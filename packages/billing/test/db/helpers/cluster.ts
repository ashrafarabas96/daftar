import { Client } from 'pg';

/**
 * The scratch cluster this lane talks to. Never a default: a DB proof that
 * silently fell back to a localhost default could be measuring a different
 * cluster than the one the runner prepared, and the report would name a
 * schema that was never touched.
 */
function required(name: string): string {
  const v = process.env[name];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`${name} is not set; run this lane through test/db/run-db-proof.sh`);
  }
  return v;
}

export const ownerUrl = (): string => required('P5_DB_OWNER_URL');
export const appUrl = (): string => required('P5_DB_APP_URL');

/**
 * The schema the BORROWED relations live in.
 *
 * ROUND 12: `p5scratch` in the fixture lane, where they are copies, and
 * `public` in the real-schema lane, where they are the frozen relations
 * created by applying the whole migration history with the project's own
 * runner. The requested DDL references them unqualified and resolves them
 * through `search_path`, so this is the only place a case has to care.
 */
export const borrowedSchema = (): string => process.env['P5_BORROWED_SCHEMA'] ?? 'p5scratch';

/** Which of the two schemas a run measured, for the evidence line. */
export const schemaUnderTest = (): 'fixture' | 'real' =>
  process.env['P5_REAL_SCHEMA'] === '1' ? 'real' : 'fixture';

export async function connect(url: string): Promise<Client> {
  const c = new Client({ connectionString: url });
  await c.connect();
  // ROUND 12, the challenger's F-13. The schema carries the house RLS
  // pattern: a PERMISSIVE tenant-membership policy and a RESTRICTIVE
  // business-scoping policy, default-deny for every role under FORCE ROW
  // LEVEL SECURITY — and a bypass that is a ROLE, not a setting. The live
  // `app_bypass()` is `CURRENT_USER = 'daftar_platform'`, and this lane's
  // copy names `p5owner`, so the owner connection bypasses by being the
  // principal it is and needs no `set_config` at all. An earlier form of
  // this helper set `app.bypass_rls`, which the live function has ignored
  // since `0013_security_boundary.sql`.
  return c;
}

/**
 * A connection with NO request context at all — no business, no tenant, no
 * bypass. What the house pattern promises such a session is zero rows.
 */
export async function connectWithoutContext(url: string): Promise<Client> {
  const c = new Client({ connectionString: url });
  await c.connect();
  return c;
}

/**
 * The REQUEST CONTEXT, set the way the frozen schema expects it.
 *
 * ROUND 12, the challenger's F-13. `0006_rls.sql` scopes a business-scoped
 * table with TWO policies: a permissive tenant-membership policy, which is
 * an EXISTS over `businesses` comparing `b.tenant_id` to `app_tenant()`,
 * and a restrictive business-scoping policy comparing `business_id` to
 * `app_business()`. A session that sets only `app.business_id` therefore
 * satisfies the restrictive half and FAILS the permissive one — which is
 * what this lane did until this round, and what made its isolation claims
 * incomparable with the frozen schema's.
 *
 * `transactionLocal` is the frozen discipline: `set_config(..., true)` has
 * SET LOCAL semantics, so the context dies with the transaction and a
 * pooled connection cannot carry a stale one. It is passed `true` wherever
 * the case owns a transaction, and the sites that do not are the lane's
 * own divergence, recorded in `P5-CHECKPOINT.md` §9 item 3.
 */
export async function setRequestContext(
  c: Client,
  scope: { readonly tenantId: string; readonly businessId: string },
  transactionLocal = false,
): Promise<void> {
  await c.query(`SELECT set_config('app.tenant_id', $1, $3), set_config('app.business_id', $2, $3)`, [
    scope.tenantId,
    scope.businessId,
    transactionLocal,
  ]);
}

export async function pidOf(c: Client): Promise<number> {
  const r = await c.query<{ pid: number }>('SELECT pg_backend_pid()::int AS pid');
  const row = r.rows[0];
  if (row === undefined) throw new Error('pg_backend_pid returned no row');
  return row.pid;
}

/**
 * Wait, bounded, until backend `pid` is parked on a heavyweight lock.
 *
 * The same shape the repository's own interleaving tests use
 * (`tests/helpers/stock-ledger.ts: waitUntilBlocked`), written here rather
 * than imported because that helper belongs to a tree this thread does not
 * own and pulls the root test harness in with it.
 *
 * Why this is a barrier and not a sleep: the PASS is an OBSERVED lock wait
 * on a named backend, read from `pg_stat_activity`. Elapsing time never
 * passes anything — the bound is the failure. A statement that never blocks
 * fails the case instead of being assumed to have blocked.
 */
export async function waitUntilBlocked(observer: Client, pid: number, what: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    const r = await observer.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE pid = $1 AND wait_event_type = 'Lock' AND state = 'active'`,
      [pid],
    );
    if ((r.rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${what}: backend ${pid} never waited on a lock`);
}

/** A point observation, used to prove a statement did NOT block. */
export async function isBlocked(observer: Client, pid: number): Promise<boolean> {
  const r = await observer.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE pid = $1 AND wait_event_type = 'Lock' AND state = 'active'`,
    [pid],
  );
  return (r.rows[0]?.n ?? 0) > 0;
}

export function uuid(): string {
  return crypto.randomUUID();
}

/** The SQLSTATE of a thrown pg error, or '' — asserted on, never a substring of a message. */
export function sqlstate(e: unknown): string {
  return typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string' ? e.code : '';
}

/**
 * The CONSTRAINT a pg error names, or ''. Round 7: asserting a SQLSTATE
 * alone proved too weak. 23503 is the code of every foreign key in the
 * schema, so a case that asserts only `23503` passes when a DIFFERENT key
 * refuses — which is how the first version of the cross-currency case
 * stayed green with the currency removed from the key it was written to
 * observe. A case that names the constraint cannot be satisfied by its
 * neighbour.
 */
export function constraintOf(e: unknown): string {
  return typeof e === 'object' && e !== null && 'constraint' in e && typeof e.constraint === 'string'
    ? e.constraint
    : '';
}

/**
 * The refusal a pg error represents: its SQLSTATE, and the NAME of the
 * defence that produced it when the database gives one — `'23514/si_tax_structural_zero'`.
 *
 * ROUND 10, the independent challenger's F-11. `sqlstate` alone was asserted
 * 38 times in this lane, and the challenger measured what those codes
 * actually are on a clean run: `23514` comes from SIX distinct constraints
 * and was asserted bare ten times, `23505` from four, `23503` from two, and
 * `23000` from at least ten distinct `RAISE` sites and was asserted bare
 * sixteen. So most refusal assertions here could be satisfied by a
 * neighbouring defence, which is the hollowness `constraintOf`'s own
 * round-7 docstring warned about — and which was then applied to six places
 * out of the whole lane.
 *
 * Every `RAISE ... USING` in the schema now carries `CONSTRAINT = '<name>'`,
 * so a plpgsql refusal names itself exactly as a CHECK or a key does, and
 * this is the one function the lane asserts on. `sqlstate` remains for the
 * few cases that are genuinely about the CLASS — a privilege refusal
 * (`42501`) and a deadlock (`40P01`) have no constraint to name.
 */
export function refusedBy(e: unknown): string {
  const code = sqlstate(e);
  if (code === '') return '';
  const constraint = constraintOf(e);
  return constraint === '' ? code : `${code}/${constraint}`;
}
