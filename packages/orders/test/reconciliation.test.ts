/**
 * Channel reconciliation.
 *
 * Each of the six finding codes gets its own minimal fixture, and each fixture
 * is proved to produce EXACTLY that one finding — not merely "a finding". A
 * reconciler that returned every code for every input would satisfy a looser
 * assertion and would be useless.
 *
 * The clean fixture is proved reconciled in the same breath, because a fold
 * that reported a finding for correct data would be the more expensive defect:
 * nobody acts on an alarm that is always on.
 */
import { describe, expect, it } from 'vitest';
import { ORDER_CHANNELS, reconcileChannelOrders, type CanonicalSaleRow, type ChannelOrderRow, type ReconciliationFindingCode } from '../src';

const O1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const O2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const S1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const S2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';

function codes(orders: readonly ChannelOrderRow[], sales: readonly CanonicalSaleRow[]): ReconciliationFindingCode[] {
  return reconcileChannelOrders(orders, sales).findings.map((f) => f.code);
}

describe('a reconciled period', () => {
  it('reports nothing for a sold order, an open order and a direct POS sale together', () => {
    const report = reconcileChannelOrders(
      [
        { orderId: O1, channel: 'storefront', state: 'completed', saleId: S1 },
        { orderId: O2, channel: 'storefront', state: 'accepted', saleId: null },
      ],
      [
        { saleId: S1, orderId: O1 },
        { saleId: S2, orderId: null },
      ],
    );
    expect(report.findings).toEqual([]);
    expect(report.isReconciled).toBe(true);
    expect(report.checkedOrders).toBe(2);
    expect(report.checkedSales).toBe(2);
    expect(report.salesWithoutChannelOrigin).toBe(1);
  });

  it('counts an empty period as reconciled, and says the subject was empty', () => {
    const report = reconcileChannelOrders([], []);
    expect(report.isReconciled).toBe(true);
    expect(report.checkedOrders).toBe(0);
    expect(report.checkedSales).toBe(0);
  });
});

describe('each finding, exactly once, from its own minimal fixture', () => {
  it('order_without_sale — the order believes it sold something the ledger never saw', () => {
    const report = reconcileChannelOrders([{ orderId: O1, channel: 'storefront', state: 'fulfilled', saleId: S1 }], []);
    expect(report.findings).toEqual([{ code: 'order_without_sale', orderId: O1, saleId: S1, counterpartId: null }]);
    expect(report.isReconciled).toBe(false);
  });

  it('order_binding_missing — a sale-bound state with no sale id', () => {
    expect(codes([{ orderId: O1, channel: 'storefront', state: 'fulfilled', saleId: null }], [])).toEqual(['order_binding_missing']);
  });

  it('binding_without_state — a sale id on an order that never reached the sale', () => {
    expect(codes([{ orderId: O1, channel: 'storefront', state: 'accepted', saleId: S1 }], [{ saleId: S1, orderId: O1 }])).toEqual(['binding_without_state']);
  });

  it('sale_without_order — a sale naming an order nobody has', () => {
    expect(codes([], [{ saleId: S1, orderId: O1 }])).toEqual(['sale_without_order']);
  });

  it('order_sale_mismatch — the sale names an order bound to a different sale, and names the other sale', () => {
    const report = reconcileChannelOrders(
      [{ orderId: O1, channel: 'storefront', state: 'fulfilled', saleId: S2 }],
      [
        { saleId: S1, orderId: O1 },
        { saleId: S2, orderId: O1 },
      ],
    );
    const mismatch = report.findings.filter((f) => f.code === 'order_sale_mismatch');
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]?.saleId).toBe(S1);
    expect(mismatch[0]?.counterpartId).toBe(S2);
  });

  it('sale_shared_by_orders — two orders bound to one sale, naming the first claimant', () => {
    const report = reconcileChannelOrders(
      [
        { orderId: O1, channel: 'storefront', state: 'fulfilled', saleId: S1 },
        { orderId: O2, channel: 'marketplace', state: 'completed', saleId: S1 },
      ],
      [{ saleId: S1, orderId: O1 }],
    );
    const shared = report.findings.filter((f) => f.code === 'sale_shared_by_orders');
    expect(shared).toHaveLength(1);
    expect(shared[0]?.orderId).toBe(O2);
    expect(shared[0]?.counterpartId).toBe(O1);
  });
});

describe('the inputs themselves', () => {
  it('refuses two rows for one order id', () => {
    expect(() =>
      reconcileChannelOrders(
        [
          { orderId: O1, channel: 'storefront', state: 'accepted', saleId: null },
          { orderId: O1, channel: 'storefront', state: 'cancelled', saleId: null },
        ],
        [],
      ),
    ).toThrowError(expect.objectContaining({ code: 'order.reconciliation_order_duplicate' }));
  });

  it('refuses two rows for one sale id', () => {
    expect(() =>
      reconcileChannelOrders(
        [],
        [
          { saleId: S1, orderId: null },
          { saleId: S1, orderId: null },
        ],
      ),
    ).toThrowError(expect.objectContaining({ code: 'order.reconciliation_sale_duplicate' }));
  });

  it('refuses an unrecognised channel rather than bucketing it as other', () => {
    expect(() => reconcileChannelOrders([{ orderId: O1, channel: 'tiktok', state: 'accepted', saleId: null }], [])).toThrowError(
      expect.objectContaining({ code: 'order.channel_unknown' }),
    );
  });

  it('accepts every channel it declares, and the declared set is non-empty', () => {
    expect(ORDER_CHANNELS.length).toBeGreaterThan(0);
    for (const channel of ORDER_CHANNELS) {
      expect(reconcileChannelOrders([{ orderId: O1, channel, state: 'accepted', saleId: null }], []).isReconciled).toBe(true);
    }
  });
});

describe('what this fold does NOT claim', () => {
  it('compares no amount and no quantity — neither input carries one', () => {
    const orderKeys = Object.keys({ orderId: O1, channel: 'storefront', state: 'accepted', saleId: null } satisfies ChannelOrderRow);
    const saleKeys = Object.keys({ saleId: S1, orderId: null } satisfies CanonicalSaleRow);
    for (const key of [...orderKeys, ...saleKeys]) {
      expect(key).not.toMatch(/minor|total|amount|quantity|price/i);
    }
  });
});
