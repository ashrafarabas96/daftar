/**
 * P4-S4 — ONE JOURNAL ENTRY PER ALLOCATION, EACH WITH ITS SOURCE BINDING.
 * (Implementation map §3.1, §3.2; `0042_accounting_journal.sql:273-298`;
 *  `docs/PHASE_4_ARCHITECTURE_LOCK.md` P4-AL-05, P4-AL-16.)
 *
 * ── THE LAW ───────────────────────────────────────────────────────────────
 *
 * Every settlement row — every `payment_allocations` row and every
 * `customer_credit_applications` row — has EXACTLY ONE journal entry, bound to
 * it by its own id; and there is no entry of a settlement source type without
 * a binding, and no binding without an entry. Collapsing the N allocations of
 * one payment into one entry is not expressible: there is nowhere to put the
 * other N−1 source ids.
 *
 * Four mechanisms make it structural on the accepted supplier side, and §3.2
 * asks this slice for the same four:
 *
 *   1. `binding_source_id = id` as a row CHECK — the source id IS the
 *      allocation id, not a free column;
 *   2. the DEFERRED FK from the allocation to the binding — the allocation
 *      cannot commit without an entry;
 *   3. `journal_entries_binding_fk` (`0042:294-298`) — the entry cannot commit
 *      without the binding;
 *   4. the binding PK `(business_id, source_type, source_id)` (`0042:280`) — a
 *      second entry for the same allocation is a primary-key violation — and
 *      `UNIQUE (business_id, journal_entry_id)` (`0042:282`) — one entry
 *      cannot serve two sources.
 *
 * This file asserts the law as a BIJECTION measured out of the catalogue, and
 * then asserts each of the four mechanisms is actually declared, because a
 * bijection that happens to hold on one scenario is not the same claim as a
 * bijection the database cannot break. It is load-bearing for the reversals of
 * a later slice: each allocation already has its own addressable entry.
 *
 * ── EVERY COUNT SAYS WHAT IT IS A COUNT OF ────────────────────────────────
 *
 * Every number below carries a `business_id` predicate. A count with no
 * business predicate is a count over the whole cluster and belongs to nobody's
 * scenario, and this estate runs its suites against a shared cluster.
 *
 * ── RED UNTIL `0081` LANDS ────────────────────────────────────────────────
 *
 * Every `it` requires its subject first, so while the relations, the routines,
 * the source types and the routes do not exist this file is RED naming them,
 * never vacuously green. No `.skip`, no `.todo`, no conditional pass.
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { requireSubject } from '../golden-regression/phase4-s2/harness';
import { entryLines, entryOfSource, must } from '../golden-regression/phase4-s4/harness';
import {
  appliedTotal,
  collectPayment,
  CREDIT_SOURCE_TYPE,
  INVOICE_SETTLING_SOURCE_TYPES,
  S4_SOURCE_TYPES,
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

const CLAIM = 'one journal entry per allocation, each with its source binding, and no entry without a binding nor binding without an entry';

let w: SettlementWorld;
let missing: readonly string[] = [];
let res: Response;
let paymentId: string;
let creditId: string;
let invoices: readonly OpenInvoice[] = [];

/** One `(source_type, source_id, journal_entry_id)` triple of this business. */
interface Binding {
  readonly source_type: string;
  readonly source_id: string;
  readonly journal_entry_id: string;
}

