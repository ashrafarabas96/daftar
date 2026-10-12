/**
 * P15 — RESUMABLE CHECKPOINT (HIGH-VELOCITY PART 22)
 * =================================================
 *
 * PART 22 asks for a checkpoint another session can resume from without asking
 * anyone: the last known good SHA, the current candidate, what is accepted,
 * which agents are active, which reviews are pending, the open blockers, the
 * task order, the signed heads, which evidence is still valid, and the next
 * executable tasks.
 *
 * WHY THIS IS A COMMAND AND NOT A DOCUMENT
 *
 * A checkpoint written by hand is wrong within the hour, and a stale checkpoint
 * is worse than none: a resuming session trusts it precisely because it looks
 * authoritative. This round has a measured instance of that hazard — the
 * handoff's own Arabic summary sat ten commits behind, and the independent
 * challenger found it, not any gate. So everything here that CAN be measured is
 * measured at run time, and everything that cannot is read from the files that
 * own it, with its source named.
 *
 * `--check` re-reads the written checkpoint and exits 1 when HEAD has moved past
 * it, so a resuming session can tell "current" from "plausible". A handoff that
 * cannot detect its own expiry will eventually lie.
 *
 * WHAT IT WILL NOT CARRY
 *
 * No connection string, password, token or credential, measured or declared.
 * The fixture passwords in this pack are minted per run and must never be
 * written to a file that outlives the run. The checkpoint names the ENV VAR a
 * resuming session needs, never a value.
 *
 * It also records no verdict. Nothing here accepts, seals or signs: a checkpoint
 * is a position, and PART 15 reserves the judgement for the challenger and the
 * coordinator.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const PACK = '/mnt/project-files/phase15';
const OUT = join(PACK, 'P15-RESUME-CHECKPOINT.md');
const BRANCH = 'claude/project-thread-n5qrtj';
const BASE = 'origin/main';

const git = (args: readonly string[]): { ok: boolean; out: string } => {
  const r = spawnSync('git', [...args], { cwd: ROOT, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
};

/** A fact that was measured, with the command that measured it. */
interface Fact {
  readonly what: string;
  readonly value: string;
  readonly how: string;
}

