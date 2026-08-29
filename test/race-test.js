/* Six copies of the same queued sign-in arriving at once must record one visit. */
'use strict';
const BASE = process.env.BASE_URL || 'http://localhost:3401';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n}${x ? ' — ' + x : ''}`); } };
const post = (p, b) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })
  .then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));

(async () => {
  const ref = 'race-' + Date.now();
  const payload = { full_name: 'John Doe 14', company: 'Race Co', phone: '415-268-0999',
    visit_type: 'contractor', project_id: 1, client_ref: ref };

  const results = await Promise.all(Array.from({ length: 6 }, () => post('/api/kiosk/signin', payload)));
  ok('all six requests answered ok', results.every((r) => r.status === 200 && r.data && r.data.ok), JSON.stringify(results.map((r) => r.status)));
  const dups = results.filter((r) => r.data.duplicate).length;
  ok('five of six answered as duplicates', dups === 5, `${dups} duplicates`);
  const ids = new Set(results.map((r) => r.data.visit && r.data.visit.id));
  ok('every answer names the same visit', ids.size === 1, JSON.stringify([...ids]));

  const login = await fetch(BASE + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'hankalfr@gmail.com', password: 'Testing123!' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const visits = await (await fetch(`${BASE}/api/admin/visits?limit=50`, { headers: { cookie } })).json();
  const rows = visits.rows || visits;
  // scoped to this run's reference: earlier runs left their own John Doe 14 rows
  const mine = rows.filter((v) => v.client_ref === ref);
  ok('exactly one visit recorded for this reference', mine.length === 1, `${mine.length} visits`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
