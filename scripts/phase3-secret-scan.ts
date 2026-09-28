#!/usr/bin/env tsx
/**
 * ─────────────────────────────────────────────────────────────────────────
 * PHASE 3 SECRET HISTORY RANGE SCAN (corrective directive §7)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS
 *
 * The hygiene job's `gitleaks/gitleaks-action@v2` step does not scan a pull
 * request's history. On a `pull_request` event it asks the GitHub API for the
 * PR's commits WITHOUT paging, so it receives the first page — the 30 OLDEST
 * commits — and runs `gitleaks detect --log-opts="--no-merges --first-parent
 * <first>^..<30th>"`. On PR #4 (≈400 commits) that is commits 1–30; every
 * later commit, the head included, and every commit that reached the branch
 * through a merge, was never read. The green tick said "30 commits scanned".
 *
 * WHAT THIS SCAN IS
 *
 * An explicit range, named by commit id, owned by this repository:
 *
 *   base  the Phase 3 base `0f2b09e…` (PHASE3_BASE). It is VERIFIED, not
 *         assumed: `git merge-base <head> <main-ref>` must equal it.
 *         (`--base=derive` takes the merge-base itself — the per-PR mode the
 *         CI hygiene job uses, which is not a Phase 3 release claim.)
 *   head  the exact commit under scan (`--head`, resolved to 40 hex).
 *   range every commit reachable from head and not from base — merged
 *         agent/worktree branches included — `git log base..head`, with
 *         `--diff-merges=first-parent` so a merge commit's own content (a
 *         conflict resolution, an "evil merge") is read as well.
 *
 * gitleaks is pinned (8.24.3, the version the CI action ran) and checksum-
 * verified: a downloaded release archive must match the digest published in
 * the release's checksums file, and the executable itself must match the
 * digest of the binary inside it, whichever way it was obtained.
 *
 * The rule set is gitleaks' built-in default, and nothing in the scanned
 * tree may change it: a `.gitleaks.toml`, `GITLEAKS_CONFIG` or
 * `GITLEAKS_CONFIG_TOML` is refused, and inline `gitleaks:allow` comments are
 * ignored (`--ignore-gitleaks-allow`), so no commit can suppress its own
 * finding.
 *
 * THE ALLOWLIST, AND WHY IT CANNOT HIDE A SECRET
 *
 * gitleaks is run with NO ignore file. This script applies `.gitleaksignore`
 * itself, and only under all of these conditions, each checked every run:
 *
 *   1. every entry is one exact gitleaks fingerprint
 *      `<40-hex commit>:<path>:<rule>:<line>` — no wildcard, no path-wide or
 *      rule-wide entry, no regular expression;
 *   2. every entry is immediately preceded by a `#` comment giving its reason;
 *   3. every entry is PROVED to be a migration digest: the line it names, read
 *      from git at that commit, is exactly `['<NNNN_name>.sql', '<64 hex>']`,
 *      and the 64 hex are the SHA-256 of that migration file at that same
 *      commit. A line holding anything else — a real credential included —
 *      fails the scan even if its fingerprint is listed.
 *
 * THE EXTRACTED RELEASE ARCHIVE: TREE MODE
 *
 * The release gate runs a second time inside the extracted archive, which has
 * no `.git`. There this script does not pretend to scan a range and does not
 * skip: it copies exactly the files the archive's `DELIVERY_MANIFEST.json`
 * lists (each checked against its recorded SHA-256) into a scratch directory
 * and runs `gitleaks dir` over them with the same default rules and the same
 * `--ignore-gitleaks-allow`, printing `mode: tree (no git history)`. Any
 * finding fails it. Tree findings carry fingerprints without a commit
 * (`<path>:<rule>:<line>`), and `.gitleaksignore` may list those too, as
 * `tree:<path>:<rule>:<line>` (inert for gitleaks itself), under
 * the same three conditions with condition 3 read from the tree: a migration
 * digest line proved against the tree's migration file, or — for a
 * `generic-api-key` test fixture that predates Phase 3 — the SHA-256 of the
 * exact line, pinned in the reason as `line-sha256 <64 hex>`, so the entry
 * covers that one line of text and nothing else. A provider-specific rule
 * (a GitHub token, a private key, …) can never be allowlisted. `--mode=tree`
 * runs the same over `git ls-files` in a checkout. The release evidence
 * records the REPOSITORY run's range result; a tree run cannot stand in for it.
 *
 * WHAT IT PRINTS, AND WHAT THE RELEASE EVIDENCE RECORDS
 *
 * base, head, merge-base, commits in range (and merges), commits gitleaks
 * reports scanned (must equal the range), findings, findings allowlisted
 * (with fingerprints), findings remaining, and the result. `--evidence=<file>`
 * writes the same as JSON for `scripts/phase3-s9-evidence.ts`.
 *
 * Usage:
 *   npm run scan:secrets:phase3 -- [--mode=auto|range|tree] [--head=<rev>]
 *   (without --head: $PHASE3_SCAN_HEAD if set, else HEAD)
 *     [--base=<sha>|derive] [--main-ref=<ref>] [--repo=<dir>]
 *     [--gitleaks=<path>] [--evidence=<file>]
 *
 * `auto` (the default) is tree mode where `DELIVERY_MANIFEST.json` exists
 * (an extracted archive) and range mode everywhere else.
 *
 * Exit 0 = PASS, 1 = FAIL (a finding, or any precondition not met).
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** The first commit NOT in Phase 3: `main` at the time the Phase 3 branch was cut. */
export const PHASE3_BASE = '0f2b09e7f2bd1015053ff2cb79ad1ceafc25bc6f';

