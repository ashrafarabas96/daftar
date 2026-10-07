/**
 * P4-S7 — THE SCHEDULE SCREEN (maturity level D).
 *
 * A pure view: props in, elements out. No fetch, no state, no clock.
 *
 * ── WHAT THE MERCHANT IS SHOWN, AND IN WHAT WORDS ───────────────────────
 *
 * The merchant reads "what is still owed, when the next payment falls due, and
 * which payments are late". They are never shown a term from the engine: the
 * merchant-language guard (`scripts/guards/merchant-jargon.ts`) has
 * `installments.` and `debts.` in scope, so the English strings carry no
 * "account", "credit", "debit", "receivable" or "ledger", the Arabic ones
 * carry no «حساب» — which is why the customer statement is «كشف المديونية» and
 * not the glossary's «كشف حساب» — and the Turkish ones carry no «borçlu» or
 * «hesap planı». Every one of those is a word a bookkeeper uses and a
 * shopkeeper does not.
 *
 * ── NO TEXT OUTSIDE `t(...)` ────────────────────────────────────────────
 *
 * Every string a merchant can read comes from `t(...)`. The only text node
 * that is not a translation is DATA, and every one of those is inside `<bdi>`
 * so an Arabic customer name beside a Latin document number cannot reorder the
 * line. That is the same rule the Phase 3 views follow and the same rule the
 * guard enforces over this directory.
 *
 * ── RTL AND LTR ─────────────────────────────────────────────────────────
 *
 * Nothing here chooses a side. Direction comes from the document's `dir`,
 * amounts and dates are formatted by `locale`, and the layout primitives use
 * the design system's LOGICAL properties — so the screen is the same component
 * in Arabic and in Turkish, and the mirroring is the browser's. A view that
 * read `locale === 'ar'` to pick `marginLeft` would be a view that has to be
 * corrected once per locale forever.
 *
 * `daysPastDue` is deliberately rendered through a translated sentence with a
 * numeric variable rather than by concatenating a number and a word: "15" and
 * "days late" joined in source order is the bug RTL exists to expose.
 */
import { Badge, Button, EmptyState, List } from '@daftar/design-system';
import type { ViewBaseProps } from '@/lib/phase3-format';
import { RefusalNotice } from '../common/feedback';
import { CivilDate, Fact, Heading, Inline, Money, Muted, Panel, Stack, Text, Title } from '../common/primitives';
import type { InstallmentPlanModel, InstallmentRowModel } from './types';

/** The tone of each derived status. A badge, so the status is visible without being read as a figure. */
const STATUS_TONE: Readonly<Record<InstallmentRowModel['status'], 'neutral' | 'warning' | 'danger' | 'success'>> = {
  settled: 'success',
  overdue: 'danger',
  due_today: 'warning',
  upcoming: 'neutral',
};

export function InstallmentStatusBadge({ t, status }: { status: InstallmentRowModel['status'] } & Pick<ViewBaseProps, 't'>) {
  return <Badge tone={STATUS_TONE[status]}>{t(`installments.status.${status}`)}</Badge>;
}

export function PlanStatusBadge({ t, status }: { status: InstallmentPlanModel['status'] } & Pick<ViewBaseProps, 't'>) {
  const tone = status === 'overdue' ? 'danger' : status === 'settled' ? 'success' : 'neutral';
  return <Badge tone={tone}>{t(`installments.plan.${status}`)}</Badge>;
}

export interface InstallmentPlanViewProps {
  plan: InstallmentPlanModel;
  /** True with `installments.manage`, which is SENSITIVE and a default of no built-in role (`OD-P4-01` OPTION A). */
  canManage: boolean;
  /** True with `payments.collect`: taking the money is the ORDINARY payment path, never a second mechanism. */
  canCollect: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  errorKey: string | null;
  on: {
    onLoadMore: () => void;
    onCollect?: () => void;
    onReschedule?: () => void;
    onCancel?: () => void;
  };
}

