/**
 * P4-S4 — THE TWO PAYLOAD BOUNDS OF `POST /v1/customer-payments`:
 * THE ALLOCATION CAP, AND "ONCE PER INVOICE, EACH LEG WITH ITS OWN ID".
 *
 * Both rules are ENFORCED on this head and neither was ASSERTED anywhere.
 * Measured on `b7aeec2c` before this file existed:
 *
 *   `grep -rn CUSTOMER_PAYMENT_MAX_ALLOCATIONS tests/`            → EXIT 1, zero rows
 *   `grep -rn 'allocates once to each invoice' tests/`            → EXIT 1, zero rows
 *   `grep -rln receivables-payload tests/`                        → 3 files
 *
 * The third line is the probe's POSITIVE CONTROL: the module IS reachable from
 * the suite tree, so the two zeros are about these two rules and not about a
 * grep that could never have matched (RULE-3, RULE-11).
 *
 * ── WHY A POSITIVE CONTROL IN EVERY `it`, AND WHY NOT 50 REAL INVOICES ─────
 *
 * "51 allocations are refused" is satisfied by a server that refuses the
 * request for ANY reason — a malformed body, an unknown customer, a method
 * that wants a reference. What makes the refusal the CAP's is that the SAME
 * request shape with 50 legs gets PAST the cap and is refused for a different,
 * named reason. That control costs nothing: the 50 legs name invoice ids that
 * do not exist, so the request walks the whole payload layer, is admitted by
 * it, and dies at the invoice lookup with `customer_payment.not_found`
 * (`customer-payment.service.ts:610-614`). Seeding 50 real invoices would
 * prove the same thing and buy a minute of fixture per run.
 *
 * ── THE GATES, ENUMERATED AND THEN CORRECTED BY THE PLANTS ────────────────
 *
 * A negative control that disables ONE of several gates is a BLIND control, so
 * every gate standing behind each rule is named here. This list was written
 * from the source FIRST and was WRONG by one gate in each rule; the plants
 * below are what found the missing one, and it is left on the record because
 * "I enumerated the gates" is worth nothing without the thing that checked
 * the enumeration.
 *
 * THE CAP, three places:
 *   G1  zod `.max(CUSTOMER_PAYMENT_MAX_ALLOCATIONS)` —
 *       `apps/api/src/modules/receivables/receivables.schemas.ts:161`,
 *       reached through the route's `ZodValidationPipe`
 *       (`receivables.controller.ts:68`).
 *   G2  `assertAllocations`' length check —
 *       `apps/api/src/modules/receivables/receivables-payload.ts:258`,
 *       reached from `collectIntentFields` (`:301`) and so from
 *       `customerCollectPaymentIntentSha256` (`:322`).
 *   G3  THE ROUTINE ITSELF, in PL/pgSQL: `customer_collect_payment` raises
 *       `customer_payment.allocations_invalid: a payment is allocated to
 *       0..50 distinct open invoices in positive amounts, with an optional
 *       trimmed reference` (`0081:1957`). This file first said "nothing in the
 *       database", and the plant on G2 is what proved that claim false.
 *
 * G1 STANDS IN FRONT OF G2, AND G2 IN FRONT OF G3, over the same bound. So the
 * route can never reach G2, and a suite that only POSTs would be asserting one
 * gate while believing it asserted the cap. That is why the third `it` calls
 * the payload builder DIRECTLY: G2 gets its own assertion at the layer where
 * it is the only thing standing.
 *
 * ONCE PER INVOICE / ONE ID PER LEG, four places:
 *   H1  zod: NOTHING. `CustomerPaymentAllocationSchema`
 *       (`receivables.schemas.ts:91-98`) is a `.strict()` object and the array
 *       at `:161` carries `.max()` alone — no `.refine`, no `.superRefine`.
 *       The absence is SIGHTED: the same array line does carry the cap, which
 *       this file proves zod answers, so "zod has no uniqueness rule" is read
 *       off a line that demonstrably works.
 *   H2  `assertAllocations` —
 *       `receivables-payload.ts:259-261`, one `if` covering BOTH halves:
 *       repeated `allocationId` and repeated `invoiceId` raise the SAME
 *       message, so a client cannot tell which half answered. Asserted below,
 *       and stated as a finding rather than hidden.
 *   H3  THE ROUTINE, the same `0081:1957` as G3 — `distinct open invoices` is
 *       one law with the cap. MEASURED, not read: with H2 disabled, a payment
 *       naming one real invoice twice came back `400 VALIDATION_FAILED` /
 *       `customer_payment.allocations_invalid` WITH NO `details.reason`, which
 *       is how the routine's refusal differs from H2's.
 *   H4  the two UNIQUE constraints,
 *       `payment_allocations_invoice_uq (business_id, payment_id, invoice_id)`
 *       (`0081:326`) and
 *       `payment_allocations_line_no_uq (business_id, payment_id, line_no)`
 *       (`0081:325`). NOT REACHED even with H2 removed, because H3 answers
 *       first; and neither name is in `UNIQUE_KEY_REFUSALS`
 *       (`receivables-errors.ts:366-368`), so if one ever did fire it would be
 *       re-thrown untouched rather than classified. That is a note for the
 *       owner, not something this file asserts.
 *
 * ── THE REFUSALS AS THE ENVELOPE RENDERS THEM ─────────────────────────────
 *
 * `GlobalExceptionFilter` (`apps/api/src/common/error.filter.ts:54-59`) turns a
 * `ZodError` into `400 VALIDATION_FAILED` with `details.issues`, and an
 * `AppError` (`:42-45`) into its own status with `details.receivablesCode`.
 * So G1, G2 and G3 share a status AND a top-level code: G1 is told apart by
 * carrying `details.issues`, G2 by carrying `details.reason`, and G3 by
 * carrying NEITHER. All three are measured below, and the one a client cannot
 * resolve — WHICH half of H2 refused it — is asserted as today's answer so a
 * future improvement breaks the test instead of passing unnoticed.
 *
 * `AppError.message` is the generic `'Validation failed'`
 * (`receivables-errors.ts:320`), never `assertAllocations`' sentence, so a
 * `toThrow('a payment has 0..50 allocations')` is RED against a server that
 * refuses correctly. The first run of this file proved that and the third `it`
 * reads `details` instead.
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CUSTOMER_PAYMENT_MAX_ALLOCATIONS,
  customerCollectPaymentIntentSha256,
  type CollectPaymentIntentAllocation,
  type CollectPaymentIntentInput,
} from '../../apps/api/src/modules/receivables/receivables-payload';
import { requireSubject } from '../golden-regression/phase4-s2/harness';
import { derivedRead, type DerivedRead } from '../golden-regression/phase4-s4/harness';
import { collectPayment, derivedChildId, type AllocationInput } from '../golden-regression/phase4-s4/settlement-path';
import {
  newCustomer,
  sellOnCredit,
  settlementMissing,
  settlementWorld,
  stockUp,
  type OpenInvoice,
  type SettlementWorld,
} from '../golden-regression/phase4-s4/settlement-world';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';

const CLAIM =
  'POST /v1/customer-payments refuses a payment carrying more than CUSTOMER_PAYMENT_MAX_ALLOCATIONS allocations, and refuses a payment that allocates twice to one invoice or twice under one allocation id';

/** The refusal of one request, as a client reads it off the envelope. */
interface Refusal {
  readonly status: number;
  /** `body.error.code` — the API's stable top-level code. */
  readonly code: string;
  /** `body.error.details.receivablesCode`, or `null` when the answer did not come from an `AppError`. */
  readonly receivablesCode: string | null;
  /** `body.error.details.reason` — `assertAllocations`' own sentence. */
  readonly reason: string | null;
  /** `details.issues`, flattened to `path:code`, which only a `ZodError` carries. */
  readonly issues: readonly string[];
}

