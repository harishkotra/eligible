/**
 * Build Eligible's data layer on Appwrite, from nothing.
 *
 * TWO DATABASE TYPES, TWO JOBS, ONE SCRIPT:
 *
 *   1. TablesDB  - the arithmetic. Columns for jurisdiction, age band, income
 *      ceiling, rupee benefit, document count. Indexed, so the query is a
 *      range scan and not a filter over 2,066 rows in memory.
 *   2. VectorsDB - the meaning. One document per scheme holding the slug and
 *      the embedded eligibility prose. Cosine similarity does the recall.
 *
 * ORDER MATTERS. Tables first, because the free plan allows one shared
 * database and the app must still work if the vector layer is not available.
 * The vector layer is attempted last and, if the project is on the free plan,
 * this script says so plainly instead of pretending: VectorsDB needs dedicated
 * compute ($10/month Micro, 1 GB) because an HNSW index keeps its graph in RAM.
 *
 * RUN
 *   npx tsx scripts/setup-appwrite.ts            # build everything
 *   npx tsx scripts/setup-appwrite.ts --dry      # print the plan, touch nothing
 *   npx tsx scripts/setup-appwrite.ts --vectors  # only rebuild the vector layer
 *
 * Needs ENDPOINT, PROJECT_ID, API_KEY in .env. The key must carry
 * rows.read + rows.write + collections/tables write. Nothing here prints a key.
 */

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { Client, Embeddings, Query, TablesDB, TablesDBIndexType, VectorsDB } from 'node-appwrite';
import { DB, EMBED_DIMENSION, EMBED_MODEL, T_PROFILES, T_SCHEMES, T_SEARCHES, V_COLLECTION, VDB, toRow } from '../server/appwrite.js';

const DRY = process.argv.includes('--dry');
const VECTORS_ONLY = process.argv.includes('--vectors');
const BATCH = 100;

type Column =
  | { kind: 'string'; key: string; size: number; required: boolean }
  | { kind: 'text'; key: string; required: boolean }
  | { kind: 'int'; key: string; required: boolean; min?: number; max?: number }
  | { kind: 'bool'; key: string; required: boolean };

const log = (...parts: unknown[]) => console.log(...parts);

function requireEnv(): { endpoint: string; project: string; key: string } {
  const endpoint = process.env.APPWRITE_ENDPOINT || process.env.ENDPOINT || '';
  const project = process.env.APPWRITE_PROJECT_ID || process.env.PROJECT_ID || '';
  const key = process.env.APPWRITE_API_KEY || process.env.API_KEY || '';
  const missing = [
    ['ENDPOINT', endpoint],
    ['PROJECT_ID', project],
    ['API_KEY', key],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    throw new Error(`Missing ${missing.join(', ')} in .env. Nothing was created.`);
  }
  return { endpoint, project, key };
}

/** The schemes table. Every column exists because a rule reads it. */
const SCHEME_COLUMNS: Column[] = [
  { kind: 'string', key: 'slug', size: 128, required: true },
  { kind: 'string', key: 'name', size: 256, required: true },
  { kind: 'string', key: 'jurisdiction', size: 64, required: true },
  { kind: 'string', key: 'level', size: 24, required: true },
  { kind: 'text', key: 'summary', required: false },
  { kind: 'int', key: 'benefitAmount', required: true },
  { kind: 'string', key: 'benefitKind', size: 24, required: true },
  { kind: 'string', key: 'benefitLine', size: 480, required: false },
  { kind: 'int', key: 'minAge', required: true },
  { kind: 'int', key: 'maxAge', required: true },
  { kind: 'int', key: 'incomeCeiling', required: true },
  { kind: 'bool', key: 'hasAgeRule', required: true },
  { kind: 'bool', key: 'hasIncomeRule', required: true },
  { kind: 'bool', key: 'womenOnly', required: true },
  { kind: 'bool', key: 'disabilityOnly', required: true },
  { kind: 'string', key: 'appMode', size: 48, required: false },
  { kind: 'string', key: 'officialLink', size: 480, required: false },
  { kind: 'string', key: 'tags', size: 480, required: false },
  { kind: 'string', key: 'occupations', size: 240, required: false },
  { kind: 'string', key: 'categories', size: 240, required: false },
  { kind: 'int', key: 'docsCount', required: true },
  { kind: 'text', key: 'eligibility', required: false },
  { kind: 'text', key: 'documents', required: false },
];

