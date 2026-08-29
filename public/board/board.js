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
  let latest = null;

  /*
   * Roll call: the same list, but you tap people off it as they are found at
   * the muster point. Who has been accounted for is held here and in this
   * browser only — a fire is the worst possible moment to be waiting on a
   * round trip, and the board keeps polling underneath so somebody signing
   * out on their phone still drops off the list.
   */
  const ACCOUNTED_KEY = 'sl.board.accounted';
  let rollcall = false;
  let accounted = new Set();
  try { accounted = new Set(JSON.parse(sessionStorage.getItem(ACCOUNTED_KEY) || '[]')); } catch { /* private mode */ }
  const rememberAccounted = () => {
    try { sessionStorage.setItem(ACCOUNTED_KEY, JSON.stringify([...accounted])); } catch { /* private mode */ }
  };

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
    const off = rollcall && accounted.has(p.id);
    return `<div class="person${isNew ? ' new' : ''}${rollcall ? ' tappable' : ''}${off ? ' accounted' : ''}"
      ${rollcall ? `data-person="${p.id}" role="button" tabindex="0"` : ''}>
      ${p.photo
        ? `<img class="avatar" src="${esc(p.photo)}" alt="">`
        : `<div class="avatar">${esc(initials(p.name))}</div>`}
      <div class="who">
        <div class="name">${esc(p.name)}</div>
        <div class="sub">${p.type ? `<span class="tag">${esc(p.type)}</span>` : ''}${esc(sub)}</div>
      </div>
      <div class="when">${off ? '✓' : esc(time(showOut ? p.out : p.in))}</div>
    </div>`;
  }

  /** Tapping somebody marks them found; tapping again puts them back. */
  function bindRollcall() {
    if (!rollcall) return;
    document.querySelectorAll('[data-person]').forEach((el) => {
      const toggle = () => {
        const id = Number(el.dataset.person);
        if (accounted.has(id)) accounted.delete(id); else accounted.add(id);
        rememberAccounted();
        if (latest) draw(latest);
      };
      el.addEventListener('click', toggle);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    });
  }

  function draw(data) {
    latest = data;
    zone = data.timezone;
    locale = data.date_format || 'en-GB';
    drawCamera(data.camera);

    $('#title').textContent = data.title;
    if (data.logo) { $('#logo').src = data.logo; $('#logo').hidden = false; }

    const recentFrom = Date.parse(data.recent_since);
    const isRecent = (iso) => Date.parse(iso) >= recentFrom;

    const arrivals = data.onsite.filter((p) => isRecent(p.in));
    const settled = data.onsite.filter((p) => !isRecent(p.in));

    $('#count').textContent = data.onsite.length;
    const stillMissing = data.onsite.filter((p) => !accounted.has(p.id)).length;
    $('#subtitle').textContent = rollcall
      ? `${data.onsite.length - stillMissing} of ${data.onsite.length} accounted for`
      : data.onsite.length
        ? `${arrivals.length} arrived in the last ${data.recent_minutes} minutes`
        : 'Nobody is signed in';

    $('#rollcall-note').textContent = rollcall
      ? 'Tap each person as they are found. This is kept on this device only, and clears when you close the tab.'
      : '';
    show($('#rollcall-note'), rollcall);

    $('#arrivals').innerHTML = rollcall ? '' : arrivals.map((p) => card(p, { isNew: true })).join('');

    // With arrivals called out above, this heading would otherwise lie.
    $('#onsite-heading').textContent = rollcall ? 'Everyone on site'
      : arrivals.length ? 'Also on site' : 'On site';
    const listed = rollcall ? data.onsite : settled;
    $('#onsite').innerHTML = listed.length
      ? listed.map((p) => card(p, { isNew: !rollcall && false })).join('')
      : ((!rollcall && arrivals.length) ? '' : '<p class="empty">Nobody is signed in right now.</p>');

    // In a roll call the only question is who is still inside, so who left is
    // noise — and the new arrivals are not a separate group either.
    $('#arrivals-wrap').hidden = rollcall || !arrivals.length;
    $('#left-wrap').hidden = rollcall || !data.left.length;
    $('#left').innerHTML = rollcall ? '' : data.left.map((p) => card(p, { showOut: true })).join('');
    bindRollcall();

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

  const show = (el, on) => { if (el) el.classList.toggle('hidden', !on); };

  /*
   * How the picture arrives depends on what the camera speaks. A snapshot is
   * one JPEG re-fetched on a timer; MJPEG is a single image element the camera
   * keeps writing to; HLS is a video; and some cameras only offer their own
   * page, which has to be framed and may refuse to be.
   */
  let cameraTimer = null;
  let cameraShown = null;
  function drawCamera(cam) {
    const box = $('#camera-box');
    if (!cam) { show(box, false); clearInterval(cameraTimer); cameraShown = null; return; }
    const signature = JSON.stringify(cam);
    show(box, true);
    box.className = `camera-box size-${cam.size || 'small'}`;
    $('#camera-label').textContent = cam.label || '';
    if (signature === cameraShown) return;   // already up; do not restart the stream
    cameraShown = signature;
    clearInterval(cameraTimer);

    const holder = $('#camera-holder');
    if (cam.mode === 'embed') {
      holder.innerHTML = `<iframe src="${cam.url}" title="Camera" referrerpolicy="no-referrer"></iframe>`;
    } else if (cam.mode === 'hls') {
      holder.innerHTML = `<video src="${cam.url}" autoplay muted playsinline></video>`;
    } else if (cam.mode === 'mjpeg') {
      holder.innerHTML = `<img src="${cam.url}" alt="">`;
    } else {
      const draw = () => {
        const sep = cam.url.includes('?') ? '&' : '?';
        // A cache-buster, or the browser shows the same first frame all day.
        holder.innerHTML = `<img src="${cam.url}${sep}_=${Date.now()}" alt="">`;
      };
      draw();
      cameraTimer = setInterval(draw, cam.refresh * 1000);
    }
    holder.onclick = () => box.classList.toggle('big');
  }

  $('#rollcall-toggle').addEventListener('click', () => {
    rollcall = !rollcall;
    $('#rollcall-toggle').textContent = rollcall ? 'Back to the board' : 'Roll call';
    $('#rollcall-toggle').classList.toggle('on', rollcall);
    document.body.classList.toggle('rollcall', rollcall);
    if (!rollcall) { accounted.clear(); rememberAccounted(); }
    if (latest) draw(latest);
  });

  tick();
  setInterval(tick, 10_000);
  poll();
  setInterval(poll, POLL_MS);
  // A board left open all day should be current the moment somebody looks at it.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
})();
