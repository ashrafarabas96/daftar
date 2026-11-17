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
 * any other character, so a literal carrying an unbalanced parenthesis pairs a
 * call's opening parenthesis with the wrong `)`. MEASURED, not reasoned: eight
 * such statements were probed — an unbalanced `(` and an unbalanced `)` inside
 * a single-quoted literal, a `)` inside a dollar-quoted body, a `)` in a
 * literal inside a sum's own argument, an escaped quote, a line comment, and
 * two reader calls in one statement — and NONE of them let a summing read
 * through, with the probe's own control sighted (a removal that deleted
 * everything would have read as unsafe). The distortion eats INTO the literal
 * and leaves MORE of the statement in the remainder, never less, which is the
 * refusing direction. Three of the eight are permanent cases in the table
 * below, one of them the "allowed" side under the same distortion.
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

/** One class of statement the removal must refuse or leave alone. */
export interface ReaderStripCase {
  /** What the class is, in the law's own terms. */
  readonly what: string;
  readonly text: string;
  readonly names: readonly string[];
  /** `true`: a `sum(` must survive the removal. `false`: it must not. */
  readonly mustRefuse: boolean;
  /** The exact remainder, so a pass is a measurement and not a coincidence. */
  readonly remainder: string;
}

/**
 * The classes themselves, in one table, because the two places that read them
 * are a database-free suite and the law's own suite — and a class table that
 * lives in only one of them is a class table only one runner ever reads.
 *
 * MEASURED, and the reason this table exists: nothing reaches
 * `reader-of-record-strip.test.ts` on the runner. The test is REACH, not naming
 * — the CI-speed lane measured suites that no `ci.yml` argument names and that
 * gate scripts run anyway, so "not named" is not "not run" (their measurement,
 * not mine). Mine is narrower: this suite's name appears nowhere in `scripts`,
 * `.github`, `packages`, `apps` or `tests` but a doc comment here, with the
 * probe sighted on the suites that lane named. A suite nothing reaches is
 * NOT_RUN, and NOT_RUN does not count — so the classes are asserted from here
 * by `receivables-s4-budgets.test.ts` too, which the runner does execute, and
 * the law's teeth are measured on the runner on the same head as the law.
 * `ci.yml` belongs to another lane and was not touched.
 */
export const READER_STRIP_CASES: readonly ReaderStripCase[] = [
  {
    what: 'a bare sum in the read itself',
    text: 'SELECT sum(amount) FROM invoices WHERE customer_id = $1',
    names: ['invoice_outstanding', 'customer_ar_outstanding'],
    mustRefuse: true,
    remainder: 'SELECT sum(amount) FROM invoices WHERE customer_id = $1',
  },
  {
    what: "a sum inside a reader of record's argument — the class the old pattern allowed",
    text: 'SELECT invoice_outstanding(sum(x), $2)',
    names: ['invoice_outstanding', 'customer_ar_outstanding'],
    mustRefuse: true,
    remainder: 'SELECT sum(x), $2',
  },
  {
    what: 'a reader of record call that sums nothing itself',
    text: 'SELECT * FROM customer_ar_outstanding($1, $2)',
    names: ['invoice_outstanding', 'customer_ar_outstanding'],
    mustRefuse: false,
    remainder: 'SELECT * FROM $1, $2',
  },
  {
    what: 'two readers of record nested, with no sum of their own',
    text: 'SELECT invoice_outstanding(customer_ar_outstanding($1, $2), $3)',
    names: ['invoice_outstanding', 'customer_ar_outstanding'],
    mustRefuse: false,
    remainder: 'SELECT $1, $2, $3',
  },
  {
    what: "a sum applied TO a reader of record's result",
    text: 'SELECT sum(invoice_outstanding($1)) FROM customers WHERE id = $2',
    names: ['invoice_outstanding', 'customer_ar_outstanding'],
    mustRefuse: true,
    remainder: 'SELECT sum($1) FROM customers WHERE id = $2',
  },
  {
    what: "CONTROL: an unlisted function keeps its call, so the removal's subject is the NAMES and not the shape",
    text: 'SELECT some_other_function(sum(x), $2)',
    names: ['invoice_outstanding', 'customer_ar_outstanding'],
    mustRefuse: true,
    remainder: 'SELECT some_other_function(sum(x), $2)',
  },
  {
    // The removal pairs the call's `(` with the `)` INSIDE the literal, so it
    // eats into the literal and the sum after it survives in the remainder —
    // more text, not less, which is the refusing direction. Measured, not
    // reasoned: eight literal, dollar-quote, escaped-quote and comment cases
    // were probed and none let a summing read through.
    what: "a sum after a reader's argument whose literal carries an unbalanced )",
    text: "SELECT invoice_outstanding(')', sum(x))",
    names: ['invoice_outstanding', 'customer_ar_outstanding'],
    mustRefuse: true,
    remainder: "SELECT '', sum(x))",
  },
  {
    what: 'a sum after a reader whose dollar-quoted body carries a )',
    text: 'SELECT invoice_outstanding($q$ ) $q$, sum(x))',
    names: ['invoice_outstanding', 'customer_ar_outstanding'],
    mustRefuse: true,
    remainder: 'SELECT $q$  $q$, sum(x))',
  },
  {
    // The "allowed" side under the same distortion: the literal is eaten and
    // nothing is summed, so the statement must still pass. Without this case
    // the three above could be satisfied by a removal that refuses everything.
    what: 'CONTROL: the same literal distortion with no sum anywhere is still allowed',
    text: "SELECT invoice_outstanding(')', $2)",
    names: ['invoice_outstanding', 'customer_ar_outstanding'],
    mustRefuse: false,
    remainder: "SELECT '', $2)",
  },
];
