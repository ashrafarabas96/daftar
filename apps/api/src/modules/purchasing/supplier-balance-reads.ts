import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { minorUnitsOf } from '@daftar/domain-core';
import { convertToBase, parseUnitCost } from '@daftar/inventory';
import type {
  CurrencyAmountDto,
  SupplierBalanceRowDto,
  SupplierBalancesPageDto,
  SupplierOpenPurchaseDto,
  SupplierOpenPurchasesDto,
} from '@daftar/shared-contracts';
import type { QueryResultRow } from 'pg';
import { Database } from '../../infra/database';
import { readBaseCurrency } from '../inventory/inventory-stock-read';
import { assertBusinessWide, likeEscaped, reachableWarehouses, requireAnyPermission } from '../inventory/read-scope';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { purchasingRefusal } from './purchasing-errors';

/**
 * The supplier-side READS of P3-S7 (PHASE_3_S7_CONTRACT A-09(a), (b)) and
 * the one ledger-AP query every payable read shares.
 *
 * Nothing is stored or cached (A-03): what the merchant owes is derived per
 * request from the ledger's `accounts_payable` lines, what is outstanding on
 * a purchase from `purchase_ap_outstanding`, and the balance in the
 * merchant's favour from the credit notes' remaining amounts — the one stored
 * figure the lock tolerates, re-proved against its derivation at every COMMIT
 * (S6 TL-16). Every read is a statement through `daftar_app` under row level
 * security.
 */

const DEFAULT_LIMIT = 20;
/** A payment holds at most 50 allocations (S6 A-07): the proposal never names more. */
const MAX_ALLOCATIONS = 50;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ── The ledger AP of received purchases ──────────────────────────────────

/** How a payable read groups the AP lines: per purchase currency, or per supplier and purchase currency. */
export type PayableGrouping = 'currency' | 'supplier_currency';

/**
 * The ledger AP of received purchases (S4 A-20, extended by S5 A-19 and S6
 * A-18): the AP lines of each purchase's `purchase` entry, of its
 * `supplier_return` entries (joined through `supplier_returns.purchase_id`),
 * of the `reversal` entry whose `accounting_reversals.original_entry_id` is
 * the purchase entry, and of the entries of its supplier payment allocations
 * and supplier-credit allocations, through their row's `purchase_id` (one
 * entry per row, so every AP line of such an entry is this purchase's; a
 * credit allocation's 1150 lines are not AP and fall out at the account
 * join).
 *
 * Per group: `base_minor` is `Σ credit − Σ debit` over every AP line, the
 * base-only dust lines included (S5 TL-3); `txn_minor` is the signed txn over
 * the AP lines IN the purchase currency only, because a dust line moves base
 * only. For a domestic purchase the two currencies coincide and no dust line
 * exists.
 *
 * This is the S6 `S5_PAYABLE_SQL` moved here unchanged but for the
 * `supplier_id` the `ap` CTE now projects, so one text serves the per-supplier
 * and per-purchase payables, the settlement read and the supplier-balance
 * list, which therefore cannot diverge (PHASE_3_S7_CONTRACT A-09(a), T-05).
 * `filter` is a static predicate over `p` written by the caller; `$1` is the
 * business.
 */
export function payableSql(o: { readonly groupBy: PayableGrouping; readonly filter: string }): string {
  const key = o.groupBy === 'currency' ? 'currency_code' : 'supplier_id, currency_code';
  return `WITH ap AS (
         SELECT p.supplier_id, p.currency_code::text AS currency_code, jl.txn_currency, jl.credit_minor, jl.debit_minor, jl.txn_amount_minor
           FROM purchases p
           JOIN accounting_source_bindings pb ON pb.business_id = p.business_id AND pb.source_type = 'purchase' AND pb.source_id = p.id
           JOIN LATERAL (
                  SELECT pb.journal_entry_id
                  UNION ALL
                  SELECT rb.journal_entry_id
                    FROM supplier_returns r
                    JOIN accounting_source_bindings rb
                      ON rb.business_id = r.business_id AND rb.source_type = 'supplier_return' AND rb.source_id = r.id
                   WHERE r.business_id = p.business_id AND r.purchase_id = p.id
                  UNION ALL
                  SELECT ar.journal_entry_id
                    FROM accounting_reversals ar
                   WHERE ar.business_id = p.business_id AND ar.original_entry_id = pb.journal_entry_id
                  UNION ALL
                  SELECT ab.journal_entry_id
                    FROM supplier_payment_allocations a
                    JOIN accounting_source_bindings ab
                      ON ab.business_id = a.business_id AND ab.source_type = 'supplier_payment' AND ab.source_id = a.id
                   WHERE a.business_id = p.business_id AND a.purchase_id = p.id
                  UNION ALL
                  SELECT cb.journal_entry_id
                    FROM supplier_credit_allocations c
                    JOIN accounting_source_bindings cb
                      ON cb.business_id = c.business_id AND cb.source_type = 'supplier_credit_allocation' AND cb.source_id = c.id
                   WHERE c.business_id = p.business_id AND c.purchase_id = p.id
                ) e ON true
           JOIN journal_lines jl ON jl.business_id = p.business_id AND jl.journal_entry_id = e.journal_entry_id
           JOIN accounts a ON a.business_id = jl.business_id AND a.id = jl.account_id AND a.system_key = 'accounts_payable'
          WHERE p.business_id = $1 AND p.status = 'received' AND ${o.filter})
     SELECT ${key}, sum(credit_minor - debit_minor)::text AS base_minor,
            coalesce(sum(CASE WHEN txn_currency = currency_code
                              THEN CASE WHEN credit_minor > 0 THEN txn_amount_minor ELSE -txn_amount_minor END END), 0)::text AS txn_minor
       FROM ap
      GROUP BY ${key}
      ORDER BY ${key}`;
}

