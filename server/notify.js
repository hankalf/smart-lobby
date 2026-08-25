'use strict';
const nodemailer = require('nodemailer');
const { run, get, nowISO } = require('./db');
const settings = require('./settings');

const baseUrl = () => (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');

function transport() {
  const n = settings.getSection('notify');
  if (!n.email_enabled || !n.smtp_host) return null;
  return nodemailer.createTransport({
    host: n.smtp_host,
    port: Number(n.smtp_port) || 587,
    secure: !!n.smtp_secure,
    auth: n.smtp_user ? { user: n.smtp_user, pass: n.smtp_pass } : undefined
  });
}

function log(entry) {
  run('INSERT INTO notifications (visit_id, delivery_id, channel, target, subject, status, error, created_at) VALUES (?,?,?,?,?,?,?,?)',
    entry.visit_id || null, entry.delivery_id || null, entry.channel, entry.target || null,
    entry.subject || null, entry.status, entry.error || null, nowISO());
}

async function sendEmail({ to, subject, html, text, visit_id, delivery_id }) {
  const n = settings.getSection('notify');
  const t = transport();
  if (!t || !to) {
    log({ visit_id, delivery_id, channel: 'email', target: to, subject, status: t ? 'skipped_no_address' : 'skipped_disabled' });
    return false;
  }
  try {
    await t.sendMail({
      from: `"${n.from_name}" <${n.from_email}>`,
      to, subject, text, html
    });
    log({ visit_id, delivery_id, channel: 'email', target: to, subject, status: 'sent' });
    return true;
  } catch (err) {
    log({ visit_id, delivery_id, channel: 'email', target: to, subject, status: 'error', error: String(err.message || err) });
    return false;
  }
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

async function sendWebhook({ url, title, lines, photoUrl, visit_id, delivery_id }) {
  const n = settings.getSection('notify');
  const target = url || n.global_webhook_url;
  if (!target) return false;
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
  try {
    const res = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    log({ visit_id, delivery_id, channel: 'webhook', target, subject: title, status: res.ok ? 'sent' : `http_${res.status}` });
    return res.ok;
  } catch (err) {
    log({ visit_id, delivery_id, channel: 'webhook', target, subject: title, status: 'error', error: String(err.message || err) });
    return false;
  }
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
    sendEmail({ to: v.host_email, subject: title, html, text: lines.join('\n'), visit_id: visitId }),
    sendWebhook({ url: v.host_webhook, title, lines, photoUrl, visit_id: visitId }),
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
    sendEmail({ to: v.host_email, subject: title, text: lines.join('\n'), html: `<p>${title}</p><p>${lines.join('<br>')}</p>`, visit_id: visitId }),
    sendWebhook({ url: v.host_webhook, title, lines, visit_id: visitId })
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
    sendEmail({ to: d.host_email, subject: title, html, text: lines.join('\n'), delivery_id: deliveryId }),
    sendWebhook({ url: d.host_webhook, title, lines, photoUrl, delivery_id: deliveryId }),
    n.sms_on_delivery
      ? sendSms({ to: d.host_phone, message: `${title}. ${d.parcel_count} parcel(s) at reception.`, delivery_id: deliveryId })
      : Promise.resolve(false)
  ]);
}

/** Turn an SMTP failure into something a person can act on. */
function explainSmtpError(err) {
  const message = String((err && err.message) || err);
  const code = (err && err.code) || '';
  const response = String((err && err.response) || '');

  if (code === 'EAUTH' || /535|password not accepted|invalid credentials/i.test(response + message)) {
    return 'The username or password was rejected. Gmail needs a 16-character App Password rather than your '
      + 'normal password, and the username must be the full address.';
  }
  if (/must issue a starttls|STARTTLS/i.test(response + message)) {
    return 'The server wants an encrypted connection. Use port 587 with TLS-on-connect switched off, or port 465 with it on.';
  }
  if (code === 'ESOCKET' || /wrong version number|SSL routines/i.test(message)) {
    return 'TLS mismatch: port 587 needs “Use TLS on connect” switched off, port 465 needs it on.';
  }
  if (code === 'ECONNECTION' || code === 'ETIMEDOUT' || code === 'EDNS' || /getaddrinfo|ENOTFOUND/i.test(message)) {
    return 'Could not reach that SMTP server — check the host name and port.';
  }
  if (/5\.7\.0|denied|not allowed to send/i.test(response)) {
    return 'The server accepted the login but refused to send. The From address usually has to match the account you signed in with.';
  }
  return message;
}

async function sendTest(to) {
  const org = settings.getSection('org');
  const n = settings.getSection('notify');
  const t = transport();
  if (!t) {
    return { ok: false, error: 'Email is switched off, or no SMTP host is set. Save those settings, then test.' };
  }
  if (!to) return { ok: false, error: 'No address to send the test to.' };

  try {
    await t.sendMail({
      from: `"${n.from_name}" <${n.from_email}>`,
      to,
      subject: `${org.name} Smart Lobby test email`,
      text: 'This is a test notification from your Smart Lobby install. If you can read this, SMTP is configured correctly.',
      html: '<p>This is a test notification from your Smart Lobby install.</p>'
        + '<p>If you can read this, SMTP is configured correctly.</p>'
    });
    log({ channel: 'email', target: to, subject: 'test', status: 'sent' });
    return { ok: true };
  } catch (err) {
    log({ channel: 'email', target: to, subject: 'test', status: 'error', error: String(err.message || err) });
    return { ok: false, error: explainSmtpError(err) };
  }
}

async function sendTestSms(to) {
  return sendSms({ to, message: 'Smart Lobby test message. If you can read this, SMS notifications are working.' });
}

module.exports = { notifyArrival, notifyDeparture, notifyDelivery, sendTest, sendTestSms, sendWebhook, sendEmail, sendSms, toE164, baseUrl };
