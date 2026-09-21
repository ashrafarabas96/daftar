import { createRequire } from 'node:module';
import { chmodSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
 * starts an embedded server (test harness, db-from-zero contract). It is a
 * no-op when the bits are already correct, and it never throws on a
 * read-only file system — the library's own check then applies.
 */
const EXEC_BITS = 0o111;

export function ensureEmbeddedPgBinariesExecutable(): void {
  const require = createRequire(__filename);
  const pkg = `@embedded-postgres/${process.platform}-${process.arch}`;
  let nativeDir: string;
  try {
    nativeDir = join(dirname(require.resolve(`${pkg}/package.json`)), 'native');
  } catch {
    return; // platform package not installed (another OS/arch) — nothing to fix
  }
  for (const sub of ['bin', 'lib']) {
    const dir = join(nativeDir, sub);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = join(dir, entry);
      try {
        const st = statSync(file);
        if (!st.isFile() || (st.mode & EXEC_BITS) === EXEC_BITS) continue;
        chmodSync(file, st.mode | EXEC_BITS);
      } catch {
        // read-only or unreadable file: leave it to the library's own check
      }
    }
  }
}
