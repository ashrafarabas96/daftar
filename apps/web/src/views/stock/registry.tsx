/**
 * The stock views and the fixtures the SSR suites render them with (P3-S7
 * §4.3, §6: T-08, T-15, T-16).
 *
 * The fixtures carry, on purpose, what a real payload holds and a screen must
 * never show: the base variant, the stock sequence, the trace, entry and
 * movement ids, and a posting account planted on a command answer. T-08
 * proves none of them reaches the markup.
 */
import type { InventoryMovementDocumentDto, InventoryOpeningDto } from '@daftar/shared-contracts';
import type { InventoryStocktakeDetailDto, InventoryStockRowDto, InventoryStocktakeSummaryDto, InventoryWarehouseDto } from '@/lib/phase3-api';
import { defineView, type ViewEntry } from '@/lib/phase3-format';
import { AdjustStockView, type AdjustStockViewProps } from './AdjustStockView';
import { CountListView, type CountListViewProps } from './CountListView';
import { CountSheetView, type CountSheetViewProps } from './CountSheetView';
import { MoveStockView, type MoveStockViewProps } from './MoveStockView';
import { ScreenState } from './parts';
import { StockLevelsView, type StockLevelsViewProps } from './StockLevelsView';
import { draftLineOf, identityKey, stockRowOptions, type DraftLine, type PickOption } from './model';

const noop = (): void => undefined;

// ── Hidden values a real payload carries (T-08) ─────────────────────────

const HIDDEN = {
  baseVariantId: 'ba5e0000-7777-4c2b-9a0d-00000000bv07',
  lastStockSeq: '918273645501',
  capturedAtStockSeq: '918273645577',
  businessTransactionId: 'b7d3a2c1-7777-4c2b-9a0d-00000000bt07',
  journalEntryId: 'e9e9e9e9-7777-4c2b-9a0d-00000000je07',
  movementId: 'a0a0a0a0-7777-4c2b-9a0d-00000000mv07',
  postingAccountId: 'acc0acc0-7777-4c2b-9a0d-00000000pa07',
} as const;

// ── Master data ─────────────────────────────────────────────────────────

const MAIN = 'c1000000-0000-4000-8000-000000000001';
const BACK = 'c1000000-0000-4000-8000-000000000002';
const OLD = 'c1000000-0000-4000-8000-000000000003';

const WAREHOUSES: InventoryWarehouseDto[] = [
  {
    warehouseId: MAIN,
    name: 'Main store',
    status: 'active',
    homeBranchId: 'b1000000-0000-4000-8000-000000000001',
    branchIds: ['b1000000-0000-4000-8000-000000000001'],
  },
  {
    warehouseId: BACK,
    name: 'Back room',
    status: 'active',
    homeBranchId: 'b1000000-0000-4000-8000-000000000001',
    branchIds: ['b1000000-0000-4000-8000-000000000001'],
  },
  {
    warehouseId: OLD,
    name: 'Old depot',
    status: 'archived',
    homeBranchId: 'b1000000-0000-4000-8000-000000000002',
    branchIds: ['b1000000-0000-4000-8000-000000000002'],
  },
];

const UNIT_NAMES: Record<string, string> = { piece: 'Piece', kg: 'Kilogram' };

const OIL = 'd1000000-0000-4000-8000-000000000001';
const SHIRT = 'd1000000-0000-4000-8000-000000000002';
const RICE = 'd1000000-0000-4000-8000-000000000003';
const SHIRT_RED = 'e1000000-0000-4000-8000-000000000001';
const SHIRT_BLUE = 'e1000000-0000-4000-8000-000000000002';

/** Stock rows as the read returns them, with what the stock_levels row holds and the read never returns. */
const OIL_ROW = {
  productId: OIL,
  variantId: null,
  name: 'Olive oil',
  variantName: null,
  unitCode: 'piece',
  unitDecimals: 0,
  onHand: '12',
  lastStockSeq: HIDDEN.lastStockSeq,
  baseVariantId: HIDDEN.baseVariantId,
};
const RED_ROW = { productId: SHIRT, variantId: SHIRT_RED, name: 'Shirt', variantName: 'Red / M', unitCode: 'piece', unitDecimals: 0, onHand: '0' };
const BLUE_ROW = { productId: SHIRT, variantId: SHIRT_BLUE, name: 'Shirt', variantName: 'Blue / L', unitCode: 'piece', unitDecimals: 0, onHand: '-3' };
/** Stock recorded before the shirt had options: shown under the item's name alone. */
const SHIRT_BEFORE_OPTIONS = {
  productId: SHIRT,
  variantId: null,
  name: 'Shirt',
  variantName: null,
  unitCode: 'piece',
  unitDecimals: 0,
  onHand: '4',
  baseVariantId: HIDDEN.baseVariantId,
};
const RICE_ROW = { productId: RICE, variantId: null, name: 'Rice', variantName: null, unitCode: 'kg', unitDecimals: 3, onHand: '1234.5' };
const ROWS: InventoryStockRowDto[] = [OIL_ROW, RED_ROW, BLUE_ROW, SHIRT_BEFORE_OPTIONS, RICE_ROW];

