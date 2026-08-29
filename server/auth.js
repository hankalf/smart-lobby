'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { get, run, all, nowISO } = require('./db');

const COOKIE = 'sl_session';
const SESSION_DAYS = 30;

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createUser({ email, password, name, role = 'admin', hostId = null, mustChange = false }) {
  const hash = bcrypt.hashSync(password, 10);
  const res = run(
    `INSERT INTO users (email, password_hash, name, role, host_id, must_change_password, active, created_at)
     VALUES (?,?,?,?,?,?,1,?)`,
    String(email).toLowerCase().trim(), hash, name || email, role, hostId, mustChange ? 1 : 0, nowISO()
  );
  return get('SELECT id, email, name, role, host_id, must_change_password FROM users WHERE id = ?', res.lastInsertRowid);
}

function verifyLogin(email, password) {
  const user = get('SELECT * FROM users WHERE email = ? AND active = 1', String(email || '').toLowerCase().trim());
  if (!user) return null;
  if (!bcrypt.compareSync(String(password || ''), user.password_hash)) return null;
  return user;
}

/**
 * Whether this connection is one a Secure cookie can travel over.
 *
 * Read from the request rather than from NODE_ENV, which was the bug: a
 * platform that terminates TLS ahead of the app — Railway does — passes the
 * real scheme in a header and does not set NODE_ENV for you, so the session
 * cookie went out without Secure on a site served entirely over https. Asking
 * the request is also right for a LAN install on plain http, where marking
 * the cookie Secure would stop anyone signing in at all.
 */
const overHttps = (req) => !!req && (req.secure || req.headers['x-forwarded-proto'] === 'https');

function startSession(res, user, req) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  run('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)', token, user.id, nowISO(), expires.toISOString());
  const secure = overHttps(req) && process.env.INSECURE_COOKIES !== 'true';
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
  return token;
}

function endSession(req, res) {
  const token = parseCookies(req)[COOKIE];
  if (token) run('DELETE FROM sessions WHERE token = ?', token);
  // Cleared with the same flags it was set with, or the browser keeps it.
  const secure = overHttps(req) && process.env.INSECURE_COOKIES !== 'true';
  res.setHeader('Set-Cookie',
    `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
}

function currentUser(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const row = get(
    `SELECT u.id, u.email, u.name, u.role, u.host_id, u.must_change_password FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`,
    token, nowISO()
  );
  if (!row) return null;
  row.must_change_password = !!row.must_change_password;
  // What this login may see, worked out here so nothing downstream has to.
  row.areas = require('./roles').areasFor(row.role);
  return row;
}

function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'not_authenticated' });
  req.user = user;
  next();
}

/**
 * Change a password, and cut every session but the one asking.
 *
 * Somebody changing their password has usually decided the old one is no
 * longer trustworthy, so leaving the other sessions signed in would defeat
 * the point. `keepToken` is the browser doing the changing, which stays.
 */
function setPassword(userId, password, keepToken, { mustChange = false } = {}) {
  if (!password || String(password).length < 8) throw new Error('weak_password');
  run('UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?',
    bcrypt.hashSync(String(password), 10), mustChange ? 1 : 0, userId);
  if (keepToken) run('DELETE FROM sessions WHERE user_id = ? AND token != ?', userId, keepToken);
  else run('DELETE FROM sessions WHERE user_id = ?', userId);
}

function verifyPassword(userId, password) {
  const user = get('SELECT password_hash FROM users WHERE id = ?', userId);
  return !!user && bcrypt.compareSync(String(password || ''), user.password_hash);
}

function anyUsers() {
  return all('SELECT id FROM users LIMIT 1').length > 0;
}

function purgeExpired() {
  run('DELETE FROM sessions WHERE expires_at < ?', nowISO());
}

module.exports = { COOKIE, createUser, verifyLogin, startSession, endSession, currentUser, requireAuth,
  anyUsers, purgeExpired, parseCookies, setPassword, verifyPassword };
