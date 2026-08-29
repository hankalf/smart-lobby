'use strict';
const { get, all, run } = require('./db'); // eslint-disable-line no-unused-vars

const DEFAULTS = {
  org: {
    name: "Nature's Touch Builds",
    logo_path: null,
    background_path: null,       // legacy single image, migrated into backgrounds on read
    backgrounds: [],
    background_rotate_seconds: 12,
    background_dim: 40,
    welcome_align: 'center',
    welcome_valign: 'middle',
    show_welcome_footer: false,
    primary_color: '#2f7d5d',
    accent_color: '#123a2c',
    welcome_title: 'Welcome',
    welcome_message: 'Please tap below to sign in',
    goodbye_message: 'Thanks for visiting. Have a safe journey.',
    // The Spanish wording of the three lines above. Left empty, the kiosk shows
    // the English one rather than a blank screen.
    welcome_title_es: '',
    welcome_message_es: '',
    goodbye_message_es: '',
    timezone: 'Europe/London',
    date_format: 'en-GB',
    phone_country: 'US'
  },
  // What the "Your details" form asks, per visitor type. Each field is
  // off / optional / required, so an interview need not ask why they are here.
  details: {
    visitor: { photo: 'required', company: 'optional', phone: 'required', email: 'off', staff: 'required', purpose: 'optional', vehicle: 'off', reference: 'off', movement: 'off', project: 'off', id_scan: 'off' },
    // A contractor is here for a job, not a person: the project they are working
    // on is what matters, and no vehicle is asked for.
    contractor: { photo: 'required', company: 'required', phone: 'required', email: 'off', staff: 'off', purpose: 'off', vehicle: 'off', reference: 'off', movement: 'off', project: 'required', id_scan: 'off' },
    interview: { photo: 'required', company: 'off', phone: 'required', email: 'optional', staff: 'required', purpose: 'off', vehicle: 'off', reference: 'off', movement: 'off', project: 'off', id_scan: 'off' },
    // A driver at a warehouse gate: the haulier, the vehicle and the paperwork
    // matter; who they are visiting usually does not.
    driver: { photo: 'optional', company: 'required', phone: 'required', email: 'off', staff: 'off', purpose: 'off', vehicle: 'required', reference: 'required', movement: 'required', project: 'off', id_scan: 'off' }
  },
  /*
   * The order the sign-in steps are asked in, per visitor type. Finding the
   * visitor always comes first, because it decides whether the induction is
   * needed at all; everything after that is yours to arrange. A step that does
   * not apply — no photo asked for, no documents for this type, an induction
   * already watched — is skipped wherever it sits.
   */
  flow: {
    visitor: ['details', 'photo', 'documents', 'induction'],
    contractor: ['details', 'photo', 'documents', 'induction'],
    interview: ['details', 'photo', 'documents', 'induction'],
    driver: ['details', 'photo', 'documents', 'induction']
  },
  /*
   * Custom label and help text for the details fields, per visitor type — a
   * driver is asked for a haulier, not a company. Anything left empty falls back
   * to the standard wording.
   */
  wording: {},
  /*
   * The visitor types themselves — the cards on the kiosk. Stored as a list the
   * dashboard edits; empty means "never configured", and the list is then built
   * from the older per-card switches so an existing site keeps its exact layout
   * until it first saves the Visitor types tab.
   */
  types: [],
  kiosk: {
    visit_types: ['visitor', 'contractor', 'interview'],
    welcome_shows_menu: true,
    show_interview_button: true,
    show_contractor_button: false,
    show_driver_button: false,
    show_delivery_button: true,
    /*
     * Offering Spanish puts a language button on every screen. The kiosk's own
     * wording is translated in the app; anything an admin typed — document
     * questions, project names, the welcome lines — shows its Spanish version
     * when one has been filled in, and the English otherwise.
     */
    spanish_enabled: false,
    default_language: 'en',
    show_onsite_count: false,
    idle_timeout_seconds: 90,
    returning_lookup_field: 'phone',
    lookup_by_name: true,
    qr_signout_enabled: true,
    auto_signout_enabled: true,
    auto_signout_time: '23:59',
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
    acknowledgement_text: 'I confirm I have watched and understood the site induction.',
    acknowledgement_text_es: ''
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
    // Sign-out is reachable by anyone who can reach the kiosk, so releasing a
    // door on it is off unless a site deliberately turns it on.
    unlock_on_signout: false,
    require_host_approval: false
  },
  notify: {
    /*
     * Notifications go to Microsoft Teams: a company channel that sees every
     * arrival, and each staff member's own Teams link for their own visitors.
     * Email and SMS were both removed — this deployment cannot reach a mail
     * server, text messages were never going to be paid for, and a channel
     * post is what the site actually watches.
     *
     * Which events are worth posting at all. These have existed since the
     * start and were never on any screen, so sign-out notifications could not
     * be switched on however much a site wanted them.
     */
    on_signin: true,
    on_signout: false,
    on_delivery: true,
    on_induction: false,
    /*
     * And who is worth posting about. Keyed by visitor type; a type that is
     * not named here notifies, so adding a new one on the Visitor types tab
     * does not silently go unannounced.
     */
    types_notified: {},
    /*
     * And who else, beyond the person being visited.
     *
     * Keyed by visitor type: { contractor: { staff: [3, 7] } }. Those people
     * are tagged in the channel post and get it through their own chat
     * webhook if they have one — a safety officer who wants every contractor,
     * an HR manager who wants every interview, without either of them having
     * to watch a channel for the three arrivals a week that concern them.
     */
    type_routing: {},
    global_webhook_url: '',
    webhook_channel_always: true,
    webhook_format: 'teams',
    /*
     * The address Teams uses to fetch a visitor's photo. Normally PUBLIC_URL
     * covers it; this is here so the address can be corrected from the
     * dashboard, since getting it wrong shows up only as a missing picture.
     */
    public_url: '',
    /*
     * What each kind of notification looks like when it lands — one design per
     * event, see server/notify-card.js. `card` is the single shared design
     * that came before there were four; sign-ins still fall back to it, so a
     * site that had one set up keeps exactly the card it had.
     *
     * Deliberately empty rather than pre-filled with each event's defaults:
     * an entry here means "somebody designed this", which is what lets
     * sign-ins inherit the older shared design instead of silently replacing
     * it with a stock one.
     */
    card: { ...require('./notify-card').DEFAULT_CARD },
    cards: {}
  },
  /*
   * The wall board: who is on site, on a page somebody can leave open.
   *
   * It shows the whole roster, so it is not simply left open to the internet —
   * it lives behind an unguessable key in its own URL, the way the photo links
   * do. Clearing the key turns the board off for everyone holding the old
   * address, which is what makes it revocable.
   */
  board: {
    enabled: false,
    key: '',
    recent_minutes: 20,
    show_photos: true,
    show_company: true,
    show_host: true,
    title: '',
    /*
     * A camera alongside the roster.
     *
     * The board is served over https, and a browser will not load an http
     * image into an https page — so a camera on the local network, which is
     * almost always plain http, cannot be shown directly however the URL is
     * written. `proxy` makes the server fetch it instead, which fixes that,
     * but only works where the server can reach the camera: on Railway it
     * cannot see your LAN. The panel says all of this plainly.
     */
    camera_enabled: false,
    camera_mode: 'snapshot',   // snapshot | mjpeg | hls | embed
    camera_url: '',
    camera_label: '',
    camera_refresh_seconds: 5,
    camera_proxy: false,
    camera_size: 'small'       // small | medium | large
  },
  /*
   * Copying a backup off the machine.
   *
   * The destination is a URL, and the one that works for a normal account in
   * somebody else's tenant is a Power Automate flow into OneDrive — the same
   * shape as the Teams webhook, and needing no Azure app registration or admin
   * consent, which is exactly what such an account cannot obtain.
   */
  backup: {
    offsite_enabled: false,
    offsite_url: '',
    offsite_secret: '',
    // A database-only copy is a fraction of the size, for sites whose photos
    // push the archive past what the flow will accept.
    offsite_include_media: true,
    offsite_last_at: '',
    offsite_last_ok: true,
    offsite_last_error: '',
    offsite_last_file: ''
  },
  privacy: {
    retain_visits_days: 730,
    retain_photos_days: 90,
    /*
     * A licence number is the most identifying thing this system holds, and it
     * is useful for far less time than the visit record it sits on — long
     * enough to answer a question about last month, not for two years. It gets
     * its own, shorter window, cleared from the visit while the visit stays.
     */
    retain_id_days: 180,
    hide_names_on_signout_list: false,
    /*
     * What the kiosk tells a visitor about what it is taking. Shown on the
     * details screen, where the asking happens, rather than buried in a
     * document they scroll past.
     */
    notice_enabled: true,
    notice_text: '',
    notice_text_es: ''
  }
};

