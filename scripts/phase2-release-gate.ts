#!/usr/bin/env tsx
/**
 * ─────────────────────────────────────────────────────────────────────────
 * PHASE 2 RELEASE GATE — `npm run gate:phase2:release`
 * ─────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT IS
 *
 * The one command that decides whether the Phase 2 release candidate may be
 * handed to a Tech Lead. It COMPOSES what already exists rather than
 * restating it: the Phase 1 release gate, the permanent P2-S8 gate (which
 * composes P2-S7 … P2-S1 and the Phase 1 machine gate in turn), the
 * deployment-authority matrix, and the closure checks that belong to P2-S9
 * itself. There is no monolith here and no second copy of any assertion: if a
 * claim is already proved somewhere, this file runs that thing and records
 * what it answered.
 *
 * IT MUST RUN FROM AN EXTRACTED ARCHIVE
 *
 * Nothing below shells out to `git`, reads `.git`, or consults an untracked
 * file. The tree's identity comes from `DELIVERY_MANIFEST.json` when one is
 * present — which is how an extracted release candidate says what it is — and
 * from nothing at all when one is not. A gate that can only run where its
 * author ran it has not proved that the archive is the product.
 *
 * MANDATORY CHECKS CANNOT BE SKIPPED
 *
 * Any `RELEASE_GATE_SKIP_*` in the environment fails the gate before it runs
 * anything, and the evidence it writes records `mandatorySkipped`. A release
 * verdict with a skip in it is not a release verdict.
 *
 * THE RUNNER CANARY RUNS FIRST
 *
 * Before a single test result is believed, `scripts/runner-canary.ts` proves
 * — outside Vitest, in its own process — that a failing test can still make
 * this repository's runner exit non-zero. DAFTAR has shipped a runner that
 * exited 0 over four failing tests; every green number below is worth exactly
 * what that proof is worth.
 *
 * Usage:
 *   npm run gate:phase2:release [-- --evidence=<file.json>] [--log-dir=<dir>]
 *                               [--archive-sha256=<hex>] [--list]
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { arch, platform, release as osRelease } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const args = new Map(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=') as [string, string | undefined]));
const LIST_ONLY = args.has('list');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const LOG_DIR = args.get('log-dir') ?? join(ROOT, 'release', `phase2-gate-logs-${stamp}`);
const EVIDENCE = args.get('evidence') ?? join(ROOT, 'release', 'phase2-s9-release-gate.json');
const ARCHIVE_SHA256 = args.get('archive-sha256') ?? null;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

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

const results: StepResult[] = [];

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

function runStep(name: string, cmd: string, cmdArgs: string[], mandatory = true): boolean {
  const command = [cmd, ...cmdArgs].join(' ');
  if (LIST_ONLY) {
    console.log(`  ${mandatory ? '[mandatory]' : '[advisory] '} ${name} — ${command}`);
    results.push({ name, command, mandatory, status: 'skipped', exitCode: null, durationMs: 0, log: null, summary: null });
    return true;
  }
  console.log(`\n── ${name}\n   ${command}`);
  const started = Date.now();
  const res = spawnSync(cmd, cmdArgs, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' }, maxBuffer: 256 * 1024 * 1024 });
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const durationMs = Date.now() - started;
  const logFile = join(LOG_DIR, `${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.log`);
  writeFileSync(logFile, output);
  const ok = res.status === 0;
  results.push({
    name,
    command,
    mandatory,
    status: ok ? 'pass' : 'fail',
    exitCode: res.status,
    durationMs,
    log: logFile.replace(`${ROOT}/`, ''),
    summary: summarise(output),
  });
  console.log(`   ${ok ? 'PASS' : 'FAIL'} in ${(durationMs / 1000).toFixed(1)}s${ok ? '' : `\n${output.slice(-6000)}`}`);
  return ok;
}

/** A check this file performs itself, because there is nothing else to run. */
function inProcess(name: string, fn: () => string[]): boolean {
  if (LIST_ONLY) {
    console.log(`  [mandatory] ${name} — (in process)`);
    results.push({ name, command: '(in process)', mandatory: true, status: 'skipped', exitCode: null, durationMs: 0, log: null, summary: null });
    return true;
  }
  console.log(`\n── ${name}`);
  const started = Date.now();
  let problems: string[] = [];
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
}

