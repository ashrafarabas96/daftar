/**
 * The POS views and the fixtures the SSR suites render them with (P4-S3, in
 * the shape of the P3-S7 contract's §4.3 and §6: T-08, T-15, T-16).
 *
 * The fixtures carry, on purpose, what a real POS payload holds and a screen
 * must never show — the trace id of the sale and the stock movements it
 * produced — so T-08 proves neither reaches the markup. Every amount in a
 * fixture is an integer minor-unit STRING, as the server sends it.
 */
import { defineView, type ViewEntry } from '@/lib/phase3-format';
import type { PosBasketDto, PosBasketLineDto, PosSaleReceiptDto, PosSearchHitDto } from '@/lib/phase4-pos-api';
import { RegisterView, type RegisterViewProps } from './RegisterView';
import { SaleDoneView, type SaleDoneViewProps } from './SaleDoneView';
import { TillView, type PosBranchOption, type TillViewProps } from './TillView';

const noop = (): void => undefined;

/** Values a real POS answer carries and no POS screen renders (T-08). */
const HIDDEN = {
  businessTransactionId: 'b7d3a2c1-4444-4c2b-9a0d-00000000bt43',
  movementId: 'a0a0a0a0-4444-4c2b-9a0d-00000000mv43',
} as const;

const MAIN = 'd1000000-0000-4000-8000-000000000011';
const OTHER = 'd1000000-0000-4000-8000-000000000012';

const BRANCHES: PosBranchOption[] = [
  { id: MAIN, name: 'Main shop' },
  { id: OTHER, name: 'Market stall' },
];

const UNIT_NAMES: Record<string, string> = { PCE: 'piece', KGM: 'kg' };

const HITS: PosSearchHitDto[] = [
  {
    productId: 'p1000000-0000-4000-8000-000000000001',
    variantId: null,
    name: 'Rice 5 kg',
    variantName: null,
    unitCode: 'PCE',
    unitDecimals: 0,
    unitPriceMinor: '3150',
    currency: 'JOD',
    onHand: '24',
  },
  {
    productId: 'p1000000-0000-4000-8000-000000000002',
    variantId: 'v1000000-0000-4000-8000-000000000002',
    name: 'Olive oil',
    variantName: '1 litre',
    unitCode: 'PCE',
    unitDecimals: 0,
    unitPriceMinor: '710',
    currency: 'JOD',
    onHand: null,
  },
];

const LINES: PosBasketLineDto[] = [
  {
    lineId: 'l1000000-0000-4000-8000-000000000001',
    productId: 'p1000000-0000-4000-8000-000000000001',
    variantId: null,
    name: 'Rice 5 kg',
    variantName: null,
    unitCode: 'PCE',
    unitDecimals: 0,
    quantity: '2',
    unitPriceMinor: '3150',
    lineTotalMinor: '6300',
  },
  {
    lineId: 'l1000000-0000-4000-8000-000000000002',
    productId: 'p1000000-0000-4000-8000-000000000002',
    variantId: 'v1000000-0000-4000-8000-000000000002',
    name: 'Olive oil',
    variantName: '1 litre',
    unitCode: 'KGM',
    unitDecimals: 3,
    quantity: '1.500',
    unitPriceMinor: '710',
    lineTotalMinor: '1065',
  },
];

const BASKET: PosBasketDto = {
  tillSessionId: 't1000000-0000-4000-8000-000000000001',
  revision: 4,
  currency: 'JOD',
  lines: LINES,
  subtotalMinor: '7365',
  discountMinor: '0',
  totalMinor: '7365',
};

const DISCOUNTED: PosBasketDto = { ...BASKET, revision: 5, discountMinor: '365', totalMinor: '7000' };

const SALE: PosSaleReceiptDto = {
  saleId: 's1000000-0000-4000-8000-000000000001',
  receiptNumber: 'S-2026-000417',
  currency: 'JOD',
  lines: LINES,
  subtotalMinor: '7365',
  discountMinor: '365',
  totalMinor: '7000',
  businessTransactionId: HIDDEN.businessTransactionId,
  movementIds: [HIDDEN.movementId],
};

