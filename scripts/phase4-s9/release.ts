#!/usr/bin/env tsx
/**
 * PHASE 4 — P4-S9 — THE RELEASE GATE PLAN, THE TWO DEPLOYMENT PROOFS, THE
 * MIGRATION HASH VERIFIER, THE RC ARCHIVE AND THE SHA256
 *
 * ── THE TWO PROOFS ARE NOT THE SAME PROOF ────────────────────────────────
 *
 *   (A) FRESH INSTALL — a fresh cluster from `0000` to the candidate, then a
 *       second pass that must be a no-op.
 *   (B) REAL UPGRADE — an existing database at the FROZEN PREDECESSOR PREFIX,
 *       upgraded to the candidate.
 *
 * A's success is NEVER a safety claim about B. They answer different
 * questions: A asks "can this history be built", B asks "can a database that
 * already exists be moved". The recorded lesson is sharper still — a suite
 * that applies migrations AS A SUPERUSER is never asked the two questions that
 * decide whether a deployment works, because a superuser has every privilege
 * the migration might have forgotten to grant and owns every object it might
 * have forgotten to hand over. So: PROVE A DEPLOYMENT BY PERFORMING IT, as the
 * non-superuser deployment principal, and then DIFF THE CATALOGUE against a
 * superuser build. The diff is the part that catches the forgotten GRANT —
 * `[[daftar-grant-before-owner]]`: a `GRANT` issued without grant option warns
 * and COMMITS rather than raising, so an ordering mistake produces a green
 * migration and a missing privilege.
 *
 * ── THE EXIT STATUS MUST BE PROVED ABLE TO SAY NO ────────────────────────
 *
 * `[[daftar-a-gate-that-reads-an-exit-status-must-prove-it-can-say-no]]`:
 * DAFTAR's runner once exited 0 over four failing tests and hid four of them.
 * Every step of this plan that reads a verdict out of an exit status declares
 * `readsExitStatus: true`, and the plan refuses to run until the runner canary
 * has been executed FIRST and has proved a non-zero status is reachable here.
 *
 * ── SUPPLY CHAIN ─────────────────────────────────────────────────────────
 *
 * The dependency audit is RELEASE-BLOCKING. No `--force`, no advisory ignore,
 * no allowlist for a real High advisory, no lowering the audit level. `sharp`
 * is pinned at `0.35.5`. Any security dependency fix is narrow, reviewed,
 * documented in the lockfile, and folded into the FINAL RC checksum — which is
 * why the archive is built AFTER the audit and the checksum is computed from
 * the archive that actually ships.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// ───────────────────── THE RELEASE GATE PLAN ──────────────────────────────

export interface ReleaseStep {
  readonly order: number;
  readonly id: string;
  readonly what: string;
  /** The command, where there is one. */
  readonly command: string | null;
  /** Does this step's verdict come out of an exit status? */
  readonly readsExitStatus: boolean;
  /** Must it run inside the EXTRACTED ARCHIVE rather than the working tree? */
  readonly inExtractedArchive: boolean;
  /** Is it release-blocking? */
  readonly blocking: boolean;
  /** The evidence artefact id it produces. */
  readonly produces: string | null;
}

