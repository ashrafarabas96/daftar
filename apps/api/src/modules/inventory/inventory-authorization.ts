import { Inject, Injectable } from '@nestjs/common';
import { AppError, hasPermission, type Permission } from '@daftar/domain-core';
import type { InventoryOperationCode, InventoryPayload } from '@daftar/inventory';
import { Database, type BusinessScope } from '../../infra/database';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { InventoryAssertionMinterService } from './inventory-assertion.minter';
import type { BusinessTransactionId } from './business-transaction';

/**
 * What each operation kind demands of the actor before an assertion for it
 * may be minted (P3-AL-55 §E, "Application check before minting").
 *
 * - `warehouses`: the domain permission, plus every affected warehouse
 *   reachable from the actor's branch scope (P3-AL-39). An operation that
 *   affects no warehouse — product configuration — passes the scope half
 *   trivially; a transfer lists both of its warehouses.
 * - `business_wide`: the domain permission, plus `branch_scope_mode = 'all'`
 *   (P3-AL-15 §B). An assigned-scope actor never reaches the minter for such
 *   a kind, whatever warehouses or branches it names.
 *
 * One row per registered kind and no default: a kind registered in
 * `@daftar/inventory` without a row here does not compile.
 */
/**
 * A permission that may authorize MINTING. Every `*.view` key is excluded by
 * construction: a read mints nothing, so no read permission may appear in
 * `OPERATION_AUTHORITY` — naming `customers.view`, `inventory.view` or any other
 * read key in a row below does not compile. This is the type-level form of the
 * P4-S1 rule that a till holding `customers.view` cannot mint a customer write.
 */
type MintingPermission = Exclude<Permission, `${string}.view`>;

const OPERATION_AUTHORITY: Readonly<
  Record<InventoryOperationCode, { readonly permission: MintingPermission; readonly scope: 'warehouses' | 'business_wide' }>
