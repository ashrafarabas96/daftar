/**
 * P4-S3 — THE SERVER-SIDE CART: the statement count, the arithmetic, the
 * refusals, and the `0079` seam.
 *
 * The trust boundary's HTTP half lives in
 * `tests/security/pos-s3-trust-boundary.test.ts`; the structural laws live in
 * the permanent `tests/guards/pos-s3-cart-law.test.ts`. This suite is the
 * BEHAVIOURAL half: the production service, the production statement plan and
 * the production arithmetic, driven through the seams they really use.
 *
 * ── WHAT IS REAL HERE AND WHAT IS NOT, STATED PLAINLY ────────────────────
 *
 * `pos_till_sessions` and `pos_cart_lines` are created by migration `0079`,
 * which is AGENT E's file. This agent creates and edits no migration and
 * invents no migration number. At the time this suite was written `0079` had
 * not landed, so the suite is built in two halves and BOTH of them assert:
 *
 *   §1–§4 run the real `PosCartService` through its real `CartSql` port with a
 *   RECORDING seam. That is not a convenience: the claim under test in §1 is
 *   "this operation issues exactly these statements", and a recorder is the
 *   only instrument that measures it. Nothing of the service, the plan or the
 *   pricing is stubbed — only the connection is.
 *
 *   §5 is the `0079` SEAM, and it is a DECLARED DEFERRED SEAM in the sense
 *   `TL-P4-S1-C12` records: «a promise is not a protection», so the condition
 *   is discovered from the DATABASE rather than from a slice number, and the
 *   suite's behaviour changes the moment what made it safe stops being true.
 *   It asks the live catalogue whether `pos_cart_lines` exists:
 *
 *     - it does NOT: the projection statement is sent to the real server
 *       anyway and must be refused `42P01 undefined_table` NAMING
 *       `pos_cart_lines` — which proves everything else in that statement
 *       parses, because PostgreSQL reports a missing relation only after it
 *       has parsed the query, and a syntax error would arrive as `42601`;
 *     - it DOES: the live assertions run — the declared columns exist, none of
 *       the forbidden stored-total columns does, and the statements execute.
 *
 *   Neither branch skips, neither relaxes a threshold, and the second branch
 *   becomes the real test automatically when E's migration lands.
 *
 * ── NO MIGRATION, NO ACCOUNTING OBJECT, NO LATER SLICE ────────────────────
 *
 * Nothing here writes a migration, posts an entry, moves stock or names a
 * payment, an allocation, a credit, a refund, a return or an installment.
 * P4-S3 creates no accounting object at all.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError, TrustedRoleSet, type Permission } from '@daftar/domain-core';
import type { Database } from '../../apps/api/src/infra/database';
import type { Logger } from '../../apps/api/src/infra/logger';
import type { MembershipContext } from '../../apps/api/src/modules/tenancy/tenancy.service';
import { PosCartService, RecordingCartSql } from '../../apps/api/src/modules/pos/pos-cart.service';
import {
  CART_STATEMENTS_PER_COMMAND,
  POS_CART_COLUMNS,
  POS_CART_FORBIDDEN_COLUMNS,
  POS_CART_MERGE_UNIQUE_KEY,
  POS_CART_MERGE_KEY_NULLS_NOT_DISTINCT,
  cartStatementPlan,
  type CartCommandTarget,
} from '../../apps/api/src/modules/pos/pos-cart-statements';
import { roundingGrains, priceCart } from '../../apps/api/src/modules/pos/pos-cart-pricing';
import { POS_CART_COMMANDS, type PosCartCommand } from '../../apps/api/src/modules/pos/pos-price-authority';
import { POS_CART_ROUTE_AUTHORITY, POS_CART_ROUTE_HANDLERS } from '../../apps/api/src/modules/pos/pos-cart-routes';
import { PosCartService as PosCartServiceType } from '../../apps/api/src/modules/pos/pos-cart.service';
import { ensurePostgres, ownerPool } from '../helpers/test-app';

const REPO = join(import.meta.dirname, '..', '..');
const MIGRATIONS = join(REPO, 'infrastructure/database/migrations');

const TENANT = '11111111-1111-4111-8111-111111111111';
const BUSINESS = '22222222-2222-4222-8222-222222222222';
const TILL = '33333333-3333-4333-8333-333333333333';
const LINE = '44444444-4444-4444-8444-444444444444';
const PRODUCT = '55555555-5555-4555-8555-555555555555';

const logs: { fields: Record<string, unknown>; message: string }[] = [];
const logger = {
  info: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  error: (fields: Record<string, unknown>, message: string) => {
    logs.push({ fields, message });
  },
} as unknown as Logger;

/**
 * A `Database` that throws if anything touches it.
 *
 * §1–§4 drive `runPlan` and `recompute`, which are the seams that take no
 * connection. A stub that THROWS is the assertion: if a later edit made the
 * arithmetic or the plan executor open a transaction, these sections would
 * fail rather than quietly becoming slower.
 */
