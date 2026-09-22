import { describe, expect, it, vi } from 'vitest';
import { mintAccountingAssertion, type AccountingAssertionClaims } from '../src/assertion';
import { AccountingError } from '../src/errors';
import type { AccountingAssertionMinter, AccountingPostingPort, PostEntryRequest } from '../src/ports';
import { AccountingEngine, canonicalAccountIdentity, computeCommandFingerprint, validateBranchScope, validatePostingCommand } from '../src/post';
import type { BranchScope, PostingCommand, PostingLineCommand } from '../src/types';

/** Narrow an optional to its value; `noUncheckedIndexedAccess` plus the lint rules forbid `!`. */
function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('expected a value, found none');
  return value;
}

const TENANT = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const BUSINESS = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const SOURCE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const BRANCH_A = '1b4e28ba-2fa1-11d2-9a0c-0305e82c3301';
const BRANCH_B = '2c5f39cb-3fb2-11d2-9a0c-0305e82c3302';
const ACTOR = '4d7b5aed-5fd4-11d2-9a0c-0305e82c3304';

const line = (over: Partial<PostingLineCommand> = {}): PostingLineCommand => ({
  account: { kind: 'system', systemKey: 'cash' },
  side: 'D',
  baseAmountMinor: 10_000n,
  baseCurrency: 'ILS',
  txnAmountMinor: 10_000n,
  txnCurrency: 'ILS',
  fxRate: '1',
  fxRateSource: 'base',
  fxRateAt: new Date('2026-03-14T08:00:00Z'),
  branchId: null,
  warehouseId: null,
  ...over,
});

const command = (over: Partial<PostingCommand> = {}): PostingCommand => ({
  tenantId: TENANT,
  businessId: BUSINESS,
  sourceType: 'manual_adjustment',
  sourceId: SOURCE,
  entryDate: '2026-03-14',
  lines: [line(), line({ account: { kind: 'system', systemKey: 'owner_equity' }, side: 'C' })],
  ...over,
});

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof AccountingError) return e.code;
    throw e;
  }
  throw new Error('expected a refusal');
};

describe('canonical account identity (§23, §29)', () => {
  it('uses the system key for a system account', () => {
    expect(canonicalAccountIdentity({ kind: 'system', systemKey: 'cash' })).toBe('cash');
  });

  it('prefixes a business chart code so the two namespaces cannot collide', () => {
    expect(canonicalAccountIdentity({ kind: 'code', code: '4100' })).toBe('code:4100');
    // A custom account literally coded "cash" must not impersonate the system
    // account whose key is "cash".
    expect(canonicalAccountIdentity({ kind: 'code', code: 'cash' })).not.toBe(canonicalAccountIdentity({ kind: 'system', systemKey: 'cash' }));
  });

  it('refuses a malformed reference rather than hashing it', () => {
    expect(() => canonicalAccountIdentity({ kind: 'system', systemKey: 'Cash Account' })).toThrow(AccountingError);
    expect(() => canonicalAccountIdentity({ kind: 'code', code: '' })).toThrow(AccountingError);
  });
});

