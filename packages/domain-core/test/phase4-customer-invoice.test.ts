import { describe, expect, it } from 'vitest';
import {
  agingBucketLabels,
  CUSTOMER_STATUSES,
  CUSTOMER_TEXT_BOUNDS,
  CUSTOMER_TRANSITIONS,
  INVOICE_LIFECYCLE_STATES,
  INVOICE_LIFECYCLE_TRANSITIONS,
  INVOICE_SETTLEMENT_STATES,
  isCustomerTransitionAllowed,
  isInvoiceLifecycleTransitionAllowed,
  isStructuralZeroTax,
  MAX_AGING_BUCKETS,
  MAX_CUSTOMER_CONTACTS,
  NUMBERED_DOCUMENT_KINDS,
  normalizeCustomerText,
  STRUCTURAL_ZERO_TAX_MINOR,
  validateAgingBucketDays,
  validateCustomerStatement,
  type CustomerContactStatement,
} from '../src';

/**
 * P4-S1 — the pure customer and invoice domain rules.
 *
 * Nothing here touches a database, and nothing here computes money: the
 * receivable, the outstanding and the settlement state are derived by the
 * product's own SQL functions (P4-AL-07), so a test of them belongs to the
 * slice that ships those functions and would be a second implementation here.
 */

const contact = (over: Partial<CustomerContactStatement> = {}): CustomerContactStatement => ({
  contactId: '11111111-1111-4111-8111-111111111111',
  name: 'Layla',
  phone: '+962790000000',
  ...over,
});

describe('customer lifecycle (P4-AL-08, P4-AL-46)', () => {
  it('has exactly two states and no delete', () => {
    expect([...CUSTOMER_STATUSES]).toEqual(['active', 'inactive']);
  });

  it('permits archive and reactivate, and nothing else', () => {
    expect(isCustomerTransitionAllowed('active', 'inactive')).toBe(true);
    expect(isCustomerTransitionAllowed('inactive', 'active')).toBe(true);
    // A same-state move is not a transition: an idempotent replay answers the
    // stored row, it does not re-run a transition.
    expect(isCustomerTransitionAllowed('active', 'active')).toBe(false);
    expect(CUSTOMER_TRANSITIONS).toHaveLength(2);
  });
});

describe('customer statement validation', () => {
  it('accepts a minimal statement', () => {
    expect(validateCustomerStatement({ name: 'Abu Ahmad' })).toEqual([]);
  });

  it('refuses an empty or whitespace-only name', () => {
    expect(validateCustomerStatement({ name: '   ' })).toEqual(['name_invalid']);
  });

  it('refuses a name beyond the stored bound, counted in code points', () => {
    // An astral character is ONE code point and PostgreSQL's char_length counts
    // it as one, so a bound checked with `String.length` would refuse text the
    // column accepts. The bound is checked over code points.
    const exactly = '\u{1F600}'.repeat(CUSTOMER_TEXT_BOUNDS.name.max);
    expect(validateCustomerStatement({ name: exactly })).toEqual([]);
    expect(validateCustomerStatement({ name: `${exactly}\u{1F600}` })).toEqual(['name_invalid']);
  });

  it('refuses text holding a NUL, which PostgreSQL cannot store', () => {
    expect(validateCustomerStatement({ name: 'a\u0000b' })).toEqual(['name_invalid']);
  });

  it('refuses an email that is not address-shaped, and accepts one that is', () => {
    expect(validateCustomerStatement({ name: 'x', email: 'not-an-address' })).toEqual(['email_invalid']);
    expect(validateCustomerStatement({ name: 'x', email: 'a@b.co' })).toEqual([]);
  });

  it('treats an omitted, null and empty optional field alike: cleared, not refused', () => {
    expect(validateCustomerStatement({ name: 'x' })).toEqual([]);
    expect(validateCustomerStatement({ name: 'x', phone: null })).toEqual([]);
    expect(validateCustomerStatement({ name: 'x', phone: '   ' })).toEqual([]);
    expect(normalizeCustomerText('   ')).toBeNull();
    expect(normalizeCustomerText(' a ')).toBe('a');
  });

  it('refuses more contacts than one statement may carry', () => {
    const many = Array.from({ length: MAX_CUSTOMER_CONTACTS + 1 }, (_, i) => contact({ contactId: `1111111${i % 10}-1111-4111-8111-11111111111${i % 10}` }));
    expect(validateCustomerStatement({ name: 'x', contacts: many })).toContain('contacts_too_many');
  });

  it('refuses a duplicate contact id and a non-canonical one', () => {
    expect(validateCustomerStatement({ name: 'x', contacts: [contact(), contact()] })).toContain('contact_id_duplicate');
    expect(validateCustomerStatement({ name: 'x', contacts: [contact({ contactId: '11111111-1111-4111-8111-11111111111Z' })] })).toContain(
      'contact_id_invalid',
    );
    // An upper-case UUID is refused rather than lower-cased into acceptance:
    // the intent digest binds the exact spelling.
    expect(validateCustomerStatement({ name: 'x', contacts: [contact({ contactId: '11111111-1111-4111-8111-11111111111A' })] })).toContain(
      'contact_id_invalid',
    );
  });

  it('refuses a contact nobody can reach', () => {
    expect(validateCustomerStatement({ name: 'x', contacts: [contact({ phone: null, email: null })] })).toContain('contact_reachability_missing');
    expect(validateCustomerStatement({ name: 'x', contacts: [contact({ phone: null, email: 'a@b.co' })] })).toEqual([]);
  });

  it('refuses two primary contacts and accepts none or one', () => {
    const a = contact({ isPrimary: true });
    const b = contact({ contactId: '22222222-2222-4222-8222-222222222222', isPrimary: true });
    expect(validateCustomerStatement({ name: 'x', contacts: [a, b] })).toContain('contact_primary_ambiguous');
    expect(validateCustomerStatement({ name: 'x', contacts: [a] })).toEqual([]);
    expect(validateCustomerStatement({ name: 'x', contacts: [contact()] })).toEqual([]);
  });

  it('reports every problem, not the first', () => {
    const problems = validateCustomerStatement({ name: '', email: 'nope', notes: 'n'.repeat(CUSTOMER_TEXT_BOUNDS.notes.max + 1) });
    expect(problems).toEqual(['name_invalid', 'email_invalid', 'notes_invalid']);
  });
});

