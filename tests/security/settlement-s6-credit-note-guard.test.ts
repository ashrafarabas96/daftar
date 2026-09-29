/**
 * P3-S6 T-15 — THE SUPPLIER CREDIT NOTE CHANGES ONLY BY ONE BACKED CONSUMPTION
 * (docs/PHASE_3_S6_CONTRACT.md A-10, A-12, §2.4, §6 T-15; 0067 R-66,
 * 0068 R-73).
 *
 * `supplier_credit_note_guard()` (replaced by its owner, trigger
 * `supplier_credit_notes_immutable` untouched) admits exactly one UPDATE: both
 * remaining values decremented to `(r − c, g(r − c))`, every other column
 * unchanged, backed by exactly ONE consumer row of THIS transaction (a
 * credit allocation or a refund) naming the note, `r`, `c` and the carrying
 * released. Everything else is `supplier_credit_note.immutable`:
 *   - a naked UPDATE of the pair (a decrement, an increase, to zero), by the
 *     owner or by the internal principal;
 *   - an UPDATE of any one of the fifteen other columns, alone or beside a
 *     backed decrement;
 *   - a backed decrement with a wrong carrying value; one backed twice; one
 *     whose backer belongs to another business transaction;
 *   - DELETE.
 * `daftar_app` holds neither UPDATE nor DELETE. The one writer,
 * `supplier_credit_note_consume`, has no grantee and re-verifies the
 * transaction's consumed assertion and its own consumer row
 * (`inventory.source_type_not_authorized`), and refuses a double apply
 * (`supplier_credit_note.consumption_inconsistent`). No other function
 * updates the note.
 */
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  attempt,
  expectAccepted,
  must,
  ownerClient,
  refusedWith,
  scratch,
  seedS3World,
  type Outcome,
  type S3Business,
  type S3World,
} from '../helpers/inventory-commands';
import { receivedPurchase } from '../helpers/purchase-returns';
import {
  committed,
  createMethod,
  noteOf,
  prepareAllocate,
  preparePay,
  prepareRefund,
  runS6,
  sqlReturnToCredit,
  type S6Call,
} from '../helpers/supplier-settlement';

let world: S3World;
let A: S3Business;
let method: string;
let cash: string;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  world = await seedS3World(ownerPool(), 's6cng');
  A = world.A;
  cash = must(
    (await ownerPool().query<{ id: string }>(`SELECT id::text FROM accounts WHERE business_id = $1 AND system_key = 'cash'`, [A.businessId])).rows[0],
  ).id;
  method = await committed((c) => createMethod(c, A, { postingAccountId: cash }));
});

afterAll(async () => {
  await resetData();
});

