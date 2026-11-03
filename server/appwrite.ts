/**
 * The Appwrite half of Eligible.
 *
 * Two database types do two different jobs, and neither can do the other's:
 *
 *   TablesDB  -> arithmetic. Jurisdiction, age band, income ceiling, rupee
 *                benefit, document count. Indexed columns, range queries,
 *                exact rejections with the number that did it.
 *   VectorsDB -> meaning. 2,066 eligibility paragraphs embedded once, queried
 *                by cosine similarity with the sentence the person typed.
 *
 * Everything here degrades to `isConfigured() === false` rather than throwing,
 * so the app still runs (in local mode) while the key is being rotated.
 */

import {
  Client,
  Databases,
  Embeddings,
  EmbeddingModel,
  Query,
  TablesDB,
  VectorsDB,
} from 'node-appwrite';
import type { Profile } from './rules.js';
import type { SchemeDoc } from './engine.js';

export const DB = process.env.APPWRITE_DATABASE_ID ?? 'eligible';
export const T_SCHEMES = process.env.APPWRITE_TABLE_SCHEMES ?? 'schemes';
export const T_PROFILES = process.env.APPWRITE_TABLE_PROFILES ?? 'profiles';
export const T_SEARCHES = process.env.APPWRITE_TABLE_SEARCHES ?? 'searches';
export const VDB = process.env.VECTORS_DATABASE_ID ?? 'eligible_vectors';
export const V_COLLECTION = process.env.VECTORS_COLLECTION_ID ?? 'scheme_text';
export const EMBED_DIMENSION = 768;
export const EMBED_MODEL = (process.env.EMBEDDING_MODEL as EmbeddingModel) ?? EmbeddingModel.Nomicembedtext;

export type Hit = { slug: string; similarity: number };

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in .env`);
  return value;
}

export function isConfigured(): boolean {
  return Boolean(
    (process.env.APPWRITE_ENDPOINT || process.env.ENDPOINT) &&
      (process.env.APPWRITE_PROJECT_ID || process.env.PROJECT_ID) &&
      (process.env.APPWRITE_API_KEY || process.env.API_KEY),
  );
}

export function client(): Client {
  return new Client()
    .setEndpoint(process.env.APPWRITE_ENDPOINT || need('ENDPOINT'))
    .setProject(process.env.APPWRITE_PROJECT_ID || need('PROJECT_ID'))
    .setKey(process.env.APPWRITE_API_KEY || need('API_KEY'));
}

let cached: { tables: TablesDB; vectors: VectorsDB; embeddings: Embeddings; databases: Databases } | null = null;

export function services() {
  if (cached) return cached;
  const c = client();
  cached = {
    tables: new TablesDB(c),
    vectors: new VectorsDB(c),
    embeddings: new Embeddings(c),
    databases: new Databases(c),
  };
  return cached;
}

/** Cosine similarity lives on the document under one of these keys. */
export function readSimilarity(doc: Record<string, unknown>): number {
  for (const key of ['$vectorCosine', '$similarity', '$score', '$vectorDot']) {
    const value = doc[key];
    if (typeof value === 'number') return Number(value.toFixed(4));
  }
  return 0;
}

export async function embed(texts: string[]): Promise<number[][]> {
  const { embeddings } = services();
  const list = await embeddings.createTextEmbeddings({ texts, model: EMBED_MODEL });
  return list.embeddings.map((e) => e.embedding).filter((v): v is number[] => Array.isArray(v) && v.length > 0);
}

const SELECT = [
  'slug', 'name', 'jurisdiction', 'level', 'summary', 'benefitAmount', 'benefitKind',
  'benefitLine', 'minAge', 'maxAge', 'incomeCeiling', 'womenOnly', 'appMode',
  'officialLink', 'tags', 'occupations', 'categories', 'docsCount',
  'hasAgeRule', 'hasIncomeRule',
];

/** The arithmetic half. Every clause is a column, not a guess. */
export async function tableCandidates(profile: Profile): Promise<Record<string, unknown>[]> {
  const { tables } = services();
  const queries: string[] = [Query.select(SELECT), Query.limit(500)];
  if (profile.state) queries.push(Query.equal('jurisdiction', [profile.state, 'All India']));
  if (profile.age !== null && profile.age !== undefined) {
    queries.push(Query.lessThanEqual('minAge', profile.age));
    queries.push(Query.greaterThanEqual('maxAge', profile.age));
  }
  if (profile.income !== null && profile.income !== undefined) {
    queries.push(Query.greaterThanEqual('incomeCeiling', profile.income));
  }
  const list = await tables.listRows({ databaseId: DB, tableId: T_SCHEMES, queries });
  return list.rows as unknown as Record<string, unknown>[];
}

/**
 * The meaning half.
 *
 * Cosine similarity runs inside the VectorsDB collection, which stores one
 * document per scheme: the slug plus the embedded prose. Slugs are joined back
 * to the tables afterwards, so the vector store never duplicates the numbers
 * the table already owns.
 */
export async function semanticCandidates(text: string, limit = 80): Promise<Hit[]> {
  const { vectors } = services();
  const [vector] = await embed([text]);
  if (!vector) return [];
  const list = await vectors.listDocuments({
    databaseId: VDB,
    collectionId: V_COLLECTION,
    queries: [Query.vectorCosine('embedding', vector), Query.limit(limit)],
  });
  return (list.documents as unknown as Record<string, unknown>[]).map((doc) => ({
    slug: String(doc.slug ?? doc.$id),
    similarity: readSimilarity(doc),
  }));
}

export async function rowsBySlug(slugs: string[]): Promise<Record<string, unknown>[]> {
  if (!slugs.length) return [];
  const { tables } = services();
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < slugs.length; i += 100) {
    const chunk = slugs.slice(i, i + 100);
    const list = await tables.listRows({
      databaseId: DB,
      tableId: T_SCHEMES,
      queries: [Query.equal('slug', chunk), Query.select(SELECT)],
    });
    out.push(...(list.rows as unknown as Record<string, unknown>[]));
  }
  return out;
}

export async function recordSearch(profile: Profile, text: string, matched: number, near: number, ms: number): Promise<void> {
  try {
    const { tables } = services();
    await tables.createRow({
      databaseId: DB,
      tableId: T_SEARCHES,
      rowId: `s_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      data: {
        age: profile.age ?? -1,
        income: profile.income ?? -1,
        state: profile.state ?? '',
        gender: profile.gender ?? '',
        occupation: profile.occupations.join(',').slice(0, 200),
        query: text.slice(0, 2000),
        matched,
        near,
        ms,
      },
    });
  } catch {
    // Logging is a nicety. A full text index must never break a search.
  }
}

