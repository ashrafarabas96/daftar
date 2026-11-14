/**
 * The customer views and the fixtures the SSR suites render them with (MVP-02),
 * in the shape of `suppliers/registry.ts`.
 *
 * Every fixture is a state the page can actually reach: a page of rows with a
 * cursor, a last page without one, an empty list, and "show more" refused while
 * the rows stay (the page's catch sets the refusal and never touches the cursor,
 * so the button stays too). A refused FIRST read renders `ScreenState` and never
 * reaches this view, so there is no fixture for it.
 *
 * The rows are deliberately NOT in alphabetical order: the view must show them
 * as the server sent them, and a sorted fixture could not tell a view that sorts
 * from one that does not.
 */
import { defineView, type ViewEntry } from '@/lib/phase3-format';
import type { CustomerListItemDto } from '@/lib/phase4-customers-api';
import { CustomerListView, type CustomerListViewProps } from './CustomerListView';

const noop = (): void => undefined;

const customer = (over: Partial<CustomerListItemDto> & Pick<CustomerListItemDto, 'id' | 'name'>): CustomerListItemDto => ({
  phone: null,
  email: null,
  status: 'active',
  revision: 1,
  primaryContactName: null,
  createdAt: '2026-11-10T09:30:00Z',
  updatedAt: '2026-11-10T09:30:00Z',
  ...over,
});

const WITH_CONTACT = customer({
  id: '5c1f0a52-3b7e-4d0a-9a53-0f2b6f1c7a01',
  name: 'Zaytoun Grocery',
  phone: '0599-123456',
  email: 'orders@zaytoun.example',
  primaryContactName: 'Samira Haddad',
});
const INACTIVE = customer({ id: '5c1f0a52-0000-4000-8000-000000000002', name: 'Al-Amal Pharmacy', phone: '0568-777000', status: 'inactive' });
const ARABIC_NAME = customer({ id: '5c1f0a52-0000-4000-8000-000000000003', name: 'مخبز النور', phone: '0597-555010' });
const NO_DETAILS = customer({ id: '5c1f0a52-0000-4000-8000-000000000004', name: 'Bayt Hanan' });

const list = (over: Partial<CustomerListViewProps>): CustomerListViewProps => ({
  customers: [WITH_CONTACT, INACTIVE, ARABIC_NAME, NO_DETAILS],
  hasMore: true,
  loadingMore: false,
  errorKey: null,
  onLoadMore: noop,
  ...over,
});

export const VIEW_REGISTRY: readonly ViewEntry[] = [
  defineView('CustomerListView', CustomerListView, {
    'four customers: with phone and contact, inactive, and one with no contact details': list({}),
    'one customer, no further page': list({ customers: [WITH_CONTACT], hasMore: false }),
    'no customers at all': list({ customers: [], hasMore: false }),
    'show more was refused, with the rows still on screen': list({ hasMore: true, errorKey: 'error.FORBIDDEN' }),
  }),
];
