/**
 * CHALLENGER (round 4, signature 2) — the §1A.3 central claim, on TWO REAL
 * CONNECTIONS against real indexes at READ COMMITTED. Disposable experiment.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { adminUrl, ensureDatabase, startOrReuse } from '../helpers/embedded-cluster';

const B = '11111111-1111-1111-1111-111111111111';
const I1 = '22222222-2222-2222-2222-222222222221';
const C1 = '33333333-3333-3333-3333-333333333331';
const u = (n: number): string => `44444444-0000-0000-0000-${String(n).padStart(12, '0')}`;

let url: string;
let pool: Pool;

async function connect(): Promise<Client> {
  const c = new Client({ connectionString: url });
  await c.connect();
  await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  return c;
}

describe('S6 challenge — two REAL writers under the widened keys', () => {
  beforeAll(async () => {
    await startOrReuse();
    await ensureDatabase('s6chal2');
    url = adminUrl.replace(/\/postgres$/, '/s6chal2');
    pool = new Pool({ connectionString: url, max: 4 });
    await pool.query(`
      DROP TABLE IF EXISTS allocation_reversals, payment_allocations, customer_credit_applications;
      CREATE TABLE payment_allocations (
        business_id uuid NOT NULL, id uuid NOT NULL, invoice_id uuid NOT NULL,
        ar_released_before_txn_minor bigint NOT NULL, amount_minor bigint NOT NULL,
        chain_generation bigint NOT NULL DEFAULT 0, PRIMARY KEY (business_id, id));
      CREATE TABLE customer_credit_applications (
        business_id uuid NOT NULL, id uuid NOT NULL, invoice_id uuid NOT NULL, credit_id uuid NOT NULL,
        ar_released_before_txn_minor bigint NOT NULL, credit_remaining_before_minor bigint NOT NULL,
        amount_minor bigint NOT NULL,
        chain_generation bigint NOT NULL DEFAULT 0, credit_chain_generation bigint NOT NULL DEFAULT 0,
        PRIMARY KEY (business_id, id));
      CREATE TABLE allocation_reversals (
        business_id uuid NOT NULL, id uuid NOT NULL, reducer_id uuid NOT NULL,
        reducer_kind text NOT NULL, invoice_id uuid NOT NULL, credit_id uuid,
        freed_ar_level_minor bigint NOT NULL, freed_credit_level_minor bigint,
        PRIMARY KEY (business_id, id), UNIQUE (business_id, reducer_id));
      -- the THREE replacement keys of §2A, exactly as specified
      CREATE UNIQUE INDEX payment_allocations_level_generation_uq
        ON payment_allocations (business_id, invoice_id, ar_released_before_txn_minor, chain_generation);
      CREATE UNIQUE INDEX customer_credit_applications_invoice_level_generation_uq
        ON customer_credit_applications (business_id, invoice_id, ar_released_before_txn_minor, chain_generation);
      CREATE UNIQUE INDEX customer_credit_applications_level_generation_uq
        ON customer_credit_applications (business_id, credit_id, credit_remaining_before_minor, credit_chain_generation);
    `);
  }, 180_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
  });

  async function seedReversedTail(): Promise<void> {
    await pool.query('TRUNCATE allocation_reversals, payment_allocations, customer_credit_applications');
    await pool.query('INSERT INTO payment_allocations VALUES ($1,$2,$3,0,400,0)', [B, u(1), I1]);
    await pool.query('INSERT INTO payment_allocations VALUES ($1,$2,$3,400,300,0)', [B, u(2), I1]);
    await pool.query('INSERT INTO payment_allocations VALUES ($1,$2,$3,700,300,0)', [B, u(3), I1]);
    await pool.query(
      `INSERT INTO allocation_reversals (business_id,id,reducer_id,reducer_kind,invoice_id,freed_ar_level_minor)
       VALUES ($1,$2,$3,'payment_allocation',$4,700)`,
      [B, u(903), u(3), I1],
    );
  }

  /** The §2A.1 generation expression, as a WRITER would evaluate it for a new row. */
  async function genFor(c: Client, level: bigint): Promise<bigint> {
    const r = await c.query<{ n: string }>(
      `SELECT pg_catalog.count(*)::text AS n
         FROM public.allocation_reversals r
         JOIN public.payment_allocations o
           ON o.business_id = r.business_id AND o.id = r.reducer_id
        WHERE r.business_id = $1 AND r.invoice_id = $2
          AND o.ar_released_before_txn_minor <= $3`,
      [B, I1, level.toString()],
    );
    return BigInt(r.rows[0]?.n ?? '0');
  }

  it('B1 — SOUND: two TRUTHFUL writers at one freed level compute the SAME key, the second BLOCKS on the index and gets 23505, with no lock taken by either', async () => {
    await seedReversedTail();
    const t1 = await connect();
    const t2 = await connect();
    try {
      // Both compute the generation from the append-only reversal rows alone.
      expect(await genFor(t1, 700n)).toBe(1n);
      expect(await genFor(t2, 700n)).toBe(1n);
      await t1.query('INSERT INTO payment_allocations VALUES ($1,$2,$3,700,300,1)', [B, u(11), I1]);

      // T2 inserts the SAME key while T1 is still open. It must BLOCK on T1's
      // uncommitted index entry — proved by the insert not settling on its own.
      let settled: 'blocked' | 'raised' | 'committed' = 'blocked';
      const racing = t2
        .query('INSERT INTO payment_allocations VALUES ($1,$2,$3,700,300,1)', [B, u(12), I1])
        .then(() => {
          settled = 'committed';
        })
        .catch(() => {
          settled = 'raised';
        });
      await new Promise((r) => setTimeout(r, 700));
      expect(settled, 'T2 did not block on the index entry: the mutual exclusion is not there').toBe('blocked');
      // Neither party took a row lock or an advisory key — this is the unlocked path.
      const locks = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_locks WHERE locktype = 'advisory'`,
      );
      expect(locks.rows[0]?.n).toBe('0');

      await t1.query('COMMIT');
      await racing;
      expect(settled).toBe('raised');
      await t2.query('ROLLBACK').catch(() => undefined);

      const rows = await pool.query<{ id: string }>(
        'SELECT id FROM payment_allocations WHERE ar_released_before_txn_minor = 700 AND chain_generation = 1',
      );
      expect(rows.rows.map((r) => r.id)).toEqual([u(11)]);
    } finally {
      await t1.end().catch(() => undefined);
      await t2.end().catch(() => undefined);
    }
  });

  it('B2 — FINDING: two concurrent writers at ONE invoice AR level, one per relation, BOTH COMMIT — the widened keys are per-relation and exclude nothing across them', async () => {
    await seedReversedTail();
    const t1 = await connect();
    const t2 = await connect();
    try {
      // Both are TRUTHFUL: the freed AR level is 700 and both compute generation 1.
      expect(await genFor(t1, 700n)).toBe(1n);
      // T1: a payment allocation at the freed AR level 700.
      await t1.query('INSERT INTO payment_allocations VALUES ($1,$2,$3,700,300,1)', [B, u(21), I1]);
      // T2: a credit application at the SAME AR level 700 of the SAME invoice.
      await t2.query(
        `INSERT INTO customer_credit_applications
           (business_id,id,invoice_id,credit_id,ar_released_before_txn_minor,credit_remaining_before_minor,amount_minor,chain_generation,credit_chain_generation)
         VALUES ($1,$2,$3,$4,700,500,300,1,0)`,
        [B, u(22), I1, C1],
      );
      // Neither blocked: no index spans the two relations, and a BEFORE INSERT
      // trigger that READS cannot see the other transaction's uncommitted row.
      await t1.query('COMMIT');
      await t2.query('COMMIT');
    } finally {
      await t1.end().catch(() => undefined);
      await t2.end().catch(() => undefined);
    }
    const both = await pool.query<{ rel: string; id: string }>(
      `SELECT 'payment_allocations' AS rel, id FROM payment_allocations
        WHERE business_id=$1 AND invoice_id=$2 AND ar_released_before_txn_minor=700
          AND id NOT IN (SELECT reducer_id FROM allocation_reversals WHERE business_id=$1)
       UNION ALL
       SELECT 'customer_credit_applications', id FROM customer_credit_applications
        WHERE business_id=$1 AND invoice_id=$2 AND ar_released_before_txn_minor=700
       ORDER BY 1`,
      [B, I1],
    );
    // TWO ACTIVE reducers at one AR level of one invoice, committed, with 600
    // minor released where 300 was available — the F1 state, one relation apart.
    expect(both.rows.map((r) => r.rel)).toEqual(['customer_credit_applications', 'payment_allocations']);
    const released = await pool.query<{ s: string }>(
      `SELECT coalesce(sum(amount_minor),0)::text AS s FROM (
         SELECT amount_minor FROM payment_allocations
          WHERE business_id=$1 AND invoice_id=$2
            AND id NOT IN (SELECT reducer_id FROM allocation_reversals WHERE business_id=$1)
         UNION ALL
         SELECT amount_minor FROM customer_credit_applications WHERE business_id=$1 AND invoice_id=$2) x`,
      [B, I1],
    );
    expect(released.rows[0]?.s).toBe('1300'); // capacity on this chain is 1000
  });
});
