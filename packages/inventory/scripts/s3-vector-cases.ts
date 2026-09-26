/**
 * The shared P3-S3 vectors, as pure functions (PHASE_3_S3_CONTRACT §4.1, T-16).
 *
 * `scripts/generate-s3-vectors.ts` writes:
 *
 * - `vectors/invpl-s3-vectors.json` — the `invpl/1` payload AND intent streams
 *   of the seven P3-S3 kinds, built by `src/movement-payloads.ts`, plus the
 *   reason-word cases of `src/reason-digest.ts`;
 * - `vectors/allocation-vectors.json` — the largest-remainder split and the
 *   opening valuation of `src/allocation.ts`, with LITERAL expected numbers
 *   computed by hand. The generator refuses to write a file in which the
 *   package disagrees with them, so the JSON records the SPEC, not whatever
 *   the code happens to do.
 *
 * `test/movement-payloads.test.ts` and `test/allocation.test.ts` rebuild both
 * and require the committed files to be byte-identical. The SQL
 * canonicalizer, `inventory_reason_words` and `inventory_largest_remainder`
 * are tested against the SAME files (T-16); nobody hand-copies a vector.
 *
 * Every integer is written as decimal TEXT, because a value may exceed 2^53.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { format, resolveConfig } from 'prettier';
import { allocateOpening, largestRemainder } from '../src/allocation';
import { parseDecimal } from '../src/fixed-point';
import {
  adjustPayload,
  damagePayload,
  openingPayload,
  stocktakeCountPayload,
  stocktakeFinalizePayload,
  stocktakeOpenPayload,
  toC10,
  toQ4,
  transferPayload,
  type MovementPayload,
} from '../src/movement-payloads';
import {
  INVENTORY_PAYLOAD_SCHEMAS,
  inventoryIntentSchema,
  type InventoryPayloadFieldSpec,
  type InventoryPayloadSchema,
  type InventoryS3OperationCode,
} from '../src/payload';
import { reasonWords } from '../src/reason-digest';

// ── Shapes ───────────────────────────────────────────────────────────────

/** One field of an expanded stream: its schema name, its type, and its canonical text or JSON null for SQL NULL. */
export interface S3VectorField {
  readonly name: string;
  readonly type: InventoryPayloadFieldSpec['type'];
  readonly value: string | null;
}

export interface S3StreamVector {
  readonly fields: readonly S3VectorField[];
  readonly canonicalHex: string;
  readonly sha256: string;
}

export interface S3PayloadVector {
  readonly id: string;
  readonly why: string;
  readonly opCode: InventoryS3OperationCode;
  readonly tenantId: string;
  readonly businessId: string;
  /** The builder input, with fixed-point integers as decimal text. Documentation of the routine arguments. */
  readonly input: Readonly<Record<string, unknown>>;
  readonly payload: S3StreamVector;
  readonly intent: S3StreamVector;
}

export interface ReasonVector {
  readonly id: string;
  readonly why: string;
  readonly reason: string;
  readonly utf8Hex: string;
  readonly sha256: string;
  readonly words: readonly string[];
}

export interface InvplS3Vectors {
  readonly spec: string;
  readonly note: string;
  readonly reasons: readonly ReasonVector[];
  readonly cases: readonly S3PayloadVector[];
}

export interface AllocationCase {
  readonly id: string;
  readonly why: string;
  /** NUMERIC text, each >= 0. */
  readonly weights: readonly string[];
  readonly total: string;
  readonly shares: readonly string[];
}

export interface OpeningAllocationCase {
  readonly id: string;
  readonly why: string;
  /** `NUMERIC(18,4)` quantity and `NUMERIC(28,10)` unit cost, as the routine receives them. */
  readonly lines: readonly { readonly qty: string; readonly unitCost: string }[];
  /** `inventory_half_even(Σ qty × cost, 1, 0)`. */
  readonly total: string;
  readonly shares: readonly string[];
  /** Case B only: the opening position, and whether the stock total matches it (A-13). */
  readonly caseB: { readonly positionMinor: string; readonly outcome: 'match' | 'inventory.opening_valuation_mismatch' } | null;
}

export interface AllocationVectors {
  readonly version: string;
  readonly note: string;
  readonly cases: readonly AllocationCase[];
  readonly openings: readonly OpeningAllocationCase[];
}

// ── Identifiers (fixed test material) ────────────────────────────────────

