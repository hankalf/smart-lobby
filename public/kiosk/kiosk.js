/* Smart Lobby — reception kiosk */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const show = (el, on = true) => el && el.classList.toggle('hidden', !on);

  const state = {
    cfg: null,
    lang: 'en',
    screen: 'idle',
    history: [],
    visitType: 'visitor',
    visitor: null,
    induction: { required: false, slideshow: null },
    agreement: null,
    agreements: [],
    agreementIndex: 0,
    signedDocs: [],
    photo: null,
    signature: null,
    deliveryPhoto: null,
    questions: [],
    answers: {},
    deckIndex: 0,
    deckStart: null,
    inductionDone: false,
    deckWatched: null,
    flow: [],
    flowIndex: -1,
    lastResult: null,
    deviceToken: localStorage.getItem('sl_device_token') || '',
    deviceId: null,
    device: null,
    configRev: null,
    configPending: false,
    appliedSections: undefined
  };

  /* ------------------------------------------------------------- helpers */

  /*
   * The site's clock rather than the tablet's. A kiosk left on the wrong zone —
   * or one shipped in from another office — would otherwise print a date on the
   * badge that does not match the day the visitor is standing there on. A zone
   * Intl cannot parse is checked once and then ignored, leaving the tablet's.
   */
  let zoneSeen = {};
  const siteZone = () => {
    const tz = (state.cfg && state.cfg.org && state.cfg.org.timezone) || undefined;
    if (!tz) return undefined;
    if (zoneSeen.tz !== tz) {
      try { new Intl.DateTimeFormat('en', { timeZone: tz }); zoneSeen = { tz, use: tz }; } catch { zoneSeen = { tz }; }
    }
    return zoneSeen.use;
  };

  /* ------------------------------------------------------------- language */

  /*
   * The kiosk's own wording, in Spanish. Anything an admin typed — documents,
   * questions, project names, the welcome lines — is not in this table: those
   * carry their own Spanish alongside the English, filled in on the dashboard,
   * and fall back to English when the box was left empty.
   */
  const STRINGS = {
    'Touch to start': 'Toque para comenzar',
    'How can we help?': '¿Cómo podemos ayudarle?',
    'Cancel': 'Cancelar',
    'What brings you here today?': '¿Qué le trae por aquí hoy?',
    'Back': 'Atrás',
    'Have you visited us before?': '¿Nos ha visitado antes?',
    'Continue': 'Continuar',
    "I'm new here": 'Soy nuevo aquí',
    'Your details': 'Sus datos',
    'Full name': 'Nombre completo',
    'Company': 'Empresa',
    'Phone number': 'Número de teléfono',
    'Mobile number': 'Número de celular',
    'Email': 'Correo electrónico',
    'Email address': 'Correo electrónico',
    'Which member of staff are you here to see?': '¿A qué miembro del personal viene a ver?',
    'Start typing a name…': 'Empiece a escribir un nombre…',
    'Reason for visit': 'Motivo de la visita',
    'Meeting, delivery, site works…': 'Reunión, entrega, obras…',
    'Vehicle registration': 'Placa del vehículo',
    'Load or order reference': 'Referencia de carga o pedido',
    'Order, docket or PO number': 'Número de pedido u orden de compra',
    'Pick-Up or Delivery': 'Recogida o entrega',
    'Project': 'Proyecto',
    '— choose a project —': '— elija un proyecto —',
    '— choose —': '— elegir —',
    'Pick-Up': 'Recogida',
    'Delivery': 'Entrega',
    'Both': 'Ambos',
    'Photo for your badge': 'Foto para su credencial',
    'Take photo': 'Tomar foto',
    'Retake': 'Repetir',
    'Looks good': 'Se ve bien',
    'Open camera': 'Abrir cámara',
    'Skip': 'Omitir',
    'Site rules': 'Reglas del sitio',
    'Please sign below': 'Firme a continuación, por favor',
    'Clear': 'Borrar',
    'I agree & continue': 'Acepto y continúo',
    'I agree — next document': 'Acepto — siguiente documento',
    'Next': 'Siguiente',
    'Finish': 'Terminar',
    'Nearly done': 'Casi listo',
    'Watch again': 'Ver de nuevo',
    'I confirm': 'Confirmo',
    'I confirm I have watched and understood the site induction.':
      'Confirmo que he visto y entendido la inducción del sitio.',
    "You're signed in": 'Ha registrado su entrada',
    'Signed out': 'Salida registrada',
    'Thanks for visiting.': 'Gracias por su visita.',
    'Print badge': 'Imprimir credencial',
    'Done': 'Listo',
    'Sign in': 'Registrar entrada',
    'Sign out': 'Registrar salida',
    'Visitors & contractors': 'Visitantes y contratistas',
    'Leaving site': 'Saliendo del sitio',
    'Interview': 'Entrevista',
    'Here to meet the hiring team': 'Viene a una entrevista',
    'Driver': 'Conductor',
    'Pick-up or delivery': 'Recogida o entrega',
    'Courier drop-off': 'Entrega de paquetería',
    'Request entry': 'Solicitar entrada',
    'Unlock the door': 'Abrir la puerta',
    'Contractor': 'Contratista',
    'Working on site': 'Trabaja en el sitio',
    'Visitor': 'Visitante',
    'Yes': 'Sí',
    'No': 'No',
    'Start typing…': 'Empiece a escribir…',
    '📷 Open the badge scanner': '📷 Abrir el escáner de credenciales',
    'Close the scanner': 'Cerrar el escáner',
    'Hold your badge up to the camera.': 'Acerque su credencial a la cámara.',
    'Delivery drop-off': 'Entrega de paquetes',
    'Your name': 'Su nombre',
    'Courier company': 'Empresa de mensajería',
    'Who is it for?': '¿Para quién es?',
    'Number of parcels': 'Número de paquetes',
    'Tracking number': 'Número de seguimiento',
    'Photo of parcel': 'Foto del paquete',
    'Log delivery': 'Registrar entrega',
    'Delivery logged': 'Entrega registrada',
    'The recipient has been notified. Thank you!': 'El destinatario ha sido avisado. ¡Gracias!',
    'Reception has been notified.': 'Recepción ha sido avisada.',
    'Please see reception.': 'Pase por recepción, por favor.',
    'Sorry, something went wrong. Please see reception.': 'Algo salió mal. Pase por recepción, por favor.',
    'Please enter your name.': 'Escriba su nombre, por favor.',
    'Please enter a contact number.': 'Escriba un número de contacto, por favor.',
    'Please enter an email address.': 'Escriba un correo electrónico, por favor.',
    'Please enter your company.': 'Escriba su empresa, por favor.',
    'Please choose who you are here to see.': 'Elija a quién viene a ver, por favor.',
    'Please enter your vehicle registration.': 'Escriba la placa de su vehículo, por favor.',
    'Please enter your load or order reference.': 'Escriba su referencia de carga o pedido, por favor.',
    'Please choose whether this is a pick-up or a delivery.': 'Indique si es una recogida o una entrega, por favor.',
    'Please choose your project.': 'Elija su proyecto, por favor.',
    'Please sign in the box to continue': 'Firme en el recuadro para continuar, por favor',
    'Door unlocked — please come in': 'Puerta abierta — adelante',
    'Could not unlock the door': 'No se pudo abrir la puerta',
    'Photo captured': 'Foto tomada',
    'Your badge is printing…': 'Su credencial se está imprimiendo…',
    'Tap “Print badge” to collect your badge.': 'Toque “Imprimir credencial” para recoger su credencial.',
    'Badge found': 'Credencial encontrada',
    "That's me": 'Soy yo',
    "I'm not on this list": 'No estoy en esta lista',
    'That number is used by more than one person — who are you?':
      'Ese número lo usan varias personas — ¿quién es usted?',
    'The scanner could not load. Please type your name instead.': 'El escáner no pudo cargarse. Escriba su nombre, por favor.',
    'Hold your badge up to the camera, or type your name below.': 'Acerque su credencial a la cámara, o escriba su nombre abajo.',
    'That is not a badge from this building.': 'Esa no es una credencial de este edificio.',
    'Please tell us who the delivery is for.': 'Indique para quién es la entrega, por favor.',
    'Could not log the delivery. Please see reception.': 'No se pudo registrar la entrega. Pase por recepción, por favor.',
    'Could not sign out — please see reception.': 'No se pudo registrar la salida — pase por recepción.',
    "Enter your {x} and we'll speed things up.": 'Escriba su {x} y agilizamos el proceso.',
    "Enter your {x} or your name and we'll speed things up.": 'Escriba su {x} o su nombre y agilizamos el proceso.',
    'First name, last name or {x}': 'Nombre, apellido o {x}',
    'Search for yourself by first name, last name or {x}, then tap your name.':
      'Búsquese por nombre, apellido o {x} y toque su nombre.',
    '{x} or name': '{x} o nombre',
    'name': 'nombre'
  };

  /** The kiosk's own wording in the language on screen; {x} fills a blank. */
  function t(text, vars) {
    let out = state.lang === 'es' ? (STRINGS[text] || text) : text;
    if (vars) for (const [k, v] of Object.entries(vars)) out = out.replace(`{${k}}`, v);
    return out;
  }

  /**
   * Admin-typed content: the Spanish column when it is filled in and Spanish is
   * on screen, the English otherwise. Never blank because a translation is
   * missing — an untranslated document still has to be readable.
   */
  function inLang(row, field) {
    if (!row) return '';
    const es = state.lang === 'es' ? row[`${field}_es`] : null;
    const value = es && String(es).trim() ? es : row[field];
    return value == null ? '' : value;
  }

  /*
   * The fixed wording in the page itself. Each element remembers the English it
   * shipped with the first time it is translated, so the toggle can go back
   * and forth without the words drifting.
   */
  const STATIC_TEXT = [
    '#start-btn',
    '[data-screen="menu"] .bar h2', '[data-screen="menu"] .bar button',
    '[data-screen="type"] .bar h2', '[data-screen="type"] .bar button',
    '#identify-title', '#identify-continue', '#identify-skip',
    '[data-screen="identify"] .bar button',
    '[data-screen="details"] .bar h2', '[data-screen="details"] .bar button',
    '[data-screen="photo"] .bar h2', '[data-screen="photo"] .bar button',
    '#btn-capture', '#btn-retake', '#btn-photo-continue', '#btn-photo-skip',
    '[data-screen="agreement"] .bar button', '.sig-label', '#sig-clear',
    '#deck-prev', '#deck-next',
    '[data-screen="ack"] h2', '#ack-replay', '#ack-confirm',
    '#btn-print-badge', '[data-screen="done"] [data-go="idle"]',
    '[data-screen="signout"] .bar h2', '[data-screen="signout"] .bar button',
    '#btn-scan', '#btn-scan-stop', '#scan-status',
    '[data-screen="delivery"] .bar h2', '[data-screen="delivery"] .bar button',
    '#d-capture', '#d-submit',
    '[data-screen="delivery"] .field span', '#f-movement option'
  ];
  const STATIC_PLACEHOLDER = ['#f-host-search', '#d-host-search', '#f-purpose', '#f-reference', '#signout-q'];

  function applyStaticLanguage() {
    for (const sel of STATIC_TEXT) {
      $$(sel).forEach((el) => {
        if (!el.dataset.en) {
          const text = el.textContent.trim();
          if (!text) return;
          el.dataset.en = text;
        }
        el.textContent = t(el.dataset.en);
      });
    }
    for (const sel of STATIC_PLACEHOLDER) {
      $$(sel).forEach((el) => {
        if (!el.dataset.enPh) el.dataset.enPh = el.placeholder;
        if (el.dataset.enPh) el.placeholder = t(el.dataset.enPh);
      });
    }
    const openCamera = ['#btn-photo-native', '#d-native'];
    for (const sel of openCamera) {
      const el = $(sel);
      if (!el) continue;
      // The label wraps a hidden input, so only the text node is replaced.
      const node = el.childNodes[0];
      if (node && node.nodeType === Node.TEXT_NODE) node.textContent = t('Open camera');
    }
  }

  /**
   * The two ways the language is offered: a bar naming both languages on the
   * home screens, where the choice is made before anything starts, and a corner
   * pill once a flow is underway, for anyone who realises partway through.
   */
  function updateLangControls() {
    const enabled = !!(state.cfg && state.cfg.kiosk.spanish_enabled);
    // No pill on the home screens (the bar names both languages there) and none
    // over the induction deck, whose Next button owns the same corner — the
    // language was chosen before the deck, and the slides are one deck anyway.
    const pillHidden = state.screen === 'idle' || state.screen === 'menu' || state.screen === 'induction';
    show($('#lang-toggle'), enabled && !pillHidden);
    // The pill offers the language you would switch to, in that language.
    $('#lang-toggle').textContent = state.lang === 'es' ? 'English' : 'Español';
    $$('.lang-bar').forEach((bar) => {
      show(bar, enabled);
      $$('button', bar).forEach((b) => b.classList.toggle('on', b.dataset.lang === state.lang));
    });
  }

  /** Switch the words on screen, leaving everything typed so far alone. */
  function setLanguage(lang) {
    state.lang = lang === 'es' ? 'es' : 'en';
    applyStaticLanguage();
    if (state.cfg) applyConfig();
    updateLangControls();
    if (state.screen === 'details') applyDetailFields();
    if (state.screen === 'agreement') showDocument(state.agreementIndex, { preserve: true });
    if (state.screen === 'done' && state.lastResult) showDone(state.lastResult);
  }

  $('#lang-toggle').addEventListener('click', () => setLanguage(state.lang === 'es' ? 'en' : 'es'));
  $$('.lang-bar button').forEach((b) => b.addEventListener('click', () => setLanguage(b.dataset.lang)));

  async function api(path, body, opts = {}) {
    const res = await fetch(`/api/kiosk${path}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      ...opts
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'request_failed'), { data, status: res.status });
    return data;
  }

  function toast(msg, ms = 2600) {
    const t = $('#toast');
    t.textContent = msg;
    show(t, true);
    clearTimeout(toast._t);
    toast._t = setTimeout(() => show(t, false), ms);
  }

  // The background photos stay up throughout, so tapping a card does not drop the
  // visitor onto a bare screen. The induction deck is the exception: it takes over
  // the whole screen and a photo behind it would only distract.
  const NO_BACKDROP = new Set(['induction']);
  function updateBackdrop() {
    $('#bg-stage').classList.toggle('visible',
      document.body.classList.contains('has-bg') && !NO_BACKDROP.has(state.screen));
  }

  function setScreen(name, { push = true } = {}) {
    const changed = state.screen !== name;
    if (push && changed) state.history.push(state.screen);
    state.screen = name;
    $$('.screen').forEach((s) => { s.hidden = s.dataset.screen !== name; });
    updateBackdrop();
    if (name !== 'photo' && name !== 'delivery') stopCamera();
    if (name !== 'signout' && scanStream) stopScanner();
    // The scanner opens with the screen, so a badge can simply be held up.
    if (name === 'signout' && state.cfg && state.cfg.kiosk.qr_signout_enabled && !scannerDismissed) startScanner();
    if (name === 'idle') resetVisit();
    updateLangControls();
    if (name === 'details') applyDetailFields();
    // Sizing the pad wipes any ink on it, so a re-render of the same screen —
    // a language switch mid-document — must leave it alone.
    if (name === 'agreement' && changed) sizeSignaturePad();
    resetIdleTimer();
    const focusable = document.querySelector(`.screen[data-screen="${name}"] input:not([type=hidden])`);
    if (focusable) setTimeout(() => focusable.focus(), 120);
  }

  /*
   * Where "back" and "cancel" lead. With the cards on the welcome screen the menu
   * screen is never used, and sending anyone there showed an empty page.
   */
  const homeScreen = () => (state.cfg && state.cfg.kiosk.welcome_shows_menu ? 'idle' : 'menu');

  function goBack() {
    let prev = state.history.pop();
    while (prev === 'menu' && homeScreen() === 'idle') prev = state.history.pop();
    setScreen(prev || homeScreen(), { push: false });
  }

  function resetVisit() {
    // The next person starts in the site's default language, not whichever one
    // the last visitor happened to leave the kiosk in.
    const defaultLang = state.cfg && state.cfg.kiosk.default_language === 'es' ? 'es' : 'en';
    if (state.lang !== defaultLang) setLanguage(defaultLang);
    state.history = [];
    state.visitor = null;
    state.agreements = [];
    state.agreementIndex = 0;
    state.signedDocs = [];
    state.answers = {};
    state.questions = [];
    state.photo = null;
    state.signature = null;
    state.deliveryPhoto = null;
    state.induction = { required: false, slideshow: null };
    state.lastResult = null;
    state.deckIndex = 0;
    state.inductionDone = false;
    state.deckWatched = null;
    // A countdown left ticking by an abandoned visit must not unlock anything
    // for the next person.
    clearInterval(renderSlide._t);
    state.flow = [];
    state.flowIndex = -1;
    scannerDismissed = false;
    ['#f-name', '#f-company', '#f-phone', '#f-email', '#f-host-search', '#f-host-id', '#f-purpose', '#f-vehicle',
     '#f-reference', '#f-movement', '#f-project', '#identify-value', '#signout-q', '#d-name', '#d-company',
     '#d-host-search', '#d-host-id', '#d-tracking'].forEach((s) => {
      const el = $(s); if (el) el.value = '';
    });
    $('#d-count').value = '1';
    show($('#identify-result'), false);
    show($('#details-error'), false);
    show($('#questions-error'), false);

    // Wipe the captured images themselves, not just their visibility: an
    // abandoned sign-in must never leave a face on screen for the next person.
    for (const sel of ['#shot', '#d-shot']) {
      const img = $(sel);
      if (img) { img.removeAttribute('src'); show(img, false); }
    }

    // Put the photo step back to its starting state, or the next visitor arrives
    // to "Retake" and "Looks good" left over from someone else's attempt.
    show($('#btn-capture'), true);
    show($('#btn-retake'), false);
    show($('#btn-photo-continue'), false);
    show($('#btn-photo-native'), false);
    show($('#btn-photo-skip'), true);
    show($('#cam-error'), false);

    $('#agreement-questions').innerHTML = '';
    $('#signout-results').innerHTML = '';
    clearSignature();
  }

  /* ------------------------------------------------------------ idle timer */

  let idleTimer = null;
  function resetIdleTimer() {
    clearTimeout(idleTimer);
    const secs = state.cfg ? Number(state.cfg.kiosk.idle_timeout_seconds) : 90;
    if (!secs || state.screen === 'idle' || state.screen === 'induction') return;
    const wait = state.screen === 'done' ? Number(state.cfg.kiosk.thank_you_seconds || 12) : secs;
    idleTimer = setTimeout(() => setScreen('idle'), wait * 1000);
  }
  ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, resetIdleTimer, { passive: true }));

  /* ------------------------------------------------------------ bootstrap */

  async function boot() {
    const urlToken = new URLSearchParams(location.search).get('token');
    if (urlToken) {
      localStorage.setItem('sl_device_token', urlToken);
      state.deviceToken = urlToken;
      history.replaceState({}, '', location.pathname);
    }
    try {
      /*
       * A registered device draws its card list from its first check-in. Waiting
       * for that answer alongside the config means the first paint already shows
       * this device's cards, instead of everyone's for a blink and then the
       * right ones. ping() never throws, so an offline check-in cannot stop the
       * kiosk — it just falls back to the full set, as before.
       */
      const [cfg] = await Promise.all([api('/config'), state.deviceToken ? ping() : Promise.resolve()]);
      state.cfg = cfg;
    } catch {
      toast('Cannot reach the lobby server — retrying…');
      return setTimeout(boot, 5000);
    }
    state.configRev = state.cfg.config_rev;
    state.lang = state.cfg.kiosk.default_language === 'es' ? 'es' : 'en';
    applyConfig();
    if (!state.deviceToken) ping();
    setInterval(ping, 20000); // also how quickly a dashboard change reaches the kiosk
    setInterval(refreshCount, 60000);
  }

  function applyConfig() {
    const { org, kiosk, deliveries, access } = state.cfg;
    document.documentElement.style.setProperty('--brand', org.primary_color || '#2f7d5d');
    document.documentElement.style.setProperty('--brand-dark', org.accent_color || '#123a2c');

    updateLangControls();
    applyStaticLanguage();
    $('#idle-title').textContent = inLang(org, 'welcome_title') || 'Welcome';
    $('#idle-message').textContent = inLang(org, 'welcome_message');
    $('#idle-org').textContent = org.name || '';
    if (org.logo_path) { $('#idle-logo').src = org.logo_path; show($('#idle-logo'), true); }

    // Optional photos behind the welcome screen, with a scrim so the text stays readable.
    const idle = document.querySelector('.idle');
    idle.dataset.align = org.welcome_align || 'center';
    idle.dataset.valign = org.welcome_valign || 'middle';
    show(document.querySelector('.idle-foot'), !!org.show_welcome_footer);
    document.documentElement.style.setProperty('--scrim', `rgba(8,18,14,${(Number(org.background_dim) || 0) / 100})`);
    startBackgrounds(org.backgrounds || [], Number(org.background_rotate_seconds) || 12);
    buildSections();
    document.title = `${org.name} — Reception`;

    show($('#w-tracking'), !!deliveries.ask_tracking);

    // Phone wording and the example shown follow the country set in Settings.
    const PHONE = {
      US: { label: 'Phone number', example: '(555) 123-4567' },
      CA: { label: 'Phone number', example: '(555) 123-4567' },
      GB: { label: 'Mobile number', example: '07700 900123' },
      IE: { label: 'Mobile number', example: '085 123 4567' },
      AU: { label: 'Mobile number', example: '0412 345 678' },
      NZ: { label: 'Mobile number', example: '021 123 4567' }
    };
    const phone = PHONE[(org.phone_country || 'US').toUpperCase()] || PHONE.US;
    const byEmail = kiosk.returning_lookup_field === 'email';

    const byName = !!kiosk.lookup_by_name;
    // The label the visitor is searched by, in the language on screen and in
    // lower case where it sits inside a sentence.
    const idLabel = t(byEmail ? 'Email address' : phone.label);
    $('#identify-label').textContent = byName ? t('{x} or name', { x: idLabel }) : idLabel;
    // A name needs a text keyboard, so only ask for the number pad when it is numbers only.
    $('#identify-value').type = byEmail || byName ? 'text' : 'tel';
    $('#identify-value').inputMode = byEmail || byName ? 'text' : 'tel';
    $('#identify-value').placeholder = byEmail ? 'you@company.com' : phone.example;
    $('#identify-lead').textContent = t(byName
      ? "Enter your {x} or your name and we'll speed things up."
      : "Enter your {x} and we'll speed things up.", { x: idLabel.toLowerCase() });
    $('#f-phone').placeholder = phone.example;
    $('#w-phone').querySelector('span').textContent = t(phone.label);
    $('#signout-q').placeholder = t('Start typing…');
    $('#signout-label').textContent = t('First name, last name or {x}', { x: t(phone.label).toLowerCase() });
    $('#signout-lead').textContent =
      t('Search for yourself by first name, last name or {x}, then tap your name.', { x: t(phone.label).toLowerCase() });
    // A custom acknowledgement uses its Spanish box; the stock line, the
    // dictionary — t() leaves any other custom English text untouched.
    $('#ack-text').textContent =
      t(inLang(state.cfg.induction, 'acknowledgement_text') || 'I confirm I have watched and understood the site induction.');

    const tiles = $('#type-tiles');
    tiles.innerHTML = pickerTypes().map((ty) =>
      `<button class="tile" data-type="${escapeHtml(ty.key)}"><span class="tile-icon">${escapeHtml(ty.icon || '👤')}</span>` +
      `<span>${escapeHtml(typeWord(ty, 'label'))}</span></button>`).join('');
    tiles.querySelectorAll('[data-type]').forEach((b) => b.addEventListener('click', () => {
      state.visitType = b.dataset.type;
      loadAgreement().then(() => setScreen('identify'));
    }));

    refreshCount();
    tickClock();
    // applyConfig runs again whenever settings change, so this must not stack up.
    clearInterval(clockTimer);
    clockTimer = setInterval(tickClock, 20000);
  }
  let clockTimer = null;

  /**
   * Welcome-screen backgrounds. One image is simply shown; several crossfade on a
   * timer using two stacked layers. Images are preloaded so a slow first paint
   * never shows a blank screen mid-rotation.
   */
  let bgTimer = null;
  function startBackgrounds(list, seconds) {
    const stage = $('#bg-stage');
    clearInterval(bgTimer);
    stage.querySelectorAll('.idle-bg').forEach((el) => el.remove());

    if (!list.length) { document.body.classList.remove('has-bg'); updateBackdrop(); return; }
    document.body.classList.add('has-bg');
    updateBackdrop();

    const layers = [0, 1].map(() => {
      const el = document.createElement('div');
      el.className = 'idle-bg';
      stage.prepend(el);
      return el;
    });

    list.forEach((src) => { const img = new Image(); img.src = src; });

    let index = 0;
    let front = 0;
    layers[front].style.backgroundImage = `url("${list[0]}")`;
    layers[front].classList.add('on');
    if (list.length < 2) return;

    bgTimer = setInterval(() => {
      // Nothing to see while the visitor is mid sign-in, so hold until they finish.
      if (state.screen !== 'idle') return;
      index = (index + 1) % list.length;
      const back = 1 - front;
      layers[back].style.backgroundImage = `url("${list[index]}")`;
      layers[back].classList.add('on');
      layers[front].classList.remove('on');
      front = back;
    }, Math.max(3, seconds) * 1000);
  }

  function tickClock() {
    const org = state.cfg ? state.cfg.org : {};
    if (!org.show_welcome_footer) return;
    try {
      $('#idle-clock').textContent = new Date().toLocaleString(org.date_format || 'en-GB',
        { weekday: 'long', hour: '2-digit', minute: '2-digit', timeZone: org.timezone || undefined });
    } catch { $('#idle-clock').textContent = new Date().toLocaleTimeString(); }
  }

  async function refreshCount() {
    if (!state.cfg || !state.cfg.kiosk.show_onsite_count) return;
    try {
      const cfg = await api('/config');
      $('#onsite-count').textContent = state.lang === 'es'
        ? `${cfg.onsite_count} personas en el sitio ahora mismo`
        : `${cfg.onsite_count} people currently on site`;
      show($('#onsite-count'), true);
    } catch { /* offline */ }
  }

  async function ping() {
    // Report the cameras this tablet has, so one can be picked in the dashboard.
    let cameras = [];
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      cameras = devices.filter((d) => d.kind === 'videoinput')
        .map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }));
    } catch { /* permission not granted yet, or no media API */ }

    try {
      const res = await fetch('/api/kiosk/ping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: state.deviceToken, version: '1.0.0', cameras })
      });
      const d = await res.json();
      state.deviceId = d.device_id;
      state.device = d.device_id ? d : null;

      // The cards are built before the first check-in, so the kiosk does not yet
      // know which device it is. Rebuild them once that answer arrives, and again
      // if the device's card list is changed in the dashboard.
      const sectionSig = JSON.stringify((state.device && state.device.sections) || null);
      if (sectionSig !== state.appliedSections) {
        state.appliedSections = sectionSig;
        if (state.cfg) buildSections();
      }

      // Something changed in the dashboard: pick it up without anyone walking
      // over to the tablet, but never mid sign-in.
      if (d.config_rev !== undefined && state.configRev !== null && d.config_rev !== state.configRev) {
        state.configPending = true;
      }
      if (state.configPending && state.screen === 'idle') await reloadConfig();
    } catch { /* offline; the kiosk keeps working */ }
  }

  async function reloadConfig() {
    try {
      state.cfg = await api('/config');
      state.configRev = state.cfg.config_rev;
      state.configPending = false;
      applyConfig();
    } catch { /* try again on the next check-in */ }
  }

  /* ---------------------------------------------------------------- menu */

  $$('[data-go]').forEach((b) => b.addEventListener('click', () => {
    // "menu" means the home screen, wherever the cards happen to live.
    setScreen(b.dataset.go === 'menu' ? homeScreen() : b.dataset.go);
  }));
  $$('[data-back]').forEach((b) => b.addEventListener('click', goBack));

  /** The sections offered on the home screen, one card each. */
  /** The types on offer, and how each is worded in the language on screen. */
  const allTypes = () => (state.cfg && state.cfg.types) || [];
  const pickerTypes = () => allTypes().filter((ty) => ty.mode === 'picker' || ty.mode === 'both');
  const cardTypes = () => allTypes().filter((ty) => ty.mode === 'card' || ty.mode === 'both');
  // A custom Spanish wording wins; the stock English labels go through the
  // dictionary so the built-in cards still translate.
  const typeWord = (ty, field) =>
    (state.lang === 'es' && (ty[`${field}_es`] || '').trim()) ? ty[`${field}_es`] : t(ty[field] || '');

  function sectionsHtml() {
    const { deliveries, access, kiosk } = state.cfg;
    const cards = [];

    // The general Sign in card only makes sense while some type is offered
    // behind it; a site running entirely on per-type cards drops it.
    if (pickerTypes().length) {
      cards.push(`<button class="tile" data-action="signin">
        <span class="tile-icon">👋</span><span>${t('Sign in')}</span><small>${t('Visitors & contractors')}</small></button>`);
    }
    cards.push(`<button class="tile" data-action="signout">
      <span class="tile-icon">🚪</span><span>${t('Sign out')}</span><small>${t('Leaving site')}</small></button>`);

    for (const ty of cardTypes()) {
      cards.push(`<button class="tile" data-action="${escapeHtml(ty.key)}">
        <span class="tile-icon">${escapeHtml(ty.icon || '👤')}</span><span>${escapeHtml(typeWord(ty, 'label'))}</span>${
        typeWord(ty, 'sub') ? `<small>${escapeHtml(typeWord(ty, 'sub'))}</small>` : ''}</button>`);
    }
    if (kiosk.show_delivery_button && deliveries.enabled) {
      cards.push(`<button class="tile" data-action="delivery">
        <span class="tile-icon">📦</span><span>${t('Delivery')}</span><small>${t('Courier drop-off')}</small></button>`);
    }
    if (access.enabled && access.unlock_button_on_kiosk && state.cfg.access_points.length) {
      cards.push(`<button class="tile" data-action="unlock">
        <span class="tile-icon">🔓</span><span>${t('Request entry')}</span><small>${t('Unlock the door')}</small></button>`);
    }
    return cards.join('');
  }

  function wireSections(container) {
    container.innerHTML = sectionsHtml();

    /*
     * A device can carry its own list of cards — which ones, and in what order.
     * A warehouse gate leads with Driver; reception leads with Sign in. Cards not
     * on the list are dropped, and anything on the list the site has switched off
     * simply is not there to place.
     */
    const only = state.device && state.device.sections;
    if (Array.isArray(only) && only.length) {
      const built = new Map($$('[data-action]', container).map((el) => [el.dataset.action, el]));
      container.innerHTML = '';
      only.forEach((key) => {
        const el = built.get(key);
        if (el) container.appendChild(el);
      });
    }
    $$('[data-action]', container).forEach((el) => el.addEventListener('click', (e) => {
      e.stopPropagation();
      runAction(el.dataset.action);
    }));
  }

  async function runAction(action) {
    // A card that goes straight into a sign-in as a particular type.
    const direct = allTypes().find((ty) => ty.key === action && (ty.mode === 'card' || ty.mode === 'both'));
    if (direct) {
      state.visitType = direct.key;
      await loadAgreement();
      state.induction = await api('/induction', { visit_type: direct.key }).catch(() => state.induction);
      return setScreen('identify');
    }
    if (action === 'signin') {
      const offered = pickerTypes();
      if (offered.length > 1) return setScreen('type');
      state.visitType = offered.length ? offered[0].key : 'visitor';
      await loadAgreement();
      return setScreen('identify');
    }
    if (action === 'signout') return setScreen('signout');
    if (action === 'delivery') { setScreen('delivery'); startCamera($('#d-cam')); return; }
    if (action === 'unlock') {
      try {
        await api('/unlock', { access_point_id: state.cfg.access_points[0].id });
        toast(t('Door unlocked — please come in'));
      } catch { toast(t('Could not unlock the door')); }
    }
  }

  /** The same sections, either straight on the welcome screen or behind "Touch to start". */
  function buildSections() {
    const inline = !!state.cfg.kiosk.welcome_shows_menu;
    show($('#start-btn'), !inline);
    show($('#welcome-actions'), inline);
    // Both containers are filled, so the menu is never an empty screen if
    // something does route there.
    wireSections($('#welcome-actions'));
    wireSections($('#menu-tiles'));
  }

  /* ------------------------------------------------------------ identify */

  async function loadAgreement() {
    try {
      state.agreements = await api(`/agreements/${encodeURIComponent(state.visitType)}`);
    } catch { state.agreements = []; }
    state.agreementIndex = 0;
    state.signedDocs = [];
    state.agreement = state.agreements[0] || null;
  }

  /** Letters mean they typed a name; digits mean a phone number. */
  const looksLikeName = (value) => /[a-z]/i.test(value.replace(/^\+/, ''));

  $('#identify-continue').addEventListener('click', async () => {
    const value = $('#identify-value').value.trim();
    if (!value) return startFlow();
    const isEmail = value.includes('@');

    // Name typed: offer the matches so they can pick themselves.
    if (!isEmail && looksLikeName(value) && state.cfg.kiosk.lookup_by_name) {
      const box = $('#identify-matches');
      const r = await api('/lookup', { name: value, visit_type: state.visitType }).catch(() => ({ matches: [] }));
      if (r.too_short) {
        box.innerHTML = `<p class="muted">${state.lang === 'es'
          ? 'Escriba al menos tres letras de su nombre.' : 'Type at least three letters of your name.'}</p>`;
        return;
      }
      if (!r.matches.length) {
        box.innerHTML = '';
        $('#f-name').value = value;
        return startFlow();
      }
      showIdentityChoices(r.matches, () => { $('#f-name').value = value; });
      return;
    }

    try {
      const r = await api('/lookup', {
        [isEmail ? 'email' : 'phone']: value,
        visit_type: state.visitType
      });
      // Several people share this number or address: ask who they are before
      // anything is prefilled, so nobody continues as somebody else.
      if (r.multiple && r.matches && r.matches.length) {
        showIdentityChoices(r.matches,
          () => { if (isEmail) $('#f-email').value = value; else $('#f-phone').value = value; },
          t('That number is used by more than one person — who are you?'));
        return;
      }
      state.induction = r.induction || { required: false, slideshow: null };
      if (r.found && r.visitor) {
        state.visitor = r.visitor;
        $('#f-name').value = r.visitor.full_name || '';
        $('#f-company').value = r.visitor.company || '';
        $('#f-phone').value = r.visitor.phone || '';
        $('#f-email').value = r.visitor.email || '';
        const note = $('#identify-result');
        note.textContent = r.already_onsite
          ? (state.lang === 'es'
            ? `Bienvenido de nuevo, ${r.visitor.full_name}. Según nuestros registros ya está dentro — continúe para registrarse de nuevo, o vuelva atrás y registre su salida.`
            : `Welcome back ${r.visitor.full_name}. Our records show you are already signed in — continue to sign in again, or go back and sign out.`)
          : (state.lang === 'es'
            ? `¡Bienvenido de nuevo, ${r.visitor.full_name}!${state.induction.required ? '' : ' No hace falta ver la inducción otra vez.'}`
            : `Welcome back, ${r.visitor.full_name}!${state.induction.required ? '' : ' No need to watch the induction again.'}`);
        note.classList.remove('hidden');
        setTimeout(() => startFlow(), 900);
      } else {
        if (isEmail) $('#f-email').value = value; else $('#f-phone').value = value;
        startFlow();
      }
    } catch (err) {
      if (err.status === 403) return toast(t('Please see reception.'));
      startFlow();
    }
  });

  /** They picked themselves from the name matches: fetch their details and carry on. */
  /**
   * A list of "That's me" choices, with a way out for someone who is none of
   * them. Used when a typed name matches several people, and when a phone
   * number turns out to be shared — `heading` says why they are being asked.
   */
  function showIdentityChoices(matches, onNotListed, heading) {
    const box = $('#identify-matches');
    box.innerHTML = (heading ? `<p class="lead">${escapeHtml(heading)}</p>` : '')
      + matches.map((m) => `<div class="result">
          <div class="result-photo initials">${escapeHtml(initials(m.full_name))}</div>
          <div class="result-who"><b>${escapeHtml(m.full_name)}</b>
            ${m.company ? `<span>${escapeHtml(m.company)}</span>` : ''}</div>
          <button class="btn" data-pick="${m.id}">${t("That's me")}</button>
        </div>`).join('')
      + `<div class="actions"><button class="btn ghost" id="not-listed">${t("I'm not on this list")}</button></div>`;

    $$('[data-pick]', box).forEach((b) => b.addEventListener('click', () => pickReturningVisitor(Number(b.dataset.pick))));
    $('#not-listed', box).addEventListener('click', () => {
      box.innerHTML = '';
      if (onNotListed) onNotListed();
      startFlow();
    });
  }

  async function pickReturningVisitor(visitorId) {
    try {
      const r = await api('/lookup', { visitor_id: visitorId, visit_type: state.visitType });
      $('#identify-matches').innerHTML = '';
      if (r.found && r.visitor) {
        state.visitor = r.visitor;
        state.induction = r.induction || state.induction;
        $('#f-name').value = r.visitor.full_name || '';
        $('#f-company').value = r.visitor.company || '';
        $('#f-phone').value = r.visitor.phone || '';
        $('#f-email').value = r.visitor.email || '';
      }
      startFlow();
    } catch (err) {
      if (err.status === 403) return toast(t('Please see reception.'));
      startFlow();
    }
  }

  $('#identify-skip').addEventListener('click', async () => {
    try { state.induction = await api('/induction', { visit_type: state.visitType }); } catch { /* ignore */ }
    startFlow();
  });

  /* -------------------------------------------------------- host picker */

  function attachHostPicker(inputSel, hiddenSel, listSel) {
    const input = $(inputSel), hidden = $(hiddenSel), list = $(listSel);
    let timer = null;
    input.addEventListener('input', () => {
      hidden.value = '';
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = input.value.trim();
        if (q.length < 1) { list.innerHTML = ''; return; }
        const hosts = await fetch(`/api/kiosk/staff?q=${encodeURIComponent(q)}`).then((r) => r.json()).catch(() => []);
        list.innerHTML = hosts.slice(0, 6).map((h) =>
          `<div data-id="${h.id}">${h.name}${h.department ? ` <span>${h.department}</span>` : ''}</div>`).join('');
        list.querySelectorAll('[data-id]').forEach((d) => d.addEventListener('click', () => {
          hidden.value = d.dataset.id;
          input.value = d.textContent.trim().split('\n')[0];
          list.innerHTML = '';
        }));
      }, 180);
    });
  }
  attachHostPicker('#f-host-search', '#f-host-id', '#host-suggest');
  attachHostPicker('#d-host-search', '#d-host-id', '#d-host-suggest');

  /**
   * "Your details" is configured per visitor type: each field is off, optional or
   * required, so an interview is not asked why they are here.
   */
  const DETAIL_WIDGETS = {
    company: '#w-company', phone: '#w-phone', email: '#w-email',
    staff: '#w-host', purpose: '#w-purpose', vehicle: '#w-vehicle',
    reference: '#w-reference', movement: '#w-movement', project: '#w-project'
  };

  function detailFields() {
    const all = (state.cfg && state.cfg.details) || {};
    return all[state.visitType] || all.visitor || {};
  }

  /** Custom wording in the language on screen: the Spanish box, else the English one. */
  function customWord(custom, field) {
    const es = state.lang === 'es' ? custom[`${field}_es`] : null;
    return ((es && String(es).trim()) || custom[field] || '').trim();
  }

  function applyDetailFields() {
    const fields = detailFields();
    const wording = ((state.cfg && state.cfg.wording) || {})[state.visitType] || {};

    for (const [field, sel] of Object.entries(DETAIL_WIDGETS)) {
      const wrap = $(sel);
      if (!wrap) continue;
      const mode = fields[field] || 'off';
      show(wrap, mode !== 'off');

      const custom = wording[field] || {};
      const label = wrap.querySelector('span');
      if (label) {
        // Remember the wording the page shipped with, so switching visitor type
        // does not leave another type's label behind.
        if (!label.dataset.base) label.dataset.base = label.textContent.replace(/\s*\*$/, '');
        const base = customWord(custom, 'label') || t(label.dataset.base);
        label.textContent = mode === 'required' ? `${base} *` : base;
      }

      let help = wrap.querySelector('.field-help');
      const text = customWord(custom, 'description');
      if (text && !help) {
        help = document.createElement('span');
        help.className = 'field-help';
        wrap.appendChild(help);
      }
      if (help) { help.textContent = text; show(help, !!text); }
    }

    // The projects on offer, named in the language on screen. The choice made
    // so far survives both a language switch and a re-render.
    const select = $('#f-project');
    const chosen = select.value;
    select.innerHTML = `<option value="">${t('— choose a project —')}</option>` +
      ((state.cfg && state.cfg.projects) || []).map((p) =>
        `<option value="${p.id}">${escapeHtml(inLang(p, 'name'))}${p.code ? ` (${escapeHtml(p.code)})` : ''}</option>`).join('');
    if (chosen) select.value = chosen;

    // The full name field is always asked, and can be worded too. It restores its
    // own default like the rest, or one type's wording would follow the next.
    const nameWrap = $('#w-name');
    const nameLabel = nameWrap && nameWrap.querySelector('span');
    if (nameLabel) {
      const custom = wording.name || {};
      if (!nameLabel.dataset.base) nameLabel.dataset.base = nameLabel.textContent.replace(/\s*\*$/, '');
      nameLabel.textContent = `${customWord(custom, 'label') || t(nameLabel.dataset.base)} *`;

      let help = nameWrap.querySelector('.field-help');
      const text = customWord(custom, 'description');
      if (text && !help) {
        help = document.createElement('span');
        help.className = 'field-help';
        nameWrap.appendChild(help);
      }
      if (help) { help.textContent = text; show(help, !!text); }
    }
  }

  /* --------------------------------------------------------------- details */

  $('#details-continue').addEventListener('click', async () => {
    const err = $('#details-error');
    const fields = detailFields();
    if (!$('#f-name').value.trim()) return fail(t('Please enter your name.'));
    if (fields.phone === 'required' && !$('#f-phone').value.trim()) return fail(t('Please enter a contact number.'));
    if (fields.email === 'required' && !$('#f-email').value.trim()) return fail(t('Please enter an email address.'));
    if (fields.company === 'required' && !$('#f-company').value.trim()) return fail(t('Please enter your company.'));
    if (fields.staff === 'required' && !$('#f-host-id').value) return fail(t('Please choose who you are here to see.'));
    if (fields.vehicle === 'required' && !$('#f-vehicle').value.trim()) return fail(t('Please enter your vehicle registration.'));
    if (fields.reference === 'required' && !$('#f-reference').value.trim()) return fail(t('Please enter your load or order reference.'));
    if (fields.movement === 'required' && !$('#f-movement').value) return fail(t('Please choose whether this is a pick-up or a delivery.'));
    if (fields.project === 'required' && !$('#f-project').value) return fail(t('Please choose your project.'));
    show(err, false);

    if (!state.visitor) {
      try {
        state.induction = await api('/induction', { visit_type: state.visitType });
      } catch { /* keep whatever we have */ }
    }
    nextStep();

    function fail(msg) { err.textContent = msg; show(err, true); }
  });

  /*
   * The sign-in steps run in the order configured for this visitor type, so a
   * contractor can watch the induction before signing anything. A step that does
   * not apply is skipped wherever it sits in the order.
   */
  function startFlow() {
    const configured = (state.cfg.flow && state.cfg.flow[state.visitType]) || ['details', 'photo', 'documents', 'induction'];
    state.flow = configured.slice();
    state.flowIndex = -1;
    nextStep();
  }

  function nextStep() {
    state.flowIndex += 1;
    const step = state.flow[state.flowIndex];
    if (!step) return submitSignIn();

    if (step === 'details') return setScreen('details');

    if (step === 'photo') {
      const photo = detailFields().photo || 'off';
      if (photo === 'off') return nextStep();
      // A required photo hides the skip, unless the camera could not open at all.
      show($('#btn-photo-skip'), photo !== 'required');
      setScreen('photo');
      return startCamera($('#cam'));
    }

    if (step === 'documents') {
      if (!state.agreements || !state.agreements.length) return nextStep();
      return showDocument(0);
    }

    if (step === 'induction') {
      const show_ = state.induction && state.induction.slideshow;
      const needed = state.induction && state.induction.required && show_ && show_.slides && show_.slides.length;
      if (!needed) return nextStep();
      return startDeck();
    }

    return nextStep();
  }

  /**
   * Show one document: its text, its questions, and a signature box.
   * `preserve` keeps the answers and signature already given — it re-renders the
   * words without punishing a language switch made halfway down the page.
   */
  function showDocument(index, { preserve = false } = {}) {
    state.agreementIndex = index;
    state.agreement = state.agreements[index];
    const many = state.agreements.length > 1;
    const title = inLang(state.agreement, 'name');
    $('#agreement-title').textContent = many
      ? `${title} (${index + 1} ${state.lang === 'es' ? 'de' : 'of'} ${state.agreements.length})`
      : title;
    // A questionnaire may have no text to read at all.
    $('#agreement-body').textContent = inLang(state.agreement, 'body');
    show($('#agreement-body'), !!inLang(state.agreement, 'body').trim());
    // A questionnaire is a document that only asks questions — no signature box.
    const needsSignature = state.agreement.require_signature !== 0;
    show($('.sig-label'), needsSignature);
    show($('.sig-wrap'), needsSignature);
    show($('#sig-clear'), needsSignature);
    const last = index === state.agreements.length - 1;
    $('#agreement-continue').textContent = t(needsSignature
      ? (last ? 'I agree & continue' : 'I agree — next document')
      : (last ? 'Continue' : 'Next'));
    renderQuestions({ preserve });
    if (!preserve) clearSignature();
    setScreen('agreement');
  }

  /** Declaration questions attached to the document, answered before signing. */
  function renderQuestions({ preserve = false } = {}) {
    const box = $('#agreement-questions');
    const kept = preserve ? state.answers : {};
    state.answers = {};
    let questions = [];
    try { questions = JSON.parse(state.agreement.questions || '[]'); } catch { questions = []; }
    state.questions = questions;
    show($('#questions-error'), false);

    box.innerHTML = questions.map((q, i) => {
      const id = q.id || `q${i + 1}`;
      const qLabel = (state.lang === 'es' && (q.label_es || '').trim()) ? q.label_es : q.label;
      const qHelp = (state.lang === 'es' && (q.description_es || '').trim()) ? q.description_es : q.description;
      const label = `<span class="q-label">${escapeHtml(qLabel)}${q.required ? ' <span class="req">*</span>' : ''}`
        + `${qHelp ? `<span class="q-help">${escapeHtml(qHelp)}</span>` : ''}</span>`;
      // Choices show their translation but always carry the English value, so
      // the stored answers read the same however the question was answered.
      const choices = q.type === 'choice' ? (q.options || []) : ['Yes', 'No'];
      const shown = q.type === 'choice'
        ? (state.lang === 'es' && Array.isArray(q.options_es) && q.options_es.length === choices.length
          ? q.options_es : choices)
        : choices.map((c) => t(c));
      const body = q.type === 'text'
        ? `<input class="input" data-q="${id}" autocomplete="off">`
        : `<div class="q-choices" data-qgroup="${id}">
             ${choices.map((c, ci) =>
               `<button type="button" data-q="${id}" data-value="${escapeHtml(c)}" aria-pressed="false">${escapeHtml(shown[ci] || c)}</button>`).join('')}
           </div>`;
      return `<div class="question" data-question="${id}">${label}${body}</div>`;
    }).join('');

    // Answers carried through a re-render: values back into text boxes, and the
    // pressed state back onto the chosen buttons.
    for (const [id, value] of Object.entries(kept)) {
      const input = box.querySelector(`input[data-q="${CSS.escape(id)}"]`);
      if (input) { input.value = value; state.answers[id] = value; continue; }
      const btn = box.querySelector(`[data-qgroup="${CSS.escape(id)}"] button[data-value="${CSS.escape(value)}"]`);
      if (btn) { btn.setAttribute('aria-pressed', 'true'); state.answers[id] = value; }
    }

    $$('[data-qgroup] button', box).forEach((b) => b.addEventListener('click', () => {
      const group = b.closest('[data-qgroup]');
      $$('button', group).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      state.answers[b.dataset.q] = b.dataset.value;
      applyQuestionConditions();
    }));
    $$('input[data-q]', box).forEach((input) => input.addEventListener('input', () => {
      state.answers[input.dataset.q] = input.value.trim();
      applyQuestionConditions();
    }));

    applyQuestionConditions();
  }

  /**
   * Questions that depend on an earlier answer. A hidden one is not asked, not
   * required, and its answer is dropped — so changing your mind higher up cannot
   * leave a stale answer to a question nobody was shown.
   */
  function questionVisible(q) {
    if (!q.show_if || !q.show_if.id) return true;
    const parent = (state.questions || []).find((x) => x.id === q.show_if.id);
    if (parent && !questionVisible(parent)) return false;
    return state.answers[q.show_if.id] === q.show_if.value;
  }

  function applyQuestionConditions() {
    (state.questions || []).forEach((q, i) => {
      const id = q.id || `q${i + 1}`;
      const el = document.querySelector(`[data-question="${id}"]`);
      if (!el) return;
      const visible = questionVisible(q);
      show(el, visible);
      if (!visible && state.answers[id] !== undefined) {
        delete state.answers[id];
        const input = el.querySelector('input[data-q]');
        if (input) input.value = '';
        $$('button[data-q]', el).forEach((b) => b.setAttribute('aria-pressed', 'false'));
      }
    });
  }

  const escapeHtml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /* ---------------------------------------------------------------- camera */

  /**
   * Which camera to open. "front"/"rear" map to facingMode; anything else is
   * treated as a specific camera id chosen for this device in the dashboard.
   */
  function cameraConstraint() {
    const choice = (state.device && state.device.default_camera) || 'front';
    const base = { width: { ideal: 1280 } };
    if (choice === 'front') return { ...base, facingMode: 'user' };
    if (choice === 'rear') return { ...base, facingMode: 'environment' };
    return { ...base, deviceId: { ideal: choice } };
  }

  /**
   * Why the camera did not open, in words reception can act on. A kiosk app that
   * never forwards the permission request looks exactly like a refusal, which is
   * the most common cause on a locked-down tablet.
   */
  function cameraProblem(err) {
    const name = (err && err.name) || '';
    if (!window.isSecureContext) return 'The camera needs an https:// address.';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'The camera was blocked. If this tablet runs a kiosk app, allow the camera for that app in '
        + 'iOS Settings — some kiosk apps never ask.';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found on this device.';
    if (name === 'NotReadableError') return 'The camera is already in use by another app.';
    return 'The camera could not be opened.';
  }

  /**
   * Start a video element and wait until it actually has a picture. Safari needs
   * play() called explicitly, and reports zero dimensions until the first frame,
   * which is what everything downstream measures.
   */
  async function playVideo(videoEl) {
    videoEl.setAttribute('playsinline', '');
    videoEl.muted = true;
    try { await videoEl.play(); } catch { /* some browsers resolve without it */ }
    if (videoEl.videoWidth) return;
    await new Promise((resolve) => {
      const done = () => { videoEl.removeEventListener('loadedmetadata', done); resolve(); };
      videoEl.addEventListener('loadedmetadata', done);
      setTimeout(done, 3000);
    });
  }

  let stream = null;
  async function startCamera(videoEl) {
    stopCamera();
    show($('#cam-error'), false);
    show($('#btn-photo-native'), false);
    show($('#d-native'), false);
    show($('#btn-capture'), true);
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: cameraConstraint(), audio: false });
      videoEl.srcObject = stream;
      // iOS will not start the stream from the attribute alone, and a paused
      // video has no dimensions, so a captured frame would come out blank.
      await playVideo(videoEl);
    } catch (e) {
      // Live preview is unavailable. Fall back to the device's own camera app,
      // which works even where a kiosk app refuses the in-page camera.
      $('#cam-error').textContent = `${cameraProblem(e)} Tap “Open camera” to use the camera app instead.`;
      show($('#cam-error'), true);
      show($('#btn-photo-native'), true);
      show($('#d-native'), true);
      show($('#btn-capture'), false);
    }
  }

  /** Read a file from the native camera picker and downscale it to a square. */
  function fileToSquareDataUrl(file, size = 600) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('read_failed'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('decode_failed'));
        img.onload = () => {
          const canvas = $('#cam-canvas');
          canvas.width = size;
          canvas.height = size;
          const side = Math.min(img.width, img.height);
          canvas.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
          resolve(canvas.toDataURL('image/jpeg', 0.82));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  $('#photo-native-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      state.photo = await fileToSquareDataUrl(file);
      $('#shot').src = state.photo;
      show($('#shot'), true);
      show($('#cam-error'), false);
      show($('#btn-photo-native'), false);
      show($('#btn-photo-continue'), true);
      show($('#btn-photo-skip'), false);
    } catch { toast('Could not read that photo'); }
    e.target.value = '';
  });

  $('#d-native-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      state.deliveryPhoto = await fileToSquareDataUrl(file, 800);
      $('#d-shot').src = state.deliveryPhoto;
      show($('#d-shot'), true);
      toast(t('Photo captured'));
    } catch { toast('Could not read that photo'); }
    e.target.value = '';
  });

  function stopCamera() {
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  }

  function grabFrame(videoEl) {
    const canvas = $('#cam-canvas');
    const w = videoEl.videoWidth || 640;
    const h = videoEl.videoHeight || 480;
    const size = Math.min(w, h);
    canvas.width = 600; canvas.height = 600;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(videoEl, (w - size) / 2, (h - size) / 2, size, size, 0, 0, 600, 600);
    return canvas.toDataURL('image/jpeg', 0.82);
  }

  $('#btn-capture').addEventListener('click', () => {
    if (!stream) return nextStep();
    state.photo = grabFrame($('#cam'));
    $('#shot').src = state.photo;
    show($('#shot'), true);
    show($('#btn-capture'), false);
    show($('#btn-retake'), true);
    show($('#btn-photo-continue'), true);
    show($('#btn-photo-skip'), false);
    stopCamera();
  });

  $('#btn-retake').addEventListener('click', () => {
    state.photo = null;
    show($('#shot'), false);
    show($('#btn-capture'), true);
    show($('#btn-retake'), false);
    show($('#btn-photo-continue'), false);
    show($('#btn-photo-skip'), true);
    startCamera($('#cam'));
  });

  $('#btn-photo-continue').addEventListener('click', () => { stopCamera(); nextStep(); });
  $('#btn-photo-skip').addEventListener('click', () => { state.photo = null; stopCamera(); nextStep(); });

  /* ------------------------------------------------------------- signature */

  const pad = $('#sig-pad');
  let drawing = false, hasInk = false, padCtx = null;

  function sizeSignaturePad() {
    const rect = pad.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    pad.width = Math.max(1, rect.width * dpr);
    pad.height = Math.max(1, rect.height * dpr);
    padCtx = pad.getContext('2d');
    padCtx.scale(dpr, dpr);
    padCtx.lineWidth = 2.4;
    padCtx.lineCap = 'round';
    padCtx.lineJoin = 'round';
    padCtx.strokeStyle = '#12211b';
    hasInk = false;
  }

  function clearSignature() {
    if (padCtx) padCtx.clearRect(0, 0, pad.width, pad.height);
    hasInk = false;
    state.signature = null;
  }

  function padPoint(e) {
    const r = pad.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  pad.addEventListener('pointerdown', (e) => {
    if (!padCtx) sizeSignaturePad();
    drawing = true; hasInk = true;
    pad.setPointerCapture(e.pointerId);
    const p = padPoint(e);
    padCtx.beginPath();
    padCtx.moveTo(p.x, p.y);
  });
  pad.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = padPoint(e);
    padCtx.lineTo(p.x, p.y);
    padCtx.stroke();
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) =>
    pad.addEventListener(ev, () => { drawing = false; }));
  window.addEventListener('resize', () => { if (state.screen === 'agreement') sizeSignaturePad(); });

  $('#sig-clear').addEventListener('click', clearSignature);

  $('#agreement-continue').addEventListener('click', () => {
    const missing = (state.questions || []).filter((q, i) => {
      const id = q.id || `q${i + 1}`;
      // A question they were never shown cannot be required of them.
      return q.required && questionVisible(q) && !String(state.answers[id] || '').trim();
    });
    const err = $('#questions-error');
    if (missing.length) {
      err.textContent = missing.length === 1
        ? `Please answer: ${missing[0].label}`
        : `Please answer all ${missing.length} required questions.`;
      show(err, true);
      err.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    show(err, false);
    const needsSignature = state.agreement.require_signature !== 0;
    if (needsSignature && !hasInk) return toast(t('Please sign in the box to continue'));

    state.signedDocs.push({
      agreement_id: state.agreement.id,
      signature: needsSignature ? pad.toDataURL('image/png') : null,
      answers: Object.keys(state.answers).length ? state.answers : null
    });

    const next = state.agreementIndex + 1;
    if (next < state.agreements.length) return showDocument(next);
    nextStep();
  });

  /* ------------------------------------------------------------------ deck */

  function startDeck() {
    state.deckIndex = 0;
    state.deckStart = new Date().toISOString();
    // Which slides have already been sat through, so going back to re-read one
    // does not lock every slide again on the way forward.
    state.deckWatched = new Set();
    renderSlide();
    setScreen('induction');
  }

  function renderSlide() {
    const show_ = state.induction.slideshow;
    const slides = show_.slides;
    const slide = slides[state.deckIndex];
    const stage = $('#deck-stage');
    if (!slide) return;
    if (slide.kind === 'image') stage.innerHTML = `<img src="${slide.image_path}" alt="">`;
    else if (slide.kind === 'pdf') stage.innerHTML = `<iframe src="${slide.image_path}#toolbar=0"></iframe>`;
    else stage.innerHTML = slide.html || '';
    $('#deck-count').textContent = `${state.deckIndex + 1} ${state.lang === 'es' ? 'de' : 'of'} ${slides.length}`;
    $('#deck-progress-fill').style.width = `${((state.deckIndex + 1) / slides.length) * 100}%`;
    $('#deck-prev').disabled = state.deckIndex === 0;

    /*
     * The deck's "minimum seconds per slide" is what stops the whole induction
     * being clicked through unread: Next counts down and only then unlocks.
     * A slide already sat through stays unlocked, so going back to re-read an
     * earlier one is free rather than a penalty.
     */
    const minSecs = Number(show_.min_seconds_per_slide || 0);
    const next = $('#deck-next');
    const nextLabel = () => t(state.deckIndex === slides.length - 1 ? 'Finish' : 'Next');
    const slideKey = slide.id != null ? slide.id : state.deckIndex;
    clearInterval(renderSlide._t);
    if (minSecs > 0 && !(state.deckWatched && state.deckWatched.has(slideKey))) {
      next.disabled = true;
      let left = minSecs;
      next.textContent = `${left}s`;
      renderSlide._t = setInterval(() => {
        left -= 1;
        if (left <= 0) {
          clearInterval(renderSlide._t);
          if (state.deckWatched) state.deckWatched.add(slideKey);
          next.disabled = false;
          next.textContent = nextLabel();
        } else next.textContent = `${left}s`;
      }, 1000);
    } else {
      next.disabled = false;
      next.textContent = nextLabel();
    }
  }

  $('#deck-next').addEventListener('click', () => {
    const slides = state.induction.slideshow.slides;
    if (state.deckIndex < slides.length - 1) { state.deckIndex += 1; return renderSlide(); }
    clearInterval(renderSlide._t);
    if (state.cfg.induction.require_acknowledgement) setScreen('ack');
    else { state.inductionDone = true; nextStep(); }
  });

  $('#deck-prev').addEventListener('click', () => {
    if (state.deckIndex > 0) { state.deckIndex -= 1; renderSlide(); }
  });

  $('#ack-replay').addEventListener('click', () => { state.deckIndex = 0; renderSlide(); setScreen('induction'); });
  $('#ack-confirm').addEventListener('click', () => { state.inductionDone = true; nextStep(); });

  /* --------------------------------------------------------------- sign in */

  async function submitSignIn() {
    const inductionDone = state.inductionDone;
    const payload = {
      visitor_id: state.visitor ? state.visitor.id : null,
      // Who they said they are, when they picked themselves from a list — the
      // server must not re-guess it from a phone number others share.
      visitor_id: state.visitor ? state.visitor.id : null,
      full_name: $('#f-name').value.trim(),
      company: $('#f-company').value.trim(),
      phone: $('#f-phone').value.trim(),
      email: $('#f-email').value.trim(),
      host_id: $('#f-host-id').value || null,
      visit_type: state.visitType,
      purpose: $('#f-purpose').value.trim(),
      vehicle_reg: $('#f-vehicle').value.trim().toUpperCase(),
      reference: $('#f-reference').value.trim(),
      movement: $('#f-movement').value,
      project_id: $('#f-project').value || null,
      language: state.lang,
      photo: state.photo,
      documents: state.signedDocs,
      device_id: state.deviceId,
      induction_completed: inductionDone,
      slideshow_id: inductionDone && state.induction.slideshow ? state.induction.slideshow.id : null,
      induction_started_at: state.deckStart,
      induction_seconds: state.deckStart ? Math.round((Date.now() - new Date(state.deckStart).getTime()) / 1000) : null
    };
    try {
      const result = await api('/signin', payload);
      state.lastResult = result;
      showDone(result);
    } catch (err) {
      toast(err.data && err.data.message ? err.data.message : t('Sorry, something went wrong. Please see reception.'));
    }
  }

  function showDone(result) {
    const org = state.cfg.org;
    $('#done-title').textContent = state.lang === 'es'
      ? `Ha registrado su entrada, ${result.visit.full_name.split(' ')[0]}`
      : `You're signed in, ${result.visit.full_name.split(' ')[0]}`;
    $('#done-sub').textContent = result.visit.host_name
      ? (state.lang === 'es'
        ? `${result.visit.host_name} ha sido avisado y le atenderá en breve.`
        : `${result.visit.host_name} has been notified and will be with you shortly.`)
      : t('Reception has been notified.');
    // The code and its QR belong on the badge, not on screen — nobody can use a
    // code they only saw for a few seconds.
    $('#done-code').textContent = '';
    $('#done-qr').innerHTML = '';

    // Badges are on for the account, but a kiosk with no printer attached opts out.
    const deviceCanPrint = !state.device || state.device.print_enabled;
    const badge = deviceCanPrint ? result.badge : null;
    show($('#btn-print-badge'), !!badge);
    if (badge) {
      buildBadge(result, badge, org);
      const note = $('#done-badge-note');
      note.textContent = t(badge.auto_print ? 'Your badge is printing…' : 'Tap “Print badge” to collect your badge.');
      show(note, true);
      if (badge.auto_print) setTimeout(() => window.print(), 700);
    } else {
      show($('#done-badge-note'), false);
    }
    setScreen('done');
  }

  function buildBadge(result, badge, org) {
    const root = document.documentElement;
    const landscape = badge.orientation === 'landscape';
    root.style.setProperty('--badge-w', `${badge.label_width_mm}mm`);
    root.style.setProperty('--badge-h', `${badge.label_height_mm}mm`);
    // A horizontal badge is turned onto a label that keeps its own size.
    root.style.setProperty('--card-w', `${landscape ? badge.label_height_mm : badge.label_width_mm}mm`);
    root.style.setProperty('--card-h', `${landscape ? badge.label_width_mm : badge.label_height_mm}mm`);
    root.style.setProperty('--card-turn', landscape
      ? `translateX(${badge.label_width_mm}mm) rotate(90deg)` : 'none');
    root.style.setProperty('--badge-scale', badge.font_scale || 1);

    $('#badge-type').textContent = badge.title_text || result.visit.visit_type.toUpperCase();
    $('#badge-name').textContent = result.visit.full_name;
    $('#badge-company').textContent = badge.show_company ? (result.visit.company || '') : '';
    show($('#badge-company'), !!(badge.show_company && result.visit.company));

    const meta = [];
    if (badge.show_host && result.visit.host_name) meta.push(`Visiting: ${result.visit.host_name}`);
    const tz = siteZone();
    if (badge.show_date) meta.push(new Date(result.visit.signed_in_at).toLocaleDateString(org.date_format || 'en-GB', { timeZone: tz }));
    if (badge.show_time) meta.push(new Date(result.visit.signed_in_at).toLocaleTimeString(org.date_format || 'en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz }));
    if (badge.show_badge_no && badge.badge_no) meta.push(badge.badge_no);
    $('#badge-meta').innerHTML = meta.join('<br>');

    const photo = $('#badge-photo');
    if (badge.show_photo && state.photo) { photo.src = state.photo; show(photo, true); } else show(photo, false);

    const logo = $('#badge-logo');
    if (badge.show_logo && org.logo_path) { logo.src = org.logo_path; show(logo, true); } else show(logo, false);

    $('#badge-qr').innerHTML = badge.show_qr
      ? `<img src="/api/qr?text=${encodeURIComponent(result.checkout_code)}" alt="">` : '';
    $('#badge-foot').textContent = badge.footer_text || '';
  }

  $('#btn-print-badge').addEventListener('click', () => window.print());

  /* -------------------------------------------------------------- sign out */

  let signoutTimer = null;
  const initials = (name) => String(name || '').split(/\s+/).filter(Boolean).slice(0, 2)
    .map((w) => w[0].toUpperCase()).join('');

  $('#signout-q').addEventListener('input', () => {
    clearTimeout(signoutTimer);
    signoutTimer = setTimeout(async () => {
      const q = $('#signout-q').value.trim();
      // Matches appear from the first letter typed.
      if (!q) return ($('#signout-results').innerHTML = '');
      const isCode = /^[0-9A-F]{8}$/i.test(q);
      const rows = await api('/signout/search', isCode ? { code: q } : { q }).catch(() => []);
      $('#signout-results').innerHTML = rows.length
        ? rows.map((r) => `<div class="result">
            ${r.photo_url
              ? `<img class="result-photo" src="${escapeHtml(r.photo_url)}" alt="">`
              : `<div class="result-photo initials">${escapeHtml(initials(r.full_name))}</div>`}
            <div class="result-who"><b>${escapeHtml(r.full_name)}</b>
            <span>${r.company ? escapeHtml(r.company) + ' · ' : ''}in since ${new Date(r.signed_in_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: siteZone() })}${r.host_name ? ' · ' + escapeHtml(r.host_name) : ''}</span></div>
            <button class="btn" data-signout="${r.id}">Sign out</button></div>`).join('')
        : '<p class="muted">No matching visitor is signed in.</p>';
      $$('#signout-results [data-signout]').forEach((b) => b.addEventListener('click', async () => {
        const res = await api('/signout', { visit_id: Number(b.dataset.signout) }).catch(() => null);
        if (!res) return toast(t('Could not sign out — please see reception.'));
        $('#done-title').textContent = t('Signed out');
        $('#done-sub').textContent = inLang(state.cfg.org, 'goodbye_message') || res.goodbye || t('Thanks for visiting.');
        $('#done-code').textContent = '';
        $('#done-qr').innerHTML = '';
        show($('#btn-print-badge'), false);
        show($('#done-badge-note'), false);
        setScreen('done');
      }));
    }, 140);
  });

  /* --------------------------------------------------------- badge scanner */

  /*
   * Scanning the QR code on a printed badge to sign out. Chrome has a native
   * BarcodeDetector; iPad Safari and the WKWebView kiosk apps do not, so jsQR is
   * bundled — and only fetched when somebody actually opens the scanner.
   */
  let scanStream = null;
  let scanTimer = null;
  let detector = null;
  let jsQrLoading = null;
  let scannerDismissed = false;

  function loadJsQr() {
    if (window.jsQR) return Promise.resolve(window.jsQR);
    if (jsQrLoading) return jsQrLoading;
    jsQrLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'vendor/jsQR.js';
      script.onload = () => resolve(window.jsQR);
      script.onerror = () => reject(new Error('jsqr_failed'));
      document.head.appendChild(script);
    });
    return jsQrLoading;
  }

  async function startScanner() {
    const status = $('#scan-status');
    show($('#scan-panel'), true);
    show($('#scan-row'), false);
    status.textContent = 'Starting the camera…';

    try {
      if ('BarcodeDetector' in window && !detector) {
        detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      }
      if (!detector) await loadJsQr();
    } catch {
      status.textContent = t('The scanner could not load. Please type your name instead.');
      return;
    }

    try {
      scanStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 } }, audio: false
      });
      $('#scan-cam').srcObject = scanStream;
      await playVideo($('#scan-cam'));
      status.textContent = t('Hold your badge up to the camera, or type your name below.');
      scanTimer = setInterval(scanFrame, 180);
    } catch (err) {
      // No camera here: fold the scanner away and leave the search, with the
      // button available in case a second tap is what it takes.
      show($('#scan-panel'), false);
      show($('#scan-row'), true);
      toast(`${cameraProblem(err)} Search for your name instead.`, 6000);
    }
  }

  function stopScanner() {
    clearInterval(scanTimer);
    scanTimer = null;
    if (scanStream) { scanStream.getTracks().forEach((t) => t.stop()); scanStream = null; }
    show($('#scan-panel'), false);
    show($('#scan-row'), !!(state.cfg && state.cfg.kiosk.qr_signout_enabled));
  }

  async function scanFrame() {
    const video = $('#scan-cam');
    if (!video.videoWidth) return;
    const canvas = $('#scan-canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    let text = null;
    try {
      if (detector) {
        const found = await detector.detect(canvas);
        if (found.length) text = found[0].rawValue;
      } else if (window.jsQR) {
        const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const found = window.jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
        if (found) text = found.data;
      }
    } catch { /* keep trying on the next frame */ }

    if (!text) return;
    const code = String(text).trim().toUpperCase();
    if (!/^[0-9A-F]{8}$/.test(code)) {
      $('#scan-status').textContent = t('That is not a badge from this building.');
      return;
    }

    stopScanner();
    // Hand the code to the ordinary search, so the visitor still sees their own
    // name and photo before anything happens.
    const input = $('#signout-q');
    input.value = code;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    toast(t('Badge found'));
  }

  $('#btn-scan').addEventListener('click', startScanner);
  $('#btn-scan-stop').addEventListener('click', () => { scannerDismissed = true; stopScanner(); });

  /* -------------------------------------------------------------- delivery */

  $('#d-capture').addEventListener('click', () => {
    if (!stream) return $('#d-native-input').click();
    state.deliveryPhoto = grabFrame($('#d-cam'));
    $('#d-shot').src = state.deliveryPhoto;
    show($('#d-shot'), true);
    toast(t('Photo captured'));
  });

  $('#d-submit').addEventListener('click', async () => {
    const err = $('#d-error');
    const cfg = state.cfg.deliveries;
    if (cfg.require_recipient && !$('#d-host-id').value && !$('#d-host-search').value.trim()) {
      err.textContent = t('Please tell us who the delivery is for.');
      return show(err, true);
    }
    show(err, false);
    try {
      await api('/delivery', {
        courier_name: $('#d-name').value.trim(),
        courier_company: $('#d-company').value.trim(),
        recipient_host_id: $('#d-host-id').value || null,
        recipient_text: $('#d-host-id').value ? null : $('#d-host-search').value.trim(),
        tracking: $('#d-tracking').value.trim(),
        parcel_count: Number($('#d-count').value) || 1,
        photo: state.deliveryPhoto
      });
      stopCamera();
      $('#done-title').textContent = t('Delivery logged');
      $('#done-sub').textContent = t('The recipient has been notified. Thank you!');
      $('#done-code').textContent = '';
      $('#done-qr').innerHTML = '';
      show($('#btn-print-badge'), false);
      show($('#done-badge-note'), false);
      setScreen('done');
    } catch (e) {
      err.textContent = t('Could not log the delivery. Please see reception.');
      show(err, true);
    }
  });

  /* ------------------------------------------------------------------ init */

  boot();
})();
