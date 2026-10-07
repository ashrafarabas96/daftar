/**
 * P4-S5, maturity level C — the CONCURRENCY MODELS of the refund cap.
 *
 * ## What this file is
 *
 * Five races, each modelled DETERMINISTICALLY as TWO TRANSACTIONS whose steps
 * are interleaved explicitly. There is **no `sleep`, no timer and no
 * `Promise.all` over two real connections** anywhere in it: a race proved by
 * timing passes on a fast machine and reddens CI on a slow one, and a race
 * *disproved* by timing proves nothing at all. The barriers here are the row
 * lock and the unique index, both of which refuse rather than wait, so the
 * interleaving a test writes is the interleaving that runs.
 *
 * It is a MODEL and says so. It touches no database, because `refunds`,
 * `credit_notes` and `credit_note_applications` exist at no migration prefix
 * `0000`–`0086` and S5 owns no migration number. What it pins is the SHAPE of
 * the protocol — lock, read under the lock, cap against THAT reading, insert at
 * THAT level, decrement optimistically, verify the chain at COMMIT — so the
 * implementation written against the sealed schema has a specification to be
 * judged against.
 *
 * ## The model implements the isolation level it names
 *
 * This is the one lesson of `docs/PHASE_4_S6_LEVEL_UNIQUENESS.md` §1A, which
 * records how a sibling slice's model declared READ COMMITTED in its header
 * while writing into a shared `Map` that every transaction could read — READ
 * UNCOMMITTED, whatever the comment said — and how that, together with a
 * rollback that cleared the locks but left the rows, produced a green verdict
 * for a mechanism that did not work. So:
 *
 * - every write is STAGED in the writing transaction's own buffer;
 * - a read sees COMMITTED state plus the reader's OWN buffer, and nothing of
 *   any other transaction's;
 * - `commit` PUBLISHES the buffer; `rollback` DISCARDS it, rows and all;
 * - the chain verifier takes a TRANSACTION ID, because a `DEFERRABLE INITIALLY
 *   DEFERRED` constraint trigger fires INSIDE the committing transaction and
 *   therefore sees exactly that transaction's view — not the committed state a
 *   later reader sees, and not another transaction's staged rows;
 * - the unique index is modelled as what §1A calls it: a CONCURRENCY PRIMITIVE,
 *   not a predicate. It excludes at the KEY, across transactions, on a path
 *   where no lock was taken, and it does so atomically.
 *
 * Both mechanisms are proved LOAD-BEARING by mutation, at the end of the file:
 * a world whose `rollback` publishes instead of discarding, and a world at READ
 * UNCOMMITTED, each behave differently from the correct world on a case the
 * correct world passes. A model whose defects are not shown to matter is a
 * model nobody can trust.
 *
 * ## Why every model has a RED PROOF beside it
 *
 * `[[daftar-a-green-gate-must-prove-it-can-be-red]]`. For each race the file
 * runs the protocol correctly and then runs the protocol a real implementation
 * is most likely to write instead — the cap checked against a remaining read
 * BEFORE the lock — and the broken one MUST overdraw. A model that cannot
 * distinguish the two proves nothing about either.
 *
 * The planted subject in every red proof is REAL: the protocol under attack is
 * the one `apps/api/src/modules/returns/returns-settlement.ts` implements and
 * `apps/api/src/modules/returns/returns-ports.ts` prescribes, and the figures
 * are the figures the accepted `customer_credit_consume` (`0081:1224-1250`) and
 * `customer_credit_verify` (`0081:879-918`) operate on.
 *
 * ## The carrying half is exercised, not flattened
 *
 * The source below is a 10 000-unit note carrying 10 853 base — rate 1.0853, so
 * `carrying ≠ amount` at every level and `g` is genuinely non-linear. Each
 * staged row's `releasedBaseMinor` is `creditRelease(...)` and each decrement
 * recomputes the stored carrying as `creditRemainingCarrying(...)` from the
 * ORIGINAL pair, never from the previous rounded step. The chain verifier's
 * carrying law — `Σ cr_rel = OB − g(remaining)` and
 * `stored remaining carrying = g(stored remaining)` — is therefore a live
 * assertion in every race rather than an identity made true by setting the two
 * halves equal.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { refundCapRefusal, type ConsumableSourceCap, type RefundSourceKind, type ReturnsRefusalCode } from '@daftar/domain-core';
import { creditRelease, creditRemainingCarrying } from '@daftar/inventory';
import { verifySourceConsumptionChain, type SourceConsumerRow } from '../../apps/api/src/modules/returns/returns-settlement';

/**
 * A name that would carry, or stand in for, an FX rate. Used by the structural
 * half of the cap proof, and asserted able to match before it is relied on.
 */
const RATE_SHAPED = /rate|conversion|exponent|currency|snapshot|base/i;

// ── The model ───────────────────────────────────────────────────────────

/**
 * One consumer row as the model stores it. The same three columns the accepted
 * chain verifier reads — the LEVEL, the amount, the carrying released — because
 * a model that stored a running total would be modelling a design this slice
 * forbids.
 */
type ConsumerRow = SourceConsumerRow & { readonly by: string };

/** What one transaction has written and not yet committed. */
interface Staged {
  readonly rows: ConsumerRow[];
  /** `null` until the transaction has decremented the source row. */
  remainingMinor: bigint | null;
  remainingCarryingMinor: bigint | null;
}

interface WorldOptions {
  /**
   * `'read committed'` is the correct setting and the default. `'read
   * uncommitted'` exists ONLY so the mutation suite at the end of this file can
   * prove that the correct setting is load-bearing.
   */
  readonly isolation?: 'read committed' | 'read uncommitted';
  /**
   * `true` is the correct setting and the default: a rolled-back transaction's
   * staged rows are DISCARDED. `false` exists only for the mutation suite.
   */
  readonly discardOnRollback?: boolean;
}

/** The index's verdict, in the three shapes PostgreSQL actually produces. */
type IndexVerdict = 'ok' | 'blocked_on_uncommitted_key' | 'duplicate_key';

