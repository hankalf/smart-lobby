/*
 * The pressure valve on the disk.
 *
 * A full volume is the one failure with no graceful version: the database
 * stops writing, the kiosk turns people away, and the backup that would have
 * warned you cannot be written either. Photos are what fill it, so the oldest
 * of them go before that happens — but never the recent ones, never quietly,
 * and never when it is switched off.
 *
 * The disk in a test container is not going to be 90% full on demand, so the
 * thresholds are driven from the other end: the module is asked to shed at a
 * mark below where the disk already sits, which is the same code path a real
 * site reaches by filling up.
 */
'use strict';
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

(async () => {
  await req('POST', '/api/admin/login', { email: 'hankalfr@gmail.com', password: 'Testing123!' });

  const db = require('../server/db');
  const storage = require('../server/storage');
  const files = require('../server/files');
  const settings = require('../server/settings');
  const BEFORE = settings.getSection('storage');

  /* ---- some photos, half of them old and half of them recent ---- */
  const dayOld = (n) => new Date(Date.now() - n * 864e5).toISOString();
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(50 * 1024, 7)]);
  const made = [];
  const visitor = db.run(
    "INSERT INTO visitors (full_name, company, created_at) VALUES ('Shed Subject', 'Shed Test Ltd', ?)",
    new Date().toISOString()).lastInsertRowid;

  const plant = (daysAgo) => {
    const web = files.saveBuffer(jpeg, 'private', 'photos', `shed-${daysAgo}-${Math.random().toString(36).slice(2, 8)}.jpg`);
    const id = db.run(`INSERT INTO visits (visitor_id, visit_type, status, signed_in_at, photo_path, created_at)
                       VALUES (?, 'visitor', 'out', ?, ?, ?)`,
      visitor, dayOld(daysAgo), web, dayOld(daysAgo)).lastInsertRowid;
    made.push({ id, web, daysAgo, abs: files.absoluteFor(web) });
    return id;
  };
  for (const d of [400, 300, 200, 120, 100, 91]) plant(d);   // beyond any floor
  for (const d of [5, 2, 1]) plant(d);                       // this week — untouchable
  ok('there are photos on the disk to shed', made.every((m) => fs.existsSync(m.abs)));

  /* ---- with room to spare, it does nothing at all ---- */
  let r = storage.shed({ shed_at_percent: 100, shed_to_percent: 99 });
  ok('it stays out of the way while there is room', r.ran === false && r.photos === 0, JSON.stringify(r));
  ok('…and says why, rather than looking like it worked', typeof r.why === 'string' && r.why.length > 0, r.why);

  /* ---- switched off, it stays off however full the disk is ---- */
  r = storage.shed({ shed_enabled: false, shed_at_percent: 0, shed_to_percent: 0 });
  ok('switched off, nothing is deleted whatever the pressure', r.ran === false && r.photos === 0, JSON.stringify(r));
  ok('…and every photo is still there', made.every((m) => fs.existsSync(m.abs)));

  /* ---- under pressure, the oldest go and the recent ones do not ---- */
  const used = storage.usage();
  ok('the volume size is known here, so the rest can be tested', !!used.volume_size, JSON.stringify(used).slice(0, 120));

  /*
   * Start below where the disk already is, and clear to a mark it can never
   * reach — so the sweep runs to the end of what it is allowed to touch. That
   * is the worst case: everything outside the floor goes, and nothing inside
   * it does.
   */
  r = storage.shed({ shed_at_percent: 0, shed_to_percent: 0, shed_floor_days: 90 });
  ok('under pressure it runs', r.ran === true, JSON.stringify(r).slice(0, 160));
  ok('…and drops the photos beyond the floor', r.photos === 6, `${r.photos} dropped`);
  ok('…freeing roughly what those files weighed', r.freed > 6 * 40 * 1024, `${r.freed} bytes`);

  const gone = made.filter((m) => m.daysAgo >= 91);
  const kept = made.filter((m) => m.daysAgo < 91);
  ok('the old files are off the disk', gone.every((m) => !fs.existsSync(m.abs)),
    gone.filter((m) => fs.existsSync(m.abs)).map((m) => m.daysAgo).join(','));
  ok('nothing inside the floor window is touched, however full it is',
    kept.every((m) => fs.existsSync(m.abs)),
    kept.filter((m) => !fs.existsSync(m.abs)).map((m) => m.daysAgo).join(','));

  /* ---- the visit stays; only the photo on it goes ---- */
  const rows = gone.map((m) => db.get('SELECT id, photo_path, signed_in_at FROM visits WHERE id = ?', m.id));
  ok('the visits themselves are still there — this is not a retention purge',
    rows.every((v) => !!v), JSON.stringify(rows.map((v) => !!v)));
  ok('…with the photo unhooked rather than left pointing at nothing',
    rows.every((v) => v.photo_path === null), JSON.stringify(rows.map((v) => v.photo_path)));

  /* ---- and it is on the record ---- */
  const entry = db.get("SELECT * FROM audit_log WHERE action = 'storage.shed' ORDER BY id DESC LIMIT 1");
  ok('the sweep is written to the audit log', !!entry, 'no audit entry');
  const detail = entry ? JSON.parse(entry.detail || '{}') : {};
  ok('…saying how many went and how much it freed',
    detail.photos === 6 && detail.freed > 0, JSON.stringify(detail).slice(0, 120));
  ok('…and the window it was allowed to reach into', detail.floor_days === 90, String(detail.floor_days));

  const after = settings.getSection('storage');
  ok('the last sweep is remembered for the Backups page',
    !!after.shed_last_at && after.shed_last_photos === 6, JSON.stringify(after).slice(0, 140));

  /* ---- a second sweep with nothing left to reach is honest about it ---- */
  r = storage.shed({ shed_at_percent: 0, shed_to_percent: 0, shed_floor_days: 90 });
  ok('a sweep with nothing left to take reports nothing taken', r.photos === 0, JSON.stringify(r).slice(0, 120));

  /* ---- the button on the Backups page ---- */
  plant(200);
  const forced = await req('POST', '/api/admin/storage/shed', { force: true });
  ok('the button frees room on demand', forced.status === 200 && forced.data.ok, JSON.stringify(forced.data).slice(0, 120));
  ok('…and hands back what the disk looks like afterwards',
    !!(forced.data.storage && forced.data.storage.used >= 0), JSON.stringify(forced.data.storage).slice(0, 100));

  const health = (await req('GET', '/api/admin/backups')).data.storage;
  ok('the Backups page is told the valve is armed and when it last ran',
    health.shedding === true && !!health.shed_last_at, JSON.stringify(health).slice(0, 140));

  /* ---- reception cannot delete the site's photos ---- */
  await req('POST', '/api/admin/logout');
  const staffPass = 'Reception123!';
  await req('POST', '/api/admin/login', { email: 'hankalfr@gmail.com', password: 'Testing123!' });
  const rec = (await req('POST', '/api/admin/users', {
    email: `shed-reception-${Date.now()}@example.com`, name: 'Shed Reception', role: 'reception', password: staffPass, must_change: false
  })).data;
  if (rec && rec.email) {
    await req('POST', '/api/admin/logout');
    await req('POST', '/api/admin/login', { email: rec.email, password: staffPass });
    const denied = await req('POST', '/api/admin/storage/shed', { force: true });
    ok('reception cannot delete the site’s photos', denied.status === 403, String(denied.status));
    await req('POST', '/api/admin/logout');
    await req('POST', '/api/admin/login', { email: 'hankalfr@gmail.com', password: 'Testing123!' });
    await req('DELETE', `/api/admin/users/${rec.id}`);
  } else {
    ok('reception cannot delete the site’s photos', false, `could not create the account: ${JSON.stringify(rec)}`);
  }

  /* ---- put the site back as it was ---- */
  db.run('DELETE FROM visits WHERE visitor_id = ?', visitor);
  db.run('DELETE FROM visitors WHERE id = ?', visitor);
  for (const m of made) { try { fs.unlinkSync(m.abs); } catch { /* already gone */ } }
  settings.setSection('storage', {
    shed_enabled: BEFORE.shed_enabled !== false,
    shed_at_percent: BEFORE.shed_at_percent ?? 90,
    shed_to_percent: BEFORE.shed_to_percent ?? 75,
    shed_floor_days: BEFORE.shed_floor_days ?? 14,
    shed_last_at: BEFORE.shed_last_at || '',
    shed_last_freed: BEFORE.shed_last_freed || 0,
    shed_last_photos: BEFORE.shed_last_photos || 0
  });
  const leftover = fs.existsSync(path.join(require('../server/db').DATA_DIR, 'uploads', 'private', 'photos'))
    ? fs.readdirSync(path.join(require('../server/db').DATA_DIR, 'uploads', 'private', 'photos'))
      .filter((n) => n.startsWith('shed-')) : [];
  ok('the fixture is cleared away afterwards', leftover.length === 0, leftover.join(','));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
