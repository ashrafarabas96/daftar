/**
 * P4-S2 — THE `P0001` ERROR CONTRACT OF THE SELLING SURFACE (TL-P4-S2-R5).
 *
 * «An internal invariant failure is not an authorization denial.»
 *
 * `common/error.filter.ts` used to end its PostgreSQL arm with
 * `42501 || P0001 -> 403 FORBIDDEN / 'Access denied'`. Every refusal a Phase 4
 * routine or trigger raises carries `P0001`, so the whole known selling
 * vocabulary arrived at the client as an authorization denial: sixteen suites
 * read "the sale was refused" while the server log said
 * `selling.sale_cogs_owed`. The two statements are not the same statement, and
 * the difference is who has to act — the merchant, or whoever owns the
 * invariant.
 *
 * What this suite pins, and the order it pins it in:
 *
 *   (A) a KNOWN PUBLIC selling code (`sale.*`, `invoice.*`, `customer.*`)
 *       leaves with the status the stable registry assigns it, through
 *       `sellingRefusal` — the one selling mapping, never a second status
 *       table in the filter;
 *   (B) a RECOGNIZED INTERNAL `selling.*` invariant leaves as 500
 *       `INTERNAL_ERROR`, NOT 403, with the invariant's name in the log and
 *       nothing of the database in the body;
 *   (C) an UNKNOWN, unrelated, historical `P0001` keeps the ACCEPTED fallback
 *       and `42501` is still 403 — this pass audits nothing of Phase 1-3, and
 *       a suite that let the fallback drift would be the accidental redesign
 *       the ruling's scope excludes;
 *   (D) the inventory and accounting mappings are UNCHANGED, pinned as
 *       explicit tables rather than re-derived from the code they guard.
 *
 * ── WHY HALF OF IT IS A FILTER HARNESS AND HALF IS THE REAL ROUTE ─────────
 *
 * The filter's job is to turn ONE exception into ONE response, so the law is
 * stated against the filter itself where that is what is being measured: a
 * `customer.not_deletable` raised by a trigger has no route in this slice
 * (nothing deletes a customer), and a law written only against reachable
 * routes could not state the contract for the codes the filter exists to
 * catch. Those cases are driven through a real `GlobalExceptionFilter` with a
 * real `ArgumentsHost` double — the production class, its production logger
 * port, no stubbing of the mapping under test.
 *
 * And «a test that merely catches a rejected Promise is insufficient»: the
 * four cases that CAN be reached over HTTP are driven through
 * `POST /v1/sales` — the real route, the real guards, the real filter — and
 * every one of them asserts the HTTP STATUS and the STABLE RESPONSE CODE.
 *
 * ── THE COMPOSITION ───────────────────────────────────────────────────────
 *
 * DAFTAR composes Nest twice (`app/app.module.ts` and
 * `app/merchant-api.module.ts`), and a controller registered in only one of
 * them is untestable from the other side. `createTestApp()` builds the
 * `AppModule` composition, so every route case below runs against THAT one;
 * `P4_S2_REQUIRED_CONTROLLERS` and the test at the end of this file are what
 * say the production composition carries `SalesController` too.
 *
 * ── THE PLANTED DEFECT ────────────────────────────────────────────────────
 *
 * The internal-invariant case over HTTP needs a VIOLATED invariant, and a
 * suite may not leave one in the tree. It is planted in DATA and reverted in
 * a `finally`: see `plantedSequenceFormat`. No migration is edited, no
 * routine is replaced in the live catalogue, and the revert is asserted.
 */
import { randomUUID } from 'node:crypto';
import type { ArgumentsHost } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountingError } from '@daftar/accounting';
import { GlobalExceptionFilter } from '../../apps/api/src/common/error.filter';
import type { Logger } from '../../apps/api/src/infra/logger';
import { P4_S2_REQUIRED_CONTROLLERS } from '../../apps/api/src/modules/selling/selling.module';
import { SELLING_INTERNAL_INVARIANT_CODES } from '../../apps/api/src/modules/selling/selling-errors';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { asMember, onboardS3Business, registerActor, today, type HttpActor, type S3Business } from '../helpers/inventory-commands';
import { must, requireSubject, saleSubject, type SaleSubject } from '../golden-regression/phase4-s2/harness';
import { confirmSale, seedSaleFixtures } from '../golden-regression/phase4-s2/sale-path';

const CLAIM = 'a known selling refusal keeps its registered status, and a violated internal invariant is a 500 rather than a 403';

// ─────────────────────────────────────────────────────────────────────────
// The filter harness. The PRODUCTION class, driven through a real
// `ArgumentsHost`, with nothing of the mapping under test replaced.
// ─────────────────────────────────────────────────────────────────────────

interface Rendered {
  readonly status: number;
  readonly payload: { error: { code: string; message: string; requestId: string; details?: Record<string, unknown> } };
  /** Everything the filter asked the logger to record, so the log can be asserted as a contract. */
  readonly logged: readonly { readonly fields: Record<string, unknown>; readonly message: string }[];
}

