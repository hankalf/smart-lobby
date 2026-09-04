/*
 * Records kept about people and jobs: projects, certificates, companies, and
 * the reports drawn from them.
 */
import { $, $$, SETTINGS, VIEWS, allowed, api, confirmAction, esc, fmtDate, fmtDay, modal, render, setSettings,
  toast
} from './core.js';

/* ----------------------------------------------------------- compliance */

const DATE_ONLY = (d) => (d ? String(d).slice(0, 10) : '');

/*
 * The paperwork that says somebody may work here, and stops saying it.
 *
 * The list leads with what has already lapsed, because that is the row
 * somebody has to act on today — not the one running out in three weeks.
 */
VIEWS.compliance = async (root) => {
  const data = await api('/certificates');
  const rows = data.expiring || [];
  const kinds = data.kinds || [];
  const expired = rows.filter((r) => r.expired);
  const soon = rows.filter((r) => !r.expired);
  const s = SETTINGS && SETTINGS.compliance ? SETTINGS.compliance : {};

  root.innerHTML = `
    <h1 class="page">Certificates</h1>
    <p class="page-sub">Insurance, safety cards and method statements — the paperwork with a date on it. Held
      against a company, so one policy covers all their people, or against one person for their own card.</p>

    ${!data.health.enabled ? `<div class="notice"><b>Checking is switched off.</b> Certificates can be recorded and
      this page will still warn you before they lapse, but nothing is checked at the kiosk until you turn it on
      under <b>Settings → Certificates</b>.</div>` : ''}

    <div class="grid cards" style="margin-bottom:1.25rem">
      <div class="card stat"><div class="n">${expired.length}</div><div class="l">Out of date now</div></div>
      <div class="card stat"><div class="n">${soon.length}</div>
        <div class="l">Running out within ${esc(String(data.health.warn_days || 30))} days</div></div>
    </div>

    <div class="card section">
      <div class="row between" style="margin-bottom:.5rem">
        <h2 style="margin:0">What needs chasing</h2>
        <button class="btn" id="cert-add">Record a certificate</button>
      </div>
      <div class="table-wrap">${rows.length ? `<table>
        <thead><tr><th>Held by</th><th>Certificate</th><th>Reference</th><th>Expires</th><th></th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td><b>${esc(r.holder)}</b><div class="muted">${r.company_id ? 'Company' : 'Person'}</div></td>
          <td>${esc(r.label)}</td>
          <td class="muted">${esc(r.reference || '—')}</td>
          <td><span class="pill ${r.expired ? 'off' : 'on'}">${esc(DATE_ONLY(r.expires_on))}</span>
            <div class="muted">${r.expired
              ? `${Math.abs(r.days_left)} day${Math.abs(r.days_left) === 1 ? '' : 's'} ago`
              : `in ${r.days_left} day${r.days_left === 1 ? '' : 's'}`}</div></td>
          <td style="white-space:nowrap">
            <button class="btn ghost" data-certedit="${r.id}">Edit</button>
            <button class="btn ghost" data-certdel="${r.id}">Remove</button></td>
        </tr>`).join('')}</tbody></table>`
        : '<p class="empty">Nothing lapsing. Certificates with no expiry date never appear here.</p>'}</div>
    </div>`;

  $('#cert-add').addEventListener('click', () => certificateForm(null, kinds));
  $$('[data-certedit]').forEach((b) => b.addEventListener('click',
    () => certificateForm(rows.find((r) => r.id === Number(b.dataset.certedit)), kinds)));
  $$('[data-certdel]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Remove this certificate? The record of it goes; nobody is turned away for it afterwards.')) return;
    await api(`/certificates/${b.dataset.certdel}`, { method: 'DELETE' });
    render('compliance');
  }));
};

/**
 * Record or correct one certificate.
 *
 * Whose it is comes first, because a company policy and a personal card are
 * different things and picking the wrong one is how a gate lets the wrong
 * person through.
 */
async function certificateForm(existing, kinds) {
  const [companies, people] = await Promise.all([
    api('/companies').then((d) => d.companies || []).catch(() => []),
    api('/visitors').catch(() => [])
  ]);
  const isCompany = !existing || !!existing.company_id;
  const m = modal(existing ? 'Edit certificate' : 'Record a certificate', `
    <div class="form-grid">
      <label class="field"><span>Held by</span>
        <select class="input" id="cf-holder">
          <option value="company" ${isCompany ? 'selected' : ''}>A company — covers all their people</option>
          <option value="visitor" ${isCompany ? '' : 'selected'}>One person — their own card</option>
        </select></label>
      <label class="field" id="cf-kind-wrap"><span>Kind</span>
        <select class="input" id="cf-kind">
          ${kinds.map((k) => `<option value="${esc(k.key)}"
            ${existing && existing.kind === k.key ? 'selected' : ''}>${esc(k.label)}</option>`).join('')}
        </select></label>
    </div>
    <label class="field" id="cf-company-wrap"><span>Company</span>
      <select class="input" id="cf-company">
        ${companies.map((c) => `<option value="${c.id}"
          ${existing && existing.company_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')
          || '<option value="">No companies yet</option>'}
      </select></label>
    <label class="field hidden" id="cf-visitor-wrap"><span>Person</span>
      <select class="input" id="cf-visitor">
        ${people.slice(0, 300).map((p) => `<option value="${p.id}"
          ${existing && existing.visitor_id === p.id ? 'selected' : ''}>${esc(p.full_name)}${p.company
            ? ` — ${esc(p.company)}` : ''}</option>`).join('') || '<option value="">Nobody on file yet</option>'}
      </select></label>
    <div class="form-grid">
      <label class="field"><span>Reference</span>
        <input class="input" id="cf-ref" value="${esc((existing && existing.reference) || '')}"
          placeholder="Policy or card number"></label>
      <label class="field"><span>Expires</span>
        <input class="input" id="cf-expires" type="date" value="${esc(DATE_ONLY(existing && existing.expires_on))}">
        <span class="muted">Leave empty for something that does not expire</span></label>
    </div>
    <label class="field"><span>Notes</span>
      <textarea class="input" id="cf-notes" rows="2">${esc((existing && existing.notes) || '')}</textarea></label>`,
    async (bg, close) => {
      const holder = $('#cf-holder', bg).value;
      const body = {
        kind: $('#cf-kind', bg).value,
        reference: $('#cf-ref', bg).value.trim(),
        expires_on: $('#cf-expires', bg).value || null,
        notes: $('#cf-notes', bg).value.trim()
      };
      if (holder === 'company') { body.company_id = Number($('#cf-company', bg).value) || null; body.visitor_id = null; }
      else { body.visitor_id = Number($('#cf-visitor', bg).value) || null; body.company_id = null; }
      const r = existing
        ? await api(`/certificates/${existing.id}`, { method: 'PATCH', body })
        : await api('/certificates', { method: 'POST', body });
      if (r && r.error) return toast(r.message || 'Could not save');
      close();
      render('compliance');
    });

  const swap = () => {
    const company = $('#cf-holder', m.bg).value === 'company';
    $('#cf-company-wrap', m.bg).classList.toggle('hidden', !company);
    $('#cf-visitor-wrap', m.bg).classList.toggle('hidden', company);
  };
  $('#cf-holder', m.bg).addEventListener('change', swap);
  swap();
}

