/**
 * P4-S4 — THE CLIENT STATES NO DERIVED FIGURE, AND THAT IS A REFUSAL AND NOT
 * A CONVENTION.
 * (`docs/PHASE_4_ARCHITECTURE_LOCK.md` P4-AL-18, P4-AL-30; the accepted
 *  `POST /v1/supplier-payments` allocation object,
 *  `apps/api/src/modules/purchasing/purchasing.schemas.ts:356-363`.)
 *
 * ── THE LAW ───────────────────────────────────────────────────────────────
 *
 * «The caller computes and the database re-verifies» is a law of the
 * SERVICE -> ROUTINE boundary. It is not a law of the CLIENT -> API one. At
 * the HTTP boundary the opposite holds: a request names the SUBJECTS of the
 * command — which invoice, how much money, which credit — and states none of
 * the figures the server derives from the stored documents. The accepted
 * supplier allocation object is exactly four fields for that reason, and
 * P4-AL-18 refuses a server-derived figure BY NAME rather than validating one
 * that arrived.
 *
 * There is a correctness reason underneath the precedent, and it is why this
 * file exists rather than a comment: the IDEMPOTENCY INTENT DIGEST is computed
 * over the request (P4-AL-30). A derived figure inside the request puts the FX
 * RATE inside the digest, so the same collection retried after a rate movement
 * hashes differently and comes back as a false `idempotency_conflict` instead
 * of the recomputation it should be. A body that merely IGNORED the extra key
 * would still have hashed it. So the schema must be `.strict()`, and this file
 * is the red-provable claim that it is.
 *
 * ── WHY EACH CASE HAS A CONTROL ───────────────────────────────────────────
 *
 * A refusal test with no control is the weakest test in a suite: a 400 proves
 * the body was refused, not that it was refused FOR THE EXTRA KEY. Every case
 * below therefore sends the SAME body twice — once lawful and once with
 * `releasedBeforeMinor` put back on it — and requires the lawful one to COMMIT
 * and the other to be refused. If the refusal came from anything else in the
 * body, the control is refused too and the case goes red.
 *
 * `releasedBeforeMinor` is the probe on purpose: it is the most tempting
 * derived figure of the slice, the one every suite computes and the one that
 * reads most like a token the caller holds. A boundary proved on an obviously
 * absurd key is not proved.
 *
 * ── RED UNTIL `0081` LANDS ────────────────────────────────────────────────
 *
 * Every `it` requires its subject first. No `.skip`, no `.todo`, no
 * conditional that turns an absent route into a pass.
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { requireSubject } from '../golden-regression/phase4-s2/harness';
import { must } from '../golden-regression/phase4-s4/harness';
import {
  applyCredit,
  applyCreditPath,
  collectPayment,
  COLLECT_PAYMENT_PATH,
  creditBodyWithDerivedFigure,
  CREDIT_APPLICATION_BODY_SHAPE,
  DERIVED_FIGURE_PROBE_KEY,
  PAYMENT_BODY_SHAPE,
  paymentBodyWithDerivedFigure,
  type AllocationInput,
  type CreditApplicationInput,
  type PaymentInput,
} from '../golden-regression/phase4-s4/settlement-path';
import {
  newCustomer,
  sellOnCredit,
  settlementMissing,
  settlementWorld,
  stockUp,
  type OpenInvoice,
  type SettlementWorld,
} from '../golden-regression/phase4-s4/settlement-world';

const CLAIM = 'the HTTP request of a collection and of a credit application carries no server-derived figure, and a body that states one is refused';

let w: SettlementWorld;
let missing: readonly string[] = [];

/** The payment route: the lawful body, and the same body with one derived figure. */
let paymentLawful: Response | undefined;
let paymentWithFigure: Response | undefined;
/** The credit route: the same pair. */
let creditLawful: Response | undefined;
let creditWithFigure: Response | undefined;

