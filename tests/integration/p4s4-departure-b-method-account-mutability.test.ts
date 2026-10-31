/**
 * P4-S4 — DEPARTURE B, DOCUMENTED: WHAT HAPPENS WHEN A PAYMENT METHOD THAT
 * HAS TAKEN A **CUSTOMER** PAYMENT IS ASKED TO MOVE ITS POSTING ACCOUNT.
 * (Tech Lead §23 item (4); `docs/PHASE_4_ARCHITECTURE_LOCK.md` "Departure B";
 *  `0067:814` `payment_method_guard()`, `:839-841` the arm; `0067:302`
 *  `payment_methods_account_uq`; `0068:169` `payment_method_update`;
 *  `0081:281-284` `payments_method_fk`; `0067:1801` / `0068:1331` the pinned
 *  body digest.)
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  THIS FILE DOCUMENTS BEHAVIOUR. IT DOES NOT ENDORSE IT.              ║
 * ║                                                                      ║
 * ║  Every assertion below says what THIS DATABASE DOES TODAY. Not one   ║
 * ║  of them says that what it does is right, and none of them is an     ║
 * ║  argument for leaving it that way. Departure B is a declared         ║
 * ║  departure and it stays declared until a slice closes it.            ║
 * ║                                                                      ║
 * ║  THE DAY A LATER SLICE CLOSES DEPARTURE B, THIS FILE IS WHAT GOES    ║
 * ║  RED. That is its job. When it does: DELETE OR INVERT THE ASSERTION  ║
 * ║  THAT WENT RED, AND CLOSE DEPARTURE B IN                             ║
 * ║  `docs/PHASE_4_ARCHITECTURE_LOCK.md`. Each assertion's own failure    ║
 * ║  message repeats that instruction, so a future reader who sees only  ║
 * ║  the CI log still knows what to do.                                  ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * ── WHAT THE DEPARTURE IS, IN ONE LINE OF SQL ─────────────────────────────
 *
 * `payment_method_guard()`'s lock arm (`0067:839-841`) reads:
 *
 *     IF NEW.posting_account_id IS DISTINCT FROM OLD.posting_account_id
 *        AND (EXISTS (SELECT 1 FROM supplier_payments …)
 *             OR EXISTS (SELECT 1 FROM supplier_refunds …)) THEN
 *       RAISE EXCEPTION 'payment_method.posting_account_locked: …'
 *
 * The customer-side relation `payments` is not in that condition. The guard's
 * body digest is PINNED by `supplier_settlement_guard_gaps()` (`0067:1801`,
 * re-pinned at `0068:1331`), so this slice may not extend the arm: it must
 * document instead. Hence this file, and hence its being a permanent test and
 * not a migration.
 *
 * ── WHAT THE MEASUREMENT FOUND, AND WHY THE FILE IS SHAPED THIS WAY ───────
 *
 * The departure's own text predicts that "a payment method's `posting_account_id`
 * can still be changed while `payments` rows reference that method". MEASURED
 * ON THIS HEAD, THROUGH THE PRODUCT'S OWN SIGNED COMMAND, THAT CHANGE IS
 * REFUSED. Not by the guard — the guard really does pass, and the fourth `it`
 * below proves it passes by reading the live body — but by
 * `payments_method_fk` (`0081:281-284`), the three-column edge
 * `(business_id, payment_method_id, posting_account_id)` into
 * `payment_methods (business_id, id, posting_account_id)`
 * (`payment_methods_account_uq`, `0067:302`). An `UPDATE` of the parent's
 * `posting_account_id` dissolves the parent tuple a live `payments` row
 * depends on, and the edge's parent-side action (`NO ACTION`, the default)
 * refuses it with SQLSTATE `23503`.
 *
 * So the file documents the departure AS IT ACTUALLY IS, which is narrower
 * than as it was written down: what is missing on the customer side is the
 * NAMED refusal `payment_method.posting_account_locked`, not the refusal. The
 * integrity half of the lock is enforced; the diagnostics half is not. Both
 * halves are measured here, and the two are kept apart assertion by
 * assertion so that nobody has to take this comment's word for either.
 *
 * ── THE CONTRAST IS THE WHOLE PROOF ───────────────────────────────────────
 *
 * A file that only showed the customer side could be green because the guard
 * is absent, broken or unwired, and it would read exactly the same. So the
 * SAME command, in the SAME transaction shape, is also pointed at a method
 * that a `supplier_payments` row references, and that one is refused with
 * `payment_method.posting_account_locked`. The guard is alive, its arm fires,
 * and the only difference between the two methods is which relation holds the
 * row that references them.
 *
 * ── HOW THE BEHAVIOUR IS REACHED ──────────────────────────────────────────
 *
 * Through `payment_method_update` (`0068:169`), `SECURITY DEFINER`, as
 * `daftar_app`, consuming a real signed `payment.update_method` assertion
 * minted with the test key over the `invpl/1` stream of its own arguments —
 * the accepted `methodUpdateCall` + `runS6` path of the Phase 3 settlement
 * harness, reused and not re-invented. NEVER a bare `UPDATE`: a bare `UPDATE`
 * is answered earlier, and for a different reason, by the guard's
 * `field_immutable` arm (it demands the next revision, this transaction's own
 * `now()` and its own business-transaction id), so a proof written that way
 * would be about immutability while claiming to be about the posting account.
 *
 * Every attempt runs inside a transaction that is ALWAYS rolled back. A
 * posting account that really moved would change where every later suite's
 * money lands.
 *
 * ── THE BOUND, READ AND NOT ASSUMED ───────────────────────────────────────
 *
 * The departure is tolerable because every `payments` row pins its OWN
 * `posting_account_id` and its journal entry is posted against the pinned
 * value, so no existing row and no posted entry is ever rewritten. The last
 * `it` READS the journal entry bound to the payment's allocation — line by
 * line, out of `accounting_source_bindings` ⋈ `journal_lines` ⋈ `accounts` —
 * before and after the attempt, and compares. It does not assume.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { ownerClient } from '../helpers/stock-ledger';
import { requireSubject } from '../golden-regression/phase4-s2/harness';
import { entryOfSource, inRolledBackTx, must, systemAccountId } from '../golden-regression/phase4-s4/harness';
import { collectPayment } from '../golden-regression/phase4-s4/settlement-path';
import { committed, createMethod, methodRevision, methodUpdateCall, payInFull, runS6 } from '../helpers/supplier-settlement';
import { receivedPurchase } from '../helpers/purchase-returns';
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
  'what this database does today when a payment method that has taken a CUSTOMER payment is asked, through the product’s own signed command, to move its posting account — and what it does when the referencing row is a SUPPLIER payment instead';

/** The named refusal the guard's arm (`0067:839-841`) raises on the supplier side. */
const NAMED_LOCK = 'payment_method.posting_account_locked';

