/* Edge cases the happy-path suites do not reach. */
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

(async () => {
  /* ---- unauthenticated access to admin data ---- */
  let r = await req('GET', '/api/admin/visits');
  ok('admin API refuses an anonymous request', r.status === 401 || r.status === 403, String(r.status));
  r = await req('GET', '/api/admin/settings');
  ok('settings refuse an anonymous request', r.status === 401 || r.status === 403, String(r.status));

  await req('POST', '/api/admin/login', { email: 'hankalfr@gmail.com', password: 'Testing123!' });

  /* ---- bad login ---- */
  const bad = await fetch(BASE + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'hankalfr@gmail.com', password: 'wrong' }) });
  ok('a wrong password is refused', bad.status === 401, String(bad.status));

  /* ---- kiosk input validation ---- */
  r = await req('POST', '/api/kiosk/signin', { visit_type: 'contractor' });
  ok('sign-in without a name is refused', r.status === 400 && r.data.error === 'name_required', JSON.stringify(r.data));
  r = await req('POST', '/api/kiosk/signin', { full_name: 'X', company: 'Y', phone: '415-268-5551', visit_type: 'contractor', project_id: 999999 });
  ok('an unknown project is refused', r.status === 400 && r.data.error === 'unknown_project', JSON.stringify(r.data));

  /* ---- a closed project must not accept new people ---- */
  r = await req('POST', '/api/admin/projects', { name: 'Closed job', active: 1 });
  const proj = r.data;
  await req('PATCH', `/api/admin/projects/${proj.id}`, { active: 0 });
  r = await req('POST', '/api/kiosk/signin', { full_name: 'Late Arrival', company: 'Z', phone: '415-268-5552', visit_type: 'contractor', project_id: proj.id });
  ok('a closed project is refused at sign-in', r.status === 400 && r.data.error === 'unknown_project', JSON.stringify(r.data));

  /* ---- a project in use cannot be deleted ---- */
  r = await req('DELETE', '/api/admin/projects/1');
  ok('a project with visits refuses deletion', r.status >= 400 || (r.data && r.data.error === 'project_in_use'), JSON.stringify(r.data));

  /* ---- oversized and malformed input ---- */
  r = await req('POST', '/api/kiosk/signin', { full_name: 'A'.repeat(5000), company: 'B'.repeat(5000), phone: '415-268-5553', visit_type: 'contractor', project_id: 1 });
  ok('a huge name does not crash the server', r.status === 200 || r.status === 400, String(r.status));
  r = await req('POST', '/api/kiosk/signin', { full_name: "Robert'); DROP TABLE visits;--", company: 'C', phone: '415-268-5554', visit_type: 'contractor', project_id: 1 });
  ok('an SQL-looking name is stored, not executed', r.status === 200, String(r.status));
  r = await req('GET', '/api/admin/visits?limit=5');
  ok('the visits table still exists afterwards', r.status === 200 && Array.isArray(r.data.rows || r.data));

  /* ---- XSS: a script tag in a name must come back escaped where rendered ---- */
  await req('POST', '/api/kiosk/signin', { full_name: '<script>alert(1)</script>', company: 'D', phone: '415-268-5555', visit_type: 'contractor', project_id: 1 });
  r = await req('GET', '/api/admin/visits?limit=50');
  const rows = r.data.rows || r.data;
  ok('a script-tag name is stored verbatim (escaped at render)', rows.some((v) => v.full_name === '<script>alert(1)</script>'));

  /* ---- sign-out twice ---- */
  const onsite = (await req('GET', '/api/admin/dashboard')).data.onsite;
  if (onsite.length) {
    const id = onsite[0].id;
    r = await req('POST', '/api/kiosk/signout', { visit_id: id });
    ok('sign-out works', r.status === 200);
    r = await req('POST', '/api/kiosk/signout', { visit_id: id });
    ok('signing the same visit out twice is refused', r.status === 404, String(r.status));
  }

  /* ---- roll call and CSV export ---- */
  r = await req('GET', '/api/admin/rollcall');
  ok('roll call responds', r.status === 200 && typeof r.data.count === 'number', JSON.stringify(r.data).slice(0, 80));
  const csv = await fetch(BASE + '/api/admin/rollcall?format=csv', { headers: { cookie } });
  const text = await csv.text();
  ok('roll call CSV downloads', csv.status === 200 && text.includes('Name'), text.slice(0, 60));

  /* ---- health ---- */
  r = await req('GET', '/api/health');
  ok('health reports storage and rendering', r.data.ok === true && !!r.data.storage && !!r.data.slide_rendering, JSON.stringify(r.data));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