function refusalOf(res: Response): Refusal {
  const error = (res.body as { error?: Record<string, unknown> } | undefined)?.error ?? {};
  const details = (error['details'] as Record<string, unknown> | undefined) ?? {};
  const rawIssues = details['issues'];
  return {
    status: res.status,
    code: typeof error['code'] === 'string' ? error['code'] : '',
    receivablesCode: typeof details['receivablesCode'] === 'string' ? details['receivablesCode'] : null,
    reason: typeof details['reason'] === 'string' ? details['reason'] : null,
    issues: Array.isArray(rawIssues)
      ? rawIssues.map((i) => {
          const o = (i ?? {}) as Record<string, unknown>;
          return `${String(o['path'] ?? '')}:${String(o['code'] ?? '')}`;
        })
      : [],
  };
}

/** The identity of a refusal for the purpose of "these two reasons DIFFER": everything a client can act on. */
function refusalIdentity(r: Refusal): string {
  return JSON.stringify([r.status, r.code, r.receivablesCode, r.reason, [...r.issues].sort()]);
}

/** Does the stored estate hold a payment under this id? The readback that says "nothing moved". */
async function paymentRows(businessId: string, paymentId: string): Promise<number> {
  const r = await ownerPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM payments WHERE business_id = $1 AND id = $2`, [businessId, paymentId]);
  return Number(r.rows[0]?.n ?? '-1');
}

/** Allocation rows of a payment, so "no leg landed either" is read and not inferred from the header alone. */
async function allocationRows(businessId: string, paymentId: string): Promise<number> {
  const r = await ownerPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM payment_allocations WHERE business_id = $1 AND payment_id = $2`, [
    businessId,
    paymentId,
  ]);
  return Number(r.rows[0]?.n ?? '-1');
}