// ─────────────────────────────────────────────────────────────────────────
// The closure checks this gate owns
// ─────────────────────────────────────────────────────────────────────────

const MIGRATIONS_DIR = join(ROOT, 'infrastructure/database/migrations');
const FROZEN_THROUGH_AT_LEAST = '0052_accounting_journal_lines_rls_performance.sql';

function frozenHistoryIntact(): string[] {
  const problems: string[] = [];
  const manifest = JSON.parse(readFileSync(join(ROOT, 'infrastructure/database/MIGRATION_MANIFEST.json'), 'utf8')) as {
    frozenThrough: string;
    migrations: { name: string; sha256: string }[];
  };
  if (manifest.frozenThrough < FROZEN_THROUGH_AT_LEAST) {
    problems.push(`frozenThrough is ${manifest.frozenThrough}; P2-S8 was accepted and frozen, so it must be at least ${FROZEN_THROUGH_AT_LEAST}`);
  }
  for (const m of manifest.migrations) {
    const path = join(MIGRATIONS_DIR, m.name);
    if (!existsSync(path)) {
      problems.push(`${m.name} is recorded frozen but missing`);
      continue;
    }
    const onDisk = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (onDisk !== m.sha256) problems.push(`${m.name} hashes to ${onDisk.slice(0, 12)}… but was frozen at ${m.sha256.slice(0, 12)}…`);
  }
  const onDisk = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  const unfrozen = onDisk.filter((f) => f <= manifest.frozenThrough && !manifest.migrations.some((m) => m.name === f));
  for (const f of unfrozen) problems.push(`${f} predates frozenThrough but is not in the manifest`);
  if (problems.length === 0) console.log(`   ${manifest.migrations.length} frozen migrations verified through ${manifest.frozenThrough}`);
  return problems;
}

/**
 * P2-S9 adds no migration. This is P2-S9's OWN hard stop, and it lives here
 * rather than in the P2-S8 gate, which is permanent and must never forbid an
 * authorized successor.
 */
function phase2s9AddsNoMigration(): string[] {
  const beyond = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && f > FROZEN_THROUGH_AT_LEAST)
    .sort();
  return beyond.length === 0 ? [] : [`P2-S9 is release closure and creates no migration, but ${beyond.join(', ')} exists`];
}

/**
 * RB-P2-02 — no authoritative document at the release head may still describe
 * the slice that was accepted as an open, blocked or unfrozen candidate.
 *
 * The check is deliberately narrow: it looks for the specific stale CLAIMS
 * that were actually found, not for any sentence containing the word
 * "candidate". A historical narrative is legitimate and common in these
 * pages, so a line is only a finding when it is NOT marked as superseded,
 * withdrawn or historical.
 */
const AUTHORITATIVE_DOCS = [
  'docs/PHASE_2_ACCOUNTING_EXECUTION_PLAN.md',
  'docs/PHASE_2_ARCHITECTURE_LOCK.md',
  'docs/PHASE_2_S8_ACCEPTANCE.md',
  'docs/PHASE_2_PERFORMANCE_BASELINE.md',
  'TECHNICAL_DEBT.md',
  // The page that describes this very check. A release document that exempts
  // itself from the consistency rule it states is the first one to go stale,
  // and describing a forbidden claim is not licence to write one: §4 of that
  // page names each claim without making it.
  'docs/PHASE_2_S9_RELEASE.md',
];

