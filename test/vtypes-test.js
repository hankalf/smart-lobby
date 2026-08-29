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

  const pillSaved = () => page.waitForFunction(() => {
    const el = document.querySelector('#save-state');
    return !el.hidden && /Saved/.test(el.textContent);
  }, null, { timeout: 10000 });
  // The pill blanks itself when it hides, so waiting for it to go is what
  // stops the next check matching a "Saved" left over from the last one.
  const pillGone = () => page.waitForFunction(() => document.querySelector('#save-state').hidden,
    null, { timeout: 10000 });

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

  /* ---- the icon is chosen from a picker, not typed ---- */
  await page.click('[data-vtpick="0"]');
  await page.waitForSelector('.emoji-pick .emoji', { timeout: 5000 });
  ok('the picker offers emoji in groups', (await page.$$('.emoji-group')).length >= 4,
    String((await page.$$('.emoji-group')).length));
  ok('…and shows which one is on the card now', (await page.$$('.emoji-grid .emoji.on')).length >= 0);
  await page.click('.emoji-grid .emoji[data-emoji="🦺"]');
  await page.waitForTimeout(400);
  ok('picking one closes the picker', (await page.$('.emoji-pick')) === null);
  ok('so does changing its icon',
    (await page.$$eval('#vt-preview .tile-icon', (e) => e.map((x) => x.textContent))).includes('🦺'));
  ok('…and the button on the row shows it',
    (await page.textContent('[data-vtpick="0"]')).trim() === '🦺',
    await page.textContent('[data-vtpick="0"]'));
  await pillSaved();
  ok('the picked icon is saved',
    (await page.evaluate(() => fetch('/api/admin/settings').then((r) => r.json())
      .then((s) => s.types[0].icon))) === '🦺');

  // Anything the list does not offer can still be pasted in.
  await page.click('[data-vtpick="0"]');
  await page.waitForSelector('#emoji-own', { timeout: 5000 });
  await page.fill('#emoji-own', '🐝');
  await page.click('.modal [data-save]');
  await page.waitForTimeout(400);
  ok('an emoji of your own can be pasted in',
    (await page.textContent('[data-vtpick="0"]')).trim() === '🐝',
    await page.textContent('[data-vtpick="0"]'));
  await page.click('[data-vtpick="0"]');
  await page.waitForSelector('.emoji-pick .emoji', { timeout: 5000 });
  await page.click('.emoji-grid .emoji[data-emoji="🦺"]');
  await page.waitForTimeout(400);

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

  /* ---- dragging a card in the preview sets the kiosk order ---- */
  await page.selectOption('#vt-lang', 'en');
  const modeEls = await page.$$('[data-vtmode]');
  for (let i = 0; i < modeEls.length; i++) await page.selectOption(`[data-vtmode="${i}"]`, 'card');
  await page.waitForTimeout(400);

  const movable = () => page.$$eval('#vt-preview .kiosk-preview:first-child .tile.movable span:nth-child(2)',
    (e) => e.map((x) => x.textContent.trim()));
  const rowNames = () => page.$$eval('[data-vtlabel]', (e) => e.map((x) => x.value));

  const before = await movable();
  ok('only the type cards can be moved', before.length === (await rowNames()).length,
    `${before.length} movable vs ${(await rowNames()).length} types`);
  ok('the fixed cards are not draggable',
    (await page.$$('#vt-preview .tile[draggable="true"]')).length === before.length);

  /*
   * Playwright's mouse does not drive HTML5 drag events, so the drag is
   * dispatched directly — the point under test is what the handlers do with
   * a drop, not whether Chromium can drag.
   */
  await pillGone();
  await page.evaluate(() => {
    const zone = document.querySelector('#vt-preview [data-vtdrop]');
    const tiles = [...zone.querySelectorAll('.tile.movable')];
    const last = tiles[tiles.length - 1];
    const first = tiles[0];
    const dt = new DataTransfer();
    last.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const box = first.getBoundingClientRect();
    zone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt,
      clientX: box.left + 2, clientY: box.top + box.height / 2 }));
    zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await page.waitForTimeout(500);

  const after = await movable();
  ok('dragging a card to the front moves it there',
    after[0] === before[before.length - 1], `${before.join(',')} -> ${after.join(',')}`);
  ok('…and the list underneath follows the same order',
    (await rowNames()).join(',') === after.join(','), `${(await rowNames()).join(',')} vs ${after.join(',')}`);

  await pillSaved();
  const stored = await page.evaluate(() =>
    fetch('/api/admin/settings').then((r) => r.json()).then((s) => s.types.map((t) => t.label)));
  ok('…and the new order is what the kiosk will get', stored.join(',') === after.join(','),
    `${stored.join(',')} vs ${after.join(',')}`);

  ok('no javascript errors anywhere', errors.length === 0, errors.slice(0, 3).join(' | '));

  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
