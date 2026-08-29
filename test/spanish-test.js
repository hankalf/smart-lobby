'use strict';
const { chromium, launchOptions } = require('./browser');
const BASE = process.env.BASE_URL || 'http://localhost:3401';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n}${x ? ' — ' + x : ''}`); } };

(async () => {
  const browser = await chromium.launch({ ...launchOptions(), args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const page = await (await browser.newContext({ viewport: { width: 1024, height: 1366 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(`${BASE}/kiosk/front-gate`);
  await page.waitForSelector('body.cfg-ready', { timeout: 10000 });

  // On the home screen the bar naming both languages is what is shown; the
  // pill appears on later screens instead.
  const langBtn = await page.$('.lang-bar button[data-lang="es"]');
  const barVisible = langBtn ? await langBtn.isVisible() : false;
  ok('the English/Español bar is on the home screen', barVisible);
  if (barVisible) {
    const before = await page.$eval('body', (el) => el.innerText);
    await langBtn.click();
    await page.waitForTimeout(900);
    const after = await page.$eval('body', (el) => el.innerText);
    ok('switching language changes the wording', before !== after);

    const startVisible = await page.$eval('#start-btn', (el) => !el.hidden && !!el.offsetParent).catch(() => false);
    if (startVisible) await page.click('#start-btn');
    await page.waitForFunction(() => document.querySelectorAll('#menu-tiles [data-action], #welcome-actions [data-action]').length > 0);
    await page.click('[data-action="contractor"]');
    await page.waitForSelector('[data-screen="identify"]:not([hidden])');
    const idText = await page.$eval('[data-screen="identify"]', (el) => el.innerText);
    ok('the sign-in flow continues in Spanish', /[¿¡áéíóúñ]|Continuar|Volver|nuevo/i.test(idText), idText.slice(0, 100));
    const pill = await page.$('#lang-toggle');
    ok('the language pill appears once past the home screen', pill && await pill.isVisible());

    await page.click('#identify-skip');
    await page.waitForSelector('[data-screen="details"]:not([hidden])');
    const detText = await page.$eval('[data-screen="details"]', (el) => el.innerText);
    ok('the details form is translated', /Nombre|Empresa|Teléfono|Proyecto/i.test(detText), detText.slice(0, 100));

    // an English-only deck must still play rather than blocking a Spanish visitor
    await page.fill('#f-name', 'Prueba Español');
    await page.fill('#f-company', 'Constructora');
    await page.fill('#f-phone', '415-268-0444');
    const projVisible = await page.$eval('#f-project', (el) => !!el.closest('label')).catch(() => false);
    if (projVisible) await page.selectOption('#f-project', { index: 1 }).catch(() => {});
    await page.click('#details-continue');
    let reached = null;
    for (let i = 0; i < 12; i++) {
      const scr = await page.$eval('.screen:not([hidden])', (el) => el.dataset.screen).catch(() => null);
      if (scr === 'induction' || scr === 'done') { reached = scr; break; }
      if (scr === 'photo') { await page.waitForTimeout(1200); await page.click('#btn-capture');
        await page.waitForTimeout(1200); await page.click('#btn-photo-continue'); }
      else if (scr === 'agreement') {
        const box = await page.locator('#sig-pad').boundingBox();
        await page.mouse.move(box.x + 40, box.y + 60); await page.mouse.down();
        for (let j = 0; j < 10; j++) await page.mouse.move(box.x + 40 + j * 12, box.y + 60 + (j % 3) * 8);
        await page.mouse.up(); await page.click('#agreement-continue');
      }
      await page.waitForTimeout(900);
    }
    ok('an English-only deck still plays for a Spanish visitor', reached === 'induction' || reached === 'done', String(reached));
  }
  ok('no page errors in Spanish', errors.length === 0, JSON.stringify(errors));
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
