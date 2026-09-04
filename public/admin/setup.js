/*
 * What a visitor is asked to do on the way in.
 *
 * Induction decks, the documents they sign, the badge that gets printed, and
 * the visitor types that decide which of those apply to whom.
 */
import { $, $$, SETTINGS, VIEWS, api, autoSave, autoSaveOn, confirmAction, copyText, el, esc, fmtDate, getPath,
  modal, pickEmoji, render, setPath, setSettings, siteZone, toast, typeName, upload
} from './core.js';

/*
 * A deck converted from PowerPoint carries a risk a PDF does not: PowerPoint
 * shrinks overflowing text to fit its box and records only the shrink factor,
 * which the converter ignores — so a slide whose text was already tight comes
 * out with its words drawn at full size, over whatever sat beside them. The
 * deck cannot be inspected from here, so the deck that came from a .pptx says
 * what to look for and how to settle it.
 */
function pptxHint(s) {
  const from = String(s.source_file || '').toLowerCase();
  if (!/\.(pptx|ppt|odp)$/.test(from) || s.render_mode !== 'rendered') return '';
  return `<div class="notice" style="margin:.75rem 0 0">
    <b>Converted from PowerPoint.</b> Check it with <b>Preview</b> — if any slide's text runs under a picture
    or off the edge, that is PowerPoint's “shrink text on overflow” being ignored by the converter, and no
    setting here fixes it. Open the deck in PowerPoint, <b>File → Export → PDF</b>, and upload that PDF here
    instead: it renders exactly as you see it, and is still split into slides.</div>`;
}

VIEWS.induction = async (root) => {
  const { rows, capabilities } = await api('/slideshows');
  root.innerHTML = `
    <h1 class="page">Induction decks</h1>
    <p class="page-sub">Upload a PowerPoint, PDF or images. First-time visitors watch it before they finish signing in;
      people who have already seen the current version skip straight through.</p>
    ${capabilities.libreoffice && capabilities.poppler
      ? `<div class="notice">Slides are rendered as designed.
         <details style="margin-top:.4rem"><summary>If a slide comes out with its text pushed into the pictures</summary>
           <p style="margin:.5rem 0 0">That is a font this server does not have. PowerPoint drew the text in one
           font, the renderer substituted another with different letter widths, and the wording reflowed onto more
           lines than the slide had room for. Stand-ins for Arial, Calibri, Cambria and Times are installed, but a
           brand font — or Microsoft's newer <b>Aptos</b> — has none.</p>
           <p style="margin:.5rem 0 0"><b>The fix takes a minute:</b> in PowerPoint choose <b>File → Save a Copy
           / Export → PDF</b> and upload the PDF here instead. A PDF carries its fonts inside it, so it renders
           exactly as you see it, every time. Everything else works the same — it is still split into slides.</p>
         </details></div>`
      : `<div class="notice error"><b>This server cannot render PowerPoint properly.</b>
         Missing: ${[capabilities.libreoffice ? null : 'LibreOffice', capabilities.poppler ? null : 'poppler (pdftoppm)'].filter(Boolean).join(' and ')}.
         Decks are rebuilt from their text and images instead, which loses the original layout, fonts and colours.
         <br>Deploy with the included <code class="token">Dockerfile</code> to get both, or export your deck to PDF and
         upload that instead — a PDF keeps the original look.</div>`}
    <div class="row"><button class="btn" id="s-new">New deck</button></div>
    ${rows.length ? rows.map((s) => `
      <div class="card section" data-show="${s.id}">
        <div class="row between">
          <div><h2 style="margin:0">${esc(s.name)}
            <span class="pill ${s.language === 'es' ? 'wait' : 'on'}">${s.language === 'es' ? 'Español' : 'English'}</span>
            <span class="pill ${s.active ? 'on' : 'off'}">${s.active ? 'active' : 'off'}</span></h2>
            <span class="muted">v${s.version} · ${s.slide_count} slide(s) · watched ${s.views} time(s)
            ${s.source_file ? `· from ${esc(s.source_file)}` : ''}</span>
            ${s.render_mode === 'rebuilt'
              ? '<div><span class="pill wait">rebuilt from text — not the original layout</span></div>'
              : s.render_mode === 'rendered'
              ? '<div><span class="pill on">rendered as designed</span></div>'
              : s.render_mode === 'pdf' ? '<div><span class="pill wait">embedded PDF</span></div>' : ''}</div>
          <div class="row" style="margin:0">
            <button class="btn ghost" data-preview="${s.id}">Preview</button>
            <button class="btn ghost" data-edit="${s.id}">Settings</button>
            <button class="btn ghost" data-del="${s.id}">Delete</button>
          </div>
        </div>
        ${pptxHint(s)}
        <div class="dropzone" data-drop="${s.id}">
          <p><b>Drop a PDF, .pptx or image here</b> — or
            <label class="btn subtle" style="display:inline-flex">Choose file<input type="file" hidden data-file="${s.id}"
              accept=".pdf,.pptx,.ppt,.odp,image/*"></label></p>
          <p class="muted"><b>A PDF is the safest thing to upload.</b> PowerPoint shrinks text to fit its boxes;
            the converter here does not, so a tight slide can come out with its words running under the pictures.
            Exporting from PowerPoint with <b>File → Export → PDF</b> settles the layout before it ever reaches
            this server. A .pptx works too, and usually looks right — check it with <b>Preview</b>.</p>
          <p class="muted">Uploading a deck replaces the current slides and bumps the version, so everyone sees the new induction once.</p>
        </div>
        <div class="slide-grid" data-slides="${s.id}" style="margin-top:1rem"></div>
      </div>`).join('')
      : '<div class="card section"><p class="empty">No induction decks yet. Create one, then upload your PowerPoint.</p></div>'}`;

  $('#s-new').addEventListener('click', () => deckSettings(null));
  $$('[data-edit]').forEach((b) => b.addEventListener('click', () => deckSettings(b.dataset.edit)));
  $$('[data-del]').forEach((b) => b.addEventListener('click', () => confirmAction('Delete this induction deck and its slides?',
    async () => { await api(`/slideshows/${b.dataset.del}`, { method: 'DELETE' }); render('induction'); })));
  $$('[data-preview]').forEach((b) => b.addEventListener('click', () => previewDeck(b.dataset.preview)));

  rows.forEach((s) => loadSlides(s.id));

  $$('[data-file]').forEach((input) => input.addEventListener('change', async () => {
    if (input.files[0]) await doUpload(input.dataset.file, input.files[0]);
  }));
  $$('[data-drop]').forEach((zone) => {
    ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, () => zone.classList.remove('over')));
    zone.addEventListener('drop', async (e) => {
      e.preventDefault();
      if (e.dataTransfer.files[0]) await doUpload(zone.dataset.drop, e.dataTransfer.files[0]);
    });
  });

  async function doUpload(showId, file) {
    toast(`Processing ${file.name}…`, 8000);
    try {
      const r = await upload(`/slideshows/${showId}/upload`, file);
      toast(r.note || `${r.count} slide(s) ready`, r.note ? 8000 : 3000);
      render('induction');
    } catch (err) {
      toast(err.data && err.data.error === 'unsupported_file_type'
        ? 'Please upload a .pptx, .pdf or image file' : 'Could not process that file');
    }
  }

  async function loadSlides(showId) {
    const slides = await api(`/slideshows/${showId}/slides`);
    const box = $(`[data-slides="${showId}"]`);
    if (!box) return;
    box.innerHTML = slides.map((s, i) => `<div class="slide-thumb">
      <span class="num">${i + 1}</span>
      <button data-slide-del="${showId}:${s.id}" title="Remove slide">✕</button>
      ${s.kind === 'image' ? `<img src="${esc(s.image_path)}" alt="">`
        : s.kind === 'pdf' ? '<div class="html-preview">PDF document</div>'
        : `<div class="html-preview">${s.html || ''}</div>`}</div>`).join('');
    $$('[data-slide-del]', box).forEach((b) => b.addEventListener('click', async () => {
      const [sid, slideId] = b.dataset.slideDel.split(':');
      await api(`/slideshows/${sid}/slides/${slideId}`, { method: 'DELETE' });
      loadSlides(sid);
    }));
  }
};

