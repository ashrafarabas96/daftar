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
  buildReversalMovement,
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
  KIND_SIGN,
  LoyaltyRefusal,
  POINTS_DELTA_MAX,
  REGISTERED_KINDS,
  saleConsumptionIdentity,
  saleEarnIdentity,
  SOURCE_KIND_PAIRS,
  tryBuildPostSaleEarnMovement,
  type LoyaltyEarningConfig,
  type LoyaltyLedger,
  type LoyaltyMovement,
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


/** F-06 — a refusal is asserted by its CODE, never by its class alone.
 *  `toThrow(LoyaltyRefusal)` passes when ANY law in the call path refuses, so
 *  it keeps passing when the refusal moves to a different reason — including a
 *  reason the test was written to rule out. This returns the code so the
 *  assertion names the one law under test. */
function refusalCodeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof LoyaltyRefusal) return error.code;
    throw error;
  }
  throw new Error('expected a refusal, but the call returned normally');
}

const BUSINESS = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';

/**
 * The `storedPartyMovementCount` a caller must state (C-2), derived from the ledger
 * being handed over.
 *
 * `R11-03`: this is EXACTLY the shape the guard cannot see — the length of the
 * array about to be handed over is a count of that array, not of the store, and
 * it satisfies the check for any narrowing. It is used here deliberately,
 * because every ledger in this suite is the whole of its party's ledger and the
 * two numbers are the same number; it is NOT the shape a real caller should
 * copy, which is why the field carries its source in its name and the writer's
 * contract says where the number must come from. The cases that exercise a
 * DISAGREEMENT, and the padded narrowing of `R11-04`, state the count by hand.
 */
const partyCount = (
  l: LoyaltyLedger, businessId: string = BUSINESS, customerId: string = CUSTOMER,
): { storedPartyMovementCount: number } => ({
  storedPartyMovementCount: l.movements.filter(
    (m) => m.businessId === businessId && m.customerId === customerId,
  ).length,
});

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
    expect(refusalCodeOf(() => foldBalance(emptyLedger(), BUSINESS, CUSTOMER, '12/10/2026'))).toBe('loyalty.date_not_civil');
    expect(() => assertCivilDate('2026-02-30', 'asOf')).toThrow(/not a real calendar date/);
    expect(refusalCodeOf(() => assertCivilDate('2026-13-01', 'asOf'))).toBe('loyalty.date_not_civil');
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
    expect(refusalCodeOf(() => buildSaleConsumptionMovement(base, inSale({ points: 1001n })))).toBe(
      'loyalty.insufficient_eligible_points',
    );
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

/* ================================================================== *
 * F-01 — the restoration horizon, and what the fold withholds
 *
 * Round 1 of an independent challenge found that points restored after a full
 * sale reversal came back with NO horizon and stayed redeemable forever.
 * Round 2 found that the first fix keyed on `sourceType` and so exempted the
 * exact row it was written to stop: the pack specifies the restoration AS a
 * positive `manual_adjustment` `adjust` naming its target (§1.4, §2.3, A-16).
 * These are the permanent proofs of the second fix, and the lesson they encode
 * is that a guard must be driven through the REAL WRITER. Every fixture below
 * goes through `appendMovement`, so every shape law is satisfied and the rows
 * are ones a lawful writer can actually produce.
 *
 * Round 4 moved the remedy from a REFUSAL to a WITHHOLDING (`F-13`, below):
 * the quantity that cannot be attributed is excluded from what may be spent,
 * and the rest of the ledger is answered. These cases now pin that, and the
 * `F-13` block holds the red proof and the positive case for the remainder.
 * ================================================================== */

describe('foldExpiry — F-01, a positive row that CORRECTS another has no attributable horizon', () => {
  /** The challenge's fixture, built the way the pack says a reversal is written:
   *  100 points with a horizon of 2026-06-01, 40 consumed by a sale, and that
   *  sale reversed by a positive `manual_adjustment` `adjust` whose `correctsId`
   *  names the row it corrects. Nothing here bypasses `validateDraft`. */
  function restoredLedger(): LoyaltyLedger {
    return ledgerOf(
      earn('e1', 100n, '2025-06-01', '2026-06-01'),
      consume('c1', 40n, '2025-09-01'),
      adjust('r1', 40n, '2025-09-02', 'sale fully reversed', 'e1'),
    );
  }

  it('withholds the 40 it cannot attribute rather than reporting them spendable', () => {
    const fold = foldExpiry(restoredLedger(), BUSINESS, CUSTOMER, '2026-06-01');
    // The whole ledger is still in the balance — withholding is not forgetting.
    expect(fold.balancePoints).toBe(100n);
    expect(fold.unattributablePoints).toBe(40n);
    // And it is NOT in either spendable figure: not lot-backed, not a grant.
    expect(fold.unhorizonedPoints).toBe(0n);
    expect(fold.spendablePoints).toBe(0n);
    expect(fold.expiringPoints).toBe(60n);
    // The quantity the old fold offered, now offered to nobody.
    expect(eligiblePoints(restoredLedger(), BUSINESS, CUSTOMER, '2026-06-01')).toBe(0n);
  });

  it('withholds at EVERY asOf, not only on the horizon day', () => {
    for (const asOf of ['2025-09-02', '2026-05-31', '2026-06-01', '2036-01-01']) {
      const fold = foldExpiry(restoredLedger(), BUSINESS, CUSTOMER, asOf);
      expect(fold.unattributablePoints).toBe(40n);
      expect(fold.unhorizonedPoints).toBe(0n);
      // On no date does the restored quantity become spendable.
      expect(fold.spendablePoints).toBe(asOf < '2026-06-01' ? 60n : 0n);
    }
    // Ten years on there is nothing left to spend, where the fold this replaced
    // still offered 40.
    expect(eligiblePoints(restoredLedger(), BUSINESS, CUSTOMER, '2036-01-01')).toBe(0n);
  });

  it('RED PROOF — the fold this replaced reported 40 points that never expire', () => {
    // The old loop, restated exactly: every positive non-earn row joined an
    // un-horizoned total spendable at every asOf. Run it over the same lawful
    // ledger and it reproduces the figures BOTH challenge rounds measured —
    // which is the point, because the round-1 fix changed none of them.
    const rows = restoredLedger().movements;
    const brokenFold = (asOf: string) => {
      let unhorizoned = 0n;
      let draw = 0n;
      for (const m of rows) {
        if (m.movementKind === 'earn') continue;
        if (m.pointsDelta < 0n) draw += -m.pointsDelta;
        else unhorizoned += m.pointsDelta;
      }
      const lots = rows
        .filter((m) => m.movementKind === 'earn')
        .map((m) => ({ expiresOn: must(m.expiresOn, 'an earn horizon'), remaining: m.pointsDelta }));
      for (const lot of lots) {
        const take = lot.remaining < draw ? lot.remaining : draw;
        lot.remaining -= take;
        draw -= take;
      }
      const expiring = lots.filter((l) => l.expiresOn <= asOf).reduce((acc, l) => acc + l.remaining, 0n);
      const spendableFromLots = lots.filter((l) => l.expiresOn > asOf).reduce((acc, l) => acc + l.remaining, 0n);
      return { expiringPoints: expiring, spendablePoints: spendableFromLots + unhorizoned };
    };

    // On the horizon day: the lot is drawn down by the consumption that was
    // reversed, 60 expire, and the restored 40 are reported spendable.
    const atHorizon = brokenFold('2026-06-01');
    expect(atHorizon.expiringPoints).toBe(60n);
    expect(atHorizon.spendablePoints).toBe(40n);

    // Ten years later, with nothing left that could ever expire them.
    const muchLater = brokenFold('2036-01-01');
    expect(muchLater.spendablePoints).toBe(40n);
    expect(muchLater.expiringPoints).toBe(60n);

    // The canary: the shipped fold offers none of those 40, at either date.
    for (const asOf of ['2026-06-01', '2036-01-01']) {
      const shipped = foldExpiry(restoredLedger(), BUSINESS, CUSTOMER, asOf);
      expect(shipped.unattributablePoints).toBe(40n);
      expect(shipped.spendablePoints).toBe(0n);
      expect(eligiblePoints(restoredLedger(), BUSINESS, CUSTOMER, asOf)).toBe(0n);
    }
  });

  it('REACHABILITY — the guard fires on a row the LAWFUL writer produces, not only on a hand-built one', () => {
    // The round-1 fix was unreachable through `appendMovement`, and nothing
    // caught that because its own test built a ledger by hand. So reachability
    // is now asserted: every row of the fixture passes `validateDraft`, and the
    // enumeration below is why `manual_adjustment:adjust` is the only shape
    // that can reach the guard at all.
    const ledger = restoredLedger();
    expect(ledger.movements.map((m) => m.id)).toEqual(['e1', 'c1', 'r1']);
    const restoring = must(
      ledger.movements.find((m) => m.id === 'r1'),
      'the restoring row',
    );
    expect(restoring.pointsDelta).toBe(40n);
    expect(restoring.correctsId).toBe('e1');
    expect(SOURCE_KIND_PAIRS).toContain(`${restoring.sourceType}:${restoring.movementKind}`);

    // Of the four registered pairs, `sale:earn` is skipped by the loop, and
    // `sale:consume` and `expiry_sweep:expire` cannot be positive at all — so a
    // guard that exempted `manual_adjustment` could never fire.
    const positiveNonEarnPairs = SOURCE_KIND_PAIRS.filter((pair) => {
      const kind = must(pair.split(':')[1], 'a kind') as keyof typeof KIND_SIGN;
      return kind !== 'earn' && KIND_SIGN[kind] !== 'negative';
    });
    expect(positiveNonEarnPairs).toEqual(['manual_adjustment:adjust']);
  });

  it('still spends a STANDING manual grant, which corrects nothing', () => {
    // The one positive non-earn shape that is MEANT to have no horizon: the
    // merchant's goodwill grant, with `correctsId === null`. The fix must not
    // take it away, and the field must say that none of it is lot-backed.
    const ledger = ledgerOf(
      earn('e1', 100n, '2025-06-01', '2026-06-01'),
      adjust('a1', 40n, '2025-09-01', 'merchant goodwill'),
    );
    const onHorizon = foldExpiry(ledger, BUSINESS, CUSTOMER, '2026-06-01');
    expect(must(ledger.movements.find((m) => m.id === 'a1'), 'the grant').correctsId).toBeNull();
    expect(onHorizon.balancePoints).toBe(140n);
    expect(onHorizon.expiringPoints).toBe(100n);
    expect(onHorizon.spendablePoints).toBe(40n);
    expect(onHorizon.unhorizonedPoints).toBe(40n);
    expect(eligiblePoints(ledger, BUSINESS, CUSTOMER, '2026-06-01')).toBe(40n);

    const muchLater = foldExpiry(ledger, BUSINESS, CUSTOMER, '2036-01-01');
    expect(muchLater.spendablePoints).toBe(40n);
    expect(muchLater.unhorizonedPoints).toBe(40n);
    expect(muchLater.spendablePoints - muchLater.unhorizonedPoints).toBe(0n);
  });

  it('separates the two shapes by `correctsId` and by nothing else', () => {
    // Same source, same kind, same sign, same points, same dates. The ONLY
    // difference is whether the row names a row it corrects — which is what
    // §1.4 makes the marker of a correction, and what the round-1 fix could
    // not see.
    const grant = ledgerOf(earn('e1', 100n, '2025-06-01', '2026-06-01'), adjust('a1', 40n, '2025-09-01', 'goodwill'));
    const correction = ledgerOf(
      earn('e1', 100n, '2025-06-01', '2026-06-01'),
      adjust('a1', 40n, '2025-09-01', 'goodwill', 'e1'),
    );
    const asGrant = foldExpiry(grant, BUSINESS, CUSTOMER, '2026-06-01');
    const asCorrection = foldExpiry(correction, BUSINESS, CUSTOMER, '2026-06-01');
    expect(asGrant.unhorizonedPoints).toBe(40n);
    expect(asGrant.unattributablePoints).toBe(0n);
    expect(asCorrection.unhorizonedPoints).toBe(0n);
    expect(asCorrection.unattributablePoints).toBe(40n);
    // Same balance, opposite verdicts on the same 40 points.
    expect(asGrant.balancePoints).toBe(asCorrection.balancePoints);
    expect(eligiblePoints(grant, BUSINESS, CUSTOMER, '2026-06-01')).toBe(40n);
    expect(eligiblePoints(correction, BUSINESS, CUSTOMER, '2026-06-01')).toBe(0n);
  });

  it('keeps the guard closed over a source §5.7.2 has yet to register', () => {
    // Defence in depth, and labelled as such: this ledger is built BY HAND
    // because no writer can produce `sale:adjust` today. This arm stays a
    // REFUSAL where the correcting arm became a withholding (`F-13`), and the
    // difference is the point: a correction is a lawful row whose quantity can
    // be set aside, while a positive row from an unregistered source means the
    // ledger was assembled past `validateDraft`, and a fold has no basis for
    // an answer of any kind over a ledger that cannot exist.
    const byHand: LoyaltyLedger = {
      movements: [
        {
          id: 'e1', businessId: BUSINESS, customerId: CUSTOMER, pointSeq: 1n,
          movementKind: 'earn', sourceType: 'sale', sourceId: 'sale-earn',
          pointsDelta: 100n, expiresOn: '2026-06-01', effectiveOn: '2025-06-01',
          reason: null, correctsId: null,
        },
        {
          id: 'x1', businessId: BUSINESS, customerId: CUSTOMER, pointSeq: 2n,
          movementKind: 'adjust', sourceType: 'sale', sourceId: 'sale-spend',
          pointsDelta: 40n, expiresOn: null, effectiveOn: '2025-09-02',
          reason: 'a source no registry admits yet', correctsId: null,
        },
      ],
    };
    expect(SOURCE_KIND_PAIRS).not.toContain('sale:adjust');
    expect(refusalCodeOf(() => foldExpiry(byHand, BUSINESS, CUSTOMER, '2026-06-01'))).toBe(
      'loyalty.unattributable_positive_movement',
    );
  });

  it('reports zero un-horizoned points for a ledger that has none', () => {
    // Without this the field could be a constant 40 in the cases above and
    // nothing would notice.
    const ledger = ledgerOf(earn('e1', 100n, '2025-06-01', '2026-06-01'), consume('c1', 40n, '2025-09-01'));
    const fold = foldExpiry(ledger, BUSINESS, CUSTOMER, '2026-05-31');
    expect(fold.unhorizonedPoints).toBe(0n);
    expect(fold.unattributablePoints).toBe(0n);
    expect(fold.spendablePoints).toBe(60n);
  });
});

