/**
 * THE AUDITED ADMINISTRATIVE WRITE-OFF OF A STRANDED CREDIT BALANCE — `DR-97`
 * item 2, and the card `DR97_ADMIN_CREDIT_TERMINATION_AR.md`.
 *
 * ── What is being tested, and what is deliberately NOT ──────────────────
 *
 * `DR-97` splits the way out of a stranded balance into two independent
 * commands. Only ONE of them is this card's, and the other is not here and
 * must not arrive here later: a cash return is a command of a different
 * layer (`TL-P5-R3` forbids any path from credit to cash inside `billing`,
 * and `test/plan-change.test.ts` scans for its symbol). So this file tests
 * the WRITE-OFF alone — the balance is cancelled where it already lives, by
 * an order somebody is named for, and no money leaves anywhere.
 *
 * ── CRITERION 5 OF THE CARD IS OPEN, AND IS NOT CLAIMED HERE ────────────
 *
 * The card's fifth criterion is the five audit fields measured ON A REAL ROW
 * IN CI. It cannot be met by this file and is NOT met anywhere yet, for a
 * reason that is a sealed-logic conflict rather than missing work:
 *
 *   `0088_p5_billing_platform_credit_ledger.sql:189`
 *   CONSTRAINT pca_consumption_invoice
 *     CHECK ((kind = 'consumption') = (invoice_id IS NOT NULL))
 *
 * Every `consumption` row must name an invoice. A write-off has no invoice —
 * that is the whole point of it: nothing was billed, a balance was cancelled.
 * So the row this module computes CANNOT BE INSERTED while that CHECK stands,
 * and the five fields therefore have no real row to be measured on.
 *
 * The four ways out are all forbidden to this card, and each for its own
 * reason: relaxing the CHECK, adding a third `kind`, and fabricating a
 * synthetic `invoice_id` all weaken sealed logic; writing a follow-on
 * migration touches money in production. It is recorded for the owner in
 * `OWNER_QUEUE_AR.md` and the last case below PINS the conflict, so that
 * "criterion 5 is open" is a measured fact in an executed case and not a
 * sentence in a comment somebody can skim.
 *
 * ── Why the authority vocabulary here is BORROWED and not invented ──────
 *
 * `packages/billing/src` held no actor, issuer, role or permission type at
 * all — measured, with `currency` as the positive control. The live platform
 * console already has the vocabulary: `AdminService.require(userId, key)`
 * over a capability map, in which `'billing.manage'` is held by
 * `['platform_owner', 'billing_admin']` (`admin.service.ts:33`). This module
 * adopts that capability rather than coining a word, and the case
 * `the capability is the live one` reads the live map and fails if the two
 * ever drift apart.
 *
 * It then authorizes a write-off for `platform_owner` ONLY — a STRICT SUBSET
 * of the live holders of that capability. The direction of that narrowing is
 * stated because it is a money decision: refusing a `billing_admin`'s
 * write-off can only block a legitimate order, which the owner can then issue
 * themselves, while allowing one would let a non-owner cancel a customer's
 * money with no way back. The recoverable direction is the one taken. Whether
 * `billing_admin` SHOULD hold this is an accounting question, not a
 * programming one, and it is raised for the owner rather than decided here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { foldCreditBalance, type CreditAdjustment } from '../src/credit';
import { BillingError } from '../src/errors';
import {
  writeOffPlatformCreditBalance,
  CREDIT_WRITE_OFF_CAPABILITY,
  CREDIT_WRITE_OFF_AUTHORIZED_ROLES,
  type PlatformCreditWriteOffCommand,
} from '../src/credit-write-off';

// ───────────────────────────────────────────────────────────────────────────
// Fixtures. Every amount is an exact integer of minor units.
// ───────────────────────────────────────────────────────────────────────────

const OWNER = { userId: 'u-owner-1', platformRole: 'platform_owner', capability: CREDIT_WRITE_OFF_CAPABILITY } as const;

const BIZ = 'b-1';

function grant(id: string, amountMinor: bigint, currency: string, occurredAt: string): CreditAdjustment {
  return { id, businessId: BIZ, kind: 'grant', amountMinor, currency, occurredAt, ref: `r-${id}`, reason: `granted ${id}` };
}

function consumption(id: string, amountMinor: bigint, currency: string, occurredAt: string, appliesToGrantId: string): CreditAdjustment {
  return { id, businessId: BIZ, kind: 'consumption', amountMinor, currency, occurredAt, ref: `r-${id}`, reason: `spent ${id}`, appliesToGrantId };
}

/** An ILS balance of 1500, stranded after the subscription moved to USD. */
const STRANDED: readonly CreditAdjustment[] = [grant('g-1', 1500n, 'ILS', '2026-01-01T00:00:00.000Z')];

