/**
 * P4-S4 — THE CUSTOMER IDENTITY PIN AND THE WALK-IN LAW, NOW STRUCTURAL.
 * (P4-S4 BUILD CONTRACT **Departure A** and OQ-7, CLOSED by the Tech Lead's
 *  §23 ruling and by `0082_phase4_customer_settlement_structural_pin.sql`;
 *  implementation map §8.2, §8.5;
 *  `0075_phase4_customers_invoices_numbering.sql:248`, `:313-316`, `:661-684`;
 *  `0067:274` as the precedent Departure A deferred to.)
 *
 * ── WHY THIS FILE EXISTS AT ALL ───────────────────────────────────────────
 *
 * The implementation map proposed `ALTER TABLE invoices ADD UNIQUE
 * (business_id, id, customer_id)` so that the settlement relations could point
 * a THREE-column foreign key at it. With that key both laws below are
 * STRUCTURAL:
 *
 *   — an allocation naming customer C against an invoice of customer D has no
 *     FK target at all;
 *   — and a walk-in invoice, whose `customer_id` IS NULL (`0075:248`,
 *     `:313-316`), has no `(business, id, customer)` tuple with a non-null
 *     customer for a `NOT NULL` child column to match.
 *
 * The P4-S4 contract DEFERRED that key ("Departure A"): `invoices` is a table
 * an earlier slice of this phase created and applied, and widening its key was
 * an ownership question the Tech Lead had not answered. For the length of that
 * deferral the foreign key was the narrow
 * `(business_id, invoice_id) → invoices (business_id, id)`, and both laws
 * rested on `invoice_settlement_verify`, a DEFERRABLE INITIALLY DEFERRED
 * constraint trigger, with the refusals
 * `invoice_settlement.customer_mismatch` and
 * `invoice_settlement.walkin_not_settleable`.
 *
 * THE DEFERRAL IS OVER. `0082` adds the non-partial key and a THREE-COLUMN
 * edge from each reducer onto it — ADDED BESIDE `0081`'s two-column edge, not
 * in place of it, because a Phase 4 migration never drops a composite seam
 * (P2-S8's accepted rule). Each reducer therefore carries TWO invoice edges:
 * the narrow one, now redundant, and the pin. So this file asserts the
 * STRUCTURAL form by PRESENCE — the pin is there, on each reducer, and the
 * refusal a planted row meets names it — and never by "the reducer has exactly
 * one invoice edge", which is no longer true and was never the law. And the
 * planted proofs below are refused by the EDGE rather than by the verifier.
 * The obstacle recorded against the key — "PostgreSQL needs a non-partial
 * unique index as an FK target, and walk-in invoices carry a NULL
 * `customer_id`" — did not bind: a unique constraint is not a `NOT NULL`
 * constraint, the key contains the primary key so it validates on any data,
 * and the NULL is what MAKES the walk-in law structural rather than what
 * blocks it. A reducer's `customer_id` is `NOT NULL`, so under MATCH SIMPLE
 * the edge fires on every row, and a non-null triple can never match a
 * NULL-customer parent tuple.
 *
 * The two verifier arms are KEPT and are now unreachable through the
 * relations, because the row that would raise them cannot be inserted at all.
 * This file asserts they are still in the routine, because a corrective that
 * deleted a subsumed check would trade defence in depth for tidiness.
 *
 * Cross-business linkage was never the half that was given up — ONE
 * `business_id` column feeds every FK on the row and there is nowhere to put a
 * second — and its law is unchanged below.
 *
 * ONE LAW, TWO VOCABULARIES. Each law is answered twice and this file asserts
 * both, because they are two different claims:
 *
 *   — at the ROUTE, the API pre-checks the invoice and refuses in the
 *     DOCUMENT's domain — `customer_payment.invoice_walkin` and
 *     `customer_payment.customer_mismatch` on the payment path,
 *     `customer_credit_application.*` on the credit path. That is what a
 *     merchant sees, and it is raised before the command reaches the database;
 *   — at the RELATION, the database answers in the INVARIANT's domain. That is
 *     what a future caller — an import, a correction, another slice's command —
 *     will see, and it is what the planted rows below exercise.
 *
 * A route case that expected the database's code would assert a code no caller
 * of that route can see; a planted-row proof that expected the service's would
 * assert a code the database cannot raise. The codes differing is the
 * architecture.
 *
 * So each law needs a PERMANENT TEST and a PLANTED RED PROOF, which is what
 * this file is. Neither may be left to the application layer, and this file
 * proves that by planting each violation with DIRECT SQL that never touches the
 * command.
 *
 * ── WHAT THE PLANTED PROOFS NOW MEASURE, AND WHY IT CHANGED ───────────────
 *
 * Before `0082` the planted row INSERTED successfully — the narrow
 * `(business_id, invoice_id)` edge was satisfied by a mismatched row, which was
 * the whole point of Departure A — and the proof then called
 * `invoice_settlement_verify` by hand to show the deferred verifier would
 * refuse it at COMMIT. Calling it by hand was necessary because a planted row
 * carries no accounting source binding, so reaching COMMIT would fire every
 * deferred check in an order PostgreSQL does not promise and the proof could
 * die on the missing binding instead of on the law.
 *
 * After `0082` the INSERT ITSELF IS REFUSED, immediately, by
 * `<relation>_invoice_fk` — there is no row to verify and no deferral to reach.
 * That is a STRICTLY STRONGER measurement and the proofs below assert it in
 * that form: the plant raises `foreign_key_violation` (SQLSTATE 23503) naming
 * the reducer's invoice edge. The verifier is no longer the thing holding
 * these two laws up, so a proof that still went through it would be measuring
 * a backstop and reporting it as the invariant.
 *
 * Every planted transaction is rolled back in a `finally`. A planted violation
 * that committed because the law did not refuse it would poison every later
 * law of the suite, and the suite would report a cascade instead of the one
 * finding.
 *
 * ── RED UNTIL `0081` AND `0082` LAND ──────────────────────────────────────
 *
 * Every `it` requires its subject first. No `.skip`, no `.todo`, no
 * conditional pass.
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { ownerClient } from '../helpers/stock-ledger';
import { requireSubject } from '../golden-regression/phase4-s2/harness';
import { deferredVerifierWiring, inRolledBackTx, invoiceChain, must, plantSettlementRow, raised } from '../golden-regression/phase4-s4/harness';
import {
  applyCredit,
  collectPayment,
  CREDIT_APPLICATION_BODY_SHAPE,
  CREDIT_ROUTE_REFUSALS,
  PAYMENT_ROUTE_REFUSALS,
  refusalCode,
  VERIFIER_REFUSALS,
  ROUTINES,
  type AllocationInput,
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

/**
 * Why a ROUTE case expects a document-domain code and a PLANTED-ROW case
 * expects the database's. Stated once and quoted in each message, so a reader
 * of a failure sees the reason and not just the mismatch.
 */
