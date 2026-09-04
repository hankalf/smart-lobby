/*
 * Who is on site, who is expected, and what has been delivered.
 *
 * The dashboard, expected arrivals, the visit list, the visitor registry,
 * drivers and deliveries — the pages somebody at the front desk actually
 * opens during a shift.
 */
import { $, $$, SETTINGS, VIEWS, api, apiPage, confirmAction, el, esc, fmtDate, fmtDay, fmtTime, modal, render,
  toast, toastUndo
} from './core.js';
import { questionLabels, reprintBadge } from './setup.js';

/*
 * The things that break silently.
 *
 * A deleted Teams flow and a kiosk that stopped talking both look exactly
 * like everything being fine — the failures were recorded all along, but
 * only somebody who thought to open the activity list would ever see them.
 * These say it on the page people actually look at.
 */
/*
 * Wired after the dashboard is drawn, because the notice it belongs to is
 * built as a string like the rest of them.
 */
function wireExampleClear() {
  const b = $('#clear-examples');
  if (!b) return;
  b.addEventListener('click', async () => {
    if (!confirm('Remove the four example visitors and their visits? Your own records are untouched.')) return;
    const r = await api('/examples', { method: 'DELETE' });
    toast(`${r.removed} example${r.removed === 1 ? '' : 's'} cleared`);
    render('dashboard');
  });
}

