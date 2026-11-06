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
  return [...body.matchAll(/readonly\s+([A-Za-z_$][\w$]*)\s*\??\s*:\s*([^;\n]+);/g)].map((m) => [m[1] as string, (m[2] as string).trim()] as const);
}

const CONTEXT_FIELDS = interfaceFields(ERRORS, 'BillingErrorContext');

/** A name that denotes a value rather than an identifier. */
const MONEY_NOUN = /(amount|price|minor|total|balance|charge|credit|tax|sum|value|payload|body|rate|fee|cost)/i;

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
    const offences = CONTEXT_FIELDS.filter(([n]) => MONEY_NOUN.test(n)).map(([n, t]) => `${n}: ${t}`);
    expect(offences, 'a field that denotes a value was added to the refusal context').toEqual([]);
  });

  it('has no field typed bigint — in this package a bigint is minor units', () => {
    const offences = CONTEXT_FIELDS.filter(([, t]) => /\bbigint\b/.test(t)).map(([n, t]) => `${n}: ${t}`);
    expect(offences, 'a bigint reached the refusal context').toEqual([]);
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

  it('toSafeJSON carries the code and the context, and nothing else', () => {
    // The one behavioural half: the representation does not reach for
    // `message`, `stack` or `name`, each of which can hold anything.
    const e = new BillingError('billing.invariant_violated', 'a message that must not travel', { businessId: 'b1', invariant: 'x' });
    expect(e.toSafeJSON()).toEqual({ code: 'billing.invariant_violated', businessId: 'b1', invariant: 'x' });
    expect(Object.keys(e.toSafeJSON()).sort()).toEqual(['businessId', 'code', 'invariant']);
    expect(JSON.stringify(e.toSafeJSON())).not.toContain('must not travel');
  });
});
