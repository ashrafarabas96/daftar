#!/usr/bin/env tsx
/**
 * ─────────────────────────────────────────────────────────────────────────
 * P2-S9 RELEASE EVIDENCE — the machine-readable record of one release run
 * ─────────────────────────────────────────────────────────────────────────
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE DOCUMENTS
 *
 * A static document can state a contract, a hash, or the fact that a slice
 * was accepted. It cannot state a workflow run id, a timing, an artefact
 * digest or an archive digest, because those come into existence only when
 * the workflow runs — and a document that has to be edited to carry them
 * turns into a loop: the document changes the head, the new head invalidates
 * the run the document names, and a new run has to be recorded in the
 * document. So the contracts live in `docs/`, and everything a run produces
 * lives here, in one file, assembled from artefacts rather than typed.
 *
 * EVERY VALUE BELOW IS READ, NOT WRITTEN
 *
 * The archive digest is hashed from the archive. The tree hash, file count,
 * migration hashes and source commit are read out of the delivery manifest
 * the export wrote. The gate verdicts, failure counts and mandatory-skip
 * counts are read out of the two gate artefacts. The workflow ids come from
 * the runner's own environment. Nothing here is a claim this script makes on
 * its own behalf.
 *
 * THE TWO GATE RUNS ARE BOTH REQUIRED
 *
 * `--repo-gate` is the run on the repository checkout (§27) and
 * `--archive-gate` is the run inside the extracted archive, on a tree with no
 * `.git` (§28). A release candidate that passes only the first has proved
 * that the developer's working directory works.
 *
 * Usage:
 *   npm run evidence:phase2:s9 -- --repo-gate=<file> --archive-gate=<file>
 *                                 [--archive=<zip>] [--ci-run=<id>]
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const RELEASE = join(ROOT, 'release');
const args = new Map(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=') as [string, string | undefined]));

const REPO_GATE = args.get('repo-gate') ?? join(RELEASE, 'phase2-s9-release-gate.json');
const ARCHIVE_GATE = args.get('archive-gate') ?? join(RELEASE, 'phase2-s9-release-gate-archive.json');
const ARCHIVE = args.get('archive') ?? join(RELEASE, 'DAFTAR_PHASE_2_RC.zip');
const DEPLOYMENT = join(RELEASE, 'phase2-s9-deployment-authority.json');
const OUT = join(RELEASE, 'phase2-s9-release-evidence.json');

const problems: string[] = [];

function readJson<T>(path: string, what: string): T | null {
  if (!existsSync(path)) {
    problems.push(`${what} is missing: ${path.replace(`${ROOT}/`, '')}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (e) {
    problems.push(`${what} is not readable JSON: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

interface GateArtefact {
  verdict?: string;
  mandatorySkipped?: number;
  summary?: { total?: number; pass?: number; fail?: number; skipped?: number };
  tree?: { kind?: string; deliveryManifest?: Record<string, unknown> | null; archiveSha256?: string | null };
  environment?: Record<string, unknown>;
  steps?: { name: string; status: string; durationMs: number; exitCode: number | null }[];
}

interface DeliveryManifest {
  phase: number;
  sourceCommit: string;
  gitDirty: boolean;
  treeHash: string;
  treeHashAlgorithm: string;
  fileCount: number;
  migrationCount: number;
  frozenThrough: string;
  migrationHashes: { name: string; sha256: string }[];
  migrationManifestSha256: string;
  environment: Record<string, unknown>;
  generatedAt: string;
}

const repoGate = readJson<GateArtefact>(REPO_GATE, 'the release gate run on the repository (§27)');
const archiveGate = readJson<GateArtefact>(ARCHIVE_GATE, 'the release gate run inside the extracted archive (§28)');
const deployment = readJson<{ verdict?: string; findings?: string[]; roleMatrix?: unknown[]; inventory?: Record<string, unknown> }>(
  DEPLOYMENT,
  'the deployment-authority matrix',
);

/** The delivery manifest is the archive's own statement of what it is. */
let delivery: DeliveryManifest | null = null;
let archiveSha256: string | null = null;
let archiveBytes: number | null = null;
let archiveEntryCount: number | null = null;

