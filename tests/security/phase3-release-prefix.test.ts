/**
 * T-01 — THE PHASE 3 PREFIX MUST BE ABLE TO SAY BOTH YES AND NO
 * (docs/PHASE_3_S9_CONTRACT.md A-03, §7 T-01, T-12).
 *
 * `scripts/phase3-prefix.ts` protects the accepted Phase 3 migrations
 * 0053–0069 as a literal copy of their digests and permits every later
 * migration. This file proves it in both directions, on throwaway copies of
 * the migrations directory and the manifest (the method of
 * `tests/security/phase2-release-prefix.test.ts`). Nothing in this repository
 * is written to; the successor `0070` exists in the copy only.
 *
 * ── Before and after the P3-S8 freeze ────────────────────────────────────
 *
 * The literal's 0069 digest is the one the S8 freeze records. Until that
 * freeze commit, the manifest does not yet list 0069 and `frozenThrough` is
 * still 0068, and `S8_ACCEPTED` in `scripts/phase3-s8-gate.ts` is empty. So:
 *   - the literal is compared with `S8_ACCEPTED` when that is non-empty, and
 *     with the digest of the 0069 file on disk otherwise;
 *   - each copy is taken to the S8 freeze state when the real manifest has
 *     not reached it (0069 appended at its on-disk digest, `frozenThrough`
 *     moved to it). After the freeze this changes nothing;
 *   - the real tree is expected to PASS once frozen, and before that to fail
 *     for exactly the two freeze reasons and nothing else.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PHASE2_PREFIX } from '../../scripts/phase2-prefix';
import { PHASE3_PREFIX, PHASE3_PREFIX_END, PHASE3_PREFIX_START, PHASE3_SLICE_HEADS, checkPhase3Prefix } from '../../scripts/phase3-prefix';
import { S8_MIGRATION_NAME } from '../../scripts/phase3-s8-gate';

const REPO = join(__dirname, '../..');
const MIGRATIONS = 'infrastructure/database/migrations';
const MANIFEST = 'infrastructure/database/MIGRATION_MANIFEST.json';

type Manifest = { frozenThrough: string; migrations: { name: string; sha256: string }[] } & Record<string, unknown>;

const temporaries: string[] = [];
afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

const sha256 = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex');
const realManifest = (): Manifest => JSON.parse(readFileSync(join(REPO, MANIFEST), 'utf8')) as Manifest;
const onDisk = (name: string): string => sha256(readFileSync(join(REPO, MIGRATIONS, name)));
const nameAt = (i: number): string => {
  const pair = PHASE3_PREFIX[i];
  if (pair === undefined) throw new Error(`no Phase 3 prefix entry ${i}`);
  return pair[0];
};

/** True while the real manifest has not yet recorded the S8 freeze. */
const freezePending = (): boolean => !realManifest().migrations.some((m) => m.name === PHASE3_PREFIX_END);

/** The manifest as the S8 freeze leaves it: unchanged once the freeze has happened. */
function atS8Freeze(m: Manifest): Manifest {
  if (m.migrations.some((e) => e.name === PHASE3_PREFIX_END)) return m;
  return { ...m, frozenThrough: PHASE3_PREFIX_END, migrations: [...m.migrations, { name: PHASE3_PREFIX_END, sha256: onDisk(PHASE3_PREFIX_END) }] };
}

/** `S8_ACCEPTED` as `scripts/phase3-s8-gate.ts` states it, read from its source (it is not exported). */
function s8Accepted(): Record<string, string> {
  const source = readFileSync(join(REPO, 'scripts/phase3-s8-gate.ts'), 'utf8');
  const decl = /const S8_ACCEPTED\s*:[^=]*=\s*\{([^}]*)\}/.exec(source);
  if (decl === null) throw new Error('scripts/phase3-s8-gate.ts no longer declares S8_ACCEPTED as an object literal');
  const body = decl[1] ?? '';
  return Object.fromEntries([...body.matchAll(/['"]?([0-9A-Za-z_.]+)['"]?\s*:\s*['"]([0-9a-f]{64})['"]/g)].map((m) => [m[1] ?? '', m[2] ?? '']));
}

/** A throwaway tree holding the migrations and the manifest at the S8 freeze. */
function tree(): { root: string; dir: string; manifest: () => Manifest; write: (m: Manifest) => void; manifestPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'daftar-p3-prefix-'));
  temporaries.push(root);
  const dir = join(root, MIGRATIONS);
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(join(REPO, MIGRATIONS))) if (f.endsWith('.sql')) copyFileSync(join(REPO, MIGRATIONS, f), join(dir, f));
  const manifestPath = join(root, MANIFEST);
  const write = (m: Manifest): void => writeFileSync(manifestPath, `${JSON.stringify(m, null, 2)}\n`);
  write(atS8Freeze(realManifest()));
  const manifest = (): Manifest => JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  return { root, dir, manifest, write, manifestPath };
}