const WHY_ROUTE_DOMAIN =
  "The API answers in the DOCUMENT's domain because `settledInvoice` pre-checks the invoice and refuses before the command reaches " +
  "the database, so the code a merchant sees is the payment's or the application's and NOT a SQLSTATE — the database's refusal is " +
  'asserted by the planted-row proof. The two codes differing is the architecture, not an inconsistency.';

/**
 * `foreign_key_violation`. The SQLSTATE the structural pin refuses with, named
 * rather than matched on a message: PostgreSQL's wording for a constraint
 * violation is not a stable interface, while the class is.
 */
const FK_VIOLATION = '23503';

/**
 * The refusal `invoices_lifecycle_guard()` (`0075:546-556`) raises when any
 * identity column of an invoice is changed, `customer_id` among them. It is a
 * BEFORE trigger, so on the parent side it answers before the three-column edge
 * does — which is why the parent-side law below asserts THIS and not a
 * SQLSTATE.
 */
const INVOICE_IDENTITY_FINAL = 'invoice.state_invalid: the identity of an invoice is final';

/**
 * The catalogue names the structural pin consists of, so a failure message
 * tells the reader which constraint was supposed to answer.
 */
const STRUCTURAL = {
  key: 'invoices_customer_uq',
  /** The three-column edges `0082` ADDS. */
  allocationEdge: 'payment_allocations_invoice_customer_fk',
  applicationEdge: 'customer_credit_applications_invoice_customer_fk',
  /** `0081`'s two-column edges, which `0082` leaves exactly where they are. */
  narrowAllocationEdge: 'payment_allocations_invoice_fk',
  narrowApplicationEdge: 'customer_credit_applications_invoice_fk',
} as const;

const CLAIM = 'an allocation whose customer is not the invoice’s customer is refused, and a walk-in invoice carries no allocation and no credit application';

let w: SettlementWorld;
let missing: readonly string[] = [];

/** Customer C and her own, lawfully settled invoice — the clone source. */
let customerC: string;
let invoiceC: OpenInvoice;
/** Customer D and her invoice: the one C's money must not reach. */
let customerD: string;
let invoiceD: OpenInvoice;
/** The walk-in invoice: `customer_id IS NULL`. */
let walkin: OpenInvoice;
/** A credit of customer C, so the walk-in law can be asserted of the credit path too. */
let creditC: { readonly creditId: string; readonly originalMinor: bigint; readonly originalCarryingMinor: bigint } | undefined;

/** A SECOND open invoice of customer C, so a LAWFUL credit application exists to clone. */
let invoiceC2: OpenInvoice;

