'use strict';
/**
 * Changing a visitor type's key, and moving everything that was filed under it.
 *
 * A visitor type has a key and a label. The label is what everybody reads and
 * can be changed whenever; the key is an identifier, derived from the label
 * once when the type is created and then left alone, because every visit ever
 * recorded is stored against it.
 *
 * That is the right design and it has one sharp edge: rename Interview to
 * UniFirst and the key stays `interview` for ever. Nothing breaks — the visits
 * and the settings agree with each other — but from then on the data says one
 * thing and the screen says another. Exports, the reports' type filter and
 * every per-type setting are filed under a name the site stopped using, and
 * the next person to read any of it has to be told why.
 *
 * So the key can be changed deliberately, which means moving everything filed
 * under it at the same time. All of it or none of it: a rename that moved the
 * visits but not the notification routing would leave a type that posts
 * nowhere, and would do it silently.
 *
 * Deliberately not automatic. A label is edited casually — a typo, a capital
 * letter, a change of mind — and rewriting the identity of every historical
 * visit each time somebody fixes a spelling is not a thing software should do
 * on its own.
 */
const { db, run, get, all } = require('./db');
const settings = require('./settings');

/** The same rule the dashboard uses when it derives a key from a label. */
function keyFrom(label) {
  return String(label || '').toLowerCase().trim()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

/*
 * Words the kiosk's own routing uses, which a type may not take — the same
 * list settings.js refuses on the way in.
 */
const RESERVED = ['signin', 'signout', 'delivery', 'unlock', 'menu', 'idle'];

/**
 * Move one visitor type from one key to another.
 *
 * @param {string} from  the key as stored
 * @param {string} to    the key it should have
 * @returns {{ok: boolean, error?: string, message?: string, moved?: object}}
 */
function rekey(from, to) {
  const oldKey = String(from || '').trim();
  const newKey = keyFrom(to);

  const types = settings.getAll().types || [];
  const mine = types.find((t) => t && t.key === oldKey);
  if (!mine) return { ok: false, error: 'not_found', message: 'There is no visitor type with that key.' };
  if (!newKey) {
    return { ok: false, error: 'bad_key', message: 'That name has no letters or numbers in it to make a key from.' };
  }
  if (newKey === oldKey) {
    return { ok: false, error: 'unchanged', message: 'That is already its key.' };
  }
  if (RESERVED.includes(newKey)) {
    return { ok: false, error: 'reserved', message: `“${newKey}” is a word the kiosk uses for something else.` };
  }
  if (types.some((t) => t && t.key === newKey)) {
    return { ok: false, error: 'taken', message: `Another visitor type already uses the key “${newKey}”.` };
  }

  /*
   * Every place a type key is stored. Kept as one list rather than spread
   * through the function so that adding a per-type setting later has an
   * obvious place to be added to — a rename that misses one is the failure
   * this whole file exists to avoid.
   */
  const sectionsKeyedByType = [
    ['details', (s) => s],                       // which fields each type is asked for
    ['flow', (s) => s],                          // the order of the sign-in steps
    ['wording', (s) => s],                       // what each field is called
    ['notify', (s) => s.types_notified],         // whether a type is announced
    ['notify', (s) => s.type_routing],           // who else hears, and its own channel
    ['compliance', (s) => s.required]            // which certificates it must have
  ];

  const moved = { visits: 0, expected: 0, archived: 0, settings: [] };

  /*
   * One transaction. Half a rename is worse than none: a type whose visits
   * moved but whose notification routing did not would quietly stop posting,
   * and nothing would say why.
   */
  db.exec('BEGIN');
  try {
    moved.visits = run('UPDATE visits SET visit_type = ? WHERE visit_type = ?', newKey, oldKey).changes;
    moved.expected = run('UPDATE expected_visits SET visit_type = ? WHERE visit_type = ?', newKey, oldKey).changes;

    /*
     * Deleted visits too, which are kept in full so they can be restored.
     * Skipping them would mean a record restored next month arrived under a
     * key nothing recognises any more — filed correctly right up until somebody
     * needed it. The payload is the row as JSON, so the type is replaced in
     * place rather than the whole shape being rebuilt here.
     */
    for (const row of all("SELECT id, payload, summary FROM archived_records WHERE kind = 'visit'")) {
      let payload;
      let summary;
      try {
        payload = JSON.parse(row.payload);
        summary = row.summary ? JSON.parse(row.summary) : null;
      } catch { continue; }          // unreadable already; leave it as it is
      const inPayload = payload && payload.visit && payload.visit.visit_type === oldKey;
      const inSummary = summary && summary.visit_type === oldKey;
      if (!inPayload && !inSummary) continue;
      if (inPayload) payload.visit.visit_type = newKey;
      if (inSummary) summary.visit_type = newKey;
      run('UPDATE archived_records SET payload = ?, summary = ? WHERE id = ?',
        JSON.stringify(payload), summary ? JSON.stringify(summary) : row.summary, row.id);
      moved.archived = (moved.archived || 0) + 1;
    }

    for (const [name, pick] of sectionsKeyedByType) {
      const section = settings.getSection(name);
      const map = pick(section);
      if (!map || typeof map !== 'object' || !(oldKey in map)) continue;
      map[newKey] = map[oldKey];
      delete map[oldKey];
      /*
       * Written whole. setSection deep-merges, so simply naming the new key
       * would add it and leave the old one sitting alongside — two entries for
       * one type, one of them wrong.
       */
      writeWhole(name, section);
      moved.settings.push(pick === undefined ? name : `${name}`);
    }

    /* The per-event card designs, which nest their overrides a level deeper. */
    const notify = settings.getSection('notify');
    let cardsMoved = false;
    for (const design of [notify.card, ...Object.values(notify.cards || {})]) {
      if (design && design.by_type && oldKey in design.by_type) {
        design.by_type[newKey] = design.by_type[oldKey];
        delete design.by_type[oldKey];
        cardsMoved = true;
      }
    }
    if (cardsMoved) {
      writeWhole('notify', notify);
      moved.settings.push('notify.cards');
    }

    /* And the type itself, last, so a failure above leaves it findable. */
    const nextTypes = (settings.getAll().types || [])
      .map((t) => (t && t.key === oldKey ? { ...t, key: newKey } : t));
    writeWhole('types', nextTypes);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return { ok: false, error: 'failed', message: `Nothing was changed — ${err.message}` };
  }

  settings.bumpConfigRev();
  return {
    ok: true,
    from: oldKey,
    to: newKey,
    moved,
    message: `Moved ${moved.visits} visit(s) and ${moved.expected} booking(s) from “${oldKey}” to “${newKey}”.`
  };
}

/**
 * Replace a settings section outright.
 *
 * setSection merges, which is what every other caller wants and exactly what
 * this one must not have: renaming a key by merging leaves the old one behind.
 */
function writeWhole(name, value) {
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    name, JSON.stringify(value));
}

/** Whether a type's key still matches the name it is now called. */
const drifted = (type) => !!(type && type.key && type.label && keyFrom(type.label) !== type.key);

module.exports = { rekey, keyFrom, drifted };
