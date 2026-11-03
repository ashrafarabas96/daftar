/**
 * P4-S3 — **THE CART READ, PERFORMED AGAINST A REAL DATABASE THROUGH THE REAL
 * COMPOSITION** (`GET /v1/pos/till-sessions/:sessionId/cart-lines`; lock
 * `P4-AL-18`, `P4-AL-40`, `P4-AL-86`, `OD-P4-09` OPTION A).
 *
 * ── WHY THIS READ EXISTS, AND WHY A 200 WOULD NOT HAVE TESTED IT ──────────
 *
 * The slice shipped a SERVER-SIDE basket with four write commands and no way
 * to read it. Each command answers with the recomputed cart, which was taken
 * to mean a till «never asks twice» — true of every case except the one that
 * matters, a till screen that RELOADS. `GET /v1/pos/till-sessions/current`
 * and `GET /v1/pos/till-sessions/:sessionId` both answer a `TillSession` and
 * carry no line, so before this read a reload lost the basket while its rows
 * sat in `pos_cart_lines` with no route able to see them.
 *
 * «A read that is only asserted to return 200 is not tested.» So nothing
 * below asserts a status alone. Each section states a FACT about the answer:
 *
 *   §1  the cart a command just wrote is the cart this read returns, FIELD FOR
 *       FIELD — one `toEqual` against the command's own body, which is the
 *       only form of the claim that cannot pass with a read that recomputes
 *       differently;
 *   §2  the reload: the same cart, with no command in between, twice;
 *   §3  a removed line is ABSENT and the tombstone is not resurrected;
 *   §4  a closed shift's basket is READABLE, which is a ruling (see
 *       `PosCartService.readCart`) and is asserted here rather than asserted
 *       in prose;
 *   §5  a colleague's session is `pos.session_not_owned`, a cross-business and
 *       a cross-tenant session are `pos.session_not_found`, and NONE of them
 *       is answered with an empty cart — an empty cart would be a leak
 *       dressed as a zero;
 *   §6  the figures are the SERVER's: no price, total or tax is accepted from
 *       the request in any form, and no refusal body carries SQL, a routine
 *       name, a GUC or a constraint name;
 *   §7  the statement count: TWO, and ONE connection.
 *
 * ── EVERY SUBJECT IS CREATED THROUGH A ROUTE ──────────────────────────────
 *
 * No `pos_till_sessions` or `pos_cart_lines` row is inserted by hand here. It
 * could not be: `daftar_app` holds `SELECT` only on both relations
 * (`0079:605`) and every write goes through a `SECURITY DEFINER` routine
 * consuming an `invctl/1` assertion. So the baskets this read answers were
 * appended by `POST .../cart-lines` and the closed shift was closed by
 * `POST .../close`, which is what makes a refusal below the isolation refusing
 * a request whose ALLOW form demonstrably works rather than a route that
 * refuses everything.
 *
 * ── THE BASENAME IS `pos-s3-` FOR A REASON ────────────────────────────────
 *
 * The P4-S3 gate's roster rule takes any file under `tests/` whose basename
 * begins `pos-s3-` or `phase4-pos-`, so this suite runs under
 * `gate:phase4:s3` with no gate edit. A basename beginning `p4-` or
 * `phase4-` in `tests/integration`, `tests/security` or `tests/performance`
 * would have turned the SEALED `gate:phase4:s1` red through `suiteProblems`
 * (`scripts/phase4-s1-gate.ts`), which is the other half of why the prefix is
 * this one.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { Database } from '../../apps/api/src/infra/database';
import { TenancyService, type MembershipContext } from '../../apps/api/src/modules/tenancy/tenancy.service';
import { PosCartService, type CartDto } from '../../apps/api/src/modules/pos/pos-cart.service';
import { cartReadPlan, CART_STATEMENTS_PER_READ } from '../../apps/api/src/modules/pos/pos-cart-statements';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { closeTillSession, openTillSession } from '../helpers/pos-till-sessions';
import { asMember, onboardS3Business, registerActor, type HttpActor, type S3Business } from '../helpers/inventory-commands';
import { addMember } from '../helpers/merchant-reads';

let t: TestApp;
/** The owner of tenant 1, a member of both A and A2 — so a cross-BUSINESS probe is not a cross-tenant one in disguise. */
let owner: HttpActor;
/** The owner of tenant 2, for the cross-TENANT probe. */
let ownerB: HttpActor;
/** The cashier whose till every ALLOW below is about. */
let cashier: HttpActor;
/** A real colleague of the same business with the same role — the only version of `OD-P4-09` a test can ask about. */
let colleague: HttpActor;
/** A third member, whose shift is COUNTED AND CLOSED with lines still in its basket (§4). */
let closer: HttpActor;

let A: S3Business;
/** A second business of the SAME tenant. */
let A2: S3Business;
/** A business of ANOTHER tenant. */
let B: S3Business;

/** `cashier`'s open till in A, and the two lines its basket holds. */
let session: string;
let lineIds: string[] = [];
/** The cart body the LAST command answered with — the thing §1 compares the read against. */
let commandAnswer: CartDto;

