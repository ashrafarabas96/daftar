/**
 * The POS views and the fixtures the SSR suites render them with (P4-S3, in
 * the shape of the P3-S7 contract's §4.3 and §6: T-08, T-15, T-16).
 *
 * Every fixture is the SERVER's real wire shape: `PosTillSessionDto` is the
 * stored till row (snake_case, `id`, `opened_at`), `PosCartDto` is `CartDto`
 * (`cartLineId`, `grossMinor`, `netMinor`, `taxMinor`, and NO `revision`), and
 * the receipt is a `SaleDto` from `POST /v1/sales`. Every amount is an integer
 * minor-unit STRING, as the server sends it.
 *
 * The `SaleDto` fixture carries, on purpose, everything a real commit answers
 * and a receipt must never show — the COGS the sale posted, the FX snapshot,
 * the base-currency total, the branch, the warehouse and the invoice's id — so
 * `apps/web/test/pos-receipt-invisible.test.tsx` proves none of them reaches
 * the markup. The old fixture planted `businessTransactionId` and
 * `movementIds`; `SaleDto` has neither field, and the T-08 coverage of those
 * two kinds is carried by the purchases registry.
 */
import { defineView, type ViewEntry } from '@/lib/phase3-format';
import type { PosCartDto, PosCartLineDto, PosProductHitDto, SaleDto } from '@/lib/phase4-pos-api';
import { RegisterView, type RegisterViewProps } from './RegisterView';
import { SaleDoneView, type SaleDoneViewProps } from './SaleDoneView';
import { TillView, type PosSellingPlace, type TillViewProps } from './TillView';

const noop = (): void => undefined;

const MAIN_BRANCH = 'd1000000-0000-4000-8000-000000000011';
const MAIN_STORE = 'd1000000-0000-4000-8000-00000000w011';
const STALL_STORE = 'd1000000-0000-4000-8000-00000000w012';

const PLACES: PosSellingPlace[] = [
  { id: MAIN_STORE, branchId: MAIN_BRANCH, name: 'Main shop' },
  { id: STALL_STORE, branchId: MAIN_BRANCH, name: 'Market stall' },
];

const UNIT_NAMES: Record<string, string> = { PCE: 'piece', KGM: 'kg' };

const HITS: PosProductHitDto[] = [
  {
    productId: 'p1000000-0000-4000-8000-000000000001',
    variantId: null,
    name: 'Rice 5 kg',
    variantName: null,
    sku: 'RICE-5',
    barcode: '0000000000017',
    unitCode: 'PCE',
    unitDecimals: 0,
    unitPriceMinor: '3150',
    currency: 'JOD',
    onHand: '24',
    trackInventory: true,
    matchedOn: 'name',
  },
  {
    productId: 'p1000000-0000-4000-8000-000000000002',
    variantId: 'v1000000-0000-4000-8000-000000000002',
    name: 'Olive oil',
    variantName: '1 litre',
    sku: null,
    // A scanned barcode ranks first, and an untracked item shows no on-hand
    // figure at all: `0` would read as "out of stock" and stop a fine sale.
    barcode: '0000000000024',
    unitCode: 'PCE',
    unitDecimals: null,
    unitPriceMinor: '710',
    currency: 'JOD',
    onHand: null,
    trackInventory: false,
    matchedOn: 'barcode',
  },
];

const LINE_ONE = 'l1000000-0000-4000-8000-000000000001';
const LINE_TWO = 'l1000000-0000-4000-8000-000000000002';

/** Two lines as `CartDto` carries them: no unit, no variant name, no revision. */
const LINES: PosCartLineDto[] = [
  {
    cartLineId: LINE_ONE,
    productId: 'p1000000-0000-4000-8000-000000000001',
    variantId: null,
    name: 'Rice 5 kg',
    quantity: '2',
    unitPriceMinor: '3150',
    grossMinor: '6300',
    discountMinor: '0',
    netMinor: '6300',
  },
  {
    cartLineId: LINE_TWO,
    productId: 'p1000000-0000-4000-8000-000000000002',
    variantId: 'v1000000-0000-4000-8000-000000000002',
    name: 'Olive oil',
    quantity: '1.5',
    unitPriceMinor: '710',
    grossMinor: '1065',
    discountMinor: '0',
    netMinor: '1065',
  },
];

