'use strict';
/**
 * A copy of the data somewhere other than the one file everything lives in.
 *
 * Deleting a record is recoverable now, but that is the only failure the
 * archive covers. A corrupted database, a bad migration, or a volume that goes
 * away take everything with them, and until now there was no second copy of
 * anything anywhere.
 *
 * SQLite's own VACUUM INTO is what makes this safe to run against a live
 * database: it writes a consistent copy without stopping writers, which
 * copying the file by hand does not — a plain copy taken mid-write, with a
 * WAL alongside it, is a copy of a half-finished transaction.
 *
 * These sit on the same volume, so they answer "somebody broke the data" and
 * not "the volume is gone". The download button in the dashboard is the other
 * half: a backup that has been pulled off the machine is the only one that
 * survives losing the machine.
 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR, db } = require('./db');

const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const KEEP = 7;

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

/**
 * A name nothing is using yet.
 *
 * The stamp is only to the second, so the nightly copy and somebody pressing
 * "Back up now" in the same second land on the same name — and VACUUM INTO
 * refuses to write over a file that exists, which surfaced as a 500 rather
 * than a backup.
 */
function freeName() {
  const base = `smartlobby-${stamp()}`;
  for (let n = 0; n < 100; n++) {
    const file = n ? `${base}-${n + 1}.db` : `${base}.db`;
    if (!fs.existsSync(path.join(BACKUP_DIR, file))) return file;
  }
  throw new Error('could not find an unused backup filename');
}

/** @returns {{file: string, path: string, bytes: number}} */
function create() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const file = freeName();
  const full = path.join(BACKUP_DIR, file);
  /*
   * The filename is built here from a timestamp, never from anything a caller
   * sends, so there is nothing to escape — but VACUUM INTO takes a literal
   * rather than a parameter, so the quoting is done properly regardless.
   */
  db.exec(`VACUUM INTO '${full.replace(/'/g, "''")}'`);
  prune();
  return { file, path: full, bytes: fs.statSync(full).size };
}

/** Oldest first, so the newest KEEP are the ones kept. */
function list() {
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter((f) => /^smartlobby-.*\.db$/.test(f))
      .map((f) => {
        const s = fs.statSync(path.join(BACKUP_DIR, f));
        return { file: f, bytes: s.size, at: s.mtime.toISOString() };
      })
      .sort((a, b) => b.at.localeCompare(a.at));
  } catch { return []; }
}

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
 * The name is matched against the listing rather than joined onto the
 * directory, so a name containing .. or a slash cannot reach a file outside it.
 */
function pathOf(file) {
  const known = list().find((b) => b.file === file);
  return known ? path.join(BACKUP_DIR, known.file) : null;
}

/** Runs nightly; also the thing the dashboard's "Back up now" calls. */
function runDaily() {
  try {
    const made = create();
    console.log(`[backup] wrote ${made.file} (${Math.round(made.bytes / 1024)} kB)`);
    return made;
  } catch (err) {
    console.error('[backup] failed:', err.message);
    return null;
  }
}

module.exports = { BACKUP_DIR, KEEP, create, list, prune, pathOf, runDaily };
