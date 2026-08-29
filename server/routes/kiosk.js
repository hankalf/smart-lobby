'use strict';
const express = require('express');
const crypto = require('crypto');
const { all, get, run, nowISO } = require('../db');
const settings = require('../settings');
const files = require('../files');
const notify = require('../notify');
const accessCtl = require('../access');
const { nextBadgeNo } = require('../badges');
const companies = require('../companies');
const compliance = require('../compliance');
const localtime = require('../localtime');
const devices = require('../devices');
const phoneRules = require('../../public/kiosk/phone');
const ratelimit = require('../ratelimit');

const router = express.Router();

const clean = (v) => (typeof v === 'string' ? v.trim() : v);
const normPhone = (p) => String(p || '').replace(/[^\d+]/g, '');
const lower = (s) => String(s || '').trim().toLowerCase();

// Stored numbers may contain spaces, dashes or brackets; compare on digits only.
const PHONE_NORM_SQL = "replace(replace(replace(replace(phone, char(32), ''), '-', ''), '(', ''), ')', '')";

/** Every active deck assigned to this visitor type, in every language. */
function slideshowsFor(visitType) {
  return all('SELECT * FROM slideshows WHERE active = 1 ORDER BY id').filter((s) => {
    let list = [];
    try { list = JSON.parse(s.required_for); } catch { list = []; }
    return !list.length || list.includes(visitType);
  });
}

/**
 * The deck to show: the one in the language on the kiosk's screen, the English
 * one when no translation has been uploaded, and whatever exists as a last
 * resort — a site with only a Spanish deck still shows it to everyone.
 */
function activeSlideshowFor(visitType, language) {
  const shows = slideshowsFor(visitType);
  return shows.find((s) => (s.language || 'en') === (language === 'es' ? 'es' : 'en'))
    || shows.find((s) => (s.language || 'en') === 'en')
    || shows[0] || null;
}

function slidesFor(showId) {
  return all('SELECT id, position, kind, image_path, html, caption FROM slides WHERE slideshow_id = ? ORDER BY position, id', showId);
}

/** Has this person already seen the current version of the induction? */
function inductionStatus(visitor, visitType, language) {
  const cfg = settings.getSection('induction');
  if (!cfg.enabled) return { required: false, slideshow: null };
  const show = activeSlideshowFor(visitType, language);
  if (!show) return { required: false, slideshow: null };
  const slides = slidesFor(show.id);
  if (!slides.length) return { required: false, slideshow: null };

  /*
   * "Already watched" counts a completion of the deck in either language: the
   * English and Spanish uploads are the same induction, and someone who sat
   * through one is not made to sit through its translation. Each variant is
   * checked against its own current version, so bumping one still brings
   * everyone who watched it back in.
   */
  let required = true;
  if (visitor && !cfg.show_to_returning_visitors) {
    const variants = slideshowsFor(visitType).filter((s) => slidesFor(s.id).length);
    for (const variant of variants) {
      const seen = get(`SELECT * FROM slide_views WHERE visitor_id = ? AND slideshow_id = ? AND completed_at IS NOT NULL
                        ORDER BY completed_at DESC LIMIT 1`, visitor.id, variant.id);
      if (!seen || Number(seen.slideshow_version) !== Number(variant.version)) continue;
      const repeatDays = Number(variant.repeat_after_days || cfg.repeat_after_days || 0);
      const ageDays = (Date.now() - new Date(seen.completed_at).getTime()) / 864e5;
      if (!repeatDays || ageDays < repeatDays) { required = false; break; }
    }
  }
  return {
    required,
    slideshow: required ? { ...show, slides, required_for: undefined } : { id: show.id, version: show.version, name: show.name }
  };
}

/** Every active document assigned to this category, in the order they were created. */
function agreementsFor(visitType) {
  return all('SELECT * FROM agreements WHERE active = 1 ORDER BY id').filter((a) => {
    let list = [];
    try { list = JSON.parse(a.required_for); } catch { list = []; }
    return !list.length || list.includes(visitType);
  });
}

const activeAgreementFor = (visitType) => agreementsFor(visitType)[0] || null;

/**
 * The documents this particular person still has to sign, mirroring how the
 * decks repeat: a document set to every visit is always due; one set to "once"
 * is due until they have signed the current version — editing the wording bumps
 * the version, so a changed document comes back to everyone; one set to N days
 * is due again once their newest signature of the current version is older
 * than that. Someone the kiosk cannot identify signs everything, which is also
 * what happens offline.
 */
