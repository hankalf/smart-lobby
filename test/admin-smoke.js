'use strict';
const { chromium, launchOptions } = require('./browser');
(async () => {
  const browser = await chromium.launch({ ...launchOptions(), });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${process.env.BASE_URL || 'http://localhost:3401'}/admin/`);
  await page.fill('#gate-email', 'owner@example.test');
  await page.fill('#gate-pass', 'Testing123!');
  await page.click('#gate-submit');
  await page.waitForSelector('#shell:not(.hidden)', { timeout: 8000 });
  // A page listed under a heading is only clickable once that heading is open.
  const go = async (view) => {
    const parent = await page.evaluate((v) => {
      const child = document.querySelector(`#nav .subnav button[data-view="${v}"]`);
      return child ? child.closest('.subnav').dataset.for : null;
    }, view);
    if (parent) await page.click(`#nav > button[data-view="${parent}"]`);
    await page.click(`#nav [data-view="${view}"]`);
  };
  for (const view of ['induction', 'devices', 'vtypes', 'projects', 'printers', 'documents', 'visits', 'settings']) {
    await go(view).catch(() => {});
    await page.waitForTimeout(700);
  }
  await go('induction');
  await page.waitForSelector('[data-edit]');
  await page.click('[data-edit]');
  await page.waitForSelector('#dk-sig', { timeout: 5000 });
  console.log('deck settings shows signature checkbox, checked =', await page.$eval('#dk-sig', (el) => el.checked));
  // documents view: the new frequency control
  await page.click('.modal-bg [data-close]');
  await go('documents');
  await page.waitForSelector('[data-doc]');
  await page.click('[data-doc]');
  await page.waitForSelector('#ag-repeat-mode', { timeout: 5000 });
  console.log('document editor shows frequency select =', await page.$eval('#ag-repeat-mode', (el) => el.value));
  await page.selectOption('#ag-repeat-mode', 'days');
  console.log('days input appears =', await page.$eval('#ag-repeat-days-wrap', (el) => !el.hidden));
  await page.click('.modal-bg [data-close]');
  // devices view: copy button + link column
  await go('devices');
  await page.waitForSelector('[data-dvcopy]');
  console.log('devices row link:', await page.$eval('td code.token', (el) => el.textContent));
  console.log('page errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error('CRASH', e.message); process.exit(1); });
