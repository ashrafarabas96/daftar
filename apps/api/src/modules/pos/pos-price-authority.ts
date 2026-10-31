import { SALE_FORBIDDEN_REQUEST_FIELDS } from '@daftar/domain-core';
import { posRefusal } from './pos-errors';

/**
 * ══════════════════════════════════════════════════════════════════════════
 * THE TRUST BOUNDARY OF P4-S3. The central claim of the slice.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * «The client sends identities, quantities and a discount request, and NOTHING
 * else is believed.» (lock P4-AL-18; execution plan §P4-S3; `OD-P4-02` OPTION
 * A — discount only.)
 *
 * ## Why this is a module and not a `.strict()` schema
 *
 * `.strict()` alone is most of the protection and none of the evidence. A
 * strict Zod object refuses an unknown key, but it refuses `lineTotalMinor`
 * and `lniTotalMinor` with the same `unrecognized_keys` issue and the same
 * generic `VALIDATION_FAILED` body, so a suite asserting that a forged total
 * was refused cannot tell the difference between the law holding and a typo
 * being caught. P4-S3's gate has to assert the law BY NAME
 * (`[[a-gate-that-checks-filenames-is-not-a-gate]]`), so the refusal needs its
 * own registered code — `pos.cart_price_authority_refused` — and that needs a
 * classifier that runs BEFORE the schema.
 *
 * The order is therefore: authority scan, then schema. `CartCommandPipe`
 * composes exactly those two in exactly that order, as one object, so the
 * ordering cannot be reconfigured wrongly at a decorator.
 *
 * ## Allowlist first, classification second
 *
 * The accepted key set of a cart command is tiny and enumerated, so the scan
 * is an ALLOWLIST and not a blocklist: every key that is not accepted is
 * refused, and only then is it classified into the two codes. That ordering is
 * what makes the law total. A blocklist of forged names would be exactly as
 * long as somebody's imagination, and `discountMinor` — a permitted field
 * whose name is in the money vocabulary — proves the direction matters: it is
 * accepted because it is on the allowlist, never because a pattern spared it.
 *
 * Classification then answers WHICH refusal:
 *
 * - a name in `POS_CART_FORGED_FIELDS`, or matching one of
 *   `PRICE_AUTHORITY_PATTERNS`, is a figure the server derives →
 *   `pos.cart_price_authority_refused`;
 * - anything else → `pos.cart_field_unknown`.
 *
 * The patterns exist so the law covers a name NOBODY LISTED. A table of exact
 * names is a record of the attacks already thought of; `/total/i` covers
 * `cartTotalMinor`, `grandTotal`, `totalDue` and the one the next client
 * invents. The table is kept beside it because a pattern says nothing about
 * what the server derives the figure FROM, and that sentence is the only
 * documentation a reviewer can check.
 *
 * ## The value is never touched
 *
 * Nothing in this file reads, parses, compares, rounds or logs the VALUE of a
 * refused field. P4-AL-18: validating a client's figure «implies the client's
 * number could be adopted». The refusal carries the field's NAME and its PATH
 * so a client developer can fix their payload, and nothing else — a `details`
 * carrying `{ sent: 4999, server: 5000 }` would be a calibration oracle, and
 * an attacker with one does not need to guess twice.
 */

// ─────────────────────────────────────────────────────────────────────────
// 1. The forged-field table
// ─────────────────────────────────────────────────────────────────────────

/**
 * Every name a cart request must never carry, with WHAT THE SERVER DERIVES IT
 * FROM. The sentence is the point: a reviewer can check each row against the
 * code that does the deriving, which a bare list of strings does not permit.
 *
 * The table is a SUPERSET of the accepted `SALE_FORBIDDEN_REQUEST_FIELDS`
 * (`packages/domain-core/src/sale.ts:246`) — asserted, not assumed, by
 * `tests/guards/pos-s3-cart-law.test.ts`. The cart is the step before the
 * sale, so a name the sale refuses cannot become askable one layer earlier;
 * and the cart adds the names only a basket has (`lineTotalMinor`,
 * `cartTotalMinor`, `lineCount`).
 */