async function inTx(fn: (c: Client) => Promise<void>): Promise<void> {
  const c = await ownerClient();
  try {
    await c.query('BEGIN');
    await fn(c);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
}

/** A committed 100.00 ILS note (two pieces at 50.00 paid, then both returned), and its supplier. */
function note100(): Promise<{ creditNoteId: string; supplierId: string }> {
  return committed(async (c) => {
    const n = await sqlReturnToCredit(c, A, method, { qty: '2', unitPriceMinor: '5000', returnQty: '2' });
    return { creditNoteId: n.creditNoteId, supplierId: n.purchase.supplierId };
  });
}

const g = async (c: Client, creditNoteId: string, remaining: bigint): Promise<bigint> =>
  BigInt(
    must(
      (
        await c.query<{ g: string }>(
          `SELECT supplier_credit_remaining_carrying(n.original_amount_minor, n.original_carrying_base_amount_minor, $3::bigint)::text AS g
             FROM supplier_credit_notes n WHERE n.business_id = $1 AND n.id = $2`,
          [A.businessId, creditNoteId, remaining.toString()],
        )
      ).rows[0],
    ).g,
  );

const update = (c: Client, creditNoteId: string, set: string, params: readonly unknown[] = []): Promise<Outcome<unknown>> =>
  attempt(c, () => c.query(`UPDATE supplier_credit_notes SET ${set} WHERE business_id = $1 AND id = $2`, [A.businessId, creditNoteId, ...params]));

/** The pair set to (r, carrying) — `$3`, `$4`. */
const PAIR = 'remaining_amount_minor = $3::bigint, remaining_carrying_base_amount_minor = $4::bigint';

/**
 * Insert, as the owner in this transaction, a credit allocation BACKING a
 * decrement of the note from `rb` by `c`: a copy of `honest` (its trace and
 * timestamp) naming `rb`, `c` and the carrying released g(rb) − g(rb − c).
 */
async function backer(c: Client, honest: S6Call, rb: bigint, consumed: bigint, creditNoteId: string): Promise<void> {
  const released = (await g(c, creditNoteId, rb)) - (await g(c, creditNoteId, rb - consumed));
  const id = randomUUID();
  await c.query(
    `INSERT INTO supplier_credit_allocations (tenant_id, business_id, id, supplier_id, credit_note_id, purchase_id, allocation_date, credit_currency,
                                              credit_amount_consumed_minor, credit_to_base_rate, credit_remaining_before_minor,
                                              credit_carrying_base_released_minor, credit_dust_base_minor, purchase_currency,
                                              purchase_amount_applied_minor, purchase_historical_to_base_rate, ap_released_before_txn_minor,
                                              purchase_carrying_base_released_minor, ap_dust_base_minor, realized_fx_gain_loss_minor,
                                              intent_sha256, business_transaction_id, created_by, binding_source_id)
     SELECT tenant_id, business_id, $3, supplier_id, credit_note_id, purchase_id, allocation_date, credit_currency,
            $5::bigint, credit_to_base_rate, $4::bigint,
            $6::bigint, 0, purchase_currency,
            $5::bigint, purchase_historical_to_base_rate, ap_released_before_txn_minor,
            $6::bigint, 0, 0,
            intent_sha256, business_transaction_id, created_by, $3
       FROM supplier_credit_allocations WHERE business_id = $1 AND id = $2`,
    [A.businessId, honest.params[0], id, rb.toString(), consumed.toString(), released.toString()],
  );
}

/** An honest allocation of `consumed` from the note in this transaction (the note is decremented by its writer). */
async function honestAllocation(c: Client, creditNoteId: string, supplierId: string, consumed: bigint): Promise<S6Call> {
  const target = await receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '4', unitPriceMinor: '5000' }], { supplierId });
  const call = await prepareAllocate(c, A, { creditNoteId, purchaseId: target.purchaseId, consumedMinor: consumed });
  await runS6(c, A, call);
  return call;
}

