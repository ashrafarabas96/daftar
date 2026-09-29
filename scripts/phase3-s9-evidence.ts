#!/usr/bin/env tsx
/**
 * ─────────────────────────────────────────────────────────────────────────
 * P3-S9 RELEASE EVIDENCE — the machine-readable record of one release run
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The form of `scripts/phase2-s9-evidence.ts` (docs/PHASE_3_S9_CONTRACT.md
 * A-13): run ids, timings and digests come into existence only when the
 * workflow runs, so they live here, assembled from artefacts, and never in a
 * document that would have to be edited to carry them. Every value below is
 * read, not written.
 *
 * WHAT IS KEPT FROM P2-S9
 *
 * The sidecar digest; the delivery manifest read out of the zip itself; no
 * forbidden entry in the zip; the repository run on a source checkout and the
 * archive run inside an extracted archive; the archive run on the archive's
 * own tree hash and commit; both gate verdicts PASS with 0 fail and 0
 * mandatory skips.
 *
 * WHAT IS ADDED
 *
 *   1. The exact SHA. `--expected-sha` is required and the archive's
 *      `sourceCommit` must equal it. Under `workflow_dispatch` with a `sha`
 *      input, `GITHUB_SHA` is the branch head, not the commit under release,
 *      so recording it (as P2 did) proves nothing about the archive.
 *   2. A second, independent route to the content. `--git-archive` is
 *      `git archive --format=tar --prefix=DAFTAR/ <sha>`, read straight from
 *      the object store. Its commit id (the tar's global comment) must be the
 *      expected SHA, and the tree hash recomputed from its files with the
 *      export's algorithm must equal the delivery manifest's, over the same
 *      path set. The export's route is the working tree; this one is git's.
 *   3. `phase: 3`.
 *   4. The migration claim, for this release only: the migrations shipped
 *      are exactly the Phase 2 prefix followed by the final Phase 3 prefix
 *      (`PHASE3_PREFIX`: the slices 0053–0069, then the corrective hardening
 *      0070–0073, each at its accepted digest), and `frozenThrough` is the
 *      Phase 3 prefix end, 0073. P3-S9 itself added none. This file describes
 *      one run of one commit and is named for the slice, which is the only
 *      place such a sentence may live; no gate says it.
 *   5. The deployment matrix and the deployed-database rehearsal PASS in both
 *      runs, and no role but the deployer holds TEMP or CREATE on `public`.
 *   6. The nested `gate:phase2:release` artefact PASS in both runs, on the
 *      same tree as its parent.
 *   7. The full Phase 3 secret history scan (corrective directive §7):
 *      `scripts/phase3-secret-scan.ts` over base `0f2b09e…` — verified as the
 *      merge-base with main — through exactly the commit under release, every
 *      commit in the range read, nothing remaining. The evidence records base,
 *      head, commits in range, commits scanned, findings, allowlisted
 *      fingerprints and the result. The archive run has no `.git` and cannot
 *      scan history (the release gate scans its files in tree mode there), so
 *      the repository checkout's range scan is the one recorded, and a
 *      tree-mode artefact is refused in its place.
 *      Required when `--secret-scan=<file>` is passed (the release workflow
 *      passes it); judged whenever the file is present.
 *
 * Usage:
 *   npm run evidence:phase3:s9 -- --expected-sha=<40-hex> --repo-gate=<file>
 *     --archive-gate=<file> --archive=<zip> --git-archive=<tar> [--ci-run=<id>]
 *     [--release-dir=<dir>] [--deployment=<file>] [--archive-deployment=<file>]
 *     [--rehearsal=<file>] [--archive-rehearsal=<file>] [--secret-scan=<file>]
 *     [--out=<file>]
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PHASE2_PREFIX } from './phase2-prefix';
import { PHASE3_PREFIX, PHASE3_PREFIX_END } from './phase3-prefix';
import { secretScanEvidenceProblems, type ScanResult } from './phase3-secret-scan';

const ROOT = join(__dirname, '..');
const argv = process.argv.slice(2);
function arg(name: string): string | undefined {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.slice(name.length + 3);
}

const RELEASE = resolve(arg('release-dir') ?? join(ROOT, 'release'));
const inRelease = (name: string, file: string): string => resolve(arg(name) ?? join(RELEASE, file));
const REPO_GATE = inRelease('repo-gate', 'phase3-s9-release-gate.json');
const ARCHIVE_GATE = inRelease('archive-gate', 'phase3-s9-release-gate-archive.json');
const ARCHIVE = inRelease('archive', 'DAFTAR_PHASE_3_RC.zip');
const GIT_ARCHIVE = arg('git-archive') === undefined ? null : resolve(String(arg('git-archive')));
const DEPLOYMENT = inRelease('deployment', 'phase2-s9-deployment-authority.json');
const ARCHIVE_DEPLOYMENT = inRelease('archive-deployment', 'phase2-s9-deployment-authority-archive.json');
const REHEARSAL = inRelease('rehearsal', 'phase3-s9-deployed-rehearsal.json');
const ARCHIVE_REHEARSAL = inRelease('archive-rehearsal', 'phase3-s9-deployed-rehearsal-archive.json');
const SECRET_SCAN = inRelease('secret-scan', 'phase3-secret-scan.json');
const OUT = inRelease('out', 'phase3-s9-release-evidence.json');
const EXPECTED_SHA = arg('expected-sha') ?? null;
const DEPLOYER = 'daftar_migrator';

const problems: string[] = [];
const sha256 = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex');
const shown = (path: string): string => path.replace(`${ROOT}/`, '');

/** The export's tree hash (`scripts/export-release.ts`): "<path>:<sha256>" lines in path order, joined with \n. */
function treeHash(entries: readonly { path: string; sha256: string }[]): string {
  const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return sha256(sorted.map((e) => `${e.path}:${e.sha256}`).join('\n'));
}

