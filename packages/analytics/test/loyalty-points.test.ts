/**
 * P13-S6 — tests for the loyalty point folds.
 *
 * The cases follow `P13-LOYALTY-DESIGN` section by section: the balance
 * identity of §1.5, the idempotency invariant of §3.1/§5.5.3, the horizon
 * cases of §4.4 (`T2-EXP-BOUND-1..3`, `T2-EXP-IDEM`, `T2-EXP-ORDER`,
 * `T2-EXP-PARTIAL`, `T2-EXP-ADJUSTED`, `T2-EXP-LEAP`, `T4-EXP-LONG-HORIZON`),
 * and the two-sided transaction boundary of §2.2(d)/§5.5.
 *
 * NAMED RED PROOFS are collected in the last block. Each pairs the real
 * implementation with a deliberately broken one and asserts that the broken
 * one violates the law — `P13-S0 §5`'s canary requirement, so a test that
 * cannot tell them apart is caught rather than trusted.
 */
import { describe, expect, it } from 'vitest';
import {
  addDays,
  appendMovement,
  assertCivilDate,
  buildSaleConsumptionMovement,
  computeEarnedPoints,
  consumptionKindIsRegistered,
  convertPointsToValueMinor,
  divideRounded,
  eligiblePoints,
  emptyLedger,
  foldBalance,
  foldExpiry,
  identityKey,
  LoyaltyRefusal,
  POINTS_DELTA_MAX,
  REGISTERED_KINDS,
  saleConsumptionIdentity,
  saleEarnIdentity,
  tryBuildPostSaleEarnMovement,
  type LoyaltyEarningConfig,
  type LoyaltyLedger,
  type LoyaltyMovementDraft,
  type RoundingMode,
} from '../src/loyalty/points';

/** Indexed access that narrows instead of asserting: the repository forbids the
 *  non-null assertion, and a test that indexes a result should fail loudly on a
 *  missing entry rather than silently compare `undefined`. */
function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`expected ${what} to be present`);
  return value;
}


const BUSINESS = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';

const earn = (id: string, points: bigint, effectiveOn: string, expiresOn: string): LoyaltyMovementDraft => ({
  id,
  businessId: BUSINESS,
  customerId: CUSTOMER,
  movementKind: 'earn',
  sourceType: 'sale',
  sourceId: `sale-${id}`,
  pointsDelta: points,
  expiresOn,
  effectiveOn,
  reason: null,
  correctsId: null,
});

const expire = (id: string, points: bigint, effectiveOn: string): LoyaltyMovementDraft => ({
  id,
  businessId: BUSINESS,
  customerId: CUSTOMER,
  movementKind: 'expire',
  sourceType: 'expiry_sweep',
  sourceId: `sweep-${id}`,
  pointsDelta: -points,
  expiresOn: null,
  effectiveOn,
  reason: null,
  correctsId: null,
});

const adjust = (id: string, delta: bigint, effectiveOn: string, reason = 'merchant goodwill', correctsId: string | null = null): LoyaltyMovementDraft => ({
  id,
  businessId: BUSINESS,
  customerId: CUSTOMER,
  movementKind: 'adjust',
  sourceType: 'manual_adjustment',
  sourceId: `adj-${id}`,
  pointsDelta: delta,
  expiresOn: null,
  effectiveOn,
  reason,
  correctsId,
});

const consume = (id: string, points: bigint, effectiveOn: string, saleId = `sale-${id}`): LoyaltyMovementDraft => ({
  id,
  businessId: BUSINESS,
  customerId: CUSTOMER,
  movementKind: 'consume',
  sourceType: 'sale',
  sourceId: saleId,
  pointsDelta: -points,
  expiresOn: null,
  effectiveOn,
  reason: null,
  correctsId: null,
});

function ledgerOf(...drafts: readonly LoyaltyMovementDraft[]): LoyaltyLedger {
  let ledger = emptyLedger();
  for (const draft of drafts) ledger = appendMovement(ledger, draft).ledger;
  return ledger;
}

const CONFIG: LoyaltyEarningConfig = { pointsPerMinorUnit: { numerator: 1n, denominator: 100n }, horizonDays: 730 };

const committed = (overrides: Partial<Parameters<typeof tryBuildPostSaleEarnMovement>[0]> = {}) =>
  ({
    phase: 'after_sale_commit',
    businessId: BUSINESS,
    customerId: CUSTOMER,
    saleId: 'sale-1',
    businessTransactionId: 'btx-1',
    eligibleBaseMinor: 12345n,
    effectiveOn: '2026-10-12',
    movementId: 'mv-1',
    ...overrides,
  }) as Parameters<typeof tryBuildPostSaleEarnMovement>[0];

/* ================================================================== *
 * §1.5 — the balance fold and its one identity
 * ================================================================== */

