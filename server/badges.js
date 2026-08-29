'use strict';
/**
 * Badge numbers. One visitor, one number, for the day printed on it.
 *
 * The number is worked out from the numbers already handed out that day rather
 * than from how many people have signed in. Those two only agree while nothing
 * is ever removed: delete one of today's visits and the count goes back a step,
 * so the next arrival is handed a badge someone on site is already wearing.
 *
 * What the number looks like is a site's own business — some print a plain
 * running number, some want the date in it, some want contractors on their own
 * series so a glance at a badge says which. So the shape is a format string
 * rather than something baked in here.
 */
const { get } = require('./db');
const settings = require('./settings');

/**
 * The words a badge format can use.
 *
 * `{seq}` is the counter and is what makes a number unique; everything else is
 * decoration. Each is given the day being numbered and the visit type, so a
 * token can be added here and it is immediately usable, previewable and
 * printable with no second list to keep in step.
 */
const TOKENS = [
  { id: 'prefix', describe: 'The prefix below', value: (ctx) => ctx.prefix },
  { id: 'yyyy', describe: 'Year, four digits', value: (ctx) => ctx.day.slice(0, 4) },
  { id: 'yy', describe: 'Year, two digits', value: (ctx) => ctx.day.slice(2, 4) },
  { id: 'mm', describe: 'Month', value: (ctx) => ctx.day.slice(5, 7) },
  { id: 'dd', describe: 'Day of the month', value: (ctx) => ctx.day.slice(8, 10) },
  { id: 'type', describe: 'First letter of the visitor type — C for contractor', value: (ctx) => ctx.typeLetter },
  { id: 'TYPE', describe: 'The visitor type in full, in capitals', value: (ctx) => ctx.typeName },
  { id: 'seq', describe: 'The counter, which every format needs', value: () => null }
];

const DEFAULT_FORMAT = '{prefix}{yy}{mm}{dd}-{seq}';
const MIN_DIGITS = 1;
const MAX_DIGITS = 8;

/** An unset or unreadable width falls back to 3; a real one is clamped. */
function clampDigits(n) {
  const width = Number(n);
  if (!Number.isFinite(width) || width === 0) return 3;
  return Math.min(MAX_DIGITS, Math.max(MIN_DIGITS, Math.floor(width)));
}

/**
 * Split a format into the fixed text either side of the counter.
 *
 * Everything before `{seq}` is what a badge from this day and type starts
 * with, which is how the last number issued is found again without reading
 * every visit ever recorded. A format with no `{seq}` in it would hand every
 * visitor the same number, so one is appended rather than allowing that.
 */
function renderFormat(day, visitType, cfg) {
  const format = String(cfg.badge_format || DEFAULT_FORMAT).includes('{seq}')
    ? String(cfg.badge_format || DEFAULT_FORMAT)
    : `${cfg.badge_format || ''}{seq}`;

  const type = String(visitType || '');
  const ctx = {
    day: String(day),
    prefix: cfg.badge_prefix || '',
    typeLetter: type ? type.charAt(0).toUpperCase() : '',
    typeName: type.toUpperCase()
  };

  const fill = (text) => text.replace(/\{(\w+)\}/g, (whole, name) => {
    const token = TOKENS.find((t) => t.id === name);
    if (!token || name === 'seq') return whole;
    const value = token.value(ctx);
    return value == null ? '' : String(value);
  });

  const at = format.indexOf('{seq}');
  return {
    prefix: fill(format.slice(0, at)),
    // A second {seq} would be filled with the same number; only the first counts.
    suffix: fill(format.slice(at + '{seq}'.length)).replace(/\{seq\}/g, ''),
    digits: clampDigits(cfg.badge_seq_digits)
  };
}

/** What a badge number would look like, without issuing one. */
function sampleBadgeNo(day, visitType, cfg, seq = 1) {
  const { prefix, suffix, digits } = renderFormat(day, visitType, cfg || settings.getSection('badge'));
  return `${prefix}${String(seq).padStart(digits, '0')}${suffix}`;
}

/**
 * The next badge number for `day` (YYYY-MM-DD), which is today's date at
 * sign-in and the day they arrived when a badge is reprinted later.
 *
 * Matching on the prefix by position rather than LIKE keeps a prefix that
 * happens to contain `%` or `_` from matching other days as well. The counter
 * is read out of the fixed number of digits that follow it, so text after the
 * counter — a suffix, a site code — does not get swept into the number.
 */
function nextBadgeNo(day, visitType) {
  const cfg = settings.getSection('badge');
  const { prefix, suffix, digits } = renderFormat(day, visitType, cfg);
  const row = get(
    `SELECT MAX(CAST(substr(badge_no, ?, ?) AS INTEGER)) AS n
       FROM visits WHERE substr(badge_no, 1, ?) = ?`,
    prefix.length + 1, digits, prefix.length, prefix
  );
  const seq = (row && row.n ? row.n : 0) + 1;
  return `${prefix}${String(seq).padStart(digits, '0')}${suffix}`;
}

module.exports = {
  nextBadgeNo, sampleBadgeNo, renderFormat,
  DEFAULT_FORMAT, MIN_DIGITS, MAX_DIGITS,
  TOKENS: TOKENS.map(({ id, describe }) => ({ id, describe }))
};
