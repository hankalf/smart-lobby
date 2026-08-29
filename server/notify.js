'use strict';
const { run, get, all, nowISO } = require('./db');
const settings = require('./settings');
const cards = require('./notify-card');
const photolink = require('./photolink');

/*
 * The address Teams will use to fetch a photo. PUBLIC_URL is the deployment's
 * own answer; the settings field exists so a site can fix this without a
 * redeploy, which matters because a wrong value here shows up only as a card
 * with a missing picture.
 */
const baseUrl = () => {
  const configured = settings.getSection('notify').public_url || process.env.PUBLIC_URL || '';
  return (configured || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
};

/** A photo link Microsoft can actually follow — see server/photolink.js. */
const cardPhotoUrl = (visit) =>
  (visit && visit.photo_path && visit.id)
    ? `${baseUrl()}/notify/photo/${visit.id}?t=${photolink.sign(visit.id)}`
    : null;

function log(entry) {
  const r = run('INSERT INTO notifications (visit_id, delivery_id, channel, target, subject, status, error, created_at) VALUES (?,?,?,?,?,?,?,?)',
    entry.visit_id || null, entry.delivery_id || null, entry.channel, entry.target || null,
    entry.subject || null, entry.status, entry.error || null, nowISO());
  return Number(r.lastInsertRowid);
}

// A row goes in before the attempt and is settled after, so the dashboard can
// show what is in flight right now, not just what already finished.
const logStart = (entry) => log({ ...entry, status: 'sending' });

/*
 * How long before a failed post is tried again: a minute, then five, then
 * twenty-five. Three goes covers a service restarting or a network blip, and
 * stops well short of posting an arrival to a channel an hour after the person
 * walked in, which would be worse than not posting it at all.
 */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 25 * 60_000];

function logFinish(id, status, error, { retryable = false, payload = null } = {}) {
  const row = get('SELECT attempts FROM notifications WHERE id = ?', id);
  const attempts = (row && row.attempts) || 1;
  const delay = retryable ? RETRY_DELAYS_MS[attempts - 1] : undefined;
  run('UPDATE notifications SET status = ?, error = ?, next_try_at = ?, payload = COALESCE(?, payload) WHERE id = ?',
    delay ? 'retrying' : status,
    error || null,
    delay ? new Date(Date.now() + delay).toISOString() : null,
    payload ? JSON.stringify(payload) : null,
    id);
}

/**
 * Work out the payload shape from the webhook URL itself, so one host can be on
 * Slack and another on Teams. Falls back to the configured format for URLs we
 * do not recognise (self-hosted Mattermost, n8n, custom endpoints).
 */
function detectWebhookFormat(url) {
  const u = String(url || '').toLowerCase();
  if (u.includes('hooks.slack.com')) return 'slack';
  if (u.includes('webhook.office.com') || u.includes('logic.azure.com') || u.includes('powerplatform.com')) return 'teams';
  if (u.includes('chat.googleapis.com')) return 'google_chat';
  return null;
}

/**
 * Where a chat notification goes: the person's own webhook, and the company
 * channel as well when that is switched on. With it off the channel is only a
 * fallback for people who have no webhook of their own.
 */
function webhookTargets(ownUrl, extraUrls = []) {
  const n = settings.getSection('notify');
  const list = [];
  if (ownUrl) list.push(ownUrl);
  // Whoever this visitor type is routed to, through their own chat webhook.
  extraUrls.filter(Boolean).forEach((url) => list.push(url));
  if (n.global_webhook_url && (n.webhook_channel_always !== false || !ownUrl)) list.push(n.global_webhook_url);
  return [...new Set(list.filter(Boolean))];
}

/** Post to every destination for this recipient, and report on each. */
function sendWebhooks({ ownUrl, extraUrls, model, visit_id, delivery_id }) {
  return Promise.all(webhookTargets(ownUrl, extraUrls || []).map((url) =>
    sendWebhook({ url, model, visit_id, delivery_id })));
}

