import { createRequire } from 'node:module';
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

/**
 * Make the embedded-PostgreSQL binaries executable BEFORE the server starts
 * (Final Release Blocker 3 — first run on a clean machine).
 *
 * `embedded-postgres` fixes the permissions itself, but it calls its
 * `ensureBinIsExecutable()` helper WITHOUT awaiting it and then spawns
 * `initdb` immediately. On a freshly installed `node_modules` the shipped
 * binaries do not yet carry the executable bit, so the chmod races the spawn
 * and the FIRST run on a clean checkout fails with EACCES; every later run
 * succeeds because the (eventually applied) chmod persists. That made the
 * failure invisible in a long-lived working copy and fatal in the extracted
 * release archive.
 *
 * Doing it synchronously here removes the race for every entry point that
 * starts an embedded server (test harness, db-from-zero contract).
 *
 * The platform package declares `"exports": "./dist/index.js"`, so its
 * `package.json` CANNOT be resolved directly — the directory is located from
 * the `embedded-postgres` entry point instead. When the platform package is
 * present, a failure to prepare it THROWS: a silent no-op is exactly the bug
 * this function exists to prevent.
 */
const EXEC_BITS = 0o111;

/** Absolute path of `@embedded-postgres/<platform>-<arch>/native`, or null when that package is not installed. */
export function embeddedPgNativeDir(): string | null {
  const require = createRequire(__filename);
  const relative = join('@embedded-postgres', `${process.platform}-${process.arch}`, 'native');
  const roots: string[] = [];
  try {
    // .../node_modules/embedded-postgres/dist/index.js → .../node_modules
    let dir = dirname(require.resolve('embedded-postgres'));
    for (let i = 0; i < 6; i += 1) {
      if (dir.endsWith(`${sep}node_modules`)) {
        roots.push(dir);
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // embedded-postgres itself is absent; fall back to the well-known locations
  }
  roots.push(join(process.cwd(), 'node_modules'), join(__dirname, '..', 'node_modules'));
  for (const root of roots) {
    const candidate = join(root, relative);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function ensureEmbeddedPgBinariesExecutable(): void {
  const nativeDir = embeddedPgNativeDir();
  if (nativeDir === null) return; // platform package not installed (another OS/arch) — nothing to prepare
  let prepared = 0;
  for (const sub of ['bin', 'lib']) {
    const dir = join(nativeDir, sub);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const file = join(dir, entry);
      const st = statSync(file);
      if (!st.isFile()) continue;
      if ((st.mode & EXEC_BITS) !== EXEC_BITS) chmodSync(file, st.mode | EXEC_BITS);
      if (sub === 'bin') prepared += 1;
    }
  }
  if (prepared === 0) {
    throw new Error(`embedded PostgreSQL binaries not found under ${nativeDir}/bin — the embedded server cannot start`);
  }
}
