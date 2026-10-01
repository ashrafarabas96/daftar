/**
 * P4-S2 — THE ATOMIC SALE LAW, AS A PURE FUNCTION OF COMMITTED STATE.
 * (docs/PHASE_4_ARCHITECTURE_LOCK.md §15, P4-AL-16, P4-AL-20, P4-AL-23,
 *  P4-AL-25, P4-AL-49 `R-SAL-03`/`R-SAL-07`;
 *  docs/PHASE_4_S2_GOLDEN_AND_CONCURRENCY_DESIGN.md §4.)
 *
 * P4-AL-16 says there is never a committed state in which stock left the shelf
 * and no invoice exists, or an invoice exists and no movement was written. The
 * seven states the slice must make unreachable are listed in `LAWS` below.
 *
 * ── WHY THIS IS A PURE FUNCTION AND NOT A LIST OF SQL STATEMENTS ──────────
 *
 * Because a law has to be able to SAY NO, and a law written as a `SELECT` that
 * a suite asserts returns no row can only be proved able to say no by planting
 * a violation in a real database — which means a scratch cluster, a writer
 * nobody has yet, and a migration this agent may not write. A law written over
 * a PROJECTION of the committed state is proved able to say no by handing it a
 * projection that violates it, which `tests/guards/sale-s2-red-proofs.test.ts`
 * does for every one of the seven, in milliseconds, forever.
 *
 * The projection is read by one query per relation and nothing is computed in
 * SQL, so there is no second expression of any law anywhere.
 *
 * ── NON-VACUITY ───────────────────────────────────────────────────────────
 *
 * `L0` is the canary INSIDE the law: a world with no sale satisfies all seven
 * universally-quantified laws, and a reviewer reading "the atomic sale law
 * holds" over an empty database has been told nothing. A world with no sale is
 * therefore itself a violation.
 *
 * Nothing here is an equality over a set a later phase populates
 * (`[[daftar-a-closure-rule-is-not-an-invariant]]`, P4-AL-88): every law is of
 * the form "for every X that exists, Y", so S4's payments, S5's credit notes
 * and S6's reversals arriving does not make one of these sentences false.
 */

/** A stock movement, projected. `value_delta_base_minor` as a string: money is never a float. */
export interface MovementRow {
  readonly sourceType: string;
  readonly sourceId: string;
  readonly valueDeltaBaseMinor: string;
}

export interface SaleRow {
  readonly id: string;
}

export interface SaleItemRow {
  readonly saleId: string;
}

export interface InvoiceRow {
  readonly id: string;
  readonly saleId: string;
  /** `draft | open | void` (`0075:257`). */
  readonly status: string;
  readonly bindingSourceId: string | null;
}

export interface InvoiceItemRow {
  readonly invoiceId: string;
}

export interface BindingRow {
  readonly sourceType: string;
  readonly sourceId: string;
  readonly journalEntryId: string;
}

/** A journal entry, with the SYSTEM KEYS its lines touch — identities, never codes. */
export interface EntryRow {
  readonly id: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly systemKeys: readonly string[];
}

export interface SaleWorld {
  readonly sales: readonly SaleRow[];
  readonly saleItems: readonly SaleItemRow[];
  readonly invoices: readonly InvoiceRow[];
  readonly invoiceItems: readonly InvoiceItemRow[];
  readonly movements: readonly MovementRow[];
  readonly bindings: readonly BindingRow[];
  readonly entries: readonly EntryRow[];
}

/** The source type a sale's stock movements carry (P4-AL-29b: the `sale` stock source). */
export const SALE_STOCK_SOURCE = 'sale';
/** The two accounting source types P4-S2 registers (execution plan S2 row, `TL-P4-S1-R1`). */
export const SALE_ACCOUNTING_SOURCE = 'sale';
export const INVOICE_ACCOUNTING_SOURCE = 'invoice';
/** The engine identities of the three accounts a sale touches (`0040:53,59,63`). */
export const INVENTORY_KEY = 'inventory';
export const COGS_KEY = 'cogs';
export const REVENUE_KEY = 'sales_revenue';

