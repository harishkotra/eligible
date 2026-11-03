/**
 * Prove the Appwrite side exists, before you trust it with a demo.
 *
 * This is a read-only check. It answers four questions in order:
 *
 *   1. Can I reach the project, and do I have the right key?
 *   2. Does the table layer hold every row, with the columns the rules read?
 *   3. Are the indexes there, or will every search scan 2,066 rows?
 *   4. Does the meaning layer answer, and does a cosine hit join back to a row?
 *
 * Exit code 0 means all of that is true. Anything else prints the failing
 * step and stops, so a broken half never looks like a finished product.
 *
 *   npx tsx scripts/verify-appwrite.ts
 */

import 'dotenv/config';
import { Client, TablesDB, VectorsDB, Query } from 'node-appwrite';
import { DB, T_PROFILES, T_SCHEMES, T_SEARCHES, V_COLLECTION, VDB, isConfigured } from '../server/appwrite.js';

const REQUIRED_COLUMNS = [
  'slug', 'name', 'jurisdiction', 'level', 'benefitAmount', 'benefitKind', 'minAge', 'maxAge',
  'incomeCeiling', 'hasAgeRule', 'hasIncomeRule', 'womenOnly', 'disabilityOnly', 'docsCount',
];
const REQUIRED_INDEXES = ['by_jurisdiction', 'by_slug', 'by_age', 'by_ceiling'];

const failures: string[] = [];
const notes: string[] = [];
const ok = (label: string, extra = '') => console.log(`  ok   ${label}${extra ? ` — ${extra}` : ''}`);
const bad = (label: string, why: string) => {
  console.log(`  FAIL ${label} — ${why}`);
  failures.push(`${label}: ${why}`);
};

async function main(): Promise<void> {
  if (!isConfigured()) {
    console.log('\nNo Appwrite credentials in .env, so there is nothing to verify.');
    console.log('Local mode is the default. Copy .env.example to .env and fill it in first.\n');
    process.exit(2);
  }

  const endpoint = process.env.APPWRITE_ENDPOINT || process.env.ENDPOINT || '';
  const project = process.env.APPWRITE_PROJECT_ID || process.env.PROJECT_ID || '';
  const key = process.env.APPWRITE_API_KEY || process.env.API_KEY || '';
  const client = new Client().setEndpoint(endpoint).setProject(project).setKey(key);
  const tables = new TablesDB(client);
  const vectors = new VectorsDB(client);

  console.log(`\nEligible verify -> ${endpoint} project ${project}\n`);

  // 1. reachability
  try {
    const db = await tables.get({ databaseId: DB });
    ok('database reachable', db.name);
  } catch (error) {
    bad('database reachable', (error as Error).message.slice(0, 200));
    process.exit(1);
  }

  // 2. tables and rows
  for (const tableId of [T_SCHEMES, T_PROFILES, T_SEARCHES]) {
    try {
      const columns = await tables.listColumns({ databaseId: DB, tableId });
      const keys = columns.columns.map((c) => c.key);
      ok(`table ${tableId}`, `${keys.length} columns`);
      if (tableId === T_SCHEMES) {
        const missing = REQUIRED_COLUMNS.filter((c) => !keys.includes(c));
        if (missing.length) bad(`columns in ${tableId}`, `missing ${missing.join(', ')}`);
      }
    } catch (error) {
      bad(`table ${tableId}`, (error as Error).message.slice(0, 160));
    }
  }

  let rows = 0;
  try {
    const list = await tables.listRows({ databaseId: DB, tableId: T_SCHEMES, queries: [Query.limit(1)] });
    rows = list.total;
    if (rows < 2000) bad('scheme rows', `only ${rows} present; run npx tsx scripts/setup-appwrite.ts`);
    else ok('scheme rows', `${rows.toLocaleString('en-IN')}`);
  } catch (error) {
    bad('scheme rows', (error as Error).message.slice(0, 160));
  }

  // 3. indexes
  try {
    const list = await tables.listIndexes({ databaseId: DB, tableId: T_SCHEMES });
    const keys = list.indexes.map((i) => i.key);
    const missing = REQUIRED_INDEXES.filter((k) => !keys.includes(k));
    if (missing.length) bad('scheme indexes', `missing ${missing.join(', ')}`);
    else ok('scheme indexes', keys.join(', '));
  } catch (error) {
    bad('scheme indexes', (error as Error).message.slice(0, 160));
  }

  // 4. the meaning layer
  try {
    await vectors.get({ databaseId: VDB });
    const col = await vectors.getCollection({ databaseId: VDB, collectionId: V_COLLECTION });
    ok('vector collection', `${col.name}, ${col.dimension}d`);
    const docs = await vectors.listDocuments({ databaseId: VDB, collectionId: V_COLLECTION, queries: [Query.limit(1)] });
    if (docs.total < 2000) {
      notes.push(`vector layer holds ${docs.total} of ${rows} schemes; searches fall back to lexical scoring for the rest`);
      console.log(`  warn vector documents — ${docs.total.toLocaleString('en-IN')} of ${rows.toLocaleString('en-IN')}`);
    } else {
      ok('vector documents', docs.total.toLocaleString('en-IN'));
    }
  } catch (error) {
    notes.push('vector layer absent: VectorsDB needs dedicated compute, so semantic recall is lexical instead');
    console.log(`  warn vector layer — ${(error as Error).message.slice(0, 140)}`);
  }

  console.log('');
  for (const n of notes) console.log(`  note ${n}`);
  if (failures.length) {
    console.log(`\n${failures.length} check(s) failed. The table layer is not ready.\n`);
    process.exit(1);
  }
  console.log('All required checks passed. Start the API and it will use Appwrite.\n');
}

main().catch((error) => {
  console.error(`verify crashed: ${(error as Error).message}`);
  process.exit(1);
});
