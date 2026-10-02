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
    owner: TILL_SESSION_COLUMNS.owner,
    /** The one value of `status` a cart command may write behind. */
    openStatus: TILL_SESSION_STATES.open,
  }),
  lines: Object.freeze({
    table: POS_CART_LINES,
    id: CART_LINE_COLUMNS.id,
    tenantId: CART_LINE_COLUMNS.tenant,
    businessId: CART_LINE_COLUMNS.business,
    tillSessionId: CART_LINE_COLUMNS.session,
    // ── The five the session contract does not declare (reported to the
    //    coordinator as this agent's requirement on `0079`) ──────────────
    productId: 'product_id',
    variantId: 'variant_id',
    /** `NUMERIC(18,4)` — the ledger's quantity type (P4-AL-15b). */
    quantity: 'quantity',
    /** `BIGINT`, a non-negative integer count of minor units. The discount REQUEST. */
    discountMinor: 'discount_minor',
    /** The stable ordering of a basket, so two recomputations agree on the order of the lines. */
    lineSeq: 'line_seq',
  }),
});

/**
 * Exactly the cart-line columns this module requires BEYOND the declared
 * session contract — the list the hand-back reports and a guard enumerates, so
 * "five more columns" is data rather than a sentence.
 */
export const POS_CART_COLUMNS_BEYOND_CONTRACT: readonly string[] = Object.freeze(['product_id', 'variant_id', 'quantity', 'discount_minor', 'line_seq']);

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
  readonly role: 'mutation' | 'projection';
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
   * `pos.session_not_owned` and the session's `opened_by_user_id` is what it
   * is compared against, inside the mutation's own statement.
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
}

const S = POS_CART_COLUMNS.sessions;
const L = POS_CART_COLUMNS.lines;

/**
 * The gate every mutation passes through: the till session, resolved in the
 * mutation's OWN statement, in three narrowing steps.
 *
 * It is three CTEs and not one predicate because the four refusals a cart
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
 *   - `usable` is the `OD-P4-09` step: the session is visible, in the
 *     caller's own business, open — and belongs to a COLLEAGUE. 403
 *     `pos.session_not_owned`. The command is well formed and the till's
 *     state allows it; what forbids it is WHO is asking, and a shift change
 *     opens a new session rather than adding a second actor to this one.
 *
 * All three are resolved in the mutation's one statement, so learning which
 * refusal applies costs no extra round trip and the statement count stays
 * constant.
 */
const USABLE_SESSION = `
  visible AS (
    SELECT s.${S.id}, s.${S.status}, s.${S.owner}
      FROM ${S.table} s
     WHERE s.${S.tenantId} = $1::uuid
       AND s.${S.businessId} = $2::uuid
       AND s.${S.id} = $3::uuid
     FOR SHARE
  ),
  opened AS (SELECT v.${S.id}, v.${S.owner} FROM visible v WHERE v.${S.status} = '${S.openStatus}'),
  usable AS (SELECT o.${S.id} FROM opened o WHERE o.${S.owner} = $4::uuid)`;

/**
 * The three counts every mutation reports beside its own, so ONE statement
 * answers all four questions a cart command can be refused by. Each count is
 * a registered code in the canonical registry and the service maps them in
 * this order — widest refusal first, because the narrower ones would leak the
 * existence of a row the wider one says is invisible.
 */
