'use strict';
/**
 * A copy of everything, somewhere other than the one file it all lives in.
 *
 * The first version of this copied only the database, which turned out to be
 * half a backup: every visit row points at a photo, every signed document at a
 * signature image, every deck at its slides — and none of those are in the
 * database. Restoring it gave you records referring to files that no longer
 * existed. A backup is now one ZIP holding the database *and* the uploads, so
 * what comes back is what was there.
 *
 * SQLite's VACUUM INTO is what makes this safe against a running site: it
 * writes a consistent copy without stopping writers, which copying the file by
 * hand does not — a plain copy taken mid-write, with a WAL beside it, is a
 * copy of a half-finished transaction.
 *
 * Every backup is opened and checked after it is written. An unverified backup
 * is a guess, and the moment you find out it was a bad one is the moment you
 * needed it.
 *
 * These sit on the same volume as the live data, so on their own they answer
 * "something corrupted the database" and not "the volume is gone". Downloading
 * one is what answers the second, and the dashboard says so.
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { DATA_DIR, db } = require('./db');
const zip = require('./zip');
const unzip = require('./unzip');

const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
/** Written by a restore, applied by the next start — see applyPending(). */
const { PENDING } = require('./restore-boot');
const KEEP = 7;

/* Already-compressed bytes; deflating them again costs time and saves nothing. */
const INCOMPRESSIBLE = /\.(jpe?g|png|gif|webp|mp4|webm|zip|pdf)$/i;

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

/**
 * A name nothing is using yet.
 *
 * The stamp is only to the second, so the nightly copy and somebody pressing
 * "Back up now" in the same second land on the same name — and VACUUM INTO
 * refuses to write over a file that exists, which surfaced as a 500 rather
 * than a backup.
 */
function freeName(ext) {
  const base = `smartlobby-${stamp()}`;
  for (let n = 0; n < 100; n++) {
    const file = n ? `${base}-${n + 1}${ext}` : `${base}${ext}`;
    if (!fs.existsSync(path.join(BACKUP_DIR, file))) return file;
  }
  throw new Error('could not find an unused backup filename');
}

/** Every file under a directory, as paths relative to it. */
function walk(dir, base = dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else if (e.isFile()) out.push(path.relative(base, full));
  }
  return out;
}

/**
 * Open a database copy and satisfy ourselves it is one.
 *
 * integrity_check is SQLite's own verdict on the file; the counts are the
 * cheaper question of whether it is this application's database rather than
 * some other one that happens to be valid.
 */
function verify(dbPath) {
  let copy;
  try {
    copy = new DatabaseSync(dbPath, { readOnly: true });
    const integrity = copy.prepare('PRAGMA integrity_check').get();
    const verdict = integrity && (integrity.integrity_check || Object.values(integrity)[0]);
    if (verdict !== 'ok') return { ok: false, error: `SQLite reported: ${verdict}` };
    const counts = {
      visits: copy.prepare('SELECT COUNT(*) AS n FROM visits').get().n,
      visitors: copy.prepare('SELECT COUNT(*) AS n FROM visitors').get().n,
      signatures: copy.prepare('SELECT COUNT(*) AS n FROM signatures').get().n,
      users: copy.prepare('SELECT COUNT(*) AS n FROM users').get().n
    };
    if (!counts.users) return { ok: false, error: 'the copy has no accounts in it' };
    return { ok: true, counts };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  } finally {
    try { if (copy) copy.close(); } catch { /* already gone */ }
  }
}

/**
 * @returns {{file: string, bytes: number, entries: number, counts: object, media_files: number}}
 */
function create({ includeMedia = true } = {}) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const scratch = path.join(BACKUP_DIR, `.building-${Date.now()}.db`);
  try { fs.unlinkSync(scratch); } catch { /* not there */ }

  // The consistent snapshot first, and checked before anything is built on it.
  db.exec(`VACUUM INTO '${scratch.replace(/'/g, "''")}'`);
  const checked = verify(scratch);
  if (!checked.ok) {
    try { fs.unlinkSync(scratch); } catch { /* leave it */ }
    throw new Error(`the copy did not verify — ${checked.error}`);
  }

  const file = freeName('.zip');
  const full = path.join(BACKUP_DIR, file);
  const media = includeMedia ? walk(UPLOAD_DIR) : [];
  let mediaBytes = 0;
  let written;

  const archive = zip.create(full);
  try {
    archive.add('smartlobby.db', scratch);
    for (const rel of media) {
      mediaBytes += archive.add(`uploads/${rel}`, path.join(UPLOAD_DIR, rel),
        { store: INCOMPRESSIBLE.test(rel) });
    }
    archive.add('manifest.json', Buffer.from(JSON.stringify({
      created_at: new Date().toISOString(),
      app: 'smart-lobby',
      format: 1,
      counts: checked.counts,
      media_files: media.length,
      media_bytes: mediaBytes,
      // Said plainly in the archive, so a database-only copy cannot be
      // mistaken for a complete one months later.
      database_only: !includeMedia
    }, null, 2)));
    written = archive.finish();
  } catch (err) {
    // A half-written archive is worse than none: it would sit in the list
    // looking like a backup until the day somebody tried to use it.
    try { fs.unlinkSync(full); } catch { /* nothing written */ }
    throw err;
  } finally {
    try { fs.unlinkSync(scratch); } catch { /* already gone */ }
  }

  prune();
  return { file, bytes: written.bytes, entries: written.entries, counts: checked.counts,
    media_files: media.length, database_only: !includeMedia };
}

