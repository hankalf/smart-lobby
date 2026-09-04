'use strict';
/**
 * What this install can actually do, asked of the machine it is running on.
 *
 * Every hard problem this system has had was only visible from where it was
 * deployed. Whether the server can reach a tile service, whether the address
 * Teams fetches photos from resolves, whether the nightly backup has ever
 * finished, whether a tablet has stopped checking in — none of it can be
 * answered by reading the code, and all of it is invisible from a settings
 * page that shows what was configured rather than what happened.
 *
 * So this asks. One request, run on demand, that goes and looks: at the disk,
 * at the database, at the backups, at the outside world, and at the settings
 * for the combinations that are individually valid and together do nothing.
 *
 * Three rules it keeps:
 *
 *   - It says what it knows and no more. A webhook that answered 202 was
 *     accepted, not delivered, and this reports the difference rather than
 *     tidying it away.
 *   - It never sends anything anybody would see. No test posts to real
 *     channels: it reports what the notification log already recorded, so
 *     pressing it twice is free and pressing it during a busy morning is
 *     harmless.
 *   - A check that cannot run says so, rather than passing quietly. "Not
 *     checked" is a different answer from "fine", and reporting the first as
 *     the second is how this whole class of problem started.
 */
const { get, all, STORAGE, DATA_DIR } = require('./db');
const settings = require('./settings');
const storage = require('./storage');
const notify = require('./notify');

/** The states a check can come back in, worst first when they are sorted. */
const RANK = { bad: 0, warn: 1, info: 2, ok: 3, skip: 4 };

const ok = (detail, extra) => ({ state: 'ok', detail, ...extra });
const warn = (detail, hint) => ({ state: 'warn', detail, hint });
const bad = (detail, hint) => ({ state: 'bad', detail, hint });
const info = (detail) => ({ state: 'info', detail });
const skip = (detail) => ({ state: 'skip', detail });

const ago = (iso) => {
  if (!iso) return null;
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(mins)) return null;
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
};

/**
 * Fetch something, briefly, and never throw.
 *
 * Used for the checks that reach outside. A server with no route out hangs
 * rather than refusing, so everything here is on a timer — a check that never
 * comes back is worse than one that reports it could not.
 */
async function reach(url, ms = 8000) {
  try {
    const bail = AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
    const res = await fetch(url, { signal: bail, redirect: 'follow' });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, status: 0, error: String((err && err.message) || err) };
  }
}

/* ------------------------------------------------------------- the checks */