async function sendWebhook({ url, model, visit_id, delivery_id }) {
  const n = settings.getSection('notify');
  const target = url;
  if (!target) return { ok: false, status: 0, detail: 'No webhook URL.' };
  const format = detectWebhookFormat(target) || n.webhook_format;
  const title = model.title;
  const body = cards.render(format, model);

  // Recorded before the attempt and settled after, so the dashboard shows a
  // post that is in flight rather than nothing until it is over.
  const logId = logStart({ visit_id, delivery_id, channel: 'webhook', target, subject: title });
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timer);

    // Chat platforms explain refusals in the body, which is the useful part.
    const text = await res.text().catch(() => '');
    /*
     * A 404 or a 401 means the webhook is gone or revoked — trying it again in
     * a minute will fail in exactly the same way. A 429 or a 5xx is the service
     * having a moment, which is precisely what a retry is for.
     */
    const worthRetrying = !res.ok && (res.status === 429 || res.status >= 500);
    logFinish(logId, res.ok ? 'sent' : `http_${res.status}`, res.ok ? null : text.slice(0, 500),
      { retryable: worthRetrying, payload: worthRetrying ? { url: target, model } : null });
    return { ok: res.ok, status: res.status, detail: explainWebhookError(res.status, text, format) };
  } catch (err) {
    /*
     * Notifications live or die on this now, so the reason has to be readable
     * by whoever set the link up. "fetch failed" is what the runtime says for
     * everything from a deleted Flow to a typo in the URL.
     */
    const raw = String((err && err.message) || err);
    const name = format === 'teams' ? 'Teams' : format === 'slack' ? 'Slack'
      : format === 'google_chat' ? 'Google Chat' : 'that service';
    const detail = /abort/i.test(raw)
      ? `${name} did not answer within 15 seconds.`
      : /fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|network/i.test(raw)
        ? `Could not reach ${name}. Check the link was pasted whole and that the flow still exists — a deleted or `
          + 'turned-off Teams workflow looks exactly like this.'
        : raw;
    // Never answering, or not being reachable, is the most retryable failure there is.
    logFinish(logId, 'error', detail, { retryable: true, payload: { url: target, model } });
    return { ok: false, status: 0, detail };
  }
}

function explainWebhookError(status, body, format) {
  if (status >= 200 && status < 300) return 'Delivered.';
  const text = String(body || '').slice(0, 300);
  if (status === 400 && format === 'teams') {
    return 'Teams rejected the message (400). This usually means the flow expects a different payload — '
      + `check the workflow is the webhook template rather than a custom one. Response: ${text}`;
  }
  if (status === 404 || status === 410) return 'That webhook no longer exists — it may have been deleted in Teams or Slack.';
  if (status === 401 || status === 403) return 'The webhook refused the request. It may have been revoked, or your tenant blocks it.';
  if (status === 429) return 'Rate limited — too many messages too quickly.';
  return `The server answered ${status}. ${text}`;
}

const fmtTime = (iso) => {
  const s = settings.getSection('org');
  try {
    return new Date(iso).toLocaleString(s.date_format || 'en-GB', { timeZone: s.timezone || undefined });
  } catch { return iso; }
};

function visitDetail(visitId) {
  return get(`SELECT v.*, p.full_name, p.company, p.phone, p.email, h.name AS host_name, h.email AS host_email,
                     h.phone AS host_phone, h.webhook_url AS host_webhook, s.name AS site_name,
                     j.name AS project_name, l.name AS location_name, d.name AS device_name
              FROM visits v
              JOIN visitors p ON p.id = v.visitor_id
              LEFT JOIN hosts h ON h.id = v.host_id
              LEFT JOIN sites s ON s.id = v.site_id
              LEFT JOIN projects j ON j.id = v.project_id
              LEFT JOIN locations l ON l.id = v.location_id
              LEFT JOIN devices d ON d.id = v.device_id
              WHERE v.id = ?`, visitId);
}

/**
 * Whether this kind of visitor is one the site wants to hear about.
 *
 * Absent from the map means yes, so a visitor type added later is announced
 * rather than quietly ignored until somebody notices the silence.
 */
function typeNotified(visitType) {
  const map = settings.getSection('notify').types_notified || {};
  return map[visitType] !== false;
}

