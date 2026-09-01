'use strict';
/*
 * The "print this" button on the standalone printable pages — the site report
 * and the gate sign.
 *
 * A file rather than an onclick attribute, and that is the whole point of it.
 * The site sends Content-Security-Policy with script-src 'self', which blocks
 * inline event handlers exactly as it blocks inline <script> — so
 * `onclick="window.print()"` is dead on arrival, silently. It renders as a
 * button, it hovers like a button, and nothing happens when it is pressed.
 * The report's print button had been that way since it was written.
 *
 * Anything carrying data-print gets wired. Nothing else here, on purpose: a
 * page whose only job is to be printed should not be running code.
 */
(() => {
  for (const button of document.querySelectorAll('[data-print]')) {
    button.addEventListener('click', () => window.print());
  }
})();
