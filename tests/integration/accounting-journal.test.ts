import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbUrl, ensurePostgres, ownerPool, resetData } from '../helpers/test-app';

/**
 * MATRIX 2 — DATABASE INVARIANTS (Architecture Lock AL-02, directive §37).
 *
 * This is NOT an authorization suite. Under AL-03 no runtime role holds
 * journal DML at all, so an attempt made as `daftar_app` fails at privilege
 * checking and never reaches the constraint it was supposed to exercise — a
 * green test that proved nothing. Authorization is proved separately, against
 * the live grant catalogue, in `tests/security/journal-privilege-matrix.test.ts`.
 *
 * Everything here therefore runs as the SCHEMA OWNER, the one authority that
 * legitimately holds DML, so each case actually reaches the CHECK, the FK or
 * the deferred constraint trigger it is aimed at. A PASS requires both
 * matrices; neither substitutes for the other.
 *
 * Every deferred case is asserted at COMMIT, not at INSERT: the whole point of
 * the entry-side constraint trigger is that a transaction which writes an
 * entry and no lines still has a pending check when it tries to commit.
 */

const FINGERPRINT = 'a'.repeat(64);
const MAX_MONEY_MINOR = 1000000000000000000n;

interface Fixture {
  tenantId: string;
  businessId: string;
  userId: string;
  otherTenantId: string;
  otherBusinessId: string;
  otherUserId: string;
  branchId: string;
  accounts: Record<string, string>;
  otherAccounts: Record<string, string>;
}

let fx: Fixture;

/** A connection with its own transaction, as the schema owner. */
async function owner(): Promise<Client> {
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  return client;
}

interface LineSpec {
  lineNo: number;
  accountId: string;
  debitMinor?: bigint | number;
  creditMinor?: bigint | number;
  baseAmountMinor?: bigint | number;
  baseCurrency?: string;
  txnCurrency?: string;
  txnAmountMinor?: bigint | number;
  fxRate?: string;
  fxRateSource?: string;
  businessId?: string;
  tenantId?: string;
  branchId?: string | null;
}

interface EntrySpec {
  businessId?: string;
  tenantId?: string;
  sourceType?: string;
  sourceId?: string;
  entryDate?: string;
  actorKind?: string;
  actorUserId?: string | null;
  actorSystemKey?: string | null;
  fingerprint?: string;
  status?: string;
  entryId?: string;
}

function lineValues(spec: LineSpec, entryId: string): unknown[] {
  const debit = BigInt(spec.debitMinor ?? 0);
  const credit = BigInt(spec.creditMinor ?? 0);
  const base = BigInt(spec.baseAmountMinor ?? (debit > credit ? debit : credit));
  const baseCurrency = spec.baseCurrency ?? 'ILS';
  const txnCurrency = spec.txnCurrency ?? baseCurrency;
  const domestic = txnCurrency === baseCurrency;
  return [
    spec.tenantId ?? fx.tenantId,
    spec.businessId ?? fx.businessId,
    entryId,
    spec.lineNo,
    spec.accountId,
    debit.toString(),
    credit.toString(),
    base.toString(),
    baseCurrency,
    txnCurrency,
    (spec.txnAmountMinor === undefined ? base : BigInt(spec.txnAmountMinor)).toString(),
    spec.fxRate ?? (domestic ? '1.0000000000' : '1.0000000000'),
    spec.fxRateSource ?? (domestic ? 'base' : 'manual'),
    spec.branchId === undefined ? null : spec.branchId,
  ];
}

const INSERT_LINE = `INSERT INTO journal_lines
  (tenant_id, business_id, journal_entry_id, line_no, account_id,
   debit_minor, credit_minor, base_amount_minor, base_currency,
   txn_currency, txn_amount_minor, fx_rate, fx_rate_source, fx_rate_at, branch_id)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, date_trunc('second', now()), $14)`;
// Second precision, because 0045 §24 now requires it: the canonical
// fingerprint serializes fx_rate_at to the second, so two rows differing only
// in milliseconds would share one fingerprint.

/**
 * Write an entry, its lines and its binding in ONE transaction and commit.
 * Resolves on a successful COMMIT, rejects with the database's error.
 */
async function post(entry: EntrySpec, lines: LineSpec[], opts: { binding?: boolean } = {}): Promise<string> {
  const client = await owner();
  const entryId = entry.entryId ?? randomUUID();
  const sourceId = entry.sourceId ?? randomUUID();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO journal_entries
        (tenant_id, business_id, id, entry_date, description, source_type, source_id, status,
         actor_kind, actor_user_id, actor_system_key, request_id, posting_fingerprint)
       VALUES ($1,$2,$3,$4,'fixture',$5,$6,$7,$8,$9,$10,'req-fixture',$11)`,
      [
        entry.tenantId ?? fx.tenantId,
        entry.businessId ?? fx.businessId,
        entryId,
        entry.entryDate ?? '2026-09-01',
        entry.sourceType ?? 'manual_adjustment',
        sourceId,
        entry.status ?? 'posted',
        entry.actorKind ?? 'user',
        entry.actorUserId === undefined ? fx.userId : entry.actorUserId,
        entry.actorSystemKey ?? null,
        entry.fingerprint ?? FINGERPRINT,
      ],
    );
    for (const line of lines) await client.query(INSERT_LINE, lineValues(line, entryId));
    if (opts.binding !== false) {
      await client.query(
        `INSERT INTO accounting_source_bindings (tenant_id, business_id, source_type, source_id, journal_entry_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [entry.tenantId ?? fx.tenantId, entry.businessId ?? fx.businessId, entry.sourceType ?? 'manual_adjustment', sourceId, entryId],
      );
    }
    await client.query('COMMIT');
    return entryId;
  } finally {
    await client.end();
  }
}

