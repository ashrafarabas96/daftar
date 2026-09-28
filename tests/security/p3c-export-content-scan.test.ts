/**
 * The release export's own refusals, run for real (Phase 3 corrective, TD-19
 * follow-up):
 *
 * - its raw-credential content scan covers every JavaScript/TypeScript source
 *   spelling a release can execute — `.mts` (the web and admin production
 *   entries), `.cts`, `.mjs`, `.cjs`, `.js`, `.jsx` — not only `.ts`/`.tsx`;
 * - both apps' production entries, `apps/web/server.mts` and
 *   `apps/admin/server.mts`, are required inputs: an export without them is
 *   refused as not self-contained, because `npm start` in either app runs them.
 *
 * Each case runs the REAL `scripts/export-release.ts` (the working tree's
 * copy) in a throw-away clone of the committed tree with exactly one planted
 * defect, and reads the export's own verdict. The clone's `node_modules` is a
 * symlink to this repository's; nothing is written here.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const REPO = join(__dirname, '../..');
const temporaries: string[] = [];
afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout;
}

/** A clone of HEAD carrying the working tree's export script, with `plant` applied and committed. */
function cloneWith(plant: (root: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), 'daftar-export-scan-'));
  temporaries.push(root);
  git(REPO, ['clone', '--quiet', '--no-hardlinks', REPO, root]);
  git(root, ['config', 'user.email', 'export-scan@test.daftar.local']);
  git(root, ['config', 'user.name', 'export scan test']);
  copyFileSync(join(REPO, 'scripts/export-release.ts'), join(root, 'scripts/export-release.ts'));
  plant(root);
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '--allow-empty', '-m', 'plant']);
  symlinkSync(join(REPO, 'node_modules'), join(root, 'node_modules'), 'dir');
  // A symlink is not the directory `.gitignore` names: keep the clone clean.
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

// Assembled so that this file itself never carries the pattern it plants.
const PRIVATE_KEY = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ');

describe('the release export refuses what it must', () => {
  it('control: an unplanted clone passes the required-input and content checks', () => {
    const run = exportIn(cloneWith(() => undefined));
    expect(run.output).toMatch(/ok \d+ required inputs tracked/);
    expect(run.output).not.toMatch(/raw credential material in export/);
  }, 180_000);

  it.each(['apps/web/planted.mts', 'scripts/planted.cts', 'scripts/planted.mjs', 'scripts/planted.cjs', 'apps/web/planted.js', 'apps/web/planted.jsx'])(
    'a private key planted in %s stops the export',
    (rel) => {
      const run = exportIn(
        cloneWith((root) => {
          writeFileSync(join(root, rel), `export const planted = \`${PRIVATE_KEY}\nMIIB\`;\n`);
        }),
      );
      expect(run.status, run.output).toBe(1);
      expect(run.output).toContain(`FAIL raw credential material in export: ${rel}`);
    },
    180_000,
  );

  it.each(['apps/web/server.mts', 'apps/admin/server.mts'])(
    'an export without %s is refused as not self-contained',
    (rel) => {
      const run = exportIn(
        cloneWith((root) => {
          git(root, ['rm', '--quiet', rel]);
        }),
      );
      expect(run.status, run.output).toBe(1);
      expect(run.output).toContain('FAIL required source files are not tracked');
      expect(run.output).toContain(rel);
    },
    180_000,
  );
});
