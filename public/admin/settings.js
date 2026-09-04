/*
 * Settings — every panel under the Settings heading.
 *
 * The panels share one settings object, one auto-saver and several collectors
 * that read the DOM, which is why they are still built in one pass: only the
 * chosen panel is on screen, and switching is a show/hide rather than a
 * re-render, so nothing half-typed is lost on the way.
 */
import { $, $$, ME, SECTION, SETTINGS, VIEWS, api, applyBranding, autoSave, autoSaveOn, confirmAction,
  crossHighlight, el, esc, firstSection, fmtDate, fmtDay, getPath, modal, onSectionOpen, render, setPath,
  setSettingField, setSettings, showBoardLink, showSection, start, toast, upload
} from './core.js';

// Rows and columns of the "Your details" matrix.
const DETAIL_FIELDS = [
  ['photo', 'Photo', 'Needs https:// for the camera to open'],
  ['company', 'Company', ''],
  ['phone', 'Phone number', 'Also used to recognise returning visitors'],
  ['email', 'Email address', ''],
  ['staff', 'Who they are seeing', ''],
  ['purpose', 'Reason for visit', ''],
  ['vehicle', 'Vehicle registration', ''],
  ['reference', 'Load or order reference', 'Order, docket or PO number'],
  ['movement', 'Pick-Up or Delivery', ''],
  ['project', 'Project', 'Picked from the list on the Projects tab'],
  ['id_scan', "Scan a driver's licence",
    'Reads the barcode on the back of a US or Canadian licence and records the name, licence number and issuing '
    + 'state — nothing else off the card. Needs https:// and a rear camera.']
];
// One column per visitor type, straight from the Visitor types tab.
const DETAIL_TYPES = null; // replaced by detailTypes() — kept null so stale references fail loudly
const detailTypes = () => ((SETTINGS && SETTINGS.types) || []).map((ty) => [ty.key, ty.label]);
const routeTypes = () => ((SETTINGS && SETTINGS.types) || [])
  .map((ty) => ({ key: ty.key, label: ty.label, icon: ty.icon || '👤' }));

/**
 * One visitor type: whether it is announced, and who else hears about it.
 *
 * Staff come from the Staff tab, imported spreadsheet and all, so this list
 * can be long — hence a filter box once there are more than a handful, and
 * a list that scrolls inside the card rather than pushing the page down.
 * Somebody with no email is shown but cannot be ticked: there is no address
 * to tag, and a silently ignored choice is worse than a disabled one.
 */
/** Which of a type's notifications reach a channel of its own. */
const ROUTED_EVENTS = [
  ['signin', 'Arrivals'],
  ['signout', 'Sign-outs'],
  ['induction', 'Inductions completed']
];

function routeCard(ty, s, staff, hidden) {
  const mine = (s.notify.type_routing || {})[ty.key] || {};
  const chosen = (mine.staff || []).map(Number);
  const hook = mine.webhook_url || '';
  // Absent means yes, the same rule the server applies when it decides where
  // to post — so a channel added today hears about an event added next year.
  const wants = (id) => (mine.events || {})[id] !== false;
  const posting = (s.notify.types_notified || {})[ty.key] !== false;
  const taggable = staff.filter((h) => h.email);
  const named = taggable.filter((h) => chosen.includes(h.id)).map((h) => h.name);

  const person = (h) => `<label class="check route-person${h.email ? '' : ' no-email'}">
    <input type="checkbox" data-routestaff="${esc(ty.key)}" value="${h.id}"
      ${chosen.includes(h.id) ? 'checked' : ''} ${h.email ? '' : 'disabled'}>
    <span>${esc(h.name)}<br><span class="muted">${h.email
      ? esc(h.email) + (h.webhook_url ? ' · also messaged directly' : '')
      : 'No email on file — nothing to tag'}</span></span></label>`;

  return `<div class="route-card${posting ? '' : ' not-posting'}" data-routecard="${esc(ty.key)}"
    ${hidden ? 'hidden' : ''}>
    <div class="route-head">
      <span class="route-icon">${esc(ty.icon)}</span>
      <span class="route-label">${esc(ty.label)}</span>
      <label class="check route-post"><input type="checkbox" data-notifytype="${esc(ty.key)}"
        ${posting ? 'checked' : ''}> <span>Post about these</span></label>
    </div>
    <div class="route-body">
      <p class="muted route-off-note">Nothing is posted about this type at all, so nobody below is told either.</p>
      <div class="route-also-head">
        <span class="route-also-title">Also tell</span>
        <span class="muted route-count" data-routecount="${esc(ty.key)}">${
          named.length ? esc(joinNames(named)) : 'Nobody — just the host and the channel'}</span>
      </div>
      ${staff.length ? `
        ${staff.length > 8 ? `<input class="input route-filter" data-routefilter="${esc(ty.key)}"
          placeholder="Find a name">` : ''}
        <div class="route-people">${staff.map(person).join('')}</div>
        ${taggable.length ? '' : '<p class="muted" style="margin:.5rem 0 0">Nobody on the Staff tab has an email '
          + 'address yet, so there is nobody who can be tagged.</p>'}`
        : '<p class="muted" style="margin:.25rem 0 0">Nobody on the <b>Staff</b> tab yet.</p>'}

      <!--
        A channel, as opposed to the named people above. The difference is
        who maintains the list: adding a person here needs an administrator
        in this panel, whereas a Contractors team in Teams is kept up to
        date by whoever runs that team.
      -->
      <div class="route-channel">
        <label class="field"><span>A channel of its own</span>
          <input class="input" data-routehook="${esc(ty.key)}" value="${esc(hook)}"
            placeholder="https://…  Teams workflow link" autocomplete="off" spellcheck="false"></label>
        <div class="route-events${hook ? '' : ' hidden'}" data-routeevents="${esc(ty.key)}">
          <span class="muted">Post to it:</span>
          ${ROUTED_EVENTS.map(([id, label]) => `<label class="check"><input type="checkbox"
            data-routeevent="${esc(ty.key)}" value="${id}" ${wants(id) ? 'checked' : ''}>
            <span>${label}</span></label>`).join('')}
        </div>
        <div class="row route-channel-foot${hook ? '' : ' hidden'}">
          <button class="btn ghost" type="button" data-routetest="${esc(ty.key)}">Send a test to it</button>
          <span class="muted" data-routetestnote="${esc(ty.key)}"></span>
        </div>
        <!--
          What has actually reached this channel, where the channel is set
          up. The Activity list answers it for the whole site, which is the
          wrong shape for the question somebody has while looking at one
          type: has anything ever arrived in here?
        -->
        <div class="route-history${hook ? '' : ' hidden'}" data-routehistory="${esc(ty.key)}"></div>
        <p class="muted route-channel-help">Only this type's notifications go here, and only the ones ticked.
          The company channel above still gets everything.</p>
      </div>
    </div>
  </div>`;
}

