import { CART_LINE_COLUMNS, POS_CART_LINES, POS_TILL_SESSIONS, TILL_SESSION_COLUMNS, TILL_SESSION_STATES } from './pos-session-contract';
import type { PosCartCommand } from './pos-price-authority';

/**
 * ══════════════════════════════════════════════════════════════════════════
 * THE CART'S STATEMENT COUNT IS CONSTANT IN THE LINE COUNT.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * A cart with one line and a cart with fifty lines issue the SAME NUMBER OF
 * STATEMENTS for the same operation (execution plan §P4-S3: "the cart's
 * statement count constant in the line count").
 *
 * ## Why this file exists at all
 *
 * The claim could have been measured — issue the operation, count what the
 * driver sent — and only measuring it has a defect the brief names: it is a
 * PER-OPERATION claim, not a timing claim, and a measurement is an observation
 * of the code that happened to run. So the claim is made STRUCTURAL instead.
 * Every cart command is expressed as an ordered PLAN of statements, built from
 * the command and its identifiers alone, and the executor runs exactly that
 * plan and nothing else. The plan's length is then a pure function nobody has
 * to run a database to interrogate:
 *
 *     cartStatementPlan(c, {...}).length  ===  cartStatementPlan(c, {...}).length
 *
 * for a one-line cart and a fifty-line cart, because the plan is built without
 * reference to the line count at all. `tests/guards/pos-s3-cart-law.test.ts`
 * asserts that; `tests/integration/pos-s3-cart.test.ts` asserts that the
 * EXECUTOR issues exactly the plan, through a recording seam, so the structure
 * and the behaviour are both pinned and neither can drift alone.
 *
 * ## Why every plan is exactly TWO statements
 *
 *   1. **the mutation** — one statement that resolves the till session, locks
 *      what it changes and changes it. The session resolution is folded into
 *      the statement's own CTE rather than taken as a separate read, so a
 *      command does not become three statements to learn whether it was
 *      allowed: the refusal arrives as a column.
 *   2. **the projection** — one statement that returns EVERY line of the cart
 *      with the catalogue's price joined on, for `priceCart` to recompute from.
 *
 * The projection is the half that would be N statements if anybody wrote it
 * naturally: read the lines, then look up each line's price. It is one
 * statement with one join, so adding a fiftieth line adds a ROW and never a
 * round trip. There is no per-line read, no per-line write and no loop that
 * touches the database anywhere in this module — and the plan's shape is what
 * makes that reviewable rather than a promise.
 *
 * ## What is NOT counted, and why that is honest
 *
 * `BEGIN`, the `set_config` scope statement and `COMMIT` are the transaction
 * boundary's, issued by `Database.transact` for every command in the tree
 * (`infra/database.ts:800-820`). They are constant three for one line and for
 * fifty, so including them would change both sides of the equality by the same
 * amount and prove nothing extra. What is counted is what THIS module issues.
 *
 * ## 0079 — AGENT E OWNS THE MIGRATION, AND `pos-session-contract.ts` OWNS THE NAMES
 *
 * `pos_till_sessions` and `pos_cart_lines` are created by `0079`, which is the
 * migration owner's file and not this agent's: nobody else creates or edits a
 * migration and nobody invents its number.
 *
 * The declared column contract for both relations is
 * `pos-session-contract.ts`, written by the till-session owner of this slice,
 * and `POS_CART_COLUMNS` below is built FROM it rather than beside it — the
 * shared identifiers (`tenant_id`, `business_id`, `id`, `till_session_id`, the
 * session's `status`) are imported, so the two halves of the POS module cannot
 * come to spell one column two ways.
 *
 * FIVE names are the cart's own and are NOT in that contract, because the
 * contract was written for the actor-binding law and had no reason to name
 * them: `product_id`, `variant_id`, `quantity`, `discount_minor` and
 * `line_seq`. They are declared here, marked, and REPORTED to the coordinator
 * as the columns `0079` must carry beyond the session contract. They are a
 * REQUIREMENT ON `0079` stated so it can be compared — not a guess asserted as
 * fact.
 */

/**
 * Every relation and column name this module depends on `0079` providing.
 *
 * Written as data so the dependency is one object rather than a scatter of
 * string literals, and so a guard can assert that no identifier appears in a
 * statement that is not declared here.
 */
