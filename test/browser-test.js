/* Kiosk browser test: device page, card filter, contractor flow with deck signature. */
'use strict';
const { chromium, launchOptions } = require('./browser');

const BASE = process.env.BASE_URL || 'http://localhost:3401';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};

// Count non-transparent pixels on a canvas — flow clicks alone proved nothing before.
const inkPixels = (page, sel) => page.$eval(sel, (c) => {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
  return n;
});

async function drawOn(page, sel) {
  const box = await page.locator(sel).boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx - 60, cy - 10);
  await page.mouse.down();
  for (let i = 0; i <= 12; i++) await page.mouse.move(cx - 60 + i * 10, cy + Math.sin(i) * 18);
  await page.mouse.up();
}

/*
 * api-test leaves the deck with its signature switched off, so this suite turns
 * it back on rather than depending on whatever ran last.
 */
async function armDeckSignature() {
  const login = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'hankalfr@gmail.com', password: 'Testing123!' })
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const body = await fetch(`${BASE}/api/admin/slideshows`, { headers: { cookie } }).then((r) => r.json());
  const decks = Array.isArray(body) ? body : body.rows || [];
  if (!decks.length) return ok('a deck exists to sign', false);
  await fetch(`${BASE}/api/admin/slideshows/${decks[0].id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ require_signature: true })
  });
}

(async () => {
  await armDeckSignature();
  const browser = await chromium.launch({ ...launchOptions(),
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
  });
  const page = await (await browser.newContext({ viewport: { width: 1024, height: 1366 } })).newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));

  /* ---- device page shows only its cards ---- */
  await page.goto(`${BASE}/kiosk/front-gate`);
  await page.waitForSelector('body.cfg-ready', { timeout: 10000 });
  await page.waitForFunction(() => {
    const s = document.querySelector('#start-btn');
    const w = document.querySelector('#welcome-actions');
    return (s && !s.hidden && s.offsetParent) || (w && w.children.length);
  });
  // enter the menu whichever welcome mode is on
  const startVisible = await page.$eval('#start-btn', (el) => !el.hidden && !!el.offsetParent).catch(() => false);
  if (startVisible) await page.click('#start-btn');
  await page.waitForFunction(() => {
    const m = document.querySelector('#menu-tiles');
    const w = document.querySelector('#welcome-actions');
    return (m && m.children.length) || (w && w.children.length);
  });
  const actions = await page.$$eval('#menu-tiles [data-action], #welcome-actions [data-action]',
    (els) => [...new Set(els.map((e) => e.dataset.action))]);
  ok('device page shows only its two cards', actions.length === 2 && actions.includes('contractor') && actions.includes('signout'),
    JSON.stringify(actions));
  ok('address bar stays on device page', page.url().endsWith('/kiosk/front-gate'), page.url());
  const manifest = await page.$eval('link[rel="manifest"]', (l) => l.getAttribute('href')).catch(() => null);
  ok('manifest link points at device manifest', manifest === '/kiosk/front-gate/manifest.webmanifest', String(manifest));
  const warnHidden = await page.$eval('#device-warning', (el) => el.classList.contains('hidden'));
  ok('no unknown-device warning on a good link', warnHidden);

  /* ---- unknown device page warns ---- */
  const p2 = await (await browser.newContext({ viewport: { width: 1024, height: 1366 } })).newPage();
  await p2.goto(`${BASE}/kiosk/no-such-tablet`);
  await p2.waitForSelector('body.cfg-ready', { timeout: 10000 });
  await p2.waitForFunction(() => !document.querySelector('#device-warning').classList.contains('hidden'), null, { timeout: 8000 })
    .then(() => ok('unknown device link shows a warning', true))
    .catch(async () => ok('unknown device link shows a warning', false, await p2.$eval('#device-warning', (e) => e.className)));
  await p2.close();

  /* ---- contractor flow through to the deck signature ---- */
  await page.click('[data-action="contractor"]');
  await page.waitForSelector('[data-screen="identify"]:not([hidden])');
  // new visitor: skip lookup
  await page.click('#identify-skip');
  await page.waitForSelector('[data-screen="details"]:not([hidden])');
  await page.fill('#f-name', 'Hank Alfred 20');
  await page.fill('#f-company', 'E2E Ltd');
  await page.fill('#f-phone', '415-268-0199');
  const projVisible = await page.$eval('#f-project', (el) => !!el.closest('label') && !el.closest('label').hidden).catch(() => false);
  if (projVisible) await page.selectOption('#f-project', { index: 1 }).catch(() => {});
  await page.click('#details-continue');

  // photo step: skip if offered
  await page.waitForFunction(() => {
    const scr = document.querySelector('.screen:not([hidden])');
    return scr && ['photo', 'agreement', 'induction'].includes(scr.dataset.screen);
  });
  let current = await page.$eval('.screen:not([hidden])', (el) => el.dataset.screen);
  if (current === 'photo') {
    // the fake camera streams a test pattern; take the photo for real
    await page.waitForTimeout(1500);
    await page.click('#btn-capture');
    await page.waitForFunction(() => {
      const img = document.querySelector('.camera-wrap img');
      return img && img.src.startsWith('data:image') && img.offsetParent;
    }, null, { timeout: 8000 });
    ok('captured photo is shown for confirmation', true);
    await page.click('#btn-photo-continue');
    await page.waitForFunction(() => {
      const scr = document.querySelector('.screen:not([hidden])');
      return scr && ['agreement', 'induction'].includes(scr.dataset.screen);
    });
    current = await page.$eval('.screen:not([hidden])', (el) => el.dataset.screen);
  }

  if (current === 'agreement') {
    await drawOn(page, '#sig-pad');
    const docInk = await inkPixels(page, '#sig-pad');
    ok('document signature pad takes ink', docInk > 200, `${docInk}px`);
    await page.click('#agreement-continue');
    await page.waitForFunction(() => {
      const scr = document.querySelector('.screen:not([hidden])');
      return scr && scr.dataset.screen === 'induction';
    });
  }

  /* ---- the deck ---- */
  await page.waitForSelector('[data-screen="induction"]:not([hidden])');
  // one slide only; Next should land on the ack screen with the signature box
  await page.click('#deck-next');
  await page.waitForSelector('[data-screen="ack"]:not([hidden])');
  const sigShown = await page.$eval('#ack-sig-block', (el) => !el.classList.contains('hidden'));
  ok('ack screen shows the signature box for this deck', sigShown);

  // confirm without ink must be refused
  await page.click('#ack-confirm');
  await page.waitForTimeout(400);
  const stillAck = await page.$eval('.screen:not([hidden])', (el) => el.dataset.screen);
  ok('confirm without a signature is refused', stillAck === 'ack', stillAck);

  await drawOn(page, '#ack-sig-pad');
  const ackInk = await inkPixels(page, '#ack-sig-pad');
  ok('ack signature pad takes ink', ackInk > 200, `${ackInk}px`);
  await page.click('#ack-confirm');
  await page.waitForSelector('[data-screen="done"]:not([hidden])', { timeout: 10000 });
  ok('flow completes to done screen', true);

  /* ---- server has the induction signature ---- */
  const res = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'hankalfr@gmail.com', password: 'Testing123!' })
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const visits = await (await fetch(`${BASE}/api/admin/visits?limit=5`, { headers: { cookie } })).json();
  const rowsV = visits.rows || visits;
  const mine = rowsV.find((v) => v.full_name === 'Hank Alfred 20');
  ok('visit recorded for browser sign-in', !!mine, JSON.stringify(rowsV.slice(0, 2)));
  if (mine) {
    const detail = await (await fetch(`${BASE}/api/admin/visits/${mine.id}`, { headers: { cookie } })).json();
    const ind = detail.inductions && detail.inductions[0];
    ok('induction record carries the drawn signature', !!(ind && ind.signature_path), JSON.stringify(ind || null).slice(0, 140));
  }

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
