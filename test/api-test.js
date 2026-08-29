/* Full API pass over a fresh Smart Lobby, mock data end to end. */
'use strict';
const BASE = process.env.BASE_URL || 'http://localhost:3401';
let cookie = '';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};

async function req(method, path, body, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + path, { method, headers: { ...headers, cookie }, body: payload });
  const setc = res.headers.get('set-cookie');
  if (setc) cookie = setc.split(';')[0];
  let data = null;
  try { data = await res.json(); } catch { /* non-json */ }
  return { status: res.status, data };
}
const get_ = (p) => req('GET', p);
const post = (p, b) => req('POST', p, b);
const patch = (p, b) => req('PATCH', p, b);
const del = (p) => req('DELETE', p);

// A tiny real PNG (1x1) for uploads/signature data URLs.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const SIG = `data:image/png;base64,${PNG_B64}`;

(async () => {
  /* ---- setup + login ---- */
  let r = await post('/api/admin/setup', { name: 'Hank', email: 'hankalfr@gmail.com', password: 'Testing123!' });
  ok('first-run setup creates admin', r.status === 200);
  r = await get_('/api/admin/me');
  ok('session cookie works', r.status === 200 && r.data && r.data.email);

  /* ---- settings: enable contractor card, spanish, signature doc ---- */
  r = await get_('/api/admin/settings');
  const settings = r.data;
  ok('settings load', r.status === 200 && settings.kiosk);
  settings.kiosk.spanish_enabled = true;
  // The Visitor Types list is what puts cards on the home screen now.
  settings.types = settings.types.map((ty) => (ty.key === 'contractor' ? { ...ty, mode: 'both' } : ty));
  r = await req('PUT', '/api/admin/settings', { kiosk: settings.kiosk, types: settings.types });
  ok('settings save', r.status === 200);
  r = await get_('/api/kiosk/config');
  ok('contractor card is on for the kiosk', r.data.types.some((ty) => ty.key === 'contractor' && (ty.mode === 'card' || ty.mode === 'both')),
    JSON.stringify(r.data.types.map((t) => [t.key, t.mode])));

  /* ---- projects ---- */
  r = await post('/api/admin/projects', { name: 'Warehouse extension', name_es: 'Ampliación del almacén', code: 'WH-EXT' });
  const project = r.data;
  ok('project created', r.status === 200 && project.id);

  /* ---- devices: slug lifecycle ---- */
  r = await post('/api/admin/devices', { name: 'North Gate iPad' });
  const dev = r.data;
  ok('device gets slug from name', dev.slug === 'north-gate-ipad', JSON.stringify(dev.slug));
  r = await post('/api/admin/devices', { name: 'North Gate iPad' });
  const dev2 = r.data;
  ok('duplicate name gets unique slug', dev2.slug === 'north-gate-ipad-2', dev2.slug);
  r = await patch(`/api/admin/devices/${dev.id}`, { name: 'North Gate iPad (front)' });
  ok('rename leaves slug alone', r.data.slug === 'north-gate-ipad');
  r = await patch(`/api/admin/devices/${dev.id}`, { slug: 'front-gate', sections: JSON.stringify(['contractor', 'signout']) });
  ok('explicit slug change works', r.data.slug === 'front-gate', r.data.slug);
  await del(`/api/admin/devices/${dev2.id}`);

  /* ---- printers ---- */
  r = await post('/api/admin/printers', { name: 'Lobby QL-820', model: 'Brother QL-820NWB', label_type: 'DK-2205', foreground: 'black', port: 'wireless_direct', ip_address: '192.168.118.1' });
  ok('printer created (wireless direct)', r.status === 200 && r.data.id);

  /* ---- deck with signature required ---- */
  r = await post('/api/admin/slideshows', { name: 'Site induction', required_for: ['contractor', 'visitor'], min_seconds_per_slide: 0, language: 'en', require_signature: true });
  const deck = r.data;
  ok('deck created with require_signature', deck.require_signature === 1, JSON.stringify(deck.require_signature));
  r = await patch(`/api/admin/slideshows/${deck.id}`, { require_signature: false });
  ok('deck signature can be turned off', r.data.require_signature === 0);
  r = await patch(`/api/admin/slideshows/${deck.id}`, { require_signature: true });
  ok('…and back on', r.data.require_signature === 1);

  // slides via upload (png)
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from(PNG_B64, 'base64')], { type: 'image/png' }), 'slide1.png');
  r = await req('POST', `/api/admin/slideshows/${deck.id}/upload`, fd);
  ok('slide uploaded', r.status === 200, JSON.stringify(r.data));

  /* ---- agreement already seeded; make sure it needs signature ---- */
  r = await get_('/api/admin/agreements');
  const agreement = r.data.rows ? r.data.rows[0] : r.data[0];
  ok('seed agreement exists', !!agreement);

  /* ---- kiosk config ---- */
  r = await get_('/api/kiosk/config');
  const cfg = r.data;
  ok('kiosk config has projects', Array.isArray(cfg.projects) && cfg.projects.length === 1);
  ok('config decks carry require_signature', cfg.decks.length === 1 && cfg.decks[0].require_signature === 1,
    JSON.stringify(cfg.decks.map((d) => d.require_signature)));

  /* ---- kiosk ping: slug, token, unknown ---- */
  r = await post('/api/kiosk/ping', { slug: 'front-gate' });
  ok('ping by slug resolves device', r.data.device_id === dev.id && JSON.stringify(r.data.sections) === JSON.stringify(['contractor', 'signout']));
  r = await post('/api/kiosk/ping', { token: dev.token });
  ok('ping by legacy token still works', r.data.device_id === dev.id && r.data.slug === 'front-gate');
  r = await post('/api/kiosk/ping', { slug: 'gone' });
  ok('unknown slug flagged, not silent', r.data.device_id === null && r.data.unknown === true);
  r = await post('/api/kiosk/ping', {});
  ok('bare kiosk not flagged', r.data.device_id === null && r.data.unknown === false);

  /* ---- induction status offers deck with require_signature ---- */
  r = await post('/api/kiosk/induction', { visit_type: 'contractor', language: 'en' });
  ok('induction offered to contractor', r.data.required === true && r.data.slideshow && r.data.slideshow.slides.length === 1);
  ok('induction deck says signature needed', r.data.slideshow.require_signature === 1, JSON.stringify(r.data.slideshow && r.data.slideshow.require_signature));

  /* ---- contractor sign-in with induction signature ---- */
  r = await post('/api/kiosk/signin', {
    full_name: 'Carlos Vega', company: 'Vega Electrical', phone: '415-268-0101',
    visit_type: 'contractor', project_id: project.id, language: 'es',
    documents: [{ agreement_id: agreement.id, signature: SIG, answers: {} }],
    induction_completed: true, slideshow_id: deck.id, induction_signature: SIG,
    induction_started_at: new Date().toISOString(), induction_seconds: 42,
    device_id: dev.id, client_ref: 'test-ref-1'
  });
  const visit = r.data && r.data.visit;
  ok('contractor signs in', r.status === 200 && visit && visit.id && r.data.checkout_code, JSON.stringify(r.data).slice(0, 120));
  r = await post('/api/kiosk/signin', { full_name: 'Carlos Vega', company: 'Vega Electrical', phone: '415-268-0101', visit_type: 'contractor', project_id: project.id, client_ref: 'test-ref-1' });
  ok('client_ref dedupes retried sign-in', r.data.duplicate === true && r.data.visit.id === visit.id, JSON.stringify(r.data).slice(0, 120));

  /* ---- induction signature stored ---- */
  r = await get_(`/api/admin/visits/${visit.id}`);
  const ind = r.data.inductions && r.data.inductions[0];
  ok('induction record has signature_path', !!(ind && ind.signature_path), JSON.stringify(ind || null).slice(0, 160));
  if (ind && ind.signature_path) {
    const img = await fetch(BASE + ind.signature_path, { headers: { cookie } });
    ok('induction signature image serves (auth)', img.status === 200);
    const anon = await fetch(BASE + ind.signature_path);
    ok('…and is private without login', anon.status === 403);
  }

  /* ---- returning visitor skips induction ---- */
  r = await post('/api/kiosk/lookup', { phone: '415-268-0101' });
  ok('lookup finds Carlos', r.data.found === true && r.data.visitor.full_name === 'Carlos Vega');
  r = await post('/api/kiosk/induction', { visit_type: 'contractor', visitor_id: r.data.visitor.id, language: 'en' });
  ok('returning contractor skips induction', r.data.required === false, JSON.stringify(r.data).slice(0, 100));

  /* ---- shared phone asks who you are ---- */
  r = await post('/api/kiosk/signin', { full_name: 'Maria Vega', company: 'Vega Electrical', phone: '415-268-0101', visit_type: 'contractor', project_id: project.id, client_ref: 'test-ref-2' });
  ok('second person on shared phone signs in as new visitor', r.status === 200 && r.data.visit && r.data.visit.visitor_id !== visit.visitor_id, JSON.stringify(r.data).slice(0, 140));
  r = await post('/api/kiosk/lookup', { phone: '415-268-0101' });
  ok('shared phone returns choice list', r.data.multiple === true && r.data.matches.length === 2, JSON.stringify(r.data).slice(0, 140));

  /* ---- sign-out ---- */
  r = await post('/api/kiosk/signout/search', { q: 'Carlos' });
  const target = Array.isArray(r.data) ? r.data[0] : null;
  ok('sign-out search finds him', !!target, JSON.stringify(r.data).slice(0, 120));
  if (target) {
    r = await post('/api/kiosk/signout', { visit_id: target.id });
    ok('sign-out works', r.status === 200);
  }

  /* ---- deck without signature: config reflects it ---- */
  await patch(`/api/admin/slideshows/${deck.id}`, { require_signature: false });
  r = await get_('/api/kiosk/config');
  ok('toggle reaches kiosk config', r.data.decks[0].require_signature === 0);

  /* ---- per-device pages ---- */
  for (const [path, want] of [['/kiosk/front-gate', 200], ['/kiosk/front-gate/manifest.webmanifest', 200], ['/kiosk/gone/manifest.webmanifest', 404]]) {
    const res = await fetch(BASE + path, { redirect: 'manual' });
    ok(`GET ${path} -> ${want}`, res.status === want, String(res.status));
  }
  const mf = await (await fetch(BASE + '/kiosk/front-gate/manifest.webmanifest')).json();
  ok('manifest start_url is device page', mf.start_url === '/kiosk/front-gate', mf.start_url);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