/* ================================================================== *
 * F-11 — the reversal writer, and the hole only the DDL can close
 *
 * A challenge measured the next question after the F-01 fix: the SAME reversal
 * with `correctsId` omitted passes `validateDraft` (`corrects_ck` constrains
 * the field only when it is non-null) and is admitted as a standing grant —
 * immortal again. So the fold's closure depended on the caller CHOOSING to
 * name its target, which is the caller discipline `appendMovement`'s own
 * contract disclaims. These cases pin both halves: what the writer now makes
 * impossible, and what remains possible without it.
 * ================================================================== */

describe('buildReversalMovement — F-11, a reversal cannot omit what it corrects', () => {
  const base = () => ledgerOf(earn('e1', 100n, '2025-06-01', '2026-06-01'), consume('c1', 40n, '2025-09-01'));

  it('always writes `correctsId`, because it is a required field of its request', () => {
    const ledger = base();
    const draft = buildReversalMovement(ledger, { ...partyCount(ledger), 
      businessId: BUSINESS,
      customerId: CUSTOMER,
      sourceId: 'sale-c1',
      correctsId: 'c1',
      points: 40n,
      asOf: '2025-09-02',
      movementId: 'r1',
      reason: 'sale fully reversed',
    });
    expect(draft.correctsId).toBe('c1');
    expect(draft.movementKind).toBe('adjust');
    expect(draft.sourceType).toBe('manual_adjustment');
    expect(draft.pointsDelta).toBe(40n);
    // It invents no registry row: this is the pair the pack already specifies
    // for a correction.
    expect(SOURCE_KIND_PAIRS).toContain(`${draft.sourceType}:${draft.movementKind}`);

    // And the fold then withholds it, which is the F-01 law reached through the
    // real writer rather than through a fixture.
    const applied = appendMovement(ledger, draft).ledger;
    expect(foldExpiry(applied, BUSINESS, CUSTOMER, '2026-06-01').unattributablePoints).toBe(40n);
  });

  it('refuses a reversal that names a movement the ledger does not hold, or itself', () => {
    const ledger = base();
    const request = {
      businessId: BUSINESS,
      customerId: CUSTOMER,
      sourceId: 'sale-c1',
      points: 40n,
      asOf: '2025-09-02',
      movementId: 'r1',
      reason: 'sale fully reversed',
    };
    expect(refusalCodeOf(() => buildReversalMovement(ledger, { ...partyCount(ledger),  ...request, correctsId: 'nope' }))).toBe(
      'loyalty.corrects_unknown_movement',
    );
    expect(refusalCodeOf(() => buildReversalMovement(ledger, { ...partyCount(ledger),  ...request, correctsId: 'r1' }))).toBe(
      'loyalty.corrects_self',
    );
  });

  it('RED PROOF — the hole that remains: a hand-written reversal WITHOUT `correctsId` is immortal', () => {
    // This is the challenge's measurement, kept as a test of the limit rather
    // than of the fix. It asserts the CURRENT behaviour and will go red the day
    // the DDL carries the distinction on a column the writer cannot omit, which
    // is exactly when it should be rewritten.
    const ledger = appendMovement(base(), {
      id: 'r1',
      businessId: BUSINESS,
      customerId: CUSTOMER,
      movementKind: 'adjust',
      sourceType: 'manual_adjustment',
      sourceId: 'sale-c1',
      pointsDelta: 40n,
      expiresOn: null,
      effectiveOn: '2025-09-02',
      reason: 'sale fully reversed',
      correctsId: null, // the omission, and nothing refuses it
    }).ledger;

    const onHorizon = foldExpiry(ledger, BUSINESS, CUSTOMER, '2026-06-01');
    expect(onHorizon.balancePoints).toBe(100n);
    expect(onHorizon.expiringPoints).toBe(60n);
    expect(onHorizon.spendablePoints).toBe(40n);
    expect(onHorizon.unhorizonedPoints).toBe(40n);
    expect(eligiblePoints(ledger, BUSINESS, CUSTOMER, '2026-06-01')).toBe(40n);

    // Ten years on, after a sweep would have taken the 60 it was handed.
    expect(eligiblePoints(ledger, BUSINESS, CUSTOMER, '2036-01-01')).toBe(40n);

    // The honest statement of the arm, asserted rather than asserted away: the
    // fold fails closed on a reversal that NAMES its target, and a reversal
    // that does not name one is indistinguishable from a grant.
    const named = appendMovement(
      base(),
      buildReversalMovement(base(), { ...partyCount(base()), 
        businessId: BUSINESS,
        customerId: CUSTOMER,
        sourceId: 'sale-c1',
        correctsId: 'c1',
        points: 40n,
        asOf: '2025-09-02',
        movementId: 'r2',
        reason: 'sale fully reversed',
      }),
    ).ledger;
    expect(foldExpiry(named, BUSINESS, CUSTOMER, '2026-06-01').unattributablePoints).toBe(40n);
    expect(foldExpiry(named, BUSINESS, CUSTOMER, '2026-06-01').unhorizonedPoints).toBe(0n);
  });
});

/* ================================================================== *
 * F-13 — failing closed must be as wide as the doubt and no wider
 *
 * Round 4 of the independent challenge accepted the F-01 and F-11 fixes and
 * then measured what they cost: the refusal propagated `foldExpiry` ->
 * `eligiblePoints` -> `buildSaleConsumptionMovement`, so ONE lawful full
 * return — recorded correctly, through `buildReversalMovement`, naming the row
 * it corrects — made every later redemption for that customer a 500 at the
 * till, permanently, inside the horizon, while 60 of the 100 points on that
 * ledger were perfectly attributable.
 *
 * The remedy is to withhold the QUANTITY rather than refuse the CUSTOMER. The
 * fold still never permits a spend the remainder relation would refuse, which
 * is all §A.3's cross-check contract asks of it.
 * ================================================================== */

describe('eligiblePoints — F-13, a lawful reversal withholds its own quantity and nothing else', () => {
  /** The challenge's probe: the horizon is 2027-01-01, so NOTHING here is
   *  expiring and the only question is attribution. 100 earned, 40 consumed,
   *  that sale reversed through the real writer. */
  function reversedInsideHorizon(): LoyaltyLedger {
    const ledger = ledgerOf(earn('e1', 100n, '2026-01-01', '2027-01-01'), consume('c1', 40n, '2026-03-01'));
    return appendMovement(
      ledger,
      buildReversalMovement(ledger, { ...partyCount(ledger), 
        businessId: BUSINESS,
        customerId: CUSTOMER,
        sourceId: 'sale-c1',
        correctsId: 'c1',
        points: 40n,
        asOf: '2026-03-02',
        movementId: 'r1',
        reason: 'sale fully reversed',
      }),
    ).ledger;
  }

  const spend = (points: bigint) =>
    ({
      phase: 'inside_sale_transaction',
      businessId: BUSINESS,
      customerId: CUSTOMER,
      saleId: 'sale-later',
      businessTransactionId: 'btx-later',
      points,
      asOf: '2026-06-01',
      movementId: 'mv-later',
    }) as Parameters<typeof buildSaleConsumptionMovement>[1];

  it('answers the attributable 60 and lets the customer spend them', () => {
    const ledger = reversedInsideHorizon();
    const fold = foldExpiry(ledger, BUSINESS, CUSTOMER, '2026-06-01');
    expect(fold.balancePoints).toBe(100n);
    expect(fold.expiringPoints).toBe(0n);
    expect(fold.unattributablePoints).toBe(40n);
    expect(fold.spendablePoints).toBe(60n);
    expect(eligiblePoints(ledger, BUSINESS, CUSTOMER, '2026-06-01')).toBe(60n);

    // The till, which is the surface the defect was measured at.
    const draft = buildSaleConsumptionMovement(ledger, spend(10n));
    expect(draft.pointsDelta).toBe(-10n);
    expect(draft.sourceType).toBe('sale');
    // And the whole attributable remainder, to the point, not one past it.
    const whole = buildSaleConsumptionMovement(ledger, spend(60n));
    expect(whole.pointsDelta).toBe(-60n);

    // Once that remainder is actually spent, the withheld 40 do not reappear as
    // the balance nothing has drawn down. This is the sequence, not a single
    // reading: the ledger is append-only, so a quantity that comes back later
    // comes back for good.
    const afterSpend = appendMovement(ledger, whole).ledger;
    const fold2 = foldExpiry(afterSpend, BUSINESS, CUSTOMER, '2026-06-01');
    expect(fold2.balancePoints).toBe(40n);
    expect(fold2.unattributablePoints).toBe(40n);
    expect(fold2.spendablePoints).toBe(0n);
    expect(eligiblePoints(afterSpend, BUSINESS, CUSTOMER, '2026-06-01')).toBe(0n);
  });

  it('still refuses the 40 it withheld — withholding is not permitting', () => {
    const ledger = reversedInsideHorizon();
    for (const points of [61n, 70n, 100n]) {
      expect(refusalCodeOf(() => buildSaleConsumptionMovement(ledger, spend(points)))).toBe(
        'loyalty.insufficient_eligible_points',
      );
    }
    // The refusal states the bound it enforced, so the 40 are visibly absent
    // from what was offered rather than silently added to it.
    let refusal: unknown;
    try {
      buildSaleConsumptionMovement(ledger, spend(61n));
    } catch (error) {
      refusal = error;
    }
    const thrown = must(refusal instanceof LoyaltyRefusal ? refusal : null, 'a loyalty refusal');
    expect(thrown.context.available).toBe('60');
    expect(thrown.context.requested).toBe('61');
  });

  it('RED PROOF — the fold this replaced refused every spend on that ledger', () => {
    // The previous shipped predicate, restated exactly: a positive non-earn row
    // naming a correction REFUSED the fold. Driven over the same lawful ledger
    // it reproduces the figure the challenge measured — no quantity is
    // spendable, not even the 60 nothing was ever in doubt about.
    const refusingEligible = (ledger: LoyaltyLedger, asOf: string): bigint => {
      for (const m of ledger.movements) {
        if (m.movementKind === 'earn') continue;
        if (m.pointsDelta < 0n) continue;
        if (m.correctsId !== null || m.sourceType !== 'manual_adjustment') {
          throw new LoyaltyRefusal('loyalty.unattributable_positive_movement', 'the old predicate', {
            movementId: m.id,
          });
        }
      }
      return eligiblePoints(ledger, BUSINESS, CUSTOMER, assertCivilDate(asOf, 'asOf'));
    };

    const ledger = reversedInsideHorizon();
    for (const asOf of ['2026-03-02', '2026-06-01', '2026-12-31']) {
      expect(() => refusingEligible(ledger, asOf)).toThrow(LoyaltyRefusal);
    }

    // The canary: the shipped path answers all three, and answers 60 — the
    // quantity the broken one could not report at any date.
    for (const asOf of ['2026-03-02', '2026-06-01', '2026-12-31']) {
      expect(eligiblePoints(ledger, BUSINESS, CUSTOMER, asOf)).toBe(60n);
    }
  });

  it('withholds across SEVERAL reversals and keeps the arithmetic exact', () => {
    // Two reversals, so the figure cannot be the single row's points under
    // another name, and one standing grant, so the two un-lot-backed totals are
    // measured apart from each other on one ledger.
    const first = ledgerOf(
      earn('e1', 100n, '2026-01-01', '2027-01-01'),
      consume('c1', 40n, '2026-03-01'),
      consume('c2', 25n, '2026-03-05'),
      adjust('g1', 7n, '2026-03-06', 'merchant goodwill'),
    );
    const reverse = (ledger: LoyaltyLedger, target: string, points: bigint, id: string, day: string) =>
      appendMovement(
        ledger,
        buildReversalMovement(ledger, { ...partyCount(ledger), 
          businessId: BUSINESS,
          customerId: CUSTOMER,
          sourceId: `sale-${target}`,
          correctsId: target,
          points,
          asOf: day,
          movementId: id,
          reason: 'sale fully reversed',
        }),
      ).ledger;
    const ledger = reverse(reverse(first, 'c1', 40n, 'r1', '2026-03-02'), 'c2', 25n, 'r2', '2026-03-07');

    const fold = foldExpiry(ledger, BUSINESS, CUSTOMER, '2026-06-01');
    expect(fold.balancePoints).toBe(107n); // 100 - 40 - 25 + 7 + 40 + 25
    expect(fold.unattributablePoints).toBe(65n);
    expect(fold.unhorizonedPoints).toBe(7n);
    expect(fold.spendablePoints).toBe(42n); // 35 left in the lot, plus the grant
    expect(eligiblePoints(ledger, BUSINESS, CUSTOMER, '2026-06-01')).toBe(42n);
    // The identity the figure has to satisfy, asserted rather than assumed.
    expect(fold.balancePoints - fold.expiringPoints - fold.unattributablePoints).toBe(42n);
  });

  it('never offers more than the lot-backed remainder once the horizon passes', () => {
    // The bound that made refusing attractive in the first place: after the
    // horizon the withheld quantity must not reappear as the balance the sweep
    // has not yet taken.
    const ledger = reversedInsideHorizon();
    const after = foldExpiry(ledger, BUSINESS, CUSTOMER, '2027-01-01');
    expect(after.expiringPoints).toBe(60n);
    expect(after.unattributablePoints).toBe(40n);
    expect(after.spendablePoints).toBe(0n);
    expect(eligiblePoints(ledger, BUSINESS, CUSTOMER, '2027-01-01')).toBe(0n);
    expect(refusalCodeOf(() => buildSaleConsumptionMovement(ledger, { ...spend(1n), asOf: '2027-01-01' }))).toBe(
      'loyalty.insufficient_eligible_points',
    );
  });
});