const CART: PosCartDto = {
  tillSessionId: 't1000000-0000-4000-8000-000000000001',
  currency: 'JOD',
  lines: LINES,
  subtotalMinor: '7365',
  discountMinor: '0',
  taxMinor: '0',
  totalMinor: '7365',
};

/**
 * A discount the server granted ON A LINE (`POS_DISCOUNT_GRAIN`): the first
 * line's `discountMinor` and `netMinor` move, and the cart's `discountMinor`
 * is the server's exact sum of the line requests.
 */
const DISCOUNTED: PosCartDto = {
  ...CART,
  lines: LINES.map((line) => (line.cartLineId === LINE_ONE ? { ...line, discountMinor: '365', netMinor: '5935' } : line)),
  discountMinor: '365',
  totalMinor: '7000',
};

/**
 * What `POST /v1/sales` answers. Every operator figure a real commit carries is
 * here so the invisibility suite has something to catch.
 */
const SALE: SaleDto = {
  saleId: 's1000000-0000-4000-8000-00000000sl01',
  status: 'confirmed',
  settlementMode: 'cash',
  customerId: null,
  branchId: MAIN_BRANCH,
  warehouseId: MAIN_STORE,
  documentDate: '2026-10-02',
  currencyCode: 'JOD',
  subtotalTxnMinor: '7365',
  discountTxnMinor: '365',
  taxMinor: '0',
  totalTxnMinor: '7000',
  totalBaseMinor: '4900333',
  sourceToBaseRate: '7.0004762',
  rateSource: 'manual',
  rateTimestamp: '2026-10-02T00:00:00Z',
  lines: [
    {
      lineId: LINE_ONE,
      lineNo: 1,
      productId: 'p1000000-0000-4000-8000-000000000001',
      variantId: null,
      nameSnapshot: 'Rice 5 kg',
      quantity: '2',
      unitPriceTxnMinor: '3150',
      grossTxnMinor: '6300',
      discountTxnMinor: '365',
      netTxnMinor: '5935',
      taxMinor: '0',
      baseShareMinor: '4154500',
    },
    {
      lineId: LINE_TWO,
      lineNo: 2,
      productId: 'p1000000-0000-4000-8000-000000000002',
      variantId: 'v1000000-0000-4000-8000-000000000002',
      nameSnapshot: 'Olive oil',
      quantity: '1.5',
      unitPriceTxnMinor: '710',
      grossTxnMinor: '1065',
      discountTxnMinor: '0',
      netTxnMinor: '1065',
      taxMinor: '0',
      baseShareMinor: '745833',
    },
  ],
  invoice: {
    invoiceId: 'i1000000-0000-4000-8000-00000000in01',
    number: { documentKind: 'invoice', period: '2026', numberSeq: '417', documentNumber: 'S-2026-000417' },
    issueDate: '2026-10-02',
    dueDate: null,
    status: 'open',
    totalTxnMinor: '7000',
    totalBaseMinor: '4900333',
  },
  cogsBaseMinor: '3310000',
  replayed: false,
};

const TILL_BASE: TillViewProps = {
  places: PLACES,
  placeId: '',
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
  onPlace: noop,
  onOpeningFloat: noop,
  onClosingCount: noop,
  onOpen: noop,
  onAskClose: noop,
  onCancelClose: noop,
  onClose: noop,
  onBackToSelling: noop,
};

/** The stored till row, as `GET /v1/pos/till-sessions/current` answers it. */
const OPEN_SESSION = {
  id: 't1000000-0000-4000-8000-000000000001',
  branch_id: MAIN_BRANCH,
  warehouse_id: MAIN_STORE,
  terminal_code: 'web',
  currency_code: 'JOD',
  opened_by: 'u1000000-0000-4000-8000-00000000us01',
  status: 'open',
  opened_at: '2026-10-02T07:15:00.000Z',
  closed_at: null,
  opening_float_minor: '5000',
  closing_count_minor: null,
};

