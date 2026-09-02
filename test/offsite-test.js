/*
 * Getting a backup off the machine when it is bigger than the far end will
 * take in one go — which a site keeping ninety days of photos passes inside
 * a fortnight.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
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

/* Stands in for the Power Automate flow, and refuses what a real one would. */
const uploads = [];
let refuseOver = Infinity;
const flow = http.createServer((q, res) => {
  const chunks = [];
  q.on('data', (c) => chunks.push(c));
  q.on('end', () => {
    const body = Buffer.concat(chunks);
    const name = new URL(q.url, 'http://x').searchParams.get('name') || q.headers['x-filename'];
    if (body.length > refuseOver) { res.writeHead(413); return res.end('too large'); }
    uploads.push({ name, bytes: body.length, type: q.headers['content-type'] });
    res.writeHead(202); res.end('');
  });
});
const FLOW_URL = 'http://127.0.0.1:2755/offsite';

(async () => {
  await new Promise((r) => flow.listen(2755, '127.0.0.1', r));
  await req('POST', '/api/admin/login', { email: 'owner@example.test', password: 'Testing123!' });

  const DATA_DIR = process.env.DATA_DIR || require('../server/db').DATA_DIR;
  const photos = path.join(DATA_DIR, 'uploads', 'private', 'photos');
  fs.mkdirSync(photos, { recursive: true });

  await req('PUT', '/api/admin/settings', {
    backup: { offsite_enabled: true, offsite_url: FLOW_URL, offsite_include_media: true }
  });

  /* ---- a small one still goes in one piece ---- */
  uploads.length = 0;
  let r = await req('POST', '/api/admin/backups', {});
  ok('a backup is written', r.status === 200 && r.data.ok, JSON.stringify(r.data).slice(0, 120));
  ok('…and goes off in one piece while it fits',
    uploads.length === 1 && !(r.data.offsite || {}).split, JSON.stringify(r.data.offsite));
  ok('…as a zip, not as text', uploads[0].type === 'application/zip', uploads[0].type);

  /* ---- now make it too big for one go ---- */
  const offsite = require('../server/offsite');
  const blob = Buffer.alloc(400 * 1024, 9);
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(photos, `big-${i}.jpg`), blob);
  // Smaller than the real cap so this finishes in seconds rather than filling
  // a disk to reach ninety megabytes.
  refuseOver = 6 * 1024 * 1024;
  const backup = require('../server/backup');
  const built = backup.createParts({ maxBytes: Math.floor(refuseOver * 0.85) });

  ok('a big backup is cut into several pieces', built.parts.length > 2, String(built.parts.length));
  ok('the database goes first, and on its own',
    built.parts[0].kind === 'database' && built.parts[0].index === 1, JSON.stringify(built.parts[0]));
  ok('…and everything after it holds files',
    built.parts.slice(1).every((p) => p.kind === 'files'), JSON.stringify(built.parts.map((p) => p.kind)));
  ok('every piece fits through the far end',
    built.parts.every((p) => p.bytes <= refuseOver),
    JSON.stringify(built.parts.map((p) => Math.round(p.bytes / 1024) + 'k')));
  ok('the pieces are numbered so a gap is obvious',
    built.parts.every((p, i) => p.index === i + 1 && p.total === built.parts.length),
    JSON.stringify(built.parts.map((p) => `${p.index}of${p.total}`)));
  ok('…and named so the order is plain in a folder',
    built.parts.every((p) => /-\d+of\d+-(database|files)\.zip$/.test(p.file)),
    JSON.stringify(built.parts.map((p) => p.file)));

  /* ---- every piece is a real archive on its own ---- */
  const dbPart = backup.inspect(fs.readFileSync(built.parts[0].path));
  ok('the database piece verifies as a backup', dbPart.ok && dbPart.counts.users >= 1, JSON.stringify(dbPart));
  const filePart = backup.inspect(fs.readFileSync(built.parts[1].path));
  ok('a files piece is recognised rather than refused as the wrong file',
    filePart.ok && filePart.files_only === true, JSON.stringify(filePart));
  ok('…and says how many files it holds and which piece it is',
    filePart.media_files > 0 && filePart.part === 2, JSON.stringify(filePart));

  /* ---- restoring a files piece brings its files back ---- */
  const victim = path.join(photos, 'big-0.jpg');
  fs.unlinkSync(victim);
  ok('a photo can go missing', !fs.existsSync(victim));
  const holder = built.parts.slice(1).find((p) => {
    const seen = backup.inspect(fs.readFileSync(p.path));
    return seen.ok && seen.media_files > 0;
  });
  for (const p of built.parts.slice(1)) backup.stageRestore(fs.readFileSync(p.path));
  ok('restoring the files pieces puts it back', fs.existsSync(victim), String(!!holder));
  ok('…without staging a database restore, because there is nothing to swap',
    !backup.pendingRestore());

  /* ---- and the real path sends them all ---- */
  // The real path batches against the real cap, so the stand-in has to accept
  // what a real flow would; what is under test here is that every piece goes.
  refuseOver = Infinity;
  uploads.length = 0;
  const result = await offsite.copyInParts({ file: 'test-backup.zip' }, 30 * 1024 * 1024);
  ok('a split copy reports itself as split', result.split === true, JSON.stringify(result).slice(0, 140));
  ok('…and every piece got there', result.ok && result.parts_sent === result.parts,
    `${result.parts_sent} of ${result.parts}`);
  ok('…which is what actually arrived', uploads.length === result.parts,
    `${uploads.length} uploads, ${result.parts} parts`);
  ok('the database piece arrived first', /1of\d+-database/.test(uploads[0].name || ''), uploads[0].name);

  /* ---- a far end that refuses one piece ---- */
  uploads.length = 0;
  refuseOver = 1024;   // everything but the smallest is refused now
  const partial = await offsite.copyInParts({ file: 'test-backup-2.zip' }, 30 * 1024 * 1024);
  ok('a partial failure is reported as one, not as success', partial.ok === false, JSON.stringify(partial).slice(0, 140));
  ok('…saying how many pieces got there', partial.parts_sent < partial.parts,
    `${partial.parts_sent} of ${partial.parts}`);
  ok('…and whether the database itself is safely away',
    typeof partial.database_ok === 'boolean', JSON.stringify(partial.database_ok));

  const health = (await req('GET', '/api/admin/backups')).data.health.offsite;
  ok('the dashboard is told the last copy did not get there', health.last_ok === false,
    JSON.stringify(health));

  /*
   * ---- nothing is left lying in the scratch directory ----
   *
   * Excluding this suite's own fixture, which is still open and is cleaned up
   * on the line below. It used to be counted, and the check passed only when
   * the fixture and a real split happened to land in the same second and share
   * a directory name — so the internal cleanup removed the fixture too. That
   * is a coin toss, not a test.
   */
  const tmp = path.join(DATA_DIR, 'tmp');
  const mine = path.basename(built.dir);
  const leftovers = fs.existsSync(tmp)
    ? fs.readdirSync(tmp).filter((n) => n.startsWith('offsite-') && n !== mine) : [];
  ok('the pieces are cleaned up after sending', leftovers.length === 0, leftovers.join(','));

  fs.rmSync(built.dir, { recursive: true, force: true });
  await req('PUT', '/api/admin/settings', { backup: { offsite_enabled: false } });
  flow.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
