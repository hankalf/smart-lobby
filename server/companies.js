'use strict';
/**
 * The firms people come from.
 *
 * Company was free text typed at a kiosk by whoever happened to be standing
 * there, so "Vaccums", "Vacuums Ltd" and "vacuums" counted as three different
 * firms in every report, and a name typed wrong the first time stayed wrong
 * for ever. A company is a record now.
 *
 * Two things follow from that, and they are the whole point:
 *
 *   - Renaming one fixes it everywhere, including on visits already recorded.
 *   - Two that turn out to be the same firm can be merged into one.
 *
 * `visitors.company` is still the name to print and is kept in step with the
 * record — everything that reads it goes on working, and `company_id` is what
 * decides two people are from the same firm.
 */
const { run, get, all, nowISO } = require('./db');

/** Same firm or not: case and surrounding space do not make a new company. */
const key = (name) => String(name || '').trim();

/**
 * The company for a typed name, creating it the first time it is seen.
 *
 * @returns {object|null} the company row, or null for an empty name
 */
function resolve(name) {
  const clean = key(name);
  if (!clean) return null;
  const found = get('SELECT * FROM companies WHERE lower(name) = lower(?)', clean);
  if (found) return found;
  run('INSERT INTO companies (name, created_at) VALUES (?,?)', clean, nowISO());
  return get('SELECT * FROM companies WHERE lower(name) = lower(?)', clean);
}

/** Every company, with how many people and visits are behind it. */
const list = () => all(`
  SELECT c.*,
         (SELECT COUNT(*) FROM visitors p WHERE p.company_id = c.id) AS people,
         (SELECT COUNT(*) FROM visits v JOIN visitors p ON p.id = v.visitor_id
           WHERE p.company_id = c.id) AS visits,
         (SELECT MAX(v.signed_in_at) FROM visits v JOIN visitors p ON p.id = v.visitor_id
           WHERE p.company_id = c.id) AS last_visit_at
    FROM companies c ORDER BY lower(c.name)`);

const detail = (id) => {
  const c = get('SELECT * FROM companies WHERE id = ?', id);
  if (!c) return null;
  c.people = all(`SELECT id, full_name, phone, email, visit_count, last_visit_at, blocked
                  FROM visitors WHERE company_id = ? ORDER BY lower(full_name)`, id);
  return c;
};

/**
 * Correct a company's name.
 *
 * The printed name on every visitor from that firm moves with it, which is
 * what makes this a correction rather than a second spelling.
 */
function rename(id, name) {
  const clean = key(name);
  if (!clean) throw new Error('A company needs a name.');
  const clash = get('SELECT id FROM companies WHERE lower(name) = lower(?) AND id != ?', clean, id);
  if (clash) throw new Error(`There is already a company called ${clean}. Merge them instead.`);
  run('UPDATE companies SET name = ? WHERE id = ?', clean, id);
  run('UPDATE visitors SET company = ? WHERE company_id = ?', clean, id);
  return get('SELECT * FROM companies WHERE id = ?', id);
}

/**
 * Fold one company into another — the misspelling into the correct one.
 *
 * Everybody moves across, the printed name on them is corrected, and the one
 * left behind is removed. Nothing is lost: a visitor's history is theirs, not
 * the company's, so it travels with them.
 */
function merge(fromId, intoId) {
  if (Number(fromId) === Number(intoId)) throw new Error('That is the same company.');
  const from = get('SELECT * FROM companies WHERE id = ?', fromId);
  const into = get('SELECT * FROM companies WHERE id = ?', intoId);
  if (!from || !into) throw new Error('One of those companies no longer exists.');

  const moved = run('UPDATE visitors SET company_id = ?, company = ? WHERE company_id = ?',
    into.id, into.name, from.id).changes;
  // Notes are worth keeping; two sets of them are worth keeping as two.
  if (from.notes && String(from.notes).trim()) {
    const joined = [into.notes, `From ${from.name}: ${from.notes}`].filter(Boolean).join('\n');
    run('UPDATE companies SET notes = ? WHERE id = ?', joined, into.id);
  }
  // A firm barred under either name stays barred under the one that remains.
  if (from.blocked) run('UPDATE companies SET blocked = 1 WHERE id = ?', into.id);
  run('DELETE FROM companies WHERE id = ?', from.id);
  return { moved, into: get('SELECT * FROM companies WHERE id = ?', into.id), from: from.name };
}

/**
 * Names close enough to be worth a second look.
 *
 * Deliberately suggestions rather than anything automatic: only a person
 * knows whether two similar names are one firm or two with similar names.
 */
function duplicates() {
  const rows = all('SELECT id, name FROM companies ORDER BY lower(name)');
  const squashed = (s) => String(s).toLowerCase()
    .replace(/\b(ltd|limited|llc|inc|plc|gmbh|co|company|group|holdings|services|uk|usa)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
  const pairs = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = squashed(rows[i].name);
      const b = squashed(rows[j].name);
      if (!a || !b) continue;
      if (a === b || near(a, b)) pairs.push({ a: rows[i], b: rows[j] });
    }
  }
  return pairs.slice(0, 40);
}

/** Within one edit of each other — a transposition, a dropped or doubled letter. */
function near(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length < 4) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

module.exports = { resolve, list, detail, rename, merge, duplicates };
