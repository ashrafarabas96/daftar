/**
 * ROUND 28 — every invocation of the four pack tools that anyone is SHOWN
 * carries `-I`.
 *
 * This file exists because of F-50, which the coordinator's diff review rated
 * P1 and blocking after the challenger had filed it P3.
 *
 * The four tools under `tools/` refuse to run unless `sys.flags.isolated` is
 * set. Their own docstrings printed the un-isolated form of the command. That
 * is not cosmetic. Measured on a byte copy of the pack, with a
 * `sitecustomize.py` on `PYTHONPATH` — the B-9 threat model, which `site`
 * imports at interpreter startup before line 1 of the tool:
 *
 *   $ PYTHONPATH=evil python3 tools/manifest-digests.py --dir b --check
 *   44 files, 44 rows, 0 problems
 *   rc=0                            # over a pack with a DRIFTED document
 *
 *   $ PYTHONPATH=evil python3 -I tools/manifest-digests.py --dir b --check
 *   DRIFTED: P5-CHECKPOINT.md
 *   rc=1
 *
 * A forged green at rc 0, reached by running the command the tool's own file
 * printed. The code cannot close that vector: `sitecustomize` and
 * `usercustomize` run before any line of the script, so the only control is
 * that every invocation anyone copies carries `-I`.
 *
 * AND THE GUARD CANNOT BE READ AS ESTABLISHING ISOLATION. `sys.flags` is an
 * ordinary writable attribute of an ordinary module, so a startup plant can
 * hand the check a `flags` whose `isolated` is 1; measured, an un-isolated run
 * then printed no refusal and exited 0. The absence of the refusal is not
 * evidence. Hence a law over the text, which is a thing a reader can check
 * without trusting any run: if an un-isolated command is written down
 * anywhere in this repository, this test reds.
 *
 * The law reads RAW source on purpose, unlike `db-refusals-name-their-defence`
 * — a command inside a comment or a docstring is exactly what F-50 was, so
 * stripping comments would strip the defect.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..');
const PACK = process.env.P5_PACK_DIR ?? '/mnt/project-files/phase5';

/** The four tools whose invocations must be isolated. */
const TOOLS = ['context-sites.py', 'status-block.py', 'manifest-digests.py', 'seal-check-run.py'] as const;

/**
 * Any written invocation of one of the four, isolated or not. `python3`,
 * `python`, and an absolute or relative path to the file all count, because
 * what matters is what a reader can copy.
 */
const INVOCATION = new RegExp(String.raw`python3?\s+((?:-\S+\s+)*)(?:\S*/)?(${TOOLS.join('|').replace(/\./g, '\\.')})`, 'g');

/** `-I` present among the flags of one matched invocation. */
const isolated = (flags: string): boolean => flags.split(/\s+/).some((f) => f === '-I' || (/^-[A-Za-z]+$/.test(f) && f.includes('I')));

/** Every file of the repository, excluding what is not ours to read. */
const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (entry === '.git' || entry === 'node_modules' || entry === 'dist' || entry === '.next') {
      continue;
    }
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

/** Offending lines in one text, as `path:line: text`. */
const offencesIn = (label: string, text: string): string[] => {
  const found: string[] = [];
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(INVOCATION)) {
      if (!isolated(m[1] ?? '')) found.push(`${label}:${i + 1}: ${line.trim()}`);
    }
  });
  return found;
};

/**
 * The same scan over a Markdown document, with one exemption: a fenced block
 * whose opening fence declares `f-50-quote`.
 *
 * Found immediately after this law first ran against the published pack. These
 * documents have to QUOTE the defect — §3.1 of the checkpoint and §21.2 of the
 * response show the forged green beside the isolated run, which is the whole
 * evidence for F-50 — and a law that forbids writing the defect down forbids
 * reporting it. The exemption is therefore a sentence someone writes on the
 * fence, visible in the diff, never inferred from what the line looks like: a
 * rule that exempted `PYTHONPATH=…` lines by shape would exempt exactly the
 * command an attacker wants a reader to copy. The marker does not appear in
 * the copied text, and `quoted` below reds if the exemption ever stops being
 * used, so it cannot outlive its reason.
 */
const offencesOutsideQuotedBlocks = (label: string, text: string): [string[], number] => {
  const found: string[] = [];
  let exemptBlocks = 0;
  let inFence = false;
  let exempt = false;
  text.split('\n').forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      if (inFence) {
        inFence = false;
        exempt = false;
      } else {
        inFence = true;
        exempt = /f-50-quote/.test(line);
        if (exempt) exemptBlocks += 1;
      }
      return;
    }
    if (inFence && exempt) return;
    for (const m of line.matchAll(INVOCATION)) {
      if (!isolated(m[1] ?? '')) found.push(`${label}:${i + 1}: ${line.trim()}`);
    }
  });
  return [found, exemptBlocks];
};

const readable = (p: string): string | null => {
  try {
    const t = readFileSync(p, 'utf8');
    // A binary file is not a document and its bytes are not commands.
    return t.includes('\u0000') ? null : t;
  } catch {
    return null;
  }
};

