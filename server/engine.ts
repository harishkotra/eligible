/**
 * The search engine, in two halves that must both agree.
 *
 * HALF ONE is meaning: which schemes read like this person's life. In Appwrite
 * that is VectorsDB cosine similarity over the scheme prose. Locally, with no
 * credentials, it is a BM25-style lexical score over the same prose, and the UI
 * says so on the receipt instead of pretending.
 *
 * HALF TWO is arithmetic: which schemes the person actually satisfies.
 * Age bands, income ceilings and jurisdiction come from TablesDB columns.
 *
 * The interesting output is not the intersection. It is the difference: schemes
 * that sounded right and were killed by a number, each with the number named.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { blend, evaluate, type Blocker, type SchemeRow } from './rules.js';
import type { ParsedProfile } from './extract.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

export type SchemeDoc = SchemeRow & {
  documents: string[];
  embedText: string;
};

export type Candidate = {
  scheme: SchemeDoc;
  similarity: number | null;
  ruleScore: number;
  score: number;
  reasons: string[];
  blockers: Blocker[];
  /** Words the user wrote that also appear in the scheme's own text. */
  shared: string[];
};

export type Receipts = {
  vectorLayer: string;
  tableLayer: string;
  vectorMs: number;
  tableMs: number;
  totalMs: number;
  semanticCandidates: number;
  tableCandidates: number;
  union: number;
  killedByRules: number;
  queries: string[];
};

export type SearchResult = {
  profile: ParsedProfile;
  parsedBy: string;
  matches: Candidate[];
  nearMisses: Candidate[];
  /** The rest of the matches, name only, so the page can list them without
   *  shipping five hundred full cards. */
  also: Array<{ slug: string; name: string }>;
  counts: { matched: number; near: number; scanned: number; total: number; semanticPassed: number };
  receipts: Receipts;
};

export const STOPWORDS = new Set(
  `a an the and or of for to in on at is are am was were be been being i my me we our you your he she they them his her their it its this that these those with without from by as if then than so such not no nor but do does did doing have has had having can could will would should may might must about into over under between during through after before above below up down out off again further once here there when where why how all any both each few more most other some only own same too very just don also get got make made want need know like work works working year years old age aged income earn earning salary month monthly per family children kids two three four five husband wife live living near city town village district state country india indian government scheme schemes apply applying application benefit benefits amount money help support provide provided providing assist assistance given give`.split(/\s+/),
);

// Fixtures are 4.7 MB; parsing once at boot costs about 40 ms and saves a
// database round trip on every search in local mode.
let docs: SchemeDoc[] | null = null;
let meta: Record<string, unknown> | null = null;
let states: { name: string; own: number; reachable: number }[] = [];
let idf = new Map<string, number>();

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s₹]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

