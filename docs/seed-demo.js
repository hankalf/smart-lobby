#!/usr/bin/env node
'use strict';
/**
 * A believable site, for the screenshots in the guides.
 *
 *   DATA_DIR=/tmp/demo PORT=3500 node server/index.js &
 *   BASE_URL=http://localhost:3500 node docs/seed-demo.js
 *
 * Everything here is invented — the firms, the people, the jobs. What is not
 * invented is the shape: a contractor site with a crew in early on two jobs,
 * visitors and interviews through the morning, drivers in and out, a few
 * parcels waiting and some paperwork about to lapse. A screenshot of an empty
 * dashboard teaches nobody anything, and one of obviously fake data teaches
 * them to distrust the rest of the guide.
 *
 * The clock matters: everything is placed against the site's own day, so the
 * dashboard reads as a real morning rather than a row of identical times.
 */
const BASE = process.env.BASE_URL || 'http://localhost:3500';

let cookie = '';
async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie },
    body: body ? JSON.stringify(body) : undefined
  });
  const setc = res.headers.get('set-cookie');
  if (setc) cookie = setc.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => null) };
}

/*
 * A stand-in for a visitor photo: initials on a soft field, drawn as an SVG
 * data URL. Deliberately not a face — the guides are published, and putting a
 * stock photograph of a person into a visitor record teaches exactly the wrong
 * lesson about what this system holds.
 */
