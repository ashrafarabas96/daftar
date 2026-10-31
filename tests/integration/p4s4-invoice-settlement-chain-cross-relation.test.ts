/**
 * P4-S4 — THE CHAIN LAW ACROSS THE TWO REDUCER RELATIONS.
 * (DR-72. `0081:327-333` and `0081:473-476`; the chain itself is
 *  `invoice_settlement_verify` at `0081:691`, reached from
 *  `payment_allocation_value_complete` at `0081:1060` `at PERFORM`.)
 *
 * ── THE HOLE THIS FILE COVERS, AND WHY NOTHING ELSE COVERS IT ─────────────
 *
 * Both settling relations carry a per-relation level `UNIQUE` on
 * `(business_id, invoice_id, ar_released_before_txn_minor)`, and
 * `p4s4-invoice-settlement-chain.test.ts:318` already proves that a second row
 * at one position WITHIN `payment_allocations` is refused `23505` by that
 * index. The schema states the limit of that index in its own words
 * (`0081:327-333`):
 *
 *   «a UNIQUE index cannot see across `payment_allocations` and
 *    `customer_credit_applications`, which can each occupy the same level, so
 *    the cross-relation guarantee rests on `invoice_settlement_verify`.»
 *
 * So the cross-relation case has NO index behind it. One payment allocation
 * and one credit application of the same invoice, both computed from the same
 * chain position, collide on no key in either relation, and the ONLY thing in
 * the estate that refuses them is the chain inside
 * `invoice_settlement_verify`. This file is that law.
 *
 * ── WHAT THE REFUSED STATE IS ─────────────────────────────────────────────
 *
 * The attack is not an over-settlement. The two reducers apply `a₁` and `a₂`
 * with `a₁ + a₂ = T`, so every AGGREGATE reads perfectly closed:
 *
 *     Σa = T          and          Σrel = HALF_EVEN(B·Σa, T) = B   (at Σa = T)
 *
 * and therefore `invoice_outstanding` returns `0` in BOTH currencies. The
 * invoice looks paid. What is false is the HISTORY: both reducers claim that
 * nothing had been released before them, so the same `a₁` of the invoice is
 * released twice and the other `a₂` of it never is. The only term of the law
 * that can see this is the per-row recurrence `h.x <> h.before`
 * (`0081:770-772`), and this file measures that the cumulative identity is
 * BLIND to it on this head — see the last case, which proves the identity has
 * teeth where `B ≠ T` and measures that on this head it cannot.
 *
 * ── WHY THE LAW IS FORCED BY NAME AND NOT WITH `ALL` ──────────────────────
 *
 * The two `value_complete` triggers are `DEFERRABLE INITIALLY DEFERRED`, so a
 * violation planted in a transaction that is rolled back NEVER REACHES THE
 * CHECK: the write is accepted, the invoice reads `outstanding = 0`, and
 * nothing is raised at all. That is measured here as its own case, because it
 * is the reason every refusal below forces the constraint rather than trusting
 * the plant to speak.
 *
 * It is forced BY NAME because `payment_allocations_binding_fk` is deferred
 * too (measured below), and a planted allocation has no
 * `accounting_source_bindings` row — no command wrote it a journal entry — so
 * `SET CONSTRAINTS ALL IMMEDIATE` would let a FOREIGN KEY answer in place of
 * the law. Forcing the settlement trigger by name leaves the binding FK
 * deferred and makes the chain the next thing that can speak. That the law and
 * not something else is what spoke is then proved by the pair of cases below:
 * the SAME plant with the LAWFUL position is ACCEPTED through the SAME forced
 * trigger. One integer differs between the two, so no foreign key, no missing
 * seed row and no guard can account for the refusal.
 *
 * Every `it` requires its subject first. No `.skip`, no `.todo`, no
 * conditional pass; every count carries a `business_id` predicate; every
 * planted row runs inside a transaction that is ALWAYS rolled back.
 */
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { ownerClient } from '../helpers/stock-ledger';
import { requireSubject } from '../golden-regression/phase4-s2/harness';
import {
  chainBreaks,
  chainTotals,
  cloneRow,
  deferredVerifierWiring,
  derivedRead,
  inRolledBackTx,
  invoiceChain,
  must,
  plantSettlementRow,
  raised,
  type Queryable,
} from '../golden-regression/phase4-s4/harness';
import { applyCredit, collectPayment, CHAIN, ROUTINES, type AllocationInput } from '../golden-regression/phase4-s4/settlement-path';
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
  'two reducers of one invoice computed from the same chain position are refused even when one is a payment allocation and the other a credit application, which no per-relation UNIQUE can see';

/**
 * The refusal this law answers with. It is a literal here, so the case below
 * ALSO asserts that this exact token appears in the LIVE body of
 * `invoice_settlement_verify`: the day the migration renames the refusal, this
 * file fails loudly instead of passing on a string nothing raises any more.
 */
const CHAIN_REFUSAL = 'invoice_settlement.settlement_inconsistent';
/** The constraint trigger that carries the law, forced by name. */
const SETTLEMENT_TRIGGER = 'payment_allocations_value_complete';
/** Deferred too, and the reason `ALL` is not what gets forced. */
const BINDING_FK = 'payment_allocations_binding_fk';

let w: SettlementWorld;
let missing: readonly string[] = [];

/** The twin that is settled LAWFULLY across both relations: the positive control. */
let lawful: OpenInvoice | undefined;
/** The twin that is settled HALF way, and which the planted row then attacks. */
let attacked: OpenInvoice | undefined;
/** `a₁`, applied by the credit application at position 0 on BOTH twins. */
let a1 = 0n;
/** `a₂ = T − a₁`, applied by the payment allocation: at `a₁` on the lawful twin, at `0` by the plant. */
let a2 = 0n;
/** The lawful payment allocation on the lawful twin, which every plant below is cloned from. */
let sourceAllocationId: string | undefined;

function leg(inv: OpenInvoice, appliedMinor: bigint, releasedBefore: bigint): AllocationInput {
  return {
    invoiceId: inv.invoiceId,
    appliedMinor: appliedMinor.toString(),
    releasedBeforeMinor: releasedBefore.toString(),
    invoiceTotalTxnMinor: inv.totalTxnMinor,
    invoiceTotalBaseMinor: inv.totalBaseMinor,
  };
}

/** The live `sha256` of a routine's `pg_get_functiondef`, which is how «unchanged» is proved of a database object. */
async function routineDigest(q: Queryable, name: string): Promise<string> {
  const r = await q.query<{ digest: string }>(
    `SELECT encode(sha256(pg_get_functiondef(p.oid)::text::bytea), 'hex') AS digest
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = $1`,
    [name],
  );
  return must(r.rows[0], `the live definition of ${name}`).digest;
}

/** The live body of a routine, read from the catalogue and never out of a migration file. */
async function routineBody(q: Queryable, name: string): Promise<string> {
  const r = await q.query<{ body: string }>(
    `SELECT pg_get_functiondef(p.oid) AS body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = $1`,
    [name],
  );
  return must(r.rows[0], `the live body of ${name}`).body;
}

/**
 * Plant ONE payment allocation on the attacked twin, cloned from the lawful
 * twin's accepted allocation with the named overrides, then force the
 * settlement trigger BY NAME and report what it raised.
 *
 * The clone keeps the amount, the currencies, the rates, the payment's base
 * amount, the dust and the realized FX of an ACCEPTED row, so the per-row
 * identities of `payment_allocation_value_complete` (`0081:1049-1057`) are
 * satisfied and the chain is the next thing that can speak. Everything runs in
 * a transaction that is always rolled back.
 */
async function plantOnAttacked(overrides: Readonly<Record<string, string | number | null>>): Promise<{
  readonly insertError: { readonly message: string; readonly code: string | undefined } | null;
  readonly forced: { readonly message: string; readonly code: string | undefined } | null;
  /**
   * `relation@position+applied` per step, SORTED.
   *
   * Sorted because the two rows of the attack SHARE a position and
   * `invoiceChain` orders by the position alone, so the order the union
   * happened to return is not a property of the estate. The law's own
   * `ORDER BY d.x, d.amount` (`0081:766`) breaks the tie inside the database;
   * a suite that asserted the order it saw out here would be asserting how a
   * `UNION ALL` was planned.
   */
  readonly positions: readonly string[];
  readonly applied: bigint;
  readonly released: bigint;
  readonly breaks: readonly { readonly kind: string; readonly actualPosition: string }[];
  readonly read: { readonly outstandingTxnMinor: bigint; readonly outstandingBaseMinor: bigint; readonly state: string } | null;
}> {
  const target = must(attacked, 'the attacked twin');
  const source = must(sourceAllocationId, 'the lawful allocation every plant is cloned from');
  return inRolledBackTx(
    () => ownerClient(),
    w.shop,
    async (c) => {
      const newId = randomUUID();
      // The INSERT is reported separately from the forced check. A plant that
      // died on insertion never reached the law, and a case that conflated the
      // two would read «something refused me» as «the chain refused me».
      const insertError = await raised(() =>
        plantSettlementRow(c, 'payment_allocations', w.shop.businessId, source, { id: newId, binding_source_id: newId, ...overrides }),
      );
      if (insertError !== null) return { insertError, forced: null, positions: [], applied: 0n, released: 0n, breaks: [], read: null };
      // Measured BEFORE the force, because after a refusal the transaction is
      // aborted and nothing can be read out of it.
      const chain = await invoiceChain(c, w.shop.businessId, target.invoiceId);
      const totals = chainTotals(chain);
      const positions = chain.map((s) => `${s.relation}@${s.positionMinor}+${s.appliedMinor}`).sort();
      const breaks = chainBreaks(chain).map((b) => ({ kind: b.kind, actualPosition: b.actualPosition }));
      const forced = await raised(() => c.query(`SET CONSTRAINTS ${SETTLEMENT_TRIGGER} IMMEDIATE`));
      // Readable only when the force did NOT refuse: that is the whole point
      // of the negative control and of the acceptance case.
      const read = forced === null ? await derivedRead(c, w.shop.businessId, target.invoiceId) : null;
      return {
        insertError,
        forced,
        positions,
        applied: totals.applied,
        released: totals.released,
        breaks,
        read: read === null ? null : { outstandingTxnMinor: read.outstandingTxnMinor, outstandingBaseMinor: read.outstandingBaseMinor, state: read.state },
      };
    },
  );
}

