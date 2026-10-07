/**
 * THE REVERSAL GENERATION LAW, at level C, as a PURE FUNCTION — and the three
 * backfill expressions of `docs/PHASE_4_S6_DDL_SPECIFICATION.md` §2A.1 checked
 * AGAINST it.
 *
 * Why this file exists, stated plainly, because its absence is the finding:
 * round 4 added about 150 lines of §2A prose, disclosed that neither upgrade
 * path could prove the backfill expression, and shipped an expression that was
 * wrong. The generation law is a PURE FUNCTION of a level and a reversal
 * sequence. It needed no server, no cluster and no migration to be checked, and
 * it was not checked. A disclosure that a proof is owed is not a substitute for
 * the cheap proof that was available — so the cheap proof is here, and every
 * expression the specification prints is TRANSLITERATED and compared.
 *
 * What a transliteration is and is not: `sqlRound4` and `sqlRepaired` below are
 * hand transliterations of SQL text into the same set semantics the law uses,
 * and the last block transliterates the credit chain's two candidate forms.
 * They prove that the EXPRESSION'S SHAPE computes
 * what the law requires, which is the thing round 4 got wrong. They do NOT
 * prove PostgreSQL evaluates them that way over real rows — that is owed at
 * level F, with its planted counterpart, and the specification says so.
 */
import { describe, expect, it } from 'vitest';

import { type GenerationRow, type ReversalSequence, asOfNowGeneration, generationFormsAgreeOnActive, writeTimeGeneration } from '../src/customer-reversal';

// ─────────────────────────────────────────────────────────────────────────────
// The histories, with EVERY row's generation written out by hand.
//
// A history is read top to bottom as the order things happened. `reversedAt` is
// the position in `reversals` of the reversal that retired the row, and
// `reversals[i]` is the level the i-th reversal freed. `want` is the value the
// row's `chain_generation` column must hold — computed by hand from the law's
// own words and NOT from any function in this repository, which is the only way
// a table like this is evidence rather than a restatement.
// ─────────────────────────────────────────────────────────────────────────────

interface History {
  readonly name: string;
  readonly rows: readonly (GenerationRow & { readonly want: bigint })[];
  readonly reversals: ReversalSequence;
  /** `true` when a lawful chain: no reversal below an active row. */
  readonly lawful: boolean;
}

