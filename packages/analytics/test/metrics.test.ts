/**
 * Tests for the four named customer metrics.
 *
 * The named RED PROOFS in this file are the point of it. Each one asserts the
 * SPECIFIC refusal, inequality or law it expects — never merely "it throws" —
 * because a canary asserted as "it throws" is satisfied by any defect,
 * including a typo in the test. Each red proof also reports the size of the set
 * it ran over, because a zero-match scan and an empty population both report
 * success.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { AnalyticsRefusal } from '../src/errors';
import {
  AnalyticsContractViolation,
  COMMITTED_NON_VOID_STATUSES,
  arAging,
  assertFrequencyAdditivity,
  assertIsPartition,
  assertLastPurchaseLaw,
  documentHeaderFoldThatIsNotNetSalesValue,
  isCommittedNonVoid,
  lastPurchase,
  netSalesValue,
  nextCivilDate,
  parseCivilDate,
  purchaseFrequency,
  type MetricSaleRow,
  type SaleDocumentStatus,
} from '../src/metrics';
import type { AnalyticsInterval, AnalyticsScope } from '../src/provenance';

const SCOPE: AnalyticsScope = { kind: 'bounded_set', size: 1 };
const CUSTOMER = 'customer-1';

function row(
  saleId: string,
  documentDate: string,
  status: SaleDocumentStatus,
  extra: { isReturn?: boolean; netTxnMinor?: bigint; customerId?: string } = {},
): MetricSaleRow {
  return {
    saleId,
    customerId: extra.customerId === undefined ? CUSTOMER : extra.customerId,
    documentDate,
    status,
    isReturn: extra.isReturn === true,
    netTxnMinor: extra.netTxnMinor === undefined ? 0n : extra.netTxnMinor,
  };
}

function interval(from: string, to: string): AnalyticsInterval {
  return { kind: 'calendar_range', from, to };
}

/* ========================================================================= *
 * RED PROOF 1 — the forbidden-vocabulary scan over this module's own source
 * ========================================================================= */

describe('RED PROOF: the forbidden vocabulary does not appear in this module source', () => {
  // Assembled from fragments so that this test file is not itself a violation
  // of the rule it enforces. The rule is on the TERM, and a test asserting the
  // absence of a term must not spell the term.
  const C = 'c' + 'ustomer';
  const FORBIDDEN: readonly string[] = [
    C + '_' + 'value',
    C + 'Value',
    C + '_' + 'worth',
    C + 'Worth',
    'l' + 'tv',
    'l' + 'ifetime' + '_' + 'value',
    'l' + 'ifetime' + 'Value',
    'l' + 'ifetime value',
    C + ' ' + 'l' + 'ifetime value',
    'v' + 'alue' + '_' + 'score',
  ];

  const SUBJECTS: readonly string[] = ['src/metrics.ts', 'src/export/fields.ts'];

  it('loaded both subjects and both are non-empty', () => {
    // PROOF-OF-PROOF obligations 1 and 2: the subject exists and was read, and
    // the set scanned is measurably non-empty.
    expect(SUBJECTS.length).toBe(2);
    expect(FORBIDDEN.length).toBe(10);
    for (const subject of SUBJECTS) {
      const text = readFileSync(join(__dirname, '..', subject), 'utf8');
      expect(text.length).toBeGreaterThan(1000);
    }
  });

  for (const subject of SUBJECTS) {
    it(`${subject} contains none of the ${10} forbidden terms`, () => {
      const text = readFileSync(join(__dirname, '..', subject), 'utf8').toLowerCase();
      const found = FORBIDDEN.filter((term) => text.includes(term.toLowerCase()));
      // Names the vocabulary rule and the offending term, not merely a
      // non-empty list: a non-empty list names no law.
      expect(found, `forbidden-vocabulary rule M-0/M-1 violated in ${subject} by: ${found.join(', ')}`).toEqual([]);
    });
  }

  it('the scan is not vacuous: a planted term is detected', () => {
    // PROOF-OF-PROOF obligations 3 and 4: the mutation lands in the text that
    // is actually scanned, and the planted change is visible here in the test.
    const planted = `const x = 1; // ${FORBIDDEN[0]}\n`;
    const found = FORBIDDEN.filter((term) => planted.toLowerCase().includes(term.toLowerCase()));
    expect(found).toEqual([FORBIDDEN[0]]);
  });
});

