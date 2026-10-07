/**
 * P4-S6 CHALLENGE (signature 2) — the demonstrations behind the findings.
 *
 * This file is the INDEPENDENT CHALLENGER's, on branch `p4s6c/challenge-1`. It
 * edits nothing of the author's and asserts nothing about style: every case
 * below either exhibits a state the author's design admits and should not, or
 * exhibits the fact that one of the author's own models reaches its verdict
 * from a mechanism the model does not implement.
 *
 * It uses the author's own production module as its subject. Where it needs a
 * scheduler it builds its own, because the author's is file-local — and the
 * difference between the two schedulers IS finding F1.
 */
import { describe, expect, it } from 'vitest';
import { invoiceChain, orderedActive, planAllocationReversal, type ActiveReducer } from '../src/customer-reversal';

const INV = 'invoice-1';
const TOTAL = 1000n;

function alloc(reducerId: string, level: bigint, amount: bigint): ActiveReducer {
  return { reducerId, kind: 'payment_allocation', level, amount, originalEntryId: `entry-${reducerId}` };
}

/** The author's standard world: 0 → 400 → 700, closing 1000, with the tail reversed. */
const SEED: readonly ActiveReducer[] = [alloc('alloc-1', 0n, 400n), alloc('alloc-2', 400n, 300n), alloc('alloc-3', 700n, 300n)];

// ══════════════════════════════════════════════════════════════════════════
// F1. The concurrency model claims READ COMMITTED and implements neither
//     isolation nor rollback. Both are load-bearing for its C-7 verdict.
// ══════════════════════════════════════════════════════════════════════════

/**
 * The same world, with the two mechanisms PostgreSQL actually provides and the
 * author's `World` does not:
 *
 * - a transaction's own writes live in its own buffer until it commits, and a
 *   read sees committed state plus its own buffer (READ COMMITTED);
 * - a refused transaction's writes are DISCARDED (rollback).
 *
 * A DEFERRED constraint trigger fires at COMMIT, inside the committing
 * transaction, so it sees exactly what that transaction can see.
 */
class IsolatedWorld {
  private committed: ActiveReducer[] = [];
  private readonly buffers = new Map<string, ActiveReducer[]>();
  public readonly reversed = new Set<string>();

  constructor(seed: readonly ActiveReducer[]) {
    this.committed = [...seed];
  }

  public insert(txn: string, row: ActiveReducer): void {
    const b = this.buffers.get(txn) ?? [];
    b.push(row);
    this.buffers.set(txn, b);
  }

  /** What `txn` can see: committed rows plus its OWN uncommitted ones. */
  public visibleTo(txn: string): readonly ActiveReducer[] {
    return [...this.committed, ...(this.buffers.get(txn) ?? [])].filter((r) => !this.reversed.has(r.reducerId));
  }

  /** The deferred verifier, run inside `txn` at its COMMIT, over what `txn` sees. */
  public verifyAtCommit(txn: string): void {
    const chain = invoiceChain(INV, TOTAL, this.visibleTo(txn));
    let before = 0n;
    for (const r of orderedActive(chain)) {
      if (r.level !== before) throw new Error('invoice_settlement.settlement_inconsistent');
      before += r.amount;
    }
    if (before > chain.capacity) throw new Error('invoice_settlement.settlement_inconsistent');
  }

  public commit(txn: string): void {
    this.committed = [...this.committed, ...(this.buffers.get(txn) ?? [])];
    this.buffers.delete(txn);
  }

  /** A refused transaction's writes are discarded. The author's model keeps them. */
  public rollback(txn: string): void {
    this.buffers.delete(txn);
  }

  public committedRows(): readonly ActiveReducer[] {
    return this.committed;
  }
}

