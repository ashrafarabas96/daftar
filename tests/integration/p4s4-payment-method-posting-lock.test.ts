/**
 * P4-S4 — THE CUSTOMER-SIDE PAYMENT-METHOD POSTING-ACCOUNT LOCK.
 * (Tech Lead §23 item (4). `0067:289`, `:302`, `:351-352`, `:503-504`,
 *  `:839-841`; `0081:248-249`, `:281-284`; `0081` R-85 as the disclosure this
 *  file MEASURES rather than repeats.)
 *
 * ── THE QUESTION, AND WHY IT NEEDED A MEASUREMENT ─────────────────────────
 *
 * On the supplier side there is an accepted mechanism that pins which general
 * ledger account a payment method posts to, so the posting account is not
 * client-selected and cannot drift. `0081` R-85 ("DEPARTURE B") discloses that
 * the customer side does not have it:
 *
 *     "`payment_method_guard()` IS NOT TOUCHED. Its `posting_account_locked`
 *      arm names `supplier_payments` and `supplier_refunds` only
 *      (`0067:839-841`), so a method that has taken a CUSTOMER payment may
 *      still move its posting account. … The gap is REAL and DISCLOSED."
 *
 * THE FIRST HALF OF THAT IS TRUE AND THE CONCLUSION IS FALSE, and this file is
 * the measurement that separates them. The arm really does name only the two
 * supplier relations — the first `it` below reads the LIVE body and asserts
 * exactly that, so the disclosure is not softened. But the arm is not what
 * makes the supplier-side account un-driftable, and the customer side already
 * has the thing that does.
 *
 * ── THE ACCEPTED MECHANISM IS A COMPOSITE EDGE, NOT THE TRIGGER ───────────
 *
 * `payment_methods` carries `UNIQUE (business_id, id, posting_account_id)`
 * (`0067:302`) — a candidate key that exists only to be a foreign-key target,
 * since `(business_id, id)` is already the primary key. Every settlement
 * document then stores its own `posting_account_id` and reaches the method
 * THROUGH that triple:
 *
 *   — `supplier_payments_method_fk`   (`0067:351-352`)
 *   — `supplier_refunds_method_fk`    (`0067:503-504`)
 *   — `payments_method_fk`            (`0081:281-284`)  ← the customer side
 *
 * That one edge does both halves of the job, and each half is an `it` below:
 *
 *   NOT CLIENT-SELECTED. The posting account is part of the KEY into the
 *   method row, so a (method of A, account of B) pair and a (method, account)
 *   pair the method does not carry are both unrepresentable. A caller cannot
 *   name a general-ledger account; it can only name a method, and the account
 *   comes with it.
 *
 *   CANNOT DRIFT. `UPDATE payment_methods SET posting_account_id = …` under a
 *   live child dissolves the parent tuple `(business, id, old account)` that
 *   the child depends on, and the edge's parent-side action refuses the
 *   update. This holds for `payments` exactly as it holds for
 *   `supplier_payments`, because it is the same edge shape onto the same key.
 *
 * So what `payment_method_guard()`'s arm actually contributes on the supplier
 * side is a NAMED refusal — `payment_method.posting_account_locked` — in place
 * of a raw `foreign_key_violation`. On the customer side the lock holds and the
 * refusal is the raw SQLSTATE. That is a DIAGNOSTICS difference, not an
 * integrity one, and the last `it` below measures it in that form so the
 * remaining difference is recorded as what it is rather than as a missing lock.
 *
 * ── WHY THIS FILE BUILDS NOTHING ──────────────────────────────────────────
 *
 * Extending the arm would mean replacing a Phase 3 body and re-recording its
 * SHA-256 inside `supplier_settlement_guard_gaps()` (`0072:700-720`), which is
 * cross-phase surface no ruling covers — R-85 is right about that. And the
 * §23 item asks for the LOCK, which is present. A lock that is enforced does
 * not need a second enforcement; it needs a test that fails the day somebody
 * weakens the edge, which is what this file is. `0082` adds nothing for this
 * item and says so in its own R-97.
 *
 * Every `it` requires its subject first. No `.skip`, no `.todo`, no
 * conditional pass.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { ownerClient } from '../helpers/stock-ledger';
import { requireSubject } from '../golden-regression/phase4-s2/harness';
import { inRolledBackTx, must, raised } from '../golden-regression/phase4-s4/harness';
import { collectPayment } from '../golden-regression/phase4-s4/settlement-path';
import { methodRevision, methodUpdateCall, runS6 } from '../helpers/supplier-settlement';
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
  'the general-ledger account a customer payment posts to is fixed by the payment method and cannot be chosen by the caller or moved once the method has taken a payment';

/** `foreign_key_violation` — the class the composite edge refuses with. */
const FK_VIOLATION = '23503';

