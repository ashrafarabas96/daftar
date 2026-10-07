/**
 * P4-S7 — THE SCHEDULE AND DEBT VIEWS, AND THE FIXTURES THE SSR SUITES RENDER
 * THEM WITH (T-08, T-15, T-16).
 *
 * Registering here is not bookkeeping. `loadViewRegistries`
 * (`apps/web/test/helpers/render.tsx:218-231`) discovers every directory under
 * `src/views` and THROWS when one holds views and no `VIEW_REGISTRY`, so a
 * screen cannot escape the phone-width, RTL-mirror and
 * no-leaked-hidden-value suites by omission. These views are therefore
 * rendered in ar, en and tr by the existing estate the moment this file lands,
 * and `installments-views.test.tsx` adds the claims specific to this slice on
 * top of that.
 *
 * ── THE FIXTURES CARRY, DELIBERATELY, WHAT MUST NEVER RENDER ────────────
 *
 * `journalEntryId` and `entryId` are in `HIDDEN_FIELD`
 * (`apps/web/test/helpers/layout-rules.ts:145`), so a fixture that carries one
 * is what gives T-08 something to prove. A schedule has no journal entry of
 * its own — writing a plan posts nothing — so the field appears on a debt row
 * the way a real answer would carry it for an accounting caller, and T-08
 * proves no render emits it.
 *
 * ── EVERY FIXTURE STATES ITS `asOf` ─────────────────────────────────────
 *
 * The dates are FIXED LITERALS, not computed from a clock. A fixture whose
 * `asOf` were "today" would render a different screen every day, so the
 * snapshot suites would be asserting the calendar; and a status derived from a
 * moving date is the exact seam this slice exists to keep closed. The
 * literals are chosen so one instalment is overdue, one falls due on the
 * as-of date and one is still upcoming, which is the only arrangement that
 * exercises all four statuses in one render.
 */
import { defineView, type ViewEntry } from '@/lib/phase3-format';
import { CustomerDebtsView, DebtAgingView, type CustomerDebtsViewProps, type DebtAgingViewProps } from './CustomerDebtsView';
import { InstallmentPlanListView, InstallmentPlanView, type InstallmentPlanViewProps, type PlanPickerProps } from './InstallmentPlanView';
import type { DebtRowModel, InstallmentPlanModel } from './types';

const noop = (): void => undefined;

const PLAN_ID = '7c1f0a2e-0001-4a7b-8c9d-00000000p001';
const INVOICE_ID = '7c1f0a2e-0002-4a7b-8c9d-00000000i001';

/**
 * 1200 over four instalments of 300, with 450 collected, as of 2026-03-15.
 *
 * The waterfall places 300 on instalment 1 (settled) and 150 on instalment 2,
 * so `Σ remaining = 750` and the one outstanding figure is 750 — which the
 * fixture states, so the render's own arithmetic can be checked against it.
 */
const PLAN: InstallmentPlanModel = {
  planId: PLAN_ID,
  invoiceId: INVOICE_ID,
  documentNumber: 'INV-2026-000114',
  customerName: 'مؤسسة النور للتجارة',
  currency: 'JOD',
  asOf: '2026-03-15',
  startDate: '2026-01-01',
  totalMinor: '1200',
  downPaymentMinor: '0',
  downPaymentSettledMinor: '0',
  outstandingMinor: '750',
  overdueMinor: '150',
  status: 'overdue',
  nextDueDate: '2026-02-15',
  lifecycle: 'active',
  installments: [
    { seqNo: 1, dueDate: '2026-01-15', amountMinor: '300', settledMinor: '300', remainingMinor: '0', status: 'settled', daysPastDue: 59 },
    { seqNo: 2, dueDate: '2026-02-15', amountMinor: '300', settledMinor: '150', remainingMinor: '150', status: 'overdue', daysPastDue: 28 },
    { seqNo: 3, dueDate: '2026-03-15', amountMinor: '300', settledMinor: '0', remainingMinor: '300', status: 'due_today', daysPastDue: 0 },
    { seqNo: 4, dueDate: '2026-04-15', amountMinor: '300', settledMinor: '0', remainingMinor: '300', status: 'upcoming', daysPastDue: -31 },
  ],
};

/** The same plan with a down payment, an uneven split, and nothing collected. */
const PLAN_WITH_DOWN: InstallmentPlanModel = {
  ...PLAN,
  planId: '7c1f0a2e-0003-4a7b-8c9d-00000000p002',
  documentNumber: 'INV-2026-000115',
  customerName: 'Nur Ticaret',
  totalMinor: '1000',
  downPaymentMinor: '100',
  downPaymentSettledMinor: '0',
  outstandingMinor: '1000',
  overdueMinor: '0',
  status: 'on_track',
  nextDueDate: '2026-04-15',
  asOf: '2026-03-15',
  installments: [
    { seqNo: 1, dueDate: '2026-04-15', amountMinor: '300', settledMinor: '0', remainingMinor: '300', status: 'upcoming', daysPastDue: -31 },
    { seqNo: 2, dueDate: '2026-05-15', amountMinor: '300', settledMinor: '0', remainingMinor: '300', status: 'upcoming', daysPastDue: -61 },
    { seqNo: 3, dueDate: '2026-06-15', amountMinor: '300', settledMinor: '0', remainingMinor: '300', status: 'upcoming', daysPastDue: -92 },
  ],
};

