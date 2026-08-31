'use strict';
/**
 * What a notification looks like when it lands.
 *
 * Every channel used to get the same thing: a title and a bare list of lines.
 * That reads fine in a log and badly in a Teams channel somebody actually
 * watches — the useful part is a face and four facts, not a paragraph.
 *
 * So a notification is built once as a plain model — title, subtitle, a chosen
 * and ordered set of fields, a photo, a footer, some buttons — and each service
 * renders that model in its own idiom. The site decides what the model
 * contains from the Notifications settings, and the preview in the dashboard
 * renders the very same model, so what is designed there is what arrives.
 *
 * There are four things worth telling somebody about, and they are not the
 * same kind of message: an arrival wants a face and a project, a sign-out
 * wants a time, a parcel has no visitor on it at all. Each one therefore gets
 * its own design, its own fields and its own wording — see EVENTS below.
 */

/**
 * Every fact a card about a *visit* can carry, in the order they are offered.
 *
 * `value` is given the joined visit row, so a field can be added here and it is
 * immediately selectable in the dashboard, previewable and sendable — there is
 * no second list to keep in step.
 */
const VISIT_FIELDS = [
  { id: 'company', label: 'Company', value: (v) => v.company },
  { id: 'type', label: 'Visitor type', value: (v) => v.visit_type && title(v.visit_type) },
  { id: 'project', label: 'Project', value: (v) => v.project_name },
  { id: 'host', label: 'Here to see', value: (v) => v.host_name },
  { id: 'purpose', label: 'Purpose', value: (v) => v.purpose },
  { id: 'vehicle', label: 'Vehicle', value: (v) => v.vehicle_reg },
  { id: 'badge', label: 'Badge', value: (v) => v.badge_no },
  { id: 'phone', label: 'Phone', value: (v) => v.phone },
  { id: 'email', label: 'Email', value: (v) => v.email },
  { id: 'site', label: 'Site', value: (v) => v.site_name },
  { id: 'location', label: 'Location', value: (v) => v.location_name },
  { id: 'device', label: 'Signed in at', value: (v) => v.device_name },
  { id: 'time', label: 'Time', value: (v, ctx) => ctx.fmtTime(v.signed_in_at) },
  { id: 'signed_out', label: 'Signed out', value: (v, ctx) => v.signed_out_at && ctx.fmtTime(v.signed_out_at) },
  { id: 'duration', label: 'On site for', value: (v) => duration(v.signed_in_at, v.signed_out_at) },
  { id: 'completed', label: 'Completed', value: (v, ctx) => ctx.fmtTime(ctx.now || v.induction_at) },
  // Off by default: a licence number in a channel everybody can scroll back
  // through is a different thing from one held in the visit record.
  { id: 'id_name', label: 'Name on ID', value: (v) => v.id_name, sensitive: true },
  { id: 'id_number', label: 'Licence number', value: (v) => v.id_number, sensitive: true },
  { id: 'id_state', label: 'ID issued by', value: (v) => v.id_state, sensitive: true }
];

/** A parcel has none of a visitor's facts and several of its own. */
const DELIVERY_FIELDS = [
  { id: 'recipient', label: 'For', value: (d) => d.host_name || d.recipient_text },
  { id: 'courier', label: 'Courier', value: (d) => d.courier_name },
  { id: 'carrier', label: 'Carrier', value: (d) => d.courier_company },
  { id: 'parcels', label: 'Parcels', value: (d) => d.parcel_count },
  { id: 'tracking', label: 'Tracking', value: (d) => d.tracking },
  { id: 'notes', label: 'Notes', value: (d) => d.notes },
  { id: 'site', label: 'Site', value: (d) => d.site_name },
  { id: 'received', label: 'Received', value: (d, ctx) => ctx.fmtTime(d.received_at) },
  { id: 'collect', label: 'Collect from', value: () => 'Reception' }
];

const title = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

