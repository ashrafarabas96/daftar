#!/usr/bin/env tsx
/**
 * ─────────────────────────────────────────────────────────────────────────
 * PHASE 3 RELEASE GATE — `npm run gate:phase3:release`
 * ─────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT IS
 *
 * The one command that decides whether the Phase 3 release candidate may be
 * handed over (docs/PHASE_3_S9_CONTRACT.md §2). It COMPOSES what already
 * exists and restates nothing: the Phase 2 release gate verbatim (which
 * composes the Phase 1 release gate, the P2-S8 gate chain, the deployment
 * matrix and the supply-chain check), the permanent Phase 3 corrective gate
 * verbatim (which composes the permanent P3-S8 gate, and through it P3-S7 …
 * P3-S1, P2-S8 … P2-S1 and Phase 1, then proves every corrected blocker and
 * runs the real-browser matrix; the corrective directive §19), and the
 * deployed-database rehearsal. What it adds itself is only what belongs to
 * the Phase 3 closure: the Phase 3 migration prefix, the Phase 3 documents'
 * agreement with the accepted state, and the tree's identity as a Phase 3
 * candidate.
 *
 * WHAT RUNS TWICE, AND WHY THAT IS ACCEPTED (A-04, TL-2)
 *
 * `gate:phase2:s8` and `check:deployment-authority` run once inside each of
 * the two composed gates. Avoiding that would need a switch on a predecessor
 * gate that skips its own steps, and a predecessor gate with a skip switch is
 * a weakened gate.
 *
 * IT MUST RUN FROM AN EXTRACTED ARCHIVE
 *
 * Nothing below shells out to git or reads a repository directory. The tree's
 * identity comes from `DELIVERY_MANIFEST.json` when one is present, and an
 * extracted candidate that says it is not a Phase 3 candidate is refused.
 *
 * NO SENTENCE ABOUT FILES AFTER THE PREFIX
 *
 * The Phase 3 prefix check protects 0053 through the prefix end and permits
 * every later migration. This file names no migration after the prefix: the
 * P2-S9 gate once forbade forward evolution by asserting "no migration after
 * 0052", and the first successor migration turned it red on every later tree.
 *
 * MANDATORY CHECKS CANNOT BE SKIPPED
 *
 * Any `RELEASE_GATE_SKIP_*` in the environment fails the gate before it runs
 * anything, and the evidence it writes records `mandatorySkipped`.
 *
 * `--root <dir>` and `--structural-only` exist for the red proofs
 * (tests/security/phase3-release-gate.test.ts): they change WHERE the gate
 * looks, never WHAT it demands, and a structural-only run reports no release
 * verdict.
 *
 * Usage:
 *   npm run gate:phase3:release [-- --evidence=<file.json>] [--log-dir=<dir>]
 *                               [--archive-sha256=<hex>] [--list]
 *                               [--root <dir> --structural-only]
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { arch, platform, release as osRelease } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Client } from 'pg';
import { PHASE3_PREFIX, PHASE3_PREFIX_END, PHASE3_PREFIX_START, checkPhase3Prefix } from './phase3-prefix';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// ─────────────────────────────────────────────────────────────────────────
// The closure checks this gate owns. Each takes the root it looks at, so the
// red proofs can point it at a copy.
// ─────────────────────────────────────────────────────────────────────────

/** A-08: the identity of the tree being gated, as `scripts/phase2-release-gate.ts` records it. */
export function treeIdentity(root: string, archiveSha256: string | null): Record<string, unknown> {
  const manifestPath = join(root, 'DELIVERY_MANIFEST.json');
  if (!existsSync(manifestPath)) return { kind: 'source-checkout', deliveryManifest: null, archiveSha256 };
  const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  return {
    kind: 'extracted-archive',
    archiveSha256,
    deliveryManifest: {
      phase: m['phase'],
      sourceCommit: m['sourceCommit'],
      treeHash: m['treeHash'],
      fileCount: m['fileCount'],
      migrationCount: m['migrationCount'],
      frozenThrough: m['frozenThrough'],
      generatedAt: m['generatedAt'],
    },
  };
}

