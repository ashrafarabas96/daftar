/**
 * P4-S4 — THE CUSTOMER IDENTITY PIN AND THE WALK-IN LAW.
 * (P4-S4 BUILD CONTRACT **Departure A** and OQ-7; implementation map §8.2,
 *  §8.5; `0075_phase4_customers_invoices_numbering.sql:247`, `:313-316`,
 *  `:661-684`; `0067:274` as the precedent Departure A defers.)
 *
 * ── WHY THIS FILE EXISTS AT ALL ───────────────────────────────────────────
 *
 * The implementation map proposed `ALTER TABLE invoices ADD UNIQUE
 * (business_id, id, customer_id)` so that the settlement relations could point
 * a THREE-column foreign key at it. With that key, both laws below are
 * STRUCTURAL and need no test of their own:
 *
 *   — an allocation naming customer C against an invoice of customer D has no
 *     FK target at all;
 *   — and a walk-in invoice, whose `customer_id` IS NULL (`0075:247`,
 *     `:313-316`), has no `(business, id, customer)` tuple with a non-null
 *     customer for a `NOT NULL` child column to match.
 *
 * The contract REFUSED that key for this slice: `invoices` is a table an
 * earlier slice of this phase created and applied, and widening its key is an
 * ownership question the Tech Lead has not answered. The foreign key is
 * therefore the narrow `(business_id, invoice_id) → invoices (business_id, id)`.
 *
 * Cross-business linkage is still unrepresentable — ONE `business_id` column
 * feeds every FK on the row and there is nowhere to put a second — but the two
 * laws above are no longer structural, and the contract moves them onto
 * `invoice_settlement_verify`, the DEFERRABLE INITIALLY DEFERRED constraint
 * trigger class the purchase chain already relies on:
 *
 *   1. the customer identity pin — `<row>.customer_id` must equal the
 *      invoice's `customer_id`; refusal `invoice_settlement.customer_mismatch`;
 *   2. the walk-in law — an invoice whose `customer_id IS NULL` may carry no
 *      allocation and no credit application at all; refusal
 *      `invoice_settlement.walkin_not_settleable`.
 *
 * ONE LAW, TWO VOCABULARIES. Each law is answered twice and this file asserts
 * both, because they are two different claims:
 *
 *   — at the ROUTE, the API pre-checks the invoice and refuses in the
 *     DOCUMENT's domain — `customer_payment.invoice_walkin` and
 *     `customer_payment.customer_mismatch` on the payment path,
 *     `customer_credit_application.*` on the credit path. That is what a
 *     merchant sees, and it is raised before the command reaches the database;
 *   — at COMMIT, `invoice_settlement_verify` answers in the INVARIANT's
 *     domain, `invoice_settlement.*`. That is what a future caller of the
 *     routine — an import, a correction, another slice's command — will see,
 *     and it is the one the planted rows below exercise.
 *
 * A route case that expected the verifier's code would assert a code no caller
 * of that route can see; a planted-row proof that expected the service's would
 * assert a code the database cannot raise. The codes differing is the
 * architecture.
 *
 * So each law needs a PERMANENT TEST and a PLANTED RED PROOF, which is what
 * this file is. Neither may be left to the application layer, and this file proves
 * that by planting each violation with DIRECT SQL that never touches the
 * command.
 *
 * ── WHY THE PLANTED PROOFS CALL THE VERIFIER DIRECTLY ─────────────────────
 *
 * A planted row has no accounting source binding, so letting a planted
 * transaction reach COMMIT (or `SET CONSTRAINTS ALL IMMEDIATE`) would fire
 * every deferred check in an order PostgreSQL does not promise, and the proof
 * could die on the missing binding instead of on the law it exists to
 * exercise. Each planted proof therefore calls `invoice_settlement_verify`
 * itself — and the claim that this is a proof about the ESTATE and not about a
 * function nobody runs is carried by its own `it` below, which reads
 * `pg_trigger` and requires both settlement relations to reach that verifier
 * through a deferred constraint trigger.
 *
 * Every planted transaction is rolled back in a `finally`. A planted violation
 * that committed because the law did not refuse it would poison every later
 * law of the suite, and the suite would report a cascade instead of the one
 * finding.
 *
 * ── RED UNTIL `0081` LANDS ────────────────────────────────────────────────
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
 * expects the verifier's. Stated once and quoted in each message, so a reader
 * of a failure sees the reason and not just the mismatch.
 */