describe('foldBalance — §1.5, one definition with no predicate to forget', () => {
  it('holds the identity balance = earned + expired + adjusted + consumed', () => {
    const ledger = ledgerOf(
      earn('e1', 500n, '2026-01-01', '2028-01-01'),
      earn('e2', 250n, '2026-02-01', '2028-02-01'),
      adjust('a1', -40n, '2026-03-01'),
      adjust('a2', 10n, '2026-03-02'),
      consume('c1', 100n, '2026-04-01'),
      expire('x1', 60n, '2026-05-01'),
    );
    const balance = foldBalance(ledger, BUSINESS, CUSTOMER, '2026-12-31');
    expect(balance.earnedPoints).toBe(750n);
    expect(balance.adjustedPoints).toBe(-30n);
    expect(balance.consumedPoints).toBe(-100n);
    expect(balance.expiredPoints).toBe(-60n);
    expect(balance.balancePoints).toBe(560n);
    expect(balance.earnedPoints + balance.expiredPoints + balance.adjustedPoints + balance.consumedPoints).toBe(
      balance.balancePoints,
    );
    expect(balance.movementCount).toBe(6);
  });

  it('is a function of the supplied asOf and reads no clock', () => {
    const ledger = ledgerOf(earn('e1', 500n, '2026-01-01', '2028-01-01'), earn('e2', 250n, '2026-06-01', '2028-06-01'));
    expect(foldBalance(ledger, BUSINESS, CUSTOMER, '2025-12-31').balancePoints).toBe(0n);
    expect(foldBalance(ledger, BUSINESS, CUSTOMER, '2026-01-01').balancePoints).toBe(500n);
    expect(foldBalance(ledger, BUSINESS, CUSTOMER, '2026-05-31').balancePoints).toBe(500n);
    expect(foldBalance(ledger, BUSINESS, CUSTOMER, '2026-06-01').balancePoints).toBe(750n);
  });

  it('answers a positive count and never an absence predicate (§1.3, R22)', () => {
    const balance = foldBalance(emptyLedger(), BUSINESS, CUSTOMER, '2026-10-12');
    expect(balance.movementCount).toBe(0);
    expect(balance.balancePoints).toBe(0n);
    expect(Object.keys(balance)).not.toContain('hasMovements');
  });

  it('refuses an asOf that is not a civil date; there is no clock to fall back to (§4.1)', () => {
    expect(() => foldBalance(emptyLedger(), BUSINESS, CUSTOMER, '12/10/2026')).toThrow(LoyaltyRefusal);
    expect(() => assertCivilDate('2026-02-30', 'asOf')).toThrow(/not a real calendar date/);
    expect(() => assertCivilDate('2026-13-01', 'asOf')).toThrow(LoyaltyRefusal);
    expect(assertCivilDate('2028-02-29', 'asOf')).toBe('2028-02-29');
  });

  it('keeps every digit above Number.MAX_SAFE_INTEGER, because a point count is a bigint', () => {
    const drafts = Array.from({ length: 10 }, (_, i) => earn(`e${i}`, POINTS_DELTA_MAX, '2026-01-01', '2030-01-01'));
    const balance = foldBalance(ledgerOf(...drafts), BUSINESS, CUSTOMER, '2026-01-01');
    expect(balance.balancePoints).toBe(10000000000000000n);
    expect(balance.balancePoints.toString()).toBe('10000000000000000');
    // The red half of the same case: the moment it becomes a Number it is wrong.
    expect(Number.isSafeInteger(Number(balance.balancePoints))).toBe(false);
  });
});

/* ================================================================== *
 * §3.1 / §5.5.3 — idempotency
 * ================================================================== */

describe('appendMovement — §3.1 and §5.5.3, the identity is the invariant', () => {
  it('states the consumption identity as (businessId, sale, saleId, kind) and nothing else', () => {
    const identity = saleConsumptionIdentity(BUSINESS, 'sale-7');
    expect(identity).toEqual({ businessId: BUSINESS, sourceType: 'sale', sourceId: 'sale-7', movementKind: 'consume' });
    // The earn row for the same sale is a different kind, so the two coexist.
    expect(identityKey(identity)).not.toBe(identityKey(saleEarnIdentity(BUSINESS, 'sale-7')));
  });

  it('applying the SAME consumption twice is a no-op on the balance', () => {
    const base = ledgerOf(earn('e1', 1000n, '2026-01-01', '2029-01-01'));
    const draft = consume('c1', 300n, '2026-06-01', 'sale-7');

    const first = appendMovement(base, draft);
    expect(first.outcome).toBe('appended');
    const afterFirst = foldBalance(first.ledger, BUSINESS, CUSTOMER, '2026-12-31');
    expect(afterFirst.balancePoints).toBe(700n);
    expect(afterFirst.movementCount).toBe(2);

    // The replay: the same sale id, the same kind. A different row id and a
    // different effective date do not make it a new fact.
    const second = appendMovement(first.ledger, { ...draft, id: 'c1-retry', effectiveOn: '2026-06-02' });
    expect(second.outcome).toBe('already_present');
    expect(second.movement.id).toBe('c1');
    expect(second.ledger).toBe(first.ledger);

    const afterSecond = foldBalance(second.ledger, BUSINESS, CUSTOMER, '2026-12-31');
    expect(afterSecond.balancePoints).toBe(700n);
    expect(afterSecond.movementCount).toBe(2);
    expect(afterSecond).toEqual(afterFirst);

    // Ten more replays change nothing either.
    let ledger = second.ledger;
    for (let i = 0; i < 10; i += 1) ledger = appendMovement(ledger, { ...draft, id: `c1-retry-${i}` }).ledger;
    expect(foldBalance(ledger, BUSINESS, CUSTOMER, '2026-12-31').balancePoints).toBe(700n);
    expect(ledger.movements.length).toBe(2);
  });

  it('the earn retry of §2.3 is the same property: at-least-once behind exactly-once', () => {
    let ledger = emptyLedger();
    const draft = earn('e1', 123n, '2026-10-12', '2028-10-11');
    for (let i = 0; i < 5; i += 1) ledger = appendMovement(ledger, { ...draft, id: `e1-attempt-${i}` }).ledger;
    expect(ledger.movements.length).toBe(1);
    expect(foldBalance(ledger, BUSINESS, CUSTOMER, '2026-10-12').balancePoints).toBe(123n);
  });

  it('assigns the per-customer point_seq itself, so a caller cannot invent one', () => {
    const ledger = ledgerOf(earn('e1', 1n, '2026-01-01', '2027-01-01'), earn('e2', 1n, '2026-01-02', '2027-01-02'));
    expect(ledger.movements.map((m) => m.pointSeq)).toEqual([1n, 2n]);
  });
});

