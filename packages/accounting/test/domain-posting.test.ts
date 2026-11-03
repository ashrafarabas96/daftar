import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { mintAccountingAssertion, type AccountingAssertionClaims } from '../src/assertion';
import { isDomainReversibleSourceType, isDomainSourceType, mintDomainPostingAssertion, mintDomainReversalAssertion } from '../src/domain-posting';
import { AccountingError } from '../src/errors';
import type { AccountingAssertionMinter, AccountingPostingPort, PostEntryRequest } from '../src/ports';
import { AccountingEngine, computeCommandFingerprint, DOMAIN_REVERSIBLE_SOURCE_TYPES, DOMAIN_SOURCE_TYPES, NATIVE_SOURCE_TYPES } from '../src/post';
import { computeReversalFingerprint, mirrorReversalLines, type PostedEntrySnapshot } from '../src/sources';
import type { PostingCommand, PostingLineCommand } from '../src/types';

const TENANT = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const BUSINESS = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const SOURCE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const BRANCH = '1b4e28ba-2fa1-11d2-9a0c-0305e82c3301';
const WAREHOUSE = '3d6a4adc-4fc3-11d2-9a0c-0305e82c3303';
const ACTOR = '4d7b5aed-5fd4-11d2-9a0c-0305e82c3304';

const key = { kid: 'acct1', secret: Buffer.alloc(32, 5) };

function minterSpy(): { minter: AccountingAssertionMinter; claims: AccountingAssertionClaims[] } {
  const claims: AccountingAssertionClaims[] = [];
  return {
    claims,
    minter: {
      mint: (c) => {
        claims.push(c);
        return mintAccountingAssertion(key, c);
      },
    },
  };
}

const line = (over: Partial<PostingLineCommand> = {}): PostingLineCommand => ({
  account: { kind: 'system', systemKey: 'inventory' },
  side: 'D',
  baseAmountMinor: 221n,
  baseCurrency: 'ILS',
  txnAmountMinor: 221n,
  txnCurrency: 'ILS',
  fxRate: '1.0000000000',
  fxRateSource: 'base',
  fxRateAt: new Date('2026-09-26T00:00:00Z'),
  branchId: BRANCH,
  warehouseId: WAREHOUSE,
  ...over,
});

/** The A-05 shape of an adjustment gain: Dr inventory / Cr cogs, at the warehouse and its home branch. */
const command = (over: Partial<PostingCommand> = {}): PostingCommand => ({
  tenantId: TENANT,
  businessId: BUSINESS,
  sourceType: 'inventory_adjustment',
  sourceId: SOURCE,
  entryDate: '2026-09-26',
  lines: [line(), line({ account: { kind: 'system', systemKey: 'cogs' }, side: 'C' })],
  requestId: null,
  ...over,
});

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof AccountingError) return e.code;
    throw e;
  }
  return 'accepted';
};

