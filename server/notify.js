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
/*
 * Where this install can be reached from outside.
 *
 * Four answers, best first, because getting this wrong is invisible until
 * somebody clicks a link:
 *
 *   1. What an administrator typed, if they typed one.
 *   2. PUBLIC_URL, for a deployment that sets it.
 *   3. The host of a real request that has actually arrived — which needs no
 *      configuration at all and is right by construction. Remembered, so a
 *      notification sent from a background job hours later still has it.
 *   4. Railway's own domain variable, so a fresh deploy is right before the
 *      first request arrives.
 *
 * localhost is the last resort and means nothing has told us anything. It used
 * to be the only fallback, which is how a site running on Railway with no
 * PUBLIC_URL set handed out an on-site board link pointing at localhost:8080 —
 * a link that works on the server and nowhere else in the world.
 */
let seenOrigin = '';

/** Remember the origin a real request arrived on. See baseUrl above. */
function rememberOrigin(req) {
  try {
    const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    if (!host || /^localhost|^127\.|^\[?::1\]?/i.test(host)) return;
    seenOrigin = `${String(proto).split(',')[0].trim()}://${String(host).split(',')[0].trim()}`;
  } catch { /* a malformed header is not worth failing a request over */ }
}

const baseUrl = () => {
  const railway = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '';
  const configured = settings.getSection('notify').public_url
    || process.env.PUBLIC_URL
    || seenOrigin
    || railway
    || '';
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
  /*
   * Answered rather than thrown. A caller that hands this the wrong shape is a
   * bug either way, but the cost of the bug should be a failed notification,
   * not a dead process — this is called from routes, and an async route that
   * throws takes the server with it. That is not a hypothetical: a test button
   * passed the pre-design shape, this read a property of undefined, and the
   * gate stopped answering.
   */
  if (!model || typeof model !== 'object') {
    return { ok: false, status: 0, detail: 'Nothing to send — the message was not built.' };
  }
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
    return {
      ok: res.ok,
      status: res.status,
      // Told apart so the page can say "accepted" where that is all we know.
      accepted_only: res.status === 202,
      detail: explainWebhookError(res.status, text, format)
    };
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
  /*
   * 202 is not "delivered", and the difference matters.
   *
   * A Teams workflow's webhook is an HTTP trigger: it accepts the request and
   * answers 202 straight away, then runs the flow — the step that actually
   * posts the card — afterwards. So a 202 says the message was accepted, and
   * says nothing at all about whether it arrived.
   *
   * This used to report "Delivered." for it, which is how a workflow that was
   * failing every single run for a fortnight could sit behind a test button
   * that said everything was fine. Nothing here can see the flow's own run
   * history; the honest thing is to say where to look.
   */
  if (status === 202) {
    return 'Accepted. A Teams workflow answers this the moment it takes the request and posts the card '
      + 'afterwards, so it can still fail at that step — if nothing appears in the chat or channel, open '
      + 'the flow in Power Automate and read its run history.';
  }
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
 * The channel this kind of visitor has of its own, if this event is one it
 * wants.
 *
 * Different in kind from routedStaff above, and the difference is the point: a
 * routed person is tagged by name and messaged directly, which is right for a
 * safety officer and wrong for a team of eight. A channel is a place — whoever
 * needs to know about contractors is added to the Contractors team in Teams by
 * whoever runs it, rather than one at a time in these settings by an
 * administrator who has to be asked.
 *
 * The site's own channel still hears everything; this is in addition to it,
 * never instead of it.
 *
 * @param {string} visitType
 * @param {'signin'|'signout'|'induction'} event
 * @returns {string|null}
 */
function typeChannel(visitType, event) {
  const routing = settings.getSection('notify').type_routing || {};
  const mine = routing[visitType] || {};
  const url = String(mine.webhook_url || '').trim();
  if (!url) return null;
  /*
   * Absent means yes. A channel set up for contractors should hear about an
   * event added to the software next year, rather than quietly not — the same
   * rule types_notified uses, for the same reason.
   */
  const events = mine.events || {};
  return events[event] === false ? null : url;
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
    ownUrl: v.host_webhook,
    extraUrls: [...also.map((p) => p.webhook_url), typeChannel(v.visit_type, 'signin')],
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
    ownUrl: v.host_webhook,
    extraUrls: [...also.map((p) => p.webhook_url), typeChannel(v.visit_type, 'signout')],
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

  /*
   * The same window the device watch uses, rather than a fixed hour of its
   * own: a site that set the threshold to five minutes because the gate matters
   * should not then wait an hour for the dashboard to agree.
   */
  const quietAfter = Math.min(1440, Math.max(2, Number(settings.getSection('notify').device_quiet_minutes) || 15));
  const quiet = all(
    `SELECT name, last_seen_at FROM devices
     WHERE last_seen_at IS NOT NULL AND last_seen_at < ? ORDER BY last_seen_at`,
    new Date(Date.now() - quietAfter * 60_000).toISOString());

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
    ownUrl: v.host_webhook,
    extraUrls: [...also.map((p) => p.webhook_url), typeChannel(v.visit_type, 'induction')],
    model, visit_id: visitId
  });
}

