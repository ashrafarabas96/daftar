/**
 * The blanker's own fixtures. A blanker nobody tested IS the defect: every
 * text law in this package is only as sound as this function, and the failure
 * mode is silent — a mis-lexed file still yields a correct-LENGTH string, so
 * the laws report "no subject found" rather than "defect found".
 */
import { describe, expect, it } from 'vitest';
import { blankOut } from './helpers/lexer';

describe('blankOut', () => {
  it('preserves length and line structure exactly', () => {
    const src = "const a = 'xy';\n// note\nconst b = 1;\n";
    const out = blankOut(src);
    expect(out.length).toBe(src.length);
    expect(out.split('\n').length).toBe(src.split('\n').length);
  });

  it('blanks a string body but keeps its delimiters', () => {
    expect(blankOut("const a = 'secret';")).toBe("const a = '      ';");
  });

  it('blanks a line comment and a block comment body', () => {
    expect(blankOut('a; // hide')).toBe('a; //     ');
    expect(blankOut('a; /* hide */ b;')).toBe('a; /*      */ b;');
  });

  it('survives a REGEX LITERAL CONTAINING A QUOTE without inverting parity for the rest of the file', () => {
    // The exact shape that once flipped quote parity and made nine laws
    // report "no subject found" instead of "defect found".
    const src = "const r = /\\bfrom\\s+'([^']+)'/g;\nconst keep = 'visible';\nx.require('k');";
    const out = blankOut(src);
    expect(out.length).toBe(src.length);
    // The code after the regex is still CODE: the call is still visible.
    expect(out).toContain('x.require(');
    // And the string after the regex was blanked, not left readable.
    expect(out).not.toContain('visible');
  });

  it('treats a division as division, not as the start of a regex', () => {
    const src = "const q = a / b; x.require('k');";
    expect(blankOut(src)).toContain('x.require(');
  });

  it('does not let an escaped quote end a string early', () => {
    const src = "const a = 'it\\'s'; x.require('k');";
    const out = blankOut(src);
    expect(out).toContain('x.require(');
  });

  it('blanks a template literal body', () => {
    expect(blankOut('const a = `abc`;')).toBe('const a = `   `;');
  });
});
