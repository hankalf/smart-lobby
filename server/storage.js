'use strict';
/**
 * How much room is left, and what is using it.
 *
 * A Railway volume is a fixed size. Filling it does not degrade anything
 * gracefully: the database cannot write, sign-ins start failing, and the
 * backup that would have told you about it cannot be written either. Nothing
 * anywhere reported on this, so the first sign would have been the kiosk
 * refusing people.
 *
 * Photos are what fill it — a few thousand faces at 90KB each — so the
 * breakdown names them separately from the database, and the estimate says
 * how long the room left will last at the rate this site is actually going.
 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR, get, all, run } = require('./db');

/** Bytes under a directory, following nothing and forgiving what has gone. */
function sizeOf(dir) {
  let total = 0;
  let files = 0;
  let stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      if (!entry.isFile()) continue;
      try { total += fs.statSync(full).size; files++; } catch { /* deleted underneath us */ }
    }
  }
  return { bytes: total, files };
}

const fileSize = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };

/**
 * What the volume looks like right now.
 *
 * `free` and `size` come from the filesystem, so on a platform without a
 * volume they describe the container's own disk — which is the honest answer,
 * because that is what is being filled.
 */
function usage() {
  const uploads = sizeOf(path.join(DATA_DIR, 'uploads'));
  const backups = sizeOf(path.join(DATA_DIR, 'backups'));
  const photos = sizeOf(path.join(DATA_DIR, 'uploads', 'private', 'photos'));
  const database = ['smartlobby.db', 'smartlobby.db-wal', 'smartlobby.db-shm']
    .reduce((sum, name) => sum + fileSize(path.join(DATA_DIR, name)), 0);

  let volume = null;
  try {
    const s = fs.statfsSync(DATA_DIR);
    volume = { size: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch { /* a platform without statfs; the breakdown still stands */ }

  const used = database + uploads.bytes + backups.bytes;
  const out = {
    dir: DATA_DIR,
    database,
    uploads: uploads.bytes,
    upload_files: uploads.files,
    photos: photos.bytes,
    photo_files: photos.files,
    backups: backups.bytes,
    backup_files: backups.files,
    used
  };

  if (volume) {
    out.volume_size = volume.size;
    out.volume_free = volume.free;
    out.percent_used = volume.size ? Math.round(((volume.size - volume.free) / volume.size) * 100) : null;
    out.days_left = daysLeft(volume.free);
    /*
     * Nine tenths full is the point at which somebody has to do something;
     * three quarters is worth knowing about while there is still time to
     * choose what to do rather than delete whatever is nearest.
     */
    out.level = out.percent_used >= 90 ? 'critical' : out.percent_used >= 75 ? 'warning' : 'ok';
  }
  return out;
}

/**
 * How long the room left will last, at the rate this site is filling it.
 *
 * Worked out from the last 30 days of arrivals with a photo rather than from
 * a guess at an average site: a gate doing 200 a day and an office doing five
 * are not the same problem.
 */
function daysLeft(freeBytes) {
  const row = get(`SELECT COUNT(*) AS n FROM visits
                   WHERE photo_path IS NOT NULL AND signed_in_at >= date('now','-30 days')`);
  const perDay = (row && row.n ? row.n : 0) / 30;
  if (perDay < 0.1) return null;
  const photos = sizeOf(path.join(DATA_DIR, 'uploads', 'private', 'photos'));
  const perPhoto = photos.files ? photos.bytes / photos.files : 90 * 1024;
  const days = Math.floor(freeBytes / (perDay * perPhoto));
  // Beyond a couple of years the number stops meaning anything useful.
  return days > 900 ? null : days;
}

/**
 * The pressure valve: drop the oldest photos before the disk fills.
 *
 * The retention window says how long photos are kept as a matter of policy.
 * This is the other thing — what happens when policy and the size of the
 * volume disagree, and the volume is about to win. A site keeping ninety days
 * of faces at a busy gate can pass a small volume well inside that window, and
 * everything that fails then fails badly: the database cannot write, the kiosk
 * turns people away, and the nightly backup that would have said so cannot be
 * written either.
 *
 * So the oldest faces go early. They are the least useful bytes on the disk,
 * they are the only ones there are a lot of, and losing them costs a look-up
 * nobody was going to do — against a site that stops working.
 *
 * Three things it will not do: touch anything inside the floor window, run at
 * all when it is switched off, or delete quietly. Every sweep is written to
 * the audit log with what went and how much it freed.
 */
function shed(opts = {}) {
  const settings = require('./settings');
  const files = require('./files');
  const cfg = { ...settings.getSection('storage'), ...opts };
  const numberOr = (v, dflt) => (v === '' || v == null || !Number.isFinite(Number(v)) ? dflt : Number(v));
  const at = numberOr(cfg.shed_at_percent, 90);
  const to = numberOr(cfg.shed_to_percent, 75);
  const floorDays = Math.max(1, numberOr(cfg.shed_floor_days, 14));

  const before = usage();
  const skip = (why) => ({ ran: false, why, percent_used: before.percent_used ?? null, freed: 0, photos: 0 });
  if (cfg.shed_enabled === false) return skip('switched off');
  if (!before.volume_size) return skip('the volume size is not known here');
  /*
   * Both marks have to be passed. The mark it starts at is what makes this a
   * last resort rather than a second retention policy; the mark it clears to
   * is what stops the button on the Backups page — which drops the first
   * mark to nothing — from taking every photo it can reach.
   */
  if (before.percent_used < at || before.percent_used <= to) return skip('there is room');

  /*
   * Oldest first, in batches, stopping the moment there is room again — a
   * site that is barely over loses a handful of photos, not a year of them.
   * The floor is applied in the query, so nothing recent can be reached even
   * if the disk never comes back under the mark.
   */
  const floor = new Date(Date.now() - floorDays * 864e5).toISOString();
  let freed = 0;
  let photos = 0;
  let oldest = null;
  let newest = null;

  for (;;) {
    const batch = all(`SELECT id, photo_path, signed_in_at FROM visits
                       WHERE photo_path IS NOT NULL AND signed_in_at < ?
                       ORDER BY signed_in_at ASC LIMIT 200`, floor);
    if (!batch.length) break;
    for (const v of batch) {
      const full = files.absoluteFor(v.photo_path);
      let size = 0;
      try { if (full) size = fs.statSync(full).size; } catch { /* already gone */ }
      files.removeFile(v.photo_path);
      run('UPDATE visits SET photo_path = NULL WHERE id = ?', v.id);
      freed += size;
      photos++;
      if (!oldest) oldest = v.signed_in_at;
      newest = v.signed_in_at;
    }
    const now = usage();
    if (!now.volume_size || now.percent_used <= to) break;
  }

  const after = usage();
  const result = {
    ran: true,
    photos,
    freed,
    from: oldest,
    to: newest,
    floor_days: floorDays,
    percent_before: before.percent_used,
    percent_used: after.percent_used,
    // Said plainly, because "it ran" and "it worked" are not the same thing:
    // a site whose disk is full of something other than photos stays full.
    enough: after.percent_used != null && after.percent_used <= to
  };

  if (photos) {
    run(`INSERT INTO audit_log (user_id, action, entity, entity_id, detail, created_at)
         VALUES (?, 'storage.shed', 'storage', NULL, ?, ?)`,
      opts.userId || null, JSON.stringify(result), new Date().toISOString());
    settings.setSection('storage', {
      shed_last_at: new Date().toISOString(), shed_last_freed: freed, shed_last_photos: photos
    });
    console.log(`[storage] ${before.percent_used}% full — dropped ${photos} photo(s) older than `
      + `${floorDays} days, freeing ${Math.round(freed / 1048576)}MB (now ${after.percent_used}%)`);
  }
  return result;
}

/** The short version, for the dashboard's health banner. */
function health() {
  const u = usage();
  if (!u.volume_size) return { known: false };
  const cfg = require('./settings').getSection('storage');
  return {
    known: true,
    level: u.level,
    percent_used: u.percent_used,
    free: u.volume_free,
    days_left: u.days_left,
    shedding: cfg.shed_enabled !== false,
    shed_at_percent: Number(cfg.shed_at_percent) || 90,
    shed_last_at: cfg.shed_last_at || '',
    shed_last_freed: Number(cfg.shed_last_freed) || 0,
    shed_last_photos: Number(cfg.shed_last_photos) || 0
  };
}

module.exports = { usage, health, sizeOf, shed };