/** The named refusal the supplier-side trigger arm raises in its place. */
const NAMED_LOCK = 'payment_method.posting_account_locked';

/** The candidate key on `payment_methods` that every settlement edge targets (`0067:302`). */
const METHOD_ACCOUNT_KEY = 'payment_methods_account_uq';

let w: SettlementWorld;
let missing: readonly string[] = [];
let customer: string;
let invoice: OpenInvoice;
/** A second, eligible settlement asset account the method could be moved to. */
let otherAccount: string | undefined;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  w = await settlementWorld('s4lock');
  missing = await settlementMissing(w);
  if (missing.length > 0) return;

  await stockUp(w, '100', '6');
  customer = await newCustomer(w);
  invoice = await sellOnCredit(w, customer, '2');

  // The method takes a CUSTOMER payment and nothing else, which is the exact
  // state R-85 says leaves the posting account free to move.
  const res = await collectPayment(w.t, w.headers, {
    paymentId: randomUUID(),
    customerId: customer,
    paymentMethodId: w.paymentMethodId,
    paymentDate: w.day,
    amountMinor: invoice.totalTxnMinor,
    allocations: [
      {
        invoiceId: invoice.invoiceId,
        appliedMinor: invoice.totalTxnMinor,
        releasedBeforeMinor: '0',
        invoiceTotalTxnMinor: invoice.totalTxnMinor,
        invoiceTotalBaseMinor: invoice.totalBaseMinor,
      },
    ],
  });
  expect(res.status, `the customer payment must commit, or the lock has no subject at all: ${res.status} ${JSON.stringify(res.body)}`).toBeLessThan(300);

  // Another account the method is ELIGIBLE to post to, so a refusal below is
  // caused by the lock and not by the eligibility policy (R-65). Eligibility is
  // asked of the accepted helper rather than re-derived from account types
  // here — a second copy of that policy in a fixture is a second policy. The
  // helper is judged "only for the transaction's business", so the question is
  // put inside a business-scoped transaction; it is read-only and rolled back.
  otherAccount = await inRolledBackTx(
    () => ownerClient(),
    w.shop,
    async (c) => {
      const r = await c.query<{ id: string }>(
        `SELECT a.id::text AS id FROM accounts a
        WHERE a.business_id = $1 AND a.id <> $2
          AND accounting_settlement_account_eligibility(a.business_id, a.id) = 'eligible'
        ORDER BY a.id LIMIT 1`,
        [w.shop.businessId, w.postingAccountId],
      );
      return r.rows[0]?.id;
    },
  );
}, 420_000);

afterAll(async () => {
  await w?.t?.close();
  await resetData();
});

/**
 * Ask the REAL command to move the method's posting account, and report what
 * it raised (or `null` if it succeeded).
 *
 * It goes through `payment_method_update` — the signed `payment.update_method`
 * entry routine, as `daftar_app`, with a real `invctl/1` assertion over the
 * arguments — and NOT through a bare `UPDATE`. A bare `UPDATE` is refused
 * earlier and for a different reason: `payment_method_guard()`'s
 * `field_immutable` arm requires the next revision, this transaction's own
 * `now()` and its own business-transaction id, so it answers before the lock
 * does and a proof written that way would assert the immutability arm while
 * claiming to assert the posting-account lock.
 *
 * The transaction is always rolled back. A posting account that really moved
 * would change where every later test's money lands.
 */
function moveThePostingAccount(destination: string): Promise<{ readonly message: string; readonly code: string | undefined } | null> {
  return inRolledBackTx(
    () => ownerClient(),
    w.shop,
    async (c) =>
      raised(async () => {
        const revision = await methodRevision(c, w.shop.businessId, w.paymentMethodId);
        await runS6(c, w.shop, methodUpdateCall(w.shop, w.paymentMethodId, revision, { postingAccountId: destination }));
      }),
  );
}

/** The method's posting account as the database holds it right now. */
async function postingAccount(): Promise<string> {
  const r = await ownerPool().query<{ acct: string }>(`SELECT posting_account_id::text AS acct FROM payment_methods WHERE business_id = $1 AND id = $2`, [
    w.shop.businessId,
    w.paymentMethodId,
  ]);
  return must(r.rows[0], `payment method ${w.paymentMethodId}`).acct;
}