describe('posting command validation (§26, §61)', () => {
  it('accepts a balanced two-line entry', () => {
    expect(() => validatePostingCommand(command())).not.toThrow();
  });

  it('refuses an entry with fewer than two lines', () => {
    expect(codeOf(() => validatePostingCommand(command({ lines: [line()] })))).toBe('accounting.payload_invalid');
  });

  it('refuses an unbalanced entry', () => {
    const lines = [line(), line({ account: { kind: 'system', systemKey: 'owner_equity' }, side: 'C', baseAmountMinor: 9_999n, txnAmountMinor: 9_999n })];
    expect(codeOf(() => validatePostingCommand(command({ lines })))).toBe('accounting.payload_invalid');
  });

  it('refuses a non-positive amount', () => {
    expect(codeOf(() => validatePostingCommand(command({ lines: [line({ baseAmountMinor: 0n, txnAmountMinor: 0n }), line()] })))).toBe(
      'accounting.payload_invalid',
    );
  });

  it('refuses an amount above the 10^18 cap', () => {
    const over = 1_000_000_000_000_000_001n;
    expect(codeOf(() => validatePostingCommand(command({ lines: [line({ baseAmountMinor: over, txnAmountMinor: over }), line()] })))).toBe(
      'accounting.payload_invalid',
    );
  });

  it('refuses a domestic line that does not carry the base rate source', () => {
    expect(codeOf(() => validatePostingCommand(command({ lines: [line({ fxRateSource: 'manual' }), line()] })))).toBe('accounting.payload_invalid');
  });

  it('refuses a foreign line claiming the base rate source', () => {
    const l = line({ txnCurrency: 'USD', txnAmountMinor: 2_688n, fxRate: '3.72', fxRateSource: 'base' });
    expect(codeOf(() => validatePostingCommand(command({ lines: [l, line()] })))).toBe('accounting.payload_invalid');
  });

  it('refuses a base amount that is not the exact conversion', () => {
    const l = line({ txnCurrency: 'USD', txnAmountMinor: 10_000n, baseAmountMinor: 37_201n, fxRate: '3.72', fxRateSource: 'provider' });
    const other = line({ account: { kind: 'system', systemKey: 'owner_equity' }, side: 'C', baseAmountMinor: 37_201n, txnAmountMinor: 37_201n });
    expect(codeOf(() => validatePostingCommand(command({ lines: [l, other] })))).toBe('accounting.payload_invalid');
  });

  it('accepts a correctly converted foreign line', () => {
    const l = line({ txnCurrency: 'USD', txnAmountMinor: 10_000n, baseAmountMinor: 37_200n, fxRate: '3.72', fxRateSource: 'provider' });
    const other = line({ account: { kind: 'system', systemKey: 'owner_equity' }, side: 'C', baseAmountMinor: 37_200n, txnAmountMinor: 37_200n });
    expect(() => validatePostingCommand(command({ lines: [l, other] }))).not.toThrow();
  });

  it('names the offending line without ever naming an amount', () => {
    try {
      validatePostingCommand(command({ lines: [line({ baseAmountMinor: 0n, txnAmountMinor: 0n }), line()] }));
      throw new Error('expected a refusal');
    } catch (e) {
      const err = e as AccountingError;
      expect(err.context.lineNo).toBe(1);
      const safe = JSON.stringify(err.toSafeJSON());
      expect(safe).not.toContain('10000');
      expect(safe).not.toContain('3.72');
    }
  });
});

describe('branch scope (§52)', () => {
  const all: BranchScope = { mode: 'all' };
  const assigned: BranchScope = { mode: 'assigned', allowedBranchIds: [BRANCH_A] };

  it('all scope permits a business-level entry with no branch', () => {
    expect(() => validateBranchScope(command(), all)).not.toThrow();
  });

  it('all scope permits any branch in the business', () => {
    const lines = [line({ branchId: BRANCH_B }), line({ account: { kind: 'system', systemKey: 'owner_equity' }, side: 'C', branchId: BRANCH_B })];
    expect(() => validateBranchScope(command({ lines }), all)).not.toThrow();
  });

  it('assigned scope permits the branch the member holds', () => {
    const lines = [line({ branchId: BRANCH_A }), line({ account: { kind: 'system', systemKey: 'owner_equity' }, side: 'C', branchId: BRANCH_A })];
    expect(() => validateBranchScope(command({ lines }), assigned)).not.toThrow();
  });

  it('assigned scope refuses a NULL branch — it would silently widen the member', () => {
    expect(codeOf(() => validateBranchScope(command(), assigned))).toBe('accounting.branch_scope_violation');
  });

  it('assigned scope refuses a branch the member does not hold', () => {
    const lines = [line({ branchId: BRANCH_B }), line({ account: { kind: 'system', systemKey: 'owner_equity' }, side: 'C', branchId: BRANCH_B })];
    expect(codeOf(() => validateBranchScope(command({ lines }), assigned))).toBe('accounting.branch_scope_violation');
  });

  it('assigned scope refuses when only ONE line escapes the scope', () => {
    const lines = [line({ branchId: BRANCH_A }), line({ account: { kind: 'system', systemKey: 'owner_equity' }, side: 'C', branchId: BRANCH_B })];
    expect(codeOf(() => validateBranchScope(command({ lines }), assigned))).toBe('accounting.branch_scope_violation');
  });

  it('compares branch ids case-insensitively, as UUIDs', () => {
    const lines = [line({ branchId: BRANCH_A.toUpperCase() }), line({ account: { kind: 'system', systemKey: 'owner_equity' }, side: 'C', branchId: BRANCH_A })];
    expect(() => validateBranchScope(command({ lines }), assigned)).not.toThrow();
  });
});

