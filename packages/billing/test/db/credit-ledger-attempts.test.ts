/**
 * ROUND 6 — the collection attempt, executed.
 *
 * Master Continuous Mission V3 §12 adds one rule to Phase 5's provider
 * seam: an attempt is bound to a stable logical identity at the provider,
 * and after an accepted-but-lost response no attempt is created under a NEW
 * key until the first is reconciled — «لأن تفرد صف النجاح في DB لا يمنع
 * خصمًا خارجيًا ثانيًا», because the uniqueness of the success row in this
 * database does not prevent a second debit elsewhere.
 *
 * That sentence sets the honest boundary of this file. The rule itself is
 * proved in `test/collection.test.ts`, against a provider that charges and
 * then loses the connection, by COUNTING the charges: the key reused
 * collects once, a fresh key collects twice. Nothing in a database can
 * produce that difference. What is proved HERE is the second witness — that
 * the application cannot RECORD its way past an attempt it has not
 * accounted for, which is what makes the discipline survive a process that
 * restarts between the request and the answer.
 *
 * Class: `PROVEN BY EXECUTION AGAINST THE REQUESTED DDL (SCRATCH CLUSTER)`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { collectionAttemptKey } from '../../src/collection';
import { appUrl, connect, ownerUrl, pidOf, refusedBy, uuid, waitUntilBlocked } from './helpers/cluster';
import { createBusiness, createDraftInvoice, type Scope } from './helpers/finalize';

const TENANT = '7f1a0000-0000-4000-8000-000000000004';
const T1 = '2026-02-01T00:00:00.000Z';

let owner: Client;
let observer: Client;

async function freshScope(currency = 'USD'): Promise<Scope> {
  const businessId = uuid();
  await createBusiness(owner, 'p5scratch', TENANT, businessId, currency);
  return { tenantId: TENANT, businessId, currency };
}

interface AttemptOverrides {
  readonly key?: string;
  readonly outcome?: string;
  readonly code?: string | null;
  readonly amountMinor?: bigint;
}

/**
 * One attempt row, named the way `src/collection.ts` names it — unless the
 * case is about a key that is named some other way.
 */
function attemptInsert(
  c: Client,
  s: Scope,
  invoiceId: string,
  attemptNo: number,
  o: AttemptOverrides = {},
): Promise<unknown> {
  const outcome = o.outcome ?? 'unknown';
  const code = o.code === undefined ? (outcome === 'succeeded' || outcome === 'unknown' ? null : 'fake_card_declined') : o.code;
  return c.query(
    `INSERT INTO p5scratch.subscription_charge_attempts
       (id, tenant_id, business_id, invoice_id, attempt_no, idempotency_key, amount_minor, currency,
        outcome, provider, provider_ref, provider_code, attempted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'fake','fake_000001',$10,$11)`,
    [
      uuid(),
      s.tenantId,
      s.businessId,
      invoiceId,
      attemptNo,
      o.key ?? collectionAttemptKey({ invoiceId, attemptNo }),
      (o.amountMinor ?? 1000n).toString(),
      s.currency,
      outcome,
      code,
      T1,
    ],
  );
}

const failed = (c: Client, s: Scope, invoiceId: string, attemptNo: number): Promise<unknown> =>
  attemptInsert(c, s, invoiceId, attemptNo, { outcome: 'failed' });

beforeAll(async () => {
  owner = await connect(ownerUrl());
  observer = await connect(ownerUrl());
});

afterAll(async () => {
  await owner?.end();
  await observer?.end();
});

