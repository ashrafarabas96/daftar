'use client';
/**
 * What "New customer" needs before it shows the form: a session, and nothing
 * else. There is no access read to ask first: the route names
 * `customers.manage`, a Phase 4 key, and no endpoint answers "what may I do".
 * So the page shows the form and renders the server's answer: a 403 on send is
 * the refusal text beside the kept form.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ensureSession } from '@/lib/client';
import type { Locale } from '@/lib/i18n';
import type { PageStatus } from '@/views/common/feedback';

export interface CreateSession {
  status: PageStatus | 'ready';
}

/** A session; to login when there is none. `attempt` re-runs it (the page's "try again" and "another customer"). */
export function useCreateSession(locale: Locale, attempt: number): CreateSession {
  const router = useRouter();
  const [state, setState] = useState<CreateSession>({ status: 'loading' });
  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    void (async () => {
      try {
        if (!(await ensureSession())) {
          router.push(`/${locale}/login`);
          return;
        }
        if (live) setState({ status: 'ready' });
      } catch {
        if (live) setState({ status: 'failed' });
      }
    })();
    return () => {
      live = false;
    };
  }, [locale, router, attempt]);
  return state;
}