const T = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const B = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const DOC = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const DOC2 = '8d0f778a-8536-41ef-a55c-f18fd2a01bf8';
const W1 = '3d6a4adc-4fc3-11d2-9a0c-0305e82c3303';
const W2 = '4e7b5bed-50d4-41d2-8a0c-0305e82c3304';
const V1 = '16fd2706-8baf-433b-82eb-8c7fada847da';
const V2 = '2a9c1b4e-6f3d-4e8a-b1c7-5d0e9f2a3b4c';
const V3 = 'c56a4180-65aa-42ec-a945-5fd21dec0538';
const OB = '5e2d1f0a-9b8c-4d7e-8f6a-1b2c3d4e5f60';

const REASON_ASCII = 'Water damage in aisle 4';
const REASON_ARABIC = 'تلف بسبب الرطوبة — المستودع ٢ 📦';

// ── invpl/1 cases ────────────────────────────────────────────────────────

type Build = () => MovementPayload;

interface RawCase {
  readonly id: string;
  readonly why: string;
  readonly opCode: InventoryS3OperationCode;
  readonly input: Readonly<Record<string, unknown>>;
  readonly build: Build;
}

/** Declares a case whose builder input is recorded verbatim (bigint rendered as text). */
function kase<I extends object>(id: string, why: string, opCode: InventoryS3OperationCode, input: I, builder: (i: I) => MovementPayload): RawCase {
  return { id, why, opCode, input: Object.fromEntries(Object.entries(input)), build: () => builder(input) };
}

const tb = { tenantId: T, businessId: B };

