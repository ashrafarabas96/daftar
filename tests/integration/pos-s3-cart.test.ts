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
  POS_CART_UNIQUE_CONSTRAINT,
  POS_CART_UNIQUE_COLUMNS,
  POS_CART_UNIQUE_IS_PARTIAL,
  POS_CART_UNIQUE_PREDICATE,
  type CartStatement,
  setLineParams,
  cartStatementPlan,
  type CartCommandTarget,
} from '../../apps/api/src/modules/pos/pos-cart-statements';
import { roundingGrains, priceCart, type StoredCartLine } from '../../apps/api/src/modules/pos/pos-cart-pricing';
import { POS_CART_COMMANDS, type PosCartCommand } from '../../apps/api/src/modules/pos/pos-price-authority';
import { newBusinessTransactionId } from '../../apps/api/src/modules/inventory/business-transaction';
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

/**
 * A stand-in for the shared authority module: it establishes an authority and
 * mints a token without a key or a connection.
 *
 * It is a stub because what this suite measures is the CART's behaviour — the
 * statement count, the arithmetic, the refusals — and the authority module has
 * its own suites for `sales.create`, the warehouse scope and the signing. What
 * is NOT stubbed is the order: `issuePlan` calls `authorize` then `mint` then
 * the seam, and §3 asserts the authority was established with the SESSION's
 * warehouse rather than anything a body carried.
 */
const BTX = newBusinessTransactionId();

const authorized: { opCode: string; warehouseIds: readonly string[]; payloadSha256: string }[] = [];

const authorization = {
  authorize: async (
    _m: MembershipContext,
    opCode: string,
    _btx: unknown,
    warehouseIds: readonly string[] = [],
  ): Promise<{ opCode: string; warehouseIds: readonly string[] }> => {
    authorized.push({ opCode, warehouseIds, payloadSha256: '' });
    return { opCode, warehouseIds };
  },
  mint: (authority: { opCode: string }, payload: { opCode: string; sha256: string }): string => {
    if (payload.opCode !== authority.opCode) throw new Error(`authority for ${authority.opCode} cannot sign ${payload.opCode}`);
    const last = authorized[authorized.length - 1];
    if (last !== undefined) last.payloadSha256 = payload.sha256;
    return `invctl1.test.${payload.sha256.slice(0, 16)}`;
  },
} as unknown as ConstructorParameters<typeof PosCartService>[1];

function service(): PosCartService {
  return new PosCartService(noDatabase, authorization, logger);
}

/**
 * Drive one command over ONE recording port for both the gate and the seam.
 *
 * Production passes two ports — the gate reads in its own transaction, the
 * routine and the projection run inside the `invctl/1` seam — and this passes
 * the same one twice, so every statement the real path issues is recorded in
 * the real order. That is what makes the count a measurement of production
 * rather than of a test-only path.
 */
