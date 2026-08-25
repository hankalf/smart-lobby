/* Smart Lobby — reception kiosk */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const show = (el, on = true) => el && el.classList.toggle('hidden', !on);

  const state = {
    cfg: null,
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
    lastResult: null,
    deviceToken: localStorage.getItem('sl_device_token') || '',
    deviceId: null,
    device: null
  };

  /* ------------------------------------------------------------- helpers */

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
    if (push && state.screen !== name) state.history.push(state.screen);
    state.screen = name;
    $$('.screen').forEach((s) => { s.hidden = s.dataset.screen !== name; });
    updateBackdrop();
    if (name !== 'photo' && name !== 'delivery') stopCamera();
    if (name === 'idle') resetVisit();
    if (name === 'details') applyDetailFields();
    if (name === 'agreement') sizeSignaturePad();
    resetIdleTimer();
    const focusable = document.querySelector(`.screen[data-screen="${name}"] input:not([type=hidden])`);
    if (focusable) setTimeout(() => focusable.focus(), 120);
  }

  function goBack() {
    const prev = state.history.pop() || 'menu';
    setScreen(prev, { push: false });
  }

  function resetVisit() {
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
    ['#f-name', '#f-company', '#f-phone', '#f-email', '#f-host-search', '#f-host-id', '#f-purpose', '#f-vehicle',
     '#identify-value', '#signout-q', '#d-name', '#d-company', '#d-host-search', '#d-host-id', '#d-tracking'].forEach((s) => {
      const el = $(s); if (el) el.value = '';
    });
    $('#d-count').value = '1';
    show($('#identify-result'), false);
    show($('#details-error'), false);
    show($('#shot'), false);
    show($('#d-shot'), false);
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
      state.cfg = await api('/config');
    } catch {
      toast('Cannot reach the lobby server — retrying…');
      return setTimeout(boot, 5000);
    }
    applyConfig();
    ping();
    setInterval(ping, 60000);
    setInterval(refreshCount, 60000);
  }

  function applyConfig() {
    const { org, kiosk, deliveries, access } = state.cfg;
    document.documentElement.style.setProperty('--brand', org.primary_color || '#2f7d5d');
    document.documentElement.style.setProperty('--brand-dark', org.accent_color || '#123a2c');
    $('#idle-title').textContent = org.welcome_title || 'Welcome';
    $('#idle-message').textContent = org.welcome_message || '';
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

    $('#identify-label').textContent = byEmail ? 'Email address' : phone.label;
    $('#identify-value').type = byEmail ? 'email' : 'tel';
    $('#identify-value').placeholder = byEmail ? 'you@company.com' : phone.example;
    $('#identify-lead').textContent = byEmail
      ? "Enter your email address and we'll speed things up."
      : `Enter your ${phone.label.toLowerCase()} and we'll speed things up.`;
    $('#f-phone').placeholder = phone.example;
    $('#w-phone').querySelector('span').textContent = phone.label;
    $('#signout-q').placeholder = 'Start typing…';
    $('#signout-label').textContent = `First name, last name or ${phone.label.toLowerCase()}`;
    $('#signout-lead').textContent =
      `Search for yourself by first name, last name or ${phone.label.toLowerCase()}, then tap your name.`;
    $('#ack-text').textContent = state.cfg.induction.acknowledgement_text || 'I confirm I have watched the induction.';

    const tiles = $('#type-tiles');
    const labels = { visitor: ['👤', 'Visitor'], contractor: ['🦺', 'Contractor'], interview: ['💼', 'Interview'],
      delivery: ['📦', 'Delivery'], staff: ['🪪', 'Staff'] };
    tiles.innerHTML = (kiosk.visit_types || ['visitor']).map((t) => {
      const [icon, label] = labels[t] || ['👤', t];
      return `<button class="tile" data-type="${t}"><span class="tile-icon">${icon}</span><span>${label}</span></button>`;
    }).join('');
    tiles.querySelectorAll('[data-type]').forEach((b) => b.addEventListener('click', () => {
      state.visitType = b.dataset.type;
      loadAgreement().then(() => setScreen('identify'));
    }));

    refreshCount();
    tickClock();
    setInterval(tickClock, 20000);
  }

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
      $('#onsite-count').textContent = `${cfg.onsite_count} people currently on site`;
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
    } catch { /* offline; the kiosk keeps working */ }
  }

  /* ---------------------------------------------------------------- menu */

  $$('[data-go]').forEach((b) => b.addEventListener('click', () => setScreen(b.dataset.go)));
  $$('[data-back]').forEach((b) => b.addEventListener('click', goBack));

  /** The sections offered on the home screen, one card each. */
  function sectionsHtml() {
    const { kiosk, deliveries, access } = state.cfg;
    const cards = [
      `<button class="tile" data-action="signin">
        <span class="tile-icon">👋</span><span>Sign in</span><small>Visitors &amp; contractors</small></button>`,
      `<button class="tile" data-action="signout">
        <span class="tile-icon">🚪</span><span>Sign out</span><small>Leaving site</small></button>`
    ];

    if (kiosk.show_interview_button) {
      cards.push(`<button class="tile" data-action="interview">
        <span class="tile-icon">💼</span><span>Interview</span><small>Here to meet the hiring team</small></button>`);
    }
    if (kiosk.show_delivery_button && deliveries.enabled) {
      cards.push(`<button class="tile" data-action="delivery">
        <span class="tile-icon">📦</span><span>Delivery</span><small>Courier drop-off</small></button>`);
    }
    if (access.enabled && access.unlock_button_on_kiosk && state.cfg.access_points.length) {
      cards.push(`<button class="tile" data-action="unlock">
        <span class="tile-icon">🔓</span><span>Request entry</span><small>Unlock the door</small></button>`);
    }
    return cards.join('');
  }

  function wireSections(container) {
    container.innerHTML = sectionsHtml();
    $$('[data-action]', container).forEach((el) => el.addEventListener('click', (e) => {
      e.stopPropagation();
      runAction(el.dataset.action);
    }));
  }

  async function runAction(action) {
    if (action === 'interview') {
      state.visitType = 'interview';
      await loadAgreement();
      state.induction = await api('/induction', { visit_type: 'interview' }).catch(() => state.induction);
      return setScreen('identify');
    }
    if (action === 'signin') {
      const types = state.cfg.kiosk.visit_types || ['visitor'];
      if (types.length > 1) return setScreen('type');
      state.visitType = types[0];
      await loadAgreement();
      return setScreen('identify');
    }
    if (action === 'signout') return setScreen('signout');
    if (action === 'delivery') { setScreen('delivery'); startCamera($('#d-cam')); return; }
    if (action === 'unlock') {
      try {
        await api('/unlock', { access_point_id: state.cfg.access_points[0].id });
        toast('Door unlocked — please come in');
      } catch { toast('Could not unlock the door'); }
    }
  }

  /** The same sections, either straight on the welcome screen or behind "Touch to start". */
  function buildSections() {
    const inline = !!state.cfg.kiosk.welcome_shows_menu;
    show($('#start-btn'), !inline);
    show($('#welcome-actions'), inline);
    wireSections(inline ? $('#welcome-actions') : $('#menu-tiles'));
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

  $('#identify-continue').addEventListener('click', async () => {
    const value = $('#identify-value').value.trim();
    if (!value) return setScreen('details');
    const isEmail = value.includes('@');
    try {
      const r = await api('/lookup', {
        [isEmail ? 'email' : 'phone']: value,
        visit_type: state.visitType
      });
      state.induction = r.induction || { required: false, slideshow: null };
      if (r.found && r.visitor) {
        state.visitor = r.visitor;
        $('#f-name').value = r.visitor.full_name || '';
        $('#f-company').value = r.visitor.company || '';
        $('#f-phone').value = r.visitor.phone || '';
        $('#f-email').value = r.visitor.email || '';
        const note = $('#identify-result');
        note.textContent = r.already_onsite
          ? `Welcome back ${r.visitor.full_name}. Our records show you are already signed in — continue to sign in again, or go back and sign out.`
          : `Welcome back, ${r.visitor.full_name}!${state.induction.required ? '' : ' No need to watch the induction again.'}`;
        note.classList.remove('hidden');
        setTimeout(() => setScreen('details'), 900);
      } else {
        if (isEmail) $('#f-email').value = value; else $('#f-phone').value = value;
        setScreen('details');
      }
    } catch (err) {
      if (err.status === 403) return toast('Please see reception.');
      setScreen('details');
    }
  });

  $('#identify-skip').addEventListener('click', async () => {
    try { state.induction = await api('/induction', { visit_type: state.visitType }); } catch { /* ignore */ }
    setScreen('details');
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
    staff: '#w-host', purpose: '#w-purpose', vehicle: '#w-vehicle'
  };

  function detailFields() {
    const all = (state.cfg && state.cfg.details) || {};
    return all[state.visitType] || all.visitor || {};
  }

  function applyDetailFields() {
    const fields = detailFields();
    for (const [field, sel] of Object.entries(DETAIL_WIDGETS)) {
      const wrap = $(sel);
      if (!wrap) continue;
      const mode = fields[field] || 'off';
      show(wrap, mode !== 'off');
      const label = wrap.querySelector('span');
      if (label) {
        const base = label.textContent.replace(/\s*\*$/, '');
        label.textContent = mode === 'required' ? `${base} *` : base;
      }
    }
  }

  /* --------------------------------------------------------------- details */

  $('#details-continue').addEventListener('click', async () => {
    const err = $('#details-error');
    const fields = detailFields();
    if (!$('#f-name').value.trim()) return fail('Please enter your name.');
    if (fields.phone === 'required' && !$('#f-phone').value.trim()) return fail('Please enter a contact number.');
    if (fields.email === 'required' && !$('#f-email').value.trim()) return fail('Please enter an email address.');
    if (fields.company === 'required' && !$('#f-company').value.trim()) return fail('Please enter your company.');
    if (fields.staff === 'required' && !$('#f-host-id').value) return fail('Please choose who you are here to see.');
    show(err, false);

    if (!state.visitor) {
      try {
        state.induction = await api('/induction', { visit_type: state.visitType });
      } catch { /* keep whatever we have */ }
    }
    nextAfterDetails();

    function fail(msg) { err.textContent = msg; show(err, true); }
  });

  function nextAfterDetails() {
    const photo = detailFields().photo || 'off';
    if (photo !== 'off') {
      // A required photo hides the skip, unless the camera could not open at all.
      show($('#btn-photo-skip'), photo !== 'required');
      setScreen('photo');
      return startCamera($('#cam'));
    }
    afterPhoto();
  }

  function afterPhoto() {
    if (state.agreements && state.agreements.length) return showDocument(0);
    afterAgreement();
  }

  /** Show one document: its text, its questions, and a signature box. */
  function showDocument(index) {
    state.agreementIndex = index;
    state.agreement = state.agreements[index];
    const many = state.agreements.length > 1;
    $('#agreement-title').textContent = many
      ? `${state.agreement.name} (${index + 1} of ${state.agreements.length})`
      : state.agreement.name;
    // A questionnaire may have no text to read at all.
    $('#agreement-body').textContent = state.agreement.body || '';
    show($('#agreement-body'), !!String(state.agreement.body || '').trim());
    // A questionnaire is a document that only asks questions — no signature box.
    const needsSignature = state.agreement.require_signature !== 0;
    show($('.sig-label'), needsSignature);
    show($('.sig-wrap'), needsSignature);
    show($('#sig-clear'), needsSignature);
    const last = index === state.agreements.length - 1;
    $('#agreement-continue').textContent = needsSignature
      ? (last ? 'I agree & continue' : 'I agree — next document')
      : (last ? 'Continue' : 'Next');
    renderQuestions();
    clearSignature();
    setScreen('agreement');
  }

  /** Declaration questions attached to the document, answered before signing. */
  function renderQuestions() {
    const box = $('#agreement-questions');
    state.answers = {};
    let questions = [];
    try { questions = JSON.parse(state.agreement.questions || '[]'); } catch { questions = []; }
    state.questions = questions;
    show($('#questions-error'), false);

    box.innerHTML = questions.map((q, i) => {
      const id = q.id || `q${i + 1}`;
      const label = `<span class="q-label">${escapeHtml(q.label)}${q.required ? ' <span class="req">*</span>' : ''}</span>`;
      if (q.type === 'text') {
        return `<div class="question">${label}<input class="input" data-q="${id}" autocomplete="off"></div>`;
      }
      const choices = q.type === 'choice' ? (q.options || []) : ['Yes', 'No'];
      return `<div class="question">${label}<div class="q-choices" data-qgroup="${id}">
        ${choices.map((c) => `<button type="button" data-q="${id}" data-value="${escapeHtml(c)}" aria-pressed="false">${escapeHtml(c)}</button>`).join('')}
      </div></div>`;
    }).join('');

    $$('[data-qgroup] button', box).forEach((b) => b.addEventListener('click', () => {
      const group = b.closest('[data-qgroup]');
      $$('button', group).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      state.answers[b.dataset.q] = b.dataset.value;
    }));
    $$('input[data-q]', box).forEach((input) => input.addEventListener('input', () => {
      state.answers[input.dataset.q] = input.value.trim();
    }));
  }

  const escapeHtml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function afterAgreement() {
    if (state.induction && state.induction.required && state.induction.slideshow &&
        state.induction.slideshow.slides && state.induction.slideshow.slides.length) {
      return startDeck();
    }
    submitSignIn();
  }

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
    } catch (e) {
      // Live preview is unavailable (insecure origin, or permission refused).
      // Fall back to the device's own camera app, which works everywhere on iPadOS.
      $('#cam-error').textContent = window.isSecureContext
        ? 'Live preview is unavailable — tap “Open camera” to take the photo with the camera app.'
        : 'The live preview needs an https:// address. Tap “Open camera” to use the camera app instead, or skip this step.';
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
      toast('Photo captured');
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
    if (!stream) return afterPhoto();
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

  $('#btn-photo-continue').addEventListener('click', () => { stopCamera(); afterPhoto(); });
  $('#btn-photo-skip').addEventListener('click', () => { state.photo = null; stopCamera(); afterPhoto(); });

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
      return q.required && !String(state.answers[id] || '').trim();
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
    if (needsSignature && !hasInk) return toast('Please sign in the box to continue');

    state.signedDocs.push({
      agreement_id: state.agreement.id,
      signature: needsSignature ? pad.toDataURL('image/png') : null,
      answers: Object.keys(state.answers).length ? state.answers : null
    });

    const next = state.agreementIndex + 1;
    if (next < state.agreements.length) return showDocument(next);
    afterAgreement();
  });

  /* ------------------------------------------------------------------ deck */

  function startDeck() {
    state.deckIndex = 0;
    state.deckStart = new Date().toISOString();
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
    $('#deck-count').textContent = `${state.deckIndex + 1} of ${slides.length}`;
    $('#deck-progress-fill').style.width = `${((state.deckIndex + 1) / slides.length) * 100}%`;
    $('#deck-prev').disabled = state.deckIndex === 0;
    $('#deck-next').textContent = state.deckIndex === slides.length - 1 ? 'Finish' : 'Next';

    const minSecs = Number(show_.min_seconds_per_slide || 0);
    const next = $('#deck-next');
    if (minSecs > 0) {
      next.disabled = true;
      let left = minSecs;
      next.textContent = `${left}s`;
      clearInterval(renderSlide._t);
      renderSlide._t = setInterval(() => {
        left -= 1;
        if (left <= 0) {
          clearInterval(renderSlide._t);
          next.disabled = false;
          next.textContent = state.deckIndex === slides.length - 1 ? 'Finish' : 'Next';
        } else next.textContent = `${left}s`;
      }, 1000);
    } else next.disabled = false;
  }

  $('#deck-next').addEventListener('click', () => {
    const slides = state.induction.slideshow.slides;
    if (state.deckIndex < slides.length - 1) { state.deckIndex += 1; return renderSlide(); }
    clearInterval(renderSlide._t);
    if (state.cfg.induction.require_acknowledgement) setScreen('ack');
    else submitSignIn(true);
  });

  $('#deck-prev').addEventListener('click', () => {
    if (state.deckIndex > 0) { state.deckIndex -= 1; renderSlide(); }
  });

  $('#ack-replay').addEventListener('click', () => { state.deckIndex = 0; renderSlide(); setScreen('induction'); });
  $('#ack-confirm').addEventListener('click', () => submitSignIn(true));

  /* --------------------------------------------------------------- sign in */

  async function submitSignIn(inductionDone = false) {
    const payload = {
      visitor_id: state.visitor ? state.visitor.id : null,
      full_name: $('#f-name').value.trim(),
      company: $('#f-company').value.trim(),
      phone: $('#f-phone').value.trim(),
      email: $('#f-email').value.trim(),
      host_id: $('#f-host-id').value || null,
      visit_type: state.visitType,
      purpose: $('#f-purpose').value.trim(),
      vehicle_reg: $('#f-vehicle').value.trim().toUpperCase(),
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
      toast(err.data && err.data.message ? err.data.message : 'Sorry, something went wrong. Please see reception.');
    }
  }

  function showDone(result) {
    const org = state.cfg.org;
    $('#done-title').textContent = `You're signed in, ${result.visit.full_name.split(' ')[0]}`;
    $('#done-sub').textContent = result.visit.host_name
      ? `${result.visit.host_name} has been notified and will be with you shortly.`
      : 'Reception has been notified.';
    $('#done-code').textContent = `Sign-out code: ${result.checkout_code}`;
    $('#done-qr').innerHTML = `<img src="/api/qr?text=${encodeURIComponent(result.checkout_code)}" alt="Sign out QR code">`;

    // Badges are on for the account, but a kiosk with no printer attached opts out.
    const deviceCanPrint = !state.device || state.device.print_enabled;
    const badge = deviceCanPrint ? result.badge : null;
    show($('#btn-print-badge'), !!badge);
    if (badge) {
      buildBadge(result, badge, org);
      const note = $('#done-badge-note');
      note.textContent = badge.auto_print ? 'Your badge is printing…' : 'Tap “Print badge” to collect your badge.';
      show(note, true);
      if (badge.auto_print) setTimeout(() => window.print(), 700);
    } else {
      show($('#done-badge-note'), false);
    }
    setScreen('done');
  }

  function buildBadge(result, badge, org) {
    const root = document.documentElement;
    root.style.setProperty('--badge-w', `${badge.label_width_mm}mm`);
    root.style.setProperty('--badge-h', `${badge.label_height_mm}mm`);
    root.style.setProperty('--badge-scale', badge.font_scale || 1);

    $('#badge-type').textContent = badge.title_text || result.visit.visit_type.toUpperCase();
    $('#badge-name').textContent = result.visit.full_name;
    $('#badge-company').textContent = badge.show_company ? (result.visit.company || '') : '';
    show($('#badge-company'), !!(badge.show_company && result.visit.company));

    const meta = [];
    if (badge.show_host && result.visit.host_name) meta.push(`Visiting: ${result.visit.host_name}`);
    if (badge.show_date) meta.push(new Date(result.visit.signed_in_at).toLocaleDateString(org.date_format || 'en-GB'));
    if (badge.show_time) meta.push(new Date(result.visit.signed_in_at).toLocaleTimeString(org.date_format || 'en-GB', { hour: '2-digit', minute: '2-digit' }));
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
  $('#signout-q').addEventListener('input', () => {
    clearTimeout(signoutTimer);
    signoutTimer = setTimeout(async () => {
      const q = $('#signout-q').value.trim();
      if (q.length < 2) return ($('#signout-results').innerHTML = '');
      const isCode = /^[0-9A-F]{8}$/i.test(q);
      const rows = await api('/signout/search', isCode ? { code: q } : { q }).catch(() => []);
      $('#signout-results').innerHTML = rows.length
        ? rows.map((r) => `<div class="result"><div><b>${r.full_name}</b>
            <span>${r.company ? r.company + ' · ' : ''}in since ${new Date(r.signed_in_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${r.host_name ? ' · ' + r.host_name : ''}</span></div>
            <button class="btn" data-signout="${r.id}">Sign out</button></div>`).join('')
        : '<p class="muted">No matching visitor is signed in.</p>';
      $$('#signout-results [data-signout]').forEach((b) => b.addEventListener('click', async () => {
        const res = await api('/signout', { visit_id: Number(b.dataset.signout) }).catch(() => null);
        if (!res) return toast('Could not sign out — please see reception.');
        $('#done-title').textContent = 'Signed out';
        $('#done-sub').textContent = res.goodbye || 'Thanks for visiting.';
        $('#done-code').textContent = '';
        $('#done-qr').innerHTML = '';
        show($('#btn-print-badge'), false);
        show($('#done-badge-note'), false);
        setScreen('done');
      }));
    }, 220);
  });

  /* -------------------------------------------------------------- delivery */

  $('#d-capture').addEventListener('click', () => {
    if (!stream) return $('#d-native-input').click();
    state.deliveryPhoto = grabFrame($('#d-cam'));
    $('#d-shot').src = state.deliveryPhoto;
    show($('#d-shot'), true);
    toast('Photo captured');
  });

  $('#d-submit').addEventListener('click', async () => {
    const err = $('#d-error');
    const cfg = state.cfg.deliveries;
    if (cfg.require_recipient && !$('#d-host-id').value && !$('#d-host-search').value.trim()) {
      err.textContent = 'Please tell us who the delivery is for.';
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
      $('#done-title').textContent = 'Delivery logged';
      $('#done-sub').textContent = 'The recipient has been notified. Thank you!';
      $('#done-code').textContent = '';
      $('#done-qr').innerHTML = '';
      show($('#btn-print-badge'), false);
      show($('#done-badge-note'), false);
      setScreen('done');
    } catch (e) {
      err.textContent = 'Could not log the delivery. Please see reception.';
      show(err, true);
    }
  });

  /* ------------------------------------------------------------------ init */

  boot();
})();
