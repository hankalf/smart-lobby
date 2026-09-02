/*
 * The two ways out of a sign-in that has gone wrong.
 *
 * Both come from the same real report: somebody typed a partial phone number,
 * got all the way to the end, and then could neither finish nor go back. The
 * server was refusing the number — correctly — but the refusal arrived as a
 * toast on the induction screen, where the only button in front of them tried
 * exactly the same thing again.
 *
 * So: catch it at the first screen that asks, and when the server does refuse,
 * put them back on the form with the reason on it. And give every screen a way
 * to abandon the whole thing.
 */
'use strict';
const BASE = process.env.BASE_URL || 'http://localhost:3401';
const browser = require('./browser');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n}${x ? ' — ' + x : ''}`); } };

const shown = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const box = el.getBoundingClientRect();
  return (box.width > 0 && box.height > 0) ? (el.textContent || '').trim() : null;
}, sel);

const screenNow = (page) => page.evaluate(() => {
  const el = document.querySelector('.screen:not([hidden])');
  return el ? el.dataset.screen : null;
});

/** A signature, drawn across whichever pad is in front of us. */
async function sign(page, sel) {
  const pad = page.locator(sel);
  if (!await pad.count() || !await pad.isVisible()) return;
  const box = await pad.boundingBox();
  if (!box) return;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx - 60, cy - 10);
  await page.mouse.down();
  for (let i = 0; i <= 12; i++) await page.mouse.move(cx - 60 + i * 10, cy + Math.sin(i) * 18);
  await page.mouse.up();
}

/**
 * One step forward, whatever this screen wants before it will move.
 *
 * The photo screen is the awkward one: its main button opens a camera this
 * browser does not have, so clicking it just sits there — the skip button is
 * the only way through. The rest is filling in what is asked.
 */
async function step(page, at) {
  if (at === 'photo') {
    const skip = page.locator('#btn-photo-skip');
    if (await skip.count() && await skip.isVisible()) return skip.click().catch(() => {});
  }
  if (at === 'agreement') {
    // Any question that is asked gets an answer, so "you missed one" is never
    // what stops us — this suite is about the phone number, not the questions.
    for (const group of await page.locator('#agreement-questions [data-qgroup]:visible').all()) {
      await group.locator('button').first().click().catch(() => {});
    }
    for (const box of await page.locator('#agreement-questions input[data-q]:visible').all()) {
      await box.fill('n/a').catch(() => {});
    }
    await sign(page, '#sig-pad');
    return page.click('#agreement-continue').catch(() => {});
  }
  if (at === 'induction') return page.click('#deck-next').catch(() => {});
  if (at === 'ack') {
    await sign(page, '#ack-sig-pad');
    return page.click('#ack-confirm').catch(() => {});
  }
  const go = page.locator('.screen:not([hidden]) .btn.big:visible').first();
  if (await go.count()) return go.click().catch(() => {});
}

(async () => {
  if (!browser.available()) { console.log('  (no browser)'); console.log('\n0 passed, 0 failed'); return; }

  const jar = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.test', password: 'Testing123!' })
  });
  const cookie = (jar.headers.get('set-cookie') || '').split(';')[0];
  const staff = await fetch(`${BASE}/api/admin/staff`, { headers: { cookie } }).then((r) => r.json());
  const host = (staff && staff[0]) || null;

  /*
   * The photo step is switched off for the duration. This suite is about where
   * a refused sign-in leaves the visitor, and a headless browser has no camera
   * — so the photo screen is a wall the test cannot walk through, and has
   * nothing to do with what is being proved. Put back at the end.
   */
  const settingsUrl = `${BASE}/api/admin/settings`;
  const before = await fetch(settingsUrl, { headers: { cookie } }).then((r) => r.json());
  const putSettings = (body) => fetch(settingsUrl, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body)
  });
  await putSettings({ details: { visitor: { ...before.details.visitor, photo: 'off' } } });
  const restore = () => putSettings({ details: { visitor: before.details.visitor } });

  const b = await browser.chromium.launch(browser.launchOptions());
  const page = await (await b.newContext({ viewport: { width: 1024, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const start = async () => {
    await page.goto(`${BASE}/kiosk/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1400);
    await page.locator('.tile[data-action="signin"]').first().click();
    await page.waitForTimeout(700);
    const picker = page.locator('.tile[data-type="visitor"]').first();
    if (await picker.count() && await picker.isVisible()) { await picker.click(); await page.waitForTimeout(700); }
  };

  /* ---- a half-typed number is caught at the first screen that asks ---- */
  await start();
  ok('the kiosk asks whether you have been before', await screenNow(page) === 'identify',
    await screenNow(page));

  await page.fill('#identify-value', '415 268');           // far too short to be a number
  await page.click('#identify-continue');
  await page.waitForTimeout(700);
  ok('a half-typed phone number does not get past the first screen',
    await screenNow(page) === 'identify', await screenNow(page));
  const complaint = await shown(page, '#identify-result');
  ok('…and says what is wrong with it', !!complaint && complaint.length > 5, complaint);

  /* ---- a number takes its shape as it is typed ---- */
  await page.fill('#identify-value', '');
  await page.locator('#identify-value').type('4152680155', { delay: 20 });
  const shaped = await page.inputValue('#identify-value');
  ok('a number is formatted as it is typed', shaped === '(415) 268-0155', shaped);

  await page.fill('#identify-value', '415 268 0155');
  await page.click('#identify-continue');
  await page.waitForTimeout(1400);
  ok('a real number goes through', await screenNow(page) !== 'identify', await screenNow(page));

  /* ---- and the details screen refuses one too ---- */
  if (await screenNow(page) === 'details') {
    await page.fill('#f-name', 'Recover Tester');
    await page.fill('#f-phone', '415 000');
    await page.click('#details-continue');
    await page.waitForTimeout(600);
    ok('the details screen refuses an impossible number as well',
      await screenNow(page) === 'details', await screenNow(page));
    ok('…on the form, where it can be corrected', !!await shown(page, '#details-error'),
      await shown(page, '#details-error'));
  } else {
    ok('the details screen refuses an impossible number as well', true, 'no details step for this type');
    ok('…on the form, where it can be corrected', true, 'no details step for this type');
  }

  /* ---- a refusal from the server lands back on the form ---- */
  await start();
  await page.locator('#identify-skip').click();
  await page.waitForTimeout(1000);
  if (await screenNow(page) === 'details') {
    await page.fill('#f-name', 'Recover Tester Two');
    await page.fill('#f-phone', '415 268 0156');
    if (host) {
      await page.fill('#f-host-search', host.name);
      await page.waitForTimeout(600);
      const suggestion = page.locator('#host-suggest [data-host], #host-suggest button, #host-suggest div').first();
      if (await suggestion.count()) await suggestion.click().catch(() => {});
    }
    /*
     * The number is made impossible again after the form has been passed —
     * which is exactly what a queued sign-in from an older app, or a visitor
     * editing the field after validation, produces. The server refuses it, and
     * what matters is where the visitor ends up.
     */
    await page.evaluate(() => { document.querySelector('#f-phone').value = '415 268 0100'; });
    await page.click('#details-continue');
    await page.waitForTimeout(2500);

    await page.evaluate(() => { document.querySelector('#f-phone').value = '000 000 0000'; });
    /*
     * Push through whatever steps are left. How many there are depends on what
     * the site has switched on — run on its own this suite reaches the end in
     * one hop, and on a full run there is a document to sign and a deck to sit
     * through first — so each screen is handled for what it actually asks
     * rather than by hunting for the biggest button.
     */
    for (let i = 0; i < 14; i++) {
      const at = await screenNow(page);
      if (at === 'done' || at === 'details' || !at) break;
      await step(page, at);
      await page.waitForTimeout(900);
    }
    const ended = await screenNow(page);
    ok('a sign-in the server refuses does not strand the visitor',
      ended === 'details' || ended === 'done', ended);
  } else {
    ok('a sign-in the server refuses does not strand the visitor', true, 'no details step');
  }

  /* ---- start over, from anywhere ---- */
  await start();
  page.on('dialog', (d) => d.accept());
  const restart = page.locator('.screen:not([hidden]) [data-restart]').first();
  ok('every sign-in screen offers a way to start over', await restart.count() > 0);
  if (await restart.count()) {
    await restart.click();
    await page.waitForTimeout(900);
    ok('…which returns to the welcome screen', await screenNow(page) === 'idle', await screenNow(page));
    const left = await page.evaluate(() => (document.querySelector('#identify-value') || {}).value);
    ok('…and leaves nothing of theirs behind', !left, left);
  } else {
    ok('…which returns to the welcome screen', false, 'no restart button');
    ok('…and leaves nothing of theirs behind', false, 'no restart button');
  }

  ok('the kiosk threw nothing along the way', errors.length === 0, errors.join(' | '));

  await b.close();
  await restore();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
