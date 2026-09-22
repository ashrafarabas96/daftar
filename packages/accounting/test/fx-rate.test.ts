import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mintAccountingAssertion, type AccountingAssertionKey } from '../src/assertion';
import {
  ACCTCTL_DOMAIN,
  ACCTCTL_VERSION,
  controlAssertionPreimage,
  mintAccountingControlAssertion,
  splitAccountingControlAssertion,
} from '../src/control-assertion';
import { AccountingError } from '../src/errors';
import { canonicalEnteredRate, computeFxRateFingerprint, deriveFxRateId, fxRateCanonicalStream, type FxRateFacts } from '../src/fx-rate';
import { deriveSourceId } from '../src/sources';

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('expected a value, found none');
  return value;
}

const refusal = (run: () => unknown): AccountingError => {
  try {
    run();
  } catch (e) {
    if (e instanceof AccountingError) return e;
    throw e;
  }
  throw new Error('expected a refusal, got a value');
};

const KEY: AccountingAssertionKey = { kid: 'v1', secret: Buffer.alloc(32, 7) };
const T = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const B = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const U = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const R = '1b4e28ba-2fa1-11d2-9a0c-0305e82c3301';
const FP = 'a'.repeat(64);

// ── §32, §59: one spec, one vector source ─────────────────────────────────

interface Vector {
  name: string;
  why: string;
  facts: {
    tenantId: string;
    businessId: string;
    rateId: string;
    fromCurrency: string;
    toCurrency: string;
    rate: string;
    effectiveAt: string;
    source: 'manual';
  };
  canonicalHex: string;
  fingerprint: string;
}

const vectors = JSON.parse(readFileSync(join(__dirname, '../vectors/fxrate-vectors.json'), 'utf8')) as { spec: string; cases: Vector[] };

const toFacts = (v: Vector): FxRateFacts => ({
  tenantId: v.facts.tenantId,
  businessId: v.facts.businessId,
  rateId: v.facts.rateId,
  fromCurrency: v.facts.fromCurrency,
  toCurrency: v.facts.toCurrency,
  rate: v.facts.rate,
  effectiveAt: new Date(v.facts.effectiveAt),
  source: v.facts.source,
});

