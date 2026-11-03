/**
 * Text to structure.
 *
 * Two hundred million lines of Indian government prose exist because nobody
 * ever had to make them machine readable. This file is the translator: it turns
 * a scheme's eligibility paragraph into numbers and tags that a database can
 * compare, and turns a human's sentence into the same shape.
 *
 * Every extractor is deliberately conservative. When a rule cannot be read with
 * confidence we record "no rule stated" instead of guessing, because a wrong
 * threshold is worse than a missing one: it silently denies someone money they
 * are owed.
 */

export const STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat',
  'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh',
  'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab',
  'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh',
  'Uttarakhand', 'West Bengal', 'Andaman & Nicobar Islands', 'Chandigarh',
  'Dadra & Nagar Haveli and Daman & Diu', 'Delhi', 'Jammu & Kashmir', 'Ladakh',
  'Lakshadweep', 'Puducherry',
] as const;

const STATE_ALIASES: Record<string, string> = {
  orissa: 'Odisha',
  uttaranchal: 'Uttarakhand',
  pondicherry: 'Puducherry',
  'j and k': 'Jammu & Kashmir',
  jk: 'Jammu & Kashmir',
  'j&k': 'Jammu & Kashmir',
  'nct of delhi': 'Delhi',
  'new delhi': 'Delhi',
  'andaman and nicobar': 'Andaman & Nicobar Islands',
  'andaman & nicobar': 'Andaman & Nicobar Islands',
  'dadra and nagar haveli': 'Dadra & Nagar Haveli and Daman & Diu',
  daman: 'Dadra & Nagar Haveli and Daman & Diu',
  'daman and diu': 'Dadra & Nagar Haveli and Daman & Diu',
  'dadra & nagar haveli': 'Dadra & Nagar Haveli and Daman & Diu',
};

/** Words that mean a person does a kind of work. Ordered by specificity. */
export const OCCUPATION_WORDS: Array<[string, string[]]> = [
  ['farmer', ['farmer', 'farming', 'agricultur', 'cultivator', 'kisan', 'ryot', 'crop', 'horticultur', 'livestock', 'dairy', 'animal husbandry']],
  ['student', ['student', 'studying', 'pursuing', 'school going', 'college going']],
  ['artisan', ['artisan', 'craft', 'handloom', 'handicraft', 'weaver', 'weaving', 'potter', 'carpenter', 'blacksmith', 'cobbler', 'sculptor', 'embroidery', 'tailor', 'stitching', 'garment', 'boutique', 'dressmaker']],
  ['fisher', ['fisher', 'fishing', 'fish worker', 'aquaculture']],
  ['entrepreneur', ['entrepreneur', 'enterprise', 'industry', 'industrial', 'startup', 'start-up', 'msme', 'manufactur', 'self employed', 'self-employed', 'business']],
  ['trader', ['trader', 'shopkeeper', 'vendor', 'retail', 'kirana', 'shop owner', 'merchant', 'hawker', 'street vendor']],
  ['worker', ['labour', 'labor', 'worker', 'mason', 'construction', 'factory', 'industrial worker', 'unorganised', 'unorganized', 'barber', 'mechanic', 'electrician', 'plumber', 'painter', 'cook', 'chef', 'security guard', 'housekeeping']],
  ['driver', ['driver', 'transport', 'auto rickshaw', 'taxi']],
  ['teacher', ['teacher', 'teaching', 'faculty', 'professor']],
  ['healthworker', ['nurse', 'nursing', 'asha', 'health worker', 'midwife', 'anm', 'paramedic']],
  ['senior', ['senior citizen', 'old age', 'elderly', 'aged person', 'super senior']],
  ['disabled', ['disabilit', 'disabled', 'divyang', 'handicap', 'specially abled']],
  ['widow', ['widow', 'widower', 'destitute woman']],
  ['pregnant', ['pregnant', 'maternity', 'expectant mother', 'lactating']],
  ['sanitation', ['sanitation worker', 'safai', 'sewer', 'manual scaveng']],
  ['exserviceman', ['ex-servicemen', 'ex servicemen', 'exservicemen', 'armed forces', 'defence personnel', 'defense personnel']],
  ['unemployed', ['unemployed', 'jobless', 'unemployment']],
  ['teacher', ['trainer', 'instructor']],
];

