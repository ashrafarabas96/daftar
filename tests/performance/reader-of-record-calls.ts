/**
 * `P4-AL-07`'s stripper, in one place and testable without a database.
 *
 * THIS COMMIT MOVES THE LAW'S TEETH WITHOUT CHANGING THEM. The law at
 * `receivables-s4-budgets.test.ts` says: a read derives its money through the
 * product's own reader of record and sums nothing itself. It is checked by
 * removing every reader-of-record CALL from the statement and then refusing a
 * `sum(` in what is left — so the removal is the whole of the law's teeth.
 * `stripReaderOfRecordCalls` below is that removal, byte for byte as the gate
 * performed it inline, so that the suite beside it can measure what the removal
 * does and does not catch WITHOUT a database.
 *
 * The suite `reader-of-record-strip.test.ts` is red on this commit, on purpose,
 * and the red is the subject: `…\([^)]*\)` cannot balance parentheses — it
 * stops at the FIRST `)`. A statement whose reader call carries a sum IN ITS
 * ARGUMENT, `invoice_outstanding(sum(x), $2)`, is stripped to `, $2)`: the sum
 * leaves with the fragment and the law passes the very thing it exists to
 * refuse — a second copy of the arithmetic, with a slower failure mode.
 *
 * Handed over from P4-PERF by card `P4PERF_AL07_STRIP_UNBALANCED_PARENS_AR.md`,
 * whose terms are explicit: `P4-AL-07` tightens and is never relaxed, and no
 * name may be removed from the closure to make a statement pass.
 */

/** Matches a reader-of-record call's NAME, used to find the statements that call one at all. */
export function readerOfRecordCall(names: readonly string[]): RegExp {
  return new RegExp(`\\b(?:public\\.)?(?:${names.join('|')})\\s*\\(`, 'i');
}

/**
 * Remove every reader-of-record call from `text`, with its arguments.
 *
 * As it stands: the pattern the gate used inline, unchanged, parenthesis
 * blindness included. The remedy is the next commit; this one establishes what
 * the behaviour IS, measured, so the change can be read against it (RULE-16).
 */
export function stripReaderOfRecordCalls(text: string, names: readonly string[]): string {
  return text.replace(new RegExp(`\\b(?:public\\.)?(?:${names.join('|')})\\([^)]*\\)`, 'gi'), '');
}