/* ================================================================== *
 * §1.2 / §1.4 — shape refusals
 * ================================================================== */

describe('validateDraft — §1.2 shape rules, refused before the request is made (§5.5.4 F-3)', () => {
  it('refuses a zero delta, because it records no fact', () => {
    expect(() => appendMovement(emptyLedger(), adjust('a1', 0n, '2026-01-01'))).toThrow(/zero points/);
  });

  it('refuses a delta outside the ledger range rather than wrapping it', () => {
    expect(() => appendMovement(emptyLedger(), earn('e1', POINTS_DELTA_MAX + 1n, '2026-01-01', '2027-01-01'))).toThrow(
      /outside the ledger's range/,
    );
  });

  it('refuses a sign that contradicts the kind', () => {
    expect(() => appendMovement(emptyLedger(), { ...earn('e1', 5n, '2026-01-01', '2027-01-01'), pointsDelta: -5n })).toThrow(
      /earn movement is positive/,
    );
    expect(() => appendMovement(emptyLedger(), { ...consume('c1', 5n, '2026-01-01'), pointsDelta: 5n })).toThrow(
      /consume movement is negative/,
    );
  });

  it('refuses a (source, kind) pair the least-authority registry does not admit', () => {
    expect(() =>
      appendMovement(emptyLedger(), { ...earn('e1', 5n, '2026-01-01', '2027-01-01'), sourceType: 'expiry_sweep' }),
    ).toThrow(/may not produce this movement kind/);
    expect(() => appendMovement(emptyLedger(), { ...expire('x1', 5n, '2026-01-01'), sourceType: 'sale' })).toThrow(
      /may not produce this movement kind/,
    );
  });

  it('refuses an adjust with no reason, and accepts one with a reason (§1.4)', () => {
    expect(() => appendMovement(emptyLedger(), adjust('a1', -5n, '2026-01-01', ''))).toThrow(/must carry a reason/);
    expect(appendMovement(emptyLedger(), adjust('a1', -5n, '2026-01-01', 'goodwill')).outcome).toBe('appended');
  });

  it('refuses a horizon on a non-earn row and a missing one on an earn row', () => {
    expect(() => appendMovement(emptyLedger(), { ...earn('e1', 5n, '2026-01-01', '2027-01-01'), expiresOn: null })).toThrow(
      /an earn carries a horizon/,
    );
    expect(() => appendMovement(emptyLedger(), { ...expire('x1', 5n, '2026-01-01'), expiresOn: '2027-01-01' })).toThrow(
      /an earn carries a horizon/,
    );
  });

  it('refuses a horizon on or before the day earned — the horizon-of-zero shape (§4.2)', () => {
    expect(() => appendMovement(emptyLedger(), earn('e1', 5n, '2026-01-01', '2026-01-01'))).toThrow(/after the day earned/);
    expect(() => appendMovement(emptyLedger(), earn('e1', 5n, '2026-01-02', '2026-01-01'))).toThrow(/after the day earned/);
  });

  it('a correction is a new adjust row naming its target; there is no reversed flag (§1.4)', () => {
    const base = ledgerOf(earn('e1', 500n, '2026-01-01', '2029-01-01'));
    const target = must(base.movements[0], 'base.movements entry');
    const corrected = appendMovement(base, adjust('a1', -500n, '2026-02-01', 'earned in error on sale-e1', target.id));
    expect(corrected.outcome).toBe('appended');
    expect(foldBalance(corrected.ledger, BUSINESS, CUSTOMER, '2026-12-31').balancePoints).toBe(0n);
    // The corrected row is untouched and keeps its point_seq.
    expect(corrected.ledger.movements[0]).toEqual(target);
    expect(Object.keys(target)).not.toContain('reversed');

    // A movement may be corrected more than once; §1.4 says so deliberately.
    const twice = appendMovement(corrected.ledger, adjust('a2', 100n, '2026-03-01', 'partial restoration', target.id));
    expect(twice.outcome).toBe('appended');

    expect(() => appendMovement(base, adjust('a9', -1n, '2026-02-01', 'why', 'not-in-the-ledger'))).toThrow(
      /must name a movement in the ledger/,
    );
    expect(() => appendMovement(base, { ...adjust('a3', -1n, '2026-02-01', 'why'), correctsId: 'a3' })).toThrow(
      /may not correct itself/,
    );
    expect(() => appendMovement(base, { ...earn('e2', 1n, '2026-02-01', '2027-01-01'), correctsId: target.id })).toThrow(
      /only an adjust may be a correction/,
    );
  });
});

/* ================================================================== *
 * §4 — the expiry fold
 * ================================================================== */