/** A balanced, domestic, two-line entry — the shape case D expects to pass. */
function balancedLines(amount = 10000): LineSpec[] {
  return [
    { lineNo: 1, accountId: fx.accounts['cash'] ?? '', debitMinor: amount },
    { lineNo: 2, accountId: fx.accounts['sales_revenue'] ?? '', creditMinor: amount },
  ];
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  const pool = ownerPool();

  const tenant = (await pool.query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`)).rows[0];
  const business = (
    await pool.query<{ id: string }>(
      `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
       VALUES ($1,'Journal One','journal-one','PS','ILS','Asia/Hebron') RETURNING id`,
      [tenant?.id],
    )
  ).rows[0];
  const user = (
    await pool.query<{ id: string }>(`INSERT INTO users (email, password_hash, display_name) VALUES ('journal@test.dev','x','Journal') RETURNING id`)
  ).rows[0];
  const branch = (await pool.query<{ id: string }>(`INSERT INTO branches (business_id, name, is_default) VALUES ($1,'Main',true) RETURNING id`, [business?.id]))
    .rows[0];

  const otherTenant = (await pool.query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`)).rows[0];
  const otherBusiness = (
    await pool.query<{ id: string }>(
      `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
       VALUES ($1,'Journal Two','journal-two','JO','JOD','Asia/Amman') RETURNING id`,
      [otherTenant?.id],
    )
  ).rows[0];
  const otherUser = (
    await pool.query<{ id: string }>(`INSERT INTO users (email, password_hash, display_name) VALUES ('journal2@test.dev','x','Journal2') RETURNING id`)
  ).rows[0];

  const read = async (businessId: string): Promise<Record<string, string>> => {
    const { rows } = await pool.query<{ system_key: string; id: string }>(
      `SELECT system_key, id FROM accounts WHERE business_id = $1 AND system_key IS NOT NULL`,
      [businessId],
    );
    return Object.fromEntries(rows.map((r) => [r.system_key, r.id]));
  };

  fx = {
    tenantId: tenant?.id ?? '',
    businessId: business?.id ?? '',
    userId: user?.id ?? '',
    otherTenantId: otherTenant?.id ?? '',
    otherBusinessId: otherBusiness?.id ?? '',
    otherUserId: otherUser?.id ?? '',
    branchId: branch?.id ?? '',
    accounts: await read(business?.id ?? ''),
    otherAccounts: await read(otherBusiness?.id ?? ''),
  };
  // The chart trigger is the only reason accounts exist here; if it stopped
  // working these cases would fail for the wrong reason.
  expect(Object.keys(fx.accounts)).toHaveLength(21);
  expect(Object.keys(fx.otherAccounts)).toHaveLength(21);
});

afterAll(async () => {
  await resetData();
});

