/**
 * THE PHASE 3 SECRET HISTORY SCAN MUST BE ABLE TO SAY NO
 * (Phase 3 corrective directive §7, §19).
 *
 * `scripts/phase3-secret-scan.ts` scans every commit reachable from the head
 * and not from the Phase 3 base. A scan that has only ever passed proves
 * nothing, so every case below builds a THROWAWAY repository in a temporary
 * directory with a long history — a base on `main` and a 120-commit branch
 * with an agent branch merged into it — plants a credential somewhere in it,
 * and runs the real scan against it. Nothing in this repository is read or
 * written; no case needs this repository's `.git`, so the file runs the same
 * inside an extracted release archive.
 *
 * Every planted credential is REMOVED again by a later commit, so the head's
 * tree is clean and only a history scan can see it.
 *
 * The planted credential is a GitHub personal-access-token shape assembled at
 * run time from random characters: no credential-shaped literal exists in this
 * file, so the repository's own scans do not read this file as a leak.
 *
 * ── The window this scan replaces ────────────────────────────────────────
 *
 * `gitleaks/gitleaks-action@v2` on a pull request takes the first page of the
 * PR's commits from the GitHub API (30, oldest first) and scans
 * `--no-merges --first-parent <1st>^..<30th>`. `actionWindowFindings` below
 * reproduces that selection over the throwaway history (oldest first by
 * commit date), and the cases prove what it cannot see: a commit after the
 * 30th — accepted commit 61b89d6 is the 70th of the Phase 3 range — and any
 * commit that arrived through a merge, however early.
 */
import { createHash, randomInt } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GITLEAKS_BINARY_SHA256,
  GITLEAKS_VERSION,
  PHASE3_BASE,
  ensureGitleaks,
  git,
  parseIgnoreFile,
  scan,
  scanTree,
  secretScanEvidenceProblems,
  type ScanResult,
} from '../../scripts/phase3-secret-scan';

const HISTORY = 120;
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const MIGRATION = 'infrastructure/database/migrations/0044_accounting_assertion_keys.sql';
const MIGRATION_TEXT = '-- a migration\nCREATE TABLE accounting_assertion_keys (kid text PRIMARY KEY);\n';

/** A GitHub PAT shape (`gitleaks` rule `github-pat`), never written literally in this file. */
function plantedToken(): string {
  let body = '';
  for (let i = 0; i < 36; i++) body += ALNUM[randomInt(ALNUM.length)];
  return ['gh', 'p_', body].join('');
}

type FileOp = { readonly op: 'M'; readonly path: string; readonly content: string } | { readonly op: 'D'; readonly path: string };

interface Plan {
  /** first-parent position (1-based) → the files that commit changes, besides its own note */
  readonly onBranch?: Readonly<Record<number, readonly FileOp[]>>;
  /** the agent branch forks after this first-parent position and is merged as the next one */
  readonly sideAfter?: number;
  readonly side?: readonly (readonly FileOp[])[];
  /** files the merge commit itself changes (an "evil merge") */
  readonly inMerge?: readonly FileOp[];
}

const workDirs: string[] = [];
let gitleaks = '';

/**
 * Build the throwaway history with `git fast-import`: `main` holds one base
 * commit; `phase` holds HISTORY first-parent commits on top of it, one of
 * which may be the merge of an agent branch. Commit dates increase by a
 * minute per commit, the agent branch's interleaved, so "oldest first" is
 * well defined.
 */
