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
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GITLEAKS_BINARY_SHA256,
  GITLEAKS_VERSION,
  PHASE3_BASE,
  ensureGitleaks,
  parseIgnoreFile,
  scan,
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

function git(repo: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

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
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', repo]);
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
  execFileSync('git', ['-C', repo, 'fast-import', '--quiet'], { input: stream });
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
      expect(r.problems.join('\n')).toMatch(/only generic-api-key findings on migration digests may be allowlisted/);
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
        entries: [{ fingerprint: `${sha}:scripts/p.ts:generic-api-key:60`, reason: 'r', commit: sha, path: 'scripts/p.ts', rule: 'generic-api-key', line: 60 }],
        problems: [],
      });
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
