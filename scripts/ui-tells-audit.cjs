#!/usr/bin/env node
/**
 * ui-tells-audit.js — the checks layout-audit.js does not make.
 *
 *   npm i playwright-core
 *   node ui-tells-audit.js http://localhost:5173 1440,1180,860
 *
 * Reports, per viewport: which font families actually loaded and which elements fell back to a
 * system stack, text below 4.5:1 contrast against its own background, elements pushed past the
 * viewport, clipped text, and sibling boxes that genuinely overlap in both axes.
 *
 * Exit code 1 if anything is wrong, so it works as a gate. Screenshots are written next to the
 * cwd as ui-<width>.png; read those for hierarchy, not for correctness.
 */
const { chromium } = require('playwright-core');

const PROBE = `() => {
  const rgb = (c) => { const m = c.match(/\\d+(\\.\\d+)?/g); return m ? m.slice(0, 4).map(Number) : null; };
  const lum = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); })
    .reduce((acc, v, i) => acc + v * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };

  // nearest ancestor with a fully opaque background; alpha fills are treated as unknown
  const bgOf = (el) => {
    let e = el;
    while (e) {
      const c = getComputedStyle(e).backgroundColor;
      if (c && c !== 'rgba(0, 0, 0, 0)') {
        const p = rgb(c);
        if (p && (p.length < 4 || p[3] === 1)) return p;
      }
      e = e.parentElement;
    }
    return rgb(getComputedStyle(document.body).backgroundColor) || [255, 255, 255];
  };

  const families = new Set();
  document.fonts.forEach((f) => families.add(f.family.replace(/["']/g, '')));

  const textEls = [...document.querySelectorAll('h1,h2,h3,h4,p,span,b,em,li,td,th,dt,dd,button,a,label,code,pre')]
    .filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1))
    .filter((e) => e.getBoundingClientRect().width > 0);

  const vw = window.innerWidth;
  const fonts = [], contrast = [], offscreen = [], clipped = [], overlaps = [];
  const seen = new Set();

  for (const el of textEls) {
    const cs = getComputedStyle(el);
    const fam = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim();
    if (!seen.has(fam)) {
      seen.add(fam);
      fonts.push({ family: fam, webfont: families.has(fam), size: cs.fontSize, tag: el.tagName.toLowerCase() });
    }
    const fs = parseFloat(cs.fontSize);
    if (fs <= 18 && cs.color) {
      const fg = rgb(cs.color);
      if (fg && (fg.length < 4 || fg[3] > 0.5)) {
        const r = ratio(fg, bgOf(el));
        if (r < 4.5) contrast.push({ text: el.textContent.trim().slice(0, 40), ratio: Math.round(r * 100) / 100, size: cs.fontSize });
      }
    }
    const box = el.getBoundingClientRect();
    if (box.right > vw + 1 && box.width > 40) offscreen.push({ tag: el.tagName, w: Math.round(box.width), right: Math.round(box.right) });
    if (el.scrollWidth > el.clientWidth + 2 && ['hidden', 'clip', 'auto', 'scroll'].includes(cs.overflowX) && el.clientWidth > 0) {
      clipped.push({ tag: el.tagName, cls: String(el.className).slice(0, 30), scroll: el.scrollWidth, client: el.clientWidth });
    }
  }

  // real overlaps: direct children of every layout container, both axes must intersect
  const containers = [...document.querySelectorAll('main, section, article, header, footer, aside, [class*=col], [class*=grid], [class*=row]')];
  for (const host of containers) {
    const kids = [...host.children].filter((k) => { const r = k.getBoundingClientRect(); return r.height > 4 && r.width > 4; });
    for (let i = 0; i < kids.length; i++) {
      for (let j = i + 1; j < kids.length; j++) {
        const a = kids[i].getBoundingClientRect(), b = kids[j].getBoundingClientRect();
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ox > 4 && oy > 4) overlaps.push({ host: String(host.className).slice(0, 24), a: String(kids[i].className).slice(0, 24), b: String(kids[j].className).slice(0, 24), px: [Math.round(ox), Math.round(oy)] });
      }
    }
  }

  return {
    fonts, loadedFamilies: [...families], contrast: contrast.slice(0, 12), offscreen: offscreen.slice(0, 8),
    clipped: clipped.slice(0, 8), overlaps: overlaps.slice(0, 8),
    pageOverflow: document.documentElement.scrollWidth > vw,
  };
}`;

(async () => {
  const url = process.argv[2] || 'http://localhost:5173';
  const widths = (process.argv[3] || '1440,1180,860').split(',').map(Number);
  const browser = await chromium.launch({ channel: 'chrome' });
  let failed = false;

  for (const width of widths) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 2 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    // domcontentloaded, not networkidle: an SSE/websocket stream never goes idle
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3500);
    const r = await page.evaluate(`(${PROBE})()`);
    await page.screenshot({ path: `ui-${width}.png` });
    await page.close();

    const sysFonts = r.fonts.filter((f) => !f.webfont).map((f) => f.family);
    const bad = r.contrast.length || r.offscreen.length || r.clipped.length || r.overlaps.length || r.pageOverflow || errors.length;
    if (bad) failed = true;
    console.log(JSON.stringify({ width, ...r, pageErrors: errors, verdict: bad ? 'issues' : 'ok' }, null, 1));
    if (sysFonts.length) console.log(`  note: these stacks resolved outside loaded webfonts: ${sysFonts.join(', ')}`);
  }

  await browser.close();
  process.exit(failed ? 1 : 0);
})();
