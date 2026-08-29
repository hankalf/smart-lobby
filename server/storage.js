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
const { DATA_DIR, get } = require('./db');

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

/** The short version, for the dashboard's health banner. */
function health() {
  const u = usage();
  if (!u.volume_size) return { known: false };
  return {
    known: true,
    level: u.level,
    percent_used: u.percent_used,
    free: u.volume_free,
    days_left: u.days_left
  };
}

module.exports = { usage, health, sizeOf };
