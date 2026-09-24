/**
 * EXACT-SHA BINDING FOR EVERY P2-S8 EVIDENCE ARTEFACT (f §11).
 *
 * The problem this solves is not that the numbers were wrong. It is that a
 * JSON file full of milliseconds says nothing about WHICH TREE produced them.
 * A reviewer holding `phase2-s8-performance-tier2.json` could not tell
 * whether it was measured against the commit being accepted, against the same
 * commit with one migration edited, or on a laptop three days earlier — and a
 * measurement that cannot be tied to a commit is a measurement of something
 * nobody can name.
 *
 * So every artefact carries the same block, produced here rather than written
 * out by hand in four places: the head commit, both candidate migrations'
 * SHA-256s, the Node version, the run identity when the producer was GitHub
 * Actions, and when it was produced.
 *
 * ── The assertion, and where it belongs ──────────────────────────────────
 *
 * f §11 also asks that, when `GITHUB_SHA` is set, the tree actually checked
 * out is the tree GitHub says it is. That is a refusal, and it is deliberately
 * NOT thrown from here. A helper that threw would fail a measurement suite
 * half an hour into a run, with a message about environment variables, for a
 * condition that has nothing to do with the measurement. Instead this records
 * `githubSha` beside `head`, and `assertExactShaBinding` — called by the
 * gates, which are cheap and run first — is what refuses a mismatch.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_ROOT = join(__dirname, '..');

/** The two candidate migrations under review. Frozen history is covered by the manifest. */
export const P2_S8_CANDIDATES = ['0051_accounting_reconciler_read.sql', '0052_accounting_journal_lines_rls_performance.sql'] as const;

export interface ExactShaBinding {
  /** `git rev-parse HEAD` in the tree that produced the artefact. */
  readonly head: string;
  readonly branch: string;
  /** What GitHub said the commit was, when a workflow produced this. */
  readonly githubSha: string | null;
  /**
   * The commit the RUN was asked to be about, when that is not the same
   * thing. `workflow_dispatch` can only be pointed at a branch or a tag, so
   * the evidence workflow takes the commit as an input, checks it out, and
   * declares it here; `GITHUB_SHA` then names the branch head the dispatch
   * resolved to, which may have moved on. Both are recorded, and the
   * assertion below binds HEAD to this one when it is present, because it is
   * the commit being accepted.
   */
  readonly expectedSha: string | null;
  readonly githubRunId: string | null;
  readonly githubRunAttempt: string | null;
  readonly githubWorkflow: string | null;
  readonly producedIn: 'GITHUB_ACTIONS' | 'LOCAL';
  readonly producedAt: string;
  readonly node: string;
  /** name → SHA-256 of the file as it was on disk when this was produced. */
  readonly candidates: Record<string, string>;
}

const git = (root: string, ...args: string[]): string => {
  const res = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : 'unknown';
};

const envOrNull = (name: string): string | null => {
  const v = process.env[name];
  return v === undefined || v === '' ? null : v;
};

export function candidateDigests(root: string = DEFAULT_ROOT): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of P2_S8_CANDIDATES) {
    const path = join(root, 'infrastructure/database/migrations', name);
    out[name] = existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'absent';
  }
  return out;
}

export function exactShaBinding(root: string = DEFAULT_ROOT): ExactShaBinding {
  const githubSha = envOrNull('GITHUB_SHA');
  return {
    head: git(root, 'rev-parse', 'HEAD'),
    branch: git(root, 'rev-parse', '--abbrev-ref', 'HEAD'),
    githubSha,
    expectedSha: envOrNull('P2S8_EXPECTED_SHA'),
    githubRunId: envOrNull('GITHUB_RUN_ID'),
    githubRunAttempt: envOrNull('GITHUB_RUN_ATTEMPT'),
    githubWorkflow: envOrNull('GITHUB_WORKFLOW'),
    producedIn: envOrNull('GITHUB_ACTIONS') === 'true' ? 'GITHUB_ACTIONS' : 'LOCAL',
    producedAt: new Date().toISOString(),
    node: process.version,
    candidates: candidateDigests(root),
  };
}

/**
 * The refusal f §11 names: inside GitHub Actions, the checked-out tree must be
 * the commit GitHub is reporting on. Returns the reason, or null when the
 * binding holds (including outside Actions, where there is nothing to bind to).
 */
export function exactShaMismatch(root: string = DEFAULT_ROOT): string | null {
  const expected = envOrNull('P2S8_EXPECTED_SHA') ?? envOrNull('GITHUB_SHA');
  if (expected === null) return null;
  const label = envOrNull('P2S8_EXPECTED_SHA') === null ? 'GITHUB_SHA' : 'the commit this run was asked to produce evidence for';
  const head = git(root, 'rev-parse', 'HEAD');
  if (head === expected) return null;
  return `${label} is ${expected} but the checked-out tree is at ${head} — every claim this run makes would be attributed to a commit it did not read (f §11)`;
}
