#!/usr/bin/env tsx
/**
 * Admin i18n parity gate (T-06). Run from the repo root:
 *   npx tsx apps/admin/scripts/check-i18n-parity.ts
 * Fails on: key-set mismatch across ar/en/tr, empty values, `{var}` placeholder
 * sets that differ from en, t('…') keys missing from the catalogs, ar/tr keys
 * missing from REVIEW_STATUS.json (or not flagged needs_human_review), and
 * dynamic t(`prefix.${x}`) targets that do not exist.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ADMIN = join(__dirname, '..');
const MSG = join(ADMIN, 'src/messages');
const LOCALES = ['ar', 'en', 'tr'] as const;
let failures = 0;
const fail = (msg: string) => {
  failures++;
  process.stderr.write(`  FAIL ${msg}\n`);
};

const load = (file: string) => JSON.parse(readFileSync(join(MSG, file), 'utf8')) as Record<string, unknown>;
const cat = Object.fromEntries(LOCALES.map((l) => [l, load(`${l}.json`) as Record<string, string>])) as Record<
  (typeof LOCALES)[number],
  Record<string, string>
>;
const placeholders = (v: string) =>
  [...v.matchAll(/\{(\w+)\}/g)]
    .map((m) => m[1] ?? '')
    .sort()
    .join(',');

const enKeys = Object.keys(cat.en).sort();
for (const l of LOCALES) {
  const keys = Object.keys(cat[l]).sort();
  if (JSON.stringify(keys) !== JSON.stringify(enKeys)) {
    fail(
      `${l}: key set differs from en (missing: ${enKeys.filter((k) => !(k in cat[l])).join(', ') || 'none'}; extra: ${keys.filter((k) => !(k in cat.en)).join(', ') || 'none'})`,
    );
  }
  for (const [k, v] of Object.entries(cat[l])) {
    if (typeof v !== 'string' || v.trim().length === 0) fail(`${l}: empty value for "${k}"`);
    else if (placeholders(v) !== placeholders(cat.en[k] ?? '')) fail(`${l}: placeholders of "${k}" differ from en`);
  }
}

const review = load('REVIEW_STATUS.json') as Record<string, Record<string, { needs_human_review?: boolean }>>;
for (const l of ['ar', 'tr'] as const) {
  for (const k of enKeys) {
    if (review[l]?.[k]?.needs_human_review !== true) fail(`REVIEW_STATUS.json: ${l}.${k} is not flagged needs_human_review`);
  }
  for (const k of Object.keys(review[l] ?? {})) if (!(k in cat.en)) fail(`REVIEW_STATUS.json: stale ${l}.${k}`);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}
const used = new Set<string>();
for (const file of walk(join(ADMIN, 'src'))) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/\bt\(\s*'([^']+)'/g)) used.add(m[1] ?? '');
  for (const m of src.matchAll(/'(nav\.[\w.]+)'/g)) used.add(m[1] ?? '');
  for (const m of src.matchAll(/\bt\(\s*`([\w.]*)\$\{/g)) {
    const prefix = m[1] ?? '';
    if (!enKeys.some((k) => k.startsWith(prefix))) fail(`${relative(ADMIN, file)}: dynamic key prefix "${prefix}" matches nothing`);
  }
}
for (const k of used) if (!(k in cat.en)) fail(`code references unknown key "${k}"`);

if (failures) {
  process.stderr.write(`admin i18n parity: ${failures} failure(s)\n`);
  process.exit(1);
}
process.stdout.write(`admin i18n parity OK: ${enKeys.length} keys x ${LOCALES.length} locales, ${used.size} keys referenced by literal calls\n`);
