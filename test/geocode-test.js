/*
 * Placing the site by typing its address.
 *
 * Pointed at a stub rather than at OpenStreetMap. Not to avoid the network —
 * though a suite that fails when somebody else's service is having an
 * afternoon is a suite people learn to ignore — but because the interesting
 * cases are the ones a real geocoder will not produce on demand: nothing
 * found, a refusal, unreadable rubbish, and a server with no way out at all.
 * Those are what the settings page has to say something useful about, and
 * they are exactly what you cannot ask a working service for.
 *
 * The stub is started here and GEOCODE_URL points the server at it, which is
 * the same knob a site would use for an internal geocoder.
 */
'use strict';
const http = require('http');
const BASE = process.env.BASE_URL || 'http://localhost:3401';
let cookie = '';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n}${x ? ' — ' + x : ''}`); } };

async function req(method, p, body) {
  const res = await fetch(BASE + p, {
    method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie },
    body: body ? JSON.stringify(body) : undefined
  });
  const setc = res.headers.get('set-cookie'); if (setc) cookie = setc.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => null) };
}

const geocode = (q) => req('GET', `/api/admin/geocode?q=${encodeURIComponent(q)}`);

(async () => {
  await req('POST', '/api/admin/login', { email: 'owner@example.test', password: 'Testing123!' });

  const before = (await geocode('Riverside Way')).data;
  /*
   * Whatever the server was started with. On a full run GEOCODE_URL is unset,
   * so this reaches the real Nominatim or fails to — either is a fine answer
   * and neither is this suite's business, so it only checks the shape.
   */
  ok('a lookup always answers with something the page can show',
    !!(before && (Array.isArray(before.results) || before.message)),
    JSON.stringify(before).slice(0, 100));

  /* ---- the answers a real service will not give on demand ---- */

  let seenAgent = null;
  let seenQuery = null;
  const stub = http.createServer((r, res) => {
    seenAgent = r.headers['user-agent'];
    seenQuery = new URL(r.url, 'http://x').searchParams.get('q');
    const mode = new URL(r.url, 'http://x').searchParams.get('mode')
      || (seenQuery.includes('NOTHING') ? 'empty'
        : seenQuery.includes('BROKEN') ? 'rubbish'
          : seenQuery.includes('REFUSED') ? 'refuse' : 'ok');
    if (mode === 'refuse') { res.writeHead(429).end('slow down'); return; }
    if (mode === 'rubbish') { res.writeHead(200, { 'Content-Type': 'application/json' }).end('not json at all'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(mode === 'empty' ? [] : [
      { display_name: '14 Riverside Way, Oakland, California, USA', lat: '37.7955', lon: '-122.2712' },
      { display_name: 'Riverside Way, Portland, Oregon, USA', lat: '45.5152', lon: '-122.6784' },
      // Rows a geocoder can return that are no use as coordinates.
      { display_name: 'Nowhere in particular', lat: 'not-a-number', lon: '-122.0' },
      { display_name: '', lat: '1.0', lon: '2.0' }
    ]));
  });
  await new Promise((done) => stub.listen(0, '127.0.0.1', done));
  const stubUrl = `http://127.0.0.1:${stub.address().port}/search`;

  /*
   * The module is exercised directly here. Restarting the whole server with a
   * different environment mid-suite would prove the same thing at ten times
   * the cost, and this is the piece that does the work.
   */
  const path = require('path');
  const modulePath = path.join(__dirname, '..', 'server', 'geocode.js');
  process.env.GEOCODE_URL = stubUrl;
  delete require.cache[require.resolve(modulePath)];
  const geo = require(modulePath);

  let r = await geo.lookup('14 Riverside Way');
  ok('an address comes back as coordinates', r.results && r.results.length >= 2,
    JSON.stringify(r).slice(0, 120));
  ok('…with the numbers as numbers, not strings',
    typeof r.results[0].lat === 'number' && typeof r.results[0].lng === 'number',
    JSON.stringify(r.results[0]));
  ok('…the right way round — latitude from lat, longitude from lon',
    Math.abs(r.results[0].lat - 37.7955) < 0.001 && Math.abs(r.results[0].lng + 122.2712) < 0.001,
    JSON.stringify(r.results[0]));

  /*
   * Every match, not just the first. A street name exists in forty towns, and
   * a fence quietly placed on the wrong one is found out by a visitor who
   * cannot sign in.
   */
  ok('every match is offered, so the wrong town can be spotted',
    r.results.length === 2 && /Oakland/.test(r.results[0].label) && /Portland/.test(r.results[1].label),
    JSON.stringify(r.results.map((x) => x.label)));
  ok('…and rows that are not usable coordinates are dropped rather than shown',
    r.results.every((x) => x.label && Number.isFinite(x.lat) && Number.isFinite(x.lng)));

  ok('the lookup identifies itself, as the service asks callers to',
    /SmartLobby/.test(seenAgent || ''), seenAgent);

  /* ---- and the ways it goes wrong ---- */
  r = await geo.lookup('NOTHING AT ALL');
  ok('nothing found says so, and suggests what to try',
    r.error === 'not_found' && /Nothing found/.test(r.message), JSON.stringify(r));

  r = await geo.lookup('REFUSED please');
  ok('a service that refuses is reported with its status',
    r.error === 'lookup_failed' && /429/.test(r.message), JSON.stringify(r));

  r = await geo.lookup('BROKEN response');
  ok('an unreadable answer does not throw', r.error === 'lookup_failed', JSON.stringify(r));

  r = await geo.lookup('ab');
  ok('a couple of characters is not a lookup worth making',
    r.error === 'too_short' && seenQuery !== 'ab', JSON.stringify(r));

  /*
   * The case a hosted server actually hits: no route out. It hangs rather than
   * refusing, so the message has to arrive on a timer and name the other two
   * ways of placing the site.
   */
  process.env.GEOCODE_URL = 'http://127.0.0.1:9/search';   // discard port
  delete require.cache[require.resolve(modulePath)];
  const offline = require(modulePath);
  r = await offline.lookup('14 Riverside Way');
  ok('a server with no way out says so, and names the other two ways',
    r.error === 'unreachable' && /coordinates/.test(r.message) && /Use where I am now/.test(r.message),
    JSON.stringify(r));

  delete process.env.GEOCODE_URL;
  await new Promise((done) => stub.close(done));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
