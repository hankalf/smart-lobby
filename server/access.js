'use strict';
/**
 * Door / barrier control. Each access point is an HTTP call, which covers the
 * common smart-relay hardware (Shelly, Tasmota, ESPHome, Home Assistant,
 * Ubiquiti Access, Net2 web API, generic webhook) without extra dependencies.
 */
const { all, get, run, nowISO } = require('./db');

function parseJson(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function fillTemplate(str, vars) {
  return String(str || '').replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k])));
}

/*
 * Whoever is wiring a door reads this message off the screen, and "fetch
 * failed" — all Node reports for every network fault — tells them nothing
 * about which end to go and look at. The reason is one level down, in the
 * cause, so say what it was in the terms they would check it in.
 */
function reasonFor(err, url) {
  if (err && err.name === 'AbortError') return 'No reply within 8 seconds — the relay may be asleep or on another network';

  let host = '';
  try { host = new URL(url).host; } catch { host = 'the relay'; }

  const code = (err && err.cause && err.cause.code) || (err && err.code) || '';
  switch (code) {
    case 'ECONNREFUSED': return `${host} refused the connection — check the port, and that the relay is switched on`;
    case 'ENOTFOUND': return `${host} could not be found — check the address, or use its IP instead of a name`;
    case 'EHOSTUNREACH':
    case 'ENETUNREACH': return `No route to ${host} — the relay is on a network this server cannot reach`;
    case 'ETIMEDOUT': return `${host} did not answer — usually a firewall between here and the door`;
    case 'ECONNRESET': return `${host} dropped the connection part way through`;
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN': return `${host} presented a self-signed certificate — use http:// for a relay on your own network`;
    default: break;
  }
  const detail = (err && err.cause && err.cause.message) || (err && err.message) || String(err);
  return `Could not reach ${host} — ${detail}`;
}

async function trigger(pointId, { visitId = null, actor = 'system', source = 'manual' } = {}) {
  const point = get('SELECT * FROM access_points WHERE id = ?', pointId);
  if (!point) return { ok: false, error: 'unknown_access_point' };
  if (!point.enabled) return { ok: false, error: 'disabled' };

  const vars = {
    seconds: point.unlock_seconds,
    door: point.name,
    actor,
    visit_id: visitId || '',
    timestamp: nowISO()
  };

  const url = fillTemplate(point.url, vars);
  const method = (point.method || 'POST').toUpperCase();
  const headers = Object.assign({ 'Content-Type': 'application/json' }, parseJson(point.headers, {}));
  const bodyTemplate = point.body || JSON.stringify({ action: 'unlock', seconds: '{{seconds}}', door: '{{door}}', actor: '{{actor}}' });
  const body = method === 'GET' || method === 'HEAD' ? undefined : fillTemplate(bodyTemplate, vars);

  let result = 'ok';
  let detail = '';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { method, headers, body, signal: controller.signal });
    clearTimeout(timer);
    // The relay answered, so the wiring is right and only what we sent is
    // wrong. Say which, since the two are fixed in different places.
    detail = res.ok ? `HTTP ${res.status}` : `HTTP ${res.status} — the relay answered but turned the request down${
      res.status === 401 || res.status === 403 ? ' (check the password or token in the headers)' : ''}`;
    if (!res.ok) result = 'error';
  } catch (err) {
    result = 'error';
    detail = reasonFor(err, url);
  }

  run('INSERT INTO access_events (access_point_id, visit_id, actor, trigger_source, result, detail, created_at) VALUES (?,?,?,?,?,?,?)',
    pointId, visitId, actor, source, result, detail, nowISO());

  return { ok: result === 'ok', detail };
}

async function autoUnlock(kind, { visitId, actor, siteId }) {
  const column = kind === 'signout' ? 'auto_unlock_on_signout' : 'auto_unlock_on_signin';
  const points = all(`SELECT id FROM access_points WHERE enabled = 1 AND ${column} = 1 AND (site_id IS NULL OR site_id = ? OR ? IS NULL)`,
    siteId || null, siteId || null);
  const results = [];
  for (const p of points) results.push(await trigger(p.id, { visitId, actor, source: kind }));
  return results;
}

function occupancy(siteId) {
  const row = siteId
    ? get("SELECT COUNT(*) AS n FROM visits WHERE status = 'onsite' AND site_id = ?", siteId)
    : get("SELECT COUNT(*) AS n FROM visits WHERE status = 'onsite'");
  return row ? row.n : 0;
}

module.exports = { trigger, autoUnlock, occupancy };
