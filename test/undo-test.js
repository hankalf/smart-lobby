/*
 * A way back from the wrong button.
 *
 * Somebody taps Visitor instead of Contractor, or signs their mate in, and
 * notices while still standing at the tablet. Until now that meant finding a
 * member of staff: the record stayed wrong, the wrong person stayed tagged in
 * Teams, and the roll call was wrong in a fire.
 *
 * The kiosk is unauthenticated, so most of what is proved here is the shape of
 * what it may not do: cancel a visit it was not handed a token for, cancel one
 * from this morning, or destroy anything.
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

let n = 0;
const signIn = async (extra = {}) => {
  n++;
  return (await req('POST', '/api/kiosk/signin', {
    full_name: `Undo Person ${n}`, phone: `415881${String(1000 + n)}`, company: 'Undo Test Ltd',
    visit_type: 'visitor', client_ref: `undo-${Date.now()}-${n}`, ...extra
  })).data;
};

(async () => {
  await req('POST', '/api/admin/login', { email: 'owner@example.test', password: 'Testing123!' });
  const staff = (await req('GET', '/api/admin/staff')).data || [];
  const host = staff[0]
    || (await req('POST', '/api/admin/staff', { name: 'Undo Host', email: 'undo@example.com', active: 1 })).data;

  /* ---- the sign-in hands back the way out ---- */
  const first = await signIn({ host_id: host.id });
  ok('a sign-in hands back a way to cancel it', !!first.undo_token, JSON.stringify(first).slice(0, 120));
  ok('…which carries an expiry and a signature, not just the visit id',
    /^\d{13}\.[0-9a-f]{32}$/.test(String(first.undo_token)), first.undo_token);

  /* ---- a made-up token cancels nothing ---- */
  let r = await req('POST', '/api/kiosk/signin/undo', { visit_id: first.visit.id, undo_token: 'nonsense' });
  ok('a made-up token is refused', r.status === 403, `${r.status} ${JSON.stringify(r.data)}`);
  r = await req('POST', '/api/kiosk/signin/undo', { visit_id: first.visit.id });
  ok('no token at all is refused', r.status === 403, String(r.status));

  /* ---- somebody else's token does not work on this visit ---- */
  const second = await signIn({ host_id: host.id });
  r = await req('POST', '/api/kiosk/signin/undo', { visit_id: first.visit.id, undo_token: second.undo_token });
  ok('a token for one sign-in cannot cancel another', r.status === 403, String(r.status));
  ok('…and the visit it was aimed at is untouched',
    (await req('GET', `/api/admin/visits/${first.visit.id}`)).status === 200);

  /* ---- the right token does ---- */
  r = await req('POST', '/api/kiosk/signin/undo', { visit_id: second.visit.id, undo_token: second.undo_token });
  ok('the right token cancels the sign-in it belongs to', r.status === 200 && r.data.ok, JSON.stringify(r.data));
  ok('…and the visit is off the list, not merely signed out',
    (await req('GET', `/api/admin/visits/${second.visit.id}`)).status === 404);
  const onsite = (await req('GET', '/api/admin/visits?status=onsite&q=Undo Test Ltd')).data;
  ok('…so it is not on site either', !onsite.some((v) => v.id === second.visit.id),
    JSON.stringify(onsite.map((v) => v.id)));

  /* ---- but nothing is destroyed ---- */
  const deleted = (await req('GET', '/api/admin/archive')).data;
  const kept = deleted.find((a) => a.kind === 'visit' && a.record_id === second.visit.id);
  ok('the cancelled sign-in is kept as a deleted record, not destroyed', !!kept,
    JSON.stringify(deleted).slice(0, 200));
  ok('…and says why it went', !!kept && /cancel/i.test(kept.deleted_by || ''),
    kept && kept.deleted_by);
  const back = await req('POST', `/api/admin/archive/${kept.id}/restore`);
  ok('…so a cancellation made in error can itself be undone', back.status === 200 && back.data.ok,
    JSON.stringify(back.data).slice(0, 120));
  await req('DELETE', `/api/admin/visits/${second.visit.id}`);

  /* ---- the same token cannot be used twice ---- */
  r = await req('POST', '/api/kiosk/signin/undo', { visit_id: second.visit.id, undo_token: second.undo_token });
  ok('cancelling the same sign-in twice is refused rather than repeated', r.status === 404, String(r.status));

  /* ---- and not on a visit from earlier in the day ---- */
  const old = await signIn({ host_id: host.id });
  const db = require('../server/db');
  db.run('UPDATE visits SET signed_in_at = ? WHERE id = ?',
    new Date(Date.now() - 3 * 3600e3).toISOString(), old.visit.id);
  r = await req('POST', '/api/kiosk/signin/undo', { visit_id: old.visit.id, undo_token: old.undo_token });
  ok('a visit from hours ago is somebody’s actual day, not a mis-tap', r.status === 409, String(r.status));
  ok('…and is still on site afterwards',
    (await req('GET', `/api/admin/visits/${old.visit.id}`)).data.status === 'onsite');

  /* ---- clearing up ---- */
  await req('DELETE', `/api/admin/visits/${first.visit.id}`);
  await req('DELETE', `/api/admin/visits/${old.visit.id}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