function buildRepo(plan: Plan): { repo: string; base: string; head: string } {
  const repo = mkdtempSync(join(tmpdir(), 'p3c-secret-scan-'));
  workDirs.push(repo);
  git(repo, ['init', '--quiet', '--initial-branch=main']);
  let t = 1_790_000_000;
  let stream = '';
  const data = (s: string): string => `data ${Buffer.byteLength(s)}\n${s}\n`;
  const ops = (list: readonly FileOp[]): string => list.map((f) => (f.op === 'M' ? `M 100644 inline ${f.path}\n${data(f.content)}` : `D ${f.path}\n`)).join('');
  const commit = (ref: string, mark: number, msg: string, from: number | null, merge: number | null, files: readonly FileOp[]): void => {
    t += 60;
    stream += `commit ${ref}\nmark :${mark}\ncommitter Canary <canary@example.invalid> ${t} +0000\n${data(msg)}`;
    if (from !== null) stream += `from :${from}\n`;
    if (merge !== null) stream += `merge :${merge}\n`;
    stream += ops(files);
  };
  commit('refs/heads/main', 1, 'base', null, null, [
    { op: 'M', path: 'README.md', content: '# canary\n' },
    { op: 'M', path: MIGRATION, content: MIGRATION_TEXT },
  ]);
  let prev = 1;
  let mark = 1;
  for (let pos = 1; pos <= HISTORY; pos++) {
    const note: FileOp = { op: 'M', path: `notes/${String(pos).padStart(3, '0')}.txt`, content: `commit ${pos}\n` };
    if (plan.sideAfter !== undefined && pos === plan.sideAfter + 1) {
      let sidePrev = prev;
      (plan.side ?? []).forEach((files, i) => {
        mark += 1;
        commit('refs/heads/agent', mark, `agent ${i + 1}`, sidePrev, null, files);
        sidePrev = mark;
      });
      mark += 1;
      commit('refs/heads/phase', mark, `merge agent at ${pos}`, prev, sidePrev, [note, ...(plan.inMerge ?? [])]);
    } else {
      mark += 1;
      commit('refs/heads/phase', mark, `commit ${pos}`, prev, null, [note, ...(plan.onBranch?.[pos] ?? [])]);
    }
    prev = mark;
  }
  git(repo, ['fast-import', '--quiet'], stream);
  return { repo, base: git(repo, ['rev-parse', 'main']), head: git(repo, ['rev-parse', 'phase']) };
}

const leak = (token: string): FileOp => ({ op: 'M', path: 'config/leak.ts', content: `export const githubToken = '${token}';\n` });
const unleak: FileOp = { op: 'D', path: 'config/leak.ts' };

function runScan(repo: string, base: string, head: string): ScanResult {
  return scan({ repo, head, base, mainRef: 'main', gitleaks });
}

/**
 * The gitleaks-action@v2 pull-request window: the first 30 PR commits, oldest
 * first, scanned as `--no-merges --first-parent <first>^..<30th>`, with no
 * ignore file. Returns the number of findings.
 */
function actionWindowFindings(repo: string, base: string, head: string): number {
  const commits = git(repo, ['rev-list', '--reverse', '--date-order', `${base}..${head}`]).split('\n');
  const page = commits.slice(0, 30);
  const first = page[0];
  const last = page[page.length - 1];
  if (first === undefined || last === undefined) throw new Error('the throwaway history is empty');
  const empty = mkdtempSync(join(tmpdir(), 'p3c-secret-scan-empty-'));
  workDirs.push(empty);
  const report = join(empty, 'report.json');
  const run = spawnSync(
    gitleaks,
    [
      'git',
      '--no-banner',
      '--redact',
      '--exit-code',
      '0',
      '-i',
      empty,
      '--report-format',
      'json',
      '--report-path',
      report,
      '--log-opts',
      `--no-merges --first-parent ${first}^..${last}`,
      repo,
    ],
    { encoding: 'utf8' },
  );
  expect(run.status).toBe(0);
  return (JSON.parse(readFileSync(report, 'utf8')) as unknown[]).length;
}

beforeAll(() => {
  gitleaks = ensureGitleaks(process.env['GITLEAKS_BIN']);
});

afterAll(() => {
  for (const d of workDirs) rmSync(d, { recursive: true, force: true });
});

