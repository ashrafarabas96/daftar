/**
 * P4-S4 — A CREDIT APPLICATION REPLAY THAT NAMES A DIFFERENT CUSTOMER IS NOT A
 * REPLAY.
 *
 * `POST /v1/customer-credits/:creditId/applications` carries SIX keys, and
 * `customerId` is one of them (`settlement-path.ts`'
 * `CreditApplicationRequestBody`). It is not a figure the server derives: it is
 * the caller's own statement of WHOSE invoice it means, and
 * `customer-credit-application.service.ts:210` refuses
 * `customer_credit_application.customer_mismatch` when it disagrees with the
 * invoice's customer. That refusal is the only thing standing between a client
 * that meant someone else and a silent settlement of the invoice it named.
 *
 * THE DEFECT THIS SUITE EXISTS FOR. The intent digest the routine computes
 * (`0081:2270-2273`) is SIX fields — application_id, credit_id, invoice_id,
 * application_date, consumed, applied — and `customerId` is deliberately not
 * among them, because it is not an argument of `customer_apply_credit` at all
 * (15 parameters, none of them a customer). The service's replay branch
 * therefore answered on a digest that cannot see `customerId`, and it sat
 * BEFORE the identity check: a second delivery under a stored `applicationId`
 * naming a DIFFERENT customer matched the stored digest, returned
 * `200 replayed: true`, and the three-identities check at :209-210 was never
 * reached. The caller was told its command had been carried out for the
 * customer it named, when the stored application belongs to another.
 *
 * The fix is the ORDER, not the digest: the stated identity is now checked
 * against the invoice before the replay branch answers, so a mismatch is
 * `customer_credit_application.customer_mismatch` whether or not an
 * application is already stored. Adding `customerId` to the digest is NOT the
 * remedy — `customer_credit_applications.intent_sha256` is computed and stored
 * by the ROUTINE and this file's TypeScript only reproduces it, so a seventh
 * field on this side would disagree with the migration on EVERY application
 * and turn every lawful replay into a false `idempotency_conflict` — the exact
 * fault `p4s4-intent-replay.test.ts` exists for on the payment side.
 *
 * §C keeps the suite honest: a byte-identical second delivery still replays,
 * so this cannot pass by refusing everything.
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { must } from '../golden-regression/phase4-s4/harness';
import { applyCredit, collectPayment, CREDIT_ROUTE_REFUSALS, refusalCode, type AllocationInput } from '../golden-regression/phase4-s4/settlement-path';
import {
  newCustomer,
  sellOnCredit,
  settlementMissing,
  settlementWorld,
  stockUp,
  type OpenInvoice,
  type SettlementWorld,
} from '../golden-regression/phase4-s4/settlement-world';

const CLAIM =
  'a second delivery of a credit application under a stored application id, naming a DIFFERENT customer, is refused customer_mismatch and never answered as a replay';

let w: SettlementWorld;
let missing: readonly string[] = [];

/** The credit's owner, and the invoice her credit lawfully applies to. */
let owner: string;
let ownerInvoice: OpenInvoice;
/** Somebody else entirely: the identity the second delivery states. */
let stranger: string;
let credit: { readonly creditId: string; readonly originalMinor: bigint; readonly originalCarryingMinor: bigint };

/** The three deliveries, all made in `beforeAll` so each `it` is a pure assertion. */
let first: Response | undefined;
let wrongCustomer: Response | undefined;
let identicalReplay: Response | undefined;

function leg(inv: OpenInvoice, appliedMinor: bigint, releasedBefore = 0n): AllocationInput {
  return {
    invoiceId: inv.invoiceId,
    appliedMinor: appliedMinor.toString(),
    releasedBeforeMinor: releasedBefore.toString(),
    invoiceTotalTxnMinor: inv.totalTxnMinor,
    invoiceTotalBaseMinor: inv.totalBaseMinor,
  };
}