/**
 * A sign-in that was cancelled on the kiosk seconds after it was made.
 *
 * Takes the record rather than an id, because by the time this is sent the
 * visit has been archived and there is nothing left to read.
 *
 * Deliberately not a card anybody can design. The other four are announcements
 * and a house style is fine on them; this one exists to contradict a card that
 * already went out, and it should look like a correction wherever it lands.
 * It reuses the sign-in card only for who to tag — the people who were told.
 */
async function notifyCancelled(v) {
  const n = settings.getSection('notify');
  if (!n.on_signin || !v || !typeNotified(v.visit_type)) return;
  const also = routedStaff(v.visit_type);
  const model = cards.buildModel('signin', v, n, cardContext({ also, fallbackTitle: v.full_name }));

  model.title = `Cancelled — ${v.full_name} is not signed in`;
  model.subtitle = 'That sign-in was undone at the kiosk moments after it was made. Please ignore the earlier message.';
  model.headerStyle = 'attention';
  model.photoUrl = null;
  // Nothing to open: the visit is gone, so a link to it would lead nowhere.
  model.links = [];
  model.footer = null;

  /*
   * Wherever the sign-in went, including the type's own channel: a correction
   * that does not reach everyone who read the thing it corrects is worse than
   * no correction at all.
   */
  await sendWebhooks({
    ownUrl: v.host_webhook,
    extraUrls: [...also.map((p) => p.webhook_url), typeChannel(v.visit_type, 'signin')],
    model, visit_id: null
  });
}

/**
 * A tablet that has stopped checking in, and one that has come back.
 *
 * Not a visitor event, so it does not go through the card designer: a site
 * notice should look like a site notice wherever it lands, and there is no
 * visitor to design a card around. It is posted to the company channel only —
 * the person a visitor came to see has no use for it, and waking every host
 * on the site because a tablet rebooted is how people mute the channel.
 */
async function notifyDevice(device, state) {
  const n = settings.getSection('notify');
  if (!n.on_device_offline) return;
  const down = state === 'down';
  const quiet = device.last_seen_at
    ? Math.round((Date.now() - Date.parse(device.last_seen_at)) / 60000) : null;

  const model = {
    event: down ? 'device_offline' : 'device_back',
    title: down ? `Kiosk offline — ${device.name}` : `Kiosk back online — ${device.name}`,
    subtitle: down
      ? 'It has stopped checking in. Nobody can sign in or out on it until it is back.'
      : 'It is checking in again.',
    fields: [
      { label: 'Tablet', value: device.name },
      ...(device.location_name ? [{ label: 'Where', value: device.location_name }] : []),
      { label: down ? 'Last seen' : 'Was quiet for',
        value: down
          ? `${fmtTime(device.last_seen_at)}${quiet != null ? ` — ${quiet} minutes ago` : ''}`
          : (quiet != null ? `${quiet} minutes` : 'a while') }
    ],
    photoUrl: null,
    photoPlacement: 'top',
    photoShape: 'square',
    photoSize: 'small',
    headerStyle: down ? 'attention' : 'good',
    detailsStyle: 'facts',
    footer: null,
    mention: null,
    mentionTemplate: null,
    alsoMention: [],
    alsoTemplate: null,
    // Somewhere to go and look: the Devices page says what every tablet is
    // doing, which is the next thing anybody reading this wants.
    links: [{ id: 'devices', label: 'Open Devices', url: `${baseUrl()}/admin/#devices` }]
  };

  // The company channel only — see above.
  await sendWebhooks({ ownUrl: null, extraUrls: [], model, visit_id: null });
}