export interface Law {
  readonly id: string;
  /** The committed state this law makes unreachable, in the words of §15. */
  readonly forbids: string;
  readonly check: (w: SaleWorld) => readonly string[];
}

const ids = <T>(rows: readonly T[], of: (r: T) => string): ReadonlySet<string> => new Set(rows.map(of));

export const LAWS: readonly Law[] = [
  {
    id: 'L0',
    forbids: 'a verdict on the atomic sale law reached over a database that contains no sale',
    check: (w) =>
      w.sales.length === 0
        ? ['NO SUBJECT: the atomic sale law was evaluated over a world with no sale, so every law below held vacuously and nothing was proved']
        : [],
  },
  {
    id: 'L1',
    forbids: 'a sale with no stock movement',
    check: (w) => {
      const moved = ids(
        w.movements.filter((m) => m.sourceType === SALE_STOCK_SOURCE),
        (m) => m.sourceId,
      );
      return w.sales.filter((s) => !moved.has(s.id)).map((s) => `L1: sale ${s.id} committed with no stock movement`);
    },
  },
  {
    id: 'L2',
    forbids: 'a stock movement with no invoice',
    check: (w) => {
      const invoiced = ids(w.invoices, (i) => i.saleId);
      return w.movements
        .filter((m) => m.sourceType === SALE_STOCK_SOURCE && !invoiced.has(m.sourceId))
        .map((m) => `L2: stock movement for sale ${m.sourceId} committed with no invoice`);
    },
  },
  {
    id: 'L3',
    forbids: 'an invoice with no accounting binding',
    check: (w) => {
      const bound = ids(
        w.bindings.filter((b) => b.sourceType === INVOICE_ACCOUNTING_SOURCE),
        (b) => b.sourceId,
      );
      const out: string[] = [];
      for (const i of w.invoices) {
        if (i.status === 'draft') continue; // a draft owes no binding (`0075:300`)
        if (i.bindingSourceId !== i.id) out.push(`L3: invoice ${i.id} is ${i.status} and its binding_source_id is ${String(i.bindingSourceId)}`);
        if (!bound.has(i.id)) out.push(`L3: invoice ${i.id} is ${i.status} and no accounting_source_bindings row names it`);
      }
      return out;
    },
  },
  {
    id: 'L4',
    forbids: 'a COGS entry with no commercial source',
    check: (w) => {
      const sales = ids(w.sales, (s) => s.id);
      const out: string[] = [];
      for (const e of w.entries) {
        if (!e.systemKeys.includes(COGS_KEY)) continue;
        if (e.sourceType !== SALE_ACCOUNTING_SOURCE) out.push(`L4: COGS entry ${e.id} is bound to source type ${e.sourceType}, not to a sale`);
        else if (!sales.has(e.sourceId)) out.push(`L4: COGS entry ${e.id} names sale ${e.sourceId}, which does not exist`);
      }
      return out;
    },
  },
  {
    id: 'L5',
    forbids: 'a revenue entry without an invoice',
    check: (w) => {
      const invoices = ids(w.invoices, (i) => i.id);
      const out: string[] = [];
      for (const e of w.entries) {
        if (!e.systemKeys.includes(REVENUE_KEY)) continue;
        if (e.sourceType !== INVOICE_ACCOUNTING_SOURCE) out.push(`L5: revenue entry ${e.id} is bound to source type ${e.sourceType}, not to an invoice`);
        else if (!invoices.has(e.sourceId)) out.push(`L5: revenue entry ${e.id} names invoice ${e.sourceId}, which does not exist`);
      }
      return out;
    },
  },
  {
    id: 'L6',
    forbids: 'an inventory decrement without COGS',
    check: (w) => {
      const cogsFor = ids(
        w.entries.filter((e) => e.systemKeys.includes(COGS_KEY) && e.sourceType === SALE_ACCOUNTING_SOURCE),
        (e) => e.sourceId,
      );
      const out: string[] = [];
      for (const m of w.movements) {
        if (m.sourceType !== SALE_STOCK_SOURCE) continue;
        if (BigInt(m.valueDeltaBaseMinor) >= 0n) continue;
        if (!cogsFor.has(m.sourceId)) out.push(`L6: sale ${m.sourceId} decremented inventory by ${m.valueDeltaBaseMinor} with no COGS entry`);
      }
      return out;
    },
  },
  {
    id: 'L7',
    forbids: 'a partial sale: a sale or an invoice committed without its lines, or an entry without its binding',
    check: (w) => {
      const saleLines = ids(w.saleItems, (r) => r.saleId);
      const invoiceLines = ids(w.invoiceItems, (r) => r.invoiceId);
      const boundEntries = ids(w.bindings, (b) => b.journalEntryId);
      return [
        ...w.sales.filter((s) => !saleLines.has(s.id)).map((s) => `L7: sale ${s.id} committed with no sale_items row`),
        ...w.invoices.filter((i) => !invoiceLines.has(i.id)).map((i) => `L7: invoice ${i.id} committed with no invoice_items row`),
        ...w.entries.filter((e) => !boundEntries.has(e.id)).map((e) => `L7: journal entry ${e.id} committed with no accounting_source_bindings row`),
      ];
    },
  },
];