let mismatchByCommand: Response | undefined;
let walkinByCommand: Response | undefined;
let walkinCreditByCommand: Response | undefined;
let lawfulCreditApplication: Response | undefined;

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
  w = await settlementWorld('s4pin');
  missing = await settlementMissing(w);
  if (missing.length > 0) return;

  await stockUp(w, '100', '6');
  customerC = await newCustomer(w);
  customerD = await newCustomer(w);
  invoiceC = await sellOnCredit(w, customerC, '2');
  invoiceD = await sellOnCredit(w, customerD, '2');
  walkin = await sellOnCredit(w, null, '1');
  invoiceC2 = await sellOnCredit(w, customerC, '1');
  expect(walkin.customerId, 'the walk-in invoice really carries a NULL customer, or neither walk-in law has a subject (0075:247)').toBeNull();

  // ── the permanent test of the pin: C's money at D's invoice ──────────
  const surplus = 500n;
  const creditId = randomUUID();
  mismatchByCommand = await collectPayment(w.t, w.headers, {
    paymentId: randomUUID(),
    customerId: customerC,
    paymentMethodId: w.paymentMethodId,
    paymentDate: w.day,
    amountMinor: invoiceD.totalTxnMinor,
    allocations: [leg(invoiceD, BigInt(invoiceD.totalTxnMinor))],
  });

  // ── the permanent test of the walk-in law, payment side ──────────────
  walkinByCommand = await collectPayment(w.t, w.headers, {
    paymentId: randomUUID(),
    customerId: customerC,
    paymentMethodId: w.paymentMethodId,
    paymentDate: w.day,
    amountMinor: walkin.totalTxnMinor,
    allocations: [leg(walkin, BigInt(walkin.totalTxnMinor))],
  });

  // ── C settles her own invoice lawfully, with a surplus, so there is a
  //    lawful allocation to CLONE and a lawful credit to apply ──────────
  const lawful = await collectPayment(w.t, w.headers, {
    paymentId: randomUUID(),
    customerId: customerC,
    paymentMethodId: w.paymentMethodId,
    paymentDate: w.day,
    amountMinor: (BigInt(invoiceC.totalTxnMinor) + surplus).toString(),
    creditId,
    allocations: [leg(invoiceC, BigInt(invoiceC.totalTxnMinor))],
  });
  expect(lawful.status, `C's own settlement commits, or there is no accepted row to clone: ${JSON.stringify(lawful.body)}`).toBeLessThan(300);
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
  creditC = { creditId, originalMinor: BigInt(cr.oa), originalCarryingMinor: BigInt(cr.ob) };

  // ── the permanent test of the walk-in law, CREDIT side: the route is
  //    asked to apply C's credit to the walk-in invoice, which the body
  //    NAMES, so the refusal is caused by the law and not by the shape of
  //    the request ────────────────────────────────────────────────
  walkinCreditByCommand = await applyCredit(w.t, w.headers, {
    applicationId: randomUUID(),
    creditId,
    customerId: customerC,
    invoiceId: walkin.invoiceId,
    applicationDate: w.day,
    consumedMinor: '1',
    remainingBeforeMinor: creditC.originalMinor.toString(),
    creditOriginalMinor: creditC.originalMinor.toString(),
    creditOriginalCarryingMinor: creditC.originalCarryingMinor.toString(),
    leg: leg(walkin, 1n),
  });

  // ── and a LAWFUL credit application against C's OWN second invoice, so
  //    the planted proof below has a `customer_credit_applications` row to
  //    clone. The route case above and the planted proof are not substitutes
  //    for one another: Departure A puts the walk-in law inside
  //    `invoice_settlement_verify`, so proving the ROUTE refuses it and
  //    proving the RELATION cannot hold such a row are two different claims,
  //    and the second is the one a future caller of the routine relies on.
  lawfulCreditApplication = await applyCredit(w.t, w.headers, {
    applicationId: randomUUID(),
    creditId,
    customerId: customerC,
    invoiceId: invoiceC2.invoiceId,
    applicationDate: w.day,
    consumedMinor: '1',
    remainingBeforeMinor: creditC.originalMinor.toString(),
    creditOriginalMinor: creditC.originalMinor.toString(),
    creditOriginalCarryingMinor: creditC.originalCarryingMinor.toString(),
    leg: leg(invoiceC2, 1n),
  });
}, 420_000);

afterAll(async () => {
  await w?.t?.close();
  await resetData();
});

/** The one lawful `payment_allocations` row of customer C's invoice: the clone source. */
async function cloneSource(): Promise<string> {
  const chain = await invoiceChain(ownerPool(), w.shop.businessId, invoiceC.invoiceId);
  return must(
    chain.find((s) => s.relation === 'payment_allocations'),
    `a lawful payment allocation of invoice ${invoiceC.invoiceId} to clone — without one no violation can be planted and no law exercised`,
  ).id;
}

describe('P4-S4 the customer identity pin', () => {
  it('the subject exists: the settlement relations, the verifier, the commands and the routes', () => {
    requireSubject(missing, CLAIM);
  });

  it('an allocation whose customer is not the invoice’s customer is REFUSED by the command', () => {
    requireSubject(missing, CLAIM);
    const res = must(mismatchByCommand, 'the mismatch attempt');
    expect(
      res.status,
      `customer C's payment may not settle customer D's invoice. Since 0082 gave the reducer a three-column edge onto invoices_customer_uq this has ` +
        `no FK target at all, and the API answer, the command and invoice_settlement_verify each refuse it as well, so a refusal here is ` +
        `owed by four independent mechanisms. Measured: ${res.status} ${JSON.stringify(res.body)}`,
    ).toBeGreaterThanOrEqual(400);
    expect(res.status, 'and it is a business refusal naming a reason, not a 500').toBeLessThan(500);
    expect(
      refusalCode(res, PAYMENT_ROUTE_REFUSALS.customerMismatch),
      `the refusal names ${PAYMENT_ROUTE_REFUSALS.customerMismatch} in a machine-readable code, so the merchant sentence is RENDERED from ` +
        `a code rather than composed by the server (P4-AL-16). ${WHY_ROUTE_DOMAIN} Measured: ${JSON.stringify(res.body)}`,
    ).not.toBeNull();
  });

  it('and it wrote nothing: D’s invoice carries no settlement row of C’s money', async () => {
    requireSubject(missing, CLAIM);
    const chain = await invoiceChain(ownerPool(), w.shop.businessId, invoiceD.invoiceId);
    expect(chain, `invoice ${invoiceD.invoiceId} of customer D has an empty chain: ${JSON.stringify(chain)}`).toEqual([]);
    const r = await ownerPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM payment_allocations a
        WHERE a.business_id = $1 AND a.invoice_id = $2 AND a.customer_id <> $3`,
      [w.shop.businessId, invoiceD.invoiceId, customerD],
    );
    expect(must(r.rows[0]).n, 'no allocation of THIS business names D’s invoice under another customer').toBe(0);
  });

  it('THE PLANTED RED PROOF — a mismatched allocation inserted by DIRECT SQL is UNREPRESENTABLE: the INSERT itself is refused', async () => {
    requireSubject(missing, CLAIM);
    const sourceId = await cloneSource();
    const outcome = await inRolledBackTx(
      () => ownerClient(),
      w.shop,
      async (c) => {
        const newId = randomUUID();
        // ONE departure from an accepted row: the invoice it names is D's, while
        // the row's own `customer_id` stays C's. `0081`'s narrow FK
        // `(business_id, invoice_id)` is satisfied by exactly this row — it
        // still is, which is why the refusal below must name the THREE-column
        // edge and not that one — and before `0082` only
        // the deferred verifier stood between it and a committed cross-customer
        // settlement. The three-column edge 0082 adds beside it has no tuple
        // for this row, so the write dies
        // here and there is nothing left to verify.
        return raised(() =>
          plantSettlementRow(c, 'payment_allocations', w.shop.businessId, sourceId, {
            id: newId,
            binding_source_id: newId,
            invoice_id: invoiceD.invoiceId,
            ar_released_before_txn_minor: 0,
          }),
        );
      },
    );
    expect(
      outcome,
      `the planted allocation names invoice ${invoiceD.invoiceId} (customer D) while carrying customer C, and the database ACCEPTED THE ROW. ` +
        `The §23 ruling asked for a structural pin: with ${STRUCTURAL.key} on invoices and the three-column ${STRUCTURAL.allocationEdge}, this ` +
        `tuple has no foreign-key target at all. A row that inserts means the pin is not there, and a cross-customer settlement is one missed ` +
        `verifier call away from being committed by anything that writes the relation.`,
    ).not.toBeNull();
    const refusal = must(outcome, 'the refusal');
    expect(
      refusal.code,
      `and the refusal is STRUCTURAL — SQLSTATE 23503 (foreign_key_violation), raised by the edge on the INSERT, not ` +
        `${VERIFIER_REFUSALS.customerMismatch} raised by a deferred trigger the writer could have been the only one to skip. Measured: ` +
        `[${refusal.code ?? 'no code'}] ${refusal.message}`,
    ).toBe(FK_VIOLATION);
    expect(
      refusal.message,
      `and it names the reducer's own invoice edge ${STRUCTURAL.allocationEdge}, so the finding points at the constraint that refused it. ` +
        `Measured: ${refusal.message}`,
    ).toContain(STRUCTURAL.allocationEdge);
  });
});