const rawCases: readonly RawCase[] = [
  // inventory.transfer
  kase(
    'S3-TRF-01',
    'one line, a whole quantity',
    'inventory.transfer',
    { ...tb, transferId: DOC, sourceWarehouseId: W1, destinationWarehouseId: W2, lines: [{ variantId: V1, qtyQ4: toQ4('5') }] },
    transferPayload,
  ),
  kase(
    'S3-TRF-02',
    'three lines in request order, fractional quantities as exact Q4 integers',
    'inventory.transfer',
    {
      ...tb,
      transferId: DOC,
      sourceWarehouseId: W1,
      destinationWarehouseId: W2,
      lines: [
        { variantId: V3, qtyQ4: toQ4('0.25') },
        { variantId: V1, qtyQ4: toQ4('12.3456') },
        { variantId: V2, qtyQ4: toQ4('99999999.9999') },
      ],
    },
    transferPayload,
  ),
  kase(
    'S3-TRF-03',
    'S3-TRF-01 with the two warehouses swapped: a different digest',
    'inventory.transfer',
    { ...tb, transferId: DOC, sourceWarehouseId: W2, destinationWarehouseId: W1, lines: [{ variantId: V1, qtyQ4: toQ4('5') }] },
    transferPayload,
  ),

  // inventory.adjust
  kase(
    'S3-ADJ-01',
    'one gain at an explicit cost (AL08-ADJ-POS shape: 2 at 110.5 = 221)',
    'inventory.adjust',
    {
      ...tb,
      adjustmentId: DOC,
      warehouseId: W1,
      occurredOn: '2026-09-26',
      reason: REASON_ASCII,
      lines: [{ variantId: V1, qtyDeltaQ4: toQ4('2'), unitCostC10: toC10('110.5'), expectedValue: 221n }],
    },
    adjustPayload,
  ),
  kase(
    'S3-ADJ-02',
    'one loss: negative qty_delta_q4, NULL unit_cost_c10, negative expected_value',
    'inventory.adjust',
    {
      ...tb,
      adjustmentId: DOC,
      warehouseId: W1,
      occurredOn: '2026-09-26',
      reason: REASON_ASCII,
      lines: [{ variantId: V1, qtyDeltaQ4: -toQ4('3'), unitCostC10: null, expectedValue: -300n }],
    },
    adjustPayload,
  ),
  kase(
    'S3-ADJ-03',
    'S3-ADJ-02 with a different expected_value: the SAME intent digest, a different payload digest',
    'inventory.adjust',
    {
      ...tb,
      adjustmentId: DOC,
      warehouseId: W1,
      occurredOn: '2026-09-26',
      reason: REASON_ASCII,
      lines: [{ variantId: V1, qtyDeltaQ4: -toQ4('3'), unitCostC10: null, expectedValue: -301n }],
    },
    adjustPayload,
  ),
  kase(
    'S3-ADJ-04',
    'three lines, mixed signs, one with expected_value 0, and a multi-byte UTF-8 reason',
    'inventory.adjust',
    {
      ...tb,
      adjustmentId: DOC2,
      warehouseId: W2,
      occurredOn: '2024-02-29',
      reason: REASON_ARABIC,
      lines: [
        { variantId: V2, qtyDeltaQ4: toQ4('1.5'), unitCostC10: toC10('0.0000000001'), expectedValue: 0n },
        { variantId: V1, qtyDeltaQ4: -toQ4('0.0001'), unitCostC10: null, expectedValue: 0n },
        { variantId: V3, qtyDeltaQ4: toQ4('10'), unitCostC10: toC10('3.3333333333'), expectedValue: 33n },
      ],
    },
    adjustPayload,
  ),
  kase(
    'S3-ADJ-05',
    'transfer vs adjust over identical ids: same document, warehouse and variant as S3-TRF-01, a different digest',
    'inventory.adjust',
    {
      ...tb,
      adjustmentId: DOC,
      warehouseId: W1,
      occurredOn: '2026-09-26',
      reason: REASON_ASCII,
      lines: [{ variantId: V1, qtyDeltaQ4: toQ4('5'), unitCostC10: toC10('0'), expectedValue: 0n }],
    },
    adjustPayload,
  ),

  // inventory.damage
  kase(
    'S3-DMG-01',
    'one write-off with a negative expected_value',
    'inventory.damage',
    {
      ...tb,
      adjustmentId: DOC,
      warehouseId: W1,
      occurredOn: '2026-09-26',
      reason: REASON_ASCII,
      lines: [{ variantId: V1, qtyQ4: toQ4('3'), expectedValue: -300n }],
    },
    damagePayload,
  ),
  kase(
    'S3-DMG-02',
    'a write-off valued at zero (a key whose average is zero)',
    'inventory.damage',
    {
      ...tb,
      adjustmentId: DOC,
      warehouseId: W1,
      occurredOn: '2026-09-26',
      reason: REASON_ASCII,
      lines: [{ variantId: V1, qtyQ4: toQ4('3'), expectedValue: 0n }],
    },
    damagePayload,
  ),
  kase(
    'S3-DMG-03',
    'three lines with the multi-byte reason, one valued at the -10^18 bound',
    'inventory.damage',
    {
      ...tb,
      adjustmentId: DOC2,
      warehouseId: W2,
      occurredOn: '2026-01-01',
      reason: REASON_ARABIC,
      lines: [
        { variantId: V1, qtyQ4: toQ4('1'), expectedValue: -1n },
        { variantId: V2, qtyQ4: toQ4('0.5'), expectedValue: -1000000000000000000n },
        { variantId: V3, qtyQ4: toQ4('7'), expectedValue: -7n },
      ],
    },
    damagePayload,
  ),

  // inventory.stocktake_open
  kase('S3-STO-01', 'open a stocktake on W1', 'inventory.stocktake_open', { ...tb, stocktakeId: DOC, warehouseId: W1 }, stocktakeOpenPayload),
  kase(
    'S3-STO-02',
    'the same stocktake id on W2: a different digest',
    'inventory.stocktake_open',
    { ...tb, stocktakeId: DOC, warehouseId: W2 },
    stocktakeOpenPayload,
  ),
  kase('S3-STO-03', 'another stocktake on W1', 'inventory.stocktake_open', { ...tb, stocktakeId: DOC2, warehouseId: W1 }, stocktakeOpenPayload),

  // inventory.stocktake_count
  kase(
    'S3-STC-01',
    'one line counted at zero',
    'inventory.stocktake_count',
    { ...tb, stocktakeId: DOC, warehouseId: W1, lines: [{ variantId: V1, countedQ4: 0n }] },
    stocktakeCountPayload,
  ),
  kase(
    'S3-STC-02',
    'three lines in ascending variant order',
    'inventory.stocktake_count',
    {
      ...tb,
      stocktakeId: DOC,
      warehouseId: W1,
      lines: [
        { variantId: V1, countedQ4: toQ4('10') },
        { variantId: V2, countedQ4: toQ4('0.0001') },
        { variantId: V3, countedQ4: toQ4('12345.6789') },
      ],
    },
    stocktakeCountPayload,
  ),
  kase(
    'S3-STC-03',
    'S3-STC-01 recounted: a different counted quantity',
    'inventory.stocktake_count',
    { ...tb, stocktakeId: DOC, warehouseId: W1, lines: [{ variantId: V1, countedQ4: toQ4('4') }] },
    stocktakeCountPayload,
  ),

  // inventory.stocktake_finalize
  kase(
    'S3-STF-01',
    'finalize three lines: a loss, a zero variance and a gain at the average (cost NULL)',
    'inventory.stocktake_finalize',
    {
      ...tb,
      stocktakeId: DOC,
      warehouseId: W1,
      outcome: 'finalized',
      occurredOn: '2026-09-26',
      lines: [
        { variantId: V1, varianceQ4: -toQ4('2'), unitCostC10: null, expectedValue: -200n },
        { variantId: V2, varianceQ4: 0n, unitCostC10: null, expectedValue: 0n },
        { variantId: V3, varianceQ4: toQ4('1.5'), unitCostC10: null, expectedValue: 150n },
      ],
    },
    stocktakeFinalizePayload,
  ),
  kase(
    'S3-STF-02',
    'finalize a gain on a key never valued: the explicit cost is bound',
    'inventory.stocktake_finalize',
    {
      ...tb,
      stocktakeId: DOC,
      warehouseId: W1,
      outcome: 'finalized',
      occurredOn: '2026-09-26',
      lines: [{ variantId: V1, varianceQ4: toQ4('4'), unitCostC10: toC10('0'), expectedValue: 0n }],
    },
    stocktakeFinalizePayload,
  ),
  kase(
    'S3-STF-03',
    'cancel: outcome cancelled, occurred_on NULL, line_count 0',
    'inventory.stocktake_finalize',
    { ...tb, stocktakeId: DOC, warehouseId: W1, outcome: 'cancelled', occurredOn: null, lines: [] },
    stocktakeFinalizePayload,
  ),
  kase(
    'S3-STF-04',
    'S3-STF-01 with different variances and values: the SAME intent digest, a different payload digest',
    'inventory.stocktake_finalize',
    {
      ...tb,
      stocktakeId: DOC,
      warehouseId: W1,
      outcome: 'finalized',
      occurredOn: '2026-09-26',
      lines: [
        { variantId: V1, varianceQ4: -toQ4('1'), unitCostC10: null, expectedValue: -100n },
        { variantId: V2, varianceQ4: 0n, unitCostC10: null, expectedValue: 0n },
        { variantId: V3, varianceQ4: toQ4('2'), unitCostC10: null, expectedValue: 200n },
      ],
    },
    stocktakeFinalizePayload,
  ),

  // inventory.opening
  kase(
    'S3-OPN-01',
    'Case A: one line, opening_balance_id and position_minor both NULL',
    'inventory.opening',
    {
      ...tb,
      openingId: DOC,
      occurredOn: '2026-01-01',
      openingBalanceId: null,
      positionMinor: null,
      lines: [{ warehouseId: W1, variantId: V1, qtyQ4: toQ4('10'), unitCostC10: toC10('1.2345') }],
    },
    openingPayload,
  ),
  kase(
    'S3-OPN-02',
    'Case A: three lines across two warehouses, one at zero cost',
    'inventory.opening',
    {
      ...tb,
      openingId: DOC,
      occurredOn: '2026-01-01',
      openingBalanceId: null,
      positionMinor: null,
      lines: [
        { warehouseId: W1, variantId: V1, qtyQ4: toQ4('3'), unitCostC10: toC10('33.3333') },
        { warehouseId: W2, variantId: V1, qtyQ4: toQ4('2'), unitCostC10: toC10('10.125') },
        { warehouseId: W1, variantId: V2, qtyQ4: toQ4('7'), unitCostC10: toC10('0') },
      ],
    },
    openingPayload,
  ),
  kase(
    'S3-OPN-03',
    'Case B: S3-OPN-01 bound to an opening balance and its position; the SAME intent digest as S3-OPN-01',
    'inventory.opening',
    {
      ...tb,
      openingId: DOC,
      occurredOn: '2026-01-01',
      openingBalanceId: OB,
      positionMinor: 12n,
      lines: [{ warehouseId: W1, variantId: V1, qtyQ4: toQ4('10'), unitCostC10: toC10('1.2345') }],
    },
    openingPayload,
  ),
];

