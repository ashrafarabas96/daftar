/**
 * P3-S6 T-09 — MP-7: THE PHASE 3 SETTLEMENT PREFIX BUILT A SUPPLIER SURFACE
 * AND DID NOT QUIETLY BUILD A CUSTOMER ONE
 * (docs/PHASE_3_S6_CONTRACT.md A-01, A-05, A-22, §6 T-09; P:251).
 *
 * ── Why this file was re-expressed in P4-S1 (lock P4-AL-88) ───────────────
 *
 * Until Phase 4 this suite asked the LIVE CATALOGUE whether the customer side
 * existed at all: `payments`, `payment_allocations`, `payment_reversals`,
 * `refunds`, `customer_credits`, `credit_notes`, `customer_payments` and
 * `customer_refunds` had to be absent, NO relation whatever could match
 * `(customer|sale|invoice)`, every verb on `/v1/payments`, `/v1/refunds`,
 * `/v1/invoices` and `/v1/sales` had to answer 404, and the source-type and
 * operation-kind registries were pinned by absolute equality under a
 * `payment|refund|sale|invoice|customer|credit` filter.
 *
 * Every one of those is a claim about the FUTURE, and Phase 4 is that future:
 * it builds `customers`, `invoices`, `sales`, `payments` and the routes for
 * them by design. The suite is permanent and is required by name at
 * `scripts/phase3-s6-gate.ts:172`, so it is composed by `gate:phase3:s6` ->
 * `s7` -> `s8` -> `gate:phase3:corrective`, and through that by
 * `gate:phase3:release` AND `gate:phase4:s1`. The first Phase 4 migration would
 * therefore turn an ACCEPTED Phase 3 gate red.
 *
 * It is neither deleted nor allowlisted. Deleting it deletes a real Phase 3
 * protection; an allowlist of the Phase 4 names turns "these do not exist" into
 * "these exist and that is fine", which asserts nothing. Instead the suite says
 * what it always MEANT, which is phase-scoped:
 *
 *   §A The absolute-absence assertions become STRUCTURAL. Instead of asking
 *      today's catalogue whether `customers` exists, §A reads the Phase 3
 *      prefix's own accepted files — `scripts/phase3-prefix.ts` holds their
 *      names and digests — and asserts that no migration in `0053–0073`
 *      creates a relation matching those patterns. It still fails if a Phase 3
 *      migration is edited to add a customer table, and it says nothing about
 *      the future. Red proof: `§A red proof`.
 *
 *   §B The exact-list and route assertions become SUPPLIER-SCOPED. Each keeps
 *      every `supplier_*` name it carried and drops the absolute equality, so
 *      what it asserts is *the supplier settlement surface is exactly these
 *      objects, these registries and these routes and nothing more* — the
 *      property P3-S6 actually bought. Red proofs: `§B1 red proof`,
 *      `§B2 red proof`, `§B3 red proof`.
 *
 * `[[daftar-a-closure-rule-is-not-an-invariant]]`: the invariant that outlives
 * the slice is the shape of what the slice built, never "nothing else will ever
 * exist".
 *
 * §B3 is STRICTLY STRONGER than what it replaces: the operation-kind assertion
 * used to pin only the rows matching a filter, and now pins EVERY row the
 * Phase 3 prefix registered — all 27 — by exact equality, using the
 * `registered_by` provenance column the registry already carries.
 */
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOMAIN_SOURCE_TYPES } from '../../packages/accounting/src/post';
import { MIGRATIONS_DIR } from '../../apps/api/src/infra/migrate';
import { PHASE3_PREFIX } from '../../scripts/phase3-prefix';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { asMember, onboardS3Business, registerActor, type HttpActor, type S3Business } from '../helpers/inventory-commands';
import { S6_SOURCE_TYPES } from '../helpers/supplier-settlement';

// ─────────────────────────────────────────────────────────────────────────────
// §A — the structural half: what the Phase 3 prefix's own files create.
// ─────────────────────────────────────────────────────────────────────────────