export const POS_CART_FORGED_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  // ── The four figures the brief names explicitly ───────────────────────
  lineTotalMinor: 'the line total is HALF_EVEN(quantity x catalogue price) less the discount, computed once per line',
  cartTotalMinor: 'the cart total is the exact integer sum of the line totals — no second rounding',
  unitPriceMinor: "the unit price is the catalogue's `products.base_price_minor` for this business",
  taxMinor: 'tax is structurally zero (P4-AL-44, OD-03 OPEN); there is no rate for a client to state',

  // ── Their spellings and their neighbours ─────────────────────────────
  unitPrice: "the unit price is the catalogue's, in the product's own price currency",
  price: 'the price is the catalogue price; `OD-P4-02` OPTION A permits no override',
  priceMinor: 'the price is the catalogue price',
  priceOverride: '`OD-P4-02` is RULED OPTION A — an override is not representable, not merely refused',
  overridePriceMinor: '`OD-P4-02` is RULED OPTION A — an override is not representable',
  lineTotal: 'the line total is derived per line',
  cartTotal: 'the cart total is the exact sum of derived line totals',
  grandTotal: 'there is one total and the server owns it',
  totalMinor: 'every total is derived',
  totalTxnMinor: 'the transaction-currency total is derived',
  totalBaseMinor: 'the base-currency total is one conversion of the derived transaction total',
  baseShareMinor: "a line's base share is derived from the document's one conversion",
  subtotal: 'the subtotal is the sum of derived line grosses',
  subtotalMinor: 'the subtotal is the sum of derived line grosses',
  grossMinor: 'the line gross is HALF_EVEN(quantity x catalogue price)',
  netMinor: 'the line net is the derived gross less the requested discount',
  amountMinor: 'every amount on a cart line is derived',
  tax: 'tax is structurally zero; there is no rate, exemption or threshold to state',
  taxRate: 'OD-03 is OPEN: no jurisdiction rate exists for a client to send',
  taxExempt: 'OD-03 is OPEN: exemption is not modelled',
  discountPercent: 'a discount is an integer count of minor units, not a percentage the server must round',
  discountRate: 'a discount is an integer count of minor units',

  // ── Cost and value (P4-AL-25): never an input, never a column ────────
  cogsMinor: "the cost of goods sold is the stock writer's own stored integer",
  unitCostMinor: 'unit cost is the moving average the stock writer holds',
  valueDeltaMinor: "the value delta is the stock writer's",
  averageCost: "the moving average is the stock writer's",

  // ── FX (P4-AL-19): the snapshot is read from the registry ────────────
  currency: "the currency is the product's own price currency, and a mixed basket is refused",
  currencyCode: "the currency is the product's own price currency",
  fxRate: 'the rate is the registry snapshot the document is posted at',
  rate: 'the rate is the registry snapshot',
  rateId: 'the rate row is resolved by the server',
  rateSource: 'the rate source is the registry',
  rateTimestamp: 'the rate instant is the registry snapshot',

  // ── Scope and authority (P4-AL-35, P4-AL-40) ─────────────────────────
  branchId: "the branch is the warehouse's immutable home branch, and scope is RLS",
  tenantId: 'the tenant comes from the authenticated membership, never the body',
  businessId: 'the business comes from the authenticated membership, never the body',
  actorUserId: 'the actor is the authenticated principal',
  permission: "authority is the actor's granted permission set, not a claim in a payload",
  roles: "authority is the actor's granted role set",

  // ── Stock truth (P4-AL-05): no stored available or reserved quantity ─
  onHand: 'on-hand is the level row, read under its own lock',
  availableQuantity: 'there is no stored available quantity anywhere (P4-AL-05)',
  reservedQuantity: 'there is no stored reserved quantity anywhere (P4-AL-05); a cart reserves nothing',

  // ── Derived settlement truth (P4-AL-06) ──────────────────────────────
  paidMinor: 'a paid total is derived, never stored and never stated',
  outstandingMinor: 'an outstanding total is derived, never stored and never stated',
  settlementState: 'a settlement state is derived from the allocations',
  invoiceStatus: 'a document status is a lifecycle fact the server transitions',
  paymentId: 'P4-S3 owns no payment: a cart cannot name one',
  allocationId: 'P4-S3 owns no allocation: a cart cannot name one',

  // ── The anti-patterns ────────────────────────────────────────────────
  idempotencyKey: "P4-AL-30: the document's own UUID is the key, plus a stored intent digest",
  allowOversell: '`OD-P4-05` OPTION A: oversell is unrepresentable, not a flag',
  allowNegativeStock: '`OD-P4-05` OPTION A: oversell is unrepresentable, not a flag',
  force: 'there is no override flag anywhere in Phase 4',
  skipValidation: 'there is no bypass anywhere in Phase 4',
  // The obvious spelling of this one — the PostgreSQL role attribute's own
  // name — is deliberately ABSENT, and the reason is worth a line:
  // `scripts/static-guards.ts` rule 5 (`no-generic-rls-bypass`) refuses that
  // token, case-insensitively, anywhere under `apps/api/src` outside the
  // provisioner boundary. It is RIGHT to be blunt about it, because a grep
  // that exempted "but it is only a string in a table" is a grep somebody
  // eventually routes a real bypass through — and it is blunt enough to have
  // caught the EXPLANATION of the omission on this suite's first run, which is
  // why this comment does not name the token either. The CONCEPT is covered by
  // the two spellings below, and a client that sends the forbidden spelling is
  // refused `pos.cart_field_unknown` regardless: still a refusal, still a 400,
  // still never silently ignored.
  bypassIsolation: 'isolation is row level security and no payload reaches it',
  disableRowSecurity: 'isolation is row level security and no payload reaches it',
  now: '`[[daftar-a-command-must-not-read-the-clock]]`: a date is supplied where one is needed, never defaulted',
  timestamp: 'a cart line carries no instant a client could state',
  issuedAt: "a document instant is the server's",

  // ── Names only a BASKET has ──────────────────────────────────────────
  lineCount: 'the line count is a property of the stored lines',
  lines: 'a cart is mutated one line at a time; a whole basket posted at once is the forged-totals attack with no attacker required (P4-AL-18)',
  cartVersion: 'the cart has no client-owned revision; concurrency is resolved at the row',
  revision: 'a revision the server owns is not a field a client states on a cart line',
});

