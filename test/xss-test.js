'use strict';
const { chromium, launchOptions } = require('./browser');
(async () => {
  const browser = await chromium.launch({ ...launchOptions(), });
  const page = await browser.newPage();
  let alerted = false;
  page.on('dialog', async (d) => { alerted = true; await d.dismiss(); });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${process.env.BASE_URL || 'http://localhost:3401'}/admin/`);
  await page.fill('#gate-email', 'owner@example.test');
  await page.fill('#gate-pass', 'Testing123!');
  await page.click('#gate-submit');
  await page.waitForSelector('#shell:not(.hidden)', { timeout: 8000 });
  // the visitor registry lists everyone ever seen, so the crafted name is there
  await page.click('[data-view="visitors"]');
  await page.waitForTimeout(1500);
  const q = await page.$('#v-q, #visitor-q, input[placeholder*="Search" i]');
  if (q) { await q.fill('script'); await page.waitForTimeout(1200); }
  const shown = await page.$eval('body', (el) => el.innerText).catch(() => '');
  console.log('script-tag name rendered as text:', shown.includes('<script>alert(1)</script>'));
  console.log('no alert fired (XSS blocked):', !alerted);
  console.log('page errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(alerted || errors.length ? 1 : 0);
})().catch((e) => { console.error('CRASH', e.message); process.exit(1); });
