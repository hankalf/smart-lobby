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
  const host = (await req('POST', '/api/admin/staff', { name: 'Hank Alfred 44', email: 'bk@x.test', active: 1 })).data;

  /* ---- something worth backing up: a visit, a photo, a signature ---- */
  const agreement = (await req('GET', '/api/admin/agreements')).data[0];
  const r = await req('POST', '/api/kiosk/signin', {
    full_name: 'Hank Alfred 42', company: 'Backup Co', phone: '415-268-8001',
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

  /* ---- the state that gets thrown away, so the restore has something to prove ---- */
  await req('POST', '/api/kiosk/signin', {
    full_name: 'Hank Alfred 43', company: 'Later Co', phone: '415-268-8002',
    visit_type: 'visitor', host_id: host.id, client_ref: 'after-' + Date.now()
  });
  const before = (await req('GET', '/api/admin/visits?limit=100')).data;
  ok('somebody was added after the backup was taken',
    before.some((v) => v.full_name === 'Hank Alfred 43'));

  /* ---- staging it ---- */
  const staged = await upload('/api/admin/restore', archive);
  ok('the restore is accepted', staged.status === 200 && staged.data.ok === true, JSON.stringify(staged.data).slice(0, 110));
  ok('…and says it needs a restart', /start/i.test(staged.data.message || ''), staged.data.message);
  ok('…having first backed up what it is about to replace', !!staged.data.safety_backup, String(staged.data.safety_backup));
  ok('the safety copy is in the list',
    (await req('GET', '/api/admin/backups')).data.backups.some((b) => b.file === staged.data.safety_backup));

  ok('nothing has changed yet — it is still the newer data',
    (await req('GET', '/api/admin/visits?limit=100')).data.some((v) => v.full_name === 'Hank Alfred 43'));
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
  ok('the visitor from the backup is back', names2.includes('Hank Alfred 42'), names2.join(','));
  ok('the one added afterwards is gone', !names2.includes('Hank Alfred 43'), names2.join(','));
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