/* ================================================================== *
 * F-14, F-15, F-16 — a correction is attributed through the row it corrects
 *
 * Round 5 of the independent challenge accepted the F-13 remedy and then
 * measured what it still got wrong. The withheld quantity was subtracted from
 * the WHOLE balance, and the whole balance held points the withholding has no
 * claim on, because the fold drew on lots only: the overflow was discarded and
 * an un-horizoned grant was never drawn down at all.
 *
 * So the fold is now a sequential replay over three stores — dated lots, the
 * un-horizoned pool, and the withheld quantity — and a correction is attributed
 * through the row it corrects, in both signs. Every fixture below goes through
 * this package's own writers except where a case says otherwise and says why.
 * ================================================================== */

describe('foldExpiry — F-14, a reversal withholds only the part its target drew from a LOT', () => {
  const sale = (points: bigint, asOf: string, movementId: string) =>
    ({
      phase: 'inside_sale_transaction',
      businessId: BUSINESS,
      customerId: CUSTOMER,
      saleId: `sale-${movementId}`,
      businessTransactionId: `btx-${movementId}`,
      points,
      asOf,
      movementId,
    }) as Parameters<typeof buildSaleConsumptionMovement>[1];

  /** The challenge's fixture, every row through a lawful writer: a standing
   *  grant of 30, one lot of 10 with a horizon well in the future, a spend of
   *  40 that SPANS both — eligible was exactly 40, so the writer allowed it —
   *  and that sale fully returned. */
  function grantAndLotSpanned(spend: bigint): LoyaltyLedger {
    let ledger = ledgerOf(
      adjust('g1', 30n, '2026-01-01', 'merchant goodwill'),
      earn('e1', 10n, '2026-01-02', '2027-01-01'),
    );
    ledger = appendMovement(ledger, buildSaleConsumptionMovement(ledger, sale(spend, '2026-01-03', 'c1'))).ledger;
    return appendMovement(
      ledger,
      buildReversalMovement(ledger, { ...partyCount(ledger), 
        businessId: BUSINESS,
        customerId: CUSTOMER,
        sourceId: 'sale-c1',
        correctsId: 'c1',
        points: spend,
        asOf: '2026-01-04',
        movementId: 'r1',
        reason: 'sale fully reversed',
      }),
    ).ledger;
  }

  it('leaves the grant spendable at every date, where it used to withhold all 40', () => {
    const ledger = grantAndLotSpanned(40n);
    for (const asOf of ['2026-06-01', '2027-06-01', '2040-01-01']) {
      const fold = foldExpiry(ledger, BUSINESS, CUSTOMER, asOf);
      expect(fold.balancePoints).toBe(40n);
      expect(fold.unhorizonedPoints).toBe(30n);
      // Only the 10 the spend took from the lot is un-attributable.
      expect(fold.unattributablePoints).toBe(10n);
      expect(fold.spendablePoints).toBe(30n);
      expect(eligiblePoints(ledger, BUSINESS, CUSTOMER, asOf)).toBe(30n);
    }
    // The surface the defect was measured at: the till now takes the grant.
    expect(buildSaleConsumptionMovement(ledger, sale(30n, '2026-06-01', 'c2')).pointsDelta).toBe(-30n);
  });

  it('agrees exactly with the control whose spend stayed inside the lot', () => {
    // The challenge separated cause from shape with this pair: the same four
    // movements with the spend inside the lot were already correct, so any
    // difference between the two is the over-draw and nothing else.
    const spanned = foldExpiry(grantAndLotSpanned(40n), BUSINESS, CUSTOMER, '2026-06-01');
    const inside = foldExpiry(grantAndLotSpanned(10n), BUSINESS, CUSTOMER, '2026-06-01');
    expect(spanned.unattributablePoints).toBe(inside.unattributablePoints);
    expect(spanned.spendablePoints).toBe(inside.spendablePoints);
    expect(eligiblePoints(grantAndLotSpanned(40n), BUSINESS, CUSTOMER, '2026-06-01')).toBe(
      eligiblePoints(grantAndLotSpanned(10n), BUSINESS, CUSTOMER, '2026-06-01'),
    );
  });

  it('RED PROOF — the two-pass fold this replaced reported eligible 0 on that ledger', () => {
    // The previous shape, restated: one `draw` total applied to the lots, the
    // overflow discarded, the grant never drawn, and the whole restored
    // quantity withheld. Over the same lawful ledger it reproduces the figures
    // the challenge measured — eligible 0 at every date, permanently.
    const rows = grantAndLotSpanned(40n).movements;
    const brokenFold = (asOf: string) => {
      let unhorizoned = 0n;
      let unattributable = 0n;
      let draw = 0n;
      for (const m of rows) {
        if (m.movementKind === 'earn') continue;
        if (m.pointsDelta < 0n) draw += -m.pointsDelta;
        else if (m.correctsId !== null) unattributable += m.pointsDelta;
        else unhorizoned += m.pointsDelta;
      }
      const lots = rows
        .filter((m) => m.movementKind === 'earn')
        .map((m) => ({ expiresOn: must(m.expiresOn, 'an earn horizon'), remaining: m.pointsDelta }));
      for (const lot of lots) {
        const take = lot.remaining < draw ? lot.remaining : draw;
        lot.remaining -= take;
        draw -= take; // and whatever is left is DISCARDED, which is the defect
      }
      const expiring = lots.filter((l) => l.expiresOn <= asOf).reduce((acc, l) => acc + l.remaining, 0n);
      const spendableFromLots = lots.filter((l) => l.expiresOn > asOf).reduce((acc, l) => acc + l.remaining, 0n);
      const balance = 30n + 10n - 40n + 40n;
      const eligible = balance - expiring - unattributable;
      return {
        spendablePoints: spendableFromLots + unhorizoned,
        unattributablePoints: unattributable,
        eligible: eligible > 0n ? eligible : 0n,
      };
    };

    for (const asOf of ['2026-06-01', '2027-06-01', '2040-01-01']) {
      const broken = brokenFold(asOf);
      expect(broken.unattributablePoints).toBe(40n);
      expect(broken.eligible).toBe(0n);
      // And the figure that made it silent rather than loud: the fold's own
      // spendable said 30 while nothing could be spent.
      expect(broken.spendablePoints).toBe(30n);
    }

    // The canary: the shipped fold answers 30 at every one of those dates.
    const ledger = grantAndLotSpanned(40n);
    for (const asOf of ['2026-06-01', '2027-06-01', '2040-01-01']) {
      expect(eligiblePoints(ledger, BUSINESS, CUSTOMER, asOf)).toBe(30n);
    }
  });

  it('F-15 — the pool is DRAWN DOWN, so `spendablePoints` cannot exceed the balance', () => {
    // Both of the challenge's measurements, which reported 30 against a balance
    // of 20 and 50 against a balance of 15.
    let a = ledgerOf(adjust('g1', 30n, '2026-01-01', 'merchant goodwill'));
    a = appendMovement(a, buildSaleConsumptionMovement(a, sale(10n, '2026-01-03', 'c1'))).ledger;
    const foldA = foldExpiry(a, BUSINESS, CUSTOMER, '2026-06-01');
    expect(foldA.balancePoints).toBe(20n);
    expect(foldA.spendablePoints).toBe(20n);
    expect(foldA.unhorizonedPoints).toBe(20n);

    let b = ledgerOf(adjust('g1', 50n, '2026-01-01', 'merchant goodwill'), earn('e1', 5n, '2026-01-02', '2027-01-01'));
    b = appendMovement(b, buildSaleConsumptionMovement(b, sale(40n, '2026-01-03', 'c1'))).ledger;
    const foldB = foldExpiry(b, BUSINESS, CUSTOMER, '2026-06-01');
    expect(foldB.balancePoints).toBe(15n);
    expect(foldB.spendablePoints).toBe(15n);
    // The lot went first and the pool took the rest: 5 from the lot, 35 from 50.
    expect(foldB.unhorizonedPoints).toBe(15n);
    expect(must(foldB.lots[0], 'the lot').remainingPoints).toBe(0n);
  });

  it('F-16 — a negative correction of a restoring row discharges what that row credited', () => {
    // `validateDraft` admits a negative `manual_adjustment` naming its target —
    // A-16's hand correction, and the lawful way to record that a return was
    // itself cancelled. `buildReversalMovement` cannot write it (it refuses a
    // non-positive quantity), so the last row is written through
    // `appendMovement` directly, which is the registry's own law.
    let ledger = ledgerOf(earn('e1', 100n, '2026-01-01', '2027-01-01'));
    ledger = appendMovement(ledger, buildSaleConsumptionMovement(ledger, sale(40n, '2026-01-02', 'c1'))).ledger;
    ledger = appendMovement(
      ledger,
      buildReversalMovement(ledger, { ...partyCount(ledger), 
        businessId: BUSINESS,
        customerId: CUSTOMER,
        sourceId: 'sale-c1',
        correctsId: 'c1',
        points: 40n,
        asOf: '2026-01-03',
        movementId: 'r1',
        reason: 'sale fully reversed',
      }),
    ).ledger;
    const withTheReturn = foldExpiry(ledger, BUSINESS, CUSTOMER, '2026-06-01');
    expect(withTheReturn.unattributablePoints).toBe(40n);
    expect(eligiblePoints(ledger, BUSINESS, CUSTOMER, '2026-06-01')).toBe(60n);

    ledger = appendMovement(
      ledger,
      adjust('x1', -40n, '2026-01-05', 'the return was itself cancelled; the sale stands', 'r1'),
    ).ledger;
    const fold = foldExpiry(ledger, BUSINESS, CUSTOMER, '2026-06-01');
    expect(fold.balancePoints).toBe(60n);
    // The withheld quantity is DISCHARGED by the row that cancels it, and the
    // lot that never funded the restoration is left alone.
    expect(fold.unattributablePoints).toBe(0n);
    expect(fold.spendablePoints).toBe(60n);
    expect(eligiblePoints(ledger, BUSINESS, CUSTOMER, '2026-06-01')).toBe(60n);
    expect(buildSaleConsumptionMovement(ledger, sale(60n, '2026-06-01', 'c9')).pointsDelta).toBe(-60n);
  });

  it('F-16 — the conservation identity alone cannot tell the two errors apart', () => {
    // Why the identity is not the proof: the broken fold satisfied it exactly
    // while being wrong by 40 twice over. 60 = 0 expiring + 20 spendable + 40
    // withheld, on a ledger whose truth is 60 spendable and 0 withheld. So the
    // identity is asserted AND the per-store figures are asserted beside it.
    expect(60n).toBe(0n + 20n + 40n);
    expect(60n).toBe(0n + 60n + 0n);
  });

  it('conserves: the balance is exactly the lots, the pool and the withheld quantity', () => {
    // The identity the replay makes true by construction, asserted on a ledger
    // that exercises every store at once.
    let ledger = ledgerOf(
      adjust('g1', 30n, '2026-01-01', 'merchant goodwill'),
      earn('e1', 10n, '2026-01-02', '2026-06-01'),
      earn('e2', 50n, '2026-01-02', '2027-01-01'),
    );
    ledger = appendMovement(ledger, buildSaleConsumptionMovement(ledger, sale(45n, '2026-01-03', 'c1'))).ledger;
    ledger = appendMovement(
      ledger,
      buildReversalMovement(ledger, { ...partyCount(ledger), 
        businessId: BUSINESS,
        customerId: CUSTOMER,
        sourceId: 'sale-c1',
        correctsId: 'c1',
        points: 45n,
        asOf: '2026-01-04',
        movementId: 'r1',
        reason: 'sale fully reversed',
      }),
    ).ledger;
    for (const asOf of ['2026-02-01', '2026-06-01', '2027-06-01']) {
      const fold = foldExpiry(ledger, BUSINESS, CUSTOMER, asOf);
      const inLots = fold.lots.reduce((acc, l) => acc + l.remainingPoints, 0n);
      expect(inLots + fold.unhorizonedPoints + fold.unattributablePoints).toBe(fold.balancePoints);
      // And the eligible figure is never wider than the stores can back.
      expect(eligiblePoints(ledger, BUSINESS, CUSTOMER, asOf)).toBeLessThanOrEqual(fold.spendablePoints);
    }
  });
});