describe('Matrix 2 — journal invariants (A–H)', () => {
  it('D: a balanced two-line entry with a matching binding COMMITS', async () => {
    const id = await post({}, balancedLines());
    // Addressed by the entry's full identity, as everything that means "this
    // entry's lines" must be: the UUID alone is not an entry (§9).
    const { rows } = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM journal_lines WHERE business_id = $1 AND journal_entry_id = $2`, [
      fx.businessId,
      id,
    ]);
    expect(rows[0]?.n).toBe(2);
  });

  it('A: an entry with ZERO lines is refused at COMMIT — the entry-side trigger is what catches this', async () => {
    await expect(post({}, [])).rejects.toThrow(/accounting\.entry_too_few_lines/);
  });

  it('B: an entry with ONE line is refused at COMMIT', async () => {
    await expect(post({}, [{ lineNo: 1, accountId: fx.accounts['cash'] ?? '', debitMinor: 10000 }])).rejects.toThrow(/accounting\.entry_too_few_lines/);
  });

  it('C: two unbalanced lines are refused at COMMIT', async () => {
    await expect(
      post({}, [
        { lineNo: 1, accountId: fx.accounts['cash'] ?? '', debitMinor: 10000 },
        { lineNo: 2, accountId: fx.accounts['sales_revenue'] ?? '', creditMinor: 9999 },
      ]),
    ).rejects.toThrow(/accounting\.entry_unbalanced/);
  });

  it('E: a line referencing another business’s account is refused', async () => {
    await expect(
      post({}, [
        { lineNo: 1, accountId: fx.accounts['cash'] ?? '', debitMinor: 10000 },
        { lineNo: 2, accountId: fx.otherAccounts['sales_revenue'] ?? '', creditMinor: 10000 },
      ]),
    ).rejects.toThrow(/journal_lines_account_fk|entry_account_foreign/);
  });

  it('H: an entry with no source binding is refused at COMMIT', async () => {
    await expect(post({}, balancedLines(), { binding: false })).rejects.toThrow(/journal_entries_binding_fk|accounting\.entry_binding_missing/);
  });
});

describe('Matrix 2 — immutability (F, G and the binding perimeter)', () => {
  let entryId: string;

  beforeAll(async () => {
    entryId = await post({}, balancedLines(7700));
  });

  it('F: DELETE of a posted line is refused', async () => {
    await expect(ownerPool().query(`DELETE FROM journal_lines WHERE business_id = $1 AND journal_entry_id = $2`, [fx.businessId, entryId])).rejects.toThrow(
      /accounting\.journal_immutable/,
    );
  });

  it('G: UPDATE of a posted line is refused', async () => {
    await expect(
      ownerPool().query(`UPDATE journal_lines SET memo = 'edited' WHERE business_id = $1 AND journal_entry_id = $2`, [fx.businessId, entryId]),
    ).rejects.toThrow(/accounting\.journal_immutable/);
  });

  it('UPDATE and DELETE of a posted entry are refused', async () => {
    await expect(
      ownerPool().query(`UPDATE journal_entries SET description = 'edited' WHERE business_id = $1 AND id = $2`, [fx.businessId, entryId]),
    ).rejects.toThrow(/accounting\.journal_immutable/);
    await expect(ownerPool().query(`DELETE FROM journal_entries WHERE business_id = $1 AND id = $2`, [fx.businessId, entryId])).rejects.toThrow(
      /accounting\.journal_immutable/,
    );
  });

  it('UPDATE and DELETE of a source binding are refused', async () => {
    await expect(
      ownerPool().query(`UPDATE accounting_source_bindings SET source_id = gen_random_uuid() WHERE business_id = $1 AND journal_entry_id = $2`, [
        fx.businessId,
        entryId,
      ]),
    ).rejects.toThrow(/accounting\.binding_immutable/);
    await expect(
      ownerPool().query(`DELETE FROM accounting_source_bindings WHERE business_id = $1 AND journal_entry_id = $2`, [fx.businessId, entryId]),
    ).rejects.toThrow(/accounting\.binding_immutable/);
  });

  it('there is no admin, support or platform bypass — the schema OWNER is refused too', async () => {
    // These statements are issued by the schema owner, a superuser in this
    // harness, which bypasses RLS and every grant. The trigger still says no,
    // which is the whole reason it exists alongside the grant shape.
    const who = (await ownerPool().query<{ su: boolean }>(`SELECT rolsuper AS su FROM pg_roles WHERE rolname = current_user`)).rows[0];
    expect(who?.su, 'this suite must run as a principal that could otherwise do anything').toBe(true);
    await expect(ownerPool().query(`DELETE FROM journal_entries WHERE business_id = $1 AND id = $2`, [fx.businessId, entryId])).rejects.toThrow(
      /accounting\.journal_immutable/,
    );
  });
});

describe('AL-01 — the binding is deferred in BOTH directions', () => {
  it('entry present, binding missing → COMMIT fails', async () => {
    await expect(post({}, balancedLines(), { binding: false })).rejects.toThrow(/journal_entries_binding_fk|accounting\.entry_binding_missing/);
  });

  it('binding present, journal entry missing → COMMIT fails', async () => {
    const client = await owner();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO accounting_source_bindings (tenant_id, business_id, source_type, source_id, journal_entry_id)
         VALUES ($1,$2,'manual_adjustment',$3,$4)`,
        [fx.tenantId, fx.businessId, randomUUID(), randomUUID()],
      );
      await expect(client.query('COMMIT')).rejects.toThrow(/accounting_source_bindings_entry_fk/);
    } finally {
      await client.end();
    }
  });

  it('both written in EITHER order inside one transaction → COMMIT passes', async () => {
    // Binding first, entry second. A non-deferred FK would reject the binding
    // the moment it is written; this is what "DEFERRABLE INITIALLY DEFERRED"
    // actually buys, and the reason it is worth testing rather than declaring.
    //
    // The source type is `manual_adjustment` because P2-S4 gave `reversal`
    // and `opening_balance` deferred completeness triggers of their own: an
    // entry of either type must also carry its detail row. That is a
    // SEPARATE rule from the one under test here, and naming one of those
    // types would make this case prove two things and fail for the wrong
    // reason. `manual_adjustment` isolates the deferred binding by itself.
    const client = await owner();
    const entryId = randomUUID();
    const sourceId = randomUUID();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO accounting_source_bindings (tenant_id, business_id, source_type, source_id, journal_entry_id)
         VALUES ($1,$2,'manual_adjustment',$3,$4)`,
        [fx.tenantId, fx.businessId, sourceId, entryId],
      );
      await client.query(
        `INSERT INTO journal_entries (tenant_id, business_id, id, entry_date, source_type, source_id, actor_kind, actor_user_id, posting_fingerprint)
         VALUES ($1,$2,$3,'2026-09-02','manual_adjustment',$4,'user',$5,$6)`,
        [fx.tenantId, fx.businessId, entryId, sourceId, fx.userId, FINGERPRINT],
      );
      for (const line of balancedLines(4200)) await client.query(INSERT_LINE, lineValues(line, entryId));
      await client.query('COMMIT');
    } finally {
      await client.end();
    }
    const { rows } = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM journal_entries WHERE id = $1`, [entryId]);
    expect(rows[0]?.n).toBe(1);
  });

  it('a binding pointing at another business’s entry is refused', async () => {
    const entryId = await post({}, balancedLines(1500));
    const client = await owner();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO accounting_source_bindings (tenant_id, business_id, source_type, source_id, journal_entry_id)
         VALUES ($1,$2,'reversal',$3,$4)`,
        [fx.otherTenantId, fx.otherBusinessId, randomUUID(), entryId],
      );
      await expect(client.query('COMMIT')).rejects.toThrow(/accounting_source_bindings_entry_fk/);
    } finally {
      await client.end();
    }
  });

  it('a duplicate source identity is refused', async () => {
    const sourceId = randomUUID();
    await post({ sourceId }, balancedLines(2500));
    await expect(post({ sourceId }, balancedLines(2500))).rejects.toThrow(
      /accounting_source_bindings_pkey|journal_entries_business_id_source_type_source_id_key/,
    );
  });

  it('a second binding for one journal entry is refused', async () => {
    const entryId = await post({}, balancedLines(3300));
    await expect(
      ownerPool().query(
        `INSERT INTO accounting_source_bindings (tenant_id, business_id, source_type, source_id, journal_entry_id)
         VALUES ($1,$2,'reversal',$3,$4)`,
        [fx.tenantId, fx.businessId, randomUUID(), entryId],
      ),
    ).rejects.toThrow(/accounting_source_bindings_business_id_journal_entry_id_key/);
  });

  it('an unregistered source_type is refused', async () => {
    await expect(post({ sourceType: 'sale' }, balancedLines())).rejects.toThrow(/journal_entries_source_type_fkey|source_type/);
  });
});

describe('AL-04 — actor shape', () => {
  it('user + NULL user id → refused', async () => {
    await expect(post({ actorKind: 'user', actorUserId: null }, balancedLines())).rejects.toThrow(/journal_entries_actor_shape_ck/);
  });

  it('user + a system key → refused', async () => {
    await expect(post({ actorKind: 'user', actorSystemKey: 'worker' }, balancedLines())).rejects.toThrow(/journal_entries_actor_shape_ck/);
  });

  it('system + a user id → refused', async () => {
    await expect(post({ actorKind: 'system', actorUserId: fx.userId, actorSystemKey: 'worker' }, balancedLines())).rejects.toThrow(
      /journal_entries_actor_shape_ck/,
    );
  });

  it('system + an unregistered system key → refused (the registry is EMPTY, so every system actor is unregistered)', async () => {
    await expect(post({ actorKind: 'system', actorUserId: null, actorSystemKey: 'worker' }, balancedLines())).rejects.toThrow(
      /journal_entries_actor_system_key_fkey/,
    );
    const { rows } = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM accounting_system_actors`);
    expect(rows[0]?.n, 'accounting_system_actors must stay empty in Phase 2').toBe(0);
  });

  it('a real user shape passes structurally', async () => {
    await expect(post({ actorKind: 'user', actorUserId: fx.userId }, balancedLines(900))).resolves.toBeTruthy();
  });
});

