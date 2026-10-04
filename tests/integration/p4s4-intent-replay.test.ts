/**
 * P4-S4 — A REPLAY OF A STORED CUSTOMER PAYMENT IS A REPLAY, NOT A CONFLICT.
 *
 * `payments.intent_sha256` is computed and stored by the ROUTINE
 * (`customer_collect_payment`, `0081:1851-1865`), and
 * `customer-payment.service.ts` compares its own digest against that stored
 * value before it does anything else. The two are therefore the same claim
 * written twice — once in SQL and once in TypeScript — and nothing but an
 * end-to-end replay proves they agree.
 *
 * THE DEFECT THIS SUITE EXISTS FOR. The service used to compute the intent
 * BEFORE its state read, which forced two divergences from the routine:
 *
 *   - it signed the client's NULLABLE `currency` where `0081:1859` signs
 *     `lower(p_currency_code::text)`, the resolved code, which the routine's own
 *     shape check refuses as NULL (`0081:1877-1881`);
 *   - it omitted `credit_amount` where `0081:1861` signs
 *     `p_credit_amount_minor`, named in the routine's COMMENT at `0081:2151` as
 *     part of the request-only intent — so the two streams differed in LENGTH,
 *     16 header fields against 17.
 *
 * The digests disagreed on EVERY payment, so the second delivery of a request
 * a client is entitled to retry came back
 * `customer_payment.idempotency_conflict`. Both sides now follow the migration:
 * the currency is resolved before the digest, and `credit_amount` is derived
 * inside `receivables-payload.ts` from the request alone.
 *
 * Why a replay and not a comparison of two field lists: a unit comparison of
 * the streams is in §D and is worth having, but it can only ever check the
 * shape someone WROTE DOWN. §A–§C put the real routine on the other end, so the
 * assertion is against what the database actually stored.
 *
 * Every case replays a BYTE-IDENTICAL request — `collectPayment` serialises a
 * `PaymentInput` deterministically — and requires `replayed: true` with no
 * second document row and no second journal entry. §C keeps the other half
 * honest: a genuinely different command on the same payment id still conflicts,
 * so this suite cannot pass by making every replay succeed.
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { customerCollectPaymentIntentSha256, type CollectPaymentIntentAllocation } from '../../apps/api/src/modules/receivables/receivables-payload';
import { appliedTotal, collectPayment, allocationRequestBody, type AllocationInput, type PaymentInput } from '../golden-regression/phase4-s4/settlement-path';
import {
  newCustomer,
  sellOnCredit,
  settlementMissing,
  settlementWorld,
  stockUp,
  type OpenInvoice,
  type SettlementWorld,
} from '../golden-regression/phase4-s4/settlement-world';

const CLAIM = 'a byte-identical second delivery of a customer payment replays the stored rows; the service digest equals the one the routine stored';

let w: SettlementWorld;
let missing: readonly string[] = [];

/** The leg a suite states for an invoice at the START of its chain. */
function wholeInvoiceLeg(inv: OpenInvoice): AllocationInput {
  return {
    invoiceId: inv.invoiceId,
    appliedMinor: inv.totalTxnMinor,
    releasedBeforeMinor: '0',
    invoiceTotalTxnMinor: inv.totalTxnMinor,
    invoiceTotalBaseMinor: inv.totalBaseMinor,
  };
}

