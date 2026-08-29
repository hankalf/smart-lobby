/* The wall board: behind a key, revocable, and telling the truth about who is in. */
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
// No cookie at all — what somebody holding only the link would see.
const anon = (path) => fetch(BASE + path, { cache: 'no-store' });

(async () => {
  await req('POST', '/api/admin/login', { email: 'hankalfr@gmail.com', password: 'Testing123!' });

  /* ---- off by default, and nothing is served ---- */
  let r = await req('GET', '/api/admin/board');
  ok('the board starts switched off', r.status === 200 && !r.data.url, JSON.stringify(r.data));
  ok('a guessed board address is not found', (await anon('/board/abc123')).status === 404);

  /* ---- turning it on mints a key ---- */
  r = await req('POST', '/api/admin/board/key', { enabled: true });
  const url = r.data.url;
  const key = r.data.key;
  ok('turning it on creates a link', r.status === 200 && !!url && !!key, JSON.stringify(r.data).slice(0, 90));
  ok('the key is long enough to be unguessable', key.length >= 32, `${key.length} chars`);

  const path = url.slice(url.indexOf('/board/'));
  ok('the board page loads with no login', (await anon(path)).status === 200);
  ok('a wrong key on the same board is refused', (await anon('/board/' + 'f'.repeat(key.length))).status === 404);

  /* ---- the roster ---- */
  await req('POST', '/api/kiosk/signin', {
    full_name: 'Hank Alfred 41', company: 'Board Co', phone: '415-268-7001',
    visit_type: 'contractor', project_id: 1, client_ref: 'board-' + Date.now()
  });
  let data = await (await anon(`/api/board/${key}/data`)).json();
  ok('the roster loads without a login', Array.isArray(data.onsite), JSON.stringify(data).slice(0, 80));
  const me = data.onsite.find((p) => p.name === 'Hank Alfred 41');
  ok('somebody who just signed in is on it', !!me, data.onsite.map((p) => p.name).join(','));
  ok('their company is shown', me && me.company === 'Board Co', me && me.company);
  ok('the arrival counts as recent', me && Date.parse(me.in) >= Date.parse(data.recent_since));
  ok('the board carries the site heading', typeof data.title === 'string' && data.title.length > 0, data.title);

  /* ---- signing out moves them across ---- */
  const visit = (await req('GET', '/api/admin/visits?limit=50')).data.find((v) => v.full_name === 'Hank Alfred 41');
  await req('POST', '/api/kiosk/signout', { visit_id: visit.id });
  data = await (await anon(`/api/board/${key}/data`)).json();
  ok('they leave the on-site list', !data.onsite.some((p) => p.name === 'Hank Alfred 41'));
  ok('…and appear under just signed out', data.left.some((p) => p.name === 'Hank Alfred 41'),
    data.left.map((p) => p.name).join(','));

  /* ---- what the panel can hide ---- */
  await req('PUT', '/api/admin/settings', { board: { show_company: false, show_host: false } });
  data = await (await anon(`/api/board/${key}/data`)).json();
  ok('company can be hidden', data.left.every((p) => p.company === null));
  ok('the host can be hidden', data.left.every((p) => p.host === null));
  await req('PUT', '/api/admin/settings', { board: { show_company: true, show_host: true } });

  /* ---- turning it off revokes every copy of the link ---- */
  r = await req('POST', '/api/admin/board/key', { enabled: false });
  ok('turning it off clears the key', r.status === 200 && !r.data.url && !r.data.key, JSON.stringify(r.data));
  ok('the old link stops serving the page', (await anon(path)).status === 404);
  ok('the old link stops serving the roster', (await anon(`/api/board/${key}/data`)).status === 404);

  /* ---- a new link is a different link ---- */
  const first = (await req('POST', '/api/admin/board/key', { enabled: true })).data.key;
  const second = (await req('POST', '/api/admin/board/key', { enabled: true })).data.key;
  ok('asking for a new link gives a different one', first !== second, `${first} / ${second}`);
  ok('the previous link no longer works', (await anon(`/api/board/${first}/data`)).status === 404);

  /* ---- the key never reaches the kiosk ---- */
  const cfg = await (await anon('/api/kiosk/config')).text();
  ok('the board key is not in the kiosk config', !cfg.includes(second));

  /* ---- the change is on the record ---- */
  const audit = (await req('GET', '/api/admin/audit')).data;
  ok('issuing a link is recorded', audit.some((a) => a.action === 'board_key_issued'));
  ok('turning it off is recorded', audit.some((a) => a.action === 'board_disabled'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
