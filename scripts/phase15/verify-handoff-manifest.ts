#!/usr/bin/env tsx
/**
 * ─────────────────────────────────────────────────────────────────────────
 * P15 HANDOFF MANIFEST VERIFIER
 * ─────────────────────────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS — a failure of mine, mechanised so it cannot recur quietly
 *
 * PART 13 of DIRECTIVE #11 makes the handoff manifest a required gate and
 * requires a SHA256 for every off-Git artifact. I wrote that manifest, computed
 * the digests, and then kept editing three of the documents it describes. The
 * digests were therefore stale the moment the next edit landed, and nothing
 * said so: a reader would have taken a stale digest as a verified one.
 *
 * The bundle-integrity audit caught it from the outside, which is the part that
 * matters — my own evidence index was wrong and only an external check noticed.
 * The repository's own rule already covered this and I broke it:
 * **generated artifacts LAST.** A digest is a generated artifact.
 *
 * Recomputing the digests fixes this instance and nothing else. This script is
 * the part that generalises: the manifest becomes self-verifying, so the same
 * ordering mistake fails loudly on the next run instead of shipping.
 *
 * ── BOTH DIRECTIONS, because a one-sided check is half a ratchet ──────────
 *
 *   1. every digest in the manifest matches the file it names  (no stale digest)
 *   2. every artifact in the directory appears in the manifest (no silent gap)
 *
 * (1) alone would pass a manifest that simply omits the document somebody
 * forgot to hash — which is the failure PART 13 exists to prevent in the first
 * place. (2) alone would pass a complete list of wrong numbers.
 *
 * It also refuses to pass on an empty digest table: a verifier that parsed
 * nothing and reported success is the vacuous green PART 17 forbids.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────
 *
 *   npx tsx scripts/phase15/verify-handoff-manifest.ts
 *   npx tsx scripts/phase15/verify-handoff-manifest.ts --rewrite
 *
 * `--rewrite` recomputes the table in place, and is the ONLY sanctioned way to
 * update it: run it as the last action before a handoff, after every document
 * edit, never before. Without it the script is read-only and exits non-zero on
 * any mismatch or omission.
 */

import { protectFailingExitCode } from '../../tests/helpers/exit-code';

protectFailingExitCode();

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

const ARGV = process.argv.slice(2);
const REWRITE = ARGV.includes('--rewrite');
const DIR = ARGV.find((a) => a.startsWith('--dir='))?.slice('--dir='.length) ?? '/mnt/project-files/phase15';
const MANIFEST = 'P15-HANDOFF-MANIFEST.md';

/** The manifest cannot carry its own digest: writing it changes it. */
const SELF = MANIFEST;

const ROW = /^\| `(P15-[A-Za-z0-9_.-]+\.(?:md|json))` \| ([\d,]+) \| `([0-9a-f]{64})` \|$/gm;

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function artifactsOnDisk(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => /^P15-.*\.(md|json)$/.test(f) && f !== SELF)
    .sort();
}

/**
 * DIRECTION 3: is the manifest's own status header CURRENT?
 *
 * The independent challenger found this file asserting an exact SHA ten commits
 * behind the branch, and four counts in its Arabic summary — the section the
 * owner actually reads — that disagreed with both the branch and with §4 of the
 * same document. This gate did not catch any of it, because it proved digests
 * and digests only: a file can carry a perfectly consistent digest table and a
 * header describing a different commit.
 *
 * Phase 4 recorded this class as `TL-P4-COORD-R63`: a status header sitting
 * outside the laws the file enforces. The fix is for the file's own gate to
 * enforce them, so the numbers cannot rot silently between rounds.
 *
 * Every figure here is MEASURED from git — commits ahead of the base, files
 * added, and `package.json` script keys compared as KEY SETS against the base
 * rather than as diff lines, because counting diff lines is precisely how this
 * pack produced a wrong script count once already.
 */
interface Currency {
  readonly headSha: string;
  readonly commits: number;
  readonly newFiles: number;
  readonly scriptsAdded: number;
  readonly problems: readonly string[];
}

