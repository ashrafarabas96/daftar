import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
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

/**
 * The REPOSITORY's prettier, loaded from the repository root the same way the
 * binary above is located there -- not imported by bare specifier, which would
 * resolve by hoisting and could silently become some other copy. This package
 * does not declare prettier, and that is the point: the gate's instrument is
 * the repository's, and if it is not there this file fails rather than checks
 * nothing.
 */
const repoPrettier = createRequire(join(root, 'package.json'))('prettier') as typeof import('prettier');

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
    // ROUND 26. This test spawns the repository's own prettier over every file
    // of the package, which takes about 2.4s alone and longer when twenty-two
    // other files are competing for the container's CPU: in the round-26 full
    // run it exceeded vitest's 5s default and the suite went red while
    // `npm run format` at the same tree was rc 0. A wall-clock budget is not
    // part of what this law asserts, and a timing flake in the ONE test that
    // guards the only repo gate which can see this package is the worst place
    // to have one — it trains a reader to re-run instead of to look. The
    // budget is explicit and generous; the assertion above is untouched, so a
    // genuinely misformatted file still reds it (M98).
  }, 120_000);

  /**
   * THE TWO CONTROLS THE CLAIM ABOVE NEVER HAD. The comment closing the case
   * above says "a genuinely misformatted file still reds it (M98)", and
   * NOTHING IN THIS FILE MEASURED THAT: both cases above are satisfied by a
   * gate that accepts everything, and the first one is satisfied by four files
   * merely existing. A format gate that cannot refuse is the fail-open this
   * file was written to close -- asserted here in prose, never once measured.
   *
   * THE DECLARED LIMIT, and it is why these drive a different entry point. They
   * run the PINNED prettier through its Node API with the REPOSITORY's own
   * config and ignore file, so they answer on every host. They do NOT exercise
   * the CLI spawn above: on Windows that spawn cannot even start (`code 1` with
   * empty output, measured, which is why this file is among the host-condition
   * failures `tools/law-ran.py` names), so its argv wiring stays the runner's
   * to judge and is NOT claimed here. What is claimed is the half that was pure
   * prose -- this prettier, with this config, REFUSES a misformatted file and
   * ACCEPTS the formatted one, and this ignore file does not place the
   * package's own sources out of the gate's scope.
   */
  it('RED: the pinned prettier with this config refuses a misformatted file, and accepts the formatted one', async () => {
    const resolved = await repoPrettier.resolveConfig(join(pkg, 'src', 'invoice.ts'), { config });
    expect(resolved, 'the repository config did not resolve, so the answers below would be prettier defaults rather than this gate').not.toBeNull();
    const options = { ...resolved, filepath: join(pkg, 'src', 'invoice.ts') };
    expect(await repoPrettier.check('const  x=1\n', options), 'a misformatted file is ACCEPTED, so this gate can refuse nothing').toBe(false);
    expect(await repoPrettier.check('const x = 1;\n', options), 'the formatted form is REFUSED, so the answer above is not simply always false').toBe(true);
  }, 30_000);

  it("RED: this ignore file does not put the package's own sources out of scope", async () => {
    for (const relative of ['src/invoice.ts', 'test/law-bytes-are-pinned.test.ts']) {
      const info = await repoPrettier.getFileInfo(join(pkg, relative), { ignorePath: ignore });
      expect(info.ignored, `${relative} is IGNORED, so the gate above checks it not at all`).toBe(false);
      expect(info.inferredParser, `${relative} is given no parser, so the gate above would pass over it`).toBe('typescript');
    }
    // And the probe is SIGHTED: an ignore file that is not being read at all
    // answers `ignored: false` for everything, including the one tree it
    // certainly excludes -- which would make both answers above vacuous.
    const vendored = await repoPrettier.getFileInfo(join(root, 'node_modules', 'prettier', 'index.cjs'), { ignorePath: ignore });
    expect(vendored.ignored, 'node_modules is NOT ignored, so this ignore file is not being read and the answers above are blind').toBe(true);
  }, 30_000);
});
