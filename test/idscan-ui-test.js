/* The licence widget only appears when the toggle is on, and it feeds the sign-in. */
'use strict';
const { chromium, launchOptions } = require('./browser');
const BASE = process.env.BASE_URL || 'http://localhost:3401';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n}${x ? ' — ' + x : ''}`); } };

async function api(path, body, method = 'POST', cookie = '') {
  const res = await fetch(BASE + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie }, body: body ? JSON.stringify(body) : undefined });
  return { headers: res.headers, data: await res.json().catch(() => null) };
}

(async () => {
  const login = await api('/api/admin/login', { email: 'hankalfr@gmail.com', password: 'Testing123!' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const setScan = async (mode) => {
    const s = (await api('/api/admin/settings', null, 'GET', cookie)).data;
    s.details.contractor.id_scan = mode;
    await api('/api/admin/settings', { details: s.details }, 'PUT', cookie);
  };

  const browser = await chromium.launch({ ...launchOptions(), args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });

  const openDetails = async (page) => {
    await page.goto(`${BASE}/kiosk/front-gate`);
    await page.waitForSelector('body.cfg-ready', { timeout: 10000 });
    const start = await page.$eval('#start-btn', (el) => !el.hidden && !!el.offsetParent).catch(() => false);
    if (start) await page.click('#start-btn');
    await page.waitForFunction(() => document.querySelectorAll('#menu-tiles [data-action], #welcome-actions [data-action]').length > 0);
    await page.click('[data-action="contractor"]');
    await page.waitForSelector('[data-screen="identify"]:not([hidden])');
    await page.click('#identify-skip');
    await page.waitForSelector('[data-screen="details"]:not([hidden])');
  };

  /* ---- off: no widget at all ---- */
  await setScan('off');
  let page = await (await browser.newContext({ viewport: { width: 1024, height: 1366 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openDetails(page);
  ok('with the scan off the licence field is hidden',
    await page.$eval('#w-id-scan', (el) => el.hidden || !el.offsetParent));
  await page.close();

  /* ---- optional: widget shown, sign-in allowed without scanning ---- */
  await setScan('optional');
  page = await (await browser.newContext({ viewport: { width: 1024, height: 1366 } })).newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await openDetails(page);
  ok('with the scan on the licence field appears', await page.$eval('#w-id-scan', (el) => !!el.offsetParent));
  ok('the scan button is offered', await page.$eval('#id-scan-open', (el) => !!el.offsetParent));
  ok('the camera is not running until the button is pressed',
    await page.$eval('#id-scan-cam-wrap', (el) => el.classList.contains('hidden')));
  ok('the heavy decoder has not been fetched yet',
    await page.evaluate(() => typeof window.ZXing === 'undefined'));

  // Pressing it must open the camera and load the decoder, without errors.
  await page.click('#id-scan-open');
  await page.waitForTimeout(3500);
  ok('pressing scan loads the decoder', await page.evaluate(() => typeof window.ZXing === 'object'));
  const camShown = await page.$eval('#id-scan-cam-wrap', (el) => !el.classList.contains('hidden'));
  const status = await page.$eval('#id-scan-status', (el) => el.textContent);
  ok('the camera preview opens (or says why not)', camShown || status.length > 5, `cam=${camShown} status=${status}`);
  await page.click('#id-scan-cancel');
  ok('cancel puts the button back', await page.$eval('#id-scan-open', (el) => !!el.offsetParent));

  /* ---- required: the flow refuses to continue without a scan ---- */
  await setScan('required');
  const p2 = await (await browser.newContext({ viewport: { width: 1024, height: 1366 } })).newPage();
  p2.on('pageerror', (e) => errors.push(e.message));
  await openDetails(p2);
  await p2.fill('#f-name', 'Needs Licence');
  await p2.fill('#f-company', 'Haulage');
  await p2.fill('#f-phone', '415-268-0400');
  const proj = await p2.$('#f-project');
  if (proj) await p2.selectOption('#f-project', { index: 1 }).catch(() => {});
  await p2.click('#details-continue');
  await p2.waitForTimeout(600);
  const stillDetails = await p2.$eval('.screen:not([hidden])', (el) => el.dataset.screen);
  const err = await p2.$eval('#details-error', (el) => el.textContent);
  ok('required stops the flow until a licence is scanned', stillDetails === 'details' && /licen/i.test(err),
    `${stillDetails} / ${err}`);

  ok('no page errors anywhere', errors.length === 0, JSON.stringify(errors));
  await setScan('off');
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
