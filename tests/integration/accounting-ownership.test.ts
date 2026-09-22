import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { must, seedPostingFixture, todayIn, type PostingFixture } from '../helpers/accounting-posting';

/**
 * MATRIX — PHYSICAL OWNERSHIP AND STRUCTURAL FX SHAPE (§2-§6, §12).
 *
 * Two questions about candidate 0047's storage, both asked of the database
 * rather than of the code that normally writes it.
 *
 * First: can a row claim one tenant while belonging to another tenant's
 * business? Every other business-owned table in DAFTAR answers no with a
 * composite foreign key; application correctness is not a substitute for
 * that, because the table outlives every writer that exists today.
 *
 * Second: can the draft hold an FX snapshot the journal would later refuse?
 * The draft is not the arithmetic authority — the posting engine and the
 * frozen journal validator are, and this file does not second-guess them —
 * but a shape that is obviously impossible should be unwritable here too,
 * so a merchant discovers it while editing rather than at posting time.
 *
 * Every case writes as the schema owner, deliberately. A test that connected
 * as a runtime role would stop on "permission denied" and prove nothing
 * about the constraint it claims to be testing (§3).
 */

let fx: PostingFixture;
let other: PostingFixture;
let today: string;

const AT = new Date('2026-03-14T09:15:00Z');

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  fx = await seedPostingFixture(ownerPool(), 'own');
  other = await seedPostingFixture(ownerPool(), 'own-other');
  today = await todayIn(ownerPool(), 'Asia/Hebron');
}, 180_000);

/** A draft opening balance, written directly, so the line cases have a parent. */
async function draft(who: PostingFixture): Promise<string> {
  const id = randomUUID();
  await ownerPool().query(
    `INSERT INTO accounting_opening_balances (tenant_id, business_id, id, status, as_of_date, actor_user_id)
     VALUES ($1, $2, $3, 'draft', $4, $5)`,
    [who.tenantId, who.businessId, id, today, who.userId],
  );
  return id;
}

interface LineOverrides {
  tenantId?: string;
  businessId?: string;
  baseCurrency?: string;
  txnCurrency?: string;
  baseAmountMinor?: string;
  txnAmountMinor?: string;
  fxRate?: string;
  fxRateSource?: string;
}

/** Insert one position directly, so the CHECK or the FK is what answers. */
async function insertLine(who: PostingFixture, openingBalanceId: string, o: LineOverrides = {}): Promise<void> {
  await ownerPool().query(
    `INSERT INTO accounting_opening_balance_lines (
       tenant_id, business_id, opening_balance_id, line_no, account_ref_kind, account_system_key,
       side, base_amount_minor, base_currency, txn_amount_minor, txn_currency, fx_rate, fx_rate_source, fx_rate_at)
     VALUES ($1, $2, $3, 1, 'system', 'cash', 'D', $4, $5, $6, $7, $8, $9, $10)`,
    [
      o.tenantId ?? who.tenantId,
      o.businessId ?? who.businessId,
      openingBalanceId,
      o.baseAmountMinor ?? '50000',
      o.baseCurrency ?? 'ILS',
      o.txnAmountMinor ?? '50000',
      o.txnCurrency ?? 'ILS',
      o.fxRate ?? '1.0000000000',
      o.fxRateSource ?? 'base',
      AT,
    ],
  );
}

const refused = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('the write was accepted, but this case requires a refusal');
};

// ── §2, §3 tenant ownership ───────────────────────────────────────────────

describe('opening-balance positions cannot disown their tenant (§2, §3)', () => {
  it('A · a line naming its own tenant, business and opening balance is accepted', async () => {
    const id = await draft(fx);
    await insertLine(fx, id);
    const n = await ownerPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM accounting_opening_balance_lines WHERE business_id = $1 AND opening_balance_id = $2`,
      [fx.businessId, id],
    );
    expect(must(n.rows[0]).n).toBe(1);
  });

  it('B · tenant A with tenant B’s business is refused by the database', async () => {
    const id = await draft(fx);
    // The parent opening balance is this business's own, and the position is
    // otherwise valid. Only the tenant column lies.
    const message = await refused(() => insertLine(fx, id, { tenantId: other.tenantId }));
    expect(message).toMatch(/accounting_opening_balance_lines_tenant_business_fk|violates foreign key/i);
  });

  it('C · a tenant that exists but owns no such business is refused', async () => {
    const id = await draft(fx);
    const stranger = must((await ownerPool().query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`)).rows[0]).id;
    const message = await refused(() => insertLine(fx, id, { tenantId: stranger }));
    expect(message).toMatch(/accounting_opening_balance_lines_tenant_business_fk|violates foreign key/i);
  });

  it('D · the ordinary workflow still writes its positions', async () => {
    const id = await draft(fx);
    await insertLine(fx, id);
    const row = must(
      (
        await ownerPool().query<{ tenant_id: string; business_id: string }>(
          `SELECT tenant_id, business_id FROM accounting_opening_balance_lines WHERE business_id = $1 AND opening_balance_id = $2`,
          [fx.businessId, id],
        )
      ).rows[0],
    );
    expect(row.tenant_id).toBe(fx.tenantId);
    expect(row.business_id).toBe(fx.businessId);
  });
});