/**
 * An in-memory consumable source: committed state, per-transaction buffers, a
 * row lock and a unique index over the level.
 */
class World {
  lockedBy: string | null = null;

  private readonly committed: ConsumerRow[] = [];
  private committedRemainingMinor: bigint;
  private committedRemainingCarryingMinor: bigint;
  private readonly buffers = new Map<string, Staged>();
  private readonly isolation: 'read committed' | 'read uncommitted';
  private readonly discardOnRollback: boolean;

  constructor(
    readonly kind: RefundSourceKind,
    readonly originalMinor: bigint,
    readonly originalCarryingMinor: bigint,
    options: WorldOptions = {},
  ) {
    this.committedRemainingMinor = originalMinor;
    this.committedRemainingCarryingMinor = originalCarryingMinor;
    this.isolation = options.isolation ?? 'read committed';
    this.discardOnRollback = options.discardOnRollback ?? true;
  }

  private staged(txn: string): Staged {
    let s = this.buffers.get(txn);
    if (s === undefined) {
      s = { rows: [], remainingMinor: null, remainingCarryingMinor: null };
      this.buffers.set(txn, s);
    }
    return s;
  }

  /** The committed remaining a transaction that has written nothing would read. */
  get committedRemaining(): bigint {
    return this.committedRemainingMinor;
  }

  get committedRemainingCarrying(): bigint {
    return this.committedRemainingCarryingMinor;
  }

  /**
   * What `txn` can SEE: committed state, plus its own staged write — and, under
   * the mutated READ UNCOMMITTED setting only, every other transaction's too.
   */
  private visibleRows(txn: string): ConsumerRow[] {
    if (this.isolation === 'read uncommitted') {
      return [...this.committed, ...[...this.buffers.values()].flatMap((b) => b.rows)];
    }
    return [...this.committed, ...this.staged(txn).rows];
  }

  private visibleRemaining(txn: string): { readonly amount: bigint; readonly carrying: bigint } {
    if (this.isolation === 'read uncommitted') {
      const written = [...this.buffers.values()].filter((b) => b.remainingMinor !== null);
      const last = written[written.length - 1];
      if (last !== undefined) return { amount: last.remainingMinor as bigint, carrying: last.remainingCarryingMinor as bigint };
    } else {
      const own = this.buffers.get(txn);
      if (own !== undefined && own.remainingMinor !== null) {
        return { amount: own.remainingMinor, carrying: own.remainingCarryingMinor as bigint };
      }
    }
    return { amount: this.committedRemainingMinor, carrying: this.committedRemainingCarryingMinor };
  }

  /**
   * The unlocked read a careless implementation would use: `SELECT` with no
   * `FOR UPDATE`. Under READ COMMITTED it returns the COMMITTED remaining, so a
   * stale read is stale precisely because another transaction's write is not
   * visible yet — the real mechanism, not an approximation of it.
   */
  dirtyRead(txn: string): bigint {
    return this.visibleRemaining(txn).amount;
  }

  /** `SELECT … FOR UPDATE`. `null` when another transaction holds the row. Held until commit or rollback. */
  lock(txn: string): ConsumableSourceCap | null {
    if (this.lockedBy !== null && this.lockedBy !== txn) return null;
    this.lockedBy = txn;
    return { kind: this.kind, originalMinor: this.originalMinor, remainingMinor: this.visibleRemaining(txn).amount };
  }

  /**
   * `INSERT` into the consumer relation, through the LEVEL UNIQUE.
   *
   * The index is the concurrency primitive §1A describes, in its three real
   * behaviours: an equal key held by another UNCOMMITTED transaction BLOCKS the
   * inserter (`blocked_on_uncommitted_key`), an equal key already COMMITTED is a
   * `23505` (`duplicate_key`), and the check and the claim are one act — there
   * is no window between them, because this method is the only way a row
   * reaches the relation.
   */
  insertAtLevel(txn: string, row: ConsumerRow): IndexVerdict {
    for (const [other, buffer] of this.buffers) {
      if (other === txn) continue;
      if (buffer.rows.some((r) => r.remainingBeforeMinor === row.remainingBeforeMinor)) return 'blocked_on_uncommitted_key';
    }
    if (this.committed.some((r) => r.remainingBeforeMinor === row.remainingBeforeMinor)) return 'duplicate_key';
    if (this.staged(txn).rows.some((r) => r.remainingBeforeMinor === row.remainingBeforeMinor)) return 'duplicate_key';
    this.staged(txn).rows.push(row);
    return 'ok';
  }

  /**
   * The optimistic decrement: `UPDATE … WHERE remaining_amount_minor = $level`,
   * with the row count as the verdict — the `0081:1239-1250` shape.
   *
   * The new carrying is `g(remaining_after)` from the ORIGINAL pair, which is
   * the condition `customer_credit_guard` (`0081:1090-1117`) enforces on the
   * row and the one `verifyCreditChain` re-derives at COMMIT.
   */
  decrement(txn: string, level: bigint, consumedMinor: bigint): 'ok' | 'source_changed' {
    if (this.visibleRemaining(txn).amount !== level) return 'source_changed';
    const after = level - consumedMinor;
    const s = this.staged(txn);
    s.remainingMinor = after;
    s.remainingCarryingMinor = creditRemainingCarrying(this.originalMinor, this.originalCarryingMinor, after);
    return 'ok';
  }

  /**
   * The decrement an implementation that "retries until it succeeds" ends up
   * performing: `UPDATE … SET remaining = remaining − $c` with NO level
   * predicate, so the row count never refuses anything. Used only by the broken
   * protocol, and named so a red proof can name its mistake.
   */
  forceDecrement(txn: string, consumedMinor: bigint): void {
    const seen = this.visibleRemaining(txn);
    const after = seen.amount - consumedMinor;
    const s = this.staged(txn);
    s.remainingMinor = after;
    // `g` REFUSES a negative remaining, which is the row guard doing its job —
    // and a protocol that forced the row past zero never reached the guard. So
    // the model stores what a bare `SET remaining = remaining − c` would leave
    // behind, and lets the COMMIT-time verifier be the thing that reports it.
    s.remainingCarryingMinor = after < 0n ? seen.carrying - consumedMinor : creditRemainingCarrying(this.originalMinor, this.originalCarryingMinor, after);
  }