/** "3h 20m" — worth having on a sign-out card, meaningless on an arrival. */
function duration(from, to) {
  if (!from || !to) return null;
  const mins = Math.round((new Date(to) - new Date(from)) / 60000);
  if (!Number.isFinite(mins) || mins < 0) return null;
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}

/**
 * How wide the face is drawn, in pixels.
 *
 * Adaptive Cards' named sizes are advisory and Teams draws Medium small; an
 * explicit width is the only way to get a picture somebody can recognise.
 */
/*
 * Bigger than they were across the board. 120px was the old maximum, and at
 * that size a face in a Teams channel on a laptop is a thumbnail — recognisable
 * only if you already know who it is, which is the opposite of the job. The
 * card is also clickable now, so the size here is the glance and the tap is the
 * proper look.
 */
const PHOTO_PX = { small: 84, medium: 140, large: 200 };
const PHOTO_SIZES = Object.keys(PHOTO_PX);

/** Teams only understands its own palette, so a card style is a choice, not a colour. */
const HEADER_STYLES = ['none', 'accent', 'emphasis', 'good', 'warning', 'attention'];

/** Settings shared by every card, whatever the event. */
const CARD_BASE = {
  header_style: 'accent',
  show_photo: true,
  photo_placement: 'left',
  photo_shape: 'person',
  photo_size: 'large',
  details_style: 'facts',
  footer_template: '{org} · Smart Lobby',
  // The line naming anybody this visitor type is routed to, beyond the host.
  also_template: 'Also for {who}.',
  /*
   * `links` is deliberately absent rather than an empty array: absent means
   * "nobody has chosen buttons for this card", which is what lets a site that
   * had the older single Open-the-dashboard button keep it. An empty array
   * means somebody chose to have none.
   */
  /*
   * Tag the person concerned in the channel post, using the email on their
   * staff record. It is what turns a channel everybody half-watches into
   * something that actually reaches the one person who needs it, without each
   * of them having to set up a webhook of their own.
   */
  mention_host: true
};

/**
 * The four things worth telling somebody about.
 *
 * Each carries the defaults that make its card read correctly out of the box.
 * The wording matters more than it looks: a sign-out that says "your visitor
 * is here" is worse than no message, because somebody walks down to reception
 * for a person who has just left.
 */
const EVENTS = [
  {
    id: 'signin',
    label: 'Sign-ins',
    hint: 'When a visitor signs in at the kiosk',
    subject: 'visit',
    fields: VISIT_FIELDS,
    defaults: {
      title_template: '{name} has arrived to see {host}',
      subtitle_template: '{company}',
      mention_template: '{host} — your visitor is here.',
      fields: ['company', 'type', 'project', 'host', 'purpose', 'vehicle', 'badge', 'time'],
      header_style: 'accent',
      show_photo: true
    }
  },
  {
    id: 'signout',
    label: 'Sign-outs',
    hint: 'When a visitor signs out and leaves site',
    subject: 'visit',
    fields: VISIT_FIELDS,
    defaults: {
      title_template: '{name} has signed out',
      subtitle_template: '{company}',
      mention_template: '{host} — your visitor has left site.',
      fields: ['company', 'host', 'signed_out', 'duration'],
      header_style: 'emphasis',
      // A face is what makes an arrival useful at the desk. On the way out it
      // is just a second picture of somebody who has gone.
      show_photo: false
    }
  },
  {
    id: 'induction',
    label: 'Finished site induction',
    hint: 'When somebody finishes the induction deck and signs it',
    subject: 'visit',
    fields: VISIT_FIELDS,
    defaults: {
      title_template: '{name} has completed the site induction',
      subtitle_template: '{company}',
      mention_template: '{host} — your visitor is inducted and cleared to work.',
      fields: ['company', 'type', 'project', 'completed'],
      header_style: 'good',
      show_photo: true
    }
  },
  {
    id: 'delivery',
    label: 'Parcel arrives',
    hint: 'When reception books in a delivery',
    subject: 'delivery',
    fields: DELIVERY_FIELDS,
    defaults: {
      title_template: 'Delivery waiting for {recipient}',
      subtitle_template: '{carrier}',
      mention_template: '{host} — a parcel is waiting for you at reception.',
      fields: ['courier', 'carrier', 'parcels', 'tracking', 'received', 'collect'],
      header_style: 'warning',
      // A parcel is a box, not a person.
      show_photo: false
    }
  }
];