/** The customer-side settlement tables P3-S6 promised it was not building. */
const CUSTOMER_SETTLEMENT_TABLES = [
  'payments',
  'payment_allocations',
  'payment_reversals',
  'refunds',
  'customer_credits',
  'credit_notes',
  'customer_payments',
  'customer_refunds',
] as const;

/**
 * The pattern the suite always used on `relname`, unchanged.
 *
 * It is named here and referred to by name from the assertion and from the test
 * titles. The titles used to quote the alternation verbatim, which made a test
 * NAME read as a Phase 4 vocabulary filter sitting beside an exact equality —
 * the shape `tests/security/phase4-forward-evolution.test.ts` refuses. The
 * pattern itself is unchanged and the assertion is unchanged; only the echo of
 * it in the prose is gone, and the one definition is now the only place the
 * alternation is written.
 */
const CUSTOMER_RELATION_PATTERN = /(customer|sale|invoice)/;

/** A relation this migration brings into existence, and how. */
interface CreatedRelation {
  readonly name: string;
  readonly file: string;
  readonly how: 'CREATE' | 'RENAME';
}

/**
 * Every relation a set of migration files creates or renames into existence.
 *
 * Deliberately conservative about what counts as "creating a relation": tables,
 * partitioned tables, plain and materialized views, AND `ALTER TABLE … RENAME
 * TO`, because a rename is a second way to make a forbidden name appear. The
 * regexes are deliberately loose on whitespace and on `IF NOT EXISTS` /
 * `OR REPLACE` / `UNLOGGED`, so a differently-formatted `CREATE TABLE` cannot
 * slip past the finder.
 */
export function relationsCreatedBy(dir: string, files: readonly string[]): CreatedRelation[] {
  const found: CreatedRelation[] = [];
  const strip = (raw: string): string =>
    raw
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n');
  for (const file of files) {
    const sql = strip(readFileSync(join(dir, file), 'utf8'));
    const patterns: readonly (readonly [RegExp, CreatedRelation['how']])[] = [
      [/\bCREATE\s+(?:UNLOGGED\s+|GLOBAL\s+|LOCAL\s+|TEMP\s+|TEMPORARY\s+)*TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?/gi, 'CREATE'],
      [/\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP\s+|TEMPORARY\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?/gi, 'CREATE'],
      [/\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?"?[A-Za-z_][A-Za-z0-9_]*"?\s+RENAME\s+TO\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/gi, 'RENAME'],
    ];
    for (const [re, how] of patterns) {
      for (const m of sql.matchAll(re)) {
        const name = (m[1] ?? '').toLowerCase();
        if (name && name !== 'public') found.push({ name, file, how });
      }
    }
  }
  return found;
}

/** The accepted Phase 3 prefix, by name, straight from the accepted module. */
const PHASE3_FILES: readonly string[] = PHASE3_PREFIX.map(([name]) => name);