export const POS_CART_COLUMNS = Object.freeze({
  sessions: Object.freeze({
    table: POS_TILL_SESSIONS,
    id: TILL_SESSION_COLUMNS.id,
    tenantId: TILL_SESSION_COLUMNS.tenant,
    businessId: TILL_SESSION_COLUMNS.business,
    /** The lifecycle column the till-session surface transitions. A cart command only READS it. */
    status: TILL_SESSION_COLUMNS.status,
    /** `OD-P4-09`'s column. A cart command only READS it; re-owning a till is refused by the schema. */
    // `0079` ships `opened_by`. A's `pos-session-contract.ts` declares
    // `opened_by_user_id`, and the two cannot both be right: the composite
    // edge `pos_cart_lines_session_actor_fk` names
    // `REFERENCES pos_till_sessions (business_id, id, opened_by)`, so the
    // migration's spelling is the one the database answers to. Reported to
    // the coordinator as a contract/migration conflict rather than resolved
    // in A's file, which is not mine. Asserted against `0079`'s own text by
    // the guard suite so this cannot drift back.
    owner: 'opened_by',
    /**
     * The warehouse the till sells from, and the subject of every cart
     * command's `authorize(..., warehouseIds)`. It is the SESSION's, read per
     * command, because a cashier's branch scope can be narrowed mid-shift.
     */
    warehouse: 'warehouse_id',
    /**
     * The SESSION's currency, `CHAR(3) NOT NULL` with a foreign key to
     * `currencies (code)` (`0079`). It is what an EMPTY basket's currency is:
     * the cart's figures otherwise take their currency off the stored lines,
     * and a basket with no lines had none, so `recompute` answered
     * `currency: ''`. An empty string is not a currency — rendering its
     * totals threw `Unsupported currency:` on the till, in all three locales
     * at all three viewports, and the crash took the close step with it. The
     * till has a currency from the moment it is opened, so the empty basket
     * reports the session's rather than nothing.
     */
    currency: TILL_SESSION_COLUMNS.currency,
    /** The one value of `status` a cart command may write behind. */
    openStatus: TILL_SESSION_STATES.open,
  }),
  lines: Object.freeze({
    table: POS_CART_LINES,
    id: CART_LINE_COLUMNS.id,
    tenantId: CART_LINE_COLUMNS.tenant,
    businessId: CART_LINE_COLUMNS.business,
    tillSessionId: CART_LINE_COLUMNS.session,
    // ── The six the session contract does not declare, spelled as `0079`
    //    SHIPS them. These were a REQUIREMENT on the migration when this
    //    module was written and are now a reading of it: where my name and
    //    E's differed, E's wins, because the schema is the truth and its
    //    names are woven through its own constraints and end-state
    //    assertions. `line_seq` was mine and is `line_no`; `discount_minor`
    //    was mine and is `requested_discount_minor` — a better name, because
    //    it says REQUESTED and so cannot be read as what was granted.
    productId: 'product_id',
    variantId: 'variant_id',
    /** `NUMERIC(18,4) CHECK (quantity > 0)` — the ledger's quantity type (P4-AL-15b). */
    quantity: 'quantity',
    /** `BIGINT NOT NULL DEFAULT 0`, the client's discount REQUEST. No column records what was GRANTED. */
    discountMinor: 'requested_discount_minor',
    /** `INTEGER CHECK (line_no >= 1)`. The basket's identity and its stable order. */
    lineNo: 'line_no',
    /** The actor, and the subject of `OD-P4-09`'s composite edge `pos_cart_lines_session_actor_fk`. */
    addedBy: 'added_by',
    /**
     * The TOMBSTONE. `0079` gives the internal writer no `DELETE` on this
     * relation — `tests/security/inventory-db-authority.test.ts` states
     * positively that beyond the accepted prefix `daftar_inventory_internal`
     * holds none — so a removal sets `removed_at` and the row stays. Every
     * read of a live basket must therefore say `removed_at IS NULL`, and the
     * ordinal's uniqueness is the PARTIAL index carrying the same predicate.
     */
    removedAt: 'removed_at',
  }),
});

/**
 * Exactly the cart-line columns this module requires BEYOND the declared
 * session contract — the list the hand-back reports and a guard enumerates, so
 * "five more columns" is data rather than a sentence.
 */
