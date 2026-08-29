/* The settings page folds up, and the side menu can reach every section. */
const { chromium, launchOptions } = require('./browser');
const BASE = process.env.BASE_URL || 'http://localhost:3401';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n}${x ? ' — ' + x : ''}`); } };

(async () => {
  const browser = await chromium.launch({ ...launchOptions(), });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // The missing favicon is a long-standing cosmetic 404, not this page's doing.
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if ((m.location().url || '').endsWith('/favicon.ico')) return;
    errors.push(m.text());
  });

  await page.goto(BASE + '/admin/');
  await page.fill('#gate-email', 'hankalfr@gmail.com');
  await page.fill('#gate-pass', 'Testing123!');
  await page.click('#gate-submit');
  await page.waitForSelector('#shell:not(.hidden)');

  /* ---- the sub-menu only appears under Settings ---- */
  ok('no sub-list is open on the dashboard',
    await page.$$eval('#nav .subnav', (s) => s.every((x) => x.hidden)));
  await page.click('#nav > button[data-view="settings"]');
  await page.waitForSelector('#set-branding');
  ok('the sub-list appears under Settings', await page.isVisible('#nav .subnav[data-for="settings"]'));
  const items = await page.$$eval('#nav .subnav[data-for="settings"] button[data-section]', (b) => b.map((x) => x.dataset.section));
  ok('it lists every panel', items.length === 14, items.join(','));

  /* ---- the two groups ---- */
  ok('Sign-in setup has its own list',
    (await page.$$('#nav .subnav[data-for="signin"] button')).length === 4);
  await page.click('#nav > button[data-view="signin"]');
  await page.waitForTimeout(700);
  ok('a heading with no page of its own opens its first entry',
    (await page.textContent('h1.page')).trim() === 'Induction decks', await page.textContent('h1.page'));
  ok('…and stays highlighted while a child is open',
    await page.evaluate(() => document.querySelector('#nav > button[data-view="signin"]').classList.contains('active')));
  ok('…with only its own list showing',
    await page.evaluate(() => document.querySelector('#nav .subnav[data-for="settings"]').hidden));

  for (const [view, heading] of [['devices', 'Devices'], ['printers', 'Printers'], ['locations', 'Locations']]) {
    await page.click(`#nav > button[data-view="settings"]`);
    await page.waitForTimeout(400);
    await page.click(`#nav .subnav[data-for="settings"] button[data-view="${view}"]`);
    await page.waitForTimeout(700);
    ok(`${heading} opens from under Settings`, (await page.textContent('h1.page')).trim() === heading,
      await page.textContent('h1.page'));
    ok(`…with Settings still the highlighted tab`,
      await page.evaluate(() => document.querySelector('#nav > button[data-view="settings"]').classList.contains('active')));
  }

  await page.click('#nav > button[data-view="settings"]');
  await page.waitForSelector('#set-branding');

  /* ---- every menu entry matches a real panel ---- */
  const missing = [];
  for (const slug of items) if (!(await page.$(`#set-${slug}`))) missing.push(slug);
  ok('every entry points at a panel that exists', missing.length === 0, missing.join(','));

  /* ---- panels start folded ---- */
  const bodies = await page.$$eval('.collapsible', (s) => s.map((x) => x.classList.contains('open')));
  ok('the sections start collapsed', bodies.every((b) => !b), String(bodies.filter(Boolean).length) + ' open');
  ok('the headings are still readable', await page.isVisible('#set-retention .sec-head h2'));
  ok('the contents are hidden', await page.isHidden('#set-retention [data-set="privacy.retain_visits_days"]'));

  /* ---- clicking a heading opens it ---- */
  await page.click('#set-retention .sec-head');
  ok('clicking a heading opens the panel', await page.isVisible('#set-retention [data-set="privacy.retain_visits_days"]'));
  await page.click('#set-retention .sec-head');
  ok('clicking again closes it', await page.isHidden('#set-retention [data-set="privacy.retain_visits_days"]'));

  /* ---- the menu jumps to a section ---- */
  await page.click('#nav .subnav button[data-section="notifications"]');
  await page.waitForTimeout(400);
  ok('a menu entry opens its section', await page.evaluate(() => document.querySelector('#set-notifications').classList.contains('open')));
  ok('…and marks itself in the menu', await page.evaluate(() => document.querySelector('#nav .subnav button[data-section="notifications"]').classList.contains('active')));
  ok('…and puts it in the address bar', page.url().endsWith('#settings/notifications'), page.url());

  /* ---- deleted records loads on open ---- */
  await page.click('#nav .subnav button[data-section="deleted"]');
  await page.waitForTimeout(700);
  const archiveText = await page.textContent('#archive-list');
  ok('the deleted records list loads', !/Loading/.test(archiveText), archiveText.slice(0, 60));

  await page.click('#nav .subnav button[data-section="activity"]');
  await page.waitForTimeout(700);
  const auditText = await page.textContent('#audit-list');
  ok('the activity log loads', !/Loading/.test(auditText) && auditText.length > 20, auditText.slice(0, 60));
  // Who did it, read from the column that holds it — not guessed from wording,
  // which changes with whichever actions happen to be in the log.
  ok('the log names who did it',
    await page.$$eval('#audit-list tbody tr td:nth-child(2)',
      (cells) => cells.length > 0 && cells.some((c) => c.textContent.trim().length > 0)),
    auditText.slice(0, 80));

  /* ---- expand / collapse all ---- */
  await page.click('#sec-expand');
  ok('expand all opens everything',
    (await page.$$eval('.collapsible', (s) => s.every((x) => x.classList.contains('open')))));
  await page.click('#sec-collapse');
  ok('collapse all shuts everything',
    (await page.$$eval('.collapsible', (s) => s.every((x) => !x.classList.contains('open')))));

  /* ---- what is left open survives a reload ---- */
  await page.click('#set-branding .sec-head');
  await page.reload();
  await page.waitForSelector('#shell:not(.hidden)');
  await page.click('#nav > button[data-view="settings"]');
  await page.waitForSelector('#set-branding');
  ok('an open section is still open after a reload',
    await page.evaluate(() => document.querySelector('#set-branding').classList.contains('open')));
  ok('the others are still closed',
    await page.evaluate(() => !document.querySelector('#set-access').classList.contains('open')));

  /* ---- a deep link works from cold ---- */
  await page.goto(BASE + '/admin/#settings/access');
  await page.reload();
  await page.waitForSelector('#set-access');
  await page.waitForTimeout(500);
  ok('a link straight to a section opens it',
    await page.evaluate(() => document.querySelector('#set-access').classList.contains('open')));
  ok('…with Settings marked in the menu',
    await page.evaluate(() => document.querySelector('#nav > button[data-view="settings"]').classList.contains('active')));

  /* ---- the check-in flow can be rearranged ---- */
  await page.click('#nav .subnav button[data-section="flow"]');
  await page.waitForSelector('#flow-strip .flow-chip');
  const order0 = await page.$$eval('#flow-strip .flow-label', (e) => e.map((x) => x.textContent));
  ok('the flow is shown as a strip of steps', order0.length === 4, order0.join(' > '));
  ok('the steps are numbered in order',
    (await page.$$eval('#flow-strip .flow-n', (e) => e.map((x) => x.textContent))).join('') === '1234');

  await page.click('#flow-strip [data-sright="0"]');
  await page.waitForTimeout(250);
  const order1 = await page.$$eval('#flow-strip .flow-label', (e) => e.map((x) => x.textContent));
  ok('an arrow moves a step along', order1[0] === order0[1] && order1[1] === order0[0], order1.join(' > '));
  ok('the numbering follows',
    (await page.$$eval('#flow-strip .flow-n', (e) => e.map((x) => x.textContent))).join('') === '1234');

  const chips = await page.$$('#flow-strip .flow-chip');
  const last = await chips[chips.length - 1].boundingBox();
  const first = await chips[0].boundingBox();
  await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2);
  await page.mouse.down();
  await page.mouse.move(first.x + 4, first.y + first.height / 2, { steps: 20 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const order2 = await page.$$eval('#flow-strip .flow-label', (e) => e.map((x) => x.textContent));
  ok('dragging a step to the front moves it there', order2[0] === order1[order1.length - 1], order2.join(' > '));
  ok('nothing is lost or duplicated by a drag',
    new Set(order2).size === 4 && order2.every((l) => order0.includes(l)), order2.join(' > '));

  // The strip and the all-types list are two views of the same thing.
  await page.click('#set-flow .sub-fold > summary');
  await page.waitForTimeout(250);
  /*
   * The strip shows whichever type the picker is on, which is not necessarily
   * the first one this site happens to have — comparing against a hardcoded
   * "visitor" column made this pass or fail depending on what an earlier suite
   * had left the visitor types looking like.
   */
  const flowType = await page.inputValue('#flow-type');
  const column = await page.$$eval(`[data-flowtype="${flowType}"] .flow-list li span:first-child`,
    (e) => e.map((x) => x.textContent));
  ok('the side-by-side list agrees with the strip', column.join(',') === order2.join(','),
    `${column.join(',')} vs ${order2.join(',')}`);

  // Nothing to press any more — the page saves itself.
  await page.waitForFunction(() => {
    const el = document.querySelector('#save-state');
    return !el.hidden && /Saved/.test(el.textContent);
  }, null, { timeout: 10000 }).catch(() => {});
  const savedFlow = await page.evaluate(() => fetch('/api/admin/settings').then((r) => r.json()).then((s) => s.flow.visitor));
  ok('the rearranged flow is saved', Array.isArray(savedFlow) && savedFlow.length === 4, JSON.stringify(savedFlow));

  /* ---- the account, backup and camera panels are wired ---- */
  await page.click('#nav .subnav button[data-section="users"]');
  await page.waitForTimeout(400);
  ok('there is a form to change your own password', await page.isVisible('#pw-current'));
  await page.fill('#pw-new', 'abcdefgh');
  await page.fill('#pw-again', 'different');
  await page.click('#pw-save');
  await page.waitForTimeout(300);
  ok('mismatched new passwords are caught before the server sees them',
    /do not match/i.test(await page.textContent('#pw-result')), await page.textContent('#pw-result'));

  await page.click('#nav .subnav button[data-section="backups"]');
  await page.waitForTimeout(900);
  ok('the backup list loads', !/Loading/.test(await page.textContent('#backup-list')),
    (await page.textContent('#backup-list')).slice(0, 60));
  await page.click('#backup-now');
  await page.waitForTimeout(1200);
  ok('a backup can be taken from the page', /Download/.test(await page.textContent('#backup-list')),
    (await page.textContent('#backup-list')).slice(0, 60));

  await page.click('#nav .subnav button[data-section="board"]');
  await page.waitForTimeout(700);
  ok('the camera panel warns about http and https',
    /https/i.test(await page.textContent('#camera-warning')));
  await page.fill('[data-set="board.camera_url"]', 'rtsp://192.168.1.50/stream');
  await page.click('#camera-test');
  await page.waitForTimeout(900);
  ok('an RTSP address is explained rather than silently failing',
    /RTSP/i.test(await page.textContent('#camera-result')), await page.textContent('#camera-result'));
  await page.fill('[data-set="board.camera_url"]', '');

  /* ---- the wording block folds inside its panel ---- */
  await page.click('#nav .subnav button[data-section="details"]');
  await page.waitForTimeout(400);
  ok('the panel is called Visitor form',
    (await page.textContent('#set-details .sec-head h2')).trim() === 'Visitor form',
    await page.textContent('#set-details .sec-head h2'));
  ok('the wording block starts folded', await page.isHidden('#wording-type'));
  await page.click('#set-details .sub-fold > summary');
  await page.waitForTimeout(250);
  ok('and opens when asked', await page.isVisible('#wording-type'));

  /* ---- the settings still save themselves ---- */
  await page.click('#nav .subnav button[data-section="retention"]');
  await page.waitForTimeout(300);
  await page.waitForFunction(() => document.querySelector('#save-state').hidden, null, { timeout: 10000 });
  await page.fill('[data-set="privacy.retain_visits_days"]', '400');
  await page.waitForFunction(() => {
    const el = document.querySelector('#save-state');
    return !el.hidden && /Saved/.test(el.textContent);
  }, null, { timeout: 10000 });
  const saved = await page.evaluate(() => fetch('/api/admin/settings').then((r) => r.json()).then((s) => s.privacy.retain_visits_days));
  ok('settings save themselves from inside a folded page', String(saved) === '400', String(saved));

  /* ---- other views are untouched ---- */
  await page.click('#nav > button[data-view="dashboard"]');
  await page.waitForTimeout(500);
  ok('the dashboard still loads', await page.isVisible('h1.page'));
  ok('the sub-lists hide again',
    await page.$$eval('#nav .subnav', (s) => s.every((x) => x.hidden)));

  ok('no javascript errors anywhere', errors.length === 0, errors.slice(0, 3).join(' | '));

  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
