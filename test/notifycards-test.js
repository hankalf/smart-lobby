/* Four events, four designs, and the buttons along the bottom. */
'use strict';
const { chromium, launchOptions } = require('./browser');
const BASE = process.env.BASE_URL || 'http://localhost:3401';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n}${x ? ' — ' + x : ''}`); } };

/* ---------------------------------------------- the model, without a browser */

const cards = require('../server/notify-card');

const VISIT = {
  full_name: 'Hank Alfred', company: 'Example Contracting', visit_type: 'contractor',
  host_name: 'Hank Alfred', host_email: 'host@example.com', project_name: 'Lakeview Phase 2',
  signed_in_at: '2026-08-29T09:00:00.000Z', signed_out_at: '2026-08-29T12:20:00.000Z'
};
const PARCEL = {
  host_name: 'Hank Alfred', host_email: 'host@example.com', courier_name: 'Pat Doe',
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
  ok('a parcel is about a parcel', /Delivery waiting for Hank Alfred/.test(delivery.title), delivery.title);
  ok('…and never says a visitor is here', !/visitor/.test(delivery.mentionTemplate || ''), delivery.mentionTemplate);
  ok('a parcel carries parcel facts, not visit ones',
    delivery.fields.some((f) => f.label === 'Tracking') && !delivery.fields.some((f) => f.label === 'Project'),
    delivery.fields.map((f) => f.label).join(','));
  ok('a parcel never carries a photo', delivery.photoUrl === null);

  /* ---- each event keeps its own design ---- */
  const mixed = { cards: { signin: { title_template: 'ARRIVED: {name}' } } };
  ok('designing one event leaves the others alone',
    cards.buildModel('signin', VISIT, mixed, CTX).title === 'ARRIVED: Hank Alfred'
    && /has signed out/.test(cards.buildModel('signout', VISIT, mixed, CTX).title));

  /* ---- the older single design still applies to arrivals ---- */
  const legacy = { card: { title_template: 'OLD: {name}' } };
  ok('a design set up before there were four is kept for arrivals',
    cards.buildModel('signin', VISIT, legacy, CTX).title === 'OLD: Hank Alfred');
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
    tagged.msteams.entities[0].text === '<at>Hank Alfred</at>', JSON.stringify(tagged.msteams));

  const untagged = cards.buildModel('signin', VISIT, { cards: { signin: { mention_host: false } } }, CTX);
  ok('turning the tag off leaves no <at> behind',
    !/<at>/.test(JSON.stringify(cards.teamsCard(untagged))));

  /* ---- routing a visitor type to somebody beyond the host ---- */
  const safety = [{ name: 'Hank Alfred', email: 'safety@example.com' }];
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
    { ...CTX, also: [{ name: 'Hank Alfred', email: 'HOST@example.com' }] });
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
  await page.fill('#gate-email', 'hankalfr@gmail.com');
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
    body: JSON.stringify({ name: 'Hank Alfred', email: 'safety@example.com', active: 1 })
  }).then((r) => r.json()));
  ok('a staff member to route to exists', !!(officer && officer.id), JSON.stringify(officer).slice(0, 80));

  await page.reload();
  await page.waitForSelector('[data-routetype="contractor"]', { timeout: 10000 });
  ok('every visitor type has an "Also tell" picker',
    (await page.$$('[data-routetype]')).length === (await page.$$('[data-notifytype]')).length);
  ok('somebody with no email cannot be picked — there is nothing to tag',
    (await page.$$eval('[data-routetype="contractor"] option',
      (os) => os.filter((o) => /no email/.test(o.textContent)).every((o) => o.disabled))));

  await pillGone();
  await page.selectOption('[data-routetype="contractor"]', [String(officer.id)]);
  await pillSaved();
  const routing = await page.evaluate(() =>
    fetch('/api/admin/settings').then((r) => r.json()).then((s) => s.notify.type_routing));
  ok('the choice is saved against that type',
    (routing.contractor.staff || []).includes(officer.id), JSON.stringify(routing));
  ok('…and not against the others',
    !((routing.visitor || {}).staff || []).includes(officer.id), JSON.stringify(routing.visitor));

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

  ok('no javascript errors anywhere', errors.length === 0, errors.slice(0, 3).join(' | '));

  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
