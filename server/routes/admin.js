'use strict';
const express = require('express');
const crypto = require('crypto');
const { all, get, run, nowISO } = require('../db');
const auth = require('../auth');
const settings = require('../settings');
const files = require('../files');
const notify = require('../notify');
const accessCtl = require('../access');
const decks = require('../slides');
const badges = require('../badges');
const { nextBadgeNo } = badges;
const localtime = require('../localtime');
const deviceSlugs = require('../devices');
const ratelimit = require('../ratelimit');
const archive = require('../archive');
const expected = require('../expected');
const cards = require('../notify-card');
const roles = require('../roles');

const router = express.Router();
const clean = (v) => (typeof v === 'string' ? v.trim() : v);

function audit(req, action, entity, entityId, detail) {
  run('INSERT INTO audit_log (user_id, action, entity, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
    req.user ? req.user.id : null, action, entity || null, entityId || null,
    detail ? JSON.stringify(detail) : null, nowISO());
}

/**
 * Timestamps counted into the site's own days, for the activity charts.
 *
 * SQLite can group on the stored UTC text but not on a zone whose offset moves
 * with the clocks, so the bucketing happens here. Days nothing happened on are
 * left out, as they were when this was a GROUP BY.
 */
function byLocalDay(timestamps, days, endOn) {
  const counts = new Map();
  for (const ts of timestamps) {
    if (!ts) continue;
    const day = localtime.dayOf(ts);
    counts.set(day, (counts.get(day) || 0) + 1);
  }
  // `endOn` lets a report end on a chosen day rather than always on today,
  // which is what makes "last quarter" a thing that can be asked for.
  const last = endOn ? Date.parse(`${endOn}T12:00:00Z`) : Date.now();
  const earliest = localtime.dayOf(new Date(last - (days - 1) * 864e5));
  return [...counts.entries()]
    .filter(([day]) => day >= earliest)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, n]) => ({ day, n }));
}

/** The same, by hour of the local day, so "busiest hour" means the site's hour. */
function byLocalHour(timestamps) {
  const counts = new Map();
  for (const ts of timestamps) {
    const hour = ts && localtime.hourOf(ts);
    if (hour) counts.set(hour, (counts.get(hour) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([hour, n]) => ({ hour, n }));
}

function csv(rows, columns) {
  const head = columns.map((c) => c.label).join(',');
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [head, ...rows.map((r) => columns.map((c) => esc(typeof c.value === 'function' ? c.value(r) : r[c.key])).join(','))].join('\r\n');
}

/* ------------------------------------------------------------- auth flow */

router.get('/bootstrap', (req, res) => {
  res.json({
    needs_setup: !auth.anyUsers(),
    user: auth.currentUser(req),
    org: settings.getSection('org'),
    storage_warning: require('../db').STORAGE.message
  });
});

router.post('/setup', ratelimit.limit({ name: 'setup', windowMs: 60 * 60000, max: 10 }), (req, res) => {
  if (auth.anyUsers()) return res.status(400).json({ error: 'already_setup' });
  const { email, password, name, org_name } = req.body || {};
  if (!email || !password || String(password).length < 8) return res.status(400).json({ error: 'weak_credentials' });
  const user = auth.createUser({ email, password, name, role: 'owner' });
  if (org_name) settings.setSection('org', { name: org_name });
  if (!get('SELECT id FROM sites LIMIT 1')) {
    run('INSERT INTO sites (name, active, created_at) VALUES (?,1,?)', org_name || 'Main site', nowISO());
  }
  /*
   * One example visit of each type, so the dashboard, the board, the badge
   * designer and the Teams preview all have something real to draw on the
   * very first screen rather than saying "nothing yet" four times over.
   */
  /*
   * SEED_EXAMPLES=false skips them entirely, for an install that is going
   * straight into service and does not want John Doe on the board on day one.
   */
  const examples = process.env.SEED_EXAMPLES === 'false' ? { skipped: true } : require('../examples').seed();
  auth.startSession(res, user, req);
  res.json({ ok: true, user, examples });
});


/*
 * A password prompt on a public URL. Ten tries a quarter-hour is far more than
 * a person mistyping their own password needs, and turns guessing from minutes
 * of work into years of it. Keyed on the account as well as the caller, so a
 * single account cannot be ground down from a spread of addresses.
 */
const loginLimit = [
  ratelimit.limit({ name: 'login-ip', windowMs: 15 * 60000, max: 20,
    message: 'Too many sign-in attempts. Please wait a few minutes.' }),
  ratelimit.limit({ name: 'login-user', windowMs: 15 * 60000, max: 10,
    keyOn: (req) => String((req.body && req.body.email) || '').toLowerCase(),
    message: 'Too many sign-in attempts for that account. Please wait a few minutes.' })
];

router.post('/login', loginLimit, (req, res) => {
  const user = auth.verifyLogin(req.body.email, req.body.password);
  if (!user) return res.status(401).json({ error: 'invalid_credentials' });
  // Signing in successfully clears the count, so a person who mistyped twice
  // and then got it right is not left near a limit they cannot see.
  ratelimit.clear('login-ip', req);
  ratelimit.clear('login-user', req, (r) => String((r.body && r.body.email) || '').toLowerCase());
  auth.startSession(res, user, req);
  res.json({
    ok: true,
    user: {
      id: user.id, email: user.email, name: user.name, role: user.role,
      areas: roles.areasFor(user.role),
      must_change_password: !!user.must_change_password
    }
  });
});

router.post('/logout', (req, res) => { auth.endSession(req, res); res.json({ ok: true }); });

router.use(auth.requireAuth);

/*
 * The permission check, on every request rather than in the menu.
 *
 * Hiding a tab from somebody who can still call the endpoint behind it is not
 * a permission system, so this sits ahead of every route below and asks
 * roles.js the same question the dashboard asks when it decides what to draw.
 *
 * A login carrying a temporary password can do exactly two things until it is
 * changed: read who it is, and change it. Otherwise "you must pick a password"
 * would be a suggestion.
 */
router.use((req, res, next) => {
  if (req.user.must_change_password && !(req.path === '/me' || req.path === '/me/password')) {
    return res.status(403).json({
      error: 'password_change_required',
      message: 'Choose a new password before going any further.'
    });
  }
  const area = roles.areaForRequest(req.method, req.path);
  if (area && !roles.can(req.user.role, area)) {
    return res.status(403).json({
      error: 'not_allowed',
      area,
      message: `Your access level does not include ${area}.`
    });
  }
  next();
});

// Any successful change in the dashboard bumps the configuration revision, so
// every kiosk picks it up on its next check-in without anybody touching them.
router.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  res.on('finish', () => {
    if (res.statusCode < 400) {
      try { settings.bumpConfigRev(); } catch { /* never let this break the request */ }
    }
  });
  next();
});

router.get('/me', (req, res) => res.json(req.user));

/**
 * Just enough for the dashboard to draw itself: the name, the colours, the
 * time zone every timestamp is formatted in, and the visitor-type labels.
 *
 * The whole settings object is administrator-only — it holds the Teams webhook
 * and the board key — but reception still needs times shown on the site's own
 * clock, so this is the part everybody signed in may read.
 */
router.get('/branding', (req, res) => {
  const s = settings.getAll();
  res.json({ org: s.org, types: s.types, kiosk: { spanish_enabled: s.kiosk.spanish_enabled } });
});

/* ------------------------------------------------------------- dashboard */

router.get('/dashboard', (req, res) => {
  const day = localtime.dayRange(localtime.today());
  const onsite = all(`SELECT v.id, v.signed_in_at, v.visit_type, v.badge_no, v.photo_path, v.vehicle_reg,
                             p.full_name, p.company, p.phone, h.name AS host_name, s.name AS site_name
                      FROM visits v JOIN visitors p ON p.id = v.visitor_id
                      LEFT JOIN hosts h ON h.id = v.host_id LEFT JOIN sites s ON s.id = v.site_id
                      WHERE v.status = 'onsite' ORDER BY v.signed_in_at DESC`);
  const stats = {
    onsite: onsite.length,
    today_in: get('SELECT COUNT(*) AS n FROM visits WHERE signed_in_at >= ? AND signed_in_at < ?', day.start, day.end).n,
    today_out: get('SELECT COUNT(*) AS n FROM visits WHERE signed_out_at >= ? AND signed_out_at < ?', day.start, day.end).n,
    deliveries_waiting: get("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'awaiting'").n,
    visitors_total: get('SELECT COUNT(*) AS n FROM visitors').n,
    inductions_today: get('SELECT COUNT(*) AS n FROM slide_views WHERE completed_at >= ? AND completed_at < ?', day.start, day.end).n,
    // Booked in for today and not yet walked in on. The number reception is
    // actually asked for at eight in the morning.
    expected_today: get("SELECT COUNT(*) AS n FROM expected_visits WHERE expected_on = ? AND status = 'expected'",
      localtime.today()).n
  };
  const week = byLocalDay(all(`SELECT signed_in_at FROM visits WHERE signed_in_at >= date('now','-14 days')`)
    .map((r) => r.signed_in_at), 14);
  const storage_warning = require('../db').STORAGE.message;
  const devices = all('SELECT id, name, last_seen_at FROM devices ORDER BY name');
  res.json({ onsite, stats, week, devices, storage_warning,
    // Whether anything has quietly stopped working — see notify.health().
    health: {
      ...notify.health(),
      /*
       * Whether the examples this site was set up with are still on file, and
       * whether anybody real has arrived since — which together are the
       * moment to offer to clear them out.
       */
      // How full the volume is. Filling it stops sign-ins and the backup that
      // would have warned you, so it is worth a banner rather than a page.
      storage: require('../storage').health(),
      /*
       * Printers people have reported as not printing. Nothing here has looked
       * at a printer — it cannot — so this is a count of what visitors said,
       * and the dashboard says so in those words.
       */
      printers: all(`SELECT id, name, trouble_since FROM printers
                     WHERE trouble_since IS NOT NULL ORDER BY trouble_since`),
      /*
       * Every working printer, so the dashboard can offer to flag one.
       * Reception is who notices badges have stopped, and the Printers page
       * is administrative — without this the people who can see the problem
       * would have nowhere to report it. Names and ids only; the rest of a
       * printer's record stays behind the settings.
       */
      printers_known: all(`SELECT id, name FROM printers
                           WHERE active = 1 AND trouble_since IS NULL ORDER BY name`),
      examples: (() => {
        const examples = require('../examples');
        return { present: examples.present(), real_visits: examples.present() && !examples.onlyExamples() };
      })(),
      backup: { ...require('../backup').health(), offsite: require('../offsite').health() }
    },
    recent_deliveries: all(
      `SELECT d.*, h.name AS host_name FROM deliveries d LEFT JOIN hosts h ON h.id = d.recipient_host_id
       ORDER BY d.received_at DESC LIMIT 10`) });
});

/* ------------------------------------------------------------- expected */

/*
 * Who is coming. A plan, kept apart from the record of who was actually here
 * — see the table's own note in db.js for why that separation matters.
 */
router.get('/expected', (req, res) => res.json({
  ...expected.today(),
  // The whole window asked for, which is not the same as today's summary.
  rows: expected.list(req.query)
}));

router.post('/expected', (req, res) => {
  const made = expected.create(req.body || {}, req.user ? (req.user.name || req.user.email) : null);
  if (made.error) {
    return res.status(400).json({
      error: made.error,
      message: { name_required: 'A name is needed.', date_invalid: 'That is not a date.' }[made.error]
        || 'That could not be saved.'
    });
  }
  audit(req, 'create', 'expected_visit', made.id, { name: made.full_name, on: made.expected_on });
  res.json(made);
});

router.patch('/expected/:id', (req, res) => {
  const saved = expected.update(Number(req.params.id), req.body || {});
  if (!saved) return res.status(404).json({ error: 'not_found' });
  if (saved.error) {
    return res.status(saved.error === 'not_found' ? 404 : 409).json({
      error: saved.error,
      message: saved.error === 'already_arrived'
        ? 'They have already arrived, so this is now a record of a visit rather than a plan.'
        : 'That could not be changed.'
    });
  }
  audit(req, 'update', 'expected_visit', saved.id, { status: saved.status });
  res.json(saved);
});

router.delete('/expected/:id', (req, res) => {
  if (!expected.remove(Number(req.params.id))) return res.status(404).json({ error: 'not_found' });
  audit(req, 'delete', 'expected_visit', Number(req.params.id), null);
  res.json({ ok: true });
});

