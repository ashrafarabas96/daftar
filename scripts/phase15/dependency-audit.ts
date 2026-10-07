#!/usr/bin/env tsx
/**
 * ─────────────────────────────────────────────────────────────────────────
 * PHASE 15 DEPENDENCY / SUPPLY-CHAIN AUDIT (production hardening)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 *
 * `scripts/check-supply-chain.ts` (`npm run check:supply-chain`) is a
 * DETERMINISTIC, OFFLINE boundary: every resolved package is a checksummed
 * registry tarball, every install script is on a reviewed list, the lockfile
 * names every declared dependency, no range floats, the pure accounting
 * packages acquire no runtime dependency. It deliberately refuses to run
 * `npm audit`, because an advisory database is a moving target and a gate
 * whose verdict changes when somebody else publishes something cannot be
 * reproduced from a commit. That reasoning is correct and this script does
 * not overturn it.
 *
 * This script is the RELEASE-SCOPE audit that sits beside it. A release is a
 * point in time, and at that point in time the moving target is exactly the
 * thing you must look at: the question "does the code we are about to ship
 * depend on something with a published advisory today" has no offline
 * answer. So this script COMPOSES rather than replaces — it runs
 * `check:supply-chain` as its first arm and refuses to pass if that boundary
 * is red — and then adds the five things a release needs and a commit-
 * reproducible boundary cannot give:
 *
 *   1. supply-chain-boundary  `npm run check:supply-chain` must pass. Its
 *                             findings are not restated here; its exit code
 *                             is an arm of this audit.
 *   2. lockfile-sync          `package-lock.json` agrees with every workspace
 *                             manifest, PROVED WITHOUT MUTATING IT (below).
 *   3. advisories             `npm audit --json`, failing at or above
 *                             SEVERITY_FLOOR, every finding printed with
 *                             package, severity, advisory id and the
 *                             dependency path.
 *   4. licenses               every direct and transitive dependency's
 *                             license, against LICENSE_ALLOWLIST plus an
 *                             entry-by-entry REVIEWED_NON_ALLOWLIST.
 *   5. resolution-source      any dependency resolved from a git, file or
 *                             non-registry http source.
 *   6. install-scripts        the install-script inventory against
 *                             EXPECTED_INSTALL_SCRIPTS; drift in EITHER
 *                             direction fails.
 *
 * WHY LOCKFILE SYNC IS PROVED, NOT ASKED
 *
 * The obvious way to ask whether the lockfile is current is `npm ci
 * --dry-run` or `npm install --package-lock-only`. Both are refused here:
 * the first resolves against the network (so the gate is not reproducible
 * and a proxy outage reads as a defect), and the second WRITES the lockfile,
 * which means the check can "pass" by silently repairing the very drift it
 * exists to report. A gate that fixes its own subject is not a gate.
 *
 * So the reconciliation is done directly, and in two halves, because npm
 * records the answer to both in the lockfile itself:
 *
 *   declaration mirror  lockfileVersion 3 stores, at the key of each
 *                       workspace path (`""` for the root, `apps/api`, …),
 *                       a copy of that manifest's `name`, `version`,
 *                       `dependencies`, `devDependencies`,
 *                       `peerDependencies` and `optionalDependencies`. If
 *                       the manifest on disk differs from that copy in any
 *                       one entry, the lockfile is stale with respect to the
 *                       manifest — that difference is precisely what `npm
 *                       install` would rewrite. Reading it costs nothing and
 *                       writes nothing.
 *   resolution satisfies  for every declared range that is not a workspace
 *                       link, the version npm would actually resolve for
 *                       that workspace (walking the lockfile's nesting from
 *                       the workspace directory outwards, the way node
 *                       resolution does) must SATISFY the declared range.
 *                       `check:supply-chain` asks only that a package of
 *                       that name exists somewhere in the lockfile; a
 *                       manifest bumped from `^3` to `^4` against a
 *                       lockfile still holding `3.x` passes that and fails
 *                       this.
 *
 * NON-VACUITY
 *
 * Every arm refuses to pass on an empty subject set, and prints the subject
 * count it measured. Zero locked packages read, zero licenses resolved, zero
 * manifests reconciled, an `npm audit` whose output does not parse — each is
 * a FAIL, never a pass. A check that looked at nothing has measured nothing,
 * and "no findings over nothing" is the shape every vacuous green takes.
 *
 * An arm that genuinely cannot run here — `npm audit` unreachable through a
 * proxy is the real case — is UNMEASURED, and UNMEASURED exits non-zero and
 * names the arm. It never degrades to a pass.
 *
 * Usage:
 *   npm run audit:deps:phase15 [-- --audit-json=<file>] [--skip-boundary]
 *     --audit-json=<file>   read `npm audit --json` output from a file
 *                           instead of running npm (for a fixture or an
 *                           air-gapped run); the arm records its source.
 *     --skip-boundary       do not re-run check:supply-chain. The summary
 *                           then records that arm as UNMEASURED and the exit
 *                           code is non-zero: a skipped step is UNMEASURED,
 *                           never green.
 *     --json=<file>         also write the summary object to a file.
 *
 * Exit 0 = PASS. Any FAIL or any UNMEASURED arm = exit 1.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(join(__dirname, '..', '..'));

// ── the declared constants: every threshold has a name and a reason ────────

/**
 * The severity floor. An advisory AT or ABOVE this severity fails the audit.
 *
 * `moderate` and not `high`: a moderate advisory in a dependency that parses
 * attacker-supplied input — which, in a multi-tenant commerce API, is most of
 * the request path — is a production issue whatever the CVSS band says. The
 * floor is a named constant so that raising it is a visible, reviewable act
 * and not a flag somebody passed on one run.
 */
