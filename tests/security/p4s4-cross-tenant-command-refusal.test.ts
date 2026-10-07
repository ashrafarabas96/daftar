/**
 * P4-S4 — §16 CASE C: A TENANT-A MERCHANT ATTEMPTS AN OPERATION ON A
 * TENANT-B OBJECT, AND THE OPERATION IS REFUSED WITH NO EFFECT IN B.
 *
 * (TL-P4-RLS-INT-01 §10, §15, §16 CASE C. CASE A, CASE B and CASE D of that
 *  matrix are NOT this file's: this file holds exactly one cell of it.)
 *
 * ── WHAT THE TECH LEAD RULED, AND THEREFORE WHAT IS PROVED HERE ──
 *
 * §10 settled that the internal NOLOGIN principals' broad read visibility is
 * INTENTIONAL, and that the question which must be proved instead is:
 *
 *     CAN AN ORDINARY RUNTIME CREDENTIAL REACH CROSS-TENANT DATA OR EFFECT
 *     THROUGH THAT AUTHORITY?
 *
 * So the actor here is never an internal principal and never a superuser. It
 * is a REAL MERCHANT of Tenant A, holding a real access token, a real
 * membership and the real Phase 4 permissions, issuing a LEGITIMATE product
 * command through the public HTTP surface — with one or more identifiers
 * belonging to Tenant B's business substituted in.
 *
 * ── WHY THIS FILE IS NOT A SECOND COPY OF AN EXISTING LAW ──
 *
 * The cross-tenant REFUSAL of the Phase 4 surface is already proved, route by
 * route, in ALLOW/DENY pairs, by
 * `tests/golden-regression/phase4/01-cross-tenant.golden.test.ts` — the sale
 * command at `:738`, the payment at `:1762`, the credit application at
 * `:1851`, the payment read at `:1917`, the credit read at `:1943`, the
 * generic Phase 4 reads at `:590` and `:624`, and the SQL half of all of it at
 * `:530`, `:816`, `:1985`. That file is the authority for "it answers 4xx",
 * and nothing here restates it.
 *
 * What that file does NOT do — and what the Tech Lead calls "the half that is
 * usually missing" — is the two halves below.
 *
 * ## HALF ONE: THE REFUSAL IS PROVED TO BE THE *RIGHT* REFUSAL.
 *
 * Every existing cross-tenant case asserts the refusal as MEMBERSHIP IN A
 * STATUS SET: `expect([403, 404, 409, 422]).toContain(res.status)`
 * (`01-cross-tenant.golden.test.ts:752`, `:768`, `:782`, `:1817`, `:1835`,
 * `:1847`, `:1876`, `:1890`, `:1902`). That set is wide enough to be satisfied by a refusal
 * that says NOTHING about tenancy:
 *
 *   - a 400/422 from the STRUCTURAL validator — a field missing, an id that
 *     did not parse, an amount that did not add up. A validator that refuses
 *     before the business binding is ever consulted would keep every one of
 *     those assertions green with the barrier removed. This is not
 *     hypothetical: the golden's own comment at `:1775-1789` records that a
 *     stray `creditId` made "every DENY form of this case answer `400
 *     customer_payment.allocations_invalid` — refused by the STRUCTURAL
 *     validator before the business binding was ever consulted".
 *   - a 404 that means "this row does not exist anywhere", which is also what
 *     a broken read returns.
 *   - and for a COLLECTION route, `200 []`. AN EMPTY COLLECTION IS NEVER A
 *     REFUSAL, and a status-set assertion cannot even see one.
 *
 * So this file CLASSIFIES every refusal into one of seven named verdicts
 * (`Verdict` below) and asserts WHICH one happened, with its own message:
 * `authorization`, `tenant_barrier`, `grant`, `conflict`, and the three that
 * are FAILED PROOFS — `structural`, `empty_collection`, `accepted`. And a
 * `tenant_barrier` verdict is only accepted when its three preconditions are
 * independently measured, because "not found" on its own is the weakest
 * possible evidence:
 *
 *   (a) EXISTENCE — the subject row really is in B, read on the owner
 *       connection, which bypasses row security. A not-found over a row that
 *       does not exist proves nothing.
 *   (b) INVISIBILITY — the same row, read as `daftar_app` under A's OWN
 *       tenant/business GUCs, is ZERO rows. That is the barrier, measured
 *       where it lives, and it is what makes (c) a tenancy refusal rather
 *       than a 404 from a read that is simply broken.
 *   (c) THE POSITIVE CONTROL — the identical command shape DEMONSTRABLY WORKS
 *       in A. Every ALLOW below is a real 200/201 taken in the fixture, so
 *       no refusal here can be exhaustion, a closed invoice or a missing
 *       field.
 *
 * ## HALF TWO: NO EFFECT IN B, READ FROM THE RELATIONS THEMSELVES.
 *
 * The existing cases that read B's state at all read a COUNT of ONE OR TWO
 * relations: `saleCount` (`01-cross-tenant.golden.test.ts:712`) counts
 * `sales`; the payment case counts `payments` and `payment_allocations`
 * (`:1811-1812`, `:1826-1827`); the credit-application case counts
 * `customer_credit_applications` (`:1871`, `:1884`). A count of three relations is
 * blind to four of the Tech Lead's seven clauses and to one whole CLASS of
 * effect:
 *
 *   - NO JOURNAL ENTRY — `journal_entries` / `journal_lines` are counted by no
 *     cross-tenant case in the tree. `grep -rl tableDigest tests/` names ten
 *     files and not one of them is a Phase 4 cross-tenant suite.
 *   - NO STOCK MOVEMENT — `stock_movements` / `stock_levels` likewise. A sale
 *     is the one Phase 4 command that moves stock.
 *   - NO CUSTOMER-CREDIT MUTATION and NO SETTLEMENT MUTATION are MUTATIONS IN
 *     PLACE: applying a credit lowers `customer_credits.remaining_amount_minor`
 *     and settling an invoice changes what it owes. A ROW COUNT CANNOT SEE
 *     EITHER OF THEM — the count is identical before and after — and the red
 *     proof `the no-effect law sees a mutation IN PLACE` below demonstrates
 *     exactly that on a real credit.
 *
 * So "no effect" here is an ORDERED-ROW DIGEST of EVERY business-scoped
 * relation in the catalogue plus the journal and the side-effect logs, taken
 * on the owner connection before and after, and asserted BYTE-IDENTICAL.
 * The digest primitive is NOT rebuilt: `tests/helpers/table-digest.ts:49`
 * `tableDigest`, `:73` `changedTables` and `:79` `rowCounts` are the P3-S8 "byte-identical,
 * measured" helpers, and the relation set is DISCOVERED out of `pg_class`
 * (`tests/golden-regression/phase4-s2/harness.ts:411` `tablesWithColumn`)
 * rather than listed, so a relation a later slice adds is inside this law on
 * the day it lands.
 *
 * The seventh clause, NO INAPPROPRIATE DATA RETURNED, is about the RESPONSE
 * rather than the relations, so it is asserted on the response: no identifier
 * of B appears anywhere in the body the refusal handed back.
 *
 * ── THE RED PROOFS ──
 *
 * Each law is shown to be able to FAIL, against a REAL subject and never a
 * fictional one (§15, and «never plant a fictional subject and assert no
 * finding»):
 *
 *   RP-1 the digest law sees a real INSERTING effect — B's OWN owner commits
 *        a lawful credit sale, and the law names `sales`, `invoices`,
 *        `journal_entries`, `journal_lines` and `stock_movements` as changed.
 *   RP-2 the digest law sees a MUTATION IN PLACE while the row count does not
 *        — B's own credit application lowers B's credit, `customer_credits`
 *        holds the same number of rows, and the digest changes anyway. This
 *        is the clause a count-based law structurally cannot hold.
 *   RP-3 the INVISIBILITY leg can fail — the restrictive read barrier on the
 *        four P4-S4 relations is WIDENED to `USING (true)` inside a
 *        transaction that is rolled back, and B's rows become visible to a
 *        reader under A's scope. The permissive variant is planted against
 *        real rows and the law catches it.
 *   RP-4 the classifier refuses a STRUCTURAL refusal as a tenancy proof — a
 *        real request with a required field removed.
 *   RP-5 the classifier refuses `200 []` as a refusal — a real collection
 *        route answering for a customer that holds nothing.
 */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { confirmSale } from '../golden-regression/phase4-s2/sale-path';
