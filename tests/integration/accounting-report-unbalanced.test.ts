/**
 * THE INCIDENT DRILL (P2-S7 §23, §51).
 *
 * A whole-business trial balance that does not balance is not a report; it
 * is evidence that the journal has been damaged. The rule is that the server
 * REFUSES rather than renders, because a rendered unbalanced trial balance
 * gets pasted into a tax return.
 *
 * Proving the refusal needs damage, and the database is built specifically to
 * make that impossible: `journal_entry_validate` and `journal_line_validate`
 * are deferred constraint triggers owned by `daftar_accounting_internal`, so
 * no application role can write an entry whose debits and credits differ.
 *
 * So this suite breaks the journal the way a real incident would — OUT OF
 * BAND, as the database owner, with replication-role suppression, the same
 * door a mistaken restore or a hand-run UPDATE comes through. Nothing is
 * added to the product to make the state reachable: no test flag, no
 * "allowUnbalanced" option, no widened role. §51 asks for the defense to be
 * proven, not for the defense to be given a bypass to be proven against.
 *
 * The damage is repaired at the end of the case, and the same report is
 * asserted to come back. A defense that latched would be its own outage.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ownerPool, resetData, uniqueEmail, type TestApp } from '../helpers/test-app';
import { fingerprintOf, must, postAdjustmentAs, sourceAssertion, todayIn, type PostCommand, type PostLine } from '../helpers/accounting-posting';

let t: TestApp;
const unique = (): string => `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

interface Owner {
  token: string;
  userId: string;
  businessId: string;
  tenantId: string;
}

let o: Owner;
let today: string;
let damagedLine: { businessId: string; journalEntryId: string; lineNo: number };

const auth = () => ({ Authorization: `Bearer ${o.token}`, 'X-Business-Id': o.businessId });

function line(systemKey: string, side: 'D' | 'C', amount: bigint): PostLine {
  return {
    account: { kind: 'system', systemKey },
    side,
    baseAmountMinor: amount,
    baseCurrency: 'ILS',
    txnAmountMinor: amount,
    txnCurrency: 'ILS',
    fxRate: '1',
    fxRateSource: 'base',
    fxRateAt: new Date('2026-03-14T09:15:00Z'),
    branchId: null,
    warehouseId: null,
  };
}

beforeAll(async () => {
  await resetData();
  t = await createTestApp();

  const reg = await t.request
    .post('/v1/auth/register')
    .send({ email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: 'Owner', preferredLocale: 'ar' });
  const token = reg.body.accessToken as string;
  const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${token}`);
  const on = await t.request
    .post('/v1/onboarding/complete')
    .set('Idempotency-Key', `idem-${unique()}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ businessName: 'Incident Biz', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `inc-${unique()}`.slice(0, 60) });
  expect(on.status).toBe(201);
  const businessId = on.body.businessId as string;
  const tenantId = must((await ownerPool().query<{ tenant_id: string }>(`SELECT tenant_id FROM businesses WHERE id = $1`, [businessId])).rows[0]).tenant_id;
  o = { token, userId: me.body.userId as string, businessId, tenantId };
  today = await todayIn(ownerPool(), 'Asia/Hebron');

  const c: PostCommand = {
    tenantId,
    businessId,
    sourceType: 'manual_adjustment',
    sourceId: randomUUID(),
    entryDate: today,
    description: 'a sound fact, before the damage',
    requestId: 'req-incident',
    lines: [line('cash', 'D', 70_000n), line('sales_revenue', 'C', 70_000n)],
  };
  const assertion = sourceAssertion({
    actorUserId: o.userId,
    tenantId,
    businessId,
    operationKind: 'post',
    sourceType: 'manual_adjustment',
    sourceId: c.sourceId,
    postingFingerprint: fingerprintOf(c),
  });
  const posted = await postAdjustmentAs(assertion, c, 'because the merchant said so');
  damagedLine = { businessId, journalEntryId: posted.entryId, lineNo: 1 };
}, 300_000);

afterAll(async () => {
  if (t !== undefined) await t.close();
});

/**
 * The out-of-band writer. `session_replication_role = replica` suppresses the
 * validating constraint triggers for this connection only, which is exactly
 * what a restore or a DBA's session does, and is available to nobody the
 * application authenticates as.
 */