export const RELEASE_PLAN: readonly ReleaseStep[] = [
  {
    order: 1,
    id: 'runner-canary',
    what: 'prove the runner can report failure, asked OUTSIDE Vitest, before any test result in this run is trusted',
    command: 'npx tsx scripts/runner-canary.ts',
    readsExitStatus: true,
    inExtractedArchive: false,
    blocking: true,
    produces: null,
  },
  {
    order: 2,
    id: 'skip-flags-refused',
    what: 'fail BEFORE running anything if any RELEASE_GATE_SKIP_* is set',
    command: null,
    readsExitStatus: false,
    inExtractedArchive: false,
    blocking: true,
    produces: null,
  },
  {
    order: 3,
    id: 'merge-base',
    what: 'verify PHASE4_BASE against git merge-base — never assume it',
    command: 'npx tsx scripts/phase4-secret-scan.ts --verify-base-only',
    readsExitStatus: true,
    inExtractedArchive: false,
    blocking: true,
    produces: null,
  },
  {
    order: 4,
    id: 'secret-history-range',
    what: 'the Phase 4 range scan over PHASE4_BASE..head with the pinned checksum-verified gitleaks',
    command: 'npm run scan:secrets:phase4',
    readsExitStatus: true,
    inExtractedArchive: false,
    blocking: true,
    produces: 'E-05',
  },
  {
    order: 5,
    id: 'migration-hashes',
    what: 'every migration file hashes to its manifest digest AND its prefix-module digest',
    command: 'npx tsx scripts/phase4-s9/run.ts --migration-hashes',
    readsExitStatus: true,
    inExtractedArchive: true,
    blocking: true,
    produces: 'E-04',
  },
  {
    order: 6,
    id: 'supply-chain',
    what: 'npm audit --audit-level=high, release-blocking, no --force, no allowlist, sharp pinned at 0.35.5',
    command: 'npm audit --audit-level=high && npm run check:supply-chain',
    readsExitStatus: true,
    inExtractedArchive: false,
    blocking: true,
    produces: 'E-07',
  },
  {
    order: 7,
    id: 'inventories-fresh',
    what: 'the three generated inventories agree with the live tree',
    command: 'npx tsx scripts/phase4-s8/generate-inventories.ts --check',
    readsExitStatus: true,
    inExtractedArchive: true,
    blocking: true,
    produces: 'E-13',
  },
  {
    order: 8,
    id: 'fresh-cluster',
    what: 'PROOF (A): a fresh cluster, 0000 -> candidate, then a second pass that must be a no-op',
    command: 'npm run check:db-from-zero',
    readsExitStatus: true,
    inExtractedArchive: true,
    blocking: true,
    produces: 'E-02',
  },
  {
    order: 9,
    id: 'upgrade-rehearsal',
    what: 'PROOF (B): a REAL upgrade from the frozen predecessor prefix to the candidate, performed as the non-superuser deployment principal, then the catalogue diffed against a superuser build',
    command: 'npx tsx scripts/phase4-s9/run.ts --upgrade-rehearsal',
    readsExitStatus: true,
    inExtractedArchive: true,
    blocking: true,
    produces: 'E-03',
  },
  {
    order: 10,
    id: 'composed-gates',
    what: 'gate:phase3:release and gate:phase4:s8, composed VERBATIM and INTERNALLY — the release gate runs as ONE command from an extracted archive with no workflow around it',
    command: 'npm run gate:phase4:release',
    readsExitStatus: true,
    inExtractedArchive: true,
    blocking: true,
    produces: 'E-01',
  },
  {
    order: 11,
    id: 'rc-archive',
    what: 'build DAFTAR_PHASE_4_RC.zip with a SIBLING .sha256 — never inside the zip, because a hash of a file containing its own hash is not computable',
    command: 'npm run export:release:phase4',
    readsExitStatus: true,
    inExtractedArchive: false,
    blocking: true,
    produces: 'E-06',
  },
  {
    order: 12,
    id: 'archive-rerun',
    what: 'extract the archive into a CLEAN directory and run gate:phase4:release again THERE, on a NEW cluster',
    command: 'npx tsx scripts/phase4-s9/run.ts --archive-rerun',
    readsExitStatus: true,
    inExtractedArchive: true,
    blocking: true,
    produces: 'E-01',
  },
  {
    order: 13,
    id: 'evidence-index',
    what: 'assemble the evidence index and the release report, and refuse the forbidden TD-08 vocabulary in both',
    command: 'npx tsx scripts/phase4-s9/run.ts --report',
    readsExitStatus: true,
    inExtractedArchive: false,
    blocking: true,
    produces: null,
  },
];