/** How many applications this id owns, read after the fact. */
async function applications(applicationId: string): Promise<number> {
  const r = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM customer_credit_applications WHERE business_id = $1 AND id = $2`, [
    w.shop.businessId,
    applicationId,
  ]);
  return r.rows[0]?.n ?? 0;
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  w = await settlementWorld('s4creditreplay');
  missing = await settlementMissing(w);
  if (missing.length > 0) return;

  await stockUp(w, '100', '6');
  owner = await newCustomer(w);
  stranger = await newCustomer(w);
  const settled = await sellOnCredit(w, owner, '2');
  ownerInvoice = await sellOnCredit(w, owner, '1');

  // The credit: the owner overpays her first invoice, and the surplus is money
  // the business owes her.
  const creditId = randomUUID();
  const lawful = await collectPayment(w.t, w.headers, {
    paymentId: randomUUID(),
    customerId: owner,
    paymentMethodId: w.paymentMethodId,
    paymentDate: w.day,
    amountMinor: (BigInt(settled.totalTxnMinor) + 500n).toString(),
    creditId,
    allocations: [leg(settled, BigInt(settled.totalTxnMinor))],
  });
  expect(lawful.status, `the overpayment commits, or there is no credit to apply: ${JSON.stringify(lawful.body)}`).toBeLessThan(300);
  const cr = must(
    (
      await ownerPool().query<{ oa: string; ob: string }>(
        `SELECT original_amount_minor::text AS oa, original_carrying_base_amount_minor::text AS ob
           FROM customer_credits WHERE business_id = $1 AND id = $2`,
        [w.shop.businessId, creditId],
      )
    ).rows[0],
    `the credit ${creditId}`,
  );
  credit = { creditId, originalMinor: BigInt(cr.oa), originalCarryingMinor: BigInt(cr.ob) };

  const applicationId = randomUUID();
  const body = {
    applicationId,
    creditId,
    invoiceId: ownerInvoice.invoiceId,
    applicationDate: w.day,
    consumedMinor: '100',
    remainingBeforeMinor: credit.originalMinor.toString(),
    creditOriginalMinor: credit.originalMinor.toString(),
    creditOriginalCarryingMinor: credit.originalCarryingMinor.toString(),
    leg: leg(ownerInvoice, 100n),
  } as const;

  // 1. the lawful application, by its owner.
  first = await applyCredit(w.t, w.headers, { ...body, customerId: owner });
  // 2. the SAME application id, every digested field identical, naming the
  //    stranger. Nothing about this request is the command that was stored.
  wrongCustomer = await applyCredit(w.t, w.headers, { ...body, customerId: stranger });
  // 3. the byte-identical second delivery, which must still replay.
  identicalReplay = await applyCredit(w.t, w.headers, { ...body, customerId: owner });
}, 420_000);

afterAll(async () => {
  await w?.t?.close();
  await resetData();
});

describe(`§0 ${CLAIM}`, () => {
  it('the slice is present, so nothing below is vacuous', () => {
    expect(missing, 'the P4-S4 settlement surface is incomplete, so this suite would prove nothing').toEqual([]);
  });

  it('the two customers are distinct, or the subject of §B does not exist', () => {
    expect(owner).not.toBe(stranger);
    expect(ownerInvoice.customerId).toBe(owner);
  });
});

describe('§A the lawful application', () => {
  it('is accepted and is not a replay', () => {
    const res = must(first, 'the first delivery');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((res.body as { replayed: boolean }).replayed).toBe(false);
  });
});

describe('§B the same application id, a DIFFERENT customer', () => {
  it('is REFUSED customer_mismatch — it is not answered 200 replayed:true', () => {
    const res = must(wrongCustomer, 'the wrong-customer delivery');
    // The defect's exact signature: 200 with replayed true.
    expect(
      (res.body as { replayed?: boolean }).replayed,
      `the route told a caller naming customer ${stranger} that its command had been carried out, when the stored application ` +
        `belongs to ${owner}. Measured: ${res.status} ${JSON.stringify(res.body)}`,
    ).not.toBe(true);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(refusalCode(res, CREDIT_ROUTE_REFUSALS.customerMismatch), JSON.stringify(res.body)).toBe(CREDIT_ROUTE_REFUSALS.customerMismatch);
  });

  it('and it wrote nothing: the one stored application is still the only one', async () => {
    const res = must(first, 'the first delivery');
    expect(await applications((res.body as { applicationId: string }).applicationId)).toBe(1);
  });
});

describe('§C the other half: a byte-identical second delivery still REPLAYS', () => {
  it('answers 200 replayed:true, so §B is not passing by refusing everything', () => {
    const res = must(identicalReplay, 'the identical second delivery');
    expect(refusalCode(res, 'customer_credit_application.idempotency_conflict'), 'a lawful replay was refused as a different command').toBeNull();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body as { replayed: boolean }).replayed).toBe(true);
  });
});