import { requireSubject, saleSubject, tablesWithColumn } from '../golden-regression/phase4-s2/harness';
import { JOURNAL_AND_LOGS, changedTables, rowCounts, tableDigest, type TableDigest } from '../helpers/table-digest';
import { appDbUrl, createTestApp, ensurePostgres, ownerPool, resetData, uniqueEmail, type TestApp } from '../helpers/test-app';

const CLAIM = '§16 CASE C — a Tenant A merchant reaches no cross-tenant data and no cross-tenant effect through a legitimate Phase 4 command';

/**
 * The four relations `0081` creates and the five `0075` creates: the rows a
 * CASE C attempt would have to touch to have reached anything. Named here
 * only for the INVISIBILITY leg and for RP-3's plant; the NO-EFFECT law does
 * not use this list, because a list is a blind spot and that law discovers
 * its relations out of the catalogue.
 */
const BARRIER_RELATIONS = ['customer_credit_applications', 'customer_credits', 'customers', 'invoices', 'payment_allocations', 'payments', 'sales'] as const;

/**
 * THE SEVEN "NO EFFECT IN B" CLAUSES of §15, each as the relations that would
 * carry the effect if it had occurred. The clause is the UNIT the failure
 * message names, so a digest that moves is reported as "a journal entry was
 * written in B" rather than as a table name a reader has to interpret.
 *
 * `response` is the one clause that is not a relation: it is read from the
 * refusal's own body.
 */
const CLAUSES: readonly { readonly clause: string; readonly relations: readonly string[] }[] = [
  { clause: 'no financial row', relations: ['sales', 'sale_items', 'invoices', 'invoice_items', 'payments'] },
  { clause: 'no journal entry', relations: ['journal_entries', 'journal_lines', 'accounting_source_bindings'] },
  { clause: 'no stock movement', relations: ['stock_movements', 'stock_levels'] },
  { clause: 'no customer-credit mutation', relations: ['customer_credits'] },
  { clause: 'no settlement mutation', relations: ['payment_allocations', 'customer_credit_applications'] },
  { clause: 'no successful business effect', relations: ['customers', 'customer_contacts', 'invoice_sequences', 'audit_events', 'outbox_events'] },
];

/**
 * ── THE REFUSAL VOCABULARY ──
 *
 * Seven verdicts, four of which are refusals that say something about
 * tenancy and three of which are FAILED PROOFS. The distinction is the whole
 * of §15's "a refusal must be proved to be the RIGHT refusal".
 */
type Verdict =
  /** 401/403: the credential or the business context was refused. Authority, not row visibility. */
  | 'authorization'
  /** 404 `<domain>.not_found`: the row is invisible to this scope. The RLS barrier, subject to the three preconditions. */
  | 'tenant_barrier'
  /** A privilege refusal (SQLSTATE 42501 / "permission denied"): the missing GRANT, not a policy. */
  | 'grant'
  /** 409: a state conflict. A refusal, but one that concedes the row was READ, so it is reported separately. */
  | 'conflict'
  /** 400/422 from the structural validator: a FAILED PROOF — it would pass with the barrier gone. */
  | 'structural'
  /** 2xx with an empty collection: a FAILED PROOF — an empty collection is never a refusal. */
  | 'empty_collection'
  /** 2xx: the command was TAKEN. The finding this whole file exists to catch. */
  | 'accepted';

/** The verdicts that are a tenancy refusal at all. */
const REFUSALS: readonly Verdict[] = ['authorization', 'tenant_barrier', 'grant', 'conflict'];

/** The verdicts §15 forbids a CASE C attempt to end in, each with why it is not a proof. */
const NOT_A_PROOF: Readonly<Record<string, string>> = {
  accepted: 'the command was ACCEPTED — a Tenant A credential reached a Tenant B object',
  empty_collection:
    'the route answered 2xx with an EMPTY COLLECTION. An empty collection is never a refusal: it is indistinguishable from a read that found nothing, and a status-set assertion cannot see it at all',
  structural:
    'the refusal came from the STRUCTURAL validator (a field, a parse or an arithmetic check) BEFORE the business binding was consulted. It would be returned just the same with the tenant barrier removed, so it is not evidence of isolation',
};

/**
 * THE STABLE MACHINE CODE OF A REFUSAL — and the first thing this exercise
 * MEASURED that the brief did not say.
 *
 * `apps/api/src/common/error.filter.ts:33` renders
 * `{ error: { code, message, requestId, details } }`, and the TOP-LEVEL `code`
 * of every Phase 4 cross-tenant refusal is the generic HTTP one, `NOT_FOUND`.
 * The DOMAIN code — the one that says which authority refused and why — is
 * nested: `details.sellingCode`, `details.receivablesCode`,
 * `details.inventoryCode`. A classifier that read `error.code` alone sees
 * `NOT_FOUND` for a structural parse failure and for the tenant barrier
 * alike, which is exactly the collapse §15 forbids. So the domain code is
 * read from `details`, by the `…Code` suffix the filter uses, and the generic
 * code is only the fallback.
 */
function codeOf(res: Response): string {
  const err = (res.body as { error?: { code?: unknown; details?: Record<string, unknown> } } | undefined)?.error;
  const details = err?.details ?? {};
  for (const [k, v] of Object.entries(details)) if (/Code$/.test(k) && typeof v === 'string' && v.includes('.')) return v;
  return String(err?.code ?? '');
}

/** Whether a 2xx body is an empty collection — the answer a leaky collection route gives that looks like a refusal. */
function isEmptyCollection(body: unknown): boolean {
  if (Array.isArray(body)) return body.length === 0;
  if (body !== null && typeof body === 'object') {
    const items = (body as { items?: unknown }).items;
    if (Array.isArray(items)) return items.length === 0;
  }
  return false;
}

/**
 * THE CLASSIFIER. It reads the status and the stable code and nothing else —
 * never a message, which is localized and may not be parsed.
 *
 * A privilege refusal is looked for FIRST, because it can arrive under any
 * status: `42501` is what a missing GRANT raises, and a law that read it as
 * "the barrier held" would be a law about the grant (the distinction the
 * sibling `p4s4-rls-barrier-behaviour.test.ts:60-75` draws for the DB half).
 */
function classify(res: Response): Verdict {
  const code = codeOf(res);
  const text = JSON.stringify(res.body ?? {});
  if (/42501|permission denied|row-level security|row level security/i.test(text)) return 'grant';
  if (res.status >= 200 && res.status < 300) return isEmptyCollection(res.body) ? 'empty_collection' : 'accepted';
  if (res.status === 401 || res.status === 403) return 'authorization';
  // `…not_found` and never `…_invalid`: the domain codes that end in
  // `not_found` are the ones a row the scope cannot see produces
  // (`sale.not_found`, `sale.customer_not_found`,
  // `inventory.warehouse_not_found`, `customer_payment.not_found`,
  // `customer_credit_application.not_found`, `invoice.not_found`,
  // `customer.not_found`), while a 404 carrying only the generic
  // `NOT_FOUND` — a route that does not exist, a path that did not parse —
  // is structural and is NOT a tenancy proof.
  if (res.status === 404) return /\.[a-z_]*not_found$/.test(code) ? 'tenant_barrier' : 'structural';
  if (res.status === 409) return 'conflict';
  if (res.status === 400 || res.status === 422) return 'structural';
  return 'structural';
}

/** The refusal, stated so the failure message says WHICH refusal happened and why it is or is not a proof. */
function expectTenantRefusal(res: Response, what: string): Verdict {
  const verdict = classify(res);
  const why = NOT_A_PROOF[verdict];
  expect(
    why,
    `${what}: ${why ?? ''} — status ${res.status}, code ${JSON.stringify(codeOf(res))}, body ${JSON.stringify(res.body).slice(0, 600)}`,
  ).toBeUndefined();
  expect(REFUSALS, `${what}: the verdict ${verdict} is not one of the refusal verdicts`).toContain(verdict);
  return verdict;
}

