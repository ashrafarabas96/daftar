/**
 * Customers (MVP-02), read-only: the people the business sells to, from
 * `GET /v1/customers`, **in the order the server gives them** — the merchant's
 * own alphabet, `(name, id)`. The view never sorts: the server's order is the
 * only one that stays stable across "show more".
 *
 * A row shows the name, the phone and email as stored, and the primary contact
 * when the customer has one. It shows NO money: no balance, no credit limit, no
 * receivable. Those belong to the next, finance-reviewed screen, and a list
 * answer carries none of them in any case.
 *
 * Nothing here creates, edits or opens a customer: the rows are inert and the
 * empty state has no action, because there is nowhere yet to send the merchant.
 */
import { Badge, Button, EmptyState, List } from '@daftar/design-system';
import type { CustomerListItemDto } from '@/lib/phase4-customers-api';
import { rich, type ViewBaseProps } from '@/lib/phase3-format';
import { Notice, STACK, ScreenTitle } from '@/views/stock/parts';

export interface CustomerListViewProps {
  /** The page renders this view only once the first read has landed (`ScreenState` covers loading), so there is no null state. */
  customers: readonly CustomerListItemDto[];
  hasMore: boolean;
  loadingMore: boolean;
  errorKey: string | null;
  onLoadMore: () => void;
}

export function CustomerListView(props: CustomerListViewProps & ViewBaseProps) {
  const { t } = props;
  return (
    <div style={STACK}>
      <ScreenTitle>{t('customers.list.title')}</ScreenTitle>
      {props.errorKey !== null ? <Notice tone="error">{t(props.errorKey)}</Notice> : null}
      {props.customers.length === 0 ? (
        // A refused first read renders `ScreenState` and never reaches this view,
        // and "show more" can only be refused while rows are on screen, so an
        // empty list never arrives beside a refusal.
        <EmptyState title={t('customers.list.empty')} />
      ) : (
        <List
          items={props.customers.map((customer) => ({
            key: customer.id,
            primary: (
              <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                <bdi>{customer.name}</bdi>
                {customer.status === 'inactive' ? <Badge tone="neutral">{t('common.inactive')}</Badge> : null}
              </span>
            ),
            secondary: <Details t={t} customer={customer} />,
          }))}
        />
      )}
      {props.hasMore ? (
        <Button variant="secondary" fullWidth loading={props.loadingMore} onClick={props.onLoadMore}>
          {t('common.loadMore')}
        </Button>
      ) : null}
    </div>
  );
}

function Details(props: Pick<ViewBaseProps, 't'> & { customer: CustomerListItemDto }) {
  const { t, customer } = props;
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: '0.125rem', overflowWrap: 'anywhere' }}>
      {customer.phone !== null ? <bdi dir="ltr">{customer.phone}</bdi> : null}
      {customer.email !== null ? <bdi dir="ltr">{customer.email}</bdi> : null}
      {customer.primaryContactName !== null ? <span>{rich(t('customers.list.contact'), { name: <bdi>{customer.primaryContactName}</bdi> })}</span> : null}
    </span>
  );
}
