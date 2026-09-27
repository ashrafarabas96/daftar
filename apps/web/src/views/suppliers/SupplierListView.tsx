/**
 * Suppliers (P3-S7 contract A-11, A-09(a)). A business-wide caller sees what
 * is still owed to each supplier and the balance in their favour, per
 * currency, from the live balances read; an assigned-scope caller sees the
 * plain list (S4 TL-4). No sorting by amount: "who do I owe" is the
 * "Only suppliers I owe" filter.
 */
import { Badge, Button, Checkbox, EmptyState, List, TextField } from '@daftar/design-system';
import type { ViewBaseProps } from '@/lib/phase3-format';
import { RefusalNotice } from '../common/feedback';
import { Amounts, Inline, Muted, Stack, Title } from '../common/primitives';
import type { SupplierRowModel } from './types';

export interface SupplierListViewProps {
  /** True for a business-wide caller: rows carry balances and the "owed only" filter is offered. */
  withBalances: boolean;
  rows: SupplierRowModel[];
  search: string;
  owedOnly: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  errorKey: string | null;
  on: {
    onSearch: (value: string) => void;
    onOwedOnly: (value: boolean) => void;
    onOpen: (supplierId: string) => void;
    onLoadMore: () => void;
  };
}

export function SupplierStatusBadge({ t, status }: { status: 'active' | 'inactive' } & Pick<ViewBaseProps, 't'>) {
  return status === 'inactive' ? <Badge tone="neutral">{t('common.inactive')}</Badge> : null;
}

export function SupplierListView(props: SupplierListViewProps & ViewBaseProps) {
  const { t, locale, on } = props;
  return (
    <Stack>
      <Title>{t('suppliers.list.title')}</Title>
      <TextField label={t('common.search')} type="search" value={props.search} placeholder={t('suppliers.list.searchHint')} onChange={on.onSearch} />
      {props.withBalances ? <Checkbox label={t('suppliers.list.owedOnly')} checked={props.owedOnly} onChange={on.onOwedOnly} /> : null}
      <RefusalNotice t={t} locale={locale} errorKey={props.errorKey} />
      {props.rows.length === 0 ? (
        <EmptyState title={props.search.length > 0 ? t('common.noResults') : t('suppliers.list.empty')} />
      ) : (
        <List
          items={props.rows.map((row) => ({
            key: row.supplierId,
            onClick: () => on.onOpen(row.supplierId),
            primary: (
              <Inline gap={2}>
                <bdi>{row.name}</bdi>
                <SupplierStatusBadge t={t} status={row.status} />
              </Inline>
            ),
            secondary: props.withBalances ? <BalanceLine {...props} row={row} /> : undefined,
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

function BalanceLine(props: ViewBaseProps & { row: SupplierRowModel }) {
  const { t, locale, row } = props;
  const owed = row.owed ?? [];
  const favour = row.inYourFavour ?? [];
  if (owed.length === 0 && favour.length === 0) return <Muted>{t('suppliers.balance.settled')}</Muted>;
  return (
    <Stack gap={1}>
      {owed.length > 0 ? (
        <Inline gap={2}>
          <span>{t('suppliers.balance.youOwe')}</span>
          <Amounts amounts={owed} locale={locale} />
        </Inline>
      ) : null}
      {favour.length > 0 ? (
        <Inline gap={2}>
          <span>{t('suppliers.balance.inYourFavour')}</span>
          <Amounts amounts={favour} locale={locale} />
        </Inline>
      ) : null}
    </Stack>
  );
}