/** `colleague`'s own open till in A. Visible, open, in this business, and not the cashier's. */
let colleagueSession: string;
/** `owner`'s open till in A2, with a line in it. */
let a2Session: string;
/** `ownerB`'s open till in B, with a line in it. */
let bSession: string;
/** `closer`'s CLOSED till in A, with a line still in its basket. */
let closedSession: string;
let closedLineId: string;

const cartPath = (sessionId: string): string => `/v1/pos/till-sessions/${sessionId}/cart-lines`;

/** Append one line through the real route, and hand back the cart the command answered with. */
async function append(by: HttpActor, businessId: string, sessionId: string, productId: string, quantity: string): Promise<CartDto> {
  const res = await t.request.post(cartPath(sessionId)).set(asMember(by, businessId)).send({ productId, variantId: null, quantity });
  expect(res.status, `the append was refused: ${JSON.stringify(res.body)}`).toBe(201);
  return res.body as CartDto;
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  t = await createTestApp();

  owner = await registerActor(t, 'POS S3 cart-read owner');
  A = await onboardS3Business(t, owner, 'poss3read');
  A2 = await onboardS3Business(t, owner, 'poss3read2', A.tenantId);
  ownerB = await registerActor(t, 'POS S3 cart-read owner B');
  B = await onboardS3Business(t, ownerB, 'poss3readb');

  cashier = await addMember(t, owner, A, 'POS S3 cart-read cashier', 'cashier');
  colleague = await addMember(t, owner, A, 'POS S3 cart-read colleague', 'cashier');
  closer = await addMember(t, owner, A, 'POS S3 cart-read closer', 'cashier');

  // `pos_till_sessions_one_open_per_user_uq` is a PARTIAL unique index on
  // `(business_id, opened_by) WHERE status = 'open'`, so a suite that needs
  // four tills in one business needs four ACTORS. That is the ruling, not an
  // inconvenience: one session, one authenticated user, one drawer.
  session = (await openTillSession(t, cashier, A.businessId, { branchId: A.branchX, warehouseId: A.w1 }, { terminalCode: 'poss3_read_a' })).sessionId;
  colleagueSession = (await openTillSession(t, colleague, A.businessId, { branchId: A.branchX, warehouseId: A.w1 }, { terminalCode: 'poss3_read_col' }))
    .sessionId;
  closedSession = (await openTillSession(t, closer, A.businessId, { branchId: A.branchX, warehouseId: A.w1 }, { terminalCode: 'poss3_read_cls' })).sessionId;
  a2Session = (await openTillSession(t, owner, A2.businessId, { branchId: A2.branchX, warehouseId: A2.w1 }, { terminalCode: 'poss3_read_a2' })).sessionId;
  bSession = (await openTillSession(t, ownerB, B.businessId, { branchId: B.branchX, warehouseId: B.w1 }, { terminalCode: 'poss3_read_b' })).sessionId;

  // TWO lines, two different products, so an answer that dropped one, merged
  // them or reordered them is visible. The second append's answer is the whole
  // basket, which is what §1 compares against.
  await append(cashier, A.businessId, session, A.piece.productId, '2');
  commandAnswer = await append(cashier, A.businessId, session, A.piece2.productId, '3');
  lineIds = commandAnswer.lines.map((l) => l.cartLineId);
  expect(lineIds, 'the fixture basket does not hold two lines, so every case below has the wrong subject').toHaveLength(2);

  await append(colleague, A.businessId, colleagueSession, A.piece.productId, '1');
  await append(owner, A2.businessId, a2Session, A2.piece.productId, '1');
  await append(ownerB, B.businessId, bSession, B.piece.productId, '1');

  // The closed shift: a line, then the count. `0079`'s own comment on
  // `pos_till_session_close` is that «the basket is NOT deleted: a closed
  // session and its lines are the frozen record of the shift», so this basket
  // is still there after the drawer is counted — which is what §4 reads.
  const closedCart = await append(closer, A.businessId, closedSession, A.piece.productId, '4');
  closedLineId = closedCart.lines[0]?.cartLineId ?? '';
  expect(closedLineId, 'the shift to be closed has no line, so §4 would read an empty basket either way').not.toBe('');
  await closeTillSession(t, closer, A.businessId, closedSession);
}, 900_000);

afterAll(async () => {
  await t.close();
  await resetData();
});

/** The read, as a cashier issues it. */
const read = async (by: HttpActor, businessId: string, sessionId: string): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await t.request.get(cartPath(sessionId)).set(asMember(by, businessId));
  return { status: res.status, body: res.body as Record<string, unknown> };
};

