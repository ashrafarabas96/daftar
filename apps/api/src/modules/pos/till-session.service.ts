import { Inject, Injectable } from '@nestjs/common';
import { tillSessionClosePayload, tillSessionOpenPayload } from '@daftar/inventory';
import { Database } from '../../infra/database';
import type { BusinessTransactionId } from '../inventory/business-transaction';
import { InventoryAuthorizationService } from '../inventory/inventory-authorization';
import { readBaseCurrency, type ReadScope } from '../inventory/inventory-stock-read';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { posRefusal, rethrowPosRefusal } from './pos-errors';
import { POS_TILL_SESSIONS, TILL_SESSION_COLUMNS as C, TILL_SESSION_STATES } from './pos-session-contract';
import type { TillSessionCloseRequest, TillSessionOpenRequest } from './pos.schemas';

/**
 * THE TILL-SESSION LIFECYCLE (P4-S3; `OD-P4-09` OPTION A — **one session, one
 * authenticated user**; lock `P4-AL-30`, `P4-AL-39`, `P4-AL-40`, `P4-AL-48`).
 *
 * Two commands and two reads. Opening a till and closing it are separate
 * commands because they happen at separate times — which is why this is not
 * the `POST /v1/sales` case, where a `confirm` route would have been half of
 * an atomic commit offered over HTTP. There is deliberately NO reopen, NO
 * take-over and NO transfer command: a change of user is a NEW session, which
 * is the ruling itself, and a command for any of them would be the refused
 * `OD-P4-09` OPTION B with a route in front of it.
 *
 * ## This service does not write the till. It AUTHORIZES and MINTS.
 *
 * `daftar_app` — the principal every request runs as — holds `SELECT` and
 * nothing else on `pos_till_sessions` and `pos_cart_lines`. The writers are
 * `0079`'s two `SECURITY DEFINER` routines, owned by
 * `daftar_inventory_internal`, and each one's FIRST executable statement
 * consumes an `invctl/1` assertion of its own registered kind over its own
 * arguments. So the shape of every command here is:
 *
 *   1. **validate** what the client may say — identities and counted cash, and
 *      nothing else is believed;
 *   2. **authorize**, through `InventoryAuthorizationService`: `sales.create`,
 *      plus branch/warehouse scope over the till's warehouse. This is where
 *      `P4-AL-40` is honoured, and it has to be here: `0079` §9.1 records that
 *      its own RLS policies cannot reach `member_branch_scopes`, so the
 *      database verifies the SIGNED RESULT of this decision rather than the
 *      membership graph (P3-AL-54 §E);
 *   3. **mint** the assertion over the exact `invpl/1` payload the routine
 *      hashes — `tillSessionOpenPayload` / `tillSessionClosePayload`, held
 *      byte-identical to `inventory_claimed_payload_digest(...)`'s own
 *      argument arrays by the shared vectors. A field in the wrong place, of
 *      the wrong type, or one too many or too few, is
 *      `inventory.assertion_payload_mismatch` on every call;
 *   4. **one seam-1 transaction**, and the routine. Seam 1 and not seam 2,
 *      because P4-S3 creates **no accounting object at all**: the handle
 *      carries no posting capability, and that is a property of its type
 *      rather than a convention — counting a drawer is not posting it.
 *
 * **The business, the tenant and the ACTOR come from the verified assertion,
 * never from an argument.** Neither payload grammar has a user field and
 * neither routine takes one, so the user a till session belongs to is a signed
 * server decision. A client that could name the owner could open a till in a
 * colleague's name, and `pos.schemas.ts` refuses every spelling of it as an
 * unknown key.
 *
 * ## The replay proof is SIGNED, and this service does not compute it
 *
 * `open_intent_sha256` and `close_intent_sha256` are the assertion's own
 * payload digest, which the routine lifts out of the token it has just
 * verified. A replay is therefore answered only to a caller who presented an
 * assertion over the identical payload — the counted cash figure included,
 * because both figures are inside the signed payload. An earlier version of
 * this service computed a digest of its own; it would have matched the stored
 * value never.
 *
 * ## Why the ownership rules are not `if`s in this file
 *
 * They are constraints. `pos_cart_lines (business_id, till_session_id,
 * added_by)` references `pos_till_sessions (business_id, id, opened_by)`, so a
 * basket line for another user's session has no parent row to point at; and
 * `pos_till_session_guard()` refuses an `UPDATE` that changes `opened_by`.
 * Neither is a check inside a wrapper, which is what makes them binding on
 * `daftar_inventory_internal` itself and on anything reaching
 * `Database.withTransaction` — the trusted generic primitive, which protects
 * no table by itself. The reads below compare the owner too, but that
 * comparison is a merchant SENTENCE and not the rule.
 *
 * ## Isolation
 *
 * Cross-tenant and cross-business invisibility is RLS's. The `business_id = $1`
 * clauses are the ordinary scoping every query in the estate carries, not the
 * isolation: the six policies on each relation are what make another
 * business's till unreadable with its id in hand. That is why naming a foreign
 * session answers `pos.session_not_found` and not a 403 — the row is absent
 * from the actor's own transaction, and a 403 would confirm a row exists in a
 * business the caller has no membership in.
 */