export const SKIP_FLAG_PREFIX = 'RELEASE_GATE_SKIP_';

/** Any `RELEASE_GATE_SKIP_*` present in the environment. The gate fails BEFORE running anything. */
export function skipFlagProblems(env: Readonly<Record<string, string | undefined>>): string[] {
  const set = Object.keys(env).filter((key) => key.startsWith(SKIP_FLAG_PREFIX) && env[key] !== undefined && env[key] !== '');
  return set.length === 0 ? [] : [`${set.join(', ')} is set — the release gate fails BEFORE running anything rather than running a reduced matrix`];
}

/**
 * The plan's own laws.
 *
 * The one that is easy to get wrong: a step that reads a verdict out of an
 * exit status may not come BEFORE the runner canary, because until the canary
 * has run, a zero exit status in this environment means nothing.
 */
export function releasePlanProblems(plan: readonly ReleaseStep[] = RELEASE_PLAN): string[] {
  const problems: string[] = [];
  if (plan.length === 0) problems.push('the release plan is EMPTY');
  const ordered = [...plan].sort((a, b) => a.order - b.order);
  const canaryAt = ordered.findIndex((s) => s.id === 'runner-canary');
  if (canaryAt === -1) problems.push('no runner canary — a gate that reads a verdict out of an exit status must FIRST prove that status can say NO');
  else if (canaryAt !== 0)
    problems.push(`the runner canary is step ${(canaryAt + 1).toString()} and must be FIRST: every exit status read before it is unreadable`);
  for (let i = 0; i < ordered.length; i += 1) {
    const step = ordered[i];
    if (step === undefined) continue;
    if (step.readsExitStatus && canaryAt !== -1 && i < canaryAt)
      problems.push(`${step.id} reads an exit status before the canary has proved one can be non-zero`);
    if (step.blocking && step.command === null && step.id !== 'skip-flags-refused')
      problems.push(`${step.id} is blocking and names no command, so nothing executes it`);
  }
  const skipAt = ordered.findIndex((s) => s.id === 'skip-flags-refused');
  if (skipAt > 2) problems.push('the RELEASE_GATE_SKIP_* refusal is not near the front — it must fail BEFORE running anything');
  // BOTH deployment proofs, and the archive re-run AFTER the archive is built.
  if (!ordered.some((s) => s.id === 'fresh-cluster')) problems.push('no fresh-cluster step — proof (A) is missing');
  if (!ordered.some((s) => s.id === 'upgrade-rehearsal')) problems.push('no upgrade-rehearsal step — proof (B) is missing, and A never implies B');
  const archiveAt = ordered.findIndex((s) => s.id === 'rc-archive');
  const rerunAt = ordered.findIndex((s) => s.id === 'archive-rerun');
  if (archiveAt !== -1 && rerunAt !== -1 && rerunAt < archiveAt) problems.push('the archive re-run precedes the archive build');
  const auditAt = ordered.findIndex((s) => s.id === 'supply-chain');
  if (auditAt !== -1 && archiveAt !== -1 && archiveAt < auditAt)
    problems.push(
      'the RC archive is built BEFORE the dependency audit — any security dependency fix must be folded into the FINAL RC checksum, so the archive is built after',
    );
  return problems;
}

// ───────────────── THE FORBIDDEN SUPPLY-CHAIN REMEDIES ────────────────────

export const SHARP_PIN = '0.35.5';

export interface AuditInvocation {
  readonly command: string;
  readonly level: string;
  readonly ignoredAdvisories: readonly string[];
  readonly allowlist: readonly string[];
}

