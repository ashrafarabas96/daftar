/**
 * P4-S4 — THE CUSTOMER-SETTLEMENT HARNESS.
 *
 * The mechanism every P4-S4 law relies on, so that it exists once. Nothing
 * here asserts a law; the suites do. Five things live here:
 *
 *   1. SUBJECT DISCOVERY AND THE CANARY. Every claim this slice makes has a
 *      subject — a relation, a column, a routine, a registry row, a route —
 *      and a claim with no subject must never pass. `settlementSubject()`
 *      reads what EXISTS from the live catalogue and from the route table, and
 *      `requireSubject()` (the accepted P4-S2 one, imported rather than
 *      re-written) throws, naming what is missing, rather than letting a suite
 *      be vacuously green. While `0081` is not applied every P4-S4 suite is
 *      therefore RED with the missing names in its message, which is the
 *      honest report and not a defect.
 *
 *   2. THE MONEY CLOSURE, MEASURED TWICE. `Σ invoice_amount_applied + credit
 *      created = amount_minor` out of the ROWS, and the ledger side of the
 *      same movement out of `journal_lines ⋈ accounts` by `system_key`. Every
 *      figure is summed IN SQL and carried as text into `BigInt`: integer
 *      minor units throughout, because a money figure read into a JS number is
 *      a float and money in this estate is never a float.
 *
 *   3. THE CHAIN. The union of `payment_allocations` and
 *      `customer_credit_applications` over ONE invoice, ordered by the chain
 *      position, so the oldest-first law can be stated as a recurrence rather
 *      than as a count.
 *
 *   4. THE PLANTER. A row cloned out of a LAWFUL row of the same relation with
 *      named overrides, through `to_jsonb` + `jsonb_populate_record` over a
 *      column list DISCOVERED from `pg_attribute`. A planted red proof that
 *      typed its own column list would be a second copy of the schema, and it
 *      would start failing on an unrelated column the day the migration owner
 *      adds one — which is the moment a red proof must still be about its own
 *      law.
 *
 *   5. THE VERIFIER'S WIRING. A direct call to `invoice_settlement_verify` is
 *      only as strong as the claim that the estate itself calls it at COMMIT,
 *      so `deferredVerifierWiring()` reads `pg_trigger` and
 *      `pg_get_functiondef` and reports which relations reach the verifier
 *      through a `DEFERRABLE INITIALLY DEFERRED` constraint trigger.
 *
 * The forced-interleaving mechanism, the deadlock ruling and the census are
 * NOT re-written here: they are imported from the accepted P4-S2 harness,
 * because a mechanism described twice drifts.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { expect } from 'vitest';
import { must, type Queryable } from '../phase4-s2/harness';
import { CHAIN, COLUMNS, ROUTINES, S4_OPERATION_KINDS, S4_RELATIONS, S4_SOURCE_TYPES, SYSTEM_KEYS } from './settlement-path';

export { must, type Queryable };

// ── 1. subject discovery and the canary ───────────────────────────────────

/** The relations of a candidate set that exist in the live catalogue right now. */
export async function existingRelations(q: Queryable, candidates: readonly string[]): Promise<readonly string[]> {
  if (candidates.length === 0) return [];
  const r = await q.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY ($1) ORDER BY 1`,
    [[...candidates]],
  );
  return r.rows.map((x) => x.relname);
}

/** The columns of one relation that exist. Empty when the relation itself is absent. */
export async function existingColumns(q: Queryable, relation: string): Promise<readonly string[]> {
  const r = await q.query<{ attname: string }>(
    `SELECT a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
    [relation],
  );
  return r.rows.map((x) => x.attname);
}

/** Does a routine of this name exist, whatever its argument list? */
export async function routineExists(q: Queryable, name: string): Promise<boolean> {
  const r = await q.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1`,
    [name],
  );
  return must(r.rows[0]).n > 0;
}

/** Is `value` present in `column` of registry `relation`? False when the relation itself is absent. */
export async function registryHas(q: Queryable, relation: string, column: string, value: string): Promise<boolean> {
  if ((await existingRelations(q, [relation])).length === 0) return false;
  const r = await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${quoteIdent(relation)} WHERE ${quoteIdent(column)} = $1`, [value]);
  return must(r.rows[0]).n > 0;
}

/** Does the business's chart carry an account with this system key? */
export async function systemAccountId(q: Queryable, businessId: string, key: string): Promise<string | null> {
  const r = await q.query<{ id: string }>(`SELECT id::text AS id FROM accounts WHERE business_id = $1 AND system_key = $2`, [businessId, key]);
  return r.rows[0]?.id ?? null;
}

