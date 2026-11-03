/**
 * The `invpl/1` builder for `sale.commit` — P4-S2 (docs/PHASE_4_S2_CONTRACT.md
 * A-05, A-06, A-08; lock P4-AL-16, P4-AL-18, P4-AL-25, P4-AL-28, P4-AL-30,
 * P4-AL-44).
 *
 * It takes exactly the arguments the service passes to the sale commit
 * routine, in fixed point and in routine order, following the accepted
 * `purchase-payloads.ts` conventions without variation:
 *
 * - quantities are Q4 (qty x 10^4);
 * - a unit price is the C10 of a txn MINOR unit (price x 10^(e+10));
 * - money is integer minor units — txn for the sale's own currency, base for
 *   the shares;
 * - a currency is bound as its lowercase ISO code, a date as the integer
 *   `YYYYMMDD`, a rate as R10 (rate x 10^10) and a rate instant as epoch
 *   seconds;
 * - free text as its eight SHA-256 words.
 *
 * Two properties of this builder are load-bearing and are tested as such.
 *
 * **It reads no clock.** `[[daftar-a-command-must-not-read-the-clock]]`.
 * `documentDate` and `dueDate` are required arguments and there is no
 * `?? today()` anywhere in this file, in the schema, in the service, in the
 * engine or in the trusted database command. The same retry sent either side
 * of local midnight is the same command forever, and a financial command whose
 * fingerprint covers a server-resolved date is not idempotent at all.
 *
 * **The intent is the CLIENT's request and nothing else.** `saleCommitIntentSha256`
 * is computable from the request alone, BEFORE any catalogue price, FX rate or
 * stock level is read — which is what lets the commit path consult the
 * idempotency proof before it reads current state
 * (`[[daftar-registry-before-state]]`). A fingerprint that covered the
 * resolved price would turn every price change into a false conflict, and one
 * that covered the server's date would answer "success" to a command it had
 * never seen.
 *
 * It refuses what the database could never accept, so no assertion is minted
 * for a command that cannot succeed, and the database refuses all of it again.
 */
import { InventoryError } from './errors';
import { MAX_DOCUMENT_LINES, yyyymmdd, type MovementPayload } from './movement-payloads';
import { buildInventoryPayload, CANONICAL_UUID_RE, inventoryIntentSha256, type InventoryPayloadField } from './payload';
import { currencyCode } from './purchase-payloads';
import { documentTextWords } from './supplier-payloads';

/** The most lines one sale may carry: the document bound, not a new number. */
export const MAX_SALE_PAYLOAD_LINES = MAX_DOCUMENT_LINES;

/** Free-text bounds the package holds a sale to, in characters after trimming. */
export const SALE_PAYLOAD_TEXT_MAX = Object.freeze({ notes: 1000 });

function refuse(message: string): never {
  throw new InventoryError('inventory.payload_invalid', message);
}

const uuid = (value: string, what: string): InventoryPayloadField => {
  if (typeof value !== 'string' || !CANONICAL_UUID_RE.test(value)) refuse(`${what} is not a canonical lowercase uuid`);
  return { kind: 'uuid', value };
};
const uuidOrNull = (value: string | null, what: string): InventoryPayloadField => (value === null ? { kind: 'null' } : uuid(value, what));
const int = (value: bigint): InventoryPayloadField => ({ kind: 'integer', value });
const intOrNull = (value: bigint | null): InventoryPayloadField => (value === null ? { kind: 'null' } : int(value));

function assertBigint(v: unknown, what: string): asserts v is bigint {
  if (typeof v !== 'bigint') refuse(`${what} must be an integer`);
}

/** The notes as eight words, or eight NULLs. */
const notesWords = (notes: string | null): InventoryPayloadField[] =>
  documentTextWords(notes, 'notes', { min: 1, max: SALE_PAYLOAD_TEXT_MAX.notes }).map((w) => intOrNull(w));

/** `YYYY-MM-DD` as the integer `YYYYMMDD`, or NULL. */
const dateOrNull = (date: string | null): InventoryPayloadField => (date === null ? { kind: 'null' } : int(yyyymmdd(date)));

/** R10 of a rate of exactly 1: the domestic snapshot. */
export const SALE_DOMESTIC_RATE_R10 = 10n ** 10n;

/** The FX snapshot the sale binds, in the payload's fixed-point form. */
export interface SaleRateSnapshot {
  /** The registry row, or null when the sale is in the base currency. */
  readonly rateId: string | null;
  /** rate x 10^10. Exactly 10^10 when domestic. */
  readonly rateR10: bigint;
  readonly source: 'base' | 'manual';
  readonly rateAtEpochSeconds: bigint;
}

