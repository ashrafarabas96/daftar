'use client';
/**
 * What the customers page does before it reads anything (MVP-02), in the shape
 * of `stock/stock-page-kit.ts`: `ensureSession()` on mount, else to login.
 *
 * There is no access read to ask first: the customer routes name
 * `customers.view`, a Phase 4 key, and no endpoint answers "what may I see". So
 * the page asks the server and renders its answer — a 403 on load is
 * `common.noPermission`, any other failed load is the data-safe load failure —
 * and hides nothing on a guess.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ensureSession } from '@/lib/client';
import type { Locale } from '@/lib/i18n';
import { isPermissionRefusal } from '@/lib/phase3-errors';

/** The states a page shows instead of its screen. */
export type CustomerPhase = 'loading' | 'ready' | 'denied' | 'failed';

/** True once there is a session; sends the visitor to login otherwise. */
export function useCustomerSession(locale: Locale): boolean {
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

/** How a refused or failed load is shown: permission on a 403, the data-safe failure otherwise. */
export function phaseOfFailure(error: unknown): 'denied' | 'failed' {
  return isPermissionRefusal(error) ? 'denied' : 'failed';
}

/** One page of the list per read; the server's own maximum is 50. */
export const CUSTOMER_PAGE_SIZE = 20;
