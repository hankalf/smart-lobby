/*
 * Checking a US or Canadian phone number properly.
 *
 * A number typed at a kiosk is the only way the site can reach somebody after
 * they have gone, and it is what a returning visitor is recognised by. Ten
 * random digits satisfy "ten digits" and are worth nothing on either count, so
 * the rules the numbering plan actually imposes are applied instead.
 *
 * The North American Numbering Plan says, for a number NXX-NXX-XXXX:
 *   - the area code starts 2-9, and its second and third digits are not both 1
 *     (that pattern, N11, is reserved for 411, 911 and the like)
 *   - the exchange code also starts 2-9, and is not N11 either
 *   - 555-01xx is reserved for fiction, so it is refused outside of testing
 * Codes ending 00 are unassignable, and 37X/96X are held in reserve.
 *
 * Rather than ship a list of live area codes — which changes several times a
 * year and would quietly start rejecting real people the month it went stale —
 * this checks the structural rules, which do not change, and knows the handful
 * of codes that are permanently not valid. A number that passes is a number the
 * plan permits; whether it rings is something only a call can answer.
 *
 * Runs unchanged in the kiosk and in Node, so the server can apply the same
 * rules without trusting the tablet.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Phone = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Area codes with a nationwide meaning rather than a place.
  const NON_GEOGRAPHIC = new Set(['800', '833', '844', '855', '866', '877', '888', '900', '976']);

  const digitsOf = (value) => String(value == null ? '' : value).replace(/\D/g, '');

  /**
   * Reduce to the ten national digits, dropping a leading country code.
   * @returns {string} ten digits, or '' if it cannot be read as one
   */
  function national(value) {
    let d = digitsOf(value);
    if (d.length === 11 && d[0] === '1') d = d.slice(1);
    return d.length === 10 ? d : '';
  }

  /**
   * @param {string} value  as typed
   * @param {object} [opts]
   * @param {boolean} [opts.allowFictional]  permit 555-01xx, for test data
   * @returns {{ok: boolean, digits?: string, formatted?: string, e164?: string, error?: string, message?: string}}
   */
  function check(value, opts) {
    const allowFictional = !!(opts && opts.allowFictional);
    const raw = digitsOf(value);
    if (!raw) return { ok: false, error: 'empty', message: 'Please enter your phone number.' };

    const d = national(value);
    if (!d) {
      return {
        ok: false,
        error: raw.length < 10 ? 'too_short' : 'too_long',
        message: raw.length < 10
          ? `That is only ${raw.length} digit${raw.length === 1 ? '' : 's'} — a US number has 10.`
          : 'That is more than 10 digits. Please check the number.'
      };
    }

    const area = d.slice(0, 3);
    const exchange = d.slice(3, 6);

    if (area[0] === '0' || area[0] === '1') {
      return { ok: false, error: 'bad_area', message: 'An area code cannot start with 0 or 1.' };
    }
    if (area[1] === '1' && area[2] === '1') {
      return { ok: false, error: 'bad_area', message: `${area} is a service code, not an area code.` };
    }
    /*
     * Codes ending 00 are not assignable to a place — but 800 and its siblings
     * are the toll-free and premium codes, which are perfectly real and are
     * often a contractor's office line. 37X and 96X are held in reserve.
     */
    if ((area.endsWith('00') && !NON_GEOGRAPHIC.has(area))
        || (area[0] === '3' && area[1] === '7') || (area[0] === '9' && area[1] === '6')) {
      return { ok: false, error: 'unassigned_area', message: `${area} is not a valid area code.` };
    }
    if (exchange[0] === '0' || exchange[0] === '1') {
      return { ok: false, error: 'bad_exchange', message: 'The digits after the area code cannot start with 0 or 1.' };
    }
    if (exchange[1] === '1' && exchange[2] === '1') {
      return { ok: false, error: 'bad_exchange', message: 'That is not a usable phone number.' };
    }
    if (!allowFictional && exchange === '555' && d.slice(6, 8) === '01') {
      return { ok: false, error: 'fictional', message: 'That is a fictional number. Please enter a real one.' };
    }

    return {
      ok: true,
      digits: d,
      formatted: `(${area}) ${exchange}-${d.slice(6)}`,
      e164: `+1${d}`,
      toll_free: NON_GEOGRAPHIC.has(area)
    };
  }

  /** Format as it is typed, so the shape is obvious before the field is left. */
  function formatAsTyped(value) {
    const d = digitsOf(value).replace(/^1(?=\d)/, '').slice(0, 10);
    if (d.length <= 3) return d;
    if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  }

  return { check, national, formatAsTyped, digitsOf, NON_GEOGRAPHIC };
}));