/** One committed sale line, with every server-resolved figure already bound. */
export interface SaleCommitPayloadLine {
  /** The CLIENT's line id: the `sale_items.id`, the movement's `source_line_id` and the bridge row's. */
  readonly lineId: string;
  /** The product the CLIENT named. */
  readonly productId: string;
  /** The merchant variant the CLIENT named, or null for a simple product (P3-AL-52). */
  readonly merchantVariantId: string | null;
  /** The stock key the SERVER resolved: the base variant for a simple product. */
  readonly variantId: string;
  readonly qtyQ4: bigint;
  /** The client's discount REQUEST, in txn minor units, `>= 0`. */
  readonly discountMinor: bigint;
  /** The C10 of a txn minor unit: the price the SERVER resolved from the catalogue. */
  readonly unitPriceC10: bigint;
  /** `gross - discount + 0` in txn minor units, computed by the server. */
  readonly netTxnMinor: bigint;
  /** This line's exact integer share of the base total. */
  readonly baseShareMinor: bigint;
}

/** What the request itself states — the whole of the sale's intent. */
export interface SaleCommitIntentInput {
  readonly tenantId: string;
  readonly businessId: string;
  readonly saleId: string;
  /** A stated fact: `credit` debits AR, `cash` debits the cash account directly. */
  readonly settlementMode: 'credit' | 'cash';
  /** NULL is a walk-in, admissible only for a `cash` sale. */
  readonly customerId: string | null;
  readonly warehouseId: string;
  /** `YYYY-MM-DD`. REQUIRED. */
  readonly documentDate: string;
  /** `YYYY-MM-DD` or null. REQUIRED as a field; null means due on issue. */
  readonly dueDate: string | null;
  /** Always 0 while P4-AL-44 holds; stated by the client, never defaulted. */
  readonly taxMinor: bigint;
  readonly notes: string | null;
  readonly lines: readonly SaleCommitIntentLine[];
}

/** The client's half of one line. */
export interface SaleCommitIntentLine {
  readonly lineId: string;
  /** The product the client named. */
  readonly productId: string;
  /**
   * The merchant variant the client named, or null for a product that has
   * none. The hidden base variant never leaves the server (P3-AL-52), so the
   * resolved stock key is NOT part of the intent: it is derived, and a
   * fingerprint covering it could not be computed before the catalogue read.
   */
  readonly merchantVariantId: string | null;
  readonly qtyQ4: bigint;
  readonly discountMinor: bigint;
}

export interface SaleCommitPayloadInput extends SaleCommitIntentInput {
  /** The warehouse's home branch, resolved by the server. */
  readonly branchId: string;
  /** The invoice the commit will write. Minted by the server; in the payload, NOT in the intent. */
  readonly invoiceId: string;
  /** Uppercase ISO code, resolved by the server. */
  readonly currency: string;
  readonly rate: SaleRateSnapshot;
  readonly subtotalTxnMinor: bigint;
  readonly discountTxnMinor: bigint;
  readonly totalTxnMinor: bigint;
  readonly totalBaseMinor: bigint;
  readonly lines: readonly SaleCommitPayloadLine[];
}

/**
 * The lines' shared shape checks. One line per variant AND one line per id:
 * `sale_items` carries `UNIQUE (business_id, sale_id, id)` for the bridge's
 * line FK (P4-AL-29b) and the stock writer's five-part identity
 * (`0059:147`) refuses a second movement on one source line, so a duplicated
 * variant inside one sale would be refused by the ledger after the sale row
 * had been written — which is a transaction that can only roll back. It is
 * refused here instead, with a code the merchant can act on.
 */
function assertLines(ids: readonly string[], identities: readonly string[]): void {
  if (ids.length === 0) throw new InventoryError('inventory.lines_required', 'a sale needs at least one line');
  if (ids.length > MAX_SALE_PAYLOAD_LINES) refuse(`a sale has at most ${MAX_SALE_PAYLOAD_LINES} lines`);
  if (new Set(ids).size !== ids.length || new Set(identities).size !== identities.length) {
    throw new InventoryError('inventory.duplicate_line', 'a sale has one line per variant, each with its own id');
  }
}

