/**
 * The Phase-2-native sources: manual adjustment, reversal, opening balance
 * (directive §10-§34).
 *
 * Everything in this module is PURE. It derives — a source identity from a
 * transport key, a mirror from a persisted entry, an equity plug from a set
 * of positions — and it writes nothing. That matters more here than usual:
 * for a reversal and for an opening balance the database derives the same
 * values from the same persisted rows, and the two derivations are compared
 * through the signed fingerprint before anything is written. A bug in either
 * one is a refusal, never a wrong entry.
 */
import { createHash } from 'node:crypto';
import { AccountingError } from './errors';
import { canonicalDate, computeFingerprint, type CanonicalLineInput } from './fingerprint';
import { MAX_MONEY_MINOR, type AccountRef, type PostingLineCommand, type PostingSide } from './types';

/** The system account an opening position's residual equity is written to (AL-13). */
export const OPENING_EQUITY_SYSTEM_KEY = 'opening_equity';

/**
 * ── Transport idempotency, and why it is not a second table (§11) ────────
 *
 * The FINANCIAL identity of a command is `(business_id, source_type,
 * source_id)`, enforced by a UNIQUE constraint on `journal_entries` and again
 * on `accounting_source_bindings`. An HTTP `Idempotency-Key` is a TRANSPORT
 * concern: it says "this is the same request I sent a moment ago", not "this
 * is the same financial fact".
 *
 * Phase 1's only idempotency mechanism is `onboarding_operations` (migration
 * `0018`). It is keyed by USER and restricted to the two onboarding kinds,
 * and no runtime role but the platform one may write it. It is therefore NOT
 * reusable for a business-scoped merchant command, and this is the explicit
 * statement of that gap the directive asks for rather than a silent
 * workaround.
 *
 * What replaces it is the smallest durable mechanism that could work: DERIVE
 * the source id from the business and the key. The same key then produces the
 * same source identity, so the constraint the ledger already enforces does
 * the work:
 *
 *   same key + same request       → same source id, same fingerprint
 *                                 → the existing entry, `created: false`
 *   same key + different request  → same source id, different fingerprint
 *                                 → `accounting.idempotency_conflict`
 *   two requests at once          → the posting primitive's advisory lock on
 *                                   that exact source identity serializes
 *                                   them; one creates, the other replays
 *
 * No cache, no expiry, no second source of truth that could disagree with the
 * ledger, and nothing to reconcile after a crash. The derivation is
 * business-scoped by construction, so one tenant's key can never collide with
 * another's, and it is not reversible to the key.
 *
 * A request id is NOT a source id. `requestId` remains narrative, outside the
 * fingerprint, and is stored for tracing only.
 */
