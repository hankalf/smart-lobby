/*
 * The printed sign at a gate, and the phone check-in it opens.
 *
 * Two things are being held to account here.
 *
 * The sign has to say what *this* entrance does. A phone check-in used to come
 * up showing every card on the site, because /go/<code> has no device name in
 * it and the kiosk had no other way to ask — so a barrier that only takes
 * deliveries offered to sign people out, and a sign printed for it said the
 * wrong thing above the code.
 *
 * And the print button has to work. Both standalone printable pages carried
 * `onclick="window.print()"`, which the site's own Content-Security-Policy
 * blocks as surely as it blocks an inline <script>: the button rendered, it
 * hovered, and nothing happened. So this drives it in a real browser rather
 * than checking the markup, because the markup looked fine the whole time.
 */
'use strict';
const BASE = process.env.BASE_URL || 'http://localhost:3401';
const browser = require('./browser');
let cookie = '';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n}${x ? ' — ' + x : ''}`); } };

async function req(method, p, body) {
  const res = await fetch(BASE + p, {
    method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie },
    body: body ? JSON.stringify(body) : undefined
  });
  const setc = res.headers.get('set-cookie'); if (setc) cookie = setc.split(';')[0];
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, data, text };
}

(async () => {
  await req('POST', '/api/admin/login', { email: 'hankalfr@gmail.com', password: 'Testing123!' });
  const BEFORE = (await req('GET', '/api/admin/settings')).data;

  const where = (await req('POST', '/api/admin/locations', { name: 'Sign Test Gate' })).data;
  const device = (await req('POST', '/api/admin/devices',
    { name: 'Sign Test Gate iPad', location_id: where.id })).data;

  /* ---- a sign for a device with phone check-in off ---- */
  let r = await req('GET', `/api/admin/devices/${device.id}/sign`);
  ok('a device with phone check-in off has no sign to print, and says why',
    r.status === 409 && /phone check-in is off/i.test(r.text), `${r.status} ${r.text.slice(0, 60)}`);

  /* ---- switched on, and told which cards it offers ---- */
  await req('PUT', '/api/admin/settings', { kiosk: { ...BEFORE.kiosk, self_checkin_enabled: true } });
  await req('PATCH', `/api/admin/devices/${device.id}`,
    { self_checkin: 1, sections: ['signin', 'signout', 'delivery'] });

  r = await req('GET', `/api/admin/devices/${device.id}/sign`);
  ok('a sign can be printed straight from the dashboard', r.status === 200, String(r.status));
  ok('…naming the entrance it belongs to', r.text.includes('Sign Test Gate iPad'));
  ok('…and where that is', r.text.includes('Sign Test Gate<'));

  /*
   * One heading on every sign. Built from the device's cards it produced
   * "Sign in, Contractor or Delivery from your phone" — a sentence nobody
   * reads from six feet away, and the cards are on the screen the code opens
   * anyway.
   */
  ok('the sign says the same plain thing however many cards the device has',
    /<h1>Check-in from your phone<\/h1>/.test(r.text),
    (r.text.match(/<h1>[^<]*<\/h1>/) || [''])[0]);

  ok('the code is drawn into the page rather than fetched',
    r.text.includes('<svg') && !/<img[^>]+\/api\/qr/.test(r.text));

  /*
   * And the address is nowhere on it. It is unreadable at sign distance and
   * nobody types one off a wall, but anybody photographing the sign would walk
   * away with a working check-in link in plain text — the one thing on the
   * sheet worth not handing out.
   */
  const link = (await req('GET', `/api/admin/devices/${device.id}/links`)).data;
  ok('the check-in address is not printed in words anywhere on the sign',
    !r.text.includes(link.self) && !/\/go\//.test(r.text),
    (r.text.match(/[^\s"'>]*\/go\/[^\s"'<]*/) || [''])[0]);

  /*
   * ---- the button, in a browser ----
   *
   * The one form of this check that would have caught the bug. Everything
   * about the markup was right; the policy simply refused to run it.
   */
  if (browser.available()) {
    const b = await browser.chromium.launch(browser.launchOptions());
    const ctx = await b.newContext();
    // The page is behind a login, like the rest of the dashboard.
    await ctx.addCookies([{ name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='),
      url: BASE }]);
    const page = await ctx.newPage();
    const blocked = [];
    page.on('console', (m) => {
      if (m.type() === 'error' && /Content Security Policy/i.test(m.text())) blocked.push(m.text().slice(0, 100));
    });

    await page.goto(`${BASE}/api/admin/devices/${device.id}/sign`, { waitUntil: 'networkidle' });
    await page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
    await page.click('[data-print]');
    await page.waitForTimeout(300);
    ok('pressing “print this sign” actually prints',
      await page.evaluate(() => window.__printed) === 1);
    ok('…with nothing on the page refused by the content security policy',
      blocked.length === 0, blocked.join(' | '));

    /* The same button on the site report, which had the same dead handler. */
    const today = new Date().toISOString().slice(0, 10);
    await page.goto(`${BASE}/api/admin/stats/print?from=${today}&to=${today}`, { waitUntil: 'networkidle' });
    await page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
    await page.click('[data-print]');
    await page.waitForTimeout(300);
    ok('the printable report’s button works too', await page.evaluate(() => window.__printed) === 1);

    /*
     * ---- what the code actually opens ----
     *
     * The point of the whole thing: a phone that scanned this sign gets the
     * cards chosen for this gate, not every card on the site.
     */
    const phone = await (await b.newContext({ viewport: { width: 414, height: 860 } })).newPage();
    await phone.goto(link.self, { waitUntil: 'networkidle' });
    await phone.waitForTimeout(1800);
    /*
     * Deduplicated: the same cards are built into the welcome screen and the
     * menu behind it, so counting both containers counts everything twice.
     */
    const cards = await phone.evaluate(() => [...new Set(
      [...document.querySelectorAll('#welcome-actions .tile, #menu-tiles .tile')]
        .map((t) => (t.dataset.action || t.dataset.type || (t.textContent || '').trim()))
    )]);
    ok('a phone that scans the sign gets exactly this device’s cards',
      cards.length === 3, JSON.stringify(cards));
    ok('…and not every card on the site',
      !cards.some((c) => /interview/i.test(c)), JSON.stringify(cards));

    /*
     * And the phone must not take the tablet's identity with it. Rewriting the
     * address to /kiosk/<slug> would throw away the code the sign-in has to
     * send, and hand a stranger a home-screen icon for the gate kiosk.
     */
    ok('the phone stays on the address the sign sent it to',
      /\/go\//.test(await phone.evaluate(() => location.pathname)),
      await phone.evaluate(() => location.pathname));

    /*
     * ---- a refusal at the first tap, not the last ----
     *
     * The report this comes from: details filled in, photograph taken, site
     * rules read and signed, induction sat through, and only then "you are off
     * site". Right answer, useless moment. So the fence is switched on with
     * the site somewhere else entirely, and the visitor should get no further
     * than the first card.
     */
    const GATE = { lat: 51.5, lng: -0.12 };            // the site
    const AWAY = { latitude: 37.7955, longitude: -122.2712, accuracy: 15 };  // the visitor
    await req('PUT', '/api/admin/settings', {
      geofence: { enabled: true, lat: GATE.lat, lng: GATE.lng, radius_m: 250, require_location: true }
    });

    const far = await (await b.newContext({
      viewport: { width: 414, height: 860 }, geolocation: AWAY, permissions: ['geolocation']
    })).newPage();
    await far.goto(link.self, { waitUntil: 'networkidle' });
    await far.waitForTimeout(1600);
    await far.locator('.tile').first().click();
    await far.waitForFunction(() => {
      const s = document.querySelector('.screen:not([hidden])');
      return s && s.dataset.screen === 'blocked';
    }, null, { timeout: 12000 }).catch(() => {});

    const at = await far.evaluate(() => {
      const s = document.querySelector('.screen:not([hidden])');
      return s && s.dataset.screen;
    });
    ok('a phone away from the site is stopped at the first tap', at === 'blocked', at);
    ok('…and told why, in words that name the distance',
      /km from the site|m from the site/.test(await far.textContent('#blocked-message')),
      (await far.textContent('#blocked-message')).slice(0, 80));

    /* And somebody standing on the site is not stopped at all. */
    const here = await (await b.newContext({
      viewport: { width: 414, height: 860 },
      geolocation: { latitude: GATE.lat + 0.0001, longitude: GATE.lng + 0.0001, accuracy: 15 },
      permissions: ['geolocation']
    })).newPage();
    await here.goto(link.self, { waitUntil: 'networkidle' });
    await here.waitForTimeout(1600);
    await here.locator('.tile').first().click();
    await here.waitForTimeout(2500);
    const got = await here.evaluate(() => {
      const s = document.querySelector('.screen:not([hidden])');
      return s && s.dataset.screen;
    });
    ok('a phone on the site carries on into the sign-in', got && got !== 'blocked', got);

    /*
     * The nudge to turn the phone. Only where it helps: a narrow portrait
     * screen that scanned a sign, never a tablet bolted to a gate.
     */
    ok('a phone is told it reads more easily turned sideways',
      await here.isVisible('#turn-hint'));
    const tablet = await (await b.newContext({ viewport: { width: 1024, height: 768 } })).newPage();
    await tablet.goto(`${BASE}/kiosk/`, { waitUntil: 'networkidle' });
    await tablet.waitForTimeout(1400);
    ok('…and a tablet at the gate is not', !await tablet.isVisible('#turn-hint'));

    await req('PUT', '/api/admin/settings', { geofence: BEFORE.geofence || { enabled: false } });
    await b.close();
  } else {
    console.log('  (no browser — the button and the phone are not checked)');
  }

  /*
   * A phone scanning the sign is not the tablet reporting for duty. Counting
   * it would keep a dead gate iPad looking alive every time somebody used the
   * sign beside it, which is exactly when you want to know it is down.
   */
  const before = (await req('GET', '/api/admin/devices')).data.find((d) => d.id === device.id);
  await req('POST', '/api/kiosk/ping', { self_code: link.self.split('/').pop() });
  const after = (await req('GET', '/api/admin/devices')).data.find((d) => d.id === device.id);
  ok('a phone using the sign does not count as the tablet checking in',
    (before.last_seen_at || null) === (after.last_seen_at || null),
    `${before.last_seen_at} -> ${after.last_seen_at}`);

  /* ---- put the site back ---- */
  await req('DELETE', `/api/admin/devices/${device.id}`);
  await req('DELETE', `/api/admin/locations/${where.id}`);
  await req('PUT', '/api/admin/settings', { kiosk: BEFORE.kiosk });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