  /** The release this slice's arithmetic computes for a consumption at `level`. */
  releaseFor(level: bigint, consumedMinor: bigint): bigint {
    return creditRelease(this.originalMinor, this.originalCarryingMinor, level, consumedMinor);
  }

  /**
   * The COMMIT-time chain law, as the DEFERRED constraint trigger sees it:
   * inside `txn`, over `txn`'s own view.
   *
   * It takes the transaction id because that is the whole point of §1A's
   * finding. A verifier that read some global state would see rows no committing
   * transaction can see, and would answer a question nobody asked.
   */
  verifyAsSeenBy(txn: string): 'ok' | 'inconsistent' {
    const seen = this.visibleRemaining(txn);
    return this.judge(seen.amount, seen.carrying, this.visibleRows(txn));
  }

  /** The same law over COMMITTED state — what a later reader, or a nightly check, would find. */
  verifyCommitted(): 'ok' | 'inconsistent' {
    return this.judge(this.committedRemainingMinor, this.committedRemainingCarryingMinor, [...this.committed]);
  }

  private judge(remainingMinor: bigint, remainingCarryingMinor: bigint, rows: readonly ConsumerRow[]): 'ok' | 'inconsistent' {
    try {
      verifySourceConsumptionChain(
        {
          originalMinor: this.originalMinor,
          originalCarryingMinor: this.originalCarryingMinor,
          remainingMinor,
          remainingCarryingMinor,
        },
        rows,
      );
      return 'ok';
    } catch {
      return 'inconsistent';
    }
  }

  /** PUBLISH the buffer and release the lock. */
  commit(txn: string): void {
    const s = this.buffers.get(txn);
    if (s !== undefined) {
      this.committed.push(...s.rows);
      if (s.remainingMinor !== null) {
        this.committedRemainingMinor = s.remainingMinor;
        this.committedRemainingCarryingMinor = s.remainingCarryingMinor as bigint;
      }
      this.buffers.delete(txn);
    }
    if (this.lockedBy === txn) this.lockedBy = null;
  }

  /** DISCARD the buffer — rows and the staged remaining both — and release the lock. */
  rollback(txn: string): void {
    if (!this.discardOnRollback) {
      // The MUTATION: publish instead of discarding. A refused transaction's row
      // stays in the world for ever, which is the exact defect §1A.2 records.
      this.commit(txn);
      return;
    }
    this.buffers.delete(txn);
    if (this.lockedBy === txn) this.lockedBy = null;
  }

  committedRowsBy(): readonly string[] {
    return this.committed.map((r) => r.by);
  }

  committedLevels(): readonly bigint[] {
    return this.committed.map((r) => r.remainingBeforeMinor);
  }
}

type Outcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ReturnsRefusalCode | 'blocked' | 'blocked_on_uncommitted_key' | 'duplicate_key' | 'chain_inconsistent' };

/**
 * The CORRECT protocol, as ONE transaction: lock, read under the lock, cap
 * against THAT reading, insert at THAT level, decrement optimistically, let the
 * deferred verifier judge, and then commit — or roll back, which discards
 * everything it staged.
 *
 * `TL-P4-S5-R1` is visible in what it does not do: it reads no invoice, writes
 * no AR and takes no lock on one.
 */
function refundTxn(world: World, txn: string, requestedMinor: bigint): Outcome {
  const locked = world.lock(txn);
  if (locked === null) return { ok: false, code: 'blocked' };
  const fail = (code: Exclude<Outcome, { ok: true }>['code']): Outcome => {
    world.rollback(txn);
    return { ok: false, code };
  };
  const capProblem = refundCapRefusal(locked, requestedMinor);
  if (capProblem !== null) return fail(capProblem);
  const level = locked.remainingMinor;
  const inserted = world.insertAtLevel(txn, {
    by: txn,
    remainingBeforeMinor: level,
    consumedMinor: requestedMinor,
    releasedBaseMinor: world.releaseFor(level, requestedMinor),
  });
  if (inserted !== 'ok') return fail(inserted);
  if (world.decrement(txn, level, requestedMinor) !== 'ok') return fail('customer_refund.source_changed');
  if (world.verifyAsSeenBy(txn) !== 'ok') return fail('chain_inconsistent');
  world.commit(txn);
  return { ok: true };
}

/**
 * The BROKEN protocol the red proofs plant, in its two halves: the remaining is
 * read BEFORE the lock (`brokenStaleRead`), and the cap is then checked and the
 * row written against that stale level (`brokenApply`).
 *
 * It is split in two so a test can write the interleaving that actually bites —
 * BOTH transactions read, THEN both apply — deterministically, with no timing
 * involved.
 *
 * This is not a straw man. It is the natural shape of an implementation that
 * validates the request in a service method and then calls a repository, and it
 * is exactly why «the refund cap is checked INSIDE the source under
 * `FOR UPDATE`» is a law about WHERE the check happens and not merely that it
 * happens.
 */
function brokenStaleRead(world: World, txn: string): bigint {
  return world.dirtyRead(txn);
}

function brokenApply(world: World, txn: string, stale: bigint, requestedMinor: bigint): Outcome {
  const capProblem = refundCapRefusal({ kind: world.kind, originalMinor: world.originalMinor, remainingMinor: stale }, requestedMinor);
  if (capProblem !== null) return { ok: false, code: capProblem };
  const inserted = world.insertAtLevel(txn, {
    by: txn,
    remainingBeforeMinor: stale,
    consumedMinor: requestedMinor,
    releasedBaseMinor: world.releaseFor(stale, requestedMinor),
  });
  if (inserted !== 'ok') {
    world.rollback(txn);
    return { ok: false, code: inserted };
  }
  // The defect: it forces the decrement at the STALE level instead of letting
  // the optimistic row count refuse it — which is what an implementation that
  // "retries until it succeeds" amounts to — and it commits without letting the
  // deferred verifier speak.
  world.forceDecrement(txn, requestedMinor);
  world.commit(txn);
  return { ok: true };
}