const CHECKS = [
  /* ---- the machine ---- */
  {
    group: 'This server',
    id: 'build',
    label: 'Which version is running',
    run: () => {
      const commit = (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT || '').slice(0, 7);
      return info(commit
        ? `Commit ${commit}, running since ${ago(module.exports.startedAt) || 'start-up'}.`
        : `No commit stamp — started ${ago(module.exports.startedAt) || 'recently'}. `
          + 'A host that sets RAILWAY_GIT_COMMIT_SHA or GIT_COMMIT names the version here.');
    }
  },
  {
    group: 'This server',
    id: 'storage',
    label: 'Does the data survive a deploy',
    run: () => (STORAGE.ephemeral
      ? bad('Nothing is persistent — the database and every photo are erased on the next deploy.',
        'Add a volume and mount it at /data, or set DATA_DIR to somewhere that persists.')
      : ok(`Persistent, in ${DATA_DIR}.`))
  },
  {
    group: 'This server',
    id: 'disk',
    label: 'Room left',
    run: () => {
      const u = storage.usage();
      const free = u && u.volume_free;
      const days = u && u.days_left;
      if (!Number.isFinite(free)) return skip('The host did not report free space.');
      const gb = (free / 1e9).toFixed(1);
      if (free < 200e6) return bad(`${gb} GB free.`, 'Photos are shed automatically below this, but the database still needs room.');
      if (Number.isFinite(days) && days < 30) return warn(`${gb} GB free — about ${days} days at the current rate.`);
      return ok(`${gb} GB free${Number.isFinite(days) ? `, about ${days} days at the current rate` : ''}.`);
    }
  },
  {
    group: 'This server',
    id: 'database',
    label: 'The database answers',
    run: () => {
      const visits = get('SELECT COUNT(*) AS n FROM visits').n;
      const people = get('SELECT COUNT(*) AS n FROM visitors').n;
      return ok(`${visits} visit(s), ${people} visitor(s) on file.`);
    }
  },

  /* ---- what the outside world can see, and what this can reach ---- */
  {
    group: 'Reaching the outside',
    id: 'public_url',
    label: 'The address Teams fetches photos from',
    run: async () => {
      const url = notify.baseUrl();
      if (/^https?:\/\/localhost|127\.0\.0\.1/.test(url)) {
        return bad(`It thinks it is at ${url}, which is only reachable from the server itself.`,
          'Set PUBLIC_URL, or fill in the public address under Notifications. Until then every card '
          + 'arrives with a broken picture and every link in one leads nowhere.');
      }
      const r = await reach(`${url}/api/health`);
      if (r.ok) return ok(`${url} — reachable, and answering as this server.`);
      return warn(`${url} — this server could not fetch its own address (${r.error || `HTTP ${r.status}`}).`,
        'That may only mean the host does not route back to itself. Open the address in a browser to '
        + 'be sure; if it works there, photos in Teams will be fine.');
    }
  },
  {
    group: 'Reaching the outside',
    id: 'tiles',
    label: 'Map and satellite imagery',
    run: async () => {
      const probe = await require('./tiles').probe();
      const names = Object.entries(probe.layers)
        .map(([id, l]) => `${l.label || id}: ${l.ok ? 'reachable' : (l.error || 'unavailable')}`);
      if (probe.layers.map && probe.layers.map.ok && probe.layers.satellite && probe.layers.satellite.ok) {
        return ok(names.join(' · '));
      }
      if (probe.ok) return warn(names.join(' · '), 'The geofence map works with whichever layer is available.');
      return warn(names.join(' · '),
        'No basemap, so the geofence is drawn on squared paper. Everything else is unaffected — and '
        + 'TILE_URL points this at your own tile server if the defaults are blocked.');
    }
  },
  {
    group: 'Reaching the outside',
    id: 'geocode',
    label: 'Looking up an address',
    run: async () => {
      const r = await require('./geocode').lookup('10 Downing Street London');
      if (r.results && r.results.length) return ok('Working — an address comes back as coordinates.');
      return warn(r.message || 'No answer.',
        'Only used when somebody presses Find while placing the site. The other two ways of setting '
        + 'the coordinates do not need it.');
    }
  },

  /* ---- notifications: what actually happened, not what is configured ---- */
  {
    group: 'Notifications',
    id: 'destinations',
    label: 'Where messages are set to go',
    run: () => {
      const n = settings.getSection('notify');
      const routing = n.type_routing || {};
      const typed = Object.entries(routing).filter(([, r]) => r && r.webhook_url).length;
      const people = all("SELECT COUNT(*) AS n FROM hosts WHERE active = 1 AND webhook_url IS NOT NULL AND webhook_url != ''")[0].n;
      if (!n.global_webhook_url && !typed && !people) {
        return warn('Nothing is configured — no arrival reaches anybody.',
          'Set the company channel under Notifications, or give at least one person a chat link.');
      }
      const bits = [];
      if (n.global_webhook_url) bits.push('a company channel');
      if (typed) bits.push(`${typed} visitor type channel(s)`);
      if (people) bits.push(`${people} personal chat link(s)`);
      return ok(bits.join(', ') + '.');
    }
  },
  {
    group: 'Notifications',
    id: 'delivery',
    label: 'What has actually been delivered',
    run: () => {
      const recent = all(`SELECT status, COUNT(*) AS n FROM notifications
                          WHERE created_at > ? GROUP BY status`,
      new Date(Date.now() - 7 * 864e5).toISOString());
      if (!recent.length) return info('Nothing has been sent in the last seven days.');
      const total = recent.reduce((sum, r) => sum + r.n, 0);
      const sent = recent.filter((r) => r.status === 'sent').reduce((sum, r) => sum + r.n, 0);
      const failed = total - sent;
      const last = get("SELECT created_at FROM notifications WHERE status = 'sent' ORDER BY id DESC LIMIT 1");
      const line = `${sent} of ${total} accepted in the last seven days`
        + (last ? `, most recently ${ago(last.created_at)}` : '') + '.';
      if (!failed) {
        return ok(`${line} Accepted is not the same as delivered — a Teams workflow answers before it posts.`);
      }
      return warn(`${line} ${failed} did not get through.`,
        'The Activity list under Notifications says which and why.');
    }
  },
  {
    group: 'Notifications',
    id: 'stuck',
    label: 'Anything queued and not getting through',
    run: () => {
      const stuck = all("SELECT target, attempts FROM notifications WHERE status = 'retrying'");
      if (!stuck.length) return ok('Nothing waiting to be retried.');
      return warn(`${stuck.length} message(s) waiting to be tried again.`,
        'Three attempts over half an hour, then they stop. A destination that fails every time is '
        + 'usually a workflow that has been deleted or turned off.');
    }
  },

  /* ---- the settings that are each valid and together do nothing ---- */
  {
    group: 'Settings that disagree',
    id: 'geofence',
    label: 'The phone check-in fence',
    run: () => {
      const g = settings.getSection('geofence');
      const k = settings.getSection('kiosk');
      if (!g.enabled) return skip('Switched off — phone check-ins are accepted from anywhere.');
      const placed = Number.isFinite(Number(g.lat)) && Number.isFinite(Number(g.lng))
        && (Number(g.lat) !== 0 || Number(g.lng) !== 0);
      if (!placed) {
        return bad('Switched on with no coordinates, so every phone check-in is refused.',
          'Set the site location under Kiosk sign-in flow, or switch the fence off.');
      }
      if (!k.self_checkin_enabled) {
        return info('Set up, but phone check-in is switched off site-wide, so nothing uses it.');
      }
      return ok(`${g.radius_m} m around ${Number(g.lat).toFixed(5)}, ${Number(g.lng).toFixed(5)}.`);
    }
  },
  {
    group: 'Settings that disagree',
    id: 'selfcheckin',
    label: 'Phone check-in',
    run: () => {
      const k = settings.getSection('kiosk');
      if (!k.self_checkin_enabled) return skip('Switched off site-wide.');
      const withCode = all("SELECT name FROM devices WHERE self_checkin = 1 AND self_code IS NOT NULL AND self_code != ''");
      if (!withCode.length) {
        return warn('Switched on site-wide, but no device has a code, so there is no QR to scan.',
          'Switch it on for a device under Devices — that is where the code and the printable sign are.');
      }
      return ok(`${withCode.length} device(s) with a code: ${withCode.map((d) => d.name).join(', ')}.`);
    }
  },
  {
    group: 'Settings that disagree',
    id: 'badges',
    label: 'Badge printing',
    run: () => {
      const b = settings.getSection('badge');
      if (!b.enabled) return skip('Switched off.');
      const printers = all('SELECT name, trouble_since FROM printers');
      const down = printers.filter((p) => p.trouble_since);
      if (!printers.length) {
        return info('On, printing through the tablet\'s own browser. No printer is registered, which is '
          + 'fine — registering one only adds the "not printing" reporting.');
      }
      if (down.length) {
        return warn(`${down.length} printer(s) reported as not printing: ${down.map((p) => p.name).join(', ')}.`,
          'Somebody marked it down on the Printers page or the on-site board; mark it working there once it is.');
      }
      return ok(`${printers.length} printer(s), none reported down.`);
    }
  },
  {
    group: 'Settings that disagree',
    id: 'board',
    label: 'The on-site board',
    run: () => {
      const b = settings.getSection('board');
      if (!b.enabled) return skip('Switched off.');
      if (!b.key) return bad('Switched on but has no link, so nothing can open it.', 'Press New link under Live on-site board.');
      return ok('On, behind its unguessable link.');
    }
  },

  /* ---- the tablets at the gate ---- */
  {
    group: 'Tablets',
    id: 'devices',
    label: 'Are the kiosks checking in',
    run: () => {
      const devices = all('SELECT name, last_seen_at FROM devices ORDER BY name');
      if (!devices.length) return info('No devices registered. The kiosk still works; a device record is what gives it its own link and settings.');
      const quiet = devices.filter((d) => !d.last_seen_at
        || Date.now() - Date.parse(d.last_seen_at) > 15 * 60000);
      if (!quiet.length) return ok(`${devices.length} device(s), all checking in.`);
      return warn(`${quiet.length} of ${devices.length} quiet for more than 15 minutes: `
        + quiet.map((d) => `${d.name} (${d.last_seen_at ? ago(d.last_seen_at) : 'never seen'})`).join(', '),
      'A tablet that is simply switched off looks exactly like this.');
    }
  },

  /* ---- the copy of everything ---- */
  {
    group: 'Backups',
    id: 'backups',
    label: 'The nightly copy',
    run: () => {
      const list = require('./backup').list();
      if (!list.length) return warn('No backup has ever been written.', 'One runs nightly; press Back up now to prove it works before relying on it.');
      const newest = list[0];
      const old = Date.now() - Date.parse(newest.created_at) > 36 * 3600e3;
      const line = `${list.length} kept, newest ${ago(newest.created_at)} (${(newest.bytes / 1e6).toFixed(1)} MB).`;
      return old ? warn(`${line} That is older than a day and a half.`, 'The nightly job runs while the server is up; a host that sleeps will miss it.')
        : ok(line);
    }
  },
  {
    group: 'Backups',
    id: 'offsite',
    label: 'A copy somewhere else',
    run: () => {
      const off = require('./offsite');
      if (!off.enabled()) {
        return warn('Not set up — every backup is on the same disk as the thing it is backing up.',
          'A volume failure or a deleted project takes both. Set an off-site destination under Backups.');
      }
      const h = off.health();
      if (h && h.last_ok) return ok(`Last copied off ${ago(h.last_ok)}.`);
      return warn('Set up, but nothing has been copied off yet.', 'Press Test under Backups to prove the destination accepts it.');
    }
  }
];

