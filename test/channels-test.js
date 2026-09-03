/*
 * A channel per visitor type, alongside the one that hears everything.
 *
 * The shape being tested: the company channel is the plant manager's — it gets
 * every arrival, sign-out, induction, delivery, tablet gone quiet and printer
 * reported down, whatever the type. A visitor type can also have a channel of
 * its own, which gets that type's notifications and nothing else, narrowed
 * further by which events are ticked for it.
 *
 * Every check here is about where a post landed rather than about what it
 * says, because that is the whole feature and it is the part that cannot be
 * verified by reading the settings back: a webhook stored perfectly and never
 * posted to looks exactly like one that works.
 */
'use strict';
const http = require('http');
const { chromium, launchOptions, available } = require('./browser');
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

/* One stub standing in for several Teams channels, told apart by path. */
const posts = [];
const hooks = http.createServer((q, res) => {
  let body = '';
  q.on('data', (c) => { body += c; });
  q.on('end', () => {
    posts.push({ path: q.url, body: JSON.parse(body || '{}') });
    res.writeHead(202); res.end('');
  });
});

const PORT = 2712;
const at = (name) => `http://127.0.0.1:${PORT}/webhook.office.com/${name}`;
const EVERYTHING = at('everything');      // the plant manager's channel
const CONTRACTORS = at('contractors');    // one visitor type's own
const VISITORS = at('visitors');          // another's

const landed = () => posts.map((p) => p.path.split('/').pop());
const went = (name) => posts.some((p) => p.path.endsWith(`/${name}`));
const text = (name) => JSON.stringify((posts.find((p) => p.path.endsWith(`/${name}`)) || {}).body || {});
const settle = () => new Promise((done) => setTimeout(done, 1400));