if (!existsSync(ARCHIVE)) {
  problems.push(`the release archive is missing: ${ARCHIVE.replace(`${ROOT}/`, '')}`);
} else {
  const buf = readFileSync(ARCHIVE);
  archiveSha256 = createHash('sha256').update(buf).digest('hex');
  archiveBytes = buf.byteLength;

  // The sibling digest file must agree with the archive it names; if the two
  // ever disagree, one of them was written by hand.
  const sidecar = `${ARCHIVE}.sha256`;
  if (existsSync(sidecar)) {
    const recorded = readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0];
    if (recorded !== archiveSha256)
      problems.push(`${sidecar.replace(`${ROOT}/`, '')} records ${recorded.slice(0, 12)}… but the archive hashes to ${archiveSha256.slice(0, 12)}…`);
  } else {
    problems.push('the archive has no sibling .sha256');
  }

  // Read the delivery manifest OUT of the archive rather than from any copy
  // left in the working directory: the manifest that matters is the one a
  // recipient would find inside the file they were given.
  try {
    const raw = execFileSync('unzip', ['-p', ARCHIVE, 'DAFTAR/DELIVERY_MANIFEST.json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    delivery = JSON.parse(raw) as DeliveryManifest;
    archiveEntryCount = execFileSync('unzip', ['-Z1', ARCHIVE], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n')
      .filter((l) => l.length > 0 && !l.endsWith('/')).length;
  } catch (e) {
    problems.push(`the archive carries no readable DAFTAR/DELIVERY_MANIFEST.json: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// The archive must not carry a working tree, a dependency tree, a secret or
// a build output (§24). This is asked of the ZIP's own entry list, which is
// the only place the question can be answered about the delivered file.
let forbiddenEntries: string[] = [];
if (existsSync(ARCHIVE)) {
  const entries = execFileSync('unzip', ['-Z1', ARCHIVE], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .filter((l) => l.length > 0);
  const forbidden =
    /(^|\/)(\.git|node_modules|\.next|dist|build|coverage|\.gradle|var|\.pgdata|release)(\/|$)|(^|\/)\.env($|\.)|\.(pem|key|dump|log|tsbuildinfo|zip)$|\.sql\.gz$/i;
  forbiddenEntries = entries.filter((e) => forbidden.test(e));
  if (forbiddenEntries.length > 0) problems.push(`the archive carries forbidden content: ${forbiddenEntries.slice(0, 10).join(', ')}`);
}

/**
 * The two gate runs must agree about WHICH tree they gated. The repository
 * run knows its commit only through the export; the archive run knows it only
 * through the delivery manifest. If those disagree, one of the two runs was
 * made against a different tree and neither number means anything.
 */
if (delivery && archiveGate?.tree?.deliveryManifest) {
  const inGate = archiveGate.tree.deliveryManifest as { treeHash?: string; sourceCommit?: string };
  if (inGate.treeHash !== delivery.treeHash)
    problems.push(`the archive gate ran against tree hash ${String(inGate.treeHash).slice(0, 12)}…, not the archive's ${delivery.treeHash.slice(0, 12)}…`);
  if (inGate.sourceCommit !== delivery.sourceCommit)
    problems.push(`the archive gate ran against commit ${String(inGate.sourceCommit).slice(0, 12)}…, not the archive's ${delivery.sourceCommit.slice(0, 12)}…`);
}
if (archiveGate && archiveGate.tree?.kind !== 'extracted-archive') {
  problems.push(`the archive gate reports tree kind "${String(archiveGate.tree?.kind)}" — §28 requires a run inside the extracted archive`);
}
if (repoGate && repoGate.tree?.kind !== 'source-checkout') {
  problems.push(`the repository gate reports tree kind "${String(repoGate.tree?.kind)}" — §27 requires a run on the repository checkout`);
}

for (const [label, gate] of [
  ['repository', repoGate],
  ['extracted archive', archiveGate],
] as const) {
  if (!gate) continue;
  if (gate.verdict !== 'PASS') problems.push(`the ${label} gate verdict is ${String(gate.verdict)}`);
  if ((gate.summary?.fail ?? -1) !== 0) problems.push(`the ${label} gate reports ${String(gate.summary?.fail)} failures`);
  if ((gate.mandatorySkipped ?? -1) !== 0) problems.push(`the ${label} gate reports ${String(gate.mandatorySkipped)} mandatory skips`);
}

if (deployment && deployment.verdict !== 'PASS') problems.push(`the deployment-authority matrix verdict is ${String(deployment.verdict)}`);

/** The migrations P2-S8 froze, named so a reader does not have to find them. */
const P2_S8_MIGRATIONS = ['0051_accounting_reconciler_read.sql', '0052_accounting_journal_lines_rls_performance.sql'];

const evidence = {
  produced: 'scripts/phase2-s9-evidence.ts',
  producedAt: new Date().toISOString(),
  phase: 2,
  slice: 'P2-S9',

  source: {
    commit: delivery?.sourceCommit ?? null,
    gitDirty: delivery?.gitDirty ?? null,
    treeHash: delivery?.treeHash ?? null,
    treeHashAlgorithm: delivery?.treeHashAlgorithm ?? null,
    fileCount: delivery?.fileCount ?? null,
    exportedAt: delivery?.generatedAt ?? null,
  },

  archive: {
    name: ARCHIVE.split('/').pop(),
    sha256: archiveSha256,
    bytes: archiveBytes,
    entryCount: archiveEntryCount,
    forbiddenEntries,
  },

  migrations: {
    count: delivery?.migrationCount ?? null,
    frozenThrough: delivery?.frozenThrough ?? null,
    manifestSha256: delivery?.migrationManifestSha256 ?? null,
    hashes: delivery?.migrationHashes ?? [],
    p2s8Frozen: (delivery?.migrationHashes ?? []).filter((m) => P2_S8_MIGRATIONS.includes(m.name)),
  },

  environment: {
    export: delivery?.environment ?? null,
    repositoryGate: repoGate?.environment ?? null,
    archiveGate: archiveGate?.environment ?? null,
  },

  workflows: {
    // The runner's own identity. Absent on a workstation, which is the
    // honest answer there rather than a number made up to fill the field.
    thisRun: process.env['GITHUB_RUN_ID'] ?? null,
    thisWorkflow: process.env['GITHUB_WORKFLOW'] ?? null,
    thisSha: process.env['GITHUB_SHA'] ?? null,
    repository: process.env['GITHUB_REPOSITORY'] ?? null,
    ciRun: args.get('ci-run') ?? null,
  },

  gates: {
    repository: {
      verdict: repoGate?.verdict ?? null,
      total: repoGate?.summary?.total ?? null,
      pass: repoGate?.summary?.pass ?? null,
      fail: repoGate?.summary?.fail ?? null,
      mandatorySkipped: repoGate?.mandatorySkipped ?? null,
      steps: (repoGate?.steps ?? []).map((s) => ({ name: s.name, status: s.status, durationMs: s.durationMs })),
    },
    extractedArchive: {
      verdict: archiveGate?.verdict ?? null,
      total: archiveGate?.summary?.total ?? null,
      pass: archiveGate?.summary?.pass ?? null,
      fail: archiveGate?.summary?.fail ?? null,
      mandatorySkipped: archiveGate?.mandatorySkipped ?? null,
      steps: (archiveGate?.steps ?? []).map((s) => ({ name: s.name, status: s.status, durationMs: s.durationMs })),
    },
  },

  deploymentAuthority: {
    verdict: deployment?.verdict ?? null,
    findings: deployment?.findings ?? null,
    roleMatrix: deployment?.roleMatrix ?? null,
    inventory: deployment?.inventory ?? null,
  },

  verdict: problems.length === 0 ? 'PASS' : 'FAIL',
  problems,
};

mkdirSync(RELEASE, { recursive: true });
writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`);

console.log('P2-S9 RELEASE EVIDENCE');
console.log(`  source commit      ${String(evidence.source.commit)}`);
console.log(`  tree hash          ${String(evidence.source.treeHash)}`);
console.log(`  archive sha256     ${String(evidence.archive.sha256)}`);
console.log(`  files in archive   ${String(evidence.archive.entryCount)}`);
console.log(`  migrations         ${String(evidence.migrations.count)} frozen through ${String(evidence.migrations.frozenThrough)}`);
console.log(
  `  repository gate    ${String(evidence.gates.repository.verdict)} (${String(evidence.gates.repository.fail)} fail, ${String(evidence.gates.repository.mandatorySkipped)} skipped)`,
);
console.log(
  `  archive gate       ${String(evidence.gates.extractedArchive.verdict)} (${String(evidence.gates.extractedArchive.fail)} fail, ${String(evidence.gates.extractedArchive.mandatorySkipped)} skipped)`,
);
console.log(`  deployment matrix  ${String(evidence.deploymentAuthority.verdict)}`);
console.log(`\nP2-S9 RELEASE EVIDENCE: ${evidence.verdict}`);
console.log(`  ${OUT.replace(`${ROOT}/`, '')}`);
if (problems.length > 0) {
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
