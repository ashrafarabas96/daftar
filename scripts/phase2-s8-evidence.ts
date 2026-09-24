#!/usr/bin/env tsx
/**
 * THE P2-S8 EVIDENCE FILE (f §50).
 *
 * `release/phase2-s8-evidence.json` is the machine-readable answer to "what
 * was actually checked, and what did each check say". It exists because a
 * handoff written in prose can be read generously, and a reviewer who has to
 * decide whether to accept a slice needs something that cannot be.
 *
 * TWO RULES SHAPE THIS FILE.
 *
 * The first is f §50: a MANDATORY check recorded as SKIPPED is not evidence,
 * and the count of them must be zero. So a check here carries one of PASS,
 * FAIL or SKIPPED, and the P2-S8 gate refuses to pass while any mandatory one
 * is SKIPPED. There is no fourth status meaning "we did not get to it".
 *
 * The second is f §3, and it is the reason this script does almost nothing
 * clever: it does NOT decide any verdict itself. Every status below is read
 * from an artefact some other process produced — a gate's exit status, a
 * rehearsal's JSON, a measurement file, a `git` observation. A script that
 * graded its own homework would be exactly the kind of green that proves
 * nothing.
 *
 * Usage: npm run evidence:phase2:s8
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(ROOT, 'infrastructure/database/migrations');

type Status = 'PASS' | 'FAIL' | 'SKIPPED';

interface Check {
  readonly id: string;
  readonly name: string;
  readonly mandatory: boolean;
  readonly status: Status;
  /** Where the status came from. Never "because this script said so". */
  readonly evidence: string;
}

const checks: Check[] = [];
const add = (id: string, name: string, mandatory: boolean, status: Status, evidence: string): void => {
  checks.push({ id, name, mandatory, status, evidence });
};

const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const readIfPresent = (path: string): string | null => (existsSync(join(ROOT, path)) ? read(path) : null);
const sha256 = (path: string): string =>
  createHash('sha256')
    .update(readFileSync(join(ROOT, path)))
    .digest('hex');
const git = (...args: string[]): string => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }).stdout.trim();

/** A JSON artefact another process wrote, or null when it was never produced. */
function artefact<T>(path: string): T | null {
  const raw = readIfPresent(path);
  return raw === null ? null : (JSON.parse(raw) as T);
}

// ── the migration boundary ─────────────────────────────────────────────────
const manifest = JSON.parse(read('infrastructure/database/MIGRATION_MANIFEST.json')) as {
  frozenThrough: string;
  migrations: { name: string; sha256: string }[];
};
const migrations = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const CANDIDATE = '0051_accounting_reconciler_read.sql';
/**
 * The second candidate, authorized on 2026-09-24 once the performance evidence
 * had been re-measured at acceptance scale and the first diagnosis refuted.
 * It was corrected IN PLACE through review rather than superseded by a 0053:
 * a candidate is not history, and answering a correction with a new number
 * makes the reviewer read two files to learn one thing.
 */
const RLS_CANDIDATE = '0052_accounting_journal_lines_rls_performance.sql';
const CANDIDATES = [CANDIDATE, RLS_CANDIDATE] as const;