describe('mintDomainPostingAssertion (A-06)', () => {
  it('mints `post` for the command source identity over computeCommandFingerprint, with the given actor', () => {
    const { minter, claims } = minterSpy();
    const cmd = command();
    const assertion = mintDomainPostingAssertion(minter, cmd, ACTOR);
    expect(claims).toEqual([
      {
        actorUserId: ACTOR,
        tenantId: TENANT,
        businessId: BUSINESS,
        operationKind: 'post',
        sourceType: 'inventory_adjustment',
        sourceId: SOURCE,
        postingFingerprint: computeCommandFingerprint(cmd),
      },
    ]);
    expect(assertion.split('.')[8]).toBe(computeCommandFingerprint(cmd));
  });

  it('accepts both domain sources, the opening with an N+1 shape and NULL equity dimensions', () => {
    const { minter } = minterSpy();
    const opening = command({
      sourceType: 'inventory_opening',
      lines: [
        line({ baseAmountMinor: 100n, txnAmountMinor: 100n }),
        line({
          account: { kind: 'system', systemKey: 'opening_equity' },
          side: 'C',
          baseAmountMinor: 100n,
          txnAmountMinor: 100n,
          branchId: null,
          warehouseId: null,
        }),
      ],
    });
    expect(codeOf(() => mintDomainPostingAssertion(minter, opening, ACTOR))).toBe('accepted');
  });

  it('refuses every Phase-2-native source and any source no domain owns, before minting', () => {
    // P4-S2: `sale` left this list because it became a real domain source
    // type with a real writer (`sale-posting.ts`), which is exactly what
    // `TL-P4-S1-R1` requires of a registered type. It is replaced here by two
    // names that are still not source types — a stock movement kind and a
    // Phase 4 operation code — so the claim this loop makes (a name that is
    // not a domain source buys no authority) keeps a subject.
    for (const sourceType of [...NATIVE_SOURCE_TYPES, 'purchase_reversal', 'sale.commit', 'stocktake', 'inventory_transfer', '']) {
      const { minter, claims } = minterSpy();
      expect(codeOf(() => mintDomainPostingAssertion(minter, command({ sourceType }), ACTOR))).toBe('accounting.assertion_wrong_source');
      expect(claims).toHaveLength(0);
    }
    // P3-S4 (0063/0064): PHASE_3_S4_CONTRACT §7.3 row 22 appends the two S4 domain sources.
    // P3-S5 (0065/0066): PHASE_3_S5_CONTRACT §7.3 row 22 appends `supplier_return`.
    // P3-S6 (0067/0068): PHASE_3_S6_CONTRACT §7.3 row 20 appends the three settlement sources.
    // Phase 3 corrective (0072, TD-16) appends the residue write-off.
    expect(DOMAIN_SOURCE_TYPES).toEqual([
      'inventory_adjustment',
      'inventory_opening',
      'purchase',
      'negative_inventory_cost_adjustment',
      'supplier_return',
      'supplier_payment', // P3-S6 (0067/0068)
      'supplier_credit_allocation', // P3-S6 (0067/0068)
      'supplier_refund', // P3-S6 (0067/0068)
      'purchase_residue_write_off', // Phase 3 corrective (0072, TD-16)
      // P4-S2 (0077): the COGS entry and the revenue entry of a sale. `invoice`
      // is P4-S2's rather than P4-S1's by Tech Lead ruling `TL-P4-S1-R1`.
      'sale',
      'invoice',
      // P4-S4 (0081, a CANDIDATE migration): the two settlement reducers and
      // the customer credit. The credit is a source in its own right and not a
      // tail on an allocation entry, because a payment that allocates nothing
      // has no allocation entry for its surplus leg to ride on. None of the
      // three is reversible: reversal is P4-S6's, and `0081` deliberately puts
      // all three in the generic guard's plain refusal arm with no
      // `purchase`-style escape.
      'customer_payment_allocation',
      'customer_credit_application',
      'customer_credit',
    ]);
    expect(isDomainSourceType('inventory_adjustment')).toBe(true);
    expect(isDomainSourceType('manual_adjustment')).toBe(false);
  });

  it('runs validatePostingCommand: an unbalanced or single-line entry spends no authority', () => {
    const { minter, claims } = minterSpy();
    expect(codeOf(() => mintDomainPostingAssertion(minter, command({ lines: [line()] }), ACTOR))).toBe('accounting.payload_invalid');
    expect(
      codeOf(() => mintDomainPostingAssertion(minter, command({ lines: [line(), line({ side: 'C', baseAmountMinor: 1n, txnAmountMinor: 1n })] }), ACTOR)),
    ).toBe('accounting.payload_invalid');
    expect(claims).toHaveLength(0);
  });

  it('takes no branch scope and never calls validateBranchScope (the warehouse scope is the authority, L:1024)', () => {
    expect(mintDomainPostingAssertion.length).toBe(3);
    const code = readFileSync(join(__dirname, '..', 'src', 'domain-posting.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/validateBranchScope/);
    // A line on a branch no assigned member could hold is minted as given.
    const { minter } = minterSpy();
    expect(
      codeOf(() =>
        mintDomainPostingAssertion(
          minter,
          command({ lines: [line({ branchId: SOURCE }), line({ account: { kind: 'system', systemKey: 'cogs' }, side: 'C', branchId: SOURCE })] }),
          ACTOR,
        ),
      ),
    ).toBe('accepted');
  });
});

describe('AccountingEngine.post refuses a domain-owned source (TL-10)', () => {
  it('refuses inventory_adjustment and inventory_opening with assertion_wrong_source, before minting or posting', async () => {
    const { minter, claims } = minterSpy();
    const seen: PostEntryRequest[] = [];
    const port: AccountingPostingPort = {
      postEntry: async (r) => {
        seen.push(r);
        return { entryId: SOURCE, created: true };
      },
    };
    const engine = new AccountingEngine(
      minter,
      port,
      { postAdjustment: async () => ({ entryId: SOURCE, created: true }) },
      { postReversal: async () => ({ entryId: SOURCE, created: true }) },
      { postOpeningBalance: async () => ({ entryId: SOURCE, created: true }) },
      { readEntry: async () => null, readBusinessBaseCurrency: async () => 'ILS' },
    );
    const mint = vi.spyOn(minter, 'mint');
    for (const sourceType of DOMAIN_SOURCE_TYPES) {
      await expect(engine.post(command({ sourceType }), { actorUserId: ACTOR, branchScope: { mode: 'all' } })).rejects.toMatchObject({
        code: 'accounting.assertion_wrong_source',
      });
    }
    expect(mint).not.toHaveBeenCalled();
    expect(claims).toHaveLength(0);
    expect(seen).toHaveLength(0);
    // A source nobody owns yet still posts through the generic path, as
    // before. P4-S2: this used `sale`, which is now a domain source with a
    // real writer (`TL-P4-S1-R1`). `period_close` is a source type no phase
    // has registered, so the generic arm keeps a subject.
    await engine.post(command({ sourceType: 'period_close' }), { actorUserId: ACTOR, branchScope: { mode: 'all' } });
    expect(seen).toHaveLength(1);
    mint.mockRestore();
  });
});

// P3-S5 (0065/0066): PHASE_3_S5_CONTRACT §7.3 row 22 — the domain-reversible
// sources (R-B2a) and the reversal minter of A-06.
describe('DOMAIN_REVERSIBLE_SOURCE_TYPES (R-B2a)', () => {
  it('is exactly the purchase, a domain source; purchase_reversal is no accounting source at all', () => {
    expect(DOMAIN_REVERSIBLE_SOURCE_TYPES).toEqual(['purchase']);
    for (const st of DOMAIN_REVERSIBLE_SOURCE_TYPES) expect(isDomainSourceType(st)).toBe(true);
    expect(isDomainReversibleSourceType('purchase')).toBe(true);
    for (const st of ['supplier_return', 'inventory_adjustment', 'negative_inventory_cost_adjustment', 'purchase_reversal', 'reversal', 'manual_adjustment']) {
      expect(isDomainReversibleSourceType(st)).toBe(false);
    }
    expect((DOMAIN_SOURCE_TYPES as readonly string[]).includes('purchase_reversal')).toBe(false);
  });
});

describe('mintDomainReversalAssertion (A-06, R-B2a)', () => {
  const ENTRY = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
  const at = new Date('2026-09-20T00:00:00Z');
  /** A purchase entry as the ledger reader returns it: Dr inventory at the warehouse / Cr AP at the branch (S4 A-05). */
  const purchaseEntry = (over: Partial<PostedEntrySnapshot> = {}): PostedEntrySnapshot => ({
    entryId: ENTRY,
    tenantId: TENANT,
    businessId: BUSINESS,
    sourceType: 'purchase',
    entryDate: '2026-09-20',
    lines: [
      {
        lineNo: 1,
        account: { kind: 'system', systemKey: 'inventory' },
        side: 'D',
        baseAmountMinor: 24786n,
        baseCurrency: 'ILS',
        txnAmountMinor: 24786n,
        txnCurrency: 'ILS',
        fxRate: '1.0000000000',
        fxRateSource: 'base',
        fxRateAt: at,
        branchId: BRANCH,
        warehouseId: WAREHOUSE,
        memo: null,
      },
      {
        lineNo: 2,
        account: { kind: 'system', systemKey: 'accounts_payable' },
        side: 'C',
        baseAmountMinor: 24786n,
        baseCurrency: 'ILS',
        txnAmountMinor: 6749n,
        txnCurrency: 'USD',
        fxRate: '3.6725000000',
        fxRateSource: 'manual',
        fxRateAt: at,
        branchId: BRANCH,
        warehouseId: null,
        memo: null,
      },
    ],
    ...over,
  });

  it('mints `reverse` / `reversal` / the original entry id over computeReversalFingerprint of the mirror', () => {
    const { minter, claims } = minterSpy();
    const original = purchaseEntry();
    const assertion = mintDomainReversalAssertion(minter, original, '2026-09-27', ACTOR);
    const fp = computeReversalFingerprint(original, '2026-09-27', mirrorReversalLines(original));
    expect(claims).toEqual([
      {
        actorUserId: ACTOR,
        tenantId: TENANT,
        businessId: BUSINESS,
        operationKind: 'reverse',
        sourceType: 'reversal',
        sourceId: ENTRY,
        postingFingerprint: fp,
      },
    ]);
    expect(assertion.split('.')[8]).toBe(fp);
    // The mirror swaps sides and copies the rate, the currencies and the dimensions verbatim.
    expect(mirrorReversalLines(original).map((l) => [l.side, l.txnCurrency, l.fxRate, l.warehouseId])).toEqual([
      ['C', 'ILS', '1.0000000000', WAREHOUSE],
      ['D', 'USD', '3.6725000000', null],
    ]);
  });

  it('signs exactly what AccountingEngine.reverse signs for the same original and date', async () => {
    const original = purchaseEntry();
    const spy = minterSpy();
    const engine = new AccountingEngine(
      spy.minter,
      { postEntry: async () => ({ entryId: SOURCE, created: true }) },
      { postAdjustment: async () => ({ entryId: SOURCE, created: true }) },
      { postReversal: async () => ({ entryId: SOURCE, created: true }) },
      { postOpeningBalance: async () => ({ entryId: SOURCE, created: true }) },
      { readEntry: async () => original, readBusinessBaseCurrency: async () => 'ILS' },
    );
    await engine.reverse(
      { tenantId: TENANT, businessId: BUSINESS, originalEntryId: ENTRY, entryDate: '2026-09-27', reason: 'wrong supplier' },
      { actorUserId: ACTOR, branchScope: { mode: 'all' } },
    );
    const domain = minterSpy();
    mintDomainReversalAssertion(domain.minter, original, '2026-09-27', ACTOR);
    expect(domain.claims).toEqual(spy.claims);
  });

  it('refuses every source but a domain-reversible one, before minting', () => {
    for (const sourceType of [
      'supplier_return',
      'inventory_adjustment',
      'inventory_opening',
      'negative_inventory_cost_adjustment',
      'manual_adjustment',
      'opening_balance',
      // P4-S2: both Phase 4 sale source types are domain sources and NEITHER
      // is reversible by the generic workflow. A sale is corrected by a
      // return or a void — a new auditable document — never by mirroring its
      // entry (P4-AL-24, P4-AL-46).
      'sale',
      'invoice',
      'supplier_payment', // P3-S6 (0067/0068): §7.3 row 20, not reversible (TL-2)
      'supplier_credit_allocation', // P3-S6 (0067/0068)
      'supplier_refund', // P3-S6 (0067/0068)
      'purchase_residue_write_off', // Phase 3 corrective (0072, TD-16): not reversible
    ]) {
      const { minter, claims } = minterSpy();
      expect(codeOf(() => mintDomainReversalAssertion(minter, purchaseEntry({ sourceType }), '2026-09-27', ACTOR))).toBe('accounting.assertion_wrong_source');
      expect(claims).toHaveLength(0);
    }
    const { minter, claims } = minterSpy();
    expect(codeOf(() => mintDomainReversalAssertion(minter, purchaseEntry({ sourceType: 'reversal' }), '2026-09-27', ACTOR))).toBe(
      'accounting.assertion_wrong_source',
    );
    expect(claims).toHaveLength(0);
  });

  it('refuses a date before the original, and a date that is not a real civil date; the original date itself is accepted', () => {
    const { minter, claims } = minterSpy();
    expect(codeOf(() => mintDomainReversalAssertion(minter, purchaseEntry(), '2026-09-19', ACTOR))).toBe('accounting.entry_date_before_original');
    expect(codeOf(() => mintDomainReversalAssertion(minter, purchaseEntry(), '2026-02-30', ACTOR))).toBe('accounting.payload_invalid');
    expect(claims).toHaveLength(0);
    expect(codeOf(() => mintDomainReversalAssertion(minter, purchaseEntry(), '2026-09-20', ACTOR))).toBe('accepted');
  });

  it('takes no branch scope and never calls validateBranchScope (the warehouse scope is the authority, L:1024)', () => {
    expect(mintDomainReversalAssertion.length).toBe(4);
    const { minter } = minterSpy();
    const foreign = purchaseEntry({ lines: purchaseEntry().lines.map((l) => ({ ...l, branchId: SOURCE })) });
    expect(codeOf(() => mintDomainReversalAssertion(minter, foreign, '2026-09-27', ACTOR))).toBe('accepted');
  });
});