/** 10 000 units carrying 10 853 base: rate 1.0853, so `carrying ≠ amount` everywhere. */
const NOTE_ORIGINAL = 10_000n;
const NOTE_CARRYING = 10_853n;

const creditNote = (options: WorldOptions = {}): World => new World('credit_note', NOTE_ORIGINAL, NOTE_CARRYING, options);
const customerCredit = (options: WorldOptions = {}): World => new World('customer_credit', NOTE_ORIGINAL, NOTE_CARRYING, options);

// ── Race 1: refund vs refund ────────────────────────────────────────────

describe('P4-S5 concurrency model — race 1: refund vs refund on one source', () => {
  it('T2 cannot take the lock while T1 holds it, and meets the NEW remaining once T1 commits', () => {
    const w = creditNote();

    // T1 begins and takes the lock. T2 arrives mid-flight and is BLOCKED — it is
    // not permitted to read a remaining that T1 is about to change.
    expect(w.lock('T1')).not.toBeNull();
    expect(w.lock('T2')).toBeNull();
    w.rollback('T1');

    // T1 then runs its transaction properly, inside the lock.
    expect(refundTxn(w, 'T1', 6_000n)).toEqual({ ok: true });

    // Only now can T2 proceed, and what it reads is 4 000 and not 10 000.
    expect(w.lock('T2')).toEqual({ kind: 'credit_note', originalMinor: 10_000n, remainingMinor: 4_000n });
    w.rollback('T2');
    expect(refundTxn(w, 'T2', 6_000n)).toEqual({ ok: false, code: 'customer_refund.amount_exceeds_source' });
    expect(refundTxn(w, 'T2', 4_000n)).toEqual({ ok: true });

    expect(w.committedRemaining).toBe(0n);
    expect(w.committedRemainingCarrying).toBe(0n);
    expect(w.committedRowsBy()).toEqual(['T1', 'T2']);
    expect(w.verifyCommitted()).toBe('ok');
  });

  it('the carrying releases are non-linear, unequal for equal amounts, and still sum to the original carrying', () => {
    const w = creditNote();
    expect(refundTxn(w, 'T1', 3_333n)).toEqual({ ok: true });
    expect(refundTxn(w, 'T2', 3_333n)).toEqual({ ok: true });
    expect(refundTxn(w, 'T3', 3_334n)).toEqual({ ok: true });
    // Each release is `g(rb) − g(rb − c)` at its OWN level, and two equal
    // amounts at different levels release DIFFERENT carrying base — the fact a
    // model with `carrying == amount` cannot exhibit at all.
    const releases = [w.releaseFor(10_000n, 3_333n), w.releaseFor(6_667n, 3_333n), w.releaseFor(3_334n, 3_334n)];
    expect(releases[0]).not.toBe(releases[1]);
    expect(releases.reduce((a, b) => a + b, 0n)).toBe(NOTE_CARRYING);
    expect(w.committedRemaining).toBe(0n);
    expect(w.verifyCommitted()).toBe('ok');
  });

  it('RED PROOF — under READ COMMITTED two unlocked readers each see 10 000, and the overdraw is real', () => {
    // The interleaving, written out. BOTH transactions read while the committed
    // remaining is still 10 000 — and under READ COMMITTED a staged write is
    // genuinely invisible, which is why the read is stale and why this race is a
    // race rather than an artefact of a shared mutable map.
    const w = creditNote();
    const t1 = brokenStaleRead(w, 'T1');
    const t2 = brokenStaleRead(w, 'T2');
    expect([t1, t2]).toEqual([10_000n, 10_000n]);
    expect(brokenApply(w, 'T1', t1, 10_000n)).toEqual({ ok: true });
    // T2's level is 10 000 too, and T1 has now COMMITTED a row at that level, so
    // the level UNIQUE catches this particular overdraw. That is the index doing
    // its job on the unlocked path — and it is the ONLY thing that does, because
    // neither transaction took the lock and neither ran the verifier.
    expect(brokenApply(w, 'T2', t2, 10_000n)).toEqual({ ok: false, code: 'duplicate_key' });
    expect(w.committedRemaining).toBe(0n);

    // So an overdraw needs a DIFFERENT level, which is exactly P4-AL-22's
    // attacker. On a fresh world T2 declares 9 999 — one off the truth — and
    // nothing on the unlocked path refuses it.
    const w2 = creditNote();
    expect(brokenApply(w2, 'T1', brokenStaleRead(w2, 'T1'), 10_000n)).toEqual({ ok: true });
    expect(brokenApply(w2, 'T2', 9_999n, 9_999n)).toEqual({ ok: true });
    // The planted subject: 19 999 units refunded out of a 10 000-unit note, and
    // the COMMIT-time verifier is the thing that would have caught it had the
    // protocol let it run.
    expect(w2.committedRemaining).toBe(-9_999n);
    expect(w2.verifyCommitted()).toBe('inconsistent');
  });
});

// ── Race 2: refund vs credit consumption ───────────────────────────────