const SEVERITY_FLOOR = 'moderate';
/** npm's severity ladder, lowest first. The floor's index is the cut. */
const SEVERITY_ORDER = ['info', 'low', 'moderate', 'high', 'critical'] as const;
type Severity = (typeof SEVERITY_ORDER)[number];

/**
 * The licenses this release may ship. Permissive and attribution-only, with
 * no source-disclosure obligation attaching to DAFTAR's own code.
 *
 * `CC-BY-4.0` and `OFL-1.1` are data and font licenses, not code licenses,
 * and are here because the packages that carry them (`caniuse-lite`, a
 * webfont) ship data and glyphs; both are attribution-only.
 */
const LICENSE_ALLOWLIST: readonly string[] = [
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'CC-BY-4.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'OFL-1.1',
  'Python-2.0',
  'Unlicense',
];

/**
 * The packages whose license is NOT on the allowlist and which a human has
 * nonetheless cleared, one by one, with the exact license string they
 * cleared it under.
 *
 * This is deliberately a separate map and not three more strings in
 * `LICENSE_ALLOWLIST`: adding `LGPL-3.0-or-later` to the allowlist would
 * clear it for every package forever, which is the "never widen a narrow
 * result under a broad name" failure applied to licensing. Here the clearance
 * is pinned to one package name AND one license string, so a different
 * package arriving under the same license, or the same package changing its
 * license, fails and is read by a human again.
 */
const REVIEWED_NON_ALLOWLIST: Record<string, { readonly license: string; readonly reason: string }> = {
  '@img/sharp-libvips-linux-x64': {
    license: 'LGPL-3.0-or-later',
    reason:
      'the prebuilt libvips shared library behind sharp. LGPL, not GPL: it is dynamically loaded by a separate process boundary and is not linked into, and imposes no source obligation on, DAFTAR code. Shipped unmodified, which is the condition the LGPL attaches.',
  },
  '@img/sharp-libvips-linuxmusl-x64': {
    license: 'LGPL-3.0-or-later',
    reason: 'the musl build of the same prebuilt libvips library, same reasoning',
  },
  '@img/sharp-wasm32': {
    license: 'Apache-2.0 AND LGPL-3.0-or-later AND MIT',
    reason: 'the wasm fallback build of sharp, carrying libvips under the same LGPL terms; optional and not installed on linux/x64',
  },
};

/**
 * The third-party packages allowed to run `preinstall`/`install`/`postinstall`.
 *
 * An install script runs with the full environment — every deployment secret
 * CI holds — before a single test executes, so this set is EXACT: a package
 * that appears and is not listed fails, and a listed package that no longer
 * appears in the lockfile also fails. `check:supply-chain` treats the second
 * direction as a note, because a platform-optional package is legitimately
 * absent from any one machine; at release scope the set is measured against
 * the LOCKFILE rather than against what happens to be installed, and the
 * lockfile names every platform, so drift in either direction is real.
 */
const EXPECTED_INSTALL_SCRIPTS: readonly string[] = [
  '@embedded-postgres/darwin-arm64',
  '@embedded-postgres/darwin-x64',
  '@embedded-postgres/linux-arm',
  '@embedded-postgres/linux-arm64',
  '@embedded-postgres/linux-ia32',
  '@embedded-postgres/linux-ppc64',
  '@embedded-postgres/linux-x64',
  '@embedded-postgres/windows-x64',
  'argon2',
  'esbuild',
  'fsevents',
];

/** A dependency whose `resolved` does not begin with this is not a public-registry tarball. */
const REGISTRY_PREFIX = 'https://registry.npmjs.org/';

// ── semver, the small part of it this audit needs, and FAIL-CLOSED ───────

