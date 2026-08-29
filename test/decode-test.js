/*
 * The real decode path: the vendored ZXing build reading an actual PDF417
 * barcode, and the parser turning it into the three fields. Proves the whole
 * chain apart from the camera itself.
 */
'use strict';
const fs = require('fs');
const { chromium, launchOptions } = require('./browser');
const S = '/tmp/claude-0/-home-user-smart-lobby/ce73f715-d1b5-5b56-8f24-3e3b2af8ba29/scratchpad';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n}${x ? ' — ' + x : ''}`); } };

(async () => {
  const browser = await chromium.launch({ ...launchOptions(), });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // Load the kiosk so the vendored files are served exactly as the iPad gets them.
  await page.goto(`${process.env.BASE_URL || 'http://localhost:3401'}/kiosk/`);
  await page.waitForSelector('body.cfg-ready', { timeout: 10000 });

  ok('the AAMVA parser is loaded with the page', await page.evaluate(() => typeof window.AAMVA === 'object'));
  ok('the PDF417 decoder is NOT loaded until needed',
    await page.evaluate(() => typeof window.ZXing === 'undefined'));

  // Fetch the decoder the way the scan button does.
  await page.evaluate(() => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/zxing.min.js';
    s.onload = resolve; s.onerror = () => reject(new Error('load failed'));
    document.head.appendChild(s);
  }));
  ok('the vendored decoder loads from the kiosk', await page.evaluate(() => typeof window.ZXing === 'object'));
  ok('it exposes a PDF417 reader', await page.evaluate(() => typeof window.ZXing.PDF417Reader === 'function'));

  const b64 = fs.readFileSync(`${S}/licence.png`).toString('base64');
  const result = await page.evaluate(async (data) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + data; });
    const canvas = document.createElement('canvas');
    canvas.width = img.width; canvas.height = img.height;
    canvas.getContext('2d').drawImage(img, 0, 0);
    try {
      const Z = window.ZXing;
      const reader = new Z.PDF417Reader();
      const bitmap = new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(canvas)));
      const text = reader.decode(bitmap).getText();
      return { decoded: true, parsed: window.AAMVA.parse(text) };
    } catch (e) {
      return { decoded: false, error: String(e && e.message || e) };
    }
  }, b64);

  ok('a real PDF417 licence barcode decodes', result.decoded, JSON.stringify(result).slice(0, 140));
  if (result.decoded) {
    const p = result.parsed;
    ok('it parses as a licence', p.ok, JSON.stringify(p));
    ok('the name comes out right', p.name === 'John Smith', p.name);
    ok('the licence number comes out right', p.number === '12345678', p.number);
    ok('the issuing state comes out right', p.state === 'TX', p.state);
    ok('nothing else is returned — no DOB, no address',
      Object.keys(p).sort().join(',') === 'name,number,ok,state', Object.keys(p).join(','));
  }

  ok('no page errors', errors.length === 0, JSON.stringify(errors));
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
