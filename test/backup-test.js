/* A backup is only a backup if it comes back. This proves the round trip. */
'use strict';
const fs = require('fs');
const path = require('path');
const BASE = process.env.BASE_URL || 'http://localhost:3401';
const DATA_DIR = process.env.DATA_DIR;
let cookie = '';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n}${x ? ' — ' + x : ''}`); } };
async function req(method, p, body) {
  const res = await fetch(BASE + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie }, body: body ? JSON.stringify(body) : undefined });
  const setc = res.headers.get('set-cookie'); if (setc) cookie = setc.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => null) };
}
const upload = async (p, buffer, name = 'backup.zip') => {
  const form = new FormData();
  form.append('file', new Blob([buffer]), name);
  const res = await fetch(BASE + p, { method: 'POST', headers: { cookie }, body: form });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

(async () => {
  await req('POST', '/api/admin/login', { email: 'hankalfr@gmail.com', password: 'Testing123!' });
  const host = (await req('POST', '/api/admin/staff', { name: 'John Doe 44', email: 'bk@x.test', active: 1 })).data;

  /* ---- something worth backing up: a visit, a photo, a signature ---- */
  const agreement = (await req('GET', '/api/admin/agreements')).data[0];
  const r = await req('POST', '/api/kiosk/signin', {
    full_name: 'John Doe 42', company: 'Backup Co', phone: '415-268-8001',
    visit_type: 'visitor', host_id: host.id, photo: PNG,
    documents: [{ agreement_id: agreement.id, signature: PNG, answers: {} }],
    client_ref: 'bk-' + Date.now()
  });
  const visitId = r.data.visit.id;
  ok('a visit with a photo and a signature exists', r.status === 200 && !!visitId, JSON.stringify(r.data).slice(0, 70));
  const detail = (await req('GET', `/api/admin/visits/${visitId}`)).data;
  const photoPath = detail.photo_path;
  const sigPath = detail.signatures[0].signature_path;
  ok('…and both files are on disk', !!photoPath && !!sigPath, `${photoPath} / ${sigPath}`);

  /* ---- taking one ---- */
  let made = await req('POST', '/api/admin/backups');
  ok('a backup can be taken', made.status === 200 && made.data.bytes > 0, JSON.stringify(made.data).slice(0, 90));
  ok('it is a single archive, not a bare database', /\.zip$/.test(made.data.file), made.data.file);
  ok('it says what is inside it', made.data.counts && made.data.counts.visits > 0, JSON.stringify(made.data.counts));
  ok('it carries the uploaded files as well as the database',
    made.data.media_files > 0 && made.data.entries > made.data.media_files,
    `${made.data.media_files} file(s), ${made.data.entries} entries`);

  /* ---- what is actually in it ---- */
  const dl = await fetch(`${BASE}/api/admin/backups/${encodeURIComponent(made.data.file)}`, { headers: { cookie } });
  const archive = Buffer.from(await dl.arrayBuffer());
  ok('it downloads', dl.status === 200 && archive.length > 0, `${dl.status}, ${archive.length} bytes`);
  ok('and it really is a ZIP', archive.slice(0, 2).toString() === 'PK', archive.slice(0, 4).toString('hex'));

  const unzip = require('../server/unzip');
  const entries = unzip.readZip(archive);
  const names = [...entries.keys()];
  ok('the database is in it', names.includes('smartlobby.db'));
  ok('there is a manifest', names.includes('manifest.json'));
  ok('the visitor photo is in it', names.includes(`uploads${photoPath.replace('/media', '')}`),
    names.filter((n) => n.includes('photos')).join(',') || 'no photo entries');
  ok('the signature is in it', names.includes(`uploads${sigPath.replace('/media', '')}`),
    names.filter((n) => n.includes('signatures')).join(',') || 'no signature entries');
  ok('the database inside opens as a database',
    entries.get('smartlobby.db').slice(0, 15).toString() === 'SQLite format 3',
    entries.get('smartlobby.db').slice(0, 15).toString());
  const manifest = JSON.parse(entries.get('manifest.json').toString());
  ok('the manifest counts match the database', manifest.counts.visits === made.data.counts.visits,
    JSON.stringify(manifest.counts));

  /*
   * ---- the drill: proving it would restore, without restoring it ----
   *
   * Everything above says the archive is readable. This is the other question,
   * and the only one that matters on the day: would it actually put the site
   * back? Schema, accounts, and the photos the records point at included.
   */
  const countBefore = (await req('GET', '/api/admin/backups')).data.backups.length;
  const drill = await req('POST', `/api/admin/backups/${encodeURIComponent(made.data.file)}/drill`);
  ok('a backup can be tested without being restored',
    drill.status === 200 && drill.data.ok === true, JSON.stringify(drill.data).slice(0, 140));
  ok('…and says it would restore', drill.data.restorable === true);
  ok('…with nothing worth warning about, on one just taken',
    (drill.data.warnings || []).length === 0, JSON.stringify(drill.data.warnings));
  ok('…naming what would come back', drill.data.counts.visits > 0 && drill.data.counts.users > 0,
    JSON.stringify(drill.data.counts));
  ok('…and that every file the records point at is in the archive',
    drill.data.referenced_files > 0 && drill.data.missing_files === 0,
    `${drill.data.missing_files} missing of ${drill.data.referenced_files}`);
  ok('…and how far back it goes', !!drill.data.first_visit && !!drill.data.last_visit,
    `${drill.data.first_visit} → ${drill.data.last_visit}`);

  const after = (await req('GET', '/api/admin/backups')).data;
  ok('testing a backup changes nothing — no restore is staged',
    !after.health.pending_restore, 'a restore was staged');
  ok('…and no safety copy was written as a side effect, the way staging one does',
    after.backups.length === countBefore, `${countBefore} before, ${after.backups.length} after`);

  const missing = await req('POST', '/api/admin/backups/no-such-backup.zip/drill');
  ok('testing a backup that is not there says so rather than throwing',
    missing.status === 400 && missing.data.ok === false, JSON.stringify(missing.data).slice(0, 90));

  /*
   * A database-only copy is the trap this is really for: it restores
   * perfectly, and every face on it comes back as a broken image.
   */
  const dbOnly = require('../server/backup').create({ includeMedia: false });
  const thin = require('../server/backup').drill(dbOnly.file);
  ok('a database-only copy is still reported as restorable', thin.ok && thin.restorable === true,
    JSON.stringify(thin).slice(0, 120));
  ok('…but warns that the photos would come back broken',
    thin.missing_files > 0 && thin.warnings.some((w) => /not in this archive/.test(w)),
    JSON.stringify(thin.warnings));

  /* ---- reading one back, without changing anything ---- */
  let look = await upload('/api/admin/restore/check', archive);
  ok('a real backup is recognised', look.status === 200 && look.data.ok === true, JSON.stringify(look.data).slice(0, 90));
  ok('…and reports what it holds', look.data.counts.visits > 0 && look.data.media_files > 0,
    JSON.stringify({ counts: look.data.counts, media: look.data.media_files }));

  look = await upload('/api/admin/restore/check', Buffer.from('this is not a zip at all'));
  ok('a file that is not a ZIP is refused', look.data.ok === false && /ZIP/i.test(look.data.error), JSON.stringify(look.data));

  const notOurs = require('../server/zip');
  const strayPath = path.join(DATA_DIR || '.', 'stray.zip');
  const stray = notOurs.create(strayPath);
  stray.add('something-else.txt', Buffer.from('not a backup'));
  stray.finish();
  look = await upload('/api/admin/restore/check', fs.readFileSync(strayPath));
  ok('a ZIP that is not a backup is refused', look.data.ok === false && /smartlobby\.db/.test(look.data.error),
    JSON.stringify(look.data));
  fs.unlinkSync(strayPath);

  /*
   * A perfectly good ZIP whose smartlobby.db is rubbish. Corrupting the bytes
   * inside the real archive would not do it: the entry is deflated, so the
   * database is not sitting there in the clear to be damaged.
   */
  const badPath = path.join(DATA_DIR || '.', 'damaged.zip');
  const bad = notOurs.create(badPath);
  bad.add('smartlobby.db', Buffer.from('SQLite format 3\u0000 but the rest of this is nonsense'.repeat(20)));
  bad.finish();
  look = await upload('/api/admin/restore/check', fs.readFileSync(badPath));
  ok('a backup with a damaged database in it is refused',
    look.data.ok === false && /verify|readable/i.test(look.data.error || ''), JSON.stringify(look.data).slice(0, 110));
  fs.unlinkSync(badPath);

  // A valid database that is not this application's is not a backup either.
  const foreignPath = path.join(DATA_DIR || '.', 'foreign.zip');
  const { DatabaseSync: MakeDb } = require('node:sqlite');
  const otherDbPath = path.join(DATA_DIR || '.', 'foreign.db');
  const other = new MakeDb(otherDbPath);
  other.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY)');
  other.close();
  const foreign = notOurs.create(foreignPath);
  foreign.add('smartlobby.db', fs.readFileSync(otherDbPath));
  foreign.finish();
  look = await upload('/api/admin/restore/check', fs.readFileSync(foreignPath));
  ok('somebody else\'s database is refused', look.data.ok === false, JSON.stringify(look.data).slice(0, 110));
  fs.unlinkSync(foreignPath); fs.unlinkSync(otherDbPath);

  /* ------------------------- copying it off the machine, to OneDrive ------ */

  /*
   * A stand-in for the Power Automate flow: it keeps what it is sent, so the
   * test can open the upload and check a real archive arrived intact rather
   * than merely that something was posted.
   */
  const http = require('http');
  const landed = [];
  const sink = http.createServer((rq, rs) => {
    const chunks = [];
    rq.on('data', (c) => chunks.push(c));
    rq.on('end', () => {
      landed.push({
        url: rq.url,
        headers: rq.headers,
        body: Buffer.concat(chunks)
      });
      rs.writeHead(200).end('ok');
    });
  });
  await new Promise((go) => sink.listen(0, '127.0.0.1', go));
  const flow = `http://127.0.0.1:${sink.address().port}/workflows/fake`;

  let t = await req('POST', '/api/admin/backups/offsite/test', { url: flow, secret: 'shared-word' });
  ok('a test file reaches the destination', t.data.ok === true, JSON.stringify(t.data));
  ok('…carrying the filename in the address', /[?&]name=/.test(landed[0].url), landed[0].url);
  ok('…and in a header too', !!landed[0].headers['x-filename'], JSON.stringify(landed[0].headers['x-filename']));
  ok('…with the shared word, so the flow can check it',
    landed[0].headers['x-smart-lobby-secret'] === 'shared-word', landed[0].headers['x-smart-lobby-secret']);

  await req('PUT', '/api/admin/settings', { backup: { offsite_enabled: true, offsite_url: flow } });
  landed.length = 0;
  const sent = await req('POST', '/api/admin/backups');
  ok('a new backup is copied off as it is written', sent.data.offsite && sent.data.offsite.ok === true,
    JSON.stringify(sent.data.offsite));
  ok('exactly one upload arrived', landed.length === 1, String(landed.length));

  const arrived = landed[0].body;
  ok('what arrived is the archive itself, not base64 of it',
    arrived.slice(0, 2).toString() === 'PK', arrived.slice(0, 4).toString('hex'));
  ok('…the same size the server reported', arrived.length === sent.data.bytes,
    `${arrived.length} vs ${sent.data.bytes}`);
  const arrivedEntries = unzip.readZip(arrived);
  ok('…and it opens, with the database in it', arrivedEntries.has('smartlobby.db'));
  ok('…and the visitor photos with it',
    [...arrivedEntries.keys()].some((k) => k.startsWith('uploads/')),
    [...arrivedEntries.keys()].slice(0, 4).join(','));
  ok('the sent name matches the backup that was written',
    decodeURIComponent(landed[0].url.split('name=')[1] || '') === sent.data.file,
    `${landed[0].url} vs ${sent.data.file}`);

  /* ---- a destination that is down must not lose the backup ---- */
  await new Promise((go) => sink.close(go));
  const orphaned = await req('POST', '/api/admin/backups');
  ok('a backup is still written when the destination is unreachable',
    orphaned.status === 200 && orphaned.data.ok === true && orphaned.data.bytes > 0,
    JSON.stringify(orphaned.data).slice(0, 80));
  ok('…and it says the copy did not get there', orphaned.data.offsite && orphaned.data.offsite.ok === false,
    JSON.stringify(orphaned.data.offsite));
  ok('…in words that say what to do', /reach|answer/i.test((orphaned.data.offsite || {}).error || ''),
    (orphaned.data.offsite || {}).error);
  ok('the file is on disk regardless',
    (await req('GET', '/api/admin/backups')).data.backups.some((b) => b.file === orphaned.data.file));

  const dash = (await req('GET', '/api/admin/dashboard')).data;
  ok('the dashboard reports the failed copy',
    dash.health.backup.offsite.enabled === true && dash.health.backup.offsite.last_ok === false,
    JSON.stringify(dash.health.backup.offsite));

  await req('PUT', '/api/admin/settings', { backup: { offsite_enabled: false, offsite_url: '' } });

  /* ---- the state that gets thrown away, so the restore has something to prove ---- */
  await req('POST', '/api/kiosk/signin', {
    full_name: 'John Doe 43', company: 'Later Co', phone: '415-268-8002',
    visit_type: 'visitor', host_id: host.id, client_ref: 'after-' + Date.now()
  });
  const before = (await req('GET', '/api/admin/visits?limit=100')).data;
  ok('somebody was added after the backup was taken',
    before.some((v) => v.full_name === 'John Doe 43'));

  /* ---- staging it ---- */
  const staged = await upload('/api/admin/restore', archive);
  ok('the restore is accepted', staged.status === 200 && staged.data.ok === true, JSON.stringify(staged.data).slice(0, 110));
  ok('…and says it needs a restart', /start/i.test(staged.data.message || ''), staged.data.message);
  ok('…having first backed up what it is about to replace', !!staged.data.safety_backup, String(staged.data.safety_backup));
  ok('the safety copy is in the list',
    (await req('GET', '/api/admin/backups')).data.backups.some((b) => b.file === staged.data.safety_backup));

  ok('nothing has changed yet — it is still the newer data',
    (await req('GET', '/api/admin/visits?limit=100')).data.some((v) => v.full_name === 'John Doe 43'));
  ok('the dashboard says a restore is waiting',
    (await req('GET', '/api/admin/dashboard')).data.health.backup.pending_restore === true);

  const pending = path.join(DATA_DIR, 'restore-pending.zip');
  ok('the archive is staged on disk', fs.existsSync(pending));

  /* ---- cancelling ---- */
  const cancelled = await req('DELETE', '/api/admin/restore');
  ok('a staged restore can be cancelled', cancelled.data.ok === true && cancelled.data.cancelled === true,
    JSON.stringify(cancelled.data));
  ok('…and the staged file goes with it', !fs.existsSync(pending));

  /* ---- staged again, for the runner's restart to apply ---- */
  const again = await upload('/api/admin/restore', archive);
  ok('it can be staged again', again.data.ok === true, JSON.stringify(again.data).slice(0, 80));

  // Applied out here, exactly as the next server start would, then checked
  // against a fresh read of the file — this is the whole point of a backup.
  const boot = require('../server/restore-boot');
  const applied = boot.applyPending();
  ok('applying it reports what came back', applied && applied.media > 0, JSON.stringify(applied));

  const { DatabaseSync } = require('node:sqlite');
  const restored = new DatabaseSync(path.join(DATA_DIR, 'smartlobby.db'), { readOnly: true });
  const names2 = restored.prepare('SELECT full_name FROM visitors').all().map((v) => v.full_name);
  ok('the visitor from the backup is back', names2.includes('John Doe 42'), names2.join(','));
  ok('the one added afterwards is gone', !names2.includes('John Doe 43'), names2.join(','));
  const sig = restored.prepare('SELECT signature_path FROM signatures ORDER BY id DESC LIMIT 1').get();
  ok('their signature record came back', !!sig && !!sig.signature_path, JSON.stringify(sig));
  restored.close();

  const liveDir = path.join(DATA_DIR, 'uploads');
  ok('the photo file is back on disk', fs.existsSync(path.join(liveDir, photoPath.replace('/media/', ''))),
    photoPath);
  ok('the signature file is back on disk', fs.existsSync(path.join(liveDir, sigPath.replace('/media/', ''))),
    sigPath);
  ok('the staged archive is cleared once applied', !fs.existsSync(pending));
  ok('applying again with nothing staged does nothing', require('../server/restore-boot').applyPending() === null);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