/**
 * Phone conventions per country: the dialling code used to turn a locally typed
 * number into E.164 for SMS, the wording on the kiosk, and an example so people
 * can see the shape expected of them.
 */
const PHONE_COUNTRIES = {
  US: { dial: '+1', trunk: '', label: 'Phone number', example: '(555) 123-4567', name: 'United States' },
  CA: { dial: '+1', trunk: '', label: 'Phone number', example: '(555) 123-4567', name: 'Canada' },
  GB: { dial: '+44', trunk: '0', label: 'Mobile number', example: '07700 900123', name: 'United Kingdom' },
  IE: { dial: '+353', trunk: '0', label: 'Mobile number', example: '085 123 4567', name: 'Ireland' },
  AU: { dial: '+61', trunk: '0', label: 'Mobile number', example: '0412 345 678', name: 'Australia' },
  NZ: { dial: '+64', trunk: '0', label: 'Mobile number', example: '021 123 4567', name: 'New Zealand' }
};

const phoneCountry = (code) => PHONE_COUNTRIES[String(code || '').toUpperCase()] || PHONE_COUNTRIES.US;

const DETAIL_FIELDS = [
  ['photo', 'Photo'],
  ['company', 'Company'],
  ['phone', 'Phone number'],
  ['email', 'Email address'],
  ['staff', 'Who they are seeing'],
  ['purpose', 'Reason for visit'],
  ['vehicle', 'Vehicle registration'],
  ['reference', 'Load or order reference'],
  ['movement', 'Pick-Up or Delivery'],
  ['project', 'Project'],
  ['id_scan', "Scan a driver's licence"]
];