export function loadFixtures(): { docs: SchemeDoc[]; meta: Record<string, unknown>; states: typeof states } {
  if (docs) return { docs, meta: meta!, states };
  docs = JSON.parse(fs.readFileSync(path.join(root, 'data/fixtures/schemes.json'), 'utf8')) as SchemeDoc[];
  meta = JSON.parse(fs.readFileSync(path.join(root, 'data/fixtures/meta.json'), 'utf8')) as Record<string, unknown>;
  states = JSON.parse(fs.readFileSync(path.join(root, 'data/fixtures/states.json'), 'utf8'));
  const df = new Map<string, number>();
  for (const doc of docs) {
    const seen = new Set(tokenize(doc.embedText));
    for (const term of seen) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const N = docs.length;
  idf = new Map([...df].map(([term, n]) => [term, Math.log(1 + (N - n + 0.5) / (n + 0.5))]));
  return { docs, meta: meta!, states };
}

export function getMeta() {
  const loaded = loadFixtures();
  return { meta: loaded.meta, states: loaded.states };
}

/** Lexical stand-in for the vector layer. Honest about being lexical. */
export function lexicalScore(query: string[], doc: SchemeDoc): number {
  if (!query.length) return 0;
  const tokens = tokenize(doc.embedText);
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  let score = 0;
  for (const term of query) {
    const tf = counts.get(term);
    if (!tf) continue;
    score += (idf.get(term) ?? 0) * (tf / (tf + 1.2));
  }
  // Length normalisation keeps long eligibility paragraphs from winning on bulk.
  const norm = 1 / (1 + Math.log(1 + tokens.length / 120));
  return score * norm;
}

export function topSemantic(query: string, limit: number, pool?: SchemeDoc[]): Array<{ scheme: SchemeDoc; similarity: number }> {
  const all = pool ?? loadFixtures().docs;
  const terms = [...new Set(tokenize(query))];
  const scored = all.map((scheme) => ({ scheme, raw: lexicalScore(terms, scheme) }));
  const max = scored.reduce((n, s) => Math.max(n, s.raw), 0) || 1;
  return scored
    .filter((s) => s.raw > 0)
    .map((s) => ({ scheme: s.scheme, similarity: Number((s.raw / max).toFixed(4)) }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

/** Table layer in local mode: the same predicates the Appwrite query uses. */
export function tablePass(profile: ParsedProfile, pool: SchemeDoc[]): SchemeDoc[] {
  return pool.filter((s) => {
    if (s.jurisdiction !== 'All India' && profile.state && s.jurisdiction !== profile.state) return false;
    if (profile.age !== null) {
      if (s.minAge > profile.age) return false;
      if (s.maxAge < profile.age) return false;
    }
    if (profile.income !== null && s.incomeCeiling < profile.income) return false;
    return true;
  });
}

export type Pairs = Array<{ scheme: SchemeDoc; similarity: number | null }>;

export type BuildInput = {
  profile: ParsedProfile;
  parsedBy: string;
  pairs: Pairs;
  scanned: number;
  limit?: number;
  vectorLayer: string;
  tableLayer: string;
  vectorMs: number;
  tableMs: number;
  started: number;
  queries: string[];
  semanticCandidates: number;
  tableCandidates: number;
};

/** Shared by the local path and the Appwrite path: same ranking, same output. */
export function buildResult(input: BuildInput): SearchResult {
  const limit = input.limit ?? 24;
  const matches: Candidate[] = [];
  const nearMisses: Candidate[] = [];
  let semanticOk = 0;
  // Words worth quoting back: not units, not numbers, not boilerplate that
  // every government page contains.
  const NOISE = new Set([
    'lakh', 'lakhs', 'crore', 'crores', 'rupees', 'year', 'years', 'month', 'months',
    'scheme', 'schemes', 'government', 'india', 'indian', 'state', 'under', 'above',
    'below', 'annual', 'income', 'family', 'provided', 'assistance', 'financial',
    'apply', 'application', 'eligible', 'eligibility', 'benefit', 'benefits',
  ]);
  const asked = new Set(
    tokenize(`${input.profile.text ?? ''} ${input.profile.occupations.join(' ')}`).filter(
      (t) =>
        t.length > 3 &&
        !NOISE.has(t) &&
        !/^\d+$/.test(t) &&
        // the reason line already names the occupation; quoting it twice is noise
        !input.profile.occupations.includes(t),
    ),
  );

  for (const { scheme, similarity } of input.pairs) {
    const verdict = evaluate(scheme, input.profile);
    const candidate: Candidate = {
      scheme,
      similarity,
      ruleScore: verdict.score,
      score: Number(blend(verdict.score, similarity).toFixed(4)),
      reasons: verdict.reasons,
      blockers: verdict.blockers,
      shared: [...new Set(tokenize(scheme.embedText || scheme.summary || ''))]
        .filter((t) => asked.has(t) && !NOISE.has(t) && !/^\d+$/.test(t))
        .slice(0, 3),
    };
    if (verdict.ok) {
      matches.push(candidate);
      if (similarity !== null) semanticOk += 1;
    }
    else if (candidate.blockers.length) nearMisses.push(candidate);
  }

  const gapWeight = (c: Candidate) => c.blockers.reduce((n, b) => n + (b.field === 'state' ? 100 : 1), 0);
  matches.sort((a, b) => b.score - a.score || b.ruleScore - a.ruleScore);
  nearMisses.sort((a, b) => gapWeight(a) - gapWeight(b) || b.score - a.score);

  return {
    profile: input.profile,
    parsedBy: input.parsedBy,
    matches: matches.slice(0, limit),
    also: matches.slice(limit).map((c) => ({ slug: c.scheme.slug, name: c.scheme.name })),
    nearMisses: nearMisses.slice(0, 10),
    counts: {
      matched: matches.length,
      near: nearMisses.length,
      scanned: input.scanned,
      total: input.pairs.length,
      semanticPassed: semanticOk,
    },
    receipts: {
      vectorLayer: input.vectorLayer,
      tableLayer: input.tableLayer,
      vectorMs: input.vectorMs,
      tableMs: input.tableMs,
      totalMs: Date.now() - input.started,
      semanticCandidates: input.semanticCandidates,
      tableCandidates: input.tableCandidates,
      union: input.pairs.length,
      killedByRules: nearMisses.length,
      queries: input.queries,
    },
  };
}

export type SearchOptions = {
  text: string;
  profile: ParsedProfile;
  parsedBy: string;
  limit?: number;
  semanticLimit?: number;
};

export function searchLocal({ text, profile, parsedBy, limit = 24, semanticLimit = 80 }: SearchOptions): SearchResult {
  const started = Date.now();
  const { docs: all } = loadFixtures();

  const tableStart = Date.now();
  const passed = new Set(tablePass(profile, all).map((s) => s.slug));
  const tableMs = Date.now() - tableStart;

  const vectorStart = Date.now();
  const semanticQuery = [text || profile.text || '', profile.occupations.join(' '), profile.category ?? ''].join(' ');
  const semantic = topSemantic(semanticQuery, semanticLimit, all);
  const vectorMs = Date.now() - vectorStart;

  const merged = new Map<string, { scheme: SchemeDoc; similarity: number | null }>();
  for (const s of semantic) merged.set(s.scheme.slug, s);
  for (const s of all) if (passed.has(s.slug) && !merged.has(s.slug)) merged.set(s.slug, { scheme: s, similarity: null });

  return buildResult({
    profile,
    parsedBy,
    pairs: [...merged.values()],
    scanned: all.length,
    limit,
    vectorLayer: 'local lexical index (no Appwrite key present)',
    tableLayer: 'local predicate pass (no Appwrite key present)',
    vectorMs,
    tableMs,
    started,
    queries: [
      `semantic: score(${tokenize(semanticQuery).slice(0, 8).join(' ')}) over ${all.length} scheme texts`,
      `table: jurisdiction ∈ {${profile.state ?? 'any'}, All India} ∧ minAge ≤ ${profile.age ?? 'any'} ≤ maxAge ∧ income ≤ ${profile.income ?? 'any'}`,
    ],
    semanticCandidates: semantic.length,
    tableCandidates: passed.size,
  });
}