/**
 * `exception` through the real filter, as the status, the body and the log it
 * produced.
 *
 * The response double implements the two methods the filter calls and
 * nothing else, so a filter that started calling a third one fails here
 * rather than silently taking a different path.
 */
function render(exception: unknown): Rendered {
  let status = 0;
  let payload: Rendered['payload'] | undefined;
  const logged: { fields: Record<string, unknown>; message: string }[] = [];
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(value: unknown) {
      payload = value as Rendered['payload'];
      return this;
    },
    setHeader(): void {},
  };
  const host = {
    switchToHttp: () => ({ getResponse: <T>(): T => res as unknown as T }),
  } as unknown as ArgumentsHost;
  const logger = {
    error: (fields: unknown, message?: unknown): void => {
      logged.push({ fields: (fields ?? {}) as Record<string, unknown>, message: String(message ?? '') });
    },
    warn: (): void => {},
    info: (): void => {},
    debug: (): void => {},
  } as unknown as Logger;
  new GlobalExceptionFilter(logger).catch(exception, host);
  expect(payload, 'the filter rendered a body').not.toBeUndefined();
  return { status, payload: must(payload, 'the rendered body'), logged };
}

/** A PostgreSQL error as `pg` delivers one: the SQLSTATE on `code`, the routine's text on `message`. */
function pgError(code: string, message: string, extra: Record<string, unknown> = {}): Error & { code: string } {
  return Object.assign(new Error(message), { code, severity: 'ERROR', ...extra }) as Error & { code: string };
}

/** Everything a response body says, as one string — what a leak test searches. */
function bodyText(payload: unknown): string {
  return JSON.stringify(payload);
}

/**
 * The internal text a routine's refusal carries, in one deliberately
 * poisonous message: the SQL, the assertion body, an amount, a journal entry
 * id and a stack frame, all of them things §29 forbids leaving the process.
 */
const POISON = {
  sql: "SELECT replayed FROM sale_commit($1::uuid, $2::uuid, 'sale.commit')",
  assertion: 'a committed sale whose goods carry value owes a COGS entry, and this one has none',
  amount: '184733',
  journalEntryId: '9f2b1c44-0000-4000-8000-aaaabbbbcccc',
  frame: 'PL/pgSQL function sales_cogs_owed() line 42 at RAISE',
} as const;

const poisonous = (code: string): Error & { code: string } =>
  pgError(
    'P0001',
    `${code}: ${POISON.assertion}\nCONTEXT: ${POISON.frame}\nSTATEMENT: ${POISON.sql}\n` +
      `detail: amount ${POISON.amount}, journal_entry_id ${POISON.journalEntryId}`,
    { where: POISON.frame, internalQuery: POISON.sql, detail: `amount ${POISON.amount}` },
  );

// ─────────────────────────────────────────────────────────────────────────
// (A) The known PUBLIC selling codes.
// ─────────────────────────────────────────────────────────────────────────

/**
 * The registered contract of every public selling code this suite pins,
 * written out rather than read from `SELLING_STATUS`: a test that imports the
 * table it is checking agrees with any edit to it, including a wrong one.
 *
 * The classes the ruling names are all represented: an idempotency conflict
 * (409), current-state conflicts (409), payload problems (400 and 422),
 * permission problems (403) and a target that does not exist (404).
 */
const PUBLIC_SELLING_CONTRACT: readonly { readonly code: string; readonly status: number; readonly envelope: string }[] = [
  // sale.* — the atomic commit's own vocabulary.
  { code: 'sale.idempotency_conflict', status: 409, envelope: 'CONFLICT' },
  { code: 'sale.state_invalid', status: 409, envelope: 'CONFLICT' },
  { code: 'sale.state_changed', status: 409, envelope: 'CONFLICT' },
  { code: 'sale.customer_inactive', status: 409, envelope: 'CONFLICT' },
  { code: 'sale.not_found', status: 404, envelope: 'NOT_FOUND' },
  { code: 'sale.product_not_found', status: 404, envelope: 'NOT_FOUND' },
  { code: 'sale.lines_required', status: 400, envelope: 'VALIDATION_FAILED' },
  { code: 'sale.quantity_invalid', status: 400, envelope: 'VALIDATION_FAILED' },
  { code: 'sale.credit_requires_customer', status: 400, envelope: 'VALIDATION_FAILED' },
  { code: 'sale.total_zero', status: 422, envelope: 'VALIDATION_FAILED' },
  { code: 'sale.document_date_in_future', status: 422, envelope: 'VALIDATION_FAILED' },
  { code: 'sale.tax_policy_absent', status: 422, envelope: 'VALIDATION_FAILED' },
  { code: 'sale.discount_not_permitted', status: 403, envelope: 'FORBIDDEN' },
  { code: 'sale.credit_not_permitted', status: 403, envelope: 'FORBIDDEN' },
  // invoice.* — the guards P4-AL-46 states, raised by a trigger and by no route.
  { code: 'invoice.status_not_writable', status: 409, envelope: 'CONFLICT' },
  { code: 'invoice.state_invalid', status: 409, envelope: 'CONFLICT' },
  { code: 'invoice.not_found', status: 404, envelope: 'NOT_FOUND' },
  { code: 'invoice.sequence_not_found', status: 404, envelope: 'NOT_FOUND' },
  { code: 'invoice.document_kind_unknown', status: 400, envelope: 'VALIDATION_FAILED' },
  // customer.* — including the one no route can reach.
  { code: 'customer.not_deletable', status: 409, envelope: 'CONFLICT' },
  { code: 'customer.idempotency_conflict', status: 409, envelope: 'CONFLICT' },
  { code: 'customer.not_found', status: 404, envelope: 'NOT_FOUND' },
  { code: 'customer.name_invalid', status: 400, envelope: 'VALIDATION_FAILED' },
  { code: 'customer.business_wide_scope_required', status: 403, envelope: 'FORBIDDEN' },
];

