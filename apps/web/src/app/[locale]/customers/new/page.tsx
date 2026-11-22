'use client';
/**
 * New customer (P4-S1): `POST /v1/customers`.
 *
 * The page holds no send logic of its own: one `CreateFlow` per form
 * (`views/customers/customer-create-flow.ts`) owns the id, the double-click
 * guard and the reading of an already-stored customer, and every outcome is
 * folded into the screen by `afterOutcome`. Both are tested without React.
 *
 * - The id is minted when the flow is created, i.e. once per form. A new flow
 *   is created only by "another customer", which the view offers only beside
 *   a saved or an already-stored customer. A reload while a send is
 *   unconfirmed re-opens THAT send's id from the page address
 *   (`?customer=<uuid>`, no browser storage) and reads it back before showing
 *   the form.
 * - No answer or a 5xx is never shown as "nothing was saved": the flow reads
 *   the customer back by its id.
 * - A refusal sets the refusal text and nothing else.
 */
import { use, useCallback, useEffect, useRef, useState } from 'react';
import { makeT, type Locale } from '@/lib/i18n';
import { createCustomer, getCustomer } from '@/lib/phase4-customers-api';
import { PageStateView } from '@/views/common/feedback';
import { CustomerCreateView } from '@/views/customers/CustomerCreateView';
import { planCreateCustomer, type CreateField, type CreateFormModel } from '@/views/customers/customer-create';
import {
  afterOutcome,
  beforeSend,
  createCustomerFlow,
  urlPendingMarker,
  type CreateFlow,
  type CreateOutcome,
  type CreateScreenState,
} from '@/views/customers/customer-create-flow';
import { PageShell } from '../../AppHeader';
import { useCreateSession } from './customer-create-page-kit';

const EMPTY_FORM: CreateFormModel = { name: '', phone: '', email: '', notes: '', errors: {} };

/** A flow re-opens the id of an unconfirmed send from the page address when there is one (a reload), and mints a new one otherwise. Called only in an effect, where `window` exists. */
const newFlow = (): CreateFlow => createCustomerFlow({ send: createCustomer, readStored: getCustomer, pending: urlPendingMarker(window) });

export default function NewCustomerPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = use(params);
  const t = makeT(locale);
  const [attempt, setAttempt] = useState(0);
  const session = useCreateSession(locale, attempt);
  const [screen, setScreen] = useState<CreateScreenState | null>(null);
  // One flow, one id, per form: created by a fresh session check and by nothing else.
  const flow = useRef<CreateFlow | null>(null);

  useEffect(() => {
    if (session.status !== 'ready') return;
    let live = true;
    const current = newFlow();
    flow.current = current;
    // A send from before a reload is read back FIRST: found, it is shown as saved; not found, the form comes with the same id behind it.
    const resumed = current.resume();
    setScreen({ form: EMPTY_FORM, busy: resumed !== null, errorKey: null, result: null, stored: null, storedUnread: false });
    if (resumed !== null) {
      void resumed.then((outcome) => {
        if (live) setScreen((s) => (s ? afterOutcome(s, outcome) : s));
      });
    }
    return () => {
      live = false;
    };
  }, [session.status]);

  /** A fresh form: a new flow, a new id. */
  const startOver = useCallback(() => setAttempt((n) => n + 1), []);

  function settle(pending: Promise<CreateOutcome> | null | undefined) {
    if (!pending) return;
    setScreen((s) => (s ? beforeSend(s) : s));
    void pending.then((outcome) => setScreen((s) => (s ? afterOutcome(s, outcome) : s)));
  }

  const onField = (field: CreateField, value: string) =>
    setScreen((s) => {
      if (!s) return s;
      const errors = { ...s.form.errors };
      delete errors[field];
      return { ...s, form: { ...s.form, [field]: value, errors } };
    });

  if (session.status !== 'ready' || !screen) {
    return (
      <PageShell locale={locale} active="customers">
        <PageStateView t={t} locale={locale} status={session.status === 'ready' ? 'loading' : session.status} onRetry={startOver} />
      </PageShell>
    );
  }

  return (
    <PageShell locale={locale} active="customers">
      <CustomerCreateView
        t={t}
        locale={locale}
        form={screen.form}
        busy={screen.busy}
        errorKey={screen.errorKey}
        result={screen.result}
        stored={screen.stored}
        storedUnread={screen.storedUnread}
        on={{
          onField,
          onSubmit: () => settle(flow.current?.submit((id) => planCreateCustomer(screen.form, id))),
          onRereadStored: () => settle(flow.current?.rereadStored()),
          onStartOver: startOver,
        }}
      />
    </PageShell>
  );
}