/** The shared per-line intent checks, run by both the intent digest and the payload. */
function assertIntentLines(lines: readonly SaleCommitIntentLine[]): void {
  assertLines(
    lines.map((l) => l.lineId),
    // The STATED identity is what is checked for duplication, because it is
    // all the client said; two lines that resolve to one stock key are two
    // lines on one product and variant and are caught by the same check.
    lines.map((l) => `${l.productId}:${l.merchantVariantId ?? ''}`),
  );
  for (const [i, l] of lines.entries()) {
    const what = `line ${i + 1}`;
    uuid(l.productId, `${what} product_id`);
    uuidOrNull(l.merchantVariantId, `${what} variant_id`);
    assertBigint(l.qtyQ4, `${what} quantity`);
    assertBigint(l.discountMinor, `${what} discount`);
    // A sale takes stock OUT, so the request states a POSITIVE quantity and
    // the movement's negative sign is the routine's, never the client's: a
    // client that could state the sign could state an inbound movement under
    // a sale's authority.
    if (l.qtyQ4 <= 0n) refuse(`${what} quantity must be positive`);
    if (l.discountMinor < 0n) refuse(`${what} discount must not be negative`);
  }
}

/**
 * The idempotency proof the `sales` row stores, computable from the REQUEST
 * ALONE: `sale_id`, `customer_id`, `warehouse_id`, `document_date`,
 * `due_date`, `tax_minor`, the notes words, `line_count` and per line the
 * line's id, the product and merchant variant it named, its quantity and its
 * requested discount.
 *
 * It is the first thing the commit path computes and the thing it compares
 * before it reads any state. A replay carrying this sale's id and a DIFFERENT
 * digest is a different command and is refused; one carrying the same digest
 * is answered from the stored rows, having changed nothing.
 */
export function saleCommitIntentSha256(input: SaleCommitIntentInput): string {
  assertIntentLines(input.lines);
  if (input.settlementMode !== 'credit' && input.settlementMode !== 'cash') refuse('a settlement mode is credit or cash');
  // A receivable owed by nobody is not representable: the row CHECK and
  // `invoices_walkin_no_ar`'s deferred trigger both refuse it, so no
  // assertion is minted for a command that can only roll back.
  if (input.settlementMode === 'credit' && input.customerId === null) {
    refuse('a credit sale names the customer who owes it');
  }
  // A due date with nobody to owe it: the `invoices_walkin_terms_ck` mirror.
  if (input.dueDate !== null && (input.customerId === null || input.settlementMode !== 'credit')) {
    refuse('a due date belongs to a credit sale with a named customer');
  }
  assertBigint(input.taxMinor, 'tax');
  // P4-AL-44 / OD-03: the tax boundary, refused in the payload builder as
  // well as in the schema and the database, so no assertion is ever minted
  // for a sale the `CHECK (tax_minor = 0)` would refuse at the last moment.
  if (input.taxMinor !== 0n) throw new InventoryError('sale.tax_policy_absent', 'sales tax is structurally zero in this release');
  const fields: InventoryPayloadField[] = [
    uuid(input.saleId, 'sale_id'),
    { kind: 'code', value: input.settlementMode },
    uuidOrNull(input.customerId, 'customer_id'),
    uuid(input.warehouseId, 'warehouse_id'),
    int(yyyymmdd(input.documentDate)),
    dateOrNull(input.dueDate),
    int(input.taxMinor),
    ...notesWords(input.notes),
    int(BigInt(input.lines.length)),
  ];
  for (const l of input.lines) {
    fields.push(uuid(l.lineId, 'line_id'), uuid(l.productId, 'product_id'), uuidOrNull(l.merchantVariantId, 'variant_id'), int(l.qtyQ4), int(l.discountMinor));
  }
  return inventoryIntentSha256('sale.commit', input.tenantId, input.businessId, fields);
}

/**
 * `sale.commit`: sale_id, customer_id, warehouse_id, branch_id, invoice_id,
 * document_date, due_date, currency, rate_id, rate_r10, rate_source, rate_at,
 * subtotal_txn_minor, discount_txn_minor, tax_minor, total_txn_minor,
 * total_base_minor, notes words, line_count, then per line (line_id,
 * product_id, merchant_variant_id, variant_id, qty_q4, discount_minor,
 * unit_price_c10, net_txn_minor, base_share_minor).
 *
 * The arithmetic the builder re-checks, so that an assertion is never minted
 * over figures the database would refuse:
 *
 * - `total = subtotal - discount + tax`, the `sales_total_ck` identity;
 * - `discount <= subtotal`, the `sales_discount_ck` identity;
 * - `total > 0`, because `invoices.total_txn_minor` is `CHECK (BETWEEN 1 AND
 *   10^18)` (`0075:260`) and an invoice of zero is not representable — so a
 *   sale discounted to nothing is refused here rather than at the invoice
 *   insert, where the only possible outcome is a rolled-back transaction;
 * - `Sigma base_share = total_base_minor` EXACTLY, the `0043` per-line law: the
 *   shares are an exact integer partition of the one conversion, never eight
 *   separate conversions, and never a rounding account
 *   (`[[daftar-rounding-is-not-additive]]`);
 * - the rate's shape: a domestic snapshot has no registry row and a rate of
 *   exactly 1; a foreign one has both.
 *
 * It re-checks NO cost and NO value, because it is given none: the COGS the
 * sale posts is the sum of the `value_delta_base_minor` integers the stock
 * writer computes from the locked level row, and nothing upstream of the lock
 * may predict it (P4-AL-25).
 */
