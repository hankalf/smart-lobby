'use strict';
/**
 * The wall board: who is on site, right now, on a page you leave open.
 *
 * This is the one page that shows the whole roster without a login, so the
 * address is the credential: a 128-bit key in the path, exactly the trade the
 * per-device kiosk links make. Everything here goes through that check first —
 * the roster, the counts and the photos — and clearing the key in the
 * dashboard revokes every copy of the link at once.
 *
 * An admin session opens it too, so whoever set it up does not have to dig the
 * link out to look at it.
 */
const crypto = require('crypto');
const express = require('express');
const { all, get } = require('../db');
const settings = require('../settings');
const files = require('../files');
const auth = require('../auth');
const ratelimit = require('../ratelimit');
const localtime = require('../localtime');

// The on-site board, shown on a screen nobody is watching for errors.
// See server/asyncroutes.js.
const router = require('../asyncroutes').guard(express.Router());

const newKey = () => crypto.randomBytes(16).toString('hex');

/** Constant-time, and never true for a board that has been switched off. */
function keyMatches(given) {
  const b = settings.getSection('board');
  if (!b.enabled || !b.key) return false;
  const a = Buffer.from(String(given || ''));
  const want = Buffer.from(String(b.key));
  if (a.length !== want.length) return false;
  return crypto.timingSafeEqual(a, want);
}

/*
 * A board left open on a screen polls every few seconds forever, so the limit
 * has to be generous — it is here to stop the roster being scraped in bulk by
 * somebody who found the link, not to police normal use.
 */
const boardLimit = ratelimit.limit({
  windowMs: 60_000, max: 240, name: 'board', message: 'Too many requests.'
});

function allow(req, res, next) {
  if (keyMatches(req.params.key) || auth.currentUser(req)) return next();
  res.status(404).json({ error: 'no_board' });
}

router.get('/:key/data', boardLimit, allow, (req, res) => {
  const b = settings.getSection('board');
  const org = settings.getSection('org');
  const minutes = Math.min(240, Math.max(1, Number(b.recent_minutes) || 20));
  const since = new Date(Date.now() - minutes * 60_000).toISOString();

  const columns = `v.id, v.visit_type, v.badge_no, v.signed_in_at, v.signed_out_at, v.photo_path,
                   p.full_name, p.company, h.name AS host_name, j.name AS project_name, l.name AS location_name`;
  const from = `FROM visits v JOIN visitors p ON p.id = v.visitor_id
                LEFT JOIN hosts h ON h.id = v.host_id
                LEFT JOIN projects j ON j.id = v.project_id
                LEFT JOIN locations l ON l.id = v.location_id`;

  const shape = (r) => ({
    id: r.id,
    name: r.full_name,
    company: b.show_company === false ? null : r.company,
    host: b.show_host === false ? null : r.host_name,
    type: r.visit_type,
    project: r.project_name,
    location: r.location_name,
    badge: r.badge_no,
    in: r.signed_in_at,
    out: r.signed_out_at,
    photo: (b.show_photos !== false && r.photo_path)
      ? `/api/board/${encodeURIComponent(req.params.key)}/photo/${r.id}`
      : null
  });

  const onsite = all(`SELECT ${columns} ${from} WHERE v.status = 'onsite' ORDER BY v.signed_in_at DESC`).map(shape);

  /*
   * Everybody who has left today, not just the last twenty minutes.
   *
   * The short window meant a name vanished off the board while the person was
   * still walking to their van, and by mid-afternoon the board could not answer
   * "has the electrician been yet" — which is most of what it gets asked. The
   * list now holds for the site's own day and empties itself when the next one
   * starts, so the board reads as a record of the day rather than of the last
   * few minutes.
   *
   * The short window is still used, for the "just arrived" highlight — that is
   * a different question, and one the client re-decides on every poll.
   */
  const day = localtime.dayRange(localtime.today());
  const left = all(`SELECT ${columns} ${from}
                    WHERE v.status != 'onsite' AND v.signed_out_at IS NOT NULL
                      AND v.signed_out_at >= ? AND v.signed_out_at < ?
                    ORDER BY v.signed_out_at DESC LIMIT 200`, day.start, day.end).map(shape);

  res.set('Cache-Control', 'no-store').json({
    camera: b.camera_enabled && b.camera_url ? {
      mode: b.camera_mode || 'snapshot',
      // Through the server when asked for, so the page sees a same-origin
      // https URL and the browser's mixed-content rule stops applying.
      url: b.camera_proxy ? `/api/board/${encodeURIComponent(req.params.key)}/camera` : b.camera_url,
      label: b.camera_label || '',
      refresh: Math.min(60, Math.max(1, Number(b.camera_refresh_seconds) || 5)),
      size: b.camera_size || 'small'
    } : null,
    title: b.title || org.name || 'Smart Lobby',
    logo: org.logo_path || null,
    timezone: org.timezone || null,
    date_format: org.date_format || 'en-GB',
    recent_minutes: minutes,
    // Whoever arrived inside the window is called out; the client re-decides
    // this on every poll, so a row stops being "new" without a reload.
    recent_since: since,
    onsite,
    left,
    /*
     * Printers somebody has marked as not printing. On the board because the
     * board is the screen the desk actually looks at, and a badge printer that
     * has quietly stopped is otherwise found out one confused visitor at a
     * time. Names only — the board is visible to anyone with the address, so
     * it says which printer, not who reported it or what they said.
     */
    printers_down: all('SELECT name FROM printers WHERE trouble_since IS NOT NULL ORDER BY name')
      .map((p) => p.name),
    now: new Date().toISOString()
  });
});