/** "1.4 GB" — sizes a person reads rather than a number of bytes. */
function fmtBytes(n) {
  const bytes = Number(n) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let value = bytes;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

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
  const disk = h.storage || {};
  if (disk.known && disk.level !== 'ok') {
    const runsOut = disk.days_left != null
      ? ` At the rate photos are arriving that is about ${disk.days_left} day${disk.days_left === 1 ? '' : 's'}.`
      : '';
    out.push(`<div class="notice${disk.level === 'critical' ? ' error' : ''}">
      <b>Storage is ${disk.percent_used}% full</b> — ${fmtBytes(disk.free)} left.${esc(runsOut)}
      When it fills, sign-ins stop and no backup can be written. What is using it is under
      <b>Settings → Backups</b>; shortening how long photos are kept under
      <b>Data retention</b> is usually the quickest room to find.</div>`);
  }

  /*
   * The offer to clear the examples out used to wait until real visits had
   * arrived, on the reasoning that until then they are the only thing making
   * the dashboard legible. That reasoning is wrong for the case that matters
   * most: somebody who has just deployed this for a real site wants them gone
   * *before* the first visitor, and had no way to say so short of an
   * environment variable and a redeploy. So it is offered either way, and
   * only the wording changes.
   */
  /*
   * Worded as a report and not as a fact, because that is exactly what it
   * is: nothing has looked at the printer, and nothing can. Saying "the
   * printer is offline" would be claiming knowledge this system does not
   * have, and the first time it was wrong nobody would trust the next one.
   */
  if (Array.isArray(h.printers) && h.printers.length) {
    out.push(`<div class="notice error"><b>Badges are not printing</b> —
      ${h.printers.map((p) => esc(p.name)).join(', ')}. Reported from the desk; nothing here can
      reach a printer to check. Usually out of labels, switched off, or off its Wi-Fi. Sign-ins are
      still being recorded — only the badge is missing.
      ${h.printers.map((p) => `<button class="btn link" data-prfixed="${p.id}">${
esc(p.name)} is working again</button>`).join(' ')}</div>`);
  }

  if (h.examples && h.examples.present) {
    out.push(`<div class="notice">${h.examples.real_visits
      ? `Your own visits have started arriving, so the example records this site was set up with have
         done their job.`
      : `This site is showing four example visitors so the dashboard, board and reports have something
         in them. They are not real and count for nothing — clear them out whenever you like.`}
      <button class="btn link" id="clear-examples">Clear them out</button></div>`);
  }

  const c = h.compliance || {};
  if (c.enabled && (c.expired || c.expiring)) {
    const bits = [];
    if (c.expired) bits.push(`<b>${c.expired} certificate${c.expired === 1 ? ' has' : 's have'} lapsed.</b>`);
    if (c.expiring) bits.push(`${c.expiring} run${c.expiring === 1 ? 's' : ''} out within ${c.warn_days} days.`);
    out.push(`<div class="notice${c.expired ? ' error' : ''}">${bits.join(' ')}
      Whoever they belong to may be turned away at the gate — the list is under <b>Certificates</b>.</div>`);
  }

  const b = h.backup || {};
  if (b.pending_restore) {
    out.push(`<div class="notice"><b>A restore is waiting to be applied.</b> It takes effect the next time the
      server starts. Until then this is still the old data.</div>`);
  } else if (b.offsite && b.offsite.enabled && b.offsite.last_ok === false) {
    out.push(`<div class="notice error"><b>Backups are not reaching OneDrive.</b>
      ${esc(b.offsite.last_error || '')} They are still being written on the server, but the copy that would
      survive losing it is not getting away. See <b>Settings → Backups</b>.</div>`);
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
  const h = d.health || {};
  const max = Math.max(1, ...d.week.map((w) => w.n));
  root.innerHTML = `
    <h1 class="page">Dashboard</h1>
    <p class="page-sub">Live view of who is on site right now.</p>
    ${d.storage_warning ? `<div class="notice error" style="font-size:1rem">
      <b>Storage is not persistent.</b> ${esc(d.storage_warning)}</div>` : ''}
    ${healthNotices(d.health)}
    <div class="grid cards" style="margin-bottom:1.25rem">
      ${[['On site now', d.stats.onsite], ['Still expected today', d.stats.expected_today || 0],
         ['Signed in today', d.stats.today_in], ['Signed out today', d.stats.today_out],
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
          <!--
            Here rather than only on the Printers page, which is
            administrative: reception are the ones who notice the labels have
            stopped, and nothing in this system can reach a printer to find
            out for itself.
          -->
          ${(h.printers_known || []).length
  ? '<button class="btn ghost" id="btn-printer-down">Badges not printing</button>' : ''}
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

  wireExampleClear();
  $('#btn-rollcall').addEventListener('click', rollCall);
  $('#btn-signout-all').addEventListener('click', () => confirmAction(
    'Sign out every person currently on site?',
    async () => { const r = await api('/visits/signout-all', { method: 'POST' }); toast(`${r.count} signed out`); render('dashboard'); }));
  bindSignoutButtons(root, () => render('dashboard'));

  /*
   * Reporting a printer, and clearing it, from the dashboard — where
   * reception are, rather than on the administrative Printers page they
   * cannot open. The list comes with the dashboard for the same reason: they
   * cannot read the printer register either.
   */
  const raise = $('#btn-printer-down');
  if (raise) {
    raise.addEventListener('click', () => {
      const known = h.printers_known || [];
      const bg = modal('Badges are not printing', `
        <p class="muted" style="margin-top:0">This tells the dashboard, the on-site board and your chat
          channel at once, so nobody else has to work it out at the gate. Sign-ins carry on as
          normal — only the badge is missing.</p>
        ${known.length > 1 ? `<label class="field"><span>Which printer</span>
          <select class="input" id="pd-which">${known.map((p) =>
  `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label>` : ''}
        <label class="field"><span>What is wrong, if you know</span>
          <input class="input" id="pd-note" placeholder="Out of labels, switched off, offline…"></label>`,
      async (box, close) => {
        const which = $('#pd-which', box);
        const id = which ? which.value : known[0].id;
        await api(`/printers/${id}/trouble`,
          { method: 'POST', body: { note: $('#pd-note', box).value.trim() || null } });
        close();
        render('dashboard');
      }, 'Tell everyone');
      const note = $('#pd-note', bg);
      if (note) note.focus();
    });
  }

  $$('[data-prfixed]').forEach((b) => b.addEventListener('click', async () => {
    await api(`/printers/${b.dataset.prfixed}/working`, { method: 'POST' });
    toast('Marked as working again');
    render('dashboard');
  }));
};

