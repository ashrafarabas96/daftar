/**
 * DR-97 §3 CRITERION 5 — THE WRITE-OFF ROW, AGAINST A REAL LEDGER IN CI.
 *
 * Criterion 5 asks for the audit record's five fields ON A REAL ROW, measured
 * in CI and not locally. This file does not deliver that. It measures, on a
 * real cluster, WHY it cannot be delivered yet — so that the card's "open"
 * stops being a sentence I wrote and becomes a refusal Postgres issues, with
 * its SQLSTATE and its constraint named.
 *
 * The collision, which `packages/billing/src/credit-write-off.ts:57` already
 * states in prose:
 *
 *     CONSTRAINT pca_consumption_invoice
 *       CHECK ((kind = 'consumption') = (invoice_id IS NOT NULL))
 *
 * The command writes ONE `consumption` per drawn-down grant and names no
 * invoice, because a write-off has none. The ledger's own invariant then
 * refuses the row. That invariant is not weakened here, and no third `kind`
 * is invented and no synthetic invoice fabricated: all three are money-model
 * decisions, and they are the owner's (charter 9/second), carded with numbers.
 *
 * What this file is therefore allowed to prove is the shape of the block, and
 * each of the four cases below exists to stop one way of getting that shape
 * wrong:
 *
 *   1. the write-off row as the command would emit it IS refused, by
 *      `pca_consumption_invoice`, with SQLSTATE 23514;
 *   2. POSITIVE CONTROL — the same row WITH an invoice is ACCEPTED, so case 1
 *      measures the missing invoice and not a broken fixture, a policy, a
 *      privilege, or a chronology trigger;
 *   3. the OTHER invariant on the same column pair refuses with a DIFFERENT
 *      constraint name, so case 1's attribution is measured and not assumed —
 *      two refusals that read alike would make case 1 unfalsifiable;
 *   4. after all of it, ZERO rows in the ledger carry the write-off's
 *      `source_ref`, with a positive control that the same probe DOES find
 *      the row case 2 accepted. So "criterion 5 is open" is a measured count,
 *      not a claim.
 *
 * NOT_RUN does not count (DR-95 item 5). This file needs a real Postgres, so
 * it runs in CI's `backend` job after the fresh migrate, and nothing here is
 * measurable on the Windows host.
 *
 * WHAT CI TAUGHT THIS FILE, AND IT WAS MY DEFECT, NOT THE LEDGER'S. On run
 * 43370481243 the positive control below (case 2) was REFUSED, and so its
 * dependent counter (case 4) failed with it:
 *
 *     invoice <id> claims 0 of applied credit but its consumption rows sum
 *     to 5000                       -- si_credit_agrees_with_ledger
 *
 * I had read that refusal, before measuring it, as the ledger's `invoice_id`
 * invariant. It is a DIFFERENT and stricter one, and the two facts that make
 * it are both in `0088` where I could have read them first:
 *
 *   - `si_credit_agrees_trg` and `pca_credit_agrees_trg` are CONSTRAINT
 *     triggers, `DEFERRABLE INITIALLY DEFERRED` ⇒ they fire at COMMIT, not at
 *     the statement. Each autocommitted INSERT was therefore its own
 *     transaction, and at its commit the invoice still claimed 0 credit while
 *     the consumption summed to 5000. An invoice and the consumption that
 *     draws it down MUST be written in ONE transaction.
 *   - `si_immutable()` lets `credit_minor` be written only on the
 *     `draft -> open` transition (any later state change must leave credit and
 *     total untouched) ⇒ the invoice is therefore seeded as a DRAFT, and case 2
 *     opens it and inserts its consumption together.
 *
 * So the fixture is what changed, and no invariant was weakened to make a case
 * pass: `si_credit_within_charge` and `si_total_is_charge_minus_credit` are
 * both satisfied exactly (charge 6000, credit 5000, total 1000), and the two
 * refusals this file is about (cases 1 and 3) are immediate CHECKs that passed
 * on that same run and are untouched.
 */
import { randomUUID } from 'node:crypto';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ensurePostgres, dbUrl } from '../helpers/test-app';

const CURRENCY = 'JOD';
const GRANT_MINOR = 5000;
/** The one marker every row this file writes or attempts carries. */
const SOURCE_REF = 'dr97/write-off/criterion-5';

interface Fixture {
  readonly tenantId: string;
  readonly businessId: string;
  readonly invoiceId: string;
  readonly grantId: string;
}

