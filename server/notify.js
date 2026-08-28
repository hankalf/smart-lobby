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
    auth: n.smtp_user ? { user: n.smtp_user, pass: n.smtp_pass } : undefined,
    /*
     * Without these, a host that silently drops the connection — a wrong port,
     * a firewall — leaves the send hanging for two minutes. That is what a
     * "nothing happened" test button feels like. Fail inside half a minute
     * with a reason instead.
     */
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 30000
  });
}

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

/*
 * Where the HTTPS mail APIs live. Overridable so the whole path can be tested
 * against a local stand-in; production never sets these variables.
 */
const API_BASES = {
  brevo: () => process.env.BREVO_API_BASE || 'https://api.brevo.com',
  sendgrid: () => process.env.SENDGRID_API_BASE || 'https://api.sendgrid.com'
};

/**
 * Send over an HTTPS mail API instead of SMTP. Exists because some hosting
 * platforms (Railway among them, on some plans) block the SMTP ports outright
 * — port 443 is never blocked. Both services can send as an address they have
 * verified by emailing it a confirmation, so the From address can stay the
 * lobby's own.
 */
async function sendViaApi({ provider, apiKey, fromName, fromEmail, to, subject, text, html }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const url = provider === 'brevo'
      ? `${API_BASES.brevo()}/v3/smtp/email`
      : `${API_BASES.sendgrid()}/v3/mail/send`;
    const body = provider === 'brevo'
      ? { sender: { name: fromName, email: fromEmail }, to: [{ email: to }], subject,
          textContent: text || undefined, htmlContent: html || undefined }
      : { personalizations: [{ to: [{ email: to }] }], from: { email: fromEmail, name: fromName }, subject,
          content: [
            ...(text ? [{ type: 'text/plain', value: text }] : []),
            ...(html ? [{ type: 'text/html', value: html }] : [])
          ] };
    const headers = provider === 'brevo'
      ? { 'Content-Type': 'application/json', 'api-key': apiKey }
      : { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    if (res.ok || res.status === 202) return { ok: true };
    const detail = await res.text().catch(() => '');
    return { ok: false, error: explainApiError(provider, res.status, detail) };
  } catch (err) {
    const reason = /abort/i.test(String(err.message)) ? 'The service did not answer within 20 seconds.'
      : String(err.message || err);
    return { ok: false, error: `Could not reach ${provider === 'brevo' ? 'Brevo' : 'SendGrid'} — ${reason}` };
  } finally {
    clearTimeout(timer);
  }
}

function explainApiError(provider, status, body) {
  const name = provider === 'brevo' ? 'Brevo' : 'SendGrid';
  if (status === 401 || status === 403) {
    if (/verif|sender identity|from address does not match/i.test(body)) {
      return `${name} accepted the key but refused the From address: it has to be a sender you have verified in your `
        + `${name} account first (${name} emails that address a confirmation link).`;
    }
    return `${name} rejected the API key — check it was copied whole, and that it is a key with permission to send.`;
  }
  if (/verif|sender|from/i.test(body) && status === 400) {
    return `${name} refused the From address: verify it as a sender in your ${name} account first `
      + `(${name} emails that address a confirmation link).`;
  }
  return `${name} answered ${status}: ${String(body).slice(0, 300)}`;
}

/** One email, over whichever way out is configured. Returns {ok, error}. */
async function deliverEmail({ to, subject, text, html }) {
  const n = settings.getSection('notify');
  if (n.email_provider === 'brevo' || n.email_provider === 'sendgrid') {
    if (!n.email_api_key) return { ok: false, error: 'No API key is set. Paste the key from your account, save, and test again.' };
    return sendViaApi({
      provider: n.email_provider, apiKey: n.email_api_key,
      fromName: n.from_name, fromEmail: n.from_email, to, subject, text, html
    });
  }
  const t = transport();
  if (!t) return { ok: false, error: 'Email is switched off, or no SMTP host is set. Save those settings, then test.' };
  try {
    await t.sendMail({ from: `"${n.from_name}" <${n.from_email}>`, to, subject, text, html });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: explainSmtpError(err) };
  }
}