// ═════════════════════════════════════════════════════════════════════════
describe('§1 — the cart a command wrote is the cart this read returns, field for field', () => {
  it('the read answers the LAST command’s own body exactly, with no field added, dropped or re-rounded', async () => {
    const res = await read(cashier, A.businessId, session);
    expect(res.status, `the read was refused for its own till: ${JSON.stringify(res.body)}`).toBe(200);
    // ONE equality, against the cart `POST .../cart-lines` answered with. A
    // read that recomputed differently — a second rounding grain, a dropped
    // tombstone predicate, a different ORDER BY, a currency fallback of its
    // own — fails here and nowhere else, because every other assertion in this
    // file would still pass.
    expect(res.body).toEqual(commandAnswer as unknown as Record<string, unknown>);
  });

  it('every money field is a STRING of minor units and every quantity its exact decimal spelling', async () => {
    const res = await read(cashier, A.businessId, session);
    const cart = res.body as unknown as CartDto;
    // The wire contract, asserted on the READ and not only on the commands:
    // a JSON number here would be a float on a price, which is the defect the
    // whole minor-unit discipline exists to prevent.
    for (const field of ['subtotalMinor', 'discountMinor', 'taxMinor', 'totalMinor'] as const) {
      expect(typeof cart[field], field).toBe('string');
      expect(cart[field], field).toMatch(/^-?\d+$/);
    }
    // `OD-03` is OPEN, so tax is STRUCTURALLY zero (P4-AL-44) and reported
    // because it is derived, never because it was stated.
    expect(cart.taxMinor, 'a tax figure appeared while `OD-03` is open').toBe('0');
    for (const line of cart.lines) {
      for (const field of ['unitPriceMinor', 'grossMinor', 'discountMinor', 'netMinor'] as const) {
        expect(typeof line[field], `${line.cartLineId}.${field}`).toBe('string');
        expect(line[field], `${line.cartLineId}.${field}`).toMatch(/^-?\d+$/);
      }
      expect(line.quantity, `${line.cartLineId}.quantity`).toMatch(/^\d+(\.\d+)?$/);
    }
    // The total is the exact sum of the line nets: no second rounding at the
    // cart grain (the one-rounding law `recompute` refuses in production).
    const nets = cart.lines.reduce((sum, l) => sum + BigInt(l.netMinor), 0n);
    expect(cart.totalMinor, 'the cart total is not the exact sum of the line nets').toBe(nets.toString(10));
  });
});

// ═════════════════════════════════════════════════════════════════════════
describe('§2 — the reload: the same basket with no command in between', () => {
  it('two reads in a row answer the identical cart, and neither changes a row', async () => {
    const before = await basketRows(session);
    const first = await read(cashier, A.businessId, session);
    const second = await read(cashier, A.businessId, session);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // This is the case the route was added for: the till screen reloaded and
    // nothing had happened in between. Equality against the FIRST read and
    // against the command's own answer, so "stable" and "right" are both
    // stated.
    expect(second.body).toEqual(first.body);
    expect(second.body).toEqual(commandAnswer as unknown as Record<string, unknown>);
    // And a read is a read: the rows are untouched, counted as the schema
    // OWNER so no policy can hide a write.
    expect(await basketRows(session), 'a read changed the basket').toEqual(before);
  });
});

/** Every row of a basket, tombstones included, as the schema OWNER sees it. */
async function basketRows(sessionId: string): Promise<readonly { id: string; removed: boolean }[]> {
  const { rows } = await ownerPool().query<{ id: string; removed: boolean }>(
    `SELECT id::text AS id, (removed_at IS NOT NULL) AS removed FROM pos_cart_lines WHERE till_session_id = $1 ORDER BY line_no`,
    [sessionId],
  );
  return rows;
}

// ═════════════════════════════════════════════════════════════════════════
describe('§3 — a removed line is absent, and a tombstone is not resurrected', () => {
  it('the removal’s own answer and the read agree that the line is gone, while its ROW is still there', async () => {
    // A fourth actor's till, so the §1 and §2 subjects keep their verdicts.
    const remover = await addMember(t, owner, A, 'POS S3 cart-read remover', 'cashier');
    const ownTill = (await openTillSession(t, remover, A.businessId, { branchId: A.branchX, warehouseId: A.w1 }, { terminalCode: 'poss3_read_rm' })).sessionId;
    await append(remover, A.businessId, ownTill, A.piece.productId, '1');
    const twoLines = await append(remover, A.businessId, ownTill, A.piece2.productId, '1');
    const [doomed, kept] = twoLines.lines.map((l) => l.cartLineId);
    expect(doomed, 'the removal case has no line to remove').toBeDefined();

    const removed = await t.request
      .delete(`${cartPath(ownTill)}/${String(doomed)}`)
      .set(asMember(remover, A.businessId))
      .send({});
    expect(removed.status, `the removal was refused: ${JSON.stringify(removed.body)}`).toBe(200);

    const after = await read(remover, A.businessId, ownTill);
    expect(after.status).toBe(200);
    const ids = (after.body as unknown as CartDto).lines.map((l) => l.cartLineId);
    expect(ids, 'the read answered a line the removal tombstoned').not.toContain(doomed);
    expect(ids, 'the read dropped the line that was NOT removed').toEqual([kept]);
    // The read agrees with the command, which is the stronger statement: the
    // two share one `PROJECTION`, so they cannot disagree about what "the
    // cart" is.
    expect(after.body).toEqual(removed.body);

    // The TOMBSTONE is still a row — `0079` gives the internal writer no
    // DELETE on this relation — so "absent from the read" is a predicate and
    // not a deletion, and the read is what proves the predicate is applied.
    const rows = await basketRows(ownTill);
    expect(
      rows.filter((r) => r.removed).map((r) => r.id),
      'the removal deleted the row instead of tombstoning it',
    ).toEqual([String(doomed)]);
    expect(rows, 'the basket lost a row').toHaveLength(2);

    // And a second read does not bring it back: a tombstone is final
    // (`pos_cart_line_guard()` refuses un-removing one), so no later read may
    // resurrect it.
    const again = await read(remover, A.businessId, ownTill);
    expect(
      (again.body as unknown as CartDto).lines.map((l) => l.cartLineId),
      'a tombstoned line came back on a later read',
    ).toEqual([kept]);
  });
});