const HISTORIES: readonly History[] = [
  {
    name: 'a chain with no reversal at all — the only state any tree in this repository holds today',
    reversals: [],
    lawful: true,
    rows: [
      { rowId: 'PA@0', level: 0n, writtenAfter: 0, reversedAt: null, want: 0n },
      { rowId: 'PA@400', level: 400n, writtenAfter: 0, reversedAt: null, want: 0n },
      { rowId: 'PA@700', level: 700n, writtenAfter: 0, reversedAt: null, want: 0n },
    ],
  },
  {
    name: 'the tail reversed, and NOTHING written after it — the state round 4 measured 0,0,1 for',
    reversals: [700n],
    lawful: true,
    rows: [
      { rowId: 'PA@0', level: 0n, writtenAfter: 0, reversedAt: null, want: 0n },
      { rowId: 'PA@400', level: 400n, writtenAfter: 0, reversedAt: null, want: 0n },
      // Written before any reversal existed. Its own reversal is not a reversal
      // that existed when it was written, which is the whole of F-C1.
      { rowId: 'PA@700', level: 700n, writtenAfter: 0, reversedAt: 0, want: 0n },
    ],
  },
  {
    name: 'the tail reversed and the LAWFUL SUCCESSOR written at the freed level — the row this repair exists to admit',
    reversals: [700n],
    lawful: true,
    rows: [
      { rowId: 'PA@0', level: 0n, writtenAfter: 0, reversedAt: null, want: 0n },
      { rowId: 'PA@400', level: 400n, writtenAfter: 0, reversedAt: null, want: 0n },
      { rowId: 'PA@700', level: 700n, writtenAfter: 0, reversedAt: 0, want: 0n },
      { rowId: 'PA@700#2', level: 700n, writtenAfter: 1, reversedAt: null, want: 1n },
    ],
  },
  {
    name: 'three generations at one level — reversed, reversed, active',
    reversals: [700n, 700n],
    lawful: true,
    rows: [
      { rowId: 'PA@0', level: 0n, writtenAfter: 0, reversedAt: null, want: 0n },
      { rowId: 'PA@700', level: 700n, writtenAfter: 0, reversedAt: 0, want: 0n },
      { rowId: 'PA@700#2', level: 700n, writtenAfter: 1, reversedAt: 1, want: 1n },
      { rowId: 'PA@700#3', level: 700n, writtenAfter: 2, reversedAt: null, want: 2n },
    ],
  },
  {
    name: 'the chain unwound two levels and rebuilt — a reversal BELOW an earlier row, which is lawful only because that row was reversed first',
    reversals: [700n, 400n],
    lawful: true,
    rows: [
      { rowId: 'PA@0', level: 0n, writtenAfter: 0, reversedAt: null, want: 0n },
      // Written first, retired second. The reversal at 700 already existed when
      // IT was written? No — it was written before anything was reversed.
      { rowId: 'PA@400', level: 400n, writtenAfter: 0, reversedAt: 1, want: 0n },
      { rowId: 'PA@700', level: 700n, writtenAfter: 0, reversedAt: 0, want: 0n },
      // Written after BOTH reversals: one at 700 (above it, not counted) and
      // one at 400 (at its level, counted).
      { rowId: 'PA@400#2', level: 400n, writtenAfter: 2, reversedAt: null, want: 1n },
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// The transliterations.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * §2A.1 AS ROUND 4 WROTE IT. No anti-join, no ordering bound:
 *
 *   SELECT count(*) FROM allocation_reversals r JOIN payment_allocations o
 *     ON o.id = r.reducer_id
 *    WHERE r.invoice_id = a.invoice_id
 *      AND o.ar_released_before_txn_minor <= a.ar_released_before_txn_minor
 *
 * It is retained here as the PLANTED COUNTERPART. The cases below require it to
 * be WRONG; if a later edit makes it right, the repair has stopped being a
 * repair and these cases go red.
 */
function sqlRound4(row: GenerationRow, reversals: ReversalSequence): bigint {
  let n = 0n;
  for (const freed of reversals) if (freed <= row.level) n += 1n;
  return n;
}

/** The SQL conjunct the repair adds, and the only one: `r.created_at < a.created_at`. */
function existedWhenWritten(i: number, row: GenerationRow): boolean {
  return i < row.writtenAfter;
}

/**
 * §2A.1 AS REPAIRED. The same count with the law's second clause restored: only
 * reversals that already existed when this row was written, which in SQL is the
 * creation order of the reversal rows and in this model is their position.
 */
function sqlRepaired(row: GenerationRow, reversals: ReversalSequence): bigint {
  let n = 0n;
  for (let i = 0; i < reversals.length; i += 1) {
    if (!existedWhenWritten(i, row)) continue;
    const freed = reversals[i];
    if (freed !== undefined && freed <= row.level) n += 1n;
  }
  return n;
}

describe('the generation law as a pure function — every row of every history, by hand', () => {
  for (const h of HISTORIES) {
    it(`gives each row its hand-computed generation: ${h.name}`, () => {
      for (const r of h.rows) {
        expect(writeTimeGeneration(r, h.reversals), `row ${r.rowId} at level ${r.level}`).toBe(r.want);
      }
    });
  }

  it('is not a table of zeroes — the histories between them require 0, 1 and 2', () => {
    const wanted = new Set(HISTORIES.flatMap((h) => h.rows.map((r) => String(r.want))));
    expect([...wanted].sort(), 'a law whose every expected value is 0 is asserted by a constant').toEqual(['0', '1', '2']);
  });

  it('refuses a row whose named reversal freed a different level, rather than answering', () => {
    expect(() => writeTimeGeneration({ rowId: 'liar', level: 400n, writtenAfter: 0, reversedAt: 0 }, [700n])).toThrow(
      /sits at level 400 but the reversal it names freed level 700/,
    );
  });

  it('refuses a row that names a reversal position the sequence does not have', () => {
    expect(() => writeTimeGeneration({ rowId: 'liar', level: 700n, writtenAfter: 0, reversedAt: 3 }, [700n])).toThrow(/not a position of a sequence of 1/);
  });
});

describe('§2A.1 AS REPAIRED agrees with the law, and §2A.1 AS ROUND 4 WROTE IT does not', () => {
  for (const h of HISTORIES) {
    it(`the repaired expression equals the law for every row: ${h.name}`, () => {
      for (const r of h.rows) {
        expect(sqlRepaired(r, h.reversals), `row ${r.rowId}`).toBe(writeTimeGeneration(r, h.reversals));
      }
    });
  }

  it("round 4's expression is right on a chain with no reversal — which is why every path the migration has today agreed with it", () => {
    const h = HISTORIES[0];
    expect(h, 'the no-reversal history').toBeDefined();
    if (h === undefined) return;
    for (const r of h.rows) expect(sqlRound4(r, h.reversals)).toBe(r.want);
  });

  it('and WRONG on every history that holds a reversal — always on the reversed original, always by exactly its own reversal', () => {
    const withReversals = HISTORIES.filter((h) => h.reversals.length > 0);
    expect(withReversals.length, 'the comparison needs histories that hold reversals').toBeGreaterThan(0);
    let disagreements = 0;
    for (const h of withReversals) {
      for (const r of h.rows) {
        const wrong = sqlRound4(r, h.reversals);
        if (wrong === r.want) continue;
        disagreements += 1;
        // The row it is wrong about is always a REVERSED one — the only row the
        // active-scoped verifier never evaluates, which is why the verifier
        // could not have caught this and did not.
        expect(r.reversedAt, `row ${r.rowId} of "${h.name}"`).not.toBeNull();
        expect(wrong > r.want, `row ${r.rowId}: ${wrong} vs the law's ${r.want}`).toBe(true);
      }
    }
    expect(disagreements, "round 4's expression must be measurably wrong, not merely suspected").toBeGreaterThan(0);
  });
});

describe("round 4's expression manufactures the duplicate key its own migration then refuses", () => {
  const KEYED = HISTORIES[2];

  function keys(h: History, gen: (r: GenerationRow, s: ReversalSequence) => bigint): readonly string[] {
    return h.rows.map((r) => `I1|${r.level}|${gen(r, h.reversals)}`);
  }

  it('step 0c writes two rows at one key, and step 0d cannot create the index over them', () => {
    expect(KEYED, 'the successor history').toBeDefined();
    if (KEYED === undefined) return;
    const bad = keys(KEYED, sqlRound4);
    expect(new Set(bad).size, `the keys round 4's backfill stores are ${bad.join(', ')}`).toBeLessThan(bad.length);
    // Named as PostgreSQL names it, because this is the error the challenger
    // measured: "could not create unique index … Key (…, 700, 1) is duplicated".
    const duplicated = bad.filter((k, i) => bad.indexOf(k) !== i);
    expect(duplicated).toEqual(['I1|700|1']);
  });

  it('and the repaired backfill stores a key per row, so the index can be created', () => {
    expect(KEYED, 'the successor history').toBeDefined();
    if (KEYED === undefined) return;
    const good = keys(KEYED, sqlRepaired);
    expect(new Set(good).size, `the keys the law stores are ${good.join(', ')}`).toBe(good.length);
  });

  it('every history the law describes yields a distinct key per row — the index is creatable over all of them', () => {
    for (const h of HISTORIES) {
      const k = keys(h, writeTimeGeneration);
      expect(new Set(k).size, `${h.name}: ${k.join(', ')}`).toBe(k.length);
    }
  });
});

describe('the two forms of the law, and why the ACTIVE-scoped verifier is sound rather than lucky', () => {
  for (const h of HISTORIES) {
    it(`the write-time form and the as-of-now form agree on every ACTIVE row: ${h.name}`, () => {
      expect(generationFormsAgreeOnActive(h.rows, h.reversals)).toBe(h.lawful);
    });
  }

  it('the as-of-now form is WRONG on a reversed row — so the verifier must stay scoped to active rows, and that scoping is a requirement, not an oversight', () => {
    const h = HISTORIES[1];
    expect(h, 'the reversed-tail history').toBeDefined();
    if (h === undefined) return;
    const reversed = h.rows.filter((r) => r.reversedAt !== null);
    expect(reversed.length).toBeGreaterThan(0);
    for (const r of reversed) {
      expect(asOfNowGeneration(r.level, h.reversals), `row ${r.rowId}`).not.toBe(r.want);
    }
  });

  it('the bridge can be FALSE: a reversal below an ACTIVE row breaks it, which is the shape the LIFO law forbids', () => {
    // PA@700 active while level 400 has been freed. Unreachable through the
    // commands; reachable by a direct-SQL writer, and the predicate must say so
    // rather than answering `true` for every input it is ever handed.
    const unlawful: readonly GenerationRow[] = [
      { rowId: 'PA@400', level: 400n, writtenAfter: 0, reversedAt: 0 },
      { rowId: 'PA@700', level: 700n, writtenAfter: 0, reversedAt: null },
    ];
    expect(generationFormsAgreeOnActive(unlawful, [400n])).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-C6: THREE columns need THREE expressions, and the credit one is keyed on
// the CREDIT. "The mirror of it with `>=`" is a double-spend.
// ─────────────────────────────────────────────────────────────────────────────

describe('the credit chain needs its OWN expression, keyed on the credit — the literal mirror loses mutual exclusion', () => {
  /**
   * `customer_credit_applications` sits on TWO chains at once and therefore
   * carries TWO generation columns under two different unique keys:
   *
   *   customer_credit_applications_invoice_level_generation_uq
   *     (business_id, invoice_id, ar_released_before_txn_minor, chain_generation)
   *   customer_credit_applications_level_generation_uq
   *     (business_id, credit_id, credit_remaining_before_minor, credit_chain_generation)
   *
   * Round 4 wrote one expression and delegated the other two to "the mirror of
   * it … the credit one with `>=`, because that chain descends". The OPERATOR
   * is the easy half and it is right: `>=` on the descending stored column is
   * `<=` on the converted ascending level, so the law is unchanged. The KEY is
   * the half the phrase hid — a generation counted over the row's INVOICE chain
   * is not a function of the CREDIT chain the second key is on, so two truthful
   * writers at one credit remaining level can compute different values, the
   * index excludes neither, and one credit is spent twice at one level.
   *
   * Two applications of one credit, at the SAME remaining level (converted
   * level 300 — the level a reversal there has freed), against two DIFFERENT
   * invoices whose own chains differ:
   */
  const CREDIT_REVERSALS: ReversalSequence = [300n]; // the credit chain: one reversal, at converted level 300

  /** Writer A: invoice I2, at invoice level 0. I2's chain has never been reversed. */
  const invoiceReversalsOfA: ReversalSequence = [];
  const invoiceLevelOfA = 0n;
  /** Writer B: invoice I3, at invoice level 500, succeeding a reversal there. */
  const invoiceReversalsOfB: ReversalSequence = [500n];
  const invoiceLevelOfB = 500n;

  /** The second key: the credit, its remaining level, and `credit_chain_generation`. */
  function creditKey(gen: bigint): string {
    return `C1|300|${gen}`;
  }

  it('the credit-keyed expression makes the two writers compute ONE key, which is what the index excludes on', () => {
    const a = writeTimeGeneration({ rowId: 'CCA-A', level: 300n, writtenAfter: 1, reversedAt: null }, CREDIT_REVERSALS);
    const b = writeTimeGeneration({ rowId: 'CCA-B', level: 300n, writtenAfter: 1, reversedAt: null }, CREDIT_REVERSALS);
    expect(a).toBe(1n);
    expect(b).toBe(1n);
    expect(creditKey(a), 'two truthful writers at one credit level must compute ONE key or the index excludes nothing').toBe(creditKey(b));
  });

  it('the literal mirror — the generation of the row`s INVOICE chain under the CREDIT key — makes them compute DIFFERENT keys, and the credit is double-spent', () => {
    const a = writeTimeGeneration({ rowId: 'CCA-A', level: invoiceLevelOfA, writtenAfter: 0, reversedAt: null }, invoiceReversalsOfA);
    const b = writeTimeGeneration({ rowId: 'CCA-B', level: invoiceLevelOfB, writtenAfter: 1, reversedAt: null }, invoiceReversalsOfB);
    expect([creditKey(a), creditKey(b)]).toEqual(['C1|300|0', 'C1|300|1']);
    expect(creditKey(a), 'the mirror lets one credit be consumed twice at one remaining level').not.toBe(creditKey(b));
    // And it is not that the mirror is merely a different number: it is not a
    // function of the chain its key is on, which is what mutual exclusion needs.
    expect(a).not.toBe(b);
  });

  it('and the mirror also collides a LAWFUL successor with its own reversed original, when the invoice chain holds no reversal', () => {
    // The reversed original at converted credit level 300, write-time 0; and
    // the lawful successor at that freed level whose invoice chain is clean.
    const original: GenerationRow = { rowId: 'CCA-0', level: 300n, writtenAfter: 0, reversedAt: 0 };
    const successor: GenerationRow = { rowId: 'CCA-1', level: 300n, writtenAfter: 1, reversedAt: null };
    expect(creditKey(writeTimeGeneration(original, CREDIT_REVERSALS))).toBe('C1|300|0');
    // The mirror reads I2's chain, which has no reversal, so the successor
    // declares 0 and the key is already taken — the lawful row is refused.
    expect(creditKey(writeTimeGeneration({ rowId: 'CCA-1', level: invoiceLevelOfA, writtenAfter: 0, reversedAt: null }, invoiceReversalsOfA))).toBe('C1|300|0');
    // The credit-keyed form keeps them apart, which is the whole point.
    expect(creditKey(writeTimeGeneration(successor, CREDIT_REVERSALS))).toBe('C1|300|1');
  });

  it('the INVOICE-keyed generation of the same row is a third expression, over the invoice chain and the invoice level', () => {
    // Not a mirror of the credit one either: same law, different chain,
    // different level column, different join relation. Three columns, three
    // expressions, and the specification now writes all three out.
    expect(writeTimeGeneration({ rowId: 'CCA-B', level: invoiceLevelOfB, writtenAfter: 1, reversedAt: null }, invoiceReversalsOfB)).toBe(1n);
    expect(writeTimeGeneration({ rowId: 'CCA-A', level: invoiceLevelOfA, writtenAfter: 0, reversedAt: null }, invoiceReversalsOfA)).toBe(0n);
  });
});
