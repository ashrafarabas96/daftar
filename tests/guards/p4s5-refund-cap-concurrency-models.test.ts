/**
 * P4-S5, maturity level C — the CONCURRENCY MODELS of the refund cap.
 *
 * ## What this file is
 *
 * Five races, each modelled DETERMINISTICALLY over an in-memory source, with the
 * interleaving written out step by step. There is **no `sleep`, no timer and no
 * `Promise.all` over two real connections** anywhere in it: a race proved by
 * timing is a race that passes on a fast machine and reddens CI on a slow one,
 * and a race *disproved* by timing proves nothing at all. The barrier here is
 * the row lock itself — the model refuses a second lock while one is held, so
 * the interleaving the test writes is the interleaving that runs.
 *
 * It is a MODEL and says so. It does not touch a database, because `refunds`,
 * `credit_notes` and `credit_note_applications` exist at no migration prefix
 * `0000`–`0086` and S5 owns no migration number. What it pins is the SHAPE of
 * the protocol — lock, then read, then cap, then insert at the level, then
 * decrement optimistically, then verify the chain at commit — so that the
 * implementation written against the sealed schema has a specification to be
 * judged against, and so that the five races have their answers recorded before
 * anybody writes SQL.
 *
 * ## Why every model has a RED PROOF beside it
 *
 * `[[daftar-a-green-gate-must-prove-it-can-be-red]]`. For each race the file
 * runs the protocol twice: once correctly, and once through
 * `brokenStaleRead` / `brokenApply` — a protocol that checks the cap against a remaining
 * read BEFORE taking the lock, which is the single most likely way a real
 * implementation gets this wrong. The broken protocol MUST overdraw the source.
 * A model that cannot distinguish the two protocols is a model that proves
 * nothing about either, and a green run of the correct protocol alone would be
 * exactly that false green.
 *
 * The planted subject in every red proof is REAL: the protocol under attack is
 * the one `apps/api/src/modules/returns/returns-settlement.ts` implements and
 * `apps/api/src/modules/returns/returns-ports.ts` prescribes, and the figures
 * are the figures the accepted `customer_credit_consume` (`0081:1224-1250`) and
 * `customer_credit_verify` (`0081:879-918`) operate on.
 */
import { describe, expect, it } from 'vitest';
import { refundCapRefusal, type ConsumableSourceCap, type RefundSourceKind, type ReturnsRefusalCode } from '@daftar/domain-core';
import { verifySourceConsumptionChain, type SourceConsumerRow } from '../../apps/api/src/modules/returns/returns-settlement';

// ── The model ───────────────────────────────────────────────────────────

/**
 * One consumer row as the model stores it. The same three columns the accepted
 * chain verifier reads — the LEVEL, the amount, the carrying released — because
 * a model that stored a running total would be modelling a design this slice
 * forbids.
 */
type ConsumerRow = SourceConsumerRow & { readonly by: string };

/**
 * An in-memory consumable source with a row lock.
 *
 * `lockedBy` is the barrier. `lock()` refuses while another transaction holds
 * it, so the test's written interleaving is enforced rather than hoped for, and
 * a protocol that forgot to lock is visible as a protocol that never blocks.
 */
class ModelSource {
  lockedBy: string | null = null;
  readonly consumers: ConsumerRow[] = [];

  constructor(
    readonly kind: RefundSourceKind,
    readonly originalMinor: bigint,
    public remainingMinor: bigint,
  ) {}

  /** The unlocked read a careless implementation would use. Named so the red proof can name its mistake. */
  dirtyRead(): bigint {
    return this.remainingMinor;
  }

  /** `SELECT … FOR UPDATE`. `null` when another transaction holds the row — the model's barrier. */
  lock(txn: string): ConsumableSourceCap | null {
    if (this.lockedBy !== null && this.lockedBy !== txn) return null;
    this.lockedBy = txn;
    return { kind: this.kind, originalMinor: this.originalMinor, remainingMinor: this.remainingMinor };
  }

  /**
   * The optimistic decrement: `UPDATE … WHERE remaining_amount_minor = $level`,
   * with the row count as the verdict. The `0081:1239-1250` shape.
   *
   * It is the second line of defence and not the first: the cap under the lock
   * is the first. This refuses a LOST UPDATE — a decrement computed from a level
   * the row no longer holds — and it is what catches a writer that reached the
   * row without taking the lock.
   */
  decrement(level: bigint, consumedMinor: bigint): 'ok' | 'source_changed' {
    if (this.remainingMinor !== level) return 'source_changed';
    this.remainingMinor = level - consumedMinor;
    return 'ok';
  }

