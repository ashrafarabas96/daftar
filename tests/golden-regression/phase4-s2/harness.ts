/**
 * P4-S2 — THE GOLDEN AND CONCURRENCY HARNESS
 * (docs/PHASE_4_S2_GOLDEN_AND_CONCURRENCY_DESIGN.md;
 *  docs/PHASE_4_ARCHITECTURE_LOCK.md P4-AL-16, P4-AL-25, P4-AL-29, P4-AL-32,
 *  P4-AL-41, P4-AL-42, P4-AL-65, P4-AL-67, P4-AL-88, §15).
 *
 * Four things live here, and nothing else:
 *
 *   1. SUBJECT DISCOVERY AND THE CANARY. Every claim this slice makes has a
 *      subject — a relation, a routine, a registry row, a route — and a claim
 *      with no subject must never pass. `saleSubject()` reads what EXISTS from
 *      the catalogue and from the Phase 4 migration range, and
 *      `requireSubject()` throws, naming what is missing, rather than letting
 *      a suite be vacuously green. The relation inventory is DISCOVERED from
 *      the frozen Phase 4 prefix (`phase4Sql` + `readTables`), never typed out,
 *      and no equality is ever asserted over a set a later slice populates
 *      (`[[daftar-a-closure-rule-is-not-an-invariant]]`, P4-AL-88).
 *
 *   2. FORCED INTERLEAVING, WITH NO SLEEP ANYWHERE IN THE VERDICT.
 *      `[[daftar-a-test-whose-verdict-is-the-machines-speed]]`. A third
 *      connection PARKS the one row lock the stock writer must take
 *      (`stock_levels` FOR UPDATE, `0060:299-306`), the competing attempts are
 *      enqueued behind it ONE AT A TIME, and each one's arrival in the queue is
 *      OBSERVED through `pg_blocking_pids` before the next is launched. The
 *      queue order is therefore chosen by this file, not by the host's speed.
 *      The polls below are bounded, and the expiry of a bound is always a
 *      FAILURE and never a pass: an attempt that never parked did not contend,
 *      and a suite that let it through would be reporting the machine's speed.
 *
 *   3. A DEADLOCK IS A LOCK-ORDER FINDING. `classify()` maps `40P01` to its
 *      own outcome kind, and `expectNoDeadlock()` fails the case with the
 *      lock-order sentence. Nothing here retries, nothing here touches
 *      `deadlock_timeout`, and no caller may treat `40P01` as a business
 *      outcome — `[[daftar-lock-order-not-retry]]`, P4-AL-41.
 *
 *   4. THE CENSUS AND THE OFFICIAL RECONCILIATION FORMULA. The "nothing
 *      survives" census is DISCOVERED from the catalogue — every table that
 *      carries `business_id`, plus every table that carries `jti` — so a
 *      relation a later slice adds is inside the census the day it is created
 *      and cannot quietly survive a rolled-back command. The inventory
 *      identity is `GL Inventory (1200) = Σ stock_movements.value_delta_base_minor`
 *      and nothing else: `quantity × average_cost` is never the reconciliation
 *      truth (P4-AL-25, `TL-P4-S0-01`, `[[daftar-a-rounded-quotient-is-never-an-input]]`).
 *
 * This module runs no hook, opens no application, and seeds nothing. It is
 * imported by the P4-S2 goldens, by the P4-S2 integration suites and by the
 * red-proof suite, so that the mechanism each of them relies on exists once.
 */
import { join } from 'node:path';
import type { Client, Pool } from 'pg';
import { DatabaseError } from 'pg';
import { expect } from 'vitest';
import { phase4Sql, readTables } from '../../../scripts/phase4-s1-gate';
import { ownerPool } from '../../helpers/test-app';
import { SALE_COMMIT_ROUTINE } from './sale-path';

export const REPO = join(__dirname, '..', '..', '..');

/** Anything that can run a query: the owner pool, a role pool, or a single client. */
export type Queryable = Pick<Pool, 'query'>;

export function must<T>(value: T | undefined | null, what = 'value'): T {
  if (value === undefined || value === null) throw new Error(`${what} is absent`);
  return value;
}

// ── 1. subject discovery and the canary ───────────────────────────────────

/**
 * The relations the Phase 4 migration range creates, DISCOVERED from the SQL
 * of that range rather than listed. The list grows by itself when the
 * migration owner adds a relation, which is the only reason a permanent suite
 * may hold a relation inventory at all (P4-AL-88).
 */