async function settlementBindings(): Promise<readonly Binding[]> {
  const r = await ownerPool().query<Binding>(
    `SELECT b.source_type, b.source_id::text AS source_id, b.journal_entry_id::text AS journal_entry_id
       FROM accounting_source_bindings b
      WHERE b.business_id = $1 AND b.source_type = ANY ($2)
      ORDER BY b.source_type, b.source_id`,
    [w.shop.businessId, [...S4_SOURCE_TYPES]],
  );
  return r.rows;
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  w = await settlementWorld('s4binding');
  missing = await settlementMissing(w);
  if (missing.length > 0) return;

  await stockUp(w, '100', '5');
  const customer = await newCustomer(w);
  // THREE invoices on ONE payment, deliberately. With one allocation the
  // bijection and a "one entry per payment" implementation are
  // indistinguishable; with three they are not, and three is also what makes
  // `UNIQUE (business_id, journal_entry_id)` do any work.
  const i1 = await sellOnCredit(w, customer, '2');
  const i2 = await sellOnCredit(w, customer, '3');
  const i3 = await sellOnCredit(w, customer, '4');
  invoices = [i1, i2, i3];
  const legs: AllocationInput[] = invoices.map((inv) => ({
    invoiceId: inv.invoiceId,
    appliedMinor: inv.totalTxnMinor,
    releasedBeforeMinor: '0',
    invoiceTotalTxnMinor: inv.totalTxnMinor,
    invoiceTotalBaseMinor: inv.totalBaseMinor,
  }));
  paymentId = randomUUID();
  // AND a surplus, so the payment also brings a `customer_credit` into
  // existence. The third source type is forced (a zero-allocation payment has
  // no allocation entry for the surplus leg to ride on, and the completeness
  // validator pins an allocation entry's line multiset exactly), so the
  // bijection must be proved over all THREE source types — including the one
  // whose entry carries no receivable.
  creditId = randomUUID();
  res = await collectPayment(w.t, w.headers, {
    paymentId,
    customerId: customer,
    paymentMethodId: w.paymentMethodId,
    paymentDate: w.day,
    creditId,
    amountMinor: (appliedTotal(legs) + 913n).toString(),
    allocations: legs,
  });
}, 300_000);

afterAll(async () => {
  await w?.t?.close();
  await resetData();
});

