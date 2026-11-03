/**
 * End-to-end check. Drives the real page in a real browser and writes what it
 * found to scratch/e2e.json, plus screenshots for the record.
 *
 * Usage: node scripts/e2e.mjs [baseUrl]
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4317';
const OUT = 'scratch/shots';
fs.mkdirSync(OUT, { recursive: true });

const SENTENCE = 'I am a 34 year old tailor in Hyderabad, I make about 2.4 lakh a year, two kids in school';
const report = { base: BASE, steps: [], console: [] };

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
page.on('console', (m) => { if (m.type() === 'error') report.console.push(m.text()); });
page.on('pageerror', (e) => report.console.push(`pageerror: ${e.message}`));

await page.goto(BASE, { waitUntil: 'networkidle' });
report.steps.push({ step: 'load', title: await page.title(), h1: (await page.locator('h1').innerText()).replace(/\s+/g, ' ') });
await page.screenshot({ path: `${OUT}/1-hero.png`, fullPage: false });

await page.fill('#story', SENTENCE);
await page.click('button[type=submit]');
await page.waitForSelector('.res-head', { timeout: 30000 });
await page.waitForTimeout(400);

const head = await page.locator('.res-head h2').innerText();
await page.locator('.res-head').scrollIntoViewIfNeeded();
await page.waitForTimeout(300);
const sub = await page.locator('.res-sub').innerText();
const cards = await page.locator('.card').count();
const misses = await page.locator('.miss').count();
const firstCard = (await page.locator('.card').first().innerText()).split('\n').filter(Boolean).slice(0, 6);
const chips = await page.locator('.pb-chip').allInnerTexts();
report.steps.push({ step: 'search', head, sub: sub.replace(/\s+/g, ' '), cards, misses, chips, firstCard });
await page.screenshot({ path: `${OUT}/2-results.png`, fullPage: false });

// The long tail: 476 names behind one click.
const alsoBtn = page.locator('.also .linkbtn').first();
if (await alsoBtn.count()) {
  await alsoBtn.click();
  await page.waitForTimeout(300);
  const alsoCount = await page.locator('.also-list li').count();
  report.steps.push({ step: 'longtail', alsoCount });
  await page.locator('.also').scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/2b-longtail.png` });
  await alsoBtn.click();
  await page.waitForTimeout(200);
}

await page.locator('.card .linkbtn').first().click();
await page.waitForSelector('.sheet', { timeout: 5000 });
await page.waitForTimeout(300);
const sheetTitle = await page.locator('.sheet h2').innerText();
const sheetBlocks = await page.locator('.sheet .block h4').allInnerTexts();
report.steps.push({ step: 'detail', sheetTitle, sheetBlocks });
await page.screenshot({ path: `${OUT}/3-detail.png` });
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

await page.locator('.receipts summary').click();
await page.waitForTimeout(250);
const receipts = await page.locator('.receipts .stat').allInnerTexts();
const queries = await page.locator('.receipts .q').allInnerTexts();
report.steps.push({ step: 'receipts', receipts: receipts.map((r) => r.replace(/\n/g, ' ')), queries: queries.slice(1) });
await page.locator('.receipts').scrollIntoViewIfNeeded();
await page.screenshot({ path: `${OUT}/4-receipts.png` });

// Edit the profile through the UI and confirm the answer changes.
await page.locator('.pb-edit').click();
await page.waitForSelector('.panel');
const income = page.locator('.panel input').nth(1);
await income.fill('900000');
await page.locator('.panel .btn').click();
await page.waitForTimeout(2500);
report.steps.push({
  step: 'edit',
  headAfter: await page.locator('.res-head h2').innerText(),
  chipsAfter: await page.locator('.pb-chip').allInnerTexts(),
});
await page.screenshot({ path: `${OUT}/5-edited.png` });

// Mobile pass.
const m = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await m.goto(BASE, { waitUntil: 'networkidle' });
await m.fill('#story', SENTENCE);
await m.click('button[type=submit]');
await m.waitForSelector('.res-head', { timeout: 30000 });
await m.waitForTimeout(400);
await m.locator('.res-head').scrollIntoViewIfNeeded();
await m.waitForTimeout(300);
const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const tapTargets = await m.evaluate(() =>
  [...document.querySelectorAll('button, a, input, textarea')]
    .map((el) => ({ tag: el.tagName, text: (el.textContent || '').trim().slice(0, 24), h: el.getBoundingClientRect().height }))
    .filter((x) => x.h > 0 && x.h < 44),
);
report.steps.push({ step: 'mobile', horizontalOverflowPx: overflow, under44: tapTargets.slice(0, 10), under44Count: tapTargets.length });
await m.screenshot({ path: `${OUT}/6-mobile.png`, fullPage: false });

await browser.close();
fs.writeFileSync('scratch/e2e.json', JSON.stringify(report, null, 2));
console.log('steps', report.steps.length, 'consoleErrors', report.console.length);
