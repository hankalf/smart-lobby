'use strict';
/**
 * Finding Playwright and a browser to drive, wherever the tests are run.
 *
 * The suites used to name one absolute path each for the Playwright install
 * and the Chromium binary, which worked on exactly the machine they were
 * written on. This looks in the usual places instead, and says something
 * useful when it finds nothing rather than throwing a module-not-found.
 */
const fs = require('fs');

const PLAYWRIGHT_PATHS = [
  'playwright',
  '@playwright/test',
  '/opt/node22/lib/node_modules/playwright',
  '/usr/lib/node_modules/playwright'
];

function load() {
  for (const p of PLAYWRIGHT_PATHS) {
    try { return require(p); } catch { /* try the next */ }
  }
  return null;
}

const playwright = load();

/** Whether the browser suites can run at all. */
const available = () => !!playwright;

/**
 * Where Chromium is. PLAYWRIGHT_BROWSERS_PATH installs land in a versioned
 * directory, so the newest match wins; left unset, Playwright finds its own.
 */
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
    const versioned = fs.readdirSync(root).filter((d) => d.startsWith('chromium')).sort().reverse();
    for (const d of versioned) {
      const exe = `${root}/${d}/chrome-linux/chrome`;
      if (fs.existsSync(exe)) return exe;
    }
  } catch { /* nothing there */ }
  return undefined;
}

const launchOptions = () => {
  const exe = executablePath();
  return exe ? { executablePath: exe } : {};
};

module.exports = {
  available,
  executablePath,
  launchOptions,
  get chromium() {
    if (!playwright) {
      throw new Error('Playwright is not installed — run `npm install -D playwright` to include the browser suites.');
    }
    return playwright.chromium;
  }
};