const WHY_ROUTE_DOMAIN =
  "The API answers in the DOCUMENT's domain because `settledInvoice` pre-checks the invoice and refuses before the command reaches " +
  "the database, so the code a merchant sees is the payment's or the application's and NOT the verifier's `invoice_settlement.*` — " +
  'that one is raised at COMMIT and is asserted by the planted-row proof. The two codes differing is the architecture, not an ' +
  'inconsistency.';

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
      `customer C's payment may not settle customer D's invoice. With the three-column key of OQ-7 this has no FK target at all; the ` +
        `contract's Departure A refused that key for this slice and moved the law onto invoice_settlement_verify, so it must refuse here. ` +
        `Measured: ${res.status} ${JSON.stringify(res.body)}`,
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

  it('THE PLANTED RED PROOF — a mismatched allocation inserted by DIRECT SQL is refused by invoice_settlement_verify', async () => {
    requireSubject(missing, CLAIM);
    const sourceId = await cloneSource();
    const outcome = await inRolledBackTx(
      () => ownerClient(),
      w.shop,
      async (c) => {
        const newId = randomUUID();
        // ONE departure from an accepted row: the invoice it names is D's, while
        // the row's own `customer_id` stays C's. The narrow FK
        // `(business_id, invoice_id)` is satisfied — which is the whole point of
        // Departure A — so nothing but the verifier stands between this row and
        // a committed cross-customer settlement.
        await plantSettlementRow(c, 'payment_allocations', w.shop.businessId, sourceId, {
          id: newId,
          binding_source_id: newId,
          invoice_id: invoiceD.invoiceId,
          ar_released_before_txn_minor: 0,
        });
        return raised(() => c.query(`SELECT ${ROUTINES.invoiceSettlementVerify}($1::uuid, $2::uuid)`, [w.shop.businessId, invoiceD.invoiceId]));
      },
    );
    expect(
      outcome,
      `the planted allocation names invoice ${invoiceD.invoiceId} (customer D) while carrying customer C, and ${ROUTINES.invoiceSettlementVerify} ` +
        `accepted it. Departure A removed the structural guarantee and gave this law to the verifier; a verifier that does not refuse this ` +
        `means a cross-customer settlement can be committed by anything that writes the row.`,
    ).not.toBeNull();
    expect(
      must(outcome, 'the refusal').message,
      `and the refusal is the named one: ${VERIFIER_REFUSALS.customerMismatch}. Measured: ${must(outcome, 'the refusal').message}`,
    ).toContain(VERIFIER_REFUSALS.customerMismatch);
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

  it('THE PLANTED RED PROOF, CREDIT SIDE — a credit application against a walk-in invoice is refused by invoice_settlement_verify too', async () => {
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
        await plantSettlementRow(c, 'customer_credit_applications', w.shop.businessId, sourceId, {
          id: newId,
          binding_source_id: newId,
          invoice_id: walkin.invoiceId,
          ar_released_before_txn_minor: 0,
          // A FREE level on the credit side, so the departure stays the one
          // this law is about. The clone keeps the accepted row's `credit_id`,
          // and `customer_credit_applications_level_uq` is
          // `(business_id, credit_id, credit_remaining_before_minor)` — so
          // reusing the source's level made the UNIQUE index answer first and
          // `invoice_settlement_verify` was never reached. This level is unused
          // by the credit and still satisfies
          // `customer_credit_applications_consumed_ck`
          // (`consumed <= remaining_before`), because it is the maximum the
          // column admits.
          credit_remaining_before_minor: '1000000000000000000',
        });
        return raised(() => c.query(`SELECT ${ROUTINES.invoiceSettlementVerify}($1::uuid, $2::uuid)`, [w.shop.businessId, walkin.invoiceId]));
      },
    );
    expect(
      outcome,
      `the route case above proves the COMMAND refuses this; this one proves the RELATION cannot hold such a row, which is a different ` +
        `claim and the one a future caller of the routine relies on. The planted credit application names the walk-in invoice ` +
        `${walkin.invoiceId} and ${ROUTINES.invoiceSettlementVerify} accepted it.`,
    ).not.toBeNull();
    expect(
      must(outcome, 'the refusal').message,
      `and the refusal is the named one: ${VERIFIER_REFUSALS.walkinNotSettleable}. Measured: ${must(outcome, 'the refusal').message}`,
    ).toContain(VERIFIER_REFUSALS.walkinNotSettleable);
  });

  it('and the walk-in invoice’s chain is empty', async () => {
    requireSubject(missing, CLAIM);
    const chain = await invoiceChain(ownerPool(), w.shop.businessId, walkin.invoiceId);
    expect(chain, `the walk-in invoice ${walkin.invoiceId} of this business carries no settlement row at all: ${JSON.stringify(chain)}`).toEqual([]);
  });

  it('THE PLANTED RED PROOF — an allocation against a walk-in invoice inserted by DIRECT SQL is refused by invoice_settlement_verify', async () => {
    requireSubject(missing, CLAIM);
    const sourceId = await cloneSource();
    const outcome = await inRolledBackTx(
      () => ownerClient(),
      w.shop,
      async (c) => {
        const newId = randomUUID();
        await plantSettlementRow(c, 'payment_allocations', w.shop.businessId, sourceId, {
          id: newId,
          binding_source_id: newId,
          invoice_id: walkin.invoiceId,
          ar_released_before_txn_minor: 0,
        });
        return raised(() => c.query(`SELECT ${ROUTINES.invoiceSettlementVerify}($1::uuid, $2::uuid)`, [w.shop.businessId, walkin.invoiceId]));
      },
    );
    expect(
      outcome,
      `the planted allocation names the walk-in invoice ${walkin.invoiceId} and ${ROUTINES.invoiceSettlementVerify} accepted it. ` +
        `\`invoices_walkin_no_ar\` (0075:661-684) only refuses a walk-in invoice whose ENTRY touches accounts_receivable, which is a ` +
        `backstop and not this law: the row itself must be unrepresentable.`,
    ).not.toBeNull();
    expect(
      must(outcome, 'the refusal').message,
      `and the refusal is the named one: ${VERIFIER_REFUSALS.walkinNotSettleable}. Measured: ${must(outcome, 'the refusal').message}`,
    ).toContain(VERIFIER_REFUSALS.walkinNotSettleable);
  });
});