const reasonCases: readonly { id: string; why: string; reason: string }[] = [
  { id: 'RW-01', why: 'plain ASCII', reason: REASON_ASCII },
  { id: 'RW-02', why: 'Arabic, an em dash, Arabic-Indic digits and a four-byte emoji: the exact UTF-8 bytes are hashed', reason: REASON_ARABIC },
  { id: 'RW-03', why: 'surrounding spaces are part of the stored reason and are hashed, never trimmed', reason: '  Water damage in aisle 4 ' },
  { id: 'RW-04', why: 'a single character', reason: 'x' },
];

/** The expanded field list of a stream: names and types from the schema, values from the fields actually encoded. */
function expand(schema: InventoryPayloadSchema, values: readonly (string | null)[]): S3VectorField[] {
  const header = [...schema];
  const group = schema.repeat?.fields ?? [];
  const out: S3VectorField[] = [];
  values.forEach((value, i) => {
    const spec = i < header.length ? header[i] : group[(i - header.length) % Math.max(group.length, 1)];
    if (spec === undefined) throw new Error('a vector has more fields than its schema');
    out.push({ name: spec.name, type: spec.type, value });
  });
  return out;
}

/** The field values of a canonical stream: every line after the fourth, LF-split, `00` as NULL. */
function streamValues(bytes: Buffer): (string | null)[] {
  const text = bytes.toString('utf8');
  if (!text.endsWith('\n')) throw new Error('a stream must end with LF');
  const lines = text.slice(0, -1).split('\n').slice(4);
  return lines.map((l) => (l === '\u0000' ? null : l));
}