describe('journal entry structural shape', () => {
  it('a status other than posted is refused', async () => {
    await expect(post({ status: 'draft' }, balancedLines())).rejects.toThrow(/journal_entries_status_check/);
  });

  it('a fingerprint that is not lowercase SHA-256 hex is refused', async () => {
    await expect(post({ fingerprint: 'A'.repeat(64) }, balancedLines())).rejects.toThrow(/posting_fingerprint/);
    await expect(post({ fingerprint: 'z'.repeat(64) }, balancedLines())).rejects.toThrow(/posting_fingerprint/);
  });

  it('a wrong tenant/business pair is refused', async () => {
    await expect(post({ tenantId: fx.otherTenantId }, balancedLines())).rejects.toThrow(/journal_entries_tenant_business_fk/);
  });

  it('a duplicate line_no inside one entry is refused', async () => {
    await expect(
      post({}, [
        { lineNo: 1, accountId: fx.accounts['cash'] ?? '', debitMinor: 500 },
        { lineNo: 1, accountId: fx.accounts['sales_revenue'] ?? '', creditMinor: 500 },
      ]),
    ).rejects.toThrow(/journal_lines_business_id_journal_entry_id_line_no_key/);
  });

  it('a line whose tenant does not match its entry is refused', async () => {
    await expect(
      post({}, [
        { lineNo: 1, accountId: fx.accounts['cash'] ?? '', debitMinor: 500, tenantId: fx.otherTenantId },
        { lineNo: 2, accountId: fx.accounts['sales_revenue'] ?? '', creditMinor: 500 },
      ]),
    ).rejects.toThrow(/journal_lines_tenant_business_fk|entry_business_mismatch/);
  });

  it('a nullable reporting dimension is allowed, and a foreign branch is not', async () => {
    await expect(
      post({}, [
        { lineNo: 1, accountId: fx.accounts['cash'] ?? '', debitMinor: 600, branchId: fx.branchId },
        { lineNo: 2, accountId: fx.accounts['sales_revenue'] ?? '', creditMinor: 600, branchId: null },
      ]),
    ).resolves.toBeTruthy();

    await expect(
      post({}, [
        { lineNo: 1, accountId: fx.accounts['cash'] ?? '', debitMinor: 600, branchId: randomUUID() },
        { lineNo: 2, accountId: fx.accounts['sales_revenue'] ?? '', creditMinor: 600 },
      ]),
    ).rejects.toThrow(/journal_lines_branch_fk/);
  });
});

describe('AL-10 — money range', () => {
  it('a line at exactly MAX_MONEY_MINOR is accepted', async () => {
    await expect(post({}, balancedLines(Number(MAX_MONEY_MINOR)) as LineSpec[])).resolves.toBeTruthy();
  });

  it('a line above MAX_MONEY_MINOR is refused', async () => {
    const over = (MAX_MONEY_MINOR + 1n).toString();
    await expect(
      post({}, [
        { lineNo: 1, accountId: fx.accounts['cash'] ?? '', debitMinor: BigInt(over) },
        { lineNo: 2, accountId: fx.accounts['sales_revenue'] ?? '', creditMinor: BigInt(over) },
      ]),
    ).rejects.toThrow(/journal_lines_money_cap_ck/);
  });

  it('both sides positive, or neither, is refused', async () => {
    await expect(
      post({}, [
        { lineNo: 1, accountId: fx.accounts['cash'] ?? '', debitMinor: 100, creditMinor: 100, baseAmountMinor: 100 },
        { lineNo: 2, accountId: fx.accounts['sales_revenue'] ?? '', creditMinor: 100 },
      ]),
    ).rejects.toThrow(/journal_lines_one_side_ck|journal_lines_money_cap_ck/);
    await expect(
      post({}, [
        { lineNo: 1, accountId: fx.accounts['cash'] ?? '', debitMinor: 0, creditMinor: 0, baseAmountMinor: 0 },
        { lineNo: 2, accountId: fx.accounts['sales_revenue'] ?? '', creditMinor: 100 },
      ]),
      // A zero line breaks two constraints at once — "exactly one side is
      // positive" and "every amount is above zero". PostgreSQL reports
      // whichever it evaluates first, and either is the right refusal.
    ).rejects.toThrow(/journal_lines_one_side_ck|journal_lines_money_cap_ck/);
  });

  it('base_amount_minor must equal the booked side', async () => {
    await expect(
      post({}, [
        { lineNo: 1, accountId: fx.accounts['cash'] ?? '', debitMinor: 100, baseAmountMinor: 90 },
        { lineNo: 2, accountId: fx.accounts['sales_revenue'] ?? '', creditMinor: 100 },
      ]),
    ).rejects.toThrow(/journal_lines_base_amount_ck/);
  });

  it('an entry whose BIGINT sum would overflow still balances, because the checker sums in NUMERIC', async () => {
    // Four lines at 10^18 each: every line is legal, and 2 x 10^18 per side
    // overflows nothing in NUMERIC while being far past what a bigint SUM
    // could hold on top of the other side.
    const amount = MAX_MONEY_MINOR;
    await expect(
      post({}, [
        { lineNo: 1, accountId: fx.accounts['cash'] ?? '', debitMinor: amount },
        { lineNo: 2, accountId: fx.accounts['bank'] ?? '', debitMinor: amount },
        { lineNo: 3, accountId: fx.accounts['sales_revenue'] ?? '', creditMinor: amount },
        { lineNo: 4, accountId: fx.accounts['opening_equity'] ?? '', creditMinor: amount },
      ]),
    ).resolves.toBeTruthy();
  });
});

