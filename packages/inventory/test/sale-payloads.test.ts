/**
 * P4-S2 — THE `sale.commit` PAYLOAD AND INTENT, PROVED WITHOUT A DATABASE
 * (docs/PHASE_4_S2_CONTRACT.md A-05, A-06, A-08, A-09; lock P4-AL-18,
 * P4-AL-25, P4-AL-30, P4-AL-44).
 *
 * These are the tests the contract can run BEFORE migration `0077` exists.
 * They are not a rehearsal of the database's checks: each one is about a
 * property the builder alone can get wrong, and every one of them has cost
 * this project or another one real time.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InventoryError } from '../src/errors';
import { canonicalInventoryIntent, INVENTORY_OPERATION_INTENT_FIELDS, INVENTORY_PAYLOAD_SCHEMAS, inventoryIntentSchema } from '../src/payload';
import { saleCommitIntentSha256, saleCommitPayload, SALE_DOMESTIC_RATE_R10, type SaleCommitPayloadInput } from '../src/sale-payloads';

const T = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const SALE = '33333333-3333-4333-8333-333333333333';
const CUST = '44444444-4444-4444-8444-444444444444';
const WH = '55555555-5555-4555-8555-555555555555';
const BRANCH = '66666666-6666-4666-8666-666666666666';
const INV = '77777777-7777-4777-8777-777777777777';
const L1 = '88888888-8888-4888-8888-888888888888';
const P1 = '99999999-9999-4999-8999-999999999999';
// The RESOLVED stock key of P1: its hidden base variant, which the client
// never names (P3-AL-52) and the server resolves.
const V1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const L2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const P2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
// A product WITH merchant variants: the line names M2 and the stock key is M2.
const M2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const V2 = M2;
const RATE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/**
 * A two-line domestic sale: 2 x 500 and 1 x 300, 50 off the first line.
 * `subtotal = 1300`, `discount = 50`, `total = 1250`, base = txn (domestic),
 * and the base shares are the exact integer partition `950 + 300`.
 */
function base(): SaleCommitPayloadInput {
  return {
    tenantId: T,
    businessId: B,
    saleId: SALE,
    settlementMode: 'credit',
    customerId: CUST,
    warehouseId: WH,
    branchId: BRANCH,
    invoiceId: INV,
    documentDate: '2026-03-04',
    dueDate: '2026-04-03',
    currency: 'USD',
    rate: { rateId: null, rateR10: SALE_DOMESTIC_RATE_R10, source: 'base', rateAtEpochSeconds: 1772582400n },
    taxMinor: 0n,
    notes: 'counter sale',
    subtotalTxnMinor: 1300n,
    discountTxnMinor: 50n,
    totalTxnMinor: 1250n,
    totalBaseMinor: 1250n,
    lines: [
      { lineId: L1, productId: P1, merchantVariantId: null, variantId: V1, qtyQ4: 20_000n, discountMinor: 50n, unitPriceC10: 500n * 10n ** 10n, netTxnMinor: 950n, baseShareMinor: 950n },
      { lineId: L2, productId: P2, merchantVariantId: M2, variantId: V2, qtyQ4: 10_000n, discountMinor: 0n, unitPriceC10: 300n * 10n ** 10n, netTxnMinor: 300n, baseShareMinor: 300n },
    ],
  };
}

const refusal = (fn: () => unknown): InventoryError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof InventoryError) return e;
    throw e;
  }
  throw new Error('expected a refusal');
};

