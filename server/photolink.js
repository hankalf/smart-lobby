'use strict';
/**
 * A link to a visitor's photo that Microsoft can fetch.
 *
 * Teams does not render an image the way a browser does: its own servers go and
 * get the picture, with no session and no cookies. The photo lives under
 * /media/private, which is exactly what that path refuses — so the image in
 * every card came back 403 and the card showed a gap where a face should be.
 *
 * This signs a link instead. The key is 32 random bytes kept in the data
 * directory, so a restart or a redeploy does not break cards already sitting in
 * a channel, and the signature covers the visit id and an expiry. Anyone
 * holding the link can see that one photo until it expires — which is the deal
 * you accept by putting a face in a chat message at all — but the link cannot
 * be guessed, cannot be edited to point at somebody else, and dies on its own.
 *
 * The window follows the photo retention setting, so the link stops working at
 * roughly the moment the photo itself is deleted.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./db');
const settings = require('./settings');

const KEY_FILE = path.join(DATA_DIR, 'notify-photo.key');

function loadKey() {
  try {
    const hex = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
  } catch { /* first run, or an unreadable file we are about to replace */ }
  const key = crypto.randomBytes(32);
  try {
    fs.writeFileSync(KEY_FILE, key.toString('hex'), { mode: 0o600 });
  } catch (err) {
    // A read-only volume means links last only as long as this process does.
    console.warn('[notify] could not store the photo link key:', err.message);
  }
  return key;
}

const KEY = loadKey();

/** How long a card's photo stays fetchable: as long as the photo itself lives. */
function windowDays() {
  const days = Number(settings.getSection('privacy').retain_photos_days) || 90;
  return Math.min(365, Math.max(7, days));
}

const mac = (visitId, expires) =>
  crypto.createHmac('sha256', KEY).update(`${visitId}.${expires}`).digest('hex').slice(0, 32);

function sign(visitId) {
  const expires = Date.now() + windowDays() * 864e5;
  return `${expires}.${mac(visitId, expires)}`;
}

function valid(visitId, token) {
  const [expires, sig] = String(token || '').split('.');
  if (!expires || !sig || !Number(expires) || Number(expires) < Date.now()) return false;
  const expected = mac(visitId, Number(expires));
  // timingSafeEqual throws on a length mismatch, so the lengths are checked first.
  if (sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

module.exports = { sign, valid, windowDays };
