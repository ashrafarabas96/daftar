/**
 * PHASE 15 — RED PROOF: CAN DIRECTION 4 OF THE MANIFEST GATE GO RED?
 * (PREPARED / NOT PROMOTED)
 *
 * WHY
 *   The coordinator's F-14 was a false SENTENCE in the handoff manifest, not a
 *   stale digest: §8 claimed the independent challenger had never run while six
 *   of its reports sat in the same directory. The remedy was a fourth direction
 *   in `verify:handoff-manifest` that reads those reports and checks the prose
 *   against them. A direction that has never been shown to fail is not a gate,
 *   so this harness plants, one at a time, each way the prose and the reports can
 *   disagree — and the one way they can APPEAR to disagree while being correct.
 *
 *   Every plant is made in a throwaway COPY of the directory. The shared pack at
 *   /mnt/project-files/phase15 is read and never written: other sessions are
 *   working in it, and a proof that edits the subject it is proving over is not a
 *   proof.
 *
 * THE FOURTH PLANT IS THE POINT
 *   M4 plants the false sentence as a QUOTATION, inside guillemets, exactly as
 *   the corrected §8 records it. It must NOT redden. A check that cannot tell a
 *   correction from a repetition punishes a document for admitting its error, and
 *   authors then stop admitting them — so the exemption is proved in both
 *   directions, M3 against M4, rather than asserted in a comment.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, unlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const PACK = process.env.P15_PACK_DIR ?? '/mnt/project-files/phase15';
const MANIFEST = 'P15-HANDOFF-MANIFEST.md';
const FALSE_CLAIM = 'NOT RUN on any Phase 15 artifact';

/** Run the gate against a copy and return only its DIRECTION 4 block. */
function direction4(dir: string): { readonly text: string; readonly contradictions: number; readonly ran: boolean } {
  const r = spawnSync('npx', ['tsx', join(ROOT, 'scripts/phase15/verify-handoff-manifest.ts'), `--dir=${dir}`], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  // The gate exits 1 for any direction, so its CODE cannot tell us which one
  // spoke. But a gate that did not run at all must never read as "nothing
  // contradicted": that is the fail-open this whole round is about.
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  // The gate's own codes are 0 and 1. Any other code is the runner failing to
  // start it, which must not reach the marker test at all: `ran: false` is the
  // only honest answer, and it is the answer the exit code gives here.
  if (r.error !== undefined || (r.status !== 0 && r.status !== 1))
    return { text: `${out.slice(-500)}\n[harness] the gate did not run: exit ${String(r.status)}`, contradictions: 0, ran: false };
  if (!out.includes('DIRECTION 4')) return { text: out.slice(-600), contradictions: 0, ran: false };
  const block = out.slice(out.indexOf('DIRECTION 4'));
  return { text: block, contradictions: (block.match(/CONTRADICTED /g) ?? []).length, ran: true };
}

interface Plant {
  readonly id: string;
  readonly what: string;
  readonly plant: (dir: string) => void;
  /** null when the gate behaved as required. */
  readonly expect: (d: ReturnType<typeof direction4>) => string | null;
  /** Set for a §3 plant: this case is measured on DIRECTION 5 instead. */
  readonly viaDirection5?: (d: ReturnType<typeof direction5>) => string | null;
}

const reports = (dir: string): string[] =>
  readdirSync(dir)
    .filter((f) => /^P15-CHALLENGE-[0-9a-f]{7,40}\.md$/.test(f))
    .sort();

/**
 * Run the gate's own sanctioned regeneration against a copy. `--rewrite` adds
 * every P15-* file in the directory to the digest table, which is exactly what
 * made B2's fail-open invisible: M2 plants an unnamed report but never
 * regenerates, so it never reached the state a real handoff is left in.
 */
function rewrite(dir: string): void {
  const r = spawnSync('npx', ['tsx', join(ROOT, 'scripts/phase15/verify-handoff-manifest.ts'), `--dir=${dir}`, '--rewrite'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error !== undefined || (r.status !== 0 && r.status !== 1))
    throw new Error(`--rewrite did not run: exit ${String(r.status)}${r.error === undefined ? '' : ` (${String(r.error)})`}`);
}

/** The gate's DIRECTION 5 block, read the same way and with the same refusal. */
function direction5(dir: string): { readonly text: string; readonly wrong: number; readonly ran: boolean } {
  const r = spawnSync('npx', ['tsx', join(ROOT, 'scripts/phase15/verify-handoff-manifest.ts'), `--dir=${dir}`], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.error !== undefined || (r.status !== 0 && r.status !== 1))
    return { text: `${out.slice(-500)}\n[harness] the gate did not run: exit ${String(r.status)}`, wrong: 0, ran: false };
  if (!out.includes('DIRECTION 5')) return { text: out.slice(-600), wrong: 0, ran: false };
  const block = out.slice(out.indexOf('DIRECTION 5'));
  return { text: block, wrong: (block.match(/WRONG /g) ?? []).length, ran: true };
}

/** The round count the gate prints in its verdict line, or null. */
function count(dir: string): number | null {
  const r = spawnSync('npx', ['tsx', join(ROOT, 'scripts/phase15/verify-handoff-manifest.ts'), `--dir=${dir}`], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error !== undefined || (r.status !== 0 && r.status !== 1)) return null;
  // Direction 4's own line, not the verdict line: adding a document to the pack
  // moves §1's document count too, so the gate correctly FAILs on a stale header
  // and its verdict line then carries no round count at all. The count this
  // plant is about is the one direction 4 prints.
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const block = out.includes('DIRECTION 4') ? out.slice(out.indexOf('DIRECTION 4')) : '';
  const m = /(\d+) report\(s\) on disk/.exec(block);
  const named = /(\d+) SHA\(s\) named in this file/.exec(block);
  if (m === null || named === null) return null;
  // Both halves must move together: a twin on disk that the row does not name is
  // M13's case, and this one is about the recorded count.
  return Number(m[1]) === Number(named[1]) ? Number(m[1]) : null;
}

const PLANTS: readonly Plant[] = [
  {
    id: 'M1',
    what: 'a challenge report the manifest names is DELETED — the absence case',
    plant: (dir) => {
      const first = reports(dir)[0];
      if (first === undefined) throw new Error('no challenge report in the copy to delete');
      unlinkSync(join(dir, first));
    },
    expect: (d) =>
      !d.ran
        ? 'the gate did not run, and a gate that did not run is not a clean result'
        : d.contradictions > 0
          ? null
          : 'the manifest still claims a round whose report is gone, and direction 4 said nothing. A check that only catches drift passes when the evidence is simply absent',
  },
  {
    id: 'M2',
    what: 'a round happened and was never recorded — a report on disk the manifest does not name',
    plant: (dir) => {
      writeFileSync(join(dir, 'P15-CHALLENGE-0bada55.md'), '# planted round\nThis file exists only inside a throwaway copy.\n');
    },
    expect: (d) =>
      !d.ran
        ? 'the gate did not run, and a gate that did not run is not a clean result'
        : d.contradictions > 0
          ? null
          : 'a challenge report sat on disk unnamed by the manifest and the gate passed — which is exactly how "NOT RUN" survived six rounds',
  },
  {
    id: 'M3',
    what: 'the false sentence is re-ASSERTED in the prose',
    plant: (dir) => {
      const f = join(dir, MANIFEST);
      writeFileSync(join(dir, MANIFEST), `${readFileSync(f, 'utf8')}\n\nThe challenger is ${FALSE_CLAIM}.\n`);
    },
    expect: (d) =>
      !d.ran
        ? 'the gate did not run, and a gate that did not run is not a clean result'
        : d.contradictions > 0
          ? null
          : 'the manifest asserts the challenger never ran, six reports are on disk, and the gate agreed with the manifest',
  },
  {
    id: 'M4',
    what: 'the same sentence as a QUOTATION, as the correction records it — must NOT redden',
    plant: (dir) => {
      const f = join(dir, MANIFEST);
      writeFileSync(join(dir, MANIFEST), `${readFileSync(f, 'utf8')}\n\nThis file used to say «${FALSE_CLAIM}», and that was wrong.\n`);
    },
    expect: (d) =>
      !d.ran
        ? 'the gate did not run, and a gate that did not run is not a clean result'
        : d.contradictions === 0
          ? null
          : 'a correction QUOTING the claim it retracts was failed as if it were repeating it. Punish that and the next author stops recording the correction at all',
  },
  {
    id: 'M9',
    what: 'round-9 F-R9-01: a FORGED figure about the one repo file the branch MODIFIES — the shared file whose owner reads that figure first',
    plant: (dir) => {
      const f = join(dir, MANIFEST);
      const text = readFileSync(f, 'utf8');
      const forged = text.replace(/\*\*\+\d+ ?\/ ?[-\u2212]\d+\*\*/, '**+9999 / \u22128888**');
      if (forged === text) throw new Error('M9 could not plant: no **+N / −M** figure about a modified repo file is stated in this pack');
      writeFileSync(f, forged);
    },
    expect: () => null,
    viaDirection5: (d) =>
      !d.ran
        ? 'the gate did not run, and a gate that did not run is not a clean result'
        : d.wrong > 0
          ? null
          : 'a figure about the repo file this branch modifies was replaced with +9999 / −8888 and the gate still verified — which is the blind spot the challenger measured, not a hypothetical',
  },
  {
    id: 'M10',
    what: 'the GUARD-DELETION test for that arm: with the modified-file check removed, M9 must stop being caught',
    plant: (dir) => {
      // The guard is deleted in a COPY OF THE GATE, never in the repository:
      // the proof runs that copy against the same forged pack. A guard that
      // can be removed without the proof noticing is a guard that was never
      // doing the work (the P15 `:prove` lesson, applied to this direction).
      const f = join(dir, MANIFEST);
      const text = readFileSync(f, 'utf8');
      const forged = text.replace(/\*\*\+\d+ ?\/ ?[-\u2212]\d+\*\*/, '**+9999 / \u22128888**');
      if (forged === text) throw new Error('M10 could not plant: no **+N / −M** figure about a modified repo file is stated in this pack');
      writeFileSync(f, forged);
      // THE GUARD-DELETION HALF, measured inside this plant: a copy of the gate
      // with the modified-file arm cut out is run against this same forged pack,
      // and it must come back CLEAN. If it still catches the forgery, then
      // something else is doing the work and the arm is decoration — which is
      // the thing a red proof cannot tell you by going red.
      const gate = readFileSync(join(ROOT, 'scripts/phase15/verify-handoff-manifest.ts'), 'utf8');
      const marker = "const mods = gitRead(root, ['diff', '--diff-filter=M', '--name-only', `origin/main...${sha}`]);";
      if (!gate.includes(marker)) throw new Error('M10 could not plant: the modified-file arm no longer reads the branch diff in the shape this plant edits');
      const without = gate.replace(marker, "const mods = gitRead(root, ['diff', '--diff-filter=M', '--name-only', 'HEAD', '--', 'no-such-path']);");
      const stripped = join(dir, 'gate-without-the-modified-file-arm.ts');
      writeFileSync(stripped, without);
      const r = spawnSync('npx', ['tsx', stripped, `--dir=${dir}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      if (r.error !== undefined || (r.status !== 0 && r.status !== 1))
        throw new Error(`M10 could not plant: the stripped gate did not run (exit ${String(r.status)})`);
      const block = out.includes('DIRECTION 5') ? out.slice(out.indexOf('DIRECTION 5')) : '';
      const caughtAnyway = (block.match(/WRONG /g) ?? []).length > 0;
      if (caughtAnyway)
        throw new Error(
          'M10: with the modified-file arm removed, the gate STILL caught the forged figure — so that arm is not what catches it, and the proof below would attribute the red to the wrong guard',
        );
      // The stripped copy is left in the throwaway pack; the harness now runs
      // the REAL gate against the same forgery, which must go red.
    },
    expect: () => null,
    viaDirection5: (d) =>
      !d.ran
        ? 'the gate did not run, and a gate that did not run is not a clean result'
        : d.wrong > 0
          ? null
          : 'the forged figure went unnoticed, which is what M10 asserts about the copy with the arm removed — but this case runs the REAL gate, so it must still be caught here',
  },
  {
    id: 'M12',
    what: 'a SECOND report on a head that already has one, listed — it must count as its own round and not collapse into the first',
    plant: (dir) => {
      // Round 9B is a real instance: a second challenger session re-attacked
      // `071056e` and filed `P15-CHALLENGE-071056e-R9B.md`. A gate that keys
      // rounds on the SHA either refuses that name or counts two reviews as one,
      // and a set that collapses duplicates before the count is taken is how a
      // review goes missing. So this plant adds a tagged twin of a report that
      // is already recorded, lists it, and requires the round count to RISE.
      const f = join(dir, MANIFEST);
      const text = readFileSync(f, 'utf8');
      const first = reports(dir)[0];
      if (first === undefined) throw new Error('M12 could not plant: no challenge report in the copy to twin');
      const sha = /^P15-CHALLENGE-([0-9a-f]{7,40})/.exec(first)?.[1];
      if (sha === undefined) throw new Error('M12 could not plant: the report name carries no SHA to twin');
      const twin = `P15-CHALLENGE-${sha}-M12.md`;
      const before = count(dir);
      writeFileSync(join(dir, twin), '# a planted second review of the same head\nThis file exists only inside a throwaway copy.\n');
      const row = text.split('\n').find((l) => /^\|\s*\*\*Reports/.test(l.trim()));
      if (row === undefined) throw new Error('M12 could not plant: this pack has no «Reports» row to list the twin in');
      writeFileSync(f, text.replace(row, row.replace(`\`${first}\``, `\`${first}\`, \`${twin}\``)));
      rewrite(dir);
      const after = count(dir);
      if (before === null || after === null)
        throw new Error(`M12 could not plant: the gate printed no round count (before ${String(before)}, after ${String(after)})`);
      if (after !== before + 1)
        throw new Error(
          `M12: a second report on ${sha} was added and listed, and the recorded round count went ${String(before)} → ${String(after)}. Two reviews of one head counted as one round is a review that went missing`,
        );
    },
    // DIRECTION 4 only. The plant adds a document, so §1's document count is
    // legitimately stale in the copy and the gate says so; this case is about
    // whether the twin is treated as its own round, which direction 4 answers.
    expect: (d) =>
      !d.ran
        ? 'the gate did not run, and a gate that did not run is not a clean result'
        : d.contradictions === 0
          ? null
          : 'a second, properly listed report on an already-reviewed head was failed as if it were unrecorded — and the suffix is how a re-run of one head is named',
  },
  {
    id: 'M13',
    what: 'the same tagged twin, NOT listed in the Reports row — the absence half of M12',
    plant: (dir) => {
      const first = reports(dir)[0];
      if (first === undefined) throw new Error('M13 could not plant: no challenge report in the copy to twin');
      const sha = /^P15-CHALLENGE-([0-9a-f]{7,40})/.exec(first)?.[1];
      if (sha === undefined) throw new Error('M13 could not plant: the report name carries no SHA to twin');
      writeFileSync(join(dir, `P15-CHALLENGE-${sha}-M13.md`), '# a planted second review of the same head\nThis file exists only inside a throwaway copy.\n');
    },
    expect: (d) =>
      !d.ran
        ? 'the gate did not run, and a gate that did not run is not a clean result'
        : d.contradictions > 0
          ? null
          : 'a second review of an already-reviewed head sat on disk unlisted and the gate said nothing, because the head it names was already recorded — the exact shape of a collapsed duplicate',
  },
  {
    id: 'M8',
    what: 'round-8 N4: a round on disk named ONLY in a sentence about what nobody has read yet — mentioned, not recorded',
    plant: (dir) => {
      const f = join(dir, MANIFEST);
      writeFileSync(join(dir, MANIFEST), `${readFileSync(f, 'utf8')}\n\nPending, not yet read by this author: P15-CHALLENGE-0bada55.md.\n`);
      writeFileSync(join(dir, 'P15-CHALLENGE-0bada55.md'), '# planted round\nThis file exists only inside a throwaway copy.\n');
    },
    expect: (d) =>
      !d.ran
        ? 'the gate did not run, and a gate that did not run is not a clean result'
        : d.contradictions > 0
          ? null
          : 'a round on disk, named only in a sentence saying it has NOT been read, counted as recorded — which made the gate print one more round than §8 lists',
  },
  {
    id: 'M5',
    what: 'an unrecorded round, THEN the sanctioned --rewrite — the index must not become the record',
    plant: (dir) => {
      writeFileSync(join(dir, 'P15-CHALLENGE-0bada55.md'), '# planted round\nThis file exists only inside a throwaway copy.\n');
      rewrite(dir);
      const digested = readFileSync(join(dir, MANIFEST), 'utf8').includes('P15-CHALLENGE-0bada55.md');
      if (!digested) throw new Error('--rewrite did not add the planted report to the digest table, so this plant does not reach the state B2 describes');
    },
    expect: (d) =>
      !d.ran
        ? 'the gate did not run, and a gate that did not run is not a clean result'
        : d.contradictions > 0
          ? null
          : 'after its own --rewrite the gate counted the planted report as NAMED, because the digest row it had just written looked like a record. An index proves a file exists, which is the one thing never in doubt',
  },
  {
    id: 'M6',
    what: 'a line count in §3 carried forward past the commit that changed the file — the challenger\u2019s round-8 B4-1, as a case',
    plant: (dir) => {
      const f = join(dir, MANIFEST);
      const s = readFileSync(f, 'utf8');
      const m = /^\| `(scripts\/phase15\/[^`]+)` \| (\d+) \|/m.exec(s);
      if (m === null) throw new Error('no repo-file row found in \u00a73 to age');
      const broken = s.replace(m[0], `| \`${m[1] as string}\` | ${Number(m[2]) + 7} |`);
      if (broken === s) throw new Error('the row could not be changed, so this plant proves nothing');
      writeFileSync(f, broken);
    },
    expect: () => null,
    viaDirection5: (d) =>
      !d.ran
        ? 'the gate did not run, and a gate that did not run is not a clean result'
        : d.wrong > 0
          ? null
          : 'a line count in \u00a73 disagreed with git at the declared SHA and the gate passed. 24 of 25 rows being right is not a check',
  },
  {
    id: 'M7',
    what: 'a §3 row for a file that does not exist at the declared SHA — the absence half',
    plant: (dir) => {
      const f = join(dir, MANIFEST);
      const s = readFileSync(f, 'utf8');
      const m = /^\| `(scripts\/phase15\/[^`]+)` \| (\d+) \|.*$/m.exec(s);
      if (m === null) throw new Error('no repo-file row found in \u00a73 to add beside');
      writeFileSync(f, s.replace(m[0], `${m[0]}\n| \`scripts/phase15/never-existed.ts\` | 123 | a file no commit carries |`));
    },
    expect: () => null,
    viaDirection5: (d) =>
      !d.ran
        ? 'the gate did not run, and a gate that did not run is not a clean result'
        : d.wrong > 0
          ? null
          : 'the table named a file the commit does not have and the gate passed \u2014 an index of what the branch carries must not invent a row',
  },
  {
    id: 'M11',
    what: "the coordinator's replace-ref ruling: a `refs/replace` entry that changes the measured figure of a modified file must not be believed",
    plant: (dir) => {
      // WHY THIS CASE EXISTS
      //   A `refs/replace` entry makes git serve a different object everywhere
      //   — `show`, `diff`, `cat-file` — and says nothing about it in the
      //   output. It has now broken both P8's and P13's anchors silently. So
      //   every git read this gate makes carries `--no-replace-objects` AND
      //   GIT_NO_REPLACE_OBJECTS=1, and this plant is what shows that flag is
      //   load-bearing rather than decorative.
      //
      // WHERE IT IS PLANTED
      //   In a throwaway CLONE, never in this repository. A replace ref is
      //   repository-wide: left in the shared clone for even a few seconds it
      //   would silently falsify any measurement another session happens to
      //   take in that window, which is the very harm being guarded against.
      const g = (args: readonly string[], cwd: string, input?: string): { status: number; out: string } => {
        const r = spawnSync('git', [...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...(input === undefined ? {} : { input }) });
        if (r.error !== undefined) throw new Error(`M11 could not plant: git ${args.join(' ')} could not start (${r.error.message})`);
        return { status: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
      };
      const must = (args: readonly string[], cwd: string, input?: string): string => {
        const r = g(args, cwd, input);
        if (r.status !== 0) throw new Error(`M11 could not plant: git ${args.join(' ')} exited ${String(r.status)}: ${r.out.slice(0, 200).trim()}`);
        return r.out.trim();
      };
      const sha = /\*\*Exact prep SHA\*\* \| \*\*`([0-9a-f]{7,40})`\*\*/.exec(readFileSync(join(dir, MANIFEST), 'utf8'))?.[1];
      if (sha === undefined) throw new Error('M11 could not plant: this pack declares no exact SHA to measure against');
      const mainSha = must(['rev-parse', 'origin/main'], ROOT);
      const clone = mkdtempSync(join(tmpdir(), 'p15-replace-ref-'));
      try {
        must(['clone', '--shared', '--quiet', ROOT, clone], ROOT);
        must(['update-ref', 'refs/remotes/origin/main', mainSha], clone);
        // The file whose figure the forgery will move: one the branch MODIFIES.
        const modified = must(['--no-replace-objects', 'diff', '--diff-filter=M', '--name-only', `origin/main...${sha}`], clone)
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && l !== 'package.json');
        const file = modified[0];
        if (file === undefined) throw new Error('M11 could not plant: the branch modifies no repo file other than package.json, so there is no figure to move');
        const truth = must(['--no-replace-objects', 'diff', '--numstat', `origin/main..${sha}`, '--', `:(top)${file}`], clone);
        // The plant itself: the blob the subject commit carries for that file is
        // replaced by a one-line blob, so every git read that honours replace
        // objects now reports a different +N / −M for it.
        const headBlob = must(['--no-replace-objects', 'rev-parse', `${sha}:${file}`], clone);
        const planted = must(['hash-object', '-w', '--stdin', '--path', file], clone, 'planted by M11 inside a throwaway clone\n');
        if (planted.length === 0) throw new Error('M11 could not plant: the replacement blob was not written');
        must(['replace', '-f', headBlob, planted], clone);
        const replaced = must(['diff', '--numstat', `origin/main..${sha}`, '--', `:(top)${file}`], clone);
        if (replaced === truth)
          throw new Error(`M11 could not plant: the replace ref did not move the figure for ${file} (still ${truth}), so this case would prove nothing`);
        const rm = /^(\d+)\s+(\d+)\s/.exec(replaced);
        if (rm === null) throw new Error(`M11 could not plant: the replaced numstat for ${file} is unparsable (${replaced})`);
        // The manifest is forged to AGREE with the replaced reading. A gate that
        // believes replace objects therefore finds the row correct and passes.
        const f = join(dir, MANIFEST);
        const text = readFileSync(f, 'utf8');
        const esc = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const row = new RegExp(`\`${esc}\`[^|\n]*?\\*\\*\\+(\\d+) ?/ ?[-−](\\d+)\\*\\*`).exec(text);
        if (row === null) throw new Error(`M11 could not plant: no **+N / −M** row states the size of ${file}`);
        const forgedRow = (row[0] as string).replace(/\*\*\+\d+ ?\/ ?[-−]\d+\*\*/, `**+${rm[1] as string} / −${rm[2] as string}**`);
        writeFileSync(f, text.replace(row[0] as string, forgedRow));
        // ARM 1 — THE GUARD DELETED. A copy of the gate with the flag and the
        // environment variable both removed is run against the same clone: it
        // must ACCEPT the forgery. If it refuses anyway, the flag is not what
        // catches this and arm 2's red would be attributed to the wrong guard.
        const gate = readFileSync(join(ROOT, 'scripts/phase15/verify-handoff-manifest.ts'), 'utf8');
        const flag = "['--no-replace-objects', '-c', 'core.quotePath=false', ...args]";
        const envLine = "env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },";
        if (!gate.includes(flag) || !gate.includes(envLine))
          throw new Error('M11 could not plant: the gate no longer disables replace objects in the shape this plant removes');
        const stripped = join(dir, 'gate-that-believes-replace-refs.ts');
        writeFileSync(stripped, gate.replace(flag, '[...args]').replace(envLine, 'env: { ...process.env },'));
        const believing = spawnSync('npx', ['tsx', stripped, `--dir=${dir}`], { cwd: clone, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        if (believing.error !== undefined || (believing.status !== 0 && believing.status !== 1))
          throw new Error(`M11 could not plant: the stripped gate did not run (exit ${String(believing.status)})`);
        const bOut = `${believing.stdout ?? ''}${believing.stderr ?? ''}`;
        const bBlock = bOut.includes('DIRECTION 5') ? bOut.slice(bOut.indexOf('DIRECTION 5')) : '';
        if (bBlock.includes(file) && /WRONG /.test(bBlock))
          throw new Error(
            `M11: the gate with --no-replace-objects removed STILL refused the forged figure for ${file}, so the flag is not what catches a replace ref and this case attributes the red to the wrong guard`,
          );
        // ARM 2 — THE REAL GATE, same clone, same forgery. It must refuse, and
        // refuse BY NAME: a red that does not say which file is not a finding.
        const real = spawnSync('npx', ['tsx', join(ROOT, 'scripts/phase15/verify-handoff-manifest.ts'), `--dir=${dir}`], {
          cwd: clone,
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
        });
        const rOut = `${real.stdout ?? ''}${real.stderr ?? ''}`;
        if (real.error !== undefined || (real.status !== 0 && real.status !== 1))
          throw new Error(`M11: the real gate did not run (exit ${String(real.status)})`);
        const rBlock = rOut.includes('DIRECTION 5') ? rOut.slice(rOut.indexOf('DIRECTION 5')) : '';
        if (!/WRONG /.test(rBlock) || !rBlock.includes(file))
          throw new Error(
            `M11: a refs/replace entry moved the measured figure of ${file} from ${truth} to ${replaced}, the row was forged to match the replaced reading, and the real gate did not refuse it by name`,
          );
      } finally {
        rmSync(clone, { recursive: true, force: true });
      }
    },
    expect: () => null,
    viaDirection5: (d) =>
      !d.ran
        ? 'the gate did not run, and a gate that did not run is not a clean result'
        : d.wrong > 0
          ? null
          : 'the row forged to match a replace-ref reading was accepted against this repository too, so the figure is whatever a local ref says it is',
  },
];
function main(): number {
  console.log('━'.repeat(78));
  console.log('PHASE 15 — RED PROOF: DIRECTION 4 OF THE HANDOFF MANIFEST GATE   (PREPARED / NOT PROMOTED)');
  console.log('━'.repeat(78));
  console.log(`  subject pack  ${PACK} — READ, never written. Each plant goes in its own copy.`);
  console.log('');

  const base = mkdtempSync(join(tmpdir(), 'p15-mf-base-'));
  let baseline: ReturnType<typeof direction4>;
  let baseline5: ReturnType<typeof direction5>;
  try {
    cpSync(PACK, join(base, 'pack'), { recursive: true });
    baseline = direction4(join(base, 'pack'));
    baseline5 = direction5(join(base, 'pack'));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  // BOTH directions have to be clean on an untouched copy, or a later red
  // cannot be attributed to the plant that was made for it.
  if (!baseline5.ran || baseline5.wrong > 0) {
    console.log(
      `  M0 BASELINE  direction 5 on an untouched copy: FAIL — ${baseline5.ran ? `${baseline5.wrong} wrong row(s) already` : 'the gate did not run'}`,
    );
    console.log('  Everything below is INVALID. Run `verify:handoff-manifest -- --rewrite` to recount §3');
    console.log('  from git at the declared SHA, then re-run this proof.');
    console.log(baseline5.text);
    return 1;
  }
  if (!baseline.ran || baseline.contradictions > 0) {
    console.log(
      `  M0 BASELINE  an untouched copy is clean: FAIL — ${baseline.ran ? `${baseline.contradictions} contradiction(s) already` : 'the gate did not run'}`,
    );
    console.log('  Everything below is INVALID: a baseline that is already red cannot attribute a');
    console.log('  later red to a planted defect. Fix the manifest first, then re-run this proof.');
    console.log(baseline.text);
    return 1;
  }
  console.log(
    `  M0 BASELINE  an untouched copy is clean: OK (direction 4 reports no contradiction, direction 5 re-measured ${/(\d+) repo-file row/.exec(baseline5.text)?.[1] ?? '0'} row(s) from git)`,
  );

  let failures = 0;
  for (const p of PLANTS) {
    const tmp = mkdtempSync(join(tmpdir(), 'p15-mf-'));
    try {
      cpSync(PACK, join(tmp, 'pack'), { recursive: true });
      const dir = join(tmp, 'pack');
      p.plant(dir);
      const problem = p.viaDirection5 === undefined ? p.expect(direction4(dir)) : p.viaDirection5(direction5(dir));
      // A case whose requirement is "the gate must NOT complain" is labelled as
      // such: printing it as RED would read as a planted defect that reddened,
      // which is the opposite of what it measures.
      const verdict = p.id === 'M4' || p.id === 'M12' ? 'HELD GREEN ' : 'RED';
      if (problem === null) console.log(`  ${p.id} ${verdict.padEnd(10)}${p.what}`);
      else {
        failures += 1;
        console.log(`  ${p.id} FAILED    ${p.what}`);
        console.log(`       ${problem}`);
      }
    } catch (e) {
      failures += 1;
      console.log(`  ${p.id} FAILED    ${p.what}`);
      console.log(`       the plant itself did not go in: ${(e as Error).message}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  console.log('');
  if (failures > 0) {
    console.log(`EXIT 1 — ${failures} of ${PLANTS.length} plant(s) did not behave as required. Direction 4 is not`);
    console.log('  established, so the manifest’s §8 is prose again and F-14 is not closed.');
    return 1;
  }
  console.log(`All ${PLANTS.length} plants behaved as required: three reddened direction 4, and the quotation did not.`);
  console.log('  What this does NOT show: that any round PASSED. A verdict is the challenger’s to');
  console.log('  state and this author’s to quote. The gate checks only that the rounds this file');
  console.log('  claims and the rounds on disk are the same set.');
  return 0;
}

process.exitCode = main();
