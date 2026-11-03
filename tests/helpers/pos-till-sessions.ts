/**
 * OPENING A TILL SESSION THE WAY A CASHIER DOES — the P4-S3 fixture helper.
 *
 * ## Why this is a product path and not a fixture shortcut
 *
 * The Tech Lead's standing ruling is that «a sale endpoint that requires manual
 * SQL setup is not a complete product path». A till session is the scope of
 * every POS read and every cart command, so a suite that seeded
 * `pos_till_sessions` with an `INSERT` as the schema owner would be asserting
 * against a row no cashier could have created — and would have passed happily
 * with the route unmounted, the provider uncomposed or the assertion minting
 * broken. `daftar_app` holds `SELECT` only on both POS relations (`0079:605`)
 * precisely so that this cannot be done by accident.
 *
 * So this helper issues `POST /v1/pos/till-sessions` against the real
 * application and nothing else. Everything a session is — the owner taken from
 * the verified assertion rather than from the body, the server-derived
 * currency, the branch-scope authorization, the replay proof, the two partial
 * unique indexes — is decided by the route and the `SECURITY DEFINER` routine
 * behind it. If any of that is wrong, the fixture fails and says so with the
 * refusal body, which is the whole point.
 *
 * ## One open session per user per business
 *
 * `pos_till_sessions_one_open_per_user_uq` is a PARTIAL unique index on
 * `(business_id, opened_by) WHERE status = 'open'`, so a single actor cannot
 * hold two open tills in one business — a second open answers
 * `pos.till_session_already_open`. A suite that needs two warehouses at once
 * therefore needs two ACTORS, not two sessions, and that is a property of the
 * ruling rather than an inconvenience to work around: one session, one
 * authenticated user, one drawer.
 *
 * `terminalCode` is held to the `invpl/1` `code` grammar
 * (`^[a-z][a-z0-9_]{0,31}$`) by `pos.schemas.ts` and by the column's own named
 * CHECK, and `pos_till_sessions_one_open_per_terminal_uq` closes the other
 * half, so each caller gets its own code rather than sharing one.
 */
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { asMember, type HttpActor } from './inventory-commands';
import type { TestApp } from './test-app';

/** One open till session, as the route reported it. */
export interface OpenTillSession {
  /** The caller-supplied session id, which is also the replay key (`P4-AL-30`). */
  readonly sessionId: string;
  readonly branchId: string;
  readonly warehouseId: string;
  readonly terminalCode: string;
}

/** A terminal code that is legal under the `invpl/1` `code` grammar and unique per call. */
export const terminalCode = (prefix = 'till'): string => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

/**
 * Open a till through `POST /v1/pos/till-sessions`, as `by`, in `businessId`.
 *
 * The response status is asserted here rather than returned, so a suite whose
 * fixture could not open a till fails on the fixture with the route's own
 * refusal body, instead of running every later case against a session id that
 * names nothing.
 */
export async function openTillSession(
  t: TestApp,
  by: HttpActor,
  businessId: string,
  where: { readonly branchId: string; readonly warehouseId: string },
  opts: { readonly sessionId?: string; readonly terminalCode?: string; readonly openingFloatMinor?: string } = {},
): Promise<OpenTillSession> {
  const session: OpenTillSession = {
    sessionId: opts.sessionId ?? randomUUID(),
    branchId: where.branchId,
    warehouseId: where.warehouseId,
    terminalCode: opts.terminalCode ?? terminalCode(),
  };
  const res = await t.request
    .post('/v1/pos/till-sessions')
    .set(asMember(by, businessId))
    .send({
      sessionId: session.sessionId,
      branchId: session.branchId,
      warehouseId: session.warehouseId,
      terminalCode: session.terminalCode,
      openingFloatMinor: opts.openingFloatMinor ?? '0',
    });
  expect(res.status, `the till of ${businessId} at ${session.warehouseId} could not be opened: ${JSON.stringify(res.body)}`).toBe(200);
  expect(res.body.id, 'the route answered with some other session').toBe(session.sessionId);
  expect(res.body.status, 'a freshly opened till must be open').toBe('open');
  expect(res.body.warehouse_id, 'the session must carry the warehouse the open named').toBe(session.warehouseId);
  return session;
}

/** Count the till and close it through `POST /v1/pos/till-sessions/:sessionId/close`. */
export async function closeTillSession(t: TestApp, by: HttpActor, businessId: string, sessionId: string, closingCountMinor = '0'): Promise<void> {
  const res = await t.request.post(`/v1/pos/till-sessions/${sessionId}/close`).set(asMember(by, businessId)).send({ closingCountMinor });
  expect(res.status, `the till ${sessionId} could not be closed: ${JSON.stringify(res.body)}`).toBe(200);
  expect(res.body.status, 'a counted till must be closed').toBe('closed');
}
