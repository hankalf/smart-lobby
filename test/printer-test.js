/*
 * A badge printer that has stopped printing.
 *
 * The thing to hold on to while reading this: nothing in this system can see a
 * printer. Badges go out over AirPrint from the tablet, the server never
 * speaks to the printer, and on Wireless Direct the printer sits on a network
 * only that one tablet has joined. No browser reports whether a print
 * succeeded either — the dialog closes the same way whether a label came out
 * or the printer is switched off in a cupboard.
 *
 * So this is a flag a person sets, and what is worth proving is that it
 * behaves like one: it says who set it and when, it reaches every screen that
 * should show it at once, a second press does not post a second card, and only
 * a person clears it.
 */
'use strict';
const BASE = process.env.BASE_URL || 'http://localhost:3401';
let cookie = '';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n}${x ? ' — ' + x : ''}`); } };

async function req(method, p, body) {
  const res = await fetch(BASE + p, {
    method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie },
    body: body ? JSON.stringify(body) : undefined
  });
  const setc = res.headers.get('set-cookie'); if (setc) cookie = setc.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => null) };
}

const printers = () => req('GET', '/api/admin/printers').then((r) => r.data || []);
const dashPrinters = () => req('GET', '/api/admin/dashboard')
  .then((r) => ((r.data || {}).health || {}).printers || []);

(async () => {
  await req('POST', '/api/admin/login', { email: 'owner@example.test', password: 'Testing123!' });

  const made = (await req('POST', '/api/admin/printers',
    { name: 'Trouble Test Printer', label_type: 'DK-2251 62mm continuous' })).data;
  ok('a printer can be registered', !!(made && made.id), JSON.stringify(made).slice(0, 90));

  /* ---- a new printer is not in trouble ---- */
  let row = (await printers()).find((p) => p.id === made.id);
  ok('a printer starts out fine', !row.trouble_since, row.trouble_since);
  ok('…and the dashboard has nothing to say about it',
    !(await dashPrinters()).some((p) => p.id === made.id));

  /* ---- somebody at the desk marks it ---- */
  let r = await req('POST', `/api/admin/printers/${made.id}/trouble`, { note: 'Out of labels' });
  ok('the desk can mark it as not printing', r.status === 200, JSON.stringify(r.data));

  row = (await printers()).find((p) => p.id === made.id);
  ok('…and it is recorded as such', !!row.trouble_since, JSON.stringify(row.trouble_since));
  /*
   * Who and what, because "the printer is broken" a day later is useless and
   * "Hank said it was out of labels at 09:40" is somebody's next five minutes.
   */
  ok('…with who said so', row.trouble_by === 'Test Owner', row.trouble_by);
  ok('…and what they said about it', row.trouble_note === 'Out of labels', row.trouble_note);

  ok('the dashboard shows it', (await dashPrinters()).some((p) => p.id === made.id));

  /*
   * The board is the screen the desk actually looks at, which is the whole
   * reason this is not left on the printers page.
   */
  await req('POST', '/api/admin/board/key', { enabled: true });
  const link = (await req('GET', '/api/admin/board/link')).data;
  const key = new URL(link.url).pathname.split('/').filter(Boolean).pop();
  const board = (await req('GET', `/api/board/${key}/data`)).data;
  ok('the on-site board shows it too',
    Array.isArray(board.printers_down) && board.printers_down.includes('Trouble Test Printer'),
    JSON.stringify(board.printers_down));
  /*
   * Names only. The board answers to anyone holding its address, and who
   * reported a fault is staff business rather than something to put on a wall.
   */
  ok('…by name alone, with nothing about who reported it',
    JSON.stringify(board).indexOf('Out of labels') === -1
    && JSON.stringify(board.printers_down) === JSON.stringify(['Trouble Test Printer']));

  /* ---- pressing it twice is not two faults ---- */
  r = await req('POST', `/api/admin/printers/${made.id}/trouble`, {});
  ok('marking it twice changes nothing and sends nothing',
    r.status === 200 && r.data.unchanged === true, JSON.stringify(r.data));
  ok('…and does not overwrite what the first report said',
    (await printers()).find((p) => p.id === made.id).trouble_note === 'Out of labels');

  /* ---- and only a person clears it ---- */
  r = await req('POST', `/api/admin/printers/${made.id}/working`);
  ok('the desk can mark it working again', r.status === 200, JSON.stringify(r.data));
  row = (await printers()).find((p) => p.id === made.id);
  ok('…and everything about the fault is cleared with it',
    !row.trouble_since && !row.trouble_by && !row.trouble_note, JSON.stringify(row).slice(0, 120));
  ok('…the dashboard drops it', !(await dashPrinters()).some((p) => p.id === made.id));
  ok('…and so does the board',
    !((await req('GET', `/api/board/${key}/data`)).data.printers_down || []).includes('Trouble Test Printer'));

  r = await req('POST', `/api/admin/printers/${made.id}/working`);
  ok('clearing an already-clear printer is a no-op rather than an error',
    r.status === 200 && r.data.unchanged === true, JSON.stringify(r.data));

  /*
   * ---- reception, who are the entire detection mechanism ----
   *
   * The whole feature rests on somebody at the desk noticing that labels have
   * stopped. Registering printers is configuration and stays administrative,
   * but if saying "this one has stopped" were administrative too, the one
   * group who can see the problem could not report it and the feature would
   * detect nothing at all. That is exactly how it first shipped.
   */
  const desk = { email: `desk-${Date.now()}@example.com`, password: 'Testing123!', name: 'Desk', role: 'reception' };
  const account = (await req('POST', '/api/admin/users', desk)).data;
  ok('a reception login can be created', !!(account && account.id), JSON.stringify(account).slice(0, 90));

  const owner = cookie;
  cookie = '';
  const login = await req('POST', '/api/admin/login', { email: desk.email, password: desk.password });
  ok('…and can sign in', login.status === 200, JSON.stringify(login.data).slice(0, 80));
  /*
   * An account made for somebody else starts on a temporary password and can
   * do nothing until it is changed — so the report below is being made by a
   * real, settled reception login rather than by a half-created one.
   */
  const chose = await req('POST', '/api/admin/me/password',
    { current: desk.password, password: 'chosen-by-the-desk-1' });
  ok('…once they have chosen their own password', chose.status === 200, JSON.stringify(chose.data).slice(0, 80));

  r = await req('POST', `/api/admin/printers/${made.id}/trouble`, { note: 'No labels coming out' });
  ok('reception can say a printer has stopped', r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);

  const seen = await req('GET', '/api/admin/dashboard');
  ok('…and the dashboard they are looking at shows it',
    (((seen.data || {}).health || {}).printers || []).some((p) => p.id === made.id));
  ok('…and offers them the printers they could report, since they cannot read the register',
    Array.isArray(((seen.data || {}).health || {}).printers_known),
    JSON.stringify(((seen.data || {}).health || {}).printers_known));

  r = await req('POST', `/api/admin/printers/${made.id}/working`);
  ok('reception can say it is working again', r.status === 200, String(r.status));

  /* But the printer register itself stays administrative. */
  r = await req('GET', '/api/admin/printers');
  ok('reception still cannot read the printer register', r.status === 403, String(r.status));
  r = await req('POST', '/api/admin/printers', { name: 'Sneaky' });
  ok('…nor register one', r.status === 403, String(r.status));
  r = await req('DELETE', `/api/admin/printers/${made.id}`);
  ok('…nor remove one', r.status === 403, String(r.status));

  cookie = owner;
  await req('DELETE', `/api/admin/users/${account.id}`);

  /* ---- a printer nobody registered ---- */
  r = await req('POST', '/api/admin/printers/999999/trouble', {});
  ok('marking a printer that does not exist is refused', r.status === 404, String(r.status));

  await req('DELETE', `/api/admin/printers/${made.id}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
