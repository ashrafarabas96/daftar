import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE REPOSITORY'S OWN FORMAT GATE, RUN OVER THIS PACKAGE'S FILES.
 *
 * ROUND 21, AND THIS IS THE SECOND TIME THE SAME CLASS HAS BITTEN THIS PHASE
 * FAMILY. The root gate is `npm run format` = `prettier --check .` with the
 * repository's pinned prettier. At `421e425` it returned **rc 1 on thirteen
 * files, every one of them this package's and every one of them new in this
 * branch**, while the same gate at the branch's merge-base returned rc 0. So
 * the red was entirely ours, and no round of this phase had noticed, because:
 *
 *   * `packages/billing` is NOT in the root `workspaces` list
 *     (`PATCH-REQ-P5-001`), so no root script reaches it by workspace; and
 *   * this package's own `lint` is `eslint src test`, which is a different
 *     tool with a different job.
 *
 * Every evidence line that said "typecheck rc 0 / lint rc 0" was therefore
 * TRUE and was not the repo gate — which is exactly the thing P4's round 20
 * was rejected for, reported in this pack as a lesson, and then repeated here
 * by me. A gate that is not run is not a gate, and a narrower gate reported
 * under a wider name is worse than no gate.
 *
 * This case closes the hole from inside the package: it runs the REPOSITORY's
 * prettier, with the REPOSITORY's config and ignore file, over this package's
 * tree, so the package's own lane reds whenever the root gate would red for
 * our files. It cannot replace running `npm run format` at the root — that
 * also covers everyone else's files — and the evidence ledger still records
 * the root run.
 *
 * It FAILS rather than skips when the binary or the config is missing: a
 * format check that quietly passes because it could not run is the
 * fail-open this phase keeps finding in other people's tools.
 */
// `process.cwd()` rather than `import.meta.url`, which this package's
// `module` setting does not allow. The directory is then VERIFIED to be this
// package, so a run from somewhere else fails instead of checking a tree
// nobody meant.
const pkg = process.cwd();
const root = resolve(pkg, '..', '..');
const prettier = join(root, 'node_modules', '.bin', 'prettier');
const config = join(root, '.prettierrc.json');
const ignore = join(root, '.prettierignore');

describe("the repository's own format gate, over this package", () => {
  it('has the pinned prettier, its config and its ignore file available, or fails loudly', () => {
    const manifest = join(pkg, 'package.json');
    expect(existsSync(manifest), `${manifest} is missing, so the working directory is not this package`).toBe(true);
    expect(JSON.parse(readFileSync(manifest, 'utf8')).name, 'the working directory is not @daftar/billing').toBe('@daftar/billing');
    for (const path of [prettier, config, ignore]) {
      expect(existsSync(path), `${path} is missing, so this check could not run and must not pass`).toBe(true);
    }
  });

  it('reports every file of this package as already formatted', () => {
    let out = '';
    let code = 0;
    try {
      out = execFileSync(prettier, ['--check', '--config', config, '--ignore-path', ignore, '.'], {
        cwd: pkg,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      code = err.status ?? 1;
      out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    }
    // The gate's own words, so a reader of a failing run sees the file list
    // rather than a bare exit code.
    expect({ code, out: out.trim() }, "the repository's format gate would be RED for this package").toStrictEqual({
      code: 0,
      out: expect.stringContaining('use Prettier code style'),
    });
  });
});