describe('P4-S4 the walk-in law', () => {
  it('the subject exists, and the walk-in invoice really has a null customer', () => {
    requireSubject(missing, CLAIM);
    expect(walkin.customerId, 'the subject of both walk-in laws is an invoice whose customer_id IS NULL').toBeNull();
  });

  it('a payment allocation against a WALK-IN invoice is REFUSED by the command', () => {
    requireSubject(missing, CLAIM);
    const res = must(walkinByCommand, 'the walk-in allocation attempt');
    expect(
      res.status,
      `a walk-in invoice names no customer, so there is no customer whose receivable an allocation against it could release. Measured: ` +
        `${res.status} ${JSON.stringify(res.body)}`,
    ).toBeGreaterThanOrEqual(400);
    expect(res.status, 'and it is a business refusal, not a crash').toBeLessThan(500);
    expect(
      refusalCode(res, PAYMENT_ROUTE_REFUSALS.invoiceWalkin),
      `the refusal names ${PAYMENT_ROUTE_REFUSALS.invoiceWalkin}. ${WHY_ROUTE_DOMAIN} Measured: ${JSON.stringify(res.body)}`,
    ).not.toBeNull();
  });

  it('a CREDIT APPLICATION against a walk-in invoice is REFUSED by the command too — the law is about the invoice, not about the settler', () => {
    requireSubject(missing, CLAIM);
    const res = must(walkinCreditByCommand, 'the walk-in credit application attempt');
    expect(
      res.status,
      `the contract's Departure A says a walk-in invoice may carry NO allocation and NO credit application AT ALL. A law enforced on one of ` +
        `the two settling relations and not the other is half a law. The body NAMES the walk-in invoice ` +
        `(${CREDIT_APPLICATION_BODY_SHAPE}), so this refusal is caused by the law and not by the shape of the request. Measured: ` +
        `${res.status} ${JSON.stringify(res.body)}`,
    ).toBeGreaterThanOrEqual(400);
    expect(res.status, 'and it is a business refusal, not a crash').toBeLessThan(500);
    expect(
      refusalCode(res, CREDIT_ROUTE_REFUSALS.invoiceWalkin),
      `the refusal names ${CREDIT_ROUTE_REFUSALS.invoiceWalkin} — the APPLICATION's domain on this path, not the payment's. ` +
        `${WHY_ROUTE_DOMAIN} Measured: ${JSON.stringify(res.body)}`,
    ).not.toBeNull();
  });

  it('THE PLANTED RED PROOF, CREDIT SIDE — a credit application against a walk-in invoice is UNREPRESENTABLE too', async () => {
    requireSubject(missing, CLAIM);
    const res = must(lawfulCreditApplication, 'the lawful credit application');
    expect(
      res.status,
      `the lawful credit application must commit, or there is no customer_credit_applications row to clone and the credit half of the ` +
        `walk-in law is not exercised at all: ${res.status} ${JSON.stringify(res.body)}`,
    ).toBeLessThan(300);
    const sourceId = must(
      (await invoiceChain(ownerPool(), w.shop.businessId, invoiceC2.invoiceId)).find((st) => st.relation === 'customer_credit_applications'),
      `a lawful credit application of invoice ${invoiceC2.invoiceId} to clone`,
    ).id;
    const outcome = await inRolledBackTx(
      () => ownerClient(),
      w.shop,
      async (c) => {
        const newId = randomUUID();
        return raised(() =>
          plantSettlementRow(c, 'customer_credit_applications', w.shop.businessId, sourceId, {
            id: newId,
            binding_source_id: newId,
            invoice_id: walkin.invoiceId,
            ar_released_before_txn_minor: 0,
            // A FREE level on the credit side, so the departure stays the one
            // this law is about. The clone keeps the accepted row's `credit_id`,
            // and `customer_credit_applications_level_uq` is
            // `(business_id, credit_id, credit_remaining_before_minor)` — so
            // reusing the source's level would make the UNIQUE index answer
            // first and the invoice edge would never be reached. This level is
            // unused by the credit and still satisfies
            // `customer_credit_applications_consumed_ck`
            // (`consumed <= remaining_before`), because it is the maximum the
            // column admits.
            credit_remaining_before_minor: '1000000000000000000',
          }),
        );
      },
    );
    expect(
      outcome,
      `the route case above proves the COMMAND refuses this; this one proves the RELATION cannot hold such a row, which is a different ` +
        `claim and the one a future caller relies on. The planted credit application names the walk-in invoice ${walkin.invoiceId} and the ` +
        `database accepted the row. A law enforced on one of the two settling relations and not the other is half a law, so the credit side ` +
        `carries the same three-column ${STRUCTURAL.applicationEdge} as the payment side.`,
    ).not.toBeNull();
    const refusal = must(outcome, 'the refusal');
    expect(
      refusal.code,
      `and the refusal is STRUCTURAL — SQLSTATE 23503. A walk-in invoice's parent tuple carries a NULL customer_id and this row's ` +
        `customer_id is NOT NULL, so there is no tuple to match and the write cannot be expressed. Measured: [${refusal.code ?? 'no code'}] ` +
        `${refusal.message}`,
    ).toBe(FK_VIOLATION);
    expect(refusal.message, `and it names ${STRUCTURAL.applicationEdge}. Measured: ${refusal.message}`).toContain(STRUCTURAL.applicationEdge);
  });

  it('and the walk-in invoice’s chain is empty', async () => {
    requireSubject(missing, CLAIM);
    const chain = await invoiceChain(ownerPool(), w.shop.businessId, walkin.invoiceId);
    expect(chain, `the walk-in invoice ${walkin.invoiceId} of this business carries no settlement row at all: ${JSON.stringify(chain)}`).toEqual([]);
  });

  it('THE PLANTED RED PROOF — an allocation against a walk-in invoice inserted by DIRECT SQL is UNREPRESENTABLE', async () => {
    requireSubject(missing, CLAIM);
    const sourceId = await cloneSource();
    const outcome = await inRolledBackTx(
      () => ownerClient(),
      w.shop,
      async (c) => {
        const newId = randomUUID();
        return raised(() =>
          plantSettlementRow(c, 'payment_allocations', w.shop.businessId, sourceId, {
            id: newId,
            binding_source_id: newId,
            invoice_id: walkin.invoiceId,
            ar_released_before_txn_minor: 0,
          }),
        );
      },
    );
    expect(
      outcome,
      `the planted allocation names the walk-in invoice ${walkin.invoiceId} and the database accepted the row. ` +
        `\`invoices_walkin_no_ar\` (0075:661-684) only refuses a walk-in invoice whose ENTRY touches accounts_receivable, which is a ` +
        `backstop and not this law: the row itself must be unrepresentable, which is what ${STRUCTURAL.allocationEdge} onto ` +
        `${STRUCTURAL.key} makes it.`,
    ).not.toBeNull();
    const refusal = must(outcome, 'the refusal');
    expect(refusal.code, `and the refusal is STRUCTURAL — SQLSTATE 23503. Measured: [${refusal.code ?? 'no code'}] ${refusal.message}`).toBe(FK_VIOLATION);
    expect(refusal.message, `and it names ${STRUCTURAL.allocationEdge}. Measured: ${refusal.message}`).toContain(STRUCTURAL.allocationEdge);
  });
});