/* ── DR-73 §2 — THE CONSERVATION ARM, EXERCISED LIVE ───────────────────────
 *
 * The chain law's final `IF` (`0081:787-789`) is a disjunction of THREE terms,
 * and every case above exercises only the first:
 *
 *   (1) `v_bad > 0` — the per-row count, itself two things: the recurrence
 *       `h.x <> h.before` (with the per-row over-total), and, in the CASE's
 *       ELSE, the per-row release `h.rel <> supplier_ap_release(B, T, x, a)`;
 *   (2) `v_sum > T` — the aggregate over-settlement;
 *   (3) `v_rel <> inventory_half_even(B::numeric * v_sum, T, 0)` — THE
 *       CONSERVATION IDENTITY, which is what the cases below reach.
 *
 * The refusal above is caught by the recurrence, and the identity is SATISFIED
 * in that write — the case says so in its own words. So term (3) had never
 * refused a row at all. These cases make it do so, on an invoice where it is
 * not a tautology.
 *
 * ── WHY THE INVOICE IS SEEDED AND NOT COMMANDED ───────────────────────────
 *
 * A product's price currency is pinned to the business base currency, so every
 * invoice any command can create carries `rate_source = 'base'`,
 * `source_to_base_rate = 1` and therefore `B = T` — measured in the last case
 * of this file, over this business's own rows. At `B = T`,
 * `supplier_ap_release(T, T, X, a) = a` identically, so `Σrel = Σa` for ANY
 * positions and term (3) is a restatement of term (1) rather than a statement
 * of its own. An invoice with `B ≠ T` is therefore SEEDED here, directly, as
 * the plants above are seeded — and `invoices_rate_shape_ck` (`0075:295`)
 * fixes what such a seed must carry TOGETHER: a `rate_source` other than
 * `'base'`, a real `fx_rate_id`, and `source_to_base_rate <> 1`.
 *
 * The seed is a CLONE of an accepted invoice that departs from it in the rate
 * pair and in the keys that must be unique, so it satisfies every other CHECK
 * of `invoices` rather than failing the first of them. It is denominated in a
 * catalogue currency that is not the base currency and carries the same minor
 * units, and its `total_base_minor` is computed by `supplier_convert_base` —
 * the estate's own 0043 conversion law — from its total and its rate. So `B`
 * is the conversion of `T` at the rate the row carries, which is what a
 * cross-currency invoice IS, and not a number picked to make a test go red.
 *
 * ── WHAT IS NOT CLAIMED ───────────────────────────────────────────────────
 *
 * Term (3) cannot be made to refuse ALONE, and that is measured below rather
 * than argued. `supplier_ap_release` is exactly `R(X+a) − R(X)` for
 * `R(y) = HALF_EVEN(B·y, T, 0)` (`0067:683-694`), so when the positions chain
 * from zero and every row's release is its own, the per-row releases TELESCOPE
 * to `R(Σa)` — which is the identity's own value. Hence identity broken AND
 * positions chaining implies some row's release is wrong, which is term (1)
 * broken too. Term (3) is a REDUNDANT term. The cases below therefore prove
 * which term spoke by knocking the others OUT of the live body, instead of
 * asserting an attribution the refusal itself cannot carry.
 */

/** Not 1, so `B ≠ T`; and not a whole multiple, so `HALF_EVEN` is doing work. */
const SEEDED_RATE = '3.6723';

/**
 * The two independent terms of the chain law, as they stand in the LIVE body.
 *
 * Quoted from the catalogue and never re-implemented: each knockout below
 * removes one of these from `pg_get_functiondef`'s OWN text and runs the
 * result, so every term that REMAINS is the shipped term, character for
 * character. Each is asserted to occur EXACTLY ONCE before anything is
 * replaced — a substring that matched twice, or not at all, would make the
 * surgery something other than the removal of the one named term.
 */
const PER_ROW_TERMS = 'v_bad > 0 OR v_sum > v_i.total_txn_minor';
const CONSERVATION_TERM = 'v_rel <> inventory_half_even(v_i.total_base_minor::numeric * v_sum, v_i.total_txn_minor, 0)';

/** A seeded `B ≠ T` invoice, with the estate's own figures for the chain that settles it. */
interface CrossRateSeed {
  readonly invoiceId: string;
  readonly currency: string;
  /** `T`, carried over from the cloned invoice so `invoices_total_ck` still holds of its lines. */
  readonly totalTxnMinor: bigint;
  /** `B = supplier_convert_base(T, rate)`, computed by the database. */
  readonly totalBaseMinor: bigint;
  /** `rel(B,T,0,a₁)` — the credit application's own release. */
  readonly relAtZero: bigint;
  /** `rel(B,T,a₁,a₂)` — the payment allocation's own release. */
  readonly relAtA1: bigint;
  /** `conv_R(a₁)` and `conv_R(a₂)`, which are the two rows' dust. */
  readonly convA1: bigint;
  readonly convA2: bigint;
}

/**
 * Seed a schema-lawful `B ≠ T` invoice inside the caller's transaction.
 *
 * Nothing here is committed: the caller runs in `inRolledBackTx`, so the
 * DEFERRED binding foreign keys of `sales`, `invoices`, `customer_credits` and
 * `customer_credit_applications` — none of which has an
 * `accounting_source_bindings` row, because no command wrote any of these —
 * never fire, exactly as every plant above relies on. Only
 * `payment_allocations_value_complete` is ever forced, and it is forced BY
 * NAME.
 */
