#!/usr/bin/env tsx
/**
 * Localization gate (Final Enforcement Directive §64).
 * Fails on: missing key, empty value, key mismatch across ar/en/tr,
 * raw-key-looking values, and t('...') calls referencing unknown keys.
 * Also verifies the design system provider is direction-aware (RTL).
 *
 * P3-S7 (contract §7.2(a)):
 * - the t() scan walks all of `apps/web/src` (views live in `src/views`, not
 *   `src/app`), matches keys with `_` and calls that pass variables, and
 *   checks the header's `t(\`nav.${…}\`)` by enumerating its NAV keys;
 * - the merchant-jargon pass: every S7-namespace value against its locale's
 *   denylist, and the S7 web source rules (no JSX text literal outside t(),
 *   no server message rendered, no accounting.* key) —
 *   `scripts/guards/merchant-jargon.ts`, shared with apps/web/test/jargon.test.ts.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { findMerchantJargon, findS7SourceViolations } from './guards/merchant-jargon';

const ROOT = join(__dirname, '..');
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

// t('...') call sites must reference known keys — across all of apps/web/src.
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
const sources: Record<string, string> = {};
for (const file of walk(join(ROOT, 'apps/web/src'))) {
  const src = readFileSync(file, 'utf8');
  sources[relative(ROOT, file).split('\\').join('/')] = src;
  for (const m of src.matchAll(/\bt\(\s*'([a-z][\w.]+)'\s*[,)]/g)) {
    if (!known.has(m[1] ?? '')) fail(`${file}: t('${m[1]}') references an unknown key`);
  }
  // A template call over the header's NAV array: every key it can produce must exist.
  if (/\bt\(`nav\.\$\{item\.key\}`\)/.test(src)) {
    const nav = /const NAV = \[([\s\S]*?)\]/.exec(src)?.[1] ?? '';
    const navKeys = [...nav.matchAll(/\bkey:\s*'([\w.]+)'/g)].map((k) => k[1] ?? '');
    if (navKeys.length === 0) fail(`${file}: t(\`nav.\${item.key}\`) but no NAV keys could be read`);
    for (const k of navKeys) if (!known.has(`nav.${k}`)) fail(`${file}: NAV item "${k}" has no nav.${k} key`);
  }
}

// P3-S7 merchant-jargon pass (§7.2(a), T-09): the catalog half, then the source half.
for (const hit of findMerchantJargon({ ar: catalogs.get('ar'), en: catalogs.get('en'), tr: catalogs.get('tr') })) {
  fail(`catalog ${hit.locale}: "${hit.key}" uses the accounting or engine term "${hit.term}" in merchant text ("${hit.value}") — SIM-06, GL §5.2`);
}
for (const hit of findS7SourceViolations(sources)) {
  fail(`${hit.file}:${hit.line}: ${hit.rule} ("${hit.evidence}") — T-09`);
}

// Design system must be direction-aware.
const provider = readFileSync(join(__dirname, '../packages/design-system/src/provider.tsx'), 'utf8');
if (!/dirOf|rtl/.test(provider)) fail('design-system provider is not RTL-aware');

if (failures > 0) {
  console.error(`\nLOCALIZATION CHECK: FAIL (${failures})`);
  process.exit(1);
}
console.log(`LOCALIZATION CHECK: PASS (${arKeys.length} keys × ${LOCALES.length} locales)`);