interface Shop {
  readonly tenantId: string;
  readonly businessId: string;
  readonly branchId: string;
  readonly warehouseId: string;
  readonly productId: string;
  readonly userId: string;
  customerId: string;
  /** Everything the shop's own commands built, so every DENY below has a real ALLOW beside it. */
  paymentMethodId: string;
  /** The invoice the shop's own payment settled in full — the demonstration that the ALLOW form works. */
  paidInvoiceId: string;
  /** An invoice still OPEN, so a cross-tenant settlement attempt has something it could have settled. */
  openInvoiceId: string;
  paymentId: string;
  creditId: string;
  saleId: string;
}

interface Actor {
  readonly token: string;
  readonly userId: string;
}

const hdr = (a: Actor, businessId: string): Record<string, string> => ({ Authorization: `Bearer ${a.token}`, 'X-Business-Id': businessId });

let t: TestApp;
let app: Pool;
/** The relation set the NO-EFFECT law digests: every business-scoped relation in the catalogue, plus the journal and the logs. */
let EFFECT_TABLES: readonly string[] = [];
let A: Shop;
let B: Shop;
let merchantA: Actor;
let merchantB: Actor;
let day = '';

const onboarding = { countryCode: 'PS', baseCurrency: 'ILS', preferredLocale: 'en' } as const;

/** One `daftar_app` statement under the tenant/business GUCs of `scope` — the idiom `purchase-s4-isolation.test.ts:172` uses. */
async function asApp<T extends Record<string, unknown>>(scope: { tenantId: string; businessId: string }, sql: string, params: unknown[] = []): Promise<T[]> {
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [scope.tenantId, scope.businessId]);
    const r = await client.query<T>(sql, params);
    await client.query('ROLLBACK');
    return r.rows;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Rows of `relation` with this id, read on the OWNER connection, which bypasses row security. The EXISTENCE leg. */
async function existsForOwner(relation: string, businessId: string, id: string): Promise<number> {
  if (!/^[a-z_]+$/.test(relation)) throw new Error(`refusing to interpolate ${JSON.stringify(relation)}`);
  const r = await ownerPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM public.${relation} WHERE business_id = $1 AND id = $2`, [businessId, id]);
  return Number(r.rows[0]?.n ?? '-1');
}

/** The same row, as `daftar_app` under A's OWN scope. The INVISIBILITY leg: this must be ZERO. */
async function visibleUnder(scope: Shop, relation: string, id: string): Promise<number> {
  if (!/^[a-z_]+$/.test(relation)) throw new Error(`refusing to interpolate ${JSON.stringify(relation)}`);
  const rows = await asApp<{ n: string }>(scope, `SELECT count(*)::text AS n FROM public.${relation} WHERE id = $1`, [id]);
  return Number(rows[0]?.n ?? '-1');
}

/** B's whole state, byte for byte, on the owner connection. */
const snapshot = async (): Promise<TableDigest> => tableDigest(ownerPool(), EFFECT_TABLES, { businessId: B.businessId });

/**
 * THE NO-EFFECT LAW. Every one of the six relational clauses, plus a
 * catch-all for any relation no clause claims — because a clause list is a
 * list, and §15's seventh demand is that NOTHING in B moved, not that the
 * six named families did not.
 */
function noEffectProblems(before: TableDigest, after: TableDigest): string[] {
  const changed = changedTables(before, after);
  const problems: string[] = [];
  for (const { clause, relations } of CLAUSES) {
    const hit = relations.filter((r) => changed.includes(r));
    if (hit.length > 0) problems.push(`«${clause}» is BROKEN in B — ${hit.join(', ')} is not byte-identical`);
  }
  const claimed = new Set(CLAUSES.flatMap((c) => c.relations));
  const unclaimed = changed.filter((r) => !claimed.has(r));
  if (unclaimed.length > 0)
    problems.push(`«no successful business effect» is BROKEN in B — ${unclaimed.join(', ')} moved, in a relation no named clause covers`);
  return problems;
}

/**
 * EVERY clause, reported TOGETHER rather than one `expect` at a time: a
 * command that wrote a journal entry AND consumed a credit must say so about
 * both, because the first failing assertion would otherwise hide the rest and
 * the reader would fix one clause and believe the case green.
 */
function expectNoEffectInB(before: TableDigest, after: TableDigest, what: string): void {
  const problems = noEffectProblems(before, after);
  expect(problems, `${what}: B's state is not byte-identical — ${problems.join('; ')}`).toEqual([]);
}

/** The seventh clause: NO INAPPROPRIATE DATA RETURNED — not one identifier of B is anywhere in the body. */
function expectNothingOfBReturned(res: Response, what: string): void {
  const text = JSON.stringify(res.body ?? {});
  const leaked = [
    ['businessId', B.businessId],
    ['tenantId', B.tenantId],
    ['customerId', B.customerId],
    ['paymentId', B.paymentId],
    ['creditId', B.creditId],
    ['saleId', B.saleId],
    ['warehouseId', B.warehouseId],
    ['productId', B.productId],
    ['branchId', B.branchId],
  ].filter(([, id]) => typeof id === 'string' && id.length === 36 && text.includes(id));
  expect(
    leaked.map(([k]) => k),
    `${what}: «no inappropriate data returned» is BROKEN — the refusal's own body carries B's ${leaked.map(([k]) => k).join(', ')}`,
  ).toEqual([]);
  // A refusal must not echo B's ids back in ANY shape, so the response is also
  // required to be shorter than a document: a 404 that rendered B's invoice
  // would be caught above by id, and one that rendered only its figures is
  // caught here.
  expect(text.length, `${what}: the refusal body is ${text.length} bytes, which is a document and not a refusal`).toBeLessThan(4000);
}

/**
 * ONE CASE C ATTEMPT, with both halves and all four legs.
 *
 * `subject` is the row in B the attempt names, so the EXISTENCE and
 * INVISIBILITY legs have something to measure; a case whose subject is a
 * composite (a sale naming B's customer AND warehouse AND product) names the
 * one that carries the row security the attempt is testing.
 */
