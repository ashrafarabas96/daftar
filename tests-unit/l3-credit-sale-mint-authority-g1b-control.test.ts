import { randomUUID } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import { TrustedRoleSet, PERMISSIONS, type Permission } from '@daftar/domain-core';
import type { AccountingAssertionClaims, SaleCogsFacts, SaleInvoiceFacts } from '@daftar/accounting';
import { describe, expect, it } from 'vitest';
import { SalePostingService } from '../apps/api/src/modules/accounting/sale-posting.service';
import type { MembershipContext } from '../apps/api/src/modules/tenancy/tenancy.service';

/**
 * THE NEGATIVE CONTROL OF G1-B: the SECOND site that enforces
 * `receivables.view` for a credit sale, which no test in this tree could see
 * until this file existed.
 *
 * ── WHY A SECOND FILE AND NOT A SECOND CASE IN THE HTTP SUITE ────────────
 *
 * `tests/integration/l3-credit-sale-and-collection-permission-refusals.test.ts`
 * §A drives `POST /v1/sales` and asserts the TYPED refusal
 * `sale.credit_not_permitted`. Measured, that makes §A a guard on G1-A
 * (`apps/api/src/modules/selling/sale-commit.service.ts:302`) and BLIND to
 * G1-B: G1-A answers first, so removing G1-B alone leaves §A green. The
 * header of that file now says so, and records this gap. A second HTTP case
 * could not close it either — nothing an HTTP request can carry reaches
 * `authorizeSaleCommit` without passing G1-A first.
 *
 * So this file does not go through HTTP at all. It calls the method, with the
 * facts the sale writer would have resolved, and that is precisely why it is
 * sighted where §A is blind: G1-A is not on this path. Neither file is
 * sufficient alone, and that is the point of having both.
 *
 *   G1-B  `apps/api/src/modules/accounting/sale-posting.service.ts:86-88`
 *         — `invoice.settlementKind === 'credit' && !hasPermission(roles,
 *           'receivables.view')` ⇒ a BARE `ForbiddenException`, no typed code.
 *
 * ── WHAT THIS GATE IS GUARDING, WHICH IS NOT THE HTTP RESPONSE ───────────
 *
 * `authorizeSaleCommit` is the only place a sale's posting authority is
 * minted, and the service's own header states why the check belongs at the
 * mint rather than at the route: `EXECUTE` on `accounting_post_entry` is
 * granted to `daftar_app`, so reachability is not authority — the HMAC-signed
 * assertion is. A caller that reached this method with a credit invoice and
 * no `receivables.view` would walk away holding a signed authority to post
 * `Dr accounts_receivable / Cr sales_revenue`. That is what §1 below proves
 * cannot happen, and it is a different claim from "the route answers 403".
 *
 * ── THE THREE ARMS, AND WHY EACH ONE IS LOAD-BEARING ─────────────────────
 *
 * §1 THE REFUSAL. The actor holds all 58 registered keys EXCEPT
 *    `receivables.view`, on a `credit` invoice ⇒ refused, and the message
 *    names the missing key. "All but one" and not a minimal set: a refusal
 *    measured on an actor holding only `sales.create` could be about any of
 *    the other fifty-seven.
 *
 * §2 THE CREDIT-BIT CONTROL. The SAME actor, the SAME customer, the SAME
 *    figures, `settlementKind: 'cash'` ⇒ MINTS. One bit differs between §1
 *    and §2 and it is the credit bit, so §1's refusal cannot be a generally
 *    unprivileged actor, an invalid fact set or a derivation error.
 *
 * §3 THE KEY CONTROL. The SAME `credit` facts with `receivables.view` ADDED
 *    ⇒ MINTS. This is the arm that makes §1 a control on G1-B and not on the
 *    validity of the facts: with the gate removed, this exact call is what §1
 *    becomes, so §1 goes RED by minting instead of refusing. Without §3, a
 *    fact set that the derivation happened to reject would make §1 pass for
 *    the wrong reason — a green that proves nothing, which is the failure mode
 *    this lane keeps meeting.
 *
 * ── THE MINTER IS A RECORDER, AND WHAT THAT COSTS ────────────────────────
 *
 * `AccountingAssertionMinter` is one method, so the double is a recorder: it
 * returns a tagged string and keeps the claims. Nothing here asserts anything
 * cryptographic — that is `packages/accounting`'s own ground — but the claims
 * ARE read, because "it minted" has to mean "it minted for this sale": an
 * authority minted for another business or another actor would be a worse
 * defect than no authority at all.
 */

