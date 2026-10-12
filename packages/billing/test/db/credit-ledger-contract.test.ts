/**
 * ROUND 6 — the Contract Diff on `subscription_invoices`, settled and pinned.
 *
 * Master Continuous Mission V3 §12: «قبل الترقية احسم Contract Diff بين
 * حالات `subscription_invoices` وحقولها الثابتة في الـspec القديم، ومسار
 * draft→finalized الذي يطبق الرصيد والـpayable، وDDL scratch» — before
 * promotion, settle the Contract Diff between the invoice's states and fixed
 * fields in the earlier spec, the draft→finalized path that applies the
 * credit and the payable, and the scratch DDL.
 *
 * It needed settling because the two documents had grown two vocabularies
 * for one relation, and — worse — both used `total_minor`, for amounts that
 * differ by exactly the credit applied. `src/invoice-states.ts` records what
 * was settled and why. THIS file is what stops it drifting again: every
 * assertion below reads the DDL out of the live catalogue, or attacks it,
 * and compares against the exported constants. Nothing here retypes the
 * contract and then checks its own copy — the defect round 5's M10 was.
 *
 * Class, as everywhere in `test/db/`:
 * `PROVEN BY EXECUTION AGAINST THE REQUESTED DDL (SCRATCH CLUSTER)`. The
 * official schema and command are still `WAITING_FOR_INTEGRATED_SURFACE`,
 * and V3 keeps that proof at integration.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { connect, ownerUrl, sqlstate, uuid } from './helpers/cluster';
import { createDraftInvoice, type Scope } from './helpers/finalize';
import {
  canTransitionInvoice,
  FINALIZATION_WRITABLE_COLUMNS,
  SUBSCRIPTION_INVOICE_STATES,
  type SubscriptionInvoiceState,
} from '../../src/invoice-states';

const TENANT = '7f1a0000-0000-4000-8000-000000000003';
const T1 = '2026-02-01T00:00:00.000Z';

let owner: Client;

async function freshScope(currency = 'USD'): Promise<Scope> {
  const businessId = uuid();
  await owner.query(`INSERT INTO p5scratch.businesses (tenant_id, id) VALUES ($1, $2)`, [TENANT, businessId]);
  return { tenantId: TENANT, businessId, currency };
}

/** One constraint's definition, as the catalogue holds it. */
async function constraintDef(name: string): Promise<string> {
  const r = await owner.query<{ def: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'p5scratch' AND t.relname = 'subscription_invoices' AND c.conname = $1`,
    [name],
  );
  const def = r.rows[0]?.def;
  expect(def, `the constraint ${name} is not in the catalogue — this file would otherwise prove nothing`).toBeTruthy();
  return def ?? '';
}

/** The columns the relation actually has, discovered rather than listed. */
async function columnsOf(): Promise<readonly string[]> {
  const r = await owner.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'p5scratch' AND table_name = 'subscription_invoices'
      ORDER BY ordinal_position`,
  );
  return r.rows.map((row) => row.column_name);
}

/** A row sitting in `state`, built only by transitions the contract allows. */
async function invoiceIn(state: SubscriptionInvoiceState, s: Scope): Promise<string> {
  const id = await createDraftInvoice(owner, 'p5scratch', s, 1000n);
  if (state === 'draft') return id;
  if (state === 'voided') {
    await owner.query(`UPDATE p5scratch.subscription_invoices SET state = 'voided' WHERE id = $1`, [id]);
    return id;
  }
  await owner.query(`UPDATE p5scratch.subscription_invoices SET state = 'open', issued_at = $2 WHERE id = $1`, [id, T1]);
  if (state === 'open') return id;
  await owner.query(`UPDATE p5scratch.subscription_invoices SET state = $2 WHERE id = $1`, [id, state]);
  return id;
}

beforeAll(async () => {
  owner = await connect(ownerUrl());
});

afterAll(async () => {
  await owner?.end();
});