export function deriveSourceId(businessId: string, idempotencyKey: string): string {
  const key = idempotencyKey.trim();
  if (key.length < 8 || key.length > 200 || !/^[\x20-\x7e]+$/.test(key)) {
    throw new AccountingError('accounting.payload_invalid', 'an idempotency key must be 8 to 200 printable ASCII characters');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(businessId)) {
    throw new AccountingError('accounting.payload_invalid', 'a source identity must be derived for a real business');
  }
  // Domain-separated, so a digest from anywhere else in the system can never
  // be mistaken for a source identity.
  const digest = createHash('sha256').update(`daftar/accounting-source-id/v1\n${businessId.toLowerCase()}\n${key}`, 'utf8').digest();
  const b = Buffer.from(digest.subarray(0, 16));
  // RFC 4122 version 5 / variant 10, so the value is a well-formed UUID and
  // not merely 32 hex characters that happen to fit the shape.
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x50;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ── Reversal ──────────────────────────────────────────────────────────────

/** One line of a persisted entry, as the API reads it back from the ledger. */
export interface PostedLineSnapshot {
  readonly lineNo: number;
  readonly account: AccountRef;
  readonly side: PostingSide;
  readonly baseAmountMinor: bigint;
  readonly baseCurrency: string;
  readonly txnAmountMinor: bigint;
  readonly txnCurrency: string;
  readonly fxRate: string;
  readonly fxRateSource: string;
  readonly fxRateAt: Date;
  readonly branchId: string | null;
  readonly warehouseId: string | null;
  readonly memo: string | null;
}

/** A persisted entry, as the API reads it back before deriving its mirror. */
export interface PostedEntrySnapshot {
  readonly entryId: string;
  readonly tenantId: string;
  readonly businessId: string;
  readonly sourceType: string;
  readonly entryDate: string;
  readonly lines: readonly PostedLineSnapshot[];
}

/**
 * The mirror of a persisted entry: debit becomes credit and credit becomes
 * debit, and NOTHING else changes.
 *
 * Both amounts, both currencies, the rate, the rate's source, the instant it
 * was taken, the branch and the warehouse are copied verbatim. The rate is
 * never re-fetched and never recomputed at today's rate — that prohibition is
 * absolute (`DAFTAR_ACCOUNTING_RULES.md` §5.2, AL-12), because a reversal
 * that used today's rate would silently book an FX gain or loss that nobody
 * asked for and no document supports.
 */
export function mirrorReversalLines(original: PostedEntrySnapshot): PostingLineCommand[] {
  if (original.sourceType === 'reversal') {
    throw new AccountingError('accounting.reversal_of_reversal', 'a reversal may not itself be reversed', {
      businessId: original.businessId,
      originalEntryId: original.entryId,
    });
  }
  if (original.lines.length < 2) {
    throw new AccountingError('accounting.entry_not_found', 'the original entry has no lines to reverse', {
      businessId: original.businessId,
      originalEntryId: original.entryId,
    });
  }
  return [...original.lines]
    .sort((a, b) => a.lineNo - b.lineNo)
    .map((l) => ({
      account: l.account,
      side: l.side === 'D' ? ('C' as const) : ('D' as const),
      baseAmountMinor: l.baseAmountMinor,
      baseCurrency: l.baseCurrency,
      txnAmountMinor: l.txnAmountMinor,
      txnCurrency: l.txnCurrency,
      fxRate: l.fxRate,
      fxRateSource: l.fxRateSource as PostingLineCommand['fxRateSource'],
      fxRateAt: l.fxRateAt,
      branchId: l.branchId,
      warehouseId: l.warehouseId,
      memo: l.memo,
    }));
}

/** The account identity a persisted line resolves to, in canonical form (§23). */
export function snapshotAccountIdentity(ref: AccountRef): string {
  return ref.kind === 'system' ? ref.systemKey : `code:${ref.code}`;
}

const toCanonical = (l: PostingLineCommand): CanonicalLineInput => ({
  accountIdentity: snapshotAccountIdentity(l.account),
  side: l.side,
  baseAmountMinor: l.baseAmountMinor,
  baseCurrency: l.baseCurrency,
  txnAmountMinor: l.txnAmountMinor,
  txnCurrency: l.txnCurrency,
  fxRate: l.fxRate,
  fxRateSource: l.fxRateSource,
  fxRateAt: l.fxRateAt,
  branchId: l.branchId,
  warehouseId: l.warehouseId,
});

/**
 * The fingerprint the reversal authority signs.
 *
 * The header's source identity is the ORIGINAL ENTRY's id — that single
 * decision is what makes a second reversal structurally impossible — and the
 * lines are the mirror derived above. The database derives its own mirror
 * from its own rows and recomputes this digest before writing anything.
 */
export function computeReversalFingerprint(original: PostedEntrySnapshot, entryDate: string, mirrored: readonly PostingLineCommand[]): string {
  return computeFingerprint(
    {
      tenantId: original.tenantId,
      businessId: original.businessId,
      sourceType: 'reversal',
      sourceId: original.entryId,
      entryDate: canonicalDate(entryDate),
    },
    mirrored.map(toCanonical),
  );
}

// ── Opening balance ───────────────────────────────────────────────────────

/** One position a merchant states in an opening balance. No branch, no warehouse (§31). */
export interface OpeningPosition {
  readonly account: AccountRef;
  readonly side: PostingSide;
  readonly baseAmountMinor: bigint;
  readonly baseCurrency: string;
  readonly txnAmountMinor: bigint;
  readonly txnCurrency: string;
  readonly fxRate: string;
  /** `base` for a domestic position, `manual` for a foreign one (§22). */
  readonly fxRateSource: 'base' | 'manual';
  readonly fxRateAt: Date;
  readonly memo?: string | null;
}

/** The residual equity of a set of positions. Zero is a real answer. */
export interface OpeningEquityPlug {
  readonly amountMinor: bigint;
  readonly side: PostingSide;
}

/**
 * The plug (§28).
 *
 * Assets and liabilities carried in from before DAFTAR do not balance by
 * themselves; the difference is the owners' accumulated position. It is
 * arithmetic over the stated positions, never a number the merchant supplies.
 *
 * The ZERO case is explicit, not accidental: when the positions already
 * balance among themselves the plug is zero and NO plug line is emitted,
 * because `journal_lines` refuses a zero amount and an opening position with
 * no residual equity has nothing to say about equity. A caller that wanted a
 * visible zero would be asking the ledger to record a fact that is not one.
 */
export function computeOpeningEquityPlug(positions: readonly OpeningPosition[]): OpeningEquityPlug {
  let debits = 0n;
  let credits = 0n;
  for (const p of positions) {
    if (p.baseAmountMinor <= 0n || p.baseAmountMinor > MAX_MONEY_MINOR) {
      throw new AccountingError('accounting.payload_invalid', 'an opening position amount is outside the money cap');
    }
    if (p.side === 'D') debits += p.baseAmountMinor;
    else credits += p.baseAmountMinor;
  }
  const diff = debits - credits;
  const amountMinor = diff < 0n ? -diff : diff;
  if (amountMinor > MAX_MONEY_MINOR) {
    throw new AccountingError('accounting.payload_invalid', 'the opening equity plug exceeds the money cap');
  }
  // A debit surplus needs a credit to balance it, and the other way round.
  return { amountMinor, side: diff > 0n ? 'C' : 'D' };
}

/**
 * The journal lines an opening balance produces: the positions as stated,
 * plus the plug when it is not zero.
 *
 * The plug's FX snapshot instant is the as-of date at midnight UTC —
 * deterministic, derived from the opening balance itself, and therefore
 * reproducible by the database's independent derivation. A wall-clock `now()`
 * would make the digest unreproducible and every posting would be refused
 * with a payload mismatch.
 */
export function deriveOpeningBalanceLines(positions: readonly OpeningPosition[], baseCurrency: string, asOfDate: string): PostingLineCommand[] {
  if (positions.length === 0) {
    throw new AccountingError('accounting.payload_invalid', 'an opening balance needs at least one position');
  }
  for (const p of positions) {
    if (p.account.kind === 'system' && p.account.systemKey === OPENING_EQUITY_SYSTEM_KEY) {
      throw new AccountingError('accounting.payload_invalid', 'the opening equity plug is computed by the engine and may not be stated as a position');
    }
    if (p.baseCurrency.toUpperCase() !== baseCurrency.toUpperCase()) {
      throw new AccountingError('accounting.entry_base_currency_mismatch', 'an opening position is not denominated in the business base currency');
    }
  }
  const date = canonicalDate(asOfDate);
  const lines: PostingLineCommand[] = positions.map((p) => ({
    account: p.account,
    side: p.side,
    baseAmountMinor: p.baseAmountMinor,
    baseCurrency: p.baseCurrency.toUpperCase(),
    txnAmountMinor: p.txnAmountMinor,
    txnCurrency: p.txnCurrency.toUpperCase(),
    fxRate: p.fxRate,
    fxRateSource: p.fxRateSource,
    fxRateAt: p.fxRateAt,
    branchId: null,
    warehouseId: null,
    memo: p.memo ?? null,
  }));

  const plug = computeOpeningEquityPlug(positions);
  if (plug.amountMinor > 0n) {
    lines.push({
      account: { kind: 'system', systemKey: OPENING_EQUITY_SYSTEM_KEY },
      side: plug.side,
      baseAmountMinor: plug.amountMinor,
      baseCurrency: baseCurrency.toUpperCase(),
      txnAmountMinor: plug.amountMinor,
      txnCurrency: baseCurrency.toUpperCase(),
      fxRate: '1.0000000000',
      fxRateSource: 'base',
      fxRateAt: new Date(`${date}T00:00:00Z`),
      branchId: null,
      warehouseId: null,
      memo: null,
    });
  }
  return lines;
}

/** The fingerprint the opening-balance authority signs, over the derived lines. */
export function computeOpeningBalanceFingerprint(
  header: { readonly tenantId: string; readonly businessId: string; readonly openingBalanceId: string; readonly asOfDate: string },
  lines: readonly PostingLineCommand[],
): string {
  return computeFingerprint(
    {
      tenantId: header.tenantId,
      businessId: header.businessId,
      sourceType: 'opening_balance',
      sourceId: header.openingBalanceId,
      entryDate: canonicalDate(header.asOfDate),
    },
    lines.map(toCanonical),
  );
}
