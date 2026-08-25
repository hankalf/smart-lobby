'use strict';
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

// Prefer an explicit DATA_DIR, then a Railway volume if one is attached, then local disk.
// Falling back to local disk on a hosting platform means the database is destroyed on
// every deploy, so that case is reported loudly rather than failing silently.
const LOCAL_DIR = path.join(__dirname, '..', 'data');
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || LOCAL_DIR;

function storageStatus() {
  const onPlatform = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID ||
    process.env.RENDER || process.env.FLY_APP_NAME);
  const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH || null;
  const onVolume = !!volume && path.resolve(DATA_DIR).startsWith(path.resolve(volume));
  if (!onPlatform) return { ephemeral: false, dir: DATA_DIR, message: null };
  if (!volume) {
    return {
      ephemeral: true,
      dir: DATA_DIR,
      message: 'No storage volume is attached, so the database and all uploads are erased on every deploy. ' +
        'Attach a volume mounted at /data and redeploy.'
    };
  }
  if (!onVolume) {
    return {
      ephemeral: true,
      dir: DATA_DIR,
      message: `A volume is mounted at ${volume} but data is being written to ${DATA_DIR}, which is erased on every ` +
        `deploy. Set DATA_DIR=${volume} (or remove DATA_DIR entirely) and redeploy.`
    };
  }
  return { ephemeral: false, dir: DATA_DIR, message: null };
}

const STORAGE = storageStatus();
if (STORAGE.ephemeral) {
  console.warn('\n  ****************************************************************');
  console.warn('  *  DATA WILL NOT SURVIVE THE NEXT DEPLOY                       *');
  console.warn(`  *  ${STORAGE.message}`);
  console.warn('  ****************************************************************\n');
}

fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'smartlobby.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

function norm(params) {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p instanceof Date) return p.toISOString();
    if (p !== null && typeof p === 'object') return JSON.stringify(p);
    return p;
  });
}

const plain = (row) => (row ? Object.assign({}, row) : row);

function run(sql, ...params) { return db.prepare(sql).run(...norm(params)); }
function get(sql, ...params) { return plain(db.prepare(sql).get(...norm(params))); }
function all(sql, ...params) { return db.prepare(sql).all(...norm(params)).map(plain); }
function exec(sql) { return db.exec(sql); }

const nowISO = () => new Date().toISOString();

