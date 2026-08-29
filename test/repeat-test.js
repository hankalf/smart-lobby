/* Document repeat frequency — runs after api-test.js on the same DB. */
'use strict';
const BASE = process.env.BASE_URL || 'http://localhost:3401';
let cookie = '';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};
async function req(method, path, body) {
  const headers = body ? { 'Content-Type': 'application/json' } : {};
  const res = await fetch(BASE + path, { method, headers: { ...headers, cookie }, body: body ? JSON.stringify(body) : undefined });
  const setc = res.headers.get('set-cookie');
  if (setc) cookie = setc.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => null) };
}

(async () => {
  await req('POST', '/api/admin/login', { email: 'hankalfr@gmail.com', password: 'Testing123!' });

  const docs = (await req('GET', '/api/admin/agreements')).data;
  const doc = docs[docs.length - 1]; // the seeded site-rules document Carlos signed
  const visitors = (await req('GET', '/api/admin/visitors')).data;
  const rows = visitors.rows || visitors;
  const carlos = rows.find((v) => v.full_name === 'Hank Alfred');
  ok('test fixtures present', !!(doc && carlos), JSON.stringify({ doc: !!doc, carlos: !!carlos }));

  const due = async (visitorId) =>
    (await req('GET', `/api/kiosk/agreements/contractor${visitorId ? `?visitor_id=${visitorId}` : ''}`)).data
      .some((a) => a.id === doc.id);

  /* default: every visit */
  ok('default (every visit): due with no visitor', await due(null));
  ok('default (every visit): due for Carlos too', await due(carlos.id));

  /* once per version — Carlos signed v1 minutes ago */
  let r = await req('PATCH', `/api/admin/agreements/${doc.id}`, { repeat_after_days: 0 });
  ok('set to once (0) sticks', r.data.repeat_after_days === 0, JSON.stringify(r.data.repeat_after_days));
  ok('once: not due for Carlos (already signed this version)', !(await due(carlos.id)));
  ok('once: still due for an unknown face', await due(null));

  /* every 90 days — fresh signature keeps it not due */
  await req('PATCH', `/api/admin/agreements/${doc.id}`, { repeat_after_days: 90 });
  ok('90 days: not due right after signing', !(await due(carlos.id)));

  /* backdate the signature 91 days: now due again */
  const { run } = require('/home/user/smart-lobby/server/db');
  const old = new Date(Date.now() - 91 * 864e5).toISOString();
  run(`UPDATE signatures SET signed_at = ? WHERE agreement_id = ?`, old, doc.id);
  ok('90 days: due again once the signature is 91 days old', await due(carlos.id));

  await req('PATCH', `/api/admin/agreements/${doc.id}`, { repeat_after_days: 3650 });
  ok('10 years: an old signature within the window still counts', !(await due(carlos.id)));

  /* version bump voids standing signatures whatever the frequency */
  await req('PATCH', `/api/admin/agreements/${doc.id}`, { repeat_after_days: 0, version: doc.version + 1 });
  ok('changed document (version bump): due again even on "once"', await due(carlos.id));

  /* back to every visit */
  r = await req('PATCH', `/api/admin/agreements/${doc.id}`, { repeat_after_days: null });
  ok('back to every visit (null) sticks', r.data.repeat_after_days === null, JSON.stringify(r.data.repeat_after_days));
  ok('every visit again: due for Carlos', await due(carlos.id));

  /* unknown visitor_id falls back to the full set */
  ok('nonexistent visitor_id: full set, no crash', await due(999999));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
