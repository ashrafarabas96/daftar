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

export async function connect(url: string): Promise<Client> {
  const c = new Client({ connectionString: url });
  await c.connect();
  return c;
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
