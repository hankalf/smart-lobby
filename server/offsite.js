'use strict';
/**
 * Getting a backup off the machine, on its own.
 *
 * Backups on the same volume as the data answer "something corrupted the
 * database". They do not answer "the volume is gone", and a copy that only
 * leaves when somebody remembers to press Download is not really an answer
 * either. This posts each new backup somewhere else the moment it is written.
 *
 * The destination is a URL, and the one that works for a normal corporate
 * account is a Power Automate flow: "When an HTTP request is received" into
 * "Create file" in OneDrive. That is the same shape as the Teams channel
 * webhook already set up here, and it needs no Azure app registration, no
 * admin consent and no OAuth tokens to store or refresh — which matters,
 * because creating an app registration is exactly the thing a normal account
 * in somebody else's tenant cannot do.
 *
 * The archive is sent as raw bytes rather than base64 in JSON: base64 makes it
 * a third bigger, and the size limit on that trigger is the whole constraint
 * here.
 */
const fs = require('fs');
const path = require('path');
const settings = require('./settings');

/*
 * Power Automate's HTTP trigger stops accepting somewhere around a hundred
 * megabytes, and gets unreliable well before that. Past this the upload is
 * refused here, with an explanation, rather than sent to fail slowly.
 */
const SIZE_WARN = 45 * 1024 * 1024;
const SIZE_MAX = 90 * 1024 * 1024;
const TIMEOUT_MS = 180_000;

const config = () => settings.getSection('backup');

const enabled = () => {
  const c = config();
  return !!(c.offsite_enabled && c.offsite_url);
};

/** Remember how it went, so the dashboard can say when it stops working. */
function record(result) {
  settings.setSection('backup', {
    offsite_last_at: new Date().toISOString(),
    offsite_last_ok: !!result.ok,
    offsite_last_error: result.ok ? '' : String(result.error || '').slice(0, 300),
    offsite_last_file: result.file || '',
    offsite_last_parts: result.parts || 0,
    offsite_last_database_ok: result.split ? !!result.database_ok : !!result.ok
  });
  return result;
}

/**
 * Post one file to the configured destination.
 *
 * @param {string} full  the file on disk
 * @param {string} name  what to call it at the other end
 */
async function send(full, name) {
  const c = config();
  if (!c.offsite_url) return { ok: false, error: 'No destination is set.' };

  let stat;
  try { stat = fs.statSync(full); } catch { return { ok: false, error: 'That backup is no longer on disk.' }; }
  if (stat.size > SIZE_MAX) {
    return {
      ok: false,
      file: name,
      error: `That piece is ${Math.round(stat.size / 1048576)} MB, past what a Power Automate flow will accept. `
        + 'A backup over the limit is normally cut into pieces that fit; a single file this big cannot be, so it '
        + 'has to be fetched from Backups by hand.'
    };
  }

  const url = new URL(c.offsite_url);
  // In the query as well as a header: reading a header in a flow is fiddly,
  // and one of the two is always to hand.
  url.searchParams.set('name', name);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/zip',
        'Content-Length': String(stat.size),
        'X-Filename': name,
        ...(c.offsite_secret ? { 'X-Smart-Lobby-Secret': c.offsite_secret } : {})
      },
      body: fs.readFileSync(full),
      signal: controller.signal
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      return { ok: false, file: name, status: res.status, error: explain(res.status, text) };
    }
    return { ok: true, file: name, bytes: stat.size, status: res.status };
  } catch (err) {
    const raw = String((err && err.message) || err);
    return {
      ok: false,
      file: name,
      error: /abort/i.test(raw)
        ? `The destination did not answer within ${TIMEOUT_MS / 1000} seconds. A large backup over a slow link can `
          + 'do this — try sending the database only.'
        : `Could not reach the destination: ${raw}`
    };
  } finally {
    clearTimeout(timer);
  }
}

function explain(status, body) {
  const text = String(body || '').slice(0, 200);
  if (status === 404 || status === 410) return 'That flow no longer exists — it may have been deleted or turned off.';
  if (status === 401 || status === 403) return 'The destination refused the request. Check the URL was pasted whole.';
  if (status === 413) return 'The destination said the file is too large. Send the database only, without the uploaded files.';
  if (status === 429) return 'The destination is rate limiting us — too many uploads too quickly.';
  return `The destination answered ${status}. ${text}`;
}