router.get('/rollcall', (req, res) => {
  const rows = all(`SELECT v.id, v.signed_in_at, v.visit_type, v.badge_no, v.vehicle_reg, v.reference, v.movement,
                           p.full_name, p.company, p.phone,
                           h.name AS host_name, s.name AS site_name, l.name AS location_name
                    FROM visits v JOIN visitors p ON p.id = v.visitor_id
                    LEFT JOIN hosts h ON h.id = v.host_id LEFT JOIN sites s ON s.id = v.site_id
                    LEFT JOIN locations l ON l.id = v.location_id
                    WHERE v.status = 'onsite' ORDER BY l.name, p.full_name`);
  if (req.query.format === 'csv') {
    const body = csv(rows, [
      { label: 'Name', key: 'full_name' }, { label: 'Company', key: 'company' }, { label: 'Phone', key: 'phone' },
      { label: 'Type', key: 'visit_type' }, { label: 'Staff member', key: 'host_name' }, { label: 'Badge', key: 'badge_no' },
      { label: 'Vehicle', key: 'vehicle_reg' }, { label: 'Reference', key: 'reference' },
      { label: 'Signed in at', key: 'location_name' },
      { label: 'Signed in', key: 'signed_in_at' }, { label: 'Site', key: 'site_name' }
    ]);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="rollcall-${Date.now()}.csv"`);
    return res.send(body);
  }
  res.json({ generated_at: nowISO(), count: rows.length, rows });
});

/* --------------------------------------------------------------- badges */

/**
 * Everything needed to print (or reprint) one badge. A visit signed in while
 * badge printing was off has no number yet, so one is issued now rather than
 * printing a badge with a blank space where it should be.
 */
router.post('/visits/:id/badge', (req, res) => {
  const visit = get(`SELECT v.*, p.full_name, p.company, h.name AS host_name, s.name AS site_name
                     FROM visits v JOIN visitors p ON p.id = v.visitor_id
                     LEFT JOIN hosts h ON h.id = v.host_id LEFT JOIN sites s ON s.id = v.site_id
                     WHERE v.id = ?`, req.params.id);
  if (!visit) return res.status(404).json({ error: 'not_found' });

  if (!visit.badge_no) {
    visit.badge_no = nextBadgeNo(localtime.dayOf(visit.signed_in_at), visit.visit_type);
    run('UPDATE visits SET badge_no = ? WHERE id = ?', visit.badge_no, visit.id);
  }

  audit(req, 'reprint_badge', 'visit', Number(req.params.id), { badge_no: visit.badge_no });
  res.json({ visit, badge: settings.getSection('badge'), org: settings.getSection('org') });
});

/**
 * Which door a driver has been sent to. Set from the desk after they arrive, so
 * it is a small edit on a live visit rather than something they type themselves.
 */
router.patch('/visits/:id/door', (req, res) => {
  const door = String(req.body.door == null ? '' : req.body.door).trim();
  if (!/^\d{0,2}$/.test(door)) return res.status(400).json({ error: 'door_must_be_up_to_two_digits' });
  const visit = get('SELECT id FROM visits WHERE id = ?', req.params.id);
  if (!visit) return res.status(404).json({ error: 'not_found' });
  run('UPDATE visits SET door = ? WHERE id = ?', door || null, visit.id);
  audit(req, 'set_door', 'visit', visit.id, { door });
  res.json({ ok: true, door: door || null });
});

/** Badges issued recently, for reprinting a lost or damaged one. */
router.get('/badges', (req, res) => {
  const day = localtime.dayRange(localtime.today());
  res.json({
    issued: all(`SELECT v.id, v.badge_no, v.signed_in_at, v.status, v.visit_type, v.photo_path,
                        p.full_name, p.company, h.name AS host_name
                 FROM visits v JOIN visitors p ON p.id = v.visitor_id
                 LEFT JOIN hosts h ON h.id = v.host_id
                 WHERE v.signed_in_at >= date('now','-7 days')
                 ORDER BY v.signed_in_at DESC LIMIT 100`),
    printed_today: get(`SELECT COUNT(*) AS n FROM visits
                        WHERE badge_no IS NOT NULL AND signed_in_at >= ? AND signed_in_at < ?`,
      day.start, day.end).n
  });
});

/* --------------------------------------------------------------- drivers */

/** Everything about truck drivers in one place: who is on site, and the log. */
router.get('/drivers', (req, res) => {
  const day = localtime.dayRange(localtime.today());
  const base = `SELECT v.*, p.full_name, p.company, p.phone, l.name AS location_name, d.name AS device_name
                FROM visits v JOIN visitors p ON p.id = v.visitor_id
                LEFT JOIN locations l ON l.id = v.location_id
                LEFT JOIN devices d ON d.id = v.device_id
                WHERE v.visit_type = 'driver'`;

  const onsite = all(`${base} AND v.status = 'onsite' ORDER BY v.signed_in_at DESC`);

  const where = [];
  const params = [];
  if (req.query.from) { where.push('v.signed_in_at >= ?'); params.push(req.query.from); }
  if (req.query.to) { where.push('v.signed_in_at <= ?'); params.push(`${req.query.to}T23:59:59.999Z`); }
  if (req.query.q) {
    where.push('(lower(p.full_name) LIKE ? OR lower(p.company) LIKE ? OR lower(v.vehicle_reg) LIKE ? OR lower(v.reference) LIKE ?)');
    const like = `%${String(req.query.q).toLowerCase()}%`;
    params.push(like, like, like, like);
  }
  const log = all(`${base} ${where.length ? 'AND ' + where.join(' AND ') : ''}
                   ORDER BY v.signed_in_at DESC LIMIT ?`, ...params, Number(req.query.limit) || 300);

  if (req.query.format === 'csv') {
    const body = csv(log, [
      { label: 'Driver', key: 'full_name' }, { label: 'Haulier', key: 'company' }, { label: 'Phone', key: 'phone' },
      { label: 'Vehicle', key: 'vehicle_reg' }, { label: 'Reference', key: 'reference' },
      { label: 'Pick-Up / Delivery', key: 'movement' }, { label: 'Door', key: 'door' },
      { label: 'Location', key: 'location_name' },
      { label: 'Arrived', key: 'signed_in_at' }, { label: 'Left', key: 'signed_out_at' },
      { label: 'On site (minutes)', value: (r) => (r.signed_out_at
        ? Math.round((new Date(r.signed_out_at) - new Date(r.signed_in_at)) / 60000) : '') },
      { label: 'Status', key: 'status' }
    ]);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="drivers-${Date.now()}.csv"`);
    return res.send(body);
  }

  const count = (sql, ...p) => get(sql, ...p).n;
  res.json({
    onsite,
    log,
    stats: {
      onsite: onsite.length,
      today: count(`SELECT COUNT(*) AS n FROM visits WHERE visit_type = 'driver'
                    AND signed_in_at >= ? AND signed_in_at < ?`, day.start, day.end),
      delivering_today: count(`SELECT COUNT(*) AS n FROM visits WHERE visit_type = 'driver'
                               AND movement IN ('Delivery','Delivering','Both')
                               AND signed_in_at >= ? AND signed_in_at < ?`, day.start, day.end),
      collecting_today: count(`SELECT COUNT(*) AS n FROM visits WHERE visit_type = 'driver'
                               AND movement IN ('Pick-Up','Collecting','Both')
                               AND signed_in_at >= ? AND signed_in_at < ?`, day.start, day.end),
      avg_minutes: get(`SELECT AVG((julianday(signed_out_at) - julianday(signed_in_at)) * 1440) AS m
                        FROM visits WHERE visit_type = 'driver' AND signed_out_at IS NOT NULL`).m
    }
  });
});

/* ---------------------------------------------------------------- visits */

router.get('/visits', (req, res) => {
  const { from, to, status, q, type, project_id } = req.query;
  const where = [];
  const params = [];
  if (from) { where.push('v.signed_in_at >= ?'); params.push(from); }
  if (to) { where.push('v.signed_in_at <= ?'); params.push(`${to}T23:59:59.999Z`); }
  if (status) { where.push('v.status = ?'); params.push(status); }
  if (type) { where.push('v.visit_type = ?'); params.push(type); }
  // So an export taken from Reports covers the same window and the same
  // project as the figures it was downloaded from.
  if (project_id) { where.push('v.project_id = ?'); params.push(Number(project_id)); }
  if (q) { where.push('(lower(p.full_name) LIKE ? OR lower(p.company) LIKE ? OR lower(h.name) LIKE ?)');
    params.push(`%${String(q).toLowerCase()}%`, `%${String(q).toLowerCase()}%`, `%${String(q).toLowerCase()}%`); }
  const sql = `SELECT v.*, p.full_name, p.company, p.phone, p.email, h.name AS host_name, s.name AS site_name,
                      j.name AS project_name
               FROM visits v JOIN visitors p ON p.id = v.visitor_id
               LEFT JOIN hosts h ON h.id = v.host_id LEFT JOIN sites s ON s.id = v.site_id
               LEFT JOIN projects j ON j.id = v.project_id
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY v.signed_in_at DESC LIMIT ?`;
  /*
   * How many there are, as well as the page being shown.
   *
   * The list was capped at 500 with nothing saying so, which reads as "that
   * is all of them": you would export what you thought was everything and
   * quietly be missing the rest.
   */
  const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 200));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const total = get(`SELECT COUNT(*) AS n FROM visits v JOIN visitors p ON p.id = v.visitor_id
                     LEFT JOIN hosts h ON h.id = v.host_id
                     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`, ...params).n;

  // A spreadsheet is the whole thing by definition — nobody wants page one.
  const rows = req.query.format === 'csv'
    ? all(sql, ...params, 100000)
    : all(`${sql} OFFSET ?`, ...params, limit, offset);

  if (req.query.format === 'csv') {
    const body = csv(rows, [
      { label: 'Name', key: 'full_name' }, { label: 'Company', key: 'company' }, { label: 'Phone', key: 'phone' },
      { label: 'Email', key: 'email' }, { label: 'Type', key: 'visit_type' }, { label: 'Purpose', key: 'purpose' },
      { label: 'Project', key: 'project_name' },
      { label: 'Staff member', key: 'host_name' }, { label: 'Badge', key: 'badge_no' }, { label: 'Vehicle', key: 'vehicle_reg' },
      { label: 'Reference', key: 'reference' }, { label: 'Pick-Up / Delivery', key: 'movement' },
      { label: 'Signed in', key: 'signed_in_at' }, { label: 'Signed out', key: 'signed_out_at' },
      { label: 'Status', key: 'status' }, { label: 'Site', key: 'site_name' }
    ]);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="visits-${Date.now()}.csv"`);
    return res.send(body);
  }
  /*
   * Still a bare array, with the count in a header. Several suites and a
   * couple of older call sites index straight into this, and changing the
   * shape would break them without saying so.
   */
  res.setHeader('X-Total-Count', String(total));
  res.setHeader('X-Offset', String(offset));
  res.json(rows);
});

router.get('/visits/:id', (req, res) => {
  const visit = get(`SELECT v.*, p.full_name, p.company, p.phone, p.email, p.photo_path AS profile_photo,
                            h.name AS host_name, s.name AS site_name, l.name AS location_name, d.name AS device_name,
                            j.name AS project_name
                     FROM visits v JOIN visitors p ON p.id = v.visitor_id
                     LEFT JOIN hosts h ON h.id = v.host_id LEFT JOIN sites s ON s.id = v.site_id
                     LEFT JOIN locations l ON l.id = v.location_id
                     LEFT JOIN projects j ON j.id = v.project_id
                     LEFT JOIN devices d ON d.id = v.device_id WHERE v.id = ?`, req.params.id);
  if (!visit) return res.status(404).json({ error: 'not_found' });
  visit.signatures = all(`SELECT sg.*, a.name AS agreement_name, a.questions AS agreement_questions
                          FROM signatures sg
                          LEFT JOIN agreements a ON a.id = sg.agreement_id WHERE sg.visit_id = ?`, visit.id);
  visit.inductions = all(`SELECT sv.*, ss.name AS slideshow_name FROM slide_views sv
                          LEFT JOIN slideshows ss ON ss.id = sv.slideshow_id WHERE sv.visit_id = ?`, visit.id);
  visit.notifications = all('SELECT * FROM notifications WHERE visit_id = ? ORDER BY id DESC', visit.id);
  res.json(visit);
});

router.post('/visits/:id/signout', (req, res) => {
  const visit = get('SELECT * FROM visits WHERE id = ?', req.params.id);
  if (!visit) return res.status(404).json({ error: 'not_found' });
  run("UPDATE visits SET signed_out_at = ?, status = 'out', signed_out_by = ? WHERE id = ?", nowISO(), req.user.email, req.params.id);
  audit(req, 'signout', 'visit', Number(req.params.id));
  notify.notifyDeparture(Number(req.params.id)).catch(() => {});
  res.json({ ok: true });
});

router.post('/visits/signout-all', (req, res) => {
  const n = run("UPDATE visits SET signed_out_at = ?, status = 'out', signed_out_by = ? WHERE status = 'onsite'",
    nowISO(), req.user.email).changes;
  audit(req, 'signout_all', 'visit', null, { count: n });
  res.json({ ok: true, count: n });
});

/**
 * Put somebody back on site.
 *
 * Sign-out is one tap next to somebody else's name, and until now the only way
 * back was to sign them in again — a second visit for one afternoon, and a
 * roll call that is wrong in the other direction. This restores the visit that
 * is already there.
 */
router.post('/visits/:id/undo-signout', (req, res) => {
  const visit = get('SELECT id, status, signed_out_at FROM visits WHERE id = ?', req.params.id);
  if (!visit) return res.status(404).json({ error: 'not_found' });
  if (visit.status === 'onsite') {
    return res.status(400).json({ error: 'already_onsite', message: 'They are already signed in.' });
  }
  run("UPDATE visits SET status = 'onsite', signed_out_at = NULL, signed_out_by = NULL WHERE id = ?", req.params.id);
  audit(req, 'undo_signout', 'visit', Number(req.params.id), { was_signed_out_at: visit.signed_out_at });
  res.json({ ok: true, message: 'Back on site.' });
});

router.delete('/visits/:id', (req, res) => {
  // Archived first, so the signed documents and induction record survive the
  // delete and the whole thing can be put back.
  const kept = archive.archiveVisit(Number(req.params.id), req.user);
  run('DELETE FROM visits WHERE id = ?', req.params.id);
  audit(req, 'delete', 'visit', Number(req.params.id), { archived: kept });
  res.json({ ok: true, archived: kept });
});

/* -------------------------------------------------------------- visitors */

router.get('/visitors', (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  const rows = q
    ? all(`SELECT * FROM visitors WHERE lower(full_name) LIKE ? OR lower(company) LIKE ? OR lower(email) LIKE ? OR phone LIKE ?
           ORDER BY last_visit_at DESC LIMIT 300`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`)
    : all('SELECT * FROM visitors ORDER BY last_visit_at DESC LIMIT 300');
  res.json(rows);
});