/** How many rows of each kind this payment owns, read after the fact. */
async function footprint(paymentId: string): Promise<{ payments: number; allocations: number; credits: number; entries: number }> {
  const q = ownerPool();
  const b = w.shop.businessId;
  const one = async (sql: string, params: readonly unknown[]): Promise<number> => {
    const r = await q.query<{ n: number }>(sql, [...params]);
    return r.rows[0]?.n ?? 0;
  };
  return {
    payments: await one(`SELECT count(*)::int AS n FROM payments WHERE business_id = $1 AND id = $2`, [b, paymentId]),
    allocations: await one(`SELECT count(*)::int AS n FROM payment_allocations WHERE business_id = $1 AND payment_id = $2`, [b, paymentId]),
    credits: await one(`SELECT count(*)::int AS n FROM customer_credits WHERE business_id = $1 AND origin_payment_id = $2`, [b, paymentId]),
    entries: await one(
      `SELECT count(*)::int AS n FROM journal_entries je
        WHERE je.business_id = $1
          AND je.source_type IN ('customer_payment_allocation', 'customer_credit')
          AND (je.source_id IN (SELECT a.id FROM payment_allocations a WHERE a.business_id = $1 AND a.payment_id = $2)
               OR je.source_id IN (SELECT c.id FROM customer_credits c WHERE c.business_id = $1 AND c.origin_payment_id = $2))`,
      [b, paymentId],
    ),
  };
}

/** The `intent_sha256` the ROUTINE stored for this payment. */
async function storedIntent(paymentId: string): Promise<string | null> {
  const r = await ownerPool().query<{ s: string }>(`SELECT intent_sha256 AS s FROM payments WHERE business_id = $1 AND id = $2`, [
    w.shop.businessId,
    paymentId,
  ]);
  return r.rows[0]?.s ?? null;
}

/** The business's own base currency, as the server would resolve a NULL to. */
async function baseCurrency(): Promise<string> {
  const r = await ownerPool().query<{ c: string }>(`SELECT base_currency::text AS c FROM businesses WHERE id = $1`, [w.shop.businessId]);
  const c = r.rows[0]?.c;
  expect(c, 'the business has no base currency, so this suite has no subject').toBeDefined();
  return c as string;
}

/** The digest the SERVICE computes, rebuilt here from the same request. */
function serviceIntent(input: PaymentInput, currency: string): string {
  const allocations: CollectPaymentIntentAllocation[] = input.allocations.map((leg, i) => {
    const body = allocationRequestBody(leg, input.paymentId, i);
    return {
      allocationId: body.allocationId,
      invoiceId: body.invoiceId,
      paymentAmountMinor: BigInt(body.paymentAmountMinor),
      appliedMinor: BigInt(body.invoiceAmountAppliedMinor),
    };
  });
  return customerCollectPaymentIntentSha256({
    tenantId: w.shop.tenantId,
    businessId: w.shop.businessId,
    paymentId: input.paymentId,
    customerId: input.customerId,
    paymentMethodId: input.paymentMethodId,
    paymentDate: input.paymentDate,
    currency,
    amountMinor: BigInt(input.amountMinor),
    reference: input.reference ?? null,
    creditId: input.creditId ?? null,
    allocations,
  });
}

/**
 * The refusal code of a response, from where the API actually puts it:
 * `error.details.receivablesCode` (`receivables-errors.ts:278`, and the field
 * `apps/web/src/lib/client.ts:185` reads).
 */
function refusalCode(res: Response): string | undefined {
  const body = res.body as { error?: { details?: { receivablesCode?: string } } };
  return body.error?.details?.receivablesCode;
}

/** One scenario: collected once, then delivered again byte for byte. */
interface Replay {
  readonly input: PaymentInput;
  readonly first: Response;
  readonly second: Response;
  readonly afterFirst: Awaited<ReturnType<typeof footprint>>;
  readonly afterSecond: Awaited<ReturnType<typeof footprint>>;
  readonly stored: string | null;
}

/** NULL `currencyCode`, fully allocated: the case the resolved-currency defect hit. */
let resolved: Replay;
/** A surplus credit: the case the missing `credit_amount` defect hit. */
let surplus: Replay;
let base: string;

