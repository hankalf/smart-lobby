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
/*
 * A sign-in carries a photo and a few signatures as base64, which fits inside
 * this comfortably. The old 12mb allowed an anonymous caller to make the server
 * buffer twelve megabytes per request before anything could reject it.
 */
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true, limit: '4mb' }));

app.disable('x-powered-by');

/*
 * Everything the app needs is served from this origin: no CDN, no third-party
 * fonts or analytics. That makes a tight policy cheap — the only concession is
 * inline styles, which a handful of elements and the app's own show/hide use.
 * Scripts are files on this origin only, so a content-injection bug cannot be
 * turned into script execution.
 *
 * frame-ancestors 'none' keeps the dashboard out of somebody else's iframe,
 * which is what would otherwise let a crafted page trick a signed-in admin
 * into clicking through it.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // Captured photos and signatures are canvas data: URIs before they are saved.
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self'",
  // The kiosk embeds an uploaded PDF when poppler cannot split it into pages.
  "object-src 'self'",
  // Nothing frames anything by default; the board widens this for one camera.
  "frame-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');

/**
 * The board may show one camera, so its page — and only its page — is allowed
 * to load pictures from exactly that one origin.
 *
 * Widening the policy for the whole app to admit a camera would give every
 * other page the same reach for no reason. This adds the configured origin to
 * the three directives a camera can arrive through, and nothing else.
 */
function cspFor(req) {
  if (!/^\/board(\/|$)/.test(req.path)) return CSP;
  const b = settings.getSection('board');
  if (!b.camera_enabled || !b.camera_url || b.camera_proxy) return CSP;
  let origin;
  try { origin = new URL(b.camera_url).origin; } catch { return CSP; }
  return CSP
    .replace("img-src 'self' data: blob:", `img-src 'self' data: blob: ${origin}`)
    .replace("media-src 'self' blob:", `media-src 'self' blob: ${origin}`)
    .replace("connect-src 'self'", `connect-src 'self' ${origin}`)
    .replace("frame-src 'self'", `frame-src 'self' ${origin}`);
}

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', cspFor(req));
  res.setHeader('X-Frame-Options', 'DENY');
  /*
   * Told only over a connection that is already secure: sending it over plain
   * http would pin a LAN install to a scheme it may not have a certificate
   * for. Railway terminates TLS ahead of us, hence the forwarded header.
   */
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});

/* --------------------------------------------------------------- routes */

app.use('/api/kiosk', require('./routes/kiosk'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/board', require('./routes/board').router);

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
    storage: STORAGE.ephemeral ? 'ephemeral' : 'persistent',
    // Whether uploaded PowerPoint decks can be rendered slide-for-slide here.
    slide_rendering: require('./slides').capabilities()
  });
});

/* ---------------------------------------------------------------- media */

/*
 * The one photo path with no session behind it.
 *
 * Teams renders a card by having its own servers fetch the image, so the
 * picture in every arrival card has to be reachable without a login — which is
 * why it is signed instead. The token covers this visit id and an expiry, and
 * nothing here trusts the path: a bad or stale signature is refused before any
 * lookup happens. See server/photolink.js for the reasoning.
 */
const photolink = require('./photolink');
const photoLinkLimit = require('./ratelimit').limit({
  windowMs: 60_000, max: 600, name: 'notify-photo', message: 'Too many requests.'
});
app.get('/notify/photo/:id', photoLinkLimit, (req, res) => {
  const id = Number(req.params.id);
  if (!id || !photolink.valid(id, req.query.t)) return res.status(403).end();
  const visit = get('SELECT photo_path FROM visits WHERE id = ?', id);
  const abs = visit && visit.photo_path && files.absoluteFor(visit.photo_path);
  // The photo may have been cleared by retention long before the card scrolls by.
  if (!abs) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(abs);
});

app.use('/media/public', express.static(files.PUBLIC_DIR, { maxAge: '7d' }));
app.use('/media/private', (req, res, next) => {
  if (!auth.currentUser(req)) return res.status(403).send('Forbidden');
  next();
}, express.static(files.PRIVATE_DIR));

/* ------------------------------------------------------------ front end */

const PUBLIC_WEB = path.join(__dirname, '..', 'public');

// An iPad kiosk added to the home screen caches hard, and would keep running an
// old copy of the app after a deploy. These files must always be revalidated;
// they are small, and uploaded media is cached separately above.
app.use((req, res, next) => {
  if (/\.(html|js|css)$/.test(req.path) || req.path.endsWith('/')) {
    res.setHeader('Cache-Control', 'no-cache');
  }
  next();
});
app.use(express.static(PUBLIC_WEB, { extensions: ['html'] }));
app.get('/', (req, res) => res.redirect('/kiosk/'));
app.get('/kiosk', (req, res) => res.redirect('/kiosk/'));
app.get('/admin', (req, res) => res.redirect('/admin/'));

/*
 * Each tablet has its own address: /kiosk/north-gate. These come after the
 * static handler above, so a real file — /kiosk/kiosk.js — is always served as
 * itself and a slug can never shadow one.
 */
const devices = require('./devices');

/**
 * A web app manifest per device, so "Add to Home Screen" on an iPad saves an
 * icon named after the tablet that reopens on that tablet's own page. Without
 * one, iOS saves whatever is in the address bar and the device is only as
 * durable as the URL — which is how a home-screen icon used to come back to
 * the shared page showing every card.
 */