function measure(): readonly Fact[] {
  const head = git(['rev-parse', 'HEAD']).out;
  const status = git(['status', '--porcelain']).out;
  const facts: Fact[] = [
    { what: 'branch', value: git(['rev-parse', '--abbrev-ref', 'HEAD']).out, how: 'git rev-parse --abbrev-ref HEAD' },
    { what: 'HEAD (the current candidate for this pack)', value: head, how: 'git rev-parse HEAD' },
    { what: 'pushed head on the remote', value: git(['rev-parse', `origin/${BRANCH}`]).ok ? git(['rev-parse', `origin/${BRANCH}`]).out : 'NOT PUSHED or not fetched — a local head nobody else can read is not a checkpoint', how: `git rev-parse origin/${BRANCH}` },
    { what: 'base', value: `${git(['merge-base', 'HEAD', BASE]).out} (merge-base with ${BASE})`, how: `git merge-base HEAD ${BASE}` },
    { what: 'last known good SHA on the base', value: git(['rev-parse', BASE]).out, how: `git rev-parse ${BASE}` },
    { what: 'tree state', value: status.length === 0 ? 'clean' : `${status.split('\n').length} path(s) uncommitted — any evidence produced now is PREPARATION ONLY`, how: 'git status --porcelain' },
    { what: 'commits ahead of the base', value: git(['rev-list', '--count', `${BASE}..HEAD`]).out, how: `git rev-list --count ${BASE}..HEAD` },
    { what: 'migrations allocated or edited by this branch', value: ((): string => {
        const d = git(['diff', '--name-only', `${BASE}...HEAD`]).out.split('\n').filter((f) => /migrations\//.test(f));
        return d.length === 0 ? 'NONE — the frozen set is untouched, which is the precondition for this pack existing' : `${d.length}: ${d.join(', ')} — THIS NEEDS THE MIGRATION OWNER BEFORE ANYTHING ELSE`;
      })(), how: `git diff --name-only ${BASE}...HEAD | grep migrations/` },
  ];
  return facts;
}

/**
 * The pack's documents, with the digest of what is on disk NOW. A resuming
 * session needs to know whether the document it is about to trust is the one
 * the last session wrote, and in a multi-writer directory that is not a
 * question it can answer from the filename.
 */
function packState(): readonly { readonly file: string; readonly bytes: number; readonly sha: string }[] {
  if (!existsSync(PACK)) return [];
  const names = spawnSync('ls', ['-1', PACK], { encoding: 'utf8' });
  return (names.stdout ?? '')
    .split('\n')
    // The handoff manifest is EXCLUDED, and its own gate is cited instead.
    // Otherwise the two indexes are circular: the manifest's digest table must
    // be rewritten as the LAST action of a round, which would immediately
    // invalidate a digest recorded for it here, and a digest table that is
    // known-stale by construction teaches a reader to ignore digest tables.
    // One file, one indexing authority.
    .filter((f) => /^P15-.*\.(md|json)$/.test(f.trim()) && f.trim() !== 'P15-HANDOFF-MANIFEST.md')
    .map((f) => f.trim())
    .map((f) => {
      const b = readFileSync(join(PACK, f));
      return { file: f, bytes: b.length, sha: createHash('sha256').update(b).digest('hex') };
    });
}

/** The blocker ids the handoff declares, read from it rather than restated. */
function blockers(): readonly string[] {
  const f = join(PACK, 'P15-HANDOFF-MANIFEST.md');
  if (!existsSync(f)) return [];
  const text = readFileSync(f, 'utf8');
  const ids = [...text.matchAll(/^\| (B-\d+[a-z]?) \|/gm)].map((m) => m[1] ?? '');
  return [...new Set(ids)];
}

function checkMode(): number {
  if (!existsSync(OUT)) {
    console.log(`EXIT 1 — there is no checkpoint at ${OUT}. Run it without --check to write one.`);
    return 1;
  }
  const text = readFileSync(OUT, 'utf8');
  const head = git(['rev-parse', 'HEAD']).out;
  const stated = /checkpoint HEAD\s*\|\s*`([0-9a-f]{40})`/.exec(text);
  console.log('P15 RESUME CHECKPOINT — CURRENCY CHECK');
  console.log(`  checkpoint says : ${stated?.[1] ?? 'NO HEAD RECORDED'}`);
  console.log(`  HEAD is now     : ${head}`);
  if (stated?.[1] === head) {
    console.log('  CURRENT — the checkpoint describes this head.');
    return 0;
  }
  console.log('');
  console.log('EXIT 1 — THE CHECKPOINT IS STALE. It describes a head that is not this one, so a');
  console.log('  resuming session must re-generate it before relying on any position in it.');
  console.log('  This is the point of the check: a handoff that cannot detect its own expiry will');
  console.log('  eventually be read as current when it is not.');
  return 1;
}

function main(): number {
  if (process.argv.includes('--check')) return checkMode();

  const facts = measure();
  const head = facts.find((f) => f.what.startsWith('HEAD'))?.value ?? 'UNKNOWN';
  const pack = packState();
  const bs = blockers();
  const now = new Date().toISOString();

  const lines: string[] = [];
  lines.push('# P15 — RESUMABLE CHECKPOINT (PART 22)');
  lines.push('');
  lines.push('**Generated, not written.** `npm run checkpoint:phase15` rewrites this file from');
  lines.push('measurement; `npm run checkpoint:phase15 -- --check` exits 1 when HEAD has moved past it.');
  lines.push('A position stated here was true at the timestamp below and nowhere else.');
  lines.push('');
  lines.push('| | |');
  lines.push('|---|---|');
  lines.push(`| checkpoint HEAD | \`${head}\` |`);
  lines.push(`| written (UTC) | ${now} |`);
  lines.push('| status | **`PREPARED / NOT PROMOTED`** — and this file awards nothing |');
  lines.push('');
  lines.push('## 1 · Position, measured');
  lines.push('');
  lines.push('| what | value | how it was measured |');
  lines.push('|---|---|---|');
  for (const f of facts) lines.push(`| ${f.what} | ${f.value.startsWith('NONE') || f.value === 'clean' ? `**${f.value}**` : `\`${f.value}\`` } | \`${f.how}\` |`);
  lines.push('');
  lines.push('## 2 · What is accepted, and by whom');
  lines.push('');
  lines.push('- **Accepted by this author: nothing.** An author does not sign their own work (PART 15).');
  lines.push('- **An independent challenger reviewed `2c0abec` and returned REJECT**, signing eleven');
  lines.push('  items it re-measured itself. Its report is `P15-CHALLENGE-2c0abec.md` in this directory.');
  lines.push('  Both of its P1 findings are addressed in code; see §8c of the handoff manifest.');
  lines.push('- **A signature on `2c0abec` does not transfer to this head.** What is owed is a');
  lines.push('  re-challenge at the current head, and Coordinator acceptance, which has not been given.');
  lines.push('- **Phase 4 is not sealed**, and Phase 15 cannot promote before it (PART 88).');
  lines.push('');
  lines.push('## 3 · Open blockers');
  lines.push('');
  lines.push(`${bs.length} declared in \`P15-HANDOFF-MANIFEST.md\` §9, read from that file: ${bs.join(', ')}.`);
  lines.push('');
  lines.push('Two are the owner\'s and only the owner\'s: the **alert destination** (B-15) and');
  lines.push('**confirmation of the production PITR/RDS plan** with real access and approved');
  lines.push('retention/RPO/RTO (B-3, B-16). Neither may delay anything else.');
  lines.push('');
  lines.push('## 4 · Next executable tasks, in order');
  lines.push('');
  lines.push('Each is executable by a resuming session with no further authorisation, and none of');
  lines.push('them touches a frozen migration, `main`, the Phase 4 branch, or production.');
  lines.push('');
  lines.push('1. **B-18** — plant one red proof each for DR `V3`, `V4`, `V8`, `V9` and PITR `P5`–`P9`,');
  lines.push('   or print, per validator, that it carries none. Highest value: `V4` (tenant isolation');
  lines.push('   survives the restore) and `V3`/`P5` (the recovered ledger balances). A red proof must');
  lines.push('   redden **its own named validator**, not merely something.');
  lines.push('2. **B-20** — extend `verify:evidence-log` to the remaining eight instruments, starting');
  lines.push('   with `audit:deps:phase15`, the only one that fails for a substantive reason.');
  lines.push('3. **B-21** — declare and check the three preconditions, and give "did not run" an exit');
  lines.push('   code distinct from "ran and left an item unmeasured".');
  lines.push('4. **B-22** — let a diagnostic-only PG context go UNMEASURED without aborting the');
  lines.push('   primary line.');
  lines.push('5. **B-23** — name the collation in the DR and PITR evidence blocks, or run their');
  lines.push('   primary line at `en_US.utf8`.');
  lines.push('6. **B-19** — make `P9`\'s verdict and subject count carry the measured number, and');
  lines.push('   rename `P8`\'s question to what it measures.');
  lines.push('7. **B-24** — record the digest of the subject the release secret scan scanned.');
  lines.push('');
  lines.push('**Owed regardless, and not fixable here:** a **Node 24** re-run (every result in this');
  lines.push('pack was produced on Node v22.22.0 against `engines: >=24 <25`, and no Node 24 exists in');
  lines.push('this container), and a read of the **real** Phase 4/staging/production role attributes,');
  lines.push('which the Security Authority performs with `npm run verify:role-attributes` and their own');
  lines.push('credentials. That instrument needs `P15_ROLE_READ_URL` set; this file records the');
  lines.push('variable\'s NAME and never a value.');
  lines.push('');
  lines.push('## 5 · Evidence still valid at this head');
  lines.push('');
  lines.push('Re-run rather than trusted: `npm run verify:evidence-log` drives six instruments and');
  lines.push('prints the full PART 19 record per proof — base SHA, runtime, database version **and');
  lines.push('collation**, execution role, UTC window, counts beside the summary line they were read');
  lines.push('from, log digest, and measurement validity. Any run on an unclean tree is marked');
  lines.push('PREPARATION ONLY by its own run id, and is not final-SHA evidence.');
  lines.push('');
  lines.push('## 6 · The pack on disk right now');
  lines.push('');
  lines.push('These documents are **not in Git at any head**. They live in a directory other sessions');
  lines.push('write to, so these digests describe this instant only — which is why `--check` exists.');
  lines.push('');
  lines.push('`P15-HANDOFF-MANIFEST.md` is deliberately **absent** from this table: its digest table is');
  lines.push('rewritten as the last action of a round, so any digest recorded for it here would be stale');
  lines.push('by construction. It is verified by its own gate, `npm run verify:handoff-manifest`. One');
  lines.push('file, one indexing authority.');
  lines.push('');
  lines.push('| file | bytes | sha256 |');
  lines.push('|---|---|---|');
  for (const f of pack) lines.push(`| \`${f.file}\` | ${f.bytes.toLocaleString('en-US')} | \`${f.sha}\` |`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('*No credential, connection string or token appears in this file, measured or declared.*');
  lines.push('');

  writeFileSync(OUT, lines.join('\n'));
  console.log('P15 RESUME CHECKPOINT (PART 22) — WRITTEN');
  console.log('='.repeat(78));
  console.log(`  ${OUT}`);
  console.log(`  head ${head}`);
  console.log(`  ${facts.length} measured position(s), ${bs.length} blocker(s) read from the manifest, ${pack.length} document(s) digested`);
  console.log('');
  console.log('  It awards nothing and signs nothing. Re-run with --check before trusting it.');
  return 0;
}

process.exitCode = main();
