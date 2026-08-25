'use strict';
const express = require('express');
const crypto = require('crypto');
const { all, get, run, nowISO } = require('../db');
const settings = require('../settings');
const files = require('../files');
const notify = require('../notify');
const accessCtl = require('../access');

const router = express.Router();

const clean = (v) => (typeof v === 'string' ? v.trim() : v);
const normPhone = (p) => String(p || '').replace(/[^\d+]/g, '');
const lower = (s) => String(s || '').trim().toLowerCase();

// Stored numbers may contain spaces, dashes or brackets; compare on digits only.
const PHONE_NORM_SQL = "replace(replace(replace(replace(phone, char(32), ''), '-', ''), '(', ''), ')', '')";

function activeSlideshowFor(visitType) {
  const shows = all('SELECT * FROM slideshows WHERE active = 1 ORDER BY id');
  return shows.find((s) => {
    let list = [];
    try { list = JSON.parse(s.required_for); } catch { list = []; }
    return !list.length || list.includes(visitType);
  }) || null;
}

function slidesFor(showId) {
  return all('SELECT id, position, kind, image_path, html, caption FROM slides WHERE slideshow_id = ? ORDER BY position, id', showId);
}

/** Has this person already seen the current version of the induction? */
function inductionStatus(visitor, visitType) {
  const cfg = settings.getSection('induction');
  if (!cfg.enabled) return { required: false, slideshow: null };
  const show = activeSlideshowFor(visitType);
  if (!show) return { required: false, slideshow: null };
  const slides = slidesFor(show.id);
  if (!slides.length) return { required: false, slideshow: null };

  let required = true;
  if (visitor && !cfg.show_to_returning_visitors) {
    const seen = get(`SELECT * FROM slide_views WHERE visitor_id = ? AND slideshow_id = ? AND completed_at IS NOT NULL
                      ORDER BY completed_at DESC LIMIT 1`, visitor.id, show.id);
    if (seen && Number(seen.slideshow_version) === Number(show.version)) {
      const repeatDays = Number(show.repeat_after_days || cfg.repeat_after_days || 0);
      if (!repeatDays) required = false;
      else {
        const ageDays = (Date.now() - new Date(seen.completed_at).getTime()) / 864e5;
        required = ageDays >= repeatDays;
      }
    }
  }
  return {
    required,
    slideshow: required ? { ...show, slides, required_for: undefined } : { id: show.id, version: show.version, name: show.name }
  };
}

function activeAgreementFor(visitType) {
  const rows = all('SELECT * FROM agreements WHERE active = 1 ORDER BY id');
  return rows.find((a) => {
    let list = [];
    try { list = JSON.parse(a.required_for); } catch { list = []; }
    return !list.length || list.includes(visitType);
  }) || null;
}

function nextBadgeNo() {
  const badge = settings.getSection('badge');
  const day = new Date().toISOString().slice(0, 10);
  const row = get("SELECT COUNT(*) AS n FROM visits WHERE substr(signed_in_at,1,10) = ?", day);
  const seq = String((row ? row.n : 0) + 1).padStart(3, '0');
  return `${badge.badge_prefix || 'V'}${day.replace(/-/g, '').slice(2)}-${seq}`;
}

function defaultSite() {
  return get('SELECT * FROM sites WHERE active = 1 ORDER BY id LIMIT 1');
}

/* ---------------------------------------------------------------- config */

router.get('/config', (req, res) => {
  const site = defaultSite();
  const pub = settings.publicSettings();
  const agreements = all('SELECT id, name, body, version, required_for FROM agreements WHERE active = 1');
  const inductions = all('SELECT id, name, version, required_for FROM slideshows WHERE active = 1');
  res.json({
    ...pub,
    site,
    sites: all('SELECT id, name FROM sites WHERE active = 1 ORDER BY name'),
    agreements,
    has_induction: inductions.length > 0,
    onsite_count: accessCtl.occupancy(site ? site.id : null),
    access_points: pub.access.unlock_button_on_kiosk
      ? all('SELECT id, name FROM access_points WHERE enabled = 1 ORDER BY name')
      : [],
    server_time: nowISO()
  });
});