/**
 * Every git read this gate makes, with replace objects DISABLED.
 *
 * The coordinator's ruling of 2026-10-13: a `refs/replace` entry has now
 * broken both P8's and P13's anchors silently, because git substitutes the
 * replacement object everywhere — `git show`, `git diff`, `git cat-file` — with
 * no notice in the output. A gate that measures a figure through a replaced
 * object measures whatever the replacement says, so the flag goes on the
 * command AND in the environment (a `git` wrapper or an alias could otherwise
 * strip the flag), and `core.quotePath=false` keeps non-ASCII paths from
 * dropping out of a path list unnoticed.
 */
function gitRead(root: string, args: readonly string[], maxBuffer = 64 * 1024 * 1024): SpawnSyncReturns<string> {
  return spawnSync('git', ['--no-replace-objects', '-c', 'core.quotePath=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
  });
}

function arabicToWestern(t: string): string {
  return t.replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

function checkCurrency(manifest: string, root: string, dir: string): Currency {
  const git = (args: readonly string[]): string => {
    const r = gitRead(root, args);
    return r.status === 0 ? (r.stdout ?? '').trim() : '';
  };
  const headSha = git(['rev-parse', 'HEAD']);
  const base = 'origin/main';
  const commits = Number(git(['rev-list', '--count', `${base}..HEAD`]) || '0');
  const newFiles = git(['diff', '--diff-filter=A', '--name-only', `${base}...HEAD`])
    .split('\n')
    .filter((l) => l.trim().length > 0).length;

  let scriptsAdded = 0;
  try {
    const cur = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    const baseJson = JSON.parse(git(['show', `${base}:package.json`]) || '{}') as { scripts?: Record<string, string> };
    const b = baseJson.scripts ?? {};
    scriptsAdded = Object.keys(cur.scripts ?? {}).filter((k) => !(k in b)).length;
  } catch {
    scriptsAdded = -1;
  }

  const problems: string[] = [];
  if (headSha.length === 0) {
    problems.push('HEAD could not be read, so currency is UNMEASURED — which is not the same as current');
    return { headSha, commits, newFiles, scriptsAdded, problems };
  }

  // The header must name THIS head. A manifest is an index of a commit; an
  // index naming another commit indexes something the reader does not have.
  if (!manifest.includes(headSha)) {
    const stated = /\*\*Exact prep SHA\*\* \| \*\*`([0-9a-f]{7,40})`\*\*/.exec(manifest);
    problems.push(
      `the header's exact SHA is ${stated?.[1] === undefined ? 'absent' : `\`${stated[1]}\``}, but HEAD is \`${headSha}\`. A handoff must be rewritten at the head it describes.`,
    );
  }

  // The Arabic summary's counts, read with Arabic-Indic digits normalised.
  const summary = arabicToWestern(manifest);
  const claim = (re: RegExp): number | null => {
    const m = re.exec(summary);
    return m?.[1] === undefined ? null : Number(m[1]);
  };
  // The DOCUMENT count joins the three — the coordinator's round-7 B4. The
  // header said every count in §1 was checked here; three of four were, and
  // the unchecked one was the one that was wrong (20 against 21). A header
  // that overstates its own gate is the same defect as a count that is stale,
  // one level up: so the count is measured here rather than narrowed away.
  const docs = artifactsOnDisk(dir);
  const pairs: readonly { readonly what: string; readonly claimed: number | null; readonly measured: number }[] = [
    { what: 'commits on this branch', claimed: claim(/\*\*(\d+) إيداع/), measured: commits },
    { what: 'new phase-owned code files', claimed: claim(/\*\*(\d+) ملف[ًا]* برمجي/), measured: newFiles },
    { what: 'package.json script entries added', claimed: claim(/\*\*(\d+) سكربت/), measured: scriptsAdded },
    { what: 'documents in the off-Git pack, this manifest excluded', claimed: claim(/\*\*(\d+) وثيقة/), measured: docs.length },
  ];
  for (const x of pairs) {
    if (x.claimed === null) {
      problems.push(`the Arabic summary states no number for ${x.what}; measured ${x.measured}. An unstated count cannot be checked, so state it.`);
    } else if (x.claimed !== x.measured) {
      problems.push(`the Arabic summary says ${x.claimed} for ${x.what}; measured ${x.measured}. The owner reads that section.`);
    }
  }
  return { headSha, commits, newFiles, scriptsAdded, problems };
}