describe('T-15 a naked change of the pair is immutable', () => {
  it('a decrement to (r − c, g(r − c)), an increase and zero — by the owner and by the internal principal', async () => {
    const { creditNoteId } = await note100();
    await inTx(async (c) => {
      const cases: readonly (readonly [string, bigint, bigint])[] = [
        ['a lawful-looking decrement to 60.00', 6000n, await g(c, creditNoteId, 6000n)],
        ['an increase', 20000n, 20000n],
        ['to zero', 0n, 0n],
        ['the carrying alone', 10000n, 9999n],
        ['the amount alone', 9999n, 10000n],
      ];
      for (const [what, r, carrying] of cases) {
        refusedWith(await update(c, creditNoteId, PAIR, [r.toString(), carrying.toString()]), 'P0001', 'supplier_credit_note.immutable', `owner: ${what}`);
        // The internal principal sees the row (its scope set), so the guard, not row security, decides.
        const asInternal = await attempt(c, async () => {
          await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [A.tenantId, A.businessId]);
          await c.query('SET LOCAL ROLE daftar_inventory_internal');
          const seen = await c.query(`SELECT 1 FROM supplier_credit_notes WHERE business_id = $1 AND id = $2`, [A.businessId, creditNoteId]);
          expect(seen.rowCount, 'the internal principal sees the note').toBe(1);
          await c.query(`UPDATE supplier_credit_notes SET ${PAIR} WHERE business_id = $1 AND id = $2`, [
            A.businessId,
            creditNoteId,
            r.toString(),
            carrying.toString(),
          ]);
        });
        refusedWith(asInternal, 'P0001', 'supplier_credit_note.immutable', `internal: ${what}`);
      }
    });
    expect(await noteOf(ownerPool(), A.businessId, creditNoteId)).toMatchObject({ remaining: 10000n, remainingCarrying: 10000n });
  });

  it('DELETE is immutable for the owner; the internal principal holds no DELETE', async () => {
    const { creditNoteId } = await note100();
    await inTx(async (c) => {
      refusedWith(
        await attempt(c, () => c.query(`DELETE FROM supplier_credit_notes WHERE business_id = $1 AND id = $2`, [A.businessId, creditNoteId])),
        'P0001',
        'supplier_credit_note.immutable',
        'owner DELETE',
      );
      // The internal principal holds no DELETE at all: refused before the guard.
      refusedWith(
        await attempt(c, async () => {
          await c.query('SET LOCAL ROLE daftar_inventory_internal');
          await c.query(`DELETE FROM supplier_credit_notes WHERE business_id = $1 AND id = $2`, [A.businessId, creditNoteId]);
        }),
        '42501',
        null,
        'internal DELETE',
      );
    });
  });
});

/** The fifteen columns the guard freezes (all but the two remaining values), each changed by an expression. */
const FROZEN: readonly (readonly [column: string, expr: string])[] = [
  ['tenant_id', 'gen_random_uuid()'],
  ['business_id', 'gen_random_uuid()'],
  ['id', 'gen_random_uuid()'],
  ['supplier_id', 'gen_random_uuid()'],
  ['supplier_return_id', 'gen_random_uuid()'],
  ['currency_code', `CASE WHEN currency_code = 'USD' THEN 'EUR' ELSE 'USD' END`],
  ['original_amount_minor', 'original_amount_minor + 1'],
  ['original_carrying_base_amount_minor', 'original_carrying_base_amount_minor + 1'],
  ['source_to_base_rate', 'source_to_base_rate + 1'],
  ['rate_source', `CASE WHEN rate_source = 'base' THEN 'manual' ELSE 'base' END`],
  ['rate_timestamp', `rate_timestamp + interval '1 second'`],
  ['issued_on', 'issued_on - 1'],
  ['business_transaction_id', 'gen_random_uuid()'],
  ['created_by', 'gen_random_uuid()'],
  ['created_at', `created_at - interval '1 second'`],
];

describe('T-15 any other column is immutable, alone or beside a backed decrement', () => {
  it('the guard freezes exactly every column but the two remaining values', async () => {
    const r = await ownerPool().query<{ a: string }>(
      `SELECT attname::text AS a FROM pg_attribute WHERE attrelid = 'supplier_credit_notes'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum`,
    );
    expect(r.rows.map((x) => x.a).sort(), 'fifteen frozen columns and the pair').toEqual(
      [...FROZEN.map(([col]) => col), 'remaining_amount_minor', 'remaining_carrying_base_amount_minor'].sort(),
    );
  });

  it('each of the fifteen, alone → immutable; with a backed decrement → immutable; the backed decrement alone → admitted', async () => {
    const { creditNoteId, supplierId } = await note100();
    await inTx(async (c) => {
      const honest = await honestAllocation(c, creditNoteId, supplierId, 1000n);
      expect(await noteOf(c, A.businessId, creditNoteId)).toMatchObject({ remaining: 9000n });
      await backer(c, honest, 9000n, 3000n, creditNoteId);
      const carrying = (await g(c, creditNoteId, 6000n)).toString();
      for (const [column, expr] of FROZEN) {
        refusedWith(await update(c, creditNoteId, `${column} = ${expr}`), 'P0001', 'supplier_credit_note.immutable', `${column} alone`);
        refusedWith(
          await update(c, creditNoteId, `${column} = ${expr}, ${PAIR}`, ['6000', carrying]),
          'P0001',
          'supplier_credit_note.immutable',
          `${column} beside the backed decrement`,
        );
      }
      expectAccepted(await update(c, creditNoteId, PAIR, ['6000', carrying]), 'the backed decrement alone (the ALLOW)');
    });
  });
});

