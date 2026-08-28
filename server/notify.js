'use strict';
const { run, get, nowISO } = require('./db');
const settings = require('./settings');

const baseUrl = () => (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');

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
function sendWebhooks({ ownUrl, title, lines, photoUrl, visit_id, delivery_id }) {
  return Promise.all(webhookTargets(ownUrl).map((url) =>
    sendWebhook({ url, title, lines, photoUrl, visit_id, delivery_id })));
}

async function sendWebhook({ url, title, lines, photoUrl, visit_id, delivery_id }) {
  const n = settings.getSection('notify');
  const target = url;
  if (!target) return { ok: false, status: 0, detail: 'No webhook URL.' };
  const format = detectWebhookFormat(target) || n.webhook_format;
  const body = format === 'teams'
    // Teams Workflows (which replaced Office 365 connectors) rejects a bare
    // MessageCard with 400. An Adaptive Card in this envelope works on both.
    ? {
        type: 'message',
        attachments: [{
          contentType: 'application/vnd.microsoft.card.adaptive',
          contentUrl: null,
          content: {
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            type: 'AdaptiveCard',
            version: '1.4',
            body: [
              { type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium', wrap: true },
              ...(photoUrl ? [{ type: 'Image', url: photoUrl, size: 'Medium', style: 'Person' }] : []),
              { type: 'TextBlock', text: lines.join('\n\n'), wrap: true, spacing: 'Small' }
            ]
          }
        }]
      }
    : format === 'google_chat'
    ? { text: `*${title}*\n${lines.join('\n')}` }
    : format === 'generic'
    ? { event: title, details: lines, photo_url: photoUrl || null, timestamp: new Date().toISOString() }
    : {
        text: `*${title}*\n${lines.join('\n')}`,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `*${title}*\n${lines.join('\n')}` },
            ...(photoUrl ? { accessory: { type: 'image', image_url: photoUrl, alt_text: 'visitor' } } : {}) }
        ]
      };
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
    const detail = /abort/i.test(String(err.message)) ? 'The server did not answer within 15 seconds.' : String(err.message || err);
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
                     h.phone AS host_phone, h.webhook_url AS host_webhook, s.name AS site_name
              FROM visits v
              JOIN visitors p ON p.id = v.visitor_id
              LEFT JOIN hosts h ON h.id = v.host_id
              LEFT JOIN sites s ON s.id = v.site_id
              WHERE v.id = ?`, visitId);
}

async function notifyArrival(visitId) {
  const n = settings.getSection('notify');
  if (!n.on_signin) return;
  const v = visitDetail(visitId);
  if (!v) return;
  const org = settings.getSection('org');
  const photoUrl = v.photo_path ? `${baseUrl()}${v.photo_path}` : null;
  const lines = [
    `Visitor: ${v.full_name}${v.company ? ` (${v.company})` : ''}`,
    `Type: ${v.visit_type}`,
    v.purpose ? `Purpose: ${v.purpose}` : null,
    v.vehicle_reg ? `Vehicle: ${v.vehicle_reg}` : null,
    `Signed in: ${fmtTime(v.signed_in_at)}`,
    v.badge_no ? `Badge: ${v.badge_no}` : null,
    v.site_name ? `Site: ${v.site_name}` : null
  ].filter(Boolean);

  const title = `${v.full_name} has arrived to see ${v.host_name || 'reception'}`;
  const html = `
    <div style="font-family:system-ui,Segoe UI,Arial,sans-serif">
      <h2 style="color:${org.primary_color}">${title}</h2>
      ${photoUrl ? `<img src="${photoUrl}" alt="" style="max-width:220px;border-radius:12px">` : ''}
      <ul>${lines.map((l) => `<li>${l}</li>`).join('')}</ul>
      <p style="color:#666">Sent by ${org.name} Smart Lobby</p>
    </div>`;

  await Promise.all([
    sendWebhooks({ ownUrl: v.host_webhook, title, lines, photoUrl, visit_id: visitId }),
    n.sms_on_signin
      ? sendSms({ to: v.host_phone, message: `${title}. ${v.company ? v.company + '. ' : ''}Reception.`, visit_id: visitId })
      : Promise.resolve(false)
  ]);
}

async function notifyDeparture(visitId) {
  const n = settings.getSection('notify');
  if (!n.on_signout) return;
  const v = visitDetail(visitId);
  if (!v) return;
  const title = `${v.full_name} has signed out`;
  const lines = [`Signed out: ${fmtTime(v.signed_out_at)}`, v.host_name ? `Staff member: ${v.host_name}` : null].filter(Boolean);
  await Promise.all([
    sendWebhooks({ ownUrl: v.host_webhook, title, lines, visit_id: visitId })
  ]);
}

async function notifyDelivery(deliveryId) {
  const n = settings.getSection('notify');
  if (!n.on_delivery) return;
  const d = get(`SELECT d.*, h.name AS host_name, h.email AS host_email, h.phone AS host_phone, h.webhook_url AS host_webhook
                 FROM deliveries d LEFT JOIN hosts h ON h.id = d.recipient_host_id WHERE d.id = ?`, deliveryId);
  if (!d) return;
  const who = d.host_name || d.recipient_text || 'reception';
  const title = `Delivery waiting for ${who}`;
  const photoUrl = d.photo_path ? `${baseUrl()}${d.photo_path}` : null;
  const lines = [
    `Courier: ${d.courier_name || 'unknown'}${d.courier_company ? ` (${d.courier_company})` : ''}`,
    `Parcels: ${d.parcel_count}`,
    d.tracking ? `Tracking: ${d.tracking}` : null,
    `Received: ${fmtTime(d.received_at)}`,
    'Collect from reception.'
  ].filter(Boolean);
  const html = `<div style="font-family:system-ui,Arial,sans-serif"><h2>${title}</h2>
    ${photoUrl ? `<img src="${photoUrl}" style="max-width:260px;border-radius:12px">` : ''}
    <ul>${lines.map((l) => `<li>${l}</li>`).join('')}</ul></div>`;
  await Promise.all([
    sendWebhooks({ ownUrl: d.host_webhook, title, lines, photoUrl, delivery_id: deliveryId }),
    n.sms_on_delivery
      ? sendSms({ to: d.host_phone, message: `${title}. ${d.parcel_count} parcel(s) at reception.`, delivery_id: deliveryId })
      : Promise.resolve(false)
  ]);
}

/** Turn an SMTP failure into something a person can act on. */
async function sendTestSms(to) {
  return sendSms({ to, message: 'Smart Lobby test message. If you can read this, SMS notifications are working.' });
}

module.exports = { notifyArrival, notifyDeparture, notifyDelivery, sendTestSms, sendWebhook, sendWebhooks,
  webhookTargets, sendSms, toE164, baseUrl };