/**
 * DIRECTION 4: does the manifest's PROSE agree with the challenge reports on disk?
 *
 * The coordinator's F-14 was not a stale digest and not a stale count. It was a
 * SENTENCE: §8 said «Independent Challenger: NOT RUN on any Phase 15 artifact»
 * while six challenge reports sat in this very directory, each one listed in the
 * digest table the gate had just verified byte for byte. The gate checked the
 * index and never read the claim the index contradicted.
 *
 * So this direction reads the reports themselves — `P15-CHALLENGE-<sha>.md` — and
 * checks the file against them in BOTH directions, because a one-sided check is
 * half a ratchet here too:
 *
 *   · a report on disk whose SHA the manifest never names — a round that happened
 *     and went unrecorded, which is how «NOT RUN» survived six rounds;
 *   · a round named in the manifest with no report behind it — the ABSENCE case,
 *     which matters more: a claimed review nobody can read is worse than an
 *     unclaimed one, and a check that only catches drift passes happily when the
 *     evidence is simply gone (the round-4 lesson);
 *   · and the phrase itself: any sentence still asserting the challenger has not
 *     run, while a report exists, is a contradiction the gate names.
 *
 * What it does NOT decide: whether a round PASSED. The verdict in a challenger's
 * report is the challenger's to state and this author's to quote, never to grade.
 */
interface Challenge {
  readonly problems: readonly string[];
  readonly onDisk: readonly string[];
  readonly named: readonly string[];
}

function checkChallenges(manifest: string, dir: string): Challenge {
  const problems: string[] = [];
  const onDisk = artifactsOnDisk(dir)
    .map((f) => /^P15-CHALLENGE-([0-9a-f]{7,40})\.md$/.exec(f)?.[1])
    .filter((x): x is string => x !== undefined)
    .sort();
  // NAMED MEANS NAMED IN THE NARRATIVE — the coordinator's round-7 B2.
  //
  // This used to read the WHOLE file, digest table included. The digest table
  // is written by this gate's own `--rewrite`, which adds every P15-* file in
  // the directory: so the sanctioned regeneration made an unrecorded round
  // count as "named", and a copy holding the round-7 report verified clean
  // while §8 still read "RUN six times". The index proved the file's existence,
  // which is the one thing never in doubt.
  //
  // A digest row is a table row carrying a 64-hex digest. Nothing else in this
  // document has that shape, and the narrative rows of §8 — which carry report
  // filenames and no digest — are kept.
  const narrative = manifest
    .split('\n')
    .filter((l) => !(l.trim().startsWith('|') && /\b[0-9a-f]{64}\b/.test(l)))
    .join('\n');
  // NAMED MEANS NAMED IN §8's REPORTS ROW — the coordinator's round-8 N4.
  //
  // «Named anywhere in the narrative» was still too wide, and the review
  // measured the cost in a pack copy: one appended sentence — "Pending, not yet
  // read by this author: P15-CHALLENGE-211b0b7.md" — made the gate print
  // "8 challenge round(s) recorded" while §8 went on saying "RUN seven times",
  // listed seven reports, and gave the signature as covering an older head. A
  // round is recorded where a reader looks for the list of rounds, which is
  // §8's Reports row; a mention in a sentence about what has NOT been read is
  // the opposite of a record.
  const reportsRow = narrative.split('\n').filter((l) => /^\|\s*\*\*Reports/.test(l.trim()));
  if (reportsRow.length === 0)
    problems.push(
      '§8 carries no «Reports» row, so this file lists the challenge rounds nowhere a reader would look for them; the gate reads that row and nothing else',
    );
  const named = [...reportsRow.join('\n').matchAll(/P15-CHALLENGE-([0-9a-fA-F]{7,40})\.md/g)].map((m) => (m[1] ?? '').toLowerCase());
  // A report named with something that is not a SHA cannot be matched against
  // the disk at all, so it is a failure rather than a silent non-match: it
  // would otherwise read as "this round is recorded".
  for (const m of narrative.matchAll(/P15-CHALLENGE-([0-9A-Za-z._-]+)\.md/g)) {
    const token = m[1] ?? '';
    if (!/^[0-9a-fA-F]{7,40}$/.test(token))
      problems.push(
        `this file names P15-CHALLENGE-${token}.md, whose name is not a commit SHA — a report nobody can match to a head is not a record of a round`,
      );
  }
  // Two things are removed before the phrase test, and for different reasons.
  // The digest-table filenames are an index, not a claim about rounds. And text
  // inside guillemets is a QUOTATION: this file records the sentence «NOT RUN on
  // any Phase 15 artifact» as the claim that was wrong, and a check that cannot
  // tell a correction from a repetition fails the document for admitting its own
  // error — the same trap a red proof in this pack fell into when its refusal
  // pattern matched the fix's own disclaimer. A quotation is still visible to the
  // reader; it is simply not an assertion.
  const body = narrative.replace(/P15-CHALLENGE-[0-9a-fA-F]{7,40}\.md/g, '').replace(/\u00ab[^\u00bb]*\u00bb/g, '');

  for (const sha of onDisk)
    if (!named.includes(sha))
      problems.push(
        `a challenge report for ${sha} is on disk and §8's Reports row does not list it — a round that happened and went unrecorded is how "NOT RUN" survived six of them, and a mention elsewhere in the prose is not the list`,
      );
  // A name in the prose that is NOT in the Reports row: the round is either
  // recorded in the list or it is not recorded.
  const inProse = [...narrative.matchAll(/P15-CHALLENGE-([0-9a-fA-F]{7,40})\.md/g)].map((m) => (m[1] ?? '').toLowerCase());
  for (const sha of new Set(inProse))
    if (!named.includes(sha))
      problems.push(
        `P15-CHALLENGE-${sha}.md is named in the prose but not in §8's Reports row, so the round is mentioned and not recorded — which is exactly how a pack can name a round only in a sentence about what nobody has read yet`,
      );
  for (const sha of new Set(named))
    if (!onDisk.includes(sha))
      problems.push(
        `this file names P15-CHALLENGE-${sha}.md and no such report is on disk — a claimed review nobody can read is worse than an unclaimed one, so this is a FAIL and not a note`,
      );
  if (onDisk.length > 0)
    for (const phrase of ['Independent Challenger\u2060? *\\| *\\*\\*NOT RUN', 'NOT RUN on any Phase 15 artifact', 'No second party has inspected'])
      if (new RegExp(phrase).test(body))
        problems.push(
          `${onDisk.length} challenge report(s) are on disk, yet this file still asserts the challenger has not run ("${phrase.replace(/\\\\/g, '')}")`,
        );
  return { problems, onDisk, named: [...new Set(named)].sort() };
}