const EVENT_BY_ID = Object.fromEntries(EVENTS.map((e) => [e.id, e]));

/** Everything a card of this kind can be, defaults filled in. */
const cardDefaults = (eventId) => ({ ...CARD_BASE, ...(EVENT_BY_ID[eventId] || EVENT_BY_ID.signin).defaults });

/** Kept for the settings file's shape, and for anything still asking. */
const DEFAULT_CARD = cardDefaults('signin');

/**
 * The design in force for one event.
 *
 * `notify.cards.<event>` is where a design lives once somebody has touched it.
 * Before that, sign-ins fall back to `notify.card` — the single shared design
 * that existed before there were four of them — so a site that had one set up
 * keeps exactly the card it had. The other three start from their own
 * defaults rather than inheriting an arrival's wording, which would have them
 * announcing that a parcel had arrived to see somebody.
 */
function cardFor(eventId, notify, visitType) {
  const base = cardDefaults(eventId);
  const own = notify && notify.cards && notify.cards[eventId];
  let merged = (own && typeof own === 'object') ? { ...base, ...own }
    : (eventId === 'signin' && notify && notify.card) ? { ...base, ...notify.card }
      : base;

  /*
   * And one more layer, for a visitor type that wants its own card.
   *
   * A contractor arriving and somebody here for an interview are not the same
   * message: one wants the project and a hard hat colour, the other wants
   * discretion. Most sites need one design per event and never touch this, so
   * an override exists only where somebody made one — absent means "the same
   * as every other type", which is what leaving it alone should mean.
   */
  const byType = own && own.by_type;
  const forType = visitType && byType && typeof byType === 'object' ? byType[visitType] : null;
  if (forType && typeof forType === 'object') merged = { ...merged, ...forType };

  // Resolved here, once, so the designer shows the same buttons that send.
  return { ...merged, links: linkIds(merged) };
}

/** Which visitor types have a design of their own, for this event. */
function typesWithOwnCard(eventId, notify) {
  const own = notify && notify.cards && notify.cards[eventId];
  const byType = own && own.by_type;
  if (!byType || typeof byType !== 'object') return [];
  return Object.keys(byType).filter((k) => byType[k] && typeof byType[k] === 'object');
}

/**
 * Buttons along the bottom of the card.
 *
 * The point of a notification is usually to make somebody go and look at
 * something, and until now that meant reading the message, opening a tab,
 * finding the bookmark, signing in. One tap instead.
 *
 * `url` is given the same context the fields get, so a link that needs
 * something the deployment holds — the board's key, say — can build itself
 * and simply return null when that thing is not set up. A link that has no
 * address is dropped rather than rendered as a dead button.
 */
const LINKS = [
  { id: 'dashboard', label: 'Dashboard', url: (ctx) => adminUrl(ctx, 'dashboard') },
  { id: 'visits', label: "Today's visits", url: (ctx) => adminUrl(ctx, 'visits') },
  { id: 'board', label: "Who's on site", url: (ctx) => ctx.boardUrl || null,
    needs: 'the live on-site board switched on' },
  { id: 'visitors', label: 'Visitor registry', url: (ctx) => adminUrl(ctx, 'visitors') },
  { id: 'deliveries', label: 'Deliveries', url: (ctx) => adminUrl(ctx, 'deliveries') },
  { id: 'drivers', label: 'Drivers', url: (ctx) => adminUrl(ctx, 'drivers') },
  { id: 'reports', label: 'Reports', url: (ctx) => adminUrl(ctx, 'reports') },
  { id: 'kiosk', label: 'Open kiosk', url: (ctx) => (ctx.baseUrl ? `${ctx.baseUrl}/kiosk/` : null) }
];

