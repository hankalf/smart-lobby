'use strict';
/**
 * What a notification looks like when it lands.
 *
 * Every channel used to get the same thing: a title and a bare list of lines.
 * That reads fine in a log and badly in a Teams channel somebody actually
 * watches — the useful part is a face and four facts, not a paragraph.
 *
 * So a notification is built once as a plain model — title, subtitle, a chosen
 * and ordered set of fields, a photo, a footer, a button — and each service
 * renders that model in its own idiom. The site decides what the model
 * contains from the Notifications settings, and the preview in the dashboard
 * renders the very same model, so what is designed there is what arrives.
 */

/**
 * Every fact a card can carry, in the order they are offered.
 *
 * `value` is given the joined visit row, so a field can be added here and it is
 * immediately selectable in the dashboard, previewable and sendable — there is
 * no second list to keep in step.
 */
const FIELDS = [
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
  // Off by default: a licence number in a channel everybody can scroll back
  // through is a different thing from one held in the visit record.
  { id: 'id_name', label: 'Name on ID', value: (v) => v.id_name, sensitive: true },
  { id: 'id_number', label: 'Licence number', value: (v) => v.id_number, sensitive: true },
  { id: 'id_state', label: 'ID issued by', value: (v) => v.id_state, sensitive: true }
];

const FIELD_BY_ID = Object.fromEntries(FIELDS.map((f) => [f.id, f]));

const title = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

/** Teams only understands its own palette, so a card style is a choice, not a colour. */
const HEADER_STYLES = ['none', 'accent', 'emphasis', 'good', 'warning', 'attention'];

const DEFAULT_CARD = {
  header_style: 'accent',
  title_template: '{name} has arrived to see {host}',
  subtitle_template: '{company}',
  show_photo: true,
  photo_placement: 'left',
  photo_shape: 'person',
  details_style: 'facts',
  fields: ['company', 'type', 'project', 'host', 'purpose', 'vehicle', 'badge', 'time'],
  footer_template: '{org} · Smart Lobby',
  show_button: false,
  button_label: 'Open Smart Lobby',
  /*
   * Tag the person being visited in the channel post, using the email on
   * their staff record. It is what turns a channel everybody half-watches
   * into something that actually reaches the one person who needs it, without
   * each of them having to set up a webhook of their own.
   */
  mention_host: true
};

/** Fill {name}, {company}, {host}… leaving nothing behind when a value is empty. */
function fill(template, tokens) {
  const text = String(template || '').replace(/\{(\w+)\}/g, (_, key) => tokens[key] || '');
  // "Ivan Ruiz has arrived to see " when nobody was named — tidy the seam.
  return text.replace(/\s+/g, ' ').replace(/[\s·,-]+$/, '').trim();
}

/**
 * Turn a visit into the model every channel renders.
 *
 * @param {object} v      the joined visit row
 * @param {object} card   the site's card settings
 * @param {object} ctx    { org, fmtTime, photoUrl, baseUrl, fallbackTitle }
 */
function buildModel(v, card, ctx) {
  const c = { ...DEFAULT_CARD, ...(card || {}) };
  /*
   * "…has arrived to see" with the name missing off the end reads as a bug.
   * A token that stands for a person gets the word reception uses out loud
   * when nobody was named; the rest simply vanish, and fill() closes the gap.
   */
  const tokens = {
    name: v.full_name || '',
    company: v.company || '',
    host: v.host_name || 'reception',
    type: v.visit_type ? title(v.visit_type) : '',
    site: v.site_name || '',
    project: v.project_name || '',
    org: (ctx.org && ctx.org.name) || ''
  };

  const chosen = Array.isArray(c.fields) ? c.fields : DEFAULT_CARD.fields;
  const fields = chosen
    .map((id) => FIELD_BY_ID[id])
    .filter(Boolean)
    .map((f) => ({ label: f.label, value: f.value(v, ctx) }))
    .filter((f) => f.value != null && String(f.value).trim() !== '');

  return {
    title: fill(c.title_template, tokens) || ctx.fallbackTitle || tokens.name,
    subtitle: fill(c.subtitle_template, tokens) || null,
    fields,
    photoUrl: c.show_photo ? (ctx.photoUrl || null) : null,
    photoPlacement: c.photo_placement === 'top' ? 'top' : 'left',
    photoShape: c.photo_shape === 'square' ? 'square' : 'person',
    headerStyle: HEADER_STYLES.includes(c.header_style) ? c.header_style : 'accent',
    detailsStyle: c.details_style === 'lines' ? 'lines' : 'facts',
    footer: fill(c.footer_template, tokens) || null,
    // Only with an address to tag: a mention of somebody Teams cannot resolve
    // renders as literal <at> markup, which is worse than no mention.
    mention: (c.mention_host !== false && v.host_email && v.host_name)
      ? { name: v.host_name, email: v.host_email }
      : null,
    action: c.show_button && ctx.baseUrl
      ? { label: c.button_label || DEFAULT_CARD.button_label, url: `${ctx.baseUrl}/admin/#visits` }
      : null
  };
}

