import { randomUUID, createHmac } from 'node:crypto';
import { Client } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { ACCTCTL_VERSION, splitAccountingControlAssertion } from '../../packages/accounting/src/control-assertion';
import {
  accountingAssertionKey,
  appDbUrl,
  ensurePostgres,
  identityDbUrl,
  ownerPool,
  platformDbUrl,
  provisionerDbUrl,
  resetData,
  resolverDbUrl,
  workerDbUrl,
} from '../helpers/test-app';
import { must, seedPostingFixture, sourceAssertion, type PostingFixture } from '../helpers/accounting-posting';
import { controlAssertion, enterRate, enterRateAs, fxFingerprintOf, fxRefusal, rateIdFor, type RateFacts } from '../helpers/accounting-fx';

/**
 * FX AUTHORITY — WHAT A STOLEN CREDENTIAL BUYS (directive §25, §27, §30,
 * §60-§62, §67).
 *
 * The premise of every case here is that the attacker HAS the `daftar_app`
 * database password. That is the threat AL-03 was written for, and the answer
 * has to be the same for configuration as it is for posting: a caller-settable
 * GUC is not authorization, and the only thing that authorizes a rate entry is
 * an assertion signed with key material no runtime role can read.
 *
 * §30 gets its own section. Two assertion formats on one secret are only
 * separate if the separation is CRYPTOGRAPHIC, so the cases below do not stop
 * at "the parser rejected it": they re-sign the same claims the other format's
 * way and require the verifier to refuse that too.
 */

let fx: PostingFixture;

const T1 = '2026-03-01T00:00:00Z';

const ROLE_URLS: Readonly<Record<string, string>> = {
  daftar_app: appDbUrl,
  daftar_platform: platformDbUrl,
  daftar_worker: workerDbUrl,
  daftar_identity: identityDbUrl,
  daftar_resolver: resolverDbUrl,
  daftar_provisioner: provisionerDbUrl,
};

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  fx = await seedPostingFixture(ownerPool(), `fxauth-${Math.floor(Math.random() * 1e6)}`);
}, 180_000);

const facts = (over: Partial<RateFacts> & { key: string }): RateFacts => ({
  tenantId: over.tenantId ?? fx.tenantId,
  businessId: over.businessId ?? fx.businessId,
  rateId: rateIdFor(over.businessId ?? fx.businessId, over.key),
  fromCurrency: over.fromCurrency ?? 'USD',
  toCurrency: over.toCurrency ?? 'ILS',
  rate: over.rate ?? '3.71',
  effectiveAt: over.effectiveAt ?? T1,
});

