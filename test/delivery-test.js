/* Parcels: booking one in, what is required, and collecting it. */
'use strict';
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
  return { status: res.status, data: await res.json().catch(() => null) };
}
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

(async () => {
  await req('POST', '/api/admin/login', { email: 'hankalfr@gmail.com', password: 'Testing123!' });
  const staff = (await req('POST', '/api/admin/staff', {
    name: 'John Doe 70', email: 'parcels@x.test', active: 1 })).data;
  ok('somebody for a parcel to be for', !!staff.id);

  const settings = (over) => req('PUT', '/api/admin/settings', { deliveries: over });
  const book = (over = {}) => req('POST', '/api/kiosk/delivery', {
    courier_name: 'John Doe', courier_company: 'UPS', recipient_host_id: staff.id,
    tracking: '1Z999AA1', parcel_count: 2, photo: PNG, ...over
  });

  /* ---- the settings are the rules, and they are actually applied ---- */
  await settings({ enabled: true, require_recipient: true, require_photo: true, notify_recipient: false });

  let r = await book();
  ok('a complete delivery is booked in', r.status === 200 && r.data.ok, JSON.stringify(r.data));
  const firstId = r.data.id;

  r = await book({ recipient_host_id: null, recipient_text: '' });
  ok('one with nobody to give it to is refused', r.status === 400 && r.data.error === 'recipient_required',
    `${r.status} ${JSON.stringify(r.data)}`);

  /*
   * The parcel photo is the evidence when somebody says theirs never arrived.
   * The setting has defaulted to on since deliveries were added and was never
   * checked anywhere, so a parcel could be booked in without one and the site
   * would find out only when it mattered.
   */
  r = await book({ photo: null });
  ok('one with no photo is refused when a photo is required',
    r.status === 400 && r.data.error === 'photo_required', `${r.status} ${JSON.stringify(r.data)}`);
  r = await book({ photo: 'not a photo' });
  ok('…and something that is not an image does not count as one',
    r.status === 400 && r.data.error === 'photo_required', `${r.status} ${JSON.stringify(r.data)}`);
  ok('…with a reason the courier can act on', /photo of the parcel/i.test((await book({ photo: null })).data.message || ''),
    JSON.stringify((await book({ photo: null })).data));

  await settings({ require_photo: false });
  r = await book({ photo: null });
  ok('switching the requirement off lets one through without a photo', r.status === 200, JSON.stringify(r.data));
  await settings({ require_photo: true });

  await settings({ require_recipient: false });
  r = await book({ recipient_host_id: null, recipient_text: '' });
  ok('and the same for the recipient', r.status === 200, JSON.stringify(r.data));
  await settings({ require_recipient: true });

  /* ---- switched off entirely ---- */
  await settings({ enabled: false });
  r = await book();
  ok('with deliveries off the kiosk cannot book one at all', r.status === 403, String(r.status));
  await settings({ enabled: true });

  /* ---- what reception sees ---- */
  const list = (await req('GET', '/api/admin/deliveries')).data;
  const rows = list.rows || list || [];
  ok('the parcel is waiting on the deliveries page', rows.some((d) => d.id === firstId), `${rows.length} rows`);
  const mine = rows.find((d) => d.id === firstId);
  ok('…with the courier on it', mine && mine.courier_name === 'John Doe', JSON.stringify(mine || {}).slice(0, 90));
  ok('…and how many parcels', mine && mine.parcel_count === 2, String(mine && mine.parcel_count));
  ok('…and its photo kept somewhere private',
    mine && String(mine.photo_path || '').includes('/private/'), String(mine && mine.photo_path));

  /* ---- and that photo is not readable by a passer-by ---- */
  const anon = await fetch(BASE + (mine.photo_path || '/media/private/none'));
  ok('a parcel photo is not readable without a login', anon.status !== 200, String(anon.status));

  /* ---- collecting it ---- */
  r = await req('POST', `/api/admin/deliveries/${firstId}/collect`, {
    collected_by: 'John Doe', signature: PNG });
  ok('a parcel can be collected', r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);
  const after = ((await req('GET', '/api/admin/deliveries')).data.rows
    || (await req('GET', '/api/admin/deliveries')).data || []).find((d) => d.id === firstId);
  ok('…and stops being awaiting', after && after.status !== 'awaiting', String(after && after.status));
  ok('…recording who took it', after && /John Doe/.test(after.collected_by || ''), String(after && after.collected_by));

  /* ---- a parcel count that makes no sense ---- */
  for (const count of [-5, 0, 'many', null, 1e9]) await book({ parcel_count: count });
  const counted = (await req('GET', '/api/admin/deliveries')).data;
  const countRows = counted.rows || counted || [];
  ok('a nonsense parcel count never reaches the card as nonsense',
    countRows.every((d) => Number.isInteger(d.parcel_count) && d.parcel_count >= 1 && d.parcel_count <= 999),
    JSON.stringify(countRows.map((d) => d.parcel_count)));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