router.get('/visitors/:id', (req, res) => {
  const v = get('SELECT * FROM visitors WHERE id = ?', req.params.id);
  if (!v) return res.status(404).json({ error: 'not_found' });
  v.visits = all(`SELECT v.*, h.name AS host_name FROM visits v LEFT JOIN hosts h ON h.id = v.host_id
                  WHERE v.visitor_id = ? ORDER BY v.signed_in_at DESC LIMIT 100`, v.id);
  v.inductions = all(`SELECT sv.*, ss.name AS slideshow_name FROM slide_views sv
                      LEFT JOIN slideshows ss ON ss.id = sv.slideshow_id WHERE sv.visitor_id = ? ORDER BY sv.id DESC`, v.id);
  res.json(v);
});

router.patch('/visitors/:id', (req, res) => {
  const b = req.body || {};
  run(`UPDATE visitors SET full_name = COALESCE(?, full_name), company = COALESCE(?, company),
        email = COALESCE(?, email), phone = COALESCE(?, phone), blocked = COALESCE(?, blocked), notes = COALESCE(?, notes)
       WHERE id = ?`,
    clean(b.full_name), clean(b.company), clean(b.email), clean(b.phone),
    b.blocked === undefined ? null : (b.blocked ? 1 : 0), clean(b.notes), req.params.id);
  audit(req, 'update', 'visitor', Number(req.params.id), b);
  res.json(get('SELECT * FROM visitors WHERE id = ?', req.params.id));
});

router.post('/visitors/:id/reset-induction', (req, res) => {
  run('DELETE FROM slide_views WHERE visitor_id = ?', req.params.id);
  run('UPDATE visitors SET induction_completed_at = NULL, induction_version = NULL WHERE id = ?', req.params.id);
  audit(req, 'reset_induction', 'visitor', Number(req.params.id));
  res.json({ ok: true });
});

router.delete('/visitors/:id', (req, res) => {
  // Takes every visit they ever made with it, so all of that is archived too.
  const kept = archive.archiveVisitor(Number(req.params.id), req.user);
  run('DELETE FROM visitors WHERE id = ?', req.params.id);
  audit(req, 'delete', 'visitor', Number(req.params.id), { archived: kept });
  res.json({ ok: true, archived: kept });
});

/* ------------------------------------------------- deleted records & log */

router.get('/archive', (req, res) => res.json(archive.list({ limit: req.query.limit })));

router.post('/archive/:id/restore', (req, res) => {
  const result = archive.restore(Number(req.params.id));
  if (!result.ok) {
    const message = {
      not_found: 'That entry is no longer in the deleted list.',
      already_present: 'That record is already back — nothing to restore.',
      visitor_gone: 'The visitor this belongs to was deleted and purged, so the visit cannot be restored.',
      unreadable: 'That entry could not be read.'
    }[result.error] || 'That entry could not be restored.';
    return res.status(400).json({ ...result, message });
  }
  audit(req, 'restore', result.kind, Number(req.params.id), { label: result.label });
  res.json(result);
});

router.delete('/archive/:id', (req, res) => {
  const result = archive.purge(Number(req.params.id));
  if (!result.ok) return res.status(404).json(result);
  audit(req, 'purge', 'archive', Number(req.params.id), { label: result.label });
  res.json(result);
});

/** Who changed what, and when. Written all along; now it can be read. */
router.get('/audit', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  res.json(all(`SELECT a.*, u.name AS user_name, u.email AS user_email
                FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
                ORDER BY a.id DESC LIMIT ?`, limit));
});

/* ------------------------------------------------- simple CRUD resources */

function crud(resource, table, fields) {
  router.get(`/${resource}`, (req, res) => res.json(all(`SELECT * FROM ${table} ORDER BY id DESC`)));
  router.post(`/${resource}`, (req, res) => {
    const cols = fields.filter((f) => req.body[f] !== undefined);
    const sql = `INSERT INTO ${table} (${[...cols, 'created_at'].join(',')}) VALUES (${cols.map(() => '?').join(',')}${cols.length ? ',' : ''}?)`;
    const r = run(sql, ...cols.map((c) => req.body[c]), nowISO());
    audit(req, 'create', table, Number(r.lastInsertRowid), req.body);
    res.json(get(`SELECT * FROM ${table} WHERE id = ?`, r.lastInsertRowid));
  });
  router.patch(`/${resource}/:id`, (req, res) => {
    const cols = fields.filter((f) => req.body[f] !== undefined);
    if (cols.length) {
      run(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
        ...cols.map((c) => req.body[c]), req.params.id);
    }
    audit(req, 'update', table, Number(req.params.id), req.body);
    res.json(get(`SELECT * FROM ${table} WHERE id = ?`, req.params.id));
  });
  router.delete(`/${resource}/:id`, (req, res) => {
    run(`DELETE FROM ${table} WHERE id = ?`, req.params.id);
    audit(req, 'delete', table, Number(req.params.id));
    res.json({ ok: true });
  });
}

crud('staff', 'hosts', ['site_id', 'name', 'email', 'phone', 'department', 'webhook_url', 'active']);
crud('sites', 'sites', ['name', 'address', 'max_occupancy', 'active']);
crud('agreements', 'agreements', ['name', 'body', 'name_es', 'body_es', 'version', 'required_for', 'questions',
  'require_signature', 'repeat_after_days', 'active']);
crud('access-points', 'access_points', ['site_id', 'name', 'kind', 'url', 'method', 'headers', 'body',
  'unlock_seconds', 'auto_unlock_on_signin', 'auto_unlock_on_signout', 'enabled', 'notes']);

/** Send a test straight to one person's own webhook, so it can be proved before a visitor relies on it. */
router.post('/staff/:id/test-webhook', async (req, res) => {
  const person = get('SELECT * FROM hosts WHERE id = ?', req.params.id);
  if (!person) return res.status(404).json({ error: 'not_found' });

  const url = clean(req.body.url) || person.webhook_url;
  if (!url) return res.json({ ok: false, detail: 'No chat webhook is set for this person yet.' });

  const org = settings.getSection('org');
  const result = await notify.sendWebhook({
    url,
    title: `Test from ${org.name} Smart Lobby`,
    lines: [
      `This is what ${person.name} will see when a visitor arrives for them.`,
      'Visitor: Sam Taylor (Acme Roofing)',
      'Type: contractor'
    ]
  });
  audit(req, 'test_webhook', 'staff', person.id, { ok: result.ok, status: result.status });
  res.json(result);
});

/* --------------------------------------------------------- staff import */

const sheets = require('../spreadsheet');

router.get('/staff/template.csv', (req, res) => {
  const example = settings.phoneCountry(settings.getSection('org').phone_country).example;
  const body = ['First name,Last name,Email,Phone,Department,Chat webhook',
    `Alex,Green,alex@example.com,${example},Site office,`,
    `Priya,Shah,priya@example.com,${example},Estimating,`].join('\r\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="staff-template.csv"');
  res.send(body);
});

/**
 * Bulk add or update staff from a spreadsheet. Matches an existing person by
 * email, falling back to name, so re-importing a corrected sheet updates rather
 * than duplicating.
 */
router.post('/staff/import', files.memoryUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });

  let rows;
  try {
    rows = sheets.parseSpreadsheet(req.file.buffer, req.file.originalname);
  } catch (err) {
    return res.status(400).json({ error: String(err.message || err) });
  }
  if (!rows.length) return res.status(400).json({ error: 'empty_file' });

  const header = sheets.mapHeaders(rows[0]);
  const hasName = header.name !== undefined || header.first_name !== undefined || header.last_name !== undefined;
  if (!hasName) return res.status(400).json({ error: 'no_name_column', found: rows[0] });

  const created = [];
  const updated = [];
  const skipped = [];
  const cell = (row, key) => (header[key] === undefined ? '' : clean(row[header[key]] || ''));

  rows.slice(1).forEach((row, i) => {
    // Either a single Name column, or First name and Last name columns.
    const name = cell(row, 'name')
      || [cell(row, 'first_name'), cell(row, 'last_name')].filter(Boolean).join(' ').trim();
    if (!name) { skipped.push({ line: i + 2, reason: 'no name' }); return; }
    const email = cell(row, 'email').toLowerCase();
    const phone = cell(row, 'phone');
    const department = cell(row, 'department');
    const webhook = cell(row, 'webhook_url');

    // Match on email first, then fall back to the name, so adding an email to
    // somebody already on the list updates them rather than duplicating them.
    const existing = (email ? get('SELECT * FROM hosts WHERE lower(email) = ?', email) : null)
      || get('SELECT * FROM hosts WHERE lower(name) = ?', name.toLowerCase());

    if (existing) {
      run(`UPDATE hosts SET name = ?, email = COALESCE(NULLIF(?,''), email), phone = COALESCE(NULLIF(?,''), phone),
             department = COALESCE(NULLIF(?,''), department), webhook_url = COALESCE(NULLIF(?,''), webhook_url), active = 1
           WHERE id = ?`, name, email, phone, department, webhook, existing.id);
      updated.push(name);
    } else {
      run(`INSERT INTO hosts (name, email, phone, department, webhook_url, active, created_at)
           VALUES (?,?,?,?,?,1,?)`,
        name, email || null, phone || null, department || null, webhook || null, nowISO());
      created.push(name);
    }
  });

  audit(req, 'import', 'staff', null, { file: req.file.originalname, created: created.length, updated: updated.length });
  res.json({ ok: true, created: created.length, updated: updated.length, skipped, names: created.concat(updated).slice(0, 50) });
});

/* ------------------------------------------------------------- locations */

router.get('/locations', (req, res) => {
  const rows = all(`SELECT l.*, s.name AS site_name,
                      (SELECT COUNT(*) FROM devices d WHERE d.location_id = l.id) AS device_count,
                      (SELECT COUNT(*) FROM visits v WHERE v.location_id = l.id AND v.status = 'onsite') AS onsite
                    FROM locations l LEFT JOIN sites s ON s.id = l.site_id
                    ORDER BY l.name`);
  res.json(rows);
});

router.post('/locations', (req, res) => {
  const b = req.body || {};
  if (!clean(b.name)) return res.status(400).json({ error: 'name_required' });
  const r = run('INSERT INTO locations (site_id, name, description, active, created_at) VALUES (?,?,?,?,?)',
    b.site_id || null, clean(b.name), clean(b.description) || null, b.active === false ? 0 : 1, nowISO());
  audit(req, 'create', 'location', Number(r.lastInsertRowid), b);
  res.json(get('SELECT * FROM locations WHERE id = ?', r.lastInsertRowid));
});

