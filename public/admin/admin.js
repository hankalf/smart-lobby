/* Smart Lobby — admin dashboard */
(() => {
  'use strict';

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const el = (html) => { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild; };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let SETTINGS = null;
  let ME = null;

  /* ------------------------------------------------------------------ api */

  async function api(path, { method = 'GET', body, raw } = {}) {
    const res = await fetch(`/api/admin${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 401) { showGate(); throw new Error('unauthenticated'); }
    if (raw) return res;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'failed'), { data });
    return data;
  }

  const upload = async (path, file, field = 'file') => {
    const fd = new FormData();
    fd.append(field, file);
    const res = await fetch(`/api/admin${path}`, { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'upload_failed'), { data });
    return data;
  };

  function toast(msg, ms = 2800) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add('hidden'), ms);
  }

  /*
   * Times are shown on the site's clock, not the one this dashboard happens to
   * be open on. Someone checking the gate from head office in another country
   * should read the same arrival time the receptionist does, and the same one
   * printed on the badge — otherwise "3 in today" sits above a list of
   * yesterday's arrivals.
   *
   * A zone Intl cannot parse would throw out of every row it formats, so it is
   * checked once and then ignored, leaving times on the browser's own clock.
   */
  let zoneSeen = {};
  const siteZone = () => {
    const tz = (SETTINGS && SETTINGS.org.timezone) || undefined;
    if (!tz) return undefined;
    if (zoneSeen.tz !== tz) {
      try { new Intl.DateTimeFormat('en', { timeZone: tz }); zoneSeen = { tz, use: tz }; } catch { zoneSeen = { tz }; }
    }
    return zoneSeen.use;
  };
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: siteZone() }) : '—');
  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: siteZone() }) : '—');
  const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: siteZone() }) : '—');

  /* ---------------------------------------------------------------- modal */

  function modal(title, contentHtml, onSave, saveLabel = 'Save') {
    const bg = el(`<div class="modal-bg"><div class="modal"><h2>${esc(title)}</h2>
      <div class="modal-body">${contentHtml}</div>
      <div class="modal-actions">
        <button class="btn ghost" data-close>Cancel</button>
        ${onSave ? `<button class="btn" data-save>${esc(saveLabel)}</button>` : ''}
      </div></div></div>`);
    $('#modal-root').appendChild(bg);
    const close = () => bg.remove();
    bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
    $('[data-close]', bg).addEventListener('click', close);
    if (onSave) {
      $('[data-save]', bg).addEventListener('click', async () => {
        try { await onSave(bg, close); } catch (err) { toast(err.message || 'Could not save'); }
      });
    }
    return { bg, close };
  }

  /**
   * Copy to the clipboard, and say so on the button that was pressed.
   *
   * navigator.clipboard needs a secure context, which a dashboard opened over
   * plain http:// on the LAN is not — so there is a fallback through a hidden
   * textarea, and the text stays selectable on screen either way.
   */
  async function copyText(text, btn) {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
    }
    if (btn) {
      const was = btn.textContent;
      btn.textContent = ok ? 'Copied' : 'Press ⌘/Ctrl+C';
      setTimeout(() => { btn.textContent = was; }, 1600);
    }
    if (!ok) toast('Could not copy automatically — select the link and copy it.');
    return ok;
  }

  const confirmAction = (message, onYes) =>
    modal('Please confirm', `<p>${esc(message)}</p>`, async (bg, close) => { await onYes(); close(); }, 'Yes, continue');

  /** Put the uploaded logo (or initials as a fallback) in the sidebar. */
  function applyBranding() {
    const name = (SETTINGS && SETTINGS.org.name) || 'Smart Lobby';
    const logo = SETTINGS && SETTINGS.org.logo_path;
    $('#brand-name').textContent = name;
    const mark = $('#brand-mark');
    if (logo) {
      mark.classList.add('has-logo');
      mark.innerHTML = `<img src="${esc(logo)}" alt="">`;
    } else {
      mark.classList.remove('has-logo');
      mark.textContent = name.replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean)
        .slice(0, 2).map((w) => w[0].toUpperCase()).join('') || 'SL';
    }
  }

  /* ----------------------------------------------------------------- gate */

  async function showGate() {
    const boot = await fetch('/api/admin/bootstrap').then((r) => r.json());
    $('#shell').classList.add('hidden');
    $('#gate').classList.remove('hidden');
    const setup = boot.needs_setup;
    if (boot.org && boot.org.logo_path) {
      $('#gate-logo').src = boot.org.logo_path;
      $('#gate-logo').classList.remove('hidden');
    }
    $('#gate-title').textContent = setup ? 'Set up Smart Lobby' : (boot.org && boot.org.name) || 'Smart Lobby';
    $('#gate-sub').textContent = setup ? 'Create the first administrator account' : 'Sign in to the admin dashboard';
    $('#gate-org-wrap').hidden = !setup;
    $('#gate-name-wrap').hidden = !setup;
    $('#gate-submit').textContent = setup ? 'Create account' : 'Sign in';
    $('#gate-pass').autocomplete = setup ? 'new-password' : 'current-password';
    $('#gate-form').dataset.mode = setup ? 'setup' : 'login';
    if (boot.storage_warning) {
      const err = $('#gate-error');
      err.innerHTML = `<b>Storage is not persistent.</b> ${esc(boot.storage_warning)}`;
      err.classList.remove('hidden');
    }
  }

  $('#gate-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const mode = $('#gate-form').dataset.mode;
    const err = $('#gate-error');
    err.classList.add('hidden');
    const body = { email: $('#gate-email').value, password: $('#gate-pass').value };
    if (mode === 'setup') { body.name = $('#gate-name').value; body.org_name = $('#gate-org').value; }
    try {
      await api(mode === 'setup' ? '/setup' : '/login', { method: 'POST', body });
      $('#gate').classList.add('hidden');
      start();
    } catch (ex) {
      err.textContent = ex.data && ex.data.error === 'weak_credentials'
        ? 'Please use a password of at least 8 characters.'
        : 'Those details were not recognised.';
      err.classList.remove('hidden');
    }
  });

  $('#logout').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' });
    location.reload();
  });

  /* ----------------------------------------------------------------- nav */

  $$('#nav button').forEach((b) => b.addEventListener('click', () => {
    $$('#nav button').forEach((x) => x.classList.toggle('active', x === b));
    render(b.dataset.view);
    location.hash = b.dataset.view;
  }));

  const VIEWS = {};

  async function render(view) {
    const target = $('#view');
    target.innerHTML = '<p class="empty">Loading…</p>';
    try {
      await (VIEWS[view] || VIEWS.dashboard)(target);
    } catch (err) {
      if (err.message !== 'unauthenticated') target.innerHTML = `<p class="empty">Could not load: ${esc(err.message)}</p>`;
    }
  }

  /* ------------------------------------------------------------ dashboard */

  VIEWS.dashboard = async (root) => {
    const d = await api('/dashboard');
    const max = Math.max(1, ...d.week.map((w) => w.n));
    root.innerHTML = `
      <h1 class="page">Dashboard</h1>
      <p class="page-sub">Live view of who is on site right now.</p>
      ${d.storage_warning ? `<div class="notice error" style="font-size:1rem">
        <b>Storage is not persistent.</b> ${esc(d.storage_warning)}</div>` : ''}
      <div class="grid cards" style="margin-bottom:1.25rem">
        ${[['On site now', d.stats.onsite], ['Signed in today', d.stats.today_in], ['Signed out today', d.stats.today_out],
           ['Parcels waiting', d.stats.deliveries_waiting], ['Inductions today', d.stats.inductions_today],
           ['People on file', d.stats.visitors_total]]
          .map(([l, n]) => `<div class="card stat"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('')}
      </div>
      <div class="card section">
        <div class="row between">
          <h2 style="margin:0">On site now (${d.onsite.length})</h2>
          <div class="row" style="margin:0">
            <button class="btn subtle" id="btn-rollcall">Emergency roll call</button>
            <button class="btn ghost" id="btn-signout-all">Sign out everyone</button>
          </div>
        </div>
        <div class="table-wrap">${onsiteTable(d.onsite)}</div>
      </div>
      <div class="grid two">
        <div class="card section">
          <h2>Last 14 days</h2>
          <div class="bars">${d.week.map((w) => `<div style="height:${(w.n / max) * 100}%" title="${w.day}: ${w.n}"><span>${w.day.slice(8)}</span></div>`).join('')}</div>
        </div>
        <div class="card section">
          <h2>Recent deliveries</h2>
          ${d.recent_deliveries.length ? `<div class="table-wrap"><table><tbody>${d.recent_deliveries.map((x) => `
            <tr><td>${fmtDate(x.received_at)}</td><td>${esc(x.courier_company || x.courier_name || 'Courier')}</td>
            <td>${esc(x.host_name || x.recipient_text || '')}</td>
            <td><span class="pill ${x.status === 'awaiting' ? 'wait' : 'on'}">${x.status}</span></td></tr>`).join('')}</tbody></table></div>`
            : '<p class="empty">No deliveries logged yet.</p>'}
        </div>
      </div>`;

    $('#btn-rollcall').addEventListener('click', rollCall);
    $('#btn-signout-all').addEventListener('click', () => confirmAction(
      'Sign out every person currently on site?',
      async () => { const r = await api('/visits/signout-all', { method: 'POST' }); toast(`${r.count} signed out`); render('dashboard'); }));
    bindSignoutButtons(root, () => render('dashboard'));
  };

  function onsiteTable(rows) {
    if (!rows.length) return '<p class="empty">Nobody is signed in at the moment.</p>';
    return `<table><thead><tr><th></th><th>Name</th><th>Company</th><th>Type</th><th>Staff member</th><th>Badge</th><th>Since</th><th></th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td>${r.photo_path ? `<img class="avatar" src="${esc(r.photo_path)}" alt="">` : '<div class="avatar"></div>'}</td>
        <td><b>${esc(r.full_name)}</b>${r.phone ? `<div class="muted">${esc(r.phone)}</div>` : ''}</td>
        <td>${esc(r.company || '')}</td>
        <td>${esc(r.visit_type)}</td>
        <td>${esc(r.host_name || '')}</td>
        <td>${esc(r.badge_no || '')}</td>
        <td>${fmtTime(r.signed_in_at)}</td>
        <td><button class="btn ghost" data-reprint="${r.id}">Badge</button>
            <button class="btn ghost" data-signout="${r.id}">Sign out</button></td></tr>`).join('')}</tbody></table>`;
  }

  function bindSignoutButtons(root, after) {
    $$('[data-signout]', root).forEach((b) => b.addEventListener('click', async () => {
      await api(`/visits/${b.dataset.signout}/signout`, { method: 'POST' });
      toast('Signed out');
      after();
    }));
    // Reprinting from wherever somebody is standing when they are asked for it.
    $$('[data-reprint]', root).forEach((b) => b.addEventListener('click', () => reprintBadge(b.dataset.reprint)));
  }

  async function rollCall() {
    const data = await api('/rollcall');
    const html = `
      <p class="muted">Generated ${fmtDate(data.generated_at)} — ${data.count} people on site.</p>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Company</th><th>Phone</th><th>Staff member</th><th>Signed in at</th><th>In since</th></tr></thead>
      <tbody>${data.rows.map((r) => `<tr><td><b>${esc(r.full_name)}</b></td><td>${esc(r.company || '')}</td>
        <td>${esc(r.phone || '')}</td><td>${esc(r.host_name || '')}</td><td>${esc(r.location_name || '—')}</td>
        <td>${fmtTime(r.signed_in_at)}</td></tr>`).join('')}</tbody></table></div>`;
    const m = modal('Emergency roll call', html, null);
    const actions = $('.modal-actions', m.bg);
    const print = el('<button class="btn subtle">Print</button>');
    const csv = el('<a class="btn ghost" href="/api/admin/rollcall?format=csv">Download CSV</a>');
    print.addEventListener('click', () => {
      const w = window.open('', '_blank');
      w.document.write(`<title>Roll call</title><style>body{font-family:system-ui;padding:2rem}table{width:100%;border-collapse:collapse}
        td,th{border-bottom:1px solid #ccc;padding:.4rem;text-align:left;font-size:12pt}</style>
        <h1>Emergency roll call</h1>${html}`);
      w.document.close();
      w.print();
    });
    actions.prepend(csv);
    actions.prepend(print);
  }

  /* --------------------------------------------------------------- visits */

  VIEWS.visits = async (root) => {
    root.innerHTML = `
      <h1 class="page">Visits</h1>
      <p class="page-sub">Every sign-in, searchable and exportable.</p>
      <div class="card section">
        <div class="row">
          <input class="input" id="v-q" placeholder="Search name, company or staff member" style="max-width:16rem">
          <input class="input" id="v-from" type="date" style="max-width:11rem">
          <input class="input" id="v-to" type="date" style="max-width:11rem">
          <select class="input" id="v-status" style="max-width:10rem">
            <option value="">All statuses</option><option value="onsite">On site</option><option value="out">Signed out</option>
          </select>
          <button class="btn" id="v-search">Search</button>
          <a class="btn ghost" id="v-csv" href="/api/admin/visits?format=csv">Export CSV</a>
        </div>
        <div class="table-wrap" id="v-results"></div>
      </div>`;

    const load = async () => {
      const params = new URLSearchParams();
      ['q', 'from', 'to', 'status'].forEach((k) => { const v = $(`#v-${k}`).value; if (v) params.set(k, v); });
      const rows = await api(`/visits?${params}`);
      $('#v-csv').href = `/api/admin/visits?format=csv&${params}`;
      $('#v-results').innerHTML = rows.length ? `<table>
        <thead><tr><th>Name</th><th>Company</th><th>Type</th><th>Staff member</th><th>In</th><th>Out</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td><b>${esc(r.full_name)}</b></td><td>${esc(r.company || '')}</td><td>${esc(r.visit_type)}</td>
          <td>${esc(r.host_name || '')}</td><td>${fmtDate(r.signed_in_at)}</td><td>${fmtDate(r.signed_out_at)}</td>
          <td><span class="pill ${r.status === 'onsite' ? 'on' : 'off'}">${r.status}</span></td>
          <td><button class="btn ghost" data-visit="${r.id}">View</button></td></tr>`).join('')}</tbody></table>`
        : '<p class="empty">No visits match those filters.</p>';
      $$('[data-visit]').forEach((b) => b.addEventListener('click', () => visitDetail(b.dataset.visit)));
    };
    $('#v-search').addEventListener('click', load);
    $('#v-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
    load();
  };

  async function visitDetail(id) {
    const v = await api(`/visits/${id}`);
    modal(`Visit — ${v.full_name}`, `
      <div class="row" style="align-items:flex-start">
        ${v.photo_path ? `<img src="${esc(v.photo_path)}" style="width:120px;border-radius:12px">` : ''}
        <div>
          <p style="margin:0"><b>${esc(v.full_name)}</b><br>
          <span class="muted">${esc(v.company || '')} ${v.phone ? '· ' + esc(v.phone) : ''} ${v.email ? '· ' + esc(v.email) : ''}</span></p>
          <p class="muted">${esc(v.visit_type)} · ${esc(v.purpose || 'no reason given')}${v.language === 'es' ? ' · signed in en español' : ''}<br>
          ${v.project_name ? `Project: ${esc(v.project_name)}<br>` : ''}
          Staff member: ${esc(v.host_name || '—')} · Badge: ${esc(v.badge_no || '—')} ${v.vehicle_reg ? '· Vehicle: ' + esc(v.vehicle_reg) : ''}<br>
          ${v.reference ? `Reference: ${esc(v.reference)}${v.movement ? ' · ' + esc(v.movement) : ''}<br>` : ''}
          ${v.location_name ? `Signed in at: ${esc(v.location_name)}${v.device_name ? ` (${esc(v.device_name)})` : ''}<br>` : ''}
          In: ${fmtDate(v.signed_in_at)} · Out: ${fmtDate(v.signed_out_at)}</p>
        </div>
      </div>
      <h3>Induction</h3>
      ${v.inductions.length ? v.inductions.map((i) => `<p class="muted">${esc(i.slideshow_name || 'Deck')} v${i.slideshow_version} — completed ${fmtDate(i.completed_at)}${i.seconds ? ` (${i.seconds}s)` : ''}</p>
        ${i.signature_path ? `<img src="${esc(i.signature_path)}" alt="Induction signature" style="max-width:260px;border:1px solid var(--line);border-radius:8px">` : ''}`).join('')
        : '<p class="muted">Not shown for this visit (already completed previously, or not required).</p>'}
      <h3>Signed documents</h3>
      ${v.signatures.length ? v.signatures.map((s) => {
        let answers = [];
        try { answers = Object.entries(JSON.parse(s.answers || '{}')); } catch { answers = []; }
        const labels = questionLabels(s.agreement_questions);
        return `<p class="muted">${esc(s.agreement_name || 'Agreement')} v${s.agreement_version} — ${fmtDate(s.signed_at)}${s.language === 'es' ? ' · signed in Spanish' : ''}</p>
          ${answers.length ? `<table style="margin-bottom:.6rem"><tbody>${answers.map(([k, val]) =>
            `<tr><td>${esc(labels[k] || k)}</td><td><b>${esc(val)}</b></td></tr>`).join('')}</tbody></table>` : ''}
          ${s.signature_path ? `<img src="${esc(s.signature_path)}" style="max-width:260px;border:1px solid var(--line);border-radius:8px">` : ''}`;
      }).join('') : '<p class="muted">Nothing signed.</p>'}
      <h3>Notifications</h3>
      ${v.notifications.length ? `<table><tbody>${v.notifications.map((n) => `<tr><td>${esc(n.channel)}</td><td>${esc(n.target || '')}</td>
        <td><span class="pill ${n.status === 'sent' ? 'on' : 'off'}">${esc(n.status)}</span></td><td class="muted">${fmtDate(n.created_at)}</td></tr>`).join('')}</tbody></table>`
        : '<p class="muted">None sent.</p>'}`, null);
  }

  /* ------------------------------------------------------------- visitors */

  VIEWS.visitors = async (root) => {
    root.innerHTML = `
      <h1 class="page">Visitor registry</h1>
      <p class="page-sub">Everyone who has ever signed in. Induction status is tracked per person, so returning visitors skip the deck.</p>
      <div class="card section">
        <div class="row"><input class="input" id="p-q" placeholder="Search people" style="max-width:18rem">
        <button class="btn" id="p-search">Search</button></div>
        <div class="table-wrap" id="p-results"></div>
      </div>`;
    const load = async () => {
      const rows = await api(`/visitors?q=${encodeURIComponent($('#p-q').value)}`);
      $('#p-results').innerHTML = rows.length ? `<table>
        <thead><tr><th>Name</th><th>Company</th><th>Contact</th><th>Visits</th><th>Last visit</th><th>Induction</th><th></th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td><b>${esc(r.full_name)}</b> ${r.blocked ? '<span class="pill" style="background:#fdecea;color:#b3261e">blocked</span>' : ''}</td>
          <td>${esc(r.company || '')}</td>
          <td class="muted">${esc(r.phone || '')}${r.email ? '<br>' + esc(r.email) : ''}</td>
          <td>${r.visit_count}</td><td>${fmtDay(r.last_visit_at)}</td>
          <td>${r.induction_completed_at ? `<span class="pill on">done ${fmtDay(r.induction_completed_at)}</span>` : '<span class="pill off">not done</span>'}</td>
          <td><button class="btn ghost" data-person="${r.id}">Open</button></td></tr>`).join('')}</tbody></table>`
        : '<p class="empty">No people found.</p>';
      $$('[data-person]').forEach((b) => b.addEventListener('click', () => personDetail(b.dataset.person, load)));
    };
    $('#p-search').addEventListener('click', load);
    $('#p-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
    load();
  };

  async function personDetail(id, after) {
    const p = await api(`/visitors/${id}`);
    const m = modal(p.full_name, `
      <div class="form-grid">
        <label class="field"><span>Name</span><input class="input" id="pd-name" value="${esc(p.full_name)}"></label>
        <label class="field"><span>Company</span><input class="input" id="pd-company" value="${esc(p.company || '')}"></label>
        <label class="field"><span>Phone</span><input class="input" id="pd-phone" value="${esc(p.phone || '')}"></label>
        <label class="field"><span>Email</span><input class="input" id="pd-email" value="${esc(p.email || '')}"></label>
      </div>
      <label class="field"><span>Internal notes</span><textarea class="input" id="pd-notes" rows="2">${esc(p.notes || '')}</textarea></label>
      <label class="check"><input type="checkbox" id="pd-blocked" ${p.blocked ? 'checked' : ''}> Block this person from signing in</label>
      <h3>Induction</h3>
      <p class="muted">${p.inductions.length ? p.inductions.map((i) => `${esc(i.slideshow_name || 'Deck')} v${i.slideshow_version} — ${fmtDate(i.completed_at)}`).join('<br>') : 'Never completed.'}</p>
      <button class="btn ghost" id="pd-reset">Reset induction (show deck again next visit)</button>
      <h3>Visit history</h3>
      <div class="table-wrap"><table><tbody>${p.visits.map((v) => `<tr><td>${fmtDate(v.signed_in_at)}</td>
        <td>${esc(v.visit_type)}</td><td>${esc(v.host_name || '')}</td><td>${v.signed_out_at ? fmtTime(v.signed_out_at) : '<span class="pill on">on site</span>'}</td></tr>`).join('')}</tbody></table></div>`,
      async (bg, close) => {
        await api(`/visitors/${id}`, { method: 'PATCH', body: {
          full_name: $('#pd-name', bg).value, company: $('#pd-company', bg).value,
          phone: $('#pd-phone', bg).value, email: $('#pd-email', bg).value,
          notes: $('#pd-notes', bg).value, blocked: $('#pd-blocked', bg).checked
        } });
        toast('Saved');
        close();
        after();
      });
    $('#pd-reset', m.bg).addEventListener('click', async () => {
      await api(`/visitors/${id}/reset-induction`, { method: 'POST' });
      toast('Induction reset — they will see the deck on their next visit');
    });
  }

  /* -------------------------------------------------------------- drivers */

  VIEWS.drivers = async (root) => {
    const params = new URLSearchParams();
    ['q', 'from', 'to'].forEach((k) => { if (VIEWS.drivers[k]) params.set(k, VIEWS.drivers[k]); });
    const data = await api(`/drivers?${params}`);
    const cfg = await api('/settings');

    const movementPill = (m) => (m ? `<span class="pill ${/pick/i.test(m) ? 'wait' : 'on'}">${esc(m)}</span>` : '—');
    const minutes = (r) => (r.signed_out_at
      ? `${Math.round((new Date(r.signed_out_at) - new Date(r.signed_in_at)) / 60000)} min`
      : `<span class="muted">on site</span>`);

    root.innerHTML = `
      <h1 class="page">Drivers</h1>
      <p class="page-sub">Truck drivers delivering and collecting. Everything they sign in with — haulier, vehicle,
        reference — is kept here.</p>

      ${((SETTINGS && SETTINGS.types) || []).some((ty) => ty.key === 'driver' && ty.mode !== 'off') ? ''
        : `<div class="notice">The <b>Driver</b> card is switched off, so nobody can
        check in as one yet. Turn it on under <b>Visitor types</b>.</div>`}

      <div class="grid cards" style="margin-bottom:1.25rem">
        ${[['On site now', data.stats.onsite], ['Arrived today', data.stats.today],
           ['Deliveries today', data.stats.delivering_today], ['Pick-ups today', data.stats.collecting_today],
           ['Average turnaround', data.stats.avg_minutes ? `${Math.round(data.stats.avg_minutes)} min` : '—']]
          .map(([l, n]) => `<div class="card stat"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('')}
      </div>

      <div class="card section">
        <h2>On site now (${data.onsite.length})</h2>
        ${data.onsite.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Driver</th><th>Haulier</th><th>Vehicle</th><th>Reference</th><th>Pick-Up / Delivery</th><th>Door</th><th>Arrived</th><th></th></tr></thead>
          <tbody>${data.onsite.map((r) => `<tr>
            <td><b>${esc(r.full_name)}</b>${r.phone ? `<div class="muted">${esc(r.phone)}</div>` : ''}</td>
            <td>${esc(r.company || '')}</td>
            <td><b>${esc(r.vehicle_reg || '—')}</b></td>
            <td>${esc(r.reference || '—')}</td>
            <td>${movementPill(r.movement)}</td>
            <td><input class="input door-input" data-door="${r.id}" value="${esc(r.door || '')}"
                  inputmode="numeric" maxlength="2" placeholder="—" aria-label="Door number"></td>
            <td>${fmtTime(r.signed_in_at)}</td>
            <td><button class="btn ghost" data-signout="${r.id}">Sign out</button></td></tr>`).join('')}</tbody>
        </table></div>` : '<p class="empty">No drivers on site.</p>'}
      </div>

      <div class="card section">
        <div class="row between">
          <h2 style="margin:0">Driver log</h2>
          <a class="btn ghost" id="dr-csv" href="/api/admin/drivers?format=csv&${params}">Export CSV</a>
        </div>
        <div class="row">
          <input class="input" id="dr-q" placeholder="Driver, haulier, vehicle or reference" style="max-width:20rem"
            value="${esc(VIEWS.drivers.q || '')}">
          <input class="input" id="dr-from" type="date" style="max-width:11rem" value="${esc(VIEWS.drivers.from || '')}">
          <input class="input" id="dr-to" type="date" style="max-width:11rem" value="${esc(VIEWS.drivers.to || '')}">
          <button class="btn" id="dr-search">Search</button>
          ${VIEWS.drivers.q || VIEWS.drivers.from || VIEWS.drivers.to ? '<button class="btn ghost" id="dr-clear">Clear</button>' : ''}
        </div>
        ${data.log.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Arrived</th><th>Driver</th><th>Haulier</th><th>Vehicle</th><th>Reference</th><th>Pick-Up / Delivery</th><th>Door</th><th>Turnaround</th></tr></thead>
          <tbody>${data.log.map((r) => `<tr>
            <td>${fmtDate(r.signed_in_at)}</td>
            <td><b>${esc(r.full_name)}</b></td>
            <td>${esc(r.company || '')}</td>
            <td>${esc(r.vehicle_reg || '—')}</td>
            <td>${esc(r.reference || '—')}</td>
            <td>${movementPill(r.movement)}</td>
            <td>${esc(r.door || '—')}</td>
            <td>${minutes(r)}</td></tr>`).join('')}</tbody>
        </table></div>` : '<p class="empty">No driver check-ins match.</p>'}
      </div>`;

    bindSignoutButtons(root, () => render('drivers'));

    // Door numbers are typed straight into the row and saved as they are entered.
    $$('[data-door]').forEach((input) => {
      input.addEventListener('input', () => {
        const cleaned = input.value.replace(/\D/g, '').slice(0, 2);
        if (cleaned !== input.value) input.value = cleaned;
      });
      const save = async () => {
        if (input.value === input.dataset.saved) return;
        try {
          await api(`/visits/${input.dataset.door}/door`, { method: 'PATCH', body: { door: input.value } });
          input.dataset.saved = input.value;
          input.classList.add('saved');
          setTimeout(() => input.classList.remove('saved'), 900);
        } catch { toast('Could not save that door number'); }
      };
      input.dataset.saved = input.value;
      input.addEventListener('change', save);
      input.addEventListener('blur', save);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
    });

    const runSearch = () => {
      VIEWS.drivers.q = $('#dr-q').value.trim();
      VIEWS.drivers.from = $('#dr-from').value;
      VIEWS.drivers.to = $('#dr-to').value;
      render('drivers');
    };
    $('#dr-search').addEventListener('click', runSearch);
    $('#dr-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
    const clear = $('#dr-clear');
    if (clear) clear.addEventListener('click', () => {
      VIEWS.drivers.q = VIEWS.drivers.from = VIEWS.drivers.to = '';
      render('drivers');
    });
  };

  /* ----------------------------------------------------------- deliveries */

  VIEWS.deliveries = async (root) => {
    const rows = await api('/deliveries');
    root.innerHTML = `
      <h1 class="page">Deliveries</h1>
      <p class="page-sub">Parcels logged at the kiosk by couriers, and collections signed for at reception.</p>
      <div class="row between">
        <button class="btn" id="d-add">Log a delivery</button>
        <a class="btn ghost" href="/api/admin/deliveries?format=csv">Export CSV</a>
      </div>
      <div class="card section"><div class="table-wrap">${rows.length ? `<table>
        <thead><tr><th></th><th>Received</th><th>Courier</th><th>For</th><th>Parcels</th><th>Tracking</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td>${r.photo_path ? `<img class="avatar" src="${esc(r.photo_path)}" alt="">` : ''}</td>
          <td>${fmtDate(r.received_at)}</td>
          <td>${esc(r.courier_company || '')}${r.courier_name ? `<div class="muted">${esc(r.courier_name)}</div>` : ''}</td>
          <td>${esc(r.host_name || r.recipient_text || '')}</td>
          <td>${r.parcel_count}</td><td class="muted">${esc(r.tracking || '')}</td>
          <td><span class="pill ${r.status === 'awaiting' ? 'wait' : 'on'}">${esc(r.status)}</span>
            ${r.collected_at ? `<div class="muted">${esc(r.collected_by || '')} ${fmtDate(r.collected_at)}</div>` : ''}</td>
          <td>${r.status === 'awaiting'
            ? `<button class="btn" data-collect="${r.id}">Collect</button> <button class="btn ghost" data-renotify="${r.id}">Re-notify</button>`
            : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">No deliveries logged yet.</p>'}</div></div>`;

    $$('[data-collect]').forEach((b) => b.addEventListener('click', () => collectDelivery(b.dataset.collect)));
    $$('[data-renotify]').forEach((b) => b.addEventListener('click', async () => {
      await api(`/deliveries/${b.dataset.renotify}/notify`, { method: 'POST' });
      toast('Recipient notified again');
    }));
    $('#d-add').addEventListener('click', async () => {
      const hosts = await api('/staff');
      modal('Log a delivery', `
        <div class="form-grid">
          <label class="field"><span>Courier name</span><input class="input" id="nd-name"></label>
          <label class="field"><span>Courier company</span><input class="input" id="nd-company"></label>
          <label class="field"><span>For</span><select class="input" id="nd-host">
            <option value="">— choose a staff member —</option>${hosts.map((h) => `<option value="${h.id}">${esc(h.name)}</option>`).join('')}</select></label>
          <label class="field"><span>Parcels</span><input class="input" id="nd-count" type="number" value="1" min="1"></label>
          <label class="field"><span>Tracking</span><input class="input" id="nd-tracking"></label>
        </div>`, async (bg, close) => {
        await api('/deliveries', { method: 'POST', body: {
          courier_name: $('#nd-name', bg).value, courier_company: $('#nd-company', bg).value,
          recipient_host_id: $('#nd-host', bg).value || null, parcel_count: Number($('#nd-count', bg).value) || 1,
          tracking: $('#nd-tracking', bg).value } });
        close(); render('deliveries');
      });
    });
  };

  function collectDelivery(id) {
    const m = modal('Collect delivery', `
      <label class="field"><span>Collected by</span><input class="input" id="cd-name" placeholder="Name of the person collecting"></label>
      <p class="muted">Signature</p>
      <div style="border:2px dashed var(--line);border-radius:12px"><canvas id="cd-sig" style="width:100%;height:150px;display:block;touch-action:none"></canvas></div>
      <button class="btn link" id="cd-clear">Clear signature</button>`,
      async (bg, close) => {
        const canvas = $('#cd-sig', bg);
        await api(`/deliveries/${id}/collect`, { method: 'POST', body: {
          collected_by: $('#cd-name', bg).value,
          signature: canvas.dataset.hasInk === '1' ? canvas.toDataURL('image/png') : null } });
        close(); render('deliveries');
      }, 'Mark collected');

    const canvas = $('#cd-sig', m.bg);
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr; canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr); ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.strokeStyle = '#12211b';
    let down = false;
    const pt = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    canvas.addEventListener('pointerdown', (e) => { down = true; canvas.dataset.hasInk = '1'; const p = pt(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); });
    canvas.addEventListener('pointermove', (e) => { if (!down) return; const p = pt(e); ctx.lineTo(p.x, p.y); ctx.stroke(); });
    ['pointerup', 'pointerleave'].forEach((ev) => canvas.addEventListener(ev, () => { down = false; }));
    $('#cd-clear', m.bg).addEventListener('click', () => { ctx.clearRect(0, 0, canvas.width, canvas.height); canvas.dataset.hasInk = '0'; });
  }

  /* ------------------------------------------------------------ induction */

  /*
   * A deck converted from PowerPoint carries a risk a PDF does not: PowerPoint
   * shrinks overflowing text to fit its box and records only the shrink factor,
   * which the converter ignores — so a slide whose text was already tight comes
   * out with its words drawn at full size, over whatever sat beside them. The
   * deck cannot be inspected from here, so the deck that came from a .pptx says
   * what to look for and how to settle it.
   */
  function pptxHint(s) {
    const from = String(s.source_file || '').toLowerCase();
    if (!/\.(pptx|ppt|odp)$/.test(from) || s.render_mode !== 'rendered') return '';
    return `<div class="notice" style="margin:.75rem 0 0">
      <b>Converted from PowerPoint.</b> Check it with <b>Preview</b> — if any slide's text runs under a picture
      or off the edge, that is PowerPoint's “shrink text on overflow” being ignored by the converter, and no
      setting here fixes it. Open the deck in PowerPoint, <b>File → Export → PDF</b>, and upload that PDF here
      instead: it renders exactly as you see it, and is still split into slides.</div>`;
  }

  VIEWS.induction = async (root) => {
    const { rows, capabilities } = await api('/slideshows');
    root.innerHTML = `
      <h1 class="page">Induction decks</h1>
      <p class="page-sub">Upload a PowerPoint, PDF or images. First-time visitors watch it before they finish signing in;
        people who have already seen the current version skip straight through.</p>
      ${capabilities.libreoffice && capabilities.poppler
        ? `<div class="notice">Slides are rendered as designed.
           <details style="margin-top:.4rem"><summary>If a slide comes out with its text pushed into the pictures</summary>
             <p style="margin:.5rem 0 0">That is a font this server does not have. PowerPoint drew the text in one
             font, the renderer substituted another with different letter widths, and the wording reflowed onto more
             lines than the slide had room for. Stand-ins for Arial, Calibri, Cambria and Times are installed, but a
             brand font — or Microsoft's newer <b>Aptos</b> — has none.</p>
             <p style="margin:.5rem 0 0"><b>The fix takes a minute:</b> in PowerPoint choose <b>File → Save a Copy
             / Export → PDF</b> and upload the PDF here instead. A PDF carries its fonts inside it, so it renders
             exactly as you see it, every time. Everything else works the same — it is still split into slides.</p>
           </details></div>`
        : `<div class="notice error"><b>This server cannot render PowerPoint properly.</b>
           Missing: ${[capabilities.libreoffice ? null : 'LibreOffice', capabilities.poppler ? null : 'poppler (pdftoppm)'].filter(Boolean).join(' and ')}.
           Decks are rebuilt from their text and images instead, which loses the original layout, fonts and colours.
           <br>Deploy with the included <code class="token">Dockerfile</code> to get both, or export your deck to PDF and
           upload that instead — a PDF keeps the original look.</div>`}
      <div class="row"><button class="btn" id="s-new">New deck</button></div>
      ${rows.length ? rows.map((s) => `
        <div class="card section" data-show="${s.id}">
          <div class="row between">
            <div><h2 style="margin:0">${esc(s.name)}
              <span class="pill ${s.language === 'es' ? 'wait' : 'on'}">${s.language === 'es' ? 'Español' : 'English'}</span>
              <span class="pill ${s.active ? 'on' : 'off'}">${s.active ? 'active' : 'off'}</span></h2>
              <span class="muted">v${s.version} · ${s.slide_count} slide(s) · watched ${s.views} time(s)
              ${s.source_file ? `· from ${esc(s.source_file)}` : ''}</span>
              ${s.render_mode === 'rebuilt'
                ? '<div><span class="pill wait">rebuilt from text — not the original layout</span></div>'
                : s.render_mode === 'rendered'
                ? '<div><span class="pill on">rendered as designed</span></div>'
                : s.render_mode === 'pdf' ? '<div><span class="pill wait">embedded PDF</span></div>' : ''}</div>
            <div class="row" style="margin:0">
              <button class="btn ghost" data-preview="${s.id}">Preview</button>
              <button class="btn ghost" data-edit="${s.id}">Settings</button>
              <button class="btn ghost" data-del="${s.id}">Delete</button>
            </div>
          </div>
          ${pptxHint(s)}
          <div class="dropzone" data-drop="${s.id}">
            <p><b>Drop a PDF, .pptx or image here</b> — or
              <label class="btn subtle" style="display:inline-flex">Choose file<input type="file" hidden data-file="${s.id}"
                accept=".pdf,.pptx,.ppt,.odp,image/*"></label></p>
            <p class="muted"><b>A PDF is the safest thing to upload.</b> PowerPoint shrinks text to fit its boxes;
              the converter here does not, so a tight slide can come out with its words running under the pictures.
              Exporting from PowerPoint with <b>File → Export → PDF</b> settles the layout before it ever reaches
              this server. A .pptx works too, and usually looks right — check it with <b>Preview</b>.</p>
            <p class="muted">Uploading a deck replaces the current slides and bumps the version, so everyone sees the new induction once.</p>
          </div>
          <div class="slide-grid" data-slides="${s.id}" style="margin-top:1rem"></div>
        </div>`).join('')
        : '<div class="card section"><p class="empty">No induction decks yet. Create one, then upload your PowerPoint.</p></div>'}`;

    $('#s-new').addEventListener('click', () => deckSettings(null));
    $$('[data-edit]').forEach((b) => b.addEventListener('click', () => deckSettings(b.dataset.edit)));
    $$('[data-del]').forEach((b) => b.addEventListener('click', () => confirmAction('Delete this induction deck and its slides?',
      async () => { await api(`/slideshows/${b.dataset.del}`, { method: 'DELETE' }); render('induction'); })));
    $$('[data-preview]').forEach((b) => b.addEventListener('click', () => previewDeck(b.dataset.preview)));

    rows.forEach((s) => loadSlides(s.id));

    $$('[data-file]').forEach((input) => input.addEventListener('change', async () => {
      if (input.files[0]) await doUpload(input.dataset.file, input.files[0]);
    }));
    $$('[data-drop]').forEach((zone) => {
      ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('over'); }));
      ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, () => zone.classList.remove('over')));
      zone.addEventListener('drop', async (e) => {
        e.preventDefault();
        if (e.dataTransfer.files[0]) await doUpload(zone.dataset.drop, e.dataTransfer.files[0]);
      });
    });

    async function doUpload(showId, file) {
      toast(`Processing ${file.name}…`, 8000);
      try {
        const r = await upload(`/slideshows/${showId}/upload`, file);
        toast(r.note || `${r.count} slide(s) ready`, r.note ? 8000 : 3000);
        render('induction');
      } catch (err) {
        toast(err.data && err.data.error === 'unsupported_file_type'
          ? 'Please upload a .pptx, .pdf or image file' : 'Could not process that file');
      }
    }

    async function loadSlides(showId) {
      const slides = await api(`/slideshows/${showId}/slides`);
      const box = $(`[data-slides="${showId}"]`);
      if (!box) return;
      box.innerHTML = slides.map((s, i) => `<div class="slide-thumb">
        <span class="num">${i + 1}</span>
        <button data-slide-del="${showId}:${s.id}" title="Remove slide">✕</button>
        ${s.kind === 'image' ? `<img src="${esc(s.image_path)}" alt="">`
          : s.kind === 'pdf' ? '<div class="html-preview">PDF document</div>'
          : `<div class="html-preview">${s.html || ''}</div>`}</div>`).join('');
      $$('[data-slide-del]', box).forEach((b) => b.addEventListener('click', async () => {
        const [sid, slideId] = b.dataset.slideDel.split(':');
        await api(`/slideshows/${sid}/slides/${slideId}`, { method: 'DELETE' });
        loadSlides(sid);
      }));
    }
  };

  async function deckSettings(id) {
    const existing = id ? (await api('/slideshows')).rows.find((r) => String(r.id) === String(id)) : null;
    const req = existing ? JSON.parse(existing.required_for) : ['visitor', 'contractor'];
    modal(existing ? 'Deck settings' : 'New induction deck', `
      <label class="field"><span>Name</span><input class="input" id="dk-name" value="${esc(existing ? existing.name : 'Site induction')}"></label>
      <label class="field"><span>Description</span><input class="input" id="dk-desc" value="${esc(existing ? existing.description || '' : '')}"></label>
      <label class="field" style="max-width:16rem"><span>Language</span>
        <select class="input" id="dk-lang">
          <option value="en" ${!existing || existing.language !== 'es' ? 'selected' : ''}>English</option>
          <option value="es" ${existing && existing.language === 'es' ? 'selected' : ''}>Español</option>
        </select>
        <span class="muted">Upload the deck once per language. The kiosk shows the one matching the language chosen on
          screen, and falls back to English when there is no Spanish deck. Watching either language counts as having
          watched the induction.</span></label>
      <span class="muted">Show to these visitor types</span>
      <div class="form-grid" style="margin:.5rem 0 1rem">
        ${categories().map(([t, label]) => `<label class="check"><input type="checkbox" data-type="${t}" ${req.includes(t) ? 'checked' : ''}> ${label}</label>`).join('')}
      </div>
      <div class="form-grid">
        <label class="field"><span>Repeat after (days, 0 = never)</span>
          <input class="input" id="dk-repeat" type="number" min="0" value="${existing ? existing.repeat_after_days || 0 : 0}"></label>
        <label class="field"><span>Minimum seconds per slide</span>
          <input class="input" id="dk-min" type="number" min="0" value="${existing ? existing.min_seconds_per_slide : 0}">
          <span class="muted">Stops the deck being clicked through unread: Next shows a countdown and only
            unlocks once the time is up, on every slide not yet watched. 0 = no wait.</span></label>
      </div>
      <label class="check"><input type="checkbox" id="dk-sig" ${existing && existing.require_signature ? 'checked' : ''}>
        <span>Ask for a signature at the end<br><span class="muted">The confirmation screen after the last slide asks
          them to sign in a box, not just tap a button. The signature is kept on their induction record — proof they
          sat through it, the same as a signed document.</span></span></label>
      <label class="check"><input type="checkbox" id="dk-active" ${!existing || existing.active ? 'checked' : ''}> Active</label>`,
      async (bg, close) => {
        const body = {
          name: $('#dk-name', bg).value,
          description: $('#dk-desc', bg).value,
          required_for: $$('[data-type]', bg).filter((c) => c.checked).map((c) => c.dataset.type),
          repeat_after_days: Number($('#dk-repeat', bg).value) || null,
          min_seconds_per_slide: Number($('#dk-min', bg).value) || 0,
          language: $('#dk-lang', bg).value,
          require_signature: $('#dk-sig', bg).checked,
          active: $('#dk-active', bg).checked
        };
        if (existing) await api(`/slideshows/${existing.id}`, { method: 'PATCH', body });
        else await api('/slideshows', { method: 'POST', body });
        close();
        render('induction');
      });
  }

  async function previewDeck(id) {
    const slides = await api(`/slideshows/${id}/slides`);
    if (!slides.length) return toast('This deck has no slides yet');
    let i = 0;
    const m = modal('Preview', '<div id="pv-stage" style="background:#0d1512;border-radius:10px;min-height:340px;display:grid;place-items:center;padding:1rem"></div>'
      + '<div class="row between" style="margin-top:.75rem"><button class="btn ghost" id="pv-prev">Back</button><span class="muted" id="pv-n"></span><button class="btn" id="pv-next">Next</button></div>', null);
    const draw = () => {
      const s = slides[i];
      $('#pv-stage', m.bg).innerHTML = s.kind === 'image'
        ? `<img src="${esc(s.image_path)}" style="max-width:100%;max-height:60vh">`
        : s.kind === 'pdf' ? `<iframe src="${esc(s.image_path)}" style="width:100%;height:60vh;border:0;background:#fff"></iframe>`
        : `<div style="color:#fff">${s.html || ''}</div>`;
      $('#pv-n', m.bg).textContent = `${i + 1} of ${slides.length}`;
    };
    $('#pv-prev', m.bg).addEventListener('click', () => { i = Math.max(0, i - 1); draw(); });
    $('#pv-next', m.bg).addEventListener('click', () => { i = Math.min(slides.length - 1, i + 1); draw(); });
    draw();
  }

  /* ------------------------------------------------------------ documents */

  // The visitor types these documents can be attached to — the list managed on
  // the Visitor types tab, so a newly added type can be given documents at once.
  const MODE_HINT = { card: 'Own card on the home screen', picker: 'Offered behind Sign in', both: 'Card + Sign in picker', off: 'Currently hidden' };
  const categories = () => ((SETTINGS && SETTINGS.types) || []).map((ty) => [ty.key, ty.label, MODE_HINT[ty.mode] || '']);
  const categoryLabel = (t) => { const c = categories().find(([v]) => v === t); return c ? c[1] : t; };

  /** Map question ids back to the wording used at the time, for reading answers. */
  function questionLabels(questionsJson) {
    try {
      return JSON.parse(questionsJson || '[]').reduce((acc, q, i) => {
        acc[q.id || `q${i + 1}`] = q.label;
        return acc;
      }, {});
    } catch { return {}; }
  }

  VIEWS.documents = async (root) => {
    const rows = await api('/agreements');
    const parseQs = (a) => { try { return JSON.parse(a.questions || '[]'); } catch { return []; } };
    const countQuestions = (a) => parseQs(a).length;
    const spanishOn = !!(SETTINGS && SETTINGS.kiosk && SETTINGS.kiosk.spanish_enabled);

    /*
     * With Spanish offered on the kiosk, every document without its translation
     * is being shown to Spanish visitors in English. That fallback is deliberate
     * — but it must be visible here, not discovered by a contractor mid-sign-in.
     */
    const langPill = (a) => {
      if (!spanishOn) return '';
      const qs = parseQs(a);
      const translatedQs = qs.filter((q) => String(q.label_es || '').trim()).length;
      // An uploaded Spanish file counts as the Spanish wording, the same way
      // an uploaded English file replaces the typed English.
      const hasBody = docFilePages(a, false).length
        ? docFilePages(a, true).length > 0
        : !!(String(a.body_es || '').trim() || !String(a.body || '').trim());
      if (hasBody && translatedQs === qs.length) return '<span class="pill on">Español ✓</span>';
      if (!hasBody && !translatedQs) return '<span class="pill off" title="Open Edit and fill in the En español boxes">no Spanish — shows in English</span>';
      return `<span class="pill wait" title="Open Edit and fill in the En español boxes">Spanish incomplete${qs.length ? ` (${translatedQs}/${qs.length} questions)` : ''}</span>`;
    };

    root.innerHTML = `
      <h1 class="page">Documents to sign</h1>
      <p class="page-sub">NDAs, site rules and safety declarations. Each one is assigned to the categories that must sign it,
        and can ask its own questions before the signature. Deliveries do not sign anything.${spanishOn
          ? ' Spanish is offered on the kiosk, so each document also carries its Spanish wording — anything left untranslated is shown to Spanish visitors in English.' : ''}</p>
      <div class="row"><button class="btn" id="a-new">New document</button></div>
      ${rows.map((a) => `<div class="card section">
        <div class="row between"><div><h2 style="margin:0">${esc(a.name)} <span class="pill ${a.active ? 'on' : 'off'}">${a.active ? 'active' : 'off'}</span> ${langPill(a)}</h2>
        <span class="muted">v${a.version} · signed by ${esc(JSON.parse(a.required_for).map(categoryLabel).join(', ') || 'nobody')}${
          countQuestions(a) ? ` · ${countQuestions(a)} question${countQuestions(a) === 1 ? '' : 's'}` : ''}</span></div>
        <div class="row" style="margin:0"><button class="btn ghost" data-doc="${a.id}">Edit</button>
        <button class="btn ghost" data-docdel="${a.id}">Delete</button></div></div>
        ${docFilePages(a, false).length
    ? `<p class="muted" style="margin:0">📄 <b>${esc(a.source_file || 'Uploaded file')}</b> — ${docFilePages(a, false).length} page(s)${
      docFilePages(a, true).length ? `, plus ${esc(a.source_file_es || 'a Spanish file')} for Spanish` : ''}. Shown on the kiosk in place of typed wording.</p>`
    : `<pre class="muted" style="white-space:pre-wrap;margin:0">${esc(String(a.body || '').slice(0, 400))}${String(a.body || '').length > 400 ? '…' : ''}</pre>`}</div>`).join('')
        || '<div class="card section"><p class="empty">No documents yet.</p></div>'}`;
    $('#a-new').addEventListener('click', () => docEditor(null));
    $$('[data-doc]').forEach((b) => b.addEventListener('click', async () =>
      docEditor((await api('/agreements')).find((x) => String(x.id) === b.dataset.doc))));
    $$('[data-docdel]').forEach((b) => b.addEventListener('click', () => confirmAction('Delete this document?',
      async () => { await api(`/agreements/${b.dataset.docdel}`, { method: 'DELETE' }); render('documents'); })));
  };

  /** Pages already attached to a document, for one language. */
  function docFilePages(doc, es) {
    if (!doc) return [];
    try { return JSON.parse((es ? doc.pages_es : doc.pages) || '[]'); } catch { return []; }
  }

  /**
   * The upload control for one language. A file can only be attached to a
   * document that exists, so on a new document it says to save first rather
   * than offering a button that cannot work.
   */
  function docFileBlock(doc, es) {
    const label = es ? 'Archivo en español' : 'Or upload the document';
    if (!doc) {
      return `<p class="muted">${es ? 'Guarde el documento para poder subir un archivo.'
        : 'Save the document first, then reopen it to upload a PDF or Word file instead of typing the wording.'}</p>`;
    }
    const pages = docFilePages(doc, es);
    const source = es ? doc.source_file_es : doc.source_file;
    const mode = es ? doc.render_mode_es : doc.render_mode;
    const id = es ? 'es' : 'en';
    return `<div class="field">
      <span>${label}</span>
      ${pages.length ? `<div class="notice" style="margin:.4rem 0">
          <b>${esc(source || 'Uploaded file')}</b> — ${pages.length} page${pages.length === 1 ? '' : 's'}${
        mode === 'pdf' ? ', shown as a scrollable PDF' : mode === 'image' ? ', an image' : ', rendered as designed'}.
          <br><span class="muted">Shown on the kiosk instead of the wording above.</span>
        </div>
        <div class="row" style="margin:0">
          <label class="btn subtle">Replace file<input type="file" id="ag-file-${id}" accept=".pdf,.doc,.docx,.odt,.rtf,.txt,image/*" hidden></label>
          <button class="btn ghost" type="button" data-agfiledel="${id}">Remove file</button>
        </div>`
    : `<div class="row" style="margin:0">
          <label class="btn subtle">Upload PDF or Word<input type="file" id="ag-file-${id}" accept=".pdf,.doc,.docx,.odt,.rtf,.txt,image/*" hidden></label>
        </div>
        <span class="muted">Rendered to pages so it is read exactly as drafted. Leave empty to use the wording above.</span>`}
    </div>`;
  }

  function docEditor(doc) {
    const req = doc ? JSON.parse(doc.required_for) : ['visitor', 'contractor'];
    let questions = [];
    try { questions = JSON.parse((doc && doc.questions) || '[]'); } catch { questions = []; }

    const m = modal(doc ? 'Edit document' : 'New document', `
      <label class="field"><span>Title</span><input class="input" id="ag-name" value="${esc(doc ? doc.name : '')}"></label>
      <label class="field"><span>What they read and sign</span>
        <textarea class="input" id="ag-body" rows="10">${esc(doc ? doc.body : '')}</textarea></label>
      ${docFileBlock(doc, false)}

      <details class="howto" ${(doc && ((doc.name_es || '').trim() || (doc.body_es || '').trim()))
        || (SETTINGS && SETTINGS.kiosk && SETTINGS.kiosk.spanish_enabled) ? 'open' : ''}>
        <summary><b>En español</b> — shown when the kiosk is switched to Spanish</summary>
        <p class="muted" style="margin-top:.5rem">Leave a box empty and that part stays in English. The signature records
          which language was on screen when it was signed.</p>
        <label class="field"><span>Título</span><input class="input" id="ag-name-es" value="${esc((doc && doc.name_es) || '')}"></label>
        <label class="field"><span>Lo que leen y firman</span>
          <textarea class="input" id="ag-body-es" rows="10">${esc((doc && doc.body_es) || '')}</textarea></label>
        ${docFileBlock(doc, true)}
      </details>

      <h3>Who signs this</h3>
      <p class="muted" style="margin-top:0">Matched to the cards on the kiosk home screen.</p>
      <div class="form-grid" style="margin:.5rem 0 1rem">
        ${categories().map(([t, label, hint]) => `<label class="check"><input type="checkbox" data-t="${t}" ${req.includes(t) ? 'checked' : ''}>
          <span>${label}<br><span class="muted">${hint}</span></span></label>`).join('')}
      </div>

      <h3>Questions</h3>
      <p class="muted" style="margin-top:0">Asked on the kiosk before they finish. Answers are stored against the visit.</p>
      <div id="q-list"></div>
      <button class="btn subtle" id="q-add" type="button">Add a question</button>

      <h3>Signature</h3>
      <label class="check"><input type="checkbox" id="ag-sig" ${!doc || doc.require_signature !== 0 ? 'checked' : ''}>
        <span>Ask for a signature<br><span class="muted">Leave this off for a questionnaire — the visitor just answers
          the questions and carries on.</span></span></label>

      <label class="check" style="margin-top:1rem"><input type="checkbox" id="ag-active" ${!doc || doc.active ? 'checked' : ''}> Active</label>
      ${doc ? '<p class="muted">Saving bumps the version, so copies already signed stay exactly as they were signed.</p>' : ''}`,
      async (bg, close) => {
        const body = {
          name: $('#ag-name', bg).value,
          body: $('#ag-body', bg).value,
          name_es: $('#ag-name-es', bg).value.trim() || null,
          body_es: $('#ag-body-es', bg).value.trim() || null,
          required_for: JSON.stringify($$('[data-t]', bg).filter((c) => c.checked).map((c) => c.dataset.t)),
          questions: JSON.stringify(collectQuestions(bg)),
          require_signature: $('#ag-sig', bg).checked ? 1 : 0,
          active: $('#ag-active', bg).checked ? 1 : 0
        };
        if (!body.name.trim()) return toast('Give the document a title');
        if (doc) { body.version = doc.version + 1; await api(`/agreements/${doc.id}`, { method: 'PATCH', body }); }
        else await api('/agreements', { method: 'POST', body });
        close(); render('documents');
      });

    /*
     * Files are attached to the document itself, not to the form: uploading
     * saves straight away and reopens the editor on the updated document, so
     * what is on screen always matches what the kiosk will show.
     */
    ['en', 'es'].forEach((lang) => {
      const input = $(`#ag-file-${lang}`, m.bg);
      if (input) {
        input.addEventListener('change', async (e) => {
          const file = e.target.files[0];
          if (!file) return;
          toast('Uploading…', 8000);
          try {
            const out = await upload(`/agreements/${doc.id}/file?language=${lang}`, file);
            toast(out.method === 'rendered'
              ? `Uploaded — ${out.pages.length} page${out.pages.length === 1 ? '' : 's'} rendered`
              : out.method === 'pdf'
                ? 'Uploaded — shown as a scrollable PDF (install poppler for rendered pages)'
                : 'Uploaded', 5000);
            m.close();
            docEditor((await api('/agreements')).find((x) => x.id === doc.id));
            render('documents');
          } catch (err) {
            toast((err.data && err.data.error) === 'unsupported_file_type'
              ? 'That file type is not supported — use PDF, Word, ODT, RTF or text.'
              : 'Could not read that file', 5000);
          }
          e.target.value = '';
        });
      }
      const del = $(`[data-agfiledel="${lang}"]`, m.bg);
      if (del) {
        del.addEventListener('click', () => confirmAction(
          'Remove the uploaded file? The document goes back to the wording typed above.',
          async () => {
            await api(`/agreements/${doc.id}/file?language=${lang}`, { method: 'DELETE' });
            m.close();
            docEditor((await api('/agreements')).find((x) => x.id === doc.id));
            render('documents');
          }));
      }
    });

    const list = $('#q-list', m.bg);
    /*
     * A question can depend on an earlier answer — ask about the escort only when
     * they said they have no card. Only questions with fixed answers can be
     * depended on, since there is nothing dependable to match on free text.
     */
    const conditionValue = (q) => (q.show_if && q.show_if.id ? `${q.show_if.id}|${q.show_if.value}` : '');

    const conditionChoices = (index) => {
      const out = [];
      questions.slice(0, index).forEach((earlier) => {
        if (!earlier.label || !earlier.label.trim()) return;
        const answers = earlier.type === 'choice' ? (earlier.options || []) : earlier.type === 'yesno' ? ['Yes', 'No'] : [];
        const short = earlier.label.length > 40 ? `${earlier.label.slice(0, 40)}…` : earlier.label;
        answers.forEach((a) => out.push([`${earlier.id}|${a}`, `“${short}” is ${a}`]));
      });
      return out;
    };

    const drawQuestions = () => {
      list.innerHTML = questions.map((q, i) => `
        <div class="q-row" data-i="${i}">
          <div class="q-row-top">
            <input class="input" data-qlabel="${i}" placeholder="Question shown to the visitor" value="${esc(q.label || '')}">
            <select class="input" data-qtype="${i}">
              ${[['yesno', 'Yes / No'], ['text', 'Short answer'], ['choice', 'Choose one']]
                .map(([v, l]) => `<option value="${v}" ${q.type === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
            <button class="btn ghost" type="button" data-qup="${i}" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button>
            <button class="btn ghost" type="button" data-qdown="${i}" ${i === questions.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
            <button class="btn ghost" type="button" data-qdel="${i}" title="Remove">✕</button>
          </div>
          <input class="input" data-qdesc="${i}" style="margin-top:.5rem"
            placeholder="Help text shown under the question (optional)" value="${esc(q.description || '')}">
          ${q.type === 'choice' ? `<input class="input" data-qopts="${i}" style="margin-top:.5rem"
            placeholder="Options, separated by commas" value="${esc((q.options || []).join(', '))}">` : ''}
          <input class="input" data-qlabeles="${i}" style="margin-top:.5rem"
            placeholder="En español (optional — English is shown if empty)" value="${esc(q.label_es || '')}">
          ${String(q.description || '').trim() || String(q.description_es || '').trim() ? `<input class="input" data-qdesces="${i}" style="margin-top:.5rem"
            placeholder="Help text en español (optional)" value="${esc(q.description_es || '')}">` : ''}
          ${q.type === 'choice' ? `<input class="input" data-qoptses="${i}" style="margin-top:.5rem"
            placeholder="Options in Spanish, in the same order" value="${esc((q.options_es || []).join(', '))}">` : ''}
          <label class="field" style="margin:.5rem 0 0"><span>Only ask this if</span>
            <select class="input" data-qcond="${i}">
              <option value="">Always ask it</option>
              ${conditionChoices(i).map(([value, label]) =>
                `<option value="${esc(value)}" ${conditionValue(q) === value ? 'selected' : ''}>${esc(label)}</option>`).join('')}
            </select></label>
          <label class="check"><input type="checkbox" data-qreq="${i}" ${q.required ? 'checked' : ''}> Must be answered</label>
        </div>`).join('') || '<p class="muted">No questions — the visitor just reads and signs.</p>';

      $$('[data-qtype]', list).forEach((s) => s.addEventListener('change', () => {
        sync(); questions[Number(s.dataset.qtype)].type = s.value; drawQuestions();
      }));
      $$('[data-qdel]', list).forEach((b) => b.addEventListener('click', () => {
        sync(); questions.splice(Number(b.dataset.qdel), 1); drawQuestions();
      }));
      $$('[data-qup]', list).forEach((b) => b.addEventListener('click', () => {
        sync(); const i = Number(b.dataset.qup);
        [questions[i - 1], questions[i]] = [questions[i], questions[i - 1]]; drawQuestions();
      }));
      $$('[data-qdown]', list).forEach((b) => b.addEventListener('click', () => {
        sync(); const i = Number(b.dataset.qdown);
        [questions[i + 1], questions[i]] = [questions[i], questions[i + 1]]; drawQuestions();
      }));
    };

    // Pull whatever is currently typed back into the array before redrawing.
    const sync = () => {
      $$('[data-qlabel]', list).forEach((input) => { questions[Number(input.dataset.qlabel)].label = input.value; });
      $$('[data-qopts]', list).forEach((input) => {
        questions[Number(input.dataset.qopts)].options = input.value.split(',').map((o) => o.trim()).filter(Boolean);
      });
      $$('[data-qreq]', list).forEach((input) => { questions[Number(input.dataset.qreq)].required = input.checked; });
      $$('[data-qdesc]', list).forEach((input) => { questions[Number(input.dataset.qdesc)].description = input.value; });
      $$('[data-qlabeles]', list).forEach((input) => { questions[Number(input.dataset.qlabeles)].label_es = input.value; });
      $$('[data-qdesces]', list).forEach((input) => { questions[Number(input.dataset.qdesces)].description_es = input.value; });
      $$('[data-qoptses]', list).forEach((input) => {
        questions[Number(input.dataset.qoptses)].options_es = input.value.split(',').map((o) => o.trim()).filter(Boolean);
      });
      $$('[data-qcond]', list).forEach((select) => {
        const q = questions[Number(select.dataset.qcond)];
        if (!select.value) { delete q.show_if; return; }
        const [id, ...rest] = select.value.split('|');
        q.show_if = { id, value: rest.join('|') };
      });
    };

    function collectQuestions() {
      sync();
      const kept = questions.filter((q) => String(q.label || '').trim());
      const ids = new Set(kept.map((q) => q.id));
      return kept.map((q) => ({
        id: q.id,
        label: q.label.trim(),
        type: q.type || 'yesno',
        required: !!q.required,
        ...(String(q.description || '').trim() ? { description: q.description.trim() } : {}),
        ...(String(q.label_es || '').trim() ? { label_es: q.label_es.trim() } : {}),
        ...(String(q.description_es || '').trim() ? { description_es: q.description_es.trim() } : {}),
        ...(q.type === 'choice' ? { options: q.options || [] } : {}),
        ...(q.type === 'choice' && (q.options_es || []).length ? { options_es: q.options_es } : {}),
        // A condition pointing at a question that has since been deleted would
        // hide this one for ever, so it is dropped rather than kept dangling.
        ...(q.show_if && ids.has(q.show_if.id) ? { show_if: q.show_if } : {})
      }));
    }

    // Ids must survive reordering, or a condition would come to mean a different
    // question, so each new one takes the next unused number.
    const nextQuestionId = () => {
      const used = questions.map((q) => Number(String(q.id || '').replace(/\D/g, '')) || 0);
      return `q${Math.max(0, ...used) + 1}`;
    };

    $('#q-add', m.bg).addEventListener('click', () => {
      sync();
      questions.push({ id: nextQuestionId(), label: '', type: 'yesno', required: true });
      drawQuestions();
    });
    drawQuestions();
  }

  /* --------------------------------------------------------------- badges */

  // Common label stock, so nobody has to measure their own roll.
  const LABEL_SIZES = [
    [62, 100, 'Brother DK-11202 — 62 × 100 mm'],
    [62, 29, 'Brother DK-11209 — 62 × 29 mm'],
    [62, 60, 'Brother DK-11221 — 62 × 60 mm'],
    [54, 101, 'Dymo 99014 — 54 × 101 mm'],
    [89, 36, 'Dymo 99012 — 89 × 36 mm'],
    [101.6, 152.4, '4 × 6 inch shipping label'],
    [76.2, 50.8, '3 × 2 inch label'],
    [86, 54, 'Credit-card size — 86 × 54 mm']
  ];

  VIEWS.badges = async (root) => {
    SETTINGS = await api('/settings');
    const s = SETTINGS;
    const b = s.badge;
    const data = await api('/badges');

    const chk = (path, label, help) => `<label class="check"><input type="checkbox" data-set="${path}"
      ${getPath(s, path) ? 'checked' : ''}> <span>${label}${help ? `<br><span class="muted">${help}</span>` : ''}</span></label>`;
    const txt = (path, label, type = 'text') => `<label class="field"><span>${label}</span>
      <input class="input" data-set="${path}" type="${type}" value="${esc(getPath(s, path) ?? '')}"></label>`;
    const isPreset = LABEL_SIZES.some(([w, h]) => Number(b.label_width_mm) === w && Number(b.label_height_mm) === h);

    root.innerHTML = `
      <h1 class="page">Badges</h1>
      <p class="page-sub">What a printed badge shows, the label it prints on, and reprinting one that has been lost.</p>

      <div class="card section">
        <div class="check-list">
          ${chk('badge.enabled', 'Print a badge when someone signs in',
            'Leave this off if no label printer is connected — everything else works either way')}
          ${chk('badge.auto_print', 'Print automatically', 'Off means the visitor taps “Print badge” themselves')}
        </div>
      </div>

      <div class="grid two">
        <div class="card section">
          <h2>Label size</h2>
          <label class="field"><span>Label stock</span>
            <select class="input" id="label-preset">
              ${LABEL_SIZES.map(([w, h, name]) =>
                `<option value="${w}x${h}" ${Number(b.label_width_mm) === w && Number(b.label_height_mm) === h ? 'selected' : ''}>${name}</option>`).join('')}
              <option value="custom" ${isPreset ? '' : 'selected'}>Custom size…</option>
            </select></label>
          <div class="form-grid">
            ${txt('badge.label_width_mm', 'Width (mm)', 'number')}
            ${txt('badge.label_height_mm', 'Height (mm)', 'number')}
          </div>
          <label class="field"><span>Which way it prints on the label</span>
            <select class="input" data-set="badge.orientation">
              <option value="portrait" ${b.orientation !== 'landscape' ? 'selected' : ''}>Vertical — reads down the label</option>
              <option value="landscape" ${b.orientation === 'landscape' ? 'selected' : ''}>Horizontal — reads across the label</option>
            </select>
            <span class="muted">The label itself does not change size; the badge is turned on it</span></label>
          <label class="field"><span>Text size — <b id="scale-value">${b.font_scale}</b>×</span>
            <input type="range" min="0.6" max="1.6" step="0.05" id="badge-scale" data-set="badge.font_scale" value="${b.font_scale}"></label>
          <h3>Wording</h3>
          <div class="field-list">
            ${txt('badge.title_text', 'Header')}
            ${txt('badge.footer_text', 'Footer')}
            ${txt('badge.badge_prefix', 'Badge number prefix')}
          </div>
        </div>

        <div class="card section">
          <h2>What the badge shows</h2>
          <div class="check-list">
            ${chk('badge.show_logo', 'Logo')}
            ${chk('badge.show_photo', 'Photo')}
            ${chk('badge.show_company', 'Company')}
            ${chk('badge.show_host', 'Who they are visiting')}
            ${chk('badge.show_date', 'Date')}
            ${chk('badge.show_time', 'Time')}
            ${chk('badge.show_badge_no', 'Badge number')}
            ${chk('badge.show_qr', 'QR code', 'Scannable at the kiosk to sign out')}
          </div>
        </div>
      </div>

      <div class="card section">
        <h2>Preview</h2>
        <p class="muted" style="margin-top:0">Shown at the real label size, updating as you change things.</p>
        <div class="badge-preview-wrap">
          <div class="badge-preview" id="badge-preview"></div>
          <div>
            <div class="row"><button class="btn" id="badge-save">Save badge settings</button>
              <button class="btn subtle" id="badge-test">Print a test badge</button></div>
            <p class="muted" style="max-width:32rem">Connect the label printer to the device showing the kiosk and make
              it the default printer. In Chrome or Edge set margins to <b>None</b>, turn headers and footers off and
              background graphics on. On iPad, AirPrint remembers the printer you pick. Print a test badge and adjust the
              size until it lines up.</p>
          </div>
        </div>
      </div>

      <div class="card section">
        <h2>Reprint a badge</h2>
        <p class="muted" style="margin-top:0">Badges from the last week. Reprinting does not change the visit — it
          prints the same badge again, issuing a number first if that visit never had one.</p>
        <div class="row">
          <input class="input" id="badge-q" placeholder="Search name, company or badge number" style="max-width:20rem">
        </div>
        <div class="table-wrap" id="badge-list"></div>
      </div>`;

    const drawList = () => {
      const q = ($('#badge-q').value || '').toLowerCase();
      const rows = data.issued.filter((r) => !q
        || (r.full_name || '').toLowerCase().includes(q)
        || (r.company || '').toLowerCase().includes(q)
        || (r.badge_no || '').toLowerCase().includes(q));
      $('#badge-list').innerHTML = rows.length ? `<table>
        <thead><tr><th></th><th>Name</th><th>Company</th><th>Badge</th><th>Signed in</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td>${r.photo_path ? `<img class="avatar" src="${esc(r.photo_path)}" alt="">` : '<div class="avatar"></div>'}</td>
          <td><b>${esc(r.full_name)}</b></td>
          <td>${esc(r.company || '')}</td>
          <td>${esc(r.badge_no || '—')}</td>
          <td>${fmtDate(r.signed_in_at)}</td>
          <td><span class="pill ${r.status === 'onsite' ? 'on' : 'off'}">${esc(r.status)}</span></td>
          <td><button class="btn ghost" data-reprint="${r.id}">Reprint</button></td></tr>`).join('')}</tbody></table>`
        : '<p class="empty">No badges issued in the last week.</p>';
      $$('[data-reprint]').forEach((btn) => btn.addEventListener('click', () => reprintBadge(btn.dataset.reprint)));
    };
    drawList();
    $('#badge-q').addEventListener('input', drawList);

    // The preset and the custom boxes stay in step with each other.
    $('#label-preset').addEventListener('change', (e) => {
      if (e.target.value === 'custom') return;
      const [w, h] = e.target.value.split('x');
      $('[data-set="badge.label_width_mm"]').value = w;
      $('[data-set="badge.label_height_mm"]').value = h;
      drawBadgePreview();
    });
    $$('[data-set^="badge."]').forEach((input) => input.addEventListener('input', () => {
      if (input.id === 'badge-scale') $('#scale-value').textContent = input.value;
      drawBadgePreview();
    }));

    $('#badge-test').addEventListener('click', printTestBadge);
    $('#badge-save').addEventListener('click', async () => {
      const patch = {};
      $$('[data-set^="badge."]').forEach((input) => {
        const value = input.type === 'checkbox' ? input.checked
          : (input.type === 'number' || input.type === 'range') ? Number(input.value)
          : input.value;
        setPath(patch, input.dataset.set, value);
      });
      SETTINGS = await api('/settings', { method: 'PUT', body: patch });
      toast('Badge settings saved');
    });

    drawBadgePreview();
  };

  /** Print one visitor's badge again, using the current design. */
  async function reprintBadge(visitId) {
    const { visit, badge, org } = await api(`/visits/${visitId}/badge`, { method: 'POST' });
    const meta = [
      badge.show_host && visit.host_name ? `Visiting: ${visit.host_name}` : '',
      // The site's clock, so a reprint from a laptop in another zone still
      // carries the date and time the visitor actually arrived on site.
      badge.show_date ? new Date(visit.signed_in_at).toLocaleDateString(org.date_format || 'en-GB', { timeZone: siteZone() }) : '',
      badge.show_time ? new Date(visit.signed_in_at).toLocaleTimeString(org.date_format || 'en-GB', { hour: '2-digit', minute: '2-digit', timeZone: siteZone() }) : '',
      badge.show_badge_no && visit.badge_no ? visit.badge_no : ''
    ].filter(Boolean).join('<br>');

    openBadgeWindow(badge, `
      ${badge.show_logo && org.logo_path ? `<img class="logo" src="${esc(org.logo_path)}">` : ''}
      <div class="type">${esc(badge.title_text || String(visit.visit_type).toUpperCase())}</div>
      ${badge.show_photo && visit.photo_path ? `<img class="photo" src="${esc(visit.photo_path)}">` : ''}
      <div class="name">${esc(visit.full_name)}</div>
      ${badge.show_company && visit.company ? `<div class="company">${esc(visit.company)}</div>` : ''}
      <div class="meta">${meta}</div>
      ${badge.show_qr && visit.checkout_code ? `<div class="qr"><img src="/api/qr?text=${encodeURIComponent(visit.checkout_code)}"></div>` : ''}
      <div class="foot">${esc(badge.footer_text || '')}</div>`);
    toast(`Reprinting badge ${visit.badge_no}`);
  }

  /** A print window sized to the label, sharing one layout with the kiosk. */
  function openBadgeWindow(b, innerHtml) {
    const landscape = b.orientation === 'landscape';
    // The label is the size it is; a horizontal badge is rotated onto it.
    const cardW = landscape ? b.label_height_mm : b.label_width_mm;
    const cardH = landscape ? b.label_width_mm : b.label_height_mm;
    const turn = landscape ? `transform: translateX(${b.label_width_mm}mm) rotate(90deg); transform-origin: top left;` : '';

    const w = window.open('', '_blank', 'width=420,height=640');
    w.document.write(`<!doctype html><title>Badge</title><style>
      @page { size: ${b.label_width_mm}mm ${b.label_height_mm}mm; margin: 0; }
      body { margin:0; font-family: system-ui, "Segoe UI", Arial, sans-serif;
             width:${b.label_width_mm}mm; height:${b.label_height_mm}mm; overflow:hidden; }
      .card { width:${cardW}mm; height:${cardH}mm; padding:4mm; display:flex; ${turn}
              flex-direction:column; align-items:center; text-align:center; box-sizing:border-box; overflow:hidden; }
      .logo { max-height:10mm; max-width:40mm; }
      .type { font-weight:800; letter-spacing:.18em; font-size:calc(4.4mm * ${b.font_scale || 1}); }
      .photo { width:30mm; height:30mm; object-fit:cover; border-radius:2mm; margin:2mm 0; }
      .name { font-weight:800; font-size:calc(5.6mm * ${b.font_scale || 1}); line-height:1.15; margin-top:1mm; }
      .company { font-size:calc(3.6mm * ${b.font_scale || 1}); margin-top:1mm; }
      .meta { font-size:calc(3.2mm * ${b.font_scale || 1}); margin-top:1.5mm; line-height:1.4; }
      .qr { width:22mm; margin-top:auto; } .qr img { width:100%; }
      .foot { font-size:calc(2.6mm * ${b.font_scale || 1}); margin-top:1.5mm; }
    </style><div class="card">${innerHtml}</div>`);
    w.document.close();
    // Give the photo and QR a moment to load, or they print blank.
    setTimeout(() => w.print(), 700);
  }

  /* ---------------------------------------------------------------- staff */

  VIEWS.staff = async (root) => {
    const rows = await api('/staff');
    root.innerHTML = `
      <h1 class="page">Staff</h1>
      <p class="page-sub">The people visitors can ask for. Each staff member can have their own email, mobile and chat webhook for arrival alerts.</p>
      <div class="card section">
        <div class="inline-form" style="margin-bottom:1rem">
          <label class="field"><span>Name</span><input class="input" id="h-name"></label>
          <label class="field"><span>Email</span><input class="input" id="h-email" type="email"></label>
          <label class="field"><span>Mobile (for SMS)</span><input class="input" id="h-phone" type="tel"></label>
          <label class="field"><span>Department</span><input class="input" id="h-dept"></label>
          <label class="field"><span>Chat webhook (optional)</span><input class="input" id="h-hook" placeholder="Slack / Teams URL"></label>
          <button class="btn" id="h-add">Add staff member</button>
        </div>
        <div class="table-wrap">${rows.length ? `<table>
          <thead><tr><th>Name</th><th>Email</th><th>Mobile</th><th>Department</th><th>Webhook</th><th>Status</th><th></th></tr></thead>
          <tbody>${rows.map((h) => `<tr><td><b>${esc(h.name)}</b></td><td>${esc(h.email || '')}</td>
            <td>${esc(h.phone || '')}</td>
            <td>${esc(h.department || '')}</td><td class="muted">${h.webhook_url ? 'configured' : '—'}</td>
            <td><span class="pill ${h.active ? 'on' : 'off'}">${h.active ? 'active' : 'off'}</span></td>
            <td><button class="btn ghost" data-hedit="${h.id}">Edit</button>
                <button class="btn ghost" data-hdel="${h.id}">Remove</button></td></tr>`).join('')}</tbody></table>`
          : '<p class="empty">No staff yet — add the people visitors come to see.</p>'}</div>
      </div>

      <div class="card section">
        <h2>Add several at once from a spreadsheet</h2>
        <p class="muted" style="margin-top:0">Upload an Excel file (<b>.xlsx</b>) or a <b>.csv</b>. The first row should be
          headings — <i>First name</i>, <i>Last name</i>, <i>Email</i>, <i>Phone</i>, <i>Department</i>,
          <i>Chat webhook</i>. Only the name is required, and headings can be worded your way: a single
          <i>Full name</i> column works just as well as separate first and last, and “Mobile”, “Surname”, “Team” and
          similar are all understood.</p>
        <p class="muted">Someone already on the list is updated rather than duplicated, matched on email, or on name when
          there is no email — so you can fix a sheet and upload it again.</p>
        <div class="row">
          <label class="btn subtle">Choose spreadsheet<input type="file" hidden id="staff-file" accept=".xlsx,.xlsm,.csv,.txt"></label>
          <a class="btn ghost" href="/api/admin/staff/template.csv">Download a template</a>
        </div>
        <div id="import-result"></div>
      </div>

      <div class="card section">
        <h2>Setting up a chat webhook</h2>
        <p class="muted" style="margin-top:0">A webhook posts arrivals straight into a Slack channel, a Teams
          channel or a Google Chat space — no email needed. Paste the URL into a staff member's <b>Chat webhook</b> field
          above and that person's arrivals go to that channel. Leave it blank and the fallback webhook in
          <b>Settings → Notifications</b> is used instead. The format is detected from the URL, so different people
          can be on different platforms.</p>

        <details class="howto">
          <summary><b>Slack</b> — posts with the visitor's photo</summary>
          <ol>
            <li>Go to <b>api.slack.com/apps</b> → <b>Create New App</b> → <b>From scratch</b>. Name it
              “Smart Lobby” and pick your workspace.</li>
            <li>In the left menu choose <b>Incoming Webhooks</b> and switch it <b>On</b>.</li>
            <li>Click <b>Add New Webhook to Workspace</b>, choose the channel (or a direct message to that person),
              then <b>Allow</b>.</li>
            <li>Copy the URL — it looks like
              <code class="token">https://hooks.slack.com/services/T00000/B00000/XXXX</code>.</li>
            <li>Paste it into the host's <b>Chat webhook</b> box above and click <b>Add staff member</b> (or edit an
              existing one).</li>
          </ol>
          <p class="muted">Repeat steps 3–5 for each channel you want to post to; one app can hold many webhooks.</p>
        </details>

        <details class="howto">
          <summary><b>Microsoft Teams</b> — to a channel, or as a direct message to one person</summary>
          <p><b>To a channel</b></p>
          <ol>
            <li>In Teams, hover the channel → <b>⋯</b> → <b>Workflows</b>.</li>
            <li>Choose the template <b>“Post to a channel when a webhook request is received”</b>.</li>
            <li>Name it “Smart Lobby”, confirm the team and channel, then <b>Add workflow</b>.</li>
            <li>Copy the HTTPS URL it shows you — you only get it once.</li>
            <li>Paste it into the staff member's <b>Chat webhook</b> box above.</li>
          </ol>
          <p><b>To one person (a DM)</b> — use this when a site manager should be pinged directly rather than
            in a shared channel. To send it to <i>yourself</i>, start from a chat with yourself.</p>
          <ol>
            <li>In Teams, click <b>New chat</b>, type your own name and pick yourself — Teams opens a chat with
              you. (For someone else, just open your chat with them.)</li>
            <li>Hover that chat in the list → <b>⋯</b> → <b>Workflows</b>. Or open the <b>Workflows</b> app from
              the left rail and choose <b>+ New flow</b>.</li>
            <li>Choose the template <b>“Post to a chat when a webhook request is received”</b> — the
              <i>chat</i> one, not the channel one.</li>
            <li>Confirm the chat it will post into, then <b>Add workflow</b>, and copy the URL. You only get it once.</li>
            <li>Paste it into that person's <b>Chat webhook</b> box above. Only their visitors trigger it.</li>
          </ol>
          <p class="muted"><b>If the chat template is not offered</b> — some tenants only expose the channel one.
            Go to <b>make.powerautomate.com</b> → <b>Create</b> → <b>Automated cloud flow</b>, pick the trigger
            <b>“When a Teams webhook request is received”</b> and set <i>Who can trigger</i> to <b>Anyone</b>. Add
            the action <b>“Post message in a chat or channel”</b> with <i>Post as</i> = <b>Flow bot</b>,
            <i>Post in</i> = <b>Chat with Flow bot</b> and <i>Recipient</i> = your own address. Save, then copy the
            trigger's HTTP URL.</p>
          <p class="muted">The message arrives from <b>Flow bot</b> rather than from a person, which is normal.
            Some tenants restrict the chat template — if you cannot see it, your IT admin controls that.
            Microsoft is also retiring the older Office 365 connectors; if your tenant still offers
            <b>⋯ → Connectors → Incoming Webhook</b> it works, but it is channel-only and going away.</p>
        </details>

        <details class="howto">
          <summary><b>Google Chat</b></summary>
          <ol>
            <li>Open the space in Google Chat and click the space name at the top.</li>
            <li>Choose <b>Apps &amp; integrations</b> → <b>Webhooks</b> → <b>Add webhook</b>.</li>
            <li>Name it “Smart Lobby” and click <b>Save</b>.</li>
            <li>Copy the URL — it starts with
              <code class="token">https://chat.googleapis.com/v1/spaces/…</code>.</li>
            <li>Paste it into the staff member's <b>Chat webhook</b> box above.</li>
          </ol>
          <p class="muted">Webhooks are only available in spaces, not in one-to-one chats, and your Workspace
            admin must allow them.</p>
        </details>

        <details class="howto">
          <summary><b>Anything else</b> — Mattermost, n8n, Zapier, your own endpoint</summary>
          <p>Paste any URL that accepts a JSON POST. Unrecognised URLs use the format set in
            <b>Settings → Notifications</b>; choose <b>Generic JSON</b> there to receive:</p>
          <pre class="token" style="white-space:pre-wrap">{ "event": "Sam Taylor has arrived to see Alex Green",
  "details": ["Visitor: Sam Taylor (Acme Roofing)", "Type: contractor", "..."],
  "photo_url": "https://…/media/private/photos/….jpg",
  "timestamp": "2026-08-25T13:41:11.955Z" }</pre>
        </details>

        <p class="muted">To check a webhook before a real visitor uses it, paste it into
          <b>Settings → Notifications → Fallback chat webhook</b> and press <b>Send test webhook</b>. Every attempt,
          successful or not, is recorded against the visit under <b>Visits → View</b>.</p>
      </div>`;
    $('#h-add').addEventListener('click', async () => {
      if (!$('#h-name').value.trim()) return toast('Enter a name');
      await api('/staff', { method: 'POST', body: {
        name: $('#h-name').value.trim(), email: $('#h-email').value.trim(), phone: $('#h-phone').value.trim(),
        department: $('#h-dept').value.trim(), webhook_url: $('#h-hook').value.trim(), active: 1 } });
      render('staff');
    });
    $$('[data-hdel]').forEach((b) => b.addEventListener('click', () => confirmAction(
      'Remove this person? Past visits keep their name; they just stop being offered on the kiosk.',
      async () => { await api(`/staff/${b.dataset.hdel}`, { method: 'DELETE' }); render('staff'); })));

    $$('[data-hedit]').forEach((b) => b.addEventListener('click', () => {
      const person = rows.find((x) => String(x.id) === b.dataset.hedit);
      const m = modal(`Edit ${person.name}`, `
        <div class="form-grid">
          <label class="field"><span>Name</span><input class="input" id="se-name" value="${esc(person.name)}"></label>
          <label class="field"><span>Email</span><input class="input" id="se-email" type="email" value="${esc(person.email || '')}"></label>
          <label class="field"><span>Mobile (for SMS)</span><input class="input" id="se-phone" type="tel" value="${esc(person.phone || '')}"></label>
          <label class="field"><span>Department</span><input class="input" id="se-dept" value="${esc(person.department || '')}"></label>
        </div>
        <label class="field"><span>Chat webhook</span>
          <input class="input" id="se-hook" placeholder="Slack, Teams or Google Chat URL" value="${esc(person.webhook_url || '')}"></label>
        <div class="row"><button class="btn subtle" type="button" id="se-test">Send a test to this webhook</button></div>
        <div id="se-test-result"></div>
        <label class="check"><input type="checkbox" id="se-active" ${person.active ? 'checked' : ''}>
          <span>Offered on the kiosk<br><span class="muted">Switch off for someone who has left, without losing their history</span></span></label>`,
        async (bg, close) => {
          await api(`/staff/${person.id}`, { method: 'PATCH', body: {
            name: $('#se-name', bg).value.trim(),
            email: $('#se-email', bg).value.trim(),
            phone: $('#se-phone', bg).value.trim(),
            department: $('#se-dept', bg).value.trim(),
            webhook_url: $('#se-hook', bg).value.trim(),
            active: $('#se-active', bg).checked ? 1 : 0
          } });
          close(); render('staff');
        });

      // Tests whatever is currently in the box, so a URL can be proved before saving.
      $('#se-test', m.bg).addEventListener('click', async () => {
        const box = $('#se-test-result', m.bg);
        box.innerHTML = '<p class="muted">Sending…</p>';
        const r = await api(`/staff/${person.id}/test-webhook`, {
          method: 'POST', body: { url: $('#se-hook', m.bg).value.trim() }
        });
        box.innerHTML = r.ok
          ? '<div class="notice"><b>Delivered.</b> Check the chat it should have landed in.</div>'
          : `<div class="notice error"><b>Not delivered.</b> ${esc(r.detail || r.error || '')}</div>`;
      });
    }));

    $('#staff-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const box = $('#import-result');
      box.innerHTML = '<p class="muted">Reading the spreadsheet…</p>';
      try {
        const r = await upload('/staff/import', file);
        const bits = [`<b>${r.created}</b> added`, `<b>${r.updated}</b> updated`];
        if (r.skipped.length) bits.push(`<b>${r.skipped.length}</b> skipped`);
        box.innerHTML = `<div class="notice">${bits.join(' · ')}
          ${r.skipped.length ? `<br><span class="muted">Skipped rows: ${r.skipped.map((s) => `line ${s.line} (${esc(s.reason)})`).join(', ')}</span>` : ''}</div>`;
        setTimeout(() => render('staff'), 1200);
      } catch (err) {
        const reason = {
          no_name_column: 'Could not find a Name column. The first row should be headings.',
          unsupported_file_type: 'Please upload a .xlsx or .csv file.',
          old_excel_format: 'That is the older .xls format — open it in Excel and save as .xlsx or .csv.',
          empty_file: 'That spreadsheet appears to be empty.',
          not_a_zip: 'That file could not be read as a spreadsheet.'
        }[err.data && err.data.error] || 'That spreadsheet could not be read.';
        box.innerHTML = `<div class="notice error">${esc(reason)}</div>`;
      }
      e.target.value = '';
    });
  };

  /* --------------------------------------------------------------- access */

  VIEWS.access = async (root) => {
    const [points, events] = await Promise.all([api('/access-points'), api('/access-events')]);
    root.innerHTML = `
      <h1 class="page">Access &amp; doors</h1>
      <p class="page-sub">Each door is an HTTP call to your relay or access controller — Shelly, Tasmota, ESPHome,
        Home Assistant or any webhook. Placeholders <code class="token">{{seconds}}</code>, <code class="token">{{door}}</code>,
        <code class="token">{{actor}}</code> are filled in at unlock time.</p>
      <div class="row"><button class="btn" id="ap-new">Add door</button></div>
      ${points.length ? points.map((p) => `<div class="card section">
        <div class="row between"><div><h2 style="margin:0">${esc(p.name)} <span class="pill ${p.enabled ? 'on' : 'off'}">${p.enabled ? 'enabled' : 'off'}</span></h2>
        <span class="muted">${esc(p.method)} ${esc(p.url || '')}</span></div>
        <div class="row" style="margin:0"><button class="btn subtle" data-fire="${p.id}">Test unlock</button>
        <button class="btn ghost" data-apedit="${p.id}">Edit</button>
        <button class="btn ghost" data-apdel="${p.id}">Delete</button></div></div>
        <p class="muted">Auto-unlock on sign-in: ${p.auto_unlock_on_signin ? 'yes' : 'no'} ·
          on sign-out: ${p.auto_unlock_on_signout ? 'yes' : 'no'} · hold ${p.unlock_seconds}s</p>
        ${p.notes ? `<pre class="muted" style="white-space:pre-wrap;margin:.5rem 0 0">${esc(p.notes)}</pre>` : ''}</div>`).join('')
        : '<div class="card section"><p class="empty">No doors configured.</p></div>'}
      <div class="card section">
        <h2>Wiring this to an access control panel</h2>
        <p class="muted" style="margin-top:0">Smart Lobby only ever makes an HTTP call. A panel — Honeywell, Paxton,
          Net2 or anything else — is reached through a small relay module on the same network: Smart Lobby calls the
          relay, the relay closes a contact for a moment, and the panel treats it exactly like a button on the wall.
          Nothing needs to be added to the panel's own software.</p>
        <details class="howto">
          <summary><b>Honeywell panel — how it goes together</b></summary>
          <ol>
            <li>Fit a network relay module (a Shelly 1 or similar dry-contact relay) near the panel, on the same
              network as this server.</li>
            <li>Wire its output contacts across the door's <b>REX / request-to-exit</b> input, or a spare auxiliary
              input configured to release that door — the same terminals a push-to-exit button uses.</li>
            <li>Set the relay to <b>momentary</b>, matching the unlock hold you set here, so it pulses rather than
              latching the door open.</li>
            <li>Add the door here with <b>Honeywell panel via relay module</b> and the relay's address, then press
              <b>Test unlock</b>. Every attempt is logged below with what came back.</li>
          </ol>
          <p class="muted">Wiring into a REX input keeps the panel in charge of the door: its own schedules,
            interlocks and fire release still apply, and the panel's log still records the release. Have your
            installer confirm which terminals to use — that is a decision about the door, not about this software.</p>
        </details>
        <details class="howto">
          <summary><b>Setting it up before it is wired</b></summary>
          <p>Add the door now with a name and whatever you know, write the panel, door and terminals into the
            wiring notes, and leave <b>Enabled</b> unticked. It stays listed, appears in no kiosk, and is never
            called. When the relay goes in, put its address in and tick Enabled.</p>
        </details>
      </div>

      <div class="card section"><h2>Recent unlock events</h2>
        ${events.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Door</th><th>Actor</th><th>Source</th><th>Result</th></tr></thead>
        <tbody>${events.map((e) => `<tr><td>${fmtDate(e.created_at)}</td><td>${esc(e.access_point_name || '')}</td>
          <td>${esc(e.actor || '')}</td><td>${esc(e.trigger_source || '')}</td>
          <td><span class="pill ${e.result === 'ok' ? 'on' : 'off'}">${esc(e.result)}</span> <span class="muted">${esc(e.detail || '')}</span></td></tr>`).join('')}</tbody></table></div>`
          : '<p class="empty">No unlocks recorded yet.</p>'}</div>`;

    $('#ap-new').addEventListener('click', () => doorEditor(null));
    $$('[data-apedit]').forEach((b) => b.addEventListener('click', () => doorEditor(points.find((p) => String(p.id) === b.dataset.apedit))));
    $$('[data-apdel]').forEach((b) => b.addEventListener('click', () => confirmAction('Delete this door?',
      async () => { await api(`/access-points/${b.dataset.apdel}`, { method: 'DELETE' }); render('access'); })));
    $$('[data-fire]').forEach((b) => b.addEventListener('click', async () => {
      const r = await api(`/access-points/${b.dataset.fire}/trigger`, { method: 'POST' });
      toast(r.ok ? `Unlocked (${r.detail})` : `Failed: ${r.detail || r.error}`);
      render('access');
    }));
  };

  /*
   * Ways a door gets opened. Smart Lobby only ever makes an HTTP call, so any
   * panel is reached through a relay module that closes a contact — which is how
   * a Honeywell, Paxton or any other board is wired to a third-party trigger.
   */
  const DOOR_TEMPLATES = {
    honeywell: {
      label: 'Honeywell panel via relay module',
      url: 'http://192.168.1.50/relay/0?turn=on&timer={{seconds}}',
      method: 'GET', headers: '', body: '',
      notes: 'Relay output wired across the REX (request-to-exit) or auxiliary input on the Honeywell panel.\n'
        + 'Panel: \nDoor / reader: \nTerminals: \nRelay module IP: '
    },
    shelly: {
      label: 'Shelly relay',
      url: 'http://192.168.1.50/relay/0?turn=on&timer={{seconds}}',
      method: 'GET', headers: '', body: '', notes: ''
    },
    tasmota: {
      label: 'Tasmota relay',
      url: 'http://192.168.1.50/cm?cmnd=Power%20On',
      method: 'GET', headers: '', body: '', notes: ''
    },
    homeassistant: {
      label: 'Home Assistant',
      url: 'http://192.168.1.10:8123/api/services/lock/unlock',
      method: 'POST',
      headers: '{"Authorization":"Bearer YOUR_LONG_LIVED_TOKEN"}',
      body: '{"entity_id":"lock.front_door"}', notes: ''
    },
    webhook: { label: 'Something else', url: '', method: 'POST', headers: '', body: '', notes: '' }
  };

  function doorEditor(p) {
    const m = modal(p ? 'Edit door' : 'Add door', `
      <div class="form-grid">
        <label class="field"><span>Name</span><input class="input" id="ap-name" value="${esc(p ? p.name : 'Front door')}"></label>
        <label class="field"><span>How it is opened</span><select class="input" id="ap-template">
          <option value="">— choose to fill in the rest —</option>
          ${Object.entries(DOOR_TEMPLATES).map(([k, t]) => `<option value="${k}">${t.label}</option>`).join('')}
        </select></label>
      </div>
      <div class="form-grid">
        <label class="field"><span>Method</span><select class="input" id="ap-method">
          ${['POST', 'GET', 'PUT'].map((m) => `<option ${p && p.method === m ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
        <label class="field"><span>Unlock hold (seconds)</span>
          <input class="input" id="ap-secs" type="number" min="1" value="${p ? p.unlock_seconds : 5}"></label>
      </div>
      <label class="field"><span>URL</span><input class="input" id="ap-url" placeholder="http://192.168.1.50/relay/0?turn=on&amp;timer={{seconds}}"
        value="${esc(p ? p.url || '' : '')}"></label>
      <label class="field"><span>Headers (JSON, optional)</span><input class="input" id="ap-headers"
        placeholder='{"Authorization":"Bearer …"}' value="${esc(p ? p.headers || '' : '')}"></label>
      <label class="field"><span>Body template (optional)</span><textarea class="input" id="ap-body" rows="3"
        placeholder='{"action":"unlock","seconds":{{seconds}}}'>${esc(p ? p.body || '' : '')}</textarea></label>
      <label class="field"><span>Wiring notes</span>
        <textarea class="input" id="ap-notes" rows="4"
          placeholder="Panel, door, terminals, relay address — whatever the installer will need">${esc(p ? p.notes || '' : '')}</textarea>
        <span class="muted">For your own record. Nothing here is sent anywhere.</span></label>

      <label class="check"><input type="checkbox" id="ap-in" ${p && p.auto_unlock_on_signin ? 'checked' : ''}> Unlock automatically when a visitor signs in</label>
      <label class="check"><input type="checkbox" id="ap-out" ${p && p.auto_unlock_on_signout ? 'checked' : ''}> Unlock automatically when a visitor signs out</label>
      <label class="check"><input type="checkbox" id="ap-en" ${!p || p.enabled ? 'checked' : ''}>
        <span>Enabled<br><span class="muted">Leave this off until it is wired — the door is listed but never called</span></span></label>`,
      async (bg, close) => {
        const body = {
          name: $('#ap-name', bg).value, method: $('#ap-method', bg).value, url: $('#ap-url', bg).value,
          headers: $('#ap-headers', bg).value, body: $('#ap-body', bg).value,
          notes: $('#ap-notes', bg).value,
          unlock_seconds: Number($('#ap-secs', bg).value) || 5,
          auto_unlock_on_signin: $('#ap-in', bg).checked ? 1 : 0,
          auto_unlock_on_signout: $('#ap-out', bg).checked ? 1 : 0,
          enabled: $('#ap-en', bg).checked ? 1 : 0
        };
        if (p) await api(`/access-points/${p.id}`, { method: 'PATCH', body });
        else await api('/access-points', { method: 'POST', body });
        close(); render('access');
      });

    // Picking how the door is opened fills in the rest, leaving the address to change.
    $('#ap-template', m.bg).addEventListener('change', (e) => {
      const t = DOOR_TEMPLATES[e.target.value];
      if (!t) return;
      $('#ap-url', m.bg).value = t.url;
      $('#ap-method', m.bg).value = t.method;
      $('#ap-headers', m.bg).value = t.headers;
      $('#ap-body', m.bg).value = t.body;
      if (t.notes && !$('#ap-notes', m.bg).value.trim()) $('#ap-notes', m.bg).value = t.notes;
    });
  }

  /* ------------------------------------------------------------ locations */

  VIEWS.locations = async (root) => {
    const [rows, sites] = await Promise.all([api('/locations'), api('/sites')]);
    const multiSite = sites.length > 1;
    root.innerHTML = `
      <h1 class="page">Locations</h1>
      <p class="page-sub">Areas within a site — reception, the yard gate, the workshop entrance. Each device belongs to a
        location, so you can see where somebody signed in and run a roll call area by area.</p>
      <div class="card section">
        <div class="inline-form" style="margin-bottom:1rem">
          <label class="field"><span>Location name</span><input class="input" id="lo-name" placeholder="Main reception"></label>
          <label class="field"><span>Description</span><input class="input" id="lo-desc" placeholder="Ground floor, front of building"></label>
          ${multiSite ? `<label class="field"><span>Site</span><select class="input" id="lo-site">
            ${sites.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label>` : ''}
          <button class="btn" id="lo-add">Add location</button>
        </div>
        <div class="table-wrap">${rows.length ? `<table>
          <thead><tr><th>Name</th><th>Description</th>${multiSite ? '<th>Site</th>' : ''}<th>Devices</th><th>On site now</th><th>Status</th><th></th></tr></thead>
          <tbody>${rows.map((l) => `<tr>
            <td><b>${esc(l.name)}</b></td>
            <td class="muted">${esc(l.description || '')}</td>
            ${multiSite ? `<td>${esc(l.site_name || '')}</td>` : ''}
            <td>${l.device_count}</td>
            <td>${l.onsite}</td>
            <td><span class="pill ${l.active ? 'on' : 'off'}">${l.active ? 'active' : 'off'}</span></td>
            <td><button class="btn ghost" data-loedit="${l.id}">Edit</button>
                <button class="btn ghost" data-lodel="${l.id}">Remove</button></td></tr>`).join('')}</tbody></table>`
          : '<p class="empty">No locations yet. Add one for each entrance or area that has a device.</p>'}</div>
      </div>`;

    $('#lo-add').addEventListener('click', async () => {
      if (!$('#lo-name').value.trim()) return toast('Give the location a name');
      await api('/locations', { method: 'POST', body: {
        name: $('#lo-name').value.trim(), description: $('#lo-desc').value.trim(),
        site_id: multiSite ? Number($('#lo-site').value) : (sites[0] ? sites[0].id : null) } });
      render('locations');
    });

    $$('[data-loedit]').forEach((b) => b.addEventListener('click', () => {
      const l = rows.find((x) => String(x.id) === b.dataset.loedit);
      modal(`Edit ${l.name}`, `
        <label class="field"><span>Name</span><input class="input" id="le-name" value="${esc(l.name)}"></label>
        <label class="field"><span>Description</span><input class="input" id="le-desc" value="${esc(l.description || '')}"></label>
        <label class="check"><input type="checkbox" id="le-active" ${l.active ? 'checked' : ''}> Active</label>`,
        async (bg, close) => {
          await api(`/locations/${l.id}`, { method: 'PATCH', body: {
            name: $('#le-name', bg).value, description: $('#le-desc', bg).value, active: $('#le-active', bg).checked } });
          close(); render('locations');
        });
    }));

    $$('[data-lodel]').forEach((b) => b.addEventListener('click', () => confirmAction(
      'Remove this location? Devices and past visits keep working, they just stop being tied to it.',
      async () => { await api(`/locations/${b.dataset.lodel}`, { method: 'DELETE' }); render('locations'); })));
  };

  /* -------------------------------------------------------------- printers */

  const PRINTER_COLORS = [['black', 'Black'], ['red', 'Red'], ['black_red', 'Black & red (DK-2251 roll)']];
  const PRINTER_PORTS = [['network', 'Network (Wi-Fi / Ethernet)'], ['wireless_direct', 'Wireless Direct (printer hosts its own Wi-Fi)'],
    ['bluetooth', 'Bluetooth']];
  const printerPortLabel = (p) => (PRINTER_PORTS.find(([v]) => v === p) || [p, p])[1];

  VIEWS.printers = async (root) => {
    const [rows, locations] = await Promise.all([api('/printers'), api('/locations')]);

    const printerFields = (p) => `
      <div class="form-grid">
        <label class="field"><span>Printer name *</span><input class="input" id="pr-name" placeholder="Gate badge printer" value="${esc(p.name || '')}"></label>
        <label class="field"><span>Model</span><input class="input" id="pr-model" placeholder="Brother QL-820NWB" value="${esc(p.model || '')}"></label>
        <label class="field"><span>Label type</span><input class="input" id="pr-label" placeholder="DK-2205 62mm continuous" value="${esc(p.label_type || '')}"></label>
        <label class="field"><span>Foreground colour</span>
          <select class="input" id="pr-color">${PRINTER_COLORS.map(([v, l]) =>
            `<option value="${v}" ${p.foreground_color === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="field"><span>Port</span>
          <select class="input" id="pr-port">${PRINTER_PORTS.map(([v, l]) =>
            `<option value="${v}" ${p.port === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="field" id="pr-ip-wrap"><span>Static IP (if set)</span>
          <input class="input" id="pr-ip" placeholder="192.168.1.60" value="${esc(p.ip_address || '')}">
          <span class="muted" id="pr-ip-hint"></span></label>
        <label class="field"><span>Location</span>
          <select class="input" id="pr-loc"><option value="">— none —</option>
            ${locations.map((l) => `<option value="${l.id}" ${p.location_id === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Notes</span><input class="input" id="pr-notes" placeholder="Wireless Direct password, roll spares…" value="${esc(p.notes || '')}"></label>
      </div>
      <label class="check"><input type="checkbox" id="pr-active" ${p.active === 0 ? '' : 'checked'}> In service</label>`;

    // The IP box only means something when the printer is reached by address.
    const wirePortHint = (bg) => {
      const update = () => {
        const port = $('#pr-port', bg).value;
        $('#pr-ip-wrap', bg).style.display = port === 'bluetooth' ? 'none' : '';
        $('#pr-ip-hint', bg).textContent = port === 'wireless_direct'
          ? 'In Wireless Direct the printer is its own network — Brother printers answer at 192.168.118.1.'
          : 'Leave empty if the printer takes an address from your router.';
        if (port === 'wireless_direct' && !$('#pr-ip', bg).value.trim()) $('#pr-ip', bg).value = '192.168.118.1';
      };
      $('#pr-port', bg).addEventListener('change', update);
      update();
    };

    const collect = (bg) => ({
      name: $('#pr-name', bg).value.trim(),
      model: $('#pr-model', bg).value.trim(),
      label_type: $('#pr-label', bg).value.trim(),
      foreground_color: $('#pr-color', bg).value,
      port: $('#pr-port', bg).value,
      ip_address: $('#pr-ip', bg).value.trim(),
      location_id: $('#pr-loc', bg).value ? Number($('#pr-loc', bg).value) : null,
      notes: $('#pr-notes', bg).value.trim(),
      active: $('#pr-active', bg).checked
    });

    root.innerHTML = `
      <h1 class="page">Printers</h1>
      <p class="page-sub">The label printers on site: what they are, which roll is loaded, and how each is reached.
        Point a device at its printer under <b>Devices</b>, and set the badge design under <b>Badges</b>.</p>
      ${locations.length ? '' : '<div class="notice">No locations yet — add them under <b>Locations</b> so each printer can say where it is.</div>'}
      <div class="card section">
        <div class="row" style="margin-bottom:1rem"><button class="btn" id="pr-add">Add printer</button></div>
        <div class="table-wrap">${rows.length ? `<table>
          <thead><tr><th>Printer</th><th>Model</th><th>Label</th><th>Colour</th><th>Port</th><th>Address</th><th>Location</th><th>Devices</th><th>Status</th><th></th></tr></thead>
          <tbody>${rows.map((p) => `<tr>
            <td><b>${esc(p.name)}</b>${p.notes ? `<div class="muted">${esc(p.notes)}</div>` : ''}</td>
            <td class="muted">${esc(p.model || '')}</td>
            <td class="muted">${esc(p.label_type || '')}</td>
            <td class="muted">${esc((PRINTER_COLORS.find(([v]) => v === p.foreground_color) || ['', p.foreground_color])[1])}</td>
            <td class="muted">${esc(printerPortLabel(p.port))}</td>
            <td class="muted">${esc(p.ip_address || (p.port === 'bluetooth' ? '—' : 'auto'))}</td>
            <td class="muted">${esc(p.location_name || '')}</td>
            <td>${p.device_count}</td>
            <td><span class="pill ${p.active ? 'on' : 'off'}">${p.active ? 'in service' : 'out'}</span></td>
            <td><button class="btn ghost" data-predit="${p.id}">Edit</button>
                <button class="btn ghost" data-prdel="${p.id}">Remove</button></td></tr>`).join('')}</tbody></table>`
          : '<p class="empty">No printers yet. Add the badge printer so devices can point at it.</p>'}</div>
        <p class="muted">Printing itself runs over AirPrint, so a <b>Network</b> printer just needs to share the tablet's
          Wi-Fi. <b>Wireless Direct</b> is for a tablet on cellular data: the printer hosts its own Wi-Fi and the tablet
          joins it, keeping internet over LTE. A <b>Bluetooth</b> entry is inventory only — iPads can only print over
          Bluetooth from the maker's own app, not from the kiosk.</p>
      </div>`;

    $('#pr-add').addEventListener('click', () => {
      const m = modal('Add printer', printerFields({ foreground_color: 'black', port: 'network', active: 1 }),
        async (bg, close) => {
          const body = collect(bg);
          if (!body.name) return toast('Give the printer a name');
          await api('/printers', { method: 'POST', body });
          close(); render('printers');
        });
      wirePortHint(m.bg);
    });

    $$('[data-predit]').forEach((b) => b.addEventListener('click', () => {
      const p = rows.find((x) => String(x.id) === b.dataset.predit);
      const m = modal(`Edit ${p.name}`, printerFields(p), async (bg, close) => {
        const body = collect(bg);
        if (!body.name) return toast('Give the printer a name');
        await api(`/printers/${p.id}`, { method: 'PATCH', body });
        close(); render('printers');
      });
      wirePortHint(m.bg);
    }));

    $$('[data-prdel]').forEach((b) => b.addEventListener('click', () => confirmAction(
      'Remove this printer? Devices pointed at it simply lose the link.',
      async () => { await api(`/printers/${b.dataset.prdel}`, { method: 'DELETE' }); render('printers'); })));
  };

  /* --------------------------------------------------------- visitor types */

  VIEWS.vtypes = async (root) => {
    SETTINGS = await api('/settings');
    // Edited as a local copy; nothing reaches the kiosk until Save.
    const types = (SETTINGS.types || []).map((ty) => ({ ...ty }));
    const MODES = [['card', 'Own card on the home screen'], ['picker', 'Behind the Sign in card'],
      ['both', 'Both'], ['off', 'Hidden']];

    root.innerHTML = `
      <h1 class="page">Visitor types</h1>
      <p class="page-sub">The cards on the kiosk. Each type has its own wording, its own place on the home screen, and —
        via the other tabs — its own documents, induction, form fields and step order. Add one here and it appears
        everywhere a type can be chosen: the “Your details” form settings, document and deck assignment, and the
        per-device card list.</p>
      <div class="card section">
        <div id="vt-list"></div>
        <div class="row" style="margin-top:1rem">
          <button class="btn subtle" id="vt-add" type="button">Add a visitor type</button>
          <button class="btn" id="vt-save" type="button">Save visitor types</button>
        </div>
        <p class="muted">A hidden type keeps its history and settings — hide a type rather than deleting it once it has
          been used. The Spanish boxes are shown when the kiosk is switched to Spanish; empty ones fall back to English.</p>
      </div>`;

    const list = $('#vt-list');

    const draw = () => {
      list.innerHTML = types.map((ty, i) => `
        <div class="q-row" data-i="${i}">
          <div class="q-row-top">
            <input class="input" data-vticon="${i}" title="Icon (emoji)" style="max-width:4.5rem;text-align:center"
              value="${esc(ty.icon || '👤')}">
            <input class="input" data-vtlabel="${i}" placeholder="Card name — e.g. Cleaner" value="${esc(ty.label || '')}">
            <select class="input" data-vtmode="${i}">
              ${MODES.map(([v, l]) => `<option value="${v}" ${ty.mode === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
            <button class="btn ghost" type="button" data-vtup="${i}" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button>
            <button class="btn ghost" type="button" data-vtdown="${i}" ${i === types.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
            ${ty.builtin ? '<span class="pill on" title="A standard type — hide it rather than removing it">built-in</span>'
              : `<button class="btn ghost" type="button" data-vtdel="${i}" title="Remove">✕</button>`}
          </div>
          <div class="two-col" style="margin-top:.5rem">
            <input class="input" data-vtsub="${i}" placeholder="Line under the name (optional)" value="${esc(ty.sub || '')}">
            <input class="input" data-vtlabeles="${i}" placeholder="Name en español (optional)" value="${esc(ty.label_es || '')}">
          </div>
          <div class="two-col" style="margin-top:.5rem">
            <input class="input" data-vtsubes="${i}" placeholder="Line under the name en español (optional)" value="${esc(ty.sub_es || '')}">
            <span class="muted" style="align-self:center">Key: <code>${esc(ty.key || '(from the name)')}</code></span>
          </div>
        </div>`).join('');

      $$('[data-vtdel]', list).forEach((b) => b.addEventListener('click', () => {
        sync(); types.splice(Number(b.dataset.vtdel), 1); draw();
      }));
      $$('[data-vtup]', list).forEach((b) => b.addEventListener('click', () => {
        sync(); const i = Number(b.dataset.vtup);
        [types[i - 1], types[i]] = [types[i], types[i - 1]]; draw();
      }));
      $$('[data-vtdown]', list).forEach((b) => b.addEventListener('click', () => {
        sync(); const i = Number(b.dataset.vtdown);
        [types[i + 1], types[i]] = [types[i], types[i + 1]]; draw();
      }));
    };

    const sync = () => {
      $$('[data-vtlabel]', list).forEach((el) => { types[Number(el.dataset.vtlabel)].label = el.value; });
      $$('[data-vticon]', list).forEach((el) => { types[Number(el.dataset.vticon)].icon = el.value; });
      $$('[data-vtsub]', list).forEach((el) => { types[Number(el.dataset.vtsub)].sub = el.value; });
      $$('[data-vtlabeles]', list).forEach((el) => { types[Number(el.dataset.vtlabeles)].label_es = el.value; });
      $$('[data-vtsubes]', list).forEach((el) => { types[Number(el.dataset.vtsubes)].sub_es = el.value; });
      $$('[data-vtmode]', list).forEach((el) => { types[Number(el.dataset.vtmode)].mode = el.value; });
    };

    // A new type's key comes from its name, and must not collide with another
    // type or with the fixed home-screen cards.
    const keyFor = (label) => {
      const base = String(label).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'type';
      const taken = new Set([...types.map((ty) => ty.key), 'signin', 'signout', 'delivery', 'unlock', 'menu', 'idle']);
      let key = base, n = 2;
      while (taken.has(key)) key = `${base}-${n++}`;
      return key;
    };

    $('#vt-add').addEventListener('click', () => {
      sync();
      types.push({ key: '', label: '', label_es: '', sub: '', sub_es: '', icon: '🪪', mode: 'picker', builtin: false });
      draw();
      const inputs = $$('[data-vtlabel]', list);
      if (inputs.length) inputs[inputs.length - 1].focus();
    });

    $('#vt-save').addEventListener('click', async () => {
      sync();
      const named = types.filter((ty) => String(ty.label || '').trim());
      if (!named.length) return toast('Keep at least one visitor type');
      if (!named.some((ty) => ty.mode !== 'off')) return toast('Every type is hidden — nobody could sign in');
      named.forEach((ty) => { if (!ty.key) ty.key = keyFor(ty.label); });
      SETTINGS = await api('/settings', { method: 'PUT', body: { types: named } });
      if (SETTINGS.warnings && SETTINGS.warnings.length) toast(SETTINGS.warnings.join(' '), 7000);
      else toast('Visitor types saved — kiosks update within a few seconds');
      render('vtypes');
    });

    draw();
  };

  /* ------------------------------------------------------------- projects */

  VIEWS.projects = async (root) => {
    const rows = await api('/projects');
    root.innerHTML = `
      <h1 class="page">Projects</h1>
      <p class="page-sub">The jobs a contractor can be on site for. They pick one from this list when they sign in, so a
        report of who worked on what stays clean. Give a project a Spanish name and the kiosk shows it when switched to
        Spanish; leave it empty and the English one is shown.</p>
      <div class="card section">
        <div class="inline-form" style="margin-bottom:1rem">
          <label class="field"><span>Project name</span><input class="input" id="pj-name" placeholder="Riverside build"></label>
          <label class="field"><span>En español (optional)</span><input class="input" id="pj-name-es" placeholder="Obra de Riverside"></label>
          <label class="field"><span>Code (optional)</span><input class="input" id="pj-code" placeholder="RB-24" style="max-width:8rem"></label>
          <button class="btn" id="pj-add">Add project</button>
        </div>
        <div class="table-wrap">${rows.length ? `<table>
          <thead><tr><th>Project</th><th>En español</th><th>Code</th><th>On site now</th><th>Visits</th><th>Status</th><th></th></tr></thead>
          <tbody>${rows.map((p) => `<tr>
            <td><b>${esc(p.name)}</b></td>
            <td class="muted">${esc(p.name_es || '')}</td>
            <td class="muted">${esc(p.code || '')}</td>
            <td>${p.onsite}</td>
            <td>${p.visits_total}</td>
            <td><span class="pill ${p.active ? 'on' : 'off'}">${p.active ? 'active' : 'closed'}</span></td>
            <td><button class="btn ghost" data-pjedit="${p.id}">Edit</button>
                <button class="btn ghost" data-pjdel="${p.id}">Remove</button></td></tr>`).join('')}</tbody></table>`
          : '<p class="empty">No projects yet. Add the jobs contractors will be signing in against.</p>'}</div>
        <p class="muted">A finished job is closed with <b>Edit → Active off</b> — it drops off the kiosk but keeps its
          history. A project that has ever been signed in against cannot be removed, only closed.</p>
      </div>`;

    $('#pj-add').addEventListener('click', async () => {
      if (!$('#pj-name').value.trim()) return toast('Give the project a name');
      await api('/projects', { method: 'POST', body: {
        name: $('#pj-name').value.trim(),
        name_es: $('#pj-name-es').value.trim() || null,
        code: $('#pj-code').value.trim() || null } });
      render('projects');
    });

    $$('[data-pjedit]').forEach((b) => b.addEventListener('click', () => {
      const p = rows.find((x) => String(x.id) === b.dataset.pjedit);
      modal(`Edit ${p.name}`, `
        <label class="field"><span>Name</span><input class="input" id="pe-name" value="${esc(p.name)}"></label>
        <label class="field"><span>En español</span><input class="input" id="pe-name-es" value="${esc(p.name_es || '')}"></label>
        <label class="field"><span>Code</span><input class="input" id="pe-code" value="${esc(p.code || '')}"></label>
        <label class="check"><input type="checkbox" id="pe-active" ${p.active ? 'checked' : ''}>
          <span>Active<br><span class="muted">Off = closed: hidden on the kiosk, history kept.</span></span></label>`,
        async (bg, close) => {
          await api(`/projects/${p.id}`, { method: 'PATCH', body: {
            name: $('#pe-name', bg).value, name_es: $('#pe-name-es', bg).value.trim() || null,
            code: $('#pe-code', bg).value.trim() || null, active: $('#pe-active', bg).checked } });
          close(); render('projects');
        });
    }));

    $$('[data-pjdel]').forEach((b) => b.addEventListener('click', () => confirmAction(
      'Remove this project? This only works while nothing has been signed in against it.',
      async () => {
        try { await api(`/projects/${b.dataset.pjdel}`, { method: 'DELETE' }); } catch (err) {
          if (err.data && err.data.error === 'project_in_use') {
            return toast(`This project has ${err.data.visits} visit${err.data.visits === 1 ? '' : 's'} against it — close it with Edit instead.`, 5000);
          }
          throw err;
        }
        render('projects');
      })));
  };

  /* -------------------------------------------------------------- devices */

  const CAMERA_LABEL = { front: 'Front camera', rear: 'Rear camera' };

  // The home-screen cards a device can be limited to — the fixed ones plus
  // whatever visitor types currently have their own card.
  const DEVICE_SECTIONS = () => [
    ['signin', 'Sign in'], ['signout', 'Sign out'],
    ...((SETTINGS && SETTINGS.types) || []).filter((ty) => ty.mode === 'card' || ty.mode === 'both')
      .map((ty) => [ty.key, ty.label]),
    ['delivery', 'Delivery'], ['unlock', 'Request entry']
  ];

  VIEWS.devices = async (root) => {
    const [rows, locations, printers] = await Promise.all([api('/devices'), api('/locations'), api('/printers')]);
    const origin = location.origin;
    root.innerHTML = `
      <h1 class="page">Devices</h1>
      <p class="page-sub">Every tablet or screen running Smart Lobby. Register one here, then open its link on the device
        and add it to the home screen.</p>
      ${locations.length ? '' : `<div class="notice">No locations yet — add them under <b>Locations</b> first so each
        device can say where it is.</div>`}
      <div class="card section">
        <div class="inline-form" style="margin-bottom:1rem">
          <label class="field"><span>Device name</span><input class="input" id="dv-name" placeholder="Reception iPad"></label>
          <label class="field"><span>Location</span><select class="input" id="dv-loc">
            <option value="">— none —</option>
            ${locations.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select></label>
          <button class="btn" id="dv-add">Register device</button>
        </div>
        <div class="table-wrap">${rows.length ? `<table>
          <thead><tr><th>Name</th><th>Device link</th><th>Location</th><th>Camera</th><th>Mode</th><th>Printing</th><th>Last seen</th><th>Status</th><th></th></tr></thead>
          <tbody>${rows.map((d) => {
            const online = d.last_seen_at && (Date.now() - new Date(d.last_seen_at).getTime()) < 5 * 60000;
            return `<tr>
              <td><b>${esc(d.name)}</b></td>
              <td><code class="token">/kiosk/${esc(d.slug || '')}</code></td>
              <td>${esc(d.location_name || '—')}</td>
              <td>${esc(cameraName(d))}</td>
              <td>${esc(d.mode || 'kiosk')}</td>
              <td><span class="pill ${d.print_enabled ? 'on' : 'off'}">${d.print_enabled ? 'on' : 'off'}</span></td>
              <td>${fmtDate(d.last_seen_at)}</td>
              <td><span class="pill ${online ? 'on' : 'off'}">${online ? 'online' : 'offline'}</span></td>
              <td><button class="btn ghost" data-dvcopy="${d.id}">Copy link</button>
                  <button class="btn ghost" data-dvedit="${d.id}">Edit</button>
                  <button class="btn ghost" data-dvlink="${d.id}">Link</button>
                  <button class="btn ghost" data-dvdel="${d.id}">Remove</button></td></tr>`;
          }).join('')}</tbody></table>` : '<p class="empty">No devices registered yet.</p>'}</div>
      </div>`;

    /*
     * Each tablet has its own address. It is the whole link — not a token
     * tucked in a query parameter — so saving it to an iPad's home screen keeps
     * this device's cards. A saved icon used to come back to the shared page
     * showing everything, because the token never survived the trip.
     */
    const deviceUrl = (d) => `${origin}/kiosk/${d.slug || ''}`;

    const showLink = (d) => {
      const url = deviceUrl(d);
      const { bg } = modal(`${d.name} — device link`, `
        <p>Open this on the tablet:</p>
        <div class="copy-row">
          <code class="token" id="dv-url">${esc(url)}</code>
          <button class="btn" id="dv-copy">Copy link</button>
        </div>
        <p class="muted">On the iPad, open it in Safari, then <b>Share → Add to Home Screen</b>. The icon is named
          after this device and reopens on this page, so it always shows this device's cards — no Wi-Fi or sign-in
          needed to get back to it.</p>
        <p class="muted">The tablet reports in every minute, so this page shows whether it is online. Rename the
          device freely; its link only changes if you change it under Edit.</p>
        <details><summary class="muted">Older token link (still works)</summary>
          <div class="copy-row" style="margin-top:0.5rem">
            <code class="token">${origin}/kiosk/?token=${d.token}</code>
            <button class="btn ghost" id="dv-copy-token">Copy</button>
          </div>
          <p class="muted">Kept so links already handed out keep working. A tablet opened this way moves itself onto
            the address above, so anything saved to the home screen from then on is the durable one.</p>
        </details>`, null);
      $('#dv-copy', bg).addEventListener('click', (e) => copyText(url, e.currentTarget));
      $('#dv-copy-token', bg).addEventListener('click', (e) =>
        copyText(`${origin}/kiosk/?token=${d.token}`, e.currentTarget));
    };

    $('#dv-add').addEventListener('click', async () => {
      const d = await api('/devices', { method: 'POST', body: {
        name: $('#dv-name').value || 'Reception kiosk', location_id: $('#dv-loc').value || null } });
      showLink(d);
      render('devices');
    });

    $$('[data-dvlink]').forEach((b) => b.addEventListener('click', () =>
      showLink(rows.find((x) => String(x.id) === b.dataset.dvlink))));

    // One press, straight from the list — the common case is emailing a link to
    // whoever is standing at the tablet.
    $$('[data-dvcopy]').forEach((b) => b.addEventListener('click', () =>
      copyText(deviceUrl(rows.find((x) => String(x.id) === b.dataset.dvcopy)), b)));

    $$('[data-dvedit]').forEach((b) => b.addEventListener('click', () => {
      const d = rows.find((x) => String(x.id) === b.dataset.dvedit);
      let reported = [];
      try { reported = JSON.parse(d.cameras || '[]'); } catch { reported = []; }

      // This device's card list: the saved order first, then anything it has not
      // been told about, so a newly added card is offered rather than lost.
      let saved = null;
      try { saved = JSON.parse(d.sections || 'null'); } catch { saved = null; }
      const known = DEVICE_SECTIONS().map(([key]) => key);
      const sectionOrder = Array.isArray(saved) && saved.length
        ? [...new Set([...saved.filter((k) => known.includes(k)), ...known])]
        : known.slice();
      const enabled = new Set(Array.isArray(saved) && saved.length ? saved : known);
      const options = [['front', 'Front camera'], ['rear', 'Rear camera'],
        ...reported.map((c) => [c.id, c.label])];

      const m = modal(`Edit ${d.name}`, `
        <div class="form-grid">
          <label class="field"><span>Device name</span><input class="input" id="de-name" value="${esc(d.name)}"></label>
          <label class="field"><span>Device link</span><input class="input" id="de-slug" value="${esc(d.slug || '')}">
            <small class="muted">The tablet's own address: ${esc(origin)}/kiosk/<b id="de-slug-preview">${esc(d.slug || '')}</b>.
              Changing it breaks any icon already saved to a home screen, so leave it alone once the tablet is set up.</small></label>
          <label class="field"><span>Location</span><select class="input" id="de-loc">
            <option value="">— none —</option>
            ${locations.map((l) => `<option value="${l.id}" ${l.id === d.location_id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}
          </select></label>
          <label class="field"><span>Default camera</span><select class="input" id="de-cam">
            ${options.map(([v, l]) => `<option value="${esc(v)}" ${d.default_camera === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}
          </select></label>
          <label class="field"><span>Operational mode</span><select class="input" id="de-mode">
            <option value="kiosk" ${d.mode === 'kiosk' ? 'selected' : ''}>Kiosk — visitor sign-in</option>
          </select></label>
        </div>

        <h3>Cards on this device</h3>
        <p class="muted" style="margin-top:0">Which cards this kiosk shows, and the order they appear in. A warehouse
          gate can lead with Driver while reception leads with Sign in. Untick a card to hide it here without
          affecting other devices.</p>
        <div id="de-sections" class="section-order"></div>
        <p class="muted">With everything ticked in the standard order, this device shows whatever is switched on in
          Settings — including any card added later.</p>
        <p class="muted">${reported.length
          ? `${reported.length} camera${reported.length === 1 ? '' : 's'} reported by this device.`
          : 'This device has not reported its cameras yet — it does so once it has been opened and allowed camera access. Front/rear still work.'}</p>
        <label class="check"><input type="checkbox" id="de-print" ${d.print_enabled ? 'checked' : ''}>
          <span>Print badges from this device<br><span class="muted">Only applies while badge printing is on in
            Settings. Turn it off for a device with no printer attached.</span></span></label>
        <label class="field"><span>Printer beside this device</span><select class="input" id="de-printer">
          <option value="">— none —</option>
          ${printers.map((p) => `<option value="${p.id}" ${p.id === d.printer_id ? 'selected' : ''}>${esc(p.name)}${p.model ? ` (${esc(p.model)})` : ''}</option>`).join('')}
        </select>
        <span class="muted">From the Printers tab — records which printer this tablet prints to.</span></label>
        <p class="muted">More operational modes are coming; every device runs in kiosk mode for now.</p>`,
        async (bg, close) => {
          const picked = sectionOrder.filter((k) => enabled.has(k));
          const defaults = DEVICE_SECTIONS();
          const isDefault = picked.length === defaults.length
            && picked.every((k, i) => k === defaults[i][0]);
          const slug = $('#de-slug', bg).value.trim();
          await api(`/devices/${d.id}`, { method: 'PATCH', body: {
            name: $('#de-name', bg).value,
            // Only sent when it was actually edited: a rename must not quietly
            // move a tablet whose link is already on someone's home screen.
            ...(slug && slug !== (d.slug || '') ? { slug } : {}),
            location_id: $('#de-loc', bg).value || null,
            default_camera: $('#de-cam', bg).value,
            mode: $('#de-mode', bg).value,
            // Everything ticked in the standard order means "no preference", so a
            // card added later still appears on this device.
            sections: isDefault ? null : JSON.stringify(picked),
            print_enabled: $('#de-print', bg).checked,
            printer_id: $('#de-printer', bg).value ? Number($('#de-printer', bg).value) : null } });
          close(); render('devices');
        });

      // Show what the address will actually become as it is typed.
      $('#de-slug', m.bg).addEventListener('input', (e) => {
        $('#de-slug-preview', m.bg).textContent = e.target.value.trim()
          .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      });

      const drawSections = () => {
        const box = $('#de-sections', m.bg);
        const label = (k) => (DEVICE_SECTIONS().find(([key]) => key === k) || [k, k])[1];
        box.innerHTML = sectionOrder.map((key, i) => `<div class="section-row${enabled.has(key) ? '' : ' off'}">
          <label class="check"><input type="checkbox" data-dsec="${key}" ${enabled.has(key) ? 'checked' : ''}>
            <span>${i + 1}. ${esc(label(key))}</span></label>
          <span class="flow-moves">
            <button class="btn ghost" type="button" data-secup="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="btn ghost" type="button" data-secdown="${i}" ${i === sectionOrder.length - 1 ? 'disabled' : ''}>↓</button>
          </span></div>`).join('');

        $$('[data-dsec]', box).forEach((c) => c.addEventListener('change', () => {
          if (c.checked) enabled.add(c.dataset.dsec); else enabled.delete(c.dataset.dsec);
          drawSections();
        }));
        $$('[data-secup]', box).forEach((btn) => btn.addEventListener('click', () => {
          const i = Number(btn.dataset.secup);
          [sectionOrder[i - 1], sectionOrder[i]] = [sectionOrder[i], sectionOrder[i - 1]];
          drawSections();
        }));
        $$('[data-secdown]', box).forEach((btn) => btn.addEventListener('click', () => {
          const i = Number(btn.dataset.secdown);
          [sectionOrder[i + 1], sectionOrder[i]] = [sectionOrder[i], sectionOrder[i + 1]];
          drawSections();
        }));
      };
      drawSections();
    }));

    $$('[data-dvdel]').forEach((b) => b.addEventListener('click', () => confirmAction(
      'Remove this device? Its kiosk link stops working.',
      async () => { await api(`/devices/${b.dataset.dvdel}`, { method: 'DELETE' }); render('devices'); })));
  };

  function cameraName(d) {
    const choice = d.default_camera || 'front';
    if (CAMERA_LABEL[choice]) return CAMERA_LABEL[choice];
    try {
      const found = JSON.parse(d.cameras || '[]').find((c) => c.id === choice);
      if (found) return found.label;
    } catch { /* no cameras reported */ }
    return 'Specific camera';
  }

  /* -------------------------------------------------------------- reports */

  VIEWS.reports = async (root) => {
    const s = await api('/stats');
    const maxDay = Math.max(1, ...s.by_day.map((d) => d.n));
    const bar = (list) => {
      const max = Math.max(1, ...list.map((x) => x.n));
      return `<div class="barlist">${list.map((x) => `<div class="b"><span>${esc(x.name || x.visit_type || x.hour || '—')}</span>
        <div class="track"><div class="fill" style="width:${(x.n / max) * 100}%"></div></div><b>${x.n}</b></div>`).join('')}</div>`;
    };
    root.innerHTML = `
      <h1 class="page">Reports</h1>
      <p class="page-sub">Everything stays on your server — export any of it as CSV.</p>
      <div class="grid cards" style="margin-bottom:1.25rem">
        <div class="card stat"><div class="n">${s.avg_minutes ? Math.round(s.avg_minutes) : 0}</div><div class="l">Average minutes on site</div></div>
        <div class="card stat"><div class="n">${s.by_day.reduce((a, b) => a + b.n, 0)}</div><div class="l">Visits in the last 30 days</div></div>
      </div>
      <div class="card section"><h2>Visits per day (30 days)</h2>
        <div class="bars">${s.by_day.map((d) => `<div style="height:${(d.n / maxDay) * 100}%" title="${d.day}: ${d.n}"></div>`).join('')}</div></div>
      <div class="grid two">
        <div class="card section"><h2>Busiest hosts</h2>${bar(s.by_host)}</div>
        <div class="card section"><h2>Top companies</h2>${bar(s.by_company)}</div>
        <div class="card section"><h2>By visit type</h2>${bar(s.by_type.map((t) => ({ name: t.visit_type, n: t.n })))}</div>
        <div class="card section"><h2>Arrivals by hour</h2>${bar(s.by_hour.map((h) => ({ name: `${h.hour}:00`, n: h.n })))}</div>
      </div>
      <div class="card section"><h2>Exports</h2>
        <div class="row"><a class="btn ghost" href="/api/admin/visits?format=csv">All visits</a>
        <a class="btn ghost" href="/api/admin/deliveries?format=csv">All deliveries</a>
        <a class="btn ghost" href="/api/admin/rollcall?format=csv">Current roll call</a></div></div>`;
  };

  /* ------------------------------------------------------------- settings */

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
    ['project', 'Project', 'Picked from the list on the Projects tab']
  ];
  // One column per visitor type, straight from the Visitor types tab.
  const DETAIL_TYPES = null; // replaced by detailTypes() — kept null so stale references fail loudly
  const detailTypes = () => ((SETTINGS && SETTINGS.types) || []).map((ty) => [ty.key, ty.label]);

  VIEWS.settings = async (root) => {
    SETTINGS = await api('/settings');
    const users = await api('/users');
    const s = SETTINGS;
    const chk = (path, label, help) => `<label class="check"><input type="checkbox" data-set="${path}"
      ${getPath(s, path) ? 'checked' : ''}> <span>${label}${help ? `<br><span class="muted">${help}</span>` : ''}</span></label>`;
    const txt = (path, label, type = 'text', placeholder = '') => `<label class="field"><span>${label}</span>
      <input class="input" data-set="${path}" type="${type}" placeholder="${placeholder}" value="${esc(getPath(s, path) ?? '')}"></label>`;
    const bgs = s.org.backgrounds || [];

    root.innerHTML = `
      <h1 class="page">Settings</h1>
      <p class="page-sub">Everything here applies instantly to every kiosk.</p>

      <div class="card section"><h2>Branding</h2>
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

      <div class="card section"><h2>The “Your details” form</h2>
        <p class="muted" style="margin-top:0">What each type of visitor is asked. An interview does not need a reason for
          visit — the card already says why they are here — so switch it off in that column alone.</p>
        <div class="table-wrap"><table class="fields-table">
          <thead><tr><th>Field</th>${detailTypes().map(([, l]) => `<th>${l}</th>`).join('')}</tr></thead>
          <tbody>${DETAIL_FIELDS.map(([field, label, hint]) => `<tr>
            <td><b>${label}</b>${hint ? `<div class="muted">${hint}</div>` : ''}
              <div><button class="btn link" type="button" data-rowoff="${field}">Turn off for everyone</button></div></td>
            ${detailTypes().map(([type]) => {
              const value = ((s.details[type] || {})[field]) || 'off';
              return `<td><select class="input" data-set="details.${type}.${field}">
                ${[['off', 'Not asked'], ['optional', 'Optional'], ['required', 'Required']]
                  .map(([v, l]) => `<option value="${v}" ${value === v ? 'selected' : ''}>${l}</option>`).join('')}
              </select></td>`;
            }).join('')}</tr>`).join('')}</tbody>
        </table></div>
        <p class="muted">Full name is always asked. Deliveries have their own short form, set further down.</p>

        <h3>Wording</h3>
        <p class="muted" style="margin-top:0">Change what a field is called and add a line of help underneath it —
          a driver is asked for a haulier, not a company. Leave a box empty to keep the standard wording.</p>
        <label class="field" style="max-width:16rem"><span>Wording for</span>
          <select class="input" id="wording-type">
            ${detailTypes().map(([t, l]) => `<option value="${t}">${l}</option>`).join('')}
          </select></label>
        <div id="wording-fields"></div>
      </div>

      <div class="card section"><h2>The order things are asked</h2>
        <p class="muted" style="margin-top:0">Finding the visitor always comes first — it decides whether they need the
          induction at all. Everything after that is yours to arrange, per type. A step that does not apply is skipped
          wherever it sits: no photo asked for, no documents for that type, an induction already watched.</p>
        <div class="grid two" id="flow-editor">
          ${detailTypes().map(([type, label]) => `
            <div class="flow-col" data-flowtype="${type}">
              <h3 style="margin-top:0">${label}</h3>
              <ol class="flow-list"></ol>
            </div>`).join('')}
        </div>
      </div>

      <div class="card section"><h2>Kiosk sign-in flow</h2>
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

      <div class="card section"><h2>ID badge printing</h2>
        <p class="muted">Badge design, label size and reprinting now live in their own <b>Badges</b> tab.</p>
        <button class="btn subtle" id="go-badges">Open Badges</button>
      </div>

      <div class="card section"><h2>Induction</h2>
        ${chk('induction.enabled', 'Show the induction deck during sign-in')}
        ${chk('induction.show_to_returning_visitors', 'Show it every visit', 'Off = only first-timers and anyone who has not seen the current version')}
        ${chk('induction.require_acknowledgement', 'Ask for a confirmation tap at the end')}
        <div class="form-grid">${txt('induction.acknowledgement_text', 'Confirmation wording')}
        ${txt('induction.acknowledgement_text_es', 'En español (optional)')}</div>
      </div>

      <div class="card section"><h2>Deliveries</h2>
        ${chk('deliveries.enabled', 'Enable the delivery flow')}
        ${chk('deliveries.require_recipient', 'Require a recipient')}
        ${chk('deliveries.ask_tracking', 'Ask for a tracking number')}
        ${chk('deliveries.notify_recipient', 'Notify the recipient immediately')}
        ${chk('deliveries.signature_on_collection', 'Capture a signature on collection')}
      </div>

      <div class="card section"><h2>Access control</h2>
        ${chk('access.enabled', 'Enable door control')}
        ${chk('access.unlock_button_on_kiosk', 'Show a “Request entry” button on the kiosk')}
        ${chk('access.unlock_on_signin', 'Unlock doors automatically when someone signs in')}
      </div>

      <div class="card section"><h2>Notifications</h2>
        <h3>Email</h3>
        <div class="row" style="margin-bottom:.5rem">
          <span class="muted">Fill in the server settings for:</span>
          <button class="btn subtle" type="button" data-smtp="gmail">Gmail</button>
          <button class="btn subtle" type="button" data-smtp="m365">Microsoft 365</button>
          <button class="btn subtle" type="button" data-smtp="icloud">iCloud</button>
        </div>
        <details class="howto" id="gmail-howto">
          <summary><b>Using a Gmail address — what you need first</b></summary>
          <ol>
            <li>Gmail refuses ordinary passwords here, so turn on <b>2-Step Verification</b> at
              <code class="token">myaccount.google.com/security</code> if it is not on already.</li>
            <li>Go to <code class="token">myaccount.google.com/apppasswords</code>, name it “Smart Lobby”, and
              create it. Google shows a <b>16-character password</b> once — copy it.</li>
            <li>Press <b>Gmail</b> above to fill in the server settings.</li>
            <li>Put your full Gmail address in both <b>From address</b> and <b>SMTP username</b>, and paste the
              16-character App Password into <b>SMTP password</b> (spaces do not matter).</li>
            <li><b>Save settings</b>, then <b>Send test email</b>.</li>
          </ol>
          <p class="muted">Gmail always sends as the account you signed in with, so the From address has to be that
            same address. A personal account can send roughly 500 messages a day, a Workspace one about 2,000 —
            far beyond a lobby's needs. If <b>App passwords</b> is missing from your Google account, 2-Step
            Verification is not on yet, or a Workspace admin has blocked them.</p>
        </details>
        ${chk('notify.email_enabled', 'Send staff emails over SMTP')}
        <div class="form-grid">
          ${txt('notify.from_name', 'From name')}
          ${txt('notify.from_email', 'From address', 'email')}
          ${txt('notify.smtp_host', 'SMTP host')}
          ${txt('notify.smtp_port', 'SMTP port', 'number')}
          ${txt('notify.smtp_user', 'SMTP username')}
          ${txt('notify.smtp_pass', 'SMTP password', 'password')}
        </div>
        ${chk('notify.smtp_secure', 'Use TLS on connect (port 465)')}
        ${chk('notify.on_signin', 'Notify the staff member on arrival')}
        ${chk('notify.on_signout', 'Notify the staff member on sign-out')}
        ${chk('notify.on_delivery', 'Notify on deliveries')}
        <h3>Chat</h3>
        <p class="muted" style="margin-top:0">A company channel that sees everything, and each person's own webhook
          for their own visitors. Set either, or both.</p>
        ${chk('notify.webhook_channel_always', 'Post every arrival to the company channel',
          'With this off, the channel is only used for people who have no webhook of their own')}
        <div class="form-grid">
          ${txt('notify.global_webhook_url', 'Company channel webhook')}
          <label class="field"><span>Format for unrecognised URLs</span><select class="input" data-set="notify.webhook_format">
            ${[['slack', 'Slack'], ['teams', 'Microsoft Teams'], ['google_chat', 'Google Chat'], ['generic', 'Generic JSON']]
              .map(([v, l]) => `<option value="${v}" ${s.notify.webhook_format === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select></label>
        </div>
        <h3>SMS (Twilio)</h3>
        ${chk('notify.sms_enabled', 'Send text messages to hosts', 'Uses the mobile number on each staff record')}
        <div class="form-grid">
          ${txt('notify.twilio_account_sid', 'Twilio Account SID')}
          ${txt('notify.twilio_auth_token', 'Twilio Auth Token', 'password')}
          ${txt('notify.sms_from', 'Send from number', 'text', '+441234567890')}
        </div>
        ${chk('notify.sms_on_signin', 'Text the staff member when a visitor arrives')}
        ${chk('notify.sms_on_delivery', 'Text the recipient when a parcel arrives')}
        <div class="row"><button class="btn subtle" id="test-email">Send test email</button>
          <button class="btn subtle" id="test-hook">Send test webhook</button>
          <button class="btn subtle" id="test-sms">Send test SMS</button>
          <input class="input" id="test-sms-to" placeholder="Number for the test SMS" style="max-width:15rem"></div>
        <div id="email-result"></div>
        <label class="field" style="max-width:26rem;margin-top:.75rem"><span>Send test emails to</span>
          <input class="input" data-set="notify.test_email_to" type="email"
            value="${esc(s.notify.test_email_to || '')}" placeholder="${esc(ME.email)}">
          <span class="muted">Every test goes here and nowhere else — never to a staff member or a visitor.
            Left empty, tests go to whoever is signed in.</span></label>

        <h3>What has been sent</h3>
        <p class="muted" style="margin-top:0">The last 50 attempts on every channel, including the ones that were
          skipped because a channel is switched off.</p>
        <div class="table-wrap" id="notify-log"><p class="muted">Loading…</p></div>
      </div>

      <div class="card section"><h2>Data retention</h2>
        <div class="form-grid">
          ${txt('privacy.retain_visits_days', 'Delete visit records after (days)', 'number')}
          ${txt('privacy.retain_photos_days', 'Delete visitor photos after (days)', 'number')}
        </div>
      </div>

      <div class="card section"><h2>Admin users</h2>
        <div class="table-wrap"><table><tbody>${users.map((u) => `<tr><td><b>${esc(u.name || u.email)}</b><div class="muted">${esc(u.email)}</div></td>
          <td>${esc(u.role)}</td><td>${u.id === (ME && ME.id) ? '<span class="muted">you</span>'
            : `<button class="btn ghost" data-udel="${u.id}">Remove</button>`}</td></tr>`).join('')}</tbody></table></div>
        <div class="inline-form" style="margin-top:1rem">
          <label class="field"><span>Name</span><input class="input" id="u-name"></label>
          <label class="field"><span>Email</span><input class="input" id="u-email" type="email"></label>
          <label class="field"><span>Password</span><input class="input" id="u-pass" type="password" autocomplete="new-password"></label>
          <button class="btn" id="u-add">Add user</button>
        </div>
      </div>

      <div class="row"><button class="btn" id="save-settings">Save settings</button></div>`;

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
      $$('[data-wlabel], [data-wdesc], [data-wlabeles], [data-wdesces]').forEach((i) => i.addEventListener('input', capture));
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

    function drawFlow() {
      detailTypes().forEach(([type]) => {
        const list = $(`[data-flowtype="${type}"] .flow-list`);
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
    drawBadgePreview();
    $$('[data-set]').forEach((input) => input.addEventListener('input', () => {
      if (input.dataset.set === 'badge.enabled') $('#badge-setup').classList.toggle('hidden', !input.checked);
      if (input.dataset.set.startsWith('badge.')) drawBadgePreview();
    }));

    $('#save-settings').addEventListener('click', async () => {
      const patch = {};
      $$('[data-set]').forEach((input) => {
        const value = input.type === 'checkbox' ? input.checked
          : (input.type === 'number' || input.type === 'range') ? Number(input.value)
          : input.value;
        setPath(patch, input.dataset.set, value);
      });
      patch.kiosk = patch.kiosk || {};
      if (VIEWS.settings.collectFlow) patch.flow = VIEWS.settings.collectFlow();
      if (VIEWS.settings.collectWording) patch.wording = VIEWS.settings.collectWording();
      SETTINGS = await api('/settings', { method: 'PUT', body: patch });
      if (SETTINGS.warnings && SETTINGS.warnings.length) toast(SETTINGS.warnings.join(' '), 7000);
      else toast('Settings saved');
      applyBranding();
      document.documentElement.style.setProperty('--brand', SETTINGS.org.primary_color || '#2f7d5d');
      document.documentElement.style.setProperty('--brand-dark', SETTINGS.org.accent_color || '#123a2c');
    });

    $('#logo-file').addEventListener('change', async (e) => {
      if (!e.target.files[0]) return;
      await upload('/settings/logo', e.target.files[0]);
      SETTINGS = await api('/settings');
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
        SETTINGS = await api('/settings');
        toast(notes.join(' · '), notes.length > 1 ? 6000 : 3000);
        render('settings');
      } catch { toast('Those files could not be used as backgrounds'); }
    });

    const bgRemove = $('#bg-remove');
    if (bgRemove) bgRemove.addEventListener('click', () => confirmAction(
      'Remove every background photo? The kiosk goes back to the plain gradient.',
      async () => {
        await api('/settings/backgrounds', { method: 'DELETE' });
        SETTINGS = await api('/settings');
        toast('Backgrounds removed');
        render('settings');
      }));

    $$('[data-bgdel]').forEach((b) => b.addEventListener('click', async () => {
      await api(`/settings/backgrounds/${b.dataset.bgdel}`, { method: 'DELETE' });
      SETTINGS = await api('/settings');
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
      SETTINGS = await api('/settings');
      applyBranding();
      toast('Logo removed');
      render('settings');
    });

    // What was actually sent, so a test is not a black box.
    const drawNotifications = async () => {
      const rows = await api('/notifications').catch(() => []);
      const status = (r) => {
        if (r.status === 'sent') return '<span class="pill on">sent</span>';
        if (String(r.status).startsWith('skipped')) return `<span class="pill off">${esc(r.status.replace('skipped_', 'skipped: '))}</span>`;
        return `<span class="pill" style="background:#fdecea;color:var(--danger)">${esc(r.status)}</span>`;
      };
      $('#notify-log').innerHTML = rows.length ? `<table>
        <thead><tr><th>When</th><th>Channel</th><th>Sent to</th><th>About</th><th>Result</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td>${fmtDate(r.created_at)}</td>
          <td>${esc(r.channel)}</td>
          <td>${esc(r.target || '—')}</td>
          <td>${esc(r.visitor_name || r.subject || '—')}</td>
          <td>${status(r)}${r.error ? `<div class="muted">${esc(String(r.error).slice(0, 120))}</div>` : ''}</td>
        </tr>`).join('')}</tbody></table>`
        : '<p class="empty">Nothing has been sent yet.</p>';
    };
    drawNotifications();

    // Server settings for the common providers, so nobody has to look up a port.
    const SMTP_PRESETS = {
      gmail: { host: 'smtp.gmail.com', port: 587, secure: false },
      m365: { host: 'smtp.office365.com', port: 587, secure: false },
      icloud: { host: 'smtp.mail.me.com', port: 587, secure: false }
    };
    $$('[data-smtp]').forEach((b) => b.addEventListener('click', () => {
      const preset = SMTP_PRESETS[b.dataset.smtp];
      $('[data-set="notify.smtp_host"]').value = preset.host;
      $('[data-set="notify.smtp_port"]').value = preset.port;
      $('[data-set="notify.smtp_secure"]').checked = preset.secure;
      $('[data-set="notify.email_enabled"]').checked = true;
      toast('Server settings filled in — now add your address and password, then save');
    }));

    $('#test-email').addEventListener('click', async () => {
      const box = $('#email-result');
      box.innerHTML = '<p class="muted">Sending…</p>';
      const r = await api('/settings/test-email', { method: 'POST' });
      box.innerHTML = r.ok
        ? `<div class="notice">Test email sent to <b>${esc(r.to)}</b>. If it does not arrive, check the spam folder.</div>`
        : `<div class="notice error"><b>Could not send.</b> ${esc(r.error || '')}</div>`;
      drawNotifications();
    });
    $('#test-sms').addEventListener('click', async () => {
      const to = $('#test-sms-to').value.trim();
      if (!to) return toast('Enter a number to send the test to');
      const r = await api('/settings/test-sms', { method: 'POST', body: { to } });
      toast(r.ok ? `Test SMS sent to ${r.to}` : 'SMS failed — check the Twilio details (save first)');
    });
    $('#test-hook').addEventListener('click', async () => {
      const box = $('#email-result');
      box.innerHTML = '<p class="muted">Sending…</p>';
      const r = await api('/settings/test-webhook', { method: 'POST', body: { url: $('[data-set="notify.global_webhook_url"]').value } });
      box.innerHTML = r.ok
        ? '<div class="notice"><b>Webhook delivered.</b></div>'
        : `<div class="notice error"><b>Webhook failed.</b> ${esc(r.detail || '')}</div>`;
      drawNotifications();
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

  function badgeFormValues() {
    const b = {};
    $$('[data-set^="badge."]').forEach((i) => {
      b[i.dataset.set.split('.')[1]] = i.type === 'checkbox' ? i.checked : i.type === 'number' ? Number(i.value) : i.value;
    });
    return b;
  }

  function drawBadgePreview() {
    const box = $('#badge-preview');
    if (!box) return;
    const b = badgeFormValues();
    const scale = 3.78 * 0.75; // px per mm at preview scale
    const w = (b.label_width_mm || 62) * scale;
    const h = (b.label_height_mm || 100) * scale;
    const landscape = b.orientation === 'landscape';

    // The label keeps its physical size; a horizontal badge is turned on it, which
    // is exactly what the printed version does.
    box.style.width = `${w}px`;
    box.style.height = `${h}px`;
    box.classList.toggle('landscape', landscape);
    box.style.setProperty('--inner-w', `${landscape ? h : w}px`);
    box.style.setProperty('--inner-h', `${landscape ? w : h}px`);
    box.style.setProperty('--turn', landscape ? `translateX(${w}px) rotate(90deg)` : 'none');

    box.innerHTML = `<div class="b-inner">
      ${b.show_logo && SETTINGS.org.logo_path ? `<img src="${esc(SETTINGS.org.logo_path)}" style="max-height:26px;margin-bottom:4px">` : ''}
      <div class="b-type">${esc(b.title_text || 'VISITOR')}</div>
      ${b.show_photo ? '<div class="b-photo">photo</div>' : ''}
      <div class="b-name">Sam Taylor</div>
      ${b.show_company ? '<div class="b-company">Acme Roofing Ltd</div>' : ''}
      <div class="b-meta">${[b.show_host ? 'Visiting: Alex Green' : '', b.show_date ? new Date().toLocaleDateString('en-GB', { timeZone: siteZone() }) : '',
        b.show_time ? new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: siteZone() }) : '',
        // Same date the server would put on a real one: the site's, not UTC.
        b.show_badge_no ? `${b.badge_prefix || 'V'}${new Date().toLocaleDateString('en-CA', { timeZone: siteZone() }).slice(2).replace(/-/g, '')}-001` : '']
        .filter(Boolean).join('<br>')}</div>
      ${b.show_qr ? '<div class="b-qr"></div>' : ''}
      <div class="b-foot">${esc(b.footer_text || '')}</div></div>`;
  }

  function printTestBadge() {
    const b = badgeFormValues();
    const w = window.open('', '_blank', 'width=420,height=640');
    w.document.write(`<!doctype html><title>Badge test</title><style>
      @page { size: ${b.label_width_mm}mm ${b.label_height_mm}mm; margin: 0; }
      body { margin:0; font-family: system-ui, sans-serif; }
      .card { width:${b.label_width_mm}mm; height:${b.label_height_mm}mm; padding:4mm; display:flex; flex-direction:column;
              align-items:center; text-align:center; box-sizing:border-box; }
      .type { font-weight:800; letter-spacing:.18em; font-size:calc(4.4mm * ${b.font_scale || 1}); }
      .photo { width:30mm; height:30mm; border:1px dashed #999; border-radius:2mm; margin:2mm 0; display:grid; place-items:center; font-size:3mm; color:#777 }
      .name { font-weight:800; font-size:calc(5.6mm * ${b.font_scale || 1}); margin-top:1mm }
      .company { font-size:calc(3.6mm * ${b.font_scale || 1}) }
      .meta { font-size:calc(3.2mm * ${b.font_scale || 1}); margin-top:1.5mm; line-height:1.4 }
      .qr { width:22mm; height:22mm; margin-top:auto; background:repeating-conic-gradient(#000 0 25%,#fff 0 50%) 0 0/4mm 4mm }
      .foot { font-size:calc(2.6mm * ${b.font_scale || 1}); margin-top:1.5mm }
    </style><div class="card">
      <div class="type">${esc(b.title_text || 'VISITOR')}</div>
      ${b.show_photo ? '<div class="photo">photo</div>' : ''}
      <div class="name">Test Badge</div>
      ${b.show_company ? '<div class="company">Alignment check</div>' : ''}
      <div class="meta">${[b.show_host ? 'Visiting: Reception' : '', b.show_date ? new Date().toLocaleDateString('en-GB', { timeZone: siteZone() }) : '',
        b.show_badge_no ? `${b.badge_prefix || 'V'}-TEST` : ''].filter(Boolean).join('<br>')}</div>
      ${b.show_qr ? '<div class="qr"></div>' : ''}
      <div class="foot">${esc(b.footer_text || '')}</div></div>`);
    w.document.close();
    setTimeout(() => w.print(), 400);
  }

  const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  function setPath(obj, path, value) {
    const parts = path.split('.');
    let cur = obj;
    parts.forEach((k, i) => {
      if (i === parts.length - 1) cur[k] = value;
      else cur = (cur[k] = cur[k] || {});
    });
  }

  /* ----------------------------------------------------------------- init */

  async function start() {
    try {
      ME = await api('/me');
    } catch { return showGate(); }
    SETTINGS = await api('/settings');
    document.documentElement.style.setProperty('--brand', SETTINGS.org.primary_color || '#2f7d5d');
    document.documentElement.style.setProperty('--brand-dark', SETTINGS.org.accent_color || '#123a2c');
    applyBranding();
    $('#who').textContent = `${ME.name || ME.email}`;
    $('#shell').classList.remove('hidden');
    const view = (location.hash || '#dashboard').slice(1);
    const btn = $(`#nav button[data-view="${view}"]`);
    if (btn) { $$('#nav button').forEach((x) => x.classList.remove('active')); btn.classList.add('active'); }
    render(VIEWS[view] ? view : 'dashboard');
  }

  (async () => {
    const boot = await fetch('/api/admin/bootstrap').then((r) => r.json()).catch(() => null);
    if (!boot || boot.needs_setup || !boot.user) return showGate();
    start();
  })();
})();