/**
 * Run the lot.
 *
 * Sequentially rather than in parallel: three of these reach outside, one of
 * them is rate-limited by somebody else's usage policy, and a self-check that
 * takes four seconds instead of two is not worth being clever about.
 */
async function run() {
  const results = [];
  for (const check of CHECKS) {
    let out;
    try {
      out = await check.run();
    } catch (err) {
      /*
       * A check that throws is reported as a check that threw, never skipped
       * silently. The point of this page is that nothing goes unreported.
       */
      out = bad(`This check itself failed: ${String((err && err.message) || err)}`);
    }
    results.push({ id: check.id, group: check.group, label: check.label, ...out });
  }

  const worst = results.reduce((w, r) => (RANK[r.state] < RANK[w] ? r.state : w), 'skip');
  return {
    ran_at: new Date().toISOString(),
    worst,
    counts: results.reduce((c, r) => ({ ...c, [r.state]: (c[r.state] || 0) + 1 }), {}),
    checks: results
  };
}

/** Plain text, for pasting into a message to somebody who can help. */
function asText(report) {
  const mark = { ok: 'OK  ', warn: 'WARN', bad: 'BAD ', info: '--  ', skip: '--  ' };
  const lines = [`Smart Lobby — install check, ${report.ran_at}`, ''];
  let group = '';
  for (const c of report.checks) {
    if (c.group !== group) { group = c.group; lines.push(`[${group}]`); }
    lines.push(`  ${mark[c.state] || '?   '} ${c.label}: ${c.detail}`);
    if (c.hint && (c.state === 'bad' || c.state === 'warn')) lines.push(`         ${c.hint}`);
  }
  return lines.join('\n');
}

module.exports = { run, asText, startedAt: new Date().toISOString() };
