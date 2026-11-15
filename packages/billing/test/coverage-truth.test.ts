/**
 * "THE HISTORICAL 215 IS NOT FULL PRODUCT COVERAGE" — Master Continuous
 * Mission §12, made checkable instead of merely conceded.
 *
 * Line and branch coverage are UNMEASURED for this package and this file
 * does not pretend otherwise. No coverage provider is installed, and
 * installing one means adding a dependency to the root `package.json` and
 * `package-lock.json`, which belong to the Repo Owner and not to this
 * thread — the same reason `PATCH-REQ-P5-001` is a request and not an
 * edit. `NODE_V8_COVERAGE` was tried, needs no dependency at all, and
 * produced nothing usable: Vitest evaluates test modules through its own
 * module runner, so V8 attributes the executed ranges to the runner and
 * not to `src/*.ts`. That attempt is recorded in
 * `P5-COVERAGE-TRUTH.md` rather than left as an assumption.
 *
 * What CAN be measured without tooling is weaker than coverage in one way
 * and stronger in another: it cannot say which branches ran, but it can
 * say that no exported symbol is unexercised and that a green run of one
 * lane is not quotable for the other lane's claims. Both are asserted
 * below. The eleven product surfaces the mission lists — DB, RLS, API,
 * permissions, provider limits, the merchant portal, localization,
 * browser, security, concurrency, CI — are enumerated with an evidence
 * class each in `P5-COVERAGE-TRUTH.md`; a test cannot assert a document.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { priceAddOn } from '../src/addons';
import { ADDON_KINDS } from '../src/addons';
import { decideDunning, DUNNING_OUTCOMES } from '../src/dunning';
import { FAKE_BEHAVIOURS, FakePaymentProvider } from '../src/fake-provider';
import { billingPeriodAt } from '../src/period';
import { BillingError, refuse } from '../src/errors';
import { BILLING_INTERVALS } from '../src/types';
import { blankOut } from './helpers/lexer';

const SRC = join(__dirname, '..', 'src');
const TEST = join(__dirname);

/**
 * The names a module exports as VALUES. Types are excluded on purpose: a
 * type cannot be executed, so "a type no test mentions" is not an
 * untested behaviour and counting it would inflate the number this file
 * exists to keep honest.
 */
function exportedValues(source: string): readonly string[] {
  const names: string[] = [];
  for (const m of source.matchAll(/^export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z0-9_]+)/gm)) {
    const name = m[1];
    if (name !== undefined) names.push(name);
  }
  return names;
}

/**
 * The test sources, BLANKED — their comments and string literals replaced with
 * spaces, so a name that appears only in prose does not count as exercised.
 *
 * MEASURED, and it found a live one. Read raw, this law's own arm below was
 * satisfied for `refuse` — the function EVERY refusal in this package is
 * thrown through — because its only occurrences across all test sources were
 * the assertion message "the call was expected to refuse and did not" and two
 * comments. Nothing named the function. The arm at line 130 of this file
 * already says "a text law satisfied by a comment is this project's most
 * repeated defect", and the arm above it was that law. So the probe that found
 * it is also recorded: of 47 exported values, exactly ONE matched the raw
 * sources and not the blanked ones, and it was `errors.ts:refuse`.
 */
function readAllTestSources(): string {
  const parts: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        walk(join(dir, e.name));
        continue;
      }
      if (e.name.endsWith('.ts')) parts.push(readFileSync(join(dir, e.name), 'utf8'));
    }
  };
  walk(TEST);
  return blankOut(parts.join('\n'));
}

describe('the extractor is not vacuous', () => {
  it('finds exported functions, consts and classes, and ignores exported types', () => {
    const found = exportedValues(
      [
        'export function alpha(): void {}',
        'export async function beta(): Promise<void> {}',
        'export const gamma = 1;',
        'export class Delta {}',
        'export interface Epsilon { a: 1 }',
        'export type Zeta = 1;',
        '  export function notAtLineStart(): void {}',
      ].join('\n'),
    );
    expect([...found].sort()).toEqual(['Delta', 'alpha', 'beta', 'gamma']);
    expect(found).toContain('alpha');
    expect(found).toContain('beta');
    expect(found).toContain('gamma');
    expect(found).toContain('Delta');
    expect(found).not.toContain('Epsilon');
    expect(found).not.toContain('Zeta');
    expect(found).not.toContain('notAtLineStart');
  });
});

/**
 * The exports no test names, as `file:name`. ONE function, called by the arm
 * below AND by its control: a control that restated this loop would certify
 * its own copy of it rather than the one the law runs.
 */
function unexercisedIn(tests: string): string[] {
  const unexercised: string[] = [];
  for (const file of readdirSync(SRC)) {
    if (!file.endsWith('.ts')) continue;
    for (const name of exportedValues(readFileSync(join(SRC, file), 'utf8'))) {
      if (!new RegExp(`\\b${name}\\b`).test(tests)) unexercised.push(`${file}:${name}`);
    }
  }
  return unexercised;
}

