/*
 * The one box that finds anything — and, more to the point, that finds only
 * what the person typing into it could already open.
 *
 * A global search is the classic way to walk straight through a permission
 * model. Somebody who books deliveries in has no business reading the visitor
 * registry, and it would be no defence that the only route to it was a search
 * box rather than a page. So most of this suite is about who gets nothing.
 *
 * The other half is the part people notice: that a name typed the way it is
 * written on a badge, or a phone number typed with its brackets in, actually
 * finds the record.
 */
'use strict';
const BASE = process.env.BASE_URL || 'http://localhost:3401';
let cookie = '';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n}${x ? ' — ' + x : ''}`); } };

async function req(method, p, body) {
  const res = await fetch(BASE + p, {
    method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie },
    body: body ? JSON.stringify(body) : undefined
  });
  const setc = res.headers.get('set-cookie'); if (setc) cookie = setc.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => null) };
}

const find = (q) => req('GET', `/api/admin/search?q=${encodeURIComponent(q)}`).then((r) => r.data);
const titlesIn = (data, key) => {
  const g = (data.groups || []).find((x) => x.key === key);
  return g ? g.results.map((r) => r.title) : [];
};

/** A login at a given level, settled past its temporary password. */
async function loginAs(role) {
  const owner = cookie;
  const who = { email: `${role}-search-${Date.now()}@example.test`, password: 'Testing123!',
    name: `${role} tester`, role };
  const made = (await req('POST', '/api/admin/users', who)).data;
  cookie = '';
  await req('POST', '/api/admin/login', { email: who.email, password: who.password });
  await req('POST', '/api/admin/me/password', { current: who.password, password: 'chosen-by-them-1' });
  return { id: made && made.id, owner };
}

(async () => {
  await req('POST', '/api/admin/login', { email: 'owner@example.test', password: 'Testing123!' });

  /* ---- something of every kind to find ---- */
  const host = (await req('POST', '/api/admin/staff',
    { name: 'Wilhelmina Searchable', email: 'wilhelmina@example.test', department: 'Groundworks', active: 1 })).data;
  const project = (await req('POST', '/api/admin/projects',
    { name: 'Searchable Yard Works', code: 'SYW-9', active: 1 })).data;
  const device = (await req('POST', '/api/admin/devices', { name: 'Searchable Gate Tablet' })).data;
  const signin = await req('POST', '/api/kiosk/signin', {
    full_name: 'Quintus Searchable', company: 'Searchable Scaffolding Ltd',
    phone: '4155550142', visit_type: 'visitor', host_id: host.id,
    client_ref: `search-${Date.now()}`
  });
  ok('a visitor exists to be found', signin.status === 200, JSON.stringify(signin.data).slice(0, 90));
  const visitId = signin.data.visit.id;

  /* ---- the owner finds all of it ---- */
  let r = await find('Searchable');
  const kinds = (r.groups || []).map((g) => g.key);
  ok('one query reaches people, visits, firms, staff, jobs and tablets',
    ['visitor', 'visit', 'company', 'staff', 'project', 'device'].every((k) => kinds.includes(k)),
    kinds.join(','));
  ok('…and the person is in it', titlesIn(r, 'visitor').includes('Quintus Searchable'),
    titlesIn(r, 'visitor').join(','));
  ok('…the firm', titlesIn(r, 'company').includes('Searchable Scaffolding Ltd'));
  ok('…the member of staff', titlesIn(r, 'staff').includes('Wilhelmina Searchable'));
  ok('…the job', titlesIn(r, 'project').includes('Searchable Yard Works'));
  ok('…and the tablet', titlesIn(r, 'device').includes('Searchable Gate Tablet'));

  /* ---- the ways people actually type ---- */
  ok('a name typed in the wrong case still finds it',
    titlesIn(await find('quintus'), 'visitor').includes('Quintus Searchable'));
  /*
   * A number is read off a badge or a phone screen with its brackets and
   * dashes in. Stored without them, so both have to be reduced to digits
   * before they can meet.
   */
  ok('a phone number typed with brackets and dashes finds the person',
    titlesIn(await find('(415) 555-0142'), 'visitor').includes('Quintus Searchable'));
  ok('a job code finds the job', titlesIn(await find('SYW-9'), 'project').includes('Searchable Yard Works'));
  /*
   * A badge number is what reception has in front of them when somebody hands
   * a lanyard back, or when a badge turns up on a desk. Badges are off on a
   * fresh site, so this switches them on for one sign-in rather than asserting
   * against whatever the shared database happens to be set to.
   */
  const badgeWas = (await req('GET', '/api/admin/settings')).data.badge;
  await req('PUT', '/api/admin/settings', { badge: { ...badgeWas, enabled: true } });
  const badged = await req('POST', '/api/kiosk/signin', {
    full_name: 'Badged Searchable', phone: '4155550143', visit_type: 'visitor',
    host_id: host.id, client_ref: `search-badge-${Date.now()}`
  });
  const badgeNo = ((badged.data || {}).visit || {}).badge_no;
  ok('a sign-in with badges on is given a number', !!badgeNo, JSON.stringify(badged.data).slice(0, 90));
  ok('…and that number finds the visit it is on',
    titlesIn(await find(badgeNo), 'visit').includes('Badged Searchable'),
    JSON.stringify(titlesIn(await find(badgeNo), 'visit')));
  if (badged.data && badged.data.visit) await req('DELETE', `/api/admin/visits/${badged.data.visit.id}`);
  await req('PUT', '/api/admin/settings', { badge: badgeWas });

  /* ---- a search that is not yet a search ---- */
  r = await find('a');
  ok('a single letter is not searched, and says so', r.too_short === true && !r.groups.length,
    JSON.stringify(r).slice(0, 80));
  r = await find('zzzzz nothing like this exists');
  ok('nothing found comes back empty rather than as an error',
    Array.isArray(r.groups) && r.groups.length === 0, JSON.stringify(r).slice(0, 80));

  /*
   * A LIKE wildcard typed by a person is a search for that character, not a
   * request to match everything. Unescaped, "%" alone would return the entire
   * registry to anybody who typed it.
   */
  r = await find('%%');
  ok('a percent sign is searched for, not obeyed',
    !titlesIn(r, 'visitor').includes('Quintus Searchable'), titlesIn(r, 'visitor').join(','));

  /*
   * ---- who is allowed to find what ----
   *
   * The heart of it. Each level searches exactly the areas it can already
   * reach from the menu, and a source it cannot reach is never queried — so
   * the answer is not "filtered to nothing", it is "not asked".
   */
  const clerk = await loginAs('clerk');
  r = await find('Searchable');
  ok('a clerk, who has only drivers and deliveries, finds nothing at all',
    r.groups.length === 0, JSON.stringify(r.groups.map((g) => g.key)));
  ok('…and the visitor registry is not among the things searched for them',
    !r.searched.includes('visitor') && r.withheld.includes('visitor'),
    `searched: ${r.searched.join(',')}`);
  ok('…nor the visits', !r.searched.includes('visit'), r.searched.join(','));
  /* Nothing leaks through the shape of the answer either. */
  ok('…and no name reaches them in any form',
    !JSON.stringify(r).includes('Quintus') && !JSON.stringify(r).includes('Wilhelmina'),
    JSON.stringify(r).slice(0, 120));

  cookie = clerk.owner;
  await req('DELETE', `/api/admin/users/${clerk.id}`);

  const desk = await loginAs('reception');
  r = await find('Searchable');
  ok('reception finds the people and firms they work with all day',
    titlesIn(r, 'visitor').includes('Quintus Searchable')
    && titlesIn(r, 'company').includes('Searchable Scaffolding Ltd'));
  /*
   * Devices are configuration. Reception cannot open the Devices page, so a
   * search must not be the way round it.
   */
  ok('…but not the tablets, which are configuration',
    !r.searched.includes('device') && r.withheld.includes('device'),
    `searched: ${r.searched.join(',')}`);
  ok('…and no tablet name reaches them', !JSON.stringify(r).includes('Searchable Gate Tablet'));

  cookie = desk.owner;
  await req('DELETE', `/api/admin/users/${desk.id}`);

  /* ---- and a signed-out browser gets nothing ---- */
  const anon = await fetch(`${BASE}/api/admin/search?q=Searchable`);
  ok('a search without a login is refused outright', anon.status === 401 || anon.status === 403,
    String(anon.status));

  /* ---- results say where to go ---- */
  r = await find('Searchable');
  const person = (r.groups.find((g) => g.key === 'visitor') || {}).results[0];
  ok('every result says which page opens it and which record to show',
    person && person.go && person.go.view === 'visitors' && Number.isInteger(person.go.open),
    JSON.stringify(person && person.go));

  /* ---- nothing was quietly broken ---- */
  ok('no source failed behind the scenes', !r.broken, JSON.stringify(r.broken || []));

  /* ---- put the site back ---- */
  await req('DELETE', `/api/admin/visits/${visitId}`);
  await req('DELETE', `/api/admin/devices/${device.id}`);
  await req('DELETE', `/api/admin/projects/${project.id}`);
  await req('DELETE', `/api/admin/staff/${host.id}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