async function deckSettings(id) {
  const existing = id ? (await api('/slideshows')).rows.find((r) => String(r.id) === String(id)) : null;
  const req = existing ? JSON.parse(existing.required_for) : ['visitor', 'contractor'];
  modal(existing ? 'Deck settings' : 'New induction deck', `
    <label class="field"><span>Name</span><input class="input" id="dk-name" value="${esc(existing ? existing.name : 'Site induction')}"></label>
    <label class="field"><span>Description</span><input class="input" id="dk-desc" value="${esc(existing ? existing.description || '' : '')}"></label>
    <label class="field" style="max-width:16rem"><span>Language</span>
      <select class="input" id="dk-lang">
        <option value="en" ${!existing || existing.language !== 'es' ? 'selected' : ''}>English</option>
        <option value="es" ${existing && existing.language === 'es' ? 'selected' : ''}>Español</option>
      </select>
      <span class="muted">Upload the deck once per language. The kiosk shows the one matching the language chosen on
        screen, and falls back to English when there is no Spanish deck. Watching either language counts as having
        watched the induction.</span></label>
    <span class="muted">Show to these visitor types</span>
    <div class="form-grid" style="margin:.5rem 0 1rem">
      ${categories().map(([t, label]) => `<label class="check"><input type="checkbox" data-type="${t}" ${req.includes(t) ? 'checked' : ''}> ${label}</label>`).join('')}
    </div>
    <div class="form-grid">
      <label class="field"><span>Repeat after (days, 0 = never)</span>
        <input class="input" id="dk-repeat" type="number" min="0" value="${existing ? existing.repeat_after_days || 0 : 0}"></label>
      <label class="field"><span>Minimum seconds per slide</span>
        <input class="input" id="dk-min" type="number" min="0" value="${existing ? existing.min_seconds_per_slide : 0}">
        <span class="muted">Stops the deck being clicked through unread: Next shows a countdown and only
          unlocks once the time is up, on every slide not yet watched. 0 = no wait.</span></label>
    </div>
    <label class="check"><input type="checkbox" id="dk-sig" ${existing && existing.require_signature ? 'checked' : ''}>
      <span>Ask for a signature at the end<br><span class="muted">The confirmation screen after the last slide asks
        them to sign in a box, not just tap a button. The signature is kept on their induction record — proof they
        sat through it, the same as a signed document.</span></span></label>
    <label class="check"><input type="checkbox" id="dk-active" ${!existing || existing.active ? 'checked' : ''}> Active</label>`,
    async (bg, close) => {
      const body = {
        name: $('#dk-name', bg).value,
        description: $('#dk-desc', bg).value,
        required_for: $$('[data-type]', bg).filter((c) => c.checked).map((c) => c.dataset.type),
        repeat_after_days: Number($('#dk-repeat', bg).value) || null,
        min_seconds_per_slide: Number($('#dk-min', bg).value) || 0,
        language: $('#dk-lang', bg).value,
        require_signature: $('#dk-sig', bg).checked,
        active: $('#dk-active', bg).checked
      };
      if (existing) await api(`/slideshows/${existing.id}`, { method: 'PATCH', body });
      else await api('/slideshows', { method: 'POST', body });
      close();
      render('induction');
    });
}

async function previewDeck(id) {
  const slides = await api(`/slideshows/${id}/slides`);
  if (!slides.length) return toast('This deck has no slides yet');
  let i = 0;
  const m = modal('Preview', '<div id="pv-stage" style="background:#0d1512;border-radius:10px;min-height:340px;display:grid;place-items:center;padding:1rem"></div>'
    + '<div class="row between" style="margin-top:.75rem"><button class="btn ghost" id="pv-prev">Back</button><span class="muted" id="pv-n"></span><button class="btn" id="pv-next">Next</button></div>', null);
  const draw = () => {
    const s = slides[i];
    $('#pv-stage', m.bg).innerHTML = s.kind === 'image'
      ? `<img src="${esc(s.image_path)}" style="max-width:100%;max-height:60vh">`
      : s.kind === 'pdf' ? `<iframe src="${esc(s.image_path)}" style="width:100%;height:60vh;border:0;background:#fff"></iframe>`
      : `<div style="color:#fff">${s.html || ''}</div>`;
    $('#pv-n', m.bg).textContent = `${i + 1} of ${slides.length}`;
  };
  $('#pv-prev', m.bg).addEventListener('click', () => { i = Math.max(0, i - 1); draw(); });
  $('#pv-next', m.bg).addEventListener('click', () => { i = Math.min(slides.length - 1, i + 1); draw(); });
  draw();
}

/* ------------------------------------------------------------ documents */

// The visitor types these documents can be attached to — the list managed on
// the Visitor types tab, so a newly added type can be given documents at once.
const MODE_HINT = { card: 'Own card on the home screen', picker: 'Offered behind Sign in', both: 'Card + Sign in picker', off: 'Currently hidden' };
const categories = () => ((SETTINGS && SETTINGS.types) || []).map((ty) => [ty.key, ty.label, MODE_HINT[ty.mode] || '']);
const categoryLabel = (t) => { const c = categories().find(([v]) => v === t); return c ? c[1] : t; };

/** Map question ids back to the wording used at the time, for reading answers. */
export function questionLabels(questionsJson) {
  try {
    return JSON.parse(questionsJson || '[]').reduce((acc, q, i) => {
      acc[q.id || `q${i + 1}`] = q.label;
      return acc;
    }, {});
  } catch { return {}; }
}

VIEWS.documents = async (root) => {
  const rows = await api('/agreements');
  const parseQs = (a) => { try { return JSON.parse(a.questions || '[]'); } catch { return []; } };
  const countQuestions = (a) => parseQs(a).length;
  const spanishOn = !!(SETTINGS && SETTINGS.kiosk && SETTINGS.kiosk.spanish_enabled);

  /*
   * With Spanish offered on the kiosk, every document without its translation
   * is being shown to Spanish visitors in English. That fallback is deliberate
   * — but it must be visible here, not discovered by a contractor mid-sign-in.
   */
  const langPill = (a) => {
    if (!spanishOn) return '';
    const qs = parseQs(a);
    const translatedQs = qs.filter((q) => String(q.label_es || '').trim()).length;
    // An uploaded Spanish file counts as the Spanish wording, the same way
    // an uploaded English file replaces the typed English.
    const hasBody = docFilePages(a, false).length
      ? docFilePages(a, true).length > 0
      : !!(String(a.body_es || '').trim() || !String(a.body || '').trim());
    if (hasBody && translatedQs === qs.length) return '<span class="pill on">Español ✓</span>';
    if (!hasBody && !translatedQs) return '<span class="pill off" title="Open Edit and fill in the En español boxes">no Spanish — shows in English</span>';
    return `<span class="pill wait" title="Open Edit and fill in the En español boxes">Spanish incomplete${qs.length ? ` (${translatedQs}/${qs.length} questions)` : ''}</span>`;
  };

  root.innerHTML = `
    <h1 class="page">Documents to sign</h1>
    <p class="page-sub">NDAs, site rules and safety declarations. Each one is assigned to the categories that must sign it,
      and can ask its own questions before the signature. Deliveries do not sign anything.${spanishOn
        ? ' Spanish is offered on the kiosk, so each document also carries its Spanish wording — anything left untranslated is shown to Spanish visitors in English.' : ''}</p>
    <div class="row"><button class="btn" id="a-new">New document</button></div>
    ${rows.map((a) => `<div class="card section">
      <div class="row between"><div><h2 style="margin:0">${esc(a.name)} <span class="pill ${a.active ? 'on' : 'off'}">${a.active ? 'active' : 'off'}</span> ${langPill(a)}</h2>
      <span class="muted">v${a.version} · signed by ${esc(JSON.parse(a.required_for).map(categoryLabel).join(', ') || 'nobody')}${
        countQuestions(a) ? ` · ${countQuestions(a)} question${countQuestions(a) === 1 ? '' : 's'}` : ''} · ${
        a.repeat_after_days === null || a.repeat_after_days === undefined ? 'every visit'
          : a.repeat_after_days === 0 ? 'signed once' : `every ${a.repeat_after_days} days`}</span></div>
      <div class="row" style="margin:0"><button class="btn ghost" data-doc="${a.id}">Edit</button>
      <button class="btn ghost" data-docdel="${a.id}">Delete</button></div></div>
      ${docFilePages(a, false).length
  ? `<p class="muted" style="margin:0">📄 <b>${esc(a.source_file || 'Uploaded file')}</b> — ${docFilePages(a, false).length} page(s)${
    docFilePages(a, true).length ? `, plus ${esc(a.source_file_es || 'a Spanish file')} for Spanish` : ''}. Shown on the kiosk in place of typed wording.</p>`
  : `<pre class="muted" style="white-space:pre-wrap;margin:0">${esc(String(a.body || '').slice(0, 400))}${String(a.body || '').length > 400 ? '…' : ''}</pre>`}</div>`).join('')
      || '<div class="card section"><p class="empty">No documents yet.</p></div>'}`;
  $('#a-new').addEventListener('click', () => docEditor(null));
  $$('[data-doc]').forEach((b) => b.addEventListener('click', async () =>
    docEditor((await api('/agreements')).find((x) => String(x.id) === b.dataset.doc))));
  $$('[data-docdel]').forEach((b) => b.addEventListener('click', () => confirmAction('Delete this document?',
    async () => { await api(`/agreements/${b.dataset.docdel}`, { method: 'DELETE' }); render('documents'); })));
};

/** Pages already attached to a document, for one language. */
function docFilePages(doc, es) {
  if (!doc) return [];
  try { return JSON.parse((es ? doc.pages_es : doc.pages) || '[]'); } catch { return []; }
}

/**
 * The upload control for one language. A file can only be attached to a
 * document that exists, so on a new document it says to save first rather
 * than offering a button that cannot work.
 */
function docFileBlock(doc, es) {
  const label = es ? 'Archivo en español' : 'Or upload the document';
  if (!doc) {
    return `<p class="muted">${es ? 'Guarde el documento para poder subir un archivo.'
      : 'Save the document first, then reopen it to upload a PDF or Word file instead of typing the wording.'}</p>`;
  }
  const pages = docFilePages(doc, es);
  const source = es ? doc.source_file_es : doc.source_file;
  const mode = es ? doc.render_mode_es : doc.render_mode;
  const id = es ? 'es' : 'en';
  return `<div class="field">
    <span>${label}</span>
    ${pages.length ? `<div class="notice" style="margin:.4rem 0">
        <b>${esc(source || 'Uploaded file')}</b> — ${pages.length} page${pages.length === 1 ? '' : 's'}${
      mode === 'pdf' ? ', shown as a scrollable PDF' : mode === 'image' ? ', an image' : ', rendered as designed'}.
        <br><span class="muted">Shown on the kiosk instead of the wording above.</span>
      </div>
      <div class="row" style="margin:0">
        <label class="btn subtle">Replace file<input type="file" id="ag-file-${id}" accept=".pdf,.doc,.docx,.odt,.rtf,.txt,image/*" hidden></label>
        <button class="btn ghost" type="button" data-agfiledel="${id}">Remove file</button>
      </div>`
  : `<div class="row" style="margin:0">
        <label class="btn subtle">Upload PDF or Word<input type="file" id="ag-file-${id}" accept=".pdf,.doc,.docx,.odt,.rtf,.txt,image/*" hidden></label>
      </div>
      <span class="muted">Rendered to pages so it is read exactly as drafted. Leave empty to use the wording above.</span>`}
  </div>`;
}