router.get('/hosts', (req, res) => {
  const q = lower(req.query.q);
  const rows = q
    ? all(`SELECT id, name, department FROM hosts WHERE active = 1 AND (lower(name) LIKE ? OR lower(department) LIKE ?)
           ORDER BY name LIMIT 50`, `%${q}%`, `%${q}%`)
    : all('SELECT id, name, department FROM hosts WHERE active = 1 ORDER BY name LIMIT 200');
  res.json(rows);
});

/* --------------------------------------------------------------- lookup */

router.post('/lookup', (req, res) => {
  const phone = normPhone(req.body.phone);
  const email = lower(req.body.email);
  const visitType = clean(req.body.visit_type) || 'visitor';
  let visitor = null;
  if (phone && phone.length >= 6) visitor = get(`SELECT * FROM visitors WHERE ${PHONE_NORM_SQL} = ? ORDER BY id LIMIT 1`, phone);
  if (!visitor && email) visitor = get('SELECT * FROM visitors WHERE lower(email) = ? ORDER BY id LIMIT 1', email);

  if (!visitor) return res.json({ found: false, induction: inductionStatus(null, visitType) });
  if (visitor.blocked) return res.status(403).json({ found: true, blocked: true, message: 'Please see reception.' });

  const openVisit = get("SELECT id, signed_in_at FROM visits WHERE visitor_id = ? AND status = 'onsite' ORDER BY id DESC LIMIT 1", visitor.id);
  res.json({
    found: true,
    visitor: {
      id: visitor.id,
      full_name: visitor.full_name,
      company: visitor.company,
      email: visitor.email,
      phone: visitor.phone,
      visit_count: visitor.visit_count,
      last_visit_at: visitor.last_visit_at
    },
    already_onsite: openVisit || null,
    induction: inductionStatus(visitor, visitType)
  });
});

router.post('/induction', (req, res) => {
  const visitType = clean(req.body.visit_type) || 'visitor';
  const visitorId = req.body.visitor_id ? Number(req.body.visitor_id) : null;
  const visitor = visitorId ? get('SELECT * FROM visitors WHERE id = ?', visitorId) : null;
  res.json(inductionStatus(visitor, visitType));
});

router.get('/agreement/:visitType', (req, res) => {
  res.json(activeAgreementFor(req.params.visitType) || null);
});

/* --------------------------------------------------------------- sign in */