export const POS_CART_COLUMNS_BEYOND_CONTRACT: readonly string[] = Object.freeze([
  'added_by',
  'line_no',
  'product_id',
  'quantity',
  'requested_discount_minor',
  'variant_id',
]);

/**
 * The uniqueness `0079` actually ships on the cart, as data.
 *
 * `pos_cart_lines_line_uq UNIQUE (business_id, till_session_id, line_no)` — a
 * TOTAL unique constraint on the ORDINAL, not on the product identity. It is
 * what makes the basket append-only and ordinal-keyed, and it is the reason
 * `cart.add_line` derives `line_no` from `max(line_no) + 1` inside its own
 * statement instead of accepting one.
 *
 * A withdrawn requirement is recorded here rather than deleted, because the
 * reasoning was right and only the premise was wrong. This module previously
 * required a unique index on `(business_id, till_session_id, product_id,
 * variant_id)` with `NULLS NOT DISTINCT`, on the ground that `variant_id`
 * would be nullable and two NULLs are DISTINCT by default — which would have
 * merged nothing for a product with no variants and silently minted a second
 * line. That hazard does not exist in this estate: `0079` declares
 * `variant_id UUID NOT NULL` and every product carries exactly one hidden
 * base variant (`product_variants.is_base`, `0053`). The instinct is worth
 * keeping and the requirement is withdrawn.
 */
export const POS_CART_UNIQUE_CONSTRAINT = 'pos_cart_lines_line_uq';

/** The columns `pos_cart_lines_line_uq` covers, in order. The basket's identity is its ORDINAL. */
export const POS_CART_UNIQUE_COLUMNS: readonly string[] = Object.freeze(['business_id', 'till_session_id', 'line_no']);

/** The partial index's predicate, verbatim enough to recognize in `pg_get_indexdef`. */
export const POS_CART_UNIQUE_PREDICATE = 'removed_at IS NULL';

/**
 * `pos_cart_lines_line_uq` is PARTIAL — `WHERE removed_at IS NULL` — and that
 * is load-bearing in both directions.
 *
 * `0079` tombstones instead of deleting because the accepted estate gives
 * `daftar_inventory_internal` no `DELETE` beyond the accepted prefix
 * (`tests/security/inventory-db-authority.test.ts` asserts the absence
 * positively, so it is a law and not an omission). A tombstone keeps its row,
 * so WITHOUT the predicate the removed ordinal would be held for ever and the
 * cashier could never reuse it; WITH it, the ordinal is free again.
 *
 * This module nevertheless computes the next ordinal as `max(line_no) + 1`
 * over the whole basket, tombstones included, which never reuses a freed
 * ordinal. That is deliberate: filling gaps would renumber a basket under a
 * cashier's eyes, and the predicate's job is to make reuse POSSIBLE, not
 * mandatory.
 *
 * An earlier revision of this module asserted the opposite — not partial, no
 * tombstone column — from a SUPERSEDED `0079`. The record is kept because the
 * lesson is the durable part: a sibling's in-flight branch is not a source of
 * truth, and this module's seam now reads the live catalogue for every one of
 * these facts rather than any file.
 */
export const POS_CART_UNIQUE_IS_PARTIAL = true;

/**
 * The columns `0079` must NOT have, asserted by the guard suite against the
 * migration tree once it lands.
 *
 * Each one is a stored derived total, and P4-AL-06 forbids every one of them.
 * They are listed rather than described because a list is checkable: a
 * `0079` that created any of these would give one fact two authorities, and
 * the stale one would be on the cashier's screen the moment a catalogue price
 * moved under an open basket.
 */
export const POS_CART_FORBIDDEN_COLUMNS: readonly string[] = Object.freeze([
  'line_total_minor',
  'net_minor',
  'gross_minor',
  'cart_total_minor',
  'total_minor',
  'subtotal_minor',
  'tax_minor',
  'unit_price_minor',
  'price_minor',
  'currency',
  'line_count',
  'cogs_minor',
  'unit_cost_minor',
]);

/** One statement of a plan: its name (for the counter and the log), its text, its parameters. */
export interface CartStatement {
  /** `mutation` or `projection`. The two roles a cart statement may have; a third is a design change. */
  readonly role: 'gate' | 'routine' | 'projection';
  /**
   * `true` when `params` is empty because the GATE's answer supplies them
   * (`setLineParams`). Declared rather than inferred, so "this statement was
   * issued with no parameters" cannot be mistaken for a correct call.
   */
  readonly bindsFromGate?: boolean;
  readonly name: string;
  readonly text: string;
  readonly params: readonly unknown[];
}

