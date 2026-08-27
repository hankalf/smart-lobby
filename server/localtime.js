'use strict';
/**
 * The site's day, rather than the server's.
 *
 * Times are stored as UTC, but nobody at a reception desk means UTC. "Today"
 * is the day it is at the gate, and the date printed on a badge is the date
 * the visitor would write on a form. A site west of UTC signing someone in at
 * 7pm was already into the next UTC day, and a site east of it opening at 8am
 * is still in the previous one — both were being handed the wrong date.
 *
 * The zone comes from Branding, so a site sets it once and everything that
 * counts a day agrees on where that day starts and ends.
 */
const settings = require('./settings');

/** Falls back to UTC rather than throwing, so a bad zone cannot stop a sign-in. */
function zone() {
  const tz = settings.getSection('org').timezone;
  return settings.isValidTimeZone(tz) ? tz : 'UTC';
}

/*
 * Building a DateTimeFormat costs far more than using one, and the stats
 * charts convert every visit ever recorded, so keep them by zone. There is one
 * zone in practice, and only ever a handful even if it is changed.
 */
const formatters = new Map();
function formatter(kind, options) {
  const key = `${kind}:${zone()}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(options.locale, { ...options.opts, timeZone: zone() });
    formatters.set(key, f);
  }
  return f;
}

/**
 * How far ahead of UTC the zone is at that instant, in milliseconds. Read off
 * the wall clock there rather than a table, so DST is whatever it actually was
 * on the day in question.
 */
function offsetMs(date, tz) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(date)) parts[p.type] = p.value;

  // Some zones render midnight as hour 24.
  const hour = parts.hour === '24' ? 0 : Number(parts.hour);
  const asIfUTC = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    hour, Number(parts.minute), Number(parts.second));
  return asIfUTC - date.getTime();
}

/** The local calendar day of an instant, as `YYYY-MM-DD`. */
function dayOf(when = new Date()) {
  const date = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  // en-CA formats as YYYY-MM-DD, which is the shape stored and compared everywhere.
  return formatter('day', {
    locale: 'en-CA', opts: { year: 'numeric', month: '2-digit', day: '2-digit' }
  }).format(date);
}

/** Today at the site. */
const today = () => dayOf(new Date());

/** The local hour of an instant, as `HH`, for the busiest-hour chart. */
function hourOf(when) {
  const date = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(date.getTime())) return null;
  const hour = formatter('hour', { locale: 'en-GB', opts: { hour12: false, hour: '2-digit' } }).format(date);
  // Midnight comes back as 24 in some zones; the chart runs 00–23.
  return hour === '24' ? '00' : String(hour).padStart(2, '0');
}

/**
 * The half-open span of UTC instants making up a local day, for comparing
 * against stored timestamps: `signed_in_at >= start AND signed_in_at < end`.
 *
 * Local midnight is found by guessing at UTC midnight and correcting by the
 * offset, then checking the offset again at the answer — on the two days a
 * year the clocks move, the guess and the answer can sit on either side of
 * the change.
 */
function dayRange(day) {
  const tz = zone();
  const guess = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(guess.getTime())) throw new TypeError(`not a date: ${day}`);

  const midnight = (target) => {
    const first = target.getTime() - offsetMs(target, tz);
    const second = target.getTime() - offsetMs(new Date(first), tz);
    return new Date(second);
  };

  const start = midnight(guess);
  const end = midnight(new Date(guess.getTime() + 864e5));
  return { start: start.toISOString(), end: end.toISOString() };
}

module.exports = { zone, dayOf, today, hourOf, dayRange };
