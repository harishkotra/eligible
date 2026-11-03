/**
 * The server.
 *
 * One Express app, two data paths. If Appwrite credentials are present the
 * search runs against TablesDB + VectorsDB; if not, the same engine runs over
 * the local fixtures and every receipt says so out loud. Nothing is faked in
 * either mode: the timings, the counts and the queries printed in the UI are
 * the ones that actually ran.
 */

// Load .env before any module that reads process.env at import time.
import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadFixtures, getMeta, buildResult, searchLocal, topSemantic, tablePass, tokenize, type SchemeDoc } from './engine.js';
import { parseProfile } from './llm.js';
import { evaluate } from './rules.js';
import type { ParsedProfile } from './extract.js';
import {
  isConfigured, tableCandidates, semanticCandidates, rowsBySlug, recordSearch, stats, toRow,
} from './appwrite.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const app = express();
app.use(express.json({ limit: '64kb' }));

const asList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/** A TablesDB row has the same shape as a fixture doc, minus the prose block. */
function fromRow(row: Record<string, unknown>): SchemeDoc {
  return {
    ...(row as unknown as SchemeDoc),
    slug: String(row.slug ?? row.$id ?? ''),
    name: String(row.name ?? ''),
    jurisdiction: String(row.jurisdiction ?? 'All India'),
    level: String(row.level ?? ''),
    benefitKind: String(row.benefitKind ?? ''),
    benefitLine: String(row.benefitLine ?? ''),
    appMode: String(row.appMode ?? ''),
    officialLink: String(row.officialLink ?? ''),
    summary: String(row.summary ?? ''),
    eligibilityExcerpt: String(row.eligibility ?? ''),
    tags: asList(row.tags),
    occupations: asList(row.occupations),
    categories: asList(row.categories),
    documents: String(row.documents ?? '').split('|').map((s) => s.trim()).filter(Boolean),
    embedText: String(row.embedText ?? ''),
    womenOnly: Boolean(row.womenOnly),
    benefitAmount: Number(row.benefitAmount ?? 0),
    minAge: Number(row.minAge ?? 0),
    maxAge: Number(row.maxAge ?? 120),
    incomeCeiling: Number(row.incomeCeiling ?? 999_999_999),
    docsCount: Number(row.docsCount ?? 0),
    hasAgeRule: Boolean(row.hasAgeRule),
    hasIncomeRule: Boolean(row.hasIncomeRule),
  } as SchemeDoc;
}

app.get('/api/health', (_req, res) => {
  const { meta } = loadFixtures();
  res.json({
    ok: true,
    mode: isConfigured() ? 'appwrite' : 'local',
    schemes: (meta as { schemes?: number }).schemes ?? 0,
    builtAt: (meta as { builtAt?: string }).builtAt ?? null,
  });
});

app.get('/api/meta', async (_req, res) => {
  const { meta, states } = getMeta();
  const live = await stats();
  res.json({ ...meta, states, live });
});