/**
 * DIRECTION 5: does the table of REPO FILES agree with git at the SHA this
 * file declares?
 *
 * The challenger's round-8 B4-1 and B4-2. §3 claimed 312 lines for
 * `secret-scan-proof.ts`, which is its length at `955ee11`; at the SHA the
 * header declares as exact it is 319, because the newest commit touched that
 * one file. Twenty-four of the twenty-five rows reproduced — and that is the
 * point rather than the consolation: **the row that was wrong is the row the
 * last commit touched**, which is what a carried-forward figure always does.
 *
 * The digest table covers the 23 documents beside this file. NOTHING covered
 * the 25 rows of claims about files in the repository, so the only thing
 * standing between that table and a false figure was care — and B4-1 is what
 * care costs on a busy day.
 *
 * Two things matter about HOW this is checked.
 *   - It is measured against **git at the declared SHA**, not against the
 *     working tree, because the sentence under the table says the counts are
 *     `wc -l` at that commit. A row that matches the working tree and not the
 *     commit is still false as written.
 *   - It is NOT checked against anything this gate writes. Direction 4 was
 *     fooled exactly that way: it counted a report as recorded because its own
 *     `--rewrite` had digested it. The authority here is git; `--rewrite` may
 *     write the column FROM git, and this direction then agrees with it
 *     because both read the same authority, not because one read the other.
 */
interface FileTable {
  readonly problems: readonly string[];
  readonly rows: number;
  readonly sha: string | null;
}

