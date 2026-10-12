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
 * A role holding nothing but USAGE on the schema. ROUND 15, the independent
 * challenger's F-14 second leg: it measured that such a role could read
 * another tenant's grant count through the PUBLIC EXECUTE default on a
 * definer routine. The lane sets `P5_DB_STRANGER_URL`.
 */
export const strangerUrl = (): string => required('P5_DB_STRANGER_URL');
/**
 * The CLUSTER SUPERUSER, which both lanes already export because the
 * bootstrap file has to be applied by one.
 *
 * ROUND 16, the independent challenger's F-16: its measurement needed a role
 * MEMBERSHIP that the project's bootstrap deliberately does not create, and
 * only a role administrator can create one. The challenger planted it by
 * hand. The case plants and removes it itself instead, so the cluster is left
 * as it was found and the proof is repeatable — it is the only thing in this
 * lane that connects as a superuser, and it executes no part of the schema
 * under test as one, because a superuser bypasses RLS and would turn a proof
 * into a tautology.
 */
export const bootstrapUrl = (): string => required('P5_DB_BOOTSTRAP_URL');

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
export const schemaUnderTest = (): 'fixture' | 'real' => (process.env['P5_REAL_SCHEMA'] === '1' ? 'real' : 'fixture');

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
 * ROUND 12, the challenger's F-13: a business-scoped relation is guarded by
 * TWO policies, a permissive tenant one and a restrictive business one, so a
 * session that sets only `app.business_id` satisfies the restrictive half,
 * fails the permissive one, and can do nothing at all. The context is set as
 * a PAIR, always, which is what this helper exists for.
 *
 * ROUND 14, THE COORDINATOR'S DIFF-REVIEW R-2, AND IT IS A FAIR HIT: the
 * scope used to be an OPTIONAL argument defaulting to session-level, 12 of
 * 13 call sites took the default, and the pack claimed the lane set the
 * context "per transaction". The claim was false and the default is what
 * made it easy to be false — a reader of a call site could not see which
 * discipline it had chosen.
 *
 * So there is NO DEFAULT any more. Every caller names its scope:
 *
 *   'transaction'  `set_config(…, true)`, SET LOCAL semantics — the frozen
 *                  discipline. The context dies with the transaction, so a
 *                  pooled connection cannot carry a stale one. Only
 *                  meaningful inside an explicit transaction: outside one,
 *                  every statement is its own transaction and the context
 *                  would be gone before the next query.
 *   'session'      `set_config(…, false)` — this lane's divergence, for the
 *                  many cases that are a single statement with no
 *                  transaction of their own. It is a property of the TEST,
 *                  not of the requested DDL: no policy reads a GUC directly
 *                  and the DDL sets no context at all.
 *
 * The count of 'session' sites is pinned by a law in
 * `test/db-refusals-name-their-defence.test.ts`, so it cannot drift back up
 * silently, and `P5-CHECKPOINT.md` §9.3 records the divergence.
 */
export type ContextScope = 'transaction' | 'session';

export async function setRequestContext(
  c: Client,
  scope: { readonly tenantId: string; readonly businessId: string },
  contextScope: ContextScope,
): Promise<void> {
  await c.query(`SELECT set_config('app.tenant_id', $1, $3), set_config('app.business_id', $2, $3)`, [
    scope.tenantId,
    scope.businessId,
    contextScope === 'transaction',
  ]);
}

export async function pidOf(c: Client): Promise<number> {
  const r = await c.query<{ pid: number }>('SELECT pg_backend_pid()::int AS pid');
  const row = r.rows[0];
  if (row === undefined) throw new Error('pg_backend_pid returned no row');
  return row.pid;
}

/**
 * What the OBSERVER can actually see about one backend.
 *
 * ROUND 18, GAP 1, and this thread's own finding. `wait_event_type` was read
 * straight out of `pg_stat_activity`, and PostgreSQL NULLs `state`, `query`
 * and the wait columns of a backend belonging to a role the observer is not
 * a member of. So when Gap 1 moved the writers from the bypass principal to
 * `p5_app`, the barrier below said "backend 3580 never waited on a lock"
 * about a backend that was, at that moment, parked on exactly that lock: the
 * instrument reported its own BLINDNESS as a negative observation. Measured
 * on the lane's cluster, one `p5_app` holder and one `p5_app` waiter:
 * `p5owner` counted 0 Lock-waiting backends, the superuser counted 1, and
 * after `GRANT pg_read_all_stats TO p5owner` (now in
 * `credit-ledger-bootstrap.sql`) `p5owner` counted 1 too.
 *
 * The grant is the remedy; this function is the GUARD, so that a lane whose
 * observer loses that membership fails loudly instead of quietly confirming
 * every negative. `visible` is the discriminator: a row the observer may not
 * read still appears, with `state` NULL.
 *
 * ONE APPROXIMATION, NAMED (the challenger's round-13 P3). `state IS NULL` is
 * read as "I may not see this backend", and that is not the only way a NULL
 * gets there: a background worker, or an autovacuum backend, also reports a
 * NULL `state` to anyone. The direction of the error is what makes it
 * acceptable — such a row is reported as unreadable rather than as "it did
 * not wait", so the mistake is a loud failure and never a silent pass. The
 * precise test would be `pg_has_role(usename, 'USAGE')` plus
 * `pg_read_all_stats` membership, which is more machinery than a barrier over
 * backends this suite itself opened needs.
 */
async function observe(observer: Client, pid: number): Promise<{ present: boolean; visible: boolean; waiting: boolean }> {
  const r = await observer.query<{ present: boolean; visible: boolean; waiting: boolean }>(
    `SELECT true AS present,
            (state IS NOT NULL) AS visible,
            (wait_event_type = 'Lock' AND state = 'active') AS waiting
       FROM pg_stat_activity WHERE pid = $1`,
    [pid],
  );
  const row = r.rows[0];
  if (row === undefined) return { present: false, visible: false, waiting: false };
  return { present: true, visible: row.visible, waiting: row.waiting };
}

/** The one message that names WHY no wait was seen, so blindness cannot read as absence. */
function blindnessOr(seen: { present: boolean; visible: boolean }, pid: number, what: string): string {
  if (!seen.present) return `${what}: no backend ${pid} in pg_stat_activity at all`;
  if (!seen.visible)
    return (
      `${what}: the observer cannot READ backend ${pid} — pg_stat_activity hides state and the wait ` +
      `columns of another role's backend, so this is not an observation that it did not wait. ` +
      `The observing principal needs pg_read_all_stats (granted in credit-ledger-bootstrap.sql).`
    );
  return `${what}: backend ${pid} never waited on a lock`;
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
  let seen = { present: false, visible: false, waiting: false };
  for (let i = 0; i < 400; i += 1) {
    seen = await observe(observer, pid);
    if (seen.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(blindnessOr(seen, pid, what));
}

/**
 * A point observation, used to prove a statement did NOT block.
 *
 * It THROWS rather than returning false when the observer cannot read the
 * backend. A negative is the whole purpose of this call, and a blind
 * observer returns the negative the caller is hoping for.
 */
export async function isBlocked(observer: Client, pid: number): Promise<boolean> {
  const seen = await observe(observer, pid);
  if (!seen.present || !seen.visible) {
    throw new Error(blindnessOr(seen, pid, 'isBlocked'));
  }
  return seen.waiting;
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
  return typeof e === 'object' && e !== null && 'constraint' in e && typeof e.constraint === 'string' ? e.constraint : '';
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
