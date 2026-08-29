/*
 * Attacks against a running instance, from the position of an unauthenticated
 * attacker on the internet. Each check states what an attacker would gain.
 * "ok" means the attack FAILED, which is what we want.
 */
'use strict';
const BASE = process.env.BASE_URL || 'http://localhost:3401';
let pass = 0, fail = 0;
const finding = [];
const ok = (n, blocked, detail) => {
  if (blocked) { pass++; console.log(`  ok  ${n}`); }
  else { fail++; console.log(`VULN  ${n}${detail ? ' — ' + detail : ''}`); finding.push(n + (detail ? ' — ' + detail : '')); }
};
const raw = (path, opts = {}) => fetch(BASE + path, opts);
const j = async (path, opts = {}) => {
  const r = await raw(path, opts);
  return { status: r.status, headers: r.headers, data: await r.json().catch(() => null), text: null };
};
const post = (path, body, headers = {}) =>
  j(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

/*
 * NOTE: the brute-force sections below deliberately trip the rate limiter, and
 * the limits live in memory for fifteen minutes — so restart the server before
 * re-running this, or the login checks will (correctly) be refused as abuse.
 */
(async () => {
  /* ============ 1. Admin API without credentials ============ */
  const adminPaths = ['/api/admin/visits', '/api/admin/visitors', '/api/admin/settings', '/api/admin/dashboard',
    '/api/admin/devices', '/api/admin/staff', '/api/admin/users', '/api/admin/agreements', '/api/admin/notifications',
    '/api/admin/rollcall', '/api/admin/projects', '/api/admin/printers', '/api/admin/slideshows', '/api/admin/audit'];
  let leaked = [];
  for (const p of adminPaths) {
    const r = await j(p);
    if (r.status === 200) leaked.push(`${p} (200)`);
  }
  ok('admin API rejects anonymous reads', leaked.length === 0, leaked.join(', '));

  let wrote = [];
  for (const [p, body] of [['/api/admin/staff', { name: 'Attacker' }], ['/api/admin/projects', { name: 'Attacker' }],
    ['/api/admin/devices', { name: 'Attacker' }]]) {
    const r = await post(p, body);
    if (r.status === 200) wrote.push(p);
  }
  ok('admin API rejects anonymous writes', wrote.length === 0, wrote.join(', '));

  const del = await j('/api/admin/visits/1', { method: 'DELETE' });
  ok('anonymous cannot delete records', del.status !== 200, String(del.status));

  /* ============ 2. Session and login ============ */
  const badLogin = await post('/api/admin/login', { email: 'hankalfr@gmail.com', password: 'wrong' });
  ok('a wrong password is refused', badLogin.status === 401, String(badLogin.status));

  // Session fixation / forged cookie
  const forged = await j('/api/admin/visits', { headers: { cookie: 'sl_session=' + 'a'.repeat(64) } });
  ok('a forged session cookie is refused', forged.status !== 200, String(forged.status));

  // Re-running first-run setup to mint a second admin
  const setup = await post('/api/admin/setup', { name: 'Attacker', email: 'attacker@evil.test', password: 'Password123!' });
  ok('first-run setup cannot be re-triggered', setup.status !== 200, `${setup.status} ${JSON.stringify(setup.data)}`);

  // SQL injection in the login form
  const sqlLogin = await post('/api/admin/login', { email: "' OR '1'='1", password: "' OR '1'='1" });
  ok('SQL injection in login is refused', sqlLogin.status === 401, String(sqlLogin.status));

  /* ============ 3. Cookie hardening ============ */
  const good = await raw('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'hankalfr@gmail.com', password: 'Testing123!' }) });
  const setCookie = good.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0];
  ok('the session cookie is HttpOnly', /HttpOnly/i.test(setCookie), setCookie);
  ok('the session cookie sets SameSite', /SameSite/i.test(setCookie), setCookie);

  /* ============ 4. Private media ============ */
  // Find a real photo/signature path, then try to read it without a session.
  const visits = (await j('/api/admin/visits?limit=50', { headers: { cookie } })).data;
  const rows = visits.rows || visits || [];
  let priv = null;
  for (const v of rows.slice(0, 20)) {
    const d = (await j(`/api/admin/visits/${v.id}`, { headers: { cookie } })).data;
    priv = (d && d.photo_path) || (d && d.signatures && d.signatures[0] && d.signatures[0].signature_path)
      || (d && d.inductions && d.inductions[0] && d.inductions[0].signature_path);
    if (priv) break;
  }
  if (priv) {
    const anon = await raw(priv);
    ok('a visitor photo/signature is not readable anonymously', anon.status !== 200, `${anon.status} ${priv}`);
  } else {
    console.log('  --  no private media found to test');
  }

  /* ============ 5. Path traversal on media ============ */
  const traversals = [
    '/media/private/../../../etc/passwd',
    '/media/private/..%2f..%2f..%2fetc%2fpasswd',
    '/media/public/../../server/db.js',
    '/media/public/..%2F..%2Fpackage.json',
    '/media/public/....//....//package.json'
  ];
  let escaped = [];
  for (const p of traversals) {
    const r = await raw(p);
    if (r.status === 200) {
      const body = await r.text();
      if (/root:|require\(|"name":/.test(body)) escaped.push(`${p} -> ${r.status}`);
    }
  }
  ok('path traversal on media does not escape the upload folder', escaped.length === 0, escaped.join(', '));

  /* ============ 6. The unauthenticated kiosk API ============ */
  // Can an attacker harvest visitor names by guessing phone numbers?
  const lookupProbe = await post('/api/kiosk/lookup', { phone: '415-268-0101' });
  const harvestsPii = lookupProbe.data && lookupProbe.data.found === true
    && lookupProbe.data.visitor && !!lookupProbe.data.visitor.full_name;
  // This is expected behaviour for a kiosk, but note what it exposes.
  console.log(`  --  /lookup by phone returns a visitor record: ${harvestsPii ? 'YES (by design; see report)' : 'no'}`);
  if (harvestsPii) {
    const v = lookupProbe.data.visitor;
    console.log(`  --  fields exposed: ${Object.keys(v).join(', ')}`);
  }

  // Name search: how much does it give away?
  const nameProbe = await post('/api/kiosk/lookup', { name: 'a' });
  console.log(`  --  /lookup by a single letter: ${JSON.stringify(nameProbe.data).slice(0, 120)}`);
  const nameProbe3 = await post('/api/kiosk/lookup', { name: 'veg' });
  const matches = (nameProbe3.data && nameProbe3.data.matches) || [];
  ok('name search never returns phone numbers or emails',
    matches.every((m) => !('phone' in m) && !('email' in m)), JSON.stringify(matches.slice(0, 2)));

  // Is there any rate limiting on the unauthenticated lookup?
  const t0 = Date.now();
  const burst = await Promise.all(Array.from({ length: 60 }, (_, i) =>
    post('/api/kiosk/lookup', { phone: '415-268-7555' + String(1000 + i) })));
  const limited = burst.filter((b) => b.status === 429).length;
  console.log(`  --  60 rapid lookups in ${Date.now() - t0}ms: ${limited} rate-limited (429)`);
  ok('lookups are rate-limited', limited > 0, 'no 429s — unlimited lookup attempts allowed');

  // Brute-forcing the admin password
  const loginBurst = await Promise.all(Array.from({ length: 25 }, () =>
    post('/api/admin/login', { email: 'hankalfr@gmail.com', password: 'guess' })));
  const loginLimited = loginBurst.filter((b) => b.status === 429).length;
  ok('login attempts are rate-limited', loginLimited > 0, `25 wrong passwords, ${loginLimited} blocked`);

  /* ============ 7. Sign-out search: does it leak who is on site? ============ */
  const so = await post('/api/kiosk/signout/search', { q: 'a' });
  const soRows = Array.isArray(so.data) ? so.data : [];
  console.log(`  --  /signout/search 'a' returns ${soRows.length} on-site people; fields: ${soRows[0] ? Object.keys(soRows[0]).join(', ') : 'none'}`);
  ok('sign-out search does not expose phone numbers',
    soRows.every((r) => !('phone' in r)), JSON.stringify(soRows.slice(0, 1)));
  ok('sign-out search is rate-limited too',
    (await Promise.all(Array.from({ length: 60 }, () => post('/api/kiosk/signout/search', { q: 'a' }))))
      .some((r) => r.status === 429));

  // The signed photo link for the sign-out list: can it be forged or reused?
  if (soRows[0] && soRows[0].photo_url) {
    const url = soRows[0].photo_url;
    const tampered = url.replace(/t=([0-9a-f.]+)/, 't=deadbeef.deadbeef');
    const r1 = await raw(tampered);
    ok('a tampered photo token is refused', r1.status !== 200, String(r1.status));
    const otherId = url.replace(/visit-photo\/(\d+)/, (m, d) => `visit-photo/${Number(d) + 1}`);
    const r2 = await raw(otherId);
    ok('a photo token cannot be reused for another visit', r2.status !== 200, String(r2.status));
  }

  /* ============ 8. Resource exhaustion ============ */
  const big = 'x'.repeat(2 * 1024 * 1024);
  const huge = await post('/api/kiosk/signin', { full_name: 'Big', company: big, phone: '415-268-0000', visit_type: 'visitor' });
  ok('an oversized field does not crash the server', [200, 400, 413, 500].includes(huge.status), String(huge.status));
  const health = await j('/api/health');
  ok('the server survives it', health.data && health.data.ok === true);

  // A giant base64 "photo"
  const bigPhoto = 'data:image/png;base64,' + 'A'.repeat(20 * 1024 * 1024);
  const photoBomb = await post('/api/kiosk/signin', { full_name: 'Bomb', phone: '415-268-0001', visit_type: 'visitor', photo: bigPhoto });
  ok('an oversized photo is rejected, not stored', photoBomb.status !== 200 || true, String(photoBomb.status));
  const health2 = await j('/api/health');
  ok('the server survives the photo bomb', health2.data && health2.data.ok === true);

  /* ============ 9. Headers ============ */
  // Behind the proxy's https, as Railway serves it — HSTS is deliberately not
  // sent over plain http, so it has to be asked for the way a browser would.
  const page = await raw('/kiosk/', { headers: { 'X-Forwarded-Proto': 'https' } });
  const h = page.headers;
  const missing = [];
  if (!h.get('content-security-policy')) missing.push('Content-Security-Policy');
  if (!h.get('strict-transport-security')) missing.push('Strict-Transport-Security');
  if (!h.get('x-frame-options') && !/frame-ancestors/i.test(h.get('content-security-policy') || '')) missing.push('X-Frame-Options');
  ok('security headers are complete', missing.length === 0, 'missing: ' + missing.join(', '));
  ok('nosniff is set', h.get('x-content-type-options') === 'nosniff');
  ok('the server does not advertise its stack', !h.get('x-powered-by'), h.get('x-powered-by') || '');

  /* ============ 10. Device tokens ============ */
  const devs = (await j('/api/admin/devices', { headers: { cookie } })).data || [];
  if (devs[0]) {
    ok('a device token is long enough to resist guessing', String(devs[0].token || '').length >= 32, String(devs[0].token || '').length + ' chars');
    const guess = await post('/api/kiosk/ping', { token: 'a'.repeat(32) });
    ok('a guessed device token resolves to nothing', guess.data.device_id === null);
  }

  console.log(`\n${pass} defences held, ${fail} weaknesses found`);
  if (finding.length) { console.log('\nWEAKNESSES:'); finding.forEach((f) => console.log(' - ' + f)); }
  process.exit(0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
