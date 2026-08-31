/*
 * The device check page, which is the page people are sent to when something
 * on a tablet does not work.
 *
 * It is tested in a browser and not by reading its HTML, because the way it
 * broke was invisible to anything else: the site sends
 * Content-Security-Policy with script-src 'self', which blocks inline script,
 * and the page carried its entire body of checks inline. It served a 200, it
 * looked right in a diff, it rendered its headings and buttons — and it ran
 * nothing. Every guide had been sending people to a page that could not
 * answer a single question it asked.
 *
 * So the check that matters is not "does the page load" but "did its script
 * actually get to run", which is only visible as results on the screen.
 */
'use strict';
const BASE = process.env.BASE_URL || 'http://localhost:3401';
const browser = require('./browser');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n}${x ? ' — ' + x : ''}`); } };

(async () => {
  if (!browser.available()) { console.log('  (no browser)'); console.log('\n0 passed, 0 failed'); return; }

  const b = await browser.chromium.launch(browser.launchOptions());
  const page = await (await b.newContext({ viewport: { width: 820, height: 1100 } })).newPage();

  const errors = [];
  const blocked = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy/i.test(m.text())) blocked.push(m.text().slice(0, 120));
  });

  await page.goto(`${BASE}/check/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  /* ---- the script ran at all ---- */
  const rows = await page.locator('#results .row').count();
  ok('the page reports what it found, rather than an empty box', rows >= 5, `${rows} rows`);
  ok('…and nothing of its own was refused by the content security policy',
    blocked.length === 0, blocked.join(' | '));
  ok('it says what browser it is looking at',
    (await page.textContent('#ua') || '').length > 20);

  /* ---- reaching the server, the test a tablet on a printer's wifi needs ---- */
  await page.click('#test-reach');
  await page.waitForFunction(() => !/Not checked|Asking/.test(document.querySelector('#reach-note').textContent),
    null, { timeout: 10000 }).catch(() => {});
  const reach = await page.textContent('#reach-note');
  ok('it can ask the server whether it is reachable', /Reached the server/.test(reach), reach.slice(0, 90));

  /* ---- a test badge, at the size the site is actually set up for ---- */
  await page.evaluate(() => {
    // No printer in here, and window.print() would block on the dialog.
    window.__print = { calls: 0 };
    window.print = () => {
      const sheet = document.getElementById('badge-sheet');
      window.__print.calls++;
      window.__print.armed = !sheet.hidden && sheet.hasAttribute('data-printing');
      window.__print.size = getComputedStyle(document.documentElement).getPropertyValue('--badge-w').trim();
    };
  });
  await page.click('#test-badge');
  await page.waitForFunction(() => window.__print.calls > 0, null, { timeout: 10000 }).catch(() => {});
  const printed = await page.evaluate(() => window.__print);

  ok('pressing “print a test badge” reaches the print dialog', printed.calls === 1, JSON.stringify(printed));
  ok('…with the badge on the page when it does', printed.armed === true, JSON.stringify(printed));
  ok('…at the label size this site is configured for, not a default',
    printed.size === '62mm', printed.size);

  const qr = await page.evaluate(() => {
    const img = document.querySelector('.badge-qr img');
    return !!(img && img.complete && img.naturalWidth > 0);
  });
  ok('the badge carries a QR code that actually loaded', qr);

  /*
   * The page has to come back afterwards. A dialog that is cancelled leaves no
   * event to listen for, so the sheet is put away on a timer — and a check page
   * that is stuck showing a badge is no use to the person holding the tablet.
   */
  await page.waitForTimeout(900);
  ok('the page comes back afterwards, printed or cancelled',
    await page.evaluate(() => document.getElementById('badge-sheet').hidden));

  ok('nothing threw along the way', errors.length === 0, errors.join(' | '));

  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
