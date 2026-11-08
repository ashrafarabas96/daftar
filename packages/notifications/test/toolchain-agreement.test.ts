/**
 * F-7 — the package declares devDependencies that nothing installs.
 *
 * There is no `packages/notifications/package-lock.json` and the package is not
 * a root workspace member — which is exactly what makes PREPARED / NOT PROMOTED
 * mechanical, and is not going to change before promotion. So `npm ci` inside
 * the package fails, and the gates pass because `vitest` and `typescript`
 * resolve UPWARD into the root `node_modules`.
 *
 * The versions agree today. The challenger's point is that the agreement is a
 * coincidence of two independent pins: bump the root and this package's
 * declared versions quietly stop being the ones that run, with nothing red and
 * every gate still green. That is a false green — the evidence would be
 * produced by a toolchain the manifest does not name.
 *
 * The honest fix is not a second lockfile (it would need the workspace
 * membership this phase must not have). It is to make the divergence LOUD: this
 * law reads both manifests and the version actually executing, and reds on any
 * disagreement. The evidence then names a toolchain that provably ran it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// `__dirname` and `require`, matching `part42-source-laws.test.ts`: this
// package compiles as commonjs, so `import.meta` is not available here.
function manifest(path: string): { devDependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(path, 'utf8')) as { devDependencies?: Record<string, string> };
}

const own = manifest(join(__dirname, '..', 'package.json'));
const root = manifest(join(__dirname, '..', '..', '..', 'package.json'));

describe('F-7 — the toolchain that runs the gates is the toolchain the package declares', () => {
  it('this package declares at least the two tools its gates need', () => {
    // Non-empty subject set: a law over an empty list passes vacuously.
    expect(Object.keys(own.devDependencies ?? {})).toEqual(expect.arrayContaining(['typescript', 'vitest']));
  });

  it.each(['typescript', 'vitest'])('%s is pinned identically here and at the root that actually installs it', (tool) => {
    const mine = own.devDependencies?.[tool];
    const theirs = root.devDependencies?.[tool];
    expect(mine, `${tool} must be declared by this package`).toBeDefined();
    expect(theirs, `${tool} must be declared by the root, which is what installs it`).toBeDefined();
    // Exact pins on both sides, so this is a string comparison and not a range
    // question. A root bump now reds here instead of silently changing the
    // toolchain under the evidence.
    expect(theirs).toBe(mine);
  });

  it.each(['typescript', 'vitest'])('the INSTALLED %s is the declared version, not merely a compatible one', (tool) => {
    // Read from disk by path rather than with `require()`, which the lint
    // forbids and which would also resolve a hoisted copy without saying where
    // it came from. This asserts the version in the one `node_modules` that
    // these gates actually resolve into: the root's.
    const installed = manifest(join(__dirname, '..', '..', '..', 'node_modules', tool, 'package.json')) as unknown as { version: string };
    expect(installed.version).toBe(own.devDependencies?.[tool]);
  });

  it('the running Node satisfies the engines range the evidence is measured under', () => {
    // The container ships v22, which is OUTSIDE the repo's range, so a gate run
    // on the default `node` would be evidence from an unsupported runtime. This
    // asserts the runtime rather than trusting a line in the manifest.
    const [major] = process.versions.node.split('.').map(Number);
    expect(major, `engines requires >=24 <25; this run is on ${process.versions.node}`).toBe(24);
  });
});
