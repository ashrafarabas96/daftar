#!/usr/bin/env tsx
/**
 * SUPPLY-CHAIN HYGIENE (P2-S8 §47).
 *
 * The accounting core is only as trustworthy as what runs beside it. A
 * financial invariant enforced in `packages/accounting` is worth nothing if a
 * transitive dependency can rewrite `BigInt.prototype.toString` at import
 * time, and no amount of row level security survives a package whose install
 * script reads the environment the deployment credentials live in.
 *
 * This check is DETERMINISTIC and OFFLINE. It asks questions the lockfile can
 * answer by itself, so it gives the same verdict in CI, on a laptop and in a
 * container with no network — which is the only kind of check a gate can rest
 * on. It deliberately does NOT run `npm audit`: an advisory database is a
 * moving target, and a gate whose verdict changes because someone else
 * published something is a gate that cannot be reproduced from a commit.
 * Advisories are a review activity; the rules below are a boundary.
 *
 * WHAT IT ASKS
 *
 *   1. Every resolved package is a registry tarball with an integrity hash.
 *      A `git+ssh://` or `https://some-host/tarball.tgz` dependency is code
 *      that can change under a tag; an entry with no `integrity` is a tarball
 *      nobody is checksumming.
 *   2. Every package that runs an install script is on a reviewed list. This
 *      is the highest-value rule in the file: an install script runs with the
 *      developer's and CI's full environment before any test executes.
 *   3. `package-lock.json` and the workspace manifests agree — the lockfile
 *      is not stale with respect to a dependency somebody added by hand.
 *   4. No dependency is declared with a floating major (`*`, `latest`, `x`),
 *      which would make a build non-reproducible by design.
 *   5. The accounting workspaces stay minimal: `@daftar/accounting` is pure
 *      arithmetic and may not acquire a runtime dependency on a driver, a
 *      framework or a transport.
 *
 * Usage: npm run check:supply-chain
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');

interface LockPackage {
  readonly version?: string;
  readonly resolved?: string;
  readonly integrity?: string;
  readonly link?: boolean;
  readonly hasInstallScript?: boolean;
  readonly dev?: boolean;
}

interface Lockfile {
  readonly lockfileVersion: number;
  readonly packages: Record<string, LockPackage>;
}

/**
 * The names npm resolves to a directory in this repository rather than to a
 * tarball. `workspaceLinks` reads them from the lockfile instead of trusting
 * the `@daftar/` prefix, so a third-party package could not acquire a
 * workspace's exemptions by choosing the scope.
 */
function workspaceLinks(lock: Lockfile): Set<string> {
  const links = new Set<string>();
  for (const [key, pkg] of Object.entries(lock.packages)) {
    if (pkg.link === true) links.add(packageNameOf(key));
  }
  return links;
}

interface Manifest {
  readonly name?: string;
  readonly workspaces?: string[];
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly overrides?: Record<string, string>;
}

/**
 * The packages allowed to run code at install time, each with the reason.
 *
 * A name is added here by a human who read what the script does, never by
 * this script to make itself pass. Every entry is either a prebuilt native
 * binary fetch or a platform-optional package that is not installed here.
 */
const REVIEWED_INSTALL_SCRIPTS: Record<string, string> = {
  argon2: 'native password hashing; the install script fetches or builds the prebuilt binding',
  esbuild: 'the bundler behind tsx and vitest; the install script places its platform binary',
  fsevents: 'macOS-only file watching; optional, and not installed on Linux CI',
  '@embedded-postgres/darwin-arm64': 'the test-only PostgreSQL distribution, one package per platform',
  '@embedded-postgres/darwin-x64': 'the test-only PostgreSQL distribution, one package per platform',
  '@embedded-postgres/linux-arm': 'the test-only PostgreSQL distribution, one package per platform',
  '@embedded-postgres/linux-arm64': 'the test-only PostgreSQL distribution, one package per platform',
  '@embedded-postgres/linux-ia32': 'the test-only PostgreSQL distribution, one package per platform',
  '@embedded-postgres/linux-ppc64': 'the test-only PostgreSQL distribution, one package per platform',
  '@embedded-postgres/linux-x64': 'the test-only PostgreSQL distribution, one package per platform',
  '@embedded-postgres/windows-x64': 'the test-only PostgreSQL distribution, one package per platform',
};