async function caseC(o: {
  readonly what: string;
  readonly subject: { readonly relation: string; readonly id: string } | null;
  /**
   * The DOMAIN code this attempt must be refused with. Pinned per case, not
   * matched loosely: `/not_found/` would be satisfied by a route that did not
   * exist, and the whole point of the classifier is that the refusal names
   * the authority that refused it.
   */
  readonly code: RegExp;
  readonly attempt: () => Promise<Response>;
}): Promise<{ verdict: Verdict; status: number; code: string }> {
  if (o.subject !== null) {
    // (a) EXISTENCE — the row really is in B.
    expect(
      await existsForOwner(o.subject.relation, B.businessId, o.subject.id),
      `${o.what}: the subject ${o.subject.relation} ${o.subject.id} is not in B at all, so a not-found would prove nothing`,
    ).toBe(1);
    // (b) INVISIBILITY — and it is ZERO rows to A's own credential.
    expect(
      await visibleUnder(A, o.subject.relation, o.subject.id),
      `${o.what}: B's ${o.subject.relation} row IS VISIBLE to daftar_app under A's scope — the barrier is gone, and the HTTP refusal below is a controller filter and not isolation`,
    ).toBe(0);
  }
  const before = await snapshot();
  const res = await o.attempt();
  const after = await snapshot();
  // (c) THE REFUSAL, CLASSIFIED.
  const verdict = expectTenantRefusal(res, o.what);
  expect(codeOf(res), `${o.what}: the refusal's own domain code is not the one this surface owes`).toMatch(o.code);
  // HALF TWO — no effect in B, from the relations themselves.
  expectNoEffectInB(before, after, o.what);
  expectNothingOfBReturned(res, o.what);
  return { verdict, status: res.status, code: codeOf(res) };
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  t = await createTestApp();
  app = new Pool({ connectionString: appDbUrl, max: 4 });
  day = String((await ownerPool().query<{ d: string }>(`SELECT current_date::text AS d`)).rows[0]?.d ?? '');
  const scoped = await tablesWithColumn(ownerPool(), 'business_id');
  EFFECT_TABLES = [...new Set([...scoped, ...JOURNAL_AND_LOGS])].sort();

  const register = async (name: string): Promise<Actor> => {
    const reg = await t.request.post('/v1/auth/register').send({ email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: name, preferredLocale: 'en' });
    expect(reg.status).toBe(201);
    const token = reg.body.accessToken as string;
    const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${token}`);
    return { token, userId: me.body.userId as string };
  };

  /**
   * One shop, built END TO END THROUGH ITS OWN PRODUCT COMMANDS: a product, a
   * configuration, stock, a customer, two credit sales, a payment method and
   * one payment that settles the first invoice in full and OVERPAYS — so the
   * command itself creates a customer credit, and the credit application has
   * a real subject.
   *
   * Nothing here is hand-inserted. A hand-seeded payment could not be
   * inserted anyway (`payment_guard()` refuses any INSERT whose
   * `business_transaction_id` is not the command's), and a hand-seeded
   * CONFIRMED sale would plant exactly the half-built commercial fact the
   * atomic sale law forbids.
   */
  const furnish = async (actor: Actor, businessId: string, label: string): Promise<Shop> => {
    const row = (
      await ownerPool().query<{ tenant_id: string; branch_id: string; warehouse_id: string }>(
        `SELECT b.tenant_id,
                (SELECT br.id FROM branches br WHERE br.business_id = b.id ORDER BY br.is_default DESC, br.id LIMIT 1) AS branch_id,
                (SELECT w.id FROM warehouses w WHERE w.business_id = b.id ORDER BY w.id LIMIT 1) AS warehouse_id
           FROM businesses b WHERE b.id = $1`,
        [businessId],
      )
    ).rows[0];
    const product = await t.request
      .post('/v1/catalog/products')
      .set(hdr(actor, businessId))
      .send({ translations: { en: `Case C product of ${label}` }, basePriceMinor: '1000' });
    expect(product.status, `the product of ${label} was refused: ${JSON.stringify(product.body)}`).toBe(201);
    const shop: Shop = {
      tenantId: row?.tenant_id ?? '',
      businessId,
      branchId: row?.branch_id ?? '',
      warehouseId: row?.warehouse_id ?? '',
      productId: product.body.id as string,
      userId: actor.userId,
      customerId: '',
      paymentMethodId: '',
      paidInvoiceId: '',
      openInvoiceId: '',
      paymentId: '',
      creditId: '',
      saleId: '',
    };
    const h = hdr(actor, businessId);

    const configured = await t.request.put(`/v1/inventory/products/${shop.productId}/configuration`).set(h).send({ trackInventory: true, unitCode: 'piece' });
    expect(configured.status, `the configuration of ${label} was refused: ${JSON.stringify(configured.body)}`).toBe(200);
    const stocked = await t.request
      .post('/v1/inventory/adjustments')
      .set(h)
      .send({
        adjustmentId: randomUUID(),
        warehouseId: shop.warehouseId,
        occurredOn: day,
        reason: 'the §16 CASE C fixture',
        lines: [{ productId: shop.productId, quantity: '40', unitCost: '5' }],
      });
    expect(stocked.status, `the stock of ${label} was refused: ${JSON.stringify(stocked.body)}`).toBe(201);

    /**
     * The customer, through the OWNER connection and not a command: this
     * slice mounts no customer WRITE route at all (`customers.controller.ts`
     * holds five `@Get`s and nothing else), which is itself reported as a
     * finding of this exercise rather than worked around silently.
     */
    const customerId = randomUUID();
    await ownerPool().query(
      `INSERT INTO customers (tenant_id, business_id, id, name, phone, status, revision,
                              create_intent_sha256, last_intent_sha256, business_transaction_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, '+970000000', 'active', 1, $5, $5, $6, $7, $7)`,
      [shop.tenantId, businessId, customerId, `Customer of ${label}`, 'a'.repeat(64), randomUUID(), actor.userId],
    );
    shop.customerId = customerId;

    const openInvoices = async (): Promise<readonly { invoiceId: string; outstandingTxnMinor: string }[]> => {
      const page = await t.request.get(`/v1/customers/${customerId}/open-invoices?asOf=${day}`).set(h);
      expect(page.status, `the open invoices of ${label} could not be read: ${JSON.stringify(page.body)}`).toBe(200);
      return page.body.items as { invoiceId: string; outstandingTxnMinor: string }[];
    };
    const creditSale = async (known: readonly string[]): Promise<{ saleId: string; invoiceId: string }> => {
      const saleId = randomUUID();
      const committed = await confirmSale(t, h, {
        saleId,
        customerId,
        warehouseId: shop.warehouseId,
        occurredOn: day,
        lines: [{ productId: shop.productId, quantity: '1' }],
      });
      expect(committed.status, `the credit sale of ${label} was refused: ${JSON.stringify(committed.body)}`).toBe(200);
      const fresh = (await openInvoices()).filter((i) => !known.includes(i.invoiceId));
      expect(fresh.length, `the credit sale of ${label} raised no new open invoice`).toBe(1);
      return { saleId, invoiceId: String((fresh[0] as { invoiceId: string }).invoiceId) };
    };

    const first = await creditSale([]);
    const second = await creditSale([first.invoiceId]);
    shop.saleId = second.saleId;
    shop.paidInvoiceId = first.invoiceId;
    shop.openInvoiceId = second.invoiceId;

    /**
     * The settlement posting account, ASKED OF THE DATABASE rather than
     * typed, and asked UNDER THE SHOP'S OWN GUCs because
     * `accounting_settlement_account_eligibility` raises
     * `accounting.scope_mismatch` outside them. The owner pool is used so no
     * row policy can hide an account from the fixture.
     */
    const account = await (async (): Promise<string> => {
      const c = await ownerPool().connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [shop.tenantId, businessId]);
        const r = await c.query<{ id: string }>(
          `SELECT a.id FROM accounts a
            WHERE a.business_id = $1 AND accounting_settlement_account_eligibility(a.business_id, a.id) = 'eligible'
            ORDER BY a.code LIMIT 1`,
          [businessId],
        );
        await c.query('ROLLBACK');
        expect(r.rows[0]?.id, `${label} holds no eligible settlement account, so no payment method could be made`).toBeDefined();
        return String(r.rows[0]?.id);
      } finally {
        c.release();
      }
    })();
    const paymentMethodId = randomUUID();
    const method = await t.request
      .post('/v1/payment-methods')
      .set(h)
      .send({
        paymentMethodId,
        systemType: 'cash',
        postingAccountId: account,
        requiresReference: false,
        sortOrder: 10,
        names: { en: `Case C drawer of ${label}`, ar: 'الصندوق' },
      });
    expect(method.status, `the payment method of ${label} was refused: ${JSON.stringify(method.body)}`).toBe(201);
    shop.paymentMethodId = paymentMethodId;

    const owed = await openInvoices();
    const due = BigInt(String(owed.find((i) => i.invoiceId === first.invoiceId)?.outstandingTxnMinor ?? '0'));
    const surplus = BigInt(String(owed.find((i) => i.invoiceId === second.invoiceId)?.outstandingTxnMinor ?? '0'));
    expect(due > 0n && surplus > 0n, `the two credit sales of ${label} owe nothing, so the ALLOW payment would overpay nothing`).toBe(true);
    /**
     * THE POSITIVE CONTROL, taken for real: the payment overpays by the
     * SECOND invoice's worth, so it settles the first in full AND creates a
     * customer credit. Every DENY below is this exact shape with one id
     * changed, which is what makes a refusal isolation rather than
     * exhaustion.
     */
    const paymentId = randomUUID();
    const collected = await t.request
      .post('/v1/customer-payments')
      .set(h)
      .send({
        paymentId,
        customerId,
        paymentMethodId,
        paymentDate: day,
        currencyCode: 'ILS',
        amountMinor: (due + surplus).toString(10),
        reference: null,
        creditId: randomUUID(),
        allocations: [
          { allocationId: randomUUID(), invoiceId: first.invoiceId, paymentAmountMinor: due.toString(10), invoiceAmountAppliedMinor: due.toString(10) },
        ],
      });
    expect(collected.status, `the ALLOW payment of ${label} was refused: ${JSON.stringify(collected.body)}`).toBe(201);
    const credit = collected.body.credit as { creditId: string } | null;
    expect(credit, `the ALLOW payment of ${label} created no credit, so the credit-application cases would have no subject`).not.toBeNull();
    shop.paymentId = paymentId;
    shop.creditId = String((credit as { creditId: string }).creditId);
    return shop;
  };

  merchantA = await register('Merchant of Tenant A');
  merchantB = await register('Merchant of Tenant B');
  const a = await t.request
    .post('/v1/onboarding/complete')
    .set('Idempotency-Key', `casec-${randomUUID()}`)
    .set('Authorization', `Bearer ${merchantA.token}`)
    .send({ ...onboarding, businessName: 'Case C A', storeSlug: `casec-a-${randomUUID().slice(0, 8)}` });
  expect(a.status).toBe(201);
  const b = await t.request
    .post('/v1/onboarding/complete')
    .set('Idempotency-Key', `casec-${randomUUID()}`)
    .set('Authorization', `Bearer ${merchantB.token}`)
    .send({ ...onboarding, businessName: 'Case C B', storeSlug: `casec-b-${randomUUID().slice(0, 8)}` });
  expect(b.status).toBe(201);

  A = await furnish(merchantA, a.body.businessId as string, 'A');
  B = await furnish(merchantB, b.body.businessId as string, 'B');
  // The two really are different TENANTS, not two businesses of one: CASE C is
  // the cross-TENANT cell, and A2 (same tenant) belongs to the cases this file
  // does not own.
  expect(B.tenantId, 'A and B are in the same tenant, so nothing below is a CROSS-TENANT attempt at all').not.toBe(A.tenantId);
}, 600_000);

afterAll(async () => {
  await app?.end();
  await t?.close();
});

describe('§16 CASE C — the subject, and the authority the attacker really holds', () => {
  it('the subject exists: both tenants hold a complete Phase 4 estate their OWN commands built', async () => {
    requireSubject((await saleSubject(ownerPool())).missing, CLAIM);
    for (const [label, shop] of [
      ['A', A],
      ['B', B],
    ] as const) {
      for (const [field, relation] of [
        ['customerId', 'customers'],
        ['paidInvoiceId', 'invoices'],
        ['openInvoiceId', 'invoices'],
        ['saleId', 'sales'],
        ['paymentId', 'payments'],
        ['creditId', 'customer_credits'],
      ] as const) {
        const id = shop[field];
        expect(id, `${label}.${field} was never built`).toMatch(/^[0-9a-f-]{36}$/);
        expect(await existsForOwner(relation, shop.businessId, id), `${label}.${field} is not a row of ${relation}`).toBe(1);
      }
    }
    // The relation set the NO-EFFECT law digests is not empty and really does
    // hold the relations every clause names, so the law's silence is evidence.
    expect(EFFECT_TABLES.length, 'the no-effect law digests no relation at all').toBeGreaterThan(20);
    for (const { clause, relations } of CLAUSES)
      for (const r of relations) expect(EFFECT_TABLES, `the «${clause}» clause names ${r}, which the digest does not cover`).toContain(r);
  });

  it('the attacker is an ORDINARY runtime credential: a real merchant of A, holding the Phase 4 permissions, and no internal principal', async () => {
    // §10's subject. The actor's own business works for it, through the very
    // commands the DENY cases use — so every refusal below is about WHOSE row
    // it is and never about what this credential may do.
    const own = await t.request.get(`/v1/customers/${A.customerId}/open-invoices?asOf=${day}`).set(hdr(merchantA, A.businessId));
    expect(own.status, `A's own merchant cannot read A's own receivables, so no DENY below is about tenancy: ${JSON.stringify(own.body)}`).toBe(200);
    const read = await t.request.get(`/v1/customer-payments/${A.paymentId}`).set(hdr(merchantA, A.businessId));
    expect(read.status, 'A cannot read its own payment').toBe(200);
    // And the credential it runs as is the ordinary application role, which
    // holds neither SUPERUSER nor BYPASSRLS: the authority §10 asks about.
    const who = await asApp<{ u: string; su: boolean; bypass: boolean }>(
      A,
      `SELECT current_user::text AS u, r.rolsuper AS su, r.rolbypassrls AS bypass FROM pg_roles r WHERE r.rolname = current_user`,
    );
    expect(who[0]?.u, 'the runtime connection is not the ordinary application role').toBe('daftar_app');
    expect(who[0]?.su, 'the runtime role is SUPERUSER, so no policy below is being tested at all').toBe(false);
    expect(who[0]?.bypass, 'the runtime role holds BYPASSRLS, so no policy below is being tested at all').toBe(false);
  });
});

describe('§16 CASE C — the eight Phase 4 command surfaces, each REFUSED with no effect in B', () => {
  it('SALE — POST /v1/sales under A’s own header, naming B’s customer, warehouse and product', async () => {
    const got = await caseC({
      what: 'the sale command over B’s customer, warehouse and product',
      subject: { relation: 'customers', id: B.customerId },
      /**
       * MEASURED, AND WORTH RECORDING: the composite form is refused by
       * `inventory.warehouse_not_found` — the FIRST of the three cross-tenant
       * ids the command resolves, which is the warehouse and not the
       * customer. So a DENY that changes ALL the ids together proves only
       * that the FIRST of them was bound; the remaining two are never
       * reached. That is exactly why the SURGICAL case below exists, and why
       * a composite DENY on its own is a weaker law than it looks.
       */
      code: /^inventory\.warehouse_not_found$/,
      attempt: () =>
        confirmSale(t, hdr(merchantA, A.businessId), {
          saleId: randomUUID(),
          customerId: B.customerId,
          warehouseId: B.warehouseId,
          occurredOn: day,
          lines: [{ productId: B.productId, quantity: '1' }],
        }),
    });
    expect(REFUSALS, `the sale command's verdict was ${got.verdict}`).toContain(got.verdict);
  });

  it('SALE, SURGICAL — A’s own warehouse and A’s own product, and ONLY the customer is B’s', async () => {
    // The sharper form, and the one a composite DENY cannot make: everything
    // the command needs is A's own and in stock, so no leg of it can be
    // refused for the stock, the warehouse or the product. Exactly ONE field
    // crosses the tenant boundary, which is the only thing left that can
    // refuse it.
    const got = await caseC({
      what: 'the sale command over A’s own stock with ONLY B’s customer substituted',
      subject: { relation: 'customers', id: B.customerId },
      // The SELLING authority refuses it, by the customer: the one field that
      // crossed the boundary is the one the refusal names.
      code: /^sale\.customer_not_found$/,
      attempt: () =>
        confirmSale(t, hdr(merchantA, A.businessId), {
          saleId: randomUUID(),
          customerId: B.customerId,
          warehouseId: A.warehouseId,
          occurredOn: day,
          lines: [{ productId: A.productId, quantity: '1' }],
        }),
    });
    expect(REFUSALS).toContain(got.verdict);
  });

  it('INVOICE — GET /v1/invoices/:invoiceId over B’s invoice', async () => {
    const got = await caseC({
      what: 'the invoice read over B’s invoice',
      subject: { relation: 'invoices', id: B.openInvoiceId },
      code: /^invoice\.not_found$/,
      attempt: () => t.request.get(`/v1/invoices/${B.openInvoiceId}`).set(hdr(merchantA, A.businessId)),
    });
    expect(got.verdict, 'the invoice read refused for some reason other than the row being invisible').toBe('tenant_barrier');
  });

  it('SETTLEMENT — GET /v1/invoices/:invoiceId/settlement over B’s OPEN invoice', async () => {
    // The settlement READ is the one route that would hand back what B's
    // invoice still owes and what has been applied to it: the figures a
    // competitor wants. It is also the route an `empty_collection` verdict is
    // a real hazard for — a settlement chain with no legs renders as an empty
    // list — which is why the classifier treats that as a FAILED PROOF.
    const got = await caseC({
      what: 'the settlement read over B’s open invoice',
      subject: { relation: 'invoices', id: B.openInvoiceId },
      code: /^invoice\.not_found$/,
      attempt: () => t.request.get(`/v1/invoices/${B.openInvoiceId}/settlement`).set(hdr(merchantA, A.businessId)),
    });
    expect(got.verdict, 'the settlement read refused for some reason other than the row being invisible').toBe('tenant_barrier');
  });

  it('CUSTOMER — the five customer reads over B’s customer, and not one of them is an empty collection', async () => {
    // A COLLECTION route is the case a status-set assertion cannot judge:
    // `GET …/open-invoices` answers `200 {items: []}` for a customer with
    // nothing open, and that answer is indistinguishable from a refusal. So
    // every one of the five is classified, and `empty_collection` is a
    // failure here by construction.
    const routes: readonly { readonly path: string; readonly code: RegExp }[] = [
      { path: `/v1/customers/${B.customerId}`, code: /^customer\.not_found$/ },
      { path: `/v1/customers/${B.customerId}/receivable`, code: /^customer\.not_found$/ },
      { path: `/v1/customers/${B.customerId}/receivable/aging?asOf=${day}&bucketDays=30,60,90`, code: /^customer\.not_found$/ },
      { path: `/v1/customers/${B.customerId}/open-invoices?asOf=${day}`, code: /^customer\.not_found$/ },
      /**
       * MEASURED: this one answers `customer_credit.not_found` and not
       * `customer.not_found` — the credits read refuses under the
       * RECEIVABLES vocabulary while its four siblings refuse under the
       * SELLING one. The code is pinned per route rather than per surface
       * because that difference is real, and a loose `/not_found/` would have
       * hidden it.
       *
       * AND THIS IS THE ROUTE THE WHOLE `empty_collection` VERDICT EXISTS
       * FOR: it is the only one of the five that renders a LIST, so it is the
       * only one that could have answered `200 []` — the answer a
       * status-set assertion cannot tell from a refusal. It does not.
       */
      { path: `/v1/customers/${B.customerId}/credits`, code: /^customer_credit\.not_found$/ },
    ];
    for (const { path, code } of routes) {
      const got = await caseC({
        what: `the customer read ${path.split('?')[0] ?? path} over B’s customer`,
        subject: { relation: 'customers', id: B.customerId },
        code,
        attempt: () => t.request.get(path).set(hdr(merchantA, A.businessId)),
      });
      expect(got.verdict, `${path} refused for some reason other than the row being invisible`).toBe('tenant_barrier');
    }
  });

  it('PAYMENT — POST /v1/customer-payments naming B’s customer, B’s invoice and B’s payment method', async () => {
    const owed = await bOutstanding(B.openInvoiceId);
    const got = await caseC({
      what: 'the collect command over B’s customer, invoice and method',
      subject: { relation: 'payments', id: B.paymentId },
      code: /^customer_payment\.not_found$/,
      attempt: () =>
        t.request
          .post('/v1/customer-payments')
          .set(hdr(merchantA, A.businessId))
          .send({
            paymentId: randomUUID(),
            customerId: B.customerId,
            paymentMethodId: B.paymentMethodId,
            paymentDate: day,
            currencyCode: 'ILS',
            amountMinor: owed.toString(10),
            reference: null,
            creditId: null,
            allocations: [
              { allocationId: randomUUID(), invoiceId: B.openInvoiceId, paymentAmountMinor: owed.toString(10), invoiceAmountAppliedMinor: owed.toString(10) },
            ],
          }),
    });
    expect(REFUSALS).toContain(got.verdict);
  });

  it('PAYMENT ALLOCATION, SURGICAL — A’s own customer, A’s own method, and ONLY the allocation’s invoice is B’s', async () => {
    // THE ATTACK THIS FILE EXISTS FOR. The payment is wholly A's: A's
    // customer, A's payment method, A's money, A's currency, an amount that
    // is exactly what B's invoice still owes. Only the allocation LEG names
    // another tenant's invoice. A command that validated the payment header
    // against the business and then trusted the allocation list would settle
    // a competitor's receivable with this merchant's cash, and every existing
    // cross-tenant case would stay green, because every one of them changes
    // ALL the ids together.
    const owed = await bOutstanding(B.openInvoiceId);
    const got = await caseC({
      what: 'the collect command whose ONLY cross-tenant field is allocations[0].invoiceId',
      subject: { relation: 'invoices', id: B.openInvoiceId },
      // NOT `allocations_invalid` (400) and NOT `amount_exceeds_outstanding`
      // (409): both would be STRUCTURAL verdicts, refused by the list
      // validator or by arithmetic before the binding was consulted. The
      // refusal this surface owes is that the invoice is not there to settle.
      code: /^customer_payment\.not_found$/,
      attempt: () =>
        t.request
          .post('/v1/customer-payments')
          .set(hdr(merchantA, A.businessId))
          .send({
            paymentId: randomUUID(),
            customerId: A.customerId,
            paymentMethodId: A.paymentMethodId,
            paymentDate: day,
            currencyCode: 'ILS',
            amountMinor: owed.toString(10),
            reference: null,
            creditId: null,
            allocations: [
              { allocationId: randomUUID(), invoiceId: B.openInvoiceId, paymentAmountMinor: owed.toString(10), invoiceAmountAppliedMinor: owed.toString(10) },
            ],
          }),
    });
    expect(REFUSALS).toContain(got.verdict);
  });

  it('CUSTOMER CREDIT — POST /v1/customer-credits/:creditId/applications over B’s credit, customer and invoice', async () => {
    const owed = await bOutstanding(B.openInvoiceId);
    const amount = minOf(owed, await bCreditRemaining());
    const got = await caseC({
      what: 'the apply-credit command over B’s credit, customer and invoice',
      subject: { relation: 'customer_credits', id: B.creditId },
      code: /^customer_credit(_application)?\.not_found$/,
      attempt: () =>
        t.request
          .post(`/v1/customer-credits/${B.creditId}/applications`)
          .set(hdr(merchantA, A.businessId))
          .send({
            applicationId: randomUUID(),
            customerId: B.customerId,
            invoiceId: B.openInvoiceId,
            applicationDate: day,
            creditAmountConsumedMinor: amount.toString(10),
            invoiceAmountAppliedMinor: amount.toString(10),
          }),
    });
    expect(REFUSALS).toContain(got.verdict);
  });

  it('CREDIT APPLICATION, SURGICAL — A’s OWN credit and A’s own customer, and ONLY the invoice is B’s', async () => {
    // The mirror of the allocation attack, and the one that would move
    // another tenant's receivable with this tenant's credit: the credit in the
    // path is A's own and has a real remaining balance, the customer is A's
    // own, and only the invoice the credit is applied TO belongs to B.
    const owed = await bOutstanding(B.openInvoiceId);
    const mine = await aCreditRemaining();
    const amount = minOf(owed, mine);
    expect(amount > 0n, 'A’s own credit is exhausted, so this attempt would be refused for the credit and not for the tenancy').toBe(true);
    const got = await caseC({
      what: 'the apply-credit command whose ONLY cross-tenant field is invoiceId',
      subject: { relation: 'invoices', id: B.openInvoiceId },
      code: /^customer_credit_application\.not_found$/,
      attempt: () =>
        t.request
          .post(`/v1/customer-credits/${A.creditId}/applications`)
          .set(hdr(merchantA, A.businessId))
          .send({
            applicationId: randomUUID(),
            customerId: A.customerId,
            invoiceId: B.openInvoiceId,
            applicationDate: day,
            creditAmountConsumedMinor: amount.toString(10),
            invoiceAmountAppliedMinor: amount.toString(10),
          }),
    });
    expect(REFUSALS).toContain(got.verdict);
  });

  it('PAYMENT READ — GET /v1/customer-payments/:paymentId over B’s payment', async () => {
    const got = await caseC({
      what: 'the payment read over B’s payment',
      subject: { relation: 'payments', id: B.paymentId },
      code: /^customer_payment\.not_found$/,
      attempt: () => t.request.get(`/v1/customer-payments/${B.paymentId}`).set(hdr(merchantA, A.businessId)),
    });
    expect(got.verdict, 'the payment read refused for some reason other than the row being invisible').toBe('tenant_barrier');
  });

  it('SALE READ — GET /v1/sales/:saleId over B’s sale', async () => {
    const got = await caseC({
      what: 'the sale read over B’s sale',
      subject: { relation: 'sales', id: B.saleId },
      code: /^sale\.not_found$/,
      attempt: () => t.request.get(`/v1/sales/${B.saleId}`).set(hdr(merchantA, A.businessId)),
    });
    expect(got.verdict, 'the sale read refused for some reason other than the row being invisible').toBe('tenant_barrier');
  });
});