/** "A, B and C" — a list a person reads rather than a comma-separated dump. */
const joinNames = (names) => (names.length <= 1 ? (names[0] || '')
  : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

VIEWS.settings = async (root, section) => {
  setSettings(await api('/settings'));
  const users = await api('/users');
  // For routing a visitor type to somebody beyond the person being visited.
  const staff = (await api('/staff').catch(() => [])).filter((h) => h.active !== 0);
  const s = SETTINGS;
  const chk = (path, label, help) => `<label class="check"><input type="checkbox" data-set="${path}"
    ${getPath(s, path) ? 'checked' : ''}> <span>${label}${help ? `<br><span class="muted">${help}</span>` : ''}</span></label>`;
  const txt = (path, label, type = 'text', placeholder = '') => `<label class="field"><span>${label}</span>
    <input class="input" data-set="${path}" type="${type}" placeholder="${placeholder}" value="${esc(getPath(s, path) ?? '')}"></label>`;
  const bgs = s.org.backgrounds || [];

  root.innerHTML = `
    <div class="page-eyebrow">Settings</div>
    <h1 class="page" id="set-title">Settings</h1>
    <p class="page-sub">Applies instantly to every kiosk. The rest of the settings are the entries under
      <b>Settings</b> in the menu.</p>

    <div class="card section" id="set-branding"><h2>Branding</h2>
      <div class="form-grid">
        ${txt('org.name', 'Organisation name')}
        ${txt('org.welcome_title', 'Kiosk headline')}
        ${txt('org.welcome_message', 'Kiosk sub-heading')}
        ${txt('org.goodbye_message', 'Sign-out message')}
        ${txt('org.welcome_title_es', 'Headline en español', 'text', 'Bienvenido')}
        ${txt('org.welcome_message_es', 'Sub-heading en español')}
        ${txt('org.goodbye_message_es', 'Sign-out en español')}
        ${txt('org.primary_color', 'Primary colour', 'color')}
        ${txt('org.accent_color', 'Dark accent colour', 'color')}
        <label class="field"><span>Time zone</span>
          <select class="input" data-set="org.timezone" id="tz-select"></select></label>
        <label class="field"><span>Phone number format</span>
          <select class="input" data-set="org.phone_country">
            ${[['US', 'United States — (555) 123-4567'], ['CA', 'Canada — (555) 123-4567'],
               ['GB', 'United Kingdom — 07700 900123'], ['IE', 'Ireland — 085 123 4567'],
               ['AU', 'Australia — 0412 345 678'], ['NZ', 'New Zealand — 021 123 4567']]
              .map(([v, l]) => `<option value="${v}" ${(s.org.phone_country || 'US') === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select></label>
        <label class="field"><span>Date format</span>
          <select class="input" data-set="org.date_format">
            ${[['en-GB', 'UK — 25 Aug 2026, 14:30'], ['en-US', 'US — Aug 25, 2026, 2:30 PM'],
               ['en-AU', 'Australia — 25 Aug 2026'], ['en-CA', 'Canada — Aug 25, 2026'],
               ['en-IE', 'Ireland — 25 Aug 2026']]
              .map(([v, l]) => `<option value="${v}" ${s.org.date_format === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select></label>
      </div>
      <h3>Logo</h3>
      <p class="muted" style="margin-top:0">Shown on the kiosk welcome screen, the badges, this dashboard and the sign-in page.</p>
      <div class="row"><label class="btn subtle">${s.org.logo_path ? 'Replace logo' : 'Upload logo'}<input type="file" hidden id="logo-file" accept="image/*"></label>
        ${s.org.logo_path
          ? `<img src="${esc(s.org.logo_path)}" style="max-height:44px;background:#fff;border:1px solid var(--line);border-radius:8px;padding:4px">
             <button class="btn ghost" id="logo-remove">Remove logo</button>`
          : '<span class="muted">No logo set — PNG or SVG with a transparent background works best</span>'}</div>

      <h3>Welcome text position</h3>
      <p class="muted" style="margin-top:0">Move the headline, sub-heading and button clear of whatever is in your
        background photo. The preview below updates as you change it.</p>
      <div class="form-grid" style="max-width:34rem">
        <label class="field"><span>Across</span>
          <select class="input" data-set="org.welcome_align" id="wal">
            ${[['left', 'Left'], ['center', 'Centre'], ['right', 'Right']]
              .map(([v, l]) => `<option value="${v}" ${s.org.welcome_align === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select></label>
        <label class="field"><span>Down</span>
          <select class="input" data-set="org.welcome_valign" id="wval">
            ${[['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']]
              .map(([v, l]) => `<option value="${v}" ${s.org.welcome_valign === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select></label>
      </div>

      ${chk('org.show_welcome_footer', 'Show the time and organisation name along the bottom of the welcome screen')}

      <h3>Kiosk background</h3>
      <p class="muted" style="margin-top:0">Photos behind the welcome screen — site shots or finished builds work well.
        Landscape, at least 1600px wide. Add several and the kiosk fades between them. Leave it empty for the plain gradient.</p>
      <div class="row"><label class="btn subtle">${bgs.length ? 'Add more photos' : 'Upload photos'}
          <input type="file" hidden id="bg-file" accept="image/*" multiple></label>
        ${bgs.length ? `<button class="btn ghost" id="bg-remove">Remove all</button>
          <span class="muted">${bgs.length} photo${bgs.length === 1 ? '' : 's'} — you can select several at once</span>`
          : '<span class="muted">No photos yet — you can select several at once</span>'}</div>
      ${bgs.length ? `<div class="bg-grid">${bgs.map((b, i) => `
        <div class="bg-thumb" style="background-image:url('${esc(b)}')">
          <span class="num">${i + 1}</span>
          <button data-bgdel="${i}" title="Remove this photo">✕</button>
        </div>`).join('')}</div>` : ''}
      ${bgs.length > 1 ? `
        <label class="field" style="max-width:26rem;margin-top:1rem"><span>Change photo every</span>
          <select class="input" data-set="org.background_rotate_seconds">
            ${(() => {
              const presets = [[8, '8 seconds'], [12, '12 seconds'], [20, '20 seconds'], [30, '30 seconds'], [60, '1 minute'], [300, '5 minutes']];
              const current = Number(s.org.background_rotate_seconds);
              // Never show a preset as selected when the stored value is something else.
              if (!presets.some(([v]) => v === current)) presets.unshift([current, `${current} seconds`]);
              return presets.map(([v, l]) => `<option value="${v}" ${current === v ? 'selected' : ''}>${l}</option>`).join('');
            })()}
          </select></label>` : ''}
      <div class="bg-preview${bgs.length ? '' : ' no-bg'}" id="bg-preview"
           data-align="${esc(s.org.welcome_align)}" data-valign="${esc(s.org.welcome_valign)}"
           ${bgs.length ? `style="background-image:url('${esc(bgs[0])}')"` : ''}>
        <div class="bg-scrim" id="bg-scrim"></div>
        <div class="bg-text">
          <b id="pv-title">${esc(s.org.welcome_title || 'Welcome')}</b>
          <span id="pv-msg">${esc(s.org.welcome_message || '')}</span>
          <i class="pv-btn">Touch to start</i>
        </div>
      </div>
      ${bgs.length ? `
        <label class="field" style="max-width:26rem;margin-top:1rem"><span>Darken the photo so the text stays readable
          — <b id="dim-value">${s.org.background_dim}</b>%</span>
          <input type="range" min="0" max="85" step="5" id="bg-dim" data-set="org.background_dim" value="${s.org.background_dim}"></label>
      ` : ''}
    </div>

    <div class="card section" id="set-details"><h2>Visitor form</h2>
      <p class="muted" style="margin-top:0">What each type of visitor is asked. An interview does not need a reason for
        visit — the card already says why they are here — so switch it off in that column alone.</p>
      <div class="table-wrap"><table class="fields-table cross-hi">
        <thead><tr><th data-col="0">Field</th>${detailTypes()
          .map(([, l], i) => `<th data-col="${i + 1}">${l}</th>`).join('')}</tr></thead>
        <tbody>${DETAIL_FIELDS.map(([field, label, hint]) => `<tr>
          <td data-col="0"><b>${label}</b>${hint ? `<div class="muted">${hint}</div>` : ''}
            <div><button class="btn link" type="button" data-rowoff="${field}">Turn off for everyone</button></div></td>
          ${detailTypes().map(([type], i) => {
            const value = ((s.details[type] || {})[field]) || 'off';
            return `<td data-col="${i + 1}"><select class="input" data-set="details.${type}.${field}">
              ${[['off', 'Not asked'], ['optional', 'Optional'], ['required', 'Required']]
                .map(([v, l]) => `<option value="${v}" ${value === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select></td>`;
          }).join('')}</tr>`).join('')}</tbody>
      </table></div>
      <p class="muted">Full name is always asked. Deliveries have their own short form, set further down.</p>

      <details class="sub-fold">
        <summary><h3>Wording</h3><span class="muted">What each field is called, per visitor type</span></summary>
        <p class="muted" style="margin-top:0">Change what a field is called and add a line of help underneath it —
          a driver is asked for a haulier, not a company. Leave a box empty to keep the standard wording.</p>
        <label class="field" style="max-width:16rem"><span>Wording for</span>
          <select class="input" id="wording-type">
            ${detailTypes().map(([t, l]) => `<option value="${t}">${l}</option>`).join('')}
          </select></label>
        <div id="wording-fields"></div>
      </details>
    </div>

    <div class="card section" id="set-flow"><h2>Kiosk sign-in flow</h2>
      <div id="flow-phone">
      <h3 style="margin-top:0">Checking in from a phone</h3>
      <p class="muted" style="margin-top:0">A QR code at the gate that opens the sign-in on a visitor's own
        phone. Useful when one tablet has a queue behind it, or when the tablet is dead. Switch it on per
        device under <b>Devices</b>, which is also where the code to print is.</p>
      ${chk('kiosk.self_checkin_enabled', 'Allow visitors to check in from their own phone')}

      <h4 style="margin-bottom:.25rem">Only from the site itself</h4>
      <p class="muted" style="margin-top:0">A phone check-in can be refused when the phone says it is
        somewhere else. Worth being straight about what that is: a browser reports whatever coordinates it
        chooses to, so this stops somebody signing in from the car park on the way past or from home on a
        Monday — not somebody who has decided to cheat and knows how. It applies to phone check-ins only;
        a tablet bolted to the gate answers the question by being there.</p>
      ${chk('geofence.enabled', 'Refuse phone check-ins from away from the site')}

      <!--
        Three ways to place the site, because each of them fails for
        somebody: an address is no use for a compound with no postal
        address, standing on it is no use from an office two hundred miles
        away, and typing coordinates means finding them somewhere else
        first.
      -->
      <label class="field"><span>Find the site by address</span>
        <div class="row">
          <input class="input" id="geo-address" placeholder="14 Riverside Way, Oakland CA"
            autocomplete="off" style="flex:1 1 20rem">
          <button class="btn subtle" id="geo-find" type="button">Find</button>
        </div>
        <span class="muted">Looked up through OpenStreetMap, and only when you press Find — the address
          you type is sent to them, nothing else is, and no visitor's data is involved. Pick the right
          match below and the coordinates fill themselves in.</span></label>
      <div id="geo-results"></div>

      <div class="form-grid">
        ${txt('geofence.lat', 'Site latitude', 'number')}
        ${txt('geofence.lng', 'Site longitude', 'number')}
        ${txt('geofence.radius_m', 'How far out is still “here” (metres)', 'number')}
      </div>
      <div class="row"><button class="btn subtle" id="geo-here" type="button">Use where I am now</button>
        <span class="muted" id="geo-here-note">Stand on the site and press this from a phone or laptop.</span></div>

      <!--
        The fence, drawn, because two decimal numbers and a radius in metres
        are not something anybody can check by reading. A digit in the wrong
        place puts the gate in the next county and nothing on this page would
        have said so; the circle on the map either sits over the site or it
        obviously does not.

        The map is drawn by hand rather than by a mapping library, and the
        tiles come through this server. Both for the same reason: the content
        security policy admits scripts and pictures from this origin only,
        and it is doing real work — widening it here would widen it for the
        kiosk a visitor holds too.
      -->
      <div class="site-map" id="site-map">
        <div class="site-map-frame" id="site-map-frame" hidden>
          <div class="site-map-tiles" id="site-map-tiles"></div>
          <!--
            Two overlays rather than one. Everything that belongs to the
            ground — the circle and the pin — moves with the map while it is
            being dragged; the scale bar belongs to the frame and stays put,
            because a ruler that slides about as you drag is worse than none.
          -->
          <svg class="site-map-overlay" id="site-map-overlay" aria-hidden="true"></svg>
          <svg class="site-map-overlay site-map-fixed" id="site-map-scale" aria-hidden="true"></svg>
          <div class="site-map-tools">
            <div class="site-map-layers hidden" id="site-map-layers"></div>
            <div class="site-map-zoom">
              <button class="btn subtle" data-mapzoom="1" type="button" aria-label="Zoom in">+</button>
              <button class="btn subtle" data-mapzoom="-1" type="button" aria-label="Zoom out">−</button>
            </div>
          </div>
          <button class="btn subtle site-map-recentre hidden" id="site-map-recentre"
            type="button">Back to the site</button>
          <div class="site-map-credit" id="site-map-credit"></div>
        </div>
        <p class="muted" id="site-map-note"></p>
      </div>

      ${chk('geofence.require_location', 'Refuse a phone that will not say where it is')}
      <p class="muted">With that off, a visitor whose phone has location switched off is let through and the
        visit is recorded as usual — which is often the right trade, because a real visitor with a stubborn
        phone is a far more common problem than somebody trying it on. A fix indoors or among steel is
        routinely a hundred metres out, so leave the radius generous.</p>
      </div>

      <h3>How check-in works</h3>
      <p class="muted" style="margin-top:0">Finding the visitor always comes first — it decides whether they need
        the induction at all. Everything after that is yours to arrange, and it can differ per type. A step that
        does not apply is skipped wherever it sits: no photo asked for, no documents for that type, an induction
        already watched.</p>
      <label class="field" style="max-width:16rem"><span>Flow for</span>
        <select class="input" id="flow-type">
          ${detailTypes().map(([t, l]) => `<option value="${t}">${l}</option>`).join('')}
        </select></label>
      <div class="flow-strip" id="flow-strip"></div>
      <p class="muted">Drag a step to move it, or use the arrows on it.</p>
      <details class="sub-fold">
        <summary><h3>Every type side by side</h3><span class="muted">The same order, all four at once</span></summary>
        <div class="grid two" id="flow-editor">
          ${detailTypes().map(([type, label]) => `
            <div class="flow-col" data-flowtype="${type}">
              <h3 style="margin-top:0">${label}</h3>
              <ol class="flow-list"></ol>
            </div>`).join('')}
        </div>
      </details>

      <h3>Behaviour</h3>
      <div class="check-list">
        ${chk('kiosk.welcome_shows_menu', 'Skip “Touch to start”',
          'Put the sections straight on the home screen')}
        ${chk('kiosk.show_onsite_count', 'Show how many people are on site')}
        ${chk('kiosk.lookup_by_name', 'Let returning visitors find themselves by name',
          'They pick from matching names. Only a name and company are shown, never a phone number or email')}
        ${chk('kiosk.qr_signout_enabled', 'Let visitors scan their badge to sign out',
          'Only useful with badge printing on, and its QR code switched on')}
        ${chk('kiosk.auto_signout_enabled', 'Sign everyone out at the end of the day',
          'People forget to sign out, and a roll call is worthless with yesterday&rsquo;s visitors still on it')}
      </div>

      <div class="field-list">
        ${txt('kiosk.idle_timeout_seconds', 'Return to the welcome screen after (seconds)', 'number')}
        ${txt('kiosk.thank_you_seconds', 'Hold the thank-you screen for (seconds)', 'number')}
        <label class="field"><span>Sign everyone out at</span>
          <input class="input" data-set="kiosk.auto_signout_time" type="time"
            value="${esc(s.kiosk.auto_signout_time || '23:59')}"></label>
        <label class="field"><span>Returning-visitor lookup</span>
          <select class="input" data-set="kiosk.returning_lookup_field">
            <option value="phone" ${s.kiosk.returning_lookup_field === 'phone' ? 'selected' : ''}>Mobile number</option>
            <option value="email" ${s.kiosk.returning_lookup_field === 'email' ? 'selected' : ''}>Email address</option>
          </select>
          <span class="muted">A name is also accepted while “find themselves by name” is ticked above</span></label>
      </div>

      <h3>Sections on the home screen</h3>
      <p class="muted" style="margin-top:0">The visitor cards — who they are for, their wording and where each sits —
        are managed on the <b>Visitor types</b> tab. The two below are not visitor types, so they live here.</p>
      <div class="check-list">
        ${chk('kiosk.show_delivery_button', 'Delivery', 'Courier drop-off — also needs Deliveries enabled below')}
      </div>
      <p class="muted">A “Request entry” card appears too when you switch it on under <b>Access control</b>.</p>

      <h3>Language</h3>
      ${chk('kiosk.spanish_enabled', 'Offer Spanish', 'Puts an Español button on every kiosk screen. The kiosk’s own wording is already translated; your documents, questions and project names use the Spanish boxes beside them, and fall back to English where empty.')}
      <label class="field" style="max-width:16rem"><span>Language the kiosk starts in</span>
        <select class="input" data-set="kiosk.default_language">
          <option value="en" ${s.kiosk.default_language !== 'es' ? 'selected' : ''}>English</option>
          <option value="es" ${s.kiosk.default_language === 'es' ? 'selected' : ''}>Español</option>
        </select></label>

    </div>

    <div class="card section" id="set-badges"><h2>ID badge printing</h2>
      <p class="muted">Badge design, label size and reprinting now live in their own <b>Badges</b> tab.</p>
      <button class="btn subtle" id="go-badges">Open Badges</button>
    </div>

    <div class="card section" id="set-induction"><h2>Induction</h2>
      ${chk('induction.enabled', 'Show the induction deck during sign-in')}
      ${chk('induction.show_to_returning_visitors', 'Show it every visit', 'Off = only first-timers and anyone who has not seen the current version')}
      ${chk('induction.require_acknowledgement', 'Ask for a confirmation tap at the end')}
      <div class="form-grid">${txt('induction.acknowledgement_text', 'Confirmation wording')}
      ${txt('induction.acknowledgement_text_es', 'En español (optional)')}</div>
    </div>

    <div class="card section" id="set-deliveries"><h2>Deliveries</h2>
      ${chk('deliveries.enabled', 'Enable the delivery flow')}
      ${chk('deliveries.require_recipient', 'Require a recipient')}
      ${chk('deliveries.ask_tracking', 'Ask for a tracking number')}
      ${chk('deliveries.notify_recipient', 'Notify the recipient immediately')}
      ${chk('deliveries.signature_on_collection', 'Capture a signature on collection')}
    </div>

    <div class="card section" id="set-compliance"><h2>Certificates</h2>
      <p class="muted" style="margin-top:0">Insurance, safety cards, method statements — paperwork with a date on
        it. Recorded under <b>Certificates</b> in the menu; this decides what is insisted on, and what happens at
        the kiosk when it has lapsed.</p>
      <div class="check-list">
        ${chk('compliance.enabled', 'Check certificates when somebody signs in',
          'With this off nothing is checked at the gate, but the Certificates page still warns you before one lapses')}
      </div>
      <div class="form-grid">
        <label class="field"><span>When something is missing or out of date</span>
          <select class="input" data-set="compliance.on_fail">
            <option value="warn" ${s.compliance.on_fail !== 'block' ? 'selected' : ''}>Let them in, and say so at the desk</option>
            <option value="block" ${s.compliance.on_fail === 'block' ? 'selected' : ''}>Turn them away — see reception</option>
          </select>
          <span class="muted">Start with the first. A closed gate on the day you switch this on, before anything
            has been uploaded, turns everybody away at once.</span></label>
        <label class="field"><span>Warn this many days ahead</span>
          <input class="input" data-set="compliance.warn_days" type="number" min="1" max="365"
            value="${esc(s.compliance.warn_days ?? 30)}"></label>
      </div>

      <h3>What each visitor type must have</h3>
      <p class="muted" style="margin-top:0">A firm's certificate covers all of its people; a person's own covers
        only them. Either satisfies the requirement.</p>
      <div class="route-cards">
        ${routeTypes().map((ty) => {
          const need = ((s.compliance.required || {})[ty.key] || []);
          return `<div class="route-card" data-needcard="${esc(ty.key)}">
            <div class="route-head">
              <span class="route-icon">${esc(ty.icon)}</span>
              <span class="route-label">${esc(ty.label)}</span>
            </div>
            <div class="route-body">
              <div class="route-people">
                ${(s.compliance.kinds || []).map((k) => `<label class="check route-person">
                  <input type="checkbox" data-needkind="${esc(ty.key)}" value="${esc(k.key)}"
                    ${need.includes(k.key) ? 'checked' : ''}> <span>${esc(k.label)}</span></label>`).join('')
                  || '<p class="muted" style="margin:0">No kinds of certificate set up yet.</p>'}
              </div>
            </div>
          </div>`;
        }).join('') || '<div class="section-row off"><span>No visitor types yet.</span></div>'}
      </div>
    </div>

    <div class="card section" id="set-access"><h2>Access control</h2>
      <p class="muted" style="margin-top:0">Releasing a door or gate from the kiosk.
        <b>Request entry</b> puts a button on the kiosk home screen for somebody who needs letting in without
        signing in — a delivery driver at a gate, a contractor returning from their van.</p>
      <div class="check-list">
        ${chk('access.enabled', 'Enable door control')}
        ${chk('access.unlock_button_on_kiosk', 'Show a “Request entry” button on the kiosk',
          'It only appears once there is a door for it to open — see Access &amp; doors')}
        ${chk('access.unlock_on_signin', 'Unlock doors automatically when someone signs in')}
      </div>
      <div id="access-doors-warning"></div>
    </div>

    <div class="card section" id="set-notifications"><h2>Notifications</h2>
      <h3>Microsoft Teams</h3>
      <p class="muted" style="margin-top:0">Arrivals go to one Teams channel, and the person being visited is
        tagged in the post using the email on their <b>Staff</b> record — so they get a notification without
        anybody setting up a link of their own. A staff member who wants their own direct message can still paste
        a personal Teams link on their record.</p>
      <!--
        Worth naming what "everything" covers, because the label used to say
        "every arrival" and this channel has quietly grown to carry six
        different kinds of message.
      -->
      <p class="muted">The <b>company channel</b> is the one that hears everything: arrivals, sign-outs, finished
        inductions and parcels, whatever the visitor type — and a tablet gone quiet or a badge printer somebody has
        reported down. That is the one to point at a plant manager's channel. Further down, each visitor type can
        also have a channel of its own that gets only that type.</p>
      ${chk('notify.webhook_channel_always', 'Post everything to the company channel',
        'With this off, the channel is only used for people who have no Teams link of their own')}
      <div class="form-grid">
        ${txt('notify.global_webhook_url', 'Company channel link')}
        <label class="field"><span>Format for unrecognised URLs</span><select class="input" data-set="notify.webhook_format">
          ${[['teams', 'Microsoft Teams'], ['slack', 'Slack'], ['google_chat', 'Google Chat'], ['generic', 'Generic JSON']]
            .map(([v, l]) => `<option value="${v}" ${(s.notify.webhook_format || 'teams') === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <span class="muted">A Teams, Slack or Google Chat link is recognised on sight; this only applies to
          anything else.</span></label>
      </div>
      <div class="row" style="margin-top:.5rem"><button class="btn subtle" id="test-hook" type="button">Send test to
        the company channel</button></div>
      <div id="email-result"></div>

      <details class="howto" ${s.notify.global_webhook_url ? '' : 'open'}>
        <summary><b>Getting the Teams link for a channel</b></summary>
        <ol>
          <li>In Teams, hover the channel &rarr; <b>&ctdot;</b> &rarr; <b>Workflows</b>.</li>
          <li>Choose the template <b>&ldquo;Post to a channel when a webhook request is received&rdquo;</b>.</li>
          <li>Name it &ldquo;Smart Lobby&rdquo;, confirm the team and channel, then <b>Add workflow</b>.</li>
          <li>Copy the HTTPS URL it shows — you only get it once — and paste it above.</li>
          <li>Save, then press <b>Send test to Teams</b> below.</li>
        </ol>
        <p class="muted">For an individual person, the same thing with the <i>chat</i> template, pasted into their
          record on the <b>Staff</b> tab. Full instructions for both, including what to do when your tenant hides
          the chat template, are on that tab under <b>Setting up a chat webhook</b>.</p>
        <!--
          Asked every time somebody sets this up, and the answer is not
          reassuring unless it is specific: nothing we send names anybody,
          so there is no setting here that could change it.
        -->
        <p class="muted"><b>Why do the messages say they are from me?</b> Teams credits the post to whoever created
          the workflow — nothing Smart Lobby sends names a person, so no setting here can change it. Create the
          workflow from a shared or service account instead and the posts come from that account. Worth doing
          anyway: a workflow owned by one person stops working when they leave, and the first anybody knows is a
          visitor at the gate with nobody told.</p>
      </details>

      <h3>When to post</h3>
      <p class="muted" style="margin-top:0">Which moments are worth interrupting a channel for.</p>
      <div class="check-list">
        ${chk('notify.on_signin', 'Someone signs in')}
        ${chk('notify.on_signout', 'Someone signs out')}
        ${chk('notify.on_induction', 'Someone finishes the site induction',
          'The moment the briefing is on record, rather than the moment they walked in')}
        ${chk('notify.on_delivery', 'A parcel arrives')}
      </div>

      <!--
        Two events that are not about a visitor at all, and were only
        settable through the API until now — the guides told people to tick a
        box that did not exist.
      -->
      <h4>When the equipment stops</h4>
      <p class="muted" style="margin-top:0">Neither is a visitor event, so both go to the company channel only —
        never to a host's own webhook.</p>
      <div class="check-list">
        ${chk('notify.on_device_offline', 'A tablet stops checking in',
          'It checks in every 20 seconds; the message goes once it has been quiet for the window below')}
        ${chk('notify.on_printer_trouble', 'A badge printer is marked as not printing',
          'Set by hand from the Printers page — nothing here can reach a printer to ask it')}
      </div>
      <div class="form-grid">
        ${txt('notify.device_quiet_minutes', 'Minutes quiet before saying a tablet is down', 'number')}
      </div>
      <p class="muted">Fifteen rather than five on purpose: site wifi drops for two or three minutes often
        enough that a shorter window produces a channel people mute, which is worse than no channel.</p>

      <h3>Each visitor type</h3>
      <p class="muted" style="margin-top:0">Everything that differs by who is arriving, one type at a time — the
        same tabs the card designer below uses, so a type is set up in one place rather than three.</p>
      <p class="muted" style="margin-top:0"><b>Post about these</b> covers signing in, signing out and the
        induction. A type added later on the <b>Visitor types</b> tab starts switched on, so a new one is never
        silently ignored.</p>
      <p class="muted" style="margin-top:0">The person being visited is always tagged, whatever is set here.
        <b>Also tell</b> names individual staff who want a whole kind of visitor regardless of who they came to
        see — a safety officer who wants every contractor. <b>A channel of its own</b> does the same job for a
        group, and the difference is who keeps the list up to date: naming people needs an administrator in here
        every time somebody joins or leaves that role, while a Teams channel is maintained by whoever runs it.
        The company channel above still receives everything either way.</p>
      <div class="tabs subtle" id="route-tabs">
        ${routeTypes().map((ty, i) => `<button class="tab${i === 0 ? ' on' : ''}" type="button"
          data-routetab="${esc(ty.key)}">${esc(ty.icon)} ${esc(ty.label)}</button>`).join('')}
      </div>
      <!--
        Every type's panel is in the page and all but one hidden, rather than
        the hidden ones being left out. The whole lot is collected on save —
        see collectRouting — so a panel that was not on screen when somebody
        pressed save must still be there to be read, or looking at one type
        would quietly wipe the rest.
      -->
      <div class="route-panels">
        ${routeTypes().map((ty, i) => routeCard(ty, s, staff, i !== 0)).join('')
          || '<div class="section-row off"><span>No visitor types yet.</span></div>'}
      </div>

      <h3>What the message looks like</h3>
      <p class="muted" style="margin-top:0">Four different things get announced, and they are not the same kind of
        message — an arrival wants a face and a project, a sign-out wants a time, a parcel has no visitor on it at
        all. Each gets its own design. The preview is built by the same code that sends the real thing, so what you
        see here is what lands in the channel.</p>
      <div class="tabs" id="cd-events"></div>
      <p class="muted" id="cd-event-hint" style="margin:.25rem 0 .5rem"></p>
      <div class="tabs subtle" id="cd-types"></div>
      <div id="cd-type-note"></div>
      <div class="card-design">
        <div>
          <div class="form-grid">
            <label class="field"><span>Heading colour</span>
              <select class="input" id="cd-header">
                ${[['accent', 'Blue'], ['good', 'Green'], ['warning', 'Amber'], ['attention', 'Red'],
                   ['emphasis', 'Grey'], ['none', 'Plain — no tinted band']]
                  .map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
              </select>
              <span class="muted">Teams only offers its own palette, so this is a choice rather than a colour picker</span></label>
            <label class="field"><span>Details layout</span>
              <select class="input" id="cd-details">
                <option value="facts">Two columns — label beside value</option>
                <option value="lines">One line each</option>
              </select></label>
          </div>
          <div class="field-list">
            <label class="field"><span>Heading</span><input class="input" id="cd-title"></label>
            <label class="field"><span>Under the heading</span><input class="input" id="cd-subtitle"></label>
            <label class="field"><span>Footer</span><input class="input" id="cd-footer"></label>
          </div>
          <p class="muted" style="margin:.35rem 0 0" id="cd-tokens"></p>

          <div id="cd-photo-block">
            <h4>Photo</h4>
            <label class="check"><input type="checkbox" id="cd-photo"> <span>Show the visitor's photo</span></label>
            <div class="form-grid">
              <label class="field"><span>Where</span>
                <select class="input" id="cd-photo-place">
                  <option value="left">Beside the details</option>
                  <option value="top">Above the details</option>
                </select></label>
              <label class="field"><span>Shape</span>
                <select class="input" id="cd-photo-shape">
                  <option value="person">Circle</option>
                  <option value="square">Square</option>
                </select></label>
              <label class="field"><span>Size</span>
                <select class="input" id="cd-photo-size">
                  <option value="small">Small</option>
                  <option value="medium">Medium</option>
                  <option value="large">Large</option>
                </select>
                <span class="muted">A face you can recognise across a desk is the point of having one</span></label>
            </div>
          </div>
          <div id="cd-photo-warning"></div>

          <h4>What the message shows</h4>
          <p class="muted" style="margin-top:0">The arrows set the order. A field with nothing in it for that
            visitor is left out rather than shown empty.</p>
          <div class="section-order" id="cd-chosen"></div>
          <p class="muted" style="margin:.6rem 0 .3rem">Not shown</p>
          <div class="section-order" id="cd-rest"></div>

          <h4>Tagging</h4>
          <label class="check"><input type="checkbox" id="cd-mention">
            <span>Tag the person concerned in the channel post<br>
            <span class="muted">Uses the email on their <b>Staff</b> record, so the one person who needs to know
              gets a Teams notification without setting up a link of their own. Somebody with no email on file is
              simply not tagged.</span></span></label>
          <label class="field"><span>What the tag line says</span>
            <input class="input" id="cd-mention-line">
            <span class="muted"><code>{host}</code> becomes the tag itself. Worth reading twice per event —
              “your visitor is here” on a sign-out sends somebody down to reception for a person who has
              just left.</span></label>
          <label class="field"><span>And for anyone the visitor type is routed to</span>
            <input class="input" id="cd-also-line">
            <span class="muted"><code>{who}</code> becomes their tags. Only appears when a visitor type has
              somebody in its <b>Also tell</b> list, above.</span></label>

          <h4>Quick links</h4>
          <p class="muted" style="margin-top:0">Buttons along the bottom of the card, so whoever reads it can open
            the thing it is about without hunting for a bookmark. Up to four — Teams hides the rest behind a
            menu.</p>
          <div class="section-order" id="cd-links"></div>
          <p class="muted" style="margin:.6rem 0 .3rem">Not on the card</p>
          <div class="section-order" id="cd-links-rest"></div>
        </div>

        <div class="card-preview-col">
          <div class="muted" style="margin-bottom:.4rem">Preview</div>
          <div id="cd-preview" class="teams-preview"><p class="empty">Loading…</p></div>
          <p class="muted" id="cd-sample"></p>
          <details class="sub-fold">
            <summary><h3>Exactly what we send</h3></summary>
            <p class="muted" style="margin-top:0">The whole request body, as Teams receives it. If something
              appears in the channel that is not in here — an extra line, a footer, a link — it was added by the
              Teams workflow receiving this, not by Smart Lobby, and it is removed by editing that flow in Power
              Automate.</p>
            <pre class="json-dump" id="cd-json"></pre>
          </details>
          <label class="field" style="margin-top:.75rem"><span>Public address of this server</span>
            <input class="input" data-set="notify.public_url" placeholder="https://your-app.up.railway.app"
              value="${esc(s.notify.public_url || '')}">
            <span class="muted">Teams fetches the photo itself, so it needs an address reachable from outside.
              Leave blank to use the PUBLIC_URL the server was started with.</span></label>
        </div>
      </div>

      <h3>Activity</h3>
      <p class="muted" style="margin-top:0">The last 50 attempts on every channel — what is being sent right now,
        what went through, what failed and why, and what is queued to be tried again.</p>
      <div class="row" style="margin:.4rem 0"><span id="notify-summary"></span>
        <button class="btn ghost" id="notify-refresh" type="button">Refresh</button></div>
      <div class="table-wrap scroll-10" id="notify-log"><p class="muted">Loading…</p></div>
    </div>

    <div class="card section" id="set-board"><h2>Live on-site board</h2>
      <p class="muted" style="margin-top:0">A page showing who is on site, who has just arrived and who has just
        signed out, updating itself every few seconds. Leave it open on a laptop or a screen in the office.</p>
      <p class="muted">It shows the whole roster, so it is not simply open to anyone — it lives behind an
        unguessable link. Anybody holding that link can see the board, so treat it like a key: <b>New link</b>
        replaces it, and <b>Turn off</b> stops every copy of it working at once.</p>
      <div id="board-state"><p class="muted">Loading…</p></div>
      <div class="form-grid" style="margin-top:1rem">
        ${txt('board.title', 'Heading on the board', 'text', s.org.name || 'Smart Lobby')}
        ${txt('board.recent_minutes', '“Just arrived” means the last (minutes)', 'number')}
      </div>
      <div class="check-list">
        ${chk('board.show_photos', 'Show visitor photos')}
        ${chk('board.show_company', 'Show company')}
        ${chk('board.show_host', 'Show who they are visiting')}
      </div>
      <p class="muted">The board also has a <b>Roll call</b> button: the same list, bigger, where you tap each
        person as they are found at the muster point. What you have ticked stays on that device and clears when
        the tab is closed.</p>

      <h3>Camera</h3>
      ${chk('board.camera_enabled', 'Show a camera on the board')}
      <div class="notice" id="camera-warning" style="font-size:.9rem">
        <b>Before you paste a URL, the awkward part.</b> The board is served over <b>https</b>, and a browser will
        not load an <b>http</b> picture into an https page — so a camera on your local network, which is almost
        always plain http, cannot be shown directly however the address is written. Two ways round it:
        give the camera an https address of its own (a reverse proxy or a tunnel), or tick
        <b>Fetch through the server</b> below — which only works if <i>this server</i> can reach the camera, and a
        server in the cloud cannot see your local network. RTSP addresses cannot be shown by a browser at all.
      </div>
      <div class="form-grid">
        <label class="field"><span>How the camera serves its picture</span>
          <select class="input" data-set="board.camera_mode">
            ${[['snapshot', 'A still image, refreshed — snapshot.jpg'],
               ['mjpeg', 'MJPEG stream — one long-running image'],
               ['hls', 'HLS video — .m3u8'],
               ['embed', 'The camera’s own page, in a frame']]
              .map(([v, l]) => `<option value="${v}" ${(s.board.camera_mode || 'snapshot') === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
          <span class="muted">Most cameras offer a snapshot URL; it is the one that works almost everywhere</span></label>
        ${txt('board.camera_url', 'Camera address', 'text', 'https://camera.example.com/snapshot.jpg')}
        ${txt('board.camera_label', 'Label on the box', 'text', 'Front gate')}
        ${txt('board.camera_refresh_seconds', 'Refresh a still image every (seconds)', 'number')}
        <label class="field"><span>Size on the board</span>
          <select class="input" data-set="board.camera_size">
            ${[['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']]
              .map(([v, l]) => `<option value="${v}" ${(s.board.camera_size || 'small') === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
          <span class="muted">Clicking the box on the board makes it big either way</span></label>
      </div>
      ${chk('board.camera_proxy', 'Fetch through the server',
        'Fixes the http/https problem, but only for a camera this server can reach itself')}
      <div class="row"><button class="btn subtle" id="camera-test" type="button">Test the camera</button></div>
      <div id="camera-result"></div>
    </div>

    <div class="card section" id="set-retention"><h2>Data retention &amp; privacy</h2>
      <div class="form-grid">
        ${txt('privacy.retain_visits_days', 'Delete visit records after (days)', 'number')}
        ${txt('privacy.retain_photos_days', 'Delete visitor photos after (days)', 'number')}
        ${txt('privacy.retain_id_days', 'Clear scanned ID details after (days)', 'number')}
      </div>
      <p class="muted">A licence number is the most identifying thing here and is useful for far less time than the
        visit it sits on. Clearing it empties the three ID fields and leaves the rest of the visit alone.</p>

      <h3>What the kiosk tells visitors</h3>
      ${chk('privacy.notice_enabled', 'Show a privacy note on the details screen',
        'Under the form that asks, not buried in a document nobody reads')}
      <div class="field-list">
        <label class="field"><span>Wording</span>
          <textarea class="input" rows="3" data-set="privacy.notice_text"
            placeholder="Leave empty and one is written for you">${esc(s.privacy.notice_text || '')}</textarea>
          <span class="muted">Left empty, the kiosk shows a note built from what you actually ask for and how
            long you keep it — so it cannot claim to take a photo on a kiosk that never asks for one.</span></label>
        <label class="field"><span>Wording en español</span>
          <textarea class="input" rows="3" data-set="privacy.notice_text_es"
            placeholder="Opcional">${esc(s.privacy.notice_text_es || '')}</textarea></label>
      </div>
      <div id="privacy-preview"></div>
    </div>

    <div class="card section" id="set-backups"><h2>Backups</h2>
      <p class="muted" style="margin-top:0">One ZIP holding the database <b>and</b> every uploaded file — visitor
        photos, signatures, deck slides, your logo — written every night, the last seven kept. Each one is opened
        and checked after it is written, because an unverified backup is a guess.</p>
      <p class="muted">They sit on the same volume as the live data, so on their own they answer &ldquo;something
        corrupted the database&rdquo; and not &ldquo;the volume is gone&rdquo;. <b>Download one and keep it
        somewhere else</b> — that is the copy that survives losing the machine.</p>
      <div id="backup-health"></div>
      <div class="row"><button class="btn subtle" id="backup-now" type="button">Back up now</button>
        <span class="muted" id="backup-total"></span></div>
      <div id="backup-list"><p class="muted">Loading…</p></div>

      <h3>Room on the disk</h3>
      <p class="muted" style="margin-top:0">When this fills, sign-ins stop and no backup can be written — including
        the one that would have told you.</p>
      <div id="storage-use"><p class="muted">Loading…</p></div>

      <h4 style="margin-bottom:.25rem">When it gets tight</h4>
      <p class="muted" style="margin-top:0">Rather than let the disk fill and take the kiosk down with it, the
        oldest photos can be dropped early. They are the least useful thing on the disk and by far the largest —
        and losing one costs a look-up nobody was going to do, against a site that stops taking sign-ins.</p>
      ${chk('storage.shed_enabled', 'Drop the oldest photos before the disk fills')}
      <div class="form-grid">
        ${txt('storage.shed_at_percent', 'Start when the disk is this full (%)', 'number')}
        ${txt('storage.shed_to_percent', 'Clear back down to (%)', 'number')}
        ${txt('storage.shed_floor_days', 'Never touch photos newer than (days)', 'number')}
      </div>
      <div class="row"><button class="btn subtle" id="shed-now" type="button">Free up room now</button>
        <span class="muted" id="shed-last"></span></div>

      <h3>Copy each backup to OneDrive</h3>
      <p class="muted" style="margin-top:0">A backup sitting on the same volume as the data does not survive losing
        the volume. This posts each new one straight into a OneDrive folder as it is written, so there is always a
        copy somewhere else without anybody remembering to do anything.</p>
      ${chk('backup.offsite_enabled', 'Send every backup to OneDrive')}
      <div class="form-grid">
        ${txt('backup.offsite_url', 'Flow URL', 'text', 'https://prod-00.westus.logic.azure.com/workflows/…')}
        ${txt('backup.offsite_secret', 'Shared word (optional)', 'text', 'Anything — the flow can check for it')}
      </div>
      ${chk('backup.offsite_include_media', 'Send the uploaded files too',
        'Off sends the database alone — a fraction of the size, but photos and signatures would not come back')}
      <p class="muted">A backup past what a flow accepts in one go is cut into pieces that fit, the database
        first and the files after it. Each piece is a complete archive on its own, so a folder of them can be
        restored in any order — and a piece holding only files brings back the photos without touching the
        records.</p>
      <div class="row"><button class="btn subtle" id="offsite-test" type="button">Send a test file</button></div>
      <div id="offsite-result"></div>

      <details class="howto">
        <summary><b>Setting up the OneDrive flow</b></summary>
        <p class="muted" style="margin-top:.5rem">This is the same shape as the Teams channel link, and for the same
          reason: it needs no Azure app registration and no admin consent, which a normal account in a company
          tenant cannot get anyway.</p>
        <ol>
          <li>Go to <b>make.powerautomate.com</b> and sign in with your work account.</li>
          <li><b>Create</b> &rarr; <b>Instant cloud flow</b> &rarr; trigger
            <b>&ldquo;When an HTTP request is received&rdquo;</b>.</li>
          <li>Add a step: <b>OneDrive for Business</b> &rarr; <b>Create file</b>.</li>
          <li><b>Folder path</b>: pick or type a folder, e.g. <code>/Smart Lobby backups</code>.</li>
          <li><b>File name</b>: in the dynamic-content box, switch to the expression tab and use
            <code>triggerOutputs()['queries']['name']</code> — that is the filename we send.</li>
          <li><b>File content</b>: expression <code>triggerBody()</code> — the archive itself.</li>
          <li><b>Save</b>. Reopen the first step and copy the <b>HTTP POST URL</b> it now shows, and paste it above.</li>
          <li>Press <b>Send a test file</b>. A small text file should appear in that folder within a few seconds.</li>
        </ol>
        <p class="muted">To check the shared word as well, add a <b>Condition</b> after the trigger comparing
          <code>triggerOutputs()['headers']['X-Smart-Lobby-Secret']</code> to it, and only create the file when
          they match.</p>
        <p class="muted"><b>On size.</b> That trigger stops accepting very large uploads. If your archive grows past
          about 45&nbsp;MB, turn off <b>Send the uploaded files too</b> — the database alone stays small for years.
          A copy holding the database only is marked as such in the list, because it will not bring the photos back.</p>
      </details>

      <h3>Restore</h3>
      <p class="muted" style="margin-top:0">Puts a backup back — the database and the files with it. The current
        data is copied first in case this was the mistake, and nothing is swapped while the server is running:
        the restore is applied the next time it starts.</p>
      <div class="notice error" style="font-size:.9rem"><b>This replaces everything.</b> Every visit, visitor,
        document, setting and account is taken from the backup, including which accounts exist — so if that backup
        predates your password, you will be signing in with the old one.</div>
      <div class="row">
        <label class="btn subtle">Choose a backup…<input type="file" hidden id="restore-file" accept=".zip"></label>
        <span class="muted" id="restore-name">No file chosen</span>
      </div>
      <div id="restore-result"></div>
    </div>

    <div class="card section" id="set-deleted"><h2>Deleted records</h2>
      <p class="muted" style="margin-top:0">Deleting a visit or a visitor no longer destroys it. The record is kept
        here — with its signed documents and induction record — until the retention window above clears it, and can
        be put back at any time.</p>
      <div id="archive-list"><p class="empty">Loading…</p></div>
    </div>

    <div class="card section" id="set-users"><h2>Admin users</h2>
      <h3 style="margin-top:0">Your account</h3>
      <p class="muted" style="margin-top:0">Signed in as <b>${esc((ME && (ME.name || ME.email)) || '')}</b>.
        Changing your password signs out any other browser signed in as you.</p>
      <div class="inline-form">
        <label class="field"><span>Current password</span>
          <input class="input" id="pw-current" type="password" autocomplete="current-password"></label>
        <label class="field"><span>New password</span>
          <input class="input" id="pw-new" type="password" autocomplete="new-password"></label>
        <label class="field"><span>New password again</span>
          <input class="input" id="pw-again" type="password" autocomplete="new-password"></label>
        <button class="btn" id="pw-save" type="button">Change password</button>
      </div>
      <div id="pw-result"></div>

      <h3>Everyone with a login</h3>
      <div class="table-wrap"><table><tbody>${users.map((u) => `<tr><td><b>${esc(u.name || u.email)}</b><div class="muted">${esc(u.email)}</div></td>
        <td>${esc(u.role)}</td><td style="white-space:nowrap">${u.id === (ME && ME.id) ? '<span class="muted">you</span>'
          : `${(ME && ME.role === 'owner') ? `<button class="btn subtle" data-upw="${u.id}" data-uemail="${esc(u.email)}">Set password</button> ` : ''}
             <button class="btn ghost" data-udel="${u.id}">Remove</button>`}</td></tr>`).join('')}</tbody></table></div>
      <div class="inline-form" style="margin-top:1rem">
        <label class="field"><span>Name</span><input class="input" id="u-name"></label>
        <label class="field"><span>Email</span><input class="input" id="u-email" type="email"></label>
        <label class="field"><span>Password</span><input class="input" id="u-pass" type="password" autocomplete="new-password"></label>
        <button class="btn" id="u-add">Add user</button>
      </div>
      <p class="muted">Nobody can sign in at all? There is no reset email to send — run
        <code>node scripts/reset-password.js you@example.com &#39;a new password&#39;</code> on the server
        holding the data. On Railway that is a one-off command against this service.</p>
    </div>

    <div class="card section" id="set-activity"><h2>Activity log</h2>
      <p class="muted" style="margin-top:0">Who changed what, and when.</p>
      <div id="audit-list" class="scroll-10"><p class="empty">Loading…</p></div>
    </div>

    <!--
      What this install can actually do, asked of the machine it runs on.
      Last, because it is the page somebody opens when something is wrong
      rather than while setting something up.
    -->
    <div class="card section" id="set-check"><h2>Check this install</h2>
      <p class="muted" style="margin-top:0">Everything above says what was <i>configured</i>. This goes and looks
        at what is actually true from where this server is running: whether the data survives a deploy, whether it
        can reach the map and the address lookup, whether the address Teams fetches photos from resolves, whether
        the backups have ever run, whether the tablets are checking in — and the settings that are each valid on
        their own and together do nothing.</p>
      <p class="muted">It sends nothing anybody would see. No test messages go to real channels; it reports what
        the notification log already recorded, so it is free to press twice and harmless on a busy morning.</p>
      <div class="row">
        <button class="btn" id="check-run" type="button">Run the check</button>
        <button class="btn subtle hidden" id="check-copy" type="button">Copy as text</button>
        <span class="muted" id="check-when"></span>
      </div>
      <div id="check-out"></div>
    </div>

    <p class="muted">Everything here saves itself as you change it.</p>`;

  showSection(section || SECTION || firstSection());
  crossHighlight($('.fields-table.cross-hi', root));

  const saveSettings = autoSave(async () => {
    const patch = {};
    $$('[data-set]').forEach((input) => {
      /*
       * An empty number box is "not set", and must not be sent as 0.
       *
       * Number('') is 0, so every save of any setting on this page wrote a
       * zero into every number field nobody had filled in. Mostly harmless
       * and once badly not: it put 0 into the site's latitude and longitude,
       * which are perfectly finite numbers — so ticking "refuse phone
       * check-ins from away from the site" without placing the site first
       * built a fence around a point in the Gulf of Guinea and refused every
       * visitor on earth for standing several thousand kilometres away.
       *
       * It also quietly broke per-side badge margins, where empty means
       * "use the number for all round" and 0 means "no margin at all".
       */
      const blank = (input.type === 'number' || input.type === 'range')
        && String(input.value).trim() === '';
      const value = input.type === 'checkbox' ? input.checked
        : blank ? null
          : (input.type === 'number' || input.type === 'range') ? Number(input.value)
            : input.value;
      setPath(patch, input.dataset.set, value);
    });
    patch.kiosk = patch.kiosk || {};
    if (VIEWS.settings.collectFlow) patch.flow = VIEWS.settings.collectFlow();
    if (VIEWS.settings.collectWording) patch.wording = VIEWS.settings.collectWording();
    // Null when the designer has not loaded its catalogue yet; sending it
    // would clear the design rather than leave it alone.
    const designs = VIEWS.settings.collectCards && VIEWS.settings.collectCards();
    if (designs) {
      setPath(patch, 'notify.cards', designs);
      setPath(patch, 'notify.card', designs.signin);
    }
    if (VIEWS.settings.collectNotifyTypes) setPath(patch, 'notify.types_notified', VIEWS.settings.collectNotifyTypes());
    if (VIEWS.settings.collectRouting) setPath(patch, 'notify.type_routing', VIEWS.settings.collectRouting());
    if (VIEWS.settings.collectRequired) setPath(patch, 'compliance.required', VIEWS.settings.collectRequired());
    setSettings(await api('/settings', { method: 'PUT', body: patch }));
    // A rejected value — a time zone Intl cannot parse — is worth interrupting
    // for, because it was not saved and nothing else on screen would say so.
    if (SETTINGS.warnings && SETTINGS.warnings.length) toast(SETTINGS.warnings.join(' '), 7000);
    /*
     * A channel link the server refused is taken back off the screen.
     *
     * Leaving it in the box would show a link that is not stored and will
     * never be posted to, which is precisely the failure this checking
     * exists to prevent — the toast says why, and the empty box says it is
     * not saved.
     */
    const stored = (SETTINGS.notify || {}).type_routing || {};
    $$('[data-routehook]').forEach((box) => {
      const kept = (stored[box.dataset.routehook] || {}).webhook_url || '';
      if (!box.value.trim() || kept === box.value.trim()) return;
      box.value = kept;
      // Set directly rather than by firing 'input', which would start
      // another save of a change the server has already had.
      const card = box.closest('.route-card');
      $('[data-routeevents]', card).classList.toggle('hidden', !kept);
      $('.route-channel-foot', card).classList.toggle('hidden', !kept);
    });
    applyBranding();
    document.documentElement.style.setProperty('--brand', SETTINGS.org.primary_color || '#2f7d5d');
    document.documentElement.style.setProperty('--brand-dark', SETTINGS.org.accent_color || '#123a2c');
  });
  VIEWS.settings.save = saveSettings;
  autoSaveOn(root, saveSettings);

  /*
   * The kiosk shows the Request entry button only when there is a door for
   * it to open — ticking the box and finding nothing on the kiosk was the
   * kind of silence that costs an afternoon.
   */
  async function checkAccessDoors() {
    const box = $('#access-doors-warning');
    if (!box) return;
    let doors = [];
    try { doors = await api('/access-points'); } catch { return; }
    const live = doors.filter((d) => d.enabled !== 0);
    const wanted = $('[data-set="access.unlock_button_on_kiosk"]');
    box.innerHTML = (wanted && wanted.checked && !live.length)
      ? '<div class="notice error"><b>The button will not appear yet.</b> “Request entry” needs at least one '
        + 'switched-on door under <b>Settings → Access &amp; doors</b>. Until there is one the kiosk leaves the '
        + 'button off rather than showing something that cannot work.</div>'
      : '';
  }
  onSectionOpen('set-access', checkAccessDoors);
  const unlockBox = $('[data-set="access.unlock_button_on_kiosk"]');
  if (unlockBox) unlockBox.addEventListener('change', checkAccessDoors);

  /* --------------------------------------------- the notification cards */

  /*
   * One design per event, held here and sent whole on save — like the
   * wording and the step order — so switching between events or controls
   * never loses an edit. The preview is drawn by the server from these same
   * objects: there is no second copy of the layout rules in the browser to
   * drift out of step with what actually sends.
   */
  let CD = null;              // the catalogue: events, their fields, the links
  const cards = {};           // event id -> the design being edited
  /*
   * event id -> visitor type -> that type's own design.
   *
   * Absent means "the same as every other type", which is what most sites
   * want and what leaving it alone should mean. An entry here is a whole
   * design rather than a patch, so the controls edit it directly.
   */
  const perType = {};
  let cdEvent = 'signin';
  let cdType = '';            // '' is the design every type shares

  const cdEventDef = () => (CD ? CD.events.find((e) => e.id === cdEvent) : null);

  const cdSet = (id, value) => { const el = $(id); if (el) el.value = value ?? ''; };

  /** Whether this event can differ by visitor type at all — a parcel cannot. */
  const perTypeAllowed = () => !!CD && (CD.per_type_events || []).includes(cdEvent);

  /** The design the controls are editing: the shared one, or a type's own. */
  const editing = () => (cdType && perType[cdEvent] && perType[cdEvent][cdType])
    ? perType[cdEvent][cdType]
    : cards[cdEvent];

  const hasOwn = (type) => !!(perType[cdEvent] && perType[cdEvent][type]);

  /** Put one event's design into the controls. */
  function showCard() {
    const def = cdEventDef();
    const card = editing();
    if (!def || !card) return;

    $('#cd-events').innerHTML = CD.events.map((e) => `<button class="tab${e.id === cdEvent ? ' on' : ''}"
      data-cdevent="${e.id}">${esc(e.label)}</button>`).join('');
    $$('[data-cdevent]').forEach((b) => b.addEventListener('click', () => {
      cdEvent = b.dataset.cdevent;
      showCard();
      drawCardPreview();
    }));
    $('#cd-event-hint').textContent = def.hint;
    drawTypeTabs();
    $('#cd-tokens').innerHTML = 'You can use '
      + def.tokens.map(([t, what]) => `<code title="${esc(what)}">{${esc(t)}}</code>`).join(' ')
      + '. Anything empty disappears along with the spacing around it.';

    cdSet('#cd-header', card.header_style || 'accent');
    cdSet('#cd-details', card.details_style || 'facts');
    cdSet('#cd-title', card.title_template);
    cdSet('#cd-subtitle', card.subtitle_template);
    cdSet('#cd-footer', card.footer_template);
    cdSet('#cd-photo-place', card.photo_placement || 'left');
    cdSet('#cd-photo-shape', card.photo_shape || 'person');
    cdSet('#cd-photo-size', card.photo_size || 'large');
    cdSet('#cd-mention-line', card.mention_template || def.defaults.mention_template);
    cdSet('#cd-also-line', card.also_template);
    $('#cd-photo').checked = card.show_photo !== false;
    $('#cd-mention').checked = card.mention_host !== false;

    // A parcel has no face to show, so offering to put one on is a lie.
    $('#cd-photo').closest('.card-design').classList.toggle('no-photo', def.subject === 'delivery');

    drawCardFields();
    drawCardLinks();
  }

  /**
   * The row of visitor types under the event tabs.
   *
   * Every type is the usual answer and comes first. A type carrying its own
   * design is marked, so which of them differ is visible without opening
   * each one in turn.
   */
  function drawTypeTabs() {
    const row = $('#cd-types');
    const note = $('#cd-type-note');
    if (!row) return;
    if (!perTypeAllowed()) {
      row.innerHTML = '';
      note.innerHTML = '';
      cdType = '';
      return;
    }
    const types = CD.visitor_types || [];
    row.innerHTML = [
      `<button class="tab${cdType ? '' : ' on'}" data-cdtype="">Every type</button>`,
      ...types.map((t) => `<button class="tab${cdType === t.key ? ' on' : ''}" data-cdtype="${esc(t.key)}">
        ${esc(t.icon)} ${esc(t.label)}${hasOwn(t.key) ? ' <span class="tab-dot" title="Has its own design">●</span>' : ''}
      </button>`)
    ].join('');
    $$('[data-cdtype]', row).forEach((b) => b.addEventListener('click', () => {
      cdType = b.dataset.cdtype;
      showCard();
      drawCardPreview();
    }));

    note.innerHTML = !cdType
      ? '<p class="muted" style="margin:.25rem 0 .75rem">This is the card every visitor type gets. Pick a type '
        + 'above to give that one its own.</p>'
      : hasOwn(cdType)
        ? `<div class="notice" style="margin:.4rem 0 .75rem">This type has a card of its own — editing here
           changes it and nothing else.
           <button class="btn link" type="button" id="cd-type-drop">Use the same as every type</button></div>`
        : `<div class="notice" style="margin:.4rem 0 .75rem">Showing the card every type gets. Editing here would
           change it for everybody.
           <button class="btn link" type="button" id="cd-type-own">Give this type its own card</button></div>`;

    const own = $('#cd-type-own');
    if (own) own.addEventListener('click', () => {
      // Starts as a copy of the shared card, so somebody changing one line
      // does not lose the other nine.
      perType[cdEvent] = perType[cdEvent] || {};
      perType[cdEvent][cdType] = { ...cards[cdEvent] };
      showCard();
      saveSettings.soon();
      drawCardPreview();
    });
    const drop = $('#cd-type-drop');
    if (drop) drop.addEventListener('click', () => {
      if (!confirm('Drop this type\'s own card and use the shared one? What was designed here is lost.')) return;
      delete perType[cdEvent][cdType];
      showCard();
      saveSettings.soon();
      drawCardPreview();
    });
  }

  /** Read the controls back into the design for the event being edited. */
  function readCard() {
    const card = editing();
    if (!card) return {};
    card.header_style = $('#cd-header').value;
    card.details_style = $('#cd-details').value;
    card.title_template = $('#cd-title').value;
    card.subtitle_template = $('#cd-subtitle').value;
    card.footer_template = $('#cd-footer').value;
    card.show_photo = $('#cd-photo').checked;
    card.photo_placement = $('#cd-photo-place').value;
    card.photo_shape = $('#cd-photo-shape').value;
    card.photo_size = $('#cd-photo-size').value;
    card.mention_host = $('#cd-mention').checked;
    card.mention_template = $('#cd-mention-line').value;
    card.also_template = $('#cd-also-line').value;
    return card;
  }

  /*
   * Every design goes up on every save. `card` keeps the old single-design
   * key in step with sign-ins so nothing that still reads it — an older
   * server mid-deploy, a restored backup — suddenly has no design at all.
   */
  VIEWS.settings.collectCards = () => {
    if (!CD) return null;
    readCard();
    /*
     * by_type is sent whole every time, empty object included, so dropping
     * a type's own card actually drops it — settings merge key by key, and
     * leaving it out would keep the design somebody just deleted.
     */
    return Object.fromEntries(Object.entries(cards)
      .map(([id, card]) => [id, { ...card, by_type: (perType[id] || {}) }]));
  };
  VIEWS.settings.collectCard = () => (CD ? { ...cards.signin } : null);
  /** The design the designer is showing right now, for the test post. */
  VIEWS.settings.collectCurrent = () =>
    (CD ? { event: cdEvent, card: readCard(), visit_type: cdType || null } : null);

  /*
   * Stored as "false means no", so a visitor type created after this was
   * last saved is not sitting silently at the bottom of a map nobody
   * remembers to update.
   */
  VIEWS.settings.collectNotifyTypes = () => {
    const out = {};
    $$('[data-notifytype]').forEach((el) => { out[el.dataset.notifytype] = el.checked; });
    return out;
  };

  /** Which certificates each visitor type must have. */
  VIEWS.settings.collectRequired = () => {
    const out = {};
    $$('[data-needcard]').forEach((card) => {
      out[card.dataset.needcard] = $$('[data-needkind]:checked', card).map((box) => box.value);
    });
    return out;
  };

  /** Who each visitor type is routed to, beyond the person being visited. */
  VIEWS.settings.collectRouting = () => {
    const out = {};
    $$('[data-routecard]').forEach((card) => {
      const hook = $('[data-routehook]', card);
      /*
       * Every event written out, ticked or not. A missing entry means yes on
       * the server — which is the right default for a channel nobody has
       * narrowed, and the wrong answer for a box somebody has just unticked.
       */
      const events = {};
      $$('[data-routeevent]', card).forEach((box) => { events[box.value] = box.checked; });
      out[card.dataset.routecard] = {
        staff: $$('[data-routestaff]:checked', card).map((box) => Number(box.value)),
        webhook_url: hook ? hook.value.trim() : '',
        events
      };
    });
    return out;
  };

  const fieldDef = (id) => (cdEventDef().fields.find((f) => f.id === id) || { id, label: id });
  const SENSITIVE_NOTE = ' <span class="muted">— everyone in the channel can read this</span>';
  /*
   * A line the card sends whether or not it is chosen here. Said plainly in
   * the list rather than left to be discovered: a designer that shows a
   * field as left out while the card sends it anyway is a designer that
   * lies, and this exists precisely because the opposite lie — a field
   * quietly dropped from every card — went unnoticed for a day.
   */
  const ALWAYS_NOTE = ' <span class="muted">— sent anyway when somebody checks in by QR code, '
    + 'wherever you put it</span>';

  function drawCardFields() {
    const card = cards[cdEvent];
    const all = cdEventDef().fields;
    const chosen = (card.fields || []).filter((id) => all.some((f) => f.id === id));
    const rest = all.filter((f) => !chosen.includes(f.id));

    $('#cd-chosen').innerHTML = chosen.length ? chosen.map((id, i) => `<div class="section-row">
      <span>${esc(fieldDef(id).label)}${fieldDef(id).sensitive ? SENSITIVE_NOTE : ''}</span>
      <span class="flow-moves">
        <button class="btn ghost" data-cdup="${i}" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button>
        <button class="btn ghost" data-cddown="${i}" ${i === chosen.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
        <button class="btn ghost" data-cdout="${id}" title="Leave this out">Remove</button>
      </span></div>`).join('')
      : '<div class="section-row off"><span>Nothing but the heading.</span></div>';

    $('#cd-rest').innerHTML = rest.length ? rest.map((f) => `<div class="section-row off">
      <span>${esc(f.label)}${f.sensitive ? SENSITIVE_NOTE : ''}${f.always ? ALWAYS_NOTE : ''}</span>
      <span class="flow-moves"><button class="btn ghost" data-cdin="${f.id}">Add</button></span></div>`).join('')
      : '<div class="section-row off"><span>Everything is shown.</span></div>';

    const move = (from, to) => {
      if (to < 0 || to >= card.fields.length) return;
      const [item] = card.fields.splice(from, 1);
      card.fields.splice(to, 0, item);
      drawCardFields();
      drawCardPreview();
    };
    const alsoSave = (fn) => () => { fn(); saveSettings.soon(); };
    $$('[data-cdup]').forEach((b) => b.addEventListener('click', alsoSave(() => move(Number(b.dataset.cdup), Number(b.dataset.cdup) - 1))));
    $$('[data-cddown]').forEach((b) => b.addEventListener('click', alsoSave(() => move(Number(b.dataset.cddown), Number(b.dataset.cddown) + 1))));
    $$('[data-cdout]').forEach((b) => b.addEventListener('click', alsoSave(() => {
      card.fields = chosen.filter((id) => id !== b.dataset.cdout);
      drawCardFields(); drawCardPreview();
    })));
    $$('[data-cdin]').forEach((b) => b.addEventListener('click', alsoSave(() => {
      card.fields = [...chosen, b.dataset.cdin];
      drawCardFields(); drawCardPreview();
    })));
  }

  /** The same list-with-arrows idea, for the buttons along the bottom. */
  function drawCardLinks() {
    const card = cards[cdEvent];
    const all = CD.links;
    const chosen = (card.links || []).filter((id) => all.some((l) => l.id === id));
    const rest = all.filter((l) => !chosen.includes(l.id));
    const full = chosen.length >= CD.links_max;
    const label = (id) => (all.find((l) => l.id === id) || { label: id }).label;

    $('#cd-links').innerHTML = chosen.length ? chosen.map((id, i) => `<div class="section-row">
      <span>${esc(label(id))}</span>
      <span class="flow-moves">
        <button class="btn ghost" data-clup="${i}" ${i === 0 ? 'disabled' : ''} title="Move left">←</button>
        <button class="btn ghost" data-cldown="${i}" ${i === chosen.length - 1 ? 'disabled' : ''} title="Move right">→</button>
        <button class="btn ghost" data-clout="${id}">Remove</button>
      </span></div>`).join('')
      : '<div class="section-row off"><span>No buttons — just the message.</span></div>';

    $('#cd-links-rest').innerHTML = rest.map((l) => `<div class="section-row off">
      <span>${esc(l.label)}${l.needs && !CD.board_url && l.id === 'board'
        ? ` <span class="muted">— needs ${esc(l.needs)}, so it will be left off until then</span>` : ''}</span>
      <span class="flow-moves"><button class="btn ghost" data-clin="${l.id}" ${full ? 'disabled' : ''}>Add</button></span>
    </div>`).join('') || '<div class="section-row off"><span>Every link is on the card.</span></div>';

    const move = (from, to) => {
      if (to < 0 || to >= chosen.length) return;
      const next = [...chosen];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      card.links = next;
      drawCardLinks(); drawCardPreview();
    };
    const alsoSave = (fn) => () => { fn(); saveSettings.soon(); };
    $$('[data-clup]').forEach((b) => b.addEventListener('click', alsoSave(() => move(Number(b.dataset.clup), Number(b.dataset.clup) - 1))));
    $$('[data-cldown]').forEach((b) => b.addEventListener('click', alsoSave(() => move(Number(b.dataset.cldown), Number(b.dataset.cldown) + 1))));
    $$('[data-clout]').forEach((b) => b.addEventListener('click', alsoSave(() => {
      card.links = chosen.filter((id) => id !== b.dataset.clout);
      drawCardLinks(); drawCardPreview();
    })));
    $$('[data-clin]').forEach((b) => b.addEventListener('click', alsoSave(() => {
      card.links = [...chosen, b.dataset.clin].slice(0, CD.links_max);
      drawCardLinks(); drawCardPreview();
    })));
  }

  // One request per pause in typing, not one per keystroke.
  let previewTimer = null;
  const drawCardPreview = () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(loadCardPreview, 250);
  };

  /** The catalogue and the saved designs, fetched once when the panel opens. */
  async function loadCatalogue() {
    if (CD) return true;
    try { CD = await api('/notify/catalogue'); }
    catch (err) {
      if (err.message === 'unauthenticated') return false;
      $('#cd-preview').innerHTML = `<p class="empty">Could not load the designer: ${esc(err.message)}</p>`;
      return false;
    }
    CD.events.forEach((e) => {
      const saved = { ...(CD.cards[e.id] || {}) };
      // by_type lives in its own map here, not inside the design being edited.
      delete saved.by_type;
      cards[e.id] = { ...e.defaults, ...saved };
      perType[e.id] = { ...((CD.per_type || {})[e.id] || {}) };
    });
    showCard();
    return true;
  }

  async function loadCardPreview() {
    if (!(await loadCatalogue())) return;
    let data;
    try {
      data = await api('/notify/preview', {
        method: 'POST', body: { event: cdEvent, card: readCard(), visit_type: cdType || null } });
    }
    catch (err) {
      if (err.message === 'unauthenticated') return;
      $('#cd-preview').innerHTML = `<p class="empty">Could not draw the preview: ${esc(err.message)}</p>`;
      return;
    }
    // A slow request for an event, or a type, nobody is looking at any more.
    if (data.event !== cdEvent || (data.visit_type || '') !== cdType) return;

    $('#cd-preview').innerHTML = teamsPreviewHtml(data.model);
    const dump = $('#cd-json');
    if (dump) dump.textContent = JSON.stringify(data.teams, null, 2);
    $('#cd-sample').textContent = data.sample
      ? 'Nothing of this kind has happened yet, so this shows made-up details.'
      : 'Shown with the most recent real one.';

    /*
     * A card with no face on it has three quite different causes that look
     * exactly the same on screen: switched off, nobody to show one for, or
     * an address Teams cannot fetch from. Saying which turns "the photo
     * isn't showing" into something you can act on.
     */
    const warn = $('#cd-photo-warning');
    const def = cdEventDef();
    warn.innerHTML = (() => {
      if (def.subject === 'delivery') return '';
      if (!editing().show_photo) {
        return '<div class="notice">No photo on this card — <b>Show the visitor\'s photo</b> is switched off '
          + 'for this notification. Sign-outs and parcels start that way.</div>';
      }
      if (!data.subject_has_photo) {
        return '<div class="notice">The photo is switched on, but nobody in the example has one — either the '
          + 'kiosk is not asking for a photo, or nobody has signed in with one yet. Real arrivals with a photo '
          + 'will show it.</div>';
      }
      if (!data.public_url_reachable) {
        return `<div class="notice error">Teams fetches the photo from
           <b>${esc(data.public_url)}</b>, which it cannot reach from outside. Set the public address below —
           or the PUBLIC_URL variable on the server — or the card will arrive with a blank space where the face
           should be.</div>`;
      }
      return '';
    })();
  }

  /** The Adaptive Card as Teams draws it, near enough to design against. */
  function teamsPreviewHtml(m) {
    const px = { small: 56, medium: 84, large: 120 }[m.photoSize] || 120;
    const photo = m.photoUrl
      ? `<img class="tp-photo ${m.photoShape === 'person' ? 'round' : ''}" src="${esc(m.photoUrl)}"
           style="width:${px}px;height:${px}px" alt="">`
      : '';
    /*
     * The tag line is a template with {host} in it, exactly as it is on the
     * card — rendering it any other way here would show wording that is not
     * what sends, which is the one thing a preview must never do.
     */
    const mentionHtml = (m.mention && m.mentionTemplate)
      // Escaped first, then the placeholder swapped for the tag, so a name
      // or a template with a < in it cannot open a tag of its own.
      ? `<div class="tp-mention">${esc(String(m.mentionTemplate)).split('{host}')
          .join(`<span class="tp-at">@${esc(m.mention.name)}</span>`)}</div>`
      : '';
    const tag = (name) => `<span class="tp-at">@${esc(name)}</span>`;
    const names = (m.alsoMention || []).map((p) => tag(p.name));
    const alsoHtml = (names.length && m.alsoTemplate)
      ? `<div class="tp-mention tp-also">${esc(String(m.alsoTemplate)).split('{who}')
          .join(names.length > 1
            ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
            : names[0])}</div>`
      : '';
    const heading = `<div class="tp-title tp-${esc(m.headerStyle)}">${esc(m.title)}</div>
      ${m.subtitle ? `<div class="tp-sub">${esc(m.subtitle)}</div>` : ''}
      ${mentionHtml}${alsoHtml}`;
    const details = m.fields.length
      ? (m.detailsStyle === 'facts'
        ? `<div class="tp-facts">${m.fields.map((f) => `<div class="tp-fact-l">${esc(f.label)}</div>
            <div class="tp-fact-v">${esc(f.value)}</div>`).join('')}</div>`
        : `<div class="tp-lines">${m.fields.map((f) =>
            `<div>${f.label ? `<b>${esc(f.label)}:</b> ` : ''}${esc(f.value)}</div>`).join('')}</div>`)
      : '';
    /*
     * The same arrangement the card itself uses: face beside the heading,
     * facts at full width underneath. Both in one narrow column was what
     * cut the longer values off.
     */
    const main = (photo && m.photoPlacement === 'left')
      ? `<div class="tp-row">${photo}<div class="tp-main">${heading}</div></div>${details}`
      : `${photo}${heading}${details}`;
    const links = m.links || [];
    return `<div class="tp-card">
      <div class="tp-band tp-band-${esc(m.headerStyle)}">${main}</div>
      ${m.footer ? `<div class="tp-footer">${esc(m.footer)}</div>` : ''}
      ${links.length ? `<div class="tp-actions">${links.map((l) =>
        `<span class="tp-btn">${esc(l.label)}</span>`).join('')}</div>` : ''}
    </div>`;
  }

  // The card designer's own controls carry no data-set, so they ask here.
  ['#cd-header', '#cd-details', '#cd-title', '#cd-subtitle', '#cd-footer', '#cd-photo',
    '#cd-photo-place', '#cd-photo-shape', '#cd-photo-size',
    '#cd-mention', '#cd-mention-line', '#cd-also-line']
    .forEach((sel) => {
      const el = $(sel);
      if (el) el.addEventListener('input', () => { drawCardPreview(); saveSettings.soon(); });
    });
  $$('[data-notifytype]').forEach((el) => el.addEventListener('change', () => {
    /*
     * A type nobody is posting about tells nobody, routed or not — the card
     * says so rather than leaving a list of names that does nothing.
     */
    const card = el.closest('.route-card');
    if (card) card.classList.toggle('not-posting', !el.checked);
    saveSettings.soon();
  }));
  $$('[data-needkind]').forEach((el) => el.addEventListener('change', () => saveSettings.soon()));
  $$('[data-routestaff]').forEach((el) => el.addEventListener('change', () => {
    routeSummary(el.dataset.routestaff);
    /*
     * Saved at once rather than after the usual pause: the preview's extra
     * tag line is built from the routing the *server* holds, so redrawing
     * before the save lands would show the previous selection.
     */
    Promise.resolve(saveSettings.now()).then(loadCardPreview);
  }));

  /*
   * The install check: run it, show it, and make it easy to hand to somebody
   * who can help.
   *
   * The copy button is the point of the whole panel as much as the checks
   * are. "It says the map cannot be loaded" is a sentence somebody has to
   * retype; the text version is the whole picture, pasted in one go, with
   * the version and the states of everything that was not asked about.
   */
  const checkRun = $('#check-run');
  if (checkRun) {
    const out = $('#check-out');
    const when = $('#check-when');
    const copy = $('#check-copy');
    const MARK = { ok: '✓', warn: '!', bad: '✕', info: '·', skip: '·' };

    checkRun.addEventListener('click', async () => {
      checkRun.disabled = true;
      when.textContent = 'Looking…';
      out.innerHTML = '';
      try {
        const r = await api('/selfcheck');
        const groups = [];
        for (const c of r.checks) {
          const last = groups[groups.length - 1];
          if (last && last.name === c.group) last.items.push(c);
          else groups.push({ name: c.group, items: [c] });
        }
        const counts = r.counts || {};
        when.textContent = `${counts.bad || 0} needing attention, ${counts.warn || 0} worth a look, `
          + `${counts.ok || 0} fine.`;
        out.innerHTML = groups.map((g) => `<div class="check-group">
          <h4>${esc(g.name)}</h4>
          ${g.items.map((c) => `<div class="check-row is-${esc(c.state)}">
            <span class="check-mark">${MARK[c.state] || '·'}</span>
            <span class="check-body"><b>${esc(c.label)}</b> — ${esc(c.detail)}
              ${c.hint && (c.state === 'bad' || c.state === 'warn')
  ? `<span class="muted check-hint">${esc(c.hint)}</span>` : ''}</span>
          </div>`).join('')}
        </div>`).join('');
        copy.classList.remove('hidden');
      } catch (err) {
        out.innerHTML = `<div class="notice error">Could not run the check. ${esc(err.message || '')}</div>`;
      } finally { checkRun.disabled = false; }
    });

    copy.addEventListener('click', async () => {
      try {
        const res = await api('/selfcheck.txt', { raw: true });
        const text = await res.text();
        /*
         * The clipboard is refused outside a secure context and in some
         * kiosk browsers, and a button that silently does nothing is worse
         * than one that hands over the text to copy by hand.
         */
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
          toast('Copied. Paste it wherever it is needed.');
        } else {
          modal('The check, as text', `<p class="muted" style="margin-top:0">This browser will not let a page
            write to the clipboard here, so select it and copy it by hand.</p>
            <pre class="json-dump" style="max-height:22rem">${esc(text)}</pre>`);
        }
      } catch { toast('Could not fetch the text version'); }
    });
  }

  /*
   * One visitor type on screen at a time, the same way the card designer
   * works. Panels are hidden rather than removed — see the note by the
   * markup: everything is collected on save, and a panel that is not in the
   * page cannot be.
   */
  $$('[data-routetab]').forEach((tab) => tab.addEventListener('click', () => {
    const key = tab.dataset.routetab;
    $$('[data-routetab]').forEach((t) => t.classList.toggle('on', t === tab));
    $$('[data-routecard]').forEach((card) => { card.hidden = card.dataset.routecard !== key; });
    drawRouteHistory(key);
  }));
  // And for whichever tab is showing when the page is first drawn.
  const firstTab = $('[data-routetab]');
  if (firstTab) drawRouteHistory(firstTab.dataset.routetab);

  /** The one-line "who this reaches", kept in step with the ticks. */
  function routeSummary(type) {
    const card = $(`[data-routecard="${type}"]`);
    const label = $(`[data-routecount="${type}"]`, card);
    if (!label) return;
    const names = $$('[data-routestaff]:checked', card)
      .map((box) => box.closest('.route-person').querySelector('span').childNodes[0].textContent.trim());
    label.textContent = names.length ? joinNames(names) : 'Nobody — just the host and the channel';
  }

  /*
   * A type's own channel. The event ticks and the test button are hidden
   * until there is a link to apply them to, because a row of checkboxes
   * governing nothing reads as a feature that is switched on.
   */
  $$('[data-routehook]').forEach((box) => box.addEventListener('input', () => {
    const card = box.closest('.route-card');
    const has = !!box.value.trim();
    $('[data-routeevents]', card).classList.toggle('hidden', !has);
    $('.route-channel-foot', card).classList.toggle('hidden', !has);
    $('[data-routehistory]', card).classList.toggle('hidden', !has);
    $(`[data-routetestnote="${box.dataset.routehook}"]`, card).textContent = '';
    saveSettings.soon();
    if (has) drawRouteHistory(box.dataset.routehook);
  }));

  /**
   * The last few attempts on one type's own channel.
   *
   * Deliberately says "accepted" rather than "delivered" for a 202, the same
   * as everywhere else: a Teams workflow answers when it takes the request
   * and posts the card afterwards, so this is the end of what is knowable
   * from here.
   */
  async function drawRouteHistory(type) {
    const card = $(`[data-routecard="${type}"]`);
    const box = card && $('[data-routehistory]', card);
    const field = card && $('[data-routehook]', card);
    if (!box || !field) return;
    const url = field.value.trim();
    if (!url) { box.innerHTML = ''; return; }
    let r;
    try { r = await api(`/notifications/for?url=${encodeURIComponent(url)}`); } catch { return; }
    if (!r.attempts.length) {
      box.innerHTML = '<p class="muted route-history-note">Nothing has been sent to this channel yet. '
        + 'The test above proves the link; the first real arrival of this type proves the rest.</p>';
      return;
    }
    box.innerHTML = `<p class="muted route-history-note">${r.sent} of ${r.total} accepted.</p>
      <div class="route-attempts">${r.attempts.map((a) => {
  const good = a.status === 'sent';
  return `<div class="route-attempt ${good ? 'is-ok' : 'is-bad'}">
          <span>${esc(fmtDate(a.created_at))}</span>
          <span>${esc(a.visitor_name || 'a test')}</span>
          <span>${good ? 'accepted' : esc(a.status)}${a.error ? ` — ${esc(String(a.error).slice(0, 80))}` : ''}</span>
        </div>`;
}).join('')}</div>`;
  }
  $$('[data-routeevent]').forEach((box) => box.addEventListener('change', () => saveSettings.soon()));

  /*
   * A test posted to the type's own channel, built as that type's arrival —
   * so what lands is the card contractors will actually get, in the channel
   * they will actually get it in. Saved first: a link typed and tested
   * without a save behind it is the one that passes here and then never
   * delivers anything.
   */
  $$('[data-routetest]').forEach((btn) => btn.addEventListener('click', async () => {
    const type = btn.dataset.routetest;
    const card = $(`[data-routecard="${type}"]`);
    const note = $(`[data-routetestnote="${type}"]`, card);
    const url = $('[data-routehook]', card).value.trim();
    if (!url) return;
    btn.disabled = true;
    note.textContent = 'Posting…';
    try {
      await saveSettings.now();
      const r = await api('/settings/test-webhook', { method: 'POST', body: { url, event: 'signin', visit_type: type } });
      note.textContent = r.ok
        ? (r.accepted_only
          ? 'Accepted by the workflow — check the channel. If nothing appears, the flow failed after taking it; '
            + 'its run history in Power Automate says why.'
          : 'Posted — it should be in that channel now, from Flow bot. Nobody was tagged.')
        : `It was refused: ${r.detail || 'no reason given'}`;
    } catch (err) {
      note.textContent = `Could not post: ${err.message || 'the server did not answer'}`;
    } finally { btn.disabled = false; }
  }));

  /*
   * Filtering hides rows rather than removing them, so a name ticked and
   * then filtered out of view is still ticked when the box is cleared —
   * and, more importantly, is still there to be collected on save.
   */
  $$('[data-routefilter]').forEach((box) => box.addEventListener('input', () => {
    const card = $(`[data-routecard="${box.dataset.routefilter}"]`);
    const needle = box.value.trim().toLowerCase();
    $$('.route-person', card).forEach((row) => {
      row.hidden = !!needle && !row.textContent.toLowerCase().includes(needle);
    });
  }));

  // Drawn as soon as the panel is opened, not on a settings page nobody expanded.
  onSectionOpen('set-notifications', loadCardPreview);

  /* ------------------------------------------- deleted records & the log */

  const ARCHIVE_KIND = { visit: 'Visit', visitor: 'Visitor' };

  /** The one-line description of what was thrown away. */
  function archiveDetail(e) {
    const s = e.summary || {};
    const bits = [];
    // A company field long enough to shove the Restore button off the row.
    if (s.company) bits.push(esc(s.company.length > 70 ? `${s.company.slice(0, 70)}…` : s.company));
    if (e.kind === 'visit') {
      if (s.signed_in_at) bits.push(`signed in ${fmtDate(s.signed_in_at)}`);
      if (s.documents_signed) bits.push(`${s.documents_signed} document${s.documents_signed === 1 ? '' : 's'} signed`);
      if (s.induction) bits.push('induction completed');
    } else {
      bits.push(`${s.visits || 0} visit${s.visits === 1 ? '' : 's'} taken with them`);
    }
    return bits.join(' · ');
  }

  async function drawArchive() {
    const wrap = $('#archive-list');
    if (!wrap) return;
    let rows;
    try { rows = await api('/archive'); } catch (err) {
      if (err.message === 'unauthenticated') return;
      wrap.innerHTML = `<p class="empty">Could not load: ${esc(err.message)}</p>`; return;
    }
    if (!rows.length) { wrap.innerHTML = '<p class="empty">Nothing has been deleted.</p>'; return; }
    wrap.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>What</th><th>Deleted</th><th>By</th><th></th></tr></thead>
      <tbody>${rows.map((e) => `<tr>
        <td class="arch-what"><b>${esc(e.label)}</b><div class="muted">${ARCHIVE_KIND[e.kind] || esc(e.kind)}${
          archiveDetail(e) ? ' — ' + archiveDetail(e) : ''}</div></td>
        <td>${fmtDate(e.deleted_at)}</td>
        <td>${esc(e.deleted_by)}</td>
        <td style="white-space:nowrap">
          <button class="btn subtle" data-restore="${e.id}">Restore</button>
          <button class="btn ghost" data-purge="${e.id}">Delete for good</button></td>
      </tr>`).join('')}</tbody></table></div>`;

    $$('[data-restore]', wrap).forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const r = await api(`/archive/${b.dataset.restore}/restore`, { method: 'POST' });
        toast(`${r.label || 'Record'} restored`);
        await drawArchive();
        drawAudit();
      } catch (err) {
        b.disabled = false;
        toast((err.data && err.data.message) || 'Could not restore that record');
      }
    }));

    $$('[data-purge]', wrap).forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Delete this permanently? The record and its signatures cannot be recovered afterwards.')) return;
      b.disabled = true;
      try {
        await api(`/archive/${b.dataset.purge}`, { method: 'DELETE' });
        toast('Deleted for good');
        await drawArchive();
        drawAudit();
      } catch { b.disabled = false; toast('Could not delete that entry'); }
    }));
  }

  const ACTIONS = {
    delete: 'Deleted', restore: 'Restored', purge: 'Deleted for good', create: 'Created', update: 'Changed',
    signout: 'Signed out', signout_all: 'Signed everyone out', reset_induction: 'Reset induction',
    login: 'Signed in', unlock: 'Opened a door'
  };

  async function drawAudit() {
    const wrap = $('#audit-list');
    if (!wrap) return;
    let rows;
    try { rows = await api('/audit?limit=200'); } catch (err) {
      if (err.message === 'unauthenticated') return;
      wrap.innerHTML = `<p class="empty">Could not load: ${esc(err.message)}</p>`; return;
    }
    if (!rows.length) { wrap.innerHTML = '<p class="empty">Nothing recorded yet.</p>'; return; }
    wrap.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead>
      <tbody>${rows.map((a) => `<tr>
        <td style="white-space:nowrap">${fmtDate(a.created_at || a.at)}</td>
        <td>${esc(a.user_name || a.user_email || 'system')}</td>
        <td>${esc(ACTIONS[a.action] || a.action)} ${esc(a.entity || '')}${
          a.entity_id ? ` <span class="muted">#${a.entity_id}</span>` : ''}</td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  /* ------------------------------------------------------- the wall board */

  async function drawBoard() {
    const wrap = $('#board-state');
    if (!wrap) return;
    let b;
    try { b = await api('/board'); } catch (err) {
      if (err.message === 'unauthenticated') return;
      wrap.innerHTML = `<p class="empty">Could not load: ${esc(err.message)}</p>`; return;
    }
    wrap.innerHTML = b.url
      ? `<label class="field"><span>Board link</span>
           <div class="row" style="margin:0">
             <input class="input" id="board-url" readonly value="${esc(b.url)}" style="flex:1;min-width:14rem">
             <button class="btn subtle" id="board-copy" type="button">Copy</button>
             <a class="btn ghost" href="${esc(b.url)}" target="_blank" rel="noopener">Open ↗</a>
           </div></label>
         <div class="row"><button class="btn ghost" id="board-new" type="button">New link</button>
           <button class="btn ghost" id="board-off" type="button">Turn off</button></div>`
      : `<div class="row"><button class="btn" id="board-on" type="button">Turn the board on</button>
           <span class="muted">This creates the link.</span></div>`;

    const on = $('#board-on'); const fresh = $('#board-new'); const off = $('#board-off');
    const set = async (enabled, btn, note) => {
      btn.disabled = true;
      try {
        await api('/board/key', { method: 'POST', body: { enabled } });
        toast(note);
        await drawBoard();
        showBoardLink();
      }
      catch { btn.disabled = false; toast('Could not change the board'); }
    };
    if (on) on.addEventListener('click', () => set(true, on, 'Board is on'));
    if (fresh) fresh.addEventListener('click', () => {
      if (confirm('Replace the link? Anyone using the old one will stop seeing the board.')) set(true, fresh, 'New link created');
    });
    if (off) off.addEventListener('click', () => {
      if (confirm('Turn the board off? Every copy of the link stops working.')) set(false, off, 'Board turned off');
    });
    const copy = $('#board-copy');
    if (copy) copy.addEventListener('click', async () => {
      const text = $('#board-url').value;
      try { await navigator.clipboard.writeText(text); }
      catch { $('#board-url').select(); document.execCommand('copy'); }
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
    });
  }

  // Both lists are fetched the first time their panel is opened, so the
  // settings page still loads in one request for everyone who never looks.
  /* ---------------------------------------------------------- backups */

  const sizeOf = (bytes) => (bytes > 1048576
    ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} kB`);

  async function drawBackups() {
    const wrap = $('#backup-list');
    if (!wrap) return;
    let data;
    try { data = await api('/backups'); } catch (err) {
      if (err.message === 'unauthenticated') return;
      wrap.innerHTML = `<p class="empty">Could not load: ${esc(err.message)}</p>`; return;
    }
    const h = data.health || {};
    $('#backup-health').innerHTML = h.pending_restore
      ? `<div class="notice"><b>A restore is waiting.</b> It is applied the next time the server starts.
         <button class="btn link" id="restore-cancel" type="button">Cancel it</button></div>`
      : h.stale
        ? `<div class="notice error"><b>${h.last_at ? `No backup since ${esc(fmtDate(h.last_at))}` : 'No backup has been written yet'}.</b>
           One should be written every night — press <b>Back up now</b> and check the server logs if it fails.</div>`
        : '';
    const off = h.offsite || {};
    if (off.enabled) {
      const pieces = off.last_parts > 1
        ? ` in ${off.last_parts} pieces, because it is past what a flow accepts in one go` : '';
      $('#backup-health').innerHTML += off.last_ok
        ? `<div class="notice">Copied to OneDrive${off.last_at ? ` — last one ${esc(fmtDate(off.last_at))}` : ''}${esc(pieces)}.</div>`
        : `<div class="notice error"><b>The last copy to OneDrive did not get there.</b>
           ${esc(off.last_error || '')}
           ${off.last_database_ok
             ? ' The database itself did get away, so the records are safe off the machine — it is the photos and '
               + 'signatures that did not.'
             : ''}
           Backups are still being written here.</div>`;
    }
    $('#backup-total').textContent = data.backups.length
      ? `${data.backups.length} kept, ${sizeOf(h.total_bytes || 0)} in total`
      : '';

    /*
     * What is actually using the room. Photos are almost always the answer,
     * and knowing that is the difference between shortening how long they
     * are kept and deleting whatever looks big.
     */
    const st = data.storage || {};
    const box = $('#storage-use');
    if (box) {
      const parts = [
        ['Photos and signatures', st.uploads, `${st.upload_files || 0} files`],
        ['Database', st.database, ''],
        ['Backups kept here', st.backups, `${st.backup_files || 0} files`]
      ].filter(([, bytes]) => bytes > 0);
      box.innerHTML = `
        ${st.volume_size ? `<div class="disk-bar ${esc(st.level || 'ok')}">
          <div class="disk-fill" style="width:${Math.min(100, st.percent_used || 0)}%"></div></div>
          <p class="muted" style="margin:.35rem 0 .75rem">${st.percent_used}% of
            ${sizeOf(st.volume_size)} used — ${sizeOf(st.volume_free)} left${st.days_left != null
              ? `, about ${st.days_left} day${st.days_left === 1 ? '' : 's'} at the rate photos are arriving` : ''}.</p>`
          : '<p class="muted" style="margin:0 0 .75rem">This server does not report how big its disk is, so only the '
            + 'breakdown below is known.</p>'}
        <div class="section-order">
          ${parts.map(([label, bytes, note]) => `<div class="section-row">
            <span>${esc(label)}${note ? ` <span class="muted">— ${esc(note)}</span>` : ''}</span>
            <b>${sizeOf(bytes)}</b></div>`).join('')
            || '<div class="section-row off"><span>Nothing stored yet.</span></div>'}
        </div>
        ${st.photos > 0 ? `<p class="muted">Photos alone are ${sizeOf(st.photos)} across ${st.photo_files} files.
          How long they are kept is set under <b>Data retention &amp; privacy</b>; shortening it is usually the
          quickest room to find.</p>` : ''}`;
    }
    const shedNote = $('#shed-last');
    if (shedNote) {
      shedNote.textContent = st.shed_last_at
        ? `Last freed ${sizeOf(st.shed_last_freed)} on ${fmtDate(st.shed_last_at)}, `
          + `${st.shed_last_photos} photo${st.shed_last_photos === 1 ? '' : 's'}.`
        : st.shedding
          ? `Has not needed to run — it starts at ${st.shed_at_percent || 90}% full.`
          : 'Switched off, so a full disk will stop sign-ins instead.';
    }

    wrap.innerHTML = data.backups.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Taken</th><th>Size</th><th>Holds</th><th></th></tr></thead>
      <tbody>${data.backups.map((b) => `<tr>
        <td>${fmtDate(b.at)}</td><td>${sizeOf(b.bytes)}</td>
        <td>${b.complete ? 'Database and files'
          : '<span class="muted">Database only — photos and signatures will not come back from this one</span>'}</td>
        <td style="white-space:nowrap">
          <button class="btn ghost" data-bktest="${esc(b.file)}">Test</button>
          <a class="btn ghost" href="/api/admin/backups/${encodeURIComponent(b.file)}">Download</a>
          ${(h.offsite && h.offsite.enabled) ? `<button class="btn ghost" data-bksend="${esc(b.file)}">Send</button>` : ''}
          <button class="btn ghost" data-bkdel="${esc(b.file)}">Delete</button></td>
      </tr>`).join('')}</tbody></table></div>`
      : '<p class="empty">No backup written yet — the first runs a minute after the server starts.</p>';

    /*
     * The drill. A backup nobody has ever opened is a promise, and the day
     * you find out otherwise is the worst possible day — so this opens one
     * and says what it would actually put back, changing nothing.
     */
    $$('[data-bktest]', wrap).forEach((b) => b.addEventListener('click', async () => {
      const file = b.dataset.bktest;
      const was = b.textContent;
      b.disabled = true;
      b.textContent = 'Testing…';
      try {
        const r = await api(`/backups/${encodeURIComponent(file)}/drill`, { method: 'POST' });
        modal('Backup test', `
          <p class="notice ${r.warnings && r.warnings.length ? 'warn' : 'ok'}"
             style="font-size:1rem">${esc(r.summary)}</p>
          ${r.files_only ? '' : `<table><tbody>
            <tr><td>Visits</td><td><b>${(r.counts.visits || 0).toLocaleString()}</b></td></tr>
            <tr><td>People</td><td><b>${(r.counts.visitors || 0).toLocaleString()}</b></td></tr>
            <tr><td>Signed documents</td><td><b>${(r.counts.signatures || 0).toLocaleString()}</b></td></tr>
            <tr><td>Accounts able to sign in</td><td><b>${(r.counts.users || 0).toLocaleString()}</b></td></tr>
            <tr><td>Photos and signatures held</td><td><b>${(r.media_files || 0).toLocaleString()}</b>
              ${r.missing_files ? `<span class="muted"> — ${r.missing_files} referenced but missing</span>` : ''}</td></tr>
            ${r.first_visit ? `<tr><td>Covers</td><td>${fmtDay(r.first_visit)} → ${fmtDay(r.last_visit)}</td></tr>` : ''}
          </tbody></table>`}
          ${(r.warnings || []).map((w) => `<p class="muted">• ${esc(w)}</p>`).join('')}
          <p class="muted">Nothing was changed. This opened the archive, read the database inside it and put
            it down again.</p>`, null);
      } catch (err) {
        modal('Backup test', `<p class="notice error" style="font-size:1rem">This backup would not restore.</p>
          <p class="muted">${esc((err.data && err.data.error) || 'It could not be opened at all.')}</p>
          <p class="muted">Take a fresh one, and do not delete any older backup until it tests clean.</p>`, null);
      } finally { b.disabled = false; b.textContent = was; }
    }));
    $$('[data-bksend]', wrap).forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const r = await api(`/backups/${encodeURIComponent(b.dataset.bksend)}/offsite`, { method: 'POST' });
        toast(r.ok ? 'Sent to OneDrive' : `Did not get there — ${r.error}`, r.ok ? 3000 : 8000);
        await drawBackups();
      } catch { toast('Could not send that backup'); } finally { b.disabled = false; }
    }));
    $$('[data-bkdel]', wrap).forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Delete this backup? It cannot be recovered.')) return;
      try { await api(`/backups/${encodeURIComponent(b.dataset.bkdel)}`, { method: 'DELETE' }); await drawBackups(); }
      catch { toast('Could not delete that backup'); }
    }));
    const cancel = $('#restore-cancel');
    if (cancel) cancel.addEventListener('click', async () => {
      await api('/restore', { method: 'DELETE' }).catch(() => {});
      toast('Restore cancelled');
      await drawBackups();
    });
  }

  /*
   * Restoring is two steps on purpose. The first only reads the file and
   * says what is in it; nothing is staged until somebody has seen that and
   * agreed to it, because the thing being replaced is everything.
   */
  $('#restore-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    const box = $('#restore-result');
    if (!file) return;
    $('#restore-name').textContent = file.name;
    box.innerHTML = '<p class="muted">Reading it…</p>';

    const form = new FormData();
    form.append('file', file);
    let look;
    try {
      look = await fetch('/api/admin/restore/check', { method: 'POST', body: form }).then((r) => r.json());
    } catch { look = { ok: false, error: 'The server did not answer.' }; }
    if (!look.ok) {
      box.innerHTML = `<div class="notice error">${esc(look.error)}</div>`;
      return;
    }

    box.innerHTML = `<div class="notice">
      <b>That is a valid backup.</b> ${look.created_at ? `Taken ${esc(fmtDate(look.created_at))}. ` : ''}
      It holds ${look.counts.visits} visit(s), ${look.counts.visitors} visitor(s),
      ${look.counts.signatures} signature(s), ${look.counts.users} account(s)
      and ${look.media_files} uploaded file(s).</div>
      <div class="row"><button class="btn" id="restore-go" type="button">Restore this backup</button></div>`;

    $('#restore-go').addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      if (!confirm(`Replace everything with this backup?\n\n`
        + `${look.counts.visits} visits and ${look.media_files} files take the place of what is here now. `
        + 'A copy of the current data is taken first.')) return;
      btn.disabled = true;
      const send = new FormData();
      send.append('file', file);
      try {
        const r = await fetch('/api/admin/restore', { method: 'POST', body: send }).then((x) => x.json());
        box.innerHTML = r.ok
          ? `<div class="notice"><b>${esc(r.message)}</b><br>
             The current data was saved first as <b>${esc(r.safety_backup)}</b>.</div>`
          : `<div class="notice error">${esc(r.message)}</div>`;
        await drawBackups();
      } catch {
        box.innerHTML = '<div class="notice error">Could not stage the restore.</div>';
      } finally { btn.disabled = false; }
    });
  });

  $('#offsite-test').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const box = $('#offsite-result');
    const url = $('[data-set="backup.offsite_url"]').value.trim();
    if (!url) return toast('Paste the flow URL first');
    btn.disabled = true;
    box.innerHTML = '<p class="muted">Sending a small file…</p>';
    try {
      const r = await api('/backups/offsite/test', { method: 'POST', body: {
        url, secret: $('[data-set="backup.offsite_secret"]').value.trim() } });
      box.innerHTML = r.ok
        ? '<div class="notice"><b>It arrived.</b> Check the OneDrive folder — there should be a small text file in '
          + 'it. Backups will land in the same place.</div>'
        : `<div class="notice error"><b>It did not get there.</b> ${esc(r.error || '')}</div>`;
    } catch {
      box.innerHTML = '<div class="notice error">Could not run the test.</div>';
    } finally { btn.disabled = false; }
  });

  /*
   * The site's coordinates, read from the browser of whoever is standing on
   * it. Far easier than finding them on a map, and it is the one number here
   * that is tedious to get right by hand.
   */
  const geoHere = $('#geo-here');
  if (geoHere) geoHere.addEventListener('click', () => {
    const note = $('#geo-here-note');
    if (!navigator.geolocation) { note.textContent = 'This browser will not report a location.'; return; }
    note.textContent = 'Asking this browser where it is…';
    navigator.geolocation.getCurrentPosition((pos) => {
      const lat = pos.coords.latitude.toFixed(6);
      const lng = pos.coords.longitude.toFixed(6);
      setSettingField('geofence.lat', lat);
      setSettingField('geofence.lng', lng);
      note.textContent = `Set to ${lat}, ${lng} — accurate to about ${Math.round(pos.coords.accuracy)} m.`;
    }, (err) => {
      note.textContent = err.code === 1
        ? 'Location was refused. Allow it for this page and try again.'
        : 'Could not get a location from this browser.';
    }, { enableHighAccuracy: true, timeout: 10000 });
  });

  /*
   * Placing the site by address, for whoever is setting this up from an
   * office rather than standing at the gate.
   *
   * The matches are listed rather than the first one taken: a street name
   * exists in forty towns, and a fence quietly placed on the wrong one is
   * found out by a visitor who cannot sign in, which is the worst way to
   * find anything out.
   */
  const findBtn = $('#geo-find');
  if (findBtn) {
    const box = $('#geo-address');
    const list = $('#geo-results');

    const setCoords = (lat, lng) => {
      setSettingField('geofence.lat', lat);
      setSettingField('geofence.lng', lng);
    };

    const find = async () => {
      const q = box.value.trim();
      if (q.length < 3) { list.innerHTML = '<p class="muted">Type a few more characters.</p>'; return; }
      list.innerHTML = '<p class="muted">Looking…</p>';
      findBtn.disabled = true;
      let out;
      try {
        out = await api(`/geocode?q=${encodeURIComponent(q)}`);
      } catch {
        out = { message: 'Could not reach the address lookup from this server.' };
      }
      findBtn.disabled = false;

      if (!out.results || !out.results.length) {
        list.innerHTML = `<p class="muted">${esc(out.message || 'Nothing found for that.')}</p>`;
        return;
      }
      list.innerHTML = `<div class="check-list">${out.results.map((r) => `
        <button class="btn ghost" type="button" style="text-align:left"
          data-geopick="${esc(r.lat)},${esc(r.lng)}">
          ${esc(r.label)}<br><span class="muted">${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}</span>
        </button>`).join('')}</div>`;

      $$('[data-geopick]', list).forEach((b) => b.addEventListener('click', () => {
        const [lat, lng] = b.dataset.geopick.split(',');
        setCoords(lat, lng);
        list.innerHTML = `<p class="muted">Set to ${esc(lat)}, ${esc(lng)}. `
          + 'Check the map below: the circle should sit over the site with the '
          + 'whole of it inside.</p>';
      }));
    };

    findBtn.addEventListener('click', find);
    // Enter searches rather than submitting whatever form it lands in.
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); find(); }
    });
  }

  /*
   * The fence, drawn.
   *
   * "37.795500, −122.271200, 250 m" is not something anybody can check by
   * reading it. A digit in the wrong place puts the gate in the next county,
   * a radius meant for a yard swallows the town, and neither shows up until
   * a visitor is standing at the gate unable to sign in — which is the worst
   * possible moment to find out, and how this was found out.
   *
   * Drawn by hand rather than with a mapping library, which is less code
   * than it sounds: a tile is a 256-pixel square at a known place in a known
   * projection, so placing them is arithmetic. The alternative was a library
   * from a CDN, which the content security policy forbids and which would
   * have to be vendored and carried instead. Nothing here needs dragging or
   * animating; it needs to show one circle in the right place.
   */
  const mapBox = $('#site-map');
  if (mapBox) {
    const TILE = 256;
    /* Metres to a pixel at zoom 0 on the equator, for 256-pixel tiles. */
    const EQUATOR_MPP = 156543.03392;
    const frame = $('#site-map-frame');
    const tileLayer = $('#site-map-tiles');
    const overlay = $('#site-map-overlay');
    const scaleBar = $('#site-map-scale');
    const credit = $('#site-map-credit');
    const layerBar = $('#site-map-layers');
    const recentre = $('#site-map-recentre');
    const note = $('#site-map-note');

    /* How far the +/- buttons have moved off the zoom that fits the circle. */
    let nudge = 0;
    /*
     * Where the map is looking, which is not the same thing as where the site
     * is. Null means "at the site" — the state it starts in and returns to.
     * Dragging the map sets it, so somebody can look at the gate two streets
     * over without the pin springing back to the middle.
     */
    let view = null;
    /* Which basemap: the drawn one or the photograph. */
    let layer = 'map';
    /*
     * What layers can actually be had from here, asked once. An install with
     * no way out to the internet is a normal way to run this, and it should
     * not spend every redraw discovering that a dozen tiles at a time — nor
     * offer a Satellite button that could only ever show squared paper.
     */
    let layers = null;
    /* So a slow tile from an abandoned draw cannot report on the current one. */
    let generation = 0;
    /*
     * The last draw's projection, kept so a drag can turn pixels back into
     * coordinates. Reading it off the screen is the only way to answer "what
     * is under the finger", and it changes on every redraw.
     */
    let world = null;
    /* Set while the map itself is writing the coordinate fields — see below. */
    let fromMap = false;

    const setting = (path) => {
      const field = $(`[data-set="${path}"]`, root);
      const raw = field ? String(field.value).trim() : '';
      const n = Number(raw);
      return raw !== '' && Number.isFinite(n) ? n : NaN;
    };

    /** A round number of metres landing near a quarter of the frame. */
    const niceScale = (m) => {
      const steps = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000, 20000];
      for (let i = steps.length - 1; i >= 0; i--) if (steps[i] <= m) return steps[i];
      return steps[0];
    };

    const metres = (m) => (m >= 1000 ? `${(m / 1000).toFixed(m % 1000 ? 1 : 0)} km` : `${Math.round(m)} m`);

    /* ---- Web Mercator, both ways. Longitude is linear, latitude is not. ---- */

    const toWorld = (lat, lng, span) => {
      const latRad = lat * Math.PI / 180;
      return {
        x: ((lng + 180) / 360) * span * TILE,
        y: ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * span * TILE
      };
    };

    const fromWorld = (x, y, span) => {
      const n = Math.PI - (2 * Math.PI * y) / (span * TILE);
      return {
        lat: (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))),
        lng: (x / (span * TILE)) * 360 - 180
      };
    };

    /** Where a point on the frame is, in the world. */
    function pointAt(px, py) {
      if (!world) return null;
      return fromWorld(world.originX + px, world.originY + py, world.span);
    }

    function draw() {
      const lat = setting('geofence.lat');
      const lng = setting('geofence.lng');
      const radiusIn = setting('geofence.radius_m');
      const radius = Number.isFinite(radiusIn) && radiusIn > 0 ? radiusIn : 250;
      const on = !!($('[data-set="geofence.enabled"]', root) || {}).checked;

      /*
       * Zero is not a place. It is what an empty box used to become on the
       * way to the server, and it is in the Atlantic — so it is treated as
       * "not set yet" here exactly as the fence itself treats it, rather
       * than drawn as a site nobody has.
       */
      const placed = Number.isFinite(lat) && Number.isFinite(lng)
        && (lat !== 0 || lng !== 0) && Math.abs(lat) <= 85 && Math.abs(lng) <= 180;

      frame.hidden = !placed;
      if (!placed) {
        /*
         * Emptied, not just hidden. A cleared coordinate leaving the last
         * circle sitting in the markup is how a stale drawing comes back on
         * screen the moment something unhides the frame again.
         */
        tileLayer.innerHTML = '';
        overlay.innerHTML = '';
        scaleBar.innerHTML = '';
        world = null;
        note.textContent = 'Fill in the latitude and longitude — by address, by standing on the site, or by '
          + 'hand — and the fence is drawn here so you can see it land on the right place.';
        return;
      }

      const W = Math.max(240, Math.round(frame.clientWidth || 640));
      const H = Math.max(200, Math.round(frame.clientHeight || 320));

      /*
       * Zoom so the whole circle fits with room around it. Worked out from
       * the radius rather than fixed, because the same panel has to show a
       * 50 m yard and a 5 km quarry and be useful for both.
       *
       * Aim for the circle across four fifths of the shorter side. Tiles
       * only come at whole zoom levels and this rounds down to keep the
       * circle inside the frame, so what it actually lands on is somewhere
       * between two fifths and four fifths — which is a map with the fence
       * on it either way.
       */
      const atLat = EQUATOR_MPP * Math.cos(lat * Math.PI / 180);
      const want = (radius * 2) / (Math.min(W, H) * 0.8);    // metres a pixel must cover
      let z = Math.floor(Math.log2(atLat / want)) + nudge;
      z = Math.max(1, Math.min(19, z));
      const mpp = atLat / (2 ** z);

      const span = 2 ** z;
      const middle = view || { lat, lng };
      const eye = toWorld(middle.lat, middle.lng, span);
      const originX = eye.x - W / 2;
      const originY = eye.y - H / 2;
      const site = toWorld(lat, lng, span);
      const sx = site.x - originX;
      const sy = site.y - originY;

      world = { z, span, originX, originY, mpp, W, H, sx, sy };
      tileLayer.style.transform = '';
      overlay.style.transform = '';
      // A dark green line on a dark green yard is no line at all, so the
      // drawing is restyled over a photograph. See admin.css.
      frame.classList.toggle('satellite', layer === 'satellite' && available(layer));

      overlay.innerHTML = fenceSvg(W, H, sx, sy, radius, mpp);
      scaleBar.innerHTML = scaleSvg(W, H, mpp);

      /*
       * Offered only once the site has actually gone somewhere. A button
       * saying "back to the site" while the pin is in the middle of the
       * frame is a button that does nothing, which teaches people to ignore
       * the ones that do.
       */
      const adrift = sx < W * 0.25 || sx > W * 0.75 || sy < H * 0.25 || sy > H * 0.75;
      recentre.classList.toggle('hidden', !adrift);

      const mine = ++generation;
      let asked = 0;
      let failed = 0;

      tileLayer.innerHTML = '';
      /*
       * No basemap, so none is asked for. Twelve requests that cannot arrive
       * are twelve failures in the browser's console every time this panel
       * is opened, which buries the real ones.
       */
      if (!available(layer)) {
        paper(layers !== null, on, radius, lat, lng, z, nudge);
        return;
      }
      frame.classList.remove('no-tiles');
      for (let ty = Math.floor(originY / TILE); ty <= Math.floor((originY + H) / TILE); ty++) {
        // Above the pole and below it there is no map, so nothing is asked for.
        if (ty < 0 || ty >= span) continue;
        for (let tx = Math.floor(originX / TILE); tx <= Math.floor((originX + W) / TILE); tx++) {
          const col = ((tx % span) + span) % span;           // the world wraps at the date line
          const img = new Image();
          img.className = 'site-map-tile';
          img.alt = '';
          img.style.left = `${tx * TILE - originX}px`;
          img.style.top = `${ty * TILE - originY}px`;
          asked++;
          /*
           * A tile that fails after the probe said there was a basemap is
           * the exceptional case, and it still has to be legible: a circle
           * on grey nothing reads as a bug in the circle rather than as a
           * missing map.
           */
          img.addEventListener('error', () => {
            // Taken off the page rather than left to draw a torn-picture
            // icon in the middle of the map.
            img.remove();
            if (mine !== generation) return;
            failed++;
            if (failed === asked) paper(true, on, radius, lat, lng, z, nudge);
          });
          img.src = `/api/admin/tiles/${layer}/${z}/${col}/${ty}.png`;
          tileLayer.append(img);
        }
      }

      note.textContent = noteFor(on, radius, lat, lng, z, nudge);
    }

    /** Whether a named basemap can be had from this server. */
    const available = (id) => !!(layers && layers[id] && layers[id].ok);

    /** The circle and the pin — the part that belongs to the ground. */
    function fenceSvg(W, H, cx, cy, radius, mpp) {
      const ring = radius / mpp;
      overlay.setAttribute('viewBox', `0 0 ${W} ${H}`);
      return `
        <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${ring.toFixed(1)}" class="fence-ring"/>
        <line x1="${cx.toFixed(1)}" y1="${cy.toFixed(1)}" x2="${(cx + ring).toFixed(1)}" y2="${cy.toFixed(1)}"
          class="fence-radius"/>
        <text x="${(cx + ring / 2).toFixed(1)}" y="${(cy - 6).toFixed(1)}" class="fence-label"
          text-anchor="middle">${esc(metres(radius))}</text>
        <g class="fence-marker" id="fence-marker">
          <!--
            A finger is about nine millimetres across and the pin is nine
            pixels. This is the part that gets hold of: invisible, generous,
            and the reason dragging works on a tablet at all.
          -->
          <circle cx="${cx.toFixed(1)}" cy="${(cy - 10).toFixed(1)}" r="22" class="fence-grab"/>
          <path d="M ${cx.toFixed(1)} ${cy.toFixed(1)} L ${(cx - 7).toFixed(1)} ${(cy - 15).toFixed(1)}
            A 9 9 0 1 1 ${(cx + 7).toFixed(1)} ${(cy - 15).toFixed(1)} Z" class="fence-pin"/>
          <circle cx="${cx.toFixed(1)}" cy="${(cy - 21).toFixed(1)}" r="3.2" class="fence-pin-hole"/>
        </g>`;
    }

    /** The ruler, which belongs to the frame rather than to the ground. */
    function scaleSvg(W, H, mpp) {
      const barMetres = niceScale(W * mpp / 4);
      const barPx = barMetres / mpp;
      scaleBar.setAttribute('viewBox', `0 0 ${W} ${H}`);
      return `<g class="scale-bar">
          <line x1="14" y1="${H - 16}" x2="${(14 + barPx).toFixed(1)}" y2="${H - 16}"/>
          <line x1="14" y1="${H - 21}" x2="14" y2="${H - 11}"/>
          <line x1="${(14 + barPx).toFixed(1)}" y1="${H - 21}" x2="${(14 + barPx).toFixed(1)}" y2="${H - 11}"/>
          <text x="${(14 + barPx / 2).toFixed(1)}" y="${H - 22}" text-anchor="middle">${esc(metres(barMetres))}</text>
        </g>`;
    }

    /**
     * The fence on squared paper, for when there is no basemap to draw it on.
     *
     * @param {boolean} known  whether it has been established that there is
     *   no map to be had. Until that is settled this is just what the map
     *   looks like for the moment it takes to ask, and saying it failed then
     *   would be a lie that flashes up on every good install.
     */
    function paper(known, on, radius, lat, lng, z, off) {
      frame.classList.toggle('no-tiles', known);
      if (!known) { note.textContent = noteFor(on, radius, lat, lng, z, off); return; }
      note.innerHTML = `${esc(noteFor(on, radius, lat, lng, z, off))} `
        + `<b>The ${layer === 'satellite' ? 'satellite imagery' : 'map itself'} could not be loaded</b> — this `
        + 'server may have no way out to the internet, or the service may be down. The circle above is still '
        + 'drawn to scale, so it shows how big the fence is, just not where.';
    }

    function noteFor(on, radius, lat, lng, z, off) {
      const where = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      const zoomed = off ? ' Zoomed in or out by hand; the buttons only change the view, not the fence.' : '';
      return (on
        ? `A phone check-in is refused anywhere outside this circle — ${metres(radius)} from ${where}.`
        : `Drawn for reference. The fence is switched off, so phone check-ins are accepted from anywhere; `
          + `switch it on above and this circle — ${metres(radius)} from ${where} — is what would apply.`)
        + zoomed
        + ' Drag the pin to move the site, or drag the map to look around.';
    }

    /**
     * Writing the coordinates from the map.
     *
     * Six decimal places is about a tenth of a metre, which is finer than
     * anything this is for and stops the fields filling with the seventeen
     * digits a double happens to have.
     *
     * Goes through setSettingField so it saves exactly as a typed one does —
     * and sets a flag first, because the redraw those events trigger would
     * otherwise reset the zoom and snap the view back to the middle, which
     * on a drag means the ground moves out from under the pin as you drop it.
     */
    function placeSite(lat, lng) {
      fromMap = true;
      setSettingField('geofence.lat', lat.toFixed(6));
      setSettingField('geofence.lng', lng.toFixed(6));
      fromMap = false;
      draw();
    }

    /* ---------------------------------------------------------- dragging */

    /*
     * One set of pointer handlers for both gestures, because they are the
     * same gesture until it is known what was grabbed. Pointer events rather
     * than mouse or touch ones: this is set up on a laptop and used on the
     * tablet at the gate, and the tablet is the one that matters.
     */
    let drag = null;

    frame.addEventListener('pointerdown', (e) => {
      // The buttons on top of the map are buttons, not map.
      if (e.target.closest('button')) return;
      if (!world) return;
      const box = frame.getBoundingClientRect();
      drag = {
        id: e.pointerId,
        pin: !!e.target.closest('.fence-marker'),
        fromX: e.clientX, fromY: e.clientY,
        atX: e.clientX - box.left, atY: e.clientY - box.top,
        dx: 0, dy: 0, moved: false
      };
      frame.setPointerCapture(e.pointerId);
      frame.classList.add(drag.pin ? 'dragging-pin' : 'dragging-map');
      e.preventDefault();
    });

    frame.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag.dx = e.clientX - drag.fromX;
      drag.dy = e.clientY - drag.fromY;
      // A few pixels is a tap with a shaky hand, not a drag.
      if (Math.abs(drag.dx) > 3 || Math.abs(drag.dy) > 3) drag.moved = true;
      const shift = `translate(${drag.dx}px, ${drag.dy}px)`;
      if (drag.pin) {
        const marker = $('#fence-marker', overlay);
        if (marker) marker.setAttribute('transform', `translate(${drag.dx} ${drag.dy})`);
      } else {
        /*
         * Moved with a transform rather than redrawn. Rebuilding the tile
         * grid on every frame would ask the server for the same squares
         * sixty times a second and flicker while it did.
         */
        tileLayer.style.transform = shift;
        overlay.style.transform = shift;
      }
    });

    function endDrag(e) {
      if (!drag || e.pointerId !== drag.id) return;
      const done = drag;
      drag = null;
      frame.classList.remove('dragging-pin', 'dragging-map');
      try { frame.releasePointerCapture(done.id); } catch { /* already gone */ }
      if (!done.moved || !world) { draw(); return; }

      if (done.pin) {
        /*
         * The site moves to where it was dropped, and the view stays where
         * it is rather than recentring — the map jumping the moment you let
         * go is disorienting, and the pin is where you put it either way.
         */
        const at = pointAt(world.sx + done.dx, world.sy + done.dy);
        view = pointAt(world.W / 2, world.H / 2);
        if (at) placeSite(at.lat, at.lng);
        else draw();
      } else {
        view = fromWorld(world.originX - done.dx + world.W / 2,
          world.originY - done.dy + world.H / 2, world.span);
        draw();
      }
    }

    frame.addEventListener('pointerup', endDrag);
    frame.addEventListener('pointercancel', endDrag);

    recentre.addEventListener('click', () => { view = null; draw(); });

    /* ------------------------------------------------------------ layers */

    /** The Map / Satellite switch, built from what the server can actually get. */
    function drawLayerBar() {
      const usable = Object.entries(layers || {}).filter(([, l]) => l.ok);
      // One layer is not a choice, and a switch with nothing to switch to is
      // a control that can only disappoint.
      layerBar.classList.toggle('hidden', usable.length < 2);
      layerBar.innerHTML = usable.map(([id, l]) => `<button class="btn subtle${id === layer ? ' on' : ''}"
        type="button" data-maplayer="${esc(id)}">${esc(l.label || id)}</button>`).join('');
      $$('[data-maplayer]', layerBar).forEach((b) => b.addEventListener('click', () => {
        layer = b.dataset.maplayer;
        drawLayerBar();
        draw();
      }));
      credit.textContent = (layers && layers[layer] && layers[layer].credit) || '';
    }

    /*
     * Redrawn from the events the fields already fire, rather than from the
     * buttons that fill them. setSettingField dispatches 'input', so the
     * address picker and "Use where I am now" arrive here too, and there is
     * no third way of setting a coordinate that could be forgotten.
     */
    let pending = null;
    const redraw = () => { clearTimeout(pending); pending = setTimeout(draw, 150); };

    /*
     * Asked once, when the panel is wired rather than when a coordinate is
     * typed, so the answer is in by the time there is anything to draw.
     */
    api('/tiles/probe')
      .then((r) => { layers = (r && r.layers) || {}; })
      .catch(() => { layers = {}; })
      .then(() => {
        // Whichever is available, preferring the drawn map — it is the one
        // that answers "is this the right street".
        if (!available(layer)) layer = Object.keys(layers).find((id) => available(id)) || layer;
        drawLayerBar();
        draw();
      });

    root.addEventListener('input', (e) => {
      if (fromMap) return;      // the map's own writing; see placeSite
      if (e.target.matches && e.target.matches('[data-set^="geofence."]')) {
        // A coordinate typed, looked up or taken from a browser is a new
        // site, so the view goes back to it rather than staying where a
        // drag happened to leave it.
        nudge = 0;
        view = null;
        redraw();
      }
    });
    root.addEventListener('change', (e) => {
      if (e.target.matches && e.target.matches('[data-set="geofence.enabled"]')) redraw();
    });

    $$('[data-mapzoom]', mapBox).forEach((b) => b.addEventListener('click', () => {
      nudge = Math.max(-6, Math.min(6, nudge + Number(b.dataset.mapzoom)));
      draw();
    }));

    /*
     * Redrawn whenever the frame's width actually changes, which covers three
     * things at once: the window being resized, the settings panel being
     * opened for the first time, and the first layout after this runs. The
     * last one matters — the panel can still be off-screen when this wires
     * up, and a map laid out against a width of zero puts every tile in the
     * wrong place with nothing to say it did.
     */
    let drawnAt = -1;
    if (window.ResizeObserver) {
      new ResizeObserver(() => {
        const w = Math.round(frame.clientWidth);
        if (!w || w === drawnAt) return;
        drawnAt = w;
        redraw();
      }).observe(frame);
    } else {
      window.addEventListener('resize', redraw);
    }
    draw();
  }

  $('#backup-now').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = await api('/backups', { method: 'POST' });
      const copied = r.offsite
        ? (r.offsite.ok ? ', and copied to OneDrive' : ` — but it did not reach OneDrive: ${r.offsite.error}`)
        : '';
      toast(`Backup written — ${sizeOf(r.bytes)}${copied}`, r.offsite && !r.offsite.ok ? 8000 : 3000);
      await drawBackups();
    } catch (err) {
      toast((err.data && err.data.message) || 'Could not write a backup', 5000);
    } finally { btn.disabled = false; }
  });

  /*
   * Freeing room by hand. It deletes photos, so it asks first and says
   * exactly which ones — anything newer than the floor is never in reach,
   * however hard the button is pressed.
   */
  $('#shed-now').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const days = Number(getPath(SETTINGS, 'storage.shed_floor_days')) || 14;
    const down = Number(getPath(SETTINGS, 'storage.shed_to_percent')) || 75;
    if (!confirm(`Delete the oldest visitor photos until the disk is ${down}% full?\n\n`
      + `Photos from the last ${days} days are never touched. The visits themselves stay; `
      + 'only the photo on them goes, and it cannot be brought back.')) return;
    btn.disabled = true;
    try {
      const r = await api('/storage/shed', { method: 'POST', body: { force: true } });
      toast(r.photos
        ? `Freed ${sizeOf(r.freed)} — ${r.photos} photo${r.photos === 1 ? '' : 's'} dropped, `
          + `now ${r.percent_used}% full`
        : `Nothing to free — ${r.why || 'there is room'}.`, 5000);
      await drawBackups();
    } catch {
      toast('Could not free up room', 5000);
    } finally { btn.disabled = false; }
  });

  /*
   * The note as the kiosk would show it — including the one written for you
   * when the box is empty, which is otherwise invisible until you walk over
   * to the iPad.
   */
  async function drawPrivacyPreview() {
    const box = $('#privacy-preview');
    if (!box) return;
    try {
      const cfg = await fetch('/api/kiosk/config').then((r) => r.json());
      const note = cfg.privacy && cfg.privacy.notice;
      box.innerHTML = note
        ? `<p class="muted" style="margin-bottom:.25rem">On the kiosk, visitors see:</p>
           <div class="notice">${esc(note)}</div>`
        : '<p class="muted">No note is shown on the kiosk.</p>';
    } catch { box.innerHTML = ''; }
  }

  onSectionOpen('set-deleted', drawArchive);
  onSectionOpen('set-activity', drawAudit);
  onSectionOpen('set-board', drawBoard);
  $('#camera-test').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const box = $('#camera-result');
    const url = $('[data-set="board.camera_url"]').value.trim();
    if (!url) return toast('Enter a camera address first');
    btn.disabled = true;
    box.innerHTML = '<p class="muted">Asking the server to fetch it…</p>';
    try {
      const r = await api('/board/camera-test', { method: 'POST', body: { url } });
      box.innerHTML = `<div class="notice ${r.ok ? '' : 'error'}">${esc(r.message)}</div>`;
    } catch {
      box.innerHTML = '<div class="notice error">Could not run the test.</div>';
    } finally { btn.disabled = false; }
  });

  onSectionOpen('set-backups', drawBackups);
  onSectionOpen('set-retention', drawPrivacyPreview);

  /*
   * Custom wording, one visitor type at a time. Held here and sent whole on
   * save, so switching type in the picker does not lose unsaved edits.
   */
  const wording = JSON.parse(JSON.stringify(s.wording || {}));
  const WORDING_FIELDS = [['name', 'Full name'], ...DETAIL_FIELDS.filter(([f]) => f !== 'photo').map(([f, l]) => [f, l])];

  const drawWording = () => {
    const type = $('#wording-type').value;
    const forType = wording[type] || {};
    $('#wording-fields').innerHTML = WORDING_FIELDS.map(([field, standard]) => {
      const w = forType[field] || {};
      return `<div class="q-row">
        <div class="q-row-top">
          <input class="input" data-wlabel="${field}" placeholder="${esc(standard)}" value="${esc(w.label || '')}">
          <input class="input" data-wlabeles="${field}" placeholder="En español (optional)" value="${esc(w.label_es || '')}">
        </div>
        <input class="input" data-wdesc="${field}" style="margin-top:.5rem"
          placeholder="Help text shown under the field (optional)" value="${esc(w.description || '')}">
        <input class="input" data-wdesces="${field}" style="margin-top:.5rem"
          placeholder="Help text en español (optional)" value="${esc(w.description_es || '')}">
      </div>`;
    }).join('');

    const capture = () => {
      const current = $('#wording-type').value;
      wording[current] = wording[current] || {};
      WORDING_FIELDS.forEach(([field]) => {
        const label = $(`[data-wlabel="${field}"]`).value.trim();
        const description = $(`[data-wdesc="${field}"]`).value.trim();
        const label_es = $(`[data-wlabeles="${field}"]`).value.trim();
        const description_es = $(`[data-wdesces="${field}"]`).value.trim();
        if (label || description || label_es || description_es) {
          wording[current][field] = { label, description, ...(label_es ? { label_es } : {}), ...(description_es ? { description_es } : {}) };
        } else delete wording[current][field];
      });
    };
    // Edits are captured as they are typed, against the type being shown at the
    // time; switching type only redraws, or the new type would inherit them.
    $$('[data-wlabel], [data-wdesc], [data-wlabeles], [data-wdesces]').forEach((i) => i.addEventListener('input', () => {
      capture();
      saveSettings.soon();
    }));
    $('#wording-type').onchange = drawWording;
  };
  drawWording();
  VIEWS.settings.collectWording = () => wording;

  // Step order, one reorderable list per visitor type.
  const FLOW_LABELS = { details: 'Their details', photo: 'Photo', documents: 'Documents & questions', induction: 'Induction deck' };
  const flowState = {};
  detailTypes().forEach(([type]) => {
    const configured = (s.flow && s.flow[type]) || Object.keys(FLOW_LABELS);
    // Repair anything missing so a step can never quietly disappear.
    flowState[type] = [...new Set([...configured.filter((k) => FLOW_LABELS[k]), ...Object.keys(FLOW_LABELS)])];
  });

  /**
   * The flow as a strip you can rearrange by hand.
   *
   * Dragging is the quick way; the arrows on each step are the one that
   * works on the iPad this is often opened on, where HTML drag-and-drop
   * does nothing at all.
   */
  function drawStrip() {
    const strip = $('#flow-strip');
    if (!strip) return;
    const type = $('#flow-type').value;
    const steps = flowState[type];
    strip.innerHTML = `<div class="flow-end">Start</div>
      ${steps.map((step, i) => `<div class="flow-arrow">→</div>
        <div class="flow-chip" draggable="true" data-i="${i}">
          <span class="flow-n">${i + 1}</span>
          <span class="flow-label">${FLOW_LABELS[step]}</span>
          <span class="flow-moves">
            <button class="btn ghost" type="button" data-sleft="${i}" ${i === 0 ? 'disabled' : ''}
              title="Move earlier">◀</button>
            <button class="btn ghost" type="button" data-sright="${i}" ${i === steps.length - 1 ? 'disabled' : ''}
              title="Move later">▶</button>
          </span>
        </div>`).join('')}
      <div class="flow-arrow">→</div><div class="flow-end">Done</div>`;

    const swap = (from, to) => {
      if (to < 0 || to >= steps.length) return;
      [steps[from], steps[to]] = [steps[to], steps[from]];
      drawFlow();
    };
    $$('[data-sleft]', strip).forEach((b) => b.addEventListener('click', () => swap(Number(b.dataset.sleft), Number(b.dataset.sleft) - 1)));
    $$('[data-sright]', strip).forEach((b) => b.addEventListener('click', () => swap(Number(b.dataset.sright), Number(b.dataset.sright) + 1)));

    /*
     * The dragged chip is moved in the DOM as the pointer passes each other
     * chip, and the new order is read back only when the drag ends. Redrawing
     * mid-drag would destroy the element being dragged and cancel it.
     */
    let dragging = null;
    $$('.flow-chip', strip).forEach((chip) => {
      chip.addEventListener('dragstart', () => { dragging = chip; chip.classList.add('dragging'); });
      chip.addEventListener('dragend', () => {
        chip.classList.remove('dragging');
        dragging = null;
        const order = $$('.flow-chip', strip).map((c) => steps[Number(c.dataset.i)]);
        flowState[type] = order;
        drawFlow();
      });
    });
    // The chips are replaced on every redraw but the strip is not, so this
    // goes on once — otherwise a listener is added for every redraw.
    strip.ondragover = (e) => {
      if (!dragging) return;
      e.preventDefault();
      /*
       * The first step that reads as coming after the pointer. Comparing x
       * alone was wrong the moment the strip wrapped onto a second row —
       * every chip on the row below counted as being to the left.
       */
      const after = $$('.flow-chip:not(.dragging)', strip).find((el) => {
        const box = el.getBoundingClientRect();
        return e.clientY < box.top
          || (e.clientY <= box.bottom && e.clientX < box.left + box.width / 2);
      });
      if (after) strip.insertBefore(dragging, after);
      else strip.append(dragging);
    };
  }

  function drawFlow() {
    drawStrip();
    if (root.dataset.flowReady) saveSettings.soon();
    detailTypes().forEach(([type]) => {
      const list = $(`[data-flowtype="${type}"] .flow-list`);
      if (!list) return;
      list.innerHTML = flowState[type].map((step, i) => `<li>
        <span>${FLOW_LABELS[step]}</span>
        <span class="flow-moves">
          <button class="btn ghost" type="button" data-fup="${type}:${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn ghost" type="button" data-fdown="${type}:${i}" ${i === flowState[type].length - 1 ? 'disabled' : ''}>↓</button>
        </span></li>`).join('');
    });
    $$('[data-fup]').forEach((b) => b.addEventListener('click', () => {
      const [type, i] = b.dataset.fup.split(':'); const n = Number(i);
      const arr = flowState[type];
      [arr[n - 1], arr[n]] = [arr[n], arr[n - 1]];
      drawFlow();
    }));
    $$('[data-fdown]').forEach((b) => b.addEventListener('click', () => {
      const [type, i] = b.dataset.fdown.split(':'); const n = Number(i);
      const arr = flowState[type];
      [arr[n + 1], arr[n]] = [arr[n], arr[n + 1]];
      drawFlow();
    }));
  }
  drawFlow();
  $('#flow-type').addEventListener('change', drawStrip);
  root.dataset.flowReady = '1';
  VIEWS.settings.collectFlow = () => flowState;

  // One tap to switch a field off for every visitor type — turning the selfie
  // off everywhere should not mean four separate changes.
  $$('[data-rowoff]').forEach((b) => b.addEventListener('click', () => {
    const field = b.dataset.rowoff;
    detailTypes().forEach(([type]) => {
      const select = $(`[data-set="details.${type}.${field}"]`);
      if (select) select.value = 'off';
    });
    toast('Switched off for every type — remember to save');
  }));

  fillTimezones(s.org.timezone);

  $('#logo-file').addEventListener('change', async (e) => {
    if (!e.target.files[0]) return;
    await upload('/settings/logo', e.target.files[0]);
    setSettings(await api('/settings'));
    applyBranding();
    toast('Logo updated');
    render('settings');
  });

  // Keep the preview in step with the position, wording and dim controls.
  const preview = $('#bg-preview');
  const syncPreview = () => {
    preview.dataset.align = $('#wal').value;
    preview.dataset.valign = $('#wval').value;
    $('#pv-title').textContent = $('[data-set="org.welcome_title"]').value || 'Welcome';
    $('#pv-msg').textContent = $('[data-set="org.welcome_message"]').value || '';
  };
  ['#wal', '#wval', '[data-set="org.welcome_title"]', '[data-set="org.welcome_message"]']
    .forEach((sel) => $(sel).addEventListener('input', syncPreview));
  syncPreview();

  const bgFile = $('#bg-file');
  if (bgFile) bgFile.addEventListener('change', async (e) => {
    const chosen = [...e.target.files];
    if (!chosen.length) return;
    try {
      const fd = new FormData();
      chosen.forEach((f) => fd.append('file', f));
      const res = await fetch('/api/admin/settings/backgrounds', { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'failed');
      const notes = [`${data.added} photo${data.added === 1 ? '' : 's'} added`];
      if (data.rejected) notes.push(`${data.rejected} skipped — not an image`);
      if (data.skipped) notes.push(`${data.skipped} skipped — 20 photo limit`);
      setSettings(await api('/settings'));
      toast(notes.join(' · '), notes.length > 1 ? 6000 : 3000);
      render('settings');
    } catch { toast('Those files could not be used as backgrounds'); }
  });

  const bgRemove = $('#bg-remove');
  if (bgRemove) bgRemove.addEventListener('click', () => confirmAction(
    'Remove every background photo? The kiosk goes back to the plain gradient.',
    async () => {
      await api('/settings/backgrounds', { method: 'DELETE' });
      setSettings(await api('/settings'));
      toast('Backgrounds removed');
      render('settings');
    }));

  $$('[data-bgdel]').forEach((b) => b.addEventListener('click', async () => {
    await api(`/settings/backgrounds/${b.dataset.bgdel}`, { method: 'DELETE' });
    setSettings(await api('/settings'));
    toast('Photo removed');
    render('settings');
  }));

  const dim = $('#bg-dim');
  if (dim) dim.addEventListener('input', () => {
    $('#dim-value').textContent = dim.value;
    $('#bg-scrim').style.background = `rgba(8,18,14,${Number(dim.value) / 100})`;
  });
  if (dim) $('#bg-scrim').style.background = `rgba(8,18,14,${Number(dim.value) / 100})`;

  const logoRemove = $('#logo-remove');
  if (logoRemove) logoRemove.addEventListener('click', async () => {
    await api('/settings/logo', { method: 'DELETE' });
    setSettings(await api('/settings'));
    applyBranding();
    toast('Logo removed');
    render('settings');
  });

  // What was actually sent, so a test is not a black box.
  const drawNotifications = async () => {
    const box = $('#notify-log');
    if (!box) return; // the page has moved on
    const rows = await api('/notifications').catch(() => []);
    const status = (r) => {
      if (r.status === 'sending') return '<span class="pill wait">sending…</span>';
      if (r.status === 'sent') return '<span class="pill on">sent</span>';
      if (String(r.status).startsWith('skipped')) return `<span class="pill off">${esc(r.status.replace('skipped_', 'skipped: '))}</span>`;
      return `<span class="pill" style="background:#fdecea;color:var(--danger)">${esc(r.status)}</span>`;
    };
    const inFlight = rows.filter((r) => r.status === 'sending').length;
    const failed = rows.filter((r) => r.status === 'error' || String(r.status).startsWith('http_')).length;
    const sent = rows.filter((r) => r.status === 'sent').length;
    const summary = $('#notify-summary');
    if (summary) {
      summary.innerHTML = [
        inFlight ? `<span class="pill wait">${inFlight} sending now</span>` : '',
        `<span class="pill on">${sent} sent</span>`,
        failed ? `<span class="pill" style="background:#fdecea;color:var(--danger)">${failed} failed</span>` : ''
      ].filter(Boolean).join(' ');
    }
    box.innerHTML = rows.length ? `<table>
      <thead><tr><th>When</th><th>Channel</th><th>Sent to</th><th>About</th><th>Result</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td>${fmtDate(r.created_at)}</td>
        <td>${esc(r.channel)}</td>
        <td>${esc(r.target || '—')}</td>
        <td>${esc(r.visitor_name || r.subject || '—')}</td>
        <td>${status(r)}${r.error ? `<div class="muted">${esc(String(r.error).slice(0, 160))}</div>` : ''}</td>
      </tr>`).join('')}</tbody></table>`
      : '<p class="empty">Nothing has been sent yet. Press “Send test to the company channel” above to try the settings.</p>';

    // While something is mid-send, keep the list fresh so its row is watched
    // settling into sent or failed, rather than found stale later.
    if (inFlight && !drawNotifications._timer) {
      drawNotifications._timer = setTimeout(() => { drawNotifications._timer = null; drawNotifications(); }, 4000);
    }
  };
  drawNotifications();
  $('#notify-refresh').addEventListener('click', drawNotifications);

  /*
   * The test buttons test what is on screen, not what happened to be saved
   * last — pressing Test after typing a password but before Save was the
   * easiest way to a test that reported the old settings' failure.
   */
  async function saveNotifySettings() {
    const patch = {};
    $$('[data-set^="notify."]').forEach((input) => {
      const value = input.type === 'checkbox' ? input.checked
        : (input.type === 'number' || input.type === 'range') ? Number(input.value)
        : input.value;
      setPath(patch, input.dataset.set, value);
    });
    // Null when the designer has not loaded its catalogue yet; sending it
    // would clear the design rather than leave it alone.
    const designs = VIEWS.settings.collectCards && VIEWS.settings.collectCards();
    if (designs) {
      setPath(patch, 'notify.cards', designs);
      setPath(patch, 'notify.card', designs.signin);
    }
    if (VIEWS.settings.collectNotifyTypes) setPath(patch, 'notify.types_notified', VIEWS.settings.collectNotifyTypes());
    if (VIEWS.settings.collectRouting) setPath(patch, 'notify.type_routing', VIEWS.settings.collectRouting());
    if (VIEWS.settings.collectRequired) setPath(patch, 'compliance.required', VIEWS.settings.collectRequired());
    setSettings(await api('/settings', { method: 'PUT', body: patch }));
  }

  $('#test-hook').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const box = $('#email-result');
    const url = $('[data-set="notify.global_webhook_url"]').value.trim();
    if (!url) return toast('Paste the Teams channel link first');
    btn.disabled = true;
    box.innerHTML = '<p class="muted">Saving, then posting to the channel…</p>';
    try {
      // Test what is on screen, not whatever was saved last.
      await saveNotifySettings();
      // Whichever event's design is on screen — testing a sign-out card by
      // posting an arrival would tell you nothing about the one you edited.
      const editing = VIEWS.settings.collectCurrent && VIEWS.settings.collectCurrent();
      const r = await api('/settings/test-webhook', { method: 'POST', body: { url, ...(editing || {}) } });
      const photoNote = !r.photo_included
        ? ' No photo went with it — either the photo is switched off, or nobody on file has one yet.'
        : !r.public_url_reachable
          ? ' The photo will not load: Teams cannot reach the address it was told to fetch it from.'
          : ' The photo went with it — check it rendered.';
      box.innerHTML = r.ok
        ? `<div class="notice"><b>Posted.</b> It should be in the Teams channel now — from <b>Flow bot</b>, which is
           normal.${esc(photoNote)} Nobody was tagged: a test is not an arrival, so it never @-mentions a real
           colleague. Real arrivals tag the host.</div>`
        : `<div class="notice error"><b>Teams refused it.</b> ${esc(r.detail || '')}</div>`;
    } catch (err) {
      box.innerHTML = `<div class="notice error"><b>Could not post.</b> ${esc(err.message || 'The server did not answer.')}</div>`;
    } finally {
      btn.disabled = false;
      drawNotifications();
    }
  });
  const goBadges = $('#go-badges');
  if (goBadges) goBadges.addEventListener('click', () => {
    const btn = $('#nav button[data-view="badges"]');
    if (btn) btn.click();
  });

  $('#u-add').addEventListener('click', async () => {
    try {
      await api('/users', { method: 'POST', body: {
        name: $('#u-name').value, email: $('#u-email').value, password: $('#u-pass').value } });
      render('settings');
    } catch (err) {
      toast(err.data && err.data.error === 'weak_credentials' ? 'Password must be at least 8 characters' : 'Could not add that user');
    }
  });
  $$('[data-udel]').forEach((b) => b.addEventListener('click', async () => {
    await api(`/users/${b.dataset.udel}`, { method: 'DELETE' }); render('settings');
  }));

  $('#pw-save').addEventListener('click', async (e) => {
    // Captured now: currentTarget is null the moment this function awaits.
    const btn = e.currentTarget;
    const box = $('#pw-result');
    const [current, next, again] = ['#pw-current', '#pw-new', '#pw-again'].map((sel) => $(sel).value);
    // Caught here rather than by the server, so a typo does not spend one of
    // the ten attempts the rate limiter allows.
    if (next !== again) return box.innerHTML = '<div class="notice error">The two new passwords do not match.</div>';
    if (String(next).length < 8) return box.innerHTML = '<div class="notice error">Use at least 8 characters.</div>';
    btn.disabled = true;
    try {
      const r = await api('/me/password', { method: 'POST', body: { current, password: next } });
      box.innerHTML = `<div class="notice">${esc(r.message)}</div>`;
      ['#pw-current', '#pw-new', '#pw-again'].forEach((sel) => { $(sel).value = ''; });
    } catch (err) {
      box.innerHTML = `<div class="notice error">${esc((err.data && err.data.message) || 'Could not change the password.')}</div>`;
    } finally {
      btn.disabled = false;
    }
  });

  $$('[data-upw]').forEach((b) => b.addEventListener('click', async () => {
    const pass = prompt(`New password for ${b.dataset.uemail} — at least 8 characters.\n\n`
      + 'They will be signed out everywhere and will need this to sign back in.');
    if (pass === null) return;
    try {
      const r = await api(`/users/${b.dataset.upw}/password`, { method: 'POST', body: { password: pass } });
      toast(r.message, 6000);
    } catch (err) {
      toast((err.data && err.data.message) || 'Could not set that password', 5000);
    }
  }));
};

/**
 * Populate the time-zone picker from the browser's own IANA list, so an
 * unusable name like "New York" cannot be entered in the first place.
 */
function fillTimezones(current) {
  const select = $('#tz-select');
  if (!select) return;
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = []; }
  if (!zones.length) {
    zones = ['Europe/London', 'Europe/Dublin', 'America/New_York', 'America/Chicago', 'America/Denver',
      'America/Los_Angeles', 'America/Toronto', 'Australia/Sydney', 'UTC'];
  }
  const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (device && !zones.includes(device)) zones.unshift(device);

  const valid = zones.includes(current);
  select.innerHTML =
    (valid ? '' : `<option value="${esc(device || 'UTC')}" selected>${esc(device || 'UTC')} — this device</option>`) +
    zones.map((z) => `<option value="${esc(z)}" ${z === current ? 'selected' : ''}>${esc(z.replace(/_/g, ' '))}</option>`).join('');

  if (!valid) {
    const note = el(`<p class="notice error" style="margin-top:.5rem">Saved time zone ${current ? `“${esc(current)}”` : ''}
      is not a valid IANA name, so times fall back to UTC. Pick the right one below and save.</p>`);
    select.parentElement.appendChild(note);
  }
}

