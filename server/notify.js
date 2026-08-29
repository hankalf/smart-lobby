'use strict';
const { run, get, nowISO } = require('./db');
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
function logFinish(id, status, error) {
  run('UPDATE notifications SET status = ?, error = ? WHERE id = ?', status, error || null, id);
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
function webhookTargets(ownUrl) {
  const n = settings.getSection('notify');
  const list = [];
  if (ownUrl) list.push(ownUrl);
  if (n.global_webhook_url && (n.webhook_channel_always !== false || !ownUrl)) list.push(n.global_webhook_url);
  return [...new Set(list.filter(Boolean))];
}

/** Post to every destination for this recipient, and report on each. */
function sendWebhooks({ ownUrl, model, visit_id, delivery_id }) {
  return Promise.all(webhookTargets(ownUrl).map((url) =>
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
    logFinish(logId, res.ok ? 'sent' : `http_${res.status}`, res.ok ? null : text.slice(0, 500));
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
    logFinish(logId, 'error', detail);
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

/**
 * SMS via Twilio's REST API — no SDK needed, it is one form POST.
 * Numbers should be in E.164 form (+447700900123); UK 07… numbers are converted.
 */
function toE164(number, countryCode) {
  const country = settings.phoneCountry(countryCode || settings.getSection('org').phone_country);
  const raw = String(number || '').replace(/[^\d+]/g, '');
  if (!raw) return null;
  if (raw.startsWith('+')) return raw;
  if (raw.startsWith('00')) return `+${raw.slice(2)}`;
  // Countries with a trunk prefix drop it: UK 07700 900123 -> +447700900123.
  if (country.trunk && raw.startsWith(country.trunk)) return `${country.dial}${raw.slice(country.trunk.length)}`;
  // Locally typed numbers without a country code, e.g. US 5551234567 -> +15551234567.
  if (!country.trunk && raw.length <= 10) return `${country.dial}${raw}`;
  return `+${raw}`;
}

async function sendSms({ to, message, visit_id, delivery_id }) {
  const n = settings.getSection('notify');
  const number = toE164(to);
  if (!n.sms_enabled || !n.twilio_account_sid || !n.twilio_auth_token || !n.sms_from || !number) {
    log({ visit_id, delivery_id, channel: 'sms', target: to, subject: null,
      status: n.sms_enabled ? 'skipped_no_number' : 'skipped_disabled' });
    return false;
  }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(n.twilio_account_sid)}/Messages.json`;
  const auth = Buffer.from(`${n.twilio_account_sid}:${n.twilio_auth_token}`).toString('base64');
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: number, From: n.sms_from, Body: message.slice(0, 600) })
    });
    const data = await res.json().catch(() => ({}));
    log({ visit_id, delivery_id, channel: 'sms', target: number, subject: null,
      status: res.ok ? 'sent' : `error_${res.status}`, error: res.ok ? null : (data.message || '') });
    return res.ok;
  } catch (err) {
    log({ visit_id, delivery_id, channel: 'sms', target: number, status: 'error', error: String(err.message || err) });
    return false;
  }
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

/** Everything the card builder needs that is not on the visit row itself. */
const cardContext = (extra) => ({
  org: settings.getSection('org'),
  fmtTime,
  baseUrl: baseUrl(),
  ...extra
});

async function notifyArrival(visitId) {
  const n = settings.getSection('notify');
  if (!n.on_signin) return;
  const v = visitDetail(visitId);
  if (!v) return;

  const model = cards.buildModel(v, n.card, cardContext({
    photoUrl: cardPhotoUrl(v),
    fallbackTitle: `${v.full_name} has arrived`
  }));

  await Promise.all([
    sendWebhooks({ ownUrl: v.host_webhook, model, visit_id: visitId }),
    n.sms_on_signin
      ? sendSms({ to: v.host_phone,
        message: `${model.title}. ${v.company ? v.company + '. ' : ''}Reception.`, visit_id: visitId })
      : Promise.resolve(false)
  ]);
}

async function notifyDeparture(visitId) {
  const n = settings.getSection('notify');
  if (!n.on_signout) return;
  const v = visitDetail(visitId);
  if (!v) return;
  const model = cards.plainModel({
    title: `${v.full_name} has signed out`,
    lines: [`Signed out: ${fmtTime(v.signed_out_at)}`, v.host_name ? `Staff member: ${v.host_name}` : null].filter(Boolean),
    photoUrl: cardPhotoUrl(v),
    org: settings.getSection('org'),
    card: n.card
  });
  await sendWebhooks({ ownUrl: v.host_webhook, model, visit_id: visitId });
}

async function notifyDelivery(deliveryId) {
  const n = settings.getSection('notify');
  if (!n.on_delivery) return;
  const d = get(`SELECT d.*, h.name AS host_name, h.email AS host_email, h.phone AS host_phone, h.webhook_url AS host_webhook
                 FROM deliveries d LEFT JOIN hosts h ON h.id = d.recipient_host_id WHERE d.id = ?`, deliveryId);
  if (!d) return;
  const who = d.host_name || d.recipient_text || 'reception';
  const model = cards.plainModel({
    title: `Delivery waiting for ${who}`,
    lines: [
      `Courier: ${d.courier_name || 'unknown'}${d.courier_company ? ` (${d.courier_company})` : ''}`,
      `Parcels: ${d.parcel_count}`,
      d.tracking ? `Tracking: ${d.tracking}` : null,
      `Received: ${fmtTime(d.received_at)}`,
      'Collect from reception.'
    ].filter(Boolean),
    // A parcel photo is a box, not a person, so it is never behind the toggle.
    photoUrl: null,
    org: settings.getSection('org'),
    card: n.card
  });
  await Promise.all([
    sendWebhooks({ ownUrl: d.host_webhook, model, delivery_id: deliveryId }),
    n.sms_on_delivery
      ? sendSms({ to: d.host_phone, message: `${model.title}. ${d.parcel_count} parcel(s) at reception.`, delivery_id: deliveryId })
      : Promise.resolve(false)
  ]);
}

/** Turn an SMTP failure into something a person can act on. */
async function sendTestSms(to) {
  return sendSms({ to, message: 'Smart Lobby test message. If you can read this, SMS notifications are working.' });
}

module.exports = { notifyArrival, notifyDeparture, notifyDelivery, sendTestSms, sendWebhook, sendWebhooks,
  webhookTargets, sendSms, toE164, baseUrl, cardPhotoUrl, cardContext, visitDetail, fmtTime };