router.patch('/locations/:id', (req, res) => {
  const b = req.body || {};
  const fields = ['site_id', 'name', 'description', 'active'];
  const cols = fields.filter((f) => b[f] !== undefined);
  if (cols.length) {
    run(`UPDATE locations SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
      ...cols.map((c) => (typeof b[c] === 'boolean' ? (b[c] ? 1 : 0) : b[c])), req.params.id);
  }
  audit(req, 'update', 'location', Number(req.params.id), b);
  res.json(get('SELECT * FROM locations WHERE id = ?', req.params.id));
});

router.delete('/locations/:id', (req, res) => {
  run('DELETE FROM locations WHERE id = ?', req.params.id);
  audit(req, 'delete', 'location', Number(req.params.id));
  res.json({ ok: true });
});

/* -------------------------------------------------------------- projects */

/**
 * The jobs contractors sign in against. Each carries how many people are on it
 * right now, so a project cannot be deleted without seeing who is still on site.
 */
router.get('/projects', (req, res) => {
  res.json(all(`SELECT p.*, s.name AS site_name,
                  (SELECT COUNT(*) FROM visits v WHERE v.project_id = p.id AND v.status = 'onsite') AS onsite,
                  (SELECT COUNT(*) FROM visits v WHERE v.project_id = p.id) AS visits_total
                FROM projects p LEFT JOIN sites s ON s.id = p.site_id
                ORDER BY p.active DESC, p.name`));
});

router.post('/projects', (req, res) => {
  const b = req.body || {};
  if (!clean(b.name)) return res.status(400).json({ error: 'name_required' });
  const r = run('INSERT INTO projects (site_id, name, name_es, code, active, created_at) VALUES (?,?,?,?,?,?)',
    b.site_id || null, clean(b.name), clean(b.name_es) || null, clean(b.code) || null,
    b.active === false ? 0 : 1, nowISO());
  settings.bumpConfigRev();
  audit(req, 'create', 'project', Number(r.lastInsertRowid), b);
  res.json(get('SELECT * FROM projects WHERE id = ?', r.lastInsertRowid));
});

router.patch('/projects/:id', (req, res) => {
  const b = req.body || {};
  const fields = ['site_id', 'name', 'name_es', 'code', 'active'];
  const cols = fields.filter((f) => b[f] !== undefined);
  if (cols.length) {
    run(`UPDATE projects SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
      ...cols.map((c) => (typeof b[c] === 'boolean' ? (b[c] ? 1 : 0) : b[c])), req.params.id);
  }
  settings.bumpConfigRev();
  audit(req, 'update', 'project', Number(req.params.id), b);
  res.json(get('SELECT * FROM projects WHERE id = ?', req.params.id));
});

/*
 * Visits keep their project through ON DELETE SET NULL, which would quietly
 * empty the project column of every past visit. Closing a finished job is what
 * is usually meant, so deleting one that has any history is refused and the
 * caller is told to make it inactive instead.
 */
router.delete('/projects/:id', (req, res) => {
  const used = get('SELECT COUNT(*) AS n FROM visits WHERE project_id = ?', req.params.id).n;
  if (used) return res.status(409).json({ error: 'project_in_use', visits: used });
  run('DELETE FROM projects WHERE id = ?', req.params.id);
  settings.bumpConfigRev();
  audit(req, 'delete', 'project', Number(req.params.id));
  res.json({ ok: true });
});

/* ------------------------------------------------- documents to sign */

/**
 * Attach a PDF or Word file to a document. It is rendered to page images so a
 * contractor reads it exactly as it was drafted — the layout of a safety
 * document is part of what they are agreeing to. Uploading to `es` attaches
 * the Spanish copy of the same document, alongside the English one.
 */