export function auditProblems(invocation: AuditInvocation): string[] {
  const problems: string[] = [];
  if (/--force\b/.test(invocation.command)) problems.push('`--force` in the audit or fix command — a forced resolution is not a reviewed fix');
  if (invocation.level !== 'high')
    problems.push(`the audit level is ${invocation.level} and must be high — lowering it is not a fix, it is a change of subject`);
  if (invocation.ignoredAdvisories.length > 0)
    problems.push(
      `${invocation.ignoredAdvisories.length.toString()} advisory/advisories ignored (${invocation.ignoredAdvisories.join(', ')}) — no advisory ignore for a real High`,
    );
  if (invocation.allowlist.length > 0)
    problems.push(`an allowlist of ${invocation.allowlist.length.toString()} entry/entries — no allowlist for a real High advisory`);
  return problems;
}

/** `sharp` is pinned at 0.35.5. Read from the lockfile, not from `package.json`'s range. */
export function sharpPinProblems(root: string): string[] {
  const lock = join(root, 'package-lock.json');
  if (!existsSync(lock)) return ['package-lock.json is absent, so no pin can be verified'];
  const parsed = JSON.parse(readFileSync(lock, 'utf8')) as { packages?: Record<string, { version?: string }> };
  const entries = Object.entries(parsed.packages ?? {}).filter(([path]) => path.endsWith('node_modules/sharp'));
  if (entries.length === 0) return [];
  const problems: string[] = [];
  for (const [path, entry] of entries)
    if (entry.version !== SHARP_PIN) problems.push(`${path} resolves sharp to ${entry.version ?? 'an unrecorded version'} and the pin is ${SHARP_PIN}`);
  return problems;
}

// ───────────────── THE MIGRATION HASH VERIFIER ────────────────────────────

export interface MigrationHashRow {
  readonly name: string;
  readonly onDisk: string;
  readonly inManifest: string | null;
  readonly inPrefixModule: string | null;
  readonly agrees: boolean;
}

export interface ManifestShape {
  readonly frozenThrough: string;
  readonly migrations: readonly { readonly name: string; readonly sha256: string }[];
}

/**
 * Every migration on disk, against the manifest and against the accepted
 * prefix modules. THREE sources, because two can agree while both are wrong:
 * the whole point of `scripts/phase4-budget-ratchet.ts` keeping an independent
 * copy is the same point here, and the same honest weakness applies — one
 * commit could change all three. That weakness is recorded rather than
 * claimed away.
 */
export function verifyMigrationHashes(root: string, prefixDigests: ReadonlyMap<string, string>): MigrationHashRow[] {
  const dir = join(root, 'infrastructure/database/migrations');
  const manifestPath = join(root, 'infrastructure/database/MIGRATION_MANIFEST.json');
  const manifest = existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as ManifestShape) : { frozenThrough: '', migrations: [] };
  const byName = new Map(manifest.migrations.map((m) => [m.name, m.sha256]));
  const rows: MigrationHashRow[] = [];
  if (!existsSync(dir)) return rows;
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.sql')) continue;
    const onDisk = createHash('sha256')
      .update(readFileSync(join(dir, name)))
      .digest('hex');
    const inManifest = byName.get(name) ?? null;
    const inPrefixModule = prefixDigests.get(name) ?? null;
    // A CANDIDATE — a file past `frozenThrough` — is legitimately absent from
    // both. `[[daftar-a-closure-rule-is-not-an-invariant]]`: nothing here says
    // "no migration may exist after N", so a candidate is not a finding.
    const candidate = name > manifest.frozenThrough;
    const agrees = candidate
      ? (inManifest === null || inManifest === onDisk) && (inPrefixModule === null || inPrefixModule === onDisk)
      : inManifest === onDisk && (inPrefixModule === null || inPrefixModule === onDisk);
    rows.push({ name, onDisk, inManifest, inPrefixModule, agrees });
  }
  return rows;
}

export function migrationHashProblems(rows: readonly MigrationHashRow[]): string[] {
  const problems: string[] = [];
  if (rows.length === 0) problems.push('no migration file was found — an empty migration estate is never a verified one');
  for (const row of rows)
    if (!row.agrees)
      problems.push(
        `${row.name}: on disk ${row.onDisk.slice(0, 12)}…, manifest ${row.inManifest === null ? 'ABSENT' : `${row.inManifest.slice(0, 12)}…`}, ` +
          `prefix module ${row.inPrefixModule === null ? 'absent' : `${row.inPrefixModule.slice(0, 12)}…`}`,
      );
  return problems;
}

