'use strict';
/**
 * Deleting something without losing it.
 *
 * A visit carries the signatures on the documents that visitor read and the
 * record of the induction they sat through. Those are the things a site needs
 * when somebody asks, months later, whether a contractor was ever briefed —
 * and until now, deleting the visit destroyed them, silently and for good,
 * because the child rows cascade.
 *
 * So a delete copies the whole record here first: the row, its signatures and
 * its induction views, as one JSON payload. The original is then removed
 * exactly as before, which is what keeps every listing in the app honest —
 * a deleted visit is really gone from `visits`, so no query can show it by
 * forgetting a filter. Putting one back re-inserts it under its own id.
 *
 * The images are deliberately left on disk while a record is archived: a
 * restored visit with no signature image would be a hollow record. They are
 * removed when the archive entry is purged, which is also the moment the
 * files stop being referenced by anything.
 */
const { all, get, run, nowISO } = require('./db');
const files = require('./files');

/** Everything that hangs off a visit and would be lost with it. */
function visitPayload(visitId) {
  return {
    visit: get('SELECT * FROM visits WHERE id = ?', visitId),
    signatures: all('SELECT * FROM signatures WHERE visit_id = ?', visitId),
    slide_views: all('SELECT * FROM slide_views WHERE visit_id = ?', visitId)
  };
}

/** The image paths inside an archived payload, so a purge can clear them up. */
function filesIn(payload) {
  const out = [];
  const add = (p) => { if (p) out.push(p); };
  const visits = payload.visits || (payload.visit ? [payload] : []);
  for (const v of visits) {
    add(v.visit && v.visit.photo_path);
    (v.signatures || []).forEach((s) => add(s.signature_path));
    (v.slide_views || []).forEach((s) => add(s.signature_path));
  }
  if (payload.visitor) add(payload.visitor.photo_path);
  return out;
}

function store({ kind, recordId, label, summary, payload, user }) {
  run(`INSERT INTO archived_records (kind, record_id, label, summary, payload, deleted_by, deleted_at)
       VALUES (?,?,?,?,?,?,?)`,
    kind, recordId, label || null, JSON.stringify(summary || {}), JSON.stringify(payload),
    (user && (user.name || user.email)) || 'unknown', nowISO());
}

/** Archive one visit, then it is safe for the caller to delete it. */
function archiveVisit(visitId, user) {
  const payload = visitPayload(visitId);
  if (!payload.visit) return false;
  const who = get('SELECT full_name, company FROM visitors WHERE id = ?', payload.visit.visitor_id) || {};
  store({
    kind: 'visit',
    recordId: visitId,
    label: who.full_name || `Visit ${visitId}`,
    summary: {
      company: who.company || null,
      visit_type: payload.visit.visit_type,
      signed_in_at: payload.visit.signed_in_at,
      signed_out_at: payload.visit.signed_out_at,
      badge_no: payload.visit.badge_no,
      documents_signed: payload.signatures.length,
      induction: payload.slide_views.length > 0
    },
    payload,
    user
  });
  return true;
}

/** Archive a visitor and every visit they ever made. */
function archiveVisitor(visitorId, user) {
  const visitor = get('SELECT * FROM visitors WHERE id = ?', visitorId);
  if (!visitor) return false;
  const visits = all('SELECT id FROM visits WHERE visitor_id = ?', visitorId).map((v) => visitPayload(v.id));
  store({
    kind: 'visitor',
    recordId: visitorId,
    label: visitor.full_name || `Visitor ${visitorId}`,
    summary: {
      company: visitor.company || null,
      phone: visitor.phone || null,
      visits: visits.length,
      last_visit_at: visitor.last_visit_at
    },
    payload: { visitor, visits },
    user
  });
  return true;
}

const columnsOf = (table) => all(`PRAGMA table_info(${table})`).map((c) => c.name);