async function runPlan(
  sql: RecordingCartSql,
  plan: readonly CartStatement[],
  command: PosCartCommand,
  t: CartCommandTarget,
  m: MembershipContext = membership('sales.create', 'sales.discount'),
): Promise<readonly StoredCartLine[]> {
  return service().issuePlan(m, command, t, plan, sql, (_assertion, run) => run(sql), BTX);
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
const WAREHOUSE = '77777777-7777-4777-8777-777777777777';

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
/**
 * The GATE's answer for a usable session holding the addressed line, LIVE.
 *
 * `written` is gone: the gate reports what the line IS, and the service
 * decides from `line_present` / `line_removed`. That is the shape that lets
 * E's idempotent removal and this slice's 404 coexist.
 */
const USABLE = {
  session_visible: '1',
  session_open: '1',
  session_usable: '1',
  next_line_no: 4,
  line_present: '1',
  line_removed: '0',
  warehouse_id: WAREHOUSE,
  line_no: 3,
  product_id: 'bbbbbbbb-0000-4000-8000-000000000001',
  variant_id: 'cccccccc-0000-4000-8000-000000000001',
  // The line's CURRENT quantity and discount, which a revision must RESTATE.
  quantity: '2',
  requested_discount_minor: '0',
  // The stated product's BASE variant, for an append that named none: `0079`
  // declares `variant_id UUID NOT NULL`, so the server resolves it.
  base_variant_id: 'cccccccc-0000-4000-8000-000000000001',
};

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
 * The three statements are told apart by their ROLE in the plan rather than by
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
  it('one line and fifty lines issue exactly THREE statements, for every command', async () => {
    // The structural claim is asserted in the permanent guard suite. THIS is
    // the behavioural half: what the executor really sent. A per-operation
    // count, not a millisecond.
    for (const command of POS_CART_COMMANDS) {
      const plan = cartStatementPlan(command, target());
      const counts: number[] = [];
      for (const lineCount of [1, 50]) {
        const sql = seam(plan, lineCount);
        const lines = await runPlan(sql, plan, command, target());
        expect(lines, `${command} @ ${lineCount}`).toHaveLength(lineCount);
        counts.push(sql.issued.length);
      }
      // The equality the law is about.
      expect(counts[0], `${command}: 1 line vs 50 lines`).toBe(counts[1]);
      expect(counts[0]).toBe(CART_STATEMENTS_PER_COMMAND);
    }
  });

  it('a 200-line cart still issues three statements — the count is flat, not merely equal at two points', async () => {
    const plan = cartStatementPlan('cart.add_line', target());
    const observed: number[] = [];
    for (const lineCount of [1, 2, 7, 50, 200]) {
      const sql = seam(plan, lineCount);
      await runPlan(sql, plan, 'cart.add_line', target());
      observed.push(sql.issued.length);
    }
    expect(new Set(observed)).toEqual(new Set([CART_STATEMENTS_PER_COMMAND]));
  });

  it('the executor issues EXACTLY the plan, in order — no statement the plan does not hold', async () => {
    const plan = cartStatementPlan('cart.change_quantity', target());
    const sql = seam(plan, 3);
    await runPlan(sql, plan, 'cart.change_quantity', target());
    // The TEXTS are exactly the plan's, in the plan's order: no statement the
    // plan does not hold, and none of them reordered.
    expect(sql.issued.map((s) => s.text)).toEqual(plan.map((s) => s.text));
    // The PARAMETERS match the plan everywhere except the routine, which
    // declares `bindsFromGate` and is issued with what the gate answered. That
    // is the design and not a leak: `pos_cart_set_line` takes `p_line_no`,
    // `p_product_id` and `p_variant_id`, so the server must state them, and
    // the gate is the only honest source. Asserted positively, so a routine
    // issued with the plan's EMPTY params — a call that would write nulls over
    // a line — fails here.
    expect(sql.issued[0]?.params).toEqual(plan[0]?.params);
    expect(sql.issued[2]?.params).toEqual(plan[2]?.params);
    expect(plan[1]?.bindsFromGate).toBe(true);
    expect(plan[1]?.params).toEqual([]);
    expect(sql.issued[1]?.params).not.toEqual([]);
    // And every bound argument is a SERVER fact: the gate's ordinal and the
    // gate's identities, never anything the body carried.
    expect(sql.issued[1]?.params).toEqual(setLineParams('cart.change_quantity', target(), USABLE));
  });

  it('no connection is taken by the plan executor or the arithmetic', async () => {
    // `noDatabase` throws on any property access. Reaching the end of §1
    // without that error IS the assertion; this case states it so the
    // mechanism is visible rather than incidental.
    const plan = cartStatementPlan('cart.remove_line', target());
    await expect(runPlan(seam(plan, 4), plan, 'cart.remove_line', target())).resolves.toHaveLength(4);
    expect(() => (noDatabase as unknown as { withTransaction: unknown }).withTransaction).toThrow(/took a database connection/);
  });
});

