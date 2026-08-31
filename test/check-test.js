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

  /*
   * The page's own dead-man's switch. The notice is in the HTML and the script
   * removes it, so its absence is the proof the script ran — and its presence,
   * on a page where the script was blocked, is what tells the person holding
   * the tablet that the buttons are not going to work.
   */
  ok('the “these checks did not run” notice is cleared once they have',
    await page.evaluate(() => !document.getElementById('did-not-run')));

  /* ---- which build is answering ---- */
  await page.waitForFunction(() => !/Checking/.test(document.querySelector('#build-note').textContent),
    null, { timeout: 8000 }).catch(() => {});
  const build = await page.textContent('#build-note');
  ok('it says which build the server is running', /running since/i.test(build), build.slice(0, 90));

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

      /*
       * The rulers are measured here and nowhere else: this is the one instant
       * the badge is actually on the page, and it is the state that goes to
       * the printer. Measured after the sheet is put away, everything is zero.
       */
      const toMm = (px) => (px / 96) * 25.4;
      const span = (sel) => {
        const ticks = [...document.querySelectorAll(`${sel} i`)];
        if (ticks.length < 2) return null;
        return toMm(ticks[ticks.length - 1].getBoundingClientRect().left
          - ticks[0].getBoundingClientRect().left);
      };
      const card = document.querySelector('.badge-card').getBoundingClientRect();
      const inch = document.querySelector('.ruler.inch').getBoundingClientRect();
      window.__print.rules = {
        mm: span('.ruler.mm'), inch: span('.ruler.inch'), overflows: inch.right > card.right + 0.5
      };
    };
  });
  /*
   * Driven under print media, because that is the only place the badge is laid
   * out at all — on screen the sheet stays display:none, and measuring it
   * there returns zeroes for everything. It is also the honest place to
   * measure: print media is what the printer is handed.
   *
   * Clicked through the DOM rather than by a real click, since under print
   * media the button itself is hidden.
   */
  await page.emulateMedia({ media: 'print' });
  await page.evaluate(() => document.getElementById('test-badge').click());
  await page.waitForFunction(() => window.__print.calls > 0, null, { timeout: 10000 }).catch(() => {});
  const printed = await page.evaluate(() => window.__print);
  await page.emulateMedia({ media: null });

  ok('pressing “print a test badge” reaches the print dialog', printed.calls === 1, JSON.stringify(printed));
  ok('…with the badge on the page when it does', printed.armed === true, JSON.stringify(printed));
  ok('…at the label size this site is configured for, not a default',
    printed.size === '62mm', printed.size);

  /*
   * The rulers are the instrument the whole test rests on: somebody holds a
   * tape against the printed label and concludes from it whether the printer
   * is scaling. A rule that is itself 3% out sends them to change settings on
   * a printer that was doing nothing wrong, so its accuracy is worth pinning
   * to a tenth of a millimetre.
   *
   * Measured between the first line and the last, which is how a person
   * measures it — not by the element's box, which includes borders it should
   * not be judged on.
   */
  const rules = printed.rules || {};

  ok('the 50 mm rule on the test badge really is 50 mm',
    rules.mm !== null && Math.abs(rules.mm - 50) < 0.2, `${(rules.mm || 0).toFixed(2)} mm`);
  ok('the 2 inch rule on the test badge really is 2 inches',
    rules.inch !== null && Math.abs(rules.inch - 50.8) < 0.2, `${(rules.inch || 0).toFixed(2)} mm`);
  ok('…and both fit on the label rather than being squeezed to it', !rules.overflows);

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

  /* ---- the alignment page, and the arithmetic it saves you ---- */

  await page.emulateMedia({ media: 'print' });
  await page.evaluate(() => {
    window.__align = { calls: 0 };
    window.print = () => {
      const sheet = document.getElementById('align-sheet');
      window.__align.calls++;
      window.__align.armed = !sheet.hidden && sheet.hasAttribute('data-printing');
      const card = document.querySelector('.align-card').getBoundingClientRect();
      const ticks = [...document.querySelectorAll('.align-across s')];
      const down = [...document.querySelectorAll('.align-down s')];
      const toMm = (px) => (px / 96) * 25.4;
      window.__align.acrossSpan = ticks.length
        ? toMm(ticks[ticks.length - 1].getBoundingClientRect().left - card.left) : 0;
      window.__align.downSpan = down.length
        ? toMm(down[down.length - 1].getBoundingClientRect().top - card.top) : 0;
      // The badge sheet must not come along for the ride.
      window.__align.badgeHidden = !document.getElementById('badge-sheet').hasAttribute('data-printing');
    };
  });
  await page.evaluate(() => document.getElementById('print-align').click());
  await page.waitForFunction(() => window.__align.calls > 0, null, { timeout: 10000 }).catch(() => {});
  const align = await page.evaluate(() => window.__align);
  await page.emulateMedia({ media: null });

  ok('an alignment page can be printed', align.calls === 1, JSON.stringify(align));
  ok('…with only the alignment page on it, not the test badge', align.badgeHidden === true);
  /*
   * The scale has to run the full width of the label it claims to measure. One
   * that stopped short would read as an unprintable margin that is not there,
   * and send somebody to pad a badge that already fitted.
   */
  ok('…and its scale runs the full label, so a missing mark means a real margin',
    Math.abs(align.acrossSpan - 62) < 0.5, `${(align.acrossSpan || 0).toFixed(1)} mm of 62`);
  ok('…in both directions', Math.abs(align.downSpan - 100) < 0.5,
    `${(align.downSpan || 0).toFixed(1)} mm of 100`);

  await page.fill('#align-across', '56');
  await page.fill('#align-down', '94');
  await page.click('#align-apply');
  await page.waitForTimeout(300);
  const advice = (await page.textContent('#align-note')).replace(/\s+/g, ' ');
  ok('reading two numbers off it gives the margins to set',
    /3 mm.*left and right/.test(advice) && /3 mm.*top and bottom/.test(advice), advice.slice(0, 130));

  /* A label the printer can reach all of needs no correction, and should say so. */
  await page.fill('#align-across', '62');
  await page.fill('#align-down', '100');
  await page.click('#align-apply');
  await page.waitForTimeout(300);
  ok('…and says plainly when there is nothing to correct',
    /whole label is printable/i.test(await page.textContent('#align-note')));

  ok('nothing threw along the way', errors.length === 0, errors.join(' | '));

  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