describe('P4-S4 Departure A — what holds these two laws up', () => {
  it('both settlement relations reach invoice_settlement_verify through a DEFERRABLE INITIALLY DEFERRED constraint trigger', async () => {
    requireSubject(missing, CLAIM);
    // This is what makes the two planted proofs above proofs about the ESTATE.
    // The wiring is read out of the LIVE catalogue with `pg_get_functiondef`,
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

  it('the invoice-side foreign key is the NARROW two-column one, which is why the verifier has to carry these laws', async () => {
    requireSubject(missing, CLAIM);
    // THE DISCLOSURE, AS A TEST. The contract's Departure A deferred
    // `ALTER TABLE invoices ADD UNIQUE (business_id, id, customer_id)` to a
    // Tech Lead ruling; `0067:274` is the accepted precedent for adding
    // exactly such a key to an earlier slice's table. While the key is absent
    // the FK is the two-column one and the two laws above are trigger-borne.
    //
    // The day the ruling closes it, the FK widens and THIS TEST CHANGES — on
    // purpose, so nobody has to rediscover why the verifier carried a law a
    // key could have carried. It does NOT assert the gap is correct.
    const r = await ownerPool().query<{ relation: string; conname: string; def: string }>(
      `SELECT cl.relname AS relation, c.conname, pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE n.nspname = 'public' AND cl.relname = ANY ($1) AND c.contype = 'f'
          AND pg_get_constraintdef(c.oid) LIKE '%REFERENCES invoices%'
        ORDER BY 1, 2`,
      [['payment_allocations', 'customer_credit_applications']],
    );
    expect(r.rows.length, 'NO SUBJECT — neither settlement relation carries a foreign key to invoices').toBe(2);
    for (const row of r.rows)
      expect(
        row.def,
        `${row.relation}.${row.conname} must reference invoices (business_id, id) — the existing primary key — per contract Departure A, ` +
          `not (business_id, id, customer_id). Measured: ${row.def}`,
      ).toMatch(/REFERENCES invoices\(business_id, id\)/);

    const key = await ownerPool().query<{ conname: string; def: string }>(
      `SELECT c.conname, pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE n.nspname = 'public' AND cl.relname = 'invoices' AND c.contype IN ('p', 'u')
        ORDER BY 1`,
    );
    expect(
      key.rows.filter((x) => /\(business_id, id, customer_id\)/.test(x.def)),
      `invoices must NOT yet carry UNIQUE (business_id, id, customer_id): this slice did not add it (contract Departure A, OQ-7), and the ` +
        `day a Tech Lead ruling does, both laws above become structural and this test is the one that changes. Measured keys: ` +
        `${JSON.stringify(key.rows.map((x) => x.def))}`,
    ).toEqual([]);
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
