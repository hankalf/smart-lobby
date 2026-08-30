/*
 * People who are expected, before they turn up.
 *
 * A site knows about most of its visitors the day before, and until now the
 * kiosk met every one of them as a stranger. What matters here is the line
 * between a plan and a record: a booking must pre-fill the form and mark
 * itself arrived, and must never — not once, not by any route — put somebody
 * on the roll call who is not actually on site.
 */
'use strict';
const BASE = process.env.BASE_URL || 'http://localhost:3401';
const localtime = require('../server/localtime');
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
const today = () => localtime.today();
const dayAhead = (n) => new Date(Date.parse(`${today()}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

(async () => {
  await req('POST', '/api/admin/login', { email: 'hankalfr@gmail.com', password: 'Testing123!' });
  const staff = (await req('GET', '/api/admin/staff')).data || [];
  const host = staff[0]
    || (await req('POST', '/api/admin/staff', { name: 'Expect Host', email: 'ex@example.com', active: 1 })).data;

  const made = [];
  const book = async (body) => {
    const r = await req('POST', '/api/admin/expected', body);
    if (r.data && r.data.id) made.push(r.data.id);
    return r;
  };

  /* ---- booking somebody in ---- */
  let r = await book({
    full_name: 'Expected Auditor', company: 'Audit Co', phone: '415-660-1001',
    visit_type: 'visitor', host_id: host.id, expected_on: today(), expected_at: '10:00',
    purpose: 'Annual audit'
  });
  const auditor = r.data;
  ok('somebody can be booked in before they arrive', r.status === 200 && !!auditor.id, JSON.stringify(r.data).slice(0, 120));
  ok('…and is given an arrival code to pass on', /^[A-Z0-9]{6}$/.test(auditor.code || ''), auditor.code);
  ok('…with no O or 0 in it, because somebody reads it off a phone',
    !/[O0I1]/.test(auditor.code), auditor.code);
  ok('…and comes back with the name of who they are seeing, not just an id',
    auditor.host_name === host.name, auditor.host_name);
  ok('a booking with no name is refused', (await book({ expected_on: today() })).status === 400);
  ok('a booking with a nonsense date is refused',
    (await book({ full_name: 'Nobody', expected_on: 'next tuesday' })).status === 400);

  /* ---- the list, and the count reception is asked for ---- */
  await book({ full_name: 'Expected Crew', company: 'Vega Electrical', phone: '415-660-1002',
    visit_type: 'contractor', expected_on: dayAhead(2) });
  const list = (await req('GET', '/api/admin/expected')).data;
  ok('today’s summary counts who is still to come', list.expected >= 1, JSON.stringify({ e: list.expected }));
  ok('…and says which day it means', list.day === today(), list.day);
  ok('the default list looks forward, not back',
    list.rows.some((x) => x.expected_on === dayAhead(2)), JSON.stringify(list.rows.map((x) => x.expected_on)));
  const justToday = (await req('GET', `/api/admin/expected?on=${today()}`)).data.rows;
  ok('…and one day can be asked for on its own',
    justToday.every((x) => x.expected_on === today()) && justToday.length >= 1,
    JSON.stringify(justToday.map((x) => x.expected_on)));

  /* ---- a booking is not a visit ---- */
  const roll = (await req('GET', '/api/admin/rollcall')).data;
  const rollRows = Array.isArray(roll) ? roll : (roll.rows || roll.onsite || []);
  ok('nobody booked in is on the roll call — they are not on site',
    !rollRows.some((x) => x.full_name === 'Expected Auditor'),
    JSON.stringify(rollRows.map((x) => x.full_name)).slice(0, 120));
  const dash = (await req('GET', '/api/admin/dashboard')).data;
  ok('the dashboard counts them separately from who is here',
    dash.stats.expected_today >= 1 && !dash.onsite.some((x) => x.full_name === 'Expected Auditor'),
    JSON.stringify(dash.stats));

  /* ---- the kiosk recognises them by the number reception typed ---- */
  let look = await req('POST', '/api/kiosk/lookup', { phone: '4156601001', visit_type: 'visitor' });
  ok('the kiosk recognises an expected visitor by phone number',
    look.status === 200 && !!look.data.expected, JSON.stringify(look.data).slice(0, 140));
  ok('…handing back what it already knows, so nothing is retyped',
    look.data.expected.full_name === 'Expected Auditor'
    && look.data.expected.host_id === host.id
    && look.data.expected.purpose === 'Annual audit', JSON.stringify(look.data.expected));
  ok('…even though this person has never been here before', look.data.found === false);

  look = await req('POST', '/api/kiosk/lookup', { phone: '4159999999', visit_type: 'visitor' });
  ok('somebody who was not booked in is not told they were expected',
    !look.data.expected, JSON.stringify(look.data).slice(0, 100));

  /* ---- a booking for another day is not today's ---- */
  look = await req('POST', '/api/kiosk/lookup', { phone: '4156601002', visit_type: 'contractor' });
  ok('a booking two days out does not greet somebody arriving today',
    !look.data.expected, JSON.stringify(look.data.expected));

  /* ---- signing in fulfils the booking ---- */
  const signin = await req('POST', '/api/kiosk/signin', {
    full_name: 'Expected Auditor', company: 'Audit Co', phone: '415-660-1001',
    visit_type: 'visitor', host_id: host.id, client_ref: `exp-${Date.now()}`
  });
  ok('they sign in like anybody else', signin.status === 200 && !!signin.data.visit,
    JSON.stringify(signin.data).slice(0, 120));
  const after = (await req('GET', `/api/admin/expected?on=${today()}`)).data.rows
    .find((x) => x.id === auditor.id);
  ok('the booking is marked as arrived', after.status === 'arrived', after.status);
  ok('…against the visit that did it', after.visit_id === signin.data.visit.id,
    `${after.visit_id} vs ${signin.data.visit.id}`);
  ok('…and the summary no longer counts them as still to come',
    (await req('GET', '/api/admin/expected')).data.expected === list.expected - 1,
    JSON.stringify((await req('GET', '/api/admin/expected')).data.expected));

  look = await req('POST', '/api/kiosk/lookup', { phone: '4156601001', visit_type: 'visitor' });
  ok('a booking already walked in on does not greet the next person on that number',
    !look.data.expected, JSON.stringify(look.data.expected));

  /* ---- an arrived booking is history, not a plan ---- */
  const edit = await req('PATCH', `/api/admin/expected/${auditor.id}`, { full_name: 'Rewritten' });
  ok('a booking somebody has arrived on cannot be edited afterwards', edit.status === 409, String(edit.status));

  /* ---- cancelling ---- */
  const crew = (await req('GET', '/api/admin/expected')).data.rows.find((x) => x.full_name === 'Expected Crew');
  const cancelled = await req('PATCH', `/api/admin/expected/${crew.id}`, { status: 'cancelled' });
  ok('a booking can be cancelled', cancelled.status === 200 && cancelled.data.status === 'cancelled',
    JSON.stringify(cancelled.data).slice(0, 100));
  look = await req('POST', '/api/kiosk/lookup', { phone: '4156601002', visit_type: 'contractor' });
  ok('…and a cancelled booking greets nobody', !look.data.expected);

  /* ---- yesterday's no-shows are marked, not deleted ---- */
  const stale = (await book({ full_name: 'Never Came', phone: '415-660-1003', expected_on: dayAhead(-2) })).data;
  const closed = require('../server/expected').closeOldDays();
  ok('a booking nobody came to is marked as a no-show rather than deleted', closed >= 1, String(closed));
  const still = (await req('GET', `/api/admin/expected?on=${dayAhead(-2)}`)).data.rows
    .find((x) => x.id === stale.id);
  ok('…and stays on the record so it can be asked about', !!still && still.status === 'no_show',
    still && still.status);

  /* ---- who may do this ---- */
  const pw = 'Reception123!';
  const rec = (await req('POST', '/api/admin/users', {
    email: `expect-reception-${Date.now()}@example.com`, name: 'Expect Reception', role: 'reception', password: pw, must_change: false
  })).data;
  await req('POST', '/api/admin/logout');
  await req('POST', '/api/admin/login', { email: rec.email, password: pw });
  ok('reception can see who is coming — it is their job',
    (await req('GET', '/api/admin/expected')).status === 200);
  const recBooked = await req('POST', '/api/admin/expected', { full_name: 'Booked By Reception', expected_on: today() });
  ok('…and can book somebody in', recBooked.status === 200, String(recBooked.status));
  if (recBooked.data && recBooked.data.id) made.push(recBooked.data.id);
  await req('POST', '/api/admin/logout');

  const nobody = await fetch(`${BASE}/api/admin/expected`).then((res) => res.status);
  ok('nobody signed out can read who is coming to the site', nobody === 401, String(nobody));

  /* ---- clearing up ---- */
  await req('POST', '/api/admin/login', { email: 'hankalfr@gmail.com', password: 'Testing123!' });
  await req('DELETE', `/api/admin/users/${rec.id}`);
  for (const id of made) await req('DELETE', `/api/admin/expected/${id}`);
  await req('DELETE', `/api/admin/visits/${signin.data.visit.id}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