/** One row of `payableSql({ groupBy: 'currency' })`. */
export interface PayableRow {
  currency_code: string;
  base_minor: string;
  txn_minor: string;
}

// ── Queries ──────────────────────────────────────────────────────────────

const uuid = z.string().regex(CANONICAL_UUID, 'a canonical lowercase uuid');
/** `limit` 1..50 as query text (the S7 routes' cap). */
const limit = z
  .string()
  .regex(/^\d{1,2}$/, 'a limit is 1..50')
  .transform((s) => Number.parseInt(s, 10))
  .pipe(z.number().int().min(1).max(50));

export const SupplierBalancesQuerySchema = z
  .object({
    status: z.enum(['active', 'inactive']).optional(),
    search: z
      .string()
      .transform((s) => s.trim())
      .pipe(z.string().min(1).max(100))
      .optional(),
    owedOnly: z
      .enum(['true', 'false'])
      .transform((s) => s === 'true')
      .optional(),
    cursor: uuid.optional(),
    limit: limit.optional(),
  })
  .strict();

export const SupplierOpenPurchasesQuerySchema = z
  .object({
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/, 'an ISO 4217 code')
      .optional(),
    /** A positive integer of minor units, at most 18 digits. */
    amount: z
      .string()
      .regex(/^[1-9]\d{0,17}$/, 'a positive integer of minor units')
      .optional(),
    cursor: uuid.optional(),
    limit: limit.optional(),
  })
  .strict()
  .refine((q) => (q.currency === undefined) === (q.amount === undefined), {
    message: 'currency and amount come together',
    path: ['amount'],
  });

export type SupplierBalancesQuery = z.infer<typeof SupplierBalancesQuerySchema>;
export type SupplierOpenPurchasesQuery = z.infer<typeof SupplierOpenPurchasesQuerySchema>;

// ── The payment proposal ─────────────────────────────────────────────────

/** An open purchase as the proposal sees it. */
export interface ProposalPurchase {
  readonly currency: string;
  readonly outstandingMinor: bigint;
  /** The purchase's snapshot rate as R10 (rate × 10^10): the conversion its AP lines use. */
  readonly rateR10: bigint;
}

/**
 * The server's advisory allocation of `amountMinor` in `currency` over the
 * open purchases, OLDEST FIRST (A-09(b)), in exact integer arithmetic:
 * each purchase in the currency takes `min(remaining, outstanding)`, until
 * the amount is spent. It obeys the payment command's rules so that it never
 * proposes what the command would refuse (S6 A-07, 0067 R-77):
 *
 * - at most 50 allocations; the rest stays unallocated;
 * - a partial allocation `a < O` must leave `O − a` converting, at the
 *   purchase's snapshot rate, to at least one base unit, and `a` itself must
 *   convert to at least one. When it would not, the proposal STOPS there
 *   (it never skips a purchase to pay a younger one): that purchase and the
 *   rest propose 0, and the remaining amount is unallocated.
 *
 * `proposed[i]` is null for a purchase in another currency. The command
 * re-validates every allocation; this is only what the screen pre-fills.
 */
