#!/usr/bin/env tsx
/**
 * Release export (Final Enforcement Directive §70–72; Final Release Blocker 3).
 *
 * The release archive must be SELF-CONTAINED: unpacked on a clean machine it
 * supports npm ci, build, tests, database bootstrap, migrations and the
 * release gate without a single file from anywhere else. The inventory is
 * therefore EVERY file the repository tracks (git is the source of truth for
 * "what is source"), minus nothing — and the export FAILS if any tracked file
 * is forbidden release content (debris, secrets, dumps, nested archives) or if
 * a file the reproduction commands need is not tracked.
 *
 * Output: release/DAFTAR_PHASE_1_RC.zip (tree under DAFTAR/ with
 * DELIVERY_MANIFEST.json: tree hash, inventory, migration hashes, source
 * commit) and a SIBLING .sha256 (never inside the zip — no circular hash).
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const ROOT = join(__dirname, '..');
const sha = (buf: Buffer | string) => createHash('sha256').update(buf).digest('hex');

const FORBIDDEN_NAME =
  /(^|\/)(node_modules|dist|\.next|var|coverage|\.gradle|build)(\/|$)|(^|\/)\.env($|\.)|\.log$|\.tsbuildinfo$|\.zip$|\.pem$|\.key$|\.dump$|\.sql\.gz$|dev-mailbox|local\.properties$/i;
const FORBIDDEN_CONTENT = /DEV_TEST_KEY(?!\w)|argon2id\$[A-Za-z0-9+/=]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/;
/** Files with a documented reason to mention the dev-only key constant or scan patterns. */
const CONTENT_SCAN_EXEMPT = /static-guards|export-release|phase1-release-gate|credential-protector\.ts$|\.test\.|^docs\//;

