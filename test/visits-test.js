/*
 * The visits list used to stop at five hundred rows without saying so, which
 * reads as "that is all of them". This is about the list telling you how much
 * there is, handing you the rest a page at a time, and an export still being
 * the whole thing rather than the page you happen to be looking at.
 */
'use strict';
const BASE = process.env.BASE_URL || 'http://localhost:3401';
let cookie = '';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n}${x ? ' — ' + x : ''}`); } };

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie },
    body: body ? JSON.stringify(body) : undefined
  });
  const setc = res.headers.get('set-cookie'); if (setc) cookie = setc.split(';')[0];
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* csv */ }
  return { status: res.status, data, text, headers: res.headers };
}

(async () => {
  await req('POST', '/api/admin/login', { email: 'hankalfr@gmail.com', password: 'Testing123!' });

  /* ---- enough visits that one page is plainly not all of them ---- */
  /*
   * Sixty of them, because the smallest page the screen offers is fifty and a
   * pager that is never exercised is not a pager. They are deleted again at
   * the end so the suites after this one see the site they expect.
   */
  const MADE = 60;
  const stamp = Date.now();
  const hosts = (await req('GET', '/api/admin/staff')).data || [];
  const host = hosts[0]
    || (await req('POST', '/api/admin/staff', { name: 'Paging Host', email: 'paging@example.com', active: 1 })).data;
  ok('there is somebody to visit', !!(host && host.id), JSON.stringify(host).slice(0, 80));
  for (let i = 0; i < MADE; i++) {
    const r = await req('POST', '/api/kiosk/signin', {
      full_name: `Paging Person ${String(i + 1).padStart(2, '0')}`,
      phone: `415990${String(1000 + i)}`,
      company: 'Paging Test Ltd',
      visit_type: 'visitor',
      host_id: host && host.id,
      client_ref: `page-${stamp}-${i}`
    });
    if (r.status !== 200) { ok(`sign-in ${i + 1} works`, false, JSON.stringify(r.data)); break; }
  }
  const mine = 'Paging Test Ltd';

  /* ---- the count comes back, and it is the whole matching set ---- */
  let r = await req('GET', `/api/admin/visits?q=${encodeURIComponent(mine)}&limit=5`);
  ok('a page of visits comes back', r.status === 200 && Array.isArray(r.data), JSON.stringify(r.data).slice(0, 120));
  ok('…as a plain array, so older callers still work', Array.isArray(r.data));
  ok('…holding only the page asked for', r.data.length === 5, String(r.data.length));
  const total = Number(r.headers.get('X-Total-Count'));
  ok('…while the header says how many there really are', total === MADE, `${total} of ${MADE}`);
  ok('…and which slice this is', r.headers.get('X-Offset') === '0', r.headers.get('X-Offset'));

  /* ---- the pages join up, with nothing lost and nothing repeated ---- */
  const SIZE = 25;
  const page = async (offset) => (await req(
    'GET', `/api/admin/visits?q=${encodeURIComponent(mine)}&limit=${SIZE}&offset=${offset}`)).data;
  const p1 = await page(0), p2 = await page(SIZE), p3 = await page(SIZE * 2);
  ok('the second page is a different set', p2.length === SIZE && !p2.some((v) => p1.find((w) => w.id === v.id)),
    JSON.stringify(p2.map((v) => v.id)));
  ok('the last page holds the remainder', p3.length === MADE - SIZE * 2, String(p3.length));
  const seen = [...p1, ...p2, ...p3].map((v) => v.id);
  ok('every visit appears exactly once across the pages',
    new Set(seen).size === MADE, `${new Set(seen).size} distinct of ${seen.length}`);

  /* ---- the far end of the list is empty, not a repeat of the first ---- */
  ok('reading past the end gives nothing rather than page one',
    (await page(500)).length === 0);

  /* ---- silly values do not become silly queries ---- */
  const odd = async (q) => (await req('GET', `/api/admin/visits?q=${encodeURIComponent(mine)}&${q}`));
  ok('a negative offset is treated as the start',
    (await odd('limit=5&offset=-40')).data.length === 5);
  ok('a nonsense limit falls back to the default rather than emptying the list',
    (await odd('limit=abc')).data.length === MADE, String((await odd('limit=abc')).data.length));
  ok('an enormous limit is capped rather than handed to the database',
    (await odd('limit=999999')).status === 200);

  /* ---- an export is still everything, not the page on screen ---- */
  const csv = await req('GET', `/api/admin/visits?format=csv&q=${encodeURIComponent(mine)}&limit=5`);
  ok('the export is a CSV', csv.status === 200 && /Name,Company/.test(csv.text), csv.text.slice(0, 60));
  const lines = csv.text.trim().split('\n').filter(Boolean);
  ok('…and holds every visit, not just the page being shown',
    lines.length === MADE + 1, `${lines.length - 1} rows for ${MADE} visits`);

  /* ---- filters narrow the count too, not just the rows ---- */
  for (const v of p1.slice(0, 3)) await req('POST', '/api/kiosk/signout', { visit_id: v.id });
  const out = await req('GET', `/api/admin/visits?q=${encodeURIComponent(mine)}&status=out&limit=5`);
  ok('a filter changes the total as well as the page',
    Number(out.headers.get('X-Total-Count')) === 3 && out.data.length === 3,
    `${out.headers.get('X-Total-Count')} signed out, ${out.data.length} rows`);
  const still = await req('GET', `/api/admin/visits?q=${encodeURIComponent(mine)}&status=onsite&limit=5`);
  ok('…and the rest are still counted as on site',
    Number(still.headers.get('X-Total-Count')) === MADE - 3, still.headers.get('X-Total-Count'));

  /* ---- and the screen actually says so, which is the point of all this ---- */
  const browser = require('./browser');
  if (browser.available()) {
    const b = await browser.chromium.launch(browser.launchOptions());
    const page = await b.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${BASE}/admin/`);
    await page.fill('#gate-email', 'hankalfr@gmail.com');
    await page.fill('#gate-pass', 'Testing123!');
    await page.click('#gate-submit');
    await page.waitForSelector('#shell:not(.hidden)', { timeout: 8000 });
    await page.click('#nav > button[data-view="visitors"]').catch(() => {});
    await page.click('#nav [data-view="visits"]');
    await page.waitForSelector('#v-count', { timeout: 8000 });

    const count = () => page.$eval('#v-count', (el) => el.textContent.replace(/\s+/g, ' ').trim());
    ok('the page says which slice of how many you are looking at',
      /^Showing 1–\d+ of [\d,]+ visits$/.test(await count()), await count());

    await page.fill('#v-q', mine);
    await page.selectOption('#v-per', '50');
    await page.click('#v-search');
    await page.waitForFunction((n) => {
      const el = document.querySelector('#v-count');
      return el && el.textContent.includes(`of ${n} visits`);
    }, MADE, { timeout: 8000 });
    ok('…and follows the filter rather than the whole table',
      (await count()) === `Showing 1–50 of ${MADE} visits`, await count());
    ok('there is nowhere to go back to on the first page', await page.$eval('#v-prev', (el) => el.disabled));
    ok('a next page is offered when there are more than fit', !(await page.$eval('#v-next', (el) => el.disabled)));

    const before = await page.$eval('#v-results tbody tr', (r) => r.textContent);
    await page.click('#v-next');
    await page.waitForFunction(() => {
      const el = document.querySelector('#v-count');
      return el && !el.textContent.startsWith('Showing 1–');
    }, null, { timeout: 8000 });
    ok('…and it says so when you take it', (await count()) === `Showing 51–${MADE} of ${MADE} visits`, await count());
    ok('…showing the next slice, not the same one',
      (await page.$eval('#v-results tbody tr', (r) => r.textContent)) !== before);
    ok('…with a way back, and nowhere further forward',
      !(await page.$eval('#v-prev', (el) => el.disabled)) && await page.$eval('#v-next', (el) => el.disabled));

    // A new search is a new list, so it starts at the top again — otherwise
    // you search for somebody and are told there is nobody, on page two.
    await page.fill('#v-q', '');
    await page.click('#v-search');
    await page.waitForFunction(() => {
      const el = document.querySelector('#v-count');
      return el && el.textContent.startsWith('Showing 1–');
    }, null, { timeout: 8000 });
    ok('changing the search puts you back on the first page',
      (await count()).startsWith('Showing 1–'), await count());
    ok('the page threw nothing along the way', errors.length === 0, errors.join(' | '));
    await b.close();
  } else {
    console.log('  (no browser — the paging controls were not driven)');
  }

  /*
   * Sixty invented people on site would show up on the board and in every
   * count after this, so they go again. There is deliberately no route for
   * deleting a visit — that is a record of who was here — hence the direct
   * write, as in reports-test.
   */
  const db = require('../server/db');
  db.run("DELETE FROM visits WHERE client_ref LIKE 'page-%'");
  db.run("DELETE FROM visitors WHERE full_name LIKE 'Paging Person %'");
  const left = (await req('GET', `/api/admin/visits?q=${encodeURIComponent(mine)}`)).data;
  ok('the fixture is cleared away afterwards', left.length === 0, `${left.length} left behind`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
