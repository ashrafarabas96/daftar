/**
 * A refusal never carries money — as a law over `errors.ts`, because no
 * runtime case can state it.
 *
 * ── Why a source law and not a behavioural one ──────────────────────────
 *
 * Every suite in this package asserts the SAFE JSON of the refusals it
 * provokes, and none of them carries an amount. But that is a fact about the
 * refusals that exist today. The mutation that matters is adding
 * `readonly amountMinor?: bigint` to `BillingErrorContext`: it leaks nothing
 * by itself, so every behavioural case stays green, and it is a widening that
 * the next refusal — written months later by someone reading the type as
 * permission — turns into the leak. A mutation harness showed exactly that:
 * the field was added and twelve cases passed.
 *
 * So the subject here is the TYPE's field list. `BillingErrorContext` is a
 * closed shape on purpose, and this suite is what makes the shape closed in
 * fact: a field whose name is money-shaped reds, and so does a field whose
 * type is `bigint`, which in this package is only ever used for minor units.
 *
 * The field list is read with the shared blanker, so the paragraph above the
 * interface — which names `amountMinor`, `priceMinor` and `providerPayload`
 * as the fields that must never exist — is prose and not program.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blankOut } from './helpers/lexer';
import { BillingError } from '../src/errors';

const ERRORS = readFileSync(join(__dirname, '..', 'src', 'errors.ts'), 'utf8');

/** The declared fields of one interface, as `[name, type]`, from code only. */
function interfaceFields(source: string, name: string): Array<readonly [string, string]> {
  const code = blankOut(source);
  const at = code.indexOf(`export interface ${name} {`);
  expect(at, `${name} was not found in errors.ts`).toBeGreaterThan(-1);
  const open = code.indexOf('{', at);
  let depth = 0;
  let close = -1;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  expect(close, `${name} has no closing brace`).toBeGreaterThan(open);
  const body = code.slice(open + 1, close);
  return members(body);
}

/**
 * The members of an interface body, split at depth 0 and then read.
 *
 * NOT a regex over the whole body, and the reason is measured rather than
 * stylistic: the regex this replaced -- `readonly name?: type;` on one line --
 * returned the EMPTY list for a member that omits `readonly`, for a type that
 * spans lines and for a member separated by a line break, each of which can
 * carry `amountMinor?: bigint` past all three absence laws below in silence.
 * `readonly` is a MODIFIER; omitting it is legal TypeScript and was invisible
 * to a law whose entire subject is the field list. The two `RED:` cases at the
 * end of this file hold that reach, and they fail on the old reader.
 *
 * THE DECLARED LIMIT: splitting at depth 0 means a member is read as far as
 * the first top-level `;`, `,` or line break, so the TYPE of a member written
 * across lines is read joined into one line, and a nested object type stays
 * with the member it belongs to rather than being read as more members. What
 * this does NOT parse is TypeScript: an index signature, a call signature or a
 * method declaration is not of the form `name: type` and is skipped, which is
 * why the allowlist case below reads NAMES -- a member this reader cannot name
 * is a member no field of the refusal context may be declared as.
 */
/** One declared member's shape: used to READ one, and to decide a line break ends one. */
const MEMBER = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*:\s*([\s\S]+)$/;

function members(body: string): Array<readonly [string, string]> {
  const chunks: string[] = [];
  let current = '';
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] as string;
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === '<') depth++;
    // `=>` ends no generic: its `>` must not close one that was never opened.
    else if (ch === '>' && body[i - 1] !== '=') depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === ';' || ch === ',')) {
      chunks.push(current);
      current = '';
      continue;
    }
    if (depth === 0 && ch === '\n') {
      // THREE ANSWERS FOR A LINE BREAK, and each one is measured by a case
      // at the end of this file:
      //
      //  * it CONTINUES a declaration -- the text so far ends on a token
      //    that cannot end one, or the next line opens with one -- so a
      //    union written a branch per line stays ONE member, and the half
      //    of the type the `bigint` law looks for is not dropped;
      //  * it ENDS a member, when what has been read already IS one, which
      //    is how a member written without a `;` is read at all;
      //  * otherwise it DISCARDS, because a line that declares no member
      //    and continues none is not part of one. This is the blanked
      //    comment lines between the real fields: keeping them made the
      //    member AFTER each one unreadable, and the field list collapsed
      //    from twelve to four -- measured, which is how this rule was
      //    found rather than guessed.
      const trimmed = current.trim();
      const endsOpen = /(?:[:|&,(<]|=>)$/.test(trimmed);
      const nextOpens = /^[ \t]*[|&)\]}>=?:,]/.test(body.slice(i + 1));
      if (endsOpen || nextOpens) {
        current += ' ';
        continue;
      }
      if (MEMBER.test(current)) chunks.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  chunks.push(current);
  const read: Array<readonly [string, string]> = [];
  for (const chunk of chunks) {
    const m = MEMBER.exec(chunk);
    if (m) read.push([m[1] as string, (m[2] as string).trim().replace(/\s+/g, ' ')] as const);
  }
  return read;
}

