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
    detail = `HTTP ${res.status}`;
    if (!res.ok) result = 'error';
  } catch (err) {
    result = 'error';
    detail = String(err.message || err);
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
