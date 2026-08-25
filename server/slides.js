'use strict';
/**
 * Turns an uploaded induction deck into a list of slides the kiosk can show.
 *
 * Fidelity ladder:
 *   1. LibreOffice + poppler present  -> render every slide to a PNG (pixel perfect)
 *   2. PPTX only                      -> parse the OOXML and rebuild each slide as HTML
 *   3. PDF with no poppler            -> embed the PDF as a single scrollable slide
 *   4. Images                         -> stored as-is, one slide per image
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { readZip } = require('./unzip');
const { saveBuffer, PUBLIC_DIR } = require('./files');
const { run, all, get, nowISO } = require('./db');
const { DATA_DIR } = require('./db');

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

function which(bin) {
  const probe = process.platform === 'win32'
    ? spawnSync('where', [bin], { encoding: 'utf8' })
    : spawnSync('which', [bin], { encoding: 'utf8' });
  if (probe.status === 0 && probe.stdout.trim()) return probe.stdout.trim().split(/\r?\n/)[0];
  return null;
}

function findSoffice() {
  const candidates = ['soffice', 'libreoffice'];
  for (const c of candidates) { const p = which(c); if (p) return p; }
  const guesses = [
    'C:/Program Files/LibreOffice/program/soffice.exe',
    'C:/Program Files (x86)/LibreOffice/program/soffice.exe',
    '/usr/bin/soffice', '/usr/bin/libreoffice', '/opt/libreoffice/program/soffice'
  ];
  return guesses.find((g) => fs.existsSync(g)) || null;
}

function capabilities() {
  return { libreoffice: !!findSoffice(), poppler: !!which('pdftoppm') };
}

const xmlUnescape = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/&amp;/g, '&');

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function tmpDir(prefix) {
  const dir = path.join(DATA_DIR, 'tmp', `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function convertToPdf(inputPath, workDir) {
  const soffice = findSoffice();
  if (!soffice) return null;
  const res = spawnSync(soffice, ['--headless', '--norestore', '--convert-to', 'pdf', '--outdir', workDir, inputPath],
    { encoding: 'utf8', timeout: 180000 });
  if (res.error) return null;
  const pdf = fs.readdirSync(workDir).find((f) => f.toLowerCase().endsWith('.pdf'));
  return pdf ? path.join(workDir, pdf) : null;
}

function pdfToPngs(pdfPath, workDir) {
  if (!which('pdftoppm')) return null;
  const outBase = path.join(workDir, 'slide');
  const res = spawnSync('pdftoppm', ['-png', '-r', '150', pdfPath, outBase], { encoding: 'utf8', timeout: 180000 });
  if (res.error) return null;
  const files = fs.readdirSync(workDir).filter((f) => f.startsWith('slide') && f.endsWith('.png')).sort();
  return files.length ? files.map((f) => path.join(workDir, f)) : null;
}

/** Rebuild slides as HTML straight from the PPTX package. */
function parsePptx(buffer, slideshowId) {
  const zip = readZip(buffer);
  const slideNames = [...zip.keys()]
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => (+a.match(/(\d+)/)[1]) - (+b.match(/(\d+)/)[1]));

  const mediaCache = new Map();
  const storeMedia = (target) => {
    const key = target.replace(/^\.\.\//, 'ppt/');
    if (mediaCache.has(key)) return mediaCache.get(key);
    const data = zip.get(key);
    if (!data) return null;
    const web = saveBuffer(data, 'public', `slides/${slideshowId}`, path.basename(key));
    mediaCache.set(key, web);
    return web;
  };

  const out = [];
  for (const name of slideNames) {
    const xml = zip.get(name).toString('utf8');
    const relsName = name.replace('ppt/slides/', 'ppt/slides/_rels/') + '.rels';
    const rels = new Map();
    const relsXml = zip.get(relsName) ? zip.get(relsName).toString('utf8') : '';
    for (const m of relsXml.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) rels.set(m[1], m[2]);

    // Paragraph text, in document order.
    const paragraphs = [];
    for (const p of xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
      const text = [...p[1].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => xmlUnescape(t[1])).join('');
      if (text.trim()) paragraphs.push(text.trim());
    }

    // Pictures referenced by this slide.
    const images = [];
    for (const b of xml.matchAll(/<a:blip[^>]*r:embed="([^"]+)"/g)) {
      const target = rels.get(b[1]);
      if (!target || !/media\//i.test(target)) continue;
      const web = storeMedia(target);
      if (web) images.push(web);
    }

    const title = paragraphs.shift() || '';
    const bullets = paragraphs;
    const html = [
      '<div class="pptx-slide">',
      title ? `<h1>${esc(title)}</h1>` : '',
      bullets.length ? `<ul>${bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : '',
      images.length ? `<div class="pptx-media">${images.map((i) => `<img src="${esc(i)}" alt="">`).join('')}</div>` : '',
      '</div>'
    ].join('');

    out.push({ kind: 'html', html, caption: title || null });
  }
  return out;
}

function replaceSlides(slideshowId, slides) {
  run('DELETE FROM slides WHERE slideshow_id = ?', slideshowId);
  slides.forEach((s, i) => {
    run('INSERT INTO slides (slideshow_id, position, kind, image_path, html, caption) VALUES (?,?,?,?,?,?)',
      slideshowId, i, s.kind, s.image_path || null, s.html || null, s.caption || null);
  });
  run('UPDATE slideshows SET version = version + 1, updated_at = ? WHERE id = ?', nowISO(), slideshowId);
}

/**
 * @param {{buffer: Buffer, originalname: string}} file
 * @returns {{count: number, method: string, note?: string}}
 */
function ingest(file, slideshowId) {
  const ext = path.extname(file.originalname || '').toLowerCase();

  if (IMAGE_EXT.has(ext)) {
    const web = saveBuffer(file.buffer, 'public', `slides/${slideshowId}`, file.originalname);
    const existing = all('SELECT id FROM slides WHERE slideshow_id = ?', slideshowId).length;
    run('INSERT INTO slides (slideshow_id, position, kind, image_path) VALUES (?,?,?,?)',
      slideshowId, existing, 'image', web);
    run('UPDATE slideshows SET version = version + 1, updated_at = ? WHERE id = ?', nowISO(), slideshowId);
    return { count: existing + 1, method: 'image' };
  }

  const isPptx = ext === '.pptx' || ext === '.ppt' || ext === '.odp';
  const isPdf = ext === '.pdf';
  if (!isPptx && !isPdf) throw new Error('unsupported_file_type');

  const work = tmpDir('deck');
  try {
    const inputPath = path.join(work, `input${ext}`);
    fs.writeFileSync(inputPath, file.buffer);

    let pdfPath = isPdf ? inputPath : convertToPdf(inputPath, work);
    const pngs = pdfPath ? pdfToPngs(pdfPath, work) : null;

    if (pngs && pngs.length) {
      const slides = pngs.map((p) => ({
        kind: 'image',
        image_path: saveBuffer(fs.readFileSync(p), 'public', `slides/${slideshowId}`, path.basename(p))
      }));
      replaceSlides(slideshowId, slides);
      run('UPDATE slideshows SET source_file = ? WHERE id = ?', file.originalname, slideshowId);
      return { count: slides.length, method: 'rendered' };
    }

    if (isPptx && ext === '.pptx') {
      const slides = parsePptx(file.buffer, slideshowId);
      if (slides.length) {
        replaceSlides(slideshowId, slides);
        run('UPDATE slideshows SET source_file = ? WHERE id = ?', file.originalname, slideshowId);
        return {
          count: slides.length,
          method: 'parsed',
          note: 'Rebuilt from PowerPoint text and images. Install LibreOffice + poppler for pixel-perfect slides, or upload a PDF export.'
        };
      }
    }

    if (isPdf) {
      const web = saveBuffer(file.buffer, 'public', `slides/${slideshowId}`, file.originalname);
      replaceSlides(slideshowId, [{ kind: 'pdf', image_path: web }]);
      run('UPDATE slideshows SET source_file = ? WHERE id = ?', file.originalname, slideshowId);
      return { count: 1, method: 'pdf-embed', note: 'Shown as a scrollable PDF. Install poppler (pdftoppm) to split it into slides.' };
    }

    throw new Error('could_not_read_deck');
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

module.exports = { ingest, capabilities, replaceSlides };
