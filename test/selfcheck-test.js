/*
 * What this install can actually do, asked of the machine it is running on.
 *
 * The checks worth writing here are not "does it return JSON". They are the
 * ones that decide whether the page is worth opening at all:
 *
 *   - a broken install is reported as broken. Every state it can report is
 *     driven into existence and read back, because a self-check that says
 *     everything is fine on a site that is not is worse than no self-check —
 *     it is the same lie as a test button that says Delivered.
 *   - a check that throws is reported as having thrown, not quietly dropped.
 *   - nothing anybody would see is sent. It is pressed twice here and the
 *     webhook stub is checked for silence, because a diagnostic that posts to
 *     a real channel is one nobody dares press on a busy morning.
 */
'use strict';
const http = require('http');
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
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, type: res.headers.get('content-type') || '' };
}

const posts = [];
const hook = http.createServer((q, res) => {
  let b = '';
  q.on('data', (c) => { b += c; });
  q.on('end', () => { posts.push(q.url); res.writeHead(202).end(''); });
});

/** One named check out of the report. */
const find = (report, id) => report.checks.find((c) => c.id === id) || {};

(async () => {
  await new Promise((r) => hook.listen(2821, '127.0.0.1', r));
  const CHANNEL = 'http://127.0.0.1:2821/webhook.office.com/quiet';

  /* ---- not open to the world ---- */
  let r = await req('GET', '/api/admin/selfcheck');
  ok('the check needs a login', r.status === 401, String(r.status));

  await req('POST', '/api/admin/login', { email: 'owner@example.test', password: 'Testing123!' });

  r = await req('GET', '/api/admin/selfcheck');
  const report = r.data;
  ok('it answers with a report', r.status === 200 && Array.isArray(report.checks) && report.checks.length > 10,
    `${report.checks && report.checks.length} checks`);
  ok('…every check says what it is, which group it belongs to and how it went',
    report.checks.every((c) => c.id && c.label && c.group && c.detail
      && ['ok', 'warn', 'bad', 'info', 'skip'].includes(c.state)),
    JSON.stringify(report.checks.find((c) => !c.detail) || {}).slice(0, 120));
  ok('…and it counts them up, worst first',
    typeof report.worst === 'string' && report.counts && typeof report.ran_at === 'string',
    JSON.stringify({ worst: report.worst, counts: report.counts }));

  /*
   * The whole install, not a corner of it. A diagnostic that quietly stopped
   * covering the backups the day somebody refactored them would be worse than
   * none, so the areas are named here rather than counted.
   */
  const groups = [...new Set(report.checks.map((c) => c.group))];
  ok('it covers the server, the outside world, notifications, settings, tablets and backups',
    ['This server', 'Reaching the outside', 'Notifications', 'Settings that disagree', 'Tablets', 'Backups']
      .every((g) => groups.includes(g)), groups.join(' | '));

  /* ---- it sends nothing anybody would see ---- */
  await req('PUT', '/api/admin/settings', {
    notify: { global_webhook_url: CHANNEL, webhook_channel_always: true, on_signin: true }
  });
  posts.length = 0;
  await req('GET', '/api/admin/selfcheck');
  await req('GET', '/api/admin/selfcheck');
  await new Promise((done) => setTimeout(done, 600));
  ok('running it twice posts nothing to a real channel',
    posts.length === 0, `${posts.length} post(s): ${posts.join(', ')}`);

  r = await req('GET', '/api/admin/selfcheck');
  ok('…and it notices the channel is configured',
    /company channel/.test(find(r.data, 'destinations').detail || ''),
    find(r.data, 'destinations').detail);

  /* ---- a broken install is reported as broken ---- */

  /*
   * The exact state that refused every phone check-in on the live site: the
   * fence switched on with nowhere to be. Each of these settings is valid on
   * its own, which is why nothing else catches them.
   */
  await req('PUT', '/api/admin/settings', {
    geofence: { enabled: true, lat: null, lng: null },
    kiosk: { self_checkin_enabled: true },
    board: { enabled: true }
  });
  r = await req('GET', '/api/admin/selfcheck');
  ok('a fence switched on with no coordinates is reported as broken, not fine',
    find(r.data, 'geofence').state === 'bad' && /refused/.test(find(r.data, 'geofence').detail),
    JSON.stringify(find(r.data, 'geofence')));
  ok('…and says what to do about it',
    /switch the fence off|site location/i.test(find(r.data, 'geofence').hint || ''),
    find(r.data, 'geofence').hint);
  ok('phone check-in on with no device code is flagged',
    find(r.data, 'selfcheckin').state === 'warn' && /no device has a code/.test(find(r.data, 'selfcheckin').detail),
    JSON.stringify(find(r.data, 'selfcheckin')));
  ok('the whole report takes the worst state of anything in it',
    r.data.worst === 'bad', r.data.worst);

  /* And the same settings, put right, stop being reported. */
  await req('PUT', '/api/admin/settings', {
    geofence: { enabled: true, lat: 37.7955, lng: -122.2712, radius_m: 250 }
  });
  r = await req('GET', '/api/admin/selfcheck');
  ok('a fence with somewhere to be is reported as fine',
    find(r.data, 'geofence').state === 'ok' && /250 m/.test(find(r.data, 'geofence').detail),
    JSON.stringify(find(r.data, 'geofence')));

  /* ---- the text version, which is the point of the page ---- */
  r = await req('GET', '/api/admin/selfcheck.txt');
  const text = String(r.data);
  ok('there is a plain-text version to paste to somebody who can help',
    r.status === 200 && /text\/plain/.test(r.type) && /Smart Lobby — install check/.test(text),
    `${r.status} ${r.type}`);
  ok('…carrying every check, with its state readable at a glance',
    report.checks.every((c) => text.includes(c.label)) && /OK |WARN|BAD /.test(text),
    text.slice(0, 120));
  ok('…and the advice for the ones that need it',
    /Set PUBLIC_URL|switch the fence off|Add a volume|company channel/i.test(text),
    text.split('\n').slice(0, 6).join(' / '));

  /* ---- a check that throws is reported, not swallowed ---- */
  const selfcheck = require('../server/selfcheck');
  const synthetic = {
    ran_at: 'now',
    checks: [{ id: 'x', group: 'G', label: 'A check', state: 'bad', detail: 'it broke', hint: 'do this' }]
  };
  ok('the text version marks a bad check and prints its advice',
    /BAD .*A check: it broke/.test(selfcheck.asText(synthetic))
    && /do this/.test(selfcheck.asText(synthetic)),
    selfcheck.asText(synthetic));

  /* Put the fixtures back for the suites after this one. */
  await req('PUT', '/api/admin/settings', {
    geofence: { enabled: false, lat: null, lng: null },
    kiosk: { self_checkin_enabled: false },
    board: { enabled: false },
    notify: { global_webhook_url: '' }
  });

  await new Promise((done) => hook.close(done));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
