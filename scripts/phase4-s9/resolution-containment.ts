#!/usr/bin/env tsx
/**
 * PHASE 4 — P4-S9 — IS THE TREE BEING JUDGED THE TREE THAT RESOLVED?
 *
 * THE MEASURED DEFECT THIS EXISTS FOR
 *
 * npm writes workspace links as RELATIVE symlinks:
 *
 *     node_modules/@daftar/inventory -> ../../packages/inventory
 *
 * A git worktree whose whole `node_modules` is a symlink to the main
 * checkout's therefore resolves every `@daftar/*` import to the MAIN
 * CHECKOUT's packages. A typecheck or a test run in that worktree compiles the
 * worktree's own `tests/`, `scripts/` and `apps/` sources — tsconfig includes
 * them by PATH — while every `@daftar/*` import inside them resolves to
 * somebody else's `packages/`. The run is green, and the green is a statement
 * about a tree the author never edited.
 *
 * This happened twice in one day in this container: the P4-S5 owner's green
 * was about the main checkout, and an integrator chasing a `TS2305` after a
 * merge that added package exports was looking at a stale `dist/` rather than
 * a defect in the merged code.
 *
 * `[[daftar-a-check-only-asked-where-it-passes]]` is usually about WHICH
 * QUESTION a check asks. This is the same shape one level down: the right
 * question, asked of the wrong tree. A release gate is the one place that must
 * not be able to make that mistake, because its whole claim is "this commit,
 * this tree, these results".
 *
 * ── WHY IT IS HERE AND NOT ONLY IN A README ──────────────────────────────
 *
 * The hazard is invisible: nothing fails, a number is simply about the wrong
 * thing. The only defence is a check that READS THE RESOLUTION and compares it
 * against the root it was told to judge. So that is what this module does, out
 * of the filesystem, with no trust in how the environment was set up.
 *
 * ── THE SECOND HALF, WHICH IS EASY TO MISS ───────────────────────────────
 *
 * Repointing a workspace link is only half the fix. Each package's
 * `package.json` sets `"main": "dist/index.js"` and `"types":
 * "dist/index.d.ts"`, so a freshly repointed package points at a directory
 * with no `dist/` and EVERY import becomes `TS2307`. A stale `dist/` is worse
 * still: it resolves, and it answers from code that is not the code in the
 * tree. Both are reported, and they are reported DIFFERENTLY, because
 * "nothing is built" and "something old is built" need different actions.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export interface WorkspaceLinkRow {
  /** The scoped package name, e.g. `@daftar/inventory`. */
  readonly specifier: string;
  /** `node_modules/@daftar/<name>` as it appears. */
  readonly linkPath: string;
  /** Where it really leads, fully resolved. `null` when it leads nowhere. */
  readonly resolvedTo: string | null;
  /** Whether `resolvedTo` is inside the root being judged. */
  readonly insideRoot: boolean;
  /** The `main`/`types` entry points the package declares. */
  readonly entryPoints: readonly string[];
  /** Entry points that do not exist on disk — every import of this package is then TS2307. */
  readonly missingEntryPoints: readonly string[];
  /**
   * The newest source mtime and the build-output mtime, when both exist. A
   * build older than its source RESOLVES, and answers from code that is not
   * the code in the tree, which is the harder of the two failures to see.
   */
  readonly buildOlderThanSource: boolean | null;
}