/** What a cart command names. Identities, a quantity and a discount request — nothing else (P4-AL-18). */
export interface CartCommandTarget {
  readonly tenantId: string;
  readonly businessId: string;
  readonly tillSessionId: string;
  /**
   * The AUTHENTICATED user, from the membership context — never a request
   * field in any form. `OD-P4-09` OPTION A: one session, one authenticated
   * user, so a cart command into a colleague's till is refused
   * `pos.session_not_owned` and the session's `opened_by` is what it is
   * compared against, inside the GATE's own statement.
   */
  readonly actorUserId: string;
  /** The line a change, a removal or a discount names. `null` on an add, where the server mints it. */
  readonly cartLineId: string | null;
  readonly productId: string | null;
  readonly variantId: string | null;
  /** A decimal string, exact at the product's unit precision. Never a JSON number. */
  readonly quantity: string | null;
  /** A non-negative integer count of minor units, as a decimal string. */
  readonly discountMinor: string | null;
  /**
   * NOTE: there is no `lineNo` here, deliberately. `0079` makes `p_line_no` a
   * parameter of `pos_cart_set_line` rather than something the routine
   * derives, so somebody must supply it — and that somebody is the GATE, via
   * `setLineParams`, never a request field and never this type. `lineNo` is in
   * no command's accepted key set either, which the guard suite asserts, so an
   * ordinal cannot arrive in a body at all.
   */
}

const S = POS_CART_COLUMNS.sessions;
const L = POS_CART_COLUMNS.lines;

/**
 * The gate every mutation — and the one cart READ — passes through: the till
 * session, resolved in the statement's OWN text, in four narrowing steps.
 *
 * It is four CTEs and not one predicate because the four refusals a cart
 * command can carry are different answers and must not collapse into one:
 *
 *   - `visible` is the ISOLATION step. RLS is the isolation (P4-AL-40) — the
 *     `tenant_id`/`business_id` predicates are index predicates, and a
 *     session of another tenant or business is INVISIBLE rather than
 *     filtered, so an empty `visible` is `pos.session_not_found` (404) and is
 *     indistinguishable from a session that was never opened. A 403 here
 *     would confirm a row exists in a business the caller has no membership
 *     in, which is the cross-tenant enumeration the estate's guard refuses;
 *   - `opened` is the LIFECYCLE step: a closed till is `pos.session_not_open`
 *     (409). The cart only READS `status`; transitioning it belongs to the
 *     till-session surface;
 *   - `owned` is the `OD-P4-09` step on its own, INDEPENDENT of the
 *     lifecycle: the session is visible, in the caller's own business, and
 *     belongs to a COLLEAGUE. 403 `pos.session_not_owned`. It exists as its
 *     own CTE because the cart READ (`cartReadPlan`) answers a CLOSED
 *     session's basket and still has to refuse a colleague's: taking that
 *     verdict from `usable` would have reported `session_not_owned` for the
 *     owner's own closed shift, which is a false accusation rather than a
 *     refusal;
 *   - `usable` is the step a WRITE needs, and it is exactly
 *     `opened ∩ owned` — visible, open, and the caller's own. The command is
 *     well formed and the till's state allows it; what forbids it is WHO is
 *     asking, and a shift change opens a new session rather than adding a
 *     second actor to this one.
 *
 * All four are resolved in the one statement, so learning which refusal
 * applies costs no extra round trip and the statement count stays constant.
 */
const USABLE_SESSION = `
  visible AS (
    SELECT s.${S.id}, s.${S.status}, s.${S.owner}, s.${S.warehouse}, s.${S.currency}
      FROM ${S.table} s
     WHERE s.${S.tenantId} = $1::uuid
       AND s.${S.businessId} = $2::uuid
       AND s.${S.id} = $3::uuid
  ),
  opened AS (SELECT v.${S.id}, v.${S.owner} FROM visible v WHERE v.${S.status} = '${S.openStatus}'),
  owned AS (SELECT v.${S.id}, v.${S.status} FROM visible v WHERE v.${S.owner} = $4::uuid),
  usable AS (SELECT o.${S.id} FROM opened o WHERE o.${S.owner} = $4::uuid)`;