export interface SettlementSubject {
  readonly relations: readonly string[];
  readonly routines: readonly string[];
  readonly sourceTypes: readonly string[];
  readonly operationKinds: readonly string[];
  /** Whether the live `invoice_outstanding` bodies — the wrapper and the set-based definition it delegates to — read the two settling relations (seam S-P4-03, map §4.2). */
  readonly readerReadsAllocations: boolean;
  readonly readerReadsCreditApplications: boolean;
  /** Everything this slice declares and the tree does not have yet. */
  readonly missing: readonly string[];
}

/**
 * What the customer-settlement primitive consists of, and which parts of it
 * exist.
 *
 * Every name checked here is a DECLARED deliverable of the slice — the
 * contract's rulings and implementation map §8 name each one — which is why
 * this function may name them at all rather than discovering them: the point
 * of the canary is to say "the subject is absent", and a subject nobody
 * declared cannot be absent.
 *
 * The seam is part of the subject. `invoice_outstanding` is the reader of
 * record (map §4.2) and a closure law measured through a reader that still
 * subtracts nothing would report `paid = 0` on a fully settled invoice and
 * call the slice broken; so a body that does not yet read the two settling
 * relations is a MISSING SUBJECT and not a failed law.
 */
export async function settlementSubject(q: Queryable): Promise<SettlementSubject> {
  const relations = await existingRelations(q, S4_RELATIONS);
  const routines: string[] = [];
  for (const name of Object.values(ROUTINES)) if (await routineExists(q, name)) routines.push(name);
  const sourceTypes: string[] = [];
  for (const t of S4_SOURCE_TYPES) if (await registryHas(q, 'accounting_source_types', 'source_type', t)) sourceTypes.push(t);
  const operationKinds: string[] = [];
  for (const k of S4_OPERATION_KINDS) if (await registryHas(q, 'inventory_operation_kinds', 'op_code', k)) operationKinds.push(k);

  /**
   * THE READER OF RECORD IS A COMPOSITION SINCE `0083`, so the seam's question
   * is asked of the composition.
   *
   * `0083` makes the settlement sum SET-BASED: the one definition is
   * `invoice_outstanding(business, invoice_id[])`, which reads both reducers in
   * one pass, and `invoice_outstanding(business, invoice)` is a THIN WRAPPER
   * over it that holds no arithmetic — which is what keeps P4-AL-07's "exactly
   * one copy of the settlement arithmetic" true. Asking only the single-invoice
   * body whether it names the reducers would therefore report the SUBJECT
   * ABSENT for a tree that reads them exactly once, which is the opposite of
   * what this canary is for.
   *
   * So the bodies of EVERY `invoice_outstanding` overload are read, and the
   * delegation is required as well: the single-invoice reader either reads the
   * reducers itself or calls another `invoice_outstanding`. A reader that
   * neither reads them nor delegates is the seam's own defect and is still
   * reported.
   */
  const bodies = (
    await q.query<{ body: string; args: string }>(
      `SELECT pg_get_functiondef(p.oid) AS body, p.oid::regprocedure::text AS args
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'invoice_outstanding'
        ORDER BY args`,
    )
  ).rows;
  const body = bodies.map((r) => r.body).join('\n');
  const single = bodies.find((r) => r.args.replace(/\s+/g, '') === 'invoice_outstanding(uuid,uuid)')?.body ?? '';
  const readerReadsAllocations = body.includes('payment_allocations');
  const readerReadsCreditApplications = body.includes('customer_credit_applications');
  const readerComposes = single !== '' && (single.includes('payment_allocations') || /invoice_outstanding\s*\(/.test(single.replace(/^[\s\S]*?AS \$/, '')));

  const missing: string[] = [];
  for (const rel of S4_RELATIONS) {
    if (!relations.includes(rel)) {
      missing.push(`relation ${rel}`);
      continue;
    }
    const have = new Set(await existingColumns(q, rel));
    const absent = COLUMNS[rel].filter((c) => !have.has(c));
    if (absent.length > 0) missing.push(`${rel} column(s) ${absent.join(', ')}`);
  }
  for (const name of Object.values(ROUTINES)) if (!routines.includes(name)) missing.push(`routine ${name}`);
  for (const t of S4_SOURCE_TYPES) if (!sourceTypes.includes(t)) missing.push(`accounting_source_types row '${t}'`);
  for (const k of S4_OPERATION_KINDS) if (!operationKinds.includes(k)) missing.push(`inventory_operation_kinds row '${k}'`);
  if (!readerReadsAllocations) missing.push(`invoice_outstanding does not read payment_allocations (seam S-P4-03)`);
  if (!readerReadsCreditApplications) missing.push(`invoice_outstanding does not read customer_credit_applications (seam S-P4-03)`);
  if (!readerComposes)
    missing.push(`invoice_outstanding(uuid, uuid) neither reads a reducer relation nor delegates to another invoice_outstanding (seam S-P4-03)`);
  return { relations, routines, sourceTypes, operationKinds, readerReadsAllocations, readerReadsCreditApplications, missing };
}

/**
 * The route half of the subject: a route that is not mounted answers `404`,
 * and every other status — including `400`, `401`, `403` and `422` — means the
 * route is there and the request was judged.
 *
 * Probed rather than read out of the source, because a route listed in an
 * authority table and never mounted is exactly the failure a suite must not
 * mistake for a refusal: a `404` read as "the command refused me" is a green
 * law about nothing.
 */
export async function routeMounted(send: () => Promise<{ status: number }>): Promise<boolean> {
  const res = await send();
  return res.status !== 404;
}

// ── 2. the money closure ──────────────────────────────────────────────────

export interface PaymentClosure {
  /** `payments.amount_minor` — the money received, a document fact, in the PAYMENT's currency. */
  readonly amountMinor: bigint;
  /** `Σ payment_allocations.payment_amount_minor` — what the legs consumed, in the SAME currency. */
  readonly consumedMinor: bigint;
  /** `Σ customer_credits.original_amount_minor` born from this payment — also in the payment's currency. */
  readonly creditCreatedMinor: bigint;
  /** `payments.base_amount_minor` — the base side of the same document fact. */
  readonly baseAmountMinor: bigint;
  /** `Σ payment_allocations.payment_base_amount_minor`. */
  readonly consumedBaseMinor: bigint;
  /** `Σ customer_credits.original_carrying_base_amount_minor` born from this payment. */
  readonly creditCreatedBaseMinor: bigint;
  /** `Σ payment_allocations.invoice_amount_applied_minor` — the INVOICE-side figure, a different currency's units. */
  readonly appliedInvoiceMinor: bigint;
  /** `payments.allocation_count`, and the number of rows that actually exist. */
  readonly allocationCount: number;
  readonly allocationRows: number;
}

/**
 * THE CLOSURE, OUT OF THE ROWS:
 *
 *     Σ payment_amount_minor + credit created = amount_minor          (payment currency)
 *     Σ payment_base_amount_minor + credit carrying base = base_amount_minor   (base)
 *
 * IN THE PAYMENT'S CURRENCY, and the base identity alongside it. This is the
 * coordinator's binding correction to the contract's OQ-4 wording, and it is
 * the accepted supplier law (`0067:950-955`): `invoice_amount_applied_minor`
 * is denominated in the INVOICE's currency while `amount_minor` is in the
 * payment's, so adding the one to the other is adding two different units and
 * the "closure" would be an arithmetic coincidence whenever they happened to
 * agree. `appliedInvoiceMinor` is read anyway, and it is the subject of the
 * CHAIN law — which lives on the invoice and is therefore in the invoice's
 * units — never of this one.
 *
 * The base identity must count the surplus credit's
 * `original_carrying_base_amount_minor`, or a pure on-account collection —
 * zero allocations, which is in scope — has no base side at all.
 *
 * Every figure is summed in SQL in integer minor units and carried as text.
 * `coalesce(..., 0)` on each sum is load-bearing and is NOT a vacuity hole: a
 * payment with no allocation is lawful and its consumed total is genuinely
 * zero, which is the whole of the zero-allocation law. The non-vacuity this
 * reader owes instead is that `amount_minor` itself is positive, which the
 * caller asserts.
 */
export async function paymentClosure(q: Queryable, businessId: string, paymentId: string): Promise<PaymentClosure> {
  const r = await q.query<{
    amount_minor: string;
    base_amount_minor: string;
    consumed_minor: string;
    consumed_base_minor: string;
    applied_invoice_minor: string;
    credit_created_minor: string;
    credit_created_base_minor: string;
    allocation_count: number;
    allocation_rows: number;
  }>(
    `SELECT p.amount_minor::text      AS amount_minor,
            p.base_amount_minor::text AS base_amount_minor,
            p.allocation_count        AS allocation_count,
            (SELECT coalesce(sum(a.payment_amount_minor), 0)::text FROM payment_allocations a
              WHERE a.business_id = p.business_id AND a.payment_id = p.id)                     AS consumed_minor,
            (SELECT coalesce(sum(a.payment_base_amount_minor), 0)::text FROM payment_allocations a
              WHERE a.business_id = p.business_id AND a.payment_id = p.id)                     AS consumed_base_minor,
            (SELECT coalesce(sum(a.invoice_amount_applied_minor), 0)::text FROM payment_allocations a
              WHERE a.business_id = p.business_id AND a.payment_id = p.id)                     AS applied_invoice_minor,
            (SELECT count(*)::int FROM payment_allocations a
              WHERE a.business_id = p.business_id AND a.payment_id = p.id)                     AS allocation_rows,
            (SELECT coalesce(sum(cc.original_amount_minor), 0)::text FROM customer_credits cc
              WHERE cc.business_id = p.business_id AND cc.origin_payment_id = p.id)            AS credit_created_minor,
            (SELECT coalesce(sum(cc.original_carrying_base_amount_minor), 0)::text FROM customer_credits cc
              WHERE cc.business_id = p.business_id AND cc.origin_payment_id = p.id)            AS credit_created_base_minor
       FROM payments p
      WHERE p.business_id = $1 AND p.id = $2`,
    [businessId, paymentId],
  );
  const row = must(r.rows[0], `payment ${paymentId}`);
  return {
    amountMinor: BigInt(row.amount_minor),
    consumedMinor: BigInt(row.consumed_minor),
    creditCreatedMinor: BigInt(row.credit_created_minor),
    baseAmountMinor: BigInt(row.base_amount_minor),
    consumedBaseMinor: BigInt(row.consumed_base_minor),
    creditCreatedBaseMinor: BigInt(row.credit_created_base_minor),
    appliedInvoiceMinor: BigInt(row.applied_invoice_minor),
    allocationCount: row.allocation_count,
    allocationRows: row.allocation_rows,
  };
}

/**
 * THE CLOSURE in the payment's currency, as a function of the measured figures
 * rather than as an inline comparison, so the identity can be proved able to
 * refuse on synthetic figures. An identity that has only ever been handed a
 * real measurement is an identity nobody has watched say no.
 *
 * Zero is lawful; anything else is money the document cannot account for — a
 * positive residue is money that arrived and went nowhere, a negative one is
 * money the document conjured.
 */
export function closureResidue(c: Pick<PaymentClosure, 'amountMinor' | 'consumedMinor' | 'creditCreatedMinor'>): bigint {
  return c.amountMinor - c.consumedMinor - c.creditCreatedMinor;
}

/** The same identity on the BASE side, where the surplus credit contributes its carrying base. */
export function closureResidueBase(c: Pick<PaymentClosure, 'baseAmountMinor' | 'consumedBaseMinor' | 'creditCreatedBaseMinor'>): bigint {
  return c.baseAmountMinor - c.consumedBaseMinor - c.creditCreatedBaseMinor;
}

/**
 * The signed balance of ONE system account of ONE business, out of
 * `journal_lines ⋈ accounts` BY `system_key`, plus how many lines it was read
 * over.
 *
 * By identity and never by a typed account code: a code typed into a test is a
 * second copy of the chart, and the day the chart moves the test agrees with
 * the copy rather than with the estate. The line count travels with the figure
 * so a caller can refuse `0 == 0` over no lines at all.
 */
export async function ledgerBalance(q: Queryable, businessId: string, systemKey: string): Promise<{ readonly minor: bigint; readonly lines: number }> {
  const r = await q.query<{ n: string; lines: number }>(
    `SELECT coalesce(sum(l.debit_minor - l.credit_minor), 0)::text AS n, count(*)::int AS lines
       FROM journal_lines l JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
      WHERE l.business_id = $1 AND a.system_key = $2`,
    [businessId, systemKey],
  );
  const row = must(r.rows[0], `ledger balance for ${systemKey}`);
  return { minor: BigInt(row.n), lines: row.lines };
}

/** The same, restricted to the lines of ONE journal entry. */
export async function entryLines(
  q: Queryable,
  businessId: string,
  entryId: string,
): Promise<readonly { readonly systemKey: string | null; readonly debitMinor: bigint; readonly creditMinor: bigint }[]> {
  const r = await q.query<{ system_key: string | null; debit_minor: string; credit_minor: string }>(
    `SELECT a.system_key::text AS system_key, l.debit_minor::text AS debit_minor, l.credit_minor::text AS credit_minor
       FROM journal_lines l JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
      WHERE l.business_id = $1 AND l.journal_entry_id = $2
      ORDER BY a.system_key, l.debit_minor, l.credit_minor`,
    [businessId, entryId],
  );
  return r.rows.map((x) => ({ systemKey: x.system_key, debitMinor: BigInt(x.debit_minor), creditMinor: BigInt(x.credit_minor) }));
}

/** The entry bound to one source row, by the binding — never by guessing an order. */
export async function entryOfSource(q: Queryable, businessId: string, sourceType: string, sourceId: string): Promise<string | null> {
  const r = await q.query<{ id: string }>(
    `SELECT b.journal_entry_id::text AS id FROM accounting_source_bindings b
      WHERE b.business_id = $1 AND b.source_type = $2 AND b.source_id = $3`,
    [businessId, sourceType, sourceId],
  );
  return r.rows[0]?.id ?? null;
}

/** The AR system key and the credit-liability system key, named once so no suite types a code. */
export const AR_KEY = SYSTEM_KEYS.accountsReceivable;
export const CREDIT_LIABILITY_KEY = SYSTEM_KEYS.customerCreditLiability;

// ── 3. the chain over one invoice ─────────────────────────────────────────

export interface ChainStep {
  /** Which relation the step came from, so a gap can be reported against the right source. */
  readonly relation: 'payment_allocations' | 'customer_credit_applications';
  readonly id: string;
  /** `X` — the position this step was computed from. */
  readonly positionMinor: bigint;
  /** `a` — the one amount this step applies. */
  readonly appliedMinor: bigint;
  /** `rel` — the base carrying this step released. */
  readonly releasedBaseMinor: bigint;
  readonly createdAt: string;
}

/**
 * THE CHAIN over one invoice: the union of both settling relations, ordered by
 * the chain position.
 *
 * Ordered by the POSITION and not by `created_at`. The oldest-first law is a
 * law about the chain and not about the wall clock: two rows written in the
 * same transaction share a `created_at` to the microsecond, and a law that
 * ordered by it would be reporting the host's timestamp resolution. The
 * `created_at` is carried anyway, so a suite can state that position order and
 * arrival order agree without making the clock the authority.
 */
export async function invoiceChain(q: Queryable, businessId: string, invoiceId: string): Promise<readonly ChainStep[]> {
  const r = await q.query<{
    relation: string;
    id: string;
    position_minor: string;
    applied_minor: string;
    released_base_minor: string;
    created_at: string;
  }>(
    // The UNION goes in a FROM clause, and the sort is applied outside it.
    // `ORDER BY position_minor::bigint` directly after a UNION is a syntax
    // error in PostgreSQL — "Only result column names can be used, not
    // expressions or functions" — and the column has to be sorted AS A NUMBER,
    // because the positions are text here and `'1000' < '900'` lexically would
    // reorder the chain and make every gap-and-overlap assertion read a
    // sequence the database never held.
    `SELECT relation, id, position_minor, applied_minor, released_base_minor, created_at
       FROM (
         SELECT 'payment_allocations' AS relation, a.id::text AS id,
                a.${CHAIN.position} AS position_sort, a.${CHAIN.position}::text AS position_minor,
                a.${CHAIN.applied}::text AS applied_minor,
                a.invoice_carrying_base_released_minor::text AS released_base_minor, a.created_at::text AS created_at
           FROM payment_allocations a WHERE a.business_id = $1 AND a.invoice_id = $2
         UNION ALL
         SELECT 'customer_credit_applications' AS relation, c.id::text AS id,
                c.${CHAIN.position} AS position_sort, c.${CHAIN.position}::text AS position_minor,
                c.${CHAIN.applied}::text AS applied_minor,
                c.invoice_carrying_base_released_minor::text AS released_base_minor, c.created_at::text AS created_at
           FROM customer_credit_applications c WHERE c.business_id = $1 AND c.invoice_id = $2
       ) chain
      ORDER BY position_sort`,
    [businessId, invoiceId],
  );
  return r.rows.map((x) => ({
    relation: x.relation as ChainStep['relation'],
    id: x.id,
    positionMinor: BigInt(x.position_minor),
    appliedMinor: BigInt(x.applied_minor),
    releasedBaseMinor: BigInt(x.released_base_minor),
    createdAt: x.created_at,
  }));
}

export interface ChainBreak {
  readonly index: number;
  readonly expectedPosition: string;
  readonly actualPosition: string;
  readonly kind: 'gap' | 'overlap';
}

/**
 * The chain's defects, as DATA rather than as an assertion, so the law can be
 * proved able to say no on synthetic chains. An inequality that has only ever
 * been handed a real measurement is an inequality nobody has watched refuse
 * anything.
 *
 * The law: the chain starts at zero and each step's position is the previous
 * position plus the previous applied amount. A position ABOVE that is a gap —
 * an amount of the invoice nothing accounted for; a position BELOW it is an
 * overlap — the same amount of the invoice released twice.
 */
export function chainBreaks(steps: readonly Pick<ChainStep, 'positionMinor' | 'appliedMinor'>[]): readonly ChainBreak[] {
  const breaks: ChainBreak[] = [];
  let expected = 0n;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    if (step === undefined) continue;
    if (step.positionMinor !== expected)
      breaks.push({
        index: i,
        expectedPosition: expected.toString(),
        actualPosition: step.positionMinor.toString(),
        kind: step.positionMinor > expected ? 'gap' : 'overlap',
      });
    expected = step.positionMinor + step.appliedMinor;
  }
  return breaks;
}