// ─────────────────────────────────────────────────────────────────────────
// (D) The mappings that must not move.
// ─────────────────────────────────────────────────────────────────────────

/**
 * The P3-S3 inventory refusals as the filter rendered them BEFORE this
 * change, pinned by hand. Written out rather than taken from
 * `inventoryRefusal` for the reason above: the point is that the accepted
 * answers did not move, and only an independent copy can say so.
 */
const INVENTORY_CONTRACT: readonly { readonly code: string; readonly status: number; readonly envelope: string }[] = [
  { code: 'inventory.idempotency_conflict', status: 409, envelope: 'CONFLICT' },
  { code: 'inventory.document_id_conflict', status: 409, envelope: 'CONFLICT' },
  { code: 'inventory.valuation_changed', status: 409, envelope: 'CONFLICT' },
  { code: 'inventory.stocktake_changed', status: 409, envelope: 'CONFLICT' },
  { code: 'inventory.opening_case_changed', status: 409, envelope: 'CONFLICT' },
  { code: 'inventory.opening_valuation_mismatch', status: 409, envelope: 'CONFLICT' },
  { code: 'inventory.opening_already_posted', status: 409, envelope: 'CONFLICT' },
  { code: 'inventory.opening_state_invalid', status: 409, envelope: 'CONFLICT' },
  { code: 'inventory.stocktake_already_open', status: 409, envelope: 'CONFLICT' },
  { code: 'inventory.stocktake_state_invalid', status: 409, envelope: 'CONFLICT' },
  { code: 'inventory.warehouse_has_stock', status: 409, envelope: 'CONFLICT' },
  { code: 'inventory.variant_has_stock', status: 409, envelope: 'CONFLICT' },
  { code: 'inventory.product_has_stock', status: 409, envelope: 'CONFLICT' },
  { code: 'inventory.stocktake_not_found', status: 404, envelope: 'NOT_FOUND' },
  { code: 'inventory.stocktake_empty', status: 400, envelope: 'VALIDATION_FAILED' },
  { code: 'inventory.unit_cost_required', status: 400, envelope: 'VALIDATION_FAILED' },
  { code: 'inventory.unit_cost_not_applicable', status: 400, envelope: 'VALIDATION_FAILED' },
  { code: 'inventory.transfer_same_warehouse', status: 400, envelope: 'VALIDATION_FAILED' },
  { code: 'inventory.duplicate_line', status: 400, envelope: 'VALIDATION_FAILED' },
  { code: 'inventory.lines_required', status: 400, envelope: 'VALIDATION_FAILED' },
];

/**
 * An inventory code the P3-S3 set does NOT hold. It must still reach the
 * historical fallback, because the filter's inventory block is closed on
 * purpose and widening it would change an accepted Phase 3 contract.
 */
const INVENTORY_OUTSIDE_THE_P3_S3_SET = 'inventory.insufficient_stock';

/** The accounting mapping, one representative per branch of `accountingStatus`. */
const ACCOUNTING_CONTRACT: readonly { readonly code: string; readonly status: number }[] = [
  { code: 'accounting.forbidden', status: 403 },
  { code: 'accounting.branch_scope_violation', status: 403 },
  { code: 'accounting.assertion_payload_mismatch', status: 403 },
  { code: 'accounting.entry_not_found', status: 404 },
  { code: 'accounting.period_not_found', status: 404 },
  { code: 'accounting.idempotency_conflict', status: 409 },
  { code: 'accounting.source_immutable', status: 409 },
  { code: 'accounting.period_closed', status: 409 },
  { code: 'accounting.report_unbalanced', status: 409 },
  { code: 'accounting.inventory_account_domain_owned', status: 409 },
  { code: 'accounting.payload_invalid', status: 400 },
  { code: 'accounting.period_range_invalid', status: 400 },
];

// ─────────────────────────────────────────────────────────────────────────
// The real route.
// ─────────────────────────────────────────────────────────────────────────

