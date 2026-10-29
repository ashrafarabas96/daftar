/**
 * THE REFUSAL AUDIT OF THE RECEIVABLES SURFACE.
 *
 * This lives beside `receivables-errors.ts` rather than inside it, and the
 * boundary is the one `apps/web/test/domain-code-fields.test.ts` relies on. A
 * `*-errors.ts` module under `apps/api/src/modules/` has one job by
 * convention: turn a database or service refusal into an `AppError` carrying
 * a stable domain code in the response envelope's `details`. That suite
 * derives the `details` field names the client must be able to read by
 * scanning exactly those files, which is what caught `sellingCode` being a
 * dead string in three locales.
 *
 * Writing an audit row is a different job with a different destination: the
 * `refusalCode` below goes into `audit_events.metadata`, never into a
 * response. Left in the errors module it read, to that scan and to a human,
 * as a `details` field the client fails to render. Moving it is not a way
 * around the check — the check is right that a `…Code` attached in a refusal
 * module is owed a reader — it is the file saying what it is for.
 */

import type { AuditService } from '../audit/audit.service';
import { auditThenRethrowRefusal, type RefusalAttempt, type RefusalSurface } from '../audit/refusal-audit';
import { AppError } from '@daftar/domain-core';
import { AccountingError } from '@daftar/accounting';
import { InventoryError } from '@daftar/inventory';
import { parseDatabaseReceivablesCode, rethrowReceivablesRefusal } from './receivables-errors';

/**
 * ─────────────────────────────────────────────────────────────────────────
 * THE REFUSAL AUDIT (P4-AL-48)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * «A refusal is audited as heavily as a success.» Before this, it was not
 * audited AT ALL, and the reason was structural rather than an oversight:
 *
 * - no Phase 4 module calls `AuditService` — `recordTx`'s only callers are
 *   `catalog`, `admin`, `tenancy`, `auth` and `media`, so every Phase 4 audit
 *   row is written by the SQL routine itself;
 * - and the routine's audit INSERT is its LAST step (`0081:2170` for
 *   `customer_collect_payment`, `0081:2420` for `customer_apply_credit`),
 *   after all 33 and all 23 of their `RAISE EXCEPTION`s. A `RAISE` aborts the
 *   transaction, so a row written earlier would not survive either. A refused
 *   customer payment persisted NO audit evidence whatsoever.
 *
 * The fix is NOT a new transaction model. It is `OutboxService.emit`'s
 * already-accepted own-transaction shape, applied to the one row an abort
 * cannot carry: `AuditService.recordRefusal` opens a second business-scoped
 * `daftar_app` transaction after the first has rolled back. A refusal
 * describes an ATTEMPT, not an effect, so there is no effect for it to be
 * atomic with — and `AuditService`'s documented invariant is re-worded in the
 * same change to say so, instead of continuing to claim one contract for two
 * different durability guarantees.
 *
 * **Every claim P4-AL-48 makes is carried in the ROW'S OWN metadata, not
 * recovered by join.** For a success, the operation exercised IS recoverable —
 * `audit_events.metadata->>'assertionJti'` (`0081:2173`) joins
 * `inventory_assertion_uses`, which stores `op_code` (`0054:88-94`) — and
 * `intent_sha256` is on the `payments` row. For a REFUSAL neither join
 * exists: the assertion's consume INSERT (`0054:450-451`) and the document row
 * both rolled back. So recoverable-by-join is not available on this path at
 * all, and the row carries the operation, the intent digest, the branch, the
 * till session, the refusal code and the figures literally. That is the F-3
 * answer, recorded in `docs/PHASE_4_DECISION_REGISTER.md`.
 */

/**
 * What a receivables command knows about itself by the time it is refused.
 *
 * It is `RefusalAttempt` under this surface's name — the SHARED shape, not a
 * second one. The two notes that used to live on the fields are the things
 * this surface in particular knows: `entityId` is the caller-supplied document
 * id, so it is always present; and `tillSessionId` is NULL here because
 * receivables is not a POS path, which is the truth rather than a gap.
 */
export type ReceivablesAttempt = RefusalAttempt;

/**
 * The stable refusal code of an error THAT HAS ALREADY BEEN THROUGH
 * `rethrowReceivablesRefusal`, or null when it is not a refusal at all.
 *
 * It reads `details.receivablesCode`, which is the channel `receivablesRefusal`
 * writes and the web client reads, so the code that is audited is by
 * construction the code the merchant was answered with; an `InventoryError` or
 * an `AccountingError` carries its own `code`.
 *
 * **It is deliberately NOT a second classifier.** The first draft of this
 * function classified the RAW error and it was measurably wrong: a
 * `ReceivableArithmeticError` from the plan layer is neither an `AppError` nor
 * a database message, so it returned null and the refusal
 * `customer_payment.amount_exceeds_outstanding` — a 409 the merchant did
 * receive — was not audited. Classifying what the rethrow produced, instead of
 * guessing at what it will produce, makes that class of drift unrepresentable.
 *
 * Anything else — an infra failure, a seam defect, a bug — is NOT a refusal
 * and gets no refusal row: auditing a crash as a merchant refusal is the same
 * lie as answering one as a 409.
 */
export function refusedCode(error: unknown): string | null {
  if (error instanceof AppError) {
    const code = error.details?.['receivablesCode'];
    return typeof code === 'string' ? code : null;
  }
  if (error instanceof InventoryError || error instanceof AccountingError) return error.code;
  return parseDatabaseReceivablesCode(error);
}

/** This surface's two functions, both of them the ones its commands already end with. */
const RECEIVABLES_SURFACE: RefusalSurface = { rethrow: rethrowReceivablesRefusal, code: refusedCode };

/**
 * Audit a refused receivables command, then re-throw it through
 * `rethrowReceivablesRefusal` exactly as before.
 *
 * The ORDER this performs — produce the refusal that will leave, classify
 * THAT object, write the row, throw the same object — is
 * `auditThenRethrowRefusal`'s and is stated there, once, for every surface.
 * This function is the receivables BINDING of it and nothing else: it holds no
 * order of its own, so the POS and the sale commit cannot drift from it.
 */
export async function auditThenRethrowReceivablesRefusal(
  audit: AuditService,
  scope: { tenantId: string; businessId: string; userId: string },
  attempt: ReceivablesAttempt,
  error: unknown,
): Promise<never> {
  return auditThenRethrowRefusal(audit, RECEIVABLES_SURFACE, scope, attempt, error);
}