async function seedCrossRateInvoice(c: Client): Promise<CrossRateSeed> {
  const bid = w.shop.businessId;
  const source = must(attacked, 'the twin the seed is cloned from');
  const src = must(
    (
      await c.query<{ t: string; period: string; sale: string; mode: string; binding: string | null; creator: string }>(
        `SELECT i.total_txn_minor::text AS t, i.period, i.sale_id::text AS sale, s.settlement_mode AS mode,
                s.binding_source_id::text AS binding, i.created_by::text AS creator
           FROM invoices i JOIN sales s ON s.business_id = i.business_id AND s.id = i.sale_id
          WHERE i.business_id = $1 AND i.id = $2`,
        [bid, source.invoiceId],
      )
    ).rows[0],
    `the cloned invoice ${source.invoiceId} and its sale`,
  );
  // R-89: a cash-settled invoice is refused BY NAME before the chain is ever
  // computed, so a seed cloned from one would be refused by the wrong law.
  if (src.mode === 'cash')
    throw new Error('the cloned sale settles in cash, so invoice_settlement_verify would refuse the seed by the CASH law and never reach the chain');

  // A catalogue currency that is not the base one and carries the SAME minor
  // units: equal exponents keep `supplier_convert_base`'s power-of-ten scaling
  // out of every figure, so the rate is the only reason B differs from T.
  const ccy = must(
    (
      await c.query<{ code: string }>(
        `SELECT x.code FROM currencies x, businesses b, currencies base
          WHERE b.id = $1 AND base.code = b.base_currency AND x.code <> b.base_currency AND x.minor_units = base.minor_units
          ORDER BY x.code LIMIT 1`,
        [bid],
      )
    ).rows[0],
    'a catalogue currency that is not the base currency and carries its minor units',
  ).code;

  // The rate row the shape CHECK demands. `accounting_fx_rates` holds no row of
  // this business, so there is nothing to clone and the column list is written
  // out; `source` is CHECK-pinned to exactly 'manual' and the pair must be
  // distinct, and this is the pair the seeded invoice is actually converted at.
  const rateId = randomUUID();
  await c.query(
    `INSERT INTO accounting_fx_rates (tenant_id, business_id, id, from_currency, to_currency, rate, source, effective_at, entered_by_user_id, created_at)
     SELECT b.tenant_id, b.id, $2, $3, b.base_currency, $4::numeric, 'manual', date_trunc('second', now()), $5, now()
       FROM businesses b WHERE b.id = $1`,
    [bid, rateId, ccy, SEEDED_RATE, src.creator],
  );

  // `invoices_sale_uq` forbids a second invoice of one sale, so the seed owns a
  // sale of its own — a clone, which keeps the settlement mode the chain law
  // reads and every CHECK of `sales` that has nothing to do with this law.
  const saleId = randomUUID();
  await cloneRow(c, 'sales', bid, src.sale, src.binding === null ? { id: saleId } : { id: saleId, binding_source_id: saleId });

  const invoiceId = randomUUID();
  const seq = must(
    (
      await c.query<{ n: string }>(
        `SELECT (coalesce(max(number_seq), 0) + 1)::text AS n FROM invoices WHERE business_id = $1 AND document_kind = 'invoice' AND period = $2`,
        [bid, src.period],
      )
    ).rows[0],
    'the next free ordinal of this series',
  ).n;
  const converted = must(
    (
      await c.query<{ b: string }>(
        `SELECT supplier_convert_base($1::bigint, $2::numeric, x.minor_units, base.minor_units)::text AS b
           FROM currencies x, businesses b, currencies base
          WHERE b.id = $3 AND base.code = b.base_currency AND x.code = $4`,
        [src.t, SEEDED_RATE, bid, ccy],
      )
    ).rows[0],
    'the invoice total converted to base by the estate’s own 0043 law',
  ).b;
  await cloneRow(c, 'invoices', bid, source.invoiceId, {
    id: invoiceId,
    sale_id: saleId,
    binding_source_id: invoiceId,
    document_number: `XR-${invoiceId.slice(0, 13)}`,
    number_seq: seq,
    currency_code: ccy,
    rate_source: 'manual',
    fx_rate_id: rateId,
    source_to_base_rate: SEEDED_RATE,
    total_base_minor: converted,
  });

  // Every figure the two planted rows carry, computed by the estate's own
  // functions against the seed's stored B, T and rate. A second body of this
  // arithmetic out here would be a second financial truth (R-81).
  const fig = must(
    (
      await c.query<{ rel0: string; rel1: string; conv1: string; conv2: string }>(
        `SELECT supplier_ap_release($1::bigint, $2::bigint, 0, $3::bigint)::text AS rel0,
                supplier_ap_release($1::bigint, $2::bigint, $3::bigint, $4::bigint)::text AS rel1,
                supplier_convert_base($3::bigint, $5::numeric, x.minor_units, base.minor_units)::text AS conv1,
                supplier_convert_base($4::bigint, $5::numeric, x.minor_units, base.minor_units)::text AS conv2
           FROM currencies x, businesses b, currencies base
          WHERE b.id = $6 AND base.code = b.base_currency AND x.code = $7`,
        [converted, src.t, a1.toString(), a2.toString(), SEEDED_RATE, bid, ccy],
      )
    ).rows[0],
    'the releases and conversions of the seeded invoice',
  );
  return {
    invoiceId,
    currency: ccy,
    totalTxnMinor: BigInt(src.t),
    totalBaseMinor: BigInt(converted),
    relAtZero: BigInt(fig.rel0),
    relAtA1: BigInt(fig.rel1),
    convA1: BigInt(fig.conv1),
    convA2: BigInt(fig.conv2),
  };
}

/**
 * Replace ONE named term of the LIVE verifier with `false` inside the caller's
 * transaction, and return the digests that prove the surgery was applied.
 *
 * The statement executed is `pg_get_functiondef`'s own text with exactly one
 * substring swapped, so every term that REMAINS is the shipped term, character
 * for character. DDL is transactional, so the caller's `ROLLBACK` restores the
 * shipped definition, and the caller asserts from OUTSIDE that it did.
 */
async function knockOutTerm(c: Client, term: string): Promise<{ readonly before: string; readonly inside: string }> {
  const before = await routineDigest(c, ROUTINES.invoiceSettlementVerify);
  const body = await routineBody(c, ROUTINES.invoiceSettlementVerify);
  const hits = body.split(term).length - 1;
  if (hits !== 1)
    throw new Error(
      `the live body of ${ROUTINES.invoiceSettlementVerify} holds ${hits} occurrences of «${term}», not one, so replacing it is not the removal of the ` +
        'one named term and the knockout below would be a proof about an unknown edit',
    );
  await c.query(body.replace(term, 'false'));
  const inside = await routineDigest(c, ROUTINES.invoiceSettlementVerify);
  return { before, inside };
}

/**
 * Remove the verifier's EFFECT entirely, the way the negative control above
 * does: the body becomes a no-op inside this transaction, and the digest taken
 * after the replacement proves it was APPLIED before any result is read.
 */
async function replaceWithNoop(c: Client): Promise<{ readonly before: string; readonly inside: string }> {
  const before = await routineDigest(c, ROUTINES.invoiceSettlementVerify);
  await c.query(
    `CREATE OR REPLACE FUNCTION ${ROUTINES.invoiceSettlementVerify}(p_business_id UUID, p_invoice_id UUID) RETURNS void
       LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $noop$ BEGIN RETURN; END $noop$`,
  );
  const inside = await routineDigest(c, ROUTINES.invoiceSettlementVerify);
  return { before, inside };
}

/** What is done to the live verifier before the seeded write is judged. */
type Surgery = { readonly kind: 'none' } | { readonly kind: 'noop' } | { readonly kind: 'knockout'; readonly term: string };

/** What one run of the seeded `B ≠ T` write measured. */
interface CrossRateOutcome {
  readonly seed: CrossRateSeed;
  readonly insertError: { readonly message: string; readonly code: string | undefined } | null;
  readonly forced: { readonly message: string; readonly code: string | undefined } | null;
  readonly positions: readonly string[];
  readonly applied: bigint;
  readonly released: bigint;
  readonly breaks: readonly { readonly kind: string; readonly actualPosition: string }[];
  /** `inventory_half_even(B·Σa, T, 0)` — the identity's OWN value over the planted chain. */
  readonly identity: bigint;
  /** Every planted row whose stored release is not `supplier_ap_release` of its own position. */
  readonly perRowWrong: readonly string[];
  readonly read: { readonly outstandingTxnMinor: bigint; readonly outstandingBaseMinor: bigint; readonly state: string } | null;
  readonly digests: { readonly before: string; readonly inside: string } | null;
}

/**
 * Seed the `B ≠ T` invoice, settle it with a cross-relation chain whose
 * positions PARTITION its total, and move the credit application's stored
 * release by `relOffset` minor units. Then force the settlement trigger BY
 * NAME and report what it raised.
 *
 * WHY THE OFFSET IS ON THE CREDIT APPLICATION AND NOT ON THE ALLOCATION. The
 * forced trigger's OWN per-row block (`0081:1049-1057`) demands
 * `invoice_carrying_base_released_minor = supplier_ap_release(B, T, x, a)` and
 * runs BEFORE its `PERFORM invoice_settlement_verify`. A payment allocation
 * carrying a release that is not its own is therefore refused
 * `customer_payment.settlement_inconsistent` by that block and never reaches
 * the chain at all. `customer_credit_applications_value_complete` is deferred
 * too and is NOT forced, so the credit side's per-row block does not fire, and
 * the chain inside `invoice_settlement_verify` — reached through the LAWFUL
 * allocation — is the next thing that can speak.
 *
 * TWO COLUMNS MOVE AND NOT ONE, AND AN IMMEDIATE CHECK IS WHY.
 * `customer_credit_applications_realized_ck` is a table CHECK:
 * `realized_fx_gain_loss_minor = credit_carrying_base_released_minor −
 * invoice_carrying_base_released_minor`. It is immediate, so a row whose
 * release moved by one minor unit and whose realized FX did not is refused by
 * that CHECK before any law is reached. The realized column therefore moves
 * with it. The chain law reads NEITHER the realized column nor the dust one:
 * it reads `x`, `amount` and the release, and the dust is left at the figure of
 * the LAWFUL release in both runs for that reason.
 */