describe('P4-S5 concurrency model — race 2: a refund and an APPLICATION consuming one source', () => {
  it('both are consumers of the same remaining, so the second meets the first', () => {
    const w = customerCredit();

    // The application is modelled through the SAME protocol, because it is the
    // same mechanism: a consumer that locks the source, caps against the locked
    // remaining, writes at that level and decrements. `0081:877-878` records
    // that the verifier's consumers are a UNION, and the union is why these two
    // cannot each spend the whole credit.
    expect(refundTxn(w, 'APPLICATION', 7_000n)).toEqual({ ok: true });
    expect(refundTxn(w, 'REFUND', 7_000n)).toEqual({ ok: false, code: 'customer_refund.amount_exceeds_source' });
    expect(refundTxn(w, 'REFUND', 3_000n)).toEqual({ ok: true });

    expect(w.committedRemaining).toBe(0n);
    expect(w.committedRowsBy()).toEqual(['APPLICATION', 'REFUND']);
    expect(w.verifyCommitted()).toBe('ok');
  });

  it('an application that ROLLS BACK leaves the refund the WHOLE remaining — the discard, as a behaviour', () => {
    const w = customerCredit();

    // The application takes the lock and stages a row…
    expect(w.lock('APPLICATION')).not.toBeNull();
    expect(
      w.insertAtLevel('APPLICATION', {
        by: 'APPLICATION',
        remainingBeforeMinor: 10_000n,
        consumedMinor: 7_000n,
        releasedBaseMinor: w.releaseFor(10_000n, 7_000n),
      }),
    ).toBe('ok');
    expect(w.decrement('APPLICATION', 10_000n, 7_000n)).toBe('ok');
    // …and the refund, arriving now, is blocked rather than shown a half-done world.
    expect(w.lock('REFUND')).toBeNull();
    // …then the application is refused — a later guard, a permission, anything.
    w.rollback('APPLICATION');

    // The refund now sees the FULL 10 000 and may take all of it, AT the
    // original level — the level the application had staged and discarded.
    expect(refundTxn(w, 'REFUND', 10_000n)).toEqual({ ok: true });
    expect(w.committedLevels()).toEqual([10_000n]);
    expect(w.committedRowsBy()).toEqual(['REFUND']);
    expect(w.verifyCommitted()).toBe('ok');
  });

  it('a lawful refund whose source branch is MISSING from the verifier is FALSELY REFUSED — the dangerous direction for this shape', () => {
    // The title matters, and the earlier one had it backwards. For THIS shape
    // the danger is not a false acceptance: it is a FALSE REFUSAL. A verifier
    // that reads `customer_credit_applications` alone (`0081:893-897`) sees a
    // credit whose stored remaining is lower than its own consumer rows explain,
    // so it raises — and the transaction it kills is the CORRECT one. A missing
    // branch does not admit an overdrawn state; it refuses a lawful refund.
    const w = customerCredit();
    expect(refundTxn(w, 'APPLICATION', 7_000n)).toEqual({ ok: true });
    expect(refundTxn(w, 'REFUND', 3_000n)).toEqual({ ok: true });
    // With BOTH consumers counted, the chain is one chain.
    expect(w.verifyCommitted()).toBe('ok');

    // Drop the refund from the consumer set — exactly what today's
    // `customer_credit_verify` does — and the LAWFUL state reads as broken.
    const applicationsOnly = [{ remainingBeforeMinor: 10_000n, consumedMinor: 7_000n, releasedBaseMinor: w.releaseFor(10_000n, 7_000n) }];
    expect(() =>
      verifySourceConsumptionChain(
        { originalMinor: NOTE_ORIGINAL, originalCarryingMinor: NOTE_CARRYING, remainingMinor: 0n, remainingCarryingMinor: 0n },
        applicationsOnly,
      ),
    ).toThrow(/chain/);
    // So `PATCH-REQ-S5-003`'s `UNION ALL` branch is not a hardening: without it
    // the refund command cannot commit at all.
  });
});

// ── Race 3: full vs partial ────────────────────────────────────────────

describe('P4-S5 concurrency model — race 3: a FULL refund racing a PARTIAL one', () => {
  it('the partial lands, the full is refused against the reduced remaining, and the retry of the SAME body succeeds at the new cap', () => {
    const w = creditNote();

    // PARTIAL takes the lock and FULL arrives mid-flight: it never gets to
    // compute a cap against a remaining that is about to move.
    expect(w.lock('PARTIAL')).not.toBeNull();
    expect(w.lock('FULL')).toBeNull();
    w.rollback('PARTIAL');

    expect(refundTxn(w, 'PARTIAL', 3_000n)).toEqual({ ok: true });
    // The full refund asked for the original 10 000. It is refused — and the cap
    // is NOT silently adjusted to fit, which is the whole of the
    // `….settlement_changed` convention: the client retries the SAME body and
    // decides for itself.
    expect(refundTxn(w, 'FULL', 10_000n)).toEqual({ ok: false, code: 'customer_refund.amount_exceeds_source' });
    expect(w.committedRemaining).toBe(7_000n);

    expect(refundTxn(w, 'FULL', 7_000n)).toEqual({ ok: true });
    expect(w.committedRemaining).toBe(0n);
    expect(w.verifyCommitted()).toBe('ok');
  });

  it('RED PROOF — an HONEST but stale full refund is caught by the level UNIQUE, and a LYING one is not', () => {
    const w = creditNote();
    // The real interleaving: FULL reads 10 000 while PARTIAL has staged nothing
    // yet, PARTIAL then runs its whole transaction and commits, and FULL applies
    // against its stale 10 000.
    const stale = brokenStaleRead(w, 'FULL');
    expect(stale).toBe(10_000n);
    expect(refundTxn(w, 'PARTIAL', 3_000n)).toEqual({ ok: true });

    // FULL's level is 10 000, which PARTIAL has now committed a row at, so the
    // index refuses it atomically — on a path where FULL took no lock and ran no
    // verifier. The index as a CONCURRENCY PRIMITIVE and not a predicate:
    // nothing FULL could have SELECTed would have told it.
    expect(brokenApply(w, 'FULL', stale, 10_000n)).toEqual({ ok: false, code: 'duplicate_key' });
    expect(w.committedRemaining).toBe(7_000n);
    expect(w.verifyCommitted()).toBe('ok');

    // And the complement, so the index is not credited with more than it does: a
    // writer that declares a level nobody has used is NOT refused by it.
    expect(brokenApply(w, 'FULL', 9_000n, 9_000n)).toEqual({ ok: true });
    expect(w.committedRemaining).toBe(-2_000n);
    expect(w.verifyCommitted()).toBe('inconsistent');
  });
});

// ── Property 4 (NOT a race): the cap's currency ────────────────────────