// ═════════════════════════════════════════════════════════════════════════
describe('§4 — a CLOSED shift’s basket is readable, and that is the ruling', () => {
  /**
   * The four cart COMMANDS refuse `pos.session_not_open` (409) behind a
   * closed till, and this read deliberately does not. `0079` keeps the basket
   * at close on purpose — its own comment calls a closed shift's lines
   * «frozen evidence» and «the frozen record of the shift» — and what
   * `pos_cart_line_guard()` refuses is a WRITE. A `SELECT` cannot thaw a
   * counted drawer, and `GET /v1/pos/till-sessions/:sessionId` already
   * answers for a closed session, so refusing here would be two answers to
   * one question and would leave the evidence unreachable.
   *
   * Both halves are asserted, because the ruling is only meaningful as a
   * pair: the READ answers, and a WRITE to the same closed basket still does
   * not.
   */
  it('the read answers a counted shift’s frozen basket, while a command on the same basket is still refused', async () => {
    const after = await read(closer, A.businessId, closedSession);
    expect(after.status, `the read refused a closed shift's frozen basket: ${JSON.stringify(after.body)}`).toBe(200);
    const cart = after.body as unknown as CartDto;
    expect(cart.tillSessionId).toBe(closedSession);
    expect(
      cart.lines.map((l) => l.cartLineId),
      'the closed shift’s basket came back without its line',
    ).toEqual([closedLineId]);
    expect(cart.lines[0]?.quantity, 'the frozen quantity changed').toBe('4');

    // The other half: the basket is readable and still frozen. A quantity
    // change on the same line answers `pos.session_not_open`, which is the
    // 409 the commands owe and the read does not.
    const write = await t.request
      .patch(`${cartPath(closedSession)}/${closedLineId}`)
      .set(asMember(closer, A.businessId))
      .send({ quantity: '9' });
    expect(write.status, `a write into a closed shift's basket answered ${write.status}`).toBe(409);
    expect(write.body?.error?.details?.sellingCode, JSON.stringify(write.body)).toBe('pos.session_not_open');

    // …and the frozen figure did not move.
    const again = await read(closer, A.businessId, closedSession);
    expect((again.body as unknown as CartDto).lines[0]?.quantity, 'the refused write changed the frozen basket').toBe('4');
  });
});