/** The languages the kiosk can be shown in. */
const LANGUAGES = [['en', 'English'], ['es', 'Español']];

/*
 * Every visitor type has a placement:
 *   card    — its own card on the home screen, straight into that sign-in
 *   picker  — offered when somebody taps the general Sign in card
 *   both    — the card and the picker
 *   off     — not offered anywhere (history and settings are kept)
 */
const TYPE_MODES = ['card', 'picker', 'both', 'off'];
// Words already meaning something on the home screen, which a type key must not shadow.
const RESERVED_TYPE_KEYS = ['signin', 'signout', 'delivery', 'unlock', 'menu', 'idle'];
const BUILTIN_TYPE_KEYS = ['visitor', 'contractor', 'interview', 'driver'];

/** The four original types, laid out exactly as the per-card switches have them. */
function builtinTypes(kiosk) {
  const picker = Array.isArray(kiosk.visit_types) ? kiosk.visit_types : ['visitor'];
  const mode = (key, cardOn) => {
    const inPicker = picker.includes(key);
    if (cardOn) return inPicker ? 'both' : 'card';
    return inPicker ? 'picker' : 'off';
  };
  return [
    { key: 'visitor', label: 'Visitor', icon: '👤', sub: '', mode: mode('visitor', false), builtin: true },
    { key: 'contractor', label: 'Contractor', icon: '🦺', sub: 'Working on site', mode: mode('contractor', !!kiosk.show_contractor_button), builtin: true },
    { key: 'interview', label: 'Interview', icon: '💼', sub: 'Here to meet the hiring team', mode: mode('interview', !!kiosk.show_interview_button), builtin: true },
    { key: 'driver', label: 'Driver', icon: '🚚', sub: 'Pick-up or delivery', mode: mode('driver', !!kiosk.show_driver_button), builtin: true }
  ];
}

/**
 * A types list as sent by the dashboard, made safe to store: real keys, no
 * duplicates or reserved words, sane modes, labels present. Returns null when
 * nothing usable is left, so the caller can refuse rather than store a kiosk
 * with no way to sign in.
 */
function sanitizeTypes(list) {
  if (!Array.isArray(list)) return null;
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const key = String(entry.key || '').toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
    const label = String(entry.label || '').trim().slice(0, 60);
    if (!key || !label || seen.has(key) || RESERVED_TYPE_KEYS.includes(key)) continue;
    seen.add(key);
    out.push({
      key,
      label,
      label_es: String(entry.label_es || '').trim().slice(0, 60),
      sub: String(entry.sub || '').trim().slice(0, 80),
      sub_es: String(entry.sub_es || '').trim().slice(0, 80),
      icon: String(entry.icon || '').trim().slice(0, 8) || '👤',
      mode: TYPE_MODES.includes(entry.mode) ? entry.mode : 'picker',
      builtin: BUILTIN_TYPE_KEYS.includes(key)
    });
  }
  return out.length ? out : null;
}