describe('AL-09 — FX structural shape', () => {
  it('a domestic line with a rate other than 1 is refused', async () => {
    await expect(
      post({}, [
        { lineNo: 1, accountId: fx.accounts['cash'] ?? '', debitMinor: 1000, fxRate: '1.5000000000' },
        { lineNo: 2, accountId: fx.accounts['sales_revenue'] ?? '', creditMinor: 1000 },
      ]),
    ).rejects.toThrow(/journal_lines_fx_shape_ck/);
  });

  it('a domestic line whose transaction amount differs from its base amount is refused', async () => {
    await expect(
      post({}, [
        { lineNo: 1, accountId: fx.accounts['cash'] ?? '', debitMinor: 1000, txnAmountMinor: 999 },
        { lineNo: 2, accountId: fx.accounts['sales_revenue'] ?? '', creditMinor: 1000 },
      ]),
    ).rejects.toThrow(/journal_lines_fx_shape_ck/);
  });

  it('a foreign line with a rate of zero or less is refused', async () => {
    await expect(
      post({}, [
        { lineNo: 1, accountId: fx.accounts['cash'] ?? '', debitMinor: 1000, txnCurrency: 'USD', txnAmountMinor: 1000, fxRate: '0.0000000000' },
        { lineNo: 2, accountId: fx.accounts['sales_revenue'] ?? '', creditMinor: 1000 },
      ]),
    ).rejects.toThrow(/journal_lines_fx_rate_ck/);
  });

  it('a foreign line with the domestic rate sentinel, or with no real source, is refused', async () => {
    await expect(
      post({}, [
        {
          lineNo: 1,
          accountId: fx.accounts['cash'] ?? '',
          debitMinor: 3700,
          txnCurrency: 'USD',
          txnAmountMinor: 1000,
          fxRate: '3.7000000000',
          fxRateSource: 'base',
        },
        { lineNo: 2, accountId: fx.accounts['sales_revenue'] ?? '', creditMinor: 3700 },
      ]),
    ).rejects.toThrow(/journal_lines_fx_shape_ck/);
  });

  it('a domestic line claiming a non-base rate source is refused', async () => {
    await expect(
      post({}, [
        { lineNo: 1, accountId: fx.accounts['cash'] ?? '', debitMinor: 1000, fxRateSource: 'manual' },
        { lineNo: 2, accountId: fx.accounts['sales_revenue'] ?? '', creditMinor: 1000 },
      ]),
    ).rejects.toThrow(/journal_lines_fx_shape_ck/);
  });

  it('a line whose base currency is not the business base currency is refused at COMMIT', async () => {
    await expect(
      post({}, [
        { lineNo: 1, accountId: fx.accounts['cash'] ?? '', debitMinor: 1000, baseCurrency: 'USD' },
        { lineNo: 2, accountId: fx.accounts['sales_revenue'] ?? '', creditMinor: 1000, baseCurrency: 'USD' },
      ]),
    ).rejects.toThrow(/accounting\.entry_base_currency_mismatch/);
  });

  it('mixed base currencies inside one entry are refused at COMMIT', async () => {
    await expect(
      post({}, [
        { lineNo: 1, accountId: fx.accounts['cash'] ?? '', debitMinor: 1000 },
        { lineNo: 2, accountId: fx.accounts['sales_revenue'] ?? '', creditMinor: 1000, baseCurrency: 'USD' },
      ]),
    ).rejects.toThrow(/accounting\.entry_base_currency_mismatch/);
  });
});

/**
 * AL-09's conversion vectors, evaluated by the DATABASE. Each case books the
 * same foreign conversion on both sides, so the entry balances in base and
 * the only thing under test is whether the stored base amount equals the
 * exact HALF_EVEN conversion of the transaction amount.
 *
 * The two tie cases are the ones that separate HALF_EVEN from HALF_UP, which
 * is why `ROUND()` is not used anywhere in 0043: PostgreSQL rounds halves away
 * from zero and would disagree with the TypeScript engine on exactly these.
 */