export const GITLEAKS_VERSION = '8.24.3';
/** `gitleaks_8.24.3_linux_x64.tar.gz`, as published in `gitleaks_8.24.3_checksums.txt`. */
export const GITLEAKS_TARBALL_SHA256 = '9991e0b2903da4c8f6122b5c3186448b927a5da4deef1fe45271c3793f4ee29c';
/** The `gitleaks` executable inside that archive. */
export const GITLEAKS_BINARY_SHA256 = 'e18325d568268b6efb6cd0cc721f8bea5667f4cd1c8d03618ab61987f41269ad';
const GITLEAKS_TARBALL_URL = `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz`;

const ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = 'infrastructure/database/migrations';
const COMMIT_FINGERPRINT = /^([0-9a-f]{40}):([^:]+):([a-z0-9-]+):([1-9][0-9]*)$/;
/**
 * `tree:<path>:<rule>:<line>`. gitleaks itself reads a three-part line as a
 * global, any-commit ignore; the `tree:` prefix makes it a four-part line
 * naming a commit called "tree", which never matches, so these entries stay
 * inert for the gitleaks-action step and apply only here, to tree findings.
 */
const TREE_FINGERPRINT = /^tree:([^:]+):([a-z0-9-]+):([1-9][0-9]*)$/;
/**
 * The pin a tree fixture entry carries in its reason: `line-sha256 <64 hex>`.
 * A space, not `=`: `<keyword> … =<hex>` in a comment is itself what the
 * generic-api-key rule matches, and the ignore file is scanned as data.
 */
const LINE_PIN = /\bline-sha256 ([0-9a-f]{64})\b/;
/** The one gitleaks rule whose findings may be allowlisted at all: the generic high-entropy heuristic. */
const ALLOWLISTABLE_RULE = 'generic-api-key';
/** In tree mode the scanned copy holds `.gitleaksignore` under this name, so gitleaks reads it as data and not as its ignore list. */
const IGNORE_FILE_AS_DATA = 'gitleaksignore.scanned-as-data';
const DIGEST_LINE = /^\s*\['(\d{4}_[a-z0-9_]+\.sql)',\s*'([0-9a-f]{64})'\],?\s*$/;

export class SecretScanError extends Error {
  override readonly name = 'SecretScanError';
}

const sha256 = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex');

/**
 * Every git process this scan starts — and the canary suite, for its
 * throwaway repositories — goes through here. An extracted release archive
 * carries `DELIVERY_MANIFEST.json` and no `.git`: there is no history in it
 * to scan, so it is refused with that reason instead of git's "not a git
 * repository" (tests/security/archive-portability.test.ts). The range scan
 * runs on the repository checkout, before the archive is built.
 */
export function gitRun(
  repo: string,
  args: readonly string[],
  input?: string,
): { readonly status: number | null; readonly stdout: Buffer; readonly stderr: string } {
  if (existsSync(join(repo, 'DELIVERY_MANIFEST.json'))) {
    throw new SecretScanError(
      `${repo} is an extracted release archive (DELIVERY_MANIFEST.json): it has no git history; the range scan runs on the repository checkout`,
    );
  }
  const res = spawnSync('git', ['-C', repo, ...args], { input, maxBuffer: 256 * 1024 * 1024 });
  if (res.error !== undefined) throw new SecretScanError(`git could not be started: ${res.error.message}`);
  return { status: res.status, stdout: res.stdout, stderr: res.stderr.toString('utf8') };
}

function gitBuffer(repo: string, args: readonly string[], input?: string): Buffer {
  const res = gitRun(repo, args, input);
  if (res.status !== 0) throw new SecretScanError(`git ${args.join(' ')} failed (${String(res.status)}): ${res.stderr.trim()}`);
  return res.stdout;
}

/** git's standard output as trimmed text; a non-zero exit is a SecretScanError. */
export function git(repo: string, args: readonly string[], input?: string): string {
  return gitBuffer(repo, args, input).toString('utf8').trim();
}

function gitOk(repo: string, args: readonly string[]): boolean {
  return gitRun(repo, args).status === 0;
}

// ── gitleaks: pinned, checksum-verified ───────────────────────────────────

/**
 * The gitleaks executable to run: `explicit` (a flag or `GITLEAKS_BIN`), or a
 * cached download, or a fresh download. Whichever it is, its SHA-256 must be
 * the pinned binary digest, and a download's archive must match the pinned
 * archive digest before anything is extracted from it.
 */