/**
 * Picks the wording for a language, falling back to English whenever the
 * translation has not been filled in. A half-translated site should read oddly,
 * never blankly.
 */
function inLanguage(row, field, lang) {
  if (!row) return '';
  const translated = lang && lang !== 'en' ? row[`${field}_${lang}`] : null;
  const value = translated && String(translated).trim() ? translated : row[field];
  return value == null ? '' : value;
}

/** The form configuration for one visitor type, falling back to the visitor one. */
function fieldsFor(visitType) {
  const details = module.exports.getAll().details;
  return details[visitType] || details.visitor;
}

const FLOW_STEPS = [
  ['details', 'Their details'],
  ['photo', 'Photo'],
  ['documents', 'Documents & questions'],
  ['induction', 'Induction deck']
];

/** The step order for a type, repaired if anything is missing or unknown. */
function flowFor(visitType) {
  const all = module.exports.getAll().flow || {};
  const configured = Array.isArray(all[visitType]) ? all[visitType] : (all.visitor || []);
  const known = FLOW_STEPS.map(([key]) => key);
  const ordered = configured.filter((s) => known.includes(s));
  // Anything left out still happens, at the end, rather than silently vanishing.
  return [...new Set([...ordered, ...known])];
}

/** True for IANA zone names Intl actually understands, e.g. "America/New_York". */
function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function isValidLocale(tag) {
  if (!tag || typeof tag !== 'string') return false;
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([tag]).length > 0;
  } catch {
    return false;
  }
}

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

/*
 * Settings saved before email and then SMS were removed still carry their
 * keys — including an SMTP password, an API key and a Twilio auth token. They
 * are dropped on read so nothing dead is served to the dashboard, and cleared
 * from storage the first time, so credentials for features that no longer
 * exist do not sit in the database indefinitely.
 */
const DEAD_NOTIFY_KEYS = ['email_enabled', 'email_provider', 'email_api_key', 'from_name', 'from_email',
  'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_pass', 'test_email_to',
  'sms_enabled', 'sms_provider', 'twilio_account_sid', 'twilio_auth_token', 'sms_from',
  'sms_on_signin', 'sms_on_delivery'];

function stripDeadKeys(stored) {
  if (!stored.notify || typeof stored.notify !== 'object') return false;
  const found = DEAD_NOTIFY_KEYS.filter((k) => k in stored.notify);
  if (!found.length) return false;
  for (const k of found) delete stored.notify[k];
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    'notify', JSON.stringify(stored.notify));
  console.log(`[settings] removed ${found.length} stored setting(s) left over from email and SMS notifications`);
  return true;
}

function getAll() {
  const rows = all('SELECT key, value FROM settings');
  const stored = {};
  for (const r of rows) {
    try { stored[r.key] = JSON.parse(r.value); } catch { stored[r.key] = r.value; }
  }
  stripDeadKeys(stored);
  const merged = deepMerge(DEFAULTS, stored);
  // A site that has never opened the Visitor types tab gets its list built from
  // the older switches, so nothing moves on the kiosk until someone edits it.
  if (!Array.isArray(merged.types) || !merged.types.length) merged.types = builtinTypes(merged.kiosk);
  // Installs made before backgrounds became a list keep working: the single
  // image is presented as a one-item list everywhere downstream.
  if (!Array.isArray(merged.org.backgrounds) || !merged.org.backgrounds.length) {
    merged.org.backgrounds = merged.org.background_path ? [merged.org.background_path] : [];
  }
  return merged;
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

/*
 * A revision number bumped on every admin change. Kiosks send the one they are
 * running when they check in; a different number means they reload their
 * configuration, so a change made in the dashboard reaches the tablets by
 * itself rather than needing someone to walk over and refresh them.
 */
const CONFIG_REV_KEY = '_config_rev';

function configRev() {
  const row = get('SELECT value FROM settings WHERE key = ?', CONFIG_REV_KEY);
  return row ? Number(row.value) || 0 : 0;
}

function bumpConfigRev() {
  const next = configRev() + 1;
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    CONFIG_REV_KEY, String(next));
  return next;
}