/**
 * The four counts every statement of a cart plan reports beside its own, so
 * ONE statement answers every question a cart command or the cart read can be
 * refused by. Each count is a registered code in the canonical registry and
 * the service maps them in this order — widest refusal first, because the
 * narrower ones would leak the existence of a row the wider one says is
 * invisible.
 *
 * A WRITE reads `session_visible`, `session_open`, `session_usable`; the READ
 * reads `session_visible`, `session_owned` and deliberately ignores
 * `session_open` (see `PosCartService.readCart` for the ruling and why).
 */
const SESSION_DISCRIMINATORS = `(SELECT count(*) FROM visible) AS session_visible,
                   (SELECT count(*) FROM opened) AS session_open,
                   (SELECT count(*) FROM owned) AS session_owned,
                   (SELECT count(*) FROM usable) AS session_usable`;

/**
 * The projection. ONE statement, every line, the catalogue's price joined on.
 *
 * This is the statement the O(1) claim is about. It is built without reference
 * to the line count, so a fifty-line basket is fifty ROWS of one answer.
 *
 * It reads the price from the catalogue on EVERY recomputation and the cart
 * row holds no copy of it — which is "no stored derived truth" (P4-AL-06) as a
 * query rather than as a sentence.
 */
/**
 * THE BASKET, as both the four commands and the one read answer it.
 *
 * `variant_id` is reported as NULL for a product's BASE variant, and that is
 * a correction rather than a convenience. `0079` declares
 * `pos_cart_lines.variant_id UUID NOT NULL`, so a line for a product with no
 * merchant variants stores the product's hidden base variant
 * (`product_variants.is_base`, `0053`) — the server resolved it, the cashier
 * never chose it. Reporting that id to a client is reporting a choice nobody
 * made, and it is unusable besides: `resolveVariants`
 * (`inventory-stock-read.ts:98`) looks a stated variant up as
 * `variant_id = $wanted AND NOT is_base`, so a base id matches NOTHING and
 * the sale is refused `inventory.variant_not_found` — "we couldn't find that
 * option", about a product that has no options. Measured in the browser gate
 * as a 404 on the Arabic sale of a product with no variants.
 *
 * So the column means storage and this field means CHOICE: the merchant
 * variant the cashier picked, or NULL for "the product itself". That is the
 * same thing `PosProductHitDto` already reports from the type-ahead and the
 * same thing `resolveVariants` carries as `merchantVariantId`, so the three
 * now agree instead of two agreeing and one leaking. `P3-AL-52`.
 */
const PROJECTION = `
  SELECT l.${L.id} AS cart_line_id,
         l.${L.productId} AS product_id,
         CASE WHEN v.is_base THEN NULL ELSE l.${L.variantId} END AS variant_id,
         l.${L.quantity}::text AS quantity,
         l.${L.discountMinor}::text AS discount_minor,
         coalesce(v.price_minor, p.base_price_minor)::text AS unit_price_minor,
         p.price_currency,
         coalesce(t.name, '') AS name_snapshot
    FROM ${L.table} l
    JOIN products p
      ON p.business_id = l.${L.businessId} AND p.id = l.${L.productId}
    LEFT JOIN product_variants v
      ON v.business_id = l.${L.businessId} AND v.id = l.${L.variantId}
    LEFT JOIN product_translations t
      ON t.business_id = l.${L.businessId} AND t.product_id = l.${L.productId} AND t.locale = 'ar'
   WHERE l.${L.tenantId} = $1::uuid
     AND l.${L.businessId} = $2::uuid
     AND l.${L.tillSessionId} = $3::uuid
     AND l.${L.removedAt} IS NULL
   ORDER BY l.${L.lineNo}`;

const projection = (t: CartCommandTarget): CartStatement => ({
  role: 'projection',
  name: 'cart.projection',
  text: PROJECTION,
  params: [t.tenantId, t.businessId, t.tillSessionId],
});