describe('the key must name the attempt it belongs to', () => {
  it('accepts the key the package derives', async () => {
    const s = await freshScope();
    const invoiceId = await createDraftInvoice(owner, 'p5scratch', s, 1000n);
    await attemptInsert(owner, s, invoiceId, 1, { outcome: 'failed' });
    const r = await owner.query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM p5scratch.subscription_charge_attempts WHERE invoice_id = $1`,
      [invoiceId],
    );
    expect(r.rows[0]?.idempotency_key).toBe(collectionAttemptKey({ invoiceId, attemptNo: 1 }));
  });

  it('refuses a freshly generated key that names nothing', async () => {
    const s = await freshScope();
    const invoiceId = await createDraftInvoice(owner, 'p5scratch', s, 1000n);
    // The defect this round is about, in its recordable form: a caller that
    // mints a UUID per call cannot write it down here at all.
    const code = await attemptInsert(owner, s, invoiceId, 1, { key: uuid(), outcome: 'failed' }).then(() => '', (e: unknown) => refusedBy(e));
    expect(code).toBe('23514/sca_key_names_attempt');
  });

  it('refuses a key that names a DIFFERENT attempt of the same invoice', async () => {
    const s = await freshScope();
    const invoiceId = await createDraftInvoice(owner, 'p5scratch', s, 1000n);
    const code = await attemptInsert(owner, s, invoiceId, 2, {
      key: collectionAttemptKey({ invoiceId, attemptNo: 1 }),
      outcome: 'failed',
    }).then(() => '', (e: unknown) => refusedBy(e));
    expect(code).toBe('23514/sca_key_names_attempt');
  });

  it('refuses the same key twice, across invoices', async () => {
    const s = await freshScope();
    const first = await createDraftInvoice(owner, 'p5scratch', s, 1000n);
    await failed(owner, s, first, 1);
    const second = await createDraftInvoice(owner, 'p5scratch', s, 1000n);
    const code = await attemptInsert(owner, s, second, 1, {
      key: collectionAttemptKey({ invoiceId: first, attemptNo: 1 }),
      outcome: 'failed',
    }).then(() => '', (e: unknown) => refusedBy(e));
    // Refused by the key's own uniqueness or by the naming CHECK — the key
    // belongs to the other invoice on both counts.
    expect(['23505/sca_key_uq', '23514/sca_key_names_attempt']).toContain(code);
  });
});

describe('no attempt while one has no verdict', () => {
  it('refuses the next attempt until the unknown one is reconciled', async () => {
    const s = await freshScope();
    const invoiceId = await createDraftInvoice(owner, 'p5scratch', s, 1000n);
    await attemptInsert(owner, s, invoiceId, 1);

    const blocked = await failed(owner, s, invoiceId, 2).then(() => '', (e: unknown) => refusedBy(e));
    expect(blocked, 'the schedule advanced past an attempt with no verdict').toBe('23000/sca_no_attempt_while_unresolved');

    // Reconciliation: the verdict the provider always had.
    await owner.query(
      `UPDATE p5scratch.subscription_charge_attempts
          SET outcome = 'failed', provider_code = 'fake_card_declined'
        WHERE invoice_id = $1 AND attempt_no = 1`,
      [invoiceId],
    );
    await failed(owner, s, invoiceId, 2);
    const r = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM p5scratch.subscription_charge_attempts WHERE invoice_id = $1`,
      [invoiceId],
    );
    expect(r.rows[0]?.n).toBe('2');
  });

  it('refuses it whatever ordinal it claims, including a repeat of the unresolved one', async () => {
    const s = await freshScope();
    const invoiceId = await createDraftInvoice(owner, 'p5scratch', s, 1000n);
    await attemptInsert(owner, s, invoiceId, 1);
    for (const attemptNo of [1, 2, 9]) {
      const code = await failed(owner, s, invoiceId, attemptNo).then(() => '', (e: unknown) => refusedBy(e));
      expect(code, `an attempt numbered ${attemptNo} was recorded while attempt 1 had no verdict`).not.toBe('');
    }
  });

  it('two racing unresolved attempts, at DIFFERENT ordinals: one commits, the other is refused', async () => {
    const s = await freshScope();
    const invoiceId = await createDraftInvoice(owner, 'p5scratch', s, 1000n);
    await failed(owner, s, invoiceId, 1);

    const a = await connect(ownerUrl());
    const b = await connect(ownerUrl());
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      const bPid = await pidOf(b);
      // DIFFERENT ordinals on purpose. The first version of this case had
      // both sessions insert attempt 1, and a mutation proved it worthless:
      // deleting the unresolved index left it green, because
      // `sca_order_uq` was refusing the duplicate ordinal all along. The
      // hazard that needs the partial index is two processes at different
      // points in the history — one retrying as attempt 2, one as attempt
      // 3 — because then nothing else in the schema objects, and the
      // merchant ends up with two outstanding requests at the provider.
      await attemptInsert(a, s, invoiceId, 2);
      const bRun = attemptInsert(b, s, invoiceId, 3).then(() => '', (e: unknown) => refusedBy(e));
      await waitUntilBlocked(observer, bPid, 'a second unresolved attempt');
      await a.query('COMMIT');
      expect(await bRun, 'two attempts awaiting a verdict for one invoice').toBe('23505/sca_one_unresolved_per_invoice');
      await b.query('ROLLBACK');
    } finally {
      await a.end();
      await b.end();
    }
    const r = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM p5scratch.subscription_charge_attempts WHERE invoice_id = $1 AND outcome = 'unknown'`,
      [invoiceId],
    );
    expect(r.rows[0]?.n).toBe('1');
  });
});

describe('an invoice is collected at most once', () => {
  it('refuses a second success', async () => {
    const s = await freshScope();
    const invoiceId = await createDraftInvoice(owner, 'p5scratch', s, 1000n);
    await attemptInsert(owner, s, invoiceId, 1, { outcome: 'succeeded' });
    const code = await attemptInsert(owner, s, invoiceId, 2, { outcome: 'succeeded' }).then(() => '', (e: unknown) => refusedBy(e));
    expect(code).toBe('23505/sca_one_success_per_invoice');
  });

  it('refuses a success recorded by reconciling a second attempt after one already succeeded', async () => {
    const s = await freshScope();
    const invoiceId = await createDraftInvoice(owner, 'p5scratch', s, 1000n);
    await attemptInsert(owner, s, invoiceId, 1, { outcome: 'succeeded' });
    await attemptInsert(owner, s, invoiceId, 2, { outcome: 'failed' });
    const code = await owner
      .query(`UPDATE p5scratch.subscription_charge_attempts SET outcome = 'succeeded' WHERE invoice_id = $1 AND attempt_no = 2`, [invoiceId])
      .then(() => '', (e: unknown) => refusedBy(e));
    // Refused because a settled attempt is immutable, before the unique
    // index is even reached. Both would refuse it; the trigger is first.
    expect(code).toBe('23000/sca_verdict_immutable');
  });
});

describe('reconciliation is the only write, and only once', () => {
  it('records the verdict and the provider’s own fields', async () => {
    const s = await freshScope();
    const invoiceId = await createDraftInvoice(owner, 'p5scratch', s, 1000n);
    await attemptInsert(owner, s, invoiceId, 1);
    await owner.query(
      `UPDATE p5scratch.subscription_charge_attempts SET outcome = 'succeeded', provider_ref = 'fake_000042' WHERE invoice_id = $1`,
      [invoiceId],
    );
    const r = await owner.query<{ outcome: string; provider_ref: string }>(
      `SELECT outcome, provider_ref FROM p5scratch.subscription_charge_attempts WHERE invoice_id = $1`,
      [invoiceId],
    );
    expect(r.rows[0]).toMatchObject({ outcome: 'succeeded', provider_ref: 'fake_000042' });
  });

  it('refuses to change the key, the amount, the ordinal or the instant', async () => {
    const s = await freshScope();
    const invoiceId = await createDraftInvoice(owner, 'p5scratch', s, 1000n);
    await attemptInsert(owner, s, invoiceId, 1);
    const mutations = [
      `idempotency_key = idempotency_key || 'x'`,
      `amount_minor = amount_minor + 1`,
      `attempt_no = attempt_no + 1`,
      `attempted_at = now()`,
    ];
    for (const mutation of mutations) {
      const code = await owner
        .query(`UPDATE p5scratch.subscription_charge_attempts SET outcome = 'failed', provider_code = 'x', ${mutation} WHERE invoice_id = $1`, [invoiceId])
        .then(() => '', (e: unknown) => refusedBy(e));
      expect(code, `reconciliation accepted: ${mutation}`).toBe('23000/sca_reconciliation_fields_only');
    }
  });

  it('refuses to put an attempt back into the unresolved state, and refuses a DELETE', async () => {
    const s = await freshScope();
    const invoiceId = await createDraftInvoice(owner, 'p5scratch', s, 1000n);
    await attemptInsert(owner, s, invoiceId, 1, { outcome: 'failed' });
    const back = await owner
      .query(`UPDATE p5scratch.subscription_charge_attempts SET outcome = 'unknown', provider_code = NULL WHERE invoice_id = $1`, [invoiceId])
      .then(() => '', (e: unknown) => refusedBy(e));
    expect(back).toBe('23000/sca_verdict_immutable');
    const deleted = await owner
      .query(`DELETE FROM p5scratch.subscription_charge_attempts WHERE invoice_id = $1`, [invoiceId])
      .then(() => '', (e: unknown) => refusedBy(e));
    expect(deleted).toBe('23000/sca_never_deleted');
  });

  it('an unresolved attempt carries no provider code, and a failed one must', async () => {
    const s = await freshScope();
    const invoiceId = await createDraftInvoice(owner, 'p5scratch', s, 1000n);
    // §7's original CHECK demanded a code for everything but a success,
    // which would have forced a fabricated code onto the one outcome that
    // has none to report.
    await attemptInsert(owner, s, invoiceId, 1, { outcome: 'unknown', code: null });
    const second = await createDraftInvoice(owner, 'p5scratch', s, 1000n);
    const code = await attemptInsert(owner, s, second, 1, { outcome: 'failed', code: null }).then(() => '', (e: unknown) => refusedBy(e));
    expect(code).toBe('23514/sca_code_present');
  });
});

describe('the application role can do exactly this and no more', () => {
  it('records an attempt and reconciles it under RLS, and deletes nothing', async () => {
    const s = await freshScope();
    const invoiceId = await createDraftInvoice(owner, 'p5scratch', s, 1000n);
    const app = await connect(appUrl());
    try {
      await app.query(`SELECT set_config('app.business_id', $1, false)`, [s.businessId]);
      await attemptInsert(app, s, invoiceId, 1);
      await app.query(`UPDATE p5scratch.subscription_charge_attempts SET outcome = 'declined', provider_code = 'fake_card_declined' WHERE invoice_id = $1`, [invoiceId]);
      const r = await app.query<{ outcome: string }>(`SELECT outcome FROM p5scratch.subscription_charge_attempts WHERE invoice_id = $1`, [invoiceId]);
      expect(r.rows[0]?.outcome).toBe('declined');
      const deleted = await app
        .query(`DELETE FROM p5scratch.subscription_charge_attempts WHERE invoice_id = $1`, [invoiceId])
        .then(() => '', (e: unknown) => refusedBy(e));
      // ROUND 10, F-11: the measured answer is the PRIVILEGE refusal, not
      // the trigger's. The application role has no DELETE on the relation,
      // so `42501` is reported before `sca_never_deleted` can be reached —
      // and 42501 is raised by nothing else here, so it is named by the
      // class alone. The trigger's own refusal is proved on the owner's
      // connection in the case above.
      expect(deleted).toBe('42501');
    } finally {
      await app.end();
    }
  });

  it('cannot see or touch another business’s attempts', async () => {
    const mine = await freshScope();
    const theirs = await freshScope();
    const theirInvoice = await createDraftInvoice(owner, 'p5scratch', theirs, 1000n);
    await attemptInsert(owner, theirs, theirInvoice, 1, { outcome: 'failed' });
    const app = await connect(appUrl());
    try {
      await app.query(`SELECT set_config('app.business_id', $1, false)`, [mine.businessId]);
      const seen = await app.query<{ n: string }>(`SELECT count(*)::text AS n FROM p5scratch.subscription_charge_attempts WHERE invoice_id = $1`, [theirInvoice]);
      expect(seen.rows[0]?.n, 'another business’s attempt was visible').toBe('0');
      const wrote = await attemptInsert(app, theirs, theirInvoice, 2).then(() => '', (e: unknown) => refusedBy(e));
      // 42501 is the RLS WITH CHECK refusal: the row names a business the
      // session is not scoped to, so the policy rejects it before any
      // uniqueness or trigger is reached.
      expect(wrote, 'the role wrote an attempt for another business').toBe('42501');
    } finally {
      await app.end();
    }
  });
});
