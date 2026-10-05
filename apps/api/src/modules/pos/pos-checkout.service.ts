import { Inject, Injectable } from '@nestjs/common';
import { hasPermission } from '@daftar/domain-core';
import { buildInventoryPayload, formatQuantity, parseMinor, parseQuantity, saleCommitIntentSha256 } from '@daftar/inventory';
import type { PosCheckoutDto } from '@daftar/shared-contracts';
import { Database, presentInventoryAssertion, type BusinessInventoryAccountingTransaction } from '../../infra/database';
import { AuditService } from '../audit/audit.service';
import type { BusinessTransactionId } from '../inventory/business-transaction';
import { InventoryAuthorizationService, type InventoryCommandAuthority } from '../inventory/inventory-authorization';
import { SaleCommitService, type SaleCommitPlan } from '../selling/sale-commit.service';
import { readSaleDto } from '../selling/sale-reads';
import { auditThenRethrowSellingRefusal, saleCommitAttempt, type SellingAttempt } from '../selling/selling-refusal-audit';
import type { SaleCommitRequest } from '../selling/selling.schemas';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { posRefusal } from './pos-errors';
import type { PosCheckoutRequest } from './pos-checkout.schemas';

/**
 * `POST /v1/pos/till-sessions/:sessionId/checkout` — THE ATOMIC POS CHECKOUT
 * (TL-P4-S3-R1; lock P4-AL-16, P4-AL-18, P4-AL-30, P4-AL-39, P4-AL-40,
 * OD-P4-09).
 *
 * ## Why the route is here and not on `POST /v1/sales`
 *
 * `POST /v1/sales` stays the GENERIC sale commit surface and is given no
 * implicit knowledge of any POS basket, because a future channel will call the
 * sale writer with no cart at all. A checkout is an ORCHESTRATION of two
 * things that already exist — the accepted sale primitive and the accepted
 * cart — and an orchestration belongs beside the thing whose state it
 * consumes. The path follows the POS module's own spelling of its session
 * segment (`/v1/pos/till-sessions/:sessionId/...`, `pos-permissions.ts`,
 * `pos-cart-routes.ts`), so one POS module has one name for one thing.
 *
 * ## THE ATOMIC LAW, AS THIS FILE PERFORMS IT
 *
 * One checkout is ONE seam-2 transaction, owned HERE and by nothing else, and
 * these are the steps in it:
 *
 *   0. **the replay proof, FIRST and before any current state is read.** The
 *      `sales` row for the caller-supplied `saleId` is read, and the digest of
 *      THIS request — recomputed over the STORED sale's own lines, which is
 *      the only line set a replay can honestly be judged against — is compared
 *      with the stored `commit_intent_sha256`. Same digest and the sale's own
 *      lines are cart rows of THIS session ⇒ the stored sale is returned and
 *      the basket is not touched. Different digest, or a sale that is not this
 *      session's ⇒ `pos.checkout_idempotency_conflict`. An idempotency key is
 *      not permission (`[[daftar-idempotency-key-is-not-permission]]`), and
 *      consulting the proof BEFORE reading state is
 *      `[[daftar-registry-before-state]]`: a stale request replayed after a
 *      later transition, whose handler reads state first, performs a second
 *      real change;
 *   1. **the session, and the five establishment facts**: same tenant and
 *      business (RLS, not a predicate), the branch and the warehouse read FROM
 *      the session, the authenticated actor equal to `opened_by` (OD-P4-09),
 *      and `status = 'open'`;
 *   2. **the exact active cart set**, in `line_no` order, with each line's
 *      product, STOCK variant, quantity and discount request. That set is THE
 *      SNAPSHOT and nothing later re-reads it;
 *   3. **the sale request is DERIVED from the snapshot**, line for line. Each
 *      sale line's `lineId` IS the cart line's id. That is the whole of the
 *      consumption binding: the sale's own `sale_items.id` values are the cart
 *      rows it came from, so "the rows this sale consumed" is a fact of the
 *      committed sale and never "whatever was active at the time";
 *   4. **`SaleCommitService.plan`** derives price, discount, tax, subtotal,
 *      total, currency and FX from server truth. Not one figure of it is
 *      recomputed here;
 *   5. **`SaleCommitService.seamAuthority`** mints the sale's authority — the
 *      `invctl/1` assertion and the accounting authority — and this service
 *      mints ONE MORE per cart line: a `pos.cart_remove_line` assertion over
 *      that line's exact payload;
 *   6. **ONE transaction**, opened here with those assertions in CALL ORDER:
 *      `sale.commit` first, then one `pos.cart_remove_line` per line. Inside
 *      it: a transaction-scoped advisory lock on the session,
 *      `SaleCommitService.execute` (the sale, its items, the movements, the
 *      bridges, the invoice, the COGS entry, the revenue entry), then the
 *      tombstones, then the VERIFICATION, then COMMIT.
 *
 * If any step fails, NOTHING commits — not because this service unwinds
 * anything, but because there is one transaction and no second connection.
 * The seam refuses to open inside another transaction and nothing opens inside
 * it (`database.ts:150-161`), so a sale committed with the cart unconsumed,
 * or a cart consumed with no sale, is not a state this code can reach.
 *
 * ## **THERE IS NO SECOND SALE WRITER HERE**
 *
 * This file computes no price, no gross, no net, no discount, no tax, no
 * total, no share, no COGS and no FX. It issues no `INSERT` and no `UPDATE`
 * against `sales`, `sale_items`, `invoices`, `invoice_items`,
 * `stock_movements`, `journal_entries` or any bridge. It calls `plan`,
 * `seamAuthority` and `execute` on the ONE `SaleCommitService` and reads the
 * answer back through the ONE sale read. The only SQL it owns is: two reads of
 * the POS relations, the advisory lock, `pos_cart_remove_line` — Agent E's
 * accepted tombstone routine, unchanged — and one verification read.
 *
 * ## THE CART SNAPSHOT LAW, AND WHAT A CONCURRENT EDIT GETS
 *
 * The snapshot is read before the transaction, exactly as the accepted sale's
 * own `plan` reads the catalogue, the rate and the stock levels before its
 * transaction: the commit is OPTIMISTIC and a disagreement under the locks is
 * a refusal, never a retry (`[[daftar-lock-order-not-retry]]`).
 *
 * The verification inside the transaction is what makes the optimism safe, and
 * it runs AFTER the tombstones on purpose. `pos_cart_remove_line`'s `UPDATE`
 * takes the row lock, so a concurrent `pos_cart_set_line` revising one of
 * these lines either committed BEFORE it (and the verification sees the new
 * quantity, and refuses) or blocks on it (and, once this transaction commits,
 * re-evaluates its own `removed_at IS NULL` predicate against a tombstoned row
 * and changes nothing). Reading the rows before the lock could not distinguish
 * those two.
 *
 * The verification asserts three things, all of them about rows and none of
 * them about counts:
 *
 *   - every snapshot line is now tombstoned (`pos_cart_remove_line` answering
 *     0 for one of them means it had ALREADY been removed by somebody else:
 *     the basket this sale was derived from is not the basket that existed);
 *   - every snapshot line's quantity and discount request are still the ones
 *     the sale was priced from;
 *   - no OTHER line of this session is live. A line added between the snapshot
 *     and the lock would otherwise be a basket half-sold.
 *
 * Any of the three ⇒ `pos.checkout_cart_state_changed`, the transaction rolls
 * back, and the till re-reads. Never a silent "sell one cart and clear
 * another".
 *
 * ## THE REPLAY, AND THE LINE A REPLAY MUST NOT TOUCH
 *
 * A proven replay returns the stored sale and **issues no cart write at all**.
 * That is correct rather than lazy: the original checkout tombstoned its
 * snapshot in the SAME transaction that committed the sale, so a proven replay
 * has nothing left to consume. It is also the only safe answer — a replay that
 * cleared "the active lines" would clear the lines a cashier scanned AFTER the
 * first sale, which is precisely the defect TL-P4-S3-R1 calls critical. The
 * consumed identity is reported from the STORED sale's own line ids, so the
 * answer names the original snapshot and not the current basket.
 */
