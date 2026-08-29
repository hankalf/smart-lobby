/*
 * Reading a US or Canadian driver's licence.
 *
 * The barcode on the back is PDF417 holding an AAMVA record: a header naming
 * the issuing jurisdiction, then subfiles of three-letter elements, one per
 * line. Only three of them are wanted here — who it is, the licence number,
 * and which state issued it — and nothing else is kept, so a date of birth or
 * an address scanned off the card is dropped on the floor rather than stored.
 *
 * Written to run unchanged in the kiosk and in Node, so the parsing can be
 * tested against real licence payloads without a browser.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AAMVA = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /*
   * The header carries the issuer's IIN, not its postal code, and a licence
   * from a state that spells its own name differently in the DAJ element is
   * still that state. The number is the reliable identifier, so it is what is
   * mapped. Canadian provinces are here because trucks cross the border.
   */
  const IIN = {
    636033: 'AL', 636059: 'AK', 604427: 'AZ', 636021: 'AR', 636014: 'CA', 636020: 'CO',
    636006: 'CT', 636011: 'DE', 636043: 'DC', 636010: 'FL', 636055: 'GA', 636047: 'HI',
    636050: 'ID', 636035: 'IL', 636037: 'IN', 636018: 'IA', 636022: 'KS', 636046: 'KY',
    636007: 'LA', 636041: 'ME', 636003: 'MD', 636002: 'MA', 636032: 'MI', 636038: 'MN',
    636051: 'MS', 636030: 'MO', 636008: 'MT', 636054: 'NE', 636049: 'NV', 636039: 'NH',
    636036: 'NJ', 636009: 'NM', 636001: 'NY', 636004: 'NC', 636034: 'ND', 636023: 'OH',
    636058: 'OK', 636029: 'OR', 636025: 'PA', 636052: 'RI', 636005: 'SC', 636042: 'SD',
    636053: 'TN', 636015: 'TX', 636040: 'UT', 636024: 'VT', 636000: 'VA', 636045: 'WA',
    636061: 'WV', 636031: 'WI', 636060: 'WY',
    636028: 'BC', 636017: 'MB', 636048: 'NB', 636019: 'NL', 636013: 'NS', 636012: 'ON',
    636044: 'PE', 636026: 'QC', 636027: 'SK'
  };

  const STATES = new Set(Object.values(IIN).concat(['PR', 'VI', 'GU', 'AS', 'MP', 'AB', 'NT', 'NU', 'YT']));

  // The elements this reads. Everything else on the card is ignored.
  const WANTED = ['DAQ', 'DCS', 'DAC', 'DAD', 'DAA', 'DAJ', 'DCT', 'DAB'];

  /** Title case, so a card shouting DOE, JOHN is not printed on a badge that way. */
  function titleCase(s) {
    return String(s || '').toLowerCase()
      .replace(/(^|[\s'\-])([a-z])/g, (m, sep, ch) => sep + ch.toUpperCase());
  }

  /*
   * AAMVA separates records with control characters (0x1E, 0x1C, 0x0D), and
   * fields are padded with spaces. Both go; the value itself is left alone —
   * a licence number is recorded exactly as it is issued, hyphens included.
   */
  const clean = (s) => String(s == null ? '' : s).replace(/[\x00-\x1f]/g, '').trim();

  /**
   * @param {string} raw the decoded barcode text
   * @returns {{ok: boolean, name?: string, number?: string, state?: string, error?: string}}
   */
  function parse(raw) {
    const text = String(raw || '');
    if (!text) return { ok: false, error: 'empty' };
    // A compliant record starts with @, a line feed, a record separator and
    // "ANSI " — but cards in the wild vary, so the marker is what is looked for.
    if (!/ANSI |AAMVA/i.test(text) && !/\bDAQ/.test(text)) return { ok: false, error: 'not_a_licence' };

    /*
     * Most elements sit at the start of their own line, which is the reading to
     * trust. The first one does not: cards append it to the header line, after
     * the subfile designator — "...ZT03290015DLDAQ12345678" — so anything still
     * missing is looked for anywhere in the text as well. That second pass runs
     * only for absent codes, so a value that merely contains the letters (an
     * address on Daquiri Street) cannot displace a real field.
     */
    const fields = {};
    for (const line of text.split(/[\r\n]+/)) {
      const m = /^([A-Z]{3})(.*)$/.exec(clean(line));
      if (m && !(m[1] in fields)) fields[m[1]] = clean(m[2]);
    }
    for (const code of WANTED) {
      if (code in fields) continue;
      const m = new RegExp(code + '([^\\r\\n]*)').exec(text);
      if (m) fields[code] = clean(m[1]);
    }

    /*
     * Older cards (AAMVA 2000 and some 2003 issues) put the whole name in DAA
     * as LAST,FIRST,MIDDLE. Newer ones split it across DCS/DAC/DAD. Both are
     * read, the split one preferred.
     */
    let first = fields.DAC || fields.DCT || '';
    let last = fields.DCS || fields.DAB || '';
    if ((!first || !last) && fields.DAA) {
      const parts = fields.DAA.split(/[,$]/).map((p) => p.trim()).filter(Boolean);
      if (parts.length >= 2) { last = last || parts[0]; first = first || parts[1]; }
      else if (parts.length === 1) { last = last || parts[0]; }
    }
    // A truncated field is marked with these; they are not part of the name.
    const drop = (s) => String(s || '').replace(/\b(NONE|UNAVL|UNAVAIL)\b/gi, '').trim();
    first = drop(first); last = drop(last);

    const name = `${titleCase(first)} ${titleCase(last)}`.replace(/\s+/g, ' ').trim();
    const number = (fields.DAQ || '').toUpperCase();

    /*
     * The issuing state: the header's IIN is the most reliable, since DAJ is
     * absent on some cards and occasionally holds a full state name.
     */
    let state = '';
    const iin = /\b(\d{6})\b/.exec(text.slice(0, 40));
    if (iin && IIN[Number(iin[1])]) state = IIN[Number(iin[1])];
    if (!state) {
      const daj = (fields.DAJ || '').toUpperCase();
      if (STATES.has(daj)) state = daj;
    }

    if (!number) return { ok: false, error: 'no_licence_number' };
    if (!name) return { ok: false, error: 'no_name' };
    return { ok: true, name, number, state };
  }

  return { parse, titleCase, IIN };
}));
