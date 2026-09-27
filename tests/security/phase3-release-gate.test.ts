/**
 * T-03 — THE PHASE 3 RELEASE GATE'S OWN REFUSALS, ITS PLAN, AND FORWARD
 * EVOLUTION (docs/PHASE_3_S9_CONTRACT.md §2, A-03, A-08, §7 T-03).
 *
 *   (a) any `RELEASE_GATE_SKIP_*` fails the gate before a single step runs,
 *       and the artefact it writes says so;
 *   (b) `--list` plans exactly the eight steps of §2, all mandatory, in order;
 *   (c) statically, the gate spawns no git, reads no repository directory and
 *       names no migration after the Phase 3 prefix;
 *   (d) `--root <copy> --structural-only` refuses a tampered Phase 3 file, a
 *       stale claim and a Phase 2 delivery manifest, and passes the intact
 *       copy AND the copy plus a synthetic frozen successor `0070`: the
 *       lesson of the P2-S9 "no migration after 0052" assertion, proven.
 *
 * No composed gate is run here. The copies hold only what the structural
 * half reads: the migrations, the manifest and the Phase 3 pages.
 *
 * The copies carry release-state pages written here, not the repository's
 * own: the pages are the coordinator's to bring to the release state, and
 * their real content is checked by the gate itself on every run (step 4) and
 * the claim patterns by T-04. The manifest is taken to the P3-S8 freeze when
 * the repository has not reached it yet (see T-01).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PHASE3_PREFIX, PHASE3_PREFIX_END } from '../../scripts/phase3-prefix';
import { PHASE3_AUTHORITATIVE_DOCS } from '../../scripts/phase3-release-gate';

const REPO = join(__dirname, '../..');
const GATE = join(REPO, 'scripts/phase3-release-gate.ts');
const TSX = join(REPO, 'node_modules/.bin/tsx');
const MIGRATIONS = 'infrastructure/database/migrations';
const MANIFEST = 'infrastructure/database/MIGRATION_MANIFEST.json';

type Manifest = { frozenThrough: string; migrations: { name: string; sha256: string }[] } & Record<string, unknown>;

const temporaries: string[] = [];
afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

const sha256 = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex');
const tempDir = (tag: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `daftar-p3-release-${tag}-`));
  temporaries.push(dir);
  return dir;
};

/** Release-state Phase 3 pages: each makes the required statements and no stale claim. */
function releasePages(): Record<string, string> {
  const pages: Record<string, string> = {};
  for (const rel of PHASE3_AUTHORITATIVE_DOCS) pages[rel] = `# ${rel}\n\nP3-S8 is accepted and frozen; the migration history is frozen through 0069.\n`;
  pages['PROJECT_STATUS.md'] += '\n- **OD-03 — purchase tax: OPEN.** A non-zero purchase tax is refused.\n';
  pages['docs/PHASE_3_S9_RELEASE.md'] += '\nPurchase tax stays BLOCKED BY OD-03. Branch protection is MAIN_PROTECTION_EXTERNAL_BLOCKER.\n';
  return pages;
}

function write(root: string, rel: string, contents: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), contents);
}

/** What the structural half reads: migrations, the manifest at the S8 freeze, and the pages. */
function structuralCopy(): string {
  const root = tempDir('copy');
  mkdirSync(join(root, MIGRATIONS), { recursive: true });
  for (const f of readdirSync(join(REPO, MIGRATIONS))) if (f.endsWith('.sql')) copyFileSync(join(REPO, MIGRATIONS, f), join(root, MIGRATIONS, f));
  const manifest = JSON.parse(readFileSync(join(REPO, MANIFEST), 'utf8')) as Manifest;
  const frozen = manifest.migrations.some((m) => m.name === PHASE3_PREFIX_END)
    ? manifest
    : {
        ...manifest,
        frozenThrough: PHASE3_PREFIX_END,
        migrations: [...manifest.migrations, { name: PHASE3_PREFIX_END, sha256: sha256(readFileSync(join(REPO, MIGRATIONS, PHASE3_PREFIX_END))) }],
      };
  write(root, MANIFEST, `${JSON.stringify(frozen, null, 2)}\n`);
  for (const [rel, text] of Object.entries(releasePages())) write(root, rel, text);
  return root;
}