/** Every registered key except the ones named. */
const allKeysExcept = (...without: readonly Permission[]): TrustedRoleSet =>
  TrustedRoleSet.fromPersistence([
    {
      key: 'all-but-one',
      isSystem: false,
      permissions: new Set(PERMISSIONS.filter((p) => !without.includes(p))),
    },
  ]);

const TENANT = randomUUID();
const BUSINESS = randomUUID();
const BRANCH = randomUUID();
const WAREHOUSE = randomUUID();
const CUSTOMER = randomUUID();
const INVOICE = randomUUID();
const SALE = randomUUID();
const ACTOR = randomUUID();
const DAY = '2026-03-04';

const membershipWith = (roles: TrustedRoleSet): MembershipContext => ({
  tenantId: TENANT,
  businessId: BUSINESS,
  userId: ACTOR,
  roles,
  roleKeys: ['all-but-one'],
  branchScopeMode: 'all',
  allowedBranchIds: [],
});

/**
 * One credit invoice, in the base currency at rate 1, so `totalBaseMinor`
 * equals `totalTxnMinor` by construction and no rounding is in play. The
 * figures are the sale writer's; nothing here is a client's number.
 */
const creditInvoice = (): SaleInvoiceFacts => ({
  tenantId: TENANT,
  businessId: BUSINESS,
  invoiceId: INVOICE,
  issueDate: DAY,
  branchId: BRANCH,
  customerId: CUSTOMER,
  settlementKind: 'credit',
  settlementAccount: null,
  currencyCode: 'ILS',
  baseCurrency: 'ILS',
  subtotalTxnMinor: 10_000n,
  discountTxnMinor: 0n,
  taxMinor: 0n,
  totalTxnMinor: 10_000n,
  totalBaseMinor: 10_000n,
  fx: { sourceToBaseRate: '1.0000000000', rateSource: 'base', rateTimestamp: new Date(`${DAY}T00:00:00Z`) },
  lines: [{ lineNo: 1, netTxnMinor: 10_000n, taxMinor: 0n }],
});

/** The SAME sale settled at the till: the one bit §2 changes. */
const cashInvoice = (): SaleInvoiceFacts => ({
  ...creditInvoice(),
  settlementKind: 'cash',
  settlementAccount: { kind: 'system', systemKey: 'cash' },
});

const cogsFacts = (): SaleCogsFacts => ({
  tenantId: TENANT,
  businessId: BUSINESS,
  saleId: SALE,
  soldOn: DAY,
  branchId: BRANCH,
  warehouseId: WAREHOUSE,
  baseCurrency: 'ILS',
  movements: [{ sourceLineId: randomUUID(), valueDeltaBaseMinor: -6_000n }],
});

/** The recorder: one method, and it keeps what it was asked to sign. */
class RecordingMinter {
  readonly minted: AccountingAssertionClaims[] = [];
  mint(claims: AccountingAssertionClaims): string {
    this.minted.push(claims);
    return `assertion:${this.minted.length}`;
  }
}

const serviceWith = (): { svc: SalePostingService; minter: RecordingMinter } => {
  const minter = new RecordingMinter();
  return { svc: new SalePostingService(minter), minter };
};

