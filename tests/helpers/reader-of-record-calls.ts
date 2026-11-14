/**
 * Removing the reader-of-record CALLS from a captured statement, so the P4-D
 * money law can refuse a `sum(` in what the statement itself wrote.
 *
 * What is removed is the call's NAME and its two parentheses -- NOT what sits
 * between them. The arguments stay in the scanned text on purpose: a statement
 * that writes `sum(i.total_minor)` is summing money itself whether the result
 * goes to the client or into a reader's argument list, and the law's verdict on
 * that shape must not change because the removal got smarter. Removing the
 * whole call, parens and body, would make the law accept exactly that shape,
 * which is a WEAKENING of a money law and is why this file does not do it.
 *
 * Nested reader calls inside the arguments are still removed: the scan
 * continues just after the opening paren rather than skipping past the close.
 */
export function stripReaderOfRecordCalls(text: string, readers: readonly string[]): string {
  if (readers.length === 0) return text;
  const head = new RegExp(String.raw`\b(?:public\.)?(?:${readers.join('|')})\s*\(`, 'gi');
  const drop = new Set<number>();
  let cursor = 0;
  for (;;) {
    head.lastIndex = cursor;
    const m = head.exec(text);
    if (m === null) break;
    const openAt = m.index + m[0].length - 1; // the '(' the name opened
    const close = matchingParen(text, openAt);
    if (close === -1) {
      // An UNTERMINATED call: nothing from this point on is removed. A
      // truncated capture must not read as a clean strip, because that is how
      // a half-captured statement would look compliant.
      break;
    }
    for (let i = m.index; i <= openAt; i += 1) drop.add(i);
    drop.add(close);
    cursor = openAt + 1;
  }
  if (drop.size === 0) return text;
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    if (!drop.has(i)) out += text[i];
  }
  return out;
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