export function saleCommitPayload(input: SaleCommitPayloadInput): MovementPayload {
  const intentSha256 = saleCommitIntentSha256(input);
  const r = input.rate;
  assertBigint(r.rateR10, 'rate_r10');
  assertBigint(r.rateAtEpochSeconds, 'rate_at');
  if (r.source !== 'base' && r.source !== 'manual') refuse('a rate source is base or manual');
  if ((r.source === 'base') !== (r.rateId === null)) refuse('a domestic snapshot has no registry row, and a foreign one has one');
  if (r.source === 'base' ? r.rateR10 !== SALE_DOMESTIC_RATE_R10 : r.rateR10 <= 0n) refuse('a rate must be positive, and exactly 1 when domestic');

  for (const [v, name] of [
    [input.subtotalTxnMinor, 'subtotal'],
    [input.discountTxnMinor, 'discount'],
    [input.totalTxnMinor, 'total'],
    [input.totalBaseMinor, 'base total'],
  ] as const) {
    assertBigint(v, name);
    if (v < 0n) refuse(`the ${name} must not be negative`);
  }
  if (input.discountTxnMinor > input.subtotalTxnMinor) refuse('the discount must not exceed the subtotal');
  if (input.totalTxnMinor !== input.subtotalTxnMinor - input.discountTxnMinor + input.taxMinor) {
    refuse('the total must be the subtotal less the discount plus the tax, exactly');
  }
  if (input.totalTxnMinor <= 0n || input.totalBaseMinor <= 0n) throw new InventoryError('sale.total_zero', 'a sale total must be positive');

  let shares = 0n;
  let nets = 0n;
  for (const [i, l] of input.lines.entries()) {
    const what = `line ${i + 1}`;
    for (const [v, name] of [
      [l.unitPriceC10, 'unit price'],
      [l.netTxnMinor, 'net'],
      [l.baseShareMinor, 'base share'],
    ] as const) {
      assertBigint(v, `${what} ${name}`);
      if (v < 0n) refuse(`${what} ${name} must not be negative`);
    }
    shares += l.baseShareMinor;
    nets += l.netTxnMinor;
  }
  if (shares !== input.totalBaseMinor) refuse('the base shares must add up to the base total exactly');
  if (nets !== input.subtotalTxnMinor - input.discountTxnMinor) refuse('the line nets must add up to the discounted subtotal exactly');

  const fields: InventoryPayloadField[] = [
    uuid(input.saleId, 'sale_id'),
    { kind: 'code', value: input.settlementMode },
    uuidOrNull(input.customerId, 'customer_id'),
    uuid(input.warehouseId, 'warehouse_id'),
    uuid(input.branchId, 'branch_id'),
    uuid(input.invoiceId, 'invoice_id'),
    int(yyyymmdd(input.documentDate)),
    dateOrNull(input.dueDate),
    { kind: 'code', value: currencyCode(input.currency) },
    uuidOrNull(r.rateId, 'rate_id'),
    int(r.rateR10),
    { kind: 'code', value: r.source },
    int(r.rateAtEpochSeconds),
    int(input.subtotalTxnMinor),
    int(input.discountTxnMinor),
    int(input.taxMinor),
    int(input.totalTxnMinor),
    int(input.totalBaseMinor),
    ...notesWords(input.notes),
    int(BigInt(input.lines.length)),
  ];
  for (const l of input.lines) {
    fields.push(
      uuid(l.lineId, 'line_id'),
      uuid(l.productId, 'product_id'),
      uuidOrNull(l.merchantVariantId, 'variant_id'),
      uuid(l.variantId, 'variant_id'),
      int(l.qtyQ4),
      int(l.discountMinor),
      int(l.unitPriceC10),
      int(l.netTxnMinor),
      int(l.baseShareMinor),
    );
  }
  const payload = buildInventoryPayload('sale.commit', input.tenantId, input.businessId, fields);
  return { payload, intentSha256 };
}