describe('foldExpiry — §4, oldest-earn-first by (expiresOn, point_seq)', () => {
  const single = ledgerOf(earn('e1', 100n, '2026-01-01', '2027-01-01'));

  it('T2-EXP-BOUND-1 — spendable the day before the horizon; the sweep writes nothing', () => {
    const fold = foldExpiry(single, BUSINESS, CUSTOMER, '2026-12-31');
    expect(fold.spendablePoints).toBe(100n);
    expect(fold.expiringPoints).toBe(0n);
    expect(fold.balancePoints).toBe(100n);
  });

  it('T2-EXP-BOUND-2 — expired on the boundary day itself; the sweep writes -p', () => {
    const fold = foldExpiry(single, BUSINESS, CUSTOMER, '2027-01-01');
    expect(fold.expiringPoints).toBe(100n);
    expect(fold.spendablePoints).toBe(0n);
    const swept = appendMovement(single, expire('x1', fold.expiringPoints, '2027-01-01'));
    expect(foldBalance(swept.ledger, BUSINESS, CUSTOMER, '2027-01-01').balancePoints).toBe(0n);
  });

  it('T2-EXP-BOUND-3 — a second sweep writes nothing; the balance is 0 and not -2p', () => {
    const swept = appendMovement(single, expire('x1', 100n, '2027-01-01')).ledger;
    const fold = foldExpiry(swept, BUSINESS, CUSTOMER, '2027-01-02');
    expect(fold.expiringPoints).toBe(0n);
    expect(foldBalance(swept, BUSINESS, CUSTOMER, '2027-01-02').balancePoints).toBe(0n);
  });

  it('T2-EXP-IDEM — the same sweep run replayed leaves exactly one expire row', () => {
    const draft = expire('x1', 100n, '2027-01-01');
    let ledger = appendMovement(single, draft).ledger;
    const replay = appendMovement(ledger, { ...draft, id: 'x1-replay' });
    expect(replay.outcome).toBe('already_present');
    ledger = replay.ledger;
    expect(ledger.movements.filter((m) => m.movementKind === 'expire').length).toBe(1);
    expect(foldBalance(ledger, BUSINESS, CUSTOMER, '2027-01-01').balancePoints).toBe(0n);
  });

  it('T2-EXP-PARTIAL — only the lot whose horizon has passed expires', () => {
    const ledger = ledgerOf(earn('e1', 40n, '2026-01-01', '2027-01-01'), earn('e2', 60n, '2026-01-02', '2028-01-01'));
    const fold = foldExpiry(ledger, BUSINESS, CUSTOMER, '2027-06-01');
    expect(fold.expiringPoints).toBe(40n);
    expect(fold.spendablePoints).toBe(60n);
  });

  it('T2-EXP-ADJUSTED — the sweep expires AT MOST the balance: -(p-k), never -p', () => {
    const ledger = ledgerOf(earn('e1', 100n, '2026-01-01', '2027-01-01'), adjust('a1', -30n, '2026-06-01', 'goodwill clawback'));
    const fold = foldExpiry(ledger, BUSINESS, CUSTOMER, '2027-01-01');
    expect(fold.balancePoints).toBe(70n);
    expect(fold.expiringPoints).toBe(70n);
    // The naive `SUM(earn)` sweep this case exists to catch would say 100.
    expect(fold.expiringPoints).not.toBe(100n);
  });

  it('T2-EXP-ORDER — equal horizons are ordered by point_seq, byte-identically across runs', () => {
    const ledger = ledgerOf(
      earn('e1', 10n, '2026-01-01', '2027-01-01'),
      earn('e2', 20n, '2026-01-02', '2028-01-01'),
      earn('e3', 30n, '2026-01-03', '2028-01-01'),
    );
    const render = (): string =>
      JSON.stringify(
        foldExpiry(ledger, BUSINESS, CUSTOMER, '2028-01-01').lots.map((l) => [l.movementId, l.pointSeq.toString(), l.expiresOn]),
      );
    expect(render()).toBe('[["e1","1","2027-01-01"],["e2","2","2028-01-01"],["e3","3","2028-01-01"]]');
    expect(render()).toBe(render());
    expect(render()).toBe(render());
  });

  it('consumption draws on the oldest lot first, which is what makes the sweep representable (§4.3)', () => {
    const ledger = ledgerOf(
      earn('e1', 50n, '2026-01-01', '2027-01-01'),
      earn('e2', 50n, '2026-01-02', '2029-01-01'),
      consume('c1', 50n, '2026-06-01'),
    );
    const fold = foldExpiry(ledger, BUSINESS, CUSTOMER, '2027-01-01');
    // The oldest lot absorbed the consumption, so nothing is left to expire.
    expect(fold.lots.map((l) => l.remainingPoints)).toEqual([0n, 50n]);
    expect(fold.expiringPoints).toBe(0n);
    expect(fold.spendablePoints).toBe(50n);
    expect(fold.balancePoints).toBe(50n);
  });

  it('T2-EXP-LEAP — the horizon is DATE arithmetic in whole days, not month arithmetic', () => {
    // MEASURED, and it disagrees with the design document's guess.
    // `P13-LOYALTY-DESIGN §4.4` sketches `T2-EXP-LEAP` as straddled by
    // `2029-02-28` / `2029-03-01`, which would put the horizon at
    // `2029-03-01`. Whole-day DATE arithmetic from `2028-02-29` puts it at
    // `2029-02-28`: 2029 is not a leap year, so `2028-02-29 + 365` lands one
    // day short of the anniversary. The case's own instruction is to assert
    // `expires_on` AS THE STORED VALUE, which is what this does — the point of
    // the case being to pin that the horizon is day arithmetic and not month
    // arithmetic with an implicit clamp.
    expect(addDays('2028-02-29', 365)).toBe('2029-02-28');
    const ledger = ledgerOf(earn('e1', 10n, '2028-02-29', addDays('2028-02-29', 365)));
    expect(must(ledger.movements[0], 'ledger.movements entry').expiresOn).toBe('2029-02-28');
    // The real straddle, either side of the stored value.
    expect(foldExpiry(ledger, BUSINESS, CUSTOMER, '2029-02-27').expiringPoints).toBe(0n);
    expect(foldExpiry(ledger, BUSINESS, CUSTOMER, '2029-02-28').expiringPoints).toBe(10n);
    expect(foldExpiry(ledger, BUSINESS, CUSTOMER, '2029-03-01').expiringPoints).toBe(10n);
    // And month arithmetic with a clamp would have given a different answer,
    // which is the defect the case exists to catch.
    expect(addDays('2028-02-29', 366)).toBe('2029-03-01');
  });

  it('T4-EXP-LONG-HORIZON — only executable because asOf is supplied', () => {
    expect(addDays('2026-01-01', 3650)).toBe('2035-12-30');
    const secondEarnedOn = addDays('2026-01-01', 3649);
    const ledger = ledgerOf(
      earn('e1', 100n, '2026-01-01', addDays('2026-01-01', 3650)),
      earn('e2', 200n, secondEarnedOn, addDays(secondEarnedOn, 3650)),
    );
    expect(foldExpiry(ledger, BUSINESS, CUSTOMER, '2030-06-15').expiringPoints).toBe(0n);
    expect(foldExpiry(ledger, BUSINESS, CUSTOMER, '2035-12-29').expiringPoints).toBe(0n);
    expect(foldExpiry(ledger, BUSINESS, CUSTOMER, '2035-12-30').expiringPoints).toBe(100n);
    // The second earn survives until its OWN horizon, which is later than the
    // first's by exactly the 3 649 days between the two earns.
    expect(foldExpiry(ledger, BUSINESS, CUSTOMER, '2045-01-01').expiringPoints).toBe(100n);
    expect(foldExpiry(ledger, BUSINESS, CUSTOMER, addDays(secondEarnedOn, 3650)).expiringPoints).toBe(300n);
  });

  it('eligiblePoints withholds points whose horizon has passed but whose sweep has not run (§5.2)', () => {
    const ledger = ledgerOf(earn('e1', 40n, '2026-01-01', '2027-01-01'), earn('e2', 60n, '2026-01-02', '2029-01-01'));
    expect(foldBalance(ledger, BUSINESS, CUSTOMER, '2027-06-01').balancePoints).toBe(100n);
    expect(eligiblePoints(ledger, BUSINESS, CUSTOMER, '2027-06-01')).toBe(60n);
    expect(eligiblePoints(ledger, BUSINESS, CUSTOMER, '2026-12-31')).toBe(100n);
  });
});