/**
 * Who else this kind of visitor concerns.
 *
 * A safety officer who wants every contractor, an HR manager who wants every
 * interview — people with no reason to watch a general channel for the three
 * arrivals a week that are theirs. They are tagged in the post and, if they
 * have a chat webhook of their own, sent it directly.
 *
 * Inactive staff are dropped: leaving somebody who has left the company
 * tagged on every contractor arrival is exactly the kind of thing nobody
 * notices for months.
 */
function routedStaff(visitType) {
  const routing = settings.getSection('notify').type_routing || {};
  const ids = ((routing[visitType] || {}).staff || [])
    .map(Number).filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) return [];
  const rows = all(
    `SELECT id, name, email, webhook_url FROM hosts WHERE active = 1 AND id IN (${ids.map(() => '?').join(',')})`,
    ...ids);
  // Kept in the order the site chose, so the card reads the way it was set up.
  return ids.map((id) => rows.find((r) => r.id === id)).filter(Boolean);
}

/**
 * The board's own address, for a card that offers a link to it.
 *
 * Null when the board is off or has no key: a button leading to a 404 is
 * worse than one fewer button.
 */
const boardUrl = () => {
  const b = settings.getSection('board');
  return b.enabled && b.key ? `${baseUrl()}/board/${b.key}` : null;
};

/** Everything the card builder needs that is not on the row itself. */
const cardContext = (extra) => ({
  org: settings.getSection('org'),
  fmtTime,
  baseUrl: baseUrl(),
  boardUrl: boardUrl(),
  ...extra
});

async function notifyArrival(visitId) {
  const n = settings.getSection('notify');
  if (!n.on_signin) return;
  const v = visitDetail(visitId);
  if (!v) return;
  if (!typeNotified(v.visit_type)) return;

  const also = routedStaff(v.visit_type);
  const model = cards.buildModel('signin', v, n, cardContext({
    photoUrl: cardPhotoUrl(v),
    also,
    fallbackTitle: `${v.full_name} has arrived`
  }));

  await sendWebhooks({
    ownUrl: v.host_webhook, extraUrls: also.map((p) => p.webhook_url),
    model, visit_id: visitId
  });
}

async function notifyDeparture(visitId) {
  const n = settings.getSection('notify');
  if (!n.on_signout) return;
  const v = visitDetail(visitId);
  if (!v) return;
  if (!typeNotified(v.visit_type)) return;
  const also = routedStaff(v.visit_type);
  const model = cards.buildModel('signout', v, n, cardContext({
    photoUrl: cardPhotoUrl(v),
    also,
    fallbackTitle: `${v.full_name} has signed out`
  }));
  await sendWebhooks({
    ownUrl: v.host_webhook, extraUrls: also.map((p) => p.webhook_url),
    model, visit_id: visitId
  });
}

async function notifyDelivery(deliveryId) {
  const n = settings.getSection('notify');
  if (!n.on_delivery) return;
  const d = get(`SELECT d.*, h.name AS host_name, h.email AS host_email, h.phone AS host_phone, h.webhook_url AS host_webhook
                 FROM deliveries d LEFT JOIN hosts h ON h.id = d.recipient_host_id WHERE d.id = ?`, deliveryId);
  if (!d) return;
  const model = cards.buildModel('delivery', d, n, cardContext({
    // A parcel photo is a box, not a person, so it is never behind the toggle.
    photoUrl: null,
    fallbackTitle: `Delivery waiting for ${d.host_name || d.recipient_text || 'reception'}`
  }));
  await sendWebhooks({ ownUrl: d.host_webhook, model, delivery_id: deliveryId });
}

/**
 * Try again, for the posts that were worth trying again.
 *
 * Each retry updates the row it came from rather than adding a new one, so the
 * activity list shows one arrival with three attempts against it rather than
 * three arrivals — the log is meant to answer "did this person's host get
 * told", and a row per attempt buries that.
 */