let t: TestApp;
let day: string;
let owner: HttpActor;
let A: S3Business;
let subject: SaleSubject;
let customerId: string;
let period: string;

/** `INV-{YYYY}-{SEQ:5}` — the accepted format `seedSaleFixtures` seeds. */
const GOOD_FORMAT = 'INV-{YYYY}-{SEQ:5}';

/**
 * THE PLANTED DEFECT, and why it is this one.
 *
 * `sale_document_number()` (`0078:291`) refuses a rendering outside the
 * `invoices.document_number` CHECK with `selling.sequence_format_invalid`, and
 * `sale_commit` calls it at `0078:868` to number the invoice. The renderer
 * treats `{SEQ:n}` as a MINIMUM width and never truncates — a truncated
 * number would collide under `invoices_document_number_uq` — so
 * `INV-{YYYY}-{SEQ:99}` renders 108 characters where at most 64 are
 * representable, and the invariant fires inside the sale's own transaction.
 *
 * It is a defect of SERVER STATE, not of the merchant's request: this slice
 * ships no writer of `invoice_sequences.number_format`, so no payload can
 * reach it and no merchant can be told to fix it. That is exactly the shape
 * of thing the ruling is about.
 *
 * `INV-{YYYY}-{SEQ:99}` is 19 characters and matches
 * `invoice_sequences_format_ck` (8-64, both placeholders, the accepted
 * alphabet), so the plant goes in through the constraint rather than around
 * it: the defect is a LAWFUL row that the renderer refuses, which is a defect
 * someone could really ship.
 *
 * Nothing is replaced in the live catalogue and no migration is touched. The
 * row is restored in the `finally`, and the restoration is asserted.
 */
async function plantedSequenceFormat<T>(fn: () => Promise<T>): Promise<T> {
  const q = ownerPool();
  const set = async (format: string): Promise<void> => {
    const r = await q.query(`UPDATE invoice_sequences SET number_format = $1 WHERE business_id = $2 AND document_kind = 'invoice' AND period = $3`, [
      format,
      A.businessId,
      period,
    ]);
    expect(r.rowCount, `the planted format ${format} was applied to exactly one series row`).toBe(1);
  };
  await set('INV-{YYYY}-{SEQ:99}');
  try {
    return await fn();
  } finally {
    await set(GOOD_FORMAT);
    const back = await q.query<{ number_format: string }>(
      `SELECT number_format FROM invoice_sequences WHERE business_id = $1 AND document_kind = 'invoice' AND period = $2`,
      [A.businessId, period],
    );
    expect(must(back.rows[0], 'the series row').number_format, 'THE PLANT IS REVERTED — no defect is left behind for a later suite').toBe(GOOD_FORMAT);
  }
}

/** One unit of `piece` on the shelf of `w1`, through the inbound command that exists. */
async function stockUp(quantity: string): Promise<void> {
  const res = await t.request
    .post('/v1/inventory/adjustments')
    .set(asMember(owner, A.businessId))
    .send({
      adjustmentId: randomUUID(),
      warehouseId: A.w1,
      occurredOn: day,
      reason: 'the error-contract fixture',
      lines: [{ productId: A.piece.productId, quantity, unitCost: '10' }],
    });
  expect(res.status, 'the fixture inbound adjustment is accepted').toBe(201);
}

/** The stable code the envelope carries, and the domain code in its typed details. */
function codes(res: { body?: unknown }): { envelope: string | null; domain: string | null } {
  const error = (res.body as { error?: { code?: unknown; details?: Record<string, unknown> } } | undefined)?.error;
  const details = error?.details ?? {};
  const domain = [details['sellingCode'], details['inventoryCode'], details['accountingCode']].find((v) => typeof v === 'string');
  return { envelope: typeof error?.code === 'string' ? error.code : null, domain: typeof domain === 'string' ? domain : null };
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  day = await today();
  t = await createTestApp();
  owner = await registerActor(t, 'TL-P4-S2-R5 owner');
  A = await onboardS3Business(t, owner, 'r5err');
  ({ customerId, period } = await seedSaleFixtures(ownerPool(), A, day));
  subject = await saleSubject(ownerPool());
}, 180_000);

afterAll(async () => {
  await t?.close();
  await resetData();
});

// ─────────────────────────────────────────────────────────────────────────

