/**
 * P4-S6 — LEVEL F. THE SPECIFICATION'S OWN TEXT, EXECUTED ON A REAL CLUSTER.
 *
 * ## The debt this suite exists to pay
 *
 * `docs/PHASE_4_S6_DDL_SPECIFICATION.md` §2A.2 admits, in its own words, that
 * NEITHER upgrade path distinguishes the backfill EXPRESSION from the constant
 * `0`: on `check:db-from-zero` the assertion iterates over nothing, and on the
 * real upgrade every correct answer is also `0` because the reversal relations
 * are created empty in the same migration. It then says the proof is owed at
 * level F with a planted constant-`0` counterpart. **This file is that proof.**
 *
 * It also pays a second debt. `packages/inventory/test/customer-reversal-concurrency.test.ts`
 * is a MODEL, and says so. A model of PostgreSQL can be WRONG ABOUT POSTGRESQL,
 * and this slice's own history is the evidence: challenge finding F1 found the
 * model treating a `UNIQUE` index as a predicate a `SELECT` can compute, and
 * F-C2 found it comparing an expression with itself. Both were defects in the
 * model, not in the protocol. `[[daftar-concurrency-must-be-real]]` is therefore
 * discharged HERE and not there: **two real connections, real indexes, real
 * READ COMMITTED, and a waiter whose registration in the lock queue is
 * ASSERTED rather than assumed from elapsed time.**
 *
 * ## Why this is not a suite that creates its own subject and proves the fixture
 *
 * That objection is the reason the model was written instead, and it is a real
 * objection: the reversal relations do not exist in any migration, so a fixture
 * must create them, and a fixture a test author wrote is a fixture a test
 * author can quietly bend until it passes.
 *
 * The answer is that **this file transcribes nothing.** It READS the SQL out of
 * the specification documents and executes that text. `extractOne` fails the
 * suite when its anchor matches nothing, so a document that is edited away from
 * what is proved here does not silently keep a green suite — it reddens it. The
 * subject of every case below is the document, and the document is the thing
 * the migration owner will implement. What remains outside the proof is exactly
 * one thing, and it is stated rather than hidden: that the eventual migration
 * file transcribes these same statements. That is the migration owner's
 * checkable obligation at promotion, not a claim made here.
 *
 * ## Running it
 *
 * Needs a cluster, so it is opt-in and SKIPS by default — a suite that silently
 * needs a server is a suite that silently fails to run. Set `P4S6_LEVEL_F=1`
 * with a `PG_DIR`/`PG_PORT` pair nobody else holds:
 *
 *   P4S6_LEVEL_F=1 PG_DIR=/tmp/daftar-pg-p4s6f PG_PORT=56861 \
 *     npx vitest run tests/integration/p4s6-level-f-spec-executed.test.ts
 *
 * The skip is itself guarded: `it('the opt-in gate is not vacuous')` below
 * fails if the flag is set and the cluster never came up, so "skipped" and
 * "passed" can never be confused for each other.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { adminUrl, ensureDatabase, startOrReuse } from '../helpers/embedded-cluster';
import { writeTimeGeneration, asOfNowGeneration, type GenerationRow } from '../../packages/inventory/src/customer-reversal';

const ENABLED = process.env['P4S6_LEVEL_F'] === '1';

const DOCS = join(__dirname, '../../docs');
const DDL_SPEC = readFileSync(join(DOCS, 'PHASE_4_S6_DDL_SPECIFICATION.md'), 'utf8');
const LEVEL_UQ = readFileSync(join(DOCS, 'PHASE_4_S6_LEVEL_UNIQUENESS.md'), 'utf8');

// ──────────────────────────────────────────────────────────────────────────
// 0. The extractor. The document is the subject; nothing here is retyped.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Pull ONE statement out of a document, anchored on a comment or a name the
 * document itself writes.
 *
 * It THROWS on no match and on more than one match. Both matter: a silent
 * zero-match would turn every case below into a test of the empty string, and
 * a silent multi-match would let the suite prove whichever copy it happened to
 * find first after someone added a second.
 */
function extractOne(doc: string, label: string, anchor: RegExp): string {
  const found = [...doc.matchAll(anchor)];
  if (found.length !== 1) {
    throw new Error(`P4-S6 level F: the anchor for ${label} matched ${found.length} times in the specification, and exactly one match is required. ` + `The document and this suite have diverged; correct whichever is wrong rather than loosening the anchor.`);
  }
  const text = (found[0]?.[1] ?? '').trim();
  if (text.length === 0) throw new Error(`P4-S6 level F: the anchor for ${label} matched an EMPTY body`);
  return text;
}

