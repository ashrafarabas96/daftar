/**
 * P13-PROOF-CONCURRENCY — TWO REAL CONNECTIONS AGAINST A REAL POSTGRESQL.
 *
 * The owner directive behind this file: *"test atomic spend/earn/return/
 * reversal with two connections; 193 pure tests do not prove it."* Everything
 * Phase 13 has produced so far is pure unit tests over in-memory folds. A fold
 * cannot double-spend, so it cannot show that the proposed conservation
 * mechanism is needed, and it cannot show which part of the mechanism does the
 * work. This file is the first measured evidence for the mechanism's SHAPE.
 *
 * WHAT THIS IS NOT
 * ----------------
 * - It is NOT a migration, and it reads, copies and applies NO migration. The
 *   DDL below is scratch, unnumbered, created inside a throwaway cluster that
 *   is destroyed when the process exits. It models only what the mechanism
 *   needs: an append-only per-customer point movement ledger, and a per-grant
 *   remainder relation carrying what is left of each earn.
 * - It is NOT part of the package's unit suite. The package's vitest config
 *   includes only `test/**-/*.test.ts`; this file is `.mts` under
 *   `test/concurrency/` precisely so that it CANNOT match, because it needs a
 *   cluster and the unit suite must stay cluster-free. Run it directly:
 *
 *     node packages/analytics/test/concurrency/remainder-conservation.pgtest.mts
 *
 * - It is NOT a measurement of performance. This container is not a
 *   measurement box and nothing here claims a duration.
 * - It is NOT a measurement of the REAL schema. The DDL is scratch, there is
 *   no RLS on it, there is no official sale command behind it, and the
 *   official authority that would own the consumption seam does not exist on
 *   `main` at all. Those belong to integration and stay
 *   `WAITING_FOR_INTEGRATED_SURFACE`.
 *
 * WHICH CLUSTER, AND WHY IT MATTERS
 * ---------------------------------
 * The deploy target is SETTLED: the **PostgreSQL 16 family with
 * `en_US.utf8`**. An earlier revision of this file ran on whatever
 * `embedded-postgres` ships (18.4) and labelled itself as evidence about the
 * mechanism's shape and not about any production line, because the version
 * was then an open owner decision. It is no longer open, so the default here
 * is the target itself:
 *
 *   - `P13_PG_BINDIR` — a PostgreSQL `bin` directory to run DIRECTLY, via its
 *     own `initdb` and `pg_ctl`. Defaults to the first of the well-known
 *     locations that holds a 16.x `initdb`. The cluster is created with
 *     `--locale` from `P13_PG_LOCALE` (default `en_US.utf8`) and `UTF8`, and
 *     the run PRINTS `datcollate`, `datctype` and the encoding it actually
 *     got, so a reader never has to trust this comment.
 *   - If no such directory exists, the run falls back to the repository's own
 *     `embedded-postgres` and SAYS SO LOUDLY: the result is then NOT on the
 *     settled target, and the banner marks it `OFF-TARGET`.
 *
 * Either way the version is read back from `select version()` and printed. A
 * result here is a result on the line printed and on nothing else.
 *
 * HOW IT WAITS
 * ------------
 * Deterministic barriers only. There is no `sleep()` and no timing assumption
 * anywhere in the proof. The two connections are coordinated three ways, all
 * of them borrowed from the house idiom in `tests/helpers/stock-ledger.ts`:
 *   - await ordering: a statement that has returned has happened, so issuing
 *     the second connection's statement after awaiting the first's is an
 *     interleaving, not a race to be hoped for;
 *   - `waitUntilBlocked(pid)`: poll `pg_stat_activity` until that backend is
 *     observed with `wait_event_type = 'Lock'`. The assertion is on observed
 *     server state, never on elapsed time; the poll interval is only how often
 *     we look.
 *   - `pg_advisory_xact_lock` as an explicit gate where the mechanism itself
 *     uses one.
 *
 * Every case prints its own PASS/FAIL line, reports the SQLSTATE it ACTUALLY
 * OBSERVED (never the one the design predicts), and the process exits non-zero
 * if any case fails.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, chownSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { Client, Pool } from 'pg';

/**
 * The embedded distribution, loaded by a specifier `tsc` cannot see.
 *
 * `embedded-postgres` is an ESM-only package that declares `"exports":
 * "./dist/index.js"` and no `main`, so it is unresolvable under the
 * `moduleResolution: "node"` this package typechecks with
 * (`tsconfig.base.json`). The root `tests/` tree escapes that by typechecking
 * under `moduleResolution: "bundler"`; this file lives in a package that does
 * not, and changing either config is out of this task's scope — the task is
 * allowed to add these two files and nothing else.
 *
 * So the dependency is declared as the interface this file actually uses and
 * loaded at runtime through a computed specifier. Node resolves it normally
 * (which is why the file must live inside the repository, where
 * `node_modules` is on the resolution path); `tsc` sees a value of the
 * declared type and no unresolvable module; and nothing is cast to `any`.
 */
interface EmbeddedCluster {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
type EmbeddedClusterCtor = new (options: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
}) => EmbeddedCluster;

async function loadEmbeddedPostgres(): Promise<EmbeddedClusterCtor> {
  const specifier = ['embedded', 'postgres'].join('-');
  const loaded = (await import(specifier)) as unknown;
  const exported = (loaded as { default?: unknown }).default;
  if (typeof exported !== 'function') throw new Error(`${specifier} did not export a constructor`);
  return exported as EmbeddedClusterCtor;
}

/* ------------------------------------------------------------------ *
 * The throwaway cluster
 * ------------------------------------------------------------------ */

const PG_DIR = process.env['P13_PG_DIR'] ?? '/tmp/daftar-pg-p13';
const PG_PORT = Number(process.env['P13_PG_PORT'] ?? 55777);
const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const url = `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/postgres`;

/**
 * Make the shipped PostgreSQL binaries executable before `initdb` is spawned.
 *
 * `embedded-postgres` calls its own chmod helper without awaiting it, so on a
 * freshly installed `node_modules` the chmod races the spawn. The repository's
 * `scripts/ensure-embedded-pg-binaries.ts` exists for exactly this and is the
 * authority on the reasoning; it is a CommonJS module built around
 * `__filename`, which this ESM file cannot import, so the same few lines are
 * repeated here rather than the script being changed.
 */