(async () => {
  await new Promise((r) => hooks.listen(PORT, '127.0.0.1', r));
  await req('POST', '/api/admin/login', { email: 'owner@example.test', password: 'Testing123!' });

  const project = (await req('GET', '/api/admin/projects')).data[0];
  const staff = (await req('POST', '/api/admin/staff',
    { name: 'Renata Colquhoun', email: 'renata@x.test', active: 1 })).data;

  const signIn = (type, name) => req('POST', '/api/kiosk/signin', {
    full_name: name, company: 'Ashcroft Surveying', phone: '415-268-0700',
    visit_type: type, project_id: project && project.id, host_id: staff.id,
    client_ref: `chan-${type}-${Date.now()}-${Math.random()}`
  });

  /* ---------------------------------------------- what is stored, and what is not */

  let r = await req('PUT', '/api/admin/settings', {
    notify: {
      on_signin: true, on_signout: true, on_induction: true,
      global_webhook_url: EVERYTHING, webhook_channel_always: true, webhook_format: 'teams',
      type_routing: {
        contractor: { staff: [], webhook_url: CONTRACTORS, events: { signin: true, signout: true, induction: true } },
        visitor: { staff: [], webhook_url: VISITORS, events: { signin: true, signout: false, induction: true } }
      }
    }
  });
  ok('a channel per visitor type is stored',
    r.data.notify.type_routing.contractor.webhook_url === CONTRACTORS
    && r.data.notify.type_routing.visitor.webhook_url === VISITORS,
    JSON.stringify(r.data.notify.type_routing));
  ok('…and so is which of its notifications go there',
    r.data.notify.type_routing.visitor.events.signout === false,
    JSON.stringify(r.data.notify.type_routing.visitor.events));

  /*
   * The mistake that actually happens: pasting the link that opens the channel
   * in Teams instead of the workflow's webhook. It looks like a URL, it saves
   * without complaint, and nothing is ever delivered to it — so it is refused
   * here, with the reason and the fix.
   */
  r = await req('PUT', '/api/admin/settings', {
    notify: { type_routing: { driver: { staff: [], webhook_url: 'https://teams.microsoft.com/l/channel/19%3aabc/General' } } }
  });
  ok('a link that opens the channel in Teams is refused, not stored',
    r.data.notify.type_routing.driver.webhook_url === ''
    && r.data.warnings.some((w) => /not a webhook/.test(w)),
    JSON.stringify(r.data.warnings));

  r = await req('PUT', '/api/admin/settings', {
    notify: { type_routing: { driver: { staff: [], webhook_url: 'ftp://files.example.test/drop' } } }
  });
  ok('…and so is anything that is not a web address at all',
    r.data.notify.type_routing.driver.webhook_url === ''
    && r.data.warnings.some((w) => /not a web address/.test(w)),
    JSON.stringify(r.data.warnings));

  /* ------------------------------------------------------- where the posts land */

  posts.length = 0;
  r = await signIn('contractor', 'Marguerite Oyelaran');
  ok('a contractor signs in', r.status === 200, JSON.stringify(r.data).slice(0, 90));
  await settle();
  ok('the contractors channel is told', went('contractors'), landed().join(', '));
  ok('…and so is the channel that hears everything', went('everything'), landed().join(', '));
  ok('…and the visitors channel is not', !went('visitors'), landed().join(', '));
  ok('…with the card it would really get, naming the visitor',
    /Marguerite Oyelaran/.test(text('contractors')), text('contractors').slice(0, 120));

  const contractorVisit = r.data.visit_id || (r.data.visit && r.data.visit.id);

  posts.length = 0;
  r = await signIn('visitor', 'Tobias Wren');
  ok('a visitor signs in', r.status === 200, JSON.stringify(r.data).slice(0, 90));
  await settle();
  ok('the visitors channel is told', went('visitors'), landed().join(', '));
  ok('…the contractors channel is not', !went('contractors'), landed().join(', '));
  const visitorVisit = r.data.visit_id || (r.data.visit && r.data.visit.id);

  /*
   * The narrowing. Sign-outs are ticked for contractors and unticked for
   * visitors, so the same event lands in one channel and not the other — while
   * the channel that hears everything hears both, which is the point of it.
   */
  posts.length = 0;
  await req('POST', `/api/admin/visits/${contractorVisit}/signout`);
  await settle();
  ok('a sign-out reaches a channel that asked for sign-outs',
    went('contractors') && went('everything'), landed().join(', '));

  posts.length = 0;
  await req('POST', `/api/admin/visits/${visitorVisit}/signout`);
  await settle();
  ok('…and is kept out of one that did not ask for them',
    !went('visitors'), landed().join(', '));
  ok('…while the channel that hears everything still hears it',
    went('everything'), landed().join(', '));

  /* A type nobody is posting about at all tells nobody, channel included. */
  await req('PUT', '/api/admin/settings', { notify: { types_notified: { contractor: false } } });
  posts.length = 0;
  await signIn('contractor', 'Silent Arrival');
  await settle();
  ok('a type switched off entirely posts nowhere, its own channel included',
    posts.length === 0, landed().join(', '));
  await req('PUT', '/api/admin/settings', { notify: { types_notified: { contractor: true } } });

  /*
   * A site that points a type's channel at the same place as the company one
   * should get one post, not two. Everyone in that channel reading the same
   * arrival twice is how a channel gets muted.
   */
  await req('PUT', '/api/admin/settings', {
    notify: { type_routing: { contractor: { staff: [], webhook_url: EVERYTHING, events: { signin: true } } } }
  });
  posts.length = 0;
  await signIn('contractor', 'Twice Over');
  await settle();
  ok('the same channel named twice is posted to once',
    posts.filter((p) => p.path.endsWith('/everything')).length === 1, landed().join(', '));

  /* And with no channel set, nothing changes for anybody. */
  await req('PUT', '/api/admin/settings', {
    notify: { type_routing: { contractor: { staff: [], webhook_url: '', events: { signin: true } } } }
  });
  posts.length = 0;
  await signIn('contractor', 'No Channel');
  await settle();
  ok('a type with no channel of its own still reaches the company channel',
    went('everything') && !went('contractors'), landed().join(', '));

  /*
   * Absent means yes. A channel set up before an event existed should hear
   * about that event rather than silently not — the same rule types_notified
   * uses, and the one that decides whether this ages well.
   */
  await req('PUT', '/api/admin/settings', {
    notify: { type_routing: { contractor: { staff: [], webhook_url: CONTRACTORS, events: {} } } }
  });
  posts.length = 0;
  await signIn('contractor', 'Unnarrowed Channel');
  await settle();
  ok('a channel with nothing ticked either way hears about the type',
    went('contractors'), landed().join(', '));

  /* The test button, aimed at one type's channel. */
  posts.length = 0;
  r = await req('POST', '/api/admin/settings/test-webhook',
    { url: CONTRACTORS, event: 'signin', visit_type: 'contractor' });
  ok('a type\'s channel can be tested on its own',
    r.data.ok === true && posts.length === 1 && posts[0].path.endsWith('/contractors'),
    JSON.stringify(r.data).slice(0, 100));
  ok('…and the test tags nobody, since it is not a real arrival',
    r.data.tagged_nobody === true && !/"mention"/.test(JSON.stringify(posts[0].body)),
    JSON.stringify(r.data).slice(0, 100));

  /* ------------------------------------------------------ setting it up on screen */

  /*
   * The settings side, driven for real. Everything above proves the server
   * routes to a channel it has been told about; none of it proves anybody can
   * tell it. A field that collects a link and quietly drops it on save is a
   * feature that exists in the database and nowhere else.
   */
  if (available()) {
    /*
     * Cleared first, so the panel is opened in the state a site would meet it
     * in: nothing set up yet. The checks below are about what appears as it is
     * filled in, and half of them are meaningless against a prefilled card.
     */
    await req('PUT', '/api/admin/settings', {
      notify: { type_routing: { contractor: { staff: [], webhook_url: '', events: {} } } }
    });
    const browser = await chromium.launch({ ...launchOptions() });
    const page = await browser.newPage({ viewport: { width: 1320, height: 950 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto(`${BASE}/admin/`);
    await page.fill('#gate-email', 'owner@example.test');
    await page.fill('#gate-pass', 'Testing123!');
    await page.click('#gate-submit');
    await page.waitForSelector('#shell:not(.hidden)');
    await page.goto(`${BASE}/admin/#settings/notifications`);
    await page.reload();
    await page.waitForSelector('#set-notifications:not([hidden]) [data-routehook="contractor"]', { timeout: 15000 });

    const card = '[data-routecard="contractor"]';
    const savedRouting = () => page.evaluate(() => fetch('/api/admin/settings')
      .then((r) => r.json()).then((s) => s.notify.type_routing.contractor || {}));

    /*
     * Waited on by asking the server, not by watching the "Saved" pill. The
     * pill from the previous save is still on screen when the next change is
     * made, so waiting for it matches the old one and reads the settings back
     * before the new save has landed — a race that passes most of the time,
     * which is the worst kind.
     */
    async function until(what, check) {
      const deadline = Date.now() + 12000;
      let last;
      for (;;) {
        last = await savedRouting();
        if (check(last)) return last;
        if (Date.now() > deadline) throw new Error(`${what}: ${JSON.stringify(last)}`);
        await new Promise((go) => setTimeout(go, 250));
      }
    }

    ok('an empty channel shows no event ticks and nothing to test',
      await page.$eval(`${card} [data-routeevents]`, (el) => el.classList.contains('hidden'))
      && await page.$eval(`${card} .route-channel-foot`, (el) => el.classList.contains('hidden')));

    await page.fill(`${card} [data-routehook]`, CONTRACTORS);
    let saved = await until('the channel link never saved', (r2) => r2.webhook_url === CONTRACTORS)
      .catch((e) => ({ error: e.message }));
    ok('typing a channel link saves it', saved.webhook_url === CONTRACTORS, JSON.stringify(saved));
    ok('…and reveals what to send there and a way to try it',
      !await page.$eval(`${card} [data-routeevents]`, (el) => el.classList.contains('hidden'))
      && !await page.$eval(`${card} .route-channel-foot`, (el) => el.classList.contains('hidden')));

    await page.uncheck(`${card} [data-routeevent][value="signout"]`);
    saved = await until('unticking never reached the server', (r2) => r2.events && r2.events.signout === false)
      .catch((e) => ({ error: e.message, events: {} }));
    ok('unticking an event keeps it out of that channel, and stays unticked',
      saved.events && saved.events.signout === false && saved.events.signin === true,
      JSON.stringify(saved.events || saved));

    /* The test button, from the page rather than from the API. */
    posts.length = 0;
    await page.click(`${card} [data-routetest]`);
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-routetestnote="contractor"]');
      return el && el.textContent && !/Posting/.test(el.textContent);
    }, null, { timeout: 15000 });
    /*
     * "Accepted", not "posted". A Teams workflow answers 202 when it takes the
     * request and posts the card afterwards, so that is the whole of what this
     * knows — see the same distinction in teams-test.
     */
    ok('the test button reaches that channel and says what it knows',
      posts.length === 1 && posts[0].path.endsWith('/contractors')
      && /Accepted by the workflow/.test(await page.$eval('[data-routetestnote="contractor"]', (el) => el.textContent)),
      `${posts.map((p) => p.path).join(', ')} — ${await page.$eval('[data-routetestnote="contractor"]', (el) => el.textContent)}`);

    /*
     * A link the server refuses has to leave the box. Showing a channel link
     * that was not stored, on a page whose whole promise is that it saves as
     * you type, is the exact failure this checking exists to prevent.
     */
    await page.fill(`${card} [data-routehook]`, 'https://teams.microsoft.com/l/channel/19%3aabc/General');
    await page.waitForFunction(() =>
      document.querySelector('[data-routehook="contractor"]').value === '', null, { timeout: 10000 });
    ok('a link the server refuses is taken back off the screen rather than left looking saved',
      (await savedRouting()).webhook_url === '',
      JSON.stringify(await savedRouting()));
    ok('…and the ticks and the test button go with it',
      await page.$eval(`${card} [data-routeevents]`, (el) => el.classList.contains('hidden')));

    ok('the panel threw nothing while doing any of that', errors.length === 0, errors.slice(0, 2).join(' | '));
    await browser.close();
  } else {
    console.log('  (skipping the settings panel — no browser)');
  }

  /* Put the fixtures back for the suites that follow. */
  await req('PUT', '/api/admin/settings', {
    notify: {
      global_webhook_url: '', on_signout: false, on_induction: false,
      type_routing: { contractor: { staff: [], webhook_url: '', events: {} },
        visitor: { staff: [], webhook_url: '', events: {} } }
    }
  });

  await new Promise((done) => hooks.close(done));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