describe('the customer carries no derived truth (P4-AL-06, OD-P4-03)', () => {
  it('exposes no balance, due, outstanding, settled or credit-limit surface', () => {
    // A guard proves this of the SCHEMA; this proves it of the domain module,
    // so a helper cannot be added here and then invite the column.
    const exported = Object.keys(CUSTOMER_TEXT_BOUNDS);
    expect(exported).toEqual(['name', 'phone', 'email', 'notes', 'contactName', 'contactNotes']);
    for (const forbidden of ['balance', 'due', 'outstanding', 'settled', 'paid', 'limit', 'credit']) {
      expect(exported.some((k) => k.toLowerCase().includes(forbidden))).toBe(false);
    }
  });
});

describe('invoice lifecycle (P4-AL-24, P4-AL-46)', () => {
  it('is lifecycle only: three states, none of them a settlement state', () => {
    expect([...INVOICE_LIFECYCLE_STATES]).toEqual(['draft', 'open', 'void']);
    for (const settlement of INVOICE_SETTLEMENT_STATES) {
      expect(INVOICE_LIFECYCLE_STATES).not.toContain(settlement);
    }
  });

  it('permits draft→open, draft→void and open→void, and nothing else', () => {
    expect(isInvoiceLifecycleTransitionAllowed('draft', 'open')).toBe(true);
    expect(isInvoiceLifecycleTransitionAllowed('draft', 'void')).toBe(true);
    expect(isInvoiceLifecycleTransitionAllowed('open', 'void')).toBe(true);
    expect(INVOICE_LIFECYCLE_TRANSITIONS).toHaveLength(3);
  });

  it('has no path back to draft and no path out of void', () => {
    expect(isInvoiceLifecycleTransitionAllowed('open', 'draft')).toBe(false);
    expect(isInvoiceLifecycleTransitionAllowed('void', 'open')).toBe(false);
    expect(isInvoiceLifecycleTransitionAllowed('void', 'draft')).toBe(false);
  });

  it('derives its settlement vocabulary and stores none of it', () => {
    expect([...INVOICE_SETTLEMENT_STATES]).toEqual(['unpaid', 'partial', 'paid']);
  });
});

describe('the tax boundary (P4-AL-44, OD-03 OPEN)', () => {
  it('admits exactly one tax amount, the integer zero', () => {
    expect(STRUCTURAL_ZERO_TAX_MINOR).toBe('0');
    expect(isStructuralZeroTax('0')).toBe(true);
  });

  it('refuses every other spelling, including ones that look like zero', () => {
    for (const value of ['0.00', '-0', '00', '', ' 0', '0 ', '1']) {
      expect(isStructuralZeroTax(value)).toBe(false);
    }
  });
});

describe('document numbering (P4-AL-31)', () => {
  it('numbers exactly two document kinds', () => {
    expect([...NUMBERED_DOCUMENT_KINDS]).toEqual(['invoice', 'credit_note']);
  });
});

describe('aging boundaries are supplied, never invented (OD-P4-03, lock §4)', () => {
  it('accepts a strictly ascending set inside the bounds', () => {
    expect(validateAgingBucketDays([30, 60, 90])).toEqual([]);
    expect(validateAgingBucketDays([1])).toEqual([]);
  });

  it('refuses an empty set, an over-long one, a non-ascending one and an out-of-range day', () => {
    expect(validateAgingBucketDays([])).toEqual(['bucket_days_empty']);
    expect(validateAgingBucketDays(Array.from({ length: MAX_AGING_BUCKETS + 1 }, (_, i) => i + 1))).toContain('bucket_days_too_many');
    expect(validateAgingBucketDays([30, 30])).toEqual(['bucket_days_not_ascending']);
    expect(validateAgingBucketDays([60, 30])).toEqual(['bucket_days_not_ascending']);
    expect(validateAgingBucketDays([0])).toEqual(['bucket_days_out_of_range']);
    expect(validateAgingBucketDays([4000])).toEqual(['bucket_days_out_of_range']);
    expect(validateAgingBucketDays([1.5])).toEqual(['bucket_days_out_of_range']);
  });

  it('labels one bucket per boundary plus the open bucket', () => {
    expect([...agingBucketLabels([30, 60, 90])]).toEqual(['0-30', '31-60', '61-90', 'over-90']);
    expect([...agingBucketLabels([7])]).toEqual(['0-7', 'over-7']);
  });
});