async function sendEmail({ to, subject, html, text, visit_id, delivery_id }) {
  const n = settings.getSection('notify');
  const configured = n.email_enabled && (n.email_provider === 'smtp' ? !!n.smtp_host : !!n.email_api_key);
  if (!configured || !to) {
    log({ visit_id, delivery_id, channel: 'email', target: to, subject, status: configured ? 'skipped_no_address' : 'skipped_disabled' });
    return false;
  }
  const id = logStart({ visit_id, delivery_id, channel: 'email', target: to, subject });
  const result = await deliverEmail({ to, subject, text, html });
  logFinish(id, result.ok ? 'sent' : 'error', result.error);
  return result.ok;
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
    log({
      visit_id, delivery_id, channel: 'webhook', target, subject: title,
      status: res.ok ? 'sent' : `http_${res.status}`,
      error: res.ok ? null : text.slice(0, 500)
    });
    return { ok: res.ok, status: res.status, detail: explainWebhookError(res.status, text, format) };
  } catch (err) {
    const detail = /abort/i.test(String(err.message)) ? 'The server did not answer within 15 seconds.' : String(err.message || err);
    log({ visit_id, delivery_id, channel: 'webhook', target, subject: title, status: 'error', error: detail });
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
    sendEmail({ to: v.host_email, subject: title, html, text: lines.join('\n'), visit_id: visitId }),
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
    sendEmail({ to: v.host_email, subject: title, text: lines.join('\n'), html: `<p>${title}</p><p>${lines.join('<br>')}</p>`, visit_id: visitId }),
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
    sendEmail({ to: d.host_email, subject: title, html, text: lines.join('\n'), delivery_id: deliveryId }),
    sendWebhooks({ ownUrl: d.host_webhook, title, lines, photoUrl, delivery_id: deliveryId }),
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

  if (code === 'EAUTH' || /535|password not accepted|invalid credentials|authentication failed/i.test(response + message)) {
    return 'The username or password was rejected. Gmail and iCloud both refuse normal account passwords here — '
      + 'create an app-specific password (myaccount.google.com/apppasswords for Gmail, account.apple.com → '
      + 'Sign-In and Security for iCloud) and use the full email address as the username.';
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
  if (/greeting never received|timed? ?out/i.test(message)) {
    return 'The SMTP server never answered — usually the wrong port, or a firewall between this server and it. '
      + 'For iCloud and Gmail use port 587 with “TLS on connect” switched off.';
  }
  if (/5\.7\.0|denied|not allowed to send|relay|invalid sender|554/i.test(response)) {
    return 'The server accepted the login but refused to send. The From address has to match the account you '
      + 'signed in with — for iCloud that means the @icloud.com address itself, or an alias set up in iCloud Mail.';
  }
  return message;
}

async function sendTest(to) {
  const org = settings.getSection('org');
  const n = settings.getSection('notify');
  if (!n.email_enabled) {
    // Recorded too, so the log explains why a test produced nothing.
    log({ channel: 'email', target: to, subject: 'test', status: 'skipped_disabled' });
    return { ok: false, error: 'Email is switched off. Tick “Send staff emails”, save, then test.' };
  }
  if (!to) return { ok: false, error: 'No address to send the test to.' };

  const id = logStart({ channel: 'email', target: to, subject: 'test' });
  const result = await deliverEmail({
    to,
    subject: `${org.name} Smart Lobby test email`,
    text: 'This is a test notification from your Smart Lobby install. If you can read this, email is configured correctly.',
    html: '<p>This is a test notification from your Smart Lobby install.</p>'
      + '<p>If you can read this, email is configured correctly.</p>'
  });
  logFinish(id, result.ok ? 'sent' : 'error', result.error);
  return result;
}

async function sendTestSms(to) {
  return sendSms({ to, message: 'Smart Lobby test message. If you can read this, SMS notifications are working.' });
}

module.exports = { notifyArrival, notifyDeparture, notifyDelivery, sendTest, sendTestSms, sendWebhook, sendWebhooks,
  webhookTargets, sendEmail, sendSms, toE164, baseUrl };