/** `Σ a` and `Σ rel` over a chain, in integer minor units. */
export function chainTotals(steps: readonly ChainStep[]): { readonly applied: bigint; readonly released: bigint } {
  return {
    applied: steps.reduce((acc, s) => acc + s.appliedMinor, 0n),
    released: steps.reduce((acc, s) => acc + s.releasedBaseMinor, 0n),
  };
}

export interface DerivedRead {
  readonly paidTxnMinor: bigint;
  readonly paidBaseMinor: bigint;
  readonly outstandingTxnMinor: bigint;
  readonly outstandingBaseMinor: bigint;
  readonly state: string;
}

/** The reader of record's four figures and the state derived from them (map §4.2). */
export async function derivedRead(q: Queryable, businessId: string, invoiceId: string): Promise<DerivedRead> {
  const r = await q.query<{ p: string; pb: string; o: string; ob: string; state: string }>(
    `SELECT o.paid_txn_minor::text AS p, o.paid_base_minor::text AS pb,
            o.outstanding_txn_minor::text AS o, o.outstanding_base_minor::text AS ob,
            invoice_settlement_state($1, $2) AS state
       FROM invoice_outstanding($1::uuid, $2::uuid) o`,
    [businessId, invoiceId],
  );
  const row = must(r.rows[0], `invoice_outstanding for ${invoiceId}`);
  return {
    paidTxnMinor: BigInt(row.p),
    paidBaseMinor: BigInt(row.pb),
    outstandingTxnMinor: BigInt(row.o),
    outstandingBaseMinor: BigInt(row.ob),
    state: row.state,
  };
}

