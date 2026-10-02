import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { Database, type Scope } from '../../infra/database';
import { AuditService } from '../audit/audit.service';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { posRefusal, rethrowPosRefusal } from './pos-errors';
import { CART_LINE_COLUMNS, POS_CART_LINES, POS_TILL_SESSIONS, TILL_SESSION_COLUMNS as C, TILL_SESSION_STATES } from './pos-session-contract';
import type { TillSessionCloseRequest, TillSessionOpenRequest } from './pos.schemas';

/**
 * THE TILL-SESSION LIFECYCLE (P4-S3; `OD-P4-09` OPTION A — **one session, one
 * authenticated user**; lock `P4-AL-30`, `P4-AL-40`, `P4-AL-48`).
 *
 * Two commands and two reads. Opening a till and closing it are separate
 * commands because they happen at separate times — which is why this is NOT
 * the `POST /v1/sales` case, where a `confirm` route would have been half of
 * an atomic commit offered over HTTP. There is deliberately NO reopen, NO
 * take-over and NO transfer command: a change of user is a NEW session, which
 * is the ruling itself, and a command for either would be the refused
 * `OD-P4-09` OPTION B with a route in front of it.
 *
 * ## The owner is derived, never sent
 *
 * `m.userId` is the authenticated principal, resolved from the membership by
 * `TenancyService` before this service is reached. It is the ONLY source of
 * the session's owner: `pos.schemas.ts` refuses `openedByUserId`,
 * `actorUserId` and `cashierId` as unknown keys, so there is no spelling of
 * "open a till in my colleague's name" that reaches here to be validated.
 *
 * ## Why every ownership check below is ALSO a database rule, and why that is
 * ## not belt-and-braces
 *
 * `Database.withTransaction` is the TRUSTED GENERIC PRIMITIVE of this
 * process: any service can open a scoped transaction as `daftar_app` under
 * the caller's own tenant and business GUCs and issue arbitrary SQL. The
 * checks in this file protect the ROUTE. They do not protect the TABLE, and
 * they are not inherited by the next writer who needs to touch a till — a
 * reporting service, a later slice's cash-movement command, a repair script
 * running in the same process. Each of those reaches the generic primitive,
 * and none of them reaches this file.
 *
 * So `OD-P4-09` is in the SCHEMA (`0079`, the migration owner's), in two
 * parts, and this service's checks exist to render those parts as a merchant
 * sentence rather than to be the rule:
 *
 *   1. the session's owning column is `NOT NULL` and IMMUTABLE, so a till
 *      cannot be re-owned by any writer at all — reaching that refusal is a
 *      server-side defect and renders as `pos.session_owner_immutable` (500,
 *      no details), not as a merchant outcome;
 *   2. a write that attaches a basket line to a session owned by a DIFFERENT
 *      authenticated user is refused at the database and renders as
 *      `pos.session_not_owned` (403).
 *
 * `tests/guards/pos-s3-session-law.test.ts` requires both of those to be in
 * the migration tree, and `tests/security/pos-s3-session-authority.test.ts`
 * performs the bypass — the raw statement through the generic primitive, on a
 * real connection — and requires the database to refuse it. A rule proved
 * only against this service would be a rule about this service.
 *
 * ## Isolation
 *
 * Cross-tenant and cross-business invisibility is RLS's, never a predicate
 * here (`P4-AL-40`). The `business_id = $1` clauses below are not the
 * isolation: they are the ordinary scoping every query in the estate carries,
 * and the policies on `pos_till_sessions` are what make another business's
 * till unreadable and unwritable even when its id is known. That is why
 * naming a foreign session answers `pos.session_not_found` and not
 * `pos.session_not_owned`: the row is not merely forbidden, it is absent from
 * the actor's own transaction, and a 403 there would confirm the existence of
 * a row in a business the caller has no membership in.
 *
 * ## No accounting object, and no stored derived truth
 *
 * P4-S3 creates **no accounting object at all**: closing a till writes the
 * counted cash and posts nothing. The till's expected cash, and therefore any
 * over/short figure, is a computation over the session's own sales and is
 * never a column (`P4-AL-06`).
 */