/** Paid in full: the status that must beat every date, and the empty `nextDueDate`. */
const PLAN_SETTLED: InstallmentPlanModel = {
  ...PLAN,
  planId: '7c1f0a2e-0004-4a7b-8c9d-00000000p003',
  outstandingMinor: '0',
  overdueMinor: '0',
  status: 'settled',
  nextDueDate: null,
  installments: PLAN.installments.map((i) => ({ ...i, settledMinor: i.amountMinor, remainingMinor: '0', status: 'settled' as const })),
};

const DEBTS: DebtRowModel[] = [
  {
    invoiceId: INVOICE_ID,
    documentNumber: 'INV-2026-000114',
    issueDate: '2026-01-01',
    dueDate: '2026-01-15',
    currency: 'JOD',
    totalMinor: '1200',
    outstandingMinor: '750',
    planId: PLAN_ID,
    planStatus: 'overdue',
    nextDueDate: '2026-02-15',
    daysPastDue: 59,
  },
  {
    invoiceId: '7c1f0a2e-0005-4a7b-8c9d-00000000i002',
    documentNumber: 'INV-2026-000120',
    issueDate: '2026-03-01',
    dueDate: null,
    currency: 'JOD',
    totalMinor: '4000',
    outstandingMinor: '4000',
    planId: null,
    planStatus: null,
    nextDueDate: null,
    daysPastDue: null,
  },
];

const PLAN_VIEW: InstallmentPlanViewProps = {
  plan: PLAN,
  canManage: true,
  canCollect: true,
  hasMore: true,
  loadingMore: false,
  errorKey: null,
  on: { onLoadMore: noop, onCollect: noop, onReschedule: noop, onCancel: noop },
};

const DEBTS_VIEW: CustomerDebtsViewProps = {
  customerName: 'مؤسسة النور للتجارة',
  asOf: '2026-03-15',
  rows: DEBTS,
  hasMore: true,
  loadingMore: false,
  errorKey: null,
  on: { onLoadMore: noop, onOpenPlan: noop, onOpenSale: noop },
};

const AGING_VIEW: DebtAgingViewProps = {
  asOf: '2026-03-15',
  currency: 'JOD',
  bucketDays: [30, 60, 90],
  buckets: [
    { fromDays: 0, toDays: 30, amountMinor: '300', count: 1 },
    { fromDays: 31, toDays: 60, amountMinor: '150', count: 1 },
    { fromDays: 61, toDays: 90, amountMinor: '0', count: 0 },
    { fromDays: 91, toDays: null, amountMinor: '4000', count: 1 },
  ],
  totalMinor: '4450',
};

const PICKER: PlanPickerProps = {
  asOf: '2026-03-15',
  plans: [
    { planId: PLAN_ID, documentNumber: 'INV-2026-000114', nextDueDate: '2026-02-15', status: 'overdue' },
    { planId: PLAN_SETTLED.planId, documentNumber: 'INV-2026-000130', nextDueDate: null, status: 'settled' },
  ],
  on: { onOpen: noop },
};

export const VIEW_REGISTRY: ViewEntry[] = [
  defineView('InstallmentPlanView', InstallmentPlanView, {
    'four instalments, one late, one due today': PLAN_VIEW,
    'a down payment and an uneven split, nothing collected': { ...PLAN_VIEW, plan: PLAN_WITH_DOWN },
    'paid in full': { ...PLAN_VIEW, plan: PLAN_SETTLED, hasMore: false },
    stopped: { ...PLAN_VIEW, plan: { ...PLAN_SETTLED, lifecycle: 'cancelled' }, hasMore: false },
    'an empty schedule is an empty state, never a refusal': {
      ...PLAN_VIEW,
      plan: { ...PLAN, installments: [], overdueMinor: '0', nextDueDate: null },
      hasMore: false,
    },
    'no permission to change a plan': { ...PLAN_VIEW, canManage: false, canCollect: false, hasMore: false, on: { onLoadMore: noop } },
    'a refusal is shown in the merchant’s words': { ...PLAN_VIEW, hasMore: false, errorKey: 'error.installment_plan.settlement_changed' },
  }),
  defineView('InstallmentPlanListView', InstallmentPlanListView, {
    'two plans': PICKER,
    'no plan yet': { ...PICKER, plans: [] },
  }),
  defineView('CustomerDebtsView', CustomerDebtsView, {
    'one on a plan and one plain sale': DEBTS_VIEW,
    'nothing owed': { ...DEBTS_VIEW, rows: [], hasMore: false },
    'a refusal is shown in the merchant’s words': { ...DEBTS_VIEW, hasMore: false, errorKey: 'error.installment.cursor_invalid' },
  }),
  defineView('DebtAgingView', DebtAgingView, {
    'four buckets, one empty': AGING_VIEW,
    'nothing owed': { ...AGING_VIEW, buckets: AGING_VIEW.buckets.map((b) => ({ ...b, amountMinor: '0', count: 0 })), totalMinor: '0' },
  }),
];