describe('foldExpiry — the property the challenge probed, as a deterministic case', () => {
  // The round-5 challenge ran 4 000 pseudo-random ledgers at three dates and
  // found no case where the fold offered more than its stores can back. That
  // probe lived in its container and not in this suite, so the property is
  // asserted here over a SEEDED generator: same ledgers every run, no flake,
  // and a mutation that over-permits is caught by the property rather than by a
  // fixture that happens to cover it.
  const seeded = (seed: number) => {
    let state = seed >>> 0;
    return (bound: number) => {
      // xorshift32 — deterministic, and its quality does not matter here.
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state % bound;
    };
  };

  /** The number of ledgers in the run below that actually carry a reversal.
   *  Asserted exactly rather than as a floor: the seed is fixed, so this is a
   *  measurement, and a change to the generator that quietly stops exercising
   *  the reversal path reds this case instead of passing for the wrong reason. */
  const WITH_REVERSALS = 193;
  /** Likewise measurements, and likewise exact: the number of ledgers carrying
   *  a negative hand correction, and the number of (ledger, date) pairs the
   *  one-step law stops on because a draw outran its capacity. */
  const WITH_NEGATIVE_CORRECTIONS = 31;
  const BAILED_OUT = 0;

  /** THE PER-ROW LAWS, each component against its own expected value.
   *
   *  `F-20`: what stood here before was the three stores summing to the
   *  balance — the very identity `F-16` showed a PAIR of compensating errors
   *  can satisfy exactly (60 = 0 + 20 + 40 on a ledger whose truth is
   *  0 + 60 + 0). An identity over a sum cannot name which store is wrong, so
   *  the challenger re-planted `F-16`'s defect and the sum rule passed it.
   *
   *  So each row is now checked on its OWN step: the fold is read on the
   *  prefix before the row and on the prefix including it, and the expected
   *  after-value of EVERY component — each lot's remainder by name, the pool,
   *  the withheld quantity, the balance, the spendable and expiring figures —
   *  is computed here from the before-state and the row alone. This is not a
   *  second replay: it holds no stores of its own and carries no balance
   *  forward. It takes the capacity from the fold at each step and asks only
   *  whether THIS row moved the right quantity out of the right store, which
   *  is the question a compensating pair is built to escape.
   *
   *  ITS DECLARED LIMITS. It encodes the same LAWS the fold claims (§4.3's
   *  oldest-horizon-first order, a correction attributed through the row it
   *  corrects, a grant drawn after the lots), so a wrong law would be wrong in
   *  both; what it measures is whether the fold computes the laws it states,
   *  per store. And it covers a FUNDED ledger: on a draw with nothing to draw
   *  on, the claim is queued and settled by a later row, the one-step law no
   *  longer holds for the rows after it, and the check stops rather than
   *  reporting a violation it cannot attribute. The unfunded path has its own
   *  hand-built cases in the block below, and the number of ledgers that stop
   *  here is asserted exactly. */
  const stepLawViolations = (ledger: LoyaltyLedger, asOf: string): { bad: string[]; bailed: boolean } => {
    const rows = ledger.movements
      .filter((m) => m.businessId === BUSINESS && m.customerId === CUSTOMER && m.effectiveOn <= asOf)
      .slice()
      .sort((a, b) => (a.pointSeq < b.pointSeq ? -1 : a.pointSeq > b.pointSeq ? 1 : 0));
    const bad: string[] = [];
    const smaller = (a: bigint, b: bigint) => (a < b ? a : b);
    /** What a positive row put in each store, less what later rows discharged. */
    const creditPool = new Map<string, bigint>();
    const creditWithheld = new Map<string, bigint>();
    /** What a negative row drew from each store, less what restorations claimed. */
    const drawLots = new Map<string, bigint>();
    const drawPool = new Map<string, bigint>();

    for (let k = 0; k < rows.length; k += 1) {
      const m = must(rows[k], `row ${k}`);
      const before = foldExpiry({ movements: rows.slice(0, k) }, BUSINESS, CUSTOMER, asOf);
      const after = foldExpiry({ movements: rows.slice(0, k + 1) }, BUSINESS, CUSTOMER, asOf);
      const pool = before.unhorizonedPoints;
      const withheld = before.unattributablePoints;
      const expectedLots = new Map<string, bigint>(before.lots.map((l) => [l.movementId, l.remainingPoints]));
      let expectedPool = pool;
      let expectedWithheld = withheld;

      if (m.movementKind === 'earn') {
        if (m.expiresOn !== null) {
          expectedLots.set(m.id, m.pointsDelta);
        } else {
          expectedPool = pool + m.pointsDelta;
          creditPool.set(m.id, m.pointsDelta);
        }
      } else if (m.pointsDelta < 0n) {
        let left = -m.pointsDelta;
        let takenLots = 0n;
        let takenPool = 0n;
        let takenWithheld = 0n;
        if (m.correctsId !== null) {
          // The stores the TARGET credited are discharged first, and only as
          // far as the target itself credited them.
          const cw = creditWithheld.get(m.correctsId) ?? 0n;
          const takeW = smaller(smaller(cw, left), withheld);
          creditWithheld.set(m.correctsId, cw - takeW);
          takenWithheld += takeW;
          left -= takeW;
          const cp = creditPool.get(m.correctsId) ?? 0n;
          const takeP = smaller(smaller(cp, left), pool);
          creditPool.set(m.correctsId, cp - takeP);
          takenPool += takeP;
          left -= takeP;
        }
        for (const lot of before.lots
          .slice()
          .sort((a, b) =>
            a.expiresOn < b.expiresOn
              ? -1
              : a.expiresOn > b.expiresOn
                ? 1
                : a.pointSeq < b.pointSeq
                  ? -1
                  : a.pointSeq > b.pointSeq
                    ? 1
                    : 0,
          )) {
          if (left <= 0n) break;
          const take = smaller(lot.remainingPoints, left);
          expectedLots.set(lot.movementId, lot.remainingPoints - take);
          takenLots += take;
          left -= take;
        }
        const morePool = smaller(left, pool - takenPool);
        takenPool += morePool;
        left -= morePool;
        const moreWithheld = smaller(left, withheld - takenWithheld);
        takenWithheld += moreWithheld;
        left -= moreWithheld;
        expectedPool = pool - takenPool;
        expectedWithheld = withheld - takenWithheld;
        drawLots.set(m.id, takenLots);
        drawPool.set(m.id, takenPool);
        if (left > 0n) return { bad, bailed: true };
      } else if (m.correctsId === null) {
        expectedPool = pool + m.pointsDelta;
        creditPool.set(m.id, m.pointsDelta);
      } else {
        // A restoration restores what its target actually drew: the lot-backed
        // part is un-attributable and is withheld, the pool-backed part goes
        // straight back, and anything beyond what the target drew is withheld.
        const lotDrawn = drawLots.get(m.correctsId) ?? 0n;
        const poolDrawn = drawPool.get(m.correctsId) ?? 0n;
        const lotPart = smaller(lotDrawn, m.pointsDelta);
        const poolPart = smaller(poolDrawn, m.pointsDelta - lotPart);
        drawLots.set(m.correctsId, lotDrawn - lotPart);
        drawPool.set(m.correctsId, poolDrawn - poolPart);
        expectedPool = pool + poolPart;
        expectedWithheld = withheld + (m.pointsDelta - poolPart);
        creditPool.set(m.id, poolPart);
        creditWithheld.set(m.id, m.pointsDelta - poolPart);
      }

      const reported = new Map<string, bigint>(after.lots.map((l) => [l.movementId, l.remainingPoints]));
      if (reported.size !== expectedLots.size) {
        bad.push(`${m.id}: ${reported.size} lots reported where ${expectedLots.size} are expected`);
      }
      for (const [id, want] of expectedLots) {
        const got = reported.get(id);
        if (got !== want) bad.push(`${m.id}: lot ${id} expected ${want}, fold says ${String(got)}`);
      }
      if (after.unhorizonedPoints !== expectedPool) {
        bad.push(`${m.id}: pool expected ${expectedPool}, fold says ${after.unhorizonedPoints}`);
      }
      if (after.unattributablePoints !== expectedWithheld) {
        bad.push(`${m.id}: withheld expected ${expectedWithheld}, fold says ${after.unattributablePoints}`);
      }
      if (after.balancePoints !== before.balancePoints + m.pointsDelta) {
        bad.push(`${m.id}: balance expected ${before.balancePoints + m.pointsDelta}, fold says ${after.balancePoints}`);
      }
      const spendable =
        after.lots.reduce((acc, l) => (l.expiresOn > asOf ? acc + l.remainingPoints : acc), 0n) +
        after.unhorizonedPoints;
      if (after.spendablePoints !== spendable) {
        bad.push(`${m.id}: spendable expected ${spendable}, fold says ${after.spendablePoints}`);
      }
      const expiring = after.lots.reduce((acc, l) => (l.expiresOn <= asOf ? acc + l.remainingPoints : acc), 0n);
      const boundedExpiring =
        expiring > after.balancePoints ? (after.balancePoints > 0n ? after.balancePoints : 0n) : expiring;
      if (after.expiringPoints !== boundedExpiring) {
        bad.push(`${m.id}: expiring expected ${boundedExpiring}, fold says ${after.expiringPoints}`);
      }
    }
    return { bad, bailed: false };
  };

  it('never offers more than the lots and the pool can back, over 2 000 seeded ledgers', () => {
    const rand = seeded(20261012);
    const dates = ['2026-06-01', '2027-06-01', '2040-01-01'];
    let built = 0;
    let withReversals = 0;
    let withNegativeCorrections = 0;
    let breaches = 0;
    let conservationBreaches = 0;
    let bailedOut = 0;
    const stepViolations: string[] = [];

    for (let i = 0; i < 2000; i += 1) {
      let ledger = emptyLedger();
      let seq = 0;
      const steps = 3 + rand(4);
      for (let step = 0; step < steps; step += 1) {
        seq += 1;
        const day = `2026-01-${String(10 + seq).padStart(2, '0')}`;
        const roll = rand(5);
        try {
          if (roll === 0) {
            ledger = appendMovement(ledger, earn(`e${seq}`, BigInt(1 + rand(60)), day, rand(2) === 0 ? '2026-09-01' : '2028-09-01')).ledger;
          } else if (roll === 1) {
            ledger = appendMovement(ledger, adjust(`g${seq}`, BigInt(1 + rand(40)), day, 'merchant goodwill')).ledger;
          } else if (roll === 2) {
            const points = BigInt(1 + rand(50));
            if (eligiblePoints(ledger, BUSINESS, CUSTOMER, day) < points) continue;
            ledger = appendMovement(
              ledger,
              buildSaleConsumptionMovement(ledger, {
                phase: 'inside_sale_transaction',
                businessId: BUSINESS,
                customerId: CUSTOMER,
                saleId: `sale-${seq}`,
                businessTransactionId: `btx-${seq}`,
                points,
                asOf: day,
                movementId: `c${seq}`,
              } as Parameters<typeof buildSaleConsumptionMovement>[1]),
            ).ledger;
          } else if (roll === 4) {
            // `F-20`: a NEGATIVE hand correction of a restoring row — `A-16`'s
            // lawful record that a return was itself cancelled, and the exact
            // shape `F-16`'s defect lived in. The generator produced none of
            // these before, so the store the defect moved points out of was
            // never exercised by this case at all.
            const credit = ledger.movements.find(
              (m) =>
                m.pointsDelta > 0n &&
                m.correctsId !== null &&
                !ledger.movements.some((o) => o.correctsId === m.id),
            );
            if (credit === undefined) continue;
            ledger = appendMovement(
              ledger,
              adjust(`x${seq}`, -credit.pointsDelta, day, 'the return was itself cancelled; the sale stands', credit.id),
            ).ledger;
            withNegativeCorrections += 1;
          } else {
            const target = ledger.movements.find((m) => m.movementKind === 'consume' && m.correctsId === null);
            if (target === undefined) {
              // Nothing to reverse yet, so spend instead rather than wasting the
              // step: a generator that mostly idles produces few reversals, and
              // the reversal path is the one this property exists for.
              const points = BigInt(1 + rand(30));
              if (eligiblePoints(ledger, BUSINESS, CUSTOMER, day) < points) continue;
              ledger = appendMovement(
                ledger,
                buildSaleConsumptionMovement(ledger, {
                  phase: 'inside_sale_transaction',
                  businessId: BUSINESS,
                  customerId: CUSTOMER,
                  saleId: `sale-${seq}`,
                  businessTransactionId: `btx-${seq}`,
                  points,
                  asOf: day,
                  movementId: `c${seq}`,
                } as Parameters<typeof buildSaleConsumptionMovement>[1]),
              ).ledger;
              continue;
            }
            if (ledger.movements.some((m) => m.correctsId === target.id)) continue;
            ledger = appendMovement(
              ledger,
              buildReversalMovement(ledger, { ...partyCount(ledger), 
                businessId: BUSINESS,
                customerId: CUSTOMER,
                sourceId: target.sourceId,
                correctsId: target.id,
                points: -target.pointsDelta,
                asOf: day,
                movementId: `r${seq}`,
                reason: 'sale fully reversed',
              }),
            ).ledger;
            withReversals += 1;
          }
        } catch (error) {
          // A refusal is a lawful outcome for a generated step; the ledger is
          // simply left as it was. Anything that is NOT a refusal is a defect
          // and must not be swallowed.
          if (!(error instanceof LoyaltyRefusal)) throw error;
        }
      }
      built += 1;

      for (const asOf of dates) {
        const fold = foldExpiry(ledger, BUSINESS, CUSTOMER, asOf);
        if (eligiblePoints(ledger, BUSINESS, CUSTOMER, asOf) > fold.spendablePoints) breaches += 1;
        const inLots = fold.lots.reduce((acc, l) => acc + l.remainingPoints, 0n);
        if (inLots + fold.unhorizonedPoints + fold.unattributablePoints !== fold.balancePoints) {
          conservationBreaches += 1;
        }
        const step = stepLawViolations(ledger, asOf);
        if (step.bailed) bailedOut += 1;
        for (const violation of step.bad) stepViolations.push(violation);
      }
    }

    expect(built).toBe(2000);
    // EACH COMPONENT against its own expected value, row by row. The first few
    // violations are reported rather than a count, so a failure names the row,
    // the store and both figures instead of saying how many went wrong.
    expect(stepViolations.slice(0, 8)).toEqual([]);
    // Non-vacuity, because a generator that never produced a reversal would
    // make the whole property pass for the wrong reason.
    expect(withReversals).toBe(WITH_REVERSALS);
    expect(withNegativeCorrections).toBe(WITH_NEGATIVE_CORRECTIONS);
    // The ledgers the one-step law does not cover, measured and not hidden: a
    // draw that outran its capacity is settled by a later row, so the step
    // check stops there. A change that quietly sent most of the run down that
    // path would show up here as a number, not as a silently weaker property.
    expect(bailedOut).toBe(BAILED_OUT);
    expect(breaches).toBe(0);
    expect(conservationBreaches).toBe(0);
  });
});