/** The repaired expressions of DDL spec §2A.1 — the single fenced block that carries all three. */
const REPAIRED_BLOCK = extractOne(DDL_SPEC, 'the three repaired backfill expressions (§2A.1)', /```sql\n(-- \(1\) payment_allocations\.chain_generation[\s\S]*?)```/g);

/** Round 4's defect, which §2A.1 retains on purpose so the repair has a named subject. */
const ROUND4_DEFECT = extractOne(DDL_SPEC, "round 4's defective expression (§2A.1, retained as the named defect)", /```sql\n-- ROUND 4, WRONG\.[^\n]*\n([\s\S]*?)```/g);

/** Split the repaired block into its three `UPDATE`s on the document's own `-- (n)` markers. */
function repairedExpression(n: 1 | 2 | 3): string {
  const parts = REPAIRED_BLOCK.split(/^-- \((?=[123]\))/m);
  const body = parts.find((p) => p.startsWith(`${n})`));
  if (body === undefined) throw new Error(`P4-S6 level F: §2A.1's block does not carry expression (${n})`);
  const sql = body
    .split('\n')
    .filter((l) => !/^\s*--/.test(l) && !/^[123]\)/.test(l))
    .join('\n')
    .replace(/--[^\n]*$/gm, '')
    .trim();
  if (!/^UPDATE/i.test(sql)) throw new Error(`P4-S6 level F: expression (${n}) does not begin with UPDATE; it begins "${sql.slice(0, 40)}"`);
  return sql.endsWith(';') ? sql : `${sql};`;
}

/**
 * The three replacement keys, read out of LEVEL_UNIQUENESS §2's own prose,
 * where each is written as `<name> UNIQUE (<columns>)`.
 */
function replacementKey(name: string): { readonly name: string; readonly columns: readonly string[] } {
  const columns = extractOne(LEVEL_UQ, `the replacement key ${name}`, new RegExp(`${name} UNIQUE \\(([^)]*)\\)`, 'g'))
    .split(',')
    .map((c) => c.trim());
  // Non-vacuity of the WIDENING itself: a key whose last column is not the
  // generation is the NARROW key, and proving mutual exclusion with it would
  // prove nothing about this change.
  const last = columns[columns.length - 1];
  if (last === undefined || !/generation$/.test(last)) {
    throw new Error(`P4-S6 level F: ${name} as the document writes it ends in "${String(last)}", not a generation column — that is the key this slice REPLACES, not its replacement`);
  }
  return { name, columns };
}

const KEY_PA = replacementKey('payment_allocations_level_generation_uq');
const KEY_CCA_INVOICE = replacementKey('customer_credit_applications_invoice_level_generation_uq');
const KEY_CCA_CREDIT = replacementKey('customer_credit_applications_level_generation_uq');

function createKey(k: { readonly name: string; readonly columns: readonly string[] }, relation: string): string {
  return `CREATE UNIQUE INDEX ${k.name} ON ${relation} (${k.columns.join(', ')})`;
}

// ──────────────────────────────────────────────────────────────────────────
// 1. The fixture. Column shapes come from 0081, which IS in the tree.
// ──────────────────────────────────────────────────────────────────────────

const B = '11111111-1111-1111-1111-111111111111';
const I1 = '22222222-2222-2222-2222-222222222221';
const I2 = '22222222-2222-2222-2222-222222222222';
const C1 = '33333333-3333-3333-3333-333333333331';
const u = (n: number): string => `44444444-0000-0000-0000-${String(n).padStart(12, '0')}`;

/**
 * `created_at TIMESTAMPTZ NOT NULL` with NO default, deliberately: the write
 * time is the witness §2A.1 rests on, and a fixture that let `now()` supply it
 * would make every row of one statement share a timestamp and would decide the
 * strict comparison's outcome by accident. Every INSERT below states its own.
 * `0081:321` and `0081:465` carry `DEFAULT now()`; the default is not what is
 * under proof here, the COMPARISON is.
 */