describe('the state set the database enforces is the state set the package exports', () => {
  it('names exactly the five settled states', async () => {
    const def = await constraintDef('si_state_known');
    const named = [...def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(named.length, 'the state extraction came back empty or short').toBe(SUBSCRIPTION_INVOICE_STATES.length);
    expect([...named].sort()).toStrictEqual([...SUBSCRIPTION_INVOICE_STATES].sort());
  });

  it('does not name `finalized`, in the database either', async () => {
    const def = await constraintDef('si_state_known');
    expect(def).not.toContain('finalized');
  });

  it('refuses a state outside the set', async () => {
    const s = await freshScope();
    const id = await createDraftInvoice(owner, 'p5scratch', s, 1000n);
    const code = await owner
      .query(`UPDATE p5scratch.subscription_invoices SET state = 'finalized' WHERE id = $1`, [id])
      .then(() => '', (e: unknown) => sqlstate(e));
    // 23514 is the CHECK; 23000 would be the trigger. Either refuses, and
    // the assertion names both rather than pretending to know which fires
    // first — but it must not be empty.
    expect(['23514', '23000']).toContain(code);
  });
});

describe('the money vocabulary the Contract Diff settled', () => {
  it('is the spec’s four columns, and the database has them all', async () => {
    const columns = await columnsOf();
    for (const column of ['charge_minor', 'credit_minor', 'tax_minor', 'total_minor']) {
      expect(columns, `${column} is missing from the realized relation`).toContain(column);
    }
    // Round 5's names are gone: a relation that still carried
    // `payable_minor` beside `total_minor` would be the diff, not its
    // resolution.
    expect(columns).not.toContain('payable_minor');
    expect(columns).not.toContain('credit_applied_minor');
  });

  it('makes the total the spec’s arithmetic, and refuses anything else', async () => {
    const def = await constraintDef('si_total_is_charge_minus_credit');
    expect(def.replace(/[\s()]/g, '')).toContain('total_minor=charge_minor-credit_minor+tax_minor');

    const s = await freshScope();
    const code = await owner
      .query(
        `INSERT INTO p5scratch.subscription_invoices
           (id, tenant_id, business_id, period_index, currency, charge_minor, credit_minor, total_minor, state)
         VALUES ($1,$2,$3,nextval('p5scratch.scratch_period_seq')::integer,'USD',1000,300,900,'draft')`,
        [uuid(), s.tenantId, s.businessId],
      )
      .then(() => '', (e: unknown) => sqlstate(e));
    expect(code, 'the database accepted a total that is not charge minus credit').toBe('23514');
  });

  it('keeps platform tax structurally unrepresentable rather than defaulted', async () => {
    const s = await freshScope();
    const code = await owner
      .query(
        `INSERT INTO p5scratch.subscription_invoices
           (id, tenant_id, business_id, period_index, currency, charge_minor, credit_minor, tax_minor, total_minor, state)
         VALUES ($1,$2,$3,nextval('p5scratch.scratch_period_seq')::integer,'USD',1000,0,1,1001,'draft')`,
        [uuid(), s.tenantId, s.businessId],
      )
      .then(() => '', (e: unknown) => sqlstate(e));
    expect(code).toBe('23514');
  });

  it('allows one invoice per business per period, and no second', async () => {
    const s = await freshScope();
    await createDraftInvoice(owner, 'p5scratch', s, 1000n, 7);
    const code = await createDraftInvoice(owner, 'p5scratch', s, 1000n, 7).then(() => '', (e: unknown) => sqlstate(e));
    expect(code, 'a second invoice for one period is the double renewal the unique index exists to refuse').toBe('23505');
  });
});

describe('the transitions the database allows are the transitions the package allows', () => {
  it('agrees on all twenty-five pairs', async () => {
    const s = await freshScope();
    const disagreements: string[] = [];
    for (const from of SUBSCRIPTION_INVOICE_STATES) {
      const id = await invoiceIn(from, s);
      for (const to of SUBSCRIPTION_INVOICE_STATES) {
        await owner.query('BEGIN');
        // `issued_at` is written ONLY for `-> open`, which must carry one.
        // Writing it for every target was this case's first version, and it
        // reported `draft -> voided` as refused — by its own fixture, since
        // an abandoned draft was never issued and the trigger refuses to
        // give it an instant. A law that mutates more than the transition
        // it is testing measures its own mutation.
        const code = await owner
          .query(
            `UPDATE p5scratch.subscription_invoices
                SET state = $2,
                    issued_at = CASE WHEN $2 = 'open' THEN coalesce(issued_at, $3::timestamptz) ELSE issued_at END
              WHERE id = $1`,
            [id, to, T1],
          )
          .then(() => '', (e: unknown) => sqlstate(e));
        await owner.query('ROLLBACK');
        const dbAllows = code === '';
        if (dbAllows !== canTransitionInvoice(from, to)) {
          disagreements.push(`${from}->${to}: database ${dbAllows ? 'allows' : `refuses (${code})`}, package ${canTransitionInvoice(from, to) ? 'allows' : 'refuses'}`);
        }
      }
    }
    expect(disagreements, 'the database and the package disagree about the invoice lifecycle').toStrictEqual([]);
  });

  it('refuses a DELETE in every state', async () => {
    const s = await freshScope();
    for (const state of SUBSCRIPTION_INVOICE_STATES) {
      const id = await invoiceIn(state, s);
      const code = await owner
        .query(`DELETE FROM p5scratch.subscription_invoices WHERE id = $1`, [id])
        .then(() => '', (e: unknown) => sqlstate(e));
      expect(code, `a ${state} invoice was deleted`).toBe('23000');
    }
  });
});

describe('what finalization may write, and nothing else', () => {
  it('refuses the finalization when it also changes a column fixed at composition', async () => {
    const s = await freshScope();
    const columns = await columnsOf();
    const fixed = columns.filter((column) => !FINALIZATION_WRITABLE_COLUMNS.includes(column));
    // Discovered from the relation rather than listed here: a law that
    // enumerates its own subjects stops seeing the column somebody adds.
    expect(fixed.length, 'the fixed-column set came back empty').toBeGreaterThan(4);

    // Each mutation is otherwise LEGAL: the arithmetic stays consistent,
    // the sibling business exists in the same tenant, the period is free.
    // That matters more than it looks. The first version of this case wrote
    // `charge_minor + 1` and left the total alone, so the arithmetic CHECK
    // refused it and the trigger was never consulted — a mutation that
    // deleted the trigger's charge clause left the case green. A law that
    // only ever fires behind another defence has measured the other
    // defence.
    const sibling = await freshScope();
    const values: Readonly<Record<string, string>> = {
      id: `'${uuid()}'::uuid`,
      tenant_id: `'${uuid()}'::uuid`,
      business_id: `'${sibling.businessId}'::uuid`,
      period_index: `period_index + 1000`,
      currency: `'EUR'`,
      charge_minor: `1001`,
      tax_minor: `tax_minor + 0`,
    };

    const survived: string[] = [];
    const refusedByTrigger: string[] = [];
    for (const column of fixed) {
      const mutation = values[column];
      expect(mutation, `no mutation is defined for the fixed column ${column} — the case would silently skip it`).toBeTruthy();
      if (column === 'tax_minor') {
        // `tax_minor` cannot be moved at all: the structural-zero CHECK
        // makes any other value unrepresentable, so the trigger's clause
        // for it can never be the thing that refuses, and this case does
        // not claim to prove it.
        continue;
      }
      const id = await createDraftInvoice(owner, 'p5scratch', s, 1000n);
      const total = column === 'charge_minor' ? 601 : 600;
      await owner.query('BEGIN');
      const code = await owner
        .query(
          `UPDATE p5scratch.subscription_invoices
              SET state = 'open', issued_at = $2, credit_minor = 400, total_minor = ${total}, ${column} = ${mutation}
            WHERE id = $1`,
          [id, T1],
        )
        .then(() => '', (e: unknown) => sqlstate(e));
      await owner.query('ROLLBACK');
      if (code === '') survived.push(column);
      if (code === '23000') refusedByTrigger.push(column);
    }
    expect(survived, 'a column fixed at composition was changed by a finalization').toStrictEqual([]);
    // And it is the CONTRACT's trigger that refuses every one of them, not
    // an accident of some other constraint. `tenant_id` is in the list too,
    // which is worth knowing: a BEFORE trigger runs before the ownership
    // FK is evaluated, so the trigger — not the FK — is what reports it.
    expect(refusedByTrigger.sort()).toStrictEqual(['business_id', 'charge_minor', 'currency', 'id', 'period_index', 'tenant_id'].sort());
  });

  it('permits the finalization that writes only the credit, the total and the instant', async () => {
    const s = await freshScope();
    const id = await createDraftInvoice(owner, 'p5scratch', s, 1000n);
    // Inside a transaction that is rolled back, because this case is about
    // the BEFORE trigger and nothing else: the credit it writes has no
    // consumption rows behind it, and the DEFERRED agreement constraint
    // would rightly refuse it at COMMIT. That constraint is proved in
    // `credit-ledger-atomicity.test.ts`; proving it again here by letting
    // this case fail on it would mean proving neither.
    await owner.query('BEGIN');
    await owner.query(
      `UPDATE p5scratch.subscription_invoices SET state = 'open', issued_at = $2, credit_minor = 400, total_minor = 600 WHERE id = $1`,
      [id, T1],
    );
    const r = await owner.query<{ state: string; credit_minor: string; total_minor: string }>(
      `SELECT state, credit_minor::text, total_minor::text FROM p5scratch.subscription_invoices WHERE id = $1`,
      [id],
    );
    expect(r.rows[0]).toMatchObject({ state: 'open', credit_minor: '400', total_minor: '600' });
    await owner.query('ROLLBACK');
  });

  it('freezes the credit and the total once the invoice is past draft', async () => {
    const s = await freshScope();
    const id = await invoiceIn('open', s);
    for (const mutation of ['credit_minor = 1, total_minor = 999', 'issued_at = now()']) {
      const code = await owner
        .query(`UPDATE p5scratch.subscription_invoices SET state = 'paid', ${mutation} WHERE id = $1`, [id])
        .then(() => '', (e: unknown) => sqlstate(e));
      expect(code, `a settled invoice accepted: ${mutation}`).toBe('23000');
    }
  });
});