describe('G1-B — the mint refuses a credit sale to a member without receivables.view', () => {
  it('§1 REFUSES and names the missing key, while the SAME actor mints the same sale for CASH (§2) and mints the credit sale once the key is held (§3)', () => {
    // ── §3 FIRST, so §1 is read against a call already proven to mint ─────
    // The order is deliberate: if §3 cannot mint, §1's refusal says nothing
    // about the gate, and this lane does not read an unexplained green.
    const held = serviceWith();
    const minted = held.svc.authorizeSaleCommit(membershipWith(allKeysExcept()), creditInvoice(), cogsFacts());
    expect(
      minted.assertions.length,
      'THE KEY CONTROL FAILED: an actor holding receivables.view could not mint this credit sale at all, ' +
        'so §1 below would refuse for some reason other than the gate under test',
    ).toBe(2);
    expect(minted.postings.revenue.lines.map((l) => (l.account.kind === 'system' ? l.account.systemKey : `code:${l.account.code}`))).toEqual([
      'accounts_receivable',
      'sales_revenue',
    ]);
    // The authority is FOR THIS SALE: minted for this actor, this business and
    // this tenant. "It minted" alone would not be worth asserting.
    for (const claims of held.minter.minted) {
      expect(claims.actorUserId).toBe(ACTOR);
      expect(claims.businessId).toBe(BUSINESS);
      expect(claims.tenantId).toBe(TENANT);
      expect(claims.operationKind).toBe('post');
    }
    expect(held.minter.minted.map((c) => c.sourceId)).toEqual([SALE, INVOICE]);

    // ── §1 THE REFUSAL ───────────────────────────────────────────────────
    const refusing = serviceWith();
    const withoutKey = membershipWith(allKeysExcept('receivables.view'));
    let thrown: unknown;
    try {
      refusing.svc.authorizeSaleCommit(withoutKey, creditInvoice(), cogsFacts());
    } catch (e) {
      thrown = e;
    }
    expect(
      thrown,
      'a member WITHOUT receivables.view was handed a signed authority to post a receivable. ' +
        `Minted: ${JSON.stringify(refusing.minter.minted.map((c) => c.sourceType))}`,
    ).toBeInstanceOf(ForbiddenException);
    expect(
      (thrown as ForbiddenException | undefined)?.message,
      'the refusal does not name receivables.view, so it may be a different denial than the one under test',
    ).toContain('receivables.view');
    // A refusal that nevertheless minted is not a refusal: the authority is
    // the thing being withheld, so ZERO is the assertion that matters.
    expect(refusing.minter.minted, 'the refused credit sale minted an assertion anyway').toEqual([]);

    // ── §2 THE CREDIT-BIT CONTROL ────────────────────────────────────────
    const cash = serviceWith();
    const cashMinted = cash.svc.authorizeSaleCommit(withoutKey, cashInvoice(), cogsFacts());
    expect(
      cashMinted.assertions.length,
      'THE CREDIT-BIT CONTROL FAILED: the same actor cannot mint a CASH sale either, so §1 is about the actor and not about the credit bit',
    ).toBe(2);
    expect(cashMinted.postings.revenue.lines.map((l) => (l.account.kind === 'system' ? l.account.systemKey : `code:${l.account.code}`))).toEqual([
      'cash',
      'sales_revenue',
    ]);
  });

  /**
   * THE OTHER GATES OF THE SAME MINT, each of which had ZERO negative control
   * anywhere in the tree before this block.
   *
   * Measured, not assumed: `grep -rl` over `tests/` and `tests-unit/` for
   * `'sales.create is required to commit a sale'`, `'a sale may only be posted
   * for the business the membership resolved'` and `'a sale may only be
   * committed for a branch in the member branch scope'` returned NOTHING, and
   * the probe is sighted — the same grep for `'Missing permission:
   * payments.collect'` names the integration suite (RULE-11: an empty probe is
   * not a zero until a positive control says the probe can see).
   *
   * They are here and not in a separate file because they are arms of the same
   * method and the same authority. They are separate `it`s rather than one,
   * because a gate that fails should fail BY NAME.
   */

  /**
   * TWO gates carry the SAME sentence — one over the invoice facts
   * (`:89-91`), one over the sale facts (`:92-94`) — and a shared message is
   * exactly how one of a pair gets deleted silently. So each of the four
   * fields gets its own arm, and the pair is distinguished by WHICH fact set
   * is made foreign, not by the message.
   *
   * What stands behind these gates if they go is NOT another permission
   * refusal: `deriveSaleCommitPostings` would throw
   * `accounting.payload_invalid` for the mismatch between the two fact sets.
   * That is a payload error, not an authority refusal, and it would not fire
   * at all for a pair that is consistent with each other and foreign to the
   * membership — which is the case these arms rule out.
   */
  it.each([
    ['the invoice is another business', (): [SaleInvoiceFacts, SaleCogsFacts] => [{ ...creditInvoice(), businessId: randomUUID() }, cogsFacts()]],
    ['the invoice is another tenant', (): [SaleInvoiceFacts, SaleCogsFacts] => [{ ...creditInvoice(), tenantId: randomUUID() }, cogsFacts()]],
    ['the sale is another business', (): [SaleInvoiceFacts, SaleCogsFacts] => [creditInvoice(), { ...cogsFacts(), businessId: randomUUID() }]],
    ['the sale is another tenant', (): [SaleInvoiceFacts, SaleCogsFacts] => [creditInvoice(), { ...cogsFacts(), tenantId: randomUUID() }]],
  ])('§5 no authority is minted when %s than the membership resolved', (_name, facts) => {
    const { svc, minter } = serviceWith();
    const [invoice, cogs] = facts();
    let thrown: unknown;
    try {
      svc.authorizeSaleCommit(membershipWith(allKeysExcept()), invoice, cogs);
    } catch (e) {
      thrown = e;
    }
    expect(
      thrown,
      'a posting authority was minted across the tenancy boundary, or refused by something other than the authority check: ' +
        `${thrown instanceof Error ? `${thrown.constructor.name}: ${thrown.message}` : String(thrown)}`,
    ).toBeInstanceOf(ForbiddenException);
    expect((thrown as ForbiddenException).message).toContain('a sale may only be posted for the business the membership resolved');
    expect(minter.minted, 'the refused cross-tenancy sale minted an assertion anyway').toEqual([]);
  });

  it('§6 no authority is minted for a branch outside an assigned member scope, and the SAME member mints inside it', () => {
    const outside = serviceWith();
    const assignedElsewhere: MembershipContext = { ...membershipWith(allKeysExcept()), branchScopeMode: 'assigned', allowedBranchIds: [randomUUID()] };
    let thrown: unknown;
    try {
      outside.svc.authorizeSaleCommit(assignedElsewhere, creditInvoice(), cogsFacts());
    } catch (e) {
      thrown = e;
    }
    expect(thrown, `an assigned member minted a sale authority for a branch outside their scope`).toBeInstanceOf(ForbiddenException);
    expect((thrown as ForbiddenException).message).toContain('a sale may only be committed for a branch in the member branch scope');
    expect(outside.minter.minted).toEqual([]);

    // THE CONTROL: the same member, the same facts, the branch IN scope. The
    // gate is the scope and not the `assigned` mode itself.
    const inside = serviceWith();
    const assignedHere: MembershipContext = { ...membershipWith(allKeysExcept()), branchScopeMode: 'assigned', allowedBranchIds: [BRANCH] };
    expect(
      inside.svc.authorizeSaleCommit(assignedHere, creditInvoice(), cogsFacts()).assertions.length,
      'THE CONTROL FAILED: an assigned member cannot mint even for a branch IN their scope, so the refusal above is about the mode and not the branch',
    ).toBe(2);
  });

  it('§7 no authority is minted without sales.create, on either settlement shape', () => {
    const withoutCreate = membershipWith(allKeysExcept('sales.create'));
    for (const [shape, invoice] of [
      ['credit', creditInvoice()],
      ['cash', cashInvoice()],
    ] as const) {
      const { svc, minter } = serviceWith();
      let thrown: unknown;
      try {
        svc.authorizeSaleCommit(withoutCreate, invoice, cogsFacts());
      } catch (e) {
        thrown = e;
      }
      expect(thrown, `a ${shape} sale minted an authority for a member without sales.create`).toBeInstanceOf(ForbiddenException);
      expect(
        (thrown as ForbiddenException).message,
        `the ${shape} refusal does not name sales.create, so it may be the credit gate answering instead`,
      ).toContain('sales.create is required to commit a sale');
      expect(minter.minted).toEqual([]);
    }
  });

  it('§4 the gate is the credit bit and not the customer: a credit invoice with every other fact identical is the only arm refused', () => {
    // A guard that happened to refuse BOTH arms would pass §1 and prove
    // nothing. §2 above already shows the cash arm mints; this names the
    // difference as a single field rather than leaving it to be re-derived.
    const credit = creditInvoice();
    const cash = cashInvoice();
    // `JSON.stringify` cannot serialize a BigInt and every money field here is
    // one, so the comparison is on a bigint-aware rendering rather than JSON.
    const render = (v: unknown): string => {
      if (typeof v === 'bigint') return `${v}n`;
      if (v instanceof Date) return v.toISOString();
      if (Array.isArray(v)) return `[${v.map(render).join(',')}]`;
      if (v !== null && typeof v === 'object') {
        return `{${Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, x]) => `${k}:${render(x)}`)
          .join(',')}}`;
      }
      return String(v);
    };
    const differing = (Object.keys(credit) as (keyof SaleInvoiceFacts)[]).filter((k) => render(credit[k]) !== render(cash[k]));
    expect(differing.sort(), 'more than the settlement fields differ between the refused arm and its control, so the control is not one bit away').toEqual([
      'settlementAccount',
      'settlementKind',
    ]);
  });
});