describe('fxrate/1 — the canonical FX command fingerprint (§32)', () => {
  it('the vector file is the one the database is tested against', () => {
    expect(vectors.spec).toBe('fxrate/1');
    expect(vectors.cases.length).toBeGreaterThanOrEqual(8);
  });

  for (const v of vectors.cases) {
    it(`${v.name}: ${v.why}`, () => {
      const facts = toFacts(v);
      expect(fxRateCanonicalStream(facts).toString('hex')).toBe(v.canonicalHex);
      expect(computeFxRateFingerprint(facts)).toBe(v.fingerprint);
    });
  }

  it('"1", "1.0" and "1.0000000000" are ONE financial value (§59)', () => {
    const by = new Map(vectors.cases.map((c) => [c.name, c.fingerprint] as const));
    const a = must(by.get('rate-one-bare'));
    expect(must(by.get('rate-one-single-decimal'))).toBe(a);
    expect(must(by.get('rate-one-full-scale'))).toBe(a);
  });

  it('the pair DIRECTION is part of the identity — no silent reciprocal (§19)', () => {
    const facts: FxRateFacts = {
      tenantId: T,
      businessId: B,
      rateId: R,
      fromCurrency: 'USD',
      toCurrency: 'ILS',
      rate: '3.71',
      effectiveAt: new Date('2026-09-22T10:00:00Z'),
      source: 'manual',
    };
    const swapped = { ...facts, fromCurrency: 'ILS', toCurrency: 'USD' };
    expect(computeFxRateFingerprint(facts)).not.toBe(computeFxRateFingerprint(swapped));
  });

  it('every immutable fact changes the digest, and nothing else is in it', () => {
    const facts: FxRateFacts = {
      tenantId: T,
      businessId: B,
      rateId: R,
      fromCurrency: 'USD',
      toCurrency: 'ILS',
      rate: '3.71',
      effectiveAt: new Date('2026-09-22T10:00:00Z'),
      source: 'manual',
    };
    const baseline = computeFxRateFingerprint(facts);
    const mutations: FxRateFacts[] = [
      { ...facts, tenantId: '3f2504e0-4f89-41d3-9a0c-0305e82c3302' },
      { ...facts, businessId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6e' },
      { ...facts, rateId: '1b4e28ba-2fa1-11d2-9a0c-0305e82c3302' },
      { ...facts, fromCurrency: 'EUR' },
      { ...facts, toCurrency: 'TRY' },
      { ...facts, rate: '3.7100000001' },
      { ...facts, effectiveAt: new Date('2026-09-22T10:00:01Z') },
    ];
    for (const m of mutations) expect(computeFxRateFingerprint(m)).not.toBe(baseline);
  });

  it('a same-currency "rate" cannot be fingerprinted at all (§14)', () => {
    expect(
      refusal(() =>
        computeFxRateFingerprint({
          tenantId: T,
          businessId: B,
          rateId: R,
          fromCurrency: 'ILS',
          toCurrency: 'ILS',
          rate: '1',
          effectiveAt: new Date('2026-09-22T10:00:00Z'),
          source: 'manual',
        }),
      ).code,
    ).toBe('accounting.fx_same_currency');
  });

  it('a sub-second instant is refused, never truncated (§16)', () => {
    expect(
      refusal(() =>
        computeFxRateFingerprint({
          tenantId: T,
          businessId: B,
          rateId: R,
          fromCurrency: 'USD',
          toCurrency: 'ILS',
          rate: '3.71',
          effectiveAt: new Date('2026-09-22T10:00:00.250Z'),
          source: 'manual',
        }),
      ).code,
    ).toBe('accounting.payload_invalid');
  });
});

// ── §15: the rate contract, refused rather than rounded ───────────────────

describe('an entered rate is exact or it is refused (§15)', () => {
  it('canonicalizes to exactly ten fraction digits', () => {
    expect(canonicalEnteredRate('3.71')).toBe('3.7100000000');
    expect(canonicalEnteredRate('1')).toBe('1.0000000000');
    expect(canonicalEnteredRate('0.709')).toBe('0.7090000000');
    expect(canonicalEnteredRate(' 0.0000254013 ')).toBe('0.0000254013');
  });

  for (const bad of ['3.7e0', '3.71000000001', '-3.71', 'NaN', 'Infinity', '0', '0.0', '0.0000000000', '', '3,71', '+3.71', '.71', '3.']) {
    it(`refuses ${JSON.stringify(bad)}`, () => {
      expect(refusal(() => canonicalEnteredRate(bad)).code).toBe('accounting.fx_rate_invalid');
    });
  }
});

// ── §33: the rate identity, and why it is not a source identity ───────────

describe('the rate id is derived, stable and domain-separated (§33)', () => {
  it('the same business and key always derive the same rate id', () => {
    expect(deriveFxRateId(B, 'idem-key-001')).toBe(deriveFxRateId(B, 'idem-key-001'));
  });

  it('a different business, or a different key, derives a different id', () => {
    expect(deriveFxRateId(B, 'idem-key-001')).not.toBe(deriveFxRateId(T, 'idem-key-001'));
    expect(deriveFxRateId(B, 'idem-key-001')).not.toBe(deriveFxRateId(B, 'idem-key-002'));
  });

  it('one key never means one identity across two domains', () => {
    // The same business and the same Idempotency-Key. A rate is not a journal
    // source, and the two namespaces must not collide.
    expect(deriveFxRateId(B, 'idem-key-001')).not.toBe(deriveSourceId(B, 'idem-key-001'));
  });

  it('P2-S4 source identities are unchanged by the refactor that added this', () => {
    // A pinned value, computed before `deriveSourceId` was expressed in terms
    // of the shared derivation. If the domain label or the construction ever
    // changes, every adjustment and opening balance ever posted would lose
    // its identity, so this case exists to make that impossible to do
    // quietly.
    expect(deriveSourceId('9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d', 'idem-key-001')).toBe('b06e6cbb-d6c1-5003-b290-816dff33b125');
  });

  it('derives a well-formed uuid', () => {
    expect(deriveFxRateId(B, 'idem-key-001')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

// ── §29, §30: the control format and its domain separation ────────────────

describe('acctctl/1 is a different cryptographic domain (§29, §30)', () => {
  const claims = {
    actorUserId: U,
    tenantId: T,
    businessId: B,
    commandKind: 'fx_rate_enter' as const,
    resourceId: R,
    payloadFingerprint: FP,
  };

  it('mints eleven components beginning acctctl1', () => {
    const parts = splitAccountingControlAssertion(mintAccountingControlAssertion(KEY, claims));
    expect(parts).toHaveLength(11);
    expect(parts[0]).toBe(ACCTCTL_VERSION);
    expect(must(parts[5])).toBe('fx_rate_enter');
  });

  it('the MAC covers the domain prefix, so the posting preimage does NOT verify it', () => {
    const raw = mintAccountingControlAssertion(KEY, claims);
    const parts = splitAccountingControlAssertion(raw);
    const signed = parts.slice(0, 10);

    const withDomain = createHmac('sha256', KEY.secret).update(controlAssertionPreimage(signed), 'utf8').digest('hex');
    const withoutDomain = createHmac('sha256', KEY.secret).update(signed.join('.'), 'utf8').digest('hex');

    expect(must(parts[10])).toBe(withDomain);
    // This is §30's real content: the separation is not the component count.
    // Re-sign the IDENTICAL claims the way the posting format signs, and the
    // result is a different MAC, so a verifier that omitted the prefix would
    // accept a string this one refuses and vice versa.
    expect(withoutDomain).not.toBe(withDomain);
  });

  it('no posting preimage can equal a control preimage', () => {
    // A posting assertion's signed components are UUIDs, hex, digits and
    // [a-z_] words joined by dots; its preimage therefore contains neither a
    // forward slash nor a newline, and the control preimage begins with both.
    const posting = mintAccountingAssertion(KEY, {
      actorUserId: U,
      tenantId: T,
      businessId: B,
      operationKind: 'post',
      sourceType: 'manual_adjustment',
      sourceId: R,
      postingFingerprint: FP,
    });
    const postingPreimage = posting.split('.').slice(0, 11).join('.');
    expect(postingPreimage.includes('/')).toBe(false);
    expect(postingPreimage.includes('\n')).toBe(false);
    expect(controlAssertionPreimage(splitAccountingControlAssertion(mintAccountingControlAssertion(KEY, claims)).slice(0, 10))).toContain(
      `${ACCTCTL_DOMAIN}\n`,
    );
  });

  it('a posting assertion is not a control assertion, structurally either', () => {
    const posting = mintAccountingAssertion(KEY, {
      actorUserId: U,
      tenantId: T,
      businessId: B,
      operationKind: 'post',
      sourceType: 'manual_adjustment',
      sourceId: R,
      postingFingerprint: FP,
    });
    expect(refusal(() => splitAccountingControlAssertion(posting)).code).toBe('accounting.assertion_malformed');
  });

  it('refuses an unregistered command kind, a bad fingerprint and an over-long ttl', () => {
    expect(refusal(() => mintAccountingControlAssertion(KEY, { ...claims, commandKind: 'fx_rate_delete' as never })).code).toBe(
      'accounting.assertion_malformed',
    );
    expect(refusal(() => mintAccountingControlAssertion(KEY, { ...claims, payloadFingerprint: 'nope' })).code).toBe('accounting.assertion_malformed');
    expect(refusal(() => mintAccountingControlAssertion(KEY, claims, new Date(), 61)).code).toBe('accounting.assertion_malformed');
  });

  it('expires sixty seconds after minting, and not later', () => {
    const at = new Date('2026-09-22T10:00:00Z');
    const parts = splitAccountingControlAssertion(mintAccountingControlAssertion(KEY, claims, at));
    expect(Number(must(parts[8]))).toBe(Math.floor(at.getTime() / 1000) + 60);
  });
});