function leg(inv: OpenInvoice, appliedMinor: bigint, releasedBefore = 0n): AllocationInput {
  return {
    invoiceId: inv.invoiceId,
    appliedMinor: appliedMinor.toString(),
    releasedBeforeMinor: releasedBefore.toString(),
    invoiceTotalTxnMinor: inv.totalTxnMinor,
    invoiceTotalBaseMinor: inv.totalBaseMinor,
  };
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  w = await settlementWorld('s4boundary');
  missing = await settlementMissing(w);
  if (missing.length > 0) return;

  await stockUp(w, '100', '6');
  const customer = await newCustomer(w);

  // ── the payment route: the control first, so a refusal of the probe
  //    cannot be a refusal of the scenario ────────────────────────────────
  const i1 = await sellOnCredit(w, customer, '2');
  const lawful: PaymentInput = {
    paymentId: randomUUID(),
    customerId: customer,
    paymentMethodId: w.paymentMethodId,
    paymentDate: w.day,
    amountMinor: i1.totalTxnMinor,
    allocations: [leg(i1, BigInt(i1.totalTxnMinor))],
  };
  paymentLawful = await collectPayment(w.t, w.headers, lawful);

  // The SAME input, a fresh document id, one derived figure put back. Nothing
  // else differs — not the method, not the customer, not the shape of the leg.
  const i2 = await sellOnCredit(w, customer, '2');
  const probed: PaymentInput = {
    ...lawful,
    paymentId: randomUUID(),
    amountMinor: i2.totalTxnMinor,
    allocations: [leg(i2, BigInt(i2.totalTxnMinor))],
  };
  paymentWithFigure = await w.t.request.post(COLLECT_PAYMENT_PATH).set(w.headers).send(paymentBodyWithDerivedFigure(probed, '0'));

  // ── the credit route: a credit born from a surplus, one lawful
  //    application and one probed one ──────────────────────────────────────
  const i3 = await sellOnCredit(w, customer, '1');
  const i4 = await sellOnCredit(w, customer, '1');
  const i5 = await sellOnCredit(w, customer, '1');
  const surplus = BigInt(i3.totalTxnMinor) + BigInt(i4.totalTxnMinor);
  const creditId = randomUUID();
  const born = await collectPayment(w.t, w.headers, {
    paymentId: randomUUID(),
    customerId: customer,
    paymentMethodId: w.paymentMethodId,
    paymentDate: w.day,
    amountMinor: (BigInt(i5.totalTxnMinor) + surplus).toString(),
    creditId,
    allocations: [leg(i5, BigInt(i5.totalTxnMinor))],
  });
  expect(born.status, `the credit-bearing overpayment commits, or neither credit case has a subject: ${JSON.stringify(born.body)}`).toBeLessThan(300);
  const cr = must(
    (
      await ownerPool().query<{ oa: string; ob: string; rem: string }>(
        `SELECT original_amount_minor::text AS oa, original_carrying_base_amount_minor::text AS ob, remaining_amount_minor::text AS rem
           FROM customer_credits WHERE business_id = $1 AND id = $2`,
        [w.shop.businessId, creditId],
      )
    ).rows[0],
    `the credit ${creditId}`,
  );
  // Each application NAMES its invoice (`CREDIT_APPLICATION_BODY_SHAPE`), so
  // the control and the probe settle two different invoices and neither can
  // be refused for colliding with the other.
  const base: CreditApplicationInput = {
    applicationId: randomUUID(),
    creditId,
    customerId: customer,
    invoiceId: i3.invoiceId,
    applicationDate: w.day,
    consumedMinor: i3.totalTxnMinor,
    remainingBeforeMinor: cr.rem,
    creditOriginalMinor: cr.oa,
    creditOriginalCarryingMinor: cr.ob,
    leg: leg(i3, BigInt(i3.totalTxnMinor)),
  };
  creditLawful = await applyCredit(w.t, w.headers, base);
  const probedCredit: CreditApplicationInput = {
    ...base,
    applicationId: randomUUID(),
    invoiceId: i4.invoiceId,
    consumedMinor: i4.totalTxnMinor,
    remainingBeforeMinor: (BigInt(cr.rem) - BigInt(i3.totalTxnMinor)).toString(),
    leg: leg(i4, BigInt(i4.totalTxnMinor)),
  };
  creditWithFigure = await w.t.request.post(applyCreditPath(creditId)).set(w.headers).send(creditBodyWithDerivedFigure(probedCredit, '0'));
}, 420_000);

afterAll(async () => {
  await w?.t?.close();
  await resetData();
});

