#!/usr/bin/env node
'use strict';
/**
 * The screenshots in the guides.
 *
 *   DATA_DIR=/tmp/demo PORT=3512 node server/index.js &
 *   BASE_URL=http://localhost:3512 node docs/seed-demo.js
 *   BASE_URL=http://localhost:3512 node docs/shoot.js
 *
 * And, against a server that has never been set up, for the first-run screens
 * the Setup Guide opens with:
 *
 *   DATA_DIR=/tmp/fresh PORT=3514 node server/index.js &
 *   BASE_URL=http://localhost:3514 node docs/shoot.js --fresh
 *
 * Shot against a seeded demo site rather than a real one, for the obvious
 * reason: these end up in a PDF that gets sent to people, and a real site's
 * dashboard is a list of real visitors' names, companies and arrival times.
 *
 * Each shot is trimmed to where its content actually stops rather than being a
 * browser window with the interesting part somewhere in the middle.
 */
const fs = require('fs');
const path = require('path');
const browser = require('../test/browser');

const BASE = process.env.BASE_URL || 'http://localhost:3512';
const OUT = path.join(__dirname, 'img');
const FRESH = process.argv.includes('--fresh');
const ONLY = process.argv.filter((a) => !a.startsWith('--')).slice(2);

/*
 * A desk monitor rather than a laptop: the dashboard is a wide table and
 * cramming it into 1280 makes the screenshots look like a phone app. 1.5x is
 * about 390dpi once it is scaled into a 146mm text block — past what a printer
 * resolves, and half the file size of 2x.
 */
const ADMIN = { width: 1500, height: 980, scale: 1.5 };
const KIOSK = { width: 1024, height: 768, scale: 2 };    // an iPad, landscape
const BOARD = { width: 1600, height: 720, scale: 1.5 };  // a wall display
const NARROW = { width: 1000, height: 900, scale: 2 };   // a dialogue

/**
 * A screenshot of a panel, trimmed to where its content actually stops.
 *
 * The dashboard's container is as tall as the window whatever is in it, so an
 * element screenshot of it comes out with a third of a page of empty grey
 * underneath. This measures the bottom of the last thing that is actually
 * drawn and clips there.
 */
async function trimmed(page, selector) {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return null;
    const r = root.getBoundingClientRect();
    let bottom = r.top;
    for (const el of root.querySelectorAll('*')) {
      const b = el.getBoundingClientRect();
      if (b.height < 4 || b.width < 4) continue;
      if (b.bottom > bottom) bottom = b.bottom;
    }
    return {
      x: Math.max(0, r.left + window.scrollX - 8),
      y: Math.max(0, r.top + window.scrollY - 8),
      width: Math.min(r.width + 16, document.documentElement.clientWidth),
      height: Math.min(bottom - r.top + 24, 5200)
    };
  }, selector);
}

const SHOTS = [];
const shot = (name, describe, fn, viewport) => SHOTS.push({ name, describe, fn, viewport });

/* ======================================================== ordinary pages ==
 *
 * Most shots are "open this page and photograph it", so they are a table
 * rather than twenty near-identical functions. `view` is a menu entry;
 * `section` is one panel on the settings page.
 */
