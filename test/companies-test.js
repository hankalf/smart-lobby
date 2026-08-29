/* Companies as records: one firm, one spelling, corrected everywhere at once. */
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
const signin = (name, company, extra = {}) => req('POST', '/api/kiosk/signin', {
  full_name: name, company, phone: `415268${String(Math.floor(Math.random() * 9000) + 1000)}`,
  visit_type: 'visitor', client_ref: `co-${Date.now()}-${Math.random()}`, ...extra
});
const byName = (list, name) => (list || []).find((c) => c.name === name);

(async () => {
  await req('POST', '/api/admin/login', { email: 'hankalfr@gmail.com', password: 'Testing123!' });
  const DETAILS_BEFORE = (await req('GET', '/api/admin/settings')).data.details;
  await req('PUT', '/api/admin/settings', {
    details: { visitor: { photo: 'off', company: 'required', phone: 'required', staff: 'off', purpose: 'off' } }
  });

  /* ---- the same firm typed three ways is one company ---- */
  await signin('John Doe 30', 'Vacuums Ltd');
  await signin('John Doe 31', 'vacuums ltd');
  await signin('John Doe 32', '  Vacuums Ltd  ');
  let list = (await req('GET', '/api/admin/companies')).data.companies;
  const vac = list.filter((c) => /vacuums ltd/i.test(c.name));
  ok('capitals and stray spaces do not make a new company', vac.length === 1,
    JSON.stringify(vac.map((c) => c.name)));
  ok('…and everybody who typed it is on it', vac[0].people === 3, String(vac[0].people));
  ok('…with their visits counted against it', vac[0].visits === 3, String(vac[0].visits));

  /* ---- the printed name is normalised to the record ---- */
  const visitors = (await req('GET', '/api/admin/visitors?q=John Doe 3')).data;
  const typedLower = visitors.find((v) => v.full_name === 'John Doe 31');
  ok('somebody who typed it in lower case is shown the company\'s own spelling',
    typedLower && typedLower.company === 'Vacuums Ltd', String(typedLower && typedLower.company));

  /* ---- correcting a misspelling, which is the whole point ---- */
  await signin('John Doe 33', 'Vaccums');
  list = (await req('GET', '/api/admin/companies')).data.companies;
  const wrong = byName(list, 'Vaccums');
  ok('a misspelling starts as its own company', !!wrong, JSON.stringify(list.map((c) => c.name)));

  let r = await req('PATCH', `/api/admin/companies/${wrong.id}`, { name: 'Vacuum Services' });
  ok('it can be renamed', r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);
  const renamedPeople = (await req('GET', '/api/admin/visitors?q=John Doe 33')).data;
  ok('…and the correction reaches the visit already recorded',
    renamedPeople[0] && renamedPeople[0].company === 'Vacuum Services',
    String(renamedPeople[0] && renamedPeople[0].company));

  r = await req('PATCH', `/api/admin/companies/${wrong.id}`, { name: 'Vacuums Ltd' });
  ok('renaming onto a name that already exists is refused, not silently merged',
    r.status === 400 && /merge/i.test(r.data.message || ''), `${r.status} ${JSON.stringify(r.data)}`);
  r = await req('PATCH', `/api/admin/companies/${wrong.id}`, { name: '   ' });
  ok('…and a company cannot be left with no name at all', r.status === 400, String(r.status));

  /* ---- merging two that are the same firm ---- */
  list = (await req('GET', '/api/admin/companies')).data.companies;
  const keep = byName(list, 'Vacuums Ltd');
  const fold = byName(list, 'Vacuum Services');
  r = await req('POST', `/api/admin/companies/${fold.id}/merge`, { into: keep.id });
  ok('two companies can be merged', r.status === 200 && r.data.ok, JSON.stringify(r.data));
  ok('…moving everybody across', r.data.moved === 1, String(r.data.moved));

  list = (await req('GET', '/api/admin/companies')).data.companies;
  ok('the one folded in is gone', !byName(list, 'Vacuum Services'), JSON.stringify(list.map((c) => c.name)));
  ok('…and the survivor has everybody', byName(list, 'Vacuums Ltd').people === 4,
    String(byName(list, 'Vacuums Ltd').people));
  const moved = (await req('GET', '/api/admin/visitors?q=John Doe 33')).data;
  ok('…and their visits now read the surviving name',
    moved[0] && moved[0].company === 'Vacuums Ltd', String(moved[0] && moved[0].company));

  r = await req('POST', `/api/admin/companies/${keep.id}/merge`, { into: keep.id });
  ok('a company cannot be merged into itself', r.status === 400, `${r.status} ${JSON.stringify(r.data)}`);

  /* ---- a barred company turns its people away ---- */
  await req('PATCH', `/api/admin/companies/${keep.id}`, { blocked: true });
  r = await signin('John Doe 34', 'Vacuums Ltd');
  ok('barring a company turns away somebody new from it',
    r.status === 403 && r.data.error === 'blocked', `${r.status} ${JSON.stringify(r.data)}`);
  ok('…without saying why, which is reception\'s to explain',
    /see reception/i.test(r.data.message || ''), JSON.stringify(r.data));
  r = await signin('John Doe 35', 'Someone Else Ltd');
  ok('…and nobody else is caught by it', r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);
  await req('PATCH', `/api/admin/companies/${keep.id}`, { blocked: false });

  /* ---- what a near-miss looks like ---- */
  await signin('John Doe 36', 'Acme Roofing');
  await signin('John Doe 37', 'Acme Roofing Ltd');
  await signin('John Doe 38', 'Acme Roofng');
  const dupes = (await req('GET', '/api/admin/companies')).data.possible_duplicates;
  const names = dupes.map((d) => `${d.a.name}|${d.b.name}`);
  ok('a suffix like Ltd is not what makes two firms different',
    names.some((n) => /Acme Roofing\|Acme Roofing Ltd|Acme Roofing Ltd\|Acme Roofing/.test(n)), names.join(', '));
  ok('…and neither is one dropped letter',
    names.some((n) => /Roofng/.test(n)), names.join(', '));
  ok('two genuinely different firms are not offered as duplicates',
    !names.some((n) => /Someone Else/.test(n)), names.join(', '));

  /* ---- removing one keeps its people ---- */
  list = (await req('GET', '/api/admin/companies')).data.companies;
  const doomed = byName(list, 'Someone Else Ltd');
  await req('DELETE', `/api/admin/companies/${doomed.id}`);
  const orphan = (await req('GET', '/api/admin/visitors?q=John Doe 35')).data;
  ok('removing a company does not remove its people', orphan.length === 1, String(orphan.length));
  ok('…and their visits are still there',
    (await req('GET', '/api/admin/visits?q=John Doe 35')).data.length >= 1);

  /* ---- reception can read it, a clerk cannot ---- */
  ok('a company with no name is refused',
    (await req('POST', '/api/admin/companies', { name: '  ' })).status === 400);

  // Put the form back as it was: these settings are shared, and a later suite
  // filling in a field this one switched off is not that suite's fault.
  await req('PUT', '/api/admin/settings', { details: DETAILS_BEFORE });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
