/**
 * P3-S8 — ONE BUILDER PER REGISTERED OPERATION KIND (docs/PHASE_3_S8_CONTRACT.md
 * A-06, §5; rulings header: "No Phase 3 routine posts").
 *
 * `OP_KIND_BUILDERS` is keyed by `op_code`. Its keys must EQUAL the registry
 * (`registeredOpKinds()`): T-01 fails on a registered kind without a builder
 * and on a builder for an unregistered kind.
 *
 * A builder prepares the minimum preconditions of its kind through the REAL
 * commands of its slice (never an owner write to a truth table), in the
 * caller's transaction, and returns the honest entry-routine call:
 * - `sql`/`params`: the routine call exactly as the slice's service issues it;
 * - `sha256(claimed)`: the honest `invpl/1` digest of those arguments under a
 *   claimed tenant and business (the slice's own payload builder);
 * - `fields`: every signed payload field altered in turn, as the digest the
 *   altered arguments would carry (the slice's raw claimed stream, so the
 *   builders' semantic refusals never hide a field);
 * - `post(c, rows, carrier?)`: the rest of the COMPOSED command after an
 *   accepted entry call — the entries the service posts in the same
 *   transaction (none for a non-financial kind). `carrier` replaces the
 *   genuine accounting assertion (T-01 row k).
 *
 * `financial` is not read from the routine: no Phase 3 entry routine posts
 * (the service posts after it, seam 2). It is the builder's accounting source
 * types being non-empty; their union is asserted equal (T-01) to the eight
 * source types registered after 0052 plus `reversal`.
 *
 * The slice helpers this reuses: S3 `inventory-commands` / `inventory-posting`
 * (`honestCommand`, `tampers`), S4 `purchase-commands` (`honestS4`,
 * `s4Tampers`, `prepareReceipt`, `receiptPostings`), S5 `purchase-returns`
 * (`receivedPurchase`, `prepareReturn`, `prepareReversal`), S6
 * `supplier-settlement` (`preparePay`, `prepareAllocate`, `prepareRefund`,
 * `sqlReturnToCredit`). The S5 and S6 field alterations mirror the per-slice
 * suites (`purchase-s5-signed-authority`, `settlement-s6-signed-authority`),
 * whose lists are local to those files.
 */
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import {
  associateWarehouseBranchPayload,
  configureProductPayload,
  dissociateWarehouseBranchPayload,
  parseUnitCost,
  type InventoryOperationCode,
} from '../../packages/inventory/src';
import {
  OP_OF as S3_OP_OF,
  ROUTINE_OF as S3_ROUTINE_OF,
  callOf as s3CallOf,
  must,
  payloadOf as s3PayloadOf,
  rawPayloadSha256 as s3RawSha256,
  type Queryable,
  type S3Business,
  type S3Command,
  type S3Kind,
} from './inventory-commands';
import { adjustmentEntry, homeBranch, honestCommand, openingEntry, postEntryInTx, tampers as s3Tampers } from './inventory-posting';
import {
  FULL_CONTACTS,
  OP_OF as S4_OP_OF,
  ROUTINE_OF as S4_ROUTINE_OF,
  callOf as s4CallOf,
  createSupplier,
  honestDraft,
  honestS4,
  payloadOf as s4PayloadOf,
  postInTx,
  prepareReceipt,
  rawPayloadSha256 as s4RawSha256,
  receiptPostings,
  runCommand as runS4,
  s4Tampers,
  type S4Command,
  type S4Kind,
} from './purchase-commands';
import {
  S5_OP_OF,
  S5_ROUTINE_OF,
  callOf as s5CallOf,
  payloadOf as s5PayloadOf,
  postReversalInTx,
  prepareReturn,
  prepareReversal,
  rawPayloadSha256 as s5RawSha256,
  receivedPurchase,
  type ReturnCommand,
  type ReverseCommand,
  type S5Command,
  type S5Kind,
} from './purchase-returns';
import {
  S6_OP_OF,
  S6_ROUTINE_OF,
  castsOf,
  claimedSha256,
  createMethod,
  methodCreateCall,
  methodLifecycleCall,
  methodRevision,
  methodUpdateCall,
  prepareAllocate,
  preparePay,
  prepareRefund,
  runS6,
  sqlOf,
  sqlReturnToCredit,
  withElement,
  withParam,
  type S6Call,
  type S6Kind,
} from './supplier-settlement';
import { mintTestInventoryAssertion } from './test-app';

