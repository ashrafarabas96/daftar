/**
 * THE ONE REFUSAL-AUDIT COMPOSER (P4-AL-48, P4-AL-48(a)).
 *
 * `AuditService.recordRefusal` is the one WRITER of a refusal row. This module
 * is the one COMPOSER around it: the four-step order every Phase 4 command's
 * catch performs, held in a single place so that a slice which adds a command
 * cannot add a second shape with it.
 *
 * It was extracted from `receivables-refusal-audit.ts`, which was the first
 * and — until the POS and the sale commit joined — the only caller. Nothing
 * about the order changed in the extraction; what changed is that the order is
 * now stated once:
 *
 *   1. the refusal that WILL leave is produced, by the surface's own rethrow;
 *   2. it is classified, by reading the code off THAT object;
 *   3. the audit row is written, best-effort, by `recordRefusal`;
 *   4. the same refusal is thrown.
 *
 * So the audit can never change which refusal leaves, and the code in the row
 * can never be a different classification from the code on the response —
 * they are read off the same object. `recordRefusal` never throws (its own
 * contract, proved by `tests/integration/p4s4-refusal-audit-never-throws.test.ts`),
 * so this function's only exit is that refusal.
 *
 * **It decides no refusal code.** Each surface hands in its OWN already-built
 * rethrow and its own reader of the code that rethrow produced. There is no
 * classification here, no status table here and no mapping here: a second one
 * of any of those would be a second answer to "what was the merchant told".
 */

import type { AuditService } from './audit.service';

/**
 * What a command knows about itself by the time it is refused. It is filled as
 * the command learns it — a refusal raised on the first line still has the
 * document id, the operation and the request's own figures.
 *
 * This is the SHAPE of `AuditRefusalEntry`'s caller-supplied half and not a
 * second metadata schema: every field below is handed to `recordRefusal`
 * unchanged, and `recordRefusal` is the only place that decides what an
 * `audit_events.metadata` of a refusal looks like.
 */
export interface RefusalAttempt {
  /** The `invctl/1` operation code — the permission exercised. */
  readonly operation: string;
  /** The entity the refused document would have been (`payment`, `sale`, `pos_till_session`, `pos_cart_line`). */
  readonly entity: string;
  /** The caller-supplied — or, for a server-minted id, the server-minted — document id. */
  readonly entityId: string;
  /** Known once the digest is computed, which is before any state is bound. */
  intentSha256?: string;
  /** Known once a branch is bound; NULL when the refusal happened before one was. */
  branchId?: string | null;
  /** Non-null on a POS path only. NULL elsewhere is the truth rather than a gap. */
  tillSessionId?: string | null;
  /** The figures that caused it. Minor units as decimal strings, never numbers (P4-AL-54 governs what may be in here). */
  figures: Record<string, string | boolean | null>;
}

/** The membership a refused command ran under. */
export interface RefusalScope {
  readonly tenantId: string;
  readonly businessId: string;
  readonly userId: string;
}

/**
 * One surface's refusal vocabulary, as the composer needs to see it.
 *
 * Two functions, both of them the surface's EXISTING ones: the rethrow its
 * commands already end with, and a reader of the stable code off what that
 * rethrow produced. Neither is written for the audit, and that is the point —
 * the audited code is the answered code by construction.
 */
export interface RefusalSurface {
  /** The surface's own catch-all rethrow. It always throws. */
  readonly rethrow: (error: unknown) => never;
  /** The stable refusal code of an error THAT HAS ALREADY BEEN THROUGH `rethrow`, or null when it is not a merchant refusal at all. */
  readonly code: (error: unknown) => string | null;
}

/**
 * Audit a refused command, then re-throw it through the surface's own rethrow
 * exactly as before.
 *
 * A code of `null` means the error is NOT a merchant refusal — an infra
 * failure, a seam defect, a bug — and it gets no refusal row: auditing a crash
 * as a merchant refusal is the same lie as answering one as a 409.
 */
export async function auditThenRethrowRefusal(
  audit: AuditService,
  surface: RefusalSurface,
  scope: RefusalScope,
  attempt: RefusalAttempt,
  error: unknown,
): Promise<never> {
  // Capturing what the rethrow throws is how the audited code is the ANSWERED
  // code by construction rather than by a second, drift-prone classification
  // of the raw error.
  let refusal: unknown = error;
  try {
    surface.rethrow(error);
  } catch (e) {
    refusal = e;
  }
  const code = surface.code(refusal);
  if (code !== null) {
    await audit.recordRefusal(
      { tenantId: scope.tenantId, businessId: scope.businessId },
      {
        operation: attempt.operation,
        refusalCode: code,
        entity: attempt.entity,
        entityId: attempt.entityId,
        actorUserId: scope.userId,
        intentSha256: attempt.intentSha256,
        branchId: attempt.branchId ?? null,
        tillSessionId: attempt.tillSessionId ?? null,
        figures: attempt.figures,
      },
    );
  }
  throw refusal;
}
