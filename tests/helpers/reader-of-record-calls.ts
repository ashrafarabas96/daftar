/**
 * Stripping the reader-of-record CALLS out of a statement, so what is left is
 * the statement's OWN arithmetic.
 *
 * This is the machine behind the P4-AL-07 gate in
 * `tests/performance/receivables-s4-budgets.test.ts`: the gate removes every
 * call to a reader of record from a captured statement and then refuses a
 * `sum(` in what remains, because a sum that survives the removal is a SECOND
 * copy of money arithmetic outside the product's own reader.
 *
 * It lives here, out of the performance suite, because that suite needs a
 * cluster and a dataset to run at all — so the machine itself could never be
 * controlled there. Here it is a pure function over a string, and
 * `tests-unit/l3-reader-of-record-call-strip.test.ts` holds it, including the
 * defect this replaces: `\(([^)]*)\)` stops at the FIRST `)`, so a call whose
 * arguments carry a parenthesis was only partly removed and the remainder was
 * read as the statement's own arithmetic.
 */

/**
 * The reader names are PASSED IN: the gate derives them by closure over the
 * Phase 4 DDL, and a second hand-kept copy of that list here is exactly the
 * kind of list P4-AL-88 refuses.
 */
export function stripReaderOfRecordCalls(text: string, readers: readonly string[]): string {
  if (readers.length === 0) return text;
  const head = new RegExp(String.raw`\b(?:public\.)?(?:${readers.join('|')})\s*\(`, 'gi');
  let out = '';
  let cursor = 0;
  for (;;) {
    head.lastIndex = cursor;
    const m = head.exec(text);
    if (m === null) break;
    const openAt = m.index + m[0].length - 1; // the '(' the name opened
    const close = matchingParen(text, openAt);
    out += text.slice(cursor, m.index);
    if (close === -1) {
      // An UNTERMINATED call: the opener is kept with everything after it, and
      // nothing is removed. A truncated capture must not read as a clean
      // strip, because that is how a half-captured statement would look
      // compliant.
      out += text.slice(m.index);
      return out;
    }
    cursor = close + 1;
  }
  return out + text.slice(cursor);
}

/**
 * The index of the `)` that closes the `(` at `openAt`, or -1 when the text
 * has none. Parens inside a single-quoted literal do not count, and `''` is
 * the SQL escape for a quote inside one.
 */
function matchingParen(text: string, openAt: number): number {
  let depth = 0;
  let inLiteral = false;
  for (let i = openAt; i < text.length; i += 1) {
    const ch = text[i];
    if (inLiteral) {
      if (ch === "'") {
        if (text[i + 1] === "'") i += 1;
        else inLiteral = false;
      }
      continue;
    }
    if (ch === "'") {
      inLiteral = true;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}
