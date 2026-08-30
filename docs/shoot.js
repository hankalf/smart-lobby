#!/usr/bin/env node
'use strict';
/**
 * The screenshots in the guides.
 *
 *   DATA_DIR=/tmp/demo PORT=3512 node server/index.js &
 *   BASE_URL=http://localhost:3512 node docs/seed-demo.js
 *   BASE_URL=http://localhost:3512 node docs/shoot.js
 *
 * Shot against the seeded demo site rather than a real one, for the obvious
 * reason: these end up in a PDF that gets sent to people, and a real site's
 * dashboard is a list of real visitors' names, companies and arrival times.
 *
 * Each shot names the element it wants rather than taking the whole window,
 * so a screenshot stays about the thing it is illustrating instead of being a
 * browser window with the interesting part somewhere in the middle.
 */
const fs = require('fs');
const path = require('path');
const browser = require('../test/browser');

const BASE = process.env.BASE_URL || 'http://localhost:3512';
const OUT = path.join(__dirname, 'img');

/*
 * A desk monitor rather than a laptop: the dashboard is a wide table and
 * cramming it into 1280 makes the screenshots look like a phone app. Shot at
 * 2x so the type is still crisp when the PDF is printed.
 */
const ADMIN = { width: 1500, height: 980 };
const KIOSK = { width: 1024, height: 768 };   // an iPad, landscape
const BOARD = { width: 1600, height: 720 };   // a wall display

/**
 * A screenshot of a panel, trimmed to where its content actually stops.
 *
 * The dashboard's container is as tall as the window whatever is in it, so an
 * element screenshot of it comes out with a third of a page of empty grey
 * underneath. This measures the bottom of the last thing that is actually
 * drawn and clips there.
 */
async function trimmed(page, selector) {
  const box = await page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return null;
    const r = root.getBoundingClientRect();
    let bottom = r.top;
    for (const el of root.querySelectorAll('*')) {
      const b = el.getBoundingClientRect();
      // Anything with no size, or scrolled off, is not content.
      if (b.height < 4 || b.width < 4) continue;
      if (b.bottom > bottom) bottom = b.bottom;
    }
    return {
      x: Math.max(0, r.left + window.scrollX - 8),
      y: Math.max(0, r.top + window.scrollY - 8),
      width: Math.min(r.width + 16, document.documentElement.clientWidth),
      height: Math.min(bottom - r.top + 24, 4000)
    };
  }, selector);
  return box;
}

const SHOTS = [];
const shot = (name, describe, fn, viewport) => SHOTS.push({ name, describe, fn, viewport });

/* ------------------------------------------------------------- dashboard */

shot('dashboard', 'The dashboard as it looks mid-morning', async (page) => {
  await goAdmin(page, 'dashboard');
  await page.waitForSelector('.card.stat');
  return { clip: await trimmed(page, '#view') };
});

shot('rollcall', 'The emergency roll call', async (page) => {
  await goAdmin(page, 'dashboard');
  await page.waitForSelector('#btn-rollcall');
  await page.click('#btn-rollcall');
  await page.waitForTimeout(900);
  return page.locator('.modal-bg .modal, #rollcall, body').first();
});

/* -------------------------------------------------------------- expected */

shot('expected', 'Who is booked in before they arrive', async (page) => {
  await goAdmin(page, 'expected');
  await page.waitForSelector('#ex-results table, #ex-results .empty');
  return { clip: await trimmed(page, '#view') };
});

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
});

/* ---------------------------------------------------------------- visits */

shot('visits', 'Every sign-in, searchable and paged', async (page) => {
  await goAdmin(page, 'visits');
  await page.waitForSelector('#v-results table');
  return { clip: await trimmed(page, '#view') };
});

shot('visit-detail', 'One visit, with everything recorded against it', async (page) => {
  await goAdmin(page, 'visits');
  await page.waitForSelector('[data-visit]');
  await page.click('[data-visit]');
  await page.waitForSelector('.modal-bg .modal');
  await page.waitForTimeout(400);
  return page.locator('.modal-bg .modal').first();
});

/* ------------------------------------------------------------- registry */

shot('companies', 'Companies, with near-duplicates offered for merging', async (page) => {
  await goAdmin(page, 'companies');
  await page.waitForSelector('#co-results table, #view table');
  return { clip: await trimmed(page, '#view') };
});

shot('certificates', 'Paperwork with expiry dates', async (page) => {
  await goAdmin(page, 'compliance');
  await page.waitForTimeout(700);
  return { clip: await trimmed(page, '#view') };
});

/* ------------------------------------------------------------- reporting */

