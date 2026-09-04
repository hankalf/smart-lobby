/*
 * Smart Lobby admin — the shell every page is built on.
 *
 * The admin was one file of nearly eight thousand lines. Everything a page
 * needs in common lives here: talking to the server, the auto-saver, the
 * modal, formatting, the side menu, and who is allowed to see what. The pages
 * themselves are in the files beside this one, and each registers itself in
 * VIEWS rather than being listed anywhere.
 *
 * SETTINGS and ME are read straight from here by every page. They are live
 * bindings, so a page reads the current value rather than a copy taken when it
 * loaded — but a page cannot assign to one, which is why writing settings goes
 * through setSettings().
 */

export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];
export const el = (html) => { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild; };
export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * What this site calls a kind of visitor.
 *
 * A visitor type has a key and a label — `unifirst` and "UniFirst" — and the
 * key is fixed once, because every visit ever recorded is stored against it.
 * Anything a person reads has to use the label: a badge printed for a type
 * renamed last month should not still carry its old name.
 */
export const typeName = (key) => {
  if (!key) return '';
  const known = ((SETTINGS && SETTINGS.types) || []).find((t) => t && t.key === key);
  return (known && String(known.label || '').trim()) || (String(key).charAt(0).toUpperCase() + String(key).slice(1));
};

export let SETTINGS = null;
export let ME = null;

/* ------------------------------------------------------------------ api */