interface Run {
  readonly status: number | null;
  readonly output: string;
  readonly artefact: { verdict?: string; mandatorySkipped?: number; steps?: { name: string; command: string; mandatory: boolean; status: string }[] };
}

function gate(args: readonly string[], env: Record<string, string> = {}): Run {
  const evidence = join(tempDir('evidence'), 'gate.json');
  const res = spawnSync(TSX, [GATE, ...args, `--evidence=${evidence}`], { cwd: REPO, encoding: 'utf8', env: { ...process.env, ...env } });
  const artefact = JSON.parse(readFileSync(evidence, 'utf8')) as Run['artefact'];
  return { status: res.status, output: `${res.stdout ?? ''}${res.stderr ?? ''}`, artefact };
}

const structural = (root: string): Run => gate(['--root', root, '--structural-only']);

describe('(a) a mandatory skip fails the gate before anything runs', () => {
  it('RELEASE_GATE_SKIP_X=1 → exit 1, artefact FAIL, mandatorySkipped 1, no step', () => {
    const run = gate([], { RELEASE_GATE_SKIP_X: '1' });
    expect(run.status).toBe(1);
    expect(run.output).toContain('REFUSED: a release verdict may not be produced with RELEASE_GATE_SKIP_X set.');
    expect(run.output).not.toContain('── ');
    expect(run.artefact).toMatchObject({ verdict: 'FAIL', mandatorySkipped: 1, steps: [] });
  });
});

describe('(b) --list plans exactly the eight steps of §2', () => {
  it('in order, all mandatory, canary first, the Phase 2 release gate before the P3-S8 gate with the restore between', () => {
    const run = gate(['--list']);
    expect(run.status, run.output).toBe(0);
    expect(run.artefact.verdict).toBe('LISTED');
    const steps = run.artefact.steps ?? [];
    expect(steps).toHaveLength(8);
    expect(steps.every((s) => s.mandatory && s.status === 'skipped')).toBe(true);
    const commands = steps.map((s) => s.command);
    expect(commands[0]).toBe('npx tsx scripts/runner-canary.ts');
    expect(steps[1]?.name).toMatch(/tree identity.*phase 3/);
    expect(steps[2]?.name).toMatch(/Phase 3 migration prefix 0053–0069 intact; later migrations permitted/);
    expect(steps[3]?.name).toMatch(/no authoritative Phase 3 document contradicts the accepted state/);
    expect(commands.slice(1, 4)).toEqual(['(in process)', '(in process)', '(in process)']);
    expect(commands[4]).toMatch(/^npm run -s gate:phase2:release -- --evidence=\S+\/phase2-release-gate\.json --log-dir=\S+\/phase2$/);
    expect(steps[5]?.name).toMatch(/apps\/api|API build output is removed/);
    expect(commands[5]).toBe('(in process)');
    expect(commands[6]).toBe('npm run -s gate:phase3:s8');
    expect(commands[7]).toBe('npm run -s rehearse:phase3:deployed');
  });

  it('forwards --archive-sha256 to the Phase 2 release gate verbatim', () => {
    const run = gate(['--list', '--archive-sha256=abc123']);
    expect(run.artefact.steps?.[4]?.command).toMatch(/ --archive-sha256=abc123$/);
  });
});

