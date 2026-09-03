/*
 * The geofence, drawn on a map.
 *
 * Two halves, and the second one is the point.
 *
 * The server half is the tile proxy: a route that makes an outbound request on
 * behalf of whoever calls it, which is the shape of thing worth being careful
 * about. It is checked against a stub rather than against OpenStreetMap —
 * partly so the suite does not fail when somebody else's service is having an
 * afternoon, mostly because the interesting answers are the ones a working
 * tile server will not give on demand: a 404, an HTML error page where a
 * picture should be, and a host with no route to it at all.
 *
 * The browser half draws the map and then measures it. Reading the markup
 * would prove nothing here — the whole feature is arithmetic that ends in a
 * pixel radius, and every way it can be wrong (radius drawn as diameter, the
 * projection missing the latitude term, the scale bar off by a zoom level)
 * produces markup that looks perfectly fine. So the circle is measured against
 * the scale bar it is drawn beside: two independent calculations that have to
 * agree on how many metres a pixel is.
 */
'use strict';
const http = require('http');
const path = require('path');
const { chromium, launchOptions, available } = require('./browser');
const BASE = process.env.BASE_URL || 'http://localhost:3401';
let cookie = '';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n}${x ? ' — ' + x : ''}`); } };

/* A one-pixel PNG, which is a real image and small enough to inline. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

async function req(method, p, body) {
  const res = await fetch(BASE + p, {
    method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie },
    body: body ? JSON.stringify(body) : undefined
  });
  const setc = res.headers.get('set-cookie'); if (setc) cookie = setc.split(';')[0];
  return { status: res.status, type: res.headers.get('content-type') || '', res };
}

(async () => {
  /* ------------------------------------------------- the route, as served */

  // Before signing in: the proxy is not a thing to leave open.
  let r = await req('GET', '/api/admin/tiles/map/1/0/0.png');
  ok('a tile cannot be fetched without signing in', r.status === 401, String(r.status));

  await req('POST', '/api/admin/login', { email: 'owner@example.test', password: 'Testing123!' });

  for (const [why, url] of [
    ['a zoom no tile server has', '/api/admin/tiles/map/30/0/0.png'],
    ['a column past the edge of the world', '/api/admin/tiles/map/2/4/0.png'],
    ['a row past the edge of the world', '/api/admin/tiles/map/2/0/9.png'],
    ['a negative row', '/api/admin/tiles/map/2/0/-1.png'],
    ['something that is not a number at all', '/api/admin/tiles/map/2/x/0.png'],
    ['a layer nobody has heard of', '/api/admin/tiles/moon/2/0/0.png']
  ]) {
    r = await req('GET', url);
    ok(`refused: ${why}`, r.status === 400, String(r.status));
  }

  /*
   * A tile that is in range. Whether it arrives depends on whether this
   * machine can reach a tile server, which is not this suite's business — so
   * only the two acceptable answers are checked, and a picture is a picture.
   */
  r = await req('GET', '/api/admin/tiles/map/1/0/0.png');
  ok('an in-range tile is either a picture or an honest failure',
    (r.status === 200 && /^image\//.test(r.type)) || r.status === 502,
    `${r.status} ${r.type}`);

  /*
   * The question the page asks before requesting a dozen tiles that may not
   * arrive. It has to answer either way rather than fail, because a failed
   * request here would be the very console noise it exists to prevent.
   */
  r = await req('GET', '/api/admin/tiles/probe');
  const probe = await r.res.json().catch(() => null);
  ok('the page can ask what basemaps there are, and always gets an answer',
    r.status === 200 && probe && typeof probe.ok === 'boolean' && !!probe.layers, JSON.stringify(probe));
  ok('…answering for each layer by name, with who to credit for it',
    probe && probe.layers.map && probe.layers.satellite
    && typeof probe.layers.map.ok === 'boolean' && /OpenStreetMap/.test(probe.layers.map.credit)
    && /Esri/.test(probe.layers.satellite.credit),
    JSON.stringify(probe && probe.layers).slice(0, 200));
  ok('…and it is not confused with a tile at zoom "probe"',
    probe && (probe.ok === true || Object.values(probe.layers).every((l) => typeof l.error === 'string')),
    JSON.stringify(probe).slice(0, 160));

  /* ------------------------------------------- the proxy, against a stub */

  let asked = [];
  let mode = 'ok';
  const stub = http.createServer((rq, res) => {
    asked.push(rq.url);
    if (mode === 'missing') { res.writeHead(404).end('no tile'); return; }
    if (mode === 'html') {
      // The realistic version of this is a captive portal or a proxy error
      // page arriving where a picture was asked for.
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('<script>alert(1)</script>');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'image/png' }).end(PIXEL);
  });
  await new Promise((done) => stub.listen(0, '127.0.0.1', done));
  const stubBase = `http://127.0.0.1:${stub.address().port}`;

  const modulePath = path.join(__dirname, '..', 'server', 'tiles.js');
  const load = (url, satellite) => {
    process.env.TILE_URL = url;
    if (satellite) process.env.TILE_URL_SATELLITE = satellite;
    else delete process.env.TILE_URL_SATELLITE;
    delete require.cache[require.resolve(modulePath)];
    return require(modulePath);
  };

  let tiles = load(`${stubBase}/{z}/{x}/{y}.png`);

  let out = await tiles.tile('map', 14, 2627, 6329);
  ok('a tile comes back as bytes and a type',
    Buffer.isBuffer(out.body) && out.type === 'image/png', JSON.stringify(Object.keys(out)));
  ok('…asked for at the address the template describes',
    asked[0] === '/14/2627/6329.png', asked[0]);

  /*
   * The cache is the difference between a settings page somebody leaves open
   * and a settings page quietly asking a stranger's server for the same twelve
   * squares every few seconds.
   */
  asked = [];
  out = await tiles.tile('map', 14, 2627, 6329);
  ok('the same tile again is served from memory, not fetched again',
    Buffer.isBuffer(out.body) && asked.length === 0, `${asked.length} request(s)`);

  /*
   * The one that matters. This route hands whatever came back to a browser as
   * a response from this origin, so anything that is not a picture has to stop
   * here — an intercepting portal serving an HTML error page must not become a
   * page served from the app's own origin.
   */
  mode = 'html';
  out = await tiles.tile('map', 14, 1, 1);
  ok('anything that is not a picture is refused rather than passed on',
    out.error === 'not_an_image' && !out.body, JSON.stringify(out).slice(0, 80));

  mode = 'missing';
  out = await tiles.tile('map', 14, 2, 2);
  ok('a tile the server does not have is reported, not crashed on',
    out.error === 'tile_failed', JSON.stringify(out));

  /* Refused twice, fetched once: a failure is remembered for a moment too. */
  asked = [];
  out = await tiles.tile('map', 14, 2, 2);
  ok('…and remembered briefly, so a redraw does not ask twelve times over',
    out.error === 'tile_failed' && asked.length === 0, `${asked.length} request(s)`);

  /* Range checking happens before anything is fetched, not after. */
  asked = [];
  mode = 'ok';
  out = await tiles.tile('map', 3, 99, 0);
  ok('an impossible tile is refused without asking anyone for it',
    out.error === 'out_of_range' && asked.length === 0, JSON.stringify(out));
  out = await tiles.tile('map', 3.5, 1, 1);
  ok('…and so is a zoom that is not a whole number',
    out.error === 'bad_tile', JSON.stringify(out));

  /*
   * The case a self-hosted install actually hits: no route out. It hangs
   * rather than refusing, so this has to come back on a timer.
   */
  const offline = load('http://127.0.0.1:9/{z}/{x}/{y}.png');   // discard port
  out = await offline.tile('map', 10, 1, 1);
  ok('a server with no way out says so rather than hanging',
    out.error === 'unreachable', JSON.stringify(out));

  /*
   * The two layers are separate sources and separate cache entries. Sharing
   * either would put yesterday's photograph under today's street map, or the
   * other way about, with nothing on screen to say which you were looking at.
   * Note the order in the addresses: Esri's are {z}/{y}/{x}, not {z}/{x}/{y},
   * and getting that backwards produces a map of somewhere else entirely.
   */
  asked = [];
  const both = load(`${stubBase}/map/{z}/{x}/{y}.png`, `${stubBase}/sat/{z}/{y}/{x}.png`);
  await both.tile('map', 12, 5, 9);
  await both.tile('satellite', 12, 5, 9);
  ok('each layer is fetched from its own address, in its own order',
    asked.length === 2 && asked[0] === '/map/12/5/9.png' && asked[1] === '/sat/12/9/5.png',
    asked.join(', '));

  asked = [];
  await both.tile('map', 12, 5, 9);
  await both.tile('satellite', 12, 5, 9);
  ok('…and cached apart, so one layer never serves the other\'s squares',
    asked.length === 0, asked.join(', '));

  out = await both.tile('moon', 12, 5, 9);
  ok('a layer that does not exist is refused without asking anyone for it',
    out.error === 'no_such_layer', JSON.stringify(out));

  const seen = await both.probe();
  ok('the probe answers for every layer, and names who to credit',
    seen.ok === true && seen.layers.map.ok && seen.layers.satellite.ok
    && seen.layers.satellite.label === 'Satellite',
    JSON.stringify(seen).slice(0, 200));

  delete process.env.TILE_URL;
  delete process.env.TILE_URL_SATELLITE;
  await new Promise((done) => stub.close(done));

  /* -------------------------------------------------- the map, as drawn */

  if (!available()) {
    console.log('  (skipping the drawn map — no browser)');
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }

  const browser = await chromium.launch({ ...launchOptions() });
  const page = await browser.newPage({ viewport: { width: 1320, height: 950 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  /*
   * The tiles are answered here rather than fetched. Not to save the network
   * — the proxy above is already proven — but so that this half is about the
   * arithmetic, and so a red run means the map is wrong rather than that
   * somebody else's service was slow.
   */
  let wanted = [];
  let serveTiles = true;
  /*
   * The page asks once whether there is a basemap to be had before requesting
   * any tiles, so both have to be answered here — and separately, because the
   * two failure modes are different things to check: no map at all (this
   * server has no way out) and a map that turns out not to arrive.
   */
  await page.route(/\/api\/admin\/tiles\/probe/, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ok: serveTiles,
      layers: {
        map: { ok: serveTiles, credit: '\u00a9 OpenStreetMap contributors', label: 'Map' },
        satellite: { ok: serveTiles, credit: 'Imagery \u00a9 Esri', label: 'Satellite' }
      }
    })
  }));
  await page.route(/\/api\/admin\/tiles\/[a-z]+\/\d+\/\d+\/\d+/, (route) => {
    wanted.push(new URL(route.request().url()).pathname);
    if (!serveTiles) return route.abort();
    return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
  });

  await page.goto(`${BASE}/admin/`);
  await page.fill('#gate-email', 'owner@example.test');
  await page.fill('#gate-pass', 'Testing123!');
  await page.click('#gate-submit');
  await page.waitForSelector('#shell:not(.hidden)');

  await page.goto(`${BASE}/admin/#settings/flow`);
  await page.reload();
  await page.waitForSelector('#set-flow:not([hidden]) [data-set="geofence.lat"]', { timeout: 15000 });

  /* With nothing placed, there is no map — and it says what to do instead. */
  await page.fill('[data-set="geofence.lat"]', '');
  await page.fill('[data-set="geofence.lng"]', '');
  await page.waitForTimeout(400);
  ok('with no coordinates there is no map, and it says how to set them',
    await page.$eval('#site-map-frame', (el) => el.hidden)
    && /latitude and longitude/i.test(await page.$eval('#site-map-note', (el) => el.textContent)));

  /** What the drawing actually says, measured off the page. */
  const measure = () => page.evaluate(() => {
    const svg = document.querySelector('#site-map-overlay');
    const ring = svg.querySelector('circle.fence-ring');
    // The ruler is its own overlay: it belongs to the frame, not the ground,
    // so it does not slide about while the map is being dragged.
    const ruler = document.querySelector('#site-map-scale');
    const bar = ruler.querySelector('.scale-bar line');
    const barText = ruler.querySelector('.scale-bar text');
    const [, , w, h] = (svg.getAttribute('viewBox') || '0 0 0 0').split(' ').map(Number);
    const label = (barText && barText.textContent) || '';
    const n = Number(label.replace(/[^\d.]/g, ''));
    return {
      w, h,
      r: ring ? Number(ring.getAttribute('r')) : null,
      barPx: bar ? Number(bar.getAttribute('x2')) - Number(bar.getAttribute('x1')) : null,
      barMetres: /km/.test(label) ? n * 1000 : n,
      pin: !!svg.querySelector('.fence-pin'),
      note: (document.querySelector('#site-map-note').textContent || '')
    };
  });

  const place = async (lat, lng, radius) => {
    wanted = [];
    await page.fill('[data-set="geofence.lat"]', String(lat));
    await page.fill('[data-set="geofence.lng"]', String(lng));
    if (radius != null) await page.fill('[data-set="geofence.radius_m"]', String(radius));
    await page.waitForFunction(() => {
      const el = document.querySelector('#site-map-overlay circle.fence-ring');
      return el && Number(el.getAttribute('r')) > 0;
    }, null, { timeout: 10000 });
    await page.waitForTimeout(350);
    return measure();
  };

  let m = await place(37.7955, -122.2712, 250);

  ok('placing the site draws a map', !(await page.$eval('#site-map-frame', (el) => el.hidden)));
  ok('…with tiles asked for, all of them from this server',
    wanted.length >= 4 && wanted.every((p) => /^\/api\/admin\/tiles\/map\/\d+\/\d+\/\d+\.png$/.test(p)),
    `${wanted.length}: ${wanted[0]}`);
  ok('…enough of them to cover the frame',
    wanted.length >= Math.ceil(m.w / 256) * Math.ceil(m.h / 256),
    `${wanted.length} for ${m.w}×${m.h}`);
  ok('…and a pin on the spot', m.pin);

  /*
   * The measurement the whole feature rests on. The circle's pixel radius and
   * the scale bar are worked out from the same metres-per-pixel but by
   * different routes, so if either is wrong — a diameter drawn as a radius, a
   * zoom level off by one, the latitude term dropped from the projection —
   * they stop agreeing.
   */
  const metresAcross = (mm) => (mm.r / mm.barPx) * mm.barMetres;
  ok('the circle is the radius it says it is, measured against its own scale bar',
    Math.abs(metresAcross(m) - 250) < 250 * 0.02,
    `${metresAcross(m).toFixed(1)} m where 250 was set`);
  /*
   * Tiles come at whole zoom levels, so the fit cannot be exact: the view is
   * aimed at four fifths of the frame and rounded down, which lands anywhere
   * from two fifths to four fifths. Outside that band something is wrong with
   * the fitting rather than merely coarse.
   */
  ok('…and it fits inside the frame with room around it',
    m.r * 2 < Math.min(m.w, m.h) * 0.82 && m.r * 2 > Math.min(m.w, m.h) * 0.39,
    `${(m.r * 2).toFixed(0)}px across a ${Math.min(m.w, m.h)}px frame`);

  /* A different site, a different size: the view refits rather than clipping. */
  m = await place(37.7955, -122.2712, 2000);
  ok('a much bigger fence is still drawn whole, to its own scale',
    Math.abs(metresAcross(m) - 2000) < 2000 * 0.02 && m.r * 2 < Math.min(m.w, m.h),
    `${metresAcross(m).toFixed(0)} m, ${(m.r * 2).toFixed(0)}px across`);

  m = await place(37.7955, -122.2712, 40);
  ok('and so is a small one, rather than vanishing to a dot',
    Math.abs(metresAcross(m) - 40) < 40 * 0.05 && m.r > 40,
    `${metresAcross(m).toFixed(1)} m, ${m.r.toFixed(0)}px radius`);

  /*
   * Mercator stretches the ground as you go north: a pixel at 60° covers half
   * the distance it covers at the equator, at the same zoom. If that term were
   * missing the map would still draw, and every fence away from the equator
   * would be the wrong size on the ground. Same radius, same frame, so the
   * fitted zoom has to come out exactly one level closer.
   */
  const zoomOf = (paths) => Number((paths[0] || '').split('/')[5]);
  // Not 0,0: that is the null island the fence treats as "not placed yet".
  await place(0.0, 10.75, 250);
  const atEquator = zoomOf(wanted);
  await place(60.0, 10.75, 250);
  const atSixty = zoomOf(wanted);
  ok('the projection knows that a pixel covers less ground further north',
    atSixty === atEquator - 1, `zoom ${atEquator} at the equator, ${atSixty} at 60°`);

  /* The zoom buttons move the view and say so, without touching the fence. */
  m = await place(37.7955, -122.2712, 250);
  const before = m.r;
  await page.click('[data-mapzoom="1"]');
  await page.waitForTimeout(250);
  m = await measure();
  ok('zooming in makes the circle bigger on screen, not bigger on the ground',
    m.r > before * 1.5 && Math.abs(metresAcross(m) - 250) < 250 * 0.05,
    `${before.toFixed(0)}px → ${m.r.toFixed(0)}px, ${metresAcross(m).toFixed(1)} m`);
  ok('…and says the buttons only changed the view',
    /only change the view/.test(m.note), m.note.slice(0, 90));

  /*
   * The fence is off in these fixtures, and the note has to say so — a circle
   * drawn on a map is exactly the thing somebody would read as "this is
   * switched on and working".
   */
  ok('a fence that is switched off is drawn, and labelled as switched off',
    /switched off/.test(m.note), m.note.slice(0, 90));

  /* ------------------------------------------------ dragging, and layers */

  /*
   * The drag is the part that cannot be checked by reading anything. It ends
   * in an inverse Mercator, and the ways it goes wrong are subtle and silent:
   * latitude and longitude transposed, a sign flipped, the projection inverted
   * with a plausible but wrong constant. All of those still write two
   * believable numbers into two boxes. So the pin is dragged a known number of
   * pixels in a known direction, and where it lands is checked both ways.
   */
  m = await place(37.7955, -122.2712, 250);
  const readCoords = () => page.evaluate(() => ({
    lat: Number(document.querySelector('[data-set="geofence.lat"]').value),
    lng: Number(document.querySelector('[data-set="geofence.lng"]').value)
  }));
  const wasAt = await readCoords();

  /*
   * Scrolled to first. The map sits well down a long settings page, and a
   * drag aimed at a point below the fold lands on nothing at all — which
   * looks exactly like a drag handler that does not work.
   */
  await page.$eval('#site-map', (el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);
  const frameBox = await page.$eval('#site-map-frame', (el) => {
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  });

  const shove = async (fromX, fromY, dx, dy) => {
    await page.mouse.move(fromX, fromY);
    await page.mouse.down();
    // In steps, because one jump is not a drag: the handler watches
    // pointermove, and a gesture with no middle is not the one people make.
    for (let i = 1; i <= 6; i++) await page.mouse.move(fromX + (dx * i) / 6, fromY + (dy * i) / 6);
    await page.mouse.up();
    await page.waitForTimeout(400);
  };

  /* Right and down is east and south: a bigger longitude, a smaller latitude. */
  await shove(frameBox.x + frameBox.w / 2, frameBox.y + frameBox.h / 2 - 8, 60, 40);
  const after = await readCoords();
  ok('dragging the pin moves the site east and south, not somewhere else',
    after.lng > wasAt.lng && after.lat < wasAt.lat,
    `${wasAt.lat}, ${wasAt.lng} -> ${after.lat}, ${after.lng}`);

  /*
   * And by the right amount. The scale bar says how many metres a pixel is, so
   * sixty pixels east is a distance that can be arrived at two ways and
   * compared — which is what catches an inversion that gets the direction
   * right and the distance wrong.
   */
  const perPixel = m.barMetres / m.barPx;
  const eastMetres = (after.lng - wasAt.lng) * 111320 * Math.cos(wasAt.lat * Math.PI / 180);
  ok('...by the distance it was dragged, to the map’s own scale',
    Math.abs(eastMetres - 60 * perPixel) < 60 * perPixel * 0.1,
    `${eastMetres.toFixed(1)} m where ${(60 * perPixel).toFixed(1)} m was expected`);

  ok('...written at a sane precision, not the seventeen digits a double has',
    /^-?\d+\.\d{6}$/.test(await page.$eval('[data-set="geofence.lat"]', (el) => el.value)),
    await page.$eval('[data-set="geofence.lat"]', (el) => el.value));

  m = await measure();
  ok('...while the circle stays the size it was',
    Math.abs(metresAcross(m) - 250) < 250 * 0.02, `${metresAcross(m).toFixed(1)} m`);

  /*
   * Dragging the map is the other gesture, and it must not move the site. The
   * two are told apart by what was under the finger when it went down, and
   * getting that wrong would quietly relocate somebody's gate every time they
   * looked around.
   */
  const held = await readCoords();
  await shove(frameBox.x + 40, frameBox.y + frameBox.h - 50, 260, 0);
  const stillThere = await readCoords();
  ok('dragging the map looks around without moving the site',
    stillThere.lat === held.lat && stillThere.lng === held.lng,
    `${held.lat}, ${held.lng} -> ${stillThere.lat}, ${stillThere.lng}`);
  ok('...and offers a way back once the site has gone off to one side',
    !await page.$eval('#site-map-recentre', (el) => el.classList.contains('hidden')));

  await page.click('#site-map-recentre');
  await page.waitForTimeout(400);
  ok('...which puts the site back in the middle of the frame',
    await page.$eval('#site-map-recentre', (el) => el.classList.contains('hidden')));

  /* Typing a coordinate is a new site, so the view returns to it. */
  await shove(frameBox.x + 40, frameBox.y + frameBox.h - 50, 260, 0);
  await place(51.5072, -0.1276, 250);
  ok('typing new coordinates recentres the map rather than leaving it adrift',
    await page.$eval('#site-map-recentre', (el) => el.classList.contains('hidden')));

  /* ---- the photograph ---- */

  ok('both basemaps are offered when both can be had',
    (await page.$$('#site-map-layers [data-maplayer]')).length === 2
    && !await page.$eval('#site-map-layers', (el) => el.classList.contains('hidden')));

  wanted = [];
  await page.click('[data-maplayer="satellite"]');
  await page.waitForTimeout(500);
  ok('switching to Satellite fetches the satellite layer, not the drawn one',
    wanted.length >= 4 && wanted.every((u) => u.includes('/tiles/satellite/')),
    `${wanted.length}: ${wanted[0]}`);
  ok('...and credits whoever the imagery belongs to',
    /Esri/.test(await page.$eval('#site-map-credit', (el) => el.textContent)),
    await page.$eval('#site-map-credit', (el) => el.textContent));
  ok('...and restyles the circle, which would otherwise be a dark line on a dark yard',
    await page.$eval('#site-map-frame', (el) => el.classList.contains('satellite')));

  m = await measure();
  ok('...while the fence is still the fence, to the same scale',
    Math.abs(metresAcross(m) - 250) < 250 * 0.02, `${metresAcross(m).toFixed(1)} m`);

  wanted = [];
  await page.click('[data-maplayer="map"]');
  await page.waitForTimeout(500);
  ok('and back again',
    wanted.length >= 4 && wanted.every((u) => u.includes('/tiles/map/'))
    && !await page.$eval('#site-map-frame', (el) => el.classList.contains('satellite')),
    `${wanted.length}: ${wanted[0]}`);

  /*
   * Zero is not a place, it is what an empty box used to become on the way to
   * the server — and it is in the Atlantic. Drawing a map of it would present
   * a fence nobody has set as one they have.
   */
  await page.fill('[data-set="geofence.lat"]', '0');
  await page.fill('[data-set="geofence.lng"]', '0');
  await page.waitForTimeout(400);
  ok('coordinates of zero are treated as not set yet, not as a site in the Atlantic',
    await page.$eval('#site-map-frame', (el) => el.hidden));

  /* Checked here, before the tiles are deliberately broken below. */
  ok('the page threw nothing while drawing any of that', errors.length === 0, errors.slice(0, 2).join(' | '));

  /*
   * An install with no way out to the internet is a normal way to run this,
   * and the failure has to be legible: a circle floating on grey nothing looks
   * like a bug in the circle.
   */
  serveTiles = false;
  await place(51.5072, -0.1276, 250);
  await page.waitForFunction(() =>
    /could not be loaded/i.test(document.querySelector('#site-map-note').textContent),
  null, { timeout: 10000 });
  m = await measure();
  ok('with no tiles it says the map could not be loaded, not nothing',
    /could not be loaded/i.test(m.note), m.note.slice(0, 120));
  ok('…and still draws the circle to scale, so the size is checkable',
    Math.abs(metresAcross(m) - 250) < 250 * 0.02, `${metresAcross(m).toFixed(1)} m`);
  ok('…and marks the frame so it reads as paper rather than a broken map',
    await page.$eval('#site-map-frame', (el) => el.classList.contains('no-tiles')));

  /*
   * Put the fixtures back. Explicit nulls, because a key left out of a
   * settings patch keeps its old value — the same rule that once left a fence
   * at 0,0 refusing everybody.
   */
  await req('PUT', '/api/admin/settings', { geofence: { lat: null, lng: null, radius_m: 250, enabled: false } });

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