app.get('/kiosk/:slug/manifest.webmanifest', (req, res) => {
  const device = devices.bySlug(req.params.slug);
  if (!device) return res.status(404).json({ error: 'unknown_device' });
  const org = settings.getSection('org');
  res.type('application/manifest+json').set('Cache-Control', 'no-cache').json({
    name: `${device.name} — ${org.name || 'Smart Lobby'}`,
    short_name: device.name,
    // Reopening the icon lands on this device's page, token or no token.
    start_url: `/kiosk/${device.slug}`,
    scope: `/kiosk/${device.slug}`,
    display: 'standalone',
    orientation: 'any',
    background_color: '#0f172a',
    theme_color: '#0f172a'
  });
});

/*
 * Express matches this with or without a trailing slash, so /kiosk/north-gate
 * and /kiosk/north-gate/ are the same page — the kiosk normalises the address
 * bar itself once it knows which device it is.
 *
 * An address naming no device still serves the page rather than a 404: the
 * tablet stays usable, and the kiosk shows a notice saying the link matches
 * nothing, which is far more use to whoever is setting it up than a browser
 * error. The ping is what decides that, so there is one answer, not two.
 */
app.get('/kiosk/:slug', (req, res) => {
  res.set('Cache-Control', 'no-cache').sendFile(path.join(PUBLIC_WEB, 'kiosk', 'index.html'));
});

/*
 * The wall board. The key in the address is what lets the page load at all —
 * the page itself then reads the roster from /api/board/<key>/data, which
 * checks it again. Serving the shell to a wrong key would only put an empty
 * page on screen, so it is refused here as well.
 */
app.get('/board/:key', (req, res) => {
  const board = require('./routes/board');
  if (!board.keyMatches(req.params.key) && !auth.currentUser(req)) return res.status(404).send('Not found');
  res.set('Cache-Control', 'no-cache').sendFile(path.join(PUBLIC_WEB, 'board', 'index.html'));
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[error]', err);
  res.status(500).json({ error: 'server_error', detail: String(err.message || err) });
});

/* --------------------------------------------------------- housekeeping */

/**
 * Close anyone still signed in at the configured time — people forget to sign
 * out, and a roll call is worthless if last week's visitors are still listed.
 *
 * It fires only during the minute it is set for, in the site's own time zone, so
 * somebody arriving after it never gets signed straight back out again.
 */
let lastAutoSignOut = null;
function autoSignOut() {
  const kiosk = settings.getSection('kiosk');
  const org = settings.getSection('org');
  if (!kiosk.auto_signout_enabled) return;

  const target = /^\d{1,2}:\d{2}$/.test(kiosk.auto_signout_time || '') ? kiosk.auto_signout_time : '23:59';
  let localNow;
  try {
    localNow = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: org.timezone
    }).format(new Date());
  } catch {
    const d = new Date();
    localNow = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  const [h, m] = target.split(':');
  if (localNow !== `${h.padStart(2, '0')}:${m}`) return;

  const stamp = `${new Date().toISOString().slice(0, 10)} ${localNow}`;
  if (lastAutoSignOut === stamp) return; // already done this minute
  lastAutoSignOut = stamp;

  const stale = all("SELECT id FROM visits WHERE status = 'onsite'");
  if (!stale.length) return;
  run("UPDATE visits SET status = 'out', signed_out_at = ?, signed_out_by = 'auto' WHERE status = 'onsite'", nowISO());
  console.log(`[auto-signout] closed ${stale.length} open visit(s) at ${localNow}`);
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
  /*
   * The licence details go before the visit does. Keeping a licence number for
   * the same two years as the visit record was never a decision anybody made —
   * it was just the only window there was. The visit stays; the three ID
   * fields on it are emptied.
   */
  if (p.retain_id_days) {
    const cutoff = new Date(Date.now() - p.retain_id_days * 864e5).toISOString();
    const n = run(`UPDATE visits SET id_name = NULL, id_number = NULL, id_state = NULL
                   WHERE signed_in_at < ? AND (id_name IS NOT NULL OR id_number IS NOT NULL OR id_state IS NOT NULL)`,
      cutoff).changes;
    if (n) console.log(`[retention] cleared ID details from ${n} visit(s) older than ${p.retain_id_days} days`);
  }
  if (p.retain_visits_days) {
    const cutoff = new Date(Date.now() - p.retain_visits_days * 864e5).toISOString();
    const n = run('DELETE FROM visits WHERE signed_in_at < ?', cutoff).changes;
    if (n) console.log(`[retention] removed ${n} visit record(s) older than ${p.retain_visits_days} days`);
    /*
     * Deleted records are held for the same period, then cleared for good
     * along with the images only they still referred to — otherwise the
     * archive would quietly become the one place old visitor data lives on.
     */
    const archived = require('./archive').purgeOlderThan(p.retain_visits_days);
    if (archived) console.log(`[retention] purged ${archived} deleted record(s) past the retention window`);
  }
  auth.purgeExpired();
}

setInterval(autoSignOut, 30 * 1000); // checked often so a to-the-minute time is not missed
setInterval(purgeOldData, 24 * 60 * 60 * 1000);

/*
 * A nightly copy of the database, kept for a week. The first one is written a
 * minute after boot rather than waiting a day, so a fresh deploy is never
 * twenty-four hours away from having any backup at all.
 */
const backup = require('./backup');
setTimeout(() => backup.runDaily(), 60 * 1000).unref();
setInterval(() => backup.runDaily(), 24 * 60 * 60 * 1000);

// Posts that failed for a reason worth a second go.
setInterval(() => {
  require('./notify').retryPending().catch((err) => console.error('[notify] retry sweep:', err.message));
}, 60 * 1000);

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