/**
 * A-08: an extracted candidate must say it is a Phase 3 candidate. A Phase 2
 * archive gated by the Phase 3 gate is not a Phase 3 release, however green.
 */
export function treeIsAPhase3Candidate(root: string): string[] {
  const manifestPath = join(root, 'DELIVERY_MANIFEST.json');
  if (!existsSync(manifestPath)) {
    console.log('   (a source checkout carries no delivery manifest — its identity is the checkout itself)');
    return [];
  }
  let phase: unknown;
  try {
    phase = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { phase?: unknown }).phase;
  } catch (e) {
    return [`DELIVERY_MANIFEST.json is not readable JSON: ${e instanceof Error ? e.message : String(e)}`];
  }
  if (phase !== 3) return [`DELIVERY_MANIFEST.json says phase ${JSON.stringify(phase)}; the Phase 3 release gate gates a Phase 3 candidate only`];
  console.log('   the delivery manifest describes a Phase 3 release candidate');
  return [];
}

/** A-03: the Phase 3 prefix 0053 … prefix end stays complete, ordered and byte-identical; later migrations are permitted. */
export function phase3PrefixIntact(root: string): string[] {
  const problems = checkPhase3Prefix(join(root, 'infrastructure/database/migrations'), join(root, 'infrastructure/database/MIGRATION_MANIFEST.json'));
  if (problems.length === 0) {
    console.log(
      `   ${PHASE3_PREFIX.length} accepted Phase 3 migrations intact from ${PHASE3_PREFIX_START} through ${PHASE3_PREFIX_END}; later migrations permitted`,
    );
  }
  return problems;
}

/**
 * A-07 — no authoritative Phase 3 document may still describe the accepted
 * state as open, and no acceptance or release page may carry an unfilled
 * placeholder. The RB-P2-02 check of `scripts/phase2-release-gate.ts`, for the
 * Phase 3 pages, and as narrow as its predecessor: specific claims, and a line
 * that marks itself historical is not a finding. The `HISTORICAL` pattern is
 * copied, because that module runs its gate at load and cannot be imported.
 */
export const PHASE3_AUTHORITATIVE_DOCS = [
  'PROJECT_STATUS.md',
  'TECHNICAL_DEBT.md',
  'docs/PHASE_3_SLICE_MAP.md',
  'docs/PHASE_3_S8_ACCEPTANCE.md',
  'docs/DAFTAR_OPEN_DECISIONS.md',
  // The page that describes this very check. A release page that exempts
  // itself from the rule it states is the first one to go stale.
  'docs/PHASE_3_S9_RELEASE.md',
] as const;