const CONTEXT_FIELDS = interfaceFields(ERRORS, 'BillingErrorContext');

/** A name that denotes a value rather than an identifier. */
const MONEY_NOUN = /(amount|price|minor|total|balance|charge|credit|tax|sum|value|payload|body|rate|fee|cost)/i;

/**
 * The two offence sets, as ONE function each, called by the laws below AND by
 * their controls. A control that restated either filter would certify its own
 * copy of it rather than the one the law runs.
 */
const moneyNounOffences = (fields: Array<readonly [string, string]>): string[] => fields.filter(([n]) => MONEY_NOUN.test(n)).map(([n, ty]) => `${n}: ${ty}`);
const bigintOffences = (fields: Array<readonly [string, string]>): string[] => fields.filter(([, ty]) => /\bbigint\b/.test(ty)).map(([n, t2]) => `${n}: ${t2}`);

describe('BillingErrorContext is a closed shape that holds no money', () => {
  it('reads the field list from code, not from the prose above it', () => {
    // Non-vacuity, and the reason the blanker is here: the comment above the
    // interface names the three forbidden fields by name, so an unstripped
    // scan would red on the documentation of this very rule.
    expect(CONTEXT_FIELDS.length).toBeGreaterThanOrEqual(10);
    expect(CONTEXT_FIELDS.map(([n]) => n)).toContain('businessId');
    expect(CONTEXT_FIELDS.map(([n]) => n)).toContain('invariant');
    expect(ERRORS).toContain('amountMinor');
    expect(CONTEXT_FIELDS.map(([n]) => n)).not.toContain('amountMinor');
  });

  it('has no field whose name denotes a value', () => {
    expect(moneyNounOffences(CONTEXT_FIELDS), 'a field that denotes a value was added to the refusal context').toEqual([]);
  });

  it('has no field typed bigint — in this package a bigint is minor units', () => {
    expect(bigintOffences(CONTEXT_FIELDS), 'a bigint reached the refusal context').toEqual([]);
  });

  it('matches its own noun pattern (the detector is live)', () => {
    expect(MONEY_NOUN.test('amountMinor')).toBe(true);
    expect(MONEY_NOUN.test('priceMinor')).toBe(true);
    expect(MONEY_NOUN.test('providerPayload')).toBe(true);
    expect(MONEY_NOUN.test('totalMinor')).toBe(true);
    // And the fields that legitimately exist are not caught.
    for (const n of [
      'businessId',
      'planKey',
      'planVersionId',
      'addOnKey',
      'limitKey',
      'at',
      'periodIndex',
      'currency',
      'lineNo',
      'attemptNo',
      'providerRef',
      'invariant',
    ]) {
      expect(MONEY_NOUN.test(n), `${n} is caught by the pattern but is a legitimate field`).toBe(false);
    }
  });

  it('every field it does declare is an identifier, a code, an index or a count', () => {
    // Stated as an allowlist so adding a field is a deliberate act with a
    // category, rather than a line that passes because nobody named it.
    const ALLOWED = new Set([
      'businessId',
      'planKey',
      'planVersionId',
      'addOnKey',
      'limitKey',
      'at',
      'periodIndex',
      'currency',
      'lineNo',
      'attemptNo',
      'providerRef',
      'invariant',
    ]);
    const unknown = CONTEXT_FIELDS.map(([n]) => n).filter((n) => !ALLOWED.has(n));
    expect(unknown, 'a field was added to the refusal context without a category').toEqual([]);
  });

  /**
   * THE READER'S OWN REACH, which the three absence laws above all depend on
   * and none of them measured. They read ONE field list, and a member the
   * reader cannot see is a member every one of them passes over in silence --
   * which is the mutation this file was written to catch, arriving in a shape
   * the detector never looked at. Measured on the reader this file had before
   * these two cases, a regex for `readonly name?: type;` on one line, each of
   * these returned the EMPTY list:
   *
   *   amountMinor?: bigint;          -- `readonly` is a MODIFIER, not a
   *                                     declaration, and omitting it is legal
   *   readonly providerPayload?: {   -- a type that spans lines
   *     a: string;
   *   };
   *   readonly amountMinor?: bigint  -- a member separated by a line break
   *
   * So the law held only for a money field written in one particular style,
   * and said nothing about the same field written in three others.
   */
  it('RED: the reader sees a money member in every shape a declaration may take', () => {
    const shapes: Array<readonly [string, string]> = [
      ['no readonly', 'export interface Probe {\n  readonly businessId?: string;\n  amountMinor?: bigint;\n}\n'],
      ['a type that spans lines', 'export interface Probe {\n  readonly businessId?: string;\n  readonly amountMinor?:\n    | bigint\n    | undefined;\n}\n'],
      ['no semicolon', 'export interface Probe {\n  readonly businessId?: string\n  readonly amountMinor?: bigint\n}\n'],
      ['inside a generic', 'export interface Probe {\n  readonly businessId?: string;\n  readonly amountMinor?: Record<string, bigint>;\n}\n'],
      // The DISCARD branch of the line-break rule, and the one that was
      // measured wrong first: a comment line between two members. Keeping
      // it made the member AFTER it unreadable, and the real field list
      // collapsed from twelve to four.
      [
        'after a comment line',
        'export interface Probe {\n  readonly businessId?: string;\n  /** A doc comment, which is prose. */\n  amountMinor?: bigint;\n}\n',
      ],
    ];
    for (const [shape, source] of shapes) {
      const fields = interfaceFields(source, 'Probe');
      expect(
        fields.map(([n]) => n),
        `${shape}: the member is INVISIBLE to the reader, so every law above passes over it`,
      ).toContain('amountMinor');
      // And the field the shape also declares is still read, so a reader that
      // returned every identifier it saw would not satisfy this either.
      expect(
        fields.map(([n]) => n),
        `${shape}: the ordinary member was lost`,
      ).toContain('businessId');
      // And the TYPE is read whole. The bigint law reads the type, so a
      // type truncated at a line break or at a generic's comma would hide
      // the one word it looks for while the member itself was seen.
      const ty = fields.find(([n]) => n === 'amountMinor')?.[1] ?? '';
      expect(ty, `${shape}: the member was seen but its type was truncated, so the bigint law reads a different string than was declared`).toMatch(
        /\bbigint\b/,
      );
    }
  });

  it('RED: and the two offence sets above name such a member rather than returning empty', () => {
    const fields = interfaceFields('export interface Probe {\n  readonly businessId?: string;\n  amountMinor?: bigint;\n}\n', 'Probe');
    expect(moneyNounOffences(fields), 'the noun law does not name the money member').toStrictEqual(['amountMinor: bigint']);
    expect(bigintOffences(fields), 'the bigint law does not name the money member').toStrictEqual(['amountMinor: bigint']);
    // The negative control of the same two calls, on the real field list: the
    // offence sets are not simply always non-empty.
    expect(
      [...moneyNounOffences(CONTEXT_FIELDS), ...bigintOffences(CONTEXT_FIELDS)],
      'the real context is reported as an offence, so these two answer the same way whatever they are given',
    ).toStrictEqual([]);
  });

  it('toSafeJSON carries the code and the context, and nothing else', () => {
    // The one behavioural half: the representation does not reach for
    // `message`, `stack` or `name`, each of which can hold anything.
    const e = new BillingError('billing.invariant_violated', 'a message that must not travel', { businessId: 'b1', invariant: 'x' });
    expect(e.toSafeJSON()).toEqual({ code: 'billing.invariant_violated', businessId: 'b1', invariant: 'x' });
    expect(Object.keys(e.toSafeJSON()).sort()).toEqual(['businessId', 'code', 'invariant']);
    expect(JSON.stringify(e.toSafeJSON())).not.toContain('must not travel');
  });
});
