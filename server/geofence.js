'use strict';
/**
 * How far a phone check-in is from the site.
 *
 * What this is, said plainly because it will be asked: a browser reports the
 * coordinates it chooses to report. A phone can be told to lie, and a laptop
 * with developer tools open can be told to lie in about fifteen seconds. This
 * stops somebody signing in from the car park on the way past, or from bed on a
 * Monday morning — the two things that actually happen. It does not stop
 * somebody who has decided to cheat and knows how, and nobody should be told
 * that it does.
 *
 * It is also worth knowing how wrong an honest phone can be. A fix indoors, in
 * a steel-framed building or among stacked containers, is regularly a hundred
 * metres out and occasionally much worse; a phone on wifi with no GPS lock may
 * report the middle of the town. That is why the default radius is generous and
 * why "no fix at all" is a separate decision from "a fix that is too far away".
 */
const settings = require('./settings');

const EARTH_M = 6371000;
const rad = (deg) => (deg * Math.PI) / 180;

/**
 * Metres between two points, by the haversine formula.
 *
 * Accurate to a fraction of a percent at the distances that matter here, and it
 * needs no projection or dependency — over a few hundred metres the earth is
 * near enough a sphere.
 */
function metresBetween(aLat, aLng, bLat, bLng) {
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h))));
}

/*
 * Zero is not a location. It is a real coordinate — a point in the Gulf of
 * Guinea, several hundred miles off Ghana — and it is also what an empty box
 * turns into on the way through a form, which is how a fence once ended up
 * centred there and refused every visitor on earth for being nine thousand
 * kilometres away. The dashboard no longer sends zeros for empty fields, and
 * this refuses to believe them if anything ever does again.
 *
 * The cost of the guard is that a site genuinely on the equator or on the
 * prime meridian must nudge a coordinate by a ten-thousandth of a degree —
 * eleven metres, inside any sane radius. No site is on both.
 */
const placed = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n !== 0;
};

const configured = () => {
  const g = settings.getSection('geofence');
  return !!(g.enabled && placed(g.lat) && placed(g.lng));
};

/**
 * Is this phone close enough to sign in?
 *
 * @param {object} where  { lat, lng, accuracy } as the browser reported it
 * @returns {{ok: boolean, reason?: string, message?: string, metres?: number}}
 */
function check(where) {
  const g = settings.getSection('geofence');
  if (!configured()) return { ok: true, reason: 'not_configured' };

  /*
   * Read carefully, because the obvious way is wrong: Number(null) is 0, not
   * NaN, so `Number(where && where.lat)` on a missing fix produces the
   * coordinates 0,0 — a point in the Gulf of Guinea — and every visitor whose
   * phone declined is refused for being twelve thousand kilometres away
   * instead of for having no location at all.
   */
  const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
  const lat = where ? num(where.lat) : NaN;
  const lng = where ? num(where.lng) : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    /*
     * No fix at all is its own case. A phone with location switched off, or a
     * visitor who tapped Deny, is not somebody caught cheating — so a site can
     * choose to let them through and let reception see it, rather than leaving
     * a real visitor stuck at the gate with a phone that will not co-operate.
     */
    if (g.require_location === false) return { ok: true, reason: 'no_location_allowed' };
    return {
      ok: false,
      reason: 'no_location',
      message: 'This site needs your location to sign in from a phone. Allow location for this page '
        + 'and try again, or sign in on the tablet at the entrance.'
    };
  }

  const radius = Math.max(25, Number(g.radius_m) || 250);
  const metres = metresBetween(Number(g.lat), Number(g.lng), lat, lng);

  /*
   * The phone's own idea of how wrong it might be is added to the allowance
   * rather than ignored. A visitor standing in the yard whose phone says
   * "somewhere within 200 metres of here" is inside the fence as far as anyone
   * can tell, and refusing them would be the system being confidently wrong.
   * Capped, so a fix accurate to "somewhere in this county" cannot wave
   * anything through.
   */
  const slack = Math.min(500, Math.max(0, num(where.accuracy) || 0));

  if (metres <= radius + slack) return { ok: true, metres, reason: 'inside' };
  return {
    ok: false,
    reason: 'too_far',
    metres,
    message: `You appear to be about ${metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${metres} m`} `
      + 'from the site, so this check-in was not accepted. Sign in on the tablet at the entrance, '
      + 'or see reception.'
  };
}

/** What the kiosk needs to know before it asks a phone for its location. */
function publicSettings() {
  const g = settings.getSection('geofence');
  return { enabled: configured(), radius_m: Math.max(25, Number(g.radius_m) || 250),
    require_location: g.require_location !== false };
}

module.exports = { check, configured, metresBetween, publicSettings };