const PAGES = [
  ['dashboard',      { view: 'dashboard' },      'The dashboard mid-afternoon'],
  ['expected',       { view: 'expected' },       'Who is booked in before they arrive'],
  ['visits',         { view: 'visits' },         'Every sign-in, searchable and paged'],
  ['visitors',       { view: 'visitors' },       'Everyone on file, with induction status'],
  ['drivers',        { view: 'drivers' },        'Drivers on site, with the full log'],
  ['deliveries',     { view: 'deliveries' },     'Parcels waiting to be collected'],
  ['staff',          { view: 'staff' },          'The people visitors ask for'],
  ['companies',      { view: 'companies' },      'Firms as records, with duplicates flagged'],
  ['certificates',   { view: 'compliance' },     'Paperwork with expiry dates'],
  ['projects',       { view: 'projects' },       'The jobs contractors sign in against'],
  ['vtypes',         { view: 'vtypes' },         'The kiosk cards, with a live preview'],
  ['documents',      { view: 'documents' },      'NDAs, site rules and questionnaires'],
  ['induction',      { view: 'induction' },      'Induction decks'],
  ['badges',         { view: 'badges' },         'The badge designer'],
  ['devices',        { view: 'devices' },        'Every tablet, with its own address'],
  ['printers',       { view: 'printers' },       'The label printers on site'],
  ['doors',          { view: 'access' },         'Doors, each one an HTTP call'],
  ['locations',      { view: 'locations' },      'Areas within the site'],
  ['reports',        { view: 'reports' },        'Reports over a chosen window'],
  ['set-branding',   { section: 'branding' },    'Branding, and the site clock'],
  ['set-form',       { section: 'details' },     'Which fields each visitor type is asked'],
  ['set-flow',       { section: 'flow' },        'The kiosk sign-in flow'],
  ['set-notifications', { section: 'notifications' }, 'The notification channels'],
  ['set-board',      { section: 'board' },       'The on-site board settings'],
  ['set-retention',  { section: 'retention' },   'How long anything is kept'],
  ['set-backups',    { section: 'backups' },     'Backups, off-site copies and the disk'],
  ['set-users',      { section: 'users' },       'Who has a login, and at what level'],
  ['set-deleted',    { section: 'deleted' },     'Deleted records, and putting one back'],
  ['set-activity',   { section: 'activity' },    'The activity log']
];

for (const [name, where, describe] of PAGES) {
  shot(name, describe, async (page) => {
    if (where.view) {
      await goAdmin(page, where.view);
      return { clip: await trimmed(page, '#view') };
    }
    await openSection(page, where.section);
    return { clip: await trimmed(page, `#set-${where.section}`) };
  });
}

/* ============================================================== the rest == */

shot('rollcall', 'The emergency roll call', async (page) => {
  await goAdmin(page, 'dashboard');
  await page.waitForSelector('#btn-rollcall');
  await page.click('#btn-rollcall');
  await page.waitForTimeout(1000);
  return null;
}, BOARD);

shot('expected-form', 'Booking somebody in', async (page) => {
  await goAdmin(page, 'expected');
  await page.waitForSelector('#ex-add');
  await page.click('#ex-add');
  await page.waitForSelector('#ex-name');
  await page.fill('#ex-name', 'Wanda Achebe');
  await page.fill('#ex-company', 'Redgate Insurance');
  await page.fill('#ex-phone', '415-268-3000');
  await page.fill('#ex-purpose', 'Insurance renewal');
  await page.fill('#ex-at', '14:30');
  return page.locator('.modal-bg .modal').first();
}, NARROW);

shot('visit-detail', 'One visit, with everything recorded against it', async (page) => {
  await goAdmin(page, 'visits');
  await page.waitForSelector('[data-visit]');
  await page.click('[data-visit]');
  await page.waitForSelector('.modal-bg .modal');
  await page.waitForTimeout(500);
  return page.locator('.modal-bg .modal').first();
}, NARROW);

shot('card-designer', 'Designing what lands in Teams', async (page) => {
  await openSection(page, 'notifications');
  const designer = page.locator('#cd-preview').first();
  if (await designer.count()) { await designer.scrollIntoViewIfNeeded(); await page.waitForTimeout(500); }
  return { clip: await trimmed(page, '#set-notifications') };
});

shot('storage', 'Room on the disk, and the pressure valve', async (page) => {
  await openSection(page, 'backups');
  const box = page.locator('#storage-use').first();
  if (await box.count()) await box.scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  const clip = await trimmed(page, '#storage-use');
  return { clip: clip && { ...clip, height: Math.min(clip.height + 420, 2400) } };
});