export async function api(path, { method = 'GET', body, raw } = {}) {
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

/**
 * A list that knows how long it really is. The rows come back as a plain
 * array with the count in a header, so this hands back both.
 */
export async function apiPage(path) {
  const res = await api(path, { raw: true });
  const rows = await res.json().catch(() => []);
  if (!res.ok) throw new Error('failed');
  const total = Number(res.headers.get('X-Total-Count'));
  return {
    rows,
    total: Number.isFinite(total) ? total : rows.length,
    offset: Number(res.headers.get('X-Offset')) || 0
  };
}

export const upload = async (path, file, field = 'file') => {
  const fd = new FormData();
  fd.append(field, file);
  const res = await fetch(`/api/admin${path}`, { method: 'POST', body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'upload_failed'), { data });
  return data;
};

export function toast(msg, ms = 2800) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

/* ------------------------------------------------------------ auto-save */

/**
 * Saving as you go, and saying so.
 *
 * A Save button at the bottom of a page you have to scroll is a way to lose
 * work: change a toggle near the top, wander off, and nothing was kept. The
 * pages that edit settings in place now save themselves, and the pill says
 * which of the three states it is in — working, saved, or not saved and why.
 *
 * Two things this must not do. It must not fire on every keystroke, so a
 * pause is waited for. And it must not overlap itself: two saves in flight
 * against the same settings could land in either order, so a save that
 * arrives while one is running is queued behind it rather than raced.
 */
const saveState = {
  show(text, kind) {
    const el = $('#save-state');
    clearTimeout(saveState._hide);
    el.hidden = false;
    el.className = `save-state${kind === 'working' ? ' working' : ''}${kind === 'problem' ? ' problem' : ''}`;
    el.innerHTML = `<span class="dot"></span><span>${esc(text)}</span>`;
    if (kind === 'done') {
      // Long enough to read, short enough not to sit there all day.
      saveState._hide = setTimeout(() => {
        el.classList.add('fading');
        saveState._hide = setTimeout(() => saveState.clear(), 250);
      }, 1600);
    }
  },
  clear() {
    clearTimeout(saveState._hide);
    const el = $('#save-state');
    if (!el) return;
    el.hidden = true;
    el.classList.remove('fading');
    // Emptied, not just hidden: a stale "Saved" left lying about is a lie
    // the next time anything reads it, screen reader or test alike.
    el.textContent = '';
  }
};

/**
 * @param {() => Promise<void>} write  performs the save
 * @param {() => string|null} check    a reason not to save yet, or null
 * @returns {{ soon: () => void, now: () => Promise<void> }}
 */
export function autoSave(write, check = () => null) {
  let timer = null;
  let running = null;
  let again = false;

  async function run() {
    const blocked = check();
    if (blocked) return saveState.show(blocked, 'problem');
    if (running) { again = true; return running; }
    saveState.show('Saving…', 'working');
    running = (async () => {
      try {
        await write();
        saveState.show('Saved', 'done');
      } catch (err) {
        if (err.message === 'unauthenticated') return saveState.clear();
        saveState.show((err.data && err.data.message) || 'Not saved — try again', 'problem');
      } finally {
        running = null;
        // Anything that changed while that was in flight goes next.
        if (again) { again = false; run(); }
      }
    })();
    return running;
  }

  return {
    soon() { clearTimeout(timer); timer = setTimeout(run, 700); },
    now() { clearTimeout(timer); return run(); }
  };
}

/**
 * Wire the fields that belong to a saver, and only those.
 *
 * Deliberately not every input under the page: the settings page also holds
 * a password form, a restore upload and a camera-test box, and flashing
 * "Saving…" while somebody types a new password would be both wrong and
 * alarming.
 */
/**
 * Fill a settings field from code, and have it saved like a typed one.
 *
 * The event matters and is easy to get wrong: autoSaveOn below listens for
 * 'input' on a text or number field and only for 'change' on a checkbox or a
 * select. Code that filled a number field and fired 'change' — which reads
 * as the obvious choice — put the value on screen and saved nothing, and the
 * only symptom was a setting that had quietly reverted next time anybody
 * looked. Both are fired here so neither kind of field can be missed.
 */
export function setSettingField(path, value) {
  const field = $(`[data-set="${path}"]`);
  if (!field) return false;
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

export function autoSaveOn(root, saver, selector = '[data-set]') {
  $$(selector, root).forEach((el) => {
    // A checkbox or a picker is a finished decision; typing is not.
    const immediate = el.type === 'checkbox' || el.type === 'radio' || el.tagName === 'SELECT';
    el.addEventListener(immediate ? 'change' : 'input', () => saver.soon());
  });
}

/** The same, with a way back from what just happened. */
export function toastUndo(msg, undo, ms = 8000) {
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
export const siteZone = () => {
  const tz = (SETTINGS && SETTINGS.org.timezone) || undefined;
  if (!tz) return undefined;
  if (zoneSeen.tz !== tz) {
    try { new Intl.DateTimeFormat('en', { timeZone: tz }); zoneSeen = { tz, use: tz }; } catch { zoneSeen = { tz }; }
  }
  return zoneSeen.use;
};
export const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: siteZone() }) : '—');
export const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: siteZone() }) : '—');
/**
 * A date, whether given a timestamp or a plain YYYY-MM-DD.
 *
 * A bare date has no time in it, so it parses as UTC midnight — and shown
 * in a zone behind UTC that is the evening before, which turned "29 Aug"
 * into "28 Aug" on any site west of Greenwich. Anchored at midday, no zone
 * shifts it off its own day.
 */
export const fmtDay = (value) => {
  if (!value) return '—';
  const plain = /^\d{4}-\d{2}-\d{2}$/.test(String(value));
  const when = new Date(plain ? `${value}T12:00:00Z` : value);
  if (Number.isNaN(when.getTime())) return String(value);
  return when.toLocaleDateString('en-GB',
    { day: '2-digit', month: 'short', year: 'numeric', timeZone: plain ? 'UTC' : siteZone() });
};

/* ---------------------------------------------------------------- modal */

/*
 * A visitor photo, full size, from anywhere in the dashboard.
 *
 * Delegated from the document rather than bound per render: the visit record
 * is redrawn inside a modal, the on-site list is redrawn on every poll, and
 * re-binding after each one is how a handler quietly stops working.
 */