describe('P4-S5 — property 4: the cap is invariant under the disbursement rate (NOT an interleaving)', () => {
  /**
   * **This is a PROPERTY TEST and not a race**, and the earlier title calling it
   * "race 4: the FX cap" was wrong in a way worth correcting rather than
   * quietly renaming: a reader counting the slice's concurrency evidence would
   * have counted five interleavings where there are four. Nothing below
   * interleaves two transactions. One transaction holds the lock and the cap is
   * evaluated repeatedly against a spread of disbursement rates.
   *
   * It belongs in this file all the same, because it is the law that makes the
   * four real races SUFFICIENT: if the cap could be widened by a rate that
   * moved, then holding the lock and reading the remaining under it would not
   * be enough, and every interleaving above would have a second variable in it.
   *
   * The law: the cap is in the SOURCE's currency and nothing else. A refund may
   * pay out in another currency, and the base difference is realized FX. But a
   * rate that moved between two requests must not widen or narrow what the
   * source can give up — the source's remaining is denominated in the source's
   * own currency, and the disbursement's snapshot is a fact about the money
   * leaving, not about the liability.
   */
  it('the cap verdict is invariant under the disbursement rate, as a property over a spread of rates', () => {
    const w = creditNote();
    const locked = w.lock('T1');
    expect(locked).not.toBeNull();

    // A HOSTILE caller: the locked source is handed to the cap with a
    // disbursement rate welded onto it, at rates spanning eight orders of
    // magnitude. The cap must return the same verdict for every one of them,
    // because none of them is part of the question. An implementation that read
    // `source.conversion` — the plausible mistake, since every other function on
    // this path legitimately does — varies here and the property fails.
    const RATES = [10n ** 6n, 10n ** 10n, 4n * 10n ** 10n, 97n * 10n ** 9n, 10n ** 14n];
    const withRate = (rateR10: bigint): ConsumableSourceCap =>
      ({ ...(locked as ConsumableSourceCap), conversion: { rateR10, txnExponent: 2, baseExponent: 2 } }) as ConsumableSourceCap;

    for (const requested of [1n, 9_999n, 10_000n, 10_001n, 40_000n]) {
      const verdicts = RATES.map((r) => refundCapRefusal(withRate(r), requested));
      // One verdict, whatever the rate.
      expect(new Set(verdicts).size).toBe(1);
      // And it is the verdict the source's own remaining dictates.
      expect(verdicts[0]).toBe(requested > 10_000n ? 'customer_refund.amount_exceeds_source' : null);
    }

    // The property is shown NON-VACUOUS: the rates genuinely differ, and a cap
    // that did read them would have produced different verdicts at 40 000.
    expect(new Set(RATES).size).toBe(RATES.length);
    expect(RATES.map((r) => (10_000n * r) / 10n ** 10n)).not.toEqual(RATES.map(() => 10_000n));
    w.rollback('T1');
  });

  it('RED PROOF — a cap stated in the DISBURSEMENT currency lets a rate move widen it, and this one structurally cannot be', () => {
    // The defect being planted: the cap compared against a BASE-converted
    // remaining rather than the source's own remaining. At rate 1 it looks
    // right; at rate 4 it admits four times the credit note.
    const capInBase = (rateR10: bigint): bigint => (NOTE_ORIGINAL * rateR10) / 10n ** 10n;
    expect(capInBase(10n ** 10n)).toBe(10_000n);
    expect(capInBase(4n * 10n ** 10n)).toBe(40_000n);
    expect(refundCapRefusal({ kind: 'credit_note', originalMinor: NOTE_ORIGINAL, remainingMinor: NOTE_ORIGINAL }, 40_000n)).toBe(
      'customer_refund.amount_exceeds_source',
    );

    // The STRUCTURAL half, read off the declaration rather than counted off the
    // function object. `Function.prototype.length` is not an arity: it stops at
    // the first parameter with a default and says nothing about what a parameter
    // CONTAINS, so a cap that took `(source, requested, conversion = BASE)`
    // would report 2 and pass an arity assertion while reading a rate.
    const src = readFileSync(join(__dirname, '../../packages/domain-core/src/returns.ts'), 'utf8');

    // (a) the declared parameter list of the cap, verbatim.
    const params = /export function refundCapRefusal\(([^)]*)\)/.exec(src)?.[1];
    expect(params).toBeDefined();
    const declared = (params as string)
      .split(',')
      .map((t) => t.trim().split(':')[0]?.trim())
      .filter((t): t is string => Boolean(t));
    expect(declared).toEqual(['source', 'requestedMinor']);
    expect(declared.some((d) => RATE_SHAPED.test(d))).toBe(false);
    // No parameter has a DEFAULT, so there is no hidden third input either.
    expect(params).not.toContain('=');

    // (b) the field set of the type that parameter has. A rate smuggled in as a
    // field of the source would defeat (a) entirely, which is the half an arity
    // check cannot see.
    const capType = /export interface ConsumableSourceCap \{([\s\S]*?)\n\}/.exec(src)?.[1];
    expect(capType).toBeDefined();
    const fields = [...(capType as string).matchAll(/^\s*(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[?:]/gm)].map((m) => m[1] as string);
    expect(fields).toEqual(['kind', 'originalMinor', 'remainingMinor']);
    expect(fields.some((f) => RATE_SHAPED.test(f))).toBe(false);

    // (c) and the regex is shown able to MATCH, so (a) and (b) are facts about
    // the declarations and not about a regex that never fires.
    expect(['conversion', 'rateR10', 'sourceToBaseRate', 'txnExponent', 'disbursementCurrency'].every((n) => RATE_SHAPED.test(n))).toBe(true);
  });
});

// ── Race 5: the direct-SQL attack ──────────────────────────────────────