/** The forged names, as a list — the table a security suite iterates. */
export const POS_CART_FORGED_FIELD_NAMES: readonly string[] = Object.freeze(Object.keys(POS_CART_FORGED_FIELDS));

/**
 * The structural half of the law: a name NOBODY LISTED that is still a figure
 * the server derives.
 *
 * Each pattern is anchored on a word rather than a substring where the
 * substring would be ambiguous, and all of them are applied ONLY to keys the
 * allowlist has already refused — so a permitted field is never judged by a
 * pattern and `discountMinor` is accepted on its own merits.
 */
export const PRICE_AUTHORITY_PATTERNS: readonly RegExp[] = Object.freeze([
  /total/i,
  /subtotal/i,
  /price/i,
  /(^|[^a-z])tax/i,
  /cost/i,
  /cogs/i,
  /amount/i,
  /gross/i,
  /(^|[a-z])net(_|[A-Z]|$)/,
  /(^|[^a-z])rate/i,
  /currenc/i,
  /balance/i,
  /paid/i,
  /outstanding/i,
  /reserved/i,
  /available/i,
  /margin/i,
  /profit/i,
  /^minor|minor$/i,
]);

/** True iff `key` names a figure the server derives — by the table, or by the structural patterns. */
export function isPriceAuthorityField(key: string): boolean {
  if (Object.hasOwn(POS_CART_FORGED_FIELDS, key)) return true;
  return PRICE_AUTHORITY_PATTERNS.some((p) => p.test(key));
}

// ─────────────────────────────────────────────────────────────────────────
// 2. The allowlist: what a client MAY state, per command
// ─────────────────────────────────────────────────────────────────────────

/**
 * The accepted keys of each cart command, at each nesting level.
 *
 * Read the four rows together and the slice's whole trust boundary is visible
 * on one screen: an IDENTITY (`tillSessionId`, `cartLineId`, `productId`,
 * `variantId`), a QUANTITY, and a DISCOUNT REQUEST. Eight names in total, and
 * five of them are uuids.
 *
 * There is no `price`, no `total`, no `tax`, no `currency`, no `branchId` and
 * no `businessId` on any row — those are resolved — and there is no whole-cart
 * command at all, because a basket posted in one body is the attack P4-AL-18
 * describes.
 */
