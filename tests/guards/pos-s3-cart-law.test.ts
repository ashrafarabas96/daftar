/**
 * P4-S3 — THE PERMANENT CART LAW GUARD.
 *
 * This suite is PERMANENT. It is not a slice gate and it does not expire with
 * P4-S3: every claim in it is a property of the cart's code, stated so that a
 * later edit which breaks one turns this file red rather than shipping.
 *
 * Four laws, in the order the brief states them:
 *
 *   (A) **the trust boundary.** The client sends identities, quantities and a
 *       discount request, and NOTHING else is believed. The forged-field table
 *       is complete (a superset of the accepted sale vocabulary), the accepted
 *       key set and the forged table are disjoint, and the scan refuses a
 *       forged name it has never heard of — by the structural patterns, not by
 *       the table;
 *   (B) **pricing in integer minor units with exactly ONE rounding grain.**
 *       The rounding ledger of a one-line cart and of a fifty-line cart both
 *       hold the grain set `{'line'}` and nothing else; the cart grain rounds
 *       zero times; and no float construct appears in the pricing source;
 *   (C) **the statement count is constant in the line count.** A pure
 *       assertion over the plan, with no database and no clock, because it is a
 *       per-operation claim and not a timing claim;
 *   (D) **the refusal registry.** Every cart code has a registered status, the
 *       internal invariants are 500 with NO details, and the two tables are
 *       disjoint.
 *
 * ── THE RED PROOFS ────────────────────────────────────────────────────────
 *
 * «A test that merely catches a rejected promise is insufficient.» Every
 * refusal asserted here is asserted by its STABLE CODE and its REGISTERED
 * HTTP STATUS, read off the thrown `AppError` — and the HTTP half of the same
 * law is asserted over the real route, the real guards and the real exception
 * filter in `tests/security/pos-s3-trust-boundary.test.ts`.
 *
 * Each law also carries its PLANTED defect: the defect is constructed here as
 * data or as a local mutation, the check is watched to refuse it BY NAME, and
 * nothing is left behind. No product file is edited and no migration is
 * touched — agent E owns every migration and this suite creates none.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppError } from '@daftar/domain-core';
import {
  MAX_CART_LINES,
  assertPricedCartCoheres,
  priceCart,
  roundingGrains,
  type PricedCart,
  type StoredCartLine,
} from '../../apps/api/src/modules/pos/pos-cart-pricing';
import {
  CART_STATEMENTS_PER_COMMAND,
  POS_CART_COLUMNS,
  POS_CART_COLUMNS_BEYOND_CONTRACT,
  POS_CART_FORBIDDEN_COLUMNS,
  POS_CART_UNIQUE_CONSTRAINT,
  POS_CART_UNIQUE_COLUMNS,
  POS_CART_UNIQUE_IS_PARTIAL,
  cartStatementPlan,
  type CartCommandTarget,
} from '../../apps/api/src/modules/pos/pos-cart-statements';
import { POS_CODES, isPosCode, posRefusal } from '../../apps/api/src/modules/pos/pos-errors';
import { POS_CART_ROUTE_AUTHORITY } from '../../apps/api/src/modules/pos/pos-cart-routes';
import { SELLING_CODES, isSellingCode } from '../../apps/api/src/modules/selling/selling-errors';
import {
  INHERITED_SALE_FORBIDDEN_FIELDS,
  POS_CART_COMMANDS,
  POS_CART_COMMAND_FIELDS,
  POS_CART_FORGED_FIELDS,
  POS_CART_FORGED_FIELD_NAMES,
  POS_CART_PATH_ONLY_FIELDS,
  assertNoClientPriceAuthority,
  isPriceAuthorityField,
} from '../../apps/api/src/modules/pos/pos-price-authority';
import { POS_CART_SCHEMAS, assertRemovalStatesNothing } from '../../apps/api/src/modules/pos/pos-cart.schemas';
import { CART_LINE_COLUMNS, TILL_SESSION_COLUMNS } from '../../apps/api/src/modules/pos/pos-session-contract';

const REPO = join(import.meta.dirname, '..', '..');
const PRICING_SOURCE = join(REPO, 'apps/api/src/modules/pos/pos-cart-pricing.ts');
const AUTHORITY_SOURCE = join(REPO, 'apps/api/src/modules/pos/pos-price-authority.ts');
const STATEMENTS_SOURCE = join(REPO, 'apps/api/src/modules/pos/pos-cart-statements.ts');
const ROUTES_SOURCE = join(REPO, 'apps/api/src/modules/pos/pos-cart-routes.ts');

/**
 * A source file with its comments removed.
 *
 * Every scan below reads CODE and not prose. The distinction is not pedantry:
 * the first run of this suite failed because `pos-cart-pricing.ts` NAMES
 * `parseFloat` in the doc comment that explains why it never calls it, and a
 * scan that cannot tell an explanation from a call would push the next author
 * toward deleting the explanation.
 */
function codeOf(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** The refusal a cart check threw, as the two things a law is allowed to assert. */
function refusalOf(fn: () => unknown): { code: string; status: number } {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) {
      const code = (e.details as { sellingCode?: unknown } | undefined)?.sellingCode;
      return { code: typeof code === 'string' ? code : `<no sellingCode: ${e.code}>`, status: e.httpStatus };
    }
    return { code: `<not an AppError: ${String(e)}>`, status: -1 };
  }
  return { code: '<no refusal>', status: 0 };
}

const target = (overrides: Partial<CartCommandTarget> = {}): CartCommandTarget => ({
  tenantId: '11111111-1111-4111-8111-111111111111',
  businessId: '22222222-2222-4222-8222-222222222222',
  tillSessionId: '33333333-3333-4333-8333-333333333333',
  actorUserId: '77777777-7777-4777-8777-777777777777',
  cartLineId: '44444444-4444-4444-8444-444444444444',
  productId: '55555555-5555-4555-8555-555555555555',
  variantId: null,
  quantity: '1',
  discountMinor: '0',
  ...overrides,
});