function command(over: Partial<PlatformCreditWriteOffCommand> = {}): PlatformCreditWriteOffCommand {
  return {
    issuer: OWNER,
    scope: { businessId: BIZ, currency: 'ILS' },
    ledger: STRANDED,
    reason: 'stranded by a currency change; cancelled on the owner-s order',
    occurredAt: '2026-03-01T00:00:00.000Z',
    ref: 'admin-order-77',
    consumptionIds: ['w-1', 'w-2', 'w-3'],
    ...over,
  };
}

/** The code of the refusal a call produced, or `null` if it did not refuse. */
function refusalOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof BillingError) return error.code;
    throw error;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Criterion 3 — the balance after the write-off is ZERO, measured by the
// balance authority itself and not by this module's own arithmetic.
// ───────────────────────────────────────────────────────────────────────────

describe('the write-off cancels the whole stranded balance', () => {
  it('writes ONE row per grant with a remainder, and folds to exactly zero', () => {
    const out = writeOffPlatformCreditBalance(command());

    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]?.kind).toBe('consumption');
    expect(out.rows[0]?.amountMinor).toBe(1500n);
    expect(out.rows[0]?.appliesToGrantId).toBe('g-1');
    expect(out.rows[0]?.currency).toBe('ILS');

    // Criterion 3, through the authority, on the RESULTING ledger.
    const after = foldCreditBalance([...STRANDED, ...out.rows], { businessId: BIZ, currency: 'ILS' });
    expect(after.balanceMinor).toBe(0n);
    expect(out.balanceAfterMinor).toBe(0n);
    // An absolute value, not an identity between two sums computed the same
    // way: the rows must sum to the balance that existed before.
    expect(out.rows.reduce((t, r) => t + r.amountMinor, 0n)).toBe(1500n);
    expect(out.balanceBeforeMinor).toBe(1500n);
  });

  it('writes one row per grant, OLDEST FIRST, each for that grant-s own remainder', () => {
    const ledger: readonly CreditAdjustment[] = [
      grant('g-1', 1000n, 'ILS', '2026-01-01T00:00:00.000Z'),
      grant('g-2', 700n, 'ILS', '2026-02-01T00:00:00.000Z'),
      // 400 of g-1 is already spent, so its remainder is 600.
      consumption('c-1', 400n, 'ILS', '2026-02-10T00:00:00.000Z', 'g-1'),
    ];
    const out = writeOffPlatformCreditBalance(command({ ledger }));

    expect(out.rows.map((r) => r.appliesToGrantId)).toEqual(['g-1', 'g-2']);
    expect(out.rows.map((r) => r.amountMinor)).toEqual([600n, 700n]);
    expect(out.rows.reduce((t, r) => t + r.amountMinor, 0n)).toBe(1300n);
    expect(foldCreditBalance([...ledger, ...out.rows], { businessId: BIZ, currency: 'ILS' }).balanceMinor).toBe(0n);
  });

  it('writes NO row for a grant already exhausted, rather than a row of zero', () => {
    const ledger: readonly CreditAdjustment[] = [
      grant('g-1', 500n, 'ILS', '2026-01-01T00:00:00.000Z'),
      grant('g-2', 900n, 'ILS', '2026-01-02T00:00:00.000Z'),
      consumption('c-1', 500n, 'ILS', '2026-01-03T00:00:00.000Z', 'g-1'),
    ];
    const out = writeOffPlatformCreditBalance(command({ ledger }));

    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]?.appliesToGrantId).toBe('g-2');
    expect(out.rows.every((r) => r.amountMinor > 0n)).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Criterion 2 — no existing row is modified, removed or reordered.