interface Refusal {
  readonly code: string;
  readonly message: string;
}

let fixture: Fixture | undefined;

/**
 * The refusal of one statement, or a throw if it was not refused.
 *
 * A statement that succeeds where this file expects a refusal must fail the
 * case loudly; returning "no refusal" would let a weakened constraint read as
 * a pass.
 */
async function refusalOf(c: Client, sql: string, params: readonly unknown[]): Promise<Refusal> {
  try {
    const r = await c.query(sql, [...params]);
    throw new Error(`the statement was NOT refused (rowCount=${String(r.rowCount)}): ${sql}`);
  } catch (e) {
    const err = e as { code?: unknown; message?: unknown };
    if (typeof err.code !== 'string') throw e;
    return { code: err.code, message: typeof err.message === 'string' ? err.message : '' };
  }
}

/** A connection with the two GUCs the ledger's triggers and policies read. */
async function scoped(f: Fixture): Promise<Client> {
  const c = new Client({ connectionString: dbUrl });
  await c.connect();
  await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [f.tenantId]);
  await c.query(`SELECT set_config('app.business_id', $1, false)`, [f.businessId]);
  return c;
}

/**
 * One tenant, one business, one open invoice, one grant.
 *
 * The two GUCs are set BEFORE the grant insert because
 * `pca_maintain_remainder()` writes the remainder row under the tenant-isolated
 * insert policy, and `assert_invoice_credit_agrees()` fails closed for a
 * caller whose context does not own the invoice.
 */