shot('reports', 'Reports over a chosen window', async (page) => {
  await goAdmin(page, 'reports');
  await page.waitForSelector('.card.stat');
  return { clip: await trimmed(page, '#view') };
});

shot('printable-report', 'The same figures on the letterhead', async (page, ctx) => {
  await signIn(page);
  const today = ctx.today;
  await page.goto(`${BASE}/api/admin/stats/print?from=${today}&to=${today}`, { waitUntil: 'load' });
  await page.waitForTimeout(500);
  return { clip: await trimmed(page, '.sheet') };
});

/* -------------------------------------------------------------- settings */

shot('card-designer', 'Designing what lands in Teams', async (page) => {
  await goAdmin(page, 'settings');
  await page.waitForTimeout(600);
  const tab = page.locator('#nav [data-section="notifications"]').first();
  if (await tab.count()) { await tab.click(); await page.waitForTimeout(900); }
  const designer = page.locator('#cd-preview').first();
  if (await designer.count()) {
    await designer.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    return { clip: await trimmed(page, '#set-notifications') };
  }
  return { clip: await trimmed(page, '#view') };
});

shot('storage', 'Room on the disk, and the pressure valve', async (page) => {
  await goAdmin(page, 'settings');
  await page.waitForTimeout(600);
  const tab = page.locator('#nav [data-section="backups"]').first();
  if (await tab.count()) { await tab.click(); await page.waitForTimeout(1200); }
  const box = page.locator('#storage-use').first();
  if (await box.count()) await box.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  return { clip: await trimmed(page, '#set-backups') };
});

/* ----------------------------------------------------------------- board */

shot('board', 'The on-site board, for a screen in the office', async (page, ctx) => {
  await page.goto(`${BASE}${ctx.boardPath}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1400);
  return null;                       // the whole page: it is the whole point
}, BOARD);

/* ----------------------------------------------------------------- kiosk */

shot('kiosk-welcome', 'The kiosk welcome screen', async (page) => {
  await page.goto(`${BASE}/kiosk/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  return { clip: await trimmed(page, '.screen:not([hidden]) .idle-inner') };
}, KIOSK);

shot('kiosk-details', 'The details a visitor is asked for', async (page) => {
  await page.goto(`${BASE}/kiosk/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  // The Sign in card on the home screen.
  await page.locator('.tile[data-action="signin"]').first().click();
  await page.waitForTimeout(900);
  // A visitor card, if the picker appeared behind Sign in.
  const picker = page.locator('.tile[data-type="visitor"]').first();
  if (await picker.count() && await picker.isVisible()) { await picker.click(); await page.waitForTimeout(900); }
  // "I'm new here", past the returning-visitor lookup.
  const fresh = page.locator('#identify-skip');
  if (await fresh.count() && await fresh.isVisible()) { await fresh.click(); await page.waitForTimeout(1200); }
  // Filled in as a visitor would, so the shot shows a form in use rather than
  // an empty one.
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
  if (parent) { await page.click(`#nav > button[data-view="${parent}"]`); await page.waitForTimeout(250); }
  await page.click(`#nav [data-view="${view}"]`);
  await page.waitForTimeout(900);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  // The board's address, which is issued rather than fixed.
  const jar = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'hankalfr@gmail.com', password: 'Testing123!' })
  });
  const cookie = (jar.headers.get('set-cookie') || '').split(';')[0];
  const link = await fetch(`${BASE}/api/admin/board/link`, { headers: { cookie } }).then((r) => r.json());
  // The site's own day, not the container's, so the printed report covers the
  // day the seeded arrivals are actually on.
  const today = await fetch(`${BASE}/api/admin/expected`, { headers: { cookie } })
    .then((r) => r.json()).then((j) => j.day).catch(() => new Date().toISOString().slice(0, 10));
  const ctx = { boardPath: link.url ? new URL(link.url).pathname : '/board/', today };

  const b = await browser.chromium.launch(browser.launchOptions());
  for (const s of SHOTS) {
    const viewport = s.viewport || ADMIN;
    const context = await b.newContext({ viewport, deviceScaleFactor: 2 });
    const page = await context.newPage();
    try {
      const target = await s.fn(page, ctx);
      const file = path.join(OUT, `${s.name}.png`);
      if (target && target.clip) await page.screenshot({ path: file, clip: target.clip });
      else if (target) await target.screenshot({ path: file });
      else await page.screenshot({ path: file });
      console.log(`  ${s.name.padEnd(20)} ${Math.round(fs.statSync(file).size / 1024)}KB  ${s.describe}`);
    } catch (err) {
      console.log(`  ${s.name.padEnd(20)} FAILED — ${String(err.message).split('\n')[0].slice(0, 90)}`);
    }
    await context.close();
  }
  await b.close();
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
