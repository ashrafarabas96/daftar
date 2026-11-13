'use client';
/**
 * The credit sale (البيع بالدين): `POST /v1/sales` with `settlementMode:
 * 'credit'`, owed by the customer the route names.
 *
 * The customer comes from the ROUTE and from nothing else: a credit sale is a
 * debt of a named customer (the debt is the sales document), so this page is
 * reached for one customer and sells to that one. There is no customer picker
 * here and no walk-in arm.
 *
 * The page reads the customer, the warehouses it may sell from and the unit
 * names, searches the items as the merchant types (the stock screens' own
 * picker), and sends what the merchant typed. It holds no send logic of its
 * own: one `CreditSaleFlow` per form (`views/sales/credit-sale-flow.ts`) owns
 * the ids, the double-click guard and the reading of an already-stored sale,
 * and every outcome is folded into the screen by `afterOutcome`. Both are
 * tested without React.
 *
 * - The ids are minted when the flow is created, i.e. once per form. A new
 *   flow — a new form, new ids — is created only by a fresh load, which the
 *   view offers only beside a saved or an already-stored sale.
 * - The sale date is the browser's calendar day when the form OPENED
 *   (`localDateIso`), held in the form: a retry sent either side of midnight
 *   is the same command (`[[daftar-a-command-must-not-read-the-clock]]`).
 * - A refusal sets the refusal text and nothing else.
 * - A 403 on load renders the permission state; on send, the refusal text.
 */
import { use, useCallback, useEffect, useRef, useState } from 'react';
import { notFound, useRouter } from 'next/navigation';
import type { CustomerDto, InventoryWarehouseDto } from '@daftar/shared-contracts';
import { ensureSession } from '@/lib/client';
import { makeT, type Locale } from '@/lib/i18n';
import { listInventoryUnits, listInventoryWarehouses } from '@/lib/phase3-api';
import { isPermissionRefusal } from '@/lib/phase3-errors';
import { localDateIso } from '@/lib/phase3-format';
import { commitCreditSale, getCustomer, getStoredSale } from '@/lib/phase4-credit-sale-api';
import { isUuid } from '@/lib/route-ids';
import { PageStateView, type PageStatus } from '@/views/common/feedback';
import { CreditSaleView, type CreditSaleFormField } from '@/views/sales/CreditSaleView';
import { planCreditSale } from '@/views/sales/credit-sale';
import {
  afterOutcome,
  beforeSend,
  createCreditSaleFlow,
  type CreditSaleFlow,
  type CreditSaleOutcome,
  type CreditSaleScreenState,
} from '@/views/sales/credit-sale-flow';
import { draftLineOf, type PickOption } from '@/views/stock/model';
import { PageShell } from '../../../AppHeader';
import { onlyActiveWarehouse, usePickOptions } from '../../../stock/stock-page-kit';

const newFlow = (): CreditSaleFlow => createCreditSaleFlow({ send: commitCreditSale, readStored: getStoredSale });

