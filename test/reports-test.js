/* Reports over a window somebody chooses, and hours per project. */
'use strict';
const BASE = process.env.BASE_URL || 'http://localhost:3401';
const localtime = require('../server/localtime');
let cookie = '';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n}${x ? ' — ' + x : ''}`); } };
async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie },
    body: body ? JSON.stringify(body) : undefined
  });
  const setc = res.headers.get('set-cookie'); if (setc) cookie = setc.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => null), text: null };
}
const day = (offset) => {
  const base = Date.parse(`${localtime.today()}T12:00:00Z`);
  return new Date(base + offset * 864e5).toISOString().slice(0, 10);
};
const at = (offset, hour) => `${day(offset)}T${String(hour).padStart(2, '0')}:00:00.000Z`;
const stats = (q = '') => req('GET', `/api/admin/stats${q ? `?${q}` : ''}`).then((r) => r.data);

(async () => {
  await req('POST', '/api/admin/login', { email: 'owner@example.test', password: 'Testing123!' });

  /* ---- two projects with known hours on them ---- */
  const alpha = (await req('POST', '/api/admin/projects', { name: 'Report Alpha', code: 'RA', active: 1 })).data;
  const beta = (await req('POST', '/api/admin/projects', { name: 'Report Beta', code: 'RB', active: 1 })).data;
  ok('two projects to report on', !!(alpha.id && beta.id));

  const DETAILS_BEFORE = (await req('GET', '/api/admin/settings')).data.details;
  await req('PUT', '/api/admin/settings', {
    // The project has to be asked for, or the kiosk does not record one — and
    // hours per project is exactly what this suite is about.
    details: { contractor: { photo: 'off', company: 'off', phone: 'required', staff: 'off', project: 'required' } }
  });

/*
 * Signed in through the kiosk like anybody else, then moved to a known day
 * and length by writing the two timestamps straight to the database.
 *
 * There is deliberately no admin route for editing when a visit happened —
 * that is a record of who was on site, not a field to nudge — so the fixture
 * is built here rather than by adding one for a test's convenience.
 */
  const db = require('../server/db');
  const place = async (projectId, dayOffset, hours) => {
    const r = await req('POST', '/api/kiosk/signin', {
      full_name: `Report Person ${Math.random().toString(36).slice(2, 8)}`,
      phone: `415268${String(Math.floor(Math.random() * 9000) + 1000)}`,
      visit_type: 'contractor', project_id: projectId, client_ref: `rep-${Date.now()}-${Math.random()}`
    });
    const id = r.data.visit.id;
    db.run('UPDATE visits SET signed_in_at = ?, signed_out_at = ?, status = ? WHERE id = ?',
      at(dayOffset, 8), hours == null ? null : at(dayOffset, 8 + hours),
      hours == null ? 'onsite' : 'out', id);
    return id;
  };

  await place(alpha.id, -1, 4);
  await place(alpha.id, -1, 2);
  await place(alpha.id, -40, 8);      // outside a 30-day window
  await place(beta.id, -2, 3);
  await place(beta.id, -2, null);     // still on site, so no hours yet

  /* ---- the window is honoured ---- */
  let s = await stats('days=30');
  const alphaRow = s.by_project.find((p) => p.name === 'Report Alpha');
  const betaRow = s.by_project.find((p) => p.name === 'Report Beta');
  ok('hours are reported per project', !!(alphaRow && betaRow), JSON.stringify(s.by_project));
  ok('…adding up the time between signing in and out', alphaRow.hours === 6,
    `${alphaRow.hours} hours over ${alphaRow.n} visits`);
  ok('…leaving out a visit from before the window', alphaRow.n === 2, String(alphaRow.n));
  ok('somebody still on site is counted as a visit', betaRow.n === 2, String(betaRow.n));
  ok('…but not yet as hours, because they have not finished', betaRow.hours === 3, String(betaRow.hours));
  ok('…and is named as still on site', betaRow.still_on_site === 1, String(betaRow.still_on_site));

  s = await stats('days=90');
  ok('widening the window brings the older visit back',
    s.by_project.find((p) => p.name === 'Report Alpha').hours === 14,
    JSON.stringify(s.by_project.find((p) => p.name === 'Report Alpha')));

  /* ---- two explicit dates ---- */
  s = await stats(`from=${day(-2)}&to=${day(-2)}`);
  ok('a single day can be asked for', s.days === 1 && s.from === s.to, `${s.from}..${s.to} (${s.days})`);
  ok('…and holds only that day\'s visits',
    !s.by_project.some((p) => p.name === 'Report Alpha'), JSON.stringify(s.by_project));
  ok('…while the day it does hold is there',
    !!s.by_project.find((p) => p.name === 'Report Beta'), JSON.stringify(s.by_project));

  /* ---- filtering to one project ---- */
  s = await stats(`days=90&project_id=${alpha.id}`);
  ok('one project can be singled out', s.by_project.length === 1 && s.by_project[0].name === 'Report Alpha',
    JSON.stringify(s.by_project));
  ok('…and the tiles follow it rather than describing everything',
    s.total === 3 && s.total_hours === 14, `${s.total} visits, ${s.total_hours} hours`);

  /* ---- and to one visitor type ---- */
  s = await stats('days=90&visit_type=contractor');
  ok('one visitor type can be singled out',
    s.by_type.length === 1 && s.by_type[0].visit_type === 'contractor', JSON.stringify(s.by_type));

  /* ---- the whole page describes one window ---- */
  s = await stats('days=30');
  const chartTotal = s.by_day.reduce((a, b) => a + b.n, 0);
  const typeTotal = s.by_type.reduce((a, b) => a + b.n, 0);
  const hourTotal = s.by_hour.reduce((a, b) => a + b.n, 0);
  ok('the chart, the type table and the hour table all count the same visits',
    chartTotal === s.total && typeTotal === s.total && hourTotal === s.total,
    `chart ${chartTotal}, types ${typeTotal}, hours ${hourTotal}, total ${s.total}`);

  /* ---- a company with three spellings is one row ---- */
  s = await stats('days=731');
  const names = s.by_company.map((c) => c.name);
  ok('companies are grouped on the record, so one firm is one row',
    new Set(names.map((n) => String(n).toLowerCase())).size === names.length, names.join(', '));

  /* ---- an export covering the same window ---- */
  const csv = await fetch(`${BASE}/api/admin/visits?format=csv&from=${day(-2)}&to=${day(-2)}&project_id=${beta.id}`,
    { headers: { cookie } });
  const body = await csv.text();
  const lines = body.trim().split('\n');
  ok('the export honours the window and the project', lines.length === 3, `${lines.length - 1} rows`);
  ok('…and is a spreadsheet, not a page', /text\/csv/.test(csv.headers.get('content-type') || ''),
    csv.headers.get('content-type'));

  /* ---- rubbish in ---- */
  s = await stats('days=99999');
  ok('an absurd window is clamped rather than read back', s.days <= 732, String(s.days));
  s = await stats('days=0');
  ok('…and so is a window of nothing', s.days >= 1, String(s.days));

  // Put the form back as it was: these settings are shared, and a later suite
  // filling in a field this one switched off is not that suite's fault.
  await req('PUT', '/api/admin/settings', { details: DETAILS_BEFORE });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