/**
 * `@daftar/accounting` is where the money arithmetic lives, and §16 keeps it
 * pure: no transport, no configuration, no connection. A runtime dependency
 * is how that erodes, one convenience at a time.
 */
const PURE_WORKSPACES = ['packages/accounting', 'packages/domain-core', 'packages/inventory', 'packages/shared-contracts'];

let failures = 0;
const fail = (check: string, detail: string): void => {
  failures += 1;
  console.error(`  FAIL [${check}] ${detail}`);
};
const ok = (detail: string): void => console.log(`  ok      ${detail}`);

const readJson = <T>(path: string): T => JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as T;

/** `node_modules/a/node_modules/@scope/b` → `@scope/b`. */
function packageNameOf(lockKey: string): string {
  const at = lockKey.lastIndexOf('node_modules/');
  return at === -1 ? lockKey : lockKey.slice(at + 'node_modules/'.length);
}

// ── 1. Every dependency is a checksummed registry tarball ──────────────────
function checkResolution(lock: Lockfile): void {
  console.log('SUPPLY CHAIN — resolution and integrity');
  let unresolved = 0;
  let unchecksummed = 0;
  let offRegistry = 0;
  let counted = 0;

  for (const [key, pkg] of Object.entries(lock.packages)) {
    // The root and the workspace links are this repository's own source.
    if (key === '' || pkg.link === true || !key.includes('node_modules/')) continue;
    counted += 1;
    if (pkg.resolved === undefined) {
      fail('resolution', `${key} has no \`resolved\` — nothing records where this code came from`);
      unresolved += 1;
      continue;
    }
    if (/^git\+|^github:|^file:/.test(pkg.resolved)) {
      fail('resolution', `${key} resolves to ${pkg.resolved} — a git or file dependency is code that can change under its reference`);
      offRegistry += 1;
      continue;
    }
    if (!pkg.resolved.startsWith('https://registry.npmjs.org/')) {
      fail('resolution', `${key} resolves to ${pkg.resolved}, which is not the public registry`);
      offRegistry += 1;
    }
    if (pkg.integrity === undefined || pkg.integrity === '') {
      fail('integrity', `${key} has no integrity hash — its tarball is not checksummed on install`);
      unchecksummed += 1;
    }
  }

  if (unresolved === 0 && unchecksummed === 0 && offRegistry === 0) {
    ok(`all ${counted} locked packages are registry tarballs with integrity hashes`);
  }
  if (lock.lockfileVersion < 3) {
    fail('lockfile', `lockfileVersion is ${lock.lockfileVersion} — version 3 is what npm 11 writes, and a downgrade loses integrity metadata`);
  } else {
    ok(`lockfileVersion ${lock.lockfileVersion}`);
  }
}

// ── 2. Install scripts are reviewed, one by one ────────────────────────────
function checkInstallScripts(lock: Lockfile): void {
  console.log('SUPPLY CHAIN — install scripts');
  const found = new Set<string>();
  for (const [key, pkg] of Object.entries(lock.packages)) {
    if (pkg.hasInstallScript !== true) continue;
    found.add(packageNameOf(key));
  }

  for (const name of [...found].sort()) {
    const reason = REVIEWED_INSTALL_SCRIPTS[name];
    if (reason === undefined) {
      fail(
        'install-script',
        `${name} runs a script at install time and is not on the reviewed list. An install script runs with the full environment ` +
          `— every deployment secret CI holds — before a single test executes. Read what it does, then add it to ` +
          `REVIEWED_INSTALL_SCRIPTS with the reason.`,
      );
    } else {
      ok(`${name} — ${reason}`);
    }
  }

  // The converse: an entry that no longer corresponds to anything installed is
  // a stale exemption, and a stale exemption is how the next one gets waved
  // through. This is a warning, not a failure: the platform-specific
  // embedded-postgres packages are legitimately absent on any given machine.
  for (const name of Object.keys(REVIEWED_INSTALL_SCRIPTS)) {
    if (!found.has(name)) console.log(`  note    ${name} is exempted but not present in this lockfile`);
  }
  if (found.size === 0) ok('no package in the tree runs an install script');
}