function docEditor(doc) {
  const req = doc ? JSON.parse(doc.required_for) : ['visitor', 'contractor'];
  let questions = [];
  try { questions = JSON.parse((doc && doc.questions) || '[]'); } catch { questions = []; }

  const m = modal(doc ? 'Edit document' : 'New document', `
    <label class="field"><span>Title</span><input class="input" id="ag-name" value="${esc(doc ? doc.name : '')}"></label>
    <label class="field"><span>What they read and sign</span>
      <textarea class="input" id="ag-body" rows="10">${esc(doc ? doc.body : '')}</textarea></label>
    ${docFileBlock(doc, false)}

    <details class="howto" ${(doc && ((doc.name_es || '').trim() || (doc.body_es || '').trim()))
      || (SETTINGS && SETTINGS.kiosk && SETTINGS.kiosk.spanish_enabled) ? 'open' : ''}>
      <summary><b>En español</b> — shown when the kiosk is switched to Spanish</summary>
      <p class="muted" style="margin-top:.5rem">Leave a box empty and that part stays in English. The signature records
        which language was on screen when it was signed.</p>
      <label class="field"><span>Título</span><input class="input" id="ag-name-es" value="${esc((doc && doc.name_es) || '')}"></label>
      <label class="field"><span>Lo que leen y firman</span>
        <textarea class="input" id="ag-body-es" rows="10">${esc((doc && doc.body_es) || '')}</textarea></label>
      ${docFileBlock(doc, true)}
    </details>

    <h3>Who signs this</h3>
    <p class="muted" style="margin-top:0">Matched to the cards on the kiosk home screen.</p>
    <div class="form-grid" style="margin:.5rem 0 1rem">
      ${categories().map(([t, label, hint]) => `<label class="check"><input type="checkbox" data-t="${t}" ${req.includes(t) ? 'checked' : ''}>
        <span>${label}<br><span class="muted">${hint}</span></span></label>`).join('')}
    </div>

    <h3>How often</h3>
    <p class="muted" style="margin-top:0">Same as the induction decks: how often the same person is asked to sign
      this again. Editing the wording brings it back to everyone regardless, so nobody stays signed onto an old
      version.</p>
    <div class="inline-form" style="margin:.5rem 0 1rem">
      <label class="field" style="max-width:18rem"><span>Ask them to sign</span>
        <select class="input" id="ag-repeat-mode">
          <option value="always" ${!doc || doc.repeat_after_days === null || doc.repeat_after_days === undefined ? 'selected' : ''}>Every visit</option>
          <option value="once" ${doc && doc.repeat_after_days === 0 ? 'selected' : ''}>Once — until the document changes</option>
          <option value="days" ${doc && doc.repeat_after_days > 0 ? 'selected' : ''}>Again after a number of days</option>
        </select></label>
      <label class="field" style="max-width:10rem" id="ag-repeat-days-wrap" ${doc && doc.repeat_after_days > 0 ? '' : 'hidden'}>
        <span>Days</span>
        <input class="input" id="ag-repeat-days" type="number" min="1" value="${doc && doc.repeat_after_days > 0 ? doc.repeat_after_days : 90}"></label>
    </div>

    <h3>Questions</h3>
    <p class="muted" style="margin-top:0">Asked on the kiosk before they finish. Answers are stored against the visit.</p>
    <div id="q-list"></div>
    <button class="btn subtle" id="q-add" type="button">Add a question</button>

    <h3>Signature</h3>
    <label class="check"><input type="checkbox" id="ag-sig" ${!doc || doc.require_signature !== 0 ? 'checked' : ''}>
      <span>Ask for a signature<br><span class="muted">Leave this off for a questionnaire — the visitor just answers
        the questions and carries on.</span></span></label>

    <label class="check" style="margin-top:1rem"><input type="checkbox" id="ag-active" ${!doc || doc.active ? 'checked' : ''}> Active</label>
    ${doc ? '<p class="muted">Saving bumps the version, so copies already signed stay exactly as they were signed.</p>' : ''}`,
    async (bg, close) => {
      const repeatMode = $('#ag-repeat-mode', bg).value;
      const body = {
        name: $('#ag-name', bg).value,
        body: $('#ag-body', bg).value,
        name_es: $('#ag-name-es', bg).value.trim() || null,
        body_es: $('#ag-body-es', bg).value.trim() || null,
        required_for: JSON.stringify($$('[data-t]', bg).filter((c) => c.checked).map((c) => c.dataset.t)),
        questions: JSON.stringify(collectQuestions(bg)),
        require_signature: $('#ag-sig', bg).checked ? 1 : 0,
        repeat_after_days: repeatMode === 'always' ? null
          : repeatMode === 'once' ? 0
          : Math.max(1, Number($('#ag-repeat-days', bg).value) || 90),
        active: $('#ag-active', bg).checked ? 1 : 0
      };
      if (!body.name.trim()) return toast('Give the document a title');
      if (doc) {
        /*
         * The version only moves when what people read or answer has changed.
         * It is what brings a "once" or "every 90 days" document back to
         * everyone — so flipping a setting like the frequency itself must not
         * bump it and quietly void every standing signature.
         */
        const changed = ['name', 'body', 'name_es', 'body_es', 'questions']
          .some((f) => String(body[f] || '') !== String(doc[f] || (f === 'questions' ? '[]' : '')));
        if (changed) body.version = doc.version + 1;
        await api(`/agreements/${doc.id}`, { method: 'PATCH', body });
      } else await api('/agreements', { method: 'POST', body });
      close(); render('documents');
    });

  $('#ag-repeat-mode', m.bg).addEventListener('change', (e) => {
    $('#ag-repeat-days-wrap', m.bg).hidden = e.target.value !== 'days';
  });

  /*
   * Files are attached to the document itself, not to the form: uploading
   * saves straight away and reopens the editor on the updated document, so
   * what is on screen always matches what the kiosk will show.
   */
  ['en', 'es'].forEach((lang) => {
    const input = $(`#ag-file-${lang}`, m.bg);
    if (input) {
      input.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        toast('Uploading…', 8000);
        try {
          const out = await upload(`/agreements/${doc.id}/file?language=${lang}`, file);
          toast(out.method === 'rendered'
            ? `Uploaded — ${out.pages.length} page${out.pages.length === 1 ? '' : 's'} rendered`
            : out.method === 'pdf'
              ? 'Uploaded — shown as a scrollable PDF (install poppler for rendered pages)'
              : 'Uploaded', 5000);
          m.close();
          docEditor((await api('/agreements')).find((x) => x.id === doc.id));
          render('documents');
        } catch (err) {
          toast((err.data && err.data.error) === 'unsupported_file_type'
            ? 'That file type is not supported — use PDF, Word, ODT, RTF or text.'
            : 'Could not read that file', 5000);
        }
        e.target.value = '';
      });
    }
    const del = $(`[data-agfiledel="${lang}"]`, m.bg);
    if (del) {
      del.addEventListener('click', () => confirmAction(
        'Remove the uploaded file? The document goes back to the wording typed above.',
        async () => {
          await api(`/agreements/${doc.id}/file?language=${lang}`, { method: 'DELETE' });
          m.close();
          docEditor((await api('/agreements')).find((x) => x.id === doc.id));
          render('documents');
        }));
    }
  });

  const list = $('#q-list', m.bg);
  /*
   * A question can depend on an earlier answer — ask about the escort only when
   * they said they have no card. Only questions with fixed answers can be
   * depended on, since there is nothing dependable to match on free text.
   */
  const conditionValue = (q) => (q.show_if && q.show_if.id ? `${q.show_if.id}|${q.show_if.value}` : '');

  const conditionChoices = (index) => {
    const out = [];
    questions.slice(0, index).forEach((earlier) => {
      if (!earlier.label || !earlier.label.trim()) return;
      const answers = earlier.type === 'choice' ? (earlier.options || []) : earlier.type === 'yesno' ? ['Yes', 'No'] : [];
      const short = earlier.label.length > 40 ? `${earlier.label.slice(0, 40)}…` : earlier.label;
      answers.forEach((a) => out.push([`${earlier.id}|${a}`, `“${short}” is ${a}`]));
    });
    return out;
  };

  const drawQuestions = () => {
    list.innerHTML = questions.map((q, i) => `
      <div class="q-row" data-i="${i}">
        <div class="q-row-top">
          <input class="input" data-qlabel="${i}" placeholder="Question shown to the visitor" value="${esc(q.label || '')}">
          <select class="input" data-qtype="${i}">
            ${[['yesno', 'Yes / No'], ['text', 'Short answer'], ['choice', 'Choose one']]
              .map(([v, l]) => `<option value="${v}" ${q.type === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
          <button class="btn ghost" type="button" data-qup="${i}" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button>
          <button class="btn ghost" type="button" data-qdown="${i}" ${i === questions.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
          <button class="btn ghost" type="button" data-qdel="${i}" title="Remove">✕</button>
        </div>
        <input class="input" data-qdesc="${i}" style="margin-top:.5rem"
          placeholder="Help text shown under the question (optional)" value="${esc(q.description || '')}">
        ${q.type === 'choice' ? `<input class="input" data-qopts="${i}" style="margin-top:.5rem"
          placeholder="Options, separated by commas" value="${esc((q.options || []).join(', '))}">` : ''}
        <input class="input" data-qlabeles="${i}" style="margin-top:.5rem"
          placeholder="En español (optional — English is shown if empty)" value="${esc(q.label_es || '')}">
        ${String(q.description || '').trim() || String(q.description_es || '').trim() ? `<input class="input" data-qdesces="${i}" style="margin-top:.5rem"
          placeholder="Help text en español (optional)" value="${esc(q.description_es || '')}">` : ''}
        ${q.type === 'choice' ? `<input class="input" data-qoptses="${i}" style="margin-top:.5rem"
          placeholder="Options in Spanish, in the same order" value="${esc((q.options_es || []).join(', '))}">` : ''}
        <label class="field" style="margin:.5rem 0 0"><span>Only ask this if</span>
          <select class="input" data-qcond="${i}">
            <option value="">Always ask it</option>
            ${conditionChoices(i).map(([value, label]) =>
              `<option value="${esc(value)}" ${conditionValue(q) === value ? 'selected' : ''}>${esc(label)}</option>`).join('')}
          </select></label>
        <label class="check"><input type="checkbox" data-qreq="${i}" ${q.required ? 'checked' : ''}> Must be answered</label>
      </div>`).join('') || '<p class="muted">No questions — the visitor just reads and signs.</p>';

    $$('[data-qtype]', list).forEach((s) => s.addEventListener('change', () => {
      sync(); questions[Number(s.dataset.qtype)].type = s.value; drawQuestions();
    }));
    $$('[data-qdel]', list).forEach((b) => b.addEventListener('click', () => {
      sync(); questions.splice(Number(b.dataset.qdel), 1); drawQuestions();
    }));
    $$('[data-qup]', list).forEach((b) => b.addEventListener('click', () => {
      sync(); const i = Number(b.dataset.qup);
      [questions[i - 1], questions[i]] = [questions[i], questions[i - 1]]; drawQuestions();
    }));
    $$('[data-qdown]', list).forEach((b) => b.addEventListener('click', () => {
      sync(); const i = Number(b.dataset.qdown);
      [questions[i + 1], questions[i]] = [questions[i], questions[i + 1]]; drawQuestions();
    }));
  };

  // Pull whatever is currently typed back into the array before redrawing.
  const sync = () => {
    $$('[data-qlabel]', list).forEach((input) => { questions[Number(input.dataset.qlabel)].label = input.value; });
    $$('[data-qopts]', list).forEach((input) => {
      questions[Number(input.dataset.qopts)].options = input.value.split(',').map((o) => o.trim()).filter(Boolean);
    });
    $$('[data-qreq]', list).forEach((input) => { questions[Number(input.dataset.qreq)].required = input.checked; });
    $$('[data-qdesc]', list).forEach((input) => { questions[Number(input.dataset.qdesc)].description = input.value; });
    $$('[data-qlabeles]', list).forEach((input) => { questions[Number(input.dataset.qlabeles)].label_es = input.value; });
    $$('[data-qdesces]', list).forEach((input) => { questions[Number(input.dataset.qdesces)].description_es = input.value; });
    $$('[data-qoptses]', list).forEach((input) => {
      questions[Number(input.dataset.qoptses)].options_es = input.value.split(',').map((o) => o.trim()).filter(Boolean);
    });
    $$('[data-qcond]', list).forEach((select) => {
      const q = questions[Number(select.dataset.qcond)];
      if (!select.value) { delete q.show_if; return; }
      const [id, ...rest] = select.value.split('|');
      q.show_if = { id, value: rest.join('|') };
    });
  };

  function collectQuestions() {
    sync();
    const kept = questions.filter((q) => String(q.label || '').trim());
    const ids = new Set(kept.map((q) => q.id));
    return kept.map((q) => ({
      id: q.id,
      label: q.label.trim(),
      type: q.type || 'yesno',
      required: !!q.required,
      ...(String(q.description || '').trim() ? { description: q.description.trim() } : {}),
      ...(String(q.label_es || '').trim() ? { label_es: q.label_es.trim() } : {}),
      ...(String(q.description_es || '').trim() ? { description_es: q.description_es.trim() } : {}),
      ...(q.type === 'choice' ? { options: q.options || [] } : {}),
      ...(q.type === 'choice' && (q.options_es || []).length ? { options_es: q.options_es } : {}),
      // A condition pointing at a question that has since been deleted would
      // hide this one for ever, so it is dropped rather than kept dangling.
      ...(q.show_if && ids.has(q.show_if.id) ? { show_if: q.show_if } : {})
    }));
  }

  // Ids must survive reordering, or a condition would come to mean a different
  // question, so each new one takes the next unused number.
  const nextQuestionId = () => {
    const used = questions.map((q) => Number(String(q.id || '').replace(/\D/g, '')) || 0);
    return `q${Math.max(0, ...used) + 1}`;
  };

  $('#q-add', m.bg).addEventListener('click', () => {
    sync();
    questions.push({ id: nextQuestionId(), label: '', type: 'yesno', required: true });
    drawQuestions();
  });
  drawQuestions();
}

/* --------------------------------------------------------------- badges */

/*
 * Common label stock, so nobody has to measure their own roll. Listed by the
 * only thing the badge layout actually cares about — millimetres. Which roll
 * is loaded is inventory, and lives on the printer record.
 *
 * DK-2251 is first because it is the usual choice for a visitor badge: 62 mm
 * wide and continuous, so the length is yours rather than the roll's. It is
 * the same page size as the die-cut DK-11202 at a 100 mm cut, which is why
 * they share an entry — offering two identical sizes would be a choice with
 * no consequence.
 */
const LABEL_SIZES = [
  [62, 100, 'Brother 62 mm roll — DK-2251 continuous, or DK-11202 die-cut'],
  [62, 150, 'Brother DK-2251 — 62 mm continuous, long badge'],
  [62, 29, 'Brother DK-11209 — 62 × 29 mm'],
  [62, 60, 'Brother DK-11221 — 62 × 60 mm'],
  [54, 101, 'Dymo 99014 — 54 × 101 mm'],
  [89, 36, 'Dymo 99012 — 89 × 36 mm'],
  [101.6, 152.4, '4 × 6 inch shipping label'],
  [76.2, 50.8, '3 × 2 inch label'],
  [86, 54, 'Credit-card size — 86 × 54 mm']
];

VIEWS.badges = async (root) => {
  setSettings(await api('/settings'));
  const s = SETTINGS;
  const b = s.badge;
  const data = await api('/badges');

  const chk = (path, label, help) => `<label class="check"><input type="checkbox" data-set="${path}"
    ${getPath(s, path) ? 'checked' : ''}> <span>${label}${help ? `<br><span class="muted">${help}</span>` : ''}</span></label>`;
  const txt = (path, label, type = 'text') => `<label class="field"><span>${label}</span>
    <input class="input" data-set="${path}" type="${type}" value="${esc(getPath(s, path) ?? '')}"></label>`;
  const isPreset = LABEL_SIZES.some(([w, h]) => Number(b.label_width_mm) === w && Number(b.label_height_mm) === h);

  root.innerHTML = `
    <h1 class="page">Badges</h1>
    <p class="page-sub">What a printed badge shows, the label it prints on, and reprinting one that has been lost.</p>

    <div class="card section">
      <div class="check-list">
        ${chk('badge.enabled', 'Print a badge when someone signs in',
          'Leave this off if no label printer is connected — everything else works either way')}
        ${chk('badge.auto_print', 'Print automatically', 'Off means the visitor taps “Print badge” themselves')}
      </div>
    </div>

    <div class="grid two">
      <div class="card section">
        <h2>Label size</h2>
        <label class="field"><span>Label stock</span>
          <select class="input" id="label-preset">
            ${LABEL_SIZES.map(([w, h, name]) =>
              `<option value="${w}x${h}" ${Number(b.label_width_mm) === w && Number(b.label_height_mm) === h ? 'selected' : ''}>${name}</option>`).join('')}
            <option value="custom" ${isPreset ? '' : 'selected'}>Custom size…</option>
          </select></label>
        <div class="form-grid">
          ${txt('badge.label_width_mm', 'Width (mm)', 'number')}
          ${txt('badge.label_height_mm', 'Height (mm)', 'number')}
        </div>
        <p class="muted">On a <b>continuous</b> roll like the DK-2251 the width is fixed by the roll — 62 mm — and
          the height is whatever you set here, cut to length as each badge prints. On a <b>die-cut</b> roll both are
          fixed by the label, so these must match it or every badge prints short or spills onto the next one.</p>

        <h3>Margins</h3>
        <p class="muted" style="margin-top:0">The white space inside the label edge. Every label printer has a strip
          at the edge it cannot print on, and how wide it is differs by model and by roll — too small and the badge
          is clipped, too large and a 62 mm label wastes a third of itself. Start with one number; fill in a side
          only where that printer needs a different one.</p>
        <div class="form-grid">
          ${txt('badge.margin_mm', 'All round (mm)', 'number')}
        </div>
        <details>
          <summary>Different on each side</summary>
          <p class="muted">Usual on a continuous roll, where the cut edges and the side edges do not behave the
            same. Leave a box empty to use the number above.</p>
          <div class="form-grid">
            ${txt('badge.margin_top_mm', 'Top (mm)', 'number')}
            ${txt('badge.margin_bottom_mm', 'Bottom (mm)', 'number')}
            ${txt('badge.margin_left_mm', 'Left (mm)', 'number')}
            ${txt('badge.margin_right_mm', 'Right (mm)', 'number')}
          </div>
        </details>

        <!--
          The tools that tell you what to put in the boxes above live on the
          device check page, and until this was here they lived at a URL you
          could only learn from a guide — so the settings were adjustable and
          unmeasurable at the same time.

          They belong on the tablet rather than here, and not for tidiness: a
          test badge printed from this page goes to whatever printer this
          computer has. Hence the code, which is the quickest way to get the
          address onto the tablet holding the printer.
        -->
        <h3>Working out what to put in those boxes</h3>
        <div class="notice">
          <p style="margin-top:0"><b>Print from the tablet, not from here.</b> A test badge printed from this
            computer goes to this computer's printer. Open the device check on the tablet that has the badge
            printer and use the two tools on it:</p>
          <ul style="margin:.4rem 0">
            <li><b>Print an alignment page</b> — a numbered scale. Read the last number fully on the label in
              each direction, type them in, and it says what to set the margins to.</li>
            <li><b>Print a test badge</b> — a real badge at this size, carrying a 50 mm rule, a 2 inch rule and
              a mark in each corner. Rules long or short by the same factor means the printer is scaling;
              rules running along the roll instead of across it means it turned the badge; a missing corner
              means it is being clipped, and the margins need to go up.</li>
          </ul>
          <div class="row" style="align-items:center;gap:1rem;flex-wrap:wrap">
            <img class="qr-img" style="width:120px;height:120px"
              src="/api/qr?text=${encodeURIComponent(`${location.origin}/check/`)}" alt="">
            <div>
              <p class="muted" style="margin:0 0 .4rem"><code class="token">${esc(location.origin)}/check/</code></p>
              <button class="btn subtle" id="copy-check-link" type="button">Copy that address</button>
            </div>
          </div>
        </div>
        <label class="field"><span>Which way it prints on the label</span>
          <select class="input" data-set="badge.orientation">
            <option value="portrait" ${b.orientation !== 'landscape' ? 'selected' : ''}>Vertical — reads down the label</option>
            <option value="landscape" ${b.orientation === 'landscape' ? 'selected' : ''}>Horizontal — reads across the label</option>
          </select>
          <span class="muted">The label itself does not change size; the badge is turned on it</span></label>
        <label class="field"><span>Text size — <b id="scale-value">${b.font_scale}</b>×</span>
          <input type="range" min="0.6" max="1.6" step="0.05" id="badge-scale" data-set="badge.font_scale" value="${b.font_scale}"></label>
        <h3>Wording</h3>
        <div class="field-list">
          ${txt('badge.title_text', 'Header')}
          ${txt('badge.footer_text', 'Footer')}
        </div>

        <h3>Badge numbers</h3>
        <p class="muted" style="margin-top:0">Every badge gets a number, counted fresh each day. What that number
          looks like is up to you.</p>
        <div class="form-grid">
          <label class="field"><span>Prefix</span>
            <input class="input" data-set="badge.badge_prefix" value="${esc(b.badge_prefix ?? '')}">
            <span class="muted">Used by any type with no prefix of its own</span></label>
          <label class="field"><span>Counter digits</span>
            <input class="input" data-set="badge.badge_seq_digits" type="number" min="1" max="8"
              value="${esc(b.badge_seq_digits ?? 3)}">
            <span class="muted">3 gives 001 to 999 in a day</span></label>
        </div>
        <label class="field"><span>Format</span>
          <input class="input" data-set="badge.badge_format" value="${esc(b.badge_format || '{prefix}{yy}{mm}{dd}-{seq}')}">
          <span class="muted" id="bn-tokens"></span></label>

        <h4 style="margin:1.2rem 0 .3rem;font-size:.9rem;color:var(--ink-soft);text-transform:uppercase;letter-spacing:.05em">
          A prefix per visitor type</h4>
        <p class="muted" style="margin-top:0">Optional. Leave one empty and it uses the prefix above. Giving a type
          its own prefix also gives it its own run of numbers, so its first badge of the day is 001.</p>
        <div class="bn-prefixes" id="bn-prefixes"></div>

        <div id="bn-preview"></div>
      </div>

      <div class="card section">
        <h2>What the badge shows</h2>
        <div class="check-list">
          ${chk('badge.show_logo', 'Logo')}
          ${chk('badge.show_photo', 'Photo')}
          ${chk('badge.show_company', 'Company')}
          ${chk('badge.show_host', 'Who they are visiting')}
          ${chk('badge.show_date', 'Date')}
          ${chk('badge.show_time', 'Time')}
          ${chk('badge.show_badge_no', 'Badge number')}
          ${chk('badge.show_qr', 'QR code', 'Scannable at the kiosk to sign out')}
        </div>
      </div>
    </div>

    <div class="card section">
      <h2>Preview</h2>
      <p class="muted" style="margin-top:0">Shown at the real label size, updating as you change things.</p>
      <div class="badge-preview-wrap">
        <div class="badge-preview" id="badge-preview"></div>
        <div>
          <div class="row"><button class="btn subtle" id="badge-test">Print a test badge</button>
            <span class="muted">The design saves itself as you change it.</span></div>
          <p class="muted" style="max-width:32rem">Connect the label printer to the device showing the kiosk and make
            it the default printer. In Chrome or Edge set margins to <b>None</b>, turn headers and footers off and
            background graphics on. On iPad, AirPrint remembers the printer you pick. Print a test badge and adjust the
            size until it lines up.</p>
        </div>
      </div>
    </div>

    <div class="card section">
      <h2>Reprint a badge</h2>
      <p class="muted" style="margin-top:0">Badges from the last week. Reprinting does not change the visit — it
        prints the same badge again, issuing a number first if that visit never had one.</p>
      <div class="row">
        <input class="input" id="badge-q" placeholder="Search name, company or badge number" style="max-width:20rem">
      </div>
      <div class="table-wrap" id="badge-list"></div>
    </div>`;

  const drawList = () => {
    const q = ($('#badge-q').value || '').toLowerCase();
    const rows = data.issued.filter((r) => !q
      || (r.full_name || '').toLowerCase().includes(q)
      || (r.company || '').toLowerCase().includes(q)
      || (r.badge_no || '').toLowerCase().includes(q));
    $('#badge-list').innerHTML = rows.length ? `<table>
      <thead><tr><th></th><th>Name</th><th>Company</th><th>Badge</th><th>Signed in</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td>${r.photo_path ? `<img class="avatar" src="${esc(r.photo_path)}" alt="" data-bigphoto="${esc(r.photo_path)}" data-bigphoto-name="${esc(r.full_name)}">` : '<div class="avatar"></div>'}</td>
        <td><b>${esc(r.full_name)}</b></td>
        <td>${esc(r.company || '')}</td>
        <td>${esc(r.badge_no || '—')}</td>
        <td>${fmtDate(r.signed_in_at)}</td>
        <td><span class="pill ${r.status === 'onsite' ? 'on' : 'off'}">${esc(r.status)}</span></td>
        <td><button class="btn ghost" data-reprint="${r.id}">Reprint</button></td></tr>`).join('')}</tbody></table>`
      : '<p class="empty">No badges issued in the last week.</p>';
    $$('[data-reprint]').forEach((btn) => btn.addEventListener('click', () => reprintBadge(btn.dataset.reprint)));
  };
  drawList();
  $('#badge-q').addEventListener('input', drawList);

  $('#copy-check-link').addEventListener('click', (e) =>
    copyText(`${location.origin}/check/`, e.currentTarget));

  // The preset and the custom boxes stay in step with each other.
  $('#label-preset').addEventListener('change', (e) => {
    if (e.target.value === 'custom') return;
    const [w, h] = e.target.value.split('x');
    $('[data-set="badge.label_width_mm"]').value = w;
    $('[data-set="badge.label_height_mm"]').value = h;
    drawBadgePreview();
  });
  $$('[data-set^="badge."]').forEach((input) => input.addEventListener('input', () => {
    if (input.id === 'badge-scale') $('#scale-value').textContent = input.value;
    drawBadgePreview();
  }));

  $('#badge-test').addEventListener('click', printTestBadge);
  const saveBadge = autoSave(async () => {
    const patch = {};
    $$('[data-set^="badge."]').forEach((input) => {
      const value = input.type === 'checkbox' ? input.checked
        : (input.type === 'number' || input.type === 'range') ? Number(input.value)
        : input.value;
      setPath(patch, input.dataset.set, value);
    });
    /*
     * Sent whole rather than merged: clearing a type's prefix has to clear
     * it, and a merge would leave the old one behind for ever.
     */
    if (VIEWS.badges.collectPrefixes) {
      setPath(patch, 'badge.badge_prefixes', VIEWS.badges.collectPrefixes());
    }
    setSettings(await api('/settings', { method: 'PUT', body: patch }));
  });
  autoSaveOn(root, saveBadge, '[data-set^="badge."]');

  /*
   * What the next three badges would be called, drawn by the server from the
   * same code that numbers a real one — so the example here cannot drift
   * from what comes out of the printer.
   */
  let numberTimer = null;
  const drawNumbers = () => { clearTimeout(numberTimer); numberTimer = setTimeout(loadNumbers, 250); };

  /*
   * The per-type prefixes, read from the boxes rather than from what was
   * saved, so the sample below follows what is on screen.
   *
   * Every box is included, empty ones as an empty string rather than being
   * left out: settings are merged key by key on the way in, so a prefix
   * omitted here would keep the one it had and clearing a box would appear
   * to do nothing. An empty string means "use the general prefix".
   */
  const typePrefixes = () => {
    const out = {};
    $$('[data-bnprefix]').forEach((el) => { out[el.dataset.bnprefix] = el.value.trim(); });
    return out;
  };
  VIEWS.badges.collectPrefixes = typePrefixes;

  async function loadNumbers() {
    const box = $('#bn-preview');
    if (!box) return;
    let data;
    try {
      data = await api('/badges/number-preview', { method: 'POST', body: {
        format: $('[data-set="badge.badge_format"]').value,
        digits: $('[data-set="badge.badge_seq_digits"]').value,
        prefix: $('[data-set="badge.badge_prefix"]').value,
        prefixes: typePrefixes()
      } });
    } catch (err) {
      if (err.message === 'unauthenticated') return;
      box.innerHTML = `<p class="empty">${esc(err.message)}</p>`;
      return;
    }

    /*
     * Drawn once, from the types the server knows about, and then left
     * alone — rebuilding it on every keystroke would take the focus out of
     * the box being typed in.
     */
    const prefixBox = $('#bn-prefixes');
    if (prefixBox && !prefixBox.dataset.drawn) {
      prefixBox.dataset.drawn = '1';
      const saved = (SETTINGS.badge && SETTINGS.badge.badge_prefixes) || {};
      prefixBox.innerHTML = data.examples.map((e) => `<label class="field bn-prefix">
        <span>${esc(e.label)}</span>
        <input class="input" data-bnprefix="${esc(e.type)}" maxlength="8"
          value="${esc(saved[e.type] || '')}"></label>`).join('');
      $$('[data-bnprefix]', prefixBox).forEach((el) => el.addEventListener('input', () => {
        drawNumbers();
        saveBadge.soon();
      }));
      // Placeholders track the general prefix as it is typed.
      const follow = () => $$('[data-bnprefix]', prefixBox)
        .forEach((el) => { el.placeholder = $('[data-set="badge.badge_prefix"]').value || '(none)'; });
      follow();
      $('[data-set="badge.badge_prefix"]').addEventListener('input', follow);
    }

    const legend = $('#bn-tokens');
    if (legend) {
      legend.innerHTML = data.tokens
        .map((t) => `<code title="${esc(t.describe)}">{${esc(t.id)}}</code>`).join(' ')
        + '. <b>{seq}</b> is the counter — a format without one would hand everybody the same number, '
        + 'so it is added on the end.';
    }

    box.innerHTML = `<div class="bn-samples">
      ${data.examples.map((e) => `<div class="bn-row">
        <span class="muted">${esc(e.label)}</span>
        <span class="bn-nums">${e.numbers.map((n) => `<code>${esc(n)}</code>`).join('')}</span>
      </div>`).join('')}
    </div>
    <p class="muted">${data.separate_series
      ? 'Each visitor type counts on its own, so every one of them starts the day at 1.'
      : 'Every type shares one run of numbers for the day. Give a type its own prefix above — or put '
        + '<code>{type}</code> in the format — to give it its own run.'}
    </p>
    <p class="muted">Changing this leaves badges already printed alone — the counter starts again at 1 under the new
      shape, so avoid changing it partway through a day.</p>`;
  }

  ['badge.badge_format', 'badge.badge_seq_digits', 'badge.badge_prefix'].forEach((path) => {  // eslint-disable-line
    const el = $(`[data-set="${path}"]`);
    if (el) el.addEventListener('input', drawNumbers);
  });
  loadNumbers();

  drawBadgePreview();
};

/** Print one visitor's badge again, using the current design. */
export async function reprintBadge(visitId) {
  const { visit, badge, org } = await api(`/visits/${visitId}/badge`, { method: 'POST' });
  const meta = [
    badge.show_host && visit.host_name ? `Visiting: ${visit.host_name}` : '',
    // The site's clock, so a reprint from a laptop in another zone still
    // carries the date and time the visitor actually arrived on site.
    badge.show_date ? new Date(visit.signed_in_at).toLocaleDateString(org.date_format || 'en-GB', { timeZone: siteZone() }) : '',
    badge.show_time ? new Date(visit.signed_in_at).toLocaleTimeString(org.date_format || 'en-GB', { hour: '2-digit', minute: '2-digit', timeZone: siteZone() }) : '',
    badge.show_badge_no && visit.badge_no ? visit.badge_no : ''
  ].filter(Boolean).join('<br>');

  openBadgeWindow(badge, `
    ${badge.show_logo && org.logo_path ? `<img class="logo" src="${esc(org.logo_path)}">` : ''}
    <div class="type">${esc(badge.title_text || typeName(visit.visit_type).toUpperCase())}</div>
    ${badge.show_photo && visit.photo_path ? `<img class="photo" src="${esc(visit.photo_path)}">` : ''}
    <div class="name">${esc(visit.full_name)}</div>
    ${badge.show_company && visit.company ? `<div class="company">${esc(visit.company)}</div>` : ''}
    <div class="meta">${meta}</div>
    ${badge.show_qr && visit.checkout_code ? `<div class="qr"><img src="/api/qr?text=${encodeURIComponent(visit.checkout_code)}"></div>` : ''}
    <div class="foot">${esc(badge.footer_text || '')}</div>`);
  toast(`Reprinting badge ${visit.badge_no}`);
}

/** A print window sized to the label, sharing one layout with the kiosk. */
function openBadgeWindow(b, innerHtml) {
  const landscape = b.orientation === 'landscape';
  // The label is the size it is; a horizontal badge is rotated onto it.
  const cardW = landscape ? b.label_height_mm : b.label_width_mm;
  const cardH = landscape ? b.label_width_mm : b.label_height_mm;
  const turn = landscape ? `transform: translateX(${b.label_width_mm}mm) rotate(90deg); transform-origin: top left;` : '';

  const w = window.open('', '_blank', 'width=420,height=640');
  w.document.write(`<!doctype html><title>Badge</title><style>
    @page { size: ${b.label_width_mm}mm ${b.label_height_mm}mm; margin: 0; }
    body { margin:0; font-family: system-ui, "Segoe UI", Arial, sans-serif;
           width:${b.label_width_mm}mm; height:${b.label_height_mm}mm; overflow:hidden; }
    .card { width:${cardW}mm; height:${cardH}mm; padding:4mm; display:flex; ${turn}
            flex-direction:column; align-items:center; text-align:center; box-sizing:border-box; overflow:hidden; }
    .logo { max-height:10mm; max-width:40mm; }
    .type { font-weight:800; letter-spacing:.18em; font-size:calc(4.4mm * ${b.font_scale || 1}); }
    .photo { width:30mm; height:30mm; object-fit:cover; border-radius:2mm; margin:2mm 0; }
    .name { font-weight:800; font-size:calc(5.6mm * ${b.font_scale || 1}); line-height:1.15; margin-top:1mm; }
    .company { font-size:calc(3.6mm * ${b.font_scale || 1}); margin-top:1mm; }
    .meta { font-size:calc(3.2mm * ${b.font_scale || 1}); margin-top:1.5mm; line-height:1.4; }
    .qr { width:22mm; margin-top:auto; } .qr img { width:100%; }
    .foot { font-size:calc(2.6mm * ${b.font_scale || 1}); margin-top:1.5mm; }
  </style><div class="card">${innerHtml}</div>`);
  w.document.close();
  // Give the photo and QR a moment to load, or they print blank.
  setTimeout(() => w.print(), 700);
}

/* --------------------------------------------------------- visitor types */

VIEWS.vtypes = async (root) => {
  setSettings(await api('/settings'));
  const s = SETTINGS;
  // The kiosk hides Request entry until there is a door to open, so the
  // preview has to know whether there is one.
  const DOORS = (await api('/access-points').catch(() => [])).filter((d) => d.enabled !== 0);
  // Edited as a local copy; nothing reaches the kiosk until Save.
  const types = (SETTINGS.types || []).map((ty) => ({ ...ty }));
  const MODES = [['card', 'Own card on the home screen'], ['picker', 'Behind the Sign in card'],
    ['both', 'Both'], ['off', 'Hidden']];

  root.innerHTML = `
    <h1 class="page">Visitor types</h1>
    <p class="page-sub">The cards on the kiosk. Each type has its own wording, its own place on the home screen, and —
      via the other tabs — its own documents, induction, form fields and step order. Add one here and it appears
      everywhere a type can be chosen: the “Your details” form settings, document and deck assignment, and the
      per-device card list.</p>
    <div class="card section">
      <div class="row between" style="margin-bottom:.5rem">
        <h2 style="margin:0">On the kiosk</h2>
        <div class="row" style="margin:0">
          <span class="muted">As it looks right now, before saving</span>
          ${s.kiosk.spanish_enabled ? `<select class="input" id="vt-lang" style="max-width:9rem">
            <option value="en">English</option><option value="es">Español</option></select>` : ''}
        </div>
      </div>
      <div id="vt-preview"></div>
    </div>

    <div class="card section">
      <div id="vt-list"></div>
      <div class="row" style="margin-top:1rem">
        <button class="btn subtle" id="vt-add" type="button">Add a visitor type</button>
        <span class="muted">Changes save themselves; kiosks pick them up within a few seconds.</span>
      </div>
      <p class="muted">A hidden type keeps its history and settings — hide a type rather than deleting it once it has
        been used. The Spanish boxes are shown when the kiosk is switched to Spanish; empty ones fall back to English.</p>
    </div>`;

  const list = $('#vt-list');

  /*
   * The kiosk, as these settings would make it.
   *
   * The tile markup and class names are the kiosk's own, so this is not a
   * drawing of the home screen that has to be kept in step by hand — it is
   * the same structure under a copy of the same rules. Where a type appears
   * is the thing that is hard to picture from a dropdown reading "Behind the
   * Sign in card", so both surfaces are shown: the home screen, and the list
   * that opens when somebody taps Sign in.
   */
  const previewLang = () => ($('#vt-lang') ? $('#vt-lang').value : 'en');

  // Matches the kiosk: a Spanish wording wins when there is one, else English.
  const word = (ty, field) => {
    const es = (ty[`${field}_es`] || '').trim();
    return previewLang() === 'es' && es ? es : (ty[field] || '');
  };

  /*
   * `at` is the type's index in the list below when this tile stands for a
   * type, and null for the fixed cards. It is what makes the tile draggable
   * and what a drop reorders — the kiosk shows types in list order, so
   * moving a tile here is the same edit as pressing ↑ down there, done
   * where you can actually see the result.
   */
  const tile = (icon, label, sub, at = null) => `<button class="tile${at == null ? '' : ' movable'}"
    type="button" tabindex="-1" ${at == null ? '' : `draggable="true" data-vtat="${at}" title="Drag to reorder"`}>
    <span class="tile-icon">${esc(icon)}</span><span>${esc(label)}</span>
    ${sub ? `<small>${esc(sub)}</small>` : ''}</button>`;

  const typeTile = (ty, withSub) =>
    tile(ty.icon || '👤', word(ty, 'label') || '(no name yet)', withSub ? word(ty, 'sub') : '', types.indexOf(ty));

  function drawPreview() {
    const es = previewLang() === 'es';
    const shown = types.filter((ty) => ty.mode !== 'off');
    const onCards = shown.filter((ty) => ty.mode === 'card' || ty.mode === 'both');
    const behind = shown.filter((ty) => ty.mode === 'picker' || ty.mode === 'both');

    const home = [
      // The general Sign in card only exists while something sits behind it.
      ...(behind.length ? [tile('👋', es ? 'Iniciar sesión' : 'Sign in', es ? 'Visitantes y contratistas' : 'Visitors & contractors')] : []),
      tile('🚪', es ? 'Salir' : 'Sign out', es ? 'Saliendo del sitio' : 'Leaving site'),
      ...onCards.map((ty) => typeTile(ty, true)),
      ...(s.kiosk.show_delivery_button && s.deliveries.enabled
        ? [tile('📦', es ? 'Entrega' : 'Delivery', es ? 'Entrega de mensajería' : 'Courier drop-off')] : []),
      /*
       * The same three conditions the kiosk itself uses. It was two here,
       * so the preview drew a Request entry button that the kiosk left off
       * for want of a door — a preview that shows something the real screen
       * does not is worse than no preview.
       */
      ...(s.access.enabled && s.access.unlock_button_on_kiosk && DOORS.length
        ? [tile('🔓', es ? 'Solicitar entrada' : 'Request entry', es ? 'Abrir la puerta' : 'Unlock the door')] : [])
    ];

    $('#vt-preview').innerHTML = `
      <div class="kiosk-preview">
        <div class="kp-label">Home screen</div>
        <div class="kp-screen"><div class="tiles" data-vtdrop>${home.join('')}</div></div>
      </div>
      ${behind.length ? `<div class="kiosk-preview">
        <div class="kp-label">After tapping <b>Sign in</b> — “${es ? '¿Qué le trae hoy?' : 'What brings you here today?'}”</div>
        <div class="kp-screen"><div class="tiles" data-vtdrop>${behind.map((ty) => typeTile(ty, false)).join('')}</div></div>
      </div>`
      : '<p class="muted">Nothing sits behind a Sign in card, so the kiosk drops it and shows only the cards above.</p>'}
      ${shown.length ? '' : '<p class="muted">Every type is hidden, so a visitor can only sign out.</p>'}
      ${shown.length > 1 ? '<p class="muted">Drag a card to change the order they appear in on the kiosk. The fixed '
        + 'cards — Sign in, Sign out, Delivery — keep their places.</p>' : ''}`;

    wirePreviewDrag();
  }

  /**
   * Dragging a card in the preview reorders the types.
   *
   * The order is worked out from where the tile was dropped relative to the
   * other *type* tiles, not from raw DOM position: the fixed cards are
   * interleaved with them and are not part of the list being reordered, so
   * counting them would move things by the wrong amount.
   */
  function wirePreviewDrag() {
    let dragging = null;
    $$('#vt-preview .tile.movable').forEach((el) => {
      el.addEventListener('dragstart', (e) => {
        dragging = el;
        el.classList.add('dragging');
        // Firefox will not start a drag without something on the transfer.
        if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', el.dataset.vtat); }
      });
      el.addEventListener('dragend', () => { el.classList.remove('dragging'); dragging = null; });
    });

    $$('#vt-preview [data-vtdrop]').forEach((zone) => {
      zone.addEventListener('dragover', (e) => {
        if (!dragging || !zone.contains(dragging)) return;
        e.preventDefault();
        /*
         * The first tile that reads as coming after the pointer, in reading
         * order. Comparing x alone breaks the moment the tiles wrap onto a
         * second row — everything below counts as being to the left.
         */
        const after = $$('.tile.movable:not(.dragging)', zone).find((other) => {
          const box = other.getBoundingClientRect();
          return e.clientY < box.top
            || (e.clientY <= box.bottom && e.clientX < box.left + box.width / 2);
        });
        if (after) zone.insertBefore(dragging, after);
        else zone.append(dragging);
      });
      zone.addEventListener('drop', (e) => {
        if (!dragging || !zone.contains(dragging)) return;
        e.preventDefault();
        applyPreviewOrder(zone);
      });
    });
  }

  /** Read one preview row back into the list, and save. */
  function applyPreviewOrder(zone) {
    sync();
    const dropped = $$('.tile.movable', zone).map((el) => types[Number(el.dataset.vtat)]);
    // Where each of those types sat in the full list, so the ones this row
    // does not show — hidden types, and types on the other surface — keep
    // their places instead of being shuffled to the end.
    const slots = types.map((ty, i) => (dropped.includes(ty) ? i : null)).filter((i) => i !== null);
    slots.forEach((slot, i) => { types[slot] = dropped[i]; });
    draw();
    saveTypes.soon();
  }

  const draw = () => {
    list.innerHTML = types.map((ty, i) => `
      <div class="q-row" data-i="${i}">
        <div class="q-row-top">
          <button class="btn ghost icon-pick" type="button" data-vtpick="${i}"
            title="Choose the icon">${esc(ty.icon || '👤')}</button>
          <input class="input hidden" data-vticon="${i}" value="${esc(ty.icon || '👤')}">
          <input class="input" data-vtlabel="${i}" placeholder="Card name — e.g. Cleaner" value="${esc(ty.label || '')}">
          <select class="input" data-vtmode="${i}">
            ${MODES.map(([v, l]) => `<option value="${v}" ${ty.mode === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
          <button class="btn ghost" type="button" data-vtup="${i}" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button>
          <button class="btn ghost" type="button" data-vtdown="${i}" ${i === types.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
          ${ty.builtin ? '<span class="pill on" title="A standard type — hide it rather than removing it">built-in</span>'
            : `<button class="btn ghost" type="button" data-vtdel="${i}" title="Remove">✕</button>`}
        </div>
        <div class="two-col" style="margin-top:.5rem">
          <input class="input" data-vtsub="${i}" placeholder="Line under the name (optional)" value="${esc(ty.sub || '')}">
          <input class="input" data-vtlabeles="${i}" placeholder="Name en español (optional)" value="${esc(ty.label_es || '')}">
        </div>
        <div class="two-col" style="margin-top:.5rem">
          <input class="input" data-vtsubes="${i}" placeholder="Line under the name en español (optional)" value="${esc(ty.sub_es || '')}">
          <span class="muted" style="align-self:center">Key: <code>${esc(ty.key || '(from the name)')}</code>${
            keyDrifted(ty) ? ` — this type was renamed, so the key still says
              <code>${esc(ty.key)}</code>. <button class="btn link" type="button"
              data-vtrekey="${esc(ty.key)}" data-vtrekeyto="${esc(ty.label)}">Change it to
              <code>${esc(keyFromLabel(ty.label))}</code></button>` : ''}</span>
        </div>
      </div>`).join('');

    wireRekey();

    $$('[data-vtpick]', list).forEach((b) => b.addEventListener('click', () => {
      const i = Number(b.dataset.vtpick);
      pickEmoji(types[i].icon || '👤', (chosen) => {
        sync();
        types[i].icon = chosen;
        draw();
        saveTypes.soon();
      });
    }));

    $$('[data-vtdel]', list).forEach((b) => b.addEventListener('click', () => {
      sync(); types.splice(Number(b.dataset.vtdel), 1); draw(); saveTypes.soon();
    }));
    $$('[data-vtup]', list).forEach((b) => b.addEventListener('click', () => {
      sync(); const i = Number(b.dataset.vtup);
      [types[i - 1], types[i]] = [types[i], types[i - 1]]; draw(); saveTypes.soon();
    }));
    $$('[data-vtdown]', list).forEach((b) => b.addEventListener('click', () => {
      sync(); const i = Number(b.dataset.vtdown);
      [types[i + 1], types[i]] = [types[i], types[i + 1]]; draw(); saveTypes.soon();
    }));

    // The preview follows the typing, which is the point of having one.
    $$('input, select', list).forEach((el) => el.addEventListener('input', () => {
      sync(); drawPreview(); saveTypes.soon();
    }));
    drawPreview();
  };

  /*
   * A type's key is derived from its name once, when the type is created,
   * and then left alone — every visit ever recorded is stored against it.
   * Rename the type and the key stays as it was, which is correct and also
   * invisible, so this says when the two have parted company and offers to
   * put them back together. The move itself is the server's: see
   * server/rekey.js, which takes the visits, the bookings, the deleted
   * records and every per-type setting with it, or takes none of them.
   */
  const keyFromLabel = (label) => String(label || '').toLowerCase().trim()
    .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  const keyDrifted = (ty) => !!(ty && ty.key && ty.label && keyFromLabel(ty.label) !== ty.key);

  const wireRekey = () => $$('[data-vtrekey]', list).forEach((b) => b.addEventListener('click', async () => {
    const from = b.dataset.vtrekey;
    const to = keyFromLabel(b.dataset.vtrekeyto);
    /*
     * Asked first, and told exactly what moves. This rewrites the identity of
     * every historical visit of this type; somebody should press it having
     * read what it does, not having guessed.
     */
    modal(`Change the key to “${to}”?`,
      `<p>Every visit, booking and deleted record filed under <code>${esc(from)}</code> moves to
        <code>${esc(to)}</code> — along with this type's form, sign-in flow, wording, whether it is
        announced, who else is told, its own channel, its card design and its certificate rules.</p>
       <p class="muted">Nothing changes for anybody signing in: it is the same visitor type under a key
        that matches what you call it. All of it moves or none of it does.</p>`,
      async (bg, close) => {
        const out = await api(`/settings/types/${encodeURIComponent(from)}/rekey`,
          { method: 'POST', body: { to } });
        setSettings(out.settings);
        close();
        toast(out.message, 6000);
        render('vtypes');
      },
      'Change the key');
  }));

  const sync = () => {
    $$('[data-vtlabel]', list).forEach((el) => { types[Number(el.dataset.vtlabel)].label = el.value; });
    $$('[data-vticon]', list).forEach((el) => { types[Number(el.dataset.vticon)].icon = el.value; });
    $$('[data-vtsub]', list).forEach((el) => { types[Number(el.dataset.vtsub)].sub = el.value; });
    $$('[data-vtlabeles]', list).forEach((el) => { types[Number(el.dataset.vtlabeles)].label_es = el.value; });
    $$('[data-vtsubes]', list).forEach((el) => { types[Number(el.dataset.vtsubes)].sub_es = el.value; });
    $$('[data-vtmode]', list).forEach((el) => { types[Number(el.dataset.vtmode)].mode = el.value; });
  };

  // A new type's key comes from its name, and must not collide with another
  // type or with the fixed home-screen cards.
  const keyFor = (label) => {
    const base = String(label).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'type';
    const taken = new Set([...types.map((ty) => ty.key), 'signin', 'signout', 'delivery', 'unlock', 'menu', 'idle']);
    let key = base, n = 2;
    while (taken.has(key)) key = `${base}-${n++}`;
    return key;
  };

  $('#vt-add').addEventListener('click', () => {
    sync();
    types.push({ key: '', label: '', label_es: '', sub: '', sub_es: '', icon: '🪪', mode: 'picker', builtin: false });
    draw();
    const inputs = $$('[data-vtlabel]', list);
    if (inputs.length) inputs[inputs.length - 1].focus();
  });

  /*
   * Saving is held back while any card has no name.
   *
   * A save drops nameless types — that is how a half-added one is discarded
   * — so auto-saving mid-rename, in the moment after the old name is cleared
   * and before the new one is typed, would delete the card. The pill says
   * why nothing is being saved rather than leaving it a mystery.
   */
  const saveTypes = autoSave(async () => {
    sync();
    const named = types.filter((ty) => String(ty.label || '').trim());
    named.forEach((ty) => { if (!ty.key) ty.key = keyFor(ty.label); });
    setSettings(await api('/settings', { method: 'PUT', body: { types: named } }));
    if (SETTINGS.warnings && SETTINGS.warnings.length) toast(SETTINGS.warnings.join(' '), 7000);
  }, () => {
    sync();
    if (types.some((ty) => !String(ty.label || '').trim())) return 'Not saved — every card needs a name';
    if (!types.length) return 'Not saved — keep at least one visitor type';
    if (!types.some((ty) => ty.mode !== 'off')) return 'Not saved — every type is hidden, nobody could sign in';
    return null;
  });

  const langPicker = $('#vt-lang');
  if (langPicker) langPicker.addEventListener('change', drawPreview);

  draw();
};

function badgeFormValues() {
  const b = {};
  $$('[data-set^="badge."]').forEach((i) => {
    b[i.dataset.set.split('.')[1]] = i.type === 'checkbox' ? i.checked : i.type === 'number' ? Number(i.value) : i.value;
  });
  return b;
}

function drawBadgePreview() {
  const box = $('#badge-preview');
  if (!box) return;
  const b = badgeFormValues();
  const scale = 3.78 * 0.75; // px per mm at preview scale
  const w = (b.label_width_mm || 62) * scale;
  const h = (b.label_height_mm || 100) * scale;
  const landscape = b.orientation === 'landscape';

  // The label keeps its physical size; a horizontal badge is turned on it, which
  // is exactly what the printed version does.
  box.style.width = `${w}px`;
  box.style.height = `${h}px`;
  box.classList.toggle('landscape', landscape);
  box.style.setProperty('--inner-w', `${landscape ? h : w}px`);
  box.style.setProperty('--inner-h', `${landscape ? w : h}px`);
  box.style.setProperty('--turn', landscape ? `translateX(${w}px) rotate(90deg)` : 'none');

  box.innerHTML = `<div class="b-inner">
    ${b.show_logo && SETTINGS.org.logo_path ? `<img src="${esc(SETTINGS.org.logo_path)}" style="max-height:26px;margin-bottom:4px">` : ''}
    <div class="b-type">${esc(b.title_text || 'VISITOR')}</div>
    ${b.show_photo ? '<div class="b-photo">photo</div>' : ''}
    <div class="b-name">John Doe</div>
    ${b.show_company ? '<div class="b-company">Example Roofing Ltd</div>' : ''}
    <div class="b-meta">${[b.show_host ? 'Visiting: Jane Doe' : '', b.show_date ? new Date().toLocaleDateString('en-GB', { timeZone: siteZone() }) : '',
      b.show_time ? new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: siteZone() }) : '',
      // Same date the server would put on a real one: the site's, not UTC.
      b.show_badge_no ? `${b.badge_prefix || 'V'}${new Date().toLocaleDateString('en-CA', { timeZone: siteZone() }).slice(2).replace(/-/g, '')}-001` : '']
      .filter(Boolean).join('<br>')}</div>
    ${b.show_qr ? '<div class="b-qr"></div>' : ''}
    <div class="b-foot">${esc(b.footer_text || '')}</div></div>`;
}

function printTestBadge() {
  const b = badgeFormValues();
  const w = window.open('', '_blank', 'width=420,height=640');
  w.document.write(`<!doctype html><title>Badge test</title><style>
    @page { size: ${b.label_width_mm}mm ${b.label_height_mm}mm; margin: 0; }
    body { margin:0; font-family: system-ui, sans-serif; }
    .card { width:${b.label_width_mm}mm; height:${b.label_height_mm}mm; padding:4mm; display:flex; flex-direction:column;
            align-items:center; text-align:center; box-sizing:border-box; }
    .type { font-weight:800; letter-spacing:.18em; font-size:calc(4.4mm * ${b.font_scale || 1}); }
    .photo { width:30mm; height:30mm; border:1px dashed #999; border-radius:2mm; margin:2mm 0; display:grid; place-items:center; font-size:3mm; color:#777 }
    .name { font-weight:800; font-size:calc(5.6mm * ${b.font_scale || 1}); margin-top:1mm }
    .company { font-size:calc(3.6mm * ${b.font_scale || 1}) }
    .meta { font-size:calc(3.2mm * ${b.font_scale || 1}); margin-top:1.5mm; line-height:1.4 }
    .qr { width:22mm; height:22mm; margin-top:auto; background:repeating-conic-gradient(#000 0 25%,#fff 0 50%) 0 0/4mm 4mm }
    .foot { font-size:calc(2.6mm * ${b.font_scale || 1}); margin-top:1.5mm }
  </style><div class="card">
    <div class="type">${esc(b.title_text || 'VISITOR')}</div>
    ${b.show_photo ? '<div class="photo">photo</div>' : ''}
    <div class="name">Test Badge</div>
    ${b.show_company ? '<div class="company">Alignment check</div>' : ''}
    <div class="meta">${[b.show_host ? 'Visiting: Reception' : '', b.show_date ? new Date().toLocaleDateString('en-GB', { timeZone: siteZone() }) : '',
      b.show_badge_no ? `${b.badge_prefix || 'V'}-TEST` : ''].filter(Boolean).join('<br>')}</div>
    ${b.show_qr ? '<div class="qr"></div>' : ''}
    <div class="foot">${esc(b.footer_text || '')}</div></div>`);
  w.document.close();
  setTimeout(() => w.print(), 400);
}

