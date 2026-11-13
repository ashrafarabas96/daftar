'use client';
/**
 * What "Receive a payment" needs before it reads the customer: a session, and
 * the business's base currency (the default payment currency when the
 * customer has no open invoice). Read from `GET /v1/me/businesses`, the same
 * read `purchases/_shared/merchant-context.ts` uses, but WITHOUT its inventory
 * access read: that read needs an inventory grant this screen does not, and a
 * 403 from it would hide a screen the merchant may use.
 *
 * There is no access read to ask first: the routes name `customers.view`,
 * `receivables.view` and `payments.collect`, Phase 4 keys, and no endpoint
 * answers "what may I do". So the page asks the server and renders its
 * answer — a 403 on load is `common.noPermission`, a 403 on send is the
 * refusal text beside the kept form.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { currentBusinessId, ensureSession } from '@/lib/client';
import type { Locale } from '@/lib/i18n';
import { getMyBusinesses } from '@/lib/merchant-api';
import { isPermissionRefusal } from '@/lib/phase3-errors';
import type { PageStatus } from '@/views/common/feedback';

/** A refused or failed load: permission on a 403, the data-safe failure otherwise. */
export function loadFailureStatus(error: unknown): Exclude<PageStatus, 'loading'> {
  return isPermissionRefusal(error) ? 'denied' : 'failed';
}

/** The read the open invoices are paged by; the server's own maximum is 50. */
export const OPEN_INVOICES_PAGE = 50;

export interface CollectSession {
  status: PageStatus | 'ready';
  baseCurrency: string | null;
}

/** A session and the current business's base currency; to login when there is no session. */
export function useCollectSession(locale: Locale, attempt: number): CollectSession {
  const router = useRouter();
  const [state, setState] = useState<CollectSession>({ status: 'loading', baseCurrency: null });
  useEffect(() => {
    let live = true;
    setState({ status: 'loading', baseCurrency: null });
    void (async () => {
      if (!(await ensureSession())) {
        router.push(`/${locale}/login`);
        return;
      }
      try {
        const mine = await getMyBusinesses();
        const found = mine.items.find((b) => b.businessId === currentBusinessId());
        if (live) setState(found ? { status: 'ready', baseCurrency: found.baseCurrency } : { status: 'failed', baseCurrency: null });
      } catch (error) {
        if (live) setState({ status: loadFailureStatus(error), baseCurrency: null });
      }
    })();
    return () => {
      live = false;
    };
  }, [locale, router, attempt]);
  return state;
}