router.post('/agreements/:id/file', files.memoryUpload.single('file'), (req, res) => {
  const doc = get('SELECT * FROM agreements WHERE id = ?', req.params.id);
  if (!doc) return res.status(404).json({ error: 'not_found' });
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  const es = req.query.language === 'es';

  try {
    const out = decks.renderPages(
      { buffer: req.file.buffer, originalname: req.file.originalname },
      `documents/${doc.id}${es ? '/es' : ''}`
    );
    // A replaced file leaves its old pages behind otherwise.
    removeDocPages(doc, es);
    run(`UPDATE agreements SET ${es ? 'pages_es = ?, source_file_es = ?, render_mode_es = ?' : 'pages = ?, source_file = ?, render_mode = ?'},
         version = version + 1 WHERE id = ?`,
    JSON.stringify(out.pages), out.source, out.method, doc.id);
    audit(req, 'upload_document', 'agreement', doc.id, { file: out.source, language: es ? 'es' : 'en', method: out.method });
    res.json({ ok: true, ...out, agreement: get('SELECT * FROM agreements WHERE id = ?', doc.id) });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

function removeDocPages(doc, es) {
  let pages = [];
  try { pages = JSON.parse((es ? doc.pages_es : doc.pages) || '[]'); } catch { pages = []; }
  pages.forEach((p) => files.removeFile(p));
}

/** Drop the uploaded file and go back to the typed wording. */
router.delete('/agreements/:id/file', (req, res) => {
  const doc = get('SELECT * FROM agreements WHERE id = ?', req.params.id);
  if (!doc) return res.status(404).json({ error: 'not_found' });
  const es = req.query.language === 'es';
  removeDocPages(doc, es);
  run(`UPDATE agreements SET ${es ? 'pages_es = NULL, source_file_es = NULL, render_mode_es = NULL'
    : 'pages = NULL, source_file = NULL, render_mode = NULL'}, version = version + 1 WHERE id = ?`, doc.id);
  audit(req, 'remove_document_file', 'agreement', doc.id, { language: es ? 'es' : 'en' });
  res.json({ ok: true, agreement: get('SELECT * FROM agreements WHERE id = ?', doc.id) });
});

/* -------------------------------------------------------------- printers */

const PRINTER_PORTS = ['network', 'wireless_direct', 'bluetooth'];
const PRINTER_COLORS = ['black', 'red', 'black_red'];

/** What the dashboard may set on a printer, cleaned up. */
function printerBody(b) {
  return {
    name: clean(b.name),
    model: clean(b.model) || null,
    label_type: clean(b.label_type) || null,
    foreground_color: PRINTER_COLORS.includes(b.foreground_color) ? b.foreground_color : 'black',
    port: PRINTER_PORTS.includes(b.port) ? b.port : 'network',
    // Bluetooth has no address; network and Wireless Direct both do (a printer
    // in Wireless Direct is reached at its own access-point address).
    ip_address: (PRINTER_PORTS.includes(b.port) ? b.port : 'network') === 'bluetooth'
      ? null : (clean(b.ip_address) || null),
    // A location that no longer exists is dropped rather than turned into a
    // foreign-key error the dashboard cannot explain.
    location_id: b.location_id && get('SELECT id FROM locations WHERE id = ?', Number(b.location_id))
      ? Number(b.location_id) : null,
    notes: clean(b.notes) || null,
    active: b.active === false || b.active === 0 ? 0 : 1
  };
}

router.get('/printers', (req, res) => {
  res.json(all(`SELECT pr.*, l.name AS location_name,
                  (SELECT COUNT(*) FROM devices d WHERE d.printer_id = pr.id) AS device_count
                FROM printers pr LEFT JOIN locations l ON l.id = pr.location_id
                ORDER BY pr.active DESC, pr.name`));
});

/**
 * "Badges have stopped coming out of this one" — and, later, that they have
 * started again.
 *
 * A person sets it and a person clears it, because there is nothing to
 * observe: badges print over AirPrint from the tablet, the server never speaks
 * to the printer, and on Wireless Direct the printer is on a network only that
 * tablet has joined. Reception noticing is the whole detection mechanism.
 *
 * What this buys over somebody walking round telling people: everyone finds
 * out at once — the dashboard, the on-site board and the chat channel — and
 * the next person to reach the gate is not left wondering why there is no
 * badge.
 *
 * Silence never clears it. Nobody mentioning a printer is what a working one
 * and a dead one both look like on a quiet afternoon.
 */
const printerState = (down) => (req, res) => {
  const printer = get(`SELECT pr.*, l.name AS location_name FROM printers pr
                       LEFT JOIN locations l ON l.id = pr.location_id WHERE pr.id = ?`, req.params.id);
  if (!printer) return res.status(404).json({ error: 'not_found' });

  const who = req.user ? (req.user.name || req.user.email) : null;
  const note = down ? (clean((req.body || {}).note) || null) : null;

  // Already in the state asked for: say so and send nothing, so a second press
  // does not post a duplicate card to the channel.
  if (down === !!printer.trouble_since) return res.json({ ok: true, unchanged: true });

  if (down) run('UPDATE printers SET trouble_since = ?, trouble_by = ?, trouble_note = ? WHERE id = ?',
    nowISO(), who, note, printer.id);
  else run('UPDATE printers SET trouble_since = NULL, trouble_by = NULL, trouble_note = NULL WHERE id = ?',
    printer.id);

  audit(req, 'update', 'printer', Number(printer.id),
    down ? { badges: 'not printing', note } : { badges: 'printing again' });

  notify.notifyPrinter(printer, down ? 'down' : 'back', who, note)
    .catch((err) => console.error('[printer]', err.message));

  res.json({ ok: true });
};

router.post('/printers/:id/trouble', printerState(true));
router.post('/printers/:id/working', printerState(false));

router.post('/printers', (req, res) => {
  const body = printerBody(req.body || {});
  if (!body.name) return res.status(400).json({ error: 'name_required' });
  const r = run(`INSERT INTO printers (name, model, label_type, foreground_color, port, ip_address,
                                       location_id, notes, active, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    body.name, body.model, body.label_type, body.foreground_color, body.port, body.ip_address,
    body.location_id, body.notes, body.active, nowISO());
  audit(req, 'create', 'printer', Number(r.lastInsertRowid), body);
  res.json(get('SELECT * FROM printers WHERE id = ?', r.lastInsertRowid));
});

router.patch('/printers/:id', (req, res) => {
  const existing = get('SELECT * FROM printers WHERE id = ?', req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const body = printerBody({ ...existing, ...req.body });
  if (!body.name) return res.status(400).json({ error: 'name_required' });
  run(`UPDATE printers SET name = ?, model = ?, label_type = ?, foreground_color = ?, port = ?,
        ip_address = ?, location_id = ?, notes = ?, active = ? WHERE id = ?`,
    body.name, body.model, body.label_type, body.foreground_color, body.port, body.ip_address,
    body.location_id, body.notes, body.active, req.params.id);
  audit(req, 'update', 'printer', Number(req.params.id), req.body);
  res.json(get('SELECT * FROM printers WHERE id = ?', req.params.id));
});

router.delete('/printers/:id', (req, res) => {
  run('DELETE FROM printers WHERE id = ?', req.params.id);
  audit(req, 'delete', 'printer', Number(req.params.id));
  res.json({ ok: true });
});

/* ------------------------------------------------------------- induction */

router.get('/slideshows', (req, res) => {
  const rows = all('SELECT * FROM slideshows ORDER BY id DESC');
  for (const r of rows) {
    r.slide_count = get('SELECT COUNT(*) AS n FROM slides WHERE slideshow_id = ?', r.id).n;
    r.views = get('SELECT COUNT(*) AS n FROM slide_views WHERE slideshow_id = ? AND completed_at IS NOT NULL', r.id).n;
    // How the current slides were produced, so a rebuilt deck is never mistaken
    // for a rendered one.
    const kinds = all('SELECT DISTINCT kind FROM slides WHERE slideshow_id = ?', r.id).map((k) => k.kind);
    r.render_mode = kinds.includes('html') ? 'rebuilt' : kinds.includes('pdf') ? 'pdf' : kinds.length ? 'rendered' : null;
  }
  res.json({ rows, capabilities: decks.capabilities() });
});

router.post('/slideshows', (req, res) => {
  const b = req.body || {};
  const r = run(`INSERT INTO slideshows (name, description, required_for, repeat_after_days, allow_skip,
                   min_seconds_per_slide, language, require_signature, active, created_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?)`,
    clean(b.name) || 'Site induction', clean(b.description) || null,
    JSON.stringify(b.required_for || ['visitor', 'contractor']), Number(b.repeat_after_days) || null,
    b.allow_skip ? 1 : 0, Number(b.min_seconds_per_slide) || 0, b.language === 'es' ? 'es' : 'en',
    b.require_signature ? 1 : 0, b.active === false ? 0 : 1, nowISO());
  audit(req, 'create', 'slideshow', Number(r.lastInsertRowid), b);
  res.json(get('SELECT * FROM slideshows WHERE id = ?', r.lastInsertRowid));
});

router.patch('/slideshows/:id', (req, res) => {
  const b = req.body || {};
  const fields = ['name', 'description', 'repeat_after_days', 'allow_skip', 'min_seconds_per_slide', 'language',
    'require_signature', 'active'];
  const cols = fields.filter((f) => b[f] !== undefined);
  if (cols.length) {
    run(`UPDATE slideshows SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
      ...cols.map((c) => (typeof b[c] === 'boolean' ? (b[c] ? 1 : 0) : b[c])), req.params.id);
  }
  if (b.required_for) run('UPDATE slideshows SET required_for = ? WHERE id = ?', JSON.stringify(b.required_for), req.params.id);
  res.json(get('SELECT * FROM slideshows WHERE id = ?', req.params.id));
});

router.get('/slideshows/:id/slides', (req, res) => {
  res.json(all('SELECT * FROM slides WHERE slideshow_id = ? ORDER BY position, id', req.params.id));
});

router.post('/slideshows/:id/upload', files.memoryUpload.single('file'), (req, res) => {
  const show = get('SELECT * FROM slideshows WHERE id = ?', req.params.id);
  if (!show) return res.status(404).json({ error: 'not_found' });
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  try {
    const result = decks.ingest({ buffer: req.file.buffer, originalname: req.file.originalname }, show.id);
    audit(req, 'upload_deck', 'slideshow', show.id, { file: req.file.originalname, ...result });
    res.json({ ok: true, ...result, slides: all('SELECT * FROM slides WHERE slideshow_id = ? ORDER BY position', show.id) });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

router.delete('/slideshows/:id/slides/:slideId', (req, res) => {
  const slide = get('SELECT * FROM slides WHERE id = ?', req.params.slideId);
  if (slide && slide.image_path) files.removeFile(slide.image_path);
  run('DELETE FROM slides WHERE id = ?', req.params.slideId);
  run('UPDATE slideshows SET version = version + 1, updated_at = ? WHERE id = ?', nowISO(), req.params.id);
  res.json({ ok: true });
});

router.post('/slideshows/:id/reorder', (req, res) => {
  const order = req.body.order || [];
  order.forEach((slideId, i) => run('UPDATE slides SET position = ? WHERE id = ? AND slideshow_id = ?', i, slideId, req.params.id));
  res.json({ ok: true });
});

router.delete('/slideshows/:id', (req, res) => {
  run('DELETE FROM slideshows WHERE id = ?', req.params.id);
  audit(req, 'delete', 'slideshow', Number(req.params.id));
  res.json({ ok: true });
});

/* ------------------------------------------------------------ deliveries */

router.get('/deliveries', (req, res) => {
  const status = req.query.status;
  const rows = status
    ? all(`SELECT d.*, h.name AS host_name FROM deliveries d LEFT JOIN hosts h ON h.id = d.recipient_host_id
           WHERE d.status = ? ORDER BY d.received_at DESC LIMIT 300`, status)
    : all(`SELECT d.*, h.name AS host_name FROM deliveries d LEFT JOIN hosts h ON h.id = d.recipient_host_id
           ORDER BY d.received_at DESC LIMIT 300`);
  if (req.query.format === 'csv') {
    const body = csv(rows, [
      { label: 'Received', key: 'received_at' }, { label: 'Courier', key: 'courier_name' },
      { label: 'Company', key: 'courier_company' }, { label: 'Recipient', value: (r) => r.host_name || r.recipient_text },
      { label: 'Parcels', key: 'parcel_count' }, { label: 'Tracking', key: 'tracking' },
      { label: 'Status', key: 'status' }, { label: 'Collected', key: 'collected_at' }, { label: 'Collected by', key: 'collected_by' }
    ]);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="deliveries-${Date.now()}.csv"`);
    return res.send(body);
  }
  res.json(rows);
});

router.post('/deliveries', (req, res) => {
  const b = req.body || {};
  const r = run(`INSERT INTO deliveries (site_id, courier_name, courier_company, recipient_host_id, recipient_text,
                   tracking, parcel_count, notes, status, received_at) VALUES (?,?,?,?,?,?,?,?, 'awaiting', ?)`,
    b.site_id || null, clean(b.courier_name), clean(b.courier_company), b.recipient_host_id || null,
    clean(b.recipient_text), clean(b.tracking), Number(b.parcel_count) || 1, clean(b.notes), nowISO());
  const id = Number(r.lastInsertRowid);
  if (settings.getSection('deliveries').notify_recipient) notify.notifyDelivery(id).catch(() => {});
  res.json(get('SELECT * FROM deliveries WHERE id = ?', id));
});

router.post('/deliveries/:id/collect', (req, res) => {
  const sig = files.saveDataUrl(req.body.signature, 'private', 'signatures');
  run(`UPDATE deliveries SET status = 'collected', collected_at = ?, collected_by = ?, collection_signature_path = ?
       WHERE id = ?`, nowISO(), clean(req.body.collected_by) || req.user.name, sig, req.params.id);
  audit(req, 'collect', 'delivery', Number(req.params.id));
  res.json(get('SELECT * FROM deliveries WHERE id = ?', req.params.id));
});

router.post('/deliveries/:id/notify', async (req, res) => {
  await notify.notifyDelivery(Number(req.params.id));
  res.json({ ok: true });
});

router.delete('/deliveries/:id', (req, res) => {
  run('DELETE FROM deliveries WHERE id = ?', req.params.id);
  res.json({ ok: true });
});

/* ---------------------------------------------------------------- access */

router.post('/access-points/:id/trigger', async (req, res) => {
  const result = await accessCtl.trigger(Number(req.params.id), { actor: req.user.email, source: 'admin' });
  audit(req, 'unlock', 'access_point', Number(req.params.id), result);
  res.json(result);
});

router.get('/access-events', (req, res) => {
  res.json(all(`SELECT e.*, a.name AS access_point_name FROM access_events e
                LEFT JOIN access_points a ON a.id = e.access_point_id
                ORDER BY e.id DESC LIMIT 200`));
});

/* --------------------------------------------------------------- devices */

router.get('/devices', (req, res) => {
  res.json(all(`SELECT d.*, l.name AS location_name FROM devices d
                LEFT JOIN locations l ON l.id = d.location_id ORDER BY d.name`));
});

router.post('/devices', (req, res) => {
  const b = req.body || {};
  const token = crypto.randomBytes(16).toString('hex');
  const name = clean(b.name) || 'Reception kiosk';
  const r = run(`INSERT INTO devices (site_id, location_id, name, slug, token, mode, default_camera, print_enabled, created_at)
                 VALUES (?,?,?,?,?,?,?,?,?)`,
    b.site_id || null, b.location_id || null, name, deviceSlugs.uniqueSlug(clean(b.slug) || name), token,
    clean(b.mode) || 'kiosk', clean(b.default_camera) || 'front', b.print_enabled === false ? 0 : 1, nowISO());
  audit(req, 'create', 'device', Number(r.lastInsertRowid), { name });
  res.json(get('SELECT * FROM devices WHERE id = ?', r.lastInsertRowid));
});

/*
 * The links for one device, and their QR codes.
 *
 * Two different things, deliberately separate: the tablet's own address, which
 * goes on the tablet, and the phone check-in address, which goes on a sign at
 * the gate. Reissuing the second does not disturb the first — the tablet's
 * home-screen icon keeps working.
 */
router.get('/devices/:id/links', (req, res) => {
  const device = get('SELECT * FROM devices WHERE id = ?', req.params.id);
  if (!device) return res.status(404).json({ error: 'not_found' });
  const base = notify.baseUrl();
  const kiosk = device.slug ? `${base}/kiosk/${encodeURIComponent(device.slug)}` : `${base}/kiosk/`;
  const self = device.self_checkin && device.self_code ? `${base}/go/${device.self_code}` : null;
  res.json({
    kiosk,
    self,
    self_enabled: !!device.self_checkin,
    // Whether phone check-in is switched on for the site at all: a device can
    // be set up for it and still be inert until the site setting is on.
    site_enabled: settings.getSection('kiosk').self_checkin_enabled !== false
      && !!settings.getSection('kiosk').self_checkin_enabled,
    geofence: require('../geofence').publicSettings()
  });
});

/**
 * The sign to put on the wall, ready to print.
 *
 * Opened in a tab and printed — which is also how it is saved as a PDF, so it
 * can be sent to whoever actually owns the laminator. Served as its own page
 * rather than printed out of the dashboard: the admin stylesheet is built for
 * a screen with a menu down one side, and a sign is a sheet of paper with one
 * enormous code on it.
 *
 * The address is built here but only ever handed over as the code itself —
 * see sign-print.js for why it is not printed in words as well.
 */
router.get('/devices/:id/sign', async (req, res) => {
  const device = get('SELECT * FROM devices WHERE id = ?', req.params.id);
  if (!device) return res.status(404).send('No such device');
  if (!device.self_checkin || !device.self_code) {
    return res.status(409).type('text/plain')
      .send('Phone check-in is off for this device. Switch it on under Devices → Edit, '
        + 'and for the site under Settings → Kiosk sign-in flow.');
  }

  const url = `${notify.baseUrl()}/go/${device.self_code}`;
  const org = settings.getSection('org');
  const location = device.location_id
    ? get('SELECT name FROM locations WHERE id = ?', device.location_id) : null;

  let qrSvg = '';
  try {
    qrSvg = await require('qrcode').toString(url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
  } catch { qrSvg = ''; }

  res.type('html').send(require('../sign-print').render({
    qrSvg,
    deviceName: device.name,
    location: location ? location.name : '',
    orgName: org.name || '',
    logoPath: org.logo_path || '',
    geofenced: require('../geofence').publicSettings().enabled
  }));
});

/** A fresh phone check-in code, which stops every printed sign at once. */
router.post('/devices/:id/self-code', (req, res) => {
  const device = get('SELECT * FROM devices WHERE id = ?', req.params.id);
  if (!device) return res.status(404).json({ error: 'not_found' });
  const code = deviceSlugs.newSelfCode();
  run('UPDATE devices SET self_code = ?, self_checkin = 1 WHERE id = ?', code, device.id);
  audit(req, 'self_code_issued', 'device', device.id, { name: device.name });
  res.json({ ok: true, code, url: `${notify.baseUrl()}/go/${code}` });
});

router.patch('/devices/:id', (req, res) => {
  const b = req.body || {};
  /*
   * Switching phone check-in on for the first time mints the code, so there is
   * never a device with the feature on and no link to hand out.
   */
  if (b.self_checkin) {
    const existing = get('SELECT self_code FROM devices WHERE id = ?', req.params.id);
    if (existing && !existing.self_code) {
      run('UPDATE devices SET self_code = ? WHERE id = ?', deviceSlugs.newSelfCode(), req.params.id);
    }
  }
  const fields = ['site_id', 'location_id', 'name', 'mode', 'default_camera', 'print_enabled',
    'sections', 'printer_id', 'self_checkin'];
  const cols = fields.filter((f) => b[f] !== undefined);
  if (cols.length) {
    run(`UPDATE devices SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
      ...cols.map((c) => (typeof b[c] === 'boolean' ? (b[c] ? 1 : 0) : b[c])), req.params.id);
  }
  /*
   * The address is only changed when it is asked for. Renaming a tablet leaves
   * its URL alone on purpose: the link is on an iPad's home screen by then, and
   * silently moving it would strand the tablet on a page that no longer exists.
   */
  if (b.slug !== undefined) {
    run('UPDATE devices SET slug = ? WHERE id = ?',
      deviceSlugs.uniqueSlug(clean(b.slug) || clean(b.name) || 'kiosk', req.params.id), req.params.id);
  }
  audit(req, 'update', 'device', Number(req.params.id), b);
  res.json(get('SELECT * FROM devices WHERE id = ?', req.params.id));
});

router.delete('/devices/:id', (req, res) => {
  run('DELETE FROM devices WHERE id = ?', req.params.id);
  res.json({ ok: true });
});

/* -------------------------------------------------------------- settings */

/*
 * Nothing is masked here any more: the only stored secret was the Twilio auth
 * token, and SMS is gone. The Teams webhook URL is deliberately returned as it
 * is — it has to be editable, and anyone who can read this is already signed
 * in as an admin.
 */
router.get('/settings', (req, res) => res.json(settings.getAll()));

router.put('/settings', (req, res) => {
  const patch = req.body || {};
  const warnings = [];

  // A bad time zone silently breaks auto sign-out and every formatted timestamp,
  // so drop it rather than storing it, and say so.
  if (patch.org && patch.org.timezone !== undefined && !settings.isValidTimeZone(patch.org.timezone)) {
    warnings.push(`"${patch.org.timezone}" is not a valid time zone name — it was not saved. Use an IANA name such as America/New_York.`);
    delete patch.org.timezone;
  }
  if (patch.org && patch.org.date_format !== undefined && !settings.isValidLocale(patch.org.date_format)) {
    warnings.push(`"${patch.org.date_format}" is not a recognised date format — it was not saved.`);
    delete patch.org.date_format;
  }

  // The visitor-type list is stored cleaned up or not at all — a kiosk whose
  // every type was somehow removed would have no way to sign anyone in.
  if (patch.types !== undefined) {
    const cleaned = settings.sanitizeTypes(patch.types);
    if (cleaned) patch.types = cleaned;
    else {
      warnings.push('The visitor types were not saved — at least one type with a name is needed.');
      delete patch.types;
    }
  }

  const updated = settings.setAll(patch);
  audit(req, 'update', 'settings', null, Object.keys(patch));
  res.json({ ...updated, warnings });
});

/* --------------------------------------------------------- branding images */

router.post('/settings/logo', files.imageUpload.single('file'), (req, res) => {
  if (!req.file || !files.looksLikeImage(req.file.buffer)) return res.status(400).json({ error: 'not_an_image' });
  const previous = settings.getSection('org').logo_path;
  const web = files.saveBuffer(req.file.buffer, 'public', 'branding', req.file.originalname);
  settings.setSection('org', { logo_path: web });
  if (previous) files.removeFile(previous);
  audit(req, 'upload', 'logo', null, { file: req.file.originalname });
  res.json({ ok: true, logo_path: web });
});

router.delete('/settings/logo', (req, res) => {
  const current = settings.getSection('org').logo_path;
  if (current) files.removeFile(current);
  settings.setSection('org', { logo_path: null });
  audit(req, 'delete', 'logo', null);
  res.json({ ok: true });
});

const MAX_BACKGROUNDS = 20;
const currentBackgrounds = () => (settings.getSection('org').backgrounds || []).slice();

/** Store the list, keeping the legacy single field pointed at the first image. */
function saveBackgrounds(list) {
  settings.setSection('org', { backgrounds: list, background_path: list[0] || null });
  return list;
}

// Accepts one file or many in a single request; the field name is "file" either way.
router.post('/settings/backgrounds', files.imageUpload.array('file', MAX_BACKGROUNDS), (req, res) => {
  const received = req.files || [];
  const uploaded = received.filter((f) => files.looksLikeImage(f.buffer));
  // Files multer turned away by mimetype, plus any that lied about their extension.
  const rejected = (req.rejectedFiles || 0) + (received.length - uploaded.length);
  if (!uploaded.length) return res.status(400).json({ error: 'not_an_image', rejected });

  const list = currentBackgrounds();
  const room = Math.max(0, MAX_BACKGROUNDS - list.length);
  const accepted = uploaded.slice(0, room);
  for (const f of accepted) list.push(files.saveBuffer(f.buffer, 'public', 'branding', f.originalname));
  saveBackgrounds(list);
  audit(req, 'upload', 'backgrounds', null, { added: accepted.length });
  res.json({
    ok: true,
    backgrounds: list,
    added: accepted.length,
    skipped: uploaded.length - accepted.length,
    rejected
  });
});

router.delete('/settings/backgrounds', (req, res) => {
  currentBackgrounds().forEach((p) => files.removeFile(p));
  saveBackgrounds([]);
  audit(req, 'delete', 'backgrounds', null);
  res.json({ ok: true, backgrounds: [] });
});

router.delete('/settings/backgrounds/:index', (req, res) => {
  const list = currentBackgrounds();
  const i = Number(req.params.index);
  if (!Number.isInteger(i) || i < 0 || i >= list.length) return res.status(404).json({ error: 'not_found' });
  const [removed] = list.splice(i, 1);
  files.removeFile(removed);
  saveBackgrounds(list);
  audit(req, 'delete', 'background', null, { index: i });
  res.json({ ok: true, backgrounds: list });
});

/** Every notification attempt, so it is clear what was sent and to whom. */
router.get('/notifications', (req, res) => {
  res.json(all(`SELECT n.*, p.full_name AS visitor_name
                FROM notifications n
                LEFT JOIN visits v ON v.id = n.visit_id
                LEFT JOIN visitors p ON p.id = v.visitor_id
                ORDER BY n.id DESC LIMIT 50`));
});

/**
 * The card as it would arrive, built by the very same code that sends one.
 *
 * The dashboard posts the settings currently on screen — saved or not — so the
 * preview follows an edit as it is made, and there is no second copy of the
 * layout rules in the browser to drift out of step with these.
 */
router.get('/notify/preview', (req, res) => {
  const event = cards.EVENT_BY_ID[req.query.event] ? req.query.event : 'signin';
  res.json(buildPreview(event, req.query.card ? safeJson(req.query.card, null) : null,
    clean(req.query.visit_type) || null));
});

router.post('/notify/preview', (req, res) => {
  const body = req.body || {};
  const event = cards.EVENT_BY_ID[body.event] ? body.event : 'signin';
  res.json(buildPreview(event, body.card || null, clean(body.visit_type) || null));
});

function safeJson(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}

/**
 * A real visit if there is one, so the preview shows real wording and a real
 * face; an invented one on a site that has not opened yet.
 */
function sampleVisit() {
  /*
   * A visit that can show every part of the card wins: one whose host has an
   * email demonstrates the tag, and one with a photo demonstrates the picture.
   * Otherwise the preview would quietly leave out the very thing being turned
   * on, and look like the setting had no effect.
   */
  const real = get(`SELECT v.id FROM visits v
                    LEFT JOIN hosts h ON h.id = v.host_id
                    WHERE v.photo_path IS NOT NULL AND h.email IS NOT NULL AND h.email != ''
                    ORDER BY v.signed_in_at DESC LIMIT 1`)
    || get(`SELECT v.id FROM visits v JOIN hosts h ON h.id = v.host_id
            WHERE h.email IS NOT NULL AND h.email != '' ORDER BY v.signed_in_at DESC LIMIT 1`)
    || get('SELECT id FROM visits WHERE photo_path IS NOT NULL ORDER BY signed_in_at DESC LIMIT 1')
    || get('SELECT id FROM visits ORDER BY signed_in_at DESC LIMIT 1');
  if (real) return { visit: notify.visitDetail(real.id), real: true };
  return {
    real: false,
    visit: {
      id: 0, full_name: 'John Doe', company: 'Example Contracting', phone: '(415) 268-0142',
      email: 'visitor@example.com', visit_type: 'contractor', purpose: 'Foundation pour',
      vehicle_reg: 'TX 8842B', badge_no: 'V260829-014', host_name: 'John Doe',
      host_email: 'host@example.com',
      site_name: 'Main site', project_name: 'Lakeview Phase 2', location_name: 'North gate',
      device_name: 'Front gate iPad', signed_in_at: new Date().toISOString(), signed_out_at: null,
      id_name: 'IVAN R RUIZ', id_number: 'D1234567', id_state: 'TX', photo_path: null
    }
  };
}

/**
 * A parcel to show in the delivery designer.
 *
 * The real one if reception has booked any in, since a preview of the wording
 * with somebody's actual courier on it is worth more than an invented one.
 */
function sampleDelivery() {
  const real = get(`SELECT d.*, h.name AS host_name, h.email AS host_email
                    FROM deliveries d LEFT JOIN hosts h ON h.id = d.recipient_host_id
                    ORDER BY d.received_at DESC LIMIT 1`);
  if (real) return { delivery: real, real: true };
  return {
    real: false,
    delivery: {
      id: 0, courier_name: 'John Doe', courier_company: 'UPS', parcel_count: 3,
      tracking: '1Z999AA10123456784', notes: 'Two boxes and a tube',
      host_name: 'John Doe', host_email: 'host@example.com',
      recipient_text: 'John Doe', site_name: 'Main site',
      received_at: new Date().toISOString()
    }
  };
}

/**
 * What one event's card looks like right now.
 *
 * `card` overrides what is saved, so the designer can show a change before it
 * has been written — which, with auto-save, is a matter of a second, but the
 * preview should never lag behind the controls.
 */
function buildPreview(eventId, card, visitType) {
  const n = settings.getSection('notify');
  const event = cards.EVENT_BY_ID[eventId] || cards.EVENT_BY_ID.signin;
  // A card passed in is a whole design in its own right, not a patch. It is
  // put where the type being previewed will look for it, so previewing a
  // contractor's own design shows that design rather than the shared one.
  const notifyForPreview = card
    ? {
      ...n,
      cards: {
        ...(n.cards || {}),
        [event.id]: visitType && event.subject === 'visit'
          ? { ...(n.cards || {})[event.id], by_type: { ...(((n.cards || {})[event.id] || {}).by_type), [visitType]: card } }
          : card
      }
    }
    : n;

  const { row, real, photoUrl, fallbackTitle } = event.subject === 'delivery'
    ? (() => {
        const s = sampleDelivery();
        return { row: s.delivery, real: s.real, photoUrl: null,
          fallbackTitle: `Delivery waiting for ${s.delivery.host_name || s.delivery.recipient_text}` };
      })()
    : (() => {
        const s = sampleVisit();
        return { row: s.visit, real: s.real, photoUrl: notify.cardPhotoUrl(s.visit),
          fallbackTitle: `${s.visit.full_name} has arrived` };
      })();

  const model = cards.buildModel(event.id, row, notifyForPreview, {
    org: settings.getSection('org'),
    fmtTime: notify.fmtTime,
    baseUrl: notify.baseUrl(),
    boardUrl: notify.boardUrl(),
    photoUrl,
    // Whoever this visitor type is routed to, so the preview shows the extra
    // tag line rather than hiding it until the first real arrival.
    also: event.subject === 'visit' ? notify.routedStaff(visitType || row.visit_type) : [],
    // The type being designed for, which may not be the sample visit's own.
    visitType: event.subject === 'visit' ? (visitType || row.visit_type) : null,
    now: new Date().toISOString(),
    fallbackTitle
  });

  return {
    event: event.id,
    model,
    teams: cards.teamsCard(model),
    sample: !real,
    visit_type: visitType || null,
    card: cards.cardFor(event.id, notifyForPreview, visitType),
    /*
     * Whether the example this preview is built from has a face at all.
     * Without it, "the photo is not showing" has three different causes that
     * look identical, and the panel can only guess which one you hit.
     */
    subject_has_photo: !!photoUrl,
    fields: event.fields.map(({ id, label, sensitive }) => ({ id, label, sensitive: !!sensitive })),
    // A photo cannot reach Teams from an address only this machine can resolve.
    public_url: notify.baseUrl(),
    public_url_reachable: /^https?:\/\/(?!localhost|127\.|0\.0\.0\.0)/i.test(notify.baseUrl())
  };
}

/** Everything the designers need to draw themselves — events, fields, links. */
router.get('/notify/catalogue', (req, res) => {
  const n = settings.getSection('notify');
  res.json({
    ...cards.catalogue(),
    // What is in force per event, defaults and the older shared design folded in.
    cards: Object.fromEntries(cards.EVENTS.map((e) => [e.id, cards.cardFor(e.id, n)])),
    /*
     * And the visitor types that have a card of their own, per event, so the
     * designer can mark them without guessing from a merged object which
     * values came from an override.
     */
    per_type: Object.fromEntries(cards.EVENTS.map((e) => [e.id, Object.fromEntries(
      cards.typesWithOwnCard(e.id, n).map((type) => [type, cards.cardFor(e.id, n, type)]))])),
    visitor_types: (settings.getAll().types || [])
      .filter((t) => t.key).map((t) => ({ key: t.key, label: t.label || t.key, icon: t.icon || '👤' })),
    board_url: notify.boardUrl()
  });
});

router.post('/settings/test-webhook', async (req, res) => {
  if (!clean(req.body.url)) return res.json({ ok: false, detail: 'Enter a webhook URL first.' });
  /*
   * The test sends the designed card, not a plain line, so what comes back is
   * proof the layout and the photo link both survive the trip.
   *
   * With one deliberate exception: it never tags anybody. The sample is built
   * from a real recent visit, so a test would otherwise @-mention a real
   * colleague in a real channel — someone who had nothing to do with the
   * button being pressed, and who may not even be in that team. A real
   * arrival tags the host; a test is not an arrival.
   */
  const body = req.body || {};
  const event = cards.EVENT_BY_ID[body.event] ? body.event : 'signin';
  const preview = buildPreview(event, body.card || null, clean(body.visit_type) || null);
  const model = { ...preview.model, title: `${preview.model.title} — test`, mention: null, mentionTemplate: null };
  const result = await notify.sendWebhook({ url: req.body.url, model });
  res.json({
    ...result,
    photo_included: !!model.photoUrl,
    tagged_nobody: true,
    public_url_reachable: preview.public_url_reachable
  });
});

/*
 * Clear the examples out. Offered once a site has visits of its own, so
 * nobody has to work out which of the Does were real.
 */
router.get('/examples', (req, res) => {
  const examples = require('../examples');
  res.json({ present: examples.present(), only: examples.onlyExamples() });
});

router.delete('/examples', (req, res) => {
  const gone = require('../examples').clear();
  audit(req, 'delete', 'visitors', null, { examples: gone });
  res.json({ ok: true, removed: gone });
});

/* ------------------------------------------------------------ companies */

const companies = require('../companies');

router.get('/companies', (req, res) => res.json({
  companies: companies.list(),
  // Names close enough to be worth a look, offered rather than acted on.
  possible_duplicates: companies.duplicates()
}));

router.get('/companies/:id', (req, res) => {
  const c = companies.detail(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'not_found' });
  res.json(c);
});

router.post('/companies', (req, res) => {
  const name = clean(req.body && req.body.name);
  if (!name) return res.status(400).json({ error: 'name_required', message: 'A company needs a name.' });
  const c = companies.resolve(name);
  audit(req, 'create', 'companies', c.id, { name });
  res.json(c);
});

router.patch('/companies/:id', (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  try {
    if (b.name !== undefined) companies.rename(id, b.name);
  } catch (err) {
    return res.status(400).json({ error: 'rename_failed', message: err.message });
  }
  if (b.notes !== undefined) run('UPDATE companies SET notes = ? WHERE id = ?', clean(b.notes) || null, id);
  if (b.blocked !== undefined) run('UPDATE companies SET blocked = ? WHERE id = ?', b.blocked ? 1 : 0, id);
  /*
   * The job this firm is usually on. Filled into the kiosk's project dropdown
   * for anybody from this company, and overridable there — see server/projects.js.
   */
  if (b.default_project_id !== undefined) {
    run('UPDATE companies SET default_project_id = ? WHERE id = ?',
      b.default_project_id ? Number(b.default_project_id) : null, id);
  }
  audit(req, 'update', 'companies', id, b);
  res.json(companies.detail(id));
});

/** Fold one company into another — the misspelling into the correct one. */
router.post('/companies/:id/merge', (req, res) => {
  try {
    const result = companies.merge(Number(req.params.id), Number(req.body && req.body.into));
    audit(req, 'merge', 'companies', Number(req.params.id),
      { from: result.from, into: result.into.name, people: result.moved });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: 'merge_failed', message: err.message });
  }
});

/*
 * Removing a company does not remove anybody: their history is theirs. They
 * simply stop being attached to a firm, and the next sign-in makes a fresh
 * record from whatever they type.
 */
router.delete('/companies/:id', (req, res) => {
  const id = Number(req.params.id);
  run('UPDATE visitors SET company_id = NULL WHERE company_id = ?', id);
  run('DELETE FROM companies WHERE id = ?', id);
  audit(req, 'delete', 'companies', id);
  res.json({ ok: true });
});

/* ---------------------------------------------------------- certificates */

const compliance = require('../compliance');

/** What the dashboard needs to draw the panel: the kinds, and what is lapsing. */
router.get('/certificates', (req, res) => res.json({
  kinds: compliance.kinds(),
  expiring: compliance.expiring(req.query.days),
  health: compliance.health()
}));

router.get('/certificates/for', (req, res) => {
  const companyId = req.query.company_id ? Number(req.query.company_id) : null;
  const visitorId = req.query.visitor_id ? Number(req.query.visitor_id) : null;
  if (!companyId && !visitorId) return res.status(400).json({ error: 'who' });
  res.json(compliance.listFor({ companyId, visitorId }));
});

router.post('/certificates', (req, res) => {
  try {
    const made = compliance.create(req.body || {});
    audit(req, 'create', 'certificates', made.id, { kind: made.kind, expires_on: made.expires_on });
    res.json(made);
  } catch (err) {
    res.status(400).json({ error: 'bad_certificate', message: err.message });
  }
});

router.patch('/certificates/:id', (req, res) => {
  const updated = compliance.update(Number(req.params.id), req.body || {});
  audit(req, 'update', 'certificates', Number(req.params.id), req.body);
  res.json(updated);
});

router.delete('/certificates/:id', (req, res) => {
  compliance.remove(Number(req.params.id));
  audit(req, 'delete', 'certificates', Number(req.params.id));
  res.json({ ok: true });
});

/*
 * Whether one person would get through the gate right now.
 *
 * Reception asks this before somebody drives across town, and the answer is
 * the same one the kiosk uses rather than a second opinion.
 */
router.get('/certificates/check', (req, res) => {
  res.json(compliance.check(String(req.query.visit_type || 'contractor'), {
    visitorId: req.query.visitor_id ? Number(req.query.visitor_id) : null,
    companyId: req.query.company_id ? Number(req.query.company_id) : null
  }));
});

/* -------------------------------------------------------------- backups */

const backup = require('../backup');

router.get('/backups', (req, res) =>
  res.json({
    keep: backup.KEEP,
    backups: backup.list(),
    /*
     * With the off-site state folded in. The Backups panel has always drawn a
     * notice from health.offsite and this call never sent one, so whether the
     * copy to OneDrive was getting there could only be seen on the dashboard.
     */
    health: { ...backup.health(), offsite: require('../offsite').health() },
    // What is using the room, so a full volume is a breakdown rather than a
    // mystery: photos are almost always the answer.
    storage: (() => {
      const s = settings.getSection('storage');
      return {
        ...require('../storage').usage(),
        // So the panel can say what the valve is set to and when it last ran,
        // rather than the reader having to infer it from the photo count.
        shedding: s.shed_enabled !== false,
        shed_at_percent: Number(s.shed_at_percent) || 90,
        shed_last_at: s.shed_last_at || '',
        shed_last_freed: Number(s.shed_last_freed) || 0,
        shed_last_photos: Number(s.shed_last_photos) || 0
      };
    })()
  }));

router.post('/backups', async (req, res) => {
  const offsite = require('../offsite');
  try {
    const made = backup.create({
      includeMedia: settings.getSection('backup').offsite_include_media !== false
        || !(req.body && req.body.for_offsite)
    });
    audit(req, 'backup', 'database', null, { file: made.file, bytes: made.bytes, media: made.media_files });
    // Awaited here, unlike the nightly run, so the button can say what happened.
    const copied = offsite.enabled() ? await offsite.copyOff(made) : null;
    res.json({ ok: true, ...made, offsite: copied });
  } catch (err) {
    res.status(500).json({ ok: false, message: `Could not write a backup: ${err.message}` });
  }
});

/*
 * Free up room now, rather than waiting for the hourly check.
 *
 * `force` is what the button sends: somebody looking at a nearly-full disk who
 * wants the room back this minute, without first editing the threshold down
 * and then putting it back. The floor still holds — the last fortnight of
 * faces is never in reach, whoever is asking.
 */
router.post('/storage/shed', (req, res) => {
  const storage = require('../storage');
  const by = { userId: req.user ? req.user.id : null };
  const result = storage.shed(req.body && req.body.force
    ? { ...by, shed_enabled: true, shed_at_percent: 0 } : by);
  res.json({ ok: true, ...result, storage: storage.usage() });
});

/* ----------------------------------------------- copying it off the machine */

router.post('/backups/offsite/test', async (req, res) => {
  const offsite = require('../offsite');
  // Test what is on screen, not whatever was saved last.
  if (req.body && req.body.url !== undefined) {
    settings.setSection('backup', { offsite_url: clean(req.body.url), offsite_secret: clean(req.body.secret) || '' });
  }
  const result = await offsite.test();
  audit(req, 'offsite_test', 'backup', null, { ok: result.ok });
  res.json(result);
});

/** Send a backup that is already on disk — for one that failed to go the first time. */
router.post('/backups/:file/offsite', async (req, res) => {
  const offsite = require('../offsite');
  const full = backup.pathOf(req.params.file);
  if (!full) return res.status(404).json({ ok: false, error: 'not_found' });
  const result = await offsite.send(full, req.params.file);
  audit(req, 'offsite_send', 'backup', null, { file: req.params.file, ok: result.ok });
  res.json(result);
});

/*
 * "Test this backup" — the drill, without the disaster.
 *
 * A backup nobody has ever opened is a promise. This opens one, reads the
 * database inside it, and says whether it would actually put the site back —
 * schema and all the files the records point at included — while changing
 * nothing. It sits above the download route because that one matches any
 * :file, this one included.
 */
router.post('/backups/:file/drill', (req, res) => {
  const result = backup.drill(req.params.file);
  audit(req, 'backup_drill', 'database', null,
    { file: req.params.file, ok: result.ok, warnings: (result.warnings || []).length });
  res.status(result.ok ? 200 : 400).json(result);
});

/*
 * The whole thing, as one file. This is the copy that survives losing the
 * machine, so it is deliberately easy to take — and deliberately behind a
 * login, because it is every visitor record and every photo in one download.
 */
router.get('/backups/:file', (req, res) => {
  const full = backup.pathOf(req.params.file);
  if (!full) return res.status(404).json({ error: 'not_found' });
  audit(req, 'backup_download', 'database', null, { file: req.params.file });
  res.download(full);
});

router.delete('/backups/:file', (req, res) => {
  const full = backup.pathOf(req.params.file);
  if (!full) return res.status(404).json({ error: 'not_found' });
  require('fs').unlinkSync(full);
  audit(req, 'backup_delete', 'database', null, { file: req.params.file });
  res.json({ ok: true });
});

/* --------------------------------------------------------------- restore */

/**
 * Putting a backup back.
 *
 * Nothing is swapped while the server is running: the archive is checked, the
 * current data is backed up in case this was the mistake, and the restore is
 * staged for the next start. Only an owner can, because it replaces
 * everything — including which accounts exist, which is to say including who
 * can undo it.
 */
router.post('/restore', files.memoryUpload.single('file'), (req, res) => {
  if (req.user.role !== 'owner') {
    return res.status(403).json({ ok: false, message: 'Only the owner can restore a backup.' });
  }
  if (!req.file || !req.file.buffer || !req.file.buffer.length) {
    return res.status(400).json({ ok: false, message: 'Choose a backup file first.' });
  }
  const result = backup.stageRestore(req.file.buffer);
  if (!result.ok) return res.status(400).json({ ok: false, message: result.error });
  audit(req, 'restore_staged', 'database', null,
    { from: req.file.originalname, counts: result.counts, safety_backup: result.safety_backup });
  res.json({
    ok: true,
    ...result,
    message: `Ready to restore ${result.counts.visits} visit(s) and ${result.media_files} file(s). `
      + 'It is applied the next time the server starts — restart it to finish.'
  });
});

/** Read an archive and report on it, changing nothing. */
router.post('/restore/check', files.memoryUpload.single('file'), (req, res) => {
  if (!req.file || !req.file.buffer) return res.status(400).json({ ok: false, error: 'Choose a file first.' });
  res.json(backup.inspect(req.file.buffer));
});

router.delete('/restore', (req, res) => {
  const had = !!backup.pendingRestore();
  backup.cancelRestore();
  if (had) audit(req, 'restore_cancelled', 'database', null);
  res.json({ ok: true, cancelled: had });
});

/* ----------------------------------------------------------- wall board */

const boardRoutes = require('./board');

/**
 * What a badge number would look like, without issuing one.
 *
 * Rendered by the same code that numbers a real badge, so the example on the
 * settings page cannot drift from what comes out of the printer.
 */
function badgeNumberPreview(over, res) {
  const cfg = { ...settings.getSection('badge') };
  if (over.format !== undefined) cfg.badge_format = String(over.format);
  if (over.digits !== undefined) cfg.badge_seq_digits = Number(over.digits);
  if (over.prefix !== undefined) cfg.badge_prefix = String(over.prefix);
  // Whole object, not merged: clearing a per-type prefix has to clear it.
  if (over.prefixes !== undefined && over.prefixes && typeof over.prefixes === 'object') {
    cfg.badge_prefixes = over.prefixes;
  }

  const day = localtime.today();
  const all = (settings.getAll().types || []).filter((t) => t.key);
  const types = all.map((t) => t.key);
  const labelFor = (key) => (all.find((t) => t.key === key) || {}).label || key;
  res.json({
    tokens: badges.TOKENS,
    digits: { min: badges.MIN_DIGITS, max: badges.MAX_DIGITS },
    // The first three of the day, so a counter that is too narrow is obvious.
    examples: (types.length ? types : ['visitor']).slice(0, 6).map((type) => ({
      type,
      label: labelFor(type),
      prefix: badges.prefixFor(type, cfg),
      numbers: [1, 2, 3].map((n) => badges.sampleBadgeNo(day, type, cfg, n))
    })),
    /*
     * Two types sharing a prefix share one run of numbers; giving each its own
     * needs {type} in the format. Neither is wrong, but which one you have
     * should not be a surprise at the printer.
     */
    separate_series: new Set((types.length ? types : ['visitor'])
      .map((type) => badges.renderFormat(day, type, cfg).prefix)).size > 1
  });
}

router.get('/badges/number-preview', (req, res) => badgeNumberPreview(req.query, res));
// POST as well, because a prefix per visitor type is an object rather than
// something that reads well in a query string.
router.post('/badges/number-preview', (req, res) => badgeNumberPreview(req.body || {}, res));

router.get('/board', (req, res) => {
  const b = settings.getSection('board');
  res.json({ ...b, url: b.enabled && b.key ? `${notify.baseUrl()}/board/${b.key}` : null });
});

/*
 * Just the address, for the link in the side menu.
 *
 * Everyone signed in can read this, not only administrators: reception and
 * whoever books deliveries in are exactly the people who want the board open
 * on a second screen. It carries nothing but whether the board is on and
 * where it is — the camera settings and the ability to reissue the key stay
 * on /board, which stays administrative.
 */
router.get('/board/link', (req, res) => {
  const b = settings.getSection('board');
  res.json({
    enabled: !!b.enabled,
    url: b.enabled && b.key ? `${notify.baseUrl()}/board/${b.key}` : null
  });
});

/**
 * Switching the board on mints a key; switching it off clears it, which is what
 * makes the old link stop working rather than merely stop being advertised.
 * "New link" does both at once for a link that has been shared too widely.
 */
router.post('/board/key', (req, res) => {
  const enabled = req.body && req.body.enabled !== false;
  const key = enabled ? boardRoutes.newKey() : '';
  settings.setSection('board', { ...settings.getSection('board'), enabled, key });
  audit(req, enabled ? 'board_key_issued' : 'board_disabled', 'board', null);
  const b = settings.getSection('board');
  res.json({ ...b, url: b.enabled && b.key ? `${notify.baseUrl()}/board/${b.key}` : null });
});

/**
 * Whether the camera address actually gives back a picture.
 *
 * Answers from where the server is standing, which is exactly the question
 * "Fetch through the server" turns on — and it also catches the far more
 * common mistake of an http address, which the browser will refuse whatever
 * this says.
 */
router.post('/board/camera-test', async (req, res) => {
  const url = clean((req.body || {}).url) || settings.getSection('board').camera_url;
  if (!url) return res.json({ ok: false, message: 'Enter a camera address first.' });

  let parsed;
  try { parsed = new URL(url); } catch { return res.json({ ok: false, message: 'That is not a valid web address.' }); }
  if (parsed.protocol === 'rtsp:') {
    return res.json({ ok: false, message: 'RTSP cannot be shown by a browser. Use the camera’s snapshot or MJPEG address, '
      + 'or put something in front of it that speaks HLS.' });
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return res.json({ ok: false, message: `${parsed.protocol.replace(':', '')} addresses cannot be shown on a web page.` });
  }

  const insecure = parsed.protocol === 'http:';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(url, { redirect: 'error', signal: controller.signal });
    clearTimeout(timer);
    const type = r.headers.get('content-type') || '';
    if (!r.ok) return res.json({ ok: false, insecure, message: `The camera answered ${r.status}.` });
    if (!/^(image|multipart|video|application\/(vnd\.apple\.mpegurl|x-mpegurl))/i.test(type)) {
      return res.json({ ok: false, insecure,
        message: `That address returned ${type || 'no content type'} rather than a picture. `
          + 'If it is the camera’s own web page, choose the frame option instead.' });
    }
    res.json({ ok: true, insecure, content_type: type,
      message: insecure
        ? `The server can reach it (${type}). It is an http address, so tick "Fetch through the server" — `
          + 'the browser will refuse to load it directly onto the https board.'
        : `The server can reach it (${type}).` });
  } catch (err) {
    clearTimeout(timer);
    res.json({ ok: false, insecure,
      message: `This server could not reach it: ${String(err.message || err).slice(0, 120)}. `
        + 'If the camera is on your local network that is expected — a server in the cloud cannot see it. '
        + 'Untick "Fetch through the server" and give the camera an address reachable from the browser instead.' });
  }
});