shot('printable-report', 'The same figures on the letterhead', async (page, ctx) => {
  await signIn(page);
  await page.goto(`${BASE}/api/admin/stats/print?from=${ctx.today}&to=${ctx.today}`, { waitUntil: 'load' });
  await page.waitForTimeout(600);
  return { clip: await trimmed(page, '.sheet') };
}, { width: 1100, height: 900, scale: 2 });

shot('board', 'The on-site board, for a screen in the office', async (page, ctx) => {
  await page.goto(`${BASE}${ctx.boardPath}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1400);
  return null;
}, BOARD);

/* ----------------------------------------------------------------- kiosk */

shot('kiosk-welcome', 'The kiosk welcome screen', async (page) => {
  await page.goto(`${BASE}/kiosk/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1600);
  return { clip: await trimmed(page, '.screen:not([hidden]) .idle-inner') };
}, KIOSK);

shot('kiosk-details', 'The details a visitor is asked for', async (page) => {
  await page.goto(`${BASE}/kiosk/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1600);
  await page.locator('.tile[data-action="signin"]').first().click();
  await page.waitForTimeout(900);
  const picker = page.locator('.tile[data-type="visitor"]').first();
  if (await picker.count() && await picker.isVisible()) { await picker.click(); await page.waitForTimeout(900); }
  const fresh = page.locator('#identify-skip');
  if (await fresh.count() && await fresh.isVisible()) { await fresh.click(); await page.waitForTimeout(1200); }
  const fill = async (sel, value) => {
    const f = page.locator(sel);
    if (await f.count() && await f.isVisible()) await f.fill(value).catch(() => {});
  };
  await fill('#f-name', 'Wanda Achebe');
  await fill('#f-company', 'Redgate Insurance');
  await fill('#f-phone', '(415) 268-3000');
  await fill('#f-purpose', 'Insurance renewal');
  await page.waitForTimeout(400);
  return { clip: await trimmed(page, '.screen:not([hidden])') };
}, KIOSK);

shot('kiosk-signout', 'Signing out, scanner first', async (page) => {
  await page.goto(`${BASE}/kiosk/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1600);
  await page.locator('.tile[data-action="signout"]').first().click();
  await page.waitForTimeout(900);
  const box = page.locator('#signout-q');
  if (await box.count() && await box.isVisible()) { await box.fill('a'); await page.waitForTimeout(1200); }
  return { clip: await trimmed(page, '.screen:not([hidden])') };
}, KIOSK);

/* ====================================================== the first run in ==
 *
 * These need a server nobody has set up yet, so they are taken in a separate
 * pass against an empty data directory.
 */
const FRESH_SHOTS = [];
const freshShot = (name, describe, fn, viewport) => FRESH_SHOTS.push({ name, describe, fn, viewport });

