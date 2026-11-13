'use client';
/**
 * What the customer account page does around its reads (MVP-02), in the shape
 * of `customers-page-kit.ts` (the customers list): `ensureSession()` on mount,
 * else to login; a refused load is the permission state on a 403, not-found
 * on a 404, and the data-safe failure otherwise.
 *
 * And one rule that page does not need: **an answer this screen cannot place is
 * refused, not shown under a guess.** `unreadableAccount` names every amount
 * that is not minor-unit text, every age band outside the 0,30,60,90 set, a
 * band list of the wrong length, a held amount below zero and an as-of date
 * that is not the one asked for. The page treats any finding as a failed load.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ensureSession } from '@/lib/client';
import type { Locale } from '@/lib/i18n';
import { splitMinorSign } from '@/lib/minor-sign';
import { isPermissionRefusal } from '@/lib/phase3-errors';
import { localDateIso } from '@/lib/phase3-format';
import { AGE_BAND_KEYS } from '@/lib/phase4-customer-account-api';
import { ApiError } from '@/lib/client';
import type { CustomerAccountViewProps } from '@/views/customers/CustomerAccountView';

/** The states the page shows instead of its screen, and `missing`, which renders not-found. */
export type AccountPhase = 'loading' | 'ready' | 'denied' | 'failed' | 'missing';

/** One page of open invoices per read; the server's own maximum is 50. */
export const OPEN_INVOICE_PAGE_SIZE = 20;

/**
 * The as-of date every dated read is asked at: the merchant's calendar day in
 * the browser, the same rule as a new document's default date. Read ONCE per
 * visit, so the aging and the open invoices are measured to the same day and
 * "show more" does not drift across midnight. The server reads no clock of its
 * own for these routes, by design.
 */
export const accountAsOf = (): string => localDateIso();

/** True once there is a session; sends the visitor to login otherwise. */
export function useAccountSession(locale: Locale): boolean {
  const router = useRouter();
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => {
    let live = true;
    void (async () => {
      if (await ensureSession()) {
        if (live) setSignedIn(true);
        return;
      }
      router.push(`/${locale}/login`);
    })();
    return () => {
      live = false;
    };
  }, [locale, router]);
  return signedIn;
}

/** How a refused or failed load is shown. */
export function phaseOfFailure(error: unknown): 'denied' | 'failed' | 'missing' {
  if (error instanceof ApiError && error.status === 404) return 'missing';
  return isPermissionRefusal(error) ? 'denied' : 'failed';
}

type Answers = Pick<CustomerAccountViewProps, 'receivable' | 'aging' | 'openInvoices' | 'credits'>;

/** The band tokens of the offered set, in the server's order. */
const BAND_ORDER = Object.keys(AGE_BAND_KEYS);

/** Every place in the answers the screen cannot show as stated; `[]` when it can show all of it. */
export function unreadableAccount(answers: Answers, asOf: string): string[] {
  const out: string[] = [];
  const amount = (path: string, value: string): void => {
    if (splitMinorSign(value) === null) out.push(path);
  };
  amount('receivable.baseMinor', answers.receivable.baseMinor);
  answers.receivable.byCurrency.forEach((line, i) => amount(`receivable.byCurrency[${i}].txnMinor`, line.txnMinor));
  if (answers.aging.asOf !== asOf) out.push('aging.asOf');
  if (answers.aging.buckets.length !== BAND_ORDER.length) out.push('aging.buckets');
  answers.aging.buckets.forEach((bucket, i) => {
    if (bucket.label !== BAND_ORDER[i]) out.push(`aging.buckets[${i}].label`);
    // The sentence of a band names its bounds, so a bound it names must be there.
    const key = AGE_BAND_KEYS[bucket.label];
    if (key === 'customers.account.age.band' && (bucket.fromDays === null || bucket.toDays === null)) out.push(`aging.buckets[${i}].days`);
    if (key === 'customers.account.age.over' && bucket.fromDays === null) out.push(`aging.buckets[${i}].days`);
    amount(`aging.buckets[${i}].baseMinor`, bucket.baseMinor);
    bucket.byCurrency.forEach((line, j) => amount(`aging.buckets[${i}].byCurrency[${j}].txnMinor`, line.txnMinor));
  });
  answers.openInvoices.forEach((invoice, i) => {
    amount(`openInvoices[${i}].outstandingTxnMinor`, invoice.outstandingTxnMinor);
    amount(`openInvoices[${i}].totalTxnMinor`, invoice.totalTxnMinor);
  });
  answers.credits.forEach((held, i) => {
    // A held amount is what is LEFT of it, so below zero is not a figure the screen can word.
    const split = splitMinorSign(held.remainingAmountMinor);
    if (split === null || split.sign === 'negative') out.push(`credits[${i}].remainingAmountMinor`);
  });
  return out;
}