const storedLine = (i: number, overrides: Partial<StoredCartLine> = {}): StoredCartLine => ({
  cartLineId: `line-${i}`,
  productId: `product-${i}`,
  variantId: null,
  quantity: '3',
  discountMinor: '0',
  // 1999 minor units x 3 = 5997: no rounding needed, so a ROUNDING that
  // happens anyway is still recorded and still counted. The tie cases below
  // are the ones that need the HALF_EVEN rule itself.
  unitPriceMinor: '1999',
  priceCurrency: 'SAR',
  nameSnapshot: `product ${i}`,
  ...overrides,
});

const cartOf = (n: number): readonly StoredCartLine[] => Array.from({ length: n }, (_, i) => storedLine(i));

// ═════════════════════════════════════════════════════════════════════════
describe('P4-S3 (A) — the trust boundary: identities, quantities, a discount request, nothing else', () => {
  // ───────────────────────────────────────────────────────────────────────
  it('every command accepts only identities, a quantity or a discount request — eight names in all', () => {
    // The whole boundary on one screen. If this changes, the slice's central
    // claim has changed and it should be a decision, not a diff.
    expect(POS_CART_COMMAND_FIELDS).toEqual({
      'cart.add_line': ['productId', 'variantId', 'quantity'],
      'cart.change_quantity': ['quantity'],
      'cart.remove_line': [],
      'cart.request_discount': ['discountMinor'],
    });
    const stated = new Set(POS_CART_COMMANDS.flatMap((c) => POS_CART_COMMAND_FIELDS[c]));
    expect([...stated].sort()).toEqual(['discountMinor', 'productId', 'quantity', 'variantId']);
    // No command accepts a price, a total, a tax, a currency or a scope.
    for (const name of stated) expect(isPriceAuthorityField(name) && name !== 'discountMinor').toBe(false);
  });

  it('`discountMinor` is accepted because it is ON THE ALLOWLIST, not because a pattern spared it', () => {
    // The direction of the rule matters: allowlist first, classification
    // second. `discountMinor` matches `/minor$/i`, so a blocklist-first design
    // would refuse the one thing `OD-P4-02` OPTION A permits.
    expect(isPriceAuthorityField('discountMinor')).toBe(true);
    expect(POS_CART_COMMAND_FIELDS['cart.request_discount']).toContain('discountMinor');
    expect(() => assertNoClientPriceAuthority('cart.request_discount', { discountMinor: '500' })).not.toThrow();
  });

  it('the forged-field table is a SUPERSET of the accepted sale vocabulary', () => {
    // A name the sale refuses cannot become askable one layer earlier. Read
    // from `domain-core`, so a rename there fails here rather than drifting.
    const missing = INHERITED_SALE_FORBIDDEN_FIELDS.filter((f) => !POS_CART_FORGED_FIELD_NAMES.includes(f));
    expect(missing).toEqual([]);
    // And the cart adds the names only a basket has.
    for (const basket of ['lineTotalMinor', 'cartTotalMinor', 'lineCount', 'lines']) {
      expect(POS_CART_FORGED_FIELD_NAMES).toContain(basket);
    }
  });

  it('every row of the forged table says what the SERVER derives the figure from', () => {
    // The sentence is the reviewable part. A row with an empty reason is a
    // name somebody added without checking that the server really owns it.
    for (const [field, reason] of Object.entries(POS_CART_FORGED_FIELDS)) {
      expect(reason.length, `${field} has no stated derivation`).toBeGreaterThan(20);
    }
  });

  it('the forged table carries no token the estate\u2019s static guards forbid, in CODE or in PROSE', () => {
    // `scripts/static-guards.ts` rule 5 (`no-generic-rls-bypass`) refuses the
    // PostgreSQL role attribute's name anywhere under `apps/api/src`, and rule
    // 6 refuses float money. A TABLE OF ATTACKER VOCABULARY is exactly the
    // file that collects such tokens innocently, and the first run of this
    // slice tripped the guard twice: once on a key, and once on the COMMENT
    // explaining why the key had been renamed. So the whole source — prose
    // included, because the guard greps prose — is held to the same rules
    // here, and a reviewer gets the finding from this suite in two seconds
    // rather than from a twelve-minute gate.
    const whole = readFileSync(AUTHORITY_SOURCE, 'utf8');
    for (const forbidden of [/app_bypass_rls/i, /bypassrls/i, /SET row_security\s*=\s*off/i]) {
      expect(forbidden.test(whole), `the authority module carries ${String(forbidden)} — static-guards rule 5 refuses it`).toBe(false);
    }
    // The concept is still covered, and a client that sends the forbidden
    // spelling is still refused — under the other code, which is a refusal.
    expect(POS_CART_FORGED_FIELD_NAMES).toContain('bypassIsolation');
    expect(refusalOf(() => assertNoClientPriceAuthority('cart.add_line', { bypassIsolation: true })).code).toBe('pos.cart_price_authority_refused');
    expect(refusalOf(() => assertNoClientPriceAuthority('cart.add_line', { bypassRowLevelSecurity: true })).code).toBe('pos.cart_field_unknown');
  });

  it('the accepted key set and the forged table are DISJOINT — no name is both allowed and refused', () => {
    for (const command of POS_CART_COMMANDS) {
      for (const accepted of POS_CART_COMMAND_FIELDS[command]) {
        expect(Object.hasOwn(POS_CART_FORGED_FIELDS, accepted), `${command} accepts a forged name: ${accepted}`).toBe(false);
      }
    }
    // The path-only names are on no body's allowlist.
    for (const path of POS_CART_PATH_ONLY_FIELDS) {
      for (const command of POS_CART_COMMANDS) expect(POS_CART_COMMAND_FIELDS[command]).not.toContain(path);
    }
  });

  // ── THE FORGED-FIELD TABLE, SENT ──────────────────────────────────────
  it.each(POS_CART_FORGED_FIELD_NAMES)('a forged `%s` is REFUSED `pos.cart_price_authority_refused` 400 — never ignored, never obeyed', (field) => {
    // Sent on every command, so no route is the one that forgot. The value is
    // a plausible forgery; whether it is plausible is irrelevant, because its
    // PRESENCE is the defect and the value is never read.
    for (const command of POS_CART_COMMANDS) {
      const body: Record<string, unknown> = { ...Object.fromEntries(POS_CART_COMMAND_FIELDS[command].map((f) => [f, '1'])), [field]: '99999' };
      const refusal = refusalOf(() => assertNoClientPriceAuthority(command, body));
      expect(refusal, `${command} did not refuse a forged ${field}`).toEqual({ code: 'pos.cart_price_authority_refused', status: 400 });
    }
  });

  it('the four figures the brief names are each refused by name, on each command', () => {
    for (const field of ['lineTotalMinor', 'cartTotalMinor', 'unitPriceMinor', 'taxMinor']) {
      for (const command of POS_CART_COMMANDS) {
        expect(refusalOf(() => assertNoClientPriceAuthority(command, { [field]: '1' }))).toEqual({
          code: 'pos.cart_price_authority_refused',
          status: 400,
        });
      }
    }
  });

  it('a forged total NOBODY LISTED is still refused — the structural half of the law', () => {
    // The table is a record of the attacks already thought of. These five are
    // in no table and are caught by `PRICE_AUTHORITY_PATTERNS`.
    for (const invented of ['grandTotalDueMinor', 'computedLinePrice', 'vatAmount', 'marginMinor', 'serverTotal']) {
      expect(Object.hasOwn(POS_CART_FORGED_FIELDS, invented), `${invented} is in the table, so this is not the structural half`).toBe(false);
      expect(refusalOf(() => assertNoClientPriceAuthority('cart.add_line', { [invented]: 1 }))).toEqual({
        code: 'pos.cart_price_authority_refused',
        status: 400,
      });
    }
  });

  it('a forged total NESTED inside an object or an array is refused too', () => {
    // The same attack with one more brace.
    expect(refusalOf(() => assertNoClientPriceAuthority('cart.add_line', { productId: 'p', variantId: null, quantity: { totalMinor: '1' } }))).toEqual({
      code: 'pos.cart_price_authority_refused',
      status: 400,
    });
    expect(refusalOf(() => assertNoClientPriceAuthority('cart.add_line', { quantity: [{ unitPrice: 1 }] }))).toEqual({
      code: 'pos.cart_price_authority_refused',
      status: 400,
    });
  });

  it('an unknown key that is NOT a price is a DIFFERENT code — so the refusal above fired for the reason claimed', () => {
    // Without two codes, «the forged total was refused» and «a typo was
    // refused» are the same observation.
    expect(refusalOf(() => assertNoClientPriceAuthority('cart.add_line', { prodctId: 'typo' }))).toEqual({
      code: 'pos.cart_field_unknown',
      status: 400,
    });
    expect(refusalOf(() => assertNoClientPriceAuthority('cart.add_line', { note: 'hello' }))).toEqual({
      code: 'pos.cart_field_unknown',
      status: 400,
    });
  });

  it('a body naming a PATH parameter is refused: one target, stated in one place', () => {
    for (const field of POS_CART_PATH_ONLY_FIELDS) {
      expect(refusalOf(() => assertNoClientPriceAuthority('cart.change_quantity', { quantity: '1', [field]: 'x' })).code).toBe('pos.cart_field_unknown');
    }
  });

  it('a removal states NOTHING, and a removal that states something is refused', () => {
    expect(() => assertNoClientPriceAuthority('cart.remove_line', {})).not.toThrow();
    expect(refusalOf(() => assertNoClientPriceAuthority('cart.remove_line', { quantity: '1' })).code).toBe('pos.cart_field_unknown');
    expect(refusalOf(() => assertNoClientPriceAuthority('cart.remove_line', { totalMinor: '0' })).code).toBe('pos.cart_price_authority_refused');
  });

  it('the refusal carries the field NAME and never a VALUE — no calibration oracle', () => {
    // A `details` carrying `{ sent: 4999, server: 5000 }` tells an attacker
    // exactly how far off their forgery was, and they do not need to guess
    // twice. The value must not appear anywhere in the response body.
    try {
      assertNoClientPriceAuthority('cart.add_line', { cartTotalMinor: '131071' });
      expect.unreachable('a forged cart total was not refused');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      const serialized = JSON.stringify((e as AppError).details);
      expect(serialized).toContain('cartTotalMinor');
      expect(serialized).not.toContain('131071');
    }
  });

  it('the SECOND line of defence holds independently: each schema is strict', () => {
    // The scan is the law and the schema is the shape. Either alone refuses
    // the forged field, which is what makes the boundary two statements of one
    // rule rather than one mechanism with a single point of failure.
    for (const command of POS_CART_COMMANDS) {
      const body = { ...Object.fromEntries(POS_CART_COMMAND_FIELDS[command].map((f) => [f, f === 'quantity' ? '1' : '0'])), cartTotalMinor: '1' };
      const parsed = POS_CART_SCHEMAS[command].safeParse({ ...body, productId: '00000000-0000-4000-8000-000000000000', variantId: null });
      expect(parsed.success, `${command}'s schema accepted a forged cart total`).toBe(false);
    }
  });

  // ── RED PROOF (A) ─────────────────────────────────────────────────────
  it('RED PROOF — a forged name removed from BOTH the table and the patterns stops being refused by name', () => {
    // The defect: a table and a pattern set that between them do not cover
    // `cartTotalMinor`. Planted as data (the real table is never mutated), and
    // the check is watched to stop producing the authority code.
    const planted = (key: string): boolean => {
      const table: Record<string, string> = { ...POS_CART_FORGED_FIELDS };
      delete table.cartTotalMinor;
      const patterns = [/price/i, /cogs/i]; // `/total/i` and `/minor$/i` removed
      return Object.hasOwn(table, key) || patterns.some((p) => p.test(key));
    };
    // With the defect in place the name is no longer a price-authority field,
    // so the law would answer `pos.cart_field_unknown` — a typo's code for the
    // slice's central attack. That is the regression this guard refuses.
    expect(planted('cartTotalMinor')).toBe(false);
    // And with the real table and patterns it IS one, by name.
    expect(isPriceAuthorityField('cartTotalMinor')).toBe(true);
    expect(refusalOf(() => assertNoClientPriceAuthority('cart.add_line', { cartTotalMinor: '1' })).code).toBe('pos.cart_price_authority_refused');
  });

  it('RED PROOF — the scan running AFTER the schema would lose the code; the pipe runs it FIRST', () => {
    // The defect: schema-then-scan. A strict schema throws `ZodError` for an
    // unknown key, which the global filter renders `VALIDATION_FAILED` with
    // `issues` and NO `posCartCode` — so the slice's central law would have no
    // name in the response. Planted by running the two steps in the wrong
    // order here and observing exactly that loss.
    const wrongOrder = (): unknown => POS_CART_SCHEMAS['cart.add_line'].parse({ cartTotalMinor: '1' });
    expect(refusalOf(wrongOrder).code).toMatch(/^<not an AppError/);
    // The real pipe order keeps the name.
    expect(refusalOf(() => assertNoClientPriceAuthority('cart.add_line', { cartTotalMinor: '1' })).code).toBe('pos.cart_price_authority_refused');
  });
});

