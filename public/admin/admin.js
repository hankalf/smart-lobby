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

  /** The same, with a way back from what just happened. */
  function toastUndo(msg, undo, ms = 8000) {
    const t = $('#toast');
    t.innerHTML = '';
    t.append(msg + ' ');
    const btn = document.createElement('button');
    btn.className = 'btn link';
    btn.type = 'button';
    btn.textContent = 'Undo';
    btn.style.color = '#fff';
    btn.addEventListener('click', async () => {
      t.classList.add('hidden');
      clearTimeout(toast._t);
      try { await undo(); } catch { toast('Could not undo that'); }
    });
    t.append(btn);
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
    showBoardLink();
  }

  /**
   * The board sits beside "Open kiosk", but only once it has been switched on
   * — the link carries the key, and a link to a board that does not exist yet
   * is worse than no link at all.
   */
  async function showBoardLink() {
    const link = $('#open-board');
    if (!link) return;
    try {
      const b = await api('/board');
      if (b && b.url) {
        link.href = b.url;
        link.classList.remove('hidden');
      } else {
        link.classList.add('hidden');
      }
    } catch { link.classList.add('hidden'); }
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

  let CURRENT = '';

  /** The tab a page sits under: itself, or the parent whose list names it. */
  function parentOf(view) {
    const child = $(`#nav .subnav button[data-view="${view}"]`);
    return child ? child.closest('.subnav').dataset.for : view;
  }

  /** Highlight the tab, open only its sub-list, and mark the entry within it. */
  function markNav(view, section) {
    const parent = parentOf(view);
    $$('#nav > button').forEach((x) => x.classList.toggle('active', x.dataset.view === parent));
    $$('#nav .subnav').forEach((sub) => { sub.hidden = sub.dataset.for !== parent; });
    $$('#nav .subnav button').forEach((x) => x.classList.toggle('active',
      (x.dataset.view && x.dataset.view === view)
      || (!!section && view === 'settings' && x.dataset.section === section)));
  }

  const goView = (view) => { markNav(view); location.hash = view; render(view); };

  $$('#nav > button').forEach((b) => b.addEventListener('click', () => {
    // A heading with no page of its own — Sign-in setup — opens its first entry.
    if (b.dataset.group && !VIEWS[b.dataset.view]) {
      const first = $(`#nav .subnav[data-for="${b.dataset.group}"] button[data-view]`);
      if (first) return first.click();
    }
    goView(b.dataset.view);
  }));

  $$('#nav .subnav button').forEach((b) => b.addEventListener('click', async () => {
    if (b.dataset.view) return goView(b.dataset.view);
    // A panel on the settings page: show that page if it is not up, then open it.
    const section = b.dataset.section;
    markNav('settings', section);
    location.hash = `settings/${section}`;
    if (CURRENT !== 'settings') await render('settings');
    openSection(section);
  }));

  const VIEWS = {};

  async function render(view) {
    const target = $('#view');
    target.innerHTML = '<p class="empty">Loading…</p>';
    CURRENT = view;
    try {
      await (VIEWS[view] || VIEWS.dashboard)(target);
    } catch (err) {
      if (err.message !== 'unauthenticated') target.innerHTML = `<p class="empty">Could not load: ${esc(err.message)}</p>`;
    }
  }

  /* --------------------------------------------------- collapsible panels */

  /*
   * Settings had grown to a dozen panels stacked end to end, which meant
   * scrolling past branding and badge printing every time to reach retention.
   * Each panel now folds shut, and which ones are left open is remembered per
   * browser — so whoever lives in one section keeps it open and the rest
   * stays out of the way.
   */
  const OPEN_KEY = 'sl.admin.open-sections';
  const openSet = () => { try { return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || '[]')); } catch { return new Set(); } };
  const saveOpen = (s) => { try { localStorage.setItem(OPEN_KEY, JSON.stringify([...s])); } catch { /* private mode */ } };

  function setSection(sec, on) {
    sec.classList.toggle('open', on);
    const head = sec.querySelector(':scope > .sec-head');
    if (head) head.setAttribute('aria-expanded', String(on));
    if (on) sec.dispatchEvent(new CustomEvent('sec:open'));
  }

  /** Turn every `.card.section` carrying an id into a panel that folds. */
  function collapseSections(root) {
    const open = openSet();
    $$('.card.section[id]', root).forEach((sec) => {
      const h2 = sec.querySelector(':scope > h2');
      if (!h2 || sec.classList.contains('collapsible')) return;
      const body = document.createElement('div');
      body.className = 'sec-body';
      while (h2.nextSibling) body.appendChild(h2.nextSibling);
      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'sec-head';
      h2.replaceWith(head);
      head.append(el('<span class="chev" aria-hidden="true">▶</span>'), h2);
      sec.append(body);
      sec.classList.add('collapsible');
      setSection(sec, open.has(sec.id));
      head.addEventListener('click', () => {
        const on = !sec.classList.contains('open');
        const s = openSet();
        if (on) s.add(sec.id); else s.delete(sec.id);
        saveOpen(s);
        setSection(sec, on);
      });
    });
  }

  /** Run something the first time a panel is opened — and now, if it already is. */
  function onSectionOpen(id, fn) {
    const sec = document.getElementById(id);
    if (!sec) return;
    let done = false;
    const go = () => { if (done) return; done = true; fn(); };
    if (sec.classList.contains('open')) go();
    else sec.addEventListener('sec:open', go);
  }

  function openSection(slug) {
    const sec = document.getElementById(`set-${slug}`);
    if (!sec) return;
    if (!sec.classList.contains('open')) {
      const s = openSet();
      s.add(sec.id);
      saveOpen(s);
      setSection(sec, true);
    }
    sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    sec.classList.add('flash');
    setTimeout(() => sec.classList.remove('flash'), 1400);
  }

  function setAllSections(root, on) {
    const s = openSet();
    $$('.collapsible[id]', root).forEach((sec) => {
      if (on) s.add(sec.id); else s.delete(sec.id);
      setSection(sec, on);
    });
    saveOpen(s);
  }

  /* ------------------------------------------------------------ dashboard */

  /*
   * The things that break silently.
   *
   * A deleted Teams flow and a kiosk that stopped talking both look exactly
   * like everything being fine — the failures were recorded all along, but
   * only somebody who thought to open the activity list would ever see them.
   * These say it on the page people actually look at.
   */
  function healthNotices(h) {
    if (!h) return '';
    const out = [];
    const n = h.notifications || {};
    if (n.failed > 0) {
      out.push(`<div class="notice error"><b>${n.failed} notification${n.failed === 1 ? '' : 's'} failed
        in the last ${n.window_hours} hours.</b> Arrivals may not be reaching Teams. The reason for each is under
        <b>Settings → Notifications → Activity</b>${n.waiting ? `, and ${n.waiting} are waiting to be tried again` : ''}.</div>`);
    } else if (n.waiting) {
      out.push(`<div class="notice">${n.waiting} notification${n.waiting === 1 ? ' is' : 's are'} waiting to be
        sent again after a failure.</div>`);
    }
    const b = h.backup || {};
    if (b.pending_restore) {
      out.push(`<div class="notice"><b>A restore is waiting to be applied.</b> It takes effect the next time the
        server starts. Until then this is still the old data.</div>`);
    } else if (b.stale) {
      out.push(`<div class="notice error"><b>${b.last_at
        ? `The last backup was ${esc(fmtDate(b.last_at))}.`
        : 'No backup has ever been written.'}</b> One should be written every night —
        check <b>Settings → Backups</b>.</div>`);
    }
    if ((h.quiet_devices || []).length) {
      const names = h.quiet_devices.map((d) => esc(d.name)).join(', ');
      out.push(`<div class="notice error"><b>No word from ${names}</b> for over an hour.
        A kiosk that has stopped checking in is either switched off or off the network —
        anyone signing in on it is being queued, not recorded.</div>`);
    }
    return out.join('');
  }

  VIEWS.dashboard = async (root) => {
    const d = await api('/dashboard');
    const max = Math.max(1, ...d.week.map((w) => w.n));
    root.innerHTML = `
      <h1 class="page">Dashboard</h1>
      <p class="page-sub">Live view of who is on site right now.</p>
      ${d.storage_warning ? `<div class="notice error" style="font-size:1rem">
        <b>Storage is not persistent.</b> ${esc(d.storage_warning)}</div>` : ''}
      ${healthNotices(d.health)}
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
      const id = b.dataset.signout;
      await api(`/visits/${id}/signout`, { method: 'POST' });
      // Sign-out is one tap beside somebody else's name; the way back should be too.
      toastUndo('Signed out', async () => {
        await api(`/visits/${id}/undo-signout`, { method: 'POST' });
        toast('Back on site');
        after();
      });
      after();
    }));
    $$('[data-undo-signout]', root).forEach((b) => b.addEventListener('click', async () => {
      try {
        await api(`/visits/${b.dataset.undoSignout}/undo-signout`, { method: 'POST' });
        toast('Back on site');
        after();
      } catch (err) {
        toast((err.data && err.data.message) || 'Could not put them back on site');
      }
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
          <td style="white-space:nowrap"><button class="btn ghost" data-visit="${r.id}">View</button>
            ${r.status === 'onsite'
              ? `<button class="btn ghost" data-signout="${r.id}">Sign out</button>`
              : `<button class="btn ghost" data-undo-signout="${r.id}">Back on site</button>`}
          </td></tr>`).join('')}</tbody></table>`
        : '<p class="empty">No visits match those filters.</p>';
      $$('[data-visit]').forEach((b) => b.addEventListener('click', () => visitDetail(b.dataset.visit)));
      bindSignoutButtons($('#v-results'), load);
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
          ${v.id_number ? `Licence: ${esc(v.id_name || '')} · ${esc(v.id_number)}${v.id_state ? ' · ' + esc(v.id_state) : ''}<br>` : ''}
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
          countQuestions(a) ? ` · ${countQuestions(a)} question${countQuestions(a) === 1 ? '' : 's'}` : ''} · ${
          a.repeat_after_days === null || a.repeat_after_days === undefined ? 'every visit'
            : a.repeat_after_days === 0 ? 'signed once' : `every ${a.repeat_after_days} days`}</span></div>
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

      <h3>How often</h3>
      <p class="muted" style="margin-top:0">Same as the induction decks: how often the same person is asked to sign
        this again. Editing the wording brings it back to everyone regardless, so nobody stays signed onto an old
        version.</p>
      <div class="inline-form" style="margin:.5rem 0 1rem">
        <label class="field" style="max-width:18rem"><span>Ask them to sign</span>
          <select class="input" id="ag-repeat-mode">
            <option value="always" ${!doc || doc.repeat_after_days === null || doc.repeat_after_days === undefined ? 'selected' : ''}>Every visit</option>
            <option value="once" ${doc && doc.repeat_after_days === 0 ? 'selected' : ''}>Once — until the document changes</option>
            <option value="days" ${doc && doc.repeat_after_days > 0 ? 'selected' : ''}>Again after a number of days</option>
          </select></label>
        <label class="field" style="max-width:10rem" id="ag-repeat-days-wrap" ${doc && doc.repeat_after_days > 0 ? '' : 'hidden'}>
          <span>Days</span>
          <input class="input" id="ag-repeat-days" type="number" min="1" value="${doc && doc.repeat_after_days > 0 ? doc.repeat_after_days : 90}"></label>
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
        const repeatMode = $('#ag-repeat-mode', bg).value;
        const body = {
          name: $('#ag-name', bg).value,
          body: $('#ag-body', bg).value,
          name_es: $('#ag-name-es', bg).value.trim() || null,
          body_es: $('#ag-body-es', bg).value.trim() || null,
          required_for: JSON.stringify($$('[data-t]', bg).filter((c) => c.checked).map((c) => c.dataset.t)),
          questions: JSON.stringify(collectQuestions(bg)),
          require_signature: $('#ag-sig', bg).checked ? 1 : 0,
          repeat_after_days: repeatMode === 'always' ? null
            : repeatMode === 'once' ? 0
            : Math.max(1, Number($('#ag-repeat-days', bg).value) || 90),
          active: $('#ag-active', bg).checked ? 1 : 0
        };
        if (!body.name.trim()) return toast('Give the document a title');
        if (doc) {
          /*
           * The version only moves when what people read or answer has changed.
           * It is what brings a "once" or "every 90 days" document back to
           * everyone — so flipping a setting like the frequency itself must not
           * bump it and quietly void every standing signature.
           */
          const changed = ['name', 'body', 'name_es', 'body_es', 'questions']
            .some((f) => String(body[f] || '') !== String(doc[f] || (f === 'questions' ? '[]' : '')));
          if (changed) body.version = doc.version + 1;
          await api(`/agreements/${doc.id}`, { method: 'PATCH', body });
        } else await api('/agreements', { method: 'POST', body });
        close(); render('documents');
      });

    $('#ag-repeat-mode', m.bg).addEventListener('change', (e) => {
      $('#ag-repeat-days-wrap', m.bg).hidden = e.target.value !== 'days';
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
      <p class="page-sub">The people visitors can ask for. Give each one their own Teams link and their visitors' arrivals go straight to them; a mobile number adds an optional text.</p>
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
        <p class="muted" style="margin-top:0">A link posts arrivals straight into Microsoft Teams — a channel, or a
          direct message to one person. Paste it into a staff member's <b>Chat webhook</b> field above and that
          person's arrivals go there. Leave it blank and the company channel from
          <b>Settings → Notifications</b> is used instead. Slack and Google Chat links work too, recognised from the
          URL, so different people can be on different platforms.</p>

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
    ['project', 'Project', 'Picked from the list on the Projects tab'],
    ['id_scan', "Scan a driver's licence",
      'Reads the barcode on the back of a US or Canadian licence and records the name, licence number and issuing '
      + 'state — nothing else off the card. Needs https:// and a rear camera.']
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
      <p class="page-sub">Everything here applies instantly to every kiosk.
        Open a section below, or pick one from the list under Settings in the menu.</p>
      <div class="row"><button class="btn ghost" id="sec-expand">Expand all</button>
        <button class="btn ghost" id="sec-collapse">Collapse all</button></div>

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
        <h3 style="margin-top:0">How check-in works</h3>
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

      <div class="card section" id="set-access"><h2>Access control</h2>
        ${chk('access.enabled', 'Enable door control')}
        ${chk('access.unlock_button_on_kiosk', 'Show a “Request entry” button on the kiosk')}
        ${chk('access.unlock_on_signin', 'Unlock doors automatically when someone signs in')}
      </div>

      <div class="card section" id="set-notifications"><h2>Notifications</h2>
        <h3>Microsoft Teams</h3>
        <p class="muted" style="margin-top:0">Arrivals go to one Teams channel, and the person being visited is
          tagged in the post using the email on their <b>Staff</b> record — so they get a notification without
          anybody setting up a link of their own. A staff member who wants their own direct message can still paste
          a personal Teams link on their record.</p>
        ${chk('notify.webhook_channel_always', 'Post every arrival to the company channel',
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
        </details>

        <h3>What the message looks like</h3>
        <p class="muted" style="margin-top:0">The preview is built by the same code that sends the real thing, so what
          you see here is what lands in the channel.</p>
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
            <p class="muted" style="margin:.35rem 0 0">You can use
              <code>{name}</code> <code>{company}</code> <code>{host}</code> <code>{type}</code>
              <code>{project}</code> <code>{site}</code> <code>{org}</code>. Anything empty disappears
              along with the spacing around it.</p>

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
            </div>
            <div id="cd-photo-warning"></div>

            <h4>What the message shows</h4>
            <p class="muted" style="margin-top:0">The arrows set the order. A field with nothing in it for that
              visitor is left out rather than shown empty.</p>
            <div class="section-order" id="cd-chosen"></div>
            <p class="muted" style="margin:.6rem 0 .3rem">Not shown</p>
            <div class="section-order" id="cd-rest"></div>

            <h4>Tagging the host</h4>
            <label class="check"><input type="checkbox" id="cd-mention">
              <span>Tag the person being visited in the channel post<br>
              <span class="muted">Uses the email on their <b>Staff</b> record, so the one person who needs to know
                gets a Teams notification without setting up a link of their own. Somebody with no email on file is
                simply not tagged.</span></span></label>

            <h4>Button</h4>
            <label class="check"><input type="checkbox" id="cd-button"> <span>Add a button that opens the dashboard</span></label>
            <label class="field"><span>Button wording</span><input class="input" id="cd-button-label"></label>
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

        <h3>When to post</h3>
        <p class="muted" style="margin-top:0">Which moments are worth interrupting a channel for.</p>
        <div class="check-list">
          ${chk('notify.on_signin', 'Someone signs in')}
          ${chk('notify.on_signout', 'Someone signs out')}
          ${chk('notify.on_induction', 'Someone finishes the site induction',
            'The moment the briefing is on record, rather than the moment they walked in')}
          ${chk('notify.on_delivery', 'A parcel arrives')}
        </div>

        <h4>Who to post about</h4>
        <p class="muted" style="margin-top:0">Applies to signing in, signing out and the induction. A type added later
          on the <b>Visitor types</b> tab starts switched on, so a new one is never silently ignored.</p>
        <div class="section-order">
          ${detailTypes().map(([type, label]) => `<div class="section-row">
            <span>${esc(label)}</span>
            <label class="check"><input type="checkbox" data-notifytype="${esc(type)}"
              ${(s.notify.types_notified || {})[type] === false ? '' : 'checked'}> <span>Post</span></label>
          </div>`).join('') || '<div class="section-row off"><span>No visitor types yet.</span></div>'}
        </div>

        <div class="row" style="margin-top:1rem"><button class="btn subtle" id="test-hook">Send test to Teams</button></div>
        <div id="email-result"></div>

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

      <div class="row"><button class="btn" id="save-settings">Save settings</button></div>`;

    collapseSections(root);
    $('#sec-expand').addEventListener('click', () => setAllSections(root, true));
    $('#sec-collapse').addEventListener('click', () => setAllSections(root, false));

    /* --------------------------------------------- the notification card */

    /*
     * Held here and sent whole on save, like the wording and the step order,
     * so switching between the controls never loses an edit. The preview is
     * drawn by the server from this same object — there is no second copy of
     * the layout rules in the browser to drift out of step with what sends.
     */
    const card = { ...(s.notify && s.notify.card) };
    let CARD_FIELDS = [];

    const cdSet = (id, value) => { const el = $(id); if (el) el.value = value ?? ''; };
    cdSet('#cd-header', card.header_style || 'accent');
    cdSet('#cd-details', card.details_style || 'facts');
    cdSet('#cd-title', card.title_template);
    cdSet('#cd-subtitle', card.subtitle_template);
    cdSet('#cd-footer', card.footer_template);
    cdSet('#cd-photo-place', card.photo_placement || 'left');
    cdSet('#cd-photo-shape', card.photo_shape || 'person');
    cdSet('#cd-button-label', card.button_label);
    $('#cd-photo').checked = card.show_photo !== false;
    $('#cd-button').checked = !!card.show_button;
    $('#cd-mention').checked = card.mention_host !== false;

    function readCard() {
      card.header_style = $('#cd-header').value;
      card.details_style = $('#cd-details').value;
      card.title_template = $('#cd-title').value;
      card.subtitle_template = $('#cd-subtitle').value;
      card.footer_template = $('#cd-footer').value;
      card.show_photo = $('#cd-photo').checked;
      card.photo_placement = $('#cd-photo-place').value;
      card.photo_shape = $('#cd-photo-shape').value;
      card.show_button = $('#cd-button').checked;
      card.button_label = $('#cd-button-label').value;
      card.mention_host = $('#cd-mention').checked;
      return card;
    }
    VIEWS.settings.collectCard = () => readCard();

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

    const FIELD_LABEL = (id) => (CARD_FIELDS.find((f) => f.id === id) || {}).label || id;
    const FIELD_SENSITIVE = (id) => !!(CARD_FIELDS.find((f) => f.id === id) || {}).sensitive;

    function drawCardFields() {
      const chosen = card.fields || [];
      const rest = CARD_FIELDS.filter((f) => !chosen.includes(f.id));
      $('#cd-chosen').innerHTML = chosen.length ? chosen.map((id, i) => `<div class="section-row">
        <span>${esc(FIELD_LABEL(id))}${FIELD_SENSITIVE(id)
          ? ' <span class="muted">— everyone in the channel can read this</span>' : ''}</span>
        <span class="flow-moves">
          <button class="btn ghost" data-cdup="${i}" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button>
          <button class="btn ghost" data-cddown="${i}" ${i === chosen.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
          <button class="btn ghost" data-cdout="${id}" title="Leave this out">Remove</button>
        </span></div>`).join('')
        : '<div class="section-row off"><span>Nothing but the heading.</span></div>';

      $('#cd-rest').innerHTML = rest.length ? rest.map((f) => `<div class="section-row off">
        <span>${esc(f.label)}${f.sensitive ? ' <span class="muted">— everyone in the channel can read this</span>' : ''}</span>
        <span class="flow-moves"><button class="btn ghost" data-cdin="${f.id}">Add</button></span></div>`).join('')
        : '<div class="section-row off"><span>Everything is shown.</span></div>';

      const move = (from, to) => {
        if (to < 0 || to >= card.fields.length) return;
        const [item] = card.fields.splice(from, 1);
        card.fields.splice(to, 0, item);
        drawCardFields();
        drawCardPreview();
      };
      $$('[data-cdup]').forEach((b) => b.addEventListener('click', () => move(Number(b.dataset.cdup), Number(b.dataset.cdup) - 1)));
      $$('[data-cddown]').forEach((b) => b.addEventListener('click', () => move(Number(b.dataset.cddown), Number(b.dataset.cddown) + 1)));
      $$('[data-cdout]').forEach((b) => b.addEventListener('click', () => {
        card.fields = card.fields.filter((id) => id !== b.dataset.cdout);
        drawCardFields(); drawCardPreview();
      }));
      $$('[data-cdin]').forEach((b) => b.addEventListener('click', () => {
        card.fields = [...(card.fields || []), b.dataset.cdin];
        drawCardFields(); drawCardPreview();
      }));
    }

    // One request per pause in typing, not one per keystroke.
    let previewTimer = null;
    const drawCardPreview = () => {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(loadCardPreview, 250);
    };

    async function loadCardPreview() {
      let data;
      try { data = await api('/notify/preview', { method: 'POST', body: { card: readCard() } }); }
      catch (err) {
        if (err.message === 'unauthenticated') return;
        $('#cd-preview').innerHTML = `<p class="empty">Could not draw the preview: ${esc(err.message)}</p>`;
        return;
      }
      if (!CARD_FIELDS.length) { CARD_FIELDS = data.fields; drawCardFields(); }
      $('#cd-preview').innerHTML = teamsPreviewHtml(data.model);
      const dump = $('#cd-json');
      if (dump) dump.textContent = JSON.stringify(data.teams, null, 2);
      $('#cd-sample').textContent = data.sample
        ? 'Nobody has signed in yet, so this shows made-up details.'
        : 'Shown with your most recent arrival.';

      // A photo Teams cannot reach is the one failure that looks like nothing.
      const warn = $('#cd-photo-warning');
      warn.innerHTML = (card.show_photo && !data.public_url_reachable)
        ? `<div class="notice error">Teams fetches the photo from
             <b>${esc(data.public_url)}</b>, which it cannot reach from outside. Set the public address below —
             or the PUBLIC_URL variable on the server — or the card will arrive with a blank space where the face
             should be.</div>`
        : '';
    }

    /** The Adaptive Card as Teams draws it, near enough to design against. */
    function teamsPreviewHtml(m) {
      const photo = m.photoUrl
        ? `<img class="tp-photo ${m.photoShape === 'person' ? 'round' : ''}" src="${esc(m.photoUrl)}" alt="">`
        : '';
      const heading = `<div class="tp-title tp-${esc(m.headerStyle)}">${esc(m.title)}</div>
        ${m.subtitle ? `<div class="tp-sub">${esc(m.subtitle)}</div>` : ''}
        ${m.mention ? `<div class="tp-mention"><span class="tp-at">@${esc(m.mention.name)}</span>
           — your visitor is here.</div>` : ''}`;
      const details = m.fields.length
        ? (m.detailsStyle === 'facts'
          ? `<div class="tp-facts">${m.fields.map((f) => `<div class="tp-fact-l">${esc(f.label)}</div>
              <div class="tp-fact-v">${esc(f.value)}</div>`).join('')}</div>`
          : `<div class="tp-lines">${m.fields.map((f) =>
              `<div>${f.label ? `<b>${esc(f.label)}:</b> ` : ''}${esc(f.value)}</div>`).join('')}</div>`)
        : '';
      const main = (photo && m.photoPlacement === 'left')
        ? `<div class="tp-row">${photo}<div class="tp-main">${heading}${details}</div></div>`
        : `${photo}${heading}${details}`;
      return `<div class="tp-card">
        <div class="tp-band tp-band-${esc(m.headerStyle)}">${main}</div>
        ${m.footer ? `<div class="tp-footer">${esc(m.footer)}</div>` : ''}
        ${m.action ? `<div class="tp-actions"><span class="tp-btn">${esc(m.action.label)}</span></div>` : ''}
      </div>`;
    }

    ['#cd-header', '#cd-details', '#cd-title', '#cd-subtitle', '#cd-footer', '#cd-photo',
      '#cd-photo-place', '#cd-photo-shape', '#cd-button', '#cd-button-label', '#cd-mention']
      .forEach((sel) => { const el = $(sel); if (el) el.addEventListener('input', drawCardPreview); });

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
      $('#backup-total').textContent = data.backups.length
        ? `${data.backups.length} kept, ${sizeOf(h.total_bytes || 0)} in total`
        : '';

      wrap.innerHTML = data.backups.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Taken</th><th>Size</th><th>Holds</th><th></th></tr></thead>
        <tbody>${data.backups.map((b) => `<tr>
          <td>${fmtDate(b.at)}</td><td>${sizeOf(b.bytes)}</td>
          <td>${b.complete ? 'Database and files'
            : '<span class="muted">Database only — taken before backups included the files</span>'}</td>
          <td style="white-space:nowrap">
            <a class="btn ghost" href="/api/admin/backups/${encodeURIComponent(b.file)}">Download</a>
            <button class="btn ghost" data-bkdel="${esc(b.file)}">Delete</button></td>
        </tr>`).join('')}</tbody></table></div>`
        : '<p class="empty">No backup written yet — the first runs a minute after the server starts.</p>';

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

    $('#backup-now').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const r = await api('/backups', { method: 'POST' });
        toast(`Backup written — ${sizeOf(r.bytes)}`);
        await drawBackups();
      } catch (err) {
        toast((err.data && err.data.message) || 'Could not write a backup', 5000);
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
      if (VIEWS.settings.collectCard) setPath(patch, 'notify.card', VIEWS.settings.collectCard());
      if (VIEWS.settings.collectNotifyTypes) setPath(patch, 'notify.types_notified', VIEWS.settings.collectNotifyTypes());
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
        : '<p class="empty">Nothing has been sent yet. Press “Send test email” above to try the settings.</p>';

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
      if (VIEWS.settings.collectCard) setPath(patch, 'notify.card', VIEWS.settings.collectCard());
      if (VIEWS.settings.collectNotifyTypes) setPath(patch, 'notify.types_notified', VIEWS.settings.collectNotifyTypes());
      SETTINGS = await api('/settings', { method: 'PUT', body: patch });
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
        const r = await api('/settings/test-webhook', {
          method: 'POST', body: { url, card: VIEWS.settings.collectCard ? VIEWS.settings.collectCard() : undefined } });
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
    // #settings/retention opens the settings page on that panel.
    const [hashView, section] = (location.hash || '#dashboard').slice(1).split('/');
    const view = VIEWS[hashView] ? hashView : 'dashboard';
    markNav(view, section);
    await render(view);
    if (view === 'settings' && section) openSection(section);
  }

  (async () => {
    const boot = await fetch('/api/admin/bootstrap').then((r) => r.json()).catch(() => null);
    if (!boot || boot.needs_setup || !boot.user) return showGate();
    start();
  })();
})();