// ═════════════════════════════════════════════════════════════════════════
describe('§5 — the refusals, by registered code, and never an empty cart', () => {
  /**
   * The refusal's stable code, as a client reads it off the body.
   *
   * `GlobalExceptionFilter` renders `{ error: { code, message, requestId,
   * details } }`, so the stable code is `error.details.sellingCode` — the
   * registry's own code, not the generic `ApiErrorCode`.
   */
  const codeOf = (body: Record<string, unknown>): unknown => {
    const error = body['error'] as Record<string, unknown> | undefined;
    return (error?.['details'] as Record<string, unknown> | undefined)?.['sellingCode'];
  };

  /**
   * The assertion that makes every refusal below worth making: a refusal is
   * REFUSED, not answered with a zero. `{ lines: [] }` under a 200 would read
   * to a cashier as "the basket is empty" and to a naive suite as "no row
   * escaped", which is why each case states the absence of a cart as well as
   * the presence of a code.
   */
  const refusedAndNotEmptied = (body: Record<string, unknown>, what: string): void => {
    // Asserted over the WHOLE serialized body and not only its top level: the
    // refusal is rendered as `{ error: … }`, so a cart smuggled into
    // `error.details` would pass a top-level check.
    const text = JSON.stringify(body);
    for (const field of ['lines', 'tillSessionId', 'totalMinor', 'subtotalMinor', 'taxMinor'])
      expect(text.includes(`"${field}"`), `${what}: the refusal body carries "${field}"`).toBe(false);
  };

  it('a COLLEAGUE’s session in the caller’s own business is 403 `pos.session_not_owned`', async () => {
    const res = await read(cashier, A.businessId, colleagueSession);
    // `OD-P4-09`: one session, one authenticated user. The session is visible,
    // in this business and open — what forbids the read is WHO is asking, so
    // 403 and not 404. Handing over a colleague's basket would be the shared
    // till the ruling refused, read-only.
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(codeOf(res.body)).toBe('pos.session_not_owned');
    refusedAndNotEmptied(res.body, 'a colleague’s till');
  });

  it('a session of ANOTHER BUSINESS of the same tenant is 404 `pos.session_not_found` — not an empty cart', async () => {
    // `owner` is a real member of A2 and reads A2's basket successfully under
    // A2's header, so this refusal is the BUSINESS binding and not a missing
    // membership. RLS makes the row invisible under A's scope, so the honest
    // answer is 404: a 403 would confirm a row exists in a business this
    // scope has no sight of.
    const allowed = await read(owner, A2.businessId, a2Session);
    expect(allowed.status, `the ALLOW of the same shape does not work: ${JSON.stringify(allowed.body)}`).toBe(200);

    const res = await read(owner, A.businessId, a2Session);
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(codeOf(res.body)).toBe('pos.session_not_found');
    refusedAndNotEmptied(res.body, 'another business’s till');
  });

  it('a session of ANOTHER TENANT is 404 `pos.session_not_found` — not an empty cart', async () => {
    const res = await read(owner, A.businessId, bSession);
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(codeOf(res.body)).toBe('pos.session_not_found');
    refusedAndNotEmptied(res.body, 'another tenant’s till');

    // And the other direction, with another tenant's token against this
    // tenant's business.
    const foreignToken = await read(ownerB, A.businessId, session);
    expect([401, 403, 404], `another tenant's token answered ${foreignToken.status}`).toContain(foreignToken.status);
    refusedAndNotEmptied(foreignToken.body, 'another tenant’s token');
  });

  it('a session id that never existed, and a MALFORMED one, are the same 404 — the path is no oracle', async () => {
    const absent = await read(cashier, A.businessId, randomUUID());
    const malformed = await read(cashier, A.businessId, 'not-a-uuid');
    // Deliberately the same answer as another business's session. If a
    // malformed id or an unused one answered differently, the path would tell
    // an attacker which ids exist — which is the enumeration this estate's
    // guards refuse.
    for (const [what, res] of [
      ['an unused id', absent],
      ['a malformed id', malformed],
    ] as const) {
      expect(res.status, `${what}: ${JSON.stringify(res.body)}`).toBe(404);
      expect(codeOf(res.body), what).toBe('pos.session_not_found');
      refusedAndNotEmptied(res.body, what);
    }
  });

  it('the two refusals are the same shape, so neither is distinguishable by anything but its code', async () => {
    // The `requestId` is the one field that differs by design — it is the
    // request's own trace, which is what makes a refusal diagnosable at all —
    // so it is dropped before the comparison and its PRESENCE is asserted
    // instead.
    const withoutRequestId = (body: Record<string, unknown>): unknown => {
      const error = { ...(body['error'] as Record<string, unknown>) };
      expect(error['requestId'], 'a refusal with no request id cannot be traced').toMatch(/^[0-9a-f-]{36}$/);
      delete error['requestId'];
      return { ...body, error };
    };
    const other = await read(owner, A.businessId, bSession);
    const absent = await read(owner, A.businessId, randomUUID());
    expect(Object.keys(other.body).sort(), 'the cross-tenant refusal carries a field the "no such id" one does not').toEqual(Object.keys(absent.body).sort());
    // Byte for byte the same answer, down to the message. A difference here —
    // a different sentence, an extra detail, a different code — would tell a
    // caller which session ids exist in businesses it cannot see.
    expect(withoutRequestId(other.body)).toEqual(withoutRequestId(absent.body));
  });
});