export function phase4RelationsOnDisk(root: string = REPO): readonly string[] {
  const { tables, unreadable } = readTables(phase4Sql(root));
  if (unreadable.length > 0) throw new Error(`the Phase 4 migration SQL holds DDL this harness cannot read: ${unreadable.join('; ')}`);
  return [...new Set(tables.map((t) => t.name))].sort();
}

/** The relations that exist in the live catalogue right now, out of a candidate set. */
export async function existingRelations(q: Queryable, candidates: readonly string[]): Promise<readonly string[]> {
  if (candidates.length === 0) return [];
  const r = await q.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY ($1) ORDER BY 1`,
    [[...candidates]],
  );
  return r.rows.map((x) => x.relname);
}

/** Does a routine of this name exist, whatever its argument list? */
export async function routineExists(q: Queryable, name: string): Promise<boolean> {
  const r = await q.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1`,
    [name],
  );
  return must(r.rows[0]).n > 0;
}

/** Is `value` present in `column` of registry `relation`? False when the relation itself is absent. */
export async function registryHas(q: Queryable, relation: string, column: string, value: string): Promise<boolean> {
  if ((await existingRelations(q, [relation])).length === 0) return false;
  const r = await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${quoteIdent(relation)} WHERE ${quoteIdent(column)} = $1`, [value]);
  return must(r.rows[0]).n > 0;
}

/**
 * What the sale commit primitive consists of, and which parts of it exist.
 *
 * Every name below is named by the execution plan's S2 row and by P4-AL-29b,
 * which is why this function may name them at all: they are the slice's
 * declared deliverables, not a guess at a schema. `missing` is the canary's
 * subject: while it is non-empty, every claim about a sale has no subject, and
 * `requireSubject` makes that a RED rather than a vacuous green.
 */
export interface SaleSubject {
  /** The relations of the S2 scope that exist. */
  readonly relations: readonly string[];
  /** The commit routine, if one of the declared names exists. */
  readonly routine: string | null;
  readonly stockSourceTypeSale: boolean;
  readonly accountingSourceTypeSale: boolean;
  readonly accountingSourceTypeInvoice: boolean;
  readonly saleOperationKinds: readonly string[];
  /** Everything the slice declares and the tree does not have yet. */
  readonly missing: readonly string[];
}

/** The relations P4-S2 declares (execution plan §6 S2 row; P4-AL-29b's object table). */
export const S2_DECLARED_RELATIONS: readonly string[] = ['sales', 'sale_items', 'stock_source_bridge_sale'];

/**
 * The name of the sale commit routine, read from the SINGLE SOURCE OF TRUTH:
 * `SALE_COMMIT_ROUTINE` in `sale-path.ts`, which the slice that writes the
 * route exports and keeps correct.
 *
 * This was a four-candidate GUESS (`sale_commit`, `sales_commit`,
 * `sale_confirm`, `selling_commit_sale`), written when no routine existed. A
 * guess is the wrong shape even when one of its candidates is right: the
 * canary's job is to say "the subject is absent", and a guessing canary says
 * that both when the routine is missing AND when it was renamed to something
 * outside the list — so a rename would have left every P4-S2 suite
 * permanently red for a reason that is not a defect, and the fix would have
 * been to widen the guess rather than to follow the name. One constant, owned
 * by the route's own slice, decides it.
 *
 * `sale-path.ts` imports only a TYPE from this module, so this is not a
 * runtime cycle.
 */
export { SALE_COMMIT_ROUTINE } from './sale-path';

export async function saleSubject(q: Queryable = ownerPool()): Promise<SaleSubject> {
  const relations = await existingRelations(q, S2_DECLARED_RELATIONS);
  const routine = (await routineExists(q, SALE_COMMIT_ROUTINE)) ? SALE_COMMIT_ROUTINE : null;
  const stockSourceTypeSale = await registryHas(q, 'stock_source_types', 'source_type', 'sale');
  const accountingSourceTypeSale = await registryHas(q, 'accounting_source_types', 'source_type', 'sale');
  const accountingSourceTypeInvoice = await registryHas(q, 'accounting_source_types', 'source_type', 'invoice');
  const kinds =
    (await existingRelations(q, ['inventory_operation_kinds'])).length === 0
      ? []
      : (await q.query<{ op_code: string }>(`SELECT op_code FROM inventory_operation_kinds WHERE op_code LIKE 'sale.%' ORDER BY 1`)).rows.map((r) => r.op_code);

  const missing: string[] = [];
  for (const rel of S2_DECLARED_RELATIONS) if (!relations.includes(rel)) missing.push(`relation ${rel}`);
  if (routine === null) missing.push(`the sale commit routine ${SALE_COMMIT_ROUTINE}`);
  if (!stockSourceTypeSale) missing.push(`stock_source_types row 'sale'`);
  if (!accountingSourceTypeSale) missing.push(`accounting_source_types row 'sale'`);
  if (!accountingSourceTypeInvoice) missing.push(`accounting_source_types row 'invoice'`);
  if (kinds.length === 0) missing.push(`at least one sale.* operation kind`);
  return { relations, routine, stockSourceTypeSale, accountingSourceTypeSale, accountingSourceTypeInvoice, saleOperationKinds: kinds, missing };
}

/**
 * THE CANARY. A claim with no subject must never pass, so this throws — it
 * does not skip, it does not warn and it does not return a flag a caller could
 * ignore. `.skip`, `.todo` and `.only` are refused across Phase 4, and a
 * conditional pass would be a `.skip` written in a way the gate's SKIP regex
 * cannot see.
 */
export function requireSubject(missing: readonly string[], claim: string): void {
  if (missing.length === 0) return;
  throw new Error(
    `NO SUBJECT — "${claim}" cannot be true or false yet because the following do not exist: ${missing.join('; ')}. ` +
      `This is the canary of docs/PHASE_4_S2_GOLDEN_AND_CONCURRENCY_DESIGN.md: it is RED until the P4-S2 implementation lands, ` +
      `because a claim with no subject that reported green would be the vacuity defect this suite exists to refuse.`,
  );
}

/** Non-vacuity for a law asserted over rows: a law quantified over nothing proved nothing. */
export function expectSomeSubject<T>(rows: readonly T[], claim: string): readonly T[] {
  expect(rows.length, `NO SUBJECT — "${claim}" was quantified over an empty set, so it proved nothing`).toBeGreaterThan(0);
  return rows;
}

// ── 2. forced interleaving ────────────────────────────────────────────────

/** How long a bounded observation may wait before the case FAILS. Never a pass. */
const OBSERVE_ATTEMPTS = 1200;
const OBSERVE_INTERVAL_MS = 25;

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function pidOf(c: Queryable): Promise<number> {
  return must((await c.query<{ pid: number }>('SELECT pg_backend_pid()::int AS pid')).rows[0]).pid;
}

/**
 * Every backend parked on a heavyweight lock whose blockers reach `roots`,
 * computed to a FIXED POINT.
 *
 * The fixed point is not decoration. With one holder and two waiters on the
 * same row, PostgreSQL reports the SECOND waiter as blocked by the FIRST
 * waiter (it is queued behind it on the tuple lock), so a single-step
 * "blocked directly by the parker" test sees one waiter and never two, and a
 * suite built on it would release the park with only half its race enqueued.
 */
export async function blockedBehind(roots: readonly number[], q: Queryable = ownerPool()): Promise<readonly number[]> {
  const r = await q.query<{ pid: number; blockers: number[] }>(
    `SELECT pid::int AS pid, pg_blocking_pids(pid)::int[] AS blockers
       FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND state = 'active' AND pid <> ALL ($1::int[])`,
    [[...roots]],
  );
  const reached = new Set<number>(roots);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of r.rows) {
      if (reached.has(row.pid)) continue;
      if ((row.blockers ?? []).some((b) => reached.has(b))) {
        reached.add(row.pid);
        grew = true;
      }
    }
  }
  return [...reached].filter((p) => !roots.includes(p)).sort((a, b) => a - b);
}

/**
 * Wait, bounded, until exactly `n` backends are parked behind `roots`, or
 * until `settled` reports the attempt finished without ever parking.
 *
 * The two outcomes are not symmetric. `queued` is the forcing working. Either
 * other outcome is a FINDING and is thrown: an attempt that SETTLED without
 * parking did not contend at all, so whatever it returned is not a race
 * result; and the expiry of the bound means a statement that was supposed to
 * block never blocked, which is the missing serialization itself.
 */
export async function waitUntilQueued(
  roots: readonly number[],
  n: number,
  settled: { done: boolean },
  what: string,
  /** The bound, in polls. Lowered only by the harness's OWN red proofs, which must reach the bound to show it fails. */
  attempts: number = OBSERVE_ATTEMPTS,
): Promise<readonly number[]> {
  for (let i = 0; i < attempts; i += 1) {
    const parked = await blockedBehind(roots);
    if (parked.length >= n) return parked;
    if (settled.done)
      throw new Error(
        `${what}: attempt ${n} finished without ever waiting on the parked lock, so this was not a race. ` +
          `A verdict read out of an unforced interleaving is a verdict about the machine's speed — [[daftar-a-test-whose-verdict-is-the-machines-speed]].`,
      );
    await tick(OBSERVE_INTERVAL_MS);
  }
  throw new Error(
    `${what}: only ${(await blockedBehind(roots)).length} of ${n} attempts ever parked behind the held lock within ` +
      `${(attempts * OBSERVE_INTERVAL_MS) / 1000}s. The bound expiring is a FAILURE, never a pass: a command that did not ` +
      `block on the stock key did not take the lock the writer is required to take (P4-AL-29, 0060:299-306).`,
  );
}