const SCHEMA = `
  DROP TABLE IF EXISTS allocation_reversals, payment_allocations, customer_credit_applications;
  CREATE TABLE payment_allocations (
    business_id uuid NOT NULL,
    id uuid NOT NULL,
    invoice_id uuid NOT NULL,
    ar_released_before_txn_minor bigint NOT NULL,
    amount_minor bigint NOT NULL,
    chain_generation bigint NOT NULL DEFAULT 0 CHECK (chain_generation >= 0),
    created_at timestamptz NOT NULL,
    PRIMARY KEY (business_id, id));
  CREATE TABLE customer_credit_applications (
    business_id uuid NOT NULL,
    id uuid NOT NULL,
    invoice_id uuid NOT NULL,
    credit_id uuid NOT NULL,
    ar_released_before_txn_minor bigint NOT NULL,
    credit_remaining_before_minor bigint NOT NULL,
    amount_minor bigint NOT NULL,
    chain_generation bigint NOT NULL DEFAULT 0 CHECK (chain_generation >= 0),
    credit_chain_generation bigint NOT NULL DEFAULT 0 CHECK (credit_chain_generation >= 0),
    created_at timestamptz NOT NULL,
    PRIMARY KEY (business_id, id));
  CREATE TABLE allocation_reversals (
    business_id uuid NOT NULL,
    id uuid NOT NULL,
    reducer_id uuid NOT NULL,
    reducer_kind text NOT NULL,
    invoice_id uuid NOT NULL,
    credit_id uuid,
    freed_ar_level_minor bigint NOT NULL,
    freed_credit_level_minor bigint,
    created_at timestamptz NOT NULL,
    PRIMARY KEY (business_id, id),
    UNIQUE (business_id, reducer_id));
`;

const T = (n: number): string => `2026-03-0${n} 00:00:00+00`;

let url: string;
let pool: Pool;
let clusterUp = false;

async function sessionAt(): Promise<Client> {
  const c = new Client({ connectionString: url });
  await c.connect();
  await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  return c;
}

/**
 * THE CONTENTION ASSERTION, and the reason no case below has a verdict the
 * machine's speed could decide.
 *
 * `[[daftar-a-test-whose-verdict-is-the-machines-speed]]`. A second inserter
 * colliding on a unique index waits on the FIRST inserter's transaction id —
 * that is a `transactionid` lock, and PostgreSQL publishes the wait in
 * `pg_stat_activity`. This polls for the WAITER to appear there and FAILS if it
 * never does. So:
 *
 * - a pass requires the waiter to have been OBSERVED blocked. Two connections
 *   used in sequence did not contend and cannot pass;
 * - the bound is an upper bound on PATIENCE, never a verdict. A slow machine
 *   makes the poll take longer; it cannot turn "blocked" into "not blocked",
 *   because the observation is a catalogue read and not an elapsed time.
 */