const TILL_BASE: TillViewProps = {
  branches: BRANCHES,
  branchId: '',
  session: null,
  currency: 'JOD',
  openingFloatText: '',
  closingCountText: '',
  openingFloatInvalid: false,
  closingCountInvalid: false,
  justClosed: false,
  confirmingClose: false,
  busy: false,
  errorKey: null,
  onBranch: noop,
  onOpeningFloat: noop,
  onClosingCount: noop,
  onOpen: noop,
  onAskClose: noop,
  onCancelClose: noop,
  onClose: noop,
  onBackToSelling: noop,
};

const OPEN_SESSION = {
  tillSessionId: 't1000000-0000-4000-8000-000000000001',
  branchId: MAIN,
  status: 'open' as const,
  openedAt: '2026-10-02T07:15:00.000Z',
  closedAt: null,
  openingFloatMinor: '5000',
  closingCountMinor: null,
};

const REGISTER_BASE: RegisterViewProps = {
  tillOpen: true,
  search: 'ri',
  hits: HITS,
  basket: BASKET,
  quantityDrafts: {},
  lineErrors: {},
  discountText: '',
  discountInvalid: false,
  confirmingFinish: false,
  busy: false,
  errorKey: null,
  unitNames: UNIT_NAMES,
  onSearch: noop,
  onAdd: noop,
  onQuantity: noop,
  onRemove: noop,
  onDiscountText: noop,
  onApplyDiscount: noop,
  onClearDiscount: noop,
  onAskFinish: noop,
  onCancelFinish: noop,
  onFinish: noop,
  onGoToTill: noop,
};

const SALE_DONE: SaleDoneViewProps = { sale: SALE, unitNames: UNIT_NAMES, onAnother: noop, onGoToTill: noop };

export const VIEW_REGISTRY: readonly ViewEntry[] = [
  defineView('TillView', TillView, {
    'no till is open': TILL_BASE,
    'just closed': { ...TILL_BASE, justClosed: true },
    'a place chosen and the drawer counted': { ...TILL_BASE, branchId: MAIN, openingFloatText: '50.00', busy: true },
    'the counted cash is not an amount': { ...TILL_BASE, branchId: MAIN, openingFloatText: '5,0,0', openingFloatInvalid: true },
    'the till is open': { ...TILL_BASE, session: OPEN_SESSION, branchId: MAIN },
    'counting the till before it closes': { ...TILL_BASE, session: OPEN_SESSION, branchId: MAIN, closingCountText: '143.25' },
    'closing is confirmed first': { ...TILL_BASE, session: OPEN_SESSION, branchId: MAIN, closingCountText: '143.25', confirmingClose: true },
    'the closing count is not an amount': { ...TILL_BASE, session: OPEN_SESSION, branchId: MAIN, closingCountText: '1.2.3', closingCountInvalid: true },
    'the business currency is not known yet': { ...TILL_BASE, currency: null },
    'the open till was refused': { ...TILL_BASE, errorKey: 'error.pos.session_already_open' },
  }),
  defineView('RegisterView', RegisterView, {
    'no till, so nothing is sold': { ...REGISTER_BASE, tillOpen: false, hits: null, basket: null },
    'nothing searched yet': {
      ...REGISTER_BASE,
      search: '',
      hits: null,
      basket: { ...BASKET, lines: [], subtotalMinor: '0', discountMinor: '0', totalMinor: '0' },
    },
    'nothing found': { ...REGISTER_BASE, hits: [] },
    'two lines in the basket': REGISTER_BASE,
    'a discount the server allowed': { ...REGISTER_BASE, basket: DISCOUNTED, discountText: '3.65' },
    'a quantity that is not a quantity': {
      ...REGISTER_BASE,
      quantityDrafts: { 'l1000000-0000-4000-8000-000000000001': '2,5,5' },
      lineErrors: { 'l1000000-0000-4000-8000-000000000001': 'pos.basket.quantityInvalid' },
    },
    'a discount that is not an amount': { ...REGISTER_BASE, discountText: '1.555', discountInvalid: true },
    'finishing is confirmed first': { ...REGISTER_BASE, confirmingFinish: true },
    'the basket is still loading': { ...REGISTER_BASE, basket: null, hits: null, search: '' },
    'the command was refused': { ...REGISTER_BASE, errorKey: 'error.pos.session_not_open' },
  }),
  defineView('SaleDoneView', SaleDoneView, {
    'a sale with a discount': SALE_DONE,
    'a sale with no discount': { ...SALE_DONE, sale: { ...SALE, discountMinor: '0', totalMinor: '7365' } },
  }),
];
