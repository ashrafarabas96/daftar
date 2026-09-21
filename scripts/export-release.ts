#!/usr/bin/env tsx
/**
 * Release export (Final Enforcement Directive §70–72).
 * Allowlist-based source export: copies only declared paths into a staging
 * tree, scans for forbidden content, writes DELIVERY_MANIFEST.json (tree
 * hash, inventory, migration hashes, toolchain, evidence), then zips and
 * writes a SIBLING .sha256 (never inside the zip — no circular hash).
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = join(__dirname, '..');
const sha = (buf: Buffer | string) => createHash('sha256').update(buf).digest('hex');

const ALLOWLIST = [
  'apps/api/src',
  'apps/api/package.json',
  'apps/api/tsconfig.json',
  'apps/web/src',
  'apps/web/package.json',
  'apps/web/next.config.mjs',
  'apps/web/tsconfig.json',
  'apps/admin/src',
  'apps/admin/package.json',
  'apps/admin/next.config.mjs',
  'apps/admin/tsconfig.json',
  'apps/android/settings.gradle.kts',
  'apps/android/build.gradle.kts',
  'apps/android/gradle.properties',
  'apps/android/app',
  'packages/domain-core/src',
  'packages/domain-core/package.json',
  'packages/domain-core/tsconfig.json',
  'packages/shared-contracts/src',
  'packages/shared-contracts/package.json',
  'packages/shared-contracts/tsconfig.json',
  'packages/design-system/src',
  'packages/design-system/package.json',
  'packages/design-system/tsconfig.json',
  'infrastructure/database/migrations',
  'infrastructure/database/MIGRATION_MANIFEST.json',
  'scripts',
  'tests',
  'docs',
  'package.json',
  'package-lock.json',
  'tsconfig.base.json',
  'tsconfig.json',
  'vitest.config.ts',
  'eslint.config.mjs',
  '.github/workflows/ci.yml',
];

const FORBIDDEN_NAME = /(^|\/)(node_modules|dist|\.next|var|coverage|\.gradle|build)(\/|$)|\.env($|\.)|\.log$|\.tsbuildinfo$|\.zip$|\.pem$|\.key$|dev-mailbox/i;
const FORBIDDEN_CONTENT = /DEV_TEST_KEY(?!\w)|argon2id\$[A-Za-z0-9+/=]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

const staging = mkdtempSync(join(tmpdir(), 'daftar-export-'));
const tree = join(staging, 'DAFTAR');
mkdirSync(tree, { recursive: true });

console.log('EXPORT — copying allowlist');
for (const rel of ALLOWLIST) {
  const src = join(ROOT, rel);
  if (!existsSync(src)) {
    console.error(`  FAIL allowlisted path missing: ${rel}`);
    process.exit(1);
  }
  cpSync(src, join(tree, rel), { recursive: true });
}

console.log('EXPORT — walking + hashing inventory');
const inventory: { path: string; sha256: string; bytes: number }[] = [];
const walk = (d: string): void => {
  for (const e of readdirSync(d)) {
    const f = join(d, e);
    const rel = relative(tree, f);
    if (FORBIDDEN_NAME.test(rel + (statSync(f).isDirectory() ? '/' : ''))) {
      if (statSync(f).isDirectory()) {
        // Allowlisted parents (e.g. apps/android/app) may contain build debris on a
        // developer machine: remove it from the staging tree so the zip never carries it.
        rmSync(f, { recursive: true, force: true });
        continue;
      }
      console.error(`  FAIL forbidden file in export: ${rel}`);
      process.exit(1);
    }
    if (statSync(f).isDirectory()) walk(f);
    else {
      const buf = readFileSync(f);
      inventory.push({ path: rel, sha256: sha(buf), bytes: buf.byteLength });
      if (/\.(ts|tsx|sql|kt|kts|json|mjs|yml|yaml|xml)$/.test(e) && FORBIDDEN_CONTENT.test(buf.toString('utf8'))) {
        // credential-protector.ts DEFINES the dev-only constant (gated on NODE_ENV by
        // static guard rule 8 and production-providers.test.ts); every other file
        // that mentions it is a leak.
        if (!/static-guards|export-release|phase1-release-gate|credential-protector\.ts$|\.test\.|docs\//.test(rel)) {
          console.error(`  FAIL raw credential material in export: ${rel}`);
          process.exit(1);
        }
      }
    }
  }
};
walk(tree);

const migrationsDir = join(ROOT, 'infrastructure/database/migrations');
const migrationHashes = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => ({ name: f, sha256: sha(readFileSync(join(migrationsDir, f))) }));

const manifest = {
  product: 'DAFTAR',
  phase: 1,
  kind: 'release-candidate',
  generatedAt: new Date().toISOString(),
  treeHash: sha(inventory.map((i) => `${i.path}:${i.sha256}`).join('\n')),
  fileCount: inventory.length,
  inventory,
  migrationHashes,
  toolchain: { node: '24.12.x', npm: '>=11' },
  evidence: {
    gate: 'npm run gate:phase1',
    golden: 'npm run test:golden',
    localization: 'npm run check:localization',
    staticGuards: 'npm run check:guards',
    migrationHistory: 'npm run verify:history',
  },
};
writeFileSync(join(tree, 'DELIVERY_MANIFEST.json'), JSON.stringify(manifest, null, 2));

mkdirSync(join(ROOT, 'release'), { recursive: true });
const zipPath = join(ROOT, 'release', 'DAFTAR_PHASE_1_RC.zip');
rmSync(zipPath, { force: true });
execFileSync('zip', ['-qr', zipPath, 'DAFTAR'], { cwd: staging });
const zipEntries = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
  .split('\n')
  .filter((l) => l.length > 0 && !l.endsWith('/'));
if (zipEntries.length !== inventory.length + 1) {
  console.error(`  FAIL zip carries ${zipEntries.length} files but the inventory has ${inventory.length} (+ DELIVERY_MANIFEST.json)`);
  process.exit(1);
}
const zipHash = sha(readFileSync(zipPath));
writeFileSync(`${zipPath}.sha256`, `${zipHash}  DAFTAR_PHASE_1_RC.zip\n`);
rmSync(staging, { recursive: true, force: true });

console.log(`EXPORT: PASS — release/DAFTAR_PHASE_1_RC.zip (${inventory.length} files)`);
console.log(`  treeHash ${manifest.treeHash}`);
console.log(`  zip sha256 ${zipHash} (sibling .sha256 written)`);