/** `foreign_key_violation`: the class a dissolved parent tuple is refused with. */
const FK_VIOLATION = '23503';

/** The edge that answers on the customer side (`0081:281-284`). */
const CUSTOMER_EDGE = 'payments_method_fk';

/** The source type the customer payment's journal entry is bound under. */
const ALLOCATION_SOURCE = 'customer_payment_allocation';

/**
 * The sentence every failure message in this file ends with. A future reader
 * meets this test as a red line in a CI log, not as a file they chose to
 * open, so the instruction has to travel inside the failure itself.
 */
const WHEN_THIS_GOES_RED =
  ' ─── THIS TEST DOCUMENTS BEHAVIOUR AND DOES NOT ENDORSE IT. If this assertion has gone red, the behaviour it recorded has CHANGED, ' +
  'which is very probably a later slice closing Departure B. That is a welcome change and this file is what is supposed to announce it: ' +
  'DELETE OR INVERT THIS ASSERTION, and CLOSE "Departure B" in docs/PHASE_4_ARCHITECTURE_LOCK.md. Do not weaken the assertion to make it ' +
  'pass and do not delete the file: the other assertions here are still the record of what the lock does.';

let w: SettlementWorld;
let missing: readonly string[] = [];
let invoice: OpenInvoice;
let paymentId: string;
/** The id of the payment's one allocation, read back from the stored row. */
let allocationId: string;
/** A SECOND method of the same business, which takes a SUPPLIER payment and no customer payment. */
let supplierMethodId: string;
/** The account that second method posts to (`bank`), and the destination each method is asked to move to. */
let bankAccountId: string;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  w = await settlementWorld('s4depb');
  missing = await settlementMissing(w);
  if (missing.length > 0) return;

  await stockUp(w, '100', '6');
  const customer = await newCustomer(w);
  invoice = await sellOnCredit(w, customer, '2');

  // ── the CUSTOMER-side subject: `w.paymentMethodId` takes a real customer
  // payment through the product's own command and nothing else.
  paymentId = randomUUID();
  const res = await collectPayment(w.t, w.headers, {
    paymentId,
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
  expect(res.status, `the customer payment must commit, or this file documents nothing: ${res.status} ${JSON.stringify(res.body)}`).toBeLessThan(300);
  allocationId = must(
    (
      await ownerPool().query<{ id: string }>(`SELECT id::text AS id FROM payment_allocations WHERE business_id = $1 AND payment_id = $2`, [
        w.shop.businessId,
        paymentId,
      ])
    ).rows[0],
    `the allocation of payment ${paymentId}`,
  ).id;

  // ── the SUPPLIER-side control: a second method, on the business's `bank`
  // system account, created through the same accepted `payment.create_method`
  // command, which then takes a real supplier payment against a real received
  // purchase. A second method and not the same one: a method carrying BOTH a
  // customer and a supplier row could not tell the two halves apart.
  bankAccountId = must(await systemAccountId(ownerPool(), w.shop.businessId, 'bank'), `the business's bank system account`);
  supplierMethodId = await committed((c) =>
    createMethod(c, w.shop, { postingAccountId: bankAccountId, systemType: 'bank_transfer', names: { ar: 'حوالة', en: 'Bank transfer', tr: null } }),
  );
  await committed(async (c) => {
    const purchase = await receivedPurchase(c, w.shop, [{ variantId: w.shop.piece.variantId, qty: '2', unitPriceMinor: '1000' }]);
    await payInFull(c, w.shop, purchase.purchaseId, purchase.supplierId, supplierMethodId);
  });
}, 420_000);