const SESSION_DISCRIMINATORS = `(SELECT count(*) FROM visible) AS session_visible,
                   (SELECT count(*) FROM opened) AS session_open,
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
const PROJECTION = `
  SELECT l.${L.id} AS cart_line_id,
         l.${L.productId} AS product_id,
         l.${L.variantId} AS variant_id,
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
   ORDER BY l.${L.lineSeq}`;

const projection = (t: CartCommandTarget): CartStatement => ({
  role: 'projection',
  name: 'cart.projection',
  text: PROJECTION,
  params: [t.tenantId, t.businessId, t.tillSessionId],
});

/**
 * The statement plan for one cart command. EXACTLY TWO statements, for every
 * command, for every cart size.
 *
 * It is a pure function of the command and its identifiers. It never sees the
 * cart's current lines, so its length cannot depend on them — which is the O(1)
 * claim, stated in a form a test can hold without a database.
 */
export function cartStatementPlan(command: PosCartCommand, t: CartCommandTarget): readonly CartStatement[] {
  switch (command) {
    case 'cart.add_line':
      return Object.freeze([
        {
          role: 'mutation' as const,
          name: 'cart.add_line',
          // ONE statement: resolve the session, mint or merge the line, hand
          // back the id. A second add of the same variant MERGES rather than
          // duplicating, because two lines for one variant give a cashier two
          // places to change one quantity.
          text: `
            WITH${USABLE_SESSION},
            minted AS (
              INSERT INTO ${L.table} (
                ${L.id}, ${L.tenantId}, ${L.businessId}, ${L.tillSessionId},
                ${L.productId}, ${L.variantId}, ${L.quantity}, ${L.discountMinor}, ${L.lineSeq}
              )
              SELECT $5::uuid, $1::uuid, $2::uuid, u.${S.id}, $6::uuid, $7::uuid, $8::numeric, 0,
                     coalesce((SELECT max(x.${L.lineSeq}) FROM ${L.table} x
                                WHERE x.${L.businessId} = $2::uuid AND x.${L.tillSessionId} = $3::uuid), 0) + 1
                FROM usable u
              ON CONFLICT (${L.businessId}, ${L.tillSessionId}, ${L.productId}, ${L.variantId})
              DO UPDATE SET ${L.quantity} = ${L.table}.${L.quantity} + EXCLUDED.${L.quantity}
              RETURNING ${L.id}
            )
            SELECT ${SESSION_DISCRIMINATORS}, (SELECT count(*) FROM minted) AS written`,
          params: [t.tenantId, t.businessId, t.tillSessionId, t.actorUserId, t.cartLineId, t.productId, t.variantId, t.quantity],
        },
        projection(t),
      ]);

    case 'cart.change_quantity':
      return Object.freeze([
        {
          role: 'mutation' as const,
          name: 'cart.change_quantity',
          text: `
            WITH${USABLE_SESSION},
            changed AS (
              UPDATE ${L.table} l
                 SET ${L.quantity} = $6::numeric
                FROM usable u
               WHERE l.${L.tenantId} = $1::uuid
                 AND l.${L.businessId} = $2::uuid
                 AND l.${L.tillSessionId} = u.${S.id}
                 AND l.${L.id} = $5::uuid
              RETURNING l.${L.id}
            )
            SELECT ${SESSION_DISCRIMINATORS}, (SELECT count(*) FROM changed) AS written`,
          params: [t.tenantId, t.businessId, t.tillSessionId, t.actorUserId, t.cartLineId, t.quantity],
        },
        projection(t),
      ]);

    case 'cart.remove_line':
      return Object.freeze([
        {
          role: 'mutation' as const,
          name: 'cart.remove_line',
          text: `
            WITH${USABLE_SESSION},
            removed AS (
              DELETE FROM ${L.table} l
               USING usable u
               WHERE l.${L.tenantId} = $1::uuid
                 AND l.${L.businessId} = $2::uuid
                 AND l.${L.tillSessionId} = u.${S.id}
                 AND l.${L.id} = $5::uuid
              RETURNING l.${L.id}
            )
            SELECT ${SESSION_DISCRIMINATORS}, (SELECT count(*) FROM removed) AS written`,
          params: [t.tenantId, t.businessId, t.tillSessionId, t.actorUserId, t.cartLineId],
        },
        projection(t),
      ]);

    case 'cart.request_discount':
      return Object.freeze([
        {
          role: 'mutation' as const,
          name: 'cart.request_discount',
          // The discount REQUEST is stored as the integer the client sent, and
          // whether it is ALLOWED against this line's derived gross is decided
          // by `priceCart` on the projection — because the gross is the
          // server's figure and the client never saw it.
          text: `
            WITH${USABLE_SESSION},
            discounted AS (
              UPDATE ${L.table} l
                 SET ${L.discountMinor} = $6::bigint
                FROM usable u
               WHERE l.${L.tenantId} = $1::uuid
                 AND l.${L.businessId} = $2::uuid
                 AND l.${L.tillSessionId} = u.${S.id}
                 AND l.${L.id} = $5::uuid
              RETURNING l.${L.id}
            )
            SELECT ${SESSION_DISCRIMINATORS}, (SELECT count(*) FROM discounted) AS written`,
          params: [t.tenantId, t.businessId, t.tillSessionId, t.actorUserId, t.cartLineId, t.discountMinor],
        },
        projection(t),
      ]);
  }
}

/**
 * The number of statements one cart command issues. Two, for every command and
 * every cart size — the constant the law is about, named so a test asserts a
 * value rather than a tautology.
 */
export const CART_STATEMENTS_PER_COMMAND = 2;