// ═════════════════════════════════════════════════════════════════════════
describe('§2 — the arithmetic: derived on the server, integer minor units, ONE rounding', () => {
  it('the cart a command answers with is RECOMPUTED, and its rounding has one grain at any size', async () => {
    for (const lineCount of [1, 50]) {
      const plan = cartStatementPlan('cart.add_line', target());
      const lines = await runPlan(seam(plan, lineCount), plan, 'cart.add_line', target());
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
    const cart = service().recompute(TILL, await runPlan(sql, plan, 'cart.add_line', target()), 'SAR');
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
    const cart = service().recompute(TILL, await runPlan(sql, plan, 'cart.add_line', target()), 'SAR');
    expect(cart.lines.map((l) => l.quantity)).toEqual(['2.5', '0.0001', '7']);
  });

  it('a discount is applied to the DERIVED gross, and one minor unit past it is refused', async () => {
    const plan = cartStatementPlan('cart.request_discount', target({ discountMinor: '3998' }));
    const atTheGross = new RecordingCartSql((text) => (text === plan[0]?.text ? [USABLE] : [projectionRow(0, { discount_minor: '3998' })]));
    expect(service().recompute(TILL, await runPlan(atTheGross, plan, 'cart.request_discount', target({ discountMinor: '3998' })), 'SAR').totalMinor).toBe('0');

    const pastIt = new RecordingCartSql((text) => (text === plan[0]?.text ? [USABLE] : [projectionRow(0, { discount_minor: '3999' })]));
    const refusal = await refusalOf(async () =>
      service().recompute(TILL, await runPlan(pastIt, plan, 'cart.request_discount', target({ discountMinor: '3998' })), 'SAR'),
    );
    expect(refusal).toMatchObject({ code: 'pos.cart_discount_invalid', status: 400 });
  });
});

// ═════════════════════════════════════════════════════════════════════════
describe('§2b — the minting side: the authority, the payload, and what is NOT in it', () => {
  it('every cart command authorizes against the SESSION\u2019s warehouse, read per command', async () => {
    // The coordinator's ruling, asserted. A cashier's branch scope can be
    // narrowed in the middle of a shift, so a basket that kept accepting
    // writes because the scope had been checked once at open would be
    // authority outliving the decision that granted it. The warehouse comes
    // from `pos_till_sessions`, in the gate, on EVERY command.
    for (const command of POS_CART_COMMANDS) {
      authorized.length = 0;
      const plan = cartStatementPlan(command, target());
      await runPlan(seam(plan, 2), plan, command, target());
      expect(authorized, command).toHaveLength(1);
      expect(authorized[0]?.warehouseIds, command).toEqual([WAREHOUSE]);
    }
  });

  it('the three writing commands authorize under ONE op kind, and the removal under its own', async () => {
    // `pos_cart_set_line` is keyed by the line id and revises what is there,
    // so the add, the quantity change and the discount request are the same
    // authority over the same relation. `0079` registers exactly four kinds
    // and the cart uses two of them.
    const seen: Record<string, string> = {};
    for (const command of POS_CART_COMMANDS) {
      authorized.length = 0;
      const plan = cartStatementPlan(command, target());
      await runPlan(seam(plan, 1), plan, command, target());
      seen[command] = authorized[0]?.opCode ?? '';
    }
    expect(seen).toEqual({
      'cart.add_line': 'pos.cart_set_line',
      'cart.change_quantity': 'pos.cart_set_line',
      'cart.request_discount': 'pos.cart_set_line',
      'cart.remove_line': 'pos.cart_remove_line',
    });
  });

  it('the signed payload carries NO price field, and a different request signs a different digest', async () => {
    // The trust boundary, at the minting layer: there is no field a total, a
    // unit price, a tax or a rate could travel in, so a forged figure is not
    // refused here — it is INEXPRESSIBLE. The digest is asserted to MOVE with
    // the quantity, so "no price field" is not being proved by a constant.
    const digests = new Set<string>();
    for (const quantity of ['1', '2', '3']) {
      authorized.length = 0;
      const t = target({ quantity });
      const plan = cartStatementPlan('cart.add_line', t);
      await runPlan(seam(plan, 1), plan, 'cart.add_line', t);
      digests.add(authorized[0]?.payloadSha256 ?? '');
    }
    expect(digests.size).toBe(3);
    for (const d of digests) expect(d).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the authority is established BEFORE the assertion is minted, and the mint matches its kind', async () => {
    // `mint` refuses a payload whose op kind is not the authorized one, which
    // is the estate's own guard against signing one command with another's
    // authority. Asserted through the real ordering: the authority is pushed
    // by `authorize` and the digest is attached by `mint`, so a digest present
    // on the recorded authority proves the order.
    authorized.length = 0;
    const plan = cartStatementPlan('cart.remove_line', target());
    await runPlan(seam(plan, 1), plan, 'cart.remove_line', target());
    expect(authorized[0]?.opCode).toBe('pos.cart_remove_line');
    expect(authorized[0]?.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
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
      expect(await refusalOf(() => runPlan(sql, plan, 'cart.add_line', target())), code).toMatchObject({ code, status });
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
    const [gate] = cartStatementPlan('cart.add_line', target());
    expect(gate?.text).toContain(POS_CART_COLUMNS.sessions.owner);
    // The actor travels as a PARAMETER resolved from the membership, never
    // from a body: it is the fourth parameter of every cart GATE.
    for (const command of POS_CART_COMMANDS) {
      const [m] = cartStatementPlan(command, target());
      expect(m?.params[3], command).toBe(ACTOR);
    }
  });

  it('a line this basket does not hold is 404 `pos.cart_line_not_found`', async () => {
    const plan = cartStatementPlan('cart.change_quantity', target());
    // The gate says the session is usable and NO row with this id exists in it.
    // `line_present: '0'` is the 404; `written` no longer exists, because the
    // gate reports what the line IS rather than what a mutation touched.
    const missing = new RecordingCartSql(() => [{ ...USABLE, line_present: '0', line_removed: '0', line_no: null, product_id: null, variant_id: null }]);
    expect(await refusalOf(() => runPlan(missing, plan, 'cart.change_quantity', target()))).toMatchObject({
      code: 'pos.cart_line_not_found',
      status: 404,
    });
    expect(missing.issued).toHaveLength(1);
  });

  it('a discount without `sales.discount` is 403 `pos.cart_discount_not_permitted` — never silently zeroed', async () => {
    // P4-AL-35: SENSITIVE. The refusal is in the SERVICE because it depends on
    // the body and a decorator cannot see the body.
    const refusal = await refusalOf(() => service().requestDiscount(membership('sales.create'), TILL, LINE, '500', BTX));
    expect(refusal).toMatchObject({ code: 'pos.cart_discount_not_permitted', status: 403 });
    // A request of exactly ZERO needs the same key: setting a discount to zero
    // changes the price the cashier quoted just as surely as any other value.
    expect(await refusalOf(() => service().requestDiscount(membership('sales.create'), TILL, LINE, '0', BTX))).toMatchObject({
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
    const refusal = await refusalOf(() => service().requestDiscount(membership('sales.create', 'sales.discount'), TILL, LINE, '500', BTX));
    expect(refusal.code).toMatch(/took a database connection/);
  });

  it('an unpriced product is 422 and a mixed-currency basket is 422 — refused, never guessed', async () => {
    const plan = cartStatementPlan('cart.add_line', target());
    const unpriced = new RecordingCartSql((text) => (text === plan[0]?.text ? [USABLE] : [projectionRow(0, { unit_price_minor: null, price_currency: null })]));
    expect(await refusalOf(async () => service().recompute(TILL, await runPlan(unpriced, plan, 'cart.add_line', target()), 'SAR'))).toMatchObject({
      code: 'pos.cart_product_not_priced',
      status: 422,
    });
    const mixed = new RecordingCartSql((text) => (text === plan[0]?.text ? [USABLE] : [projectionRow(0), projectionRow(1, { price_currency: 'TRY' })]));
    expect(await refusalOf(async () => service().recompute(TILL, await runPlan(mixed, plan, 'cart.add_line', target()), 'SAR'))).toMatchObject({
      code: 'pos.cart_currency_mixed',
      status: 422,
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════
describe('§4 — a recognized internal invariant is a 500 with NO details', () => {
  it('a statement plan that is not three statements is 500, logged by name, with nothing in the body', async () => {
    // «Keep a recognized internal invariant at 500 with no details rather than
    // a merchant-facing 4xx»: a broken plan is a DEFECT and a merchant can do
    // nothing about it. 403 would say the cashier lacked authority; 409 would
    // say the till was in the wrong state. Both read as merchant outcomes, so
    // nobody looks at the server.
    logs.length = 0;
    const planted = [cartStatementPlan('cart.add_line', target())[0]] as never;
    let thrown: unknown;
    try {
      await runPlan(new RecordingCartSql(() => []), planted, 'cart.add_line', target());
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
      await runPlan(silent, plan, 'cart.add_line', target());
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
      const [, , projection] = cartStatementPlan('cart.add_line', target());
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
    const [, , projection] = cartStatementPlan('cart.add_line', target());
    await expect(pool.query(projection?.text ?? '', [...(projection?.params ?? [])])).resolves.toBeDefined();

    // ── The uniqueness `0079` ACTUALLY ships, read off `pg_index` ─────────
    // `pos_cart_lines_line_uq UNIQUE (business_id, till_session_id, line_no)`:
    // a TOTAL unique constraint on the ORDINAL. The basket is append-only and
    // ordinal-keyed, so this is the index `max(line_no) + 1` races against,
    // and it must NOT be partial — `0079` carries no `removed_at` and the
    // removal is a hard DELETE, which is what frees an ordinal for reuse.
    const { rows: indexes } = await pool.query<{ name: string; cols: string[]; partial: boolean; nulls_not_distinct: boolean }>(
      `SELECT ci.relname::text AS name,
              array_agg(a.attname::text ORDER BY k.ord) AS cols,
              i.indpred IS NOT NULL AS partial,
              i.indnullsnotdistinct AS nulls_not_distinct
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indrelid
         JOIN pg_class ci ON ci.oid = i.indexrelid
         CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
        WHERE c.relname = $1 AND i.indisunique
        GROUP BY ci.relname, i.indpred, i.indnullsnotdistinct`,
      [POS_CART_COLUMNS.lines.table],
    );
    const ordinal = indexes.find((row) => row.name === POS_CART_UNIQUE_CONSTRAINT);
    expect(ordinal, `0079 has no ${POS_CART_UNIQUE_CONSTRAINT}`).toBeDefined();
    expect([...(ordinal?.cols ?? [])]).toEqual([...POS_CART_UNIQUE_COLUMNS]);
    expect(
      ordinal?.partial,
      'the ordinal constraint is TOTAL: with tombstones that would hold every removed ordinal for ever, so a cashier could never reuse one',
    ).toBe(POS_CART_UNIQUE_IS_PARTIAL);
    // And the predicate is the tombstone's own, which is what frees the ordinal.
    const { rows: def } = await pool.query<{ d: string }>(`SELECT pg_get_indexdef($1::regclass) AS d`, [POS_CART_UNIQUE_CONSTRAINT]);
    expect(def[0]?.d).toContain(POS_CART_UNIQUE_PREDICATE);

    // There is NO unique index on the product identity, which is why the add
    // is an append: an upsert would raise 42P10 against this catalogue.
    const byProduct = indexes.find((row) => row.cols.includes('product_id') && row.cols.includes('variant_id'));
    expect(byProduct, 'a unique index on the product identity exists: the append-only ruling would need revisiting').toBeUndefined();

    // The TOMBSTONE column exists, and the live projection must exclude it.
    // An earlier revision of this suite asserted the opposite — no tombstone,
    // a total index — from a SUPERSEDED `0079`. Both assertions now read the
    // LIVE catalogue, which is the only reading that cannot go stale.
    expect([...actual], `${POS_CART_COLUMNS.lines.table} has no ${POS_CART_COLUMNS.lines.removedAt}`).toContain(POS_CART_COLUMNS.lines.removedAt);
    const [, , liveProjection] = cartStatementPlan('cart.add_line', target());
    expect(liveProjection?.text).toContain(`${POS_CART_COLUMNS.lines.removedAt} IS NULL`);

    // ── The writer protocol, which this slice now speaks ──────────────────
    // `0079` REVOKEs ALL on the cart from PUBLIC and grants `daftar_app`
    // SELECT only; every write belongs to `daftar_inventory_internal` and is
    // reachable solely through the SECURITY DEFINER routines
    // `pos_cart_set_line` / `pos_cart_remove_line`, each gated by an
    // `invctl/1` assertion. The plan is built on those routines for exactly
    // this reason, and the privilege is asserted rather than described so a
    // later revision cannot drift back to direct SQL and pass.
    const { rows: writers } = await pool.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.table_privileges
        WHERE table_name = $1 AND grantee = 'daftar_app' ORDER BY privilege_type`,
      [POS_CART_COLUMNS.lines.table],
    );
    expect(
      writers.map((r) => r.privilege_type),
      'daftar_app can write pos_cart_lines directly: re-check the writer protocol before trusting the mutation statements',
    ).toEqual(['SELECT']);
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
      // 201 on the append, 200 on the three that address an existing line.
      expect(route.status, route.command).toBe(route.command === 'cart.add_line' ? 201 : 200);
      expect(route.body).toBe(true);
    }
  });

  it('every route names a method that exists on the service \u2014 the mount cannot call a handler that is not there', () => {
    const service = new PosCartServiceType(noDatabase, authorization, logger);
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