describe('the engine binds authority to the payload (§27, §54)', () => {
  const key = { kid: 'acct1', secret: Buffer.alloc(32, 5) };
  const minter: AccountingAssertionMinter = { mint: (c: AccountingAssertionClaims) => mintAccountingAssertion(key, c) };

  const capturingPort = (): { port: AccountingPostingPort; seen: PostEntryRequest[] } => {
    const seen: PostEntryRequest[] = [];
    return {
      seen,
      port: {
        postEntry: async (request) => {
          seen.push(request);
          return { entryId: '5e8c6bfe-6fe5-11d2-9a0c-0305e82c3305', created: true };
        },
      },
    };
  };

  /**
   * The engine under test, with every source port stubbed. P2-S4 gave the
   * engine three more workflows; the posting behaviour these cases pin is
   * unchanged, so they build it through one helper rather than restating the
   * dependency list six times.
   */
  const engineWith = (port: AccountingPostingPort): AccountingEngine =>
    new AccountingEngine(
      minter,
      port,
      { postAdjustment: async () => ({ entryId: SOURCE, created: true }) },
      { postReversal: async () => ({ entryId: SOURCE, created: true }) },
      { postOpeningBalance: async () => ({ entryId: SOURCE, created: true }) },
      { readEntry: async () => null, readBusinessBaseCurrency: async () => 'ILS' },
    );

  it('mints an assertion over the fingerprint of the ACTUAL command', async () => {
    const { port, seen } = capturingPort();
    const cmd = command();
    await engineWith(port).post(cmd, { actorUserId: ACTOR, branchScope: { mode: 'all' } });
    expect(seen).toHaveLength(1);
    const parts = must(seen[0]).assertion.split('.');
    expect(parts[8]).toBe(computeCommandFingerprint(cmd));
    // The very payload that was signed is what travels to the database.
    expect(must(seen[0]).command).toBe(cmd);
  });

  it('takes the actor from the authorized context, never from the command', async () => {
    const { port, seen } = capturingPort();
    // A caller trying to smuggle an actor through the command shape has
    // nowhere to put it: PostingCommand has no actor field at all.
    const cmd = command() as PostingCommand & { actorUserId?: string };
    cmd.actorUserId = '00000000-0000-4000-8000-000000000000';
    await engineWith(port).post(cmd, { actorUserId: ACTOR, branchScope: { mode: 'all' } });
    expect(must(seen[0]).assertion.split('.')[2]).toBe(ACTOR);
  });

  it('refuses before minting when the payload is invalid — no authority is spent', async () => {
    const { port, seen } = capturingPort();
    const mint = vi.spyOn(minter, 'mint');
    const bad = command({ lines: [line(), line({ side: 'C', baseAmountMinor: 1n, txnAmountMinor: 1n })] });
    await expect(engineWith(port).post(bad, { actorUserId: ACTOR, branchScope: { mode: 'all' } })).rejects.toThrow(AccountingError);
    expect(mint).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0);
    mint.mockRestore();
  });

  it('refuses before minting when branch scope is violated', async () => {
    const { port, seen } = capturingPort();
    const mint = vi.spyOn(minter, 'mint');
    await expect(engineWith(port).post(command(), { actorUserId: ACTOR, branchScope: { mode: 'assigned', allowedBranchIds: [BRANCH_A] } })).rejects.toThrow(
      AccountingError,
    );
    expect(mint).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0);
    mint.mockRestore();
  });

  it('returns the database result verbatim, including an idempotent replay', async () => {
    const port: AccountingPostingPort = { postEntry: async () => ({ entryId: '5e8c6bfe-6fe5-11d2-9a0c-0305e82c3305', created: false }) };
    const result = await engineWith(port).post(command(), { actorUserId: ACTOR, branchScope: { mode: 'all' } });
    expect(result).toEqual({ entryId: '5e8c6bfe-6fe5-11d2-9a0c-0305e82c3305', created: false });
  });

  it('exposes exactly the four P2-S4 workflows — no ledger, balance, trial balance or trusted path', () => {
    const engine = engineWith({ postEntry: async () => ({ entryId: SOURCE, created: true }) });
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(engine)).filter((n) => n !== 'constructor');
    // The list is asserted EXACTLY, in order. A future slice that quietly
    // adds `postTrusted`, `systemPost`, `rawWrite` or a read model to this
    // class fails here before it reaches a reviewer (§38, §39).
    expect(surface).toEqual(['post', 'adjust', 'reverse', 'openingBalance']);
  });
});
