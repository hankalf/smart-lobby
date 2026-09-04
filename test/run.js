#!/usr/bin/env node
'use strict';
/**
 * Runs every suite against a real server, and says what broke.
 *
 *   npm test                 everything
 *   npm test -- board card   only the suites whose name contains one of these
 *   npm test -- --keep       leave the test database behind to poke at
 *
 * Two things here are not fussiness, they are what makes the results mean
 * anything:
 *
 *   - Each suite gets a freshly started server. The rate limiters are
 *     per-process, so back-to-back suites sharing one would start tripping
 *     them and failing for a reason that has nothing to do with the code.
 *
 *   - The order is fixed rather than alphabetical. api-test performs the
 *     first-run setup and leaves the fixtures every later suite reads;
 *     browser-test needs those fixtures untouched, so it comes straight
 *     after; and probe-test deletes the device fixture on purpose, so it
 *     goes last.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const browser = require('./browser');

const PORT = Number(process.env.TEST_PORT) || 3401;
const BASE = `http://localhost:${PORT}`;
const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.TEST_DATA_DIR || path.join(os.tmpdir(), 'smart-lobby-test');

/** Suites needing a browser are skipped, loudly, when there is not one. */
const SUITES = [
  { name: 'api', file: 'api-test.js' },
  // Straight after api, which performs the first-run setup that seeds them.
  { name: 'examples', file: 'examples-test.js' },
  { name: 'browser', file: 'browser-test.js', browser: true },
  { name: 'settings-smoke', file: 'settings-smoke.js', browser: true },
  { name: 'edge', file: 'edge-test.js' },
  { name: 'repeat', file: 'repeat-test.js' },
  { name: 'spanish', file: 'spanish-test.js' },
  { name: 'race', file: 'race-test.js' },
  { name: 'offline', file: 'offline-test.js' },
  { name: 'phone', file: 'phone-test.js' },
  { name: 'aamva', file: 'aamva-test.js' },
  { name: 'idscan', file: 'idscan-test.js' },
  { name: 'teams', file: 'teams-test.js' },
  // A button in the settings must not be able to stop the gate.
  { name: 'robust', file: 'robust-test.js' },
  { name: 'archive', file: 'archive-test.js' },
  { name: 'card', file: 'card-test.js' },
  { name: 'badgeno', file: 'badgeno-test.js' },
  { name: 'delivery', file: 'delivery-test.js' },
  { name: 'companies', file: 'companies-test.js' },
  { name: 'compliance', file: 'compliance-test.js' },
  { name: 'reports', file: 'reports-test.js' },
  { name: 'print', file: 'print-test.js' },
  { name: 'check', file: 'check-test.js', browser: true },
  { name: 'printer', file: 'printer-test.js' },
  { name: 'sign', file: 'sign-test.js', browser: true },
  { name: 'geocode', file: 'geocode-test.js' },
  // Drives a browser for half of it, and puts the geofence settings back after.
  { name: 'map', file: 'map-test.js', browser: true },
  { name: 'search', file: 'search-test.js' },
  { name: 'visits', file: 'visits-test.js' },
  { name: 'undo', file: 'undo-test.js' },
  { name: 'selfcheckin', file: 'selfcheckin-test.js' },
  { name: 'recover', file: 'recover-test.js', browser: true },
  { name: 'projectdefault', file: 'projectdefault-test.js' },
  { name: 'expected', file: 'expected-test.js' },
  // Forty people through one gate in one day, and every view of them agreeing.
  { name: 'day', file: 'day-test.js' },
  { name: 'notifycards', file: 'notifycards-test.js', browser: true },
  /*
   * Where each post lands: the channel that hears everything, and one per
   * type. After card-test and notifycards rather than before, because opening
   * the notifications panel saves a design per event — which is the panel
   * doing its job, and which leaves card-test's older shared design no longer
   * the one in force. Every browser suite that drives that panel sits here.
   */
  { name: 'channels', file: 'channels-test.js' },
  { name: 'board', file: 'board-test.js' },
  { name: 'account', file: 'account-test.js' },
  { name: 'backup', file: 'backup-test.js' },
  { name: 'offsite', file: 'offsite-test.js' },
  { name: 'storage', file: 'storage-test.js' },
  { name: 'roles', file: 'roles-test.js' },
  { name: 'roles-ui', file: 'roles-ui-test.js', browser: true },
  { name: 'vtypes', file: 'vtypes-test.js', browser: true },
  // Renaming a type's key, and everything filed under it moving with it.
  { name: 'rekey', file: 'rekey-test.js' },
  { name: 'autosave', file: 'autosave-test.js', browser: true },
  { name: 'xss', file: 'xss-test.js', browser: true },
  { name: 'attack', file: 'attack-test.js' },
  { name: 'admin-smoke', file: 'admin-smoke.js', browser: true },
  { name: 'idscan-ui', file: 'idscan-ui-test.js', browser: true },
  { name: 'settings-nav', file: 'settings-nav-test.js', browser: true },
  // Opens every page there is. The net under any rearrangement of the admin.
  { name: 'sweep', file: 'sweep-test.js', browser: true },
  /*
   * What the install can actually do, asked of the machine it runs on.
   * Late, because it drives several settings into deliberately broken
   * states to prove they are reported, and puts them back after.
   */
  { name: 'selfcheck', file: 'selfcheck-test.js' },
  { name: 'probe', file: 'probe-test.js' }
];

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const only = args.filter((a) => !a.startsWith('--'));

