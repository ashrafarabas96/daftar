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

/**
 * A VERDICT AND A MACHINE RECORD ARE NOT THE SAME LINE (round 14, F-R14-01).
 *
 * These were one pattern, and `reachedVerdict` took the FIRST line that matched
 * it. `pitr-proof.ts` prints `P15_PITR_PROOF: {…}` immediately BEFORE its
 * headline, so the line this record called «the verdict the run reached» was
 * the JSON blob, and the contention test below — rewritten in round 13 to read
 * the verdict line rather than the whole transcript — was never once applied to
 * the headline it was written for. A real exit-3 contention transcript went
 * back to reading «MEASURED, THEN EXITED NON-ZERO … so the code is its
 * verdict»: the round-13 fix was a regression, measured against the round-12
 * classifier over the same bytes. `load-harness.ts` prints the same way.
 *
 * So the HEADLINE is its own pattern and is preferred, the machine record is a
 * fallback for an instrument that prints no headline, and `VERDICT_LINE` stays
 * the union of the two for any reader that wants «did it reach either».
 */
/**
 * ONE SPELLING OF «WHO IS SPEAKING», SHARED BY ALL THREE PATTERNS (round 15,
 * F-R15-01). Round 14 widened the headline pattern to reach `load-harness.ts`'s
 * «P15 LOAD <profile>: <verdict>» and left `CONTENTION_VERDICT` on the narrower
 * `PHASE 15 …` prefix, so the two stopped meeting: a load run that declared
 * INVALID MEASUREMENT reached its headline, was recognised as a headline, and
 * was then tested against a pattern that could not match it — «MEASURED, THEN
 * EXITED NON-ZERO … so the code is its verdict», for a second round running,
 * in the instrument round 14 had named by name. Two patterns that must agree
 * about who speaks are now built from ONE fragment, so widening one widens the
 * other and they cannot drift apart again.
 */
const SPEAKER = String.raw`(?:PHASE\s+15|P15)[^:\n]*`;

export const VERDICT_HEADLINE = new RegExp(`^(?:EXIT\\s+\\d+\\s+[—-]|${SPEAKER}:\\s*(?:PASS|FAIL|VERIFIED|UNMEASURED|REJECT|INVALID MEASUREMENT))`, 'm');

export const MACHINE_SUMMARY = new RegExp(`^${SPEAKER}:\\s*\\{`, 'm');

export const VERDICT_LINE = new RegExp(`(?:${VERDICT_HEADLINE.source})|(?:${MACHINE_SUMMARY.source})`, 'm');

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
export const CONTENTION_VERDICT = new RegExp(`^(?:${SPEAKER}:\\s*)?INVALID MEASUREMENT\\b`);

export function reachedVerdict(r: Classifiable): string | null {
  const lines = r.output.split('\n').map((l) => l.trim());
  // The headline first, wherever it sits: a machine record printed above it is
  // this record's own data, not the instrument speaking (F-R14-01).
  const headline = lines.find((l) => VERDICT_HEADLINE.test(l));
  if (headline !== undefined) return headline.slice(0, 110);
  const machine = lines.find((l) => MACHINE_SUMMARY.test(l));
  return machine === undefined ? null : machine.slice(0, 110);
}

/**
 * The `result` field of a machine record, for an instrument that prints one and
 * no headline. It is read from the WHOLE line, never from the truncated copy
 * `reachedVerdict` returns for display, and an unparsable or absent record is
 * `null` — not a result anybody can quote.
 */
export function machineResult(out: string): string | null {
  const line = out
    .split('\n')
    .map((l) => l.trim())
    .find((l) => MACHINE_SUMMARY.test(l));
  if (line === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(line.slice(line.indexOf('{')));
    // The two keys this pack's instruments declare an outcome under:
    // `pitr-proof.ts` writes `result`, `load-harness.ts` writes `verdict`.
    // Reading only the first is how a load run's INVALID MEASUREMENT fell
    // through the fallback as well as past the headline (round 15, F-R15-01).
    const record = parsed as { result?: unknown; verdict?: unknown };
    for (const value of [record.result, record.verdict]) if (typeof value === 'string') return value;
    return null;
  } catch {
    return null;
  }
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
  // ROUND 13's F-R13-05: this was tested against the WHOLE transcript, and
  // before the verdict was read. A drill that measured a FAILURE and ALSO hit
  // contention prints both lines, so a measured failure was downgraded to «did
  // not measure» by a sentence further down its own output. Arm O3c passed
  // only because the drill happens to indent that line by two spaces — a
  // classification resting on whitespace. It is now read from the VERDICT LINE
  // the run reached, which is the only line that speaks for the run.
  const verdictLine = reachedVerdict(r);
  // What the INSTRUMENT declared: its headline when it printed one, otherwise
  // the `result` of its machine record. A headline outranks the record, which
  // is round 13's law unchanged — only the line that speaks for the run counts.
  const declared = verdictLine !== null && VERDICT_HEADLINE.test(verdictLine) ? verdictLine : machineResult(r.output);
  if (declared !== null && CONTENTION_VERDICT.test(declared))
    return 'DID NOT MEASURE — the instrument declared INVALID MEASUREMENT (a resource it needed was held), so this exit code is a statement about the RUN and not a verdict about the subject. Re-run it alone; nothing here is evidence either way';
  if (r.counts.readFrom !== null) return 'MEASURED, THEN EXITED NON-ZERO — the instrument reached its own summary line, so the code is its verdict';
  if (verdictLine !== null) return `MEASURED, THEN EXITED NON-ZERO — it printed its own verdict line (“${verdictLine}”), so the code is its verdict`;
  return 'UNCLASSIFIED NON-ZERO — no crash marker, no summary line and no verdict line this runner recognises; only the log settles it';
}