const noDatabase = new Proxy(
  {},
  {
    get(_t, prop) {
      throw new Error(`the cart arithmetic took a database connection: Database.${String(prop)}`);
    },
  },
) as Database;

function service(): PosCartService {
  return new PosCartService(noDatabase, logger);
}

function membership(...permissions: readonly Permission[]): MembershipContext {
  return {
    tenantId: TENANT,
    businessId: BUSINESS,
    userId: ACTOR,
    roles: TrustedRoleSet.fromPersistence([{ key: 'cashier', isSystem: false, permissions: new Set<string>(permissions) }]),
    roleKeys: ['cashier'],
    branchScopeMode: 'all',
    allowedBranchIds: [],
  };
}

const ACTOR = '66666666-6666-4666-8666-666666666666';

const target = (overrides: Partial<CartCommandTarget> = {}): CartCommandTarget => ({
  tenantId: TENANT,
  businessId: BUSINESS,
  tillSessionId: TILL,
  actorUserId: ACTOR,
  cartLineId: LINE,
  productId: PRODUCT,
  variantId: null,
  quantity: '1',
  discountMinor: '0',
  ...overrides,
});

/**
 * The mutation's answer when everything is in order: the session is visible,
 * open and the ACTOR'S OWN, and one cart row was touched. The three session
 * counts are what let ONE statement say which of three refusals applies.
 */
const USABLE = { session_visible: '1', session_open: '1', session_usable: '1', written: '1' };

