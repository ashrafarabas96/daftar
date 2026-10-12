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
/**
 * The pack directory. Overridable ONLY so the red proof can plant a deletion
 * in a COPY: the shared directory is never written by a proof, and a run
 * against anything but the default says so in its own output.
 */
const PACK = process.env['P15_PACK_DIR'] ?? '/mnt/project-files/phase15';
const DEFAULT_PACK = '/mnt/project-files/phase15';
const OUT = join(PACK, 'P15-RESUME-CHECKPOINT.md');
const BRANCH = 'claude/project-thread-n5qrtj';
/**
 * The base ref. Overridable ONLY so the red proof can point it at a ref that
 * does not exist, which is the condition coordinator F-5 was found in. No
 * proof needs to delete a real remote-tracking ref to establish it, and a
 * proof that mutates the repository to make its point is not one this pack
 * will run. A non-default base is announced in the output.
 */
const BASE = process.env['P15_BASE_REF'] ?? 'origin/main';
const DEFAULT_BASE = 'origin/main';

/**
 * FAIL CLOSED ON A FAILED GIT COMMAND — coordinator F-5, challenger round 6.
 *
 * This returned `{ ok, out }` and most callers read `.out` and ignored `.ok`.
 * `git rev-parse origin/main` prints its UNRESOLVED ARGUMENT to stdout and
 * exits 128 when the ref is missing, so with `origin/main` absent the
 * checkpoint wrote the literal string **"origin/main"** into a shared project
 * file as the last known-good release SHA, and exited 0. The migrations fact
 * was worse: `git diff` exited 128, the empty output filtered to nothing, and
 * the file recorded "NONE — the frozen set is untouched" — a reassurance
 * manufactured out of a failure, about the one thing in this repository that
 * must never move unnoticed.
 *
 * So `git()` now carries the exit code and stderr, and `measured()` is the only
 * way a value reaches the document: a failed command yields an UNMEASURED
 * string naming the command and the code. "I could not look" and "I looked and
 * it is clean" must not print the same way, and a ref name is not a SHA.
 */
const git = (args: readonly string[]): { ok: boolean; out: string; code: number | null; err: string } => {
  const r = spawnSync('git', [...args], { cwd: ROOT, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), code: r.status, err: (r.stderr ?? '').trim().split('\n')[0] ?? '' };
};

/**
 * A git-measured value, or an explicit statement that it could not be measured.
 * `shape` is an optional sanity check on the VALUE itself: a command can exit 0
 * and still hand back something that is not what the caller asked for.
 */
const measured = (args: readonly string[], shape?: RegExp): string => {
  const r = git(args);
  if (!r.ok) return `UNMEASURED — \`git ${args.join(' ')}\` exited ${String(r.code)}${r.err === '' ? '' : `: ${r.err}`}`;
  if (shape !== undefined && !shape.test(r.out))
    return `UNMEASURED — \`git ${args.join(' ')}\` exited 0 but its output is not the expected shape (${r.out.slice(0, 60)})`;
  return r.out;
};

const SHA = /^[0-9a-f]{40}$/;

/** A fact that was measured, with the command that measured it. */
interface Fact {
  readonly what: string;
  readonly value: string;
  readonly how: string;
}

