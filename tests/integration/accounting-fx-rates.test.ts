import { beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { must, seedPostingFixture, type PostingFixture } from '../helpers/accounting-posting';
import {
  controlAssertion,
  enterRate,
  enterRateAs,
  fxClient,
  fxFingerprintOf,
  fxRefusal,
  lookupRateAs,
  rateIdFor,
  type RateFacts,
} from '../helpers/accounting-fx';

/**
 * THE FX RATE REGISTRY, AGAINST A REAL CLUSTER (directive §11-§24, §45, §46).
 *
 * Three questions this file answers and nothing else can:
 *
 *   1. What can be STORED. The pair, the precision, the instant, the
 *      currencies — every one of them enforced by the database rather than by
 *      a validator a direct caller could go around.
 *   2. What a LOOKUP returns. §46's full matrix, including every wrong answer
 *      it must never give: a future rate, the nearest rate, the reciprocal, a
 *      cross-rate, an implicit 1, or another business's row.
 *   3. Whether a stored rate can ever CHANGE. §45 is explicit that a
 *      `permission denied` is evidence about an ACL and not about
 *      immutability, so the mutation cases run as the schema OWNER — the one
 *      principal no privilege check can stop — and require the trigger itself
 *      to answer.
 */

let fx: PostingFixture;

/** A second business inside the FIRST tenant, for the cross-business cases. */
let siblingBusinessId: string;

const AT = (s: string): string => s;
const T0 = '2026-01-01T00:00:00Z';
const T1 = '2026-03-01T00:00:00Z';
const T2 = '2026-06-01T00:00:00Z';
const FUTURE = '2027-01-01T00:00:00Z';

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  fx = await seedPostingFixture(ownerPool(), `fxrate-${Math.floor(Math.random() * 1e6)}`);
  const r = await ownerPool().query<{ id: string }>(
    `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
     VALUES ($1, 'FX Sibling', $2, 'PS', 'ILS', 'Asia/Hebron') RETURNING id`,
    [fx.tenantId, `fxrate-sibling-${Math.floor(Math.random() * 1e6)}`],
  );
  siblingBusinessId = must(r.rows[0]).id;
}, 180_000);

const facts = (over: Partial<RateFacts> & { key: string }): RateFacts => ({
  tenantId: fx.tenantId,
  businessId: over.businessId ?? fx.businessId,
  rateId: rateIdFor(over.businessId ?? fx.businessId, over.key),
  fromCurrency: over.fromCurrency ?? 'USD',
  toCurrency: over.toCurrency ?? 'ILS',
  rate: over.rate ?? '3.71',
  effectiveAt: over.effectiveAt ?? T1,
});

/**
 * Call `accounting_fx_rate_enter` DIRECTLY with a payload the application
 * layer would never have produced.
 *
 * This is the round-four lesson applied to a new command. The engine
 * canonicalizes a rate before it fingerprints one, so a malformed rate never
 * reaches the database through `enterRate` — and a test that only proved
 * THAT would be evidence about a pipe, not about the command. A later phase's
 * worker, a support script or a second service calls the routine itself.
 *
 * So the assertion here is genuine and covers a perfectly valid payload; the
 * BAD value is then handed to the routine. A routine that validated after
 * fingerprinting would answer `assertion_payload_mismatch` — technically a
 * refusal, but the wrong one, and it would mean the malformed value had
 * already been through the derivation. The cases below require the routine's
 * own code, which is only possible if it checks first.
 */
async function directEnter(over: { key: string; fromCurrency?: string; toCurrency?: string; rate?: string; effectiveAt?: string }): Promise<unknown> {
  const sound = facts({ key: over.key, fromCurrency: 'USD', toCurrency: 'ILS', rate: '3.71', effectiveAt: T1 });
  const assertion = controlAssertion({
    actorUserId: fx.userId,
    tenantId: fx.tenantId,
    businessId: fx.businessId,
    commandKind: 'fx_rate_enter',
    resourceId: sound.rateId,
    payloadFingerprint: fxFingerprintOf(sound),
  });
  return enterRateAs(assertion, {
    fromCurrency: over.fromCurrency ?? 'USD',
    toCurrency: over.toCurrency ?? 'ILS',
    rate: over.rate ?? '3.71',
    effectiveAt: over.effectiveAt ?? T1,
  });
}