const OPTIONS: PickOption[] = stockRowOptions(ROWS);
const lineOf = (index: number, quantity: string, extra: Partial<DraftLine> = {}): DraftLine => {
  const option = OPTIONS[index];
  if (option === undefined) throw new Error(`no stock option ${index}`);
  return { ...draftLineOf(option, `f1000000-0000-4000-8000-00000000000${index}`), quantity, ...extra };
};

// ── Command answers (never shown beyond their quantities) ───────────────

const movementLine = (productId: string, variantId: string | null, warehouseId: string, qtyDelta: string, suffix: string) => ({
  lineId: `f2000000-0000-4000-8000-0000000000${suffix}`,
  productId,
  variantId,
  warehouseId,
  qtyDelta,
  valueDeltaBaseMinor: qtyDelta.startsWith('-') ? '-98765431' : '98765431',
  movementId: HIDDEN.movementId,
});

const TRANSFER_RESULT: InventoryMovementDocumentDto = {
  id: 'f3000000-0000-4000-8000-000000000001',
  replayed: false,
  businessTransactionId: HIDDEN.businessTransactionId,
  journalEntryId: null,
  lines: [
    movementLine(OIL, null, MAIN, '-5.0000', '01'),
    movementLine(OIL, null, BACK, '5.0000', '02'),
    movementLine(RICE, null, MAIN, '-2.5000', '03'),
    movementLine(RICE, null, BACK, '2.5000', '04'),
  ],
};

const ADJUST_ANSWER = {
  id: 'f3000000-0000-4000-8000-000000000002',
  replayed: false,
  businessTransactionId: HIDDEN.businessTransactionId,
  journalEntryId: HIDDEN.journalEntryId,
  postingAccountId: HIDDEN.postingAccountId,
  lines: [movementLine(OIL, null, MAIN, '3.0000', '05'), movementLine(RICE, null, MAIN, '-0.2500', '06')],
};
const ADJUST_RESULT: InventoryMovementDocumentDto = ADJUST_ANSWER;

const OPENING_ANSWER = {
  ...ADJUST_ANSWER,
  id: 'f3000000-0000-4000-8000-000000000003',
  case: 'ledger_posting' as const,
  openingBalanceId: null,
  matchedAmountMinor: null,
  lines: [movementLine(OIL, null, MAIN, '40.0000', '07')],
};
const OPENING_RESULT: InventoryOpeningDto = OPENING_ANSWER;

// ── Stock levels ────────────────────────────────────────────────────────

const levels = (over: Partial<StockLevelsViewProps>): StockLevelsViewProps => ({
  warehouses: WAREHOUSES,
  warehouseId: MAIN,
  search: '',
  status: '',
  rows: ROWS,
  unitNames: UNIT_NAMES,
  hasMore: false,
  loadingMore: false,
  errorKey: null,
  actions: { move: true, count: true, adjust: true },
  onWarehouse: noop,
  onSearch: noop,
  onStatus: noop,
  onLoadMore: noop,
  onAction: noop,
  onTrackProduct: noop,
  ...over,
});

// ── Move Stock ──────────────────────────────────────────────────────────

const move = (over: Partial<MoveStockViewProps>): MoveStockViewProps => ({
  warehouses: WAREHOUSES,
  fromId: MAIN,
  toId: BACK,
  search: 'o',
  options: OPTIONS,
  lines: [lineOf(0, '5'), lineOf(4, '2.5')],
  lineErrors: {},
  unitNames: UNIT_NAMES,
  errorKey: null,
  busy: false,
  result: null,
  onFrom: noop,
  onTo: noop,
  onSearch: noop,
  onPick: noop,
  onQuantity: noop,
  onRemove: noop,
  onSubmit: noop,
  onNew: noop,
  onBack: noop,
  ...over,
});

// ── Adjust Stock ────────────────────────────────────────────────────────

const adjust = (over: Partial<AdjustStockViewProps>): AdjustStockViewProps => ({
  warehouses: WAREHOUSES,
  warehouseId: MAIN,
  reasons: ['found', 'missing', 'damaged', 'starting'],
  reason: 'found',
  occurredOn: '2026-09-27',
  note: '',
  currency: 'SAR',
  search: '',
  options: null,
  lines: [lineOf(0, '3', { needsCost: true }), lineOf(4, '0.25')],
  lineErrors: {},
  costErrors: {},
  unitNames: UNIT_NAMES,
  errorKey: null,
  busy: false,
  result: null,
  onWarehouse: noop,
  onReason: noop,
  onDate: noop,
  onNote: noop,
  onSearch: noop,
  onPick: noop,
  onQuantity: noop,
  onCost: noop,
  onRemove: noop,
  onSubmit: noop,
  onNew: noop,
  onBack: noop,
  ...over,
});

