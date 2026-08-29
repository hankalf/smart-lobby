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

const router = express.Router();

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
  const left = all(`SELECT ${columns} ${from}
                    WHERE v.status != 'onsite' AND v.signed_out_at IS NOT NULL AND v.signed_out_at >= ?
                    ORDER BY v.signed_out_at DESC LIMIT 25`, since).map(shape);

  res.set('Cache-Control', 'no-store').json({
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

module.exports = { router, newKey, keyMatches };
