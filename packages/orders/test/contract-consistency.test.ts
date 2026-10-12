/**
 * The DTO vocabulary and the domain vocabulary are the same vocabulary.
 *
 * A union that drifts is the defect this file exists to red. If a state is
 * added to the machine and not to `OrderStateDto`, a client told to render
 * "every state" silently cannot render the new one; if a finding code is added
 * to the reconciler and not to the report DTO, a finding reaches a client that
 * has no branch for it.
 *
 * TypeScript alone cannot catch this: both unions would compile perfectly while
 * disagreeing. So the check is EXECUTED over value-level lists, and each list is
 * derived from the implementation's own exported table on one side and written
 * out by hand on the other — never from the same source twice, which would
 * compare the vocabulary to itself.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ORDER_CHANNELS,
  ORDER_CLIENT_ERROR_CODES,
  ORDER_EDGES,
  ORDER_QUOTE_CONFIRMATION_FIELDS,
  NO_QUOTE_EXPIRY,
  ORDER_QUOTE_DIGEST_PATTERN,
  ORDER_SETTLEMENT_EVIDENCE_KINDS,
  SETTLEMENT_MODE_BY_EVIDENCE,
  TERMINAL_ORDER_STATES,
  type OrderChannelDto,
  type OrderSettlementEvidenceKindDto,
  type OrderQuoteConfirmationDto,
  type OrderStateDto,
} from '../src';

/** Hand-written from `OrderStateDto`. Edited only when that union is edited. */
const DTO_STATES: readonly OrderStateDto[] = ['placed', 'accepted', 'rejected', 'cancelled', 'fulfilling', 'fulfilled', 'completed'];

/** Hand-written from `OrderChannelDto`. */
const DTO_CHANNELS: readonly OrderChannelDto[] = ['storefront', 'pos', 'admin', 'marketplace'];

/** Hand-written from `OrderSettlementEvidenceKindDto`. */
const DTO_EVIDENCE_KINDS: readonly OrderSettlementEvidenceKindDto[] = ['cash_collected_on_handover', 'payment_verified', 'authorized_customer_credit'];

describe('the state vocabulary', () => {
  it('is the same set on both sides of the API boundary', () => {
    // Derived from the machine: every state any edge can reach, plus the
    // terminal set, which together is every state the machine admits.
    const fromMachine = new Set<string>([...Object.values(ORDER_EDGES).map((e) => e.to), ...TERMINAL_ORDER_STATES]);
    expect([...fromMachine].sort()).toEqual([...DTO_STATES].sort());
  });

  it('has a non-empty subject on both sides', () => {
    expect(DTO_STATES.length).toBe(7);
    expect(Object.keys(ORDER_EDGES).length).toBe(7);
  });
});

describe('the channel vocabulary', () => {
  it('is the same set the reconciler accepts', () => {
    expect([...ORDER_CHANNELS].sort()).toEqual([...DTO_CHANNELS].sort());
  });
});

describe('the settlement evidence vocabulary (section 25)', () => {
  it('is the same set on both sides of the API boundary', () => {
    expect([...DTO_EVIDENCE_KINDS].sort()).toEqual([...ORDER_SETTLEMENT_EVIDENCE_KINDS].sort());
  });

  it('offers no kind on either side that would let an unpaid order be committed as paid', () => {
    for (const kind of [...DTO_EVIDENCE_KINDS, ...ORDER_SETTLEMENT_EVIDENCE_KINDS]) {
      expect(kind).not.toMatch(/pend|unpaid|await|assume|uncollected/i);
    }
  });

  it('maps every declared kind to one settlement mode, or to none where the seam owes the answer', () => {
    // `null` is admitted deliberately (Directive #11 PART 31): the mode a
    // verified card payment settles into belongs to the merchant payment and
    // tender seam, so Phase 6 leaves it unanswered rather than guessing `cash`.
    // `undefined` is NOT admitted: that would be a DTO kind the domain has never
    // heard of.
    for (const kind of DTO_EVIDENCE_KINDS) {
      expect(Object.prototype.hasOwnProperty.call(SETTLEMENT_MODE_BY_EVIDENCE, kind)).toBe(true);
      expect(['cash', 'credit', null]).toContain(SETTLEMENT_MODE_BY_EVIDENCE[kind]);
    }
    expect(Object.keys(SETTLEMENT_MODE_BY_EVIDENCE)).toHaveLength(DTO_EVIDENCE_KINDS.length);
  });
});