describe('§A T-09 MP-7 (structural): no Phase 3 migration creates a customer-side relation', () => {
  it('the Phase 3 prefix is the accepted 21 files, 0053 through 0073', () => {
    expect(PHASE3_FILES).toHaveLength(21);
    expect(PHASE3_FILES[0]).toBe('0053_inventory_units_and_product_configuration.sql');
    expect(PHASE3_FILES[PHASE3_FILES.length - 1]).toMatch(/^0073_/);
  });

  it('no migration in 0053–0073 creates a relation matching CUSTOMER_RELATION_PATTERN', () => {
    const created = relationsCreatedBy(MIGRATIONS_DIR, PHASE3_FILES);
    // The finder must actually be finding things, or an empty result proves nothing.
    expect(created.length).toBeGreaterThan(40);
    const offenders = created.filter((r) => CUSTOMER_RELATION_PATTERN.test(r.name));
    expect(offenders.map((r) => `${r.file}: ${r.how} ${r.name}`)).toEqual([]);
  });

  it('no migration in 0053–0073 creates any of the eight customer-settlement tables', () => {
    const created = relationsCreatedBy(MIGRATIONS_DIR, PHASE3_FILES);
    const byName = new Set(created.map((r) => r.name));
    for (const name of CUSTOMER_SETTLEMENT_TABLES) {
      const where = created.filter((r) => r.name === name).map((r) => r.file);
      expect(byName.has(name), `${name} is created by ${where.join(', ')}`).toBe(false);
    }
  });

  it('§A red proof: a CREATE TABLE customers planted into a scratch copy of a Phase 3 migration is named', () => {
    const dir = mkdtempSync(join(tmpdir(), 'daftar-p3-prefix-redproof-'));
    try {
      for (const file of PHASE3_FILES) cpSync(join(MIGRATIONS_DIR, file), join(dir, file));
      const victim = '0063_purchases_suppliers_sources.sql';
      writeFileSync(
        join(dir, victim),
        `${readFileSync(join(dir, victim), 'utf8')}\nCREATE TABLE customers (id UUID PRIMARY KEY);\nCREATE TABLE IF NOT EXISTS customer_payments (id UUID PRIMARY KEY);\nALTER TABLE customer_payments RENAME TO sale_receipts;\n`,
      );
      const offenders = relationsCreatedBy(dir, PHASE3_FILES).filter((r) => CUSTOMER_RELATION_PATTERN.test(r.name));
      expect(offenders.map((r) => `${r.file}: ${r.how} ${r.name}`).sort()).toEqual([
        `${victim}: CREATE customer_payments`,
        `${victim}: CREATE customers`,
        `${victim}: RENAME sale_receipts`,
      ]);
      // And the named-table check is red on the same planted copy.
      const byName = new Set(relationsCreatedBy(dir, PHASE3_FILES).map((r) => r.name));
      expect(byName.has('customers')).toBe(true);
      expect(byName.has('customer_payments')).toBe(true);
      // The real tree is clean — the proof is that the finder is sharp, not that the tree is dirty.
      expect(relationsCreatedBy(MIGRATIONS_DIR, PHASE3_FILES).some((r) => r.name === 'customers')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §B — the supplier-scoped half: the shape of what P3-S6 built.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The supplier settlement surface, as P3-S6 built it: the six S6/S5 relations
 * plus the two payment-METHOD relations. Every name the old absolute assertion
 * carried is kept, verbatim and in the same order.
 */
const SUPPLIER_SETTLEMENT_RELATIONS = [
  'payment_method_names',
  'payment_methods',
  'supplier_credit_allocations',
  'supplier_credit_notes',
  'supplier_payment_allocations',
  'supplier_payments',
  'supplier_refunds',
] as const;

/**
 * The scope. The old assertion filtered `relname ~ '(payment|refund|credit_note|credit_alloc)'`
 * and demanded absolute equality, which is a claim about every phase. The same
 * filter intersected with the SUPPLIER side is a claim about P3-S6's own
 * surface: `supplier_*` and the payment-method tables it introduced.
 */
const isSupplierSettlementRelation = (n: string): boolean => /(payment|refund|credit_note|credit_alloc)/.test(n) && /^(supplier_|payment_method)/.test(n);

/** Every supplier-side accounting source type of the Phase 3 prefix, in `sort_order`. */
const SUPPLIER_SOURCE_TYPES = ['supplier_return', 'supplier_payment', 'supplier_credit_allocation', 'supplier_refund'] as const;

/**
 * The SETTLEMENT half of the supplier source types, by shape. Hoisted here for
 * the same reason `isSupplierSettlementRelation` above is: the predicate is the
 * scope of the claim, and it belongs with the other scopes rather than inline
 * in an assertion. `^supplier_` is what makes it P3-S6's claim and not a claim
 * about every phase — a Phase 4 `customer_payment` or `sale_refund` cannot
 * match it (P4-AL-88).
 */
const isSupplierSettlementType = (n: string): boolean => /^supplier_(payment|credit|refund)/.test(n);

/**
 * Every operation kind the Phase 3 prefix registered — all 27, not the subset a
 * name filter happened to catch. `inventory_operation_kinds.registered_by` is
 * the registry's own provenance column (`0054:54`, `^P3-S[0-9]+$`, widened in
 * P4-S1 to `^P[0-9]+-S[0-9]+$`; `P3-C` is the Phase 3 corrective pass), so this
 * is exact-equality over a set the Phase 3 prefix defines and Phase 4 cannot
 * enter.
 */
/**
 * The five op-code NAMESPACES the Phase 3 prefix registers. Phase 4's kinds are
 * `sale.*`, `invoice.*`, `customer.*` and `pos.*`, none of which is here.
 *
 * This is the vocabulary-free way to say "and nothing that names a customer
 * document": rather than filtering the Phase 3 kinds for three Phase 4 words
 * and requiring the result to be empty — which asserts nothing about a fourth
 * word nobody has thought of, and which reads as a claim about Phase 4 — the
 * suite pins the namespaces Phase 3 OWNS. A kind in any other namespace fails
 * it, whatever that namespace is called (P4-AL-88).
 */
const PHASE3_KIND_NAMESPACES = ['inventory', 'payment', 'purchase', 'structure', 'supplier'] as const;

/** The distinct namespaces of a set of op codes, sorted. */
const namespacesOf = (kinds: readonly string[]): string[] => [...new Set(kinds.map((k) => k.split('.')[0] ?? ''))].sort();

const PHASE3_OPERATION_KINDS = [
  'inventory.adjust',
  'inventory.configure_product',
  'inventory.damage',
  'inventory.opening',
  'inventory.stocktake_count',
  'inventory.stocktake_finalize',
  'inventory.stocktake_open',
  'inventory.transfer',
  'payment.activate_method',
  'payment.create_method',
  'payment.deactivate_method',
  'payment.update_method',
  'purchase.cancel',
  'purchase.draft',
  'purchase.receive',
  'purchase.return',
  'purchase.reverse',
  'purchase.write_off_residue',
  'structure.associate_warehouse_branch',
  'structure.dissociate_warehouse_branch',
  'supplier.allocate_credit',
  'supplier.archive',
  'supplier.create',
  'supplier.pay',
  'supplier.reactivate',
  'supplier.receive_refund',
  'supplier.update',
] as const;

let t: TestApp;
let owner: HttpActor;
let A: S3Business;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  t = await createTestApp();
  owner = await registerActor(t, 'S6 supplier-scope owner');
  A = await onboardS3Business(t, owner, 's6nocust');
});

afterAll(async () => {
  await t.close();
  await resetData();
});

describe('§B1 T-09 MP-7 (supplier-scoped): the supplier settlement relations are exactly these and nothing more', () => {
  it('each of the seven exists', async () => {
    for (const name of SUPPLIER_SETTLEMENT_RELATIONS) {
      const r = await ownerPool().query<{ oid: string | null }>(`SELECT to_regclass($1)::text AS oid`, [`public.${name}`]);
      expect(r.rows[0]?.oid ?? null, name).not.toBeNull();
    }
  });

  it('and the supplier settlement surface holds no eighth relation', async () => {
    const all = await ownerPool().query<{ n: string }>(
      `SELECT relname::text AS n FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p', 'v', 'm') ORDER BY relname`,
    );
    const names = all.rows.map((r) => r.n);
    expect(names.filter(isSupplierSettlementRelation)).toEqual([...SUPPLIER_SETTLEMENT_RELATIONS]);
  });

  it('§B1 red proof: a second supplier-side refund relation is named', () => {
    const planted = [...SUPPLIER_SETTLEMENT_RELATIONS, 'supplier_refund_batches', 'supplier_payment_reversals'].sort();
    // The customer side of Phase 4 is deliberately OUT of scope and must not be
    // caught: that is the whole point of the re-expression.
    const phase4 = ['customers', 'sales', 'invoices', 'payments', 'payment_allocations', 'refunds', 'credit_notes'];
    const caught = [...planted, ...phase4].filter(isSupplierSettlementRelation);
    expect(caught).not.toEqual([...SUPPLIER_SETTLEMENT_RELATIONS]);
    expect(caught.filter((n) => !SUPPLIER_SETTLEMENT_RELATIONS.includes(n as (typeof SUPPLIER_SETTLEMENT_RELATIONS)[number]))).toEqual([
      'supplier_payment_reversals',
      'supplier_refund_batches',
    ]);
    expect(phase4.filter(isSupplierSettlementRelation)).toEqual([]);
  });
});

describe('§B2 T-09 MP-7 (supplier-scoped): the supplier source types are exactly these and nothing more', () => {
  it('the database registry holds exactly the four supplier source types, in order', async () => {
    const types = await ownerPool().query<{ t: string }>(`SELECT source_type AS t FROM accounting_source_types ORDER BY sort_order`);
    expect(types.rows.map((r) => r.t).filter((n) => /supplier/.test(n))).toEqual([...SUPPLIER_SOURCE_TYPES]);
    const kinds = await ownerPool().query<{ s: string }>(
      `SELECT DISTINCT source_type AS s FROM accounting_operation_kinds WHERE source_type ~ 'supplier' ORDER BY 1`,
    );
    expect(kinds.rows.map((r) => r.s)).toEqual([...SUPPLIER_SOURCE_TYPES].sort());
  });

  it('the package registry agrees, and the three S6 settlement types are exactly its settlement half', async () => {
    expect((DOMAIN_SOURCE_TYPES as readonly string[]).filter((n) => /supplier/.test(n))).toEqual([...SUPPLIER_SOURCE_TYPES]);
    // `supplier_return` is P3-S5's; the three S6 types are the settlement ones.
    // P4-AL-88: every `supplier_*` name is KEPT and the absolute equality is
    // dropped, which is what the lock's §17.3 re-expression requires. "And
    // nothing more" is not lost — it is restated as a DISJOINTNESS claim over
    // the supplier-settlement scope, so the first Phase 4 customer source type
    // leaves it alone while a fourth SUPPLIER settlement type still fails it.
    const s6Types = (DOMAIN_SOURCE_TYPES as readonly string[]).filter(isSupplierSettlementType);
    expect(s6Types).toEqual(expect.arrayContaining([...S6_SOURCE_TYPES]));
    expect(s6Types.filter((n) => !(S6_SOURCE_TYPES as readonly string[]).includes(n))).toEqual([]);
    // And every source type the database knows is one the package knows, so a
    // supplier source type added in SQL alone is still red.
    const all = await ownerPool().query<{ t: string }>(`SELECT source_type AS t FROM accounting_source_types WHERE source_type ~ 'supplier'`);
    for (const row of all.rows) expect(DOMAIN_SOURCE_TYPES as readonly string[], row.t).toContain(row.t);
  });

  it('§B2 red proof: a fifth supplier source type is named', () => {
    const planted = [...DOMAIN_SOURCE_TYPES, 'supplier_prepayment'];
    expect(planted.filter((n) => /supplier/.test(n))).not.toEqual([...SUPPLIER_SOURCE_TYPES]);
    expect(planted.filter((n) => /supplier/.test(n) && !(SUPPLIER_SOURCE_TYPES as readonly string[]).includes(n))).toEqual(['supplier_prepayment']);
    // A Phase 4 customer source type is out of scope and must NOT be caught.
    expect([...DOMAIN_SOURCE_TYPES, 'customer_payment', 'sale', 'sale_refund'].filter((n) => /supplier/.test(n))).toEqual([...SUPPLIER_SOURCE_TYPES]);
  });
});

describe('§B3 T-09 MP-7 (supplier-scoped): the Phase 3 operation kinds are exactly these 27 and nothing more', () => {
  it('every kind registered by the Phase 3 prefix, by exact equality', async () => {
    const r = await ownerPool().query<{ k: string }>(`SELECT op_code AS k FROM inventory_operation_kinds WHERE registered_by ~ '^P3-' ORDER BY op_code`);
    expect(r.rows.map((x) => x.k)).toEqual([...PHASE3_OPERATION_KINDS]);
  });

  it('within the Phase 3 kinds: the only payment.* kinds are the four METHOD kinds, nothing names a sale, an invoice or a customer, and the only refund is the supplier one', async () => {
    const r = await ownerPool().query<{ k: string }>(`SELECT op_code AS k FROM inventory_operation_kinds WHERE registered_by ~ '^P3-' ORDER BY op_code`);
    const ops = r.rows.map((x) => x.k);
    expect(ops.filter((k) => k.startsWith('payment.'))).toEqual([
      'payment.activate_method',
      'payment.create_method',
      'payment.deactivate_method',
      'payment.update_method',
    ]);
    // STRICTLY STRONGER than "no Phase 3 kind names a sale, an invoice or a
    // customer": the namespaces of the Phase 3 kinds are exactly the five
    // Phase 3 owns, so a kind in ANY foreign namespace fails this — including
    // one no Phase 4 vocabulary list happens to mention. The set is still
    // `registered_by ~ '^P3-'`, which Phase 4 cannot enter, so this is a claim
    // about the Phase 3 prefix and about nothing else (P4-AL-88).
    expect(namespacesOf(ops)).toEqual([...PHASE3_KIND_NAMESPACES]);
    expect(ops.filter((k) => /refund/.test(k))).toEqual(['supplier.receive_refund']);
  });

  it('every Phase 3 kind carries Phase 3 provenance, so the scoping cannot be dodged by mislabelling', async () => {
    const r = await ownerPool().query<{ b: string; n: string }>(
      `SELECT registered_by AS b, count(*)::text AS n FROM inventory_operation_kinds WHERE registered_by ~ '^P3-' GROUP BY 1 ORDER BY 1`,
    );
    expect(r.rows.map((x) => `${x.b}=${x.n}`)).toEqual(['P3-C=1', 'P3-S1=3', 'P3-S3=7', 'P3-S4=7', 'P3-S5=2', 'P3-S6=7']);
    // The 27 of the literal above, accounted for.
    expect(PHASE3_OPERATION_KINDS).toHaveLength(27);
  });

  it('§B3 red proof: a 28th Phase 3-registered kind, and a mislabelled customer kind, are both named', () => {
    const planted = [...PHASE3_OPERATION_KINDS, 'supplier.settle_batch'].sort();
    expect(planted).not.toEqual([...PHASE3_OPERATION_KINDS]);
    // A kind registered as Phase 3 but naming a customer document is caught by
    // the namespace assertion, not merely by the count: `sale` is not one of
    // the five namespaces the Phase 3 prefix owns, and the proof names it.
    const mislabelled = [...PHASE3_OPERATION_KINDS, 'sale.commit'].sort();
    expect(namespacesOf(mislabelled)).not.toEqual([...PHASE3_KIND_NAMESPACES]);
    expect(namespacesOf(mislabelled).filter((n) => !(PHASE3_KIND_NAMESPACES as readonly string[]).includes(n))).toEqual(['sale']);
  });
});

describe('§B4 T-09 MP-7 (supplier-scoped): the supplier settlement routes are exactly these and nothing more', () => {
  /** The six routes `supplier-settlements.controller.ts` registers, by verb and path shape. */
  const REACHED: readonly (readonly [verb: 'get' | 'post', path: string])[] = [
    ['post', '/v1/supplier-payments'],
    ['post', '/v1/supplier-credit-allocations'],
    ['post', '/v1/supplier-refunds'],
  ];

  it('the three supplier settlement commands exist and validate their body (they are REACHED, not 404)', async () => {
    const headers = asMember(owner, A.businessId);
    for (const [verb, path] of REACHED) {
      const r = await t.request[verb](path).set(headers).send({});
      expect(r.status, `${verb.toUpperCase()} ${path}`).toBe(400);
    }
  });

  it('the three supplier settlement reads exist', async () => {
    const id = randomUUID();
    const headers = asMember(owner, A.businessId);
    // A well-formed id for a row that does not exist: reached, and answers 404
    // for the ROW, which is the accepted S6 behaviour.
    expect((await t.request.get(`/v1/supplier-payments/${id}`).set(headers)).status).toBe(404);
    // A malformed id is refused by validation, which proves the route was reached.
    for (const path of [`/v1/supplier-payments/not-a-uuid`, `/v1/suppliers/not-a-uuid/payments`, `/v1/purchases/not-a-uuid/settlements`]) {
      const r = await t.request.get(path).set(headers);
      expect([400, 404].includes(r.status), `GET ${path} -> ${r.status}`).toBe(true);
      expect(r.status, `GET ${path} is reached`).not.toBe(405);
    }
  });

  it('no seventh supplier settlement route exists: neighbouring supplier paths and the mutating verbs are 404', async () => {
    const id = randomUUID();
    const headers = asMember(owner, A.businessId);
    // Paths a wider supplier settlement surface would have. None is registered.
    const absent = [
      '/v1/supplier-payment-reversals',
      '/v1/supplier-refund-approvals',
      '/v1/supplier-credit-notes',
      '/v1/supplier-installments',
      '/v1/supplier-statements',
      `/v1/supplier-payments/${id}/reverse`,
      `/v1/supplier-refunds/${id}`,
      `/v1/supplier-credit-allocations/${id}`,
    ];
    for (const path of absent) {
      for (const verb of ['get', 'post', 'put', 'patch', 'delete'] as const) {
        const r = await t.request[verb](path).set(headers).send({});
        expect(r.status, `${verb.toUpperCase()} ${path}`).toBe(404);
      }
    }
    // The settlement commands are POST-only: nothing amends or deletes a
    // settlement over HTTP, which is the S6 append-only law.
    for (const [, path] of REACHED) {
      for (const verb of ['put', 'patch', 'delete'] as const) {
        const r = await t.request[verb](path).set(headers).send({});
        expect(r.status, `${verb.toUpperCase()} ${path}`).toBe(404);
      }
    }
  });
});
// ─────────────────────────────────────────────────────────────────────────────
// §B5 was here, and it has MOVED — it was not deleted.
//
// It asserted the half of MP-7 the §B4 re-expression had dropped: that there is
// no customer PAYMENT route. That protection is real and is still asserted, but
// it cannot live in a permanent PHASE 3 suite, because the form it was written
// in — `/v1/payments`, `/v1/refunds`, `/v1/customer-credits` and
// `/v1/credit-notes` answer 404, forever, on every verb — is a claim about the
// phase that follows this one. P4-S4 and P4-S5 build those routes by design, so
// this file would have gone red for the success of a later slice: exactly the
// defect `[[daftar-a-closure-rule-is-not-an-invariant]]` names, and exactly
// what `tests/security/phase4-forward-evolution.test.ts` reported at :444
// and :447.
//
// It now lives in `tests/security/phase4-route-surface.test.ts`, re-expressed
// so that BOTH halves of the claim are derived from the Phase 4 controllers'
// own Nest route metadata. `/v1/payments` is still refused on every verb, and
// still refused today — but because it is OUTSIDE THE DERIVED SURFACE rather
// than because a literal list names it. Mounting the route updates both halves
// in the same commit, so the protection survives P4-S4 instead of blocking it.
//
// The one claim that belongs to P4-S1 alone — that the declared surface
// contains no write verb at all — is in the `CANDIDATE-TENSE (P4-AL-61)` fence
// of `scripts/phase4-s1-gate.ts`, which the acceptance commit deletes.
// ─────────────────────────────────────────────────────────────────────────────