export type Biz = { readonly tenantId: string; readonly businessId: string };

export type RegisteringSlice = 'P3-S1' | 'P3-S3' | 'P3-S4' | 'P3-S5' | 'P3-S6';

/** One signed payload field, altered: the digest the altered arguments carry under a claimed business. */
export interface SignedField {
  readonly field: string;
  readonly sha256: (claimed: Biz) => string;
}

export type ResultRow = Readonly<Record<string, unknown>>;

/** The honest entry-routine call of one kind, prepared in a business. */
export interface PreparedKind {
  readonly sql: string;
  readonly params: readonly unknown[];
  /** The business transaction id the call and its entries run under. */
  readonly trace: string;
  readonly sha256: (claimed: Biz) => string;
  readonly fields: readonly SignedField[];
  /** The rest of the composed command after an accepted call; answers how many entries it posted. */
  readonly post: (c: Queryable, rows: readonly ResultRow[], accountingCarrier?: string) => Promise<number>;
}

/** What every builder may use: the business it prepares in, another business of the same tenant (for alternative ids), and its cash account. */
export interface OpKindFixture {
  readonly biz: S3Business;
  readonly other: S3Business;
  readonly cashAccountId: string;
}

export interface OpKindBuilder {
  readonly op: InventoryOperationCode;
  readonly slice: RegisteringSlice;
  /** The entry routine, as `oid::regprocedure::text`. */
  readonly routine: string;
  /** The accounting source types the composed command posts. */
  readonly accountingSourceTypes: readonly string[];
  readonly financial: boolean;
  prepare(c: Client, fx: OpKindFixture): Promise<PreparedKind>;
}

const NOTHING_POSTED = (): Promise<number> => Promise.resolve(0);

function textOf(rows: readonly ResultRow[], i: number, column: string): string {
  const v = rows[i]?.[column];
  if (typeof v !== 'string') throw new Error(`result column ${column} of row ${i} is not text`);
  return v;
}

function builder(
  op: InventoryOperationCode,
  slice: RegisteringSlice,
  routine: string,
  accountingSourceTypes: readonly string[],
  prepare: (c: Client, fx: OpKindFixture) => Promise<PreparedKind>,
): OpKindBuilder {
  return { op, slice, routine, accountingSourceTypes, financial: accountingSourceTypes.length > 0, prepare };
}

// ── P3-S1 ──────────────────────────────────────────────────────────────────

const CONFIGURE_SQL = `SELECT * FROM inventory_configure_product($1::uuid, $2::boolean, $3::text, $4::smallint)`;
const PAIR_SQL = (name: string): string => `SELECT ${name}($1::uuid, $2::uuid) AS changed`;

/** An unconfigured simple product, in the caller's transaction (the translation check is deferred). */
async function unconfiguredProduct(c: Queryable, businessId: string): Promise<string> {
  const id = randomUUID();
  await c.query(`INSERT INTO products (business_id, id, base_price_minor, price_currency) VALUES ($1, $2, 500, 'ILS')`, [businessId, id]);
  await c.query(`INSERT INTO product_translations (business_id, product_id, locale, name) VALUES ($1, $2, 'en', 'Matrix product')`, [businessId, id]);
  return id;
}

interface ConfigureArgs {
  readonly productId: string;
  readonly trackInventory: boolean;
  readonly unitCode: string | null;
  readonly unitDecimals: number | null;
}

const configureSha = (a: ConfigureArgs) => (b: Biz) => configureProductPayload({ ...b, ...a }).sha256;

async function prepareConfigure(c: Client, fx: OpKindFixture): Promise<PreparedKind> {
  const a: ConfigureArgs = { productId: await unconfiguredProduct(c, fx.biz.businessId), trackInventory: true, unitCode: 'piece', unitDecimals: 0 };
  return {
    sql: CONFIGURE_SQL,
    params: [a.productId, a.trackInventory, a.unitCode, a.unitDecimals],
    trace: randomUUID(),
    sha256: configureSha(a),
    fields: [
      { field: 'product id', sha256: configureSha({ ...a, productId: randomUUID() }) },
      { field: 'track inventory', sha256: configureSha({ ...a, trackInventory: false }) },
      { field: 'unit code', sha256: configureSha({ ...a, unitCode: 'kg' }) },
      { field: 'unit decimals', sha256: configureSha({ ...a, unitDecimals: 3 }) },
    ],
    post: NOTHING_POSTED,
  };
}

