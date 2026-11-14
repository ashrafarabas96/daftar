/**
 * A throw-away repository root for driving the repository's own guard SCRIPTS
 * against planted input. `scripts/static-guards.ts` and
 * `scripts/check-localization.ts` run at import time and derive their root
 * from `__dirname`, so they cannot be called with an in-memory string; copying
 * `scripts/` next to a copy of the tree they read makes the REAL script text
 * run over a tree the test controls, without editing the scripts.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { REPO_ROOT } from './refusal-codes';

const req = createRequire(join(REPO_ROOT, 'package.json'));
export const TSX_CLI: string = req.resolve('tsx/cli');
export const VITEST_MJS: string = join(dirname(req.resolve('vitest/package.json')), 'vitest.mjs');

const SKIP = /[\\/](node_modules|\.next|\.git|dist|build)([\\/]|$)/;
const COPIES = ['scripts', 'infrastructure/database', 'apps/api/src', 'apps/admin/src', 'apps/web/src', 'packages'];

export interface Sandbox {
  readonly root: string;
  /** Write (or overwrite) a file under the sandbox. */
  put(rel: string, content: string): void;
  /** Put a sandbox file back to the real tree's bytes, or delete it if the real tree has none. */
  restore(rel: string): void;
  run(script: string): { status: number | null; out: string };
  dispose(): void;
}

export function createSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'daftar-guard-'));
  for (const rel of COPIES) {
    mkdirSync(join(root, rel), { recursive: true });
    cpSync(join(REPO_ROOT, rel), join(root, rel), { recursive: true, filter: (s) => !SKIP.test(s) });
  }
  return {
    root,
    put(rel, content) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    },
    restore(rel) {
      const real = join(REPO_ROOT, rel);
      if (existsSync(real)) writeFileSync(join(root, rel), readFileSync(real));
      else rmSync(join(root, rel), { force: true });
    },
    run(script) {
      const r = spawnSync(process.execPath, [TSX_CLI, join(root, 'scripts', script)], { cwd: root, encoding: 'utf8' });
      return { status: r.status, out: `${r.stdout}${r.stderr}`.split('\\').join('/') };
    },
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
