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

const router = express.Router();
const clean = (v) => (typeof v === 'string' ? v.trim() : v);

function audit(req, action, entity, entityId, detail) {
  run('INSERT INTO audit_log (user_id, action, entity, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)',
    req.user ? req.user.id : null, action, entity || null, entityId || null,
    detail ? JSON.stringify(detail) : null, nowISO());
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

router.post('/setup', (req, res) => {
  if (auth.anyUsers()) return res.status(400).json({ error: 'already_setup' });
  const { email, password, name, org_name } = req.body || {};
  if (!email || !password || String(password).length < 8) return res.status(400).json({ error: 'weak_credentials' });
  const user = auth.createUser({ email, password, name, role: 'owner' });
  if (org_name) settings.setSection('org', { name: org_name });
  if (!get('SELECT id FROM sites LIMIT 1')) {
    run('INSERT INTO sites (name, active, created_at) VALUES (?,1,?)', org_name || 'Main site', nowISO());
  }
  auth.startSession(res, user);
  res.json({ ok: true, user });
});

router.post('/login', (req, res) => {
  const user = auth.verifyLogin(req.body.email, req.body.password);
  if (!user) return res.status(401).json({ error: 'invalid_credentials' });
  auth.startSession(res, user);
  res.json({ ok: true, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

router.post('/logout', (req, res) => { auth.endSession(req, res); res.json({ ok: true }); });

router.use(auth.requireAuth);

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

/* ------------------------------------------------------------- dashboard */

router.get('/dashboard', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const onsite = all(`SELECT v.id, v.signed_in_at, v.visit_type, v.badge_no, v.photo_path, v.vehicle_reg,
                             p.full_name, p.company, p.phone, h.name AS host_name, s.name AS site_name
                      FROM visits v JOIN visitors p ON p.id = v.visitor_id
                      LEFT JOIN hosts h ON h.id = v.host_id LEFT JOIN sites s ON s.id = v.site_id
                      WHERE v.status = 'onsite' ORDER BY v.signed_in_at DESC`);
  const stats = {
    onsite: onsite.length,
    today_in: get('SELECT COUNT(*) AS n FROM visits WHERE substr(signed_in_at,1,10) = ?', today).n,
    today_out: get("SELECT COUNT(*) AS n FROM visits WHERE substr(signed_out_at,1,10) = ?", today).n,
    deliveries_waiting: get("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'awaiting'").n,
    visitors_total: get('SELECT COUNT(*) AS n FROM visitors').n,
    inductions_today: get('SELECT COUNT(*) AS n FROM slide_views WHERE substr(completed_at,1,10) = ?', today).n
  };
  const week = all(`SELECT substr(signed_in_at,1,10) AS day, COUNT(*) AS n FROM visits
                    WHERE signed_in_at >= date('now','-13 days') GROUP BY day ORDER BY day`);
  const storage_warning = require('../db').STORAGE.message;
  const devices = all('SELECT id, name, last_seen_at FROM devices ORDER BY name');
  res.json({ onsite, stats, week, devices, storage_warning, recent_deliveries: all(
    `SELECT d.*, h.name AS host_name FROM deliveries d LEFT JOIN hosts h ON h.id = d.recipient_host_id
     ORDER BY d.received_at DESC LIMIT 10`) });
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

/* ---------------------------------------------------------------- visits */

router.get('/visits', (req, res) => {
  const { from, to, status, q, type } = req.query;
  const where = [];
  const params = [];
  if (from) { where.push('v.signed_in_at >= ?'); params.push(from); }
  if (to) { where.push('v.signed_in_at <= ?'); params.push(`${to}T23:59:59.999Z`); }
  if (status) { where.push('v.status = ?'); params.push(status); }
  if (type) { where.push('v.visit_type = ?'); params.push(type); }
  if (q) { where.push('(lower(p.full_name) LIKE ? OR lower(p.company) LIKE ? OR lower(h.name) LIKE ?)');
    params.push(`%${String(q).toLowerCase()}%`, `%${String(q).toLowerCase()}%`, `%${String(q).toLowerCase()}%`); }
  const sql = `SELECT v.*, p.full_name, p.company, p.phone, p.email, h.name AS host_name, s.name AS site_name
               FROM visits v JOIN visitors p ON p.id = v.visitor_id
               LEFT JOIN hosts h ON h.id = v.host_id LEFT JOIN sites s ON s.id = v.site_id
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY v.signed_in_at DESC LIMIT ?`;
  const rows = all(sql, ...params, Number(req.query.limit) || 500);
  if (req.query.format === 'csv') {
    const body = csv(rows, [
      { label: 'Name', key: 'full_name' }, { label: 'Company', key: 'company' }, { label: 'Phone', key: 'phone' },
      { label: 'Email', key: 'email' }, { label: 'Type', key: 'visit_type' }, { label: 'Purpose', key: 'purpose' },
      { label: 'Staff member', key: 'host_name' }, { label: 'Badge', key: 'badge_no' }, { label: 'Vehicle', key: 'vehicle_reg' },
      { label: 'Reference', key: 'reference' }, { label: 'Delivering/collecting', key: 'movement' },
      { label: 'Signed in', key: 'signed_in_at' }, { label: 'Signed out', key: 'signed_out_at' },
      { label: 'Status', key: 'status' }, { label: 'Site', key: 'site_name' }
    ]);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="visits-${Date.now()}.csv"`);
    return res.send(body);
  }
  res.json(rows);
});

router.get('/visits/:id', (req, res) => {
  const visit = get(`SELECT v.*, p.full_name, p.company, p.phone, p.email, p.photo_path AS profile_photo,
                            h.name AS host_name, s.name AS site_name, l.name AS location_name, d.name AS device_name
                     FROM visits v JOIN visitors p ON p.id = v.visitor_id
                     LEFT JOIN hosts h ON h.id = v.host_id LEFT JOIN sites s ON s.id = v.site_id
                     LEFT JOIN locations l ON l.id = v.location_id
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

router.delete('/visits/:id', (req, res) => {
  run('DELETE FROM visits WHERE id = ?', req.params.id);
  audit(req, 'delete', 'visit', Number(req.params.id));
  res.json({ ok: true });
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
  run('DELETE FROM visitors WHERE id = ?', req.params.id);
  audit(req, 'delete', 'visitor', Number(req.params.id));
  res.json({ ok: true });
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
crud('agreements', 'agreements', ['name', 'body', 'version', 'required_for', 'questions', 'require_signature', 'active']);
crud('access-points', 'access_points', ['site_id', 'name', 'kind', 'url', 'method', 'headers', 'body',
  'unlock_seconds', 'auto_unlock_on_signin', 'auto_unlock_on_signout', 'enabled']);

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
                   min_seconds_per_slide, active, created_at)
                 VALUES (?,?,?,?,?,?,?,?)`,
    clean(b.name) || 'Site induction', clean(b.description) || null,
    JSON.stringify(b.required_for || ['visitor', 'contractor']), Number(b.repeat_after_days) || null,
    b.allow_skip ? 1 : 0, Number(b.min_seconds_per_slide) || 0, b.active === false ? 0 : 1, nowISO());
  audit(req, 'create', 'slideshow', Number(r.lastInsertRowid), b);
  res.json(get('SELECT * FROM slideshows WHERE id = ?', r.lastInsertRowid));
});

router.patch('/slideshows/:id', (req, res) => {
  const b = req.body || {};
  const fields = ['name', 'description', 'repeat_after_days', 'allow_skip', 'min_seconds_per_slide', 'active'];
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
  const r = run(`INSERT INTO devices (site_id, location_id, name, token, mode, default_camera, print_enabled, created_at)
                 VALUES (?,?,?,?,?,?,?,?)`,
    b.site_id || null, b.location_id || null, clean(b.name) || 'Reception kiosk', token,
    clean(b.mode) || 'kiosk', clean(b.default_camera) || 'front', b.print_enabled === false ? 0 : 1, nowISO());
  audit(req, 'create', 'device', Number(r.lastInsertRowid), { name: b.name });
  res.json(get('SELECT * FROM devices WHERE id = ?', r.lastInsertRowid));
});

router.patch('/devices/:id', (req, res) => {
  const b = req.body || {};
  const fields = ['site_id', 'location_id', 'name', 'mode', 'default_camera', 'print_enabled', 'sections'];
  const cols = fields.filter((f) => b[f] !== undefined);
  if (cols.length) {
    run(`UPDATE devices SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
      ...cols.map((c) => (typeof b[c] === 'boolean' ? (b[c] ? 1 : 0) : b[c])), req.params.id);
  }
  audit(req, 'update', 'device', Number(req.params.id), b);
  res.json(get('SELECT * FROM devices WHERE id = ?', req.params.id));
});

router.delete('/devices/:id', (req, res) => {
  run('DELETE FROM devices WHERE id = ?', req.params.id);
  res.json({ ok: true });
});

/* -------------------------------------------------------------- settings */

const MASK = '********';
const maskSecrets = (s) => ({
  ...s,
  notify: {
    ...s.notify,
    smtp_pass: s.notify.smtp_pass ? MASK : '',
    twilio_auth_token: s.notify.twilio_auth_token ? MASK : ''
  }
});

router.get('/settings', (req, res) => res.json(maskSecrets(settings.getAll())));

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

  // A masked secret means "unchanged" — never write the mask itself back.
  if (patch.notify) {
    for (const key of ['smtp_pass', 'twilio_auth_token']) {
      if (patch.notify[key] === MASK) delete patch.notify[key];
    }
  }
  const updated = settings.setAll(patch);
  audit(req, 'update', 'settings', null, Object.keys(patch));
  res.json({ ...maskSecrets(updated), warnings });
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

router.post('/settings/test-email', async (req, res) => {
  const to = req.body.to || req.user.email;
  const result = await notify.sendTest(to);
  res.json({ ...result, to });
});

router.post('/settings/test-sms', async (req, res) => {
  if (!req.body.to) return res.status(400).json({ error: 'number_required' });
  const ok = await notify.sendTestSms(req.body.to);
  res.json({ ok, to: notify.toE164(req.body.to) });
});

router.post('/settings/test-webhook', async (req, res) => {
  if (!clean(req.body.url)) return res.json({ ok: false, detail: 'Enter a webhook URL first.' });
  const result = await notify.sendWebhook({
    url: req.body.url,
    title: 'Smart Lobby test notification',
    lines: ['If you can see this, your webhook is configured correctly.']
  });
  res.json(result);
});

/* ----------------------------------------------------------------- users */

router.get('/users', (req, res) => res.json(all('SELECT id, email, name, role, active, created_at FROM users ORDER BY id')));

router.post('/users', (req, res) => {
  const { email, password, name, role } = req.body || {};
  if (!email || !password || String(password).length < 8) return res.status(400).json({ error: 'weak_credentials' });
  try {
    res.json(auth.createUser({ email, password, name, role: role || 'admin' }));
  } catch (err) {
    res.status(400).json({ error: 'user_exists' });
  }
});

router.delete('/users/:id', (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'cannot_delete_self' });
  run('DELETE FROM users WHERE id = ?', req.params.id);
  res.json({ ok: true });
});

/* ----------------------------------------------------------------- stats */

router.get('/stats', (req, res) => {
  res.json({
    by_day: all(`SELECT substr(signed_in_at,1,10) AS day, COUNT(*) AS n FROM visits
                 WHERE signed_in_at >= date('now','-29 days') GROUP BY day ORDER BY day`),
    by_type: all('SELECT visit_type, COUNT(*) AS n FROM visits GROUP BY visit_type ORDER BY n DESC'),
    by_host: all(`SELECT h.name, COUNT(*) AS n FROM visits v JOIN hosts h ON h.id = v.host_id
                  GROUP BY h.id ORDER BY n DESC LIMIT 10`),
    by_company: all(`SELECT p.company AS name, COUNT(*) AS n FROM visits v JOIN visitors p ON p.id = v.visitor_id
                     WHERE p.company IS NOT NULL AND p.company != '' GROUP BY lower(p.company) ORDER BY n DESC LIMIT 10`),
    by_hour: all(`SELECT substr(signed_in_at,12,2) AS hour, COUNT(*) AS n FROM visits GROUP BY hour ORDER BY hour`),
    avg_minutes: get(`SELECT AVG((julianday(signed_out_at) - julianday(signed_in_at)) * 1440) AS m
                      FROM visits WHERE signed_out_at IS NOT NULL`).m
  });
});

module.exports = router;
