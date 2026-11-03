/**
 * Audits the rendered result screen at three widths: contrast against real
 * computed backgrounds, tap targets, horizontal overflow, and the geometry of
 * the scale bar. Fails the process (exit 1) if anything regresses.
 *
 *   npm run audit            # needs `npm start` on :4317
 *   BASE=http://127.0.0.1:4400 npm run audit
 *
 * Report: scratch/audit.json   Screenshots: scratch/shots/revamp-*.png
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:4317';
const SENTENCE =
  'I am a 34 year old tailor in Hyderabad, I make about 2.4 lakh a year, two kids in school';
const OUT = 'scratch/shots';
fs.mkdirSync(OUT, { recursive: true });

const PROBE = `() => {
  const rgb = (c) => { const m = c.match(/\\d+(\\.\\d+)?/g); return m ? m.slice(0, 4).map(Number) : null; };
  const lum = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); })
    .reduce((acc, v, i) => acc + v * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const bgOf = (el) => {
    let e = el;
    while (e) {
      const c = getComputedStyle(e).backgroundColor;
      if (c && c !== 'rgba(0, 0, 0, 0)') { const p = rgb(c); if (p && (p.length < 4 || p[3] === 1)) return p; }
      e = e.parentElement;
    }
    return [255, 255, 255];
  };
  const vw = window.innerWidth;
  const low = [];
  const sel = '.verdict h2, .verdict .res-sub, .legend dt, .legend dd, .sortnote, .card h3, .card .money, .card .money small, .meta-line, .why li, .gap, .miss .detail, .lh-label, .cols span, .also-row, .section-head p, .sheet .rule-row dd';
  for (const el of document.querySelectorAll(sel)) {
    const cs = getComputedStyle(el);
    if (!el.textContent.trim() || cs.visibility === 'hidden') continue;
    const size = parseFloat(cs.fontSize);
    const bold = Number(cs.fontWeight) >= 700;
    const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
    const r = ratio(rgb(cs.color), bgOf(el));
    if (r < need) low.push({ text: el.textContent.trim().slice(0, 34), cls: String(el.className).slice(0, 20), ratio: Math.round(r * 100) / 100, need, size });
  }
  const wide = [...document.querySelectorAll('body *')]
    .filter((el) => { const b = el.getBoundingClientRect(); return b.width > vw + 1 && b.height > 4; })
    .map((el) => ({ tag: el.tagName, cls: String(el.className).slice(0, 24), w: Math.round(el.getBoundingClientRect().width) }))
    .slice(0, 6);
  const small = [...document.querySelectorAll('button, input, textarea, a[href]')]
    .map((el) => ({ tag: el.tagName, t: (el.textContent || '').trim().slice(0, 22), h: Math.round(el.getBoundingClientRect().height) }))
    .filter((x) => x.h > 0 && x.h < 44 && x.tag !== 'A');
  const bars = [...document.querySelectorAll('.scale-bar span')].map((s) => Math.round((s.getBoundingClientRect().width / s.parentElement.getBoundingClientRect().width) * 1000) / 10);
  const cols = document.querySelector('.cols');
  const row = document.querySelector('.card');
  return {
    overflow: document.documentElement.scrollWidth - vw,
    lowContrast: low.slice(0, 8),
    wide,
    smallTargets: small.slice(0, 8),
    barSegmentsPct: bars,
    legend: [...document.querySelectorAll('.legend dd')].map((d) => d.textContent),
    colsPresent: Boolean(cols),
    rowCols: row ? getComputedStyle(row).gridTemplateColumns : null,
    fonts: [...new Set([...document.querySelectorAll('h1,h2,h3,.money,body')].map((el) => getComputedStyle(el).fontFamily.split(',')[0]))],
  };
}`;

const browser = await chromium.launch({ channel: 'chrome' });
const report = { base: BASE, widths: [] };

for (const width of [1440, 1024, 390]) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.fill('#story', SENTENCE);
  await page.click('button[type=submit]');
  await page.waitForSelector('.res-head', { timeout: 30000 });
  await page.waitForTimeout(500);
  const r = await page.evaluate(`(${PROBE})()`);
  report.widths.push({ width, ...r, errors });
  await page.screenshot({ path: `${OUT}/revamp-${width}.png`, fullPage: width === 1440 });
  if (width === 1440) {
    await page.locator('.also .linkbtn').first().click();
    await page.waitForTimeout(300);
    await page.locator('.also').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${OUT}/revamp-tail.png` });
    await page.locator('.receipts').scrollIntoViewIfNeeded();
    await page.locator('.receipts summary').click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/revamp-receipt.png` });
    await page.locator('.card .linkbtn').first().click();
    await page.waitForSelector('.sheet');
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/revamp-sheet.png` });
  }
  await page.close();
}

await browser.close();
fs.writeFileSync('scratch/audit.json', JSON.stringify(report, null, 2));

let failed = 0;
for (const w of report.widths) {
  const line = `${w.width}px  overflow ${w.overflow}  sub-AA ${w.lowContrast.length}  targets<44 ${w.smallTargets.length}  errors ${w.errors.length}  bar ${w.barSegmentsPct.join('/')}%  grid ${w.rowCols}`;
  console.log(line);
  if (w.overflow > 0 || w.lowContrast.length || w.smallTargets.length || w.errors.length) failed++;
}
console.log(failed ? `\nFAIL on ${failed} width(s) - see scratch/audit.json` : '\nPASS: no overflow, no sub-AA text, no small targets, no console errors');
process.exit(failed ? 1 : 0);