/**
 * Put a row back exactly as it was, keeping its id.
 *
 * Only the columns the table still has are written, so a record archived
 * before a later migration can still be restored into the newer schema.
 */
function reinsert(table, row) {
  if (!row) return;
  const cols = columnsOf(table).filter((c) => c in row);
  if (!cols.length) return;
  run(`INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    ...cols.map((c) => row[c]));
}

function restoreVisit(payload) {
  reinsert('visits', payload.visit);
  (payload.signatures || []).forEach((s) => reinsert('signatures', s));
  (payload.slide_views || []).forEach((s) => reinsert('slide_views', s));
}

/**
 * @returns {{ok: boolean, error?: string, kind?: string, label?: string}}
 */
function restore(archiveId) {
  const row = get('SELECT * FROM archived_records WHERE id = ?', archiveId);
  if (!row) return { ok: false, error: 'not_found' };
  let payload;
  try { payload = JSON.parse(row.payload); } catch { return { ok: false, error: 'unreadable' }; }

  if (row.kind === 'visit') {
    if (get('SELECT id FROM visits WHERE id = ?', row.record_id)) return { ok: false, error: 'already_present' };
    // A visit needs its visitor; one deleted since is restored alongside it.
    if (payload.visit && !get('SELECT id FROM visitors WHERE id = ?', payload.visit.visitor_id)) {
      const owner = get(`SELECT * FROM archived_records WHERE kind = 'visitor' AND record_id = ?`, payload.visit.visitor_id);
      if (!owner) return { ok: false, error: 'visitor_gone' };
      try { reinsert('visitors', JSON.parse(owner.payload).visitor); } catch { return { ok: false, error: 'unreadable' }; }
    }
    restoreVisit(payload);
  } else if (row.kind === 'visitor') {
    if (get('SELECT id FROM visitors WHERE id = ?', row.record_id)) return { ok: false, error: 'already_present' };
    reinsert('visitors', payload.visitor);
    (payload.visits || []).forEach(restoreVisit);
  } else {
    return { ok: false, error: 'unknown_kind' };
  }

  run('DELETE FROM archived_records WHERE id = ?', archiveId);
  return { ok: true, kind: row.kind, label: row.label };
}

/** Gone for good: the entry and the images only it still referred to. */
function purge(archiveId) {
  const row = get('SELECT * FROM archived_records WHERE id = ?', archiveId);
  if (!row) return { ok: false, error: 'not_found' };
  try {
    for (const path of filesIn(JSON.parse(row.payload))) {
      // Never remove a file a live record still points at.
      const live = get('SELECT id FROM visits WHERE photo_path = ?', path)
        || get('SELECT id FROM signatures WHERE signature_path = ?', path)
        || get('SELECT id FROM slide_views WHERE signature_path = ?', path)
        || get('SELECT id FROM visitors WHERE photo_path = ?', path);
      if (!live) files.removeFile(path);
    }
  } catch { /* an unreadable payload still gets its row removed */ }
  run('DELETE FROM archived_records WHERE id = ?', archiveId);
  return { ok: true, label: row.label };
}

/** Entries older than the retention window, cleared with their images. */
function purgeOlderThan(days) {
  if (!days) return 0;
  const cutoff = new Date(Date.now() - days * 864e5).toISOString();
  const old = all('SELECT id FROM archived_records WHERE deleted_at < ?', cutoff);
  old.forEach((r) => purge(r.id));
  return old.length;
}

function list({ limit = 100 } = {}) {
  return all(`SELECT id, kind, record_id, label, summary, deleted_by, deleted_at
              FROM archived_records ORDER BY deleted_at DESC LIMIT ?`, Math.min(Number(limit) || 100, 500))
    .map((r) => ({ ...r, summary: (() => { try { return JSON.parse(r.summary); } catch { return {}; } })() }));
}

module.exports = { archiveVisit, archiveVisitor, restore, purge, purgeOlderThan, list, filesIn };