// ── §11-§17: what the registry will and will not store ────────────────────

describe('the rate registry stores exact, distinct, second-precise facts (§11-§17)', () => {
  it('an ordinary rate is stored at the full contract scale', async () => {
    const f = facts({ key: 'store-plain-0001', rate: '3.71', effectiveAt: T1 });
    const out = await enterRate(f, fx.userId);
    expect(out.created).toBe(true);
    expect(out.rateId).toBe(f.rateId);

    const row = must(
      (
        await ownerPool().query<{ rate: string; source: string; entered_by_user_id: string; tenant_id: string; effective_at: Date }>(
          `SELECT rate, source, entered_by_user_id, tenant_id, effective_at FROM accounting_fx_rates WHERE business_id = $1 AND id = $2`,
          [fx.businessId, f.rateId],
        )
      ).rows[0],
    );
    // The declared scale is the stored scale: "3.71" and "3.7100000000" are
    // one value, and the one PostgreSQL keeps is the ten-digit form the
    // journal will validate against.
    expect(row.rate).toBe('3.7100000000');
    expect(row.source).toBe('manual');
    // §37: the actor comes from the signed authority, never from a parameter.
    expect(row.entered_by_user_id).toBe(fx.userId);
    expect(row.tenant_id).toBe(fx.tenantId);
  });

  it('a rate whose precision exceeds the contract is REFUSED by the ROUTINE, never rounded (§15)', async () => {
    const before = must(
      (await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM accounting_fx_rates WHERE business_id = $1`, [fx.businessId])).rows[0],
    ).n;
    for (const bad of ['3.71000000001', '3.7e0', '-3.71', 'NaN', 'Infinity', '0', '0.0000000000', '3,71', '.71', '3.']) {
      const message = await fxRefusal(() => directEnter({ key: 'bad-rate-guard-01', rate: bad }));
      // Its OWN code, not a payload mismatch: the routine must refuse before
      // it derives anything from the value.
      expect(message, `rate ${JSON.stringify(bad)} must be refused by name`).toMatch(/accounting\.fx_rate_invalid/);
      expect(message).not.toMatch(/numeric|overflow|invalid input syntax|22P02/i);
    }
    // And the engine refuses the same values before they leave the process,
    // so both layers hold. Both matter: one is the pipe, one is the command.
    expect(await fxRefusal(() => enterRate(facts({ key: 'bad-rate-engine-1', rate: '3.71000000001' }), fx.userId))).toMatch(/rate/);

    const after = must(
      (await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM accounting_fx_rates WHERE business_id = $1`, [fx.businessId])).rows[0],
    ).n;
    expect(after).toBe(before);
  });

  it('a same-currency pair is not a rate, at the ROUTINE boundary (§14)', async () => {
    expect(await fxRefusal(() => directEnter({ key: 'same-currency-001', fromCurrency: 'ILS', toCurrency: 'ILS' }))).toMatch(/accounting\.fx_same_currency/);
    // The engine will not even fingerprint one.
    expect(await fxRefusal(() => enterRate(facts({ key: 'same-currency-002', fromCurrency: 'ILS', toCurrency: 'ILS' }), fx.userId))).toMatch(
      /exchange rate against itself/,
    );
  });

  it('an unregistered currency is refused by the REGISTRY, not by a shape (§13)', async () => {
    // `ZZZ` matches [A-Z]{3} and is not money. A three-letter check would let
    // it through; the foreign key to `currencies` is what actually decides.
    const message = await fxRefusal(() => directEnter({ key: 'unknown-currency-1', fromCurrency: 'ZZZ' }));
    expect(message).toMatch(/accounting\.fx_currency_unknown/);
    expect(message).not.toMatch(/23503|foreign key|violates/i);
  });

  it('a sub-second instant is refused by the ROUTINE, never silently truncated (§16)', async () => {
    expect(await fxRefusal(() => directEnter({ key: 'subsecond-000001', effectiveAt: '2026-03-01T00:00:00.250Z' }))).toMatch(
      /accounting\.fx_effective_at_precision/,
    );
    // §64: and a NULL instant is refused by name rather than resolved from a
    // clock. There is no coalesce over this parameter anywhere in 0048.
    const sound = facts({ key: 'null-instant-0001' });
    const assertion = controlAssertion({
      actorUserId: fx.userId,
      tenantId: fx.tenantId,
      businessId: fx.businessId,
      commandKind: 'fx_rate_enter',
      resourceId: sound.rateId,
      payloadFingerprint: fxFingerprintOf(sound),
    });
    const nulled = await fxRefusal(async () => {
      const conn = await fxClient();
      try {
        await conn.query('BEGIN');
        await conn.query(`SELECT set_config('app.accounting_control_assertion', $1, true)`, [assertion]);
        await conn.query(`SELECT rate_id, created FROM accounting_fx_rate_enter($1, $2, $3, $4::timestamptz, $5)`, ['USD', 'ILS', '3.71', null, 'req-null']);
        await conn.query('COMMIT');
      } finally {
        await conn.query('ROLLBACK').catch(() => undefined);
        await conn.end().catch(() => undefined);
      }
    });
    expect(nulled).toMatch(/accounting\.fx_effective_at_required/);
    expect(nulled).not.toMatch(/null value|not-null|23502/i);
  });

  it('the database itself refuses what the command refuses (§14-§16)', async () => {
    // The command is one caller. These CHECKs are the reason a second caller
    // — a later worker, a support script, a bad migration — cannot store what
    // the command would have refused.
    const direct = async (sql: string, params: unknown[]): Promise<string> => {
      try {
        await ownerPool().query(sql, params);
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
      throw new Error('the direct insert was accepted, but this case requires a refusal');
    };
    const insert = `INSERT INTO accounting_fx_rates (tenant_id, business_id, id, from_currency, to_currency, rate, effective_at, entered_by_user_id)
                    VALUES ($1, $2, gen_random_uuid(), $3, $4, $5, $6::timestamptz, $7)`;
    expect(await direct(insert, [fx.tenantId, fx.businessId, 'ILS', 'ILS', '1', T1, fx.userId])).toMatch(/distinct_pair/);
    expect(await direct(insert, [fx.tenantId, fx.businessId, 'USD', 'ILS', '0', T1, fx.userId])).toMatch(/positive/);
    expect(await direct(insert, [fx.tenantId, fx.businessId, 'USD', 'ILS', '3.71', '2026-03-01T00:00:00.250Z', fx.userId])).toMatch(/second_precision/);
    // §12: a row may not claim a tenant that does not own its business.
    expect(await direct(insert, [fx.otherTenantId, fx.businessId, 'USD', 'ILS', '3.71', T2, fx.userId])).toMatch(/tenant_business_fk/);
  });

  it('one business cannot state two truths for one pair at one instant (§17)', async () => {
    await enterRate(facts({ key: 'uniqueness-aaa-01', fromCurrency: 'EUR', toCurrency: 'ILS', rate: '4.05', effectiveAt: T2 }), fx.userId);
    const message = await fxRefusal(() =>
      enterRate(facts({ key: 'uniqueness-bbb-02', fromCurrency: 'EUR', toCurrency: 'ILS', rate: '4.10', effectiveAt: T2 }), fx.userId),
    );
    expect(message).toMatch(/accounting\.fx_rate_conflict/);
    // The refusal is a domain sentence: no SQLSTATE, no index name, no SQL.
    expect(message).not.toMatch(/23505|duplicate key|accounting_fx_rates_identity_uk|constraint/i);
  });
});