// ── 3. The lockfile matches the manifests ──────────────────────────────────
function checkLockfileIsCurrent(lock: Lockfile, root: Manifest): void {
  console.log('SUPPLY CHAIN — the lockfile is current');
  const links = workspaceLinks(lock);
  const declared = new Map<string, string>();
  const collect = (m: Manifest, where: string): void => {
    for (const [name, range] of Object.entries({ ...m.dependencies, ...m.devDependencies })) {
      if (range.startsWith('workspace:') || range.startsWith('file:')) continue;
      declared.set(`${where}::${name}`, range);
    }
  };
  collect(root, '<root>');
  for (const ws of root.workspaces ?? []) {
    const path = join(ws, 'package.json');
    if (existsSync(join(ROOT, path))) collect(readJson<Manifest>(path), ws);
  }

  let missing = 0;
  let floating = 0;
  for (const [key, range] of declared) {
    const [, name = ''] = key.split('::');
    // A workspace link resolves to a directory in this repository, so its
    // range is not a version constraint at all — npm links the local package
    // whatever it says, and `*` is what npm itself writes. The rule that
    // matters is the converse, and it is asserted: a floating range is only
    // ever allowed to a name the lockfile records as a link.
    if (/^(\*|latest|x|\d+\.x)$/.test(range.trim()) && !links.has(name)) {
      fail('floating', `${key} is declared as \`${range}\` — a build that can resolve to a different major is not reproducible`);
      floating += 1;
    }
    const present = Object.keys(lock.packages).some((k) => packageNameOf(k) === name && k.includes('node_modules/'));
    if (!present) {
      fail('lockfile', `${key} is declared in a manifest but has no entry in package-lock.json — the lockfile is stale (run \`npm install\`)`);
      missing += 1;
    }
  }
  if (missing === 0) ok(`all ${declared.size} declared dependencies are present in the lockfile`);
  if (floating === 0)
    ok(
      `no third-party dependency is declared with a floating major (${links.size} workspace links exempt, and only because the lockfile records them as links)`,
    );

  // An override is a deliberate act and stays pinned to an exact version:
  // an override with a range re-opens the very hole it was added to close.
  for (const [name, version] of Object.entries(root.overrides ?? {})) {
    if (!/^\d+\.\d+\.\d+/.test(version)) {
      fail('override', `the override for ${name} is \`${version}\` — an override exists to pin, so it takes an exact version`);
    } else {
      ok(`override ${name}@${version} is pinned exactly`);
    }
  }
}

// ── 4. The pure packages stay pure ─────────────────────────────────────────
function checkPureWorkspaces(): void {
  console.log('SUPPLY CHAIN — the pure packages');
  for (const ws of PURE_WORKSPACES) {
    const path = join(ws, 'package.json');
    if (!existsSync(join(ROOT, path))) continue;
    const manifest = readJson<Manifest>(path);
    const runtime = Object.keys(manifest.dependencies ?? {}).filter((d) => !d.startsWith('@daftar/'));
    if (runtime.length > 0) {
      fail(
        'pure-package',
        `${ws} declares runtime dependencies (${runtime.join(', ')}). The money arithmetic has no transport, no configuration and ` +
          `no connection (§16); a dependency here is how that stops being true.`,
      );
    } else {
      ok(`${ws} has no third-party runtime dependency`);
    }
  }
}

console.log('SUPPLY-CHAIN HYGIENE (§47)\n');
const lock = readJson<Lockfile>('package-lock.json');
const root = readJson<Manifest>('package.json');
checkResolution(lock);
checkInstallScripts(lock);
checkLockfileIsCurrent(lock, root);
checkPureWorkspaces();

if (failures > 0) {
  console.error(`\nSUPPLY CHAIN: FAIL (${failures} finding${failures === 1 ? '' : 's'})`);
  process.exit(1);
}
console.log('\nSUPPLY CHAIN: PASS');
