/* The visitor-type preview: what the kiosk would show, before saving. */
'use strict';
const { chromium, launchOptions } = require('./browser');
const BASE = process.env.BASE_URL || 'http://localhost:3401';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n}${x ? ' — ' + x : ''}`); } };

(async () => {
  const login = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'hankalfr@gmail.com', password: 'Testing123!' })
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  // Spanish on, so the preview's language picker is there to test.
  await fetch(`${BASE}/api/admin/settings`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ kiosk: { spanish_enabled: true } })
  });

  const browser = await chromium.launch({ ...launchOptions() });
  const page = await browser.newPage({ viewport: { width: 1320, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if ((m.location().url || '').endsWith('/favicon.ico')) return;
    errors.push(m.text());
  });

  await page.goto(`${BASE}/admin/`);
  await page.fill('#gate-email', 'hankalfr@gmail.com');
  await page.fill('#gate-pass', 'Testing123!');
  await page.click('#gate-submit');
  await page.waitForSelector('#shell:not(.hidden)');
  await page.goto(`${BASE}/admin/#vtypes`);
  await page.reload();
  await page.waitForSelector('#vt-preview .tile', { timeout: 10000 });

  const homeTiles = () => page.$$eval('#vt-preview .kiosk-preview:first-child .tile span:nth-child(2)',
    (e) => e.map((x) => x.textContent.trim()));
  const allTiles = () => page.$$eval('#vt-preview .tile span:nth-child(2)', (e) => e.map((x) => x.textContent.trim()));

  const home = await homeTiles();
  ok('the home screen is previewed', home.length > 0, home.join(','));
  ok('…starting with Sign in and Sign out', home[0] === 'Sign in' && home[1] === 'Sign out', home.join(','));
  ok('the picker behind Sign in is previewed too',
    (await page.$$('#vt-preview .kiosk-preview')).length === 2,
    String((await page.$$('#vt-preview .kiosk-preview')).length));
  ok('it uses the kiosk\'s own tile markup', (await page.$$('#vt-preview .tiles .tile')).length > 0);

  /* ---- it follows the typing ---- */
  await page.fill('[data-vtlabel="0"]', 'Renamed Live');
  await page.waitForTimeout(350);
  ok('renaming a type updates the preview', (await allTiles()).includes('Renamed Live'), (await allTiles()).join(','));

  await page.fill('[data-vticon="0"]', '🦺');
  await page.waitForTimeout(350);
  ok('so does changing its icon',
    (await page.$$eval('#vt-preview .tile-icon', (e) => e.map((x) => x.textContent))).includes('🦺'));

  /* ---- and it follows where the type is shown ---- */
  await page.selectOption('[data-vtmode="0"]', 'card');
  await page.waitForTimeout(350);
  ok('"own card" puts it on the home screen', (await homeTiles()).includes('Renamed Live'), (await homeTiles()).join(','));

  await page.selectOption('[data-vtmode="0"]', 'picker');
  await page.waitForTimeout(350);
  ok('"behind the Sign in card" takes it off the home screen',
    !(await homeTiles()).includes('Renamed Live'), (await homeTiles()).join(','));
  ok('…but it is still shown behind Sign in', (await allTiles()).includes('Renamed Live'));

  await page.selectOption('[data-vtmode="0"]', 'off');
  await page.waitForTimeout(350);
  ok('hiding it removes it from both', !(await allTiles()).includes('Renamed Live'), (await allTiles()).join(','));

  /* ---- with nothing behind it, the kiosk drops the Sign in card ---- */
  const modes = await page.$$('[data-vtmode]');
  for (let i = 0; i < modes.length; i++) await page.selectOption(`[data-vtmode="${i}"]`, 'off');
  await page.waitForTimeout(400);
  ok('with every type hidden there is no Sign in card',
    !(await homeTiles()).includes('Sign in'), (await homeTiles()).join(','));
  ok('…and the preview says so rather than showing an empty box',
    /hidden|drops/i.test(await page.textContent('#vt-preview')), (await page.textContent('#vt-preview')).slice(0, 80));

  /* ---- Spanish ---- */
  for (let i = 0; i < modes.length; i++) await page.selectOption(`[data-vtmode="${i}"]`, 'both');
  await page.fill('[data-vtlabel="0"]', 'Cleaner');
  await page.fill('[data-vtlabeles="0"]', 'Limpiador');
  await page.waitForTimeout(350);
  ok('English is shown by default', (await allTiles()).includes('Cleaner'), (await allTiles()).join(','));
  await page.selectOption('#vt-lang', 'es');
  await page.waitForTimeout(350);
  ok('switching to Spanish shows the Spanish wording',
    (await allTiles()).includes('Limpiador'), (await allTiles()).join(','));
  ok('…and the fixed cards are in Spanish too',
    (await homeTiles()).some((t) => /Salir|Iniciar/.test(t)), (await homeTiles()).join(','));

  // A type with no Spanish wording falls back to English, as the kiosk does.
  await page.fill('[data-vtlabel="1"]', 'Auditor');
  await page.fill('[data-vtlabeles="1"]', '');
  await page.waitForTimeout(350);
  ok('a type with no Spanish falls back to its English name',
    (await allTiles()).includes('Auditor'), (await allTiles()).join(','));

  ok('no javascript errors anywhere', errors.length === 0, errors.slice(0, 3).join(' | '));

  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
