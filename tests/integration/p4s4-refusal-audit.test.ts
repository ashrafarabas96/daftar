/**
 * P4-S4 — A REFUSED COMMAND LEAVES AUDIT EVIDENCE (P4-AL-48, P4-AL-48(a)).
 *
 * `P4-AL-48` requires that «a refusal is audited as heavily as a success,
 * because the forged-total and over-cap attempts are the ones worth seeing».
 * It was not audited at all, and the reason was structural:
 *
 *   - no Phase 4 module called `AuditService` — every Phase 4 audit row was
 *     written by the SQL routine itself;
 *   - and the routine's `INSERT INTO audit_events` is its LAST step
 *     (`0081:2170`), AFTER all 33 of its `RAISE EXCEPTION`s
 *     (`0081:1874-2128`). A `RAISE` aborts the transaction, so a row written
 *     before it would not survive either.
 *
 * Measured before the fix, across a 409: audit 8 rows before and 8 after,
 * outbox 7 and 7. **A refused customer payment persisted no evidence.**
 *
 * The fix is `OutboxService.emit`'s already-accepted own-transaction shape:
 * `AuditService.recordRefusal` writes the refusal row in a SECOND
 * business-scoped `daftar_app` transaction, after the first has rolled back.
 * It needs no migration — `daftar_app` already holds `INSERT ON audit_events`
 * (`0006:79`) under the `audit_scope` policy (`0006:53-55`).
 *
 * WHAT MAKES THIS SUITE HONEST. §A proves a SERVICE-side refusal is audited
 * and §B proves a ROUTINE-side one is — §B is the case that can only pass if
 * the second transaction really does outlive the abort, because that refusal
 * is raised inside the routine. §C is the other half: a SUCCESS writes no
 * `.refused` row, so the suite cannot pass by auditing everything as refused.
 * §D holds the classifier to its own law — an error that is not a refusal is
 * not audited as one.
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '@daftar/domain-core';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { refusedCode } from '../../apps/api/src/modules/receivables/receivables-errors';
import { collectPayment, type AllocationInput, type PaymentInput } from '../golden-regression/phase4-s4/settlement-path';
import {
  newCustomer,
  sellOnCredit,
  settlementMissing,
  settlementWorld,
  stockUp,
  type OpenInvoice,
  type SettlementWorld,
} from '../golden-regression/phase4-s4/settlement-world';

const CLAIM = 'a refused customer payment persists an audit row carrying its refusal code and the figures that caused it, in its own committed transaction';

let w: SettlementWorld;
let missing: readonly string[] = [];
let invoice: OpenInvoice;
let customerId: string;

/** The refusal code the API actually put on the response. */
function responseCode(res: Response): string | undefined {
  const body = res.body as { error?: { details?: { receivablesCode?: string } } };
  return body.error?.details?.receivablesCode;
}

interface AuditRow {
  action: string;
  entity: string;
  entity_id: string | null;
  actor_user_id: string | null;
  metadata: {
    outcome?: string;
    refusalCode?: string;
    operation?: string;
    intentSha256?: string | null;
    branchId?: string | null;
    tillSessionId?: string | null;
    figures?: Record<string, unknown>;
  };
}

/** Every audit row this business holds for one document id, newest last. */
async function auditRows(entityId: string): Promise<AuditRow[]> {
  const r = await ownerPool().query<AuditRow>(
    `SELECT action, entity, entity_id, actor_user_id, metadata
       FROM audit_events
      WHERE business_id = $1 AND entity_id = $2
      ORDER BY created_at, action`,
    [w.shop.businessId, entityId],
  );
  return r.rows;
}

/** How many outbox rows name this document anywhere in their payload. */
async function outboxRowsFor(documentId: string): Promise<number> {
  const r = await ownerPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM outbox_events WHERE business_id = $1 AND payload::text LIKE '%' || $2 || '%'`,
    [w.shop.businessId, documentId],
  );
  return r.rows[0]?.n ?? 0;
}

/** Whether any `payments` row exists for this id — a refusal must leave none. */
async function paymentRows(paymentId: string): Promise<number> {
  const r = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM payments WHERE business_id = $1 AND id = $2`, [
    w.shop.businessId,
    paymentId,
  ]);
  return r.rows[0]?.n ?? 0;
}