/** True when `candidate` is `root` itself or lies beneath it. Compared on real paths, so a symlink cannot smuggle a path in. */
export function isInside(root: string, candidate: string): boolean {
  const realRoot = existsSync(root) ? realpathSync(root) : resolve(root);
  const rel = relative(realRoot, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..');
}

function newestMtime(dir: string, depth = 0): number {
  if (depth > 4 || !existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const child = join(dir, entry);
    let st;
    try {
      st = statSync(child);
    } catch {
      continue;
    }
    if (st.isDirectory()) newest = Math.max(newest, newestMtime(child, depth + 1));
    else if (/\.tsx?$/.test(entry)) newest = Math.max(newest, st.mtimeMs);
  }
  return newest;
}

/** Every `@daftar/*` workspace link under `root`, with where it really leads. */
export function workspaceLinks(root: string): WorkspaceLinkRow[] {
  const scopeDir = join(root, 'node_modules', '@daftar');
  if (!existsSync(scopeDir)) return [];
  const rows: WorkspaceLinkRow[] = [];
  for (const name of readdirSync(scopeDir).sort()) {
    const linkPath = join(scopeDir, name);
    let resolvedTo: string | null = null;
    try {
      resolvedTo = realpathSync(linkPath);
    } catch {
      resolvedTo = null;
    }
    const entryPoints: string[] = [];
    const missing: string[] = [];
    let buildOlderThanSource: boolean | null = null;
    if (resolvedTo !== null && existsSync(join(resolvedTo, 'package.json'))) {
      const pkg = JSON.parse(readFileSync(join(resolvedTo, 'package.json'), 'utf8')) as { main?: string; types?: string };
      for (const entry of [pkg.main, pkg.types]) {
        if (entry === undefined) continue;
        entryPoints.push(entry);
        if (!existsSync(join(resolvedTo, entry))) missing.push(entry);
      }
      const built = entryPoints.map((e) => join(resolvedTo as string, e)).filter((p) => existsSync(p));
      if (built.length > 0) {
        const sourceAt = newestMtime(join(resolvedTo, 'src'));
        const builtAt = Math.min(...built.map((p) => statSync(p).mtimeMs));
        if (sourceAt > 0) buildOlderThanSource = builtAt < sourceAt;
      }
    }
    rows.push({
      specifier: `@daftar/${name}`,
      linkPath: join('node_modules', '@daftar', name),
      resolvedTo,
      insideRoot: resolvedTo !== null && isInside(root, resolvedTo),
      entryPoints,
      missingEntryPoints: missing,
      buildOlderThanSource,
    });
  }
  return rows;
}

/**
 * THE FINDING.
 *
 * Note which way the empty case falls. NO workspace link is NOT a pass: it
 * means nothing was installed, so no `@daftar/*` import resolves at all and
 * any run over this root is about a tree that cannot compile. The caller that
 * must distinguish "not installed yet" from "installed and wrong" is the S9
 * registry, which declares `node_modules/@daftar` as a SUBJECT — so in an
 * extracted archive before `npm ci` the check reports
 * WAITING_FOR_INTEGRATED_SURFACE and never a PASS.
 */
export function resolutionContainmentProblems(root: string): string[] {
  const problems: string[] = [];

  // The whole directory being a symlink is the exact shape that caused this:
  // one link, and every package in it belongs to another tree.
  const nodeModules = join(root, 'node_modules');
  if (existsSync(nodeModules) && lstatSync(nodeModules).isSymbolicLink()) {
    const leadsTo = realpathSync(nodeModules);
    if (!isInside(root, leadsTo))
      problems.push(
        `node_modules is a SYMLINK to ${leadsTo}, outside the root being judged — every @daftar/* import therefore resolves to that tree's packages, ` +
          'so a green run here is a statement about a tree nobody edited',
      );
  }

  const rows = workspaceLinks(root);
  if (rows.length === 0)
    problems.push('no @daftar/* workspace link exists under this root, so no workspace import resolves at all — an unresolvable tree is not a judged tree');

  for (const row of rows) {
    if (row.resolvedTo === null) {
      problems.push(`${row.specifier}: ${row.linkPath} leads nowhere, so every import of it is TS2307`);
      continue;
    }
    if (!row.insideRoot)
      problems.push(
        `${row.specifier}: ${row.linkPath} resolves to ${row.resolvedTo}, which is OUTSIDE this root — ` +
          "the sources being compiled are this tree's and the package being imported is another tree's, so the verdict is about neither",
      );
    for (const entry of row.missingEntryPoints)
      problems.push(
        `${row.specifier}: declares ${entry} and it does not exist — a repointed workspace package with no build output turns every import of it into TS2307, which reads as a defect in the importing code`,
      );
    if (row.buildOlderThanSource === true)
      problems.push(
        `${row.specifier}: its build output is OLDER than its sources — this one RESOLVES, and answers from code that is not the code in the tree ` +
          '(a stale dist reported TS2305 after a merge that added exports, and it read as a defect in the merged code)',
      );
  }
  return problems;
}

/** A one-line description for the evidence, so the resolution is recorded beside the verdict rather than assumed. */
export function describeResolution(root: string): string {
  const rows = workspaceLinks(root);
  const outside = rows.filter((r) => !r.insideRoot);
  const unbuilt = rows.filter((r) => r.missingEntryPoints.length > 0);
  const stale = rows.filter((r) => r.buildOlderThanSource === true);
  return `${rows.length.toString()} @daftar/* link(s): ${outside.length.toString()} resolving outside this root, ${unbuilt.length.toString()} with a missing entry point, ${stale.length.toString()} with a stale build`;
}