const LINK_BY_ID = Object.fromEntries(LINKS.map((l) => [l.id, l]));

const adminUrl = (ctx, view) => (ctx.baseUrl ? `${ctx.baseUrl}/admin/#${view}` : null);

/**
 * Teams lays a few buttons out side by side and hides the rest behind an
 * overflow menu, which defeats the point of a quick link.
 */
const LINKS_MAX = 4;

/**
 * Which buttons a design asks for.
 *
 * `show_button` was the older single-button setting, which opened the visits
 * list. A site that had it on keeps that button as a chosen link, so nothing
 * disappears on upgrade — its custom wording gives way to the standard label,
 * which is the price of the designer and the sent card agreeing on one list
 * rather than each working it out its own way.
 */
const linkIds = (c) => (Array.isArray(c.links) ? c.links : (c.show_button ? ['visits'] : []))
  .filter((id) => LINK_BY_ID[id])
  .slice(0, LINKS_MAX);

/** Those buttons resolved against this deployment, dropping any with no address. */
function buildLinks(c, ctx) {
  return linkIds(c)
    .map((id) => ({ id, label: LINK_BY_ID[id].label, url: LINK_BY_ID[id].url(ctx) }))
    .filter((l) => l.url);
}

/** Fill {name}, {company}, {host}… leaving nothing behind when a value is empty. */
function fill(template, tokens) {
  const text = String(template || '').replace(/\{(\w+)\}/g, (_, key) => tokens[key] || '');
  // "John Doe has arrived to see " when nobody was named — tidy the seam.
  return text.replace(/\s+/g, ' ').replace(/^[\s·,—-]+/, '').replace(/[\s·,—-]+$/, '').trim();
}

/** The words a template can use, and what they stand for, per event. */
const TOKENS = {
  visit: [
    ['name', 'the visitor'], ['company', 'their company'], ['host', 'who they are seeing'],
    ['type', 'visitor type'], ['project', 'the project'], ['site', 'the site'], ['org', 'your organisation']
  ],
  delivery: [
    ['recipient', 'who it is for'], ['host', 'the staff member'], ['courier', 'the driver'],
    ['carrier', 'the carrier'], ['parcels', 'how many'], ['tracking', 'the tracking number'],
    ['site', 'the site'], ['org', 'your organisation']
  ]
};

function visitTokens(v, ctx) {
  return {
    name: v.full_name || '',
    company: v.company || '',
    /*
     * "…has arrived to see" with the name missing off the end reads as a bug.
     * A token that stands for a person gets the word reception uses out loud
     * when nobody was named; the rest simply vanish, and fill() closes the gap.
     */
    host: v.host_name || 'reception',
    type: v.visit_type ? title(v.visit_type) : '',
    site: v.site_name || '',
    project: v.project_name || '',
    org: (ctx.org && ctx.org.name) || ''
  };
}

function deliveryTokens(d, ctx) {
  return {
    recipient: d.host_name || d.recipient_text || 'reception',
    host: d.host_name || 'reception',
    courier: d.courier_name || '',
    carrier: d.courier_company || '',
    parcels: d.parcel_count == null ? '' : String(d.parcel_count),
    tracking: d.tracking || '',
    site: d.site_name || '',
    org: (ctx.org && ctx.org.name) || ''
  };
}

/**
 * Turn a row into the model every channel renders.
 *
 * @param {string} eventId  signin | signout | induction | delivery
 * @param {object} row      the joined visit or delivery row
 * @param {object} notify   the whole notify settings section
 * @param {object} ctx      { org, fmtTime, photoUrl, baseUrl, boardUrl, mention, now }
 */
