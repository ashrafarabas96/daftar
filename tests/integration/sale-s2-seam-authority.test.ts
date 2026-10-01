/**
 * P4-S2 — THE DECLARED ACCOUNTING AUTHORITY OF SEAM 2
 * (docs/PHASE_4_S2_CONTRACT.md A-09; `apps/api/src/infra/database.ts`
 * `SeamAccountingAuthority`, `AccountingAssertionSequence`).
 *
 * `AccountingAssertions` is a non-empty type and `plan` refuses an empty list,
 * so before this slice a command that needed the seam's ATOMICITY but posted
 * NOTHING had only two ways out: mint a signed assertion it never presents, or
 * split its commit. The first is a fake authority nothing declares; the second
 * is what the atomic sale law forbids.
 *
 * Two arms close that, and this suite is where each becomes a law:
 *
 *   `no_posting`   — the transaction DECLARES that it posts nothing, and
 *                    presenting anything is refused. A draft sale and a draft
 *                    invoice are the case (`invoices_binding_owed_ck`,
 *                    `0075:301`, makes a draft owe no binding);
 *   `conditional`  — a named assertion's entry may legitimately not exist. A
 *                    sale of stock whose stored valuation is zero posts ONE
 *                    entry: `journal_lines_money_cap_ck` (`0042:225`) requires
 *                    `base_amount_minor > 0`, and `0060:388-390` gives the
 *                    emptying movement exactly `-valuation_base_minor`, which
 *                    is 0 for a zero valuation. The accounting is sound with
 *                    one entry and `GL Inventory (1200) =
 *                    Σ value_delta_base_minor` still holds at 0.
 *
 * The property that matters most is the LAST test: with no conditional
 * element, every rule is bit-for-bit what it was. The arms are additive, so a
 * bare string and a tuple remain exactly today's seam and no existing caller
 * changes — which is why `purchase-s4-seam`, `settlement-s6-seam`,
 * `inventory-seam`, `inventory-seam-posting`, `inventory-assertion-sequence`,
 * `inventory-s3-atomicity` and `purchase-s4-atomicity` stay green beside this.
 *
 * **The seam is not the enforcer of the conditional arm and this suite does
 * not pretend it is.** It never sees a COGS total, so it cannot know whether
 * the skipped entry was owed. The law is the deferred `sales_cogs_owed`
 * trigger (contract C-07, the migration owner's): a sale whose bridged
 * movements carry a non-zero total value and no `sale` accounting binding
 * cannot COMMIT. A rule only the wrapper enforces is a convention while the
 * trusted primitive can still write the row.
 *
 * Pure state, no connection: `AccountingAssertionSequence` does no I/O, so
 * every rule here is provable without a database.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AccountingAssertionSequence, TransactionSeamError, type BusinessScope, type SeamAccountingAuthority } from '../../apps/api/src/infra/database';
import { sourceAssertion } from '../helpers/accounting-posting';

function seamCode(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof TransactionSeamError) return e.code;
    throw e;
  }
  return 'accepted';
}

const scope: BusinessScope = { tenantId: randomUUID(), businessId: randomUUID(), actorUserId: randomUUID(), businessTransactionId: randomUUID() };

const SALE_ID = randomUUID();
const INVOICE_ID = randomUUID();

const mint = (sourceType: string, sourceId: string): string =>
  sourceAssertion({
    actorUserId: scope.actorUserId,
    tenantId: scope.tenantId,
    businessId: scope.businessId,
    operationKind: 'post',
    sourceType,
    sourceId,
    postingFingerprint: randomUUID().replaceAll('-', '').repeat(2),
  });

const planned = (authority: SeamAccountingAuthority): { guc: string; sequence: AccountingAssertionSequence } => {
  const p = AccountingAssertionSequence.plan(scope, authority);
  if (p.sequence === null) throw new Error('expected a sequence');
  return { guc: p.guc, sequence: p.sequence };
};

describe("SeamAccountingAuthority — 'no_posting' is a declaration, not a silence", () => {
  it('carries no authority: the GUC is empty and there is a sequence, so nothing can post', () => {
    const { guc, sequence } = planned({ kind: 'no_posting' });
    // NOT `sequence: null`: null is the single-authority path, which sets the
    // GUC at BEGIN and would let a posting through.
    expect(guc).toBe('');
    expect(seamCode(() => sequence.next({ sourceType: 'sale', sourceId: SALE_ID }))).toBe('seam.accounting_assertion_not_authorized');
  });

  it('commits having posted nothing — which is the whole point', () => {
    const { sequence } = planned({ kind: 'no_posting' });
    expect(seamCode(() => sequence.assertComplete())).toBe('accepted');
  });

  it('a refused posting consumes nothing: the refusal is repeatable and the commit still stands', () => {
    const { sequence } = planned({ kind: 'no_posting' });
    for (const source of [
      { sourceType: 'sale', sourceId: SALE_ID },
      { sourceType: 'invoice', sourceId: INVOICE_ID },
      { sourceType: 'sale', sourceId: SALE_ID },
    ]) {
      expect(seamCode(() => sequence.next(source))).toBe('seam.accounting_assertion_not_authorized');
    }
    expect(seamCode(() => sequence.assertComplete())).toBe('accepted');
  });
});

describe("SeamAccountingAuthority — 'postings' with a conditional element", () => {
  const authority = (): SeamAccountingAuthority => {
    const cogs = mint('sale', SALE_ID);
    const revenue = mint('invoice', INVOICE_ID);
    return { kind: 'postings', assertions: [cogs, revenue], conditional: [cogs] };
  };

  it('both present, in posting order, exactly as before', () => {
    const a = authority();
    if (a.kind !== 'postings') throw new Error('unreachable');
    const { guc, sequence } = planned(a);
    expect(guc).toBe('');
    expect(sequence.next({ sourceType: 'sale', sourceId: SALE_ID })).toBe(a.assertions[0]);
    expect(sequence.next({ sourceType: 'invoice', sourceId: INVOICE_ID })).toBe(a.assertions[1]);
    expect(seamCode(() => sequence.assertComplete())).toBe('accepted');
  });

  it('THE CASE: the conditional COGS entry does not exist, the required revenue entry does, and the commit stands', () => {
    const a = authority();
    if (a.kind !== 'postings') throw new Error('unreachable');
    const { sequence } = planned(a);
    // The sale posts the revenue entry FIRST and only, because the stock it
    // released carried no value. The conditional element is SKIPPED, not
    // reordered: its authority is never handed out.
    expect(sequence.next({ sourceType: 'invoice', sourceId: INVOICE_ID })).toBe(a.assertions[1]);
    expect(seamCode(() => sequence.assertComplete())).toBe('accepted');
    // And the skipped authority stays unreachable afterwards: a caller that
    // posted the revenue entry cannot come back for the COGS one.
    expect(seamCode(() => sequence.next({ sourceType: 'sale', sourceId: SALE_ID }))).toBe('seam.accounting_assertion_exhausted');
  });

  it('the REQUIRED element may not be skipped: posting only the conditional one is refused at the commit', () => {
    const a = authority();
    if (a.kind !== 'postings') throw new Error('unreachable');
    const { sequence } = planned(a);
    expect(sequence.next({ sourceType: 'sale', sourceId: SALE_ID })).toBe(a.assertions[0]);
    // A COGS entry with no commercial source is one of the seven states
    // P4-AL-16 forbids, so this commit must not stand.
    expect(seamCode(() => sequence.assertComplete())).toBe('seam.accounting_assertion_unused');
  });

  it('a conditional element never becomes a licence for the wrong source', () => {
    const a = authority();
    if (a.kind !== 'postings') throw new Error('unreachable');
    const { sequence } = planned(a);
    // Neither claim matches, so the walk skips the conditional element and
    // then meets a REQUIRED one that disagrees: a mismatch, not a skip.
    expect(seamCode(() => sequence.next({ sourceType: 'invoice', sourceId: SALE_ID }))).toBe('seam.accounting_assertion_source_mismatch');
    // and nothing was consumed by the refusal.
    expect(sequence.next({ sourceType: 'sale', sourceId: SALE_ID })).toBe(a.assertions[0]);
  });

  it('presenting none is still lawful — the replay case, an accepted P3 law', () => {
    const a = authority();
    if (a.kind !== 'postings') throw new Error('unreachable');
    const { sequence } = planned(a);
    // `tests/integration/purchase-s4-seam.test.ts:207` asserts this as a law:
    // a replay is discovered INSIDE the transaction, after the seam was opened
    // by a caller that could not know it would be one. Tightening it needs a
    // way for the callback itself to declare the replay, which changes that
    // accepted contract and is not this slice's to change.
    expect(seamCode(() => sequence.assertComplete())).toBe('accepted');
  });

  it('a conditional assertion that is not one of the transaction own assertions is MALFORMED, never a tolerated typo', () => {
    const cogs = mint('sale', SALE_ID);
    const revenue = mint('invoice', INVOICE_ID);
    const stranger = mint('purchase', randomUUID());
    // A mis-spelled exemption would silently make a REQUIRED posting optional,
    // which is the quietest way an atomic law stops being one.
    expect(seamCode(() => AccountingAssertionSequence.plan(scope, { kind: 'postings', assertions: [cogs, revenue], conditional: [stranger] }))).toBe(
      'seam.accounting_assertion_malformed',
    );
  });

  it('every element conditional is MALFORMED: a transaction that may post nothing declares no_posting', () => {
    const cogs = mint('sale', SALE_ID);
    const revenue = mint('invoice', INVOICE_ID);
    expect(seamCode(() => AccountingAssertionSequence.plan(scope, { kind: 'postings', assertions: [cogs, revenue], conditional: [cogs, revenue] }))).toBe(
      'seam.accounting_assertion_malformed',
    );
  });

  it('a single conditional assertion still gets a SEQUENCE, never the single-authority path', () => {
    const only = mint('sale', SALE_ID);
    const p = AccountingAssertionSequence.plan(scope, { kind: 'postings', assertions: [only], conditional: [] });
    // With no conditional element a one-element list is today's seam.
    expect(p.sequence).toBeNull();
    expect(p.guc).toBe(only);
  });

  it("the arms are ADDITIVE: with no conditional element, 'postings' is bit-for-bit the old seam", () => {
    const cogs = mint('sale', SALE_ID);
    const revenue = mint('invoice', INVOICE_ID);
    for (const form of [
      [cogs, revenue] as const,
      { kind: 'postings', assertions: [cogs, revenue] } as const,
      { kind: 'postings', assertions: [cogs, revenue], conditional: [] } as const,
    ]) {
      const p = AccountingAssertionSequence.plan(scope, form);
      const sequence = p.sequence;
      if (sequence === null) throw new Error('expected a sequence');
      expect(p.guc).toBe('');
      // strict order, strict completeness, strict mismatch
      expect(seamCode(() => sequence.next({ sourceType: 'invoice', sourceId: INVOICE_ID }))).toBe('seam.accounting_assertion_source_mismatch');
      expect(sequence.next({ sourceType: 'sale', sourceId: SALE_ID })).toBe(cogs);
      expect(seamCode(() => sequence.assertComplete())).toBe('seam.accounting_assertion_unused');
      expect(sequence.next({ sourceType: 'invoice', sourceId: INVOICE_ID })).toBe(revenue);
      expect(seamCode(() => sequence.assertComplete())).toBe('accepted');
      expect(seamCode(() => sequence.next({ sourceType: 'invoice', sourceId: INVOICE_ID }))).toBe('seam.accounting_assertion_exhausted');
    }
  });

  it('a bare string is still the single-assertion seam, with no sequence at all', () => {
    const only = mint('sale', SALE_ID);
    for (const form of [only, [only] as const, { kind: 'postings', assertions: only } as const]) {
      const p = AccountingAssertionSequence.plan(scope, form);
      expect(p.guc).toBe(only);
      expect(p.sequence).toBeNull();
    }
  });

  it('an empty assertion list is still MISSING, in the declared form too', () => {
    expect(seamCode(() => AccountingAssertionSequence.plan(scope, [] as unknown as readonly [string, ...string[]]))).toBe('seam.accounting_assertion_missing');
    expect(seamCode(() => AccountingAssertionSequence.plan(scope, { kind: 'postings', assertions: [] as unknown as readonly [string, ...string[]] }))).toBe(
      'seam.accounting_assertion_missing',
    );
  });

  it('a duplicate is still MALFORMED, and a foreign scope still a scope mismatch', () => {
    const only = mint('sale', SALE_ID);
    expect(seamCode(() => AccountingAssertionSequence.plan(scope, { kind: 'postings', assertions: [only, only] }))).toBe('seam.accounting_assertion_malformed');
    const foreign = sourceAssertion({
      actorUserId: scope.actorUserId,
      tenantId: randomUUID(),
      businessId: randomUUID(),
      operationKind: 'post',
      sourceType: 'sale',
      sourceId: SALE_ID,
      postingFingerprint: randomUUID().replaceAll('-', '').repeat(2),
    });
    expect(seamCode(() => AccountingAssertionSequence.plan(scope, { kind: 'postings', assertions: [foreign, mint('invoice', INVOICE_ID)] }))).toBe(
      'seam.accounting_assertion_scope_mismatch',
    );
  });
});