> = {
  'inventory.configure_product': { permission: 'inventory.adjust', scope: 'warehouses' },
  'structure.associate_warehouse_branch': { permission: 'warehouse.manage', scope: 'business_wide' },
  'structure.dissociate_warehouse_branch': { permission: 'warehouse.manage', scope: 'business_wide' },
  // P3-S3 (PHASE_3_S3_CONTRACT A-21): every movement command is scoped by the
  // warehouses it affects — both of a transfer, the document's for the rest.
  'inventory.transfer': { permission: 'inventory.transfer', scope: 'warehouses' },
  'inventory.adjust': { permission: 'inventory.adjust', scope: 'warehouses' },
  'inventory.damage': { permission: 'inventory.adjust', scope: 'warehouses' },
  'inventory.stocktake_open': { permission: 'inventory.stocktake', scope: 'warehouses' },
  'inventory.stocktake_count': { permission: 'inventory.stocktake', scope: 'warehouses' },
  'inventory.stocktake_finalize': { permission: 'inventory.stocktake', scope: 'warehouses' },
  // Review F4 (coordinator ruling): an opening posts to opening equity and
  // reveals the business's accounting position (its Inventory line), so it is
  // a business-wide act — never available to an actor limited to assigned
  // branches, whatever warehouses it names.
  'inventory.opening': { permission: 'inventory.adjust', scope: 'business_wide' },
  // P3-S4 (PHASE_3_S4_CONTRACT A-03, TL-4): a supplier is business-wide master
  // data shared by every branch, so its commands are permission-only — they
  // name no warehouse, and `suppliers.manage` is assigned deliberately.
  'supplier.create': { permission: 'suppliers.manage', scope: 'warehouses' },
  'supplier.update': { permission: 'suppliers.manage', scope: 'warehouses' },
  'supplier.archive': { permission: 'suppliers.manage', scope: 'warehouses' },
  'supplier.reactivate': { permission: 'suppliers.manage', scope: 'warehouses' },
  // A purchase is scoped by its warehouse — and, when a replace moves the
  // draft, by the previous one too.
  'purchase.draft': { permission: 'purchases.manage', scope: 'warehouses' },
  'purchase.cancel': { permission: 'purchases.manage', scope: 'warehouses' },
  'purchase.receive': { permission: 'purchases.receive', scope: 'warehouses' },
  // P3-S5 (PHASE_3_S5_CONTRACT A-03): a return is scoped by the warehouse the
  // goods leave (TL-5); a reversal undoes a receipt, so it needs receipt
  // authority over the purchase's warehouse (TL-4).
  'purchase.return': { permission: 'purchases.return', scope: 'warehouses' },
  'purchase.reverse': { permission: 'purchases.receive', scope: 'warehouses' },
  // P3-S6 (PHASE_3_S6_CONTRACT A-03): a payment method is business-wide
  // master data naming an account of the chart, so its commands are
  // permission-only (the S4 supplier precedent) under the chart authority.
  'payment.create_method': { permission: 'accounting.chart.manage', scope: 'warehouses' },
  'payment.update_method': { permission: 'accounting.chart.manage', scope: 'warehouses' },
  'payment.deactivate_method': { permission: 'accounting.chart.manage', scope: 'warehouses' },
  'payment.activate_method': { permission: 'accounting.chart.manage', scope: 'warehouses' },
  // A payment is scoped by every allocated purchase's warehouse (AL-39); a
  // credit allocation and a refund move a supplier-wide credit, so they are
  // business-wide acts (TL-5).
  'supplier.pay': { permission: 'suppliers.pay', scope: 'warehouses' },
  'supplier.allocate_credit': { permission: 'suppliers.pay', scope: 'business_wide' },
  'supplier.receive_refund': { permission: 'suppliers.pay', scope: 'business_wide' },
  // Phase 3 corrective (0072 R-96): writing off a purchase's sub-unit AP
  // residue settles supplier AP, so it is the settlement permission, and
  // business-wide like every settlement (S6 TL-5).
  'purchase.write_off_residue': { permission: 'suppliers.pay', scope: 'business_wide' },
  // P4-S1 (lock P4-AL-35, P4-AL-39; gap G-5): a customer is business-wide
  // master data shared by every branch — the exact mirror of the P3-S4
  // supplier, so its commands are permission-only under `scope: 'warehouses'`,
  // which passes the scope half trivially because they name no warehouse
  // (the `supplier.*` rows at :44-47 and the `payment.*_method` rows at :61-64
  // are the two precedents, and both read this way for the same reason).
  //
  // `customers.manage` is ORDINARY, not sensitive (P4-AL-37: master data is not
  // a value movement), and it is a MANAGER default but NOT a cashier one
  // (P4-AL-35, `OD-P4-01` OPTION A) — a till may look a customer up with the
  // read key and may not edit the master record. That read key is deliberately
  // absent from this table: it grants no write, and a read mints no assertion.
  // The `Permission` type above is narrowed so that absence is a compile error
  // rather than a convention.
  'customer.create': { permission: 'customers.manage', scope: 'warehouses' },
  'customer.update': { permission: 'customers.manage', scope: 'warehouses' },
  'customer.archive': { permission: 'customers.manage', scope: 'warehouses' },
  'customer.reactivate': { permission: 'customers.manage', scope: 'warehouses' },
  // P4-S2 (docs/PHASE_4_S2_CONTRACT.md A-04; lock P4-AL-35, P4-AL-39,
  // P4-AL-40): a sale is scoped by THE WAREHOUSE THE STOCK LEAVES, like every
  // other movement command. `sales.create` is the minting key; `sales.view`
  // cannot appear here and would not compile, which is the point of the
  // narrowed `MintingPermission`.
  //
  // Two further authority facts the sale needs are deliberately NOT expressed
  // here, because this table is one permission per kind and conflating them
  // would make a single row carry three different decisions:
  //
  //   - a CREDIT sale also requires `receivables.view` (P4-AL-35's matrix
  //     row), checked by the route's own authority table in
  //     `selling-permissions.ts`;
  //   - a non-zero line or cart discount also requires the SENSITIVE
  //     `sales.discount` (P4-AL-35, P4-AL-37), checked by the service against
  //     the request before anything is minted, and refused — never silently
  //     zeroed, because a silently-zeroed discount charges the customer more
  //     than the cashier told them.
  'sale.commit': { permission: 'sales.create', scope: 'warehouses' },
  // P4-S3 (docs/PHASE_4_S3_MIGRATION_DESIGN.md; lock P4-AL-18, P4-AL-39,
  // OD-P4-09): a till session and its basket exist only to ring up a sale, so
  // `sales.create` — the cashier's own key (`permissions.ts:214`) — is the
  // minting key for all four kinds. No `pos.*` permission is invented: the
  // accepted permission vocabulary is sealed, and this slice was not given a
  // ruling that widens it.
  //
  // All four are `scope: 'warehouses'`, and for these kinds that half is NOT
  // trivial the way `supplier.*` and `customer.*` are. An open names its
  // warehouse, and the three later kinds are called with THE SESSION'S
  // warehouse, read from `pos_till_sessions`. Re-checking it on every cart
  // write is deliberate: a cashier's branch scope can be narrowed in the
  // middle of a shift, and a basket that kept writing because the scope was
  // checked once at open would be authority outliving the decision that
  // granted it.
  //
  // `business_wide` would be wrong for all four. A till is bound to one branch
  // by `pos_till_sessions.branch_id`, so an assigned-scope cashier — which is
  // what a cashier normally is — must be able to open and work one; demanding
  // `branch_scope_mode = 'all'` would lock every ordinary cashier out of the
  // point of sale, which is the opposite of what P4-AL-18 describes.
  //
  // Two authority facts are deliberately NOT in these rows, for the reason the
  // `sale.commit` row above gives — one permission per kind:
  //
  //   - a non-zero `requested_discount_minor` on a cart line also requires the
  //     SENSITIVE `sales.discount` (P4-AL-35, P4-AL-37), checked by the cart
  //     service against the request before anything is minted and REFUSED,
  //     never silently zeroed;
  //   - only the cashier who opened a session may write to it or close it.
  //     That is not a permission at all and is not checked here: it is
  //     `pos_cart_lines_session_actor_fk` against `pos_till_sessions_actor_uq`
  //     in `0079`, so it holds against the database rather than against this
  //     table (OD-P4-09).
  'pos.session_open': { permission: 'sales.create', scope: 'warehouses' },
  'pos.session_close': { permission: 'sales.create', scope: 'warehouses' },
  'pos.cart_set_line': { permission: 'sales.create', scope: 'warehouses' },
  'pos.cart_remove_line': { permission: 'sales.create', scope: 'warehouses' },
  // P4-S4 (R-86, R-87): taking a customer's money and spending a credit they
  // already hold. `payments.collect` is the minting key for both — it is the
  // accepted vocabulary's own settlement key and no `receivables.*` write key
  // is invented, because the permission registry is sealed and this slice was
  // given no ruling that widens it.
  //
  // Both are `scope: 'warehouses'`, and for these two that half passes
  // TRIVIALLY, exactly as it does for the `supplier.*` master-data rows at
  // :55-58 and the `customer.*` rows at :100-103: neither command names a
  // warehouse, both services call `authorize(m, code, btx)` with no warehouse
  // ids, and the `affected.length > 0` arm below is therefore never entered.
  //
  // `business_wide` WOULD BE WRONG, and not merely redundant. It demands
  // `branchScopeMode === 'all'` (:234-237), and a cashier is normally
  // assigned-scope while `payments.collect` is the cashier's OWN key — one of
  // the five the role default holds (`permissions.ts:214`). So requiring
  // business-wide scope would hand every ordinary cashier the key to collect a
  // payment and then refuse them the command, which is the `pos.*` mistake the
  // block above refuses for the same reason.
  //
  // This is a DEPARTURE from the supplier mirror, and a deliberate one. The
  // P3-S6 rows at :80-81 make `supplier.allocate_credit` and
  // `supplier.receive_refund` business-wide under TL-5, because moving a
  // supplier-wide credit reveals the business's AP position to an actor who
  // holds only some branches. The customer side cannot follow that: the key
  // that authorizes it is a till key by role default, so the S6 rule would
  // close the point of sale. The two slices' settlements are scoped by WHO
  // normally holds the key, not by a shared shape.
  'customer.collect_payment': { permission: 'payments.collect', scope: 'warehouses' },
  'customer.apply_credit': { permission: 'payments.collect', scope: 'warehouses' },
};

