/**
 * Purchases (P3-S7 contract A-11): the purchase list as List rows — supplier,
 * date, warehouse and the server's total — never a sideways-scrolling table.
 */
import { Badge, Button, EmptyState, List, Tabs } from '@daftar/design-system';
import type { PurchaseStatusDto } from '@daftar/shared-contracts';
import type { ViewBaseProps } from '@/lib/phase3-format';
import { RefusalNotice } from '../common/feedback';
import { CivilDate, Inline, Money, Stack, Title } from '../common/primitives';
import type { PurchaseFilter, PurchaseRowModel } from './types';

const STATUS_TONE: Readonly<Record<PurchaseStatusDto, 'neutral' | 'success' | 'warning' | 'danger'>> = {
  draft: 'warning',
  received: 'success',
  cancelled: 'neutral',
  reversed: 'danger',
};

export function PurchaseStatusBadge({ t, status }: { status: PurchaseStatusDto } & Pick<ViewBaseProps, 't'>) {
  return <Badge tone={STATUS_TONE[status]}>{t(`purchasing.status.${status}`)}</Badge>;
}

export interface PurchaseListViewProps {
  rows: PurchaseRowModel[];
  filter: PurchaseFilter;
  canReceive: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  errorKey: string | null;
  onFilter: (filter: PurchaseFilter) => void;
  onOpen: (row: PurchaseRowModel) => void;
  onReceive: () => void;
  onLoadMore: () => void;
}

const FILTERS: readonly PurchaseFilter[] = ['all', 'draft', 'received', 'cancelled'];

export function PurchaseListView(props: PurchaseListViewProps & ViewBaseProps) {
  const { t, locale } = props;
  return (
    <Stack>
      <Title>{t('purchasing.list.title')}</Title>
      {props.canReceive ? (
        <Button fullWidth onClick={props.onReceive}>
          {t('purchasing.receive.title')}
        </Button>
      ) : null}
      <Tabs
        tabs={FILTERS.map((f) => ({ key: f, label: t(`purchasing.list.filter.${f}`) }))}
        active={props.filter}
        onChange={(key) => props.onFilter(toFilter(key))}
      />
      <RefusalNotice t={t} locale={locale} errorKey={props.errorKey} />
      {props.rows.length === 0 ? (
        <EmptyState title={t('purchasing.list.empty')} />
      ) : (
        <List
          items={props.rows.map((row) => ({
            key: row.purchaseId,
            onClick: () => props.onOpen(row),
            primary: row.supplierName,
            secondary: (
              <Inline gap={2}>
                <CivilDate iso={row.documentDate} locale={locale} />
                <span>{row.warehouseName}</span>
                {row.supplierReference ? <bdi>{row.supplierReference}</bdi> : null}
                <PurchaseStatusBadge t={t} status={row.status} />
              </Inline>
            ),
            trailing: <Money amountMinor={row.totalTxnMinor} currency={row.currency} locale={locale} />,
          }))}
        />
      )}
      {props.hasMore ? (
        <Button variant="secondary" fullWidth loading={props.loadingMore} onClick={props.onLoadMore}>
          {t('common.loadMore')}
        </Button>
      ) : null}
    </Stack>
  );
}

function toFilter(key: string): PurchaseFilter {
  return FILTERS.find((f) => f === key) ?? 'all';
}