/** Every violation of every law, in law order. Empty means the atomic sale law held — over a non-empty world. */
export function atomicSaleLawViolations(world: SaleWorld): readonly string[] {
  return LAWS.flatMap((l) => l.check(world));
}

// ── reading the committed state ───────────────────────────────────────────

/**
 * Project the committed state of ONE business into a `SaleWorld`: one query
 * per relation, no law expressed in SQL, and every relation read only if it
 * exists — a relation a later slice has not created yet projects as empty, and
 * `L0` is what stops that emptiness from reading as a pass.
 *
 * The owner connection is used on purpose: RLS must never be the reason a law
 * saw no violation (`[[no weakening RLS for tests]]` cuts both ways — a test
 * that reads through a policy can be green because the policy hid the defect).
 */
export async function readSaleWorld(
  q: { query: (text: string, values?: readonly unknown[]) => Promise<{ rows: Record<string, never>[] | unknown[] }> },
  businessId: string,
  relationExists: (relation: string) => boolean,
): Promise<SaleWorld> {
  const rows = async <T>(relation: string, text: string): Promise<readonly T[]> =>
    relationExists(relation) ? ((await q.query(text, [businessId])).rows as readonly T[]) : [];

  return {
    sales: await rows<SaleRow>('sales', `SELECT id::text AS "id" FROM sales WHERE business_id = $1`),
    saleItems: await rows<SaleItemRow>('sale_items', `SELECT sale_id::text AS "saleId" FROM sale_items WHERE business_id = $1`),
    invoices: await rows<InvoiceRow>(
      'invoices',
      `SELECT id::text AS "id", sale_id::text AS "saleId", status, binding_source_id::text AS "bindingSourceId" FROM invoices WHERE business_id = $1`,
    ),
    invoiceItems: await rows<InvoiceItemRow>('invoice_items', `SELECT invoice_id::text AS "invoiceId" FROM invoice_items WHERE business_id = $1`),
    movements: await rows<MovementRow>(
      'stock_movements',
      `SELECT source_type AS "sourceType", source_id::text AS "sourceId", value_delta_base_minor::text AS "valueDeltaBaseMinor"
         FROM stock_movements WHERE business_id = $1`,
    ),
    bindings: await rows<BindingRow>(
      'accounting_source_bindings',
      `SELECT source_type AS "sourceType", source_id::text AS "sourceId", journal_entry_id::text AS "journalEntryId"
         FROM accounting_source_bindings WHERE business_id = $1`,
    ),
    entries: await rows<EntryRow>(
      'journal_entries',
      `SELECT e.id::text AS "id", e.source_type AS "sourceType", e.source_id::text AS "sourceId",
              coalesce(array_agg(DISTINCT a.system_key) FILTER (WHERE a.system_key IS NOT NULL), '{}') AS "systemKeys"
         FROM journal_entries e
         LEFT JOIN journal_lines l ON l.business_id = e.business_id AND l.journal_entry_id = e.id
         LEFT JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
        WHERE e.business_id = $1
        GROUP BY e.id, e.source_type, e.source_id`,
    ),
  };
}
