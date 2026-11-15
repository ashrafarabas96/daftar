/**
 * A length-preserving source blanker, shared by every text law in this package.
 *
 * ── Why this exists, and why it is not inside one of the test files ─────
 *
 * Because a text law over raw source is satisfied by a comment. P4-S7's H6
 * order law was `SPEC.indexOf` over unstripped source, and a planted comment
 * satisfied it while 94 cases passed. Three laws in this package now need the
 * same defence — the admin-authority law, the §21 meter law's siblings, and
 * the §20 "no hard-coded price" scan — and a lexer living in one test file
 * would have to be imported FROM a test file, which re-executes that file's
 * cases. So it lives here, and `test/lexer.test.ts` holds its fixtures.
 */
/**
 * Replace the CONTENTS of comments, string literals, template literals and
 * regular-expression literals with spaces, preserving the source's length and
 * line structure so an offset in the result is an offset in the original.
 *
 * Delimiters are kept, so `'x'` becomes `' '` and `// y` becomes `//  `. That
 * is what lets a later scan still see that a string was there without being
 * able to read what was in it.
 *
 * The regex-literal state is the one that matters and the one that is usually
 * missing: a `/…/` containing an apostrophe flips quote parity for everything
 * after it, and both the blanked and the unblanked view still return a
 * correct-LENGTH string, so the damage is invisible to a length check.
 */
export function blankOut(source: string): string {
  const out = source.split('');
  let i = 0;
  /** The last significant character, for the regex-or-division decision. */
  let lastSignificant = '';
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      let j = i + 2;
      while (j < source.length && source[j] !== '\n') j++;
      blank(i + 2, j);
      i = j;
      continue;
    }
    if (c === '/' && next === '*') {
      let j = i + 2;
      while (j < source.length && !(source[j] === '*' && source[j + 1] === '/')) j++;
      blank(i + 2, j);
      i = Math.min(j + 2, source.length);
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === c) break;
        j++;
      }
      blank(i + 1, j);
      lastSignificant = c;
      i = Math.min(j + 1, source.length);
      continue;
    }
    if (c === '/') {
      // Division or a regex literal. A `/` starts a regex unless the previous
      // significant character could end an expression — an identifier
      // character, a closing bracket, or a quote (a completed literal).
      const dividable = /[A-Za-z0-9_$)\]'"`]/.test(lastSignificant);
      if (!dividable) {
        let j = i + 1;
        let inClass = false;
        while (j < source.length) {
          const d = source[j];
          if (d === '\\') {
            j += 2;
            continue;
          }
          if (d === '\n') break; // an unterminated regex; stop rather than eat the file
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) break;
          j++;
        }
        blank(i + 1, j);
        lastSignificant = '/';
        i = Math.min(j + 1, source.length);
        continue;
      }
    }
    if (!/\s/.test(c ?? '')) lastSignificant = c ?? '';
    i++;
  }
  return out.join('');
}

/**
 * The string-literal BODIES of a source file, comments excluded.
 *
 * Built on `blankOut` rather than on a second walk, so there is one lexer in
 * this package and one set of fixtures for it. The trick is that blanking is
 * offset-preserving and blanks the bodies of comments, strings and regex
 * literals alike: therefore any quote character still present in the BLANKED
 * text is necessarily a real string delimiter, and the text between a pair of
 * them in the ORIGINAL is that string's body. A quote inside a comment, or
 * inside another string, or inside a regex, is a space by then.
 */
export function stringLiteralsOf(source: string): string[] {
  const blanked = blankOut(source);
  const out: string[] = [];
  let i = 0;
  while (i < blanked.length) {
    const c = blanked[i];
    if (c === "'" || c === '"' || c === '`') {
      const close = blanked.indexOf(c, i + 1);
      if (close === -1) break;
      out.push(source.slice(i + 1, close));
      i = close + 1;
      continue;
    }
    i++;
  }
  return out;
}

/**
 * The numeric and bigint literals that appear in CODE, comments and string
 * contents excluded — which is the whole point: §20 is about a number the
 * program can use, and a number in a comment is prose.
 */
export function numericLiteralsOf(source: string): string[] {
  return [...blankOut(source).matchAll(/\b\d[\d_]*(?:\.\d+)?n?\b/g)].map((m) => m[0]);
}