const rateCount = async (businessId: string): Promise<number> =>
  must((await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM accounting_fx_rates WHERE business_id = $1`, [businessId])).rows[0]).n;

// ── §25, §67: the privilege boundary, attempted for real ──────────────────

describe('no runtime credential can write the rate history (§25, §67)', () => {
  it('every login role is refused INSERT, UPDATE, DELETE and TRUNCATE at the boundary', async () => {
    for (const [role, url] of Object.entries(ROLE_URLS)) {
      const client = new Client({ connectionString: url });
      await client.connect();
      try {
        const statements = [
          `INSERT INTO accounting_fx_rates (tenant_id, business_id, id, from_currency, to_currency, rate, effective_at, entered_by_user_id)
           VALUES ('${fx.tenantId}', '${fx.businessId}', gen_random_uuid(), 'USD', 'ILS', 3.71, '${T1}', '${fx.userId}')`,
          `UPDATE accounting_fx_rates SET rate = 1`,
          `DELETE FROM accounting_fx_rates`,
          `TRUNCATE accounting_fx_rates`,
        ];
        for (const sql of statements) {
          await expect(client.query(sql), `${role} must not write accounting_fx_rates`).rejects.toThrow(/permission denied/);
        }
      } finally {
        await client.end();
      }
    }
  });

  it('only the merchant runtime may EXECUTE either FX routine, and PUBLIC may execute neither', async () => {
    const { rows } = await ownerPool().query<{ role: string; routine: string; allowed: boolean }>(
      `SELECT r.rolname AS role, f.sig AS routine, has_function_privilege(r.rolname, f.sig, 'EXECUTE') AS allowed
         FROM unnest($1::text[]) AS r(rolname)
         CROSS JOIN unnest(ARRAY['accounting_fx_rate_enter(text,text,text,timestamptz,text)',
                                 'accounting_fx_rate_lookup(uuid,text,text,timestamptz)']) AS f(sig)`,
      [[...Object.keys(ROLE_URLS), 'public']],
    );
    for (const row of rows) {
      expect(row.allowed, `${row.role} on ${row.routine}`).toBe(row.role === 'daftar_app');
    }
  });

  it('no runtime role can reach the control verifier directly', async () => {
    for (const [role, url] of Object.entries(ROLE_URLS)) {
      const client = new Client({ connectionString: url });
      await client.connect();
      try {
        await expect(client.query(`SELECT accounting_control_actor(ARRAY['fx_rate_enter'])`), role).rejects.toThrow(/permission denied/);
      } finally {
        await client.end();
      }
    }
  });
});

// ── §27, §60: a stolen credential, with every GUC it likes ────────────────

describe('a stolen daftar_app credential cannot enter a rate (§27, §60)', () => {
  it('with no assertion at all, the command refuses by name', async () => {
    const before = await rateCount(fx.businessId);
    const message = await fxRefusal(() => enterRateAs(null, { fromCurrency: 'USD', toCurrency: 'ILS', rate: '3.71', effectiveAt: T1 }));
    expect(message).toMatch(/accounting\.assertion_missing/);
    expect(await rateCount(fx.businessId)).toBe(before);
  });

  it('setting every isolation GUC to the victim’s own values changes nothing', async () => {
    const before = await rateCount(fx.businessId);
    const message = await fxRefusal(() =>
      enterRateAs(
        null,
        { fromCurrency: 'USD', toCurrency: 'ILS', rate: '3.71', effectiveAt: T1 },
        {
          'app.tenant_id': fx.tenantId,
          'app.business_id': fx.businessId,
          'app.actor_user_id': fx.userId,
          'app.bypass_rls': 'true',
        },
      ),
    );
    // The GUCs are not even consulted: the refusal is the missing assertion.
    expect(message).toMatch(/accounting\.assertion_missing/);
    expect(await rateCount(fx.businessId)).toBe(before);
  });

  it('a rate entered under a genuine assertion IGNORES contradictory GUCs entirely (§37)', async () => {
    // The GUCs name the OTHER tenant, the OTHER business and the OTHER user.
    // Every one of the three is overridden by the signed claim.
    const f = facts({ key: 'guc-ignored-00001' });
    await enterRateAs(
      controlAssertion({
        actorUserId: fx.userId,
        tenantId: fx.tenantId,
        businessId: fx.businessId,
        commandKind: 'fx_rate_enter',
        resourceId: f.rateId,
        payloadFingerprint: fxFingerprintOf(f),
      }),
      { fromCurrency: f.fromCurrency, toCurrency: f.toCurrency, rate: f.rate, effectiveAt: f.effectiveAt },
      { 'app.tenant_id': fx.otherTenantId, 'app.business_id': fx.otherBusinessId, 'app.actor_user_id': fx.otherUserId },
    );
    const row = must(
      (
        await ownerPool().query<{ tenant_id: string; business_id: string; entered_by_user_id: string }>(
          `SELECT tenant_id, business_id, entered_by_user_id FROM accounting_fx_rates WHERE id = $1`,
          [f.rateId],
        )
      ).rows[0],
    );
    expect(row).toEqual({ tenant_id: fx.tenantId, business_id: fx.businessId, entered_by_user_id: fx.userId });
    expect(await rateCount(fx.otherBusinessId)).toBe(0);
  });
});

// ── §61: the tamper matrix ────────────────────────────────────────────────

describe('every signed claim is bound — the tamper matrix (§61)', () => {
  const tampered = async (mutate: (parts: string[]) => string[], key = 'tamper-base-00001'): Promise<string> => {
    const f = facts({ key });
    const raw = controlAssertion({
      actorUserId: fx.userId,
      tenantId: fx.tenantId,
      businessId: fx.businessId,
      commandKind: 'fx_rate_enter',
      resourceId: f.rateId,
      payloadFingerprint: fxFingerprintOf(f),
    });
    const parts = mutate(splitAccountingControlAssertion(raw));
    return fxRefusal(() => enterRateAs(parts.join('.'), { fromCurrency: f.fromCurrency, toCurrency: f.toCurrency, rate: f.rate, effectiveAt: f.effectiveAt }));
  };

  const swap =
    (index: number, value: string) =>
    (parts: string[]): string[] => {
      const copy = [...parts];
      copy[index] = value;
      return copy;
    };

  const CASES: ReadonlyArray<readonly [string, (p: string[]) => string[]]> = [
    ['the actor', swap(2, randomUUID())],
    ['the tenant', swap(3, randomUUID())],
    ['the business', swap(4, randomUUID())],
    ['the command kind', swap(5, 'fx_rate_delete')],
    ['the rate id', swap(6, randomUUID())],
    ['the payload fingerprint', swap(7, 'b'.repeat(64))],
    ['the expiry', (p): string[] => swap(8, String(Number(p[8]) + 3600))(p)],
    ['the jti', swap(9, randomUUID())],
    ['the signature', swap(10, 'c'.repeat(64))],
    ['the version prefix', swap(0, 'acctctl2')],
  ];

  for (const [what, mutate] of CASES) {
    it(`rewriting ${what} is refused`, async () => {
      const before = await rateCount(fx.businessId);
      const message = await tampered(mutate);
      expect(message).toMatch(/accounting\.assertion_(invalid_signature|malformed|wrong_operation)/);
      expect(await rateCount(fx.businessId)).toBe(before);
    });
  }

  it('changing the PAYLOAD under a valid assertion is refused as a mismatch', async () => {
    const f = facts({ key: 'payload-mismatch-1' });
    const assertion = controlAssertion({
      actorUserId: fx.userId,
      tenantId: fx.tenantId,
      businessId: fx.businessId,
      commandKind: 'fx_rate_enter',
      resourceId: f.rateId,
      payloadFingerprint: fxFingerprintOf(f),
    });
    // Same signed rate id, different rate. The fingerprint is what binds the
    // authority to the numbers, so this is where that binding is proved.
    const message = await fxRefusal(() => enterRateAs(assertion, { fromCurrency: 'USD', toCurrency: 'ILS', rate: '9.99', effectiveAt: T1 }));
    expect(message).toMatch(/accounting\.assertion_payload_mismatch/);

    const swappedPair = await fxRefusal(() => enterRateAs(assertion, { fromCurrency: 'ILS', toCurrency: 'USD', rate: f.rate, effectiveAt: T1 }));
    expect(swappedPair).toMatch(/accounting\.assertion_payload_mismatch/);

    const movedInstant = await fxRefusal(() =>
      enterRateAs(assertion, { fromCurrency: 'USD', toCurrency: 'ILS', rate: f.rate, effectiveAt: '2026-03-01T00:00:01Z' }),
    );
    expect(movedInstant).toMatch(/accounting\.assertion_payload_mismatch/);
  });
});

// ── §62, §31: expiry and replay ───────────────────────────────────────────

describe('a control assertion is short-lived and single-transaction (§31, §62)', () => {
  it('expires sixty seconds after minting', async () => {
    const f = facts({ key: 'expired-assert-01' });
    const stale = controlAssertion(
      {
        actorUserId: fx.userId,
        tenantId: fx.tenantId,
        businessId: fx.businessId,
        commandKind: 'fx_rate_enter',
        resourceId: f.rateId,
        payloadFingerprint: fxFingerprintOf(f),
      },
      new Date(Date.now() - 120_000),
    );
    const message = await fxRefusal(() =>
      enterRateAs(stale, { fromCurrency: f.fromCurrency, toCurrency: f.toCurrency, rate: f.rate, effectiveAt: f.effectiveAt }),
    );
    expect(message).toMatch(/accounting\.assertion_expired/);
  });

  it('a second TRANSACTION presenting the same assertion is a replay', async () => {
    // Its own instant: §34 makes an identical rate for the same pair at the
    // same instant an idempotent replay under ANY key, which would mask the
    // assertion-replay refusal this case is about.
    const f = facts({ key: 'replayed-assert-1', effectiveAt: '2026-04-01T00:00:00Z' });
    const assertion = controlAssertion({
      actorUserId: fx.userId,
      tenantId: fx.tenantId,
      businessId: fx.businessId,
      commandKind: 'fx_rate_enter',
      resourceId: f.rateId,
      payloadFingerprint: fxFingerprintOf(f),
    });
    const payload = { fromCurrency: f.fromCurrency, toCurrency: f.toCurrency, rate: f.rate, effectiveAt: f.effectiveAt };
    expect((await enterRateAs(assertion, payload)).created).toBe(true);
    expect(await fxRefusal(() => enterRateAs(assertion, payload))).toMatch(/accounting\.assertion_replayed/);
  });

  it('a retired key cannot mint anything the verifier will accept', async () => {
    // Retirement is the operational answer to a compromise, so it has to
    // work for the control format too and not only for the posting one.
    // A kid of its own per run: retirement is TERMINAL, so a fixed one would
    // pass the first time and fail as `assertion_key_conflict` on every
    // re-run against the same cluster.
    const kid = `fxret${Math.floor(Math.random() * 1e6)}`;
    await ownerPool().query(`SELECT accounting_assertion_key_install($1, decode($2, 'base64'))`, [kid, Buffer.alloc(32, 9).toString('base64')]);
    await ownerPool().query(`SELECT accounting_assertion_key_retire($1)`, [kid]);

    const f = facts({ key: 'retired-key-00001', effectiveAt: '2026-04-03T00:00:00Z' });
    const parts = splitAccountingControlAssertion(
      controlAssertion({
        actorUserId: fx.userId,
        tenantId: fx.tenantId,
        businessId: fx.businessId,
        commandKind: 'fx_rate_enter',
        resourceId: f.rateId,
        payloadFingerprint: fxFingerprintOf(f),
      }),
    );
    const signed = [...parts.slice(0, 10)];
    signed[1] = kid;
    const mac = createHmac('sha256', Buffer.alloc(32, 9))
      .update(`acctctl/1\n${signed.join('.')}`, 'utf8')
      .digest('hex');
    const message = await fxRefusal(() =>
      enterRateAs([...signed, mac].join('.'), { fromCurrency: f.fromCurrency, toCurrency: f.toCurrency, rate: f.rate, effectiveAt: f.effectiveAt }),
    );
    expect(message).toMatch(/accounting\.assertion_key_unknown/);
  });
});

// ── §30: cross-protocol substitution, in BOTH directions ──────────────────

describe('the two assertion formats are cryptographically separate (§30)', () => {
  it('a valid POSTING assertion is not accepted by the FX verifier', async () => {
    const before = await rateCount(fx.businessId);
    const f = facts({ key: 'cross-posting-001' });
    const posting = sourceAssertion({
      actorUserId: fx.userId,
      tenantId: fx.tenantId,
      businessId: fx.businessId,
      operationKind: 'post',
      sourceType: 'manual_adjustment',
      sourceId: f.rateId,
      postingFingerprint: fxFingerprintOf(f),
    });
    const message = await fxRefusal(() =>
      enterRateAs(posting, { fromCurrency: f.fromCurrency, toCurrency: f.toCurrency, rate: f.rate, effectiveAt: f.effectiveAt }),
    );
    expect(message).toMatch(/accounting\.assertion_malformed/);
    expect(await rateCount(fx.businessId)).toBe(before);
  });

  it('a valid CONTROL assertion drives neither accounting_post_entry nor accounting_post_reversal', async () => {
    const f = facts({ key: 'cross-control-001' });
    const control = controlAssertion({
      actorUserId: fx.userId,
      tenantId: fx.tenantId,
      businessId: fx.businessId,
      commandKind: 'fx_rate_enter',
      resourceId: f.rateId,
      payloadFingerprint: fxFingerprintOf(f),
    });

    const conn = new Client({ connectionString: appDbUrl });
    await conn.connect();
    try {
      // Both GUCs, so the posting primitive cannot claim it simply never saw
      // the value: the control assertion is offered to it directly.
      await conn.query('BEGIN');
      await conn.query(`SELECT set_config('app.accounting_assertion', $1, true)`, [control]);
      await expect(
        conn.query(`SELECT entry_id, created FROM accounting_post_entry($1::date, $2, $3, $4::jsonb)`, ['2026-03-01', 'x', null, '[]']),
      ).rejects.toThrow(/accounting\.assertion_malformed/);
      await conn.query('ROLLBACK');

      await conn.query('BEGIN');
      await conn.query(`SELECT set_config('app.accounting_assertion', $1, true)`, [control]);
      await expect(
        conn.query(`SELECT entry_id, created FROM accounting_post_reversal($1::uuid, $2::date, $3, $4)`, [randomUUID(), '2026-03-01', 'why', null]),
      ).rejects.toThrow(/accounting\.assertion_malformed/);
      await conn.query('ROLLBACK');
    } finally {
      await conn.end().catch(() => undefined);
    }
  });

  it('the separation is the DOMAIN PREFIX, not the component count', async () => {
    // This is §30's real content. Take the control format's exact ten claims
    // — right shape, right count, right version component — and sign them the
    // way the POSTING format signs, with no domain prefix. A verifier that
    // separated the formats only by parsing would accept this.
    const f = facts({ key: 'cross-domain-0001', effectiveAt: '2026-04-02T00:00:00Z' });
    const parts = splitAccountingControlAssertion(
      controlAssertion({
        actorUserId: fx.userId,
        tenantId: fx.tenantId,
        businessId: fx.businessId,
        commandKind: 'fx_rate_enter',
        resourceId: f.rateId,
        payloadFingerprint: fxFingerprintOf(f),
      }),
    );
    const signed = parts.slice(0, 10);
    expect(signed[0]).toBe(ACCTCTL_VERSION);
    const undomained = createHmac('sha256', accountingAssertionKey().secret).update(signed.join('.'), 'utf8').digest('hex');

    const before = await rateCount(fx.businessId);
    const message = await fxRefusal(() =>
      enterRateAs([...signed, undomained].join('.'), { fromCurrency: f.fromCurrency, toCurrency: f.toCurrency, rate: f.rate, effectiveAt: f.effectiveAt }),
    );
    expect(message).toMatch(/accounting\.assertion_invalid_signature/);
    expect(await rateCount(fx.businessId)).toBe(before);

    // And the control assertion, correctly domained, is accepted — so the
    // case above failed for the prefix and not because the claims were bad.
    expect((await enterRate(f, fx.userId)).created).toBe(true);
  });
});
