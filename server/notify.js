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

async function sendWebhook({ url, title, lines, photoUrl, visit_id, delivery_id }) {
  const n = settings.getSection('notify');
  const target = url || n.global_webhook_url;
  if (!target) return false;
  const body = n.webhook_format === 'teams'
    ? {
        '@type': 'MessageCard',
        '@context': 'https://schema.org/extensions',
        summary: title,
        themeColor: '2f7d5d',
        title,
        text: lines.join('  \n')
      }
    : n.webhook_format === 'google_chat'
    ? { text: `*${title}*\n${lines.join('\n')}` }
    : n.webhook_format === 'generic'
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
function toE164(number, defaultCountry = '+44') {
  const raw = String(number || '').replace(/[^\d+]/g, '');
  if (!raw) return null;
  if (raw.startsWith('+')) return raw;
  if (raw.startsWith('00')) return `+${raw.slice(2)}`;
  if (raw.startsWith('0')) return `${defaultCountry}${raw.slice(1)}`;
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
  const lines = [`Signed out: ${fmtTime(v.signed_out_at)}`, v.host_name ? `Host: ${v.host_name}` : null].filter(Boolean);
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

async function sendTest(to) {
  const org = settings.getSection('org');
  const ok = await sendEmail({
    to,
    subject: `${org.name} Smart Lobby test email`,
    text: 'This is a test notification from your Smart Lobby install. If you can read this, SMTP is configured correctly.',
    html: '<p>This is a test notification from your Smart Lobby install.</p><p>If you can read this, SMTP is configured correctly.</p>'
  });
  return ok;
}

async function sendTestSms(to) {
  return sendSms({ to, message: 'Smart Lobby test message. If you can read this, SMS notifications are working.' });
}

module.exports = { notifyArrival, notifyDeparture, notifyDelivery, sendTest, sendTestSms, sendWebhook, sendEmail, sendSms, toE164, baseUrl };
