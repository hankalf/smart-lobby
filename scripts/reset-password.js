#!/usr/bin/env node
'use strict';
/**
 * The way back in when nobody can sign in.
 *
 * There is no mail server here, so there is no "email me a reset link" — and
 * without this there was no recovery at all: the owner cannot delete their own
 * account, and every other route needs a session first. Run it on the machine
 * holding the data, which is the thing being proved:
 *
 *   node scripts/reset-password.js you@example.com 'a new password'
 *
 * On Railway that is a one-off command against the service with the volume
 * mounted. With no arguments it lists the accounts, so you can see which
 * address to use.
 *
 * Every session for that account is dropped, so a stolen cookie does not
 * outlive the reset.
 */
const { migrate, all, get, run } = require('../server/db');
const auth = require('../server/auth');

migrate();

const [email, password] = process.argv.slice(2);

if (!email) {
  const users = all('SELECT id, email, name, role, active FROM users ORDER BY id');
  if (!users.length) {
    console.log('\n  No accounts yet — open the dashboard and the first-run screen will make one.\n');
    process.exit(0);
  }
  console.log('\n  Accounts on this install:\n');
  for (const u of users) {
    console.log(`    ${u.email}${u.active ? '' : '  (disabled)'}  —  ${u.role}${u.name ? `, ${u.name}` : ''}`);
  }
  console.log('\n  To set one:  node scripts/reset-password.js <email> \'<new password>\'\n');
  process.exit(0);
}

if (!password || password.length < 8) {
  console.error('\n  A password of at least 8 characters is required.\n');
  process.exit(1);
}

const user = get('SELECT id, email FROM users WHERE email = ?', String(email).toLowerCase().trim());
if (!user) {
  console.error(`\n  No account with the address ${email}. Run with no arguments to list them.\n`);
  process.exit(1);
}

auth.setPassword(user.id, password);
// Re-enable it too: an account switched off cannot sign in whatever its password.
run('UPDATE users SET active = 1 WHERE id = ?', user.id);
run(`INSERT INTO audit_log (user_id, action, entity, entity_id, detail, created_at)
     VALUES (?,?,?,?,?,?)`,
  null, 'password_reset', 'user', user.id, JSON.stringify({ by: 'command line' }), new Date().toISOString());

console.log(`\n  ${user.email} can now sign in with that password.`);
console.log('  Every other session for that account has been signed out.\n');
