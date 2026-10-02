/**
 * P4-S3 — THE POS TRUST BOUNDARY, PROVED BY SENDING THE FORGED TOTALS.
 *
 * «The client sends identities, quantities and a discount request, and NOTHING
 * else is believed.» (lock P4-AL-18; execution plan §P4-S3; `OD-P4-02` OPTION
 * A — discount only.)
 *
 * This is the slice's central claim and this suite is the proof of it. The
 * claim is not asserted by reading the schema: it is asserted by SENDING a
 * forged line total, a forged cart total, a forged unit price and a forged tax
 * amount — and the whole forged-field table besides — at every one of the four
 * cart routes, and requiring a refusal with the registered stable code and the
 * right HTTP status.
 *
 * ── WHAT "REFUSED" MEANS HERE, AND WHY IT IS NOT "IGNORED" ────────────────
 *
 * «A field silently ignored is as wrong as a field obeyed: say which it is and
 * make the test assert it.»
 *
 * IT IS REFUSED. HTTP 400, `VALIDATION_FAILED`, with
 * `details.sellingCode === 'pos.cart_price_authority_refused'` — the code's
 * registered status from the one canonical registry — and the request changes
 * nothing.
 *
 * Three things are asserted about every forged request below, because any one
 * of them alone leaves the other two failure modes open:
 *
 *   1. the STATUS is the code's registered status and the STABLE CODE is the
 *      authority law's own — not a generic `unrecognized_keys` issue, which
 *      reads identically to a typo;
 *   2. the SERVICE WAS NEVER REACHED. The recording double counts its calls,
 *      so "obeyed" and "ignored" are distinguishable from "refused": a 200
 *      with the field stripped would show a service call and no refusal;
 *   3. the forged VALUE appears NOWHERE in the response. A body carrying the
 *      client's figure beside the server's is a calibration oracle, and an
 *      attacker with one does not have to guess twice.
 *
 * ── THE DISAGREEMENT WITH P4-AL-18, STATED RATHER THAN SETTLED QUIETLY ────
 *
 * P4-AL-18 says a client-supplied total "is **ignored**, not validated". The
 * slice brief says forged totals "must be REFUSED, and the refusal must be
 * proved by sending them". Both agree on the only load-bearing part — the
 * client's number is never read, compared or adopted — and differ on the fate
 * of the REQUEST. This slice refuses, which is also what P4-AL-18's own
 * mechanism already does (`SaleCommitSchema` is `.strict()`, so every name in
 * `SALE_FORBIDDEN_REQUEST_FIELDS` is an unknown-key refusal today). It is
 * reported in the hand-back rather than settled here.
 *
 * ── THE HARNESS, AND WHY IT IS STILL THE RIGHT SUBJECT ────────────────────
 *
 * When this suite was written, P4-S3 created no `*.controller.ts` at all:
 * `discoverPhase4Routes` (`scripts/phase4-s1-gate.ts`) walks all of
 * `apps/api/src/modules` for files ending `.controller.ts` and extracts route
 * paths from the SOURCE TEXT, and the G-02 golden asserts its own route list
 * EQUAL to that discovery — so the mere existence of the file turned a sealed
 * P4-S1 golden red whether or not Nest ever mounted it. The transport has
 * since landed WITH both golden updates (`pos-cart.controller.ts`, and the
 * nine POS routes and their cross-tenant pairs in
 * `tests/golden-regression/phase4/01-cross-tenant.golden.test.ts`), so the
 * controller now exists and the cart routes answer over real HTTP.
 *
 * This suite's subject does NOT change with it, and deliberately so: what it
 * isolates is the PIPE — `row.pipe()`, the same `CartCommandPipe` object the
 * mount applies, built from the same table — so a forged field is proved
 * refused BEFORE any service, database or session exists to refuse it for
 * other reasons. The whole-stack half of the same law is now driven over the
 * mounted routes by the G-02 POS section and by the HTTP cases of
 * `tests/integration/pos-s3-cart.test.ts`; this file is what says the refusal
 * is the boundary's and not a side effect of something further in.
 *
 * So this suite drives the accepted alternative, which is the repo's own
 * pattern for exactly this case (`tests/integration/sale-s2-error-contract.test.ts`:
 * "driven through a real `GlobalExceptionFilter` with a real `ArgumentsHost`
 * double — the production class, its production logger port, no stubbing of
 * the mapping under test"). Each case runs, in order:
 *
 *   1. the route row's OWN production pipe, `row.pipe()` — the same
 *      `CartCommandPipe` object the mount will apply, built from the same
 *      table, so the thing under test is the thing that will be mounted;
 *   2. a RECORDING stand-in for the service method the row names, so "never
 *      reached" is observable;
 *   3. whatever was thrown, through the production `GlobalExceptionFilter`
 *      with a real `ArgumentsHost` double — which is where `res.status(...)`
 *      and `res.json(...)` are captured. That status and that body are
 *      literally what a client receives.
 *
 * Nest's dispatch is the one thing not exercised, and it is not the subject:
 * the subject is which status and which stable code a forged total produces.
 * The suite ALSO asserts the route table itself — four rows, every row
 * declaring a body, every row naming `sales.create` and none naming the
 * sensitive `sales.discount` — so the mount the coordinator performs is
 * checkable against the surface proved here.
 *
 * ── NO DATABASE IS NEEDED, AND THAT IS THE POINT ──────────────────────────
 *
 * A forged total is refused in the PIPE — before the schema, before the
 * service, before a connection is taken. So this suite proves the slice's
 * central law without `0079`, without a migration and without a row. If a
 * later edit moved the refusal behind a database read, this suite would need
 * one, which is itself a signal worth having.
 */