function migrate() {
  exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT,
    role TEXT NOT NULL DEFAULT 'admin',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    address TEXT,
    max_occupancy INTEGER,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS hosts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    department TEXT,
    webhook_url TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS visitors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    company TEXT,
    email TEXT,
    phone TEXT,
    photo_path TEXT,
    induction_slideshow_id INTEGER,
    induction_version INTEGER,
    induction_completed_at TEXT,
    blocked INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    visit_count INTEGER NOT NULL DEFAULT 0,
    last_visit_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_visitors_phone ON visitors(phone);
  CREATE INDEX IF NOT EXISTS idx_visitors_email ON visitors(email);

  CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
    visitor_id INTEGER REFERENCES visitors(id) ON DELETE CASCADE,
    host_id INTEGER REFERENCES hosts(id) ON DELETE SET NULL,
    visit_type TEXT NOT NULL DEFAULT 'visitor',
    purpose TEXT,
    vehicle_reg TEXT,
    badge_no TEXT,
    checkout_code TEXT,
    photo_path TEXT,
    induction_shown INTEGER NOT NULL DEFAULT 0,
    signed_in_at TEXT NOT NULL,
    signed_out_at TEXT,
    signed_out_by TEXT,
    status TEXT NOT NULL DEFAULT 'onsite',
    device_id INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_visits_status ON visits(status);
  CREATE INDEX IF NOT EXISTS idx_visits_signed_in ON visits(signed_in_at);
  CREATE INDEX IF NOT EXISTS idx_visits_code ON visits(checkout_code);

  CREATE TABLE IF NOT EXISTS agreements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    body TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    required_for TEXT NOT NULL DEFAULT '["visitor","contractor"]',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS signatures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    visit_id INTEGER REFERENCES visits(id) ON DELETE CASCADE,
    agreement_id INTEGER REFERENCES agreements(id) ON DELETE SET NULL,
    agreement_version INTEGER,
    signed_name TEXT,
    signature_path TEXT,
    signed_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS slideshows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    required_for TEXT NOT NULL DEFAULT '["visitor","contractor"]',
    repeat_after_days INTEGER,
    allow_skip INTEGER NOT NULL DEFAULT 0,
    min_seconds_per_slide INTEGER NOT NULL DEFAULT 0,
    source_file TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS slides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slideshow_id INTEGER REFERENCES slideshows(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL DEFAULT 'image',
    image_path TEXT,
    html TEXT,
    caption TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_slides_show ON slides(slideshow_id, position);

  CREATE TABLE IF NOT EXISTS slide_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    visit_id INTEGER REFERENCES visits(id) ON DELETE CASCADE,
    visitor_id INTEGER REFERENCES visitors(id) ON DELETE CASCADE,
    slideshow_id INTEGER REFERENCES slideshows(id) ON DELETE CASCADE,
    slideshow_version INTEGER,
    started_at TEXT,
    completed_at TEXT,
    seconds INTEGER
  );

  CREATE TABLE IF NOT EXISTS deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
    courier_name TEXT,
    courier_company TEXT,
    recipient_host_id INTEGER REFERENCES hosts(id) ON DELETE SET NULL,
    recipient_text TEXT,
    tracking TEXT,
    parcel_count INTEGER NOT NULL DEFAULT 1,
    photo_path TEXT,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'awaiting',
    received_at TEXT NOT NULL,
    collected_at TEXT,
    collected_by TEXT,
    collection_signature_path TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_deliveries_status ON deliveries(status);

  CREATE TABLE IF NOT EXISTS access_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'webhook',
    url TEXT,
    method TEXT NOT NULL DEFAULT 'POST',
    headers TEXT,
    body TEXT,
    unlock_seconds INTEGER NOT NULL DEFAULT 5,
    auto_unlock_on_signin INTEGER NOT NULL DEFAULT 0,
    auto_unlock_on_signout INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS access_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    access_point_id INTEGER REFERENCES access_points(id) ON DELETE CASCADE,
    visit_id INTEGER REFERENCES visits(id) ON DELETE SET NULL,
    actor TEXT,
    trigger_source TEXT,
    result TEXT,
    detail TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    description TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    token TEXT UNIQUE NOT NULL,
    mode TEXT NOT NULL DEFAULT 'kiosk',
    last_seen_at TEXT,
    last_ip TEXT,
    app_version TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    visit_id INTEGER,
    delivery_id INTEGER,
    channel TEXT NOT NULL,
    target TEXT,
    subject TEXT,
    status TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    action TEXT NOT NULL,
    entity TEXT,
    entity_id INTEGER,
    detail TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  `);

  // Columns added after the first release. CREATE TABLE IF NOT EXISTS does not
  // touch an existing table, so they are added one at a time when missing.
  addColumn('devices', 'location_id', 'INTEGER REFERENCES locations(id) ON DELETE SET NULL');
  addColumn('devices', 'default_camera', "TEXT NOT NULL DEFAULT 'front'");
  addColumn('devices', 'cameras', 'TEXT');
  addColumn('devices', 'print_enabled', 'INTEGER NOT NULL DEFAULT 1');
  addColumn('visits', 'location_id', 'INTEGER REFERENCES locations(id) ON DELETE SET NULL');
  addColumn('agreements', 'questions', 'TEXT');
  addColumn('agreements', 'require_signature', 'INTEGER NOT NULL DEFAULT 1');
  addColumn('signatures', 'answers', 'TEXT');
}

function addColumn(table, column, definition) {
  const existing = all(`PRAGMA table_info(${table})`).map((c) => c.name);
  if (existing.includes(column)) return;
  exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`[migrate] added ${table}.${column}`);
}

module.exports = { db, run, get, all, exec, migrate, nowISO, DATA_DIR, STORAGE };