@Injectable()
export class TillSessionService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(InventoryAuthorizationService) private readonly authorization: InventoryAuthorizationService,
  ) {}

  /**
   * `POST /v1/pos/till-sessions` — open a till for the authenticated user.
   *
   * The currency is **server-derived**, from the business's base currency, and
   * is deliberately not a request field even though the routine takes it as an
   * argument: a currency is a policy and not an identity, and the client sends
   * identities, quantities and a discount request. It is minted lower-cased
   * and stored upper-cased, which is the one place that asymmetry is handled.
   *
   * Everything the routine then decides is the routine's: the three advisory
   * locks in their fixed order, the replay against the stored intent, the
   * `OD-P4-09` refusal of a replay presented by a different user, the two
   * partial unique indexes behind `pos.till_session_already_open` and
   * `pos.terminal_already_open`, the insert, and the audit row in the same
   * transaction (`P4-AL-48`). This service re-decides none of it, because a
   * second copy of a decision is a second answer.
   */
  async open(m: MembershipContext, body: TillSessionOpenRequest, businessTransactionId: BusinessTransactionId): Promise<TillSession> {
    try {
      const currencyCode = await readBaseCurrency(this.db, this.scope(m));
      const authority = await this.authorization.authorize(m, 'pos.session_open', businessTransactionId, [body.warehouseId]);
      const assertion = this.authorization.mint(
        authority,
        tillSessionOpenPayload({
          tenantId: m.tenantId,
          businessId: m.businessId,
          sessionId: body.sessionId,
          branchId: body.branchId,
          warehouseId: body.warehouseId,
          terminalCode: body.terminalCode,
          currencyCode,
          openingFloatMinor: BigInt(body.openingFloatMinor),
        }),
      );
      return await this.db.withBusinessInventoryTransaction(authority.scope, assertion, async (tx) => {
        await tx.query(`SELECT till_session_id, replayed FROM pos_till_session_open($1, $2, $3, $4, $5, $6)`, [
          body.sessionId,
          body.branchId,
          body.warehouseId,
          body.terminalCode,
          currencyCode,
          body.openingFloatMinor,
        ]);
        const { rows } = await tx.query<TillSession>(`SELECT ${RETURNING} FROM ${POS_TILL_SESSIONS} WHERE ${C.business} = $1 AND ${C.id} = $2`, [
          m.businessId,
          body.sessionId,
        ]);
        return first(rows);
      });
    } catch (e) {
      rethrowPosRefusal(e);
    }
  }

  /**
   * `POST /v1/pos/till-sessions/:sessionId/close` — count the till and close it.
   *
   * The session is read FIRST, under the caller's own scope, for one reason
   * only: the warehouse to branch-scope check. That read is not the
   * authorization and not the ownership decision — both are the routine's and
   * the schema's — and it is scoped, so another business's session is invisible
   * to it and answers `pos.session_not_found`.
   *
   * The basket is **not** emptied and not required to be empty: a closed
   * session and its lines are the frozen record of the shift, and
   * `pos_cart_line_guard()` refuses every later write to them. An earlier
   * version of this service refused a close over a non-empty cart, which would
   * have made a cashier unable to end a shift over an abandoned basket.
   */
  async close(m: MembershipContext, sessionId: string, body: TillSessionCloseRequest, businessTransactionId: BusinessTransactionId): Promise<TillSession> {
    try {
      const stored = await this.readRow(m, sessionId);
      if (stored === null) throw posRefusal('pos.session_not_found');
      const authority = await this.authorization.authorize(m, 'pos.session_close', businessTransactionId, [stored.warehouse_id]);
      const assertion = this.authorization.mint(
        authority,
        tillSessionClosePayload({
          tenantId: m.tenantId,
          businessId: m.businessId,
          sessionId,
          closingCountMinor: BigInt(body.closingCountMinor),
        }),
      );
      return await this.db.withBusinessInventoryTransaction(authority.scope, assertion, async (tx) => {
        await tx.query(`SELECT till_session_id, replayed FROM pos_till_session_close($1, $2)`, [sessionId, body.closingCountMinor]);
        const { rows } = await tx.query<TillSession>(`SELECT ${RETURNING} FROM ${POS_TILL_SESSIONS} WHERE ${C.business} = $1 AND ${C.id} = $2`, [
          m.businessId,
          sessionId,
        ]);
        return first(rows);
      });
    } catch (e) {
      rethrowPosRefusal(e);
    }
  }

  /**
   * `GET /v1/pos/till-sessions/:sessionId` — one till session.
   *
   * A colleague's session in the caller's own business is REFUSED and not
   * merely filtered: `OD-P4-09` says a second user may not act in it, and a
   * read that handed over another cashier's drawer figures would be the shared
   * till the ruling refused, read-only. A session in another business is
   * invisible to the policies, so it answers `pos.session_not_found`.
   */
  async read(m: MembershipContext, sessionId: string): Promise<TillSession> {
    try {
      const stored = await this.readRow(m, sessionId);
      if (stored === null) throw posRefusal('pos.session_not_found');
      if (stored.opened_by !== m.userId) throw posRefusal('pos.session_not_owned');
      return stored;
    } catch (e) {
      rethrowPosRefusal(e);
    }
  }

  /**
   * `GET /v1/pos/till-sessions/current` — the caller's own open till, if any.
   *
   * Scoped to `m.userId` in the statement, so there is no id for a caller to
   * supply and no way to ask the question about somebody else. `null` rather
   * than a refusal: "I have no till open" is a legitimate answer a POS screen
   * renders as the open-till prompt, not an error. At most one row can come
   * back whatever the `LIMIT` says — `pos_till_sessions_one_open_per_user_uq`
   * is a partial unique index over exactly this predicate.
   */
  async current(m: MembershipContext): Promise<TillSession | null> {
    try {
      const { rows } = await this.db.scoped<TillSession>(
        { tenantId: m.tenantId, businessId: m.businessId },
        `SELECT ${RETURNING} FROM ${POS_TILL_SESSIONS}
          WHERE ${C.business} = $1 AND ${C.owner} = $2 AND ${C.status} = $3
          ORDER BY ${C.openedAt} DESC LIMIT 1`,
        [m.businessId, m.userId, TILL_SESSION_STATES.open],
      );
      return rows[0] ?? null;
    } catch (e) {
      rethrowPosRefusal(e);
    }
  }

  private scope(m: MembershipContext): ReadScope {
    return { tenantId: m.tenantId, businessId: m.businessId };
  }

  private async readRow(m: MembershipContext, sessionId: string): Promise<TillSession | null> {
    const { rows } = await this.db.scoped<TillSession>(
      { tenantId: m.tenantId, businessId: m.businessId },
      `SELECT ${RETURNING} FROM ${POS_TILL_SESSIONS} WHERE ${C.business} = $1 AND ${C.id} = $2`,
      [m.businessId, sessionId],
    );
    return rows[0] ?? null;
  }
}