function preparePair(kind: 'associate' | 'dissociate') {
  const payload = kind === 'associate' ? associateWarehouseBranchPayload : dissociateWarehouseBranchPayload;
  const sha = (warehouseId: string, branchId: string) => (b: Biz) => payload({ ...b, warehouseId, branchId }).sha256;
  return async (c: Client, fx: OpKindFixture): Promise<PreparedKind> => {
    const { w1, branchY } = fx.biz;
    if (kind === 'dissociate') {
      // The association to remove, made through the real command.
      await runPair(c, fx.biz, 'associate', w1, branchY);
    }
    return {
      sql: PAIR_SQL(`structure_${kind}_warehouse_branch`),
      params: [w1, branchY],
      trace: randomUUID(),
      sha256: sha(w1, branchY),
      fields: [
        { field: 'warehouse', sha256: sha(fx.biz.w2, branchY) },
        { field: 'branch', sha256: sha(w1, fx.biz.branchX) },
      ],
      post: NOTHING_POSTED,
    };
  };
}

async function runPair(c: Queryable, biz: S3Business, kind: 'associate' | 'dissociate', warehouseId: string, branchId: string): Promise<void> {
  const payload = kind === 'associate' ? associateWarehouseBranchPayload : dissociateWarehouseBranchPayload;
  const op = kind === 'associate' ? 'structure.associate_warehouse_branch' : 'structure.dissociate_warehouse_branch';
  const assertion = mintHonest(biz, op, payload({ ...biz, warehouseId, branchId }).sha256);
  await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true), set_config('app.inventory_assertion', $3, true)`, [
    biz.tenantId,
    biz.businessId,
    assertion,
  ]);
  await c.query('SET LOCAL ROLE daftar_app');
  await c.query(PAIR_SQL(`structure_${kind}_warehouse_branch`), [warehouseId, branchId]);
  await c.query('RESET ROLE');
}

// ── P3-S3 ──────────────────────────────────────────────────────────────────

const S3_SOURCE_TYPES: Readonly<Record<S3Kind, readonly string[]>> = {
  transfer: [],
  adjust: ['inventory_adjustment'],
  damage: ['inventory_adjustment'],
  stocktake_open: [],
  stocktake_count: [],
  stocktake_finalize: ['inventory_adjustment'],
  opening: ['inventory_opening'],
};

/** The entry an adjustment, damage or finalization owes, posted as `runFinancial` posts it. */
async function postS3(c: Queryable, biz: S3Business, cmd: S3Command, trace: string, rows: readonly ResultRow[], carrier?: string): Promise<number> {
  if (cmd.kind === 'opening') {
    if (textOf(rows, 0, 'case_kind') !== 'ledger_posting') return 0;
    const per = new Map<string, bigint>();
    rows.forEach((_, i) => {
      const wh = textOf(rows, i, 'warehouse_id');
      per.set(wh, (per.get(wh) ?? 0n) + BigInt(textOf(rows, i, 'value')));
    });
    const perWarehouse = [];
    for (const [warehouseId, valueMinor] of per) perWarehouse.push({ warehouseId, branchId: await homeBranch(c, biz.businessId, warehouseId), valueMinor });
    const command = openingEntry(biz, { sourceId: cmd.openingId, occurredOn: cmd.occurredOn, perWarehouse, trace });
    if (command === null) return 0;
    await postEntryInTx(c, command, biz.userId, carrier);
    return 1;
  }
  if (cmd.kind !== 'adjust' && cmd.kind !== 'damage' && cmd.kind !== 'stocktake_finalize') return 0;
  if (cmd.kind === 'stocktake_finalize' && cmd.outcome === 'cancelled') return 0;
  const command = adjustmentEntry(biz, {
    sourceId: cmd.kind === 'stocktake_finalize' ? cmd.stocktakeId : cmd.adjustmentId,
    occurredOn: must(cmd.occurredOn, 'occurredOn'),
    warehouseId: cmd.warehouseId,
    branchId: await homeBranch(c, biz.businessId, cmd.warehouseId),
    netValueMinor: BigInt(textOf(rows, 0, 'total')),
    trace,
  });
  if (command === null) return 0;
  await postEntryInTx(c, command, biz.userId, carrier);
  return 1;
}

function s3Builder(kind: S3Kind): OpKindBuilder {
  return builder(S3_OP_OF[kind], 'P3-S3', S3_ROUTINE_OF[kind], S3_SOURCE_TYPES[kind], async (c, fx) => {
    const cmd = await honestCommand(c, fx.biz, kind);
    const { sql, params } = s3CallOf(cmd);
    const trace = randomUUID();
    return {
      sql,
      params,
      trace,
      sha256: (b) => s3PayloadOf(b, cmd).payload.sha256,
      fields: s3Tampers(cmd, fx.other).map((t) => ({ field: t.field, sha256: (b: Biz) => s3RawSha256(b, t.cmd) })),
      post: (q, rows, carrier) => postS3(q, fx.biz, cmd, trace, rows, carrier),
    };
  });
}

// ── P3-S4 ──────────────────────────────────────────────────────────────────

function s4Prepared(cmd: S4Command, other: S3Business, trace: string, post: PreparedKind['post']): PreparedKind {
  const { sql, params } = s4CallOf(cmd);
  return {
    sql,
    params,
    trace,
    sha256: (b) => s4PayloadOf(b, cmd).payload.sha256,
    fields: s4Tampers(cmd, other).map((t) => ({ field: t.field, sha256: (b: Biz) => s4RawSha256(b, t.cmd) })),
    post,
  };
}

function s4Builder(kind: S4Kind): OpKindBuilder {
  if (kind === 'purchase_receive') {
    return builder(S4_OP_OF[kind], 'P3-S4', S4_ROUTINE_OF[kind], ['purchase', 'negative_inventory_cost_adjustment'], async (c, fx) => {
      const draft = await honestDraft(c, fx.biz, await createSupplier(c, fx.biz, FULL_CONTACTS));
      await runS4(c, fx.biz, draft);
      const prepared = await prepareReceipt(c, fx.biz, draft.purchaseId);
      const trace = randomUUID();
      return s4Prepared(prepared.cmd, fx.other, trace, async (q, _rows, carrier) => {
        const postings = receiptPostings(fx.biz, prepared, trace);
        await postInTx(q, postings.purchase, fx.biz.userId, carrier);
        if (postings.catchUp === null) return 1;
        await postInTx(q, postings.catchUp, fx.biz.userId, carrier);
        return 2;
      });
    });
  }
  return builder(S4_OP_OF[kind], 'P3-S4', S4_ROUTINE_OF[kind], [], async (c, fx) =>
    s4Prepared(await honestS4(c, fx.biz, kind), fx.other, randomUUID(), NOTHING_POSTED),
  );
}

// ── P3-S5 ──────────────────────────────────────────────────────────────────

/** Every bound field of an S5 command changed one at a time (the `purchase-s5-signed-authority` list). */
function s5Fields(cmd: S5Command, other: S3Business): SignedField[] {
  const id = randomUUID();
  const f = (field: string, altered: S5Command): SignedField => ({ field, sha256: (b) => s5RawSha256(b, altered) });
  if (cmd.kind === 'purchase_return') {
    const l = must(cmd.lines[0]);
    const withLine = (over: Partial<ReturnCommand['lines'][number]>): ReturnCommand => ({ ...cmd, lines: [{ ...l, ...over }, ...cmd.lines.slice(1)] });
    return [
      f('return id', { ...cmd, returnId: id }),
      f('purchase id', { ...cmd, purchaseId: id }),
      f('warehouse', { ...cmd, warehouseId: other.w1 }),
      f('document date', { ...cmd, documentDate: '2026-01-02' }),
      f('reason', { ...cmd, reason: `${cmd.reason ?? ''}.` }),
      f('credit note id', { ...cmd, creditNoteId: id }),
      f('carrying', { ...cmd, carryingTxnMinor: cmd.carryingTxnMinor + 1n }),
      f('ap txn', { ...cmd, apTxnMinor: cmd.apTxnMinor - 1n }),
      f('ap base', { ...cmd, apBaseMinor: cmd.apBaseMinor + 1n }),
      f('credit txn', { ...cmd, creditTxnMinor: cmd.creditTxnMinor + 1n }),
      f('credit base', { ...cmd, creditBaseMinor: cmd.creditBaseMinor + 1n }),
      f('inventory value', { ...cmd, inventoryValueMinor: cmd.inventoryValueMinor + 1n }),
      f('ppv', { ...cmd, ppvMinor: cmd.ppvMinor - 1n }),
      f('line id', withLine({ returnLineId: id })),
      f('line purchase line', withLine({ purchaseLineId: id })),
      f('line variant', withLine({ variantId: other.piece.variantId })),
      f('line qty', withLine({ qtyQ4: l.qtyQ4 + 1n })),
      f('line carrying', withLine({ carryingTxnMinor: l.carryingTxnMinor + 1n })),
      f('line value out', withLine({ valueOutMinor: l.valueOutMinor + 1n })),
      f('a line dropped', { ...cmd, lines: cmd.lines.slice(1) }),
      f('the line order', { ...cmd, lines: [...cmd.lines].reverse() }),
    ];
  }
  const l = must(cmd.lines[0]);
  const withLine = (over: Partial<ReverseCommand['lines'][number]>): ReverseCommand => ({ ...cmd, lines: [{ ...l, ...over }, ...cmd.lines.slice(1)] });
  return [
    f('purchase id', { ...cmd, purchaseId: id }),
    f('warehouse', { ...cmd, warehouseId: other.w1 }),
    f('reversal date', { ...cmd, reversalDate: '2026-01-02' }),
    f('reason', { ...cmd, reason: `${cmd.reason ?? ''}.` }),
    f('original entry id', { ...cmd, originalEntryId: id }),
    f('total', { ...cmd, totalValueMinor: cmd.totalValueMinor + 1n }),
    f('line id', withLine({ lineId: id })),
    f('line variant', withLine({ variantId: other.piece.variantId })),
    f('line qty', withLine({ qtyQ4: l.qtyQ4 - 1n })),
    f('line value', withLine({ valueMinor: l.valueMinor - 1n })),
    f('a line dropped', { ...cmd, lines: cmd.lines.slice(1) }),
    f('the line order', { ...cmd, lines: [...cmd.lines].reverse() }),
  ];
}

async function twoLinePurchase(c: Client, biz: S3Business): Promise<{ purchaseId: string; lineIds: [string, string] }> {
  const p = await receivedPurchase(c, biz, [
    { variantId: biz.piece.variantId, qty: '4', unitPriceMinor: '100' },
    { variantId: biz.piece2.variantId, qty: '2', unitPriceMinor: '70' },
  ]);
  return { purchaseId: p.purchaseId, lineIds: [must(p.lines[0]).lineId, must(p.lines[1]).lineId] };
}

function s5Builder(kind: S5Kind): OpKindBuilder {
  const sourceTypes = kind === 'purchase_return' ? ['supplier_return'] : ['reversal'];
  return builder(S5_OP_OF[kind], 'P3-S5', S5_ROUTINE_OF[kind], sourceTypes, async (c, fx) => {
    const p = await twoLinePurchase(c, fx.biz);
    if (kind === 'purchase_return') {
      const r = await prepareReturn(c, fx.biz, p.purchaseId, {
        lines: [
          { purchaseLineId: p.lineIds[0], qty: '1' },
          { purchaseLineId: p.lineIds[1], qty: '2' },
        ],
        reason: 'Damaged on arrival',
      });
      const { sql, params } = s5CallOf(r.cmd);
      return {
        sql,
        params,
        trace: r.trace,
        sha256: (b) => s5PayloadOf(b, r.cmd).payload.sha256,
        fields: s5Fields(r.cmd, fx.other),
        post: async (q, _rows, carrier) => {
          await postInTx(q, r.posting, fx.biz.userId, carrier);
          return 1;
        },
      };
    }
    const r = await prepareReversal(c, fx.biz, p.purchaseId);
    const { sql, params } = s5CallOf(r.cmd);
    return {
      sql,
      params,
      trace: r.trace,
      sha256: (b) => s5PayloadOf(b, r.cmd).payload.sha256,
      fields: s5Fields(r.cmd, fx.other),
      post: async (q, _rows, carrier) => {
        await postReversalInTx(q, fx.biz, r, carrier);
        return 1;
      },
    };
  });
}

// ── P3-S6 ──────────────────────────────────────────────────────────────────

const SYSTEM_TYPE_SWAP: Readonly<Record<string, string>> = { cash: 'wallet', manual: 'base', base: 'manual' };

/** One argument of SQL type `cast` changed so that its `invpl/1` field changes (the `settlement-s6-signed-authority` rule). */
function changedArgument(value: unknown, cast: string): unknown {
  switch (cast) {
    case 'uuid':
      return randomUUID();
    case 'boolean':
      return value !== true;
    case 'integer':
      if (typeof value !== 'number') throw new Error(`integer argument ${String(value)}`);
      return value + 1;
    case 'bigint':
      return (BigInt(String(value)) + 1n).toString(10);
    case 'date':
      return new Date(Date.parse(`${String(value)}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    case 'char(3)':
      return value === 'EUR' ? 'USD' : 'EUR';
    case 'numeric': {
      const r = parseUnitCost(String(value)) + 1n;
      const scale = 10_000_000_000n;
      return `${(r / scale).toString(10)}.${(r % scale).toString(10).padStart(10, '0')}`;
    }
    case 'timestamptz':
      return new Date(Date.parse(String(value)) + 1000).toISOString();
    case 'text':
      if (value === null) return 'Tampered';
      if (/^[A-Z]{3}$/.test(String(value))) return value === 'EUR' ? 'USD' : 'EUR';
      return SYSTEM_TYPE_SWAP[String(value)] ?? `${String(value)}.`;
    default:
      throw new Error(`no change for ${cast}`);
  }
}