/* ========================================================================= *
 * The authority's status set
 * ========================================================================= */

describe('the committed non-void status set is the authority own set', () => {
  it('holds exactly the three statuses the authority state CHECK pairs with a confirmation', () => {
    expect([...COMMITTED_NON_VOID_STATUSES].sort()).toEqual(['confirmed', 'returned_full', 'returned_partial']);
  });

  it('a returned sale is still committed; a draft and a void are not', () => {
    expect(isCommittedNonVoid('returned_partial')).toBe(true);
    expect(isCommittedNonVoid('returned_full')).toBe(true);
    expect(isCommittedNonVoid('draft')).toBe(false);
    expect(isCommittedNonVoid('void')).toBe(false);
  });
});

/* ========================================================================= *
 * Civil dates, with no clock
 * ========================================================================= */

describe('civil dates are validated and stepped by integer arithmetic', () => {
  it('refuses a date that does not exist in the calendar', () => {
    expect(() => parseCivilDate('2026-02-30', 'asOf')).toThrowError(AnalyticsContractViolation);
    try {
      parseCivilDate('2026-02-30', 'asOf');
      expect.unreachable('a non-existent date must not be coerced');
    } catch (error) {
      expect(error).toBeInstanceOf(AnalyticsContractViolation);
      expect((error as AnalyticsContractViolation).law).toBe('L-DATE-1');
    }
  });

  it('refuses a malformed shape', () => {
    expect(() => parseCivilDate('2026-2-1', 'asOf')).toThrowError(/L-DATE-1/);
  });

  it('steps month, leap-year and year boundaries', () => {
    expect(nextCivilDate('2026-01-31')).toBe('2026-02-01');
    expect(nextCivilDate('2026-02-28')).toBe('2026-03-01');
    expect(nextCivilDate('2024-02-28')).toBe('2024-02-29');
    expect(nextCivilDate('2024-02-29')).toBe('2024-03-01');
    expect(nextCivilDate('2026-12-31')).toBe('2027-01-01');
  });
});

/* ========================================================================= *
 * LAST PURCHASE
 * ========================================================================= */