export interface Park {
  readonly pid: number;
  release(): Promise<void>;
}

/**
 * Park the ONE row lock `inventory_apply_stock_movements` must take for this
 * stock key (`0060:299-306`: the level row is inserted ON CONFLICT DO NOTHING
 * and then locked FOR UPDATE, in sorted key order, A-23).
 *
 * The row must already exist, and the lock must actually be taken: a park on
 * a row that is not there holds nothing, and every attempt would then sail
 * past and the suite would report a green race that never happened.
 */
export async function parkStockKey(open: () => Promise<Client>, businessId: string, warehouseId: string, variantId: string): Promise<Park> {
  return parkRow(
    open,
    `SELECT 1 FROM stock_levels WHERE business_id = $1 AND warehouse_id = $2 AND variant_id = $3 FOR UPDATE`,
    [businessId, warehouseId, variantId],
    `parkStockKey: no stock_levels row for (${warehouseId}, ${variantId})`,
  );
}

/**
 * Park a row lock on EXACTLY ONE row, whatever relation it is in, on a
 * connection of its own.
 *
 * The generalisation of `parkStockKey`, and it exists because a seam the
 * routine reaches by TAKING A ROW LOCK cannot be injected at with a trigger:
 * `invoice_sequences` is read `FOR UPDATE` and never updated (P4-AL-31 — the
 * ordinal is `max(number_seq) + 1`, not a stored counter), so a
 * `BEFORE UPDATE` trigger there never fires, the injection observes nothing,
 * and the case passes for the wrong reason. Holding the row is the only way
 * to reach that seam, and it is the method §2 already uses for the stock key.
 *
 * `sql` must select EXACTLY ONE row `FOR UPDATE`. A park on an absent row
 * holds nothing, every attempt sails past, and the suite reports a forced
 * interleaving that never happened — so a row count other than one THROWS.
 */