describe('no exported value of this package is unexercised', () => {
  it('every exported function, const and class is named by at least one test file', () => {
    // Named, not counted: a non-empty list of names is a defect report,
    // while "0 unexercised exports" is a number that could be produced by
    // an extractor that found nothing.
    expect(unexercisedIn(readAllTestSources())).toEqual([]);
  });

  it('RED: a name that appears only in prose is NOT read as exercised', () => {
    // The control of the blanking, and of the arm above, in one: a source in
    // which every export name occurs ONLY inside a comment and a string must
    // report them ALL unexercised. Read raw, this answer was `[]` and the law
    // was satisfied by prose -- which is how `refuse` passed.
    const prose = ['// priceAddOn decideDunning billingPeriodAt refuse', "const why = 'ADDON_KINDS BILLING_INTERVALS DUNNING_OUTCOMES FAKE_BEHAVIOURS';"].join(
      '\n',
    );
    const named = unexercisedIn(blankOut(prose));
    expect(named.length, 'a file of pure prose exercises nothing, so every export must be reported').toBeGreaterThan(25);
    expect(named.join(' '), 'and the report names the export that provoked this case').toContain('errors.ts:refuse');
    // SIGHTED, and this is the half that makes the answer above mean
    // something: the same names written as CODE are not reported.
    const asCode = unexercisedIn(blankOut('const used = [priceAddOn, decideDunning, billingPeriodAt, refuse];'));
    expect(asCode, 'a name written as code is still reported unexercised, so this reader answers the same way whatever it is given').not.toContain(
      'errors.ts:refuse',
    );
    // AND the arm's own input is the executable half. The two answers above
    // blank their input at the call site, so they would not notice if
    // `readAllTestSources` stopped blanking -- and that change is invisible on
    // today's tree, because `refuse` is now named in code as well. So the
    // input is read directly, on the exact message that excused `refuse`:
    const read = readAllTestSources();
    expect(read, 'an assertion MESSAGE survived into the arm input, so the arm is reading prose again').not.toContain(
      'the call was expected to refuse and did not',
    );
    // SIGHTED: and it did not blank everything, which would also satisfy the
    // line above while making the arm vacuous.
    expect(read, 'the executable text is gone from the arm input').toContain('unexercisedIn(');
  });

  it('and there are enough of them for that to mean something', () => {
    let n = 0;
    for (const file of readdirSync(SRC)) {
      if (file.endsWith('.ts')) n += exportedValues(readFileSync(join(SRC, file), 'utf8')).length;
    }
    // A guard against the arm above passing because the extractor broke.
    expect(n).toBeGreaterThan(25);
  });
});

