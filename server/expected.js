'use strict';
/**
 * People who are expected, before they turn up.
 *
 * A site knows about most of its visitors the day before: the crew starting
 * Monday, the auditor at ten, the interview at two. Without this, the kiosk
 * meets every one of them as a stranger — they stand typing a name into a
 * tablet with three people waiting behind them — and reception cannot answer
 * "who is coming today" without asking around.
 *
 * An expectation is a plan, not a record of a visit. Plans move, get cancelled
 * and get stood up, so they live in their own table: nothing here ever puts
 * somebody on the roll call who is not actually on site, which in a fire is
 * the one thing this system must not get wrong.
 */
const crypto = require('crypto');
const { run, get, all, nowISO } = require('./db');
const localtime = require('./localtime');

const clean = (v) => (typeof v === 'string' ? v.trim() : v);
const lower = (v) => (clean(v) || '').toLowerCase() || null;

/** Digits only, so "(415) 268-0101" and "4152680101" are the same number. */
const digits = (v) => String(v || '').replace(/\D/g, '');
const PHONE_NORM_SQL = "replace(replace(replace(replace(replace(phone, char(32), ''), '-', ''), '(', ''), ')', ''), '+', '')";

/*
 * The code a visitor is given when they are booked in — the one on the email
 * their host forwards them, which they type or scan at the kiosk instead of
 * filling the form in.
 *
 * Deliberately short and deliberately not sequential: six characters from an
 * alphabet with no O/0 or I/1 in it, because it gets read off a phone screen
 * and typed with one thumb. It is a convenience, not a credential — knowing
 * one only pre-fills a form somebody standing at the kiosk could fill in
 * anyway, and it stops working the moment it is used or the day passes.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = Array.from(crypto.randomBytes(6)).map((b) => ALPHABET[b % ALPHABET.length]).join('');
    if (!get('SELECT id FROM expected_visits WHERE code = ?', code)) return code;
  }
  // Twenty collisions on a 32^6 space means something is very wrong; a longer
  // code is still better than handing back one that is already in use.
  return crypto.randomBytes(8).toString('hex').toUpperCase();
}

const FIELDS = ['full_name', 'company', 'phone', 'email', 'visit_type', 'host_id', 'project_id',
  'site_id', 'expected_on', 'expected_at', 'purpose', 'notes'];

/** A booking with the names of the things it points at, for a list or a card. */
const DETAIL = `SELECT e.*, h.name AS host_name, h.email AS host_email, j.name AS project_name
                FROM expected_visits e
                LEFT JOIN hosts h ON h.id = e.host_id
                LEFT JOIN projects j ON j.id = e.project_id`;

function create(body, by) {
  const name = clean(body.full_name);
  if (!name) return { error: 'name_required' };
  const on = clean(body.expected_on) || localtime.today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) return { error: 'date_invalid' };

  const r = run(`INSERT INTO expected_visits
      (full_name, company, phone, email, visit_type, host_id, project_id, site_id,
       expected_on, expected_at, purpose, notes, code, status, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'expected',?,?)`,
    name, clean(body.company) || null, clean(body.phone) || null, lower(body.email),
    clean(body.visit_type) || 'visitor',
    body.host_id ? Number(body.host_id) : null,
    body.project_id ? Number(body.project_id) : null,
    body.site_id ? Number(body.site_id) : null,
    on, clean(body.expected_at) || null, clean(body.purpose) || null, clean(body.notes) || null,
    newCode(), by || null, nowISO());
  return detail(Number(r.lastInsertRowid));
}