/** Newest first. Older database-only backups are listed, and marked as such. */
function list() {
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter((f) => /^smartlobby-.*\.(zip|db)$/.test(f))
      .map((f) => {
        const s = fs.statSync(path.join(BACKUP_DIR, f));
        return { file: f, bytes: s.size, at: s.mtime.toISOString(), complete: f.endsWith('.zip') };
      })
      .sort((a, b) => b.at.localeCompare(a.at));
  } catch { return []; }
}

const totalBytes = () => list().reduce((n, b) => n + b.bytes, 0);

function prune() {
  const extra = list().slice(KEEP);
  for (const b of extra) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, b.file)); } catch { /* already gone */ }
  }
  return extra.length;
}

/**
 * The absolute path of one backup, or null.
 *
 * Matched against the listing rather than joined onto the directory, so a name
 * containing .. or a slash cannot reach a file outside it.
 */
function pathOf(file) {
  const known = list().find((b) => b.file === file);
  return known ? path.join(BACKUP_DIR, known.file) : null;
}

/* ------------------------------------------------------------- restoring */

/**
 * Read an archive and say whether it could be restored, without touching
 * anything. This is what the dashboard shows before asking "are you sure".
 */
function inspect(buffer) {
  let files;
  try { files = unzip.readZip(buffer); } catch (err) {
    return { ok: false, error: `That is not a readable ZIP file (${String(err.message || err).slice(0, 80)}).` };
  }
  const dbEntry = files.get('smartlobby.db');
  if (!dbEntry) return { ok: false, error: 'That ZIP has no smartlobby.db in it, so it is not a Smart Lobby backup.' };

  const scratch = path.join(DATA_DIR, `.inspect-${Date.now()}.db`);
  try {
    fs.writeFileSync(scratch, dbEntry);
    const checked = verify(scratch);
    if (!checked.ok) return { ok: false, error: `The database inside it did not verify — ${checked.error}` };
    let manifest = null;
    try { manifest = JSON.parse(files.get('manifest.json').toString('utf8')); } catch { /* older, or hand-made */ }
    const media = [...files.keys()].filter((k) => k.startsWith('uploads/'));
    return { ok: true, counts: checked.counts, media_files: media.length, created_at: manifest && manifest.created_at };
  } finally {
    try { fs.unlinkSync(scratch); } catch { /* already gone */ }
  }
}

/**
 * Stage an archive to be restored.
 *
 * Nothing is swapped here. The database is open and being written to by this
 * process, and replacing a file out from under an open SQLite handle is how a
 * restore becomes a second disaster. The archive is put aside and the next
 * start applies it — one restart away on any host, and the only moment when
 * nothing is holding the file.
 */
function stageRestore(buffer) {
  const checked = inspect(buffer);
  if (!checked.ok) return checked;
  // A copy of what is about to be replaced, in case the restore was the mistake.
  let safety;
  try { safety = create().file; } catch (err) {
    return { ok: false, error: `Could not back up the current data first, so nothing was changed (${err.message}).` };
  }
  fs.writeFileSync(PENDING, buffer);
  return { ok: true, ...checked, safety_backup: safety };
}

const pendingRestore = () => (fs.existsSync(PENDING) ? PENDING : null);

function cancelRestore() {
  try { fs.unlinkSync(PENDING); return true; } catch { return false; }
}

/** Runs nightly; also what "Back up now" calls. */
function runDaily() {
  try {
    const made = create();
    console.log(`[backup] wrote ${made.file} — ${Math.round(made.bytes / 1024)} kB, `
      + `${made.counts.visits} visit(s), ${made.media_files} uploaded file(s)`);
    /*
     * And straight off the machine, if that is set up. Deliberately not
     * awaited and deliberately unable to throw: a destination that is down
     * must not turn a backup that was written successfully into a failure.
     */
    require('./offsite').copyOff(made).catch(() => {});
    return made;
  } catch (err) {
    console.error('[backup] failed:', err.message);
    return null;
  }
}

/** When the last one was, for the warning on the dashboard. */
function health() {
  const all = list();
  const newest = all[0] || null;
  const hours = newest ? (Date.now() - Date.parse(newest.at)) / 3600_000 : null;
  return {
    last_at: newest ? newest.at : null,
    last_file: newest ? newest.file : null,
    count: all.length,
    total_bytes: all.reduce((n, b) => n + b.bytes, 0),
    // Nightly, so a day and a half without one means something is wrong.
    stale: hours === null || hours > 36,
    pending_restore: !!pendingRestore()
  };
}

module.exports = {
  BACKUP_DIR, KEEP, create, list, prune, pathOf, runDaily, verify, health, totalBytes,
  inspect, stageRestore, pendingRestore, cancelRestore
};