const REGISTER_BASE: RegisterViewProps = {
  tillOpen: true,
  search: 'ri',
  hits: HITS,
  moreMatches: false,
  cart: CART,
  quantityDrafts: {},
  discountDrafts: {},
  quantityErrors: {},
  discountErrors: {},
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

const SALE_DONE: SaleDoneViewProps = { sale: SALE, onAnother: noop, onGoToTill: noop };

export const VIEW_REGISTRY: readonly ViewEntry[] = [
  defineView('TillView', TillView, {
    'no till is open': TILL_BASE,
    'just closed': { ...TILL_BASE, justClosed: true },
    'a place chosen and the drawer counted': { ...TILL_BASE, placeId: MAIN_STORE, openingFloatText: '50.00', busy: true },
    'the counted cash is not an amount': { ...TILL_BASE, placeId: MAIN_STORE, openingFloatText: '5,0,0', openingFloatInvalid: true },
    'the till is open': { ...TILL_BASE, session: OPEN_SESSION, placeId: MAIN_STORE },
    'counting the till before it closes': { ...TILL_BASE, session: OPEN_SESSION, placeId: MAIN_STORE, closingCountText: '143.25' },
    'closing is confirmed first': { ...TILL_BASE, session: OPEN_SESSION, placeId: MAIN_STORE, closingCountText: '143.25', confirmingClose: true },
    'the closing count is not an amount': { ...TILL_BASE, session: OPEN_SESSION, placeId: MAIN_STORE, closingCountText: '1.2.3', closingCountInvalid: true },
    'the business currency is not known yet': { ...TILL_BASE, currency: null },
    'the open till was refused': { ...TILL_BASE, errorKey: 'error.pos.session_already_open' },
    // The till this cashier is on is a drawer a colleague already holds: the
    // refusal has its own sentence, and "refresh and try again" would be wrong.
    'the terminal is already open': { ...TILL_BASE, placeId: MAIN_STORE, errorKey: 'error.pos.terminal_already_open' },
  }),
  defineView('RegisterView', RegisterView, {
    'no till, so nothing is sold': { ...REGISTER_BASE, tillOpen: false, hits: null, cart: null },
    'nothing searched yet': {
      ...REGISTER_BASE,
      search: '',
      hits: null,
      cart: { ...CART, lines: [], subtotalMinor: '0', discountMinor: '0', totalMinor: '0' },
    },
    'nothing found': { ...REGISTER_BASE, hits: [] },
    'the prefix is too broad': { ...REGISTER_BASE, search: 'a', moreMatches: true },
    'two lines in the basket': REGISTER_BASE,
    'a discount the server allowed on a line': { ...REGISTER_BASE, cart: DISCOUNTED, discountDrafts: { [LINE_ONE]: '3.65' } },
    'a quantity that is not a quantity': {
      ...REGISTER_BASE,
      quantityDrafts: { [LINE_ONE]: '2,5,5' },
      quantityErrors: { [LINE_ONE]: 'pos.basket.quantityInvalid' },
    },
    'a discount that is not an amount': {
      ...REGISTER_BASE,
      discountDrafts: { [LINE_ONE]: '1.555' },
      discountErrors: { [LINE_ONE]: 'pos.discount.invalid' },
    },
    'finishing is confirmed first': { ...REGISTER_BASE, confirmingFinish: true },
    'the basket has not been driven yet': { ...REGISTER_BASE, cart: null, hits: null, search: '' },
    'the command was refused': { ...REGISTER_BASE, errorKey: 'error.pos.session_not_open' },
    // A refusal only the SALE commit can send: the browser's day is ahead of
    // the server's. The till states the document date, so it is reachable.
    'the sale was refused': { ...REGISTER_BASE, errorKey: 'error.sale.document_date_in_future' },
  }),
  defineView('SaleDoneView', SaleDoneView, {
    'a sale with a discount': SALE_DONE,
    'a sale with no discount': {
      ...SALE_DONE,
      sale: {
        ...SALE,
        discountTxnMinor: '0',
        totalTxnMinor: '7365',
        lines: SALE.lines.map((line) => ({ ...line, discountTxnMinor: '0', netTxnMinor: line.grossTxnMinor })),
      },
    },
  }),
];
