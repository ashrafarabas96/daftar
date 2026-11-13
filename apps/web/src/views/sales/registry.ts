/**
 * The sales views and the fixtures the SSR suites render them with, in the
 * shape of `suppliers/registry.ts`.
 *
 * Every fixture is a state the page can reach:
 *
 * - each `errorKey` is one `creditSaleRefusalKey` produces for an answer
 *   `POST /v1/sales` can give this page (a selling refusal carries
 *   `details.sellingCode`; a 403 is `error.FORBIDDEN`; no answer at all is
 *   `error.fallback`), or the flow's own key for a stored sale it could not
 *   read — asserted in `test/credit-sale-screens.test.tsx`;
 * - the form-error fixtures are `planCreditSale` of their own form and lines,
 *   folded by `afterOutcome`, exactly as the page derives them;
 * - a refused fixture keeps everything typed, because the page's fold sets the
 *   refusal and touches nothing else;
 * - every saved or stored sale is a CREDIT sale for the fixture customer, and
 *   its lines' figures sum to its total, as the server's answer does;
 * - a 403 on LOAD renders `PageStateView` and never reaches this view, so it
 *   has no fixture here.
 */
import type { InventoryWarehouseDto, SaleDto } from '@daftar/shared-contracts';
import { defineView, type ViewEntry } from '@/lib/phase3-format';
import { draftLineOf, type DraftLine, type PickOption } from '../stock/model';
import { CreditSaleView, type CreditSaleViewProps } from './CreditSaleView';
import { mintCreditSaleIds, planCreditSale, type CreditSaleFormModel } from './credit-sale';
import { afterOutcome, type CreditSaleScreenState } from './credit-sale-flow';

const noop = (): void => undefined;

/** The one customer every fixture is about; named so the od03 slice rule can admit it by name. */
const FIXTURE_CUSTOMER_ID = '7c1f0a52-3b7e-4d0a-9a53-0f2b6f1c7a01';

const WAREHOUSES: InventoryWarehouseDto[] = [
  {
    warehouseId: 'a1b2c3d4-0001-4a7b-8c9d-0000000000a1',
    name: 'Main shop',
    status: 'active',
    homeBranchId: 'b0b0b0b0-0001-4a7b-8c9d-000000000001',
    branchIds: ['b0b0b0b0-0001-4a7b-8c9d-000000000001'],
  },
  {
    warehouseId: 'a1b2c3d4-0002-4a7b-8c9d-0000000000a2',
    name: 'Back store',
    status: 'active',
    homeBranchId: 'b0b0b0b0-0001-4a7b-8c9d-000000000001',
    branchIds: ['b0b0b0b0-0001-4a7b-8c9d-000000000001'],
  },
];
const MAIN = WAREHOUSES[0]?.warehouseId ?? '';

const UNIT_NAMES: Readonly<Record<string, string>> = { piece: 'Piece', kg: 'Kilogram' };

const RICE: PickOption = {
  key: '5a5a5a5a-0001-4a7b-8c9d-000000000001:',
  productId: '5a5a5a5a-0001-4a7b-8c9d-000000000001',
  variantId: null,
  name: 'Rice 5 kg',
  variantName: null,
  unitCode: 'piece',
  unitDecimals: 0,
  onHand: null,
};
const OLIVES: PickOption = {
  key: '5a5a5a5a-0002-4a7b-8c9d-000000000002:5a5a5a5a-0003-4a7b-8c9d-000000000003',
  productId: '5a5a5a5a-0002-4a7b-8c9d-000000000002',
  variantId: '5a5a5a5a-0003-4a7b-8c9d-000000000003',
  name: 'Olives',
  variantName: 'Green',
  unitCode: 'kg',
  unitDecimals: 3,
  onHand: null,
};

const lineOf = (option: PickOption, lineKey: string, quantity: string): DraftLine => ({ ...draftLineOf(option, lineKey), quantity });
const TYPED: DraftLine[] = [lineOf(RICE, 'line-rice', '3'), lineOf(OLIVES, 'line-olives', '1.250')];