const STALE_CLAIMS: [RegExp, string][] = [
  [/P2-S8[^\n|]{0,40}(CANDIDATE\s*—\s*BLOCKED|BLOCKED)/i, 'still calls P2-S8 blocked'],
  [/frozenThrough[^\n|]{0,20}=\s*`?0050/i, 'still states frozenThrough = 0050'],
  [/no\s+`?0052`?\b/i, 'still says 0052 does not exist'],
  [/\b005[12]\b[^\n|]{0,80}\b(is a |are )?candidates?\b(?![^\n|]{0,60}(until|accepted|frozen))/i, 'still calls 0051/0052 a candidate'],
  [/not frozen, not in the manifest/i, 'still says the slice migrations are not in the manifest'],
  [/budget\s+C[^\n|]{0,80}(miss|fail|over)/i, 'still reports budget C as failing'],
];

/** A line that says of itself that it is history is not a stale claim. */
const HISTORICAL =
  /\b(superseded|withdrawn|historical|refuted|no longer|was\s+(?:blocked|a candidate)|at the time|originally|has since|used to|before\s+0052|corrected)\b/i;

function documentsAgreeWithReality(): string[] {
  const problems: string[] = [];
  for (const rel of AUTHORITATIVE_DOCS) {
    const path = join(ROOT, rel);
    if (!existsSync(path)) {
      problems.push(`${rel} is missing — it is an authoritative document`);
      continue;
    }
    const lines = readFileSync(path, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (HISTORICAL.test(line)) return;
      for (const [pattern, why] of STALE_CLAIMS) {
        if (pattern.test(line)) problems.push(`${rel}:${i + 1} ${why} — "${line.trim().slice(0, 140)}"`);
      }
    });
  }
  if (problems.length === 0) console.log(`   ${AUTHORITATIVE_DOCS.length} authoritative documents carry no stale acceptance claim`);
  return problems;
}

/**
 * The identity of the tree being gated. In a git checkout there is no
 * DELIVERY_MANIFEST.json and this is empty, which is correct and says so. In
 * an extracted release candidate the manifest IS the source identity, which
 * is the whole point of §28: the gate must not need the repository it came
 * from in order to say what it just gated.
 */
function treeIdentity(): Record<string, unknown> {
  const manifestPath = join(ROOT, 'DELIVERY_MANIFEST.json');
  if (!existsSync(manifestPath)) return { kind: 'source-checkout', deliveryManifest: null, archiveSha256: ARCHIVE_SHA256 };
  const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  return {
    kind: 'extracted-archive',
    archiveSha256: ARCHIVE_SHA256,
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

/** An extracted archive must match the inventory it carries, file for file. */
function archiveMatchesItsManifest(): string[] {
  const manifestPath = join(ROOT, 'DELIVERY_MANIFEST.json');
  if (!existsSync(manifestPath)) {
    console.log('   (a source checkout carries no delivery manifest — nothing to compare)');
    return [];
  }
  const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as { inventory: { path: string; sha256: string }[]; treeHash: string };
  const problems: string[] = [];
  for (const entry of m.inventory) {
    const path = join(ROOT, entry.path);
    if (!existsSync(path)) {
      problems.push(`${entry.path} is in the inventory but not in the archive`);
      continue;
    }
    const onDisk = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (onDisk !== entry.sha256) problems.push(`${entry.path} does not hash to what the inventory recorded`);
  }
  const recomputed = createHash('sha256')
    .update(m.inventory.map((i) => `${i.path}:${i.sha256}`).join('\n'))
    .digest('hex');
  if (recomputed !== m.treeHash) problems.push(`the tree hash recomputed from the inventory is ${recomputed.slice(0, 12)}…, not ${m.treeHash.slice(0, 12)}…`);
  if (problems.length === 0) console.log(`   ${m.inventory.length} files match the delivery inventory; tree hash ${m.treeHash.slice(0, 16)}…`);
  return problems;
}

/**
 * The tree must carry no working tree and no credential.
 *
 * Note what is NOT checked here, and why. `node_modules`, `.next`, `dist`,
 * `coverage` and `.gradle` are all ABSENT from the archive and all PRESENT
 * by the time this gate runs, in a checkout and in an extracted archive
 * alike, because the gate's own first instruction to a reader is `npm ci`
 * and its later steps build three applications. Refusing them here would
 * mean refusing every tree this gate is ever run in. What the ARCHIVE
 * contains is settled where it can be settled — `scripts/export-release.ts`
 * refuses to put any of them in, and compares the zip's entry count against
 * its own inventory — and what is checked HERE is the set that must not
 * appear at any point in either tree: a git working tree, an environment
 * file, a private key, a database dump.
 */
const FORBIDDEN_IN_ANY_TREE = /(^|\/)\.git(\/|$)|(^|\/)\.env($|\.)|\.(pem|key|dump)$|\.sql\.gz$/i;
const NOT_WORTH_WALKING = new Set(['node_modules', '.next', 'dist', 'build', 'coverage', '.gradle', 'var', '.pgdata', 'release']);

function treeCarriesNoWorkingTreeOrCredential(): string[] {
  // A source checkout HAS a `.git`, and must: that is what it is. The claim
  // this check makes is about the release candidate, so in a checkout it
  // says so and stands down rather than inventing a refusal nobody wants.
  if (!existsSync(join(ROOT, 'DELIVERY_MANIFEST.json'))) {
    console.log('   (a source checkout legitimately has a .git — the archive is where this is settled)');
    return [];
  }
  const problems: string[] = [];
  const walk = (dir: string, rel = ''): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const here = rel === '' ? e.name : `${rel}/${e.name}`;
      if (FORBIDDEN_IN_ANY_TREE.test(here)) {
        problems.push(`the gated tree contains ${here}`);
        continue;
      }
      if (NOT_WORTH_WALKING.has(e.name)) continue;
      if (e.isDirectory()) walk(join(dir, e.name), here);
    }
  };
  walk(ROOT);
  if (problems.length === 0) console.log('   no git working tree, environment file, private key or database dump in the gated tree');
  return problems;
}

// ─────────────────────────────────────────────────────────────────────────

const mandatorySkips = Object.keys(process.env).filter((k) => k.startsWith('RELEASE_GATE_SKIP_'));

function main(): void {
  console.log('PHASE 2 RELEASE GATE — P2-S9 closure\n');
  if (!LIST_ONLY) mkdirSync(LOG_DIR, { recursive: true });

  if (mandatorySkips.length > 0 && !LIST_ONLY) {
    console.error(`REFUSED: a release verdict may not be produced with ${mandatorySkips.join(', ')} set.`);
    writeFileSync(
      EVIDENCE,
      `${JSON.stringify({ verdict: 'FAIL', mandatorySkipped: mandatorySkips.length, mandatorySkips, steps: [], producedAt: new Date().toISOString() }, null, 2)}\n`,
    );
    process.exit(1);
  }

  const identity = treeIdentity();
  console.log(`tree: ${String(identity['kind'])}\n`);

  const plan: (() => boolean)[] = [
    // The canary comes first, and nothing below means anything without it.
    () => runStep('runner failure canary (outside Vitest)', 'npx', ['tsx', 'scripts/runner-canary.ts']),

    // What the tree IS, before anything is run inside it.
    () => inProcess('the gated tree carries no git working tree and no credential', treeCarriesNoWorkingTreeOrCredential),
    () => inProcess('the archive matches the inventory it carries', archiveMatchesItsManifest),
    () => inProcess('frozen history 0000–0052 byte-for-byte', frozenHistoryIntact),
    () => inProcess('P2-S9 creates no migration', phase2s9AddsNoMigration),
    () => inProcess('no authoritative document contradicts the accepted state (RB-P2-02)', documentsAgreeWithReality),

    // Everything the Phase 1 release gate already proves: toolchain, manifest,
    // db-from-zero, guards, localization, format, lint, typecheck, unit,
    // integration + security + DB contract + upgrade matrix, golden
    // regression, API/web/admin builds, Android lint/unit/assemble, audit,
    // artefact scan, secret scan, docs.
    () =>
      runStep('Phase 1 release gate (the whole release command matrix)', npm, [
        'run',
        '-s',
        'gate:phase1:release',
        '--',
        `--log-dir=${join(LOG_DIR, 'phase1')}`,
      ]),

    // PUT THE TREE BACK THE WAY THE STEP ABOVE FOUND IT.
    //
    // The Phase 1 release gate ends by building the API, which leaves
    // `apps/api/dist` in the tree. The Phase 1 MACHINE gate — which the P2-S8
    // gate composes through every predecessor — refuses a source tree that
    // carries a build output, by name. Both are right: a source tree should
    // not carry one, and a release gate that never built the API would be
    // proving nothing. What is wrong is asking the second question without
    // restoring the state the first one was asked in.
    //
    // CI never saw this, because it runs the two in separate jobs on separate
    // checkouts. Composing them in ONE tree is what made it visible, and it
    // is the composer's to fix: nothing after this point reads the API build,
    // and the archive export carries no build output either.
    () =>
      inProcess('the source tree is a source tree again (the API build output is removed)', () => {
        rmSync(join(ROOT, 'apps/api/dist'), { recursive: true, force: true });
        return existsSync(join(ROOT, 'apps/api/dist')) ? ['apps/api/dist is still present after being removed'] : [];
      }),

    // The Phase 2 slice gates, composed: P2-S8 runs P2-S7 … P2-S1 and the
    // Phase 1 machine gate in turn, and adds the Tier 1 budgets, failure
    // injection, the reconciliation authority and the RLS contract.
    () => runStep('Phase 2 slice gate — P2-S8 (composes S7…S1 and Phase 1)', npm, ['run', '-s', 'gate:phase2:s8']),

    // The release blocker P2-S9 exists to close.
    () => runStep('deployment authority — the six-case matrix as the production principal', npm, ['run', '-s', 'check:deployment-authority']),

    // Supply-chain hygiene, stated again here because it is a release
    // property rather than a slice property.
    () => runStep('supply-chain hygiene', npm, ['run', '-s', 'check:supply-chain']),
  ];

  let failed = false;
  for (const step of plan) {
    if (!step()) {
      failed = true;
      break; // stop at the first failure: a release verdict is not a survey
    }
  }

  const failures = results.filter((r) => r.status === 'fail');
  const artefact = {
    produced: 'scripts/phase2-release-gate.ts',
    producedAt: new Date().toISOString(),
    phase: 2,
    slice: 'P2-S9',
    tree: identity,
    environment: {
      node: process.version,
      npm: (spawnSync(npm, ['--version'], { encoding: 'utf8' }).stdout ?? '').trim(),
      platform: `${platform()}-${arch()}`,
      osRelease: osRelease(),
    },
    mandatorySkipped: mandatorySkips.length,
    mandatorySkips,
    steps: results,
    summary: {
      total: results.length,
      pass: results.filter((r) => r.status === 'pass').length,
      fail: failures.length,
      skipped: results.filter((r) => r.status === 'skipped').length,
    },
    verdict: LIST_ONLY ? 'LISTED' : failures.length === 0 && !failed ? 'PASS' : 'FAIL',
  };
  mkdirSync(join(ROOT, 'release'), { recursive: true });
  writeFileSync(EVIDENCE, `${JSON.stringify(artefact, null, 2)}\n`);

  if (LIST_ONLY) {
    console.log(`\n${results.length} steps planned. Nothing was run.`);
    return;
  }
  console.log(`\nPHASE 2 RELEASE GATE: ${artefact.verdict}`);
  console.log(`  ${artefact.summary.pass} pass, ${artefact.summary.fail} fail, ${artefact.mandatorySkipped} mandatory skipped`);
  console.log(`  evidence: ${EVIDENCE.replace(`${ROOT}/`, '')}`);
  console.log(`  logs:     ${LOG_DIR.replace(`${ROOT}/`, '')}`);
  if (artefact.verdict !== 'PASS') process.exit(1);
}

main();
