/* Teams notifications: channel + per-person, on arrival and delivery. */
'use strict';
const http = require('http');
const BASE = process.env.BASE_URL || 'http://localhost:3401';
let cookie = '';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n}${x ? ' — ' + x : ''}`); } };
async function req(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie }, body: body ? JSON.stringify(body) : undefined });
  const setc = res.headers.get('set-cookie'); if (setc) cookie = setc.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => null) };
}

// Stands in for a Teams Workflows endpoint. Two paths so channel and DM are told apart.
const posts = [];
let mode = 'ok';
const teams = http.createServer((q, res) => {
  let body = '';
  q.on('data', (c) => { body += c; });
  q.on('end', () => {
    posts.push({ path: q.url, body: JSON.parse(body || '{}') });
    if (mode === 'refuse') { res.writeHead(400); return res.end('Flow is turned off'); }
    res.writeHead(202); res.end('');
  });
});

const CHANNEL = 'http://127.0.0.1:2700/webhook.office.com/channel';
const PERSON  = 'http://127.0.0.1:2700/webhook.office.com/person';
const SAFETY  = 'http://127.0.0.1:2700/webhook.office.com/safety';
const cardText = (p) => JSON.stringify(p.body);

(async () => {
  await new Promise((r) => teams.listen(2700, '127.0.0.1', r));
  await req('POST', '/api/admin/login', { email: 'owner@example.test', password: 'Testing123!' });

  await req('PUT', '/api/admin/settings', { notify: {
    on_signin: true, on_delivery: true, global_webhook_url: CHANNEL,
    webhook_channel_always: true, webhook_format: 'teams'
  } });
  let r = await req('GET', '/api/admin/settings');
  ok('email settings are gone from the API', !('smtp_host' in r.data.notify) && !('email_enabled' in r.data.notify),
    JSON.stringify(Object.keys(r.data.notify)));
  ok('Teams is the default format', r.data.notify.webhook_format === 'teams');

  /* test button posts to the channel */
  posts.length = 0;
  r = await req('POST', '/api/admin/settings/test-webhook', { url: CHANNEL });
  ok('test posts to the channel', r.data.ok === true && posts.length === 1, JSON.stringify(r.data));
  ok('test uses the Teams Adaptive Card envelope',
    posts[0] && posts[0].body.type === 'message' && posts[0].body.attachments[0].contentType.includes('adaptive'),
    posts[0] && cardText(posts[0]).slice(0, 120));

  /* a staff member with their own Teams link */
  r = await req('POST', '/api/admin/staff', { name: 'John Doe', email: 'dana@x.test', webhook_url: PERSON, active: 1 });
  const host = r.data;
  ok('staff member with a Teams link created', !!host.id && host.webhook_url === PERSON);

  posts.length = 0;
  r = await req('POST', '/api/kiosk/signin', { full_name: 'John Doe 19', company: 'Teams Co', phone: '415-268-0700',
    visit_type: 'contractor', project_id: 1, host_id: host.id, client_ref: 'teams-' + Date.now() });
  ok('sign-in ok', r.status === 200, JSON.stringify(r.data).slice(0, 90));
  await new Promise((r2) => setTimeout(r2, 1200));

  const toPerson = posts.find((p) => p.path.endsWith('/person'));
  const toChannel = posts.find((p) => p.path.endsWith('/channel'));
  ok('the person being visited is messaged', !!toPerson, JSON.stringify(posts.map((p) => p.path)));
  ok('the company channel is posted too', !!toChannel);
  ok('the card names visitor and host', !!toPerson && /John Doe 19/.test(cardText(toPerson)) && /John Doe/.test(cardText(toPerson)));

  /* both attempts are in the activity log as sent */
  r = await req('GET', '/api/admin/notifications');
  const rows = r.data.rows || r.data;
  const webhookSent = rows.filter((x) => x.channel === 'webhook' && x.status === 'sent').length;
  ok('activity log records the Teams posts', webhookSent >= 2, `${webhookSent} sent`);
  ok('no email rows are produced any more', !rows.some((x) => x.channel === 'email' && x.created_at > new Date(Date.now() - 60000).toISOString()));

  /* ---- a visitor type routed to somebody who is not the host ---- */
  r = await req('POST', '/api/admin/staff', {
    name: 'John Doe', email: 'safety@x.test', webhook_url: SAFETY, active: 1 });
  const officer = r.data;
  ok('a safety officer with their own Teams link exists', !!officer.id);

  await req('PUT', '/api/admin/settings', {
    notify: { type_routing: { contractor: { staff: [officer.id] } } } });

  posts.length = 0;
  r = await req('POST', '/api/kiosk/signin', { full_name: 'John Doe 20', company: 'Teams Co', phone: '415-268-0701',
    visit_type: 'contractor', project_id: 1, host_id: host.id, client_ref: 'route-' + Date.now() });
  ok('a routed contractor signs in', r.status === 200, JSON.stringify(r.data).slice(0, 90));
  await new Promise((r2) => setTimeout(r2, 1400));

  const toSafety = posts.find((p) => p.path.endsWith('/safety'));
  ok('the routed person is messaged directly', !!toSafety, JSON.stringify(posts.map((p) => p.path)));
  ok('the person being visited still is', !!posts.find((p) => p.path.endsWith('/person')));
  ok('and the channel still is', !!posts.find((p) => p.path.endsWith('/channel')));

  const channelCard = posts.find((p) => p.path.endsWith('/channel'));
  const entities = channelCard.body.attachments[0].content.msteams.entities;
  ok('the channel post tags both of them', entities.length === 2,
    JSON.stringify(entities.map((e) => e.mentioned.id)));
  ok('…the host and the routed person', 
    entities.map((e) => e.mentioned.id).sort().join(',') === 'dana@x.test,safety@x.test',
    entities.map((e) => e.mentioned.id).join(','));
  ok('every tag in the text is one Teams was told about',
    entities.every((e) => cardText(channelCard).includes(e.text.replace(/"/g, '\\"'))
      || JSON.stringify(channelCard.body.attachments[0].content.body).includes(e.text)),
    JSON.stringify(channelCard.body.attachments[0].content.body).slice(0, 250));

  /* a visitor of another type is not routed to them */
  posts.length = 0;
  r = await req('POST', '/api/kiosk/signin', { full_name: 'John Doe 21', company: 'Teams Co', phone: '415-268-0702',
    visit_type: 'visitor', host_id: host.id, client_ref: 'noroute-' + Date.now() });
  await new Promise((r2) => setTimeout(r2, 1400));
  ok('a type with no routing does not reach them',
    !posts.find((p) => p.path.endsWith('/safety')), JSON.stringify(posts.map((p) => p.path)));

  /* somebody who has left the company stops being tagged */
  await req('PATCH', `/api/admin/staff/${officer.id}`, { active: 0 });
  posts.length = 0;
  r = await req('POST', '/api/kiosk/signin', { full_name: 'John Doe 22', company: 'Teams Co', phone: '415-268-0703',
    visit_type: 'contractor', project_id: 1, host_id: host.id, client_ref: 'gone-' + Date.now() });
  await new Promise((r2) => setTimeout(r2, 1400));
  ok('a routed person who has left is dropped, not left tagged forever',
    !posts.find((p) => p.path.endsWith('/safety')), JSON.stringify(posts.map((p) => p.path)));

  await req('PUT', '/api/admin/settings', { notify: { type_routing: {} } });

  /* a refused flow is reported, not swallowed */
  mode = 'refuse';
  r = await req('POST', '/api/admin/settings/test-webhook', { url: CHANNEL });
  ok('a refused Teams flow is reported', r.data.ok === false && (r.data.detail || '').length > 5, JSON.stringify(r.data));
  mode = 'ok';

  teams.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