describe('Phase 3 secret history range scan', () => {
  it('pins gitleaks 8.24.3 by digest and names the Phase 3 base', () => {
    expect(GITLEAKS_VERSION).toBe('8.24.3');
    expect(createHash('sha256').update(readFileSync(gitleaks)).digest('hex')).toBe(GITLEAKS_BINARY_SHA256);
    expect(PHASE3_BASE).toBe('0f2b09e7f2bd1015053ff2cb79ad1ceafc25bc6f');
  });

  it('CONTROL: a clean long history with a merged agent branch passes, every commit counted', () => {
    const { repo, base, head } = buildRepo({
      sideAfter: 4,
      side: [[{ op: 'M', path: 'agent.txt', content: 'a\n' }], [{ op: 'M', path: 'agent.txt', content: 'b\n' }]],
    });
    const r = runScan(repo, base, head);
    expect(r.problems).toEqual([]);
    expect(r.result).toBe('PASS');
    expect(r.base).toBe(base);
    expect(r.head).toBe(head);
    expect(r.mergeBase).toBe(base);
    expect(r.commitsInRange).toBe(HISTORY + 2);
    expect(r.mergesInRange).toBe(1);
    expect(r.commitsScanned).toBe(r.commitsInRange);
    expect(r.findings).toBe(0);
  });

  it('a credential planted in the 2nd commit after the base, and removed in the 3rd, fails the scan', () => {
    const { repo, base, head } = buildRepo({ onBranch: { 2: [leak(plantedToken())], 3: [unleak] } });
    const r = runScan(repo, base, head);
    expect(r.result).toBe('FAIL');
    expect(r.remaining).toHaveLength(1);
    expect(r.remaining[0]?.rule).toBe('github-pat');
    expect(r.remaining[0]?.commit).toBe(git(repo, ['rev-list', '--reverse', `${base}..${head}`]).split('\n')[1]);
  });

  it('a credential in the 35th commit (early third, like 61b89d6 at 70 of 399) fails the scan, and the action window never reads it', () => {
    const { repo, base, head } = buildRepo({ onBranch: { 35: [leak(plantedToken())], 36: [unleak] } });
    const r = runScan(repo, base, head);
    expect(r.result).toBe('FAIL');
    expect(r.remaining.map((f) => f.rule)).toEqual(['github-pat']);
    expect(actionWindowFindings(repo, base, head)).toBe(0);
  });

  it('a credential in an early agent-branch commit merged into the range fails the scan, and the action window never reads it', () => {
    const { repo, base, head } = buildRepo({ sideAfter: 3, side: [[leak(plantedToken())], [unleak]] });
    const r = runScan(repo, base, head);
    expect(r.result).toBe('FAIL');
    expect(r.remaining.map((f) => f.rule)).toEqual(['github-pat']);
    expect(r.remaining[0]?.commit).toBe(git(repo, ['rev-parse', 'agent~1']));
    expect(actionWindowFindings(repo, base, head)).toBe(0);
  });

  it('a credential that exists only in a merge commit (an evil merge) fails the scan', () => {
    const { repo, base, head } = buildRepo({
      sideAfter: 3,
      side: [[{ op: 'M', path: 'agent.txt', content: 'a\n' }]],
      inMerge: [leak(plantedToken())],
      onBranch: { 6: [unleak] },
    });
    const r = runScan(repo, base, head);
    expect(r.result).toBe('FAIL');
    expect(r.remaining).toHaveLength(1);
    // the finding is the merge commit itself: two parents
    expect(git(repo, ['rev-list', '--parents', '-n', '1', String(r.remaining[0]?.commit)]).split(' ')).toHaveLength(3);
  });

  it('an inline gitleaks:allow comment does not suppress a finding', () => {
    const token = plantedToken();
    const allowed: FileOp = { op: 'M', path: 'config/leak.ts', content: `export const githubToken = '${token}'; // gitleaks:allow\n` };
    const { repo, base, head } = buildRepo({ onBranch: { 5: [allowed], 6: [unleak] } });
    expect(runScan(repo, base, head).result).toBe('FAIL');
  });

  it('a .gitleaks.toml in the tree is refused: it could replace or allowlist the default rules', () => {
    const { repo, base, head } = buildRepo({});
    writeFileSync(join(repo, '.gitleaks.toml'), '[allowlist]\npaths = [".*"]\n');
    const r = runScan(repo, base, head);
    expect(r.result).toBe('FAIL');
    expect(r.problems.join('\n')).toMatch(/\.gitleaks\.toml is present/);
  });

  it('a declared base that is not the merge-base of head and main is refused', () => {
    const { repo, base, head } = buildRepo({});
    const notTheBase = git(repo, ['rev-parse', 'phase~100']);
    const r = runScan(repo, notTheBase, head);
    expect(r.result).toBe('FAIL');
    expect(r.problems.join('\n')).toContain(`is ${base}, not the declared base ${notTheBase}`);
  });

  it('the RANGE scan refuses an extracted release archive (DELIVERY_MANIFEST.json, no history) with that reason', () => {
    const archive = mkdtempSync(join(tmpdir(), 'p3c-secret-scan-archive-'));
    workDirs.push(archive);
    writeFileSync(join(archive, 'DELIVERY_MANIFEST.json'), '{}\n');
    expect(() => runScan(archive, PHASE3_BASE, 'HEAD')).toThrow(/extracted release archive/);
  });

  describe('the allowlist accepts exact fingerprints of migration digests only', () => {
    const digest = createHash('sha256').update(MIGRATION_TEXT).digest('hex');
    const digestLine = `  ['0044_accounting_assertion_keys.sql', '${digest}'],\n`;

    function withIgnore(repo: string, text: string): void {
      writeFileSync(join(repo, '.gitleaksignore'), text);
    }

    it('a flagged migration digest is allowlisted by its exact fingerprint, with a reason, and proved against the migration', () => {
      const { repo, base, head } = buildRepo({ onBranch: { 10: [{ op: 'M', path: 'scripts/prefix.ts', content: `export const P = [\n${digestLine}];\n` }] } });
      const before = runScan(repo, base, head);
      expect(before.result).toBe('FAIL');
      expect(before.remaining.map((f) => f.rule)).toEqual(['generic-api-key']);
      const fp = String(before.remaining[0]?.fingerprint);
      withIgnore(repo, `# migration digest, not a credential\n${fp}\n`);
      const after = runScan(repo, base, head);
      expect(after.problems).toEqual([]);
      expect(after.result).toBe('PASS');
      expect(after.allowlisted.map((a) => a.fingerprint)).toEqual([fp]);
    });

    it('the exact fingerprint of a REAL credential is still a failure', () => {
      const { repo, base, head } = buildRepo({ onBranch: { 10: [leak(plantedToken())], 11: [unleak] } });
      const fp = String(runScan(repo, base, head).remaining[0]?.fingerprint);
      withIgnore(repo, `# "just a test value"\n${fp}\n`);
      const r = runScan(repo, base, head);
      expect(r.result).toBe('FAIL');
      expect(r.remaining.map((f) => f.fingerprint)).toEqual([fp]);
      expect(r.problems.join('\n')).toMatch(/only generic-api-key findings may be allowlisted/);
    });

    it('a digest line whose hex is not the migration’s SHA-256 is still a failure', () => {
      const wrong = `  ['0044_accounting_assertion_keys.sql', '${createHash('sha256').update('something else').digest('hex')}'],\n`;
      const { repo, base, head } = buildRepo({ onBranch: { 10: [{ op: 'M', path: 'scripts/prefix.ts', content: `export const P = [\n${wrong}];\n` }] } });
      const fp = String(runScan(repo, base, head).remaining[0]?.fingerprint);
      withIgnore(repo, `# claims to be a migration digest\n${fp}\n`);
      const r = runScan(repo, base, head);
      expect(r.result).toBe('FAIL');
      expect(r.problems.join('\n')).toMatch(/hashes to .* not the .* on the line/);
    });

    it('wildcards, path-wide entries and entries without a reason are refused', () => {
      const sha = 'a'.repeat(40);
      expect(parseIgnoreFile(`# r\n${sha}:scripts/*.ts:generic-api-key:60\n`).problems).toHaveLength(1);
      expect(parseIgnoreFile('# r\nscripts/phase2-prefix.ts\n').problems).toHaveLength(1);
      expect(parseIgnoreFile(`# r\n${sha}:scripts/p.ts:generic-api-key\n`).problems).toHaveLength(1);
      expect(parseIgnoreFile(`${sha}:scripts/p.ts:generic-api-key:60\n`).problems).toHaveLength(1);
      expect(parseIgnoreFile(`# r\n\n${sha}:scripts/p.ts:generic-api-key:60\n`).problems).toHaveLength(1);
      expect(parseIgnoreFile(`# r\n${sha}:scripts/p.ts:generic-api-key:60\n`)).toEqual({
        entries: [
          {
            fingerprint: `${sha}:scripts/p.ts:generic-api-key:60`,
            reason: 'r',
            kind: 'commit',
            commit: sha,
            path: 'scripts/p.ts',
            rule: 'generic-api-key',
            line: 60,
            lineSha256: null,
          },
        ],
        problems: [],
      });
    });
  });

  describe('tree mode: the extracted archive has no history, so its files are scanned, never skipped', () => {
    const REPO = join(__dirname, '../..');
    const TSX = join(REPO, 'node_modules/.bin/tsx');
    const SOURCE_COMMIT = 'f'.repeat(40);
    const digest = createHash('sha256').update(MIGRATION_TEXT).digest('hex');
    /** A rehearsal-style throwaway password, never written literally in this file. */
    const fixtureValue = ['rehearsal', 'migrator', 'pw', '123456'].join('_');
    const fixtureLine = `  __MIGRATOR_DB_PASSWORD__: '${fixtureValue}',`;
    const lineSha = (text: string): string => createHash('sha256').update(text).digest('hex');
    const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

    /** An extracted archive: the files, and a DELIVERY_MANIFEST.json whose inventory lists them; `extra` is on disk but not delivered. */
    function buildArchive(files: Readonly<Record<string, string>>, extra: Readonly<Record<string, string>> = {}, inventory?: Record<string, string>): string {
      const root = mkdtempSync(join(tmpdir(), 'p3c-secret-tree-'));
      workDirs.push(root);
      for (const [path, text] of Object.entries({ ...files, ...extra })) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
      }
      const listed = Object.entries(files).map(([path, text]) => ({ path, sha256: inventory?.[path] ?? sha(text) }));
      writeFileSync(join(root, 'DELIVERY_MANIFEST.json'), JSON.stringify({ sourceCommit: SOURCE_COMMIT, inventory: listed }));
      return root;
    }
    const baseFiles = (): Record<string, string> => ({ 'README.md': '# canary\n', [MIGRATION]: MIGRATION_TEXT, 'notes/a.txt': 'a\n' });
    const treeScan = (root: string): ScanResult => scanTree({ root, gitleaks });

    it('CONTROL: a clean archive passes in tree mode, every delivered file counted, and no range is claimed', () => {
      const r = treeScan(buildArchive(baseFiles()));
      expect(r.problems).toEqual([]);
      expect(r).toMatchObject({ mode: 'tree', result: 'PASS', head: SOURCE_COMMIT, base: null, commitsScanned: null, filesScanned: 3, findings: 0 });
    });

    it('a credential in a delivered file fails the tree scan', () => {
      const r = treeScan(buildArchive({ ...baseFiles(), 'config/leak.ts': `export const githubToken = '${plantedToken()}';\n` }));
      expect(r.result).toBe('FAIL');
      expect(r.remaining.map((f) => `${f.file}:${f.rule}`)).toEqual(['config/leak.ts:github-pat']);
    });

    it('a credential behind gitleaks:allow still fails the tree scan', () => {
      const r = treeScan(buildArchive({ ...baseFiles(), 'config/leak.ts': `export const githubToken = '${plantedToken()}'; // gitleaks:allow\n` }));
      expect(r.result).toBe('FAIL');
    });

    it('the .gitleaksignore file is itself scanned as data, not obeyed by gitleaks', () => {
      const r = treeScan(buildArchive({ ...baseFiles(), '.gitleaksignore': `# ${plantedToken()}\n` }));
      expect(r.result).toBe('FAIL');
      expect(r.remaining.map((f) => f.file)).toEqual(['.gitleaksignore']);
    });

    it('only the delivered inventory is the tree: a file on disk outside it is not read, a changed file is refused', () => {
      expect(treeScan(buildArchive(baseFiles(), { 'stray/leftover.ts': `export const githubToken = '${plantedToken()}';\n` })).result).toBe('PASS');
      const tampered = treeScan(buildArchive(baseFiles(), {}, { 'notes/a.txt': sha('not a\n') }));
      expect(tampered.result).toBe('FAIL');
      expect(tampered.problems.join('\n')).toMatch(/notes\/a\.txt does not match its inventory digest/);
    });

    it('tree entries: a migration digest proved against the tree, and a fixture line pinned by line-sha256, are allowlisted', () => {
      const prefix = `export const P = [\n  ['0044_accounting_assertion_keys.sql', '${digest}'],\n];\n`;
      const rehearsal = `export const V = {\n${fixtureLine}\n};\n`;
      const files = { ...baseFiles(), 'scripts/prefix.ts': prefix, 'scripts/rehearsal.ts': rehearsal };
      const before = treeScan(buildArchive(files));
      expect(before.remaining.map((f) => f.fingerprint).sort()).toEqual(['scripts/prefix.ts:generic-api-key:2', 'scripts/rehearsal.ts:generic-api-key:2']);
      const ignore = [
        '# migration digest, not a credential',
        'tree:scripts/prefix.ts:generic-api-key:2',
        '',
        `# rehearsal fixture, not a credential. line-sha256 ${lineSha(fixtureLine)}`,
        'tree:scripts/rehearsal.ts:generic-api-key:2',
        '',
      ].join('\n');
      const after = treeScan(buildArchive({ ...files, '.gitleaksignore': ignore }));
      expect(after.problems).toEqual([]);
      expect(after.result).toBe('PASS');
      expect(after.allowlisted).toHaveLength(2);
    });

    it('tree entries: a pin that is not the line, a missing pin, or a provider-specific rule is still a failure', () => {
      const rehearsal = `export const V = {\n${fixtureLine}\n};\n`;
      const wrongPin = `# fixture. line-sha256 ${lineSha('something else')}\ntree:scripts/rehearsal.ts:generic-api-key:2\n`;
      const noPin = '# fixture\ntree:scripts/rehearsal.ts:generic-api-key:2\n';
      for (const ignore of [wrongPin, noPin]) {
        const r = treeScan(buildArchive({ ...baseFiles(), 'scripts/rehearsal.ts': rehearsal, '.gitleaksignore': ignore }));
        expect(r.result).toBe('FAIL');
        expect(r.remaining.map((f) => f.fingerprint)).toEqual(['scripts/rehearsal.ts:generic-api-key:2']);
      }
      const tokenLine = `export const githubToken = '${plantedToken()}';`;
      const pat = treeScan(
        buildArchive({
          ...baseFiles(),
          'config/leak.ts': `${tokenLine}\n`,
          '.gitleaksignore': `# "a test token". line-sha256 ${lineSha(tokenLine)}\ntree:config/leak.ts:github-pat:1\n`,
        }),
      );
      expect(pat.result).toBe('FAIL');
      expect(pat.problems.join('\n')).toMatch(/only generic-api-key findings may be allowlisted, not github-pat/);
    });

    it('tree entries are inert for gitleaks itself: a range finding at the same path and line is not hidden', () => {
      const { repo, base, head } = buildRepo({ onBranch: { 10: [leak(plantedToken())], 11: [unleak] } });
      writeFileSync(join(repo, '.gitleaksignore'), '# a tree entry\ntree:config/leak.ts:github-pat:1\n');
      expect(runScan(repo, base, head).result).toBe('FAIL');
    });

    it('the CLI takes its head from --head, else PHASE3_SCAN_HEAD (the PR head a pull_request run names), else HEAD', () => {
      const { repo, base, head } = buildRepo({});
      const run = (extra: readonly string[], env: Record<string, string | undefined>): string => {
        const res = spawnSync(
          TSX,
          [join(REPO, 'scripts/phase3-secret-scan.ts'), `--repo=${repo}`, `--gitleaks=${gitleaks}`, `--base=${base}`, '--main-ref=main', ...extra],
          {
            cwd: REPO,
            encoding: 'utf8',
            env: { ...process.env, PHASE3_SCAN_HEAD: undefined, ...env },
          },
        );
        return `${res.stdout}${res.stderr}`;
      };
      const named = run([], { PHASE3_SCAN_HEAD: head });
      expect(named).toContain(`head: ${head}`);
      expect(named).toContain('result: PASS');
      expect(run([], {})).toContain(`head: ${base}`);
      expect(run([`--head=${base}`], { PHASE3_SCAN_HEAD: head })).toContain(`head: ${base}`);
    });

    it('the CLI picks tree mode by itself inside an archive and says so', () => {
      const run = (root: string): { status: number | null; out: string } => {
        const res = spawnSync(TSX, [join(REPO, 'scripts/phase3-secret-scan.ts'), `--repo=${root}`, `--gitleaks=${gitleaks}`], { cwd: REPO, encoding: 'utf8' });
        return { status: res.status, out: `${res.stdout}${res.stderr}` };
      };
      const clean = run(buildArchive(baseFiles()));
      expect(clean.out).toContain('mode: tree (no git history)');
      expect(clean.status).toBe(0);
      const dirty = run(buildArchive({ ...baseFiles(), 'config/leak.ts': `export const githubToken = '${plantedToken()}';\n` }));
      expect(dirty.out).toContain('mode: tree (no git history)');
      expect(dirty.out).toContain('result: FAIL');
      expect(dirty.status).toBe(1);
    });
  });

  describe('scripts/phase3-s9-evidence.ts carries and requires the scan', () => {
    const REPO = join(__dirname, '../..');
    const TSX = join(REPO, 'node_modules/.bin/tsx');
    const SHA = 'e5'.repeat(20);

    /** Runs the evidence assembler over a release directory holding only the secret-scan artefact (if any). */
    function evidence(artefact: unknown, flag: boolean): { problems: string[]; secretHistoryScan: Record<string, unknown> } {
      const dir = mkdtempSync(join(tmpdir(), 'p3c-secret-scan-evidence-'));
      workDirs.push(dir);
      if (artefact !== undefined) writeFileSync(join(dir, 'phase3-secret-scan.json'), JSON.stringify(artefact));
      const args = [join(REPO, 'scripts/phase3-s9-evidence.ts'), `--release-dir=${dir}`, `--expected-sha=${SHA}`];
      if (flag) args.push(`--secret-scan=${join(dir, 'phase3-secret-scan.json')}`);
      spawnSync(TSX, args, { cwd: REPO, encoding: 'utf8', env: { ...process.env, GITHUB_SHA: '' } });
      return JSON.parse(readFileSync(join(dir, 'phase3-s9-release-evidence.json'), 'utf8')) as {
        problems: string[];
        secretHistoryScan: Record<string, unknown>;
      };
    }
    const scanProblems = (problems: string[]): string[] => problems.filter((p) => /secret (history )?scan/.test(p));
    const passing = (): Record<string, unknown> => ({
      produced: 'scripts/phase3-secret-scan.ts',
      tool: { name: 'gitleaks', version: GITLEAKS_VERSION, binarySha256: GITLEAKS_BINARY_SHA256 },
      mode: 'phase3-base',
      base: PHASE3_BASE,
      head: SHA,
      mergeBase: PHASE3_BASE,
      commitsInRange: 401,
      commitsScanned: 401,
      findings: 3,
      remaining: [],
      result: 'PASS',
    });

    it('records base, head, commit count, findings and result, and raises nothing about a passing scan', () => {
      const e = evidence(passing(), true);
      expect(scanProblems(e.problems)).toEqual([]);
      expect(e.secretHistoryScan).toMatchObject({ base: PHASE3_BASE, head: SHA, commitsInRange: 401, commitsScanned: 401, findings: 3, result: 'PASS' });
    });

    it('refuses a missing scan when the workflow requires it', () => {
      expect(scanProblems(evidence(undefined, true).problems)).toEqual([expect.stringMatching(/the Phase 3 secret history scan is missing/)]);
    });

    it('refuses a failed or partial scan found in the release directory even when not required', () => {
      const problems = scanProblems(evidence({ ...passing(), result: 'FAIL', commitsScanned: 30 }, false).problems);
      expect(problems.join('\n')).toMatch(/result is FAIL/);
      expect(problems.join('\n')).toMatch(/read 30 of 401 commits/);
    });
  });

  describe('the release evidence accepts only a full Phase 3 range scan at the exact head', () => {
    const head = 'b'.repeat(40);
    const good: ScanResult = {
      produced: 'scripts/phase3-secret-scan.ts',
      tool: { name: 'gitleaks', version: GITLEAKS_VERSION, binarySha256: GITLEAKS_BINARY_SHA256 },
      mode: 'phase3-base',
      base: PHASE3_BASE,
      head,
      mainRef: 'origin/main',
      mergeBase: PHASE3_BASE,
      logOpts: `--diff-merges=first-parent ${PHASE3_BASE}..${head}`,
      commitsInRange: 400,
      mergesInRange: 14,
      commitsScanned: 400,
      findings: 3,
      allowlisted: [],
      remaining: [],
      filesScanned: null,
      ignoreFile: { present: true, sha256: null, entries: 3, unused: 0 },
      problems: [],
      result: 'PASS',
    };

    it('accepts the good artefact', () => {
      expect(secretScanEvidenceProblems(good, head)).toEqual([]);
    });

    it.each([
      ['a missing artefact', null],
      ['a failed scan', { ...good, result: 'FAIL' as const }],
      ['a derived base', { ...good, mode: 'derived-merge-base' as const }],
      [
        'the archive run’s tree scan in place of the range',
        { ...good, mode: 'tree' as const, base: null, mergeBase: null, commitsInRange: null, commitsScanned: null, filesScanned: 968 },
      ],
      ['another base', { ...good, base: 'c'.repeat(40) }],
      ['another head', { ...good, head: 'd'.repeat(40) }],
      ['the 30-commit window', { ...good, commitsScanned: 30 }],
      ['another gitleaks', { ...good, tool: { ...good.tool, version: '8.18.0' } }],
      ['a remaining finding', { ...good, remaining: [{ fingerprint: 'x', rule: 'r', file: 'f', line: 1, commit: head }] }],
    ])('refuses %s', (_label, artefact) => {
      expect(secretScanEvidenceProblems(artefact, head).length).toBeGreaterThan(0);
    });
  });
});
