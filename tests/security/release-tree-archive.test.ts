/**
 * T-05 — THE TREE CHECKS, END TO END, THROUGH THE PHASE 3 RELEASE GATE
 * (docs/PHASE_3_S9_CONTRACT.md A-04, A-08, §7 T-05).
 *
 * `gate:phase3:release` does not re-implement the tree checks: step 5 runs
 * `gate:phase2:release` verbatim, which asks them of the same root. This file
 * proves that composition end to end. Each case runs the REAL Phase 3 gate in
 * a hard-linked copy of the delivered tree that carries a
 * `DELIVERY_MANIFEST.json` built with the export's algorithm, plants exactly
 * one defect, and requires the gate to stop red on it:
 *
 *   - a `.git/` in the tree            → step 5 ("the gated tree contains .git")
 *   - a `.env` in the tree             → step 5 ("the gated tree contains .env")
 *   - one inventoried file, one byte   → step 5 ("does not hash to what the inventory recorded")
 *   - a treeHash that does not recompute → step 5 ("the tree hash recomputed …")
 *   - a manifest that says `phase: 2`  → step 2 (A-08)
 *
 * Every case stops before `gate:phase1:release`, so this file stays fast: the
 * cost of each is the two runner canaries (the Phase 3 gate's and the
 * composed Phase 2 gate's).
 *
 * The copy is taken to the release state first: the migration manifest at
 * the P3-S8 freeze when the repository has not reached it yet (see T-01), and
 * release-state Phase 3 pages (the real pages are the coordinator's, and are
 * checked by step 4 on every real run and by T-04). A replaced file is
 * unlinked before it is written, so nothing reaches back into this tree.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PHASE3_PREFIX_END } from '../../scripts/phase3-prefix';
import { PHASE3_AUTHORITATIVE_DOCS } from '../../scripts/phase3-release-gate';
import { deliveredFiles } from '../helpers/delivered-files';

const REPO = join(__dirname, '../..');
const MIGRATIONS = 'infrastructure/database/migrations';
const MANIFEST = 'infrastructure/database/MIGRATION_MANIFEST.json';
const UNREAD_BY_THE_PHASE3_STEPS = 'docs/PHASE_3_EXECUTION_PLAN.md';

type Manifest = { frozenThrough: string; migrations: { name: string; sha256: string }[] } & Record<string, unknown>;
interface Delivery {
  phase: number;
  treeHash: string;
  inventory: { path: string; sha256: string; bytes: number }[];
  [key: string]: unknown;
}

const ENV_BEFORE = existsSync(join(REPO, '.env'));
const UNREAD_BEFORE = createHash('sha256')
  .update(readFileSync(join(REPO, UNREAD_BY_THE_PHASE3_STEPS)))
  .digest('hex');
const MANIFEST_BEFORE = createHash('sha256')
  .update(readFileSync(join(REPO, MANIFEST)))
  .digest('hex');

const temporaries: string[] = [];
afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

const sha256 = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex');

/** Replace a file in the copy; the unlink is what protects the original. */
function rewrite(root: string, rel: string, contents: string | Buffer): void {
  const target = join(root, rel);
  rmSync(target, { force: true });
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

/** The export's DELIVERY_MANIFEST.json for the copy as it stands (`scripts/export-release.ts`). */
function deliveryManifest(root: string, files: readonly string[]): Delivery {
  const paths = [...files].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const inventory = paths.map((path) => {
    const buf = readFileSync(join(root, path));
    return { path, sha256: sha256(buf), bytes: buf.byteLength };
  });
  const manifest = JSON.parse(readFileSync(join(root, MANIFEST), 'utf8')) as Manifest;
  const migrationHashes = paths
    .filter((p) => p.startsWith(`${MIGRATIONS}/`) && p.endsWith('.sql'))
    .map((p) => ({ name: p.slice(MIGRATIONS.length + 1), sha256: sha256(readFileSync(join(root, p))) }));
  return {
    product: 'DAFTAR',
    phase: 3,
    kind: 'release-candidate',
    generatedAt: new Date().toISOString(),
    sourceCommit: 'c'.repeat(40),
    treeHash: sha256(inventory.map((i) => `${i.path}:${i.sha256}`).join('\n')),
    treeHashAlgorithm: 'sha256 over "<relative path>:<sha256 of file bytes>" lines, sorted by path, joined with \\n',
    fileCount: inventory.length,
    gitDirty: false,
    inventory,
    migrationHashes,
    migrationCount: migrationHashes.length,
    frozenThrough: manifest.frozenThrough,
  };
}

/** A hard-linked, release-state copy of the delivered tree, carrying its delivery manifest. */
function extractedCopy(): { root: string; delivery: Delivery } {
  const root = mkdtempSync(join(tmpdir(), 'daftar-p3-archive-'));
  temporaries.push(root);
  const files = deliveredFiles(REPO).filter((rel) => rel !== 'DELIVERY_MANIFEST.json' && existsSync(join(REPO, rel)));
  for (const rel of files) {
    const target = join(root, rel);
    mkdirSync(dirname(target), { recursive: true });
    linkSync(join(REPO, rel), target);
  }
  for (const modules of ['node_modules', 'apps/web/node_modules']) {
    if (existsSync(join(REPO, modules))) symlinkSync(join(REPO, modules), join(root, modules), 'dir');
  }

  const manifest = JSON.parse(readFileSync(join(root, MANIFEST), 'utf8')) as Manifest;
  if (!manifest.migrations.some((m) => m.name === PHASE3_PREFIX_END)) {
    const digest = sha256(readFileSync(join(root, MIGRATIONS, PHASE3_PREFIX_END)));
    rewrite(
      root,
      MANIFEST,
      `${JSON.stringify({ ...manifest, frozenThrough: PHASE3_PREFIX_END, migrations: [...manifest.migrations, { name: PHASE3_PREFIX_END, sha256: digest }] }, null, 2)}\n`,
    );
  }
  const pages: Record<string, string> = {};
  for (const rel of PHASE3_AUTHORITATIVE_DOCS) pages[rel] = `# ${rel}\n\nP3-S8 is accepted and frozen; the migration history is frozen through 0069.\n`;
  pages['PROJECT_STATUS.md'] += '\n- **OD-03 — purchase tax: OPEN.** A non-zero purchase tax is refused.\n';
  pages['docs/PHASE_3_S9_RELEASE.md'] += '\nPurchase tax stays BLOCKED BY OD-03. Branch protection is MAIN_PROTECTION_EXTERNAL_BLOCKER.\n';
  for (const [rel, text] of Object.entries(pages)) rewrite(root, rel, text);

  const inventory = [...new Set([...files, ...Object.keys(pages)])];
  const delivery = deliveryManifest(root, inventory);
  rewrite(root, 'DELIVERY_MANIFEST.json', `${JSON.stringify(delivery, null, 2)}\n`);
  return { root, delivery };
}

interface GateRun {
  readonly status: number | null;
  readonly output: string;
  readonly steps: { name: string; status: string }[];
  readonly nestedSteps: string[] | null;
}

/** The real Phase 3 release gate, run inside the copy. */
function gateInCopy(root: string): GateRun {
  const evidence = join(root, 'release', 'gate.json');
  const logDir = join(root, 'release', 'logs');
  const res = spawnSync('npx', ['tsx', 'scripts/phase3-release-gate.ts', `--evidence=${evidence}`, `--log-dir=${logDir}`], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0' },
    maxBuffer: 256 * 1024 * 1024,
  });
  const artefact = JSON.parse(readFileSync(evidence, 'utf8')) as { steps: { name: string; status: string }[] };
  const nestedPath = join(logDir, 'phase2-release-gate.json');
  const nested = existsSync(nestedPath) ? (JSON.parse(readFileSync(nestedPath, 'utf8')) as { steps: { name: string }[] }).steps.map((s) => s.name) : null;
  return { status: res.status, output: `${res.stdout ?? ''}${res.stderr ?? ''}`, steps: artefact.steps, nestedSteps: nested };
}