describe('AL-09 — FX arithmetic, computed in the database', () => {
  const VECTORS: readonly { name: string; txn: string; rate: string; txnCurrency: string; expected: string }[] = [
    { name: 'USD(2) → ILS(2)', txn: '10000', rate: '3.7000000000', txnCurrency: 'USD', expected: '37000' },
    { name: 'JOD(3) → ILS(2)', txn: '10000', rate: '5.2500000000', txnCurrency: 'JOD', expected: '5250' },
    { name: 'LBP(2) → ILS(2), large', txn: '1000000000', rate: '0.0000111000', txnCurrency: 'LBP', expected: '11100' },
    { name: 'tie, quotient even → stays even', txn: '25', rate: '0.1000000000', txnCurrency: 'USD', expected: '2' },
    { name: 'tie, quotient odd → rounds up', txn: '35', rate: '0.1000000000', txnCurrency: 'USD', expected: '4' },
    { name: 'at MAX_MONEY_MINOR', txn: MAX_MONEY_MINOR.toString(), rate: '1.0000000000', txnCurrency: 'USD', expected: MAX_MONEY_MINOR.toString() },
  ];

  for (const v of VECTORS) {
    it(`accepts the exact conversion: ${v.name}`, async () => {
      await expect(
        post({}, [
          {
            lineNo: 1,
            accountId: fx.accounts['cash'] ?? '',
            debitMinor: BigInt(v.expected),
            txnCurrency: v.txnCurrency,
            txnAmountMinor: BigInt(v.txn),
            fxRate: v.rate,
          },
          {
            lineNo: 2,
            accountId: fx.accounts['sales_revenue'] ?? '',
            creditMinor: BigInt(v.expected),
            txnCurrency: v.txnCurrency,
            txnAmountMinor: BigInt(v.txn),
            fxRate: v.rate,
          },
        ]),
      ).resolves.toBeTruthy();
    });

    it(`refuses a base amount one minor unit away: ${v.name}`, async () => {
      const wrong = (BigInt(v.expected) + 1n).toString();
      await expect(
        post({}, [
          {
            lineNo: 1,
            accountId: fx.accounts['cash'] ?? '',
            debitMinor: BigInt(wrong),
            txnCurrency: v.txnCurrency,
            txnAmountMinor: BigInt(v.txn),
            fxRate: v.rate,
          },
          {
            lineNo: 2,
            accountId: fx.accounts['sales_revenue'] ?? '',
            creditMinor: BigInt(wrong),
            txnCurrency: v.txnCurrency,
            txnAmountMinor: BigInt(v.txn),
            fxRate: v.rate,
          },
        ]),
      ).rejects.toThrow(/accounting\.entry_fx_arithmetic|journal_lines_money_cap_ck/);
    });
  }

  it('ILS(2) → JOD(3): the reverse exponent direction is exact too', async () => {
    // Booked in the JOD business, whose base currency has three minor units.
    const client = await owner();
    const entryId = randomUUID();
    const sourceId = randomUUID();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO journal_entries (tenant_id, business_id, id, entry_date, source_type, source_id, actor_kind, actor_user_id, posting_fingerprint)
         VALUES ($1,$2,$3,'2026-09-03','manual_adjustment',$4,'user',$5,$6)`,
        [fx.otherTenantId, fx.otherBusinessId, entryId, sourceId, fx.otherUserId, FINGERPRINT],
      );
      for (const [lineNo, account, debit, credit] of [
        [1, fx.otherAccounts['cash'] ?? '', '10000', '0'],
        [2, fx.otherAccounts['sales_revenue'] ?? '', '0', '10000'],
      ] as const) {
        await client.query(INSERT_LINE, [
          fx.otherTenantId,
          fx.otherBusinessId,
          entryId,
          lineNo,
          account,
          debit,
          credit,
          '10000',
          'JOD',
          'ILS',
          '5250',
          '0.1904761905',
          'manual',
          null,
        ]);
      }
      await client.query(
        `INSERT INTO accounting_source_bindings (tenant_id, business_id, source_type, source_id, journal_entry_id)
         VALUES ($1,$2,'manual_adjustment',$3,$4)`,
        [fx.otherTenantId, fx.otherBusinessId, sourceId, entryId],
      );
      await client.query('COMMIT');
    } finally {
      await client.end();
    }
    const { rows } = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM journal_entries WHERE id = $1`, [entryId]);
    expect(rows[0]?.n).toBe(1);
  });
});

