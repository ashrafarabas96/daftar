/**
 * P4-S2 — THE SALE PATH ADAPTER, AND THE ONE PLACE ITS CONTRACT IS WRITTEN.
 *
 * The suites in this directory were written BEFORE the sale commit primitive
 * existed, because the laws they assert — exactly one commit on the final
 * unit, no partial sale after a failure, the inventory identity — are the
 * slice's acceptance criteria and had to be stated before the implementation
 * could be measured against them. That creates exactly one coupling problem,
 * and this file is where it is paid for: a suite that hard-codes a request
 * body is a suite that has to be rewritten line by line when the real DTO
 * lands, and the rewrite is where a law quietly becomes a weaker law.
 *
 * So every suite reaches the sale through `confirmSale` and through nothing
 * else. When the real command lands, the ONE place that changes is this file,
 * and no assertion in any suite moves.
 *
 * ── WHAT IS CONTRACT AND WHAT IS ASSUMPTION ───────────────────────────────
 *
 * Fixed by the lock and the execution plan, not by this file:
 *
 *   — the route is under `/v1/sales` (`scripts/phase4-s1-gate.ts:386`,
 *     `PHASE4_ROUTE_PREFIXES`; lock §16);
 *   — the command is idempotent by a CALLER-SUPPLIED document UUID plus a
 *     stored `intent_sha256` read before any write (P4-AL-30), so the body
 *     carries the sale's own id;
 *   — the client sends identities, quantities and a discount request, and
 *     NOTHING believed: no total, no unit cost, no tax (P4-AL-18);
 *   — tax is structurally zero and a non-zero tax is REFUSED (P4-AL-44,
 *     OD-03 open), so no field here carries a tax figure;
 *   — a walk-in sale carries a null `customer_id` (P4-AL-11).
 *
 * Assumed by this file, and the only thing a later edit may touch: the field
 * NAMES, and whether the cash payment travels on the same request. Both are
 * the selling module's to decide. `SALE_BODY_SHAPE` records the assumption in
 * one string so the diff that corrects it is one line and is visible.
 */
import type { Response } from 'supertest';
import type { TestApp } from '../../helpers/test-app';

/** The assumption this adapter makes about the command's body, recorded so correcting it is one visible line. */
export const SALE_BODY_SHAPE =
  'POST /v1/sales { saleId, customerId|null, warehouseId, branchId, occurredOn, lines[{ productId, quantity, discount? }], payment? }';

export interface SaleLine {
  readonly productId: string;
  /** A decimal string. A quantity is never a float in this estate. */
  readonly quantity: string;
}

export interface SaleInput {
  /** The caller-supplied document UUID the idempotency of P4-AL-30 is keyed on. */
  readonly saleId: string;
  /** Null for a walk-in sale (P4-AL-11). */
  readonly customerId: string | null;
  readonly warehouseId: string;
  readonly branchId: string;
  readonly occurredOn: string;
  readonly lines: readonly SaleLine[];
  /** A cash sale settles in the same transaction (P4-AL-16); a credit sale omits this. */
  readonly payment?: { readonly paymentMethodId: string };
}

/** The one call every P4-S2 suite makes. */
export function confirmSale(t: TestApp, headers: Record<string, string>, input: SaleInput): Promise<Response> {
  return t.request
    .post('/v1/sales')
    .set(headers)
    .send(input as unknown as object);
}

/**
 * The refusal law, stated so it does not depend on which key of the error
 * envelope the selling module chooses for its machine code.
 *
 * What G-01 requires of the loser is that it be a STABLE BUSINESS REFUSAL:
 * a conflict rather than a crash, naming the stock reason in a machine-readable
 * way, with a localized sentence rendered from that code rather than from a
 * message the server composed. So: the status, the envelope's stable code, and
 * the presence of a `*.insufficient_stock` code SOMEWHERE in the typed details.
 * That is a law about the refusal, not a copy of the module's DTO.
 */
export function stockRefusalCode(res: Response): string | null {
  const seen: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > 6) return;
    if (typeof value === 'string') {
      seen.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) walk(v, depth + 1);
      return;
    }
    if (value !== null && typeof value === 'object') for (const v of Object.values(value)) walk(v, depth + 1);
  };
  walk((res.body as { error?: unknown } | undefined)?.error, 0);
  return seen.find((s) => /\.insufficient_stock$/.test(s)) ?? null;
}

// ── fixtures the sale needs and no product path yet writes ────────────────

/**
 * A customer and a `period`-scoped invoice sequence, inserted on the OWNER
 * connection.
 *
 * This is a FIXTURE and not a product path, for exactly the reason
 * `tests/golden-regression/phase4/01-cross-tenant.golden.test.ts:33-38` gives:
 * P4-S1 grants no DML on any Phase 4 relation to any runtime principal and
 * ships no writer, so a customer can only arrive this way until the slice that
 * owns `customers.manage` lands. Nothing in these suites asserts anything about
 * how the row got here; what they assert is what the SALE does with it.
 *
 * A credit sale is used throughout, rather than a cash sale, because the cash
 * arm of P4-AL-16 brings in `payments`, `payment_allocations` and the
 * settlement entry, and those are P4-S4's relations. The laws of §15 this
 * slice owns — sale ⇔ movement ⇔ invoice ⇔ binding ⇔ COGS ⇔ revenue — are all
 * present on the credit arm, and a suite that needed S4's tables to state an
 * S2 law would be red for a reason that is not S2's.
 */
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { Queryable } from './harness';

export interface SaleFixtures {
  readonly customerId: string;
  readonly period: string;
}

export async function seedSaleFixtures(
  q: Queryable,
  shop: { readonly tenantId: string; readonly businessId: string; readonly userId: string },
  issueDate: string,
): Promise<SaleFixtures> {
  const customerId = randomUUID();
  const digest = 'f'.repeat(64);
  await q.query(
    `INSERT INTO customers (tenant_id, business_id, id, name, phone, status, revision,
                            create_intent_sha256, last_intent_sha256, business_transaction_id, created_by, updated_by)
     VALUES ($1, $2, $3, 'P4-S2 race customer', '+970000001', 'active', 1, $4, $4, $5, $6, $6)`,
    [shop.tenantId, shop.businessId, customerId, digest, randomUUID(), shop.userId],
  );
  const period = issueDate.slice(0, 4);
  await q.query(
    `INSERT INTO invoice_sequences (tenant_id, business_id, document_kind, period, number_format)
     VALUES ($1, $2, 'invoice', $3, 'INV-{YYYY}-{SEQ:5}')
     ON CONFLICT DO NOTHING`,
    [shop.tenantId, shop.businessId, period],
  );
  return { customerId, period };
}

/**
 * The columns a law is about must exist before the law can be asserted — the
 * canary again, at column grain. A law written against a column that is not
 * there does not fail: it raises `42703` from somewhere inside a helper, which
 * reads as an infrastructure error rather than as "this claim has no subject".
 */
export async function requireColumns(q: Queryable, relation: string, columns: readonly string[]): Promise<void> {
  const r = await q.query<{ attname: string }>(
    `SELECT a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = $1 AND a.attnum > 0 AND NOT a.attisdropped`,
    [relation],
  );
  const have = new Set(r.rows.map((x) => x.attname));
  const missing = columns.filter((c) => !have.has(c));
  expect(missing, `NO SUBJECT — ${relation} lacks ${missing.join(', ')}, so a law written over those columns has nothing to be true of`).toEqual([]);
}