// ── Count Stock ─────────────────────────────────────────────────────────

const STOCKTAKES: InventoryStocktakeSummaryDto[] = [
  {
    stocktakeId: 'a1000000-0000-4000-8000-000000000003',
    warehouseId: MAIN,
    status: 'draft',
    createdAt: '2026-09-27T08:00:00.000Z',
    closedAt: null,
    lineCount: 2,
  },
  {
    stocktakeId: 'a1000000-0000-4000-8000-000000000002',
    warehouseId: MAIN,
    status: 'finalized',
    createdAt: '2026-08-31T08:00:00.000Z',
    closedAt: '2026-08-31T12:00:00.000Z',
    lineCount: 14,
  },
  {
    stocktakeId: 'a1000000-0000-4000-8000-000000000001',
    warehouseId: MAIN,
    status: 'cancelled',
    createdAt: '2026-07-31T08:00:00.000Z',
    closedAt: '2026-07-31T09:00:00.000Z',
    lineCount: 0,
  },
];

const countList = (over: Partial<CountListViewProps>): CountListViewProps => ({
  warehouses: WAREHOUSES,
  warehouseId: MAIN,
  stocktakes: STOCKTAKES,
  openStocktakeId: 'a1000000-0000-4000-8000-000000000003',
  canCount: true,
  hasMore: true,
  busy: false,
  errorKey: null,
  onWarehouse: noop,
  onStart: noop,
  onOpen: noop,
  onLoadMore: noop,
  ...over,
});

const countLine = (row: (typeof ROWS)[number], counted: string, expected: string | null, variance: string | null, suffix: string) => ({
  lineId: `a2000000-0000-4000-8000-0000000000${suffix}`,
  productId: row.productId,
  variantId: row.variantId,
  name: row.name,
  variantName: row.variantName,
  unitCode: row.unitCode,
  unitDecimals: row.unitDecimals,
  countedQty: counted,
  expectedQty: expected,
  varianceQty: variance,
  capturedAtStockSeq: HIDDEN.capturedAtStockSeq,
});

/** An open count as a member without `inventory.adjust` reads it: no expected quantity (TL-8). */
const BLIND_DRAFT: InventoryStocktakeDetailDto = {
  ...STOCKTAKES[0],
  stocktakeId: 'a1000000-0000-4000-8000-000000000003',
  warehouseId: MAIN,
  status: 'draft',
  createdAt: '2026-09-27T08:00:00.000Z',
  closedAt: null,
  lineCount: 2,
  lines: [countLine(OIL_ROW, '11.0000', null, null, '01'), countLine(RICE_ROW, '1234.5000', null, null, '02')],
};

/** The same count as a member who may adjust stock reads it. */
const SIGHTED_DRAFT: InventoryStocktakeDetailDto = {
  ...BLIND_DRAFT,
  lines: [countLine(OIL_ROW, '11.0000', '12.0000', '-1.0000', '01'), countLine(RED_ROW, '2.0000', '0.0000', '2.0000', '03')],
};

const FINISHED: InventoryStocktakeDetailDto = {
  ...BLIND_DRAFT,
  stocktakeId: 'a1000000-0000-4000-8000-000000000002',
  status: 'finalized',
  createdAt: '2026-08-31T08:00:00.000Z',
  closedAt: '2026-08-31T12:00:00.000Z',
  lineCount: 3,
  lines: [
    countLine(OIL_ROW, '11.0000', '12.0000', '-1.0000', '01'),
    countLine(RED_ROW, '2.0000', '0.0000', '2.0000', '03'),
    countLine(RICE_ROW, '1234.5000', '1234.5000', '0.0000', '02'),
  ],
};

const countSheet = (over: Partial<CountSheetViewProps>): CountSheetViewProps => ({
  stocktake: BLIND_DRAFT,
  warehouseName: 'Main store',
  canCount: true,
  counts: { [identityKey(OIL, null)]: '10' },
  newLines: [],
  search: '',
  options: null,
  costLines: [],
  costs: {},
  occurredOn: '2026-09-27',
  currency: 'SAR',
  unitNames: UNIT_NAMES,
  lineErrors: {},
  costErrors: {},
  errorKey: null,
  noticeKey: null,
  busy: false,
  running: null,
  confirmCancel: false,
  confirmFinish: false,
  onCount: noop,
  onSearch: noop,
  onPick: noop,
  onNewQuantity: noop,
  onRemoveNew: noop,
  onCost: noop,
  onDate: noop,
  onSave: noop,
  onAskFinish: noop,
  onFinish: noop,
  onDismissFinish: noop,
  onAskCancel: noop,
  onConfirmCancel: noop,
  onDismissCancel: noop,
  onBack: noop,
  ...over,
});