export function ensureGitleaks(explicit: string | undefined, root: string = ROOT): string {
  if (explicit !== undefined && explicit !== '') {
    const path = resolve(explicit);
    if (!existsSync(path)) throw new SecretScanError(`gitleaks not found at ${path}`);
    const digest = sha256(readFileSync(path));
    if (digest !== GITLEAKS_BINARY_SHA256)
      throw new SecretScanError(`${path} has SHA-256 ${digest}, not the pinned gitleaks ${GITLEAKS_VERSION} linux x64 binary ${GITLEAKS_BINARY_SHA256}`);
    return path;
  }
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new SecretScanError(`no pinned gitleaks download for ${process.platform}/${process.arch}; pass --gitleaks=<path> or GITLEAKS_BIN`);
  }
  const dir = join(root, 'node_modules', '.cache', 'daftar-gitleaks', GITLEAKS_VERSION);
  const bin = join(dir, 'gitleaks');
  if (existsSync(bin) && sha256(readFileSync(bin)) === GITLEAKS_BINARY_SHA256) return bin;
  mkdirSync(dir, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'daftar-gitleaks-'));
  try {
    const tarball = join(work, 'gitleaks.tar.gz');
    execFileSync('curl', ['-fsSL', '--retry', '3', '-o', tarball, GITLEAKS_TARBALL_URL], { stdio: ['ignore', 'ignore', 'inherit'] });
    const tarDigest = sha256(readFileSync(tarball));
    if (tarDigest !== GITLEAKS_TARBALL_SHA256)
      throw new SecretScanError(`the downloaded gitleaks archive has SHA-256 ${tarDigest}, not the published ${GITLEAKS_TARBALL_SHA256}`);
    execFileSync('tar', ['-xzf', tarball, '-C', work, 'gitleaks']);
    const extracted = join(work, 'gitleaks');
    const binDigest = sha256(readFileSync(extracted));
    if (binDigest !== GITLEAKS_BINARY_SHA256)
      throw new SecretScanError(`the extracted gitleaks has SHA-256 ${binDigest}, not the pinned ${GITLEAKS_BINARY_SHA256}`);
    chmodSync(extracted, 0o755);
    renameSync(extracted, bin);
    return bin;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ── the allowlist ─────────────────────────────────────────────────────────

export interface IgnoreEntry {
  readonly fingerprint: string;
  readonly reason: string;
  /** `commit`: a range finding (`<commit>:<path>:<rule>:<line>`); `tree`: a tree finding (`<path>:<rule>:<line>`). */
  readonly kind: 'commit' | 'tree';
  readonly commit: string | null;
  readonly path: string;
  readonly rule: string;
  readonly line: number;
  /** `line-sha256 <hex>` in the reason: the exact line a tree entry covers. */
  readonly lineSha256: string | null;
}

/** Parse `.gitleaksignore`; every problem is returned, none is thrown. */
export function parseIgnoreFile(text: string): { entries: IgnoreEntry[]; problems: string[] } {
  const entries: IgnoreEntry[] = [];
  const problems: string[] = [];
  let comment: string[] = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (line === '') {
      comment = [];
      return;
    }
    if (line.startsWith('#')) {
      comment.push(line.replace(/^#+\s*/, ''));
      return;
    }
    const reason = comment.join(' ').trim();
    comment = [];
    const c = COMMIT_FINGERPRINT.exec(line);
    const t = c === null ? TREE_FINGERPRINT.exec(line) : null;
    if (/[*?[\]]/.test(line)) {
      problems.push(`.gitleaksignore line ${i + 1} carries a wildcard: "${line}"`);
    } else if (reason === '') {
      problems.push(`.gitleaksignore line ${i + 1} has no reason comment directly above it: "${line}"`);
    } else if (c !== null && c[1] !== undefined && c[2] !== undefined && c[3] !== undefined && c[4] !== undefined) {
      entries.push({ fingerprint: line, reason, kind: 'commit', commit: c[1], path: c[2], rule: c[3], line: Number(c[4]), lineSha256: null });
    } else if (t !== null && t[1] !== undefined && t[2] !== undefined && t[3] !== undefined) {
      const pin = LINE_PIN.exec(reason)?.[1] ?? null;
      entries.push({ fingerprint: `${t[1]}:${t[2]}:${t[3]}`, reason, kind: 'tree', commit: null, path: t[1], rule: t[2], line: Number(t[3]), lineSha256: pin });
    } else {
      problems.push(`.gitleaksignore line ${i + 1} is not one exact fingerprint <commit>:<path>:<rule>:<line> or tree:<path>:<rule>:<line>: "${line}"`);
    }
  });
  return { entries, problems };
}

/**
 * Condition 3, over a reader of file content (`null` = absent): the
 * fingerprinted line is a migration name and its true SHA-256; or, in tree
 * mode only, a line whose SHA-256 is pinned in the entry's reason.
 */
function verifyEntry(e: IgnoreEntry, read: (path: string) => Buffer | null, where: string): string | null {
  if (e.rule !== ALLOWLISTABLE_RULE) return `${e.fingerprint}: only ${ALLOWLISTABLE_RULE} findings may be allowlisted, not ${e.rule}`;
  const content = read(e.path);
  if (content === null) return `${e.fingerprint}: ${e.path} does not exist ${where}`;
  const text = content.toString('utf8').split('\n')[e.line - 1];
  if (text === undefined) return `${e.fingerprint}: ${e.path} has no line ${e.line} ${where}`;
  const m = DIGEST_LINE.exec(text);
  if (m && m[1] !== undefined && m[2] !== undefined) {
    const migrationPath = `${MIGRATIONS_DIR}/${m[1]}`;
    const migration = read(migrationPath);
    if (migration === null) return `${e.fingerprint}: ${migrationPath} does not exist ${where}`;
    const actual = sha256(migration);
    if (actual !== m[2]) return `${e.fingerprint}: ${m[1]} hashes to ${actual} ${where}, not the ${m[2]} on the line`;
    return null;
  }
  if (e.kind === 'tree' && e.lineSha256 !== null) {
    const actual = sha256(text);
    if (actual !== e.lineSha256)
      return `${e.fingerprint}: line ${e.line} of ${e.path} ${where} hashes to ${actual}, not the pinned line-sha256 ${e.lineSha256}`;
    return null;
  }
  return `${e.fingerprint}: line ${e.line} of ${e.path} ${where} is not a ['<migration>.sql', '<sha256>'] pair${e.kind === 'tree' ? ' and the entry pins no line-sha256' : ''}`;
}

/** Condition 3 for a range entry, read from git at the fingerprint's own commit. */
export function verifyDigestEntry(repo: string, e: IgnoreEntry): string | null {
  const commit = e.commit ?? '';
  if (!gitOk(repo, ['cat-file', '-e', `${commit}^{commit}`])) return `${e.fingerprint}: commit ${commit} is not in this repository`;
  return verifyEntry(
    e,
    (path) => (gitOk(repo, ['cat-file', '-e', `${commit}:${path}`]) ? gitBuffer(repo, ['show', `${commit}:${path}`]) : null),
    `at ${commit.slice(0, 12)}`,
  );
}

/** Condition 3 for a tree entry, read from the scanned tree. */
export function verifyTreeEntry(root: string, e: IgnoreEntry): string | null {
  return verifyEntry(e, (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path)) : null), 'in the tree');
}

