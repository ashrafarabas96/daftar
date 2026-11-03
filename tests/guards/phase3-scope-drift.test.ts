/**
 * P4-AL-88 — THE DISJOINTNESS HALF, PROVED BOTH DIRECTIONS.
 *
 * `tests/helpers/phase3-scope-drift.ts` carries the second step of the
 * re-expressed P3-S4/S5/S6 upgrade matrices: once each matrix has asserted its
 * original exact equalities at the accepted Phase 3 head, the migrations beyond
 * that head are applied and this is what is asserted about them.
 *
 * A re-expression is only as good as its red, so every clause of it is proved
 * here to be GREEN on a faithful successor and RED on each way a successor
 * could reach back into the Phase 3 scope. These proofs are pure — they take
 * the tagged row digests the matrices compute — so they are permanent and cost
 * no database.
 */
import { describe, expect, it } from 'vitest';
import { REGISTRATION_TAGS, backfillAuditViolations, phase3RegistryViolations, phase3Registrants, phase3ScopeViolations } from '../helpers/phase3-scope-drift';

/** A Phase 3 scope as one of the matrices digests it. */
const HEAD = [
  'acc:a1:b1:1000:asset:cash:true',
  'je:e1:b1:2026-01-01:purchase:p1',
  'pur:b1:p1:s1:w1:received:1:SAR:1200:1200:1:sha',
  'src:supplier_return:8',
  'kind:purchase_receipt:1:false:P3-S4',
  'audit:b1:purchase.received',
].sort();

/** What the real successors (`0074`-`0076`) leave beside it. */
const FAITHFUL_SUCCESSOR = [...HEAD, 'src:invoice:12', 'audit:b1:structure.permission_backfilled'].sort();

describe('P4-AL-88 the Phase 3 scope survives the phase that follows (proof)', () => {
  it('is green on a successor that only registers and audits its own structure change', () => {
    expect(phase3ScopeViolations(HEAD, FAITHFUL_SUCCESSOR)).toEqual([]);
  });

  it('is red when a successor REMOVES a row of the Phase 3 scope', () => {
    const tampered = FAITHFUL_SUCCESSOR.filter((r) => !r.startsWith('je:'));
    expect(phase3ScopeViolations(HEAD, tampered)).toEqual(['removed-or-rewritten:je:e1:b1:2026-01-01:purchase:p1']);
  });

  it('is red when a successor REWRITES a row of the Phase 3 scope', () => {
    const tampered = FAITHFUL_SUCCESSOR.map((r) => (r.startsWith('pur:') ? r.replace(':received:', ':reversed:') : r));
    // A rewrite is caught twice over: the row that stood is gone, and the row
    // that replaced it is a business row a migration may not write.
    expect(phase3ScopeViolations(HEAD, tampered)).toEqual([
      'added:pur:b1:p1:s1:w1:reversed:1:SAR:1200:1200:1:sha',
      'removed-or-rewritten:pur:b1:p1:s1:w1:received:1:SAR:1200:1200:1:sha',
    ]);
  });

  it('is red when a successor writes a BUSINESS row into the Phase 3 scope', () => {
    expect(phase3ScopeViolations(HEAD, [...FAITHFUL_SUCCESSOR, 'je:e9:b1:2026-02-02:invoice:i1'])).toEqual(['added:je:e9:b1:2026-02-02:invoice:i1']);
  });

  it('is red when a successor writes an audit row that is not a structure record', () => {
    expect(phase3ScopeViolations(HEAD, [...FAITHFUL_SUCCESSOR, 'audit:b1:invoice.issued'])).toEqual(['added:audit:b1:invoice.issued']);
  });

  it('admits a registration only under a registry tag, never under a business tag with a registry-looking row', () => {
    expect(REGISTRATION_TAGS).toEqual(['src', 'kind']);
    expect(phase3ScopeViolations(HEAD, [...FAITHFUL_SUCCESSOR, 'kind:invoice_issue:-1:false:P4-S1'])).toEqual([]);
    expect(phase3ScopeViolations(HEAD, [...FAITHFUL_SUCCESSOR, 'mv:b1:m1:w1:v1:1:invoice_issue:invoice:i1:-1:100:-100'])).toEqual([
      'added:mv:b1:m1:w1:v1:1:invoice_issue:invoice:i1:-1:100:-100',
    ]);
  });
});

/** The registry half. */
const REG_HEAD = ['op:purchase_receipt:P3-S4', 'op:stock_write_off:P3-C', 'type:supplier_return:P3-S5', 'acct:post:supplier_return'].sort();
const REG_AFTER = [...REG_HEAD, 'op:invoice_issue:P4-S1', 'acct:post:invoice'].sort();

