'use strict';
/**
 * One box that finds anything: a visitor, a firm, a job, a member of staff, a
 * tablet, a visit, somebody booked in for tomorrow.
 *
 * Reception know the name and want the record. Without this they have to guess
 * which page a thing lives on first — a name might be a visitor, or a member
 * of staff, or a company, and "Halden" could be all three — and the guess is
 * wrong often enough to be the slow part of a busy morning.
 *
 * ---------------------------------------------------------------------------
 * The part that matters most
 *
 * A search box that reaches everything is the classic way to walk straight
 * through a permission model. Somebody who books deliveries in has no business
 * reading the visitor registry, and it would be no defence that the only route
 * to it was a search box rather than a page.
 *
 * So every source declares the area it belongs to, and a source whose area the
 * caller does not hold is never queried at all — not queried and filtered
 * afterwards, which is the shape that leaks the day somebody edits the filter.
 * The areas are exactly the ones roles.js uses for the pages themselves, so
 * what a search can reach and what a menu can reach cannot drift apart.
 */
const { all } = require('./db');
const roles = require('./roles');

/*
 * Matched with LIKE on a couple of indexed-enough columns rather than with
 * SQLite's full-text search. A site's whole registry is thousands of rows, not
 * millions; FTS would mean a second copy of every searchable string kept in
 * step with the first, and the failure mode of that is a search that quietly
 * stops finding things somebody renamed last week.
 */
