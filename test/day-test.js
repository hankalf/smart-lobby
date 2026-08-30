/*
 * A whole day at a real gate: forty people through the kiosk.
 *
 * Every other suite tests one thing at a time with two or three records. This
 * one runs the day the site actually has — a crew in at seven, visitors and
 * interviews through the morning, drivers in and out, most of them signed out
 * by the evening and a few left on site — and then asks every part of the
 * system the same question from its own angle.
 *
 * The point is agreement. The dashboard, the roll call, the on-site board, the
 * reports, the paged list, the CSV export and the printed page are six
 * different queries over one set of facts, and on a busy day they have every
 * opportunity to disagree. A count that is right when there are three visits
 * and wrong when there are forty is the kind of thing nobody notices until an
 * evacuation.
 */
'use strict';
const BASE = process.env.BASE_URL || 'http://localhost:3401';
const localtime = require('../server/localtime');
let cookie = '';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n}${x ? ' — ' + x : ''}`); } };

async function req(method, p, body) {
  const res = await fetch(BASE + p, {
    method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie },
    body: body ? JSON.stringify(body) : undefined
  });
  const setc = res.headers.get('set-cookie'); if (setc) cookie = setc.split(';')[0];
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { /* csv or html */ }
  return { status: res.status, data, text, headers: res.headers };
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/*
 * A made-up but plausible day. Forty people, weighted the way a contractor
 * site actually is — mostly the crew, a handful of visitors, a couple of
 * interviews, deliveries in and out — with the hours they would really be on
 * site rather than everybody arriving at nine.
 */
const FIRST = ['Ana', 'Ben', 'Cara', 'Dev', 'Elin', 'Femi', 'Gus', 'Hana', 'Iris', 'Jonah',
  'Kai', 'Lena', 'Marek', 'Nadia', 'Omar', 'Pia', 'Quinn', 'Rosa', 'Sami', 'Tess'];
const LAST = ['Adeyemi', 'Barros', 'Chen', 'Duarte', 'Ellis', 'Fontaine', 'Grady', 'Haddad',
  'Ibrahim', 'Jensen', 'Kowalski', 'Lindqvist', 'Moreau', 'Novak', 'Okafor', 'Petrov',
  'Quintero', 'Rahman', 'Silva', 'Tanaka'];
const FIRMS = ['Vega Electrical', 'Ironbark Steel', 'Halden Plumbing', 'Kestrel Groundworks',
  'Marlow Scaffolding', 'Northgate Roofing'];

/** A deterministic shuffle-free spread, so a failure is reproducible. */
const person = (i) => `${FIRST[i % FIRST.length]} ${LAST[(i * 7 + 3) % LAST.length]}`;

function planDay() {
  const day = [];
  for (let i = 0; i < 40; i++) {
    // 22 contractors, 10 visitors, 4 interviews, 4 drivers.
    const type = i < 22 ? 'contractor' : i < 32 ? 'visitor' : i < 36 ? 'interview' : 'driver';
    const inHour = type === 'contractor' ? 7 + (i % 2)
      : type === 'driver' ? 9 + (i % 6)
        : 9 + (i % 8);
    // Roughly a fifth are still on site when the day is looked at.
    const stillHere = i % 5 === 0;
    const length = type === 'contractor' ? 8 : type === 'driver' ? 1 : 2;
    day.push({
      i,
      full_name: person(i),
      company: type === 'contractor' ? FIRMS[i % FIRMS.length] : (i % 3 ? 'Audit Partners' : 'Meridian Design'),
      phone: `4152${String(600000 + i * 7).slice(0, 6)}`,
      visit_type: type,
      in_hour: inHour,
      out_hour: stillHere ? null : Math.min(19, inHour + length),
      photo: i % 4 === 0,
      /*
       * A driver with no vehicle and no docket is not a delivery, and the
       * kiosk says so — which is the site's own configuration doing its job,
       * so the fixture supplies them rather than turning the rules off.
       */
      vehicle_reg: type === 'driver' ? `DAY ${String(100 + i)}` : null,
      reference: type === 'driver' ? `PO-${9000 + i}` : null,
      movement: type === 'driver' ? (i % 2 ? 'Delivery' : 'Pick-Up') : null
    });
  }
  return day;
}

(async () => {
  await req('POST', '/api/admin/login', { email: 'hankalfr@gmail.com', password: 'Testing123!' });

  /* ------------------------------------------------------------ the site */

  const staff = [];
  for (const name of ['Priya Raman', 'Tom Beckett', 'Dana Whitlock']) {
    const found = ((await req('GET', '/api/admin/staff')).data || []).find((h) => h.name === name);
    staff.push(found || (await req('POST', '/api/admin/staff',
      { name, email: `${name.split(' ')[0].toLowerCase()}.day@example.com`, active: 1 })).data);
  }
  ok('the site has staff for visitors to be here to see', staff.every((h) => h && h.id));

  const projects = [];
  for (const [name, code] of [['Warehouse fit-out', 'DAY-W'], ['Yard resurfacing', 'DAY-Y']]) {
    projects.push((await req('POST', '/api/admin/projects', { name, code, active: 1 })).data);
  }
  ok('…and two jobs for the crew to be working on', projects.every((p) => p && p.id));

  /*
   * What the site already holds. A fresh install ships with one example visit
   * per type and the suites before this one leave their own fixtures behind,
   * so every count here is measured as a difference rather than assumed to
   * start at nought — a test that only passes on an empty database is a test
   * that will start lying the first time somebody runs it out of order.
   */
  const TODAY = localtime.today();
  const BASE_DASH = (await req('GET', '/api/admin/dashboard')).data;
  const WAS_ONSITE = BASE_DASH.stats.onsite;
  const WAS_IN = BASE_DASH.stats.today_in;
  const WAS_OUT = BASE_DASH.stats.today_out;
  const BASE_STATS = (await req('GET', `/api/admin/stats?from=${TODAY}&to=${TODAY}`)).data;
  const WAS_TODAY = BASE_STATS.total;
  const WAS_HOURS = BASE_STATS.total_hours;
  const WAS_CONTRACTORS = (BASE_STATS.by_type.find((t) => t.visit_type === 'contractor') || {}).n || 0;

  const SETTINGS_BEFORE = (await req('GET', '/api/admin/settings')).data;
  const DETAILS_BEFORE = SETTINGS_BEFORE.details;
  const BADGE_BEFORE = SETTINGS_BEFORE.badge;
  await req('PUT', '/api/admin/settings', {
    details: { contractor: { photo: 'optional', company: 'required', phone: 'required', staff: 'off', project: 'required' } },
    /*
     * Badges on, with a prefix per type. Forty numbers issued in one day is
     * the only way to find out whether two people can end up wearing the same
     * one — which on a site with a barrier is not a cosmetic problem.
     */
    badge: {
      enabled: true, auto_print: false, badge_prefix: 'D',
      badge_prefixes: { contractor: 'C', driver: 'T' }
    }
  });

  /* ---- a few of them were booked in the day before ---- */
  const plan = planDay();
  const booked = [plan[24], plan[25], plan[33]];
  const bookings = [];
  for (const p of booked) {
    const r = await req('POST', '/api/admin/expected', {
      full_name: p.full_name, company: p.company, phone: p.phone, visit_type: p.visit_type,
      host_id: staff[0].id, expected_on: localtime.today(), expected_at: `${String(p.in_hour).padStart(2, '0')}:00`
    });
    bookings.push(r.data);
  }
  ok('three of them were booked in before the day started',
    bookings.every((b) => b && b.id), JSON.stringify(bookings.map((b) => b && b.id)));
  ok('…and the dashboard counts them as still to come, not as here',
    (await req('GET', '/api/admin/dashboard')).data.stats.expected_today >= 3);

  /* --------------------------------------------------- the day itself */

  const db = require('../server/db');
  const range = localtime.dayRange(localtime.today());
  const atHour = (h) => new Date(Date.parse(range.start) + h * 3600e3).toISOString();

  const started = Date.now();
  const made = [];
  for (const p of plan) {
    const r = await req('POST', '/api/kiosk/signin', {
      full_name: p.full_name,
      company: p.company,
      phone: p.phone,
      visit_type: p.visit_type,
      host_id: p.visit_type === 'contractor' ? null : staff[p.i % staff.length].id,
      project_id: p.visit_type === 'contractor' ? projects[p.i % projects.length].id : null,
      photo: p.photo ? PNG : null,
      vehicle_reg: p.vehicle_reg,
      reference: p.reference,
      movement: p.movement,
      client_ref: `day-${p.i}-${Date.now()}`
    });
    if (r.status !== 200 || !r.data.visit) {
      ok(`sign-in ${p.i + 1} of 40 is accepted`, false, JSON.stringify(r.data).slice(0, 140));
      break;
    }
    made.push({ ...p, id: r.data.visit.id, badge_no: r.data.visit.badge_no });
  }
  const signinMs = Date.now() - started;
  ok('forty people sign in through the kiosk', made.length === 40, `${made.length} got through`);
  ok('…without the kiosk slowing to a crawl', signinMs / Math.max(1, made.length) < 400,
    `${Math.round(signinMs / Math.max(1, made.length))}ms each, ${signinMs}ms for the day`);

  // Spread across the day. There is deliberately no route for editing when a
  // visit happened — that is a record of who was where — so the fixture is
  // built here rather than by adding one for a test's convenience.
  for (const v of made) {
    db.run('UPDATE visits SET signed_in_at = ?, created_at = ? WHERE id = ?',
      atHour(v.in_hour), atHour(v.in_hour), v.id);
  }
  // Everybody who left, signed out through the kiosk like they really would.
  const leavers = made.filter((v) => v.out_hour != null);
  for (const v of leavers) {
    await req('POST', '/api/kiosk/signout', { visit_id: v.id });
    db.run('UPDATE visits SET signed_out_at = ? WHERE id = ?', atHour(v.out_hour), v.id);
  }
  const stillHere = made.filter((v) => v.out_hour == null);
  ok(`${leavers.length} of them sign out again through the day`,
    leavers.length + stillHere.length === 40, `${leavers.length} out, ${stillHere.length} still here`);

  /* ------------------------------------------ does everything agree? */

  const dash = (await req('GET', '/api/admin/dashboard')).data;
  ok('the dashboard says exactly who is still on site',
    dash.stats.onsite - WAS_ONSITE === stillHere.length,
    `${dash.stats.onsite} now, ${WAS_ONSITE} before, ${stillHere.length} of mine`);
  ok('…and counts the whole day’s arrivals', dash.stats.today_in - WAS_IN === 40,
    `${dash.stats.today_in} today, ${WAS_IN} before`);
  ok('…and the departures with them', dash.stats.today_out - WAS_OUT === leavers.length,
    `${dash.stats.today_out - WAS_OUT} vs ${leavers.length}`);
  ok('…listing every one of the people still here, not a page of them',
    stillHere.every((v) => dash.onsite.some((r) => r.id === v.id)), `${dash.onsite.length} listed`);

  const roll = (await req('GET', '/api/admin/rollcall')).data;
  ok('the roll call agrees with the dashboard, person for person',
    roll.count === dash.stats.onsite && stillHere.every((v) => roll.rows.some((r) => r.id === v.id)),
    `${roll.count} on the roll call, ${dash.stats.onsite} on the dashboard`);
  ok('…and nobody who signed out is still on it',
    !roll.rows.some((r) => leavers.some((v) => v.id === r.id)),
    JSON.stringify(roll.rows.filter((r) => leavers.some((v) => v.id === r.id)).map((r) => r.full_name)));

  const rollCsv = await req('GET', '/api/admin/rollcall?format=csv');
  ok('the roll call prints as a CSV with one line per person here',
    rollCsv.text.trim().split('\n').filter(Boolean).length === roll.count + 1,
    `${rollCsv.text.trim().split('\n').length - 1} rows for ${roll.count} people`);

  /* ---- the board somebody has on a screen in the office ---- */
  await req('POST', '/api/admin/board/key', { enabled: true });
  const link = (await req('GET', '/api/admin/board/link')).data;
  const key = link.url ? link.url.split('/').pop() : null;
  const board = key ? (await req('GET', `/api/board/${key}/data`)).data : null;
  ok('the on-site board shows the same people as the roll call',
    !!board && board.onsite.length === roll.count,
    board ? `${board.onsite.length} on the board, ${roll.count} on the roll call` : 'no board');
  ok('…each of today’s forty who are still here among them',
    !!board && stillHere.every((v) => board.onsite.some((r) => r.id === v.id)));

  /* ---- the visits list, which is where forty stops fitting on a screen ---- */
  const day = TODAY;
  const dayTotal = WAS_TODAY + 40;
  const page1 = await req('GET', `/api/admin/visits?from=${day}&to=${day}&limit=15`);
  ok('the visits list knows how many there are, while showing fifteen',
    Number(page1.headers.get('X-Total-Count')) === dayTotal && page1.data.length === 15,
    `${page1.headers.get('X-Total-Count')} total, ${dayTotal} expected, ${page1.data.length} shown`);
  const ids = new Set();
  for (let offset = 0; offset < dayTotal + 15; offset += 15) {
    const p = await req('GET', `/api/admin/visits?from=${day}&to=${day}&limit=15&offset=${offset}`);
    p.data.forEach((v) => ids.add(v.id));
  }
  ok('…and paging through reaches every one of them, with none repeated',
    ids.size === dayTotal, `${ids.size} distinct of ${dayTotal}`);
  ok('…including all forty of today’s', made.every((v) => ids.has(v.id)));

  const csv = await req('GET', `/api/admin/visits?format=csv&from=${day}&to=${day}`);
  ok('the export is the whole day, not the page on screen',
    csv.text.trim().split('\n').filter(Boolean).length === dayTotal + 1,
    `${csv.text.trim().split('\n').length - 1} rows for ${dayTotal} visits`);

  /* ---- the figures, and the hours a contractor operation bills on ---- */
  const stats = (await req('GET', `/api/admin/stats?from=${day}&to=${day}`)).data;
  ok('the reports count the same visits as the list', stats.total === dayTotal,
    `${stats.total} vs ${dayTotal}`);
  const crew = made.filter((v) => v.visit_type === 'contractor');
  const crewHours = crew.filter((v) => v.out_hour != null)
    .reduce((n, v) => n + (v.out_hour - v.in_hour), 0);
  ok('…and the hours per project add up to what the crew actually worked',
    Math.abs((stats.total_hours - WAS_HOURS) - crewHours) < 0.2,
    `${stats.total_hours - WAS_HOURS} counted, ${crewHours} worked`);
  ok('…split across both jobs',
    stats.by_project.filter((p) => /^(Warehouse fit-out|Yard resurfacing)$/.test(p.name)).length === 2,
    JSON.stringify(stats.by_project.map((p) => p.name)));
  ok('…and every visitor type is broken out',
    new Set(stats.by_type.map((t) => t.visit_type)).size >= 4, JSON.stringify(stats.by_type));
  const typed = Object.fromEntries(stats.by_type.map((t) => [t.visit_type, t.n]));
  ok('…with the crew counted as the crew', typed.contractor - WAS_CONTRACTORS === 22,
    `${typed.contractor} contractors, ${WAS_CONTRACTORS} before`);

  const printed = await req('GET', `/api/admin/stats/print?from=${day}&to=${day}`);
  ok('the printed report says the same number, not a different one',
    printed.text.includes(`>${dayTotal.toLocaleString('en-GB')}</div>`), String(dayTotal));
  ok('…and names both jobs with their hours on it',
    printed.text.includes('Warehouse fit-out') && printed.text.includes('Yard resurfacing'));

  /* ---- badges, which have to be unique or they are not badges ---- */
  const badges = made.map((v) => v.badge_no).filter(Boolean);
  ok('every one of the forty is issued a badge number', badges.length === 40, `${badges.length} issued`);
  ok('…and no two people are wearing the same one',
    new Set(badges).size === badges.length,
    `${badges.length} issued, ${new Set(badges).size} distinct`);
  ok('…with the crew’s prefix on the crew and the drivers’ on the drivers',
    made.filter((v) => v.visit_type === 'contractor').every((v) => v.badge_no.startsWith('C'))
    && made.filter((v) => v.visit_type === 'driver').every((v) => v.badge_no.startsWith('T'))
    && made.filter((v) => v.visit_type === 'visitor').every((v) => v.badge_no.startsWith('D')),
    JSON.stringify(made.slice(0, 3).concat(made.slice(-3)).map((v) => `${v.visit_type}:${v.badge_no}`)));
  /*
   * Each prefix runs its own series — that is the point of a prefix per type,
   * so the crew's numbers are not interleaved with the drivers'. What matters
   * is that within a series nothing is skipped and nothing repeats.
   */
  const series = {};
  for (const v of made) {
    const key = v.badge_no.slice(0, v.badge_no.length - 3);
    (series[key] = series[key] || []).push(Number(v.badge_no.slice(-3)));
  }
  ok('…and within each series the numbers run 1, 2, 3 with nothing skipped or repeated',
    Object.values(series).every((seq) => {
      const sorted = [...seq].sort((a, b) => a - b);
      return sorted.every((n, i) => n === i + 1);
    }), JSON.stringify(Object.fromEntries(
      Object.entries(series).map(([k, v]) => [k, `${v.length} issued, up to ${Math.max(...v)}`]))));

  /* ---- the bookings the day was supposed to fulfil ---- */
  const expectedNow = (await req('GET', `/api/admin/expected?on=${day}`)).data;
  ok('everybody who was booked in is marked as having arrived',
    bookings.every((b) => (expectedNow.rows.find((r) => r.id === b.id) || {}).status === 'arrived'),
    JSON.stringify(expectedNow.rows.filter((r) => bookings.some((b) => b.id === r.id)).map((r) => r.status)));
  ok('…against the visit that actually did it',
    bookings.every((b) => {
      const row = expectedNow.rows.find((r) => r.id === b.id);
      return row && made.some((v) => v.id === row.visit_id && v.full_name === row.full_name);
    }));

  /* ---- and none of it is slow enough to notice ---- */
  const timed = async (label, path) => {
    const t = Date.now();
    const r = await req('GET', path);
    return { label, ms: Date.now() - t, status: r.status };
  };
  const timings = [
    await timed('dashboard', '/api/admin/dashboard'),
    await timed('roll call', '/api/admin/rollcall'),
    await timed('visits page', `/api/admin/visits?from=${day}&to=${day}&limit=15`),
    await timed('reports', `/api/admin/stats?from=${day}&to=${day}`),
    await timed('printed report', `/api/admin/stats/print?from=${day}&to=${day}`)
  ];
  ok('every page answers in well under a second on a full day',
    timings.every((t) => t.status === 200 && t.ms < 1000),
    timings.map((t) => `${t.label} ${t.ms}ms`).join(', '));
  console.log(`      ${timings.map((t) => `${t.label} ${t.ms}ms`).join(' · ')}`);

  /* ---- the end of the day: sign everyone out at once ---- */
  const swept = await req('POST', '/api/admin/visits/signout-all');
  ok('signing out everyone at the end of the day clears the site',
    swept.data.count === roll.count, `${swept.data.count} swept, ${roll.count} were here`);
  const afterSweep = (await req('GET', '/api/admin/dashboard')).data;
  ok('…leaving nobody on site', afterSweep.stats.onsite === 0, String(afterSweep.stats.onsite));
  ok('…while the day still counts every arrival — a sweep is not a delete',
    afterSweep.stats.today_in - WAS_IN === 40, `${afterSweep.stats.today_in} today, ${WAS_IN} before`);
  ok('…and the roll call is empty rather than stale',
    (await req('GET', '/api/admin/rollcall')).data.count === 0);

  /* ---------------------------------------------------- clearing up */

  for (const v of made) await req('DELETE', `/api/admin/visits/${v.id}`);
  for (const b of bookings) if (b && b.id) await req('DELETE', `/api/admin/expected/${b.id}`);
  for (const p of projects) await req('DELETE', `/api/admin/projects/${p.id}`);
  db.run("DELETE FROM visitors WHERE phone LIKE '4152%' AND id NOT IN (SELECT visitor_id FROM visits)");
  await req('POST', '/api/admin/board/key', { enabled: false });
  await req('PUT', '/api/admin/settings', { details: DETAILS_BEFORE, badge: BADGE_BEFORE });

  const left = (await req('GET', `/api/admin/visits?from=${day}&to=${day}`));
  ok('the day is cleared away afterwards, so the suites after this see the site they expect',
    Number(left.headers.get('X-Total-Count')) === WAS_TODAY,
    `${left.headers.get('X-Total-Count')} left, ${WAS_TODAY} were there before`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
