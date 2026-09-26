/**
 * THE CORRECTED P2-S9 ASSERTION MUST BE ABLE TO SAY BOTH YES AND NO.
 *
 * `gate:phase2:release` used to assert "no migration may exist after 0052".
 * On 2026-09-26 the Tech Lead replaced that with the historical invariant in
 * `scripts/phase2-prefix.ts`: the accepted Phase 2 prefix 0000–0052 stays
 * complete, ordered, immutable and byte-identical, and later migrations are
 * permitted. This file proves the new check against every case the decision
 * names, in both directions.
 *
 * Each case copies the real migrations directory and manifest into a
 * temporary tree, changes exactly one thing, and asks the check about the
 * copy. Nothing in this repository is written to. The successor case adds a
 * synthetic `0059` to the COPY only; no production 0059 exists.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PHASE2_PREFIX, PHASE2_PREFIX_END, checkPhase2Prefix } from '../../scripts/phase2-prefix';

const REPO = join(__dirname, '../..');
const MIGRATIONS = 'infrastructure/database/migrations';
const MANIFEST = 'infrastructure/database/MIGRATION_MANIFEST.json';

type Manifest = { frozenThrough: string; migrations: { name: string; sha256: string }[] } & Record<string, unknown>;

const temporaries: string[] = [];
afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway tree holding the migrations and manifest; `through` limits it to a prefix of the real chain. */
function tree(through?: string): { root: string; dir: string; manifestPath: string; manifest: () => Manifest; write: (m: Manifest) => void } {
  const root = mkdtempSync(join(tmpdir(), 'daftar-p2-prefix-'));
  temporaries.push(root);
  const dir = join(root, MIGRATIONS);
  mkdirSync(dir, { recursive: true });
  const real = JSON.parse(readFileSync(join(REPO, MANIFEST), 'utf8')) as Manifest;
  const keep = (name: string) => through === undefined || name <= through;
  for (const f of readdirSync(join(REPO, MIGRATIONS))) if (f.endsWith('.sql') && keep(f)) copyFileSync(join(REPO, MIGRATIONS, f), join(dir, f));
  const manifestPath = join(root, MANIFEST);
  const write = (m: Manifest) => writeFileSync(manifestPath, `${JSON.stringify(m, null, 2)}\n`);
  if (through === undefined) write(real);
  else write({ ...real, frozenThrough: through, migrations: real.migrations.filter((m) => keep(m.name)) });
  const manifest = () => JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  return { root, dir, manifestPath, manifest, write };
}

const check = (t: ReturnType<typeof tree>) => checkPhase2Prefix(t.dir, t.manifestPath);
const M0017 = PHASE2_PREFIX[17][0];
const M0051 = PHASE2_PREFIX[51][0];

describe('the accepted Phase 2 prefix literal', () => {
  it('is 53 migrations, 0000 through 0052, in order, and is the prefix of the checked-in manifest', () => {
    expect(PHASE2_PREFIX).toHaveLength(53);
    expect(PHASE2_PREFIX[0][0]).toBe('0000_extensions.sql');
    expect(PHASE2_PREFIX_END).toBe('0052_accounting_journal_lines_rls_performance.sql');
    const names = PHASE2_PREFIX.map(([n]) => n);
    expect([...names].sort()).toEqual(names);
    PHASE2_PREFIX.forEach(([n], i) => expect(n.startsWith(String(i).padStart(4, '0') + '_')).toBe(true));
    const real = JSON.parse(readFileSync(join(REPO, MANIFEST), 'utf8')) as Manifest;
    expect(real.migrations.slice(0, 53).map((m) => [m.name, m.sha256])).toEqual(PHASE2_PREFIX.map(([n, s]) => [n, s]));
  });

  it('names no migration after 0052, so it needs no edit for any later phase', () => {
    expect(readFileSync(join(REPO, 'scripts/phase2-prefix.ts'), 'utf8')).not.toMatch(/\b0(05[3-9]|0[6-9]\d|[1-9]\d\d)_/);
  });
});

describe('must PASS', () => {
  it('exactly the accepted prefix through 0052', () => {
    const t = tree(PHASE2_PREFIX_END);
    expect(readdirSync(t.dir)).toHaveLength(53);
    expect(check(t)).toEqual([]);
  });

  it('the prefix plus the frozen P3-S1 migrations (the repository as it is)', () => {
    const t = tree();
    expect(readdirSync(t.dir).length).toBeGreaterThan(53);
    expect(check(t)).toEqual([]);
  });

  it('a simulated successor 0059 in the fixture only', () => {
    const t = tree();
    writeFileSync(join(t.dir, '0059_fixture_successor.sql'), '-- fixture only: a later phase\nselect 1;\n');
    const m = t.manifest();
    t.write({ ...m, migrations: [...m.migrations, { name: '0059_fixture_successor.sql', sha256: '0'.repeat(64) }] });
    expect(check(t)).toEqual([]);
  });
});

