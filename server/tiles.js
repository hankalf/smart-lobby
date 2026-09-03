'use strict';
/**
 * Map tiles, fetched by this server rather than by the browser.
 *
 * The settings page draws the geofence on a map so whoever set it can see the
 * circle land on their own site rather than trusting two decimal numbers. The
 * map needs a basemap, and a basemap is images from somebody else's server.
 *
 * Which this site's content security policy does not allow: img-src is
 * 'self' data: blob:, and widening it for a tile host would widen it for every
 * page in the app — the kiosk a visitor uses, the board on the wall — to admit
 * pictures for one settings panel that an administrator opens twice in the
 * life of an install. So the tiles come through here instead, the same trade
 * the on-site board's camera proxy makes, and the browser only ever talks to
 * this origin.
 *
 * That has a second effect worth having: nobody's browser is put in touch with
 * a mapping service, so no visitor-facing page leaks a referrer or an address
 * to one. The only thing the outside world sees is this server asking for a
 * square of map.
 *
 * The tiles are OpenStreetMap's by default. Their tile policy asks for an
 * identifying User-Agent, caching, and no bulk downloading; a settings panel
 * showing a dozen 256-pixel squares now and then sits far inside that, and the
 * cache below means a redraw at the same zoom asks them for nothing at all.
 * A site that would rather not use them — or has no way out to the internet —
 * points TILE_URL at its own and nothing else changes. Without either, the map
 * falls back to drawing the fence on plain paper, which still answers "is the
 * radius the right size" if not "is it the right place".
 */

/*
 * Two ways of looking at the same ground, because they answer different
 * questions. The drawn map is better for "is this the right street"; the
 * photograph is better for "is that our yard, and does the circle cover the
 * far gate" — which on a site with no useful postal address is the only
 * question that can be answered at all.
 *
 * Both are overridable, so a site can point at its own tiles, and so the tests
 * can answer for them without reaching the internet.
 *
 * A word about the imagery, because it is worth knowing before relying on it:
 * OpenStreetMap have no satellite tiles, so the default is Esri's World
 * Imagery, which is what most small mapping applications use and asks only to
 * be credited. It is somebody else's free service. A site that would rather
 * not depend on one — or has a paid imagery subscription already — sets
 * TILE_URL_SATELLITE and TILE_ATTRIBUTION_SATELLITE and nothing else changes.
 * Nothing here breaks if it goes away: the layer reports itself unavailable
 * and the button for it is not offered.
 */
const LAYERS = {
  map: {
    url: process.env.TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    credit: process.env.TILE_ATTRIBUTION || '\u00a9 OpenStreetMap contributors',
    label: 'Map'
  },
  satellite: {
    // Note the order: Esri's addresses are {z}/{y}/{x}, not {z}/{x}/{y}.
    url: process.env.TILE_URL_SATELLITE
      || 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    credit: process.env.TILE_ATTRIBUTION_SATELLITE
      || 'Imagery \u00a9 Esri, Maxar, Earthstar Geographics',
    label: 'Satellite'
  }
};

const LAYER_IDS = Object.keys(LAYERS);

const AGENT = process.env.TILE_AGENT || process.env.GEOCODE_AGENT
  || 'SmartLobby/1.0 (self-hosted visitor management; geofence map)';

/** Past this the tile servers have nothing, and asking is just a 404 each time. */
const MAX_ZOOM = 19;

/*
 * Kept in memory rather than on disk. A tile is about 15 KB, so this is a few
 * megabytes at worst, and the alternative is a cache directory to grow
 * unbounded on an install whose storage is already the thing that runs out.
 * Losing it on restart costs one redraw.
 */
const CACHE_MAX = 600;
const CACHE_TTL_MS = 7 * 864e5;
const cache = new Map();

/*
 * A failure is remembered too, briefly. A server with no route out does not
 * refuse, it hangs for the full timeout — and a map redraw asks for twelve
 * tiles at once, so without this a page on an offline install spends a minute
 * of the server's time discovering the same thing twelve times.
 */
const FAIL_TTL_MS = 30000;

/*
 * Two at a time, which is what the tile policy asks of a client and what a
 * browser would have done itself. Enough to fill a small map quickly, not
 * enough to look like someone scraping.
 */
