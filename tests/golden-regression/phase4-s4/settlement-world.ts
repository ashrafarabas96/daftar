/**
 * P4-S4 — THE WORLD A CUSTOMER SETTLEMENT NEEDS, BUILT THROUGH REAL COMMANDS.
 *
 * A law proved against hand-built rows is a law about the fixture, so
 * everything here that HAS a sanctioned producer arrives through it:
 *
 *   — the business, its branches, its warehouses and its catalogue through the
 *     real onboarding and the real inventory commands (`onboardS3Business`);
 *   — priced stock through the real adjustment command, so the goods carry
 *     value and the invoices that sell them are not zero-valued;
 *   — the INVOICE through `POST /v1/sales` and nothing else, because
 *     `sale_commit` is the only sanctioned producer of a committed sale and
 *     its invoice (P4-S2);
 *   — the PAYMENT METHOD through the accepted Phase 3 `payment.create_method`
 *     command, which already exists and is already the only writer of
 *     `payment_methods`. P4-S4 reuses the method authority and never
 *     re-creates it (implementation map §2).
 *
 * The two things that have no merchant write path on this head are the
 * CUSTOMER and the invoice SEQUENCE row, and they are inserted as the owner
 * for exactly the reason the accepted P4-S2 fixture gives: P4-S1 grants no DML
 * on any Phase 4 relation to any runtime principal and ships no writer, so a
 * customer can only arrive this way until the slice that owns
 * `customers.manage` lands. Nothing in any suite asserts anything about how
 * those two rows got here; what the suites assert is what the SETTLEMENT does
 * with them.
 */
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { asMember, onboardS3Business, reauthenticate, registerActor, today, type HttpActor, type S3Business } from '../../helpers/inventory-commands';
import { committed, createMethod, stateRate } from '../../helpers/supplier-settlement';
import { createTestApp, ownerPool, type TestApp } from '../../helpers/test-app';
import { confirmSale, seedSaleFixtures } from '../phase4-s2/sale-path';
import { baseCurrencyOf, invoiceTotals, must, settlementSubject, systemAccountId } from './harness';
import { applyCreditPath, COLLECT_PAYMENT_PATH } from './settlement-path';

export interface SettlementWorld {
  readonly t: TestApp;
  readonly owner: HttpActor;
  readonly shop: S3Business;
  readonly day: string;
  /** The method every collection in these suites is taken through. */
  readonly paymentMethodId: string;
  /** The account that method posts to, by identity. */
  readonly postingAccountId: string;
  readonly headers: Record<string, string>;
}

/** The commonly-needed world: a business, a method, and nothing about settlement yet. */
export async function settlementWorld(label: string): Promise<SettlementWorld> {
  const t = await createTestApp();
  const owner = await registerActor(t, `${label} owner`);
  const shop = await onboardS3Business(t, owner, label);
  const day = await today();
  // The posting account is the business's own `cash` system account, found by
  // its SYSTEM KEY. A typed account code in a fixture is a second copy of the
  // chart just as surely as one in an assertion.
  const postingAccountId = must(await systemAccountId(ownerPool(), shop.businessId, 'cash'), `the business's cash system account`);
  const paymentMethodId = await committed((c) => createMethod(c, shop, { postingAccountId, systemType: 'cash' }));
  return { t, owner, shop, day, paymentMethodId, postingAccountId, headers: asMember(owner, shop.businessId) };
}

/**
 * THE WHOLE SUBJECT OF THE SLICE: the catalogue half (relations, columns,
 * routines, registry rows, the reader-of-record seam) plus the ROUTE half.
 *
 * The route is probed and not read out of a source file. A route listed in an
 * authority table and never mounted answers `404`, and a `404` read as "the
 * command refused me" is a green law about nothing — so the probe asks the
 * running application, and any status other than `404` means the route is
 * there and judged the request.
 */
export async function settlementMissing(w: SettlementWorld): Promise<readonly string[]> {
  const subject = await settlementSubject(ownerPool());
  const missing = [...subject.missing];
  const collect = await w.t.request.post(COLLECT_PAYMENT_PATH).set(w.headers).send({});
  if (collect.status === 404) missing.push(`the route POST ${COLLECT_PAYMENT_PATH} is not mounted`);
  const apply = await w.t.request.post(applyCreditPath(randomUUID())).set(w.headers).send({});
  if (apply.status === 404) missing.push(`the route POST ${applyCreditPath(':creditId')} is not mounted`);
  return missing;
}

/**
 * KEEP THE WORLD'S CREDENTIAL FRESH, OUTSIDE EVERY MEASURED SPAN.
 *
 * The product's access token lives 900 seconds
 * (`apps/api/src/modules/auth/tokens.ts:60`) and nothing here lengthens it.
 * A world that is only read for a few seconds never reaches this; a world
 * being SEEDED for twenty minutes — the P4-S4 budget dataset, paced against
 * the product's own rate limiter — would otherwise die of a `401` half way
 * through, which is a fixture that measures nothing rather than a finding.
 *
 * So the actor logs in again when its credential is older than
 * `REFRESH_AFTER_MS`, which is comfortably inside the token's life, and both
 * the actor and the world's header object are updated in place. Call it where
 * a wait is already lawful — beside the pacing wait, never inside a measured
 * span — and it costs one request every ten minutes.
 */
const REFRESH_AFTER_MS = 600_000;
const lastAuthAt = new WeakMap<SettlementWorld, number>();