import { randomUUID } from 'node:crypto';
import type { ArgumentsHost } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { GlobalExceptionFilter } from '../../apps/api/src/common/error.filter';
import type { Logger } from '../../apps/api/src/infra/logger';
import { POS_CART_ROUTE_AUTHORITY, POS_CART_ROUTE_HANDLERS, type PosCartRoute } from '../../apps/api/src/modules/pos/pos-cart-routes';
import { POS_CODES, isPosCode } from '../../apps/api/src/modules/pos/pos-errors';
import {
  POS_CART_COMMANDS,
  POS_CART_COMMAND_FIELDS,
  POS_CART_FORGED_FIELD_NAMES,
  POS_CART_PATH_ONLY_FIELDS,
} from '../../apps/api/src/modules/pos/pos-price-authority';

const PRODUCT = '33333333-3333-4333-8333-333333333333';

/** The forged VALUE. Distinctive, so its absence from every response body is checkable. */
const FORGED_VALUE = '987654321';

// ─────────────────────────────────────────────────────────────────────────
// The harness: the production pipe, a recording handler, the production filter
// ─────────────────────────────────────────────────────────────────────────

/** Every call the route made of the service, so "never reached" is observable. */
let calls: { command: string; body: unknown }[] = [];

const logs: { fields: Record<string, unknown>; message: string }[] = [];
const logger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  error: (fields: Record<string, unknown>, message: string) => {
    logs.push({ fields, message });
  },
} as unknown as Logger;

const filter = new GlobalExceptionFilter(logger);

interface Answer {
  readonly status: number;
  /** The `ApiErrorCode` envelope, or `<200>` when no refusal happened at all. */
  readonly code: string;
  /** The registered selling/POS code the refusal travels under, or null. */
  readonly sellingCode: string | null;
  readonly raw: string;
}

/**
 * `exception` through the REAL filter, as the status and the body it produced.
 *
 * The response double implements the two methods the filter calls and nothing
 * else, so a filter that started calling a third one fails here rather than
 * silently taking a different path.
 */