router.post('/signin', async (req, res) => {
  try {
    const b = req.body || {};
    const kiosk = settings.getSection('kiosk');
    const fullName = clean(b.full_name);
    if (!fullName) return res.status(400).json({ error: 'name_required' });

    const visitType = clean(b.visit_type) || 'visitor';
    const phone = normPhone(b.phone);
    const email = lower(b.email);
    if (kiosk.require_phone && !phone) return res.status(400).json({ error: 'phone_required' });
    if (kiosk.require_email && !email) return res.status(400).json({ error: 'email_required' });
    if (kiosk.require_host && !b.host_id) return res.status(400).json({ error: 'host_required' });

    const site = b.site_id ? get('SELECT * FROM sites WHERE id = ?', Number(b.site_id)) : defaultSite();

    let visitor = b.visitor_id ? get('SELECT * FROM visitors WHERE id = ?', Number(b.visitor_id)) : null;
    if (!visitor && phone) visitor = get(`SELECT * FROM visitors WHERE ${PHONE_NORM_SQL} = ? LIMIT 1`, phone);
    if (!visitor && email) visitor = get('SELECT * FROM visitors WHERE lower(email) = ? LIMIT 1', email);
    if (visitor && visitor.blocked) return res.status(403).json({ error: 'blocked', message: 'Please see reception.' });

    const photoPath = files.saveDataUrl(b.photo, 'private', 'photos');

    if (visitor) {
      run(`UPDATE visitors SET full_name = ?, company = COALESCE(?, company), email = COALESCE(?, email),
             phone = COALESCE(?, phone), photo_path = COALESCE(?, photo_path),
             visit_count = visit_count + 1, last_visit_at = ? WHERE id = ?`,
        fullName, clean(b.company) || null, email || null, phone || null, photoPath, nowISO(), visitor.id);
    } else {
      const r = run(`INSERT INTO visitors (full_name, company, email, phone, photo_path, visit_count, last_visit_at, created_at)
                     VALUES (?,?,?,?,?,1,?,?)`,
        fullName, clean(b.company) || null, email || null, phone || null, photoPath, nowISO(), nowISO());
      visitor = get('SELECT * FROM visitors WHERE id = ?', r.lastInsertRowid);
    }

    const badgeCfg = settings.getSection('badge');
    const badgeNo = badgeCfg.enabled ? nextBadgeNo() : null;
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();

    // Which entrance or area they signed in at, taken from the kiosk itself.
    const device = b.device_id ? get('SELECT * FROM devices WHERE id = ?', Number(b.device_id)) : null;

    const visitRes = run(`INSERT INTO visits
      (site_id, visitor_id, host_id, visit_type, purpose, vehicle_reg, badge_no, checkout_code, photo_path,
       induction_shown, signed_in_at, status, device_id, location_id, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'onsite',?,?,?)`,
      site ? site.id : null, visitor.id, b.host_id ? Number(b.host_id) : null, visitType,
      clean(b.purpose) || null, (clean(b.vehicle_reg) || '').toUpperCase() || null, badgeNo, code, photoPath,
      b.induction_completed ? 1 : 0, nowISO(), device ? device.id : null,
      device ? device.location_id : null, nowISO());
    const visitId = Number(visitRes.lastInsertRowid);

    // Signed agreement (NDA / site rules)
    if (b.signature) {
      const agreement = b.agreement_id ? get('SELECT * FROM agreements WHERE id = ?', Number(b.agreement_id)) : activeAgreementFor(visitType);
      const sigPath = files.saveDataUrl(b.signature, 'private', 'signatures');
      run('INSERT INTO signatures (visit_id, agreement_id, agreement_version, signed_name, signature_path, signed_at) VALUES (?,?,?,?,?,?)',
        visitId, agreement ? agreement.id : null, agreement ? agreement.version : null, fullName, sigPath, nowISO());
    }

    // Induction completion
    if (b.induction_completed && b.slideshow_id) {
      const show = get('SELECT * FROM slideshows WHERE id = ?', Number(b.slideshow_id));
      if (show) {
        run(`INSERT INTO slide_views (visit_id, visitor_id, slideshow_id, slideshow_version, started_at, completed_at, seconds)
             VALUES (?,?,?,?,?,?,?)`,
          visitId, visitor.id, show.id, show.version, b.induction_started_at || nowISO(), nowISO(), Number(b.induction_seconds) || null);
        run('UPDATE visitors SET induction_slideshow_id = ?, induction_version = ?, induction_completed_at = ? WHERE id = ?',
          show.id, show.version, nowISO(), visitor.id);
      }
    }

    const visit = get(`SELECT v.*, p.full_name, p.company, h.name AS host_name, s.name AS site_name
                       FROM visits v JOIN visitors p ON p.id = v.visitor_id
                       LEFT JOIN hosts h ON h.id = v.host_id LEFT JOIN sites s ON s.id = v.site_id
                       WHERE v.id = ?`, visitId);

    notify.notifyArrival(visitId).catch(() => {});
    if (settings.getSection('access').unlock_on_signin) {
      accessCtl.autoUnlock('signin', { visitId, actor: fullName, siteId: site ? site.id : null }).catch(() => {});
    }

    res.json({ ok: true, visit, badge: badgeCfg.enabled ? { ...badgeCfg, badge_no: badgeNo } : null, checkout_code: code });
  } catch (err) {
    res.status(500).json({ error: 'signin_failed', detail: String(err.message || err) });
  }
});

/* -------------------------------------------------------------- sign out */

router.post('/signout/search', (req, res) => {
  const q = lower(req.body.q);
  const code = String(req.body.code || '').trim().toUpperCase();
  if (code) {
    const v = get(`SELECT v.id, v.signed_in_at, p.full_name, p.company, h.name AS host_name
                   FROM visits v JOIN visitors p ON p.id = v.visitor_id LEFT JOIN hosts h ON h.id = v.host_id
                   WHERE v.checkout_code = ? AND v.status = 'onsite'`, code);
    return res.json(v ? [v] : []);
  }
  if (!q || q.length < 2) return res.json([]);
  res.json(all(`SELECT v.id, v.signed_in_at, p.full_name, p.company, h.name AS host_name
                FROM visits v JOIN visitors p ON p.id = v.visitor_id LEFT JOIN hosts h ON h.id = v.host_id
                WHERE v.status = 'onsite' AND (lower(p.full_name) LIKE ? OR replace(p.phone, char(32), '') LIKE ?)
                ORDER BY v.signed_in_at DESC LIMIT 25`, `%${q}%`, `%${q}%`));
});