/** The branch an invoice carries, read from the relation and not from the audit row it is compared with. */
async function invoiceBranch(invoiceId: string): Promise<string> {
  const r = await ownerPool().query<{ b: string }>(`SELECT branch_id::text AS b FROM invoices WHERE business_id = $1 AND id = $2`, [
    w.shop.businessId,
    invoiceId,
  ]);
  const b = r.rows[0]?.b;
  expect(b, 'the invoice this refusal names has no branch, so the assertion has no subject').toBeDefined();
  return b as string;
}

/** The whole invoice as one leg, at the start of its chain. */
function wholeInvoiceLeg(inv: OpenInvoice): AllocationInput {
  return {
    invoiceId: inv.invoiceId,
    appliedMinor: inv.totalTxnMinor,
    releasedBeforeMinor: '0',
    invoiceTotalTxnMinor: inv.totalTxnMinor,
    invoiceTotalBaseMinor: inv.totalBaseMinor,
  };
}

/** A payment request over this invoice, with whatever the case needs overridden. */
function request(over: Partial<PaymentInput> = {}): PaymentInput {
  const leg = wholeInvoiceLeg(invoice);
  return {
    paymentId: randomUUID(),
    customerId,
    paymentMethodId: w.paymentMethodId,
    paymentDate: w.day,
    amountMinor: leg.appliedMinor,
    allocations: [leg],
    ...over,
  };
}

interface Refusal {
  readonly input: PaymentInput;
  readonly res: Response;
  readonly rows: AuditRow[];
  readonly outbox: number;
  readonly payments: number;
}

async function refuse(input: PaymentInput): Promise<Refusal> {
  const res = await collectPayment(w.t, w.headers, input);
  return {
    input,
    res,
    rows: await auditRows(input.paymentId),
    outbox: await outboxRowsFor(input.paymentId),
    payments: await paymentRows(input.paymentId),
  };
}

/** §A — refused by the SERVICE, before the transaction opens: a future date. */
let service: Refusal;
/** §B — refused by the ROUTINE, inside the transaction it then aborts: a reused allocation id. */
let routine: Refusal;
/** §C — the control: a payment that succeeds. */
let success: { readonly input: PaymentInput; readonly res: Response; readonly rows: AuditRow[] };

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  w = await settlementWorld('s4refusalaudit');
  missing = await settlementMissing(w);
  if (missing.length > 0) return;

  await stockUp(w, '100', '5');
  customerId = await newCustomer(w);

  // §A: a date after the business's own today. The service refuses it from its
  // one state read (`customer-payment.service.ts`, `state.future`), so no
  // transaction is ever opened and no routine is ever called.
  const futureInvoice = await sellOnCredit(w, customerId, '4');
  invoice = futureInvoice;
  const far = new Date(`${w.day}T00:00:00Z`);
  far.setUTCFullYear(far.getUTCFullYear() + 1);
  service = await refuse(request({ paymentDate: far.toISOString().slice(0, 10) }));

  // §B: an allocation id already used by ANOTHER document. This one is refused
  // by the ROUTINE and by nothing before it: the reuse check is
  // `EXISTS (SELECT 1 FROM payment_allocations ...)` at `0081:1975-1978`,
  // inside the routine's own transaction, which the `RAISE` then aborts. The
  // service cannot pre-empt it — `UNIQUE_KEY_REFUSALS` exists precisely
  // because the collision is the database's to see — so this is the case that
  // proves the refusal row's own transaction OUTLIVES the abort, which is the
  // whole architectural claim of P4-AL-48(a).
  const first = await sellOnCredit(w, customerId, '4');
  const reusedAllocationId = randomUUID();
  const won = await collectPayment(
    w.t,
    w.headers,
    request({ allocations: [{ ...wholeInvoiceLeg(first), allocationId: reusedAllocationId }], amountMinor: first.totalTxnMinor }),
  );
  expect(won.status, 'the first payment must succeed, or §B has no colliding id to reuse').toBeLessThan(300);
  invoice = await sellOnCredit(w, customerId, '4');
  routine = await refuse(request({ allocations: [{ ...wholeInvoiceLeg(invoice), allocationId: reusedAllocationId }] }));

  // §C: the control. Nothing about this payment is refused.
  invoice = await sellOnCredit(w, customerId, '4');
  const ok = request();
  const okRes = await collectPayment(w.t, w.headers, ok);
  success = { input: ok, res: okRes, rows: await auditRows(ok.paymentId) };
}, 300_000);