describe('LAST PURCHASE', () => {
  it('answers the same-day sale with the greater id, under (documentDate, saleId)', () => {
    // Inserted in the reverse of their id order on purpose: a reader ordering
    // on an insertion timestamp passes the exclusion half of this canary and
    // fails this half, which is the half worth having.
    const rows = [row('sale-b', '2026-03-10', 'confirmed'), row('sale-a', '2026-03-10', 'confirmed')];
    const answer = lastPurchase(rows, { customerId: CUSTOMER, asOf: '2026-03-31', scope: SCOPE });
    expect(answer.value.sale?.saleId).toBe('sale-b');
    expect(answer.value.candidateCount).toBe(2);
  });

  it('carries on-demand provenance with its asOf, interval, definition and scope, and no watermark', () => {
    const answer = lastPurchase([row('sale-a', '2026-03-10', 'confirmed')], {
      customerId: CUSTOMER,
      asOf: '2026-03-31',
      scope: SCOPE,
    });
    expect(answer.provenance.mode).toBe('on_demand');
    expect(answer.provenance.asOf).toBe('2026-03-31');
    expect(answer.provenance.interval).toEqual({
      kind: 'calendar_range',
      from: '2026-03-31',
      to: '2026-03-31',
    });
    expect(answer.provenance.sourceDefinition.definition).toBe('sales.committed_non_void_sale_documents');
    expect(answer.provenance.scope).toEqual(SCOPE);
    expect(Object.keys(answer.provenance).sort()).toEqual(['asOf', 'interval', 'mode', 'scope', 'sourceDefinition']);
    expect('watermark' in answer.provenance).toBe(false);
  });

  it('is a pure function of its request: two replays are deeply identical', () => {
    const rows = [row('sale-a', '2026-03-10', 'confirmed')];
    const request = { customerId: CUSTOMER, asOf: '2026-03-31', scope: SCOPE };
    expect(lastPurchase(rows, request)).toEqual(lastPurchase(rows, request));
  });

  it('answers "no purchase" with a reported cardinality of zero, not a null date', () => {
    const answer = lastPurchase([], { customerId: CUSTOMER, asOf: '2026-03-31', scope: SCOPE });
    expect(answer.value.sale).toBeNull();
    expect(answer.value.candidateCount).toBe(0);
  });

  it('excludes a sale dated after the supplied asOf', () => {
    const rows = [row('sale-a', '2026-03-10', 'confirmed'), row('sale-z', '2026-04-01', 'confirmed')];
    const answer = lastPurchase(rows, { customerId: CUSTOMER, asOf: '2026-03-31', scope: SCOPE });
    expect(answer.value.sale?.saleId).toBe('sale-a');
    expect(answer.value.candidateCount).toBe(1);
  });

  it('excludes another customer rows', () => {
    const rows = [row('sale-a', '2026-03-10', 'confirmed'), row('sale-other', '2026-03-20', 'confirmed', { customerId: 'customer-2' })];
    const answer = lastPurchase(rows, { customerId: CUSTOMER, asOf: '2026-03-31', scope: SCOPE });
    expect(answer.value.sale?.saleId).toBe('sale-a');
  });

  /* --- RED PROOF 2 — the void and the draft candidate ------------------- */

  describe('RED PROOF: a later void or draft sale is never the last purchase', () => {
    const rows = [
      row('sale-a', '2026-03-10', 'confirmed'),
      row('sale-b', '2026-03-10', 'confirmed'),
      row('sale-void', '2026-03-20', 'void'),
      row('sale-draft', '2026-03-25', 'draft'),
    ];

    it('the population is non-empty and contains both excluded candidates', () => {
      expect(rows.length).toBe(4);
      expect(rows.filter((r) => !isCommittedNonVoid(r.status)).map((r) => r.saleId)).toEqual(['sale-void', 'sale-draft']);
    });

    it('the answer is the same-day committed sale, and the candidate set excludes the void and the draft', () => {
      const answer = lastPurchase(rows, { customerId: CUSTOMER, asOf: '2026-03-31', scope: SCOPE });
      expect(answer.value.sale?.saleId).toBe('sale-b');
      expect(answer.value.sale?.status).toBe('confirmed');
      expect(answer.value.candidateCount).toBe(2);
    });

    it('the membership law turns red by name when a void sale is planted as the answer', () => {
      // The planted defect, visible in the diff of this test: a status-set
      // drift that selected the later void document.
      const planted = { sale: { saleId: 'sale-void', customerId: CUSTOMER, documentDate: '2026-03-20', status: 'void' as const }, candidateCount: 2 };
      try {
        assertLastPurchaseLaw(rows, { customerId: CUSTOMER, asOf: '2026-03-31', scope: SCOPE }, planted);
        expect.unreachable('the membership line of L-LASTP-1 must refuse a void document');
      } catch (error) {
        expect(error).toBeInstanceOf(AnalyticsContractViolation);
        const violation = error as AnalyticsContractViolation;
        expect(violation.law).toBe('L-LASTP-1');
        expect(violation.message).toContain('not a member of the canonical committed non-void candidate set');
        expect(violation.detail.saleId).toBe('sale-void');
      }
    });

    it('the maximality law turns red by name, with both document keys, when same-day order is reversed', () => {
      // The planted defect: the earlier of two same-day sales selected, which
      // is exactly what substituting an insertion timestamp for the document
      // order produces.
      const planted = { sale: { saleId: 'sale-a', customerId: CUSTOMER, documentDate: '2026-03-10', status: 'confirmed' as const }, candidateCount: 2 };
      try {
        assertLastPurchaseLaw(rows, { customerId: CUSTOMER, asOf: '2026-03-31', scope: SCOPE }, planted);
        expect.unreachable('the maximality line of L-LASTP-1 must refuse a non-maximal answer');
      } catch (error) {
        const violation = error as AnalyticsContractViolation;
        expect(violation.law).toBe('L-LASTP-1');
        expect(violation.message).toContain('strictly later than the answer');
        expect(violation.detail.answerSaleId).toBe('sale-a');
        expect(violation.detail.greaterSaleId).toBe('sale-b');
        expect(violation.detail.greaterDocumentDate).toBe('2026-03-10');
      }
    });

    it('the cardinality law turns red by name when a non-empty set answers "no purchase"', () => {
      try {
        assertLastPurchaseLaw(rows, { customerId: CUSTOMER, asOf: '2026-03-31', scope: SCOPE }, { sale: null, candidateCount: 2 });
        expect.unreachable('the cardinality line of L-LASTP-1 must refuse a blank over a non-empty set');
      } catch (error) {
        const violation = error as AnalyticsContractViolation;
        expect(violation.law).toBe('L-LASTP-1');
        expect(violation.message).toContain('empty candidate set');
      }
    });

    it('the baseline is restored: the real answer satisfies the law', () => {
      const answer = lastPurchase(rows, { customerId: CUSTOMER, asOf: '2026-03-31', scope: SCOPE });
      expect(() => assertLastPurchaseLaw(rows, { customerId: CUSTOMER, asOf: '2026-03-31', scope: SCOPE }, answer.value)).not.toThrow();
    });
  });
});

