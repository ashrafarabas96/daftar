import { z } from 'zod';

/**
 * THE TILL-SESSION REQUESTS (P4-S3).
 *
 * Both schemas are `.strict()`, the accepted P3-S4 / P4-S1 shape: the client
 * sends IDENTITIES and COUNTED CASH and nothing else is believed, so every
 * other key is refused as unknown before the service is reached.
 *
 * What is refused HERE, because the field's mere presence is the defect:
 *
 * - **`openedByUserId`, `actorUserId`, `cashierId`** and every other way of
 *   naming WHO the session belongs to. `OD-P4-09` OPTION A: a till session
 *   belongs to the AUTHENTICATED user, derived from the request's own
 *   membership context, and a client that could name the owner could open a
 *   till in a colleague's name. The owner is not a request field in any form;
 * - **`tenantId` / `businessId`**. Scope is resolved from the membership and
 *   enforced by RLS (`P4-AL-40`); a request that carries its own scope is a
 *   request asking to choose it;
 * - **`status`, `openedAt`, `closedAt`, `expectedCashMinor`, `varianceMinor`**.
 *   The first three are the server's and the last two are DERIVED
 *   (`P4-AL-06`: no stored authoritative derived truth, and nothing
 *   authoritative arrives from a client). The till's expected cash is a
 *   computation over the session's own sales; a client-supplied expected
 *   total, or a client-supplied variance, is the forged-totals attack of §12
 *   with no attacker required;
 * - **`force`, `reopen`, `takeOver`, `override*`**. A closed session is never
 *   reopened and a till is never taken over — a shift change opens a NEW
 *   session. A flag for either is a hint that the state exists;
 * - **`idempotencyKey`**. `P4-AL-30`: the caller-supplied `sessionId` IS the
 *   key, and the stored open-intent digest is what makes it a proof.
 *
 * Money is an integer count of MINOR UNITS as a decimal string — the accepted
 * `minorUnits` shape of `selling.schemas.ts:261-262`. No Float, no Double, no
 * decimal point: a till counted in floating point is a till that disagrees
 * with itself.
 */

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'must be a canonical lowercase uuid');

/** Integer minor units, non-negative, as a decimal STRING. No sign, no decimal point, no leading zero. */
const minorUnits = z.string().regex(/^(0|[1-9][0-9]{0,18})$/, 'an amount is a non-negative integer count of minor units');

/**
 * `POST /v1/pos/till-sessions` — open a till.
 *
 * `sessionId` is caller-supplied and is the replay key: the same id with the
 * same intent returns the SAME session having changed nothing, and the same id
 * with a DIFFERENT intent is refused `pos.session_idempotency_conflict`. A
 * bare key would prove only that a request had been seen before and would say
 * nothing about WHICH request it was.
 *
 * `openingFloatMinor` is the cash the cashier states is in the drawer at the
 * start of the shift. It is an INPUT the merchant asserts, not a derivation —
 * the same category as `invoices.due_date` in `TL-P4-S1-C11`, a fact of the
 * document — so storing it is not stored derived truth. What would be is an
 * expected or closing-variance figure, and neither is representable here.
 */
export const TillSessionOpenSchema = z
  .object({
    sessionId: uuid,
    branchId: uuid,
    openingFloatMinor: minorUnits,
  })
  .strict();

export type TillSessionOpenRequest = z.infer<typeof TillSessionOpenSchema>;

/**
 * `POST /v1/pos/till-sessions/:sessionId/close` — count the till and close it.
 *
 * `closingCountMinor` is the cash the cashier COUNTED. The server stores the
 * count and computes nothing from it in this slice: P4-S3 creates **no
 * accounting object at all**, so there is no cash-movement posting, no
 * over/short entry and no variance row. The difference between the counted
 * cash and the session's sales is a READ, derived when it is asked for.
 *
 * There is deliberately no `varianceMinor`, no `reason` and no `approvedBy`:
 * each belongs to a cash-management command this slice does not own, and a
 * field for one would be that command half-built.
 */
export const TillSessionCloseSchema = z
  .object({
    closingCountMinor: minorUnits,
  })
  .strict();

export type TillSessionCloseRequest = z.infer<typeof TillSessionCloseSchema>;
