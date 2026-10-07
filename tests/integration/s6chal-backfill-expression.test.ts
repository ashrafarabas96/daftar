/**
 * CHALLENGER (round 4, signature 2) — the P4-S6 §2A.1 BACKFILL EXPRESSION,
 * executed on a real PostgreSQL cluster against the generation LAW it claims
 * to implement. Not part of the slice; a disposable experiment.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { adminUrl, ensureDatabase, startOrReuse } from '../helpers/embedded-cluster';

const B = '11111111-1111-1111-1111-111111111111';
const I1 = '22222222-2222-2222-2222-222222222221';
const I2 = '22222222-2222-2222-2222-222222222222';
const C1 = '33333333-3333-3333-3333-333333333331';
const u = (n: number): string => `44444444-0000-0000-0000-${String(n).padStart(12, '0')}`;

/** §2A.1 VERBATIM, for payment_allocations. */
const BACKFILL_PA = `
UPDATE payment_allocations a
   SET chain_generation = (
         SELECT pg_catalog.count(*)
           FROM public.allocation_reversals r
           JOIN public.payment_allocations o
             ON o.business_id = r.business_id AND o.id = r.reducer_id
          WHERE r.business_id = a.business_id
            AND r.invoice_id  = a.invoice_id
            AND o.ar_released_before_txn_minor <= a.ar_released_before_txn_minor)`;

/** The literal descending MIRROR of §2A.1 (invoice-keyed, as the spec writes it). */
const BACKFILL_CREDIT_LITERAL_MIRROR = `
UPDATE customer_credit_applications a
   SET credit_chain_generation = (
         SELECT pg_catalog.count(*)
           FROM public.allocation_reversals r
           JOIN public.customer_credit_applications o
             ON o.business_id = r.business_id AND o.id = r.reducer_id
          WHERE r.business_id = a.business_id
            AND r.invoice_id  = a.invoice_id
            AND o.credit_remaining_before_minor >= a.credit_remaining_before_minor)`;

/** The credit-keyed expression §3 of LEVEL_UNIQUENESS describes but no document writes. */
const BACKFILL_CREDIT_BY_CREDIT = `
UPDATE customer_credit_applications a
   SET credit_chain_generation = (
         SELECT pg_catalog.count(*)
           FROM public.allocation_reversals r
           JOIN public.customer_credit_applications o
             ON o.business_id = r.business_id AND o.id = r.reducer_id
          WHERE r.business_id = a.business_id
            AND r.credit_id   = a.credit_id
            AND o.credit_remaining_before_minor >= a.credit_remaining_before_minor)`;

let pool: Pool;