describe('P4-S5 concurrency model — race 5: direct-SQL writers that never take the lock', () => {
  /**
   * P4-AL-22, in its own words: "a `UNIQUE` over a declared remaining level
   * forbids two rows claiming the same level; it does not cap total consumption,
   * because a direct SQL attacker simply declares a different level."
   *
   * The two devices this race separates, each catching what the other cannot:
   *
   * - the LEVEL UNIQUE catches two writers who both tell the TRUTH, because the
   *   truth is one level and the index excludes at the key, atomically, with no
   *   lock taken. The deferred verifier is BLIND to that case, because each
   *   transaction's own view is internally consistent;
   * - the DEFERRED CHAIN VERIFIER catches the writer who LIES about the level to
   *   dodge the index. The index is blind to that case, because the keys differ.
   *
   * An implementation that shipped either alone would pass a suite asserting
   * only the other, which is why both arms are here.
   */
  it('the optimistic row count refuses a decrement computed from a level the row no longer holds', () => {
    const w = creditNote();
    expect(refundTxn(w, 'HONEST', 3_000n)).toEqual({ ok: true });
    expect(w.committedRemaining).toBe(7_000n);
    expect(w.decrement('ATTACKER', 10_000n, 10_000n)).toBe('source_changed');
    expect(w.committedRemaining).toBe(7_000n);
    w.rollback('ATTACKER');
  });

  it('two TRUTHFUL direct writers compute the SAME level, and only the index can refuse one of them', () => {
    const w = creditNote();
    // Neither takes the lock. Both read the committed 10 000 and both, honestly,
    // declare level 10 000.
    expect(w.insertAtLevel('A', { by: 'A', remainingBeforeMinor: 10_000n, consumedMinor: 6_000n, releasedBaseMinor: w.releaseFor(10_000n, 6_000n) })).toBe(
      'ok',
    );
    // B's insert BLOCKS on A's uncommitted index entry — it does not pass and it
    // does not read around it. That is the mutual exclusion the index provides
    // and nothing else on this path does.
    expect(w.insertAtLevel('B', { by: 'B', remainingBeforeMinor: 10_000n, consumedMinor: 6_000n, releasedBaseMinor: w.releaseFor(10_000n, 6_000n) })).toBe(
      'blocked_on_uncommitted_key',
    );

    // And the verifier genuinely CANNOT see it: inside A's own transaction the
    // view is one consistent chain, which is why the index and not the verifier
    // is what saves this case.
    expect(w.decrement('A', 10_000n, 6_000n)).toBe('ok');
    expect(w.verifyAsSeenBy('A')).toBe('ok');
    w.commit('A');
    // After A commits, B's retry at the same level is a 23505 rather than a wait.
    expect(w.insertAtLevel('B', { by: 'B', remainingBeforeMinor: 10_000n, consumedMinor: 6_000n, releasedBaseMinor: w.releaseFor(10_000n, 6_000n) })).toBe(
      'duplicate_key',
    );
    w.rollback('B');
    expect(w.verifyCommitted()).toBe('ok');
  });

  it('B WAITS, A ROLLS BACK, and B then commits AT THE SAME LEVEL — the wait is not a refusal', () => {
    // L2. The test above ends with A committing, so B's level is gone and its
    // retry is a `23505`. That is one half of the behaviour. This is the other,
    // and it is the half that matters for liveness rather than safety: a
    // transaction that WAITED on an uncommitted index entry and then saw the
    // holder roll back must be able to take that level, because the level was
    // never consumed. A model that refused here would describe a system in
    // which one rolled-back refund burns a level forever.
    const w = creditNote();
    const row = (by: string): ConsumerRow => ({ by, remainingBeforeMinor: 10_000n, consumedMinor: 6_000n, releasedBaseMinor: w.releaseFor(10_000n, 6_000n) });

    expect(w.insertAtLevel('A', row('A'))).toBe('ok');
    expect(w.decrement('A', 10_000n, 6_000n)).toBe('ok');
    // B waits. It does not read around A, and it is not refused.
    expect(w.insertAtLevel('B', row('B'))).toBe('blocked_on_uncommitted_key');

    // A is refused by a later guard and rolls back.
    w.rollback('A');
    // Nothing of A's survives: not the row, not the decrement.
    expect(w.committedLevels()).toEqual([]);

    // B retries at the SAME level and lands. This is the positive case the
    // earlier draft only declared.
    expect(w.insertAtLevel('B', row('B'))).toBe('ok');
    expect(w.decrement('B', 10_000n, 6_000n)).toBe('ok');
    w.commit('B');
    expect(w.committedLevels()).toEqual([10_000n]);
    expect(w.committedRowsBy()).toEqual(['B']);
    expect(w.verifyCommitted()).toBe('ok');

    // And the wait was real: had B been allowed through while A was still
    // staged, BOTH rows would have reached the relation at level 10 000 and the
    // source would have given up 12 000 of its 10 000. The model says so.
    const overdrawn = creditNote();
    expect(overdrawn.insertAtLevel('A', { by: 'A', remainingBeforeMinor: 10_000n, consumedMinor: 6_000n, releasedBaseMinor: overdrawn.releaseFor(10_000n, 6_000n) })).toBe('ok');
    overdrawn.forceDecrement('A', 6_000n);
    overdrawn.commit('A');
    expect(overdrawn.insertAtLevel('B', { by: 'B', remainingBeforeMinor: 10_000n, consumedMinor: 6_000n, releasedBaseMinor: overdrawn.releaseFor(10_000n, 6_000n) })).toBe(
      'duplicate_key',
    );
  });

  it('a writer that FABRICATES the level dodges the index, and the deferred verifier refuses it inside its own transaction', () => {
    const w = creditNote();
    expect(refundTxn(w, 'HONEST', 3_000n)).toEqual({ ok: true });

    // A level no consumer could lawfully have seen — 6 999, one minor unit off
    // the real 7 000. DISTINCT from the honest row's level, so the index admits
    // it: P4-AL-22's sentence, literally.
    expect(
      w.insertAtLevel('ATTACKER', {
        by: 'ATTACKER',
        remainingBeforeMinor: 6_999n,
        consumedMinor: 6_999n,
        releasedBaseMinor: w.releaseFor(6_999n, 6_999n),
      }),
    ).toBe('ok');
    expect(w.decrement('ATTACKER', 7_000n, 6_999n)).toBe('ok');
    const levels = [...w.committedLevels(), 6_999n];
    expect(new Set(levels).size).toBe(levels.length); // the UNIQUE is green…
    expect(w.verifyAsSeenBy('ATTACKER')).toBe('inconsistent'); // …and the verifier, inside the attacker's own transaction, is not.

    // So the transaction dies and its rows are DISCARDED. Nothing of it survives.
    w.rollback('ATTACKER');
    expect(w.committedRemaining).toBe(7_000n);
    expect(w.committedRowsBy()).toEqual(['HONEST']);
    expect(w.verifyCommitted()).toBe('ok');
  });

  it('RED PROOF — the level UNIQUE alone, as the whole mechanism, calls the fabricated state lawful', () => {
    const w = creditNote();
    expect(refundTxn(w, 'HONEST', 3_000n)).toEqual({ ok: true });
    const attacker: ConsumerRow = { by: 'ATTACKER', remainingBeforeMinor: 6_999n, consumedMinor: 6_999n, releasedBaseMinor: w.releaseFor(6_999n, 6_999n) };
    expect(w.insertAtLevel('ATTACKER', attacker)).toBe('ok');
    expect(w.decrement('ATTACKER', 7_000n, 6_999n)).toBe('ok');

    // A guard that checked only "no two rows claim the same level" — the
    // supplier shape at `0067:491`, taken as sufficient — is green here.
    const rows = [{ remainingBeforeMinor: 10_000n, consumedMinor: 3_000n }, attacker];
    expect(new Set(rows.map((r) => r.remainingBeforeMinor)).size).toBe(rows.length);

    // And the thing the UNIQUE cannot see: the levels do not CHAIN. The
    // attacker's row declares 6 999 where the chain requires 7 000, so no
    // consumer could lawfully have read it. Note that the SUM reconciles against
    // the staged remaining — which is precisely why a verifier checking only the
    // total would also be green here, and why the accepted chain law checks the
    // LEVELS.
    let running = 0n;
    let chainHolds = true;
    for (const row of [...rows].sort((a, b) => (a.remainingBeforeMinor > b.remainingBeforeMinor ? -1 : 1))) {
      if (row.remainingBeforeMinor !== NOTE_ORIGINAL - running) chainHolds = false;
      running += row.consumedMinor;
    }
    expect(NOTE_ORIGINAL - running).toBe(1n);
    expect(chainHolds).toBe(false);
    expect(w.verifyAsSeenBy('ATTACKER')).toBe('inconsistent');
    w.rollback('ATTACKER');
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

// ── The model's own mechanisms, proved load-bearing by mutation ─────────

describe('the model implements the isolation level it names, and both halves matter', () => {
  const stageApplication = (w: World): void => {
    expect(w.lock('APPLICATION')).not.toBeNull();
    expect(
      w.insertAtLevel('APPLICATION', {
        by: 'APPLICATION',
        remainingBeforeMinor: 10_000n,
        consumedMinor: 7_000n,
        releasedBaseMinor: w.releaseFor(10_000n, 7_000n),
      }),
    ).toBe('ok');
    expect(w.decrement('APPLICATION', 10_000n, 7_000n)).toBe('ok');
    w.rollback('APPLICATION');
  };

  it('MUTATION — a rollback that PUBLISHES instead of discarding makes a refused transaction permanent', () => {
    // The correct world: the application rolls back and the refund takes the
    // whole 10 000 at the original level.
    const correct = customerCredit();
    stageApplication(correct);
    expect(refundTxn(correct, 'REFUND', 10_000n)).toEqual({ ok: true });
    expect(correct.committedRowsBy()).toEqual(['REFUND']);
    expect(correct.verifyCommitted()).toBe('ok');

    // The MUTATED world, identical in every other respect: the refused
    // application's row survives, the refund's 10 000 is refused against a
    // remaining that should never have moved, and the committed chain holds a
    // row no command ever committed.
    const mutated = customerCredit({ discardOnRollback: false });
    stageApplication(mutated);
    expect(refundTxn(mutated, 'REFUND', 10_000n)).toEqual({ ok: false, code: 'customer_refund.amount_exceeds_source' });
    expect(mutated.committedRowsBy()).toEqual(['APPLICATION']);
  });

  it('MUTATION — a world at READ UNCOMMITTED cannot exhibit race 1 at all, so the race would prove nothing', () => {
    const stageSix = (w: World): void => {
      const seen = brokenStaleRead(w, 'T1');
      expect(w.insertAtLevel('T1', { by: 'T1', remainingBeforeMinor: seen, consumedMinor: 6_000n, releasedBaseMinor: w.releaseFor(seen, 6_000n) })).toBe('ok');
      expect(w.decrement('T1', seen, 6_000n)).toBe('ok');
    };

    // At READ COMMITTED a second unlocked reader still sees 10 000 — the stale
    // read that makes the race real.
    const correct = creditNote();
    stageSix(correct);
    expect(brokenStaleRead(correct, 'T2')).toBe(10_000n);

    // At READ UNCOMMITTED T2 sees T1's staged write, its read is never stale, the
    // cap refuses it honestly, and the model silently stops modelling the defect
    // it was written to find. That is §1A.2's finding, as a mutation.
    const mutated = creditNote({ isolation: 'read uncommitted' });
    stageSix(mutated);
    expect(brokenStaleRead(mutated, 'T2')).toBe(4_000n);
    expect(brokenStaleRead(mutated, 'T2')).not.toBe(brokenStaleRead(correct, 'T2'));
  });

  it('the verifier takes a TRANSACTION ID, and the two views genuinely differ', () => {
    const w = creditNote();
    expect(refundTxn(w, 'HONEST', 3_000n)).toEqual({ ok: true });
    // A second transaction stages a row and has not committed. Its own view is
    // consistent, the COMMITTED view is consistent too, and they are DIFFERENT
    // views — which is what makes the transaction id a parameter rather than
    // decoration.
    expect(w.insertAtLevel('T2', { by: 'T2', remainingBeforeMinor: 7_000n, consumedMinor: 7_000n, releasedBaseMinor: w.releaseFor(7_000n, 7_000n) })).toBe(
      'ok',
    );
    expect(w.decrement('T2', 7_000n, 7_000n)).toBe('ok');
    expect(w.verifyAsSeenBy('T2')).toBe('ok');
    expect(w.verifyCommitted()).toBe('ok');
    expect(w.committedRemaining).toBe(7_000n);
    // A THIRD transaction, which can see neither, reads the committed 7 000 and
    // not T2's 0.
    expect(w.dirtyRead('T3')).toBe(7_000n);
    w.rollback('T2');
  });
});
