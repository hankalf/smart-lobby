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

  /* ----------------------------------------------------------------- gate */

  async function showGate() {
    const boot = await fetch('/api/admin/bootstrap').then((r) => r.json());
    $('#shell').classList.add('hidden');
    $('#gate').classList.remove('hidden');
    const setup = boot.needs_setup;
    $('#gate-title').textContent = setup ? 'Set up Smart Lobby' : (boot.org && boot.org.name) || 'Smart Lobby';
    $('#gate-sub').textContent = setup ? 'Create the first administrator account' : 'Sign in to the admin dashboard';
    $('#gate-org-wrap').hidden = !setup;
    $('#gate-name-wrap').hidden = !setup;
    $('#gate-submit').textContent = setup ? 'Create account' : 'Sign in';
    $('#gate-pass').autocomplete = setup ? 'new-password' : 'current-password';
    $('#gate-form').dataset.mode = setup ? 'setup' : 'login';
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
    return `<table><thead><tr><th></th><th>Name</th><th>Company</th><th>Type</th><th>Host</th><th>Badge</th><th>Since</th><th></th></tr></thead>
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
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Company</th><th>Phone</th><th>Host</th><th>In since</th></tr></thead>
      <tbody>${data.rows.map((r) => `<tr><td><b>${esc(r.full_name)}</b></td><td>${esc(r.company || '')}</td>
        <td>${esc(r.phone || '')}</td><td>${esc(r.host_name || '')}</td><td>${fmtTime(r.signed_in_at)}</td></tr>`).join('')}</tbody></table></div>`;
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
          <input class="input" id="v-q" placeholder="Search name, company or host" style="max-width:16rem">
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
        <thead><tr><th>Name</th><th>Company</th><th>Type</th><th>Host</th><th>In</th><th>Out</th><th>Status</th><th></th></tr></thead>
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
          Host: ${esc(v.host_name || '—')} · Badge: ${esc(v.badge_no || '—')} ${v.vehicle_reg ? '· Vehicle: ' + esc(v.vehicle_reg) : ''}<br>
          In: ${fmtDate(v.signed_in_at)} · Out: ${fmtDate(v.signed_out_at)}</p>
        </div>
      </div>
      <h3>Induction</h3>
      ${v.inductions.length ? v.inductions.map((i) => `<p class="muted">${esc(i.slideshow_name || 'Deck')} v${i.slideshow_version} — completed ${fmtDate(i.completed_at)}${i.seconds ? ` (${i.seconds}s)` : ''}</p>`).join('')
        : '<p class="muted">Not shown for this visit (already completed previously, or not required).</p>'}
      <h3>Signed documents</h3>
      ${v.signatures.length ? v.signatures.map((s) => `<p class="muted">${esc(s.agreement_name || 'Agreement')} v${s.agreement_version} — ${fmtDate(s.signed_at)}</p>
        ${s.signature_path ? `<img src="${esc(s.signature_path)}" style="max-width:260px;border:1px solid var(--line);border-radius:8px">` : ''}`).join('')
        : '<p class="muted">Nothing signed.</p>'}
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
      const hosts = await api('/hosts');
      modal('Log a delivery', `
        <div class="form-grid">
          <label class="field"><span>Courier name</span><input class="input" id="nd-name"></label>
          <label class="field"><span>Courier company</span><input class="input" id="nd-company"></label>
          <label class="field"><span>For</span><select class="input" id="nd-host">
            <option value="">— choose a host —</option>${hosts.map((h) => `<option value="${h.id}">${esc(h.name)}</option>`).join('')}</select></label>
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

  VIEWS.documents = async (root) => {
    const rows = await api('/agreements');
    root.innerHTML = `
      <h1 class="page">Documents to sign</h1>
      <p class="page-sub">NDAs, site rules and safety policies. Visitors sign on the kiosk and the signature is stored against the visit.</p>
      <div class="row"><button class="btn" id="a-new">New document</button></div>
      ${rows.map((a) => `<div class="card section">
        <div class="row between"><div><h2 style="margin:0">${esc(a.name)} <span class="pill ${a.active ? 'on' : 'off'}">${a.active ? 'active' : 'off'}</span></h2>
        <span class="muted">v${a.version} · shown to ${esc(JSON.parse(a.required_for).join(', '))}</span></div>
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
    const types = ['visitor', 'contractor', 'interview', 'staff'];
    const req = doc ? JSON.parse(doc.required_for) : ['visitor', 'contractor'];
    modal(doc ? 'Edit document' : 'New document', `
      <label class="field"><span>Title</span><input class="input" id="ag-name" value="${esc(doc ? doc.name : '')}"></label>
      <label class="field"><span>Body</span><textarea class="input" id="ag-body" rows="12">${esc(doc ? doc.body : '')}</textarea></label>
      <span class="muted">Required for</span>
      <div class="form-grid" style="margin:.5rem 0">
        ${types.map((t) => `<label class="check"><input type="checkbox" data-t="${t}" ${req.includes(t) ? 'checked' : ''}> ${t}</label>`).join('')}
      </div>
      <label class="check"><input type="checkbox" id="ag-active" ${!doc || doc.active ? 'checked' : ''}> Active</label>
      ${doc ? '<p class="muted">Saving bumps the version so previously signed copies stay intact.</p>' : ''}`,
      async (bg, close) => {
        const body = {
          name: $('#ag-name', bg).value,
          body: $('#ag-body', bg).value,
          required_for: JSON.stringify($$('[data-t]', bg).filter((c) => c.checked).map((c) => c.dataset.t)),
          active: $('#ag-active', bg).checked ? 1 : 0
        };
        if (doc) { body.version = doc.version + 1; await api(`/agreements/${doc.id}`, { method: 'PATCH', body }); }
        else await api('/agreements', { method: 'POST', body });
        close(); render('documents');
      });
  }

  /* ---------------------------------------------------------------- hosts */

  VIEWS.hosts = async (root) => {
    const rows = await api('/hosts');
    root.innerHTML = `
      <h1 class="page">Hosts</h1>
      <p class="page-sub">The people visitors can ask for. Each host can have their own email and chat webhook for arrival alerts.</p>
      <div class="card section">
        <div class="inline-form" style="margin-bottom:1rem">
          <label class="field"><span>Name</span><input class="input" id="h-name"></label>
          <label class="field"><span>Email</span><input class="input" id="h-email" type="email"></label>
          <label class="field"><span>Mobile (for SMS)</span><input class="input" id="h-phone" type="tel"></label>
          <label class="field"><span>Department</span><input class="input" id="h-dept"></label>
          <label class="field"><span>Chat webhook (optional)</span><input class="input" id="h-hook" placeholder="Slack / Teams URL"></label>
          <button class="btn" id="h-add">Add host</button>
        </div>
        <div class="table-wrap">${rows.length ? `<table>
          <thead><tr><th>Name</th><th>Email</th><th>Mobile</th><th>Department</th><th>Webhook</th><th>Status</th><th></th></tr></thead>
          <tbody>${rows.map((h) => `<tr><td><b>${esc(h.name)}</b></td><td>${esc(h.email || '')}</td>
            <td>${esc(h.phone || '')}</td>
            <td>${esc(h.department || '')}</td><td class="muted">${h.webhook_url ? 'configured' : '—'}</td>
            <td><span class="pill ${h.active ? 'on' : 'off'}">${h.active ? 'active' : 'off'}</span></td>
            <td><button class="btn ghost" data-hdel="${h.id}">Remove</button></td></tr>`).join('')}</tbody></table>`
          : '<p class="empty">No hosts yet — add the people visitors come to see.</p>'}</div>
      </div>`;
    $('#h-add').addEventListener('click', async () => {
      if (!$('#h-name').value.trim()) return toast('Enter a name');
      await api('/hosts', { method: 'POST', body: {
        name: $('#h-name').value.trim(), email: $('#h-email').value.trim(), phone: $('#h-phone').value.trim(),
        department: $('#h-dept').value.trim(), webhook_url: $('#h-hook').value.trim(), active: 1 } });
      render('hosts');
    });
    $$('[data-hdel]').forEach((b) => b.addEventListener('click', async () => {
      await api(`/hosts/${b.dataset.hdel}`, { method: 'DELETE' }); render('hosts');
    }));
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

  /* -------------------------------------------------------------- devices */

  VIEWS.devices = async (root) => {
    const rows = await api('/devices');
    const origin = location.origin;
    root.innerHTML = `
      <h1 class="page">Kiosks</h1>
      <p class="page-sub">Register each tablet so you can see whether it is online. Open
        <code class="token">${origin}/kiosk/</code> on the device and add it to the home screen.</p>
      <div class="card section">
        <div class="inline-form" style="margin-bottom:1rem">
          <label class="field"><span>Device name</span><input class="input" id="dv-name" placeholder="Reception iPad"></label>
          <button class="btn" id="dv-add">Register kiosk</button>
        </div>
        <div class="table-wrap">${rows.length ? `<table>
          <thead><tr><th>Name</th><th>Token</th><th>Last seen</th><th>Status</th><th></th></tr></thead>
          <tbody>${rows.map((d) => {
            const online = d.last_seen_at && (Date.now() - new Date(d.last_seen_at).getTime()) < 5 * 60000;
            return `<tr><td><b>${esc(d.name)}</b></td><td><code class="token">${esc(d.token)}</code></td>
              <td>${fmtDate(d.last_seen_at)}</td>
              <td><span class="pill ${online ? 'on' : 'off'}">${online ? 'online' : 'offline'}</span></td>
              <td><button class="btn ghost" data-dvdel="${d.id}">Remove</button></td></tr>`;
          }).join('')}</tbody></table>` : '<p class="empty">No kiosks registered yet.</p>'}</div>
      </div>`;
    $('#dv-add').addEventListener('click', async () => {
      const d = await api('/devices', { method: 'POST', body: { name: $('#dv-name').value || 'Reception kiosk' } });
      modal('Kiosk registered', `<p>On the tablet, open:</p><p><code class="token">${origin}/kiosk/?token=${d.token}</code></p>
        <p class="muted">The kiosk stores the token locally and reports in every minute so you can see it here.</p>`, null);
      render('devices');
    });
    $$('[data-dvdel]').forEach((b) => b.addEventListener('click', async () => {
      await api(`/devices/${b.dataset.dvdel}`, { method: 'DELETE' }); render('devices');
    }));
  };

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
          ${txt('org.timezone', 'Time zone', 'text', 'Europe/London')}
        </div>
        <div class="row"><label class="btn subtle">${s.org.logo_path ? 'Replace logo' : 'Upload logo'}<input type="file" hidden id="logo-file" accept="image/*"></label>
          ${s.org.logo_path
            ? `<img src="${esc(s.org.logo_path)}" style="max-height:44px;background:#fff;border:1px solid var(--line);border-radius:8px;padding:4px">
               <button class="btn ghost" id="logo-remove">Remove logo</button>`
            : '<span class="muted">No logo set — PNG or SVG with a transparent background works best</span>'}</div>
      </div>

      <div class="card section"><h2>Kiosk sign-in flow</h2>
        <div class="form-grid">
          ${chk('kiosk.require_photo', 'Take a photo', 'Needs https:// or localhost for the camera to open')}
          ${chk('kiosk.require_phone', 'Require a phone number')}
          ${chk('kiosk.require_email', 'Require an email address')}
          ${chk('kiosk.require_host', 'Require choosing a host')}
          ${chk('kiosk.ask_purpose', 'Ask reason for visit')}
          ${chk('kiosk.ask_vehicle', 'Ask vehicle registration')}
          ${chk('kiosk.show_delivery_button', 'Show the delivery button')}
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
        ${chk('notify.on_signin', 'Notify the host on arrival')}
        ${chk('notify.on_signout', 'Notify the host on sign-out')}
        ${chk('notify.on_delivery', 'Notify on deliveries')}
        <h3>Chat</h3>
        <div class="form-grid">
          ${txt('notify.global_webhook_url', 'Fallback chat webhook')}
          <label class="field"><span>Webhook format</span><select class="input" data-set="notify.webhook_format">
            ${[['slack', 'Slack'], ['teams', 'Microsoft Teams'], ['google_chat', 'Google Chat'], ['generic', 'Generic JSON']]
              .map(([v, l]) => `<option value="${v}" ${s.notify.webhook_format === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select></label>
        </div>
        <h3>SMS (Twilio)</h3>
        ${chk('notify.sms_enabled', 'Send text messages to hosts', 'Uses the phone number on each host record')}
        <div class="form-grid">
          ${txt('notify.twilio_account_sid', 'Twilio Account SID')}
          ${txt('notify.twilio_auth_token', 'Twilio Auth Token', 'password')}
          ${txt('notify.sms_from', 'Send from number', 'text', '+441234567890')}
        </div>
        ${chk('notify.sms_on_signin', 'Text the host when a visitor arrives')}
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

    drawBadgePreview();
    $$('[data-set]').forEach((input) => input.addEventListener('input', () => {
      if (input.dataset.set === 'badge.enabled') $('#badge-setup').classList.toggle('hidden', !input.checked);
      if (input.dataset.set.startsWith('badge.')) drawBadgePreview();
    }));

    $('#save-settings').addEventListener('click', async () => {
      const patch = {};
      $$('[data-set]').forEach((input) => {
        const value = input.type === 'checkbox' ? input.checked
          : input.type === 'number' ? Number(input.value)
          : input.value;
        setPath(patch, input.dataset.set, value);
      });
      patch.kiosk = patch.kiosk || {};
      patch.kiosk.visit_types = $$('[data-vtype]').filter((c) => c.checked).map((c) => c.dataset.vtype);
      SETTINGS = await api('/settings', { method: 'PUT', body: patch });
      toast('Settings saved');
    });

    $('#logo-file').addEventListener('change', async (e) => {
      if (!e.target.files[0]) return;
      await upload('/settings/logo', e.target.files[0]);
      toast('Logo updated');
      render('settings');
    });

    const logoRemove = $('#logo-remove');
    if (logoRemove) logoRemove.addEventListener('click', async () => {
      await api('/settings/logo', { method: 'DELETE' });
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
    $('#brand-name').textContent = SETTINGS.org.name || 'Smart Lobby';
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