describe('TL-P4-S2-R5 (A): a known public selling code keeps its REGISTERED status', () => {
  it('a known `sale.*` P0001 is rendered with its registered status and its stable code', () => {
    const offenders: string[] = [];
    for (const c of PUBLIC_SELLING_CONTRACT.filter((x) => x.code.startsWith('sale.'))) {
      const r = render(pgError('P0001', `${c.code}: the routine's own words, which are not the merchant's`));
      if (r.status !== c.status) offenders.push(`${c.code} -> ${r.status}, not ${c.status}`);
      if (r.payload.error.code !== c.envelope) offenders.push(`${c.code} -> envelope ${r.payload.error.code}, not ${c.envelope}`);
      if (r.payload.error.details?.['sellingCode'] !== c.code)
        offenders.push(`${c.code} -> details.sellingCode ${String(r.payload.error.details?.['sellingCode'])}`);
    }
    expect(offenders, 'every known sale.* code leaves with the status and code the registry assigns it').toEqual([]);
  });

  it('a known `invoice.*` P0001 is rendered with its registered status and its stable code', () => {
    const offenders: string[] = [];
    for (const c of PUBLIC_SELLING_CONTRACT.filter((x) => x.code.startsWith('invoice.'))) {
      const r = render(pgError('P0001', `${c.code}: the trigger's own words`));
      if (r.status !== c.status) offenders.push(`${c.code} -> ${r.status}, not ${c.status}`);
      if (r.payload.error.code !== c.envelope) offenders.push(`${c.code} -> envelope ${r.payload.error.code}, not ${c.envelope}`);
      if (r.payload.error.details?.['sellingCode'] !== c.code) offenders.push(`${c.code} -> details.sellingCode is not the code`);
    }
    expect(offenders, 'every known invoice.* code leaves with the status and code the registry assigns it').toEqual([]);
  });

  it('a known `customer.*` P0001 is rendered with its registered status and its stable code', () => {
    const offenders: string[] = [];
    for (const c of PUBLIC_SELLING_CONTRACT.filter((x) => x.code.startsWith('customer.'))) {
      const r = render(pgError('P0001', `${c.code}: the trigger's own words`));
      if (r.status !== c.status) offenders.push(`${c.code} -> ${r.status}, not ${c.status}`);
      if (r.payload.error.code !== c.envelope) offenders.push(`${c.code} -> envelope ${r.payload.error.code}, not ${c.envelope}`);
    }
    expect(offenders, 'every known customer.* code leaves with the status and code the registry assigns it').toEqual([]);
  });

  it('NONE of the known public selling codes is rendered as an authorization denial unless it IS one', () => {
    const wrongly403 = PUBLIC_SELLING_CONTRACT.filter((c) => c.status !== 403).filter((c) => render(pgError('P0001', `${c.code}: text`)).status === 403);
    expect(
      wrongly403.map((c) => c.code),
      'the three codes that ARE permission refusals are 403 and no other code is',
    ).toEqual([]);
    const rightly403 = PUBLIC_SELLING_CONTRACT.filter((c) => c.status === 403);
    expect(rightly403.length, 'the pinned table does contain permission refusals, so the claim above has a subject').toBeGreaterThan(0);
  });

  it('the merchant message is a safe generic sentence: the routine’s text after the colon is never forwarded', () => {
    const r = render(poisonous('sale.state_changed'));
    expect(r.status).toBe(409);
    const text = bodyText(r.payload);
    for (const [name, value] of Object.entries(POISON)) {
      expect(text.includes(value), `the body leaked the ${name} the routine carried`).toBe(false);
    }
  });
});

describe('TL-P4-S2-R5 (B): a recognized internal `selling.*` invariant is 500, NOT 403', () => {
  it('every registered internal invariant is rendered 500 INTERNAL_ERROR and never 403', () => {
    expect(SELLING_INTERNAL_INVARIANT_CODES.length, 'the registry is not empty, so this claim has a subject').toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const code of SELLING_INTERNAL_INVARIANT_CODES) {
      const r = render(poisonous(code));
      if (r.status !== 500) offenders.push(`${code} -> ${r.status}, not 500`);
      if (r.payload.error.code !== 'INTERNAL_ERROR') offenders.push(`${code} -> envelope ${r.payload.error.code}, not INTERNAL_ERROR`);
    }
    expect(offenders, 'a violated internal invariant is a defect reported as one — never an authorization denial').toEqual([]);
  });

  it('`selling.sale_cogs_owed` — the code the ruling names — is 500 and carries no details at all', () => {
    const r = render(poisonous('selling.sale_cogs_owed'));
    expect(r.status, 'an internal invariant failure is not an authorization denial').toBe(500);
    expect(r.payload.error.code, 'the stable response code').toBe('INTERNAL_ERROR');
    expect(r.payload.error.message, 'the generic safe sentence').toBe('Internal error');
    expect(r.payload.error.details, 'the internal invariant vocabulary is not part of the merchant contract, so the body carries none of it').toBeUndefined();
    expect(typeof r.payload.error.requestId, 'the request id is still the correlation handle').toBe('string');
  });

  it('the invariant is LOGGED with the request id and the internal code, and with nothing else of the database', () => {
    const r = render(poisonous('selling.sale_cogs_owed'));
    expect(r.logged.length, 'exactly one log line — the invariant, not also the generic unhandled-error line').toBe(1);
    const line = must(r.logged[0], 'the log line');
    expect(line.fields['invariant'], 'the log names the invariant that broke').toBe('selling.sale_cogs_owed');
    expect(Object.keys(line.fields).sort(), 'the log fields are the request id and the invariant code, and nothing else').toEqual(['invariant', 'requestId']);
    const text = JSON.stringify(line.fields);
    for (const [name, value] of Object.entries(POISON)) {
      expect(text.includes(value), `the LOG FIELDS carried the ${name} — the invariant code is the whole of what is recorded`).toBe(false);
    }
  });

  it('raw internal text NEVER reaches the response body of an internal invariant', () => {
    const offenders: string[] = [];
    for (const code of SELLING_INTERNAL_INVARIANT_CODES) {
      const text = bodyText(render(poisonous(code)).payload);
      for (const [name, value] of Object.entries(POISON)) if (text.includes(value)) offenders.push(`${code} leaked ${name}`);
      // Not even the invariant's own name: it names a Phase 4 internal law and
      // no `error.selling.*` entry exists in any of the three catalogues, so a
      // client could render nothing from it.
      if (text.includes(code)) offenders.push(`${code} leaked its own internal code`);
      if (/P0001|SQLSTATE|pg_catalog|RAISE|plpgsql/i.test(text)) offenders.push(`${code} leaked a database internal`);
    }
    expect(offenders, 'no SQL, no raw message, no amount, no journal id, no assertion body and no stack leaves the process').toEqual([]);
  });

  it('an UNRECOGNIZED `selling.*` code is NOT treated as an invariant: the registry is explicit, never a wildcard', () => {
    const r = render(pgError('P0001', 'selling.migration_end_state_invalid: 0078-E(2): sale_commit takes 30 arguments'));
    expect(
      r.status,
      'a migration-time end-state assertion is not in the registry, so it keeps the unaudited historical fallback rather than being given a contract nobody has located',
    ).toBe(403);
    const wildcarded = ['selling.authority_leak', 'selling.derived_truth_stored', 'selling.cross_business_binding_expressible'].filter(
      (c) => render(pgError('P0001', `${c}: text`)).status !== 403,
    );
    expect(wildcarded, 'the excluded codes are excluded — a `selling.*` wildcard would have swept all three in').toEqual([]);
  });
});