async function outOfBand(sql: string, params: readonly unknown[]): Promise<void> {
  const client = await ownerPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL session_replication_role = 'replica'`);
    await client.query(sql, [...params]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

const trialBalance = () => t.request.get(`/v1/businesses/${o.businessId}/accounting/trial-balance`).query({ asOf: today }).set(auth());

describe('a damaged journal is refused, not rendered (§23, §51)', () => {
  it('the sound journal reports normally first, so the refusal below is about the damage', async () => {
    const res = await trialBalance();
    expect(res.status).toBe(200);
    expect(res.body.isBalanced).toBe(true);
    expect(res.body.totalDebitMinor).toBe('70000');
    expect(res.body.totalCreditMinor).toBe('70000');
  });

  it('the journal itself refuses the damage through every ordinary route', async () => {
    // The damage below is only reachable out of band. Through an ordinary
    // connection — the one the API uses — the same UPDATE never lands: a
    // posted line is immutable, so the corruption the rest of this suite
    // reasons about cannot be produced by anything the product can do.
    await expect(
      ownerPool().query(
        `UPDATE journal_lines
            SET debit_minor = debit_minor + 1, base_amount_minor = base_amount_minor + 1, txn_amount_minor = txn_amount_minor + 1
         WHERE business_id = $1 AND journal_entry_id = $2 AND line_no = $3`,
        [damagedLine.businessId, damagedLine.journalEntryId, damagedLine.lineNo],
      ),
    ).rejects.toThrow(/accounting\.journal_immutable/);
  });

  it('once the journal is damaged, the whole-business trial balance refuses', async () => {
    await outOfBand(
      `UPDATE journal_lines
            SET debit_minor = debit_minor + 1, base_amount_minor = base_amount_minor + 1, txn_amount_minor = txn_amount_minor + 1
         WHERE business_id = $1 AND journal_entry_id = $2 AND line_no = $3`,
      [damagedLine.businessId, damagedLine.journalEntryId, damagedLine.lineNo],
    );

    const res = await trialBalance();
    expect(res.status).toBe(409);
    expect(res.body.error.details.code).toBe('accounting.report_unbalanced');
  });

  /**
   * §56. The refusal names the condition and nothing else. A message
   * carrying "debits 70001, credits 70000" would publish the merchant's
   * turnover to anyone who could provoke the error.
   */
  it('the refusal carries no amount, no total and no difference', async () => {
    const res = await trialBalance();
    // A correlation id and the caller's own business id are not facts about
    // the books; everything else in the refusal is held to the rule.
    const body = JSON.stringify(res.body)
      .replace(/"requestId":"[^"]*"/, '')
      .replace(/"businessId":"[^"]*"/, '');
    expect(body).not.toMatch(/70000|70001/);
    expect(body).not.toMatch(/\d{3,}/);
  });

  /**
   * A branch-dimensional report is NOT subject to the whole-business
   * assertion (§24), so it still answers — which is the correct behaviour
   * and also the reason the assertion has to be scoped rather than global.
   */
  it('the refusal is scoped to the whole-business report, not to every read', async () => {
    const entries = await t.request.get(`/v1/businesses/${o.businessId}/accounting/entries`).set(auth());
    expect(entries.status).toBe(200);
    const detail = await t.request.get(`/v1/businesses/${o.businessId}/accounting/entries/${damagedLine.journalEntryId}`).set(auth());
    expect(detail.status).toBe(200);
  });

  it('repairing the journal restores the report; the defense does not latch', async () => {
    await outOfBand(
      `UPDATE journal_lines
            SET debit_minor = debit_minor - 1, base_amount_minor = base_amount_minor - 1, txn_amount_minor = txn_amount_minor - 1
         WHERE business_id = $1 AND journal_entry_id = $2 AND line_no = $3`,
      [damagedLine.businessId, damagedLine.journalEntryId, damagedLine.lineNo],
    );
    const res = await trialBalance();
    expect(res.status).toBe(200);
    expect(res.body.isBalanced).toBe(true);
    expect(res.body.totalDebitMinor).toBe('70000');
  });
});
