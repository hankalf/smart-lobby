'use strict';
require('dotenv').config();

const path = require('path');
const express = require('express');
const { migrate, all, get, run, nowISO, STORAGE } = require('./db');
const auth = require('./auth');
const settings = require('./settings');
const files = require('./files');

migrate();

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true, limit: '12mb' }));

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

/* --------------------------------------------------------------- routes */

app.use('/api/kiosk', require('./routes/kiosk'));
app.use('/api/admin', require('./routes/admin'));

const QRCode = require('qrcode');
app.get('/api/qr', async (req, res) => {
  const text = String(req.query.text || '').slice(0, 512);
  if (!text) return res.status(400).send('missing text');
  try {
    const svg = await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.type('image/svg+xml').set('Cache-Control', 'public, max-age=3600').send(svg);
  } catch (err) {
    res.status(500).send('qr_failed');
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    time: nowISO(),
    onsite: get("SELECT COUNT(*) AS n FROM visits WHERE status='onsite'").n,
    storage: STORAGE.ephemeral ? 'ephemeral' : 'persistent'
  });
});

/* ---------------------------------------------------------------- media */

app.use('/media/public', express.static(files.PUBLIC_DIR, { maxAge: '7d' }));
app.use('/media/private', (req, res, next) => {
  if (!auth.currentUser(req)) return res.status(403).send('Forbidden');
  next();
}, express.static(files.PRIVATE_DIR));

/* ------------------------------------------------------------ front end */

const PUBLIC_WEB = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_WEB, { extensions: ['html'] }));
app.get('/', (req, res) => res.redirect('/kiosk/'));
app.get('/kiosk', (req, res) => res.redirect('/kiosk/'));
app.get('/admin', (req, res) => res.redirect('/admin/'));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[error]', err);
  res.status(500).json({ error: 'server_error', detail: String(err.message || err) });
});

/* --------------------------------------------------------- housekeeping */

function autoSignOut() {
  const kiosk = settings.getSection('kiosk');
  const org = settings.getSection('org');
  if (!kiosk.auto_signout_hour) return;
  let hour;
  try {
    hour = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: org.timezone }).format(new Date()));
  } catch { hour = new Date().getHours(); }
  if (hour < Number(kiosk.auto_signout_hour)) return;
  const stale = all("SELECT id FROM visits WHERE status = 'onsite'");
  if (!stale.length) return;
  run("UPDATE visits SET status = 'out', signed_out_at = ?, signed_out_by = 'auto' WHERE status = 'onsite'", nowISO());
  console.log(`[auto-signout] closed ${stale.length} open visit(s)`);
}

function purgeOldData() {
  const p = settings.getSection('privacy');
  if (p.retain_photos_days) {
    const cutoff = new Date(Date.now() - p.retain_photos_days * 864e5).toISOString();
    for (const v of all('SELECT id, photo_path FROM visits WHERE photo_path IS NOT NULL AND signed_in_at < ?', cutoff)) {
      files.removeFile(v.photo_path);
      run('UPDATE visits SET photo_path = NULL WHERE id = ?', v.id);
    }
  }
  if (p.retain_visits_days) {
    const cutoff = new Date(Date.now() - p.retain_visits_days * 864e5).toISOString();
    const n = run('DELETE FROM visits WHERE signed_in_at < ?', cutoff).changes;
    if (n) console.log(`[retention] removed ${n} visit record(s) older than ${p.retain_visits_days} days`);
  }
  auth.purgeExpired();
}

setInterval(autoSignOut, 15 * 60 * 1000);
setInterval(purgeOldData, 24 * 60 * 60 * 1000);

/* ------------------------------------------------------- first-run seed */

function seedIfEmpty() {
  if (!get('SELECT id FROM sites LIMIT 1')) {
    run('INSERT INTO sites (name, active, created_at) VALUES (?,1,?)', settings.getSection('org').name || 'Main site', nowISO());
  }
  if (!get('SELECT id FROM agreements LIMIT 1')) {
    run(`INSERT INTO agreements (name, body, version, required_for, active, created_at) VALUES (?,?,?,?,?,?)`,
      'Site safety rules & confidentiality',
      ['While on site you agree to:',
        '- Report to your host and remain with them in operational areas.',
        '- Wear the PPE provided and follow all safety signage.',
        '- Follow the fire evacuation procedure and assemble at the muster point.',
        '- Keep confidential any information you see or hear during your visit.',
        '- Report any accident, near miss or hazard to reception immediately.'].join('\n'),
      1, JSON.stringify(['visitor', 'contractor', 'interview']), 1, nowISO());
  }
}
seedIfEmpty();

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`\n  Smart Lobby running`);
  console.log(`  Kiosk : http://localhost:${PORT}/kiosk/`);
  console.log(`  Admin : http://localhost:${PORT}/admin/\n`);
  if (!auth.anyUsers()) console.log('  First run: open the admin URL to create your account.\n');
});