/** A model with no fields to choose from — sign-outs and parcels stay simple. */
function plainModel({ title: heading, lines, photoUrl, org, card, mention }) {
  const c = { ...DEFAULT_CARD, ...(card || {}) };
  return {
    title: heading,
    subtitle: null,
    fields: lines.map((line) => {
      const at = String(line).indexOf(': ');
      return at > 0 ? { label: line.slice(0, at), value: line.slice(at + 2) } : { label: '', value: line };
    }),
    photoUrl: c.show_photo ? (photoUrl || null) : null,
    photoPlacement: c.photo_placement === 'top' ? 'top' : 'left',
    photoShape: c.photo_shape === 'square' ? 'square' : 'person',
    headerStyle: HEADER_STYLES.includes(c.header_style) ? c.header_style : 'accent',
    detailsStyle: c.details_style === 'lines' ? 'lines' : 'facts',
    footer: fill(c.footer_template, { org: (org && org.name) || '' }) || null,
    mention: (c.mention_host !== false && mention && mention.email && mention.name) ? mention : null,
    action: null
  };
}

/* ------------------------------------------------------------- renderers */

/*
 * An @-mention in a Teams card is two halves that have to agree: the literal
 * `<at>Name</at>` in the text, and an entity in msteams.entities whose `text`
 * matches it exactly and whose `mentioned.id` is the person's address. Get
 * either half wrong and Teams prints the markup instead of tagging anybody.
 */
const mentionTag = (m) => (m.mention ? `<at>${m.mention.name}</at>` : '');

function mentionEntities(m) {
  if (!m.mention) return null;
  return [{
    type: 'mention',
    text: mentionTag(m),
    mentioned: { id: m.mention.email, name: m.mention.name }
  }];
}

function teamsCard(m) {
  const heading = [
    { type: 'TextBlock', text: m.title, weight: 'Bolder', size: 'Medium', wrap: true,
      ...(m.headerStyle === 'none' ? {} : { color: colorFor(m.headerStyle) }) },
    ...(m.subtitle ? [{ type: 'TextBlock', text: m.subtitle, isSubtle: true, wrap: true, spacing: 'None' }] : []),
    ...(m.mention ? [{ type: 'TextBlock', text: `${mentionTag(m)} — your visitor is here.`, wrap: true, spacing: 'Small' }] : [])
  ];

  const details = m.detailsStyle === 'facts'
    ? (m.fields.length ? [{ type: 'FactSet', facts: m.fields.map((f) => ({ title: f.label ? `${f.label}:` : ' ', value: String(f.value) })) }] : [])
    : (m.fields.length
      ? [{ type: 'TextBlock', wrap: true, spacing: 'Small',
        text: m.fields.map((f) => (f.label ? `**${f.label}:** ${f.value}` : String(f.value))).join('\n\n') }]
      : []);

  const photo = m.photoUrl
    ? { type: 'Image', url: m.photoUrl, size: 'Medium', style: m.photoShape === 'person' ? 'Person' : 'Default',
      altText: 'Visitor photo' }
    : null;

  /*
   * A face beside the facts rather than above them: the same information in
   * roughly half the height, which is what makes it readable in a busy channel.
   */
  const main = photo && m.photoPlacement === 'left'
    ? [{
        type: 'ColumnSet',
        columns: [
          { type: 'Column', width: 'auto', items: [photo] },
          { type: 'Column', width: 'stretch', items: [...heading, ...details] }
        ]
      }]
    : [...(photo ? [photo] : []), ...heading, ...details];

  const body = m.headerStyle === 'none'
    ? main
    : [{ type: 'Container', style: containerStyle(m.headerStyle), bleed: true, items: main }];

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
        ...(m.action ? { actions: [{ type: 'Action.OpenUrl', title: m.action.label, url: m.action.url }] } : {}),
        ...(m.mention ? { msteams: { entities: mentionEntities(m) } } : {})
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
  const text = [`*${m.title}*`, ...(m.subtitle ? [m.subtitle] : []), ...asLines(m)].join('\n');
  return {
    text,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text },
        ...(m.photoUrl ? { accessory: { type: 'image', image_url: m.photoUrl, alt_text: 'visitor' } } : {}) },
      ...(m.footer ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: m.footer }] }] : [])
    ]
  };
}

const googleChatBody = (m) => ({
  text: [`*${m.title}*`, ...(m.subtitle ? [m.subtitle] : []), ...asLines(m)].join('\n')
});

const genericBody = (m) => ({
  event: m.title,
  subtitle: m.subtitle,
  details: asLines(m),
  fields: m.fields,
  photo_url: m.photoUrl || null,
  timestamp: new Date().toISOString()
});

function render(format, model) {
  if (format === 'teams') return teamsCard(model);
  if (format === 'google_chat') return googleChatBody(model);
  if (format === 'generic') return genericBody(model);
  return slackBody(model);
}

module.exports = { FIELDS, FIELD_BY_ID, DEFAULT_CARD, HEADER_STYLES, buildModel, plainModel, render, teamsCard };
