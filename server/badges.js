'use strict';
/**
 * Badge numbers. One visitor, one number, for the day printed on it.
 *
 * The number is worked out from the numbers already handed out that day rather
 * than from how many people have signed in. Those two only agree while nothing
 * is ever removed: delete one of today's visits and the count goes back a step,
 * so the next arrival is handed a badge someone on site is already wearing.
 */
const { get } = require('./db');
const settings = require('./settings');

/** `V260827-` — the part of a badge number shared by everyone there that day. */
function prefixFor(day) {
  const badge = settings.getSection('badge');
  return `${badge.badge_prefix || 'V'}${String(day).replace(/-/g, '').slice(2)}-`;
}

/**
 * The next badge number for `day` (YYYY-MM-DD), which is today's date at
 * sign-in and the day they arrived when a badge is reprinted later.
 *
 * Matching on the prefix by position rather than LIKE keeps a prefix that
 * happens to contain `%` or `_` from matching other days as well.
 */
function nextBadgeNo(day) {
  const prefix = prefixFor(day);
  const row = get(
    `SELECT MAX(CAST(substr(badge_no, ?) AS INTEGER)) AS n
       FROM visits WHERE substr(badge_no, 1, ?) = ?`,
    prefix.length + 1, prefix.length, prefix
  );
  const seq = (row && row.n ? row.n : 0) + 1;
  return `${prefix}${String(seq).padStart(3, '0')}`;
}

module.exports = { nextBadgeNo };