function measure(): readonly Fact[] {
  const headR = git(['rev-parse', 'HEAD']);
  const statusR = git(['status', '--porcelain']);
  const pushed = measured(['rev-parse', `origin/${BRANCH}`], SHA);
  const facts: Fact[] = [
    { what: 'branch', value: measured(['rev-parse', '--abbrev-ref', 'HEAD']), how: 'git rev-parse --abbrev-ref HEAD' },
    { what: 'HEAD (the current candidate for this pack)', value: measured(['rev-parse', 'HEAD'], SHA), how: 'git rev-parse HEAD' },
    {
      what: 'pushed head on the remote',
      value: pushed.startsWith('UNMEASURED')
        ? `NOT PUSHED or not fetched — a local head nobody else can read is not a checkpoint (${pushed})`
        : pushed,
      how: `git rev-parse origin/${BRANCH}`,
    },
    {
      what: 'base',
      value: ((): string => {
        const mb = measured(['merge-base', 'HEAD', BASE], SHA);
        return mb.startsWith('UNMEASURED') ? mb : `${mb} (merge-base with ${BASE})`;
      })(),
      how: `git merge-base HEAD ${BASE}`,
    },
    // The shape check matters most here: `git rev-parse <missing ref>` exits
    // 128 having echoed the REF NAME to stdout, so without it this field read
    // "origin/main" and looked like an answer.
    { what: 'last known good SHA on the base', value: measured(['rev-parse', BASE], SHA), how: `git rev-parse ${BASE}` },
    {
      what: 'tree state',
      value: !statusR.ok
        ? `UNMEASURED — \`git status --porcelain\` exited ${String(statusR.code)}`
        : statusR.out.length === 0
          ? 'clean'
          : `${statusR.out.split('\n').length} path(s) uncommitted — any evidence produced now is PREPARATION ONLY`,
      how: 'git status --porcelain',
    },
    { what: 'commits ahead of the base', value: measured(['rev-list', '--count', `${BASE}..HEAD`], /^\d+$/), how: `git rev-list --count ${BASE}..HEAD` },
    {
      what: 'migrations allocated or edited by this branch',
      value: ((): string => {
        const r = git(['diff', '--name-only', `${BASE}...HEAD`]);
        // A failed diff must NEVER read as "the frozen set is untouched". That
        // is the single most load-bearing reassurance in this pack, and it was
        // being manufactured out of an exit 128.
        if (!r.ok)
          return `UNMEASURED — \`git diff --name-only ${BASE}...HEAD\` exited ${String(r.code)}${r.err === '' ? '' : `: ${r.err}`}. This is NOT a statement that the frozen set is untouched.`;
        const d = r.out.split('\n').filter((f) => /migrations\//.test(f));
        return d.length === 0
          ? 'NONE — the frozen set is untouched, which is the precondition for this pack existing'
          : `${d.length}: ${d.join(', ')} — THIS NEEDS THE MIGRATION OWNER BEFORE ANYTHING ELSE`;
      })(),
      how: `git diff --name-only ${BASE}...HEAD | grep migrations/`,
    },
  ];
  if (!headR.ok) facts.unshift({ what: '! THIS CHECKPOINT IS NOT TRUSTWORTHY', value: `git rev-parse HEAD exited ${String(headR.code)} — nothing below is anchored to a commit`, how: 'git rev-parse HEAD' });
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
  // `ls` can fail — a permission change, an unmounted share — and an empty
  // listing from a failed command would mean "the pack has no documents",
  // which is the exact false reading the currency check now exists to stop.
  // Returning an empty array here is safe BECAUSE that check treats an empty
  // table as a refusal; this makes the cause visible rather than inferred.
  const names = spawnSync('ls', ['-1', PACK], { encoding: 'utf8' });
  if (names.error !== undefined || names.status !== 0) {
    console.error(`! could not list ${PACK} (ls exited ${String(names.status)}): the pack state below is UNMEASURED, not empty`);
    return [];
  }
  return (names.stdout ?? '')
    .split('\n')
    // The handoff manifest is EXCLUDED, and its own gate is cited instead.
    // Otherwise the two indexes are circular: the manifest's digest table must
    // be rewritten as the LAST action of a round, which would immediately
    // invalidate a digest recorded for it here, and a digest table that is
    // known-stale by construction teaches a reader to ignore digest tables.
    // One file, one indexing authority.
    .filter((f) => /^P15-.*\.(md|json)$/.test(f.trim()) && f.trim() !== 'P15-HANDOFF-MANIFEST.md' && f.trim() !== 'P15-RESUME-CHECKPOINT.md')
    // This file is excluded too, and for a harder reason than the manifest: a
    // file cannot carry its own digest. Including itself made every write change
    // the digest it had just recorded, so the output was non-deterministic no
    // matter how the timestamp was derived. Its own integrity is the manifest's
    // to record, which is the same one-file-one-authority rule running the other
    // way.
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
  // The comparison's OWN side can fail too. If HEAD cannot be read there is no
  // head to compare against, and reporting STALE would be as wrong as
  // reporting CURRENT: neither was measured.
  const headR = git(['rev-parse', 'HEAD']);
  const head = headR.ok && SHA.test(headR.out) ? headR.out : null;
  const stated = /checkpoint HEAD\s*\|\s*`([0-9a-f]{40})`/.exec(text);
  console.log('P15 RESUME CHECKPOINT — CURRENCY CHECK');
  if (head === null) {
    console.log(`  EXIT 2 — NOT MEASURED: \`git rev-parse HEAD\` exited ${String(headR.code)}, so there is no head to`);
    console.log('  compare the checkpoint against. This is not STALE and not CURRENT.');
    return 2;
  }
  if (PACK !== DEFAULT_PACK) console.log(`  ! NOT THE DEFAULT PACK: ${PACK}`);
  if (BASE !== DEFAULT_BASE) console.log(`  ! NOT THE DEFAULT BASE REF: ${BASE}`);
  console.log(`  checkpoint says : ${stated?.[1] ?? 'NO HEAD RECORDED'}`);
  console.log(`  HEAD is now     : ${head}`);
  // A HEAD MATCH IS NOT CURRENCY — the challenger's round-4 finding.
  //
  // This check compared the recorded head to HEAD and nothing else, so with all
  // fourteen pack documents DELETED it printed CURRENT: the head had not moved,
  // and absence was invisible to it. A checkpoint exists to tell a resuming
  // session whether the documents it is about to trust are the ones the last
  // session wrote, and a document that is gone fails that question harder than
  // one that drifted. So the recorded digest table is re-read against the disk,
  // and a missing file, a changed digest and a document the table never
  // recorded are each named.
  const rows = [...text.matchAll(/^\|\s*`(P15-[^`]+)`\s*\|\s*([\d,]+)\s*\|\s*`([0-9a-f]{64})`\s*\|/gm)].map((m) => ({
    file: m[1] ?? '',
    bytes: Number((m[2] ?? '0').replace(/,/g, '')),
    sha: m[3] ?? '',
  }));
  const missing: string[] = [];
  const drifted: string[] = [];
  for (const row of rows) {
    const onDisk = join(PACK, row.file);
    if (!existsSync(onDisk)) {
      missing.push(row.file);
      continue;
    }
    const b = readFileSync(onDisk);
    const sha = createHash('sha256').update(b).digest('hex');
    if (sha !== row.sha) drifted.push(`${row.file} (recorded ${row.sha.slice(0, 12)}, on disk ${sha.slice(0, 12)}, ${row.bytes} \u2192 ${b.length} bytes)`);
  }
  const recorded = new Set(rows.map((r) => r.file));
  const unrecorded = packState()
    .map((e) => e.file)
    .filter((f) => !recorded.has(f));

  console.log(`  pack documents  : ${rows.length} recorded; ${missing.length} MISSING, ${drifted.length} DRIFTED, ${unrecorded.length} on disk but unrecorded`);
  if (rows.length === 0) {
    console.log('');
    console.log('EXIT 1 — THE CHECKPOINT RECORDS NO DOCUMENT AT ALL. Whatever head it names, it');
    console.log('  indexes nothing, so it cannot tell a resuming session that anything is intact.');
    return 1;
  }
  for (const f of missing) console.log(`    MISSING  ${f} — recorded here, not on disk`);
  for (const d of drifted) console.log(`    DRIFTED  ${d}`);
  for (const f of unrecorded) console.log(`    UNRECORDED ${f} — on disk, absent from this checkpoint's table`);

  if (stated?.[1] === head && missing.length === 0 && drifted.length === 0 && unrecorded.length === 0) {
    console.log('  CURRENT — the checkpoint describes this head, and every document it records is on');
    console.log('  disk with the digest it recorded.');
    return 0;
  }
  if (stated?.[1] === head) {
    console.log('');
    console.log('EXIT 1 — THE HEAD MATCHES BUT THE PACK DOES NOT. A currency check that only compared');
    console.log('  heads reported CURRENT with every document deleted, because absence moves no SHA.');
    console.log('  A checkpoint answers "are the documents I am about to trust the ones the last');
    console.log('  session wrote", and for a file that is gone the answer is no, not silence.');
    return 1;
  }
  console.log('');
  console.log('EXIT 1 — THE CHECKPOINT IS STALE. It describes a head that is not this one, so a');
  console.log('  resuming session must re-generate it before relying on any position in it.');
  console.log('  This is the point of the check: a handoff that cannot detect its own expiry will');
  console.log('  eventually be read as current when it is not.');
  return 1;
}

function main(): number {
  // THE SAFE VERB IS THE DEFAULT.
  //
  // The bare command used to REGENERATE, and the independent challenger ran it
  // for the most reasonable possible motive: it was the only verb available,
  // and nothing in the command or its output said otherwise. That rewrote a
  // document in a directory several sessions share, and the challenger had to
  // disclose having done so rather than being able to undo it.
  //
  // A command whose default action writes to shared state, when its read-only
  // mode is the one a reader almost always wants, is a trap with a polite
  // manual. So `--check` is now what a bare invocation does, and writing takes
  // an explicit `--write`. The determinism fix means a legitimate rewrite is
  // byte-identical at an unchanged head anyway, so the cost of the stricter
  // default is nil and the benefit is that nobody writes by accident.
  if (!process.argv.includes('--write')) {
    if (!process.argv.includes('--check')) {
      console.log('P15 RESUME CHECKPOINT — read-only by default. Pass --write to regenerate.');
      console.log('');
    }
    return checkMode();
  }

  const facts = measure();

  // H-03: REFUSE TO WRITE A POSITION NOBODY CAN RESUME FROM.
  //
  // With `origin/main` unreachable, every base-derived fact is honestly
  // UNMEASURED — the shape check above saw to that — and the write path then
  // persisted the document anyway and exited 0. A checkpoint exists to be
  // resumed from; a checkpoint whose base, merge-base, commits-ahead and
  // migration diff are all "could not look" is not a position, and persisting it
  // with exit 0 tells the next reader there is one. The pushed-head fact has had
  // this arm since round 3 ("a local head nobody else can read is not a
  // checkpoint"); the base facts had none, which is the half the challenger
  // found. Fetch the base and run again: that is one command, and it is cheaper
  // than a plausible document.
  const BASE_FACTS = ['base', 'last known good SHA on the base', 'commits ahead of the base', 'migrations allocated or edited by this branch'];
  const unresolvedBase = facts.filter((f) => BASE_FACTS.includes(f.what) && f.value.startsWith('UNMEASURED'));
  if (unresolvedBase.length > 0) {
    console.log('');
    console.log(`EXIT 1 \u2014 NOTHING WAS WRITTEN. The base ref \`${BASE}\` could not be resolved, so ${unresolvedBase.length} of this`);
    console.log('  checkpoint\u2019s positions are UNMEASURED:');
    for (const f of unresolvedBase) console.log(`    \u00b7 ${f.what} \u2014 ${f.value.slice(0, 160)}`);
    console.log('  A checkpoint is a position to resume from. One whose base nobody can resolve is not');
    console.log('  a position, and writing it with exit 0 would tell the next reader that there is one.');
    console.log(`  Fetch the base and run again: \`git fetch origin ${BASE.replace(/^origin\//, '')}\`. P15_BASE_REF names a different one.`);
    console.log('  The document on disk is UNCHANGED, so whatever position it already records still stands.');
    return 1;
  }

  const head = facts.find((f) => f.what.startsWith('HEAD'))?.value ?? 'UNKNOWN';
  const pack = packState();
  const bs = blockers();
  // DETERMINISM: the time is the HEAD COMMIT's date, not the clock.
  //
  // This file was stamped with `new Date().toISOString()`, and the handoff
  // manifest digest-indexes it — so two consecutive runs produced two different
  // digests and `verify:handoff-manifest` went stale every time the checkpoint
  // was regenerated. The independent challenger measured it: the two gates
  // could never both be green, permanently. A digest gate over a
  // self-regenerating file measures the clock rather than the content, and a
  // gate people learn to silence with `--rewrite` is worse than no gate.
  //
  // The commit date is the right clock anyway: this file describes a HEAD, so
  // its content should change when the HEAD changes and at no other time.
  // Regenerating at an unchanged head is now byte-identical, which is what
  // makes the digest meaningful.
  const dateR = git(['show', '-s', '--format=%cI', 'HEAD']);
  const now =
    dateR.ok && dateR.out.length > 0
      ? `${dateR.out}  (the HEAD commit's date — this file is deterministic at a given head, by design)`
      : `UNMEASURED — \`git show -s --format=%cI HEAD\` exited ${String(dateR.code)}, so this file carries no timestamp it measured`;

  const lines: string[] = [];
  lines.push('# P15 — RESUMABLE CHECKPOINT (PART 22)');
  lines.push('');
  lines.push('**Generated, not written, and deterministic.** `npm run checkpoint:phase15` CHECKS this file;');
  lines.push('`npm run checkpoint:phase15 -- --write` rewrites it — the read-only verb is the default, because');
  lines.push('this directory has several writers and a bare command should not change shared state. It rewrites');
  lines.push('this file from measurement, and at an unchanged head it rewrites it **byte-identically** — its');
  lines.push('timestamp is the HEAD commit\'s date, not the clock, so the manifest can digest-index it');
  lines.push('without the two gates fighting. It still changes when another pack document changes,');
  lines.push('because §6 digests them, and that is real content drift rather than a moving clock.');
  lines.push('');
  lines.push('**`--check` reads more than the head.** It compares the head it records against `HEAD`, AND');
  lines.push('re-reads §6 against the disk, naming a MISSING document, a DRIFTED digest, a document on');
  lines.push('disk that §6 never recorded, and an empty table. It used to compare the head alone, so with');
  lines.push('every document in this pack DELETED it still printed CURRENT: deleting a file moves no SHA.');
  lines.push('`npm run checkpoint:phase15:prove` plants each of those five cases and requires this check to');
  lines.push('go red naming it.');
  lines.push('');
  // H-05: this block used to say `checkpoint:phase15` rewrites the file and that
  // `--check` exits 1 when HEAD has moved past it. Both stopped being true two
  // commits apart — the read-only verb became the default, and `--check` grew to
  // re-read §6 against the disk — and the commit whose purpose was to correct the
  // prose left this sentence standing three lines under its replacement. Two
  // paragraphs describing one mechanism is how that happens, so there is now one.
  lines.push('A position stated here was true at the timestamp below and nowhere else. `--write` refuses');
  lines.push(`to run at all when the base ref cannot be resolved: it would otherwise persist a document whose`);
  lines.push('base, merge-base and commits-ahead all read UNMEASURED, which is not a position to resume from.');
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
  lines.push('Two files are deliberately **absent** from this table. This checkpoint itself, because a');
  lines.push('file cannot carry its own digest — including itself made every write invalidate the digest');
  lines.push('it had just recorded; its integrity is recorded in the manifest instead. And');
  lines.push('`P15-HANDOFF-MANIFEST.md`, because its digest table is');
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
  console.log('  It awards nothing and signs nothing. A bare `checkpoint:phase15` re-checks it.');
  return 0;
}

process.exitCode = main();
