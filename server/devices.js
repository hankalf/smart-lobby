'use strict';
/**
 * A device's address on the network.
 *
 * Each tablet gets its own URL — /kiosk/north-gate — rather than sharing one
 * page and being told apart by a ?token= query parameter. That matters for one
 * concrete reason: on an iPad you open the link in Safari and use "Add to Home
 * Screen", and what iOS saves is the address bar. A query parameter is fragile
 * there (we used to clear it on load, and a standalone home-screen web app also
 * gets a storage jar of its own, so nothing carried over in localStorage
 * either); a path is not. Whatever the tablet is reopened from — the home
 * screen icon, a bookmark, a re-typed address — the path still says which
 * device this is.
 *
 * The token stays as the device's secret and keeps working, so links already
 * handed out are not broken.
 */
const { get, all } = require('./db');

const RESERVED = new Set([
  // Real files and endpoints under /kiosk/ that a slug must never shadow.
  'kiosk.js', 'kiosk.css', 'sw.js', 'index.html', 'vendor', 'api', 'media', 'admin', 'shared'
]);

/** "North Gate iPad" -> "north-gate-ipad" */
function slugify(name) {
  const base = String(name || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')  // strip accents, keep the letters
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || 'kiosk';
}

/**
 * A slug no other device is using, and that cannot collide with a file served
 * from the same folder.
 */
function uniqueSlug(name, excludeId) {
  const base = slugify(name);
  const taken = new Set(
    all('SELECT id, slug FROM devices WHERE slug IS NOT NULL')
      .filter((d) => d.id !== Number(excludeId))
      .map((d) => d.slug)
  );
  let candidate = RESERVED.has(base) ? `${base}-kiosk` : base;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${base}-${n}`;
  return candidate;
}

const bySlug = (slug) => (slug ? get('SELECT * FROM devices WHERE slug = ?', String(slug)) : null);
const byToken = (token) => (token ? get('SELECT * FROM devices WHERE token = ?', String(token)) : null);

/** Resolve however the tablet identified itself: by its path, or its token. */
function resolve({ slug, token }) {
  return bySlug(slug) || byToken(token) || null;
}

/**
 * The device a phone check-in code belongs to.
 *
 * A code is only ever handed out for a device with self check-in switched on,
 * and switching it off stops the code working without reissuing anything —
 * which is the point of checking the flag here rather than only at issue time.
 */
function bySelfCode(code) {
  const clean = String(code || '').trim();
  if (clean.length < 8) return null;
  return get('SELECT * FROM devices WHERE self_code = ? AND self_checkin = 1', clean) || null;
}

/** A fresh code for a device's phone link, replacing whatever it had. */
function newSelfCode() {
  return require('crypto').randomBytes(16).toString('hex');
}

module.exports = { slugify, uniqueSlug, bySlug, byToken, bySelfCode, newSelfCode, resolve, RESERVED };