function render(exception: unknown): Answer {
  let status = 0;
  let payload: unknown;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(value: unknown) {
      payload = value;
      return this;
    },
  };
  const host = { switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({}) }) } as unknown as ArgumentsHost;
  filter.catch(exception, host);
  const error = (payload as { error?: { code?: string; details?: Record<string, unknown> } } | undefined)?.error;
  const sellingCode = error?.details?.sellingCode;
  return {
    status,
    code: error?.code ?? `<no error envelope: ${status}>`,
    sellingCode: typeof sellingCode === 'string' ? sellingCode : null,
    raw: JSON.stringify(payload),
  };
}

/**
 * One request at one route: the production pipe, then the handler, then the
 * production filter if anything was thrown.
 *
 * This is the mounted handler's whole chain minus Nest's dispatch, in the
 * order a mount runs it — the pipe FIRST, which is what makes the trust
 * boundary outermost.
 */
function send(route: PosCartRoute, body: unknown): Answer {
  calls = [];
  try {
    const parsed = route.pipe().transform(body, { type: 'body' } as never);
    calls.push({ command: POS_CART_ROUTE_HANDLERS[route.command], body: parsed });
    return { status: route.status, code: '<200>', sellingCode: null, raw: JSON.stringify(parsed) };
  } catch (e) {
    return render(e);
  }
}

/** A body this route ACCEPTS, so a forged field is the only difference in each case below. */
function validBody(route: PosCartRoute): Record<string, unknown> {
  switch (route.command) {
    case 'cart.add_line':
      return { productId: PRODUCT, variantId: null, quantity: '2' };
    case 'cart.change_quantity':
      return { quantity: '3' };
    case 'cart.remove_line':
      return {};
    case 'cart.request_discount':
      return { discountMinor: '150' };
  }
}

const routes = (): readonly PosCartRoute[] => POS_CART_ROUTE_AUTHORITY;

beforeEach(() => {
  calls = [];
  logs.length = 0;
});

// ═════════════════════════════════════════════════════════════════════════
const EXPECTED_STATUS: Readonly<Record<string, 200 | 201>> = Object.freeze({
  // 201 on the append, because a line really is created every time; 200 on
  // the three that address a line which already exists.
  'cart.add_line': 201,
  'cart.change_quantity': 200,
  'cart.remove_line': 200,
  'cart.request_discount': 200,
});