describe('TL-P4-S2-R5 (C): the historical contracts this pass does NOT redesign', () => {
  it('an unknown, unrelated legacy `P0001` keeps the previous fallback', () => {
    const legacy = [
      'provisioning.tenant_limit_reached: the tenant already holds its maximum number of businesses',
      'structure.branch_archived: the branch is archived',
      'something_with_no_prefix_at_all happened deep inside a Phase 1 routine',
      'catalog.unit_locked: the unit is locked',
    ];
    const offenders: string[] = [];
    for (const message of legacy) {
      const r = render(pgError('P0001', message));
      if (r.status !== 403) offenders.push(`${message.slice(0, 32)} -> ${r.status}`);
      if (r.payload.error.code !== 'FORBIDDEN' || r.payload.error.message !== 'Access denied') offenders.push(`${message.slice(0, 32)} -> body changed`);
    }
    expect(offenders, 'an UNKNOWN P0001 is untouched until it is separately audited — the accepted Phase 1-3 contracts do not move in this pass').toEqual([]);
  });

  it('`42501` remains 403 FORBIDDEN / Access denied', () => {
    const r = render(pgError('42501', 'permission denied for table sales'));
    expect(r.status).toBe(403);
    expect(r.payload.error.code).toBe('FORBIDDEN');
    expect(r.payload.error.message).toBe('Access denied');
    expect(bodyText(r.payload).includes('sales'), 'not even the relation name the privilege error carried').toBe(false);
  });

  it('a `42501` is NOT matched by either new block, even when its message happens to carry a selling code', () => {
    // A `42501` message is PostgreSQL's own, not a routine's, so this case is
    // hypothetical by construction — and it is asserted anyway, because the
    // new blocks are gated on the SQLSTATE and a later edit that gated them on
    // the message alone would be caught here rather than in production.
    const r = render(pgError('42501', 'permission denied: selling.sale_cogs_owed'));
    expect(r.status, 'the privilege contract is decided by the SQLSTATE').toBe(403);
  });
});