export interface InvoiceSnapshot {
  readonly totalTxnMinor: string;
  readonly totalBaseMinor: string;
  readonly currencyCode: string;
  readonly customerId: string | null;
  /** `invoices.source_to_base_rate` — the invoice's OWN historical snapshot `R`, as the database stores it. */
  readonly sourceToBaseRate: string;
  /**
   * An INVOICE's `rate_source` admits three values (`0075:265`); a payment's
   * and a credit's admit only `'base'` and `'manual'`, because
   * `accounting_fx_rates.source` is CHECK-pinned to exactly `'manual'`
   * (`0048:88`) and so there is no provider rate in the estate to read.
   * `'base'` is the estate saying the rate is structurally 1.
   */
  readonly rateSource: string;
}

/**
 * One invoice's stored totals AND its own rate snapshot — which is what every
 * release and every AR dust figure is computed from, and which is read back
 * rather than assumed. A suite that assumed the invoice's rate would be
 * asserting against its own arithmetic instead of against the document.
 */
export async function invoiceTotals(q: Queryable, businessId: string, invoiceId: string): Promise<InvoiceSnapshot> {
  const r = await q.query<{ t: string; b: string; c: string; cust: string | null; rate: string; src: string }>(
    `SELECT total_txn_minor::text AS t, total_base_minor::text AS b, currency_code::text AS c, customer_id::text AS cust,
            source_to_base_rate::text AS rate, rate_source AS src
       FROM invoices WHERE business_id = $1 AND id = $2`,
    [businessId, invoiceId],
  );
  const row = must(r.rows[0], `invoice ${invoiceId}`);
  return { totalTxnMinor: row.t, totalBaseMinor: row.b, currencyCode: row.c, customerId: row.cust, sourceToBaseRate: row.rate, rateSource: row.src };
}