describe('must FAIL', () => {
  it('one byte modified in a Phase 2 migration', () => {
    for (const name of [PHASE2_PREFIX[0][0], M0017, PHASE2_PREFIX_END]) {
      const t = tree();
      const bytes = readFileSync(join(t.dir, name));
      bytes[bytes.length - 1] ^= 0x01;
      writeFileSync(join(t.dir, name), bytes);
      expect(check(t).join('\n')).toContain(`${name} hashes to`);
    }
  });

  it('one byte modified AND its manifest digest updated to match', () => {
    const t = tree();
    const bytes = readFileSync(join(t.dir, M0051));
    bytes[0] ^= 0x01;
    writeFileSync(join(t.dir, M0051), bytes);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const m = t.manifest();
    t.write({ ...m, migrations: m.migrations.map((e) => (e.name === M0051 ? { ...e, sha256: digest } : e)) });
    const problems = check(t).join('\n');
    expect(problems).toContain(`${M0051} hashes to`);
    expect(problems).toContain(`the manifest records ${M0051}`);
  });

  it('one Phase 2 migration deleted', () => {
    const t = tree();
    unlinkSync(join(t.dir, M0017));
    expect(check(t).join('\n')).toContain(`${M0017} belongs to the accepted Phase 2 prefix but is missing`);
  });

  it('one Phase 2 migration renamed', () => {
    const t = tree();
    const renamed = M0017.replace(/\.sql$/, '_renamed.sql');
    renameSync(join(t.dir, M0017), join(t.dir, renamed));
    const problems = check(t).join('\n');
    expect(problems).toContain(`${M0017} belongs to the accepted Phase 2 prefix but is missing`);
    expect(problems).toContain(`${renamed} is in the Phase 2 range`);
  });

  it('a Phase 2 migration renamed past 0052, out of the prefix', () => {
    const t = tree();
    renameSync(join(t.dir, M0017), join(t.dir, '0099_moved.sql'));
    expect(check(t).join('\n')).toContain(`${M0017} belongs to the accepted Phase 2 prefix but is missing`);
  });

  it('a file inserted into the Phase 2 range', () => {
    const t = tree();
    writeFileSync(join(t.dir, '0017a_inserted.sql'), 'select 1;\n');
    expect(check(t).join('\n')).toContain('0017a_inserted.sql is in the Phase 2 range');
  });

  it('the ordering of the prefix changed in the manifest', () => {
    const t = tree();
    const m = t.manifest();
    const migrations = [...m.migrations];
    [migrations[16], migrations[17]] = [migrations[17], migrations[16]];
    t.write({ ...m, migrations });
    expect(check(t).join('\n')).toContain(`manifest entry 16 is ${M0017}`);
  });

  it('the identity of a prefix entry changed in the manifest', () => {
    const t = tree();
    const m = t.manifest();
    t.write({ ...m, migrations: m.migrations.map((e) => (e.name === M0017 ? { ...e, name: M0017.replace(/\.sql$/, '_x.sql') } : e)) });
    expect(check(t).join('\n')).toContain(`manifest entry 17 is ${M0017.replace(/\.sql$/, '_x.sql')}`);
  });

  it('a Phase 2 entry removed from the manifest', () => {
    const t = tree();
    const m = t.manifest();
    t.write({ ...m, migrations: m.migrations.filter((e) => e.name !== M0051) });
    expect(check(t).join('\n')).toContain(`manifest entry 51 is ${PHASE2_PREFIX_END}`);
  });

  it('the expected hash of a Phase 2 migration changed in the manifest', () => {
    const t = tree();
    const m = t.manifest();
    t.write({ ...m, migrations: m.migrations.map((e) => (e.name === M0017 ? { ...e, sha256: 'f'.repeat(64) } : e)) });
    expect(check(t).join('\n')).toContain(`the manifest records ${M0017} at ffffffffffff…`);
  });

  it('frozenThrough moved back inside the prefix', () => {
    const t = tree();
    t.write({ ...t.manifest(), frozenThrough: M0051 });
    expect(check(t).join('\n')).toContain(`frozenThrough is ${M0051}`);
  });
});

describe('the release gate runs this check, and its exit status can say no', () => {
  const tsx = join(REPO, 'node_modules/.bin/tsx');
  const run = (root: string) => spawnSync(tsx, [join(REPO, 'scripts/phase2-prefix.ts'), `--root=${root}`], { encoding: 'utf8' });

  it('the standalone check exits 0 on an intact tree and 1 on a tampered one', () => {
    const good = tree();
    const ok = run(good.root);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain('PASS Phase 2 migration prefix');

    const bad = tree();
    unlinkSync(join(bad.dir, M0017));
    const refused = run(bad.root);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(`${M0017} belongs to the accepted Phase 2 prefix but is missing`);
  });

  it('gate:phase2:release plans the corrected step and no longer carries the old assertion', () => {
    const evidence = join(mkdtempSync(join(tmpdir(), 'daftar-p2-list-')), 'gate.json');
    temporaries.push(join(evidence, '..'));
    const listed = spawnSync(tsx, [join(REPO, 'scripts/phase2-release-gate.ts'), '--list', `--evidence=${evidence}`], { cwd: REPO, encoding: 'utf8' });
    expect(listed.stdout).toContain('Phase 2 migration prefix 0000–0052 intact (P2-S9, corrected)');
    expect(listed.stdout).not.toContain('P2-S9 creates no migration');
    const source = readFileSync(join(REPO, 'scripts/phase2-release-gate.ts'), 'utf8');
    expect(source).toContain('checkPhase2Prefix(');
    expect(source).not.toMatch(/function phase2s9AddsNoMigration/);
  });
});