function onsiteTable(rows) {
  if (!rows.length) return '<p class="empty">Nobody is signed in at the moment.</p>';
  return `<table><thead><tr><th></th><th>Name</th><th>Company</th><th>Type</th><th>Staff member</th><th>Badge</th><th>Since</th><th></th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td>${r.photo_path ? `<img class="avatar" src="${esc(r.photo_path)}" alt="" data-bigphoto="${esc(r.photo_path)}" data-bigphoto-name="${esc(r.full_name)}">` : '<div class="avatar"></div>'}</td>
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

/* ------------------------------------------------------------- expected */

/*
 * Who is coming, before they arrive.
 *
 * The list a site actually wants at eight in the morning: who is due, who
 * has walked in, and who has not. Kept apart from Visits on purpose — a
 * booking is a plan, and a plan must never put somebody on the roll call.
 */
VIEWS.expected = async (root) => {
  const STATUS = {
    expected: ['Due', 'off'], arrived: ['Arrived', 'on'],
    cancelled: ['Cancelled', 'off'], no_show: ['Did not come', 'off']
  };

  root.innerHTML = `
    <h1 class="page">Expected</h1>
    <p class="page-sub">Book somebody in before they arrive and the kiosk knows them: their details are already
      filled in, and reception can answer “who is coming today” without asking around.</p>
    <div class="card section">
      <div class="row">
        <input class="input" id="ex-day" type="date" style="max-width:11rem">
        <select class="input" id="ex-status" style="max-width:11rem">
          <option value="">Any status</option>
          ${Object.entries(STATUS).map(([k, [l]]) => `<option value="${k}">${l}</option>`).join('')}
        </select>
        <button class="btn ghost" id="ex-all">Everything ahead</button>
        <button class="btn" id="ex-add">Book somebody in</button>
      </div>
      <p class="muted" id="ex-summary" style="margin:.6rem 0 0"></p>
      <div class="table-wrap" id="ex-results"></div>
    </div>`;

  const load = async () => {
    const params = new URLSearchParams();
    if ($('#ex-day').value) params.set('on', $('#ex-day').value);
    if ($('#ex-status').value) params.set('status', $('#ex-status').value);
    const data = await api(`/expected?${params}`);
    const rows = data.rows || [];

    $('#ex-summary').textContent = `Today: ${data.expected} still to come, ${data.arrived} arrived`
      + `${data.cancelled ? `, ${data.cancelled} cancelled` : ''}.`;

    $('#ex-results').innerHTML = rows.length ? `<table>
      <thead><tr><th>When</th><th>Name</th><th>Company</th><th>Type</th><th>Seeing</th>
        <th>Code</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows.map((r) => {
      const [label, pill] = STATUS[r.status] || [r.status, 'off'];
      return `<tr>
        <td>${esc(fmtDay(r.expected_on))}${r.expected_at ? `<br><span class="muted">${esc(r.expected_at)}</span>` : ''}</td>
        <td><b>${esc(r.full_name)}</b></td><td>${esc(r.company || '')}</td>
        <td>${esc(r.visit_type)}</td><td>${esc(r.host_name || '')}</td>
        <td>${r.status === 'expected' ? `<code class="token">${esc(r.code)}</code>` : ''}</td>
        <td><span class="pill ${pill}">${label}</span></td>
        <td style="white-space:nowrap">
          ${r.status === 'arrived'
          ? `<button class="btn ghost" data-exvisit="${r.visit_id}">Open visit</button>`
          : `<button class="btn ghost" data-exedit="${r.id}">Edit</button>
             <button class="btn ghost" data-exdel="${r.id}">Remove</button>`}
        </td></tr>`;
    }).join('')}</tbody></table>`
      : '<p class="empty">Nobody is booked in for this. Use “Book somebody in” for a visitor you already '
        + 'know is coming — the crew starting Monday, the auditor at ten.</p>';

    $$('[data-exedit]').forEach((b) => b.addEventListener('click',
      () => bookingForm(rows.find((r) => String(r.id) === b.dataset.exedit), load)));
    $$('[data-exvisit]').forEach((b) => b.addEventListener('click', () => visitDetail(b.dataset.exvisit)));
    $$('[data-exdel]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Remove this booking? Nobody is signed in or out by this — it is only the plan.')) return;
      await api(`/expected/${b.dataset.exdel}`, { method: 'DELETE' });
      await load();
    }));
  };

  $('#ex-day').addEventListener('change', load);
  $('#ex-status').addEventListener('change', load);
  $('#ex-all').addEventListener('click', () => { $('#ex-day').value = ''; $('#ex-status').value = ''; load(); });
  $('#ex-add').addEventListener('click', () => bookingForm(null, load));
  load();
};

async function bookingForm(existing, after) {
  const staff = (await api('/staff').catch(() => [])).filter((h) => h.active !== 0);
  const projects = await api('/projects').catch(() => []);
  const types = ((SETTINGS && SETTINGS.types) || []).filter((t) => t.key)
    .map((t) => ({ key: t.key, label: t.label || t.key }));
  if (!types.length) types.push({ key: 'visitor', label: 'visitor' });
  const e = existing || {};
  /*
   * The site's own today, asked of the server. A dashboard open on a laptop
   * in another time zone would otherwise default the booking to its own
   * date — which for a site east of it is yesterday, and a booking for
   * yesterday is one nobody is ever expected on.
   */
  const today = (await api('/expected?limit=1').catch(() => ({}))).day
    || new Date().toISOString().slice(0, 10);
  const m = modal(existing ? `Expected — ${existing.full_name}` : 'Book somebody in', `
    <div class="form-grid">
      <label class="field"><span>Name</span><input class="input" id="ex-name" value="${esc(e.full_name || '')}"></label>
      <label class="field"><span>Company</span><input class="input" id="ex-company" value="${esc(e.company || '')}"></label>
      <label class="field"><span>Phone</span><input class="input" id="ex-phone" value="${esc(e.phone || '')}">
        <span class="muted">How the kiosk recognises them — the same number they will type in.</span></label>
      <label class="field"><span>Email</span><input class="input" id="ex-email" value="${esc(e.email || '')}"></label>
      <label class="field"><span>Day</span><input class="input" id="ex-on" type="date"
        value="${esc(e.expected_on || today)}"></label>
      <label class="field"><span>Time (optional)</span><input class="input" id="ex-at" type="time"
        value="${esc(e.expected_at || '')}"></label>
      <label class="field"><span>Visitor type</span><select class="input" id="ex-type">
        ${types.map((t) => `<option value="${esc(t.key)}"
          ${(e.visit_type || 'visitor') === t.key ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}
      </select></label>
      <label class="field"><span>Who they are seeing</span><select class="input" id="ex-host">
        <option value="">—</option>
        ${staff.map((h) => `<option value="${h.id}" ${String(e.host_id) === String(h.id) ? 'selected' : ''}>${esc(h.name)}</option>`).join('')}
      </select></label>
      <label class="field"><span>Project</span><select class="input" id="ex-project">
        <option value="">—</option>
        ${projects.map((p) => `<option value="${p.id}" ${String(e.project_id) === String(p.id) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
      </select></label>
    </div>
    <label class="field"><span>Reason for visit</span><input class="input" id="ex-purpose" value="${esc(e.purpose || '')}"></label>
    <label class="field"><span>Notes for reception</span><textarea class="input" id="ex-notes" rows="2">${esc(e.notes || '')}</textarea></label>
    ${e.code ? `<p class="muted">Arrival code: <code class="token">${esc(e.code)}</code> — they can give this at the
      desk, or simply type the phone number above.</p>` : ''}`,
  async (bg, close) => {
    const body = {
      full_name: $('#ex-name').value.trim(),
      company: $('#ex-company').value.trim(),
      phone: $('#ex-phone').value.trim(),
      email: $('#ex-email').value.trim(),
      expected_on: $('#ex-on').value,
      expected_at: $('#ex-at').value,
      visit_type: $('#ex-type').value,
      host_id: $('#ex-host').value || null,
      project_id: $('#ex-project').value || null,
      purpose: $('#ex-purpose').value.trim(),
      notes: $('#ex-notes').value.trim()
    };
    if (!body.full_name) return toast('A name is needed.');
    let saved;
    try {
      saved = existing
        ? await api(`/expected/${existing.id}`, { method: 'PATCH', body })
        : await api('/expected', { method: 'POST', body });
    } catch (err) {
      return toast((err.data && err.data.message) || 'That could not be saved.', 5000);
    }
    close();
    // The code is what a host forwards to their visitor, so it is worth
    // saying rather than leaving to be found in the table.
    if (!existing && saved.code) toast(`Booked in. Arrival code ${saved.code}`, 6000);
    await after();
  });
  return m;
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
        <select class="input" id="v-per" style="max-width:9rem" title="Rows per page">
          <option value="50">50 a page</option><option value="100">100 a page</option>
          <option value="200" selected>200 a page</option><option value="500">500 a page</option>
        </select>
      </div>
      <div class="table-wrap" id="v-results"></div>
      <div class="row" id="v-pager" style="justify-content:space-between;align-items:center"></div>
    </div>`;

  let offset = 0;
  const per = () => Number($('#v-per').value) || 200;

  const load = async () => {
    const params = new URLSearchParams();
    ['q', 'from', 'to', 'status'].forEach((k) => { const v = $(`#v-${k}`).value; if (v) params.set(k, v); });
    $('#v-csv').href = `/api/admin/visits?format=csv&${params}`;
    params.set('limit', String(per()));
    params.set('offset', String(offset));
    const { rows, total } = await apiPage(`/visits?${params}`);
    drawPager(rows.length, total);
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

  /*
   * Says which slice of what you are looking at. Without it a capped list
   * reads as the whole list, and an export taken from it looks complete.
   */
  function drawPager(shown, total) {
    const pager = $('#v-pager');
    if (!total) { pager.innerHTML = ''; return; }
    const first = total ? offset + 1 : 0;
    const last = offset + shown;
    pager.innerHTML = `
      <span class="muted" id="v-count">Showing ${first.toLocaleString()}–${last.toLocaleString()}
        of ${total.toLocaleString()} visit${total === 1 ? '' : 's'}</span>
      <span class="row" style="gap:.4rem">
        <button class="btn ghost" id="v-prev" ${offset === 0 ? 'disabled' : ''}>Previous</button>
        <button class="btn ghost" id="v-next" ${last >= total ? 'disabled' : ''}>Next</button>
      </span>`;
    $('#v-prev').addEventListener('click', () => { offset = Math.max(0, offset - per()); load(); });
    $('#v-next').addEventListener('click', () => { offset += per(); load(); });
  }

  // Any change of filter is a new list, so page one of it.
  const search = () => { offset = 0; load(); };
  $('#v-search').addEventListener('click', search);
  $('#v-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
  ['from', 'to', 'status', 'per'].forEach((k) => $(`#v-${k}`).addEventListener('change', search));
  load();
};

async function visitDetail(id) {
  const v = await api(`/visits/${id}`);
  modal(`Visit — ${v.full_name}`, `
    <div class="row" style="align-items:flex-start">
      ${v.photo_path ? `<img src="${esc(v.photo_path)}" class="visit-photo" data-bigphoto="${esc(v.photo_path)}"
         data-bigphoto-name="${esc(v.full_name)}" alt="" title="Click to see it full size">` : ''}
      <div>
        <p style="margin:0"><b>${esc(v.full_name)}</b><br>
        <span class="muted">${esc(v.company || '')} ${v.phone ? '· ' + esc(v.phone) : ''} ${v.email ? '· ' + esc(v.email) : ''}</span></p>
        <p class="muted">${esc(v.visit_type)} · ${esc(v.purpose || 'no reason given')}${v.language === 'es' ? ' · signed in en español' : ''}<br>
        ${v.project_name ? `Project: ${esc(v.project_name)}<br>` : ''}
        Staff member: ${esc(v.host_name || '—')} · Badge: ${esc(v.badge_no || '—')} ${v.vehicle_reg ? '· Vehicle: ' + esc(v.vehicle_reg) : ''}<br>
        ${v.reference ? `Reference: ${esc(v.reference)}${v.movement ? ' · ' + esc(v.movement) : ''}<br>` : ''}
        ${v.id_number ? `Licence: ${esc(v.id_name || '')} · ${esc(v.id_number)}${v.id_state ? ' · ' + esc(v.id_state) : ''}<br>` : ''}
        ${v.location_name ? `Signed in at: ${esc(v.location_name)}${v.device_name ? ` (${esc(v.device_name)})` : ''}<br>` : ''}
        <!--
          Only when it is not the ordinary case. A tablet sign-in needs no
          explaining; somebody letting themselves in on their own phone does,
          because the photograph and the location on this record came from
          their device rather than from one of yours.
        -->
        ${v.source === 'phone' ? 'Checked in on their own phone, by QR code<br>' : ''}
        ${v.source === 'desk' ? 'Signed in at the desk by reception<br>' : ''}
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
        <td>${r.photo_path ? `<img class="avatar" src="${esc(r.photo_path)}" alt="" data-bigphoto="${esc(r.photo_path)}" data-bigphoto-name="${esc(r.full_name)}">` : ''}</td>
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

