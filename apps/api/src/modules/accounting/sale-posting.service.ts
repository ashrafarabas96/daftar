import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import {
  deriveSaleCommitPostings,
  mintSaleCommitAssertions,
  type AccountingAssertionMinter,
  type SaleCogsFacts,
  type SaleCommitPostings,
  type SaleInvoiceFacts,
} from '@daftar/accounting';
import { hasPermission } from '@daftar/domain-core';
import { AccountingAssertionMinterService } from './accounting-assertion.minter';
import type { MembershipContext } from '../tenancy/tenancy.service';

/**
 * The accounting authority of a sale commit (P4-S2; P4-AL-16, P4-AL-39).
 *
 * The sale command owns the sale: the basket, the prices, the stock movements,
 * the invoice and its number. It does NOT own the authority to post, and this
 * service is the only place in the process where that authority is minted for
 * a sale. A selling service that minted its own assertion would be a second
 * posting authority with no permission check in front of it, which is exactly
 * what "no direct financial write outside the accounting authority" forbids.
 *
 * ── Why this is a permission check and not only a derivation ─────────────
 *
 * `[[daftar-execute-is-reachability-not-authority]]`. `EXECUTE` on
 * `accounting_post_entry` is granted to `daftar_app` (`0045:867`), so anything
 * holding an app connection can reach the primitive; what the primitive trusts
 * is the HMAC-signed assertion and nothing else. The assertion is therefore
 * the authority, minting it is the authorizing act, and the check belongs at
 * the mint. The matrix of P4-AL-35 is applied here in full:
 *
 *   a cash sale    `sales.create`
 *   a credit sale  `sales.create` + `receivables.view`
 *
 * The second key on the credit arm is not decoration. A credit sale creates a
 * receivable, and a till that may sell for cash but may not see what customers
 * owe has no business creating debt — which is why the cashier's default set
 * holds `sales.create` and `receivables.view` is the delegation that turns a
 * till into a credit desk.
 *
 * ── What is deliberately not expressible here ───────────────────────────
 *
 * There is no `mintTrusted`, no `skipPermission` and no parameter that could
 * carry an actor from a DTO: the actor is `MembershipContext.userId`. There is
 * no amount parameter either — every figure comes from the resolved
 * server-side facts the caller read from the catalogue, the invoice it just
 * wrote and the movements the stock writer just returned (P4-AL-18). A total
 * arriving from a POS client reaches no field of this method.
 */
@Injectable()
export class SalePostingService {
  constructor(@Inject(AccountingAssertionMinterService) private readonly minter: AccountingAssertionMinter) {}

  /**
   * Derive both postings of a sale commit and mint their two assertions, in
   * posting order, for presentation to the seam.
   *
   * **Two postings, or one.** A sale that released no stock value has no cost
   * of goods to post (`saleCogsReleasedBaseMinor`), so `postings.cogs` is
   * `null` and exactly one assertion is minted. The caller passes the array
   * through to the seam unchanged and does not assume its length.
   *
   * The returned assertions are passed to
   * `withBusinessInventoryAccountingTransaction` as its ordered
   * `accountingAssertions`, and `AccountingAssertionSequence` then hands out
   * the k-th one only for a posting whose `(sourceType, sourceId)` matches its
   * claims — so the COGS authority cannot be spent on the revenue entry even
   * by a caller that posts them in the wrong order.
   *
   * Both are minted BEFORE the transaction opens, which is the seam's
   * contract. The consequence for the COGS figure is documented on
   * `mintSaleCommitAssertions`: it is a prediction, compared against the stock
   * writer's own integers by `accounting_post_entry`'s fingerprint recompute
   * and again by the deferred `accounting_sale_entry_complete` trigger, so a
   * stale prediction is a refused sale and never a misstated cost.
   */
  authorizeSaleCommit(
    membership: MembershipContext,
    invoice: SaleInvoiceFacts,
    cogs: SaleCogsFacts,
  ): { readonly postings: SaleCommitPostings; readonly assertions: readonly [string] | readonly [string, string] } {
    if (!hasPermission(membership.roles, 'sales.create')) {
      throw new ForbiddenException('sales.create is required to commit a sale');
    }
    if (invoice.settlementKind === 'credit' && !hasPermission(membership.roles, 'receivables.view')) {
      throw new ForbiddenException('receivables.view is required to sell on credit: a sale that creates a receivable is not a cash sale');
    }
    if (invoice.businessId !== membership.businessId || invoice.tenantId !== membership.tenantId) {
      throw new ForbiddenException('a sale may only be posted for the business the membership resolved');
    }
    if (cogs.businessId !== membership.businessId || cogs.tenantId !== membership.tenantId) {
      throw new ForbiddenException('a sale may only be posted for the business the membership resolved');
    }
    // Branch scope is enforced where tenant scope is (P4-AL-40): an assigned
    // member may not post a sale of a branch outside their scope. The RLS
    // policies refuse the rows as well — this is not the only line of defence,
    // it is the one that produces a named refusal instead of zero rows.
    if (membership.branchScopeMode === 'assigned' && !membership.allowedBranchIds.includes(invoice.branchId)) {
      throw new ForbiddenException('a sale may only be committed for a branch in the member branch scope');
    }
    const postings = deriveSaleCommitPostings(invoice, cogs);
    // ONE assertion when `postings.cogs` is null — a sale that released no
    // stock value posts revenue only, and a fabricated COGS assertion would
    // make it uncommittable. The seam is handed exactly this array, so its
    // LENGTH is what tells the seam how many postings to expect; the caller
    // never counts them itself.
    const assertions = mintSaleCommitAssertions(this.minter, postings, invoice, membership.userId);
    return { postings, assertions };
  }
}
