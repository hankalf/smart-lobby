'use strict';
/**
 * One example of each visitor type, put in at first setup.
 *
 * A brand-new install is entirely empty, which is the worst moment to be
 * looking at it: every page says "nothing yet", the badge designer has no
 * badge to draw, the Teams card preview invents a visitor, and there is no
 * way to see what a report or the on-site board will look like without first
 * standing at the kiosk and signing yourself in four times.
 *
 * So each type gets one example — signed in this morning, signed out at
 * lunchtime, except one left on site so the dashboard and the board have
 * somebody on them. They are ordinary records: they can be deleted like any
 * other, and nothing here runs again once a site has its own.
 */
const { run, get, all, nowISO } = require('./db');
const companies = require('./companies');

/*
 * Names that are obviously placeholders. Somebody clearing these out should
 * not have to wonder whether one of them was a real visitor, and a card that
 * reaches Teams during setup should read as a sample rather than as a person.
 */
const PEOPLE = [
  { type: 'visitor', name: 'John Doe', company: 'Example Consulting', purpose: 'Site meeting', out_hours: 2 },
  { type: 'contractor', name: 'Jane Doe', company: 'Example Roofing', vehicle: 'AB12 CDE', out_hours: null },
  { type: 'interview', name: 'Sam Doe', company: '', purpose: 'Interview', out_hours: 1 },
  { type: 'driver', name: 'Alex Doe', company: 'Example Haulage', vehicle: 'XY98 ZTU', reference: 'ORD-1001', out_hours: 1 }
];

const hoursAgo = (h) => new Date(Date.now() - h * 3600e3).toISOString();

/**
 * Put one visit of each configured type in, if this site has none of its own.
 *
 * @returns {number} how many were added
 */
function seed() {
  // Never on a site that has been used: examples belong to an empty install.
  if (get('SELECT id FROM visits LIMIT 1')) return 0;

  const site = get('SELECT id FROM sites LIMIT 1');
  // The types this site actually has, falling back to the four built-in ones.
  const configured = require('./settings').getAll().types || [];
  const wanted = configured.length ? configured.map((t) => t.key) : PEOPLE.map((p) => p.type);

  let made = 0;
  for (const person of PEOPLE) {
    if (!wanted.includes(person.type)) continue;
    const company = person.company ? companies.resolve(person.company) : null;
    const r = run(`INSERT INTO visitors (full_name, company, company_id, phone, is_example, visit_count, last_visit_at, created_at)
                   VALUES (?,?,?,?,1,1,?,?)`,
      person.name, company ? company.name : null, company ? company.id : null,
      null, hoursAgo(4), nowISO());
    const visitorId = Number(r.lastInsertRowid);
    run(`INSERT INTO visits (site_id, visitor_id, visit_type, purpose, vehicle_reg, reference,
                             status, signed_in_at, signed_out_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      site ? site.id : null, visitorId, person.type, person.purpose || null,
      person.vehicle || null, person.reference || null,
      person.out_hours == null ? 'onsite' : 'out',
      hoursAgo(4), person.out_hours == null ? null : hoursAgo(4 - person.out_hours), nowISO());
    made++;
  }
  if (made) console.log(`[setup] added ${made} example visit(s) — delete them once your own start arriving`);
  return made;
}

/** Whether any of the examples are still on file. */
const present = () => !!get('SELECT id FROM visitors WHERE is_example = 1 LIMIT 1');

/** Whether what is on file is still nothing but the examples. */
const onlyExamples = () => present() && !get('SELECT id FROM visitors WHERE is_example = 0 LIMIT 1');

/**
 * Clear them out — offered once a site has visits of its own.
 *
 * Matched on the flag, never on the name. Somebody genuinely called John Doe
 * signing in should not have their record and their whole history swept away
 * because a placeholder shares their name.
 */
function clear() {
  const rows = all('SELECT id FROM visitors WHERE is_example = 1');
  let gone = 0;
  for (const v of rows) {
    run('DELETE FROM visits WHERE visitor_id = ?', v.id);
    gone += run('DELETE FROM visitors WHERE id = ?', v.id).changes;
  }
  // The example firms too, but only if nobody real has since used them.
  for (const person of PEOPLE.filter((p) => p.company)) {
    const c = get('SELECT id FROM companies WHERE lower(name) = lower(?)', person.company);
    if (c && !get('SELECT id FROM visitors WHERE company_id = ? LIMIT 1', c.id)) {
      run('DELETE FROM companies WHERE id = ?', c.id);
    }
  }
  return gone;
}

module.exports = { seed, clear, present, onlyExamples, PEOPLE };