afterAll(async () => {
  await w?.t?.close();
  await resetData();
});

/**
 * Ask the REAL command to move `method`'s posting account to `destination`,
 * and report what it raised — or `null` when it succeeded.
 *
 * `payment_method_update` (`0068:169`) as `daftar_app`, with a real signed
 * `payment.update_method` assertion over its own arguments, the stored
 * revision read first. Always rolled back.
 */
function moveThePostingAccount(method: string, destination: string): Promise<{ readonly message: string; readonly code: string | undefined } | null> {
  return inRolledBackTx(
    () => ownerClient(),
    w.shop,
    async (c) => {
      const revision = await methodRevision(c, w.shop.businessId, method);
      try {
        await runS6(c, w.shop, methodUpdateCall(w.shop, method, revision, { postingAccountId: destination }));
        return null;
      } catch (e) {
        const err = e as { message?: unknown; code?: unknown };
        return { message: String(err.message ?? e), code: typeof err.code === 'string' ? err.code : undefined };
      }
    },
  );
}

/** A method's posting account as the database holds it right now. */
async function postingAccount(method: string): Promise<string> {
  return must(
    (
      await ownerPool().query<{ acct: string }>(`SELECT posting_account_id::text AS acct FROM payment_methods WHERE business_id = $1 AND id = $2`, [
        w.shop.businessId,
        method,
      ])
    ).rows[0],
    `payment method ${method}`,
  ).acct;
}