/** The payment's own stored snapshot, read back the same way. */
export async function paymentSnapshot(
  q: Queryable,
  businessId: string,
  paymentId: string,
): Promise<{ readonly currencyCode: string; readonly paymentToBaseRate: string; readonly rateSource: string; readonly fxRateId: string | null }> {
  const r = await q.query<{ c: string; rate: string; src: string; fx: string | null }>(
    `SELECT currency_code::text AS c, payment_to_base_rate::text AS rate, rate_source AS src, fx_rate_id::text AS fx
       FROM payments WHERE business_id = $1 AND id = $2`,
    [businessId, paymentId],
  );
  const row = must(r.rows[0], `payment ${paymentId}`);
  return { currencyCode: row.c, paymentToBaseRate: row.rate, rateSource: row.src, fxRateId: row.fx };
}

/** The credit's own stored snapshot and its immutable original pair. */
export async function creditSnapshot(
  q: Queryable,
  businessId: string,
  creditId: string,
): Promise<{
  readonly currencyCode: string;
  readonly creditToBaseRate: string;
  readonly originalAmountMinor: string;
  readonly originalCarryingBaseAmountMinor: string;
  readonly remainingAmountMinor: string;
  readonly remainingCarryingBaseAmountMinor: string;
}> {
  const r = await q.query<{ c: string; rate: string; oa: string; ob: string; ra: string; rb: string }>(
    `SELECT currency_code::text AS c, credit_to_base_rate::text AS rate,
            original_amount_minor::text AS oa, original_carrying_base_amount_minor::text AS ob,
            remaining_amount_minor::text AS ra, remaining_carrying_base_amount_minor::text AS rb
       FROM customer_credits WHERE business_id = $1 AND id = $2`,
    [businessId, creditId],
  );
  const row = must(r.rows[0], `customer credit ${creditId}`);
  return {
    currencyCode: row.c,
    creditToBaseRate: row.rate,
    originalAmountMinor: row.oa,
    originalCarryingBaseAmountMinor: row.ob,
    remainingAmountMinor: row.ra,
    remainingCarryingBaseAmountMinor: row.rb,
  };
}

