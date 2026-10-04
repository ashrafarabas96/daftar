import type { Provider } from '@nestjs/common';
import { CustomerCreditApplicationService } from './customer-credit-application.service';
import { CustomerPaymentService } from './customer-payment.service';
import { ReceivablesReadService } from './receivables-reads';

/**
 * The P4-S4 receivables providers, as the two merchant compositions spread
 * them.
 *
 * It is deliberately NOT a Nest `@Module` imported by the compositions, for
 * the reason `purchasingProviders()` and `sellingProviders()` both document:
 * these services depend on providers composed INLINE by `AppModule` and
 * `MerchantApiModule` — `Database`, `InventoryAuthorizationService`,
 * `AccountingAssertionMinterService` and `DatabaseAccountingPostingAdapter` —
 * and a child module's controller would not appear in the composition's own
 * `controllers` list, which `tests/integration/process-composition.test.ts`
 * holds both processes to.
 *
 * DAFTAR composes Nest TWICE, and a controller registered in only one of them
 * is a route that cannot be tested. `ReceivablesController` is registered in
 * both.
 */
export function receivablesProviders(): Provider[] {
  return [CustomerPaymentService, CustomerCreditApplicationService, ReceivablesReadService];
}

/**
 * The controller both compositions must register — the `P4_S2_REQUIRED_CONTROLLERS`
 * precedent (`selling.module.ts`), and for the same reason.
 */
export const P4_S4_REQUIRED_CONTROLLERS: readonly string[] = Object.freeze(['ReceivablesController']);

/**
 * EVERYTHING THIS SLICE NEEDS THAT IS OUTSIDE THIS AGENT'S FILE OWNERSHIP.
 *
 * Stated here rather than made, exactly as `selling.module.ts` states the
 * wiring P4-S2 owed to `app.module.ts` and `merchant-api.module.ts`. Each row
 * names a file, the edit and why the HTTP side cannot work without it. Nothing
 * here is optional and nothing here is this agent's to write.
 *
 * Until the first three rows land, both commands refuse
 * `customer_payment.registry_incomplete` (500) at the first call, naming the
 * files — a loud, single, documented seam rather than a silent wrong hash.
 */