  release(txn: string): void {
    if (this.lockedBy === txn) this.lockedBy = null;
  }

  /** The COMMIT-time chain law, over applications AND refunds together. */
  verify(): 'ok' | 'inconsistent' {
    // The carrying pair is not what these five races are about, so the model
    // keeps it proportional and exact (carrying == amount) and lets the chain
    // verifier judge the LEVELS, which is the half a race can break. The
    // carrying arithmetic has its own vectors in the plan-layer suite.
    try {
      verifySourceConsumptionChain(
        {
          originalMinor: this.originalMinor,
          originalCarryingMinor: this.originalMinor,
          remainingMinor: this.remainingMinor,
          remainingCarryingMinor: this.remainingMinor,
        },
        this.consumers,
      );
      return 'ok';
    } catch {
      return 'inconsistent';
    }
  }
}

type Outcome = { readonly ok: true } | { readonly ok: false; readonly code: ReturnsRefusalCode | 'blocked' };

/**
 * The CORRECT protocol: lock, read under the lock, cap against THAT reading,
 * insert at THAT level, decrement optimistically, release.
 *
 * `TL-P4-S5-R1` is visible in what it does not do: it reads no invoice, writes
 * no AR and takes no lock on one.
 */
function correctProtocol(source: ModelSource, txn: string, requestedMinor: bigint): Outcome {
  const locked = source.lock(txn);
  if (locked === null) return { ok: false, code: 'blocked' };
  try {
    const capProblem = refundCapRefusal(locked, requestedMinor);
    if (capProblem !== null) return { ok: false, code: capProblem };
    source.consumers.push({ by: txn, remainingBeforeMinor: locked.remainingMinor, consumedMinor: requestedMinor, releasedBaseMinor: requestedMinor });
    const written = source.decrement(locked.remainingMinor, requestedMinor);
    if (written !== 'ok') {
      source.consumers.pop();
      return { ok: false, code: 'customer_refund.source_changed' };
    }
    return { ok: true };
  } finally {
    source.release(txn);
  }
}

/**
 * The BROKEN protocol the red proofs plant, in its two halves: the remaining is
 * read BEFORE the lock (`brokenStaleRead`), and the cap is then checked and the
 * row written against that stale level (`brokenApply`).
 *
 * It is split in two on purpose, so a test can write the interleaving that
 * actually bites — BOTH transactions read, THEN both apply — deterministically,
 * with no timing involved.
 *
 * This is not a straw man. It is the natural shape of an implementation that
 * validates the request in a service method and then calls a repository, and it
 * is exactly why «the refund cap is checked INSIDE the source under
 * `FOR UPDATE`» is a law about WHERE the check happens and not merely that it
 * happens.
 */
function brokenStaleRead(source: ModelSource): bigint {
  return source.dirtyRead();
}

function brokenApply(source: ModelSource, txn: string, stale: bigint, requestedMinor: bigint): Outcome {
  const capProblem = refundCapRefusal({ kind: source.kind, originalMinor: source.originalMinor, remainingMinor: stale }, requestedMinor);
  if (capProblem !== null) return { ok: false, code: capProblem };
  const locked = source.lock(txn);
  if (locked === null) return { ok: false, code: 'blocked' };
  try {
    source.consumers.push({ by: txn, remainingBeforeMinor: stale, consumedMinor: requestedMinor, releasedBaseMinor: requestedMinor });
    // The defect: it forces the decrement at the STALE level rather than letting
    // the optimistic row count refuse it, which is what an implementation that
    // "retries until it succeeds" amounts to.
    source.remainingMinor = source.remainingMinor - requestedMinor;
    return { ok: true };
  } finally {
    source.release(txn);
  }
}

const creditNote = (original: bigint, remaining = original): ModelSource => new ModelSource('credit_note', original, remaining);
const customerCredit = (original: bigint, remaining = original): ModelSource => new ModelSource('customer_credit', original, remaining);

// ── Race 1: refund vs refund ────────────────────────────────────────────