function jsonable(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString(10);
  if (Array.isArray(value)) return value.map(jsonable);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonable(v)]));
  }
  return value;
}

function buildCase(c: RawCase): S3PayloadVector {
  const built = c.build();
  if (built.payload.opCode !== c.opCode) throw new Error(`vector ${c.id} built the wrong operation`);
  const payloadFields = expand(INVENTORY_PAYLOAD_SCHEMAS[c.opCode], streamValues(built.payload.bytes));
  // The intent stream is rebuilt here, independently of the builder: the
  // payload's fields minus the server-derived names, re-hashed.
  const intentSchema = inventoryIntentSchema(c.opCode);
  const keep = new Set([...intentSchema, ...(intentSchema.repeat?.fields ?? [])].map((s) => s.name));
  const intentFields = payloadFields.filter((f) => keep.has(f.name));
  const intentBytes = Buffer.from(['invpl/1', c.opCode, T, B, ...intentFields.map((f) => f.value ?? '\u0000')].map((l) => `${l}\n`).join(''), 'utf8');
  const intentSha = createHash('sha256').update(intentBytes).digest('hex');
  if (intentSha !== built.intentSha256) throw new Error(`vector ${c.id}: the builder's intent digest disagrees with the spec`);
  return {
    id: c.id,
    why: c.why,
    opCode: c.opCode,
    tenantId: T,
    businessId: B,
    input: jsonable(c.input) as Readonly<Record<string, unknown>>,
    payload: { fields: payloadFields, canonicalHex: built.payload.bytes.toString('hex'), sha256: built.payload.sha256 },
    intent: { fields: intentFields, canonicalHex: intentBytes.toString('hex'), sha256: intentSha },
  };
}