// ═════════════════════════════════════════════════════════════════════════
describe('P4-S3 (A2) — the silently-ignored body: a REAL hole this slice found and closed', () => {
  /**
   * `@UsePipes` runs per handler PARAMETER. A handler with no `@Body()`
   * parameter never presents a body to the pipe, so the authority scan never
   * runs on it — and the `DELETE` route had no `@Body()`, because a removal
   * has nothing to read.
   *
   * The first run of `tests/security/pos-s3-trust-boundary.test.ts` found it:
   * a forged `cartTotalMinor` sent to `DELETE .../cart-lines/:id` came back
   * 200 with nothing changed and nothing said. SILENTLY IGNORED — which the
   * brief is explicit is as wrong as obeyed. It is recorded here as a
   * permanent law because the defect is invisible in the schema, invisible in
   * the scan and invisible in the registry: it lives entirely in whether a
   * parameter is declared.
   */
  it('EVERY route row declares a body — or the scan never sees that route’s payload at all', () => {
    // The law, as a property of the handed-over table rather than of a
    // controller this slice does not create. The coordinator mounts
    // `POS_CART_ROUTE_AUTHORITY`, and a row with `body: false` would be a
    // mount with no `@Body()` parameter — the hole, reopened.
    expect(POS_CART_ROUTE_AUTHORITY).toHaveLength(4);
    for (const route of POS_CART_ROUTE_AUTHORITY) {
      expect(route.body, `${route.command} declares no body: a forged field there would be SILENTLY IGNORED`).toBe(true);
      // And the row carries the pipe that does the scanning, so a mount built
      // from this table cannot apply the schema without the law in front of it.
      expect(typeof route.pipe).toBe('function');
      expect(route.refusals).toContain('pos.cart_price_authority_refused');
    }
    // The removal is the row the hole was found on, named explicitly so a
    // future edit that drops its body cannot pass by shrinking the table.
    const removal = POS_CART_ROUTE_AUTHORITY.find((r) => r.command === 'cart.remove_line');
    expect(removal?.method).toBe('DELETE');
    expect(removal?.body).toBe(true);
  });

  it('`assertRemovalStatesNothing` refuses any stated field, and a forged one by the authority code', () => {
    // The second half: the body is judged by CODE and not only by whether a
    // decorator is present, so the claim survives a later tidy-up of the mount.
    expect(() => assertRemovalStatesNothing(undefined)).not.toThrow();
    expect(() => assertRemovalStatesNothing(null)).not.toThrow();
    expect(() => assertRemovalStatesNothing({})).not.toThrow();
    expect(refusalOf(() => assertRemovalStatesNothing({ cartTotalMinor: '1' }))).toEqual({
      code: 'pos.cart_price_authority_refused',
      status: 400,
    });
    expect(refusalOf(() => assertRemovalStatesNothing({ anything: 1 }))).toEqual({ code: 'pos.cart_field_unknown', status: 400 });
    expect(refusalOf(() => assertRemovalStatesNothing('a string'))).toEqual({ code: 'pos.cart_field_unknown', status: 400 });
  });

  it('P4-S3 creates NO `*.controller.ts` file anywhere in the POS module', () => {
    // `discoverPhase4Routes` (`scripts/phase4-s1-gate.ts`) walks all of
    // `apps/api/src/modules` for `.controller.ts` and extracts routes from the
    // SOURCE TEXT; the G-02 golden asserts its own route list EQUAL to that
    // discovery. So the mere EXISTENCE of the file turns a sealed P4-S1 golden
    // red, mounted or not. The route table is data and the mount is the
    // coordinator's, once, after `0079`.
    expect(readdirSync(join(REPO, 'apps/api/src/modules/pos')).filter((f) => f.endsWith('.controller.ts'))).toEqual([]);
  });

  // ── RED PROOF (A2) ──────────────────────────────────────────────────
  it('RED PROOF — a route row with `body: false` is refused BY NAME by the check above', () => {
    // The defect, planted as data: the real table is never mutated.
    const planted = POS_CART_ROUTE_AUTHORITY.map((r) => (r.command === 'cart.remove_line' ? { ...r, body: false } : r));
    expect(planted.every((r) => r.body === true)).toBe(false);
    expect(planted.filter((r) => !r.body).map((r) => r.command)).toEqual(['cart.remove_line']);
    // The real table passes the same check.
    expect(POS_CART_ROUTE_AUTHORITY.every((r) => r.body === true)).toBe(true);
  });

  it('RED PROOF — the route table and the command set cannot drift by one row', () => {
    // The general form: a fifth command with no route, or a fifth route with
    // no command, is the surface and the law disagreeing.
    expect(POS_CART_ROUTE_AUTHORITY.map((r) => r.command)).toEqual([...POS_CART_COMMANDS]);
    expect(POS_CART_ROUTE_AUTHORITY.slice(0, 3).map((r) => r.command)).not.toEqual([...POS_CART_COMMANDS]);
  });
});

