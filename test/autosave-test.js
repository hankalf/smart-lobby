/* Changes keep themselves, and the pill says so. */
'use strict';
const { chromium, launchOptions } = require('./browser');
const BASE = process.env.BASE_URL || 'http://localhost:3401';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n}${x ? ' — ' + x : ''}`); } };

(async () => {
  const browser = await chromium.launch({ ...launchOptions() });
  const page = await browser.newPage({ viewport: { width: 1320, height: 950 } });
  const errors = [];
  const puts = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if ((m.location().url || '').endsWith('/favicon.ico')) return;
    errors.push(m.text());
  });
  page.on('request', (r) => {
    if (r.method() === 'PUT' && r.url().endsWith('/api/admin/settings')) puts.push(Date.now());
  });

  await page.goto(`${BASE}/admin/`);
  await page.fill('#gate-email', 'hankalfr@gmail.com');
  await page.fill('#gate-pass', 'Testing123!');
  await page.click('#gate-submit');
  await page.waitForSelector('#shell:not(.hidden)');

  /*
   * The pill is emptied when it hides, so this cannot be satisfied by the
   * leftover text of an earlier save — which is exactly how an earlier
   * version of this check passed while saving nothing.
   */
  const savedPill = () => page.waitForFunction(() => {
    const el = document.querySelector('#save-state');
    return !el.hidden && /Saved/.test(el.textContent);
  }, null, { timeout: 10000 });

  const settingValue = (path) => page.evaluate((p) =>
    fetch('/api/admin/settings').then((r) => r.json()).then((s) => p.split('.').reduce((o, k) => o[k], s)), path);

  /* ---- the settings page ---- */
  await page.goto(`${BASE}/admin/#settings/branding`);
  await page.reload();
  await page.waitForSelector('#set-branding:not([hidden]) [data-set="org.welcome_title"]', { timeout: 10000 });
  ok('the Save button is gone', (await page.$('#save-settings')) === null);

  puts.length = 0;
  await page.fill('[data-set="org.welcome_title"]', 'Saved By Itself');
  ok('nothing is sent while still typing', puts.length === 0, String(puts.length));
  await page.waitForSelector('#save-state:not([hidden])', { timeout: 5000 });
  ok('the pill appears', await page.isVisible('#save-state'));
  await savedPill();
  ok('…and settles on "Saved"', /Saved/.test(await page.textContent('#save-state')), await page.textContent('#save-state'));
  ok('the change really is on the server', (await settingValue('org.welcome_title')) === 'Saved By Itself',
    String(await settingValue('org.welcome_title')));
  ok('one save, not one per keystroke', puts.length === 1, `${puts.length} requests`);

  await page.waitForFunction(() => document.querySelector('#save-state').hidden, null, { timeout: 8000 });
  ok('the pill goes away on its own afterwards', await page.isHidden('#save-state'));

  /* ---- a checkbox is a finished decision, so it saves at once ---- */
  puts.length = 0;
  const before = await settingValue('kiosk.show_onsite_count');
  await page.click('#nav .subnav button[data-section="flow"]');
  await page.waitForSelector('[data-set="kiosk.show_onsite_count"]');
  await page.click('[data-set="kiosk.show_onsite_count"]');
  await savedPill();
  ok('ticking a box saves it', (await settingValue('kiosk.show_onsite_count')) !== before,
    `${before} -> ${await settingValue('kiosk.show_onsite_count')}`);

  /* ---- typing quickly must not race itself ---- */
  puts.length = 0;
  await page.click('#nav .subnav button[data-section="branding"]');
  await page.waitForSelector('[data-set="org.welcome_message"]');
  for (const word of ['One ', 'Two ', 'Three ', 'Four ', 'Five']) {
    await page.type('[data-set="org.welcome_message"]', word, { delay: 20 });
    await page.waitForTimeout(120);
  }
  await savedPill();
  await page.waitForTimeout(600);
  ok('a burst of typing is not one request per word', puts.length <= 3, `${puts.length} requests`);
  const typed = await page.inputValue('[data-set="org.welcome_message"]');
  ok('the last thing typed is what was saved', (await settingValue('org.welcome_message')) === typed,
    `${await settingValue('org.welcome_message')} vs ${typed}`);

  /* ---- typing a password must not look like saving ---- */
  await page.click('#nav .subnav button[data-section="users"]');
  await page.waitForSelector('#pw-current');
  await page.waitForFunction(() => document.querySelector('#save-state').hidden, null, { timeout: 8000 });
  puts.length = 0;
  await page.type('#pw-new', 'not-a-setting', { delay: 15 });
  await page.waitForTimeout(1200);
  ok('typing a password saves nothing', puts.length === 0, `${puts.length} requests`);
  ok('…and does not flash the pill', await page.isHidden('#save-state'));

  /* ---- visitor types ---- */
  await page.goto(`${BASE}/admin/#vtypes`);
  await page.reload();
  await page.waitForSelector('[data-vtlabel="0"]', { timeout: 10000 });
  ok('its Save button is gone too', (await page.$('#vt-save')) === null);

  await page.fill('[data-vtlabel="0"]', 'Kept Automatically');
  await savedPill();
  const types = await page.evaluate(() => fetch('/api/admin/settings').then((r) => r.json()).then((s) => s.types));
  ok('renaming a card is saved', types.some((t) => t.label === 'Kept Automatically'),
    types.map((t) => t.label).join(','));

  /* ---- and the one case where saving would destroy something ---- */
  await page.fill('[data-vtlabel="0"]', '');
  await page.waitForFunction(() => /needs a name/.test(document.querySelector('#save-state').textContent), null, { timeout: 8000 });
  ok('clearing a name does not save, and says why',
    /needs a name/.test(await page.textContent('#save-state')), await page.textContent('#save-state'));
  await page.waitForTimeout(900);
  const still = await page.evaluate(() => fetch('/api/admin/settings').then((r) => r.json()).then((s) => s.types));
  ok('…and the card is still there on the server', still.length === types.length,
    `${still.length} vs ${types.length}`);

  await page.fill('[data-vtlabel="0"]', 'Named Again');
  await savedPill();
  ok('naming it again saves normally',
    (await page.evaluate(() => fetch('/api/admin/settings').then((r) => r.json()).then((s) => s.types)))
      .some((t) => t.label === 'Named Again'));

  ok('no javascript errors anywhere', errors.length === 0, errors.slice(0, 3).join(' | '));

  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