describe('(c) statically: no git, no repository directory, no migration after the prefix', () => {
  const source = readFileSync(GATE, 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('spawns no git and reads no .git', () => {
    expect(code).not.toMatch(/['"`]git['"`]/);
    expect(code).not.toMatch(/['"`][^'"`\n]*\.git\b[^'"`\n]*['"`]/);
    expect(code).not.toMatch(/\bgit\s+(ls-files|rev-parse|status|archive)\b/);
  });

  it('names no migration after the Phase 3 prefix, and asserts nothing about "no migration after"', () => {
    expect(source).not.toMatch(/\b0(0[7-9]\d|[1-9]\d\d)_/);
    expect(code).not.toMatch(/AddsNoMigration|no migration (may exist )?after/i);
  });

  it('the plan is the one §2 names: it composes the predecessor gates by name', () => {
    expect(code).toContain("'gate:phase2:release'");
    expect(code).toContain("'gate:phase3:s8'");
    expect(code).toContain("'rehearse:phase3:deployed'");
    expect(code).toContain('checkPhase3Prefix(');
  });
});

describe('(d) --root <copy> --structural-only', () => {
  it('PASS on the intact copy, with no release verdict', () => {
    const run = structural(structuralCopy());
    expect(run.status, run.output).toBe(0);
    expect(run.artefact.verdict).toBe('STRUCTURAL_PASS');
    expect(run.artefact.steps?.map((s) => s.status)).toEqual(['pass', 'pass', 'pass']);
    expect(run.output).not.toContain('gate:phase2:release');
  });

  it('PASS on the copy plus a synthetic frozen 0070 with its manifest entry (forward evolution)', () => {
    const root = structuralCopy();
    const successor = '0070_fixture_successor.sql';
    const body = '-- fixture only: a later phase\nselect 1;\n';
    write(root, `${MIGRATIONS}/${successor}`, body);
    const m = JSON.parse(readFileSync(join(root, MANIFEST), 'utf8')) as Manifest;
    write(
      root,
      MANIFEST,
      `${JSON.stringify({ ...m, frozenThrough: successor, migrations: [...m.migrations, { name: successor, sha256: sha256(body) }] }, null, 2)}\n`,
    );
    const run = structural(root);
    expect(run.status, run.output).toBe(0);
    expect(run.artefact.verdict).toBe('STRUCTURAL_PASS');
  });

  it('FAIL on one byte changed in a Phase 3 file', () => {
    const root = structuralCopy();
    const name = PHASE3_PREFIX[5]?.[0] ?? '';
    const bytes = readFileSync(join(root, MIGRATIONS, name));
    bytes.writeUInt8(bytes.readUInt8(10) ^ 0x01, 10);
    writeFileSync(join(root, MIGRATIONS, name), bytes);
    const run = structural(root);
    expect(run.status).toBe(1);
    expect(run.artefact.verdict).toBe('FAIL');
    expect(run.output).toContain(`${name} hashes to`);
  });

  it('FAIL on a planted stale claim', () => {
    const root = structuralCopy();
    write(root, 'PROJECT_STATUS.md', `${readFileSync(join(root, 'PROJECT_STATUS.md'), 'utf8')}\nThe next step is P3-S8.\n`);
    const run = structural(root);
    expect(run.status).toBe(1);
    expect(run.output).toMatch(/PROJECT_STATUS\.md:\d+ still names P3-S8 as the next step/);
  });

  it('FAIL on a delivery manifest that says phase 2', () => {
    const root = structuralCopy();
    write(root, 'DELIVERY_MANIFEST.json', `${JSON.stringify({ phase: 2, inventory: [], treeHash: sha256('') }, null, 2)}\n`);
    const run = structural(root);
    expect(run.status).toBe(1);
    expect(run.output).toContain('DELIVERY_MANIFEST.json says phase 2; the Phase 3 release gate gates a Phase 3 candidate only');
    expect(run.artefact.steps?.[0]?.status).toBe('fail');
  });

  it('PASS on a delivery manifest that says phase 3', () => {
    const root = structuralCopy();
    write(root, 'DELIVERY_MANIFEST.json', `${JSON.stringify({ phase: 3, inventory: [], treeHash: sha256('') }, null, 2)}\n`);
    const run = structural(root);
    expect(run.status, run.output).toBe(0);
  });
});