/**
 * The GATE. ONE statement, issued BEFORE the seam opens, that answers
 * everything the minting needs and everything a refusal needs to be chosen
 * from.
 *
 * It runs first — and outside the write transaction — because the `invctl/1`
 * assertion SIGNS the payload, and `pos.cart_set_line`'s payload carries
 * `line_no`, `product_id`, `variant_id` and `qty_q4`. Those are server facts
 * about an existing basket, so they must be READ before anything can be
 * minted, and minting must precede the seam. The order is forced by the
 * protocol, not chosen: gate, authorize, mint, then the routine.
 *
 * It also carries the session's `warehouse_id`, so the authority check and
 * the line facts are one round trip rather than two.
 *
 * WHAT THIS DOES NOT DO is hold a lock. An earlier revision took `FOR SHARE`
 * here, which was meaningful while the gate and the write shared one
 * transaction and is meaningless now that the gate is its own read. The
 * ordinal it computes CAN therefore be taken by a concurrent till between the
 * gate and the routine — and that is handled where it belongs: the partial
 * unique index refuses the second writer and `pos_cart_set_line` raises
 * `pos.cart_line_conflict`, which is a real refusal of a real race and is
 * retryable by the client. Pretending to prevent it with a lock in a
 * transaction that has already ended would be the worse answer.
 *
 * Every column it returns is a fact the SERVER then states to the routine. The
 * client supplied none of them, which is the whole trust boundary expressed in
 * the shape of the plan rather than in a comment.
 */
const GATE = `
  WITH${USABLE_SESSION},
  line AS (
    SELECT l.${L.id}, l.${L.lineNo}, l.${L.productId}, l.${L.variantId}, l.${L.removedAt},
             l.${L.quantity}, l.${L.discountMinor}
      FROM ${L.table} l
     WHERE l.${L.tenantId} = $1::uuid
       AND l.${L.businessId} = $2::uuid
       AND l.${L.tillSessionId} = $3::uuid
       AND l.${L.id} = $5::uuid
  )
  SELECT ${SESSION_DISCRIMINATORS},
         -- The SESSION's warehouse, for the authority check. Read per command
         -- and never cached: a cashier's branch scope can be narrowed
         -- mid-shift, and a basket that kept accepting writes because the
         -- scope was checked once at open would be authority outliving the
         -- decision that granted it.
         (SELECT v.${S.warehouse} FROM visible v) AS warehouse_id,
         -- The session's own currency, so an EMPTY basket still has one.
         (SELECT v.${S.currency} FROM visible v) AS session_currency,
         coalesce((SELECT max(x.${L.lineNo}) FROM ${L.table} x
                    WHERE x.${L.businessId} = $2::uuid AND x.${L.tillSessionId} = $3::uuid), 0) + 1 AS next_line_no,
         (SELECT count(*) FROM line) AS line_present,
         (SELECT count(*) FROM line WHERE ${L.removedAt} IS NOT NULL) AS line_removed,
         (SELECT ${L.lineNo} FROM line) AS line_no,
         (SELECT ${L.productId} FROM line) AS product_id,
         (SELECT ${L.variantId} FROM line) AS variant_id,
         -- The line's CURRENT quantity and discount request. They are read
         -- because pos_cart_set_line writes BOTH columns on every call: a
         -- quantity change that did not restate the discount would silently
         -- clear it, and a discount request that did not restate the quantity
         -- would set it to NULL and be refused outright. Revising one field
         -- therefore means restating the other, from the server's own copy.
         (SELECT ${L.quantity}::text FROM line) AS quantity,
         (SELECT ${L.discountMinor}::text FROM line) AS requested_discount_minor,
         -- The stated product's BASE variant, for an append that named no
         -- variant. Migration 0079 declares variant_id UUID NOT NULL, so none
         -- is not representable in the relation: a simple product sells as its
         -- one hidden base variant (product_variants.is_base, 0053). The
         -- SERVER resolves it, which is also what keeps it safe to sign -- it
         -- is a function of the stated product and resolves identically on a
         -- replay, unlike a catalogue price.
         (SELECT bv.id FROM product_variants bv
           WHERE bv.business_id = $2::uuid AND bv.product_id = $6::uuid AND bv.is_base) AS base_variant_id`;

const gate = (t: CartCommandTarget): CartStatement => ({
  role: 'gate',
  name: 'cart.gate',
  text: GATE,
  params: [t.tenantId, t.businessId, t.tillSessionId, t.actorUserId, t.cartLineId ?? null, t.productId ?? null],
});