/** Every input the reproduction commands read. Derived from package.json scripts, CI and the build configs — kept explicit so a mis-tracked file fails loudly. */
function requiredFiles(): string[] {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string>; workspaces: string[] };
  const fromScripts = Object.values(pkg.scripts)
    .flatMap((s) => [...s.matchAll(/(scripts\/[A-Za-z0-9_.-]+\.(?:ts|mjs))/g)].map((m) => m[1] as string))
    .filter((f, i, a) => a.indexOf(f) === i);
  const workspaceFiles = pkg.workspaces.flatMap((ws) => {
    const wpkg = JSON.parse(readFileSync(join(ROOT, ws, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    const configs = Object.values(wpkg.scripts ?? {}).flatMap((s) => [...s.matchAll(/-p\s+([A-Za-z0-9_.-]+\.json)/g)].map((m) => `${ws}/${m[1]}`));
    return [`${ws}/package.json`, `${ws}/tsconfig.json`, ...configs];
  });
  const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const fromCi = [...ci.matchAll(/(infrastructure\/[A-Za-z0-9_./-]+|scripts\/[A-Za-z0-9_.-]+\.ts)/g)].map((m) => m[1] as string);
  return [
    'package.json',
    'package-lock.json',
    'tsconfig.base.json',
    'tsconfig.json',
    'vitest.config.ts',
    'eslint.config.mjs',
    '.prettierrc.json',
    '.prettierignore',
    '.nvmrc',
    '.node-version',
    '.gitignore',
    '.github/workflows/ci.yml',
    'TECHNICAL_DEBT.md',
    'infrastructure/database/bootstrap.sql',
    'infrastructure/database/MIGRATION_MANIFEST.json',
    'apps/web/next.config.mjs',
    'apps/admin/next.config.mjs',
    'apps/android/settings.gradle.kts',
    'apps/android/build.gradle.kts',
    'apps/android/gradle.properties',
    'apps/android/app/build.gradle.kts',
    'apps/android/app/proguard-rules.pro',
    'apps/android/app/src/main/AndroidManifest.xml',
    'apps/android/app/src/debug/res/xml/network_security_config.xml',
    'tests/helpers/test-app.ts',
    'tests/helpers/global-setup.ts',
    'tests/helpers/setup.ts',
    ...fromScripts,
    ...workspaceFiles,
    ...fromCi,
  ].filter((f, i, a) => a.indexOf(f) === i);
}

const git = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (git.status !== 0) {
  console.error('  FAIL export must run from the git repository (git ls-files is the source inventory)');
  process.exit(1);
}
const tracked = git.stdout.split('\0').filter((f) => f.length > 0 && existsSync(join(ROOT, f)));
const sourceCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
if (dirty.length > 0) {
  console.error(`  FAIL working tree has uncommitted changes — the export must describe exactly one commit:\n${dirty}`);
  process.exit(1);
}

console.log('EXPORT — auditing required reproduction inputs');
const missing = requiredFiles().filter((f) => !tracked.includes(f));
if (missing.length > 0) {
  console.error(`  FAIL required source files are not tracked (the archive would not be self-contained):\n  ${missing.join('\n  ')}`);
  process.exit(1);
}
console.log(`  ok ${requiredFiles().length} required inputs tracked`);

console.log('EXPORT — hygiene of the tracked inventory');
for (const rel of tracked) {
  if (FORBIDDEN_NAME.test(rel)) {
    console.error(`  FAIL forbidden file is tracked: ${rel}`);
    process.exit(1);
  }
}

const staging = mkdtempSync(join(tmpdir(), 'daftar-export-'));
const tree = join(staging, 'DAFTAR');
mkdirSync(tree, { recursive: true });

console.log('EXPORT — copying + hashing inventory');
const inventory: { path: string; sha256: string; bytes: number }[] = [];
for (const rel of tracked) {
  const src = join(ROOT, rel);
  const dst = join(tree, rel);
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst);
  const buf = readFileSync(src);
  inventory.push({ path: rel, sha256: sha(buf), bytes: buf.byteLength });
  if (/\.(ts|tsx|sql|kt|kts|json|mjs|yml|yaml|xml|properties)$/.test(rel) && FORBIDDEN_CONTENT.test(buf.toString('utf8')) && !CONTENT_SCAN_EXEMPT.test(rel)) {
    console.error(`  FAIL raw credential material in export: ${rel}`);
    process.exit(1);
  }
}

const migrationsDir = join(ROOT, 'infrastructure/database/migrations');
const migrationHashes = tracked
  .filter((f) => f.startsWith('infrastructure/database/migrations/') && f.endsWith('.sql'))
  .sort()
  .map((f) => ({ name: f.slice('infrastructure/database/migrations/'.length), sha256: sha(readFileSync(join(ROOT, f))) }));
const manifestOnDisk = JSON.parse(readFileSync(join(ROOT, 'infrastructure/database/MIGRATION_MANIFEST.json'), 'utf8')) as { frozenThrough: string };
const unmanifested = migrationHashes.filter((m) => m.name > manifestOnDisk.frozenThrough);
if (unmanifested.length > 0) {
  console.error(`  FAIL migrations newer than the frozen manifest: ${unmanifested.map((m) => m.name).join(', ')} — freeze them before exporting`);
  process.exit(1);
}
void migrationsDir;

const manifest = {
  product: 'DAFTAR',
  phase: 1,
  kind: 'release-candidate',
  generatedAt: new Date().toISOString(),
  sourceCommit,
  treeHash: sha(inventory.map((i) => `${i.path}:${i.sha256}`).join('\n')),
  fileCount: inventory.length,
  inventory,
  migrationHashes,
  migrationManifestSha256: sha(readFileSync(join(ROOT, 'infrastructure/database/MIGRATION_MANIFEST.json'))),
  toolchain: { node: '24.12.x', npm: '>=11', gradle: '8.14.x', androidSdk: 'platform 35 / build-tools 35.0.0' },
  reproduction: [
    'npm ci',
    'npm run gate:phase1:release -- --evidence=release/evidence.json',
    'npm run perf:baseline',
    'PROVISIONING_ASSERTION_KEY=<base64 ≥32B> BOOTSTRAP_DATABASE_URL=<daftar_platform url> npm run bootstrap:provisioning-key',
  ],
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

console.log(`EXPORT: PASS — release/DAFTAR_PHASE_1_RC.zip (${inventory.length} files, commit ${sourceCommit.slice(0, 7)})`);
console.log(`  treeHash ${manifest.treeHash}`);
console.log(`  zip sha256 ${zipHash} (sibling .sha256 written)`);