router.get('/:key/photo/:id', boardLimit, allow, (req, res) => {
  const visit = get('SELECT photo_path FROM visits WHERE id = ?', Number(req.params.id));
  const abs = visit && visit.photo_path && files.absoluteFor(visit.photo_path);
  if (!abs) return res.status(404).end();
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.sendFile(abs);
});

/**
 * The camera picture, fetched by the server rather than the browser.
 *
 * This exists for one reason: the board is https, and a browser refuses to
 * load an http image into an https page. Going through the server turns the
 * camera into a same-origin https URL and the rule stops applying — but only
 * where the server can reach the camera at all, which a cloud host cannot do
 * for something on your local network.
 *
 * The URL is set by a signed-in admin, so this is not a hole anyone else can
 * point somewhere; even so it follows no redirects, gives up quickly, and
 * passes through only images, so it cannot be turned into a general fetcher
 * for the inside of the network the server sits on.
 */
router.get('/:key/camera', boardLimit, allow, async (req, res) => {
  const b = settings.getSection('board');
  if (!b.camera_enabled || !b.camera_url) return res.status(404).end();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const upstream = await fetch(b.camera_url, { redirect: 'error', signal: controller.signal });
    // The timeout covers getting an answer, not the stream that follows: an
    // MJPEG feed is one response that never ends, and aborting it at ten
    // seconds would make the picture freeze every ten seconds.
    clearTimeout(timer);
    if (!upstream.ok) return res.status(502).json({ error: 'camera_unreachable', status: upstream.status });
    const type = upstream.headers.get('content-type') || '';
    if (!/^(image|multipart|video)\//i.test(type)) {
      return res.status(502).json({ error: 'not_an_image', detail: type.slice(0, 60) });
    }
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'no-store');
    // Streamed rather than buffered, so an MJPEG feed keeps flowing.
    const reader = upstream.body.getReader();
    req.on('close', () => reader.cancel().catch(() => {}));
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        await new Promise((resolve) => res.once('drain', resolve));
      }
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) res.status(502).json({ error: 'camera_failed', detail: String(err.message || err).slice(0, 120) });
    else res.end();
  } finally {
    clearTimeout(timer);
  }
});

module.exports = { router, newKey, keyMatches };