describe('F1 — the direct-SQL race at a freed level, under the isolation the model claims', () => {
  it('CRITICAL: two unlocked direct inserts at the freed level BOTH commit, and the committed active chain is broken with nothing left to refuse it', () => {
    const w = new IsolatedWorld(SEED);
    w.reversed.add('alloc-3'); // the tail is reversed; level 700 is free on the ACTIVE chain

    // Neither party takes a lock — the author's C-7 premise, and the premise
    // that makes a lock-based protection unavailable by construction.
    w.insert('D1', alloc('bad-1', 700n, 50n));
    w.insert('D2', alloc('bad-2', 700n, 50n));

    // Each one's DEFERRED verifier runs inside its own transaction, so it sees
    // committed state plus its own row — and NOT the other's uncommitted row.
    expect(() => w.verifyAtCommit('D1')).not.toThrow();
    expect(() => w.verifyAtCommit('D2')).not.toThrow();
    w.commit('D1');
    w.commit('D2');

    // Both landed. Two ACTIVE rows at level 700, which is exactly the state
    // `payment_allocations_level_uq` refused atomically and with no lock.
    const active = w.committedRows().filter((r) => !w.reversed.has(r.reducerId));
    expect(active.filter((r) => r.level === 700n).map((r) => r.reducerId)).toEqual(['bad-1', 'bad-2']);

    // And nothing will ever notice: no later transaction is obliged to run the
    // verifier on this chain, and the invoice is now over-consumed.
    expect(active.reduce((a, r) => a + r.amount, 0n)).toBe(800n);
    const chain = invoiceChain(INV, TOTAL, active);
    // The chain the author's own predicate calls broken is now the COMMITTED one.
    expect(orderedActive(chain).map((r) => [r.reducerId, r.level])).toEqual([
      ['alloc-1', 0n],
      ['alloc-2', 400n],
      ['bad-1', 700n],
      ['bad-2', 700n],
    ]);
  });

  it('and the author’s verdict needs BOTH defects: with visibility alone the loser is refused, and only the missing rollback makes its row survive', () => {
    // Visibility as the author's World has it (immediate), rollback as the
    // author's World has it (none): D1 is refused and its row STAYS, so D2 is
    // refused by a row that does not exist. The outcome the model reports is
    // produced by the two defects together.
    const rows: ActiveReducer[] = [...SEED];
    const reversed = new Set(['alloc-3']);
    const verify = (): void => {
      const chain = invoiceChain(
        INV,
        TOTAL,
        rows.filter((r) => !reversed.has(r.reducerId)),
      );
      let before = 0n;
      for (const r of orderedActive(chain)) {
        if (r.level !== before) throw new Error('invoice_settlement.settlement_inconsistent');
        before += r.amount;
      }
    };
    rows.push(alloc('bad-1', 700n, 50n));
    rows.push(alloc('bad-2', 700n, 50n));
    expect(() => verify()).toThrow(/settlement_inconsistent/); // D1
    expect(() => verify()).toThrow(/settlement_inconsistent/); // D2, on D1's dead row
    // Both refused — which is NOT "the deferred verifier refuses the second",
    // and the model's assertion (`codes.length >= 1`) cannot tell the two apart.
    expect(rows.filter((r) => r.level === 700n && r.reducerId.startsWith('bad')).length).toBe(2);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// F5. `allocation_reversal.already_reversed` is unreachable for the condition
//     it names; an exact replay is answered `not_last_reducer` with advice
//     the client cannot act on.
// ══════════════════════════════════════════════════════════════════════════

describe('F5 — the single-reducer reversal replay is reported as a LIFO refusal', () => {
  const input = {
    reversalId: 'rev-1',
    reducerId: 'alloc-3',
    kind: 'payment_allocation' as const,
    originalEntryId: 'entry-alloc-3',
    sourceType: 'customer_payment_allocation' as const,
    reversalDate: '2026-03-02',
    originalDate: '2026-03-01',
    reason: 'duplicate receipt',
  };

  it('MEDIUM: replaying the reversal of an already-reversed reducer answers not_last_reducer, never already_reversed', () => {
    // The world after the lawful reversal of the tail: alloc-3 is gone from the
    // ACTIVE set, and alloc-2 is the new tail.
    const afterwards = invoiceChain(INV, TOTAL, [SEED[0] as ActiveReducer, SEED[1] as ActiveReducer]);
    let code = 'accepted';
    try {
      planAllocationReversal({ ...input, chains: [afterwards] });
    } catch (e) {
      code = (e as { code?: string }).code ?? 'unknown';
    }
    expect(code).toBe('allocation_reversal.not_last_reducer');
    expect(code).not.toBe('allocation_reversal.already_reversed');
  });

  it('and the advice that refusal carries is impossible to act on: the only "later" reducer is the one already reversed', () => {
    const afterwards = invoiceChain(INV, TOTAL, [SEED[0] as ActiveReducer, SEED[1] as ActiveReducer]);
    // `reverseInThisOrder` is newest-first over the ACTIVE set, so it names
    // alloc-2 — reversing which does NOT make alloc-3 reversible, because
    // alloc-3 is not active at all. The refusal sends the client in a circle.
    expect([...orderedActive(afterwards)].reverse().map((r) => r.reducerId)).toEqual(['alloc-2', 'alloc-1']);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// F8. The not-before-original check is a lexicographic string comparison with
//     no format assertion, so a non-canonical civil date defeats it.
// ══════════════════════════════════════════════════════════════════════════

describe('F8 — the date comparison is lexicographic over unvalidated strings', () => {
  it('LOW: a non-canonical reversalDate earlier than the original passes the date_before_original check', () => {
    const chain = invoiceChain(INV, TOTAL, SEED);
    // '2026-3-02' IS 2 March 2026 and precedes 5 March, but '3' > '0', so the
    // string comparison says it does not.
    const plan = planAllocationReversal({
      reversalId: 'rev-1',
      reducerId: 'alloc-3',
      kind: 'payment_allocation',
      originalEntryId: 'entry-alloc-3',
      sourceType: 'customer_payment_allocation',
      chains: [chain],
      reversalDate: '2026-3-02',
      originalDate: '2026-03-05',
      reason: 'non-canonical date',
    });
    // Accepted, and the malformed date is carried into the plan — and from
    // there into the row and the intent hash.
    expect(plan.reversalDate).toBe('2026-3-02');
  });
});
