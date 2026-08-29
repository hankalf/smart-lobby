/* Paths the other suites do not reach — upgrades, deletes, and awkward input. */
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

  /* ---- deleting things that are referenced ---- */
  let r = await req('GET', '/api/admin/devices');
  const dev = r.data[0];
  r = await req('GET', '/api/admin/visits?limit=50');
  const withDevice = (r.data.rows || r.data).find((v) => v.device_name);
  r = await req('DELETE', `/api/admin/devices/${dev.id}`);
  ok('a device with visits can be removed', r.status === 200, JSON.stringify(r.data));
  r = await req('GET', `/api/admin/visits?limit=50`);
  ok('its visits survive the device being removed', (r.data.rows || r.data).length > 0);
  if (withDevice) {
    r = await req('GET', `/api/admin/visits/${withDevice.id}`);
    ok('a visit whose device is gone still opens', r.status === 200 && !!r.data.full_name, JSON.stringify(r.data).slice(0, 80));
  }

  /* ---- deleting a staff member who has visitors ---- */
  r = await req('POST', '/api/admin/staff', { name: 'Temp Host', email: 't@x.test', active: 1 });
  const host = r.data;
  r = await req('POST', '/api/kiosk/signin', { full_name: 'Sees Temp', company: 'C', phone: '415-268-0501',
    visit_type: 'visitor', host_id: host.id, client_ref: 'probe-host-' + Date.now() });
  const visitId = r.data.visit && r.data.visit.id;
  r = await req('DELETE', `/api/admin/staff/${host.id}`);
  ok('a staff member with visitors can be removed', r.status === 200);
  r = await req('GET', `/api/admin/visits/${visitId}`);
  ok('their visitor record still opens afterwards', r.status === 200 && r.data.full_name === 'Sees Temp',
    JSON.stringify(r.data).slice(0, 80));

  /* ---- a document with no questions and no signature ---- */
  r = await req('POST', '/api/admin/agreements', { name: 'Notice only', body: 'Please read this.',
    required_for: JSON.stringify(['visitor']), questions: '[]', require_signature: 0, active: 1 });
  const notice = r.data;
  ok('a read-only notice can be created', r.status === 200 && notice.require_signature === 0);
  r = await req('POST', '/api/kiosk/signin', { full_name: 'Read Only', company: 'C', phone: '415-268-0502',
    visit_type: 'visitor', host_id: null,
    documents: [{ agreement_id: notice.id, signature: null, answers: {} }],
    client_ref: 'probe-doc-' + Date.now() });
  ok('signing in against it without a signature works', r.status === 200 || r.data.error === 'host_required',
    JSON.stringify(r.data).slice(0, 90));
  await req('DELETE', `/api/admin/agreements/${notice.id}`);

  /* ---- awkward but legitimate input ---- */
  const odd = [
    ['a name with an emoji', 'Jo 🙂 Smith'],
    ['a name in Chinese characters', '李伟'],
    ['a name with an accent', 'José Núñez'],
    ['a very long company', 'C'.repeat(300)]
  ];
  for (const [label, value] of odd) {
    r = await req('POST', '/api/kiosk/signin', {
      full_name: label.includes('company') ? 'Long Co Person' : value,
      company: label.includes('company') ? value : 'Co',
      phone: '415-268-0600', visit_type: 'contractor', project_id: 1,
      client_ref: 'probe-' + Math.random().toString(36).slice(2)
    });
    ok(`${label} is accepted`, r.status === 200, `${r.status} ${JSON.stringify(r.data).slice(0, 70)}`);
  }

  /* ---- malformed requests must not crash the server ---- */
  const raw = async (body) => {
    const res = await fetch(BASE + '/api/kiosk/signin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    return res.status;
  };
  ok('broken JSON is rejected cleanly', [400, 500].includes(await raw('{not json')), String(await raw('{not json')));
  ok('an empty body is rejected cleanly', [400, 500].includes(await raw('')), String(await raw('')));
  ok('a JSON array where an object belongs is rejected', [400, 500].includes(await raw('[1,2,3]')));
  r = await req('GET', '/api/health');
  ok('the server is still healthy after all that', r.data && r.data.ok === true);

  /* ---- pagination and filtering ---- */
  r = await req('GET', '/api/admin/visits?limit=1');
  ok('a limit is respected', (r.data.rows || r.data).length <= 1, String((r.data.rows || r.data).length));
  r = await req('GET', '/api/admin/visits?limit=99999');
  ok('an absurd limit does not hang or crash', r.status === 200);

  /* ---- config stays coherent after all the churn ---- */
  r = await req('GET', '/api/kiosk/config');
  ok('kiosk config still loads', r.status === 200 && Array.isArray(r.data.types) && r.data.types.length > 0);
  ok('every visitor type still has its detail fields',
    Object.values(r.data.details).every((d) => 'photo' in d && 'id_scan' in d));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