// ═════════════════════════════════════════════════════════════════════════
describe('§6 — the figures are the SERVER’s, and no refusal describes the machine', () => {
  /** A distinctive forged value, so its absence from every answer is checkable. */
  const FORGED = '987654321';

  it('no price, total, tax or line is accepted from the request in ANY form', async () => {
    const truth = await read(cashier, A.businessId, session);
    expect(truth.status).toBe(200);
    const before = await basketRows(session);

    // The handler takes NOTHING but the session in its path — no `@Body()`,
    // no `@Query()` — so a forged figure here is not refused, it is
    // INEXPRESSIBLE. That is the stronger property and it is what is
    // asserted: every one of these answers the identical, untainted cart, and
    // the forged value appears nowhere in it.
    const probes: readonly { readonly what: string; readonly send: () => Promise<{ status: number; body: unknown }> }[] = [
      {
        what: 'forged figures in the QUERY STRING',
        send: async () => {
          const r = await t.request
            .get(`${cartPath(session)}?totalMinor=${FORGED}&subtotalMinor=${FORGED}&taxMinor=${FORGED}&unitPriceMinor=${FORGED}&discountMinor=${FORGED}`)
            .set(asMember(cashier, A.businessId));
          return { status: r.status, body: r.body };
        },
      },
      {
        what: 'forged figures and a whole basket in the BODY of the GET',
        send: async () => {
          const r = await t.request
            .get(cartPath(session))
            .set(asMember(cashier, A.businessId))
            .send({
              totalMinor: FORGED,
              taxMinor: FORGED,
              lines: [{ cartLineId: randomUUID(), productId: A.piece.productId, quantity: '99', unitPriceMinor: FORGED, netMinor: FORGED }],
            });
          return { status: r.status, body: r.body };
        },
      },
      {
        what: 'a forged currency and a forged session id in the QUERY STRING',
        send: async () => {
          const r = await t.request
            .get(`${cartPath(session)}?currency=XXX&sessionId=${a2Session}&businessId=${A2.businessId}`)
            .set(asMember(cashier, A.businessId));
          return { status: r.status, body: r.body };
        },
      },
    ];

    for (const probe of probes) {
      const res = await probe.send();
      expect(res.status, `${probe.what}: ${JSON.stringify(res.body)}`).toBe(200);
      expect(res.body, probe.what).toEqual(truth.body);
      expect(JSON.stringify(res.body).includes(FORGED), `${probe.what}: the forged value came back`).toBe(false);
      // In particular the scope did not move: a query string naming another
      // business's session answered THIS session's cart.
      expect((res.body as CartDto).tillSessionId, probe.what).toBe(session);
    }

    // And nothing was written by any of it, counted as the schema OWNER so no
    // policy can hide a write.
    expect(await basketRows(session), 'a forged request changed the basket').toEqual(before);
    const { rows } = await ownerPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM pos_cart_lines WHERE till_session_id = $1 AND quantity = 99`, [
      session,
    ]);
    expect(rows[0]?.n, 'a forged line was written').toBe('0');
  });

  it('no refusal body carries SQL, a routine name, a GUC or a constraint name', async () => {
    const bodies: readonly { readonly what: string; readonly body: unknown }[] = [
      { what: 'a colleague’s till', body: (await read(cashier, A.businessId, colleagueSession)).body },
      { what: 'another business’s till', body: (await read(owner, A.businessId, a2Session)).body },
      { what: 'another tenant’s till', body: (await read(owner, A.businessId, bSession)).body },
      { what: 'a malformed id', body: (await read(cashier, A.businessId, 'not-a-uuid')).body },
    ];
    // The vocabulary a refusal must not teach. Each entry is a real
    // identifier in this slice's schema or in the statements the read issues,
    // so a body that leaked the underlying failure would carry one of them.
    const forbidden = [
      'SELECT',
      'pos_cart_lines',
      'pos_till_sessions',
      'pos_cart_set_line',
      'pos_cart_remove_line',
      'pos_cart_line_guard',
      'pos_till_session_guard',
      'app.tenant_id',
      'app.business_id',
      'app.inventory_assertion',
      'pos_cart_lines_line_uq',
      'tenant_membership',
      'business_isolation',
      'P0001',
      'opened_by',
      'removed_at',
      'line_no',
    ];
    for (const { what, body } of bodies) {
      const text = JSON.stringify(body);
      for (const token of forbidden) expect(text.includes(token), `${what}: the refusal body carries "${token}"`).toBe(false);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════
describe('§7 — two statements and one connection, measured on the production service', () => {
  /**
   * THE TRANSACTION BOUNDARY'S OWN STATEMENTS, named so the exclusion below is
   * visible rather than hidden in a number.
   *
   * `Database.withTransaction` issues `BEGIN` and the `set_config` scope
   * statement before it hands the client over, and `COMMIT` or `ROLLBACK`
   * after — for EVERY transaction in the tree, and constant whatever the read
   * does. `pos-cart-statements.ts` already states why they are not counted:
   * «they are constant three for one line and for fifty, so including them
   * would change both sides of the equality by the same amount and prove
   * nothing extra. What is counted is what THIS module issues.» They are
   * nevertheless asserted below rather than merely dropped, so a read that
   * stopped committing or opened a second transaction is still visible.
   */
  const BOUNDARY = /^\s*(BEGIN|COMMIT|ROLLBACK|SET\s|SELECT set_config)/i;

  /**
   * THE STATEMENT COUNT, stated as a number and measured rather than promised.
   *
   * TWO: the gate and the projection. It is the fewest the read can be —
   * without the gate it would answer a colleague's basket, and without the
   * projection it would answer nothing — and it is one fewer than a command,
   * which needs a routine between them.
   *
   * It is measured on the `PosCartService` the PRODUCTION composition built
   * (`t.app.get`), by wrapping the one `Database` method the read uses, so
   * what is counted is what this read issues and not what a request's
   * authentication, tenancy resolution or audit happen to issue around it.
   * The wrapper is removed in a `finally`, so a failure here cannot leave the
   * app instrumented for a later case.
   */
  it('`readCart` issues exactly two statements — the gate then the projection — in ONE transaction', async () => {
    const service = t.app.get(PosCartService);
    const db = t.app.get(Database);
    const tenancy = t.app.get(TenancyService);
    const m: MembershipContext = await tenancy.resolveMembership(cashier.userId, A.businessId);

    const issued: string[] = [];
    let transactions = 0;
    const original = db.withTransaction.bind(db);
    type WithTransaction = <T>(scope: Parameters<typeof original>[0], fn: (client: PoolClient) => Promise<T>) => Promise<T>;
    const instrumented: WithTransaction = async (scope, fn) => {
      transactions += 1;
      return original(scope, async (client) => {
        const query = client.query.bind(client) as PoolClient['query'];
        (client as unknown as { query: unknown }).query = (...args: readonly unknown[]): unknown => {
          issued.push(String(args[0]));
          return (query as unknown as (...a: readonly unknown[]) => unknown)(...args);
        };
        return fn(client);
      });
    };
    (db as unknown as { withTransaction: WithTransaction }).withTransaction = instrumented;
    let cart: CartDto;
    try {
      cart = await service.readCart(m, session);
    } finally {
      (db as unknown as { withTransaction: typeof original }).withTransaction = original;
    }

    // The answer is still the right one — a measurement of a read that did
    // not work would count nothing worth counting.
    expect(cart.lines.map((l) => l.cartLineId)).toEqual(lineIds);

    const own = issued.filter((st) => !BOUNDARY.test(st));
    expect(own, `the read issued ${own.length} statements of its own:\n${own.join('\n--\n')}`).toHaveLength(CART_STATEMENTS_PER_READ);
    expect(CART_STATEMENTS_PER_READ, 'two: the gate and the projection').toBe(2);
    // ONE transaction, so ONE connection: a read that took a second
    // connection would be taking one it does not need.
    expect(transactions, 'the read took more than one connection').toBe(1);
    // What was excluded, stated: the boundary's own COMMIT and nothing else.
    // `BEGIN` and the scope statement are issued before the wrapper sees the
    // client, so they are not in `issued` at all.
    expect(
      issued.filter((st) => BOUNDARY.test(st)).map((st) => st.trim().split(/\s/)[0]?.toUpperCase()),
      'the boundary statements excluded from the count are not the ones expected',
    ).toEqual(['COMMIT']);

    // And they are the plan's own statements, in the plan's own order — the
    // gate and the projection the four COMMANDS are built from, not a second
    // pair that resembles them.
    const plan = cartReadPlan({ tenantId: m.tenantId, businessId: m.businessId, tillSessionId: session, actorUserId: m.userId });
    expect(own).toEqual(plan.map((st) => st.text));
  });

  it('a refused read stops at the gate and never issues the projection', async () => {
    const service = t.app.get(PosCartService);
    const db = t.app.get(Database);
    const tenancy = t.app.get(TenancyService);
    const m: MembershipContext = await tenancy.resolveMembership(cashier.userId, A.businessId);

    const issued: string[] = [];
    const original = db.withTransaction.bind(db);
    type WithTransaction = <T>(scope: Parameters<typeof original>[0], fn: (client: PoolClient) => Promise<T>) => Promise<T>;
    const instrumented: WithTransaction = async (scope, fn) =>
      original(scope, async (client) => {
        const query = client.query.bind(client) as PoolClient['query'];
        (client as unknown as { query: unknown }).query = (...args: readonly unknown[]): unknown => {
          issued.push(String(args[0]));
          return (query as unknown as (...a: readonly unknown[]) => unknown)(...args);
        };
        return fn(client);
      });
    (db as unknown as { withTransaction: WithTransaction }).withTransaction = instrumented;
    let refusal: unknown;
    try {
      await service.readCart(m, colleagueSession).then(
        () => undefined,
        (e: unknown) => {
          refusal = e;
        },
      );
    } finally {
      (db as unknown as { withTransaction: typeof original }).withTransaction = original;
    }

    expect(refusal, 'a colleague’s basket was answered').toBeDefined();
    const own = issued.filter((st) => !BOUNDARY.test(st));
    // ONE statement: a refused read does not go on to project a basket it is
    // not allowed to see. The refusal is therefore not a filter applied after
    // the rows were fetched.
    expect(own, `the refused read issued ${own.length} statements of its own:\n${own.join('\n--\n')}`).toHaveLength(1);
    expect(own[0], 'the one statement a refused read issues is the GATE').toBe(
      cartReadPlan({ tenantId: m.tenantId, businessId: m.businessId, tillSessionId: colleagueSession, actorUserId: m.userId })[0]?.text,
    );
  });
});

/**
 * §8 — THE VARIANT THE CASHIER CHOSE, AND THE BASE VARIANT THEY DID NOT.
 *
 * `0079` declares `pos_cart_lines.variant_id UUID NOT NULL`, so a line for a
 * product with no merchant variants STORES the product's hidden base variant
 * (`product_variants.is_base`, `0053`). The server resolved it; nobody chose
 * it. Reporting it was not merely untidy — it was unusable: `resolveVariants`
 * (`inventory-stock-read.ts:98`) looks a stated variant up as
 * `variant_id = $wanted AND NOT is_base`, so a base id matches NOTHING and
 * the sale came back `inventory.variant_not_found`, "we couldn't find that
 * option", about a product with no options. Found in the browser gate as a
 * 404 on the Arabic sale.
 *
 * So the column means STORAGE and the field means CHOICE. Both halves are
 * asserted, because "the read says null" alone would also pass if the
 * projection had started nulling every variant.
 */
describe('§8 — the cart reports the variant a cashier chose, and null for a product that has no options', () => {
  it('a product with no merchant variants reads back as null, while its ROW still stores the base variant', async () => {
    const res = await read(cashier, A.businessId, session);
    expect(res.status).toBe(200);
    const line = (res.body as unknown as CartDto).lines[0];
    expect(line, 'the basket the whole suite is about is empty').toBeDefined();
    // The CHOICE: null, because this product has no options to choose.
    expect(line?.variantId, 'the cart reported a variant the cashier never chose').toBeNull();
    // And the LAST command answered the same thing, so the read and the four
    // writes cannot disagree about what a line is.
    expect(commandAnswer.lines[0]?.variantId).toBeNull();
    // The STORAGE: not null, and the base variant specifically. This is the
    // half that makes the claim above meaningful — remove the projection's
    // `CASE WHEN v.is_base` and `variantId` becomes this id.
    const { rows } = await ownerPool().query<{ variant_id: string; is_base: boolean }>(
      `SELECT l.variant_id::text AS variant_id, v.is_base
         FROM pos_cart_lines l JOIN product_variants v ON v.id = l.variant_id
        WHERE l.id = $1`,
      [line?.cartLineId],
    );
    expect(rows[0]?.variant_id, 'the row stores no variant, so 0079 is not what this test thinks it is').toBeTruthy();
    expect(rows[0]?.is_base, 'the stored variant is not the base variant, so this case is not the one it claims to be').toBe(true);
  });

  it('CANARY: the null is the projection’s `CASE` and nothing else — the same statement without it reports the id', async () => {
    // The first shape of this canary tried to make the stored variant a
    // merchant one with `UPDATE product_variants SET is_base = false`. The
    // DATABASE refused it — `catalog.base_variant_not_mutable: a base variant
    // is system stock identity and is not a merchant object` — which is a
    // protection working, not an obstacle. So the discrimination is proved
    // without fighting it: run the SHIPPED projection, then run the same text
    // with only the `CASE` removed, over the same row, as the same principal.
    const m: MembershipContext = await t.app.get(TenancyService).resolveMembership(cashier.userId, A.businessId);
    const plan = cartReadPlan({ tenantId: m.tenantId, businessId: m.businessId, tillSessionId: session, actorUserId: m.userId });
    const projection = plan[1];
    expect(projection?.role).toBe('projection');
    const shipped = projection?.text ?? '';
    const CASE_EXPR = 'CASE WHEN v.is_base THEN NULL ELSE l.variant_id END AS variant_id';
    expect(shipped, 'the projection no longer carries the guard this canary is about').toContain(CASE_EXPR);

    const params = [...(projection?.params ?? [])];
    const withGuard = await ownerPool().query<{ variant_id: string | null }>(shipped, params);
    expect(withGuard.rows[0], 'the projection returned no row, so neither half below proves anything').toBeDefined();
    expect(withGuard.rows[0]?.variant_id, 'the shipped projection reported a base variant').toBeNull();

    const withoutGuard = await ownerPool().query<{ variant_id: string | null }>(shipped.replace(CASE_EXPR, 'l.variant_id AS variant_id'), params);
    // Same statement, same row, same connection — only the guard removed. A
    // non-null here is what the guard is suppressing, so the null above is
    // the guard's doing and not an empty column or a filtered row.
    expect(withoutGuard.rows[0]?.variant_id, 'removing the guard changed nothing, so the guard is not what nulls the variant').toBeTruthy();
  });
});

