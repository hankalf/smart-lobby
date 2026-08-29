/* Deleting no longer destroys: the record is archived, viewable and restorable. */
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
/* The visits list answers with a bare array, not {rows}. */
const liveVisits = async () => {
  const d = (await req('GET', '/api/admin/visits?limit=100')).data;
  return Array.isArray(d) ? d : (d && d.rows) || [];
};
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

(async () => {
  await req('POST', '/api/admin/login', { email: 'hankalfr@gmail.com', password: 'Testing123!' });
  const agreement = (await req('GET', '/api/admin/agreements')).data[0];

  /* ---- a visit with a signed document, then deleted ---- */
  let r = await req('POST', '/api/kiosk/signin', {
    full_name: 'Hank Alfred 40', company: 'Archive Co', phone: '415-268-1001',
    visit_type: 'contractor', project_id: 1, photo: SIG,
    documents: [{ agreement_id: agreement.id, signature: SIG, answers: {} }],
    client_ref: 'arch-' + Date.now()
  });
  const visitId = r.data.visit.id;
  const visitorId = r.data.visit.visitor_id;
  ok('a visit with a signature is created', r.status === 200 && !!visitId, JSON.stringify(r.data).slice(0, 80));

  let detail = (await req('GET', `/api/admin/visits/${visitId}`)).data;
  ok('it has a signature before deletion', detail.signatures && detail.signatures.length === 1,
    JSON.stringify((detail.signatures || []).length));
  const sigPath = detail.signatures[0].signature_path;

  r = await req('DELETE', `/api/admin/visits/${visitId}`);
  ok('deleting reports it was archived', r.status === 200 && r.data.archived === true, JSON.stringify(r.data));
  ok('the visit is really gone from the live list',
    (await req('GET', `/api/admin/visits/${visitId}`)).status === 404
    || !(await req('GET', `/api/admin/visits/${visitId}`)).data
    || !(await req('GET', `/api/admin/visits/${visitId}`)).data.full_name);

  const list = (await req('GET', '/api/admin/archive')).data;
  const entry = list.find((e) => e.kind === 'visit' && e.record_id === visitId);
  ok('it appears in the deleted list', !!entry, JSON.stringify(list.slice(0, 2)));
  ok('the list shows who it was', entry && entry.label === 'Hank Alfred 40', entry && entry.label);
  ok('…and that a document was signed', entry && entry.summary.documents_signed === 1, JSON.stringify(entry && entry.summary));
  ok('…and who deleted it', entry && typeof entry.deleted_by === 'string' && entry.deleted_by.length > 0, entry && entry.deleted_by);

  /* ---- the signature image survives while archived ---- */
  const img = await fetch(BASE + sigPath, { headers: { cookie } });
  ok('the signature image is still on disk while archived', img.status === 200, String(img.status));

  /* ---- restore ---- */
  r = await req('POST', `/api/admin/archive/${entry.id}/restore`);
  ok('restoring succeeds', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
  detail = (await req('GET', `/api/admin/visits/${visitId}`)).data;
  ok('the visit is back under its own id', detail && detail.full_name === 'Hank Alfred 40', JSON.stringify(detail).slice(0, 80));
  ok('its signature came back too', detail.signatures && detail.signatures.length === 1,
    JSON.stringify((detail.signatures || []).length));
  ok('it is no longer listed as deleted',
    !(await req('GET', '/api/admin/archive')).data.some((e) => e.kind === 'visit' && e.record_id === visitId));

  /* ---- deleting a visitor takes their visits, and brings them all back ---- */
  r = await req('DELETE', `/api/admin/visitors/${visitorId}`);
  ok('deleting a visitor archives them', r.status === 200 && r.data.archived === true, JSON.stringify(r.data));
  const vEntry = (await req('GET', '/api/admin/archive')).data.find((e) => e.kind === 'visitor' && e.record_id === visitorId);
  ok('the visitor is in the deleted list', !!vEntry);
  ok('with a count of the visits taken with them', vEntry && vEntry.summary.visits >= 1, JSON.stringify(vEntry && vEntry.summary));
  ok('their visits are gone from the live list',
    !(await liveVisits()).some((v) => v.full_name === 'Hank Alfred 40'));

  r = await req('POST', `/api/admin/archive/${vEntry.id}/restore`);
  ok('restoring the visitor works', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
  const back = await liveVisits();
  ok('their visit came back with them', back.some((v) => v.full_name === 'Hank Alfred 40'),
    `${back.length} visit(s) listed`);

  /* ---- restoring twice is refused, with a reason ---- */
  r = await req('DELETE', `/api/admin/visits/${visitId}`);
  const again = (await req('GET', '/api/admin/archive')).data.find((e) => e.record_id === visitId && e.kind === 'visit');
  await req('POST', `/api/admin/archive/${again.id}/restore`);
  r = await req('POST', `/api/admin/archive/${again.id}/restore`);
  ok('restoring an entry twice is refused politely', r.status === 400 && /no longer|already/i.test(r.data.message || ''),
    JSON.stringify(r.data));

  /* ---- purging is permanent, and clears the image ---- */
  r = await req('DELETE', `/api/admin/visits/${visitId}`);
  const toPurge = (await req('GET', '/api/admin/archive')).data.find((e) => e.record_id === visitId && e.kind === 'visit');
  r = await req('DELETE', `/api/admin/archive/${toPurge.id}`);
  ok('purging succeeds', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
  ok('the entry is gone from the deleted list',
    !(await req('GET', '/api/admin/archive')).data.some((e) => e.id === toPurge.id));
  const gone = await fetch(BASE + sigPath, { headers: { cookie } });
  ok('the signature image is removed on purge', gone.status !== 200, String(gone.status));

  /* ---- the activity log ---- */
  const audit = (await req('GET', '/api/admin/audit')).data;
  ok('the activity log is readable', Array.isArray(audit) && audit.length > 0, String(audit && audit.length));
  ok('it records the deletions', audit.some((a) => a.action === 'delete' && a.entity === 'visit'));
  ok('it records the restores', audit.some((a) => a.action === 'restore'));
  ok('it records the purge', audit.some((a) => a.action === 'purge'));
  ok('it names who did it', audit.some((a) => a.user_name || a.user_email), JSON.stringify(audit[0]));

  /* ---- neither endpoint is open to the world ---- */
  const anonArchive = await fetch(BASE + '/api/admin/archive');
  const anonAudit = await fetch(BASE + '/api/admin/audit');
  ok('the deleted list needs a login', anonArchive.status !== 200, String(anonArchive.status));
  ok('the activity log needs a login', anonAudit.status !== 200, String(anonAudit.status));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