function readJson<T>(path: string, what: string): T | null {
  if (!existsSync(path)) {
    problems.push(`${what} is missing: ${shown(path)}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (e) {
    problems.push(`${what} is not readable JSON: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

interface NestedArtefact {
  present?: boolean;
  verdict?: string | null;
  mandatorySkipped?: number | null;
  summary?: { fail?: number } | null;
  tree?: { kind?: string | null; treeHash?: string | null; sourceCommit?: string | null };
}

interface GateArtefact {
  produced?: string;
  phase?: number;
  structuralOnly?: boolean;
  verdict?: string;
  mandatorySkipped?: number;
  summary?: { total?: number; pass?: number; fail?: number; skipped?: number };
  tree?: { kind?: string; deliveryManifest?: { treeHash?: string; sourceCommit?: string; phase?: number } | null; archiveSha256?: string | null };
  environment?: Record<string, unknown>;
  steps?: { name: string; status: string; durationMs: number; exitCode: number | null }[];
  nested?: { 'gate:phase2:release'?: NestedArtefact } | null;
}

interface DeliveryManifest {
  phase: number;
  sourceCommit: string;
  gitDirty: boolean;
  treeHash: string;
  treeHashAlgorithm: string;
  fileCount: number;
  inventory: { path: string; sha256: string }[];
  migrationCount: number;
  frozenThrough: string;
  migrationHashes: { name: string; sha256: string }[];
  migrationManifestSha256: string;
  environment: Record<string, unknown>;
  generatedAt: string;
}

interface DeploymentArtefact {
  verdict?: string;
  staticOnly?: boolean;
  postgres?: string | null;
  findings?: string[];
  roleMatrix?: { role?: string; temporaryOnDatabase?: unknown; createOnPublic?: unknown }[];
  inventory?: Record<string, unknown>;
}

interface RehearsalArtefact {
  verdict?: string;
  [key: string]: unknown;
}

// ── the exact commit ──────────────────────────────────────────────────────

if (EXPECTED_SHA === null) problems.push('--expected-sha is required: evidence that does not name the commit under release is evidence about nothing');
else if (!/^[0-9a-f]{40}$/.test(EXPECTED_SHA)) problems.push(`--expected-sha must be a full 40-hex commit id, not "${EXPECTED_SHA}"`);

// ── the archive, and the delivery manifest read out of it ────────────────

let delivery: DeliveryManifest | null = null;
let archiveSha256: string | null = null;
let archiveBytes: number | null = null;
let archiveEntryCount: number | null = null;
let forbiddenEntries: string[] = [];

if (!existsSync(ARCHIVE)) {
  problems.push(`the release archive is missing: ${shown(ARCHIVE)}`);
} else {
  const buf = readFileSync(ARCHIVE);
  archiveSha256 = sha256(buf);
  archiveBytes = buf.byteLength;
  const sidecar = `${ARCHIVE}.sha256`;
  if (existsSync(sidecar)) {
    const recorded = readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0] ?? '';
    if (recorded !== archiveSha256)
      problems.push(`${shown(sidecar)} records ${recorded.slice(0, 12)}… but the archive hashes to ${archiveSha256.slice(0, 12)}…`);
  } else {
    problems.push('the archive has no sibling .sha256');
  }
  try {
    delivery = JSON.parse(
      execFileSync('unzip', ['-p', ARCHIVE, 'DAFTAR/DELIVERY_MANIFEST.json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
    ) as DeliveryManifest;
  } catch (e) {
    problems.push(`the archive carries no readable DAFTAR/DELIVERY_MANIFEST.json: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const entries = execFileSync('unzip', ['-Z1', ARCHIVE], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n')
      .filter((l) => l.length > 0);
    archiveEntryCount = entries.filter((l) => !l.endsWith('/')).length;
    const forbidden =
      /(^|\/)(\.git|node_modules|\.next|dist|build|coverage|\.gradle|var|\.pgdata|release)(\/|$)|(^|\/)\.env($|\.)|\.(pem|key|dump|log|tsbuildinfo|zip)$|\.sql\.gz$/i;
    forbiddenEntries = entries.filter((e) => forbidden.test(e));
    if (forbiddenEntries.length > 0) problems.push(`the archive carries forbidden content: ${forbiddenEntries.slice(0, 10).join(', ')}`);
  } catch (e) {
    problems.push(`the archive's entry list is not readable: ${e instanceof Error ? e.message : String(e)}`);
  }
}

if (delivery) {
  if (delivery.phase !== 3) problems.push(`the delivery manifest says phase ${JSON.stringify(delivery.phase)}; this is the Phase 3 release`);
  if (EXPECTED_SHA !== null && delivery.sourceCommit !== EXPECTED_SHA) {
    problems.push(`the archive was exported from commit ${String(delivery.sourceCommit)}, not the commit under release ${EXPECTED_SHA}`);
  }
  if (delivery.gitDirty !== false) problems.push('the delivery manifest does not say the export ran on a clean tree');
  const recomputed = treeHash(delivery.inventory ?? []);
  if (recomputed !== delivery.treeHash)
    problems.push(`the delivery inventory recomputes to tree hash ${recomputed.slice(0, 12)}…, not the recorded ${String(delivery.treeHash).slice(0, 12)}…`);

  // 4. The migration claim, for this one release: the Phase 2 prefix, then the final Phase 3 prefix.
  const expected = [...PHASE2_PREFIX, ...PHASE3_PREFIX].map(([name, digest]) => ({ name, sha256: digest }));
  const shipped = (delivery.migrationHashes ?? []).map((m) => ({ name: m.name, sha256: m.sha256 }));
  if (JSON.stringify(shipped) !== JSON.stringify(expected)) {
    const extra = shipped.filter((m) => !expected.some((e) => e.name === m.name)).map((m) => m.name);
    const changed = shipped.filter((m) => expected.some((e) => e.name === m.name && e.sha256 !== m.sha256)).map((m) => m.name);
    const missing = expected.filter((e) => !shipped.some((m) => m.name === e.name)).map((e) => e.name);
    problems.push(
      `the migrations shipped are not exactly the Phase 2 prefix and the final Phase 3 prefix (0053–0073): extra [${extra.join(', ')}], changed [${changed.join(', ')}], missing [${missing.join(', ')}]`,
    );
  }
  if (delivery.migrationCount !== expected.length)
    problems.push(`the delivery manifest counts ${String(delivery.migrationCount)} migrations, not ${expected.length}`);
  if (delivery.frozenThrough !== PHASE3_PREFIX_END)
    problems.push(`the delivery manifest says frozenThrough ${String(delivery.frozenThrough)}, not ${PHASE3_PREFIX_END}`);
}

// ── 2. the second route to the content: git's own archive of the commit ──

interface TarContent {
  readonly files: { path: string; sha256: string }[];
  readonly comment: string | null;
  readonly unsupported: string[];
}

/** A reader for the pax/ustar tar `git archive` writes. Regular files only; anything else is reported. */
function readTar(buf: Buffer): TarContent {
  const files: { path: string; sha256: string }[] = [];
  const unsupported: string[] = [];
  let comment: string | null = null;
  let nextPath: string | null = null;
  const text = (b: Buffer): string => {
    const nul = b.indexOf(0);
    return b.subarray(0, nul === -1 ? b.length : nul).toString('utf8');
  };
  const pax = (b: Buffer): Map<string, string> => {
    const out = new Map<string, string>();
    let i = 0;
    while (i < b.length) {
      const space = b.indexOf(0x20, i);
      if (space === -1) break;
      const len = Number(b.subarray(i, space).toString('ascii'));
      if (!Number.isInteger(len) || len <= 0) throw new Error('the tar carries a malformed pax record');
      const record = b.subarray(space + 1, i + len - 1).toString('utf8');
      const eq = record.indexOf('=');
      out.set(record.slice(0, eq), record.slice(eq + 1));
      i += len;
    }
    return out;
  };
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const sizeField = header.subarray(124, 136);
    if (((sizeField[0] ?? 0) & 0x80) !== 0) throw new Error('the tar carries a base-256 size field, which no git archive of this tree needs');
    const size = parseInt(text(sizeField).trim() || '0', 8);
    const type = String.fromCharCode(header[156] ?? 0);
    const body = buf.subarray(off + 512, off + 512 + size);
    const prefix = text(header.subarray(345, 500));
    const name = prefix !== '' ? `${prefix}/${text(header.subarray(0, 100))}` : text(header.subarray(0, 100));
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'g') {
      comment = pax(body).get('comment') ?? comment;
      continue;
    }
    if (type === 'x') {
      nextPath = pax(body).get('path') ?? null;
      continue;
    }
    if (type === 'L') {
      nextPath = text(body);
      continue;
    }
    const path = nextPath ?? name;
    nextPath = null;
    if (type === '5') continue;
    if (type !== '0' && type !== '\0') {
      unsupported.push(`${path} (type ${JSON.stringify(type)})`);
      continue;
    }
    files.push({ path, sha256: sha256(body) });
  }
  return { files, comment, unsupported };
}

let gitArchive: Record<string, unknown> | null = null;
if (GIT_ARCHIVE === null) {
  problems.push('--git-archive is required: the export is checked against git archive of the same commit');
} else if (!existsSync(GIT_ARCHIVE)) {
  problems.push(`the git archive is missing: ${shown(GIT_ARCHIVE)}`);
} else {
  try {
    const tar = readTar(readFileSync(GIT_ARCHIVE));
    const outside = tar.files.filter((f) => !f.path.startsWith('DAFTAR/')).map((f) => f.path);
    const files = tar.files.filter((f) => f.path.startsWith('DAFTAR/')).map((f) => ({ path: f.path.slice('DAFTAR/'.length), sha256: f.sha256 }));
    const hash = treeHash(files);
    gitArchive = { sha256: sha256(readFileSync(GIT_ARCHIVE)), commit: tar.comment, fileCount: files.length, treeHash: hash };
    if (outside.length > 0) problems.push(`the git archive carries files outside DAFTAR/: ${outside.slice(0, 5).join(', ')}`);
    if (tar.unsupported.length > 0) problems.push(`the git archive carries entries that are not regular files: ${tar.unsupported.slice(0, 5).join(', ')}`);
    if (EXPECTED_SHA !== null && tar.comment !== EXPECTED_SHA)
      problems.push(`the git archive was made of commit ${String(tar.comment)}, not the commit under release ${EXPECTED_SHA}`);
    if (delivery) {
      if (hash !== delivery.treeHash)
        problems.push(`the git archive's tree hash is ${hash.slice(0, 12)}…, not the export's ${String(delivery.treeHash).slice(0, 12)}…`);
      const inGit = new Set(files.map((f) => f.path));
      const inExport = new Set((delivery.inventory ?? []).map((i) => i.path));
      const onlyGit = [...inGit].filter((p) => !inExport.has(p));
      const onlyExport = [...inExport].filter((p) => !inGit.has(p));
      if (onlyGit.length > 0 || onlyExport.length > 0) {
        problems.push(
          `the git archive and the export list different files: only in git [${onlyGit.slice(0, 5).join(', ')}], only in the export [${onlyExport.slice(0, 5).join(', ')}]`,
        );
      }
    }
  } catch (e) {
    problems.push(`the git archive is not a readable tar: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── the two gate runs ─────────────────────────────────────────────────────

const repoGate = readJson<GateArtefact>(REPO_GATE, 'the release gate run on the repository checkout');
const archiveGate = readJson<GateArtefact>(ARCHIVE_GATE, 'the release gate run inside the extracted archive');

for (const [label, gate, kind] of [
  ['repository', repoGate, 'source-checkout'],
  ['extracted archive', archiveGate, 'extracted-archive'],
] as const) {
  if (!gate) continue;
  if (gate.produced !== 'scripts/phase3-release-gate.ts' || gate.phase !== 3)
    problems.push(`the ${label} gate artefact was not produced by the Phase 3 release gate`);
  if (gate.structuralOnly !== false) problems.push(`the ${label} gate artefact is not a full release run`);
  if (gate.tree?.kind !== kind) problems.push(`the ${label} gate reports tree kind "${String(gate.tree?.kind)}", not "${kind}"`);
  if (gate.verdict !== 'PASS') problems.push(`the ${label} gate verdict is ${String(gate.verdict)}`);
  if ((gate.summary?.fail ?? -1) !== 0) problems.push(`the ${label} gate reports ${String(gate.summary?.fail)} failures`);
  if ((gate.mandatorySkipped ?? -1) !== 0) problems.push(`the ${label} gate reports ${String(gate.mandatorySkipped)} mandatory skips`);

  // 6. The nested Phase 2 release gate, on the same tree as its parent.
  const nested = gate.nested?.['gate:phase2:release'];
  if (!nested || nested.present !== true) {
    problems.push(`the ${label} gate carries no nested gate:phase2:release artefact`);
  } else {
    if (nested.verdict !== 'PASS') problems.push(`the nested gate:phase2:release in the ${label} run is ${String(nested.verdict)}`);
    if ((nested.summary?.fail ?? -1) !== 0)
      problems.push(`the nested gate:phase2:release in the ${label} run reports ${String(nested.summary?.fail)} failures`);
    if ((nested.mandatorySkipped ?? -1) !== 0)
      problems.push(`the nested gate:phase2:release in the ${label} run reports ${String(nested.mandatorySkipped)} mandatory skips`);
    if (nested.tree?.kind !== gate.tree?.kind)
      problems.push(`the nested gate:phase2:release in the ${label} run gated a "${String(nested.tree?.kind)}" tree, not its parent's`);
  }
}

if (delivery && archiveGate?.tree) {
  const inGate = archiveGate.tree.deliveryManifest ?? null;
  if (inGate?.treeHash !== delivery.treeHash)
    problems.push(`the archive gate ran against tree hash ${String(inGate?.treeHash).slice(0, 12)}…, not the archive's ${delivery.treeHash.slice(0, 12)}…`);
  if (inGate?.sourceCommit !== delivery.sourceCommit)
    problems.push(`the archive gate ran against commit ${String(inGate?.sourceCommit)}, not the archive's ${delivery.sourceCommit}`);
  const nested = archiveGate.nested?.['gate:phase2:release']?.tree;
  if (nested && (nested.treeHash !== delivery.treeHash || nested.sourceCommit !== delivery.sourceCommit)) {
    problems.push('the nested gate:phase2:release in the archive run gated a different tree from the archive');
  }
  if (archiveGate.tree.archiveSha256 !== archiveSha256)
    problems.push(`the archive gate was told archive digest ${String(archiveGate.tree.archiveSha256)}, not ${String(archiveSha256)}`);
}

// ── 5. the deployment matrix and the deployed rehearsal, in both runs ─────

function checkDeployment(label: string, d: DeploymentArtefact | null): void {
  if (!d) return;
  if (d.verdict !== 'PASS') problems.push(`the ${label} deployment-authority matrix verdict is ${String(d.verdict)}`);
  if (d.staticOnly === true) problems.push(`the ${label} deployment-authority matrix ran its static half only`);
  const rows = Array.isArray(d.roleMatrix) ? d.roleMatrix : [];
  if (rows.length === 0) problems.push(`the ${label} deployment-authority matrix carries no role matrix`);
  for (const r of rows) {
    if (r.role === DEPLOYER) continue;
    if (r.temporaryOnDatabase !== false)
      problems.push(`in the ${label} role matrix ${String(r.role)} holds TEMP on the database (${JSON.stringify(r.temporaryOnDatabase)})`);
    if (r.createOnPublic !== false) problems.push(`in the ${label} role matrix ${String(r.role)} holds CREATE on public (${JSON.stringify(r.createOnPublic)})`);
  }
}

const deployment = readJson<DeploymentArtefact>(DEPLOYMENT, 'the deployment-authority matrix of the repository run');
const archiveDeployment = readJson<DeploymentArtefact>(ARCHIVE_DEPLOYMENT, 'the deployment-authority matrix of the archive run');
checkDeployment('repository', deployment);
checkDeployment('archive', archiveDeployment);

const rehearsal = readJson<RehearsalArtefact>(REHEARSAL, 'the deployed-database rehearsal of the repository run');
const archiveRehearsal = readJson<RehearsalArtefact>(ARCHIVE_REHEARSAL, 'the deployed-database rehearsal of the archive run');
for (const [label, r] of [
  ['repository', rehearsal],
  ['archive', archiveRehearsal],
] as const) {
  if (r && r.verdict !== 'PASS') problems.push(`the ${label} deployed-database rehearsal verdict is ${String(r.verdict)}`);
}

// ── 7. the full Phase 3 secret history scan ──────────────────────────────

// Required when the workflow names it (`--secret-scan=`, as
// phase3-s9-release.yml does); judged whenever it is present, so a failed or
// partial scan sitting in the release directory is never ignored.
const secretScanRequired = arg('secret-scan') !== undefined;
const secretScan = secretScanRequired || existsSync(SECRET_SCAN) ? readJson<Partial<ScanResult>>(SECRET_SCAN, 'the Phase 3 secret history scan') : null;
if (secretScan) problems.push(...secretScanEvidenceProblems(secretScan, EXPECTED_SHA));

// ─────────────────────────────────────────────────────────────────────────

const gateSummary = (g: GateArtefact | null): Record<string, unknown> => ({
  verdict: g?.verdict ?? null,
  total: g?.summary?.total ?? null,
  pass: g?.summary?.pass ?? null,
  fail: g?.summary?.fail ?? null,
  mandatorySkipped: g?.mandatorySkipped ?? null,
  database: g?.environment?.['database'] ?? null,
  nestedPhase2Release: g?.nested?.['gate:phase2:release'] ?? null,
  steps: (g?.steps ?? []).map((s) => ({ name: s.name, status: s.status, durationMs: s.durationMs })),
});

const evidence = {
  produced: 'scripts/phase3-s9-evidence.ts',
  producedAt: new Date().toISOString(),
  phase: 3,
  slice: 'P3-S9',
  source: {
    expectedCommit: EXPECTED_SHA,
    commit: delivery?.sourceCommit ?? null,
    gitDirty: delivery?.gitDirty ?? null,
    treeHash: delivery?.treeHash ?? null,
    treeHashAlgorithm: delivery?.treeHashAlgorithm ?? null,
    fileCount: delivery?.fileCount ?? null,
    exportedAt: delivery?.generatedAt ?? null,
  },
  archive: { name: ARCHIVE.split('/').pop(), sha256: archiveSha256, bytes: archiveBytes, entryCount: archiveEntryCount, forbiddenEntries },
  gitArchive,
  migrations: {
    count: delivery?.migrationCount ?? null,
    frozenThrough: delivery?.frozenThrough ?? null,
    manifestSha256: delivery?.migrationManifestSha256 ?? null,
    hashes: delivery?.migrationHashes ?? [],
  },
  environment: { export: delivery?.environment ?? null, repositoryGate: repoGate?.environment ?? null, archiveGate: archiveGate?.environment ?? null },
  workflows: {
    thisRun: process.env['GITHUB_RUN_ID'] ?? null,
    thisWorkflow: process.env['GITHUB_WORKFLOW'] ?? null,
    thisSha: process.env['GITHUB_SHA'] ?? null,
    repository: process.env['GITHUB_REPOSITORY'] ?? null,
    ciRun: arg('ci-run') ?? null,
  },
  gates: { repository: gateSummary(repoGate), extractedArchive: gateSummary(archiveGate) },
  deploymentAuthority: {
    repository: {
      verdict: deployment?.verdict ?? null,
      postgres: deployment?.postgres ?? null,
      findings: deployment?.findings ?? null,
      roleMatrix: deployment?.roleMatrix ?? null,
    },
    extractedArchive: {
      verdict: archiveDeployment?.verdict ?? null,
      postgres: archiveDeployment?.postgres ?? null,
      findings: archiveDeployment?.findings ?? null,
    },
  },
  deployedRehearsal: { repository: rehearsal, extractedArchive: archiveRehearsal },
  secretHistoryScan: {
    base: secretScan?.base ?? null,
    head: secretScan?.head ?? null,
    mergeBase: secretScan?.mergeBase ?? null,
    mainRef: secretScan?.mainRef ?? null,
    gitleaks: secretScan?.tool ?? null,
    logOpts: secretScan?.logOpts ?? null,
    commitsInRange: secretScan?.commitsInRange ?? null,
    mergesInRange: secretScan?.mergesInRange ?? null,
    commitsScanned: secretScan?.commitsScanned ?? null,
    findings: secretScan?.findings ?? null,
    allowlisted: secretScan?.allowlisted ?? null,
    remaining: secretScan?.remaining ?? null,
    result: secretScan?.result ?? null,
  },
  verdict: problems.length === 0 ? 'PASS' : 'FAIL',
  problems,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`);

console.log('P3-S9 RELEASE EVIDENCE');
console.log(`  commit under release ${String(EXPECTED_SHA)}`);
console.log(`  archive commit       ${String(evidence.source.commit)}`);
console.log(`  tree hash            ${String(evidence.source.treeHash)}`);
console.log(`  git archive          ${String(gitArchive?.['treeHash'] ?? null)}`);
console.log(`  archive sha256       ${String(archiveSha256)}`);
console.log(`  migrations           ${String(evidence.migrations.count)} frozen through ${String(evidence.migrations.frozenThrough)}`);
console.log(`  repository gate      ${String(repoGate?.verdict ?? null)}`);
console.log(`  archive gate         ${String(archiveGate?.verdict ?? null)}`);
console.log(
  `  secret history scan  ${String(secretScan?.result ?? null)}: ${String(secretScan?.base ?? null)}..${String(secretScan?.head ?? null)}, ` +
    `${String(secretScan?.commitsScanned ?? null)}/${String(secretScan?.commitsInRange ?? null)} commits, ` +
    `${String(secretScan?.findings ?? null)} findings, ${String(secretScan?.remaining?.length ?? null)} remaining`,
);
console.log(`\nP3-S9 RELEASE EVIDENCE: ${evidence.verdict}`);
console.log(`  ${shown(OUT)}`);
if (problems.length > 0) {
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
