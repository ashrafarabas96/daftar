'use client';
/**
 * Display-name lookups the purchasing and supplier pages share. A purchase
 * carries ids; the names come from the live reads (items `ids=`, warehouses,
 * suppliers) in the viewer's language. Nothing here computes a figure.
 */
import type { SupplierDto } from '@daftar/shared-contracts';
import { getSupplier, listInventoryItems, listInventoryWarehouses, type InventoryItemDto } from '@/lib/phase3-api';

/** The items `ids=` read takes at most fifty per page (A-06). */
const IDS_PER_READ = 50;

/** productId → the item, for every distinct id (merchant variants only; the base variant is never listed). */
export async function itemsById(productIds: readonly string[]): Promise<Map<string, InventoryItemDto>> {
  const distinct = [...new Set(productIds)];
  const chunks: string[][] = [];
  for (let i = 0; i < distinct.length; i += IDS_PER_READ) chunks.push(distinct.slice(i, i + IDS_PER_READ));
  const pages = await Promise.all(chunks.map((ids) => listInventoryItems({ ids, limit: IDS_PER_READ })));
  return new Map(pages.flatMap((p) => p.items).map((item) => [item.productId, item]));
}

/** warehouseId → name, for the warehouses the caller reaches. */
export async function warehouseNames(): Promise<Map<string, string>> {
  const warehouses = await listInventoryWarehouses();
  return new Map(warehouses.items.map((w) => [w.warehouseId, w.name]));
}

/** supplierId → supplier, for every distinct id. */
export async function suppliersById(supplierIds: readonly string[]): Promise<Map<string, SupplierDto>> {
  const distinct = [...new Set(supplierIds)];
  const suppliers = await Promise.all(distinct.map((id) => getSupplier(id)));
  return new Map(suppliers.map((s) => [s.id, s]));
}

/** The item's display name with its merchant variant, if any. */
export function lineNames(
  items: ReadonlyMap<string, InventoryItemDto>,
  productId: string,
  variantId: string | null,
): { name: string; variantName: string | null; unitDecimals: number } {
  const item = items.get(productId);
  const variant = variantId === null ? undefined : item?.variants.find((v) => v.variantId === variantId);
  return { name: item?.name ?? '', variantName: variant?.name ?? null, unitDecimals: item?.unitDecimals ?? 0 };
}
