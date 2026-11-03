/**
 * SEEDING THROUGH THE API ONLY (directive §8: "business seeded through the API").
 *
 * No row is written to the database directly. Each locale gets its own owner,
 * registered with that locale, whose main business holds warehouses, tracked
 * items, a posted opening, suppliers, received and draft purchases and an open
 * stock count — everything the Phase 3 screens read. Per viewport the owner
 * also gets two things a run consumes: one untouched received purchase (for
 * "Undo receipt") and one new business with a tracked item and NO opening
 * (a business has one posted opening, so "Starting stock" can succeed once
 * per business; the empty lists of that business are the empty states).
 */
import { randomUUID } from 'node:crypto';
import type { Locale, Viewport } from './config';
import { comboTag } from './config';

export class ApiCallError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${method} ${path} -> ${status} ${body.slice(0, 300)}`);
    this.name = 'ApiCallError';
  }
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(value: unknown, key: string): unknown {
  if (!isRecord(value)) throw new Error(`expected an object with "${key}"`);
  return value[key];
}

function str(value: unknown, key: string): string {
  const v = field(value, key);
  if (typeof v !== 'string') throw new Error(`expected "${key}" to be a string`);
  return v;
}

function list(value: unknown, key: string): unknown[] {
  const v = field(value, key);
  if (!Array.isArray(v)) throw new Error(`expected "${key}" to be an array`);
  return v;
}

class Client {
  token: string | null = null;
  business: string | null = null;
  constructor(private readonly api: string) {}

  async call(method: 'GET' | 'POST' | 'PUT', path: string, body?: Json): Promise<unknown> {
    const headers: Record<string, string> = { 'content-type': 'application/json', 'accept-language': 'en' };
    if (this.token !== null) headers['authorization'] = `Bearer ${this.token}`;
    if (this.business !== null) headers['x-business-id'] = this.business;
    if (method !== 'GET') headers['idempotency-key'] = randomUUID();
    const res = await fetch(this.api + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new ApiCallError(method, path, res.status, text);
    return text.length === 0 ? null : (JSON.parse(text) as unknown);
  }
}

/** Merchant-visible names, per locale, that the flows search for and click. */
export interface LocaleNames {
  readonly business: string;
  readonly second: string;
  readonly supplierA: string;
  readonly supplierASearch: string;
  readonly supplierB: string;
  readonly supplierBSearch: string;
  readonly rice: string;
  readonly riceSearch: string;
  /**
   * The POS type-ahead is a PREFIX probe, not a substring one: `pos-reads.ts`
   * matches `lower(t.name) ^@ lower($q)`. `riceSearch` is the substring term
   * the catalog and stock pickers use, and "rice" is not a prefix of "Basmati
   * rice 5 kg" — measured on the browser gate, where the en and tr POS sale
   * steps timed out waiting for the row while ar passed only because "أرز"
   * happens to be a prefix of "أرز بسمتي ٥ كغ". These two are real prefixes.
   */
  readonly ricePrefix: string;
  readonly oil: string;
  readonly oilSearch: string;
  readonly tea: string;
  readonly teaSearch: string;
  /** See `ricePrefix`: a real prefix of `tea`, for the POS type-ahead. */
  readonly teaPrefix: string;
  readonly cash: string;
  readonly starterItem: string;
}

export const NAMES: Readonly<Record<Locale, LocaleNames>> = {
  ar: {
    business: 'متجر النور',
    second: 'مستودع المعرض',
    supplierA: 'شركة الجنيدي للتوريدات الغذائية',
    supplierASearch: 'الجنيدي',
    supplierB: 'Al-Quds Trading Co.',
    supplierBSearch: 'Quds',
    rice: 'أرز بسمتي ٥ كغ',
    riceSearch: 'أرز',
    ricePrefix: 'أرز',
    oil: 'زيت زيتون بكر ممتاز ١ لتر',
    oilSearch: 'زيت',
    tea: 'شاي أخضر',
    teaSearch: 'شاي',
    teaPrefix: 'شاي',
    cash: 'الصندوق',
    starterItem: 'عسل جبلي',
  },
  en: {
    business: 'Corner Grocer',
    second: 'Showroom store',
    supplierA: 'Jneidi Food Supplies',
    supplierASearch: 'Jneidi',
    supplierB: 'Al-Quds Trading Co.',
    supplierBSearch: 'Quds',
    rice: 'Basmati rice 5 kg',
    riceSearch: 'rice',
    ricePrefix: 'Basmati',
    oil: 'Extra virgin olive oil 1 L',
    oilSearch: 'olive',
    tea: 'Green tea',
    teaSearch: 'tea',
    teaPrefix: 'Green',
    cash: 'Cash drawer',
    starterItem: 'Mountain honey',
  },
  tr: {
    business: 'Köşe Bakkalı',
    second: 'Teşhir deposu',
    supplierA: 'Güneş Gıda Tedarik Ltd. Şti.',
    supplierASearch: 'Güneş',
    supplierB: 'Al-Quds Trading Co.',
    supplierBSearch: 'Quds',
    rice: 'Basmati pirinç 5 kg',
    riceSearch: 'pirinç',
    ricePrefix: 'Basmati',
    oil: 'Sızma zeytinyağı 1 L',
    oilSearch: 'zeytin',
    tea: 'Yeşil çay',
    teaSearch: 'çay',
    teaPrefix: 'Yeşil',
    cash: 'Kasa',
    starterItem: 'Dağ balı',
  },
};

const PRODUCT_TEXT = {
  rice: { ar: 'أرز بسمتي ٥ كغ', en: 'Basmati rice 5 kg', tr: 'Basmati pirinç 5 kg' },
  oil: { ar: 'زيت زيتون بكر ممتاز ١ لتر', en: 'Extra virgin olive oil 1 L', tr: 'Sızma zeytinyağı 1 L' },
  sugar: { ar: 'سكر أبيض سائب', en: 'Loose white sugar', tr: 'Açık toz şeker' },
  tea: { ar: 'شاي أخضر', en: 'Green tea', tr: 'Yeşil çay' },
  honey: { ar: 'عسل جبلي', en: 'Mountain honey', tr: 'Dağ balı' },
} as const;

const MARKET: Readonly<Record<Locale, { country: string; currency: string }>> = {
  ar: { country: 'PS', currency: 'ILS' },
  en: { country: 'PS', currency: 'ILS' },
  tr: { country: 'TR', currency: 'TRY' },
};

export interface StarterBusiness {
  readonly businessId: string;
  readonly name: string;
}

export interface LocaleSeed {
  readonly locale: Locale;
  readonly email: string;
  readonly password: string;
  readonly currency: string;
  readonly businessId: string;
  readonly mainWarehouse: string;
  readonly secondWarehouse: string;
  readonly supplierA: string;
  readonly supplierB: string;
  /** The purchase with the most lines, received in the past: the return flow's source ("INV-2041"). */
  readonly returnReference: string;
  readonly draftId: string;
  /** Per viewport tag: the supplier reference of one untouched received purchase for "Undo receipt". */
  readonly undoReference: Readonly<Record<string, string>>;
  /** Per viewport tag: a business with a tracked item and no opening yet. */
  readonly starter: Readonly<Record<string, StarterBusiness>>;
}

const daysAgo = (n: number): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

async function trackedProduct(c: Client, text: { ar: string; en: string; tr: string }, priceMinor: number, unitCode: string): Promise<string> {
  const p = await c.call('POST', '/v1/catalog/products', { translations: { ...text }, basePriceMinor: String(priceMinor) });
  const id = str(p, 'id');
  await c.call('PUT', `/v1/inventory/products/${id}/configuration`, { trackInventory: true, unitCode });
  return id;
}

async function warehousesOf(c: Client): Promise<{ id: string; branchId: string; name: string }[]> {
  return list(await c.call('GET', '/v1/businesses/current/warehouses'), 'items').map((w) => ({
    id: str(w, 'id'),
    branchId: str(w, 'branchId'),
    name: str(w, 'name'),
  }));
}

/** Seed one locale's owner and businesses. `viewports` decides how many per-run artefacts are made. */
export async function seedLocale(api: string, locale: Locale, viewports: readonly Viewport[], runId: string): Promise<LocaleSeed> {
  const c = new Client(api);
  const n = NAMES[locale];
  const market = MARKET[locale];
  const email = `owner-${locale}-${runId}@daftar.local`;
  const password = 'Str0ng!Passw0rd-browser';
  const reg = await c.call('POST', '/v1/auth/register', {
    email,
    password,
    displayName: locale === 'ar' ? 'سامر الخطيب' : 'Deniz Kaya',
    preferredLocale: locale,
  });
  c.token = str(reg, 'accessToken');
  const on = await c.call('POST', '/v1/onboarding/complete', {
    businessName: n.business,
    countryCode: market.country,
    baseCurrency: market.currency,
    storeSlug: `main-${locale}-${runId}`,
    preferredLocale: locale,
  });
  const tenantId = str(on, 'tenantId');
  c.business = str(on, 'businessId');
  const main = (await warehousesOf(c))[0];
  if (main === undefined) throw new Error('onboarding created no warehouse');
  const second = str(await c.call('POST', '/v1/businesses/current/warehouses', { name: n.second, branchId: main.branchId }), 'id');

  const accounts = await c.call('GET', `/v1/businesses/${c.business}/accounting/accounts`);
  const account = (key: string): string => {
    const found = list(accounts, 'items').find((a) => field(a, 'systemKey') === key);
    if (found === undefined) throw new Error(`no ${key} account`);
    return str(found, 'accountId');
  };
  await c.call('POST', '/v1/payment-methods', {
    paymentMethodId: randomUUID(),
    systemType: 'cash',
    postingAccountId: account('cash'),
    requiresReference: false,
    sortOrder: 10,
    names: { ar: NAMES.ar.cash, en: NAMES.en.cash, tr: NAMES.tr.cash },
  });

  const rice = await trackedProduct(c, PRODUCT_TEXT.rice, 4500, 'piece');
  const oil = await trackedProduct(c, PRODUCT_TEXT.oil, 3800, 'piece');
  const sugar = await trackedProduct(c, PRODUCT_TEXT.sugar, 600, 'kg');
  const tea = await trackedProduct(c, PRODUCT_TEXT.tea, 1200, 'box');

  await c.call('POST', '/v1/inventory/openings', {
    openingId: randomUUID(),
    occurredOn: daysAgo(10),
    lines: [
      { productId: rice, warehouseId: main.id, quantity: '60', unitCost: '3000' },
      { productId: oil, warehouseId: main.id, quantity: '40', unitCost: '2650' },
      { productId: sugar, warehouseId: main.id, quantity: '120.5', unitCost: '320' },
      { productId: tea, warehouseId: main.id, quantity: '30', unitCost: '700' },
      { productId: rice, warehouseId: second, quantity: '6', unitCost: '3000' },
    ],
  });

  const supplierA = randomUUID();
  await c.call('POST', '/v1/suppliers', { supplierId: supplierA, name: n.supplierA, phone: '+970599123456' });
  const supplierB = randomUUID();
  await c.call('POST', '/v1/suppliers', { supplierId: supplierB, name: n.supplierB });

  const received = async (
    supplierId: string,
    date: string,
    lines: { productId: string; quantity: string; unitPrice: string }[],
    reference: string,
  ): Promise<string> => {
    const id = randomUUID();
    const draft = await c.call('PUT', `/v1/purchases/${id}`, {
      expectedRevision: 0,
      supplierId,
      warehouseId: main.id,
      currency: market.currency,
      documentDate: date,
      supplierReference: reference,
      lines: lines.map((l) => ({ lineId: randomUUID(), ...l })),
    });
    const revision = field(draft, 'draftRevision');
    await c.call('POST', `/v1/purchases/${id}/receive`, { draftRevision: typeof revision === 'number' ? revision : 1 });
    return id;
  };
  await received(
    supplierA,
    daysAgo(7),
    [
      { productId: rice, quantity: '20', unitPrice: '31' },
      { productId: oil, quantity: '10', unitPrice: '27' },
    ],
    'INV-2041',
  );
  await received(supplierA, daysAgo(4), [{ productId: sugar, quantity: '50', unitPrice: '3.4' }], 'INV-2077');
  await received(supplierA, daysAgo(2), [{ productId: tea, quantity: '12', unitPrice: '7.25' }], 'INV-2090');
  await received(supplierB, daysAgo(3), [{ productId: oil, quantity: '6', unitPrice: '28' }], 'QT-118');
  const undoReference: Record<string, string> = {};
  for (const v of viewports) {
    const ref = `UR-${comboTag(locale, v)}`;
    await received(supplierB, daysAgo(1), [{ productId: sugar, quantity: '5', unitPrice: '3.5' }], ref);
    undoReference[v.name] = ref;
  }
  const draftId = randomUUID();
  await c.call('PUT', `/v1/purchases/${draftId}`, {
    expectedRevision: 0,
    supplierId: supplierB,
    warehouseId: main.id,
    currency: market.currency,
    documentDate: daysAgo(0),
    supplierReference: 'DR-1',
    lines: [{ lineId: randomUUID(), productId: rice, quantity: '5', unitPrice: '30' }],
  });
  await c.call('POST', '/v1/inventory/stocktakes', { stocktakeId: randomUUID(), warehouseId: second });
  const mainBusiness = c.business;

  const starter: Record<string, StarterBusiness> = {};
  for (const v of viewports) {
    c.business = null;
    const name = `${n.business} ${v.name}`;
    const created = await c.call('POST', `/v1/tenants/${tenantId}/businesses`, {
      businessName: name,
      countryCode: market.country,
      baseCurrency: market.currency,
      storeSlug: `starter-${locale}-${v.name}-${runId}`,
      preferredLocale: locale,
    });
    c.business = str(created, 'businessId');
    await trackedProduct(c, PRODUCT_TEXT.honey, 2000, 'piece');
    starter[v.name] = { businessId: c.business, name };
  }

  return {
    locale,
    email,
    password,
    currency: market.currency,
    businessId: mainBusiness,
    mainWarehouse: main.name,
    secondWarehouse: n.second,
    supplierA,
    supplierB,
    returnReference: 'INV-2041',
    draftId,
    undoReference,
    starter,
  };
}