router.post('/signout', async (req, res) => {
  const id = Number(req.body.visit_id);
  const visit = get("SELECT * FROM visits WHERE id = ? AND status = 'onsite'", id);
  if (!visit) return res.status(404).json({ error: 'not_found' });
  run("UPDATE visits SET signed_out_at = ?, status = 'out', signed_out_by = ? WHERE id = ?", nowISO(), 'kiosk', id);
  notify.notifyDeparture(id).catch(() => {});
  accessCtl.autoUnlock('signout', { visitId: id, actor: 'kiosk', siteId: visit.site_id }).catch(() => {});
  res.json({ ok: true, goodbye: settings.getSection('org').goodbye_message });
});

/* ------------------------------------------------------------ deliveries */

router.post('/delivery', async (req, res) => {
  const cfg = settings.getSection('deliveries');
  if (!cfg.enabled) return res.status(403).json({ error: 'deliveries_disabled' });
  const b = req.body || {};
  if (cfg.require_recipient && !b.recipient_host_id && !clean(b.recipient_text)) {
    return res.status(400).json({ error: 'recipient_required' });
  }
  const site = defaultSite();
  const photo = files.saveDataUrl(b.photo, 'private', 'parcels');
  const r = run(`INSERT INTO deliveries (site_id, courier_name, courier_company, recipient_host_id, recipient_text,
                   tracking, parcel_count, photo_path, notes, status, received_at)
                 VALUES (?,?,?,?,?,?,?,?,?, 'awaiting', ?)`,
    site ? site.id : null, clean(b.courier_name) || null, clean(b.courier_company) || null,
    b.recipient_host_id ? Number(b.recipient_host_id) : null, clean(b.recipient_text) || null,
    clean(b.tracking) || null, Number(b.parcel_count) || 1, photo, clean(b.notes) || null, nowISO());
  const id = Number(r.lastInsertRowid);
  if (cfg.notify_recipient) notify.notifyDelivery(id).catch(() => {});
  res.json({ ok: true, id });
});

/* ---------------------------------------------------------------- access */

router.post('/unlock', async (req, res) => {
  const cfg = settings.getSection('access');
  if (!cfg.enabled || !cfg.unlock_button_on_kiosk) return res.status(403).json({ error: 'disabled' });
  const result = await accessCtl.trigger(Number(req.body.access_point_id), { actor: 'kiosk', source: 'kiosk_button' });
  res.json(result);
});

/* ------------------------------------------------------------ heartbeat */

router.post('/ping', (req, res) => {
  const token = String(req.body.token || '');
  if (token) {
    const device = get('SELECT * FROM devices WHERE token = ?', token);
    if (device) {
      // The kiosk reports the cameras it can see so they can be chosen in the dashboard.
      const cameras = Array.isArray(req.body.cameras)
        ? JSON.stringify(req.body.cameras.slice(0, 8).map((c) => ({
            id: String(c.id || '').slice(0, 120),
            label: String(c.label || '').slice(0, 120)
          })))
        : device.cameras;
      run('UPDATE devices SET last_seen_at = ?, last_ip = ?, app_version = ?, cameras = ? WHERE id = ?',
        nowISO(), req.ip, String(req.body.version || ''), cameras, device.id);
      const location = device.location_id ? get('SELECT name FROM locations WHERE id = ?', device.location_id) : null;
      return res.json({
        ok: true,
        device_id: device.id,
        name: device.name,
        site_id: device.site_id,
        location_id: device.location_id,
        location_name: location ? location.name : null,
        mode: device.mode,
        default_camera: device.default_camera || 'front',
        print_enabled: !!device.print_enabled
      });
    }
  }
  res.json({ ok: true, device_id: null });
});

module.exports = router;