// ───────────────── THE RC ARCHIVE AND ITS SHA256 ──────────────────────────

export const ARCHIVE_NAME = 'DAFTAR_PHASE_4_RC.zip';

/**
 * The sibling `.sha256`, never a member of the archive.
 *
 * A checksum file inside the archive it describes is not computable: adding it
 * changes the bytes it is a hash of. So it is a SIBLING, and the format is the
 * `sha256sum` one so an operator can verify it with the tool they already
 * have.
 */
export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function renderSiblingChecksum(archiveName: string, digest: string): string {
  return `${digest}  ${archiveName}\n`;
}

export function archiveProblems(root: string, archiveName: string = ARCHIVE_NAME): string[] {
  const archive = join(root, 'release', archiveName);
  const sibling = `${archive}.sha256`;
  const problems: string[] = [];
  if (!existsSync(archive)) return [`${archiveName} is absent — nothing to checksum`];
  if (!existsSync(sibling)) return [`${archiveName}.sha256 is absent — the archive ships without the checksum an operator verifies it with`];
  const expected = sha256File(archive);
  const recorded = readFileSync(sibling, 'utf8').trim().split(/\s+/)[0] ?? '';
  if (recorded !== expected) problems.push(`${archiveName}.sha256 records ${recorded.slice(0, 16)}… and the archive hashes to ${expected.slice(0, 16)}…`);
  if (!readFileSync(sibling, 'utf8').includes(archiveName))
    problems.push(`${archiveName}.sha256 does not name the file it describes, so it cannot be verified with sha256sum -c`);
  return problems;
}

// ───────────────── THE EXTRACTED-ARCHIVE AND UPGRADE PROCEDURES ────────────

export interface ProcedureStep {
  readonly id: string;
  readonly what: string;
  /** The reason this step exists. A step with no reason is a step nobody can safely delete. */
  readonly why: string;
}

/**
 * `[[daftar-a-check-only-asked-where-it-passes]]`: DAFTAR's release gate failed
 * THREE TIMES the first time it ran on a clean runner and inside an extracted
 * archive, and NONE of the three was a product defect. Every step below exists
 * because of one of those classes of failure.
 */
export const EXTRACTED_ARCHIVE_PROCEDURE: readonly ProcedureStep[] = [
  {
    id: 'A-1',
    what: 'extract the archive into a NEW, EMPTY directory outside the repository',
    why: 'an extraction over the working tree inherits the working tree files the archive forgot',
  },
  {
    id: 'A-2',
    what: 'run `npm ci` there, from the archive own lockfile',
    why: 'a gate that reuses the repository node_modules is not asked whether the archive can install',
  },
  {
    id: 'A-3',
    what: 'start a NEW cluster on a UNIQUE PG_DIR and PG_PORT, and tear it down afterwards',
    why: 'an explicitly-set PG_DIR is never torn down by the harness, and a shared data directory is another run state',
  },
  {
    id: 'A-4',
    what: 'ASSERT that every `@daftar/*` import resolves INSIDE the extracted directory and that each workspace package is built from it',
    why: 'npm writes workspace links as RELATIVE symlinks, so a `node_modules` that leads anywhere else makes the whole run a statement about another tree — measured twice in one day in this container, and repointing alone leaves every entry point unbuilt and every import TS2307',
  },
  {
    id: 'A-5',
    what: 'run the gate with NO environment inherited from the outer run except the cluster coordinates',
    why: 'an inherited variable is how a gate passes in one shell and fails in a clean one',
  },
  {
    id: 'A-6',
    what: 'assert the gate is runnable as ONE command with no workflow around it',
    why: 'gate:phase4:release composes gate:phase3:release and gate:phase4:s8 VERBATIM and INTERNALLY for exactly this reason',
  },
  {
    id: 'A-7',
    what: 'assert there is NO `.git` in the extracted directory, and that every history-dependent check reports that it cannot run rather than passing',
    why: 'a range scan with no history to scan must say so; a tree-mode scan is the substitute and is labelled as one',
  },
];

