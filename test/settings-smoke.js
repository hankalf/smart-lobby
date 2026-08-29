'use strict';
const { chromium, launchOptions } = require('./browser');
(async () => {
  const browser = await chromium.launch({ ...launchOptions(), });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${process.env.BASE_URL || 'http://localhost:3401'}/admin/`);
  await page.fill('#gate-email', 'hankalfr@gmail.com');
  await page.fill('#gate-pass', 'Testing123!');
  await page.click('#gate-submit');
  await page.waitForSelector('#shell:not(.hidden)', { timeout: 8000 });
  await page.click('[data-view="settings"]');
  // The panels are folded by default now; this suite reads across all of them.
  await page.waitForSelector('#sec-expand', { timeout: 8000 });
  await page.click('#sec-expand');
  await page.waitForSelector('#notify-log table, #notify-log .empty', { timeout: 8000 });
  console.log('activity summary:', await page.$eval('#notify-summary', (el) => el.textContent.trim()));
  console.log('log rows:', await page.$$eval('#notify-log tbody tr', (els) => els.length));
  await page.click('#notify-refresh');
  await page.waitForTimeout(600);
  // Teams replaced email: the channel link, its test button, and no email leftovers
  console.log('teams channel field present:', await page.$('[data-set="notify.global_webhook_url"]') !== null);
  console.log('teams test button label:', await page.$eval('#test-hook', (el) => el.textContent.trim()));
  const body = await page.$eval('body', (el) => el.innerText);
  console.log('no SMTP wording left:', !/SMTP|smtp/.test(body));
  console.log('no email fields left:', await page.$('[data-set="notify.smtp_host"]') === null
    && await page.$('#email-provider') === null && await page.$('#test-email') === null);
  console.log('default format is Teams:', await page.$eval('[data-set="notify.webhook_format"]', (el) => el.value));
  console.log('page errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error('CRASH', e.message); process.exit(1); });
