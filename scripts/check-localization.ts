#!/usr/bin/env tsx
/**
 * Localization gate (Final Enforcement Directive §64).
 * Fails on: missing key, empty value, key mismatch across ar/en/tr,
 * raw-key-looking values, and t('...') calls referencing unknown keys.
 * Also verifies the design system provider is direction-aware (RTL).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const LOCALES = ['ar', 'en', 'tr'] as const;
let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.error(`  FAIL ${msg}`);
};

const catalogs = new Map<string, Record<string, string>>();
for (const locale of LOCALES) {
  const file = join(__dirname, `../apps/web/src/messages/${locale}.json`);
  try {
    catalogs.set(locale, JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>);
  } catch {
    fail(`missing or invalid catalog: apps/web/src/messages/${locale}.json`);
  }
}

const ar = catalogs.get('ar') ?? {};
const arKeys = Object.keys(ar).sort();
for (const locale of LOCALES) {
  const dict = catalogs.get(locale) ?? {};
  const keys = Object.keys(dict).sort();
  if (JSON.stringify(keys) !== JSON.stringify(arKeys)) {
    const missing = arKeys.filter((k) => !(k in dict));
    const extra = keys.filter((k) => !(k in ar));
    fail(`catalog ${locale}: key mismatch (missing: ${missing.slice(0, 5).join(', ') || 'none'}; extra: ${extra.slice(0, 5).join(', ') || 'none'})`);
  }
  for (const [k, v] of Object.entries(dict)) {
    if (typeof v !== 'string' || v.trim().length === 0) fail(`catalog ${locale}: empty value for key "${k}"`);
    if (v === k) fail(`catalog ${locale}: raw key rendered as value for "${k}"`);
    if (/^[a-z]+(\.[a-zA-Z0-9]+){2,}$/.test(v.trim())) fail(`catalog ${locale}: value of "${k}" looks like an untranslated key ("${v}")`);
  }
}

// t('...') call sites must reference known keys.
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}
const known = new Set(arKeys);
for (const file of walk(join(__dirname, '../apps/web/src/app'))) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/\bt\(\s*'([a-z][a-zA-Z0-9.]+)'\s*\)/g)) {
    if (!known.has(m[1] ?? '')) fail(`${file}: t('${m[1]}') references an unknown key`);
  }
}

// Design system must be direction-aware.
const provider = readFileSync(join(__dirname, '../packages/design-system/src/provider.tsx'), 'utf8');
if (!/dirOf|rtl/.test(provider)) fail('design-system provider is not RTL-aware');

if (failures > 0) {
  console.error(`\nLOCALIZATION CHECK: FAIL (${failures})`);
  process.exit(1);
}
console.log(`LOCALIZATION CHECK: PASS (${arKeys.length} keys × ${LOCALES.length} locales)`);