// ── §18, §45: append-only truth, proved through the trigger ───────────────

describe('a stored rate is history and cannot be changed (§18, §45)', () => {
  it('UPDATE and DELETE are refused for the SCHEMA OWNER — the trigger answers, not an ACL', async () => {
    const f = facts({ key: 'immutable-rate-01', fromCurrency: 'TRY', toCurrency: 'ILS', rate: '0.11', effectiveAt: T1 });
    await enterRate(f, fx.userId);

    const owner = async (sql: string): Promise<string> => {
      try {
        await ownerPool().query(sql, [fx.businessId, f.rateId]);
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
      throw new Error('the mutation was accepted, but a rate is append-only');
    };

    // The owner of the table holds every privilege PostgreSQL can grant, so
    // a `permission denied` here would be impossible — which is exactly why
    // §45 requires the test to run as this principal.
    const updated = await owner(`UPDATE accounting_fx_rates SET rate = 9.99 WHERE business_id = $1 AND id = $2`);
    expect(updated).toMatch(/accounting\.fx_rate_immutable/);
    expect(updated).not.toMatch(/permission denied/i);

    const deleted = await owner(`DELETE FROM accounting_fx_rates WHERE business_id = $1 AND id = $2`);
    expect(deleted).toMatch(/accounting\.fx_rate_immutable/);
    expect(deleted).not.toMatch(/permission denied/i);

    const row = must(
      (await ownerPool().query<{ rate: string }>(`SELECT rate FROM accounting_fx_rates WHERE business_id = $1 AND id = $2`, [fx.businessId, f.rateId])).rows[0],
    );
    expect(row.rate).toBe('0.1100000000');
  });

  it('a correction is a NEW rate at a later instant, and the old one survives', async () => {
    const early = facts({ key: 'correction-old-001', fromCurrency: 'USD', toCurrency: 'TRY', rate: '40.10', effectiveAt: T1 });
    const later = facts({ key: 'correction-new-001', fromCurrency: 'USD', toCurrency: 'TRY', rate: '40.55', effectiveAt: T2 });
    await enterRate(early, fx.userId);
    await enterRate(later, fx.userId);

    const rows = (
      await ownerPool().query<{ rate: string }>(
        `SELECT rate FROM accounting_fx_rates WHERE business_id = $1 AND from_currency = 'USD' AND to_currency = 'TRY' ORDER BY effective_at`,
        [fx.businessId],
      )
    ).rows;
    expect(rows.map((r) => r.rate)).toEqual(['40.1000000000', '40.5500000000']);
  });
});

// ── §21, §46: the lookup matrix, in full ──────────────────────────────────

describe('the lookup is deterministic and never guesses (§21, §46)', () => {
  const PAIR = { from: 'USD', to: 'LBP' } as const;
  const scope = (): { tenantId: string; businessId: string } => ({ tenantId: fx.tenantId, businessId: fx.businessId });

  it('with no rates at all, the answer is a refusal — never an implicit 1.0', async () => {
    const message = await fxRefusal(() => lookupRateAs(scope(), { ...PAIR, at: AT(T2) }));
    expect(message).toMatch(/accounting\.fx_rate_missing/);
    // §46's sharpest line: a foreign pair with no stated rate does NOT
    // convert at one. A system that defaulted to 1 would book a 90,000-fold
    // error in LBP and balance perfectly while doing it.
    expect(message).not.toMatch(/1\.0000000000/);
  });

  it('one rate before the fact is returned, complete (§22)', async () => {
    await enterRate(facts({ key: 'lookup-first-0001', ...PAIR, fromCurrency: 'USD', toCurrency: 'LBP', rate: '89500', effectiveAt: T1 }), fx.userId);
    const snap = await lookupRateAs(scope(), { ...PAIR, at: AT(T2) });
    expect(snap.rate).toBe('89500.0000000000');
    expect(snap.source).toBe('manual');
    expect(snap.effective_at.toISOString()).toBe(new Date(T1).toISOString());
    expect(snap.rate_id).toBe(rateIdFor(fx.businessId, 'lookup-first-0001'));
  });

  it('with several historical rates, the LATEST at or before the fact wins', async () => {
    await enterRate(facts({ key: 'lookup-second-001', fromCurrency: 'USD', toCurrency: 'LBP', rate: '89700', effectiveAt: T2 }), fx.userId);
    await enterRate(facts({ key: 'lookup-zero-0001', fromCurrency: 'USD', toCurrency: 'LBP', rate: '89000', effectiveAt: T0 }), fx.userId);

    expect((await lookupRateAs(scope(), { ...PAIR, at: AT('2026-02-01T00:00:00Z') })).rate).toBe('89000.0000000000');
    expect((await lookupRateAs(scope(), { ...PAIR, at: AT('2026-04-01T00:00:00Z') })).rate).toBe('89500.0000000000');
    expect((await lookupRateAs(scope(), { ...PAIR, at: AT('2026-09-01T00:00:00Z') })).rate).toBe('89700.0000000000');
    // Exactly AT the effective instant, the rate is in force.
    expect((await lookupRateAs(scope(), { ...PAIR, at: AT(T2) })).rate).toBe('89700.0000000000');
  });

  it('a FUTURE rate is ignored, however much closer it is', async () => {
    await enterRate(facts({ key: 'lookup-future-001', fromCurrency: 'USD', toCurrency: 'LBP', rate: '95000', effectiveAt: FUTURE }), fx.userId);
    // A "nearest rate" implementation would return the future one for a fact
    // dated a day before it. This must return the last one already in force.
    expect((await lookupRateAs(scope(), { ...PAIR, at: AT('2026-12-31T23:59:59Z') })).rate).toBe('89700.0000000000');
  });

  it('a fact BEFORE the first rate has no rate', async () => {
    const message = await fxRefusal(() => lookupRateAs(scope(), { ...PAIR, at: AT('2025-06-01T00:00:00Z') }));
    expect(message).toMatch(/accounting\.fx_rate_missing/);
  });

  it('the OPPOSITE pair is never substituted, and never inverted (§19, §20)', async () => {
    const message = await fxRefusal(() => lookupRateAs(scope(), { from: 'LBP', to: 'USD', at: AT(T2) }));
    expect(message).toMatch(/accounting\.fx_rate_missing/);
  });

  it('a cross rate is never inferred from two stated legs (§20)', async () => {
    // USD->EUR and EUR->TRY both exist for this business; USD->TRY at an
    // instant before its own first rate must still be missing. The registry
    // stores stated pairs; it is not an FX graph solver.
    await enterRate(facts({ key: 'cross-usd-eur-001', fromCurrency: 'USD', toCurrency: 'EUR', rate: '0.92', effectiveAt: T0 }), fx.userId);
    await enterRate(facts({ key: 'cross-eur-try-001', fromCurrency: 'EUR', toCurrency: 'TRY', rate: '44.20', effectiveAt: T0 }), fx.userId);
    const message = await fxRefusal(() => lookupRateAs(scope(), { from: 'USD', to: 'TRY', at: AT('2026-02-01T00:00:00Z') }));
    expect(message).toMatch(/accounting\.fx_rate_missing/);
  });

  it('a currency does not convert to itself out of history', async () => {
    const message = await fxRefusal(() => lookupRateAs(scope(), { from: 'ILS', to: 'ILS', at: AT(T2) }));
    expect(message).toMatch(/accounting\.fx_same_currency/);
  });

  it('an unregistered currency is refused rather than answered "missing"', async () => {
    const message = await fxRefusal(() => lookupRateAs(scope(), { from: 'ZZZ', to: 'ILS', at: AT(T2) }));
    expect(message).toMatch(/accounting\.fx_currency_unknown/);
  });

  it('another business in the SAME tenant has its own rates, and cannot see this one’s', async () => {
    await enterRate(
      {
        tenantId: fx.tenantId,
        businessId: siblingBusinessId,
        rateId: rateIdFor(siblingBusinessId, 'sibling-rate-0001'),
        fromCurrency: 'USD',
        toCurrency: 'LBP',
        rate: '90100',
        effectiveAt: T1,
      },
      fx.userId,
    );
    // The sibling sees its own number, not the first business's.
    expect((await lookupRateAs({ tenantId: fx.tenantId, businessId: siblingBusinessId }, { ...PAIR, at: AT(T2) })).rate).toBe('90100.0000000000');
    expect((await lookupRateAs(scope(), { ...PAIR, at: AT(T2) })).rate).toBe('89700.0000000000');

    // And naming the sibling's id from the first business's scope returns
    // nothing — refused by row level security, not by an argument check.
    const message = await fxRefusal(() => lookupRateAs(scope(), { businessId: siblingBusinessId, ...PAIR, at: AT(T2) }));
    expect(message).toMatch(/accounting\.fx_rate_missing/);
  });

  it('another TENANT’s rates are invisible even when its business id is named', async () => {
    const otherUser = fx.otherUserId;
    await enterRate(
      {
        tenantId: fx.otherTenantId,
        businessId: fx.otherBusinessId,
        rateId: rateIdFor(fx.otherBusinessId, 'other-tenant-rate1'),
        fromCurrency: 'USD',
        toCurrency: 'LBP',
        rate: '77777',
        effectiveAt: T1,
      },
      otherUser,
    );
    const message = await fxRefusal(() => lookupRateAs(scope(), { businessId: fx.otherBusinessId, ...PAIR, at: AT(T2) }));
    expect(message).toMatch(/accounting\.fx_rate_missing/);
    expect((await lookupRateAs({ tenantId: fx.otherTenantId, businessId: fx.otherBusinessId }, { ...PAIR, at: AT(T2) })).rate).toBe('77777.0000000000');
  });
});

// ── §23: a lookup is a read ───────────────────────────────────────────────

describe('a lookup changes nothing (§23)', () => {
  it('leaves every row, audit trail and outbox queue exactly as it found them', async () => {
    const before = must(
      (
        await ownerPool().query<{ rates: number; audits: number; outbox: number; digest: string }>(
          `SELECT (SELECT count(*) FROM accounting_fx_rates WHERE business_id = $1)::int AS rates,
                  (SELECT count(*) FROM audit_events  WHERE business_id = $1)::int AS audits,
                  (SELECT count(*) FROM outbox_events WHERE business_id = $1)::int AS outbox,
                  (SELECT md5(string_agg(r.id::text || r.rate::text || r.effective_at::text, '|' ORDER BY r.id))
                   FROM accounting_fx_rates r WHERE r.business_id = $1) AS digest`,
          [fx.businessId],
        )
      ).rows[0],
    );

    for (let i = 0; i < 5; i += 1) {
      await lookupRateAs({ tenantId: fx.tenantId, businessId: fx.businessId }, { from: 'USD', to: 'LBP', at: AT('2026-09-01T00:00:00Z') });
    }

    const after = must(
      (
        await ownerPool().query<{ rates: number; audits: number; outbox: number; digest: string }>(
          `SELECT (SELECT count(*) FROM accounting_fx_rates WHERE business_id = $1)::int AS rates,
                  (SELECT count(*) FROM audit_events  WHERE business_id = $1)::int AS audits,
                  (SELECT count(*) FROM outbox_events WHERE business_id = $1)::int AS outbox,
                  (SELECT md5(string_agg(r.id::text || r.rate::text || r.effective_at::text, '|' ORDER BY r.id))
                   FROM accounting_fx_rates r WHERE r.business_id = $1) AS digest`,
          [fx.businessId],
        )
      ).rows[0],
    );
    expect(after).toEqual(before);
  });

  it('there is no usage column anywhere on the table', async () => {
    // Stated structurally as well as behaviourally: historical truth must not
    // depend on mutable usage metadata, and the way to keep that true is for
    // the column not to exist.
    const cols = (
      await ownerPool().query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'accounting_fx_rates'`)
    ).rows.map((r) => r.column_name);
    expect(cols.sort()).toEqual(
      ['business_id', 'created_at', 'effective_at', 'entered_by_user_id', 'from_currency', 'id', 'rate', 'source', 'tenant_id', 'to_currency'].sort(),
    );
  });
});
