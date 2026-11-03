import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ar from '@/messages/ar.json';
import en from '@/messages/en.json';
import tr from '@/messages/tr.json';
import { ApiError } from '@/lib/client';
import { FALLBACK_ERROR_KEY, RETRYABLE_CONFLICTS, isRetryableConflict, refusalKey, withConflictRetry } from '@/lib/phase3-errors';
import {
  ENVELOPE_CODES,
  MERCHANT_ACCOUNTING_CODES,
  OD03_UNKEYED,
  REPO_ROOT,
  accountingCodes,
  inventoryCodes,
  paymentMethodCodes,
  purchasingCodes,
} from './helpers/refusal-codes';

/**
 * T-10 (P3-S7 contract §6, A-15(d); Annex R #9–#12): every refusal code an S7
 * screen can meet has `error.<code>` in ar, en and tr, and each text is a
 * sentence for a merchant — never a code.
 */
const CATALOGS: Readonly<Record<'ar' | 'en' | 'tr', Readonly<Record<string, string>>>> = { ar, en, tr };

/** A token that looks like a code rather than words: `snake_case`, `dotted.code` or an upper-case envelope code. */
const CODE_LIKE = /\b[a-z]+_[a-z_]+\b|\b[a-z]+\.[a-z_]+\b|\b[A-Z]{2,}_[A-Z_]+\b/;

const purchasing = purchasingCodes();
const paymentMethod = paymentMethodCodes();
const inventory = inventoryCodes();

/**
 * The keys of `RECEIVABLES_STATUS` (P4-S4), read out of the API source the way
 * `helpers/refusal-codes.ts` reads every other explicit table — the object
 * literal's keys, never a list kept beside it.
 *
 * Returns `[]` when `receivables-errors.ts` has not merged into this tree,
 * which is a real state while the slice's agents work in parallel worktrees.
 * It is read locally rather than added to the shared helper because that
 * helper's readers THROW on a missing module, which is right for a Phase 3
 * table that must always be there and wrong for a Phase 4 one that is still
 * landing. The caller makes the absence visible rather than passing quietly.
 */
function receivablesCodes(): readonly string[] {
  let source: string;
  try {
    source = readFileSync(join(REPO_ROOT, 'apps/api/src/modules/receivables/receivables-errors.ts'), 'utf8');
  } catch {
    return [];
  }
  const from = source.indexOf('const RECEIVABLES_STATUS = {');
  if (from < 0) throw new Error('receivables-errors.ts no longer declares `const RECEIVABLES_STATUS = {`');
  const to = source.indexOf('\n} as const', from);
  if (to < 0) throw new Error('receivables-errors.ts: the RECEIVABLES_STATUS table does not end in `} as const`');
  const codes = [...new Set([...source.slice(from, to).matchAll(/^ {2}'([a-z_]+\.[a-z_]+)':/gm)].map((m) => m[1] ?? ''))];
  if (codes.length === 0) throw new Error('receivables-errors.ts: the RECEIVABLES_STATUS table reads empty');
  return codes.sort();
}

const REQUIRED: readonly string[] = [
  ...purchasing.filter((c) => !OD03_UNKEYED.includes(c)),
  ...paymentMethod,
  ...inventory,
  ...MERCHANT_ACCOUNTING_CODES,
  ...ENVELOPE_CODES,
];