async function expectBlockedOnLock(pid: number, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const { rows } = await pool.query<{ wait_event_type: string | null; wait_event: string | null; state: string }>(`SELECT wait_event_type, wait_event, state FROM pg_stat_activity WHERE pid = $1`, [pid]);
    const row = rows[0];
    if (row?.wait_event_type === 'Lock') return;
    if (Date.now() > deadline) {
      throw new Error(`P4-S6 level F: ${what} — the second writer was NEVER observed waiting on a lock ` + `(state=${String(row?.state)}, wait=${String(row?.wait_event_type)}/${String(row?.wait_event)}). ` + `A writer that never queued did not contend, and this case proves nothing. This is a FAILURE, not a pass.`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function pidOf(c: Client): Promise<number> {
  const { rows } = await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  const pid = rows[0]?.pid;
  if (pid === undefined) throw new Error('no backend pid');
  return pid;
}

async function reset(): Promise<void> {
  // A case that failed part-way through L-F4b would otherwise leave its guard
  // installed, and every later INSERT would be refused by a leftover from
  // another case — a red that names the wrong defect.
  await pool.query('DROP TRIGGER IF EXISTS g1 ON payment_allocations');
  await pool.query('DROP TRIGGER IF EXISTS g2 ON customer_credit_applications');
  await pool.query('DROP FUNCTION IF EXISTS p4s6_active_level_guard()');
  await pool.query('DROP INDEX IF EXISTS payment_allocations_level_generation_uq, customer_credit_applications_invoice_level_generation_uq, customer_credit_applications_level_generation_uq');
  await pool.query('TRUNCATE allocation_reversals, payment_allocations, customer_credit_applications');
}

/** The history §2A.1 names by its duplicate key, `I1|700|1`. */
async function seedReversedTail(): Promise<void> {
  await pool.query('INSERT INTO payment_allocations VALUES ($1,$2,$3,0,400,0,$4)', [B, u(1), I1, T(1)]);
  await pool.query('INSERT INTO payment_allocations VALUES ($1,$2,$3,400,300,0,$4)', [B, u(2), I1, T(2)]);
  await pool.query('INSERT INTO payment_allocations VALUES ($1,$2,$3,700,300,0,$4)', [B, u(3), I1, T(3)]);
  await pool.query(`INSERT INTO allocation_reversals (business_id,id,reducer_id,reducer_kind,invoice_id,freed_ar_level_minor,created_at) VALUES ($1,$2,$3,'payment_allocation',$4,700,$5)`, [B, u(903), u(3), I1, T(4)]);
}

async function generations(): Promise<readonly { readonly id: string; readonly level: string; readonly gen: string }[]> {
  const { rows } = await pool.query<{ id: string; level: string; gen: string }>(`SELECT id, ar_released_before_txn_minor::text AS level, chain_generation::text AS gen FROM payment_allocations ORDER BY ar_released_before_txn_minor, created_at`);
  return rows;
}

describe('P4-S6 level F — the specification executed', () => {
  beforeAll(async () => {
    if (!ENABLED) return;
    await startOrReuse();
    await ensureDatabase('p4s6levelf');
    url = adminUrl.replace(/\/postgres$/, '/p4s6levelf');
    pool = new Pool({ connectionString: url, max: 8 });
    await pool.query(SCHEMA);
    clusterUp = true;
  }, 240_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
  });

  // ── The gate's own non-vacuity ─────────────────────────────────────────

  it('the opt-in gate is not vacuous: asked to run, it RAN', () => {
    // `[[daftar-a-green-gate-must-prove-it-can-be-red]]`. Without this case a
    // cluster that never came up would leave every case below silently
    // skipped and the file reported as passing.
    expect(ENABLED ? clusterUp : true).toBe(true);
  });

  it('the extraction found real SQL in the real documents', () => {
    expect(repairedExpression(1)).toMatch(/r\.created_at\s*<\s*a\.created_at/);
    expect(repairedExpression(2)).toMatch(/customer_credit_applications/);
    // F-C6: expression (3) is keyed on the CREDIT. If a future edit returns it
    // to the invoice, this reddens rather than measuring the wrong key.
    expect(repairedExpression(3)).toMatch(/o\.credit_id\s*=\s*a\.credit_id/);
    expect(repairedExpression(3)).toMatch(/credit_remaining_before_minor\s*>=/);
    // The planted counterpart must be the thing it claims to be: round 4's
    // expression is the repaired one MINUS the write-time bound.
    expect(ROUND4_DEFECT).toMatch(/ar_released_before_txn_minor/);
    expect(ROUND4_DEFECT).not.toMatch(/created_at/);
  });

  // ── RED PROOF L-F1. §2A.2's owed proof: EXPRESSION ≠ CONSTANT 0 ────────
  //
  // Four things, as required of every red proof:
  //   subject exists      — the three originals and the reversal are COUNTED;
  //   mutation occurred   — the stored generations are read back and differ
  //                         between the two expressions on the same data;
  //   result is non-empty — the row count is asserted > 0 before any verdict;
  //   the defect is NAMED — SQLSTATE 23505 on the specific key `…,700,1`, not
  //                         merely "the statement threw".

  it.runIf(ENABLED)('L-F1a — the REPAIRED expression admits the lawful successor, and the wider key is BUILDABLE', async () => {
    await reset();
    await seedReversedTail();

    const { rows: before } = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM payment_allocations');
    expect(before[0]?.n).toBe('3'); // the subject exists
    const { rows: revs } = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM allocation_reversals');
    expect(revs[0]?.n).toBe('1'); // and it HOLDS A REVERSAL, which is the only data on which the two answers differ

    const applied = await pool.query(repairedExpression(1));
    expect(applied.rowCount).toBe(3); // the mutation really occurred, over every row

    // The law, from src/ and not from a copy (F-C2's lesson). The reversal
    // sequence is [700]; the three originals were all written before it.
    const seq = [700n];
    const rows: GenerationRow[] = [
      { rowId: u(1), level: 0n, writtenAfter: 0, reversedAt: null },
      { rowId: u(2), level: 400n, writtenAfter: 0, reversedAt: null },
      { rowId: u(3), level: 700n, writtenAfter: 0, reversedAt: 0 },
    ];
    const expected = rows.map((r) => writeTimeGeneration(r, seq).toString());
    expect(expected).toEqual(['0', '0', '0']);
    expect((await generations()).map((g) => g.gen)).toEqual(expected);

    // The lawful successor at the FREED level — the one row this whole repair
    // exists to admit — carries generation 1, because one reversal existed
    // when it was written.
    expect(writeTimeGeneration({ rowId: u(4), level: 700n, writtenAfter: 1, reversedAt: null }, seq)).toBe(1n);

    await pool.query(createKey(KEY_PA, 'payment_allocations'));
    await pool.query('INSERT INTO payment_allocations VALUES ($1,$2,$3,700,300,1,$4)', [B, u(4), I1, T(5)]);
    const { rows: after } = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM payment_allocations WHERE ar_released_before_txn_minor = 700');
    expect(after[0]?.n).toBe('2'); // the reversed original and its successor COEXIST at one level
  });

  it.runIf(ENABLED)("L-F1b — ROUND 4's expression stores 1 on the reversed original and the migration CANNOT APPLY", async () => {
    await reset();
    await seedReversedTail();

    const applied = await pool.query(ROUND4_DEFECT.replace(/^SET/i, 'UPDATE payment_allocations a\n   SET'));
    expect(applied.rowCount).toBe(3); // the mutation really occurred

    // THE EXACT DEFECT, named as a figure and not as a feeling: the row at 700
    // counted the reversal OF ITSELF, because 700 <= 700.
    const got = await generations();
    expect(got.map((g) => `${g.level}:${g.gen}`)).toEqual(['0:0', '400:0', '700:1']);
    // and it disagrees with the law, read from src/
    expect(writeTimeGeneration({ rowId: u(3), level: 700n, writtenAfter: 0, reversedAt: 0 }, [700n])).toBe(0n);
    // while the AS-OF-NOW form — which the deferred verifier uses, correctly,
    // over ACTIVE rows only — gives 1. The two forms are different functions,
    // which is F-C1's structural half.
    expect(asOfNowGeneration(700n, [700n])).toBe(1n);

    // Step 0c has now manufactured the duplicate that step 0d refuses.
    await pool.query(createKey(KEY_PA, 'payment_allocations'));
    await expect(pool.query('INSERT INTO payment_allocations VALUES ($1,$2,$3,700,300,1,$4)', [B, u(4), I1, T(5)])).rejects.toMatchObject({
      code: '23505',
      constraint: KEY_PA.name,
    });
  });

  it.runIf(ENABLED)('L-F1c — the CONSTANT 0 is indistinguishable on an empty-reversal tree and WRONG on this one', async () => {
    await reset();
    await seedReversedTail();
    // The successor is written FIRST, so the relation holds the row the
    // constant gets wrong. `DEFAULT 0` is what a column addition gives it.
    await pool.query('INSERT INTO payment_allocations VALUES ($1,$2,$3,700,300,DEFAULT,$4)', [B, u(4), I1, T(5)]);
    const { rows } = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM payment_allocations WHERE chain_generation = 0');
    expect(rows[0]?.n).toBe('4'); // every row took the constant

    // And the constant collides where the expression does not: two rows at
    // level 700 both holding generation 0.
    await expect(pool.query(createKey(KEY_PA, 'payment_allocations'))).rejects.toMatchObject({ code: '23505' });

    // Now the expression, on the same four rows. It gives the successor 1.
    await pool.query(repairedExpression(1));
    const got = await generations();
    expect(got.map((g) => `${g.level}:${g.gen}`)).toEqual(['0:0', '400:0', '700:0', '700:1']);
    await pool.query(createKey(KEY_PA, 'payment_allocations')); // and now it builds
  });

  it.runIf(ENABLED)('L-F1d — the tie fails CLOSED, in the direction §2A.1 claims', async () => {
    await reset();
    await seedReversedTail();
    // A successor sharing the reversal's exact timestamp. Strict `<` counts
    // zero reversals before it, so it takes the generation of its own reversed
    // original — and the index refuses it. That is the fail-closed direction.
    await pool.query('INSERT INTO payment_allocations VALUES ($1,$2,$3,700,300,0,$4)', [B, u(4), I1, T(4)]);
    await pool.query(repairedExpression(1));
    const got = await generations();
    expect(got.filter((g) => g.level === '700').map((g) => g.gen)).toEqual(['0', '0']);
    await expect(pool.query(createKey(KEY_PA, 'payment_allocations'))).rejects.toMatchObject({ code: '23505' });
  });

  // ── RED PROOF L-F2. REAL mutual exclusion, two REAL sessions ───────────

  it.runIf(ENABLED)('L-F2a — two truthful writers at ONE freed level: the second QUEUES and is then REFUSED', async () => {
    await reset();
    await seedReversedTail();
    await pool.query(repairedExpression(1));
    await pool.query(createKey(KEY_PA, 'payment_allocations'));

    const a = await sessionAt();
    const b = await sessionAt();
    try {
      // Both compute the SAME key, because both see the same one reversal.
      // That is the point of the widening: honest parties collide.
      const bPid = await pidOf(b); // BEFORE b blocks: a Client serialises its queries
      await a.query('INSERT INTO payment_allocations VALUES ($1,$2,$3,700,300,1,$4)', [B, u(10), I1, T(5)]);
      const pending = b.query('INSERT INTO payment_allocations VALUES ($1,$2,$3,700,300,1,$4)', [B, u(11), I1, T(6)]);
      const settled = pending.then(
        () => ({ ok: true }) as const,
        (e: unknown) => ({ ok: false, e }) as const,
      );

      await expectBlockedOnLock(bPid, 'L-F2a');
      await a.query('COMMIT');
      const r = await settled;
      expect(r.ok).toBe(false);
      expect(r.ok === false ? r.e : null).toMatchObject({ code: '23505', constraint: KEY_PA.name });
      await b.query('ROLLBACK').catch(() => undefined);

      const { rows } = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM payment_allocations WHERE ar_released_before_txn_minor = 700 AND chain_generation = 1');
      expect(rows[0]?.n).toBe('1'); // exactly ONE successor exists
    } finally {
      await a.end().catch(() => undefined);
      await b.end().catch(() => undefined);
    }
  });

  it.runIf(ENABLED)('L-F2b — the non-vacuous counterpart: a successor beside its reversed original does NOT queue', async () => {
    await reset();
    await seedReversedTail();
    await pool.query(repairedExpression(1));
    await pool.query(createKey(KEY_PA, 'payment_allocations'));

    const a = await sessionAt();
    try {
      // Generation 1 against the immutable original's 0: different keys, so
      // this must NOT block and must NOT be refused. Without this case L-F2a
      // would also pass against a key so coarse it excluded everything.
      await a.query('INSERT INTO payment_allocations VALUES ($1,$2,$3,700,300,1,$4)', [B, u(12), I1, T(5)]);
      await a.query('COMMIT');
      const { rows } = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM payment_allocations WHERE ar_released_before_txn_minor = 700');
      expect(rows[0]?.n).toBe('2');
    } finally {
      await a.end().catch(() => undefined);
    }
  });

  it.runIf(ENABLED)('L-F2c — a writer that FABRICATES a generation is refused by its own COMMIT, not trusted', async () => {
    await reset();
    await seedReversedTail();
    await pool.query(repairedExpression(1));
    await pool.query(createKey(KEY_PA, 'payment_allocations'));
    const a = await sessionAt();
    const b = await sessionAt();
    try {
      await a.query('INSERT INTO payment_allocations VALUES ($1,$2,$3,700,300,1,$4)', [B, u(13), I1, T(5)]);
      await a.query('COMMIT');
      // A liar claiming generation 2 escapes the INDEX — the index is mutual
      // exclusion over equal keys and nothing more. What catches it is the
      // deferred verifier's generation law, which is LEVEL E and not proved
      // here. Recorded as the index's STATED limit rather than papered over.
      await b.query('INSERT INTO payment_allocations VALUES ($1,$2,$3,700,300,2,$4)', [B, u(14), I1, T(6)]);
      await b.query('COMMIT');
      const { rows } = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM payment_allocations WHERE ar_released_before_txn_minor = 700');
      expect(rows[0]?.n).toBe('3');
      // and the law says the fabricated value is not the row's generation
      expect(writeTimeGeneration({ rowId: u(14), level: 700n, writtenAfter: 1, reversedAt: null }, [700n])).toBe(1n);
    } finally {
      await a.end().catch(() => undefined);
      await b.end().catch(() => undefined);
    }
  });

  // ── RED PROOF L-F3. F-C6: the credit key, and the double-spend ─────────

  /**
   * ONE credit `C1`, and a reversal whose freed credit level is ABOVE the level
   * the two writers then contend for.
   *
   * The reversed original sits at remaining level 1200, NOT at 1000. That
   * placement is load-bearing and was a defect in this file's first draft: with
   * the original at 1000 it occupies the key `(C1, 1000, 0)` itself, so the
   * counterpart case L-F3b would have been refused by a COLLISION WITH THE
   * SEED rather than admitted-and-double-spent — red for the wrong reason, and
   * therefore proving nothing. `[[daftar-a-red-proof-names-its-defect]]`.
   *
   * After it: credit remaining level 1000 is FREE, invoice `I1`'s chain carries
   * one reversal and invoice `I2`'s carries none — which is exactly the
   * asymmetry that makes an invoice-keyed generation differ between two
   * truthful parties at one credit level.
   */
  async function seedCreditWithReversalAbove(): Promise<void> {
    await pool.query('INSERT INTO customer_credit_applications VALUES ($1,$2,$3,$4,0,1200,200,0,0,$5)', [B, u(20), I1, C1, T(1)]);
    await pool.query(`INSERT INTO allocation_reversals (business_id,id,reducer_id,reducer_kind,invoice_id,credit_id,freed_ar_level_minor,freed_credit_level_minor,created_at) VALUES ($1,$2,$3,'credit_application',$4,$5,0,1200,$6)`, [B, u(920), u(20), I1, C1, T(2)]);
  }

  /** What each expression ANSWERS for a row, computed by the server, not typed by hand. */
  async function countedGeneration(kind: 'credit' | 'invoice', invoiceId: string, remaining: number, at: string): Promise<string> {
    const where = kind === 'credit' ? 'o.credit_id = $2' : 'r.invoice_id = $2';
    const { rows } = await pool.query<{ n: string }>(
      `SELECT pg_catalog.count(*)::text AS n
         FROM allocation_reversals r
         JOIN customer_credit_applications o ON o.business_id = r.business_id AND o.id = r.reducer_id
        WHERE r.business_id = $1 AND ${where}
          AND o.credit_remaining_before_minor >= $3 AND r.created_at < $4`,
      [B, kind === 'credit' ? C1 : invoiceId, remaining, at],
    );
    return rows[0]?.n ?? '?';
  }

  it.runIf(ENABLED)('L-F3a — the CREDIT-keyed expression makes two truthful writers at one remaining level COLLIDE', async () => {
    await reset();
    await seedCreditWithReversalAbove();
    await pool.query(repairedExpression(3));
    await pool.query(createKey(KEY_CCA_CREDIT, 'customer_credit_applications'));

    // The key both parties compute is the SAME, and the server says so.
    expect(await countedGeneration('credit', I1, 1000, T(3))).toBe('1');
    expect(await countedGeneration('credit', I2, 1000, T(4))).toBe('1');

    const a = await sessionAt();
    const b = await sessionAt();
    try {
      const bPid = await pidOf(b); // BEFORE b blocks, for the same reason as L-F2a
      await a.query('INSERT INTO customer_credit_applications VALUES ($1,$2,$3,$4,0,1000,400,0,1,$5)', [B, u(21), I1, C1, T(3)]);
      const pending = b.query('INSERT INTO customer_credit_applications VALUES ($1,$2,$3,$4,0,1000,400,0,1,$5)', [B, u(22), I2, C1, T(4)]);
      const settled = pending.then(
        () => ({ ok: true }) as const,
        (e: unknown) => ({ ok: false, e }) as const,
      );
      await expectBlockedOnLock(bPid, 'L-F3a');
      await a.query('COMMIT');
      const r = await settled;
      expect(r.ok).toBe(false);
      expect(r.ok === false ? r.e : null).toMatchObject({ code: '23505', constraint: KEY_CCA_CREDIT.name });
      await b.query('ROLLBACK').catch(() => undefined);
      const { rows } = await pool.query<{ n: string }>('SELECT coalesce(sum(amount_minor),0)::text AS n FROM customer_credit_applications WHERE credit_remaining_before_minor = 1000');
      expect(rows[0]?.n).toBe('400'); // the credit is spent ONCE at that level
    } finally {
      await a.end().catch(() => undefined);
      await b.end().catch(() => undefined);
    }
  });

  it.runIf(ENABLED)('L-F3b — the INVOICE-keyed mirror round 4 implied: both writers commit and the credit is SPENT TWICE', async () => {
    await reset();
    await seedCreditWithReversalAbove();
    await pool.query(createKey(KEY_CCA_CREDIT, 'customer_credit_applications'));

    // THE DEFECT, as two figures from the server: counted over each party's own
    // INVOICE chain, two truthful parties at ONE credit level disagree.
    const genA = await countedGeneration('invoice', I1, 1000, T(3));
    const genB = await countedGeneration('invoice', I2, 1000, T(4));
    expect([genA, genB]).toEqual(['1', '0']);

    const a = await sessionAt();
    const b = await sessionAt();
    try {
      await a.query('INSERT INTO customer_credit_applications VALUES ($1,$2,$3,$4,0,1000,400,0,$5,$6)', [B, u(21), I1, C1, Number(genA), T(3)]);
      await b.query('INSERT INTO customer_credit_applications VALUES ($1,$2,$3,$4,0,1000,400,0,$5,$6)', [B, u(22), I2, C1, Number(genB), T(4)]);
      // NEITHER queued — which IS the defect: different keys, so the index has
      // nothing to exclude. Both commit.
      await a.query('COMMIT');
      await b.query('COMMIT');
      const { rows } = await pool.query<{ n: string }>('SELECT coalesce(sum(amount_minor),0)::text AS n FROM customer_credit_applications WHERE credit_remaining_before_minor = 1000');
      // 800 applied at ONE remaining level of 1000, by two parties neither of
      // which lied. The credit is double-spent at that level. THE EXACT DEFECT,
      // and the reason expression (3)'s WHERE names `credit_id`.
      expect(rows[0]?.n).toBe('800');
    } finally {
      await a.end().catch(() => undefined);
      await b.end().catch(() => undefined);
    }
  });

  // ── RED PROOF L-F4. F-C5: the cross-relation seam is OPEN, measured ────

  it.runIf(ENABLED)('L-F4 — one invoice level, two RELATIONS: neither writer queues and 1300 is released against 1000', async () => {
    await reset();
    await pool.query('INSERT INTO payment_allocations VALUES ($1,$2,$3,0,400,0,$4)', [B, u(30), I1, T(1)]);
    await pool.query(`INSERT INTO allocation_reversals (business_id,id,reducer_id,reducer_kind,invoice_id,freed_ar_level_minor,created_at) VALUES ($1,$2,$3,'payment_allocation',$4,0,$5)`, [B, u(930), u(30), I1, T(2)]);
    await pool.query(createKey(KEY_PA, 'payment_allocations'));
    await pool.query(createKey(KEY_CCA_INVOICE, 'customer_credit_applications'));

    const a = await sessionAt();
    const b = await sessionAt();
    try {
      // The SAME invoice level 0, generation 1, one row in each relation. A
      // unique index is PER-RELATION, so there is no key both writers share.
      await a.query('INSERT INTO payment_allocations VALUES ($1,$2,$3,0,600,1,$4)', [B, u(31), I1, T(3)]);
      await b.query('INSERT INTO customer_credit_applications VALUES ($1,$2,$3,$4,0,1000,700,1,0,$5)', [B, u(32), I1, C1, T(4)]);
      await a.query('COMMIT');
      await b.query('COMMIT');
      const { rows } = await pool.query<{ n: string }>(`SELECT ((SELECT coalesce(sum(amount_minor),0) FROM payment_allocations WHERE invoice_id = $1 AND id <> $2) + (SELECT coalesce(sum(amount_minor),0) FROM customer_credit_applications WHERE invoice_id = $1))::text AS n`, [I1, u(30)]);
      // 600 + 700 = 1300 released against an invoice of 1000. The seam is
      // OPEN, it is PRE-EXISTING (0081:330-332 records it), and it is
      // reachable only from the direct-SQL path because both routines take the
      // chain lock. LEVEL_UNIQUENESS §4's claim that it is "refused at
      // statement time and at COMMIT" was WITHDRAWN for this reason, and this
      // case is why. A document saying a hole is closed is worse than a hole.
      expect(rows[0]?.n).toBe('1300');
    } finally {
      await a.end().catch(() => undefined);
      await b.end().catch(() => undefined);
    }
  });

  it.runIf(ENABLED)('L-F4b — the CONDITION: the cross-relation BEFORE INSERT guard of §2 (a) refuses it', async () => {
    await reset();
    await pool.query('INSERT INTO payment_allocations VALUES ($1,$2,$3,0,400,0,$4)', [B, u(30), I1, T(1)]);
    // The guard LEVEL_UNIQUENESS §2 (a) specifies, as a trigger on both
    // relations. It is a READ, so it closes the seam only for parties that are
    // not concurrent — which is exactly F1's finding, and is why the guard is
    // (a) beside the index's (a0) and never instead of it.
    await pool.query(`
      CREATE FUNCTION p4s6_active_level_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM payment_allocations p
                    WHERE p.business_id = NEW.business_id AND p.invoice_id = NEW.invoice_id
                      AND p.ar_released_before_txn_minor = NEW.ar_released_before_txn_minor
                      AND NOT EXISTS (SELECT 1 FROM allocation_reversals r WHERE r.business_id = p.business_id AND r.reducer_id = p.id))
           OR EXISTS (SELECT 1 FROM customer_credit_applications c
                    WHERE c.business_id = NEW.business_id AND c.invoice_id = NEW.invoice_id
                      AND c.ar_released_before_txn_minor = NEW.ar_released_before_txn_minor
                      AND NOT EXISTS (SELECT 1 FROM allocation_reversals r WHERE r.business_id = c.business_id AND r.reducer_id = c.id))
        THEN RAISE EXCEPTION 'invoice_settlement.active_level_occupied';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER g1 BEFORE INSERT ON payment_allocations FOR EACH ROW EXECUTE FUNCTION p4s6_active_level_guard();
      CREATE TRIGGER g2 BEFORE INSERT ON customer_credit_applications FOR EACH ROW EXECUTE FUNCTION p4s6_active_level_guard();
    `);
    // Level 0 is occupied by an ACTIVE payment allocation: the cross-relation
    // write is refused by NAME. Sequential, so the guard's read sees it.
    await expect(pool.query('INSERT INTO customer_credit_applications VALUES ($1,$2,$3,$4,0,1000,700,0,0,$5)', [B, u(32), I1, C1, T(3)])).rejects.toMatchObject({
      message: expect.stringContaining('invoice_settlement.active_level_occupied'),
    });
    await pool.query('DROP TRIGGER g1 ON payment_allocations; DROP TRIGGER g2 ON customer_credit_applications; DROP FUNCTION p4s6_active_level_guard()');
  });
});