describe('a green run of one lane is not quotable for the other', () => {
  it('the pure config excludes the database lane, and the database config is the only one that includes it', () => {
    const pure = readFileSync(join(__dirname, '..', 'vitest.config.ts'), 'utf8');
    const db = readFileSync(join(__dirname, '..', 'vitest.db.config.ts'), 'utf8');
    expect(pure).toMatch(/exclude:\s*\['test\/db\/\*\*'\]/);
    expect(db).toMatch(/include:\s*\['test\/db\/\*\*\/\*\.test\.ts'\]/);
    // Asserted over BLANKED source, so the word "exclude" in either
    // config's own prose cannot satisfy or break the law. A text law
    // satisfied by a comment is this project's most repeated defect.
    const dbExecutable = blankOut(db);
    expect(dbExecutable).not.toMatch(/exclude\s*:/);
    // SIGHTED, and this is the half the line above cannot supply itself: a
    // blanker that returned nothing -- or that stopped being called on a view
    // this case then re-derived -- satisfies a `not.toMatch` for free. So the
    // same view is asserted to STILL CARRY the executable text this config is
    // read for. A negative assertion over a TRANSFORMED input cannot detect
    // that the transform stopped; only a positive one on the same view can.
    // MEASURED, not assumed: the blanker blanks STRING CONTENTS too, so the
    // path inside `include: [...]` is spaces in this view and only the KEY
    // is still code. That is what is asserted -- the raw-text assertions
    // above already hold the path itself.
    expect(dbExecutable, 'the blanked view carries no `include:` key, so the absence above is vacuous').toMatch(/include:\s*\[/);
  });

  it('and no pure test file reaches for a database', () => {
    const offenders: string[] = [];
    for (const e of readdirSync(TEST, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith('.ts')) continue;
      // Blanked, because THIS file names the patterns it forbids and
      // would otherwise report itself.
      const src = blankOut(readFileSync(join(TEST, e.name), 'utf8'));
      if (/\bfrom\s+'pg'|require\(\s*'pg'\s*\)/.test(src)) offenders.push(e.name);
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * The four exported union constants the law above found unexercised.
 *
 * They were exercised BEHAVIOURALLY all along — a test passing
 * `kind: 'nope'` and getting a refusal runs the `includes` check that
 * reads them — but none of them was named, so nothing pinned the exported
 * array to the set its validator actually enforces. A public constant
 * that drifts from the validator beside it is a real defect class: a
 * consumer branches on `ADDON_KINDS` and the package accepts, or refuses,
 * something else. These cases close that, both directions, which is also
 * why the law above needs no allowlist.
 */
describe('each exported union constant is the set its validator enforces', () => {
  it('ADDON_KINDS', () => {
    expect([...ADDON_KINDS]).toEqual(['flat', 'per_unit']);
    for (const kind of ADDON_KINDS) {
      expect(() =>
        priceAddOn(
          { key: 'seats', kind, quantity: 1, unitPrice: { amountMinor: 100n, currency: 'USD' } },
          { startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2026-02-01T00:00:00.000Z' },
          [],
        ),
      ).not.toThrow(/addon_kind_unknown/);
    }
    expect(() =>
      priceAddOn(
        // A value outside the constant must be refused, so the constant is
        // the boundary and not a label beside one.
        { key: 'seats', kind: 'tiered' as never, quantity: 1, unitPrice: { amountMinor: 100n, currency: 'USD' } },
        { startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2026-02-01T00:00:00.000Z' },
        [],
      ),
    ).toThrow();
  });

  it('BILLING_INTERVALS', () => {
    expect([...BILLING_INTERVALS]).toEqual(['month', 'year']);
    for (const interval of BILLING_INTERVALS) {
      expect(() => billingPeriodAt({ anchorAt: '2026-01-01T00:00:00.000Z', interval }, '2026-01-15T00:00:00.000Z')).not.toThrow();
    }
    expect(() => billingPeriodAt({ anchorAt: '2026-01-01T00:00:00.000Z', interval: 'week' as never }, '2026-01-15T00:00:00.000Z')).toThrow();
  });

  it('DUNNING_OUTCOMES', () => {
    // `unknown` joined the set in round 6: a provider that accepted the
    // charge and lost the response. `declined` joined it in round 8, for the
    // challenger's F-02: it was already in `CHARGE_OUTCOMES`, in the fake
    // provider and in the DDL, and its absence HERE meant the authority
    // refused the commonest card outcome outright. This pin is what made the
    // gap visible once it was closed — and, until round 8, what locked it in
    // place. A pin states the set; it does not state that the set is right,
    // which is why `dunning.test.ts` now also asserts that every
    // `ChargeOutcome` is a member.
    expect([...DUNNING_OUTCOMES]).toEqual(['succeeded', 'declined', 'failed', 'unknown']);
    const policy = { retryOffsetHours: [24, 48], graceHours: 72 } as const;
    const input = (outcome: (typeof DUNNING_OUTCOMES)[number] | 'pending') => ({
      policy,
      periodEndsAt: '2026-01-01T00:00:00.000Z',
      attempts: [{ attemptedAt: '2026-01-02T00:00:00.000Z', outcome: outcome as never }],
      asOf: '2026-01-03T00:00:00.000Z',
      storedState: 'past_due' as const,
    });
    for (const outcome of DUNNING_OUTCOMES) {
      expect(() => decideDunning(input(outcome))).not.toThrow();
    }
    expect(() => decideDunning(input('pending'))).toThrow();
  });

  /**
   * And `refuse` itself, which the arm above found unexercised the moment it
   * stopped reading prose. It is the fifth entry of the list this `describe`
   * opens with, for the same reason as the other four: it was exercised
   * BEHAVIOURALLY all along -- every refusal in this package is thrown through
   * it -- and NAMED nowhere, so nothing held the one function that turns a
   * code and a context into the exception a client sees. It is exercised here
   * rather than excused in an allowlist, which is what keeps the arm above
   * free of one.
   */
  it('refuse', () => {
    let caught: unknown;
    try {
      refuse('billing.invariant_violated', 'a message that must not travel', { businessId: 'b1', invariant: 'x' });
    } catch (e) {
      caught = e;
    }
    expect(caught, 'refuse returned instead of throwing').toBeInstanceOf(BillingError);
    const error = caught as BillingError;
    expect(error.code).toBe('billing.invariant_violated');
    // The context travels and the message does NOT, which is the whole of what
    // this function is for.
    expect(error.toSafeJSON()).toEqual({ code: 'billing.invariant_violated', businessId: 'b1', invariant: 'x' });
    expect(JSON.stringify(error.toSafeJSON())).not.toContain('must not travel');
    // And its declared default: no context at all is an empty context, not a
    // thrown reader.
    expect(() => refuse('billing.invariant_violated', 'm')).toThrow(BillingError);
  });

  it('FAKE_BEHAVIOURS', () => {
    expect([...FAKE_BEHAVIOURS]).toEqual(['succeed', 'decline', 'fail', 'unavailable', 'accept_then_lose']);
    for (const behaviour of FAKE_BEHAVIOURS) {
      expect(() => new FakePaymentProvider({ defaultBehaviour: behaviour })).not.toThrow();
      expect(() => new FakePaymentProvider({ byInstrument: { card: behaviour } })).not.toThrow();
    }
    expect(() => new FakePaymentProvider({ defaultBehaviour: 'explode' as never })).toThrow();
    expect(() => new FakePaymentProvider({ byInstrument: { card: 'explode' as never } })).toThrow();
  });
});
