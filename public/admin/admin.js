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

  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—');
  const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

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
        <td><button class="btn ghost" data-signout="${r.id}">Sign out</button></td></tr>`).join('')}</tbody></table>`;
  }

  function bindSignoutButtons(root, after) {
    $$('[data-signout]', root).forEach((b) => b.addEventListener('click', async () => {
      await api(`/visits/${b.dataset.signout}/signout`, { method: 'POST' });
      toast('Signed out');
      after();
    }));
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
          <p class="muted">${esc(v.visit_type)} · ${esc(v.purpose || 'no reason given')}<br>
          Staff member: ${esc(v.host_name || '—')} · Badge: ${esc(v.badge_no || '—')} ${v.vehicle_reg ? '· Vehicle: ' + esc(v.vehicle_reg) : ''}<br>
          ${v.location_name ? `Signed in at: ${esc(v.location_name)}${v.device_name ? ` (${esc(v.device_name)})` : ''}<br>` : ''}
          In: ${fmtDate(v.signed_in_at)} · Out: ${fmtDate(v.signed_out_at)}</p>
        </div>
      </div>
      <h3>Induction</h3>
      ${v.inductions.length ? v.inductions.map((i) => `<p class="muted">${esc(i.slideshow_name || 'Deck')} v${i.slideshow_version} — completed ${fmtDate(i.completed_at)}${i.seconds ? ` (${i.seconds}s)` : ''}</p>`).join('')
        : '<p class="muted">Not shown for this visit (already completed previously, or not required).</p>'}
      <h3>Signed documents</h3>
      ${v.signatures.length ? v.signatures.map((s) => {
        let answers = [];
        try { answers = Object.entries(JSON.parse(s.answers || '{}')); } catch { answers = []; }
        const labels = questionLabels(s.agreement_questions);
        return `<p class="muted">${esc(s.agreement_name || 'Agreement')} v${s.agreement_version} — ${fmtDate(s.signed_at)}</p>
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

  VIEWS.induction = async (root) => {
    const { rows, capabilities } = await api('/slideshows');
    root.innerHTML = `
      <h1 class="page">Induction decks</h1>
      <p class="page-sub">Upload a PowerPoint, PDF or images. First-time visitors watch it before they finish signing in;
        people who have already seen the current version skip straight through.</p>
      ${capabilities.libreoffice && capabilities.poppler ? ''
        : `<div class="notice">High-fidelity rendering is not available on this server
           (${capabilities.libreoffice ? '' : 'LibreOffice missing'}${!capabilities.libreoffice && !capabilities.poppler ? ', ' : ''}${capabilities.poppler ? '' : 'poppler/pdftoppm missing'}).
           PowerPoint files are rebuilt from their text and images instead — for pixel-perfect slides, export your deck to PDF and upload that, or install those tools.</div>`}
      <div class="row"><button class="btn" id="s-new">New deck</button></div>
      ${rows.length ? rows.map((s) => `
        <div class="card section" data-show="${s.id}">
          <div class="row between">
            <div><h2 style="margin:0">${esc(s.name)} <span class="pill ${s.active ? 'on' : 'off'}">${s.active ? 'active' : 'off'}</span></h2>
              <span class="muted">v${s.version} · ${s.slide_count} slide(s) · watched ${s.views} time(s)
              ${s.source_file ? `· from ${esc(s.source_file)}` : ''}</span></div>
            <div class="row" style="margin:0">
              <button class="btn ghost" data-preview="${s.id}">Preview</button>
              <button class="btn ghost" data-edit="${s.id}">Settings</button>
              <button class="btn ghost" data-del="${s.id}">Delete</button>
            </div>
          </div>
          <div class="dropzone" data-drop="${s.id}">
            <p><b>Drop a .pptx, .pdf or image here</b> — or
              <label class="btn subtle" style="display:inline-flex">Choose file<input type="file" hidden data-file="${s.id}"
                accept=".pptx,.ppt,.odp,.pdf,image/*"></label></p>
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
    const types = ['visitor', 'contractor', 'interview', 'staff'];
    modal(existing ? 'Deck settings' : 'New induction deck', `
      <label class="field"><span>Name</span><input class="input" id="dk-name" value="${esc(existing ? existing.name : 'Site induction')}"></label>
      <label class="field"><span>Description</span><input class="input" id="dk-desc" value="${esc(existing ? existing.description || '' : '')}"></label>
      <span class="muted">Show to these visitor types</span>
      <div class="form-grid" style="margin:.5rem 0 1rem">
        ${types.map((t) => `<label class="check"><input type="checkbox" data-type="${t}" ${req.includes(t) ? 'checked' : ''}> ${t}</label>`).join('')}
      </div>
      <div class="form-grid">
        <label class="field"><span>Repeat after (days, 0 = never)</span>
          <input class="input" id="dk-repeat" type="number" min="0" value="${existing ? existing.repeat_after_days || 0 : 0}"></label>
        <label class="field"><span>Minimum seconds per slide</span>
          <input class="input" id="dk-min" type="number" min="0" value="${existing ? existing.min_seconds_per_slide : 0}"></label>
      </div>
      <label class="check"><input type="checkbox" id="dk-active" ${!existing || existing.active ? 'checked' : ''}> Active</label>`,
      async (bg, close) => {
        const body = {
          name: $('#dk-name', bg).value,
          description: $('#dk-desc', bg).value,
          required_for: $$('[data-type]', bg).filter((c) => c.checked).map((c) => c.dataset.type),
          repeat_after_days: Number($('#dk-repeat', bg).value) || null,
          min_seconds_per_slide: Number($('#dk-min', bg).value) || 0,
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

  // The kiosk home-screen cards these documents can be attached to.
  const CATEGORIES = [
    ['visitor', 'Visitors', 'Sign in / Sign out card'],
    ['contractor', 'Contractors', 'Sign in / Sign out card'],
    ['interview', 'Interviews', 'Interview card — candidates'],
    ['staff', 'Staff', 'Employees, if you sign them in']
  ];
  const categoryLabel = (t) => (CATEGORIES.find(([v]) => v === t) || [t, t])[1];

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
    const countQuestions = (a) => { try { return JSON.parse(a.questions || '[]').length; } catch { return 0; } };
    root.innerHTML = `
      <h1 class="page">Documents to sign</h1>
      <p class="page-sub">NDAs, site rules and safety declarations. Each one is assigned to the categories that must sign it,
        and can ask its own questions before the signature. Deliveries do not sign anything.</p>
      <div class="row"><button class="btn" id="a-new">New document</button></div>
      ${rows.map((a) => `<div class="card section">
        <div class="row between"><div><h2 style="margin:0">${esc(a.name)} <span class="pill ${a.active ? 'on' : 'off'}">${a.active ? 'active' : 'off'}</span></h2>
        <span class="muted">v${a.version} · signed by ${esc(JSON.parse(a.required_for).map(categoryLabel).join(', ') || 'nobody')}${
          countQuestions(a) ? ` · ${countQuestions(a)} question${countQuestions(a) === 1 ? '' : 's'}` : ''}</span></div>
        <div class="row" style="margin:0"><button class="btn ghost" data-doc="${a.id}">Edit</button>
        <button class="btn ghost" data-docdel="${a.id}">Delete</button></div></div>
        <pre class="muted" style="white-space:pre-wrap;margin:0">${esc(a.body.slice(0, 400))}${a.body.length > 400 ? '…' : ''}</pre></div>`).join('')
        || '<div class="card section"><p class="empty">No documents yet.</p></div>'}`;
    $('#a-new').addEventListener('click', () => docEditor(null));
    $$('[data-doc]').forEach((b) => b.addEventListener('click', async () =>
      docEditor((await api('/agreements')).find((x) => String(x.id) === b.dataset.doc))));
    $$('[data-docdel]').forEach((b) => b.addEventListener('click', () => confirmAction('Delete this document?',
      async () => { await api(`/agreements/${b.dataset.docdel}`, { method: 'DELETE' }); render('documents'); })));
  };

  function docEditor(doc) {
    const req = doc ? JSON.parse(doc.required_for) : ['visitor', 'contractor'];
    let questions = [];
    try { questions = JSON.parse((doc && doc.questions) || '[]'); } catch { questions = []; }

    const m = modal(doc ? 'Edit document' : 'New document', `
      <label class="field"><span>Title</span><input class="input" id="ag-name" value="${esc(doc ? doc.name : '')}"></label>
      <label class="field"><span>What they read and sign</span>
        <textarea class="input" id="ag-body" rows="10">${esc(doc ? doc.body : '')}</textarea></label>

      <h3>Who signs this</h3>
      <p class="muted" style="margin-top:0">Matched to the cards on the kiosk home screen.</p>
      <div class="form-grid" style="margin:.5rem 0 1rem">
        ${CATEGORIES.map(([t, label, hint]) => `<label class="check"><input type="checkbox" data-t="${t}" ${req.includes(t) ? 'checked' : ''}>
          <span>${label}<br><span class="muted">${hint}</span></span></label>`).join('')}
      </div>

      <h3>Questions</h3>
      <p class="muted" style="margin-top:0">Asked on the kiosk just above the signature. Answers are stored against the visit.</p>
      <div id="q-list"></div>
      <button class="btn subtle" id="q-add" type="button">Add a question</button>

      <label class="check" style="margin-top:1rem"><input type="checkbox" id="ag-active" ${!doc || doc.active ? 'checked' : ''}> Active</label>
      ${doc ? '<p class="muted">Saving bumps the version, so copies already signed stay exactly as they were signed.</p>' : ''}`,
      async (bg, close) => {
        const body = {
          name: $('#ag-name', bg).value,
          body: $('#ag-body', bg).value,
          required_for: JSON.stringify($$('[data-t]', bg).filter((c) => c.checked).map((c) => c.dataset.t)),
          questions: JSON.stringify(collectQuestions(bg)),
          active: $('#ag-active', bg).checked ? 1 : 0
        };
        if (!body.name.trim()) return toast('Give the document a title');
        if (doc) { body.version = doc.version + 1; await api(`/agreements/${doc.id}`, { method: 'PATCH', body }); }
        else await api('/agreements', { method: 'POST', body });
        close(); render('documents');
      });

    const list = $('#q-list', m.bg);
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
          ${q.type === 'choice' ? `<input class="input" data-qopts="${i}" style="margin-top:.5rem"
            placeholder="Options, separated by commas" value="${esc((q.options || []).join(', '))}">` : ''}
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
    };

    function collectQuestions() {
      sync();
      return questions
        .filter((q) => String(q.label || '').trim())
        .map((q, i) => ({
          id: q.id || `q${i + 1}`,
          label: q.label.trim(),
          type: q.type || 'yesno',
          required: !!q.required,
          ...(q.type === 'choice' ? { options: q.options || [] } : {})
        }));
    }

    $('#q-add', m.bg).addEventListener('click', () => {
      sync();
      questions.push({ id: `q${questions.length + 1}`, label: '', type: 'yesno', required: true });
      drawQuestions();
    });
    drawQuestions();
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
            <td><button class="btn ghost" data-hdel="${h.id}">Remove</button></td></tr>`).join('')}</tbody></table>`
          : '<p class="empty">No staff yet — add the people visitors come to see.</p>'}</div>
      </div>

      <div class="card section">
        <h2>Add several at once from a spreadsheet</h2>
        <p class="muted" style="margin-top:0">Upload an Excel file (<b>.xlsx</b>) or a <b>.csv</b>. The first row should be
          headings — <i>Name</i>, <i>Email</i>, <i>Mobile</i>, <i>Department</i>, <i>Chat webhook</i>. Only Name is required,
          and the headings can be worded your way (“Full name”, “Phone”, “Team” and similar are understood).</p>
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
            in a shared channel.</p>
          <ol>
            <li>In Teams, open the chat with that person → <b>⋯</b> → <b>Workflows</b>. (Or open the
              <b>Workflows</b> app and start from there.)</li>
            <li>Choose the template <b>“Post to a chat when a webhook request is received”</b> — the
              <i>chat</i> one, not the channel one.</li>
            <li>Confirm the chat it will post into, then <b>Add workflow</b> and copy the URL.</li>
            <li>Paste it into that person's <b>Chat webhook</b> box above. Only their visitors trigger it.</li>
          </ol>
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
    $$('[data-hdel]').forEach((b) => b.addEventListener('click', async () => {
      await api(`/staff/${b.dataset.hdel}`, { method: 'DELETE' }); render('staff');
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
          on sign-out: ${p.auto_unlock_on_signout ? 'yes' : 'no'} · hold ${p.unlock_seconds}s</p></div>`).join('')
        : '<div class="card section"><p class="empty">No doors configured.</p></div>'}
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

  function doorEditor(p) {
    modal(p ? 'Edit door' : 'Add door', `
      <div class="form-grid">
        <label class="field"><span>Name</span><input class="input" id="ap-name" value="${esc(p ? p.name : 'Front door')}"></label>
        <label class="field"><span>Method</span><select class="input" id="ap-method">
          ${['POST', 'GET', 'PUT'].map((m) => `<option ${p && p.method === m ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span>URL</span><input class="input" id="ap-url" placeholder="http://192.168.1.50/relay/0?turn=on&amp;timer={{seconds}}"
        value="${esc(p ? p.url || '' : '')}"></label>
      <label class="field"><span>Headers (JSON, optional)</span><input class="input" id="ap-headers"
        placeholder='{"Authorization":"Bearer …"}' value="${esc(p ? p.headers || '' : '')}"></label>
      <label class="field"><span>Body template (optional)</span><textarea class="input" id="ap-body" rows="3"
        placeholder='{"action":"unlock","seconds":{{seconds}}}'>${esc(p ? p.body || '' : '')}</textarea></label>
      <div class="form-grid">
        <label class="field"><span>Unlock hold (seconds)</span><input class="input" id="ap-secs" type="number" min="1" value="${p ? p.unlock_seconds : 5}"></label>
      </div>
      <label class="check"><input type="checkbox" id="ap-in" ${p && p.auto_unlock_on_signin ? 'checked' : ''}> Unlock automatically when a visitor signs in</label>
      <label class="check"><input type="checkbox" id="ap-out" ${p && p.auto_unlock_on_signout ? 'checked' : ''}> Unlock automatically when a visitor signs out</label>
      <label class="check"><input type="checkbox" id="ap-en" ${!p || p.enabled ? 'checked' : ''}> Enabled</label>`,
      async (bg, close) => {
        const body = {
          name: $('#ap-name', bg).value, method: $('#ap-method', bg).value, url: $('#ap-url', bg).value,
          headers: $('#ap-headers', bg).value, body: $('#ap-body', bg).value,
          unlock_seconds: Number($('#ap-secs', bg).value) || 5,
          auto_unlock_on_signin: $('#ap-in', bg).checked ? 1 : 0,
          auto_unlock_on_signout: $('#ap-out', bg).checked ? 1 : 0,
          enabled: $('#ap-en', bg).checked ? 1 : 0
        };
        if (p) await api(`/access-points/${p.id}`, { method: 'PATCH', body });
        else await api('/access-points', { method: 'POST', body });
        close(); render('access');
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

  /* -------------------------------------------------------------- devices */

  const CAMERA_LABEL = { front: 'Front camera', rear: 'Rear camera' };

  VIEWS.devices = async (root) => {
    const [rows, locations] = await Promise.all([api('/devices'), api('/locations')]);
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
          <thead><tr><th>Name</th><th>Location</th><th>Camera</th><th>Mode</th><th>Printing</th><th>Last seen</th><th>Status</th><th></th></tr></thead>
          <tbody>${rows.map((d) => {
            const online = d.last_seen_at && (Date.now() - new Date(d.last_seen_at).getTime()) < 5 * 60000;
            return `<tr>
              <td><b>${esc(d.name)}</b></td>
              <td>${esc(d.location_name || '—')}</td>
              <td>${esc(cameraName(d))}</td>
              <td>${esc(d.mode || 'kiosk')}</td>
              <td><span class="pill ${d.print_enabled ? 'on' : 'off'}">${d.print_enabled ? 'on' : 'off'}</span></td>
              <td>${fmtDate(d.last_seen_at)}</td>
              <td><span class="pill ${online ? 'on' : 'off'}">${online ? 'online' : 'offline'}</span></td>
              <td><button class="btn ghost" data-dvedit="${d.id}">Edit</button>
                  <button class="btn ghost" data-dvlink="${d.id}">Link</button>
                  <button class="btn ghost" data-dvdel="${d.id}">Remove</button></td></tr>`;
          }).join('')}</tbody></table>` : '<p class="empty">No devices registered yet.</p>'}</div>
      </div>`;

    const showLink = (d) => modal(`${d.name} — setup link`, `
      <p>On the device, open:</p>
      <p><code class="token">${origin}/kiosk/?token=${d.token}</code></p>
      <p class="muted">It stores the token locally and reports in every minute, so this page shows whether it is online.
        Add the page to the home screen for a full-screen kiosk.</p>`, null);

    $('#dv-add').addEventListener('click', async () => {
      const d = await api('/devices', { method: 'POST', body: {
        name: $('#dv-name').value || 'Reception kiosk', location_id: $('#dv-loc').value || null } });
      showLink(d);
      render('devices');
    });

    $$('[data-dvlink]').forEach((b) => b.addEventListener('click', () =>
      showLink(rows.find((x) => String(x.id) === b.dataset.dvlink))));

    $$('[data-dvedit]').forEach((b) => b.addEventListener('click', () => {
      const d = rows.find((x) => String(x.id) === b.dataset.dvedit);
      let reported = [];
      try { reported = JSON.parse(d.cameras || '[]'); } catch { reported = []; }
      const options = [['front', 'Front camera'], ['rear', 'Rear camera'],
        ...reported.map((c) => [c.id, c.label])];

      modal(`Edit ${d.name}`, `
        <div class="form-grid">
          <label class="field"><span>Device name</span><input class="input" id="de-name" value="${esc(d.name)}"></label>
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
        <p class="muted">${reported.length
          ? `${reported.length} camera${reported.length === 1 ? '' : 's'} reported by this device.`
          : 'This device has not reported its cameras yet — it does so once it has been opened and allowed camera access. Front/rear still work.'}</p>
        <label class="check"><input type="checkbox" id="de-print" ${d.print_enabled ? 'checked' : ''}>
          <span>Print badges from this device<br><span class="muted">Only applies while badge printing is on in
            Settings. Turn it off for a device with no printer attached.</span></span></label>
        <p class="muted">More operational modes are coming; every device runs in kiosk mode for now.</p>`,
        async (bg, close) => {
          await api(`/devices/${d.id}`, { method: 'PATCH', body: {
            name: $('#de-name', bg).value,
            location_id: $('#de-loc', bg).value || null,
            default_camera: $('#de-cam', bg).value,
            mode: $('#de-mode', bg).value,
            print_enabled: $('#de-print', bg).checked } });
          close(); render('devices');
        });
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
          ${txt('org.primary_color', 'Primary colour', 'color')}
          ${txt('org.accent_color', 'Dark accent colour', 'color')}
          <label class="field"><span>Time zone</span>
            <select class="input" data-set="org.timezone" id="tz-select"></select></label>
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

      <div class="card section"><h2>Kiosk sign-in flow</h2>
        <div class="form-grid">
          ${chk('kiosk.require_photo', 'Take a photo', 'Needs https:// or localhost for the camera to open')}
          ${chk('kiosk.require_phone', 'Require a phone number')}
          ${chk('kiosk.require_email', 'Require an email address')}
          ${chk('kiosk.require_host', 'Require choosing a staff member')}
          ${chk('kiosk.ask_purpose', 'Ask reason for visit')}
          ${chk('kiosk.ask_vehicle', 'Ask vehicle registration')}
          ${chk('kiosk.welcome_shows_menu', 'Skip “Touch to start”',
            'Put the sections straight on the home screen')}
          ${chk('kiosk.show_onsite_count', 'Show how many people are on site')}
        </div>
        <div class="form-grid">
          ${txt('kiosk.idle_timeout_seconds', 'Return to the welcome screen after (seconds)', 'number')}
          ${txt('kiosk.thank_you_seconds', 'Hold the thank-you screen for (seconds)', 'number')}
          ${txt('kiosk.auto_signout_hour', 'Automatically sign everyone out at (hour, 24h)', 'number')}
          <label class="field"><span>Returning-visitor lookup</span>
            <select class="input" data-set="kiosk.returning_lookup_field">
              <option value="phone" ${s.kiosk.returning_lookup_field === 'phone' ? 'selected' : ''}>Mobile number</option>
              <option value="email" ${s.kiosk.returning_lookup_field === 'email' ? 'selected' : ''}>Email address</option>
            </select></label>
        </div>
        <h3>Sections on the home screen</h3>
        <p class="muted" style="margin-top:0">Sign in and sign out always share the first card. Switch the rest off
          for sites that do not need them.</p>
        <div class="form-grid">
          ${chk('kiosk.show_interview_button', 'Interview', 'For candidates arriving to meet the hiring team')}
          ${chk('kiosk.show_delivery_button', 'Delivery', 'Courier drop-off — also needs Deliveries enabled below')}
        </div>
        <p class="muted">A “Request entry” card appears too when you switch it on under <b>Access control</b>.</p>

        <span class="muted">Visit types offered on the kiosk</span>
        <div class="form-grid" style="margin-top:.5rem">
          ${['visitor', 'contractor', 'interview', 'staff'].map((t) => `<label class="check">
            <input type="checkbox" data-vtype="${t}" ${s.kiosk.visit_types.includes(t) ? 'checked' : ''}> ${t}</label>`).join('')}
        </div>
      </div>

      <div class="card section"><h2>ID badge printing</h2>
        <p class="muted">Badge printing is optional. Turn it on only when a label printer is connected — everything else keeps working either way.</p>
        ${chk('badge.enabled', 'Print a badge when someone signs in')}
        <div id="badge-setup" class="${s.badge.enabled ? '' : 'hidden'}">
          <div class="badge-preview-wrap" style="margin-top:1rem">
            <div style="flex:1;min-width:280px">
              <div class="form-grid">
                ${txt('badge.label_width_mm', 'Label width (mm)', 'number')}
                ${txt('badge.label_height_mm', 'Label height (mm)', 'number')}
                ${txt('badge.title_text', 'Header text')}
                ${txt('badge.badge_prefix', 'Badge number prefix')}
                ${txt('badge.footer_text', 'Footer text')}
                ${txt('badge.font_scale', 'Font scale (1 = normal)', 'number')}
              </div>
              <div class="form-grid">
                ${chk('badge.auto_print', 'Print automatically (no extra tap)')}
                ${chk('badge.show_logo', 'Show logo')}
                ${chk('badge.show_photo', 'Show photo')}
                ${chk('badge.show_company', 'Show company')}
                ${chk('badge.show_host', 'Show host')}
                ${chk('badge.show_date', 'Show date')}
                ${chk('badge.show_time', 'Show time')}
                ${chk('badge.show_qr', 'Show sign-out QR code')}
                ${chk('badge.show_badge_no', 'Show badge number')}
              </div>
              <div class="row"><button class="btn subtle" id="badge-test">Print a test badge</button></div>
              <p class="muted">Setup: connect the label printer to the tablet or the kiosk PC, set it as the default printer,
                choose the matching label size in the printer driver, then print a test badge. In Chrome/Edge, turn off
                “Headers and footers” and set margins to <b>None</b> so the label fills the whole area. On iPad, AirPrint
                shows the print dialog — pick the label printer once and it is remembered.</p>
            </div>
            <div>
              <span class="muted">Preview</span>
              <div class="badge-preview" id="badge-preview"></div>
            </div>
          </div>
        </div>
      </div>

      <div class="card section"><h2>Induction</h2>
        ${chk('induction.enabled', 'Show the induction deck during sign-in')}
        ${chk('induction.show_to_returning_visitors', 'Show it every visit', 'Off = only first-timers and anyone who has not seen the current version')}
        ${chk('induction.require_acknowledgement', 'Ask for a confirmation tap at the end')}
        <div class="form-grid">${txt('induction.acknowledgement_text', 'Confirmation wording')}</div>
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
        ${chk('notify.email_enabled', 'Send host emails over SMTP')}
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
        <div class="form-grid">
          ${txt('notify.global_webhook_url', 'Fallback chat webhook')}
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
      patch.kiosk.visit_types = $$('[data-vtype]').filter((c) => c.checked).map((c) => c.dataset.vtype);
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

    $('#test-email').addEventListener('click', async () => {
      const r = await api('/settings/test-email', { method: 'POST', body: { to: ME.email } });
      toast(r.ok ? `Test email sent to ${ME.email}` : 'Could not send — check the SMTP settings (save first)');
    });
    $('#test-sms').addEventListener('click', async () => {
      const to = $('#test-sms-to').value.trim();
      if (!to) return toast('Enter a number to send the test to');
      const r = await api('/settings/test-sms', { method: 'POST', body: { to } });
      toast(r.ok ? `Test SMS sent to ${r.to}` : 'SMS failed — check the Twilio details (save first)');
    });
    $('#test-hook').addEventListener('click', async () => {
      const r = await api('/settings/test-webhook', { method: 'POST', body: { url: $('[data-set="notify.global_webhook_url"]').value } });
      toast(r.ok ? 'Test message posted' : 'Webhook call failed');
    });
    const badgeTest = $('#badge-test');
    if (badgeTest) badgeTest.addEventListener('click', printTestBadge);

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
    box.style.width = `${(b.label_width_mm || 62) * scale}px`;
    box.style.height = `${(b.label_height_mm || 100) * scale}px`;
    box.innerHTML = `
      ${b.show_logo && SETTINGS.org.logo_path ? `<img src="${esc(SETTINGS.org.logo_path)}" style="max-height:26px;margin-bottom:4px">` : ''}
      <div class="b-type">${esc(b.title_text || 'VISITOR')}</div>
      ${b.show_photo ? '<div class="b-photo">photo</div>' : ''}
      <div class="b-name">Sam Taylor</div>
      ${b.show_company ? '<div class="b-company">Acme Roofing Ltd</div>' : ''}
      <div class="b-meta">${[b.show_host ? 'Visiting: Alex Green' : '', b.show_date ? new Date().toLocaleDateString('en-GB') : '',
        b.show_time ? new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '',
        b.show_badge_no ? `${b.badge_prefix || 'V'}${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-001` : '']
        .filter(Boolean).join('<br>')}</div>
      ${b.show_qr ? '<div class="b-qr"></div>' : ''}
      <div class="b-foot">${esc(b.footer_text || '')}</div>`;
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
      <div class="meta">${[b.show_host ? 'Visiting: Reception' : '', b.show_date ? new Date().toLocaleDateString('en-GB') : '',
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
