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
import { spawnSync } from 'node:child_process';

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

function arabicToWestern(t: string): string {
  return t.replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

function checkCurrency(manifest: string, root: string): Currency {
  const git = (args: readonly string[]): string => {
    const r = spawnSync('git', [...args], { cwd: root, encoding: 'utf8' });
    return r.status === 0 ? (r.stdout ?? '').trim() : '';
  };
  const headSha = git(['rev-parse', 'HEAD']);
  const base = 'origin/main';
  const commits = Number(git(['rev-list', '--count', `${base}..HEAD`]) || '0');
  const newFiles = git(['diff', '--diff-filter=A', '--name-only', `${base}...HEAD`]).split('\n').filter((l) => l.trim().length > 0).length;

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
  const pairs: readonly { readonly what: string; readonly claimed: number | null; readonly measured: number }[] = [
    { what: 'commits on this branch', claimed: claim(/\*\*(\d+) إيداع/), measured: commits },
    { what: 'new phase-owned code files', claimed: claim(/\*\*(\d+) ملف[ًا]* برمجي/), measured: newFiles },
    { what: 'package.json script entries added', claimed: claim(/\*\*(\d+) سكربت/), measured: scriptsAdded },
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
  const named = [...manifest.matchAll(/P15-CHALLENGE-([0-9a-f]{7,40})\.md/g)].map((m) => m[1] ?? '');
  // Two things are removed before the phrase test, and for different reasons.
  // The digest-table filenames are an index, not a claim about rounds. And text
  // inside guillemets is a QUOTATION: this file records the sentence «NOT RUN on
  // any Phase 15 artifact» as the claim that was wrong, and a check that cannot
  // tell a correction from a repetition fails the document for admitting its own
  // error — the same trap a red proof in this pack fell into when its refusal
  // pattern matched the fix's own disclaimer. A quotation is still visible to the
  // reader; it is simply not an assertion.
  const body = manifest.replace(/P15-CHALLENGE-[0-9a-f]{7,40}\.md/g, '').replace(/\u00ab[^\u00bb]*\u00bb/g, '');

  for (const sha of onDisk)
    if (!named.includes(sha))
      problems.push(
        `a challenge report for ${sha} is on disk and this file never names it — a round that happened and went unrecorded is how "NOT RUN" survived six of them`,
      );
  for (const sha of new Set(named))
    if (!onDisk.includes(sha))
      problems.push(
        `this file names P15-CHALLENGE-${sha}.md and no such report is on disk — a claimed review nobody can read is worse than an unclaimed one, so this is a FAIL and not a note`,
      );
  if (onDisk.length > 0)
    for (const phrase of ['Independent Challenger\u2060? *\\| *\\*\\*NOT RUN', 'NOT RUN on any Phase 15 artifact', 'No second party has inspected'])
      if (new RegExp(phrase).test(body))
        problems.push(`${onDisk.length} challenge report(s) are on disk, yet this file still asserts the challenger has not run ("${phrase.replace(/\\\\/g, '')}")`);
  return { problems, onDisk, named: [...new Set(named)].sort() };
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
    const rewritten = `${manifest.slice(0, start)}${table}\n${lines.slice(end).join('\n')}`;
    writeFileSync(manifestPath, rewritten);
    console.log(`\nREWROTE the digest table: ${onDisk.length} artifact(s).`);
    console.log(
      '  This is the LAST action before a handoff, never an earlier one: a digest computed before the next edit is stale the moment that edit lands.',
    );
    console.log('\nPHASE 15 HANDOFF MANIFEST: REWRITTEN');
    return;
  }

  // ── direction 3: is the header current? ────────────────────────────────
  const cur = checkCurrency(manifest, resolve(__dirname, '../..'));
  console.log('');
  console.log('DIRECTION 3 — IS THE HEADER CURRENT? (measured from git, not read from the file)');
  console.log(`  HEAD ${cur.headSha}`);
  console.log(`  measured: ${cur.commits} commit(s) ahead of origin/main, ${cur.newFiles} file(s) added, ${cur.scriptsAdded === -1 ? 'package.json unreadable' : `${cur.scriptsAdded} package.json script key(s) added`}`);
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

  const problems = stale.length + missing.length + unlisted.length + cur.problems.length + ch.problems.length;
  console.log('');
  if (problems === 0) {
    console.log(
      `PHASE 15 HANDOFF MANIFEST: VERIFIED — ${rows.length} digest(s) match, ${onDisk.length} artifact(s) all listed, none missing, header current at ${cur.headSha.slice(0, 12)}, ${ch.onDisk.length} challenge round(s) recorded`,
    );
    return;
  }
  console.error(
    `PHASE 15 HANDOFF MANIFEST: FAIL — ${stale.length} stale digest(s), ${missing.length} missing file(s), ${unlisted.length} unlisted artifact(s), ${cur.problems.length} stale header claim(s), ${ch.problems.length} contradicted challenge claim(s).`,
  );
  console.error('  A stale digest is not a cosmetic defect: it is an evidence index asserting a byte state that is not the one on disk.');
  console.error(
    '  Fix the DOCUMENTS first if a change was unintended, then re-run with --rewrite as the last action. Do not swap digests to make a diff disappear.',
  );
  process.exitCode = 1;
}

main();