export async function parkRow(open: () => Promise<Client>, sql: string, params: readonly unknown[], what: string): Promise<Park> {
  const c = await open();
  await c.query('BEGIN');
  const r = await c.query(sql, [...params]);
  if (r.rowCount !== 1) {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end().catch(() => undefined);
    throw new Error(`${what} — a park on an absent row holds no lock and forces no interleaving`);
  }
  const pid = await pidOf(c);
  let released = false;
  return {
    pid,
    release: async (): Promise<void> => {
      if (released) return;
      released = true;
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end().catch(() => undefined);
    },
  };
}

export type Outcome<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'deadlock'; readonly error: unknown }
  | { readonly kind: 'error'; readonly error: unknown };

/** `40P01` gets its own kind so no caller can mistake it for a business outcome. */
export function classify<T>(value: T | undefined, error: unknown | undefined): Outcome<T> {
  if (error !== undefined) {
    const sqlstate = error instanceof DatabaseError ? error.code : undefined;
    if (sqlstate === '40P01') return { kind: 'deadlock', error };
    return { kind: 'error', error };
  }
  return { kind: 'ok', value: value as T };
}

export async function settle<T>(run: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return classify(await run(), undefined);
  } catch (e) {
    return classify<T>(undefined, e);
  }
}

/**
 * A deadlock is a lock-order defect, and this is where that is stated once.
 * It is not retried, it is not a business outcome, and `deadlock_timeout` is
 * not touched — `[[daftar-lock-order-not-retry]]`, P4-AL-41.
 */
