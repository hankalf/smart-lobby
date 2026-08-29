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

## ZXing 0.23.0

PDF417 decoding, for reading the barcode on the back of a driver's licence,
from <https://github.com/zxing-js/library>, Apache-2.0. Bundled for the same
reason as jsQR, and likewise fetched only when the licence scanner is opened —
it is the larger of the two files by some way.

Native `BarcodeDetector` is preferred where it exists and supports pdf417;
Safari does not, which is what this is for.

To update: take `umd/index.min.js` from the npm package
(`npm pack @zxing/library@<version>`) and save it here as `zxing.min.js`.