const AVATAR_INK = ['#2f7d5d', '#3c6e8f', '#8a5a3b', '#6b5b95', '#417068', '#8a5308'];
function avatar(name, i) {
  const initials = name.split(/\s+/).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  const ink = AVATAR_INK[i % AVATAR_INK.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${ink}" stop-opacity=".18"/>
      <stop offset="1" stop-color="${ink}" stop-opacity=".34"/></linearGradient></defs>
    <rect width="240" height="240" fill="url(#g)"/>
    <text x="120" y="120" font-family="Helvetica,Arial,sans-serif" font-size="86" font-weight="600"
          fill="${ink}" text-anchor="middle" dominant-baseline="central">${initials}</text>
  </svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

const STAFF = [
  { name: 'Priya Raman', email: 'priya.raman@naturestouch.example', phone: '415-268-0140', department: 'Site management' },
  { name: 'Tom Beckett', email: 'tom.beckett@naturestouch.example', phone: '415-268-0141', department: 'Groundworks' },
  { name: 'Dana Whitlock', email: 'dana.whitlock@naturestouch.example', phone: '415-268-0142', department: 'Health & safety' },
  { name: 'Marcus Ojo', email: 'marcus.ojo@naturestouch.example', phone: '415-268-0143', department: 'Facilities' },
  { name: 'Ellie Sharpe', email: 'ellie.sharpe@naturestouch.example', phone: '415-268-0144', department: 'People' }
];

const PROJECTS = [
  { name: 'Warehouse extension', code: 'WX1' },
  { name: 'Yard resurfacing', code: 'YR2' },
  { name: 'Office fit-out', code: 'OF3' }
];

/*
 * The crew, the callers and the deliveries. `in` and `out` are hours on the
 * site's clock; `out: null` means they are still here when the screenshot is
 * taken.
 */
const PEOPLE = [
  // The crew, in early, mostly still on site.
  { n: 'Aleksy Nowak',    c: 'Vega Electrical',      t: 'contractor', p: 0, in: 7,  out: null },
  { n: 'Bea Fontaine',    c: 'Vega Electrical',      t: 'contractor', p: 0, in: 7,  out: null },
  { n: 'Callum Reid',     c: 'Ironbark Steel',       t: 'contractor', p: 0, in: 7,  out: null },
  { n: 'Dilan Kaya',      c: 'Ironbark Steel',       t: 'contractor', p: 0, in: 7,  out: 15 },
  { n: 'Esme Bright',     c: 'Kestrel Groundworks',  t: 'contractor', p: 1, in: 7,  out: null },
  { n: 'Femi Adeyemi',    c: 'Kestrel Groundworks',  t: 'contractor', p: 1, in: 7,  out: null },
  { n: 'Grace Okonkwo',   c: 'Marlow Scaffolding',   t: 'contractor', p: 1, in: 8,  out: null },
  { n: 'Hamid Rahimi',    c: 'Marlow Scaffolding',   t: 'contractor', p: 1, in: 8,  out: 14 },
  { n: 'Ines Duarte',     c: 'Halden Plumbing',      t: 'contractor', p: 2, in: 8,  out: null },
  { n: 'Jonah Whitmore',  c: 'Halden Plumbing',      t: 'contractor', p: 2, in: 8,  out: null },
  { n: 'Kasia Lewandowska', c: 'Vega Electrical',    t: 'contractor', p: 0, in: 9,  out: null },
  { n: 'Liam Ferris',     c: 'Ironbark Steel',       t: 'contractor', p: 0, in: 9,  out: 13 },

  // Callers through the morning.
  { n: 'Marguerite Oyelaran', c: 'Ashcroft Surveying', t: 'visitor', h: 0, in: 9,  out: null, why: 'Quarterly site survey' },
  { n: 'Nikhil Sharma',   c: 'Bevan & Locke',        t: 'visitor', h: 0, in: 9,  out: 11, why: 'Contract review' },
  { n: 'Orla Brennan',    c: 'Redgate Insurance',    t: 'visitor', h: 2, in: 10, out: null, why: 'Annual audit' },
  { n: 'Petra Kovač',     c: 'Meridian Design',      t: 'visitor', h: 3, in: 10, out: 12, why: 'Fit-out walkthrough' },
  { n: 'Quentin Marsh',   c: 'Northgate Roofing',    t: 'visitor', h: 1, in: 11, out: null, why: 'Quoting the roof' },

  // Interviews.
  { n: 'Rosa Villalobos', c: '',                     t: 'interview', h: 4, in: 10, out: 11 },
  { n: 'Sami Haddad',     c: '',                     t: 'interview', h: 4, in: 14, out: null },

  // Drivers.
  { n: 'Tomás Ferreira',  c: 'Longhaul Logistics',   t: 'driver', in: 8,  out: 9,  veh: 'BX21 KLM', ref: 'PO-44821', mv: 'Delivery' },
  { n: 'Ushi Tanaka',     c: 'Bellman Freight',      t: 'driver', in: 11, out: 12, veh: 'LT70 WRC', ref: 'PO-44903', mv: 'Delivery' },
  { n: 'Viktor Ilić',     c: 'Longhaul Logistics',   t: 'driver', in: 13, out: null, veh: 'CE22 HDN', ref: 'SO-10277', mv: 'Pick-Up' }
];

const EXPECTED = [
  { n: 'Wanda Achebe', c: 'Redgate Insurance', t: 'visitor', h: 2, at: '14:30', why: 'Insurance renewal' },
  { n: 'Xavier Boucher', c: 'Aurora Fire Systems', t: 'contractor', p: 2, at: '15:00', why: 'Alarm commissioning' },
  { n: 'Yara Salim', c: '', t: 'interview', h: 4, at: '16:00', why: 'Second interview' }
];

const DELIVERIES = [
  { courier: 'Nadia Petrov', company: 'Bellman Freight', host: 3, parcels: 2, ref: 'BF-99120', at: 9 },
  { courier: 'Owen Pryce', company: 'Citylink', host: 0, parcels: 1, ref: 'CL-40288', at: 11 },
  { courier: 'Rafael Costa', company: 'Longhaul Logistics', host: 2, parcels: 4, ref: 'LH-77301', at: 13 }
];

(async () => {
  const setup = await req('POST', '/api/admin/setup', {
    email: 'hankalfr@gmail.com', password: 'Testing123!', name: 'Hank Alfred',
    org_name: "Nature's Touch Builds"
  });
  if (setup.status !== 200) await req('POST', '/api/admin/login', { email: 'hankalfr@gmail.com', password: 'Testing123!' });

  const localtime = require('../server/localtime');
  const db = require('../server/db');
  /*
   * Read after the time zone is set below, not before — these are the site's
   * own hours, and asking what the day is while the site is still nominally in
   * UTC would place every arrival eight hours out.
   */
  const at = (hour, minute = 0) =>
    new Date(Date.parse(localtime.dayRange(localtime.today()).start)
      + hour * 3600e3 + minute * 60e3).toISOString();
  const dayOff = (n) => new Date(Date.parse(`${localtime.today()}T12:00:00Z`) + n * 864e5)
    .toISOString().slice(0, 10);

  /* ---------------------------------------------------------- the site */

  await req('PUT', '/api/admin/settings', {
    org: {
      welcome_title: 'Welcome to Nature’s Touch Builds',
      welcome_message: 'Please sign in — it takes about a minute.',
      goodbye_message: 'Thanks for visiting. Travel safely.',
      /*
       * The demo site is on the west coast. Not decoration: the screenshots
       * are taken whenever they are taken, and a wall clock reading half past
       * eleven at night above a list of people who arrived at seven in the
       * morning is the first thing a reader would notice. A real zone makes
       * the shots read as a working afternoon — and demonstrates the thing
       * the guides say about the site's own clock.
       */
      timezone: 'America/Los_Angeles'
    },
    badge: { enabled: true, auto_print: false, badge_prefix: 'NTB', badge_prefixes: { contractor: 'C', driver: 'T' } },
    details: {
      contractor: { photo: 'optional', company: 'required', phone: 'required', staff: 'off', project: 'required' },
      visitor: { photo: 'optional', company: 'optional', phone: 'required', staff: 'required', purpose: 'optional' }
    }
  });

  const staff = [];
  for (const s of STAFF) staff.push((await req('POST', '/api/admin/staff', { ...s, active: 1 })).data);

  const projects = [];
  for (const p of PROJECTS) projects.push((await req('POST', '/api/admin/projects', { ...p, active: 1 })).data);

  /* -------------------------------------------------------- the day so far */

  let i = 0;
  for (const person of PEOPLE) {
    i++;
    const body = {
      full_name: person.n,
      company: person.c || null,
      phone: `415268${String(2000 + i)}`,
      visit_type: person.t,
      client_ref: `demo-${i}`,
      // Everybody gets one: a list where two rows in ten have a picture and the
      // rest are grey boxes reads as broken rather than as optional.
      photo: avatar(person.n, i)
    };
    if (person.h != null) body.host_id = staff[person.h].id;
    if (person.p != null) body.project_id = projects[person.p].id;
    if (person.why) body.purpose = person.why;
    if (person.veh) { body.vehicle_reg = person.veh; body.reference = person.ref; body.movement = person.mv; }

    const r = await req('POST', '/api/kiosk/signin', body);
    if (r.status !== 200) { console.error('sign-in failed for', person.n, r.data); continue; }
    const id = r.data.visit.id;

    // Placed on the site's own clock, so the dashboard reads as a morning
    // rather than a column of identical timestamps.
    db.run('UPDATE visits SET signed_in_at = ?, created_at = ? WHERE id = ?',
      at(person.in, (i * 7) % 60), at(person.in, (i * 7) % 60), id);
    if (person.out != null) {
      await req('POST', '/api/kiosk/signout', { visit_id: id });
      db.run('UPDATE visits SET signed_out_at = ? WHERE id = ?', at(person.out, (i * 11) % 60), id);
    }
  }

  /* ------------------------------------------------------------ expected */

  for (const e of EXPECTED) {
    await req('POST', '/api/admin/expected', {
      full_name: e.n, company: e.c || null, phone: `415268${String(3000 + EXPECTED.indexOf(e))}`,
      visit_type: e.t, host_id: e.h != null ? staff[e.h].id : null,
      project_id: e.p != null ? projects[e.p].id : null,
      expected_on: localtime.today(), expected_at: e.at, purpose: e.why
    });
  }
  // One for tomorrow, so the list is plainly not only today.
  await req('POST', '/api/admin/expected', {
    full_name: 'Zoë Lindqvist', company: 'Ashcroft Surveying', phone: '4152683900',
    visit_type: 'visitor', host_id: staff[0].id, expected_on: dayOff(1), expected_at: '09:00',
    purpose: 'Level survey'
  });

  /* ---------------------------------------------------------- deliveries */

  for (const d of DELIVERIES) {
    const r = await req('POST', '/api/kiosk/delivery', {
      courier_name: d.courier, courier_company: d.company,
      recipient_host_id: staff[d.host].id, parcel_count: d.parcels, tracking_number: d.ref,
      photo: avatar(d.company, DELIVERIES.indexOf(d) + 2)
    });
    if (r.data && r.data.id) db.run('UPDATE deliveries SET received_at = ? WHERE id = ?', at(d.at, 20), r.data.id);
  }

  /* -------------------------------------------------- paperwork on file */

  const companies = ((await req('GET', '/api/admin/companies')).data || {}).companies || [];
  const byName = (name) => companies.find((c) => c.name === name);
  const certs = [
    ['Vega Electrical', 'Public liability insurance', dayOff(120)],
    ['Ironbark Steel', 'Public liability insurance', dayOff(9)],
    ['Kestrel Groundworks', 'Method statement', dayOff(-4)],
    ['Marlow Scaffolding', 'Public liability insurance', dayOff(240)]
  ];
  for (const [firm, kind, expires] of certs) {
    const company = byName(firm);
    if (!company) continue;
    await req('POST', '/api/admin/certificates', {
      company_id: company.id, kind, reference: `${firm.split(' ')[0].toUpperCase()}-${expires.replace(/-/g, '')}`,
      expires_on: expires
    });
  }

  /* ------------------------------------------------------------- board on */

  await req('POST', '/api/admin/board/key', { enabled: true });
  const link = (await req('GET', '/api/admin/board/link')).data;

  /*
   * The four example records a fresh install ships with go, so the screenshots
   * show one coherent site rather than this one with John Doe standing in it.
   */
  await req('DELETE', '/api/admin/examples');

  const dash = (await req('GET', '/api/admin/dashboard')).data;
  console.log(`  seeded: ${dash.stats.onsite} on site, ${dash.stats.today_in} in today, `
    + `${dash.stats.expected_today} still expected, ${dash.stats.deliveries_waiting} parcels waiting`);
  console.log(`  board:  ${link.url}`);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