export function expectNoDeadlock(outcomes: readonly Outcome<unknown>[], what: string): void {
  const deadlocks = outcomes.filter((o) => o.kind === 'deadlock');
  expect(
    deadlocks.length,
    `${what}: ${deadlocks.length} of ${outcomes.length} attempts died with SQLSTATE 40P01. A deadlock between two commands of this ` +
      `estate is a LOCK-ORDER DEFECT in the declared order of P4-AL-41, not contention and not an outcome to retry: fix the order the ` +
      `command acquires its rows in. This suite will not retry, will not raise deadlock_timeout and will not report a pass. ` +
      `First deadlock: ${deadlocks[0] === undefined ? '' : String((deadlocks[0] as { error: unknown }).error)}`,
  ).toBe(0);
}

/**
 * THE FORCED RACE. `attempts` are launched in order; each one's arrival in the
 * lock queue behind `park` is OBSERVED before the next is launched, so the
 * service order is the array order and not a coin toss. The park is released
 * only once every attempt is parked, and always released, even on a throw.
 */
export async function forcedRace<T>(park: Park, attempts: readonly (() => Promise<T>)[], what: string): Promise<readonly Outcome<T>[]> {
  const pending: Promise<Outcome<T>>[] = [];
  const flags: { done: boolean }[] = [];
  try {
    for (let i = 0; i < attempts.length; i += 1) {
      const flag = { done: false };
      flags.push(flag);
      const run = settle(must(attempts[i], `attempt ${i}`)).then((o) => {
        flag.done = true;
        return o;
      });
      pending.push(run);
      await waitUntilQueued([park.pid], i + 1, flag, `${what}: enqueueing attempt ${i + 1} of ${attempts.length}`);
    }
  } finally {
    await park.release();
  }
  const outcomes = await Promise.all(pending);
  expectNoDeadlock(outcomes, what);
  return outcomes;
}

// ── 3. the census ─────────────────────────────────────────────────────────

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`refusing to interpolate the identifier ${JSON.stringify(name)}`);
  return `"${name}"`;
}

/** Every ordinary public table that carries a column of this name. Discovered, never listed. */
export async function tablesWithColumn(q: Queryable, column: string): Promise<readonly string[]> {
  const r = await q.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = $1 AND a.attnum > 0 AND NOT a.attisdropped)
      ORDER BY 1`,
    [column],
  );
  return r.rows.map((x) => x.relname);
}

export type Census = Readonly<Record<string, number>>;

/**
 * THE CENSUS: one row count per business-scoped relation, for this business,
 * over every such relation THAT EXISTS — plus the consumed-assertion registries,
 * found by their `jti` column.
 *
 * Discovered rather than listed on purpose. The accepted H-7 counter
 * (`tests/helpers/inventory-commands.ts:756`) names its tables as literals, so
 * a relation a later slice adds is outside it and a row that survives a
 * rolled-back command in that relation is invisible to every atomicity suite
 * built on it. A census read out of `pg_class` has no such blind spot and
 * needs no edit when `sales` and `sale_items` arrive.
 */
export async function census(q: Queryable, businessId: string): Promise<Census> {
  const scoped = await tablesWithColumn(q, 'business_id');
  const jtis = (await tablesWithColumn(q, 'jti')).filter((t) => !scoped.includes(t));
  const parts = [
    ...scoped.map((t) => `(SELECT count(*)::int FROM ${quoteIdent(t)} WHERE business_id = $1) AS ${quoteIdent(t)}`),
    ...jtis.map((t) => `(SELECT count(*)::int FROM ${quoteIdent(t)}) AS ${quoteIdent(t)}`),
  ];
  if (parts.length === 0) throw new Error('census: no business-scoped relation exists, so this census would assert nothing');
  const r = await q.query<Record<string, number>>(`SELECT ${parts.join(', ')}`, [businessId]);
  return must(r.rows[0], 'census');
}

/** `after − before`, keeping only what moved. */
export function censusDelta(before: Census, after: Census): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(after)) {
    const d = v - (before[k] ?? 0);
    if (d !== 0) out[k] = d;
  }
  for (const k of Object.keys(before)) if (!(k in after)) out[k] = -(before[k] ?? 0);
  return out;
}

// ── 4. the official reconciliation formula ────────────────────────────────

/**
 * `GL Inventory (1200)` — the signed sum of the journal lines on the account
 * whose system key is `inventory`. Read by IDENTITY, never by a typed account
 * code, because a code typed into a test is a second copy of the chart.
 */
export async function glInventoryBaseMinor(q: Queryable, businessId: string): Promise<bigint> {
  const r = await q.query<{ n: string }>(
    `SELECT coalesce(sum(l.debit_minor - l.credit_minor), 0)::text AS n
       FROM journal_lines l JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
      WHERE l.business_id = $1 AND a.system_key = 'inventory'`,
    [businessId],
  );
  return BigInt(must(r.rows[0]).n);
}

/** `Σ stock_movements.value_delta_base_minor` — the ledger side of the identity. */
export async function ledgerValueBaseMinor(q: Queryable, businessId: string): Promise<bigint> {
  const r = await q.query<{ n: string }>(`SELECT coalesce(sum(value_delta_base_minor), 0)::text AS n FROM stock_movements WHERE business_id = $1`, [
    businessId,
  ]);
  return BigInt(must(r.rows[0]).n);
}

/**
 * THE OFFICIAL IDENTITY (P4-AL-25, `TL-P4-S0-01`):
 *
 *     GL Inventory (1200) == Σ stock_movements.value_delta_base_minor
 *
 * Integer minor units on both sides, and no average cost anywhere.
 * `quantity × average_cost` is never the reconciliation truth: the average is
 * a rounded quotient, and re-multiplying it reintroduces the drift the stored
 * delta already resolved — `[[daftar-a-rounded-quotient-is-never-an-input]]`,
 * `[[daftar-rounding-is-not-additive]]`. The canonical suite document's
 * GOLD-33 wording still says `Σ(qty×avg_cost)`; the lock supersedes it, and
 * this function is the only reconciliation this slice performs.
 *
 * It asserts the identity, and it asserts the identity has a SUBJECT: a
 * business with no movement and no inventory line satisfies `0 == 0` while
 * proving nothing at all.
 */
export async function expectInventoryReconciled(q: Queryable, businessId: string, what: string): Promise<bigint> {
  const gl = await glInventoryBaseMinor(q, businessId);
  const ledger = await ledgerValueBaseMinor(q, businessId);
  const movements = must((await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM stock_movements WHERE business_id = $1`, [businessId])).rows[0]).n;
  expect(movements, `${what}: NO SUBJECT — the reconciliation identity was asserted over a business with no stock movement`).toBeGreaterThan(0);
  expect(
    gl.toString(),
    `${what}: GL Inventory (1200) must equal Σ stock_movements.value_delta_base_minor exactly (P4-AL-25); never quantity × average_cost`,
  ).toBe(ledger.toString());
  return gl;
}

