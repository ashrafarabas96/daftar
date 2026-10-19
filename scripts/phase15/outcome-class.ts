/**
 * PHASE 15 — WHAT A NON-ZERO EXIT CODE MEANS
 * (PREPARED / NOT PROMOTED)
 *
 * This is the evidence log's classifier, in a module of its own so it can be
 * PROVED against real process output instead of a hand-written record.
 *
 * It was extracted on challenge round 6, H-04. The classifier's law — a crash
 * and a measured-but-adverse run must never print the same way — had a red proof
 * for the crash that happens BEFORE any measurement, injected into the
 * instrument's own process with a real module error. The half a reader assumes
 * is covered, a crash AFTER the summary line, was proved only through a
 * `beforeExit` hook; the shape the challenger planted was a synchronous throw at
 * the end of the instrument's own module evaluation, and nothing in the pack ran
 * that shape end to end. It could not be run from inside the runner without
 * editing an instrument in the tree, so the classifier moved to where a proof
 * can reach it: `scripts/phase15/outcome-class-proof.ts` copies a real
 * instrument, appends a real throw, runs it, and classifies what actually came
 * out of the process.
 *
 * Nothing here judges a subject. It judges the RUN: did the process reach its
 * own summary, and did it die. The instrument's verdict is the reader's to weigh.
 */
/** What the classifier needs to know about a run. Nothing else. */
export interface Classifiable {
  readonly output: string;
  readonly exitCode: number | null;
  readonly ran: boolean;
  readonly notRunReason: string | null;
  readonly counts: Counts;
}

export interface Counts {
  readonly measured: number | null;
  readonly unmeasured: number | null;
  readonly findings: number | null;
  readonly skips: number | null;
  readonly dirtyTreeDeclared: boolean;
  /** the exact line the numbers were read from, so they can be checked. */
  readonly readFrom: string | null;
}

export const SUMMARY_LINE = /^(?:measured\s+\d+\s+of\s+\d+:|\d+\s+probes?:|\d+\s+(?:case|check|rule|item)s?:)/i;

export function scrape(out: string): Counts {
  const full = out;
  const line = out
    .split('\n')
    .map((l) => l.trim())
    .find((l) => SUMMARY_LINE.test(l));

  if (line === undefined) {
    return {
      measured: null,
      unmeasured: null,
      findings: null,
      skips: null,
      dirtyTreeDeclared: /PLUS UNCOMMITTED CHANGES|THE TREE IS NOT CLEAN/.test(full),
      readFrom: null,
    };
  }

  const num = (re: RegExp): number | null => {
    const m = re.exec(line);
    return m?.[1] === undefined ? null : Number(m[1]);
  };
  return {
    // `measured N of M` and `N probes: N MEASURED` are the two shapes in use.
    measured: num(/^measured\s+(\d+)\s+of\s+\d+/i) ?? num(/(\d+)\s+MEASURED/),
    unmeasured: num(/(\d+)\s+UNMEASURED/),
    findings: num(/(\d+)\s+FINDING/),
    // A skip is the one count whose ABSENCE is the good news, so it is scraped
    // from an explicit statement only. PART 12: a PASS that contains mandatory
    // skips is not a PASS, and silence about skips is not a statement of none.
    skips: num(/(\d+)\s+skip/i),
    dirtyTreeDeclared: /PLUS UNCOMMITTED CHANGES|THE TREE IS NOT CLEAN/.test(full),
    readFrom: line,
  };
}

export const LOADER_MARKERS =
  /ERR_MODULE_NOT_FOUND|Cannot find module|ERR_UNKNOWN_FILE_EXTENSION|ERR_REQUIRE_ESM|SyntaxError:|ERR_INVALID_ARG|MODULE_NOT_FOUND/;

export const RUNTIME_MARKERS =
  /(?:^|\n)\s*(?:Uncaught )?(?:TypeError|RangeError|ReferenceError|AssertionError|Error):|\n\s+at [^\n]*\(?[^\n]*:\d+:\d+\)?|UnhandledPromiseRejection|FATAL ERROR:|Segmentation fault/;

export const VERDICT_LINE =
  /^(?:EXIT\s+\d+\s+[—-]|PHASE\s+15\s+[A-Z0-9 /-]+:\s*(?:PASS|FAIL|VERIFIED|UNMEASURED|REJECT|INVALID MEASUREMENT)|P15[A-Z0-9_ ]*:\s*\{)/m;

/**
 * «I COULD NOT MEASURE» IS NOT A VERDICT ABOUT THE SUBJECT (round 12, F-R12-02a).
 *
 * `pitr:proof` grew a distinct exit 3 for a drill that never ran because a
 * fixed port was held. This classifier did not know the headline, so a real
 * exit-3 transcript was labelled «MEASURED, THEN EXITED NON-ZERO … so the code
 * is its verdict» — the exact confusion the exit code was added to end, moved
 * one layer out into the record that quotes it.
 *
 * It is matched on the instrument's own HEADLINE, not on the number 3: a code
 * means whatever an instrument decides it means, and this record reads evidence
 * in the log rather than a convention it hopes holds. Note that a drill which
 * measured a FAILURE before the contention says FAIL and exits 1 — that is a
 * verdict, and it is classified as one; only a run whose verdict line IS the
 * contention headline did not measure.
 */
export const CONTENTION_VERDICT = /^(?:PHASE\s+15\s+[A-Z0-9 /-]+:\s*)?INVALID MEASUREMENT\b/m;

export function reachedVerdict(r: Classifiable): string | null {
  const line = r.output
    .split('\n')
    .map((l) => l.trim())
    .find((l) => VERDICT_LINE.test(l));
  return line === undefined ? null : line.slice(0, 110);
}

export function outcomeClass(r: Classifiable): string {
  if (r.notRunReason !== null) return `NOT RUN — ${r.notRunReason}`;
  if (!r.ran) return 'NO RESULT — the process returned no exit code of its own';
  if (r.exitCode === 0) return 'COMPLETED, exit 0';
  const loader = LOADER_MARKERS.test(r.output);
  const threw = RUNTIME_MARKERS.test(r.output);
  const reached = r.counts.readFrom !== null || reachedVerdict(r) !== null;
  if (loader && !reached) return 'CRASHED BEFORE MEASURING — a loader/parse error and no summary line, so this exit code is NOT a verdict about the subject';
  if (threw && !reached)
    return 'CRASHED BEFORE MEASURING — an uncaught runtime error with no summary line, so this exit code is NOT a verdict about the subject';
  if (loader || threw)
    return 'MEASURED, THEN THREW — it reached its own summary AND died on an uncaught error, so its totals describe an INCOMPLETE run and the exit code is not a verdict either';
  if (CONTENTION_VERDICT.test(r.output))
    return 'DID NOT MEASURE — the instrument declared INVALID MEASUREMENT (a resource it needed was held), so this exit code is a statement about the RUN and not a verdict about the subject. Re-run it alone; nothing here is evidence either way';
  if (r.counts.readFrom !== null) return 'MEASURED, THEN EXITED NON-ZERO — the instrument reached its own summary line, so the code is its verdict';
  const verdict = reachedVerdict(r);
  if (verdict !== null) return `MEASURED, THEN EXITED NON-ZERO — it printed its own verdict line (“${verdict}”), so the code is its verdict`;
  return 'UNCLASSIFIED NON-ZERO — no crash marker, no summary line and no verdict line this runner recognises; only the log settles it';
}
