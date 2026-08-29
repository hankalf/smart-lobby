/*
 * Offline resilience for the kiosk. The service worker keeps a copy of the
 * app itself, the configuration, and every image the kiosk has shown, so a
 * dropped connection — a cellular tablet in a dead spot, the site router
 * rebooting — leaves a working kiosk rather than a browser error page.
 *
 * Nothing is served stale while the network is up: the app and configuration
 * are fetched network-first, exactly as before, and the cache only answers
 * when the network cannot. Media uses the cache first and refreshes behind
 * the scenes, since a slide or background that is a request old is fine.
 * Sign-ins are not handled here — the page queues those itself, where it can
 * tell the visitor what happened.
 */
'use strict';

const CACHE = 'sl-kiosk-v3';
const SHELL = ['/kiosk/', '/kiosk/kiosk.js', '/kiosk/aamva.js', '/kiosk/kiosk.css', '/shared/theme.css',
  '/kiosk/vendor/jsQR.js'];
// The PDF417 decoder is 350KB and only some sites scan licences, so it is not
// pre-cached — the network-first rule below keeps a copy once it has been used.

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
      .catch(() => { /* a missing asset must not block install; it caches on first use */ })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(request)
      /*
       * Any device address — /kiosk/north-gate, or an older /kiosk/?token=… —
       * is the same kiosk page, so the shell answers for one that has not been
       * opened on this tablet before. The page still reads the device from the
       * address bar, which the browser keeps as requested, so it comes up as
       * the right tablet even when served from the generic cache entry.
       */
      || (request.mode === 'navigate' ? await cache.match('/kiosk/') : null);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirstRefresh(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const refresh = fetch(request)
    .then((res) => { if (res.ok) cache.put(request, res.clone()); return res; })
    .catch(() => null);
  return cached || refresh.then((res) => res || Response.error());
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // sign-ins and pings go straight through

  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  if (url.pathname.startsWith('/media/public/')) {
    event.respondWith(cacheFirstRefresh(request));
    return;
  }
  // The app shell, the kiosk configuration, and small GET lookups such as the
  // per-type document list: fresh while the network is up, cached when not.
  if (url.pathname.startsWith('/kiosk') || url.pathname === '/shared/theme.css'
      || url.pathname.startsWith('/api/kiosk/') || url.pathname.startsWith('/api/qr')) {
    event.respondWith(networkFirst(request));
  }
});