const check = (t: ReturnType<typeof tree>): string[] => checkPhase3Prefix(t.dir, t.manifestPath);
const M0053 = nameAt(0);
const M0060 = nameAt(7);
const M0063 = nameAt(10);
const OFFSET = PHASE2_PREFIX.length;

describe('the accepted Phase 3 prefix literal', () => {
  it('is 17 migrations, 0053 through 0069, in order', () => {
    expect(PHASE3_PREFIX).toHaveLength(17);
    expect(PHASE3_PREFIX_START).toBe('0053_inventory_units_and_product_configuration.sql');
    expect(PHASE3_PREFIX_END).toBe('0069_inventory_reconciliation_read_and_account_domain.sql');
    const names = PHASE3_PREFIX.map(([n]) => n);
    expect([...names].sort()).toEqual(names);
    PHASE3_PREFIX.forEach(([n, digest], i) => {
      expect(n.startsWith(`${String(OFFSET + i).padStart(4, '0')}_`)).toBe(true);
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it('equals the manifest entries that follow the Phase 2 prefix (53–68, and 69 once the S8 freeze records it)', () => {
    const recorded = realManifest().migrations.slice(OFFSET, OFFSET + PHASE3_PREFIX.length);
    expect(recorded.length).toBe(freezePending() ? PHASE3_PREFIX.length - 1 : PHASE3_PREFIX.length);
    expect(recorded.map((m) => [m.name, m.sha256])).toEqual(PHASE3_PREFIX.slice(0, recorded.length).map(([n, s]) => [n, s]));
  });

  it('carries the P3-S8 file the S8 gate names, at S8_ACCEPTED once frozen and at its on-disk digest before', () => {
    expect(PHASE3_PREFIX_END).toBe(S8_MIGRATION_NAME);
    const accepted = s8Accepted();
    const literal = PHASE3_PREFIX[PHASE3_PREFIX.length - 1]?.[1];
    if (Object.keys(accepted).length > 0) expect(accepted).toEqual({ [PHASE3_PREFIX_END]: literal });
    else expect(literal).toBe(onDisk(PHASE3_PREFIX_END));
  });

  it('names each accepted slice head, in order, from the literal', () => {
    const names = PHASE3_PREFIX.map(([n]) => n);
    const heads = Object.values(PHASE3_SLICE_HEADS);
    expect(Object.keys(PHASE3_SLICE_HEADS)).toEqual(['P3-S1', 'P3-S2', 'P3-S3', 'P3-S4', 'P3-S5', 'P3-S6', 'P3-S7', 'P3-S8']);
    for (const h of heads) expect(names).toContain(h);
    expect([...heads].sort()).toEqual(heads);
    expect(PHASE3_SLICE_HEADS['P3-S8']).toBe(PHASE3_PREFIX_END);
  });

  it('names no migration after 0069, so it needs no edit for any later phase', () => {
    expect(readFileSync(join(REPO, 'scripts/phase3-prefix.ts'), 'utf8')).not.toMatch(/\b0(0[7-9]\d|[1-9]\d\d)_/);
  });
});

describe('the repository itself', () => {
  it('passes once the S8 freeze is recorded, and before it fails only for the freeze', () => {
    const problems = checkPhase3Prefix(join(REPO, MIGRATIONS), join(REPO, MANIFEST));
    if (!freezePending()) {
      expect(problems).toEqual([]);
      return;
    }
    expect(problems).toEqual([
      `frozenThrough is ${realManifest().frozenThrough}; the Phase 3 prefix must stay frozen through ${PHASE3_PREFIX_END}`,
      `the manifest ends before entry ${OFFSET + PHASE3_PREFIX.length - 1} (${PHASE3_PREFIX_END}) of the Phase 3 prefix`,
    ]);
  });
});

describe('must PASS', () => {
  it('the intact tree at the S8 freeze', () => {
    expect(check(tree())).toEqual([]);
  });

  it('the tree plus a synthetic frozen successor 0070 in the copy only (forward evolution)', () => {
    const t = tree();
    const successor = '0070_fixture_successor.sql';
    writeFileSync(join(t.dir, successor), '-- fixture only: a later phase\nselect 1;\n');
    const m = t.manifest();
    t.write({
      ...m,
      frozenThrough: successor,
      migrations: [...m.migrations, { name: successor, sha256: sha256('-- fixture only: a later phase\nselect 1;\n') }],
    });
    expect(check(t)).toEqual([]);
  });
});

describe('must FAIL', () => {
  it('one byte changed in a Phase 3 migration', () => {
    for (const name of [M0053, M0063, PHASE3_PREFIX_END]) {
      const t = tree();
      const bytes = readFileSync(join(t.dir, name));
      bytes.writeUInt8(bytes.readUInt8(bytes.length - 1) ^ 0x01, bytes.length - 1);
      writeFileSync(join(t.dir, name), bytes);
      expect(check(t).join('\n')).toContain(`${name} hashes to`);
    }
  });

  it('one byte changed AND its manifest digest updated to match', () => {
    const t = tree();
    const bytes = readFileSync(join(t.dir, M0063));
    bytes.writeUInt8(bytes.readUInt8(0) ^ 0x01, 0);
    writeFileSync(join(t.dir, M0063), bytes);
    const m = t.manifest();
    t.write({ ...m, migrations: m.migrations.map((e) => (e.name === M0063 ? { ...e, sha256: sha256(bytes) } : e)) });
    const problems = check(t).join('\n');
    expect(problems).toContain(`${M0063} hashes to`);
    expect(problems).toContain(`the manifest records ${M0063}`);
  });

  it('a Phase 3 migration deleted', () => {
    const t = tree();
    unlinkSync(join(t.dir, M0060));
    expect(check(t).join('\n')).toContain(`${M0060} belongs to the accepted Phase 3 prefix but is missing`);
  });

  it('a Phase 3 migration renamed', () => {
    const t = tree();
    const renamed = M0060.replace(/\.sql$/, '_renamed.sql');
    renameSync(join(t.dir, M0060), join(t.dir, renamed));
    const problems = check(t).join('\n');
    expect(problems).toContain(`${M0060} belongs to the accepted Phase 3 prefix but is missing`);
    expect(problems).toContain(`${renamed} is in the Phase 3 range`);
  });

  it('a Phase 3 migration moved out of the range, past 0069', () => {
    const t = tree();
    renameSync(join(t.dir, M0060), join(t.dir, '0099_moved.sql'));
    expect(check(t).join('\n')).toContain(`${M0060} belongs to the accepted Phase 3 prefix but is missing`);
  });

  it('a file inserted into the Phase 3 range', () => {
    const t = tree();
    writeFileSync(join(t.dir, '0060a_inserted.sql'), 'select 1;\n');
    expect(check(t).join('\n')).toContain('0060a_inserted.sql is in the Phase 3 range');
  });

  it('the order of the prefix changed in the manifest', () => {
    const t = tree();
    const m = t.manifest();
    const migrations = [...m.migrations];
    const a = migrations[OFFSET + 6];
    const b = migrations[OFFSET + 7];
    if (a === undefined || b === undefined) throw new Error('the manifest is shorter than the prefix');
    migrations[OFFSET + 6] = b;
    migrations[OFFSET + 7] = a;
    t.write({ ...m, migrations });
    expect(check(t).join('\n')).toContain(`manifest entry ${OFFSET + 6} is ${M0060}`);
  });

  it('the name of a prefix entry changed in the manifest', () => {
    const t = tree();
    const m = t.manifest();
    const changed = M0060.replace(/\.sql$/, '_x.sql');
    t.write({ ...m, migrations: m.migrations.map((e) => (e.name === M0060 ? { ...e, name: changed } : e)) });
    expect(check(t).join('\n')).toContain(`manifest entry ${OFFSET + 7} is ${changed}`);
  });

  it('a Phase 3 entry removed from the manifest', () => {
    const t = tree();
    const m = t.manifest();
    t.write({ ...m, migrations: m.migrations.filter((e) => e.name !== M0060) });
    expect(check(t).join('\n')).toContain(`manifest entry ${OFFSET + 7} is ${nameAt(8)}`);
  });

  it('the expected digest of a Phase 3 migration changed in the manifest', () => {
    const t = tree();
    const m = t.manifest();
    t.write({ ...m, migrations: m.migrations.map((e) => (e.name === M0060 ? { ...e, sha256: 'f'.repeat(64) } : e)) });
    expect(check(t).join('\n')).toContain(`the manifest records ${M0060} at ffffffffffff…`);
  });

  it('frozenThrough moved below 0069', () => {
    const t = tree();
    const below = nameAt(PHASE3_PREFIX.length - 2);
    t.write({ ...t.manifest(), frozenThrough: below });
    expect(check(t).join('\n')).toContain(`frozenThrough is ${below}`);
  });
});

describe('the standalone check (T-12: the ci.yml step) exits 0 and 1', () => {
  const tsx = join(REPO, 'node_modules/.bin/tsx');
  const run = (root: string) => spawnSync(tsx, [join(REPO, 'scripts/phase3-prefix.ts'), `--root=${root}`], { encoding: 'utf8' });

  it('0 on an intact tree, 1 on a tampered one', () => {
    const good = tree();
    const ok = run(good.root);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain('PASS Phase 3 migration prefix');

    const bad = tree();
    unlinkSync(join(bad.dir, M0060));
    const refused = run(bad.root);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(`${M0060} belongs to the accepted Phase 3 prefix but is missing`);
  });

  it('ci.yml runs both prefix checks in the backend job', () => {
    const ci = readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('run: npx tsx scripts/phase2-prefix.ts');
    expect(ci).toContain('run: npx tsx scripts/phase3-prefix.ts');
  });
});