/* ------------------------------------------------------------ companies */

/*
 * The firms people come from, as records rather than as whatever was typed
 * at the kiosk that morning. The two things worth doing here are correcting
 * a name — which corrects it on every visit already recorded — and merging
 * two that turn out to be the same firm.
 */
VIEWS.companies = async (root) => {
  const data = await api('/companies');
  const rows = data.companies || [];
  const dupes = data.possible_duplicates || [];

  root.innerHTML = `
    <h1 class="page">Companies</h1>
    <p class="page-sub">Every firm that has been on site. A name typed wrong at the kiosk is corrected here, and
      two that are the same firm can be merged — both fix every visit already recorded, not just the next one.</p>

    ${dupes.length ? `<div class="card section" id="dupe-card">
      <h2>These look like the same firm</h2>
      <p class="muted" style="margin-top:0">Suggestions only — similar names are sometimes two real companies.
        Merging keeps everybody and everything they have done.</p>
      <div class="section-order">
        ${dupes.map((d) => `<div class="section-row">
          <span><b>${esc(d.a.name)}</b> and <b>${esc(d.b.name)}</b></span>
          <span class="flow-moves">
            <button class="btn ghost" data-mergedupe="${d.b.id}:${d.a.id}">Keep “${esc(d.a.name)}”</button>
            <button class="btn ghost" data-mergedupe="${d.a.id}:${d.b.id}">Keep “${esc(d.b.name)}”</button>
          </span></div>`).join('')}
      </div>
    </div>` : ''}

    <div class="card section">
      <div class="inline-form" style="margin-bottom:1rem">
        <label class="field"><span>Add a company</span><input class="input" id="co-name" placeholder="Example Roofing Ltd"></label>
        <button class="btn" id="co-add">Add</button>
        <input class="input" id="co-find" placeholder="Search" style="max-width:14rem">
      </div>
      <div class="table-wrap">${rows.length ? `<table>
        <thead><tr><th>Company</th><th>People</th><th>Visits</th><th>Last on site</th><th>Status</th><th></th></tr></thead>
        <tbody id="co-rows">${rows.map((c) => `<tr data-co="${c.id}" data-name="${esc((c.name || '').toLowerCase())}">
          <td><b>${esc(c.name)}</b>${c.notes ? `<div class="muted">${esc(c.notes)}</div>` : ''}</td>
          <td>${c.people}</td><td>${c.visits}</td>
          <td class="muted">${c.last_visit_at ? esc(fmtDate(c.last_visit_at)) : '—'}</td>
          <td><span class="pill ${c.blocked ? 'off' : 'on'}">${c.blocked ? 'barred' : 'allowed'}</span></td>
          <td style="white-space:nowrap">
            <button class="btn ghost" data-coedit="${c.id}">Edit</button>
            <button class="btn ghost" data-comerge="${c.id}">Merge</button>
            <button class="btn ghost" data-codel="${c.id}">Remove</button></td>
        </tr>`).join('')}</tbody></table>`
        : '<p class="empty">No companies yet. They appear as people sign in.</p>'}</div>
      <p class="muted">Barring a company turns away everybody from it at the kiosk, with the same “please see
        reception” a barred individual gets. Removing one leaves its people and their history alone — they simply
        stop being attached to a firm.</p>
    </div>`;

  $('#co-find').addEventListener('input', (e) => {
    const needle = e.target.value.trim().toLowerCase();
    $$('#co-rows tr').forEach((tr) => { tr.hidden = !!needle && !tr.dataset.name.includes(needle); });
  });

  $('#co-add').addEventListener('click', async () => {
    const name = $('#co-name').value.trim();
    if (!name) return toast('Give the company a name');
    await api('/companies', { method: 'POST', body: { name } });
    render('companies');
  });

  $$('[data-coedit]').forEach((b) => b.addEventListener('click', () => editCompany(Number(b.dataset.coedit), rows)));
  $$('[data-comerge]').forEach((b) => b.addEventListener('click', () => mergeCompany(Number(b.dataset.comerge), rows)));
  $$('[data-codel]').forEach((b) => b.addEventListener('click', async () => {
    const c = rows.find((x) => x.id === Number(b.dataset.codel));
    if (!confirm(`Remove ${c.name}? Its ${c.people} ${c.people === 1 ? 'person keeps' : 'people keep'} `
      + 'their history — they just stop being attached to a firm.')) return;
    await api(`/companies/${c.id}`, { method: 'DELETE' });
    render('companies');
  }));
  $$('[data-mergedupe]').forEach((b) => b.addEventListener('click', async () => {
    const [from, into] = b.dataset.mergedupe.split(':').map(Number);
    await doMerge(from, into, rows);
  }));
};