// ── the scan ──────────────────────────────────────────────────────────────

export interface ScanOptions {
  readonly repo: string;
  readonly head: string;
  /** a 40-hex commit to verify against the merge-base, or 'derive' to take the merge-base itself */
  readonly base: string;
  readonly mainRef?: string;
  readonly gitleaks: string;
}

interface GitleaksFinding {
  readonly RuleID: string;
  readonly File: string;
  readonly StartLine: number;
  readonly Commit: string;
  readonly Fingerprint: string;
}

export interface ScanResult {
  readonly produced: 'scripts/phase3-secret-scan.ts';
  readonly tool: { readonly name: 'gitleaks'; readonly version: string; readonly binarySha256: string };
  /** `phase3-base` / `derived-merge-base`: a range scan of git history; `tree`: the files of an extracted archive (no history). */
  readonly mode: 'phase3-base' | 'derived-merge-base' | 'tree';
  readonly base: string | null;
  readonly head: string | null;
  readonly mainRef: string | null;
  readonly mergeBase: string | null;
  readonly logOpts: string | null;
  readonly commitsInRange: number | null;
  readonly mergesInRange: number | null;
  readonly commitsScanned: number | null;
  /** tree mode: the files scanned */
  readonly filesScanned: number | null;
  readonly findings: number | null;
  readonly allowlisted: readonly { fingerprint: string; reason: string }[];
  readonly remaining: readonly { fingerprint: string; rule: string; file: string; line: number; commit: string | null }[];
  readonly ignoreFile: { readonly present: boolean; readonly sha256: string | null; readonly entries: number; readonly unused: number };
  readonly problems: readonly string[];
  readonly result: 'PASS' | 'FAIL';
}