describe('the client error codes', () => {
  it('are a non-empty, duplicate-free subset of codes this package can actually raise', () => {
    expect(ORDER_CLIENT_ERROR_CODES.length).toBeGreaterThan(0);
    expect(new Set(ORDER_CLIENT_ERROR_CODES).size).toBe(ORDER_CLIENT_ERROR_CODES.length);
    for (const code of ORDER_CLIENT_ERROR_CODES) {
      expect(code.startsWith('order.')).toBe(true);
    }
  });

  it('name the one refusal a shopper-facing client must branch on above all others', () => {
    // An order whose sale committed is reversed through the sales authority,
    // never cancelled. A client that offered a Cancel button there would ask for
    // a refusal it could not explain.
    expect(ORDER_CLIENT_ERROR_CODES).toContain('order.cancel_after_sale');
  });

  it('name the refusals a checkout client must be able to render', () => {
    // A storefront that could not render these would strand the shopper at the
    // one moment they can still act: an expired quote, a superseded price, a
    // settlement the evidence does not support, and a payment surface that is
    // not integrated.
    for (const code of ['order.quote_expired', 'order.quote_version_stale', 'order.settlement_mode_unsupported', 'order.payment_surface_not_integrated']) {
      expect(ORDER_CLIENT_ERROR_CODES).toContain(code);
    }
  });
});

describe('the quote-confirmation fact carries the intent digest (Master Continuous Mission V2, 12 Oct 2026)', () => {
  // V2 settles R6a and names its parts: «مع نسخة العرض المختارة وبصمة القصد» —
  // the chosen quote version AND the intent digest. Revision 4 had the version
  // and not the digest.
  //
  // Why the digest is not the duplicate-truth defect revision 4 removed: the
  // version says WHICH row was agreed to, the digest says WHAT that row held.
  // Those are different questions, and the second one is the only one that can
  // still be answered after the row is gone or recomputed. `I6a.7` keeps the
  // stored digest from ever disagreeing with its source by admitting only the
  // source's own values — it extends the composite FK rather than copying a
  // value beside it.
  //
  // An interface is type-only, so the subject here is a VALUE typed as the DTO:
  // a field added to the interface and not to the hand-written list reds the
  // typecheck, and a field removed from the interface reds this case.
  const CONFIRMATION: OrderQuoteConfirmationDto = {
    confirmationId: '6b1f0a2c-0000-4000-8000-000000000001',
    quoteId: '6b1f0a2c-0000-4000-8000-000000000002',
    orderId: '6b1f0a2c-0000-4000-8000-000000000003',
    confirmedVersion: 3,
    // Whole seconds, like every other instant this package admits. The
    // fractional `.000Z` rendering a `Date#toISOString()` produces was here
    // until the coordinator's diff review at `b3719c0` pointed out that
    // `quote.test.ts` asserts that exact spelling is REFUSED (R-06): a shape
    // fixture that cannot pass the laws it is a fixture for teaches a reader
    // the wrong canonical form, even where the case only counts keys.
    confirmedAt: '2026-10-01T09:30:00Z',
    confirmedQuoteDigest: 'a'.repeat(64),
    confirmedQuoteExpiresAt: '2026-10-01T10:00:00Z',
    confirmedByUserId: null,
  };

  /** Hand-written from `OrderQuoteConfirmationDto`. Edited only when that interface is edited. */
  const DTO_KEYS: readonly string[] = [
    'confirmationId',
    'quoteId',
    'orderId',
    'confirmedVersion',
    'confirmedAt',
    'confirmedQuoteDigest',
    'confirmedQuoteExpiresAt',
    'confirmedByUserId',
  ];

  it('names the digest of the snapshot that was agreed to, not only its version', () => {
    expect(Object.keys(CONFIRMATION).sort()).toEqual([...DTO_KEYS].sort());
    expect(DTO_KEYS).toContain('confirmedQuoteDigest');
    expect(DTO_KEYS).toContain('confirmedVersion');
  });

  it('carries the same field list as a runtime value, so the law is executed and not only compiled', () => {
    // MEASURED: dropping `confirmedQuoteDigest` from the interface reds
    // `npm run typecheck` (TS2353) and leaves this suite green at 296, because
    // vitest transpiles without typechecking. The exported value closes that
    // gap — dropping the field from it reds HERE.
    expect([...ORDER_QUOTE_CONFIRMATION_FIELDS].sort()).toEqual([...DTO_KEYS].sort());
    expect([...ORDER_QUOTE_CONFIRMATION_FIELDS].sort()).toEqual(Object.keys(CONFIRMATION).sort());
    expect(Object.isFrozen(ORDER_QUOTE_CONFIRMATION_FIELDS)).toBe(true);
  });

  it('keeps the digest a required field, so a confirmation of an unidentified snapshot is unrepresentable', () => {
    // `confirmedByUserId` is the one nullable field — a shopper confirming on
    // the storefront is not a member. The digest is not among the nullable
    // ones: a confirmation that cannot say what it confirmed is not a
    // confirmation.
    const nullable = Object.entries(CONFIRMATION)
      .filter(([, v]) => v === null)
      .map(([k]) => k);
    expect(nullable).toEqual(['confirmedByUserId']);
    // `confirmedByUserId` is the ONLY nullable field. The expiry used to be
    // nullable too, and that nullability silently disabled the composite
    // foreign key — see the case below.
    expect(CONFIRMATION.confirmedQuoteDigest).toMatch(ORDER_QUOTE_DIGEST_PATTERN);
  });

  it('never carries a null expiry, because a null inside a composite key disables the whole key', () => {
    // MEASURED on PostgreSQL 16.15, as a non-superuser migrator, from the catalogue and then by
    // execution: `pg_constraint.confmatchtype = 's'` (MATCH SIMPLE), under which a composite
    // foreign key is skipped ENTIRELY if ANY of its columns is null. With this field nullable, a
    // confirmation naming an order, a quote, a version and a digest that no parent row had was
    // ACCEPTED — the seven-column key went unchecked, for exactly the quotes that never expire.
    // With `'infinity'` in place of the null, the same two attacks are refused and both lawful
    // cases (open-ended, and one microsecond before a real expiry) are still accepted.
    const openEnded: OrderQuoteConfirmationDto = { ...CONFIRMATION, confirmedQuoteExpiresAt: NO_QUOTE_EXPIRY };
    expect(openEnded.confirmedQuoteExpiresAt).toBe('infinity');
    expect(Object.values(openEnded).filter((v) => v === null)).toEqual([null]); // only confirmedByUserId
    // And the half-open rule still holds for it by arithmetic, with no special case: every
    // instant is strictly less than infinity.
    expect(ORDER_QUOTE_CONFIRMATION_FIELDS).toContain('confirmedQuoteExpiresAt');
  });

  it('carries the expiry it was shown, which is what makes the half-open window a same-row check', () => {
    // `confirmedAt < expiresAt` is a rule about TWO rows, and a SQL CHECK cannot read another
    // row — so without this field the rule needs a trigger, and a trigger is something an
    // operator can disable. MEASURED on PostgreSQL 16.15: with the quote's expiry pulled through
    // the same composite foreign key, a confirmation claiming a later expiry than its quote has
    // is refused by that key; with the key dropped, the identical row is accepted and stores a
    // confirmation twelve hours after the quote really expired.
    expect(DTO_KEYS).toContain('confirmedQuoteExpiresAt');
    expect(new Date(CONFIRMATION.confirmedAt).getTime()).toBeLessThan(new Date(CONFIRMATION.confirmedQuoteExpiresAt).getTime());
  });

  it('is not a settlement and carries no amount (I6a.6)', () => {
    // The fact that the shopper agreed is not the fact that money moved. A
    // money-shaped key here would make this relation a second answer to "what
    // was charged", which R6a exists to avoid.
    const moneyish = Object.keys(CONFIRMATION).filter((k) => /minor|amount|total|paid|settle|tender/i.test(k));
    expect(moneyish).toEqual([]);
    // The planted control, so the empty result above is a measurement.
    expect(Object.keys({ ...CONFIRMATION, paidTotalMinor: '1' }).filter((k) => /minor|amount|total|paid|settle|tender/i.test(k))).toEqual(['paidTotalMinor']);
  });
});