describe('S6 challenge — §2A.1 backfill expression on a real cluster', () => {
  beforeAll(async () => {
    await startOrReuse();
    await ensureDatabase('s6chal');
    pool = new Pool({ connectionString: adminUrl.replace(/\/postgres$/, '/s6chal'), max: 4 });
    await pool.query(`
      DROP TABLE IF EXISTS allocation_reversals, payment_allocations, customer_credit_applications;
      CREATE TABLE payment_allocations (
        business_id uuid NOT NULL, id uuid NOT NULL, invoice_id uuid NOT NULL,
        ar_released_before_txn_minor bigint NOT NULL,
        chain_generation bigint NOT NULL DEFAULT 0,
        PRIMARY KEY (business_id, id));
      CREATE TABLE customer_credit_applications (
        business_id uuid NOT NULL, id uuid NOT NULL, invoice_id uuid NOT NULL, credit_id uuid NOT NULL,
        ar_released_before_txn_minor bigint NOT NULL, credit_remaining_before_minor bigint NOT NULL,
        chain_generation bigint NOT NULL DEFAULT 0, credit_chain_generation bigint NOT NULL DEFAULT 0,
        PRIMARY KEY (business_id, id));
      CREATE TABLE allocation_reversals (
        business_id uuid NOT NULL, id uuid NOT NULL, reducer_id uuid NOT NULL,
        reducer_kind text NOT NULL, invoice_id uuid NOT NULL, credit_id uuid,
        freed_ar_level_minor bigint NOT NULL, freed_credit_level_minor bigint,
        PRIMARY KEY (business_id, id), UNIQUE (business_id, reducer_id));
    `);
  }, 180_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
  });

  async function reset(): Promise<void> {
    await pool.query('TRUNCATE allocation_reversals, payment_allocations, customer_credit_applications');
    await pool.query('DROP INDEX IF EXISTS pa_lvl_gen_uq');
  }
  async function pa(id: number, invoice: string, level: bigint, gen = 0n): Promise<void> {
    await pool.query('INSERT INTO payment_allocations VALUES ($1,$2,$3,$4,$5)', [B, u(id), invoice, level, gen]);
  }
  async function revPa(id: number, reducer: number, invoice: string, freed: bigint): Promise<void> {
    await pool.query(
      `INSERT INTO allocation_reversals (business_id,id,reducer_id,reducer_kind,invoice_id,freed_ar_level_minor)
       VALUES ($1,$2,$3,'payment_allocation',$4,$5)`,
      [B, u(900 + id), u(reducer), invoice, freed],
    );
  }
  async function gens(): Promise<Record<string, string>> {
    const r = await pool.query<{ id: string; ar_released_before_txn_minor: string; chain_generation: string }>(
      'SELECT id, ar_released_before_txn_minor, chain_generation FROM payment_allocations ORDER BY ar_released_before_txn_minor, id',
    );
    return Object.fromEntries(r.rows.map((x) => [`${x.id.slice(-3)}@${x.ar_released_before_txn_minor}`, x.chain_generation]));
  }

  // ── FINDING: the expression RE-DATES the reversed original ───────────────
  it('A1 — the <= DOUBLE-COUNTS the row the reversal is about: the reversed original is backfilled to 1, not its write-time 0', async () => {
    await reset();
    await pa(1, I1, 0n);
    await pa(2, I1, 400n);
    await pa(3, I1, 700n);
    await revPa(3, 3, I1, 700n); // the tail at 700 is reversed
    await pool.query(BACKFILL_PA);
    const g = await gens();
    // The LAW: gen is the value "as of the moment this row was written". All
    // three rows predate the only reversal, so all three must be 0.
    expect(g).toEqual({ '001@0': '0', '002@400': '0', '003@700': '1' });
    //                                                 ^^^^^^^^^^ the defect
  });

  it('A1b — and the §2A.1 ordering therefore cannot complete: step 0d CREATE UNIQUE INDEX fails over its own backfill', async () => {
    await reset();
    await pa(1, I1, 0n);
    await pa(2, I1, 400n);
    await pa(3, I1, 700n);
    await revPa(3, 3, I1, 700n);
    await pa(4, I1, 700n, 1n); // the LAWFUL successor at the freed level, gen 1
    await pool.query(BACKFILL_PA); // step 0c
    await expect(
      pool.query(
        'CREATE UNIQUE INDEX pa_lvl_gen_uq ON payment_allocations (business_id, invoice_id, ar_released_before_txn_minor, chain_generation)',
      ),
    ).rejects.toThrow(/duplicate key|23505|could not create unique index/i);
    const g = await gens();
    expect([g['003@700'], g['004@700']]).toEqual(['1', '1']); // two rows, ONE key
  });

  it('A2 — two reversals at different levels on one chain: the live rows are right, the reversed ones are inflated', async () => {
    await reset();
    await pa(1, I1, 0n);
    await pa(2, I1, 400n);
    await pa(3, I1, 700n);
    await revPa(3, 3, I1, 700n);
    await revPa(2, 2, I1, 400n); // LIFO: 700 then 400
    await pa(5, I1, 400n, 1n); // lawful successor at 400
    await pool.query(BACKFILL_PA);
    const g = await gens();
    expect(g['001@0']).toBe('0'); // correct: no reversal at level <= 0
    expect(g['005@400']).toBe('1'); // correct: the one reversal at 400
    expect(g['002@400']).toBe('1'); // WRONG: write-time was 0 — now collides with 005
    expect(g['003@700']).toBe('2'); // WRONG: write-time was 0
  });

  it('A3 — SOUND: a reversal on a DIFFERENT invoice of the same business does not leak into this chain', async () => {
    await reset();
    await pa(1, I1, 0n);
    await pa(2, I1, 400n);
    await pa(10, I2, 0n);
    await pa(11, I2, 400n);
    await revPa(11, 11, I2, 400n); // reversal on I2 only
    await pool.query(BACKFILL_PA);
    const g = await gens();
    expect(g['001@0']).toBe('0');
    expect(g['002@400']).toBe('0'); // I1 untouched
    expect(g['010@0']).toBe('0');
    expect(g['011@400']).toBe('1'); // only I2's own row moved
  });

  it('A4 — the JOIN silently DROPS every credit_application reversal on the same AR chain, so the expression is not the stated law on a mixed chain', async () => {
    await reset();
    await pa(1, I1, 0n); // PA at AR level 0, releases 400
    await pool.query(
      `INSERT INTO customer_credit_applications (business_id,id,invoice_id,credit_id,ar_released_before_txn_minor,credit_remaining_before_minor)
       VALUES ($1,$2,$3,$4,400,600)`,
      [B, u(20), I1, C1],
    ); // CA at AR level 400
    await pa(2, I1, 600n); // PA at AR level 600
    // Reverse the CA at AR level 400 — a reversal ON THIS CHAIN, freed level 400.
    await pool.query(
      `INSERT INTO allocation_reversals (business_id,id,reducer_id,reducer_kind,invoice_id,credit_id,freed_ar_level_minor,freed_credit_level_minor)
       VALUES ($1,$2,$3,'credit_application',$4,$5,400,600)`,
      [B, u(920), u(20), I1, C1],
    );
    await pool.query(BACKFILL_PA);
    const g = await gens();
    // THE LAW says "the number of reversal rows ON THIS CHAIN whose freed level
    // is <= X". For the PA at 600 that is 1. The expression says 0.
    const lawful = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM allocation_reversals r
        WHERE r.business_id=$1 AND r.invoice_id=$2 AND r.freed_ar_level_minor <= 600`,
      [B, I1],
    );
    expect(lawful.rows[0]?.n).toBe('1'); // the law
    expect(g['002@600']).toBe('0'); // the expression
  });

  it('A5 — the DESCENDING credit chain: >= is the right flip, and the literal invoice-keyed mirror is WRONG across invoices', async () => {
    await reset();
    const ca = async (id: number, invoice: string, remainingBefore: bigint, arLevel: bigint): Promise<void> => {
      await pool.query(
        `INSERT INTO customer_credit_applications (business_id,id,invoice_id,credit_id,ar_released_before_txn_minor,credit_remaining_before_minor)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [B, u(id), invoice, C1, arLevel, remainingBefore],
      );
    };
    // One credit C1 consumed against TWO invoices: 1000 -> 600 (I1), 600 -> 200 (I2).
    await ca(30, I1, 1000n, 0n);
    await ca(31, I2, 600n, 0n);
    // Reverse the credit-chain tail (31, freed credit level 600) and append the
    // lawful successor at the freed level 600 — against a DIFFERENT invoice (I1).
    await pool.query(
      `INSERT INTO allocation_reversals (business_id,id,reducer_id,reducer_kind,invoice_id,credit_id,freed_ar_level_minor,freed_credit_level_minor)
       VALUES ($1,$2,$3,'credit_application',$4,$5,0,600)`,
      [B, u(931), u(31), I2, C1],
    );
    await ca(32, I1, 600n, 400n);

    // (a) the CREDIT-keyed expression gives the descending law its right answers
    await pool.query(BACKFILL_CREDIT_BY_CREDIT);
    const byCredit = await pool.query<{ id: string; credit_chain_generation: string }>(
      'SELECT id, credit_chain_generation FROM customer_credit_applications ORDER BY credit_remaining_before_minor DESC, id',
    );
    expect(byCredit.rows.map((r) => `${r.id.slice(-3)}=${r.credit_chain_generation}`)).toEqual(['030=0', '031=1', '032=1']);
    //   030 @1000: no reversal at level >= 1000 -> 0 (right)
    //   032 @600 : the 600 reversal             -> 1 (right)
    //   031 @600 : INFLATED (write-time 0) — the same A1 defect on this chain

    // (b) the LITERAL invoice-keyed mirror of §2A.1 splits one credit chain by invoice
    await pool.query(BACKFILL_CREDIT_LITERAL_MIRROR);
    const literal = await pool.query<{ id: string; credit_chain_generation: string }>(
      'SELECT id, credit_chain_generation FROM customer_credit_applications ORDER BY credit_remaining_before_minor DESC, id',
    );
    expect(literal.rows.map((r) => `${r.id.slice(-3)}=${r.credit_chain_generation}`)).toEqual(['030=0', '031=1', '032=0']);
    //   032 @600 against I1 gets 0 — the SAME key as the reversed 031's
    //   write-time 0, and a DIFFERENT answer from the credit-keyed expression.
  });

  it('A6 — SOUND: the expression is IDEMPOTENT; re-running it after a partial failure changes nothing', async () => {
    await reset();
    await pa(1, I1, 0n);
    await pa(2, I1, 400n);
    await pa(3, I1, 700n);
    await revPa(3, 3, I1, 700n);
    await pool.query(BACKFILL_PA);
    const once = await gens();
    await pool.query(BACKFILL_PA);
    await pool.query(BACKFILL_PA);
    expect(await gens()).toEqual(once);
  });

  it('A7 — the §2A.2 "cheaper floor" the migration carries cannot distinguish the constant from the law', async () => {
    await reset();
    await pa(1, I1, 0n);
    await pa(2, I1, 400n);
    const empty = await pool.query<{ nz: string; rev: string }>(
      `SELECT (SELECT count(*) FROM payment_allocations WHERE chain_generation <> 0)::text AS nz,
              (SELECT count(*) FROM allocation_reversals)::text AS rev`,
    );
    expect(empty.rows[0]).toEqual({ nz: '0', rev: '0' });
    await pool.query(BACKFILL_PA);
    expect(Object.values(await gens())).toEqual(['0', '0']);
  });
});