/**
 * The proof that one domain command has established its own authority
 * (P3-AL-33): the permission its operation kind requires, and the branch /
 * warehouse scope over every warehouse it affects (P3-AL-39).
 *
 * Only `InventoryAuthorizationService.authorize` issues one, and `mint`
 * accepts nothing else: an object of the same shape built anywhere else is
 * refused, because it is not in the set of proofs this module issued. So "a
 * domain command that has proven its own authority may mint" is a property of
 * the code path, not a flag, an option or a boolean anyone could pass as
 * `true`.
 */
export interface InventoryCommandAuthority {
  /**
   * The seam scope. The actor is the authenticated member; there is no other
   * source for it. The trace id is the one the boundary minted for this operation.
   */
  readonly scope: BusinessScope;
  readonly opCode: InventoryOperationCode;
  /** Every warehouse whose scope was checked, de-duplicated. */
  readonly warehouseIds: readonly string[];
}

/** The proofs `authorize` issued. Weak, so a proof lives exactly as long as its command. */
const issued = new WeakSet<InventoryCommandAuthority>();

/**
 * The authorization seam every Phase 3 command uses (P3-AL-33, P3-AL-39,
 * P3-AL-55 §I): domain permission, then warehouse scope over EVERY affected
 * warehouse, then — only for a command that passed both — the `invctl/1`
 * assertion over the command's exact payload.
 *
 * Branch scope comes from the `MembershipContext` the guard already resolved
 * (`branchScopeMode`, `allowedBranchIds` — loaded from `member_branch_scopes`)
 * and is not re-derived here. The one thing added is the warehouse half: an
 * assigned-scope actor reaches a warehouse only through `branch_warehouses`,
 * from a branch in their set (P3-AL-15). As in the accepted warehouse list,
 * an archived branch in that set grants nothing.
 *
 * Every check here runs BEFORE any seam is opened. The database then verifies
 * the signed result of this decision, not the membership graph (P3-AL-54 §E).
 */
