/*
 * Checking in from your own phone, and the fence around it.
 *
 * The fence is a deterrent, not a control — a browser reports whatever
 * coordinates it chooses to — so what is worth proving is the shape of it: the
 * code cannot be invented, switching the feature off stops every printed sign
 * at once, a tablet at the gate is never asked where it is, and the site's own
 * coordinates are never published to anyone who asks for the kiosk config.
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

/* The demo site, and a point a comfortable walk away from it. */
const SITE = { lat: 37.7749, lng: -122.4194 };
const NEAR = { lat: 37.77495, lng: -122.41945, accuracy: 20 };   // a few metres
const FAR = { lat: 37.8044, lng: -122.2712, accuracy: 20 };      // across the bay

let n = 0;
const signIn = (extra) => req('POST', '/api/kiosk/signin', {
  full_name: `Phone Person ${++n}`, phone: `415773${String(1000 + n)}`,
  company: 'Phone Test Ltd', visit_type: 'visitor',
  client_ref: `self-${Date.now()}-${n}`, ...extra
});

(async () => {
  await req('POST', '/api/admin/login', { email: 'hankalfr@gmail.com', password: 'Testing123!' });
  const staff = (await req('GET', '/api/admin/staff')).data || [];
  const host = staff[0]
    || (await req('POST', '/api/admin/staff', { name: 'Phone Host', email: 'ph@example.com', active: 1 })).data;

  const BEFORE = (await req('GET', '/api/admin/settings')).data;
  const device = (await req('POST', '/api/admin/devices', { name: 'Phone Gate Sign' })).data;
  const made = [];
  const track = (r) => { if (r.data && r.data.visit) made.push(r.data.visit.id); return r; };

  /* ---- the maths, before anything else depends on it ---- */
  const geofence = require('../server/geofence');
  ok('the distance between two points is right to within a few metres',
    Math.abs(geofence.metresBetween(SITE.lat, SITE.lng, 37.7849, -122.4194) - 1112) < 25,
    String(geofence.metresBetween(SITE.lat, SITE.lng, 37.7849, -122.4194)));

  /* ---- a device offers it, and is given a link ---- */
  let r = await req('PATCH', `/api/admin/devices/${device.id}`, { self_checkin: true });
  ok('a device can offer check-in from a phone', r.status === 200, String(r.status));
  const links = (await req('GET', `/api/admin/devices/${device.id}/links`)).data;
  ok('…and is given a link to print', !!links.self && /\/go\/[a-f0-9]{32}$/.test(links.self), links.self);
  ok('…which is not the tablet’s own address', links.self !== links.kiosk);
  const code = links.self.split('/').pop();

  /* ---- switched off for the site, the link does nothing ---- */
  await req('PUT', '/api/admin/settings', { kiosk: { self_checkin_enabled: false } });
  r = await signIn({ host_id: host.id, self_code: code, location: NEAR });
  ok('with phone check-in off for the site, the link is refused',
    r.status === 403 && r.data.error === 'self_checkin_off', JSON.stringify(r.data));

  await req('PUT', '/api/admin/settings', { kiosk: { self_checkin_enabled: true } });

  /* ---- a made-up code is not a code ---- */
  r = await signIn({ host_id: host.id, self_code: 'f'.repeat(32), location: NEAR });
  ok('a code nobody issued is refused', r.status === 403 && r.data.error === 'self_checkin_closed',
    JSON.stringify(r.data));

  /* ---- with no fence set, a phone check-in just works ---- */
  await req('PUT', '/api/admin/settings', { geofence: { enabled: false } });
  r = track(await signIn({ host_id: host.id, self_code: code, location: null }));
  ok('with no site location set, a phone check-in is not blocked',
    r.status === 200 && !!r.data.visit, JSON.stringify(r.data).slice(0, 110));

  /* ---- with a fence, near passes and far does not ---- */
  await req('PUT', '/api/admin/settings', {
    geofence: { enabled: true, lat: SITE.lat, lng: SITE.lng, radius_m: 250, require_location: true }
  });

  r = track(await signIn({ host_id: host.id, self_code: code, location: NEAR }));
  ok('somebody standing on the site can check in from their phone',
    r.status === 200 && !!r.data.visit, JSON.stringify(r.data).slice(0, 110));

  r = await signIn({ host_id: host.id, self_code: code, location: FAR });
  ok('somebody across town cannot', r.status === 403 && r.data.error === 'geofence_too_far',
    JSON.stringify(r.data).slice(0, 120));
  ok('…and is told roughly how far off they are, not just refused',
    /\d/.test(r.data.message || ''), r.data.message);

  r = await signIn({ host_id: host.id, self_code: code, location: null });
  ok('a phone that will not say where it is is refused when the site insists',
    r.status === 403 && r.data.error === 'geofence_no_location', JSON.stringify(r.data).slice(0, 110));

  await req('PUT', '/api/admin/settings', { geofence: { require_location: false } });
  r = track(await signIn({ host_id: host.id, self_code: code, location: null }));
  ok('…and let through when the site would rather not turn real visitors away',
    r.status === 200 && !!r.data.visit, JSON.stringify(r.data).slice(0, 110));

  /* ---- a poor fix is forgiven rather than punished ---- */
  await req('PUT', '/api/admin/settings', { geofence: { require_location: true } });
  r = track(await signIn({
    host_id: host.id, self_code: code,
    // 400m away, but the phone admits it could be 500m out — which indoors is
    // an ordinary fix, not a lie.
    location: { lat: 37.77852, lng: -122.4194, accuracy: 500 }
  }));
  ok('a phone that admits it might be far out is given the benefit of the doubt',
    r.status === 200, JSON.stringify(r.data).slice(0, 110));

  /* ---- the tablet at the gate is never asked ---- */
  r = track(await signIn({ host_id: host.id }));
  ok('a sign-in from the tablet is not geofenced — it is bolted to the gate',
    r.status === 200 && !!r.data.visit, JSON.stringify(r.data).slice(0, 110));

  /* ---- and the fence is not readable from outside ---- */
  const config = await fetch(`${BASE}/api/kiosk/config`).then((x) => x.json());
  ok('the kiosk config says a fence exists', config.geofence && config.geofence.enabled === true,
    JSON.stringify(config.geofence));
  ok('…without publishing where the site is',
    config.geofence.lat === undefined && config.geofence.lng === undefined,
    JSON.stringify(config.geofence));
  ok('…and carries no backup or notification settings at all',
    !('backup' in config) && !('notify' in config), Object.keys(config).join(','));

  /*
   * ---- the page a scanned sign actually opens ----
   *
   * From a real report: the sign worked, the phone opened the link, and the
   * visitor got a blank white page. The same index.html is served at three
   * addresses — /kiosk/, /kiosk/<device>/ and /go/<code> — and a relative
   * `href="kiosk.css"` resolves against whichever one it was opened at, so
   * under /go/ the browser asked for /go/kiosk.css, got the fallback HTML
   * back, and quietly rendered nothing.
   *
   * Checked by fetching what the page asks for rather than by driving a
   * browser: a stylesheet that answers with HTML is the whole bug, and it says
   * so without needing a screen.
   */
  const pageUrl = `${BASE}/go/${code}`;
  const html = await fetch(pageUrl).then((x) => x.text());
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])
    .filter((u) => /\.(css|js)$/.test(u));
  ok('the phone page asks for a stylesheet and its scripts', refs.length >= 3, refs.join(' '));

  const wrong = [];
  for (const ref of refs) {
    const res = await fetch(new URL(ref, pageUrl).href);
    const type = res.headers.get('content-type') || '';
    const want = ref.endsWith('.css') ? 'css' : 'javascript';
    if (!res.ok || !type.includes(want)) wrong.push(`${ref} → ${res.status} ${type.split(';')[0]}`);
  }
  ok('…and every one of them is actually served from that address', wrong.length === 0,
    wrong.join(' | '));

  /*
   * ---- asked before the first question, not after the last ----
   *
   * From a real report: somebody filled in their details on their phone, took
   * a photograph, read the site rules, signed them, sat through the induction,
   * and was only then told they were off site. The refusal was right and the
   * moment was useless.
   *
   * The precheck exists to ask the same question at the top of the flow, and
   * what matters is that it gives the *same* answer — a gate that waves people
   * through and then refuses them at submit is worse than no gate at all.
   */
  const precheck = (body) => req('POST', '/api/kiosk/precheck', body);

  let pre = await precheck({ self_code: code, location: NEAR });
  ok('a phone on site is told it may start', pre.status === 200 && pre.data.ok === true,
    JSON.stringify(pre.data));

  pre = await precheck({ self_code: code, location: FAR });
  const far = await signIn({ host_id: host.id, self_code: code, location: FAR });
  ok('a phone across town is refused before it is asked anything',
    pre.status === 403 && pre.data.error === 'geofence_too_far', JSON.stringify(pre.data));
  ok('…with exactly what the sign-in would have said at the end',
    pre.data.error === far.data.error && pre.data.message === far.data.message,
    `${pre.data.error} vs ${far.data.error}`);

  pre = await precheck({ self_code: code, location: null });
  ok('a phone that will not say where it is is refused up front too',
    pre.status === 403 && pre.data.error === 'geofence_no_location', JSON.stringify(pre.data));

  pre = await precheck({ self_code: 'nothinglikeacode', location: NEAR });
  ok('a withdrawn sign is refused before anything is typed',
    pre.status === 403 && pre.data.error === 'self_checkin_closed', JSON.stringify(pre.data));

  pre = await precheck({});
  ok('a tablet at the gate has nothing to prove and is not asked',
    pre.status === 200 && pre.data.ok === true, JSON.stringify(pre.data));

  /*
   * Nothing is written. A question asked before every sign-in must not leave
   * anything behind, or a phone opened and abandoned at a gate becomes a visit
   * nobody made.
   */
  const onsiteBefore = (await req('GET', '/api/admin/dashboard')).data.stats.onsite;
  await precheck({ self_code: code, location: NEAR });
  ok('…and asking creates nothing',
    (await req('GET', '/api/admin/dashboard')).data.stats.onsite === onsiteBefore);

  /*
   * ---- a fence switched on before the site was placed ----
   *
   * Zero is a real coordinate — a point in the Gulf of Guinea — and it is also
   * what an empty number box turned into on its way through the settings form.
   * So ticking "refuse phone check-ins from away from the site" without
   * filling in the coordinates built a fence off the coast of Ghana and
   * refused every visitor on earth for standing nine thousand kilometres away,
   * with nothing on screen to say why.
   *
   * A fence with nowhere to be is no fence: check-ins go through, and the
   * empty boxes on the settings page are the thing that says so.
   */
  await req('PUT', '/api/admin/settings',
    { geofence: { enabled: true, lat: 0, lng: 0, radius_m: 250, require_location: true } });
  r = await signIn({ host_id: host.id, self_code: code, location: NEAR });
  ok('a fence enabled before the site is placed lets people in rather than refusing everyone',
    r.status === 200, JSON.stringify(r.data).slice(0, 120));
  if (r.data && r.data.visit) made.push(r.data.visit.id);

  const unplaced = await fetch(`${BASE}/api/kiosk/config`).then((x) => x.json());
  ok('…and the kiosk is told there is no fence, rather than one it cannot see',
    unplaced.geofence.enabled === false, JSON.stringify(unplaced.geofence));

  // Put the real fence back for the checks that follow.
  await req('PUT', '/api/admin/settings',
    { geofence: { enabled: true, lat: SITE.lat, lng: SITE.lng, radius_m: 250, require_location: true } });

  /* ---- reissuing stops every sign already printed ---- */
  const fresh = (await req('POST', `/api/admin/devices/${device.id}/self-code`)).data;
  ok('a new link can be issued', !!fresh.code && fresh.code !== code, fresh.code);
  r = await signIn({ host_id: host.id, self_code: code, location: NEAR });
  ok('…and the old one stops working at once',
    r.status === 403 && r.data.error === 'self_checkin_closed', JSON.stringify(r.data));

  /* ---- turning it off on the device does the same ---- */
  await req('PATCH', `/api/admin/devices/${device.id}`, { self_checkin: false });
  r = await signIn({ host_id: host.id, self_code: fresh.code, location: NEAR });
  ok('switching it off on the device closes its link too',
    r.status === 403 && r.data.error === 'self_checkin_closed', JSON.stringify(r.data));

  /* ---- put the site back ---- */
  for (const id of made) await req('DELETE', `/api/admin/visits/${id}`);
  await req('DELETE', `/api/admin/devices/${device.id}`);
  await req('PUT', '/api/admin/settings', { kiosk: BEFORE.kiosk, geofence: BEFORE.geofence || { enabled: false } });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