function agreementsDueFor(visitor, visitType) {
  const docs = agreementsFor(visitType);
  if (!visitor) return docs;
  return docs.filter((a) => {
    const days = a.repeat_after_days;
    if (days === null || days === undefined) return true; // every visit
    const signed = get(
      `SELECT sg.signed_at FROM signatures sg JOIN visits v ON v.id = sg.visit_id
       WHERE v.visitor_id = ? AND sg.agreement_id = ? AND sg.agreement_version = ?
       ORDER BY sg.signed_at DESC LIMIT 1`,
      visitor.id, a.id, a.version);
    if (!signed) return true;
    if (Number(days) === 0) return false; // once per version
    return (Date.now() - new Date(signed.signed_at).getTime()) / 864e5 >= Number(days);
  });
}

function defaultSite() {
  return get('SELECT * FROM sites WHERE active = 1 ORDER BY id LIMIT 1');
}

/*
 * These endpoints answer to anyone, because an iPad in a lobby cannot hold a
 * secret. The limits are set well above what a real site produces — a lookup
 * happens once per sign-in, and a busy gate might see one a minute — but far
 * below what walking a range of phone numbers to harvest names would need.
 * Several tablets at one site share a public address, hence the headroom.
 *
 * The heartbeat is deliberately not limited: every device makes one a minute,
 * and throttling it would blind the dashboard rather than stop an attacker.
 */
const lookupLimit = ratelimit.limit({
  name: 'kiosk-lookup', windowMs: 60000, max: 30,
  message: 'Too many attempts from this network. Please wait a moment, or ask reception.'
});
const searchLimit = ratelimit.limit({
  name: 'kiosk-search', windowMs: 60000, max: 40,
  message: 'Too many searches from this network. Please wait a moment, or ask reception.'
});
const writeLimit = ratelimit.limit({
  // Ninety a minute is a sign-in every two-thirds of a second across the whole
  // site — beyond any real shift change, including several tablets behind one
  // address — while still bounding what a flood can write to disk.
  name: 'kiosk-write', windowMs: 60000, max: 90,
  message: 'Too many sign-ins from this network. Please wait a moment, or ask reception.'
});

/* ---------------------------------------------------------------- config */

router.get('/config', (req, res) => {
  const site = defaultSite();
  const pub = settings.publicSettings();
  const agreements = all(`SELECT id, name, name_es, body, body_es, pages, pages_es, render_mode, render_mode_es,
                                 version, required_for, questions, require_signature, repeat_after_days
                          FROM agreements WHERE active = 1`);
  const inductions = all('SELECT id, name, version, required_for FROM slideshows WHERE active = 1');
  res.json({
    ...pub,
    site,
    sites: all('SELECT id, name FROM sites WHERE active = 1 ORDER BY name'),
    // Both wordings go down, so switching language on the kiosk does not need
    // another round trip to the server.
    projects: all('SELECT id, name, name_es, code FROM projects WHERE active = 1 ORDER BY name'),
    agreements,
    // The active decks, slides and all: with these and the agreements above the
    // kiosk can run a complete sign-in with the connection down.
    decks: all(`SELECT id, name, language, required_for, version, min_seconds_per_slide, repeat_after_days,
                       require_signature
                FROM slideshows WHERE active = 1 ORDER BY id`)
      .map((s) => ({ ...s, slides: slidesFor(s.id) }))
      .filter((s) => s.slides.length),
    has_induction: inductions.length > 0,
    onsite_count: accessCtl.occupancy(site ? site.id : null),
    access_points: pub.access.unlock_button_on_kiosk
      ? all('SELECT id, name FROM access_points WHERE enabled = 1 ORDER BY name')
      : [],
    config_rev: settings.configRev(),
    server_time: nowISO()
  });
});

router.get('/staff', searchLimit, (req, res) => {
  const q = lower(req.query.q);
  const rows = q
    ? all(`SELECT id, name, department FROM hosts WHERE active = 1 AND (lower(name) LIKE ? OR lower(department) LIKE ?)
           ORDER BY name LIMIT 50`, `%${q}%`, `%${q}%`)
    : all('SELECT id, name, department FROM hosts WHERE active = 1 ORDER BY name LIMIT 200');
  res.json(rows);
});



/*
 * Picking yourself from a list of people who share a phone number.
 *
 * The kiosk has to be able to say "this one, of the three you just showed me",
 * and that means an endpoint that takes a visitor id. Left open, that endpoint
 * is the whole visitor table: ask for id 1, 2, 3 and read off every name,
 * company and number. So the choice list is signed when it is handed out, and
 * only the ids in a signed, unexpired list can be asked about.
 */
const CHOICE_KEY = crypto.randomBytes(32);
const CHOICE_TTL_MS = 5 * 60 * 1000;

function choiceToken(ids) {
  const expires = Date.now() + CHOICE_TTL_MS;
  const body = `${ids.slice().sort((a, b) => a - b).join(',')}.${expires}`;
  return `${expires}.${crypto.createHmac('sha256', CHOICE_KEY).update(body).digest('hex').slice(0, 32)}`;
}

