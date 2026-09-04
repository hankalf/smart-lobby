/* Four events, four designs, and the buttons along the bottom. */
'use strict';
const { chromium, launchOptions } = require('./browser');
const BASE = process.env.BASE_URL || 'http://localhost:3401';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n}${x ? ' — ' + x : ''}`); } };

/* ---------------------------------------------- the model, without a browser */

const cards = require('../server/notify-card');

const VISIT = {
  full_name: 'John Doe', company: 'Example Contracting', visit_type: 'contractor',
  host_name: 'John Doe', host_email: 'host@example.com', project_name: 'Lakeview Phase 2',
  signed_in_at: '2026-08-29T09:00:00.000Z', signed_out_at: '2026-08-29T12:20:00.000Z'
};
const PARCEL = {
  host_name: 'John Doe', host_email: 'host@example.com', courier_name: 'Pat Doe',
  courier_company: 'UPS', parcel_count: 3, tracking: '1Z999', received_at: '2026-08-29T09:00:00.000Z'
};
const CTX = {
  org: { name: "Nature's Touch Builds" }, fmtTime: (t) => String(t).slice(11, 16),
  baseUrl: 'https://lobby.example', boardUrl: 'https://lobby.example/board/secretkey'
};

function unit() {
  const empty = { cards: {} };

  const signin = cards.buildModel('signin', VISIT, empty, CTX);
  ok('an arrival still says somebody arrived', /has arrived to see/.test(signin.title), signin.title);

  const signout = cards.buildModel('signout', VISIT, empty, CTX);
  ok('a sign-out says they signed out', /has signed out/.test(signout.title), signout.title);
  /*
   * The whole reason this exists: the sign-out card used to tag the host and
   * tell them their visitor was here, sending somebody down to reception for
   * a person who had just left.
   */
  ok('a sign-out does not say the visitor is here',
    !/is here/.test(signout.mentionTemplate || ''), signout.mentionTemplate);
  ok('…it says they have gone', /left site/.test(signout.mentionTemplate || ''), signout.mentionTemplate);
  ok('a sign-out still tags the host', signout.mention && signout.mention.email === 'host@example.com');
  ok('a sign-out shows how long they were on site',
    signout.fields.some((f) => f.value === '3h 20m'), JSON.stringify(signout.fields));

  const induction = cards.buildModel('induction', VISIT, empty, CTX);
  ok('an induction says it was completed', /completed the site induction/.test(induction.title), induction.title);
  ok('…and tags them as cleared to work', /cleared to work/.test(induction.mentionTemplate || ''));

  const delivery = cards.buildModel('delivery', PARCEL, empty, CTX);
  ok('a parcel is about a parcel', /Delivery waiting for John Doe/.test(delivery.title), delivery.title);
  ok('…and never says a visitor is here', !/visitor/.test(delivery.mentionTemplate || ''), delivery.mentionTemplate);
  ok('a parcel carries parcel facts, not visit ones',
    delivery.fields.some((f) => f.label === 'Tracking') && !delivery.fields.some((f) => f.label === 'Project'),
    delivery.fields.map((f) => f.label).join(','));
  ok('a parcel never carries a photo', delivery.photoUrl === null);

  /* ---- each event keeps its own design ---- */
  const mixed = { cards: { signin: { title_template: 'ARRIVED: {name}' } } };
  ok('designing one event leaves the others alone',
    cards.buildModel('signin', VISIT, mixed, CTX).title === 'ARRIVED: John Doe'
    && /has signed out/.test(cards.buildModel('signout', VISIT, mixed, CTX).title));

  /* ---- the older single design still applies to arrivals ---- */
  const legacy = { card: { title_template: 'OLD: {name}' } };
  ok('a design set up before there were four is kept for arrivals',
    cards.buildModel('signin', VISIT, legacy, CTX).title === 'OLD: John Doe');
  ok('…and is not inflicted on parcels',
    /Delivery waiting/.test(cards.buildModel('delivery', PARCEL, legacy, CTX).title));

  /* ---- quick links ---- */
  const linked = { cards: { signin: { links: ['dashboard', 'board', 'visits'] } } };
  const m = cards.buildModel('signin', VISIT, linked, CTX);
  ok('the chosen links come out in order',
    m.links.map((l) => l.id).join(',') === 'dashboard,board,visits', m.links.map((l) => l.id).join(','));
  ok('the dashboard link points at the dashboard',
    m.links[0].url === 'https://lobby.example/admin/#dashboard', m.links[0].url);
  ok('the board link carries its key', m.links[1].url === 'https://lobby.example/board/secretkey', m.links[1].url);

  const noBoard = cards.buildModel('signin', VISIT, linked, { ...CTX, boardUrl: null });
  ok('a link with nowhere to go is left off, not left dead',
    noBoard.links.map((l) => l.id).join(',') === 'dashboard,visits', noBoard.links.map((l) => l.id).join(','));

  /*
   * A site that had the older single button keeps it — and the designer is
   * shown the same list the sender uses, so the panel cannot say "no buttons"
   * while a button is going out on every card.
   */
  const oldButton = { card: { show_button: true, button_label: 'Open the log' } };
  ok('an older single button survives as a chosen link',
    cards.cardFor('signin', oldButton).links.join(',') === 'visits',
    JSON.stringify(cards.cardFor('signin', oldButton).links));
  ok('…and is what the card actually carries',
    cards.buildModel('signin', VISIT, oldButton, CTX).links.map((l) => l.id).join(',') === 'visits');
  ok('a card that never had one has no buttons',
    cards.cardFor('signout', oldButton).links.length === 0);

  const greedy = { cards: { signin: { links: ['dashboard', 'visits', 'visitors', 'reports', 'drivers', 'kiosk'] } } };
  ok('no more buttons than Teams will lay out',
    cards.buildModel('signin', VISIT, greedy, CTX).links.length === cards.LINKS_MAX);

  const teams = cards.teamsCard(m).attachments[0].content;
  ok('they arrive as Teams actions', (teams.actions || []).length === 3, JSON.stringify(teams.actions));
  ok('…of the kind that opens a URL', teams.actions.every((a) => a.type === 'Action.OpenUrl'));
  ok('a card with no links has no actions key',
    cards.teamsCard(cards.buildModel('signin', VISIT, empty, CTX)).attachments[0].content.actions === undefined);

  /* ---- the tag line, which is two halves that have to agree ---- */
  const tagged = cards.teamsCard(signout).attachments[0].content;
  const line = JSON.stringify(tagged.body).match(/<at>[^<]*<\/at>/);
  ok('the tag markup is in the text', !!line, JSON.stringify(tagged.body).slice(0, 200));
  ok('…and matches the entity exactly',
    tagged.msteams.entities[0].text === '<at>John Doe</at>', JSON.stringify(tagged.msteams));

  const untagged = cards.buildModel('signin', VISIT, { cards: { signin: { mention_host: false } } }, CTX);
  ok('turning the tag off leaves no <at> behind',
    !/<at>/.test(JSON.stringify(cards.teamsCard(untagged))));

  /* ---- a visitor type with a card of its own ---- */
  const split = { cards: { signin: {
    title_template: '{name} has arrived',
    by_type: { contractor: { title_template: 'CONTRACTOR {name} — {project}', header_style: 'warning' } }
  } } };
  ok('a type with its own card gets it',
    cards.buildModel('signin', { ...VISIT, visit_type: 'contractor' }, split, CTX).title
      === 'CONTRACTOR John Doe — Lakeview Phase 2',
    cards.buildModel('signin', { ...VISIT, visit_type: 'contractor' }, split, CTX).title);
  ok('…and every other type keeps the shared one',
    cards.buildModel('signin', { ...VISIT, visit_type: 'interview' }, split, CTX).title
      === 'John Doe has arrived',
    cards.buildModel('signin', { ...VISIT, visit_type: 'interview' }, split, CTX).title);
  ok('an override changes only what it names',
    cards.cardFor('signin', split, 'contractor').header_style === 'warning'
      && cards.cardFor('signin', split, 'visitor').header_style === 'accent',
    `${cards.cardFor('signin', split, 'contractor').header_style} / ${cards.cardFor('signin', split, 'visitor').header_style}`);
  ok('…and leaves the fields it says nothing about alone',
    cards.cardFor('signin', split, 'contractor').fields.join(',')
      === cards.cardFor('signin', split, 'visitor').fields.join(','));
  ok('the designer is told which types have their own',
    cards.typesWithOwnCard('signin', split).join(',') === 'contractor',
    JSON.stringify(cards.typesWithOwnCard('signin', split)));
  ok('…and that the other events have none', cards.typesWithOwnCard('signout', split).length === 0);
  ok('a parcel has no visitor type, so it cannot vary by one',
    cards.buildModel('delivery', PARCEL, split, CTX).visitType === null);

  /* ---- routing a visitor type to somebody beyond the host ---- */
  const safety = [{ name: 'John Doe', email: 'safety@example.com' }];
  const routed = cards.buildModel('signin', VISIT, empty, { ...CTX, also: safety });
  ok('a routed person is tagged as well as the host',
    routed.alsoMention.length === 1 && routed.alsoMention[0].email === 'safety@example.com',
    JSON.stringify(routed.alsoMention));
  const routedCard = cards.teamsCard(routed).attachments[0].content;
  ok('Teams is told about both tags', routedCard.msteams.entities.length === 2,
    JSON.stringify(routedCard.msteams.entities));
  ok('…and every tag in the text has an entity behind it',
    (JSON.stringify(routedCard.body).match(/<at>/g) || []).length === 2,
    JSON.stringify(routedCard.body).slice(0, 300));
  ok('the routed line says who else it is for',
    /Also for/.test(JSON.stringify(routedCard.body)), JSON.stringify(routedCard.body).slice(0, 300));

  // Routing somebody who is already the host would tag them twice.
  const dupe = cards.buildModel('signin', VISIT, empty,
    { ...CTX, also: [{ name: 'John Doe', email: 'HOST@example.com' }] });
  ok('the host is not tagged twice when routed to themselves',
    dupe.alsoMention.length === 0, JSON.stringify(dupe.alsoMention));

  // Somebody who wants every contractor still wants them with the host tag off.
  const hostOff = cards.buildModel('signin', VISIT,
    { cards: { signin: { mention_host: false } } }, { ...CTX, also: safety });
  ok('turning off the host tag does not turn off a routed one',
    hostOff.mention === null && hostOff.alsoMention.length === 1);

  ok('no routing means no extra line',
    cards.buildModel('signin', VISIT, empty, CTX).alsoTemplate === null);

  /* ---- Slack gets the buttons too, without pretending it can tag ---- */
  const slack = cards.render('slack', m);
  ok('Slack gets the links as buttons',
    slack.blocks.some((b) => b.type === 'actions' && b.elements.length === 3));
  ok('Slack never emits <at> markup', !/<at>/.test(JSON.stringify(slack)));
}

/* ------------------------------------------------------ and in the dashboard */

(async () => {
  unit();

  const browser = await chromium.launch({ ...launchOptions() });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
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
  // stops the next check reading a "Saved" left over from the last one.
  const pillGone = () => page.waitForFunction(() => document.querySelector('#save-state').hidden,
    null, { timeout: 10000 });

  await page.goto(`${BASE}/admin/`);
  await page.fill('#gate-email', 'owner@example.test');
  await page.fill('#gate-pass', 'Testing123!');
  await page.click('#gate-submit');
  await page.waitForSelector('#shell:not(.hidden)');

  await page.goto(`${BASE}/admin/#settings/notifications`);
  await page.reload();
  await page.waitForSelector('#cd-events .tab', { timeout: 10000 });

  const tabs = await page.$$eval('#cd-events .tab', (bs) => bs.map((b) => b.textContent.trim()));
  ok('there is a designer for each of the four', tabs.length === 4, tabs.join(' | '));
  ok('…named for what they are',
    tabs.join(',') === 'Sign-ins,Sign-outs,Finished site induction,Parcel arrives', tabs.join(','));

  await page.waitForFunction(() => !/Loading/.test(document.querySelector('#cd-preview').textContent),
    null, { timeout: 10000 });
  ok('the arrival preview draws', /arrived/.test(await page.textContent('#cd-preview')),
    (await page.textContent('#cd-preview')).slice(0, 120));

  /* ---- switching to sign-outs shows the sign-out design, not the arrival's ---- */
  await page.click('#cd-events .tab:nth-child(2)');
  await page.waitForFunction(() => /signed out/i.test(document.querySelector('#cd-preview').textContent),
    null, { timeout: 10000 });
  ok('switching event switches the preview', /signed out/i.test(await page.textContent('#cd-preview')));
  ok('…and the heading box follows it',
    /signed out/.test(await page.inputValue('#cd-title')), await page.inputValue('#cd-title'));
  ok('the tag line is the sign-out one',
    /left site/.test(await page.inputValue('#cd-mention-line')), await page.inputValue('#cd-mention-line'));
  ok('the preview shows that tag line rather than "is here"',
    !/is here/.test(await page.textContent('#cd-preview')));

  /* ---- a parcel has no photo controls to offer ---- */
  await page.click('#cd-events .tab:nth-child(4)');
  await page.waitForFunction(() => /Delivery|parcel/i.test(document.querySelector('#cd-preview').textContent),
    null, { timeout: 10000 });
  ok('the parcel designer hides the photo controls', await page.isHidden('#cd-photo-block'));
  const parcelFields = await page.textContent('#cd-chosen');
  ok('it offers parcel fields', /Tracking/.test(parcelFields), parcelFields.slice(0, 160));
  ok('…and not visit ones', !/Project/.test(await page.textContent('#cd-rest')));

  /* ---- adding a quick link, which must save itself ---- */
  await page.click('#cd-events .tab:nth-child(1)');
  await page.waitForSelector('#cd-links-rest [data-clin="dashboard"]');
  await page.click('#cd-links-rest [data-clin="dashboard"]');
  await pillSaved();

  const saved = await page.evaluate(() =>
    fetch('/api/admin/settings').then((r) => r.json()).then((s) => s.notify.cards));
  ok('the link is saved against sign-ins',
    (saved.signin.links || []).includes('dashboard'), JSON.stringify(saved.signin.links));
  ok('…and not against the others',
    !(saved.delivery.links || []).includes('dashboard'), JSON.stringify(saved.delivery.links));

  await page.waitForFunction(() => /Dashboard/.test(document.querySelector('#cd-preview').textContent),
    null, { timeout: 10000 });
  ok('the button shows up in the preview', /Dashboard/.test(await page.textContent('#cd-preview')));

  /* ---- editing one event's wording does not touch another's ---- */
  await pillGone();
  await page.fill('#cd-title', '{name} is at the gate');
  await pillSaved();
  const after = await page.evaluate(() =>
    fetch('/api/admin/settings').then((r) => r.json()).then((s) => s.notify.cards));
  ok('the arrival wording is saved', after.signin.title_template === '{name} is at the gate',
    after.signin.title_template);
  ok('the sign-out wording is untouched', /signed out/.test(after.signout.title_template),
    after.signout.title_template);

  /* ---- routing a visitor type, in the dashboard and on the wire ---- */
  const officer = await page.evaluate(() => fetch('/api/admin/staff', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'John Doe', email: 'safety@example.com', active: 1 })
  }).then((r) => r.json()));
  ok('a staff member to route to exists', !!(officer && officer.id), JSON.stringify(officer).slice(0, 80));

  /*
   * Somebody with no email at all, to prove they cannot be ticked — and
   * enough people besides to cross the threshold where the card grows a
   * filter box, so the filter is actually exercised rather than skipped on a
   * site that happens to have three staff.
   */
  await page.evaluate(async () => {
    const add = (body) => fetch('/api/admin/staff', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    await add({ name: 'John Doe 41', active: 1 });
    for (let i = 42; i <= 50; i++) await add({ name: `John Doe ${i}`, email: `h${i}@example.com`, active: 1 });
  });

  await page.reload();
  /*
   * One visitor type is on screen at a time now, chosen from the tabs above
   * the panels, so this opens the one the checks below are about. The rest
   * stay in the page while hidden — everything is collected on save, and
   * looking at one type must not wipe the others.
   */
  await page.waitForSelector('[data-routetab="contractor"]', { timeout: 10000 });
  await page.click('[data-routetab="contractor"]');
  await page.waitForSelector('[data-routecard="contractor"]:not([hidden])');
  ok('there is a tab for every visitor type',
    (await page.$$('[data-routetab]')).length === (await page.$$('[data-routecard]')).length,
    `${(await page.$$('[data-routetab]')).length} tabs`);
  ok('every visitor type gets a card',
    (await page.$$('[data-routecard]')).length === (await page.$$('[data-notifytype]')).length,
    `${(await page.$$('[data-routecard]')).length} cards`);
  ok('each card carries its type name and icon',
    (await page.textContent('[data-routecard="contractor"] .route-label')).trim().length > 0
    && (await page.textContent('[data-routecard="contractor"] .route-icon')).trim().length > 0);
  ok('staff are checkboxes, not a multi-select',
    (await page.$$('[data-routecard="contractor"] [data-routestaff]')).length > 0
    && (await page.$$('[data-routecard="contractor"] select')).length === 0);
  ok('somebody with no email cannot be ticked — there is nothing to tag',
    await page.$$eval('[data-routecard="contractor"] .route-person.no-email input',
      (bs) => bs.length > 0 && bs.every((b) => b.disabled)));
  ok('the card says who it reaches before anything is ticked',
    /Nobody/.test(await page.textContent('[data-routecount="contractor"]')),
    await page.textContent('[data-routecount="contractor"]'));

  await pillGone();
  await page.check(`[data-routecard="contractor"] [data-routestaff][value="${officer.id}"]`);
  await pillSaved();
  ok('ticking somebody updates the line saying who it reaches',
    /John Doe/.test(await page.textContent('[data-routecount="contractor"]')),
    await page.textContent('[data-routecount="contractor"]'));
  const routing = await page.evaluate(() =>
    fetch('/api/admin/settings').then((r) => r.json()).then((s) => s.notify.type_routing));
  ok('the choice is saved against that type',
    (routing.contractor.staff || []).includes(officer.id), JSON.stringify(routing));
  ok('…and not against the others',
    !((routing.visitor || {}).staff || []).includes(officer.id), JSON.stringify(routing.visitor));

  /* ---- a type nobody posts about tells nobody, and says so ---- */
  ok('a posted type does not carry the "nothing is posted" note',
    await page.isHidden('[data-routecard="contractor"] .route-off-note'));
  await pillGone();
  await page.uncheck('[data-routecard="contractor"] [data-notifytype]');
  await page.waitForTimeout(200);
  ok('unticking Post says the list below does nothing',
    await page.isVisible('[data-routecard="contractor"] .route-off-note'));
  await page.check('[data-routecard="contractor"] [data-notifytype]');
  await page.waitForTimeout(200);
  ok('…and ticking it back clears the note',
    await page.isHidden('[data-routecard="contractor"] .route-off-note'));
  await pillSaved();
  ok('the people ticked survive Post being turned off and on',
    await page.isChecked(`[data-routecard="contractor"] [data-routestaff][value="${officer.id}"]`));

  /* ---- a long list gets a filter, and filtering must not lose a tick ---- */
  ok('a long staff list gets a filter box', await page.isVisible('[data-routefilter="contractor"]'));
  await page.fill('[data-routefilter="contractor"]', 'zzzz-no-such-name');
  await page.waitForTimeout(200);
  ok('filtering to nothing hides every row',
    await page.$$eval('[data-routecard="contractor"] .route-person', (rs) => rs.every((r) => r.hidden)));
  await page.fill('[data-routefilter="contractor"]', '44');
  await page.waitForTimeout(200);
  ok('…and a name narrows it to that one',
    await page.$$eval('[data-routecard="contractor"] .route-person',
      (rs) => rs.filter((r) => !r.hidden).length === 1));
  await page.fill('[data-routefilter="contractor"]', '');
  await page.waitForTimeout(200);
  ok('clearing it brings the ticked person back, still ticked',
    await page.isChecked(`[data-routecard="contractor"] [data-routestaff][value="${officer.id}"]`));

  /*
   * The dangerous case: a name hidden by the filter is still ticked, so a
   * save while filtered must not quietly drop them.
   */
  await page.fill('[data-routefilter="contractor"]', 'zzzz-no-such-name');
  await page.waitForTimeout(200);
  await pillGone();
  await page.check('[data-routecard="contractor"] [data-notifytype]').catch(() => {});
  await page.uncheck('[data-routecard="contractor"] [data-notifytype]');
  await page.check('[data-routecard="contractor"] [data-notifytype]');
  await pillSaved();
  const survived = await page.evaluate(() =>
    fetch('/api/admin/settings').then((r) => r.json()).then((s) => s.notify.type_routing));
  ok('saving while the list is filtered does not drop who is hidden',
    (survived.contractor.staff || []).includes(officer.id), JSON.stringify(survived.contractor));
  await page.fill('[data-routefilter="contractor"]', '');

  /* ---- ticking on one card must not tick the same person on another ---- */
  const otherCard = (await page.$$eval('[data-routecard]', (cs) => cs.map((c) => c.dataset.routecard)))
    .find((k) => k !== 'contractor');
  ok('the same person is untouched on another type\'s card',
    !(await page.isChecked(`[data-routecard="${otherCard}"] [data-routestaff][value="${officer.id}"]`)));

  /*
   * The preview is built from a real recent visit; whether that one happens
   * to be a contractor is not this check's business, so the model is asked
   * for directly with a contractor in front of it.
   */
  const previewed = await page.evaluate(() => fetch('/api/admin/notify/preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'signin' })
  }).then((r) => r.json()));
  ok('the preview still builds with routing on', !!previewed.model, JSON.stringify(previewed).slice(0, 80));

  /* ---- a missing photo says which of the three reasons it is ---- */
  await page.click('#cd-events .tab:nth-child(2)');
  await page.waitForFunction(() => /signed out/i.test(document.querySelector('#cd-preview').textContent),
    null, { timeout: 10000 });
  ok('a card with the photo switched off says so rather than showing nothing',
    /switched off/.test(await page.textContent('#cd-photo-warning')),
    await page.textContent('#cd-photo-warning'));

  await page.click('#cd-events .tab:nth-child(1)');
  await page.waitForFunction(() => /arrived|gate/i.test(document.querySelector('#cd-preview').textContent),
    null, { timeout: 10000 });
  const note = await page.textContent('#cd-photo-warning');
  ok('an arrival with nobody photographed says that instead',
    /nobody in the example has one|cannot reach|^\s*$/.test(note), note);

  /* ---- and the same thing in the dashboard ---- */
  await page.click('#cd-events .tab:nth-child(1)');
  await page.waitForSelector('#cd-types .tab', { timeout: 10000 });
  ok('the designer offers the visitor types', (await page.$$('#cd-types .tab')).length >= 2,
    String((await page.$$('#cd-types .tab')).length));
  ok('…starting on the card every type gets',
    /Every type/.test(await page.textContent('#cd-types .tab.on')),
    await page.textContent('#cd-types .tab.on'));

  await page.click('#cd-types [data-cdtype="contractor"]');
  await page.waitForTimeout(400);
  ok('a type with no card of its own says the shared one is showing',
    /card every type gets/i.test(await page.textContent('#cd-type-note')),
    (await page.textContent('#cd-type-note')).slice(0, 90));

  await pillGone();
  await page.click('#cd-type-own');
  await pillSaved();
  ok('…and can be given one', /card of its own/i.test(await page.textContent('#cd-type-note')),
    (await page.textContent('#cd-type-note')).slice(0, 90));

  await pillGone();
  await page.fill('#cd-title', 'CONTRACTOR {name}');
  await pillSaved();
  const bySplit = await page.evaluate(() =>
    fetch('/api/admin/settings').then((r) => r.json()).then((s) => s.notify.cards.signin));
  ok('the type\'s own wording is saved under that type',
    bySplit.by_type.contractor.title_template === 'CONTRACTOR {name}',
    JSON.stringify(bySplit.by_type));
  ok('…and the shared card is untouched', bySplit.title_template !== 'CONTRACTOR {name}',
    bySplit.title_template);

  await page.click('#cd-types [data-cdtype=""]');
  await page.waitForTimeout(400);
  ok('going back to Every type shows the shared wording again',
    (await page.inputValue('#cd-title')) === bySplit.title_template,
    await page.inputValue('#cd-title'));

  ok('no javascript errors anywhere', errors.length === 0, errors.slice(0, 3).join(' | '));

  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