export function proposeAllocation(
  purchases: readonly ProposalPurchase[],
  currency: string,
  amountMinor: bigint,
  baseExponent: number,
): { readonly proposed: (bigint | null)[]; readonly unallocatedMinor: bigint } {
  let remaining = amountMinor;
  let allocations = 0;
  let stopped = false;
  const proposed = purchases.map((p): bigint | null => {
    if (p.currency !== currency) return null;
    if (stopped || remaining === 0n || allocations >= MAX_ALLOCATIONS || p.outstandingMinor <= 0n) return 0n;
    let a = p.outstandingMinor <= remaining ? p.outstandingMinor : remaining;
    if (a < p.outstandingMinor) {
      const exponent = minorUnitsOf(p.currency);
      if (convertToBase(p.outstandingMinor - a, p.rateR10, exponent, baseExponent) < 1n || convertToBase(a, p.rateR10, exponent, baseExponent) < 1n) {
        stopped = true;
        a = 0n;
      }
    }
    if (a > 0n) {
      allocations += 1;
      remaining -= a;
    }
    return a;
  });
  return { proposed, unallocatedMinor: remaining };
}

// ── Rows ─────────────────────────────────────────────────────────────────

interface OpenPurchaseRow {
  id: string;
  document_date: string;
  supplier_reference: string | null;
  warehouse_id: string;
  currency_code: string;
  total_txn_minor: string;
  source_to_base_rate: string | null;
  outstanding: string;
  on_page: boolean | null;
}

/**
 * `GET /v1/supplier-balances` and `GET /v1/suppliers/:id/open-purchases`.
 * Each read re-checks its permission and applies its scope rule (A-04):
 *
 * - supplier balances sum every warehouse, so `suppliers.view` AND
 *   business-wide scope (the S4 TL-4 precedent);
 * - open purchases are `suppliers.view` or `suppliers.pay`, over the
 *   warehouses the caller reaches: another warehouse's purchase is absent.
 */
@Injectable()
export class SupplierBalanceReadService {
  constructor(@Inject(Database) private readonly db: Database) {}

  private async rows<T extends QueryResultRow>(m: MembershipContext, text: string, params: unknown[]): Promise<T[]> {
    return (await this.db.scoped<T>({ tenantId: m.tenantId, businessId: m.businessId }, text, params)).rows;
  }

  /**
   * One page of suppliers, newest first (the supplier keyset of
   * `listSuppliers`), then the two aggregates for THOSE suppliers only:
   * `owed` per purchase currency from `payableSql`, and `inYourFavour` per
   * note currency. There is no sort by amount: it would aggregate the whole
   * business on every page; `owedOnly` narrows the page instead.
   */
  async balances(m: MembershipContext, q: SupplierBalancesQuery): Promise<SupplierBalancesPageDto> {
    requireAnyPermission(m, ['suppliers.view']);
    assertBusinessWide(m);
    const size = q.limit ?? DEFAULT_LIMIT;
    const suppliers = await this.rows<{ id: string; name: string; status: 'active' | 'inactive' }>(
      m,
      `SELECT s.id, s.name, s.status
         FROM suppliers s
        WHERE s.business_id = $1
          AND ($2::text IS NULL OR s.status = $2::text)
          AND ($3::text IS NULL OR s.name ILIKE '%' || $3 || '%' ESCAPE '\\')
          AND (NOT $4::boolean
               OR EXISTS (SELECT 1 FROM purchases p
                           WHERE p.business_id = s.business_id AND p.supplier_id = s.id AND p.status = 'received'
                             AND NOT EXISTS (SELECT 1 FROM purchase_reversals r WHERE r.business_id = p.business_id AND r.id = p.id)
                             AND purchase_ap_outstanding(p.business_id, p.id) <> 0))
          AND ($5::uuid IS NULL OR (s.created_at, s.id) < (SELECT c.created_at, c.id FROM suppliers c WHERE c.business_id = $1 AND c.id = $5::uuid))
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT $6`,
      [m.businessId, q.status ?? null, q.search === undefined ? null : likeEscaped(q.search), q.owedOnly ?? false, q.cursor ?? null, size + 1],
    );
    const page = suppliers.slice(0, size);
    const ids = page.map((s) => s.id);
    const owed =
      ids.length === 0
        ? []
        : await this.rows<PayableRow & { supplier_id: string }>(m, payableSql({ groupBy: 'supplier_currency', filter: 'p.supplier_id = ANY($2::uuid[])' }), [
            m.businessId,
            ids,
          ]);
    const favour =
      ids.length === 0
        ? []
        : await this.rows<{ supplier_id: string; currency_code: string; remaining: string }>(
            m,
            `SELECT n.supplier_id, n.currency_code::text AS currency_code, sum(n.remaining_amount_minor)::text AS remaining
               FROM supplier_credit_notes n
              WHERE n.business_id = $1 AND n.supplier_id = ANY($2::uuid[])
              GROUP BY n.supplier_id, n.currency_code
             HAVING sum(n.remaining_amount_minor) <> 0
              ORDER BY n.supplier_id, n.currency_code`,
            [m.businessId, ids],
          );
    const last = page.at(-1);
    return {
      items: page.map(
        (s): SupplierBalanceRowDto => ({
          supplierId: s.id,
          name: s.name,
          status: s.status,
          owed: owed
            .filter((r) => r.supplier_id === s.id && r.txn_minor !== '0')
            .map((r): CurrencyAmountDto => ({ currency: r.currency_code, amountMinor: r.txn_minor })),
          inYourFavour: favour.filter((r) => r.supplier_id === s.id).map((r): CurrencyAmountDto => ({ currency: r.currency_code, amountMinor: r.remaining })),
        }),
      ),
      nextCursor: suppliers.length > size && last !== undefined ? last.id : null,
    };
  }