/**
 * Was `id` one of the people this token was issued for, and is it still fresh?
 * The caller sends back the list it was given; the signature is what makes that
 * list trustworthy, so a list nobody was offered cannot be presented.
 */
function choiceAllows(token, ids, id) {
  const [expires, mac] = String(token || '').split('.');
  if (!expires || !mac || !Number(expires) || Number(expires) < Date.now()) return false;
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isFinite);
  if (!list.includes(Number(id))) return false;
  const body = `${list.slice().sort((a, b) => a - b).join(',')}.${expires}`;
  const expected = crypto.createHmac('sha256', CHOICE_KEY).update(body).digest('hex').slice(0, 32);
  if (mac.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected));
}

/* --------------------------------------------------------------- lookup */

router.post('/lookup', lookupLimit, (req, res) => {
  const phone = normPhone(req.body.phone);
  const email = lower(req.body.email);
  const visitType = clean(req.body.visit_type) || 'visitor';
  const name = lower(req.body.name);

  /*
   * Looking someone up by name is a search of everyone who has ever visited, on a
   * screen anyone can walk up to. It is deliberately narrow: at least three
   * characters, a handful of results, and only a name and company come back —
   * never a phone number or email, which are what the search is meant to save
   * them typing.
   */
  if (name) {
    if (!settings.getSection('kiosk').lookup_by_name) return res.json({ found: false, matches: [] });
    if (name.length < 3) return res.json({ found: false, matches: [], too_short: true });
    const matches = all(
      `SELECT id, full_name, company FROM visitors
       WHERE blocked = 0 AND lower(full_name) LIKE ?
       ORDER BY last_visit_at DESC LIMIT 8`, `%${name}%`);
    return res.json({ found: false, choice_token: choiceToken(matches.map((m) => m.id)), matches });
  }

  /*
   * A whole crew often shares one phone — the site phone, the foreman's. Picking
   * "the first" record for it would greet the wrong person, skip an induction
   * the newcomer has never seen, and at sign-in overwrite somebody else's name.
   * So a number several people share comes back as a question, not a match:
   * the kiosk shows the names and asks which of them they are.
   */
  let visitor = null;
  if (phone && phone.length >= 6) {
    const sharing = all(`SELECT * FROM visitors WHERE ${PHONE_NORM_SQL} = ? ORDER BY last_visit_at DESC LIMIT 8`, phone);
    const allowed = sharing.filter((v) => !v.blocked);
    if (sharing.length && !allowed.length) return res.status(403).json({ found: true, blocked: true, message: 'Please see reception.' });
    if (allowed.length > 1) {
      return res.json({ found: false, multiple: true,
        choice_token: choiceToken(allowed.map((v) => v.id)),
        matches: allowed.map((v) => ({ id: v.id, full_name: v.full_name, company: v.company })) });
    }
    visitor = allowed[0] || null;
  }
  if (!visitor && email) {
    const sharing = all('SELECT * FROM visitors WHERE lower(email) = ? ORDER BY last_visit_at DESC LIMIT 8', email);
    const allowed = sharing.filter((v) => !v.blocked);
    if (sharing.length && !allowed.length) return res.status(403).json({ found: true, blocked: true, message: 'Please see reception.' });
    if (allowed.length > 1) {
      return res.json({ found: false, multiple: true,
        choice_token: choiceToken(allowed.map((v) => v.id)),
        matches: allowed.map((v) => ({ id: v.id, full_name: v.full_name, company: v.company })) });
    }
    visitor = allowed[0] || null;
  }
  /*
   * Only reachable with a token from a choice list this caller was just given,
   * and only for the people on it. Without that, an id is not enough to learn
   * anything: the request is refused rather than answered with somebody's
   * details.
   */
  if (!visitor && req.body.visitor_id) {
    const wanted = Number(req.body.visitor_id);
    if (!choiceAllows(req.body.choice_token, req.body.choice_ids, wanted)) {
      return res.status(403).json({ error: 'choice_expired', message: 'Please enter your details again.' });
    }
    visitor = get('SELECT * FROM visitors WHERE id = ?', wanted);
  }

  const lang = req.body.language === 'es' ? 'es' : 'en';
  if (!visitor) return res.json({ found: false, induction: inductionStatus(null, visitType, lang) });
  if (visitor.blocked) return res.status(403).json({ found: true, blocked: true, message: 'Please see reception.' });

  const openVisit = get("SELECT id, signed_in_at FROM visits WHERE visitor_id = ? AND status = 'onsite' ORDER BY id DESC LIMIT 1", visitor.id);
  res.json({
    found: true,
    visitor: {
      id: visitor.id,
      full_name: visitor.full_name,
      company: visitor.company,
      email: visitor.email,
      phone: visitor.phone,
      visit_count: visitor.visit_count,
      last_visit_at: visitor.last_visit_at
    },
    already_onsite: openVisit || null,
    induction: inductionStatus(visitor, visitType, lang)
  });
});