describe('sale.commit — the payload builds, and its digests are what they claim', () => {
  it('builds, and the payload digest is the SHA-256 of the exact bytes', () => {
    const built = saleCommitPayload(base());
    expect(built.payload.opCode).toBe('sale.commit');
    expect(built.payload.sha256).toBe(createHash('sha256').update(built.payload.bytes).digest('hex'));
    expect(built.intentSha256).toMatch(/^[0-9a-f]{64}$/);
    // The payload digest and the intent digest are different streams over
    // different schemas. A builder that returned one for both would make the
    // idempotency proof and the authority the same fact.
    expect(built.intentSha256).not.toBe(built.payload.sha256);
  });

  it('the stream is the header, the notes words and nine fields per line, every line LF-terminated', () => {
    const built = saleCommitPayload(base());
    const header = INVENTORY_PAYLOAD_SCHEMAS['sale.commit'];
    const perLine = header.repeat?.fields.length ?? 0;
    expect(perLine).toBe(9);
    // 'invpl/1', op code, tenant, business, then the fields.
    const lines = built.payload.bytes.toString('latin1').split('\n');
    expect(lines[lines.length - 1]).toBe(''); // the last field is LF-terminated too
    expect(lines.length - 1).toBe(4 + header.length + 2 * perLine);
  });
});

