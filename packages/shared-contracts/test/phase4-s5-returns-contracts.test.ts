/**
 * P4-S5, maturity level C — the returns CONTRACT's absences, asserted over the
 * real declaration rather than over a hand-copied list.
 *
 * This suite reads `src/returns.ts` FROM DISK and parses the field names out of
 * each `interface`. That is the difference between a guard and a comment: a
 * hand-written list of "fields `RefundDto` must not have" goes stale the moment
 * somebody adds one, while this test's subject IS the shipped declaration. Add
 * `invoiceId` to `RefundDto` and this file goes red on the next run.
 *
 * The three absences it defends, and the law behind each:
 *
 * 1. no field on a refund may name an INVOICE — `TL-P4-S5-R1`, "a refund is not
 *    an invoice-outstanding reducer";
 * 2. no field on a refund may name a PAYMENT — the same ruling, "it carries no
 *    `payment_id`", and the execution plan's "no column that could name a
 *    payment";
 * 3. no shape anywhere in the contract may carry a stored consumption total —
 *    the cap is derived from the exact stored rows, and `refunded_amount_minor`
 *    is independently an authoritative-balance column to G-3.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REFUND_NAMES_NO_INVOICE, forbiddenRefundFields, refundInvoiceNamingFields } from '@daftar/domain-core';

const SOURCE = readFileSync(join(__dirname, '../src/returns.ts'), 'utf8');

/**
 * The field names declared inside one `interface` of the contract, read from the
 * text.
 *
 * Deliberately a text parse and not a type-level trick: a type-level assertion
 * is erased at runtime and a `keyof` over an interface cannot be enumerated
 * without a value, so the only way to make the SHIPPED declaration the subject
 * is to read it. Comment lines are dropped first, so a doc comment mentioning an
 * invoice can neither satisfy nor fail the law — the same precondition
 * `scripts/phase4-s1-gate.ts:1413-1424` asserts rather than assumes of its own
 * SQL bodies.
 */
function interfaceFields(name: string): readonly string[] {
  return Object.freeze(declaredMembers(interfaceBody(name)).map((m) => m.name));
}