router.post('/induction', (req, res) => {
  const visitType = clean(req.body.visit_type) || 'visitor';
  const visitorId = req.body.visitor_id ? Number(req.body.visitor_id) : null;
  const visitor = visitorId ? get('SELECT * FROM visitors WHERE id = ?', visitorId) : null;
  res.json(inductionStatus(visitor, visitType, req.body.language === 'es' ? 'es' : 'en'));
});

router.get('/agreement/:visitType', (req, res) => {
  res.json(activeAgreementFor(req.params.visitType) || null);
});

router.get('/agreements/:visitType', (req, res) => {
  // With a visitor_id, only what that person is actually due to sign comes
  // back; without one (a new face, or before lookup) it is the full set.
  const visitor = req.query.visitor_id ? get('SELECT * FROM visitors WHERE id = ?', Number(req.query.visitor_id)) : null;
  res.json(agreementsDueFor(visitor, req.params.visitType));
});

/* --------------------------------------------------------------- sign in */

router.post('/signin', writeLimit, async (req, res) => {
  try {
    const b = req.body || {};
    const kiosk = settings.getSection('kiosk');
    const fullName = clean(b.full_name);
    if (!fullName) return res.status(400).json({ error: 'name_required' });

    const visitType = clean(b.visit_type) || 'visitor';
    const phone = normPhone(b.phone);
    const email = lower(b.email);

    // Which fields this visitor type must supply is configured per type.
    const fields = settings.fieldsFor(visitType);
    if (fields.phone === 'required' && !phone) return res.status(400).json({ error: 'phone_required' });
    /*
     * The same check the kiosk makes, applied again here: the tablet is not
     * trusted, and a queued sign-in from an old app version must not slip an
     * impossible number past. Only where the numbering plan applies.
     */
    const country = String(settings.getSection('org').phone_country || 'US').toUpperCase();
    if (phone && (country === 'US' || country === 'CA')) {
      const seen = phoneRules.check(phone, { allowFictional: process.env.NODE_ENV !== 'production' });
      if (!seen.ok) return res.status(400).json({ error: 'bad_phone', message: seen.message });
    }
    if (fields.email === 'required' && !email) return res.status(400).json({ error: 'email_required' });
    if (fields.staff === 'required' && !b.host_id) return res.status(400).json({ error: 'host_required' });
    if (fields.company === 'required' && !clean(b.company)) return res.status(400).json({ error: 'company_required' });
    if (fields.vehicle === 'required' && !clean(b.vehicle_reg)) return res.status(400).json({ error: 'vehicle_required' });
    if (fields.reference === 'required' && !clean(b.reference)) return res.status(400).json({ error: 'reference_required' });
    if (fields.movement === 'required' && !clean(b.movement)) return res.status(400).json({ error: 'movement_required' });

    /*
     * A project has to be one of the live ones, not whatever id was posted:
     * this is an unauthenticated endpoint, and a closed job must not quietly
     * gain someone on site.
     */
    let project = null;
    if (fields.project !== 'off' && b.project_id) {
      project = get('SELECT * FROM projects WHERE id = ? AND active = 1', Number(b.project_id));
      if (!project) return res.status(400).json({ error: 'unknown_project' });
    }
    if (fields.project === 'required' && !project) return res.status(400).json({ error: 'project_required' });

    const language = b.language === 'es' ? 'es' : 'en';

    /*
     * What the kiosk read off a licence. The kiosk does the decoding — it has
     * to, to show the visitor what it read — so these arrive already parsed,
     * and are taken as three plain strings and nothing more: capped, stripped
     * of control characters, and never used to look anyone up. A licence scan
     * that failed simply leaves them empty rather than blocking the sign-in.
     */
    const idField = (v, max) => {
      // Control characters only: a name keeps its spaces, a number its hyphens.
      const s = String(v == null ? '' : v).replace(/[\x00-\x1f]/g, '').trim().slice(0, max);
      return s || null;
    };
    const idName = fields.id_scan === 'off' ? null : idField(b.id_name, 120);
    const idNumber = fields.id_scan === 'off' ? null : idField(b.id_number, 40);
    const idState = fields.id_scan === 'off' ? null
      : (idField(b.id_state, 2) || '').toUpperCase().replace(/[^A-Z]/g, '') || null;
    if (fields.id_scan === 'required' && !idNumber) return res.status(400).json({ error: 'id_scan_required' });

    /*
     * A sign-in queued on the kiosk while the connection was down is retried
     * until it lands, so its reference must make it land exactly once — the
     * retry whose response was lost must not become a second visit.
     */
    const clientRef = clean(b.client_ref) ? String(clean(b.client_ref)).slice(0, 64) : null;
    if (clientRef) {
      const dup = get('SELECT id, checkout_code FROM visits WHERE client_ref = ?', clientRef);
      if (dup) {
        const visit = get(`SELECT v.*, p.full_name, p.company, h.name AS host_name, s.name AS site_name,
                                  j.name AS project_name, j.name_es AS project_name_es
                           FROM visits v JOIN visitors p ON p.id = v.visitor_id
                           LEFT JOIN hosts h ON h.id = v.host_id LEFT JOIN sites s ON s.id = v.site_id
                           LEFT JOIN projects j ON j.id = v.project_id WHERE v.id = ?`, dup.id);
        return res.json({ ok: true, duplicate: true, visit, badge: null, checkout_code: dup.checkout_code });
      }
    }

    // A queued sign-in carries the moment it actually happened; a time that is
    // implausible — in the future, or older than the queue could be — is
    // ignored rather than trusted.
    let signedInAt = nowISO();
    const queuedAt = b.queued_at ? new Date(b.queued_at) : null;
    if (queuedAt && !Number.isNaN(queuedAt.getTime())
        && queuedAt.getTime() < Date.now() && Date.now() - queuedAt.getTime() < 48 * 3600e3) {
      signedInAt = queuedAt.toISOString();
    }

    const site = b.site_id ? get('SELECT * FROM sites WHERE id = ?', Number(b.site_id)) : defaultSite();

    /*
     * Sign-in updates the matched record — including its name — so a phone or
     * email match must never guess. A returning visitor who picked themselves
     * arrives with their visitor_id; without one, a number or address only
     * matches the record carrying the name just typed, and anyone else on a
     * shared number becomes a new visitor rather than silently becoming
     * somebody else.
     */
    const matchAmong = (rows) => rows.find((v) => lower(v.full_name) === lower(fullName)) || null;
    let visitor = b.visitor_id ? get('SELECT * FROM visitors WHERE id = ?', Number(b.visitor_id)) : null;
    if (!visitor && phone) visitor = matchAmong(all(`SELECT * FROM visitors WHERE ${PHONE_NORM_SQL} = ?`, phone));
    if (!visitor && email) visitor = matchAmong(all('SELECT * FROM visitors WHERE lower(email) = ?', email));
    if (visitor && visitor.blocked) return res.status(403).json({ error: 'blocked', message: 'Please see reception.' });

    const photoPath = files.saveDataUrl(b.photo, 'private', 'photos');

    /*
     * The firm they typed, matched to a record rather than kept as loose text
     * — so a name already on file is reused whatever the capitals, and a
     * correction made later reaches this visit too.
     */
    const company = companies.resolve(b.company);
    const companyName = company ? company.name : (clean(b.company) || null);
    if (company && company.blocked) {
      return res.status(403).json({ error: 'blocked', message: 'Please see reception.' });
    }

    if (visitor) {
      run(`UPDATE visitors SET full_name = ?, company = COALESCE(?, company), email = COALESCE(?, email),
             phone = COALESCE(?, phone), photo_path = COALESCE(?, photo_path),
             visit_count = visit_count + 1, last_visit_at = ? WHERE id = ?`,
        fullName, companyName, email || null, phone || null, photoPath, nowISO(), visitor.id);
      if (company) run('UPDATE visitors SET company_id = ? WHERE id = ?', company.id, visitor.id);
    } else {
      const r = run(`INSERT INTO visitors (full_name, company, email, phone, photo_path, visit_count, last_visit_at, created_at)
                     VALUES (?,?,?,?,?,1,?,?)`,
        fullName, companyName, email || null, phone || null, photoPath, nowISO(), nowISO());
      visitor = get('SELECT * FROM visitors WHERE id = ?', r.lastInsertRowid);
      if (company) run('UPDATE visitors SET company_id = ? WHERE id = ?', company.id, visitor.id);
    }

    /*
     * The paperwork. Checked after the visitor and company are known, since a
     * firm's insurance covers its people and a person's own card covers only
     * them. Whether a lapse closes the gate or merely says so at the desk is
     * the site's decision, not this one's.
     */
    const papers = compliance.check(visitType, {
      visitorId: visitor.id, companyId: company ? company.id : null
    });
    if (papers.blocking) {
      return res.status(403).json({
        error: 'compliance', detail: compliance.explain(papers),
        message: 'Please see reception before signing in.'
      });
    }

    const badgeCfg = settings.getSection('badge');
    const badgeNo = badgeCfg.enabled ? nextBadgeNo(localtime.today(), visitType) : null;
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();

    // Which entrance or area they signed in at, taken from the kiosk itself.
    const device = b.device_id ? get('SELECT * FROM devices WHERE id = ?', Number(b.device_id)) : null;

    let visitRes;
    try {
      visitRes = run(`INSERT INTO visits
        (site_id, visitor_id, host_id, visit_type, purpose, vehicle_reg, badge_no, checkout_code, photo_path,
         induction_shown, signed_in_at, status, device_id, location_id, reference, movement, project_id,
         language, client_ref, id_name, id_number, id_state, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'onsite',?,?,?,?,?,?,?,?,?,?,?)`,
        site ? site.id : null, visitor.id, b.host_id ? Number(b.host_id) : null, visitType,
        clean(b.purpose) || null, (clean(b.vehicle_reg) || '').toUpperCase() || null, badgeNo, code, photoPath,
        b.induction_completed ? 1 : 0, signedInAt, device ? device.id : null,
        device ? device.location_id : null, clean(b.reference) || null, clean(b.movement) || null,
        project ? project.id : null, language, clientRef, idName, idNumber, idState, nowISO());
    } catch (err) {
      /*
       * Two retries of the same queued sign-in racing each other: the earlier
       * SELECT saw nothing for either, and the unique index on client_ref
       * stopped the second insert. Answer it as the duplicate it is.
       */
      if (clientRef && /UNIQUE.*client_ref|client_ref.*UNIQUE/i.test(String(err.message))) {
        const dup = get('SELECT id, checkout_code FROM visits WHERE client_ref = ?', clientRef);
        if (dup) {
          const visit = get(`SELECT v.*, p.full_name, p.company FROM visits v
                             JOIN visitors p ON p.id = v.visitor_id WHERE v.id = ?`, dup.id);
          return res.json({ ok: true, duplicate: true, visit, badge: null, checkout_code: dup.checkout_code });
        }
      }
      throw err;
    }
    const visitId = Number(visitRes.lastInsertRowid);

    // One row per document signed, each with the answers given to its questions.
    // Capped: each entry writes a signature image, and the array arrives from an
    // unauthenticated caller. No sign-in legitimately signs more than a handful.
    const signed = Array.isArray(b.documents) && b.documents.length
      ? b.documents.slice(0, 20)
      : (b.signature || b.answers ? [{ agreement_id: b.agreement_id, signature: b.signature, answers: b.answers }] : []);

    for (const doc of signed) {
      const agreement = doc.agreement_id
        ? get('SELECT * FROM agreements WHERE id = ?', Number(doc.agreement_id))
        : activeAgreementFor(visitType);
      const sigPath = files.saveDataUrl(doc.signature, 'private', 'signatures');
      const answers = doc.answers && typeof doc.answers === 'object' ? JSON.stringify(doc.answers) : null;
      // The language goes on the signature as well as the visit: it records
      // which wording of the document this particular name was signed against.
      run(`INSERT INTO signatures (visit_id, agreement_id, agreement_version, signed_name, signature_path, answers,
                                   language, signed_at)
           VALUES (?,?,?,?,?,?,?,?)`,
        visitId, agreement ? agreement.id : null, agreement ? agreement.version : null, fullName, sigPath, answers,
        language, nowISO());
    }

    // Induction completion
    if (b.induction_completed && b.slideshow_id) {
      const show = get('SELECT * FROM slideshows WHERE id = ?', Number(b.slideshow_id));
      if (show) {
        // Kept with the completion record, so "who signed off the induction and
        // when" is one row, the same shape as a signed document.
        const inductionSig = files.saveDataUrl(b.induction_signature, 'private', 'signatures');
        run(`INSERT INTO slide_views (visit_id, visitor_id, slideshow_id, slideshow_version, started_at, completed_at,
                                      seconds, signature_path)
             VALUES (?,?,?,?,?,?,?,?)`,
          visitId, visitor.id, show.id, show.version, b.induction_started_at || nowISO(), nowISO(),
          Number(b.induction_seconds) || null, inductionSig);
        run('UPDATE visitors SET induction_slideshow_id = ?, induction_version = ?, induction_completed_at = ? WHERE id = ?',
          show.id, show.version, nowISO(), visitor.id);
      }
    }

    const visit = get(`SELECT v.*, p.full_name, p.company, h.name AS host_name, s.name AS site_name,
                              j.name AS project_name, j.name_es AS project_name_es
                       FROM visits v JOIN visitors p ON p.id = v.visitor_id
                       LEFT JOIN hosts h ON h.id = v.host_id LEFT JOIN sites s ON s.id = v.site_id
                       LEFT JOIN projects j ON j.id = v.project_id
                       WHERE v.id = ?`, visitId);

    notify.notifyArrival(visitId).catch(() => {});
    // A separate post, off by default: on a busy gate it doubles the traffic,
    // but it is the one a safety officer wants — the briefing on record.
    if (b.induction_completed && b.slideshow_id) notify.notifyInduction(visitId).catch(() => {});
    if (settings.getSection('access').unlock_on_signin) {
      accessCtl.autoUnlock('signin', { visitId, actor: fullName, siteId: site ? site.id : null }).catch(() => {});
    }

    res.json({
      ok: true, visit, badge: badgeCfg.enabled ? { ...badgeCfg, badge_no: badgeNo } : null, checkout_code: code,
      // Signed in, but with something out of date the desk should chase.
      compliance: papers.ok ? null : { detail: compliance.explain(papers) }
    });
  } catch (err) {
    res.status(500).json({ error: 'signin_failed', detail: String(err.message || err) });
  }
});