/** The projection every statement returns, so the four of them cannot disagree about the shape. */
const RETURNING = [
  C.id,
  C.branch,
  C.warehouse,
  C.terminalCode,
  C.currency,
  C.owner,
  C.status,
  C.openedAt,
  C.closedAt,
  C.openingFloatMinor,
  C.closingCountMinor,
].join(', ');

/**
 * One till session as the API reports it. Minor units travel as strings,
 * exactly as `BIGINT` arrives from `pg`.
 *
 * Neither intent digest is in the projection. They are the replay proofs, they
 * are the assertion's own payload digests, and a client has no use for one —
 * echoing a signed digest back over HTTP would be handing out a value whose
 * only purpose is to be presented again.
 */
export interface TillSession {
  readonly id: string;
  readonly branch_id: string;
  readonly warehouse_id: string;
  readonly terminal_code: string;
  readonly currency_code: string;
  readonly opened_by: string;
  readonly status: string;
  readonly opened_at: Date;
  readonly closed_at: Date | null;
  readonly opening_float_minor: string;
  readonly closing_count_minor: string | null;
}

function first(rows: readonly TillSession[]): TillSession {
  const row = rows[0];
  // A command whose routine returned and whose row is then unreadable is a
  // defect in this service or in the routine, not a merchant outcome: it
  // renders as a 500 through the registry rather than as a refusal.
  if (row === undefined) throw posRefusal('pos.session_state_invalid');
  return row;
}