describe('every written invocation of the pack tools is isolated', () => {
  it('finds no un-isolated invocation anywhere in the repository', () => {
    const offences: string[] = [];
    let scanned = 0;
    let seen = 0;
    for (const p of walk(REPO)) {
      const text = readable(p);
      if (text === null) continue;
      scanned += 1;
      const label = relative(REPO, p);
      // Not this file: it quotes the defect on purpose, four lines above.
      if (label.endsWith('tool-commands-are-isolated.test.ts')) {
        continue;
      }
      for (const line of text.split('\n')) {
        for (const m of line.matchAll(INVOCATION)) {
          seen += 1;
          if (!isolated(m[1] ?? '')) offences.push(`${label}: ${line.trim()}`);
        }
      }
    }
    expect(scanned, 'the walk read no files, so this law measured nothing').toBeGreaterThan(50);
    expect(seen, 'no invocation of the four tools was found anywhere, so this law is vacuous — the tools or their names moved').toBeGreaterThan(0);
    expect(
      offences,
      'an un-isolated invocation is written down: a reader who copies it runs the tool with PYTHONPATH and the user site directory on sys.path, which is F-50',
    ).toStrictEqual([]);
  });

  it('proves the scan can see an un-isolated invocation at all', () => {
    // The law above is a prohibition, so it needs a non-vacuity witness: a
    // prohibition over a scan that matches nothing passes forever.
    expect(offencesIn('fixture', '    python3 tools/manifest-digests.py --dir <dir> --check')).toStrictEqual([
      'fixture:1: python3 tools/manifest-digests.py --dir <dir> --check',
    ]);
    expect(offencesIn('fixture', '$ python3 ./tools/seal-check-run.py --dir p --tests t')).toHaveLength(1);
    expect(offencesIn('fixture', 'python3 -E -s tools/status-block.py --dir d')).toHaveLength(1);
    // And it must NOT red on the forms that are correct, or the law would be
    // unsatisfiable and someone would delete it.
    expect(offencesIn('fixture', '    python3 -I tools/context-sites.py --dir d --tests t')).toStrictEqual([]);
    expect(offencesIn('fixture', 'python3 -I -X faulthandler tools/manifest-digests.py')).toStrictEqual([]);
    expect(offencesIn('fixture', '[sys.executable, "-I", str(tools / "status-block.py")]')).toStrictEqual([]);
  });

  it('exempts a DECLARED quotation block, and nothing else', () => {
    const quoted = ['```text f-50-quote', '$ python3 tools/manifest-digests.py --check', '```'].join('\n');
    const undeclared = ['```text', '$ python3 tools/manifest-digests.py --check', '```'].join('\n');
    const after = ['```text f-50-quote', '$ python3 tools/manifest-digests.py --check', '```', '', 'Run it with `python3 tools/status-block.py --dir d`.'].join(
      '\n',
    );

    expect(offencesOutsideQuotedBlocks('doc', quoted)).toStrictEqual([[], 1]);
    // Without the declaration the very same line is an offence, which is what
    // makes the exemption a sentence someone wrote rather than a shape.
    expect(offencesOutsideQuotedBlocks('doc', undeclared)[0]).toHaveLength(1);
    // And the exemption ends with its block: prose after the fence is covered.
    expect(offencesOutsideQuotedBlocks('doc', after)[0]).toHaveLength(1);
  });

  it('holds over the pack documents this author owns, when the pack is present', () => {
    // The pack lives outside the repository, so this arm is measured HERE and
    // not in CI; that limit is written into the handoff rather than left for a
    // reader to discover. Reviewer-owned reports are exempt BY EXACT NAME:
    // they are frozen bytes quoting the old text, and correcting a reviewer's
    // report would be worse than the defect.
    if (!existsSync(PACK)) {
      expect(existsSync(PACK), `no pack at ${PACK}: this arm is UNMEASURED here, by absence`).toBe(false);
      return;
    }
    const reviewerOwned = /^P5-(CHALLENGE|COORD-DIFF-REVIEW)-[0-9a-f]{7}\.md$/;
    const offences: string[] = [];
    let quoted = 0;
    let mine = 0;
    for (const name of readdirSync(PACK)) {
      if (reviewerOwned.test(name)) continue;
      const text = readable(join(PACK, name));
      if (text === null) continue;
      mine += 1;
      const [found, exempted] = offencesOutsideQuotedBlocks(name, text);
      offences.push(...found);
      quoted += exempted;
    }
    expect(mine, 'no author-owned document was read from the pack').toBeGreaterThan(0);
    expect(
      quoted,
      'no declared `f-50-quote` block was found: the documents stopped quoting the defect, so that exemption is dead and should be deleted rather than left standing',
    ).toBeGreaterThan(0);
    expect(offences, 'an author-owned pack document prints an un-isolated command, which is the half of F-50 that routes the reader').toStrictEqual([]);
  });
});