const CATEGORY_WORDS: Array<[string, string[]]> = [
  ['sc', ['scheduled caste', 'scheduled castes', 'sc community', 'sc/st', 'sc, st', 'sc and st']],
  ['st', ['scheduled tribe', 'scheduled tribes', 'st community', 'adivasi']],
  ['obc', ['other backward class', 'other backward classes', 'obc', 'backward class']],
  ['minority', ['minority', 'minorities']],
  ['ews', ['economically weaker section', 'ews']],
  ['bpl', ['below poverty line', 'bpl']],
  ['general', ['general category']],
];

const GENDER_WORDS: Array<[string, string[]]> = [
  ['female', ['woman', 'women', 'female', 'girl', 'girls', 'widow', 'mother', 'maternity', 'lady', 'mahila']],
  ['male', ['man', 'men', 'male', 'boy', 'boys']],
  ['transgender', ['transgender', 'third gender', 'trans person']],
];

const BENEFIT_KINDS: Array<[string, string[]]> = [
  ['pension', ['pension']],
  ['scholarship', ['scholarship', 'fellowship', 'stipend']],
  ['subsidy', ['subsid']],
  ['loan', ['loan', 'credit', 'interest subvention', 'financial assistance at']],
  ['insurance', ['insurance', 'cover', 'insured']],
  ['housing', ['house', 'housing', 'dwelling', 'pucca']],
  ['health', ['hospital', 'medical', 'treatment', 'health']],
  ['food', ['food grain', 'ration', 'nutrition', 'meal']],
  ['training', ['training', 'skilling', 'apprentice', 'coaching']],
  ['equipment', ['equipment', 'machine', 'tool', 'implement', 'kit']],
  ['cash', ['cash', 'incentive', 'grant', 'assistance of', 'amount of']],
];

export type SchemeFacts = {
  level: 'central' | 'state';
  jurisdiction: string;
  occupations: string[];
  categories: string[];
  genders: string[];
  womenOnly: boolean;
  /** Scheme exists only for people with a disability certificate. */
  disabilityOnly: boolean;
  minAge: number;
  maxAge: number;
  hasAgeRule: boolean;
  incomeCeiling: number;
  hasIncomeRule: boolean;
  benefitAmount: number;
  benefitKind: string;
  benefitLine: string;
  docsCount: number;
  summary: string;
  ageClause: string;
  incomeClause: string;
  eligibilityExcerpt: string;
};

/** Value stored when a scheme states no income ceiling at all. */
export const NO_INCOME_CEILING = 999999999;
export const NO_AGE_MAX = 120;

