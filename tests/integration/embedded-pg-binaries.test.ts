import { chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { embeddedPgNativeDir, ensureEmbeddedPgBinariesExecutable } from '../../scripts/ensure-embedded-pg-binaries';

/**
 * Final Release Blocker 3 — FIRST RUN ON A CLEAN MACHINE.
 *
 * `embedded-postgres` chmods its binaries without awaiting the promise and
 * spawns `initdb` immediately, so a freshly installed `node_modules` loses the
 * race and the first run dies with EACCES. Our helper removes the race — but
 * only if it actually FINDS the binaries. The platform package's `exports` map
 * forbids resolving its `package.json`, which silently defeated the first
 * implementation; these tests fail if the helper ever degrades to a no-op.
 */
describe('embedded PostgreSQL binaries are prepared before the server starts (Blocker 3)', () => {
  it('locates the platform package (the exports map does not hide it)', () => {
    const dir = embeddedPgNativeDir();
    expect(dir, 'native directory of @embedded-postgres/<platform>-<arch>').not.toBeNull();
    expect(statSync(join(dir as string, 'bin', 'initdb')).isFile()).toBe(true);
  });

  it('restores the executable bit a fresh install is missing (idempotent, never a silent no-op)', () => {
    const initdb = join(embeddedPgNativeDir() as string, 'bin', 'initdb');
    const original = statSync(initdb).mode;
    // Reproduce the state npm leaves behind on a clean machine.
    chmodSync(initdb, original & ~0o111);
    expect(statSync(initdb).mode & 0o111).toBe(0);
    ensureEmbeddedPgBinariesExecutable();
    expect(statSync(initdb).mode & 0o111).toBe(0o111);
    // Running again changes nothing and still succeeds.
    ensureEmbeddedPgBinariesExecutable();
    expect(statSync(initdb).mode & 0o111).toBe(0o111);
    chmodSync(initdb, original);
  });
});
