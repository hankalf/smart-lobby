/*
 * Which job a sign-in lands on before anybody picks one.
 *
 * A crew from one firm are on the same job every morning for months. Made to
 * choose it off a dropdown each time they pick the top one, or last month's,
 * and the hours report a contractor operation bills against quietly becomes
 * fiction. So the kiosk offers an answer — and, just as importantly, only ever
 * offers it.
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
const lookup = (body) => req('POST', '/api/kiosk/lookup', { visit_type: 'contractor', ...body })
  .then((r) => r.data);

(async () => {
  await req('POST', '/api/admin/login', { email: 'hankalfr@gmail.com', password: 'Testing123!' });
  const BEFORE = (await req('GET', '/api/admin/settings')).data.projects || { default_by_type: {} };

  const warehouse = (await req('POST', '/api/admin/projects', { name: 'Default Warehouse', code: 'DW', active: 1 })).data;
  const yard = (await req('POST', '/api/admin/projects', { name: 'Default Yard', code: 'DY', active: 1 })).data;
  const closed = (await req('POST', '/api/admin/projects', { name: 'Default Finished', code: 'DF', active: 1 })).data;

  /* ---- nothing set: the kiosk suggests nothing ---- */
  let r = await lookup({ company: 'Nobody In Particular Ltd' });
  ok('with nothing configured the kiosk suggests no project', !r.default_project,
    JSON.stringify(r.default_project));

  /* ---- a fallback per visitor type ---- */
  await req('PUT', '/api/admin/settings', { projects: { default_by_type: { contractor: yard.id, visitor: null } } });
  r = await lookup({ company: 'Nobody In Particular Ltd' });
  ok('a per-type fallback is suggested', r.default_project && r.default_project.id === yard.id,
    JSON.stringify(r.default_project));
  ok('…and says where it came from', r.default_project.from === 'type', r.default_project.from);

  r = await lookup({ visit_type: 'visitor', company: 'Nobody In Particular Ltd' });
  ok('…and only for the type it was set on', !r.default_project, JSON.stringify(r.default_project));

  /* ---- a firm's own usual job wins ---- */
  const made = [];
  const signin = await req('POST', '/api/kiosk/signin', {
    full_name: 'Project Default Person', phone: '4152664001', company: 'Ironclad Steel Erectors',
    visit_type: 'contractor', project_id: yard.id, client_ref: `pd-${Date.now()}`
  });
  ok('a contractor signs in, creating the company record', signin.status === 200, JSON.stringify(signin.data).slice(0, 110));
  if (signin.data && signin.data.visit) made.push(signin.data.visit.id);

  const companies = ((await req('GET', '/api/admin/companies')).data || {}).companies || [];
  const firm = companies.find((c) => c.name === 'Ironclad Steel Erectors');
  ok('the firm is on file', !!firm, JSON.stringify(companies.map((c) => c.name)).slice(0, 120));

  await req('PATCH', `/api/admin/companies/${firm.id}`, { default_project_id: warehouse.id });
  r = await lookup({ company: 'Ironclad Steel Erectors' });
  ok('the firm’s own usual job beats the per-type fallback',
    r.default_project && r.default_project.id === warehouse.id, JSON.stringify(r.default_project));
  ok('…and says so', r.default_project.from === 'company', r.default_project.from);

  ok('…however the name was typed', (await lookup({ company: 'ironclad steel erectors' })).default_project.id === warehouse.id);

  /* ---- a returning visitor gets it from their own record ---- */
  r = await lookup({ phone: '4152664001' });
  ok('a returning contractor is recognised and offered their firm’s job',
    r.found && r.default_project && r.default_project.id === warehouse.id,
    JSON.stringify({ found: r.found, project: r.default_project }));

  /* ---- a closed job is never suggested ---- */
  await req('PATCH', `/api/admin/companies/${firm.id}`, { default_project_id: closed.id });
  await req('PATCH', `/api/admin/projects/${closed.id}`, { active: 0 });
  r = await lookup({ company: 'Ironclad Steel Erectors' });
  ok('a finished job is never suggested, even when it is still on the firm',
    !r.default_project || r.default_project.id !== closed.id, JSON.stringify(r.default_project));

  /* ---- and it is only ever a suggestion ---- */
  await req('PATCH', `/api/admin/companies/${firm.id}`, { default_project_id: warehouse.id });
  const other = await req('POST', '/api/kiosk/signin', {
    full_name: 'Project Default Person', phone: '4152664001', company: 'Ironclad Steel Erectors',
    visit_type: 'contractor', project_id: yard.id, client_ref: `pd2-${Date.now()}`
  });
  if (other.data && other.data.visit) made.push(other.data.visit.id);
  const recorded = (await req('GET', `/api/admin/visits/${other.data.visit.id}`)).data;
  ok('what the visitor actually chose is what is recorded, not the suggestion',
    recorded.project_id === yard.id, `${recorded.project_id} vs ${yard.id}`);

  /* ---- a default can be cleared again ---- */
  await req('PUT', '/api/admin/settings', { projects: { default_by_type: { contractor: null, visitor: null } } });
  r = await lookup({ company: 'Nobody In Particular Ltd' });
  ok('a per-type default can be cleared, not only changed', !r.default_project,
    JSON.stringify(r.default_project));

  /* ---- put the site back ---- */
  for (const id of made) await req('DELETE', `/api/admin/visits/${id}`);
  for (const p of [warehouse, yard, closed]) await req('DELETE', `/api/admin/projects/${p.id}`);
  await req('PUT', '/api/admin/settings', { projects: BEFORE });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