/** Every argument changed in turn, every element of every array argument, the arrays shortened and reordered. */
function s6Fields(call: S6Call): SignedField[] {
  const casts = castsOf(call.kind);
  const out: SignedField[] = [];
  const f = (field: string, altered: S6Call): SignedField => ({ field, sha256: (b) => claimedSha256(b, altered) });
  casts.forEach((cast, i) => {
    const value = call.params[i];
    if (cast.endsWith('[]')) {
      const elements = Array.isArray(value) ? value.map((x) => String(x)) : [];
      elements.forEach((e, k) => out.push(f(`argument ${i + 1}[${k + 1}] (${cast})`, withElement(call, i, k, String(changedArgument(e, cast.slice(0, -2)))))));
    } else {
      out.push(f(`argument ${i + 1} (${cast})`, withParam(call, i, changedArgument(value, cast))));
    }
  });
  const arrays = casts.flatMap((cast, i) => (cast.endsWith('[]') ? [i] : []));
  if (arrays.length > 0) {
    const reshape = (g: (xs: readonly unknown[]) => unknown[]): S6Call =>
      arrays.reduce<S6Call>((acc, i) => withParam(acc, i, g(Array.isArray(acc.params[i]) ? acc.params[i] : [])), call);
    out.push(
      f(
        'an allocation dropped',
        reshape((xs) => xs.slice(0, 1)),
      ),
    );
    out.push(
      f(
        'the allocation order',
        reshape((xs) => [...xs].reverse()),
      ),
    );
  }
  return out;
}