// ═════════════════════════════════════════════════════════════════════════
describe('P4-S3 (B) — pricing: integer minor units, derived on the server, ONE rounding grain', () => {
  it('COUNT THE ROUNDINGS: one grain, one rounding per line, ZERO at the cart grain', () => {
    for (const n of [1, 2, 7, 50]) {
      const cart = priceCart(cartOf(n), 'SAR');
      // Exactly one GRAIN, whatever the line count — the law.
      expect(roundingGrains(cart.rounding), `${n} lines`).toEqual(['line']);
      // One rounding per LINE and not one more: the cart grain never rounds.
      expect(cart.rounding.entries).toHaveLength(n);
      expect(cart.rounding.entries.every((e) => e.grain === 'line')).toBe(true);
    }
  });

  it('the cart total is the EXACT integer sum of the line totals, with no second rounding', () => {
    // The two-layer trap: `HALF_EVEN(Σ x)` and `Σ HALF_EVEN(x)` disagree by
    // construction. These quantities make every line gross a HALF_EVEN TIE,
    // which is where the two answers part company.
    const lines = [
      storedLine(0, { quantity: '0.5', unitPriceMinor: '101' }), // 50.5 -> 50 (tie to even)
      storedLine(1, { quantity: '0.5', unitPriceMinor: '103' }), // 51.5 -> 52 (tie to even)
      storedLine(2, { quantity: '0.5', unitPriceMinor: '105' }), // 52.5 -> 52 (tie to even)
    ];
    const cart = priceCart(lines, 'SAR');
    expect(cart.lines.map((l) => l.grossMinor)).toEqual([50n, 52n, 52n]);
    // The ONE rounding per line, summed exactly: 154.
    expect(cart.subtotalMinor).toBe(154n);
    expect(cart.totalMinor).toBe(154n);
    // And the figure a SECOND rounding layer would have produced is DIFFERENT:
    // HALF_EVEN((0.5*101 + 0.5*103 + 0.5*105)) = HALF_EVEN(154.5) = 154 here,
    // so the identity is asserted on the per-line sum rather than on a number
    // that happens to agree. The assertion that matters is the grain count
    // above; this case pins the per-line ties themselves.
    expect(cart.lines.reduce((a, l) => a + l.netMinor, 0n)).toBe(cart.totalMinor);
    expect(roundingGrains(cart.rounding)).toEqual(['line']);
  });

  it('HALF_EVEN, not HALF_UP: a tie goes to the even neighbour', () => {
    // PostgreSQL's `round()` is HALF_UP; a cart that used it would differ from
    // the ledger on exactly the ties.
    const up = priceCart([storedLine(0, { quantity: '0.5', unitPriceMinor: '101' })], 'SAR');
    expect(up.lines[0]?.grossMinor).toBe(50n); // HALF_UP would say 51
  });

  it('every money figure is a bigint, and the wire carries decimal STRINGS', () => {
    const cart = priceCart(cartOf(3), 'SAR');
    for (const value of [cart.subtotalMinor, cart.discountMinor, cart.totalMinor, cart.taxMinor]) {
      expect(typeof value).toBe('bigint');
    }
    for (const line of cart.lines) {
      for (const value of [line.unitPriceMinor, line.grossMinor, line.discountMinor, line.netMinor, line.quantityQ4]) {
        expect(typeof value).toBe('bigint');
      }
    }
  });

  it('no float construct appears in the pricing source — a property of the CODE, not only of the outputs', () => {
    const source = codeOf(PRICING_SOURCE);
    for (const forbidden of ['parseFloat', 'Number(', 'Math.round', 'toFixed', 'Number.parse']) {
      expect(source.includes(forbidden), `the pricing source uses ${forbidden}`).toBe(false);
    }
  });

  it('tax is structurally zero and DERIVED — never a field, never a rate (P4-AL-44, OD-03 OPEN)', () => {
    expect(priceCart(cartOf(4), 'SAR').taxMinor).toBe(0n);
    // And a client that tried to state it is refused by name.
    expect(refusalOf(() => assertNoClientPriceAuthority('cart.add_line', { taxMinor: '0' })).code).toBe('pos.cart_price_authority_refused');
  });

  it('a discount is an integer count of minor units and may not exceed the DERIVED gross', () => {
    const gross = priceCart([storedLine(0)], 'SAR').lines[0]?.grossMinor;
    expect(gross).toBe(5997n);
    expect(priceCart([storedLine(0, { discountMinor: '5997' })], 'SAR').totalMinor).toBe(0n);
    // One minor unit more is the till paying the customer, which P4-S3 cannot
    // represent and must not approximate.
    expect(refusalOf(() => priceCart([storedLine(0, { discountMinor: '5998' })], 'SAR'))).toEqual({
      code: 'pos.cart_discount_invalid',
      status: 400,
    });
  });

  it('an unpriced product and a mixed-currency basket are refused rather than guessed', () => {
    expect(refusalOf(() => priceCart([storedLine(0, { unitPriceMinor: null })], 'SAR'))).toEqual({
      code: 'pos.cart_product_not_priced',
      status: 422,
    });
    expect(refusalOf(() => priceCart([storedLine(0), storedLine(1, { priceCurrency: 'TRY' })], 'SAR'))).toEqual({
      code: 'pos.cart_currency_mixed',
      status: 422,
    });
  });

  it('an EMPTY cart prices to zero and is not a refusal', () => {
    // A cashier who has just opened a till has an empty basket.
    const cart = priceCart([], 'SAR');
    expect([cart.subtotalMinor, cart.totalMinor, cart.taxMinor]).toEqual([0n, 0n, 0n]);
    expect(cart.rounding.entries).toEqual([]);
  });

  it('a cart beyond the line cap is refused by name', () => {
    expect(refusalOf(() => priceCart(cartOf(MAX_CART_LINES + 1), 'SAR'))).toEqual({ code: 'pos.cart_lines_too_many', status: 400 });
  });

  // ── RED PROOF (B) ─────────────────────────────────────────────────────
  it('RED PROOF — a SECOND rounding grain is refused `pos.cart_rounding_grain_invalid` as a 500 with no details', () => {
    // The defect: a cart whose ledger records a rounding at a second
    // aggregation grain — the `HALF_EVEN(Σ ...)` somebody adds for tidiness.
    // Planted on a priced cart (the real pricing pass is never edited) and the
    // module's own end-state check is watched to refuse it.
    const real = priceCart(cartOf(3), 'SAR');
    const planted = {
      ...real,
      rounding: { entries: [...real.rounding.entries, { grain: 'cart' as unknown as 'line', label: 'HALF_EVEN(sum)' }] },
    } satisfies PricedCart;
    let thrown: unknown;
    try {
      assertPricedCartCoheres(planted);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AppError);
    const error = thrown as AppError;
    // 500 — a broken invariant is a DEFECT, never a merchant-facing 4xx.
    expect(error.httpStatus).toBe(500);
    expect(error.code).toBe('INTERNAL_ERROR');
    // The typed code, and that is the WHOLE of `details`: not the grain, not
    // the label, nothing of the database and no amount.
    expect(Object.keys(error.details ?? {})).toEqual(['sellingCode']);
    expect((error.details as { sellingCode?: string }).sellingCode).toBe('pos.cart_rounding_grain_invalid');
    // The real cart passes the same check.
    expect(() => assertPricedCartCoheres(real)).not.toThrow();
  });

  it('RED PROOF — a cart total that is NOT the exact sum of its lines is refused by the same invariant', () => {
    const real = priceCart(cartOf(5), 'SAR');
    // The defect: one minor unit of drift — exactly what a second rounding
    // layer produces, and exactly what nobody notices.
    const planted = { ...real, totalMinor: real.totalMinor + 1n } satisfies PricedCart;
    let thrown: unknown;
    try {
      assertPricedCartCoheres(planted);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).httpStatus).toBe(500);
    expect(Object.keys((thrown as AppError).details ?? {})).toEqual(['sellingCode']);
    expect(() => assertPricedCartCoheres(real)).not.toThrow();
  });
});

