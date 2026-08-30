#!/usr/bin/env node
'use strict';
/**
 * Turns the guide sources into PDFs.
 *
 *   node docs/build.js
 *
 * The sources in this folder are HTML fragments — body content only. This
 * wraps each one in the shared stylesheet and prints it through Chromium,
 * which is what gives real page breaks, running footers and page numbers.
 * Writing them as HTML rather than in a PDF library means the wording can be
 * edited by anyone, and diffs are readable.
 *
 * The fonts are the ones installed on the machine, deliberately: a guide that
 * fetches a webfont at render time comes out in a fallback face the day the
 * network is down, and nobody notices until it is printed.
 */
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const CSS = fs.readFileSync(path.join(HERE, 'guide.css'), 'utf8');

const GUIDES = [
  { src: 'front-desk-guide.html', out: 'Smart Lobby - Front Desk Guide.pdf', title: 'Smart Lobby — Front Desk Guide' },
  { src: 'administrator-guide.html', out: 'Smart Lobby - Administrator Guide.pdf', title: 'Smart Lobby — Administrator Guide' }
];

/** Playwright, wherever it happens to be installed. */
function chromium() {
  for (const p of ['playwright', '@playwright/test', '/opt/node22/lib/node_modules/playwright']) {
    try { return require(p).chromium; } catch { /* try the next */ }
  }
  return null;
}

/** Chromium's own binary, when PLAYWRIGHT_BROWSERS_PATH points somewhere. */
function executablePath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root) return undefined;
  for (const candidate of [`${root}/chromium`, root]) {
    try {
      if (fs.existsSync(`${candidate}/chrome-linux/chrome`)) return `${candidate}/chrome-linux/chrome`;
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch { /* keep looking */ }
  }
  try {
    for (const d of fs.readdirSync(root).filter((n) => n.startsWith('chromium')).sort().reverse()) {
      const exe = `${root}/${d}/chrome-linux/chrome`;
      if (fs.existsSync(exe)) return exe;
    }
  } catch { /* nothing there */ }
  return undefined;
}

const page = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>${CSS}</style></head><body>${body}</body></html>`;

/*
 * The running foot. Chromium wants its own inline styles here — the page's
 * stylesheet does not reach the header and footer templates — and a font size
 * has to be stated or it renders at a default nobody would choose.
 */
const footer = (title) => `
  <div style="width:100%; font-family: Arial, sans-serif; font-size:7pt; color:#7d8b85;
              padding:0 32mm; display:flex; justify-content:space-between;">
    <span>${title}</span>
    <span class="pageNumber"></span>
  </div>`;

(async () => {
  const launcher = chromium();
  if (!launcher) {
    console.error('Playwright is not installed. Run: npm install -D playwright && npx playwright install chromium');
    process.exit(1);
  }
  const exe = executablePath();
  const browser = await launcher.launch(exe ? { executablePath: exe } : {});

  for (const guide of GUIDES) {
    const body = fs.readFileSync(path.join(HERE, guide.src), 'utf8');
    const tab = await browser.newPage();
    await tab.setContent(page(guide.title, body), { waitUntil: 'load' });
    await tab.pdf({
      path: path.join(HERE, guide.out),
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      // An empty header rather than none: Chromium draws its own date and URL
      // across the top otherwise.
      headerTemplate: '<span></span>',
      footerTemplate: footer(guide.title),
      margin: { top: '18mm', bottom: '20mm', left: '32mm', right: '32mm' }
    });
    await tab.close();
    const size = fs.statSync(path.join(HERE, guide.out)).size;
    console.log(`  ${guide.out.padEnd(42)} ${Math.round(size / 1024)}KB`);
  }

  await browser.close();
})().catch((err) => { console.error('Could not build the guides:', err); process.exit(1); });