describe('T-15 a backed decrement must be exact, backed once, and backed by THIS transaction', () => {
  it('a wrong carrying value (±1) → immutable; the exact one → admitted', async () => {
    const { creditNoteId, supplierId } = await note100();
    await inTx(async (c) => {
      const honest = await honestAllocation(c, creditNoteId, supplierId, 1000n);
      await backer(c, honest, 9000n, 3333n, creditNoteId);
      const exact = await g(c, creditNoteId, 5667n);
      for (const off of [-1n, 1n]) {
        refusedWith(
          await update(c, creditNoteId, PAIR, ['5667', (exact + off).toString()]),
          'P0001',
          'supplier_credit_note.immutable',
          `carrying off by ${off}`,
        );
      }
      refusedWith(
        await update(c, creditNoteId, PAIR, ['5666', (await g(c, creditNoteId, 5666n)).toString()]),
        'P0001',
        'supplier_credit_note.immutable',
        'c off by one',
      );
      expectAccepted(await update(c, creditNoteId, PAIR, ['5667', exact.toString()]), 'the exact decrement');
    });
  });

  it('two backers of the same decrement → immutable', async () => {
    const { creditNoteId, supplierId } = await note100();
    const other = await note100();
    await inTx(async (c) => {
      const honest = await honestAllocation(c, creditNoteId, supplierId, 1000n);
      await backer(c, honest, 9000n, 3000n, creditNoteId);
      // A refund backing the same (rb, c): a copy of an honest refund of another note, re-pointed.
      const refund = await prepareRefund(c, A, { creditNoteId: other.creditNoteId, paymentMethodId: method, consumedMinor: 1000n });
      await runS6(c, A, refund);
      const released = (await g(c, creditNoteId, 9000n)) - (await g(c, creditNoteId, 6000n));
      // The copy is written under the allocation backer's trace, as one business transaction would write both.
      await c.query(`SELECT set_config('app.business_transaction_id', $1, true)`, [honest.trace]);
      await c.query(
        `INSERT INTO supplier_refunds (tenant_id, business_id, id, supplier_id, credit_note_id, payment_method_id, posting_account_id, refund_date, reference,
                                       source_currency, source_amount_consumed_minor, source_to_base_rate, credit_remaining_before_minor,
                                       source_carrying_base_released_minor, source_dust_base_minor, receipt_currency, receipt_amount_minor,
                                       receipt_to_base_rate, receipt_base_amount_minor, rate_source, rate_timestamp, fx_rate_id, realized_fx_gain_loss_minor,
                                       intent_sha256, business_transaction_id, created_by, binding_source_id)
         SELECT tenant_id, business_id, $3, $7::uuid, $4, payment_method_id, posting_account_id, refund_date, reference,
                source_currency, 3000, source_to_base_rate, 9000,
                $5::bigint, 0, receipt_currency, 3000,
                receipt_to_base_rate, $5::bigint, rate_source, rate_timestamp, fx_rate_id, 0,
                intent_sha256, $6::uuid, created_by, $3
           FROM supplier_refunds WHERE business_id = $1 AND id = $2`,
        [A.businessId, refund.params[0], randomUUID(), creditNoteId, released.toString(), honest.trace, supplierId],
      );
      refusedWith(
        await update(c, creditNoteId, PAIR, ['6000', (await g(c, creditNoteId, 6000n)).toString()]),
        'P0001',
        'supplier_credit_note.immutable',
        'an allocation and a refund both back it',
      );
    });
  });

  it('a backer of another business transaction → immutable', async () => {
    const { creditNoteId, supplierId } = await note100();
    await inTx(async (c) => {
      const honest = await honestAllocation(c, creditNoteId, supplierId, 1000n);
      await backer(c, honest, 9000n, 3000n, creditNoteId);
      const carrying = (await g(c, creditNoteId, 6000n)).toString();
      await scratch(c, async () => {
        await c.query(`SELECT set_config('app.business_transaction_id', $1, true)`, [randomUUID()]);
        refusedWith(await update(c, creditNoteId, PAIR, ['6000', carrying]), 'P0001', 'supplier_credit_note.immutable', 'the backer is not this trace’s');
      });
      await c.query(`SELECT set_config('app.business_transaction_id', $1, true)`, [honest.trace]);
      expectAccepted(await update(c, creditNoteId, PAIR, ['6000', carrying]), 'under the backer’s own trace');
    });
  });
});