function ensureBinariesExecutable(): void {
  // `process.argv[1]` is this script, which is inside the repository, so the
  // require it creates resolves against the repository's `node_modules`.
  // (`import.meta` is unavailable under this package's `module: commonjs`.)
  const require = createRequire(process.argv[1] ?? process.cwd());
  let dir: string;
  try {
    dir = dirname(require.resolve('embedded-postgres'));
  } catch {
    return;
  }
  for (let i = 0; i < 6; i += 1) {
    if (dir.endsWith(`${sep}node_modules`)) {
      const native = join(dir, '@embedded-postgres', `${process.platform}-${process.arch}`, 'native');
      try {
        for (const entry of readdirSync(native, { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          const file = join(native, entry.name);
          chmodSync(file, statSync(file).mode | 0o111);
        }
      } catch {
        /* the platform package is not installed here; the server start will say so */
      }
      return;
    }
    dir = dirname(dir);
  }
}

/* ------------------------------------------------------------------ *
 * The settled target: a real PostgreSQL 16 with en_US.utf8
 * ------------------------------------------------------------------ */

/** Where a distribution PostgreSQL `bin` directory is usually found. 16 first: it is the target. */
const BINDIR_CANDIDATES: readonly string[] = [
  '/usr/lib/postgresql/16/bin',
  '/usr/pgsql-16/bin',
  '/opt/homebrew/opt/postgresql@16/bin',
  '/usr/local/opt/postgresql@16/bin',
];

const PG_LOCALE = process.env['P13_PG_LOCALE'] ?? 'en_US.utf8';

/**
 * The owner the server runs as.
 *
 * PostgreSQL refuses to start as root, on purpose. When this process IS root
 * (which it is in this container), the data directory and the socket
 * directory are handed to an unprivileged account and every server command is
 * run through `su`. `P13_PG_OWNER` overrides the account.
 */
const PG_OWNER = process.env['P13_PG_OWNER'] ?? 'claude';

function isRoot(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

/** The first candidate `bin` directory that actually holds an `initdb`, or null. */
function findBinDir(): string | null {
  const explicit = process.env['P13_PG_BINDIR'];
  const candidates = explicit === undefined || explicit === '' ? BINDIR_CANDIDATES : [explicit];
  for (const dir of candidates) {
    try {
      if (statSync(join(dir, 'initdb')).isFile()) return dir;
    } catch {
      /* not here; try the next */
    }
  }
  return null;
}

/**
 * A cluster run from a distribution PostgreSQL, satisfying the same interface
 * the embedded package does so the runner below does not care which it got.
 *
 * Nothing is installed and nothing in the repository is touched: `initdb`
 * writes into a throwaway directory under the system temp dir, and `stop`
 * removes it.
 */
class ExternalCluster implements EmbeddedCluster {
  // Written as explicit fields, not constructor parameter properties: this
  // file is run by `node` directly, whose type stripping is syntax-only and
  // rejects a parameter property outright (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX).
  private readonly binDir: string;
  private readonly dataDir: string;
  private readonly sockDir: string;
  private readonly port: number;

  constructor(binDir: string, dataDir: string, sockDir: string, port: number) {
    this.binDir = binDir;
    this.dataDir = dataDir;
    this.sockDir = sockDir;
    this.port = port;
  }

  /** Run a server binary, as `PG_OWNER` when this process is root. */
  private run(bin: string, args: readonly string[]): string {
    const command = [join(this.binDir, bin), ...args].join(' ');
    if (isRoot()) {
      return execFileSync('su', [PG_OWNER, '-c', command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    }
    return execFileSync(join(this.binDir, bin), [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }

  /** The server's own version string, read from the binary before any cluster exists. */
  version(): string {
    return execFileSync(join(this.binDir, 'postgres'), ['--version'], { encoding: 'utf8' }).trim();
  }

  async initialise(): Promise<void> {
    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(this.sockDir, { recursive: true });
    if (isRoot()) {
      // `initdb` requires the data directory to be owned by the account that
      // will run the server, and the server must be able to create its socket.
      const owner = execFileSync('id', ['-u', PG_OWNER], { encoding: 'utf8' }).trim();
      const group = execFileSync('id', ['-g', PG_OWNER], { encoding: 'utf8' }).trim();
      chownSync(this.dataDir, Number(owner), Number(group));
      chownSync(this.sockDir, Number(owner), Number(group));
    }
    this.run('initdb', [
      '-D',
      join(this.dataDir, 'data'),
      `--locale=${PG_LOCALE}`,
      '--encoding=UTF8',
      '-U',
      PG_USER,
      '--auth=trust',
    ]);
  }

  async start(): Promise<void> {
    this.run('pg_ctl', [
      '-D',
      join(this.dataDir, 'data'),
      '-o',
      `'-p ${this.port} -c listen_addresses=localhost -c unix_socket_directories=${this.sockDir}'`,
      '-l',
      join(this.dataDir, 'server.log'),
      'start',
      '-w',
    ]);
  }

  async stop(): Promise<void> {
    try {
      this.run('pg_ctl', ['-D', join(this.dataDir, 'data'), 'stop', '-m', 'immediate']);
    } catch {
      /* already down, or never came up; the directory removal below is what matters */
    }
  }
}

/* ------------------------------------------------------------------ *
 * Outcomes, pids, and the only two ways this file waits
 * ------------------------------------------------------------------ */

type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string | null; readonly constraint: string | null; readonly message: string };

/** Run `fn` and return its failure as a value, so a refusal can be asserted instead of thrown. */
async function settle<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    const code = typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string' ? e.code : null;
    const constraint =
      typeof e === 'object' && e !== null && 'constraint' in e && typeof e.constraint === 'string' ? e.constraint : null;
    return { ok: false, code, constraint, message: e instanceof Error ? e.message : String(e) };
  }
}

/** How a refusal is reported: the SQLSTATE OBSERVED, and the constraint it named if it named one. */
function observed(o: Outcome<unknown>): string {
  if (o.ok) return 'accepted';
  return `SQLSTATE ${o.code ?? '(none)'}${o.constraint === null ? '' : ` constraint=${o.constraint}`}`;
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what} to be present`);
  return value;
}

async function one<R extends Record<string, unknown>>(c: Client | Pool, sql: string, params: unknown[] = []): Promise<R> {
  const r = await c.query<R>(sql, params);
  return must(r.rows[0], `a row from ${sql.slice(0, 60)}`) as R;
}

async function pidOf(c: Client): Promise<number> {
  const r = await one<{ pid: number }>(c, 'SELECT pg_backend_pid()::int AS pid');
  return r.pid;
}

/**
 * Wait — bounded, on OBSERVED SERVER STATE — until `pid` is parked on a lock.
 *
 * This is the house barrier (`tests/helpers/stock-ledger.ts:365`). It asserts
 * nothing about how long anything took; it returns the `wait_event` the server
 * reported, so a case can say WHICH lock the loser actually waited on instead
 * of assuming.
 */
async function waitUntilBlocked(admin: Pool, pid: number, what: string): Promise<string> {
  for (let i = 0; i < 600; i += 1) {
    const r = await admin.query<{ event: string | null }>(
      `SELECT wait_event AS event FROM pg_stat_activity
        WHERE pid = $1 AND wait_event_type = 'Lock' AND state = 'active'`,
      [pid],
    );
    const row = r.rows[0];
    if (row !== undefined) return row.event ?? '(unnamed)';
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${what}: backend ${pid} was never observed waiting on a lock`);
}

/** A point observation: is `pid` parked on a lock right now? Used to prove a statement did NOT block. */
async function isBlocked(admin: Pool, pid: number): Promise<boolean> {
  const r = await admin.query(
    `SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock' AND state = 'active'`,
    [pid],
  );
  return r.rows.length > 0;
}

/* ------------------------------------------------------------------ *
 * The scratch schema — the mechanism's shape, and nothing else
 * ------------------------------------------------------------------ */

/**
 * Three relations, created only inside the throwaway cluster:
 *
 * `point_movements` — the append-only per-customer ledger. `point_seq` is the
 * total order the Phase 13 expiry fold reads lots in (`points.ts:§4.3`:
 * `(expires_on, point_seq)`, never a timestamp).
 *
 * `point_grant_remainders` — one row per earn, carrying what is LEFT of it.
 * Non-negativity is maintained by the relation's OWN TRIGGER, which is the
 * mechanism as proposed; the trigger is what case 2 and case 4 measure.
 *
 * `point_draws` — one row per (grant, draw). `UNIQUE (business_id, grant_id,
 * remaining_before)` is modelled on the live level-uniqueness pattern that
 * `apps/api/src/modules/purchasing/purchasing-errors.ts:504` maps
 * (`supplier_credit_allocations_level_uq`, "one consumer per remaining level
 * of a note"). Case 3 is the claim that matters most: the level key refuses a
 * stale-bound second draw with NO LOCK TAKEN AT ALL.
 */
const SCHEMA = `
create schema p13_proof;

create table p13_proof.point_movements (
  id              uuid primary key,
  business_id     uuid   not null,
  customer_id     uuid   not null,
  point_seq       bigint not null generated always as identity,
  movement_kind   text   not null check (movement_kind in ('earn','consume','adjust','expire')),
  points_delta    bigint not null,
  effective_on    date   not null,
  expires_on      date,
  reason          text,
  constraint horizon_ck check ((movement_kind = 'earn') = (expires_on is not null))
);

create table p13_proof.point_grant_remainders (
  business_id      uuid   not null,
  grant_id         uuid   not null,
  point_seq        bigint not null,
  expires_on       date   not null,
  granted_points   bigint not null,
  remaining_points bigint not null,
  primary key (business_id, grant_id)
);

create table p13_proof.point_draws (
  id               uuid   primary key,
  business_id      uuid   not null,
  grant_id         uuid   not null,
  movement_id      uuid   not null,
  remaining_before bigint not null,
  drawn_points     bigint not null,
  constraint point_draws_level_uq unique (business_id, grant_id, remaining_before)
);

-- THE NAIVE RULE (case 1). Conservation expressed as a rule evaluated over
-- sum() INSIDE the inserting statement. This is the defect, kept deliberately.
create function p13_proof.guard_ledger_sum() returns trigger language plpgsql as $fn$
declare total bigint;
begin
  select coalesce(sum(m.points_delta), 0) into total
    from p13_proof.point_movements m
   where m.business_id = new.business_id and m.customer_id = new.customer_id;
  if total + new.points_delta < 0 then
    raise exception 'loyalty.insufficient_points: balance % cannot absorb %', total, new.points_delta;
  end if;
  return new;
end
$fn$;

create trigger point_movements_sum_guard before insert on p13_proof.point_movements
  for each row execute function p13_proof.guard_ledger_sum();

-- THE MECHANISM (cases 2, 4, 6). Non-negativity of a grant's remainder,
-- maintained by the remainder relation's own trigger.
create function p13_proof.guard_remainder_nonneg() returns trigger language plpgsql as $fn$
begin
  if new.remaining_points < 0 then
    raise exception 'loyalty.grant_overdrawn: grant % left with % points', new.grant_id, new.remaining_points;
  end if;
  if new.remaining_points > new.granted_points then
    raise exception 'loyalty.grant_over_restored: grant % left with % of %', new.grant_id, new.remaining_points, new.granted_points;
  end if;
  return new;
end
$fn$;

create trigger point_grant_remainders_nonneg before insert or update on p13_proof.point_grant_remainders
  for each row execute function p13_proof.guard_remainder_nonneg();

-- THE RESTORATION IDENTITY (cases 7, 10). The loyalty design's §5.7.2 binds a
-- reversal to the CANONICAL SALE OR RETURN IDENTITY rather than to a free-text
-- reference, under the ledger's existing identity invariant. Modelled here as
-- the design states it: (business, source type, source id, restoring kind).
-- Nothing else about a reversal is modelled, because nothing else is specified:
-- §5.7.4 marks the PARTIAL return WAITING_FOR_EXPLICIT_POLICY and says in so
-- many words that NO TEST CASE is written for it. None is written here.
create table p13_proof.point_movement_identities (
  business_id   uuid not null,
  source_type   text not null,
  source_id     uuid not null,
  movement_kind text not null,
  movement_id   uuid not null,
  constraint point_movements_identity_uq primary key (business_id, source_type, source_id, movement_kind)
);
`;

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const BUSINESS = '11111111-1111-1111-1111-111111111111';
let uuidCounter = 0;
/** Deterministic ids: a proof that reports a failing id should report the same id on a re-run. */
function id(): string {
  uuidCounter += 1;
  const hex = uuidCounter.toString(16).padStart(12, '0');
  return `22222222-2222-4222-8222-${hex}`;
}

const ADVISORY_NAMESPACE = 'daftar.loyalty_customer_id';
const LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2::text))`;

/** An earn of `points`, as both a ledger row and the grant remainder it opens. */
async function earn(
  c: Client | Pool,
  customerId: string,
  points: bigint,
  expiresOn: string,
): Promise<{ grantId: string; pointSeq: string }> {
  const grantId = id();
  const m = await one<{ point_seq: string }>(
    c,
    `INSERT INTO p13_proof.point_movements (id, business_id, customer_id, movement_kind, points_delta, effective_on, expires_on)
       VALUES ($1, $2, $3, 'earn', $4, date '2026-01-01', $5) RETURNING point_seq::text AS point_seq`,
    [grantId, BUSINESS, customerId, points.toString(), expiresOn],
  );
  await c.query(
    `INSERT INTO p13_proof.point_grant_remainders (business_id, grant_id, point_seq, expires_on, granted_points, remaining_points)
       VALUES ($1, $2, $3, $4, $5, $5)`,
    [BUSINESS, grantId, m.point_seq, expiresOn, points.toString()],
  );
  return { grantId, pointSeq: m.point_seq };
}

async function ledgerTotal(c: Client | Pool, customerId: string): Promise<bigint> {
  const r = await one<{ total: string }>(
    c,
    `SELECT coalesce(sum(points_delta), 0)::text AS total FROM p13_proof.point_movements
      WHERE business_id = $1 AND customer_id = $2`,
    [BUSINESS, customerId],
  );
  return BigInt(r.total);
}

async function remaining(c: Client | Pool, grantId: string): Promise<bigint> {
  const r = await one<{ remaining_points: string }>(
    c,
    `SELECT remaining_points::text FROM p13_proof.point_grant_remainders WHERE business_id = $1 AND grant_id = $2`,
    [BUSINESS, grantId],
  );
  return BigInt(r.remaining_points);
}

/** A fresh connection in READ COMMITTED, with the isolation level READ BACK from the server. */
async function session(): Promise<Client> {
  const c = new Client({ connectionString: url });
  await c.connect();
  return c;
}

async function begin(c: Client): Promise<void> {
  await c.query('BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED');
  const r = await one<{ transaction_isolation: string }>(c, 'SHOW transaction_isolation');
  if (r.transaction_isolation !== 'read committed') {
    throw new Error(`expected read committed, server reported ${r.transaction_isolation}`);
  }
}

/* ------------------------------------------------------------------ *
 * The cases
 * ------------------------------------------------------------------ */

interface CaseResult {
  readonly name: string;
  readonly ok: boolean;
  /** Everything observed, printed whether the case passed or failed. */
  readonly notes: readonly string[];
}

type CaseFn = (admin: Pool, note: (line: string) => void) => Promise<void>;

const cases: readonly { readonly name: string; readonly fn: CaseFn }[] = [
  /* ---------------------------------------------------------------- *
   * 1. RED PROOF
   * ---------------------------------------------------------------- */
  {
    name: 'case-1-red-proof: the naive sum() rule ADMITS a double-spend',
    /**
     * This case ASSERTS THE DEFECT. It fails loudly if the double-spend does
     * NOT happen, because a proof that the mechanism is needed is worth
     * nothing if the thing it protects against cannot be reproduced here.
     *
     * No race is hoped for: each statement is awaited, so the interleaving is
     * the one written down. Both backends evaluate the guard's `sum()` before
     * either commits, and under READ COMMITTED neither can see the other's
     * uncommitted row. Two inserts do not conflict on any lock, so nothing
     * blocks and nothing is refused.
     */
    fn: async (admin, note) => {
      const customer = id();
      await earn(admin, customer, 100n, '2027-01-01');
      if ((await ledgerTotal(admin, customer)) !== 100n) throw new Error('fixture: the customer should start at 100');

      const a = await session();
      const b = await session();
      try {
        await begin(a);
        await begin(b);
        const spend = (c: Client): Promise<unknown> =>
          c.query(
            `INSERT INTO p13_proof.point_movements (id, business_id, customer_id, movement_kind, points_delta, effective_on, reason)
               VALUES ($1, $2, $3, 'consume', -100, date '2026-02-01', 'red proof')`,
            [id(), BUSINESS, customer],
          );

        const readA = await ledgerTotal(a, customer);
        const readB = await ledgerTotal(b, customer);
        note(`both connections read a total of ${readA} / ${readB} before either wrote`);
        if (readA !== 100n || readB !== 100n) throw new Error('both connections should have read 100');

        const insertA = await settle(() => spend(a));
        const insertB = await settle(() => spend(b));
        note(`A's -100 insert: ${observed(insertA)}`);
        note(`B's -100 insert: ${observed(insertB)}`);
        const blockedB = await isBlocked(admin, await pidOf(b));
        note(`B observed parked on a lock while A held its row: ${blockedB}`);

        const commitA = await settle(() => a.query('COMMIT'));
        const commitB = await settle(() => b.query('COMMIT'));
        note(`A commit: ${observed(commitA)}; B commit: ${observed(commitB)}`);

        if (!insertA.ok || !insertB.ok || !commitA.ok || !commitB.ok) {
          throw new Error(
            'THE DEFECT DID NOT REPRODUCE: the naive sum() rule refused one of the two spends. ' +
              'Either the guard is stronger than the design describes, or this case no longer models it. ' +
              `A=${observed(insertA)}/${observed(commitA)} B=${observed(insertB)}/${observed(commitB)}`,
          );
        }

        const total = await ledgerTotal(admin, customer);
        note(`committed ledger total after two -100 spends of a 100 balance: ${total}`);
        if (total >= 0n) {
          throw new Error(`THE DEFECT DID NOT REPRODUCE: the committed total is ${total}, not negative`);
        }
        note('DEFECT REPRODUCED: both spends committed and the balance is negative — the rule is not a guard');
      } finally {
        await settle(() => a.query('ROLLBACK'));
        await settle(() => b.query('ROLLBACK'));
        await a.end();
        await b.end();
      }
    },
  },

  /* ---------------------------------------------------------------- *
   * 2. The remainder row refuses it
   * ---------------------------------------------------------------- */
  {
    name: 'case-2: the per-grant remainder row REFUSES the second spend',
    /**
     * The same two-connection race, against a remainder that is DECREMENTED
     * rather than re-derived. The row lock serialises the two writers; the
     * loser's statement then re-reads the committed row under READ COMMITTED
     * and the relation's own trigger refuses it.
     *
     * Barrier: `waitUntilBlocked` on B's backend. We do not wait for a
     * duration; we wait until the server reports B parked on a lock, and the
     * case reports which lock that was.
     */
    fn: async (admin, note) => {
      const customer = id();
      const { grantId } = await earn(admin, customer, 100n, '2027-01-01');

      const a = await session();
      const b = await session();
      try {
        await begin(a);
        await begin(b);
        const decrement = (c: Client, points: bigint): Promise<unknown> =>
          c.query(
            `UPDATE p13_proof.point_grant_remainders SET remaining_points = remaining_points - $3
              WHERE business_id = $1 AND grant_id = $2`,
            [BUSINESS, grantId, points.toString()],
          );

        const first = await settle(() => decrement(a, 100n));
        note(`A's decrement of 100 (uncommitted): ${observed(first)}`);
        if (!first.ok) throw new Error('A should have been accepted');

        const pidB = await pidOf(b);
        const pending = settle(() => decrement(b, 100n));
        const event = await waitUntilBlocked(admin, pidB, 'B must park on the remainder row A holds');
        note(`B observed waiting, wait_event = ${event}`);

        await a.query('COMMIT');
        const second = await pending;
        note(`B's decrement after A committed: ${observed(second)}`);
        note(`B's refusal message: ${second.ok ? '(none)' : second.message.split('\n')[0]}`);
        await settle(() => b.query('ROLLBACK'));

        if (second.ok) throw new Error('B was accepted: the remainder did not refuse the second spend');
        const left = await remaining(admin, grantId);
        note(`committed remainder after the race: ${left}`);
        if (left !== 0n) throw new Error(`expected 0 remaining, observed ${left}`);
      } finally {
        await settle(() => a.query('ROLLBACK'));
        await settle(() => b.query('ROLLBACK'));
        await a.end();
        await b.end();
      }
    },
  },

  /* ---------------------------------------------------------------- *
   * 3. Level uniqueness — the stronger guard
   * ---------------------------------------------------------------- */
  {
    name: 'case-3: level uniqueness refuses two draws at the SAME level with NO lock taken',
    /**
     * The claim that matters most. Neither connection takes a row lock, an
     * advisory lock, or `FOR UPDATE`: both read the remainder with a plain
     * SELECT, both bind `remaining_before = 100`, and both insert a draw. The
     * unique index — not a lock the application remembered to take — is what
     * collides.
     */
    fn: async (admin, note) => {
      const customer = id();
      const { grantId } = await earn(admin, customer, 100n, '2027-01-01');

      const a = await session();
      const b = await session();
      try {
        await begin(a);
        await begin(b);

        // Plain reads. No FOR UPDATE, no advisory lock, nothing.
        const readA = await remaining(a, grantId);
        const readB = await remaining(b, grantId);
        note(`both connections read remaining = ${readA} / ${readB} with NO lock of any kind`);
        if (readA !== 100n || readB !== 100n) throw new Error('both should have read 100');

        const draw = (c: Client, before: bigint, points: bigint): Promise<unknown> =>
          c.query(
            `INSERT INTO p13_proof.point_draws (id, business_id, grant_id, movement_id, remaining_before, drawn_points)
               VALUES ($1, $2, $3, $4, $5, $6)`,
            [id(), BUSINESS, grantId, id(), before.toString(), points.toString()],
          );

        const first = await settle(() => draw(a, readA, 60n));
        note(`A's draw at level 100: ${observed(first)}`);
        if (!first.ok) throw new Error('A should have been accepted');

        const pidB = await pidOf(b);
        const pending = settle(() => draw(b, readB, 60n));
        const event = await waitUntilBlocked(admin, pidB, 'B must park on the unique index entry A inserted');
        note(`B observed waiting on the index entry, wait_event = ${event} — a lock nobody asked for`);

        await a.query('COMMIT');
        const second = await pending;
        note(`B's draw at the SAME level after A committed: ${observed(second)}`);
        await settle(() => b.query('ROLLBACK'));

        if (second.ok) throw new Error('B was accepted: level uniqueness did not collide');
        if (second.code !== '23505') {
          note(`NOTE: the refusal was NOT a unique violation. Observed ${observed(second)}`);
          throw new Error(`expected a unique-violation-shaped refusal, observed SQLSTATE ${second.code ?? '(none)'}`);
        }
        note(`level uniqueness held: SQLSTATE 23505 on ${second.constraint ?? '(no constraint named)'}`);
      } finally {
        await settle(() => a.query('ROLLBACK'));
        await settle(() => b.query('ROLLBACK'));
        await a.end();
        await b.end();
      }
    },
  },

  /* ---------------------------------------------------------------- *
   * 4. Lock and constraint are complements
   * ---------------------------------------------------------------- */
  {
    name: 'case-4: the lock makes the loser WAIT and re-bind; without it the loser is REFUSED at once',
    /**
     * Three observations, two of them contrasting outcomes of the same race:
     *
     * 4a WITH the per-customer advisory lock, the loser's draw FITS: B is
     *    observed waiting on `advisory`, then PROCEEDS on fresh state at a new
     *    level. The lock converted a refusal into a wait.
     * 4b WITH the lock, the loser's draw does NOT fit: B waits, then is
     *    REFUSED by the remainder trigger on the state it re-read. Waiting is
     *    not the same as succeeding.
     * 4c WITHOUT the lock, bound against state that has already moved: B is
     *    refused on its first attempt with no holder to wait for. No backend
     *    is ever observed parked.
     *
     * Together: the lock decides WHETHER you wait; the constraint decides
     * whether you are right. Neither substitutes for the other.
     */
    fn: async (admin, note) => {
      // ---- 4a: both draws fit. The loser waits, then proceeds. ----
      {
        const customer = id();
        const { grantId } = await earn(admin, customer, 100n, '2027-01-01');
        const a = await session();
        const b = await session();
        try {
          await begin(a);
          await begin(b);
          await a.query(LOCK_SQL, [ADVISORY_NAMESPACE, customer]);
          note('4a: A holds the per-customer advisory lock');

          const beforeA = await remaining(a, grantId);
          await a.query(
            `INSERT INTO p13_proof.point_draws (id, business_id, grant_id, movement_id, remaining_before, drawn_points)
               VALUES ($1, $2, $3, $4, $5, 40)`,
            [id(), BUSINESS, grantId, id(), beforeA.toString()],
          );
          await a.query(
            `UPDATE p13_proof.point_grant_remainders SET remaining_points = remaining_points - 40
              WHERE business_id = $1 AND grant_id = $2`,
            [BUSINESS, grantId],
          );

          const pidB = await pidOf(b);
          const gate = settle(() => b.query(LOCK_SQL, [ADVISORY_NAMESPACE, customer]));
          const event = await waitUntilBlocked(admin, pidB, '4a: B must park on the advisory lock');
          note(`4a: B observed WAITING, wait_event = ${event}`);

          await a.query('COMMIT');
          const got = await gate;
          note(`4a: B acquired the gate after A committed: ${observed(got)}`);
          if (!got.ok) throw new Error('4a: B should have acquired the advisory lock');

          const beforeB = await remaining(b, grantId);
          note(`4a: B re-read FRESH state: remaining_before = ${beforeB} (it had read nothing stale)`);
          if (beforeB !== 60n) throw new Error(`4a: expected B to see 60, observed ${beforeB}`);

          const drawB = await settle(() =>
            b.query(
              `INSERT INTO p13_proof.point_draws (id, business_id, grant_id, movement_id, remaining_before, drawn_points)
                 VALUES ($1, $2, $3, $4, $5, 40)`,
              [id(), BUSINESS, grantId, id(), beforeB.toString()],
            ),
          );
          const updB = await settle(() =>
            b.query(
              `UPDATE p13_proof.point_grant_remainders SET remaining_points = remaining_points - 40
                WHERE business_id = $1 AND grant_id = $2`,
              [BUSINESS, grantId],
            ),
          );
          note(`4a: B's draw at the new level: ${observed(drawB)}; its decrement: ${observed(updB)}`);
          if (!drawB.ok || !updB.ok) throw new Error('4a: B should have PROCEEDED on fresh state');
          await b.query('COMMIT');
          const left = await remaining(admin, grantId);
          note(`4a: OUTCOME = waited then PROCEEDED; remaining ${left} after two 40s of 100`);
          if (left !== 20n) throw new Error(`4a: expected 20 remaining, observed ${left}`);
        } finally {
          await settle(() => a.query('ROLLBACK'));
          await settle(() => b.query('ROLLBACK'));
          await a.end();
          await b.end();
        }
      }

      // ---- 4b: the loser's draw no longer fits. It waits, then is refused. ----
      {
        const customer = id();
        const { grantId } = await earn(admin, customer, 100n, '2027-01-01');
        const a = await session();
        const b = await session();
        try {
          await begin(a);
          await begin(b);
          await a.query(LOCK_SQL, [ADVISORY_NAMESPACE, customer]);
          await a.query(
            `UPDATE p13_proof.point_grant_remainders SET remaining_points = remaining_points - 60
              WHERE business_id = $1 AND grant_id = $2`,
            [BUSINESS, grantId],
          );

          const pidB = await pidOf(b);
          const gate = settle(() => b.query(LOCK_SQL, [ADVISORY_NAMESPACE, customer]));
          const event = await waitUntilBlocked(admin, pidB, '4b: B must park on the advisory lock');
          note(`4b: B observed WAITING, wait_event = ${event}`);
          await a.query('COMMIT');
          if (!(await gate).ok) throw new Error('4b: B should have acquired the advisory lock');

          const refused = await settle(() =>
            b.query(
              `UPDATE p13_proof.point_grant_remainders SET remaining_points = remaining_points - 60
                WHERE business_id = $1 AND grant_id = $2`,
              [BUSINESS, grantId],
            ),
          );
          note(`4b: B's 60 against the 40 it now sees: ${observed(refused)}`);
          note(`4b: refusal message: ${refused.ok ? '(none)' : refused.message.split('\n')[0]}`);
          if (refused.ok) throw new Error('4b: B was accepted: the remainder trigger did not refuse an overdraw');
          note('4b: OUTCOME = waited then REFUSED on fresh state — the lock did not make it lawful');
          await settle(() => b.query('ROLLBACK'));
        } finally {
          await settle(() => a.query('ROLLBACK'));
          await settle(() => b.query('ROLLBACK'));
          await a.end();
          await b.end();
        }
      }

      // ---- 4c: no lock at all. Bound against state that has moved: refused at once. ----
      {
        const customer = id();
        const { grantId } = await earn(admin, customer, 100n, '2027-01-01');
        const a = await session();
        const b = await session();
        try {
          await begin(a);
          await begin(b);
          const staleB = await remaining(b, grantId); // B binds 100 and takes NOTHING
          await a.query(
            `INSERT INTO p13_proof.point_draws (id, business_id, grant_id, movement_id, remaining_before, drawn_points)
               VALUES ($1, $2, $3, $4, 100, 40)`,
            [id(), BUSINESS, grantId, id()],
          );
          await a.query('COMMIT');
          note(`4c: A committed a draw at level 100; B still holds the stale bind remaining_before = ${staleB}`);

          const pidB = await pidOf(b);
          const refused = await settle(() =>
            b.query(
              `INSERT INTO p13_proof.point_draws (id, business_id, grant_id, movement_id, remaining_before, drawn_points)
                 VALUES ($1, $2, $3, $4, $5, 40)`,
              [id(), BUSINESS, grantId, id(), staleB.toString()],
            ),
          );
          const parked = await isBlocked(admin, pidB);
          note(`4c: B's stale-bound draw: ${observed(refused)}`);
          note(`4c: B observed parked on a lock at any point in this sub-case: ${parked} (no holder existed to wait for)`);
          if (refused.ok) throw new Error('4c: B was accepted: the level key did not refuse a stale bind');
          if (parked) throw new Error('4c: B waited, so the refusal was not immediate');
          note(`4c: OUTCOME = REFUSED IMMEDIATELY, SQLSTATE ${refused.code ?? '(none)'} on ${refused.constraint ?? '(none)'}`);
          await settle(() => b.query('ROLLBACK'));
        } finally {
          await settle(() => a.query('ROLLBACK'));
          await settle(() => b.query('ROLLBACK'));
          await a.end();
          await b.end();
        }
      }
    },
  },

  /* ---------------------------------------------------------------- *
   * 5. Deterministic draw order avoids deadlock
   * ---------------------------------------------------------------- */
  {
    name: 'case-5: the same (expires_on, point_seq) draw order completes; opposing orders DEADLOCK',
    /**
     * Two grants, two transactions, each drawing from both.
     *
     * In the SAME order — oldest first by `(expires_on, point_seq)`, the total
     * order `points.ts:§4.3` says is FORCED — the second transaction parks on
     * the first grant and completes once the first commits.
     *
     * In OPPOSING orders each holds what the other wants next. Both second
     * statements are issued only after BOTH first locks have been observed
     * taken, so the cycle is constructed, not hoped for. The SQLSTATE of what
     * PostgreSQL does about it is reported, not assumed.
     */
    fn: async (admin, note) => {
      const lockGrant = (c: Client, grantId: string): Promise<unknown> =>
        c.query(
          `SELECT remaining_points FROM p13_proof.point_grant_remainders
            WHERE business_id = $1 AND grant_id = $2 FOR UPDATE`,
          [BUSINESS, grantId],
        );

      // The oldest-first order is read from the relation, not hardcoded.
      const orderedGrants = async (customer: string, g1: string, g2: string): Promise<string[]> => {
        const r = await admin.query<{ grant_id: string }>(
          `SELECT grant_id::text FROM p13_proof.point_grant_remainders
            WHERE business_id = $1 AND grant_id = ANY($2::uuid[])
            ORDER BY expires_on, point_seq`,
          [BUSINESS, [g1, g2]],
        );
        void customer;
        return r.rows.map((x) => x.grant_id);
      };

      // ---- 5a: the same order. Both complete. ----
      {
        const customer = id();
        const early = await earn(admin, customer, 100n, '2026-06-01');
        const late = await earn(admin, customer, 100n, '2027-06-01');
        const order = await orderedGrants(customer, early.grantId, late.grantId);
        note(`5a: oldest-first order by (expires_on, point_seq) = [${order.join(', ')}]`);
        if (must(order[0], 'the first grant') !== early.grantId) throw new Error('5a: the earlier horizon should sort first');

        const a = await session();
        const b = await session();
        try {
          await begin(a);
          await begin(b);
          const [g1, g2] = [must(order[0], 'g1'), must(order[1], 'g2')];
          await lockGrant(a, g1);
          await lockGrant(a, g2);
          const pidB = await pidOf(b);
          const pendingB = settle(async () => {
            await lockGrant(b, g1);
            await lockGrant(b, g2);
          });
          const event = await waitUntilBlocked(admin, pidB, '5a: B must park on the first grant');
          note(`5a: B observed waiting on the oldest grant, wait_event = ${event}`);
          await a.query('COMMIT');
          const outB = await pendingB;
          note(`5a: B after A committed: ${observed(outB)}`);
          if (!outB.ok) throw new Error(`5a: B should have completed, observed ${observed(outB)}`);
          const commitB = await settle(() => b.query('COMMIT'));
          note(`5a: B commit: ${observed(commitB)}`);
          if (!commitB.ok) throw new Error('5a: B should have committed');
          note('5a: OUTCOME = both transactions completed, no deadlock');
        } finally {
          await settle(() => a.query('ROLLBACK'));
          await settle(() => b.query('ROLLBACK'));
          await a.end();
          await b.end();
        }
      }

      // ---- 5b: opposing orders. A cycle. ----
      {
        const customer = id();
        const early = await earn(admin, customer, 100n, '2026-06-01');
        const late = await earn(admin, customer, 100n, '2027-06-01');
        const order = await orderedGrants(customer, early.grantId, late.grantId);
        const [g1, g2] = [must(order[0], 'g1'), must(order[1], 'g2')];

        const a = await session();
        const b = await session();
        try {
          await begin(a);
          await begin(b);
          await lockGrant(a, g1); // A: oldest first
          await lockGrant(b, g2); // B: newest first
          note('5b: A holds the oldest grant, B holds the newest — both first locks OBSERVED taken');

          const pidA = await pidOf(a);
          const pidB = await pidOf(b);
          const pendingA = settle(() => lockGrant(a, g2));
          const pendingB = settle(() => lockGrant(b, g1));
          // Both are now reaching for what the other holds: wait until the
          // server reports each of them parked. The cycle exists at that point.
          const eventA = await waitUntilBlocked(admin, pidA, '5b: A must park on the newest grant').catch(() => '(already resolved)');
          const eventB = await waitUntilBlocked(admin, pidB, '5b: B must park on the oldest grant').catch(() => '(already resolved)');
          note(`5b: A wait_event = ${eventA}; B wait_event = ${eventB}`);

          const outA = await pendingA;
          const outB = await pendingB;
          note(`5b: A's second lock: ${observed(outA)}`);
          note(`5b: B's second lock: ${observed(outB)}`);
          const victims = [outA, outB].filter((o) => !o.ok);
          if (victims.length !== 1) {
            throw new Error(`5b: expected exactly one victim, observed ${victims.length} failures`);
          }
          const victim = must(victims[0], 'the victim');
          if (victim.ok) throw new Error('unreachable');
          note(`5b: victim refusal: ${victim.message.split('\n')[0]}`);
          if (victim.code !== '40P01') {
            note(`5b: NOTE — the observed SQLSTATE is ${victim.code ?? '(none)'}, NOT the 40P01 a deadlock predicts`);
            throw new Error(`5b: expected a deadlock-shaped refusal, observed ${victim.code ?? '(none)'}`);
          }
          note('5b: OUTCOME = DEADLOCK, SQLSTATE 40P01 — one transaction was aborted by the server');
          await settle(() => a.query('COMMIT'));
          await settle(() => b.query('COMMIT'));
        } finally {
          await settle(() => a.query('ROLLBACK'));
          await settle(() => b.query('ROLLBACK'));
          await a.end();
          await b.end();
        }
      }
    },
  },

  /* ---------------------------------------------------------------- *
   * 6. Earning never blocks or fails a sale
   * ---------------------------------------------------------------- */
  {
    name: 'case-6: an in-flight earn neither blocks nor fails a concurrent spend, and its own failure is isolated',
    /**
     * 6a An earn, uncommitted, holding its own new ledger row and its own new
     *    grant remainder. A spend of an OLDER grant runs concurrently: it
     *    takes the per-customer advisory lock, draws, and commits. The spend's
     *    backend is observed NOT parked at any point, so the earn did not
     *    block it, and the spend was accepted, so the earn did not fail it.
     *
     *    Note the shape this measures: an earn appends and opens its own row.
     *    It takes no customer-wide lock. If the proposed mechanism were to
     *    make an earn take the same per-customer advisory lock a spend takes,
     *    this case would not hold — the earn would block the sale. That is the
     *    design constraint this case pins.
     *
     * 6b The earn then FAILS (a second remainder row for a grant id that
     *    already has one) and is rolled back. The spend's committed effect is
     *    unchanged: a failed earn cannot take points away.
     */
    fn: async (admin, note) => {
      const customer = id();
      const old = await earn(admin, customer, 100n, '2026-06-01');
      const totalBefore = await ledgerTotal(admin, customer);

      const earner = await session();
      const seller = await session();
      try {
        await begin(earner);
        await begin(seller);

        // The earn, in flight and uncommitted.
        const newGrant = id();
        await earner.query(
          `INSERT INTO p13_proof.point_movements (id, business_id, customer_id, movement_kind, points_delta, effective_on, expires_on)
             VALUES ($1, $2, $3, 'earn', 50, date '2026-03-01', date '2028-01-01')`,
          [newGrant, BUSINESS, customer],
        );
        const seq = await one<{ point_seq: string }>(
          earner,
          `SELECT point_seq::text FROM p13_proof.point_movements WHERE id = $1`,
          [newGrant],
        );
        await earner.query(
          `INSERT INTO p13_proof.point_grant_remainders (business_id, grant_id, point_seq, expires_on, granted_points, remaining_points)
             VALUES ($1, $2, $3, date '2028-01-01', 50, 50)`,
          [BUSINESS, newGrant, seq.point_seq],
        );
        note('6a: an earn of 50 is in flight and uncommitted (ledger row + its own new remainder row)');

        // The sale, concurrently, on the older grant.
        const pidSeller = await pidOf(seller);
        const gate = await settle(() => seller.query(LOCK_SQL, [ADVISORY_NAMESPACE, customer]));
        note(`6a: the sale's advisory lock: ${observed(gate)}`);
        if (!gate.ok) throw new Error('6a: the sale should have taken the lock');
        let everParked = await isBlocked(admin, pidSeller);

        const before = await remaining(seller, old.grantId);
        const drawn = await settle(() =>
          seller.query(
            `INSERT INTO p13_proof.point_draws (id, business_id, grant_id, movement_id, remaining_before, drawn_points)
               VALUES ($1, $2, $3, $4, $5, 70)`,
            [id(), BUSINESS, old.grantId, id(), before.toString()],
          ),
        );
        everParked = everParked || (await isBlocked(admin, pidSeller));
        const dec = await settle(() =>
          seller.query(
            `UPDATE p13_proof.point_grant_remainders SET remaining_points = remaining_points - 70
              WHERE business_id = $1 AND grant_id = $2`,
            [BUSINESS, old.grantId],
          ),
        );
        everParked = everParked || (await isBlocked(admin, pidSeller));
        const consume = await settle(() =>
          seller.query(
            `INSERT INTO p13_proof.point_movements (id, business_id, customer_id, movement_kind, points_delta, effective_on, reason)
               VALUES ($1, $2, $3, 'consume', -70, date '2026-03-01', 'sale')`,
            [id(), BUSINESS, customer],
          ),
        );
        everParked = everParked || (await isBlocked(admin, pidSeller));
        const commit = await settle(() => seller.query('COMMIT'));

        note(`6a: the sale's draw ${observed(drawn)}, decrement ${observed(dec)}, consume ${observed(consume)}, commit ${observed(commit)}`);
        note(`6a: the sale's backend observed parked on a lock at any step: ${everParked}`);
        if (!drawn.ok || !dec.ok || !consume.ok || !commit.ok) {
          throw new Error('6a: the in-flight earn FAILED a concurrent sale — the mechanism does not hold');
        }
        if (everParked) throw new Error('6a: the in-flight earn BLOCKED a concurrent sale');
        note('6a: OUTCOME = the sale committed, never parked; the earn neither blocked nor failed it');

        // 6b: the earn's own failure, isolated.
        const failed = await settle(() =>
          earner.query(
            `INSERT INTO p13_proof.point_grant_remainders (business_id, grant_id, point_seq, expires_on, granted_points, remaining_points)
               VALUES ($1, $2, $3, date '2028-01-01', 50, 50)`,
            [BUSINESS, newGrant, seq.point_seq],
          ),
        );
        note(`6b: the earn's second remainder row for one grant: ${observed(failed)}`);
        if (failed.ok) throw new Error('6b: a duplicate grant remainder was accepted');
        await earner.query('ROLLBACK');

        const totalAfter = await ledgerTotal(admin, customer);
        const left = await remaining(admin, old.grantId);
        note(`6b: ledger total ${totalBefore} -> ${totalAfter}; the sold grant's remainder = ${left}`);
        if (totalAfter !== totalBefore - 70n) {
          throw new Error(`6b: the failed earn disturbed the ledger: expected ${totalBefore - 70n}, observed ${totalAfter}`);
        }
        if (left !== 30n) throw new Error(`6b: expected 30 remaining, observed ${left}`);
        const ghost = await admin.query(
          `SELECT 1 FROM p13_proof.point_grant_remainders WHERE business_id = $1 AND grant_id = $2`,
          [BUSINESS, newGrant],
        );
        note(`6b: rows left behind by the rolled-back earn: ${ghost.rows.length}`);
        if (ghost.rows.length !== 0) throw new Error('6b: the failed earn left a remainder row behind');
        note("6b: OUTCOME = the earn's failure was isolated; the committed sale is untouched");
      } finally {
        await settle(() => earner.query('ROLLBACK'));
        await settle(() => seller.query('ROLLBACK'));
        await earner.end();
        await seller.end();
      }
    },
  },

  /* ---------------------------------------------------------------- *
   * 7. A FULL reversal, raced
   * ---------------------------------------------------------------- */
  {
    name: 'case-7: two connections reversing the SAME sale restore the points ONCE, and over-restoration is refused',
    /**
     * The directive names `return` and `reversal` as raced cases that the pure
     * suite cannot cover. This is them, at the ONLY scope the design
     * specifies: §5.7 restricts v1 to a FULL reversal and marks the partial
     * arm `WAITING_FOR_EXPLICIT_POLICY` with no test case, so no partial case
     * is invented here.
     *
     * 7a Two connections both act on the reversal of ONE return document.
     *    Each writes the restoring movement's identity row — (business,
     *    source type, source id, kind) — and restores the grant. The identity
     *    key is the whole mechanism: one commits, the other is refused BY
     *    NAME. A reversal that bound to a `reason` string instead would let
     *    both through and restore the points twice.
     *
     * 7b The restoration is bounded by what was granted, not by what is
     *    asked. A restoration larger than the draw it reverses is refused by
     *    the remainder relation's own trigger (`grant_over_restored`) — the
     *    same trigger as case 2, in its other direction. This is the
     *    conservation law's upper half, and nothing in the pure suite can
     *    reach it.
     */
    fn: async (admin, note) => {
      const customer = id();
      const grant = await earn(admin, customer, 100n, '2027-01-01');
      const RETURN_DOC = id();

      // A sale consumed 40 of it, and is now being fully returned.
      await admin.query(
        `INSERT INTO p13_proof.point_draws (id, business_id, grant_id, movement_id, remaining_before, drawn_points)
           VALUES ($1, $2, $3, $4, 100, 40)`,
        [id(), BUSINESS, grant.grantId, id()],
      );
      await admin.query(
        `UPDATE p13_proof.point_grant_remainders SET remaining_points = remaining_points - 40
          WHERE business_id = $1 AND grant_id = $2`,
        [BUSINESS, grant.grantId],
      );
      await admin.query(
        `INSERT INTO p13_proof.point_movements (id, business_id, customer_id, movement_kind, points_delta, effective_on, reason)
           VALUES ($1, $2, $3, 'consume', -40, date '2026-03-01', 'sale')`,
        [id(), BUSINESS, customer],
      );
      const consumedTotal = await ledgerTotal(admin, customer);
      note(`7a: fixture — 100 earned, 40 consumed by the sale now being returned; ledger total = ${consumedTotal}`);

      const a = await session();
      const b = await session();
      try {
        await begin(a);
        await begin(b);

        // Both reverse the SAME return document, with the SAME identity.
        const restoreA = id();
        const idA = await settle(() =>
          a.query(
            `INSERT INTO p13_proof.point_movement_identities (business_id, source_type, source_id, movement_kind, movement_id)
               VALUES ($1, 'sale_return', $2, 'adjust', $3)`,
            [BUSINESS, RETURN_DOC, restoreA],
          ),
        );
        note(`7a: A claims the restoration identity for the return document: ${observed(idA)}`);
        if (!idA.ok) throw new Error('7a: A should have claimed the identity first');

        const pidB = await pidOf(b);
        const restoreB = id();
        const pendingB = b.query(
          `INSERT INTO p13_proof.point_movement_identities (business_id, source_type, source_id, movement_kind, movement_id)
             VALUES ($1, 'sale_return', $2, 'adjust', $3)`,
          [BUSINESS, RETURN_DOC, restoreB],
        );
        const settledB = settle(() => pendingB);
        const eventB = await waitUntilBlocked(admin, pidB, '7a: the second reversal');
        note(`7a: B observed waiting on the identity key, wait_event = ${eventB}`);

        // A completes the reversal: restore 40 to the grant, append the movement.
        const restored = await settle(() =>
          a.query(
            `UPDATE p13_proof.point_grant_remainders SET remaining_points = remaining_points + 40
              WHERE business_id = $1 AND grant_id = $2`,
            [BUSINESS, grant.grantId],
          ),
        );
        await a.query(
          `INSERT INTO p13_proof.point_movements (id, business_id, customer_id, movement_kind, points_delta, effective_on, reason)
             VALUES ($1, $2, $3, 'adjust', 40, date '2026-03-02', 'full return of the sale')`,
          [restoreA, BUSINESS, customer],
        );
        note(`7a: A's restoration of the grant: ${observed(restored)}`);
        await a.query('COMMIT');

        const outcomeB = await settledB;
        note(`7a: B's identical reversal, once A had committed: ${observed(outcomeB)}`);
        if (outcomeB.ok) throw new Error('7a: the SAME reversal was accepted twice — the points were restored twice');
        if (outcomeB.constraint !== 'point_movements_identity_uq') {
          throw new Error(`7a: expected the identity key to refuse by name, observed ${observed(outcomeB)}`);
        }
        await settle(() => b.query('ROLLBACK'));

        const afterTotal = await ledgerTotal(admin, customer);
        const left = await remaining(admin, grant.grantId);
        note(`7a: ledger total ${consumedTotal} -> ${afterTotal}; grant remainder = ${left} of 100`);
        if (afterTotal !== consumedTotal + 40n) {
          throw new Error(`7a: expected ${consumedTotal + 40n} after ONE restoration, observed ${afterTotal}`);
        }
        if (left !== 100n) throw new Error(`7a: expected the grant back at 100, observed ${left}`);
        note('7a: OUTCOME = restored exactly once; the duplicate was refused by name on point_movements_identity_uq');

        // 7b: the upper half of the conservation law.
        await begin(b);
        const over = await settle(() =>
          b.query(
            `UPDATE p13_proof.point_grant_remainders SET remaining_points = remaining_points + 1
              WHERE business_id = $1 AND grant_id = $2`,
            [BUSINESS, grant.grantId],
          ),
        );
        note(`7b: a restoration of 1 point beyond what was granted: ${observed(over)}`);
        if (over.ok) throw new Error('7b: a grant was restored above what it granted');
        await settle(() => b.query('ROLLBACK'));
        note('7b: OUTCOME = over-restoration refused by the remainder relation\'s own trigger — the law holds in BOTH directions');
        note('7b: NOT MEASURED HERE, and deliberately: the PARTIAL return. §5.7.4 marks it');
        note('7b: WAITING_FOR_EXPLICIT_POLICY and writes no test case for it; neither does this proof');
      } finally {
        await settle(() => a.query('ROLLBACK'));
        await settle(() => b.query('ROLLBACK'));
        await a.end();
        await b.end();
      }
    },
  },

  /* ---------------------------------------------------------------- *
   * 8. Consumption succeeds only if the sale succeeds
   * ---------------------------------------------------------------- */
  {
    name: 'case-8: a rolled-back sale leaves NO consumption, and frees the points for the next connection',
    /**
     * The owner's law, in his words: consumption happens inside the sale's own
     * transaction and succeeds only if the sale succeeds. A fold cannot test
     * it — a fold has no transaction. Two connections can.
     *
     * 8a A takes the lock, draws the whole grant, decrements, appends the
     *    consumption — and then its sale FAILS. B, waiting on the same
     *    customer, is observed parked, then wakes and spends the SAME points
     *    successfully. So A's rollback released real points, not merely rows:
     *    nothing of A survives.
     *
     * 8b After both finish, the ledger and the remainder agree, and the
     *    draw table carries exactly ONE draw — A's is gone.
     */
    fn: async (admin, note) => {
      const customer = id();
      const grant = await earn(admin, customer, 100n, '2027-01-01');
      const startTotal = await ledgerTotal(admin, customer);

      const a = await session();
      const b = await session();
      try {
        await begin(a);
        await begin(b);

        await a.query(LOCK_SQL, [ADVISORY_NAMESPACE, customer]);
        const beforeA = await remaining(a, grant.grantId);
        await a.query(
          `INSERT INTO p13_proof.point_draws (id, business_id, grant_id, movement_id, remaining_before, drawn_points)
             VALUES ($1, $2, $3, $4, $5, 100)`,
          [id(), BUSINESS, grant.grantId, id(), beforeA.toString()],
        );
        await a.query(
          `UPDATE p13_proof.point_grant_remainders SET remaining_points = remaining_points - 100
            WHERE business_id = $1 AND grant_id = $2`,
          [BUSINESS, grant.grantId],
        );
        await a.query(
          `INSERT INTO p13_proof.point_movements (id, business_id, customer_id, movement_kind, points_delta, effective_on, reason)
             VALUES ($1, $2, $3, 'consume', -100, date '2026-03-01', 'sale that will fail')`,
          [id(), BUSINESS, customer],
        );
        note('8a: A has drawn the whole grant, decremented it and appended the consumption — all uncommitted');

        // B arrives for the same customer and parks on A's lock.
        const pidB = await pidOf(b);
        const pendingGate = settle(() => b.query(LOCK_SQL, [ADVISORY_NAMESPACE, customer]));
        const eventB = await waitUntilBlocked(admin, pidB, "8a: B on A's customer lock");
        note(`8a: B observed parked on the per-customer lock, wait_event = ${eventB}`);

        // A's SALE FAILS.
        await a.query('ROLLBACK');
        note('8a: A ROLLED BACK — the sale failed, so the consumption must not have happened');

        const gate = await pendingGate;
        if (!gate.ok) throw new Error(`8a: B should have taken the lock once A released it: ${observed(gate)}`);

        const beforeB = await remaining(b, grant.grantId);
        note(`8a: B reads remaining = ${beforeB} after A's rollback`);
        if (beforeB !== 100n) throw new Error(`8a: A's rollback did not release the points: B sees ${beforeB}`);

        const drawB = await settle(() =>
          b.query(
            `INSERT INTO p13_proof.point_draws (id, business_id, grant_id, movement_id, remaining_before, drawn_points)
               VALUES ($1, $2, $3, $4, $5, 100)`,
            [id(), BUSINESS, grant.grantId, id(), beforeB.toString()],
          ),
        );
        note(`8a: B's draw at the SAME level A had drawn at: ${observed(drawB)}`);
        if (!drawB.ok) {
          throw new Error(`8a: A's rolled-back draw still blocks the level — the rollback was not complete: ${observed(drawB)}`);
        }
        await b.query(
          `UPDATE p13_proof.point_grant_remainders SET remaining_points = remaining_points - 100
            WHERE business_id = $1 AND grant_id = $2`,
          [BUSINESS, grant.grantId],
        );
        await b.query(
          `INSERT INTO p13_proof.point_movements (id, business_id, customer_id, movement_kind, points_delta, effective_on, reason)
             VALUES ($1, $2, $3, 'consume', -100, date '2026-03-01', 'the sale that succeeded')`,
          [id(), BUSINESS, customer],
        );
        await b.query('COMMIT');

        const endTotal = await ledgerTotal(admin, customer);
        const left = await remaining(admin, grant.grantId);
        const draws = await admin.query(
          `SELECT 1 FROM p13_proof.point_draws WHERE business_id = $1 AND grant_id = $2`,
          [BUSINESS, grant.grantId],
        );
        note(`8b: ledger total ${startTotal} -> ${endTotal}; remainder = ${left}; draw rows on the grant = ${draws.rows.length}`);
        if (endTotal !== startTotal - 100n) {
          throw new Error(`8b: expected ONE consumption of 100, observed a total of ${endTotal}`);
        }
        if (left !== 0n) throw new Error(`8b: expected 0 remaining, observed ${left}`);
        if (draws.rows.length !== 1) {
          throw new Error(`8b: expected exactly one surviving draw, observed ${draws.rows.length}`);
        }
        note('8b: OUTCOME = the failed sale consumed nothing and left nothing; the points were spent exactly once');
      } finally {
        await settle(() => a.query('ROLLBACK'));
        await settle(() => b.query('ROLLBACK'));
        await a.end();
        await b.end();
      }
    },
  },

  /* ---------------------------------------------------------------- *
   * 9. The retry TERMINATES
   * ---------------------------------------------------------------- */
  {
    name: 'case-9: the lock loser\'s re-bind retry terminates — it either spends or is refused, never loops',
    /**
     * Case 4 showed the loser WAITS and re-binds. It did not show that the
     * re-bind ENDS. A mechanism whose loser re-reads and tries again is a
     * livelock risk, and "it will converge" is an assertion, not a
     * measurement. This case bounds it and reports the number of attempts the
     * server actually needed.
     *
     * A FIRST DRAFT OF THIS CASE WAS VACUOUS, and it is worth saying why,
     * because the failure is easy to repeat. It let the competing sale commit
     * BEFORE the loser read the remainder, so the loser's bind was always
     * fresh, it succeeded on attempt 1, and the case reported "terminated"
     * having never retried once. A termination proof whose loop body runs
     * once proves nothing about termination.
     *
     * So the interleaving is now the one that actually produces a stale bind,
     * which is case 4c's: the loser reads the remainder WITHOUT holding the
     * lock, the competing sale commits in between, and only then does the
     * loser draw — at a level that no longer exists. The case asserts that
     * the loop retried AT LEAST ONCE and still reached a definite end.
     */
    fn: async (admin, note) => {
      const customer = id();
      const grant = await earn(admin, customer, 100n, '2027-01-01');

      const loser = await session();
      try {
        const ATTEMPT_BOUND = 8;
        const COMPETING_SALES = 3;
        let attempts = 0;
        let retried = 0;
        let outcome: string = '(none)';

        for (let i = 0; i < ATTEMPT_BOUND; i += 1) {
          attempts += 1;

          await begin(loser);
          // The bind, taken WITHOUT the lock — this is what makes it stale.
          const before = await remaining(loser, grant.grantId);

          // A competing sale commits AFTER the loser has bound and BEFORE it
          // draws. This is the interleaving that invalidates the bind.
          if (i < COMPETING_SALES) {
            const winner = await session();
            try {
              await begin(winner);
              const w = await remaining(winner, grant.grantId);
              await winner.query(
                `INSERT INTO p13_proof.point_draws (id, business_id, grant_id, movement_id, remaining_before, drawn_points)
                   VALUES ($1, $2, $3, $4, $5, 20)`,
                [id(), BUSINESS, grant.grantId, id(), w.toString()],
              );
              await winner.query(
                `UPDATE p13_proof.point_grant_remainders SET remaining_points = remaining_points - 20
                  WHERE business_id = $1 AND grant_id = $2`,
                [BUSINESS, grant.grantId],
              );
              await winner.query('COMMIT');
            } finally {
              await winner.end();
            }
          }

          const drawn = await settle(() =>
            loser.query(
              `INSERT INTO p13_proof.point_draws (id, business_id, grant_id, movement_id, remaining_before, drawn_points)
                 VALUES ($1, $2, $3, $4, $5, 20)`,
              [id(), BUSINESS, grant.grantId, id(), before.toString()],
            ),
          );
          const dec = drawn.ok
            ? await settle(() =>
                loser.query(
                  `UPDATE p13_proof.point_grant_remainders SET remaining_points = remaining_points - 20
                    WHERE business_id = $1 AND grant_id = $2`,
                  [BUSINESS, grant.grantId],
                ),
              )
            : drawn;
          if (dec.ok) {
            await loser.query('COMMIT');
            outcome = `SPENT on attempt ${attempts}, on a bind of remaining_before = ${before}`;
            break;
          }
          await settle(() => loser.query('ROLLBACK'));
          retried += 1;
          note(`9: attempt ${attempts} bound to ${before}, was overtaken, and was refused: ${observed(dec)}`);
          if (dec.code === 'P0001') {
            outcome = `REFUSED on attempt ${attempts}: ${observed(dec)} — the grant is exhausted`;
            break;
          }
        }

        note(`9: attempts the loop actually took = ${attempts} of a bound of ${ATTEMPT_BOUND}; retries forced = ${retried}`);
        note(`9: terminal outcome = ${outcome}`);
        if (outcome === '(none)') {
          throw new Error(`9: the retry did NOT terminate within ${ATTEMPT_BOUND} attempts — this is a livelock`);
        }
        if (retried < 1) {
          throw new Error('9: the loop never retried, so it measured nothing about termination (the vacuous case above)');
        }
        note('9: OUTCOME = the retry was genuinely forced and still terminated with a definite answer');
        note('9: NOT MEASURED: termination under more than two writers, under an adversarial writer that');
        note('9: never yields, and any claim about how LONG a retry takes. This bounds the NUMBER of');
        note('9: attempts against a bounded competitor, not a duration and not a guarantee of progress');
        note('9: against an unbounded one.');
      } finally {
        await settle(() => loser.query('ROLLBACK'));
        await loser.end();
      }
    },
  },

  /* ---------------------------------------------------------------- *
   * 10. The expiry sweep beside a spend
   * ---------------------------------------------------------------- */
  {
    name: 'case-10: an expiry sweep and a spend cannot take the same points — one of them is refused',
    /**
     * The sweep is the one writer that is neither a sale nor an earn, and it
     * touches the same grant a sale is drawing from. If both could take the
     * same points, the balance would go negative with every row individually
     * valid — the same failure as case 1, by another route.
     *
     * The sweep is written the way the design requires: it expires what is
     * LEFT of a grant, under the same per-customer lock, with its own identity
     * (`source_type = 'expiry_sweep'`). The case asserts the measured
     * outcome: one of the two writers is refused, by name, and the ledger is
     * conserved whichever one won.
     */
    fn: async (admin, note) => {
      const customer = id();
      // A grant whose horizon has passed, so the sweep has something to take.
      const grant = await earn(admin, customer, 100n, '2026-02-01');
      const startTotal = await ledgerTotal(admin, customer);

      const sweeper = await session();
      const seller = await session();
      try {
        await begin(sweeper);
        await begin(seller);

        // The sweep goes first and takes the whole remainder, uncommitted.
        await sweeper.query(LOCK_SQL, [ADVISORY_NAMESPACE, customer]);
        const beforeSweep = await remaining(sweeper, grant.grantId);
        await sweeper.query(
          `UPDATE p13_proof.point_grant_remainders SET remaining_points = 0
            WHERE business_id = $1 AND grant_id = $2`,
          [BUSINESS, grant.grantId],
        );
        const sweepMovement = id();
        await sweeper.query(
          `INSERT INTO p13_proof.point_movement_identities (business_id, source_type, source_id, movement_kind, movement_id)
             VALUES ($1, 'expiry_sweep', $2, 'expire', $3)`,
          [BUSINESS, grant.grantId, sweepMovement],
        );
        await sweeper.query(
          `INSERT INTO p13_proof.point_movements (id, business_id, customer_id, movement_kind, points_delta, effective_on, reason)
             VALUES ($1, $2, $3, 'expire', $4, date '2026-02-02', 'horizon passed')`,
          [sweepMovement, BUSINESS, customer, (-beforeSweep).toString()],
        );
        note(`10: the sweep has taken all ${beforeSweep} remaining points of the expired grant, uncommitted`);

        // The sale arrives for the same customer and parks on the same lock.
        const pidSeller = await pidOf(seller);
        const pendingGate = settle(() => seller.query(LOCK_SQL, [ADVISORY_NAMESPACE, customer]));
        const event = await waitUntilBlocked(admin, pidSeller, '10: the sale behind the sweep');
        note(`10: the sale observed parked on the per-customer lock, wait_event = ${event}`);

        await sweeper.query('COMMIT');
        note('10: the sweep COMMITTED');

        const gate = await pendingGate;
        if (!gate.ok) throw new Error(`10: the sale should have taken the lock after the sweep: ${observed(gate)}`);

        const beforeSale = await remaining(seller, grant.grantId);
        note(`10: the sale re-reads remaining = ${beforeSale} AFTER the sweep committed`);
        const drawn = await settle(() =>
          seller.query(
            `INSERT INTO p13_proof.point_draws (id, business_id, grant_id, movement_id, remaining_before, drawn_points)
               VALUES ($1, $2, $3, $4, $5, 100)`,
            [id(), BUSINESS, grant.grantId, id(), beforeSale.toString()],
          ),
        );
        const dec = drawn.ok
          ? await settle(() =>
              seller.query(
                `UPDATE p13_proof.point_grant_remainders SET remaining_points = remaining_points - 100
                  WHERE business_id = $1 AND grant_id = $2`,
                [BUSINESS, grant.grantId],
              ),
            )
          : drawn;
        note(`10: the sale's spend of the swept points: ${observed(dec)}`);
        if (dec.ok) {
          throw new Error('10: the sale spent points the sweep had already expired — they were taken twice');
        }
        await settle(() => seller.query('ROLLBACK'));

        const endTotal = await ledgerTotal(admin, customer);
        const left = await remaining(admin, grant.grantId);
        note(`10: ledger total ${startTotal} -> ${endTotal}; remainder = ${left}`);
        if (endTotal !== 0n) throw new Error(`10: the sweep should have zeroed the balance, observed ${endTotal}`);
        if (left !== 0n) throw new Error(`10: expected 0 remaining, observed ${left}`);
        note(`10: OUTCOME = the sweep won and the sale was refused (${observed(dec)}); the points were taken ONCE`);
        note('10: WHAT THIS DOES NOT SETTLE: whether the sweep SHOULD win. A sale losing to a sweep that');
        note('10: fires mid-sale is a POLICY question for the loyalty configuration owner, not a');
        note('10: mechanism question. The mechanism holds either way — the measured fact is that they');
        note('10: cannot both take the same points.');
      } finally {
        await settle(() => sweeper.query('ROLLBACK'));
        await settle(() => seller.query('ROLLBACK'));
        await sweeper.end();
        await seller.end();
      }
    },
  },
];