/**
 * `n` legs of one minor unit each, every leg naming a DIFFERENT invoice id
 * that does not exist, and every leg carrying its own derived allocation id.
 *
 * One minor unit per leg so `Σ paymentAmountMinor = amountMinor = n` exactly:
 * `assertAllocations` refuses a payment that allocates more than it received
 * and refuses a `creditId` that does not match a surplus, and a case that
 * tripped either of those would be a case about arithmetic rather than about
 * the cap.
 */
function unknownLegs(n: number): readonly AllocationInput[] {
  return Array.from(
    { length: n },
    (): AllocationInput => ({
      invoiceId: randomUUID(),
      appliedMinor: '1',
      releasedBeforeMinor: '0',
      invoiceTotalTxnMinor: '0',
      invoiceTotalBaseMinor: '0',
    }),
  );
}

let w: SettlementWorld;
let missing: readonly string[] = [];
let customer = '';
let invoice: OpenInvoice;
/** The reader of record on the one real invoice, BEFORE any request of this file. */
let readBefore: DerivedRead;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  w = await settlementWorld('s4cap');
  missing = await settlementMissing(w);
  if (missing.length > 0) return;

  // ONE real invoice, through the real sale command. It is here for the
  // READBACK and for the duplicate case: an outstanding that is already zero
  // cannot be shown not to have moved, and a duplicate allocation to an
  // invoice that does not exist would be refused by the invoice lookup before
  // the uniqueness rule could be the thing that answered.
  await stockUp(w, '100', '9');
  customer = await newCustomer(w);
  invoice = await sellOnCredit(w, customer, '3');
  readBefore = await derivedRead(ownerPool(), w.shop.businessId, invoice.invoiceId);
  expect(
    readBefore.outstandingTxnMinor > 0n,
    `NO SUBJECT — the invoice owes ${readBefore.outstandingTxnMinor}, so "the outstanding did not move" would hold over a figure that is already zero`,
  ).toBe(true);
}, 420_000);

afterAll(async () => {
  await w?.t?.close?.();
});