function buildModel(eventId, row, notify, ctx) {
  const event = EVENT_BY_ID[eventId] || EVENT_BY_ID.signin;
  // A parcel has no visitor type, so only the visit events can vary by one.
  const visitType = event.subject === 'visit' ? (ctx.visitType || row.visit_type) : null;
  const c = cardFor(event.id, notify, visitType);
  const tokens = event.subject === 'delivery' ? deliveryTokens(row, ctx) : visitTokens(row, ctx);

  const byId = Object.fromEntries(event.fields.map((f) => [f.id, f]));
  const chosen = Array.isArray(c.fields) ? c.fields : event.defaults.fields;
  const fields = chosen
    .map((id) => byId[id])
    .filter(Boolean)
    .map((f) => ({ label: f.label, value: f.value(row, ctx) }))
    .filter((f) => f.value != null && String(f.value).trim() !== '');

  /*
   * Only somebody Teams can resolve gets tagged: a mention of an address it
   * does not know renders as literal <at> markup, which is worse than none.
   */
  const who = ctx.mention || { name: row.host_name, email: row.host_email };
  const mention = (c.mention_host !== false && who && who.email && who.name)
    ? { name: who.name, email: who.email }
    : null;

  /*
   * Anybody this visitor type is routed to. Not behind `mention_host`: that
   * toggle is about the person being visited, and somebody who asked to be
   * told about every contractor still wants telling when it is off.
   */
  const also = (ctx.also || [])
    .filter((p) => p && p.email && p.name)
    .filter((p) => !mention || p.email.toLowerCase() !== mention.email.toLowerCase())
    .map((p) => ({ name: p.name, email: p.email }));

  return {
    event: event.id,
    visitType: visitType || null,
    title: fill(c.title_template, tokens) || ctx.fallbackTitle || tokens.name || event.label,
    subtitle: fill(c.subtitle_template, tokens) || null,
    fields,
    photoUrl: c.show_photo ? (ctx.photoUrl || null) : null,
    /*
     * Where tapping the face leads. The same signed link the card shows, which
     * is good for as long as the photo is kept — so the picture opens in the
     * browser at whatever size the screen allows.
     */
    photoLinkUrl: c.show_photo ? (ctx.photoUrl || null) : null,
    photoPlacement: c.photo_placement === 'top' ? 'top' : 'left',
    photoShape: c.photo_shape === 'square' ? 'square' : 'person',
    photoSize: PHOTO_SIZES.includes(c.photo_size) ? c.photo_size : 'large',
    headerStyle: HEADER_STYLES.includes(c.header_style) ? c.header_style : 'accent',
    detailsStyle: c.details_style === 'lines' ? 'lines' : 'facts',
    footer: fill(c.footer_template, tokens) || null,
    mention,
    // Kept as a template so each channel can put its own idea of a tag where
    // {host} is — Teams gets <at>…</at>, Slack gets a plain name.
    mentionTemplate: mention ? (c.mention_template || cardDefaults(event.id).mention_template) : null,
    alsoMention: also,
    alsoTemplate: also.length ? (c.also_template || CARD_BASE.also_template) : null,
    links: buildLinks(c, ctx)
  };
}

/* ------------------------------------------------------------- renderers */

/*
 * An @-mention in a Teams card is two halves that have to agree: the literal
 * `<at>Name</at>` in the text, and an entity in msteams.entities whose `text`
 * matches it exactly and whose `mentioned.id` is the person's address. Get
 * either half wrong and Teams prints the markup instead of tagging anybody.
 */
const tagFor = (person) => `<at>${person.name}</at>`;

const mentionTag = (m) => (m.mention ? tagFor(m.mention) : '');

const mentionLine = (m, tag) =>
  (m.mention && m.mentionTemplate ? fill(m.mentionTemplate, { host: tag }) : '');