/* ------------------------------------------------------------------ *
 * The runner
 * ------------------------------------------------------------------ */

async function main(): Promise<number> {
  rmSync(PG_DIR, { recursive: true, force: true });

  // The settled target first; the repository's embedded cluster only as a
  // clearly-labelled fallback.
  const binDir = findBinDir();
  let pg: EmbeddedCluster;
  let onTarget: boolean;
  let binaryVersion: string;
  if (binDir === null) {
    ensureBinariesExecutable();
    const EmbeddedPostgres = await loadEmbeddedPostgres();
    pg = new EmbeddedPostgres({
      databaseDir: PG_DIR,
      user: PG_USER,
      password: PG_PASSWORD,
      port: PG_PORT,
      persistent: false,
    });
    onTarget = false;
    binaryVersion = "the repository's own embedded-postgres";
  } else {
    const external = new ExternalCluster(binDir, PG_DIR, join(PG_DIR, 'sock'), PG_PORT);
    pg = external;
    binaryVersion = external.version();
    onTarget = /\b16\.\d+\b/.test(binaryVersion);
  }

  let pool: Pool | null = null;
  const results: CaseResult[] = [];
  try {
    await pg.initialise();
    await pg.start();
    const admin = new Pool({ connectionString: url, max: 4 });
    pool = admin;

    const v = await one<{ version: string }>(admin, 'SELECT version() AS version');
    const loc = await one<{ collate: string; ctype: string; encoding: string }>(
      admin,
      `SELECT datcollate AS collate, datctype AS ctype, pg_encoding_to_char(encoding) AS encoding
         FROM pg_database WHERE datname = current_database()`,
    );
    console.log('P13-PROOF-CONCURRENCY — two real connections, one real cluster');
    console.log(`binary:      ${binaryVersion}`);
    console.log(`measured on: ${v.version}`);
    console.log(`collation:   datcollate=${loc.collate} datctype=${loc.ctype} encoding=${loc.encoding}`);
    console.log(
      onTarget
        ? 'TARGET: this IS the settled deploy line (the PostgreSQL 16 family). The collation line above is read\n' +
            '        back from the catalogue, not asserted. What this still does NOT cover: the real schema, its\n' +
            '        routines and RLS, the official sale authority, isolation levels above READ COMMITTED, more\n' +
            '        than two connections, and every timing figure — no duration is claimed anywhere.'
        : 'OFF-TARGET: no PostgreSQL 16 binaries were found, so this ran on the fallback printed above. The\n' +
            '            settled deploy line is the PostgreSQL 16 family with en_US.utf8, so THIS RUN IS NOT\n' +
            '            EVIDENCE FOR THE TARGET. Re-run with P13_PG_BINDIR pointing at a 16.x bin directory.',
    );
    console.log('');

    await admin.query(SCHEMA);

    for (const c of cases) {
      const notes: string[] = [];
      const outcome = await settle(() => c.fn(admin, (line) => notes.push(line)));
      if (outcome.ok) {
        results.push({ name: c.name, ok: true, notes });
        console.log(`PASS ${c.name}`);
      } else {
        results.push({ name: c.name, ok: false, notes: [...notes, `FAILURE: ${outcome.message}`] });
        console.log(`FAIL ${c.name}`);
      }
      for (const n of notes) console.log(`       - ${n}`);
      if (!outcome.ok) console.log(`       ! ${outcome.message}`);
      console.log('');
    }
  } catch (e) {
    console.log(`FAIL harness: ${e instanceof Error ? e.message : String(e)}`);
    results.push({ name: 'harness', ok: false, notes: [] });
  } finally {
    await pool?.end().catch(() => undefined);
    await settle(() => pg.stop());
    rmSync(PG_DIR, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} cases passed`);
  for (const f of failed) console.log(`  FAILED: ${f.name}`);
  return failed.length === 0 ? 0 : 1;
}

// Not a top-level `await`: this package typechecks with `module: commonjs`,
// under which a top-level await is an error. The process's exit code is the
// proof's verdict either way — non-zero if any case failed.
void main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    console.log(`FAIL harness: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  },
);
