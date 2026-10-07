/**
 * THE REFUSAL AUDIT OF THE SELLING AND POS SURFACES (P4-AL-48, P4-AL-48(a)).
 *
 * `P4-AL-48` requires that «a refusal is audited as heavily as a success». The
 * receivables surface already does it; the sale commit, the till session, the
 * basket and the POS checkout did NOT, and the reason was the same structural
 * one, visible in the SQL rather than in any comment:
 *
 *   - `sale_commit` writes exactly ONE `audit_events` row — `sale.committed`,
 *     at `0078:1002` — and it is the routine's LAST step, after all 33 of its
 *     `RAISE EXCEPTION`s. Every one of those raises aborts the transaction, so
 *     a row written before it would not survive either;
 *   - `pos_till_session_open`'s only audit row, `pos.till_session_opened`
 *     (`0079:954`), sits inside the NON-REPLAY arm after its seven raises;
 *   - `pos_till_session_close`'s only audit row, `pos.till_session_closed`
 *     (`0079:1022`), sits inside the NON-REPLAY arm after its six.
 *
 * So a REFUSED sale, a refused till open and a refused till close persisted no
 * audit evidence whatsoever, exactly as a refused customer payment did not.
 *
 * The fix is NOT a second mechanism. `AuditService.recordRefusal` is the one
 * writer and `auditThenRethrowRefusal` is the one composer; this module is the
 * SELLING BINDING of it — the surface's own rethrow and the surface's own
 * reader of the code that rethrow produced, and nothing else.
 *
 * ## Why this is not in `selling-errors.ts`
 *
 * The boundary is the one `apps/web/test/domain-code-fields.test.ts` relies
 * on, and the argument is `receivables-refusal-audit.ts`' word for word: a
 * `*-errors.ts` module turns a refusal into an `AppError` carrying a stable
 * domain code in the response envelope's `details`, and that suite derives the
 * `details` field names the client must render by scanning exactly those
 * files. The `refusalCode` composed here goes into `audit_events.metadata` and
 * NEVER into a response, so left in the errors module it would read — to the
 * scan and to a human — as a `details` field the client fails to render.
 *
 * ## Why ONE module serves both `selling` and `pos`
 *
 * Because there is ONE refusal registry. `pos-errors.ts` registers nothing: it
 * NARROWS `SELLING_STATUS`, and `rethrowPosRefusal` IS `rethrowSellingRefusal`
 * re-exported. A `pos-refusal-audit.ts` would therefore have had to read the
 * same `details.sellingCode` off the same rethrow's output — a second place
 * deciding the same thing, which is the defect this whole shape exists to
 * prevent.
 */

import type { AuditService } from '../audit/audit.service';
import { auditThenRethrowRefusal, type RefusalAttempt, type RefusalSurface } from '../audit/refusal-audit';
import { AppError } from '@daftar/domain-core';
import { AccountingError } from '@daftar/accounting';
import { InventoryError } from '@daftar/inventory';
import { parseDatabaseSellingCode, rethrowSellingRefusal } from './selling-errors';

/**
 * What a selling or POS command knows about itself by the time it is refused.
 * The SHARED shape under this surface's name, never a second one.
 */
export type SellingAttempt = RefusalAttempt;

/**
 * The stable refusal code of an error THAT HAS ALREADY BEEN THROUGH
 * `rethrowSellingRefusal`, or null when it is not a merchant refusal at all.
 *
 * It reads `details.sellingCode`, which is the channel `sellingRefusal` writes
 * and the web client reads, so the code that is audited is by construction the
 * code the merchant was answered with. `details.inventoryCode` is read for the
 * same reason and from the same object: the ONE stock writer and the ONE
 * branch-scope authorizer are the inventory module's, so a sale or a till is
 * refused `inventory.insufficient_stock` or `inventory.warehouse_out_of_scope`
 * through `inventoryRefusal`'s channel and not through this surface's. An
 * `InventoryError` or an `AccountingError` carries its own `code` — the sale
 * path meets both, because the deferred completeness triggers raise at COMMIT.
 *
 * **A 500 is not a refusal.** `SELLING_STATUS` carries 500-class codes for the
 * INTERNAL `selling.*` invariants, and `sellingRefusal` attaches those to
 * `details.sellingCode` as well. Auditing one as a merchant refusal would be
 * the same lie as answering it as a 409, so the status the merchant actually
 * received is the test — read off the `AppError` itself rather than from a
 * second copy of the status table.
 */