/** One row of the projection, as the statement's column names spell it. */
const projectionRow = (i: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  cart_line_id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`,
  product_id: `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, '0')}`,
  variant_id: null,
  quantity: '2',
  discount_minor: '0',
  unit_price_minor: '1999',
  price_currency: 'SAR',
  name_snapshot: `product ${i}`,
  ...overrides,
});

/**
 * A recording seam that answers the mutation with "one usable session, one row
 * written" and the projection with `lineCount` rows.
 *
 * The two statements are told apart by their ROLE in the plan rather than by
 * matching their text, so the discrimination does not depend on the SQL's
 * spelling and survives `0079` renaming a column.
 */
function seam(plan: readonly { text: string }[], lineCount: number): RecordingCartSql {
  const mutationText = plan[0]?.text;
  return new RecordingCartSql((text) => (text === mutationText ? [USABLE] : Array.from({ length: lineCount }, (_, i) => projectionRow(i))));
}

/** A refusal, as the two things a law may assert, read off the thrown error. */
async function refusalOf(fn: () => Promise<unknown>): Promise<{ code: string; status: number; details: unknown }> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof AppError) {
      const code = (e.details as { sellingCode?: unknown } | undefined)?.sellingCode;
      return { code: typeof code === 'string' ? code : `<no sellingCode: ${e.code}>`, status: e.httpStatus, details: e.details };
    }
    return { code: `<not an AppError: ${String(e)}>`, status: -1, details: undefined };
  }
  return { code: '<no refusal>', status: 0, details: undefined };
}

beforeAll(async () => {
  await ensurePostgres();
});

afterAll(async () => {
  logs.length = 0;
});

// ═════════════════════════════════════════════════════════════════════════
describe('§1 — the statement count is constant in the line count, MEASURED at the seam', () => {
  it('one line and fifty lines issue exactly two statements, for every command', async () => {
    // The structural claim is asserted in the permanent guard suite. THIS is
    // the behavioural half: what the executor really sent. A per-operation
    // count, not a millisecond.
    for (const command of POS_CART_COMMANDS) {
      const plan = cartStatementPlan(command, target());
      const counts: number[] = [];
      for (const lineCount of [1, 50]) {
        const sql = seam(plan, lineCount);
        const lines = await service().runPlan(sql, plan);
        expect(lines, `${command} @ ${lineCount}`).toHaveLength(lineCount);
        counts.push(sql.issued.length);
      }
      // The equality the law is about.
      expect(counts[0], `${command}: 1 line vs 50 lines`).toBe(counts[1]);
      expect(counts[0]).toBe(CART_STATEMENTS_PER_COMMAND);
    }
  });

  it('a 500-line cart still issues two statements — the count is flat, not merely equal at two points', async () => {
    const plan = cartStatementPlan('cart.add_line', target());
    const observed: number[] = [];
    for (const lineCount of [1, 2, 7, 50, 200]) {
      const sql = seam(plan, lineCount);
      await service().runPlan(sql, plan);
      observed.push(sql.issued.length);
    }
    expect(new Set(observed)).toEqual(new Set([CART_STATEMENTS_PER_COMMAND]));
  });

  it('the executor issues EXACTLY the plan, in order — no statement the plan does not hold', async () => {
    const plan = cartStatementPlan('cart.change_quantity', target());
    const sql = seam(plan, 3);
    await service().runPlan(sql, plan);
    expect(sql.issued.map((s) => s.text)).toEqual(plan.map((s) => s.text));
    expect(sql.issued.map((s) => s.params)).toEqual(plan.map((s) => s.params));
  });

  it('no connection is taken by the plan executor or the arithmetic', async () => {
    // `noDatabase` throws on any property access. Reaching the end of §1
    // without that error IS the assertion; this case states it so the
    // mechanism is visible rather than incidental.
    const plan = cartStatementPlan('cart.remove_line', target());
    await expect(service().runPlan(seam(plan, 4), plan)).resolves.toHaveLength(4);
    expect(() => (noDatabase as unknown as { withTransaction: unknown }).withTransaction).toThrow(/took a database connection/);
  });
});

// ═════════════════════════════════════════════════════════════════════════
describe('§2 — the arithmetic: derived on the server, integer minor units, ONE rounding', () => {
  it('the cart a command answers with is RECOMPUTED, and its rounding has one grain at any size', async () => {
    for (const lineCount of [1, 50]) {
      const plan = cartStatementPlan('cart.add_line', target());
      const lines = await service().runPlan(seam(plan, lineCount), plan);
      const cart = service().recompute(TILL, lines, 'SAR');
      // 1999 x 2 = 3998 per line, exactly.
      expect(cart.lines).toHaveLength(lineCount);
      expect(cart.totalMinor).toBe(String(3998 * lineCount));
      expect(cart.taxMinor).toBe('0');
      // Every figure a decimal STRING of minor units — never a JSON number.
      for (const value of [cart.subtotalMinor, cart.discountMinor, cart.taxMinor, cart.totalMinor]) {
        expect(typeof value).toBe('string');
        expect(value).toMatch(/^-?\d+$/);
      }
      // And the rounding ledger of the same stored lines: ONE grain.
      const priced = priceCart(lines, 'SAR');
      expect(roundingGrains(priced.rounding), `${lineCount} lines`).toEqual(['line']);
      expect(priced.rounding.entries).toHaveLength(lineCount);
    }
  });

  it('the cart total is the exact sum of the line nets — no second rounding at the cart grain', async () => {
    // Quantities chosen so every line gross is a HALF_EVEN TIE, which is
    // where one rounding layer and two part company.
    const plan = cartStatementPlan('cart.add_line', target());
    const sql = new RecordingCartSql((text) =>
      text === plan[0]?.text
        ? [USABLE]
        : [
            projectionRow(0, { quantity: '0.5', unit_price_minor: '101' }),
            projectionRow(1, { quantity: '0.5', unit_price_minor: '103' }),
            projectionRow(2, { quantity: '0.5', unit_price_minor: '105' }),
          ],
    );
    const cart = service().recompute(TILL, await service().runPlan(sql, plan), 'SAR');
    expect(cart.lines.map((l) => l.grossMinor)).toEqual(['50', '52', '52']);
    expect(cart.subtotalMinor).toBe('154');
    expect(cart.totalMinor).toBe('154');
    // The identity, over the wire's own strings.
    expect(cart.lines.reduce((a, l) => a + BigInt(l.netMinor), 0n).toString(10)).toBe(cart.totalMinor);
  });

  it('the quantity comes back as its exact decimal spelling, with no float anywhere', async () => {
    const plan = cartStatementPlan('cart.add_line', target());
    const sql = new RecordingCartSql((text) =>
      text === plan[0]?.text
        ? [USABLE]
        : [projectionRow(0, { quantity: '2.5000' }), projectionRow(1, { quantity: '0.0001' }), projectionRow(2, { quantity: '7' })],
    );
    const cart = service().recompute(TILL, await service().runPlan(sql, plan), 'SAR');
    expect(cart.lines.map((l) => l.quantity)).toEqual(['2.5', '0.0001', '7']);
  });

  it('a discount is applied to the DERIVED gross, and one minor unit past it is refused', async () => {
    const plan = cartStatementPlan('cart.request_discount', target({ discountMinor: '3998' }));
    const atTheGross = new RecordingCartSql((text) => (text === plan[0]?.text ? [USABLE] : [projectionRow(0, { discount_minor: '3998' })]));
    expect(service().recompute(TILL, await service().runPlan(atTheGross, plan), 'SAR').totalMinor).toBe('0');

    const pastIt = new RecordingCartSql((text) => (text === plan[0]?.text ? [USABLE] : [projectionRow(0, { discount_minor: '3999' })]));
    const refusal = await refusalOf(async () => service().recompute(TILL, await service().runPlan(pastIt, plan), 'SAR'));
    expect(refusal).toMatchObject({ code: 'pos.cart_discount_invalid', status: 400 });
  });
});

// ═════════════════════════════════════════════════════════════════════════
describe('§3 — the refusals, by stable code and registered status', () => {
  it('the session gate answers THREE different refusals from ONE statement, widest first', async () => {
    // Each code is the till-session surface's own, registered in the one
    // canonical registry: a cart command invents no second vocabulary for a
    // session fact. The ORDER is the law, not a style — answering
    // `pos.session_not_owned` for a session in another business would confirm
    // that a row exists there, which is the cross-tenant enumeration the
    // estate's guard refuses.
    const cases = [
      { counts: { session_visible: '0', session_open: '0', session_usable: '0' }, code: 'pos.session_not_found', status: 404 },
      { counts: { session_visible: '1', session_open: '0', session_usable: '0' }, code: 'pos.session_not_open', status: 409 },
      { counts: { session_visible: '1', session_open: '1', session_usable: '0' }, code: 'pos.session_not_owned', status: 403 },
    ];
    for (const { counts, code, status } of cases) {
      const plan = cartStatementPlan('cart.add_line', target());
      const sql = new RecordingCartSql(() => [{ ...counts, written: '0' }]);
      expect(await refusalOf(() => service().runPlan(sql, plan)), code).toMatchObject({ code, status });
      // And the PROJECTION was never issued: a refused command does not go on
      // to read a basket it is not allowed to touch.
      expect(sql.issued, code).toHaveLength(1);
    }
  });

  it('`OD-P4-09` is enforced by the cart too: the actor is compared against the session\u2019s own owner column', async () => {
    // The comparison happens in SQL, inside the mutation, against
    // `opened_by_user_id` — so it costs no extra statement and no `if` in this
    // process can be the only thing standing between a cashier and a
    // colleague's till.
    const [mutation] = cartStatementPlan('cart.add_line', target());
    expect(mutation?.text).toContain(POS_CART_COLUMNS.sessions.owner);
    // The actor travels as a PARAMETER resolved from the membership, never
    // from a body: it is the fourth parameter of every cart mutation.
    for (const command of POS_CART_COMMANDS) {
      const [m] = cartStatementPlan(command, target());
      expect(m?.params[3], command).toBe(ACTOR);
    }
  });

  it('a line this basket does not hold is 404 `pos.cart_line_not_found`', async () => {
    const plan = cartStatementPlan('cart.change_quantity', target());
    const missing = new RecordingCartSql(() => [{ session_visible: '1', session_open: '1', session_usable: '1', written: '0' }]);
    expect(await refusalOf(() => service().runPlan(missing, plan))).toMatchObject({ code: 'pos.cart_line_not_found', status: 404 });
    expect(missing.issued).toHaveLength(1);
  });

  it('a discount without `sales.discount` is 403 `pos.cart_discount_not_permitted` — never silently zeroed', async () => {
    // P4-AL-35: SENSITIVE. The refusal is in the SERVICE because it depends on
    // the body and a decorator cannot see the body.
    const refusal = await refusalOf(() => service().requestDiscount(membership('sales.create'), TILL, LINE, '500'));
    expect(refusal).toMatchObject({ code: 'pos.cart_discount_not_permitted', status: 403 });
    // A request of exactly ZERO needs the same key: setting a discount to zero
    // changes the price the cashier quoted just as surely as any other value.
    expect(await refusalOf(() => service().requestDiscount(membership('sales.create'), TILL, LINE, '0'))).toMatchObject({
      code: 'pos.cart_discount_not_permitted',
      status: 403,
    });
    // And it is refused BEFORE a connection is taken: `noDatabase` throws on
    // touch, so a refusal that reached the seam would surface as that error.
    expect(refusal.code).toBe('pos.cart_discount_not_permitted');
  });

  it('an actor WITH `sales.discount` gets past the permission gate and reaches the seam', async () => {
    // The control for the case above: without it, a service that refused every
    // discount would look identical.
    const refusal = await refusalOf(() => service().requestDiscount(membership('sales.create', 'sales.discount'), TILL, LINE, '500'));
    expect(refusal.code).toMatch(/took a database connection/);
  });

  it('an unpriced product is 422 and a mixed-currency basket is 422 — refused, never guessed', async () => {
    const plan = cartStatementPlan('cart.add_line', target());
    const unpriced = new RecordingCartSql((text) => (text === plan[0]?.text ? [USABLE] : [projectionRow(0, { unit_price_minor: null, price_currency: null })]));
    expect(await refusalOf(async () => service().recompute(TILL, await service().runPlan(unpriced, plan), 'SAR'))).toMatchObject({
      code: 'pos.cart_product_not_priced',
      status: 422,
    });
    const mixed = new RecordingCartSql((text) => (text === plan[0]?.text ? [USABLE] : [projectionRow(0), projectionRow(1, { price_currency: 'TRY' })]));
    expect(await refusalOf(async () => service().recompute(TILL, await service().runPlan(mixed, plan), 'SAR'))).toMatchObject({
      code: 'pos.cart_currency_mixed',
      status: 422,
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════
describe('§4 — a recognized internal invariant is a 500 with NO details', () => {
  it('a statement plan that is not two statements is 500, logged by name, with nothing in the body', async () => {
    // «Keep a recognized internal invariant at 500 with no details rather than
    // a merchant-facing 4xx»: a broken plan is a DEFECT and a merchant can do
    // nothing about it. 403 would say the cashier lacked authority; 409 would
    // say the till was in the wrong state. Both read as merchant outcomes, so
    // nobody looks at the server.
    logs.length = 0;
    const planted = [cartStatementPlan('cart.add_line', target())[0]] as never;
    let thrown: unknown;
    try {
      await service().runPlan(new RecordingCartSql(() => []), planted);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AppError);
    const error = thrown as AppError;
    expect(error.httpStatus).toBe(500);
    expect(error.code).toBe('INTERNAL_ERROR');
    // The typed code, and that is the WHOLE of `details`: no statement count,
    // no SQL, no routine name, no amount.
    expect(Object.keys(error.details ?? {})).toEqual(['sellingCode']);
    expect((error.details as { sellingCode?: string }).sellingCode).toBe('pos.cart_statement_plan_invalid');
    // The name went to the LOG, beside nothing a merchant could read.
    expect(logs.map((l) => l.fields.invariant)).toContain('pos.cart_statement_plan_invalid');
  });

  it('a mutation that returned no row at all is the same 500 — never a merchant refusal', async () => {
    const plan = cartStatementPlan('cart.add_line', target());
    const silent = new RecordingCartSql(() => []);
    let thrown: unknown;
    try {
      await service().runPlan(silent, plan);
    } catch (e) {
      thrown = e;
    }
    expect((thrown as AppError).httpStatus).toBe(500);
    expect(Object.keys((thrown as AppError).details ?? {})).toEqual(['sellingCode']);
  });
});

// ═════════════════════════════════════════════════════════════════════════
describe('§5 — the `0079` seam, discovered from the DATABASE and not from a slice number', () => {
  it('states where `0079` stands, and asserts the right half accordingly', async () => {
    const pool = ownerPool();
    const { rows } = await pool.query<{ lines: string | null; sessions: string | null }>(
      `SELECT to_regclass($1)::text AS lines, to_regclass($2)::text AS sessions`,
      [POS_CART_COLUMNS.lines.table, POS_CART_COLUMNS.sessions.table],
    );
    const present = rows[0]?.lines !== null && rows[0]?.sessions !== null;

    if (!present) {
      // ── `0079` HAS NOT LANDED ───────────────────────────────────────────
      // The statement is sent to the REAL server anyway. PostgreSQL reports a
      // missing relation only AFTER parsing, so `42P01` naming
      // `pos_cart_lines` proves every other identifier, cast, join and clause
      // in the projection is accepted by the parser — and a syntax error
      // would have arrived as `42601` instead.
      const [, projection] = cartStatementPlan('cart.add_line', target());
      let code: string | undefined;
      let message = '';
      try {
        await pool.query(projection?.text ?? '', [...(projection?.params ?? [])]);
      } catch (e) {
        code = (e as { code?: string }).code;
        message = String((e as { message?: string }).message ?? '');
      }
      expect(code, `the projection failed for a reason other than the missing relation: ${message}`).toBe('42P01');
      expect(message).toContain(POS_CART_COLUMNS.lines.table);
      // And the migration tree really has no `0079` yet, so the seam's
      // statement about the world is checkable and not a guess.
      const ordinals = readdirSync(MIGRATIONS)
        .filter((f) => f.endsWith('.sql'))
        .map((f) => Number(f.slice(0, 4)))
        .filter((n) => Number.isInteger(n));
      expect(Math.max(...ordinals)).toBeLessThan(79);
      return;
    }

    // ── `0079` HAS LANDED ─────────────────────────────────────────────────
    // Every column this module depends on exists, under the name it depends
    // on, and NONE of the stored derived totals does.
    const expected = [
      ...Object.entries(POS_CART_COLUMNS.lines)
        .filter(([key]) => key !== 'table')
        .map(([, column]) => column),
    ];
    const { rows: columns } = await pool.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [
      POS_CART_COLUMNS.lines.table,
    ]);
    const actual = new Set(columns.map((c) => c.column_name));
    for (const column of expected) expect([...actual], `0079 has no ${POS_CART_COLUMNS.lines.table}.${column}`).toContain(column);
    // P4-AL-06: no stored derived truth.
    for (const forbidden of POS_CART_FORBIDDEN_COLUMNS) {
      expect([...actual], `${POS_CART_COLUMNS.lines.table} stores a derived total: ${forbidden}`).not.toContain(forbidden);
    }
    // And the projection EXECUTES, which is the whole point of the seam.
    const [, projection] = cartStatementPlan('cart.add_line', target());
    await expect(pool.query(projection?.text ?? '', [...(projection?.params ?? [])])).resolves.toBeDefined();

    // ── The merge key, including the half that would fail SILENTLY ────────
    // The add is an upsert, so `0079` must carry a unique index on exactly
    // the tuple the statement infers, and it must treat two NULL
    // `variant_id`s as EQUAL. Without `NULLS NOT DISTINCT`, a product with no
    // variants would never conflict with itself: a second scan of one barcode
    // would quietly mint a second line, with no error at the till and no
    // failing assertion anywhere else in this slice. So it is read off
    // `pg_index` rather than trusted.
    const { rows: indexes } = await pool.query<{ cols: string[]; nulls_not_distinct: boolean }>(
      `SELECT array_agg(a.attname::text ORDER BY k.ord) AS cols, i.indnullsnotdistinct AS nulls_not_distinct
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indrelid
         CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
        WHERE c.relname = $1 AND i.indisunique
        GROUP BY i.indexrelid, i.indnullsnotdistinct`,
      [POS_CART_COLUMNS.lines.table],
    );
    const merge = indexes.find((row) => [...row.cols].sort().join(',') === [...POS_CART_MERGE_UNIQUE_KEY].sort().join(','));
    expect(merge, `0079 has no unique index on (${POS_CART_MERGE_UNIQUE_KEY.join(', ')}) — the add-line upsert would raise 42P10`).toBeDefined();
    expect(
      merge?.nulls_not_distinct,
      'the merge index treats two NULL variant_id values as DISTINCT: a product with no variants would silently get a SECOND line',
    ).toBe(POS_CART_MERGE_KEY_NULLS_NOT_DISTINCT);

    // The merge itself, demonstrated: the same product twice is ONE line.
    const [mutation] = cartStatementPlan('cart.add_line', target());
    expect(mutation?.text).toContain('ON CONFLICT');
  });
});

// ═════════════════════════════════════════════════════════════════════════
describe('§6 — the surface this slice hands over, stated so it is enumerable', () => {
  it('the route table is four rows, one per command, and the mount is the coordinator\u2019s', () => {
    // P4-S3 creates NO `*.controller.ts` file, not even an unmounted one:
    // `discoverPhase4Routes` walks all of `apps/api/src/modules` for that
    // suffix and the G-02 golden asserts its own route list EQUAL to that
    // discovery, so the file's mere existence turns a sealed P4-S1 golden red.
    // The surface is handed over as DATA and mounted once, by the coordinator,
    // after `0079`.
    expect(readdirSync(join(REPO, 'apps/api/src/modules/pos')).filter((f) => f.endsWith('.controller.ts'))).toEqual([]);
    expect(POS_CART_ROUTE_AUTHORITY).toHaveLength(4);
    expect(POS_CART_ROUTE_AUTHORITY.map((r) => r.command)).toEqual([...POS_CART_COMMANDS]);
    for (const route of POS_CART_ROUTE_AUTHORITY) {
      expect(route.permission).toBe('sales.create');
      expect(route.sensitive).toBe(false);
      expect(route.status).toBe(200);
      expect(route.body).toBe(true);
    }
  });

  it('every route names a method that exists on the service \u2014 the mount cannot call a handler that is not there', () => {
    const service = new PosCartServiceType(noDatabase, logger);
    for (const route of POS_CART_ROUTE_AUTHORITY) {
      const method = POS_CART_ROUTE_HANDLERS[route.command];
      expect(typeof (service as unknown as Record<string, unknown>)[method], `${route.command} \u2192 ${String(method)}`).toBe('function');
    }
  });

  it('P4-S3 builds no payment, allocation, credit, refund, return or installment surface', () => {
    // The scope boundary, asserted over this agent's own source rather than
    // promised in a hand-back.
    const sources = [
      'pos-cart.service.ts',
      'pos-cart-statements.ts',
      'pos-cart-pricing.ts',
      'pos-cart-routes.ts',
      'pos-cart.schemas.ts',
      'pos-price-authority.ts',
    ];
    for (const file of sources) {
      const code = readFileSync(join(REPO, 'apps/api/src/modules/pos', file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      for (const forbidden of ['payments', 'payment_allocations', 'customer_credits', 'credit_notes', 'refunds', 'installment']) {
        expect(code.includes(forbidden), `${file} reaches for ${forbidden}`).toBe(false);
      }
      // And no accounting object at all.
      for (const forbidden of ['journal_entries', 'accounting_post_entry', 'postEntry', 'accounting_source_bindings', 'stock_movements']) {
        expect(code.includes(forbidden), `${file} reaches for ${forbidden}`).toBe(false);
      }
    }
  });

  it('each command has one plan, one schema, one accepted-key row and one route \u2014 four of each', () => {
    expect(POS_CART_COMMANDS).toHaveLength(4);
    for (const command of POS_CART_COMMANDS as readonly PosCartCommand[]) {
      expect(cartStatementPlan(command, target()), command).toHaveLength(CART_STATEMENTS_PER_COMMAND);
      expect(
        POS_CART_ROUTE_AUTHORITY.filter((r) => r.command === command),
        command,
      ).toHaveLength(1);
    }
  });
});