describe('P4-S4 the collection route states no derived figure', () => {
  it('the subject exists: the relations, the commands, the source types, the seam and both routes', () => {
    requireSubject(missing, CLAIM);
  });

  it('THE CONTROL — the lawful four-field body COMMITS, so a refusal below is about the extra key and nothing else', () => {
    requireSubject(missing, CLAIM);
    const res = must(paymentLawful, 'the lawful collection');
    expect(
      res.status,
      `${PAYMENT_BODY_SHAPE} must be accepted as it stands. If this is red, every refusal in this file is unattributable and the ` +
        `boundary is not proved. Measured: ${res.status} ${JSON.stringify(res.body)}`,
    ).toBeLessThan(300);
  });

  it(`a body carrying ${DERIVED_FIGURE_PROBE_KEY} on an allocation is REFUSED`, () => {
    requireSubject(missing, CLAIM);
    const res = must(paymentWithFigure, 'the probed collection');
    expect(
      res.status,
      `the same body as the control, with ${DERIVED_FIGURE_PROBE_KEY} put back on the first leg, must be refused: the chain position is ` +
        `derived by the server from the stored chain, and a client that states it puts the figure in the intent digest (P4-AL-30). ` +
        `Measured: ${res.status} ${JSON.stringify(res.body)}`,
    ).toBe(400);
  });

  it('and it wrote nothing: the refused collection left no payment row of this business', async () => {
    requireSubject(missing, CLAIM);
    const r = await ownerPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM payments WHERE business_id = $1`, [w.shop.businessId]);
    expect(
      must(r.rows[0], 'the payment count of this business').n,
      `exactly two payments of THIS business committed — the control and the credit-bearing overpayment — and the probed body wrote none. ` +
        `A schema refusal that still reached the service would show up here as a third.`,
    ).toBe('2');
  });
});

describe('P4-S4 the credit-application route states no derived figure', () => {
  it('the subject exists', () => {
    requireSubject(missing, CLAIM);
  });

  it('THE CONTROL — the lawful four-field credit body COMMITS', () => {
    requireSubject(missing, CLAIM);
    const res = must(creditLawful, 'the lawful credit application');
    expect(
      res.status,
      `${CREDIT_APPLICATION_BODY_SHAPE} must be accepted as it stands, or the refusal below is unattributable. ` +
        `Measured: ${res.status} ${JSON.stringify(res.body)}`,
    ).toBeLessThan(300);
  });

  it(`a credit-application body carrying ${DERIVED_FIGURE_PROBE_KEY} is REFUSED`, () => {
    requireSubject(missing, CLAIM);
    const res = must(creditWithFigure, 'the probed credit application');
    expect(
      res.status,
      `the credit route is held to the same boundary as the payment route — a law enforced on one of the two settling commands and not ` +
        `the other is half a law. Measured: ${res.status} ${JSON.stringify(res.body)}`,
    ).toBe(400);
  });

  it('and it wrote nothing: exactly one credit application of this business exists', async () => {
    requireSubject(missing, CLAIM);
    const r = await ownerPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM customer_credit_applications WHERE business_id = $1`, [
      w.shop.businessId,
    ]);
    expect(
      must(r.rows[0], 'the credit-application count of this business').n,
      'the control committed and the probed body did not, so THIS business carries exactly one credit application',
    ).toBe('1');
  });
});

describe('P4-S4 the declared shapes carry no derived figure either', () => {
  /**
   * The two shape constants are what every other P4-S4 suite builds its bodies
   * from, so a derived figure reintroduced there would travel into all of them
   * at once. This case is cheap, needs no database, and is the one test in the
   * slice that would catch that edit.
   */
  const DERIVED = [
    'releasedBeforeMinor',
    'carryingReleasedMinor',
    'arDustBaseMinor',
    'realizedFxMinor',
    'creditCarryingReleasedMinor',
    'creditDustBaseMinor',
  ] as const;

  it('neither declared body shape names a figure the server derives', () => {
    const offenders = DERIVED.filter((k) => PAYMENT_BODY_SHAPE.includes(k) || CREDIT_APPLICATION_BODY_SHAPE.includes(k));
    expect(
      offenders,
      `a derived figure is named in a declared request shape, so every suite of this slice is sending it. ` +
        `payment: ${PAYMENT_BODY_SHAPE}; credit: ${CREDIT_APPLICATION_BODY_SHAPE}`,
    ).toEqual([]);
  });

  it('THE RED PROOF — the same check names an offender when one is present, so the test above is not vacuous', () => {
    const planted = `${PAYMENT_BODY_SHAPE.slice(0, -2)}, releasedBeforeMinor }`;
    expect(
      DERIVED.filter((k) => planted.includes(k)),
      'the filter must actually find a derived figure in a shape that states one, or the case above passes on any shape at all',
    ).toEqual(['releasedBeforeMinor']);
  });
});
