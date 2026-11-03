/**
 * Ingest: CSV of scraped MyScheme pages -> the two shapes the app needs.
 *
 * 1. rows, which become 2,066 rows in Appwrite TablesDB
 * 2. embedText per row, which becomes 2,066 vectors in Appwrite VectorsDB
 *
 * Nothing is invented here. If a column is empty the field stays empty and the
 * rules engine treats it as "no rule stated" rather than a zero.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readScheme, STATES, NO_INCOME_CEILING } from '../server/extract.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const SRC = process.env.SCHEMES_CSV ?? path.join(root, 'data/source/schemes.csv');
const OUT = path.join(root, 'data/fixtures');

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
      continue;
    }
    field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some((v) => v.trim() !== '')) rows.push(row); }
  const header = rows.shift()!.map((h) => h.replace(/^\ufeff/, '').trim());
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

function bulletList(raw: string): string[] {
  const text = (raw ?? '').replace(/\r/g, '').trim();
  if (!text) return [];
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const bullets = lines
    .map((l) => l.replace(/^[•\-*\u2022]\s*/, '').replace(/^\d+[.)]\s*/, '').trim())
    .filter((l) => l.length > 2);
  const out = bullets.length > 1 ? bullets : text.split(/[;,]\s+/).map((p) => p.trim()).filter((p) => p.length > 2);
  return out.slice(0, 14).map((d) => (d.length > 90 ? `${d.slice(0, 88)}…` : d));
}

const csvPath = fs.existsSync(SRC) ? SRC : path.join(root, 'data/source/gov_myscheme_data.csv');
if (!fs.existsSync(csvPath)) {
  console.error(`No CSV at ${csvPath}. Run: npm run fetch:source`);
  process.exit(1);
}

const raw = fs.readFileSync(csvPath, 'utf8');
const rows = parseCsv(raw);
fs.mkdirSync(OUT, { recursive: true });

const seen = new Set<string>();
const schemes: Record<string, unknown>[] = [];
let skipped = 0;

for (const row of rows) {
  const slug = (row['Scheme Slug'] || '').trim().replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 36);
  const name = (row['Scheme Name'] || '').trim();
  if (!slug || !name) { skipped += 1; continue; }
  if (seen.has(slug)) { skipped += 1; continue; }
  seen.add(slug);

  const facts = readScheme(row);
  const tags = (row['Tags / Categories'] || '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 1 && t.length <= 28)
    .slice(0, 6);
  const documents = bulletList(row['Documents Required'] || '');
  const officialLink = (row['Official Link'] || row['MyScheme URL'] || '').trim();
  const summary = facts.summary;

  const embedText = [
    name,
    tags.join(', '),
    summary,
    facts.eligibilityExcerpt,
    facts.benefitLine,
  ]
    .filter(Boolean)
    .join('. ')
    .replace(/\s+/g, ' ')
    .slice(0, 900);

  schemes.push({
    slug,
    name,
    level: facts.level,
    jurisdiction: facts.jurisdiction,
    issuer: (row['State / UT / Ministry'] || '').trim().slice(0, 80),
    appMode: (row['Application Mode'] || '').trim(),
    tags,
    occupations: facts.occupations,
    categories: facts.categories,
    genders: facts.genders,
    womenOnly: facts.womenOnly,
    disabilityOnly: facts.disabilityOnly,
    minAge: facts.minAge,
    maxAge: facts.maxAge,
    hasAgeRule: facts.hasAgeRule,
    incomeCeiling: facts.incomeCeiling,
    hasIncomeRule: facts.hasIncomeRule,
    benefitAmount: facts.benefitAmount,
    benefitKind: facts.benefitKind,
    benefitLine: facts.benefitLine,
    docsCount: facts.docsCount,
    summary,
    ageClause: facts.ageClause,
    incomeClause: facts.incomeClause,
    eligibilityExcerpt: facts.eligibilityExcerpt,
    documents,
    officialLink,
    embedText,
  });
}

schemes.sort((a, b) => String(a.name).localeCompare(String(b.name)));

const states: Record<string, { name: string; total: number; own: number; central: number }> = {};
for (const s of schemes) {
  const j = String(s.jurisdiction);
  states[j] ??= { name: j, total: 0, own: 0, central: 0 };
  states[j].total += 1;
  if (s.level === 'central') states[j].central += 1;
  else states[j].own += 1;
}
// Every state can use every central scheme, so the headline count per state is
// own + All India. That is the number the picker shows.
const centralTotal = schemes.filter((s) => s.level === 'central').length;
const stateList = STATES.map((name) => {
  const own = states[name]?.own ?? 0;
  return { name, own, reachable: own + centralTotal };
}).sort((a, b) => b.own - a.own);

const withIncome = schemes.filter((s) => s.hasIncomeRule).length;
const withAge = schemes.filter((s) => s.hasAgeRule).length;
const withMoney = schemes.filter((s) => Number(s.benefitAmount) > 0).length;
const jurisdictions = Object.keys(states).length;

const meta = {
  builtAt: new Date().toISOString(),
  source: 'myscheme.gov.in public scheme pages, CSV scrape (Aryan-Pardeshi/gov-myscheme-dataset)',
  sourceRows: rows.length,
  schemes: schemes.length,
  skipped,
  central: schemes.length - schemes.filter((s) => s.level === 'state').length,
  stateLevel: schemes.filter((s) => s.level === 'state').length,
  jurisdictions,
  withIncomeRule: withIncome,
  withAgeRule: withAge,
  withMoney,
  docsTotal: schemes.reduce((n, s) => n + (Array.isArray(s.documents) ? s.documents.length : 0), 0),
  incomeCeilingSentinel: NO_INCOME_CEILING,
  embedChars: schemes.reduce((n, s) => n + String(s.embedText).length, 0),
  approxEmbedTokens: Math.round(schemes.reduce((n, s) => n + String(s.embedText).length, 0) / 4),
};

fs.writeFileSync(path.join(OUT, 'schemes.json'), JSON.stringify(schemes));
fs.writeFileSync(path.join(OUT, 'states.json'), JSON.stringify(stateList, null, 2));
fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 2));

console.log(JSON.stringify(meta, null, 2));
console.log('\nTop states by own schemes:', stateList.slice(0, 6).map((s) => `${s.name} ${s.own}`).join(' · '));
console.log('Telangana:', JSON.stringify(stateList.find((s) => s.name === 'Telangana')));
console.log(
  '\nAge parse sample:',
  JSON.stringify(schemes.filter((s) => s.hasAgeRule).slice(0, 3).map((s) => [s.name, s.minAge, s.maxAge, s.ageClause])),
);
console.log(
  '\nIncome parse sample:',
  JSON.stringify(schemes.filter((s) => s.hasIncomeRule).slice(0, 3).map((s) => [s.name, s.incomeCeiling, s.incomeClause])),
);