describe('foldExpiry — restoring MORE than the target drew, and a draw with nothing to draw on', () => {
  const sale = (points: bigint, asOf: string, movementId: string) =>
    ({
      phase: 'inside_sale_transaction',
      businessId: BUSINESS,
      customerId: CUSTOMER,
      saleId: `sale-${movementId}`,
      businessTransactionId: `btx-${movementId}`,
      points,
      asOf,
      movementId,
    }) as Parameters<typeof buildSaleConsumptionMovement>[1];

  it('F-21 — the WRITER refuses a reversal larger than the row it corrects took', () => {
    // Round 1 of the challenge listed over-restoration among the laws it could
    // not break; under the replay it was absorbed without limit, and the change
    // had not been recorded. Measured before the fix: a 1,000,000-point
    // "reversal" of a 40-point consumption reported `balancePoints` 1,000,060.
    // Redemption stayed correct, but that figure is what a customer screen and
    // a CRM read show, so one hand correction could set it to any value.
    let ledger = ledgerOf(earn('e1', 100n, '2026-01-01', '2027-01-01'));
    ledger = appendMovement(ledger, buildSaleConsumptionMovement(ledger, sale(40n, '2026-01-02', 'c1'))).ledger;
    const request = {
      businessId: BUSINESS,
      customerId: CUSTOMER,
      sourceId: 'sale-c1',
      correctsId: 'c1',
      asOf: '2026-01-03',
      movementId: 'r1',
      reason: 'sale fully reversed',
    };
    for (const points of [41n, 50n, 500n, 1000000n]) {
      expect(refusalCodeOf(() => buildReversalMovement(ledger, { ...partyCount(ledger),  ...request, points }))).toBe(
        'loyalty.corrects_more_than_target',
      );
    }
    // The bound is the row's own magnitude and not a partial-return rule:
    // `§5.7.4` leaves the quantity of a partial return to configuration, so
    // anything up to what the row took is still built.
    expect(buildReversalMovement(ledger, { ...partyCount(ledger),  ...request, points: 40n }).pointsDelta).toBe(40n);
    expect(buildReversalMovement(ledger, { ...partyCount(ledger),  ...request, points: 1n }).pointsDelta).toBe(1n);

    // F-22 — AND THE DATE. This case exists because a mutation run found the
    // ordering guard was written with no case behind it: removing it reddened
    // nothing, which is the same defect as a comment promising a protection
    // the code does not give. A correction dated before the row it corrects is
    // visible at a date its target is not, so the fold reads a restoration of a
    // draw that has not happened yet and withholds the whole quantity — the
    // conservative answer to a row that should not exist.
    expect(refusalCodeOf(() => buildReversalMovement(ledger, { ...partyCount(ledger),  ...request, points: 40n, asOf: '2026-01-01' }))).toBe(
      'loyalty.corrects_out_of_order',
    );
    // The boundary itself is lawful: a correction ON its target's own date is
    // built, because §4.1's dates are civil dates and carry no time of day.
    expect(buildReversalMovement(ledger, { ...partyCount(ledger),  ...request, points: 40n, asOf: '2026-01-02' }).pointsDelta).toBe(40n);

    // AND THE HARM THE GUARD STOPS, hand-built because the writer now refuses
    // it and the DDL still permits it. The challenge measured a consumption
    // dated after its own reversal: at a date where the reversal is visible and
    // the consumption is not, the ledger reports a balance of 140 for a
    // customer who has earned 100. Redemption is not over-offered — the lot
    // backs 100 — so this is a reporting and attribution defect, and it heals
    // once the target becomes visible. It is asserted here so the figure in
    // §A.3c.3 of the patch request is a measurement and not a recollection.
    const outOfOrder: LoyaltyLedger = {
      movements: [
        {
          id: 'e9', businessId: BUSINESS, customerId: CUSTOMER, pointSeq: 1n,
          movementKind: 'earn', sourceType: 'sale', sourceId: 'sale-e9',
          pointsDelta: 100n, expiresOn: '2027-01-01', effectiveOn: '2026-01-01',
          reason: null, correctsId: null,
        },
        {
          id: 'c9', businessId: BUSINESS, customerId: CUSTOMER, pointSeq: 2n,
          movementKind: 'consume', sourceType: 'sale', sourceId: 'sale-c9',
          pointsDelta: -40n, expiresOn: null, effectiveOn: '2026-09-01',
          reason: null, correctsId: null,
        },
        {
          id: 'r9', businessId: BUSINESS, customerId: CUSTOMER, pointSeq: 3n,
          movementKind: 'adjust', sourceType: 'manual_adjustment', sourceId: 'adj-r9',
          pointsDelta: 40n, expiresOn: null, effectiveOn: '2026-03-01',
          reason: 'sale fully reversed', correctsId: 'c9',
        },
      ],
    };
    const early = foldExpiry(outOfOrder, BUSINESS, CUSTOMER, '2026-05-01');
    expect(early.balancePoints).toBe(140n);
    expect(early.unattributablePoints).toBe(40n);
    expect(early.spendablePoints).toBe(100n);
    expect(eligiblePoints(outOfOrder, BUSINESS, CUSTOMER, '2026-05-01')).toBe(100n);
    // And once the target is visible the figures are the ordinary ones again.
    const later = foldExpiry(outOfOrder, BUSINESS, CUSTOMER, '2026-12-01');
    expect(later.balancePoints).toBe(100n);
    expect(later.spendablePoints).toBe(60n);
    expect(eligiblePoints(outOfOrder, BUSINESS, CUSTOMER, '2026-12-01')).toBe(60n);

    // And the bound counts what earlier corrections already gave back, so two
    // partial restorations cannot together exceed the whole.
    const half = appendMovement(
      ledger,
      buildReversalMovement(ledger, { ...partyCount(ledger),  ...request, points: 30n, movementId: 'r1', sourceId: 'desk-1' }),
    ).ledger;
    expect(refusalCodeOf(() => buildReversalMovement(half, { ...partyCount(half),  ...request, points: 11n, movementId: 'r2', sourceId: 'desk-2' }))).toBe(
      'loyalty.corrects_more_than_target',
    );
    expect(buildReversalMovement(half, { ...partyCount(half),  ...request, points: 10n, movementId: 'r2', sourceId: 'desk-2' }).pointsDelta).toBe(10n);
  });

  it('F-23 — the bound is on the MAGNITUDE of the row named, at every sign', () => {
    // The seventh round found the `F-21` bound written inside
    // `if (corrected.pointsDelta < 0n)`, so it compared a correction of a DRAW
    // and nothing else. `§1.4` lets `correctsId` name any movement the ledger
    // holds, so a correction naming a POSITIVE row walked past the comparison
    // and restored the defect the bound was added for. Reproduced here before
    // the fix, through this writer, to the digit: naming the earn, 1,000,000
    // points were accepted and the fold read `1000060 / 0 / 60 / 0 / 1000000 /
    // 60`; naming a standing grant of 10, 999,999 were accepted and it read
    // `1000009 / 0 / 10 / 10 / 999999 / 10`. The first is byte for byte the
    // figure `F-21` was raised for, through the function that now refuses it.
    const base = (() => {
      let l = ledgerOf(earn('e1', 100n, '2026-01-01', '2027-01-01'));
      l = appendMovement(l, buildSaleConsumptionMovement(l, sale(40n, '2026-01-02', 'c1'))).ledger;
      return l;
    })();
    const ask = (ledger: LoyaltyLedger, correctsId: string, points: bigint, id = 'x1') =>
      buildReversalMovement(ledger, { ...partyCount(ledger), 
        businessId: BUSINESS, customerId: CUSTOMER, sourceId: `desk-${id}`, correctsId, points,
        asOf: '2026-01-03', movementId: id, reason: 'desk correction',
      });

    // A NEGATIVE target: the law as it already stood.
    expect(ask(base, 'c1', 40n).pointsDelta).toBe(40n);
    expect(refusalCodeOf(() => ask(base, 'c1', 41n))).toBe('loyalty.corrects_more_than_target');

    // A POSITIVE target — the earn. The bound is its own magnitude, 100.
    expect(refusalCodeOf(() => ask(base, 'e1', 1000000n))).toBe('loyalty.corrects_more_than_target');
    expect(refusalCodeOf(() => ask(base, 'e1', 101n))).toBe('loyalty.corrects_more_than_target');
    expect(ask(base, 'e1', 100n).pointsDelta).toBe(100n);
    // And it counts what earlier corrections of that row already moved.
    const after60 = appendMovement(base, ask(base, 'e1', 60n, 'x1')).ledger;
    expect(refusalCodeOf(() => ask(after60, 'e1', 41n, 'x2'))).toBe('loyalty.corrects_more_than_target');
    expect(ask(after60, 'e1', 40n, 'x2').pointsDelta).toBe(40n);

    // A POSITIVE target — a standing grant, the other shape measured.
    const withGrant = appendMovement(base, adjust('g1', 10n, '2026-01-02', 'merchant goodwill')).ledger;
    expect(refusalCodeOf(() => ask(withGrant, 'g1', 999999n))).toBe('loyalty.corrects_more_than_target');
    expect(refusalCodeOf(() => ask(withGrant, 'g1', 11n))).toBe('loyalty.corrects_more_than_target');
    expect(ask(withGrant, 'g1', 10n).pointsDelta).toBe(10n);

    // AND IT IS A NET BOUND OVER THE CHAIN, which round 9 made it (`F-25`).
    // The reading here used to be "magnitudes in either direction on this one
    // row", which refused a further point after a negative hand correction had
    // moved the same row. Under the chain invariant the quantity a chain may
    // move is its ROOT's magnitude, NET: a draw of 40 moved twice over by a
    // desk correction has a net of -40, so restoring 1 is inside the root and
    // is built, while anything that pushes the net past 40 in either direction
    // is refused by name. The change is deliberate and the figures are here so
    // the rule is read off the case rather than off a sentence.
    const twiceMoved: LoyaltyLedger = {
      movements: [
        ...base.movements,
        {
          id: 'd1', businessId: BUSINESS, customerId: CUSTOMER, pointSeq: 3n,
          movementKind: 'adjust', sourceType: 'manual_adjustment', sourceId: 'adj-d1',
          pointsDelta: -40n, expiresOn: null, effectiveOn: '2026-01-02',
          reason: 'a second desk movement against the same consumption', correctsId: 'c1',
        },
      ],
    };
    expect(ask(twiceMoved, 'c1', 1n).pointsDelta).toBe(1n);
    expect(ask(twiceMoved, 'c1', 80n).pointsDelta).toBe(80n);
    expect(refusalCodeOf(() => ask(twiceMoved, 'c1', 81n))).toBe('loyalty.corrects_more_than_target');

    // A ZERO target. `validateDraft` refuses a zero delta, so such a row exists
    // only past the writer — and a correction of a row that moved nothing is
    // refused by the same bound, which is what "the magnitude of the row named"
    // means when that magnitude is 0.
    const withZero: LoyaltyLedger = {
      movements: [
        ...base.movements,
        {
          id: 'z1', businessId: BUSINESS, customerId: CUSTOMER, pointSeq: 3n,
          movementKind: 'adjust', sourceType: 'manual_adjustment', sourceId: 'adj-z1',
          pointsDelta: 0n, expiresOn: null, effectiveOn: '2026-01-02',
          reason: 'a row the ledger itself would refuse', correctsId: null,
        },
      ],
    };
    expect(refusalCodeOf(() => appendMovement(base, {
      id: 'z9', businessId: BUSINESS, customerId: CUSTOMER, movementKind: 'adjust',
      sourceType: 'manual_adjustment', sourceId: 'adj-z9', pointsDelta: 0n,
      expiresOn: null, effectiveOn: '2026-01-02', reason: 'nothing', correctsId: null,
    }))).toBe('loyalty.movement_would_be_zero');
    expect(refusalCodeOf(() => ask(withZero, 'z1', 1n))).toBe('loyalty.corrects_more_than_target');
  });

  it('F-25 — the bound is one invariant over the whole chain, and the chain was unbounded', () => {
    // An eighth round found the bound was per LINK: each link may name the
    // PREVIOUS link, and for a freshly appended correction nothing has moved
    // that row yet, so every link passed its own comparison and nothing bounded
    // the sum. Reproduced before the fix, through this writer alone
    // (`balance / spendable / withheld / eligible`):
    //
    //   20 links on a 100-point earn          2100 / 100 / 2000 / 100
    //   2 links on a 1,000,000-point earn  3000000 / 1000000 / 2000000 / 1000000
    //   5 links on a 40-point consume       260 /  60 /  200 /  60
    //
    // A balance of 2100 for a customer who has earned 100, and TWO desk
    // corrections are enough. Redemption was never over-offered — the eligible
    // figure is the truth at every length — so it is an over-report, the class
    // `F-21` was accepted as a blocker on.
    let ledger = ledgerOf(earn('e1', 100n, '2026-01-01', '2027-01-01'));
    ledger = appendMovement(ledger, buildSaleConsumptionMovement(ledger, sale(40n, '2026-01-02', 'c1'))).ledger;
    const link = (l: LoyaltyLedger, correctsId: string, id: string, points: bigint) =>
      buildReversalMovement(l, { ...partyCount(l), 
        businessId: BUSINESS, customerId: CUSTOMER, sourceId: `desk-${id}`, correctsId, points,
        asOf: '2026-01-03', movementId: id, reason: 'desk correction',
      });

    // THE WHOLE CHAIN, AT ITS BOUND. The first link restores the draw's 40 and
    // the second — naming the first — would take the chain's net to 80.
    const first = appendMovement(ledger, link(ledger, 'c1', 'x0', 40n)).ledger;
    expect(refusalCodeOf(() => link(first, 'x0', 'x1', 40n))).toBe('loyalty.corrects_more_than_target');
    // Even one point, because the chain is already at its root's magnitude.
    expect(refusalCodeOf(() => link(first, 'x0', 'x1', 1n))).toBe('loyalty.corrects_more_than_target');

    // A DEEP CHAIN (four links), refused at the first step that crosses. Each
    // link corrects the one before it, and the bound is the root's 40 net.
    let deep = ledger;
    let target = 'c1';
    for (const [i, points] of [10n, 10n, 10n, 10n].entries()) {
      deep = appendMovement(deep, link(deep, target, `k${i}`, points)).ledger;
      target = `k${i}`;
    }
    expect(deep.movements.length).toBe(6);
    expect(refusalCodeOf(() => link(deep, target, 'k9', 1n))).toBe('loyalty.corrects_more_than_target');

    // AN ALTERNATING-SIGN CHAIN. `buildReversalMovement` builds only positive
    // quantities, so the negative link is A-16's own desk correction, written
    // past the writer — and once the chain's net falls back inside the root,
    // the next positive correction is LAWFUL again. That is why the remedy is a
    // net bound and not a refusal of corrections of corrections: "the cancel
    // was itself wrong" is a real desk sequence.
    const cancelled: LoyaltyLedger = {
      movements: [
        ...first.movements,
        {
          id: 'z0', businessId: BUSINESS, customerId: CUSTOMER, pointSeq: 4n,
          movementKind: 'adjust', sourceType: 'manual_adjustment', sourceId: 'adj-z0',
          pointsDelta: -40n, expiresOn: null, effectiveOn: '2026-01-03',
          reason: 'the restoration was itself cancelled', correctsId: 'x0',
        },
      ],
    };
    expect(link(cancelled, 'z0', 'z1', 40n).pointsDelta).toBe(40n);
    expect(refusalCodeOf(() => link(cancelled, 'z0', 'z1', 41n))).toBe('loyalty.corrects_more_than_target');

    // A ROOT THAT MOVED NOTHING admits no correction: the ledger itself refuses
    // a zero delta, so the row is hand-built, and the chain's bound is 0.
    const zeroRoot: LoyaltyLedger = {
      movements: [
        ...ledger.movements,
        {
          id: 'q0', businessId: BUSINESS, customerId: CUSTOMER, pointSeq: 3n,
          movementKind: 'adjust', sourceType: 'manual_adjustment', sourceId: 'adj-q0',
          pointsDelta: 0n, expiresOn: null, effectiveOn: '2026-01-02',
          reason: 'a row the ledger itself would refuse', correctsId: null,
        },
      ],
    };
    expect(refusalCodeOf(() => link(zeroRoot, 'q0', 'q1', 1n))).toBe('loyalty.corrects_more_than_target');

    // A CHAIN THIS LEDGER CANNOT READ TO ITS ROOT is a named refusal and not a
    // pass: a root the writer cannot see is not a bound. This is the shape a
    // caller's filter or an RLS-narrowed read produces.
    const blinded: LoyaltyLedger = {
      movements: [
        ...ledger.movements,
        {
          id: 'u0', businessId: BUSINESS, customerId: CUSTOMER, pointSeq: 3n,
          movementKind: 'adjust', sourceType: 'manual_adjustment', sourceId: 'adj-u0',
          pointsDelta: 40n, expiresOn: null, effectiveOn: '2026-01-03',
          reason: 'a correction whose target is not in this read', correctsId: 'not-in-this-ledger',
        },
      ],
    };
    expect(refusalCodeOf(() => link(blinded, 'u0', 'u1', 1n))).toBe('loyalty.corrects_chain_unreadable');

    // AND A CYCLE IS REFUSED RATHER THAN WALKED. No writer here can build one;
    // the `LoyaltyLedger` type admits it, and a guard that hangs the till would
    // be worse than the report it fixes.
    const cyclic: LoyaltyLedger = {
      movements: [
        ...ledger.movements,
        {
          id: 'p1', businessId: BUSINESS, customerId: CUSTOMER, pointSeq: 3n,
          movementKind: 'adjust', sourceType: 'manual_adjustment', sourceId: 'adj-p1',
          pointsDelta: 10n, expiresOn: null, effectiveOn: '2026-01-03', reason: 'p', correctsId: 'p2',
        },
        {
          id: 'p2', businessId: BUSINESS, customerId: CUSTOMER, pointSeq: 4n,
          movementKind: 'adjust', sourceType: 'manual_adjustment', sourceId: 'adj-p2',
          pointsDelta: 10n, expiresOn: null, effectiveOn: '2026-01-03', reason: 'q', correctsId: 'p1',
        },
      ],
    };
    expect(refusalCodeOf(() => link(cyclic, 'p1', 'p3', 1n))).toBe('loyalty.corrects_cycle');
    // And the fold itself still terminates on that ledger, because it never
    // takes a second hop — measured, not assumed.
    expect(foldExpiry(cyclic, BUSINESS, CUSTOMER, '2026-06-01').balancePoints).toBe(80n);

    // WHAT THIS DOES NOT BIND, measured so the residual is not a sentence: a
    // chain written past this writer is still admitted by the relation.
    let byHand: LoyaltyLedger = ledger;
    let handTarget = 'c1';
    for (let i = 0; i < 20; i += 1) {
      byHand = {
        movements: [
          ...byHand.movements,
          {
            id: `h${i}`, businessId: BUSINESS, customerId: CUSTOMER, pointSeq: BigInt(3 + i),
            movementKind: 'adjust', sourceType: 'manual_adjustment', sourceId: `adj-h${i}`,
            pointsDelta: 100n, expiresOn: null, effectiveOn: '2026-01-03',
            reason: 'a desk chain', correctsId: handTarget,
          },
        ],
      };
      handTarget = `h${i}`;
    }
    const fold = foldExpiry(byHand, BUSINESS, CUSTOMER, '2026-06-01');
    expect(fold.balancePoints).toBe(2060n);
    expect(fold.spendablePoints).toBe(60n);
    expect(fold.unattributablePoints).toBe(2000n);
    expect(eligiblePoints(byHand, BUSINESS, CUSTOMER, '2026-06-01')).toBe(60n);
  });

  it('F-25 RED PROOF — the per-link bound restored, and it accepts a chain of 1 000 100', () => {
    // `P13-S0 §5`'s canary requirement. `perLink` is the bound exactly as it
    // stood at `3f5a8d2`: the named row's own magnitude, less what corrections
    // OF THAT ROW have already moved. Asked about a chain where each link names
    // the one before it, it accepts every link — which is the finding.
    const perLink = (movements: readonly LoyaltyMovement[], correctsId: string, points: bigint): string => {
      const corrected = must(movements.find((m) => m.id === correctsId), 'the corrected row');
      const moved = corrected.pointsDelta < 0n ? -corrected.pointsDelta : corrected.pointsDelta;
      const alreadyMoved = movements
        .filter((m) => m.correctsId === corrected.id)
        .reduce((acc, m) => acc + (m.pointsDelta < 0n ? -m.pointsDelta : m.pointsDelta), 0n);
      return alreadyMoved + points > moved ? 'loyalty.corrects_more_than_target' : '(accepted)';
    };

    // A 100-point earn and 10 000 links of 100, each correcting the one before.
    const rows: LoyaltyMovement[] = [{
      id: 'e1', businessId: BUSINESS, customerId: CUSTOMER, pointSeq: 1n,
      movementKind: 'earn', sourceType: 'sale', sourceId: 'sale-e1',
      pointsDelta: 100n, expiresOn: '2027-01-01', effectiveOn: '2026-01-01',
      reason: null, correctsId: null,
    }];
    let target = 'e1';
    let accepted = 0;
    for (let i = 0; i < 10000; i += 1) {
      // The predicate is asked about the chain as it stands, link by link.
      if (perLink(rows, target, 100n) === '(accepted)') accepted += 1;
      rows.push({
        id: `n${i}`, businessId: BUSINESS, customerId: CUSTOMER, pointSeq: BigInt(2 + i),
        movementKind: 'adjust', sourceType: 'manual_adjustment', sourceId: `adj-n${i}`,
        pointsDelta: 100n, expiresOn: null, effectiveOn: '2026-01-03',
        reason: 'a desk chain', correctsId: target,
      });
      target = `n${i}`;
    }
    // EVERY ONE of them, and the balance the ledger then reports.
    expect(accepted).toBe(10000);
    expect(foldBalance({ movements: rows }, BUSINESS, CUSTOMER, '2026-06-01').balancePoints).toBe(1000100n);

    // The chain invariant refuses the SECOND link of that same chain, by name.
    const twoRows: LoyaltyLedger = { movements: [must(rows[0], 'the earn'), must(rows[1], 'the first link')] };
    expect(refusalCodeOf(() => buildReversalMovement(twoRows, { ...partyCount(twoRows), 
      businessId: BUSINESS, customerId: CUSTOMER, sourceId: 'desk-2', correctsId: 'n0',
      points: 1n, asOf: '2026-01-03', movementId: 'n1', reason: 'desk correction',
    }))).toBe('loyalty.corrects_more_than_target');

    // And the other figure the per-link bound produced: two links on a lawful
    // 1,000,000-point earn, which is the one that needs no patience at all.
    const bigEarn = ledgerOf(earn('e9', 1000000n, '2026-01-01', '2027-01-01'));
    const one = appendMovement(bigEarn, buildReversalMovement(bigEarn, { ...partyCount(bigEarn), 
      businessId: BUSINESS, customerId: CUSTOMER, sourceId: 'desk-b1', correctsId: 'e9',
      points: 1000000n, asOf: '2026-01-03', movementId: 'b1', reason: 'desk correction',
    })).ledger;
    expect(perLink(one.movements, 'b1', 1000000n)).toBe('(accepted)');
    expect(refusalCodeOf(() => buildReversalMovement(one, { ...partyCount(one), 
      businessId: BUSINESS, customerId: CUSTOMER, sourceId: 'desk-b2', correctsId: 'b1',
      points: 1000000n, asOf: '2026-01-03', movementId: 'b2', reason: 'desk correction',
    }))).toBe('loyalty.corrects_more_than_target');
  });

  it('F-26 — the target is found by the DECLARED key, so one business cannot decide another\'s refusals', () => {
    // `§1.3` keys the relation `(business_id, id)` and there is no global unique
    // on `id`, so two businesses may hold one movement id — the case RLS case 9
    // exists for. This writer matched on `id` alone, and both arms were
    // measured: with the sibling business's row earlier in the ledger, a
    // business's LAWFUL correction of its own row was refused
    // `loyalty.corrects_unknown_movement`; and with the party check passing,
    // the other business's corrections were counted into this one's bound, so
    // it could not correct its own row by even 1 point. Both failed CLOSED,
    // which is why this was a residual and not a blocker — and it is still one
    // party's writes deciding another's refusals.
    const row = (businessId: string, id: string, seq: bigint, delta: bigint, correctsId: string | null = null): LoyaltyMovement => ({
      id, businessId, customerId: CUSTOMER, pointSeq: seq,
      movementKind: delta < 0n ? 'consume' : 'adjust',
      sourceType: delta < 0n ? 'sale' : 'manual_adjustment', sourceId: `src-${businessId}-${id}`,
      pointsDelta: delta, expiresOn: null, effectiveOn: '2026-01-02',
      reason: delta < 0n ? null : 'desk', correctsId,
    });
    const ask = (ledger: LoyaltyLedger, points: bigint) =>
      buildReversalMovement(ledger, { ...partyCount(ledger), 
        businessId: BUSINESS, customerId: CUSTOMER, sourceId: 'desk-1', correctsId: 'm1', points,
        asOf: '2026-01-03', movementId: 'r1', reason: 'desk correction',
      });

    // The sibling business's row comes FIRST, which is what made `find` pick it.
    const shared: LoyaltyLedger = { movements: [row('biz-2', 'm1', 1n, -40n), row(BUSINESS, 'm1', 1n, -40n)] };
    expect(ask(shared, 40n).pointsDelta).toBe(40n);

    // And the other party's corrections are not counted into this bound.
    const alsoCorrected: LoyaltyLedger = {
      movements: [
        row(BUSINESS, 'm1', 1n, -40n),
        row('biz-2', 'm1', 1n, -40n),
        row('biz-2', 'r9', 2n, 40n, 'm1'),
      ],
    };
    expect(ask(alsoCorrected, 1n).pointsDelta).toBe(1n);
    expect(ask(alsoCorrected, 40n).pointsDelta).toBe(40n);
    expect(refusalCodeOf(() => ask(alsoCorrected, 41n))).toBe('loyalty.corrects_more_than_target');

    // A target that belongs to another party is NOT FOUND, by name. This is the
    // refusal the deleted party check used to give: with the lookup keyed it
    // could never fire, and a guard that cannot fire is a comment.
    const othersOnly: LoyaltyLedger = { movements: [row('biz-2', 'm1', 1n, -40n)] };
    expect(refusalCodeOf(() => ask(othersOnly, 40n))).toBe('loyalty.corrects_unknown_movement');
    const otherCustomer: LoyaltyLedger = {
      movements: [{ ...row(BUSINESS, 'm1', 1n, -40n), customerId: 'cust-other' }],
    };
    expect(refusalCodeOf(() => ask(otherCustomer, 40n))).toBe('loyalty.corrects_unknown_movement');
  });

  it('C-2 — a narrowed ledger over-reports, and the writer refuses the narrowing by name', () => {
    // The coordinator's review measured the sentence "breaking the obligation is
    // a refusal, never a pass" FALSE, and it was. The chain is read through the
    // array this writer is handed, so a missing ANCESTOR is refused
    // `loyalty.corrects_chain_unreadable` — but a missing LATER correction is
    // simply not there to see. Reproduced here first, with the guard disabled by
    // stating the narrowed count: the full ledger refuses the second 40 with
    // `loyalty.corrects_more_than_target`, the narrowed one ACCEPTS it, and the
    // displayed balance then reads 140 for a customer who earned 100.
    //
    // Eligible points are NOT over-reported — they stay at 60 — so redemption
    // was never exposed; the harm is a displayed figure, which is the F-21/F-25
    // over-report class, not a spend of points that do not exist.
    const base = (() => {
      let l = ledgerOf(earn('e1', 100n, '2026-01-01', '2027-01-01'));
      l = appendMovement(l, buildSaleConsumptionMovement(l, sale(40n, '2026-01-02', 'c1'))).ledger;
      return l;
    })();
    const first = buildReversalMovement(base, {
      ...partyCount(base), businessId: BUSINESS, customerId: CUSTOMER, sourceId: 'desk-1',
      correctsId: 'c1', points: 40n, asOf: '2026-01-03', movementId: 'r1', reason: 'first',
    });
    const full = appendMovement(base, first).ledger;
    const second = (ledger: LoyaltyLedger, count: number) =>
      buildReversalMovement(ledger, {
        storedPartyMovementCount: count, businessId: BUSINESS, customerId: CUSTOMER,
        sourceId: 'desk-2', correctsId: 'c1', points: 40n, asOf: '2026-01-05',
        movementId: 'r2', reason: 'second',
      });

    // The full ledger refuses it: the chain has already moved the root's 40.
    expect(refusalCodeOf(() => second(full, 3))).toBe('loyalty.corrects_more_than_target');

    // The narrowed ledger, with the count stated to MATCH the narrowing so the
    // new guard stands aside, accepts it — this is the defect, measured.
    const narrowed: LoyaltyLedger = { movements: full.movements.filter((m) => m.id !== 'r1') };
    const accepted = second(narrowed, 2);
    expect(accepted.pointsDelta).toBe(40n);
    const over = appendMovement(full, accepted).ledger;
    expect(foldBalance(over, BUSINESS, CUSTOMER, '2026-01-06').balancePoints).toBe(140n);
    expect(eligiblePoints(over, BUSINESS, CUSTOMER, '2026-01-06')).toBe(60n);

    // And the guard: the ledger handed over is checked against the count the
    // caller states from the store, so the narrowing itself is refused by name.
    expect(refusalCodeOf(() => second(narrowed, 3))).toBe('loyalty.ledger_not_party_complete');
    expect(refusalCodeOf(() => second(full, 4))).toBe('loyalty.ledger_not_party_complete');
    expect(refusalCodeOf(() => second(full, -1))).toBe('loyalty.ledger_count_not_stated');
    expect(refusalCodeOf(() => second(full, 1.5))).toBe('loyalty.ledger_count_not_stated');

    // Its limit, stated: this catches a NARROWED ledger, not a caller that
    // miscounts in the same direction as its narrowing or states a false count.
    // Only the database can close that, and §A.3c.3 asks for the bound there.
    expect(second(narrowed, 2).pointsDelta).toBe(40n);
  });

  it('R11-04 — count equality is not set equality, and the writer accepts a padded narrowing', () => {
    // The challenger's own finding on the C-2 guard, reproduced and PINNED so
    // that closing it has to be a deliberate change to this case rather than a
    // silent one. The stated count is a scalar, so a ledger that drops the row
    // that matters and carries another row of the same party in its place
    // states a TRUE count over a WRONG set. A paged read with an overlapping
    // window reaches this shape without anyone intending it.
    //
    // What is measured: the whole ledger refuses the second 40, the padded
    // narrowing is ACCEPTED at delta 40, and the count guard never fires
    // because the count is right. Only §A.3c.3's trigger closes it — the
    // relation cannot be narrowed by a caller at all there.
    let base = ledgerOf(earn('e1', 100n, '2026-01-01', '2027-01-01'));
    base = appendMovement(base, buildSaleConsumptionMovement(base, sale(40n, '2026-01-02', 'c1'))).ledger;
    const first = buildReversalMovement(base, {
      ...partyCount(base), businessId: BUSINESS, customerId: CUSTOMER, sourceId: 'desk-1',
      correctsId: 'c1', points: 40n, asOf: '2026-01-03', movementId: 'r1', reason: 'first',
    });
    const full = appendMovement(base, first).ledger;
    const second = (ledger: LoyaltyLedger, count: number) =>
      buildReversalMovement(ledger, {
        storedPartyMovementCount: count, businessId: BUSINESS, customerId: CUSTOMER,
        sourceId: 'desk-2', correctsId: 'c1', points: 40n, asOf: '2026-01-05',
        movementId: 'r2', reason: 'second',
      });

    expect(full.movements).toHaveLength(3);
    expect(refusalCodeOf(() => second(full, 3))).toBe('loyalty.corrects_more_than_target');

    // Drop the correction that moved the root, pad with an unrelated earn of
    // the SAME party, and the count is three again — truthfully three.
    const padded: LoyaltyLedger = {
      movements: [
        ...full.movements.filter((m) => m.id !== 'r1'),
        {
          id: 'e2', businessId: BUSINESS, customerId: CUSTOMER, pointSeq: 9n,
          movementKind: 'earn', sourceType: 'manual_adjustment', sourceId: 'desk-pad',
          pointsDelta: 10n, expiresOn: '2027-06-01', effectiveOn: '2026-01-04',
          reason: 'goodwill', correctsId: null,
        },
      ],
    };
    expect(padded.movements).toHaveLength(3);
    const accepted = second(padded, 3);
    expect(accepted.pointsDelta).toBe(40n);

    // The guard still fires on a count that does NOT match the padded set, so
    // what is accepted here is a true count over the wrong rows, and nothing
    // weaker than that.
    expect(refusalCodeOf(() => second(padded, 4))).toBe('loyalty.ledger_not_party_complete');
  });

  it('F-33 — the two party filters are load-bearing TOGETHER, and neither is witnessable alone', () => {
    // The chain is collected by a `correctsId -> children` index and its net is
    // summed from the ledger, and BOTH steps filter on the declared key. Drop
    // either one alone and nothing reds: the index admits a foreign row into
    // `chain`, and the sum then discards it; or the sum admits it, and it was
    // never in `chain`. Each defence masks the other, which is the `P5 R9`
    // lesson — a one-at-a-time sweep cannot see two defences that mask each
    // other, so the honest proof is a PAIR-DROP and an assertion by name.
    //
    // Measured AT THIS HEAD (`R11-06` corrected the earlier figures, which came
    // from the tree before the C-2 case landed): dropping `sameParty` from the
    // index alone leaves 233 passed, rc 0, and from the sum alone likewise.
    // Dropping it from BOTH reds `F-26` above and this case, 2 failed / 231
    // passed, rc 1. So neither filter is reported as witnessed on its own, and
    // both are reported as witnessed together.
    const row = (businessId: string, id: string, seq: bigint, delta: bigint, correctsId: string | null = null): LoyaltyMovement => ({
      id, businessId, customerId: CUSTOMER, pointSeq: seq,
      movementKind: delta < 0n ? 'consume' : 'adjust',
      sourceType: delta < 0n ? 'sale' : 'manual_adjustment', sourceId: `src-${businessId}-${id}`,
      pointsDelta: delta, expiresOn: null, effectiveOn: '2026-01-02',
      reason: delta < 0n ? null : 'desk', correctsId,
    });

    // One id, two parties (`§1.3`: the relation is keyed `(business_id, id)` and
    // there is no global unique on `id`) — and the foreign side carries a whole
    // CHAIN hanging off this party's root: a child and a grandchild. The
    // grandchild is the leg the index's own walk is needed for: a one-generation
    // reach would not find it even with the filter gone.
    const ledger: LoyaltyLedger = {
      movements: [
        row(BUSINESS, 'm1', 1n, -100n),
        row('biz-2', 'm1', 1n, -100n),
        row('biz-2', 'f1', 2n, 60n, 'm1'),
        row('biz-2', 'f2', 3n, 40n, 'f1'),
        { ...row(BUSINESS, 'm1', 1n, -100n), id: 'm2', customerId: 'cust-other' },
        row('biz-2', 'f3', 4n, 25n, 'm2'),
      ],
    };
    const ask = (points: bigint) =>
      buildReversalMovement(ledger, { ...partyCount(ledger), 
        businessId: BUSINESS, customerId: CUSTOMER, sourceId: 'desk-1', correctsId: 'm1', points,
        asOf: '2026-01-03', movementId: 'r1', reason: 'desk correction',
      });

    // This party's own chain is empty, so its whole 100 is available: the
    // foreign 60 + 40 + 25 move nothing here. With both filters dropped the
    // chain's net reads 100 and even 1 point is refused.
    expect(ask(1n).pointsDelta).toBe(1n);
    expect(ask(100n).pointsDelta).toBe(100n);
    expect(refusalCodeOf(() => ask(101n))).toBe('loyalty.corrects_more_than_target');
  });

  it('F-23 RED PROOF — the sign gate restored, and the defect comes back to the digit', () => {
    // `P13-S0 §5`'s canary requirement: the case above must be able to tell the
    // fixed writer from the broken one. `broken` is the bound exactly as it was
    // written — inside the target's sign — and it is asked the same question.
    const base = (() => {
      let l = ledgerOf(earn('e1', 100n, '2026-01-01', '2027-01-01'));
      l = appendMovement(l, buildSaleConsumptionMovement(l, sale(40n, '2026-01-02', 'c1'))).ledger;
      return l;
    })();
    const broken = (ledger: LoyaltyLedger, correctsId: string, points: bigint): string => {
      const corrected = must(ledger.movements.find((m) => m.id === correctsId), 'the corrected row');
      if (corrected.pointsDelta < 0n) {
        const taken = -corrected.pointsDelta;
        const alreadyRestored = ledger.movements
          .filter((m) => m.correctsId === corrected.id && m.pointsDelta > 0n)
          .reduce((acc, m) => acc + m.pointsDelta, 0n);
        if (alreadyRestored + points > taken) return 'loyalty.corrects_more_than_target';
      }
      return '(accepted)';
    };
    // The broken bound refuses the draw and waves the earn through.
    expect(broken(base, 'c1', 41n)).toBe('loyalty.corrects_more_than_target');
    expect(broken(base, 'e1', 1000000n)).toBe('(accepted)');
    // The real one refuses both, by name.
    expect(refusalCodeOf(() => buildReversalMovement(base, { ...partyCount(base), 
      businessId: BUSINESS, customerId: CUSTOMER, sourceId: 'desk-1', correctsId: 'e1',
      points: 1000000n, asOf: '2026-01-03', movementId: 'x1', reason: 'desk correction',
    }))).toBe('loyalty.corrects_more_than_target');

    // AND THE FIGURE THE BROKEN WRITER PRODUCED, which is still what the
    // relation permits past this package: 1,000,000 points naming the earn.
    const byHand: LoyaltyLedger = {
      movements: [
        ...base.movements,
        {
          id: 'x1', businessId: BUSINESS, customerId: CUSTOMER, pointSeq: 3n,
          movementKind: 'adjust', sourceType: 'manual_adjustment', sourceId: 'adj-x1',
          pointsDelta: 1000000n, expiresOn: null, effectiveOn: '2026-01-03',
          reason: 'a desk correction naming the earn', correctsId: 'e1',
        },
      ],
    };
    const fold = foldExpiry(byHand, BUSINESS, CUSTOMER, '2026-06-01');
    expect(fold.balancePoints).toBe(1000060n);
    expect(fold.expiringPoints).toBe(0n);
    expect(fold.spendablePoints).toBe(60n);
    expect(fold.unhorizonedPoints).toBe(0n);
    expect(fold.unattributablePoints).toBe(1000000n);
    // Redemption is unmoved, which is why this is a reporting defect and not a
    // money one — and why the whole quantity is withheld: an earn is in no
    // draw, so a correction naming one credits NOTHING spendable. The route
    // that works for an under-award is §2.3's standing grant.
    expect(eligiblePoints(byHand, BUSINESS, CUSTOMER, '2026-06-01')).toBe(60n);
    const grantRoute = appendMovement(base, adjust('g9', 1000000n, '2026-01-03', 'the under-award, as a grant')).ledger;
    expect(eligiblePoints(grantRoute, BUSINESS, CUSTOMER, '2026-06-01')).toBe(1000060n);
  });

  it('withholds the excess when an over-restoration is written past the writer', () => {
    // The fold must still be sound over a ledger the writer would refuse, and
    // this is the arm that keeps it measured: hand-built, because
    // `buildReversalMovement` now refuses the quantity. A quantity beyond what
    // the target drew is accounted for by no draw, so it is withheld, and a
    // mutation that returns it to the spendable pool is caught here.
    let ledger = ledgerOf(earn('e1', 100n, '2026-01-01', '2027-01-01'));
    ledger = appendMovement(ledger, buildSaleConsumptionMovement(ledger, sale(40n, '2026-01-02', 'c1'))).ledger;
    ledger = {
      movements: [
        ...ledger.movements,
        {
          id: 'r1', businessId: BUSINESS, customerId: CUSTOMER, pointSeq: 3n,
          movementKind: 'adjust', sourceType: 'manual_adjustment', sourceId: 'adj-r1',
          pointsDelta: 50n, expiresOn: null, effectiveOn: '2026-01-03',
          reason: 'ten more than the consumption took', correctsId: 'c1',
        },
      ],
    };

    const fold = foldExpiry(ledger, BUSINESS, CUSTOMER, '2026-06-01');
    expect(fold.balancePoints).toBe(110n);
    expect(fold.unattributablePoints).toBe(50n);
    expect(fold.unhorizonedPoints).toBe(0n);
    expect(fold.spendablePoints).toBe(60n);
    expect(eligiblePoints(ledger, BUSINESS, CUSTOMER, '2026-06-01')).toBe(60n);
    // Conservation, which is what the excess going anywhere else would break.
    const inLots = fold.lots.reduce((acc, l) => acc + l.remainingPoints, 0n);
    expect(inLots + fold.unhorizonedPoints + fold.unattributablePoints).toBe(fold.balancePoints);
  });

  it('settles a draw that precedes its capacity, so reading in order changes no answer', () => {
    // The two-pass fold summed every negative BEFORE building the lots, so a
    // spend recorded ahead of the earn that funds it still drew on it. The
    // replay must not change that answer, so an unfunded claim is queued and
    // settled when capacity appears. Built by hand: no writer produces this
    // order, and that is the point — the fold must not depend on the writers to
    // avoid it.
    const byHand: LoyaltyLedger = {
      movements: [
        {
          id: 'a1', businessId: BUSINESS, customerId: CUSTOMER, pointSeq: 1n,
          movementKind: 'adjust', sourceType: 'manual_adjustment', sourceId: 'adj-a1',
          pointsDelta: -30n, expiresOn: null, effectiveOn: '2026-01-01',
          reason: 'a draw with nothing yet to draw on', correctsId: null,
        },
        {
          id: 'e1', businessId: BUSINESS, customerId: CUSTOMER, pointSeq: 2n,
          movementKind: 'earn', sourceType: 'sale', sourceId: 'sale-e1',
          pointsDelta: 100n, expiresOn: '2027-01-01', effectiveOn: '2026-01-02',
          reason: null, correctsId: null,
        },
      ],
    };
    const fold = foldExpiry(byHand, BUSINESS, CUSTOMER, '2026-06-01');
    expect(fold.balancePoints).toBe(70n);
    expect(must(fold.lots[0], 'the lot').remainingPoints).toBe(70n);
    expect(fold.spendablePoints).toBe(70n);
    expect(eligiblePoints(byHand, BUSINESS, CUSTOMER, '2026-06-01')).toBe(70n);
    const inLots = fold.lots.reduce((acc, l) => acc + l.remainingPoints, 0n);
    expect(inLots + fold.unhorizonedPoints + fold.unattributablePoints).toBe(fold.balancePoints);
  });

  it('settles a claim in PARTS, so capacity smaller than the claim stops at what it funded', () => {
    // The challenger's observation on round 6: about twenty-five lines of the
    // replay were unreachable through this package's own writers, among them
    // the `break` that stops settling when the capacity that just appeared is
    // SMALLER than the oldest claim. A line that would silently stop settling
    // deserves a case rather than a reader's confidence, so here is the one
    // that reaches it: a claim of 50, then a lot of 20 — which settles 20 and
    // stops — then a grant of 40, which settles the remaining 30.
    const row = (
      id: string, seq: bigint, kind: 'adjust' | 'earn', delta: bigint, day: string,
      expiresOn: string | null, reason: string | null,
    ): LoyaltyMovement => ({
      id, businessId: BUSINESS, customerId: CUSTOMER, pointSeq: seq,
      movementKind: kind, sourceType: kind === 'earn' ? 'sale' : 'manual_adjustment',
      sourceId: `src-${id}`, pointsDelta: delta, expiresOn, effectiveOn: day,
      reason, correctsId: null,
    });
    const claim = row('a1', 1n, 'adjust', -50n, '2026-01-01', null, 'a draw with nothing yet to draw on');
    const lot = row('e1', 2n, 'earn', 20n, '2026-01-02', '2027-01-01', null);
    const grant = row('g1', 3n, 'adjust', 40n, '2026-01-03', null, 'merchant goodwill');

    // After the lot: 20 of the 50 are settled and the claim is still owed 30,
    // which is the state the `break` leaves behind.
    const afterLot = foldExpiry({ movements: [claim, lot] }, BUSINESS, CUSTOMER, '2026-06-01');
    expect(afterLot.balancePoints).toBe(-30n);
    expect(must(afterLot.lots[0], 'the lot').remainingPoints).toBe(0n);
    expect(afterLot.unhorizonedPoints).toBe(0n);
    expect(afterLot.unattributablePoints).toBe(0n);
    expect(afterLot.spendablePoints).toBe(0n);
    expect(eligiblePoints({ movements: [claim, lot] }, BUSINESS, CUSTOMER, '2026-06-01')).toBe(0n);

    // And then the grant settles the rest, leaving exactly its remainder.
    const byHand: LoyaltyLedger = { movements: [claim, lot, grant] };
    const fold = foldExpiry(byHand, BUSINESS, CUSTOMER, '2026-06-01');
    expect(fold.balancePoints).toBe(10n);
    expect(must(fold.lots[0], 'the lot').remainingPoints).toBe(0n);
    expect(fold.unhorizonedPoints).toBe(10n);
    expect(fold.unattributablePoints).toBe(0n);
    expect(fold.spendablePoints).toBe(10n);
    expect(eligiblePoints(byHand, BUSINESS, CUSTOMER, '2026-06-01')).toBe(10n);
    const inLots = fold.lots.reduce((acc, l) => acc + l.remainingPoints, 0n);
    expect(inLots + fold.unhorizonedPoints + fold.unattributablePoints).toBe(fold.balancePoints);
  });

  it('offers nothing on a ledger whose draws exceed everything it ever held', () => {
    // An unfunded claim that is never settled: the balance goes negative, the
    // stores stay at zero, and the eligible figure is zero rather than a
    // negative number or a refusal. Hand-built, because no writer permits it.
    const byHand: LoyaltyLedger = {
      movements: [
        {
          id: 'a1', businessId: BUSINESS, customerId: CUSTOMER, pointSeq: 1n,
          movementKind: 'adjust', sourceType: 'manual_adjustment', sourceId: 'adj-a1',
          pointsDelta: -30n, expiresOn: null, effectiveOn: '2026-01-01',
          reason: 'an overdraw', correctsId: null,
        },
      ],
    };
    const fold = foldExpiry(byHand, BUSINESS, CUSTOMER, '2026-06-01');
    expect(fold.balancePoints).toBe(-30n);
    expect(fold.spendablePoints).toBe(0n);
    expect(fold.unattributablePoints).toBe(0n);
    expect(eligiblePoints(byHand, BUSINESS, CUSTOMER, '2026-06-01')).toBe(0n);
  });
});