/* ----------------------------------------------------------------- users */

router.get('/users', (req, res) => res.json(all(
  `SELECT u.id, u.email, u.name, u.role, u.active, u.created_at, u.host_id, u.must_change_password,
          h.name AS staff_name
   FROM users u LEFT JOIN hosts h ON h.id = u.host_id ORDER BY u.id`)));

/** The access levels themselves, so the dashboard need not hard-code them. */
router.get('/roles', (req, res) => res.json(roles.describe()));

router.post('/users', (req, res) => {
  const { email, password, name, role, host_id, must_change } = req.body || {};
  if (!email || !password || String(password).length < 8) return res.status(400).json({ error: 'weak_credentials' });
  if (role && !roles.ROLES[role]) return res.status(400).json({ error: 'unknown_role' });
  // Only an owner hands out administrator, or an administrator could quietly
  // promote themselves past whoever set them up.
  if (roles.isAdmin(role || 'admin') && req.user.role !== 'owner') {
    return res.status(403).json({ error: 'owner_only', message: 'Only the owner can create an administrator.' });
  }
  try {
    const created = auth.createUser({
      email, password, name, role: role || 'reception',
      hostId: host_id || null,
      // The person setting it up should not go on knowing the password.
      mustChange: must_change !== false
    });
    audit(req, 'create', 'user', created.id, { email: created.email, role: created.role });
    res.json(created);
  } catch (err) {
    res.status(400).json({ error: 'user_exists', message: 'There is already a login with that email address.' });
  }
});

