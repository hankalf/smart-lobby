/*
 * A button in the settings must not be able to stop the gate.
 *
 * This exists because one could. The Test button on a staff member's chat
 * webhook built its message the way notifications were built before they were
 * designed; the sender read a property of undefined; and because Express 4
 * hands a *thrown* error to the error middleware but never sees what an async
 * handler *rejects* with, that became an unhandled rejection and Node ended
 * the process. Every tablet mid-sign-in lost its request, and on a host that
 * restarts by itself the only symptom was a button that seemed to do nothing.
 *
 * Two halves, and the second is the one that matters in a year:
 *
 *   - The button works, and sends the card somebody actually wants to see.
 *   - A handler that throws costs one 500 and nothing else, whatever the
 *     handler is, because the guard is on the router rather than on the route.
 *     The next bug of this shape will be a bug, not an outage.
 *
 * The guard is exercised against an express app started here rather than by
 * breaking the real server. Proving the point by killing the server every
 * other suite is about to use would be a poor trade.
 */
'use strict';
const http = require('http');
const express = require('express');
const BASE = process.env.BASE_URL || 'http://localhost:3401';
let cookie = '';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n}${x ? ' — ' + x : ''}`); } };

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie },
    body: body ? JSON.stringify(body) : undefined
  });
  const setc = res.headers.get('set-cookie'); if (setc) cookie = setc.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => null) };
}

(async () => {
  /* ------------------------------------------------ the guard, on its own */

  const { guard } = require('../server/asyncroutes');

  const app = guard(express());
  const inner = guard(express.Router());
  let reached = 0;

  inner.get('/mounted', (rq, rs) => { reached++; rs.json({ ok: true }); });

  app.get('/fine', (rq, rs) => rs.json({ ok: true }));
  app.get('/throws-sync', () => { throw new Error('thrown outright'); });
  app.get('/throws-async', async () => { throw new Error('rejected'); });
  app.get('/rejects', () => Promise.reject(new Error('a bare rejection')));
  // A handler that answers and *then* fails: the response is already gone, so
  // the only thing left to protect is the process.
  app.get('/late', async (rq, rs) => { rs.json({ ok: true }); throw new Error('after the answer'); });
  app.use('/sub', inner);

  let handled = 0;
  app.use((err, rq, rs, next) => {           // eslint-disable-line no-unused-vars
    handled++;
    rs.status(500).json({ error: 'server_error', detail: String(err.message) });
  });

  const server = http.createServer(app);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const local = `http://127.0.0.1:${server.address().port}`;
  /*
   * On a timer, because the failure this guards against is not an error — it
   * is silence. Without the guard the rejected handler never answers, and a
   * plain fetch would wait for ever: the suite would hang rather than fail,
   * which tells whoever is watching nothing at all.
   */
  const hit = async (p) => {
    try {
      const r = await fetch(local + p, { signal: AbortSignal.timeout(4000) });
      return { status: r.status, data: await r.json().catch(() => null) };
    } catch (err) {
      return { status: 0, data: { detail: `no answer — ${String(err.message || err)}` } };
    }
  };

  /*
   * Nothing here is allowed to end the process, so a failure to guard shows up
   * as this suite dying rather than as a red check. Watched for explicitly, so
   * the reason is on the screen either way.
   */
  const died = [];
  process.on('unhandledRejection', (e) => died.push(String(e && e.message)));

  let r = await hit('/fine');
  ok('an ordinary route still answers', r.status === 200 && r.data.ok === true, JSON.stringify(r));

  r = await hit('/throws-sync');
  ok('a handler that throws outright reaches the error middleware',
    r.status === 500 && /thrown outright/.test(r.data.detail), JSON.stringify(r));

  r = await hit('/throws-async');
  ok('an async handler that throws does too — the whole point',
    r.status === 500 && /rejected/.test(r.data.detail), JSON.stringify(r));

  r = await hit('/rejects');
  ok('so does a handler that just hands back a rejected promise',
    r.status === 500 && /a bare rejection/.test(r.data.detail), JSON.stringify(r));

  r = await hit('/sub/mounted');
  ok('a mounted router is left alone and still routes',
    r.status === 200 && reached === 1, `${r.status}, reached ${reached}`);

  r = await hit('/late');
  ok('a handler that fails after answering still answers',
    r.status === 200 && r.data.ok === true, JSON.stringify(r));

  ok('the error middleware ran for each failure, not once for all of them',
    handled === 4, String(handled));

  // A tick for anything that was going to become an unhandled rejection.
  await new Promise((done) => setTimeout(done, 150));
  ok('and nothing was left to end the process', died.length === 0, died.join(' | '));

  await new Promise((done) => server.close(done));

  /* ------------------------------------------- the button that started it */

  const hooks = [];
  const stub = http.createServer((q, res) => {
    let body = '';
    q.on('data', (c) => { body += c; });
    q.on('end', () => { hooks.push(JSON.parse(body || '{}')); res.writeHead(202).end(''); });
  });
  await new Promise((done) => stub.listen(0, '127.0.0.1', done));
  const personal = `http://127.0.0.1:${stub.address().port}/webhook.office.com/personal`;

  await req('POST', '/api/admin/login', { email: 'owner@example.test', password: 'Testing123!' });
  const person = (await req('POST', '/api/admin/staff',
    { name: 'Priya Raman', email: 'priya@robust.test', webhook_url: personal, active: 1 })).data;

  hooks.length = 0;
  r = await req('POST', `/api/admin/staff/${person.id}/test-webhook`, {});
  ok('the test button on a staff record answers at all',
    r.status === 200 && r.data && typeof r.data.ok === 'boolean', JSON.stringify(r).slice(0, 120));
  ok('…reports that it was delivered', r.data.ok === true, JSON.stringify(r.data).slice(0, 120));
  ok('…and something really arrived at that person\'s own webhook',
    hooks.length === 1, `${hooks.length} post(s)`);

  /*
   * The card, not a bare line. "It arrived" is half the question; whether it
   * arrives looking like anything is the other half, and the old shape sent
   * something no renderer could make a card out of.
   */
  const sent = JSON.stringify(hooks[0] || {});
  ok('…as the designed card, in the Teams envelope',
    hooks[0] && hooks[0].type === 'message'
    && hooks[0].attachments[0].contentType.includes('adaptive'), sent.slice(0, 120));
  ok('…marked as a test, so nobody reads it as a real arrival',
    / — test/.test(sent), sent.slice(0, 200));
  ok('…naming the person it is proving the link for', /Priya Raman/.test(sent), sent.slice(0, 200));
  ok('…and tagging nobody, since a test is not an arrival',
    r.data.tagged_nobody === true && !/"mentioned"/.test(sent), sent.slice(0, 160));

  /* A person with no webhook is told so, rather than something being attempted. */
  const bare = (await req('POST', '/api/admin/staff',
    { name: 'Nobody Nowhere', email: 'nobody@robust.test', active: 1 })).data;
  hooks.length = 0;
  r = await req('POST', `/api/admin/staff/${bare.id}/test-webhook`, {});
  ok('a staff member with no chat link is told so, and nothing is sent',
    r.status === 200 && r.data.ok === false && /No chat webhook/.test(r.data.detail) && hooks.length === 0,
    JSON.stringify(r.data));

  /*
   * And the server is still there. This is the check the whole suite is named
   * for: before the guard, the request above took the process with it.
   */
  r = await req('GET', '/api/health');
  ok('the server is still serving after all of that', r.status === 200 && r.data.ok === true,
    JSON.stringify(r).slice(0, 100));

  /* Tidy up, so a later suite does not find two invented people. */
  await req('DELETE', `/api/admin/staff/${person.id}`);
  await req('DELETE', `/api/admin/staff/${bare.id}`);

  await new Promise((done) => stub.close(done));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