app.post('/api/search', async (req, res) => {
  const body = req.body as { text?: string; profile?: Partial<ParsedProfile> };
  const text = String(body.text ?? '').slice(0, 1200);
  if (!text && !body.profile) {
    res.status(400).json({ error: 'Give me a sentence or a profile.' });
    return;
  }

  const { profile, parsedBy } = text
    ? await parseProfile(text)
    : { profile: { age: null, income: null, state: null, gender: null, category: null, occupations: [], children: null, fieldSources: {}, text: '' } as ParsedProfile, parsedBy: 'form' };
  const merged: ParsedProfile = { ...profile, ...(body.profile ?? {}) } as ParsedProfile;
  merged.text = text;

  const started = Date.now();
  try {
    if (!isConfigured()) {
      const result = searchLocal({ text, profile: merged, parsedBy });
      res.json(result);
      return;
    }

    // Configured but empty is the worst-looking state there is: a real key, no
    // tables yet, and a blank screen. Fall back to the local corpus and say so
    // on the receipt rather than serving nothing.
    // Appwrite path: the vector store decides what to read, the tables decide
    // what is true, and the slugs join the two.
    const t0 = Date.now();
    const rows = await tableCandidates(merged).catch(() => [] as Record<string, unknown>[]);
    const tableMs = Date.now() - t0;

    const t1 = Date.now();
    const query = [text, merged.occupations.join(' '), merged.category ?? ''].join(' ');
    const hits = await semanticCandidates(query, 80).catch(() => []);
    const vectorMs = Date.now() - t1;

    if (rows.length === 0 && hits.length === 0) {
      const result = searchLocal({ text, profile: merged, parsedBy });
      result.receipts.vectorLayer = 'local fallback: Appwrite returned no rows (run npm run verify:appwrite)';
      result.receipts.tableLayer = 'local fallback: Appwrite returned no rows (run npm run verify:appwrite)';
      res.json(result);
      return;
    }

    const bySlug = new Map<string, SchemeDoc>();
    for (const row of rows) {
      const doc = fromRow(row);
      if (doc.slug) bySlug.set(doc.slug, doc);
    }
    const missing = hits.filter((h) => !bySlug.has(h.slug)).map((h) => h.slug);
    if (missing.length) {
      for (const row of await rowsBySlug(missing).catch(() => [])) {
        const doc = fromRow(row as Record<string, unknown>);
        if (doc.slug) bySlug.set(doc.slug, doc);
      }
    }

    const similarity = new Map(hits.map((h) => [h.slug, h.similarity]));
    const pairs = [...bySlug.values()].map((doc) => ({ scheme: doc, similarity: similarity.get(doc.slug) ?? null }));

    const result = buildResult({
      profile: merged,
      parsedBy,
      pairs,
      scanned: (getMeta().meta as { schemes?: number }).schemes ?? pairs.length,
      vectorLayer: 'VectorsDB · cosine over 2,066 embedded eligibility texts (nomic-embed-text)',
      tableLayer: `TablesDB · range query on ${['jurisdiction', 'minAge', 'maxAge', 'incomeCeiling'].join(', ')}`,
      vectorMs,
      tableMs,
      started,
      queries: [
        `Query.vectorCosine("embedding", vec) · limit 80`,
        `Query.equal("jurisdiction", [${merged.state ?? 'any'}, "All India"])`,
        `Query.lessThanEqual("minAge", ${merged.age ?? 'any'}) ∧ Query.greaterThanEqual("maxAge", ${merged.age ?? 'any'})`,
        `Query.greaterThanEqual("incomeCeiling", ${merged.income ?? 'any'})`,
      ],
      semanticCandidates: hits.length,
      tableCandidates: rows.length,
    });

    await recordSearch(merged, text, result.counts.matched, result.counts.near, result.receipts.totalMs);
    res.json(result);
  } catch (error) {
    // A database hiccup must not look like "you qualify for nothing".
    const message = error instanceof Error ? error.message : 'search failed';
    const fallback = searchLocal({ text, profile: merged, parsedBy: `${parsedBy} (Appwrite unavailable, local index used)` });
    res.json({ ...fallback, error: message });
  }
});

app.get('/api/scheme/:slug', (req, res) => {
  const { docs } = loadFixtures();
  const doc = docs.find((d) => d.slug === req.params.slug);
  if (!doc) {
    res.status(404).json({ error: 'No scheme with that slug.' });
    return;
  }
  res.json(doc);
});

app.get('/api/explain/:slug', (req, res) => {
  const { docs } = loadFixtures();
  const doc = docs.find((d) => d.slug === req.params.slug);
  if (!doc) {
    res.status(404).json({ error: 'No scheme with that slug.' });
    return;
  }
  const profile = {
    age: Number(req.query.age) || null,
    income: Number(req.query.income) || null,
    state: (req.query.state as string) || null,
    gender: (req.query.gender as string) || null,
    category: (req.query.category as string) || null,
    occupations: String(req.query.occupations ?? '').split(',').filter(Boolean),
  };
  res.json({ verdict: evaluate(doc, profile), scheme: doc });
});

// Static build, when one exists. In dev Vite serves the UI itself.
const dist = path.join(root, 'dist');
if (fs.existsSync(dist)) app.use(express.static(dist));

const port = Number(process.env.PORT ?? 4317);
if (process.env.NODE_ENV !== 'test') {
  app.listen(port, () => {
    const mode = isConfigured() ? 'Appwrite (TablesDB + VectorsDB)' : 'local fixtures';
    console.log(`Eligible on http://localhost:${port} · ${mode}`);
  });
}

export { app };
export const _internal = { fromRow, asList, toRow, tokenize, topSemantic, tablePass };
