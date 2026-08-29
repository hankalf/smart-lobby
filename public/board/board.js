/* Smart Lobby — the wall board. Who is on site, kept current on its own. */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s)
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // /board/<key> — the key is the credential, and every request carries it.
  const KEY = decodeURIComponent((location.pathname.match(/\/board\/([^/]+)/) || [])[1] || '');

  const POLL_MS = 10_000;
  let zone = null;
  let locale = 'en-GB';
  let failures = 0;

  const time = (iso) => {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', timeZone: zone || undefined });
    } catch { return ''; }
  };

  /** Two initials when there is no photo — better than an empty circle. */
  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }

  function card(p, { isNew = false, showOut = false } = {}) {
    const sub = [p.company, p.host ? `to see ${p.host}` : null, p.project].filter(Boolean).join(' · ');
    return `<div class="person${isNew ? ' new' : ''}">
      ${p.photo
        ? `<img class="avatar" src="${esc(p.photo)}" alt="">`
        : `<div class="avatar">${esc(initials(p.name))}</div>`}
      <div class="who">
        <div class="name">${esc(p.name)}</div>
        <div class="sub">${p.type ? `<span class="tag">${esc(p.type)}</span>` : ''}${esc(sub)}</div>
      </div>
      <div class="when">${esc(time(showOut ? p.out : p.in))}</div>
    </div>`;
  }

  function draw(data) {
    zone = data.timezone;
    locale = data.date_format || 'en-GB';

    $('#title').textContent = data.title;
    if (data.logo) { $('#logo').src = data.logo; $('#logo').hidden = false; }

    const recentFrom = Date.parse(data.recent_since);
    const isRecent = (iso) => Date.parse(iso) >= recentFrom;

    const arrivals = data.onsite.filter((p) => isRecent(p.in));
    const settled = data.onsite.filter((p) => !isRecent(p.in));

    $('#count').textContent = data.onsite.length;
    $('#subtitle').textContent = data.onsite.length
      ? `${arrivals.length} arrived in the last ${data.recent_minutes} minutes`
      : 'Nobody is signed in';

    $('#arrivals-wrap').hidden = !arrivals.length;
    $('#arrivals').innerHTML = arrivals.map((p) => card(p, { isNew: true })).join('');

    // With arrivals called out above, this heading would otherwise lie.
    $('#onsite-heading').textContent = arrivals.length ? 'Also on site' : 'On site';
    $('#onsite').innerHTML = settled.length
      ? settled.map((p) => card(p)).join('')
      : (arrivals.length ? '' : '<p class="empty">Nobody is signed in right now.</p>');

    $('#left-wrap').hidden = !data.left.length;
    $('#left').innerHTML = data.left.map((p) => card(p, { showOut: true })).join('');

    // The site's zone arrives with the roster, so the clock is redrawn here as
    // well — otherwise it shows the viewer's own time until the next tick.
    tick();
  }

  async function poll() {
    try {
      const res = await fetch(`/api/board/${encodeURIComponent(KEY)}/data`, { cache: 'no-store' });
      if (res.status === 404) {
        // The key was cleared in the dashboard — say so rather than sitting on
        // a board that has quietly stopped being true.
        document.querySelector('main').innerHTML =
          '<p class="empty">This board has been turned off. Ask for a new link.</p>';
        $('#subtitle').textContent = '';
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      draw(await res.json());
      failures = 0;
      $('#offline').classList.add('hidden');
    } catch {
      // One dropped poll on a flaky connection is not worth a banner.
      if (++failures >= 2) $('#offline').classList.remove('hidden');
    }
  }

  function tick() {
    try {
      $('#clock').textContent = new Date().toLocaleTimeString(locale,
        { hour: '2-digit', minute: '2-digit', timeZone: zone || undefined });
    } catch { $('#clock').textContent = ''; }
  }

  tick();
  setInterval(tick, 10_000);
  poll();
  setInterval(poll, POLL_MS);
  // A board left open all day should be current the moment somebody looks at it.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
})();
