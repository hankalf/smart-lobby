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
  /*
   * Counted against the panels themselves rather than against a number that
   * has to be remembered: adding a settings panel and forgetting its menu
   * entry is exactly what this is for, and a magic number only catches it
   * until somebody updates the number instead of the menu.
   */
  const panels = await page.$$eval('.card.section[id^="set-"]', (s) => s.map((x) => x.id.slice(4)));
  ok('it lists every panel', items.length === panels.length,
    `menu: ${items.join(',')} / panels: ${panels.join(',')}`);

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

  /* ---- one panel is a page, and only one is on screen ---- */
  const showing = () => page.$$eval('.card.section[id^="set-"]',
    (secs) => secs.filter((x) => !x.hidden).map((x) => x.id));
  ok('exactly one panel is shown at a time', (await showing()).length === 1, (await showing()).join(','));
  ok('the Settings tab lands on the first entry', (await showing())[0] === 'set-branding', (await showing()).join(','));
  ok('…and says so in the address bar', page.url().endsWith('#settings/branding'), page.url());
  ok('another panel is not merely folded but off the page',
    await page.isHidden('#set-retention [data-set="privacy.retain_visits_days"]'));

  /* ---- the panel's heading becomes the page title ---- */
  ok('the page is titled for the panel it shows',
    (await page.textContent('#set-title')).trim() === 'Branding', await page.textContent('#set-title'));
  ok('…with Settings above it', /Settings/.test(await page.textContent('.page-eyebrow')));
  ok('the panel does not then repeat its own heading',
    await page.isHidden('#set-branding > h2'));

  /* ---- the menu switches page ---- */
  await page.click('#nav .subnav button[data-section="notifications"]');
  await page.waitForTimeout(400);
  ok('a menu entry shows its page', (await showing()).join(',') === 'set-notifications', (await showing()).join(','));
  ok('…and hides the one before it', await page.isHidden('#set-branding'));
  ok('…retitling the page', (await page.textContent('#set-title')).trim() === 'Notifications',
    await page.textContent('#set-title'));
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

  /* ---- switching page does not throw away what was just typed ---- */
  await page.click('#nav .subnav button[data-section="branding"]');
  await page.waitForSelector('#set-branding [data-set="org.welcome_title"]');
  await page.waitForFunction(() => document.querySelector('#save-state').hidden, null, { timeout: 10000 });
  await page.fill('[data-set="org.welcome_title"]', 'Typed Then Switched');
  // Straight to another page, inside the pause before a save would fire.
  await page.click('#nav .subnav button[data-section="retention"]');
  await page.waitForFunction(() => {
    const el = document.querySelector('#save-state');
    return !el.hidden && /Saved/.test(el.textContent);
  }, null, { timeout: 10000 });
  ok('typing then switching page still saves what was typed',
    (await page.evaluate(() => fetch('/api/admin/settings').then((r) => r.json())
      .then((s) => s.org.welcome_title))) === 'Typed Then Switched');
  ok('…and the panel switched all the same', (await showing()).join(',') === 'set-retention',
    (await showing()).join(','));

  /* ---- the page you were on comes back after a reload ---- */
  await page.reload();
  await page.waitForSelector('#set-retention', { timeout: 10000 });
  ok('a reload comes back to the same page', (await showing()).join(',') === 'set-retention',
    (await showing()).join(','));

  /* ---- a deep link works from cold ---- */
  await page.goto(BASE + '/admin/#settings/access');
  await page.reload();
  await page.waitForSelector('#set-access');
  await page.waitForTimeout(500);
  ok('a link straight to a section opens it',
    await page.evaluate(() => !document.querySelector('#set-access').hidden));
  ok('…and nothing else with it',
    (await page.$$eval('.card.section[id^="set-"]', (secs) => secs.filter((x) => !x.hidden).length)) === 1);
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
    (await page.textContent('#set-title')).trim() === 'Visitor form', await page.textContent('#set-title'));
  /* ---- hovering a dropdown lights its row and its column ---- */
  const lit = () => page.$$eval('.fields-table .cross-row, .fields-table .cross-col',
    (cs) => cs.length);
  ok('nothing is lit before the pointer is anywhere', (await lit()) === 0, String(await lit()));

  const cell = await page.$('.fields-table tbody tr:nth-child(2) td[data-col="2"]');
  await cell.hover();
  await page.waitForTimeout(150);
  ok('hovering a cell lights its whole column',
    (await page.$$eval('.fields-table [data-col="2"].cross-col', (cs) => cs.length))
      === (await page.$$eval('.fields-table [data-col="2"]', (cs) => cs.length)),
    String(await page.$$eval('.fields-table [data-col="2"].cross-col', (cs) => cs.length)));
  ok('…and its whole row',
    await page.$$eval('.fields-table tbody tr:nth-child(2) td',
      (cs) => cs.every((c) => c.classList.contains('cross-row'))));
  ok('the cell itself is marked as the one about to be clicked',
    await page.$eval('.fields-table tbody tr:nth-child(2) td[data-col="2"]',
      (c) => c.classList.contains('cross-row') && c.classList.contains('cross-col')));
  ok('a cell in another column is not lit as the target',
    await page.$eval('.fields-table tbody tr:nth-child(2) td[data-col="1"]',
      (c) => c.classList.contains('cross-row') && !c.classList.contains('cross-col')));

  const other = await page.$('.fields-table tbody tr:nth-child(1) td[data-col="1"]');
  await other.hover();
  await page.waitForTimeout(150);
  ok('moving on lights the new cross and drops the old',
    await page.$eval('.fields-table tbody tr:nth-child(2) td[data-col="2"]',
      (c) => !c.classList.contains('cross-row') && !c.classList.contains('cross-col')));

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

  /*
   * ---- a setting filled in by a button, rather than typed ----
   *
   * "Use where I am now" fills the site's coordinates from the browser of
   * whoever is standing on the site. It put the numbers on screen and saved
   * none of them: the auto-save listens for 'input' on a number field and only
   * for 'change' on a checkbox, and the button fired 'change' — the obvious
   * choice, and the wrong one. The only symptom was a geofence that had
   * quietly reverted the next time anybody looked, which is a fence nobody
   * would trust once they noticed.
   *
   * So this presses the button and then asks the server, because what the box
   * says was never the part that was broken.
   */
  await page.context().grantPermissions(['geolocation'], { origin: BASE });
  await page.context().setGeolocation({ latitude: 37.7955, longitude: -122.2712, accuracy: 12 });
  // The sub-list is only open while Settings is the view; earlier checks here
  // have moved off it.
  await page.click('#nav > button[data-view="settings"]');
  await page.waitForSelector('#nav .subnav[data-for="settings"] button[data-section="flow"]');
  await page.click('#nav [data-section="flow"]');
  await page.waitForSelector('#geo-here');
  await page.click('#geo-here');
  await page.waitForFunction(() =>
    (document.querySelector('[data-set="geofence.lat"]') || {}).value, null, { timeout: 8000 })
    .catch(() => {});
  ok('“use where I am now” fills the coordinates in',
    /37\.79/.test(await page.inputValue('[data-set="geofence.lat"]')),
    await page.inputValue('[data-set="geofence.lat"]'));

  // Long enough for the auto-save to have run.
  await page.waitForTimeout(2000);
  const stored = await page.evaluate(() =>
    fetch('/api/admin/settings').then((r) => r.json()).then((s) => s.geofence));
  // Compared with a tolerance, not by rounding to a string: 37.7955 does not
  // survive toFixed(3) as anybody would guess it does.
  ok('…and they are actually saved, not just shown',
    Math.abs(Number(stored.lat) - 37.7955) < 0.001 && Math.abs(Number(stored.lng) + 122.2712) < 0.001,
    JSON.stringify(stored));

  /* The address box is offered alongside it, for whoever is not on site. */
  ok('an address can be typed instead of coordinates', await page.isVisible('#geo-address'));

  ok('no javascript errors anywhere', errors.length === 0, errors.slice(0, 3).join(' | '));

  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