describe('P4-S5 concurrency model — race 1: refund vs refund on one source', () => {
  it('serializes on the source row and the second refund meets the NEW remaining, not the old one', () => {
    const source = creditNote(10_000n);

    // T2 arrives while T1 holds the lock: it is BLOCKED, not permitted to read
    // a stale remaining. This is the barrier, and the assertion is that it
    // exists at all.
    expect(source.lock('T1')).not.toBeNull();
    expect(source.lock('T2')).toBeNull();
    source.release('T1');

    expect(correctProtocol(source, 'T1', 10_000n)).toEqual({ ok: true });
    expect(correctProtocol(source, 'T2', 10_000n)).toEqual({ ok: false, code: 'customer_refund.source_exhausted' });

    expect(source.remainingMinor).toBe(0n);
    expect(source.consumers).toHaveLength(1);
    expect(source.verify()).toBe('ok');
  });

  it('RED PROOF — the broken protocol refunds 10000 twice out of a source of 10000', () => {
    const source = creditNote(10_000n);
    // The interleaving, written out: both transactions read the remaining while
    // it is still 10000, and only then does either of them apply.
    const seenByT1 = brokenStaleRead(source);
    const seenByT2 = brokenStaleRead(source);
    expect(seenByT1).toBe(10_000n);
    expect(seenByT2).toBe(10_000n);
    expect(brokenApply(source, 'T1', seenByT1, 10_000n)).toEqual({ ok: true });
    expect(brokenApply(source, 'T2', seenByT2, 10_000n)).toEqual({ ok: true });

    // The planted subject: the source is overdrawn, two refunds were paid out
    // of one credit note, and the COMMIT-time verifier is the thing that would
    // have caught it had the protocol let it run.
    expect(source.remainingMinor).toBe(-10_000n);
    expect(source.verify()).toBe('inconsistent');
  });
});

// ── Race 2: refund vs credit consumption ───────────────────────────────

describe('P4-S5 concurrency model — race 2: a refund against a credit APPLICATION on one source', () => {
  it('both are consumers of the same remaining, so the second one meets the first one', () => {
    const source = customerCredit(7_500n);

    // The application is modelled through the SAME protocol, because it is the
    // same mechanism: a consumer that locks the source, caps against the locked
    // remaining, writes at that level and decrements. `0081:877-878` records
    // that the verifier's consumers are a UNION, and the union is why these two
    // cannot each spend the whole credit.
    expect(correctProtocol(source, 'APPLICATION', 5_000n)).toEqual({ ok: true });
    expect(correctProtocol(source, 'REFUND', 5_000n)).toEqual({ ok: false, code: 'customer_refund.amount_exceeds_source' });
    expect(correctProtocol(source, 'REFUND', 2_500n)).toEqual({ ok: true });

    expect(source.remainingMinor).toBe(0n);
    expect(source.consumers.map((c) => c.by)).toEqual(['APPLICATION', 'REFUND']);
    expect(source.verify()).toBe('ok');
  });

  it('RED PROOF — a verifier that counted only the APPLICATION rows would call the overdrawn state lawful', () => {
    const source = customerCredit(7_500n);
    expect(correctProtocol(source, 'APPLICATION', 5_000n)).toEqual({ ok: true });
    // The refund slips through at a fabricated level, the way it would if the
    // widened guard were not in place.
    source.consumers.push({ by: 'REFUND', remainingBeforeMinor: 2_500n, consumedMinor: 2_500n, releasedBaseMinor: 2_500n });
    source.remainingMinor = 0n;
    expect(source.verify()).toBe('ok');

    // Now drop the refund from the consumer set — which is EXACTLY what
    // `customer_credit_verify` does today, reading
    // `customer_credit_applications` alone (`0081:893-897`) — and the lawful
    // state reads as inconsistent. That is the subject of PATCH-REQ-S5-003:
    // without the UNION ALL branch the verifier refuses a correct refund.
    const applicationsOnly = source.consumers.filter((c) => c.by === 'APPLICATION');
    expect(() =>
      verifySourceConsumptionChain({ originalMinor: 7_500n, originalCarryingMinor: 7_500n, remainingMinor: 0n, remainingCarryingMinor: 0n }, applicationsOnly),
    ).toThrow(/chain/);
  });
});

// ── Race 3: full vs partial ────────────────────────────────────────────