describe('P4-S4 one journal entry per allocation, bound by the allocation’s own id', () => {
  it('the subject exists: the settlement relations, the commands, the source types, the seam and the routes', () => {
    requireSubject(missing, CLAIM);
  });

  it('one payment across THREE invoices is accepted and wrote three allocation rows', async () => {
    requireSubject(missing, CLAIM);
    expect(res.status, `the collection commits: ${JSON.stringify(res.body)}`).toBeLessThan(300);
    const r = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM payment_allocations WHERE business_id = $1 AND payment_id = $2`, [
      w.shop.businessId,
      paymentId,
    ]);
    expect(must(r.rows[0]).n, 'three legs were stated, so three allocation rows of THIS payment of THIS business exist').toBe(3);
  });

  it('every allocation of the business has exactly one entry, bound by its OWN id', async () => {
    requireSubject(missing, CLAIM);
    const r = await ownerPool().query<{ id: string; binding_source_id: string; source_type: string; entries: number }>(
      `SELECT a.id::text AS id, a.binding_source_id::text AS binding_source_id, a.accounting_source_type AS source_type,
              (SELECT count(*)::int FROM accounting_source_bindings b
                WHERE b.business_id = a.business_id AND b.source_type = a.accounting_source_type AND b.source_id = a.binding_source_id) AS entries
         FROM payment_allocations a WHERE a.business_id = $1 ORDER BY a.id`,
      [w.shop.businessId],
    );
    expect(r.rows.length, 'NO SUBJECT — this business has no allocation, so the bijection is asserted over nothing').toBeGreaterThan(0);
    for (const row of r.rows) {
      expect(
        row.binding_source_id,
        `the allocation's source id IS its own id (the row CHECK of map §3.2): allocation ${row.id} binds ${row.binding_source_id}, and a ` +
          `free binding column is a place to collapse N allocations into one entry`,
      ).toBe(row.id);
      expect(row.entries, `allocation ${row.id} (${row.source_type}) has exactly one journal entry — not zero, not two`).toBe(1);
    }
  });

  it('no binding of a settlement source type lacks its entry, and no settlement entry lacks its binding', async () => {
    requireSubject(missing, CLAIM);
    const bindings = await settlementBindings();
    expect(
      bindings.length,
      `NO SUBJECT — this business holds no binding of the source types ${S4_SOURCE_TYPES.join(' / ')}, so neither direction of the law ` +
        `has anything to be true of`,
    ).toBeGreaterThan(0);

    // Direction 1: every binding's entry exists, is of the same source type
    // and names the same source id. The binding and the entry each carry the
    // pair, and the two deferred FKs of `0042:287-298` are what make them
    // agree; this measures that they do.
    const orphanBindings = await ownerPool().query<{ source_id: string; source_type: string }>(
      `SELECT b.source_id::text AS source_id, b.source_type
         FROM accounting_source_bindings b
        WHERE b.business_id = $1 AND b.source_type = ANY ($2)
          AND NOT EXISTS (SELECT 1 FROM journal_entries e
                           WHERE e.business_id = b.business_id AND e.id = b.journal_entry_id
                             AND e.source_type = b.source_type AND e.source_id = b.source_id)`,
      [w.shop.businessId, [...S4_SOURCE_TYPES]],
    );
    expect(orphanBindings.rows, 'no binding of this business points at an entry that is absent or disagrees about its source').toEqual([]);

    // Direction 2: every settlement entry has its binding. An entry nobody can
    // address is an entry no reversal can ever find.
    const orphanEntries = await ownerPool().query<{ id: string; source_type: string; source_id: string }>(
      `SELECT e.id::text AS id, e.source_type, e.source_id::text AS source_id
         FROM journal_entries e
        WHERE e.business_id = $1 AND e.source_type = ANY ($2)
          AND NOT EXISTS (SELECT 1 FROM accounting_source_bindings b
                           WHERE b.business_id = e.business_id AND b.source_type = e.source_type AND b.source_id = e.source_id
                             AND b.journal_entry_id = e.id)`,
      [w.shop.businessId, [...S4_SOURCE_TYPES]],
    );
    expect(orphanEntries.rows, 'no settlement entry of this business is unbound').toEqual([]);
  });

  it('and the entries are DISTINCT: three allocations of one payment are three entries, never one', async () => {
    requireSubject(missing, CLAIM);
    const r = await ownerPool().query<{ allocations: number; entries: number }>(
      `SELECT count(*)::int AS allocations, count(DISTINCT b.journal_entry_id)::int AS entries
         FROM payment_allocations a
         JOIN accounting_source_bindings b
           ON b.business_id = a.business_id AND b.source_type = a.accounting_source_type AND b.source_id = a.binding_source_id
        WHERE a.business_id = $1 AND a.payment_id = $2`,
      [w.shop.businessId, paymentId],
    );
    const row = must(r.rows[0], 'the allocation/entry census of this payment');
    expect(row.allocations, 'NO SUBJECT — the payment has no allocation to count entries for').toBeGreaterThan(1);
    expect(
      row.entries,
      `${row.allocations} allocations of one payment must have ${row.allocations} DISTINCT journal entries, measured ${row.entries}. ` +
        `A collapsed entry is an allocation no later reversal can address (map §3.2).`,
    ).toBe(row.allocations);
  });

  it('each allocation’s entry moves the receivable, and its lines balance in base minor units', async () => {
    requireSubject(missing, CLAIM);
    const bindings = await settlementBindings();
    expect(bindings.length, 'NO SUBJECT — no settlement binding to read lines through').toBeGreaterThan(0);
    for (const b of bindings) {
      const lines = await entryLines(ownerPool(), w.shop.businessId, b.journal_entry_id);
      const shown = JSON.stringify(lines.map((l) => ({ key: l.systemKey, d: l.debitMinor.toString(), c: l.creditMinor.toString() })));
      // The count is asserted BEFORE the sum. `sum()` over no rows is NULL and
      // FORCE RLS can make a reader see nothing and report the loudest
      // possible pass — the non-vacuity canary `accounting_invoice_entry_complete`
      // adds for exactly this reason (`0077:1461-1474`, map §3.4).
      expect(lines.length, `the entry ${b.journal_entry_id} of ${b.source_type} ${b.source_id} has lines: ${shown}`).toBeGreaterThan(1);
      const balance = lines.reduce((acc, l) => acc + l.debitMinor - l.creditMinor, 0n);
      expect(balance.toString(), `the entry ${b.journal_entry_id} balances in base minor units: ${shown}`).toBe('0');
      // The receivable law is quantified over the INVOICE-SETTLING source
      // types and not over all three. `customer_credit` is an accounting
      // source but not a settler: a credit coming into existence moves money
      // from the till to a liability and touches no receivable, so a law that
      // demanded an AR line of it would be false of it — and the fix would
      // have been to weaken the law rather than to name the set properly.
      if (INVOICE_SETTLING_SOURCE_TYPES.includes(b.source_type as (typeof INVOICE_SETTLING_SOURCE_TYPES)[number]))
        expect(
          lines.map((l) => l.systemKey),
          `a settlement of an invoice releases the receivable, so its entry carries an accounts_receivable line. Measured: ${shown}`,
        ).toContain('accounts_receivable');
      else
        expect(
          lines.map((l) => l.systemKey).filter((k) => k !== null),
          `the surplus leg of a ${b.source_type} entry touches the method's posting account and customer_credit_liability ONLY: nothing is ` +
            `owed to anyone yet, so no receivable moves. Measured: ${shown}`,
        ).toContain('customer_credit_liability');
    }
    // Non-vacuity of the split itself: if no binding of either kind were
    // present, the branch above would have asserted nothing about either.
    const kinds = new Set(bindings.map((b) => b.source_type));
    expect(
      [...kinds].sort(),
      `NO SUBJECT for the split — this business must hold a binding of an invoice-settling source AND one of ${CREDIT_SOURCE_TYPE}, or ` +
        `one of the two branches above ran zero times. Measured: ${JSON.stringify([...kinds])}`,
    ).toEqual([...S4_SOURCE_TYPES].filter((t) => kinds.has(t)).sort());
    expect(kinds.has(CREDIT_SOURCE_TYPE), `NO SUBJECT — no ${CREDIT_SOURCE_TYPE} binding exists, so the non-settling branch proved nothing`).toBe(true);
    expect(
      [...kinds].some((k) => INVOICE_SETTLING_SOURCE_TYPES.includes(k as (typeof INVOICE_SETTLING_SOURCE_TYPES)[number])),
      'NO SUBJECT — no invoice-settling binding exists, so the receivable branch proved nothing',
    ).toBe(true);
  });

  it('`entryOfSource` finds each allocation’s entry through the binding and never by position', async () => {
    requireSubject(missing, CLAIM);
    const r = await ownerPool().query<{ id: string; source_type: string }>(
      `SELECT id::text AS id, accounting_source_type AS source_type FROM payment_allocations WHERE business_id = $1 AND payment_id = $2 ORDER BY line_no`,
      [w.shop.businessId, paymentId],
    );
    expect(r.rows.length, 'NO SUBJECT — no allocation to look an entry up for').toBeGreaterThan(0);
    const found: string[] = [];
    for (const row of r.rows) {
      const entry = await entryOfSource(ownerPool(), w.shop.businessId, row.source_type, row.id);
      expect(entry, `allocation ${row.id} of source type ${row.source_type} is addressable through its binding`).not.toBeNull();
      found.push(must(entry, 'the bound entry'));
    }
    expect(new Set(found).size, `the ${found.length} allocations resolve to ${new Set(found).size} distinct entries`).toBe(found.length);
  });

  it('and a settlement entry touches only the closed set of settlement accounts: each dust rides on its own principal account', async () => {
    requireSubject(missing, CLAIM);
    // THE DUST RULE, as the coordinator's second correction states it: a
    // credit application carries TWO dusts, each a second line on its own
    // PRINCIPAL account — the credit dust on `customer_credit_liability`
    // (2210) and the AR dust on `accounts_receivable` — exactly as the
    // accepted supplier path puts each dust on the same account as its
    // principal (`packages/inventory/src/supplier-settlement.ts:259-280`).
    // There is no write-off, no `rounding_difference_minor` column and no
    // 6100 line anywhere in the settlement path.
    //
    // Asserted as the CLOSED ACCOUNT SET rather than as the presence of a dust
    // line, because a dust line only exists when the dust is non-zero and
    // these fixtures settle at rate 1. What the law then owes is that no
    // settlement entry may reach for a FOURTH account when a figure does not
    // divide: the set is `accounts_receivable | customer_credit_liability |
    // fx_gain | fx_loss | the method's posting account`, which is the mirror
    // of `SettlementAccount` (`supplier-settlement.ts:224-225`), whose comment
    // says "never 6100 (rounding), 6200 or tax".
    const r = await ownerPool().query<{ entry_id: string; source_type: string; account_id: string; system_key: string | null; code: string }>(
      `SELECT e.id::text AS entry_id, e.source_type, l.account_id::text AS account_id, a.system_key::text AS system_key, a.code
         FROM journal_entries e
         JOIN journal_lines l ON l.business_id = e.business_id AND l.journal_entry_id = e.id
         JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
        WHERE e.business_id = $1 AND e.source_type = ANY ($2)`,
      [w.shop.businessId, [...S4_SOURCE_TYPES]],
    );
    expect(r.rows.length, `NO SUBJECT — this business holds no line on any entry of ${S4_SOURCE_TYPES.join(' / ')}`).toBeGreaterThan(0);
    const permitted = new Set(['accounts_receivable', 'customer_credit_liability', 'fx_gain', 'fx_loss']);
    const offenders = r.rows.filter((x) => !(x.system_key !== null && permitted.has(x.system_key)) && x.account_id !== w.postingAccountId);
    expect(
      offenders.map((x) => `${x.source_type} entry ${x.entry_id} on ${x.system_key ?? x.code}`),
      `a settlement entry may post only to accounts_receivable, customer_credit_liability, fx_gain, fx_loss or the method's own posting ` +
        `account (${w.postingAccountId}). Dust is a second line on its own principal account, never a write-off, and the rounding account ` +
        `(6100), 6200 and tax are unreachable from here.`,
    ).toEqual([]);
  });

  // ── the four mechanisms are DECLARED, not merely satisfied ────────────

  it('the binding-identity CHECK, the two deferred FKs and the binding PK are all declared on the settlement relations', async () => {
    requireSubject(missing, CLAIM);
    const r = await ownerPool().query<{ relation: string; conname: string; contype: string; deferred: boolean; def: string }>(
      `SELECT cl.relname AS relation, c.conname, c.contype::text AS contype, c.condeferred AS deferred, pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE n.nspname = 'public' AND cl.relname = ANY ($1)
        ORDER BY 1, 2`,
      [['payment_allocations', 'customer_credit_applications', 'customer_credits']],
    );
    expect(r.rows.length, 'NO SUBJECT — no settlement relation carries a constraint, so there is no mechanism to read').toBeGreaterThan(0);
    // All THREE accounting sources, not just the two settlers: the credit is a
    // source in its own right, so it owes the same binding identity CHECK and
    // the same deferred edge. A source that owed neither could be written
    // without an entry.
    for (const relation of ['payment_allocations', 'customer_credit_applications', 'customer_credits']) {
      const own = r.rows.filter((x) => x.relation === relation);
      expect(own.length, `NO SUBJECT — ${relation} carries no constraint`).toBeGreaterThan(0);
      const shown = JSON.stringify(own.map((x) => ({ name: x.conname, def: x.def, deferred: x.deferred })));
      expect(
        own.some((x) => x.contype === 'c' && /binding_source_id\s*=\s*id/.test(x.def)),
        `${relation} must carry the row CHECK that its binding source id IS its own id (map §3.2 mechanism 1). Measured: ${shown}`,
      ).toBe(true);
      expect(
        own.some((x) => x.contype === 'f' && x.deferred && /accounting_source_bindings/.test(x.def)),
        `${relation} must carry a DEFERRABLE INITIALLY DEFERRED foreign key to accounting_source_bindings, so a settlement row cannot ` +
          `commit without its entry (mechanism 2). Measured: ${shown}`,
      ).toBe(true);
    }
    // Mechanism 3 and 4 are on the ACCEPTED accounting relations and are
    // asserted so that a later migration cannot quietly weaken the half of the
    // law this slice leans on.
    const journal = await ownerPool().query<{ conname: string; deferred: boolean; def: string }>(
      `SELECT c.conname, c.condeferred AS deferred, pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE n.nspname = 'public' AND cl.relname = ANY ($1) ORDER BY 1`,
      [['journal_entries', 'accounting_source_bindings']],
    );
    expect(
      journal.rows.some((x) => x.conname === 'journal_entries_binding_fk' && x.deferred),
      `journal_entries must still carry its deferred binding FK (0042:294-298, mechanism 3): ${JSON.stringify(journal.rows.map((x) => x.conname))}`,
    ).toBe(true);
    expect(
      journal.rows.some((x) => /PRIMARY KEY \(business_id, source_type, source_id\)/.test(x.def)),
      `accounting_source_bindings must still key on (business_id, source_type, source_id) (0042:280, mechanism 4), so a second entry for one ` +
        `allocation is a primary-key violation: ${JSON.stringify(journal.rows.map((x) => x.def))}`,
    ).toBe(true);
    expect(
      journal.rows.some((x) => /UNIQUE \(business_id, journal_entry_id\)/.test(x.def)),
      `and on (business_id, journal_entry_id) (0042:282), so one entry cannot serve two sources: ${JSON.stringify(journal.rows.map((x) => x.def))}`,
    ).toBe(true);
  });
});
