'use strict';
/**
 * The sign that goes on the wall at a gate: scan this, sign in on your phone.
 *
 * A standalone page rather than a printable view of the dashboard, for the
 * same reason the site report is one — the admin stylesheet is built for a
 * screen with a menu down one side, and bending it into A4 with @media print
 * is how printed pages end up with half a heading on the next sheet.
 *
 * Everything is inline, including the QR itself as an SVG. A sign that fetches
 * anything is a sign that comes out blank when somebody prints the file they
 * saved last week on a laptop that is not on the wifi — and a blank sign at a
 * gate teaches visitors that the system does not work.
 *
 * Sized for A4 and US Letter both, which is why nothing is positioned against
 * a page edge: the shared area of the two is what the layout lives inside, so
 * one file prints correctly on either without asking anybody which they have.
 */

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * @param {object} opts
 * @param {string} opts.url        the /go/<code> address the sign points at
 * @param {string} opts.qrSvg      that address as an SVG QR code, already rendered
 * @param {string} opts.deviceName which entrance this is
 * @param {string} [opts.location] where that is, if the device says
 * @param {string} [opts.orgName]  the site's name, for the top of the sign
 * @param {string} [opts.logoPath] the site's logo, as a data URI
 * @param {string[]} [opts.cards]  what this device offers — "Sign in", "Delivery"
 * @param {boolean} [opts.geofenced] whether a location is required
 */
function render(opts = {}) {
  const {
    url = '', qrSvg = '', deviceName = '', location = '', orgName = '',
    logoPath = '', cards = [], geofenced = false
  } = opts;

  /*
   * What the visitor can do here, named from the device's own card list. A
   * sign that says "sign in" at a barrier that only takes deliveries sends
   * people to the wrong place, and the card list is the one thing that
   * actually knows.
   */
  const what = cards.length
    ? cards.length === 1 ? cards[0] : `${cards.slice(0, -1).join(', ')} or ${cards[cards.length - 1]}`
    : 'Sign in';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(deviceName || 'Check in')} — sign to print</title>
<style>
  @page { size: auto; margin: 14mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0; font-family: "Liberation Sans", Arial, Helvetica, sans-serif; color: #111;
    display: flex; align-items: center; justify-content: center; min-height: 100vh;
  }
  .sign { width: 100%; max-width: 170mm; text-align: center; }
  .logo { max-height: 20mm; max-width: 70mm; margin-bottom: 6mm; }
  .org { font-size: 5mm; letter-spacing: .12em; text-transform: uppercase; color: #444; margin: 0 0 3mm; }
  h1 { font-size: 15mm; line-height: 1.05; margin: 0 0 4mm; }
  .lead { font-size: 6mm; color: #333; margin: 0 0 8mm; }

  /*
   * The code itself, as large as the page allows. A visitor holds a phone at
   * arm's length in whatever light a gate has, and every millimetre here is
   * the difference between a scan that works first time and one that has
   * somebody shuffling forwards and back.
   */
  .qr { width: 105mm; height: 105mm; margin: 0 auto 6mm; }
  .qr svg { width: 100%; height: 100%; display: block; }

  .where { font-size: 6.5mm; font-weight: 700; margin: 0 0 2mm; }
  .where small { display: block; font-size: 4.5mm; font-weight: 400; color: #555; margin-top: 1mm; }

  /* The address in words, for a phone whose camera will not co-operate. */
  .url { font-family: "Liberation Mono", "DejaVu Sans Mono", monospace; font-size: 4mm; color: #444;
         word-break: break-all; margin: 5mm 0 0; }
  .note { font-size: 4mm; color: #555; margin: 4mm 0 0; line-height: 1.5; }
  @media print { .noprint { display: none !important; } }
  .noprint { margin-top: 10mm; }
  .noprint button {
    font: inherit; font-size: 4.5mm; padding: 3mm 7mm; border-radius: 3mm;
    border: 1px solid #2f6f4f; background: #2f6f4f; color: #fff; cursor: pointer;
  }
</style></head>
<body>
  <div class="sign">
    ${logoPath ? `<img class="logo" src="${esc(logoPath)}" alt="">` : ''}
    ${orgName ? `<p class="org">${esc(orgName)}</p>` : ''}
    <h1>${esc(what)} from your phone</h1>
    <p class="lead">Point your camera at the code</p>
    <div class="qr">${qrSvg}</div>
    <p class="where">${esc(deviceName)}${location ? `<small>${esc(location)}</small>` : ''}</p>
    <p class="url">${esc(url)}</p>
    <p class="note">
      ${geofenced
    ? 'Your phone will ask to share its location — this only works from the site itself. '
    : ''}No app to install. If the code will not scan, use the tablet at the entrance.
    </p>
    <!--
      Printing from a button rather than leaving somebody to find the menu.
      Hidden on the printed page, obviously — a sign with "Print this sign" on
      it stuck to a wall is its own small comedy.
    -->
    <div class="noprint"><button data-print type="button">Print this sign</button></div>
    <script src="/shared/print-button.js"></script>
  </div>
</body></html>`;
}

module.exports = { render };