async function seed(): Promise<Fixture> {
  const c = new Client({ connectionString: dbUrl });
  await c.connect();
  try {
    const tenantId = (await c.query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id::text AS id`)).rows[0]?.id;
    if (tenantId === undefined) throw new Error('no tenant was created');
    await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]);

    const businessId = (
      await c.query<{ id: string }>(
        `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
         VALUES ($1, 'DR97 criterion 5', $2, 'JO', $3, 'Asia/Amman') RETURNING id::text AS id`,
        [tenantId, `dr97-c5-${randomUUID().slice(0, 8)}`, CURRENCY],
      )
    ).rows[0]?.id;
    if (businessId === undefined) throw new Error('no business was created');
    await c.query(`SELECT set_config('app.business_id', $1, false)`, [businessId]);

    // A DRAFT, charged above the grant: `credit_minor` may only be written on
    // the `draft -> open` transition (`si_immutable`), and it may not exceed
    // the charge (`si_credit_within_charge`). Case 2 does both halves in one
    // transaction, because the agreement triggers are deferred to commit.
    const invoiceId = randomUUID();
    await c.query(
      `INSERT INTO public.subscription_invoices
         (id, tenant_id, business_id, period_index, currency, charge_minor, credit_minor, tax_minor, total_minor, state, issued_at)
       VALUES ($1, $2, $3, 0, $4, 6000, 0, 0, 6000, 'draft', NULL)`,
      [invoiceId, tenantId, businessId, CURRENCY],
    );

    const grantId = randomUUID();
    await c.query(
      `INSERT INTO public.platform_credit_adjustments
         (id, tenant_id, business_id, kind, amount_minor, currency, occurred_at, source_ref, reason)
       VALUES ($1, $2, $3, 'grant', $4, $5, now(), $6, 'DR-97 criterion 5 fixture: the grant a write-off would draw down')`,
      [grantId, tenantId, businessId, GRANT_MINOR.toString(), CURRENCY, SOURCE_REF],
    );

    return { tenantId, businessId, invoiceId, grantId };
  } finally {
    await c.end();
  }
}

function fx(): Fixture {
  if (fixture === undefined) throw new Error('the fixture was not built, so no case below would measure anything');
  return fixture;
}

/**
 * The insert the command's output asks for, parameterised on the two columns
 * the invariants pair. One statement for all four cases: a case that wrote its
 * own SQL could differ from the others in a way that explains its result.
 */
const CONSUMPTION_INSERT = `
  INSERT INTO public.platform_credit_adjustments
    (id, tenant_id, business_id, kind, amount_minor, currency, occurred_at, source_ref, reason,
     applies_to_grant_id, invoice_id)
  VALUES ($1, $2, $3, 'consumption', $4, $5, now() + interval '1 second', $6, $7, $8, $9)
`;

describe('DR-97 criterion 5 — the write-off row against the live ledger', () => {
  beforeAll(async () => {
    await ensurePostgres();
    fixture = await seed();
  }, 120_000);

  afterAll(() => {
    fixture = undefined;
  });

  it('the write-off row, exactly as the command emits it, is refused by pca_consumption_invoice', async () => {
    const f = fx();
    const c = await scoped(f);
    try {
      const r = await refusalOf(c, CONSUMPTION_INSERT, [
        randomUUID(),
        f.tenantId,
        f.businessId,
        GRANT_MINOR.toString(),
        CURRENCY,
        SOURCE_REF,
        'cancel the stranded balance: the subscription moved currency',
        f.grantId,
        null, // a write-off names no invoice — this is the whole collision
      ]);
      expect(r.code, `the refusal is not a check violation: ${r.code} ${r.message}`).toBe('23514');
      expect(r.message, `the refusal does not name the constraint this card is blocked on: ${r.message}`).toContain('pca_consumption_invoice');
    } finally {
      await c.end();
    }
  }, 60_000);

  it('POSITIVE CONTROL: the same row WITH an invoice is accepted, so the case above measures the missing invoice', async () => {
    const f = fx();
    const c = await scoped(f);
    try {
      // ONE transaction, because `si_credit_agrees_trg` and
      // `pca_credit_agrees_trg` are deferred to COMMIT: the invoice's claimed
      // credit and the consumption that draws it down have to agree AT THAT
      // POINT, and two autocommitted statements can never agree at either of
      // their commits.
      await c.query('BEGIN');
      const opened = await c.query(
        `UPDATE public.subscription_invoices
            SET state = 'open', issued_at = now(), credit_minor = $2::bigint, total_minor = charge_minor - $2::bigint
          WHERE id = $1 AND state = 'draft'`,
        [f.invoiceId, GRANT_MINOR.toString()],
      );
      expect(opened.rowCount, 'the draft invoice could not be opened with its credit, so case 2 would measure the fixture and not the ledger').toBe(1);

      const r = await c.query(CONSUMPTION_INSERT, [
        randomUUID(),
        f.tenantId,
        f.businessId,
        GRANT_MINOR.toString(),
        CURRENCY,
        SOURCE_REF,
        'the control: a consumption that names its invoice',
        f.grantId,
        f.invoiceId,
      ]);
      expect(r.rowCount, 'the fixture cannot insert a consumption AT ALL, so the refusal above was not about the invoice').toBe(1);

      // The commit is the measurement: every deferred invariant on both rows
      // runs here, so a green case 2 means the ledger ACCEPTED the pair and
      // not merely that two statements returned.
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      await c.end();
    }
  }, 60_000);

  it('the other invariant on the same pair refuses with a DIFFERENT name, so the attribution above is measured', async () => {
    const f = fx();
    const c = await scoped(f);
    try {
      const r = await refusalOf(c, CONSUMPTION_INSERT, [
        randomUUID(),
        f.tenantId,
        f.businessId,
        GRANT_MINOR.toString(),
        CURRENCY,
        SOURCE_REF,
        'a consumption that draws nothing',
        null, // no grant named
        f.invoiceId,
      ]);
      expect(r.code).toBe('23514');
      expect(r.message, `this refusal does not name pca_kind_names_grant: ${r.message}`).toContain('pca_kind_names_grant');
      expect(r.message, 'the two invariants are indistinguishable in their messages, so case 1 cannot be attributed').not.toContain('pca_consumption_invoice');
    } finally {
      await c.end();
    }
  }, 60_000);

  it('criterion 5 is OPEN as a counted fact: zero write-off rows exist, while the control row does', async () => {
    const f = fx();
    const c = await scoped(f);
    try {
      const writeOffs = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM public.platform_credit_adjustments
          WHERE source_ref = $1 AND kind = 'consumption' AND invoice_id IS NULL`,
        [SOURCE_REF],
      );
      expect(writeOffs.rows[0]?.n, 'a write-off row exists after all, so this card is no longer blocked and criterion 5 must be re-measured').toBe('0');

      // POSITIVE CONTROL for the counter itself: the same probe, minus the one
      // predicate the write-off differs by, finds the row case 2 accepted. A
      // counter that found nothing either way would report zero while blind.
      const withInvoice = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM public.platform_credit_adjustments
          WHERE source_ref = $1 AND kind = 'consumption' AND invoice_id IS NOT NULL`,
        [SOURCE_REF],
      );
      expect(Number(withInvoice.rows[0]?.n), 'the counter finds no consumption at all, so its zero above is blind').toBeGreaterThan(0);
    } finally {
      await c.end();
    }
  }, 60_000);
});
