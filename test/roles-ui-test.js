/* What a limited login actually sees, in a browser. */
'use strict';
const { chromium, launchOptions } = require('./browser');
const BASE = process.env.BASE_URL || 'http://localhost:3401';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n}${x ? ' — ' + x : ''}`); } };
const api = async (method, p, body, cookie) => {
  const res = await fetch(BASE + p, {
    method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, data: await res.json().catch(() => null), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
};

(async () => {
  const owner = (await api('POST', '/api/admin/login', { email: 'hankalfr@gmail.com', password: 'Testing123!' })).cookie;
  const staff = (await api('POST', '/api/admin/staff', { name: 'Hank Alfred 60', email: 'ui-clerk@x.test', active: 1 }, owner)).data;
  await api('POST', '/api/admin/users', {
    email: 'ui-clerk@x.test', password: 'temporary123', name: staff.name, role: 'clerk', host_id: staff.id
  }, owner);

  const browser = await chromium.launch({ ...launchOptions() });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if ((m.location().url || '').endsWith('/favicon.ico')) return;
    errors.push(m.text());
  });

  /* ---- a temporary password sends them somewhere other than the dashboard ---- */
  await page.goto(`${BASE}/admin/`);
  await page.fill('#gate-email', 'ui-clerk@x.test');
  await page.fill('#gate-pass', 'temporary123');
  await page.click('#gate-submit');
  await page.waitForTimeout(1200);
  ok('a temporary password lands on "choose a password"', await page.isVisible('#gate-new'));
  ok('…and not on the dashboard', await page.isHidden('#shell'));
  ok('…with the reason said out loud', /temporary/i.test(await page.textContent('#gate-sub')),
    await page.textContent('#gate-sub'));

  await page.fill('#gate-new', 'clerk-picked-99');
  await page.fill('#gate-again', 'does-not-match');
  await page.click('#gate-submit');
  await page.waitForTimeout(400);
  ok('two different new passwords are refused', /do not match/i.test(await page.textContent('#gate-error')),
    await page.textContent('#gate-error'));

  await page.fill('#gate-again', 'clerk-picked-99');
  await page.click('#gate-submit');
  await page.waitForSelector('#shell:not(.hidden)', { timeout: 12000 });
  ok('choosing one lets them in', await page.isVisible('#shell'));

  /* ---- and they see only their own level ---- */
  const tabs = await page.$$eval('#nav > button:not(.hidden)', (b) => b.map((x) => x.textContent.trim()));
  ok('a clerk sees the dashboard, drivers and deliveries',
    tabs.join(',') === 'Dashboard,Drivers,Deliveries', tabs.join(','));
  ok('…and no Settings tab', !tabs.includes('Settings'), tabs.join(','));
  ok('…and no Visits or Visitor registry', !tabs.includes('Visits') && !tabs.includes('Visitor registry'), tabs.join(','));
  ok('their level is shown beside their name', /clerk/i.test(await page.textContent('#who')), await page.textContent('#who'));
  ok('the board link is not offered to them', await page.isHidden('#open-board'));

  /* ---- and a link they should not have lands somewhere harmless ---- */
  await page.goto(`${BASE}/admin/#settings/backups`);
  await page.reload();
  await page.waitForSelector('#shell:not(.hidden)', { timeout: 10000 });
  await page.waitForTimeout(600);
  ok('an old bookmark to the settings falls back to the dashboard',
    (await page.textContent('h1.page')).trim() === 'Dashboard', await page.textContent('h1.page'));

  ok('no javascript errors anywhere', errors.length === 0, errors.slice(0, 3).join(' | '));

  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
