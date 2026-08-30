'use strict';
/**
 * Who can see what.
 *
 * Everyone with a login used to see everything: one role, 'admin', which meant
 * the whole dashboard — the settings, the backups, the deleted records and
 * every other account. Reception does not need the backups, and whoever books
 * deliveries in does not need the visitor registry.
 *
 * This is the single place that decides. The dashboard reads it to know which
 * tabs to draw, and every request is checked against it on the way in — the
 * menu is a convenience, not a control. Hiding a tab from somebody who can
 * still call the endpoint behind it is not a permission system.
 */

/**
 * The areas a login can be given. These are what a role is a bundle of, so a
 * new page is added to a role by naming it here rather than by editing four
 * lists that then drift apart.
 */
const AREAS = ['dashboard', 'visits', 'visitors', 'projects', 'reports', 'drivers', 'deliveries', 'admin'];

const ROLES = {
  reception: {
    label: 'Reception',
    describe: 'The front desk: who is on site, the registry, projects and reports.',
    areas: ['dashboard', 'visits', 'visitors', 'projects', 'reports']
  },
  clerk: {
    label: 'Clerk',
    describe: 'Drivers and deliveries, and the dashboard.',
    areas: ['dashboard', 'drivers', 'deliveries']
  },
  manager: {
    label: 'Manager',
    describe: 'Everything reception and clerk can do, together. Not the settings.',
    areas: ['dashboard', 'visits', 'visitors', 'projects', 'reports', 'drivers', 'deliveries']
  },
  admin: {
    label: 'Administrator',
    describe: 'Everything, including the settings, backups, accounts and deleted records.',
    areas: AREAS
  },
  /*
   * The first account, and the only one that cannot be demoted or removed —
   * an install where nobody can reach the settings is an install nobody can
   * fix. It is an administrator in every other respect.
   */
  owner: {
    label: 'Owner',
    describe: 'An administrator that cannot be removed or demoted.',
    areas: AREAS
  }
};

const areasFor = (role) => (ROLES[role] || ROLES.reception).areas;
const can = (role, area) => areasFor(role).includes(area);
const isAdmin = (role) => can(role, 'admin');

/**
 * Which area each part of the admin API belongs to.
 *
 * Matched on the first path segment. Anything not named here needs 'admin',
 * so a route added later is closed until somebody decides otherwise — the
 * failure mode of forgetting to add an entry is a locked door rather than an
 * open one.
 */
const AREA_BY_PREFIX = {
  dashboard: 'dashboard',
  // Thirty days of visits broken down by day, type, host and company: that is
  // the Reports page, not the dashboard, whatever the name suggests.
  stats: 'reports',
  rollcall: 'visits',
  visits: 'visits',
  // Booking somebody in for tomorrow is reception's job, and it belongs with
  // the visits they will become.
  expected: 'visits',
  visitors: 'visitors',
  // The firms behind the people, so it sits with the registry.
  companies: 'visitors',
  // The sample records a fresh install starts with, and clearing them out.
  examples: 'visitors',
  // Reception chases lapsing paperwork; changing it is handled below.
  certificates: 'visitors',
  projects: 'projects',
  reports: 'reports',
  drivers: 'drivers',
  deliveries: 'deliveries',
  // Reading the staff list is how a visit names who it is for; changing it is
  // handled separately below.
  staff: 'visits'
};

/** Everything about your own session and account, whoever you are. */
const ALWAYS_ALLOWED = new Set(['me', 'logout', 'login', 'setup', 'bootstrap', 'branding']);

/*
 * A few requests anyone signed in may make, matched on the whole path rather
 * than its first segment — because the segment they sit under is otherwise
 * administrative.
 *
 * `/board/link` is the address of the on-site board and nothing else. The
 * board settings, which include the camera and the key that can be reissued,
 * stay under `/board` and stay administrative.
 */
const OPEN_PATHS = new Set(['GET /board/link']);

/**
 * @returns {string|null} the area this request needs, or null if anyone signed
 *   in may make it
 */
function areaForRequest(method, urlPath) {
  const path = String(urlPath || '').split('?')[0].replace(/\/+$/, '') || '/';
  if (OPEN_PATHS.has(`${String(method || '').toUpperCase()} ${path}`)) return null;
  const segment = path.split('/').filter(Boolean)[0] || '';
  if (ALWAYS_ALLOWED.has(segment)) return null;
  // Changing your own password is not an administrative act.
  if (segment === 'me') return null;
  /*
   * The staff list is readable by anyone who can open a visit, but editing it
   * — and especially granting a login through it — is administration.
   */
  if (segment === 'staff' && method !== 'GET') return 'admin';
  // Reading what is lapsing is reception's job; deciding the rules is not.
  if (segment === 'certificates' && method !== 'GET') return 'visitors';
  return AREA_BY_PREFIX[segment] || 'admin';
}

/** The list the dashboard uses to decide which tabs to draw. */
const describe = () => Object.entries(ROLES)
  .filter(([key]) => key !== 'owner')
  .map(([key, r]) => ({ key, label: r.label, describe: r.describe, areas: r.areas }));

module.exports = { AREAS, ROLES, areasFor, can, isAdmin, areaForRequest, describe, OPEN_PATHS };
