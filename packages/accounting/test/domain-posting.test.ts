import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { mintAccountingAssertion, type AccountingAssertionClaims } from '../src/assertion';
import { isDomainSourceType, mintDomainPostingAssertion } from '../src/domain-posting';
import { AccountingError } from '../src/errors';
import type { AccountingAssertionMinter, AccountingPostingPort, PostEntryRequest } from '../src/ports';
import { AccountingEngine, computeCommandFingerprint, DOMAIN_SOURCE_TYPES, NATIVE_SOURCE_TYPES } from '../src/post';
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
    for (const sourceType of [...NATIVE_SOURCE_TYPES, 'sale', 'stocktake', 'inventory_transfer', '']) {
      const { minter, claims } = minterSpy();
      expect(codeOf(() => mintDomainPostingAssertion(minter, command({ sourceType }), ACTOR))).toBe('accounting.assertion_wrong_source');
      expect(claims).toHaveLength(0);
    }
    expect(DOMAIN_SOURCE_TYPES).toEqual(['inventory_adjustment', 'inventory_opening']);
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
    // A source nobody owns yet still posts through the generic path, as before.
    await engine.post(command({ sourceType: 'sale' }), { actorUserId: ACTOR, branchScope: { mode: 'all' } });
    expect(seen).toHaveLength(1);
    mint.mockRestore();
  });
});