describe('P4-S4 the structural pin — what holds these two laws up', () => {
  it('both settlement relations still reach invoice_settlement_verify through a DEFERRABLE INITIALLY DEFERRED constraint trigger', async () => {
    requireSubject(missing, CLAIM);
    // The verifier is no longer what holds the customer pin and the walk-in law
    // up — the edge is — but it is still what holds the R-83 CHAIN up, and its
    // two named arms are kept as defence in depth. So this stays a law: the
    // wiring is read out of the LIVE catalogue with `pg_get_functiondef`,
    // because a routine REPLACED by a later migration is the one that runs and
    // a migration file is not evidence of what will execute.
    const wiring = await deferredVerifierWiring(ownerPool());
    expect(
      wiring.length,
      `NO SUBJECT — no constraint trigger exists on any of the settlement relations, so there is no wiring to read: ${JSON.stringify(wiring)}`,
    ).toBeGreaterThan(0);
    for (const relation of ['payment_allocations', 'customer_credit_applications']) {
      const own = wiring.filter((x) => x.relation === relation);
      const shown = JSON.stringify(own);
      expect(own.length, `NO SUBJECT — ${relation} carries no constraint trigger at all`).toBeGreaterThan(0);
      expect(
        own.some((x) => x.reachesVerifier),
        `${relation} must reach ${ROUTINES.invoiceSettlementVerify} from a constraint trigger, or the customer pin and the walk-in law are ` +
          `enforced by nothing the database runs. Measured: ${shown}`,
      ).toBe(true);
      expect(
        own.filter((x) => x.reachesVerifier).every((x) => x.deferred),
        `and that trigger is DEFERRABLE INITIALLY DEFERRED — the chain is only coherent at COMMIT, so a trigger that fired per statement ` +
          `would refuse a lawful multi-leg settlement mid-flight. Measured: ${shown}`,
      ).toBe(true);
    }
  });

  it('each reducer CARRIES the THREE-column structural pin, beside 0081’s narrow edge, on a NON-PARTIAL key that admits walk-in rows', async () => {
    requireSubject(missing, CLAIM);
    // THE PIN, AS A TEST — the replacement for the disclosure this `it` used to
    // be. Departure A deferred
    // `ALTER TABLE invoices ADD UNIQUE (business_id, id, customer_id)` to a
    // Tech Lead ruling, naming `0067:274` as the accepted precedent for adding
    // exactly such a key to an earlier slice's table. The ruling closed it and
    // `0082` carries it — ADDITIVELY.
    //
    // SO THIS IS A PRESENCE ASSERTION, NOT A COUNT. `0082` could not replace
    // `0081`'s narrow edge: a Phase 4 migration never drops a composite seam
    // (P2-S8's accepted rule, enforced by `compositeFkProblems`). Each reducer
    // therefore has TWO edges to `invoices`, and an assertion that it has
    // exactly one — or that EVERY invoice edge is the three-column one — would
    // be red on a correct estate and would be pressure to drop the seam. What
    // the pin needs is that the three-column edge EXISTS on each reducer, is
    // VALIDATED (a NOT VALID edge pins new rows only), is IMMEDIATE (a
    // deferred one is the verifier again) and RESTRICTs on delete. Both halves
    // are asserted: the pin per reducer, and the narrow edge still standing.
    const r = await ownerPool().query<{ relation: string; conname: string; def: string; validated: boolean; deferrable: boolean }>(
      `SELECT cl.relname AS relation, c.conname, pg_get_constraintdef(c.oid) AS def, c.convalidated AS validated, c.condeferrable AS deferrable
         FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE n.nspname = 'public' AND cl.relname = ANY ($1) AND c.contype = 'f'
          AND pg_get_constraintdef(c.oid) LIKE '%REFERENCES invoices%'
        ORDER BY 1, 2`,
      [['payment_allocations', 'customer_credit_applications']],
    );
    expect(r.rows.length, 'NO SUBJECT — neither settlement relation carries a foreign key to invoices').toBeGreaterThan(0);
    const PIN = /FOREIGN KEY \(business_id, invoice_id, customer_id\) REFERENCES invoices\(business_id, id, customer_id\)/;
    const NARROW = /FOREIGN KEY \(business_id, invoice_id\) REFERENCES invoices\(business_id, id\)/;
    for (const [relation, pinName, narrowName] of [
      ['payment_allocations', STRUCTURAL.allocationEdge, STRUCTURAL.narrowAllocationEdge],
      ['customer_credit_applications', STRUCTURAL.applicationEdge, STRUCTURAL.narrowApplicationEdge],
    ] as const) {
      const own = r.rows.filter((x) => x.relation === relation);
      const shown = JSON.stringify(own);
      const pins = own.filter((x) => PIN.test(x.def));
      expect(
        pins.map((x) => x.conname),
        `${relation} must carry the three-column pin — FOREIGN KEY (business_id, invoice_id, customer_id) REFERENCES invoices ` +
          `(business_id, id, customer_id) — so that a mismatched customer has no target at all. Without it both laws are back on a ` +
          `deferred trigger any writer can skip. Measured: ${shown}`,
      ).toEqual([pinName]);
      const pinRow = must(pins[0], `${relation}'s three-column pin`);
      expect(
        pinRow.validated,
        `and ${pinName} is VALIDATED — a NOT VALID edge pins the rows written after it and none of the rows already there. Measured: ${shown}`,
      ).toBe(true);
      expect(
        pinRow.deferrable,
        `and ${pinName} is IMMEDIATE — a DEFERRABLE edge would make the mismatch refusable at COMMIT, which is what the verifier already ` +
          `did; the pin is worth having because the row cannot be expressed at the statement. Measured: ${shown}`,
      ).toBe(false);
      expect(pinRow.def, `and ${pinName} carries ON DELETE RESTRICT, as 0081's edge did. Measured: ${pinRow.def}`).toContain('ON DELETE RESTRICT');
      // And the seam `0082` did NOT drop, positively: this is what makes the
      // corrective additive rather than a replacement, and it is read from the
      // catalogue rather than trusted to the text rule that forbids the drop.
      expect(
        own.filter((x) => NARROW.test(x.def)).map((x) => x.conname),
        `${relation} must STILL carry 0081's two-column edge ${narrowName}. The composite seams are never dropped (P2-S8's accepted rule), ` +
          `so the pin was added beside it; a seam that is gone means a later migration dropped and re-added one, which is the defect this ` +
          `shape exists to avoid. Measured: ${shown}`,
      ).toEqual([narrowName]);
    }

    // The key the edges target, and the two properties that make it work: it
    // exists, and its index is NOT PARTIAL. A partial index is not a lawful FK
    // target in PostgreSQL, and this key does not need to be partial — it
    // contains the primary key, so it is unique whatever customer_id holds.
    const key = await ownerPool().query<{ conname: string; def: string; partial: boolean }>(
      `SELECT c.conname, pg_get_constraintdef(c.oid) AS def, (i.indpred IS NOT NULL) AS partial
         FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
         JOIN pg_index i ON i.indexrelid = c.conindid
        WHERE n.nspname = 'public' AND cl.relname = 'invoices' AND c.contype IN ('p', 'u')
        ORDER BY 1`,
    );
    const pin = key.rows.filter((x) => /UNIQUE \(business_id, id, customer_id\)/.test(x.def));
    expect(
      pin.length,
      `invoices must carry UNIQUE (business_id, id, customer_id) — the key both reducer edges target. Measured keys: ` +
        `${JSON.stringify(key.rows.map((x) => x.def))}`,
    ).toBe(1);
    expect(
      must(pin[0], 'the customer key').partial,
      `and that key is NON-PARTIAL. PostgreSQL does not accept a partial unique index as a foreign-key target, which is the obstacle a ` +
        `partial key here would reintroduce — and it does not need to be partial, because containing the primary key makes it unique on the ` +
        `walk-in rows too. Measured: ${JSON.stringify(must(pin[0], 'the customer key'))}`,
    ).toBe(false);
  });

  it('and the walk-in invoice is STILL REPRESENTABLE: invoices.customer_id stayed nullable', async () => {
    requireSubject(missing, CLAIM);
    // A pin bought by forbidding walk-in sales would be a product change and
    // not an invariant. The cheapest way to make the three-column edge "work"
    // is to make `invoices.customer_id` NOT NULL, which would silence every
    // other assertion in this file and delete the walk-in sale.
    const r = await ownerPool().query<{ nullable: boolean }>(
      `SELECT NOT a.attnotnull AS nullable FROM pg_attribute a
        WHERE a.attrelid = 'public.invoices'::regclass AND a.attname = 'customer_id' AND NOT a.attisdropped`,
    );
    expect(
      must(r.rows[0], 'invoices.customer_id').nullable,
      'invoices.customer_id must stay NULLABLE — the walk-in invoice (0075:248) is a product behaviour, and the pin is structural WITHOUT ' +
        'removing it: the reducer side is NOT NULL, which is what makes a non-null triple unable to match a NULL-customer parent.',
    ).toBe(true);
    expect(walkin.customerId, 'and a real walk-in invoice of this world still carries a NULL customer').toBeNull();
  });

  it('and the OTHER half of that sentence is a catalogue fact too: every reducer column the pin names is NOT NULL', async () => {
    requireSubject(missing, CLAIM);
    // THE FACT THE WHOLE PIN RESTS ON, AND THE ONE THIS FILE WAS ONLY
    // ASSERTING IN PROSE. A composite foreign key is MATCH SIMPLE: if ANY
    // referencing column is NULL, PostgreSQL does not check the constraint at
    // all and the row is admitted. So a later slice that made
    // `payment_allocations.customer_id` nullable would not drop a constraint,
    // would not rename one, and would leave every planted red proof in this
    // file still passing — because those proofs insert a non-null WRONG
    // customer, which stays refused. What it would open is the row nobody
    // writes a proof for: `customer_id => NULL` against ANY invoice, a
    // walk-in invoice included, satisfying the edge vacuously and carrying
    // settlement money that belongs to no customer.
    //
    // The sentence one `it` above says "the reducer side is NOT NULL, which is
    // what makes a non-null triple unable to match a NULL-customer parent".
    // That is the premise of the walk-in law, and a premise asserted only
    // inside an error message is a premise nothing checks.
    const r = await ownerPool().query<{ relation: string; attname: string }>(
      `SELECT cl.relname AS relation, a.attname
         FROM pg_attribute a
         JOIN pg_class cl ON cl.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE n.nspname = 'public'
          AND cl.relname = ANY ($1)
          AND a.attname = ANY ($2)
          AND NOT a.attisdropped
          AND NOT a.attnotnull
        ORDER BY 1, 2`,
      [
        ['payment_allocations', 'customer_credit_applications'],
        ['business_id', 'invoice_id', 'customer_id'],
      ],
    );
    expect(
      r.rows,
      'every column the three-column edge references must stay NOT NULL on BOTH reducers. A nullable one makes the foreign key pass ' +
        'vacuously under MATCH SIMPLE, so the customer pin and the walk-in law would both be gone with no constraint dropped and nothing ' +
        `else in this file failing. Nullable now: ${JSON.stringify(r.rows)}`,
    ).toEqual([]);
  });

  it('the two verifier arms are KEPT as defence in depth, not deleted because the edge subsumes them', async () => {
    requireSubject(missing, CLAIM);
    // `0082` adds no trigger and replaces no routine. The customer and walk-in
    // arms of `invoice_settlement_verify` are now unreachable THROUGH THE
    // RELATIONS — the planted proofs above die at the INSERT — and they stay in
    // the routine for any future caller that arrives by another road.
    const r = await ownerPool().query<{ src: string }>(`SELECT p.prosrc AS src FROM pg_proc p WHERE p.proname = $1`, [ROUTINES.invoiceSettlementVerify]);
    const src = must(r.rows[0], `the live body of ${ROUTINES.invoiceSettlementVerify}`).src;
    for (const code of [VERIFIER_REFUSALS.customerMismatch, VERIFIER_REFUSALS.walkinNotSettleable])
      expect(
        src,
        `${code} must still be raised by ${ROUTINES.invoiceSettlementVerify}. The structural pin makes it unreachable through the two ` +
          `reducer relations; removing a check because a stronger one subsumes it trades defence in depth for tidiness, and would also mean ` +
          `replacing a candidate body with green CI evidence behind it.`,
      ).toContain(code);
  });

  it('the PARENT side is covered too: re-parenting or orphaning a settled invoice is refused, and the pin is the second line behind the frozen guard', async () => {
    requireSubject(missing, CLAIM);
    // ── A MEASURED CORRECTION, KEPT AS THE RECORD ────────────────────────
    //
    // `invoice_settlement_verify` fires from constraint triggers on the two
    // REDUCER relations, so it is never reached by a write to `invoices`
    // itself: moving a settled invoice's customer, or nulling it, is outside
    // its reach altogether. That looked like a hole the new edge closes.
    //
    // IT IS NOT A HOLE. `invoices_lifecycle_guard()` (`0075:546-556`) already
    // freezes `customer_id` on every UPDATE, and it ANSWERS FIRST — it is a
    // BEFORE trigger, so the row never reaches the edge. This `it` therefore
    // asserts the invariant (the write is refused) and NAMES THE MECHANISM
    // THAT ANSWERED, rather than claiming the edge did. Asserting 23503 here
    // would have been asserting a mechanism that never runs.
    //
    // What the three-column edge adds on the parent side is a SECOND, INDEPENDENT
    // and STRUCTURAL line behind a guard in the frozen prefix: a guard is a
    // body that can be replaced, and the edge is a shape that cannot be
    // satisfied. Both halves are asserted below — the refusal, and the edge's
    // referenced column list carrying `customer_id`.
    for (const [label, target] of [
      ['RE-PARENTING to another customer', customerD],
      ['ORPHANING into a walk-in', null],
    ] as const) {
      const outcome = await inRolledBackTx(
        () => ownerClient(),
        w.shop,
        async (c) =>
          raised(() => c.query(`UPDATE invoices SET customer_id = $3 WHERE business_id = $1 AND id = $2`, [w.shop.businessId, invoiceC.invoiceId, target])),
      );
      expect(
        outcome,
        `${label}: invoice ${invoiceC.invoiceId} carries a committed allocation of customer C's money and the database ACCEPTED the write. ` +
          `That would move C's settled money onto another receivable, or leave a walk-in invoice carrying settlement rows, with no reducer ` +
          `row changed and nothing on the reducers ever consulted.`,
      ).not.toBeNull();
      expect(
        must(outcome, 'the refusal').message,
        `${label}: and it is refused BY NAME. ${INVOICE_IDENTITY_FINAL} answers first because it is a BEFORE trigger, so the row never ` +
          `reaches the three-column edge; the edge is the second line, asserted structurally below. Measured: ` +
          `[${must(outcome, 'the refusal').code ?? 'no code'}] ${must(outcome, 'the refusal').message}`,
      ).toContain(INVOICE_IDENTITY_FINAL);
    }

    // The second line, as a shape: the referenced side of each reducer's edge
    // names `customer_id`, so a parent tuple a child depends on cannot be
    // dissolved even if the guard above were ever replaced.
    const r = await ownerPool().query<{ relation: string; referenced: string[] }>(
      `SELECT cl.relname AS relation,
              (SELECT array_agg(a.attname::text ORDER BY k.ord)
                 FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS referenced
         FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid
        WHERE c.contype = 'f' AND c.confrelid = 'public.invoices'::regclass AND cl.relname = ANY ($1)
        ORDER BY 1`,
      [['payment_allocations', 'customer_credit_applications']],
    );
    expect(r.rows.length, 'NO SUBJECT — neither reducer carries an edge to invoices').toBeGreaterThan(0);
    // Again by PRESENCE and not by count: each reducer has two edges to
    // `invoices` and only the three-column one carries `customer_id` on the
    // referenced side. Requiring EVERY edge to name it would be requiring the
    // narrow seam to have been dropped.
    for (const relation of ['payment_allocations', 'customer_credit_applications']) {
      const own = r.rows.filter((x) => x.relation === relation);
      expect(
        own.filter((x) => (x.referenced ?? []).join(',') === 'business_id,id,customer_id').length,
        `${relation} must carry an edge REFERENCING invoices (business_id, id, customer_id), so the customer of a settled invoice is part ` +
          `of the tuple its children depend on and cannot be dissolved under them. Measured: ${JSON.stringify(own)}`,
      ).toBe(1);
    }
  });

  it('cross-business linkage is still unrepresentable: one business_id column feeds every edge of a settlement row', async () => {
    requireSubject(missing, CLAIM);
    // The half of OQ-7 that Departure A did NOT give up. Every foreign key of
    // a settlement relation that reaches a business-scoped table must carry
    // `business_id` as its first column; there is then nowhere to put a second
    // business and a row linking business A's payment to business B's invoice
    // cannot be written.
    const r = await ownerPool().query<{ relation: string; conname: string; def: string }>(
      `SELECT cl.relname AS relation, c.conname, pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE n.nspname = 'public' AND cl.relname = ANY ($1) AND c.contype = 'f'
        ORDER BY 1, 2`,
      [['payments', 'payment_allocations', 'customer_credits', 'customer_credit_applications']],
    );
    expect(r.rows.length, 'NO SUBJECT — the settlement relations carry no foreign key at all').toBeGreaterThan(0);
    // The edges to the GLOBAL relations are the exceptions, and they are named
    // rather than pattern-matched: `currencies` is keyed by code and `users` by
    // id, and neither is business-scoped.
    const global = /REFERENCES (currencies|users)\(/;
    const offenders = r.rows.filter((x) => !global.test(x.def) && !/FOREIGN KEY \((tenant_id, )?business_id/.test(x.def));
    expect(
      offenders.map((x) => `${x.relation}.${x.conname}: ${x.def}`),
      `every business-scoped edge of a settlement row carries business_id as a key column, so there is nowhere to name a second business`,
    ).toEqual([]);
  });
});