const clean = (s: string | undefined | null): string =>
  (s ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const sentences = (text: string): string[] =>
  clean(text)
    .split(/(?<=[.;])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

/** "2.5 lakh", "₹ 2,50,000", "Rs. 1 crore", "30 thousand" -> rupees */
export function parseRupees(raw: string): number | null {
  const m = raw.match(/(\d[\d,]*(?:\.\d+)?)\s*(crore|cr\b|lakh|lac\b|lacs|lakhs|thousand|k\b)?/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] ?? '').toLowerCase();
  if (unit.startsWith('crore') || unit === 'cr') return Math.round(n * 10_000_000);
  if (unit.startsWith('lakh') || unit.startsWith('lac')) return Math.round(n * 100_000);
  if (unit === 'thousand' || unit === 'k') return Math.round(n * 1_000);
  return Math.round(n);
}

/** Cities people actually name when you ask where they live. */
export const CITY_TO_STATE: Record<string, string> = {
  hyderabad: 'Telangana', warangal: 'Telangana', nizamabad: 'Telangana', karimnagar: 'Telangana', khammam: 'Telangana',
  bengaluru: 'Karnataka', bangalore: 'Karnataka', mysuru: 'Karnataka', mysore: 'Karnataka', hubballi: 'Karnataka', mangaluru: 'Karnataka', belagavi: 'Karnataka',
  mumbai: 'Maharashtra', pune: 'Maharashtra', nagpur: 'Maharashtra', nashik: 'Maharashtra', thane: 'Maharashtra', aurangabad: 'Maharashtra', solapur: 'Maharashtra',
  chennai: 'Tamil Nadu', madras: 'Tamil Nadu', coimbatore: 'Tamil Nadu', madurai: 'Tamil Nadu', salem: 'Tamil Nadu', tiruchirappalli: 'Tamil Nadu', vellore: 'Tamil Nadu', erode: 'Tamil Nadu', tirunelveli: 'Tamil Nadu',
  kolkata: 'West Bengal', calcutta: 'West Bengal', howrah: 'West Bengal', siliguri: 'West Bengal', asansol: 'West Bengal', durgapur: 'West Bengal',
  ahmedabad: 'Gujarat', surat: 'Gujarat', vadodara: 'Gujarat', rajkot: 'Gujarat', bhavnagar: 'Gujarat', jamnagar: 'Gujarat',
  jaipur: 'Rajasthan', jodhpur: 'Rajasthan', udaipur: 'Rajasthan', kota: 'Rajasthan', ajmer: 'Rajasthan', bikaner: 'Rajasthan',
  lucknow: 'Uttar Pradesh', kanpur: 'Uttar Pradesh', varanasi: 'Uttar Pradesh', agra: 'Uttar Pradesh', prayagraj: 'Uttar Pradesh', meerut: 'Uttar Pradesh', gorakhpur: 'Uttar Pradesh', noida: 'Uttar Pradesh', ghaziabad: 'Uttar Pradesh', bareilly: 'Uttar Pradesh',
  patna: 'Bihar', gaya: 'Bihar', muzaffarpur: 'Bihar', bhagalpur: 'Bihar', darbhanga: 'Bihar',
  bhopal: 'Madhya Pradesh', indore: 'Madhya Pradesh', gwalior: 'Madhya Pradesh', jabalpur: 'Madhya Pradesh', ujjain: 'Madhya Pradesh', sagar: 'Madhya Pradesh',
  ranchi: 'Jharkhand', dhanbad: 'Jharkhand', jamshedpur: 'Jharkhand', bokaro: 'Jharkhand',
  raipur: 'Chhattisgarh', bhilai: 'Chhattisgarh', bilaspur: 'Chhattisgarh',
  bhubaneswar: 'Odisha', cuttack: 'Odisha', rourkela: 'Odisha', puri: 'Odisha',
  guwahati: 'Assam', dibrugarh: 'Assam', silchar: 'Assam', jorhat: 'Assam',
  kochi: 'Kerala', cochin: 'Kerala', thiruvananthapuram: 'Kerala', trivandrum: 'Kerala', kozhikode: 'Kerala', thrissur: 'Kerala', kollam: 'Kerala',
  chandigarh: 'Chandigarh', ludhiana: 'Punjab', amritsar: 'Punjab', jalandhar: 'Punjab', patiala: 'Punjab',
  dehradun: 'Uttarakhand', haridwar: 'Uttarakhand', nainital: 'Uttarakhand',
  shimla: 'Himachal Pradesh', dharamshala: 'Himachal Pradesh', manali: 'Himachal Pradesh',
  srinagar: 'Jammu & Kashmir', jammu: 'Jammu & Kashmir', leh: 'Ladakh',
  panaji: 'Goa', margao: 'Goa', vasco: 'Goa',
  agartala: 'Tripura', imphal: 'Manipur', shillong: 'Meghalaya', aizawl: 'Mizoram', kohima: 'Nagaland', gangtok: 'Sikkim', itanagar: 'Arunachal Pradesh',
  puducherry: 'Puducherry', pondicherry: 'Puducherry', karaikal: 'Puducherry',
  visakhapatnam: 'Andhra Pradesh', vizag: 'Andhra Pradesh', vijayawada: 'Andhra Pradesh', guntur: 'Andhra Pradesh', tirupati: 'Andhra Pradesh', nellore: 'Andhra Pradesh', kurnool: 'Andhra Pradesh', rajahmundry: 'Andhra Pradesh',
  'port blair': 'Andaman & Nicobar Islands', silvassa: 'Dadra & Nagar Haveli and Daman & Diu', kavaratti: 'Lakshadweep',
};

function readState(text: string): string | null {
  const hay = text.toLowerCase();
  for (const [alias, canonical] of Object.entries(STATE_ALIASES)) {
    if (hay.includes(alias)) return canonical;
  }
  let best: { name: string; at: number } | null = null;
  for (const state of STATES) {
    const at = hay.indexOf(state.toLowerCase());
    if (at >= 0 && (!best || at < best.at)) best = { name: state, at };
  }
  if (best) return best.name;
  for (const [city, state] of Object.entries(CITY_TO_STATE)) {
    if (new RegExp(`\\b${city}\\b`).test(hay)) return state;
  }
  return null;
}

function tagsFrom(text: string, table: Array<[string, string[]]>, limit: number): string[] {
  const hay = text.toLowerCase();
  const found: string[] = [];
  for (const [tag, words] of table) {
    if (found.includes(tag)) continue;
    // Prefix-anchored match: "agricultur" catches agriculture but "male" must
    // never fire inside "female".
    const hit = words.some((w) => new RegExp(`(?<![a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(hay));
    if (hit) found.push(tag);
    if (found.length >= limit) break;
  }
  return found;
}

/** Age band from a piece of eligibility prose. Conservative: no match means no rule. */
export function parseAgeBand(text: string): { min: number; max: number; stated: boolean; clause: string } {
  const hay = clean(text);
  if (!hay) return { min: 0, max: NO_AGE_MAX, stated: false, clause: '' };

  const between = hay.match(/between\s*(?:the\s*age\s*of\s*)?(\d{1,2})\s*(?:and|to|-|–)\s*(\d{1,2})\s*(?:years|yrs)?/i)
    ?? hay.match(/(?:aged?|age)\s*(\d{1,2})\s*(?:to|-|–)\s*(\d{1,2})\s*(?:years|yrs)/i)
    ?? hay.match(/(\d{1,2})\s*[-–]\s*(\d{1,2})\s*(?:years|yrs)\s*(?:of\s*age)?/i);
  if (between) {
    const a = Number(between[1]);
    const b = Number(between[2]);
    if (a >= 5 && b <= 110 && a < b) {
      return { min: a, max: b, stated: true, clause: sentenceAround(hay, between[0]) };
    }
  }

  let min = 0;
  let max = NO_AGE_MAX;
  let stated = false;
  let clause = '';

  const minM = hay.match(/(?:above|over|minimum(?:\s*age)?(?:\s*of)?|at\s*least|not\s*less\s*than|completed)\s*(\d{1,2})\s*(?:years|yrs)/i);
  if (minM) {
    const v = Number(minM[1]);
    if (v >= 5 && v <= 110) { min = v; stated = true; clause = sentenceAround(hay, minM[0]); }
  }
  const altMin = hay.match(/(?:age\s*(?:of|group)?\s*)(\d{1,2})\s*(?:years|yrs)\s*(?:and|or)\s*(?:above|more|older)/i);
  if (!stated && altMin) {
    const v = Number(altMin[1]);
    if (v >= 5 && v <= 110) { min = v; stated = true; clause = sentenceAround(hay, altMin[0]); }
  }
  const maxM = hay.match(/(?:below|under|up\s*to|upto|maximum(?:\s*age)?(?:\s*of)?|not\s*(?:more|exceed)|less\s*than)\s*(\d{1,2})\s*(?:years|yrs)/i);
  if (maxM) {
    const v = Number(maxM[1]);
    if (v >= 5 && v <= 110) { max = v; stated = true; clause = clause || sentenceAround(hay, maxM[0]); }
  }
  return { min, max, stated, clause };
}

/** Annual income ceiling from eligibility prose. Conservative: takes the largest stated limit. */
export function parseIncomeCeiling(text: string): { ceiling: number; stated: boolean; clause: string } {
  const parts = sentences(text);
  let best: { ceiling: number; clause: string } | null = null;
  for (const sentence of parts) {
    const low = sentence.toLowerCase();
    if (!low.includes('income')) continue;
    const re = /(?:₹|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d+)?)\s*(crore|cr\b|lakh|lac|lacs|lakhs|thousand|k\b)?/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sentence))) {
      const value = parseRupees(m[0]);
      if (!value) continue;
      if (value < 5000) continue;
      if (value > 50_000_000) continue;
      if (!best || value > best.ceiling) best = { ceiling: value, clause: sentence.trim() };
    }
  }
  if (!best) return { ceiling: NO_INCOME_CEILING, stated: false, clause: '' };
  return { ceiling: best.ceiling, stated: true, clause: best.clause.slice(0, 260) };
}

function sentenceAround(hay: string, needle: string): string {
  const at = hay.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return '';
  const start = Math.max(0, hay.lastIndexOf('.', at) + 1);
  const end = hay.indexOf('.', at + needle.length);
  const cut = end < 0 ? hay.length : end + 1;
  return hay.slice(start, cut).trim().slice(0, 240);
}

function benefitFrom(benefits: string, description: string): { amount: number; kind: string; line: string } {
  const body = clean(benefits) || clean(description);
  const firstLine = sentences(body)[0] ?? '';
  let amount = 0;
  const re = /(?:₹|rs\.?|inr)\s*(\d[\d,]*(?:\.\d+)?)\s*(crore|cr\b|lakh|lac\b|lacs|lakhs|thousand|k\b)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const v = parseRupees(m[0]);
    if (v && v > amount && v <= 100_000_000) amount = v;
  }
  let kind = 'assistance';
  const low = `${body.slice(0, 3000)} ${firstLine}`.toLowerCase();
  for (const [tag, words] of BENEFIT_KINDS) {
    if (words.some((w) => low.includes(w))) { kind = tag; break; }
  }
  return { amount, kind, line: firstLine.slice(0, 220) };
}

function countDocuments(docs: string): number {
  const text = clean(docs);
  if (!text) return 0;
  const bullets = text.split(/\n/).map((l) => l.trim()).filter((l) => /^[•\-*\u2022]|^\d+[.)]/.test(l));
  if (bullets.length) return bullets.length;
  const parts = text.split(/[;,]\s+/).map((p) => p.trim()).filter((p) => p.length > 3);
  return parts.length > 20 ? 20 : parts.length;
}

export function readScheme(row: Record<string, string>): SchemeFacts {
  const eligibility = clean(row['Eligibility Criteria'] || row['Eligibility (General)']);
  const exclusions = clean(row['Exclusions / Ineligibility']);
  const tags = clean(row['Tags / Categories']);
  const description = clean(row['Description']);
  const benefits = clean(row['Benefits']);
  const levelRaw = clean(row['Level']).toLowerCase();
  const issuerRaw = clean(row['State / UT / Ministry']);
  const name = clean(row['Scheme Name']) || clean(row['Scheme Slug']);

  const level: 'central' | 'state' = levelRaw.includes('central') || levelRaw.includes('ministry')
    ? 'central'
    : 'state';
  const jurisdiction = level === 'central' ? 'All India' : (readState(issuerRaw) ?? issuerRaw);

  const age = parseAgeBand(`${eligibility} ${description.slice(0, 600)}`);
  const income = parseIncomeCeiling(`${eligibility}\n${exclusions}`);
  const benefit = benefitFrom(benefits, description);

  const hay = `${eligibility} ${tags} ${description.slice(0, 800)}`;
  const occupations = tagsFrom(hay, OCCUPATION_WORDS, 6);
  const categories = tagsFrom(hay, CATEGORY_WORDS, 5);
  const genders = tagsFrom(hay, GENDER_WORDS, 3);
  // Only an explicit phrase counts as an exclusion. A scheme that merely
  // mentions women is not a women-only scheme.
  const womenOnly = /only\s*(?:for\s*)?(?:women|girls|females?)|women\s*only|girls?\s*only|female\s*(?:applicants?|candidates?)\s*only|for\s*women\s*only|widows?\s*only|maternity\s*benefit/.test(hay.toLowerCase());

  // Same doctrine as womenOnly: only an explicit statement excludes anyone.
  // 'disability' alone is too loose (many schemes exclude disabled applicants),
  // so we require the scheme to be framed as being for disabled people.
  const disHead = `${name} ${eligibility.slice(0, 300)}`.toLowerCase();
  const disHit = /(?:for\s+(?:the\s+)?)?(?:persons?|people)\s+with\s+disabilit|divyang|disabilit(?:y|ies)\s+(?:pension|allowance|welfare|scheme)|schemes?\s+for\s+(?:the\s+)?disabled|disabled\s+persons?/.test(
    disHead,
  );
  const disNegated = /(?:not|never|except|other than|ineligible)[^.]{0,60}(?:disabilit|divyang|disabled)/.test(disHead);
  const disabilityOnly = disHit && !disNegated;

  const summarySource = description.replace(/^Introduction:\s*/i, '');
  const summary = (sentences(summarySource)[0] ?? summarySource).slice(0, 220);

  return {
    level,
    jurisdiction,
    occupations,
    categories,
    genders,
    womenOnly,
    disabilityOnly,
    minAge: age.min,
    maxAge: age.max,
    hasAgeRule: age.stated,
    incomeCeiling: income.ceiling,
    hasIncomeRule: income.stated,
    benefitAmount: benefit.amount,
    benefitKind: benefit.kind,
    benefitLine: benefit.line,
    docsCount: countDocuments(clean(row['Documents Required'])),
    summary,
    ageClause: age.clause,
    incomeClause: income.clause,
    eligibilityExcerpt: eligibility.slice(0, 400),
  };
}

/* ------------------------------------------------------------------ */
/* The other direction: a sentence from a human, into the same shape. */
/* ------------------------------------------------------------------ */

export type ParsedProfile = {
  age: number | null;
  income: number | null;
  state: string | null;
  gender: string | null;
  category: string | null;
  occupations: string[];
  children: number | null;
  fieldSources: Record<string, string>;
  text?: string;
};

export function parseProfileRules(text: string): ParsedProfile {
  const hay = clean(text);
  const low = hay.toLowerCase();
  const sources: Record<string, string> = {};

  let age: number | null = null;
  const ageM = hay.match(/(\d{1,2})\s*(?:years?|yrs?)[\s-]*(?:old|of age)/i)
    ?? hay.match(/(?:i\s*am|age(?:d)?(?:\s*is)?|my\s*age\s*is)\s*(\d{1,2})\b/i)
    ?? hay.match(/\b(\d{1,2})\s*y\/o\b/i);
  if (ageM) {
    const v = Number(ageM[1]);
    if (v >= 10 && v <= 100) { age = v; sources.age = ageM[0]; }
  }

  let income: number | null = null;
  const incomeM = hay.match(/(?:₹|rs\.?|inr)\s*(\d[\d,]*(?:\.\d+)?)\s*(crore|cr\b|lakh|lac\b|lacs|lakhs|thousand|k\b)?/i)
    ?? hay.match(/(\d[\d,]*(?:\.\d+)?)\s*(crore|lakh|lac|lakhs)\b/i)
    ?? hay.match(/(?:income|earn|salary|kamaata|kamata)[a-z\s]*(?:of|is|about|around|roughly)?\s*(?:₹|rs\.?)?\s*(\d[\d,]*(?:\.\d+)?)\s*(crore|cr\b|lakh|lac\b|lacs|lakhs|thousand|k\b)?/i);
  if (incomeM) {
    const raw = incomeM[2] ? `${incomeM[1]} ${incomeM[2]}` : incomeM[0];
    const v = parseRupees(raw) ?? (/income|earn|salary/.test(low) ? Number(incomeM[1].replace(/,/g, '')) : null);
    // "2.4 lakh" must become 240000, not 2.4
    const fixed = v !== null && v < 1000 && incomeM[2]
      ? parseRupees(`${incomeM[1]} ${incomeM[2]}`)
      : v;
    if (fixed && fixed >= 1000) { income = fixed; sources.income = incomeM[0]; }
  }
  if (income === null) {
    const bare = hay.match(/(?:income|earn|salary)[^\d]{0,20}(\d{4,9})/i);
    if (bare) { income = Number(bare[1]); sources.income = bare[0]; }
  }

  const state = readState(hay);
  if (state) sources.state = state;

  let gender: string | null = null;
  if (/\b(woman|women|female|lady|mother|widow|girl)\b/i.test(hay)) { gender = 'female'; sources.gender = 'female'; }
  else if (/\b(man|male|gentleman|boy)\b/i.test(hay)) { gender = 'male'; sources.gender = 'male'; }
  else if (/\btransgender\b/i.test(hay)) { gender = 'transgender'; sources.gender = 'transgender'; }

  const categories = tagsFrom(hay, CATEGORY_WORDS, 2);
  const category = categories[0] ?? null;
  if (category) sources.category = category;

  const occupations = tagsFrom(hay, OCCUPATION_WORDS, 4);
  if (occupations.length) sources.occupations = occupations.join(', ');

  let children: number | null = null;
  const kidM = hay.match(/(\d)\s*(?:kids|children|child|sons?|daughters?)/i)
    ?? hay.match(/(?:two|three|four|five)\s*(?:kids|children)/i);
  if (kidM) {
    const wordMap: Record<string, number> = { two: 2, three: 3, four: 4, five: 5 };
    const token = (String(kidM[0]).match(/\d|one|two|three|four|five|six/i)?.[0] ?? '').toLowerCase();
    const v = /^\d$/.test(token) ? Number(token) : wordMap[token];
    if (v) { children = v; sources.children = kidM[0]; }
  }

  return { age, income, state, gender, category, occupations, children, fieldSources: sources };
}
