/**
 * T-01 — THE PHASE 3 PREFIX MUST BE ABLE TO SAY BOTH YES AND NO
 * (docs/PHASE_3_S9_CONTRACT.md A-03, §7 T-01, T-12; the Tech Lead's final
 * seal of 2026-09-29).
 *
 * `scripts/phase3-prefix.ts` protects the final Phase 3 migration history,
 * 0053–0073, as a literal copy of the digests: the slices' 0053–0069 and the
 * corrective hardening's 0070–0073, provenance kept apart. It permits every
 * later migration. This file proves it in both directions, on throwaway
 * copies of the migrations directory and the manifest (the method of
 * `tests/security/phase2-release-prefix.test.ts`). Nothing in this repository
 * is written to; the successor `0074` exists in the copy only, and no real
 * 0074 exists.
 *
 * Until the seal, this file also carried the scaffolding for the moment
 * before the P3-S8 freeze (0069 on disk but not yet in the manifest). Both
 * freezes are recorded now, so the copies are taken from the real manifest
 * as it stands.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PHASE2_PREFIX } from '../../scripts/phase2-prefix';
import { CORRECTIVE_ACCEPTED, CORRECTIVE_MIGRATIONS } from '../../scripts/phase3-corrective-gate';
import {
  PHASE3_CORRECTIVE_PREFIX,
  PHASE3_PREFIX,
  PHASE3_PREFIX_END,
  PHASE3_PREFIX_START,
  PHASE3_SLICE_HEADS,
  PHASE3_SLICE_PREFIX,
  PHASE3_SLICE_PREFIX_END,
  checkPhase3Prefix,
} from '../../scripts/phase3-prefix';
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
const nameAt = (i: number): string => {
  const pair = PHASE3_PREFIX[i];
  if (pair === undefined) throw new Error(`no Phase 3 prefix entry ${i}`);
  return pair[0];
};

/** `S8_ACCEPTED` as `scripts/phase3-s8-gate.ts` states it, read from its source (it is not exported). */
function s8Accepted(): Record<string, string> {
  const source = readFileSync(join(REPO, 'scripts/phase3-s8-gate.ts'), 'utf8');
  const decl = /const S8_ACCEPTED\s*:[^=]*=\s*\{([^}]*)\}/.exec(source);
  if (decl === null) throw new Error('scripts/phase3-s8-gate.ts no longer declares S8_ACCEPTED as an object literal');
  const body = decl[1] ?? '';
  return Object.fromEntries([...body.matchAll(/['"]?([0-9A-Za-z_.]+)['"]?\s*:\s*['"]([0-9a-f]{64})['"]/g)].map((m) => [m[1] ?? '', m[2] ?? '']));
}

/** A throwaway tree holding the migrations and the manifest as they stand. */
function tree(): { root: string; dir: string; manifest: () => Manifest; write: (m: Manifest) => void; manifestPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'daftar-p3-prefix-'));
  temporaries.push(root);
  const dir = join(root, MIGRATIONS);
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(join(REPO, MIGRATIONS))) if (f.endsWith('.sql')) copyFileSync(join(REPO, MIGRATIONS, f), join(dir, f));
  const manifestPath = join(root, MANIFEST);
  const write = (m: Manifest): void => writeFileSync(manifestPath, `${JSON.stringify(m, null, 2)}\n`);
  write(realManifest());
  const manifest = (): Manifest => JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  return { root, dir, manifest, write, manifestPath };
}

const check = (t: ReturnType<typeof tree>): string[] => checkPhase3Prefix(t.dir, t.manifestPath);
const M0053 = nameAt(0);
const M0060 = nameAt(7);
const M0063 = nameAt(10);
const M0069 = PHASE3_SLICE_PREFIX_END;
const corrective = (i: number): string => PHASE3_CORRECTIVE_PREFIX[i]?.[0] ?? `(no corrective entry ${i})`;
const M0070 = corrective(0);
const M0071 = corrective(1);
const M0072 = corrective(2);
const M0073 = corrective(3);
const OFFSET = PHASE2_PREFIX.length;

