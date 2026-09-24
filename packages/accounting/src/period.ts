/**
 * The accounting-period application half: the `acctperiod/1` canonical
 * command fingerprint, the reason-identity contract, the two derived
 * identities and the typed shapes the three commands carry (P2-S6 §18-§20).
 *
 * Everything here is PURE. It derives and canonicalizes; it reads no clock,
 * no configuration and no connection. In particular there is no fiscal
 * calendar generator and no function that produces a period from a year, a
 * quarter or a month: DAFTAR does not guess what a merchant's books look
 * like, and a helper that offered to would be the seam through which it
 * eventually did (§9).
 */
import { createHash } from 'node:crypto';
import { AccountingError } from './errors';
import { canonicalDate, canonicalUuid } from './fingerprint';
import { deriveAccountingResourceId } from './sources';

/** The only two states a period has. Not an enum with room in it. */
export type AccountingPeriodStatus = 'open' | 'closed';

/** The three commands. Each one is its own authority and its own fingerprint. */
export type AccountingPeriodCommandKind = 'period_create' | 'period_close' | 'period_reopen';

export const ACCOUNTING_PERIOD_COMMAND_KINDS: readonly AccountingPeriodCommandKind[] = ['period_create', 'period_close', 'period_reopen'];

/** Stream version prefix. Bump only with a new spec and new vectors. */
export const ACCTPERIOD_VERSION = 'acctperiod/1';

/** The reason's bounds, in Unicode code points — the unit PostgreSQL counts in. */
export const PERIOD_REASON_MAX_LENGTH = 500;

/**
 * The reason-identity contract (§20), stated once so both languages can obey
 * the same two steps:
 *
 *   1. Strip leading and trailing SPACE, TAB, LF and CR — those four code
 *      points and NO others.
 *   2. SHA-256 of the UTF-8 bytes, lowercase hex.
 *
 * Step 1 is written out as a character class rather than as `String.trim()`
 * on purpose. JavaScript's `trim` removes every Unicode whitespace character,
 * including U+00A0, U+2028 and U+FEFF; PostgreSQL's `btrim(x)` removes
 * spaces. Neither is wrong, and that is the problem: a fingerprint whose two
 * implementations disagreed about one invisible character would refuse a
 * command the merchant never changed. So the contract names the four code
 * points it strips, and `btrim(x, E' \t\n\r')` on the database side strips
 * exactly those.
 *
 * ── Why there is no Unicode NFC step ──────────────────────────────────────
 *
 * There was one, and it came out. PostgreSQL's `normalize(text, NFC)` raises
 * `Unicode normalization can only be performed if server encoding is UTF8`,
 * and DAFTAR does not require a UTF8 server encoding of a deployment today —
 * the test cluster is the proof, since it is not one.
 *
 * Keeping the step would have meant one of two things: a new, unstated
 * deployment requirement that the bootstrap does not enforce and that a
 * restored database could silently fail to meet, or a PostgreSQL half that
 * quietly does less than this one — which is exactly the drift the shared
 * vectors exist to catch.
 *
 * So the contract takes the bytes VERBATIM, and the cost is small and
 * precise: a reason typed with a decomposed accent and the same reason typed
 * with a composed one are two different reasons. A retry that changed
 * spelling is REFUSED as a payload mismatch rather than silently treated as
 * the same command, and nothing is ever stored that nobody signed.
 */
const TRIMMED = /^[ \t\n\r]+|[ \t\n\r]+$/g;

export function normalizePeriodReason(raw: string): string {
  const reason = raw.replace(TRIMMED, '');
  if (reason.length === 0) {
    throw new AccountingError('accounting.period_reopen_reason_required', 'reopening a period requires a reason');
  }
  // Code points, not UTF-16 units: PostgreSQL's `length()` counts characters,
  // and a reason of 300 emoji is 300 characters there and 600 here.
  if ([...reason].length > PERIOD_REASON_MAX_LENGTH) {
    throw new AccountingError('accounting.period_reopen_reason_required', `a reopen reason is at most ${PERIOD_REASON_MAX_LENGTH} characters`);
  }
  return reason;
}

/** Lowercase hex SHA-256 of the normalized reason's UTF-8 bytes. */
export function periodReasonDigest(reason: string): string {
  return createHash('sha256')
    .update(Buffer.from(normalizePeriodReason(reason), 'utf8'))
    .digest('hex');
}

/** Everything that identifies one period command. Nothing narrative appears here. */
export interface PeriodCommandFacts {
  readonly kind: AccountingPeriodCommandKind;
  readonly tenantId: string;
  readonly businessId: string;
  /** Derived from the request's `Idempotency-Key`: which command this IS. */
  readonly operationId: string;
  /** The period the command acts on. Derived on create, stated on the rest. */
  readonly periodId: string;
  /** `YYYY-MM-DD`. Required for `period_create`, absent otherwise. */
  readonly startDate?: string;
  readonly endDate?: string;
  /** The reason itself, for `period_reopen`. Its DIGEST enters the stream. */
  readonly reason?: string;
}