describe('every published error code is one this package can actually raise (challenger P3-01)', () => {
  // The previous test asserted that the published codes are non-empty,
  // duplicate-free and prefixed `order.` — and its title claimed they are codes
  // "this package can actually raise", which its body never reached. It stayed
  // green over `order.sale_binding_conflict`, a code whose only branch was
  // unreachable: the independent challenger measured a second `record_sale`
  // naming a different sale raising `order.transition_not_allowed` instead.
  //
  // So the subject set is now READ FROM THE SOURCE. Every `new OrderError('x'`
  // in `src/` is collected, and the published list must be a subset of it. A
  // published code with no `throw` behind it is now impossible to ship, and a
  // code that is raised without being published stays allowed — not every
  // refusal is a client's business.
  const raised = new Set<string>();
  const sourceDir = join(__dirname, '..', 'src');
  for (const file of readdirSync(sourceDir)) {
    if (!file.endsWith('.ts')) continue;
    const text = readFileSync(join(sourceDir, file), 'utf8');
    for (const match of text.matchAll(/new OrderError\(\s*'([^']+)'/g)) {
      const code = match[1];
      if (code !== undefined) raised.add(code);
    }
  }

  it('found the raise sites at all — the scan is not vacuously green', () => {
    // A scan that matched nothing would make the subset check below pass for
    // every possible published list, which is the failure mode of a test that
    // reads its own subject.
    expect(raised.size).toBeGreaterThan(20);
    expect(raised).toContain('order.quote_expired');
    expect(raised).not.toContain('order.sale_binding_conflict');
  });

  it('publishes no code the source never raises', () => {
    const unraisable = ORDER_CLIENT_ERROR_CODES.filter((code) => !raised.has(code));
    expect(unraisable).toEqual([]);
  });
});