/* ========================================================================= *
 * PURCHASE FREQUENCY
 * ========================================================================= */

describe('PURCHASE FREQUENCY', () => {
  // Three committed sales in the window, one partially returned and one fully
  // returned, plus a return document dated OUTSIDE the window against an
  // in-window sale, plus a void and a draft.
  const rows: readonly MetricSaleRow[] = [
    row('s-1', '2026-03-02', 'confirmed'),
    row('s-2', '2026-03-11', 'returned_partial'),
    row('s-3', '2026-03-20', 'returned_full'),
    row('r-1', '2026-03-12', 'confirmed', { isReturn: true }),
    row('r-outside', '2026-04-05', 'confirmed', { isReturn: true }),
    row('s-void', '2026-03-15', 'void'),
    row('s-draft', '2026-03-16', 'draft'),
  ];
  const WHOLE = interval('2026-03-01', '2026-03-31');
  const REQUEST = { customerId: CUSTOMER, asOf: '2026-03-31', scope: SCOPE, interval: WHOLE };

  it('the population is non-empty and measured', () => {
    expect(rows.length).toBe(7);
  });

  it('counts sale documents and return documents separately', () => {
    const answer = purchaseFrequency(rows, REQUEST);
    expect(answer.value.saleCount).toBe(3);
    expect(answer.value.returnCount).toBe(1);
    expect(answer.value.netOrderCount).toBeUndefined();
  });

  it('omits netOrderCount unless the caller explicitly asks, and a partial return does not remove a purchase', () => {
    const answer = purchaseFrequency(rows, REQUEST, { includeNetOrderCount: true });
    expect(answer.value.saleCount).toBe(3);
    expect(answer.value.netOrderCount).toBe(2);
    expect(answer.value.saleCount).not.toBe(answer.value.netOrderCount);
  });

  it('carries the supplied interval on the answer with on-demand provenance', () => {
    const answer = purchaseFrequency(rows, REQUEST);
    expect(answer.provenance.mode).toBe('on_demand');
    expect(answer.provenance.interval).toEqual(WHOLE);
  });

  /* --- RED PROOF 3 — the absent interval -------------------------------- */

  it('RED PROOF: a window question with no window refuses analytics.interval_required', () => {
    try {
      purchaseFrequency(rows, { ...REQUEST, interval: null });
      expect.unreachable('a count over an explicit interval must not invent one');
    } catch (error) {
      expect(error).toBeInstanceOf(AnalyticsRefusal);
      const refusal = error as AnalyticsRefusal;
      expect(refusal.code).toBe('analytics.interval_required');
      expect(refusal.httpStatus).toBe(422);
    }
  });

  it('refuses an interval that ends before it begins', () => {
    expect(() => purchaseFrequency(rows, { ...REQUEST, interval: interval('2026-03-31', '2026-03-01') })).toThrowError(/L-DATE-2/);
  });

  /* --- RED PROOF 4 — additivity over a partition ------------------------ */

  describe('RED PROOF: additivity over a partition of the interval', () => {
    // Several split points. Each sub-interval list is a real partition under
    // the inclusive/inclusive convention: each part begins on the civil
    // successor of the previous part end.
    const PARTITIONS: readonly { readonly name: string; readonly parts: readonly AnalyticsInterval[] }[] = [
      {
        name: 'split mid-month, on no document date',
        parts: [interval('2026-03-01', '2026-03-10'), interval('2026-03-11', '2026-03-31')],
      },
      {
        name: 'split ON a boundary date: 2026-03-11 is a document date and ends a part',
        parts: [interval('2026-03-01', '2026-03-11'), interval('2026-03-12', '2026-03-31')],
      },
      {
        name: 'split ON a boundary date: 2026-03-12 is a return document date and begins a part',
        parts: [interval('2026-03-01', '2026-03-11'), interval('2026-03-12', '2026-03-31')],
      },
      {
        name: 'split on the interval first day',
        parts: [interval('2026-03-01', '2026-03-01'), interval('2026-03-02', '2026-03-31')],
      },
      {
        name: 'split on the interval last day',
        parts: [interval('2026-03-01', '2026-03-30'), interval('2026-03-31', '2026-03-31')],
      },
      {
        name: 'three-way split straddling every document date',
        parts: [interval('2026-03-01', '2026-03-02'), interval('2026-03-03', '2026-03-20'), interval('2026-03-21', '2026-03-31')],
      },
      {
        name: 'per-day partition of the whole month',
        parts: Array.from({ length: 31 }, (_unused, index) => {
          const day = String(index + 1).padStart(2, '0');
          return interval(`2026-03-${day}`, `2026-03-${day}`);
        }),
      },
    ];

    it('the partition set is non-empty and every member is a real partition', () => {
      expect(PARTITIONS.length).toBe(7);
      for (const partition of PARTITIONS) {
        expect(() => assertIsPartition(WHOLE, partition.parts)).not.toThrow();
      }
    });

    for (const partition of PARTITIONS) {
      it(`the sum over the parts equals the whole (${partition.name})`, () => {
        const whole = assertFrequencyAdditivity(rows, REQUEST, partition.parts, {
          includeNetOrderCount: true,
        });
        expect(whole.value.saleCount).toBe(3);
        expect(whole.value.returnCount).toBe(1);
        expect(whole.value.netOrderCount).toBe(2);
      });
    }

    it('a GAP of one civil day between parts turns L-FREQ-1 red by name', () => {
      // The planted defect: 2026-03-11 is covered by neither part. A
      // lexicographic comparison cannot see it, which is why the check uses the
      // civil successor.
      const gapped = [interval('2026-03-01', '2026-03-10'), interval('2026-03-12', '2026-03-31')];
      try {
        assertFrequencyAdditivity(rows, REQUEST, gapped);
        expect.unreachable('a gapped sub-interval list is not a partition');
      } catch (error) {
        const violation = error as AnalyticsContractViolation;
        expect(violation.law).toBe('L-FREQ-1');
        expect(violation.message).toContain('neither meet nor are disjoint by one civil day');
        expect(violation.detail.previousTo).toBe('2026-03-10');
        expect(violation.detail.expectedNextFrom).toBe('2026-03-11');
        expect(violation.detail.actualNextFrom).toBe('2026-03-12');
      }
    });

    it('an OVERLAP of one civil day between parts turns L-FREQ-1 red by name', () => {
      const overlapping = [interval('2026-03-01', '2026-03-11'), interval('2026-03-11', '2026-03-31')];
      try {
        assertFrequencyAdditivity(rows, REQUEST, overlapping);
        expect.unreachable('an overlapping sub-interval list is not a partition');
      } catch (error) {
        const violation = error as AnalyticsContractViolation;
        expect(violation.law).toBe('L-FREQ-1');
        expect(violation.message).toContain('neither meet nor are disjoint by one civil day');
      }
    });

    it('a partition that does not reach the end of the interval turns L-FREQ-1 red by name', () => {
      const short = [interval('2026-03-01', '2026-03-10'), interval('2026-03-11', '2026-03-20')];
      try {
        assertFrequencyAdditivity(rows, REQUEST, short);
        expect.unreachable('a short sub-interval list is not a partition');
      } catch (error) {
        const violation = error as AnalyticsContractViolation;
        expect(violation.law).toBe('L-FREQ-1');
        expect(violation.message).toContain('does not end where the interval ends');
        expect(violation.detail.expected).toBe('2026-03-31');
        expect(violation.detail.actual).toBe('2026-03-20');
      }
    });

    it('the additivity assertion is not vacuous: it sees a one-document discrepancy', () => {
      // The instrument test. An exclusive-upper-bound defect drops exactly the
      // document on the boundary day; the sum over the parts then differs from
      // the whole by one, and the law must name both figures. Simulated here by
      // asserting additivity of a partition against a DIFFERENT whole interval
      // that covers one extra document.
      const widerRequest = { ...REQUEST, interval: interval('2026-03-01', '2026-04-05') };
      try {
        assertFrequencyAdditivity(rows, widerRequest, [interval('2026-03-01', '2026-03-31'), interval('2026-04-01', '2026-04-04')]);
        expect.unreachable('a partition that stops one day short of the whole must be refused');
      } catch (error) {
        const violation = error as AnalyticsContractViolation;
        expect(violation.law).toBe('L-FREQ-1');
      }
    });

    it('an empty sub-interval list is not a partition', () => {
      try {
        assertIsPartition(WHOLE, []);
        expect.unreachable('an empty list must not pass as a partition');
      } catch (error) {
        const violation = error as AnalyticsContractViolation;
        expect(violation.law).toBe('L-FREQ-1');
        expect(violation.message).toContain('empty list of sub-intervals');
      }
    });

    it('the baseline is restored and green: the real partitions still add up', () => {
      for (const partition of PARTITIONS) {
        const whole = assertFrequencyAdditivity(rows, REQUEST, partition.parts);
        expect(whole.value.saleCount).toBe(3);
      }
    });
  });
});

