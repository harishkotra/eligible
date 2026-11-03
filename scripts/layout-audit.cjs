#!/usr/bin/env node
/**
 * Layout audit for a running UI.
 *
 *   npm i playwright-core
 *   node layout-audit.js http://localhost:5173 1600,1440,1180,900,420
 *
 * Uses the installed Chrome through channel: 'chrome', so no browser download.
 * Prints one line per width and exits non-zero if any width has page overflow,
 * a clipped row, or a page/console error. Screenshots land in /tmp/layout-<width>.png.
 */
const { chromium } = require('playwright-core');

const URL = process.argv[2] || 'http://localhost:5173';
const WIDTHS = (process.argv[3] || '1600,1440,1180,900,420').split(',').map(Number);
const ROW_SELECTOR = process.env.ROW_SELECTOR || '.feed-row';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  let failures = 0;

  for (const width of WIDTHS) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message.slice(0, 160)}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text().slice(0, 160));
    });

    try {
      await page.goto(URL, { waitUntil: 'networkidle', timeout: 45000 });
    } catch (err) {
      console.log(`FAIL ${width}px  could not load ${URL}: ${err.message.slice(0, 120)}`);
      failures += 1;
      await page.close();
      continue;
    }
    // let the first data poll land, so rows and long values are present
    await page.waitForTimeout(1800);

    const metrics = await page.evaluate((selector) => {
      const doc = document.documentElement;
      const vw = doc.clientWidth;
      const offenders = [];
      document.querySelectorAll('*').forEach((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.height > 0 && rect.width > vw + 1) {
          const cls = String(el.className || '').slice(0, 40);
          offenders.push(`${el.tagName.toLowerCase()}${cls ? '.' + cls : ''} @${Math.round(rect.width)}px`);
        }
      });
      const rows = Array.from(document.querySelectorAll(selector));
      const clipped = rows.filter((row) => row.scrollWidth > row.clientWidth + 2).length;
      return {
        overflowX: doc.scrollWidth - vw,
        rows: rows.length,
        clipped,
        offenders: offenders.slice(0, 5),
      };
    }, ROW_SELECTOR);

    const bad = metrics.overflowX > 0 || metrics.clipped > 0 || errors.length > 0;
    if (bad) failures += 1;
    console.log(
      `${bad ? 'FAIL' : 'ok  '} ${width}px  overflow=${metrics.overflowX}  rows=${metrics.rows}  ` +
        `clipped=${metrics.clipped}  errors=${errors.length}`,
    );
    metrics.offenders.forEach((entry) => console.log(`     wider than viewport: ${entry}`));
    errors.slice(0, 3).forEach((entry) => console.log(`     ${entry}`));

    await page.screenshot({ path: `/tmp/layout-${width}.png` });
    await page.close();
  }

  await browser.close();
  if (failures) console.log(`\n${failures} width(s) failed`);
  process.exit(failures ? 1 : 0);
})();
