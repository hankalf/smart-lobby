/*
 * The report on paper.
 *
 * Hours per project is the number a contractor operation bills and audits
 * against, and "here is a screenshot of my dashboard" is not what goes in
 * front of a client. What matters here is that the printed page says the same
 * thing as the screen it was printed from — a report that quietly ignores the
 * project filter is worse than no report.
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
  let data = null; try { data = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, data, text, type: res.headers.get('content-type') || '' };
}

const day = (offset) => new Date(Date.parse(`${localtime.today()}T12:00:00Z`) + offset * 864e5)
  .toISOString().slice(0, 10);
const at = (offset, hour) => `${day(offset)}T${String(hour).padStart(2, '0')}:00:00.000Z`;

(async () => {
  await req('POST', '/api/admin/login', { email: 'hankalfr@gmail.com', password: 'Testing123!' });

  /* ---- two projects with known hours, as the screen would show them ---- */
  const alpha = (await req('POST', '/api/admin/projects', { name: 'Print Alpha', code: 'PA', active: 1 })).data;
  const beta = (await req('POST', '/api/admin/projects', { name: 'Print Beta', code: 'PB', active: 1 })).data;
  const DETAILS_BEFORE = (await req('GET', '/api/admin/settings')).data.details;
  await req('PUT', '/api/admin/settings', {
    details: { contractor: { photo: 'off', company: 'off', phone: 'required', staff: 'off', project: 'required' } }
  });

  const db = require('../server/db');
  const place = async (projectId, dayOffset, hrs) => {
    const r = await req('POST', '/api/kiosk/signin', {
      full_name: `Print Person ${Math.random().toString(36).slice(2, 8)}`,
      phone: `415771${String(Math.floor(Math.random() * 9000) + 1000)}`,
      visit_type: 'contractor', project_id: projectId, client_ref: `pr-${Date.now()}-${Math.random()}`
    });
    db.run('UPDATE visits SET signed_in_at = ?, signed_out_at = ?, status = ? WHERE id = ?',
      at(dayOffset, 8), at(dayOffset, 8 + hrs), 'out', r.data.visit.id);
    return r.data.visit.id;
  };
  const mine = [];
  mine.push(await place(alpha.id, -1, 4), await place(alpha.id, -2, 6), await place(beta.id, -1, 3));

  const window = `from=${day(-7)}&to=${day(0)}`;
  const screen = (await req('GET', `/api/admin/stats?${window}`)).data;

  /* ---- it is a web page, not JSON ---- */
  let r = await req('GET', `/api/admin/stats/print?${window}`);
  ok('the printable report comes back as a page', r.status === 200 && /text\/html/.test(r.type), r.type);
  ok('…that is a whole document, so it prints on its own',
    /^<!doctype html>/i.test(r.text.trim()) && /<\/html>/i.test(r.text), r.text.slice(0, 60));
  ok('…carrying its own styling rather than fetching any',
    r.text.includes('<style>') && !/<link[^>]+stylesheet/i.test(r.text));
  ok('…and telling the browser what size paper it is for', r.text.includes('@page'));

  /* ---- with the site's own letterhead on it ---- */
  const org = (await req('GET', '/api/admin/settings')).data.org;
  ok('it carries the organisation name as a letterhead', r.text.includes(org.name), org.name);
  ok('…and says when it was prepared, so an old print-out is obvious',
    /Prepared/.test(r.text));

  /* ---- and says the same thing as the screen ---- */
  ok('the window on the page is the window that was asked for',
    r.text.includes(`${screen.days} day`), `${screen.days} days`);
  ok('the visit count matches the Reports page exactly',
    r.text.includes(`>${screen.total.toLocaleString('en-GB')}</div>`), String(screen.total));
  ok('both projects appear with their hours',
    r.text.includes('Print Alpha') && r.text.includes('Print Beta'));
  ok('…and the hours per project are the ones the screen shows',
    screen.by_project.filter((p) => /^Print /.test(p.name))
      .every((p) => r.text.includes(`>${p.hours >= 10 ? Math.round(p.hours) : p.hours}</td>`)),
    JSON.stringify(screen.by_project.filter((p) => /^Print /.test(p.name))));

  /* ---- a filter on screen is a filter on paper ---- */
  const oneProject = await req('GET', `/api/admin/stats/print?${window}&project_id=${alpha.id}`);
  ok('filtering to one project names it on the report', oneProject.text.includes('Project: Print Alpha'));
  ok('…and leaves the other project off it', !oneProject.text.includes('Print Beta'));

  const oneType = await req('GET', `/api/admin/stats/print?${window}&visit_type=contractor`);
  ok('filtering to one visitor type says so on the report',
    oneType.text.includes('Visitor type: contractor'));

  /* ---- nothing a visitor typed can become markup on the page ---- */
  const nasty = (await req('POST', '/api/admin/projects',
    { name: '<img src=x onerror=alert(1)>Bad Project', code: 'XSS', active: 1 })).data;
  const nastyId = await place(nasty.id, -1, 2);
  mine.push(nastyId);
  const escaped = await req('GET', `/api/admin/stats/print?${window}`);
  ok('a project named with markup is printed as text, not run as markup',
    !escaped.text.includes('<img src=x') && escaped.text.includes('&lt;img src=x'),
    escaped.text.includes('<img src=x') ? 'raw markup made it onto the page' : 'ok');

  /*
   * ---- it is guarded exactly as the Reports page is ----
   *
   * Reception can already read the figures on screen, so printing them is not
   * a new door; a clerk, who has deliveries and drivers and nothing else,
   * must not be able to reach them through this route either.
   */
  const pw = 'Reception123!';
  const rec = (await req('POST', '/api/admin/users', {
    email: `print-reception-${Date.now()}@example.com`, name: 'Print Reception', role: 'reception', password: pw, must_change: false
  })).data;
  const clerk = (await req('POST', '/api/admin/users', {
    email: `print-clerk-${Date.now()}@example.com`, name: 'Print Clerk', role: 'clerk', password: pw, must_change: false
  })).data;

  await req('POST', '/api/admin/logout');
  await req('POST', '/api/admin/login', { email: rec.email, password: pw });
  ok('reception can print what they can already read on screen',
    (await req('GET', `/api/admin/stats/print?${window}`)).status === 200);

  await req('POST', '/api/admin/logout');
  await req('POST', '/api/admin/login', { email: clerk.email, password: pw });
  const denied = await req('GET', `/api/admin/stats/print?${window}`);
  ok('a clerk cannot reach the site’s figures through the printable report',
    denied.status === 403, String(denied.status));

  await req('POST', '/api/admin/logout');
  await req('POST', '/api/admin/login', { email: 'hankalfr@gmail.com', password: 'Testing123!' });
  await req('DELETE', `/api/admin/users/${rec.id}`);
  await req('DELETE', `/api/admin/users/${clerk.id}`);

  /* ---- put the site back as it was ---- */
  for (const id of mine) await req('DELETE', `/api/admin/visits/${id}`);
  for (const p of [alpha, beta, nasty]) await req('DELETE', `/api/admin/projects/${p.id}`);
  await req('PUT', '/api/admin/settings', { details: DETAILS_BEFORE });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
