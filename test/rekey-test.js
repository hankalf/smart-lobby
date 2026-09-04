/*
 * Changing a visitor type's key, and everything filed under it moving with it.
 *
 * A visitor type has a key and a label. The label is what everybody reads; the
 * key is what every visit is stored against, derived from the label once and
 * then left alone. Rename Interview to UniFirst and the key stays `interview`
 * for ever — nothing breaks, but the data says one thing and the screen says
 * another, and every per-type setting is filed under a name the site stopped
 * using.
 *
 * So the interesting checks here are not "did the key change". They are:
 *
 *   - did *everything* move — visits, bookings, the form, the flow, the
 *     wording, the notification routing, the type's own channel, the card
 *     designs, the certificate rules;
 *   - does the type still behave identically afterwards, which is the whole
 *     point of a rename as against a new type;
 *   - and when it is refused, is nothing left half-moved.
 *
 * That last one is why this exists as its own suite. A rename that moved the
 * visits but not the routing would leave a visitor type that posts nowhere,
 * and would do it silently.
 */
'use strict';
const http = require('http');
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
  return { status: res.status, data: await res.json().catch(() => null) };
}

const posts = [];
const hooks = http.createServer((q, res) => {
  let b = '';
  q.on('data', (c) => { b += c; });
  q.on('end', () => { posts.push({ path: q.url, body: JSON.parse(b || '{}') }); res.writeHead(202).end(''); });
});