  /**
   * The supplier's received, unreversed purchases in reachable warehouses
   * with something outstanding (`purchase_ap_outstanding > 0`), OLDEST first
   * on (document date, created, id), keyset-paged. With `currency` and
   * `amount`, every row in that currency carries its share of the
   * oldest-first proposal (`proposeAllocation`), computed over ALL the open
   * purchases, not only the page, so a page never contradicts the next.
   */
  async openPurchases(m: MembershipContext, supplierId: string, q: SupplierOpenPurchasesQuery): Promise<SupplierOpenPurchasesDto> {
    requireAnyPermission(m, ['suppliers.view', 'suppliers.pay']);
    const [supplier] = await this.rows<{ id: string }>(m, 'SELECT id FROM suppliers WHERE business_id = $1 AND id = $2', [m.businessId, supplierId]);
    if (supplier === undefined) throw purchasingRefusal('supplier.not_found');
    const reachable = await reachableWarehouses(this.db, m);
    const open = await this.rows<OpenPurchaseRow>(
      m,
      `SELECT p.id, p.document_date::text AS document_date, p.supplier_reference, p.warehouse_id, p.currency_code::text AS currency_code,
              p.total_txn_minor::text AS total_txn_minor, p.source_to_base_rate::text AS source_to_base_rate, o.outstanding::text AS outstanding,
              ($4::uuid IS NULL
               OR (p.document_date, p.created_at, p.id)
                  > (SELECT c.document_date, c.created_at, c.id FROM purchases c WHERE c.business_id = $1 AND c.id = $4::uuid)) AS on_page
         FROM purchases p
        CROSS JOIN LATERAL (SELECT purchase_ap_outstanding(p.business_id, p.id) AS outstanding) o
        WHERE p.business_id = $1 AND p.supplier_id = $2 AND p.status = 'received'
          AND NOT EXISTS (SELECT 1 FROM purchase_reversals r WHERE r.business_id = p.business_id AND r.id = p.id)
          AND ($3::uuid[] IS NULL OR p.warehouse_id = ANY($3::uuid[]))
          AND o.outstanding > 0
        ORDER BY p.document_date, p.created_at, p.id`,
      [m.businessId, supplierId, reachable === null ? null : [...reachable], q.cursor ?? null],
    );
    let proposed: (bigint | null)[] = open.map(() => null);
    let unallocated: bigint | null = null;
    if (q.currency !== undefined && q.amount !== undefined) {
      const baseExponent = minorUnitsOf(await readBaseCurrency(this.db, m));
      const proposal = proposeAllocation(
        open.map((r) => {
          if (r.source_to_base_rate === null) throw new Error('a received purchase has no snapshot rate');
          return { currency: r.currency_code, outstandingMinor: BigInt(r.outstanding), rateR10: parseUnitCost(r.source_to_base_rate) };
        }),
        q.currency,
        BigInt(q.amount),
        baseExponent,
      );
      proposed = proposal.proposed;
      unallocated = proposal.unallocatedMinor;
    }
    const size = q.limit ?? DEFAULT_LIMIT;
    const onPage = open.map((r, i) => ({ r, proposal: proposed[i] ?? null })).filter((x) => x.r.on_page === true);
    const items = onPage.slice(0, size);
    const last = items.at(-1);
    return {
      items: items.map(
        ({ r, proposal }): SupplierOpenPurchaseDto => ({
          purchaseId: r.id,
          documentDate: r.document_date,
          supplierReference: r.supplier_reference,
          warehouseId: r.warehouse_id,
          currency: r.currency_code,
          totalTxnMinor: r.total_txn_minor,
          outstandingTxnMinor: r.outstanding,
          proposedMinor: proposal === null ? null : proposal.toString(10),
        }),
      ),
      nextCursor: onPage.length > size && last !== undefined ? last.r.id : null,
      unallocatedMinor: unallocated === null ? null : unallocated.toString(10),
    };
  }
}