/**
 * `satisfies`, implemented here rather than imported.
 *
 * The repository has `semver` in `node_modules` as a transitive dependency,
 * but no `@types/semver`, and this script may not add one; an untyped import
 * would be an `any` flowing into the one place a wrong answer is invisible.
 * A hand-rolled full semver implementation would be worse: a subtly wrong
 * range evaluator produces a FALSE GREEN, which is the single outcome this
 * project's standard refuses.
 *
 * So this covers exactly the range forms the manifests use — exact,
 * `^x.y.z`, `~x.y.z`, `>=x.y.z`, with prerelease tags — and FAILS CLOSED on
 * anything else: `null` means "this script cannot evaluate this range", and
 * the caller reports that as a finding rather than passing it. Narrow and
 * honest beats broad and guessed.
 */
interface Parsed {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly pre: string;
}
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(text: string): Parsed | null {
  const m = VERSION.exec(text.trim());
  if (m === null || m[1] === undefined || m[2] === undefined || m[3] === undefined) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? '' };
}

/** -1 / 0 / 1 on the release triple only; prereleases are compared as dotted identifiers. */
function compare(a: Parsed, b: Parsed): number {
  for (const field of ['major', 'minor', 'patch'] as const) {
    if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
  }
  if (a.pre === b.pre) return 0;
  if (a.pre === '') return 1;
  if (b.pre === '') return -1;
  const x = a.pre.split('.');
  const y = b.pre.split('.');
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const l = x[i];
    const r = y[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    const ln = /^\d+$/.test(l);
    const rn = /^\d+$/.test(r);
    if (ln && rn) return Number(l) < Number(r) ? -1 : 1;
    if (ln !== rn) return ln ? -1 : 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

/** `^1.2.3` → the exclusive upper bound `2.0.0`; `^0.2.3` → `0.3.0`; `^0.0.3` → `0.0.4`. */
function caretCeiling(v: Parsed): Parsed {
  if (v.major > 0) return { major: v.major + 1, minor: 0, patch: 0, pre: '' };
  if (v.minor > 0) return { major: 0, minor: v.minor + 1, patch: 0, pre: '' };
  return { major: 0, minor: 0, patch: v.patch + 1, pre: '' };
}

/** `true` / `false`, or `null` when this script cannot evaluate the range at all. */
export function satisfies(version: string, range: string): boolean | null {
  const v = parseVersion(version);
  if (v === null) return null;
  const text = range.trim();
  const operator = /^(\^|~|>=|=)?\s*(.+)$/.exec(text);
  if (operator === null || operator[2] === undefined) return null;
  const target = parseVersion(operator[2]);
  if (target === null) return null;
  switch (operator[1] ?? '=') {
    case '=':
      return compare(v, target) === 0;
    case '>=':
      return compare(v, target) >= 0;
    case '~':
      return compare(v, target) >= 0 && compare(v, { major: target.major, minor: target.minor + 1, patch: 0, pre: '' }) < 0;
    case '^':
      return compare(v, target) >= 0 && compare(v, caretCeiling(target)) < 0;
    default:
      return null;
  }
}

// ── the result shape ──────────────────────────────────────────────────────

type ArmResult = 'PASS' | 'FAIL' | 'UNMEASURED';

interface Arm {
  readonly name: string;
  /** what this arm actually looked at; 0 is never a PASS */
  subjects: number;
  readonly subjectLabel: string;
  result: ArmResult;
  readonly findings: string[];
  /** set on UNMEASURED: the exact reason, including the command that failed */
  cause?: string;
}

const arms: Arm[] = [];
function arm(name: string, subjectLabel: string): Arm {
  const a: Arm = { name, subjects: 0, subjectLabel, result: 'FAIL', findings: [] };
  arms.push(a);
  return a;
}

/**
 * Close an arm. An arm with no findings but an empty subject set is a FAIL,
 * not a PASS: it measured nothing. This is the only place an arm becomes
 * PASS, so there is no path to a green arm that bypasses the count.
 */
function settle(a: Arm): void {
  if (a.result === 'UNMEASURED') return;
  if (a.subjects <= 0) {
    a.findings.unshift(
      `NON-VACUITY: this arm read 0 ${a.subjectLabel}. A check with an empty subject set has measured nothing, and "no findings" over nothing is not a pass.`,
    );
    a.result = 'FAIL';
    return;
  }
  a.result = a.findings.length === 0 ? 'PASS' : 'FAIL';
}

function unmeasured(a: Arm, cause: string): void {
  a.result = 'UNMEASURED';
  a.cause = cause;
}

// ── the lockfile and the manifests ────────────────────────────────────────

interface LockPackage {
  readonly version?: string;
  readonly resolved?: string;
  readonly integrity?: string;
  readonly link?: boolean;
  readonly hasInstallScript?: boolean;
  readonly dev?: boolean;
  readonly name?: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
}

interface Lockfile {
  readonly lockfileVersion: number;
  readonly packages: Record<string, LockPackage>;
}

interface Manifest {
  readonly name?: string;
  readonly version?: string;
  readonly workspaces?: string[];
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly license?: string | { readonly type?: string };
  readonly licenses?: readonly (string | { readonly type?: string })[];
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

/** `node_modules/a/node_modules/@scope/b` → `@scope/b`. */
function packageNameOf(lockKey: string): string {
  const at = lockKey.lastIndexOf('node_modules/');
  return at === -1 ? lockKey : lockKey.slice(at + 'node_modules/'.length);
}

/** The lockfile keys that are third-party packages: not the root, not a workspace link. */
function thirdPartyKeys(lock: Lockfile): string[] {
  return Object.keys(lock.packages).filter((k) => {
    const pkg = lock.packages[k];
    return k !== '' && k.includes('node_modules/') && pkg?.link !== true;
  });
}

/** The workspace paths the lockfile records as links in this repository. */
function workspaceLinkNames(lock: Lockfile): Set<string> {
  const names = new Set<string>();
  for (const [key, pkg] of Object.entries(lock.packages)) if (pkg.link === true) names.add(packageNameOf(key));
  return names;
}

// ── arm 1: the offline boundary still holds ──────────────────────────────

function armSupplyChainBoundary(skip: boolean): void {
  const a = arm('supply-chain-boundary', 'boundary runs');
  if (skip) {
    unmeasured(a, '--skip-boundary was passed: `npm run check:supply-chain` was not run. A skipped step is UNMEASURED, never green.');
    return;
  }
  const run = spawnSync('npm', ['run', '--silent', 'check:supply-chain'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const status = run.status;
  if (run.error !== undefined) {
    unmeasured(a, `\`npm run --silent check:supply-chain\` could not be started: ${run.error.message}`);
    return;
  }
  a.subjects = 1;
  const log = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  if (status !== 0) {
    // Its findings are its own to report; this arm records the verdict and
    // the tail of the log so the failure is attributable without this script
    // paraphrasing (and so possibly misrepresenting) another gate.
    a.findings.push(
      `\`npm run --silent check:supply-chain\` exited ${String(status)}. The offline supply-chain boundary is red, so this release-scope audit cannot pass. Last lines: ${log
        .trim()
        .split('\n')
        .slice(-4)
        .join(' | ')}`,
    );
  }
  settle(a);
}

// ── arm 2: the lockfile is in sync, without mutating it ──────────────────

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;

/**
 * The version the lockfile resolves for `name` as seen from the directory
 * `from`, by the same outward walk node resolution performs: first
 * `<from>/node_modules/<name>`, then each parent's, ending at the root's.
 */
function resolvedFor(lock: Lockfile, from: string, name: string): { key: string; pkg: LockPackage } | null {
  const segments = from === '' ? [] : from.split('/');
  for (let depth = segments.length; depth >= 0; depth -= 1) {
    const prefix = segments.slice(0, depth).join('/');
    const key = prefix === '' ? `node_modules/${name}` : `${prefix}/node_modules/${name}`;
    const pkg = lock.packages[key];
    if (pkg !== undefined) return { key, pkg };
  }
  return null;
}

function armLockfileSync(lock: Lockfile, root: Manifest): void {
  const a = arm('lockfile-sync', 'manifest/lockfile declaration pairs');
  const links = workspaceLinkNames(lock);
  const manifestPaths = ['', ...(root.workspaces ?? [])];
  let declarations = 0;

  for (const ws of manifestPaths) {
    const file = ws === '' ? 'package.json' : `${ws}/package.json`;
    if (!existsSync(join(ROOT, file))) {
      a.findings.push(`${file} is listed as a workspace but does not exist`);
      continue;
    }
    const manifest = readJson<Manifest>(join(ROOT, file));
    const locked = lock.packages[ws];
    if (locked === undefined) {
      a.findings.push(`package-lock.json has no entry for the workspace \`${ws === '' ? '<root>' : ws}\` — the lockfile does not know this manifest exists`);
      continue;
    }
    a.subjects += 1;

    // (a) the declaration mirror: what npm install would rewrite.
    if ((manifest.name ?? '') !== (locked.name ?? '') && ws !== '')
      a.findings.push(`${file} is named "${String(manifest.name)}" but the lockfile records "${String(locked.name)}" at \`${ws}\``);
    if ((manifest.version ?? '') !== (locked.version ?? ''))
      a.findings.push(`${file} is version ${String(manifest.version)} but the lockfile records ${String(locked.version)} at \`${ws === '' ? '<root>' : ws}\``);
    for (const field of DEP_FIELDS) {
      const declared = manifest[field] ?? {};
      const mirrored = locked[field] ?? {};
      for (const [name, range] of Object.entries(declared)) {
        declarations += 1;
        const inLock = mirrored[name];
        if (inLock === undefined)
          a.findings.push(
            `${file} declares ${field}.${name} = "${range}" but the lockfile's \`${ws === '' ? '<root>' : ws}\` entry does not mirror it — the lockfile is stale with respect to this manifest (\`npm install\` would rewrite it)`,
          );
        else if (inLock !== range)
          a.findings.push(
            `${file} declares ${field}.${name} = "${range}" but the lockfile mirrors "${inLock}" at \`${ws === '' ? '<root>' : ws}\` — the lockfile is stale with respect to this manifest`,
          );
      }
      for (const [name, range] of Object.entries(mirrored)) {
        if (declared[name] === undefined)
          a.findings.push(
            `the lockfile's \`${ws === '' ? '<root>' : ws}\` entry mirrors ${field}.${name} = "${range}" but ${file} no longer declares it — the lockfile is stale with respect to this manifest`,
          );
      }
    }

    // (b) resolution satisfies the declared range.
    for (const field of ['dependencies', 'devDependencies'] as const) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        if (links.has(name) || range.startsWith('workspace:') || range.startsWith('file:') || range.startsWith('npm:')) continue;
        const hit = resolvedFor(lock, ws, name);
        if (hit === null) {
          a.findings.push(
            `${file} declares ${field}.${name} but no lockfile entry resolves for \`${ws === '' ? '<root>' : ws}\` — the lockfile is stale (\`npm install\`)`,
          );
          continue;
        }
        const version = hit.pkg.version;
        if (version === undefined) {
          a.findings.push(`${hit.key} (resolving ${name} for \`${ws === '' ? '<root>' : ws}\`) records no version`);
          continue;
        }
        const verdict = satisfies(version, range);
        if (verdict === null) {
          // Fail closed: an unevaluable range is reported, never waved past.
          a.findings.push(
            `${file} declares ${field}.${name} = "${range}" and the lockfile resolves ${hit.key}@${version}, but this audit cannot evaluate that range form (it evaluates exact, \`^\`, \`~\` and \`>=\` only). An unevaluable range is a finding, not a pass: declare it in an evaluable form, or extend \`satisfies\` and say so in the report.`,
          );
          continue;
        }
        if (!verdict)
          a.findings.push(
            `${file} declares ${field}.${name} = "${range}" but the lockfile resolves ${hit.key}@${version}, which does not satisfy it — the lockfile is out of sync with the manifest`,
          );
      }
    }
  }

  console.log(`  subject: ${a.subjects} manifests reconciled, ${declarations} declared dependency entries compared`);
  settle(a);
}

// ── arm 3: advisories ────────────────────────────────────────────────────

interface AuditVia {
  readonly source?: number;
  readonly name?: string;
  readonly title?: string;
  readonly url?: string;
  readonly severity?: string;
}
interface AuditVuln {
  readonly name?: string;
  readonly severity?: string;
  readonly isDirect?: boolean;
  readonly via?: readonly (AuditVia | string)[];
  readonly effects?: readonly string[];
  readonly range?: string;
}
interface AuditReport {
  readonly auditReportVersion?: number;
  readonly vulnerabilities?: Record<string, AuditVuln>;
  readonly metadata?: { readonly vulnerabilities?: Record<string, number>; readonly dependencies?: Record<string, number> };
}

const severityIndex = (s: string): number => SEVERITY_ORDER.indexOf(s as Severity);

/**
 * The chain from a declared dependency down to the vulnerable package, read
 * from the audit report's own `effects` graph: `a > b > sharp`. A finding
 * without a path is a finding nobody can act on.
 */
function dependencyPaths(name: string, vulns: Record<string, AuditVuln>): string[] {
  const paths: string[] = [];
  const walk = (current: string, chain: string[]): void => {
    if (chain.includes(current)) {
      paths.push([...chain, `${current} (cycle)`].join(' > '));
      return;
    }
    const node = vulns[current];
    const next = [...(node?.effects ?? [])];
    const trail = [...chain, current];
    if (next.length === 0 || trail.length > 12) {
      paths.push(trail.reverse().join(' > '));
      return;
    }
    for (const parent of next) walk(parent, trail);
  };
  walk(name, []);
  return [...new Set(paths)].slice(0, 6);
}

function armAdvisories(auditJsonPath: string | undefined): void {
  const a = arm('advisories', 'audited dependencies');
  let text: string;
  let source: string;
  if (auditJsonPath !== undefined) {
    const path = resolve(auditJsonPath);
    if (!existsSync(path)) {
      unmeasured(a, `--audit-json=${auditJsonPath} does not exist`);
      return;
    }
    text = readFileSync(path, 'utf8');
    source = `--audit-json=${path}`;
  } else {
    const run = spawnSync('npm', ['audit', '--json'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const status = run.status;
    if (run.error !== undefined) {
      unmeasured(a, `\`npm audit --json\` could not be started: ${run.error.message}`);
      return;
    }
    // `npm audit` exits non-zero when it FINDS something, which is not a
    // failure to measure. The distinction is whether it produced a report.
    text = run.stdout ?? '';
    source = `npm audit --json (exit ${String(status)})`;
    if (text.trim() === '') {
      unmeasured(
        a,
        `\`npm audit --json\` exited ${String(status)} and produced no output: ${String(run.stderr ?? '')
          .trim()
          .split('\n')
          .slice(-3)
          .join(' | ')}`,
      );
      return;
    }
  }

  let report: AuditReport;
  try {
    report = JSON.parse(text) as AuditReport;
  } catch (e) {
    // Unparsable output is UNMEASURED, never a pass: the commonest way an
    // advisory arm goes vacuously green is a proxy error page parsed as "no
    // vulnerabilities".
    unmeasured(a, `${source} did not produce parsable JSON (${(e as Error).message}); first 200 bytes: ${JSON.stringify(text.slice(0, 200))}`);
    return;
  }
  const vulns = report.vulnerabilities;
  if (vulns === undefined || typeof vulns !== 'object') {
    unmeasured(a, `${source} produced JSON with no \`vulnerabilities\` object; an audit report this script cannot read is not evidence of a clean tree`);
    return;
  }
  const audited = report.metadata?.dependencies?.['total'] ?? 0;
  if (audited <= 0) {
    unmeasured(
      a,
      `${source} reports metadata.dependencies.total = ${String(audited)}: the audit looked at no dependencies, so there is nothing to conclude from it`,
    );
    return;
  }
  a.subjects = audited;

  const floor = severityIndex(SEVERITY_FLOOR);
  let atOrAbove = 0;
  for (const [name, v] of Object.entries(vulns)) {
    const severity = String(v.severity ?? 'unknown');
    const idx = severityIndex(severity);
    if (idx < 0) {
      a.findings.push(
        `${name}: npm audit reports severity "${severity}", which is not on the ladder ${SEVERITY_ORDER.join(' < ')} — an unreadable severity is treated as a failure`,
      );
      continue;
    }
    if (idx < floor) {
      console.log(`  below floor  ${name} (${severity})`);
      continue;
    }
    atOrAbove += 1;
    const advisories = (v.via ?? [])
      .filter((x): x is AuditVia => typeof x === 'object')
      .map((x) => `${String(x.url ?? '')}${x.source === undefined ? '' : ` [id ${String(x.source)}]`}${x.title === undefined ? '' : `: ${x.title}`}`);
    const viaNames = (v.via ?? []).filter((x): x is string => typeof x === 'string');
    for (const path of dependencyPaths(name, vulns)) {
      a.findings.push(
        `${severity.toUpperCase()} ≥ ${SEVERITY_FLOOR} — package ${name}${v.range === undefined ? '' : `@${v.range}`}` +
          `${v.isDirect === true ? ' (direct dependency)' : ''}; dependency path: ${path}` +
          `${advisories.length > 0 ? `; advisories: ${advisories.join(' ; ')}` : ''}` +
          `${viaNames.length > 0 ? `; vulnerable through: ${viaNames.join(', ')}` : ''}`,
      );
    }
  }
  console.log(`  subject: ${a.subjects} dependencies audited by ${source}; ${atOrAbove} at or above the ${SEVERITY_FLOOR} floor`);
  settle(a);
}

// ── arm 4: licenses ─────────────────────────────────────────────────────

function licenseOf(manifest: Manifest): string | null {
  const direct = manifest.license;
  if (typeof direct === 'string' && direct.trim() !== '') return direct.trim();
  if (direct !== undefined && typeof direct === 'object' && typeof direct.type === 'string') return direct.type.trim();
  const legacy: readonly (string | { readonly type?: string })[] = manifest.licenses ?? [];
  if (legacy.length > 0) return legacy.map((l) => (typeof l === 'string' ? l : (l.type ?? '?'))).join(' OR ');
  return null;
}

function armLicenses(lock: Lockfile): void {
  const a = arm('licenses', 'resolved package licenses');
  const keys = thirdPartyKeys(lock);
  let notInstalled = 0;
  const byLicense = new Map<string, number>();

  for (const key of keys) {
    const name = packageNameOf(key);
    const manifestPath = join(ROOT, key, 'package.json');
    if (!existsSync(manifestPath)) {
      // A locked-but-not-installed package is a platform-optional one. It is
      // counted and named, NOT silently dropped: if the count ever exceeds
      // the installed count the arm has stopped measuring the real tree.
      notInstalled += 1;
      continue;
    }
    const license = licenseOf(readJson<Manifest>(manifestPath));
    a.subjects += 1;
    if (license === null) {
      a.findings.push(`${key} (${name}) declares no license at all. Code with no license grant is code this release has no right to ship.`);
      continue;
    }
    byLicense.set(license, (byLicense.get(license) ?? 0) + 1);
    if (LICENSE_ALLOWLIST.includes(license)) continue;
    const reviewed = REVIEWED_NON_ALLOWLIST[name];
    if (reviewed === undefined) {
      a.findings.push(
        `${key} (${name}) is licensed "${license}", which is not on LICENSE_ALLOWLIST (${LICENSE_ALLOWLIST.join(', ')}) and has no entry in REVIEWED_NON_ALLOWLIST. Read the license, then either it belongs on the allowlist or this package does not ship.`,
      );
      continue;
    }
    if (reviewed.license !== license) {
      a.findings.push(
        `${key} (${name}) is now licensed "${license}" but was reviewed under "${reviewed.license}". A package that changes its license is read again by a human; the old clearance does not carry over.`,
      );
      continue;
    }
    console.log(`  reviewed     ${name} — ${license} — ${reviewed.reason}`);
  }

  for (const name of Object.keys(REVIEWED_NON_ALLOWLIST)) {
    if (!keys.some((k) => packageNameOf(k) === name))
      a.findings.push(
        `REVIEWED_NON_ALLOWLIST clears ${name} but the lockfile no longer holds it — a stale clearance is how the next one gets waved through. Remove the entry.`,
      );
  }

  console.log(
    `  subject: ${a.subjects} licenses resolved from ${keys.length} locked third-party packages (${notInstalled} locked but not installed on ${process.platform}/${process.arch})`,
  );
  console.log(
    `  licenses seen: ${[...byLicense.entries()]
      .sort((x, y) => y[1] - x[1])
      .map(([l, c]) => `${l}×${c}`)
      .join(', ')}`,
  );
  if (a.subjects > 0 && notInstalled >= a.subjects)
    a.findings.push(
      `NON-VACUITY: ${notInstalled} of ${keys.length} locked packages are not installed, which is at least as many as the ${a.subjects} whose license was read. This arm is reading a tree that is mostly absent; run it where the dependencies are installed.`,
    );
  settle(a);
}

// ── arm 5: where the code came from ─────────────────────────────────────

function armResolutionSource(lock: Lockfile): void {
  const a = arm('resolution-source', 'locked third-party packages');
  for (const key of thirdPartyKeys(lock)) {
    const pkg = lock.packages[key];
    if (pkg === undefined) continue;
    a.subjects += 1;
    const resolved = pkg.resolved;
    if (resolved === undefined || resolved === '') {
      a.findings.push(`${key} records no \`resolved\` — nothing says where this code came from, so nothing can say it has not changed`);
      continue;
    }
    if (/^(git\+|git:|github:|gitlab:|bitbucket:|file:|link:)/.test(resolved)) {
      a.findings.push(
        `${key} resolves to ${resolved} — a git or file dependency is code that can change under its reference, with no immutable tarball and no published digest`,
      );
      continue;
    }
    if (resolved.startsWith('http://')) {
      a.findings.push(`${key} resolves to ${resolved} over plain http — the transport cannot authenticate what it delivered`);
      continue;
    }
    if (!resolved.startsWith(REGISTRY_PREFIX)) {
      a.findings.push(`${key} resolves to ${resolved}, which is not the public registry (${REGISTRY_PREFIX})`);
      continue;
    }
    if (pkg.integrity === undefined || pkg.integrity === '')
      a.findings.push(`${key} is a registry tarball with no integrity hash — nothing checksums it on install`);
  }
  console.log(`  subject: ${a.subjects} locked third-party packages checked for their resolution source`);
  settle(a);
}

// ── arm 6: install scripts ──────────────────────────────────────────────

function armInstallScripts(lock: Lockfile): void {
  const a = arm('install-scripts', 'locked third-party packages');
  const found = new Set<string>();
  for (const key of thirdPartyKeys(lock)) {
    a.subjects += 1;
    if (lock.packages[key]?.hasInstallScript === true) found.add(packageNameOf(key));
  }
  const expected = new Set(EXPECTED_INSTALL_SCRIPTS);
  for (const name of [...found].sort()) {
    if (!expected.has(name))
      a.findings.push(
        `${name} runs a preinstall/install/postinstall script and is NOT in EXPECTED_INSTALL_SCRIPTS. An install script runs with the full environment — every deployment secret CI holds — before a single test executes. Read what it does, then add it with the reason or remove the dependency.`,
      );
    else console.log(`  inventory    ${name} (install script, expected)`);
  }
  for (const name of [...expected].sort()) {
    if (!found.has(name))
      a.findings.push(
        `EXPECTED_INSTALL_SCRIPTS names ${name} but no lockfile entry for it declares an install script. The set has drifted: either the dependency is gone or it stopped running a script, and either way the expectation is now describing something that is not there.`,
      );
  }
  console.log(`  subject: ${a.subjects} locked third-party packages scanned for install scripts; ${found.size} declare one, ${expected.size} expected`);
  settle(a);
}

// ── CLI ─────────────────────────────────────────────────────────────────

function main(): void {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const hit = argv.find((x) => x.startsWith(`--${name}=`));
    return hit === undefined ? undefined : hit.slice(name.length + 3);
  };
  const skipBoundary = argv.includes('--skip-boundary');

  console.log('PHASE 15 DEPENDENCY / SUPPLY-CHAIN AUDIT');
  console.log(`  severity floor: ${SEVERITY_FLOOR} (${SEVERITY_ORDER.join(' < ')})`);
  console.log(`  license allowlist: ${LICENSE_ALLOWLIST.join(', ')}`);
  console.log(`  reviewed non-allowlist entries: ${Object.keys(REVIEWED_NON_ALLOWLIST).length}`);
  console.log('');

  const lockPath = join(ROOT, 'package-lock.json');
  if (!existsSync(lockPath)) {
    console.log(
      `P15_DEPENDENCY_AUDIT: ${JSON.stringify({ result: 'UNMEASURED', cause: 'package-lock.json does not exist; there is no dependency set to audit' })}`,
    );
    process.exit(1);
  }
  const lock = readJson<Lockfile>(lockPath);
  const root = readJson<Manifest>(join(ROOT, 'package.json'));
  if (typeof lock.packages !== 'object' || Object.keys(lock.packages).length === 0) {
    console.log(
      `P15_DEPENDENCY_AUDIT: ${JSON.stringify({ result: 'UNMEASURED', cause: 'package-lock.json records no packages; an empty subject set measures nothing' })}`,
    );
    process.exit(1);
  }

  console.log('ARM supply-chain-boundary');
  armSupplyChainBoundary(skipBoundary);
  console.log('ARM lockfile-sync');
  armLockfileSync(lock, root);
  console.log('ARM advisories');
  armAdvisories(flag('audit-json'));
  console.log('ARM licenses');
  armLicenses(lock);
  console.log('ARM resolution-source');
  armResolutionSource(lock);
  console.log('ARM install-scripts');
  armInstallScripts(lock);

  console.log('');
  for (const a of arms) {
    console.log(`${a.result.padEnd(10)} ${a.name} (${a.subjects} ${a.subjectLabel})`);
    if (a.cause !== undefined) console.log(`    UNMEASURED: ${a.cause}`);
    for (const f of a.findings) console.log(`    - ${f}`);
  }

  const failed = arms.filter((x) => x.result === 'FAIL');
  const un = arms.filter((x) => x.result === 'UNMEASURED');
  const result: ArmResult = un.length > 0 ? 'UNMEASURED' : failed.length > 0 ? 'FAIL' : 'PASS';
  const summary = {
    produced: 'scripts/phase15/dependency-audit.ts',
    severityFloor: SEVERITY_FLOOR,
    licenseAllowlist: LICENSE_ALLOWLIST.length,
    reviewedNonAllowlist: Object.keys(REVIEWED_NON_ALLOWLIST).length,
    expectedInstallScripts: EXPECTED_INSTALL_SCRIPTS.length,
    lockfileVersion: lock.lockfileVersion,
    arms: arms.map((x) => ({
      name: x.name,
      result: x.result,
      subjects: x.subjects,
      findings: x.findings.length,
      ...(x.cause === undefined ? {} : { cause: x.cause }),
    })),
    unmeasured: un.map((x) => x.name),
    failedArms: failed.map((x) => x.name),
    findings: arms.flatMap((x) => x.findings),
    result,
  };
  const out = flag('json');
  if (out !== undefined) {
    const p = resolve(out);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `${JSON.stringify(summary, null, 2)}\n`);
  }
  console.log('');
  console.log(`P15_DEPENDENCY_AUDIT: ${JSON.stringify({ ...summary, findings: summary.findings.length })}`);
  if (result === 'UNMEASURED') console.log(`PHASE 15 DEPENDENCY AUDIT: UNMEASURED — ${un.map((x) => x.name).join(', ')}`);
  else console.log(`PHASE 15 DEPENDENCY AUDIT: ${result}`);
  process.exit(result === 'PASS' ? 0 : 1);
}

if (require.main === module) main();