describe('P4-S3 — forged totals are REFUSED, and the refusal is proved by sending them', () => {
  it('the four routes accept their own bodies — so a refusal below is the forged field and not the route', () => {
    // The control. Without it, a suite that refused everything would look
    // identical to a suite that proved the law.
    for (const route of routes()) {
      const answer = send(route, validBody(route));
      expect(answer.status, `${route.command} refused its own valid body: ${answer.raw}`).toBe(EXPECTED_STATUS[route.command]);
      expect(calls, route.command).toHaveLength(1);
    }
  });

  // ── THE FOUR FIGURES THE BRIEF NAMES, AT EVERY ROUTE ──────────────────
  it.each(['lineTotalMinor', 'cartTotalMinor', 'unitPriceMinor', 'taxMinor'])(
    'a forged `%s` is refused 400 `pos.cart_price_authority_refused` at every cart route',
    (field) => {
      for (const route of routes()) {
        const answer = send(route, { ...validBody(route), [field]: FORGED_VALUE });
        // (1) the registered status and the STABLE CODE — not a generic
        //     unknown-key issue, which reads the same as a typo.
        expect(answer.status, `${route.command}/${field}: ${answer.raw}`).toBe(400);
        expect(answer.code).toBe('VALIDATION_FAILED');
        expect(answer.sellingCode, `${route.command}/${field}`).toBe('pos.cart_price_authority_refused');
        expect(isPosCode(answer.sellingCode ?? '')).toBe(true);
        // (2) the service was NEVER reached: not obeyed, and not ignored.
        expect(calls, `${route.command}/${field} reached the service`).toHaveLength(0);
        // (3) the forged VALUE is nowhere in the response — no calibration oracle.
        expect(answer.raw).not.toContain(FORGED_VALUE);
        // The field NAME is reported, so a client developer can fix the payload.
        expect(answer.raw).toContain(field);
        // And the route row declares this refusal, so the hand-over table and
        // the behaviour agree.
        expect(route.refusals).toContain('pos.cart_price_authority_refused');
      }
    },
  );

  it('the WHOLE forged-field table is refused the same way, at every route', () => {
    // Not a sample: the table. A name added to the table without being refused
    // would be a row nobody can rely on.
    for (const field of POS_CART_FORGED_FIELD_NAMES) {
      for (const route of routes()) {
        const answer = send(route, { ...validBody(route), [field]: FORGED_VALUE });
        expect(answer.status, `${route.command}/${field}: ${answer.raw}`).toBe(400);
        expect(answer.sellingCode, `${route.command}/${field}`).toBe('pos.cart_price_authority_refused');
        expect(calls, `${route.command}/${field} reached the service`).toHaveLength(0);
        expect(answer.raw).not.toContain(FORGED_VALUE);
      }
    }
  });

  it('a WHOLE BASKET posted in one body is refused by name — there is no such route and no such field', () => {
    // P4-AL-18: "a client-side cart that posts a finished basket is the
    // forged-totals attack of §12 with no attacker required".
    const answer = send(routes()[0] as PosCartRoute, {
      lines: [{ productId: PRODUCT, quantity: '1', lineTotalMinor: FORGED_VALUE }],
      cartTotalMinor: FORGED_VALUE,
    });
    expect(answer.status).toBe(400);
    expect(answer.sellingCode).toBe('pos.cart_price_authority_refused');
    expect(calls).toHaveLength(0);
    expect(answer.raw).not.toContain(FORGED_VALUE);
  });

  it('a forged total NESTED inside the one accepted field is refused', () => {
    const answer = send(routes()[0] as PosCartRoute, { productId: PRODUCT, variantId: null, quantity: { amountMinor: FORGED_VALUE } });
    expect(answer.status).toBe(400);
    expect(answer.sellingCode).toBe('pos.cart_price_authority_refused');
    expect(calls).toHaveLength(0);
  });

  it('a forged total NOBODY LISTED is refused too — the structural half of the law', () => {
    for (const invented of ['grandTotalDueMinor', 'computedLinePrice', 'vatAmount', 'serverTotal']) {
      expect(POS_CART_FORGED_FIELD_NAMES).not.toContain(invented);
      const answer = send(routes()[0] as PosCartRoute, { productId: PRODUCT, variantId: null, quantity: '1', [invented]: FORGED_VALUE });
      expect(answer.status, `${invented}: ${answer.raw}`).toBe(400);
      expect(answer.sellingCode).toBe('pos.cart_price_authority_refused');
      expect(calls).toHaveLength(0);
    }
  });

  it('an unknown key that is NOT a price gets a DIFFERENT registered code', () => {
    // Two codes, so "the forged total was refused" and "a typo was refused"
    // are not the same observation.
    const answer = send(routes()[0] as PosCartRoute, { productId: PRODUCT, variantId: null, quantity: '1', memo: 'hello' });
    expect(answer.status).toBe(400);
    expect(answer.sellingCode).toBe('pos.cart_field_unknown');
    expect(calls).toHaveLength(0);
  });

  it('a body naming a PATH parameter is refused: one target, stated in one place', () => {
    for (const field of POS_CART_PATH_ONLY_FIELDS) {
      const answer = send(routes()[1] as PosCartRoute, { quantity: '1', [field]: randomUUID() });
      expect(answer.status, field).toBe(400);
      expect(answer.sellingCode, field).toBe('pos.cart_field_unknown');
      expect(calls).toHaveLength(0);
    }
  });

  it('a removal with a body is refused — and that is the hole this suite found', () => {
    // `@UsePipes` runs per handler PARAMETER: a handler with no `@Body()`
    // presents no body to the pipe, so a forged total sent to a `DELETE` was
    // SILENTLY IGNORED — 200, nothing changed, nothing said. Every route row
    // now carries `body: true` and the removal's schema is the empty strict
    // object.
    const removal = routes()[2] as PosCartRoute;
    expect(removal.method).toBe('DELETE');
    expect(removal.body).toBe(true);
    expect(send(removal, {}).status).toBe(200);
    const answer = send(removal, { totalMinor: FORGED_VALUE });
    expect(answer.status).toBe(400);
    expect(answer.sellingCode).toBe('pos.cart_price_authority_refused');
    expect(calls).toHaveLength(0);
    // A `DELETE` whose body never arrives at all is still a valid removal.
    expect(send(removal, undefined).status).toBe(200);
  });
});

