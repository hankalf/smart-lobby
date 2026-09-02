/* Access levels — enforced on every request, not just hidden in the menu. */
'use strict';
const BASE = process.env.BASE_URL || 'http://localhost:3401';
let cookie = '';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n}${x ? ' — ' + x : ''}`); } };
async function req(method, p, body, jar) {
  const res = await fetch(BASE + p, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(jar === null ? {} : { cookie: jar || cookie }) },
    body: body ? JSON.stringify(body) : undefined
  });
  const setc = res.headers.get('set-cookie');
  if (setc && jar === undefined) cookie = setc.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => null), cookie: setc ? setc.split(';')[0] : null };
}
const signIn = async (email, password) =>
  (await req('POST', '/api/admin/login', { email, password }, null));

(async () => {
  await req('POST', '/api/admin/login', { email: 'owner@example.test', password: 'Testing123!' });

  const levels = (await req('GET', '/api/admin/roles')).data;
  ok('the access levels are listed', Array.isArray(levels) && levels.length === 4, JSON.stringify((levels || []).map((l) => l.key)));
  const byKey = Object.fromEntries(levels.map((l) => [l.key, l]));
  ok('reception is the front desk',
    JSON.stringify(byKey.reception.areas) === JSON.stringify(['dashboard', 'visits', 'visitors', 'projects', 'reports']),
    JSON.stringify(byKey.reception.areas));
  ok('a clerk gets drivers and deliveries',
    JSON.stringify(byKey.clerk.areas) === JSON.stringify(['dashboard', 'drivers', 'deliveries']),
    JSON.stringify(byKey.clerk.areas));
  ok('a manager is reception and clerk together',
    byKey.reception.areas.every((a) => byKey.manager.areas.includes(a))
    && byKey.clerk.areas.every((a) => byKey.manager.areas.includes(a)),
    JSON.stringify(byKey.manager.areas));
  ok('…but not the settings', !byKey.manager.areas.includes('admin'), JSON.stringify(byKey.manager.areas));
  ok('an administrator gets everything', byKey.admin.areas.includes('admin'));

  /* ---- a login for each level, made through the staff list ---- */
  const staff = {};
  const jars = {};
  for (const level of ['reception', 'clerk', 'manager']) {
    const person = (await req('POST', '/api/admin/staff',
      { name: `John Doe ${level}`, email: `${level}@x.test`, active: 1 })).data;
    staff[level] = person;
    const made = await req('POST', '/api/admin/users', {
      email: `${level}@x.test`, password: 'temporary123', name: person.name, role: level, host_id: person.id
    });
    ok(`a ${level} login can be created against a staff member`,
      made.status === 200 && made.data.role === level, JSON.stringify(made.data).slice(0, 90));
    ok(`…and is tied to that staff record`, made.data.host_id === person.id, String(made.data.host_id));
    ok(`…with the password marked temporary`, made.data.must_change_password === 1, String(made.data.must_change_password));
  }

  /* ---- a temporary password blocks everything but changing it ---- */
  let r = await signIn('reception@x.test', 'temporary123');
  ok('they can sign in with the temporary password', r.status === 200, JSON.stringify(r.data).slice(0, 70));
  ok('…and are told they must change it', r.data.user.must_change_password === true, JSON.stringify(r.data.user));
  const fresh = r.cookie;
  ok('reading who they are still works', (await req('GET', '/api/admin/me', null, fresh)).status === 200);
  r = await req('GET', '/api/admin/visits?limit=5', null, fresh);
  ok('but nothing else does yet', r.status === 403 && r.data.error === 'password_change_required', JSON.stringify(r.data));
  r = await req('GET', '/api/admin/dashboard', null, fresh);
  ok('not even the dashboard', r.status === 403, String(r.status));

  r = await req('POST', '/api/admin/me/password', { current: 'temporary123', password: 'chosen-by-me-1' }, fresh);
  ok('choosing their own password works', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
  r = await signIn('reception@x.test', 'chosen-by-me-1');
  ok('…and it is no longer temporary', r.data.user.must_change_password === false, JSON.stringify(r.data.user));
  jars.reception = r.cookie;
  ok('the old temporary password stops working', (await signIn('reception@x.test', 'temporary123')).status !== 200);

  for (const level of ['clerk', 'manager']) {
    await req('POST', '/api/admin/me/password', { current: 'temporary123', password: `chosen-${level}-1` },
      (await signIn(`${level}@x.test`, 'temporary123')).cookie);
    jars[level] = (await signIn(`${level}@x.test`, `chosen-${level}-1`)).cookie;
  }

  /* ---- what each level may actually reach ---- */
  const ALLOWED = {
    reception: ['/api/admin/dashboard', '/api/admin/visits?limit=5', '/api/admin/visitors', '/api/admin/projects', '/api/admin/stats'],
    clerk: ['/api/admin/dashboard', '/api/admin/deliveries', '/api/admin/drivers'],
    manager: ['/api/admin/dashboard', '/api/admin/visits?limit=5', '/api/admin/visitors', '/api/admin/deliveries', '/api/admin/drivers', '/api/admin/projects']
  };
  const REFUSED = {
    reception: ['/api/admin/deliveries', '/api/admin/drivers', '/api/admin/settings', '/api/admin/users', '/api/admin/backups', '/api/admin/archive', '/api/admin/audit', '/api/admin/devices'],
    clerk: ['/api/admin/visits?limit=5', '/api/admin/visitors', '/api/admin/settings', '/api/admin/users', '/api/admin/backups', '/api/admin/audit'],
    manager: ['/api/admin/settings', '/api/admin/users', '/api/admin/backups', '/api/admin/archive', '/api/admin/audit', '/api/admin/devices', '/api/admin/board']
  };

  for (const [level, paths] of Object.entries(ALLOWED)) {
    const bad = [];
    for (const p of paths) {
      const res = await req('GET', p, null, jars[level]);
      if (res.status !== 200) bad.push(`${p} -> ${res.status}`);
    }
    ok(`a ${level} can reach everything in their level`, bad.length === 0, bad.join(', '));
  }
  for (const [level, paths] of Object.entries(REFUSED)) {
    const leaked = [];
    for (const p of paths) {
      const res = await req('GET', p, null, jars[level]);
      if (res.status !== 403) leaked.push(`${p} -> ${res.status}`);
    }
    ok(`a ${level} is refused everything outside it`, leaked.length === 0, leaked.join(', '));
  }

  /* ---- every route the API declares, against every level ---- */

  /*
   * The hand-written lists above say what each level should reach. This sweeps
   * everything the server actually declares, so a route nobody classified
   * cannot quietly sit open — and so the enforcement and the policy are
   * checked against each other rather than only against my memory.
   */
  const fs = require('fs');
  const path = require('path');
  const roleMap = require('../server/roles');
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'admin.js'), 'utf8');
  const declared = [...new Set((source.match(/router\.get\('\/[^']*'/g) || [])
    .map((m) => m.slice("router.get('".length, -1))
    .filter((r) => !r.includes(':')))];
  ok('the sweep found the routes to probe', declared.length > 20, String(declared.length));

  for (const level of ['reception', 'clerk', 'manager']) {
    const wrong = [];
    for (const route of declared) {
      const area = roleMap.areaForRequest('GET', route);
      const shouldPass = area === null || roleMap.can(level, area);
      const res = await req('GET', `/api/admin${route}`, null, jars[level]);
      const didPass = res.status !== 403;
      if (shouldPass !== didPass) wrong.push(`${route} expected ${shouldPass ? 'allowed' : '403'} got ${res.status}`);
    }
    ok(`every declared route behaves as ${level}'s level says`, wrong.length === 0, wrong.join(' | '));
  }

  // The one that was wrong: reporting analytics reached by a level without reports.
  ok('reporting figures need the reports area',
    (await req('GET', '/api/admin/stats', null, jars.clerk)).status === 403,
    String((await req('GET', '/api/admin/stats', null, jars.clerk)).status));
  ok('…and reception, who has reports, still gets them',
    (await req('GET', '/api/admin/stats', null, jars.reception)).status === 200);

  /* ---- the on-site board is offered to every level, its settings are not ---- */
  for (const level of ['reception', 'clerk', 'manager']) {
    const res = await req('GET', '/api/admin/board/link', null, jars[level]);
    ok(`a ${level} can find the on-site board`, res.status === 200, `${res.status}`);
    ok(`…and is told only whether it is on and where`,
      res.status === 200 && Object.keys(res.data || {}).sort().join(',') === 'enabled,url',
      JSON.stringify(res.data));
  }
  ok('the board settings stay administrative',
    (await req('GET', '/api/admin/board', null, jars.reception)).status === 403,
    String((await req('GET', '/api/admin/board', null, jars.reception)).status));
  ok('…so the camera address is not handed out with the link',
    !JSON.stringify((await req('GET', '/api/admin/board/link', null, jars.clerk)).data).includes('camera'));
  r = await req('POST', '/api/admin/board/key', { enabled: true }, jars.reception);
  ok('and reception cannot reissue the key', r.status === 403, String(r.status));

  /* ---- the menu is not the control ---- */
  const me = (await req('GET', '/api/admin/me', null, jars.reception)).data;
  ok('the dashboard is told what to draw', Array.isArray(me.areas) && me.areas.includes('visits'), JSON.stringify(me.areas));
  ok('…and not told it can reach the settings', !me.areas.includes('admin'), JSON.stringify(me.areas));
  ok('branding is readable by everyone, so times are on the site clock',
    (await req('GET', '/api/admin/branding', null, jars.clerk)).status === 200);
  ok('…but it does not carry the Teams link or the board key',
    !JSON.stringify((await req('GET', '/api/admin/branding', null, jars.clerk)).data).includes('webhook'),
    'webhook found in branding');

  /* ---- writing is checked too, not only reading ---- */
  r = await req('PUT', '/api/admin/settings', { org: { name: 'Taken Over' } }, jars.manager);
  ok('a manager cannot change the settings', r.status === 403, `${r.status} ${JSON.stringify(r.data)}`);
  r = await req('POST', '/api/admin/staff', { name: 'Snuck In', active: 1 }, jars.reception);
  ok('reception can read the staff list but not add to it', r.status === 403, String(r.status));
  ok('…and reading it still works', (await req('GET', '/api/admin/staff', null, jars.reception)).status === 200);
  r = await req('DELETE', '/api/admin/visits/1', null, jars.clerk);
  ok('a clerk cannot delete a visit', r.status === 403, String(r.status));

  /* ---- nobody can promote themselves ---- */
  const myId = (await req('GET', '/api/admin/me', null, jars.manager)).data.id;
  r = await req('PATCH', `/api/admin/users/${myId}`, { role: 'admin' }, jars.manager);
  ok('a manager cannot make themselves an administrator', r.status === 403, `${r.status} ${JSON.stringify(r.data)}`);

  /* ---- and the owner stays the owner ---- */
  const users = (await req('GET', '/api/admin/users')).data;
  const owner = users.find((u) => u.role === 'owner');
  r = await req('PATCH', `/api/admin/users/${owner.id}`, { role: 'reception' });
  ok('the owner cannot be demoted', r.status === 400 && r.data.error === 'owner_fixed', JSON.stringify(r.data));
  r = await req('DELETE', `/api/admin/users/${owner.id}`);
  ok('…nor removed by themselves', r.status === 400, String(r.status));

  /* ---- an administrator can be granted, and only by the owner ---- */
  r = await req('PATCH', `/api/admin/users/${users.find((u) => u.role === 'manager').id}`, { role: 'admin' });
  ok('the owner can promote somebody to administrator', r.status === 200 && r.data.role === 'admin', JSON.stringify(r.data));
  const adminJar = (await signIn('manager@x.test', 'chosen-manager-1')).cookie;
  ok('and then they can reach the settings', (await req('GET', '/api/admin/settings', null, adminJar)).status === 200);
  r = await req('POST', '/api/admin/users',
    { email: 'second-admin@x.test', password: 'temporary123', role: 'admin' }, adminJar);
  ok('an administrator cannot mint another administrator', r.status === 403, `${r.status} ${JSON.stringify(r.data)}`);
  r = await req('POST', '/api/admin/users',
    { email: 'their-clerk@x.test', password: 'temporary123', role: 'clerk' }, adminJar);
  ok('…but can create the levels below', r.status === 200 && r.data.role === 'clerk', JSON.stringify(r.data).slice(0, 80));

  /* ---- an unknown level is refused rather than quietly allowed ---- */
  r = await req('POST', '/api/admin/users', { email: 'nope@x.test', password: 'temporary123', role: 'superuser' });
  ok('an invented access level is refused', r.status === 400 && r.data.error === 'unknown_role', JSON.stringify(r.data));

  /* ---- signed out is still signed out ---- */
  ok('none of this is reachable without signing in',
    (await fetch(`${BASE}/api/admin/roles`)).status === 401);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