/**
 * Copy a freshly written backup off the machine, if that is switched on.
 *
 * Never throws: a failure to get the copy away must not lose the backup that
 * was successfully written, and the reason is recorded for the dashboard.
 */
async function copyOff(made) {
  if (!enabled()) return null;
  const backup = require('./backup');
  const full = backup.pathOf(made.file);
  if (!full) return record({ ok: false, file: made.file, error: 'The backup vanished before it could be sent.' });

  /*
   * One piece if it fits, several if it does not.
   *
   * A whole archive under the limit is simplest to restore, so that is still
   * what goes when it fits. Past the limit the choice used to be between
   * failing and sending the database without the photos — which restores to
   * records pointing at faces that are gone — so it is now cut up instead.
   */
  const stat = fs.statSync(full);
  if (stat.size <= SIZE_MAX) {
    const result = await send(full, made.file);
    record(result);
    if (result.ok) console.log(`[backup] copied ${made.file} off the machine`);
    else console.error(`[backup] could not copy ${made.file} off the machine: ${result.error}`);
    return result;
  }
  return copyInParts(made, stat.size);
}

/**
 * Send a backup too big to go in one piece, as several that fit.
 *
 * The database part goes first: it is the smallest and the most valuable, and
 * getting it away is worth doing even if the photos afterwards fail. What
 * happened to each piece is reported, so a partial success reads as a partial
 * success rather than as either a triumph or a disaster.
 */
async function copyInParts(made, wholeSize) {
  const backup = require('./backup');
  let built;
  try {
    // A margin under the limit: the ZIP's own headers and the manifest are
    // added on top of the files a batch was measured by.
    built = backup.createParts({ maxBytes: Math.floor(SIZE_MAX * 0.85) });
  } catch (err) {
    return record({ ok: false, file: made.file, error: `Could not split the backup up: ${err.message}` });
  }

  const sent = [];
  try {
    for (const part of built.parts) {
      const result = await send(part.path, part.file);
      sent.push({ ...result, kind: part.kind, index: part.index, of: part.total });
      if (result.ok) console.log(`[backup] copied ${part.file} off the machine`);
      else console.error(`[backup] could not copy ${part.file}: ${result.error}`);
    }
  } finally {
    fs.rmSync(built.dir, { recursive: true, force: true });
  }

  const failed = sent.filter((r) => !r.ok);
  const database = sent.find((r) => r.kind === 'database');
  const summary = {
    ok: failed.length === 0,
    split: true,
    parts: sent.length,
    parts_sent: sent.length - failed.length,
    file: `${made.file} (in ${sent.length} pieces)`,
    database_ok: !!(database && database.ok),
    error: failed.length
      ? `${failed.length} of ${sent.length} pieces did not get there — ${failed[0].error}`
        + (database && database.ok ? ' The database itself did get away.' : '')
      : ''
  };
  if (failed.length === 0) {
    console.log(`[backup] ${made.file} copied off in ${sent.length} pieces `
      + `(${Math.round(wholeSize / 1048576)} MB whole)`);
  }
  record(summary);
  return summary;
}

/** A small file, to prove the destination works before trusting it with a backup. */
async function test() {
  const c = config();
  if (!c.offsite_url) return { ok: false, error: 'Paste the destination URL first.' };
  const tmp = path.join(require('./db').DATA_DIR, `.offsite-test-${Date.now()}.txt`);
  fs.writeFileSync(tmp, `Smart Lobby test upload, ${new Date().toISOString()}.\n`
    + 'If you can see this file, backups will arrive here too.\n');
  try {
    return await send(tmp, `smartlobby-test-${Date.now()}.txt`);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  }
}

/** For the warning on the dashboard. */
function health() {
  const c = config();
  if (!enabled()) return { enabled: false };
  return {
    enabled: true,
    last_at: c.offsite_last_at || null,
    last_ok: c.offsite_last_ok !== false,
    last_error: c.offsite_last_error || '',
    last_file: c.offsite_last_file || '',
    last_parts: c.offsite_last_parts || 0,
    // Whether the database itself got away, which is the part that matters
    // most when only some of the pieces did.
    last_database_ok: c.offsite_last_database_ok !== false
  };
}

module.exports = { send, copyOff, copyInParts, test, health, enabled, SIZE_WARN, SIZE_MAX };