// ═════════════════════════════════════════════════════════════════════════
describe('P4-S3 — the two things a client MAY state, and nothing more', () => {
  it('a quantity and a discount request are the whole of what gets through', () => {
    const add = send(routes()[0] as PosCartRoute, { productId: PRODUCT, variantId: null, quantity: '2.5' });
    expect(add.status).toBe(201);
    expect(calls[0]).toEqual({ command: 'addLine', body: { productId: PRODUCT, variantId: null, quantity: '2.5' } });

    const discount = send(routes()[3] as PosCartRoute, { discountMinor: '150' });
    expect(discount.status).toBe(200);
    expect(calls[0]).toEqual({ command: 'requestDiscount', body: { discountMinor: '150' } });
  });

  it('a quantity that is not an exact decimal string is refused by the schema — never coerced', () => {
    for (const bad of [{ quantity: 2 }, { quantity: '2.00001' }, { quantity: '0' }, { quantity: '-1' }, { quantity: 'two' }, { quantity: '0.0' }]) {
      const answer = send(routes()[1] as PosCartRoute, bad);
      expect(answer.status, `${JSON.stringify(bad)}: ${answer.raw}`).toBe(400);
      expect(answer.code).toBe('VALIDATION_FAILED');
      expect(calls).toHaveLength(0);
    }
  });

  it('a discount that is not an integer count of minor units is refused — a JSON number is an IEEE double', () => {
    for (const bad of [{ discountMinor: 150 }, { discountMinor: '1.5' }, { discountMinor: '-1' }, { discountMinor: '01' }]) {
      const answer = send(routes()[3] as PosCartRoute, bad);
      expect(answer.status, `${JSON.stringify(bad)}: ${answer.raw}`).toBe(400);
      expect(calls).toHaveLength(0);
    }
  });

  it('a forged field is refused BEFORE the schema, so the law has a name', () => {
    // Ordering is the whole reason the authority module exists. A strict
    // schema alone refuses `cartTotalMinor` and `crtTotalMinor` with the same
    // `unrecognized_keys` issue and the same generic body, so the law would
    // have no name in the response.
    let bySchemaAlone: unknown;
    try {
      (routes()[0] as PosCartRoute).schema.parse({ cartTotalMinor: '1' });
      bySchemaAlone = new Error('the schema accepted a forged cart total');
    } catch (e) {
      bySchemaAlone = e;
    }
    expect(render(bySchemaAlone).sellingCode, 'a bare schema refusal carries no POS code').toBeNull();
    // The real chain keeps the name.
    expect(send(routes()[0] as PosCartRoute, { cartTotalMinor: '1' }).sellingCode).toBe('pos.cart_price_authority_refused');
  });

  it('the SECOND line of defence holds independently: each route schema is strict', () => {
    // The scan is the law and the schema is the shape. Either alone refuses
    // the forged field, which is what makes the boundary two statements of one
    // rule rather than one mechanism with a single point of failure.
    for (const route of routes()) {
      expect(route.schema.safeParse({ ...validBody(route), cartTotalMinor: '1' }).success, `${route.command}'s schema accepted a forged total`).toBe(false);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════
describe('P4-S3 — the refusal contract and the handed-over surface', () => {
  it('every refusal this suite saw carries a REGISTERED code and its registered status', () => {
    const seen = new Set<string>();
    for (const route of routes()) {
      for (const body of [
        { ...validBody(route), cartTotalMinor: '1' },
        { ...validBody(route), nope: 1 },
      ]) {
        const answer = send(route, body);
        expect(answer.sellingCode, `${route.command}: ${answer.raw}`).not.toBeNull();
        expect(isPosCode(answer.sellingCode ?? ''), `${answer.sellingCode} is not registered`).toBe(true);
        expect(answer.status).toBe(400);
        seen.add(answer.sellingCode ?? '');
      }
    }
    expect([...seen].sort()).toEqual(['pos.cart_field_unknown', 'pos.cart_price_authority_refused']);
    // Every code a route declares is registered in the ONE canonical registry.
    for (const route of routes()) for (const code of route.refusals) expect(POS_CODES, `${code}`).toContain(code);
  });

  it('no refusal body leaks SQL, a routine name, a GUC, a constraint or an amount (P4-AL-54)', () => {
    for (const route of routes()) {
      const answer = send(route, { ...validBody(route), cartTotalMinor: FORGED_VALUE, fxRate: '3.75' });
      for (const leak of ['SELECT', 'INSERT', 'pos_cart_lines', 'pos_till_sessions', 'app.business_id', 'base_price_minor', FORGED_VALUE, '3.75']) {
        expect(answer.raw, `${route.command} leaked ${leak}`).not.toContain(leak);
      }
    }
  });

  it('the handed-over route table is four rows, one per command, every one declaring a body', () => {
    // The surface is the law, and the mount is the coordinator's. This is what
    // the mount is checked against.
    expect(routes()).toHaveLength(4);
    expect(routes().map((r) => r.command)).toEqual([...POS_CART_COMMANDS]);
    for (const route of routes()) {
      expect(POS_CART_COMMAND_FIELDS[route.command], route.command).toBeDefined();
      // The DELETE hole, closed as a property of the table.
      expect(route.body, `${route.command} does not declare a body: a forged field there would be SILENTLY IGNORED`).toBe(true);
      // The append answers 201 and the other three 200. This assertion read
      // `toBe(200)` while the add was an upsert, on the ground that a MERGED
      // line is not a created one; `0079` makes the basket append-only, so
      // the honest answer flipped with the identity.
      expect(route.status, `${route.command} answers the wrong status`).toBe(EXPECTED_STATUS[route.command]);
      // `sales.create` on all four; the SENSITIVE key on none, because it
      // depends on the body and a decorator cannot see the body.
      expect(route.permission, route.command).toBe('sales.create');
      expect(route.sensitive).toBe(false);
      expect(route.path.startsWith('/v1/pos/till-sessions/:sessionId/cart-lines')).toBe(true);
    }
    // There is no whole-basket route and no GET. The method union of
    // `PosCartRoute` cannot even express `GET`, so this is a check on the DATA
    // rather than on the type: every row is one of the three mutating verbs,
    // and no row addresses the cart as a whole.
    expect([...new Set(routes().map((r) => r.method))].sort()).toEqual(['DELETE', 'PATCH', 'POST']);
    expect(routes().some((r) => r.path.endsWith('/cart'))).toBe(false);
  });

  it('`sales.discount` is on NO route row — it is a body-dependent service check', () => {
    for (const route of routes()) expect(route.permission).not.toBe('sales.discount');
    // And the discount route declares the refusal the service raises, so the
    // sensitive key is accounted for somewhere a reviewer can find it.
    const discount = routes()[3] as PosCartRoute;
    expect(discount.refusals).toContain('pos.cart_discount_not_permitted');
  });
});