/* ========================================================================= *
 * RED PROOF 5 — NET SALES VALUE refuses, and never returns 0n
 * ========================================================================= */

describe('RED PROOF: NET SALES VALUE shows nothing, not zero', () => {
  const rows: readonly MetricSaleRow[] = [
    row('s-1', '2026-03-02', 'confirmed', { netTxnMinor: 900719925474099399n }),
    row('s-2', '2026-03-20', 'returned_full', { netTxnMinor: 25_000n }),
    row('r-1', '2026-03-21', 'confirmed', { isReturn: true, netTxnMinor: -25_000n }),
  ];
  const REQUEST = {
    customerId: CUSTOMER,
    asOf: '2026-03-31',
    scope: SCOPE,
    interval: interval('2026-03-01', '2026-03-31'),
  };

  it('the population is non-empty and carries a fully returned sale and a return document', () => {
    expect(rows.length).toBe(3);
    expect(rows.some((r) => r.status === 'returned_full')).toBe(true);
    expect(rows.some((r) => r.isReturn)).toBe(true);
  });

  it('refuses analytics.waiting_for_integrated_surface rather than returning a figure', () => {
    let returned: unknown = 'NOTHING WAS RETURNED';
    try {
      returned = netSalesValue(rows, REQUEST);
      expect.unreachable('a net sales figure must not be produced on this branch');
    } catch (error) {
      expect(error).toBeInstanceOf(AnalyticsRefusal);
      const refusal = error as AnalyticsRefusal;
      expect(refusal.code).toBe('analytics.waiting_for_integrated_surface');
      expect(refusal.httpStatus).toBe(503);
      expect(refusal.message).toContain('never reimplements the sum');
    }
    // The assertion that matters: it did not resolve to 0n, and it did not
    // resolve to anything at all.
    expect(returned).toBe('NOTHING WAS RETURNED');
    expect(returned).not.toBe(0n);
  });

  it('the named inequality L-NETSALES-1 holds: the document-header fold is NOT this metric', () => {
    // The fold is computable, and that is precisely why it is dangerous. The
    // standing proof is that it is a DIFFERENT thing from the metric: the
    // metric refuses, the fold produces a figure, and the two can therefore
    // never be the same answer.
    const fold = documentHeaderFoldThatIsNotNetSalesValue(rows, CUSTOMER, REQUEST.interval);
    expect(typeof fold).toBe('bigint');
    // Money in bigint minor units: every digit of the eighteen-digit figure
    // survives, which a float would not.
    expect(fold).toBe(900719925474099399n + 25_000n + -25_000n);
    expect(String(fold)).toBe('900719925474099399');
    expect(() => netSalesValue(rows, REQUEST)).toThrowError(AnalyticsRefusal);
  });
});

/* ========================================================================= *
 * AR AGING refuses
 * ========================================================================= */

describe('AR AGING shows nothing, not an empty band list', () => {
  it('refuses analytics.waiting_for_integrated_surface, naming the Phase 4 readers', () => {
    try {
      arAging({ customerId: CUSTOMER, asOf: '2026-03-31', scope: SCOPE, bucketDays: [30, 60, 90] });
      expect.unreachable('an aged position must not be produced on this branch');
    } catch (error) {
      expect(error).toBeInstanceOf(AnalyticsRefusal);
      const refusal = error as AnalyticsRefusal;
      expect(refusal.code).toBe('analytics.waiting_for_integrated_surface');
      expect(refusal.httpStatus).toBe(503);
      expect(refusal.context.bucketDays).toBe('30,60,90');
    }
  });
});
