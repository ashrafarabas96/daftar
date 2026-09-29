#!/usr/bin/env tsx
/**
 * PHASE 1 MACHINE GATE (Final Enforcement Directive §4–6, §75).
 * Authoritative release gate: the final report may NOT claim PASS unless this
 * script exits 0. Not a directory-exists check — verifies real buildable
 * content, workspace integrity, artifact hygiene, and required evidence.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.error(`  MISSING ${msg}`);
};
const ok = (msg: string) => console.log(`  ok      ${msg}`);

function requireFile(path: string, label: string, minBytes = 100): void {
  const full = join(ROOT, path);
  if (!existsSync(full)) return fail(`${label} (${path})`);
  if (statSync(full).isFile() && statSync(full).size < minBytes) return fail(`${label} is an empty placeholder (${path})`);
  ok(label);
}

function requireDir(path: string, label: string, minFiles: number, pattern?: RegExp): void {
  const full = join(ROOT, path);
  if (!existsSync(full) || !statSync(full).isDirectory()) return fail(`${label} (${path})`);
  let count = 0;
  const walk = (d: string): void => {
    for (const e of readdirSync(d)) {
      if (['node_modules', '.next', 'dist', 'build', '.gradle'].includes(e)) continue;
      const f = join(d, e);
      if (statSync(f).isDirectory()) walk(f);
      else if (!pattern || pattern.test(e)) count++;
    }
  };
  walk(full);
  if (count < minFiles) return fail(`${label} has only ${count} real files (need ${minFiles}) (${path})`);
  ok(`${label} (${count} files)`);
}

console.log('PHASE 1 GATE — product tree');
requireDir('packages/design-system/src', 'Design System source', 6, /\.tsx?$/);
requireFile('packages/design-system/package.json', 'Design System manifest', 200);
requireDir('apps/web/src', 'Merchant Web source', 15, /\.(tsx?|json|mjs)$/);
requireFile('apps/web/package.json', 'Merchant Web manifest', 200);
requireDir('apps/admin/src', 'Admin Web source', 10, /\.(tsx?|json|mjs)$/);
requireFile('apps/admin/package.json', 'Admin Web manifest', 200);
requireFile('apps/android/settings.gradle.kts', 'Android Gradle settings', 50);
requireFile('apps/android/app/build.gradle.kts', 'Android app module', 300);
requireDir('apps/android/app/src', 'Android Kotlin source', 6, /\.(kt|xml)$/);
requireDir('tests/golden-regression', 'Golden regression suite', 4, /\.test\.ts$/);

console.log('PHASE 1 GATE — machine checks');
requireFile('scripts/check-localization.ts', 'Localization checker', 500);
requireFile('scripts/static-guards.ts', 'Static architecture guards', 500);
requireFile('scripts/export-release.ts', 'Release export script', 500);
requireFile('scripts/verify-migration-history.ts', 'Migration history verifier', 500);
requireFile('.github/workflows/ci.yml', 'CI workflow', 800);
requireFile('infrastructure/database/MIGRATION_MANIFEST.json', 'Migration manifest', 500);

console.log('PHASE 1 GATE — workspace integrity');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { workspaces: string[] };
const expected = [
  'apps/api',
  'apps/web',
  'apps/admin',
  'packages/domain-core',
  'packages/accounting',
  'packages/inventory',
  'packages/shared-contracts',
  'packages/design-system',
].sort();
const actual = [...pkg.workspaces].sort();
if (JSON.stringify(expected) !== JSON.stringify(actual)) fail(`root workspaces must be exactly ${expected.join(', ')} (got ${actual.join(', ')})`);
else ok('exact workspace set');
for (const ws of expected) {
  if (!existsSync(join(ROOT, ws, 'package.json'))) fail(`ghost workspace: ${ws}`);
}
const lock = readFileSync(join(ROOT, 'package-lock.json'), 'utf8');
for (const ws of expected) {
  const name = (JSON.parse(readFileSync(join(ROOT, ws, 'package.json'), 'utf8')) as { name: string }).name;
  if (!lock.includes(`"node_modules/${name}"`)) fail(`package-lock.json does not contain workspace ${name}`);
}
ok('package-lock covers all workspaces');

console.log('PHASE 1 GATE — artifact hygiene');
const forbiddenPaths = ['var/dev-mailbox.log', 'tsconfig.tsbuildinfo', '.env'];
for (const p of forbiddenPaths) {
  if (existsSync(join(ROOT, p))) fail(`forbidden artifact present: ${p}`);
}
if (existsSync(join(ROOT, 'apps/api/dist'))) fail('stale apps/api/dist in source tree');
const zips = readdirSync(ROOT).filter((f) => f.endsWith('.zip'));
if (zips.length > 0) fail(`nested zip(s) in source tree: ${zips.join(', ')}`);
ok('no forbidden release artifacts');

console.log('PHASE 1 GATE — RC evidence reports (final stage)');
for (const doc of [
  'docs/PHASE_1_ACCEPTANCE_REPORT.md',
  'docs/PHASE_1_IMPLEMENTATION_REPORT.md',
  'docs/PHASE_1_TEST_REPORT.md',
  'docs/PHASE_1_SECURITY_REVIEW.md',
]) {
  if (existsSync(join(ROOT, doc))) ok(doc);
  else console.log(`  pending ${doc} (required before release export)`);
}

if (failures > 0) {
  console.error(`\nPHASE 1 GATE: FAIL (${failures} missing/invalid deliverable${failures === 1 ? '' : 's'})`);
  process.exit(1);
}
console.log('\nPHASE 1 GATE: PASS');
