/**
 * TIME SPENT EXECUTING INSIDE POSTGRESQL, READ FROM `pg_stat_statements` (DR-98).
 *
 * WHY THIS EXISTS. PERF01's budgets A and B are ceilings on what the
 * database costs a posting. They were asserted on the client's wall clock, and
 * the wall clock also contains everything between the test process and the
 * server: a scheduler pause on a shared runner, a garbage collection, a socket
 * that waits for its turn. On CI run 42044287780 the same two budgets passed
 * six times and failed once inside one job, two minutes apart, on identical
 * code: p50 3.7 ms but max 167.7 ms, and the p95 was decided by stalls outside
 * PostgreSQL. This module measures the part the budget is actually about.
 *
 * WHAT A NUMBER FROM HERE IS. The cumulative `total_exec_time` that the server
 * itself accounted to statements run in ONE database by every role except the
 * probe's own, in milliseconds. One iteration's figure is the difference
 * between two reads of that cumulative sum taken on either side of it.
 *
 * WHAT IT IS NOT. It is not a wall clock and not a latency: it has no network,
 * no driver, no HTTP, no JSON, no queueing for a pooled connection. And it is
 * not the whole of the server's work either. Two things are known to sit
 * OUTSIDE it, measured on PostgreSQL 18.4 (a deferred constraint trigger that
 * slept 300 ms at COMMIT: the COMMIT row read 0.0005 ms and the statements the
 * trigger ran read 308 ms, so what a deferred trigger RUNS as SQL is counted,
 * as separate top-level rows, and what happens in COMMIT itself is not):
 *   - the commit's own work after the trigger queue is empty, WAL flush
 *     included, because `COMMIT` is accounted at ProcessUtility and the commit
 *     proper happens after it returns;
 *   - procedural-language time that is not inside a SQL statement.
 * So a pass here says "the SQL the database executed fitted the ceiling", and
 * says nothing about commit durability latency. That is a narrower claim than
 * the one the wall clock made, by design of the decision, and the wall clock
 * keeps being measured and printed beside it.
 *
 * SCOPE OF THE READ. Statistics are cluster-wide shared memory, filtered here
 * by `dbid`, so the view can be read from ANY database in the cluster where
 * the extension exists. It is created in the cluster's maintenance database
 * (`postgres`, `adminUrl`) and not in `daftar`, so the measured database gains
 * no extension objects that a later schema scan could trip over.
 *
 * A statement from another client of the same database inside the window is
 * counted too. In these suites nothing else talks to the database during a
 * measured iteration, and anything that does can only make the figure larger,
 * never hide a cost.
 */
import { Client } from 'pg';
import { adminUrl } from './embedded-cluster';

/**
 * Every failure of the instrument carries one of these ASCII tags, so a red run
 * names what broke instead of looking like a budget that was missed.
 */
export type InstrumentFault = 'UNAVAILABLE' | 'SETTING' | 'BLIND' | 'EVICTED' | 'NEGATIVE';

export class InstrumentError extends Error {
  constructor(
    readonly fault: InstrumentFault,
    detail: string,
  ) {
    super(`PERF01-INSTRUMENT-${fault} ${detail}`);
    this.name = 'InstrumentError';
  }
}

export interface InstrumentSettings {
  readonly sharedPreloadLibraries: string;
  /** `pg_stat_statements.track`, as the server reports it. */
  readonly track: string;
  /** `pg_stat_statements.track_utility`, as the server reports it. */
  readonly trackUtility: string;
  readonly serverVersion: string;
}

export class InDatabaseClock {
  private constructor(
    private readonly client: Client,
    private readonly databaseOid: number,
    private readonly probeRoleOid: number,
    private readonly deallocAtOpen: number,
    readonly settings: InstrumentSettings,
  ) {}