(async () => {
  await new Promise((r) => hooks.listen(2801, '127.0.0.1', r));
  const OWN = 'http://127.0.0.1:2801/webhook.office.com/its-own-channel';
  await req('POST', '/api/admin/login', { email: 'owner@example.test', password: 'Testing123!' });

  const settingsNow = () => req('GET', '/api/admin/settings').then((r) => r.data);
  const project = (await req('GET', '/api/admin/projects')).data[0];

  /* ---- a type, renamed on screen but not underneath ---- */

  const before = await settingsNow();
  const types = before.types;
  ok('the fixtures have an interview type to rename', types.some((t) => t.key === 'interview'),
    types.map((t) => t.key).join(','));

  // Everything a site would have set up against it by now, including changes
  // to the stock form and flow — so the checks below can tell "the site's
  // settings moved" apart from "a key with the default settings exists".
  const stockDetails = JSON.parse(JSON.stringify(before.details.interview));
  await req('PUT', '/api/admin/settings', {
    details: { interview: { vehicle: 'required' } },
    flow: { interview: ['photo', 'details', 'documents', 'induction'] },
    types: types.map((t) => (t.key === 'interview' ? { ...t, label: 'UniFirst' } : t)),
    notify: {
      on_signin: true,
      types_notified: { interview: true },
      type_routing: { interview: { staff: [], webhook_url: OWN, events: { signin: true } } },
      cards: { signin: { by_type: { interview: { title_template: '{name} — UniFirst arrival' } } } }
    },
    compliance: { required: { interview: ['insurance'] } },
    wording: { interview: { company: 'Employer' } }
  });

  const renamedLabel = (await settingsNow()).types.find((t) => t.key === 'interview');
  ok('the label changes on its own, as it always could', renamedLabel.label === 'UniFirst',
    JSON.stringify(renamedLabel));

  // Somebody arrives under the old key, as everyone has been doing.
  // An interview needs somebody to be interviewed by, which is rather the point
  // of the type — so this suite makes one rather than working around it.
  const host = (await req('POST', '/api/admin/staff',
    { name: 'Yusra Benkhadra', email: 'yusra@rekey.test', active: 1 })).data;
  const signIn = (type, name) => req('POST', '/api/kiosk/signin', {
    full_name: name, company: 'Ashcroft Surveying', phone: '415-268-0700',
    visit_type: type, host_id: host.id, project_id: project && project.id,
    // The form above was customised to require one, which is the point of
    // customising it — so this gives it one rather than working around it.
    vehicle_reg: 'AB12 CDE',
    client_ref: `rk-${Date.now()}-${Math.random()}`
  });
  let r = await signIn('interview', 'Wilhelmina Achterberg');
  ok('a visit is recorded against the old key', r.status === 200, JSON.stringify(r.data).slice(0, 80));

  await req('POST', '/api/admin/expected', {
    full_name: 'Booked Beforehand', visit_type: 'interview',
    expected_on: new Date().toISOString().slice(0, 10)
  });

  /* ---- the rename ---- */

  r = await req('POST', '/api/admin/settings/types/interview/rekey', { to: 'UniFirst' });
  ok('the key can be changed to match the name', r.status === 200 && r.data.ok === true && r.data.to === 'unifirst',
    JSON.stringify(r.data).slice(0, 140));
  ok('…and it says what it moved', r.data.moved.visits >= 1 && r.data.moved.expected >= 1,
    JSON.stringify(r.data.moved));

  const after = await settingsNow();

  ok('the type now has the key its name would give it',
    after.types.some((t) => t.key === 'unifirst' && t.label === 'UniFirst')
    && !after.types.some((t) => t.key === 'interview'),
    after.types.map((t) => `${t.key}:${t.label}`).join(', '));

  /*
   * Every per-type setting, checked one at a time. A rename that misses one
   * leaves a setting that silently stops applying — which looks exactly like
   * the setting never having worked.
   */
  const gone = (o) => o && !('interview' in o);

  /*
   * The form and the flow are checked by what they say rather than by whether
   * the old key is absent, because for one of the four built-in types it never
   * can be: those have entries in the shipped defaults, and a stored settings
   * section is merged over the defaults rather than replacing them, so the
   * stock entry comes back under the old key however the rename is written.
   *
   * That leftover is inert — no visitor type has that key any more, so nothing
   * ever reads it. What matters, and what these check, is that the *site's own*
   * settings went to the new key and did not stay behind at the old one.
   */
  ok('the form it asks for moved with it',
    after.details.unifirst && after.details.unifirst.vehicle === 'required',
    JSON.stringify(after.details.unifirst));
  ok('…and did not stay behind under the old key',
    !after.details.interview || after.details.interview.vehicle === stockDetails.vehicle,
    JSON.stringify(after.details.interview));
  ok('the sign-in flow moved with it',
    Array.isArray(after.flow.unifirst) && after.flow.unifirst[0] === 'photo',
    JSON.stringify(after.flow.unifirst));
  ok('…and did not stay behind either',
    !after.flow.interview || after.flow.interview[0] === 'details',
    JSON.stringify(after.flow.interview));
  ok('the wording moved with it',
    after.wording.unifirst && after.wording.unifirst.company === 'Employer' && gone(after.wording),
    JSON.stringify(after.wording));
  ok('whether it is announced moved with it',
    after.notify.types_notified.unifirst === true && gone(after.notify.types_notified),
    JSON.stringify(after.notify.types_notified));
  ok('its own notification channel moved with it',
    after.notify.type_routing.unifirst && after.notify.type_routing.unifirst.webhook_url === OWN
    && gone(after.notify.type_routing),
    JSON.stringify(after.notify.type_routing).slice(0, 160));
  ok('its own card design moved with it',
    after.notify.cards.signin.by_type.unifirst
    && /UniFirst arrival/.test(after.notify.cards.signin.by_type.unifirst.title_template)
    && gone(after.notify.cards.signin.by_type),
    JSON.stringify(after.notify.cards.signin.by_type).slice(0, 160));
  ok('the certificates it must have moved with it',
    Array.isArray(after.compliance.required.unifirst) && gone(after.compliance.required),
    JSON.stringify(after.compliance.required));

  /*
   * And the defaults themselves are untouched by any of it.
   *
   * They used to be handed out by reference when nothing was stored over them,
   * so a caller that changed what it was given changed the defaults for the
   * whole process — every later read agreed, and nothing looked wrong until a
   * restart. A rename is exactly the kind of caller that does that.
   */
  const shipped = require('../server/settings').DEFAULTS;
  ok('the shipped defaults were not edited on the way through',
    Object.keys(shipped.details).join(',') === 'visitor,contractor,interview,driver'
    && Object.keys(shipped.flow).join(',') === 'visitor,contractor,interview,driver',
    `${Object.keys(shipped.details).join(',')} | ${Object.keys(shipped.flow).join(',')}`);

  /* ---- and the history came too ---- */

  const visits = (await req('GET', '/api/admin/visits?limit=200')).data;
  const rows = Array.isArray(visits) ? visits : visits.rows || [];
  const her = rows.find((v) => v.full_name === 'Wilhelmina Achterberg');
  ok('a visit recorded under the old key now reads as the new one',
    her && her.visit_type === 'unifirst', her && her.visit_type);
  ok('nothing is left filed under the old key at all',
    !rows.some((v) => v.visit_type === 'interview'),
    rows.filter((v) => v.visit_type === 'interview').length + ' left');

  const expected = (await req('GET', '/api/admin/expected')).data;
  const booked = (Array.isArray(expected) ? expected : expected.rows || [])
    .find((e) => e.full_name === 'Booked Beforehand');
  ok('a booking made before the rename came with it', booked && booked.visit_type === 'unifirst',
    booked && booked.visit_type);

  /*
   * The point of a rename rather than a new type: it goes on behaving the same.
   * An arrival under the new key must still reach the channel that was set up
   * under the old one.
   */
  posts.length = 0;
  r = await signIn('unifirst', 'Bartholomew Nkemelu');
  ok('somebody can sign in under the new key', r.status === 200, JSON.stringify(r.data).slice(0, 80));
  await new Promise((done) => setTimeout(done, 1500));
  ok('…and still reaches the channel that was set up under the old one',
    posts.some((p) => p.path.endsWith('/its-own-channel')), posts.map((p) => p.path).join(', '));
  ok('…with the design that was set up under the old one',
    /UniFirst arrival/.test(JSON.stringify(posts[0] || {})),
    JSON.stringify(posts[0] || {}).slice(0, 140));

  /* ---- and what it refuses ---- */

  r = await req('POST', '/api/admin/settings/types/nosuchtype/rekey', { to: 'whatever' });
  ok('a type that does not exist is refused', r.status === 404 && r.data.error === 'not_found',
    JSON.stringify(r.data));

  r = await req('POST', '/api/admin/settings/types/unifirst/rekey', { to: 'visitor' });
  ok('a key another type already uses is refused', r.status === 400 && r.data.error === 'taken',
    JSON.stringify(r.data));

  r = await req('POST', '/api/admin/settings/types/unifirst/rekey', { to: 'menu' });
  ok('a word the kiosk uses for itself is refused', r.status === 400 && r.data.error === 'reserved',
    JSON.stringify(r.data));

  r = await req('POST', '/api/admin/settings/types/unifirst/rekey', { to: '!!!' });
  ok('a name with nothing in it to make a key from is refused',
    r.status === 400 && r.data.error === 'bad_key', JSON.stringify(r.data));

  r = await req('POST', '/api/admin/settings/types/unifirst/rekey', { to: 'UniFirst' });
  ok('and renaming it to what it already is says so rather than churning the data',
    r.status === 400 && r.data.error === 'unchanged', JSON.stringify(r.data));

  /* Nothing above was allowed to half-move anything. */
  const still = await settingsNow();
  ok('a refused rename leaves everything exactly where it was',
    still.types.some((t) => t.key === 'unifirst')
    && !!still.notify.type_routing.unifirst
    && !!still.details.unifirst,
    still.types.map((t) => t.key).join(','));

  /* Put the fixtures back, so later suites find the types they expect. */
  await req('POST', '/api/admin/settings/types/unifirst/rekey', { to: 'interview' });
  await req('PUT', '/api/admin/settings', {
    types: (await settingsNow()).types.map((t) => (t.key === 'interview' ? { ...t, label: 'Interview' } : t)),
    notify: {
      types_notified: {}, type_routing: {},
      cards: { signin: { by_type: {} } }
    },
    compliance: { required: {} },
    wording: {}
  });
  const back = await settingsNow();
  ok('and the fixtures are back the way the other suites expect them',
    back.types.some((t) => t.key === 'interview' && t.label === 'Interview'),
    back.types.map((t) => `${t.key}:${t.label}`).join(', '));

  await new Promise((done) => hooks.close(done));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