export const POS_CART_COMMAND_FIELDS: Readonly<Record<PosCartCommand, readonly string[]>> = Object.freeze({
  'cart.add_line': Object.freeze(['productId', 'variantId', 'quantity']),
  'cart.change_quantity': Object.freeze(['quantity']),
  'cart.remove_line': Object.freeze([]),
  'cart.request_discount': Object.freeze(['discountMinor']),
});

/** The four cart commands. A fifth would be a new row above and a new route, never a flag on one of these. */
export type PosCartCommand = 'cart.add_line' | 'cart.change_quantity' | 'cart.remove_line' | 'cart.request_discount';

export const POS_CART_COMMANDS: readonly PosCartCommand[] = Object.freeze([
  'cart.add_line',
  'cart.change_quantity',
  'cart.remove_line',
  'cart.request_discount',
]);

/**
 * The session and the line are PATH parameters, never body fields. A body that
 * carries one is refused like any other unknown key: a command whose target
 * can be stated in two places has two answers to "which line", and the one in
 * the body is the one nobody authorized.
 *
 * `tillSessionId` is listed beside `sessionId` although the routes spell the
 * segment `:sessionId` (the till-session surface's spelling, kept so one POS
 * module has one name for one thing). A client that guessed the other spelling
 * must be refused too: a name that is neither accepted nor refused is a name
 * that is SILENTLY IGNORED, which is the failure mode this whole module exists
 * to rule out.
 */
export const POS_CART_PATH_ONLY_FIELDS: readonly string[] = Object.freeze(['sessionId', 'tillSessionId', 'cartLineId']);

// ─────────────────────────────────────────────────────────────────────────
// 3. The scan
// ─────────────────────────────────────────────────────────────────────────

/** How deep a cart body may nest. A cart command's body is flat; this is a bound, not a feature. */
const MAX_BODY_DEPTH = 4;

/**
 * Refuse `body` if it names anything the server derives, or anything at all
 * that this command does not accept.
 *
 * Runs BEFORE the schema, so the refusal is the authority law's own code and
 * not a generic unknown-key issue. Recursive, because a forged total hidden
 * inside a nested object is the same attack with one more brace, and
 * array-aware for the same reason.
 *
 * A non-object body is left alone: that is a SHAPE problem and the schema
 * states the shape. This function has exactly one job.
 */
export function assertNoClientPriceAuthority(command: PosCartCommand, body: unknown): void {
  const accepted = new Set([...POS_CART_COMMAND_FIELDS[command]]);
  walk(body, accepted, [], 0);
}

function walk(node: unknown, accepted: ReadonlySet<string>, path: readonly string[], depth: number): void {
  if (node === null || typeof node !== 'object') return;
  if (depth > MAX_BODY_DEPTH) {
    // Not a price question, but it is this function's refusal to make: a body
    // deeper than any cart command has is not a cart command.
    throw posRefusal('pos.cart_field_unknown', { path: path.join('.') });
  }
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) walk(item, accepted, [...path, String(i)], depth + 1);
    return;
  }
  for (const key of Object.keys(node)) {
    // At the top level the command's own accepted names are permitted. Below
    // it nothing is: no cart command has a nested accepted object, so every
    // key inside one is unknown by construction.
    const permitted = depth === 0 && accepted.has(key);
    if (!permitted) {
      const where = [...path, key].join('.');
      throw isPriceAuthorityField(key)
        ? // The NAME and the PATH. Never the value: a `details` carrying the
          // client's figure beside the server's is a calibration oracle.
          posRefusal('pos.cart_price_authority_refused', { field: key, path: where })
        : posRefusal('pos.cart_field_unknown', { field: key, path: where });
    }
    walk((node as Record<string, unknown>)[key], accepted, [...path, key], depth + 1);
  }
}

/**
 * The accepted sale vocabulary this table is held to be a superset of —
 * re-exported so the guard suite reads it from one place and a rename in
 * `domain-core` fails here rather than drifting silently.
 */
export const INHERITED_SALE_FORBIDDEN_FIELDS: readonly string[] = SALE_FORBIDDEN_REQUEST_FIELDS;