const PROFILE_COLUMNS: Column[] = [
  { kind: 'int', key: 'age', required: false },
  { kind: 'int', key: 'income', required: false },
  { kind: 'string', key: 'state', size: 64, required: false },
  { kind: 'string', key: 'gender', size: 24, required: false },
  { kind: 'string', key: 'category', size: 48, required: false },
  { kind: 'string', key: 'occupations', size: 240, required: false },
  { kind: 'string', key: 'text', size: 2000, required: false },
  { kind: 'bool', key: 'saved', required: false },
];

const SEARCH_COLUMNS: Column[] = [
  { kind: 'int', key: 'age', required: true },
  { kind: 'int', key: 'income', required: true },
  { kind: 'string', key: 'state', size: 64, required: false },
  { kind: 'string', key: 'gender', size: 24, required: false },
  { kind: 'string', key: 'occupation', size: 240, required: false },
  { kind: 'string', key: 'query', size: 2000, required: false },
  { kind: 'int', key: 'matched', required: true },
  { kind: 'int', key: 'near', required: true },
  { kind: 'int', key: 'ms', required: true },
];

async function exists(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch {
    return false;
  }
}

async function addColumns(tables: TablesDB, tableId: string, columns: Column[]): Promise<void> {
  for (const c of columns) {
    const base = { databaseId: DB, tableId, key: c.key, required: c.required };
    const present = await exists(() => tables.getColumn({ ...base, key: c.key }));
    if (present) {
      log(`    = ${tableId}.${c.key}`);
      continue;
    }
    if (c.kind === 'string') await tables.createStringColumn({ ...base, size: c.size });
    else if (c.kind === 'text') await tables.createTextColumn(base);
    else if (c.kind === 'int') await tables.createIntegerColumn({ ...base, min: c.min ?? null, max: c.max ?? null });
    else await tables.createBooleanColumn(base);
    log(`    + ${tableId}.${c.key} (${c.kind})`);
    // Column changes are asynchronous on Appwrite; give the index a beat.
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function addIndex(tables: TablesDB, tableId: string, key: string, type: TablesDBIndexType, columns: string[]): Promise<void> {
  const base = { databaseId: DB, tableId, key, type, columns };
  const present = await exists(() => tables.getIndex({ databaseId: DB, tableId, key }));
  if (present) {
    log(`    = index ${tableId}.${key}`);
    return;
  }
  await tables.createIndex(base);
  log(`    + index ${tableId}.${key} on ${columns.join(', ')}`);
}

async function buildTables(tables: TablesDB): Promise<void> {
  const dbPresent = await exists(() => tables.get({ databaseId: DB }));
  if (!dbPresent) {
    await tables.create({ databaseId: DB, name: 'Eligible' });
    log(`+ database ${DB}`);
  } else {
    log(`= database ${DB}`);
  }

  for (const [tableId, name, columns] of [
    [T_SCHEMES, 'Schemes', SCHEME_COLUMNS],
    [T_PROFILES, 'Profiles', PROFILE_COLUMNS],
    [T_SEARCHES, 'Searches', SEARCH_COLUMNS],
  ] as Array<[string, string, Column[]]>) {
    const present = await exists(() => tables.getTable({ databaseId: DB, tableId }));
    if (present) log(`= table ${tableId}`);
    else {
      await tables.createTable({ databaseId: DB, tableId, name });
      log(`+ table ${tableId}`);
    }
    await addColumns(tables, tableId, columns);
  }

  // The three clauses the engine actually runs, each backed by an index.
  await addIndex(tables, T_SCHEMES, 'by_jurisdiction', TablesDBIndexType.Key, ['jurisdiction']);
  await addIndex(tables, T_SCHEMES, 'by_slug', TablesDBIndexType.Unique, ['slug']);
  await addIndex(tables, T_SCHEMES, 'by_age', TablesDBIndexType.Key, ['minAge', 'maxAge']);
  await addIndex(tables, T_SCHEMES, 'by_ceiling', TablesDBIndexType.Key, ['incomeCeiling']);
  await addIndex(tables, T_SCHEMES, 'by_name', TablesDBIndexType.Fulltext, ['name']);
}

// The fixture is a plain array of scheme objects. Accept a wrapped shape too,
// because a half-regenerated file should not turn into "undefined.length".
type SchemeRow = Record<string, unknown>;

function readFixture(): SchemeRow[] {
  const parsed: unknown = JSON.parse(readFileSync('data/fixtures/schemes.json', 'utf8'));
  if (Array.isArray(parsed)) return parsed as SchemeRow[];
  const wrapped = parsed as { schemes?: SchemeRow[]; rows?: SchemeRow[] };
  return wrapped.schemes ?? wrapped.rows ?? [];
}

async function loadRows(tables: TablesDB): Promise<void> {
  const rows = readFixture();
  const current = await tables.listRows({ databaseId: DB, tableId: T_SCHEMES, queries: [Query.limit(1)] });
  if (current.total === rows.length) {
    log(`= ${rows.length} rows already in ${T_SCHEMES}, not re-sent`);
    return;
  }
  log(`+ sending ${rows.length} rows in batches of ${BATCH}`);
  let sent = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    // Appwrite rejects any attribute the table does not declare, and the
    // fixture carries extras (issuer, embedText, ageClause, genders). Project
    // every row through toRow so the payload is exactly the table's columns.
    const chunk: Array<Record<string, unknown>> = rows
      .slice(i, i + BATCH)
      .map((r) => ({ ...toRow(r as never), $id: String(r.slug) }));
    try {
      await tables.createRows({ databaseId: DB, tableId: T_SCHEMES, rows: chunk });
      sent += chunk.length;
    } catch (error) {
      // One bad row must not lose the other ninety-nine: retry them singly.
      const e = error as { message?: string; code?: number; type?: string };
      log(`  ! batch at ${i} failed (${e.type ?? ''} ${e.code ?? ''} ${e.message ?? ''}), retrying singly`);
      for (const row of chunk) {
        try {
          const { $id, ...data } = row as Record<string, unknown>;
          await tables.createRow({ databaseId: DB, tableId: T_SCHEMES, rowId: String($id), data });
          sent += 1;
        } catch (inner) {
          log(`    x ${String(row.slug)}: ${(inner as Error).message.slice(0, 100)}`);
        }
      }
    }
    log(`  ${sent}/${rows.length}`);
  }
}

async function buildVectors(vectors: VectorsDB, client: Client, tables: TablesDB): Promise<boolean> {
  const dbPresent = await exists(() => vectors.get({ databaseId: VDB }));
  if (!dbPresent) {
    try {
      await vectors.create({ databaseId: VDB, name: 'Eligible meaning' });
      log(`+ vector database ${VDB}`);
    } catch (error) {
      const message = (error as Error).message;
      log('');
      log('VECTORS SKIPPED - the table layer is complete and the app runs on it.');
      log(`  reason: ${message.slice(0, 200)}`);
      log('  VectorsDB needs dedicated compute (Micro, 1 GB, $10/month): an HNSW');
      log('  index keeps its graph in RAM, which shared compute does not give it.');
      return false;
    }
  }

  const present = await exists(() => vectors.getCollection({ databaseId: VDB, collectionId: V_COLLECTION }));
  if (!present) {
    await vectors.createCollection({
      databaseId: VDB,
      collectionId: V_COLLECTION,
      name: 'Scheme meaning',
      dimension: EMBED_DIMENSION,
    });
    log(`+ vector collection ${V_COLLECTION} (${EMBED_DIMENSION}d, ${EMBED_MODEL})`);
  }

  // The embedding column is what cosine search runs against.
  const indexPresent = await exists(() => vectors.getIndex({ databaseId: VDB, collectionId: V_COLLECTION, key: 'by_meaning' }));
  if (!indexPresent) {
    await vectors.createIndex({
      databaseId: VDB,
      collectionId: V_COLLECTION,
      key: 'by_meaning',
      type: 'hnsw_cosine' as never,
      attributes: ['embedding'],
    });
    log('+ hnsw_cosine index on embedding');
  }

  const rows = readFixture();
  const embedText = rows.map((r) => String(r.embedText ?? ''));
  const have = await vectors.listDocuments({ databaseId: VDB, collectionId: V_COLLECTION, queries: [Query.limit(1)] });
  if (have.total === rows.length) {
    log(`= ${rows.length} embeddings already present`);
    return true;
  }

  const embeddings = new Embeddings(client);
  log(`+ embedding ${rows.length} scheme paragraphs with ${EMBED_MODEL}`);
  const docs: Array<Record<string, unknown>> = [];
  for (let i = 0; i < rows.length; i += 50) {
    const chunk = embedText.slice(i, i + 50);
    const list = await embeddings.createTextEmbeddings({ texts: chunk, model: EMBED_MODEL });
    list.embeddings.forEach((e, j) => {
      const slug = String(rows[i + j]?.slug ?? '');
      if (!slug || !e.embedding?.length) return;
      docs.push({ $id: slug, slug, embedding: e.embedding, text: chunk[j].slice(0, 1200) });
    });
    log(`  ${Math.min(i + 50, rows.length)}/${rows.length}`);
  }

  for (let i = 0; i < docs.length; i += BATCH) {
    await vectors.createDocuments({ databaseId: VDB, collectionId: V_COLLECTION, documents: docs.slice(i, i + BATCH) });
  }
  log(`+ ${docs.length} vector documents`);
  void tables;
  return true;
}

async function main(): Promise<void> {
  const { endpoint, project, key } = requireEnv();
  log(`Eligible setup -> ${endpoint} project ${project}`);
  log(DRY ? '(dry run: printing the plan only)' : '');

  if (DRY) {
    log(`\nTablesDB database ${DB}`);
    for (const [t, , cols] of [
      [T_SCHEMES, '', SCHEME_COLUMNS],
      [T_PROFILES, '', PROFILE_COLUMNS],
      [T_SEARCHES, '', SEARCH_COLUMNS],
    ] as Array<[string, string, Column[]]>) {
      log(`  table ${t}: ${cols.map((c) => c.key).join(', ')}`);
    }
    log(`\nVectorsDB database ${VDB} / collection ${V_COLLECTION} (${EMBED_DIMENSION}d)`);
    log('\nnothing was created');
    return;
  }

  const client = new Client().setEndpoint(endpoint).setProject(project).setKey(key);
  const tables = new TablesDB(client);
  const vectors = new VectorsDB(client);

  if (!VECTORS_ONLY) {
    log('\n-- table layer');
    await buildTables(tables);
    log('\n-- rows');
    await loadRows(tables);
  }

  log('\n-- meaning layer');
  const vectorOk = await buildVectors(vectors, client, tables);

  log('');
  log(`tables: ${vectorOk ? 'complete' : 'complete (vector layer missing)'}`);
  log(vectorOk ? 'vectors: complete' : 'vectors: not built');
  log('verify with: npx tsx scripts/verify-appwrite.ts');
}

main().catch((error) => {
  console.error(`\nsetup failed: ${(error as Error).message}`);
  process.exit(1);
});
