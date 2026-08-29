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
  { name: 'archive', file: 'archive-test.js' },
  { name: 'card', file: 'card-test.js' },
  { name: 'badgeno', file: 'badgeno-test.js' },
  { name: 'delivery', file: 'delivery-test.js' },
  { name: 'companies', file: 'companies-test.js' },
  { name: 'compliance', file: 'compliance-test.js' },
  { name: 'reports', file: 'reports-test.js' },
  { name: 'notifycards', file: 'notifycards-test.js', browser: true },
  { name: 'board', file: 'board-test.js' },
  { name: 'account', file: 'account-test.js' },
  { name: 'backup', file: 'backup-test.js' },
  { name: 'offsite', file: 'offsite-test.js' },
  { name: 'roles', file: 'roles-test.js' },
  { name: 'roles-ui', file: 'roles-ui-test.js', browser: true },
  { name: 'vtypes', file: 'vtypes-test.js', browser: true },
  { name: 'autosave', file: 'autosave-test.js', browser: true },
  { name: 'xss', file: 'xss-test.js', browser: true },
  { name: 'attack', file: 'attack-test.js' },
  { name: 'admin-smoke', file: 'admin-smoke.js', browser: true },
  { name: 'idscan-ui', file: 'idscan-ui-test.js', browser: true },
  { name: 'settings-nav', file: 'settings-nav-test.js', browser: true },
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

/** "40 passed, 0 failed" if a suite says so; its last line otherwise. */
function summarise(out) {
  const counted = out.match(/(\d+) passed, (\d+) failed/);
  if (counted) return { line: counted[0], passed: Number(counted[1]), failed: Number(counted[2]) };
  const lines = out.trim().split('\n').filter(Boolean);
  return { line: (lines[lines.length - 1] || '(no output)').slice(0, 90), passed: 0, failed: 0 };
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
      body: JSON.stringify({ email: 'hankalfr@gmail.com', password: 'Testing123!', name: 'Hank', org_name: "Nature's Touch Builds" })
    }).catch(() => null);
    const jar = setup && (setup.headers.get('set-cookie') || '').split(';')[0];
    // A project and a device, because a contractor sign-in needs a project and
    // several suites open a device page. api-test makes these itself.
    const post = (path, body) => fetch(BASE + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie: jar || '' }, body: JSON.stringify(body)
    }).catch(() => {});
    await post('/api/admin/projects', { name: 'Warehouse extension', code: 'WX1', active: 1 });
    await post('/api/admin/devices', { name: 'Front gate' });
    await stop(seed);
  }

  let failedSuites = 0;
  let totalPassed = 0;
  let totalFailed = 0;
  let skipped = 0;

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
    totalPassed += s.passed;
    totalFailed += s.failed;
    const ok = code === 0;
    if (!ok) failedSuites++;
    console.log(`  ${suite.name.padEnd(15)} ${ok ? '   ' : 'FAIL'} ${s.line}`);
    if (!ok) {
      // Only the failures, so a red run is readable without scrolling.
      const detail = out.split('\n').filter((l) => /^FAIL|^CRASH|^\s+at |Error/.test(l)).slice(0, 12);
      detail.forEach((l) => console.log(`      ${l.trim()}`));
    }
  }

  if (!keep) fs.rmSync(DATA_DIR, { recursive: true, force: true });

  console.log(`\n  ${totalPassed} checks passed, ${totalFailed} failed`
    + `${skipped ? `, ${skipped} suite(s) skipped` : ''}`);
  console.log(failedSuites ? `  ${failedSuites} suite(s) did not pass.\n` : '  Everything passed.\n');
  process.exit(failedSuites ? 1 : 0);
})().catch((err) => { console.error('\n  The runner itself failed:', err); process.exit(1); });
