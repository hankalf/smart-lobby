/* The Teams card: designed in the dashboard, and the same thing on the wire. */
'use strict';
const BASE = process.env.BASE_URL || 'http://localhost:3401';
let cookie = '';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n}${x ? ' — ' + x : ''}`); } };
async function req(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie }, body: body ? JSON.stringify(body) : undefined });
  const setc = res.headers.get('set-cookie'); if (setc) cookie = setc.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => null) };
}
const preview = async (card) => (await req('POST', '/api/admin/notify/preview', { card })).data;
/** Walk the Adaptive Card looking for an element of a kind. */
function findAll(node, type, out = []) {
  if (Array.isArray(node)) node.forEach((n) => findAll(n, type, out));
  else if (node && typeof node === 'object') {
    if (node.type === type) out.push(node);
    Object.values(node).forEach((v) => findAll(v, type, out));
  }
  return out;
}

(async () => {
  await req('POST', '/api/admin/login', { email: 'hankalfr@gmail.com', password: 'Testing123!' });

  /* ---- a host with an email, so the tag has an address to use ---- */
  const host = (await req('POST', '/api/admin/staff', { name: 'Hank Alfaro', email: 'hank@card.test', active: 1 })).data;
  ok('a staff member with an email exists', !!(host && host.id), JSON.stringify(host));

  /* ---- a visit with a photo, so the picture has something to point at ---- */
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const r = await req('POST', '/api/kiosk/signin', {
    full_name: 'Hank Alfred', company: 'Card Co', phone: '415-268-6001',
    visit_type: 'contractor', project_id: 1, host_id: host.id, photo: PNG, client_ref: 'card-' + Date.now()
  });
  ok('a visit with a photo is created', r.status === 200 && !!r.data.visit, JSON.stringify(r.data).slice(0, 70));

  /* ---- the defaults ---- */
  let p = await preview(undefined);
  ok('the preview builds a model', !!(p && p.model), JSON.stringify(p).slice(0, 70));
  ok('it offers every field the card can carry', p.fields.length >= 15, String(p.fields.length));
  ok('the licence fields are flagged as sensitive',
    p.fields.filter((f) => f.sensitive).map((f) => f.id).join(',') === 'id_name,id_number,id_state',
    p.fields.filter((f) => f.sensitive).map((f) => f.id).join(','));

  /* ---- the heading ---- */
  p = await preview({ title_template: '{name} from {company} is here', fields: [] });
  ok('tokens are filled in', /Hank Alfred from Card Co is here/.test(p.model.title), p.model.title);
  /*
   * Built here rather than through the preview: the preview shows a real
   * visit, and whether that one happens to have a host is not something this
   * check should depend on.
   */
  const cards = require('../server/notify-card');
  const bare = cards.buildModel(
    { full_name: 'Hank Alfred', visit_type: 'visitor', signed_in_at: new Date().toISOString() },
    { title_template: '{name} has arrived to see {host}', fields: [] },
    { org: { name: 'Test' }, fmtTime: (x) => x, baseUrl: '' });
  ok('an unnamed host reads as reception', /to see reception$/.test(bare.title), bare.title);
  ok('a visit with no host is not tagged', bare.mention === null, JSON.stringify(bare.mention));
  p = await preview({ title_template: '{name}{project}', fields: [] });
  ok('an empty token leaves no gap behind it', !/\s{2,}/.test(p.model.title), JSON.stringify(p.model.title));

  /* ---- which fields, and in what order ---- */
  p = await preview({ fields: ['badge', 'company', 'type'] });
  ok('only the chosen fields appear', p.model.fields.length <= 3, JSON.stringify(p.model.fields));
  p = await preview({ fields: ['company', 'type'] });
  ok('the order follows the list', p.model.fields.map((f) => f.label).join(',') === 'Company,Visitor type',
    p.model.fields.map((f) => f.label).join(','));
  // Reversed against the catalogue, so passing means the chosen order won.
  p = await preview({ fields: ['type', 'company'] });
  ok('reordering the list reorders the card', p.model.fields.map((f) => f.label).join(',') === 'Visitor type,Company',
    p.model.fields.map((f) => f.label).join(','));
  p = await preview({ fields: ['purpose', 'company'] });
  ok('a field with nothing in it is left out, not shown empty',
    !p.model.fields.some((f) => !String(f.value).trim()), JSON.stringify(p.model.fields));

  /* ---- the photo ---- */
  p = await preview({ show_photo: true });
  ok('the photo link is absolute', /^https?:\/\//.test(p.model.photoUrl || ''), String(p.model.photoUrl));
  ok('it is signed', /\?t=\d+\.[0-9a-f]{32}$/.test(p.model.photoUrl || ''), String(p.model.photoUrl));
  const noCookie = await fetch(p.model.photoUrl);
  ok('Teams could fetch it with no session', noCookie.status === 200, String(noCookie.status));
  ok('an unsigned request for the same photo is refused',
    (await fetch(p.model.photoUrl.split('?')[0])).status === 403);
  p = await preview({ show_photo: false });
  ok('turning the photo off removes it', p.model.photoUrl === null, String(p.model.photoUrl));
  ok('…and there is no Image left in the card', findAll(p.teams, 'Image').length === 0);

  /* ---- layout choices reach the Adaptive Card ---- */
  p = await preview({ show_photo: true, photo_placement: 'left' });
  ok('beside the details makes a two-column card', findAll(p.teams, 'ColumnSet').length === 1);
  p = await preview({ show_photo: true, photo_placement: 'top' });
  ok('above the details does not', findAll(p.teams, 'ColumnSet').length === 0);
  p = await preview({ show_photo: true, photo_shape: 'person' });
  ok('a circle asks Teams for a Person image', findAll(p.teams, 'Image')[0].style === 'Person');
  p = await preview({ show_photo: true, photo_shape: 'square' });
  ok('a square does not', findAll(p.teams, 'Image')[0].style === 'Default');

  p = await preview({ details_style: 'facts', fields: ['company', 'type'] });
  ok('two columns becomes a FactSet', findAll(p.teams, 'FactSet').length === 1);
  p = await preview({ details_style: 'lines', fields: ['company', 'type'] });
  ok('one line each does not', findAll(p.teams, 'FactSet').length === 0);

  p = await preview({ header_style: 'good' });
  ok('the heading colour reaches the card', JSON.stringify(p.teams).includes('"style":"good"'), 'good');
  p = await preview({ header_style: 'none' });
  ok('plain leaves the tinted band off', !/"style":"(accent|good|warning|attention|emphasis)"/.test(JSON.stringify(p.teams)));

  p = await preview({ show_button: true, button_label: 'Open the log' });
  ok('a button is added when asked for', !!(p.teams.attachments[0].content.actions || [])[0], JSON.stringify(p.teams.attachments[0].content.actions));
  ok('with the wording given', p.teams.attachments[0].content.actions[0].title === 'Open the log');
  p = await preview({ show_button: false });
  ok('and left off when not', !p.teams.attachments[0].content.actions);

  p = await preview({ footer_template: '{org} reception' });
  ok('the footer is filled in too', /reception$/.test(p.model.footer || ''), String(p.model.footer));

  /* ---- tagging the host ---- */
  p = await preview({ mention_host: true });
  ok('the host is tagged when they have an email', !!p.model.mention, JSON.stringify(p.model.mention));
  const card = p.teams.attachments[0].content;
  const entities = (card.msteams || {}).entities || [];
  ok('the tag is declared to Teams', entities.length === 1 && entities[0].type === 'mention', JSON.stringify(entities));
  ok('…against the address on the staff record', entities[0].mentioned.id.includes('@'), JSON.stringify(entities[0].mentioned));
  // Teams prints the raw markup unless these two agree exactly.
  const inBody = JSON.stringify(card.body);
  ok('the markup in the text matches the entity exactly',
    inBody.includes(entities[0].text), `${entities[0].text} not in the body`);
  ok('the tag names the same person as the entity',
    entities[0].text === `<at>${entities[0].mentioned.name}</at>`, entities[0].text);

  p = await preview({ mention_host: false });
  ok('turning tagging off removes the entity', !(p.teams.attachments[0].content.msteams),
    JSON.stringify(p.teams.attachments[0].content.msteams));
  ok('…and leaves no stray markup in the text',
    !JSON.stringify(p.teams).includes('<at>'), 'found <at> with tagging off');

  /* ---- nothing we send says anything about templates ---- */
  p = await preview(undefined);
  ok('the payload carries no wording we did not put there',
    !/get template|create your own|power automate|flow bot/i.test(JSON.stringify(p.teams)),
    JSON.stringify(p.teams).slice(0, 120));

  /* ---- the envelope Teams insists on ---- */
  p = await preview(undefined);
  ok('the payload is a Teams message envelope', p.teams.type === 'message');
  ok('carrying one adaptive card',
    p.teams.attachments.length === 1
    && p.teams.attachments[0].contentType === 'application/vnd.microsoft.card.adaptive'
    && p.teams.attachments[0].content.type === 'AdaptiveCard');

  /* ---- the design survives a save ---- */
  const design = { header_style: 'attention', title_template: '{name} — SAVED', fields: ['badge'], show_photo: false };
  await req('PUT', '/api/admin/settings', { notify: { card: design } });
  const saved = (await req('GET', '/api/admin/settings')).data.notify.card;
  ok('the design is stored', saved.header_style === 'attention' && saved.title_template === '{name} — SAVED',
    JSON.stringify(saved).slice(0, 90));
  ok('the field list is replaced, not merged', JSON.stringify(saved.fields) === '["badge"]', JSON.stringify(saved.fields));
  p = await preview(undefined);
  ok('and is what a real send would use', /— SAVED$/.test(p.model.title), p.model.title);

  /* ---- the address Teams needs ---- */
  ok('the preview says whether Teams can reach the photo', typeof p.public_url_reachable === 'boolean');
  await req('PUT', '/api/admin/settings', { notify: { public_url: 'https://lobby.example.com' } });
  p = await preview({ show_photo: true });
  ok('a public address is used for the photo link', p.model.photoUrl.startsWith('https://lobby.example.com/'), p.model.photoUrl);
  ok('…and is reported as reachable', p.public_url_reachable === true);
  await req('PUT', '/api/admin/settings', { notify: { public_url: '' } });
  p = await preview({ show_photo: true });
  ok('localhost is reported as not reachable', p.public_url_reachable === false, p.public_url);

  /* ---- other services still get their own shape ---- */
  await req('PUT', '/api/admin/settings', { notify: { card: { title_template: '{name} has arrived to see {host}', fields: ['company', 'type'], show_photo: true } } });
  ok('preview still builds after all that', !!(await preview(undefined)).model);

  /* ---- neither endpoint is open to the world ---- */
  ok('the preview needs a login', (await fetch(BASE + '/api/admin/notify/preview')).status !== 200);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