export function refusedSellingCode(error: unknown): string | null {
  if (error instanceof AppError) {
    if (error.httpStatus >= 500) return null;
    const code = error.details?.['sellingCode'] ?? error.details?.['inventoryCode'];
    return typeof code === 'string' ? code : null;
  }
  if (error instanceof InventoryError || error instanceof AccountingError) return error.code;
  return parseDatabaseSellingCode(error);
}

/** This surface's two functions, both of them the ones its commands already end with. */
const SELLING_SURFACE: RefusalSurface = { rethrow: rethrowSellingRefusal, code: refusedSellingCode };

/**
 * Audit a refused selling or POS command, then re-throw it through
 * `rethrowSellingRefusal` exactly as before.
 *
 * The ORDER — produce the refusal that will leave, classify THAT object, write
 * the row, throw the same object — is `auditThenRethrowRefusal`'s and is
 * stated there once. This function holds no order of its own.
 */
export async function auditThenRethrowSellingRefusal(
  audit: AuditService,
  scope: { tenantId: string; businessId: string; userId: string },
  attempt: SellingAttempt,
  error: unknown,
): Promise<never> {
  return auditThenRethrowRefusal(audit, SELLING_SURFACE, scope, attempt, error);
}

/**
 * The attempt record of a sale commit, from the request alone.
 *
 * It is here and not in `sale-commit.service.ts` because the sale commit has
 * TWO command paths — `POST /v1/sales` and the atomic POS checkout, which
 * derives its sale request from the basket and runs the same `plan` /
 * `execute` — and both must audit the same figures under the same operation.
 * A second copy would be a second account of what a refused sale was.
 *
 * `tillSessionId` is the ONE thing the two paths differ in, and it is the
 * caller's to state: NULL for `POST /v1/sales`, the till for a checkout. That
 * is the whole reason `AuditRefusalEntry` carries the column.
 *
 * Every figure is a REQUEST figure. `sale_commit` recomputes each price, total
 * and share from the catalogue (`0078`, step 6), so the request states
 * identities, quantities and a discount REQUEST and nothing else — and a
 * refused sale's forensics are exactly those, never a derived amount this
 * service would have had to invent.
 */
export function saleCommitAttempt(
  input: {
    readonly saleId: string;
    readonly settlementMode: string;
    readonly customerId: string | null;
    readonly warehouseId: string;
    readonly documentDate: string;
    readonly dueDate: string | null;
    readonly lines: readonly {
      readonly lineId: string;
      readonly productId: string;
      readonly variantId: string | null;
      readonly quantity: string;
      readonly discountMinor: string;
    }[];
  },
  tillSessionId: string | null,
): SellingAttempt {
  return {
    // The `invctl/1` operation the command exercises — the permission
    // exercised, carried literally because the join that recovers it for a
    // success has no row at all after an abort.
    operation: 'sale.commit',
    entity: 'sale',
    entityId: input.saleId,
    tillSessionId,
    figures: {
      settlementMode: input.settlementMode,
      customerId: input.customerId,
      warehouseId: input.warehouseId,
      documentDate: input.documentDate,
      dueDate: input.dueDate,
      lineCount: String(input.lines.length),
      lines: JSON.stringify(
        input.lines.map((l) => ({
          lineId: l.lineId,
          productId: l.productId,
          variantId: l.variantId,
          quantity: l.quantity,
          discountMinor: l.discountMinor,
        })),
      ),
    },
  };
}
