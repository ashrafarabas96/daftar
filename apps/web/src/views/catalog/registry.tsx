/**
 * The catalog view S7 adds — the "Track stock" card — and its SSR fixtures
 * (P3-S7 §4.3, §6: T-08, T-15, T-16).
 */
import type { InventoryItemDto, InventoryUnitDto } from '@/lib/phase3-api';
import { defineView, type ViewEntry } from '@/lib/phase3-format';
import { TrackingCard, type TrackingCardProps } from './TrackingCard';

const noop = (): void => undefined;

const UNITS: InventoryUnitDto[] = [
  { unitCode: 'piece', name: 'Piece', defaultDecimals: 0 },
  { unitCode: 'kg', name: 'Kilogram', defaultDecimals: 3 },
];

/** A product with options: its base variant exists on the server and never reaches this card. */
const SHIRT = {
  productId: 'd1000000-0000-4000-8000-000000000002',
  name: 'Shirt',
  status: 'active' as const,
  trackInventory: true,
  unitCode: 'piece',
  unitDecimals: 0,
  holdsStock: true,
  variants: [{ variantId: 'e1000000-0000-4000-8000-000000000001', name: 'Red / M', status: 'active' as const }],
  baseVariantId: 'ba5e0000-8888-4c2b-9a0d-00000000bv08',
};
const TRACKED: InventoryItemDto = SHIRT;

const NEW_ITEM: InventoryItemDto = {
  productId: 'd1000000-0000-4000-8000-000000000009',
  name: 'Honey',
  status: 'active',
  trackInventory: false,
  unitCode: null,
  unitDecimals: null,
  holdsStock: false,
  variants: [],
};

const card = (over: Partial<TrackingCardProps>): TrackingCardProps => ({
  item: NEW_ITEM,
  units: UNITS,
  track: false,
  unitCode: '',
  decimals: '',
  busy: false,
  errorKey: null,
  noticeKey: null,
  onTrack: noop,
  onUnit: noop,
  onDecimals: noop,
  onSave: noop,
  ...over,
});

export const VIEW_REGISTRY: readonly ViewEntry[] = [
  defineView('TrackingCard', TrackingCard, {
    'not tracked yet': card({}),
    'turning tracking on: choose a unit': card({ track: true }),
    'tracked, holds stock, refused a unit change': card({
      item: TRACKED,
      track: true,
      unitCode: 'kg',
      decimals: '0',
      errorKey: 'error.inventory.unit_identity_locked',
    }),
    saved: card({ item: TRACKED, track: true, unitCode: 'piece', decimals: '0', noticeKey: 'stock.tracking.saved' }),
    'whether it holds stock is not told to this member': card({ item: { ...TRACKED, holdsStock: null }, track: true, unitCode: 'piece', decimals: '0' }),
    loading: card({ item: null }),
    'failed to load': card({ item: null, errorKey: 'error.fallback' }),
  }),
];