export async function stats(): Promise<{ schemes: number; searches: number }> {
  if (!isConfigured()) return { schemes: 0, searches: 0 };
  try {
    const { tables } = services();
    const [a, b] = await Promise.all([
      tables.listRows({ databaseId: DB, tableId: T_SCHEMES, queries: [Query.limit(1)] }),
      tables.listRows({ databaseId: DB, tableId: T_SEARCHES, queries: [Query.limit(1)] }),
    ]);
    return { schemes: a.total, searches: b.total };
  } catch {
    return { schemes: 0, searches: 0 };
  }
}

/** Flat row payload for bulk insert; TablesDB wants plain values only. */
export function toRow(doc: SchemeDoc): Record<string, unknown> {
  return {
    slug: doc.slug,
    name: doc.name.slice(0, 256),
    jurisdiction: doc.jurisdiction.slice(0, 64),
    level: doc.level.slice(0, 24),
    summary: (doc.summary || '').slice(0, 1800),
    benefitAmount: Math.round(doc.benefitAmount || 0),
    benefitKind: doc.benefitKind.slice(0, 24),
    benefitLine: (doc.benefitLine || '').slice(0, 480),
    minAge: doc.minAge,
    maxAge: doc.maxAge,
    incomeCeiling: doc.incomeCeiling,
    womenOnly: Boolean(doc.womenOnly),
    disabilityOnly: Boolean(doc.disabilityOnly),
    appMode: (doc.appMode || '').slice(0, 48),
    officialLink: (doc.officialLink || '').slice(0, 480),
    tags: doc.tags.join(',').slice(0, 480),
    occupations: doc.occupations.join(',').slice(0, 240),
    categories: doc.categories.join(',').slice(0, 240),
    docsCount: doc.docsCount,
    hasAgeRule: doc.hasAgeRule,
    hasIncomeRule: doc.hasIncomeRule,
    eligibility: (doc.eligibilityExcerpt || '').slice(0, 1800),
    documents: (doc.documents ?? []).join(' | ').slice(0, 1800),
  };
}