async function runCrossRate(relOffset: bigint, surgery: Surgery): Promise<CrossRateOutcome> {
  const bid = w.shop.businessId;
  return inRolledBackTx(
    () => ownerClient(),
    w.shop,
    async (c) => {
      const digests = surgery.kind === 'none' ? null : surgery.kind === 'noop' ? await replaceWithNoop(c) : await knockOutTerm(c, surgery.term);
      const seed = await seedCrossRateInvoice(c);
      const lawfulTwin = must(lawful, 'the lawful twin, whose credit application is the clone source');
      const app = must(
        (
          await c.query<{ id: string; credit: string; rel: string; consumed: string }>(
            `SELECT id::text AS id, credit_id::text AS credit, credit_carrying_base_released_minor::text AS rel,
                    credit_amount_consumed_minor::text AS consumed
               FROM customer_credit_applications WHERE business_id = $1 AND invoice_id = $2`,
            [bid, lawfulTwin.invoiceId],
          )
        ).rows[0],
        'the lawful twin’s accepted credit application',
      );
      // The ORIGINAL pair of the credit that application consumed. The clone
      // below must be born AT it, and the source credit is no longer there: the
      // twins have already consumed it twice.
      const born = must(
        (
          await c.query<{ oa: string; ob: string }>(
            `SELECT original_amount_minor::text AS oa, original_carrying_base_amount_minor::text AS ob
               FROM customer_credits WHERE business_id = $1 AND id = $2`,
            [bid, app.credit],
          )
        ).rows[0],
        `the original pair of credit ${app.credit}`,
      );
      const alloc = must(
        (
          await c.query<{ pb: string }>(`SELECT payment_base_amount_minor::text AS pb FROM payment_allocations WHERE business_id = $1 AND id = $2`, [
            bid,
            must(sourceAllocationId, 'the lawful allocation'),
          ])
        ).rows[0],
        'the lawful allocation’s payment base amount',
      );

      // THE CREDIT, BORN WHOLE AND THEN DECREMENTED ONCE, exactly as its own
      // command does it. `customer_credit_guard` refuses an INSERT whose
      // remaining pair is not its original pair, and allows ONE decrement
      // backed by this transaction's own application of this credit at this
      // level. A clone pointed at the EXISTING credit would make that credit's
      // own chain inconsistent, and `customer_credit_verify` — which
      // `invoice_settlement_verify` performs AFTER the chain block — would then
      // refuse the LAWFUL run by a different law, and the control would be lost.
      const trace = randomUUID();
      const createdAt = must((await c.query<{ now: string }>(`SELECT now()::text AS now`)).rows[0], 'the planting transaction’s own now()').now;
      await c.query(`SELECT set_config('app.business_transaction_id', $1, true)`, [trace]);
      const creditId = randomUUID();
      const insertError = await raised(async () => {
        // BORN WHOLE, which the source credit no longer is: the twins have
        // already consumed it twice, so the remaining pair is carried back up
        // to the original pair in the clone's own overrides. Writing it any
        // other way is refused by `customer_credit_guard` on INSERT, which is
        // the guard that makes the decrement below the only way the pair moves.
        await cloneRow(c, 'customer_credits', bid, app.credit, {
          id: creditId,
          binding_source_id: creditId,
          business_transaction_id: trace,
          created_at: createdAt,
          remaining_amount_minor: born.oa,
          remaining_carrying_base_amount_minor: born.ob,
        });
        const appId = randomUUID();
        await cloneRow(c, 'customer_credit_applications', bid, app.id, {
          id: appId,
          binding_source_id: appId,
          business_transaction_id: trace,
          created_at: createdAt,
          credit_id: creditId,
          invoice_id: seed.invoiceId,
          invoice_currency: seed.currency,
          invoice_historical_to_base_rate: SEEDED_RATE,
          invoice_carrying_base_released_minor: (seed.relAtZero + relOffset).toString(),
          ar_dust_base_minor: (seed.relAtZero - seed.convA1).toString(),
          realized_fx_gain_loss_minor: (BigInt(app.rel) - (seed.relAtZero + relOffset)).toString(),
        });
        await c.query(
          `UPDATE customer_credits SET remaining_amount_minor = original_amount_minor - $3::bigint,
                  remaining_carrying_base_amount_minor = original_carrying_base_amount_minor - $4::bigint
            WHERE business_id = $1 AND id = $2`,
          [bid, creditId, app.consumed, app.rel],
        );
        const allocId = randomUUID();
        await plantSettlementRow(c, 'payment_allocations', bid, must(sourceAllocationId, 'the lawful allocation'), {
          id: allocId,
          binding_source_id: allocId,
          invoice_id: seed.invoiceId,
          invoice_currency: seed.currency,
          invoice_historical_to_base_rate: SEEDED_RATE,
          invoice_carrying_base_released_minor: seed.relAtA1.toString(),
          ar_dust_base_minor: (seed.relAtA1 - seed.convA2).toString(),
          realized_fx_gain_loss_minor: (BigInt(alloc.pb) - seed.relAtA1).toString(),
        });
      });
      if (insertError !== null)
        return { seed, insertError, forced: null, positions: [], applied: 0n, released: 0n, breaks: [], identity: 0n, perRowWrong: [], read: null, digests };

      // Measured BEFORE the force: after a refusal the transaction is aborted
      // and nothing can be read out of it.
      const chain = await invoiceChain(c, bid, seed.invoiceId);
      const totals = chainTotals(chain);
      const positions = chain.map((s) => `${s.relation}@${s.positionMinor}+${s.appliedMinor}`).sort();
      const breaks = chainBreaks(chain).map((b) => ({ kind: b.kind, actualPosition: b.actualPosition }));
      // The identity's OWN value, and every row whose release is not its own,
      // both read out of the DATABASE's arithmetic rather than recomputed here,
      // so what is reported is what the law itself would compute.
      const judged = must(
        (
          await c.query<{ identity: string; wrong: readonly string[] }>(
            `WITH reducers AS (
               SELECT a.ar_released_before_txn_minor AS x, a.invoice_amount_applied_minor AS amount, a.invoice_carrying_base_released_minor AS rel
                 FROM payment_allocations a WHERE a.business_id = $1 AND a.invoice_id = $2
               UNION ALL
               SELECT k.ar_released_before_txn_minor, k.invoice_amount_applied_minor, k.invoice_carrying_base_released_minor
                 FROM customer_credit_applications k WHERE k.business_id = $1 AND k.invoice_id = $2
             )
             SELECT inventory_half_even(i.total_base_minor::numeric * coalesce(sum(d.amount), 0), i.total_txn_minor, 0)::text AS identity,
                    coalesce(array_agg(d.x::text || '+' || d.amount::text || ': stored ' || d.rel::text || ' is not ' ||
                                       supplier_ap_release(i.total_base_minor, i.total_txn_minor, d.x, d.amount)::text)
                             FILTER (WHERE d.rel <> supplier_ap_release(i.total_base_minor, i.total_txn_minor, d.x, d.amount)), '{}') AS wrong
               FROM invoices i, reducers d
              WHERE i.business_id = $1 AND i.id = $2
              GROUP BY i.total_base_minor, i.total_txn_minor`,
            [bid, seed.invoiceId],
          )
        ).rows[0],
        'the identity’s own value over the planted chain',
      );
      const forced = await raised(() => c.query(`SET CONSTRAINTS ${SETTLEMENT_TRIGGER} IMMEDIATE`));
      const read = forced === null ? await derivedRead(c, bid, seed.invoiceId) : null;
      return {
        seed,
        insertError,
        forced,
        positions,
        applied: totals.applied,
        released: totals.released,
        breaks,
        identity: BigInt(judged.identity),
        perRowWrong: judged.wrong,
        read: read === null ? null : { outstandingTxnMinor: read.outstandingTxnMinor, outstandingBaseMinor: read.outstandingBaseMinor, state: read.state },
        digests,
      };
    },
  );
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  w = await settlementWorld('s4xrel');
  missing = await settlementMissing(w);
  if (missing.length > 0) return;

  await stockUp(w, '100', '7');
  const customer = await newCustomer(w);

  // THREE invoices of ONE customer. `funder` is overpaid to give birth to the
  // credit; `lawful` and `attacked` are TWINS — same product, same quantity,
  // so the same `T` and the same `B` — which is what lets one accepted
  // allocation be cloned onto the other twin without any of its stored
  // figures ceasing to be the R-82 figures of its invoice. The twins being
  // interchangeable is asserted below and not assumed.
  const funder = await sellOnCredit(w, customer, '1');
  lawful = await sellOnCredit(w, customer, '2');
  attacked = await sellOnCredit(w, customer, '2');

  const total = BigInt(lawful.totalTxnMinor);
  // A THIRD and two thirds, so the two reducers of the attack apply DIFFERENT
  // amounts. Two equal amounts at one position would make the chain's
  // `ORDER BY x, amount` a tie, and a law whose subject depends on how a tie
  // broke is a law about the planner.
  a1 = total / 3n;
  a2 = total - a1;
  expect(a1 > 0n && a2 > 0n && a1 !== a2, `the two reducers apply different positive amounts of ${total}: measured ${a1} and ${a2}`).toBe(true);

  // The credit, born of a surplus on `funder` large enough to be applied to
  // BOTH twins and still leave a positive remainder.
  const creditId = randomUUID();
  const born = await collectPayment(w.t, w.headers, {
    paymentId: randomUUID(),
    customerId: customer,
    paymentMethodId: w.paymentMethodId,
    paymentDate: w.day,
    amountMinor: (BigInt(funder.totalTxnMinor) + total).toString(),
    creditId,
    allocations: [leg(funder, BigInt(funder.totalTxnMinor), 0n)],
  });
  expect(born.status, `the credit-bearing overpayment commits: ${JSON.stringify(born.body)}`).toBeLessThan(300);
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
  const originalMinor = BigInt(cr.oa);
  expect(originalMinor >= a1 * 2n, `the credit ${originalMinor} covers the first leg of BOTH twins (${a1} each)`).toBe(true);

  // Leg one of each twin, from position 0, through the REAL credit-application
  // command: the row the attack then shares a position with.
  const credited = async (inv: OpenInvoice, remainingBefore: bigint): Promise<Response> =>
    applyCredit(w.t, w.headers, {
      applicationId: randomUUID(),
      creditId,
      customerId: customer,
      invoiceId: inv.invoiceId,
      applicationDate: w.day,
      consumedMinor: a1.toString(),
      remainingBeforeMinor: remainingBefore.toString(),
      creditOriginalMinor: cr.oa,
      creditOriginalCarryingMinor: cr.ob,
      leg: leg(inv, a1, 0n),
    });
  const c1 = await credited(lawful, originalMinor);
  expect(c1.status, `leg one of the lawful twin commits: ${JSON.stringify(c1.body)}`).toBeLessThan(300);
  const c2 = await credited(attacked, originalMinor - a1);
  expect(c2.status, `leg one of the attacked twin commits: ${JSON.stringify(c2.body)}`).toBeLessThan(300);

  // Leg two of the LAWFUL twin only, through the REAL payment command: the
  // accepted allocation every plant below is cloned from. The attacked twin is
  // deliberately left with `a₂` outstanding, so the planted row can complete
  // it to exactly `T` and the refused state is an overlap and never an
  // over-settlement.
  const paid = await collectPayment(w.t, w.headers, {
    paymentId: randomUUID(),
    customerId: customer,
    paymentMethodId: w.paymentMethodId,
    paymentDate: w.day,
    amountMinor: a2.toString(),
    allocations: [leg(lawful, a2, a1)],
  });
  expect(paid.status, `leg two of the lawful twin commits: ${JSON.stringify(paid.body)}`).toBeLessThan(300);
  const src = must(
    (
      await ownerPool().query<{ id: string }>(
        `SELECT id::text AS id FROM payment_allocations WHERE business_id = $1 AND invoice_id = $2 AND ${CHAIN.position} = $3`,
        [w.shop.businessId, lawful.invoiceId, a1.toString()],
      )
    ).rows[0],
    `the lawful twin's accepted allocation at chain position ${a1}`,
  );
  sourceAllocationId = src.id;
}, 420_000);