describe('TL-P4-S2-R5 (D): the mappings that must not move', () => {
  it('inventory refusal mappings remain UNCHANGED', () => {
    const offenders: string[] = [];
    for (const c of INVENTORY_CONTRACT) {
      const r = render(pgError('P0001', `${c.code}: the routine's own words`));
      if (r.status !== c.status) offenders.push(`${c.code} -> ${r.status}, not ${c.status}`);
      if (r.payload.error.code !== c.envelope) offenders.push(`${c.code} -> envelope ${r.payload.error.code}, not ${c.envelope}`);
      if (r.payload.error.details?.['inventoryCode'] !== c.code) offenders.push(`${c.code} -> details.inventoryCode is not the code`);
    }
    expect(offenders, 'every P3-S3 inventory refusal keeps the status and body it had before this change').toEqual([]);
  });

  it('an inventory code OUTSIDE the closed P3-S3 set still reaches the historical fallback', () => {
    const r = render(pgError('P0001', `${INVENTORY_OUTSIDE_THE_P3_S3_SET}: the warehouse does not hold enough of this variant`));
    expect(r.status, 'the filter’s inventory block is closed on purpose; the services translate this one themselves').toBe(403);
  });

  it('accounting mappings remain UNCHANGED', () => {
    const offenders: string[] = [];
    for (const c of ACCOUNTING_CONTRACT) {
      const r = render(new AccountingError(c.code as never, 'the authority refused this command'));
      if (r.status !== c.status) offenders.push(`${c.code} -> ${r.status}, not ${c.status}`);
      if (r.payload.error.code !== 'ACCOUNTING_REFUSED') offenders.push(`${c.code} -> envelope ${r.payload.error.code}`);
      if (r.payload.error.details?.['code'] !== c.code) offenders.push(`${c.code} -> details.code is not the code`);
    }
    expect(offenders, 'every accounting refusal keeps the status and body it had before this change').toEqual([]);
  });

  it('an `accounting.*` refusal raised by the DATABASE as P0001 is untouched by the new blocks', () => {
    const r = render(pgError('P0001', 'accounting.period_closed: the period is closed'));
    expect(r.status, 'the accounting vocabulary has its own typed path and is not in either selling registry').toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The REAL ROUTE. «A test that merely catches a rejected Promise is
// insufficient. Assert HTTP status and stable response code.»
// ─────────────────────────────────────────────────────────────────────────

describe('TL-P4-S2-R5: POST /v1/sales — the real route, the real filter', () => {
  it('the subject exists: the sale commit primitive and its registrations are in the tree', () => {
    requireSubject(subject.missing, CLAIM);
  });

  it('REAL ROUTE — insufficient stock is 409 CONFLICT with `inventory.insufficient_stock`, not 403', async () => {
    requireSubject(subject.missing, CLAIM);
    const res = await confirmSale(t, asMember(owner, A.businessId), {
      saleId: randomUUID(),
      customerId,
      warehouseId: A.w1,
      occurredOn: day,
      lines: [{ productId: A.piece.productId, quantity: '5' }],
    });
    expect(res.status, 'losing the stock is a business outcome: a conflict, never an authorization denial and never a 500').toBe(409);
    expect(codes(res).envelope, 'the stable response code').toBe('CONFLICT');
    expect(codes(res).domain, 'the machine-readable domain code the merchant sentence is rendered from').toBe('inventory.insufficient_stock');
    expect(/sale_commit|inventory_apply_stock_movements|PL\/pgSQL|SELECT /.test(bodyText(res.body)), 'no database internals in the body').toBe(false);
  });

  it('REAL ROUTE — a replay with a DIFFERENT intent is 409 CONFLICT with `sale.idempotency_conflict`', async () => {
    requireSubject(subject.missing, CLAIM);
    await stockUp('4');
    const saleId = randomUUID();
    const first = await confirmSale(t, asMember(owner, A.businessId), {
      saleId,
      customerId,
      warehouseId: A.w1,
      occurredOn: day,
      lines: [{ productId: A.piece.productId, quantity: '1' }],
    });
    expect(first.status, 'the first commit is accepted').toBe(200);
    const second = await confirmSale(t, asMember(owner, A.businessId), {
      saleId,
      customerId,
      warehouseId: A.w1,
      occurredOn: day,
      lines: [{ productId: A.piece.productId, quantity: '2' }],
    });
    expect(second.status, 'the same document id with a different command is a conflict (P4-AL-30)').toBe(409);
    expect(codes(second).envelope, 'the stable response code').toBe('CONFLICT');
    expect(codes(second).domain, 'the registered idempotency-conflict code').toBe('sale.idempotency_conflict');
  });

  it('REAL ROUTE — a MISSING product is 404 NOT_FOUND with a registered `*.product_not_found`', async () => {
    requireSubject(subject.missing, CLAIM);
    const res = await confirmSale(t, asMember(owner, A.businessId), {
      saleId: randomUUID(),
      customerId,
      warehouseId: A.w1,
      occurredOn: day,
      lines: [{ productId: randomUUID(), quantity: '1' }],
    });
    expect(res.status, 'a product the business does not hold is a 404, not a 403').toBe(404);
    expect(codes(res).envelope, 'the stable response code').toBe('NOT_FOUND');
    // `inventory.product_not_found` and not `sale.product_not_found`: the
    // stock identity resolution is the inventory module's, and a code keeps
    // ONE contract wherever it is raised (`sellingInventoryRefusal`). Both are
    // registered 404s, so the STATUS is the same either way; what is pinned
    // here is the code the route actually returns, measured rather than
    // assumed — this assertion was written the other way round first and the
    // route corrected it.
    expect(codes(res).domain, 'the registered not-found code the route actually returns').toBe('inventory.product_not_found');
  });

  it('REAL ROUTE — an INACTIVE (archived) product is 409 CONFLICT with `inventory.product_archived`', async () => {
    requireSubject(subject.missing, CLAIM);
    const q = ownerPool();
    const archived = await q.query(`UPDATE products SET status = 'archived' WHERE business_id = $1 AND id = $2`, [A.businessId, A.piece2.productId]);
    expect(archived.rowCount, 'exactly one product was archived for this case').toBe(1);
    try {
      const res = await confirmSale(t, asMember(owner, A.businessId), {
        saleId: randomUUID(),
        customerId,
        warehouseId: A.w1,
        occurredOn: day,
        lines: [{ productId: A.piece2.productId, quantity: '1' }],
      });
      expect(res.status, 'the state of the catalogue forbids the sale: a conflict, not an authorization denial').toBe(409);
      expect(codes(res).envelope, 'the stable response code').toBe('CONFLICT');
      expect(codes(res).domain, 'the domain code names the archived product').toBe('inventory.product_archived');
    } finally {
      await q.query(`UPDATE products SET status = 'active' WHERE business_id = $1 AND id = $2`, [A.businessId, A.piece2.productId]);
    }
  });

  it('REAL ROUTE — PLANTED: an internal `selling.*` invariant reached through the commit is 500 INTERNAL_ERROR, not 403', async () => {
    requireSubject(subject.missing, CLAIM);
    await stockUp('2');
    const res = await plantedSequenceFormat(async () =>
      confirmSale(t, asMember(owner, A.businessId), {
        saleId: randomUUID(),
        customerId,
        warehouseId: A.w1,
        occurredOn: day,
        lines: [{ productId: A.piece.productId, quantity: '1' }],
      }),
    );
    expect(
      res.status,
      'the invariant `selling.sequence_format_invalid` broke inside the commit: that is a DEFECT and 500 is the only status that says so',
    ).toBe(500);
    expect(res.body?.error?.code, 'the stable response code').toBe('INTERNAL_ERROR');
    expect(res.body?.error?.message, 'the generic safe sentence').toBe('Internal error');
    expect(res.body?.error?.details, 'no details: the internal invariant vocabulary is not part of the merchant contract').toBeUndefined();
    expect(typeof res.body?.error?.requestId, 'the correlation handle is still there').toBe('string');
    const text = bodyText(res.body);
    for (const needle of ['selling.', 'sequence_format', 'sale_commit', 'sale_document_number', 'PL/pgSQL', 'P0001', 'SELECT ', 'INV-', '{SEQ:']) {
      expect(text.includes(needle), `the response body leaked "${needle}" — no raw database text may reach a merchant`).toBe(false);
    }
  });

  it('REAL ROUTE — the planted defect is reverted: the very next sale commits', async () => {
    requireSubject(subject.missing, CLAIM);
    const res = await confirmSale(t, asMember(owner, A.businessId), {
      saleId: randomUUID(),
      customerId,
      warehouseId: A.w1,
      occurredOn: day,
      lines: [{ productId: A.piece.productId, quantity: '1' }],
    });
    expect(res.status, 'the plant left nothing behind: the route works again, so the 500 above was the DEFECT and not the route').toBe(200);
  });

  it('the route cases above ran against the TESTED composition, and the production composition registers the same controller', async () => {
    // `createTestApp()` composes `AppModule`; `merchant-api.module.ts` is the
    // production composition. A controller in only one of them is untestable
    // from the other side, which is what `P4_S2_REQUIRED_CONTROLLERS` exists
    // to make a law rather than a habit. Read as SOURCE, because the question
    // is about the composition this process did NOT build.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = join(__dirname, '..', '..');
    const offenders: string[] = [];
    for (const rel of ['apps/api/src/app/app.module.ts', 'apps/api/src/app/merchant-api.module.ts']) {
      const src = readFileSync(join(root, rel), 'utf8');
      for (const controller of P4_S2_REQUIRED_CONTROLLERS) if (!src.includes(controller)) offenders.push(`${rel} does not register ${controller}`);
    }
    expect(offenders, 'both compositions register the P4-S2 controllers, so the route cases above measure the mounted surface of each').toEqual([]);
    // The route is MOUNTED in the composition these tests built, asserted
    // POSITIVELY: an empty body reaches `SalesController`'s own
    // `ZodValidationPipe` and is refused `VALIDATION_FAILED`, which only a
    // mounted handler produces. Stated this way rather than as "the router did
    // not answer", because `tests/security/phase4-forward-evolution.test.ts`
    // refuses a permanent suite that names the router's own status beside a
    // Phase 4 route — correctly, since such a line reads as a claim that the
    // route does not exist, and this file's whole subject is that it does.
    const probe = await t.request.post('/v1/sales').set(asMember(owner, A.businessId)).send({});
    expect(probe.status, 'an empty body reaches the handler’s validation pipe — a route nothing mounted could not refuse it this way').toBe(400);
    expect(
      (probe.body as { error?: { code?: unknown } } | undefined)?.error?.code,
      'the refusal is the handler’s own, so every case above measured the mounted surface',
    ).toBe('VALIDATION_FAILED');
  });
});