freshShot('first-run', 'The only screen a new install shows', async (page) => {
  await page.goto(`${BASE}/admin/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const fill = async (sel, v) => {
    const f = page.locator(sel);
    if (await f.count() && await f.isVisible()) await f.fill(v).catch(() => {});
  };
  await fill('#gate-org', "Nature's Touch Builds");
  await fill('#gate-name', 'Hank Alfred');
  await fill('#gate-email', 'hank@naturestouch.example');
  await page.waitForTimeout(300);
  return { clip: await trimmed(page, '.gate-card') };
}, NARROW);

freshShot('sign-in-screen', 'Signing in afterwards', async (page) => {
  // Set up in passing, so the gate has an account to ask about.
  await fetch(`${BASE}/api/admin/setup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'hank@naturestouch.example', password: 'Testing123!',
      name: 'Hank Alfred', org_name: "Nature's Touch Builds" })
  }).catch(() => {});
  await page.goto(`${BASE}/admin/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.locator('#gate-email').fill('hank@naturestouch.example').catch(() => {});
  return { clip: await trimmed(page, '.gate-card') };
}, NARROW);

freshShot('day-one-dashboard', 'The dashboard on day one', async (page) => {
  await page.goto(`${BASE}/admin/`, { waitUntil: 'networkidle' });
  if (await page.locator('#gate-email').count()) {
    await page.fill('#gate-email', 'hank@naturestouch.example');
    await page.fill('#gate-pass', 'Testing123!');
    await page.click('#gate-submit');
    await page.waitForSelector('#shell:not(.hidden)', { timeout: 10000 });
  }
  await page.waitForTimeout(1400);
  return { clip: await trimmed(page, '#view') };
});

/* --------------------------------------------------------------- helpers */

async function signIn(page) {
  await page.goto(`${BASE}/admin/`, { waitUntil: 'networkidle' });
  if (await page.locator('#gate-email').count()) {
    await page.fill('#gate-email', 'hankalfr@gmail.com');
    await page.fill('#gate-pass', 'Testing123!');
    await page.click('#gate-submit');
    await page.waitForSelector('#shell:not(.hidden)', { timeout: 10000 });
  }
}

async function goAdmin(page, view) {
  if (!page.url().includes('/admin/')) await signIn(page);
  // A page listed under a heading is only clickable once the heading is open.
  const parent = await page.evaluate((v) => {
    const child = document.querySelector(`#nav .subnav button[data-view="${v}"]`);
    return child ? child.closest('.subnav').dataset.for : null;
  }, view);
  if (parent) { await page.click(`#nav > button[data-view="${parent}"]`); await page.waitForTimeout(300); }
  await page.click(`#nav [data-view="${view}"]`);
  await page.waitForTimeout(1100);
}

/** One panel of the settings page, opened from the menu and scrolled to. */
async function openSection(page, section) {
  if (!page.url().includes('/admin/')) await signIn(page);
  await page.click('#nav > button[data-view="settings"]').catch(() => {});
  await page.waitForTimeout(400);
  await page.click(`#nav [data-section="${section}"]`);
  await page.waitForTimeout(1300);
}

/* ------------------------------------------------------------------ run */

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const chosen = (FRESH ? FRESH_SHOTS : SHOTS)
    .filter((s) => !ONLY.length || ONLY.some((o) => s.name.includes(o)));

  const ctx = { boardPath: '/board/', today: new Date().toISOString().slice(0, 10) };
  if (!FRESH) {
    const jar = await fetch(`${BASE}/api/admin/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'hankalfr@gmail.com', password: 'Testing123!' })
    });
    const cookie = (jar.headers.get('set-cookie') || '').split(';')[0];
    const link = await fetch(`${BASE}/api/admin/board/link`, { headers: { cookie } }).then((r) => r.json());
    if (link.url) ctx.boardPath = new URL(link.url).pathname;
    // The site's own day, not the container's.
    ctx.today = await fetch(`${BASE}/api/admin/expected`, { headers: { cookie } })
      .then((r) => r.json()).then((j) => j.day).catch(() => ctx.today);
  }

  const b = await browser.chromium.launch(browser.launchOptions());
  let failed = 0;
  for (const s of chosen) {
    const v = s.viewport || ADMIN;
    const context = await b.newContext({
      viewport: { width: v.width, height: v.height },
      deviceScaleFactor: v.scale || 2
    });
    const page = await context.newPage();
    try {
      const target = await s.fn(page, ctx);
      const file = path.join(OUT, `${s.name}.png`);
      if (target && target.clip) await page.screenshot({ path: file, clip: target.clip });
      else if (target) await target.screenshot({ path: file });
      else await page.screenshot({ path: file });
      console.log(`  ${s.name.padEnd(20)} ${String(Math.round(fs.statSync(file).size / 1024)).padStart(4)}KB  ${s.describe}`);
    } catch (err) {
      failed++;
      console.log(`  ${s.name.padEnd(20)} FAILED — ${String(err.message).split('\n')[0].slice(0, 90)}`);
    }
    await context.close();
  }
  await b.close();
  if (failed) process.exitCode = 1;
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