describe('P4-S4 the customer-side posting-account lock', () => {
  it('the subject exists: the settlement surface, a method that has taken a CUSTOMER payment, and a second eligible account to move it to', async () => {
    requireSubject(missing, CLAIM);
    const n = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM payments WHERE business_id = $1 AND payment_method_id = $2`, [
      w.shop.businessId,
      w.paymentMethodId,
    ]);
    expect(
      must(n.rows[0], 'the payment count').n,
      `NO SUBJECT — the method has taken no customer payment, so "a method that has taken a customer payment keeps its posting account" is ` +
        `quantified over nothing`,
    ).toBeGreaterThan(0);
    const supplierSide = await ownerPool().query<{ n: number }>(
      `SELECT (SELECT count(*) FROM supplier_payments s WHERE s.business_id = $1 AND s.payment_method_id = $2)
            + (SELECT count(*) FROM supplier_refunds f WHERE f.business_id = $1 AND f.payment_method_id = $2) AS n`,
      [w.shop.businessId, w.paymentMethodId],
    );
    expect(
      Number(must(supplierSide.rows[0], 'the supplier-side count').n),
      `and it has taken NO supplier payment or refund — otherwise the trigger arm would answer and this file would be measuring the ` +
        `supplier-side lock while claiming to measure the customer-side one`,
    ).toBe(0);
    expect(
      otherAccount,
      'NO SUBJECT — no second eligible settlement account exists, so a refusal could not be told from an ineligible destination',
    ).toBeDefined();
  });

  it('THE DISCLOSURE, MEASURED: payment_method_guard’s posting_account_locked arm really does name only the two SUPPLIER relations', async () => {
    requireSubject(missing, CLAIM);
    // R-85's premise, read from the LIVE body rather than from the migration
    // text, because a routine replaced by a later migration is the one that
    // runs. This `it` exists so the finding below cannot be mistaken for a
    // claim that the disclosure was wrong about the trigger: it was right.
    const r = await ownerPool().query<{ src: string }>(`SELECT p.prosrc AS src FROM pg_proc p WHERE p.proname = 'payment_method_guard'`);
    const src = must(r.rows[0], 'the live body of payment_method_guard()').src;
    expect(src, `NO SUBJECT — the live guard raises no ${NAMED_LOCK} at all, so there is no arm to measure`).toContain(NAMED_LOCK);
    for (const table of ['supplier_payments', 'supplier_refunds'])
      expect(src, `the arm consults ${table}, which is the supplier-side half of the lock`).toMatch(new RegExp(`FROM ${table}\\b`));
    expect(
      /FROM payments\b/.test(src),
      `and it does NOT consult \`payments\`. This is R-85's premise and it holds. What does not follow from it is R-85's conclusion — that a ` +
        `method which has taken a customer payment "may still move its posting account" — because the arm is not what makes the account ` +
        `un-driftable on either side. The next two laws measure what does.`,
    ).toBe(false);
  });

  it('THE POSTING ACCOUNT IS NOT CLIENT-SELECTED: it is part of the key into the method row, on the customer side exactly as on the supplier side', async () => {
    requireSubject(missing, CLAIM);
    // The accepted mechanism, read from the catalogue and quantified over all
    // three settlement documents at once, so the customer side is judged by
    // the same claim as the two supplier relations rather than by a claim
    // written for it.
    const r = await ownerPool().query<{ relation: string; conname: string; referencing: string[]; referenced: string[] }>(
      `SELECT cl.relname AS relation, c.conname,
              (SELECT array_agg(a.attname::text ORDER BY k.ord)
                 FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS referencing,
              (SELECT array_agg(a.attname::text ORDER BY k.ord)
                 FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS referenced
         FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid
        WHERE c.contype = 'f' AND c.confrelid = 'public.payment_methods'::regclass AND cl.relname = ANY ($1)
        ORDER BY 1`,
      [['payments', 'supplier_payments', 'supplier_refunds']],
    );
    expect(
      r.rows.map((x) => x.relation),
      'NO SUBJECT — each of the three settlement documents must carry an edge into payment_methods, or there is nothing to compare',
    ).toEqual(['payments', 'supplier_payments', 'supplier_refunds']);
    for (const row of r.rows) {
      expect(
        row.referencing,
        `${row.relation}.${row.conname} must reference the method through (business_id, payment_method_id, posting_account_id) — the ` +
          `account being PART OF THE KEY is what stops a caller naming a general-ledger account at all. Measured: ${JSON.stringify(row.referencing)}`,
      ).toEqual(['business_id', 'payment_method_id', 'posting_account_id']);
      expect(
        row.referenced,
        `and it must target payment_methods (business_id, id, posting_account_id), the ${METHOD_ACCOUNT_KEY} candidate key (0067:302) — a ` +
          `two-column edge onto the primary key would let the row carry any account it liked. Measured: ${JSON.stringify(row.referenced)}`,
      ).toEqual(['business_id', 'id', 'posting_account_id']);
    }
    // And the key itself, non-partial, or none of the above could be declared.
    const key = await ownerPool().query<{ conname: string; partial: boolean }>(
      `SELECT c.conname, (i.indpred IS NOT NULL) AS partial
         FROM pg_constraint c JOIN pg_index i ON i.indexrelid = c.conindid
        WHERE c.conrelid = 'public.payment_methods'::regclass AND c.contype = 'u' AND c.conname = $1`,
      [METHOD_ACCOUNT_KEY],
    );
    expect(key.rows.length, `${METHOD_ACCOUNT_KEY} must exist on payment_methods — it is the target all three edges name`).toBe(1);
    expect(must(key.rows[0], 'the method account key').partial, 'and it is non-partial, as a foreign-key target must be').toBe(false);
  });

  it('THE RED PROOF — a method that has taken a CUSTOMER payment CANNOT move its posting account: the write is refused', async () => {
    requireSubject(missing, CLAIM);
    const before = await postingAccount();
    const destination = must(otherAccount, 'a second eligible settlement account');
    expect(destination, 'the destination is a DIFFERENT account, or the update would be a no-op and would refuse nothing').not.toBe(before);
    const outcome = await moveThePostingAccount(destination);
    expect(
      outcome,
      `payment method ${w.paymentMethodId} has taken a customer payment that posted to account ${before}, and the database allowed the ` +
        `method to be repointed at ${destination}. Every future payment on this method would then post somewhere else than every past one, ` +
        `with no entry rewritten and nothing naming the change. R-85 predicted exactly this and it does not happen: ` +
        `payments_method_fk (0081:281-284) is the same three-column edge onto ${METHOD_ACCOUNT_KEY} that the supplier relations carry, and ` +
        `the parent tuple this payment depends on cannot be dissolved under it.`,
    ).not.toBeNull();
    expect(
      must(outcome, 'the refusal').code,
      `and the refusal is the EDGE's, SQLSTATE ${FK_VIOLATION} — structural, not a trigger body a later migration could replace. Measured: ` +
        `[${must(outcome, 'the refusal').code ?? 'no code'}] ${must(outcome, 'the refusal').message}`,
    ).toBe(FK_VIOLATION);
    expect(
      must(outcome, 'the refusal').message,
      `and it names payments_method_fk, so the finding points at the constraint that answered. Measured: ${must(outcome, 'the refusal').message}`,
    ).toContain('payments_method_fk');
    expect(await postingAccount(), 'and the method still posts where it posted before').toBe(before);
  });

  it('WHAT IS ACTUALLY LEFT: the customer-side refusal is the raw SQLSTATE and not the named one — a diagnostics difference, recorded as such', async () => {
    requireSubject(missing, CLAIM);
    // The honest remainder of R-85, stated as a measurement rather than as a
    // missing lock. On the supplier side the BEFORE trigger reaches the arm
    // first and a merchant sees `payment_method.posting_account_locked`; on the
    // customer side the arm passes and the edge answers, so a merchant sees a
    // foreign-key violation. Both REFUSE. Only the sentence differs.
    //
    // This `it` is the one that changes if the arm is ever extended — which
    // would mean replacing a Phase 3 body and re-recording its digest inside
    // `supplier_settlement_guard_gaps()`, cross-phase surface no ruling
    // covers. Until then the difference is written down here instead of being
    // carried in a migration comment nobody executes.
    const refusal = must(await moveThePostingAccount(must(otherAccount, 'a second eligible settlement account')), 'the refusal');
    expect(
      refusal.message.includes(NAMED_LOCK),
      `the customer-side refusal does NOT name ${NAMED_LOCK} — payment_method_guard()'s arm consults only the two supplier relations, so it ` +
        `passes, and the edge refuses afterwards with a raw ${FK_VIOLATION}. If this assertion has gone red the arm was extended to consult ` +
        `\`payments\`, which is a welcome change and makes THIS test the one to update: the lock itself did not change, only the sentence a ` +
        `merchant reads. Measured: ${refusal.message}`,
    ).toBe(false);
    expect(
      refusal.code,
      `and it is still a refusal, which is the part that matters. A diagnostics gap is not an integrity gap. Measured: ` +
        `[${refusal.code ?? 'no code'}] ${refusal.message}`,
    ).toBe(FK_VIOLATION);
  });
});