export const PHASE3_STALE_CLAIMS: readonly (readonly [RegExp, string])[] = [
  [/P3-S8[^\n|]{0,60}\b(in progress|candidate|not (yet )?frozen)\b/i, 'still calls P3-S8 open'],
  // The same claim in a status table, where the slice and its state sit in
  // different cells (PROJECT_STATUS.md carries it in that form).
  [/^\s*\|\s*\**\s*P3-S8\b[^\n]*\|\s*\**\s*(in progress|candidate|not (yet )?frozen)\b/i, 'still lists P3-S8 as open in a status table'],
  [/frozenThrough[^\n|]{0,20}=\s*`?0068/i, 'still states the pre-S8 boundary frozenThrough = 0068'],
  [/\b69 (migrations )?frozen\b/i, 'still states the pre-S8 count of 69 frozen migrations'],
  [/next (allowed )?step is P3-S8/i, 'still names P3-S8 as the next step'],
  [/OD-03[^\n|]{0,80}\b(closed|resolved|implemented)\b/i, 'describes OD-03 as settled'],
];

/** A line that says of itself that it is history is not a stale claim (the P2 pattern, verbatim). */
const HISTORICAL =
  /\b(superseded|withdrawn|historical|refuted|no longer|was\s+(?:blocked|a candidate)|at the time|originally|has since|used to|before\s+0052|corrected)\b/i;

/** Unfinished evidence. Never history, so `HISTORICAL` does not excuse it. */
const PLACEHOLDER = /\{\{[A-Z0-9_]+\}\}/;

const REQUIRED_TEXT: readonly (readonly [string, RegExp, string])[] = [
  ['PROJECT_STATUS.md', /OD-03[^\n]{0,60}\bOPEN\b/, 'does not name OD-03 as OPEN'],
  ['docs/PHASE_3_S9_RELEASE.md', /BLOCKED BY OD-03/, 'does not carry "BLOCKED BY OD-03"'],
  ['docs/PHASE_3_S9_RELEASE.md', /MAIN_PROTECTION_EXTERNAL_BLOCKER/, 'does not record MAIN_PROTECTION_EXTERNAL_BLOCKER'],
];

export function documentFindings(root: string): string[] {
  const problems: string[] = [];
  const acceptancePages = existsSync(join(root, 'docs'))
    ? readdirSync(join(root, 'docs'))
        .filter((f) => /^PHASE_3_S\d+_ACCEPTANCE\.md$/.test(f))
        .map((f) => `docs/${f}`)
    : [];
  const pages = [...new Set<string>([...PHASE3_AUTHORITATIVE_DOCS, ...acceptancePages])];
  for (const rel of pages) {
    const path = join(root, rel);
    if (!existsSync(path)) {
      problems.push(`${rel} is missing — it is an authoritative document`);
      continue;
    }
    const text = readFileSync(path, 'utf8');
    const authoritative = (PHASE3_AUTHORITATIVE_DOCS as readonly string[]).includes(rel);
    text.split('\n').forEach((line, i) => {
      if (PLACEHOLDER.test(line)) problems.push(`${rel}:${i + 1} carries an unfilled placeholder — "${line.trim().slice(0, 140)}"`);
      if (!authoritative || HISTORICAL.test(line)) return;
      for (const [pattern, why] of PHASE3_STALE_CLAIMS) {
        if (pattern.test(line)) problems.push(`${rel}:${i + 1} ${why} — "${line.trim().slice(0, 140)}"`);
      }
    });
    for (const [page, pattern, why] of REQUIRED_TEXT) {
      if (page === rel && !pattern.test(text)) problems.push(`${rel} ${why}`);
    }
  }
  if (problems.length === 0) console.log(`   ${pages.length} Phase 3 pages carry no stale acceptance claim and no placeholder`);
  return problems;
}

/** What the gate records about the database the composed suites will use. Recorded, never decided on. */
async function databaseEnvironment(root: string): Promise<Record<string, unknown>> {
  const port = Number(process.env['PG_PORT'] ?? 55432);
  const embeddedPkg = join(root, 'node_modules/embedded-postgres/package.json');
  const embeddedPostgres = existsSync(embeddedPkg) ? (JSON.parse(readFileSync(embeddedPkg, 'utf8')) as { version?: string }).version : null;
  const client = new Client({ host: 'localhost', port, user: 'postgres', password: 'postgres', database: 'postgres', connectionTimeoutMillis: 3000 });
  const serverAtStart = await client
    .connect()
    .then(() => client.query<{ server_version: string }>('SHOW server_version'))
    .then((res): Record<string, unknown> => ({ reachable: true, serverVersion: res.rows[0]?.server_version ?? null }))
    // Recorded, not swallowed: in an extracted-archive run no server is up
    // yet, and the harness starts the embedded one at PG_DIR on first use.
    .catch((e: unknown): Record<string, unknown> => ({ reachable: false, reason: e instanceof Error ? e.message : String(e) }));
  const closeError = await client.end().then(
    () => null,
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  );
  if (closeError !== null) serverAtStart['closeError'] = closeError;
  return { pgPort: port, pgDir: process.env['PG_DIR'] ?? null, serverAtStart, embeddedPostgres };
}

// ─────────────────────────────────────────────────────────────────────────
// The harness: the shape of `scripts/phase2-release-gate.ts`, copied because
// that module runs its gate at load and cannot be imported.
// ─────────────────────────────────────────────────────────────────────────

interface StepResult {
  readonly name: string;
  readonly command: string;
  readonly mandatory: boolean;
  status: 'pass' | 'fail' | 'skipped';
  exitCode: number | null;
  durationMs: number;
  log: string | null;
  summary: string | null;
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** The lines a human would quote from a log: verdicts and test counts. */
function summarise(text: string): string {
  const lines = text
    .replace(ANSI, '')
    .split('\n')
    .filter((l) => /\b(PASS|FAIL|Tests\s+\d+|Test Files\s+\d+|verdict|BLOCKED)\b/.test(l))
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.slice(-8).join(' | ').slice(0, 1200);
}

interface Options {
  readonly root: string;
  readonly list: boolean;
  readonly structuralOnly: boolean;
  readonly evidence: string;
  readonly logDir: string;
  readonly archiveSha256: string | null;
}

export function parseOptions(argv: readonly string[]): Options {
  const value = (name: string): string | undefined => {
    const eq = argv.find((a) => a.startsWith(`--${name}=`));
    if (eq !== undefined) return eq.slice(name.length + 3);
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const rootArg = value('root');
  const root = rootArg !== undefined ? resolve(rootArg) : join(__dirname, '..');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    root,
    list: argv.includes('--list'),
    structuralOnly: argv.includes('--structural-only'),
    evidence: resolve(value('evidence') ?? join(root, 'release', 'phase3-s9-release-gate.json')),
    logDir: resolve(value('log-dir') ?? join(root, 'release', `phase3-gate-logs-${stamp}`)),
    archiveSha256: value('archive-sha256') ?? null,
  };
}

type Step =
  | { readonly kind: 'command'; readonly name: string; readonly cmd: string; readonly args: readonly string[] }
  | { readonly kind: 'in-process'; readonly name: string; readonly structural: boolean; readonly fn: () => string[] };

/**
 * Step 0 — the library packages, built from source in dependency order.
 *
 * The root runner canary runs the root configuration's global setup and setup
 * files, which import the application, which imports the `@daftar/*` library
 * packages through their built entry points. On a clean runner or in an
 * extracted archive nothing is built yet, so the canary could not load and
 * the first release run at the exact SHA stopped there ("Failed to resolve
 * entry for package @daftar/domain-core"). The set is every workspace under
 * `packages/` with a `build` script, and the order is a topological sort of
 * their `@daftar/*` dependencies: the rule `scripts/phase1-release-gate.ts`
 * uses, copied because that module runs its gate at load. The Phase 1 release
 * gate inside step 5 deletes these outputs and rebuilds them again.
 */
export function libraryBuildOrder(root: string): { order: string[]; problems: string[] } {
  const base = join(root, 'packages');
  const packages = existsSync(base)
    ? readdirSync(base, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(base, entry.name, 'package.json')))
        .map((entry) => {
          const manifest = JSON.parse(readFileSync(join(base, entry.name, 'package.json'), 'utf8')) as {
            name?: string;
            scripts?: Record<string, string>;
            dependencies?: Record<string, string>;
            peerDependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
          };
          const deps = [
            ...Object.keys(manifest.dependencies ?? {}),
            ...Object.keys(manifest.peerDependencies ?? {}),
            ...Object.keys(manifest.devDependencies ?? {}),
          ].filter((dep) => dep.startsWith('@daftar/'));
          return { name: manifest.name ?? '', dir: `packages/${entry.name}`, build: typeof manifest.scripts?.['build'] === 'string', deps };
        })
        .filter((pkg) => pkg.name !== '' && pkg.build)
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const state = new Map<string, 'visiting' | 'built'>();
  const order: string[] = [];
  const problems: string[] = [];
  const visit = (name: string, trail: readonly string[]): void => {
    const pkg = byName.get(name);
    if (pkg === undefined) return;
    if (state.get(name) === 'built') return;
    if (state.get(name) === 'visiting') {
      problems.push(`the library packages depend on each other in a cycle: ${[...trail, name].join(' -> ')}`);
      return;
    }
    state.set(name, 'visiting');
    for (const dep of [...new Set(pkg.deps)].sort()) visit(dep, [...trail, name]);
    state.set(name, 'built');
    order.push(pkg.dir);
  };
  for (const pkg of packages) visit(pkg.name, []);
  if (order.length === 0) problems.push('no library package with a build script was found under packages/');
  return { order, problems };
}

function buildLibraryPackages(root: string): string[] {
  const { order, problems } = libraryBuildOrder(root);
  if (problems.length > 0) return problems;
  for (const dir of order) {
    const res = spawnSync(npm, ['run', 'build', '-w', dir], { cwd: root, encoding: 'utf8', env: process.env });
    if (res.status !== 0)
      return [`npm run build -w ${dir} exited ${res.status ?? `on ${res.signal ?? 'an error'}`}:\n${`${res.stdout ?? ''}${res.stderr ?? ''}`.slice(-2000)}`];
  }
  console.log(`   built ${order.join(', ')}`);
  return [];
}

/** §2: the plan, all mandatory, in order. */
export function releasePlan(o: Options): readonly Step[] {
  const phase2Evidence = join(o.logDir, 'phase2-release-gate.json');
  return [
    // The canary's setup imports the built library packages, so they are
    // built first; then the canary, and nothing below means anything without it.
    {
      kind: 'in-process',
      name: 'the library packages are built from source, in dependency order (the canary imports them)',
      structural: false,
      fn: () => buildLibraryPackages(o.root),
    },
    { kind: 'command', name: 'runner failure canaries, root and web (outside Vitest)', cmd: 'npx', args: ['tsx', 'scripts/runner-canary.ts'] },
    { kind: 'in-process', name: 'tree identity; a delivery manifest, if present, says phase 3', structural: true, fn: () => treeIsAPhase3Candidate(o.root) },
    {
      kind: 'in-process',
      name: `Phase 3 migration prefix ${PHASE3_PREFIX_START.slice(0, 4)}–${PHASE3_PREFIX_END.slice(0, 4)} intact; later migrations permitted`,
      structural: true,
      fn: () => phase3PrefixIntact(o.root),
    },
    { kind: 'in-process', name: 'no authoritative Phase 3 document contradicts the accepted state', structural: true, fn: () => documentFindings(o.root) },
    // The predecessor release gate, verbatim: its canary, its tree checks, the
    // Phase 2 prefix, the Phase 1 release gate, the P2-S8 chain, the
    // deployment matrix and the supply chain.
    {
      kind: 'command',
      name: 'Phase 2 release gate (composes the Phase 1 release gate)',
      cmd: npm,
      args: [
        'run',
        '-s',
        'gate:phase2:release',
        '--',
        `--evidence=${phase2Evidence}`,
        `--log-dir=${join(o.logDir, 'phase2')}`,
        ...(o.archiveSha256 !== null ? [`--archive-sha256=${o.archiveSha256}`] : []),
      ],
    },
    // A new composition boundary: the Phase 1 release gate inside step 5 ends
    // by building the API, and the machine gate the P3-S8 chain (inside the
    // corrective gate) composes refuses a source tree that carries a build output.
    {
      kind: 'in-process',
      name: 'the source tree is a source tree again (the API build output is removed)',
      structural: false,
      fn: () => {
        rmSync(join(o.root, 'apps/api/dist'), { recursive: true, force: true });
        return existsSync(join(o.root, 'apps/api/dist')) ? ['apps/api/dist is still present after being removed'] : [];
      },
    },
    // Directive §19: the corrective gate replaces the P3-S8 gate here and
    // composes it first, so nothing the P3-S8 chain proved is dropped.
    {
      kind: 'command',
      name: 'Phase 3 corrective gate (composes P3-S8 → S7…S1, P2-S8…S1 and Phase 1; the corrected blockers; the real-browser matrix)',
      cmd: npm,
      args: ['run', '-s', 'gate:phase3:corrective'],
    },
    {
      kind: 'command',
      name: 'the deployed-database rehearsal (the business, on the database daftar_migrator built)',
      cmd: npm,
      args: ['run', '-s', 'rehearse:phase3:deployed'],
    },
  ];
}

/** The nested Phase 2 artefact, read back so the evidence need not find the log directory. */
function nestedPhase2(o: Options): Record<string, unknown> {
  const path = join(o.logDir, 'phase2-release-gate.json');
  if (!existsSync(path)) return { path, present: false };
  const a = JSON.parse(readFileSync(path, 'utf8')) as {
    verdict?: unknown;
    mandatorySkipped?: unknown;
    summary?: unknown;
    tree?: { kind?: unknown; deliveryManifest?: { treeHash?: unknown; sourceCommit?: unknown } | null };
  };
  return {
    path,
    present: true,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    verdict: a.verdict ?? null,
    mandatorySkipped: a.mandatorySkipped ?? null,
    summary: a.summary ?? null,
    tree: { kind: a.tree?.kind ?? null, treeHash: a.tree?.deliveryManifest?.treeHash ?? null, sourceCommit: a.tree?.deliveryManifest?.sourceCommit ?? null },
  };
}

async function main(): Promise<void> {
  const o = parseOptions(process.argv.slice(2));
  const results: StepResult[] = [];
  const rel = (p: string): string => p.replace(`${o.root}/`, '');

  console.log(`PHASE 3 RELEASE GATE — P3-S9 closure${o.structuralOnly ? ' (structural checks only)' : ''}\n`);

  const mandatorySkips = Object.keys(process.env).filter((k) => k.startsWith('RELEASE_GATE_SKIP_'));
  if (mandatorySkips.length > 0 && !o.list) {
    console.error(`REFUSED: a release verdict may not be produced with ${mandatorySkips.join(', ')} set.`);
    mkdirSync(dirname(o.evidence), { recursive: true });
    writeFileSync(
      o.evidence,
      `${JSON.stringify({ verdict: 'FAIL', mandatorySkipped: mandatorySkips.length, mandatorySkips, steps: [], producedAt: new Date().toISOString() }, null, 2)}\n`,
    );
    process.exit(1);
  }
  if (!o.list && !o.structuralOnly) mkdirSync(o.logDir, { recursive: true });

  const identity = treeIdentity(o.root, o.archiveSha256);
  console.log(`tree: ${String(identity['kind'])}\n`);
  const database = o.list || o.structuralOnly ? null : await databaseEnvironment(o.root);

  const runCommand = (name: string, cmd: string, args: readonly string[]): boolean => {
    const command = [cmd, ...args].join(' ');
    console.log(`\n── ${name}\n   ${command}`);
    const started = Date.now();
    const res = spawnSync(cmd, [...args], { cwd: o.root, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' }, maxBuffer: 256 * 1024 * 1024 });
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    const durationMs = Date.now() - started;
    const logFile = join(o.logDir, `${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.log`);
    writeFileSync(logFile, output);
    const ok = res.status === 0;
    results.push({
      name,
      command,
      mandatory: true,
      status: ok ? 'pass' : 'fail',
      exitCode: res.status,
      durationMs,
      log: rel(logFile),
      summary: summarise(output),
    });
    console.log(`   ${ok ? 'PASS' : 'FAIL'} in ${(durationMs / 1000).toFixed(1)}s${ok ? '' : `\n${output.slice(-6000)}`}`);
    return ok;
  };

  const runInProcess = (name: string, fn: () => string[]): boolean => {
    console.log(`\n── ${name}`);
    const started = Date.now();
    let problems: string[];
    try {
      problems = fn();
    } catch (e) {
      problems = [e instanceof Error ? e.message : String(e)];
    }
    const ok = problems.length === 0;
    results.push({
      name,
      command: '(in process)',
      mandatory: true,
      status: ok ? 'pass' : 'fail',
      exitCode: ok ? 0 : 1,
      durationMs: Date.now() - started,
      log: null,
      summary: ok ? 'ok' : problems.join(' | ').slice(0, 1200),
    });
    console.log(`   ${ok ? 'PASS' : `FAIL\n     ${problems.join('\n     ')}`}`);
    return ok;
  };

  const plan = releasePlan(o).filter((s) => !o.structuralOnly || (s.kind === 'in-process' && s.structural));
  let failed = false;
  for (const step of plan) {
    if (o.list) {
      const command = step.kind === 'command' ? [step.cmd, ...step.args].join(' ') : '(in process)';
      console.log(`  [mandatory] ${step.name} — ${command}`);
      results.push({ name: step.name, command, mandatory: true, status: 'skipped', exitCode: null, durationMs: 0, log: null, summary: null });
      continue;
    }
    const ok = step.kind === 'command' ? runCommand(step.name, step.cmd, step.args) : runInProcess(step.name, step.fn);
    if (!ok) {
      failed = true;
      break; // stop at the first failure: a release verdict is not a survey
    }
  }

  const failures = results.filter((r) => r.status === 'fail');
  const clean = failures.length === 0 && !failed;
  const verdict = o.list ? 'LISTED' : o.structuralOnly ? (clean ? 'STRUCTURAL_PASS' : 'FAIL') : clean ? 'PASS' : 'FAIL';
  const artefact = {
    produced: 'scripts/phase3-release-gate.ts',
    producedAt: new Date().toISOString(),
    phase: 3,
    slice: 'P3-S9',
    structuralOnly: o.structuralOnly,
    tree: identity,
    environment: {
      node: process.version,
      npm: (spawnSync(npm, ['--version'], { encoding: 'utf8' }).stdout ?? '').trim(),
      platform: `${platform()}-${arch()}`,
      osRelease: osRelease(),
      database,
    },
    mandatorySkipped: mandatorySkips.length,
    mandatorySkips,
    steps: results,
    nested: o.list || o.structuralOnly ? null : { 'gate:phase2:release': nestedPhase2(o) },
    summary: {
      total: results.length,
      pass: results.filter((r) => r.status === 'pass').length,
      fail: failures.length,
      skipped: results.filter((r) => r.status === 'skipped').length,
    },
    verdict,
  };
  mkdirSync(dirname(o.evidence), { recursive: true });
  writeFileSync(o.evidence, `${JSON.stringify(artefact, null, 2)}\n`);

  if (o.list) {
    console.log(`\n${results.length} steps planned. Nothing was run.`);
    return;
  }
  console.log(`\nPHASE 3 RELEASE GATE: ${verdict}`);
  console.log(`  ${artefact.summary.pass} pass, ${artefact.summary.fail} fail, ${artefact.mandatorySkipped} mandatory skipped`);
  console.log(`  evidence: ${rel(o.evidence)}`);
  if (!o.structuralOnly) console.log(`  logs:     ${rel(o.logDir)}`);
  if (verdict !== 'PASS' && verdict !== 'STRUCTURAL_PASS') process.exit(1);
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.stack : e);
    process.exit(1);
  });
}
