/* Badge numbers: the shape is a site's own business, and must not collide. */
'use strict';
const badges = require('../server/badges');
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

const DAY = '2026-08-29';
const base = { badge_prefix: 'V', badge_format: badges.DEFAULT_FORMAT, badge_seq_digits: 3 };
const sample = (over, seq = 1, type = 'contractor') =>
  badges.sampleBadgeNo(DAY, type, { ...base, ...over }, seq);

(async () => {
  /* ---- the shape, without a server ---- */
  ok('the default is exactly what was printed before this was a setting',
    sample({}, 7) === 'V260829-007', sample({}, 7));

  ok('a plain running number', sample({ badge_format: '{seq}', badge_seq_digits: 5 }, 42) === '00042',
    sample({ badge_format: '{seq}', badge_seq_digits: 5 }, 42));
  ok('the full year reads the right way round',
    sample({ badge_format: '{yyyy}{mm}{dd}-{seq}' }, 1) === '20260829-001',
    sample({ badge_format: '{yyyy}{mm}{dd}-{seq}' }, 1));
  ok('a visitor type letter', sample({ badge_format: '{type}{seq}' }, 4) === 'C004',
    sample({ badge_format: '{type}{seq}' }, 4));
  ok('…and in full', sample({ badge_format: '{TYPE}-{seq}' }, 4) === 'CONTRACTOR-004',
    sample({ badge_format: '{TYPE}-{seq}' }, 4));
  ok('text after the counter is kept', sample({ badge_format: '{prefix}{seq}/{yyyy}' }, 9) === 'V009/2026',
    sample({ badge_format: '{prefix}{seq}/{yyyy}' }, 9));

  /*
   * The one that would hand every visitor on site the same number. A format
   * with no counter gets one rather than being allowed through.
   */
  ok('a format with no counter still gets one', /\d/.test(sample({ badge_format: 'BADGE-' }, 4)),
    sample({ badge_format: 'BADGE-' }, 4));
  ok('…on the end of what was typed', sample({ badge_format: 'BADGE-' }, 4) === 'BADGE-004',
    sample({ badge_format: 'BADGE-' }, 4));
  ok('a second counter is not filled in twice',
    (sample({ badge_format: '{seq}-{seq}' }, 4).match(/004/g) || []).length === 1,
    sample({ badge_format: '{seq}-{seq}' }, 4));

  ok('an absurd counter width is clamped to something printable',
    sample({ badge_seq_digits: 99 }, 1) === 'V260829-00000001', sample({ badge_seq_digits: 99 }, 1));
  ok('a width of one is honoured', sample({ badge_seq_digits: 1 }, 7) === 'V260829-7',
    sample({ badge_seq_digits: 1 }, 7));
  ok('an empty or nonsense width falls back rather than printing nothing',
    sample({ badge_seq_digits: '' }, 1) === 'V260829-001' && sample({ badge_seq_digits: 'x' }, 1) === 'V260829-001',
    `${sample({ badge_seq_digits: '' }, 1)} / ${sample({ badge_seq_digits: 'x' }, 1)}`);
  ok('an unknown token is left alone rather than silently dropped',
    sample({ badge_format: '{nonsense}{seq}' }, 1) === '{nonsense}001',
    sample({ badge_format: '{nonsense}{seq}' }, 1));

  /* ---- a prefix per visitor type ---- */
  const perType = { badge_prefixes: { contractor: 'CON', driver: 'DRV' } };
  ok('a type with its own prefix uses it',
    sample(perType, 1, 'contractor') === 'CON260829-001', sample(perType, 1, 'contractor'));
  ok('…and one without falls back to the general prefix',
    sample(perType, 1, 'interview') === 'V260829-001', sample(perType, 1, 'interview'));
  ok('an empty per-type prefix means the general one, not no prefix at all',
    sample({ badge_prefixes: { visitor: '   ' } }, 1, 'visitor') === 'V260829-001',
    sample({ badge_prefixes: { visitor: '   ' } }, 1, 'visitor'));
  ok('a per-type prefix gives that type its own run of numbers',
    badges.renderFormat(DAY, 'contractor', { ...base, ...perType }).prefix
      !== badges.renderFormat(DAY, 'interview', { ...base, ...perType }).prefix);
  ok('the general prefix still applies with no per-type list at all',
    badges.prefixFor('contractor', base) === 'V', badges.prefixFor('contractor', base));

  /* ---- a format that separates the types gives each its own prefix ---- */
  const shared = badges.renderFormat(DAY, 'contractor', base).prefix
    === badges.renderFormat(DAY, 'visitor', base).prefix;
  ok('the default puts every type on one run of numbers', shared);
  const split = { ...base, badge_format: '{type}{yy}{mm}{dd}-{seq}' };
  ok('…and {type} gives each its own',
    badges.renderFormat(DAY, 'contractor', split).prefix !== badges.renderFormat(DAY, 'visitor', split).prefix);

  /* ---- against a running server ---- */
  await req('POST', '/api/admin/login', { email: 'hankalfr@gmail.com', password: 'Testing123!' });
  await req('PUT', '/api/admin/settings', {
    badge: { enabled: true, ...base },
    // Nothing but a name and a phone, so a sign-in here is testing badge
    // numbering rather than the form rules.
    details: { visitor: { photo: 'off', company: 'off', phone: 'required', staff: 'off', purpose: 'off' } }
  });

  let r = await req('GET', '/api/admin/badges/number-preview');
  ok('the dashboard is told what tokens there are', (r.data.tokens || []).some((t) => t.id === 'seq'),
    JSON.stringify(r.data.tokens));
  ok('…and shown the first few numbers of the day',
    r.data.examples[0].numbers.length === 3 && /001$/.test(r.data.examples[0].numbers[0]),
    JSON.stringify(r.data.examples[0]));
  ok('…and told the types share one run', r.data.separate_series === false);

  r = await req('GET', '/api/admin/badges/number-preview?format=' + encodeURIComponent('{type}-{seq}'));
  ok('the preview follows the format on screen, not the saved one',
    /^[A-Z]-001$/.test(r.data.examples[0].numbers[0]), JSON.stringify(r.data.examples[0]));
  ok('…and says each type now counts separately', r.data.separate_series === true);

  r = await req('POST', '/api/admin/badges/number-preview', { prefixes: { contractor: 'CON' } });
  const contractorRow = r.data.examples.find((e) => e.type === 'contractor');
  ok('the preview takes a prefix per type', contractorRow && /^CON/.test(contractorRow.numbers[0]),
    JSON.stringify(contractorRow));
  ok('…leaving the others on the general prefix',
    r.data.examples.filter((e) => e.type !== 'contractor').every((e) => /^V/.test(e.numbers[0])),
    JSON.stringify(r.data.examples.map((e) => e.numbers[0])));
  ok('…and noticing that they now count separately', r.data.separate_series === true);
  ok('each row carries the type name for the dashboard to label it with',
    r.data.examples.every((e) => typeof e.label === 'string' && e.label.length),
    JSON.stringify(r.data.examples.map((e) => e.label)));

  /* ---- and a real sign-in honours it ---- */
  await req('PUT', '/api/admin/settings', { badge: { badge_prefixes: { visitor: 'VIS' } } });
  const prefixed = await req('POST', '/api/kiosk/signin', {
    full_name: 'Hank Alfred 91', company: 'Badge Co', phone: '415-268-0991',
    visit_type: 'visitor', client_ref: `badge-prefix-${Date.now()}`
  });
  ok('a badge printed for that type carries its own prefix',
    /^VIS\d{6}-001$/.test(prefixed.data.badge.badge_no), prefixed.data.badge.badge_no);
  ok('…starting its own run at 1, not continuing the general one',
    prefixed.data.badge.badge_no.endsWith('-001'), prefixed.data.badge.badge_no);

  // Cleared with an empty string, because settings merge key by key: leaving
  // it out would keep the old prefix and clearing it would appear to do nothing.
  await req('PUT', '/api/admin/settings', { badge: { badge_prefixes: { visitor: '' } } });
  const cleared = await req('POST', '/api/kiosk/signin', {
    full_name: 'Hank Alfred 92', company: 'Badge Co', phone: '415-268-0992',
    visit_type: 'visitor', client_ref: `badge-clear-${Date.now()}`
  });
  ok('clearing a per-type prefix really clears it',
    /^V\d{6}-/.test(cleared.data.badge.badge_no), cleared.data.badge.badge_no);

  /* ---- real sign-ins, which is where a collision would actually hurt ---- */
  const issued = [];
  for (let i = 0; i < 4; i++) {
    const s = await req('POST', '/api/kiosk/signin', {
      full_name: `Hank Alfred 8${i}`, company: 'Badge Co', phone: `415-268-09${10 + i}`,
      visit_type: 'visitor', client_ref: `badge-${Date.now()}-${i}`
    });
    if (s.data && s.data.badge) issued.push(s.data.badge.badge_no);
  }
  ok('every sign-in gets a badge number', issued.length === 4,
    `${issued.length} of 4: ${JSON.stringify(issued)}`);
  if (issued.length !== 4) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }
  ok('…and no two are the same', new Set(issued).size === issued.length, issued.join(','));
  ok('…counting up rather than repeating', issued.every((n) => /^V\d{6}-\d{3}$/.test(n)), issued.join(','));

  /*
   * The reason the counter is read back from the badges already issued rather
   * than from a count of visits: deleting one must not hand the next arrival
   * a number somebody on site is already wearing.
   */
  const visits = (await req('GET', '/api/admin/visits?limit=5')).data;
  const newest = (visits.rows || visits || [])[0];
  await req('DELETE', `/api/admin/visits/${newest.id}`);
  const after = await req('POST', '/api/kiosk/signin', {
    full_name: 'Hank Alfred 89', company: 'Badge Co', phone: '415-268-0999',
    visit_type: 'visitor', client_ref: `badge-after-${Date.now()}`
  });
  const next = after.data && after.data.badge && after.data.badge.badge_no;
  ok('deleting a visit does not reissue a number somebody is wearing',
    !issued.slice(0, -1).includes(next), `${next} against ${issued.join(',')}`);

  /* ---- a changed format keeps counting under its own shape ---- */
  await req('PUT', '/api/admin/settings', { badge: { badge_format: 'SITE-{seq}', badge_seq_digits: 4 } });
  const reshaped = await req('POST', '/api/kiosk/signin', {
    full_name: 'Hank Alfred 90', company: 'Badge Co', phone: '415-268-0998',
    visit_type: 'visitor', client_ref: `badge-shape-${Date.now()}`
  });
  ok('a changed format takes effect on the next badge',
    /^SITE-\d{4}$/.test(reshaped.data.badge.badge_no), reshaped.data.badge.badge_no);

  await req('PUT', '/api/admin/settings', { badge: { ...base, badge_prefixes: {} } });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