/** The brace-balanced body of one shipped interface, with its comments stripped. */
function interfaceBody(name: string): string {
  const start = SOURCE.indexOf(`export interface ${name} `);
  if (start < 0) throw new Error(`the contract declares no interface ${name} — this suite has lost its subject, which is not a pass`);
  const open = SOURCE.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (let i = open; i < SOURCE.length; i++) {
    const ch = SOURCE[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  return SOURCE.slice(open + 1, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

/**
 * Every member of an interface body, `readonly` or NOT, with the modifier
 * reported separately.
 *
 * The `readonly` was once part of the MATCH, and that was a defect rather than a
 * detail: a field declared without it was invisible to every law in this file,
 * so `invoiceId: string` on a refund DTO — the exact thing `TL-P4-S5-R1`
 * forbids, and the exact thing a hurried edit produces — would have been
 * extracted as nothing and judged as nothing. A law whose subject extractor can
 * be defeated by dropping a keyword is a law that reads a filtered tree.
 *
 * So the modifier is now a SEPARATE assertion, and `declares every member
 * readonly` below is the law that enforces it.
 */
function declaredMembers(body: string): readonly { readonly name: string; readonly readonly: boolean }[] {
  return Object.freeze(
    [...body.matchAll(/^[ \t]*(readonly[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*[?:]/gm)].map((m) =>
      Object.freeze({ name: m[2] as string, readonly: m[1] !== undefined }),
    ),
  );
}

/** The members of one interface, with their modifiers — for the law that judges the modifier. */
function interfaceMembers(name: string): readonly { readonly name: string; readonly readonly: boolean }[] {
  return declaredMembers(interfaceBody(name));
}

describe('P4-S5 contract — the refund shape, read from the shipped declaration', () => {
  it('declares the interfaces this suite judges, so the suite cannot be vacuous', () => {
    for (const name of ['RefundDto', 'RefundResultDto', 'CreditNoteDto', 'CreditNoteItemDto', 'CreditNoteApplicationDto']) {
      expect(() => interfaceFields(name)).not.toThrow();
    }
    // A non-trivial field count, so a future empty interface cannot pass by
    // having nothing to judge.
    expect(interfaceFields('RefundDto').length).toBeGreaterThan(10);
  });

  it('RED PROOF — the extractor sees a field declared WITHOUT `readonly`, which the earlier one did not', () => {
    // The planted subject is the exact declaration `TL-P4-S5-R1` forbids on a
    // refund, written the way a hurried edit writes it — no `readonly`. An
    // extractor that required the keyword returned nothing for this body, so
    // every law in this file read a FILTERED tree and `invoiceId` on a refund
    // DTO would have passed unseen.
    const planted = '\n  readonly refundId: string;\n  invoiceId: string;\n  readonly amountMinor: string;\n';
    const members = declaredMembers(planted);
    expect(members.map((m) => m.name)).toEqual(['refundId', 'invoiceId', 'amountMinor']);
    // And the earlier extractor, reconstructed here as the thing being refuted:
    const readonlyOnly = [...planted.matchAll(/^\s*readonly\s+([A-Za-z_][A-Za-z0-9_]*)\s*[?:]/gm)].map((m) => m[1] as string);
    expect(readonlyOnly).toEqual(['refundId', 'amountMinor']);
    expect(readonlyOnly).not.toContain('invoiceId');
    // So the law that matters — "a refund names no invoice" — is now answerable
    // over this body, and was not before.
    expect(refundInvoiceNamingFields(members.map((m) => m.name))).toEqual(['invoiceId']);
  });

  it('every member of every shipped S5 DTO is `readonly`, asserted SEPARATELY from being seen', () => {
    // The modifier is a law of its own now rather than a condition of being
    // extracted. Both halves hold, and neither hides the other.
    for (const name of ['RefundDto', 'RefundResultDto', 'CreditNoteDto', 'CreditNoteItemDto', 'CreditNoteApplicationDto']) {
      const mutable = interfaceMembers(name).filter((m) => !m.readonly);
      expect(mutable.map((m) => `${name}.${m.name}`)).toEqual([]);
    }
    // Non-vacuous: the modifier check is shown able to FAIL on a real shape.
    expect(
      declaredMembers('\n  invoiceId: string;\n')
        .filter((m) => !m.readonly)
        .map((m) => m.name),
    ).toEqual(['invoiceId']);
  });

  it('`RefundDto` names no invoice — TL-P4-S5-R1, over the real field list', () => {
    const fields = interfaceFields('RefundDto');
    expect(refundInvoiceNamingFields(fields)).toEqual([]);
    expect(REFUND_NAMES_NO_INVOICE(fields)).toBe(true);
  });

  it('`RefundDto` names no payment, and `paymentMethodId` is lawful because a method is configuration', () => {
    const fields = interfaceFields('RefundDto');
    expect(forbiddenRefundFields(fields)).toEqual([]);
    expect(fields).toContain('paymentMethodId');
  });

  it('`RefundDto` carries BOTH nullable sources and NO discriminator', () => {
    const fields = interfaceFields('RefundDto');
    expect(fields).toContain('creditNoteId');
    expect(fields).toContain('customerCreditId');
    // GOLD-74: a `*_id` beside a `*_type`/`*_kind` with no foreign key is a
    // polymorphic reference and is refused on the financial core. The kind is
    // derived from which id is set, in one place.
    expect(fields.filter((f) => /^(source|refund)(Type|Kind)$/.test(f))).toEqual([]);
  });

  it('RED PROOF — the guard this suite relies on fires on the real forbidden names', () => {
    // Planted against the actual declaration plus each of the three names the
    // rulings name. If the guard could not refuse these, every green above
    // would be vacuous.
    const fields = interfaceFields('RefundDto');
    expect(REFUND_NAMES_NO_INVOICE([...fields, 'invoiceId'])).toBe(false);
    expect(REFUND_NAMES_NO_INVOICE([...fields, 'invoiceNumber'])).toBe(false);
    expect(forbiddenRefundFields([...fields, 'paymentId'])).toHaveLength(1);
    expect(forbiddenRefundFields([...fields, 'refundedAmountMinor'])).toHaveLength(1);
    expect(forbiddenRefundFields([...fields, 'sourceType'])).toHaveLength(1);
  });

  it('no shape in the whole contract carries a stored consumption total or a derived settlement figure', () => {
    const all = ['RefundDto', 'RefundResultDto', 'CreditNoteDto', 'CreditNoteItemDto', 'CreditNoteApplicationDto', 'CreditNotePageDto', 'RefundPageDto'];
    for (const name of all) {
      expect(forbiddenRefundFields(interfaceFields(name))).toEqual([]);
    }
  });

  it('the credit note carries the remaining PAIR and NO status of any kind', () => {
    const fields = interfaceFields('CreditNoteDto');
    expect(fields).toContain('remainingAmountMinor');
    expect(fields).toContain('remainingCarryingBaseAmountMinor');
    // There is no `settlementState`, no `isRefunded` and no `consumed*` that
    // could disagree with the pair — and, since round 3, no lifecycle `status`
    // either: `CREDIT_NOTE_HAS_NO_LIFECYCLE`.
    expect(fields.filter((f) => /settlementState|isRefunded|consumed|^status$/i.test(f))).toEqual([]);
    // The non-vacuity arm: the extractor DOES see the fields of this interface,
    // so the empty filter above is a fact about the shape and not about a
    // regex that matches nothing.
    expect(fields).toContain('creditNoteNumber');
    expect(fields.length).toBeGreaterThan(8);
  });

  it('the credit-note identity documented in the source has three terms, and the third is not a field', () => {
    // M4. The two-term identity this file once documented omitted the amount
    // refunded in cash, and a reader who trusted it would conclude money had
    // gone missing from a note that was partly applied and partly refunded.
    const body = SOURCE.slice(SOURCE.indexOf(' * ## The identity, stated correctly'), SOURCE.indexOf('export interface CreditNoteDto'));
    expect(body).toContain('appliedToInvoiceMinor + \u03a3 refunds against this note + remainingAmountMinor = totalMinor');
    // And the third term must NOT have become a column while being documented:
    // that would be the `refundedAmountMinor` of this file's header rule 4 under a new name.
    expect(interfaceFields('CreditNoteDto').filter((f) => /refunded/i.test(f))).toEqual([]);
  });

  it('the tax element exists only as a structural zero, and only where the invoice has one', () => {
    // OD-03 is OPEN. `od03Problems` reads every column matching
    // `(^|_)tax(_|$)` on every relation in `public` and there is no allowlist:
    // "nothing is permitted by being named, only by being structurally zero".
    // In the contract the mirror of that is the literal type `'0'`.
    expect(SOURCE).toMatch(/readonly taxMinor: '0';/);
    expect(SOURCE).not.toMatch(/taxRate|taxPercent|vat|jurisdiction/i);
  });
});