/** "A, B and C" — a list a person reads rather than a comma-separated dump. */
function joinNames(names) {
  if (names.length <= 1) return names[0] || '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

const alsoLine = (m, tag) => (m.alsoMention && m.alsoMention.length && m.alsoTemplate
  ? fill(m.alsoTemplate, { who: joinNames(m.alsoMention.map(tag)) })
  : '');

/** Everybody the card tags, host first — Teams needs one entity for each. */
const mentioned = (m) => [...(m.mention ? [m.mention] : []), ...(m.alsoMention || [])];

function mentionEntities(m) {
  const all = mentioned(m);
  if (!all.length) return null;
  return all.map((person) => ({
    type: 'mention',
    text: tagFor(person),
    mentioned: { id: person.email, name: person.name }
  }));
}

function teamsCard(m) {
  const line = mentionLine(m, mentionTag(m));
  const routed = alsoLine(m, tagFor);
  const heading = [
    { type: 'TextBlock', text: m.title, weight: 'Bolder', size: 'Medium', wrap: true,
      ...(m.headerStyle === 'none' ? {} : { color: colorFor(m.headerStyle) }) },
    ...(m.subtitle ? [{ type: 'TextBlock', text: m.subtitle, isSubtle: true, wrap: true, spacing: 'None' }] : []),
    ...(line ? [{ type: 'TextBlock', text: line, wrap: true, spacing: 'Small' }] : []),
    ...(routed ? [{ type: 'TextBlock', text: routed, wrap: true, isSubtle: true, spacing: 'Small' }] : [])
  ];

  const details = m.detailsStyle === 'facts'
    ? (m.fields.length ? [{ type: 'FactSet', facts: m.fields.map((f) => ({ title: f.label ? `${f.label}:` : ' ', value: String(f.value) })) }] : [])
    : (m.fields.length
      ? [{ type: 'TextBlock', wrap: true, spacing: 'Small',
        text: m.fields.map((f) => (f.label ? `**${f.label}:** ${f.value}` : String(f.value))).join('\n\n') }]
      : []);

  /*
   * An explicit width rather than size: 'Medium', which Teams renders at
   * around 64px — a thumbnail too small to recognise anybody from across a
   * desk, which is the entire point of putting a face on the card.
   */
  const photo = m.photoUrl
    ? {
      type: 'Image',
      url: m.photoUrl,
      width: `${PHOTO_PX[m.photoSize] || PHOTO_PX.large}px`,
      style: m.photoShape === 'person' ? 'Person' : 'Default',
      altText: 'Visitor photo — tap to see it full size',
      /*
       * Tapping the face opens the picture itself. Teams renders a card at
       * whatever width the window gives it, so on a phone or a narrow channel
       * even a large image is small; selectAction is the only way to let
       * somebody actually look at the person without leaving Teams to go and
       * find the visit record.
       */
      ...(m.photoLinkUrl ? { selectAction: { type: 'Action.OpenUrl', title: 'See the photo', url: m.photoLinkUrl } } : {})
    }
    : null;

  /*
   * A face beside the heading, and the facts at full width underneath.
   *
   * Both used to sit in the same narrow column beside the photo, which left
   * the facts perhaps two thirds of the card to lay out a label and a value
   * in — so long values wrapped raggedly or were cut off, and the card was
   * taller than it needed to be anyway. The heading is short and reads well
   * next to a face; the facts want the whole width.
   */
  const main = photo && m.photoPlacement === 'left'
    ? [{
        type: 'ColumnSet',
        spacing: 'None',
        columns: [
          { type: 'Column', width: 'auto', verticalContentAlignment: 'Center', items: [photo] },
          { type: 'Column', width: 'stretch', spacing: 'Medium',
            verticalContentAlignment: 'Center', items: heading }
        ]
      }, ...details.map((d) => ({ ...d, spacing: 'Medium' }))]
    : [...(photo ? [photo] : []), ...heading, ...details];

  const body = m.headerStyle === 'none'
    ? main
    : [{ type: 'Container', style: containerStyle(m.headerStyle), bleed: true, items: main }];

  const links = m.links || [];

  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      contentUrl: null,
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body: [
          ...body,
          ...(m.footer ? [{ type: 'TextBlock', text: m.footer, isSubtle: true, size: 'Small', wrap: true, spacing: 'Medium' }] : [])
        ],
        ...(links.length ? { actions: links.map((l) => ({ type: 'Action.OpenUrl', title: l.label, url: l.url })) } : {}),
        ...(mentioned(m).length ? { msteams: { entities: mentionEntities(m) } } : {})
      }
    }]
  };
}