const form = (over: Partial<CreditSaleFormModel> = {}): CreditSaleFormModel => ({
  warehouseId: MAIN,
  documentDate: '2026-11-14',
  dueDate: '',
  errors: {},
  ...over,
});

const view = (over: Partial<CreditSaleViewProps> = {}): CreditSaleViewProps => ({
  customer: { name: 'Zaytoun Grocery', status: 'active' },
  warehouses: WAREHOUSES,
  form: form(),
  search: '',
  options: null,
  lines: [],
  lineErrors: {},
  unitNames: UNIT_NAMES,
  busy: false,
  errorKey: null,
  result: null,
  stored: null,
  storedUnread: false,
  on: {
    onField: noop,
    onSearch: noop,
    onPick: noop,
    onQuantity: noop,
    onRemove: noop,
    onSubmit: noop,
    onRereadStored: noop,
    onStartOver: noop,
  },
  ...over,
});

/** A screen state the flow folds an outcome into, as the page holds it. */
const screen = (f: CreditSaleFormModel, lines: DraftLine[]): CreditSaleScreenState => ({
  form: f,
  lines,
  lineErrors: {},
  busy: true,
  errorKey: null,
  result: null,
  stored: null,
  storedUnread: false,
});

/** A form the merchant sent: `planCreditSale` of it, folded as the page folds it. */
function sent(f: CreditSaleFormModel, lines: DraftLine[]): CreditSaleViewProps {
  const planned = planCreditSale({ customerId: FIXTURE_CUSTOMER_ID, form: f, lines, ids: mintCreditSaleIds(() => '00000000-0000-4000-8000-000000000001') });
  if (planned.ok) throw new Error('this fixture is a form the plan refuses');
  return view(afterOutcome(screen(f, lines), { kind: 'invalid', errors: planned.errors, lineErrors: planned.lineErrors }));
}

const TYPED_FORM = { form: form({ dueDate: '2026-12-15' }), lines: TYPED };

/**
 * A committed credit sale as `POST /v1/sales` answers it. The total is above
 * 2^53 minor units on purpose — the screen must re-spell the server's text,
 * never a float — and the two line nets sum to it exactly
 * (60000 + 123456789012285678 = 123456789012345678).
 */
const SAVED: SaleDto = {
  saleId: '6d6d6d6d-0001-4a7b-8c9d-0000000000s1',
  status: 'confirmed',
  settlementMode: 'credit',
  customerId: FIXTURE_CUSTOMER_ID,
  branchId: 'b0b0b0b0-0001-4a7b-8c9d-000000000001',
  warehouseId: MAIN,
  documentDate: '2026-11-14',
  currencyCode: 'USD',
  subtotalTxnMinor: '123456789012345678',
  discountTxnMinor: '0',
  taxMinor: '0',
  totalTxnMinor: '123456789012345678',
  totalBaseMinor: '387850300008402771',
  sourceToBaseRate: '3.14159',
  rateSource: 'manual',
  rateTimestamp: '2026-11-14T07:30:00Z',
  lines: [
    {
      lineId: '6d6d6d6d-0002-4a7b-8c9d-0000000000l1',
      lineNo: 1,
      productId: RICE.productId,
      variantId: null,
      nameSnapshot: 'Rice 5 kg',
      quantity: '3',
      unitPriceTxnMinor: '20000',
      grossTxnMinor: '60000',
      discountTxnMinor: '0',
      netTxnMinor: '60000',
      taxMinor: '0',
      baseShareMinor: '188495',
    },
    {
      lineId: '6d6d6d6d-0003-4a7b-8c9d-0000000000l2',
      lineNo: 2,
      productId: OLIVES.productId,
      variantId: OLIVES.variantId,
      nameSnapshot: 'Olives — Green',
      quantity: '1.250',
      unitPriceTxnMinor: '98765431209828542',
      grossTxnMinor: '123456789012285678',
      discountTxnMinor: '0',
      netTxnMinor: '123456789012285678',
      taxMinor: '0',
      baseShareMinor: '387850300008214276',
    },
  ],
  invoice: {
    invoiceId: '6d6d6d6d-0004-4a7b-8c9d-0000000000i1',
    number: { documentKind: 'invoice', period: '2026', numberSeq: '418', documentNumber: 'S-2026-000418' },
    issueDate: '2026-11-14',
    dueDate: '2026-12-15',
    status: 'open',
    totalTxnMinor: '123456789012345678',
    totalBaseMinor: '387850300008402771',
  },
  cogsBaseMinor: '31415926',
  replayed: false,
};