describe('§30 — database errors carry no financial values', () => {
  it('an unbalanced entry names the entry and nothing else', async () => {
    let message = '';
    try {
      await post({}, [
        { lineNo: 1, accountId: fx.accounts['cash'] ?? '', debitMinor: 123456 },
        { lineNo: 2, accountId: fx.accounts['sales_revenue'] ?? '', creditMinor: 654321 },
      ]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/accounting\.entry_unbalanced/);
    // The two sums that would be most useful to a debugger are exactly the two
    // that must never reach a log line.
    expect(message).not.toMatch(/123456|654321/);
  });

  it('an FX mismatch names the entry and the line, not the amounts or the rate', async () => {
    let message = '';
    try {
      await post({}, [
        { lineNo: 1, accountId: fx.accounts['cash'] ?? '', debitMinor: 37001, txnCurrency: 'USD', txnAmountMinor: 10000, fxRate: '3.7000000000' },
        { lineNo: 2, accountId: fx.accounts['sales_revenue'] ?? '', creditMinor: 37001, txnCurrency: 'USD', txnAmountMinor: 10000, fxRate: '3.7000000000' },
      ]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/accounting\.entry_fx_arithmetic/);
    expect(message).toMatch(/line 1/);
    expect(message).not.toMatch(/37001|10000|3\.7/);
  });
});

describe('§26 — base currency locks on the first posted entry, never on the chart', () => {
  it('a business with a chart but no journal entry may still change its base currency', async () => {
    const pool = ownerPool();
    const tenant = (await pool.query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`)).rows[0];
    const biz = (
      await pool.query<{ id: string }>(
        `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
         VALUES ($1,'Unlocked','journal-unlocked','PS','ILS','Asia/Hebron') RETURNING id`,
        [tenant?.id],
      )
    ).rows[0];
    // P2-S1's promise: owning a chart is not a financial transaction.
    const { rows } = await pool.query<{ n: number; started: string | null }>(
      `SELECT (SELECT count(*)::int FROM accounts WHERE business_id = $1) AS n, financial_started_at AS started FROM businesses WHERE id = $1`,
      [biz?.id],
    );
    expect(rows[0]?.n).toBe(21);
    expect(rows[0]?.started).toBeNull();

    await expect(pool.query(`UPDATE businesses SET base_currency = 'USD' WHERE id = $1`, [biz?.id])).resolves.toBeTruthy();
  });

  it('a business with a posted entry may NOT change its base currency, even as the schema owner', async () => {
    await expect(ownerPool().query(`UPDATE businesses SET base_currency = 'USD' WHERE id = $1`, [fx.businessId])).rejects.toThrow(
      /accounting\.base_currency_locked/,
    );
    // Everything else about the business is still editable — the lock is
    // narrow, not a freeze on the row.
    await expect(ownerPool().query(`UPDATE businesses SET name = 'Journal One Renamed' WHERE id = $1`, [fx.businessId])).resolves.toBeTruthy();
  });
});

/**
 * COMPOSITE JOURNAL IDENTITY (Tech Lead correction, §2–§8).
 *
 * A journal entry's identity is `(business_id, id)`. There is deliberately no
 * global `UNIQUE (id)`, so two businesses may legitimately hold entries whose
 * UUID component is identical while being entirely different relational
 * entities. The commit-time validator must therefore reason only over rows
 * belonging to the target composite entry: addressing lines by
 * `journal_entry_id` alone lets one business's rows enter another business's
 * accounting validation.
 *
 * These cases are behavioural, not textual. Each one is constructed so that a
 * validator scoped by entry id alone gives a DIFFERENT answer from one scoped
 * by the composite pair, which is what makes them a real regression rather
 * than a restatement of the code.
 */
describe('composite journal identity — (business_id, id), never id alone', () => {
  /**
   * Write two complete, independently valid entries that share a UUID, in ONE
   * transaction, so both deferred validators see the simultaneous state.
   */
  async function postTwoSharingId(
    sharedId: string,
    a: { lines: LineSpec[] },
    b: { lines: LineSpec[] },
  ): Promise<{ client: Client; commit: () => Promise<void> }> {
    const client = await owner();
    const sourceA = randomUUID();
    const sourceB = randomUUID();
    await client.query('BEGIN');

    const insertEntry = async (tenantId: string, businessId: string, sourceId: string): Promise<void> => {
      await client.query(
        `INSERT INTO journal_entries
          (tenant_id, business_id, id, entry_date, description, source_type, source_id, status,
           actor_kind, actor_user_id, actor_system_key, request_id, posting_fingerprint)
         VALUES ($1,$2,$3,'2026-09-01','shared-uuid','manual_adjustment',$4,'posted','user',$5,NULL,'req-fixture',$6)`,
        [tenantId, businessId, sharedId, sourceId, tenantId === fx.tenantId ? fx.userId : fx.otherUserId, FINGERPRINT],
      );
      await client.query(
        `INSERT INTO accounting_source_bindings (tenant_id, business_id, source_type, source_id, journal_entry_id)
         VALUES ($1,$2,'manual_adjustment',$3,$4)`,
        [tenantId, businessId, sourceId, sharedId],
      );
    };

    await insertEntry(fx.tenantId, fx.businessId, sourceA);
    for (const line of a.lines) await client.query(INSERT_LINE, lineValues({ ...line }, sharedId));

    await insertEntry(fx.otherTenantId, fx.otherBusinessId, sourceB);
    for (const line of b.lines) {
      await client.query(INSERT_LINE, lineValues({ ...line, tenantId: fx.otherTenantId, businessId: fx.otherBusinessId, baseCurrency: 'JOD' }, sharedId));
    }

    return { client, commit: async () => void (await client.query('COMMIT')) };
  }

  /**
   * §7. The headline case. Two businesses, the same `journal_entries.id`, each
   * with its own tenant, accounts, source id, binding and balanced lines.
   *
   * Against the reviewed implementation this FAILED with
   * `accounting.entry_business_mismatch`, because the ownership check gathered
   * lines by entry id alone and then found the other business's rows among
   * them. Nothing was wrong with the data; the validator was asking the
   * database the wrong question.
   */
  it('two businesses may hold entries sharing a UUID, and both commit', async () => {
    const sharedId = randomUUID();
    const { client, commit } = await postTwoSharingId(
      sharedId,
      { lines: balancedLines(10000) },
      {
        lines: [
          { lineNo: 1, accountId: fx.otherAccounts['cash'] ?? '', debitMinor: 7500 },
          { lineNo: 2, accountId: fx.otherAccounts['sales_revenue'] ?? '', creditMinor: 7500 },
        ],
      },
    );
    try {
      await expect(commit()).resolves.toBeUndefined();
    } finally {
      await client.end();
    }

    // Each entry kept its own lines, and neither borrowed the other's.
    const rows = (
      await ownerPool().query<{ business_id: string; n: number; total: string }>(
        `SELECT business_id, count(*)::int AS n, sum(base_amount_minor)::text AS total
           FROM journal_lines WHERE journal_entry_id = $1 GROUP BY business_id ORDER BY business_id`,
        [sharedId],
      )
    ).rows;
    expect(rows).toHaveLength(2);
    const byBusiness = Object.fromEntries(rows.map((r) => [r.business_id, r]));
    expect(byBusiness[fx.businessId]).toMatchObject({ n: 2, total: '20000' });
    expect(byBusiness[fx.otherBusinessId]).toMatchObject({ n: 2, total: '15000' });
  });

  /**
   * §7, the sums half, stated so that only a correctly scoped validator can
   * pass it. Each entry is unbalanced on its own, but the two are unbalanced
   * in opposite directions by the same amount — so a validator that summed
   * lines by entry id alone would see a perfectly balanced 11000 = 11000 and
   * let both through. Scoped correctly, each is refused on its own merits.
   */
  it('balance is summed per business: two same-UUID entries whose merged sums balance are still both refused', async () => {
    const sharedId = randomUUID();
    const { client, commit } = await postTwoSharingId(
      sharedId,
      {
        lines: [
          { lineNo: 1, accountId: fx.accounts['cash'] ?? '', debitMinor: 10000 },
          { lineNo: 2, accountId: fx.accounts['sales_revenue'] ?? '', creditMinor: 9000 },
        ],
      },
      {
        lines: [
          { lineNo: 1, accountId: fx.otherAccounts['cash'] ?? '', debitMinor: 1000 },
          { lineNo: 2, accountId: fx.otherAccounts['sales_revenue'] ?? '', creditMinor: 2000 },
        ],
      },
    );
    try {
      await expect(commit()).rejects.toThrow(/accounting\.entry_unbalanced/);
    } finally {
      await client.end();
    }
  });

  /**
   * §7, the count half. One line each. Merged they are two, which is what the
   * "at least two lines" rule asks for — so an unscoped count would accept a
   * pair of one-line entries. Each must be refused.
   */
  it('line count is per business: two same-UUID one-line entries do not add up to a valid entry', async () => {
    const sharedId = randomUUID();
    const { client, commit } = await postTwoSharingId(
      sharedId,
      { lines: [{ lineNo: 1, accountId: fx.accounts['cash'] ?? '', debitMinor: 10000 }] },
      { lines: [{ lineNo: 1, accountId: fx.otherAccounts['sales_revenue'] ?? '', creditMinor: 10000 }] },
    );
    try {
      await expect(commit()).rejects.toThrow(/accounting\.entry_too_few_lines|accounting\.entry_unbalanced/);
    } finally {
      await client.end();
    }
  });

  /**
   * §7, the base-currency half. The two businesses have different base
   * currencies (ILS and JOD) by construction, so a validator that gathered the
   * other business's lines would call a perfectly correct entry
   * `entry_base_currency_mismatch`. This is the same defect seen from the
   * currency rule rather than the ownership rule, and it is worth its own case
   * because a partial fix could close one and leave the other open.
   */
  it('base currency is judged per business, not across a shared UUID', async () => {
    const sharedId = randomUUID();
    const { client, commit } = await postTwoSharingId(
      sharedId,
      { lines: balancedLines(4200) },
      {
        lines: [
          { lineNo: 1, accountId: fx.otherAccounts['cash'] ?? '', debitMinor: 300 },
          { lineNo: 2, accountId: fx.otherAccounts['sales_revenue'] ?? '', creditMinor: 300 },
        ],
      },
    );
    try {
      await expect(commit()).resolves.toBeUndefined();
    } finally {
      await client.end();
    }
    const currencies = (
      await ownerPool().query<{ base_currency: string }>(
        `SELECT DISTINCT base_currency FROM journal_lines WHERE journal_entry_id = $1 ORDER BY base_currency`,
        [sharedId],
      )
    ).rows.map((r) => r.base_currency);
    expect(currencies).toEqual(['ILS', 'JOD']);
  });

  /**
   * §8. The companion property, and the reason the fix is not a weakening:
   * scoping the validator must not make it possible for one business's line to
   * reach another business's entry or account. The composite foreign keys
   * refuse it before any validator runs.
   */
  it('a line cannot claim one business while referencing another business entry', async () => {
    const client = await owner();
    const entryId = randomUUID();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO journal_entries
          (tenant_id, business_id, id, entry_date, description, source_type, source_id, status,
           actor_kind, actor_user_id, actor_system_key, request_id, posting_fingerprint)
         VALUES ($1,$2,$3,'2026-09-01','x','manual_adjustment',$4,'posted','user',$5,NULL,'req',$6)`,
        [fx.otherTenantId, fx.otherBusinessId, entryId, randomUUID(), fx.otherUserId, FINGERPRINT],
      );
      // A line owned by business ONE, pointing at business TWO's entry.
      await expect(client.query(INSERT_LINE, lineValues({ lineNo: 1, accountId: fx.accounts['cash'] ?? '', debitMinor: 100 }, entryId))).rejects.toThrow(
        /journal_lines_entry_fk/,
      );
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }
  });

  it('a line cannot reference an account belonging to another business', async () => {
    const client = await owner();
    const entryId = randomUUID();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO journal_entries
          (tenant_id, business_id, id, entry_date, description, source_type, source_id, status,
           actor_kind, actor_user_id, actor_system_key, request_id, posting_fingerprint)
         VALUES ($1,$2,$3,'2026-09-01','x','manual_adjustment',$4,'posted','user',$5,NULL,'req',$6)`,
        [fx.tenantId, fx.businessId, entryId, randomUUID(), fx.userId, FINGERPRINT],
      );
      await expect(client.query(INSERT_LINE, lineValues({ lineNo: 1, accountId: fx.otherAccounts['cash'] ?? '', debitMinor: 100 }, entryId))).rejects.toThrow(
        /journal_lines_account_fk/,
      );
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }
  });

  /**
   * A tripwire, not the proof — the five behavioural cases above are the
   * proof. It exists because the defect had one exact textual shape, and a
   * refactor that reintroduced it would otherwise be caught only by whichever
   * behavioural case happened to notice first. The validator addresses lines
   * through the loaded entry's own `(business_id, id)`; `p_entry_id` survives
   * only in the entry lookup and in error messages.
   */
  it('the validator never addresses journal lines by entry id alone', async () => {
    const { rows } = await ownerPool().query<{ prosrc: string }>(`SELECT prosrc FROM pg_proc WHERE proname = 'accounting_assert_entry_valid'`);
    expect(rows).toHaveLength(1);
    const src = rows[0]?.prosrc ?? '';
    expect(src).not.toMatch(/journal_entry_id\s*=\s*p_entry_id/i);
    // And every line-addressing predicate carries its business alongside.
    const lineScopes = src.match(/jl\.journal_entry_id\s*=\s*e\.id/gi) ?? [];
    const businessScopes = src.match(/jl\.business_id\s*=\s*e\.business_id/gi) ?? [];
    expect(lineScopes.length).toBeGreaterThan(0);
    expect(businessScopes.length).toBe(lineScopes.length);
  });
});
