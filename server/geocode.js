'use strict';
/**
 * Turning "14 Riverside Way, Oakland" into a latitude and a longitude.
 *
 * Only ever used to place the site once, when somebody sets up the fence for
 * phone check-ins. Typing coordinates by hand means finding them somewhere
 * else first and transcribing two numbers where a digit in the wrong place
 * puts your gate in the next county — and "Use where I am now" only helps
 * somebody who is actually standing on the site.
 *
 * Three things worth knowing about how this is built:
 *
 * It runs on the server, not in the browser. The site sends
 * Content-Security-Policy with connect-src 'self', so a page here cannot call
 * an outside service at all — and would not be given the chance to, since that
 * would put every visitor's browser in touch with a third party.
 *
 * It asks OpenStreetMap's Nominatim, which needs no key and no account. Their
 * usage policy asks for an identifying User-Agent and no more than one request
 * a second, both of which are honoured below. Setting up a geofence is a
 * handful of lookups in the life of an install, so this sits far inside what
 * that policy is for.
 *
 * And it is entirely optional. A site that cannot reach the internet, or would
 * rather not send an address anywhere, types the coordinates in or stands on
 * site and presses the other button. Nothing depends on this working.
 */

/*
 * Overridable so a site can point at its own geocoder — an internal Nominatim,
 * or a paid service that speaks the same shape — and so the tests can answer
 * for it without reaching the internet.
 */
const ENDPOINT = process.env.GEOCODE_URL || 'https://nominatim.openstreetmap.org/search';

/*
 * Nominatim asks to be told who is calling, and refuses anonymous traffic. A
 * generic agent string is what gets an install blocked for somebody else's
 * behaviour, so this names the software.
 */
const AGENT = process.env.GEOCODE_AGENT
  || 'SmartLobby/1.0 (self-hosted visitor management; geofence setup)';

/*
 * One request a second, across the whole server. Their policy asks for it, and
 * a settings page where somebody is typing has no business making more.
 */
const MIN_GAP_MS = 1100;
let lastCall = 0;

/**
 * @param {string} query  what somebody typed into the address box
 * @returns {Promise<{results?: Array, error?: string, message?: string}>}
 */
async function lookup(query) {
  const q = String(query || '').trim();
  if (q.length < 3) {
    return { error: 'too_short', message: 'Type a few more characters of the address.' };
  }

  const wait = MIN_GAP_MS - (Date.now() - lastCall);
  if (wait > 0) await new Promise((done) => setTimeout(done, wait));
  lastCall = Date.now();

  const url = `${ENDPOINT}?format=jsonv2&limit=6&addressdetails=0&q=${encodeURIComponent(q)}`;

  let res;
  try {
    /*
     * Timed out by hand. A server with no route out does not refuse, it hangs,
     * and a settings page spinning forever is the least useful answer to give
     * somebody who has another two ways of doing this.
     */
    const bail = AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined;
    res = await fetch(url, { headers: { 'User-Agent': AGENT, Accept: 'application/json' }, signal: bail });
  } catch (err) {
    return {
      error: 'unreachable',
      message: 'Could not reach the address lookup — this server may have no way out to the internet. '
        + 'Type the coordinates in, or press “Use where I am now” standing on the site.'
    };
  }

  if (!res.ok) {
    return {
      error: 'lookup_failed',
      message: `The address lookup answered ${res.status}. Try again in a moment, or type the coordinates in.`
    };
  }

  let rows;
  try { rows = await res.json(); } catch { rows = null; }
  if (!Array.isArray(rows)) {
    return { error: 'lookup_failed', message: 'The address lookup sent something unreadable back.' };
  }

  const results = rows.map((r) => ({
    label: String(r.display_name || '').slice(0, 200),
    lat: Number(r.lat),
    lng: Number(r.lon)
  })).filter((r) => r.label && Number.isFinite(r.lat) && Number.isFinite(r.lng));

  if (!results.length) {
    return {
      error: 'not_found',
      message: 'Nothing found for that. Try the street and town without a unit number, '
        + 'or drop a pin some other way and type the coordinates in.'
    };
  }
  return { results };
}

module.exports = { lookup };
