'use strict';
const { get, all, run } = require('./db');

const DEFAULTS = {
  org: {
    name: "Nature's Touch Builds",
    logo_path: null,
    primary_color: '#2f7d5d',
    accent_color: '#123a2c',
    welcome_title: 'Welcome',
    welcome_message: 'Please tap below to sign in',
    goodbye_message: 'Thanks for visiting. Have a safe journey.',
    timezone: 'Europe/London',
    date_format: 'en-GB'
  },
  kiosk: {
    require_photo: true,
    photo_optional: false,
    require_phone: true,
    require_email: false,
    require_host: true,
    require_company: false,
    ask_vehicle: false,
    ask_purpose: true,
    visit_types: ['visitor', 'contractor', 'interview'],
    show_delivery_button: true,
    show_staff_button: false,
    show_onsite_count: false,
    idle_timeout_seconds: 90,
    returning_lookup_field: 'phone',
    auto_signout_hour: 20,
    thank_you_seconds: 12
  },
  badge: {
    enabled: false,
    auto_print: true,
    mode: 'browser',
    label_width_mm: 62,
    label_height_mm: 100,
    orientation: 'portrait',
    show_logo: true,
    show_photo: true,
    show_company: true,
    show_host: true,
    show_date: true,
    show_time: true,
    show_qr: true,
    show_badge_no: true,
    badge_prefix: 'V',
    title_text: 'VISITOR',
    footer_text: 'Please return this badge on exit',
    font_scale: 1
  },
  induction: {
    enabled: true,
    show_to_returning_visitors: false,
    repeat_after_days: 0,
    require_acknowledgement: true,
    acknowledgement_text: 'I confirm I have watched and understood the site induction.'
  },
  deliveries: {
    enabled: true,
    require_photo: true,
    require_recipient: true,
    ask_tracking: true,
    notify_recipient: true,
    signature_on_collection: true
  },
  access: {
    enabled: true,
    unlock_button_on_kiosk: false,
    unlock_on_signin: false,
    require_host_approval: false
  },
  notify: {
    email_enabled: false,
    from_name: 'Smart Lobby',
    from_email: 'lobby@example.com',
    smtp_host: '',
    smtp_port: 587,
    smtp_secure: false,
    smtp_user: '',
    smtp_pass: '',
    on_signin: true,
    on_signout: false,
    on_delivery: true,
    global_webhook_url: '',
    webhook_format: 'slack',
    sms_enabled: false,
    sms_provider: 'twilio',
    twilio_account_sid: '',
    twilio_auth_token: '',
    sms_from: '',
    sms_on_signin: true,
    sms_on_delivery: false
  },
  privacy: {
    retain_visits_days: 730,
    retain_photos_days: 90,
    hide_names_on_signout_list: false
  }
};

function deepMerge(base, override) {
  if (override === undefined) return base;
  if (override === null) return null; // an explicit null clears a value (e.g. removing the logo)
  if (typeof base !== 'object' || Array.isArray(base) || base === null) return override;
  const out = Object.assign({}, base);
  for (const k of Object.keys(override || {})) {
    out[k] = deepMerge(base[k], override[k]);
  }
  return out;
}

function getAll() {
  const rows = all('SELECT key, value FROM settings');
  const stored = {};
  for (const r of rows) {
    try { stored[r.key] = JSON.parse(r.value); } catch { stored[r.key] = r.value; }
  }
  return deepMerge(DEFAULTS, stored);
}

function getSection(section) {
  return getAll()[section] || {};
}

function setSection(section, patch) {
  const current = getSection(section);
  const merged = deepMerge(current, patch);
  run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    section,
    JSON.stringify(merged)
  );
  return merged;
}

function setAll(patch) {
  for (const section of Object.keys(patch || {})) {
    if (DEFAULTS[section]) setSection(section, patch[section]);
  }
  return getAll();
}

/** Settings safe to expose to an unauthenticated kiosk (no SMTP creds). */
function publicSettings() {
  const s = getAll();
  return {
    org: s.org,
    kiosk: s.kiosk,
    badge: { ...s.badge, mode: s.badge.mode },
    induction: s.induction,
    deliveries: s.deliveries,
    access: { enabled: s.access.enabled, unlock_button_on_kiosk: s.access.unlock_button_on_kiosk }
  };
}

module.exports = { DEFAULTS, getAll, getSection, setSection, setAll, publicSettings, deepMerge };
