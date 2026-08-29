'use strict';
const { chromium, launchOptions } = require('./browser');
const BASE = process.env.BASE_URL || 'http://localhost:3401';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n}${x ? ' — ' + x : ''}`); } };

(async () => {
  const browser = await chromium.launch({ ...launchOptions(), args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 1366 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));

  await page.goto(`${BASE}/kiosk/front-gate`);
  await page.waitForSelector('body.cfg-ready', { timeout: 10000 });

  const NAME = 'Offline Person ' + Date.now();
  // Block the sign-in endpoint so the kiosk queues it, as a dead spot would.
  let blocking = true;
  await page.route('**/api/kiosk/signin', (route) => (blocking ? route.abort('failed') : route.continue()));

  const startVisible = await page.$eval('#start-btn', (el) => !el.hidden && !!el.offsetParent).catch(() => false);
  if (startVisible) await page.click('#start-btn');
  await page.waitForFunction(() => document.querySelectorAll('#menu-tiles [data-action], #welcome-actions [data-action]').length > 0);
  await page.click('[data-action="contractor"]');
  await page.waitForSelector('[data-screen="identify"]:not([hidden])');
  await page.click('#identify-skip');
  await page.waitForSelector('[data-screen="details"]:not([hidden])');
  await page.fill('#f-name', NAME);
  await page.fill('#f-company', 'Dead Spot Ltd');
  await page.fill('#f-phone', '415-268-0888');
  const projVisible = await page.$eval('#f-project', (el) => !!el.closest('label')).catch(() => false);
  if (projVisible) await page.selectOption('#f-project', { index: 1 }).catch(() => {});
  await page.click('#details-continue');

  // walk the rest of the flow
  for (let i = 0; i < 12; i++) {
    const scr = await page.$eval('.screen:not([hidden])', (el) => el.dataset.screen).catch(() => null);
    if (scr === 'done') break;
    if (scr === 'photo') {
      await page.waitForTimeout(1200); await page.click('#btn-capture');
      await page.waitForFunction(() => { const i2 = document.querySelector('.camera-wrap img'); return i2 && i2.src.startsWith('data:image'); }, null, { timeout: 8000 }).catch(() => {});
      await page.click('#btn-photo-continue');
    } else if (scr === 'agreement') {
      const box = await page.locator('#sig-pad').boundingBox();
      await page.mouse.move(box.x + 40, box.y + 60); await page.mouse.down();
      for (let j = 0; j < 10; j++) await page.mouse.move(box.x + 40 + j * 12, box.y + 60 + (j % 3) * 8);
      await page.mouse.up();
      await page.click('#agreement-continue');
    } else if (scr === 'induction') {
      await page.click('#deck-next');
    } else if (scr === 'ack') {
      const blk = await page.$eval('#ack-sig-block', (el) => !el.classList.contains('hidden'));
      if (blk) {
        const b2 = await page.locator('#ack-sig-pad').boundingBox();
        await page.mouse.move(b2.x + 40, b2.y + 60); await page.mouse.down();
        for (let j = 0; j < 10; j++) await page.mouse.move(b2.x + 40 + j * 12, b2.y + 60 + (j % 3) * 8);
        await page.mouse.up();
      }
      await page.click('#ack-confirm');
    }
    await page.waitForTimeout(900);
  }

  const doneSub = await page.$eval('#done-sub', (el) => el.textContent).catch(() => '');
  ok('offline sign-in reaches a thank-you screen', /saved on this device|recorded the moment/i.test(doneSub), doneSub.slice(0, 90));

  const queued = await page.evaluate(() => new Promise((resolve) => {
    const r = indexedDB.open('sl-kiosk', 1);
    r.onsuccess = () => { const db = r.result; const tx = db.transaction('pending', 'readonly');
      const all = tx.objectStore('pending').getAll(); all.onsuccess = () => resolve(all.result.length); };
    r.onerror = () => resolve(-1);
  }));
  ok('it is held in the device queue', queued === 1, `${queued} queued`);

  // connection back: it must sync exactly once
  blocking = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(4000);

  const login = await fetch(BASE + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'hankalfr@gmail.com', password: 'Testing123!' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const visits = await (await fetch(`${BASE}/api/admin/visits?limit=50`, { headers: { cookie } })).json();
  const rows = (visits.rows || visits).filter((v) => v.full_name === NAME);
  ok('it syncs to the server exactly once', rows.length === 1, `${rows.length} visits`);

  const left = await page.evaluate(() => new Promise((resolve) => {
    const r = indexedDB.open('sl-kiosk', 1);
    r.onsuccess = () => { const db = r.result; const tx = db.transaction('pending', 'readonly');
      const all = tx.objectStore('pending').getAll(); all.onsuccess = () => resolve(all.result.length); };
    r.onerror = () => resolve(-1);
  }));
  ok('the queue empties after syncing', left === 0, `${left} left`);

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