/**
 * `on_hand` for one key compared to `expected` AS A NUMERIC, by the database.
 * The comparison is made in SQL and never in JavaScript: a quantity read into
 * a JS number is a float, and money and quantities in this estate are never
 * floats. The scale `stock_levels.on_hand` happens to carry is also not this
 * suite's business, so `'0'` and `'0.0000'` must not be a difference.
 */
export async function expectOnHand(q: Queryable, businessId: string, warehouseId: string, variantId: string, expected: string, what: string): Promise<void> {
  const r = await q.query<{ same: boolean | null; on_hand: string | null }>(
    `SELECT (on_hand = $4::numeric) AS same, on_hand::text AS on_hand FROM stock_levels
      WHERE business_id = $1 AND warehouse_id = $2 AND variant_id = $3`,
    [businessId, warehouseId, variantId, expected],
  );
  const row = r.rows[0];
  expect(row === undefined ? 'no stock_levels row' : row.on_hand, `${what}: on_hand must be ${expected}`).not.toBe('no stock_levels row');
  expect(row?.same, `${what}: on_hand is ${row?.on_hand ?? 'absent'}, expected ${expected}`).toBe(true);
}

/** On-hand for one stock key, as text so no float ever touches a quantity. */
export async function onHandText(q: Queryable, businessId: string, warehouseId: string, variantId: string): Promise<string | null> {
  const r = await q.query<{ on_hand: string }>(
    `SELECT on_hand::text AS on_hand FROM stock_levels WHERE business_id = $1 AND warehouse_id = $2 AND variant_id = $3`,
    [businessId, warehouseId, variantId],
  );
  return r.rows[0]?.on_hand ?? null;
}

/** Every `on_hand` of the business that is below zero. OD-P4-05: there is never one. */
export async function negativeLevels(q: Queryable, businessId: string): Promise<readonly { warehouse_id: string; variant_id: string; on_hand: string }[]> {
  const r = await q.query<{ warehouse_id: string; variant_id: string; on_hand: string }>(
    `SELECT warehouse_id, variant_id, on_hand::text AS on_hand FROM stock_levels WHERE business_id = $1 AND on_hand < 0`,
    [businessId],
  );
  return r.rows;
}