/** The business's base currency, read from the business row and never typed into a suite. */
export async function baseCurrencyOf(q: Queryable, businessId: string): Promise<string> {
  const r = await q.query<{ c: string }>(`SELECT base_currency::text AS c FROM businesses WHERE id = $1`, [businessId]);
  return must(r.rows[0], `business ${businessId}`).c;
}

// ── 4. the planter ───────────────────────────────────────────────────────

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`refusing to interpolate the identifier ${JSON.stringify(name)}`);
  return `"${name}"`;
}

/**
 * The columns of `relation` that may appear in an INSERT column list: every
 * live attribute that is not GENERATED.
 *
 * Discovered, because a planted red proof that typed its own column list is a
 * second copy of the schema: it would silently stop inserting a column the
 * migration owner adds, and the proof would then fail on a NOT NULL violation
 * instead of on the law it exists to exercise.
 */
export async function insertableColumns(q: Queryable, relation: string): Promise<readonly string[]> {
  const r = await q.query<{ attname: string }>(
    `SELECT a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = $1 AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
      ORDER BY a.attnum`,
    [relation],
  );
  if (r.rows.length === 0) throw new Error(`NO SUBJECT — ${relation} has no insertable column, so nothing can be planted in it`);
  return r.rows.map((x) => x.attname);
}