add(
  'BOUNDARY-01',
  'frozenThrough is unmoved at 0050 — P2-S8 froze nothing (g §44)',
  true,
  manifest.frozenThrough === '0050_accounting_report_indexes.sql' ? 'PASS' : 'FAIL',
  `MIGRATION_MANIFEST.json frozenThrough = ${manifest.frozenThrough}`,
);
add(
  'BOUNDARY-02',
  '0051 and 0052 exist on disk and are absent from the manifest — candidates, not frozen (g §2)',
  true,
  CANDIDATES.every((c) => migrations.includes(c) && !manifest.migrations.some((m) => m.name === c)) ? 'PASS' : 'FAIL',
  CANDIDATES.map((c) => `${c} SHA-256 ${migrations.includes(c) ? sha256(`infrastructure/database/migrations/${c}`) : '(absent)'}`).join('; '),
);
add(
  'BOUNDARY-03',
  'no 0053 and nothing beyond it (g §44)',
  true,
  migrations.filter((f) => f > RLS_CANDIDATE).length === 0 ? 'PASS' : 'FAIL',
  `highest migration on disk: ${migrations[migrations.length - 1] ?? '(none)'}`,
);
{
  const drifted = manifest.migrations.filter(
    (m) => !existsSync(join(MIGRATIONS_DIR, m.name)) || sha256(`infrastructure/database/migrations/${m.name}`) !== m.sha256,
  );
  add(
    'BOUNDARY-04',
    '0000–0050 byte-for-byte immutable (g §37)',
    true,
    drifted.length === 0 ? 'PASS' : 'FAIL',
    drifted.length === 0
      ? `all ${manifest.migrations.length} frozen migrations hash to their recorded digests`
      : `drifted: ${drifted.map((d) => d.name).join(', ')}`,
  );
}

// ── the artefacts other processes produced ─────────────────────────────────
interface RehearsalEvidence {
  readonly verdict?: string;
  readonly findings?: string[];
  readonly steps?: { step: string; ok: boolean; detail: string }[];
}
const rehearsal = artefact<RehearsalEvidence>('release/phase2-s8-rollback-rehearsal.json');
add(
  'ROLLBACK-01',
  'a real backup, a real restore, the Phase 2 migrations applied to the restored copy, and the ACCEPTED Phase 1 build run against the upgraded database (f §39–§42)',
  true,
  rehearsal === null ? 'SKIPPED' : rehearsal.verdict === 'PASS' ? 'PASS' : 'FAIL',
  rehearsal === null
    ? 'release/phase2-s8-rollback-rehearsal.json was never produced — run `npm run rehearse:phase2:rollback`'
    : `${(rehearsal.steps ?? []).length} steps, ${(rehearsal.findings ?? []).length} findings, verdict ${String(rehearsal.verdict)}`,
);

interface PerfEvidence {
  readonly tier?: number;
  readonly executedIn?: string;
  readonly measurements?: { name: string; budgetMs: number; iterations: number; p95: number }[];
  readonly budgets?: Record<string, number>;
}
for (const tier of [1, 2] as const) {
  const perf = artefact<PerfEvidence>(`release/phase2-s8-performance-tier${tier}.json`);
  const mandatory = tier === 1;
  if (perf === null) {
    add(
      `PERF-TIER${tier}`,
      `the six budgets at tier ${tier} (f §34, §35)`,
      mandatory,
      'SKIPPED',
      `release/phase2-s8-performance-tier${tier}.json was never produced — run \`P2S8_PERF_TIER=${tier} npx vitest run tests/performance/accounting-budgets.test.ts\``,
    );
    continue;
  }
  const measured = perf.measurements ?? [];
  const missed = measured.filter((m) => m.p95 > m.budgetMs);
  // A budget with no measurement is NOT a budget that was met. f §50's rule
  // about skipped checks applies inside this one too: six budgets are named,
  // and a file carrying two of them is a partial run, not a pass.
  const expected = Object.keys(perf.budgets ?? {}).length;
  const incomplete = expected === 0 || measured.length < expected;
  add(
    `PERF-TIER${tier}`,
    `the six budgets at tier ${tier} (f §34, §35)`,
    mandatory,
    incomplete ? 'SKIPPED' : missed.length === 0 ? 'PASS' : 'FAIL',
    incomplete
      ? `only ${measured.length} of ${expected || 6} budgets were measured — a partial run is not evidence; re-run the tier ${tier} suite to completion`
      : `${measured.length} measurements, run ${String(perf.executedIn)}; ${
          missed.length === 0
            ? `all within budget (worst margin: ${measured.map((m) => `${m.name} ${m.p95.toFixed(1)}/${m.budgetMs}ms`).join(', ')})`
            : `over budget: ${missed.map((m) => `${m.name} p95 ${m.p95.toFixed(1)}ms > ${m.budgetMs}ms`).join('; ')}`
        }`,
  );
}

