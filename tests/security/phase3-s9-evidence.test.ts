/**
 * T-07 — THE P3-S9 EVIDENCE ASSEMBLER REFUSES EVERY INCONSISTENCY IT IS FOR
 * (docs/PHASE_3_S9_CONTRACT.md A-13, §5.3, §7 T-07).
 *
 * `scripts/phase3-s9-evidence.ts` runs here on synthetic artefacts in a
 * temporary release directory: a real small zip built with `zip -X` and its
 * sidecar, a pax tar of the same tree in the form `git archive` writes (with
 * the commit id in its global header), two Phase 3 gate artefacts with their
 * nested Phase 2 artefacts, and the deployment and deployed-rehearsal
 * artefacts of both runs. The consistent set must PASS; each case changes one
 * thing and must FAIL with its own named problem.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PHASE2_PREFIX } from '../../scripts/phase2-prefix';
import { PHASE3_PREFIX, PHASE3_PREFIX_END } from '../../scripts/phase3-prefix';

const REPO = join(__dirname, '../..');
const TSX = join(REPO, 'node_modules/.bin/tsx');
const SHA = 'a1'.repeat(20);
const OTHER_SHA = 'b2'.repeat(20);

const temporaries: string[] = [];
afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

const sha256 = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex');
type Json = Record<string, unknown>;

// ── a tar in the form git archive writes ─────────────────────────────────

function tarHeader(name: string, size: number, type: string): Buffer {
  const h = Buffer.alloc(512, 0);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write('0000644\0', 100, 'ascii');
  h.write('0000000\0', 108, 'ascii');
  h.write('0000000\0', 116, 'ascii');
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  h.write(`${'0'.repeat(11)}\0`, 136, 'ascii');
  h.write(' '.repeat(8), 148, 'ascii');
  h.write(type, 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  const sum = h.reduce((a, b) => a + b, 0);
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return h;
}

function tarEntry(name: string, body: Buffer, type = '0'): Buffer {
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512, 0);
  return Buffer.concat([tarHeader(name, body.length, type), body, pad]);
}

function gitArchiveTar(commit: string, files: Readonly<Record<string, string>>): Buffer {
  const record = (key: string, value: string): string => {
    const tail = ` ${key}=${value}\n`;
    let len = tail.length + 1;
    while (`${len}${tail}`.length !== len) len = `${len}${tail}`.length;
    return `${len}${tail}`;
  };
  const parts = [tarEntry('pax_global_header', Buffer.from(record('comment', commit)), 'g'), tarEntry('DAFTAR/', Buffer.alloc(0), '5')];
  for (const [path, text] of Object.entries(files)) parts.push(tarEntry(`DAFTAR/${path}`, Buffer.from(text)));
  parts.push(Buffer.alloc(1024, 0));
  return Buffer.concat(parts);
}

// ── the consistent set, and one change at a time ─────────────────────────

const FILES: Readonly<Record<string, string>> = {
  'package.json': '{ "name": "daftar" }\n',
  'scripts/phase3-release-gate.ts': 'export {};\n',
  'infrastructure/database/MIGRATION_MANIFEST.json': '{}\n',
};

interface Fixture {
  files?: Record<string, string>;
  zipExtra?: Record<string, string>;
  delivery?: (d: Json) => Json;
  sidecar?: (digest: string) => string;
  tarCommit?: string;
  tarFiles?: Record<string, string>;
  repoGate?: (g: Json) => Json;
  archiveGate?: (g: Json) => Json;
  deployment?: (d: Json) => Json;
  archiveDeployment?: (d: Json) => Json;
  rehearsal?: (r: Json) => Json;
  archiveRehearsal?: (r: Json) => Json;
  expectedSha?: string | null;
}

function write(path: string, contents: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function inventoryOf(files: Readonly<Record<string, string>>): { path: string; sha256: string; bytes: number }[] {
  return Object.keys(files)
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map((path) => ({ path, sha256: sha256(files[path] ?? ''), bytes: Buffer.byteLength(files[path] ?? '') }));
}

function gate(kind: 'source-checkout' | 'extracted-archive', treeHash: string, archiveSha: string | null): Json {
  const manifest = kind === 'extracted-archive' ? { phase: 3, sourceCommit: SHA, treeHash } : null;
  return {
    produced: 'scripts/phase3-release-gate.ts',
    phase: 3,
    structuralOnly: false,
    verdict: 'PASS',
    mandatorySkipped: 0,
    summary: { total: 8, pass: 8, fail: 0, skipped: 0 },
    tree: { kind, deliveryManifest: manifest, archiveSha256: archiveSha },
    environment: { database: { pgPort: kind === 'source-checkout' ? 5432 : 55432 } },
    steps: [],
    nested: {
      'gate:phase2:release': {
        present: true,
        verdict: 'PASS',
        mandatorySkipped: 0,
        summary: { fail: 0 },
        tree: { kind, treeHash: manifest ? treeHash : null, sourceCommit: manifest ? SHA : null },
      },
    },
  };
}

const deploymentArtefact = (): Json => ({
  verdict: 'PASS',
  staticOnly: false,
  postgres: 'postgres (PostgreSQL) 16.4',
  findings: [],
  roleMatrix: [
    { role: 'daftar_migrator', temporaryOnDatabase: true, createOnPublic: true },
    { role: 'daftar_app', temporaryOnDatabase: false, createOnPublic: false },
    { role: 'daftar_reconciler', temporaryOnDatabase: false, createOnPublic: false },
  ],
});

function assemble(f: Fixture = {}): { status: number | null; output: string; evidence: { verdict: string; problems: string[] } & Json } {
  const dir = mkdtempSync(join(tmpdir(), 'daftar-p3s9-evidence-'));
  temporaries.push(dir);
  const files = f.files ?? { ...FILES };
  const inventory = inventoryOf(files);
  const treeHash = sha256(inventory.map((i) => `${i.path}:${i.sha256}`).join('\n'));
  const baseDelivery: Json = {
    product: 'DAFTAR',
    phase: 3,
    kind: 'release-candidate',
    generatedAt: '2026-09-27T00:00:00.000Z',
    sourceCommit: SHA,
    treeHash,
    treeHashAlgorithm: 'sha256 over "<relative path>:<sha256 of file bytes>" lines, sorted by path, joined with \\n',
    fileCount: inventory.length,
    gitDirty: false,
    inventory,
    migrationHashes: [...PHASE2_PREFIX, ...PHASE3_PREFIX].map(([name, digest]) => ({ name, sha256: digest })),
    migrationCount: PHASE2_PREFIX.length + PHASE3_PREFIX.length,
    frozenThrough: PHASE3_PREFIX_END,
    migrationManifestSha256: sha256('{}\n'),
    environment: { node: 'v24.12.0' },
  };
  const delivery = f.delivery ? f.delivery(baseDelivery) : baseDelivery;

  const staging = join(dir, 'staging');
  for (const [path, text] of Object.entries({ ...files, ...(f.zipExtra ?? {}) })) write(join(staging, 'DAFTAR', path), text);
  write(join(staging, 'DAFTAR', 'DELIVERY_MANIFEST.json'), `${JSON.stringify(delivery, null, 2)}\n`);
  const zip = join(dir, 'DAFTAR_PHASE_3_RC.zip');
  execFileSync('zip', ['-qrX', zip, 'DAFTAR'], { cwd: staging });
  const zipSha = sha256(readFileSync(zip));
  write(`${zip}.sha256`, `${f.sidecar ? f.sidecar(zipSha) : zipSha}  DAFTAR_PHASE_3_RC.zip\n`);

  const tar = join(dir, 'git-archive.tar');
  write(tar, gitArchiveTar(f.tarCommit ?? SHA, f.tarFiles ?? files));

  const repoGate = gate('source-checkout', treeHash, null);
  const archiveGate = gate('extracted-archive', treeHash, zipSha);
  write(join(dir, 'phase3-s9-release-gate.json'), JSON.stringify(f.repoGate ? f.repoGate(repoGate) : repoGate));
  write(join(dir, 'phase3-s9-release-gate-archive.json'), JSON.stringify(f.archiveGate ? f.archiveGate(archiveGate) : archiveGate));
  write(join(dir, 'phase2-s9-deployment-authority.json'), JSON.stringify(f.deployment ? f.deployment(deploymentArtefact()) : deploymentArtefact()));
  write(
    join(dir, 'phase2-s9-deployment-authority-archive.json'),
    JSON.stringify(f.archiveDeployment ? f.archiveDeployment(deploymentArtefact()) : deploymentArtefact()),
  );
  write(join(dir, 'phase3-s9-deployed-rehearsal.json'), JSON.stringify(f.rehearsal ? f.rehearsal({ verdict: 'PASS' }) : { verdict: 'PASS' }));
  write(
    join(dir, 'phase3-s9-deployed-rehearsal-archive.json'),
    JSON.stringify(f.archiveRehearsal ? f.archiveRehearsal({ verdict: 'PASS' }) : { verdict: 'PASS' }),
  );

  const expected = f.expectedSha === undefined ? SHA : f.expectedSha;
  const args = [join(REPO, 'scripts/phase3-s9-evidence.ts'), `--release-dir=${dir}`, `--git-archive=${tar}`, '--ci-run=123'];
  if (expected !== null) args.push(`--expected-sha=${expected}`);
  const res = spawnSync(TSX, args, { cwd: REPO, encoding: 'utf8', env: { ...process.env, GITHUB_SHA: '' } });
  const evidence = JSON.parse(readFileSync(join(dir, 'phase3-s9-release-evidence.json'), 'utf8')) as { verdict: string; problems: string[] } & Json;
  return { status: res.status, output: `${res.stdout ?? ''}${res.stderr ?? ''}`, evidence };
}

function expectRefused(f: Fixture, problem: string | RegExp): void {
  const run = assemble(f);
  expect(run.status, run.output).toBe(1);
  expect(run.evidence.verdict).toBe('FAIL');
  const joined = run.evidence.problems.join('\n');
  if (typeof problem === 'string') expect(joined).toContain(problem);
  else expect(joined).toMatch(problem);
}

const withNested = (g: Json, change: Json): Json => {
  const nested = (g['nested'] as Record<string, Json>)['gate:phase2:release'] ?? {};
  return { ...g, nested: { 'gate:phase2:release': { ...nested, ...change } } };
};

describe('the consistent set', () => {
  it('PASS, with the commit, both routes to the content, and the 70 migrations recorded', () => {
    const run = assemble();
    expect(run.evidence.problems).toEqual([]);
    expect(run.status, run.output).toBe(0);
    expect(run.evidence.verdict).toBe('PASS');
    expect(run.evidence['source']).toMatchObject({ expectedCommit: SHA, commit: SHA });
    expect(run.evidence['gitArchive']).toMatchObject({ commit: SHA, fileCount: Object.keys(FILES).length });
    expect((run.evidence['migrations'] as { count: number }).count).toBe(70);
  });
});

describe('each inconsistency is refused with its own problem', () => {
  it('no --expected-sha', () => expectRefused({ expectedSha: null }, '--expected-sha is required'));
  it('a sidecar that does not match the archive', () =>
    expectRefused({ sidecar: () => 'f'.repeat(64) }, /DAFTAR_PHASE_3_RC\.zip\.sha256 records ffffffffffff… but the archive hashes to/));
  it('a forbidden entry, DAFTAR/.env', () => expectRefused({ zipExtra: { '.env': 'SECRET=1\n' } }, 'the archive carries forbidden content: DAFTAR/.env'));
  it('an archive gate that ran on a source checkout', () =>
    expectRefused(
      { archiveGate: (g) => ({ ...g, tree: { ...(g['tree'] as Json), kind: 'source-checkout' } }) },
      'the extracted archive gate reports tree kind "source-checkout"',
    ));
  it('an archive gate that ran on another tree hash', () =>
    expectRefused(
      { archiveGate: (g) => ({ ...g, tree: { ...(g['tree'] as Json), deliveryManifest: { phase: 3, sourceCommit: SHA, treeHash: 'e'.repeat(64) } } }) },
      /the archive gate ran against tree hash eeeeeeeeeeee…/,
    ));
  it('an archive gate that ran on another commit', () =>
    expectRefused(
      {
        archiveGate: (g) => ({
          ...g,
          tree: {
            ...(g['tree'] as Json),
            deliveryManifest: {
              phase: 3,
              sourceCommit: OTHER_SHA,
              treeHash: (g['tree'] as { deliveryManifest: { treeHash: string } }).deliveryManifest.treeHash,
            },
          },
        }),
      },
      `the archive gate ran against commit ${OTHER_SHA}`,
    ));
  it('an archive exported from a commit that is not --expected-sha', () =>
    expectRefused({ expectedSha: OTHER_SHA, tarCommit: OTHER_SHA }, `the archive was exported from commit ${SHA}, not the commit under release ${OTHER_SHA}`));
  it('a git archive of another commit', () => expectRefused({ tarCommit: OTHER_SHA }, `the git archive was made of commit ${OTHER_SHA}`));
  it('a git archive whose content differs by one file', () =>
    expectRefused({ tarFiles: { ...FILES, 'package.json': '{ "name": "other" }\n' } }, /the git archive's tree hash is [0-9a-f]{12}…, not the export's/));
  it('a git archive with a different path set', () =>
    expectRefused({ tarFiles: { ...FILES, 'extra.txt': 'x\n' } }, 'the git archive and the export list different files: only in git [extra.txt]'));
  it('a delivery manifest that says phase 2', () => expectRefused({ delivery: (d) => ({ ...d, phase: 2 }) }, 'the delivery manifest says phase 2'));
  it('a migration list with an extra 0070', () =>
    expectRefused(
      { delivery: (d) => ({ ...d, migrationHashes: [...(d['migrationHashes'] as Json[]), { name: '0070_later.sql', sha256: '0'.repeat(64) }] }) },
      /are not exactly the Phase 2 and Phase 3 prefixes \(P3-S9 adds none\): extra \[0070_later\.sql\]/,
    ));
  it('a migration list with a changed digest', () =>
    expectRefused(
      {
        delivery: (d) => ({
          ...d,
          migrationHashes: (d['migrationHashes'] as { name: string; sha256: string }[]).map((m) =>
            m.name === PHASE3_PREFIX_END ? { ...m, sha256: '0'.repeat(64) } : m,
          ),
        }),
      },
      `changed [${PHASE3_PREFIX_END}]`,
    ));
  it('a frozenThrough that is not the Phase 3 prefix end', () =>
    expectRefused({ delivery: (d) => ({ ...d, frozenThrough: '0068_supplier_settlement_commands.sql' }) }, 'the delivery manifest says frozenThrough 0068'));
  it('a deployment matrix verdict FAIL', () =>
    expectRefused({ deployment: (d) => ({ ...d, verdict: 'FAIL' }) }, 'the repository deployment-authority matrix verdict is FAIL'));
  it("the archive run's deployment matrix verdict FAIL", () =>
    expectRefused({ archiveDeployment: (d) => ({ ...d, verdict: 'FAIL' }) }, 'the archive deployment-authority matrix verdict is FAIL'));
  it('a rehearsal verdict FAIL', () => expectRefused({ rehearsal: () => ({ verdict: 'FAIL' }) }, 'the repository deployed-database rehearsal verdict is FAIL'));
  it("the archive run's rehearsal verdict FAIL", () =>
    expectRefused({ archiveRehearsal: () => ({ verdict: 'FAIL' }) }, 'the archive deployed-database rehearsal verdict is FAIL'));
  it('a runtime role with temporaryOnDatabase: true', () =>
    expectRefused(
      {
        deployment: (d) => ({
          ...d,
          roleMatrix: [...(d['roleMatrix'] as Json[]), { role: 'daftar_worker', temporaryOnDatabase: true, createOnPublic: false }],
        }),
      },
      'in the repository role matrix daftar_worker holds TEMP on the database',
    ));
  it('PUBLIC with CREATE on public', () =>
    expectRefused(
      {
        archiveDeployment: (d) => ({
          ...d,
          roleMatrix: [...(d['roleMatrix'] as Json[]), { role: 'PUBLIC', temporaryOnDatabase: false, createOnPublic: true }],
        }),
      },
      'in the archive role matrix PUBLIC holds CREATE on public',
    ));
  it('a gate with mandatorySkipped: 1', () =>
    expectRefused({ repoGate: (g) => ({ ...g, mandatorySkipped: 1 }) }, 'the repository gate reports 1 mandatory skips'));
  it('a gate that is not PASS', () => expectRefused({ archiveGate: (g) => ({ ...g, verdict: 'FAIL' }) }, 'the extracted archive gate verdict is FAIL'));
  it('a structural-only gate artefact', () =>
    expectRefused({ repoGate: (g) => ({ ...g, structuralOnly: true, verdict: 'PASS' }) }, 'the repository gate artefact is not a full release run'));
  it('a nested gate:phase2:release that is not PASS', () =>
    expectRefused({ repoGate: (g) => withNested(g, { verdict: 'FAIL' }) }, 'the nested gate:phase2:release in the repository run is FAIL'));
  it('a nested gate:phase2:release that is missing', () =>
    expectRefused({ archiveGate: (g) => ({ ...g, nested: null }) }, 'the extracted archive gate carries no nested gate:phase2:release artefact'));
  it('a nested gate:phase2:release on another kind of tree', () =>
    expectRefused(
      { archiveGate: (g) => withNested(g, { tree: { kind: 'source-checkout', treeHash: null, sourceCommit: null } }) },
      /the nested gate:phase2:release in the extracted archive run gated a "source-checkout" tree/,
    ));
});