/**
 * §9 — AN EMPTY BASKET STILL HAS A CURRENCY.
 *
 * `recompute` took the cart's currency off the stored LINES, so a basket with
 * no lines answered `currency: ''`. An empty string is not a currency:
 * rendering the totals threw `Unsupported currency:` out of `minorUnitsOf`,
 * a client-side exception in all three locales at all three viewports, and
 * the crash took the till-close step with it.
 *
 * A till has a currency from the moment it is opened
 * (`pos_till_sessions.currency_code`, `CHAR(3) NOT NULL` with a foreign key
 * to `currencies`), so the empty basket reports the SESSION's.
 */
describe('§9 — an emptied basket answers the session’s own currency, not an empty string', () => {
  it('the currency survives removing every line, and equals the till’s own `currency_code`', async () => {
    const { rows } = await ownerPool().query<{ currency_code: string }>(`SELECT currency_code FROM pos_till_sessions WHERE id = $1`, [session]);
    const sessionCurrency = rows[0]?.currency_code ?? '';
    expect(sessionCurrency, 'the session has no currency, so 0079 is not what this test thinks it is').toMatch(/^[A-Z]{3}$/);

    const full = await read(cashier, A.businessId, session);
    expect((full.body as unknown as CartDto).currency, 'a basket WITH lines already disagrees with its till').toBe(sessionCurrency);

    // Empty it through the real route, one line at a time, then read again.
    for (const id of (full.body as unknown as CartDto).lines) {
      const res = await t.request.delete(`${cartPath(session)}/${id.cartLineId}`).set(asMember(cashier, A.businessId));
      expect(res.status, `the removal was refused: ${JSON.stringify(res.body)}`).toBe(200);
      // Every command's own answer must carry it too, not just the read.
      expect((res.body as unknown as CartDto).currency, 'a command answered an empty-string currency').toBe(sessionCurrency);
    }

    const emptied = await read(cashier, A.businessId, session);
    expect(emptied.status).toBe(200);
    expect((emptied.body as unknown as CartDto).lines, 'the basket was not emptied, so this case proves nothing').toEqual([]);
    expect((emptied.body as unknown as CartDto).currency, 'an emptied basket answered an empty-string currency').toBe(sessionCurrency);
    expect((emptied.body as unknown as CartDto).currency).not.toBe('');
  });
});