describe('T-15 daftar_app holds neither UPDATE nor DELETE', () => {
  it('no table or column privilege; an attempt is 42501', async () => {
    const r = must(
      (
        await ownerPool().query<{ u: boolean; d: boolean; ru: boolean; rc: boolean }>(
          `SELECT has_table_privilege('daftar_app', 'supplier_credit_notes', 'UPDATE') AS u,
                  has_table_privilege('daftar_app', 'supplier_credit_notes', 'DELETE') AS d,
                  has_column_privilege('daftar_app', 'supplier_credit_notes', 'remaining_amount_minor', 'UPDATE') AS ru,
                  has_column_privilege('daftar_app', 'supplier_credit_notes', 'remaining_carrying_base_amount_minor', 'UPDATE') AS rc`,
        )
      ).rows[0],
    );
    expect(r).toEqual({ u: false, d: false, ru: false, rc: false });
    const { creditNoteId } = await note100();
    await inTx(async (c) => {
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [A.tenantId, A.businessId]);
      for (const sql of [
        `UPDATE supplier_credit_notes SET remaining_amount_minor = 0 WHERE business_id = $1 AND id = $2`,
        `DELETE FROM supplier_credit_notes WHERE business_id = $1 AND id = $2`,
      ]) {
        const o = await attempt(c, async () => {
          await c.query('SET LOCAL ROLE daftar_app');
          await c.query(sql, [A.businessId, creditNoteId]);
        });
        refusedWith(o, '42501', null, sql.split(' ')[0]);
      }
    });
  });
});