const like = (q) => `%${String(q).replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

/** Digits only, so "(415) 268-0101" finds a number stored as 4152680101. */
const digits = (v) => String(v || '').replace(/\D/g, '');
const PHONE_SQL = "replace(replace(replace(replace(replace(phone, char(32), ''), '-', ''), '(', ''), ')', ''), '+', '')";

/*
 * Every source, with the area it belongs to and how to look inside it.
 *
 * `area` is the same string roles.js maps the equivalent page to. `go` is
 * where the dashboard should send somebody who picks the result — the view,
 * and the record to open once it is there.
 */
const SOURCES = [
  {
    key: 'visitor',
    label: 'People',
    area: 'visitors',
    find: (q, limit) => all(
      `SELECT v.id, v.full_name, v.company, v.phone, v.email,
              (SELECT COUNT(*) FROM visits vi WHERE vi.visitor_id = v.id) AS visits,
              (SELECT MAX(vi.signed_in_at) FROM visits vi WHERE vi.visitor_id = v.id) AS last_seen
       FROM visitors v
       WHERE v.full_name LIKE ? ESCAPE '\\' OR v.company LIKE ? ESCAPE '\\'
          OR v.email LIKE ? ESCAPE '\\'
          OR (? != '' AND ${PHONE_SQL.replace(/phone/g, 'v.phone')} LIKE ?)
       ORDER BY last_seen DESC NULLS LAST, v.full_name LIMIT ?`,
      like(q), like(q), like(q), digits(q), `%${digits(q)}%`, limit),
    shape: (r) => ({
      id: r.id,
      title: r.full_name,
      detail: [r.company, r.phone].filter(Boolean).join(' · '),
      note: r.visits ? `${r.visits} visit${r.visits === 1 ? '' : 's'}` : 'never signed in',
      when: r.last_seen,
      go: { view: 'visitors', open: r.id }
    })
  },
  {
    key: 'visit',
    label: 'Visits',
    area: 'visits',
    find: (q, limit) => all(
      `SELECT vi.id, vi.signed_in_at, vi.signed_out_at, vi.status, vi.badge_no, vi.visit_type,
              p.full_name, p.company, h.name AS host_name
       FROM visits vi
       JOIN visitors p ON p.id = vi.visitor_id
       LEFT JOIN hosts h ON h.id = vi.host_id
       WHERE p.full_name LIKE ? ESCAPE '\\' OR p.company LIKE ? ESCAPE '\\'
          OR vi.badge_no LIKE ? ESCAPE '\\'
       ORDER BY vi.signed_in_at DESC LIMIT ?`,
      like(q), like(q), like(q), limit),
    shape: (r) => ({
      id: r.id,
      title: r.full_name,
      detail: [r.company, r.host_name ? `to see ${r.host_name}` : null, r.badge_no]
        .filter(Boolean).join(' · '),
      note: r.status === 'onsite' ? 'on site now' : 'signed out',
      when: r.signed_in_at,
      go: { view: 'visits', open: r.id }
    })
  },
  {
    key: 'expected',
    label: 'Expected',
    area: 'visits',
    find: (q, limit) => all(
      `SELECT e.id, e.full_name, e.company, e.expected_on, e.expected_at, e.status,
              h.name AS host_name
       FROM expected_visits e LEFT JOIN hosts h ON h.id = e.host_id
       WHERE e.status = 'expected'
         AND (e.full_name LIKE ? ESCAPE '\\' OR e.company LIKE ? ESCAPE '\\'
              OR upper(e.code) = upper(?))
       ORDER BY e.expected_on, e.expected_at LIMIT ?`,
      like(q), like(q), String(q).trim(), limit),
    shape: (r) => ({
      id: r.id,
      title: r.full_name,
      detail: [r.company, r.host_name ? `to see ${r.host_name}` : null].filter(Boolean).join(' · '),
      note: `expected ${r.expected_on}${r.expected_at ? ` at ${r.expected_at}` : ''}`,
      when: null,
      go: { view: 'expected', open: r.id }
    })
  },
  {
    key: 'company',
    label: 'Companies',
    area: 'visitors',
    find: (q, limit) => all(
      `SELECT c.id, c.name,
              (SELECT COUNT(*) FROM visitors v WHERE v.company_id = c.id) AS people
       FROM companies c WHERE c.name LIKE ? ESCAPE '\\' ORDER BY c.name LIMIT ?`,
      like(q), limit),
    shape: (r) => ({
      id: r.id,
      title: r.name,
      detail: r.people ? `${r.people} ${r.people === 1 ? 'person' : 'people'} on file` : 'nobody on file yet',
      note: null,
      when: null,
      go: { view: 'companies', open: r.id }
    })
  },
  {
    /*
     * Staff sit under 'visits' rather than 'visitors', matching roles.js:
     * reading the staff list is how a visit names who it is for, so anybody
     * who can open a visit can already see these names.
     */
    key: 'staff',
    label: 'Staff',
    area: 'visits',
    find: (q, limit) => all(
      `SELECT id, name, email, department FROM hosts
       WHERE active = 1 AND (name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\'
             OR department LIKE ? ESCAPE '\\')
       ORDER BY name LIMIT ?`,
      like(q), like(q), like(q), limit),
    shape: (r) => ({
      id: r.id,
      title: r.name,
      detail: [r.department, r.email].filter(Boolean).join(' · '),
      note: null,
      when: null,
      go: { view: 'staff', open: r.id }
    })
  },
  {
    key: 'project',
    label: 'Projects',
    area: 'projects',
    find: (q, limit) => all(
      `SELECT id, name, code, active FROM projects
       WHERE name LIKE ? ESCAPE '\\' OR code LIKE ? ESCAPE '\\' OR name_es LIKE ? ESCAPE '\\'
       ORDER BY active DESC, name LIMIT ?`,
      like(q), like(q), like(q), limit),
    shape: (r) => ({
      id: r.id,
      title: r.name,
      detail: r.code || null,
      note: r.active ? null : 'closed',
      when: null,
      go: { view: 'projects', open: r.id }
    })
  },
  {
    key: 'device',
    label: 'Devices',
    area: 'admin',
    find: (q, limit) => all(
      `SELECT d.id, d.name, d.slug, d.last_seen_at, l.name AS location_name
       FROM devices d LEFT JOIN locations l ON l.id = d.location_id
       WHERE d.name LIKE ? ESCAPE '\\' OR d.slug LIKE ? ESCAPE '\\'
       ORDER BY d.name LIMIT ?`,
      like(q), like(q), limit),
    shape: (r) => ({
      id: r.id,
      title: r.name,
      detail: r.location_name || null,
      note: null,
      when: r.last_seen_at,
      go: { view: 'devices', open: r.id }
    })
  }
];

/**
 * @param {string} query   what somebody typed
 * @param {string} role    their access level
 * @param {number} [perGroup]  how many of each kind to return
 * @returns {{query: string, groups: Array, searched: string[], withheld: string[]}}
 */
function search(query, role, perGroup = 5) {
  const q = String(query || '').trim();
  /*
   * Two characters find half the registry and tell nobody anything. Three is
   * where a search starts being a search rather than a listing.
   */
  if (q.length < 2) return { query: q, groups: [], searched: [], withheld: [], too_short: true };

  const groups = [];
  const searched = [];
  const withheld = [];
  const broken = [];

  for (const source of SOURCES) {
    // Never queried, rather than queried and filtered — the second shape is
    // the one that leaks the day somebody edits the filter.
    if (!roles.can(role, source.area)) { withheld.push(source.key); continue; }
    searched.push(source.key);
    /*
     * A source that throws is reported, not swallowed. One silently returning
     * nothing looks exactly like "no matches", so a broken query would hide
     * behind an empty result for as long as nobody happened to search for
     * something they knew was there.
     */
    let rows = [];
    try {
      rows = source.find(q, perGroup + 1);
    } catch (err) {
      console.error(`[search] ${source.key}:`, err.message);
      broken.push(source.key);
    }
    if (!rows.length) continue;
    groups.push({
      key: source.key,
      label: source.label,
      // One more than asked for is fetched, purely to know whether to say so.
      more: rows.length > perGroup,
      results: rows.slice(0, perGroup).map(source.shape)
    });
  }

  return { query: q, groups, searched, withheld, ...(broken.length ? { broken } : {}) };
}

module.exports = { search, SOURCES };