const FILE_ROW = /^\| `((?:scripts|tests|apps|packages|infrastructure)\/[^`]+)` \| (\d+) \|/gm;

function linesAt(root: string, sha: string, path: string): number | null {
  const r = gitRead(root, ['show', `${sha}:${path}`], 256 * 1024 * 1024);
  if (r.error !== undefined || r.status !== 0) return null;
  const text = r.stdout ?? '';
  // `wc -l` counts newlines, which is what the sentence under the table says.
  let n = 0;
  for (const ch of text) if (ch === '\n') n += 1;
  return n;
}

function checkFileTable(manifest: string, root: string): FileTable {
  const problems: string[] = [];
  const sha = /\*\*Exact prep SHA\*\* \| \*\*`([0-9a-f]{7,40})`\*\*/.exec(manifest)?.[1] ?? null;
  const rows = [...manifest.matchAll(FILE_ROW)].map((m) => ({ path: m[1] as string, lines: Number(m[2]) }));
  if (sha === null) {
    problems.push('the header declares no exact SHA, so the line counts in §3 cannot be measured against anything — an unanchored figure is not a measurement');
    return { problems, rows: rows.length, sha };
  }
  const known = gitRead(root, ['cat-file', '-t', `${sha}^{commit}`]);
  if (known.error !== undefined || known.status !== 0 || (known.stdout ?? '').trim() !== 'commit') {
    problems.push(
      `the declared SHA ${sha} is not a commit this clone can read, so every figure attributed to it is UNMEASURED. If it was written before the push, push first and re-run: a manifest naming a commit nobody can fetch indexes nothing (the challenger's round-8 P3)`,
    );
    return { problems, rows: rows.length, sha };
  }
  if (rows.length === 0) {
    problems.push('no repo-file rows were parsed from §3, so this direction measured nothing — which is a failure and not a pass (PART 17)');
    return { problems, rows: rows.length, sha };
  }
  for (const row of rows) {
    const measured = linesAt(root, sha, row.path);
    if (measured === null) {
      problems.push(
        `§3 lists \`${row.path}\`, which does not exist at the declared SHA ${sha.slice(0, 7)} — a table of what the branch carries must not name a file the commit does not have`,
      );
      continue;
    }
    if (measured !== row.lines)
      problems.push(
        `§3 says ${row.lines} lines for \`${row.path}\`; \`git show ${sha.slice(0, 7)}:${row.path} | wc -l\` is ${measured}. A count carried forward from an earlier commit is the one defect this direction exists for`,
      );
  }
  // And the other direction: a phase-owned file the branch added with no row.
  const added = gitRead(root, ['diff', '--diff-filter=A', '--name-only', `origin/main...${sha}`]);
  if (added.error === undefined && added.status === 0) {
    const listed = new Set(rows.map((r) => r.path));
    for (const f of (added.stdout ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0))
      if (!listed.has(f))
        problems.push(`the branch adds \`${f}\` at the declared SHA and §3 has no row for it — a file nobody indexes is how PART 108 recovery fails`);
  } else {
    problems.push(
      `the added-file list could not be read (git exited ${String(added.status)}), so "every added file has a row" is UNMEASURED rather than established`,
    );
  }
  // ── AND EVERY FILE THE BRANCH MODIFIES, with the figure its row names ──
  //
  // The challenger's round-9 F-R9-01, which is round 8's B4-1 living inside the
  // mechanism built to stop it. Direction 5 covered the files the branch ADDS,
  // and the one repo file this branch MODIFIES — `scripts/phase3-secret-scan.ts`,
  // Phase 3-owned and run by CI — had no §3 row at all. Its only figure was in
  // §6.1: «+47 / −1 against origin/main, in commit 1da1037». True at `1da1037`
  // and at `211b0b7`; at the head the file declares as exact it is **+213 / −1**,
  // because `a0cb069` added 166 lines to it. The challenger proved the blind spot
  // rather than arguing it: replacing the figure with +9999 / −8888 in a copy of
  // the pack still printed VERIFIED, exit 0.
  //
  // So a modified file's figure is now measured with the command its row names,
  // and a modified file with no figure row at all is a failure — the row exists
  // only because that edit went unrecorded for eight rounds.
  // Deleted and renamed repo files are part of the same inventory: the
  // coordinator's ruling on round 9 asks for `--name-status`, so a file the
  // branch removes or moves cannot leave the record silently either.
  const names = gitRead(root, ['diff', '--name-status', `origin/main...${sha}`]);
  if (names.error !== undefined || names.status !== 0)
    problems.push(`the branch's file inventory could not be read (git exited ${String(names.status)}), so what it touches is UNMEASURED`);
  else
    for (const line of (names.stdout ?? '').split('\n')) {
      const parts = line.split('\t').filter((x) => x.length > 0);
      const status = (parts[0] ?? '').trim();
      if (status.length === 0) continue;
      if (!/^[DR]/.test(status)) continue;
      for (const path of parts.slice(1)) {
        if (manifest.includes(`\`${path}\``)) continue;
        problems.push(
          status.startsWith('D')
            ? `the branch DELETES \`${path}\` and this file never names it — a removal nobody indexes is the PART 108 recovery case in reverse`
            : `the branch RENAMES \`${path}\` and this file never names it, so a reader following the record looks for it where it no longer is`,
        );
      }
    }
  const mods = gitRead(root, ['diff', '--diff-filter=M', '--name-only', `origin/main...${sha}`]);
  if (mods.error !== undefined || mods.status !== 0)
    problems.push(
      `the modified-file list could not be read (git exited ${String(mods.status)}), so the figures this file states about the repo files the branch CHANGES are UNMEASURED rather than established`,
    );
  else
    for (const f of (mods.stdout ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)) {
      // `package.json` is counted by direction 3 as script keys, not as a diff
      // size, and §1/§6.1 state it that way.
      if (f === 'package.json') continue;
      const esc = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const row = new RegExp(`\`${esc}\`[^|\n]*?\\*\\*\\+(\\d+) ?/ ?[-\u2212](\\d+)\\*\\*`).exec(manifest);
      if (row === null) {
        problems.push(
          `the branch MODIFIES \`${f}\` and no row in this file states its size as **+N / −M** — the one repo file this phase does not own is the row an owner reads first, and a shared-file edit with no figure is how it went unrecorded for eight rounds`,
        );
        continue;
      }
      const stat = gitRead(root, ['diff', '--numstat', `origin/main..${sha}`, '--', `:(top)${f}`]);
      if (stat.error !== undefined || stat.status !== 0) {
        problems.push(`\`git diff --numstat origin/main..${sha.slice(0, 7)} -- ${f}\` exited ${String(stat.status)}, so that row's figure is UNMEASURED`);
        continue;
      }
      const m = /^(\d+)\s+(\d+)\s/.exec((stat.stdout ?? '').trim());
      if (m === null) {
        problems.push(`\`git diff --numstat\` printed nothing parsable for \`${f}\`, so the row's figure is UNMEASURED and not confirmed`);
        continue;
      }
      const added2 = Number(m[1]);
      const removed = Number(m[2]);
      if (added2 !== Number(row[1]) || removed !== Number(row[2]))
        problems.push(
          `this file says \`${f}\` is **+${row[1] ?? '?'} / −${row[2] ?? '?'}** against origin/main; \`git diff --numstat origin/main..${sha.slice(0, 7)} -- ${f}\` is **+${String(added2)} / −${String(removed)}**. A figure that was true at an earlier commit is the defect direction 5 exists for, and it is worse in the row an owner reads first`,
        );
    }
  return { problems, rows: rows.length, sha };
}