/**
 * The one writer of a cart line, as `0079` ships it.
 *
 * `pos_cart_set_line` carries the add, the quantity change and the discount
 * request alike: it is keyed by `p_line_id` and REVISES `quantity` and
 * `requested_discount_minor` when that id already names the same identities.
 * Three commands, one routine, which is the schema's decision and not this
 * module's — and it is why the three plans differ only in the arguments they
 * compute.
 *
 * There is NO price argument of any kind. A forged total is not refused here;
 * it is INEXPRESSIBLE, because the routine has nowhere to put it.
 */
// No `target` parameter, and that is the point: this statement's arguments do
// not exist until the GATE has answered, so there is nothing about the command
// for it to read. `setLineParams` is the one place a call is assembled.
const setLine = (name: string): CartStatement => ({
  role: 'routine',
  name,
  text: `SELECT cart_line_id, line_no, revised FROM pos_cart_set_line($1::uuid, $2::uuid, $3::integer, $4::uuid, $5::uuid, $6::numeric, $7::bigint)`,
  // EMPTY, and bound by `setLineParams` from the GATE's answer. The ordinal
  // and (on a revision) the identities are not known until the gate has run,
  // and inventing them before it would be the server guessing at its own
  // state. The plan's SHAPE — three statements, these texts, in this order —
  // is still fixed before any statement is issued, which is what the O(1)
  // claim is about.
  params: [],
  bindsFromGate: true,
});

/**
 * The routine's arguments, from the GATE's answer and the command's own
 * fields. The one place a `pos_cart_set_line` call is assembled.
 *
 * On an APPEND the ordinal is the gate's `next_line_no` and the identities are
 * the command's. On a REVISION the ordinal and the identities are the EXISTING
 * line's, read from the gate — because `pos_cart_set_line` refuses a line id
 * whose identities changed (`pos.cart_line_conflict`), and because a revision
 * that could restate a line's product would be an edit nobody asked for.
 */
export function setLineParams(
  command: PosCartCommand,
  t: CartCommandTarget,
  gate: {
    readonly next_line_no: number;
    readonly line_no: number | null;
    readonly product_id: string | null;
    readonly variant_id: string | null;
    readonly quantity: string | null;
    readonly requested_discount_minor: string | null;
    readonly base_variant_id?: string | null;
  },
): readonly unknown[] {
  const append = command === 'cart.add_line';
  return [
    t.tillSessionId,
    t.cartLineId,
    append ? gate.next_line_no : gate.line_no,
    append ? t.productId : gate.product_id,
    // A stated variant wins; a product sold without one takes its BASE
    // variant, resolved by the server. `0079` has no nullable variant.
    append ? (t.variantId ?? gate.base_variant_id ?? null) : gate.variant_id,
    // BOTH columns are written on every call, so revising one field means
    // RESTATING the other from the server's own copy. Passing NULL for the
    // field this command does not change would not "leave it alone": the
    // routine refuses a NULL quantity outright, and a NULL discount would
    // clear a discount the cashier had already granted.
    command === 'cart.request_discount' ? gate.quantity : t.quantity,
    command === 'cart.request_discount' ? t.discountMinor : append ? '0' : gate.requested_discount_minor,
  ];
}

/**
 * The removal, which writes the `removed_at` TOMBSTONE and never deletes.
 *
 * It is idempotent by row count: a line already tombstoned matches nothing,
 * returns 0 and raises nothing, because a till that taps "remove" twice has
 * not done anything wrong. The 404 for a line that was never in this session
 * is a DIFFERENT event and the service supplies it from the gate — see
 * `POS_CART_REMOVAL_OUTCOMES`.
 */
const removeLine = (t: CartCommandTarget): CartStatement => ({
  role: 'routine',
  name: 'cart.remove_line',
  text: `SELECT pos_cart_remove_line($1::uuid, $2::uuid) AS removed`,
  params: [t.tillSessionId, t.cartLineId],
});

/**
 * The three outcomes of a removal, kept as data because the distinction is a
 * ruling and not an implementation detail.
 *
 * E's routine is idempotent and this module's 404 is also right; the TOMBSTONE
 * is what makes them distinguishable without guessing, so neither has to be
 * withdrawn:
 *
 *   - a row with `removed_at IS NOT NULL` → already removed → 200, no refusal;
 *   - a row with `removed_at IS NULL`     → tombstone it    → 200;
 *   - no row at all for that id           → `pos.cart_line_not_found` 404.
 *
 * Without the tombstone the first and the third are the same observation, and
 * one of the two behaviours would have had to go.
 */