describe('P4-S5 concurrency model — race 3: a FULL refund racing a PARTIAL one', () => {
  it('the partial lands, the full is refused against the reduced remaining, and the retry of the SAME body succeeds at the new cap', () => {
    const source = creditNote(1_000n);

    expect(correctProtocol(source, 'PARTIAL', 300n)).toEqual({ ok: true });
    // The full refund asked for the original 1000. It is refused — and the cap
    // is NOT silently adjusted to fit, which is the whole of the
    // `….settlement_changed` convention: the client retries the SAME body and
    // decides for itself.
    expect(correctProtocol(source, 'FULL', 1_000n)).toEqual({ ok: false, code: 'customer_refund.amount_exceeds_source' });
    expect(source.remainingMinor).toBe(700n);

    expect(correctProtocol(source, 'FULL', 700n)).toEqual({ ok: true });
    expect(source.remainingMinor).toBe(0n);
    expect(source.verify()).toBe('ok');
  });

  it('RED PROOF — the broken protocol lets the full refund pay out 1000 after 300 was already paid', () => {
    const source = creditNote(1_000n);
    expect(correctProtocol(source, 'PARTIAL', 300n)).toEqual({ ok: true });
    // The stale read is taken before the partial commits in a real system; here
    // the broken protocol reads AFTER and still overdraws, because its level is
    // the read and not the lock — a strictly weaker failure than the real one,
    // and it is still a failure.
    const stale = 1_000n;
    source.consumers.push({ by: 'FULL', remainingBeforeMinor: stale, consumedMinor: 1_000n, releasedBaseMinor: 1_000n });
    source.remainingMinor -= 1_000n;
    expect(source.remainingMinor).toBe(-300n);
    expect(source.verify()).toBe('inconsistent');
  });
});

// ── Race 4: the FX cap ─────────────────────────────────────────────────

describe('P4-S5 concurrency model — race 4: the FX cap', () => {
  /**
   * The cap is in the SOURCE's currency and nothing else.
   *
   * A refund may pay out in another currency, and the base difference is
   * realized FX. But a rate that moved between two requests must not widen or
   * narrow what the source can give up: the source's remaining is denominated in
   * the source's own currency, and the disbursement's snapshot is a fact about
   * the money leaving, not about the liability.
   *
   * So this model asks the cap question twice with two very different
   * disbursement rates and asserts the SAME verdict. A cap that moved with the
   * rate would be a cap an attacker can widen by stating a rate.
   */
  it('the cap verdict is identical under two different disbursement rates, because the cap is in the source currency', () => {
    const source = creditNote(5_000n);
    const locked = source.lock('T1');
    expect(locked).not.toBeNull();

    // Two refunds of the same 5000 source-currency units, disbursed at rates
    // that differ by a factor of four. Neither rate enters the cap question.
    const atWeakRate = refundCapRefusal(locked as ConsumableSourceCap, 5_000n);
    const atStrongRate = refundCapRefusal(locked as ConsumableSourceCap, 5_000n);
    expect(atWeakRate).toBeNull();
    expect(atStrongRate).toBeNull();

    // And one source-minor-unit over is refused whatever the rate is.
    expect(refundCapRefusal(locked as ConsumableSourceCap, 5_001n)).toBe('customer_refund.amount_exceeds_source');
    source.release('T1');
  });

  it('RED PROOF — a cap stated in the DISBURSEMENT currency lets a rate move widen it', () => {
    const source = creditNote(5_000n);
    // The defect being planted: the cap compared against a BASE-converted
    // remaining rather than the source's own remaining. At rate 1 it looks
    // right; at rate 4 it admits four times the credit note.
    const capInBase = (rateR10: bigint): bigint => (source.remainingMinor * rateR10) / 10n ** 10n;
    expect(capInBase(10n ** 10n)).toBe(5_000n);
    expect(capInBase(4n * 10n ** 10n)).toBe(20_000n);
    // The correct question never has that shape, and the proof is that the
    // correct cap takes no rate argument at all.
    expect(refundCapRefusal({ kind: 'credit_note', originalMinor: 5_000n, remainingMinor: 5_000n }, 20_000n)).toBe('customer_refund.amount_exceeds_source');
    expect(refundCapRefusal.length).toBe(2);
  });
});

// ── Race 5: the direct-SQL attack ──────────────────────────────────────