const S6_SOURCE_TYPES_OF: Readonly<Record<S6Kind, readonly string[]>> = {
  method_create: [],
  method_update: [],
  method_deactivate: [],
  method_activate: [],
  pay: ['supplier_payment'],
  allocate_credit: ['supplier_credit_allocation'],
  receive_refund: ['supplier_refund'],
};

async function aMethod(c: Client, fx: OpKindFixture): Promise<{ id: string; revision: number }> {
  const id = await createMethod(c, fx.biz, { postingAccountId: fx.cashAccountId });
  return { id, revision: await methodRevision(c, fx.biz.businessId, id) };
}

/** The honest call of `kind` (the `settlement-s6-signed-authority` preparation). */
async function honestS6(c: Client, fx: OpKindFixture, kind: S6Kind): Promise<S6Call> {
  const biz = fx.biz;
  switch (kind) {
    case 'method_create':
      return methodCreateCall(biz, { postingAccountId: fx.cashAccountId, sortOrder: 20 });
    case 'method_update': {
      const m = await aMethod(c, fx);
      return methodUpdateCall(biz, m.id, m.revision, { postingAccountId: fx.cashAccountId, sortOrder: 30, names: { ar: 'بنك', en: 'Bank', tr: 'Banka' } });
    }
    case 'method_deactivate': {
      const m = await aMethod(c, fx);
      return methodLifecycleCall(biz, 'method_deactivate', m.id, m.revision);
    }
    case 'method_activate': {
      const m = await aMethod(c, fx);
      await runS6(c, biz, methodLifecycleCall(biz, 'method_deactivate', m.id, m.revision));
      return methodLifecycleCall(biz, 'method_activate', m.id, await methodRevision(c, biz.businessId, m.id));
    }
    case 'pay': {
      const m = await aMethod(c, fx);
      const p1 = await receivedPurchase(c, biz, [{ variantId: biz.piece.variantId, qty: '2', unitPriceMinor: '1000' }]);
      const p2 = await receivedPurchase(c, biz, [{ variantId: biz.piece2.variantId, qty: '1', unitPriceMinor: '700' }], { supplierId: p1.supplierId });
      return preparePay(c, biz, {
        supplierId: p1.supplierId,
        paymentMethodId: m.id,
        reference: 'TRF-1',
        allocations: [
          { purchaseId: p1.purchaseId, paymentAmountMinor: 1200n },
          { purchaseId: p2.purchaseId, paymentAmountMinor: 300n },
        ],
      });
    }
    case 'allocate_credit': {
      const m = await aMethod(c, fx);
      const n = await sqlReturnToCredit(c, biz, m.id);
      const target = await receivedPurchase(c, biz, [{ variantId: biz.piece.variantId, qty: '1', unitPriceMinor: '900' }], {
        supplierId: n.purchase.supplierId,
      });
      return prepareAllocate(c, biz, { creditNoteId: n.creditNoteId, purchaseId: target.purchaseId, consumedMinor: 600n });
    }
    case 'receive_refund': {
      const m = await aMethod(c, fx);
      const n = await sqlReturnToCredit(c, biz, m.id);
      return prepareRefund(c, biz, { creditNoteId: n.creditNoteId, paymentMethodId: m.id, consumedMinor: 400n, reference: 'RF-1' });
    }
  }
}

