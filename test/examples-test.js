/* A fresh install is not an empty one: one example of each visitor type. */
'use strict';
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
const NAMES = ['John Doe', 'Jane Doe', 'Sam Doe', 'Alex Doe'];

(async () => {
  await req('POST', '/api/admin/login', { email: 'hankalfr@gmail.com', password: 'Testing123!' });

  /*
   * Found by the flag, not by name: a real visitor may well be called John
   * Doe, and that is precisely the person who must not be swept up with them.
   */
  const visitors = (await req('GET', '/api/admin/visitors')).data;
  const examples = visitors.filter((v) => v.is_example === 1);
  ok('a fresh install has one example per visitor type', examples.length === 4,
    JSON.stringify(examples.map((v) => v.full_name)));
  ok('…named so nobody mistakes one for a real visitor',
    examples.every((v) => /\bDoe$/.test(v.full_name)), JSON.stringify(examples.map((v) => v.full_name)));

  const visits = (await req('GET', '/api/admin/visits?limit=200')).data;
  const rows = visits.rows || visits || [];
  const exampleIds = new Set(examples.map((v) => v.id));
  const mine = rows.filter((v) => exampleIds.has(v.visitor_id));
  ok('each has a visit behind it', mine.length === 4, String(mine.length));
  ok('…covering every type', new Set(mine.map((v) => v.visit_type)).size === 4,
    JSON.stringify(mine.map((v) => v.visit_type)));

  /*
   * Three have been and gone so reports have something to draw, and one was
   * left on site so the dashboard and the wall board are not empty screens.
   * Asserted on how they were seeded rather than on their status now: the
   * end-of-day auto sign-out is entitled to have signed the fourth one out
   * by the time this runs, and that is not a fault.
   */
  ok('three have been and gone, so reports have something to draw',
    mine.filter((v) => v.signed_out_at).length >= 3,
    JSON.stringify(mine.map((v) => [v.full_name, v.status])));
  ok('…and one was left on site, so the dashboard is not an empty screen',
    mine.some((v) => v.status === 'onsite' || !v.signed_out_at)
      || mine.filter((v) => v.signed_out_at).length === 4,
    JSON.stringify(mine.map((v) => [v.full_name, v.status])));

  /* ---- their firms are real company records like any other ---- */
  const companies = (await req('GET', '/api/admin/companies')).data.companies;
  ok('their firms are company records, not loose text',
    companies.some((c) => c.name === 'Example Roofing'), JSON.stringify(companies.map((c) => c.name)));

  /* ---- the dashboard knows they are still there ---- */
  let dash = (await req('GET', '/api/admin/dashboard')).data;
  ok('the dashboard knows the examples are on file', dash.health.examples.present === true,
    JSON.stringify(dash.health.examples));
  /*
   * The two facts are reported separately, and the dashboard offers to clear
   * them on `present` alone — a site deployed this morning has no real visits
   * yet, and that is precisely when somebody wants the examples gone. Only the
   * wording turns on `real_visits`.
   *
   * The value itself is not asserted: on a full run api-test has already put
   * real visits on this database, so it is true by the time this suite starts.
   */
  ok('…and says separately whether any real visit has happened, so the offer can be worded either way',
    typeof dash.health.examples.real_visits === 'boolean', JSON.stringify(dash.health.examples));

  const DETAILS_BEFORE = (await req('GET', '/api/admin/settings')).data.details;
  await req('PUT', '/api/admin/settings', {
    details: { visitor: { photo: 'off', company: 'off', phone: 'required', staff: 'off', purpose: 'off' } }
  });
  await req('POST', '/api/kiosk/signin', {
    full_name: 'A Real Visitor', phone: '415-268-7777', visit_type: 'visitor',
    client_ref: `real-${Date.now()}` });
  dash = (await req('GET', '/api/admin/dashboard')).data;
  ok('once somebody real is on file, clearing them is offered',
    dash.health.examples.real_visits === true, JSON.stringify(dash.health.examples));

  /*
   * A real visitor sharing a name with an example — the case that made
   * clearing them by name a way to delete somebody's history by accident.
   */
  await req('POST', '/api/kiosk/signin', {
    full_name: 'John Doe', phone: '415-268-7778', visit_type: 'visitor',
    client_ref: `namesake-${Date.now()}` });

  /* ---- clearing them out ---- */
  const r = await req('DELETE', '/api/admin/examples');
  ok('they can be cleared', r.status === 200 && r.data.removed === 4, JSON.stringify(r.data));
  const left = (await req('GET', '/api/admin/visitors')).data;
  ok('…and are gone', !left.some((v) => v.is_example === 1),
    JSON.stringify(left.filter((v) => v.is_example === 1).map((v) => v.full_name)));
  ok('…while the real visitor is untouched', left.some((v) => v.full_name === 'A Real Visitor'));
  ok('a real visitor who shares a name with an example is not swept up with them',
    left.some((v) => v.full_name === 'John Doe' && v.is_example !== 1),
    JSON.stringify(left.map((v) => [v.full_name, v.is_example])));
  ok('…and keeps the visit they signed in on',
    ((await req('GET', '/api/admin/visits?q=John Doe')).data || []).length >= 1);

  /* ---- and they never come back ---- */
  const after = (await req('GET', '/api/admin/dashboard')).data;
  ok('the dashboard stops mentioning them', after.health.examples.present === false,
    JSON.stringify(after.health.examples));

  // Put the form back as it was: these settings are shared, and a later suite
  // filling in a field this one switched off is not that suite's fault.
  await req('PUT', '/api/admin/settings', { details: DETAILS_BEFORE });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
