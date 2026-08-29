/* Driver's licence scanning: the toggle, storage, and what must never be stored. */
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
  await req('POST', '/api/admin/login', { email: 'hankalfr@gmail.com', password: 'Testing123!' });

  /* ---- the toggle exists and is off by default ---- */
  let r = await req('GET', '/api/admin/settings');
  ok('id_scan is a details field on every visitor type',
    Object.values(r.data.details).every((d) => 'id_scan' in d), JSON.stringify(r.data.details.contractor));
  ok('it is off by default', Object.values(r.data.details).every((d) => d.id_scan === 'off'));

  r = await req('GET', '/api/kiosk/config');
  ok('the kiosk is told about the setting', r.data.details.contractor.id_scan === 'off');

  /* ---- with the scan off, licence data sent anyway is not stored ---- */
  r = await req('POST', '/api/kiosk/signin', {
    full_name: 'No Scan', company: 'C', phone: '415-268-0301', visit_type: 'contractor', project_id: 1,
    id_name: 'Somebody Else', id_number: 'X999', id_state: 'TX', client_ref: 'idoff-' + Date.now()
  });
  ok('sign-in works with the scan off', r.status === 200, JSON.stringify(r.data).slice(0, 90));
  let detail = (await req('GET', `/api/admin/visits/${r.data.visit.id}`)).data;
  ok('licence fields are ignored while the scan is off',
    !detail.id_number && !detail.id_name && !detail.id_state,
    JSON.stringify({ n: detail.id_name, num: detail.id_number, s: detail.id_state }));

  /* ---- turn it on for contractors ---- */
  const settings = (await req('GET', '/api/admin/settings')).data;
  settings.details.contractor.id_scan = 'optional';
  r = await req('PUT', '/api/admin/settings', { details: settings.details });
  ok('the toggle saves', r.status === 200 && r.data.details.contractor.id_scan === 'optional',
    JSON.stringify(r.data.details.contractor.id_scan));

  /* ---- optional: a sign-in without a scan still works ---- */
  r = await req('POST', '/api/kiosk/signin', {
    full_name: 'Skipped Scan', company: 'C', phone: '415-268-0302', visit_type: 'contractor', project_id: 1,
    client_ref: 'idopt-' + Date.now()
  });
  ok('optional means a sign-in without a scan is allowed', r.status === 200, JSON.stringify(r.data).slice(0, 90));

  /* ---- a scanned licence is stored ---- */
  r = await req('POST', '/api/kiosk/signin', {
    full_name: 'John Smith', company: 'Haulage Co', phone: '415-268-0303', visit_type: 'contractor', project_id: 1,
    id_name: 'John Smith', id_number: '12345678', id_state: 'TX', client_ref: 'idscan-' + Date.now()
  });
  ok('a scanned sign-in is accepted', r.status === 200, JSON.stringify(r.data).slice(0, 90));
  detail = (await req('GET', `/api/admin/visits/${r.data.visit.id}`)).data;
  ok('the name from the licence is stored', detail.id_name === 'John Smith', detail.id_name);
  ok('the licence number is stored', detail.id_number === '12345678', detail.id_number);
  ok('the issuing state is stored', detail.id_state === 'TX', detail.id_state);

  /* ---- required: refuse without one ---- */
  settings.details.contractor.id_scan = 'required';
  await req('PUT', '/api/admin/settings', { details: settings.details });
  r = await req('POST', '/api/kiosk/signin', {
    full_name: 'Missing Scan', company: 'C', phone: '415-268-0304', visit_type: 'contractor', project_id: 1,
    client_ref: 'idreq-' + Date.now()
  });
  ok('required refuses a sign-in with no licence', r.status === 400 && r.data.error === 'id_scan_required', JSON.stringify(r.data));
  r = await req('POST', '/api/kiosk/signin', {
    full_name: 'Has Scan', company: 'C', phone: '415-268-0305', visit_type: 'contractor', project_id: 1,
    id_name: 'Has Scan', id_number: 'D4455667', id_state: 'CA', client_ref: 'idreq2-' + Date.now()
  });
  ok('required accepts one with a licence', r.status === 200, JSON.stringify(r.data).slice(0, 90));

  /* ---- sanitising ---- */
  r = await req('POST', '/api/kiosk/signin', {
    full_name: 'Long Fields', company: 'C', phone: '415-268-0306', visit_type: 'contractor', project_id: 1,
    id_name: 'A'.repeat(500), id_number: 'B'.repeat(500), id_state: 'texas', client_ref: 'idlong-' + Date.now()
  });
  detail = (await req('GET', `/api/admin/visits/${r.data.visit.id}`)).data;
  ok('an over-long name is capped', detail.id_name.length <= 120, String(detail.id_name.length));
  ok('an over-long number is capped', detail.id_number.length <= 40, String(detail.id_number.length));
  ok('a bad state is reduced to two letters or dropped',
    !detail.id_state || /^[A-Z]{1,2}$/.test(detail.id_state), JSON.stringify(detail.id_state));

  r = await req('POST', '/api/kiosk/signin', {
    full_name: 'Name Spaces', company: 'C', phone: '415-268-0307', visit_type: 'contractor', project_id: 1,
    id_name: 'Maria De La Cruz', id_number: 'L1234-5678-9012', id_state: 'on', client_ref: 'idsp-' + Date.now()
  });
  detail = (await req('GET', `/api/admin/visits/${r.data.visit.id}`)).data;
  ok('spaces in a name survive', detail.id_name === 'Maria De La Cruz', detail.id_name);
  ok('hyphens in a licence number survive', detail.id_number === 'L1234-5678-9012', detail.id_number);
  ok('a lowercase state is upper-cased', detail.id_state === 'ON', detail.id_state);

  /* ---- put it back so later suites are unaffected ---- */
  settings.details.contractor.id_scan = 'off';
  await req('PUT', '/api/admin/settings', { details: settings.details });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