/**
 * One NEW open invoice of B's, raised by B's OWN merchant through B's own
 * credit-sale command. Needed because a red proof above deliberately settles
 * the fixture's invoice, and a probe over an invoice that owes nothing is
 * refused by arithmetic rather than by the barrier.
 */
async function freshOpenInvoiceOfB(): Promise<string> {
  const known = (await ownerPool().query<{ id: string }>(`SELECT id FROM invoices WHERE business_id = $1`, [B.businessId])).rows.map((r) => r.id);
  const committed = await confirmSale(t, hdr(merchantB, B.businessId), {
    saleId: randomUUID(),
    customerId: B.customerId,
    warehouseId: B.warehouseId,
    occurredOn: day,
    lines: [{ productId: B.productId, quantity: '1' }],
  });
  expect(committed.status, `B’s own credit sale was refused, so no fresh open invoice could be raised: ${JSON.stringify(committed.body)}`).toBe(200);
  const fresh = (await ownerPool().query<{ id: string }>(`SELECT id FROM invoices WHERE business_id = $1`, [B.businessId])).rows
    .map((r) => r.id)
    .filter((id) => !known.includes(id));
  expect(fresh.length, 'B’s credit sale raised no new invoice').toBe(1);
  return String(fresh[0]);
}

/** What B's invoice still owes, read on the OWNER connection: the attempt must be for a REAL amount or it is refused by arithmetic. */
async function bOutstanding(invoiceId: string): Promise<bigint> {
  const r = await ownerPool().query<{ owed: string }>(
    `SELECT (i.total_txn_minor
             - coalesce((SELECT sum(pa.invoice_amount_applied_minor) FROM payment_allocations pa
                          WHERE pa.business_id = i.business_id AND pa.invoice_id = i.id), 0)
             - coalesce((SELECT sum(ca.invoice_amount_applied_minor) FROM customer_credit_applications ca
                          WHERE ca.business_id = i.business_id AND ca.invoice_id = i.id), 0))::text AS owed
       FROM invoices i WHERE i.business_id = $1 AND i.id = $2`,
    [B.businessId, invoiceId],
  );
  const owed = BigInt(String(r.rows[0]?.owed ?? '0'));
  expect(owed > 0n, `B’s invoice ${invoiceId} owes nothing, so a cross-tenant settlement attempt would be refused by arithmetic`).toBe(true);
  return owed;
}