function buildReason(c: { id: string; why: string; reason: string }): ReasonVector {
  const bytes = Buffer.from(c.reason, 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const words = reasonWords(c.reason).map((w) => w.toString(10));
  // Cross-check: the words ARE the digest, 8 hex digits at a time.
  const fromHex = Array.from({ length: 8 }, (_, i) => BigInt(`0x${sha256.slice(i * 8, i * 8 + 8)}`).toString(10));
  if (words.join(',') !== fromHex.join(',')) throw new Error(`reason vector ${c.id}: words disagree with the digest`);
  return { id: c.id, why: c.why, reason: c.reason, utf8Hex: bytes.toString('hex'), sha256, words };
}

export function buildInvplS3Vectors(): InvplS3Vectors {
  return {
    spec: 'invpl/1 for the seven P3-S3 operation kinds (PHASE_3_S3_CONTRACT A-09, A-10(b); TL-4)',
    note:
      'Generated by packages/inventory/scripts/generate-s3-vectors.ts and verified by packages/inventory/test/movement-payloads.test.ts. ' +
      'The S1 file invpl-vectors.json is untouched. payload is the stream the invctl/1 assertion signs; intent is the same stream ' +
      'without the server-derived fields (expected_value, opening_balance_id, position_minor, variance_q4), whose digest a header ' +
      'stores as intent_sha256. Each field value is its canonical invpl/1 text (integers as decimal text, _q4 = qty x 10^4, ' +
      '_c10 = cost x 10^10, dates YYYYMMDD, reason_w1..w8 = the SHA-256 of the reason as eight uint32 big-endian words) or JSON ' +
      'null for SQL NULL; types[] and values[] of the SQL canonicalizer are the fields in order. input records the builder input ' +
      'with fixed-point integers as text.',
    reasons: reasonCases.map(buildReason),
    cases: rawCases.map(buildCase),
  };
}

/**
 * The committed text: `JSON.stringify` laid out by the repository's own
 * Prettier configuration, so `npm run format` and the byte-identity test can
 * never disagree about the same file.
 */
async function renderJson(value: unknown, file: string): Promise<string> {
  const options = (await resolveConfig(join(__dirname, '..', 'vectors', file))) ?? {};
  return format(JSON.stringify(value, null, 2), { ...options, parser: 'json' });
}

export function renderInvplS3Vectors(): Promise<string> {
  return renderJson(buildInvplS3Vectors(), 'invpl-s3-vectors.json');
}

// ── Allocation ───────────────────────────────────────────────────────────

/** LITERAL expectations, computed by hand; the generator refuses to write a disagreement. */
const allocationCases: readonly AllocationCase[] = [
  { id: 'AL-01', why: 'a three-way tie: the residue of 2 goes to the lower indices', weights: ['1', '1', '1'], total: '2', shares: ['1', '1', '0'] },
  { id: 'AL-02', why: 'a four-way tie with floors of 2', weights: ['1', '1', '1', '1'], total: '10', shares: ['3', '3', '2', '2'] },
  {
    id: 'AL-03',
    why: 'a zero weight takes nothing; the residue goes to the largest remainder',
    weights: ['0', '2', '1'],
    total: '10',
    shares: ['0', '7', '3'],
  },
  { id: 'AL-04', why: 'all weights zero: every share is zero', weights: ['0', '0', '0'], total: '0', shares: ['0', '0', '0'] },
  { id: 'AL-05', why: 'a single line takes the whole total', weights: ['3.3333'], total: '7', shares: ['7'] },
  { id: 'AL-06', why: 'a residue of n - 1', weights: ['1', '1', '1', '1', '1'], total: '4', shares: ['1', '1', '1', '1', '0'] },
  {
    id: 'AL-07',
    why: 'a total above 2^53: only exact integer arithmetic gets the odd unit right',
    weights: ['1', '1'],
    total: '9007199254740993',
    shares: ['4503599627370497', '4503599627370496'],
  },
  {
    id: 'AL-08',
    why: 'fractional weights: remainders 18300, 14200, 12500 over W = 22500',
    weights: ['0.3333', '0.6667', '1.25'],
    total: '100',
    shares: ['15', '30', '55'],
  },
  { id: 'AL-09', why: 'weights of different scales are compared exactly', weights: ['2', '0.5', '1.25'], total: '3', shares: ['2', '0', '1'] },
  { id: 'AL-10', why: 'the largest remainder wins over the lower index', weights: ['3', '1'], total: '3', shares: ['2', '1'] },
  { id: 'AL-11', why: 'a zero total over positive weights', weights: ['5', '7'], total: '0', shares: ['0', '0'] },
];

const openingCases: readonly OpeningAllocationCase[] = [
  {
    id: 'OP-01',
    why: 'one line: 10 x 1.2345 = 12.345, HALF_EVEN to 12',
    lines: [{ qty: '10.0000', unitCost: '1.2345000000' }],
    total: '12',
    shares: ['12'],
    caseB: null,
  },
  {
    id: 'OP-02',
    why: 'a document total on an exact half goes to the even neighbour (2.5 -> 2), then the larger remainder takes the residue',
    lines: [
      { qty: '1.0000', unitCost: '0.5000000000' },
      { qty: '1.0000', unitCost: '2.0000000000' },
    ],
    total: '2',
    shares: ['0', '2'],
    caseB: null,
  },
  {
    id: 'OP-03',
    why: 'three lines, weights 99.9999, 20.25 and 0.7 (W = 120.9499, T = 121): floors 100, 20, 0 and the residue to the third line',
    lines: [
      { qty: '3.0000', unitCost: '33.3333000000' },
      { qty: '2.0000', unitCost: '10.1250000000' },
      { qty: '7.0000', unitCost: '0.1000000000' },
    ],
    total: '121',
    shares: ['100', '20', '1'],
    caseB: null,
  },
  {
    id: 'OP-04',
    why: 'every cost zero: T = 0 and every share 0 (Case A with no journal entry)',
    lines: [
      { qty: '5.0000', unitCost: '0.0000000000' },
      { qty: '2.0000', unitCost: '0.0000000000' },
    ],
    total: '0',
    shares: ['0', '0'],
    caseB: null,
  },
  {
    id: 'OP-GOLD-B-EXACT',
    why: 'Case B: the stock total equals the opening position exactly',
    lines: [{ qty: '100.0000', unitCost: '15.0000000000' }],
    total: '1500',
    shares: ['1500'],
    caseB: { positionMinor: '1500', outcome: 'match' },
  },
  {
    id: 'OP-GOLD-B-PLUS-1',
    why: 'Case B: the position is one minor unit above the stock total',
    lines: [{ qty: '100.0000', unitCost: '15.0000000000' }],
    total: '1500',
    shares: ['1500'],
    caseB: { positionMinor: '1501', outcome: 'inventory.opening_valuation_mismatch' },
  },
  {
    id: 'OP-GOLD-B-MINUS-1',
    why: 'Case B: the position is one minor unit below the stock total',
    lines: [{ qty: '100.0000', unitCost: '15.0000000000' }],
    total: '1500',
    shares: ['1500'],
    caseB: { positionMinor: '1499', outcome: 'inventory.opening_valuation_mismatch' },
  },
  {
    id: 'OP-GOLD-B-SPLIT',
    why: 'Case B over the OP-03 lines: the rounded total 121 is what must match the position',
    lines: [
      { qty: '3.0000', unitCost: '33.3333000000' },
      { qty: '2.0000', unitCost: '10.1250000000' },
      { qty: '7.0000', unitCost: '0.1000000000' },
    ],
    total: '121',
    shares: ['100', '20', '1'],
    caseB: { positionMinor: '121', outcome: 'match' },
  },
];

function checkAllocation(c: AllocationCase): AllocationCase {
  const got = largestRemainder(c.weights.map(parseDecimal), BigInt(c.total)).map((s) => s.toString(10));
  if (got.join(',') !== c.shares.join(',')) throw new Error(`allocation vector ${c.id}: the package computes ${got.join(',')}`);
  return c;
}

function checkOpening(c: OpeningAllocationCase): OpeningAllocationCase {
  const got = allocateOpening(c.lines.map((l) => ({ qtyQ4: toQ4(l.qty), costC10: toC10(l.unitCost) })));
  if (got.total.toString(10) !== c.total) throw new Error(`opening vector ${c.id}: the package computes the total ${got.total}`);
  if (got.shares.map((s) => s.toString(10)).join(',') !== c.shares.join(',')) throw new Error(`opening vector ${c.id}: the package computes other shares`);
  if (c.caseB !== null && (c.caseB.positionMinor === c.total) !== (c.caseB.outcome === 'match'))
    throw new Error(`opening vector ${c.id}: the Case B outcome is wrong`);
  return c;
}

export function buildAllocationVectors(): AllocationVectors {
  return {
    version: 'invalloc/1',
    note:
      'Generated by packages/inventory/scripts/generate-s3-vectors.ts from LITERAL expectations and verified by ' +
      'packages/inventory/test/allocation.test.ts. cases: largestRemainder(weights, total) = inventory_largest_remainder(numeric[], bigint), ' +
      'ties to the lower index (line_no ASC). openings: T = inventory_half_even(sum of qty x cost, 1, 0) and the shares of the same ' +
      'split (PHASE_3_S3_CONTRACT A-13); caseB states the opening position and the required outcome. Integers are decimal text.',
    cases: allocationCases.map(checkAllocation),
    openings: openingCases.map(checkOpening),
  };
}

export function renderAllocationVectors(): Promise<string> {
  return renderJson(buildAllocationVectors(), 'allocation-vectors.json');
}