function update(id, body) {
  const existing = get('SELECT * FROM expected_visits WHERE id = ?', id);
  if (!existing) return { error: 'not_found' };
  // Once somebody has walked through the door the booking is history, and
  // editing history to match what you wish had happened is not an edit.
  if (existing.status === 'arrived') return { error: 'already_arrived' };

  const sets = [];
  const params = [];
  for (const f of FIELDS) {
    if (!(f in body)) continue;
    let value = clean(body[f]);
    if (f === 'email') value = lower(value);
    if (f.endsWith('_id')) value = value ? Number(value) : null;
    sets.push(`${f} = ?`);
    params.push(value === '' ? null : value);
  }
  if (typeof body.status === 'string' && ['expected', 'cancelled'].includes(body.status)) {
    sets.push('status = ?');
    params.push(body.status);
  }
  if (!sets.length) return detail(id);
  run(`UPDATE expected_visits SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
  return detail(id);
}

const remove = (id) => run('DELETE FROM expected_visits WHERE id = ?', id).changes > 0;

const detail = (id) => get(`${DETAIL} WHERE e.id = ?`, id);

/**
 * What is on the list.
 *
 * Defaults to today and everything ahead of it, because "who is coming" is
 * almost always the question — but a date, a window or a status narrows it,
 * so yesterday's no-shows can be looked at too.
 */
function list({ on, from, to, status, host_id, limit = 200 } = {}) {
  const where = [];
  const params = [];
  if (on) { where.push('e.expected_on = ?'); params.push(on); }
  else {
    if (from) { where.push('e.expected_on >= ?'); params.push(from); }
    if (to) { where.push('e.expected_on <= ?'); params.push(to); }
    if (!from && !to) { where.push('e.expected_on >= ?'); params.push(localtime.today()); }
  }
  if (status) { where.push('e.status = ?'); params.push(status); }
  if (host_id) { where.push('e.host_id = ?'); params.push(Number(host_id)); }
  return all(`${DETAIL} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
              ORDER BY e.expected_on ASC, COALESCE(e.expected_at, '99:99') ASC, e.id ASC
              LIMIT ?`, ...params, Math.min(500, Math.max(1, Number(limit) || 200)));
}

/**
 * The count for the dashboard: expected today, and how many are still to come.
 */
function today() {
  const day = localtime.today();
  const rows = list({ on: day });
  return {
    day,
    expected: rows.filter((r) => r.status === 'expected').length,
    arrived: rows.filter((r) => r.status === 'arrived').length,
    cancelled: rows.filter((r) => r.status === 'cancelled').length,
    rows
  };
}

/**
 * Find the booking this person at the kiosk is here for.
 *
 * By code first, because that is unambiguous; otherwise by phone or email,
 * which is what makes it work for the visitor who never opened the email.
 * Only today's, and only ones nobody has walked in on yet: a booking for
 * Thursday must not greet somebody arriving on Tuesday as expected.
 */
function match({ code, phone, email, visit_type } = {}) {
  const day = localtime.today();
  const byCode = clean(code) ? get(
    "SELECT * FROM expected_visits WHERE upper(code) = ? AND status = 'expected'",
    String(code).trim().toUpperCase()) : null;
  // A code is explicit enough to honour on the wrong day: somebody holding it
  // is the person it was issued to, and being a day early is not fraud.
  if (byCode) return detail(byCode.id);

  const tryFind = (sql, ...params) => {
    const rows = all(`SELECT * FROM expected_visits
                      WHERE status = 'expected' AND expected_on = ? AND ${sql}
                      ORDER BY COALESCE(expected_at, '99:99') ASC, id ASC`, day, ...params);
    /*
     * Two bookings for the same person on one day is a duplicate, not a
     * choice: taking the earlier one and leaving the other is how a visitor
     * ends up signed in against the wrong job. Both are handed back and the
     * caller can decide; the kiosk asks nothing and simply pre-fills from the
     * first, which is the same booking either way.
     */
    return rows;
  };

  const d = digits(phone);
  let found = d.length >= 6 ? tryFind(`${PHONE_NORM_SQL} = ?`, d) : [];
  if (!found.length && lower(email)) found = tryFind('lower(email) = ?', lower(email));
  if (visit_type) {
    const sameType = found.filter((r) => r.visit_type === visit_type);
    if (sameType.length) found = sameType;
  }
  return found.length ? detail(found[0].id) : null;
}

/** Mark a booking as walked in on, against the visit that did it. */
function arrive(id, visitId) {
  const row = get('SELECT * FROM expected_visits WHERE id = ?', id);
  if (!row || row.status === 'arrived') return false;
  run("UPDATE expected_visits SET status = 'arrived', visit_id = ?, arrived_at = ? WHERE id = ?",
    visitId || null, nowISO(), id);
  return true;
}

/**
 * Yesterday and before, still marked expected: nobody came.
 *
 * Left as a status rather than deleted, so "we booked them in and they never
 * turned up" is answerable — which on a contractor site is a conversation
 * somebody has to have.
 */
function closeOldDays() {
  const n = run("UPDATE expected_visits SET status = 'no_show' WHERE status = 'expected' AND expected_on < ?",
    localtime.today()).changes;
  return n;
}

module.exports = { create, update, remove, detail, list, today, match, arrive, closeOldDays, newCode };
