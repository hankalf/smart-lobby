'use strict';
/**
 * Which job a sign-in should land on before anybody picks one.
 *
 * A crew from one firm are on the same job every morning for four months. Made
 * to choose it off a dropdown each time, they pick the top one, or the one they
 * were on last month, or whichever their thumb lands on — and the hours report
 * that a contractor operation bills against quietly becomes fiction.
 *
 * So the kiosk offers an answer. Two sources, most specific first:
 *
 *   1. The firm's own usual job, set on the company record. This is the one
 *      that earns its keep, because "who they work for" is the thing that
 *      actually predicts which job they are on.
 *   2. A fallback per visitor type, for a site running one job at a time.
 *
 * It is a default and never a decision: the field is filled in, shown selected,
 * and the visitor can change it. A default that could not be overridden would
 * be worse than none, because the day it is wrong is the day somebody is on the
 * other job and nobody notices for a month.
 */
const { get } = require('./db');
const settings = require('./settings');

/** Live projects only — a closed job must never be offered as a default. */
const openProject = (id) => (id
  ? get('SELECT id, name FROM projects WHERE id = ? AND active = 1', Number(id))
  : null);

/**
 * @param {object} opts
 * @param {string} opts.visitType    the type being signed in
 * @param {number} [opts.companyId]  the company record, where one is known
 * @param {string} [opts.companyName] what they typed, if there is no record yet
 * @returns {{id: number, name: string, from: 'company'|'type'}|null}
 */
function defaultFor({ visitType, companyId, companyName } = {}) {
  // The firm's usual job.
  let company = null;
  if (companyId) company = get('SELECT id, default_project_id FROM companies WHERE id = ?', Number(companyId));
  else if (companyName && String(companyName).trim()) {
    company = get('SELECT id, default_project_id FROM companies WHERE lower(name) = ?',
      String(companyName).trim().toLowerCase());
  }
  if (company && company.default_project_id) {
    const project = openProject(company.default_project_id);
    if (project) return { id: project.id, name: project.name, from: 'company' };
  }

  // Otherwise whatever this visitor type usually does.
  const byType = (settings.getSection('projects').default_by_type) || {};
  const fallback = openProject(byType[visitType]);
  if (fallback) return { id: fallback.id, name: fallback.name, from: 'type' };

  return null;
}

module.exports = { defaultFor };
