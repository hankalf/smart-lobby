'use strict';
/**
 * Applying a staged restore, before anything opens the database.
 *
 * This deliberately does not require db.js. Loading that module opens the
 * database file as a side effect, and swapping a file out from under an open
 * SQLite handle is how a restore turns into a second disaster — so this has to
 * run first, which means it cannot depend on anything that opens it.
 *
 * The cost is one duplicated line: where the data directory is. It is the same
 * rule db.js uses, and if the two ever disagree the restore would look for a
 * staged archive somewhere the app is not, and find nothing — a no-op rather
 * than damage.
 *
 * Everything is written beside the live files and moved into place only once
 * every piece is there, so an interrupted restore leaves the old data intact
 * rather than a half-restored site.
 */
const fs = require('fs');
const path = require('path');
const unzip = require('./unzip');

const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH
  || path.join(__dirname, '..', 'data');
const PENDING = path.join(DATA_DIR, 'restore-pending.zip');

/** @returns {{media: number}|null} what was restored, or null when there was nothing staged */
function applyPending() {
  if (!fs.existsSync(PENDING)) return null;

  let files;
  try {
    files = unzip.readZip(fs.readFileSync(PENDING));
  } catch (err) {
    fs.unlinkSync(PENDING);
    console.error('[restore] the staged archive could not be read, so nothing was changed:', err.message);
    return null;
  }

  const dbEntry = files.get('smartlobby.db');
  if (!dbEntry) {
    fs.unlinkSync(PENDING);
    console.error('[restore] the staged archive had no database in it, so nothing was changed');
    return null;
  }

  const target = path.join(DATA_DIR, 'smartlobby.db');
  const incoming = `${target}.incoming`;
  fs.writeFileSync(incoming, dbEntry);

  const staged = path.join(DATA_DIR, 'uploads.incoming');
  fs.rmSync(staged, { recursive: true, force: true });
  let media = 0;
  for (const [name, data] of files) {
    if (!name.startsWith('uploads/') || name.endsWith('/')) continue;
    // Never write outside the staging directory, whatever an entry is called.
    const rel = path.normalize(name.slice('uploads/'.length));
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const dest = path.join(staged, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
    media++;
  }

  /*
   * A write-ahead log belonging to the database being replaced would be
   * replayed on top of the new one — the one reliable way to corrupt a restore
   * that otherwise worked — so it goes before anything opens the file.
   */
  for (const suffix of ['-wal', '-shm']) {
    try { fs.unlinkSync(target + suffix); } catch { /* not there */ }
  }
  fs.renameSync(incoming, target);

  if (media) {
    const live = path.join(DATA_DIR, 'uploads');
    const aside = `${live}.replaced-${Date.now()}`;
    try { fs.renameSync(live, aside); } catch { /* nothing to move aside */ }
    fs.renameSync(staged, live);
    fs.rmSync(aside, { recursive: true, force: true });
  } else {
    fs.rmSync(staged, { recursive: true, force: true });
  }

  fs.unlinkSync(PENDING);
  console.log(`[restore] restored the database and ${media} uploaded file(s)`);
  return { media };
}

module.exports = { applyPending, PENDING, DATA_DIR };