export default function CreditSalePage({ params }: { params: Promise<{ locale: Locale; customerId: string }> }) {
  const { locale, customerId } = use(params);
  // An id from the URL reaches no API path unless it is a UUID (L-1).
  if (!isUuid(customerId)) notFound();
  const t = makeT(locale);
  const router = useRouter();
  const [attempt, setAttempt] = useState(0);
  const [loadStatus, setLoadStatus] = useState<PageStatus | 'ready'>('loading');
  const [customer, setCustomer] = useState<CustomerDto | null>(null);
  const [warehouses, setWarehouses] = useState<InventoryWarehouseDto[]>([]);
  const [unitNames, setUnitNames] = useState<Readonly<Record<string, string>>>({});
  const [search, setSearch] = useState('');
  const [screen, setScreen] = useState<CreditSaleScreenState | null>(null);
  // One flow — one set of ids — per form, created by a fresh load and by nothing else.
  const flow = useRef<CreditSaleFlow | null>(null);
  const picking = loadStatus === 'ready' && screen !== null && screen.result === null && screen.stored === null && !screen.storedUnread;
  const picker = usePickOptions('items', '', search, picking);

  useEffect(() => {
    let live = true;
    setLoadStatus('loading');
    void (async () => {
      if (!(await ensureSession())) {
        router.push(`/${locale}/login`);
        return;
      }
      try {
        const [c, w, u] = await Promise.all([getCustomer(customerId), listInventoryWarehouses(), listInventoryUnits()]);
        if (!live) return;
        flow.current = newFlow();
        setCustomer(c);
        setWarehouses(w.items);
        setUnitNames(Object.fromEntries(u.items.map((unit) => [unit.unitCode, unit.name])));
        setSearch('');
        setScreen({
          form: { warehouseId: onlyActiveWarehouse(w.items), documentDate: localDateIso(), dueDate: '', errors: {} },
          lines: [],
          lineErrors: {},
          busy: false,
          errorKey: null,
          result: null,
          stored: null,
          storedUnread: false,
        });
        setLoadStatus('ready');
      } catch (error) {
        if (live) setLoadStatus(isPermissionRefusal(error) ? 'denied' : 'failed');
      }
    })();
    return () => {
      live = false;
    };
  }, [customerId, locale, router, attempt]);

  /** A fresh form: everything re-read, a new flow, new ids. */
  const startOver = useCallback(() => setAttempt((n) => n + 1), []);

  function settle(pending: Promise<CreditSaleOutcome> | null | undefined) {
    if (!pending) return;
    setScreen((s) => (s ? beforeSend(s) : s));
    void pending.then((outcome) => setScreen((s) => (s ? afterOutcome(s, outcome) : s)));
  }

  function submit() {
    if (!screen) return;
    const { form, lines } = screen;
    settle(flow.current?.submit((ids) => planCreditSale({ customerId, form, lines, ids })));
  }

  const onField = (field: CreditSaleFormField, value: string) => {
    const errorOf = { warehouseId: 'warehouse', documentDate: 'date', dueDate: 'dueDate' } as const;
    setScreen((s) => (s ? { ...s, form: { ...s.form, [field]: value, errors: { ...s.form.errors, [errorOf[field]]: false } } } : s));
  };

  const onPick = (option: PickOption) => {
    setScreen((s) =>
      s && !s.lines.some((l) => l.key === option.key)
        ? { ...s, lines: [...s.lines, draftLineOf(option, crypto.randomUUID())], form: { ...s.form, errors: { ...s.form.errors, lines: false } } }
        : s,
    );
  };

  const onQuantity = (lineKey: string, value: string) => {
    setScreen((s) => {
      if (!s) return s;
      const { [lineKey]: _cleared, ...lineErrors } = s.lineErrors;
      void _cleared;
      return { ...s, lines: s.lines.map((l) => (l.lineKey === lineKey ? { ...l, quantity: value } : l)), lineErrors };
    });
  };

  const onRemove = (lineKey: string) => {
    setScreen((s) =>
      s ? { ...s, lines: s.lines.filter((l) => l.lineKey !== lineKey), form: { ...s.form, errors: { ...s.form.errors, tooMany: false } } } : s,
    );
  };

  if (loadStatus !== 'ready' || !customer || !screen) {
    return (
      <PageShell locale={locale} active="customers">
        <PageStateView t={t} locale={locale} status={loadStatus === 'ready' ? 'loading' : loadStatus} onRetry={startOver} />
      </PageShell>
    );
  }

  return (
    <PageShell locale={locale} active="customers">
      <CreditSaleView
        t={t}
        locale={locale}
        customer={{ name: customer.name, status: customer.status }}
        warehouses={warehouses}
        form={screen.form}
        search={search}
        options={picker.options}
        lines={screen.lines}
        lineErrors={screen.lineErrors}
        unitNames={unitNames}
        busy={screen.busy}
        errorKey={screen.errorKey ?? picker.errorKey}
        result={screen.result}
        stored={screen.stored}
        storedUnread={screen.storedUnread}
        on={{
          onField,
          onSearch: setSearch,
          onPick,
          onQuantity,
          onRemove,
          onSubmit: submit,
          onRereadStored: () => settle(flow.current?.rereadStored()),
          onStartOver: startOver,
        }}
      />
    </PageShell>
  );
}