/** A small credit sale: one line, 75.00 ILS, no pay-by date. Its line equals its total. */
const SMALL: SaleDto = {
  ...SAVED,
  saleId: '6d6d6d6d-0005-4a7b-8c9d-0000000000s2',
  currencyCode: 'ILS',
  subtotalTxnMinor: '7500',
  totalTxnMinor: '7500',
  totalBaseMinor: '7500',
  sourceToBaseRate: '1',
  rateSource: 'base',
  lines: [
    {
      ...(SAVED.lines[0] as SaleDto['lines'][number]),
      quantity: '1',
      unitPriceTxnMinor: '7500',
      grossTxnMinor: '7500',
      netTxnMinor: '7500',
      baseShareMinor: '7500',
    },
  ],
  invoice: { ...SAVED.invoice, dueDate: null, totalTxnMinor: '7500', totalBaseMinor: '7500' },
};

/** The stored sale as `GET /v1/sales/:saleId` reads it back. */
const STORED: SaleDto = { ...SMALL, replayed: false };

export const VIEW_REGISTRY: readonly ViewEntry[] = [
  defineView('CreditSaleView', CreditSaleView, {
    'fresh form': view(),
    'searching items': view({ search: 'ri', options: [RICE, OLIVES] }),
    'no item matches': view({ search: 'zzz', options: [] }),
    'two items added': view({ ...TYPED_FORM, search: 'ol', options: [RICE, OLIVES] }),
    'inactive buyer': view({ customer: { name: 'Al-Amal Pharmacy', status: 'inactive' }, ...TYPED_FORM }),
    'no warehouse to sell from': view({ warehouses: [], form: form({ warehouseId: '' }) }),
    'sent with no item': sent(form(), []),
    'pay-by date before the sale date': sent(form({ dueDate: '2026-11-13' }), TYPED),
    'a quantity is not valid': sent(form(), [lineOf(RICE, 'line-rice', '2.5'), lineOf(OLIVES, 'line-olives', '1.250')]),
    sending: view({ ...TYPED_FORM, busy: true }),
    'refused: no permission to sell to be paid later, figures kept': view({ ...TYPED_FORM, errorKey: 'sales.credit.refusedNotPermitted' }),
    'refused: the buyer was made inactive': view({ ...TYPED_FORM, errorKey: 'sales.credit.refusedInactive' }),
    'refused: prices or stock changed meanwhile': view({ ...TYPED_FORM, errorKey: 'sales.credit.refusedChanged' }),
    'refused: an item has no price': view({ ...TYPED_FORM, errorKey: 'error.sale.product_not_priced' }),
    'refused: no exchange rate today': view({ ...TYPED_FORM, errorKey: 'sales.credit.refusedRate' }),
    'refused: no permission to sell': view({ ...TYPED_FORM, errorKey: 'error.FORBIDDEN' }),
    'no answer: everything kept for a retry': view({ ...TYPED_FORM, errorKey: 'error.fallback' }),
    'server failure: everything kept for a retry': view({ ...TYPED_FORM, errorKey: 'error.INTERNAL_ERROR' }),
    // The first send was saved but its answer lost; the merchant changed a quantity and sent again.
    // The flow reads the stored sale and the screen shows IT, not the edited form.
    'already recorded: the stored sale is shown': view(afterOutcome(screen(form(), [lineOf(RICE, 'line-rice', '2')]), { kind: 'alreadySaved', sale: STORED })),
    'already recorded, but it could not be read': view(afterOutcome(screen(TYPED_FORM.form, TYPED), { kind: 'storedUnread' })),
    'saved, with a pay-by date': view({ result: SAVED }),
    'saved, no pay-by date': view({ result: SMALL }),
    'saved earlier: the same sale sent again': view({ result: { ...SAVED, replayed: true } }),
  }),
];