// Adaptive Cards name their colours; there is no hex to set, on any host.
const colorFor = (style) => ({ accent: 'Accent', good: 'Good', warning: 'Warning', attention: 'Attention' }[style] || 'Default');
const containerStyle = (style) => (style === 'emphasis' ? 'emphasis' : style === 'none' ? 'default' : style);

const asLines = (m) => m.fields.map((f) => (f.label ? `${f.label}: ${f.value}` : String(f.value)));

function slackBody(m) {
  // Slack tags by its own user id, not an email, so the name is all we can
  // honestly put here — <at> markup would arrive as literal text.
  const line = m.mention ? mentionLine(m, m.mention.name) : '';
  const routed = alsoLine(m, (p) => p.name);
  const text = [`*${m.title}*`, ...(m.subtitle ? [m.subtitle] : []),
    ...(line ? [line] : []), ...(routed ? [routed] : []), ...asLines(m)].join('\n');
  const links = m.links || [];
  return {
    text,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text },
        ...(m.photoUrl ? { accessory: { type: 'image', image_url: m.photoUrl, alt_text: 'visitor' } } : {}) },
      ...(links.length ? [{ type: 'actions', elements: links.map((l) => ({
        type: 'button', text: { type: 'plain_text', text: l.label }, url: l.url })) }] : []),
      ...(m.footer ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: m.footer }] }] : [])
    ]
  };
}

const googleChatBody = (m) => ({
  text: [
    `*${m.title}*`,
    ...(m.subtitle ? [m.subtitle] : []),
    ...(m.mention ? [mentionLine(m, m.mention.name)].filter(Boolean) : []),
    ...[alsoLine(m, (p) => p.name)].filter(Boolean),
    ...asLines(m),
    ...(m.links || []).map((l) => `<${l.url}|${l.label}>`)
  ].join('\n')
});

const genericBody = (m) => ({
  event: m.title,
  event_type: m.event || null,
  subtitle: m.subtitle,
  details: asLines(m),
  fields: m.fields,
  links: m.links || [],
  notified: mentioned(m).map((p) => ({ name: p.name, email: p.email })),
  photo_url: m.photoUrl || null,
  timestamp: new Date().toISOString()
});

function render(format, model) {
  if (format === 'teams') return teamsCard(model);
  if (format === 'google_chat') return googleChatBody(model);
  if (format === 'generic') return genericBody(model);
  return slackBody(model);
}

/** What the dashboard needs to draw the designers, without duplicating any of it. */
const catalogue = () => ({
  events: EVENTS.map((e) => ({
    id: e.id, label: e.label, hint: e.hint, subject: e.subject,
    defaults: cardDefaults(e.id),
    fields: e.fields.map(({ id, label, sensitive }) => ({ id, label, sensitive: !!sensitive })),
    tokens: TOKENS[e.subject]
  })),
  links: LINKS.map(({ id, label, needs }) => ({ id, label, needs: needs || null })),
  // Only the visit events can differ by visitor type; a parcel has none.
  per_type_events: EVENTS.filter((e) => e.subject === 'visit').map((e) => e.id),
  photo_sizes: PHOTO_SIZES.map((key) => ({ key, px: PHOTO_PX[key] })),
  links_max: LINKS_MAX,
  header_styles: HEADER_STYLES
});

module.exports = {
  VISIT_FIELDS, DELIVERY_FIELDS, EVENTS, EVENT_BY_ID, LINKS, LINKS_MAX,
  DEFAULT_CARD, CARD_BASE, HEADER_STYLES, PHOTO_PX, PHOTO_SIZES, cardDefaults, cardFor,
  typesWithOwnCard, catalogue,
  buildModel, render, teamsCard,
  // Older name, older shape: one shared design and a list of ready-made lines.
  FIELDS: VISIT_FIELDS, FIELD_BY_ID: Object.fromEntries(VISIT_FIELDS.map((f) => [f.id, f]))
};