/* -------------------------------------------------------------- sign out */

/*
 * Visitor photos live behind the admin login. To show a face in the sign-out
 * list without opening that up, each search result carries a short-lived signed
 * link: it only works for that visit, only while they are on site, and only for
 * a few minutes after the search that produced it. The key is per-process, so
 * links do not survive a restart either.
 */
const PHOTO_KEY = crypto.randomBytes(32);
const PHOTO_TTL_MS = 5 * 60 * 1000;

function photoToken(visitId) {
  const expires = Date.now() + PHOTO_TTL_MS;
  const mac = crypto.createHmac('sha256', PHOTO_KEY).update(`${visitId}.${expires}`).digest('hex').slice(0, 32);
  return `${expires}.${mac}`;
}

function photoTokenValid(visitId, token) {
  const [expires, mac] = String(token || '').split('.');
  if (!expires || !mac || !Number(expires) || Number(expires) < Date.now()) return false;
  const expected = crypto.createHmac('sha256', PHOTO_KEY).update(`${visitId}.${expires}`).digest('hex').slice(0, 32);
  // timingSafeEqual throws on a length mismatch, so check that first.
  if (mac.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected));
}

router.get('/visit-photo/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!photoTokenValid(id, req.query.t)) return res.status(403).end();
  const visit = get("SELECT photo_path FROM visits WHERE id = ? AND status = 'onsite'", id);
  if (!visit || !visit.photo_path) return res.status(404).end();
  const abs = files.absoluteFor(visit.photo_path);
  if (!abs) return res.status(404).end();
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.sendFile(abs);
});

