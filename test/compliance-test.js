/* Certificates: paperwork with a date on it, checked at the gate. */
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
/*
 * Dates on the site's own clock, not UTC. An expiry is judged against the day
 * it is where the site is — a certificate running out "today" is good through
 * today's working day — and after 23:00 UTC in summer those are two different
 * dates, which is exactly when this would otherwise start failing at night.
 */
const localtime = require('../server/localtime');
const day = (offset) => {
  const base = Date.parse(`${localtime.today()}T12:00:00Z`);
  return new Date(base + offset * 864e5).toISOString().slice(0, 10);
};
let n = 0;
const signin = (company, extra = {}) => req('POST', '/api/kiosk/signin', {
  full_name: `John Doe 5${n}`, company, phone: `415268${String(2000 + (n++)).slice(-4)}`,
  visit_type: 'contractor', project_id: 1, client_ref: `cmp-${Date.now()}-${Math.random()}`, ...extra
});

(async () => {
  await req('POST', '/api/admin/login', { email: 'hankalfr@gmail.com', password: 'Testing123!' });
  const DETAILS_BEFORE = (await req('GET', '/api/admin/settings')).data.details;
  await req('PUT', '/api/admin/settings', {
    details: {
      contractor: { photo: 'off', company: 'required', phone: 'required', staff: 'off', project: 'off' },
      visitor: { photo: 'off', company: 'required', phone: 'required', staff: 'off', purpose: 'off' }
    },
    compliance: { enabled: true, on_fail: 'warn', warn_days: 30, required: { contractor: ['insurance'] } }
  });

  /* ---- with nothing on file, a required certificate is missing ---- */
  let r = await signin('Roofing With No Papers');
  ok('a contractor with no insurance still signs in while it is only a warning',
    r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);
  ok('…but the desk is told what is wrong',
    r.data.compliance && /not on file/i.test(r.data.compliance.detail || ''),
    JSON.stringify(r.data.compliance));
  ok('…naming the certificate rather than just saying something is amiss',
    /insurance/i.test(r.data.compliance.detail), r.data.compliance.detail);

  const companies = (await req('GET', '/api/admin/companies')).data.companies;
  const noPapers = companies.find((c) => c.name === 'Roofing With No Papers');

  /* ---- a company certificate covers all of its people ---- */
  r = await req('POST', '/api/admin/certificates', {
    company_id: noPapers.id, kind: 'insurance', reference: 'POL-1', expires_on: day(200) });
  ok('a certificate can be recorded against a company', r.status === 200 && r.data.id, JSON.stringify(r.data));

  r = await signin('Roofing With No Papers');
  ok('their next person is covered by it', !r.data.compliance, JSON.stringify(r.data.compliance));

  /* ---- and an out-of-date one covers nobody ---- */
  const covered = companies.find((c) => c.name === 'Roofing With No Papers');
  const certs = (await req('GET', `/api/admin/certificates/for?company_id=${covered.id}`)).data;
  await req('PATCH', `/api/admin/certificates/${certs[0].id}`, { expires_on: day(-1) });
  r = await signin('Roofing With No Papers');
  ok('one that ran out yesterday no longer covers anybody',
    r.data.compliance && /out of date/i.test(r.data.compliance.detail), JSON.stringify(r.data.compliance));

  await req('PATCH', `/api/admin/certificates/${certs[0].id}`, { expires_on: day(0) });
  r = await signin('Roofing With No Papers');
  ok('…but one that runs out today is still good today', !r.data.compliance, JSON.stringify(r.data.compliance));
  await req('PATCH', `/api/admin/certificates/${certs[0].id}`, { expires_on: day(-1) });

  /* ---- turning them away instead ---- */
  await req('PUT', '/api/admin/settings', { compliance: { on_fail: 'block' } });
  r = await signin('Roofing With No Papers');
  ok('set to block, a lapsed certificate closes the gate',
    r.status === 403 && r.data.error === 'compliance', `${r.status} ${JSON.stringify(r.data)}`);
  ok('…telling the visitor to see reception rather than explaining their firm\'s paperwork',
    /see reception/i.test(r.data.message || ''), JSON.stringify(r.data));
  ok('…while the detail is there for the desk', /insurance/i.test(r.data.detail || ''), r.data.detail);

  r = await signin('A Firm Nobody Requires Anything Of', { visit_type: 'visitor' });
  ok('a type with nothing required is not caught by it', r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);

  /* ---- a person's own card covers only them ---- */
  await req('PATCH', `/api/admin/certificates/${certs[0].id}`, { expires_on: day(-1) });
  const visitors = (await req('GET', '/api/admin/visitors?q=John Doe 5')).data;
  const one = visitors[0];
  await req('POST', '/api/admin/certificates', {
    visitor_id: one.id, kind: 'insurance', reference: 'OWN-1', expires_on: day(90) });
  r = await req('GET', `/api/admin/certificates/check?visit_type=contractor&visitor_id=${one.id}&company_id=${covered.id}`);
  ok('their own certificate covers them even though their firm\'s has lapsed',
    r.data.ok === true, JSON.stringify(r.data));
  r = await req('GET', `/api/admin/certificates/check?visit_type=contractor&company_id=${covered.id}`);
  ok('…and covers nobody else', r.data.ok === false, JSON.stringify(r.data));

  /* ---- switched off entirely ---- */
  await req('PUT', '/api/admin/settings', { compliance: { enabled: false } });
  r = await signin('Roofing With No Papers');
  ok('with checking off nobody is stopped', r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);
  ok('…and nothing is said about it', !r.data.compliance, JSON.stringify(r.data.compliance));
  await req('PUT', '/api/admin/settings', { compliance: { enabled: true, on_fail: 'warn' } });

  /* ---- what the dashboard is told ---- */
  const board = (await req('GET', '/api/admin/certificates')).data;
  ok('the lapsing list leads with what has already lapsed',
    board.expiring.length > 0 && board.expiring[0].expired === true,
    JSON.stringify(board.expiring.map((e) => [e.holder, e.expires_on])));
  ok('…saying who holds each one', board.expiring.every((e) => e.holder && e.holder !== 'Unattached'),
    JSON.stringify(board.expiring.map((e) => e.holder)));
  ok('…and how long is left', board.expiring.every((e) => Number.isInteger(e.days_left)),
    JSON.stringify(board.expiring.map((e) => e.days_left)));
  ok('the counts reach the dashboard banner', board.health.enabled && board.health.expired >= 1,
    JSON.stringify(board.health));

  const dash = (await req('GET', '/api/admin/dashboard')).data;
  ok('…through the same dashboard call that already reports what is quietly broken',
    dash.health && dash.health.compliance && dash.health.compliance.expired >= 1,
    JSON.stringify(dash.health && dash.health.compliance));

  /* ---- one that never expires never nags ---- */
  await req('POST', '/api/admin/certificates', {
    company_id: covered.id, kind: 'rams', reference: 'FOREVER', expires_on: null });
  const again = (await req('GET', '/api/admin/certificates')).data;
  ok('a certificate with no expiry is never in the lapsing list',
    !again.expiring.some((e) => e.reference === 'FOREVER'),
    JSON.stringify(again.expiring.map((e) => e.reference)));

  /* ---- rubbish in ---- */
  r = await req('POST', '/api/admin/certificates', { kind: 'insurance' });
  ok('a certificate belonging to nobody is refused', r.status === 400, `${r.status} ${JSON.stringify(r.data)}`);
  r = await req('POST', '/api/admin/certificates', { company_id: covered.id, kind: '  ' });
  ok('…and one with no kind', r.status === 400, String(r.status));

  // Put the form back as it was: these settings are shared, and a later suite
  // filling in a field this one switched off is not that suite's fault.
  await req('PUT', '/api/admin/settings', { details: DETAILS_BEFORE });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
