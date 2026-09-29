'use client';
/**
 * What every purchasing and supplier page loads first (P3-S7 contract A-11):
 * the session, the caller's own Phase 3 grants (`GET /v1/inventory/access`)
 * and the business (its id and currency). The grants are advisory — they
 * only decide which actions a page offers; every read and command still
 * enforces its own authority on the server.
 *
 * The business comes from `GET /v1/me/businesses` (the caller's own
 * memberships, no permission needed), as on the stock screens — not from
 * `GET /v1/businesses/current`, which needs `business.view`: a custom role
 * holding `purchases.*` or `suppliers.*` without it must still reach its
 * screens (S7 UX review m-9).
 *
 * A 403 on this load renders the permission state, any other failure the
 * data-safe state with a retry (§3(b), (d)).
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { currentBusinessId, ensureSession } from '@/lib/client';
import type { Locale } from '@/lib/i18n';
import { getMyBusinesses } from '@/lib/merchant-api';
import { getInventoryAccess, type InventoryAccessDto, type Phase3Permission } from '@/lib/phase3-api';
import { isPermissionRefusal } from '@/lib/phase3-errors';
import type { PageStatus } from '@/views/common/feedback';

/** The business a page works in: what the pages read of it. */
export interface MerchantBusiness {
  businessId: string;
  baseCurrency: string;
}

export interface MerchantContext {
  access: InventoryAccessDto;
  business: MerchantBusiness;
  /** True when the caller holds the permission (advisory: the server decides). */
  can: (permission: Phase3Permission) => boolean;
}

export interface MerchantContextState {
  status: PageStatus | 'ready';
  context: MerchantContext | null;
  retry: () => void;
}

/** A load failure as a page status: a 403 is the permission state, anything else the data-safe retry. */
export function statusOfFailure(error: unknown): PageStatus {
  return isPermissionRefusal(error) ? 'denied' : 'failed';
}

export function useMerchantContext(locale: Locale): MerchantContextState {
  const router = useRouter();
  const [status, setStatus] = useState<PageStatus | 'ready'>('loading');
  const [context, setContext] = useState<MerchantContext | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setStatus('loading');
    void (async () => {
      if (!(await ensureSession())) {
        router.push(`/${locale}/login`);
        return;
      }
      try {
        const [access, mine] = await Promise.all([getInventoryAccess(), getMyBusinesses()]);
        if (!live) return;
        const current = currentBusinessId();
        const found = mine.items.find((b) => b.businessId === current);
        if (!found) {
          setStatus('failed');
          return;
        }
        const business: MerchantBusiness = { businessId: found.businessId, baseCurrency: found.baseCurrency };
        const granted = new Set<string>(access.permissions);
        setContext({ access, business, can: (permission) => granted.has(permission) });
        setStatus('ready');
      } catch (error) {
        if (live) setStatus(statusOfFailure(error));
      }
    })();
    return () => {
      live = false;
    };
  }, [locale, router, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { status, context, retry };
}