/*
 * "Hide names on the sign-out list" is a real setting a site can turn on: with
 * it, somebody signing out sees only enough to recognise their own entry, and a
 * passer-by learns nothing about who else is in the building.
 */
const withPhotos = (rows) => {
  const hide = !!settings.getSection('privacy').hide_names_on_signout_list;
  return rows.map((r) => ({
    id: r.id,
    signed_in_at: r.signed_in_at,
    full_name: hide ? maskName(r.full_name) : r.full_name,
    company: hide ? null : r.company,
    host_name: hide ? null : r.host_name,
    photo_url: (!hide && r.photo_path) ? `/api/kiosk/visit-photo/${r.id}?t=${photoToken(r.id)}` : null
  }));
};

/** "Jordan Fletcher" -> "Jordan F." — their own row is recognisable, others are not. */
function maskName(name) {
  const parts = String(name || '').trim().split(/\s+/);
  if (parts.length < 2) return parts[0] || '';
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

router.post('/signout/search', searchLimit, (req, res) => {
  const q = lower(req.body.q);
  const code = String(req.body.code || '').trim().toUpperCase();
  if (code) {
    const v = get(`SELECT v.id, v.signed_in_at, v.photo_path, p.full_name, p.company, h.name AS host_name
                   FROM visits v JOIN visitors p ON p.id = v.visitor_id LEFT JOIN hosts h ON h.id = v.host_id
                   WHERE v.checkout_code = ? AND v.status = 'onsite'`, code);
    return res.json(withPhotos(v ? [v] : []));
  }
  /*
   * Two or fewer characters would list most of the building, which is the whole
   * on-site roster — names, hosts and faces — to anyone who can reach the
   * kiosk. Three characters, matched from the start of a name or number, is
   * enough for somebody signing themselves out and useless for browsing.
   */
  if (!q || q.length < 3) return res.json([]);
  const digits = normPhone(q);
  res.json(withPhotos(all(
    `SELECT v.id, v.signed_in_at, v.photo_path, p.full_name, p.company, h.name AS host_name
     FROM visits v JOIN visitors p ON p.id = v.visitor_id LEFT JOIN hosts h ON h.id = v.host_id
     WHERE v.status = 'onsite' AND (lower(p.full_name) LIKE ? OR lower(p.full_name) LIKE ?
                                    OR ${PHONE_NORM_SQL.replace(/phone/g, 'p.phone')} LIKE ?)
     ORDER BY v.signed_in_at DESC LIMIT 25`, `${q}%`, `% ${q}%`, `${digits || q}%`)));
});

router.post('/signout', writeLimit, async (req, res) => {
  const id = Number(req.body.visit_id);
  const visit = get("SELECT * FROM visits WHERE id = ? AND status = 'onsite'", id);
  if (!visit) return res.status(404).json({ error: 'not_found' });
  run("UPDATE visits SET signed_out_at = ?, status = 'out', signed_out_by = ? WHERE id = ?", nowISO(), 'kiosk', id);
  notify.notifyDeparture(id).catch(() => {});
  // Gated, like sign-in: an unauthenticated request must not be able to
  // release a door simply because somebody was marked as leaving.
  if (settings.getSection('access').unlock_on_signout) {
    accessCtl.autoUnlock('signout', { visitId: id, actor: 'kiosk', siteId: visit.site_id }).catch(() => {});
  }
  res.json({ ok: true, goodbye: settings.getSection('org').goodbye_message });
});

/* ------------------------------------------------------------ deliveries */

/**
 * How many parcels, as a number that can be printed on a card.
 *
 * `Number(x) || 1` let a negative through, because -5 is truthy — so a
 * delivery could be booked in as minus five parcels and say so on the Teams
 * card and the deliveries page.
 */
function parcelCount(raw) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, 999);
}