export const P4_S4_REQUIRED_WIRING: readonly { readonly file: string; readonly edit: string; readonly why: string }[] = Object.freeze([
  Object.freeze({
    file: 'packages/inventory/src/payload.ts',
    edit: "add an `InventoryP4S4OperationCode = 'customer.collect_payment' | 'customer.apply_credit'`, its `INVENTORY_P4_S4_OPERATION_CODES` array, both into `InventoryOperationCode` / `INVENTORY_OPERATION_CODES`, and one `INVENTORY_PAYLOAD_SCHEMAS` entry per code matching `receivables-payload.ts`' field order exactly",
    why: '`canonicalInventoryPayload` cannot hash a payload whose op code has no field schema, so no `invctl/1` assertion can be minted for either command. `receivables-payload.ts` is the bridge that holds until then, and its `P4S4PayloadRegistryTripwire` stops compiling the day this lands.',
  }),
  Object.freeze({
    file: 'apps/api/src/modules/inventory/inventory-authorization.ts',
    edit: "add two `OPERATION_AUTHORITY` rows — `'customer.collect_payment': { permission: 'payments.collect', scope: 'warehouses' }` and `'customer.apply_credit': { permission: 'payments.collect', scope: 'warehouses' }`",
    why: "`OPERATION_AUTHORITY` is a `Record<InventoryOperationCode, …>` with no default, so the file stops compiling the moment the package registers the codes. `scope: 'warehouses'` passes the scope half trivially because neither command names a warehouse — the accepted `supplier.*` and `customer.*` shape. `business_wide` would be wrong: a cashier is normally assigned-scope and `payments.collect` is their own key (`permissions.ts:214`).",
  }),
  Object.freeze({
    file: 'packages/accounting/src/post.ts',
    edit: "add `'customer_payment_allocation'`, `'customer_credit_application'` and `'customer_credit'` to `DOMAIN_SOURCE_TYPES`",
    why: '`mintDomainPostingAssertion` refuses a command whose source type is not domain-owned, so no entry of this slice can be signed. It must NOT also join `DOMAIN_REVERSIBLE_SOURCE_TYPES`: reversal is P4-S6.',
  }),
  Object.freeze({
    file: 'infrastructure/database/migrations/0081_*.sql (Agent E)',
    edit: "register the source types and `('post', …)` operation kinds, widen `accounting_reversals_20_domain_source_guard` with each of them (the S-P4-02 deferred seam, `scripts/phase4-s1-gate.ts:1141-1153`), and expose `customer_collect_payment` / `customer_apply_credit` with the signatures `CUSTOMER_COLLECT_PAYMENT_SQL` and `CUSTOMER_APPLY_CREDIT_SQL` assume",
    why: 'the HTTP side calls those two routines by name and argument order; a different arity or order changes `customer-payment.service.ts`, `customer-credit-application.service.ts` and `receivables-payload.ts`, which must stay byte-identical to each other.',
  }),
  Object.freeze({
    file: 'tests/golden-regression/phase4-s4/settlement-path.ts',
    edit: 'drop the four DERIVED figures from the request bodies — `releasedBeforeMinor`, `carryingReleasedMinor`, `arDustBaseMinor`, `realizedFxMinor` on a payment allocation, and those plus `creditRemainingBeforeMinor`, `creditCarryingReleasedMinor`, `creditDustBaseMinor` on a credit application. Every other field name matches, including `creditId` on the request, `creditAmountConsumedMinor` and `customerId`',
    why: "`CustomerPaymentSchema` and `CustomerCreditApplicationSchema` are `.strict()`, so those keys are unknown-key refusals. «Caller computes, the database re-verifies» is the SERVICE→ROUTINE boundary, not the CLIENT→API one: the accepted `POST /v1/supplier-payments` body carries four fields per allocation and `supplier-payment.service.ts` derives the rest. Taking them from a client breaks P4-AL-18 and poisons the request-only intent digest, turning an FX movement between retries into a false `idempotency_conflict`. `receivables.schemas.ts`' header states the full argument.",
  }),
  Object.freeze({
    file: 'scripts/phase4-s1-gate.ts (+ the s4 gate) and tests/golden-regression/phase4/01-cross-tenant.golden.test.ts',
    edit: "add this slice's four routes to the Phase 4 route enumeration and the cross-tenant golden's list, with ALLOW/DENY pairs for A/A2 (same tenant, same owner) and B (other tenant), at the API and again at SQL",
    why: "the golden asserts `discoverPhase4Routes()` equals its own list, so a new route without a golden row is red. `RECEIVABLES_ROUTE_AUTHORITY` is the list to copy. `tests/**` and `scripts/**` are other agents' surfaces.",
  }),
  Object.freeze({
    file: 'packages/inventory/src/customer-settlement.ts (+ its vector file)',
    edit: 'lift `apps/api/src/modules/receivables/customer-settlement.ts` verbatim into the package and hold it to a vector file, the way `supplier-settlement.ts:18-20` is held to `vectors/supplier-settlement-vectors.json`',
    why: 'map §8.7 owes the slice a TypeScript twin of the SQL. The module is written to be lifted: it imports nothing from the API, reads no clock, no rate registry and no database, and composes only the four accepted primitives. Its `customer_*` refusal codes join `InventoryErrorCode` in the same edit.',
  }),
  Object.freeze({
    file: 'apps/api/src/modules/receivables/receivables-contracts.ts',
    edit: "replace that file's whole body with `export type { CustomerPaymentAllocationDto, CustomerCreditDto, CustomerPaymentDto, CustomerPaymentResultDto, CustomerCreditApplicationResultDto } from '@daftar/shared-contracts';` once `packages/shared-contracts/src/customer-settlement.ts` is applied",
    why: "the five DTOs are already OUT of `receivables.schemas.ts` and declared in exactly one file, under the package's exact names, which every service, read and the controller import from. So the move is one file and no other file in the directory changes — the same one-line-swap device as `customer-settlement.ts`, needed for the same reason: the package file is the coordinator's and is applied after handback, so importing it today would not compile.",
  }),
  Object.freeze({
    file: 'apps/web/src/locales/*.json (three locales)',
    edit: 'add an `error.customer_payment.*` and `error.customer_credit_application.*` entry for every code in `RECEIVABLES_CODES`',
    why: '`receivablesCode` is now read by `apps/web/src/lib/client.ts` (the one edit this slice made outside `apps/api/src/modules/receivables/`, because `apps/web/test/domain-code-fields.test.ts` derives that list from the refusal modules and is red without it). Until the catalogues exist, each code resolves to the SAFE fallback sentence rather than to a wrong one — the correct failure mode, but not the finished one.',
  }),
  Object.freeze({
    file: 'docs/PHASE_4_ARCHITECTURE_LOCK.md',
    edit: "record Departure B's disclosed gap — a payment method's posting account stays mutable while CUSTOMER payments reference it, because `payment_method_guard()` is a Phase 3 routine whose body digest is pinned in `supplier_settlement_guard_gaps()` (`0067:1801`, `0068:1331`)",
    why: 'the contract requires the boundary recorded as an open item, with one permanent test DOCUMENTING the current behaviour. Each `payments` row pins its own `posting_account_id` through the three-column FK, so no existing row is rewritten; the gap is only that a future payment could post to a different account than past ones.',
  }),
]);
