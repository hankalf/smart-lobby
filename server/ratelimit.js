'use strict';
/**
 * A small in-memory rate limiter.
 *
 * The kiosk API is open to the internet by necessity — an iPad in a lobby
 * cannot hold a secret — and the admin login is a password prompt on a public
 * URL. Without a limit, both can be hammered: the login brute-forced, and the
 * visitor lookup used to walk phone numbers until it finds real people. Neither
 * takes any skill, and nothing else in the app stands in the way.
 *
 * In memory rather than in the database because this runs as a single process:
 * a counter that survives a restart is not worth a write per request. A restart
 * forgives everyone, which is an acceptable trade for a lobby system — an
 * attacker cannot cause the restart.
 */

const WINDOWS = new Map();

/*
 * Spoofed source addresses must not be able to grow this without bound. Well
 * past what a real site produces: a lobby sees a handful of addresses, and an
 * attacker filling it just evicts their own entries.
 */
const MAX_KEYS = 20000;

function hits(key, windowMs) {
  const now = Date.now();
  let times = WINDOWS.get(key);
  if (!times) {
    if (WINDOWS.size >= MAX_KEYS) prune(true);
    times = [];
    WINDOWS.set(key, times);
  }
  // Drop anything that has aged out of the window.
  while (times.length && now - times[0] > windowMs) times.shift();
  return times;
}

function prune(force) {
  const now = Date.now();
  for (const [key, times] of WINDOWS) {
    // An hour with nothing in it means the entry is dead whatever its window.
    if (!times.length || now - times[times.length - 1] > 3600000) WINDOWS.delete(key);
  }
  if (force && WINDOWS.size >= MAX_KEYS) WINDOWS.clear();
}
setInterval(prune, 600000).unref?.();

/**
 * Express middleware allowing `max` requests per `windowMs` for each caller.
 *
 * @param {object} opts
 * @param {number} opts.windowMs   how long the window is
 * @param {number} opts.max        requests allowed within it
 * @param {string} opts.name       used in the key, so separate limits do not share a budget
 * @param {(req: object) => string} [opts.keyOn]  extra key material, e.g. the email being tried
 * @param {string} [opts.message]  what the caller is told
 */
function limit({ windowMs, max, name, keyOn, message }) {
  return (req, res, next) => {
    const who = `${name}:${req.ip}${keyOn ? `:${keyOn(req) || ''}` : ''}`;
    const times = hits(who, windowMs);
    if (times.length >= max) {
      const retry = Math.ceil((windowMs - (Date.now() - times[0])) / 1000);
      res.setHeader('Retry-After', String(Math.max(1, retry)));
      return res.status(429).json({
        error: 'too_many_requests',
        message: message || 'Too many attempts. Please wait a moment and try again.',
        retry_after: Math.max(1, retry)
      });
    }
    times.push(Date.now());
    next();
  };
}

/** Forget a caller's attempts — used after a successful login. */
function clear(name, req, keyOn) {
  WINDOWS.delete(`${name}:${req.ip}${keyOn ? `:${keyOn(req) || ''}` : ''}`);
}

module.exports = { limit, clear, _windows: WINDOWS };
