/**
 * The engine's own tests. No network, no browser, no Appwrite.
 *
 * Every assertion here encodes a promise the product makes out loud:
 * missing data never denies anybody, a stated threshold is obeyed exactly,
 * and the money in a rejection is written the way a person would say it.
 */

import { NO_AGE_MAX, NO_INCOME_CEILING, parseAgeBand, parseIncomeCeiling, readScheme } from '../server/extract.js';
import { evaluate } from '../server/rules.js';
import { searchLocal, loadFixtures } from '../server/engine.js';
import type { SchemeRow } from '../server/rules.js';

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

function row(overrides: Partial<SchemeRow> = {}): SchemeRow {
  return {
    slug: 'test',
    name: 'Test scheme',
    jurisdiction: 'Central',
    level: 'central',
    issuer: 'Test',
    summary: '',
    eligibilityExcerpt: '',
    benefitAmount: 0,
    benefitKind: 'cash',
    benefitLine: '',
    incomeCeiling: NO_INCOME_CEILING,
    hasIncomeRule: false,
    hasAgeRule: false,
    minAge: 0,
    maxAge: NO_AGE_MAX,
    womenOnly: false,
    disabilityOnly: false,
    genders: [],
    occupations: [],
    appMode: '',
    officialLink: '',
    tags: [],
    docsCount: 0,
    ...overrides,
  } as SchemeRow;
}

// ---- thresholds are read, not guessed -------------------------------------
const income = parseIncomeCeiling('The annual family income should not exceed ₹2.50 lakh.');
check('income ceiling in lakh', income.ceiling === 250000, `got ${income.ceiling}`);

const crore = parseIncomeCeiling('Applicants with annual income below 1 crore are eligible.');
check('income ceiling in crore', crore.ceiling === 10000000, `got ${crore.ceiling}`);

const band = parseAgeBand('Applicants must be between 18 and 60 years of age.');
check('age band 18-60', band.min === 18 && band.max === 60, `got ${band.min}-${band.max}`);

const openTop = parseAgeBand('Applicant should be above 18 years.');
check('open-ended age keeps a real floor', openTop.min === 18 && openTop.max === NO_AGE_MAX, `got ${openTop.min}-${openTop.max}`);

const noRule = parseIncomeCeiling('Farmers are eligible.');
check('no ceiling stated means no ceiling', noRule.stated === false && noRule.ceiling === NO_INCOME_CEILING);

// ---- restrictions need explicit words -------------------------------------
const women = readScheme({
  'Scheme Name': 'Widow Pension',
  'Scheme Slug': 'widow-pension',
  'Eligibility Criteria': 'This scheme is only for women who have lost their husband. Income should not exceed 2 lakh.',
});
check('women-only detected', women.womenOnly === true);

const mentionsWomen = readScheme({
  'Scheme Name': 'Skill Training',
  'Scheme Slug': 'skill-training',
  'Eligibility Criteria': 'Open to all students. Priority given to women candidates during selection.',
});
check('mentioning women is not women-only', mentionsWomen.womenOnly === false);

// ---- the rules engine -----------------------------------------------------
const profile = { age: 34, income: 240000, state: 'Telangana', gender: 'male', category: null, occupations: ['tailor'], children: 2 } as never;

const missing = evaluate(row(), profile);
check('missing data never denies', missing.ok === true, JSON.stringify(missing.blockers));

const tooRich = evaluate(row({ incomeCeiling: 100000, hasIncomeRule: true }), profile);
check('income over the ceiling blocks', tooRich.ok === false && tooRich.blockers.some((b) => b.field === 'income'));
check(
  'the rejection names the money in lakh',
  tooRich.blockers.some((b) => b.detail.includes('₹1 lakh') || b.detail.includes('₹1,00,000')),
  JSON.stringify(tooRich.blockers.map((b) => b.detail)),
);

const tooOld = evaluate(row({ minAge: 18, maxAge: 30, hasAgeRule: true }), profile);
check('age outside the band blocks', tooOld.ok === false && tooOld.blockers.some((b) => b.field === 'age'));

const wrongState = evaluate(row({ jurisdiction: 'Karnataka', level: 'state' }), profile);
check('state scheme in another state blocks', wrongState.ok === false && wrongState.blockers.some((b) => b.field === 'state'));

const centralAlwaysOpen = evaluate(row({ jurisdiction: 'Central', level: 'central' }), { ...(profile as object), state: 'Kerala' } as never);
check('central scheme ignores your state', centralAlwaysOpen.ok === true);

// ---- the whole pipeline over the real corpus ------------------------------
const { docs } = loadFixtures();
check('corpus loaded', docs.length > 2000, `${docs.length} docs`);

const SENTENCE = 'I am a 34 year old tailor in Hyderabad, I make about 2.4 lakh a year, two kids in school';
const result = searchLocal({ text: SENTENCE, profile: profile as never, parsedBy: 'rules' });

check('search finds matches', result.counts.matched > 0, `${result.counts.matched} matched`);
check('every match really passes', result.matches.every((m) => evaluate(m.scheme, profile).ok === true));
check('funnel is ordered', result.counts.scanned >= result.receipts.union && result.receipts.union >= result.counts.matched);
check('long tail is the remainder', result.also.length === Math.max(0, result.counts.matched - result.matches.length), `${result.also.length} vs ${result.counts.matched - result.matches.length}`);
check('near misses carry a named number', result.nearMisses.every((n) => n.blockers.length > 0));
check('shared words are real words', result.matches.every((m) => m.shared.every((w) => !/^\d+$/.test(w))));

const t0 = Date.now();
searchLocal({ text: SENTENCE, profile: profile as never, parsedBy: 'rules' });
const ms = Date.now() - t0;
check('search is fast enough to feel instant', ms < 400, `${ms}ms`);

// ---- report ---------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  x ${f}`);
  process.exit(1);
}
console.log(`matched ${result.counts.matched} of ${result.counts.scanned}, ${result.nearMisses.length} near misses, ${ms}ms\n`);