describe('P4-AL-30 — the intent is the CLIENT request, computable before any state is read', () => {
  it('the intent digest equals the digest of the intent stream over the client fields alone', () => {
    const i = base();
    const words = Array.from({ length: 8 }, (_, k) => BigInt(createHash('sha256').update(Buffer.from('counter sale', 'utf8')).digest().readUInt32BE(k * 4)));
    const bytes = canonicalInventoryIntent('sale.commit', T, B, [
      { kind: 'uuid', value: SALE },
      { kind: 'code', value: 'credit' },
      { kind: 'uuid', value: CUST },
      { kind: 'uuid', value: WH },
      { kind: 'integer', value: 20_260_304n },
      { kind: 'integer', value: 20_260_403n },
      { kind: 'integer', value: 0n },
      ...words.map((w) => ({ kind: 'integer' as const, value: w })),
      { kind: 'integer', value: 2n },
      { kind: 'uuid', value: L1 },
      { kind: 'uuid', value: P1 },
      // A simple product's line states NO variant: the base variant is the
      // server's, so the intent carries NULL where the payload carries the
      // resolved key.
      { kind: 'null' },
      { kind: 'integer', value: 20_000n },
      { kind: 'integer', value: 50n },
      { kind: 'uuid', value: L2 },
      { kind: 'uuid', value: P2 },
      { kind: 'uuid', value: M2 },
      { kind: 'integer', value: 10_000n },
      { kind: 'integer', value: 0n },
    ]);
    expect(saleCommitIntentSha256(i)).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('NO server-resolved figure is in the intent: the branch, the invoice id, the currency, the FX snapshot, every total, the price, the net and the share are all outside it', () => {
    // THIS is the test that matters. A replay must be the same command even
    // though the catalogue price, the rate and the stock have all moved
    // since. A fingerprint covering the resolved price would turn every
    // price change into a false `sale.idempotency_conflict`.
    const intent = inventoryIntentSchema('sale.commit');
    const names = [...intent.map((s) => s.name), ...(intent.repeat?.fields.map((s) => s.name) ?? [])];
    for (const derived of [
      'branch_id',
      'invoice_id',
      'currency',
      'rate_id',
      'rate_r10',
      'rate_source',
      'rate_at',
      'subtotal_txn_minor',
      'discount_txn_minor',
      'total_txn_minor',
      'total_base_minor',
      'unit_price_c10',
      'net_txn_minor',
      'base_share_minor',
      // The RESOLVED stock key. A simple product's stock lives on a hidden
      // base variant the client never sees (P3-AL-52), so the resolved key
      // cannot be part of a fingerprint that must be computable from the
      // request alone, before the catalogue is read.
      'variant_id',
    ]) {
      expect(names, `${derived} must not be part of the sale's intent`).not.toContain(derived);
    }
    // And every field the client DOES state is in it.
    expect(names).toEqual(INVENTORY_OPERATION_INTENT_FIELDS['sale.commit']);
  });

  it('the same request has the SAME intent digest when the server resolves a DIFFERENT stock variant', () => {
    // A product reconfigured from simple to varianted resolves to a different
    // stock key for the same stated line. The command the client sent did not
    // change, so neither may its proof: if it did, a retry of an in-flight
    // sale would be refused as a conflict it never caused.
    const a = base();
    const b: SaleCommitPayloadInput = {
      ...a,
      lines: a.lines.map((l) => ({ ...l, variantId: l.variantId === V1 ? RATE : l.variantId })),
    };
    expect(saleCommitIntentSha256(b)).toBe(saleCommitIntentSha256(a));
    // and the PAYLOAD digest does change, because the authority is over the
    // stock key the movement will actually touch.
    expect(saleCommitPayload(b).payload.sha256).not.toBe(saleCommitPayload(a).payload.sha256);
  });

  it('the STATED identity is in the intent: a different product, or a variant where there was none, is a different command', () => {
    const a = base();
    for (const change of [
      { productId: RATE },
      { merchantVariantId: M2 },
    ] as const) {
      const b: SaleCommitPayloadInput = { ...a, lines: [{ ...(a.lines[0] as SaleCommitPayloadInput['lines'][number]), ...change }, a.lines[1] as SaleCommitPayloadInput['lines'][number]] };
      expect(saleCommitIntentSha256(b), JSON.stringify(Object.keys(change))).not.toBe(saleCommitIntentSha256(a));
    }
  });

  it('the same request with a different resolved price, rate, branch or invoice id has the SAME intent digest', () => {
    const a = base();
    const b: SaleCommitPayloadInput = {
      ...a,
      branchId: WH, // a different (still valid) uuid
      invoiceId: RATE,
      currency: 'EUR',
      rate: { rateId: RATE, rateR10: 11n * 10n ** 9n, source: 'manual', rateAtEpochSeconds: 1772668799n },
      subtotalTxnMinor: 2600n,
      discountTxnMinor: 100n,
      totalTxnMinor: 2500n,
      totalBaseMinor: 2750n,
      lines: [
        { lineId: L1, productId: P1, merchantVariantId: null, variantId: V1, qtyQ4: 20_000n, discountMinor: 50n, unitPriceC10: 1000n * 10n ** 10n, netTxnMinor: 1900n, baseShareMinor: 2090n },
        { lineId: L2, productId: P2, merchantVariantId: M2, variantId: V2, qtyQ4: 10_000n, discountMinor: 0n, unitPriceC10: 600n * 10n ** 10n, netTxnMinor: 600n, baseShareMinor: 660n },
      ],
    };
    // The one thing the client stated that changed is nothing: note the
    // per-line `discountMinor` and `qtyQ4` are identical.
    expect(saleCommitIntentSha256(b)).toBe(saleCommitIntentSha256(a));
    // …and the PAYLOAD digests differ, because the authority is over the
    // figures the routine will actually write.
    expect(saleCommitPayload(b).payload.sha256).not.toBe(saleCommitPayload(a).payload.sha256);
  });

  it('a change to any client-stated field changes the intent digest', () => {
    const a = base();
    const d = saleCommitIntentSha256(a);
    expect(saleCommitIntentSha256({ ...a, customerId: WH })).not.toBe(d);
    expect(saleCommitIntentSha256({ ...a, warehouseId: CUST })).not.toBe(d);
    expect(saleCommitIntentSha256({ ...a, documentDate: '2026-03-05' })).not.toBe(d);
    expect(saleCommitIntentSha256({ ...a, dueDate: null })).not.toBe(d);
    expect(saleCommitIntentSha256({ ...a, notes: null })).not.toBe(d);
    expect(saleCommitIntentSha256({ ...a, notes: 'counter  sale' })).not.toBe(d);
    expect(
      saleCommitIntentSha256({
        ...a,
        lines: [{ ...(a.lines[0] as (typeof a.lines)[number]), qtyQ4: 30_000n }, a.lines[1] as (typeof a.lines)[number]],
      }),
    ).not.toBe(d);
    expect(
      saleCommitIntentSha256({
        ...a,
        lines: [{ ...(a.lines[0] as (typeof a.lines)[number]), discountMinor: 60n }, a.lines[1] as (typeof a.lines)[number]],
      }),
    ).not.toBe(d);
    // The line ORDER is part of the intent: two lines swapped are a different
    // document, with different line numbers on the printed invoice.
    expect(saleCommitIntentSha256({ ...a, lines: [a.lines[1] as (typeof a.lines)[number], a.lines[0] as (typeof a.lines)[number]] })).not.toBe(d);
  });

  it('a different tenant or business is a different intent, even with the same sale id', () => {
    const a = base();
    expect(saleCommitIntentSha256({ ...a, tenantId: B })).not.toBe(saleCommitIntentSha256(a));
    expect(saleCommitIntentSha256({ ...a, businessId: T })).not.toBe(saleCommitIntentSha256(a));
  });
});

describe('the builder reads no clock', () => {
  it('the dates are required arguments, and the same input gives the same digests forever', () => {
    const first = saleCommitPayload(base());
    const second = saleCommitPayload(base());
    expect(second.payload.sha256).toBe(first.payload.sha256);
    expect(second.intentSha256).toBe(first.intentSha256);
    // No field of the stream is a clock value: the only instant in it is the
    // BOUND rate instant, which comes from the registry row, and the only
    // dates are the two the caller supplied.
    const header = INVENTORY_PAYLOAD_SCHEMAS['sale.commit'];
    expect(header.map((s) => s.name).filter((n) => /now|current|today|created|wall/.test(n))).toEqual([]);
  });

  it('a malformed or impossible date is refused, never coerced', () => {
    expect(refusal(() => saleCommitIntentSha256({ ...base(), documentDate: '2026-02-30' })).code).toBe('inventory.payload_invalid');
    expect(refusal(() => saleCommitIntentSha256({ ...base(), documentDate: '04/03/2026' })).code).toBe('inventory.payload_invalid');
  });
});

describe('P4-AL-44 / OD-03 — the tax boundary, refused before any assertion is minted', () => {
  it('a non-zero tax is refused with the one code, by the intent digest and by the payload', () => {
    expect(refusal(() => saleCommitIntentSha256({ ...base(), taxMinor: 1n })).code).toBe('sale.tax_policy_absent');
    expect(refusal(() => saleCommitPayload({ ...base(), taxMinor: 1n, totalTxnMinor: 1251n, totalBaseMinor: 1251n })).code).toBe(
      'sale.tax_policy_absent',
    );
  });

  it('zero is accepted, and it is the only accepted value', () => {
    expect(() => saleCommitPayload(base())).not.toThrow();
    expect(refusal(() => saleCommitIntentSha256({ ...base(), taxMinor: -1n })).code).toBe('sale.tax_policy_absent');
  });
});

describe('the arithmetic the builder refuses, so no assertion is minted over figures the database would reject', () => {
  it('a total that is not subtotal - discount + tax is refused', () => {
    expect(refusal(() => saleCommitPayload({ ...base(), totalTxnMinor: 1251n, totalBaseMinor: 1251n })).code).toBe('inventory.payload_invalid');
  });

  it('a discount greater than the subtotal is refused', () => {
    expect(refusal(() => saleCommitPayload({ ...base(), discountTxnMinor: 1400n, totalTxnMinor: -100n })).code).toBe('inventory.payload_invalid');
  });

  it('a sale discounted to nothing is refused as `sale.total_zero`, because an invoice total of zero is not representable', () => {
    const z: SaleCommitPayloadInput = {
      ...base(),
      discountTxnMinor: 1300n,
      totalTxnMinor: 0n,
      totalBaseMinor: 0n,
      lines: [
        { lineId: L1, productId: P1, merchantVariantId: null, variantId: V1, qtyQ4: 20_000n, discountMinor: 1000n, unitPriceC10: 500n * 10n ** 10n, netTxnMinor: 0n, baseShareMinor: 0n },
        { lineId: L2, productId: P2, merchantVariantId: M2, variantId: V2, qtyQ4: 10_000n, discountMinor: 300n, unitPriceC10: 300n * 10n ** 10n, netTxnMinor: 0n, baseShareMinor: 0n },
      ],
    };
    expect(refusal(() => saleCommitPayload(z)).code).toBe('sale.total_zero');
  });

  it('base shares that do not add up to the base total EXACTLY are refused — the 0043 per-line law, with no rounding account', () => {
    const off: SaleCommitPayloadInput = {
      ...base(),
      lines: [
        { ...(base().lines[0] as SaleCommitPayloadInput['lines'][number]), baseShareMinor: 949n },
        base().lines[1] as SaleCommitPayloadInput['lines'][number],
      ],
    };
    expect(refusal(() => saleCommitPayload(off)).code).toBe('inventory.payload_invalid');
  });

  it('line nets that do not add up to the discounted subtotal are refused', () => {
    const off: SaleCommitPayloadInput = {
      ...base(),
      lines: [
        { ...(base().lines[0] as SaleCommitPayloadInput['lines'][number]), netTxnMinor: 949n, baseShareMinor: 950n },
        base().lines[1] as SaleCommitPayloadInput['lines'][number],
      ],
    };
    expect(refusal(() => saleCommitPayload(off)).code).toBe('inventory.payload_invalid');
  });

  it('the FX snapshot shape is refused when a domestic rate carries a registry row, or is not exactly 1', () => {
    expect(refusal(() => saleCommitPayload({ ...base(), rate: { ...base().rate, rateId: RATE } })).code).toBe('inventory.payload_invalid');
    expect(refusal(() => saleCommitPayload({ ...base(), rate: { ...base().rate, rateR10: 1n } })).code).toBe('inventory.payload_invalid');
    expect(refusal(() => saleCommitPayload({ ...base(), rate: { rateId: RATE, rateR10: 0n, source: 'manual', rateAtEpochSeconds: 1n } })).code).toBe(
      'inventory.payload_invalid',
    );
  });
});

describe('the line rules — a sale takes stock OUT, one line per variant, each with its own id', () => {
  it('a sale with no lines is refused', () => {
    expect(refusal(() => saleCommitIntentSha256({ ...base(), lines: [] })).code).toBe('inventory.lines_required');
  });

  it('two lines on one variant are refused HERE, not by the ledger after the sale row was written', () => {
    const dup = base();
    expect(
      refusal(() =>
        saleCommitIntentSha256({
          ...dup,
          lines: [dup.lines[0] as SaleCommitPayloadInput['lines'][number], { ...(dup.lines[1] as SaleCommitPayloadInput['lines'][number]), productId: P1, merchantVariantId: null }],
        }),
      ).code,
    ).toBe('inventory.duplicate_line');
  });

  it('two lines sharing one line id are refused', () => {
    const dup = base();
    expect(
      refusal(() =>
        saleCommitIntentSha256({
          ...dup,
          lines: [dup.lines[0] as SaleCommitPayloadInput['lines'][number], { ...(dup.lines[1] as SaleCommitPayloadInput['lines'][number]), lineId: L1 }],
        }),
      ).code,
    ).toBe('inventory.duplicate_line');
  });

  it('a non-positive quantity is refused: the client states the magnitude and the routine owns the sign', () => {
    const neg = base();
    expect(
      refusal(() =>
        saleCommitIntentSha256({ ...neg, lines: [{ ...(neg.lines[0] as SaleCommitPayloadInput['lines'][number]), qtyQ4: -20_000n }] }),
      ).code,
    ).toBe('inventory.payload_invalid');
    expect(
      refusal(() => saleCommitIntentSha256({ ...neg, lines: [{ ...(neg.lines[0] as SaleCommitPayloadInput['lines'][number]), qtyQ4: 0n }] })).code,
    ).toBe('inventory.payload_invalid');
  });

  it('a negative discount is refused', () => {
    const neg = base();
    expect(
      refusal(() =>
        saleCommitIntentSha256({ ...neg, lines: [{ ...(neg.lines[0] as SaleCommitPayloadInput['lines'][number]), discountMinor: -1n }] }),
      ).code,
    ).toBe('inventory.payload_invalid');
  });

  it('a non-canonical uuid is refused, never lower-cased into acceptance', () => {
    // `L2` carries hex letters, so upper-casing it is a real change.
    expect(L2.toUpperCase()).not.toBe(L2);
    expect(refusal(() => saleCommitIntentSha256({ ...base(), saleId: L2.toUpperCase() })).code).toBe('inventory.payload_invalid');
    expect(refusal(() => saleCommitIntentSha256({ ...base(), customerId: 'not-a-uuid' })).code).toBe('inventory.payload_invalid');
  });
});

describe('the schema carries no cost, no value and no COGS, at any grain (lock §4 matrix, P4-AL-25)', () => {
  it('neither the header nor the line group names a cost, a value or a COGS field', () => {
    const schema = INVENTORY_PAYLOAD_SCHEMAS['sale.commit'];
    const names = [...schema.map((s) => s.name), ...(schema.repeat?.fields.map((s) => s.name) ?? [])];
    for (const name of names) {
      expect(name, `${name} would be a second truth for money the stock ledger already holds`).not.toMatch(
        /(^|_)(cogs|cost|costs|value|valuation|average|avg)($|_)/,
      );
    }
  });

  it('the sequence number the invoice will carry is in neither stream: it does not exist until the routine holds the sequence row', () => {
    const schema = INVENTORY_PAYLOAD_SCHEMAS['sale.commit'];
    const names = [...schema.map((s) => s.name), ...(schema.repeat?.fields.map((s) => s.name) ?? [])];
    expect(names).not.toContain('number_seq');
    expect(names).not.toContain('document_number');
  });
});

describe('D-01 — the settlement mode is a STATED fact, and a receivable owed by nobody is unrepresentable', () => {
  it('a credit sale with no customer is refused before any assertion is minted', () => {
    expect(refusal(() => saleCommitIntentSha256({ ...base(), customerId: null })).code).toBe('inventory.payload_invalid');
  });

  it('a cash sale may be a walk-in: a null customer is accepted with no due date', () => {
    const walkin = { ...base(), settlementMode: 'cash' as const, customerId: null, dueDate: null };
    expect(() => saleCommitPayload(walkin)).not.toThrow();
  });

  it('a due date with nobody to owe it is refused — the `invoices_walkin_terms_ck` mirror', () => {
    expect(refusal(() => saleCommitIntentSha256({ ...base(), settlementMode: 'cash', customerId: null })).code).toBe('inventory.payload_invalid');
    expect(refusal(() => saleCommitIntentSha256({ ...base(), settlementMode: 'cash' })).code).toBe('inventory.payload_invalid');
  });

  it('the settlement mode IS part of the intent: the same basket settled two ways is two commands', () => {
    const credit = base();
    const cash = { ...base(), settlementMode: 'cash' as const, dueDate: null };
    expect(saleCommitIntentSha256(cash)).not.toBe(saleCommitIntentSha256(credit));
    // …and it is in the intent field list, not merely in the payload.
    expect(INVENTORY_OPERATION_INTENT_FIELDS['sale.commit']).toContain('settlement_mode');
  });

  it('no DERIVED settlement vocabulary is in either stream: a paid total, an outstanding total or a settlement state would be a second truth', () => {
    const schema = INVENTORY_PAYLOAD_SCHEMAS['sale.commit'];
    const names = [...schema.map((s2) => s2.name), ...(schema.repeat?.fields.map((s2) => s2.name) ?? [])];
    for (const name of names) {
      expect(name, `${name} is derived settlement truth and may not be signed as an input`).not.toMatch(
        /(^|_)(paid|unpaid|outstanding|due_amount|owed|settled|settlement_state|balance)($|_)/,
      );
    }
    // `settlement_mode` is the one permitted settlement-shaped name, and it
    // is a MODE: what the merchant stated, never what the ledger derived.
    expect(names).toContain('settlement_mode');
  });
});