@Injectable()
export class InventoryAuthorizationService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(InventoryAssertionMinterService) private readonly minter: InventoryAssertionMinterService,
  ) {}

  /**
   * Establish the authority for one command of kind `opCode` affecting
   * `warehouseIds` (lowercase canonical UUIDs; empty when the command affects
   * none). Refuses with 403 before anything is minted.
   *
   * `businessTransactionId` is the operation's trace id, minted once at the
   * API boundary (P3-AL-35). It rides in the seam scope so the routine can
   * copy it into its audit row; it is observability and plays no part in the
   * decision made here.
   */
  async authorize(
    m: MembershipContext,
    opCode: InventoryOperationCode,
    businessTransactionId: BusinessTransactionId,
    warehouseIds: readonly string[] = [],
  ): Promise<InventoryCommandAuthority> {
    const rule = OPERATION_AUTHORITY[opCode];
    if (!hasPermission(m.roles, rule.permission)) {
      throw AppError.forbidden(`Missing permission: ${rule.permission}`);
    }

    const affected = [...new Set(warehouseIds)];
    if (rule.scope === 'business_wide') {
      if (m.branchScopeMode !== 'all') {
        throw new AppError('FORBIDDEN', 'This command requires business-wide branch scope', 403, { inventoryCode: 'inventory.business_wide_scope_required' });
      }
    } else if (m.branchScopeMode === 'assigned' && affected.length > 0) {
      await this.assertWarehousesInScope(m, affected);
    }

    const authority: InventoryCommandAuthority = Object.freeze({
      scope: Object.freeze({ tenantId: m.tenantId, businessId: m.businessId, actorUserId: m.userId, businessTransactionId }),
      opCode,
      warehouseIds: Object.freeze(affected),
    });
    issued.add(authority);
    return authority;
  }

  /**
   * Mint the `invctl/1` assertion for an authorized command's exact payload.
   * The operation kind of the payload must be the one that was authorized:
   * an authority established for one kind cannot sign another.
   */
  mint(authority: InventoryCommandAuthority, payload: InventoryPayload): string {
    if (!issued.has(authority)) {
      throw new Error('an inventory assertion is minted only for an authority established by InventoryAuthorizationService');
    }
    if (payload.opCode !== authority.opCode) {
      throw new Error(`an authority established for ${authority.opCode} cannot sign a ${payload.opCode} payload`);
    }
    return this.minter.mint({
      actorUserId: authority.scope.actorUserId,
      tenantId: authority.scope.tenantId,
      businessId: authority.scope.businessId,
      opCode: payload.opCode,
      payloadSha256: payload.sha256,
    });
  }

  /**
   * P3-AL-39 for an assigned-scope actor: every affected warehouse must be
   * associated, through `branch_warehouses`, with at least one ACTIVE branch
   * in the actor's scope. Default deny — no assigned branch reaches nothing.
   * A warehouse of another business is invisible under row level security
   * and is refused exactly like one out of scope, so the answer does not
   * reveal whether it exists.
   */
  private async assertWarehousesInScope(m: MembershipContext, warehouseIds: readonly string[]): Promise<void> {
    const allowedBranchIds = [...m.allowedBranchIds];
    const reachable =
      allowedBranchIds.length === 0
        ? new Set<string>()
        : new Set(
            (
              await this.db.scoped<{ warehouse_id: string }>(
                { tenantId: m.tenantId, businessId: m.businessId },
                `SELECT DISTINCT bw.warehouse_id
                   FROM branch_warehouses bw
                   JOIN branches b ON b.business_id = bw.business_id AND b.id = bw.branch_id AND b.status = 'active'
                  WHERE bw.business_id = $1
                    AND bw.warehouse_id = ANY($2::uuid[])
                    AND bw.branch_id = ANY($3::uuid[])`,
                [m.businessId, warehouseIds, allowedBranchIds],
              )
            ).rows.map((r) => r.warehouse_id),
          );
    if (warehouseIds.some((id) => !reachable.has(id))) {
      throw new AppError('FORBIDDEN', 'A warehouse is outside your branch scope', 403, { inventoryCode: 'inventory.warehouse_out_of_scope' });
    }
  }
}