/** Stopped red at step 5 (the sixth, after the library build), inside the composed Phase 2 gate, before the Phase 1 release gate. */
function expectStoppedInTheComposedTreeChecks(run: GateRun, message: string | RegExp): void {
  expect(run.status, run.output).toBe(1);
  expect(run.steps.map((s) => s.status)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass', 'fail']);
  expect(run.steps[5]?.name).toMatch(/Phase 2 release gate/);
  if (typeof message === 'string') expect(run.output).toContain(message);
  else expect(run.output).toMatch(message);
  expect(run.nestedSteps).not.toBeNull();
  expect(run.nestedSteps?.some((n) => /Phase 1 release gate/.test(n))).toBe(false);
}

describe('gate:phase3:release, run inside an extracted release-state copy, stops red', () => {
  it('on a planted .git/', () => {
    const { root } = extractedCopy();
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    expectStoppedInTheComposedTreeChecks(gateInCopy(root), 'the gated tree contains .git');
  });

  it('on a planted .env', () => {
    const { root } = extractedCopy();
    writeFileSync(join(root, '.env'), 'DATABASE_URL=postgres://planted\n');
    expectStoppedInTheComposedTreeChecks(gateInCopy(root), 'the gated tree contains .env');
  });

  it('on one inventoried file changed by one byte', () => {
    const { root } = extractedCopy();
    const bytes = readFileSync(join(root, UNREAD_BY_THE_PHASE3_STEPS));
    bytes.writeUInt8(bytes.readUInt8(0) ^ 0x01, 0);
    rewrite(root, UNREAD_BY_THE_PHASE3_STEPS, bytes);
    expectStoppedInTheComposedTreeChecks(gateInCopy(root), `${UNREAD_BY_THE_PHASE3_STEPS} does not hash to what the inventory recorded`);
  });

  it('on a manifest treeHash that does not recompute', () => {
    const { root, delivery } = extractedCopy();
    rewrite(root, 'DELIVERY_MANIFEST.json', `${JSON.stringify({ ...delivery, treeHash: sha256('not this tree') }, null, 2)}\n`);
    expectStoppedInTheComposedTreeChecks(gateInCopy(root), /the tree hash recomputed from the inventory is [0-9a-f]{12}…, not [0-9a-f]{12}…/);
  });

  it('on a delivery manifest that says phase 2 (A-08), at its own step 2', () => {
    const { root, delivery } = extractedCopy();
    rewrite(root, 'DELIVERY_MANIFEST.json', `${JSON.stringify({ ...delivery, phase: 2 }, null, 2)}\n`);
    const run = gateInCopy(root);
    expect(run.status, run.output).toBe(1);
    expect(run.steps.map((s) => s.status)).toEqual(['pass', 'pass', 'fail']);
    expect(run.output).toContain('DELIVERY_MANIFEST.json says phase 2; the Phase 3 release gate gates a Phase 3 candidate only');
    expect(run.nestedSteps).toBeNull();
  });

  it('left the repository untouched', () => {
    expect(existsSync(join(REPO, '.env'))).toBe(ENV_BEFORE);
    expect(sha256(readFileSync(join(REPO, UNREAD_BY_THE_PHASE3_STEPS)))).toBe(UNREAD_BEFORE);
    expect(sha256(readFileSync(join(REPO, MANIFEST)))).toBe(MANIFEST_BEFORE);
  });
});