function freshData() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Stand-ins for LibreOffice and poppler, used only where the real ones are
 * missing — the deck upload path needs *something* that turns a document into
 * page images, and the suites should not be skipped on a laptop without them.
 */
function pathWithStubs() {
  const stubs = path.join(__dirname, 'fakebin');
  const has = (bin) => {
    try {
      return require('child_process')
        .spawnSync('which', [bin], { encoding: 'utf8' }).stdout.trim().length > 0;
    } catch { return false; }
  };
  return (has('soffice') && has('pdftoppm')) ? process.env.PATH : `${stubs}:${process.env.PATH}`;
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server/index.js'], {
      cwd: ROOT,
      env: { ...process.env, PATH: pathWithStubs(), DATA_DIR, PORT: String(PORT), NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    child.on('exit', (code) => {
      if (!child.ready) reject(new Error(`the server exited with ${code}:\n${log}`));
    });

    // Poll rather than watch for a line: it is the port answering that matters.
    const deadline = Date.now() + 20_000;
    const poke = () => {
      http.get(`${BASE}/api/health`, (res) => {
        res.resume();
        child.ready = true;
        resolve(child);
      }).on('error', () => {
        if (Date.now() > deadline) {
          child.kill('SIGKILL');
          return reject(new Error(`the server never answered on ${PORT}:\n${log}`));
        }
        setTimeout(poke, 250);
      });
    };
    poke();
  });
}

const stop = (child) => new Promise((resolve) => {
  if (!child || child.exitCode !== null) return resolve();
  child.once('exit', resolve);
  child.kill('SIGKILL');
});