async function replayOnce(input: PaymentInput): Promise<Replay> {
  const first = await collectPayment(w.t, w.headers, input);
  const afterFirst = await footprint(input.paymentId);
  const stored = await storedIntent(input.paymentId);
  const second = await collectPayment(w.t, w.headers, input);
  const afterSecond = await footprint(input.paymentId);
  return { input, first, second, afterFirst, afterSecond, stored };
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  w = await settlementWorld('s4replay');
  missing = await settlementMissing(w);
  if (missing.length > 0) return;
  base = await baseCurrency();

  await stockUp(w, '100', '5');

  // ── 1. NULL currencyCode, fully allocated ──────────────────────────────
  const customerA = await newCustomer(w);
  const i1 = await sellOnCredit(w, customerA, '2');
  const legs = [wholeInvoiceLeg(i1)];
  resolved = await replayOnce({
    paymentId: randomUUID(),
    customerId: customerA,
    paymentMethodId: w.paymentMethodId,
    paymentDate: w.day,
    amountMinor: appliedTotal(legs).toString(),
    allocations: legs,
  });

  // ── 2. an overpayment, so the intent carries a credit_amount ────────────
  const customerB = await newCustomer(w);
  const i2 = await sellOnCredit(w, customerB, '3');
  surplus = await replayOnce({
    paymentId: randomUUID(),
    customerId: customerB,
    paymentMethodId: w.paymentMethodId,
    paymentDate: w.day,
    amountMinor: (BigInt(i2.totalTxnMinor) + 777n).toString(),
    creditId: randomUUID(),
    allocations: [wholeInvoiceLeg(i2)],
  });
}, 300_000);

describe(`§0 ${CLAIM}`, () => {
  it('the slice is present, so nothing below is vacuous', () => {
    expect(missing, 'the P4-S4 settlement surface is incomplete, so this suite would prove nothing').toEqual([]);
  });
});

describe('§A a replay of a payment whose currency the SERVER resolved', () => {
  it('the first delivery is accepted and is not a replay', () => {
    expect(resolved.first.status, JSON.stringify(resolved.first.body)).toBe(201);
    expect((resolved.first.body as { replayed: boolean }).replayed).toBe(false);
  });

  it('the second, byte-identical delivery REPLAYS — it is not an idempotency conflict', () => {
    // The defect's exact signature was a 409/422 refusal here.
    expect(refusalCode(resolved.second), 'the replay was refused as a different command').not.toBe('customer_payment.idempotency_conflict');
    expect(resolved.second.status, JSON.stringify(resolved.second.body)).toBe(200);
    expect((resolved.second.body as { replayed: boolean }).replayed).toBe(true);
  });

  it('and it wrote nothing: one payment, the same allocations, the same entries', () => {
    expect(resolved.afterFirst.payments).toBe(1);
    expect(resolved.afterFirst.allocations).toBe(1);
    expect(resolved.afterFirst.entries).toBeGreaterThan(0);
    expect(resolved.afterSecond).toEqual(resolved.afterFirst);
  });

  it('the digest the SERVICE computes is the one the ROUTINE stored, over the resolved currency', () => {
    expect(resolved.stored, 'the payment stored no intent digest').not.toBeNull();
    expect(serviceIntent(resolved.input, base)).toBe(resolved.stored);
  });

  it('RED on the old defect: the digest over the CLIENT’s nullable currency is NOT what was stored', () => {
    // The request named no currency, so the old code signed a NULL field here.
    // If this ever equalled the stored digest, §A's proof would be vacuous.
    expect(resolved.input.currencyCode, 'this case must state no currency').toBeUndefined();
    const overADifferentCurrency = serviceIntent(resolved.input, base === 'USD' ? 'EUR' : 'USD');
    expect(overADifferentCurrency).not.toBe(resolved.stored);
  });
});