export function InstallmentPlanView(props: InstallmentPlanViewProps & ViewBaseProps) {
  const { t, locale, plan, on } = props;
  return (
    <Stack>
      <Title>{t('installments.plan.title')}</Title>

      {/* The as-of date the server derived every status below from, shown so the
          screen can be reproduced and checked. */}
      <Muted>
        {t('installments.plan.asOf')} <CivilDate iso={plan.asOf} locale={locale} />
      </Muted>

      <RefusalNotice t={t} locale={locale} errorKey={props.errorKey} />

      <Panel>
        <Fact label={t('installments.plan.forSale')}>
          <bdi>{plan.documentNumber}</bdi>
        </Fact>
        <Fact label={t('installments.plan.customer')}>
          <bdi>{plan.customerName}</bdi>
        </Fact>
        <Fact label={t('installments.plan.state')}>
          <Inline gap={2}>
            <PlanStatusBadge t={t} status={plan.status} />
            {plan.lifecycle === 'cancelled' ? <Badge tone="neutral">{t('installments.plan.stopped')}</Badge> : null}
          </Inline>
        </Fact>
        <Fact label={t('installments.plan.saleTotal')}>
          <Money amountMinor={plan.totalMinor} currency={plan.currency} locale={locale} />
        </Fact>
        {plan.downPaymentMinor === '0' ? null : (
          <Fact label={t('installments.plan.firstPayment')}>
            <Money amountMinor={plan.downPaymentMinor} currency={plan.currency} locale={locale} />
          </Fact>
        )}
        {/* THE ONE FIGURE. It is the server's `invoice_outstanding` answer,
            shown as itself: the screen neither re-sums the rows below nor
            subtracts anything from the total. */}
        <Fact label={t('installments.plan.stillOwed')}>
          <Money amountMinor={plan.outstandingMinor} currency={plan.currency} locale={locale} />
        </Fact>
        {plan.overdueMinor === '0' ? null : (
          <Fact label={t('installments.plan.lateAmount')}>
            <Money amountMinor={plan.overdueMinor} currency={plan.currency} locale={locale} />
          </Fact>
        )}
        {plan.nextDueDate === null ? (
          <Fact label={t('installments.plan.nextDue')}>
            <Text>{t('installments.plan.nothingLeft')}</Text>
          </Fact>
        ) : (
          <Fact label={t('installments.plan.nextDue')}>
            <CivilDate iso={plan.nextDueDate} locale={locale} />
          </Fact>
        )}
      </Panel>

      {/* An EMPTY schedule is an empty collection, never a refusal — the
          recorded lesson, in the one place a merchant would meet it. */}
      {plan.installments.length === 0 ? (
        <EmptyState title={t('installments.plan.noRows')} />
      ) : (
        <>
          <Heading>{t('installments.plan.rowsTitle')}</Heading>
          {/* A LIST and not a `<table>`: the estate's phone-width rule
              (`layout-rules.ts:79`) refuses table markup on a merchant screen,
              because a table scrolls sideways on a phone and a schedule is the
              screen a merchant reads standing at a counter. */}
          <List
            items={plan.installments.map((row) => ({
              key: String(row.seqNo),
              primary: (
                <Inline gap={2}>
                  {/* Every number is inside <bdi>, including the ones inside a
                      translated sentence: a digit outside <bdi> reorders
                      against Arabic text around it. */}
                  <bdi>{t('installments.row.number')}</bdi>
                  <bdi>{String(row.seqNo)}</bdi>
                  <InstallmentStatusBadge t={t} status={row.status} />
                </Inline>
              ),
              secondary: (
                <Inline gap={2}>
                  <Muted>{t('installments.row.dueOn')}</Muted>
                  <CivilDate iso={row.dueDate} locale={locale} />
                  <Muted>{t('installments.row.amount')}</Muted>
                  <Money amountMinor={row.amountMinor} currency={plan.currency} locale={locale} />
                  <Muted>{t('installments.row.stillOwed')}</Muted>
                  <Money amountMinor={row.remainingMinor} currency={plan.currency} locale={locale} />
                  {row.status === 'overdue' ? (
                    <Muted>
                      <bdi>{t('installments.row.lateByDays', { days: row.daysPastDue })}</bdi>
                    </Muted>
                  ) : null}
                </Inline>
              ),
            }))}
          />
        </>
      )}

      {/* The keyset continuation. "Load more" and never a page number: a page
          number is an OFFSET wearing a label, and a row appended mid-walk
          would shift every later page. */}
      {props.hasMore ? (
        <Button variant="secondary" fullWidth loading={props.loadingMore} onClick={on.onLoadMore}>
          {t('common.loadMore')}
        </Button>
      ) : null}

      <Stack gap={2}>
        {/* Taking the money is the ORDINARY payment screen. There is no
            "pay this instalment" button, because there is no such command:
            a payment settles the SALE, and the schedule shows where it landed. */}
        {props.canCollect && on.onCollect ? <Button onClick={on.onCollect}>{t('installments.plan.takePayment')}</Button> : null}
        {props.canCollect ? <Muted>{t('installments.plan.takePaymentHint')}</Muted> : null}
        {props.canManage && on.onReschedule ? (
          <Button variant="secondary" onClick={on.onReschedule}>
            {t('installments.plan.changeDates')}
          </Button>
        ) : null}
        {props.canManage && on.onCancel ? (
          <Button variant="secondary" onClick={on.onCancel}>
            {t('installments.plan.stop')}
          </Button>
        ) : null}
        {props.canManage && on.onCancel ? <Muted>{t('installments.plan.stopHint')}</Muted> : null}
        {!props.canManage ? <Muted>{t('installments.plan.askOwner')}</Muted> : null}
      </Stack>
    </Stack>
  );
}

export interface PlanPickerProps {
  plans: readonly { planId: string; documentNumber: string; nextDueDate: string | null; status: InstallmentPlanModel['status'] }[];
  asOf: string;
  on: { onOpen: (planId: string) => void };
}

/** The list of a customer's schedules. An empty list is an empty state and never a refusal. */
export function InstallmentPlanListView(props: PlanPickerProps & ViewBaseProps) {
  const { t, locale, on } = props;
  if (props.plans.length === 0) return <EmptyState title={t('installments.list.empty')} />;
  return (
    <Stack>
      <Title>{t('installments.list.title')}</Title>
      <Muted>
        {t('installments.plan.asOf')} <CivilDate iso={props.asOf} locale={locale} />
      </Muted>
      <List
        items={props.plans.map((plan) => ({
          key: plan.planId,
          onClick: () => on.onOpen(plan.planId),
          primary: <bdi>{plan.documentNumber}</bdi>,
          secondary: (
            <Inline gap={2}>
              <PlanStatusBadge t={t} status={plan.status} />
              {plan.nextDueDate === null ? (
                <Muted>{t('installments.plan.nothingLeft')}</Muted>
              ) : (
                <Muted>
                  {t('installments.plan.nextDue')} <CivilDate iso={plan.nextDueDate} locale={locale} />
                </Muted>
              )}
            </Inline>
          ),
        }))}
      />
    </Stack>
  );
}