/** Change somebody's access level, or which staff member their login belongs to. */
router.patch('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  const target = get('SELECT id, role, email FROM users WHERE id = ?', id);
  if (!target) return res.status(404).json({ error: 'not_found' });
  if (target.role === 'owner') {
    return res.status(400).json({ error: 'owner_fixed', message: 'The owner\'s access level cannot be changed.' });
  }
  if (id === req.user.id) {
    return res.status(400).json({ error: 'not_your_own', message: 'You cannot change your own access level.' });
  }
  const b = req.body || {};
  if (b.role !== undefined) {
    if (!roles.ROLES[b.role] || b.role === 'owner') return res.status(400).json({ error: 'unknown_role' });
    if (roles.isAdmin(b.role) && req.user.role !== 'owner') {
      return res.status(403).json({ error: 'owner_only', message: 'Only the owner can grant administrator.' });
    }
    run('UPDATE users SET role = ? WHERE id = ?', b.role, id);
  }
  if (b.host_id !== undefined) run('UPDATE users SET host_id = ? WHERE id = ?', b.host_id || null, id);
  if (b.active !== undefined) run('UPDATE users SET active = ? WHERE id = ?', b.active ? 1 : 0, id);
  audit(req, 'update', 'user', id, b);
  res.json(get('SELECT id, email, name, role, active, host_id, must_change_password FROM users WHERE id = ?', id));
});