async function retryPending() {
  const due = all(
    `SELECT id, target, payload, attempts FROM notifications
     WHERE status = 'retrying' AND next_try_at IS NOT NULL AND next_try_at <= ? LIMIT 20`, nowISO());
  for (const row of due) {
    let payload;
    try { payload = JSON.parse(row.payload); } catch { payload = null; }
    if (!payload || !payload.url || !payload.model) {
      run("UPDATE notifications SET status = 'error', next_try_at = NULL WHERE id = ?", row.id);
      continue;
    }
    const attempts = row.attempts + 1;
    run('UPDATE notifications SET attempts = ?, next_try_at = NULL WHERE id = ?', attempts, row.id);
    const format = detectWebhookFormat(payload.url) || settings.getSection('notify').webhook_format;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(payload.url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cards.render(format, payload.model)), signal: controller.signal
      });
      clearTimeout(timer);
      const text = await res.text().catch(() => '');
      // Out of goes: it stays failed, and the dashboard says so.
      const again = !res.ok && attempts <= RETRY_DELAYS_MS.length && (res.status === 429 || res.status >= 500);
      run('UPDATE notifications SET status = ?, error = ?, next_try_at = ? WHERE id = ?',
        res.ok ? 'sent' : again ? 'retrying' : `http_${res.status}`,
        res.ok ? null : text.slice(0, 500),
        again ? new Date(Date.now() + RETRY_DELAYS_MS[attempts - 1]).toISOString() : null,
        row.id);
      if (res.ok) console.log(`[notify] retry ${attempts} delivered #${row.id}`);
    } catch (err) {
      const again = attempts <= RETRY_DELAYS_MS.length;
      run('UPDATE notifications SET status = ?, error = ?, next_try_at = ? WHERE id = ?',
        again ? 'retrying' : 'error', String(err.message || err).slice(0, 300),
        again ? new Date(Date.now() + RETRY_DELAYS_MS[attempts - 1]).toISOString() : null,
        row.id);
    }
  }
  return due.length;
}

/**
 * Whether anyone should be worried, for the banner on the dashboard.
 *
 * Failures have always been recorded; nothing has ever raised a hand about
 * them. A deleted Teams flow looks exactly like everything being fine until
 * somebody thinks to open the activity list, by which point a fortnight of
 * arrivals have gone unannounced.
 */
function health() {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const recent = all(
    `SELECT status FROM notifications WHERE channel = 'webhook' AND created_at >= ?`, since);
  const failed = recent.filter((r) => r.status !== 'sent' && r.status !== 'sending' && r.status !== 'retrying').length;
  const waiting = all("SELECT id FROM notifications WHERE status = 'retrying'").length;

  const quiet = all(
    `SELECT name, last_seen_at FROM devices
     WHERE last_seen_at IS NOT NULL AND last_seen_at < ? ORDER BY last_seen_at`,
    new Date(Date.now() - 60 * 60_000).toISOString());

  const configured = !!settings.getSection('notify').global_webhook_url;
  return {
    notifications: { sent: recent.length - failed, failed, waiting, configured, window_hours: 24 },
    quiet_devices: quiet.map((d) => ({ name: d.name, last_seen_at: d.last_seen_at })),
    // Paperwork that has lapsed, or is about to, is a thing somebody has to
    // act on days before it turns into a person sent home from the gate.
    compliance: require('./compliance').health()
  };
}

/**
 * Somebody has finished the site induction.
 *
 * Off by default — on a busy gate it doubles the traffic in the channel — but
 * the one a safety officer actually wants, because it is the moment the
 * briefing is on record rather than the moment somebody walked in.
 */
async function notifyInduction(visitId) {
  const n = settings.getSection('notify');
  if (!n.on_induction) return;
  const v = visitDetail(visitId);
  if (!v || !typeNotified(v.visit_type)) return;
  const also = routedStaff(v.visit_type);
  const model = cards.buildModel('induction', v, n, cardContext({
    photoUrl: cardPhotoUrl(v),
    also,
    // The moment it was signed, which is now — the visit row holds when they
    // arrived, and on a long induction those are not the same thing.
    now: nowISO(),
    fallbackTitle: `${v.full_name} has completed the site induction`
  }));
  await sendWebhooks({
    ownUrl: v.host_webhook, extraUrls: also.map((p) => p.webhook_url),
    model, visit_id: visitId
  });
}

module.exports = { notifyArrival, notifyDeparture, notifyDelivery, notifyInduction,
  sendWebhook, sendWebhooks, webhookTargets, baseUrl, boardUrl, cardPhotoUrl, cardContext, visitDetail, fmtTime,
  retryPending, health, RETRY_DELAYS_MS, typeNotified, routedStaff };
