/*
 * Every page in the admin, opened, with the console watched.
 *
 * The other browser suites each know one page well. None of them notices when
 * a page nobody happened to write a test for stops loading — and the admin is
 * nearly eight thousand lines of one file, where a rename in one corner takes
 * out a corner nobody looked at. This suite does not know what any page is for.
 * It opens all of them, every settings panel too, and fails on a script error
 * or on a page that comes up empty.
 *
 * That makes it the net under any large rearrangement of the admin: a
 * refactor that breaks a page it never touched is caught here rather than by
 * somebody on a Monday morning who needed that page.
 *
 * The list is read from the menu rather than written down, so a page added
 * later is swept without anybody remembering to add it.
 */
'use strict';
const { chromium, launchOptions } = require('./browser');
const BASE = process.env.BASE_URL || 'http://localhost:3401';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n}${x ? ' — ' + x : ''}`); } };

(async () => {
  const browser = await chromium.launch({ ...launchOptions() });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  /* Errors are collected per page, so a failure names the page that caused it. */
  let here = 'the login screen';
  const trouble = [];
  const note = (what) => trouble.push(`${here}: ${what}`);
  page.on('pageerror', (e) => note(String(e.message || e)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const url = m.location().url || '';
    // A missing favicon is a long-standing cosmetic 404, and map tiles are
    // fetched from outside, which a test machine cannot reach.
    if (url.endsWith('/favicon.ico') || /\/tiles\//.test(url)) return;
    note(m.text());
  });
  page.on('requestfailed', (r) => {
    const url = r.url();
    if (/favicon\.ico|\/tiles\//.test(url)) return;
    note(`request failed: ${url}`);
  });

  await page.goto(BASE + '/admin/');
  await page.fill('#gate-email', 'owner@example.test');
  await page.fill('#gate-pass', 'Testing123!');
  await page.click('#gate-submit');
  await page.waitForSelector('#shell:not(.hidden)', { timeout: 10000 });
  ok('the admin loads at all', trouble.length === 0, trouble.join(' | '));

  /* The menu is the list of pages. Headings are opened to reach what is under them. */
  const menu = await page.evaluate(() => {
    const out = [];
    for (const b of document.querySelectorAll('#nav > button[data-view], #nav .subnav button')) {
      const sub = b.closest('.subnav');
      out.push({
        view: b.dataset.view || null,
        section: b.dataset.section || null,
        label: b.textContent.trim(),
        parent: sub ? sub.dataset.for : null
      });
    }
    return out;
  });
  ok('the menu offers every page to sweep', menu.length >= 25, `${menu.length} entries`);

  const open = async (entry) => {
    if (entry.parent) await page.click(`#nav > button[data-view="${entry.parent}"]`);
    const sel = entry.view
      ? `#nav [data-view="${entry.view}"]`
      : `#nav [data-section="${entry.section}"]`;
    await page.click(sel);
  };

  let swept = 0, empty = [];
  for (const entry of menu) {
    // A heading with no page of its own opens its first entry, which is
    // swept in its own right — nothing to do here.
    if (!entry.view && !entry.section) continue;
    here = entry.label;
    const before = trouble.length;
    await open(entry).catch((e) => note(`could not be opened — ${e.message}`));
    await page.waitForTimeout(500);

    /*
     * "Loading…" is what #view holds while a page is being built. Still
     * showing it half a second later means the page threw on the way up, and
     * a page that renders nothing at all is the same failure wearing a
     * different face.
     */
    const state = await page.evaluate(() => {
      const v = document.querySelector('#view');
      const shown = [...document.querySelectorAll('#view [data-panel]')].filter((p) => !p.hidden);
      return {
        text: (v ? v.textContent : '').trim().slice(0, 60),
        len: v ? v.innerHTML.length : 0,
        panels: shown.length
      };
    });
    if (/^Loading…$/.test(state.text) || /^Could not load/.test(state.text) || state.len < 40) {
      empty.push(`${entry.label} (${state.text || 'nothing'})`);
    }
    if (trouble.length === before) swept++;
  }

  ok('every page in the menu comes up', empty.length === 0, empty.join(', '));
  ok('…and none of them puts an error in the console',
    trouble.length === 0, trouble.slice(0, 6).join(' | '));
  ok(`…${swept} pages swept clean`, swept >= 25, String(swept));

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e.message); process.exit(1); });
