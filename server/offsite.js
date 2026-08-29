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
    offsite_last_file: result.file || ''
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
      error: `That backup is ${Math.round(stat.size / 1048576)} MB, past what a Power Automate flow will accept. `
        + 'Switch off "Send the uploaded files too" to send just the database, which is a fraction of the size.'
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
  const result = await send(full, made.file);
  record(result);
  if (result.ok) console.log(`[backup] copied ${made.file} off the machine`);
  else console.error(`[backup] could not copy ${made.file} off the machine: ${result.error}`);
  return result;
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
    last_file: c.offsite_last_file || ''
  };
}

module.exports = { send, copyOff, test, health, enabled, SIZE_WARN, SIZE_MAX };