document.addEventListener('click', (e) => {
  const img = e.target.closest && e.target.closest('[data-bigphoto]');
  if (!img) return;
  e.preventDefault();
  const box = el(`<div class="photo-zoom" role="dialog" aria-modal="true" aria-label="Visitor photo">
    <figure>
      <img src="${esc(img.dataset.bigphoto)}" alt="">
      <figcaption>${esc(img.dataset.bigphotoName || '')}</figcaption>
    </figure></div>`);
  const shut = () => { box.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (ev) => { if (ev.key === 'Escape') shut(); };
  box.addEventListener('click', shut);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(box);
});

export function modal(title, contentHtml, onSave, saveLabel = 'Save') {
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
 * The emoji worth putting on a kiosk card, grouped by what they are for.
 *
 * Deliberately a curated list rather than every emoji there is: the job is
 * "pick something that reads as a delivery driver from six feet away", and
 * a full picker with a search box makes that harder, not easier. Anything
 * not here can still be pasted in, so nothing is actually shut out.
 */
const EMOJI = [
  ['People', ['👤', '👥', '🧑', '👷', '🧑‍💼', '🧑‍🔧', '🧑‍🏭', '🧑‍⚕️', '🧑‍🚒', '👮', '🕵️', '🧑‍🍳',
    '🧑‍🌾', '🧑‍🎓', '🧑‍🏫', '🧑‍💻', '🤝', '👋', '🙋']],
  ['Trades & site', ['🪛', '🔧', '🔨', '🪚', '🧰', '⚙️', '🪜', '🧱', '🏗️', '🚧', '⛑️', '🦺',
    '🔩', '🪝', '🧪', '⚡', '🔌', '🚿', '🌡️']],
  ['Vehicles', ['🚚', '🚛', '🚐', '🚗', '🚕', '🛻', '🚜', '🏍️', '🚲', '🚨', '🚑', '🚒', '🛵']],
  ['Deliveries', ['📦', '📮', '📬', '🚚', '🧾', '📋', '🏷️', '📥', '🗳️']],
  ['Places & doors', ['🚪', '🏢', '🏭', '🏠', '🏬', '🛗', '🔓', '🔒', '🗝️', '🛡️', '🅿️', '🚻']],
  ['Papers & badges', ['🪪', '📄', '📝', '✍️', '📑', '🗂️', '📊', '📅', '⏱️', '✅', '❗', '⭐']]
];

/**
 * Choose an emoji, or type one in.
 *
 * @param {string} current  what is on the card now, so it can be shown chosen
 * @param {function} onPick called with the new emoji
 */
export function pickEmoji(current, onPick) {
  const body = `
    <p class="muted" style="margin-top:0">Tap one to use it. Anything else can be pasted into the box at the
      bottom — a kiosk shows whatever emoji the tablet has a picture for.</p>
    <div class="emoji-pick">
      ${EMOJI.map(([group, list]) => `<div class="emoji-group">
        <div class="muted emoji-group-name">${esc(group)}</div>
        <div class="emoji-grid">${list.map((e) => `<button class="emoji${e === current ? ' on' : ''}"
          type="button" data-emoji="${esc(e)}" title="${esc(e)}">${esc(e)}</button>`).join('')}</div>
      </div>`).join('')}
    </div>
    <label class="field" style="margin-top:.75rem"><span>Or paste your own</span>
      <input class="input" id="emoji-own" maxlength="8" style="max-width:8rem;text-align:center"
        value="${esc(current)}"></label>`;

  const { bg, close } = modal('Choose an icon', body, (_, done) => {
    const own = $('#emoji-own', bg).value.trim();
    if (own) onPick(own);
    done();
  }, 'Use this');

  $$('[data-emoji]', bg).forEach((b) => b.addEventListener('click', () => {
    // A tap on a grid emoji is the whole decision — making somebody then
    // press Save as well is a step for nothing.
    onPick(b.dataset.emoji);
    close();
  }));
}

/**
 * Copy to the clipboard, and say so on the button that was pressed.
 *
 * navigator.clipboard needs a secure context, which a dashboard opened over
 * plain http:// on the LAN is not — so there is a fallback through a hidden
 * textarea, and the text stays selectable on screen either way.
 */
export async function copyText(text, btn) {
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

export const confirmAction = (message, onYes) =>
  modal('Please confirm', `<p>${esc(message)}</p>`, async (bg, close) => { await onYes(); close(); }, 'Yes, continue');

/** Put the uploaded logo (or initials as a fallback) in the sidebar. */
export function applyBranding() {
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
 * — a link to a board that does not exist yet is worse than no link at all.
 *
 * Shown to everyone signed in, not only administrators. Reception and
 * whoever books deliveries in are the people most likely to want the roster
 * up on a second screen, and they are not the people who can switch it on.
 */
export async function showBoardLink() {
  const link = $('#open-board');
  if (!link) return;
  try {
    const b = await api('/board/link');
    if (b && b.url) {
      link.href = b.url;
      link.classList.remove('hidden');
    } else {
      link.classList.add('hidden');
    }
  } catch { link.classList.add('hidden'); }
}

/* ----------------------------------------------------------------- gate */

export async function showGate() {
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

const goView = (view) => {
  // Settings has no page of its own any more — every entry under it is one.
  if (view === 'settings') return goSection(firstSection());
  markNav(view);
  location.hash = view;
  render(view);
};

/**
 * Open one settings panel as its own page.
 *
 * Already on settings, this is a show/hide: no re-fetch, and nothing typed
 * a moment ago is thrown away mid-save.
 */
function goSection(section) {
  markNav('settings', section);
  location.hash = `settings/${section}`;
  if (CURRENT === 'settings' && $('.card.section[id^="set-"]')) return showSection(section);
  return render('settings', section);
}

$$('#nav > button').forEach((b) => b.addEventListener('click', () => {
  // A heading with no page of its own — Sign-in setup — opens its first entry.
  if (b.dataset.group && !VIEWS[b.dataset.view]) {
    const first = $(`#nav .subnav[data-for="${b.dataset.group}"] button[data-view]`);
    if (first) return first.click();
  }
  goView(b.dataset.view);
}));

$$('#nav .subnav button').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.view) return goView(b.dataset.view);
  goSection(b.dataset.section);
}));

export const VIEWS = {};

export async function render(view, section) {
  const target = $('#view');
  target.innerHTML = '<p class="empty">Loading…</p>';
  CURRENT = view;
  try {
    await (VIEWS[view] || VIEWS.dashboard)(target, section);
  } catch (err) {
    if (err.message !== 'unauthenticated') target.innerHTML = `<p class="empty">Could not load: ${esc(err.message)}</p>`;
  }
}

/* ------------------------------------------------------ settings panels */

/*
 * Settings is a dozen panels, and for a while they were stacked end to end
 * on one page with each folded shut. That was better than one long scroll
 * and still not right: the fold state was a second thing to manage, and a
 * link to a panel dropped you somewhere in the middle of a page that also
 * held eleven others.
 *
 * Each entry under Settings in the menu is now simply its own page. The
 * whole set is still built in one pass — the panels share a settings
 * object, one auto-saver and several collectors that read the DOM — but
 * only the chosen one is on screen, and switching is a show/hide rather
 * than a re-render, so nothing half-typed is lost on the way.
 */

/** The section a settings page is showing, so a re-render can restore it. */
export let SECTION = '';

/** The first entry under Settings — where the tab lands with no section named. */
export const firstSection = () => {
  const b = $('#nav .subnav[data-for="settings"] button[data-section]');
  return b ? b.dataset.section : 'branding';
};

/**
 * Show one settings panel and hide the rest.
 *
 * The panel's own <h2> becomes the page heading rather than sitting under
 * a near-identical <h1>, and `sec:open` still fires the first time each is
 * shown — several panels only fetch what they need at that point.
 */
export function showSection(slug) {
  const sections = $$('.card.section[id^="set-"]');
  if (!sections.length) return;
  const wanted = document.getElementById(`set-${slug}`) ? slug : firstSection();
  SECTION = wanted;

  sections.forEach((sec) => {
    const on = sec.id === `set-${wanted}`;
    sec.hidden = !on;
    const h2 = sec.querySelector(':scope > h2');
    // The heading is promoted to the top of the page, so it would otherwise
    // appear twice.
    if (h2) h2.hidden = true;
    if (on && !sec.dataset.opened) {
      sec.dataset.opened = '1';
      sec.dispatchEvent(new CustomEvent('sec:open'));
    }
  });

  const shown = document.getElementById(`set-${wanted}`);
  const title = $('#set-title');
  const heading = shown && shown.querySelector(':scope > h2');
  if (title && heading) title.textContent = heading.textContent;
  // Coming from another panel, the page should start at the top of this one
  // rather than wherever the last one had been scrolled to.
  const main = document.querySelector('.main');
  if (main) main.scrollTop = 0;
}

/**
 * Light up the row *and* the column under the pointer.
 *
 * A grid of identical dropdowns is easy to slip a row on: you mean to set
 * Photo for contractors and set it for interviews instead, and nothing on
 * screen ever tells you. Both bands lit means the cell you are about to
 * click is the one where they cross.
 *
 * Done in script rather than with :has() so it works the same in whatever
 * browser the site's dashboard happens to be opened in.
 */
export function crossHighlight(table) {
  if (!table) return;
  const clear = () => $$('.cross-row, .cross-col', table)
    .forEach((c) => c.classList.remove('cross-row', 'cross-col'));

  table.addEventListener('mouseover', (e) => {
    const cell = e.target.closest('td[data-col], th[data-col]');
    clear();
    if (!cell || !table.contains(cell)) return;
    $$(`[data-col="${cell.dataset.col}"]`, table).forEach((c) => c.classList.add('cross-col'));
    $$(':scope > td, :scope > th', cell.parentElement).forEach((c) => c.classList.add('cross-row'));
  });
  table.addEventListener('mouseleave', clear);
  // A dropdown opened with the keyboard should light its cell too.
  table.addEventListener('focusin', (e) => {
    const cell = e.target.closest('td[data-col]');
    if (cell) cell.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
}

/** Run something the first time a panel is shown — and now, if it already is. */
export function onSectionOpen(id, fn) {
  const sec = document.getElementById(id);
  if (!sec) return;
  let done = false;
  const go = () => { if (done) return; done = true; fn(); };
  if (sec.dataset.opened) go();
  else sec.addEventListener('sec:open', go);
}

export const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
export function setPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  parts.forEach((k, i) => {
    if (i === parts.length - 1) cur[k] = value;
    else cur = (cur[k] = cur[k] || {});
  });
}

/* ----------------------------------------------------------------- init */

/** Everything this login is not allowed to reach simply is not drawn. */
function applyPermissions() {
  const areas = (ME && ME.areas) || [];
  $$('#nav [data-area]').forEach((el) => {
    el.classList.toggle('hidden', !areas.includes(el.dataset.area));
  });
  // A heading whose every entry is hidden is a heading to nothing.
  $$('#nav .subnav').forEach((sub) => {
    const parent = $(`#nav > button[data-view="${sub.dataset.for}"]`);
    const anyLeft = $$('button', sub).some((b) => !b.classList.contains('hidden'));
    if (parent && !anyLeft) parent.classList.add('hidden');
  });
  $('#who').textContent = `${(ME && (ME.name || ME.email)) || ''}`
    + (ME && ME.role && ME.role !== 'owner' ? ` · ${ME.role}` : '');
}

export const allowed = (view) => {
  const btn = $(`#nav [data-view="${view}"]`);
  return !btn || !btn.dataset.area || ((ME && ME.areas) || []).includes(btn.dataset.area);
};

/**
 * A login handed a temporary password picks its own before anything else.
 *
 * The server refuses everything but this until it is done, so this screen is
 * the readable face of that rather than the thing enforcing it.
 */
function forcePasswordChange() {
  $('#shell').classList.add('hidden');
  const gate = $('#gate');
  gate.classList.remove('hidden');

  /*
   * The sign-in form already has its own submit handler bound. Replacing the
   * element with a copy of itself is what drops that — otherwise both run,
   * and the old one tries to sign in again with the fields now rearranged
   * under it.
   */
  $('#gate-form').replaceWith($('#gate-form').cloneNode(true));

  $('#gate-title').textContent = 'Choose a password';
  $('#gate-sub').textContent = 'The password you were given is temporary. Pick your own to carry on.';
  $('#gate-email').closest('label').hidden = true;
  $('#gate-pass').closest('label').querySelector('span').textContent = 'Temporary password';
  const extra = el(`<label class="field"><span>New password</span>
    <input class="input" id="gate-new" type="password" autocomplete="new-password" required></label>`);
  const again = el(`<label class="field"><span>New password again</span>
    <input class="input" id="gate-again" type="password" autocomplete="new-password" required></label>`);
  $('#gate-pass').closest('label').after(extra, again);
  $('#gate-submit').textContent = 'Set my password';

  $('#gate-form').onsubmit = async (e) => {
    e.preventDefault();
    const box = $('#gate-error');
    const next = $('#gate-new').value;
    if (next !== $('#gate-again').value) {
      box.textContent = 'The two new passwords do not match.';
      return box.classList.remove('hidden');
    }
    try {
      await api('/me/password', { method: 'POST', body: { current: $('#gate-pass').value, password: next } });
      location.reload();
    } catch (err) {
      box.textContent = (err.data && err.data.message) || 'Could not set that password.';
      box.classList.remove('hidden');
    }
  };
}

/* ------------------------------------------------------- global search */

/*
 * Where each kind of result lives, and how to put it in front of somebody
 * once they are on that page.
 *
 * `filter` is the page's own search box, filled in with what they typed so
 * the list is already narrowed. `row` is the attribute the page marks its
 * rows with, used to scroll to the record and flash it — a page of forty
 * rows with the right one somewhere in it is only half an answer.
 */
const SEARCH_TARGETS = {
  visitors: { filter: '#p-q', row: 'data-person' },
  visits: { filter: '#v-q', row: 'data-visit' },
  expected: { row: 'data-exedit' },
  companies: { row: 'data-co' },
  staff: { row: 'data-hedit' },
  projects: { row: 'data-pjedit' },
  devices: { row: 'data-dvedit' }
};

async function openSearchHit(go, query) {
  const target = SEARCH_TARGETS[go.view] || {};
  markNav(go.view);
  location.hash = `#${go.view}`;
  await render(go.view);

  /*
   * The page's own filter, so the list is narrowed to what was typed. Fired
   * as 'input' because that is what these boxes listen for — the same
   * mistake that made "Use where I am now" save nothing.
   */
  if (target.filter && query) {
    const box = $(target.filter);
    if (box) {
      box.value = query;
      box.dispatchEvent(new Event('input', { bubbles: true }));
      // Long enough for a list that reloads from the server to come back.
      await new Promise((done) => setTimeout(done, 450));
    }
  }

  if (!target.row) return;
  const row = $(`[${target.row}="${go.open}"]`);
  if (!row) return;
  const line = row.closest('tr, .card, li') || row;
  line.scrollIntoView({ block: 'center', behavior: 'smooth' });
  line.classList.add('found');
  setTimeout(() => line.classList.remove('found'), 2200);
}

/*
 * Waits for somebody to stop typing before asking. Without it every
 * keystroke is a query, and the answers come back out of order as often as
 * not — which is how a search box ends up showing results for "mar" while
 * the box says "marguerite".
 */
function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function wireGlobalSearch() {
  const box = $('#global-search');
  const panel = $('#search-results');
  if (!box || !panel) return;

  let seq = 0;
  let hits = [];
  let at = -1;

  const close = () => { panel.classList.add('hidden'); panel.innerHTML = ''; hits = []; at = -1; };

  /*
   * The panel is fixed rather than absolute — see the note in admin.css: the
   * sidebar scrolls, and a scrolling box clips what is positioned inside it,
   * which sliced every result down the middle. Fixed escapes the clip and
   * costs this: it has to be put where the box is, by hand, whenever the box
   * moves.
   */
  const place = () => {
    const at = box.getBoundingClientRect();
    panel.style.top = `${Math.round(at.bottom + 6)}px`;
    // Nudged back on screen if the sidebar is too near the right edge to
    // hold it, which is what a narrow window does.
    const width = panel.offsetWidth || 416;
    panel.style.left = `${Math.round(Math.max(8, Math.min(at.left, window.innerWidth - width - 8)))}px`;
  };
  window.addEventListener('resize', () => { if (!panel.classList.contains('hidden')) place(); });
  // The sidebar is what scrolls, so that is what has to be listened to.
  const side = document.querySelector('.side');
  if (side) side.addEventListener('scroll', () => { if (!panel.classList.contains('hidden')) place(); });

  const draw = (data) => {
    hits = [];
    if (!data.groups.length) {
      panel.innerHTML = `<p class="search-empty">${data.too_short
        ? 'Keep typing…'
        : `Nothing matching “${esc(data.query)}”.`}</p>`;
      panel.classList.remove('hidden');
      place();
      return;
    }
    panel.innerHTML = data.groups.map((g) => `
      <div class="search-group">${esc(g.label)}</div>
      ${g.results.map((r) => {
  hits.push({ go: r.go, query: data.query });
  return `<button class="search-hit" type="button" data-hit="${hits.length - 1}">
          <b>${esc(r.title)}</b>
          ${r.detail || r.note ? `<span>${esc([r.detail, r.note].filter(Boolean).join(' · '))}</span>` : ''}
        </button>`;
}).join('')}
      ${g.more ? '<p class="search-more">More on the page itself</p>' : ''}`).join('');
    panel.classList.remove('hidden');
    place();

    $$('[data-hit]', panel).forEach((b) => b.addEventListener('click', async () => {
      const hit = hits[Number(b.dataset.hit)];
      close();
      box.value = '';
      await openSearchHit(hit.go, hit.query);
    }));
  };

  const look = debounce(async () => {
    const q = box.value.trim();
    if (q.length < 2) return close();
    const mine = ++seq;
    try {
      const data = await api(`/search?q=${encodeURIComponent(q)}`);
      // An older answer arriving late must not replace a newer one.
      if (mine === seq) draw(data);
    } catch { if (mine === seq) close(); }
  }, 220);

  box.addEventListener('input', look);
  box.addEventListener('focus', () => { if (box.value.trim().length >= 2) look(); });

  /* Arrow keys through the list, Enter to open, Escape to give up. */
  box.addEventListener('keydown', (e) => {
    const buttons = $$('[data-hit]', panel);
    if (e.key === 'Escape') { close(); box.blur(); return; }
    if (!buttons.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      at = e.key === 'ArrowDown'
        ? Math.min(at + 1, buttons.length - 1)
        : Math.max(at - 1, 0);
      buttons.forEach((b, i) => b.classList.toggle('here', i === at));
      buttons[at].scrollIntoView({ block: 'nearest' });
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      (buttons[at] || buttons[0]).click();
    }
  });

  // A click anywhere else puts it away, but never a click inside the list.
  document.addEventListener('click', (e) => {
    if (!panel.contains(e.target) && e.target !== box) close();
  });
}

export async function start() {
  try {
    ME = await api('/me');
  } catch { return showGate(); }
  if (ME.must_change_password) return forcePasswordChange();
  // Not the whole settings object: that is administrator-only, and every
  // level needs the name, the colours and the site's clock.
  SETTINGS = await api('/branding');
  document.documentElement.style.setProperty('--brand', SETTINGS.org.primary_color || '#2f7d5d');
  document.documentElement.style.setProperty('--brand-dark', SETTINGS.org.accent_color || '#123a2c');
  applyBranding();
  applyPermissions();
  wireGlobalSearch();
  $('#shell').classList.remove('hidden');
  // #settings/retention opens the settings page on that panel.
  const [hashView, section] = (location.hash || '#dashboard').slice(1).split('/');
  // A link to a page this login cannot open lands on the dashboard rather
  // than on an error, which is what a bookmark from a former role looks like.
  const view = (VIEWS[hashView] && allowed(hashView)) ? hashView : 'dashboard';
  markNav(view, view === 'settings' ? (section || firstSection()) : section);
  await render(view, section);
}

/**
 * Replace the whole settings object.
 *
 * A page cannot assign to SETTINGS directly — it is imported, and an imported
 * binding is read-only — so every page that saves settings comes through here.
 * The value it returns is the one every other page will now read.
 */
export function setSettings(next) {
  SETTINGS = next;
  return SETTINGS;
}