/**
 * §12: the same question asked of every business-owned table this slice
 * added, read from the catalogue rather than from the migration text. A
 * table that gains a tenant column later must gain the constraint with it,
 * and this case is what notices.
 */
describe('every business-owned P2-S4 table proves its tenant physically (§12)', () => {
  const TABLES = ['accounting_manual_adjustments', 'accounting_reversals', 'accounting_opening_balances', 'accounting_opening_balance_lines'];

  it.each(TABLES)('%s carries a (tenant_id, business_id) foreign key to businesses', async (table) => {
    const r = await ownerPool().query<{ n: number }>(
      `SELECT count(*)::int AS n
       FROM pg_constraint c
       JOIN pg_class child  ON child.oid  = c.conrelid
       JOIN pg_class parent ON parent.oid = c.confrelid
       WHERE c.contype = 'f' AND child.relname = $1 AND parent.relname = 'businesses'
         AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text)
              FROM unnest(c.conkey) AS k(attnum)
              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
             = ARRAY['business_id', 'tenant_id']::text[]`,
      [table],
    );
    expect(must(r.rows[0]).n, `${table} must not be able to claim a tenant that does not own its business`).toBe(1);
  });
});

// ── §4, §5, §6 structural FX shape ────────────────────────────────────────

describe('the draft refuses an FX snapshot the journal would refuse (§4, §5, §6)', () => {
  it('domestic: rate 1, equal amounts, base source is accepted', async () => {
    const id = await draft(fx);
    await insertLine(fx, id, { fxRate: '1.0000000000' });
    const n = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM accounting_opening_balance_lines WHERE opening_balance_id = $1`, [id]);
    expect(must(n.rows[0]).n).toBe(1);
  });

  it('domestic with a rate that is not 1 is refused by the database', async () => {
    const id = await draft(fx);
    // ILS → ILS at 2.0 is not a rate, it is a doubling. journal_lines has
    // always refused it; before this correction the draft did not.
    const message = await refused(() => insertLine(fx, id, { fxRate: '2.0000000000' }));
    expect(message).toMatch(/accounting_opening_balance_lines_fx_ck|violates check constraint/i);
  });

  it('domestic with unequal amounts is refused', async () => {
    const id = await draft(fx);
    const message = await refused(() => insertLine(fx, id, { txnAmountMinor: '50001' }));
    expect(message).toMatch(/accounting_opening_balance_lines_fx_ck|violates check constraint/i);
  });

  it('an unknown base currency is refused by the registry, not by a regex', async () => {
    const id = await draft(fx);
    // Correctly shaped — three uppercase letters — and not a currency.
    const message = await refused(() => insertLine(fx, id, { baseCurrency: 'ZZZ', txnCurrency: 'ZZZ' }));
    expect(message).toMatch(/base_currency_fkey|currencies|violates foreign key/i);
  });

  it('an unknown transaction currency is refused by the registry', async () => {
    const id = await draft(fx);
    const message = await refused(() => insertLine(fx, id, { txnCurrency: 'ZZZ', fxRateSource: 'manual', fxRate: '3.7500000000', txnAmountMinor: '8000' }));
    expect(message).toMatch(/txn_currency_fkey|currencies|violates foreign key/i);
  });

  it('foreign: a different currency with a manual positive rate is structurally permitted', async () => {
    const id = await draft(fx);
    await insertLine(fx, id, { txnCurrency: 'USD', txnAmountMinor: '8000', fxRate: '3.7500000000', fxRateSource: 'manual' });
    const row = must(
      (await ownerPool().query<{ fx_rate_source: string }>(`SELECT fx_rate_source FROM accounting_opening_balance_lines WHERE opening_balance_id = $1`, [id]))
        .rows[0],
    );
    expect(row.fx_rate_source).toBe('manual');
  });

  it('foreign with the base rate source is refused', async () => {
    const id = await draft(fx);
    const message = await refused(() => insertLine(fx, id, { txnCurrency: 'USD', txnAmountMinor: '8000', fxRate: '3.7500000000', fxRateSource: 'base' }));
    expect(message).toMatch(/accounting_opening_balance_lines_fx_ck|violates check constraint/i);
  });

  it('a provider rate source is refused outright: there is no rate feed for a date before the merchant arrived', async () => {
    const id = await draft(fx);
    const message = await refused(() => insertLine(fx, id, { txnCurrency: 'USD', txnAmountMinor: '8000', fxRate: '3.7500000000', fxRateSource: 'provider' }));
    expect(message).toMatch(/fx_rate_source|violates check constraint/i);
  });
});