export async function keepSettlementAuthFresh(w: SettlementWorld): Promise<void> {
  const now = Date.now();
  const since = lastAuthAt.get(w);
  if (since !== undefined && now - since < REFRESH_AFTER_MS) return;
  if (since === undefined) {
    // First sighting of this world: its token was minted when the world was
    // built, which is as good as a refresh, so only the clock is started.
    lastAuthAt.set(w, now);
    return;
  }
  await reauthenticate(w.t, w.owner);
  w.headers.Authorization = `Bearer ${w.owner.token}`;
  lastAuthAt.set(w, Date.now());
}

/** Priced stock in through the real adjustment command: goods that carry value. */
export async function stockUp(w: SettlementWorld, quantity: string, unitCost: string): Promise<void> {
  const res = await w.t.request
    .post('/v1/inventory/adjustments')
    .set(w.headers)
    .send({
      adjustmentId: randomUUID(),
      warehouseId: w.shop.w1,
      occurredOn: w.day,
      reason: 'p4-s4 settlement fixture',
      lines: [{ productId: w.shop.piece.productId, quantity, unitCost }],
    });
  expect(res.status, `the priced inbound adjustment is accepted, or no invoice below carries value: ${JSON.stringify(res.body)}`).toBe(201);
}

/** A customer with no settlement history, and the sequence row its invoices need. */
export async function newCustomer(w: SettlementWorld): Promise<string> {
  const { customerId } = await seedSaleFixtures(ownerPool(), w.shop, w.day);
  return customerId;
}

export interface OpenInvoice {
  readonly saleId: string;
  readonly invoiceId: string;
  readonly customerId: string | null;
  readonly totalTxnMinor: string;
  readonly totalBaseMinor: string;
  readonly currencyCode: string;
  /** The invoice's OWN historical snapshot `R`, read back from the stored row. */
  readonly sourceToBaseRate: string;
  readonly rateSource: string;
}

/**
 * One CREDIT sale to `customerId`, through the real command, and its invoice
 * read back from the stored rows.
 *
 * Credit and not cash: a cash invoice is settled at the counter and reports
 * nothing outstanding (candidate `0080`), so it is not a document a payment
 * can be allocated against. The cash arm has its own permanent suite.
 *
 * `customerId === null` makes it a WALK-IN sale, which the sale adapter
 * necessarily commits as cash — `invoices_walkin_no_ar` (`0075:661`) makes a
 * receivable behind a null customer unpostable. That is exactly the document
 * the walk-in law is about: an invoice no allocation and no credit application
 * may name at all.
 */
export async function sellOnCredit(w: SettlementWorld, customerId: string | null, quantity: string): Promise<OpenInvoice> {
  const saleId = randomUUID();
  const res = await confirmSale(w.t, w.headers, {
    saleId,
    customerId,
    warehouseId: w.shop.w1,
    branchId: w.shop.branchX,
    occurredOn: w.day,
    lines: [{ productId: w.shop.piece.productId, quantity }],
  });
  expect(res.status, `the sale commits: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  const r = await ownerPool().query<{ invoice_id: string; status: string; settlement_mode: string }>(
    `SELECT i.id::text AS invoice_id, i.status, s.settlement_mode
       FROM sales s JOIN invoices i ON i.business_id = s.business_id AND i.sale_id = s.id
      WHERE s.business_id = $1 AND s.id = $2`,
    [w.shop.businessId, saleId],
  );
  const row = must(r.rows[0], `the committed sale ${saleId} and its invoice`);
  // Read back, never assumed from the request: a suite that assumed the mode
  // would still pass if the command had quietly committed the other arm, and
  // every figure below would then be about the wrong document.
  expect(row.status, 'the invoice is open, which is the only status the reader of record reads (0075:722)').toBe('open');
  expect(row.settlement_mode, `a settleable invoice is a CREDIT invoice; a walk-in sale is necessarily cash`).toBe(customerId === null ? 'cash' : 'credit');
  const totals = await invoiceTotals(ownerPool(), w.shop.businessId, row.invoice_id);
  expect(
    BigInt(totals.totalTxnMinor) > 0n,
    `NO SUBJECT — the invoice totals ${totals.totalTxnMinor} minor units, so every closure figure below would compare 0 with 0`,
  ).toBe(true);
  return {
    saleId,
    invoiceId: row.invoice_id,
    customerId: totals.customerId,
    totalTxnMinor: totals.totalTxnMinor,
    totalBaseMinor: totals.totalBaseMinor,
    currencyCode: totals.currencyCode,
    sourceToBaseRate: totals.sourceToBaseRate,
    rateSource: totals.rateSource,
  };
}

/**
 * State an FX rate through the REAL `accounting_fx_rate_enter` command, as
 * `daftar_app`, with a real control assertion — the accepted Phase 2 path and
 * the only writer of `accounting_fx_rates`.
 *
 * A rate inserted by hand would be a rate no fingerprint covers, and the
 * settlement command's own rate lookup reads the registry, not a test's table.
 */
export async function stateFxRate(w: SettlementWorld, from: string, to: string, rate: string, effectiveAt: string): Promise<string> {
  return stateRate(w.shop, from, to, rate, effectiveAt);
}

/** The business's base currency, read from the business row rather than typed into a suite. */
export async function baseCurrency(w: SettlementWorld): Promise<string> {
  return baseCurrencyOf(ownerPool(), w.shop.businessId);
}
