'use strict';
const A = require('/home/user/smart-lobby/public/kiosk/aamva.js');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n}${x ? ' — ' + x : ''}`); } };

// A modern AAMVA 2016 card (Texas), shape as produced by real scanners.
const TX = ['@', '', '', 'ANSI 636015090002DL00410288ZT03290015DLDAQ12345678',
  'DCSSMITH', 'DDEN', 'DACJOHN', 'DDFN', 'DADALLEN', 'DDGN', 'DCAC', 'DCBNONE', 'DCDNONE',
  'DBD08012022', 'DBB03151985', 'DBA03152030', 'DBC1', 'DAU070 in', 'DAYBRO',
  'DAG123 MAIN ST', 'DAIAUSTIN', 'DAJTX', 'DAK787010000  ', 'DCF12345678901234',
  'DCGUSA', 'DAW180', 'DCK1234567890', 'DDAF'].join('\n');

let r = A.parse(TX);
ok('Texas card parses', r.ok, JSON.stringify(r));
ok('name is title-cased first + last', r.name === 'John Smith', r.name);
ok('licence number read from DAQ', r.number === '12345678', r.number);
ok('state read from the header IIN', r.state === 'TX', r.state);

// California, different IIN, DAJ present too
const CA = ['@', 'ANSI 636014040002DL00410277ZC03180032DLDAQY1234567',
  'DCSGARCIA', 'DACMARIA', 'DADLUZ', 'DBB07041990', 'DAJCA', 'DAICALEXICO'].join('\n');
r = A.parse(CA);
ok('California card parses', r.ok && r.number === 'Y1234567' && r.state === 'CA', JSON.stringify(r));
ok('shouted names come back title-cased', r.name === 'Maria Garcia', r.name);

// Older card with a combined DAA name and no DCS/DAC
const OLD = ['@', 'ANSI 636000010102DL00390187ZV02260031DLDAQT64235789',
  'DAAPUBLIC,JOHN,QUINCY', 'DAJVA', 'DBB19770212'].join('\n');
r = A.parse(OLD);
ok('older combined-name card parses', r.ok, JSON.stringify(r));
ok('combined name splits LAST,FIRST', r.name === 'John Public', r.name);
ok('Virginia recognised from IIN 636000', r.state === 'VA', r.state);

// A card where the header IIN is unknown but DAJ names the state
const DAJ = ['@', 'ANSI 999999090002DL00410288ZZ03290015DLDAQP99887766',
  'DCSNGUYEN', 'DACLINH', 'DAJWA'].join('\n');
r = A.parse(DAJ);
ok('falls back to DAJ when the IIN is unknown', r.ok && r.state === 'WA', JSON.stringify(r));

// Truncation markers must not leak into the name
const TRUNC = ['@', 'ANSI 636035090002DL00410288ZI03290015DLDAQI55512345',
  "DCSO'BRIEN", 'DACPATRICK', 'DADNONE', 'DAJIL'].join('\n');
r = A.parse(TRUNC);
ok('NONE placeholders are dropped', r.ok && !/none/i.test(r.name), JSON.stringify(r));
ok('an apostrophe name capitalises correctly', r.name === "Patrick O'Brien", r.name);

// A Canadian licence (trucks cross the border)
const ON = ['@', 'ANSI 636012040002DL00410277ZO03180032DLDAQL1234-56789-01234',
  'DCSTREMBLAY', 'DACMARC', 'DAJON'].join('\n');
r = A.parse(ON);
ok('Ontario licence parses, number kept as issued', r.ok && r.number === 'L1234-56789-01234' && r.state === 'ON', JSON.stringify(r));

/* ---- things that must be refused, not guessed at ---- */
ok('empty input refused', A.parse('').ok === false);
ok('null refused', A.parse(null).ok === false);
ok('a QR code payload is refused', A.parse('https://example.com/some-qr').ok === false, JSON.stringify(A.parse('https://example.com/some-qr')));
ok('random text refused', A.parse('hello world this is not a licence').ok === false);
const NONUM = ['@', 'ANSI 636015090002DL00410288ZT03290015DL', 'DCSSMITH', 'DACJOHN', 'DAJTX'].join('\n');
ok('a licence with no number is refused', A.parse(NONUM).ok === false && A.parse(NONUM).error === 'no_licence_number', JSON.stringify(A.parse(NONUM)));
const NONAME = ['@', 'ANSI 636015090002DL00410288ZT03290015DLDAQ999', 'DAJTX'].join('\n');
ok('a licence with no name is refused', A.parse(NONAME).ok === false, JSON.stringify(A.parse(NONAME)));

/* ---- nothing beyond the three wanted fields is returned ---- */
r = A.parse(TX);
const keys = Object.keys(r).sort().join(',');
ok('only ok/name/number/state come back — no DOB or address', keys === 'name,number,ok,state', keys);
ok('the date of birth on the card is not returned', !JSON.stringify(r).includes('03151985'), JSON.stringify(r));
ok('the address on the card is not returned', !/MAIN ST/i.test(JSON.stringify(r)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