describe('T-10 — every S7-reachable refusal code has merchant text in ar, en and tr', () => {
  it('reads the explicit tables from the API code, and they hold the S6 codes the rulings name', () => {
    expect(purchasing.length).toBeGreaterThan(80);
    expect(paymentMethod.length).toBeGreaterThanOrEqual(12);
    expect(inventory.length).toBeGreaterThan(90);
    for (const code of [
      'supplier_credit_note.not_found',
      'supplier_payment.residue_below_base_unit',
      'supplier_credit_allocation.residue_below_base_unit',
      'supplier_refund.residue_below_base_unit',
    ]) {
      expect(purchasing, code).toContain(code);
    }
    expect(inventory).toContain('structure.warehouse_archived');
    const known = new Set(accountingCodes());
    for (const code of MERCHANT_ACCOUNTING_CODES) expect(known.has(code), `${code} is an AccountingErrorCode`).toBe(true);
  });

  it('has a non-empty key for every code in every locale', () => {
    const missing: string[] = [];
    for (const code of REQUIRED) {
      for (const [locale, catalog] of Object.entries(CATALOGS)) {
        const value = catalog[`error.${code}`];
        if (typeof value !== 'string' || value.trim().length === 0) missing.push(`${locale}: error.${code}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('keys every *.residue_below_base_unit and every supplier_credit_note.* code', () => {
    const wanted = purchasing.filter((c) => c.endsWith('.residue_below_base_unit') || c.startsWith('supplier_credit_note.'));
    expect(wanted.length).toBeGreaterThanOrEqual(6);
    for (const code of wanted) for (const catalog of Object.values(CATALOGS)) expect(catalog[`error.${code}`], code).toBeTruthy();
  });

  it('every error text is words, not a code, and answers the "is my data safe" question', () => {
    const SAFE: Readonly<Record<string, RegExp>> = {
      en: /Nothing was (saved|changed)/,
      ar: /لم (يُحفظ|يتغيّر|تُحفظ)/,
      tr: /(kaydedilmedi|değişmedi)/,
    };
    for (const [locale, catalog] of Object.entries(CATALOGS)) {
      for (const [key, value] of Object.entries(catalog)) {
        if (!key.startsWith('error.') || key === 'error.generic' || key === 'error.rateLimited') continue;
        expect(CODE_LIKE.test(value), `${locale} ${key}: "${value}"`).toBe(false);
        expect(value, `${locale} ${key}`).toMatch(SAFE[locale] ?? /./);
      }
    }
  });

  it('keeps OD-03 codes unkeyed, and they fall back to the data-safe text', () => {
    for (const code of OD03_UNKEYED) {
      expect(en[`error.${code}` as keyof typeof en]).toBeUndefined();
      expect(refusalKey(new ApiError(422, 'VALIDATION_FAILED', { purchasingCode: code }))).toBe(FALLBACK_ERROR_KEY);
    }
  });
});

describe('refusalKey and the retryable 409s (§3(a)(c), Annex R #9, #12)', () => {
  it('maps the domain code, then the envelope code, then the fallback', () => {
    expect(refusalKey(new ApiError(409, 'CONFLICT', { inventoryCode: 'inventory.insufficient_stock' }))).toBe('error.inventory.insufficient_stock');
    expect(refusalKey(new ApiError(422, 'ACCOUNTING_REFUSED', { code: 'accounting.fx_rate_missing' }))).toBe('error.accounting.fx_rate_missing');
    expect(refusalKey(new ApiError(404, 'NOT_FOUND'))).toBe('error.NOT_FOUND');
    expect(refusalKey(new ApiError(500, 'INTERNAL_ERROR', { purchasingCode: 'supplier.never_heard_of_it' }))).toBe(FALLBACK_ERROR_KEY);
    expect(refusalKey(new TypeError('Failed to fetch'))).toBe(FALLBACK_ERROR_KEY);
    expect(en[FALLBACK_ERROR_KEY]).toBe('Nothing was saved. Your data is safe — try again');
  });

  it('retries exactly the codes the S5/S6 tables mark retry: yes, each a real 409 code', () => {
    expect([...RETRYABLE_CONFLICTS].sort()).toEqual(
      [
        'inventory.valuation_changed',
        'purchase.fx_rate_changed',
        'supplier_credit_allocation.settlement_changed',
        'supplier_payment.fx_rate_changed',
        'supplier_payment.settlement_changed',
        'supplier_refund.fx_rate_changed',
        'supplier_refund.settlement_changed',
        // P4-S4: the receivables twins. Both commands are the SUPPLIER command
        // shape, so a figure that moved between the service's read and the
        // routine's locks is the same retryable race. There is no
        // `customer_credit_application.fx_rate_changed`: applying a credit
        // states no new rate, so only the payment path can meet a moved one.
        'customer_payment.settlement_changed',
        'customer_payment.fx_rate_changed',
        'customer_credit_application.settlement_changed',
      ].sort(),
    );
    // Every retryable code is one the API REALLY declares, checked against the
    // registry that owns its namespace rather than against a list kept here.
    //
    // The receivables registry must BE THERE. `receivablesCodes()` answers
    // `[]` on a tree where `receivables-errors.ts` has not merged, which was a
    // real state while the slice's agents worked in parallel worktrees — but
    // an empty answer would make every receivables check below pass over
    // nothing, so it is refused HERE, before the loop, rather than tolerated.
    // This is the assertion that keeps the loop honest: with it, the three
    // receivables codes are checked against the registry unconditionally.
    const receivables = receivablesCodes();
    expect(
      receivables.length,
      'receivables-errors.ts declares no RECEIVABLES_STATUS codes — every receivables check below would pass over nothing',
    ).toBeGreaterThan(0);
    const isReceivable = (code: string) => /^customer_(?:payment|credit|credit_application)\./.test(code);
    for (const code of RETRYABLE_CONFLICTS) {
      if (isReceivable(code)) {
        expect(receivables, code).toContain(code);
      } else {
        expect([...purchasing, ...inventory], code).toContain(code);
      }
    }
    expect(isRetryableConflict(new ApiError(409, 'CONFLICT', { purchasingCode: 'supplier_refund.fx_rate_changed' }))).toBe(true);
    expect(isRetryableConflict(new ApiError(409, 'CONFLICT', { purchasingCode: 'supplier_payment.idempotency_conflict' }))).toBe(false);
    expect(isRetryableConflict(new ApiError(422, 'VALIDATION_FAILED', { purchasingCode: 'supplier_payment.settlement_changed' }))).toBe(false);
  });

  it('withConflictRetry runs the same command once more on a retryable 409, and only once', async () => {
    let calls = 0;
    const flaky = () => {
      calls += 1;
      return calls === 1 ? Promise.reject(new ApiError(409, 'CONFLICT', { purchasingCode: 'supplier_payment.settlement_changed' })) : Promise.resolve('ok');
    };
    await expect(withConflictRetry(flaky)).resolves.toBe('ok');
    expect(calls).toBe(2);
    let twice = 0;
    const always = () => {
      twice += 1;
      return Promise.reject(new ApiError(409, 'CONFLICT', { inventoryCode: 'inventory.valuation_changed' }));
    };
    await expect(withConflictRetry(always)).rejects.toBeInstanceOf(ApiError);
    expect(twice).toBe(2);
    let other = 0;
    const refused = () => {
      other += 1;
      return Promise.reject(new ApiError(409, 'CONFLICT', { inventoryCode: 'inventory.insufficient_stock' }));
    };
    await expect(withConflictRetry(refused)).rejects.toBeInstanceOf(ApiError);
    expect(other).toBe(1);
  });
});
