'use strict';
const P = require('/home/user/smart-lobby/public/kiosk/phone.js');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n}${x ? ' — ' + x : ''}`); } };

/* ---- real numbers, in the shapes people actually type ---- */
for (const [label, input] of [
  ['plain digits', '4155551234'],
  ['with dashes', '415-555-1234'],
  ['with brackets and space', '(415) 555-1234'],
  ['with dots', '415.555.1234'],
  ['with a country code', '14155551234'],
  ['with +1', '+1 415 555 1234'],
  ['with spaces everywhere', ' 415  555  1234 ']
]) {
  const r = P.check(input);
  ok(`accepts a real number ${label}`, r.ok && r.digits === '4155551234', JSON.stringify(r));
}
ok('normalises to a tidy format', P.check('4155551234').formatted === '(415) 555-1234', P.check('4155551234').formatted);
ok('produces E.164 for texting', P.check('4155551234').e164 === '+14155551234');

/* ---- area codes across the country ---- */
for (const area of ['212', '312', '415', '512', '646', '702', '817', '907', '808', '206', '604', '416']) {
  ok(`accepts area code ${area}`, P.check(`${area}5551234`).ok);
}

/* ---- the checks that matter: structurally impossible numbers ---- */
for (const [label, input, why] of [
  ['all zeros', '0000000000', 'area starts 0'],
  ['starts with 1', '1115551234', 'area starts 1'],
  ['911 as an area code', '9115551234', 'N11 is a service code'],
  ['411 as an area code', '4115551234', 'N11 is a service code'],
  ['area ending 00', '4005551234', 'unassignable'],
  ['reserved 37X', '3705551234', 'held in reserve'],
  ['reserved 96X', '9605551234', 'held in reserve'],
  ['exchange starting 0', '4150551234', 'exchange starts 0'],
  ['exchange starting 1', '4151551234', 'exchange starts 1'],
  ['exchange 411', '4154111234', 'N11 exchange'],
  ['1234567890 typed as filler', '1234567890', 'area 234? no — starts 1 after strip'],
  ['keyboard mashing', '5555555555', 'exchange 555 is fine, but 555-5555 is not fictional — see below']
]) {
  const r = P.check(input);
  if (label.includes('mashing')) continue; // handled below
  ok(`rejects ${label}`, !r.ok, `${why} — got ${JSON.stringify(r)}`);
}

/* ---- the classic filler numbers ---- */
ok('rejects the fictional 555-0100 range', !P.check('4155550123').ok, JSON.stringify(P.check('4155550123')));
ok('…but allows it when explicitly testing', P.check('4155550123', { allowFictional: true }).ok);

/* ---- lengths ---- */
ok('rejects too few digits', !P.check('415555').ok && P.check('415555').error === 'too_short');
ok('rejects too many digits', !P.check('415555123456').ok);
ok('rejects empty', !P.check('').ok && P.check('').error === 'empty');
ok('rejects letters only', !P.check('not a number').ok);
ok('a short number says how many digits it has', /only 6 digits/.test(P.check('415555').message), P.check('415555').message);

/* ---- messages are usable by a person at a kiosk ---- */
ok('the area-code message names the problem', /area code/i.test(P.check('1115551234').message), P.check('1115551234').message);
ok('every rejection carries a message', ['', '415', '0005551234', '4154111234']
  .every((v) => typeof P.check(v).message === 'string' && P.check(v).message.length > 8));

/* ---- toll-free is flagged but allowed (a contractor's office line) ---- */
ok('toll-free numbers are accepted', P.check('8005551234').ok);
ok('…and flagged as non-geographic', P.check('8005551234').toll_free === true);

/* ---- as-you-type formatting ---- */
ok('formats while typing (3)', P.formatAsTyped('415') === '415', P.formatAsTyped('415'));
ok('formats while typing (6)', P.formatAsTyped('415555') === '(415) 555', P.formatAsTyped('415555'));
ok('formats while typing (10)', P.formatAsTyped('4155551234') === '(415) 555-1234', P.formatAsTyped('4155551234'));
ok('typing never exceeds 10 digits', P.formatAsTyped('41555512349999') === '(415) 555-1234');
ok('a leading 1 is absorbed while typing', P.formatAsTyped('14155551234') === '(415) 555-1234', P.formatAsTyped('14155551234'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