  /**
   * Connects as the cluster superuser, creates the extension, and refuses to
   * continue unless the server really is configured to account what we are
   * about to rely on. Nothing here falls back to anything: no preloaded
   * library means no instrument, and no instrument means a named failure.
   */
  static async open(databaseName = 'daftar'): Promise<InDatabaseClock> {
    const client = new Client({ connectionString: adminUrl });
    await client.connect();
    try {
      const show = async (name: string): Promise<string> => String((await client.query(`SELECT current_setting($1) AS v`, [name])).rows[0]?.v ?? '');
      const preload = await show('shared_preload_libraries');
      if (!preload.split(',').some((lib) => lib.trim() === 'pg_stat_statements')) {
        throw new InstrumentError(
          'UNAVAILABLE',
          `shared_preload_libraries is "${preload}": pg_stat_statements is not loaded. ` +
            `Start the cluster with it (CI: the "pg_stat_statements" step of the backend job; local embedded cluster: PG_PRELOAD_STAT_STATEMENTS=1).`,
        );
      }
      try {
        await client.query(`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`);
      } catch (e) {
        throw new InstrumentError('UNAVAILABLE', `CREATE EXTENSION pg_stat_statements failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      const settings: InstrumentSettings = {
        sharedPreloadLibraries: preload,
        track: await show('pg_stat_statements.track'),
        trackUtility: await show('pg_stat_statements.track_utility'),
        serverVersion: await show('server_version'),
      };
      // Read from the server, not assumed. `top` keeps a statement's own
      // trigger work inside that statement's row (counted once); `all` would
      // count it twice. `track_utility` is what puts BEGIN/COMMIT and the
      // statements around them on the books at all.
      if (settings.track !== 'top') {
        throw new InstrumentError(
          'SETTING',
          `pg_stat_statements.track is "${settings.track}", the measurement requires "top" (nested statements would be counted twice)`,
        );
      }
      if (settings.trackUtility !== 'on') {
        throw new InstrumentError('SETTING', `pg_stat_statements.track_utility is "${settings.trackUtility}", the measurement requires "on"`);
      }
      const db = await client.query<{ oid: number }>(`SELECT oid::int AS oid FROM pg_database WHERE datname = $1`, [databaseName]);
      if (db.rows[0] === undefined) throw new InstrumentError('UNAVAILABLE', `database "${databaseName}" does not exist`);
      const me = await client.query<{ oid: number }>(`SELECT oid::int AS oid FROM pg_roles WHERE rolname = current_user`);
      const info = await client.query<{ dealloc: string }>(`SELECT dealloc::text AS dealloc FROM pg_stat_statements_info`);
      return new InDatabaseClock(client, db.rows[0].oid, must(me.rows[0]).oid, Number(must(info.rows[0]).dealloc), settings);
    } catch (e) {
      await client.end().catch(() => undefined);
      throw e;
    }
  }

  /**
   * The cumulative executed milliseconds so far, for the measured database,
   * excluding the probe's own role. The probe is the superuser on this one
   * connection; the application's principals are all non-superusers, so
   * excluding the probe's role excludes the probe and nothing the budgets are
   * about. `calibrate` proves that, rather than this comment asserting it.
   */
  async cumulativeMs(): Promise<number> {
    const r = await this.client.query<{ ms: number }>(
      `SELECT coalesce(sum(total_exec_time), 0)::float8 AS ms FROM pg_stat_statements WHERE dbid = $1 AND userid <> $2`,
      [this.databaseOid, this.probeRoleOid],
    );
    return must(r.rows[0]).ms;
  }

  /**
   * Positive control for the instrument itself: run a statement known to take
   * at least `knownMs` inside the database, as a NON-superuser principal, and
   * require the instrument to have seen at least that. A probe that filtered
   * away the application's role, or a library that is loaded but accounting
   * nothing, would otherwise read as a database that is wonderfully fast.
   */
  async calibrate(knownMs: number, run: () => Promise<void>): Promise<number> {
    const before = await this.cumulativeMs();
    await run();
    const seen = (await this.cumulativeMs()) - before;
    if (!(seen >= knownMs)) {
      throw new InstrumentError(
        'BLIND',
        `a statement that sleeps ${knownMs} ms inside the database was accounted as ${seen.toFixed(3)} ms: the instrument does not see the application's statements`,
      );
    }
    return seen;
  }

  /** One window's in-database milliseconds, from the two reads around it. */
  static delta(before: number, after: number): number {
    const d = after - before;
    if (d < 0)
      throw new InstrumentError('NEGATIVE', `the cumulative sum went DOWN by ${(-d).toFixed(3)} ms inside one window: statistics were reset or evicted`);
    return d;
  }

  /**
   * `pg_stat_statements` forgets the least-used entries once it holds
   * `pg_stat_statements.max` of them, and a forgotten entry takes its time with
   * it, which would make a later window read LOWER than it was. The server
   * counts those evictions (`dealloc`); none may have happened since `open`.
   */
  async assertNoEviction(): Promise<void> {
    const info = await this.client.query<{ dealloc: string }>(`SELECT dealloc::text AS dealloc FROM pg_stat_statements_info`);
    const now = Number(must(info.rows[0]).dealloc);
    if (now !== this.deallocAtOpen) {
      throw new InstrumentError(
        'EVICTED',
        `pg_stat_statements evicted entries during the run (dealloc ${this.deallocAtOpen} -> ${now}): the in-database sums are not trustworthy`,
      );
    }
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new InstrumentError('UNAVAILABLE', 'the server returned no row for a query that always returns one');
  return value;
}