// ───────────────────────────────────────────────────────────────────────────

describe('the ledger is append-only, measured row by row', () => {
  it('leaves every prior row byte-identical and in its original order', () => {
    const ledger: readonly CreditAdjustment[] = [
      grant('g-1', 1000n, 'ILS', '2026-01-01T00:00:00.000Z'),
      grant('g-2', 700n, 'ILS', '2026-02-01T00:00:00.000Z'),
      consumption('c-1', 400n, 'ILS', '2026-02-10T00:00:00.000Z', 'g-1'),
    ];
    const snapshot = ledger.map((r) => ({ ...r }));

    const out = writeOffPlatformCreditBalance(command({ ledger }));
    const resulting = [...ledger, ...out.rows];

    // One at a time, deeply, and in order — not by count, which a swap of two
    // rows and an edit to a third would satisfy.
    for (let i = 0; i < snapshot.length; i++) {
      expect(resulting[i], `row ${i} of the prior ledger changed`).toStrictEqual(snapshot[i]);
    }
    // The prior rows are still the PREFIX: the new rows are appended, never
    // interleaved.
    expect(resulting.slice(0, snapshot.length)).toStrictEqual(snapshot);
    expect(resulting).toHaveLength(snapshot.length + out.rows.length);
    // And the input array itself was not mutated.
    expect(ledger).toStrictEqual(snapshot);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Criterion 1 — the mandatory reason, and its negative controls.
// ───────────────────────────────────────────────────────────────────────────

describe('the reason is mandatory, and the refusal is the LIVE code', () => {
  it('refuses an empty reason by name', () => {
    expect(refusalOf(() => writeOffPlatformCreditBalance(command({ reason: '' })))).toBe('billing.credit_reason_required');
  });

  it('refuses a reason of whitespace only — a blank is not a reason', () => {
    expect(refusalOf(() => writeOffPlatformCreditBalance(command({ reason: '   \t\n ' })))).toBe('billing.credit_reason_required');
  });

  it('refuses a reason past the 500 the ledger column allows, and accepts 500 exactly', () => {
    // Both sides of the boundary AND the boundary itself.
    expect(refusalOf(() => writeOffPlatformCreditBalance(command({ reason: 'x'.repeat(501) })))).toBe('billing.credit_reason_required');
    expect(refusalOf(() => writeOffPlatformCreditBalance(command({ reason: 'x'.repeat(500) })))).toBeNull();
    expect(refusalOf(() => writeOffPlatformCreditBalance(command({ reason: 'x'.repeat(499) })))).toBeNull();
    expect(refusalOf(() => writeOffPlatformCreditBalance(command({ reason: 'x' })))).toBeNull();
  });

  it('checks the reason BEFORE the balance, so a malformed order is not reported as having nothing to do', () => {
    // THIS CASE EXISTS BECAUSE A SEEDED CONTROL CAUGHT THE SUITE, not because
    // it was planned. Deleting this module's own reason guard left all of the
    // cases above GREEN: an empty reason lands on the rows it builds, and the
    // balance authority's re-fold then raises the SAME
    // `billing.credit_reason_required` — the two layers enforce one rule, so
    // the cases could not say which of them refused.
    //
    // There is exactly one input that separates them, and it is a real
    // difference rather than a contrivance: with NO balance to cancel, no row
    // is ever built, so the authority is never reached. Only this module's own
    // guard can refuse there — and it must, because reporting a malformed
    // order as "nothing to cancel" sends whoever reads it to look at the
    // wrong thing.
    const spent: readonly CreditAdjustment[] = [
      grant('g-1', 500n, 'ILS', '2026-01-01T00:00:00.000Z'),
      consumption('c-1', 500n, 'ILS', '2026-01-02T00:00:00.000Z', 'g-1'),
    ];
    expect(refusalOf(() => writeOffPlatformCreditBalance(command({ ledger: spent })))).toBe('billing.credit_write_off_no_balance');
    expect(refusalOf(() => writeOffPlatformCreditBalance(command({ ledger: spent, reason: '' })))).toBe('billing.credit_reason_required');
    expect(refusalOf(() => writeOffPlatformCreditBalance(command({ ledger: spent, reason: '  ' })))).toBe('billing.credit_reason_required');
    expect(refusalOf(() => writeOffPlatformCreditBalance(command({ ledger: spent, reason: 'x'.repeat(501) })))).toBe('billing.credit_reason_required');
  });

  it('stamps that one reason on every row it writes, so no row is unexplained', () => {
    const reason = 'cancelled by order admin-order-77';
    const out = writeOffPlatformCreditBalance(command({ reason }));
    expect(out.rows.every((r) => r.reason === reason)).toBe(true);
    expect(out.audit.reason).toBe(reason);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The issuer's authority, and its negative controls.
// ───────────────────────────────────────────────────────────────────────────

describe('only an authorized issuer may cancel a customer-s money', () => {
  it('accepts the platform owner (the positive control for every refusal below)', () => {
    expect(refusalOf(() => writeOffPlatformCreditBalance(command()))).toBeNull();
  });

  it('refuses a role that is not authorized, by name', () => {
    for (const platformRole of ['billing_admin', 'platform_admin', 'support_agent', 'security_admin', 'read_only_analyst', 'merchant_owner', '']) {
      expect(
        refusalOf(() => writeOffPlatformCreditBalance(command({ issuer: { ...OWNER, platformRole } }))),
        `${platformRole || '<empty>'} was not refused`,
      ).toBe('billing.credit_write_off_unauthorized');
    }
  });

  it('refuses an issuer who names no user, so an order nobody signed is not an order', () => {
    expect(refusalOf(() => writeOffPlatformCreditBalance(command({ issuer: { ...OWNER, userId: '' } })))).toBe('billing.credit_write_off_unauthorized');
    expect(refusalOf(() => writeOffPlatformCreditBalance(command({ issuer: { ...OWNER, userId: '   ' } })))).toBe('billing.credit_write_off_unauthorized');
  });

  it('refuses an issuer carrying some other capability, so the check is on THIS one', () => {
    expect(refusalOf(() => writeOffPlatformCreditBalance(command({ issuer: { ...OWNER, capability: 'read.all' } })))).toBe(
      'billing.credit_write_off_unauthorized',
    );
    expect(refusalOf(() => writeOffPlatformCreditBalance(command({ issuer: { ...OWNER, capability: 'plans.manage' } })))).toBe(
      'billing.credit_write_off_unauthorized',
    );
  });

  it('borrows the LIVE capability and never widens the live holder set', () => {
    // The vocabulary is tied to the platform console's own map, so the two
    // drifting apart is a failure here rather than a silent divergence.
    const admin = readFileSync(join(__dirname, '..', '..', '..', 'apps', 'api', 'src', 'modules', 'admin', 'admin.service.ts'), 'utf8');
    expect(CREDIT_WRITE_OFF_CAPABILITY).toBe('billing.manage');
    expect(admin, 'the live capability map no longer declares this capability').toContain(`'${CREDIT_WRITE_OFF_CAPABILITY}':`);

    const row = /'billing\.manage':\s*\[([^\]]*)\]/.exec(admin);
    expect(row?.[1], 'the live holders of billing.manage could not be read').toBeTruthy();
    const liveHolders = [...(row?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    // Non-vacuity before the subset claim: an empty read would satisfy it.
    expect(liveHolders.length).toBeGreaterThan(1);
    expect(liveHolders).toContain('platform_owner');

    // A STRICT subset: this command authorizes fewer roles than the
    // capability does, never more.
    expect(CREDIT_WRITE_OFF_AUTHORIZED_ROLES.every((r) => liveHolders.includes(r))).toBe(true);
    expect(CREDIT_WRITE_OFF_AUTHORIZED_ROLES.length).toBeLessThan(liveHolders.length);
    expect([...CREDIT_WRITE_OFF_AUTHORIZED_ROLES]).toEqual(['platform_owner']);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// A command with nothing to do REFUSES. It does not succeed silently.
// ───────────────────────────────────────────────────────────────────────────

describe('a write-off of nothing is a defect, not a no-op', () => {
  it('refuses a zero balance in the target currency by name', () => {
    const spent: readonly CreditAdjustment[] = [
      grant('g-1', 500n, 'ILS', '2026-01-01T00:00:00.000Z'),
      consumption('c-1', 500n, 'ILS', '2026-01-02T00:00:00.000Z', 'g-1'),
    ];
    expect(refusalOf(() => writeOffPlatformCreditBalance(command({ ledger: spent })))).toBe('billing.credit_write_off_no_balance');
  });

  it('refuses an empty ledger, and a currency the ledger does not hold at all', () => {
    expect(refusalOf(() => writeOffPlatformCreditBalance(command({ ledger: [] })))).toBe('billing.credit_write_off_no_balance');
    expect(refusalOf(() => writeOffPlatformCreditBalance(command({ scope: { businessId: BIZ, currency: 'EUR' } })))).toBe(
      'billing.credit_write_off_no_balance',
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Criterion 6 — another currency in the same ledger is NOT touched.
// ───────────────────────────────────────────────────────────────────────────

describe('only the target currency is cancelled', () => {
  const MIXED: readonly CreditAdjustment[] = [
    grant('g-ils', 1500n, 'ILS', '2026-01-01T00:00:00.000Z'),
    grant('g-usd', 2200n, 'USD', '2026-01-05T00:00:00.000Z'),
  ];

  it('leaves the other currency-s balance exactly as it was, before and after', () => {
    const usdBefore = foldCreditBalance(
      MIXED.filter((r) => r.currency === 'USD'),
      { businessId: BIZ, currency: 'USD' },
    );

    const out = writeOffPlatformCreditBalance(command({ ledger: MIXED }));

    // Every row written names the target currency and a target-currency grant.
    expect(out.rows.every((r) => r.currency === 'ILS')).toBe(true);
    expect(out.rows.map((r) => r.appliesToGrantId)).toEqual(['g-ils']);

    const resulting = [...MIXED, ...out.rows];
    const usdAfter = foldCreditBalance(
      resulting.filter((r) => r.currency === 'USD'),
      { businessId: BIZ, currency: 'USD' },
    );
    expect(usdAfter).toStrictEqual(usdBefore);
    expect(usdAfter.balanceMinor).toBe(2200n);

    // And the target currency is zero on the same resulting ledger.
    expect(
      foldCreditBalance(
        resulting.filter((r) => r.currency === 'ILS'),
        { businessId: BIZ, currency: 'ILS' },
      ).balanceMinor,
    ).toBe(0n);
  });

  it('converts nothing: no rate, no estimate, and no second currency on a row', () => {
    const out = writeOffPlatformCreditBalance(command({ ledger: MIXED }));
    expect(new Set(out.rows.map((r) => r.currency))).toStrictEqual(new Set(['ILS']));
    expect(out.audit.currency).toBe('ILS');
    // The amount cancelled is the ILS balance itself, unscaled.
    expect(out.audit.amountMinor).toBe(1500n);
  });

  it('refuses a ledger row whose currency cannot be read, rather than passing over it', () => {
    const broken = [grant('g-1', 1500n, 'ILS', '2026-01-01T00:00:00.000Z'), { ...grant('g-2', 10n, 'ILS', '2026-01-02T00:00:00.000Z'), currency: 'ils' }];
    expect(refusalOf(() => writeOffPlatformCreditBalance(command({ ledger: broken })))).toBe('billing.payload_invalid');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The audit record — the card's five fields, as a VALUE. Criterion 5 needs a
// real row in CI and is OPEN; see this file's header and the last case.
// ───────────────────────────────────────────────────────────────────────────

describe('the audit record carries the five fields the card names', () => {
  it('names who issued it, why, how much, in which currency, and which balance', () => {
    const out = writeOffPlatformCreditBalance(command({ ledger: [grant('g-1', 1000n, 'ILS', '2026-01-01T00:00:00.000Z')] }));

    expect(out.audit.issuedByUserId).toBe('u-owner-1');
    expect(out.audit.reason).toBe('stranded by a currency change; cancelled on the owner-s order');
    expect(out.audit.amountMinor).toBe(1000n);
    expect(out.audit.currency).toBe('ILS');
    expect(out.audit.targetBusinessId).toBe(BIZ);
    // The balance has no row of its own: it IS (business, currency), and the
    // grants cancelled are named so the order can be audited against rows.
    expect(out.audit.targetGrantIds).toEqual(['g-1']);
    // No field of the record is absent or empty.
    for (const [field, value] of Object.entries(out.audit)) {
      expect(value, `the audit field ${field} is empty`).toBeTruthy();
    }
  });

  it('reports the amount as the exact sum of the rows, as an absolute value', () => {
    const ledger: readonly CreditAdjustment[] = [grant('g-1', 1000n, 'ILS', '2026-01-01T00:00:00.000Z'), grant('g-2', 700n, 'ILS', '2026-02-01T00:00:00.000Z')];
    const out = writeOffPlatformCreditBalance(command({ ledger }));
    expect(out.audit.amountMinor).toBe(1700n);
    expect(out.audit.amountMinor).toBe(out.rows.reduce((t, r) => t + r.amountMinor, 0n));
    expect(out.audit.targetGrantIds).toEqual(['g-1', 'g-2']);
  });

  it('is a VALUE and nothing more: this package persists nothing and calls no port', () => {
    const code = readFileSync(join(__dirname, '..', 'src', 'credit-write-off.ts'), 'utf8');
    for (const forbidden of ['./ports', './fake-provider', 'pg', 'node:fs', 'process.env', 'Date.now', 'new Date(']) {
      expect(code, `the write-off reaches for ${forbidden}`).not.toContain(forbidden);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The identities the rows carry, and the instant they carry.
// ───────────────────────────────────────────────────────────────────────────

describe('the rows the caller will persist are fully identified', () => {
  it('refuses when the caller supplied too few identities, reusing the live code', () => {
    const ledger: readonly CreditAdjustment[] = [grant('g-1', 1000n, 'ILS', '2026-01-01T00:00:00.000Z'), grant('g-2', 700n, 'ILS', '2026-02-01T00:00:00.000Z')];
    expect(refusalOf(() => writeOffPlatformCreditBalance(command({ ledger, consumptionIds: ['w-1'] })))).toBe('billing.credit_application_ids_exhausted');
    // The positive control: two identities for two rows is accepted.
    expect(refusalOf(() => writeOffPlatformCreditBalance(command({ ledger, consumptionIds: ['w-1', 'w-2'] })))).toBeNull();
  });

  it('refuses an instant earlier than the ledger-s last row, through the authority-s own code', () => {
    expect(refusalOf(() => writeOffPlatformCreditBalance(command({ occurredAt: '2025-12-31T00:00:00.000Z' })))).toBe('billing.credit_ledger_out_of_order');
  });

  it('reads no clock: the same command gives the same rows, and the instant is the one supplied', () => {
    const a = writeOffPlatformCreditBalance(command());
    const b = writeOffPlatformCreditBalance(command());
    expect(a).toStrictEqual(b);
    expect(a.rows.every((r) => r.occurredAt === '2026-03-01T00:00:00.000Z')).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// CRITERION 5, PINNED AS OPEN. This case asserts the BLOCKER, so the gap is
// a measured fact rather than a claim in prose.
// ───────────────────────────────────────────────────────────────────────────

describe('criterion 5 is OPEN, and the reason is sealed logic', () => {
  it('pins the CHECK that makes a write-off row un-insertable, in the accepted migration', () => {
    const ddl = readFileSync(
      join(__dirname, '..', '..', '..', 'infrastructure', 'database', 'migrations', '0088_p5_billing_platform_credit_ledger.sql'),
      'utf8',
    );
    // Non-vacuity first: the table this is about must be in the file read.
    expect(ddl).toContain('CREATE TABLE public.platform_credit_adjustments');
    // The conflict itself. A `consumption` must name an invoice; a write-off
    // has none. Until the owner rules, the five fields have no real row.
    expect(ddl).toContain("CONSTRAINT pca_consumption_invoice  CHECK ((kind = 'consumption') = (invoice_id IS NOT NULL))");
    // And this module writes exactly the kind that constraint binds, which is
    // what makes the conflict real rather than theoretical.
    const out = writeOffPlatformCreditBalance(command());
    expect(out.rows.every((r) => r.kind === 'consumption')).toBe(true);
  });
});
