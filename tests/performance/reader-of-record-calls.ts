/**
 * `P4-AL-07`'s stripper, in one place and testable without a database.
 *
 * WHY THIS IS A MODULE AND NOT A REGEXP IN THE GATE. The law at
 * `receivables-s4-budgets.test.ts` says: a read derives its money through the
 * product's own reader of record and sums nothing itself. It is checked by
 * removing every reader-of-record CALL from the statement and then refusing a
 * `sum(` in what is left, so the removal is the whole of the law's teeth — and
 * it was a regular expression, `…\([^)]*\)`, which cannot balance parentheses:
 * it stops at the FIRST `)`. A statement whose reader call carried a sum IN ITS
 * ARGUMENT, `invoice_outstanding(sum(x), $2)`, was stripped to `, $2)`: the sum
 * left with the fragment and the law passed the very thing it exists to refuse
 * — a second copy of the arithmetic, with a slower failure mode.
 *
 * WHAT THE REMOVAL MUST DO, AND WHAT IT MUST NOT. Measured while writing this:
 * a balanced removal that deletes the call WITH its arguments does not close
 * the hole either — `invoice_outstanding(sum(x), $2)` becomes `SELECT ` and the
 * sum is gone again. The law's subject is the arithmetic the READ performs, and
 * an argument is the read's own text, so the removal deletes the call's NAME
 * and its matching parentheses and KEEPS what was inside them:
 *
 *   `SELECT invoice_outstanding(sum(x), $2)`                      → `SELECT sum(x), $2`   refused
 *   `SELECT * FROM customer_ar_outstanding($1, $2)`               → `SELECT * FROM $1, $2` allowed
 *   `SELECT invoice_outstanding(customer_ar_outstanding($1), $2)` → `SELECT $1, $2`        allowed
 *
 * The remainder is not valid SQL and is not meant to be: it is the read's own
 * text with the product's own readers taken out of it, which is exactly the
 * question the law asks. Nesting is handled because the scan continues INSIDE a
 * removed call's parentheses.
 *
 * It is strictly tighter than the pattern it replaces and never looser: every
 * statement the pattern refused is still refused (its remainder only grows),
 * and the class above is refused where it was allowed. Five classes are
 * measured in `reader-of-record-strip.test.ts`, which runs with no database.
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
 * Remove every reader-of-record call's NAME and matching parentheses from
 * `text`, keeping its arguments, at any nesting depth.
 *
 * Parentheses inside string literals and dollar-quoted bodies are counted like
 * any other character. A literal carrying an unbalanced parenthesis would
 * therefore pair a call's opening parenthesis with the wrong `)`; what that can
 * do is keep MORE of the statement in the remainder, never less, so it cannot
 * make a summing read pass — only fail, naming the statement in the law's own
 * message. Recorded rather than asserted away because the subject is the
 * statements this project's own reads issue.
 */
export function stripReaderOfRecordCalls(text: string, names: readonly string[]): string {
  const head = new RegExp(`\\b(?:public\\.)?(?:${names.join('|')})\\s*\\(`, 'gi');
  // Indices of the `)` that closes a removed call: dropped when reached.
  const closers = new Set<number>();
  let out = '';
  let i = 0;
  while (i < text.length) {
    head.lastIndex = i;
    const m = head.exec(text);
    if (m !== null && m.index === i) {
      // Find the `)` matching the `(` this match ends on, and mark it.
      let depth = 1;
      let j = i + m[0].length;
      for (; j < text.length && depth > 0; j += 1) {
        const ch = text[j];
        if (ch === '(') depth += 1;
        else if (ch === ')') depth -= 1;
      }
      if (depth === 0) closers.add(j - 1);
      i += m[0].length; // the name and its `(` are dropped
      continue;
    }
    if (!closers.has(i)) out += text[i];
    i += 1;
  }
  return out;
}
