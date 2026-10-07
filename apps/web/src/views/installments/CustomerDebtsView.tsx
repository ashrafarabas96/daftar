/**
 * P4-S7 — THE DEBTS SCREEN (maturity level D).
 *
 * "What this customer still owes me, and what is late", at a SUPPLIED as-of
 * date, as a KEYSET page.
 *
 * ── THIS IS A READ PATH, AND IT IS SHAPED AS ONE ────────────────────────
 *
 * «A command's answer is not a read path. State whose only reader is its own
 * command's return value has NO read path: a client that reloads loses it.»
 *
 * So this screen is driven by a GET, not by what a POST returned, and that
 * shows in three places:
 *
 *  - `asOf` is shown, so a reload with the same date shows the same screen;
 *  - the continuation is a CURSOR the server issued, not a page index, so a
 *    reload resumes where it was rather than re-counting rows;
 *  - an empty page is an EMPTY STATE. A customer who owes nothing is a happy
 *    customer, not a refusal, and the screen says so in the merchant's words.
 *
 * ── THE AGING OF RECORD IS NOT RE-DERIVED HERE ──────────────────────────
 *
 * The aging buckets this screen can show come from
 * `customer_ar_aging(business, customer, as_of, bucket_days)` — the read of
 * record (`0084:699`), reused unchanged. The boundaries are SUPPLIED, because
 * the lock decides no bucket policy and the screen may not invent a commercial
 * one, and the screen does not add a bucket, re-group a bucket or sum one
 * bucket into another.
 */
import { Badge, Button, EmptyState, List } from '@daftar/design-system';
import type { ViewBaseProps } from '@/lib/phase3-format';
import { RefusalNotice } from '../common/feedback';
import { CivilDate, Inline, Money, Muted, Stack, Text, Title } from '../common/primitives';
import type { DebtRowModel } from './types';

export interface CustomerDebtsViewProps {
  customerName: string;
  /** The as-of date the server derived every status and day figure from. Shown, always. */
  asOf: string;
  rows: readonly DebtRowModel[];
  /** The keyset cursor for the next page, or null on the last one. Never a page number. */
  hasMore: boolean;
  loadingMore: boolean;
  errorKey: string | null;
  on: {
    onLoadMore: () => void;
    onOpenPlan: (planId: string) => void;
    onOpenSale: (invoiceId: string) => void;
  };
}

export function CustomerDebtsView(props: CustomerDebtsViewProps & ViewBaseProps) {
  const { t, locale, on } = props;
  return (
    <Stack>
      <Title>{t('debts.list.title')}</Title>
      <Muted>
        <bdi>{props.customerName}</bdi>
      </Muted>
      <Muted>
        {t('debts.list.asOf')} <CivilDate iso={props.asOf} locale={locale} />
      </Muted>

      <RefusalNotice t={t} locale={locale} errorKey={props.errorKey} />

      {props.rows.length === 0 ? (
        <EmptyState title={t('debts.list.nothingOwed')} />
      ) : (
        <List
          items={props.rows.map((row) => ({
            key: row.invoiceId,
            onClick: () => (row.planId === null ? on.onOpenSale(row.invoiceId) : on.onOpenPlan(row.planId)),
            primary: (
              <Inline gap={2}>
                <bdi>{row.documentNumber}</bdi>
                {row.planId === null ? null : <Badge tone="neutral">{t('debts.list.hasSchedule')}</Badge>}
                {row.planStatus === 'overdue' ? <Badge tone="danger">{t('debts.list.late')}</Badge> : null}
              </Inline>
            ),
            secondary: <DebtLine {...props} row={row} />,
          }))}
        />
      )}

      {props.hasMore ? (
        <Button variant="secondary" fullWidth loading={props.loadingMore} onClick={on.onLoadMore}>
          {t('common.loadMore')}
        </Button>
      ) : null}
    </Stack>
  );
}

function DebtLine(props: ViewBaseProps & { row: DebtRowModel }) {
  const { t, locale, row } = props;
  return (
    <Inline gap={2}>
      <Text>
        {t('debts.list.stillOwed')} <Money amountMinor={row.outstandingMinor} currency={row.currency} locale={locale} />
      </Text>
      {row.nextDueDate === null ? null : (
        <Muted>
          {t('debts.list.nextDue')} <CivilDate iso={row.nextDueDate} locale={locale} />
        </Muted>
      )}
      {/* The sentence carries the number as a VARIABLE, so the number and the
          words it belongs to are mirrored together in Arabic. A number
          concatenated to a word in source order is the defect RTL exposes. */}
      {row.daysPastDue !== null && row.daysPastDue > 0 ? (
        <Muted>
          <bdi>{t('debts.list.lateByDays', { days: row.daysPastDue })}</bdi>
        </Muted>
      ) : null}
    </Inline>
  );
}

export interface DebtAgingViewProps {
  asOf: string;
  currency: string;
  /** The boundaries the caller SUPPLIED. The screen invents none. */
  bucketDays: readonly number[];
  buckets: readonly { fromDays: number; toDays: number | null; amountMinor: string; count: number }[];
  totalMinor: string;
}

/**
 * The aging, as the merchant reads it: "how long has this been owed".
 *
 * Every bucket's label is a translated sentence with its day boundaries as
 * variables, so the figures and their words mirror together, and the last
 * bucket has its own key because "61 days and more" is not "31 to 60 days"
 * with a missing number.
 */
export function DebtAgingView(props: DebtAgingViewProps & ViewBaseProps) {
  const { t, locale } = props;
  return (
    <Stack>
      <Title>{t('debts.aging.title')}</Title>
      <Muted>
        {t('debts.list.asOf')} <CivilDate iso={props.asOf} locale={locale} />
      </Muted>
      {props.buckets.every((b) => b.amountMinor === '0') ? (
        <EmptyState title={t('debts.list.nothingOwed')} />
      ) : (
        <List
          items={props.buckets.map((bucket) => ({
            key: `${String(bucket.fromDays)}-${String(bucket.toDays ?? 0)}`,
            primary: (
              // The whole label is one translated sentence with its day
              // boundaries as variables, wrapped in <bdi> so the figures and
              // the words mirror together. The open-ended bucket has its own
              // key: "61 days and more" is not "31 to 60 days" with a missing
              // number.
              <bdi>
                {bucket.toDays === null
                  ? t('debts.aging.fromOnly', { from: bucket.fromDays })
                  : t('debts.aging.fromTo', { from: bucket.fromDays, to: bucket.toDays })}
              </bdi>
            ),
            secondary: (
              <Inline gap={2}>
                <Muted>{t('debts.aging.amount')}</Muted>
                <Money amountMinor={bucket.amountMinor} currency={props.currency} locale={locale} />
                <Muted>{t('debts.aging.sales')}</Muted>
                <bdi>{String(bucket.count)}</bdi>
              </Inline>
            ),
          }))}
        />
      )}
      <Text strong>
        {t('debts.aging.total')} <Money amountMinor={props.totalMinor} currency={props.currency} locale={locale} />
      </Text>
    </Stack>
  );
}
