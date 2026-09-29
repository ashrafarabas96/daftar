/**
 * The release export's own refusals, run for real (Phase 3 corrective, TD-19
 * follow-up):
 *
 * - its raw-credential content scan covers every JavaScript/TypeScript source
 *   spelling a release can execute — `.mts` (the web and admin production
 *   entries), `.cts`, `.mjs`, `.cjs`, `.js`, `.jsx` — not only `.ts`/`.tsx`;
 * - it reads EVERY tracked file that is not binary (review L-4): scripts,
 *   templates, config of any spelling, `.github/**`, `tests/**`, `docs/**`
 *   and the root files, with no extension list and no test or docs
 *   exemption. Only the dev/test key's constant NAME is allowed, and only in
 *   the exact files that define, guard or document it (scripts/secret-scan.ts);
 *   raw key material is refused everywhere;
 * - both apps' production entries, `apps/web/server.mts` and
 *   `apps/admin/server.mts`, are required inputs: an export without them is
 *   refused as not self-contained, because `npm start` in either app runs them.
 *
 * Each case runs the REAL `scripts/export-release.ts` in a throw-away
 * repository holding the delivered tree with exactly one planted defect, and
 * reads the export's own verdict. Its `node_modules` is a symlink to this
 * tree's; nothing is written here.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { deliveredFiles } from '../helpers/delivered-files';

const REPO = join(__dirname, '../..');
const temporaries: string[] = [];
afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

/**
 * A throw-away repository holding the delivered tree with `plant` applied and
 * committed, so the export sees a clean checkout of exactly that tree.
 */
function repositoryWith(plant: (root: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), 'daftar-export-scan-'));
  temporaries.push(root);
  // The delivered inventory: DELIVERY_MANIFEST.json in an extracted archive,
  // `git ls-files` in a checkout (tests/helpers/delivered-files.ts). Built
  // into a repository of its own, so this runs the same from either.
  for (const rel of deliveredFiles(REPO)) {
    if (rel === 'DELIVERY_MANIFEST.json' || !existsSync(join(REPO, rel))) continue;
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    copyFileSync(join(REPO, rel), join(root, rel));
  }
  const commit = (message: string): string[][] => [
    ['add', '-A'],
    ['-c', 'user.email=export-scan@test.daftar.local', '-c', 'user.name=export scan test', 'commit', '--quiet', '--allow-empty', '-m', message],
  ];
  const steps = (phase: 'tree' | 'plant'): string[][] => (phase === 'tree' ? [['init', '--quiet'], ...commit('delivered tree')] : commit('plant'));
  for (const phase of ['tree', 'plant'] as const) {
    if (phase === 'plant') plant(root);
    for (const args of steps(phase)) {
      const res = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
    }
  }
  symlinkSync(join(REPO, 'node_modules'), join(root, 'node_modules'), 'dir');
  // A symlink is not the directory `.gitignore` names: keep the checkout clean.
  appendFileSync(join(root, '.git/info/exclude'), '/node_modules\n');
  return root;
}

function exportIn(root: string): { status: number | null; output: string } {
  const res = spawnSync('npx', ['tsx', 'scripts/export-release.ts', '--phase=3'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0' },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: res.status, output: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

// Assembled so that this file itself never carries the patterns it plants.
const PRIVATE_KEY = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ');
const DEV_KEY_NAME = ['DEV', 'TEST', 'KEY'].join('_');

describe('the release export refuses what it must', () => {
  it('control: an unplanted clone passes the required-input and content checks', () => {
    const run = exportIn(repositoryWith(() => undefined));
    expect(run.output).toMatch(/ok \d+ required inputs tracked/);
    expect(run.output).not.toMatch(/raw credential material in export/);
  }, 180_000);

  it.each(['apps/web/planted.mts', 'scripts/planted.cts', 'scripts/planted.mjs', 'scripts/planted.cjs', 'apps/web/planted.js', 'apps/web/planted.jsx'])(
    'a private key planted in %s stops the export',
    (rel) => {
      const run = exportIn(
        repositoryWith((root) => {
          writeFileSync(join(root, rel), `export const planted = \`${PRIVATE_KEY}\nMIIB\`;\n`);
        }),
      );
      expect(run.status, run.output).toBe(1);
      expect(run.output).toContain(`FAIL raw credential material in export: ${rel}`);
    },
    180_000,
  );

  it.each([
    'infrastructure/database/procedures/planted.sql.template',
    'scripts/planted.sh',
    'planted.toml',
    '.github/workflows/planted.yml',
    'tests/fixtures/planted.test.ts',
    'docs/planted.md',
    'apps/android/planted.pro',
    'apps/web/public/planted.txt',
  ])(
    'a private key planted in %s stops the export, whatever its spelling or place',
    (rel) => {
      const run = exportIn(
        repositoryWith((root) => {
          mkdirSync(dirname(join(root, rel)), { recursive: true });
          writeFileSync(join(root, rel), `planted\n${PRIVATE_KEY}\nMIIB\n`);
        }),
      );
      expect(run.status, run.output).toBe(1);
      expect(run.output).toContain(`FAIL raw credential material in export: ${rel}`);
    },
    180_000,
  );

  it('the dev/test key name in a test file is refused: the allowance names exact files, not every test', () => {
    const rel = 'tests/integration/planted.test.ts';
    const run = exportIn(
      repositoryWith((root) => {
        writeFileSync(join(root, rel), `export const planted = '${DEV_KEY_NAME}';\n`);
      }),
    );
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain(`FAIL raw credential material in export: ${rel}`);
  }, 180_000);

  it('a file allowed to name the dev/test key is still refused raw key material', () => {
    const rel = 'apps/api/src/modules/delivery/credential-protector.ts';
    const run = exportIn(
      repositoryWith((root) => {
        appendFileSync(join(root, rel), `// ${PRIVATE_KEY}\n`);
      }),
    );
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain(`FAIL raw credential material in export: ${rel}`);
  }, 180_000);

  it('control: a binary file is not read as text', () => {
    const run = exportIn(
      repositoryWith((root) => {
        writeFileSync(join(root, 'apps/web/planted.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x2d, 0x2d, 0x0a]));
      }),
    );
    expect(run.output).toMatch(/ok \d+ required inputs tracked/);
    expect(run.output).not.toMatch(/raw credential material in export/);
  }, 180_000);

  it.each(['apps/web/server.mts', 'apps/admin/server.mts'])(
    'an export without %s is refused as not self-contained',
    (rel) => {
      const run = exportIn(
        repositoryWith((root) => {
          rmSync(join(root, rel));
        }),
      );
      expect(run.status, run.output).toBe(1);
      expect(run.output).toContain('FAIL required source files are not tracked');
      expect(run.output).toContain(rel);
    },
    180_000,
  );
});