/** How many rows of `relation` reference `method`. */
async function referencesFrom(relation: 'payments' | 'supplier_payments' | 'supplier_refunds', method: string): Promise<number> {
  const r = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM ${relation} WHERE business_id = $1 AND payment_method_id = $2`, [
    w.shop.businessId,
    method,
  ]);
  return must(r.rows[0], `the ${relation} count`).n;
}

interface EntryLine {
  readonly accountId: string;
  readonly debitMinor: string;
  readonly creditMinor: string;
}

/**
 * The journal entry bound to the payment's allocation, line for line, in a
 * deterministic order — READ, never assumed. The binding is followed out of
 * `accounting_source_bindings`, so no suite guesses which entry it is.
 */
async function allocationEntry(): Promise<{ readonly entryId: string; readonly lines: readonly EntryLine[] }> {
  const entryId = must(
    await entryOfSource(ownerPool(), w.shop.businessId, ALLOCATION_SOURCE, allocationId),
    `the ${ALLOCATION_SOURCE} entry of ${allocationId}`,
  );
  const r = await ownerPool().query<{ account_id: string; debit_minor: string; credit_minor: string }>(
    `SELECT l.account_id::text AS account_id, l.debit_minor::text AS debit_minor, l.credit_minor::text AS credit_minor
       FROM journal_lines l
      WHERE l.business_id = $1 AND l.journal_entry_id = $2
      ORDER BY l.account_id, l.debit_minor, l.credit_minor`,
    [w.shop.businessId, entryId],
  );
  return { entryId, lines: r.rows.map((x) => ({ accountId: x.account_id, debitMinor: x.debit_minor, creditMinor: x.credit_minor })) };
}

describe('P4-S4 Departure B documented — the customer-side payment-method posting account', () => {
  it('THE SUBJECT: one method referenced only by a CUSTOMER payment, one referenced only by a SUPPLIER payment, and a different eligible account to move each to', async () => {
    requireSubject(missing, CLAIM);

    // Without this `it` every assertion below is quantified over nothing.
    expect(
      await referencesFrom('payments', w.paymentMethodId),
      `NO SUBJECT — method ${w.paymentMethodId} has taken no customer payment, so "a method that has taken a customer payment …" is about nothing`,
    ).toBeGreaterThan(0);
    expect(
      (await referencesFrom('supplier_payments', w.paymentMethodId)) + (await referencesFrom('supplier_refunds', w.paymentMethodId)),
      `and it has taken NO supplier payment or refund — otherwise the guard's arm would answer and this file would be measuring the supplier ` +
        `side while claiming to measure the customer side`,
    ).toBe(0);
    expect(
      await referencesFrom('supplier_payments', supplierMethodId),
      `NO SUBJECT — the control method ${supplierMethodId} has taken no supplier payment, so the contrast that proves the guard is ALIVE ` +
        `would be missing and a green customer-side result could not be told from an absent guard`,
    ).toBeGreaterThan(0);
    expect(await referencesFrom('payments', supplierMethodId), 'and the control method has taken no customer payment, so the two halves stay separable').toBe(
      0,
    );

    // Each payment pins its own account, which is the premise of the bound.
    const pinned = await ownerPool().query<{ acct: string }>(`SELECT posting_account_id::text AS acct FROM payments WHERE business_id = $1 AND id = $2`, [
      w.shop.businessId,
      paymentId,
    ]);
    expect(
      must(pinned.rows[0], `payment ${paymentId}`).acct,
      `the customer payment must really reference the method's account — a payments row that did not would make the whole question moot`,
    ).toBe(await postingAccount(w.paymentMethodId));

    // The destinations. Asked of the accepted eligibility helper rather than
    // re-derived from account types here: a second copy of that policy in a
    // fixture is a second policy, and then a refusal below could not be told
    // from an ineligible destination.
    const eligibility = await inRolledBackTx(
      () => ownerClient(),
      w.shop,
      async (c) =>
        (
          await c.query<{ account: string; verdict: string }>(
            `SELECT a.id::text AS account, accounting_settlement_account_eligibility(a.business_id, a.id)::text AS verdict
               FROM accounts a WHERE a.business_id = $1 AND a.id = ANY ($2) ORDER BY a.id`,
            [w.shop.businessId, [w.postingAccountId, bankAccountId]],
          )
        ).rows,
    );
    expect(eligibility.length, 'both accounts exist').toBe(2);
    for (const row of eligibility)
      expect(row.verdict, `account ${row.account} must be an ELIGIBLE settlement account, or a refusal below would be the eligibility rule's`).toBe('eligible');
    expect(bankAccountId, 'the two accounts are different, or every move below would be a no-op that refuses nothing').not.toBe(w.postingAccountId);
    expect(await postingAccount(w.paymentMethodId), 'the customer method posts to the cash account it was created on').toBe(w.postingAccountId);
    expect(await postingAccount(supplierMethodId), 'the control method posts to the bank account it was created on').toBe(bankAccountId);
  });

  it('THE CONTRAST, so a result below cannot be green because the guard is absent: a method referenced by a SUPPLIER payment is REFUSED with payment_method.posting_account_locked', async () => {
    requireSubject(missing, CLAIM);
    const before = await postingAccount(supplierMethodId);
    const outcome = await moveThePostingAccount(supplierMethodId, w.postingAccountId);
    expect(
      outcome,
      `method ${supplierMethodId} is referenced by a supplier_payments row and the database let it be repointed from ${before} to ` +
        `${w.postingAccountId}. The guard's arm (0067:839-841) names supplier_payments explicitly, so either the arm is gone, the trigger is ` +
        `unwired, or the routine stopped reaching it — and in that case every customer-side measurement in this file is measuring a guard ` +
        `that is not there.${WHEN_THIS_GOES_RED}`,
    ).not.toBeNull();
    expect(
      must(outcome, 'the supplier-side refusal').message,
      `and the refusal is the NAMED one, ${NAMED_LOCK} — that named refusal is exactly what the customer side does not get, and the next ` +
        `assertion is only meaningful because this one holds. Measured: [${must(outcome, 'the supplier-side refusal').code ?? 'no code'}] ` +
        `${must(outcome, 'the supplier-side refusal').message}${WHEN_THIS_GOES_RED}`,
    ).toContain(NAMED_LOCK);
    expect(await postingAccount(supplierMethodId), 'and the control method still posts where it posted before').toBe(before);
  });

  it('WHAT THE CUSTOMER SIDE DOES TODAY: the same command, on a method referenced by a CUSTOMER payment, is refused by payments_method_fk and NOT by the guard', async () => {
    requireSubject(missing, CLAIM);
    const before = await postingAccount(w.paymentMethodId);
    const outcome = await moveThePostingAccount(w.paymentMethodId, bankAccountId);

    // ── (a) The departure's own text predicts this move SUCCEEDS. On this
    // head it does not. That correction is recorded here as a measurement.
    expect(
      outcome,
      `DEPARTURE B IS NARROWER THAN ITS TEXT. docs/PHASE_4_ARCHITECTURE_LOCK.md says a method's posting_account_id "can still be changed while ` +
        `payments rows reference that method". Measured through the real payment_method_update command, the change is REFUSED. If this ` +
        `assertion has gone red, the move now SUCCEEDS — the edge payments_method_fk (0081:281-284) has been dropped, narrowed, or given ` +
        `ON UPDATE CASCADE — and the integrity half of the lock is GONE. That is not Departure B being closed; it is Departure B being made ` +
        `real. Do not delete this assertion: restore the edge.${WHEN_THIS_GOES_RED}`,
    ).not.toBeNull();
    const refusal = must(outcome, 'the customer-side refusal');

    // ── (b) It is the EDGE that refuses, structurally, and not the guard.
    expect(
      refusal.code,
      `and the refusal is the edge's, SQLSTATE ${FK_VIOLATION}: an UPDATE of payment_methods.posting_account_id dissolves the parent tuple ` +
        `(business, id, old account) that the live payments row depends on, and the default parent-side NO ACTION refuses it. Measured: ` +
        `[${refusal.code ?? 'no code'}] ${refusal.message}${WHEN_THIS_GOES_RED}`,
    ).toBe(FK_VIOLATION);
    expect(
      refusal.message,
      `and it names ${CUSTOMER_EDGE}, so the record points at the constraint that actually answered rather than at a constraint a reader ` +
        `assumed. Measured: ${refusal.message}${WHEN_THIS_GOES_RED}`,
    ).toContain(CUSTOMER_EDGE);

    // ── (c) THE DEPARTURE ITSELF, as what is really left of it: the customer
    // side does NOT get the named refusal the supplier side got one `it` ago.
    expect(
      refusal.message.includes(NAMED_LOCK),
      `THIS IS DEPARTURE B, MEASURED. The customer-side refusal does NOT name ${NAMED_LOCK}: payment_method_guard()'s arm consults only ` +
        `supplier_payments and supplier_refunds, so it passes, and the edge answers afterwards with a raw ${FK_VIOLATION}. A merchant who ` +
        `moves a bank account on a method that has taken supplier money reads a sentence written for them; a merchant who does it on a method ` +
        `that has taken CUSTOMER money reads a foreign-key violation. THIS FILE DOES NOT SAY THAT IS ACCEPTABLE. It says it is what happens. ` +
        `If this assertion has gone red, the arm was extended to consult \`payments\` — Departure B IS CLOSED: delete or invert this ` +
        `assertion and close "Departure B" in docs/PHASE_4_ARCHITECTURE_LOCK.md.${WHEN_THIS_GOES_RED}`,
    ).toBe(false);
    expect(await postingAccount(w.paymentMethodId), 'and the method still posts where it posted before — the attempt was rolled back').toBe(before);
  });

  it('WHY THE SLICE DOCUMENTS INSTEAD OF FIXING: the LIVE guard body consults the two supplier relations and not `payments`, and its digest is pinned', async () => {
    requireSubject(missing, CLAIM);
    // Read from the LIVE catalogue and not from the migration text, because a
    // routine replaced by a later migration is the one that runs. This is the
    // premise the previous `it` rests on, stated separately so that a reader
    // can see it is measured and not assumed.
    const body = must(
      (await ownerPool().query<{ src: string }>(`SELECT p.prosrc AS src FROM pg_proc p WHERE p.proname = 'payment_method_guard'`)).rows[0],
      'the live body of payment_method_guard()',
    ).src;
    expect(body, `NO SUBJECT — the live guard raises no ${NAMED_LOCK} at all, so there is no arm whose reach could be measured`).toContain(NAMED_LOCK);
    for (const relation of ['supplier_payments', 'supplier_refunds'])
      expect(body, `the arm consults ${relation} — the supplier-side half of the lock${WHEN_THIS_GOES_RED}`).toMatch(new RegExp(`FROM ${relation}\\b`));
    expect(
      /FROM payments\b/.test(body),
      `and it does NOT consult \`payments\`. THAT SENTENCE IS DEPARTURE B. This file records it; it does not defend it.${WHEN_THIS_GOES_RED}`,
    ).toBe(false);

    // And the reason a P4-S4 migration may not simply add the relation: the
    // body's SHA-256 is pinned by an accepted Phase 3 routine, so extending
    // the arm means re-recording a pinned digest — cross-phase surface no
    // ruling of this slice covers.
    const pin = await ownerPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_proc p WHERE p.proname = 'supplier_settlement_guard_gaps'
         AND p.prosrc LIKE '%payment_method_guard%'`,
    );
    expect(
      must(pin.rows[0], 'the digest pin').n,
      `NO SUBJECT — supplier_settlement_guard_gaps() does not mention payment_method_guard, so the stated reason this slice may not extend ` +
        `the arm (a pinned body digest, 0067:1801 / 0068:1331) is not actually in the database, and the departure should be re-argued rather ` +
        `than documented.${WHEN_THIS_GOES_RED}`,
    ).toBeGreaterThan(0);
  });

  it('THE BOUND, READ FROM THE JOURNAL: the payment keeps its OWN posting account and its journal entry is untouched by the attempt', async () => {
    requireSubject(missing, CLAIM);
    // This is why the departure is bounded rather than a correctness defect,
    // and it is the one claim a reader must not have to take on trust.
    const pinnedBefore = must(
      (
        await ownerPool().query<{ acct: string }>(`SELECT posting_account_id::text AS acct FROM payments WHERE business_id = $1 AND id = $2`, [
          w.shop.businessId,
          paymentId,
        ])
      ).rows[0],
      `payment ${paymentId}`,
    ).acct;
    const entryBefore = await allocationEntry();
    expect(
      entryBefore.lines.length,
      `NO SUBJECT — the ${ALLOCATION_SOURCE} entry of allocation ${allocationId} has no lines, so "the journal entry is unchanged" would be a ` +
        `claim about an empty set`,
    ).toBeGreaterThan(0);
    expect(
      entryBefore.lines.some((l) => l.accountId === pinnedBefore),
      `and the entry really posts to the account the payment pinned (${pinnedBefore}) — the whole bound is that the money went to the pinned ` +
        `account and stays there. Measured lines: ${JSON.stringify(entryBefore.lines)}${WHEN_THIS_GOES_RED}`,
    ).toBe(true);

    await moveThePostingAccount(w.paymentMethodId, bankAccountId);

    const pinnedAfter = must(
      (
        await ownerPool().query<{ acct: string }>(`SELECT posting_account_id::text AS acct FROM payments WHERE business_id = $1 AND id = $2`, [
          w.shop.businessId,
          paymentId,
        ])
      ).rows[0],
      `payment ${paymentId}`,
    ).acct;
    expect(
      pinnedAfter,
      `the payments row keeps its OWN posting_account_id across the attempt. If this is ever false, a past payment's account moved under it ` +
        `and the departure stopped being a reporting-continuity question.${WHEN_THIS_GOES_RED}`,
    ).toBe(pinnedBefore);

    const entryAfter = await allocationEntry();
    expect(entryAfter.entryId, 'the binding still names the same journal entry').toBe(entryBefore.entryId);
    expect(
      entryAfter.lines,
      `and the entry's lines are IDENTICAL — no posted entry is rewritten by a posting-account change. Before: ` +
        `${JSON.stringify(entryBefore.lines)}; after: ${JSON.stringify(entryAfter.lines)}${WHEN_THIS_GOES_RED}`,
    ).toEqual(entryBefore.lines);
  });
});