describe(`P4-AL-48 — ${CLAIM}`, () => {
  it('the slice is present, so this suite has a subject', () => {
    expect(missing, `the P4-S4 subject is incomplete: ${missing.join(' · ')}`).toEqual([]);
  });

  describe('§A — a refusal raised by the SERVICE is audited', () => {
    it('the merchant got the refusal they earned', () => {
      expect(service.res.status).toBe(422);
      expect(responseCode(service.res)).toBe('customer_payment.date_in_future');
    });

    it('exactly one audit row exists for the refused document, and it is a refusal', () => {
      expect(service.rows).toHaveLength(1);
      const row = service.rows[0];
      expect(row?.action).toBe('customer.collect_payment.refused');
      expect(row?.entity).toBe('payment');
      expect(row?.entity_id).toBe(service.input.paymentId);
      expect(row?.metadata.outcome).toBe('refused');
    });

    it('the row carries the refusal code and the permission exercised, in its OWN metadata', () => {
      const m = service.rows[0]?.metadata;
      // Recoverable-by-join does not exist on this path: the assertion's
      // registry INSERT (`0054:450-451`) and the document row both rolled
      // back, so these are carried literally (the F-3 answer).
      expect(m?.refusalCode).toBe('customer_payment.date_in_future');
      expect(m?.operation).toBe('customer.collect_payment');
    });

    it('the row names the actor who attempted it', () => {
      // `not.toBeNull()` alone would pass on `undefined`, i.e. on NO ROW —
      // the assertion has to require a string, or it is green about nothing.
      expect(typeof service.rows[0]?.actor_user_id).toBe('string');
    });

    it('the row carries the figures that caused it, as decimal strings and never as numbers', () => {
      const f = service.rows[0]?.metadata.figures ?? {};
      expect(f['amountMinor']).toBe(service.input.amountMinor);
      expect(f['customerId']).toBe(customerId);
      expect(f['paymentDate']).toBe(service.input.paymentDate);
      expect(f['allocationCount']).toBe('1');
      for (const [k, v] of Object.entries(f)) expect(typeof v, `${k} must not be a number in a figures object`).not.toBe('number');
    });

    it('nothing else survived: no payment row and no outbox event', async () => {
      expect(service.payments).toBe(0);
      expect(service.outbox).toBe(0);
    });
  });

  describe('§B — a refusal raised by the ROUTINE, after it aborts its own transaction, is audited', () => {
    it('the merchant got the routine’s refusal', () => {
      expect(routine.res.status).toBe(400);
      expect(responseCode(routine.res)).toBe('customer_payment.allocations_invalid');
    });

    it('the refusal row survived the abort — which is the whole point of the own-transaction shape', () => {
      expect(routine.rows).toHaveLength(1);
      expect(routine.rows[0]?.action).toBe('customer.collect_payment.refused');
      expect(routine.rows[0]?.metadata.refusalCode).toBe('customer_payment.allocations_invalid');
    });

    it('it carries the intent digest and the branch, which this refusal happened late enough to know', async () => {
      const m = routine.rows[0]?.metadata;
      expect(typeof m?.intentSha256).toBe('string');
      expect(m?.intentSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(m?.branchId).toBe(await invoiceBranch(routine.input.allocations[0]?.invoiceId ?? ''));
    });

    it('the till session is NULL, because receivables is not a POS path', () => {
      expect(routine.rows[0]?.metadata.tillSessionId).toBeNull();
    });

    it('and still nothing committed: no payment row, no outbox event', () => {
      expect(routine.payments).toBe(0);
      expect(routine.outbox).toBe(0);
    });
  });

  describe('§C — a SUCCESS writes no refusal row, so this suite cannot pass by auditing everything', () => {
    it('the payment was collected', () => {
      expect(success.res.status).toBeLessThan(300);
    });

    it('its audit row is the success the routine writes, and no `.refused` row exists', () => {
      const actions = success.rows.map((r) => r.action);
      expect(actions).toContain('customer.payment_collected');
      expect(actions.filter((a) => a.endsWith('.refused'))).toEqual([]);
    });
  });

  describe('§D — an error that is not a refusal is not audited as one', () => {
    it('`refusedCode` returns the code for a classified refusal', () => {
      expect(refusedCode(new AppError('CONFLICT', 'x', 409, { receivablesCode: 'customer_payment.customer_mismatch' }))).toBe(
        'customer_payment.customer_mismatch',
      );
    });

    it('and NULL for an infrastructure failure, a seam defect or a bug', () => {
      expect(refusedCode(new Error('ECONNRESET'))).toBeNull();
      expect(refusedCode(new AppError('INTERNAL_ERROR', 'x', 500))).toBeNull();
      expect(refusedCode(null)).toBeNull();
    });
  });
});