describe('foldExpiry — a target cannot fund two restorations with the same points', () => {
  const sale = (points: bigint, asOf: string, movementId: string) =>
    ({
      phase: 'inside_sale_transaction',
      businessId: BUSINESS,
      customerId: CUSTOMER,
      saleId: `sale-${movementId}`,
      businessTransactionId: `btx-${movementId}`,
      points,
      asOf,
      movementId,
    }) as Parameters<typeof buildSaleConsumptionMovement>[1];

  it('strikes off what a restoration claims, so a SECOND one cannot claim it again', () => {
    // Two restorations of ONE consumption. Through the writer they can only sum
    // to what that consumption took (`F-21`), and this is the pair that still
    // reaches the striking-off: both are written PAST the writer, because that
    // is the only way the second can out-claim what is left of the target's
    // draw. Labelled hand-built for that reason.
    //
    // A plausible route to it: `correctsId` must name a row in the ledger and
    // that is all (`§1.4`), so a desk correction booked twice against one sale
    // from two sources is an ordinary human error, and the DDL item in §A.3c.3
    // is what would stop it at the database.
    let ledger = ledgerOf(
      adjust('g1', 30n, '2026-01-01', 'merchant goodwill'),
      earn('e1', 10n, '2026-01-02', '2027-01-01'),
    );
    ledger = appendMovement(ledger, buildSaleConsumptionMovement(ledger, sale(40n, '2026-01-03', 'c1'))).ledger;
    const byHand = (id: string, seq: bigint, day: string, source: string): LoyaltyMovement => ({
      id, businessId: BUSINESS, customerId: CUSTOMER, pointSeq: seq,
      movementKind: 'adjust', sourceType: 'manual_adjustment', sourceId: source,
      pointsDelta: 40n, expiresOn: null, effectiveOn: day,
      reason: 'sale fully reversed', correctsId: 'c1',
    });
    ledger = {
      movements: [...ledger.movements, byHand('r1', 4n, '2026-01-04', 'adj-r1'), byHand('r2', 5n, '2026-01-05', 'adj-r2')],
    };

    const fold = foldExpiry(ledger, BUSINESS, CUSTOMER, '2026-06-01');
    expect(fold.balancePoints).toBe(80n);
    // The first restoration gave the grant's 30 back and withheld the lot's 10.
    // The second had nothing left to be attributed to, so all 40 are withheld.
    expect(fold.unhorizonedPoints).toBe(30n);
    expect(fold.unattributablePoints).toBe(50n);
    expect(fold.spendablePoints).toBe(30n);
    expect(eligiblePoints(ledger, BUSINESS, CUSTOMER, '2026-06-01')).toBe(30n);
    const inLots = fold.lots.reduce((acc, l) => acc + l.remainingPoints, 0n);
    expect(inLots + fold.unhorizonedPoints + fold.unattributablePoints).toBe(fold.balancePoints);
  });

  it('through the WRITER, two partial restorations can only sum to what was taken', () => {
    // The lawful half of the same question, and the idempotency fact worth
    // recording: the identity key of a movement is (business, source type,
    // source id, kind), so a second correction naming the SAME source is
    // absorbed by `appendMovement` as the duplicate it is. The double refund
    // that reaches the ledger is the one booked against a second source.
    let ledger = ledgerOf(
      adjust('g1', 30n, '2026-01-01', 'merchant goodwill'),
      earn('e1', 10n, '2026-01-02', '2027-01-01'),
    );
    ledger = appendMovement(ledger, buildSaleConsumptionMovement(ledger, sale(40n, '2026-01-03', 'c1'))).ledger;
    const reversal = (movementId: string, asOf: string, sourceId: string, points: bigint) =>
      buildReversalMovement(ledger, { ...partyCount(ledger), 
        businessId: BUSINESS,
        customerId: CUSTOMER,
        sourceId,
        correctsId: 'c1',
        points,
        asOf,
        movementId,
        reason: 'sale fully reversed',
      });
    const first = appendMovement(ledger, reversal('r1', '2026-01-04', 'sale-c1', 25n));
    expect(first.outcome).toBe('appended');
    ledger = first.ledger;
    const duplicate = appendMovement(ledger, reversal('rX', '2026-01-04', 'sale-c1', 15n));
    expect(duplicate.outcome).toBe('already_present');
    const second = appendMovement(ledger, reversal('r2', '2026-01-05', 'desk-correction-2', 15n));
    expect(second.outcome).toBe('appended');
    ledger = second.ledger;
    // 25 + 15 is the whole of the 40 that was taken, and one point more is
    // refused by the writer's own bound.
    expect(refusalCodeOf(() => reversal('r3', '2026-01-06', 'desk-correction-3', 1n))).toBe(
      'loyalty.corrects_more_than_target',
    );

    const fold = foldExpiry(ledger, BUSINESS, CUSTOMER, '2026-06-01');
    expect(fold.balancePoints).toBe(40n);
    expect(fold.unhorizonedPoints).toBe(30n);
    expect(fold.unattributablePoints).toBe(10n);
    expect(eligiblePoints(ledger, BUSINESS, CUSTOMER, '2026-06-01')).toBe(30n);
  });

  it('treats a restoration of an UNFUNDED draw as un-attributable, not as the pool', () => {
    // Hand-built, and labelled: a draw larger than everything the ledger held
    // leaves an unfunded claim, and restoring part of it restores points no
    // store ever gave up. Withholding is the conservative answer; returning
    // them to the spendable pool would offer points nothing backs.
    const byHand: LoyaltyLedger = {
      movements: [
        {
          id: 'g1', businessId: BUSINESS, customerId: CUSTOMER, pointSeq: 1n,
          movementKind: 'adjust', sourceType: 'manual_adjustment', sourceId: 'adj-g1',
          pointsDelta: 20n, expiresOn: null, effectiveOn: '2026-01-01',
          reason: 'merchant goodwill', correctsId: null,
        },
        {
          id: 'c1', businessId: BUSINESS, customerId: CUSTOMER, pointSeq: 2n,
          movementKind: 'consume', sourceType: 'sale', sourceId: 'sale-c1',
          pointsDelta: -50n, expiresOn: null, effectiveOn: '2026-01-02',
          reason: null, correctsId: null,
        },
        {
          id: 'r1', businessId: BUSINESS, customerId: CUSTOMER, pointSeq: 3n,
          movementKind: 'adjust', sourceType: 'manual_adjustment', sourceId: 'adj-r1',
          pointsDelta: 20n, expiresOn: null, effectiveOn: '2026-01-03',
          reason: 'part of that sale returned', correctsId: 'c1',
        },
      ],
    };
    const fold = foldExpiry(byHand, BUSINESS, CUSTOMER, '2026-06-01');
    expect(fold.balancePoints).toBe(-10n);
    expect(fold.unattributablePoints).toBe(20n);
    expect(fold.unhorizonedPoints).toBe(0n);
    expect(eligiblePoints(byHand, BUSINESS, CUSTOMER, '2026-06-01')).toBe(0n);
  });
});
