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

/**
 * The verdicts this pack's instruments print, and the three ways they open a
 * headline. `VERDICT:` is `backup-restore-proof.ts`, and `EXIT n:` with a
 * COLON is `gap-list-verification.ts`, `pg-version-matrix.ts` and the evidence
 * runner itself — round 16 measured both being read as no headline at all, so
 * the machine record stood in for them and the classifier quoted a JSON blob
 * as «its own verdict line».
 */
const VERDICTS = 'PASS|FAIL|VERIFIED|UNMEASURED|NOT MEASURED|NO VERDICT|REJECT|INVALID MEASUREMENT';
const OPENERS = `(?:EXIT\\s+\\d+\\s*[—:-]\\s*|(?:${SPEAKER}|VERDICT):\\s*)`;

export const VERDICT_HEADLINE = new RegExp(`^(?:EXIT\\s+\\d+\\s*[—:-]|(?:${SPEAKER}|VERDICT):\\s*(?:${VERDICTS}))`, 'm');

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
export const CONTENTION_VERDICT = new RegExp(`^${OPENERS}?INVALID MEASUREMENT\\b`);

/**
 * «I COULD NOT MEASURE», IN THE PACK'S OTHER SPELLINGS (round 16, F-R16-04).
 *
 * Contention is one way an instrument says it did not measure. `UNMEASURED`
 * and `NOT MEASURED` are the others, and `verify:role-attributes` prints
 * «EXIT 2 — NOT MEASURED, which is NOT a clean result.» on a real run at this
 * head — filed, until now, as «MEASURED, THEN EXITED NON-ZERO … so the code is
 * its verdict». Same defect as F-R15-01, a third instrument.
 *
 * `NO VERDICT` is the fourth spelling, and round 16 named it in its own remedy
 * and then shipped three (round 17, F-R17-04). `load-harness.ts` prints
 * «P15 LOAD: NO VERDICT — a refusal is not a FAIL and is never a PASS.» on
 * every refusal path, and the classifier filed a real one as «no verdict line
 * this runner recognises». That was honest — it sent the reader to the log —
 * but the instrument had said in as many words that it did not measure, and a
 * record that cannot hear that is reading the sentence and not the statement.
 *
 * The opener is optional because a machine record declares a BARE verdict —
 * `pitr-proof.ts`'s own `result` can be the string `UNMEASURED` — and the `^`
 * anchor is what keeps this honest: a PASS that merely mentions unmeasured
 * subjects later in its own sentence does not start with the word.
 */
export const DID_NOT_MEASURE = new RegExp(`^${OPENERS}?(?:INVALID MEASUREMENT|UNMEASURED|NOT MEASURED|NO VERDICT)\\b`);

/**
 * A REFUSAL THAT NAMES NO SPEAKER IS STILL A REFUSAL (round 18, F-R18-09).
 *
 * `verify-role-convergence.ts` opens «UNMEASURED: none of 969b8605, … is
 * reachable in this repository.» — a headline with no `EXIT n —` and no
 * `SPEAKER:` in front of it, so `VERDICT_HEADLINE` did not match, `declared`
 * fell through to the machine record, and a real transcript from a real run
 * was filed UNCLASSIFIED although `DID_NOT_MEASURE` matches the line exactly.
 *
 * It is read ONLY where nothing else speaks for the run: a bare refusal line
 * cannot outrank a verdict headline, because an instrument that refuses one
 * subject and then reaches a verdict has reached a verdict. Widening the
 * headline rule itself would have let such a line downgrade a measured FAIL
 * to «did not measure», which is the wrong direction to be wrong in.
 */
export const BARE_REFUSAL = new RegExp('^(?:INVALID MEASUREMENT|UNMEASURED|NOT MEASURED|NO VERDICT)\\s*[:—-]');
/**
 * A CONTENTION THE INSTRUMENT COULD NOT ANNOUNCE (round 20, F-R20-05).
 *
 * Every rule above reads a DECLARATION: the instrument reached a line and said
 * what the run was worth. That is the whole mechanism, and it has one blind
 * spot — an instrument whose cluster never starts never reaches any line of
 * its own. In the `ed26e00` confirmation run `test:phase15:load-harness` found
 * port 55432 held by a postmaster still shutting down, its global setup threw,
 * and the only verdict in the log was vitest's «No test files found, exiting
 * with code 1» — a setup failure wearing a filter failure's words. The
 * classifier had nothing to read and filed it `UNCLASSIFIED NON-ZERO`, which
 * is honest and useless: the log settles it in two lines, and this is the
 * second time the same held port has produced the same sentence (the `60458ec`
 * run, recorded in `pg-cluster.ts`).
 *
 * So where NOTHING spoke for the run, the SERVER's own log is read instead of
 * the instrument's. It is anchored to the postmaster's line format — a `[pid]`
 * followed by its own severity keyword — and not to the English phrase: a run
 * that merely MENTIONS a busy port in prose it writes itself must stay
 * unclassified, because «a value appearing anywhere in text the subject
 * writes» is the defect family this pack has spent eight rounds closing.
 * Control `O11c` holds that boundary, and `O11b` holds the other one: a run
 * that hit the bind failure and then reached its own verdict keeps the
 * verdict, because contention must never downgrade a measurement.
 *
 * This says nothing about the subject. It says the port was held, and the
 * instrument must be re-run alone before anything is claimed either way.
 */
