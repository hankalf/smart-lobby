# Vendored libraries

## jsQR 1.4.0

QR decoding for the sign-out scanner, from <https://github.com/cozmo/jsQR>, Apache-2.0.

It is bundled rather than loaded from a CDN so the kiosk keeps working with no
internet, and it is fetched only when somebody opens the scanner — not on every
page load.

Browsers with the native `BarcodeDetector` API use that instead and never load
this file. iPad Safari and the WKWebView-based kiosk apps do not have it, which
is why this exists.

To update: `curl -sL -o jsQR.js https://cdn.jsdelivr.net/npm/jsqr@<version>/dist/jsQR.js`
