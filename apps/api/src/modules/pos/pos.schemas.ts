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
 *   computation over the counted figures and the shift's cash payments; a
 *   client-supplied expected total, or a client-supplied variance, is the
 *   forged-totals attack of §12 with no attacker required;
 * - **`currencyCode`**. The routine takes a currency as an argument, and it is
 *   still not a request field: a currency is a POLICY, not an identity, and the
 *   client sends identities, quantities and a discount request. The service
 *   derives it from the business's base currency, mints it lower-cased for the
 *   `code` grammar and lets the routine store it upper-cased;
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
 * The `invpl/1` `code` grammar (`0054:206`), which is also the grammar
 * `pos_till_sessions_terminal_code_ck` holds the column to. The two are the
 * same regex on purpose: a value this refuses is a value no assertion can
 * cover, so refusing it here turns an unsignable argument into a merchant
 * sentence instead of an assertion failure.
 */
const registryCode = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'must be a lowercase registry code');

/**
 * `POST /v1/pos/till-sessions` — open a till.
 *
 * `sessionId` is caller-supplied and is the replay KEY. The replay PROOF is
 * the `invctl/1` assertion's own payload digest, which `0079` stores as
 * `open_intent_sha256` and compares on the next call — so the same id with a
 * different payload is `pos.session_idempotency_conflict`, and the same id
 * presented by a DIFFERENT user is `pos.session_not_owned` rather than a replay,
 * because a second user holding the first user's intent is a takeover. A bare
 * key would prove only that a request had been seen before and would say
 * nothing about WHICH request it was.
 *
 * `openingFloatMinor` is the cash the cashier states is in the drawer at the
 * start of the shift. It is an INPUT a human asserts, not a derivation — the
 * same category as `invoices.due_date` in `TL-P4-S1-C11`, a fact of the
 * document — and it is inside the signed payload, so it cannot be changed
 * between the minting and the call.
 *
 * `terminalCode` names the physical till and is held to the `invpl/1` `code`
 * grammar HERE as well as by the column's own named CHECK. That is not
 * belt-and-braces: a terminal name outside the grammar is a name no minter can
 * canonicalise, so an assertion covering it cannot exist at all, and a request
 * refused at the schema gets a merchant sentence instead of an assertion
 * failure.
 */
export const TillSessionOpenSchema = z
  .object({
    sessionId: uuid,
    branchId: uuid,
    warehouseId: uuid,
    terminalCode: registryCode,
    openingFloatMinor: minorUnits,
  })
  .strict();

export type TillSessionOpenRequest = z.infer<typeof TillSessionOpenSchema>;

/**
 * `POST /v1/pos/till-sessions/:sessionId/close` — count the till and close it.
 *
 * `closingCountMinor` is the cash the cashier COUNTED, and it is likewise
 * inside the signed payload. The server stores the count and computes nothing
 * from it in this slice: P4-S3 creates **no accounting object at all**, so
 * there is no cash-movement posting, no over/short entry and no variance row.
 * The difference between the counted cash and the shift's sales is a READ,
 * derived when it is asked for, by whichever later slice owns the cash-up.
 *
 * There is deliberately no `varianceMinor`, no `reason` and no `approvedBy`:
 * each belongs to that command, and a field for one here would be it
 * half-built.
 */
export const TillSessionCloseSchema = z
  .object({
    closingCountMinor: minorUnits,
  })
  .strict();

export type TillSessionCloseRequest = z.infer<typeof TillSessionCloseSchema>;