describe('§B a replay of an overpayment, whose intent carries the surplus', () => {
  it('the first delivery is accepted and creates exactly one credit', () => {
    expect(surplus.first.status, JSON.stringify(surplus.first.body)).toBe(201);
    expect(surplus.afterFirst.credits).toBe(1);
  });

  it('the second, byte-identical delivery REPLAYS and mints no second credit', () => {
    expect(refusalCode(surplus.second)).not.toBe('customer_payment.idempotency_conflict');
    expect(surplus.second.status, JSON.stringify(surplus.second.body)).toBe(200);
    expect((surplus.second.body as { replayed: boolean }).replayed).toBe(true);
    expect(surplus.afterSecond).toEqual(surplus.afterFirst);
    expect(surplus.afterSecond.credits).toBe(1);
  });

  it('the service digest equals the stored one, so credit_amount is in both streams', () => {
    expect(surplus.stored).not.toBeNull();
    expect(serviceIntent(surplus.input, base)).toBe(surplus.stored);
  });

  it('RED on the old defect: a digest built over a DIFFERENT surplus is not the stored one', () => {
    // `credit_amount` is derived from `amount − Σ payment_amount`, so a larger
    // amount against the same allocation is a larger surplus and must change
    // the digest.
    const other: PaymentInput = { ...surplus.input, amountMinor: (BigInt(surplus.input.amountMinor) + 1n).toString() };
    expect(serviceIntent(other, base)).not.toBe(surplus.stored);
  });
});

describe('§C the other half: a DIFFERENT command on the same payment id still conflicts', () => {
  it('a changed amount under a stored payment id is refused, not replayed', async () => {
    // On the SURPLUS payment, where a larger amount is a lawful request — a
    // larger surplus — so it reaches the digest comparison instead of being
    // refused by the credit-id closure law first.
    const changed: PaymentInput = { ...surplus.input, amountMinor: (BigInt(surplus.input.amountMinor) + 100n).toString() };
    const res = await collectPayment(w.t, w.headers, changed);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(refusalCode(res)).toBe('customer_payment.idempotency_conflict');
    // And it wrote nothing either.
    expect(await footprint(surplus.input.paymentId)).toEqual(surplus.afterFirst);
  });

  it('a changed reference under a stored payment id is refused too', async () => {
    const changed: PaymentInput = { ...resolved.input, reference: 'a reference the first delivery did not carry' };
    const res = await collectPayment(w.t, w.headers, changed);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(refusalCode(res)).toBe('customer_payment.idempotency_conflict');
    expect(await footprint(resolved.input.paymentId)).toEqual(resolved.afterFirst);
  });

  it('a changed customer under a stored payment id is refused too', async () => {
    const otherCustomer = await newCustomer(w);
    const changed: PaymentInput = { ...resolved.input, customerId: otherCustomer };
    const res = await collectPayment(w.t, w.headers, changed);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(refusalCode(res)).toBe('customer_payment.idempotency_conflict');
  });
});

describe('§D the field stream, as a unit claim alongside the replay', () => {
  it('the intent digest changes with every field the routine signs into it', () => {
    // Built on the SURPLUS case, because a change of amount there stays lawful:
    // it moves the surplus, where on a fully-allocated payment it would break
    // the credit-id closure law before any digest is computed.
    const stream = (over: Partial<PaymentInput>, currency = base): string => serviceIntent({ ...surplus.input, ...over }, currency);
    const baseline = stream({});
    expect(baseline).toBe(surplus.stored);
    // One per intent field of `0081:1851-1865`. Each must move the digest, or
    // that field is not in the stream this side builds.
    expect(stream({ paymentId: randomUUID() }), 'payment_id').not.toBe(baseline);
    expect(stream({ customerId: randomUUID() }), 'customer_id').not.toBe(baseline);
    expect(stream({ paymentMethodId: randomUUID() }), 'payment_method_id').not.toBe(baseline);
    expect(stream({ amountMinor: (BigInt(surplus.input.amountMinor) + 1n).toString() }), 'amount and the derived credit_amount').not.toBe(baseline);
    expect(stream({ reference: 'a reference' }), 'reference words').not.toBe(baseline);
    expect(stream({ creditId: randomUUID() }), 'credit_id').not.toBe(baseline);
    expect(stream({}, base === 'USD' ? 'EUR' : 'USD'), 'currency').not.toBe(baseline);
    // And the same request digests identically every time: the intent reads no
    // clock and nothing it binds moves.
    expect(stream({})).toBe(baseline);
  });
});