function s6Builder(kind: S6Kind): OpKindBuilder {
  return builder(S6_OP_OF[kind], 'P3-S6', S6_ROUTINE_OF[kind], S6_SOURCE_TYPES_OF[kind], async (c, fx) => {
    const call = await honestS6(c, fx, kind);
    return {
      sql: sqlOf(kind),
      params: [...call.params],
      trace: call.trace,
      sha256: (b) => claimedSha256(b, call),
      fields: s6Fields(call),
      post: async (q, _rows, carrier) => {
        for (const command of call.postings) await postInTx(q, command, fx.biz.userId, carrier);
        return call.postings.length;
      },
    };
  });
}

// ── the registry of builders ───────────────────────────────────────────────

const ALL: readonly OpKindBuilder[] = [
  builder('inventory.configure_product', 'P3-S1', 'inventory_configure_product(uuid,boolean,text,smallint)', [], prepareConfigure),
  builder('structure.associate_warehouse_branch', 'P3-S1', 'structure_associate_warehouse_branch(uuid,uuid)', [], preparePair('associate')),
  builder('structure.dissociate_warehouse_branch', 'P3-S1', 'structure_dissociate_warehouse_branch(uuid,uuid)', [], preparePair('dissociate')),
  ...(['transfer', 'adjust', 'damage', 'stocktake_open', 'stocktake_count', 'stocktake_finalize', 'opening'] as const).map(s3Builder),
  ...(['supplier_create', 'supplier_update', 'supplier_archive', 'supplier_reactivate', 'purchase_draft', 'purchase_cancel', 'purchase_receive'] as const).map(
    s4Builder,
  ),
  ...(['purchase_return', 'purchase_reverse'] as const).map(s5Builder),
  ...(['method_create', 'method_update', 'method_deactivate', 'method_activate', 'pay', 'allocate_credit', 'receive_refund'] as const).map(s6Builder),
];

export const OP_KIND_BUILDERS: Readonly<Record<string, OpKindBuilder>> = Object.fromEntries(ALL.map((b) => [b.op, b]));

// ── minting ────────────────────────────────────────────────────────────────

/** The assertion the service would mint for `op` in `biz` over `payloadSha256` (the package minter, the test key). */
export function mintHonest(
  biz: Biz & { readonly userId: string },
  op: InventoryOperationCode,
  payloadSha256: string,
  o: { readonly now?: Date; readonly jti?: string } = {},
): string {
  return mintTestInventoryAssertion(
    { actorUserId: biz.userId, tenantId: biz.tenantId, businessId: biz.businessId, opCode: op, payloadSha256, ...(o.jti === undefined ? {} : { jti: o.jti }) },
    o.now ?? new Date(),
  );
}