// ── the checks whose evidence is a command's exit status ───────────────────
//
// Each of these RUNS the thing and records what it answered. Nothing here
// interprets: a non-zero exit is FAIL, whatever this script thinks of it.
const COMMANDS: { id: string; name: string; mandatory: boolean; argv: [string, string[]] }[] = [
  {
    id: 'GATE-S8',
    name: 'the P2-S8 gate, including the outside-Vitest failure canary and every composed predecessor gate (f §3, g §38–§40)',
    mandatory: true,
    argv: ['npm', ['run', 'gate:phase2:s8']],
  },
  { id: 'SUPPLY-01', name: 'supply-chain hygiene (f §47)', mandatory: true, argv: ['npm', ['run', 'check:supply-chain']] },
];
const RUN_COMMANDS = process.argv.slice(2).includes('--run-commands');
for (const c of COMMANDS) {
  if (!RUN_COMMANDS) {
    add(c.id, c.name, c.mandatory, 'SKIPPED', 'not run in this invocation — pass --run-commands');
    continue;
  }
  const started = Date.now();
  const res = spawnSync(c.argv[0], c.argv[1], { cwd: ROOT, encoding: 'utf8', stdio: 'inherit', env: process.env });
  add(
    c.id,
    c.name,
    c.mandatory,
    res.status === 0 ? 'PASS' : 'FAIL',
    `\`${c.argv[0]} ${c.argv[1].join(' ')}\` exited ${res.status ?? 'on a signal'} after ${Date.now() - started}ms`,
  );
}

// ── the document ───────────────────────────────────────────────────────────
const mandatorySkipped = checks.filter((c) => c.mandatory && c.status === 'SKIPPED');
const failed = checks.filter((c) => c.status === 'FAIL');

const evidence = {
  slice: 'P2-S8',
  title: 'Security / failure / reconciliation / performance hardening + the dedicated reconciliation authority',
  producedAt: new Date().toISOString(),
  head: git('rev-parse', 'HEAD'),
  branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
  node: process.version,
  boundary: {
    frozenThrough: manifest.frozenThrough,
    frozenCount: manifest.migrations.length,
    candidate: migrations.includes(CANDIDATE) ? { name: CANDIDATE, sha256: sha256(`infrastructure/database/migrations/${CANDIDATE}`), frozen: false } : null,
    beyondCandidate: migrations.filter((f) => f > CANDIDATE),
  },
  checks,
  summary: {
    total: checks.length,
    pass: checks.filter((c) => c.status === 'PASS').length,
    fail: failed.length,
    skipped: checks.filter((c) => c.status === 'SKIPPED').length,
    /** f §50: this number must be zero, and the P2-S8 gate enforces it. */
    mandatorySkipped: mandatorySkipped.length,
  },
  verdict: failed.length === 0 && mandatorySkipped.length === 0 ? 'PASS' : 'FAIL',
};

mkdirSync(join(ROOT, 'release'), { recursive: true });
writeFileSync(join(ROOT, 'release/phase2-s8-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);

for (const c of checks) console.log(`  ${c.status.padEnd(7)} ${c.id} — ${c.name}\n          ${c.evidence}`);
console.log(
  `\nrelease/phase2-s8-evidence.json written: ${evidence.summary.pass} pass, ${evidence.summary.fail} fail, ${evidence.summary.skipped} skipped (${evidence.summary.mandatorySkipped} of them mandatory)`,
);
if (evidence.verdict !== 'PASS') {
  console.error(`\nP2-S8 EVIDENCE: FAIL`);
  process.exitCode = 1;
}