async function editCompany(id, rows) {
  const c = rows.find((x) => x.id === id);
  const projects = (await api('/projects').catch(() => [])).filter((p) => p.active !== 0);
  const m = modal(`Edit ${c.name}`, `
    <label class="field"><span>Name</span><input class="input" id="ce-name" value="${esc(c.name)}">
      <span class="muted">Correcting a spelling here corrects it on all ${c.visits} visit${c.visits === 1 ? '' : 's'}
        already recorded, not only the next one.</span></label>
    <label class="field"><span>Notes</span><textarea class="input" id="ce-notes" rows="3">${esc(c.notes || '')}</textarea></label>
    <label class="field"><span>Usually here for</span>
      <select class="input" id="ce-project">
        <option value="">— no usual job —</option>
        ${projects.map((p) => `<option value="${p.id}"
          ${String(c.default_project_id) === String(p.id) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
      </select>
      <span class="muted">Filled in on the kiosk for anybody from this firm, so a crew on the same job for
        months is not made to pick it every morning. They can still change it.</span></label>
    <label class="check"><input type="checkbox" id="ce-blocked" ${c.blocked ? 'checked' : ''}>
      <span>Bar this company from site<br><span class="muted">Everybody from it is turned away at the kiosk with
        “please see reception”</span></span></label>`,
    async (bg, close) => {
      const r = await api(`/companies/${id}`, { method: 'PATCH', body: {
        name: $('#ce-name', bg).value.trim(),
        notes: $('#ce-notes', bg).value.trim(),
        default_project_id: $('#ce-project', bg).value || null,
        blocked: $('#ce-blocked', bg).checked
      } });
      if (r && r.error) return toast(r.message || 'Could not save');
      close();
      render('companies');
    });
  return m;
}

function mergeCompany(id, rows) {
  const c = rows.find((x) => x.id === id);
  const others = rows.filter((x) => x.id !== id);
  if (!others.length) return toast('There is nothing to merge it with');
  modal(`Merge ${c.name} into another company`, `
    <p class="muted" style="margin-top:0">Everybody from <b>${esc(c.name)}</b> moves across and the name on their
      visits is corrected. <b>${esc(c.name)}</b> is then removed. Nothing is lost — a person's history is theirs,
      so it travels with them.</p>
    <label class="field"><span>Keep which company?</span>
      <select class="input" id="cm-into">
        ${others.map((o) => `<option value="${o.id}">${esc(o.name)} — ${o.people} `
          + `${o.people === 1 ? 'person' : 'people'}</option>`).join('')}
      </select></label>`,
    async (bg, close) => {
      close();
      await doMerge(id, Number($('#cm-into', bg).value), rows);
    }, 'Merge');
}

async function doMerge(fromId, intoId, rows) {
  const from = rows.find((x) => x.id === fromId);
  const into = rows.find((x) => x.id === intoId);
  const r = await api(`/companies/${fromId}/merge`, { method: 'POST', body: { into: intoId } });
  if (r && r.error) return toast(r.message || 'Could not merge');
  toast(`${from ? from.name : 'That company'} folded into ${into ? into.name : 'the other'} — `
    + `${r.moved} ${r.moved === 1 ? 'person' : 'people'} moved`, 5000);
  render('companies');
}

VIEWS.projects = async (root) => {
  const rows = await api('/projects');
  setSettings(await api('/settings'));
  const typeList = ((SETTINGS && SETTINGS.types) || []).filter((t) => t.key);
  const byType = (SETTINGS.projects && SETTINGS.projects.default_by_type) || {};
  const defaultsPanel = () => `
    <div class="card section">
      <h2>Which job to start on</h2>
      <p class="muted" style="margin-top:0">A sign-in arrives with a job already chosen, so a crew on the same one
        for months is not made to pick it every morning. Most specific wins: a firm's usual job — set on the
        company under <b>Companies</b> — beats the fallback here. Either way the visitor sees it selected and can
        change it, because the day it is wrong is the day it matters.</p>
      ${typeList.length ? `<div class="form-grid">
        ${typeList.map((t) => `<label class="field"><span>${esc(t.label || t.key)}</span>
          <select class="input" data-pjdefault="${esc(t.key)}">
            <option value="">— ask them —</option>
            ${rows.filter((p) => p.active !== 0).map((p) => `<option value="${p.id}"
              ${String(byType[t.key]) === String(p.id) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
          </select></label>`).join('')}
      </div>` : '<p class="empty">Add a visitor type first.</p>'}
    </div>`;

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
    </div>
    ${defaultsPanel()}`;

  // Saved as they are changed, like the rest of the settings.
  $$('[data-pjdefault]').forEach((sel) => sel.addEventListener('change', async () => {
    /*
     * Every type sent, with null for "ask them" — not just the one that
     * changed, and never by omitting a key. Settings are deep-merged, so a
     * key left out keeps whatever it had; clearing one requires saying so.
     */
    const next = {};
    typeList.forEach((t) => {
      const box = $(`[data-pjdefault="${t.key}"]`);
      next[t.key] = box && box.value ? Number(box.value) : null;
    });
    await api('/settings', { method: 'PUT', body: { projects: { default_by_type: next } } });
    toast('Saved');
    render('projects');
  }));

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

/* -------------------------------------------------------------- reports */

/*
 * Reports, over a window somebody chooses.
 *
 * The filters are the page: every figure below describes the same span and
 * the same project, so the tiles, the chart and the tables cannot disagree
 * with each other the way a fixed thirty days and an all-time table did.
 */
const REPORT_KEY = 'sl.admin.report-range';

VIEWS.reports = async (root) => {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(REPORT_KEY) || '{}'); } catch { saved = {}; }

  const query = new URLSearchParams();
  ['from', 'to', 'project_id', 'visit_type'].forEach((k) => { if (saved[k]) query.set(k, saved[k]); });
  if (!saved.from && !saved.to) query.set('days', String(saved.days || 30));

  const s = await api(`/stats?${query}`);
  const maxDay = Math.max(1, ...s.by_day.map((d) => d.n));
  const bar = (list) => {
    const max = Math.max(1, ...list.map((x) => x.n));
    return list.length
      ? `<div class="barlist">${list.map((x) => `<div class="b"><span>${esc(x.name || x.visit_type || x.hour || '—')}</span>
        <div class="track"><div class="fill" style="width:${(x.n / max) * 100}%"></div></div><b>${x.n}</b></div>`).join('')}</div>`
      : '<p class="empty">Nothing in this window.</p>';
  };
  const hours = (n) => (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10).toLocaleString();
  // The window travels with the exports, or the spreadsheet says something
  // different from the page it was downloaded from.
  const exportQuery = new URLSearchParams({ from: s.from, to: s.to, format: 'csv' });
  if (s.project_id) exportQuery.set('project_id', String(s.project_id));
  // The printed report has to be the window on screen, filters and all, or
  // it says something different from the page it was printed from.
  const printQuery = new URLSearchParams({ from: s.from, to: s.to });
  if (s.project_id) printQuery.set('project_id', String(s.project_id));
  if (s.visit_type) printQuery.set('visit_type', s.visit_type);

  root.innerHTML = `
    <h1 class="page">Reports</h1>
    <p class="page-sub">Everything stays on your server — export any of it as CSV.</p>

    <div class="card section">
      <div class="row" style="margin-bottom:0">
        <select class="input" id="rp-preset" style="max-width:12rem">
          ${[[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days'],
             [365, 'Last 12 months'], [0, 'Between two dates…']]
            .map(([v, l]) => `<option value="${v}" ${String(saved.days || 30) === String(v)
              && !(saved.from || saved.to) ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <span id="rp-dates" class="row ${saved.from || saved.to ? '' : 'hidden'}" style="margin:0;gap:.5rem">
          <input class="input" id="rp-from" type="date" value="${esc(s.from)}" style="max-width:10rem">
          <span class="muted">to</span>
          <input class="input" id="rp-to" type="date" value="${esc(s.to)}" style="max-width:10rem">
        </span>
        <select class="input" id="rp-project" style="max-width:14rem">
          <option value="">Every project</option>
          ${s.projects.map((p) => `<option value="${p.id}"
            ${String(s.project_id) === String(p.id) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select>
        <select class="input" id="rp-type" style="max-width:12rem">
          <option value="">Every visitor type</option>
          ${s.types.map((t) => `<option value="${esc(t)}"
            ${s.visit_type === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}
        </select>
        <button class="btn ghost" id="rp-reset">Reset</button>
        <!--
          The same figures on the site's own letterhead, for a client or an
          auditor who is not going to be handed a screenshot of a dashboard.
        -->
        <a class="btn subtle" id="rp-print" target="_blank" rel="noopener"
           href="/api/admin/stats/print?${printQuery}">Printable report</a>
      </div>
      <p class="muted" style="margin:.6rem 0 0">${esc(fmtDay(s.from))} to ${esc(fmtDay(s.to))} —
        ${s.days} day${s.days === 1 ? '' : 's'}${s.project_id ? ', one project' : ''}.</p>
    </div>

    <div class="grid cards" style="margin-bottom:1.25rem">
      <div class="card stat"><div class="n">${s.total.toLocaleString()}</div><div class="l">Visits</div></div>
      <div class="card stat"><div class="n">${s.avg_minutes ? Math.round(s.avg_minutes) : 0}</div>
        <div class="l">Average minutes on site</div></div>
      <div class="card stat"><div class="n">${hours(s.total_hours)}</div>
        <div class="l">Hours on site, all projects</div></div>
      <div class="card stat"><div class="n">${Math.round((s.total / s.days) * 10) / 10}</div>
        <div class="l">Visits a day</div></div>
    </div>

    <div class="card section"><h2>Visits per day</h2>
      ${s.by_day.length
        ? `<div class="bars">${s.by_day.map((d) => `<div style="height:${(d.n / maxDay) * 100}%"
            title="${d.day}: ${d.n}"></div>`).join('')}</div>`
        : '<p class="empty">Nothing in this window.</p>'}</div>

    <div class="card section"><h2>Hours on site, per project</h2>
      <p class="muted" style="margin-top:0">Counted from the time between signing in and signing out. Anybody still
        on site is counted in the visits but not yet in the hours — they have not finished.</p>
      <div class="table-wrap">${s.by_project.length ? `<table>
        <thead><tr><th>Project</th><th>Visits</th><th>Hours</th><th>Average</th><th>Still on site</th></tr></thead>
        <tbody>${s.by_project.map((p) => `<tr>
          <td><b>${esc(p.name)}</b></td><td>${p.n}</td><td><b>${hours(p.hours)}</b></td>
          <td class="muted">${p.n ? hours(p.hours / p.n) : 0} each</td>
          <td>${p.still_on_site ? `<span class="pill on">${p.still_on_site}</span>` : '—'}</td>
        </tr>`).join('')}</tbody></table>`
        : '<p class="empty">No visits against a project in this window. Contractors pick one when they sign in — '
          + 'set the project field to required on the <b>Visitor form</b> to collect it.</p>'}</div></div>

    <div class="grid two">
      <div class="card section"><h2>Busiest hosts</h2>${bar(s.by_host)}</div>
      <div class="card section"><h2>Top companies</h2>${bar(s.by_company)}</div>
      <div class="card section"><h2>By visit type</h2>${bar(s.by_type.map((t) => ({ name: t.visit_type, n: t.n })))}</div>
      <div class="card section"><h2>Arrivals by hour</h2>${bar(s.by_hour.map((h) => ({ name: `${h.hour}:00`, n: h.n })))}</div>
    </div>

    <div class="card section"><h2>Exports</h2>
      <p class="muted" style="margin-top:0">The visits export covers the window above; the others are as they stand
        right now.</p>
      <div class="row"><a class="btn ghost" href="/api/admin/visits?${exportQuery}">Visits in this window</a>
      <a class="btn ghost" href="/api/admin/visits?format=csv">All visits, ever</a>
      <a class="btn ghost" href="/api/admin/deliveries?format=csv">All deliveries</a>
      <a class="btn ghost" href="/api/admin/rollcall?format=csv">Current roll call</a></div></div>`;

  const remember = (patch) => {
    const next = { ...saved, ...patch };
    try { localStorage.setItem(REPORT_KEY, JSON.stringify(next)); } catch { /* private mode */ }
    render('reports');
  };

  $('#rp-preset').addEventListener('change', (e) => {
    const days = Number(e.target.value);
    // "Between two dates" keeps whatever is on screen and stops presetting.
    if (!days) return $('#rp-dates').classList.remove('hidden');
    remember({ days, from: null, to: null });
  });
  ['#rp-from', '#rp-to'].forEach((sel) => $(sel).addEventListener('change', () =>
    remember({ from: $('#rp-from').value, to: $('#rp-to').value, days: null })));
  $('#rp-project').addEventListener('change', (e) => remember({ project_id: e.target.value || null }));
  $('#rp-type').addEventListener('change', (e) => remember({ visit_type: e.target.value || null }));
  $('#rp-reset').addEventListener('click', () => {
    try { localStorage.removeItem(REPORT_KEY); } catch { /* private mode */ }
    render('reports');
  });
};