/**
 * Clone one LAWFUL row of `relation` into a new row of the same relation, with
 * `overrides` applied, and return the new row's id.
 *
 * Why cloning rather than composing: a row this estate accepts satisfies two
 * dozen CHECKs, three composite FKs and a recomputed-value identity, and a
 * hand-composed row fails the FIRST of those rather than the law under test —
 * so the proof would be green for the wrong reason, or red for the wrong one.
 * A clone departs from an accepted row in EXACTLY the ways named in
 * `overrides`, which is the one-departure-at-a-time discipline the accepted
 * negative tests already use.
 *
 * The caller must run this inside its own transaction with the business GUCs
 * set, and must not commit it: the point is to reach the deferred verifier,
 * not to leave a planted row behind.
 */
export async function cloneRow(
  c: Queryable,
  relation: string,
  businessId: string,
  sourceId: string,
  overrides: Readonly<Record<string, string | number | null>>,
): Promise<void> {
  const columns = await insertableColumns(c, relation);
  for (const key of Object.keys(overrides))
    if (!columns.includes(key)) throw new Error(`cloneRow: ${relation} has no insertable column ${key}, so the override would be silently dropped`);
  const list = columns.map(quoteIdent).join(', ');
  const r = await c.query(
    `INSERT INTO ${quoteIdent(relation)} (${list})
     SELECT ${list} FROM (
       SELECT (jsonb_populate_record(NULL::${quoteIdent(relation)}, to_jsonb(src) || $3::jsonb)).*
         FROM ${quoteIdent(relation)} src WHERE src.business_id = $1 AND src.id = $2
     ) q`,
    [businessId, sourceId, JSON.stringify(overrides)],
  );
  // A clone of an absent row inserts nothing, and a planted proof that planted
  // nothing would then "pass" because the law had nothing to refuse.
  if (r.rowCount !== 1) throw new Error(`cloneRow: ${relation} row (${businessId}, ${sourceId}) is absent, so nothing was planted and no law was exercised`);
}

/**
 * PLANT A SETTLEMENT ROW SO THAT THE LAW UNDER TEST IS THE ONE THAT ANSWERS.
 *
 * Every settling relation of `0081` carries a BEFORE INSERT guard that refuses
 * a row written outside its own command's transaction:
 *
 *   - `payment_allocation_guard()` (`0081:945-953`) demands the row's
 *     `created_at = now()` AND that its PAYMENT was created by this very
 *     transaction — the payment's `created_at = now()` and its
 *     `business_transaction_id = inventory_business_transaction_id()`;
 *   - `customer_credit_application_guard()` (`0081:1087-1090`) demands the
 *     row's own `created_at = now()` and matching trace.
 *
 * A plant that cloned an accepted row therefore died on `P0001
 * customer_payment.immutable` BEFORE reaching the deferred verifier or the
 * unique index it was aimed at, and the proof proved nothing about the law it
 * names. This helper satisfies the immutability guards and NOTHING ELSE, so
 * the next thing to speak is the law under test:
 *
 *   - it sets `app.business_transaction_id` to a fresh trace;
 *   - it stamps `created_at` from the transaction's OWN `now()`, read back
 *     rather than written as a literal, because the guards compare for exact
 *     equality;
 *   - for `payment_allocations` it first clones the owning PAYMENT under that
 *     trace, so the planted allocation has a payment of this transaction to
 *     join, and gives that payment its own `intent_sha256` because two
 *     payments may not share one document digest.
 *
 * It deliberately does not touch the deferred COMMIT verifiers: the caller runs
 * inside `inRolledBackTx`, so they never fire, and the caller either invokes the
 * verifier directly or lets an immediate constraint answer.
 */