function setAll(patch) {
  for (const section of Object.keys(patch || {})) {
    if (DEFAULTS[section]) setSection(section, patch[section]);
  }
  return getAll();
}

/** Settings safe to expose to an unauthenticated kiosk (no SMTP creds). */
/**
 * What the kiosk tells a visitor about what it is taking.
 *
 * Written out rather than left to the site to remember, and assembled from
 * what is actually switched on — a notice mentioning a photo on a kiosk that
 * never asks for one is worse than none, because it is not true. Anything
 * typed into the settings box wins outright.
 */
function privacyNotice(lang = 'en') {
  const p = getAll().privacy || {};
  if (p.notice_enabled === false) return null;
  const written = lang === 'es' ? (p.notice_text_es || p.notice_text) : p.notice_text;
  if (written && written.trim()) return written.trim();

  const details = getAll().details || {};
  const asks = (field) => Object.values(details).some((d) => d && d[field] && d[field] !== 'off');
  const org = (getAll().org || {}).name || 'this site';
  const days = Number(p.retain_visits_days) || 0;
  const idDays = Number(p.retain_id_days) || 0;

  // "a, b and c" — a list joined with a comma throughout reads as one run-on
  // clause the moment the purpose is appended to it.
  const listOf = (items, and) => (items.length < 2 ? items[0] || ''
    : `${items.slice(0, -1).join(', ')} ${and} ${items[items.length - 1]}`);

  if (lang === 'es') {
    const taken = listOf(['su nombre y los datos que introduzca',
      asks('photo') ? 'una fotografía' : null,
      asks('id_scan') ? 'el nombre, el número y el estado emisor de su identificación' : null]
      .filter(Boolean), 'y');
    const kept = [days ? `los registros ${days} días` : null,
      idDays && asks('id_scan') ? `los datos de la identificación ${idDays} días` : null].filter(Boolean);
    return `${org} registra ${taken}, para saber quién está en las instalaciones, por seguridad y para el `
      + `control de incendios.${kept.length ? ` Se conservan ${listOf(kept, 'y')}.` : ''} `
      + 'Puede pedir una copia de sus datos o su eliminación en recepción.';
  }

  const taken = listOf(['your name and the details you enter',
    asks('photo') ? 'a photograph' : null,
    asks('id_scan') ? 'the name, number and issuing state on your ID' : null]
    .filter(Boolean), 'and');
  const kept = [days ? `records for ${days} days` : null,
    idDays && asks('id_scan') ? `ID details for ${idDays} days` : null].filter(Boolean);
  return `${org} records ${taken}, so we know who is on site for safety and fire roll call.`
    + `${kept.length ? ` We keep ${listOf(kept, 'and')}.` : ''} `
    + 'Ask at reception for a copy of your details or to have them removed.';
}

function publicSettings() {
  const s = getAll();
  return {
    org: s.org,
    // Only the notice: retention numbers and the rest stay on the server.
    /*
   * Copying a backup off the machine.
   *
   * The destination is a URL, and the one that works for a normal account in
   * somebody else's tenant is a Power Automate flow into OneDrive — the same
   * shape as the Teams webhook, and needing no Azure app registration or admin
   * consent, which is exactly what such an account cannot obtain.
   */
  backup: {
    offsite_enabled: false,
    offsite_url: '',
    offsite_secret: '',
    // A database-only copy is a fraction of the size, for sites whose photos
    // push the archive past what the flow will accept.
    offsite_include_media: true,
    offsite_last_at: '',
    offsite_last_ok: true,
    offsite_last_error: '',
    offsite_last_file: ''
  },
  privacy: { notice: privacyNotice('en'), notice_es: privacyNotice('es') },
    kiosk: s.kiosk,
    types: s.types,
    details: s.details,
    wording: s.wording,
    flow: s.flow,
    badge: { ...s.badge, mode: s.badge.mode },
    induction: s.induction,
    deliveries: s.deliveries,
    access: { enabled: s.access.enabled, unlock_button_on_kiosk: s.access.unlock_button_on_kiosk }
  };
}

module.exports = { DEFAULTS, getAll, getSection, setSection, setAll, publicSettings, privacyNotice, deepMerge,
  isValidTimeZone, isValidLocale, PHONE_COUNTRIES, phoneCountry, DETAIL_FIELDS, fieldsFor,
  FLOW_STEPS, flowFor, configRev, bumpConfigRev, LANGUAGES, inLanguage, sanitizeTypes, TYPE_MODES };