afterAll(async () => {
  await w?.t?.close();
  await resetData();
});

describe('P4-S4 the chain law across the two reducer relations', () => {
  it('the subject exists: the settlement relations, their chain columns, the commands, the verifiers and the routes', () => {
    requireSubject(missing, CLAIM);
  });

  it('the shipped wiring is what calls this law at COMMIT, and the refusal this file names is the one the live routine raises', async () => {
    requireSubject(missing, CLAIM);
    const wiring = await deferredVerifierWiring(ownerPool());
    const reducers = wiring.filter((x) => x.relation === 'payment_allocations' || x.relation === 'customer_credit_applications');
    expect(
      reducers.map((x) => `${x.relation}/${x.trigger} deferred=${x.deferred} reaches=${x.reachesVerifier}`).sort(),
      `BOTH reducer relations must reach ${ROUTINES.invoiceSettlementVerify} through a DEFERRABLE INITIALLY DEFERRED constraint trigger, or the ` +
        `cross-relation law is carried by nothing and forcing it by name below would be a proof about a routine nobody runs. Measured: ` +
        `${JSON.stringify(wiring)}`,
    ).toEqual([
      `customer_credit_applications/customer_credit_applications_value_complete deferred=true reaches=true`,
      `payment_allocations/${SETTLEMENT_TRIGGER} deferred=true reaches=true`,
    ]);
    // The literal this file asserts on, pinned to the shipped routine.
    const body = await routineBody(ownerPool(), ROUTINES.invoiceSettlementVerify);
    expect(
      body.includes(CHAIN_REFUSAL),
      `${ROUTINES.invoiceSettlementVerify} must still raise "${CHAIN_REFUSAL}" by that name. If the migration renamed it, every refusal ` +
        `assertion in this file would be matching a string nothing raises, and would pass only because it never looked.`,
    ).toBe(true);
    // And the reason the force below names ONE constraint instead of ALL.
    const deferred = await ownerPool().query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'payment_allocations'::regclass AND condeferrable AND condeferred ORDER BY conname`,
    );
    expect(
      deferred.rows.map((r) => r.conname),
      `a planted allocation has no accounting_source_bindings row, so ${BINDING_FK} — deferred too — would answer in place of the law under ` +
        `SET CONSTRAINTS ALL IMMEDIATE. That is why the force below names ${SETTLEMENT_TRIGGER}.`,
    ).toEqual([BINDING_FK, SETTLEMENT_TRIGGER]);
  });

  it('POSITIVE CONTROL — a LAWFUL cross-relation chain over the twin closes the invoice to nothing in BOTH currencies', async () => {
    requireSubject(missing, CLAIM);
    const inv = must(lawful, 'the lawful twin');
    const chain = await invoiceChain(ownerPool(), w.shop.businessId, inv.invoiceId);
    expect(
      chain.map((s) => `${s.relation}@${s.positionMinor}+${s.appliedMinor}`),
      `the lawful twin is settled by ONE row in EACH relation, and the positions PARTITION its total: a cross-relation chain is not ` +
        `refused for being cross-relation, which is what makes the refusal below about the POSITION and nothing else`,
    ).toEqual([`customer_credit_applications@0+${a1}`, `payment_allocations@${a1}+${a2}`]);
    expect(chainBreaks(chain), 'and it has no gap and no overlap').toEqual([]);
    const totals = chainTotals(chain);
    const read = await derivedRead(ownerPool(), w.shop.businessId, inv.invoiceId);
    expect(
      {
        applied: totals.applied.toString(),
        released: totals.released.toString(),
        outstanding_txn: read.outstandingTxnMinor.toString(),
        outstanding_base: read.outstandingBaseMinor.toString(),
        state: read.state,
      },
      `Σa must be the invoice's whole T and Σrel its whole B, so the invoice owes nothing in either currency. This is the arm the attack ` +
        `below differs from by ONE integer, and a failure here would mean the attack's refusal could be a broken fixture wearing the ` +
        `costume of a law`,
    ).toEqual({
      applied: inv.totalTxnMinor,
      released: inv.totalBaseMinor,
      outstanding_txn: '0',
      outstanding_base: '0',
      state: 'paid',
    });
  });

  it('the twins are interchangeable and the attacked twin still owes exactly the amount the plant will claim', async () => {
    requireSubject(missing, CLAIM);
    const l = must(lawful, 'the lawful twin');
    const a = must(attacked, 'the attacked twin');
    expect(
      { txn: a.totalTxnMinor, base: a.totalBaseMinor, ccy: a.currencyCode, rate: a.sourceToBaseRate },
      `the clone keeps the SOURCE row's rel, dust, realized FX and rates, and those are the R-82 figures of the invoice the row names. If the ` +
        `twins' totals differed, the per-row identity of 0081:1049-1057 would refuse the clone and the refusal below would be the WRONG LAW`,
    ).toEqual({ txn: l.totalTxnMinor, base: l.totalBaseMinor, ccy: l.currencyCode, rate: l.sourceToBaseRate });
    const chain = await invoiceChain(ownerPool(), w.shop.businessId, a.invoiceId);
    expect(
      chain.map((s) => `${s.relation}@${s.positionMinor}+${s.appliedMinor}`),
      'the attacked twin carries exactly ONE reducer, a credit application at position 0',
    ).toEqual([`customer_credit_applications@0+${a1}`]);
    const read = await derivedRead(ownerPool(), w.shop.businessId, a.invoiceId);
    expect(
      { outstanding_txn: read.outstandingTxnMinor.toString(), state: read.state },
      `so it owes exactly a₂ = ${a2}, and a plant that applies a₂ brings Σa to exactly T — an OVERLAP and never an over-settlement, which is ` +
        `a different term of the law (0081:782 "v_sum > total")`,
    ).toEqual({ outstanding_txn: a2.toString(), state: 'partial' });
  });

  it('THE TRAP — the same violation planted and NOT forced raises nothing at all, and the invoice reads fully settled', async () => {
    requireSubject(missing, CLAIM);
    // The constraint triggers are INITIALLY DEFERRED, so a plant inside a
    // transaction that is rolled back never reaches the check. This is
    // measured, and not described, because it is the reason every refusal in
    // this file forces the constraint — and because what it shows is the
    // CORRUPT STATE the law exists to prevent: every aggregate reads closed.
    const target = must(attacked, 'the attacked twin');
    const source = must(sourceAllocationId, 'the lawful allocation');
    const outcome = await inRolledBackTx(
      () => ownerClient(),
      w.shop,
      async (c) => {
        const newId = randomUUID();
        const err = await raised(() =>
          plantSettlementRow(c, 'payment_allocations', w.shop.businessId, source, {
            id: newId,
            binding_source_id: newId,
            invoice_id: target.invoiceId,
            [CHAIN.position]: 0,
          }),
        );
        const read = await derivedRead(c, w.shop.businessId, target.invoiceId);
        const totals = chainTotals(await invoiceChain(c, w.shop.businessId, target.invoiceId));
        return { err, read, totals };
      },
    );
    expect(
      outcome.err,
      `the INSERT itself must be accepted: no per-relation UNIQUE, no foreign key and no BEFORE guard refuses this row, which is exactly ` +
        `0081:327-333's point. A refusal here would mean the law below was never reached. Measured: ${JSON.stringify(outcome.err)}`,
    ).toBeNull();
    expect(
      {
        applied: outcome.totals.applied.toString(),
        released: outcome.totals.released.toString(),
        outstanding_txn: outcome.read.outstandingTxnMinor.toString(),
        outstanding_base: outcome.read.outstandingBaseMinor.toString(),
      },
      `and with the deferred check not forced, the invoice reads CLOSED in both currencies while the same ${a1} of it was released twice and ` +
        `the other ${a2} never was. Σa = T and Σrel = B both hold, so no aggregate can see this defect: only the per-row recurrence can`,
    ).toEqual({
      applied: target.totalTxnMinor,
      released: target.totalBaseMinor,
      outstanding_txn: '0',
      outstanding_base: '0',
    });
  });

  it('THE REFUSAL — one payment allocation and one credit application at the SAME chain position are refused BY NAME', async () => {
    requireSubject(missing, CLAIM);
    const target = must(attacked, 'the attacked twin');
    const outcome = await plantOnAttacked({ invoice_id: target.invoiceId, [CHAIN.position]: 0 });
    expect(outcome.insertError, `the plant must reach the law: ${JSON.stringify(outcome.insertError)}`).toBeNull();
    // What the law refused, stated before the refusal is asserted.
    expect(
      outcome.positions,
      `the refused state is TWO reducers at position 0, one in EACH relation — the shape no per-relation UNIQUE can see (0081:327-333). Each ` +
        `relation holds exactly one row at that position, so both indexes are satisfied`,
    ).toEqual([`customer_credit_applications@0+${a1}`, `payment_allocations@0+${a2}`]);
    expect(
      { applied: outcome.applied.toString(), released: outcome.released.toString() },
      `and it is refused with Σa = T and Σrel = B — the cumulative identity Σrel = HALF_EVEN(B·Σa, T), which at Σa = T is Σrel = B, is ` +
        `SATISFIED. The law is not refusing an arithmetic mismatch; it is refusing a history in which the same amount is released twice`,
    ).toEqual({ applied: target.totalTxnMinor, released: target.totalBaseMinor });
    expect(outcome.breaks, 'and the recurrence names it an OVERLAP at position 0, which is the term that can see it').toEqual([
      { kind: 'overlap', actualPosition: '0' },
    ]);
    const err = must(outcome.forced, `the refusal. NOTHING was raised, so two reducers of invoice ${target.invoiceId} can be computed from one chain position`);
    expect(
      err.message,
      `and the refusal is the CHAIN LAW by name. A 23505 would be a per-relation UNIQUE (which cannot see this), a 23503 the deferred binding ` +
        `FK, and a "customer_payment.settlement_inconsistent" the per-row trigger at 0081:1049-1057 — none of those is this law. Measured: ` +
        `${err.code} ${err.message}`,
    ).toContain(CHAIN_REFUSAL);
    expect(err.code, `raised by ${ROUTINES.invoiceSettlementVerify} as a business refusal: ${err.code} ${err.message}`).toBe('P0001');
  });

  it('ATTRIBUTION — the SAME plant at the LAWFUL position is ACCEPTED through the SAME forced trigger, so one integer is the whole difference', async () => {
    requireSubject(missing, CLAIM);
    const target = must(attacked, 'the attacked twin');
    // Byte-for-byte the plant of the case above, with `ar_released_before_txn_minor`
    // left at the source row's lawful `a₁` instead of 0. Same clone, same new
    // payment, same absent binding row, same forced constraint.
    const outcome = await plantOnAttacked({ invoice_id: target.invoiceId });
    expect(outcome.insertError, `the plant is accepted on insertion: ${JSON.stringify(outcome.insertError)}`).toBeNull();
    expect(outcome.positions, 'the positions now PARTITION the total, across the two relations').toEqual([
      `customer_credit_applications@0+${a1}`,
      `payment_allocations@${a1}+${a2}`,
    ]);
    expect(
      outcome.forced,
      `this is the attribution of the refusal above. The two plants differ in ONE INTEGER — the chain position — and are otherwise the same ` +
        `cloned row, with the same missing accounting_source_bindings row, the same foreign keys and the same forced constraint. So the ` +
        `refusal above cannot be a foreign key, a missing seed row, a guard or the planter: it is the chain. Measured: ` +
        `${JSON.stringify(outcome.forced)}`,
    ).toBeNull();
    expect(
      must(outcome.read, 'the derived read of the accepted plant'),
      'and the accepted cross-relation chain closes the invoice to nothing in both currencies',
    ).toEqual({ outstandingTxnMinor: 0n, outstandingBaseMinor: 0n, state: 'paid' });
  });

  it('NEGATIVE CONTROL — with the verifier’s effect removed the same write is ACCEPTED, and the shipped definition is proved unchanged', async () => {
    requireSubject(missing, CLAIM);
    const target = must(attacked, 'the attacked twin');
    const source = must(sourceAllocationId, 'the lawful allocation');
    const before = await routineDigest(ownerPool(), ROUTINES.invoiceSettlementVerify);
    const outcome = await inRolledBackTx(
      () => ownerClient(),
      w.shop,
      async (c) => {
        // The verifier's EFFECT is removed by replacing its body with a no-op
        // inside this transaction. DDL is transactional, so the ROLLBACK in
        // `inRolledBackTx` restores the shipped definition; that it did is
        // asserted from OUTSIDE this transaction below, and the digest taken
        // here proves the replacement was APPLIED before any result is read.
        await c.query(
          `CREATE OR REPLACE FUNCTION ${ROUTINES.invoiceSettlementVerify}(p_business_id UUID, p_invoice_id UUID) RETURNS void
             LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $noop$ BEGIN RETURN; END $noop$`,
        );
        const inside = await routineDigest(c, ROUTINES.invoiceSettlementVerify);
        const newId = randomUUID();
        const insertError = await raised(() =>
          plantSettlementRow(c, 'payment_allocations', w.shop.businessId, source, {
            id: newId,
            binding_source_id: newId,
            invoice_id: target.invoiceId,
            [CHAIN.position]: 0,
          }),
        );
        const forced = await raised(() => c.query(`SET CONSTRAINTS ${SETTLEMENT_TRIGGER} IMMEDIATE`));
        const seen = forced === null ? await derivedRead(c, w.shop.businessId, target.invoiceId) : null;
        const read =
          seen === null ? null : { outstandingTxnMinor: seen.outstandingTxnMinor, outstandingBaseMinor: seen.outstandingBaseMinor, state: seen.state };
        return { inside, insertError, forced, read };
      },
    );
    expect(
      outcome.inside === before,
      `THE PLANT MUST BE PROVED APPLIED BEFORE ITS RESULT IS READ. The routine's digest inside the transaction must DIFFER from the shipped ` +
        `${before}; if it did not, the "acceptance" below would be the shipped law accepting the write, which is the opposite of what this ` +
        `case claims. Measured inside: ${outcome.inside}`,
    ).toBe(false);
    expect(outcome.insertError, `the plant is accepted on insertion: ${JSON.stringify(outcome.insertError)}`).toBeNull();
    expect(
      outcome.forced,
      `WITH THE LAW GONE, THE SAME WRITE IS ACCEPTED. This is the half that makes the refusal above mean something: it proves the refusal came ` +
        `from ${ROUTINES.invoiceSettlementVerify} and not from something else in the estate that would have objected anyway. Measured: ` +
        `${JSON.stringify(outcome.forced)}`,
    ).toBeNull();
    expect(
      must(outcome.read, 'the derived read with the law removed'),
      `and the invoice then reads FULLY SETTLED — Σa = T and Σrel = B — while the same ${a1} of it was released twice and the other ${a2} ` +
        `never was. That unreachable-but-plausible state is the harm, and on this head it is invisible to every aggregate`,
    ).toEqual({ outstandingTxnMinor: 0n, outstandingBaseMinor: 0n, state: 'paid' });
    const after = await routineDigest(ownerPool(), ROUTINES.invoiceSettlementVerify);
    expect(
      after,
      `and the SHIPPED definition is byte-identical after the control: the replacement lived only inside a rolled-back transaction. A test that ` +
        `left a no-op verifier behind would make every later law of this estate vacuous`,
    ).toBe(before);
  });

  it('the shipped verifier still refuses, measured AFTER the negative control, so nothing was left weakened', async () => {
    requireSubject(missing, CLAIM);
    const target = must(attacked, 'the attacked twin');
    const outcome = await plantOnAttacked({ invoice_id: target.invoiceId, [CHAIN.position]: 0 });
    const err = must(outcome.forced, 'the refusal, re-measured after the negative control replaced and restored the routine');
    expect(err.message, `the law is back and refusing: ${err.code} ${err.message}`).toContain(CHAIN_REFUSAL);
  });

  it('THE SEEDED HEAD — a schema-lawful B ≠ T invoice, and the conservation identity is NON-DEGENERATE on its own figures', async () => {
    requireSubject(missing, CLAIM);
    const out = await runCrossRate(0n, { kind: 'none' });
    expect(
      out.insertError,
      `EVERY ROW OF THE SEED MUST BE ACCEPTED, or the refusals below would be the seed failing rather than the law speaking. The seed is a rate ` +
        `row, a cloned sale, a cloned invoice carrying the rate pair, a credit born whole and decremented once, its application, and one cloned ` +
        `payment allocation. Measured: ${JSON.stringify(out.insertError)}`,
    ).toBeNull();
    expect(
      {
        t: out.seed.totalTxnMinor.toString(),
        b: out.seed.totalBaseMinor.toString(),
        differ: out.seed.totalBaseMinor !== out.seed.totalTxnMinor,
        identity: out.identity.toString(),
      },
      `the seeded invoice carries B ≠ T, and B is what supplier_convert_base makes of T at the rate the row stores — not a number chosen out ` +
        `here. The identity's own value over a chain that applies the whole of T is then HALF_EVEN(B·T, T) = B`,
    ).toEqual({
      t: out.seed.totalTxnMinor.toString(),
      b: out.seed.totalBaseMinor.toString(),
      differ: true,
      identity: out.seed.totalBaseMinor.toString(),
    });
    expect(
      out.seed.relAtZero !== a1 && out.seed.relAtA1 !== a2,
      `AND THE IDENTITY IS NOT A TAUTOLOGY HERE. At B = T, rel(T,T,X,a) = a for every X, so Σrel = Σa holds for ANY positions and the ` +
        `conservation term merely restates the per-row one — which is why no case above could reach it. On this seeded head each release ` +
        `DIFFERS from its own amount, so HALF_EVEN(B·Σa, T) is arithmetic that can disagree with the stored releases, and that is the only ` +
        `condition under which making it refuse means anything. Measured rel(B,T,0,${a1}) = ${out.seed.relAtZero} against a₁ = ${a1}, and ` +
        `rel(B,T,${a1},${a2}) = ${out.seed.relAtA1} against a₂ = ${a2}`,
    ).toBe(true);
  }, 120_000);

  it('POSITIVE CONTROL — on the seeded B ≠ T invoice the LAWFUL cross-relation chain is ACCEPTED through the forced trigger and closes it in BOTH currencies', async () => {
    requireSubject(missing, CLAIM);
    const out = await runCrossRate(0n, { kind: 'none' });
    expect(out.insertError, `the seed and its chain are accepted on insertion: ${JSON.stringify(out.insertError)}`).toBeNull();
    expect(out.positions, 'the seeded invoice is settled by ONE row in EACH relation, and the positions PARTITION its total').toEqual([
      `customer_credit_applications@0+${a1}`,
      `payment_allocations@${a1}+${a2}`,
    ]);
    expect(out.breaks, 'with no gap and no overlap').toEqual([]);
    expect(out.perRowWrong, 'and every row carries the release of its own position, measured against supplier_ap_release by the database').toEqual([]);
    expect(
      {
        applied: out.applied.toString(),
        released: out.released.toString(),
        identity: out.identity.toString(),
        forced: out.forced,
      },
      `Σa is the whole of T, Σrel is the whole of B, and Σrel IS the identity's value — so the conservation term is satisfied and the write ` +
        `passes the forced trigger. This is the arm the refusal below differs from by one minor unit, and a failure here would mean that ` +
        `refusal could be a broken seed wearing the costume of a law. Measured: ${JSON.stringify(out.forced)}`,
    ).toEqual({
      applied: out.seed.totalTxnMinor.toString(),
      released: out.seed.totalBaseMinor.toString(),
      identity: out.seed.totalBaseMinor.toString(),
      forced: null,
    });
    expect(must(out.read, 'the derived read of the accepted seeded chain'), 'and the invoice owes nothing in either currency').toEqual({
      outstandingTxnMinor: 0n,
      outstandingBaseMinor: 0n,
      state: 'paid',
    });
  }, 120_000);

  it('THE CONSERVATION ARM REFUSES — one minor unit of released base value, with the chain POSITIONS INTACT, is refused BY NAME', async () => {
    requireSubject(missing, CLAIM);
    const out = await runCrossRate(1n, { kind: 'none' });
    expect(out.insertError, `the plant must reach the law: ${JSON.stringify(out.insertError)}`).toBeNull();
    expect(
      { positions: out.positions, breaks: out.breaks },
      `THE RECURRENCE IS SATISFIED, so it cannot be what refuses. The positions still partition the total across the two relations and the ` +
        `chain has no gap and no overlap — which is the whole difference between this case and THE REFUSAL above, where the recurrence is ` +
        `exactly what spoke`,
    ).toEqual({ positions: [`customer_credit_applications@0+${a1}`, `payment_allocations@${a1}+${a2}`], breaks: [] });
    expect(
      { applied: out.applied.toString(), total: out.seed.totalTxnMinor.toString() },
      'and Σa is exactly T, so the aggregate over-settlement term (v_sum > T) is not satisfied either',
    ).toEqual({ applied: out.seed.totalTxnMinor.toString(), total: out.seed.totalTxnMinor.toString() });
    expect(
      { released: out.released.toString(), identity: out.identity.toString() },
      `THE CONSERVATION TERM IS THE ONE THAT IS BROKEN: Σrel is one minor unit above HALF_EVEN(B·Σa, T), which is the identity's own value ` +
        `computed by the database over this very chain`,
    ).toEqual({ released: (out.seed.totalBaseMinor + 1n).toString(), identity: out.seed.totalBaseMinor.toString() });
    expect(
      out.perRowWrong,
      `AND THE PER-ROW RELEASE TERM IS BROKEN TOO, on exactly the one row whose stored release was moved. The two terms cannot be separated by ` +
        `any lawful chain — the DISCLOSURE case below measures why — so this case does NOT claim the conservation term is the only one that ` +
        `could have spoken. The ATTRIBUTION case proves it would have spoken alone`,
    ).toHaveLength(1);
    const err = must(out.forced, `the refusal. NOTHING was raised, so a chain may release one minor unit more of base than its invoice carries`);
    expect(err.message, `and the refusal is the CHAIN LAW by name: ${err.code} ${err.message}`).toContain(CHAIN_REFUSAL);
    expect(err.code, `raised by ${ROUTINES.invoiceSettlementVerify} as a business refusal: ${err.code} ${err.message}`).toBe('P0001');
  }, 120_000);

  it('ATTRIBUTION — with the per-row terms knocked OUT of the live body, the conservation term ALONE refuses that minor unit, and ACCEPTS the lawful chain', async () => {
    requireSubject(missing, CLAIM);
    const shipped = await routineDigest(ownerPool(), ROUTINES.invoiceSettlementVerify);
    const refused = await runCrossRate(1n, { kind: 'knockout', term: PER_ROW_TERMS });
    const accepted = await runCrossRate(0n, { kind: 'knockout', term: PER_ROW_TERMS });
    for (const [label, out] of [
      ['the refused run', refused],
      ['the accepted run', accepted],
    ] as const) {
      const d = must(out.digests, `${label}'s digests`);
      expect(
        d.before === shipped && d.inside !== d.before,
        `THE KNOCKOUT MUST BE PROVED APPLIED BEFORE ITS RESULT IS READ: the body inside ${label} must be the SHIPPED one with «${PER_ROW_TERMS}» ` +
          `gone, so its digest must start at ${shipped} and then differ. Measured before ${d.before}, inside ${d.inside}`,
      ).toBe(true);
      expect(out.insertError, `${label} is accepted on insertion: ${JSON.stringify(out.insertError)}`).toBeNull();
    }
    expect(
      must(
        refused.forced,
        `the refusal with only the conservation term live. NOTHING was raised, so that term does not refuse this write at all ` +
          `and the refusal measured above was carried entirely by the per-row terms`,
      ).message,
      `WITH «${PER_ROW_TERMS}» REPLACED BY «false» IN THE SHIPPED TEXT, the conservation term is the only thing left that can raise — and it ` +
        `raises. That is the attribution the refusal itself cannot carry, because both terms are true of that state and ONE RAISE serves both`,
    ).toContain(CHAIN_REFUSAL);
    expect(
      accepted.forced,
      `AND THE KNOCKOUT IS NOT A BLANKET REFUSER. The same body with the same term knocked out ACCEPTS the lawful chain, so "refused" above is ` +
        `the conservation term judging one minor unit and not a variant that refuses whatever it is given. Measured: ${JSON.stringify(accepted.forced)}`,
    ).toBeNull();
    expect(
      await routineDigest(ownerPool(), ROUTINES.invoiceSettlementVerify),
      `and the SHIPPED definition is byte-identical after both knockouts: each lived only inside a rolled-back transaction. A test that left a ` +
        `term knocked out behind would make every later law of this estate weaker than it reads`,
    ).toBe(shipped);
  }, 240_000);

  it('DISCLOSURE — the per-row term sees the same minor unit, and the telescoping that makes the conservation term REDUNDANT is measured and not argued', async () => {
    requireSubject(missing, CLAIM);
    const shipped = await routineDigest(ownerPool(), ROUTINES.invoiceSettlementVerify);
    const refused = await runCrossRate(1n, { kind: 'knockout', term: CONSERVATION_TERM });
    const accepted = await runCrossRate(0n, { kind: 'knockout', term: CONSERVATION_TERM });
    for (const [label, out] of [
      ['the refused run', refused],
      ['the accepted run', accepted],
    ] as const) {
      const d = must(out.digests, `${label}'s digests`);
      expect(
        d.before === shipped && d.inside !== d.before,
        `the knockout of «${CONSERVATION_TERM}» must be proved applied before its result is read. Measured before ${d.before}, inside ${d.inside}`,
      ).toBe(true);
      expect(out.insertError, `${label} is accepted on insertion: ${JSON.stringify(out.insertError)}`).toBeNull();
    }
    expect(
      must(refused.forced, 'the refusal with only the per-row terms live').message,
      `THE PER-ROW TERM REFUSES THE SAME WRITE. So the refusal measured above is NOT evidence that the conservation term is doing work the rest ` +
        `of the law does not: both terms are true of that state, and this file says so rather than letting the shared RAISE imply otherwise`,
    ).toContain(CHAIN_REFUSAL);
    expect(accepted.forced, `and this knockout is not a blanket refuser either: ${JSON.stringify(accepted.forced)}`).toBeNull();
    // WHY THEY CANNOT BE SEPARATED, over the estate's own arithmetic on the
    // seeded invoice's own figures. `supplier_ap_release(B,T,X,a)` is exactly
    // `R(X+a) − R(X)`, so a chain whose positions chain from zero has per-row
    // releases that TELESCOPE to `R(Σa)` — the identity's own value. A chain
    // that breaks the identity while every row keeps its own release is
    // therefore not expressible, and the conservation term is redundant GIVEN
    // the per-row one. It is defence in depth and not an independent law, and
    // that is the honest description of what the cases above exercise.
    const seed = refused.seed;
    const tele = must(
      (
        await ownerPool().query<{ rows_sum: string; identity: string }>(
          `SELECT (supplier_ap_release($1::bigint, $2::bigint, 0, $3::bigint)
                   + supplier_ap_release($1::bigint, $2::bigint, $3::bigint, $4::bigint))::text AS rows_sum,
                  inventory_half_even($1::numeric * ($3::bigint + $4::bigint), $2::bigint, 0)::text AS identity`,
          [seed.totalBaseMinor.toString(), seed.totalTxnMinor.toString(), a1.toString(), a2.toString()],
        )
      ).rows[0],
      'the telescoping of the seeded invoice’s own releases',
    );
    expect(
      tele.rows_sum,
      `TELESCOPING, MEASURED: on this seeded invoice the sum of the releases each position is OWED is exactly the identity's value, so no chain ` +
        `can satisfy the per-row term and break the conservation one. That is why the refusal above is accompanied by the per-row term and why ` +
        `no case in this file claims the conservation term fires alone against a lawful row set`,
    ).toBe(tele.identity);
    expect(await routineDigest(ownerPool(), ROUTINES.invoiceSettlementVerify), 'and the shipped definition is byte-identical after both knockouts').toBe(
      shipped,
    );
  }, 240_000);

  it('NEGATIVE CONTROL — with the verifier’s effect removed the seeded B ≠ T write is ACCEPTED, and the shipped definition is proved unchanged', async () => {
    requireSubject(missing, CLAIM);
    const before = await routineDigest(ownerPool(), ROUTINES.invoiceSettlementVerify);
    const out = await runCrossRate(1n, { kind: 'noop' });
    const d = must(out.digests, 'the no-op control’s digests');
    expect(
      d.inside === before,
      `THE PLANT MUST BE PROVED APPLIED BEFORE ITS RESULT IS READ. The routine's digest inside the transaction must DIFFER from the shipped ` +
        `${before}; if it did not, the acceptance below would be the shipped law accepting the write, which is the opposite of what this case ` +
        `claims. Measured inside: ${d.inside}`,
    ).toBe(false);
    expect(out.insertError, `the seeded write is accepted on insertion: ${JSON.stringify(out.insertError)}`).toBeNull();
    expect(
      out.forced,
      `WITH THE LAW GONE, THE SAME WRITE IS ACCEPTED. This is the half that makes the refusal above mean something: it proves the refusal came ` +
        `from ${ROUTINES.invoiceSettlementVerify} and not from a CHECK, a foreign key or a per-row trigger that would have objected anyway. ` +
        `Measured: ${JSON.stringify(out.forced)}`,
    ).toBeNull();
    expect(
      must(out.read, 'the derived read with the law removed'),
      `AND THIS IS THE HARM THE CONSERVATION TERM PREVENTS. The invoice reads fully paid in its own currency — Σa = T, so the state is 'paid' ` +
        `and nothing outstanding — while the BASE currency is one minor unit over-released: the receivable carries −1 of base that the invoice ` +
        `never owed. A reader of the transaction currency alone cannot see it, which is why the law checks the base sum`,
    ).toEqual({ outstandingTxnMinor: 0n, outstandingBaseMinor: -1n, state: 'paid' });
    expect(
      await routineDigest(ownerPool(), ROUTINES.invoiceSettlementVerify),
      `and the SHIPPED definition is byte-identical after the control: the no-op lived only inside a rolled-back transaction`,
    ).toBe(before);
  }, 120_000);

  it('the shipped verifier still refuses the seeded write, measured AFTER every knockout and the no-op, so nothing was left weakened', async () => {
    requireSubject(missing, CLAIM);
    const out = await runCrossRate(1n, { kind: 'none' });
    const err = must(out.forced, 'the refusal, re-measured after the knockouts and the no-op replaced and restored the routine');
    expect(err.message, `the law is back and refusing: ${err.code} ${err.message}`).toContain(CHAIN_REFUSAL);
  }, 120_000);

  it('the conservation arm is exercised where B ≠ T, and NO COMMAND on this head can create such an invoice — which is why it is seeded', async () => {
    requireSubject(missing, CLAIM);
    // The chain law has TWO independent terms: the per-row recurrence
    // `h.x <> h.before` and the cumulative identity
    // `Σrel = HALF_EVEN(B·Σa, T)`. On the twins above the identity cannot see
    // the overlap at all, and that is a property of the HEAD and not of the
    // law: a product's price currency is pinned to the business base currency,
    // so every invoice a command creates carries `source_to_base_rate = 1` and
    // `B = T`, where `rel(B,T,X,a) = a` identically and Σrel = Σa for ANY
    // positions.
    //
    // THIS CASE USED TO STOP HERE, disclosing that the identity's teeth could
    // not be put into the live law on this head. DR-73 §2 ruled that
    // insufficient, and the cases above now do it: a `B ≠ T` invoice is SEEDED
    // directly and the conservation term is made to refuse a live write
    // through the live routine. What this case still measures is the two facts
    // that make that seed NECESSARY rather than lazy — the arithmetic reason
    // the identity is degenerate at `B = T`, and the measured fact that no row
    // any command wrote on this head escapes `B = T`.
    const r = must(
      (
        await ownerPool().query<{ same: string; lawful: string; identity: string; bt_same: string; bt_identity: string }>(
          `SELECT (supplier_ap_release(333, 1000, 0, 500) + supplier_ap_release(333, 1000, 0, 500))::text AS same,
                  (supplier_ap_release(333, 1000, 0, 500) + supplier_ap_release(333, 1000, 500, 500))::text AS lawful,
                  inventory_half_even(333::numeric * 1000, 1000, 0)::text AS identity,
                  (supplier_ap_release(1000, 1000, 0, 500) + supplier_ap_release(1000, 1000, 0, 500))::text AS bt_same,
                  inventory_half_even(1000::numeric * 1000, 1000, 0)::text AS bt_identity`,
        )
      ).rows[0],
      'the estate’s own release arithmetic',
    );
    expect(
      { lawful: r.lawful, identity: r.identity },
      'where B ≠ T, a chain whose positions PARTITION the total releases exactly B: Σrel = HALF_EVEN(B·T, T) = B',
    ).toEqual({ lawful: '333', identity: '333' });
    expect(
      r.same === r.identity,
      `and where B ≠ T, two reducers at the SAME position releasing the same Σa = T release ${r.same} and not ${r.identity}: the cumulative ` +
        `identity is SENSITIVE to the overlap. This is the term the cases above make refuse, on a seeded head where it is sensitive`,
    ).toBe(false);
    expect(
      r.bt_same,
      `but at B = T the SAME overlap releases ${r.bt_same}, which IS the identity's ${r.bt_identity} — rel(T,T,X,a) = a for every X, so the ` +
        `identity is blind and the per-row recurrence is the ONLY term that refuses the cross-relation overlap on a commanded invoice`,
    ).toBe(r.bt_identity);
    const live = must(
      (
        await ownerPool().query<{ total: string; cross: string }>(
          `SELECT count(*)::text AS total, count(*) FILTER (WHERE total_base_minor <> total_txn_minor)::text AS cross
             FROM invoices WHERE business_id = $1`,
          [w.shop.businessId],
        )
      ).rows[0],
      'the invoices of this business',
    );
    expect(BigInt(live.total) > 0n, `NO SUBJECT — this business has no invoice, so the disclosure below is quantified over nothing`).toBe(true);
    expect(
      live.cross,
      `THE DISCLOSURE: every invoice this business's COMMANDS created carries B = T, so no fixture built through a command can put the ` +
        `cumulative identity's teeth into the live law. That is why the invoice the cases above refuse on is SEEDED — cloned from an accepted ` +
        `row, departing from it in the rate pair that invoices_rate_shape_ck binds together — and why this count must stay at zero: it is ` +
        `read AFTER those cases, and every seed of theirs lives inside a transaction that is always rolled back. A non-zero count here would ` +
        `mean a seeded invoice had been left behind in the committed data, and every later law of this estate would then be reasoning about it`,
    ).toBe('0');
  });
});