/**
 * A badge printer somebody has marked as not printing, and the same when it is
 * working again.
 *
 * Worded as somebody's report rather than as an observation, because that is
 * what it is. Nothing here has spoken to the printer — it cannot: badges print
 * over AirPrint from the tablet, and on Wireless Direct the printer sits on a
 * network only that tablet has joined. Announcing "the printer is offline"
 * would be claiming knowledge this system does not have, and the first time it
 * was wrong nobody would believe the next one.
 *
 * @param {object} printer  the printer record
 * @param {'down'|'back'} state
 * @param {string} [by]     who said so
 * @param {string} [note]   what they said about it
 */
async function notifyPrinter(printer, state, by, note) {
  const n = settings.getSection('notify');
  if (!n.on_printer_trouble) return;
  const down = state === 'down';
  const since = printer.trouble_since
    ? Math.round((Date.now() - Date.parse(printer.trouble_since)) / 60000) : null;

  const model = {
    event: down ? 'printer_trouble' : 'printer_back',
    title: down ? `Badges are not printing — ${printer.name}` : `Badges are printing again — ${printer.name}`,
    subtitle: down
      ? 'Reported from the desk. Sign-ins are still being recorded — only the badge is missing.'
      : 'Marked as working again from the desk.',
    fields: [
      { label: 'Printer', value: printer.name },
      ...(printer.location_name ? [{ label: 'Where', value: printer.location_name }] : []),
      ...(down && printer.label_type ? [{ label: 'Roll', value: printer.label_type }] : []),
      ...(by ? [{ label: down ? 'Reported by' : 'Cleared by', value: by }] : []),
      ...(down && note ? [{ label: 'Note', value: note }] : []),
      ...(!down && since != null ? [{ label: 'Down for', value: `${since} minutes` }] : []),
      /*
       * The three things that account for almost every case, in the order
       * worth checking them. On the card because whoever reads it is usually
       * nowhere near the printer, and would otherwise walk to it to find out
       * it is out of labels.
       */
      ...(down ? [{ label: 'Worth checking', value: 'Out of labels · switched off · off its Wi-Fi' }] : [])
    ],
    photoUrl: null,
    photoPlacement: 'top',
    photoShape: 'square',
    photoSize: 'small',
    headerStyle: down ? 'attention' : 'good',
    detailsStyle: 'facts',
    footer: null,
    mention: null,
    mentionTemplate: null,
    alsoMention: [],
    alsoTemplate: null,
    links: [{ id: 'printers', label: 'Open Printers', url: `${baseUrl()}/admin/#printers` }]
  };

  await sendWebhooks({ ownUrl: null, extraUrls: [], model, visit_id: null });
}

module.exports = { notifyArrival, notifyDeparture, notifyDelivery, notifyInduction, notifyCancelled,
  notifyDevice,
  notifyPrinter,
  detailFor: visitDetail,
  sendWebhook, sendWebhooks, webhookTargets, baseUrl, rememberOrigin, boardUrl, cardPhotoUrl, cardContext, visitDetail, fmtTime,
  retryPending, health, RETRY_DELAYS_MS, typeNotified, routedStaff };