/** Count Stock picks items with no quantity (TL-8). */
const COUNT_OPTIONS: PickOption[] = OPTIONS.map((o) => ({ ...o, onHand: null }));

export const VIEW_REGISTRY: readonly ViewEntry[] = [
  defineView('StockLevelsView', StockLevelsView, {
    'rows in stock, out of stock, short, with options and stock from before options': levels({}),
    'no warehouse chosen': levels({ warehouseId: '', rows: null }),
    loading: levels({ rows: null, actions: { move: false, count: false, adjust: false } }),
    'empty warehouse, more pages, a refusal': levels({ rows: [], hasMore: true, errorKey: 'error.inventory.warehouse_out_of_scope' }),
  }),
  defineView('MoveStockView', MoveStockView, {
    'two lines, one with a bad quantity': move({ lineErrors: { 'f1000000-0000-4000-8000-000000000004': 'stock.line.quantityInvalid' } }),
    'no source warehouse yet': move({ fromId: '', toId: '', options: null, lines: [] }),
    'refused: not enough stock': move({ errorKey: 'error.inventory.insufficient_stock', options: [] }),
    'moved: the server answer': move({ result: TRANSFER_RESULT }),
  }),
  defineView('AdjustStockView', AdjustStockView, {
    'found extra: the server asked a cost on one line': adjust({ errorKey: 'error.inventory.unit_cost_required', options: OPTIONS }),
    'missing, member without starting stock': adjust({ reason: 'missing', reasons: ['found', 'missing', 'damaged'], lines: [lineOf(2, '1')] }),
    damaged: adjust({ reason: 'damaged', note: 'Broken in delivery', lines: [lineOf(1, '1')] }),
    'starting stock asks a cost on every line': adjust({ reason: 'starting', lines: [lineOf(0, '40', { unitCost: '2.50' })] }),
    'a cost that is not an amount': adjust({
      reason: 'starting',
      lines: [lineOf(0, '40', { unitCost: 'x' })],
      costErrors: { [lineOf(0, '40').lineKey]: 'stock.line.costInvalid' },
    }),
    'recorded: the server answer': adjust({ result: ADJUST_RESULT }),
    'starting stock recorded': adjust({ reason: 'starting', result: OPENING_RESULT, lines: [lineOf(0, '40', { unitCost: '2.50' })] }),
  }),
  defineView('CountListView', CountListView, {
    'an open count and earlier ones': countList({}),
    'no count yet': countList({ stocktakes: [], openStocktakeId: null, hasMore: false }),
    'view only': countList({ canCount: false, hasMore: false }),
    'no warehouse chosen': countList({ warehouseId: '', stocktakes: null, openStocktakeId: null, hasMore: false }),
  }),
  defineView('CountSheetView', CountSheetView, {
    'blind count in progress': countSheet({
      newLines: [{ ...lineOf(1, 'x'), onHand: null }],
      lineErrors: { 'f1000000-0000-4000-8000-000000000001': 'stock.line.quantityInvalid' },
      search: 'shirt',
      options: COUNT_OPTIONS,
    }),
    'count with expected quantities and a cost asked': countSheet({
      stocktake: SIGHTED_DRAFT,
      counts: {},
      costLines: [identityKey(SHIRT, SHIRT_RED)],
      costs: { [identityKey(SHIRT, SHIRT_RED)]: '7.25' },
      errorKey: 'error.inventory.unit_cost_required',
    }),
    'finished: how each line compared': countSheet({ stocktake: FINISHED, counts: {}, noticeKey: 'stock.count.finished' }),
    'cancelling asks first': countSheet({ confirmCancel: true }),
    'finishing asks first': countSheet({ confirmFinish: true }),
    'a cost that is not an amount': countSheet({
      stocktake: SIGHTED_DRAFT,
      counts: {},
      costLines: [identityKey(SHIRT, SHIRT_RED)],
      costs: { [identityKey(SHIRT, SHIRT_RED)]: 'abc' },
      costErrors: { [identityKey(SHIRT, SHIRT_RED)]: 'stock.line.costInvalid' },
    }),
    'saving: only Save shows progress': countSheet({ busy: true, running: 'save' }),
    'view only': countSheet({ canCount: false }),
  }),
  defineView('ScreenState', ScreenState, {
    loading: { state: 'loading' as const },
    'no permission': { state: 'denied' as const },
    'failed to load': { state: 'failed' as const },
  }),
];