describe('P4-AL-88 the Phase 3 registrants survive the phase that follows (proof)', () => {
  it('is green when a successor registers its own rows under its own registrant', () => {
    expect(phase3RegistryViolations(REG_HEAD, REG_AFTER)).toEqual([]);
    expect(phase3Registrants(REG_AFTER)).toEqual(['op:purchase_receipt:P3-S4', 'op:stock_write_off:P3-C', 'type:supplier_return:P3-S5']);
  });

  it('is red when a Phase 3 registry row is deleted', () => {
    expect(
      phase3RegistryViolations(
        REG_HEAD,
        REG_AFTER.filter((r) => r !== 'op:purchase_receipt:P3-S4'),
      ),
    ).toEqual(['removed-or-rewritten:op:purchase_receipt:P3-S4']);
  });

  it('is red when a Phase 3 registry row is re-registered under another registrant', () => {
    const tampered = REG_AFTER.map((r) => (r === 'op:purchase_receipt:P3-S4' ? 'op:purchase_receipt:P4-S1' : r));
    expect(phase3RegistryViolations(REG_HEAD, tampered)).toEqual(['removed-or-rewritten:op:purchase_receipt:P3-S4']);
  });

  it('is red when a successor registers a row claiming a PHASE 3 registrant', () => {
    expect(phase3RegistryViolations(REG_HEAD, [...REG_AFTER, 'op:invoice_void:P3-S9'])).toEqual(['phase3-registrant-appeared:op:invoice_void:P3-S9']);
  });

  it('is red when the corrective registrant is the one forged', () => {
    expect(phase3RegistryViolations(REG_HEAD, [...REG_AFTER, 'type:invoice:P3-C'])).toEqual(['phase3-registrant-appeared:type:invoice:P3-C']);
  });
});

/**
 * Two roles of the upgraded business, by THE KEYS each holds; one of them is
 * the role `0076` backfills. Keys, never a count — the last case below is the
 * one a count could not see.
 */
const PERMS_HEAD = {
  'role-owner': ['catalogue.manage', 'inventory.adjust', 'purchases.receive'],
  'role-clerk': ['catalogue.view'],
};
const PERMS_AFTER = {
  'role-owner': ['catalogue.manage', 'inventory.adjust', 'purchases.receive'],
  'role-clerk': ['catalogue.view', 'sales.create', 'sales.view'],
};

describe('R-P4-12 the audited backfill, proved both directions', () => {
  it('is green when the role whose permissions grew is exactly the role that was audited', () => {
    expect(backfillAuditViolations(PERMS_HEAD, PERMS_AFTER, ['role-clerk'])).toEqual([]);
  });

  it('is green when a successor backfills nothing and audits nothing', () => {
    expect(backfillAuditViolations(PERMS_HEAD, PERMS_HEAD, [])).toEqual([]);
  });

  it('is red when a backfill leaves no audit row', () => {
    expect(backfillAuditViolations(PERMS_HEAD, PERMS_AFTER, [])).toEqual(['unaudited-backfill:role-clerk']);
  });

  it('is red when an audit row records a backfill that did not happen', () => {
    expect(backfillAuditViolations(PERMS_HEAD, PERMS_AFTER, ['role-clerk', 'role-owner'])).toEqual(['audit-without-backfill:role-owner']);
  });

  it('is red when a role loses a permission past the accepted head, and names the key', () => {
    const robbed = { ...PERMS_AFTER, 'role-owner': ['catalogue.manage', 'purchases.receive'] };
    expect(backfillAuditViolations(PERMS_HEAD, robbed, ['role-clerk'])).toEqual(['permission-lost:role-owner:inventory.adjust']);
  });

  /**
   * THE CASE A COUNT COULD NOT SEE. This function first took role id → the
   * SIZE of its permission set, and a successor that removes one inherited key
   * and adds another leaves that size equal: nothing was lost as far as the
   * count could tell, nothing grew, no audit row was required, and a
   * permission swapped on a Phase 3 role passed silently. Judged by set
   * difference it is red twice — the key that disappeared and the key that
   * arrived unrecorded — and it stays red when the swap IS audited, because an
   * audited backfill is permission to ADD, never permission to take away.
   */
  it('is red when a successor SWAPS a permission on an inherited role, audited or not', () => {
    const swapped = { ...PERMS_AFTER, 'role-owner': ['catalogue.manage', 'purchases.receive', 'sales.discount'] };
    expect(swapped['role-owner'].length, 'the swap really is size-preserving, so a count would have seen nothing').toBe(PERMS_HEAD['role-owner'].length);
    // Unaudited, the swap is red TWICE and on two different grounds: the key
    // that disappeared, and the key that arrived with no record of arriving.
    expect(backfillAuditViolations(PERMS_HEAD, swapped, ['role-clerk'])).toEqual([
      'permission-lost:role-owner:inventory.adjust',
      'unaudited-backfill:role-owner',
    ]);
    // Audited, the arrival is accounted for and the disappearance still is
    // not: an audited backfill is permission to ADD, never to take away.
    expect(backfillAuditViolations(PERMS_HEAD, swapped, ['role-clerk', 'role-owner'])).toEqual(['permission-lost:role-owner:inventory.adjust']);
  });

  it('is red when a role of the Phase 3 business vanishes or a new one appears', () => {
    expect(backfillAuditViolations(PERMS_HEAD, { 'role-owner': PERMS_HEAD['role-owner'] }, [])).toEqual(['role-vanished:role-clerk']);
    expect(backfillAuditViolations(PERMS_HEAD, { ...PERMS_HEAD, 'role-ghost': ['sales.view'] }, [])).toEqual(['role-appeared:role-ghost']);
  });
});