/**
 * The canonical byte stream — UTF-8, newline-separated, newline-terminated:
 *
 *   acctperiod/1 \n kind \n tenant \n business \n operation_id \n period_id \n
 *     period_create: start_date \n end_date \n
 *     period_close:  (nothing further)
 *     period_reopen: reason_digest \n
 *
 * The KIND is the second field, so the three streams diverge at their fifth
 * byte and no create payload can ever equal a close payload. The PostgreSQL
 * half lives in `0049` and the shared vectors in
 * `packages/accounting/vectors/acctperiod-vectors.json` are the single source
 * both are tested against, so neither can drift without the other failing.
 *
 * What is NOT in the stream: a request id, a description, a created
 * timestamp, the actor. The actor is a CLAIM of the assertion rather than a
 * field of the payload — binding it twice would mean two places to disagree —
 * and the rest is narrative a retry may legitimately reword.
 */
export function periodCanonicalStream(facts: PeriodCommandFacts): Buffer {
  if (!ACCOUNTING_PERIOD_COMMAND_KINDS.includes(facts.kind)) {
    throw new AccountingError('accounting.payload_invalid', 'unknown period command kind');
  }
  const head = [
    ACCTPERIOD_VERSION,
    facts.kind,
    canonicalUuid(facts.tenantId),
    canonicalUuid(facts.businessId),
    canonicalUuid(facts.operationId),
    canonicalUuid(facts.periodId),
  ];

  if (facts.kind === 'period_create') {
    if (facts.startDate === undefined || facts.endDate === undefined) {
      throw new AccountingError('accounting.payload_missing_field', 'creating a period states both of its boundaries');
    }
    const start = canonicalDate(facts.startDate);
    const end = canonicalDate(facts.endDate);
    if (start > end) {
      throw new AccountingError('accounting.period_range_invalid', 'a period ends on or after it starts');
    }
    return Buffer.from([...head, start, end, ''].join('\n'), 'utf8');
  }

  if (facts.kind === 'period_reopen') {
    if (facts.reason === undefined) {
      throw new AccountingError('accounting.period_reopen_reason_required', 'reopening a period requires a reason');
    }
    return Buffer.from([...head, periodReasonDigest(facts.reason), ''].join('\n'), 'utf8');
  }

  return Buffer.from([...head, ''].join('\n'), 'utf8');
}

/** Lowercase hex SHA-256 of the canonical stream — the signed fingerprint. */
export function computePeriodFingerprint(facts: PeriodCommandFacts): string {
  return createHash('sha256').update(periodCanonicalStream(facts)).digest('hex');
}

/**
 * The period's identity, derived from the business and the request's
 * `Idempotency-Key` (§18, §29).
 *
 * The SAME deterministic-id discipline P2-S4 uses for a source identity and
 * P2-S5 for a rate identity, under its own domain label. The label is what
 * keeps one key reused across an adjustment, a rate entry and a period from
 * deriving one UUID for three unrelated things.
 */
export function derivePeriodId(businessId: string, idempotencyKey: string): string {
  return deriveAccountingResourceId('daftar/accounting-period-id/v1', businessId, idempotencyKey);
}

/**
 * The OPERATION's identity — which command a key performed — derived from the
 * same key under a second label.
 *
 * Two identities rather than one, because they answer different questions. On
 * a create they are both derived from one key and both new. On a close or a
 * reopen the period already exists and is named in the path, while the
 * operation is whatever this particular request is; deriving the operation
 * from the period would make every close of one period the same operation
 * forever, and the reopen-after-reclose hazard §18 names could not be
 * distinguished from a first reopen.
 *
 * One key reused across two DIFFERENT period commands derives one operation
 * id with two different payload fingerprints, which the registry refuses as
 * `accounting.idempotency_conflict`. That is the intended answer: a key is a
 * claim about which command this is, and the same key cannot be two commands.
 */
export function derivePeriodOperationId(businessId: string, idempotencyKey: string): string {
  return deriveAccountingResourceId('daftar/accounting-period-operation-id/v1', businessId, idempotencyKey);
}

/** What the caller states when creating a period. No actor, no tenant, no status. */
export interface PeriodCreateCommand {
  readonly tenantId: string;
  readonly businessId: string;
  readonly operationId: string;
  readonly periodId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly requestId?: string | null;
}

export interface PeriodCloseCommand {
  readonly tenantId: string;
  readonly businessId: string;
  readonly operationId: string;
  readonly periodId: string;
  readonly requestId?: string | null;
}

export interface PeriodReopenCommand extends PeriodCloseCommand {
  /** Already normalized by `normalizePeriodReason` before it reaches here. */
  readonly reason: string;
}

/**
 * The outcome of a period command.
 *
 * `changed: false` is an idempotent replay answered from the operation
 * registry — the original result, with nothing transitioned, audited or
 * published a second time.
 */
export interface PeriodCommandResult {
  readonly periodId: string;
  readonly changed: boolean;
}

/** One period as the merchant surface reads it back (§32). */
export interface AccountingPeriodSnapshot {
  readonly periodId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly status: AccountingPeriodStatus;
  readonly closedAt: string | null;
  readonly lastReopenedAt: string | null;
}