function main(): void {
  console.log('P15 HANDOFF MANIFEST VERIFIER — PART 13');
  console.log(`  directory ${DIR}`);

  const manifestPath = join(DIR, MANIFEST);
  if (!existsSync(manifestPath)) {
    console.error(
      `\nFAIL — the manifest itself is missing at ${manifestPath}. PART 13 makes it a required gate, so its absence is a gate failure, not a nil result.`,
    );
    process.exitCode = 1;
    return;
  }

  const manifest = readFileSync(manifestPath, 'utf8');
  const rows = [...manifest.matchAll(ROW)].map((m) => ({ name: m[1] as string, bytes: Number((m[2] as string).replace(/,/g, '')), digest: m[3] as string }));

  // ── non-vacuity: a verifier that parsed nothing has measured nothing ────
  if (rows.length === 0) {
    console.error(
      '\nUNMEASURED — no digest rows were parsed from the manifest. A verifier with an empty subject set proves nothing, so this is a failure and not a pass (PART 17).',
    );
    process.exitCode = 1;
    return;
  }

  const onDisk = artifactsOnDisk(DIR);
  console.log(`  subjects  ${rows.length} digest row(s) in the manifest, ${onDisk.length} artifact(s) on disk\n`);

  // ── direction 1: no stale or wrong digest ──────────────────────────────
  const stale: { name: string; was: string; now: string; wasBytes: number; nowBytes: number }[] = [];
  const missing: string[] = [];
  for (const row of rows) {
    const p = join(DIR, row.name);
    if (!existsSync(p)) {
      missing.push(row.name);
      console.log(`  MISSING  ${row.name} — named in the manifest, absent from disk`);
      continue;
    }
    const now = sha256(p);
    const nowBytes = statSync(p).size;
    if (now === row.digest) {
      console.log(`  OK       ${row.name}`);
    } else {
      stale.push({ name: row.name, was: row.digest, now, wasBytes: row.bytes, nowBytes });
      console.log(`  STALE    ${row.name}`);
      console.log(`           manifest ${row.digest} (${row.bytes} bytes)`);
      console.log(`           actual   ${now} (${nowBytes} bytes, ${nowBytes - row.bytes >= 0 ? '+' : ''}${nowBytes - row.bytes})`);
    }
  }

  // ── direction 2: no artifact omitted from the manifest ─────────────────
  const listed = new Set(rows.map((r) => r.name));
  const unlisted = onDisk.filter((f) => !listed.has(f));
  for (const f of unlisted) console.log(`  UNLISTED ${f} — present on disk, absent from the manifest`);

  if (REWRITE) {
    const table = onDisk.map((f) => `| \`${f}\` | ${statSync(join(DIR, f)).size.toLocaleString('en-US')} | \`${sha256(join(DIR, f))}\` |`).join('\n');
    const first = rows[0];
    if (first === undefined) {
      console.error('\nFAIL — cannot rewrite a table that was not parsed.');
      process.exitCode = 1;
      return;
    }
    const firstRow = new RegExp(`^\\| \`${first.name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\` \\|.*$`, 'm');
    const start = manifest.search(firstRow);
    if (start < 0) {
      console.error('\nFAIL — could not locate the digest table to rewrite.');
      process.exitCode = 1;
      return;
    }
    const lines = manifest.slice(start).split('\n');
    let end = 0;
    while (end < lines.length && /^\| `P15-/.test(lines[end] ?? '')) end++;
    let rewritten = `${manifest.slice(0, start)}${table}\n${lines.slice(end).join('\n')}`;

    // THE REPO-FILE TABLE IS REWRITTEN FROM GIT TOO — the challenger's
    // round-8 B4-2. Every Lines cell in §3 is re-read with `git show
    // <declared SHA>:<path>`, so a figure cannot be carried forward past the
    // commit that changed the file. The counts are taken from git and not
    // from the working tree, because the sentence under the table says that is
    // what they are; and direction 5 re-measures them from the same authority
    // afterwards, which is agreement rather than circularity: the claim is
    // checked against git, never against what this branch of the code wrote.
    const declared = /\*\*Exact prep SHA\*\* \| \*\*`([0-9a-f]{7,40})`\*\*/.exec(rewritten)?.[1] ?? null;
    let repoRows = 0;
    let repoUnreadable = 0;
    if (declared !== null) {
      rewritten = rewritten.replace(/^\| `((?:scripts|tests|apps|packages|infrastructure)\/[^`]+)` \| (\d+) \|/gm, (whole, path: string, was: string) => {
        const measured = linesAt(resolve(__dirname, '../..'), declared, path);
        if (measured === null) {
          repoUnreadable += 1;
          return whole; // left as written, and direction 5 then names it
        }
        repoRows += 1;
        if (String(measured) !== was) console.log(`  RECOUNTED ${path}: ${was} → ${measured} lines at ${declared.slice(0, 7)}`);
        return `| \`${path}\` | ${measured} |`;
      });
    }
    writeFileSync(manifestPath, rewritten);
    console.log(`\nREWROTE the digest table: ${onDisk.length} artifact(s).`);
    console.log(
      declared === null
        ? '  §3 was NOT recounted: the header declares no exact SHA, so there is nothing to measure the line counts against.'
        : `  §3 recounted from git at ${declared.slice(0, 7)}: ${repoRows} row(s)${repoUnreadable > 0 ? `, ${repoUnreadable} left as written because the path is absent at that commit — direction 5 names them` : ''}.`,
    );
    console.log(
      '  This is the LAST action before a handoff, never an earlier one: a digest computed before the next edit is stale the moment that edit lands.',
    );
    console.log('\nPHASE 15 HANDOFF MANIFEST: REWRITTEN');
    return;
  }

  // ── direction 3: is the header current? ────────────────────────────────
  const cur = checkCurrency(manifest, resolve(__dirname, '../..'), DIR);
  console.log('');
  console.log('DIRECTION 3 — IS THE HEADER CURRENT? (measured from git, not read from the file)');
  console.log(`  HEAD ${cur.headSha}`);
  console.log(
    `  measured: ${cur.commits} commit(s) ahead of origin/main, ${cur.newFiles} file(s) added, ${cur.scriptsAdded === -1 ? 'package.json unreadable' : `${cur.scriptsAdded} package.json script key(s) added`}`,
  );
  if (cur.problems.length === 0) {
    console.log('  the header SHA and every stated count match this branch.');
  } else {
    for (const pr of cur.problems) console.log(`  STALE ${pr}`);
  }

  // ── direction 4: does the prose agree with the challenge reports? ──────
  const ch = checkChallenges(manifest, DIR);
  console.log('');
  console.log('DIRECTION 4 — DOES THE PROSE AGREE WITH THE CHALLENGE REPORTS ON DISK?');
  console.log(`  ${ch.onDisk.length} report(s) on disk: ${ch.onDisk.join(', ') || 'none'}`);
  console.log(`  ${ch.named.length} SHA(s) named in this file: ${ch.named.join(', ') || 'none'}`);
  if (ch.problems.length === 0) console.log('  every round on disk is named here, and every round named here has a report behind it.');
  else for (const pr of ch.problems) console.log(`  CONTRADICTED ${pr}`);

  // ── direction 5: does the repo-file table agree with git at the SHA? ───
  const ft = checkFileTable(manifest, resolve(__dirname, '../..'));
  console.log('');
  console.log('DIRECTION 5 — DOES §3 AGREE WITH GIT AT THE SHA THIS FILE DECLARES?');
  console.log(`  ${ft.rows} repo-file row(s) measured against ${ft.sha === null ? 'no declared SHA' : ft.sha.slice(0, 12)}`);
  if (ft.problems.length === 0) console.log('  every row\u2019s line count is `wc -l` at that commit, and every file the branch adds has a row.');
  else for (const pr of ft.problems) console.log(`  WRONG ${pr}`);

  const problems = stale.length + missing.length + unlisted.length + cur.problems.length + ch.problems.length + ft.problems.length;
  console.log('');
  if (problems === 0) {
    console.log(
      `PHASE 15 HANDOFF MANIFEST: VERIFIED — ${rows.length} digest(s) match, ${onDisk.length} artifact(s) all listed, none missing, header current at ${cur.headSha.slice(0, 12)}, ${ch.onDisk.length} challenge round(s) recorded, ${ft.rows} repo-file row(s) re-measured from git`,
    );
    return;
  }
  console.error(
    `PHASE 15 HANDOFF MANIFEST: FAIL — ${stale.length} stale digest(s), ${missing.length} missing file(s), ${unlisted.length} unlisted artifact(s), ${cur.problems.length} stale header claim(s), ${ch.problems.length} contradicted challenge claim(s), ${ft.problems.length} wrong repo-file row(s).`,
  );
  console.error('  A stale digest is not a cosmetic defect: it is an evidence index asserting a byte state that is not the one on disk.');
  console.error(
    '  Fix the DOCUMENTS first if a change was unintended, then re-run with --rewrite as the last action. Do not swap digests to make a diff disappear.',
  );
  process.exitCode = 1;
}

main();