/**
 * NARROWED AFTER ROUND 21 (F-R21-04, F-R21-05). The first version of this rule
 * was itself a fail-open, in two ways the challenger measured on real output:
 *
 * * It accepted `WARNING: could not create listen socket for "::1"`, which a
 *   HEALTHY postmaster logs on every start when `listen_addresses` names an
 *   address family the kernel does not have. The challenger produced it from a
 *   real PG 16.15 cluster. On such a cluster EVERY crash-without-verdict would
 *   have been read as contention and sent to «re-run it alone». The phrases
 *   kept are only the ones a FAILED bind produces: a `could not bind` that
 *   says the address is in use, and the FATAL summary that no TCP/IP socket
 *   could be created at all. A per-family WARNING is not a failure to start.
 * * Its anchor was `^.*\[\d+\]`, so the postmaster's shape could sit anywhere
 *   on the line — quoted, indented, or behind a diff marker — which is the
 *   «value appearing anywhere in text the subject writes» family all over
 *   again, in the rule written to close it. The anchor is now the server's own
 *   line BEGINNING: its timestamp, then the pid, then the severity, so an
 *   INDENTED or diff-marked quote no longer speaks for the server.
 *
 * WHAT THAT ANCHOR DOES NOT BUY, stated because round 22 measured the
 * overclaim (F-R22-14): the sentence here used to read «a subject that quotes
 * a postmaster log no longer speaks for the server», and a quote reproduced
 * VERBATIM AT COLUMN 0 is byte-identical to the server's own line, so nothing
 * in this file can tell them apart. O11's own plant is such a subject. It is
 * a NAMED RESIDUAL, not a closed hole. No in-pack route reaches it: the two
 * instruments that echo a server-log tail, `pitr-proof.ts` and
 * `pg-version-matrix.ts`, embed it in a thrown `Error`, and MEASURED-THEN-THREW
 * is decided before this rule is read. Closing it would need provenance --
 * the server's log read from the file the server wrote, not from the
 * instrument's transcript -- which the runner does not have.
 *
 * Controls `O11c` and `O11e` hold the boundaries this anchor DOES hold, and
 * `O11d` holds the phrase boundary.
 */
export const SERVER_BIND_FAILURE = new RegExp(
  String.raw`^\d{4}-\d{2}-\d{2} [\d:.]+ \S+ \[\d+\]\s+(?:LOG|FATAL):\s+(?:could not bind \S+ address[^\n]*Address already in use|could not create any TCP/IP sockets)`,
  'm',
);

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
    const declared = [record.result, record.verdict].filter((v): v is string => typeof v === 'string');
    // WHERE TWO KEYS DISAGREE, THE ADVERSE ONE WINS (round 16, F-R16-08).
    // `result` used to shadow a `verdict` saying something else, which is the
    // same shape as a later line downgrading a verdict, read the other way up.
    return declared.find((v) => DID_NOT_MEASURE.test(v)) ?? declared[0] ?? null;
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
  const headlineOrRecord = verdictLine !== null && VERDICT_HEADLINE.test(verdictLine) ? verdictLine : machineResult(r.output);
  // Only when nothing else spoke for the run (round 18, F-R18-09).
  const declared =
    headlineOrRecord ??
    (verdictLine === null
      ? (r.output
          .split('\n')
          .map((l) => l.trim())
          .find((l) => BARE_REFUSAL.test(l)) ?? null)
      : null);
  if (declared !== null && CONTENTION_VERDICT.test(declared))
    return 'DID NOT MEASURE — the instrument declared INVALID MEASUREMENT (a resource it needed was held), so this exit code is a statement about the RUN and not a verdict about the subject. Re-run it alone; nothing here is evidence either way';
  if (declared !== null && DID_NOT_MEASURE.test(declared))
    return `DID NOT MEASURE — the instrument declared that it did not measure (“${declared.slice(0, 70)}”), so this exit code is a statement about the RUN and not a verdict about the subject. Nothing here is evidence either way`;
  if (r.counts.readFrom !== null) return 'MEASURED, THEN EXITED NON-ZERO — the instrument reached its own summary line, so the code is its verdict';
  if (verdictLine !== null) return `MEASURED, THEN EXITED NON-ZERO — it printed its own verdict line (“${verdictLine}”), so the code is its verdict`;
  // Nothing above spoke for this run: no counts, no verdict line, no bare
  // refusal. Only here is the SERVER's log read, so this can never downgrade
  // an instrument that reached a verdict of its own.
  if (SERVER_BIND_FAILURE.test(r.output))
    return 'DID NOT MEASURE — the instrument never reached a line of its own, and the SERVER log in this transcript says it could not bind its port, so a resource it needed was held. This exit code is a statement about the RUN; re-run it alone, and nothing here is evidence either way';
  return 'UNCLASSIFIED NON-ZERO — no crash marker, no summary line and no verdict line this runner recognises; only the log settles it';
}