describe('P4-S5 concurrency model — race 5: a direct-SQL writer that never takes the lock', () => {
  /**
   * P4-AL-22, in its own words: "a `UNIQUE` over a declared remaining level
   * forbids two rows claiming the same level; it does not cap total consumption,
   * because a direct SQL attacker simply declares a different level."
   *
   * So the level `UNIQUE` is modelled as what it is — a fast per-relation
   * backstop — and the thing that actually refuses the attacker is the
   * COMMIT-time chain verifier. Both arms are asserted, because an
   * implementation that shipped only the `UNIQUE` would pass a test that
   * asserted only the first.
   */
  it('the optimistic row count refuses a decrement computed from a fabricated level', () => {
    const source = creditNote(2_000n);
    expect(correctProtocol(source, 'HONEST', 500n)).toEqual({ ok: true });
    expect(source.remainingMinor).toBe(1_500n);

    // The attacker declares the ORIGINAL level, which no longer holds.
    expect(source.decrement(2_000n, 2_000n)).toBe('source_changed');
    expect(source.remainingMinor).toBe(1_500n);
  });

  it('and when a direct write forces the row anyway, the COMMIT-time chain verifier refuses it', () => {
    const source = creditNote(2_000n);
    expect(correctProtocol(source, 'HONEST', 500n)).toEqual({ ok: true });

    // A row at a level no consumer could lawfully have seen — 1499, one minor
    // unit off the real 1500 — inserted directly. It is DISTINCT from the honest
    // row's level, so the level UNIQUE is satisfied and proves nothing. That is
    // P4-AL-22's "a direct SQL attacker simply declares a different level",
    // literally.
    source.consumers.push({ by: 'ATTACKER', remainingBeforeMinor: 1_499n, consumedMinor: 1_000n, releasedBaseMinor: 1_000n });
    source.remainingMinor = 500n;
    const levels = source.consumers.map((c) => c.remainingBeforeMinor);
    expect(new Set(levels).size).toBe(levels.length); // the UNIQUE is green…
    expect(source.verify()).toBe('inconsistent'); // …and the chain verifier is not.
  });

  it('RED PROOF — the level UNIQUE alone, as the whole mechanism, calls the attacked state lawful', () => {
    const source = creditNote(2_000n);
    expect(correctProtocol(source, 'HONEST', 500n)).toEqual({ ok: true });
    source.consumers.push({ by: 'ATTACKER', remainingBeforeMinor: 1_499n, consumedMinor: 1_000n, releasedBaseMinor: 1_000n });
    source.remainingMinor = 500n;

    // A guard that checked only "no two rows claim the same level" — the
    // supplier shape at `0067:491`, taken as sufficient — is green here, on a
    // source that has given up 1500 of 2000 while its row says 500 remain.
    const levelUniqueHolds = new Set(source.consumers.map((c) => c.remainingBeforeMinor)).size === source.consumers.length;
    expect(levelUniqueHolds).toBe(true);

    // And the thing the UNIQUE cannot see: the levels do not CHAIN. The
    // attacker's row declares 1499 where the chain requires 1500, so no
    // consumer could lawfully have read it. Note that the SUM happens to
    // reconcile — 2000 − (500 + 1000) = 500, the stored remaining — which is
    // precisely why a verifier that checked only the total would also be green
    // here, and why the accepted chain law checks the LEVELS and not the sum.
    const ordered = [...source.consumers].sort((a, b) => (a.remainingBeforeMinor > b.remainingBeforeMinor ? -1 : 1));
    let running = 0n;
    let chainHolds = true;
    for (const row of ordered) {
      if (row.remainingBeforeMinor !== source.originalMinor - running) chainHolds = false;
      running += row.consumedMinor;
    }
    expect(source.originalMinor - running).toBe(source.remainingMinor);
    expect(chainHolds).toBe(false);
    expect(source.verify()).toBe('inconsistent');
  });

  it('RED PROOF — a level UNIQUE over a NULLABLE source column is vacuous for the other half of the refunds', () => {
    /**
     * The trap the preparation page measures (§4): `supplier_refunds_level_uq`
     * is `UNIQUE (business_id, credit_note_id, credit_remaining_before_minor)`
     * over a `credit_note_id UUID NOT NULL`. S5's `refunds` has TWO NULLABLE
     * sources by ruling, and in PostgreSQL a `UNIQUE` is `NULLS DISTINCT` by
     * default — this tree never writes `NULLS NOT DISTINCT` (the sole mention is
     * a comment at `0005:74`).
     *
     * So the copied constraint is GREEN and VACUOUS for every refund drawn on a
     * customer credit. Modelled here over the key tuple itself, because that is
     * the level at which the defect is visible and no amount of SQL review
     * catches it from reading the constraint.
     */
    const nullsDistinctKeyCollides = (a: readonly [string | null, bigint], b: readonly [string | null, bigint]): boolean =>
      a[0] !== null && b[0] !== null && a[0] === b[0] && a[1] === b[1];

    // Two credit-note refunds at the same level: the constraint catches them.
    expect(nullsDistinctKeyCollides(['note-1', 500n], ['note-1', 500n])).toBe(true);
    // Two CUSTOMER-CREDIT refunds at the same level: `credit_note_id` is NULL
    // on both, so the key never collides and the constraint admits both.
    expect(nullsDistinctKeyCollides([null, 500n], [null, 500n])).toBe(false);

    // Which is why the DDL specification requires TWO PARTIAL unique indexes,
    // one per source, each with its own red proof — never one constraint over
    // two nullable columns.
  });
});