router.delete('/users/:id', (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'cannot_delete_self' });
  run('DELETE FROM users WHERE id = ?', req.params.id);
  audit(req, 'delete', 'user', Number(req.params.id));
  res.json({ ok: true });
});

/*
 * Changing your own password. The current one is asked for even though the
 * session already proves who you are: it is what stops a walk-up at an
 * unlocked dashboard from locking the owner out of their own system.
 *
 * Rate limited on the same grounds as the login form — this is a password
 * oracle otherwise, and a quieter one, because a wrong guess here does not
 * show up as a failed sign-in.
 */
const passwordLimit = ratelimit.limit({
  windowMs: 15 * 60_000, max: 10, name: 'password-change',
  message: 'Too many attempts. Wait a few minutes and try again.'
});

router.post('/me/password', passwordLimit, (req, res) => {
  const { current, password } = req.body || {};
  if (!auth.verifyPassword(req.user.id, current)) {
    return res.status(400).json({ error: 'wrong_password', message: 'That is not your current password.' });
  }
  if (!password || String(password).length < 8) {
    return res.status(400).json({ error: 'weak_password', message: 'Use at least 8 characters.' });
  }
  auth.setPassword(req.user.id, password, auth.parseCookies(req)[auth.COOKIE], { mustChange: false });
  audit(req, 'password_change', 'user', req.user.id);
  res.json({ ok: true, message: 'Password changed. Any other browser signed in as you has been signed out.' });
});

/**
 * Setting somebody else's password — for the person who has forgotten theirs
 * and is standing in front of you. Only an owner can, and never on themselves:
 * that path asks for the current password above.
 */
router.post('/users/:id/password', (req, res) => {
  if (!roles.isAdmin(req.user.role)) {
    return res.status(403).json({ error: 'not_allowed', message: 'Only an administrator can reset a password.' });
  }
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'use_own_form', message: 'Change your own password under Your account.' });
  const target = get('SELECT id, email FROM users WHERE id = ?', id);
  if (!target) return res.status(404).json({ error: 'not_found' });
  const password = (req.body || {}).password;
  if (!password || String(password).length < 8) {
    return res.status(400).json({ error: 'weak_password', message: 'Use at least 8 characters.' });
  }
  // Temporary unless explicitly set otherwise: whoever typed it should not go
  // on being able to sign in as that person.
  const temporary = (req.body || {}).must_change !== false;
  auth.setPassword(id, password, null, { mustChange: temporary });
  audit(req, 'password_reset', 'user', id, { email: target.email, temporary });
  res.json({
    ok: true,
    temporary,
    message: `${target.email} can now sign in with that password. They were signed out everywhere`
      + (temporary ? ', and will have to pick their own before they can do anything.' : '.')
  });
});

/* ----------------------------------------------------------------- stats */

/**
 * The figures behind the Reports page.
 *
 * Every other page has a date range and this one did not: it was fixed at
 * thirty days for the chart and all-time for everything else, which cannot
 * answer "last quarter, Lakeview only" — the question somebody actually takes
 * to a client meeting.
 *
 * One window applies to the lot now, so the tiles, the chart and the tables
 * all describe the same span rather than three different ones.
 */
/*
 * The figures behind the Reports page.
 *
 * Split out from the route because the printable version has to be the same
 * numbers as the screen — computing them twice in two places is how a report
 * ends up disagreeing with the page it was printed from.
 */
function statsFor(query) {
  const q = query || {};
  const days = Math.min(731, Math.max(1, Number(q.days) || 30));
  // An explicit from/to wins; otherwise the last N days ending today.
  const to = clean(q.to) || localtime.today();
  const from = clean(q.from)
    || new Date(Date.parse(`${to}T12:00:00Z`) - (days - 1) * 864e5).toISOString().slice(0, 10);

  const where = ['v.signed_in_at >= ?', 'v.signed_in_at <= ?'];
  const params = [`${from}T00:00:00.000Z`, `${to}T23:59:59.999Z`];
  if (clean(q.project_id)) { where.push('v.project_id = ?'); params.push(Number(q.project_id)); }
  if (clean(q.visit_type)) { where.push('v.visit_type = ?'); params.push(String(q.visit_type)); }
  const scope = `WHERE ${where.join(' AND ')}`;
  const span = Math.max(1,
    Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 864e5) + 1);

  const rows = (sql) => all(sql, ...params);

  /*
   * Hours on site, per project. The site already records the project and both
   * timestamps, so this was sitting in the data unasked for — and it is the
   * number a contractor operation bills and audits against.
   */
  const byProject = rows(`
    SELECT j.name,
           COUNT(*) AS n,
           SUM(CASE WHEN v.signed_out_at IS NOT NULL
                    THEN (julianday(v.signed_out_at) - julianday(v.signed_in_at)) * 24 ELSE 0 END) AS hours,
           SUM(CASE WHEN v.signed_out_at IS NULL THEN 1 ELSE 0 END) AS still_on_site
      FROM visits v JOIN projects j ON j.id = v.project_id
     ${scope} GROUP BY j.id ORDER BY hours DESC`)
    .map((r) => ({ ...r, hours: Math.round((r.hours || 0) * 10) / 10 }));

  return {
    from,
    to,
    days: span,
    project_id: clean(q.project_id) ? Number(q.project_id) : null,
    visit_type: clean(q.visit_type) || null,
    total: rows(`SELECT COUNT(*) AS n FROM visits v ${scope}`)[0].n,
    // Capped, so a two-year window does not try to draw 731 bars.
    by_day: byLocalDay(rows(`SELECT v.signed_in_at FROM visits v ${scope}`).map((r) => r.signed_in_at),
      Math.min(span, 92), to),
    by_type: rows(`SELECT v.visit_type, COUNT(*) AS n FROM visits v ${scope} GROUP BY v.visit_type ORDER BY n DESC`),
    by_host: rows(`SELECT h.name, COUNT(*) AS n FROM visits v JOIN hosts h ON h.id = v.host_id
                   ${scope} GROUP BY h.id ORDER BY n DESC LIMIT 10`),
    // Grouped on the company record where there is one, so three spellings of
    // a firm are one row rather than three.
    by_company: rows(`SELECT COALESCE(c.name, p.company) AS name, COUNT(*) AS n
                        FROM visits v JOIN visitors p ON p.id = v.visitor_id
                        LEFT JOIN companies c ON c.id = p.company_id
                       ${scope} AND COALESCE(c.name, p.company) IS NOT NULL
                         AND COALESCE(c.name, p.company) != ''
                       GROUP BY COALESCE(CAST(c.id AS TEXT), lower(p.company)) ORDER BY n DESC LIMIT 10`),
    by_hour: byLocalHour(rows(`SELECT v.signed_in_at FROM visits v ${scope}`).map((r) => r.signed_in_at)),
    by_project: byProject,
    total_hours: Math.round(byProject.reduce((sum, r) => sum + r.hours, 0) * 10) / 10,
    avg_minutes: rows(`SELECT AVG((julianday(v.signed_out_at) - julianday(v.signed_in_at)) * 1440) AS m
                       FROM visits v ${scope} AND v.signed_out_at IS NOT NULL`)[0].m,
    projects: all('SELECT id, name FROM projects ORDER BY name'),
    types: all('SELECT DISTINCT visit_type FROM visits WHERE visit_type IS NOT NULL ORDER BY visit_type')
      .map((r) => r.visit_type)
  };
}

router.get('/stats', (req, res) => res.json(statsFor(req.query)));

/*
 * The same report, on paper.
 *
 * Hours per project is the number a contractor operation bills and audits
 * against, and "here is a screenshot of a dashboard" is not what anybody wants
 * to put in front of a client or an auditor. This is a plain page with the
 * site's own letterhead that prints — and so saves as a PDF — from any
 * browser, with no export step and nothing to reformat.
 */
router.get('/stats/print', (req, res) => {
  const stats = statsFor(req.query);
  const page = require('../report-print').render(stats, {
    org: settings.getSection('org'),
    project: stats.project_id
      ? (get('SELECT name FROM projects WHERE id = ?', stats.project_id) || {}).name : null,
    by: req.user ? (req.user.name || req.user.email) : null,
    now: nowISO()
  });
  audit(req, 'report_print', 'report', null, { from: stats.from, to: stats.to, project_id: stats.project_id });
  res.type('html').send(page);
});

module.exports = router;