const MAX_IN_FLIGHT = 2;
let running = 0;
const waiting = [];

function acquire() {
  if (running < MAX_IN_FLIGHT) { running++; return Promise.resolve(); }
  return new Promise((go) => waiting.push(go));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else running--;
}

/** Oldest out first, so the cache stays a cache rather than a leak. */
function remember(key, value) {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { ...value, at: Date.now() });
}

/**
 * One square of map.
 *
 * @param {string} layer  'map' or 'satellite'
 * @param {*} z  zoom, 0 at the whole world
 * @param {*} x  column, 0 to 2^z - 1
 * @param {*} y  row, same range
 * @returns {Promise<{body?: Buffer, type?: string, error?: string}>}
 */
async function tile(layer, z, x, y) {
  const source = LAYERS[layer];
  if (!source) return { error: 'no_such_layer' };
  const zoom = Number(z);
  const col = Number(x);
  const row = Number(y);

  /*
   * Checked here rather than trusted from the path. This is a route that makes
   * an outbound request on behalf of whoever calls it, so the numbers it will
   * put in a URL have to be numbers — the whole reason it takes three integers
   * and builds the address itself instead of accepting one.
   */
  const whole = (n) => Number.isInteger(n);
  if (!whole(zoom) || !whole(col) || !whole(row)) return { error: 'bad_tile' };
  if (zoom < 0 || zoom > MAX_ZOOM) return { error: 'out_of_range' };
  const span = 2 ** zoom;
  if (col < 0 || col >= span || row < 0 || row >= span) return { error: 'out_of_range' };

  const key = `${layer}/${zoom}/${col}/${row}`;
  const held = cache.get(key);
  if (held) {
    const age = Date.now() - held.at;
    if (held.error ? age < FAIL_TTL_MS : age < CACHE_TTL_MS) {
      // Touched so a tile in use survives the eviction of one that is not.
      cache.delete(key);
      cache.set(key, held);
      return held.error ? { error: held.error } : { body: held.body, type: held.type };
    }
    cache.delete(key);
  }

  const url = source.url
    .replace('{z}', String(zoom))
    .replace('{x}', String(col))
    .replace('{y}', String(row));

  await acquire();
  try {
    let res;
    try {
      const bail = AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined;
      res = await fetch(url, { headers: { 'User-Agent': AGENT, Accept: 'image/png,image/*' }, signal: bail });
    } catch {
      remember(key, { error: 'unreachable' });
      return { error: 'unreachable' };
    }

    if (!res.ok) {
      remember(key, { error: 'tile_failed' });
      return { error: 'tile_failed' };
    }

    const type = String(res.headers.get('content-type') || '').split(';')[0].trim();
    /*
     * Only pictures come back out of here. This route hands whatever the
     * upstream sent to a browser, so a tile server that had been replaced by
     * something serving HTML — or an intercepting portal on the way, which is
     * the realistic version — must not become a page served from this origin.
     */
    if (!/^image\//.test(type)) {
      remember(key, { error: 'not_an_image' });
      return { error: 'not_an_image' };
    }

    const body = Buffer.from(await res.arrayBuffer());
    remember(key, { body, type });
    return { body, type };
  } finally {
    release();
  }
}

/** For the tests, and for anyone wondering what the map is costing. */
const stats = () => ({ cached: cache.size, layers: LAYER_IDS });

/**
 * Which of the layers can actually be had from here, asked once so the page
 * does not request a dozen tiles that cannot arrive — nor offer a Satellite
 * button that would only ever show squared paper.
 *
 * Tile 0/0/0 is the whole world in one square, and is cached like any other,
 * so this is one small request per layer for the life of the process.
 */
async function probe() {
  const out = {};
  for (const id of LAYER_IDS) {
    const got = await tile(id, 0, 0, 0);
    out[id] = { ok: !got.error, error: got.error || null, credit: LAYERS[id].credit, label: LAYERS[id].label };
  }
  return { ok: LAYER_IDS.some((id) => out[id].ok), layers: out };
}

module.exports = { tile, probe, stats, MAX_ZOOM, LAYER_IDS };
