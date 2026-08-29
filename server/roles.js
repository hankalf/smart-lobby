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
  stats: 'dashboard',
  rollcall: 'visits',
  visits: 'visits',
  visitors: 'visitors',
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

/**
 * @returns {string|null} the area this request needs, or null if anyone signed
 *   in may make it
 */
function areaForRequest(method, urlPath) {
  const segment = String(urlPath || '').split('?')[0].split('/').filter(Boolean)[0] || '';
  if (ALWAYS_ALLOWED.has(segment)) return null;
  // Changing your own password is not an administrative act.
  if (segment === 'me') return null;
  /*
   * The staff list is readable by anyone who can open a visit, but editing it
   * — and especially granting a login through it — is administration.
   */
  if (segment === 'staff' && method !== 'GET') return 'admin';
  return AREA_BY_PREFIX[segment] || 'admin';
}

/** The list the dashboard uses to decide which tabs to draw. */
const describe = () => Object.entries(ROLES)
  .filter(([key]) => key !== 'owner')
  .map(([key, r]) => ({ key, label: r.label, describe: r.describe, areas: r.areas }));

module.exports = { AREAS, ROLES, areasFor, can, isAdmin, areaForRequest, describe };