export const UPGRADE_REHEARSAL_PROCEDURE: readonly ProcedureStep[] = [
  {
    id: 'U-1',
    what: 'build a database at the FROZEN PREDECESSOR PREFIX only — the manifest `frozenThrough` of the previous seal, not the candidate head',
    why: 'proof (B) starts from what is deployed, not from what is being released',
  },
  {
    id: 'U-2',
    what: 'hand every `postgres`-owned object in `public` to `daftar_migrator`',
    why: 'a managed deployment holds migrator ownership, and a rehearsal that keeps superuser ownership rehearses nothing',
  },
  {
    id: 'U-3',
    what: 'apply the candidate migrations AS `daftar_migrator`, never as a superuser',
    why: 'a superuser has every privilege the migration might have forgotten to grant and owns every object it might have forgotten to hand over',
  },
  { id: 'U-4', what: 'apply them a SECOND time and require a no-op', why: 'an upgrade that is not idempotent cannot be retried after a partial failure' },
  {
    id: 'U-5',
    what: 'build a SECOND database fresh from `0000` as a superuser, and DIFF the catalogue against the upgraded one',
    why: 'the diff is what catches the forgotten GRANT: a GRANT issued without grant option WARNS and COMMITS, so an ordering mistake produces a green migration and a missing privilege',
  },
  {
    id: 'U-6',
    what: 'diff relations, columns, constraints, policies, routines, grants, ownership and `relforcerowsecurity` — not merely "the migrations applied"',
    why: 'the two questions a superuser suite is never asked are "who owns it" and "who may do what to it"',
  },
  { id: 'U-7', what: 'report the diff as a FINDING against the owning slice, never as something S9 fixes', why: 'S9 is evidence only' },
];

export function procedureProblems(steps: readonly ProcedureStep[], label: string): string[] {
  const problems: string[] = [];
  if (steps.length === 0) problems.push(`${label}: the procedure is EMPTY`);
  // A DUPLICATE id is how a step comes to be read as the step above it and
  // skipped. Added because inserting the resolution-containment step produced
  // exactly that, and nothing was asking.
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id))
      problems.push(`${label} ${step.id}: declared twice — a duplicated id is how one of the two steps comes to be read as the other and skipped`);
    ids.add(step.id);
  }
  for (const step of steps) {
    if (step.what.trim() === '') problems.push(`${label} ${step.id}: no action`);
    if (step.why.trim() === '') problems.push(`${label} ${step.id}: no reason — a step with no reason is a step nobody can safely delete`);
  }
  return problems;
}

/** The catalogue dimensions the upgrade diff must cover. A missing dimension is an unasked question. */
export const CATALOGUE_DIMENSIONS: readonly string[] = [
  'relations',
  'columns',
  'constraints',
  'indexes',
  'policies',
  'routines',
  'grants',
  'ownership',
  'row-security-forced',
  'triggers',
  'sequences',
  'types',
];

export function catalogueDiffProblems(covered: readonly string[]): string[] {
  const missing = CATALOGUE_DIMENSIONS.filter((d) => !covered.includes(d));
  return missing.length === 0
    ? []
    : [
        `the upgrade catalogue diff covers ${covered.length.toString()} of ${CATALOGUE_DIMENSIONS.length.toString()} dimensions; missing ${missing.join(', ')} — the ones most often missing are grants and ownership, which are the two questions a superuser suite is never asked`,
      ];
}

/** `git rev-parse HEAD`, or null outside a worktree — used to stamp the evidence. */
export function headSha(root: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}