export async function plantSettlementRow(
  c: Client,
  relation: 'payment_allocations' | 'customer_credit_applications',
  businessId: string,
  sourceId: string,
  overrides: Readonly<Record<string, string | number | null>>,
): Promise<void> {
  const trace = randomUUID();
  const stamp = await c.query<{ now: string }>(`SELECT now()::text AS now`);
  const createdAt = must(stamp.rows[0], 'the planting transaction’s own now()').now;
  await c.query(`SELECT set_config('app.business_transaction_id', $1, true)`, [trace]);

  const own: Record<string, string | number | null> = { created_at: createdAt };
  if (relation === 'payment_allocations') {
    const owner = await c.query<{ payment_id: string }>(`SELECT payment_id::text AS payment_id FROM payment_allocations WHERE business_id = $1 AND id = $2`, [
      businessId,
      sourceId,
    ]);
    const sourcePaymentId = must(owner.rows[0], `the payment of allocation ${sourceId}`).payment_id;
    const paymentId = randomUUID();
    await cloneRow(c, 'payments', businessId, sourcePaymentId, {
      id: paymentId,
      business_transaction_id: trace,
      created_at: createdAt,
      intent_sha256: createHash('sha256').update(paymentId).digest('hex'),
    });
    own['payment_id'] = paymentId;
  } else {
    own['business_transaction_id'] = trace;
  }
  await cloneRow(c, relation, businessId, sourceId, { ...own, ...overrides });
}

export interface VerifierWiring {
  readonly relation: string;
  readonly trigger: string;
  readonly deferred: boolean;
  readonly functionName: string;
  /** Whether the trigger function's live body reaches the chain verifier. */
  readonly reachesVerifier: boolean;
}

/**
 * Which relations reach `invoice_settlement_verify` through a
 * `DEFERRABLE INITIALLY DEFERRED` constraint trigger, read out of the LIVE
 * catalogue.
 *
 * This is what makes a DIRECT call to the verifier a proof about the estate
 * rather than a proof about a function nobody runs. A routine REPLACED by a
 * later migration is the one that executes, so the body is read with
 * `pg_get_functiondef` and never out of a migration file.
 */
export async function deferredVerifierWiring(q: Queryable): Promise<readonly VerifierWiring[]> {
  const r = await q.query<{ relation: string; trigger: string; deferred: boolean; fn: string; body: string }>(
    `SELECT cl.relname AS relation, t.tgname AS trigger, t.tginitdeferred AS deferred,
            p.proname AS fn, pg_get_functiondef(p.oid) AS body
       FROM pg_trigger t
       JOIN pg_class cl ON cl.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = cl.relnamespace
       JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE n.nspname = 'public' AND NOT t.tgisinternal AND t.tgconstraint <> 0
        AND cl.relname = ANY ($1)
      ORDER BY cl.relname, t.tgname`,
    [[...S4_RELATIONS]],
  );
  return r.rows.map((x) => ({
    relation: x.relation,
    trigger: x.trigger,
    deferred: x.deferred,
    functionName: x.fn,
    reachesVerifier: x.body.includes(ROUTINES.invoiceSettlementVerify),
  }));
}

/**
 * Run `work` inside a transaction on its own connection with the business
 * GUCs set, and ALWAYS roll it back.
 *
 * Every planted red proof below runs here. The rollback is unconditional and
 * in a `finally`: a planted violation that committed because the law did not
 * refuse it would poison every later law of the suite, and the suite would
 * then report a cascade instead of the one finding.
 */
export async function inRolledBackTx<T>(
  open: () => Promise<Client>,
  scope: { readonly tenantId: string; readonly businessId: string },
  work: (c: Client) => Promise<T>,
): Promise<T> {
  const c = await open();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [scope.tenantId, scope.businessId]);
    return await work(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end().catch(() => undefined);
  }
}

/**
 * The message and SQLSTATE of whatever `work` raised, or `null` when it raised
 * nothing. A planted proof that raised NOTHING is a failure of the law, so the
 * `null` is returned rather than thrown and the caller states what it means.
 */
export async function raised(work: () => Promise<unknown>): Promise<{ readonly message: string; readonly code: string | undefined } | null> {
  try {
    await work();
    return null;
  } catch (e) {
    const err = e as { message?: unknown; code?: unknown };
    return { message: String(err.message ?? e), code: typeof err.code === 'string' ? err.code : undefined };
  }
}

/** Non-vacuity for a law asserted over rows: a law quantified over nothing proved nothing. */
export function expectSomeSubject<T>(rows: readonly T[], claim: string): readonly T[] {
  expect(rows.length, `NO SUBJECT — "${claim}" was quantified over an empty set, so it proved nothing`).toBeGreaterThan(0);
  return rows;
}