function runSuite(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, file)], {
      cwd: ROOT,
      env: { ...process.env, BASE_URL: BASE, DATA_DIR },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

/**
 * What a suite says about itself.
 *
 * A suite that crashed never prints its tally, and used to be summarised as
 * "0 passed, 0 failed" — which the totals then added nothing to. A full run
 * came back reading "1285 checks passed, 0 failed" with a suite missing
 * entirely, and the only thing that gave it away was somebody noticing the
 * count had dropped by 89 since the last run. A count nobody is comparing is
 * not a control, so `crashed` is carried out of here and counted.
 */
function summarise(out) {
  const counted = out.match(/(\d+) passed, (\d+) failed/);
  if (counted) {
    return { line: counted[0], passed: Number(counted[1]), failed: Number(counted[2]), counted: true };
  }
  const lines = out.trim().split('\n').filter(Boolean);
  return {
    line: (lines[lines.length - 1] || '(no output)').slice(0, 90),
    passed: 0,
    failed: 0,
    /*
     * Decided by the caller, which knows the exit code. A few suites report
     * "page errors: none" and exit cleanly rather than counting checks; those
     * are not crashes, and calling them crashes would be a new false alarm to
     * replace the old silence.
     */
    counted: false
  };
}

/**
 * How many checks each suite is expected to report, remembered between runs.
 *
 * The tally is the only thing that notices a suite quietly doing less than it
 * did yesterday — a `waitForSelector` that now matches nothing, a loop whose
 * fixture disappeared, a whole file that crashed before its first check. None
 * of those fail; they simply stop counting.
 *
 * Kept beside the data directory rather than in the repository: it is a note
 * about this machine's last run, not a fact about the code, and a number
 * checked in would be wrong for everybody the moment somebody adds a check.
 */
const TALLY_FILE = path.join(DATA_DIR, '..', 'smart-lobby-tally.json');

function readTally() {
  try { return JSON.parse(fs.readFileSync(TALLY_FILE, 'utf8')); } catch { return {}; }
}

function writeTally(tally) {
  try { fs.writeFileSync(TALLY_FILE, JSON.stringify(tally, null, 2)); } catch { /* not worth failing a run over */ }
}

(async () => {
  const chosen = SUITES.filter((s) => !only.length || only.some((o) => s.name.includes(o)));
  if (!chosen.length) {
    console.error(`No suite matches ${only.join(', ')}. Known: ${SUITES.map((s) => s.name).join(', ')}`);
    process.exit(1);
  }

  const canBrowse = browser.available();
  if (!canBrowse && chosen.some((s) => s.browser)) {
    console.log('\n  Playwright is not installed, so the browser suites will be skipped.');
    console.log('  Install it with:  npm install -D playwright && npx playwright install chromium\n');
  }

  freshData();
  console.log(`\n  Smart Lobby — ${chosen.length} suite(s), data in ${DATA_DIR}\n`);

  /*
   * Every suite signs in as the same owner. api-test creates it as part of
   * testing the first-run screen, so on a full run it is already there — but
   * `npm test -- board` starts from an empty database and would otherwise fail
   * on a 401 that says nothing about the board.
   */
  if (!chosen.some((s) => s.name === 'api')) {
    const seed = await startServer();
    const setup = await fetch(`${BASE}/api/admin/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.test', password: 'Testing123!', name: 'Test Owner', org_name: "Nature's Touch Builds" })
    }).catch(() => null);
    const jar = setup && (setup.headers.get('set-cookie') || '').split(';')[0];
    // A project and a device, because a contractor sign-in needs a project and
    // several suites open a device page. api-test makes these itself.
    const post = (path, body) => fetch(BASE + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie: jar || '' }, body: JSON.stringify(body)
    }).then((r) => r.json().catch(() => null)).catch(() => null);
    const patch = (path, body) => fetch(BASE + path, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', cookie: jar || '' }, body: JSON.stringify(body)
    }).then((r) => r.json().catch(() => null)).catch(() => null);

    /*
     * Enough of a site for any one suite to run on its own.
     *
     * Not decoration. Five suites could only run after api-test had been
     * through first, which meant diagnosing one failure cost a full run —
     * and a suite nobody can run alone is a suite people stop running. The
     * shape here is the smallest thing the dashboard needs to have something
     * to show: a job, a tablet, somebody to visit, and somebody who has
     * visited.
     */
    const project = await post('/api/admin/projects', { name: 'Warehouse extension', code: 'WX1', active: 1 });
    const host = await post('/api/admin/staff',
      { name: 'Jane Doe', email: 'jane@example.test', phone: '415-268-0100', active: 1 });
    /*
     * The Contractor card, switched on. It is off out of the box, and it is
     * the card the kiosk suites walk through — without it they wait thirty
     * seconds for a button that was never going to appear.
     */
    const conf = await fetch(`${BASE}/api/admin/settings`, { headers: { cookie: jar || '' } })
      .then((r) => r.json()).catch(() => null);
    if (conf && Array.isArray(conf.types)) {
      await fetch(`${BASE}/api/admin/settings`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', cookie: jar || '' },
        body: JSON.stringify({
          types: conf.types.map((t) => (t.key === 'contractor' ? { ...t, mode: 'both' } : t)),
          // Spanish, for the same reason: the language bar only exists when
          // somebody has turned the second language on.
          kiosk: { ...(conf.kiosk || {}), spanish_enabled: true }
        })
      }).catch(() => null);
    }

    /*
     * The tablet the kiosk suites open by name, cut down to the two cards they
     * count. Its slug is fixed rather than derived, because /kiosk/front-gate
     * is written into the suites and a tablet renamed in a later test would
     * otherwise take them all down with it.
     */
    const device = await post('/api/admin/devices', { name: 'Front gate' });
    if (device && device.id) {
      await patch(`/api/admin/devices/${device.id}`,
        { slug: 'front-gate', sections: JSON.stringify(['contractor', 'signout']) });
    }

    /*
     * A deck with one slide in it. An empty deck is skipped by the kiosk, so
     * the contractor flow would run straight past the induction the suites
     * are there to check — the slide is what makes it appear at all.
     */
    const deck = await post('/api/admin/slideshows',
      { name: 'Site induction', required_for: ['contractor', 'visitor'],
        min_seconds_per_slide: 0, language: 'en', require_signature: true });
    if (deck && deck.id) {
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const fd = new FormData();
      fd.append('file', new Blob([Buffer.from(png, 'base64')], { type: 'image/png' }), 'slide1.png');
      await fetch(`${BASE}/api/admin/slideshows/${deck.id}/upload`,
        { method: 'POST', headers: { cookie: jar || '' }, body: fd }).catch(() => null);
    }

    /*
     * One person who has actually been on site, so every list, report and
     * record page has a row to open. Several suites look for one and time out
     * waiting rather than saying what is missing.
     *
     * They look for this exact name. It carries a signed document and a
     * completed induction because the suites about how often a document comes
     * round again need somebody who has signed one — an unsigned visitor makes
     * every "already signed" check read the wrong way round.
     */
    const docs = await fetch(`${BASE}/api/admin/agreements`, { headers: { cookie: jar || '' } })
      .then((r) => r.json()).catch(() => null);
    const doc = Array.isArray(docs) ? docs[docs.length - 1] : null;
    const sig = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    await post('/api/kiosk/signin', {
      full_name: 'John Doe 1', company: 'Example Consulting', phone: '415-268-0142',
      visit_type: 'contractor', project_id: project && project.id,
      host_id: host && host.id, client_ref: 'seed-standalone',
      documents: doc ? [{ agreement_id: doc.id, signature: sig, answers: {} }] : [],
      ...(deck && deck.id ? {
        induction_completed: true, slideshow_id: deck.id, induction_signature: sig,
        induction_started_at: new Date().toISOString(), induction_seconds: 42
      } : {})
    });
    await stop(seed);
  }

  let failedSuites = 0;
  let totalPassed = 0;
  let totalFailed = 0;
  let skipped = 0;
  let crashed = 0;
  const wasExpecting = readTally();
  const nowRan = {};
  const shrank = [];

  for (const suite of chosen) {
    if (suite.browser && !canBrowse) {
      console.log(`  ${suite.name.padEnd(15)} skipped — no browser`);
      skipped++;
      continue;
    }
    let server;
    try {
      server = await startServer();
    } catch (err) {
      console.log(`  ${suite.name.padEnd(15)} SERVER FAILED — ${err.message.split('\n')[0]}`);
      console.log(err.message);
      failedSuites++;
      continue;
    }
    const { code, out } = await runSuite(suite.file);
    await stop(server);

    const s = summarise(out);
    // A suite that printed no tally *and* did not exit cleanly stopped early.
    s.crashed = !s.counted && code !== 0;
    totalPassed += s.passed;
    totalFailed += s.failed;
    if (s.crashed) crashed++;

    /*
     * A suite that ran fewer checks than last time did not fail — it stopped
     * asking. Reported as its own thing, because it is invisible in both the
     * pass count and the verdict.
     */
    const before = wasExpecting[suite.name];
    if (s.counted) nowRan[suite.name] = s.passed + s.failed;
    if (Number.isFinite(before) && s.counted && (s.passed + s.failed) < before) {
      shrank.push({ name: suite.name, before, now: s.passed + s.failed });
    }
    const ok = code === 0;
    if (!ok) failedSuites++;
    // A crash is marked as one rather than as a suite with nothing to say.
    const mark = s.crashed ? 'CRASH' : (ok ? '   ' : 'FAIL ');
    console.log(`  ${suite.name.padEnd(15)} ${mark} ${s.line}`);
    if (!ok) {
      // Only the failures, so a red run is readable without scrolling.
      const detail = out.split('\n').filter((l) => /^FAIL|^CRASH|^\s+at |Error/.test(l)).slice(0, 12);
      detail.forEach((l) => console.log(`      ${l.trim()}`));
    }
  }

  if (!keep) fs.rmSync(DATA_DIR, { recursive: true, force: true });

  /*
   * Remembered only from a run where nothing crashed and nothing shrank.
   * Writing the tally after a bad run would quietly accept the smaller number
   * as the new normal, which is precisely the thing this is here to stop.
   */
  if (!crashed && !shrank.length) writeTally({ ...wasExpecting, ...nowRan });

  console.log(`\n  ${totalPassed} checks passed, ${totalFailed} failed`
    + `${skipped ? `, ${skipped} suite(s) skipped` : ''}`);

  /*
   * Said plainly and last, because a crashed suite reports no failures and a
   * shrunken one reports none either: both are invisible in the line above.
   */
  if (crashed) {
    console.log(`  ${crashed} suite(s) CRASHED before finishing — their checks did not run at all.`);
  }
  for (const s2 of shrank) {
    console.log(`  ${s2.name} ran ${s2.now} checks, down from ${s2.before} last time — `
      + 'something stopped being asked rather than failing.');
  }

  /*
   * The last line is the one people read, so it has to name the actual
   * problem. A run whose only fault is a suite that shrank has no failures to
   * report and must not end on a sentence about failures.
   */
  const notPassing = failedSuites + crashed;
  if (notPassing) console.log(`  ${notPassing} suite(s) did not pass.\n`);
  else if (shrank.length) console.log(`  ${shrank.length} suite(s) ran fewer checks than last time.\n`);
  else console.log('  Everything passed.\n');
  process.exit(notPassing || shrank.length ? 1 : 0);
})().catch((err) => { console.error('\n  The runner itself failed:', err); process.exit(1); });