router.post('/delivery', async (req, res) => {
  const cfg = settings.getSection('deliveries');
  if (!cfg.enabled) return res.status(403).json({ error: 'deliveries_disabled' });
  const b = req.body || {};
  if (cfg.require_recipient && !b.recipient_host_id && !clean(b.recipient_text)) {
    return res.status(400).json({ error: 'recipient_required' });
  }
  /*
   * A photo of the parcel is the evidence when somebody says theirs never
   * arrived. The setting has always defaulted to on and was never checked
   * anywhere, so a delivery could be booked in without one and the site would
   * only find out when it mattered.
   */
  if (cfg.require_photo && !String(b.photo || '').startsWith('data:image/')) {
    return res.status(400).json({ error: 'photo_required', message: 'Please take a photo of the parcel.' });
  }
  const site = defaultSite();
  const photo = files.saveDataUrl(b.photo, 'private', 'parcels');
  const r = run(`INSERT INTO deliveries (site_id, courier_name, courier_company, recipient_host_id, recipient_text,
                   tracking, parcel_count, photo_path, notes, status, received_at)
                 VALUES (?,?,?,?,?,?,?,?,?, 'awaiting', ?)`,
    site ? site.id : null, clean(b.courier_name) || null, clean(b.courier_company) || null,
    b.recipient_host_id ? Number(b.recipient_host_id) : null, clean(b.recipient_text) || null,
    clean(b.tracking) || null, parcelCount(b.parcel_count), photo, clean(b.notes) || null, nowISO());
  const id = Number(r.lastInsertRowid);
  if (cfg.notify_recipient) notify.notifyDelivery(id).catch(() => {});
  res.json({ ok: true, id });
});