export const POS_CART_REMOVAL_OUTCOMES = Object.freeze({
  alreadyRemoved: 'idempotent',
  live: 'removed',
  absent: 'pos.cart_line_not_found',
} as const);

/**
 * The statement plan for one cart command. EXACTLY THREE statements, for every
 * command, for every cart size: the gate, the routine, the projection.
 *
 * It was TWO until `0079` was read properly. Two was a plan that resolved the
 * session and mutated in one statement — under a protocol the schema does not
 * permit, because `daftar_app` holds SELECT and only SELECT on both relations
 * and every write is a SECURITY DEFINER routine whose arguments the caller
 * supplies. An honest three beats a two that counts SQL which cannot run.
 *
 * The assertion that authorizes the routine costs NO statement: it rides the
 * seam's own scope statement at `BEGIN`
 * (`withBusinessInventoryTransaction` → `app.inventory_assertion`), so the
 * third statement is the gate, which `p_line_no` and the removal's three-way
 * outcome force.
 *
 * It is a pure function of the command and its identifiers. It never sees the
 * cart's current lines, so its length cannot depend on them — which is the
 * O(1) claim, stated in a form a test can hold without a database.
 */
export function cartStatementPlan(command: PosCartCommand, t: CartCommandTarget): readonly CartStatement[] {
  switch (command) {
    case 'cart.add_line':
      return Object.freeze([gate(t), setLine('cart.add_line'), projection(t)]);
    case 'cart.change_quantity':
      return Object.freeze([gate(t), setLine('cart.change_quantity'), projection(t)]);
    case 'cart.request_discount':
      return Object.freeze([gate(t), setLine('cart.request_discount'), projection(t)]);
    case 'cart.remove_line':
      return Object.freeze([gate(t), removeLine(t), projection(t)]);
  }
}

/** Three: the gate, the routine, the projection. Constant in the line count. */
export const CART_STATEMENTS_PER_COMMAND = 3;

/**
 * What the cart READ names: the three identities and the actor, and nothing
 * else. A read addresses no line, states no quantity and asks for no
 * discount, so the four command fields are structurally absent rather than
 * passed as `null` by a caller who might one day pass something.
 */
export type CartReadTarget = Pick<CartCommandTarget, 'tenantId' | 'businessId' | 'tillSessionId' | 'actorUserId'>;

/**
 * The statement plan for the ONE cart read,
 * `GET /v1/pos/till-sessions/:sessionId/cart-lines`. EXACTLY TWO statements,
 * for every cart size: the gate, then the projection.
 *
 * It is the SAME `gate` and the SAME `projection` the four commands are built
 * from — not a second pair that happens to look like them. That is the point
 * of building it here rather than writing a query in the read: the session
 * verdict a read refuses on and the session verdict a write refuses on are
 * one statement's text, so they cannot come to disagree, and the basket a
 * read answers and the basket a command answers are one `PROJECTION`, so the
 * read cannot drift into a second definition of "the cart" (and cannot grow a
 * second rounding layer, which `recompute` refuses in production anyway).
 *
 * TWO and not three: there is no routine, because a read writes nothing. It
 * is also the FEWEST the gate plus the projection can be — the gate's four
 * discriminators are one statement and the whole basket with its prices
 * joined on is one more, and neither can be dropped: without the gate the
 * read would answer a colleague's basket, and without the projection it would
 * answer nothing.
 *
 * The gate's `$5` (the addressed line) and `$6` (the stated product) are
 * `null` here, which makes its `line` CTE empty and its `base_variant_id`
 * NULL. The read ignores both, and paying for them is the price of ONE gate
 * instead of two — measured as columns in a row that is already being
 * fetched, not as a round trip.
 */
export function cartReadPlan(t: CartReadTarget): readonly CartStatement[] {
  const target: CartCommandTarget = { ...t, cartLineId: null, productId: null, variantId: null, quantity: null, discountMinor: null };
  return Object.freeze([gate(target), projection(target)]);
}

/** Two: the gate and the projection. Constant in the line count, and one fewer than a command. */
export const CART_STATEMENTS_PER_READ = 2;