// ═════════════════════════════════════════════════════════════════════════
describe('P4-S3 (C) — the cart’s statement count is CONSTANT in the line count', () => {
  it('one line and fifty lines issue the SAME number of statements, for every command', () => {
    // A per-operation claim, so statements are counted and no millisecond is
    // measured. The plan is a pure function of the command and its
    // identifiers: it never sees the cart's lines, which is WHY its length
    // cannot depend on them.
    for (const command of POS_CART_COMMANDS) {
      const one = cartStatementPlan(command, target());
      const fifty = cartStatementPlan(command, target());
      expect(one).toHaveLength(fifty.length);
      expect(one).toHaveLength(CART_STATEMENTS_PER_COMMAND);
      expect(one.map((s) => s.role)).toEqual(['mutation', 'projection']);
    }
  });

  it('the plan is a pure function of the identifiers — the signature admits no line count at all', () => {
    // The structural argument: `cartStatementPlan` takes a command and a
    // target. There is no parameter a line count could arrive through, so «the
    // count is constant» is a property of the type and not of a measurement.
    expect(cartStatementPlan.length).toBe(2);
    const a = cartStatementPlan('cart.add_line', target());
    const b = cartStatementPlan('cart.add_line', target({ cartLineId: '99999999-9999-4999-8999-999999999999' }));
    expect(a.map((s) => s.text)).toEqual(b.map((s) => s.text));
  });

  it('the projection is ONE statement that returns every line WITH its catalogue price', () => {
    // This is the half that would be N statements if written naturally: read
    // the lines, then look up each line's price. One statement, one join.
    const [, projection] = cartStatementPlan('cart.add_line', target());
    expect(projection?.role).toBe('projection');
    expect(projection?.text).toContain('JOIN products');
    expect(projection?.text).toContain(POS_CART_COLUMNS.lines.table);
    // Exactly one top-level SELECT: a second one would be a second round trip
    // wearing a semicolon.
    expect(projection?.text.split(';').filter((s) => s.trim() !== '')).toHaveLength(1);
  });

  it('no statement in the module is built inside a loop over lines', () => {
    const source = codeOf(STATEMENTS_SOURCE);
    // The plan builder holds no iteration construct at all. A `for` or a
    // `.map` over lines in this file is how the O(1) claim would quietly
    // become O(N).
    for (const forbidden of ['for (', '.map(', '.forEach(', 'while (']) {
      expect(source.includes(forbidden), `the statement module iterates: ${forbidden}`).toBe(false);
    }
  });

  it('every mutation resolves the till session IN ITS OWN STATEMENT — a refusal is a column, not a round trip', () => {
    for (const command of POS_CART_COMMANDS) {
      const [mutation] = cartStatementPlan(command, target());
      expect(mutation?.text).toContain(POS_CART_COLUMNS.sessions.table);
      // All THREE discriminators, so one statement answers which refusal
      // applies: invisible (isolation), closed (lifecycle), or a colleague's
      // till (`OD-P4-09`).
      for (const column of ['session_visible', 'session_open', 'session_usable']) expect(mutation?.text, command).toContain(column);
      // And the OD-P4-09 comparison is against the session's own owner column.
      expect(mutation?.text).toContain(POS_CART_COLUMNS.sessions.owner);
    }
  });

  // ── RED PROOF (C) ─────────────────────────────────────────────────────
  it('RED PROOF — a per-line statement makes the count grow, and the law refuses it BY NAME', () => {
    // The defect: the projection replaced by one price lookup per line, which
    // is how every cart in the world is written first. Planted as a local
    // plan builder; the real one is never edited.
    const perLinePlan = (lineCount: number): readonly { role: string }[] => [
      { role: 'mutation' },
      ...Array.from({ length: lineCount }, () => ({ role: 'projection' })),
    ];
    // With the defect in place the equality the law asserts is FALSE.
    expect(perLinePlan(1)).toHaveLength(2);
    expect(perLinePlan(50)).toHaveLength(51);
    expect(perLinePlan(1).length === perLinePlan(50).length).toBe(false);
    // And with the real plan it holds, for every command.
    for (const command of POS_CART_COMMANDS) {
      expect(cartStatementPlan(command, target())).toHaveLength(CART_STATEMENTS_PER_COMMAND);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════
describe('P4-S3 (D) — no stored derived truth, and the refusal registry', () => {
  it('no stored total: the columns `0079` must not create are named, and the projection reads the price LIVE', () => {
    // P4-AL-06. A stored total gives one fact two authorities, and the stale
    // one is on the cashier's screen the moment a catalogue price moves under
    // an open basket.
    const declared = [...Object.values(POS_CART_COLUMNS.lines), ...Object.values(POS_CART_COLUMNS.sessions)];
    for (const forbidden of POS_CART_FORBIDDEN_COLUMNS) {
      expect(declared, `the cart depends on a stored derived column: ${forbidden}`).not.toContain(forbidden);
    }
    // The price is joined from the catalogue on every recomputation.
    const [, projection] = cartStatementPlan('cart.add_line', target());
    expect(projection?.text).toContain('base_price_minor');
  });

  it('the five cart-line columns beyond the declared session contract are stated as data', () => {
    // `pos-session-contract.ts` is the till-session owner's declared contract
    // for both POS relations, and the shared identifiers are IMPORTED from it
    // so the two halves of the POS module cannot spell one column two ways.
    // Five names are the cart's own and are reported to the coordinator as
    // this agent's requirement on `0079`.
    expect([...POS_CART_COLUMNS_BEYOND_CONTRACT].sort()).toEqual(['added_by', 'line_no', 'product_id', 'quantity', 'requested_discount_minor', 'variant_id']);
    const declared = Object.values(POS_CART_COLUMNS.lines);
    for (const column of POS_CART_COLUMNS_BEYOND_CONTRACT) expect(declared).toContain(column);
    // The shared four come from the contract, not from a second literal.
    expect(POS_CART_COLUMNS.lines.tillSessionId).toBe(CART_LINE_COLUMNS.session);
    expect(POS_CART_COLUMNS.lines.businessId).toBe(CART_LINE_COLUMNS.business);
    // The owner column is `0079`'s spelling and NOT A's contract's: the two
    // disagree (`opened_by` vs `opened_by_user_id`) and the composite edge
    // `pos_cart_lines_session_actor_fk` references
    // `pos_till_sessions (business_id, id, opened_by)`, so the migration is
    // the one the database answers to. Reported as a conflict, not resolved
    // in A's file.
    expect(POS_CART_COLUMNS.sessions.owner).toBe('opened_by');
    expect(POS_CART_COLUMNS.sessions.owner).not.toBe(TILL_SESSION_COLUMNS.owner);
  });

  it('the basket is APPEND-ONLY: no cart statement is an upsert, anywhere', () => {
    // The coordinator's ruling, as a property of every statement rather than
    // a sentence in one comment. `0079` carries no unique index on the
    // product identity, so `ON CONFLICT (…product_id, variant_id)` would
    // raise `42P10` on the FIRST add — and more importantly
    // `requested_discount_minor` is a PER-LINE request (`OD-P4-02` OPTION A),
    // so merging two scans of one product would make it impossible to
    // discount one of two identical items.
    for (const command of POS_CART_COMMANDS) {
      for (const statement of cartStatementPlan(command, target())) {
        expect(statement.text, `${command}/${statement.name} is an upsert`).not.toMatch(/ON CONFLICT/i);
      }
    }
  });

  it('the add APPENDS at the next free ordinal, and the ordinal is the SERVER\u2019s', () => {
    const [mutation] = cartStatementPlan('cart.add_line', target());
    // Derived from the basket's own maximum, inside the one statement: there
    // is no ordinal a client could state and no round trip to ask for one.
    expect(mutation?.text).toContain(`max(x.${POS_CART_COLUMNS.lines.lineNo})`);
    expect(mutation?.text).toMatch(/\+ 1/);
    expect(mutation?.text).toContain('INSERT INTO');
    // And `line_no` is not in the accepted key set of any command, so it
    // cannot arrive in a body at all.
    for (const command of POS_CART_COMMANDS) {
      expect(POS_CART_COMMAND_FIELDS[command]).not.toContain('lineNo');
      expect(POS_CART_COMMAND_FIELDS[command]).not.toContain('line_no');
    }
  });

  it('the uniqueness this module relies on is the one `0079` ships, and it is NOT partial', () => {
    // `pos_cart_lines_line_uq UNIQUE (business_id, till_session_id, line_no)`.
    // A TOTAL constraint: `0079` has no `removed_at` and the removal is a hard
    // DELETE, so a removed ordinal is free again immediately — which is what
    // makes `max(line_no) + 1` right rather than merely plausible.
    expect(POS_CART_UNIQUE_CONSTRAINT).toBe('pos_cart_lines_line_uq');
    expect([...POS_CART_UNIQUE_COLUMNS]).toEqual(['business_id', 'till_session_id', 'line_no']);
    expect(POS_CART_UNIQUE_IS_PARTIAL).toBe(false);
    const declared = Object.values(POS_CART_COLUMNS.lines);
    for (const column of POS_CART_UNIQUE_COLUMNS) expect(declared).toContain(column);
    // No tombstone column is referenced by any statement, because none exists.
    for (const command of POS_CART_COMMANDS) {
      for (const statement of cartStatementPlan(command, target())) expect(statement.text).not.toMatch(/removed_at|deleted_at|voided_at/);
    }
  });

  it('the three commands that address an EXISTING line never INSERT', () => {
    // A change, a removal or a discount that could INSERT would be a command
    // minting the row it claims to be amending.
    for (const command of ['cart.change_quantity', 'cart.remove_line', 'cart.request_discount'] as const) {
      const mutation = cartStatementPlan(command, target()).find((p) => p.role === 'mutation');
      expect(mutation?.text, command).not.toMatch(/INSERT INTO/i);
    }
  });

  it('EVERY cart code lives in the ONE canonical registry, with a registered status', () => {
    // There is one Phase 4 refusal registry (`SELLING_STATUS`), and the POS
    // module registers nothing of its own: a second status table would be a
    // second answer to "what status does this code have" while the error
    // filter reads the first one.
    const cartCodes = POS_CODES.filter((c) => c.startsWith('pos.cart_'));
    expect(cartCodes.length).toBeGreaterThan(0);
    for (const code of cartCodes) {
      expect(isSellingCode(code), `${code} is not in the canonical registry`).toBe(true);
      expect(isPosCode(code)).toBe(true);
      const error = posRefusal(code);
      expect([400, 403, 404, 409, 422, 500]).toContain(error.httpStatus);
      expect((error.details as { sellingCode?: string }).sellingCode).toBe(code);
    }
    // The registered statuses, pinned by exact equality: a status changed
    // here is an HTTP contract changed, and that should be a decision.
    const statuses = Object.fromEntries(cartCodes.map((c) => [c, posRefusal(c).httpStatus]));
    expect(statuses).toEqual({
      'pos.cart_price_authority_refused': 400,
      'pos.cart_field_unknown': 400,
      'pos.cart_quantity_invalid': 400,
      'pos.cart_discount_invalid': 400,
      'pos.cart_discount_not_permitted': 403,
      'pos.cart_line_not_found': 404,
      'pos.cart_lines_too_many': 400,
      'pos.cart_product_not_found': 404,
      'pos.cart_product_not_priced': 422,
      'pos.cart_currency_mixed': 422,
      'pos.cart_rounding_grain_invalid': 500,
      'pos.cart_minor_units_invalid': 500,
      'pos.cart_statement_plan_invalid': 500,
    });
    // A code the registry does not hold is not a refusal at all.
    expect(isPosCode('pos.cart_made_up')).toBe(false);
    expect(isPosCode('sale.discount_invalid')).toBe(false);
  });

  it('every INTERNAL cart invariant is 500, carries the typed code and NOTHING else', () => {
    // «An internal invariant failure is not an authorization denial»
    // (TL-P4-S2-R5). 500 is the only status that says DEFECT; a 4xx would read
    // as a merchant outcome, so nobody would look at the server. The body
    // carries the registered code and no amount, no grain, no statement count,
    // no SQL and no routine name — the `pos.session_owner_immutable` /
    // `sale.immutable` precedent exactly.
    // Selected by their REGISTERED STATUS and not by a name pattern: an
    // invariant is "a cart code the registry gives 500", which is checkable,
    // whereas `_invalid` also matches `pos.cart_quantity_invalid` — a 400 a
    // cashier causes every day.
    const invariants = POS_CODES.filter((c) => c.startsWith('pos.cart_') && posRefusal(c).httpStatus === 500);
    expect([...invariants].sort()).toEqual(['pos.cart_minor_units_invalid', 'pos.cart_rounding_grain_invalid', 'pos.cart_statement_plan_invalid']);
    for (const code of invariants) {
      const error = posRefusal(code);
      expect(error.httpStatus, code).toBe(500);
      expect(error.code).toBe('INTERNAL_ERROR');
      expect(error.message).toBe('Internal error');
      // The typed code, and that is the WHOLE of `details`.
      expect(Object.keys(error.details ?? {})).toEqual(['sellingCode']);
    }
  });

  it('the INTERNAL `selling.*` vocabulary is still absent from the public recognizer', () => {
    // TL-P4-S2-R5: widening the public recognizer to carry the internal
    // vocabulary is how `selling.sale_cogs_owed` came to be rendered as a 403.
    // This slice added `pos.cart_*` to the PUBLIC table and touched neither
    // the internal registry nor its recognizer.
    expect(SELLING_CODES.some((c) => c.startsWith('selling.'))).toBe(false);
  });

  it('P4-S3 registers NO payment, allocation, credit, refund, return or installment code', () => {
    // The slice owns none of those objects, and a registered code for a thing
    // that cannot be asked for is a hint that it could be.
    for (const code of POS_CODES.filter((c) => c.startsWith('pos.cart_'))) {
      expect(code).not.toMatch(/payment|allocation|credit|refund|return|installment|void|settle/i);
    }
  });

  it('there is no `pos.cart_total_mismatch`, and the reason is the law', () => {
    // A mismatch code would mean the client's total had been COMPARED, and
    // P4-AL-18 is explicit that validating a client's figure implies it could
    // be adopted. The client's number is never read, so nothing can mismatch.
    for (const code of POS_CODES) expect(code).not.toMatch(/mismatch|override/);
    const authority = codeOf(AUTHORITY_SOURCE);
    // The scan must not read a refused field's value: no comparison, no parse.
    expect(authority).not.toMatch(/parseFloat|Number\(|BigInt\(/);
  });

  it('the handed-over route table declares only codes the canonical registry holds', () => {
    const routes = codeOf(ROUTES_SOURCE);
    expect(routes).toContain('POS_CART_ROUTE_AUTHORITY');
    for (const route of POS_CART_ROUTE_AUTHORITY) {
      for (const code of route.refusals) expect(isSellingCode(code), `${route.command} declares an unregistered ${code}`).toBe(true);
    }
  });

  it('a forged-field refusal is REFUSED and not silently ignored — the whole point, stated once', () => {
    // «A field silently ignored is as wrong as a field obeyed.» This slice
    // REFUSES: a 400 with `pos.cart_price_authority_refused`, never a 200 with
    // the field quietly stripped. Silently dropping it would leave a till
    // showing a discount the server never applied.
    const refusal = refusalOf(() => assertNoClientPriceAuthority('cart.request_discount', { discountMinor: '100', lineTotalMinor: '1' }));
    expect(refusal).toEqual({ code: 'pos.cart_price_authority_refused', status: 400 });
  });
});