describe('T-15 the one writer, supplier_credit_note_consume (R-73)', () => {
  const consume = (c: Client, creditNoteId: string, rb: bigint, consumed: bigint): Promise<Outcome<unknown>> =>
    attempt(c, () => c.query(`SELECT supplier_credit_note_consume($1::uuid, $2::bigint, $3::bigint)`, [creditNoteId, rb.toString(), consumed.toString()]));

  it('no grantee: daftar_app cannot EXECUTE it (42501)', async () => {
    const { creditNoteId } = await note100();
    await inTx(async (c) => {
      const o = await attempt(c, async () => {
        await c.query('SET LOCAL ROLE daftar_app');
        await c.query(`SELECT supplier_credit_note_consume($1::uuid, 10000, 1000)`, [creditNoteId]);
      });
      refusedWith(o, '42501', null, 'EXECUTE as daftar_app');
    });
  });

  it('with no consumed assertion, or under another operation → an assertion refusal; nothing written', async () => {
    const { creditNoteId, supplierId } = await note100();
    await inTx(async (c) => {
      const none = await consume(c, creditNoteId, 10000n, 1000n);
      expect(none.ok ? 'accepted' : none.code, 'no consumed assertion').toMatch(/^inventory\.assertion_(missing|not_consumed|wrong_operation)$/);
      const target = await receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '1', unitPriceMinor: '5000' }], { supplierId });
      await runS6(
        c,
        A,
        await preparePay(c, A, { supplierId, paymentMethodId: method, allocations: [{ purchaseId: target.purchaseId, paymentAmountMinor: 1000n }] }),
      );
      refusedWith(await consume(c, creditNoteId, 10000n, 1000n), 'P0001', 'inventory.assertion_wrong_operation', 'under supplier.pay');
      expect(await noteOf(c, A.businessId, creditNoteId)).toMatchObject({ remaining: 10000n });
    });
  });

  it('under a consumed supplier.allocate_credit: any consumption but its own row is source_type_not_authorized; a double apply is consumption_inconsistent', async () => {
    const { creditNoteId, supplierId } = await note100();
    const unrelated = await note100();
    await inTx(async (c) => {
      await honestAllocation(c, creditNoteId, supplierId, 1000n);
      expect(await noteOf(c, A.businessId, creditNoteId)).toMatchObject({ remaining: 9000n });
      for (const [what, rb, consumed] of [
        ['another amount', 9000n, 1000n],
        ['another level', 9000n, 500n],
        ['more than remains', 1000n, 2000n],
        ['zero', 10000n, 0n],
      ] as const) {
        refusedWith(await consume(c, creditNoteId, rb, consumed), 'P0001', 'inventory.source_type_not_authorized', what);
      }
      refusedWith(await consume(c, unrelated.creditNoteId, 10000n, 1000n), 'P0001', 'inventory.source_type_not_authorized', 'another note');
      refusedWith(
        await consume(c, creditNoteId, 10000n, 1000n),
        'P0001',
        'supplier_credit_note.consumption_inconsistent',
        'its own row again: the note no longer holds 100.00',
      );
      expect(await noteOf(c, A.businessId, creditNoteId), 'decremented exactly once').toMatchObject({ remaining: 9000n });
    });
  });

  it('under a consumed supplier.receive_refund: an allocation row does not back it', async () => {
    const { creditNoteId, supplierId } = await note100();
    const other = await note100();
    await inTx(async (c) => {
      const allocation = await honestAllocation(c, creditNoteId, supplierId, 1000n);
      await backer(c, allocation, 9000n, 2000n, creditNoteId);
      await runS6(c, A, await prepareRefund(c, A, { creditNoteId: other.creditNoteId, paymentMethodId: method, consumedMinor: 1000n }));
      await c.query(`SELECT set_config('app.business_transaction_id', $1, true)`, [allocation.trace]);
      refusedWith(await consume(c, creditNoteId, 9000n, 2000n), 'P0001', 'inventory.source_type_not_authorized', 'an allocation backer under receive_refund');
    });
  });

  it('catalogue: only the writer updates the note; both consumers call it after inserting their row', async () => {
    const r = await ownerPool().query<{ f: string }>(
      `SELECT p.oid::regprocedure::text AS f FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND p.prosrc ~* 'UPDATE\\s+supplier_credit_notes' ORDER BY 1`,
    );
    expect(r.rows.map((x) => x.f)).toEqual(['supplier_credit_note_consume(uuid,bigint,bigint)']);
    for (const [routine, insert] of [
      ['supplier_allocate_credit', 'INSERT INTO supplier_credit_allocations'],
      ['supplier_receive_refund', 'INSERT INTO supplier_refunds'],
    ] as const) {
      const src = must((await ownerPool().query<{ s: string }>(`SELECT prosrc AS s FROM pg_proc WHERE proname = $1`, [routine])).rows[0]).s;
      const at = src.indexOf(insert);
      const writer = src.indexOf('PERFORM supplier_credit_note_consume(');
      expect(at, `${routine} inserts its row`).toBeGreaterThan(0);
      expect(writer, `${routine} then decrements the note through the writer`).toBeGreaterThan(at);
    }
  });
});
