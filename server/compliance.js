'use strict';
/**
 * The paperwork that says somebody is allowed to work, and stops saying it.
 *
 * Insurance, a safety card, a method statement: each has a date after which
 * it means nothing. Kept as documents to sign, the way agreements are, an
 * expiry has nowhere to live — so a contractor whose ticket lapsed last month
 * signs in this morning and nothing anywhere says so.
 *
 * A certificate is held against a company (one insurance policy covering all
 * their people) or against a person (their own card), because both happen. At
 * the gate the two are checked together: a person is covered if their firm's
 * certificate covers them or their own does.
 */
const { run, get, all, nowISO } = require('./db');
const settings = require('./settings');

const cfg = () => settings.getSection('compliance');

/** The kinds this site keeps, as a list the dashboard and the gate share. */
function kinds() {
  const list = cfg().kinds;
  return (Array.isArray(list) ? list : [])
    .filter((k) => k && k.key)
    .map((k) => ({ key: String(k.key), label: String(k.label || k.key) }));
}

const labelFor = (key) => (kinds().find((k) => k.key === key) || {}).label || key;

/** Which kinds a visitor of this type must have. */
function requiredFor(visitType) {
  const map = cfg().required || {};
  const want = map[visitType];
  const known = new Set(kinds().map((k) => k.key));
  return (Array.isArray(want) ? want : []).filter((k) => known.has(k));
}

/** Today where the site is, as YYYY-MM-DD, so "expires today" is still valid. */
const today = () => require('./localtime').today();

const isExpired = (cert, on = today()) =>
  !!(cert.expires_on && String(cert.expires_on) < String(on));

/** Everything held for a person, their own and their firm's. */
function forVisitor(visitorId, companyId) {
  const parts = [];
  if (visitorId) parts.push(...all('SELECT * FROM certificates WHERE visitor_id = ?', visitorId));
  if (companyId) parts.push(...all('SELECT * FROM certificates WHERE company_id = ?', companyId));
  return parts;
}

/**
 * Whether somebody's paperwork is in order, and what is wrong if not.
 *
 * Returns `{ ok, missing, expired, blocking }` — `missing` and `expired` name
 * the kinds so the desk is told what to chase rather than only that something
 * is amiss. `blocking` says whether this should stop them, which is a site
 * setting rather than something this decides.
 */
function check(visitType, { visitorId, companyId } = {}) {
  const c = cfg();
  const need = requiredFor(visitType);
  if (!c.enabled || !need.length) return { ok: true, missing: [], expired: [], blocking: false };

  const held = forVisitor(visitorId, companyId);
  const missing = [];
  const expired = [];
  for (const kind of need) {
    const ofKind = held.filter((x) => x.kind === kind);
    if (!ofKind.length) { missing.push(kind); continue; }
    // Any one that is still in date covers them — a firm's policy or their own.
    if (!ofKind.some((x) => !isExpired(x))) expired.push(kind);
  }
  const ok = !missing.length && !expired.length;
  return {
    ok,
    missing,
    expired,
    missing_labels: missing.map(labelFor),
    expired_labels: expired.map(labelFor),
    blocking: !ok && c.on_fail === 'block'
  };
}

/** One line a person can act on, for the kiosk and the desk. */
function explain(result) {
  const bits = [];
  if (result.expired_labels && result.expired_labels.length) {
    bits.push(`out of date: ${result.expired_labels.join(', ')}`);
  }
  if (result.missing_labels && result.missing_labels.length) {
    bits.push(`not on file: ${result.missing_labels.join(', ')}`);
  }
  return bits.join('; ');
}

/**
 * What is about to lapse, for the dashboard.
 *
 * Already-expired first, then whatever runs out inside the warning window —
 * the point is to be told before somebody is turned away at the gate, not
 * after.
 */
function expiring(withinDays) {
  const days = Number(withinDays == null ? cfg().warn_days : withinDays) || 30;
  const now = today();
  const limit = new Date(Date.parse(`${now}T00:00:00Z`) + days * 864e5).toISOString().slice(0, 10);
  return all(`
    SELECT ct.*, c.name AS company_name, p.full_name AS visitor_name
      FROM certificates ct
      LEFT JOIN companies c ON c.id = ct.company_id
      LEFT JOIN visitors p ON p.id = ct.visitor_id
     WHERE ct.expires_on IS NOT NULL AND ct.expires_on <= ?
     ORDER BY ct.expires_on`, limit)
    .map((r) => ({
      ...r,
      label: labelFor(r.kind),
      holder: r.company_name || r.visitor_name || 'Unattached',
      expired: String(r.expires_on) < now,
      days_left: Math.round((Date.parse(`${r.expires_on}T00:00:00Z`) - Date.parse(`${now}T00:00:00Z`)) / 864e5)
    }));
}

/** A count for the dashboard banner, without the whole list. */
function health() {
  if (!cfg().enabled) return { enabled: false, expired: 0, expiring: 0 };
  const rows = expiring();
  return {
    enabled: true,
    expired: rows.filter((r) => r.expired).length,
    expiring: rows.filter((r) => !r.expired).length,
    warn_days: Number(cfg().warn_days) || 30
  };
}

/* ------------------------------------------------------------------ crud */

const listFor = ({ companyId, visitorId }) => all(
  `SELECT * FROM certificates WHERE ${companyId ? 'company_id' : 'visitor_id'} = ? ORDER BY kind, expires_on DESC`,
  companyId || visitorId).map((r) => ({ ...r, label: labelFor(r.kind), expired: isExpired(r) }));

function create(body) {
  const companyId = body.company_id ? Number(body.company_id) : null;
  const visitorId = body.visitor_id ? Number(body.visitor_id) : null;
  if (!companyId && !visitorId) throw new Error('A certificate belongs to a company or a person.');
  if (!String(body.kind || '').trim()) throw new Error('Say what kind of certificate this is.');
  const r = run(`INSERT INTO certificates (company_id, visitor_id, kind, reference, issued_on, expires_on, file_path, notes, created_at)
                 VALUES (?,?,?,?,?,?,?,?,?)`,
    companyId, visitorId, String(body.kind).trim(), body.reference || null,
    body.issued_on || null, body.expires_on || null, body.file_path || null, body.notes || null, nowISO());
  return get('SELECT * FROM certificates WHERE id = ?', Number(r.lastInsertRowid));
}

function update(id, body) {
  const fields = ['kind', 'reference', 'issued_on', 'expires_on', 'file_path', 'notes'];
  const cols = fields.filter((f) => body[f] !== undefined);
  if (cols.length) {
    run(`UPDATE certificates SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
      ...cols.map((c) => body[c] || null), id);
  }
  return get('SELECT * FROM certificates WHERE id = ?', id);
}

const remove = (id) => run('DELETE FROM certificates WHERE id = ?', id).changes;

module.exports = {
  kinds, labelFor, requiredFor, check, explain, expiring, health,
  listFor, create, update, remove, isExpired, forVisitor
};