/* ================================================================== *
 * §5.6 — configuration and the required rounding mode
 * ================================================================== */

describe('the rate and the rounding mode are arguments, never constants (§5.6)', () => {
  const MODES: readonly RoundingMode[] = ['floor', 'ceil', 'toward_zero', 'half_up', 'half_even'];

  it('divides exactly under every mode, including the exact-half cases', () => {
    expect(MODES.map((m) => divideRounded(7n, 2n, m))).toEqual([3n, 4n, 3n, 4n, 4n]);
    expect(MODES.map((m) => divideRounded(5n, 2n, m))).toEqual([2n, 3n, 2n, 3n, 2n]);
    expect(MODES.map((m) => divideRounded(1n, 3n, m))).toEqual([0n, 1n, 0n, 0n, 0n]);
    expect(MODES.map((m) => divideRounded(-7n, 2n, m))).toEqual([-4n, -3n, -3n, -4n, -4n]);
    expect(MODES.map((m) => divideRounded(4n, 2n, m))).toEqual([2n, 2n, 2n, 2n, 2n]);
    expect(() => divideRounded(1n, 0n, 'floor')).toThrow(/denominator must be positive/);
  });

  it('the mode changes the award, which is why there is no default', () => {
    const config: LoyaltyEarningConfig = { pointsPerMinorUnit: { numerator: 1n, denominator: 200n }, horizonDays: 365 };
    const awards = MODES.map((m) => computeEarnedPoints(1900n, config, m));
    expect(awards).toEqual([9n, 10n, 9n, 10n, 10n]);
    expect(new Set(awards.map(String)).size).toBeGreaterThan(1);
  });

  it('fails closed on absent, empty or non-positive configuration (PART 124)', () => {
    expect(() => computeEarnedPoints(100n, null, 'floor')).toThrow(/no loyalty earning configuration/);
    expect(() => computeEarnedPoints(100n, undefined, 'floor')).toThrow(/no loyalty earning configuration/);
    expect(() => computeEarnedPoints(100n, {} as LoyaltyEarningConfig, 'floor')).toThrow(/not configured/);
    expect(() =>
      computeEarnedPoints(100n, { pointsPerMinorUnit: { numerator: 0n, denominator: 1n }, horizonDays: 1 }, 'floor'),
    ).toThrow(/positive rational/);

    try {
      computeEarnedPoints(100n, null, 'floor');
      expect.unreachable('an absent configuration must refuse');
    } catch (error) {
      expect(error).toBeInstanceOf(LoyaltyRefusal);
      expect((error as LoyaltyRefusal).code).toBe('loyalty.unconfigured');
    }
  });

  it('the conversion rate is an argument too, and an absent one has no redemption capability', () => {
    expect(() => convertPointsToValueMinor(100n, null, 'floor')).toThrow(/no configured points conversion/);
    expect(convertPointsToValueMinor(100n, { valueMinorPerPoint: { numerator: 5n, denominator: 2n } }, 'floor')).toBe(250n);
    expect(convertPointsToValueMinor(101n, { valueMinorPerPoint: { numerator: 5n, denominator: 2n } }, 'floor')).toBe(252n);
    expect(convertPointsToValueMinor(101n, { valueMinorPerPoint: { numerator: 5n, denominator: 2n } }, 'ceil')).toBe(253n);
    expect(() => convertPointsToValueMinor(0n, { valueMinorPerPoint: { numerator: 1n, denominator: 1n } }, 'floor')).toThrow(
      /no points has no value/,
    );
  });

  it('refuses an award outside the ledger range instead of wrapping it', () => {
    const config: LoyaltyEarningConfig = { pointsPerMinorUnit: { numerator: 1000000n, denominator: 1n }, horizonDays: 365 };
    expect(() => computeEarnedPoints(10000000000n, config, 'floor')).toThrow(/outside the ledger's range/);
  });
});

/* ================================================================== *
 * §2.2(d) / §5.5 — the two sides of the sale's transaction boundary
 * ================================================================== */

describe('earning is AFTER the sale and cannot fail it (§2.2, §2.3)', () => {
  it('builds the earn row from the committed-sale event, with the horizon stored on it', () => {
    const attempt = tryBuildPostSaleEarnMovement(committed(), CONFIG, 'floor');
    expect(attempt.ok).toBe(true);
    if (!attempt.ok) return;
    expect(attempt.draft.movementKind).toBe('earn');
    expect(attempt.draft.sourceType).toBe('sale');
    expect(attempt.draft.sourceId).toBe('sale-1');
    expect(attempt.draft.pointsDelta).toBe(123n);
    expect(attempt.draft.effectiveOn).toBe('2026-10-12');
    expect(attempt.draft.expiresOn).toBe(addDays('2026-10-12', 730));
    expect(Object.keys(attempt.draft)).not.toContain('currency');
    expect(Object.keys(attempt.draft)).not.toContain('rate');
  });

  it('RED PROOF — an earning call that could make a sale fail: it NEVER throws, on any input', () => {
    // Every hostile input the earn path could be handed: no configuration, a
    // zero rate, a rate that awards nothing, a bad date, a bad horizon, a
    // negative base, a non-bigint base, an overflowing award. §2.2(b): the
    // earn transaction may fail in every way a transaction can fail and the
    // sale is already committed and unaffected — so there must be no throwing
    // expression here at all.
    const hostile: readonly [string, () => ReturnType<typeof tryBuildPostSaleEarnMovement>][] = [
      ['no configuration', () => tryBuildPostSaleEarnMovement(committed(), null, 'floor')],
      ['undefined configuration', () => tryBuildPostSaleEarnMovement(committed(), undefined, 'floor')],
      ['empty configuration', () => tryBuildPostSaleEarnMovement(committed(), {} as LoyaltyEarningConfig, 'floor')],
      [
        'zero rate',
        () =>
          tryBuildPostSaleEarnMovement(
            committed(),
            { pointsPerMinorUnit: { numerator: 0n, denominator: 1n }, horizonDays: 1 },
            'floor',
          ),
      ],
      [
        'negative denominator',
        () =>
          tryBuildPostSaleEarnMovement(
            committed(),
            { pointsPerMinorUnit: { numerator: 1n, denominator: -1n }, horizonDays: 1 },
            'floor',
          ),
      ],
      ['awards no whole point', () => tryBuildPostSaleEarnMovement(committed({ eligibleBaseMinor: 1n }), CONFIG, 'floor')],
      ['negative base', () => tryBuildPostSaleEarnMovement(committed({ eligibleBaseMinor: -5n }), CONFIG, 'floor')],
      [
        'base is not a bigint',
        () => tryBuildPostSaleEarnMovement(committed({ eligibleBaseMinor: 500 as unknown as bigint }), CONFIG, 'floor'),
      ],
      ['bad effective date', () => tryBuildPostSaleEarnMovement(committed({ effectiveOn: '12/10/2026' }), CONFIG, 'floor')],
      ['impossible effective date', () => tryBuildPostSaleEarnMovement(committed({ effectiveOn: '2026-02-30' }), CONFIG, 'floor')],
      [
        'zero horizon',
        () =>
          tryBuildPostSaleEarnMovement(
            committed(),
            { pointsPerMinorUnit: { numerator: 1n, denominator: 1n }, horizonDays: 0 },
            'floor',
          ),
      ],
      [
        'fractional horizon',
        () =>
          tryBuildPostSaleEarnMovement(
            committed(),
            { pointsPerMinorUnit: { numerator: 1n, denominator: 1n }, horizonDays: 1.5 },
            'floor',
          ),
      ],
      [
        'overflowing award',
        () =>
          tryBuildPostSaleEarnMovement(
            committed({ eligibleBaseMinor: 10n ** 20n }),
            { pointsPerMinorUnit: { numerator: 1n, denominator: 1n }, horizonDays: 365 },
            'floor',
          ),
      ],
      ['event is not an object', () => tryBuildPostSaleEarnMovement({} as never, CONFIG, 'floor')],
    ];

    for (const [name, call] of hostile) {
      expect(call, name).not.toThrow();
      const attempt = call();
      expect(attempt.ok, name).toBe(false);
      if (attempt.ok) continue;
      expect(attempt.refusal, name).toBeInstanceOf(LoyaltyRefusal);
      // A refusal and never a degraded answer: no draft travels beside it.
      expect(Object.keys(attempt), name).toEqual(['ok', 'refusal']);
    }
    expect(hostile.length).toBe(14);
  });
});

describe('consumption is INSIDE the sale and may refuse it (§5.5.4 F-3)', () => {
  const base = ledgerOf(earn('e1', 1000n, '2026-01-01', '2029-01-01'));
  const inSale = (overrides: Record<string, unknown> = {}) =>
    ({
      phase: 'inside_sale_transaction',
      businessId: BUSINESS,
      customerId: CUSTOMER,
      saleId: 'sale-9',
      businessTransactionId: 'btx-9',
      points: 300n,
      asOf: '2026-06-01',
      movementId: 'mv-9',
      ...overrides,
    }) as Parameters<typeof buildSaleConsumptionMovement>[1];

  it('builds a negative sale-sourced row keyed on the sale id', () => {
    const draft = buildSaleConsumptionMovement(base, inSale());
    expect(draft.pointsDelta).toBe(-300n);
    expect(draft.sourceType).toBe('sale');
    expect(draft.sourceId).toBe('sale-9');
    expect(draft.expiresOn).toBeNull();
    expect(identityKey(draft)).toBe(identityKey(saleConsumptionIdentity(BUSINESS, 'sale-9')));
  });

  it('THROWS rather than returning a result, because the sale must abort (F-3)', () => {
    // The asymmetry with the earn path is the law, not a style difference.
    expect(() => buildSaleConsumptionMovement(base, inSale({ points: 1001n }))).toThrow(LoyaltyRefusal);
    expect(() => buildSaleConsumptionMovement(base, inSale({ points: 0n }))).toThrow(/not a movement/);
    expect(() => buildSaleConsumptionMovement(base, inSale({ points: -1n }))).toThrow(/not a movement/);
    expect(() => buildSaleConsumptionMovement(base, inSale({ asOf: '2026-02-30' }))).toThrow(/not a real calendar date/);
  });

  it('F-4 — re-checks the ledger at commit time, because a quote is advisory', () => {
    // Quoted at 1000 on 2026-06-01; by the time the sale commits the points
    // have been spent on another sale.
    const spent = appendMovement(base, consume('c1', 900n, '2026-05-01', 'sale-other')).ledger;
    expect(eligiblePoints(spent, BUSINESS, CUSTOMER, '2026-06-01')).toBe(100n);
    try {
      buildSaleConsumptionMovement(spent, inSale({ points: 300n }));
      expect.unreachable('the commit-time re-check must refuse');
    } catch (error) {
      expect(error).toBeInstanceOf(LoyaltyRefusal);
      expect((error as LoyaltyRefusal).code).toBe('loyalty.insufficient_eligible_points');
    }
  });

  it('F-1 — a quantity whose horizon has passed is not consumable, even though the balance shows it', () => {
    const stale = ledgerOf(earn('e1', 500n, '2026-01-01', '2026-06-01'));
    expect(foldBalance(stale, BUSINESS, CUSTOMER, '2026-07-01').balancePoints).toBe(500n);
    expect(eligiblePoints(stale, BUSINESS, CUSTOMER, '2026-07-01')).toBe(0n);
    expect(() => buildSaleConsumptionMovement(stale, inSale({ asOf: '2026-07-01', points: 1n }))).toThrow(
      /no longer available at commit time/,
    );
  });

  it('F-2 — a sale that aborts consumes zero points: the draft is never appended', () => {
    const draft = buildSaleConsumptionMovement(base, inSale());
    // The draft is a value. Nothing has been written, and the balance is
    // unchanged, because the append belongs to the sale's own transaction.
    expect(foldBalance(base, BUSINESS, CUSTOMER, '2026-12-31').balancePoints).toBe(1000n);
    expect(base.movements.length).toBe(1);
    expect(draft.pointsDelta).toBe(-300n);
  });

  it('the consumption kind is NOT registered yet, and says so (§5.1, §5.5.5 BLOCKED)', () => {
    expect(REGISTERED_KINDS).toEqual(['earn', 'expire', 'adjust']);
    expect(REGISTERED_KINDS.length).toBe(3);
    expect(consumptionKindIsRegistered()).toBe(false);
    expect(consumptionKindIsRegistered('earn')).toBe(true);
  });
});

/* ================================================================== *
 * RED PROOFS
 * ================================================================== */

describe('RED PROOFS — the laws, proved by breaking them', () => {
  it('RED PROOF — a consumption applied twice WITHOUT the identity check doubles the spend', () => {
    const base = ledgerOf(earn('e1', 1000n, '2026-01-01', '2029-01-01'));
    const draft = consume('c1', 300n, '2026-06-01', 'sale-7');

    // The broken appender: append whatever it is handed. This is what the
    // absence of `loyalty_point_movements_identity_uq` would look like.
    const naive: LoyaltyLedger = {
      movements: [
        ...base.movements,
        { ...draft, pointSeq: 2n },
        { ...draft, id: 'c1-retry', pointSeq: 3n },
      ],
    };
    expect(foldBalance(naive, BUSINESS, CUSTOMER, '2026-12-31').balancePoints).toBe(400n);

    // The real one: the replay is a no-op and the balance does not move.
    const once = appendMovement(base, draft).ledger;
    const twice = appendMovement(once, { ...draft, id: 'c1-retry' }).ledger;
    expect(foldBalance(twice, BUSINESS, CUSTOMER, '2026-12-31').balancePoints).toBe(700n);
    expect(foldBalance(twice, BUSINESS, CUSTOMER, '2026-12-31').balancePoints).not.toBe(400n);
  });

  it('RED PROOF — a LIFO draw leaves the soonest-expiring points surviving; oldest-first does not', () => {
    // §4.3's forcing argument, made executable. Two lots: an old one that is
    // about to expire and a newer one. The customer has spent exactly one
    // lot's worth.
    const ledger = ledgerOf(
      earn('e1', 50n, '2026-01-01', '2027-01-01'),
      earn('e2', 50n, '2026-01-02', '2029-01-01'),
      consume('c1', 50n, '2026-06-01'),
    );
    const asOf = '2027-01-01';
    const balance = foldBalance(ledger, BUSINESS, CUSTOMER, asOf).balancePoints;
    expect(balance).toBe(50n);

    // The broken sweep: draw the consumption off the NEWEST lot first, then
    // expire whatever of the oldest survives. Written out so the defect is
    // visible rather than asserted.
    const lots = ledger.movements
      .filter((m) => m.movementKind === 'earn')
      .map((m) => ({ expiresOn: must(m.expiresOn, 'an earn row horizon'), remaining: m.pointsDelta }))
      .sort((a, b) => (a.expiresOn > b.expiresOn ? -1 : a.expiresOn < b.expiresOn ? 1 : 0));
    let draw = 50n;
    for (const lot of lots) {
      const take = lot.remaining < draw ? lot.remaining : draw;
      lot.remaining -= take;
      draw -= take;
    }
    const lifoExpiring = lots.filter((l) => l.expiresOn <= asOf).reduce((acc, l) => acc + l.remaining, 0n);

    // The canary: under LIFO the survivors ARE the soonest-expiring points, so
    // the sweep takes the customer's whole remaining balance at the horizon
    // even though they have been spending steadily.
    expect(lots.map((l) => l.remaining)).toEqual([0n, 50n]);
    expect(lifoExpiring).toBe(50n);
    expect(balance - lifoExpiring).toBe(0n);

    // The real fold: the consumption hit the oldest lot, so nothing expires and
    // the surviving 50 keep their later horizon.
    const real = foldExpiry(ledger, BUSINESS, CUSTOMER, asOf);
    expect(real.lots.map((l) => l.remainingPoints)).toEqual([0n, 50n]);
    expect(real.expiringPoints).toBe(0n);
    expect(real.spendablePoints).toBe(50n);
    expect(real.expiringPoints <= real.balancePoints).toBe(true);
    expect(real.expiringPoints).not.toBe(lifoExpiring);
  });

  it('RED PROOF — a naive SUM(earn) sweep over-expires an adjusted balance', () => {
    const ledger = ledgerOf(earn('e1', 100n, '2026-01-01', '2027-01-01'), adjust('a1', -30n, '2026-06-01', 'clawback'));
    const naiveSumOfEarns = ledger.movements
      .filter((m) => m.movementKind === 'earn')
      .reduce((acc, m) => acc + m.pointsDelta, 0n);
    const balance = foldBalance(ledger, BUSINESS, CUSTOMER, '2027-01-01').balancePoints;
    expect(naiveSumOfEarns).toBe(100n);
    expect(balance).toBe(70n);
    // The canary: the naive sweep really would drive the balance negative.
    expect(balance - naiveSumOfEarns < 0n).toBe(true);

    const real = foldExpiry(ledger, BUSINESS, CUSTOMER, '2027-01-01');
    expect(real.expiringPoints).toBe(70n);
    expect(balance - real.expiringPoints).toBe(0n);
  });

  it('RED PROOF — a float points fold loses digits; the bigint fold does not', () => {
    const drafts = Array.from({ length: 10 }, (_, i) => earn(`e${i}`, POINTS_DELTA_MAX, '2026-01-01', '2030-01-01'));
    const ledger = ledgerOf(...drafts);
    const exact = foldBalance(ledger, BUSINESS, CUSTOMER, '2026-01-01').balancePoints;
    expect(exact).toBe(10000000000000000n);

    const asFloat = ledger.movements.reduce((acc, m) => acc + Number(m.pointsDelta), 0);
    expect(Number.isSafeInteger(asFloat)).toBe(false);
    // One more point on top of the float total is indistinguishable from the
    // total itself, which is how a balance silently stops moving.
    expect(asFloat + 1 === asFloat).toBe(true);
    expect(exact + 1n === exact).toBe(false);
  });

  it('RED PROOF — a clock-reading expiry cannot be put at a 2035 horizon at all', () => {
    // The supplied-asOf discipline of §4.1, stated as a difference the test can
    // see: the same ledger answers differently at two supplied dates, and a
    // `current_date` implementation would answer the same at both.
    const ledger = ledgerOf(earn('e1', 100n, '2026-01-01', addDays('2026-01-01', 3650)));
    const atNear = foldExpiry(ledger, BUSINESS, CUSTOMER, '2030-06-15').expiringPoints;
    const atHorizon = foldExpiry(ledger, BUSINESS, CUSTOMER, '2035-12-30').expiringPoints;
    expect(atNear).toBe(0n);
    expect(atHorizon).toBe(100n);
    expect(atNear === atHorizon).toBe(false);
  });
});