describe('the accepted Phase 3 prefix literal', () => {
  it('is 21 migrations, 0053 through 0073, in order: 17 slice migrations through 0069, then 4 corrective ones', () => {
    expect(PHASE3_PREFIX).toHaveLength(21);
    expect(PHASE3_SLICE_PREFIX).toHaveLength(17);
    expect(PHASE3_CORRECTIVE_PREFIX).toHaveLength(4);
    expect(PHASE3_PREFIX).toEqual([...PHASE3_SLICE_PREFIX, ...PHASE3_CORRECTIVE_PREFIX]);
    expect(PHASE3_PREFIX_START).toBe('0053_inventory_units_and_product_configuration.sql');
    expect(PHASE3_SLICE_PREFIX_END).toBe('0069_inventory_reconciliation_read_and_account_domain.sql');
    expect(PHASE3_PREFIX_END).toBe('0073_default_warehouse_locale_name.sql');
    const names = PHASE3_PREFIX.map(([n]) => n);
    expect([...names].sort()).toEqual(names);
    PHASE3_PREFIX.forEach(([n, digest], i) => {
      expect(n.startsWith(`${String(OFFSET + i).padStart(4, '0')}_`)).toBe(true);
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it('equals the manifest entries that follow the Phase 2 prefix (53–73)', () => {
    const recorded = realManifest().migrations.slice(OFFSET, OFFSET + PHASE3_PREFIX.length);
    expect(recorded.map((m) => [m.name, m.sha256])).toEqual(PHASE3_PREFIX.map(([n, s]) => [n, s]));
  });

  it('carries the P3-S8 file the S8 gate names, at S8_ACCEPTED, as the end of the slice prefix', () => {
    expect(PHASE3_SLICE_PREFIX_END).toBe(S8_MIGRATION_NAME);
    expect(s8Accepted()).toEqual({ [PHASE3_SLICE_PREFIX_END]: PHASE3_SLICE_PREFIX[PHASE3_SLICE_PREFIX.length - 1]?.[1] });
  });

  it('carries the corrective hardening as the corrective gate froze it: CORRECTIVE_MIGRATIONS in order, at CORRECTIVE_ACCEPTED', () => {
    expect(PHASE3_CORRECTIVE_PREFIX.map(([n]) => n)).toEqual([...CORRECTIVE_MIGRATIONS]);
    expect(Object.fromEntries(PHASE3_CORRECTIVE_PREFIX.map(([n, d]) => [n, d]))).toEqual(CORRECTIVE_ACCEPTED);
  });

  it('names each accepted slice head, in order, from the slice literal', () => {
    const names = PHASE3_SLICE_PREFIX.map(([n]) => n);
    const heads = Object.values(PHASE3_SLICE_HEADS);
    expect(Object.keys(PHASE3_SLICE_HEADS)).toEqual(['P3-S1', 'P3-S2', 'P3-S3', 'P3-S4', 'P3-S5', 'P3-S6', 'P3-S7', 'P3-S8']);
    for (const h of heads) expect(names).toContain(h);
    expect([...heads].sort()).toEqual(heads);
    expect(PHASE3_SLICE_HEADS['P3-S8']).toBe(PHASE3_SLICE_PREFIX_END);
  });

  it('names no migration after 0073, so it needs no edit for any later phase', () => {
    expect(readFileSync(join(REPO, 'scripts/phase3-prefix.ts'), 'utf8')).not.toMatch(/\b0(07[4-9]|0[89]\d|[1-9]\d\d)_/);
  });
});

describe('the repository itself', () => {
  it('passes: the final Phase 3 history is intact and frozen', () => {
    expect(checkPhase3Prefix(join(REPO, MIGRATIONS), join(REPO, MANIFEST))).toEqual([]);
  });
});

describe('must PASS', () => {
  it('the exact accepted 0053–0073', () => {
    expect(check(tree())).toEqual([]);
  });

  it('the accepted prefix plus a synthetic frozen successor 0074 in the copy only (forward evolution)', () => {
    const t = tree();
    const successor = '0074_fixture_successor.sql';
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
    for (const name of [M0053, M0063, M0069, M0070, M0073]) {
      const t = tree();
      const bytes = readFileSync(join(t.dir, name));
      bytes.writeUInt8(bytes.readUInt8(bytes.length - 1) ^ 0x01, bytes.length - 1);
      writeFileSync(join(t.dir, name), bytes);
      expect(check(t).join('\n')).toContain(`${name} hashes to`);
    }
  });

  it('one byte changed AND its manifest digest updated to match', () => {
    for (const name of [M0063, M0072]) {
      const t = tree();
      const bytes = readFileSync(join(t.dir, name));
      bytes.writeUInt8(bytes.readUInt8(0) ^ 0x01, 0);
      writeFileSync(join(t.dir, name), bytes);
      const m = t.manifest();
      t.write({ ...m, migrations: m.migrations.map((e) => (e.name === name ? { ...e, sha256: sha256(bytes) } : e)) });
      const problems = check(t).join('\n');
      expect(problems).toContain(`${name} hashes to`);
      expect(problems).toContain(`the manifest records ${name}`);
    }
  });

  it('a Phase 3 migration deleted', () => {
    for (const name of [M0060, M0071, M0073]) {
      const t = tree();
      unlinkSync(join(t.dir, name));
      expect(check(t).join('\n')).toContain(`${name} belongs to the accepted Phase 3 prefix but is missing`);
    }
  });

  it('a Phase 3 migration renamed', () => {
    for (const name of [M0060, M0072]) {
      const t = tree();
      const renamed = name.replace(/\.sql$/, '_renamed.sql');
      renameSync(join(t.dir, name), join(t.dir, renamed));
      const problems = check(t).join('\n');
      expect(problems).toContain(`${name} belongs to the accepted Phase 3 prefix but is missing`);
      expect(problems).toContain(`${renamed} is in the Phase 3 range`);
    }
  });

  it('a Phase 3 migration moved out of the range, past 0073', () => {
    for (const name of [M0060, M0070]) {
      const t = tree();
      renameSync(join(t.dir, name), join(t.dir, '0099_moved.sql'));
      expect(check(t).join('\n')).toContain(`${name} belongs to the accepted Phase 3 prefix but is missing`);
    }
  });

  it('a file inserted into the Phase 3 range, among the slices or among the corrective migrations', () => {
    for (const inserted of ['0060a_inserted.sql', '0071a_inserted.sql']) {
      const t = tree();
      writeFileSync(join(t.dir, inserted), 'select 1;\n');
      expect(check(t).join('\n')).toContain(`${inserted} is in the Phase 3 range`);
    }
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

  it('the order of the corrective migrations changed in the manifest', () => {
    const t = tree();
    const m = t.manifest();
    const migrations = [...m.migrations];
    const a = migrations[OFFSET + 17];
    const b = migrations[OFFSET + 18];
    if (a === undefined || b === undefined) throw new Error('the manifest is shorter than the prefix');
    migrations[OFFSET + 17] = b;
    migrations[OFFSET + 18] = a;
    t.write({ ...m, migrations });
    expect(check(t).join('\n')).toContain(`manifest entry ${OFFSET + 17} is ${M0071}`);
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
    for (const name of [M0060, M0070, M0073]) {
      const t = tree();
      const m = t.manifest();
      t.write({ ...m, migrations: m.migrations.map((e) => (e.name === name ? { ...e, sha256: 'f'.repeat(64) } : e)) });
      expect(check(t).join('\n')).toContain(`the manifest records ${name} at ffffffffffff…`);
    }
  });

  it('frozenThrough moved before 0073: to 0072, or back to the original S9 boundary 0069', () => {
    for (const below of [M0072, M0069]) {
      const t = tree();
      t.write({ ...t.manifest(), frozenThrough: below });
      expect(check(t).join('\n')).toContain(`frozenThrough is ${below}; the Phase 3 prefix must stay frozen through ${M0073}`);
    }
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