/* ---------------------------------------------------------------- access */

router.post('/unlock', async (req, res) => {
  const cfg = settings.getSection('access');
  if (!cfg.enabled || !cfg.unlock_button_on_kiosk) return res.status(403).json({ error: 'disabled' });
  const result = await accessCtl.trigger(Number(req.body.access_point_id), { actor: 'kiosk', source: 'kiosk_button' });
  res.json(result);
});

/* ------------------------------------------------------------ heartbeat */

router.post('/ping', (req, res) => {
  const rev = settings.configRev();
  // A tablet says which one it is by its address — /kiosk/north-gate — or, for
  // links handed out before device pages existed, by its token.
  const slug = String(req.body.slug || '');
  const token = String(req.body.token || '');
  const device = devices.resolve({ slug, token });

  if (device) {
    // The kiosk reports the cameras it can see so they can be chosen in the dashboard.
    const cameras = Array.isArray(req.body.cameras)
      ? JSON.stringify(req.body.cameras.slice(0, 8).map((c) => ({
          id: String(c.id || '').slice(0, 120),
          label: String(c.label || '').slice(0, 120)
        })))
      : device.cameras;
    run('UPDATE devices SET last_seen_at = ?, last_ip = ?, app_version = ?, cameras = ? WHERE id = ?',
      nowISO(), req.ip, String(req.body.version || ''), cameras, device.id);
    const location = device.location_id ? get('SELECT name FROM locations WHERE id = ?', device.location_id) : null;
    return res.json({
      ok: true,
      config_rev: rev,
      device_id: device.id,
      name: device.name,
      slug: device.slug,
      site_id: device.site_id,
      location_id: device.location_id,
      location_name: location ? location.name : null,
      mode: device.mode,
      default_camera: device.default_camera || 'front',
      sections: (() => { try { return JSON.parse(device.sections || 'null'); } catch { return null; } })(),
      print_enabled: !!device.print_enabled
    });
  }

  /*
   * Nothing matched. If the tablet did offer a name or a token, that is a
   * mistake worth showing — a renamed device, a mistyped address, a link from a
   * device since deleted. Saying so beats falling back to every card on screen
   * and leaving whoever set the tablet up to wonder why its link did nothing.
   */
  res.json({ ok: true, config_rev: rev, device_id: null, unknown: !!(slug || token) });
});

module.exports = router;
