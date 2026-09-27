/**
 * T-06 — THE RUNNER CANARY RUNS FOR REAL (docs/PHASE_3_S9_CONTRACT.md A-05,
 * finding F-1, §7 T-06).
 *
 * `gate:phase2:release` has always started its "canary first" step as
 * `npx tsx scripts/runner-canary.ts`, and until P3-S9 that module only
 * exported a decision: the step ran no test and passed. Executed directly it
 * now runs the root and web runners over their deliberately failing fixtures
 * in real `vitest` children. This file proves:
 *
 *   - it exits 0 on the real tree and reports both runners;
 *   - on a copy where either failing fixture is replaced by its passing twin
 *     it exits 1 with "did not run its failing test", naming that runner;
 *   - importing the module runs nothing (the P2-S8 gate and its tamper suite
 *     import `canaryRefusal` from it).
 *
 * The copy is hard-linked from the delivered files, with `node_modules`
 * symlinked in; a replaced file is unlinked before it is written, so nothing
 * reaches back into this tree.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { deliveredFiles } from '../helpers/delivered-files';

const REPO = join(__dirname, '../..');
const ROOT_FAILING = 'tests/fixtures/runner-exit-code/failing.fixture.ts';
const ROOT_PASSING = 'tests/fixtures/runner-exit-code/passing.fixture.ts';
const WEB_FAILING = 'apps/web/test/fixtures/runner-exit-code/failing.fixture.tsx';
const WEB_PASSING = 'apps/web/test/fixtures/runner-exit-code/passing.fixture.tsx';

const temporaries: string[] = [];
afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

/** A hard-linked copy of the delivered tree with the installed dependencies symlinked in. */
function copyOfTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'daftar-canary-'));
  temporaries.push(root);
  for (const rel of deliveredFiles(REPO)) {
    const source = join(REPO, rel);
    if (!existsSync(source)) continue;
    const target = join(root, rel);
    mkdirSync(dirname(target), { recursive: true });
    linkSync(source, target);
  }
  for (const modules of ['node_modules', 'apps/web/node_modules']) {
    if (existsSync(join(REPO, modules))) symlinkSync(join(REPO, modules), join(root, modules), 'dir');
  }
  return root;
}

/** Replace a file in the copy; the unlink is what protects the original. */
function rewrite(root: string, rel: string, contents: string): void {
  rmSync(join(root, rel), { force: true });
  writeFileSync(join(root, rel), contents);
}

function canary(root: string): { status: number | null; output: string } {
  const res = spawnSync('npx', ['tsx', 'scripts/runner-canary.ts'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0' },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: res.status, output: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

describe('the runner canary, executed', () => {
  it('exits 0 on the real tree and reports both runners', () => {
    const run = canary(REPO);
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain('PASS the root runner reports failure');
    expect(run.output).toContain('PASS the web runner reports failure');
    expect(run.output).toContain('PASS runner canary: 2 runners can report failure');
  });

  it('exits 1, naming the root runner, when the root failing fixture is its passing twin', () => {
    const root = copyOfTree();
    rewrite(root, ROOT_FAILING, readFileSync(join(REPO, ROOT_PASSING), 'utf8'));
    const run = canary(root);
    expect(run.status, run.output).toBe(1);
    expect(run.output).toMatch(/the root runner \(tests\/fixtures\/runner-exit-code\/vitest\.config\.ts\): the exit-code canary did not run its failing test/);
    expect(run.output).toContain('PASS the web runner reports failure');
    expect(readFileSync(join(REPO, ROOT_FAILING), 'utf8')).toContain('expect(1).toBe(2)');
  });

  it('exits 1, naming the web runner, when the web failing fixture is its passing twin', () => {
    const root = copyOfTree();
    rewrite(root, WEB_FAILING, readFileSync(join(REPO, WEB_PASSING), 'utf8'));
    const run = canary(root);
    expect(run.status, run.output).toBe(1);
    expect(run.output).toMatch(
      /the web runner \(apps\/web\/test\/fixtures\/runner-exit-code\/vitest\.config\.mts\): the exit-code canary did not run its failing test/,
    );
    expect(run.output).toContain('PASS the root runner reports failure');
    expect(readFileSync(join(REPO, WEB_FAILING), 'utf8')).toContain('toBe(\'<bdi dir="ltr">2</bdi>\')');
  });
});

describe('importing the module runs nothing', () => {
  it('a process that only imports it prints nothing of the canary and spawns no runner', () => {
    const res = spawnSync(
      join(REPO, 'node_modules/.bin/tsx'),
      ['-e', `const m = require(${JSON.stringify(join(REPO, 'scripts/runner-canary.ts'))}); console.log('imported', Object.keys(m).join(','));`],
      { cwd: REPO, encoding: 'utf8' },
    );
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout.trim()).toBe('imported canaryRefusal');
    expect(res.stderr).toBe('');
  });
});