@Injectable()
export class PosCheckoutService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(InventoryAuthorizationService) private readonly authorization: InventoryAuthorizationService,
    // The ONE sale writer. This service holds it to call `plan`,
    // `seamAuthority` and `execute`; it reimplements none of them.
    @Inject(SaleCommitService) private readonly sales: SaleCommitService,
    // P4-AL-48's refusal audit. A checkout is refused by the session checks,
    // by the basket checks, by `sale_commit`'s own 33 raises (whose only audit
    // row, `sale.committed` at `0078:1002`, is its LAST step) or by the
    // verification — and until this was injected not one of those persisted
    // any evidence.
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * P4-AL-48's attempt record for a checkout.
   *
   * The operation is `sale.commit`, because that is the command a checkout IS:
   * the cart removals are its CONSUMPTION step, minted per line under
   * `pos.cart_remove_line`, and a refusal of one of them is reported by its own
   * code (`pos.checkout_cart_state_changed`) in the same row. One attempt, one
   * row, and the refusal code says which step refused — a second row per
   * removal would be an audit of the orchestration's internals rather than of
   * the command the cashier gave.
   *
   * The figures start as the REQUEST's, because a refusal raised on the first
   * read has only those; once the sale request is derived from the basket they
   * are replaced by `saleCommitAttempt`'s — the same figures `POST /v1/sales`
   * audits, from the same function, so a refused checkout and a refused sale
   * are not two different accounts of the same thing.
   */
  async checkout(m: MembershipContext, tillSessionId: string, input: PosCheckoutRequest, btx: BusinessTransactionId): Promise<PosCheckoutDto> {
    const attempt: SellingAttempt = {
      operation: 'sale.commit',
      entity: 'sale',
      entityId: input.saleId,
      tillSessionId,
      figures: {
        settlementMode: input.settlementMode,
        customerId: input.customerId,
        documentDate: input.documentDate,
        dueDate: input.dueDate,
      },
    };
    try {
      return await this.run(m, tillSessionId, input, btx, attempt);
    } catch (e) {
      return await auditThenRethrowSellingRefusal(this.audit, m, attempt, e);
    }
  }

  private async run(
    m: MembershipContext,
    tillSessionId: string,
    input: PosCheckoutRequest,
    btx: BusinessTransactionId,
    attempt: SellingAttempt,
  ): Promise<PosCheckoutDto> {
    // 0. THE REPLAY PROOF, BEFORE ANY CURRENT STATE IS READ.
    const replay = await this.provenReplay(m, tillSessionId, input);
    if (replay !== null) return replay;

    // 1. The session, and the five establishment facts.
    const session = await this.readSession(m, tillSessionId);
    if (session === null) throw posRefusal('pos.session_not_found');
    if (session.openedBy !== m.userId) throw posRefusal('pos.session_not_owned');
    if (session.status !== 'open') throw posRefusal('pos.session_not_open');

    // 2. THE SNAPSHOT: the exact active cart set, bound here and never re-read.
    const snapshot = await this.readCartSnapshot(m, tillSessionId);
    if (snapshot.length === 0) throw posRefusal('pos.checkout_cart_empty');
    // The SENSITIVE key, against the SNAPSHOT and not against the request —
    // the request cannot state a discount at all. A cart carrying a discount
    // request that this cashier may not grant is REFUSED and never silently
    // zeroed, because a silently-zeroed discount charges the customer more
    // than the cashier told them (P4-AL-35, P4-AL-37; the `sale_commit`
    // precedent).
    if (snapshot.some((l) => l.discountMinor > 0n) && !hasPermission(m.roles, 'sales.discount')) {
      throw posRefusal('pos.cart_discount_not_permitted');
    }

    // 3. The sale request, DERIVED from the snapshot. The cart line id is the
    //    sale line id: that is the consumption binding.
    const request = this.saleRequest(input, session, snapshot);
    // The figures the ONE sale writer is about to be given, from the ONE
    // function that states what a refused sale commit carries.
    Object.assign(attempt.figures, saleCommitAttempt(request, tillSessionId).figures);

    // 4. The ONE sale writer derives every figure.
    const outcome = await this.sales.plan(m, request, btx, attempt);
    if (outcome.kind === 'replay') {
      // `plan` found the sale already stored with THIS exact intent between
      // step 0's read and now. Two checkouts of one `saleId` raced; this one
      // sold nothing, so it consumes nothing and answers from the stored rows.
      return this.replayAnswer(m, tillSessionId, request);
    }
    const plan = outcome.plan;

    // 5. The authorities, in CALL ORDER: the sale's, then one per cart line.
    const { inventoryAssertion, accountingAssertions } = this.sales.seamAuthority(plan);
    const removalAuthority = await this.authorization.authorize(m, 'pos.cart_remove_line', btx, [session.warehouseId]);
    const removals = snapshot.map((line) => ({
      line,
      assertion: this.authorization.mint(
        removalAuthority,
        buildInventoryPayload('pos.cart_remove_line', m.tenantId, m.businessId, [
          { kind: 'uuid', value: tillSessionId },
          { kind: 'uuid', value: line.cartLineId },
        ]),
      ),
    }));

    // 6. ONE transaction.
    await this.db.withBusinessInventoryAccountingTransaction(
      plan.authority.scope,
      [inventoryAssertion, ...removals.map((r) => r.assertion)],
      accountingAssertions,
      async (tx) => {
        // The lock is taken FIRST and in one order everywhere: the session,
        // then — inside `sale_commit` — the warehouse and the variants. One
        // order is what makes a deadlock impossible; a deadlock is a lock-order
        // defect and never a business outcome
        // (`[[daftar-lock-order-not-retry]]`), so there is no retry here.
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext('daftar.pos_checkout'), hashtext($1::text))`, [tillSessionId]);
        await this.sales.execute(tx, plan);
        await this.consume(tx, tillSessionId, removals);
        await this.verify(tx, m, tillSessionId, snapshot);
      },
    );

    return {
      tillSessionId,
      sale: await readSaleDto(this.db, m, request.saleId, false),
      consumedCartLineIds: snapshot.map((l) => l.cartLineId),
    };
  }

  /**
   * Step 8 of the atomic law: consume the snapshot, row by named row, through
   * Agent E's accepted `pos_cart_remove_line`.
   *
   * There is no `DELETE`, no table-level `UPDATE` and no "clear the basket"
   * statement anywhere in this file, and that is structural: `daftar_app`
   * holds `SELECT` only on `pos_cart_lines` (`0079:693`), so the only way a
   * tombstone can be written at all is this routine, one line at a time,
   * each consuming its own minted assertion. A replay could not issue
   * `DELETE all active lines` even if somebody wrote it.
   *
   * A routine that answers 0 removed nothing, which means the row was already
   * tombstoned by somebody else. That is the snapshot having moved, and it is
   * raised as such rather than tolerated as idempotence: THIS command's
   * snapshot included a line that no longer existed when the sale was made.
   */
  private async consume(
    tx: BusinessInventoryAccountingTransaction,
    tillSessionId: string,
    removals: readonly { readonly line: CartSnapshotLine; readonly assertion: string }[],
  ): Promise<void> {
    for (const { line } of removals) {
      await presentInventoryAssertion(tx, 'pos.cart_remove_line');
      const r = await tx.query<{ removed: number }>(`SELECT pos_cart_remove_line($1::uuid, $2::uuid) AS removed`, [tillSessionId, line.cartLineId]);
      const [row] = r.rows;
      if (row === undefined || Number(row.removed) !== 1) throw posRefusal('pos.checkout_cart_state_changed');
    }
  }

  /**
   * The verification, AFTER the tombstones and under their row locks: the
   * basket this sale was derived from is the basket that existed, and nothing
   * of this session is left live.
   *
   * It is one statement over the WHOLE session, not one per line, so a line
   * nobody named is still judged — which is the case that matters, because the
   * line nobody named is the one a concurrent scan added.
   */
  private async verify(
    tx: BusinessInventoryAccountingTransaction,
    scope: { readonly businessId: string },
    tillSessionId: string,
    snapshot: readonly CartSnapshotLine[],
  ): Promise<void> {
    const r = await tx.query<{ id: string; quantity: string; requested_discount_minor: string; live: boolean }>(
      `SELECT l.id::text AS id, l.quantity::text AS quantity, l.requested_discount_minor::text AS requested_discount_minor,
              (l.removed_at IS NULL) AS live
         FROM pos_cart_lines l
        WHERE l.business_id = $1::uuid AND l.till_session_id = $2::uuid
          AND (l.removed_at IS NULL OR l.id = ANY($3::uuid[]))`,
      [scope.businessId, tillSessionId, snapshot.map((l) => l.cartLineId)],
    );
    const bound = new Map(snapshot.map((l) => [l.cartLineId, l]));
    for (const row of r.rows) {
      const line = bound.get(row.id);
      // A live row this sale did not bind: a line was added between the
      // snapshot and the lock. Selling the old basket and leaving the new line
      // would be exactly the half-sold basket the law forbids.
      if (line === undefined) throw posRefusal('pos.checkout_cart_state_changed');
      if (row.live) throw posRefusal('pos.checkout_cart_state_changed');
      // The IDENTITY of the quantity and the discount, compared as the exact
      // fixed-point integers the sale was priced from — never as text and
      // never as a float. `12.5` and `12.5000` are the same quantity and the
      // text differs.
      if (parseQuantity(row.quantity) !== line.qtyQ4) throw posRefusal('pos.checkout_cart_state_changed');
      if (parseMinor(row.requested_discount_minor) !== line.discountMinor) throw posRefusal('pos.checkout_cart_state_changed');
    }
    // Every bound line must have been among the rows read back. One that was
    // not is a row that left the session entirely, which `0079` makes
    // impossible — so it is a defect, raised as one.
    const seen = new Set(r.rows.map((x) => x.id));
    if (snapshot.some((l) => !seen.has(l.cartLineId))) throw new Error('a consumed cart line is no longer readable in its own session');
  }

  /**
   * STEP 0. The replay proof, consulted before any current state is read.
   *
   * The digest is recomputed over the STORED sale's own lines plus the
   * CLIENT's stated header intent. That is the only honest way to judge a
   * replay of a cart-derived command: the cart it was derived from has been
   * consumed, so rebuilding the line set from the basket would compare this
   * request against a DIFFERENT basket and report a conflict for a correct
   * retry. The header fields — settlement mode, customer, both dates, the
   * note — are the client's, so a key reused over a different intent is still
   * a stable conflict, which is the whole purpose of the fingerprint.
   *
   * The SESSION is bound too, and not by a column: a POS sale's line ids ARE
   * cart line ids, so "every line of this stored sale is a cart line of this
   * till session" is a fact the existing schema already carries. A `saleId`
   * that names a sale born anywhere else is a conflict here, so one till
   * cannot answer "success" for another till's sale.
   */
  private async provenReplay(m: MembershipContext, tillSessionId: string, input: PosCheckoutRequest): Promise<PosCheckoutDto | null> {
    const rows = await this.db.scoped<{
      warehouse_id: string;
      commit_intent_sha256: string;
      line_id: string;
      product_id: string;
      variant_id: string;
      is_base: boolean;
      quantity: string;
      discount_txn_minor: string;
      in_session: boolean;
    }>(
      { tenantId: m.tenantId, businessId: m.businessId },
      `SELECT s.warehouse_id::text AS warehouse_id, s.commit_intent_sha256,
              it.id::text AS line_id, it.product_id::text AS product_id, it.variant_id::text AS variant_id, v.is_base,
              it.quantity::text AS quantity, it.discount_txn_minor::text AS discount_txn_minor,
              (c.id IS NOT NULL) AS in_session
         FROM sales s
         JOIN sale_items it ON it.business_id = s.business_id AND it.sale_id = s.id
         JOIN product_variants v ON v.business_id = it.business_id AND v.id = it.variant_id
         LEFT JOIN pos_cart_lines c ON c.business_id = s.business_id AND c.id = it.id AND c.till_session_id = $3::uuid
        WHERE s.business_id = $1::uuid AND s.id = $2::uuid
        ORDER BY it.line_no`,
      [m.businessId, input.saleId, tillSessionId],
    );
    const [header] = rows.rows;
    if (header === undefined) return null;
    // The sale exists. From here every exit is an ANSWER or a CONFLICT, and
    // never a fresh commit: the document identity has been spent.
    if (!rows.rows.every((r) => r.in_session)) throw posRefusal('pos.checkout_idempotency_conflict');
    const digest = saleCommitIntentSha256({
      tenantId: m.tenantId,
      businessId: m.businessId,
      saleId: input.saleId,
      settlementMode: input.settlementMode,
      customerId: input.customerId,
      warehouseId: header.warehouse_id,
      documentDate: input.documentDate,
      dueDate: input.dueDate,
      taxMinor: 0n,
      notes: input.notes,
      lines: rows.rows.map((r) => ({
        lineId: r.line_id,
        productId: r.product_id,
        merchantVariantId: r.is_base ? null : r.variant_id,
        qtyQ4: parseQuantity(r.quantity),
        discountMinor: parseMinor(r.discount_txn_minor),
      })),
    });
    if (digest !== header.commit_intent_sha256) throw posRefusal('pos.checkout_idempotency_conflict');
    return {
      tillSessionId,
      sale: await readSaleDto(this.db, m, input.saleId, true),
      // The ORIGINAL snapshot, named from the stored sale. A line scanned
      // after that sale is not in this list and is still in the basket.
      consumedCartLineIds: rows.rows.map((r) => r.line_id),
    };
  }

  /** The answer for the race `plan` catches: the sale is stored, this call wrote nothing. */
  private async replayAnswer(m: MembershipContext, tillSessionId: string, request: SaleCommitRequest): Promise<PosCheckoutDto> {
    return { tillSessionId, sale: await readSaleDto(this.db, m, request.saleId, true), consumedCartLineIds: request.lines.map((l) => l.lineId) };
  }

  /**
   * The sale request, built from the SESSION and the SNAPSHOT and from two
   * things the client is allowed to state: which sale this is, and how it
   * settles.
   *
   * ## ONE SALE LINE PER STOCK KEY, and why the basket is not copied straight
   *
   * The basket is APPEND-ONLY (`0079`): a second scan of one product is a
   * SECOND cart line, with its own id and its own discount request. The
   * accepted sale, by contrast, has ONE line per `(product, merchant variant)`
   * — `SaleCommitSchema`'s «a sale has one line per variant»
   * (`selling.schemas.ts:350`) and, underneath it, `sale_commit`'s own
   * `inventory.duplicate_line`, which is the stock writer refusing two
   * movements on one key in one call.
   *
   * That law is the SALE WRITER'S and this slice may not change it, so a
   * basket with two scans of one product is MERGED here: the quantities are
   * summed as exact Q4 integers and the discount requests as exact minor
   * units. Nothing is rounded, nothing is averaged and no price is involved —
   * every figure is still derived by `plan` from the catalogue, over the
   * summed quantity. The RECEIPT therefore shows one line for two scans of
   * one tin of paint, which is what a receipt shows.
   *
   * ## The identity the merge keeps
   *
   * The merged line's `lineId` is the FIRST cart line of its group, in
   * `line_no` order. So every sale line id is still a cart line id of this
   * session — which is what `provenReplay` proves a stored sale by — and the
   * CONSUMPTION is bound to the WHOLE snapshot and not to the representatives:
   * `consume` tombstones every row of `snapshot`, followers included, and
   * `verify` requires every one of them to be gone. A merged follower left
   * live would be a partially consumed basket, and the verification refuses
   * exactly that.
   *
   * `variantId` is the MERCHANT variant, or `null` where the cart's stock key
   * is the hidden base variant — which never leaves the server (P3-AL-52) and
   * which `resolveVariants` re-derives from the product inside `plan`.
   * `quantity` is the snapshot's own Q4 integer rendered back through the
   * canonical formatter, so the value the sale is priced from is the value the
   * rows hold and not a text round trip.
   */
  private saleRequest(input: PosCheckoutRequest, session: TillSessionFacts, snapshot: readonly CartSnapshotLine[]): SaleCommitRequest {
    return {
      saleId: input.saleId,
      settlementMode: input.settlementMode,
      customerId: input.customerId,
      warehouseId: session.warehouseId,
      documentDate: input.documentDate,
      dueDate: input.dueDate,
      taxMinor: '0',
      notes: input.notes,
      lines: mergeByStockKey(snapshot).map((g) => ({
        lineId: g.cartLineId,
        productId: g.productId,
        variantId: g.merchantVariantId,
        quantity: formatQuantity(g.qtyQ4),
        discountMinor: g.discountMinor.toString(10),
      })),
    };
  }

  /** The session's own facts. A session of another business is invisible under RLS and reads as absent. */
  private async readSession(m: MembershipContext, tillSessionId: string): Promise<TillSessionFacts | null> {
    const r = await this.db.scoped<{ branch_id: string; warehouse_id: string; status: string; opened_by: string; currency_code: string }>(
      { tenantId: m.tenantId, businessId: m.businessId },
      `SELECT s.branch_id::text AS branch_id, s.warehouse_id::text AS warehouse_id, s.status, s.opened_by::text AS opened_by, s.currency_code
         FROM pos_till_sessions s WHERE s.business_id = $1::uuid AND s.id = $2::uuid`,
      [m.businessId, tillSessionId],
    );
    const [row] = r.rows;
    if (row === undefined) return null;
    return { branchId: row.branch_id, warehouseId: row.warehouse_id, status: row.status, openedBy: row.opened_by, currencyCode: row.currency_code };
  }

  /**
   * THE SNAPSHOT READ. Every live line of the session, in display order, with
   * the four identities and the two figures a sale line needs — and NOTHING
   * priced: `pos_cart_lines` holds no price, no total and no currency, by
   * construction (`0079:448`), so there is no cached figure here for the sale
   * to adopt.
   */
  private async readCartSnapshot(m: MembershipContext, tillSessionId: string): Promise<readonly CartSnapshotLine[]> {
    const r = await this.db.scoped<{
      id: string;
      line_no: number;
      product_id: string;
      variant_id: string;
      is_base: boolean;
      quantity: string;
      requested_discount_minor: string;
    }>(
      { tenantId: m.tenantId, businessId: m.businessId },
      `SELECT l.id::text AS id, l.line_no, l.product_id::text AS product_id, l.variant_id::text AS variant_id,
              v.is_base, l.quantity::text AS quantity, l.requested_discount_minor::text AS requested_discount_minor
         FROM pos_cart_lines l
         JOIN product_variants v ON v.business_id = l.business_id AND v.id = l.variant_id
        WHERE l.business_id = $1::uuid AND l.till_session_id = $2::uuid AND l.removed_at IS NULL
        ORDER BY l.line_no`,
      [m.businessId, tillSessionId],
    );
    return r.rows.map((row) => ({
      cartLineId: row.id,
      lineNo: row.line_no,
      productId: row.product_id,
      // The hidden base variant never leaves the server: a simple product's
      // line names NO merchant variant, and `resolveVariants` finds the base
      // one again from the product (P3-AL-52).
      merchantVariantId: row.is_base ? null : row.variant_id,
      qtyQ4: parseQuantity(row.quantity),
      discountMinor: parseMinor(row.requested_discount_minor),
    }));
  }
}

/**
 * ONE GROUP PER `(product, merchant variant)`, in first-appearance order,
 * with the quantities and the discount requests summed as EXACT INTEGERS.
 *
 * Pure, exported and database-free on purpose: the claim "two scans of one
 * product become one sale line carrying their total" is arithmetic, and
 * arithmetic is proved by driving the function, not by reading a sale back.
 * There is NO money here beyond the discount REQUEST the cart already stored
 * — no price, no gross, no net, no total — because every one of those is
 * derived by the sale writer from the catalogue, over the quantity this
 * function produces.
 */
export function mergeByStockKey(snapshot: readonly CartSnapshotLine[]): readonly CartSnapshotLine[] {
  const groups = new Map<
    string,
    { lineId: string; lineNo: number; productId: string; merchantVariantId: string | null; qtyQ4: bigint; discountMinor: bigint }
  >();
  for (const line of snapshot) {
    const key = `${line.productId}:${line.merchantVariantId ?? ''}`;
    const found = groups.get(key);
    if (found === undefined) {
      groups.set(key, {
        lineId: line.cartLineId,
        lineNo: line.lineNo,
        productId: line.productId,
        merchantVariantId: line.merchantVariantId,
        qtyQ4: line.qtyQ4,
        discountMinor: line.discountMinor,
      });
      continue;
    }
    found.qtyQ4 += line.qtyQ4;
    found.discountMinor += line.discountMinor;
  }
  return [...groups.values()].map((g) => ({
    cartLineId: g.lineId,
    lineNo: g.lineNo,
    productId: g.productId,
    merchantVariantId: g.merchantVariantId,
    qtyQ4: g.qtyQ4,
    discountMinor: g.discountMinor,
  }));
}

/** The five establishment facts of a till session, read once. */
interface TillSessionFacts {
  readonly branchId: string;
  readonly warehouseId: string;
  readonly status: string;
  readonly openedBy: string;
  readonly currencyCode: string;
}

/** ONE BOUND CART ROW. The sale line's identity and the row's identity are the same uuid, and that is the law. */
export interface CartSnapshotLine {
  readonly cartLineId: string;
  readonly lineNo: number;
  readonly productId: string;
  /** `null` where the cart's stock key is the hidden base variant (P3-AL-52). */
  readonly merchantVariantId: string | null;
  readonly qtyQ4: bigint;
  readonly discountMinor: bigint;
}

/** Re-exported so a suite can name the plan type without importing the selling module. */
export type { SaleCommitPlan, InventoryCommandAuthority };
