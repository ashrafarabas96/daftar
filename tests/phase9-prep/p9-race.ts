import { appendFileSync } from 'node:fs';
/**
 * P9 PREP — RACING REAL TRANSACTIONS, WITHOUT A SLEEP.
 *
 * Master directive Part 39: where database races matter, use real
 * PostgreSQL, multiple connections, transaction barriers and deterministic
 * lock ordering — never `sleep()` as proof, never a JS object standing in for
 * a DB race.
 *
 * The barrier here is the database's own. An exclusion constraint is checked
 * at statement time against the index, so a second transaction inserting an
 * overlapping row does not fail and does not succeed: it BLOCKS on the first
 * transaction's uncommitted index entry until that transaction ends. So the
 * ordering is established by PostgreSQL, and this module only has to observe
 * it — `awaitBlocked` polls `pg_blocking_pids`, which is the server's own
 * answer to "who is waiting on whom", and returns as soon as the wait is
 * real. It never sleeps a fixed interval and it never assumes a wait; a run
 * that does not reach the expected number of blocked backends fails, naming
 * how many it saw.
 */
import { Client } from 'pg';

/** One racer: its own connection, its own transaction. */
export interface Racer {
  readonly client: Client;
  readonly pid: number;
}

/** Open `n` connections and leave each in an open transaction. */
export async function openRacers(url: string, n: number): Promise<Racer[]> {
  const racers: Racer[] = [];
  for (let i = 0; i < n; i += 1) {
    const client = new Client({ connectionString: url });
    await client.connect();
    const pid = Number((await client.query<{ p: number }>('SELECT pg_backend_pid() AS p')).rows[0]?.p);
    if (!Number.isInteger(pid)) throw new Error('could not read a racer backend pid');
    racers.push({ client, pid });
  }
  for (const r of racers) await r.client.query('BEGIN');
  return racers;
}

export async function closeRacers(racers: readonly Racer[]): Promise<void> {
  for (const r of racers) await r.client.end().catch(() => undefined);
}

/**
 * Wait until `expected` of `pids` are genuinely blocked, as the server says.
 *
 * Returns the blocked pids. Throws naming the count it reached, because
 * "the race did not actually contend" is a different failure from "the
 * constraint did not hold" and a proof that confused them would be worthless.
 */
export async function awaitBlocked(observer: Client, pids: readonly number[], expected: number, deadlineMs = 60_000): Promise<number[]> {
  const until = Date.now() + deadlineMs;
  let blocked: number[] = [];
  let polls = 0;
  trace(`awaitBlocked entered pids=${JSON.stringify([...pids])} expected=${expected}`);
  while (blocked.length < expected && Date.now() < until) {
    const r = await observer.query<{ pid: number; b: number[] }>(`SELECT pid, pg_blocking_pids(pid) AS b FROM pg_stat_activity WHERE pid = ANY($1::int[])`, [
      [...pids],
    ]);
    blocked = r.rows.filter((x) => x.b.length > 0).map((x) => x.pid);
    polls += 1;
    if (polls === 1 || polls % 500 === 0) trace(`poll ${polls} rows=${JSON.stringify(r.rows)}`);
    if (blocked.length < expected) await yieldToDrivers();
  }
  if (blocked.length < expected) {
    throw new Error(
      `expected ${expected} of ${pids.length} backends to block on the booking invariant; observed ${blocked.length} over ${polls} polls of pg_blocking_pids in ${deadlineMs}ms — the transactions did not contend, so nothing was proven`,
    );
  }
  return blocked;
}

/**
 * Hand the event loop back, so the racers' own sockets can be written.
 *
 * This is NOT a sleep standing in for a proof (Part 39) and it is not a
 * timing assumption. Every racer, the observer and this loop share one Node
 * event loop; an uninterrupted poll loop can therefore spend its whole
 * deadline before the racers' INSERTs have even been flushed to the server,
 * which is exactly how the first version of this helper produced a failure
 * in two runs out of five. The proof is still `pg_blocking_pids` — the
 * server's own answer to who is waiting on whom — and a wait that never
 * becomes real fails above instead of being assumed.
 */
function yieldToDrivers(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 1);
  });
}

export type Attempt = { readonly i: number; readonly ok: true } | { readonly i: number; readonly ok: false; readonly code: string; readonly message: string };

/** Issue one statement per racer, without awaiting any of them. */
export function issue(racers: readonly Racer[], sql: string, params: (i: number) => unknown[]): Promise<Attempt>[] {
  return racers.map((r, i) =>
    r.client.query(sql, params(i)).then(
      (): Attempt => ({ i, ok: true }),
      (e: unknown): Attempt => ({
        i,
        ok: false,
        code: typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : '',
        message: e instanceof Error ? e.message : String(e),
      }),
    ),
  );
}

/** COMMIT every racer, swallowing the failure of one already aborted. */
export async function commitAll(racers: readonly Racer[]): Promise<void> {
  await Promise.all(racers.map((r) => r.client.query('COMMIT').catch(() => undefined)));
}

/** The outcome of a race: who committed, and under which SQLSTATEs the rest failed. */
export interface RaceOutcome {
  readonly committed: number;
  readonly refused: number;
  readonly codes: readonly string[];
  readonly blocked: number;
}

export function summarise(attempts: readonly Attempt[], blocked: number): RaceOutcome {
  const refused = attempts.filter((a): a is Extract<Attempt, { ok: false }> => !a.ok);
  return {
    committed: attempts.length - refused.length,
    refused: refused.length,
    codes: [...new Set(refused.map((a) => a.code))].sort(),
    blocked,
  };
}

/** Tracing that vitest cannot swallow: straight to a file. */
export function trace(line: string): void {
  if (process.env['P9_TRACE'] === undefined) return;
  try {
    appendFileSync(process.env['P9_TRACE'], `${new Date().toISOString()} ${line}\n`);
  } catch {
    // tracing must never change a result
  }
}
