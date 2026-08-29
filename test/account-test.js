/* Passwords, backups, retry, retention, the privacy note and the undo. */
'use strict';
const BASE = process.env.BASE_URL || 'http://localhost:3401';
let cookie = '';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n}${x ? ' — ' + x : ''}`); } };
async function req(method, path, body, jar) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(jar === null ? {} : { cookie: jar || cookie }) },
    body: body ? JSON.stringify(body) : undefined
  });
  const setc = res.headers.get('set-cookie');
  if (setc && jar === undefined) cookie = setc.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => null), cookie: setc ? setc.split(';')[0] : null };
}

(async () => {
  const OWNER = 'hankalfr@gmail.com';
  let ownerPass = 'Testing123!';
  await req('POST', '/api/admin/login', { email: OWNER, password: ownerPass });

  /* ---------------------------------------------------------- passwords */

  let r = await req('POST', '/api/admin/me/password', { current: 'not-my-password', password: 'brandnew123' });
  ok('the wrong current password is refused', r.status === 400 && r.data.error === 'wrong_password', JSON.stringify(r.data));
  r = await req('POST', '/api/admin/me/password', { current: ownerPass, password: 'short' });
  ok('a too-short new password is refused', r.status === 400 && r.data.error === 'weak_password', JSON.stringify(r.data));

  // A second browser, to prove it gets signed out.
  const second = (await req('POST', '/api/admin/login', { email: OWNER, password: ownerPass }, null)).cookie;
  ok('a second sign-in works before the change',
    (await req('GET', '/api/admin/me', null, second)).status === 200);

  const changed = 'Testing456!';
  r = await req('POST', '/api/admin/me/password', { current: ownerPass, password: changed });
  ok('changing your own password works', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
  ownerPass = changed;
  ok('the browser that changed it stays signed in', (await req('GET', '/api/admin/me')).status === 200);
  ok('every other browser is signed out', (await req('GET', '/api/admin/me', null, second)).status === 401);
  ok('the old password no longer works',
    (await req('POST', '/api/admin/login', { email: OWNER, password: 'Testing123!' }, null)).status !== 200);
  ok('the new one does',
    (await req('POST', '/api/admin/login', { email: OWNER, password: changed }, null)).status === 200);

  /* ---- an owner setting somebody else's ---- */
  r = await req('POST', '/api/admin/users', { name: 'Reset Me', email: 'reset@x.test', password: 'firstpass1' });
  const other = r.data;
  ok('a second user can be added', r.status === 200 && !!other.id, JSON.stringify(r.data));
  r = await req('POST', `/api/admin/users/${other.id}/password`, { password: 'secondpass1' });
  ok('the owner can set their password', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
  ok('they can sign in with it',
    (await req('POST', '/api/admin/login', { email: 'reset@x.test', password: 'secondpass1' }, null)).status === 200);
  r = await req('POST', `/api/admin/users/${other.id}/password`, { password: 'tiny' });
  ok('a too-short reset is refused', r.status === 400, JSON.stringify(r.data));
  r = await req('POST', '/api/admin/users/999999/password', { password: 'longenough1' });
  ok('resetting a user who does not exist is a 404', r.status === 404);

  // A non-owner must not be able to reset anyone.
  const theirs = (await req('POST', '/api/admin/login', { email: 'reset@x.test', password: 'secondpass1' }, null)).cookie;
  r = await req('POST', `/api/admin/users/${other.id}/password`, { password: 'anotherone1' }, theirs);
  ok('an ordinary admin cannot reset passwords', r.status === 403, `${r.status} ${JSON.stringify(r.data)}`);

  await req('POST', '/api/admin/login', { email: OWNER, password: ownerPass });
  r = await req('POST', `/api/admin/users/${(await req('GET', '/api/admin/me')).data.id}/password`, { password: 'viaotherroute1' });
  ok('the owner is sent to their own form instead', r.status === 400 && r.data.error === 'use_own_form', JSON.stringify(r.data));
  await req('DELETE', `/api/admin/users/${other.id}`);

  ok('neither password route is open to the world',
    (await fetch(BASE + '/api/admin/me/password', { method: 'POST' })).status === 401);

  /* ------------------------------------------------------------ backups */

  r = await req('POST', '/api/admin/backups');
  ok('a backup can be taken on demand', r.status === 200 && r.data.bytes > 0, JSON.stringify(r.data));
  const file = r.data.file;
  r = await req('GET', '/api/admin/backups');
  ok('it appears in the list', r.data.backups.some((b) => b.file === file), JSON.stringify(r.data.backups).slice(0, 90));
  ok('the list says how many are kept', r.data.keep >= 1, String(r.data.keep));

  const dl = await fetch(`${BASE}/api/admin/backups/${encodeURIComponent(file)}`, { headers: { cookie } });
  const body = Buffer.from(await dl.arrayBuffer());
  ok('it downloads', dl.status === 200 && body.length > 0, `${dl.status} ${body.length} bytes`);
  ok('and it really is a SQLite database', body.slice(0, 15).toString() === 'SQLite format 3', body.slice(0, 15).toString());

  ok('a backup cannot be fetched by climbing out of the folder',
    (await fetch(`${BASE}/api/admin/backups/${encodeURIComponent('../smartlobby.db')}`, { headers: { cookie } })).status === 404);
  ok('backups need a login', (await fetch(`${BASE}/api/admin/backups`)).status === 401);
  ok('so does downloading one', (await fetch(`${BASE}/api/admin/backups/${encodeURIComponent(file)}`)).status === 401);

  /* ------------------------------------------------------- health check */

  r = await req('GET', '/api/admin/dashboard');
  ok('the dashboard reports on notifications', !!(r.data.health && r.data.health.notifications), JSON.stringify(r.data.health));
  ok('…and on devices that have gone quiet', Array.isArray(r.data.health.quiet_devices));

  /* ---- a webhook that fails for a retryable reason is queued ---- */
  await req('PUT', '/api/admin/settings', { notify: { global_webhook_url: 'http://127.0.0.1:9/teams' } });
  await req('POST', '/api/kiosk/signin', {
    full_name: 'Retry Rita', company: 'Retry Co', phone: '415-268-7301',
    visit_type: 'contractor', project_id: 1, client_ref: 'retry-' + Date.now()
  });
  await new Promise((r2) => setTimeout(r2, 1200));
  const log = (await req('GET', '/api/admin/notifications')).data;
  const rows = log.rows || log;
  const rita = rows.find((n) => (n.subject || '').includes('Retry Rita'));
  ok('an unreachable webhook is queued to try again', rita && rita.status === 'retrying',
    JSON.stringify(rita && { status: rita.status, error: (rita.error || '').slice(0, 50) }));
  ok('…with a time to try it at', rita && !!rita.next_try_at, rita && String(rita.next_try_at));
  ok('…and what to send kept with it', rita && !!rita.payload);

  r = await req('GET', '/api/admin/dashboard');
  ok('the dashboard notices it is waiting', r.data.health.notifications.waiting >= 1,
    JSON.stringify(r.data.health.notifications));
  await req('PUT', '/api/admin/settings', { notify: { global_webhook_url: '' } });

  /* ------------------------------------------- which events, and for whom */

  // A webhook that answers, so "did it post" is a real question.
  const http = require('http');
  const posts = [];
  const sink = http.createServer((rq, rs) => {
    let body = '';
    rq.on('data', (c) => { body += c; });
    rq.on('end', () => { posts.push(body); rs.writeHead(200).end('ok'); });
  });
  await new Promise((go) => sink.listen(0, '127.0.0.1', go));
  const hook = `http://127.0.0.1:${sink.address().port}/hook`;

  // A visitor needs somebody to be visiting, so one is made here.
  const evHost = (await req('POST', '/api/admin/staff', { name: 'Event Host', email: 'ev@x.test', active: 1 })).data;
  const settle = () => new Promise((go) => setTimeout(go, 500));
  const signIn = async (name, type, extra = {}) => {
    posts.length = 0;
    const res = await req('POST', '/api/kiosk/signin', {
      full_name: name, company: 'Events Co', phone: '415-268-7501',
      visit_type: type, client_ref: 'ev-' + Math.random().toString(36).slice(2), ...extra
    });
    await settle();
    return res;
  };

  await req('PUT', '/api/admin/settings', {
    notify: { global_webhook_url: hook, on_signin: true, on_signout: true, types_notified: {} }
  });
  let res = await signIn('Event One', 'contractor', { project_id: 1 });
  ok('signing in posts to the channel', posts.length === 1, `${posts.length} post(s)`);
  const firstVisit = res.data.visit && res.data.visit.id;

  posts.length = 0;
  await req('POST', `/api/admin/visits/${firstVisit}/signout`);
  await settle();
  ok('signing out posts when that is switched on', posts.length === 1, `${posts.length} post(s)`);

  await req('PUT', '/api/admin/settings', { notify: { on_signout: false } });
  res = await signIn('Event Two', 'contractor', { project_id: 1 });
  posts.length = 0;
  await req('POST', `/api/admin/visits/${res.data.visit.id}/signout`);
  await settle();
  ok('…and stays quiet when it is not', posts.length === 0, `${posts.length} post(s)`);

  await req('PUT', '/api/admin/settings', { notify: { on_signin: false } });
  await signIn('Event Three', 'contractor', { project_id: 1 });
  ok('sign-in can be switched off entirely', posts.length === 0, `${posts.length} post(s)`);

  await req('PUT', '/api/admin/settings', {
    notify: { on_signin: true, types_notified: { contractor: false, visitor: true } }
  });
  await signIn('Quiet Contractor', 'contractor', { project_id: 1 });
  ok('a visitor type can be left out', posts.length === 0, `${posts.length} post(s)`);
  await signIn('Loud Visitor', 'visitor', { host_id: evHost.id });
  ok('…while another still posts', posts.length === 1, `${posts.length} post(s)`);

  // A type nobody has switched off must still be announced.
  await req('PUT', '/api/admin/settings', { notify: { types_notified: { contractor: false } } });
  await signIn('New Type Person', 'visitor', { host_id: evHost.id });
  ok('a type not named in the list posts by default', posts.length === 1, `${posts.length} post(s)`);

  await req('PUT', '/api/admin/settings', { notify: { global_webhook_url: '', types_notified: {} } });
  sink.close();

  /* -------------------------------------------------- privacy & the ID */

  await req('PUT', '/api/admin/settings', {
    details: { contractor: { id_scan: 'required', photo: 'required' } },
    privacy: { notice_enabled: true, notice_text: '', retain_id_days: 30 }
  });
  let cfg = await (await fetch(`${BASE}/api/kiosk/config`)).json();
  ok('the kiosk is given a privacy note', !!(cfg.privacy && cfg.privacy.notice), JSON.stringify(cfg.privacy));
  ok('it mentions the photo it takes', /photograph/i.test(cfg.privacy.notice), cfg.privacy.notice);
  ok('it mentions the ID it reads', /ID/.test(cfg.privacy.notice), cfg.privacy.notice);
  ok('it says how long the ID is kept', /30 days/.test(cfg.privacy.notice), cfg.privacy.notice);
  ok('there is a Spanish version', !!cfg.privacy.notice_es && cfg.privacy.notice_es !== cfg.privacy.notice);
  ok('the retention numbers themselves stay on the server',
    cfg.privacy.retain_visits_days === undefined && cfg.privacy.retain_id_days === undefined,
    JSON.stringify(Object.keys(cfg.privacy)));

  // A notice that claims a photo on a kiosk that never asks for one is worse than none.
  await req('PUT', '/api/admin/settings', {
    details: { visitor: { photo: 'off', id_scan: 'off' }, contractor: { photo: 'off', id_scan: 'off' },
      interview: { photo: 'off', id_scan: 'off' }, driver: { photo: 'off', id_scan: 'off' } }
  });
  cfg = await (await fetch(`${BASE}/api/kiosk/config`)).json();
  ok('with no photo asked for, the note does not claim one', !/photograph/i.test(cfg.privacy.notice), cfg.privacy.notice);

  await req('PUT', '/api/admin/settings', { privacy: { notice_text: 'We keep an eye on things. Ask Hank.' } });
  cfg = await (await fetch(`${BASE}/api/kiosk/config`)).json();
  ok('wording you type wins outright', cfg.privacy.notice === 'We keep an eye on things. Ask Hank.', cfg.privacy.notice);

  await req('PUT', '/api/admin/settings', { privacy: { notice_enabled: false } });
  cfg = await (await fetch(`${BASE}/api/kiosk/config`)).json();
  ok('and it can be switched off entirely', cfg.privacy.notice === null, JSON.stringify(cfg.privacy));
  await req('PUT', '/api/admin/settings', { privacy: { notice_enabled: true, notice_text: '' },
    details: { contractor: { photo: 'required' } } });

  /* --------------------------------------------------- undoing a signout */

  r = await req('POST', '/api/kiosk/signin', {
    full_name: 'Oops Signout', company: 'Undo Co', phone: '415-268-7401',
    visit_type: 'contractor', project_id: 1, client_ref: 'undo-' + Date.now()
  });
  const visitId = r.data.visit.id;
  await req('POST', `/api/admin/visits/${visitId}/signout`);
  let v = (await req('GET', `/api/admin/visits/${visitId}`)).data;
  ok('signing somebody out marks them out', v.status === 'out', v.status);

  r = await req('POST', `/api/admin/visits/${visitId}/undo-signout`);
  ok('the sign-out can be undone', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
  v = (await req('GET', `/api/admin/visits/${visitId}`)).data;
  ok('they are back on site', v.status === 'onsite', v.status);
  ok('with no sign-out time left on the record', !v.signed_out_at, String(v.signed_out_at));
  ok('and it is the same visit, not a new one', v.id === visitId);

  r = await req('POST', `/api/admin/visits/${visitId}/undo-signout`);
  ok('undoing twice is refused politely', r.status === 400 && /already/i.test(r.data.message || ''), JSON.stringify(r.data));
  ok('undoing a visit that does not exist is a 404',
    (await req('POST', '/api/admin/visits/999999/undo-signout')).status === 404);

  const audit = (await req('GET', '/api/admin/audit')).data;
  ok('the password change is on the record', audit.some((a) => a.action === 'password_change'));
  ok('so is the reset', audit.some((a) => a.action === 'password_reset'));
  ok('so is the backup', audit.some((a) => a.action === 'backup'));
  ok('so is putting somebody back on site', audit.some((a) => a.action === 'undo_signout'));

  /* ---- put the password back so later suites can sign in ---- */
  await req('POST', '/api/admin/me/password', { current: ownerPass, password: 'Testing123!' });
  ok('the owner password is restored for the suites that follow',
    (await req('POST', '/api/admin/login', { email: OWNER, password: 'Testing123!' }, null)).status === 200);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