@Injectable()
export class TillSessionService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * `POST /v1/pos/till-sessions` — open a till for the authenticated user.
   *
   * The replay proof comes FIRST, under the per-session advisory lock and
   * before the branch or any other state is read
   * (`[[daftar-registry-before-state]]`): a stale request replayed after a
   * later transition, whose handler reads state first, performs a second real
   * change. Same digest ⇒ the stored session is returned, having changed
   * nothing. Different digest ⇒ `pos.session_idempotency_conflict`, because an
   * idempotency key is not permission and a replay must prove WHICH command it
   * is replaying before it answers "success".
   *
   * A replay of a session id that belongs to ANOTHER user is
   * `pos.session_not_owned` and never a replay: the digest comparison is not
   * reached, because answering a colleague's session id with its stored body
   * would be a read across the `OD-P4-09` boundary dressed as idempotency.
   */
  async open(m: MembershipContext, body: TillSessionOpenRequest): Promise<TillSession> {
    const digest = openIntentDigest(m, body);
    try {
      return await this.db.withTransaction(this.scope(m), async (c) => {
        await lockSession(c, body.sessionId);

        const stored = await this.storedSession(c, m, body.sessionId);
        if (stored !== null) {
          if (stored.opened_by_user_id !== m.userId) throw posRefusal('pos.session_not_owned');
          if (stored.open_intent_sha256 !== digest) throw posRefusal('pos.session_idempotency_conflict');
          return stored;
        }

        // `P4-AL-40`: the branch is named by the command and judged by the
        // database. A branch outside this actor's `member_branch_scopes` is
        // filtered by the policy, so "absent" and "not yours" are the same
        // answer here — deliberately, because telling them apart is a
        // cross-scope enumeration.
        const branch = await c.query(`SELECT 1 FROM branches WHERE ${C.business} = $1 AND id = $2`, [m.businessId, body.branchId]);
        if (branch.rowCount === 0) throw posRefusal('pos.branch_not_found');

        // One user, one open till. The service says it as a sentence; the
        // database says it as a rule, which is what makes it true for the
        // generic primitive too.
        const openAlready = await c.query(`SELECT 1 FROM ${POS_TILL_SESSIONS} WHERE ${C.business} = $1 AND ${C.owner} = $2 AND ${C.status} = $3 LIMIT 1`, [
          m.businessId,
          m.userId,
          TILL_SESSION_STATES.open,
        ]);
        if (openAlready.rowCount !== 0) throw posRefusal('pos.session_already_open');

        const { rows } = await c.query<TillSession>(
          `INSERT INTO ${POS_TILL_SESSIONS}
             (${C.tenant}, ${C.business}, ${C.id}, ${C.branch}, ${C.owner}, ${C.status}, ${C.openingFloatMinor}, ${C.intentDigest})
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING ${RETURNING}`,
          [m.tenantId, m.businessId, body.sessionId, body.branchId, m.userId, TILL_SESSION_STATES.open, body.openingFloatMinor, digest],
        );
        const session = first(rows);

        // `P4-AL-48`: the audit row is written in the SAME transaction as its
        // effect, and it carries the actor, the permission exercised, the
        // document's UUID, the intent digest, the branch and the till session.
        await this.audit.recordTx(c, {
          action: 'pos.till_session.open',
          entity: POS_TILL_SESSIONS,
          entityId: session.id,
          actorUserId: m.userId,
          tenantId: m.tenantId,
          businessId: m.businessId,
          metadata: {
            permission: 'sales.create',
            branchId: session.branch_id,
            tillSessionId: session.id,
            intentSha256: digest,
            openingFloatMinor: session.opening_float_minor,
          },
        });
        return session;
      });
    } catch (e) {
      rethrowPosRefusal(e);
    }
  }

  /**
   * `POST /v1/pos/till-sessions/:sessionId/close` — count the till and close
   * it. A closed session is never reopened: the next shift opens a new one.
   *
   * The row is taken `FOR UPDATE`, so two concurrent closes of one till
   * serialise and the second meets `pos.session_not_open` rather than
   * overwriting the first count.
   */
  async close(m: MembershipContext, sessionId: string, body: TillSessionCloseRequest): Promise<TillSession> {
    try {
      return await this.db.withTransaction(this.scope(m), async (c) => {
        await lockSession(c, sessionId);

        const { rows } = await c.query<TillSession>(`SELECT ${RETURNING} FROM ${POS_TILL_SESSIONS} WHERE ${C.business} = $1 AND ${C.id} = $2 FOR UPDATE`, [
          m.businessId,
          sessionId,
        ]);
        const stored = rows[0];
        // Absent, or in another tenant or another business and therefore
        // invisible to this transaction. One answer for both: see the class
        // comment on why this is not a 403.
        if (stored === undefined) throw posRefusal('pos.session_not_found');
        if (stored.opened_by_user_id !== m.userId) throw posRefusal('pos.session_not_owned');
        if (stored.status !== TILL_SESSION_STATES.open) throw posRefusal('pos.session_not_open');

        const basket = await c.query(`SELECT 1 FROM ${POS_CART_LINES} WHERE ${CART_LINE_COLUMNS.business} = $1 AND ${CART_LINE_COLUMNS.session} = $2 LIMIT 1`, [
          m.businessId,
          sessionId,
        ]);
        if (basket.rowCount !== 0) throw posRefusal('pos.session_cart_not_empty');

        const closed = await c.query<TillSession>(
          `UPDATE ${POS_TILL_SESSIONS}
              SET ${C.status} = $3, ${C.closingCountMinor} = $4, ${C.closedAt} = now()
            WHERE ${C.business} = $1 AND ${C.id} = $2
            RETURNING ${RETURNING}`,
          [m.businessId, sessionId, TILL_SESSION_STATES.closed, body.closingCountMinor],
        );
        const session = first(closed.rows);

        await this.audit.recordTx(c, {
          action: 'pos.till_session.close',
          entity: POS_TILL_SESSIONS,
          entityId: session.id,
          actorUserId: m.userId,
          tenantId: m.tenantId,
          businessId: m.businessId,
          metadata: {
            permission: 'sales.create',
            branchId: session.branch_id,
            tillSessionId: session.id,
            closingCountMinor: session.closing_count_minor,
          },
        });
        return session;
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
   * read that returned another cashier's drawer figures would be the shared
   * till the ruling refused, read-only. A session in another business is
   * invisible, so it answers `pos.session_not_found`.
   */
  async read(m: MembershipContext, sessionId: string): Promise<TillSession> {
    try {
      const { rows } = await this.db.scoped<TillSession>(
        this.scope(m),
        `SELECT ${RETURNING} FROM ${POS_TILL_SESSIONS} WHERE ${C.business} = $1 AND ${C.id} = $2`,
        [m.businessId, sessionId],
      );
      const stored = rows[0];
      if (stored === undefined) throw posRefusal('pos.session_not_found');
      if (stored.opened_by_user_id !== m.userId) throw posRefusal('pos.session_not_owned');
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
   * renders as the open-till prompt, not an error.
   */
  async current(m: MembershipContext): Promise<TillSession | null> {
    try {
      const { rows } = await this.db.scoped<TillSession>(
        this.scope(m),
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

  /**
   * The GUC scope of every statement above. `actorUserId` is set because the
   * database's own actor-binding rule reads it: the rule compares the session's
   * stored owner with `app.actor_user_id`, so a transaction that did not set it
   * writes into no session at all rather than into any session.
   *
   * It is **not** authority, and the law does not claim it is. `0044` and
   * `0054` already record why: anything holding the `daftar_app` credential can
   * `set_config('app.actor_user_id', …)`, so authority travels in signed
   * assertions and permission checks, never in a GUC. What the rule buys is
   * the thing this slice actually needs — that a writer INSIDE this process,
   * reaching the trusted generic primitive with the real request's scope, still
   * cannot write into a till belonging to another authenticated user. That is
   * an in-process bypass, not an attacker with the database password, and it is
   * the bypass `OD-P4-09` is about. No `GRANT EXECUTE` and no definer routine
   * is taken for it: new authority is not needed to close a hole that is about
   * whose row it is.
   */
  private scope(m: MembershipContext): Scope {
    return { tenantId: m.tenantId, businessId: m.businessId, actorUserId: m.userId };
  }

  private async storedSession(c: PoolClient, m: MembershipContext, sessionId: string): Promise<TillSession | null> {
    const { rows } = await c.query<TillSession>(`SELECT ${RETURNING} FROM ${POS_TILL_SESSIONS} WHERE ${C.business} = $1 AND ${C.id} = $2 FOR UPDATE`, [
      m.businessId,
      sessionId,
    ]);
    return rows[0] ?? null;
  }
}

/** One till session as the API reports it. Minor units travel as strings, exactly as they are stored. */
export interface TillSession {
  readonly id: string;
  readonly branch_id: string;
  readonly opened_by_user_id: string;
  readonly status: string;
  readonly opened_at: Date;
  readonly closed_at: Date | null;
  readonly opening_float_minor: string;
  readonly closing_count_minor: string | null;
  readonly open_intent_sha256: string;
}

/** The projection every statement returns, so the four of them cannot disagree about the shape. */
const RETURNING = [C.id, C.branch, C.owner, C.status, C.openedAt, C.closedAt, C.openingFloatMinor, C.closingCountMinor, C.intentDigest].join(', ');

/**
 * The per-session advisory lock, in its own namespace — the accepted
 * `pg_advisory_xact_lock(hashtext('daftar.sale_id'), …)` shape of
 * `0078:554`. It serialises two commands naming the SAME session id and
 * nothing else, so the replay proof and the close are each decided once.
 * Transaction-scoped: it is released by the COMMIT or the ROLLBACK, never by
 * a call this service has to remember to make.
 */
async function lockSession(c: PoolClient, sessionId: string): Promise<void> {
  await c.query(`SELECT pg_advisory_xact_lock(hashtext('daftar.pos_till_session_id'), hashtext($1))`, [sessionId]);
}

function first(rows: readonly TillSession[]): TillSession {
  const row = rows[0];
  // A write that returned no row is a defect in the statement, not a merchant
  // outcome: it renders as 500 through the registry rather than as a refusal.
  if (row === undefined) throw posRefusal('pos.session_state_invalid');
  return row;
}

/**
 * The open command's intent digest (`P4-AL-30`) — the PROOF a replay is
 * judged by, not the key.
 *
 * The preimage binds the scope, the actor and every field of the command, in a
 * fixed order, with a field separator that cannot occur inside a uuid or a
 * minor-unit string. The actor is IN the preimage on purpose: the same session
 * id re-sent by a different user is not the same command, and must not be able
 * to look like a replay of one.
 *
 * It reads no clock. The same request sent either side of local midnight is
 * the same command for ever (`[[daftar-a-command-must-not-read-the-clock]]`).
 */
export function openIntentDigest(m: MembershipContext, body: TillSessionOpenRequest): string {
  const preimage = ['pos.till_session.open/1', m.tenantId, m.businessId, m.userId, body.sessionId, body.branchId, body.openingFloatMinor].join('\n');
  return createHash('sha256').update(preimage, 'utf8').digest('hex');
}