const remaining = async (shop: Shop): Promise<bigint> => {
  const r = await ownerPool().query<{ r: string }>(`SELECT remaining_amount_minor::text AS r FROM customer_credits WHERE business_id = $1 AND id = $2`, [
    shop.businessId,
    shop.creditId,
  ]);
  return BigInt(String(r.rows[0]?.r ?? '0'));
};
const bCreditRemaining = (): Promise<bigint> => remaining(B);
const aCreditRemaining = (): Promise<bigint> => remaining(A);
const minOf = (x: bigint, y: bigint): bigint => (x < y ? x : y);

describe('§16 CASE C — THE RED PROOFS: each law is shown to be able to fail, against a real subject', () => {
  it('RP-1 the no-effect law SEES a real inserting effect: B’s own lawful credit sale moves five relations', async () => {
    // The subject is REAL and LAWFUL: B's own merchant, in B's own business,
    // committing the same credit sale the fixture already committed twice. If
    // the digest law could not see this, every "no effect in B" assertion
    // above would be vacuous.
    const before = await snapshot();
    const committed = await confirmSale(t, hdr(merchantB, B.businessId), {
      saleId: randomUUID(),
      customerId: B.customerId,
      warehouseId: B.warehouseId,
      occurredOn: day,
      lines: [{ productId: B.productId, quantity: '1' }],
    });
    expect(committed.status, `B’s own sale was refused, so this red proof has no subject: ${JSON.stringify(committed.body)}`).toBe(200);
    const after = await snapshot();
    const changed = changedTables(before, after);
    for (const relation of ['sales', 'sale_items', 'invoices', 'invoice_items', 'journal_entries', 'journal_lines', 'stock_movements'])
      expect(changed, `the no-effect law did NOT see ${relation} move for a real sale, so its silence above is not evidence`).toContain(relation);
    // …and the law itself, run over this pair, FAILS — with EVERY clause named.
    const problems = noEffectProblems(before, after).join(' | ');
    for (const clause of ['no financial row', 'no journal entry', 'no stock movement'])
      expect(problems, `the «${clause}» clause did not fire for a real sale, so its silence above is not evidence`).toContain(clause);
    expect(() => expectNoEffectInB(before, after, 'RP-1')).toThrow(/not byte-identical/);
  });

  it('RP-2 the no-effect law sees a MUTATION IN PLACE that a row COUNT cannot: B’s own credit application', async () => {
    // THE CLAUSE A COUNT-BASED LAW CANNOT HOLD. Applying a credit lowers
    // `customer_credits.remaining_amount_minor` and inserts no
    // `customer_credits` row. Every existing cross-tenant case reads
    // `count(*)` (`01-cross-tenant.golden.test.ts:1577`, `:712`), so this effect is
    // invisible to all of them.
    const was = await bCreditRemaining();
    expect(was > 0n, 'B’s credit is exhausted, so this red proof has no subject').toBe(true);
    const owed = await bOutstanding(B.openInvoiceId);
    const amount = minOf(owed, was);
    const before = await snapshot();
    const applied = await t.request
      .post(`/v1/customer-credits/${B.creditId}/applications`)
      .set(hdr(merchantB, B.businessId))
      .send({
        applicationId: randomUUID(),
        customerId: B.customerId,
        invoiceId: B.openInvoiceId,
        applicationDate: day,
        creditAmountConsumedMinor: amount.toString(10),
        invoiceAmountAppliedMinor: amount.toString(10),
      });
    expect(applied.status, `B’s own credit application was refused, so this red proof has no subject: ${JSON.stringify(applied.body)}`).toBe(201);
    const after = await snapshot();

    // THE COUNT IS BLIND…
    expect(rowCounts(after).customer_credits, 'customer_credits gained or lost a row, so this case is no longer about a mutation IN PLACE').toBe(
      rowCounts(before).customer_credits,
    );
    // …AND THE DIGEST IS NOT.
    expect(
      changedTables(before, after),
      'the digest did not see the credit’s remaining balance change, so the «no customer-credit mutation» clause is vacuous',
    ).toContain('customer_credits');
    expect(await bCreditRemaining(), 'the credit’s remaining balance did not move at all').not.toBe(was);
    // The CLAUSE is named, and named ALONGSIDE the others this lawful
    // application also moved: a credit application posts a journal entry too,
    // so a law that reported only the first failing clause would have hidden
    // this one. `noEffectProblems` returns them all.
    const problems = noEffectProblems(before, after);
    expect(problems.join(' | '), 'the «no customer-credit mutation» clause did not fire for a real in-place mutation').toMatch(/no customer-credit mutation/);
    expect(problems.join(' | '), 'the «no settlement mutation» clause did not fire for a real application row').toMatch(/no settlement mutation/);
    expect(() => expectNoEffectInB(before, after, 'RP-2')).toThrow(/not byte-identical/);
  });

  it('RP-3 the INVISIBILITY leg can fail: the read barrier widened to USING (true) makes B’s rows visible under A’s scope, and the law catches it', async () => {
    // THE PERMISSIVE VARIANT, PLANTED AGAINST REAL ROWS, in a transaction
    // that is ROLLED BACK. `ALTER POLICY` is transactional, so nothing here
    // survives its own case; the plant and the read must share one connection
    // because an uncommitted policy change is invisible to a second session.
    const client = await ownerPool().connect();
    try {
      await client.query('BEGIN');
      // Baseline, on this very connection: the barrier HOLDS.
      await client.query('SET LOCAL ROLE daftar_app');
      await client.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [A.tenantId, A.businessId]);
      const held = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM invoices WHERE id = $1`, [B.openInvoiceId]);
      expect(Number(held.rows[0]?.n), 'B’s invoice is already visible under A’s scope before anything was planted').toBe(0);
      await client.query('RESET ROLE');

      // THE PLANT: widen the restrictive read barrier, and the permissive
      // tenant policy with it, on every relation this file names.
      for (const relation of BARRIER_RELATIONS) {
        await client.query(`ALTER POLICY business_isolation_read ON public.${relation} USING (true)`);
        await client.query(`ALTER POLICY tenant_membership ON public.${relation} USING (true)`);
      }
      await client.query('SET LOCAL ROLE daftar_app');
      await client.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [A.tenantId, A.businessId]);
      const leaked = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM invoices WHERE id = $1`, [B.openInvoiceId]);
      expect(
        Number(leaked.rows[0]?.n),
        'the widened barrier did NOT leak B’s invoice, so the invisibility leg of every case above cannot fail and proves nothing',
      ).toBe(1);
      // Every relation the law covers leaks, not just the one.
      for (const relation of BARRIER_RELATIONS) {
        const r = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM public.${relation} WHERE business_id = $1`, [B.businessId]);
        expect(Number(r.rows[0]?.n), `the widened barrier did not leak ${relation}`).toBeGreaterThan(0);
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    // AND THE PLANT IS GONE: the barrier holds again, on a fresh connection.
    expect(await visibleUnder(A, 'invoices', B.openInvoiceId), 'the planted policy survived its own case').toBe(0);
  });

  it('RP-4 the classifier refuses a STRUCTURAL refusal as a tenancy proof', async () => {
    // A REAL request, with a required field removed: the collect command
    // without `allocations`. This is the refusal §15 warns about by name —
    // the golden's own comment at `:1775-1789` records a whole case being
    // satisfied by it — and the classifier must call it what it is.
    const malformed = await t.request
      .post('/v1/customer-payments')
      .set(hdr(merchantA, A.businessId))
      .send({ paymentId: randomUUID(), customerId: A.customerId, paymentMethodId: A.paymentMethodId, paymentDate: day, currencyCode: 'ILS' });
    expect(malformed.status, `a request missing its required fields was not refused at all: ${JSON.stringify(malformed.body)}`).toBeGreaterThanOrEqual(400);
    expect(classify(malformed), `a request missing its required fields classified as something other than structural (${malformed.status})`).toBe('structural');
    expect(() => expectTenantRefusal(malformed, 'RP-4')).toThrow(/STRUCTURAL validator/);
    // And the same shape WITH the field present is not structural, so the
    // verdict is about the missing field and not about this route.
    //
    // A FRESH open invoice of B's, because RP-2 above deliberately consumed
    // the fixture's: a well-formed probe over an invoice that owes nothing
    // would be refused by ARITHMETIC, which is itself a structural verdict,
    // and the comparison would then prove nothing.
    const target = await freshOpenInvoiceOfB();
    const owed = await bOutstanding(target);
    const wellFormed = await t.request
      .post('/v1/customer-payments')
      .set(hdr(merchantA, A.businessId))
      .send({
        paymentId: randomUUID(),
        customerId: B.customerId,
        paymentMethodId: B.paymentMethodId,
        paymentDate: day,
        currencyCode: 'ILS',
        amountMinor: owed.toString(10),
        reference: null,
        creditId: null,
        allocations: [{ allocationId: randomUUID(), invoiceId: target, paymentAmountMinor: owed.toString(10), invoiceAmountAppliedMinor: owed.toString(10) }],
      });
    expect(classify(wellFormed), 'the well-formed cross-tenant collect was ALSO refused structurally, so the DENY cases above prove nothing').not.toBe(
      'structural',
    );
    expect(classify(wellFormed), 'the well-formed cross-tenant collect was not refused by the barrier').toBe('tenant_barrier');
  });

  it('RP-5 the classifier refuses an EMPTY COLLECTION as a refusal', async () => {
    // A REAL route answering for a REAL customer of A's OWN business that
    // holds no credit: `200 []`. A status-set assertion
    // (`expect([403,404,409,422]).toContain(res.status)`) cannot see this at
    // all, and a law that accepted it would pass with the barrier gone.
    const fresh = randomUUID();
    await ownerPool().query(
      `INSERT INTO customers (tenant_id, business_id, id, name, phone, status, revision,
                              create_intent_sha256, last_intent_sha256, business_transaction_id, created_by, updated_by)
       VALUES ($1, $2, $3, 'Holds nothing', '+970000001', 'active', 1, $4, $4, $5, $6, $6)`,
      [A.tenantId, A.businessId, fresh, 'b'.repeat(64), randomUUID(), merchantA.userId],
    );
    {
      const empty = await t.request.get(`/v1/customers/${fresh}/credits`).set(hdr(merchantA, A.businessId));
      expect(empty.status, `the credits read did not answer for A’s own customer: ${JSON.stringify(empty.body)}`).toBe(200);
      expect(empty.body, 'A’s brand-new customer already holds a credit, so this red proof has no subject').toEqual([]);
      expect(classify(empty), 'a 200 with an empty array was not classified as an empty collection').toBe('empty_collection');
      expect(() => expectTenantRefusal(empty, 'RP-5')).toThrow(/An empty collection is never a refusal/);
      // AND THE POINT: the wide status-set assertion the existing cases use
      // would not have been satisfied by this — it would have been satisfied
      // by nothing, because a 200 is not in the set — but a law written as
      // "the body holds none of B's rows" WOULD be, which is why
      // `empty_collection` is a verdict of its own and not a pass.
      expect([403, 404, 409, 422].includes(empty.status), 'a 200 is in the status set the existing cases accept').toBe(false);
    }
    // The customer is NOT removed afterwards, and cannot be: `customer_guard`
    // refuses a DELETE with `customer.not_deletable` — «a customer is
    // archived, never deleted» — which this red proof met for real. It is a
    // customer of A's OWN business, so it is outside every «no effect in B»
    // law above, and the suite resets its data in `beforeAll`.
  });

  it('RP-7 the per-case CODE PIN discriminates: two REAL refusals of two different authorities do not satisfy each other', async () => {
    // The pin is what stops a case being satisfied by any 404 at all. It is
    // shown to discriminate against REAL responses, never a fabricated one:
    // the sale read and the payment read both answer 404 `tenant_barrier`
    // over B's rows, and their domain codes belong to DIFFERENT authorities.
    const sale = await t.request.get(`/v1/sales/${B.saleId}`).set(hdr(merchantA, A.businessId));
    const payment = await t.request.get(`/v1/customer-payments/${B.paymentId}`).set(hdr(merchantA, A.businessId));
    expect(classify(sale), 'the sale read is no longer a barrier refusal, so this red proof has no subject').toBe('tenant_barrier');
    expect(classify(payment), 'the payment read is no longer a barrier refusal, so this red proof has no subject').toBe('tenant_barrier');
    expect(sale.status, 'the two refusals differ in status, so the pin is not the only thing telling them apart').toBe(payment.status);
    // SAME status, SAME verdict, DIFFERENT authority — which is precisely what
    // a status-set assertion cannot see and the pin can.
    expect(codeOf(sale)).toBe('sale.not_found');
    expect(codeOf(payment)).toBe('customer_payment.not_found');
    expect(codeOf(sale), 'the sale refusal satisfies the receivables pin, so the pin discriminates nothing').not.toMatch(/^customer_payment\.not_found$/);
    expect(codeOf(payment), 'the payment refusal satisfies the selling pin, so the pin discriminates nothing').not.toMatch(/^sale\.not_found$/);
    // …and the GENERIC envelope code really is the same for both, which is
    // why `codeOf` reads `details` and not `error.code`.
    const generic = (r: typeof sale): string => String((r.body as { error?: { code?: unknown } }).error?.code ?? '');
    expect(generic(sale), 'the two refusals no longer share a generic code, so reading error.code would have sufficed').toBe(generic(payment));
    expect(generic(sale)).toBe('NOT_FOUND');
  });

  it('RP-6 the response-leak law can fail: a body that really does carry B’s ids is caught', async () => {
    // The seventh clause, shown able to fail against a REAL id. The subject
    // is not a fictional response: it is B's own merchant reading B's own
    // payment, which legitimately renders B's ids — so the law is proved to
    // fire on a body that carries them, and its silence over every refusal
    // above is evidence.
    const own = await t.request.get(`/v1/customer-payments/${B.paymentId}`).set(hdr(merchantB, B.businessId));
    expect(own.status, 'B cannot read its own payment, so this red proof has no subject').toBe(200);
    expect(() => expectNothingOfBReturned(own, 'RP-6')).toThrow(/no inappropriate data returned/);
  });
});