function resolveMainRef(repo: string, requested: string | undefined): string | null {
  const candidates = requested !== undefined ? [requested] : ['origin/main', 'main'];
  return candidates.find((ref) => gitOk(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) ?? null;
}

export function scan(opts: ScanOptions): ScanResult {
  const problems: string[] = [];
  const repo = resolve(opts.repo);
  const derive = opts.base === 'derive';
  let head: string | null = null;
  let base: string | null = null;
  let mergeBase: string | null = null;
  let logOpts: string | null = null;
  let commitsInRange: number | null = null;
  let mergesInRange: number | null = null;
  let commitsScanned: number | null = null;
  let findings: GitleaksFinding[] | null = null;
  const allowlisted: { fingerprint: string; reason: string }[] = [];
  let remaining: ScanResult['remaining'] = [];
  const binarySha256 = sha256(readFileSync(opts.gitleaks));
  const mainRef = resolveMainRef(repo, opts.mainRef);

  const ignorePath = join(repo, '.gitleaksignore');
  const ignoreText = existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8') : null;
  const parsedAll = ignoreText === null ? { entries: [], problems: [] } : parseIgnoreFile(ignoreText);
  problems.push(...parsedAll.problems);
  // A range finding is fingerprinted with its commit; tree entries are for tree mode.
  const parsed = { entries: parsedAll.entries.filter((e) => e.kind === 'commit') };
  let unused = 0;

  const finish = (): ScanResult => ({
    produced: 'scripts/phase3-secret-scan.ts',
    tool: { name: 'gitleaks', version: GITLEAKS_VERSION, binarySha256 },
    mode: derive ? 'derived-merge-base' : 'phase3-base',
    base,
    head,
    mainRef,
    mergeBase,
    logOpts,
    commitsInRange,
    mergesInRange,
    commitsScanned,
    filesScanned: null,
    findings: findings === null ? null : findings.length,
    allowlisted,
    remaining,
    ignoreFile: { present: ignoreText !== null, sha256: ignoreText === null ? null : sha256(ignoreText), entries: parsed.entries.length, unused },
    problems,
    result: problems.length === 0 && findings !== null && remaining.length === 0 ? 'PASS' : 'FAIL',
  });

  // The rule set is gitleaks' default; nothing in the tree or the environment may replace it.
  if (existsSync(join(repo, '.gitleaks.toml')))
    problems.push('.gitleaks.toml is present: this scan runs the default gitleaks rule set and refuses a config that could replace or allowlist it');
  for (const name of ['GITLEAKS_CONFIG', 'GITLEAKS_CONFIG_TOML']) {
    if ((process.env[name] ?? '') !== '')
      problems.push(`${name} is set: this scan runs the default gitleaks rule set and refuses a config that could replace or allowlist it`);
  }

  const version = spawnSync(opts.gitleaks, ['version'], { encoding: 'utf8' });
  if (version.status !== 0 || version.stdout.trim() !== GITLEAKS_VERSION)
    problems.push(`gitleaks reports version "${String(version.stdout).trim()}", not the pinned ${GITLEAKS_VERSION}`);
  if (binarySha256 !== GITLEAKS_BINARY_SHA256) problems.push(`the gitleaks binary has SHA-256 ${binarySha256}, not the pinned ${GITLEAKS_BINARY_SHA256}`);

  if (!gitOk(repo, ['rev-parse', '--verify', '--quiet', `${opts.head}^{commit}`])) {
    problems.push(`head ${opts.head} is not a commit in ${repo}`);
    return finish();
  }
  head = git(repo, ['rev-parse', '--verify', `${opts.head}^{commit}`]);
  if (mainRef === null) {
    problems.push(`no main ref (${opts.mainRef ?? 'origin/main or main'}) to verify the base against`);
    return finish();
  }
  const mb = gitRun(repo, ['merge-base', head, mainRef]);
  if (mb.status !== 0) {
    problems.push(`${head} and ${mainRef} share no history`);
    return finish();
  }
  mergeBase = mb.stdout.toString('utf8').trim();
  if (derive) {
    base = mergeBase;
  } else {
    if (!/^[0-9a-f]{40}$/.test(opts.base)) {
      problems.push(`--base must be a full 40-hex commit id or "derive", not "${opts.base}"`);
      return finish();
    }
    base = opts.base;
    if (mergeBase !== base) problems.push(`the merge-base of ${head} and ${mainRef} is ${mergeBase}, not the declared base ${base}`);
  }
  if (!gitOk(repo, ['merge-base', '--is-ancestor', base, head])) {
    problems.push(`base ${base} is not an ancestor of head ${head}`);
    return finish();
  }
  if (base === head) problems.push(`base and head are the same commit ${head}: there is nothing to scan, which is not evidence of anything`);

  commitsInRange = Number(git(repo, ['rev-list', '--count', `${base}..${head}`]));
  mergesInRange = Number(git(repo, ['rev-list', '--count', '--merges', `${base}..${head}`]));
  logOpts = `--diff-merges=first-parent ${base}..${head}`;

  const work = mkdtempSync(join(tmpdir(), 'daftar-secret-scan-'));
  try {
    // gitleaks loads `.gitleaksignore` from the scanned directory whatever
    // `--gitleaks-ignore-path` says, and would then drop a listed finding
    // before this script could check that it is a migration digest. So it
    // scans a bare clone that shares this repository's objects (no working
    // tree, so no ignore file and no `.gitleaks.toml`), with the ignore path
    // pointed at an empty directory.
    const noIgnore = join(work, 'no-ignore');
    mkdirSync(noIgnore);
    const bare = join(work, 'objects.git');
    git(repo, ['clone', '--bare', '--shared', '--quiet', repo, bare]);
    const report = join(work, 'report.json');
    const env = { ...process.env };
    delete env['GITLEAKS_CONFIG'];
    delete env['GITLEAKS_CONFIG_TOML'];
    const run = spawnSync(
      opts.gitleaks,
      [
        'git',
        '--no-banner',
        '--no-color',
        '--redact',
        '--ignore-gitleaks-allow',
        '--gitleaks-ignore-path',
        noIgnore,
        '--exit-code',
        '0',
        '--report-format',
        'json',
        '--report-path',
        report,
        '--log-opts',
        logOpts,
        bare,
      ],
      { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 },
    );
    const log = `${run.stdout}\n${run.stderr}`;
    if (run.status !== 0) {
      problems.push(`gitleaks exited ${String(run.status)}: ${log.trim().split('\n').slice(-3).join(' | ')}`);
      return finish();
    }
    const scanned = /(\d+) commits scanned/.exec(log);
    commitsScanned = scanned ? Number(scanned[1]) : null;
    if (commitsScanned === null) problems.push('gitleaks did not report how many commits it scanned');
    else if (commitsScanned !== commitsInRange)
      problems.push(`gitleaks scanned ${commitsScanned} commits but the range ${base.slice(0, 12)}..${head.slice(0, 12)} holds ${commitsInRange}`);
    findings = JSON.parse(readFileSync(report, 'utf8')) as GitleaksFinding[];
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  const byFingerprint = new Map(parsed.entries.map((e) => [e.fingerprint, e]));
  const verified = new Map<string, string | null>();
  for (const e of parsed.entries) verified.set(e.fingerprint, verifyDigestEntry(repo, e));
  for (const problem of verified.values()) if (problem !== null) problems.push(`.gitleaksignore: ${problem}`);

  const left: { fingerprint: string; rule: string; file: string; line: number; commit: string | null }[] = [];
  const seen = new Set<string>();
  for (const f of findings) {
    seen.add(f.Fingerprint);
    const entry = byFingerprint.get(f.Fingerprint);
    if (entry !== undefined && verified.get(f.Fingerprint) === null) {
      allowlisted.push({ fingerprint: f.Fingerprint, reason: entry.reason });
    } else {
      left.push({ fingerprint: f.Fingerprint, rule: f.RuleID, file: f.File, line: f.StartLine, commit: f.Commit });
    }
  }
  remaining = left;
  unused = parsed.entries.filter((e) => !seen.has(e.fingerprint)).length;
  for (const r of remaining) problems.push(`finding ${r.rule} in ${r.file}:${r.line} at ${String(r.commit).slice(0, 12)} (${r.fingerprint})`);
  return finish();
}

// ── tree mode: the extracted archive ─────────────────────────────────────

export interface TreeScanOptions {
  /** an extracted archive (with DELIVERY_MANIFEST.json), or a checkout, whose `git ls-files` is then the inventory */
  readonly root: string;
  readonly gitleaks: string;
}

interface DeliveryInventory {
  readonly sourceCommit?: string;
  readonly inventory?: readonly { readonly path: string; readonly sha256: string }[];
}

/**
 * The files of the tree, as the archive itself lists them: the delivery
 * manifest's inventory in an extracted archive, `git ls-files` in a checkout.
 */
function treeInventory(root: string, problems: string[]): { head: string | null; files: { path: string; sha256: string | null }[] } {
  const manifestPath = join(root, 'DELIVERY_MANIFEST.json');
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as DeliveryInventory;
    if (!Array.isArray(manifest.inventory) || manifest.inventory.length === 0) {
      problems.push('DELIVERY_MANIFEST.json lists no inventory: there is nothing to say the scanned tree is the archive');
      return { head: manifest.sourceCommit ?? null, files: [] };
    }
    return { head: manifest.sourceCommit ?? null, files: manifest.inventory.map((i) => ({ path: i.path, sha256: i.sha256 })) };
  }
  const listed = git(root, ['ls-files', '-z'])
    .split('\0')
    .filter((f) => f.length > 0 && existsSync(join(root, f)));
  return { head: git(root, ['rev-parse', 'HEAD']), files: listed.map((path) => ({ path, sha256: null })) };
}

export function scanTree(opts: TreeScanOptions): ScanResult {
  const problems: string[] = [];
  const root = resolve(opts.root);
  const binarySha256 = sha256(readFileSync(opts.gitleaks));
  const ignorePath = join(root, '.gitleaksignore');
  const ignoreText = existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8') : null;
  const parsedAll = ignoreText === null ? { entries: [], problems: [] } : parseIgnoreFile(ignoreText);
  problems.push(...parsedAll.problems);
  const entries = parsedAll.entries.filter((e) => e.kind === 'tree');
  let findings: GitleaksFinding[] | null = null;
  const allowlisted: { fingerprint: string; reason: string }[] = [];
  const remaining: { fingerprint: string; rule: string; file: string; line: number; commit: string | null }[] = [];
  let unused = 0;
  let filesScanned: number | null = null;

  if (existsSync(join(root, '.gitleaks.toml')))
    problems.push('.gitleaks.toml is present: this scan runs the default gitleaks rule set and refuses a config that could replace or allowlist it');
  for (const name of ['GITLEAKS_CONFIG', 'GITLEAKS_CONFIG_TOML']) {
    if ((process.env[name] ?? '') !== '')
      problems.push(`${name} is set: this scan runs the default gitleaks rule set and refuses a config that could replace or allowlist it`);
  }
  const version = spawnSync(opts.gitleaks, ['version'], { encoding: 'utf8' });
  if (version.status !== 0 || version.stdout.trim() !== GITLEAKS_VERSION)
    problems.push(`gitleaks reports version "${String(version.stdout).trim()}", not the pinned ${GITLEAKS_VERSION}`);
  if (binarySha256 !== GITLEAKS_BINARY_SHA256) problems.push(`the gitleaks binary has SHA-256 ${binarySha256}, not the pinned ${GITLEAKS_BINARY_SHA256}`);

  const { head, files } = treeInventory(root, problems);
  const work = mkdtempSync(join(tmpdir(), 'daftar-secret-tree-'));
  try {
    // Exactly the inventory, each file checked against its recorded digest,
    // copied where no node_modules, build output or ignore file can be read
    // as part of the tree.
    const copy = join(work, 'tree');
    for (const f of files) {
      const src = join(root, f.path);
      if (!existsSync(src)) {
        problems.push(`${f.path} is in the inventory but not in the tree`);
        continue;
      }
      if (f.sha256 !== null && sha256(readFileSync(src)) !== f.sha256) problems.push(`${f.path} does not match its inventory digest`);
      const dst = join(copy, f.path === '.gitleaksignore' ? IGNORE_FILE_AS_DATA : f.path);
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
    }
    filesScanned = files.length;
    const noIgnore = join(work, 'no-ignore');
    mkdirSync(noIgnore);
    mkdirSync(copy, { recursive: true });
    const report = join(work, 'report.json');
    const env = { ...process.env };
    delete env['GITLEAKS_CONFIG'];
    delete env['GITLEAKS_CONFIG_TOML'];
    const run = spawnSync(
      opts.gitleaks,
      [
        'dir',
        '--no-banner',
        '--no-color',
        '--redact',
        '--ignore-gitleaks-allow',
        '--gitleaks-ignore-path',
        noIgnore,
        '--exit-code',
        '0',
        '--report-format',
        'json',
        '--report-path',
        report,
        '.',
      ],
      { cwd: copy, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 },
    );
    if (run.status !== 0) {
      problems.push(`gitleaks exited ${String(run.status)}: ${`${run.stdout}\n${run.stderr}`.trim().split('\n').slice(-3).join(' | ')}`);
    } else {
      findings = (JSON.parse(readFileSync(report, 'utf8')) as GitleaksFinding[]).map((f) => {
        const file = f.File.replace(/^\.\//, '') === IGNORE_FILE_AS_DATA ? '.gitleaksignore' : f.File.replace(/^\.\//, '');
        return { ...f, File: file, Fingerprint: `${file}:${f.RuleID}:${f.StartLine}` };
      });
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  const verified = new Map<string, string | null>();
  for (const e of entries) verified.set(e.fingerprint, verifyTreeEntry(root, e));
  for (const problem of verified.values()) if (problem !== null) problems.push(`.gitleaksignore: ${problem}`);
  const byFingerprint = new Map(entries.map((e) => [e.fingerprint, e]));
  const seen = new Set<string>();
  for (const f of findings ?? []) {
    seen.add(f.Fingerprint);
    const entry = byFingerprint.get(f.Fingerprint);
    if (entry !== undefined && verified.get(f.Fingerprint) === null) allowlisted.push({ fingerprint: f.Fingerprint, reason: entry.reason });
    else remaining.push({ fingerprint: f.Fingerprint, rule: f.RuleID, file: f.File, line: f.StartLine, commit: null });
  }
  unused = entries.filter((e) => !seen.has(e.fingerprint)).length;
  for (const r of remaining) problems.push(`finding ${r.rule} in ${r.file}:${r.line} (${r.fingerprint})`);

  return {
    produced: 'scripts/phase3-secret-scan.ts',
    tool: { name: 'gitleaks', version: GITLEAKS_VERSION, binarySha256 },
    mode: 'tree',
    base: null,
    head,
    mainRef: null,
    mergeBase: null,
    logOpts: null,
    commitsInRange: null,
    mergesInRange: null,
    commitsScanned: null,
    filesScanned,
    findings: findings === null ? null : findings.length,
    allowlisted,
    remaining,
    ignoreFile: { present: ignoreText !== null, sha256: ignoreText === null ? null : sha256(ignoreText), entries: entries.length, unused },
    problems,
    result: problems.length === 0 && findings !== null && remaining.length === 0 ? 'PASS' : 'FAIL',
  };
}

// ── the evidence check, shared with the release evidence ─────────────────

/**
 * What a release may require of a scan artefact: this script produced it, it
 * PASSED, over the Phase 3 base (not a derived one) verified against the
 * merge-base, at exactly `expectedHead`, having scanned every commit in the
 * range, with nothing remaining. Returns every problem; empty means accepted.
 */
export function secretScanEvidenceProblems(e: Partial<ScanResult> | null, expectedHead: string | null): string[] {
  if (e === null) return ['the Phase 3 secret history scan artefact is missing'];
  const p: string[] = [];
  if (e.produced !== 'scripts/phase3-secret-scan.ts') p.push('the secret scan artefact was not produced by scripts/phase3-secret-scan.ts');
  if (e.result !== 'PASS') p.push(`the Phase 3 secret history scan result is ${String(e.result)}`);
  if (e.mode !== 'phase3-base') p.push(`the secret scan ran in mode ${String(e.mode)}, not over the declared Phase 3 base`);
  if (e.base !== PHASE3_BASE) p.push(`the secret scan base is ${String(e.base)}, not the Phase 3 base ${PHASE3_BASE}`);
  if (e.mergeBase !== PHASE3_BASE) p.push(`the secret scan recorded merge-base ${String(e.mergeBase)}, not ${PHASE3_BASE}`);
  if (expectedHead !== null && e.head !== expectedHead) p.push(`the secret scan head is ${String(e.head)}, not the commit under release ${expectedHead}`);
  if (e.tool?.version !== GITLEAKS_VERSION || e.tool?.binarySha256 !== GITLEAKS_BINARY_SHA256)
    p.push(`the secret scan ran gitleaks ${String(e.tool?.version)} (${String(e.tool?.binarySha256)}), not the pinned ${GITLEAKS_VERSION}`);
  if (typeof e.commitsInRange !== 'number' || e.commitsInRange < 1) p.push(`the secret scan range holds ${String(e.commitsInRange)} commits`);
  if (e.commitsScanned !== e.commitsInRange) p.push(`the secret scan read ${String(e.commitsScanned)} of ${String(e.commitsInRange)} commits`);
  if (!Array.isArray(e.remaining) || e.remaining.length !== 0) p.push(`the secret scan leaves ${String(e.remaining?.length)} findings`);
  return p;
}

// ── CLI ───────────────────────────────────────────────────────────────────

/**
 * The head when `--head` is not given: `PHASE3_SCAN_HEAD` if set, else HEAD.
 * A `pull_request` run checks out GitHub's merge commit, whose first-parent
 * diff is the whole pull request, so every finding would be charged to that
 * synthesized commit and no exact fingerprint could match it. The CI job that
 * runs the corrective gate therefore names the PR head here, as the hygiene
 * job names it with `--head`; a push run names the pushed SHA itself.
 */
function defaultHead(): string {
  const named = process.env['PHASE3_SCAN_HEAD'];
  return named === undefined || named.trim() === '' ? 'HEAD' : named.trim();
}

function main(): void {
  const argv = process.argv.slice(2);
  const arg = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit === undefined ? undefined : hit.slice(name.length + 3);
  };
  const repo = resolve(arg('repo') ?? ROOT);
  const evidencePath = arg('evidence');
  const requested = arg('mode') ?? 'auto';
  if (!['auto', 'range', 'tree'].includes(requested)) {
    console.log(`PHASE 3 SECRET SCAN: FAIL\n  - --mode must be auto, range or tree, not "${requested}"`);
    process.exit(1);
  }
  const mode = requested === 'auto' ? (existsSync(join(repo, 'DELIVERY_MANIFEST.json')) ? 'tree' : 'range') : requested;
  let result: ScanResult | null = null;
  try {
    const gitleaks = ensureGitleaks(arg('gitleaks') ?? process.env['GITLEAKS_BIN'], ROOT);
    result =
      mode === 'tree'
        ? scanTree({ root: repo, gitleaks })
        : scan({ repo, head: arg('head') ?? defaultHead(), base: arg('base') ?? PHASE3_BASE, mainRef: arg('main-ref'), gitleaks });
  } catch (e) {
    if (!(e instanceof SecretScanError)) throw e;
    console.log(`PHASE 3 SECRET SCAN: FAIL\n  mode: ${mode === 'tree' ? 'tree (no git history)' : 'range'}\n  - ${e.message}`);
    process.exit(1);
  }
  if (evidencePath !== undefined) {
    const out = resolve(evidencePath);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  }
  const r = result;
  console.log('PHASE 3 SECRET SCAN');
  console.log(`  gitleaks: ${r.tool.version} (sha256 ${r.tool.binarySha256.slice(0, 16)}…)`);
  if (r.mode === 'tree') {
    console.log('  mode: tree (no git history)');
    console.log(`  tree of commit: ${String(r.head)}`);
    console.log(`  files scanned: ${String(r.filesScanned)}`);
  } else {
    console.log(`  mode: range (${r.mode})`);
    console.log(`  base: ${String(r.base)}`);
    console.log(`  head: ${String(r.head)}`);
    console.log(`  merge-base: ${String(r.mergeBase)} (with ${String(r.mainRef)})`);
    console.log(`  log options: ${String(r.logOpts)}`);
    console.log(`  commits in range: ${String(r.commitsInRange)} (${String(r.mergesInRange)} merges)`);
    console.log(`  commits scanned: ${String(r.commitsScanned)}`);
  }
  console.log(`  findings: ${String(r.findings)}`);
  console.log(`  allowlisted: ${r.allowlisted.length} (exact fingerprints, each proved against its content)`);
  for (const a of r.allowlisted) console.log(`    ${a.fingerprint}`);
  console.log(`  remaining: ${r.remaining.length}`);
  console.log(`  result: ${r.result}`);
  console.log(`\nPHASE 3 SECRET SCAN: ${r.result}`);
  for (const p of r.problems) console.log(`  - ${p}`);
  process.exit(r.result === 'PASS' ? 0 : 1);
}

if (require.main === module) main();