describe('P4-S4 — the allocation cap and the once-per-invoice rule of POST /v1/customer-payments', () => {
  /**
   * GATES: G1 (zod `.max`, `receivables.schemas.ts:161`) in front of G2
   * (`assertAllocations`, `receivables-payload.ts:258`) in front of G3 (the
   * routine, `0081:1957`).
   *
   * PLANT THAT MADE THIS RED: G1 relaxed to
   * `.max(CUSTOMER_PAYMENT_MAX_ALLOCATIONS + 1)` at `receivables.schemas.ts:161`,
   * leaving G2 untouched. The 51-leg request then fell through to G2 and came
   * back
   *   `{"error":{"code":"VALIDATION_FAILED","details":{"reason":"a payment has
   *     0..50 allocations","receivablesCode":"customer_payment.allocations_invalid"}}}`
   * instead of a `ZodError`'s `issues`, and this failed:
   *   `expected [] to include 'allocations:too_big'`.
   *
   * THE BLIND CONTROL, MEASURED: relaxing G2 ALONE left this `it` GREEN — 3
   * passed, 1 failed, and the one failure was the direct-layer `it` below, not
   * this one. That is the whole reason G2 gets its own `it`: a suite that only
   * POSTed would have reported this cap covered while the payload layer's
   * check was gone.
   */
  it(`refuses ${CUSTOMER_PAYMENT_MAX_ALLOCATIONS + 1} allocations BY THE CAP, while ${CUSTOMER_PAYMENT_MAX_ALLOCATIONS} of the same shape get past it`, async () => {
    requireSubject(missing, CLAIM);

    const overId = randomUUID();
    const atId = randomUUID();
    const over = unknownLegs(CUSTOMER_PAYMENT_MAX_ALLOCATIONS + 1);
    const at = unknownLegs(CUSTOMER_PAYMENT_MAX_ALLOCATIONS);

    const overRes = await collectPayment(w.t, w.headers, {
      paymentId: overId,
      customerId: customer,
      paymentMethodId: w.paymentMethodId,
      paymentDate: w.day,
      amountMinor: String(over.length),
      allocations: over,
    });
    const atRes = await collectPayment(w.t, w.headers, {
      paymentId: atId,
      customerId: customer,
      paymentMethodId: w.paymentMethodId,
      paymentDate: w.day,
      amountMinor: String(at.length),
      allocations: at,
    });
    const overR = refusalOf(overRes);
    const atR = refusalOf(atRes);

    // THE CAP'S OWN REFUSAL. `400`, and from zod: the `issues` key is the one
    // thing only a `ZodError` puts in the envelope, and it names the array.
    expect(overR.status, `${over.length} allocations are refused with 400, not ${overR.status}: ${JSON.stringify(overRes.body)}`).toBe(400);
    expect(overR.code, `${over.length} allocations are refused as VALIDATION_FAILED, not ${overR.code}`).toBe('VALIDATION_FAILED');
    expect(
      overR.issues,
      `${over.length} allocations are refused by the zod cap (G1), whose envelope names the allocations array: ${JSON.stringify(overRes.body)}`,
    ).toContain('allocations:too_big');
    expect(
      overR.receivablesCode,
      `the ${over.length}-leg refusal came from zod (G1), so it carries no receivablesCode — it carried ${String(overR.receivablesCode)}`,
    ).toBeNull();

    // THE POSITIVE CONTROL. The same shape one leg shorter is NOT judged by
    // the cap: it is admitted by zod AND by `assertAllocations`, and dies at
    // the invoice lookup. A 400 here would mean the 51-refusal above said
    // nothing about the cap.
    expect(atR.status, `${at.length} allocations get past the cap and are refused for naming unknown invoices: ${JSON.stringify(atRes.body)}`).toBe(404);
    expect(atR.code, `the ${at.length}-leg refusal is NOT_FOUND, not ${atR.code}`).toBe('NOT_FOUND');
    expect(
      atR.receivablesCode,
      `the ${at.length}-leg refusal names the invoice lookup, which is a DIFFERENT reason from the cap: ${JSON.stringify(atRes.body)}`,
    ).toBe('customer_payment.not_found');
    expect(atR.issues, `the ${at.length}-leg refusal did not come from zod, so it carries no issues: ${JSON.stringify(atR.issues)}`).toStrictEqual([]);

    // AND THE TWO REASONS DIFFER. Asserted on the whole client-visible
    // identity, so a future server that collapsed both onto one code would
    // fail here rather than quietly make the control blind.
    expect(
      refusalIdentity(overR),
      `the ${over.length}-leg refusal and the ${at.length}-leg refusal are DIFFERENT refusals; if they were equal the cap case proved only "this shape is refused"`,
    ).not.toBe(refusalIdentity(atR));

    // NOTHING MOVED. Neither request is a payment, neither left a leg, and the
    // reader of record on the one real invoice is where the sale left it.
    for (const [label, id] of [
      [`${over.length} allocations`, overId],
      [`${at.length} allocations`, atId],
    ] as const) {
      expect(await paymentRows(w.shop.businessId, id), `the refused payment of ${label} created no payments row`).toBe(0);
      expect(await allocationRows(w.shop.businessId, id), `the refused payment of ${label} created no payment_allocations row`).toBe(0);
    }
    const after = await derivedRead(ownerPool(), w.shop.businessId, invoice.invoiceId);
    expect(
      after.outstandingTxnMinor,
      `the invoice's outstanding is unchanged by two refused payments: ${after.outstandingTxnMinor} vs ${readBefore.outstandingTxnMinor}`,
    ).toBe(readBefore.outstandingTxnMinor);
    expect(after.paidTxnMinor, `the invoice's paid amount is unchanged by two refused payments`).toBe(readBefore.paidTxnMinor);
  }, 180_000);

  /**
   * GATE G2 AT ITS OWN LAYER.
   *
   * G1 stands in front of G2 for every client, so this is the only place G2
   * can be measured without disabling G1. The call is the one the service
   * makes (`customer-payment.service.ts:576`) and `assertAllocations` is its
   * first statement (`receivables-payload.ts:301`).
   *
   * PLANT THAT MADE THIS RED: G2's comparison widened to
   * `a.length > CUSTOMER_PAYMENT_MAX_ALLOCATIONS + 1` at
   * `receivables-payload.ts:258`, G1 left intact. The 51-allocation call then
   * returned a digest instead of throwing, and this failed:
   *   `G2 refuses 51 allocations at receivables-payload.ts:258 — nothing was
   *    thrown, so the builder digested an over-cap payment: expected undefined
   *    to be an instance of Error`.
   * The route `it` above stayed GREEN on that same run, which is the blind
   * control it names.
   *
   * `CUSTOMER_PAYMENT_MAX_ALLOCATIONS` itself was never touched: it is a
   * sealed money constant, and a plant that moves the constant moves G1, G2
   * and every assertion's expected value at once, so it proves nothing about
   * any of them.
   */
  it(`the payload builder itself refuses ${CUSTOMER_PAYMENT_MAX_ALLOCATIONS + 1} allocations, and digests ${CUSTOMER_PAYMENT_MAX_ALLOCATIONS}`, () => {
    const intentLegs = (n: number): readonly CollectPaymentIntentAllocation[] =>
      Array.from({ length: n }, (_, i): CollectPaymentIntentAllocation => {
        const allocationId = derivedChildId('11111111-1111-4111-8111-111111111111', i);
        return { allocationId, invoiceId: randomUUID(), paymentAmountMinor: 1n, appliedMinor: 1n };
      });
    const intent = (n: number): CollectPaymentIntentInput => ({
      tenantId: randomUUID(),
      businessId: randomUUID(),
      paymentId: randomUUID(),
      customerId: randomUUID(),
      paymentMethodId: randomUUID(),
      paymentDate: '2026-01-15',
      currency: 'ILS',
      amountMinor: BigInt(n),
      reference: null,
      creditId: null,
      allocations: intentLegs(n),
    });

    // THE POSITIVE CONTROL FIRST: at the cap the builder digests, so the
    // throw below is the length check and not the shape of this fixture.
    const atTheCap = customerCollectPaymentIntentSha256(intent(CUSTOMER_PAYMENT_MAX_ALLOCATIONS));
    expect(
      atTheCap,
      `${CUSTOMER_PAYMENT_MAX_ALLOCATIONS} allocations digest, so the refusal of one more is the cap (G2) and not this fixture: got ${atTheCap}`,
    ).toMatch(/^[0-9a-f]{64}$/);

    // MEASURED, NOT ASSUMED: `receivablesRefusal` builds an `AppError` whose
    // MESSAGE is the generic `'Validation failed'`
    // (`receivables-errors.ts:320`) and whose `details` carry the code and
    // `assertAllocations`' own sentence. So `toThrow('a payment has 0..50
    // allocations')` is RED on a server that refuses correctly — the first run
    // of this file proved exactly that — and the reason is read off `details`.
    let thrown: unknown;
    try {
      customerCollectPaymentIntentSha256(intent(CUSTOMER_PAYMENT_MAX_ALLOCATIONS + 1));
    } catch (e) {
      thrown = e;
    }
    expect(
      thrown,
      `G2 refuses ${CUSTOMER_PAYMENT_MAX_ALLOCATIONS + 1} allocations at receivables-payload.ts:258 — nothing was thrown, so the builder digested an over-cap payment`,
    ).toBeInstanceOf(Error);
    const details = (thrown as { details?: Record<string, unknown> }).details ?? {};
    expect(details['receivablesCode'], `G2's refusal is classified as the allocation-list refusal: ${JSON.stringify(details)}`).toBe(
      'customer_payment.allocations_invalid',
    );
    expect(details['reason'], `G2's refusal names the cap by its own sentence: ${JSON.stringify(details)}`).toBe(
      `a payment has 0..${CUSTOMER_PAYMENT_MAX_ALLOCATIONS} allocations`,
    );
    // AND THE SENTENCE DIFFERS FROM H2'S, so the two rules of this file are
    // distinguishable from each other inside `assertAllocations` even though
    // they share one code.
    expect(details['reason'], `the cap's sentence is not the once-per-invoice sentence`).not.toBe(
      'a payment allocates once to each invoice, each allocation with its own id',
    );
  });

  /**
   * GATES: H1 is NOTHING (zod has no uniqueness rule — see the header), H2 is
   * `assertAllocations` (`receivables-payload.ts:259-261`), H3 is the routine
   * (`0081:1957`), H4 is the two UNIQUE constraints (`0081:325-326`).
   *
   * PLANT THAT MADE THIS RED: H2's uniqueness `if` disabled by `false &&` at
   * `receivables-payload.ts:259`. Two `it`s went red together and the duplicate
   * request came back
   *   `{"error":{"code":"VALIDATION_FAILED","details":{"receivablesCode":
   *     "customer_payment.allocations_invalid"}}}`
   * — the same code, NO `details.reason` — so this failed:
   *   `the duplicate-invoice refusal carries H2's own sentence: expected null
   *    to be 'a payment allocates once to each invo…'`.
   *
   * THAT IS WHERE H3 CAME FROM. Before the plant this file said the next gate
   * was a UNIQUE constraint; the run says the next gate is the ROUTINE's own
   * `0..50 distinct open invoices` law, which classifies its refusal and
   * therefore never reaches H4. The enumeration was corrected from the
   * measurement, not the other way round.
   */
  it('refuses two allocations to the SAME invoice, while two DISTINCT invoices get past that rule', async () => {
    requireSubject(missing, CLAIM);

    const dupId = randomUUID();
    const distinctId = randomUUID();
    const leg = (invoiceId: string): AllocationInput => ({
      invoiceId,
      appliedMinor: '1',
      releasedBeforeMinor: '0',
      invoiceTotalTxnMinor: invoice.totalTxnMinor,
      invoiceTotalBaseMinor: invoice.totalBaseMinor,
    });

    // The duplicate names the REAL invoice twice, so the invoice lookup cannot
    // be what answers and the uniqueness rule is the only thing left standing.
    const dupRes = await collectPayment(w.t, w.headers, {
      paymentId: dupId,
      customerId: customer,
      paymentMethodId: w.paymentMethodId,
      paymentDate: w.day,
      amountMinor: '2',
      allocations: [leg(invoice.invoiceId), leg(invoice.invoiceId)],
    });
    // THE POSITIVE CONTROL: the identical body with the second leg naming a
    // DIFFERENT invoice gets past the uniqueness rule and dies at the lookup.
    const distinctRes = await collectPayment(w.t, w.headers, {
      paymentId: distinctId,
      customerId: customer,
      paymentMethodId: w.paymentMethodId,
      paymentDate: w.day,
      amountMinor: '2',
      allocations: [leg(invoice.invoiceId), leg(randomUUID())],
    });
    const dupR = refusalOf(dupRes);
    const distinctR = refusalOf(distinctRes);

    expect(dupR.status, `two allocations to one invoice are refused with 400, not ${dupR.status}: ${JSON.stringify(dupRes.body)}`).toBe(400);
    expect(dupR.code, `the duplicate-invoice refusal is VALIDATION_FAILED, not ${dupR.code}`).toBe('VALIDATION_FAILED');
    expect(dupR.receivablesCode, `the duplicate-invoice refusal names the allocation list (H2): ${JSON.stringify(dupRes.body)}`).toBe(
      'customer_payment.allocations_invalid',
    );
    expect(dupR.reason, `the duplicate-invoice refusal carries H2's own sentence: ${JSON.stringify(dupRes.body)}`).toBe(
      'a payment allocates once to each invoice, each allocation with its own id',
    );

    expect(
      distinctR.status,
      `two DISTINCT invoices get past the uniqueness rule and are refused for naming an unknown invoice: ${JSON.stringify(distinctRes.body)}`,
    ).toBe(404);
    expect(distinctR.receivablesCode, `the distinct-invoice refusal names a DIFFERENT reason: ${JSON.stringify(distinctRes.body)}`).toBe(
      'customer_payment.not_found',
    );
    expect(
      refusalIdentity(dupR),
      `the duplicate refusal and the distinct-invoice refusal are DIFFERENT refusals; equal ones would make this control blind`,
    ).not.toBe(refusalIdentity(distinctR));

    for (const [label, id] of [
      ['two allocations to one invoice', dupId],
      ['two allocations to two invoices', distinctId],
    ] as const) {
      expect(await paymentRows(w.shop.businessId, id), `the refused payment of ${label} created no payments row`).toBe(0);
      expect(await allocationRows(w.shop.businessId, id), `the refused payment of ${label} created no payment_allocations row`).toBe(0);
    }
    const after = await derivedRead(ownerPool(), w.shop.businessId, invoice.invoiceId);
    expect(
      after.outstandingTxnMinor,
      `the invoice's outstanding is unchanged by the two refused payments: ${after.outstandingTxnMinor} vs ${readBefore.outstandingTxnMinor}`,
    ).toBe(readBefore.outstandingTxnMinor);
  }, 180_000);

  /**
   * THE SECOND HALF OF H2, AND A FINDING ABOUT IT.
   *
   * `assertAllocations` judges repeated `allocationId` and repeated
   * `invoiceId` in ONE `if` with ONE message, so the refusal a client reads is
   * byte-identical for the two. This `it` asserts the refusal AND asserts the
   * indistinguishability, because a later server that gave the two halves
   * separate reasons would be an IMPROVEMENT a client could act on, and it
   * should break a test that records today's answer rather than pass silently.
   *
   * PLANT: the same plant as the previous `it` — the one `if` is both halves —
   * and it turned this `it` red in the same run, with
   *   `two legs sharing one allocationId are refused with 400, not 404:
   *    {"error":{"code":"NOT_FOUND","details":{"receivablesCode":
   *     "customer_payment.not_found"}}}`.
   * The red is informative in its own right: with H2 gone, a repeated
   * allocation id over DISTINCT invoices is not judged by the routine's
   * `distinct open invoices` law at all — the invoice lookup answers first —
   * so H2 is the ONLY gate standing behind the repeated-id half, where the
   * repeated-invoice half has H3 behind it as well.
   */
  it('refuses two allocations sharing ONE allocationId, with a refusal a client cannot tell from the duplicate-invoice one', async () => {
    requireSubject(missing, CLAIM);

    const sharedId = randomUUID();
    const sharedAllocationId = derivedChildId(sharedId, 0);
    const paymentId = randomUUID();
    const res = await collectPayment(w.t, w.headers, {
      paymentId,
      customerId: customer,
      paymentMethodId: w.paymentMethodId,
      paymentDate: w.day,
      amountMinor: '2',
      allocations: [
        {
          allocationId: sharedAllocationId,
          invoiceId: invoice.invoiceId,
          appliedMinor: '1',
          releasedBeforeMinor: '0',
          invoiceTotalTxnMinor: invoice.totalTxnMinor,
          invoiceTotalBaseMinor: invoice.totalBaseMinor,
        },
        {
          allocationId: sharedAllocationId,
          invoiceId: randomUUID(),
          appliedMinor: '1',
          releasedBeforeMinor: '0',
          invoiceTotalTxnMinor: '0',
          invoiceTotalBaseMinor: '0',
        },
      ],
    });
    const r = refusalOf(res);

    expect(r.status, `two legs sharing one allocationId are refused with 400, not ${r.status}: ${JSON.stringify(res.body)}`).toBe(400);
    expect(r.receivablesCode, `the shared-allocationId refusal names the allocation list (H2): ${JSON.stringify(res.body)}`).toBe(
      'customer_payment.allocations_invalid',
    );
    expect(r.reason, `the shared-allocationId refusal carries H2's own sentence: ${JSON.stringify(res.body)}`).toBe(
      'a payment allocates once to each invoice, each allocation with its own id',
    );

    // THE POSITIVE CONTROL: the two invoice ids here are DISTINCT, so the only
    // thing wrong with this body is the repeated allocation id — the refusal
    // above is about the id and not about the invoice.
    const distinct = await collectPayment(w.t, w.headers, {
      paymentId: randomUUID(),
      customerId: customer,
      paymentMethodId: w.paymentMethodId,
      paymentDate: w.day,
      amountMinor: '2',
      allocations: [
        {
          allocationId: derivedChildId(sharedId, 1),
          invoiceId: invoice.invoiceId,
          appliedMinor: '1',
          releasedBeforeMinor: '0',
          invoiceTotalTxnMinor: invoice.totalTxnMinor,
          invoiceTotalBaseMinor: invoice.totalBaseMinor,
        },
        {
          allocationId: derivedChildId(sharedId, 2),
          invoiceId: randomUUID(),
          appliedMinor: '1',
          releasedBeforeMinor: '0',
          invoiceTotalTxnMinor: '0',
          invoiceTotalBaseMinor: '0',
        },
      ],
    });
    expect(
      refusalOf(distinct).receivablesCode,
      `with DISTINCT allocation ids the same two-leg body gets past H2 and is refused for the unknown invoice: ${JSON.stringify(distinct.body)}`,
    ).toBe('customer_payment.not_found');

    // THE FINDING, ASSERTED: a duplicate INVOICE and a duplicate ALLOCATION ID
    // answer the same sentence, so a client cannot tell which half refused it.
    const dupInvoice = await collectPayment(w.t, w.headers, {
      paymentId: randomUUID(),
      customerId: customer,
      paymentMethodId: w.paymentMethodId,
      paymentDate: w.day,
      amountMinor: '2',
      allocations: [
        {
          allocationId: derivedChildId(sharedId, 3),
          invoiceId: invoice.invoiceId,
          appliedMinor: '1',
          releasedBeforeMinor: '0',
          invoiceTotalTxnMinor: invoice.totalTxnMinor,
          invoiceTotalBaseMinor: invoice.totalBaseMinor,
        },
        {
          allocationId: derivedChildId(sharedId, 4),
          invoiceId: invoice.invoiceId,
          appliedMinor: '1',
          releasedBeforeMinor: '0',
          invoiceTotalTxnMinor: invoice.totalTxnMinor,
          invoiceTotalBaseMinor: invoice.totalBaseMinor,
        },
      ],
    });
    expect(
      refusalIdentity(refusalOf(dupInvoice)),
      "TODAY'S ANSWER, RECORDED: one message covers both halves of H2, so the repeated-invoice refusal and the repeated-allocationId refusal are indistinguishable to a client. If this ever fails, the server told the two halves apart and this test should be split, not relaxed.",
    ).toBe(refusalIdentity(r));

    expect(await paymentRows(w.shop.businessId, paymentId), 'the refused payment sharing one allocationId created no payments row').toBe(0);
  }, 180_000);
});
