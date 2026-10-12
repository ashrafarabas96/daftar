import { describe, expect, it } from 'vitest';
import { AnalyticsRefusal } from '../src/errors';
import {
  type AttrName,
  type AttributeSpec,
  type Comparator,
  type Predicate,
} from '../src/segments/predicate';
import {
  type AuthorityPresence,
  type CostBoundConfig,
  type ValidationInput,
  NO_AUTHORITY_PRESENT,
  assertNoFinancialRederivation,
  validateAndRequireAuthorities,
  validatePredicate,
  validateSerialisedDefinition,
} from '../src/segments/validate';

/**
 * A ceiling supplied BY THE CALLER, as the design requires. It is not a product
 * default and nothing in `src/` holds a figure like it: the design withdrew its
 * proposed number and left the bound to measurement on the authoritative box, so
 * the only legitimate place for a figure is a caller's configuration — here, a
 * test's.
 */
const CEILING_SUPPLIED_BY_TEST = 500;
const BOUNDS: CostBoundConfig = { candidateCeiling: CEILING_SUPPLIED_BY_TEST };
const INPUT: ValidationInput = { bounds: BOUNDS };

const leaf = (attr: AttrName, cmp: Comparator, value?: unknown): Predicate =>
  ({ node: 'leaf', attr, cmp, ...(value === undefined ? {} : { value }) }) as unknown as Predicate;

const allOf = (...of: Predicate[]): Predicate => ({ node: 'all_of', of });
const anyOf = (...of: Predicate[]): Predicate => ({ node: 'any_of', of });
const noneOf = (...of: Predicate[]): Predicate => ({ node: 'none_of', of });

const OPTED_IN = leaf('consent.state', 'eq', 'opted_in');
const STATUS_ACTIVE = leaf('customer.status', 'eq', 'active');

function refusalOf(fn: () => unknown): AnalyticsRefusal {
  try {
    fn();
  } catch (e) {
    if (e instanceof AnalyticsRefusal) return e;
    throw e;
  }
  throw new Error('expected a refusal and got an answer; the law under test did not fire');
}

/** A tree of `n` indexed leaves, respecting the arity bound at every node. */
function manyLeaves(n: number): Predicate {
  const groups: Predicate[] = [];
  let left = n;
  while (left > 0) {
    const take = Math.min(5, left);
    groups.push(allOf(...Array.from({ length: take }, () => leaf('customer.has_email', 'is_true'))));
    left -= take;
  }
  return allOf(...groups);
}

function nest(depth: number): Predicate {
  let p: Predicate = leaf('customer.has_email', 'is_true');
  for (let i = 0; i < depth; i += 1) p = allOf(p);
  return p;
}

/* ================================================================== *
 * The admissible baseline, and the law that a predicate is not a grant.
 * ================================================================== */

describe('an admissible predicate, and what its certificate refuses to be', () => {
  it('admits the positive-state consent leaf, the one form the design rules admissible', () => {
    const admission = validatePredicate(OPTED_IN, INPUT);
    expect(admission.kind).toBe('segment_predicate_admission');
    expect(admission.leafCount).toBe(1);
    expect(admission.authoritiesRequired).toEqual(['marketing_consent']);
    expect(admission.candidateCeilingApplied).toBe(CEILING_SUPPLIED_BY_TEST);
  });

  it('states its own three negations, so membership cannot be read as authority', () => {
    const admission = validatePredicate(STATUS_ACTIVE, INPUT);
    expect(admission.confersAuthority).toBe(false);
    expect(admission.isPermissionBoundary).toBe(false);
    expect(admission.isSuppressionMechanism).toBe(false);
  });

  it('hands back a frozen record carrying no grant-shaped field at all', () => {
    const admission = validatePredicate(STATUS_ACTIVE, INPUT);
    expect(Object.isFrozen(admission)).toBe(true);
    // The only permission-shaped words on the certificate are its own three
    // negations; every other key is descriptive of the predicate.
    const declaredNegations = ['confersAuthority', 'isPermissionBoundary', 'isSuppressionMechanism'];
    for (const key of Object.keys(admission).filter((k) => !declaredNegations.includes(k))) {
      expect(key).not.toMatch(/permission|grant|role|allowed|authorityDecision/i);
    }
    expect(Object.keys(admission)).not.toContain('authorityDecision');
    expect(Object.keys(admission)).not.toContain('grantedPermissions');
  });

  it('never answers with a boolean: the only two outcomes are a certificate or a refusal', () => {
    expect(typeof validatePredicate(STATUS_ACTIVE, INPUT)).toBe('object');
    expect(refusalOf(() => validatePredicate(OPTED_IN, {} as unknown as ValidationInput))).toBeInstanceOf(
      AnalyticsRefusal,
    );
  });
});

/* ================================================================== *
 * RED PROOF 1 — the inadmissible consent count.
 * ================================================================== */

describe('RED PROOF: the absence-shaped consent predicate is refused', () => {
  it('refuses `{consent.opt_out_count, eq, 0}` as an unregistered attribute', () => {
    const absenceWearingACount = leaf('consent.opt_out_count' as AttrName, 'eq', 0);
    const r = refusalOf(() => validatePredicate(absenceWearingACount, INPUT));
    expect(r.code).toBe('analytics.predicate_not_serveable');
    expect(r.context['designCode']).toBe('segment.attribute_unknown');
    expect(r.context['attr']).toBe('consent.opt_out_count');
  });

  it('refuses it from a STORED definition too, because our own storage is not a trust boundary', () => {
    const stored = JSON.stringify({ node: 'leaf', attr: 'consent.opt_out_count', cmp: 'eq', value: 0 });
    const r = refusalOf(() => validateSerialisedDefinition(stored, INPUT));
    expect(r.context['designCode']).toBe('segment.attribute_unknown');
  });

  it('refuses the opted-out literal, so the deny-list audience is not expressible either', () => {
    const r = refusalOf(() => validatePredicate(leaf('consent.state', 'eq', 'opted_out'), INPUT));
    expect(r.context['designCode']).toBe('segment.literal_invalid');
    expect(r.context['attr']).toBe('consent.state');
  });
});

/* ================================================================== *
 * RED PROOF 2 — a `not` around the admissible positive consent leaf.
 * ================================================================== */

describe('RED PROOF: a negation may not turn the positive consent leaf into an absence predicate', () => {
  it('refuses `none_of [ {consent.state, eq, opted_in} ]`', () => {
    const r = refusalOf(() => validatePredicate(noneOf(OPTED_IN), INPUT));
    expect(r.code).toBe('analytics.predicate_not_serveable');
    expect(r.context['law']).toBe('consent.positive_state_only');
    expect(r.context['attr']).toBe('consent.state');
    expect(r.context['negationsAbove']).toBe('1');
  });

  it('refuses it at any depth, and under a double negation, so the law does not depend on parity', () => {
    const deep = refusalOf(() => validatePredicate(allOf(STATUS_ACTIVE, noneOf(anyOf(OPTED_IN))), INPUT));
    expect(deep.context['law']).toBe('consent.positive_state_only');
    const doubled = refusalOf(() => validatePredicate(noneOf(noneOf(OPTED_IN)), INPUT));
    expect(doubled.context['law']).toBe('consent.positive_state_only');
    expect(doubled.context['negationsAbove']).toBe('2');
  });

  it('still admits a negation around a leaf that is a fact about a VISIBLE row', () => {
    // Column-NULL on a row the actor can see is a fact, not a row-absence, so the
    // rule is targeted rather than a blanket ban on `none_of`.
    const admission = validatePredicate(noneOf(leaf('customer.has_email', 'is_true')), INPUT);
    expect(admission.leafCount).toBe(1);
  });
});

/* ================================================================== *
 * RED PROOF 3 — the shape bounds, proven at the bound, one under, one over.
 * ================================================================== */

describe('RED PROOF: the shape bounds refuse, and they refuse at the right place', () => {
  it('admits 31 and 32 leaves and refuses 33', () => {
    expect(validatePredicate(manyLeaves(31), INPUT).leafCount).toBe(31);
    expect(validatePredicate(manyLeaves(32), INPUT).leafCount).toBe(32);
    const r = refusalOf(() => validatePredicate(manyLeaves(33), INPUT));
    expect(r.context['designCode']).toBe('segment.predicate_too_complex');
    expect(r.context['bound']).toBe('maxLeaves');
    expect(r.context['limit']).toBe('32');
    expect(r.context['actual']).toBe('33');
  });

  it('admits depth 3 and 4 and refuses depth 5', () => {
    expect(validatePredicate(nest(3), INPUT).nestingDepth).toBe(3);
    expect(validatePredicate(nest(4), INPUT).nestingDepth).toBe(4);
    const r = refusalOf(() => validatePredicate(nest(5), INPUT));
    expect(r.context['bound']).toBe('maxDepth');
    expect(r.context['actual']).toBe('5');
  });

  it('admits 7 and 8 children on a boolean node and refuses 9', () => {
    const children = (n: number): Predicate =>
      allOf(...Array.from({ length: n }, () => leaf('customer.has_phone', 'is_true')));
    expect(validatePredicate(children(7), INPUT).leafCount).toBe(7);
    expect(validatePredicate(children(8), INPUT).leafCount).toBe(8);
    const r = refusalOf(() => validatePredicate(children(9), INPUT));
    expect(r.context['bound']).toBe('maxChildren');
    expect(r.context['actual']).toBe('9');
  });

  it('refuses an empty boolean node, because it is a predicate that asserts nothing', () => {
    const r = refusalOf(() => validatePredicate(allOf(), INPUT));
    expect(r.context['bound']).toBe('maxChildren');
    expect(r.context['actual']).toBe('0');
  });

  it('admits an `in` list of 31 and 32 elements and refuses 33', () => {
    const inList = (n: number): Predicate =>
      leaf('customer.status', 'in', Array.from({ length: n }, () => 'active'));
    expect(validatePredicate(inList(31), INPUT).leafCount).toBe(1);
    expect(validatePredicate(inList(32), INPUT).leafCount).toBe(1);
    const r = refusalOf(() => validatePredicate(inList(33), INPUT));
    expect(r.context['bound']).toBe('maxInElements');
    expect(r.context['actual']).toBe('33');
  });

  it('refuses a serialised definition over the parser bound, before parsing it', () => {
    const r = refusalOf(() => validateSerialisedDefinition('x'.repeat(8 * 1024 + 1), INPUT));
    expect(r.context['bound']).toBe('maxSerialisedBytes');
    expect(r.context['actual']).toBe('8193');
  });
});

/* ================================================================== *
 * RED PROOF 4 — no cost bound supplied.
 * ================================================================== */

describe('RED PROOF: a predicate with no cost bound supplied is refused', () => {
  it('refuses when the caller supplies no bounds object at all', () => {
    const r = refusalOf(() => validatePredicate(STATUS_ACTIVE, undefined as unknown as ValidationInput));
    expect(r.code).toBe('analytics.predicate_not_serveable');
    expect(r.context['bound']).toBe('candidateCeiling');
  });

  it('refuses when the bounds object carries no ceiling', () => {
    const r = refusalOf(() => validatePredicate(STATUS_ACTIVE, { bounds: {} } as unknown as ValidationInput));
    expect(r.context['bound']).toBe('candidateCeiling');
    expect(r.context['supplied']).toBe('undefined');
  });

  it('refuses a ceiling that is zero, negative, fractional or not a number: never unbounded', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '500']) {
      const r = refusalOf(() =>
        validatePredicate(STATUS_ACTIVE, { bounds: { candidateCeiling: bad } } as unknown as ValidationInput),
      );
      expect(r.context['bound'], `ceiling ${String(bad)} must be refused`).toBe('candidateCeiling');
    }
  });

  it('refuses the cheapest possible predicate too: no class is exempt from the configuration', () => {
    const r = refusalOf(() =>
      validatePredicate(leaf('customer.has_email', 'is_true'), { bounds: {} } as unknown as ValidationInput),
    );
    expect(r.context['bound']).toBe('candidateCeiling');
  });
});

/* ================================================================== *
 * RED PROOF 5 — financial re-derivation.
 * ================================================================== */

describe('RED PROOF: a predicate that would re-derive money is refused', () => {
  const planted = (moneyOrigin: AttributeSpec['moneyOrigin']): AttributeSpec => ({
    type: 'money_minor',
    costClass: 'JOIN_AGGREGATE',
    authority: 'customers_own_columns',
    ...(moneyOrigin === undefined ? {} : { moneyOrigin }),
  });

  it('refuses a money attribute whose figure CRM would recompute itself', () => {
    const r = refusalOf(() =>
      assertNoFinancialRederivation('insight.planted_recomputed_total', planted({ kind: 'recomputed_in_crm' })),
    );
    expect(r.code).toBe('analytics.predicate_not_serveable');
    expect(r.context['law']).toBe('no_financial_rederivation');
    expect(r.context['origin']).toBe('recomputed_in_crm');
  });

  it('refuses a money attribute that names no reporting authority at all', () => {
    const r = refusalOf(() => assertNoFinancialRederivation('insight.planted_originless', planted(undefined)));
    expect(r.context['law']).toBe('no_financial_rederivation');
  });

  it('passes the registry’s real money attributes, which only REFERENCE an authority figure', () => {
    expect(() =>
      assertNoFinancialRederivation('insight.ar_outstanding_base_minor', {
        type: 'money_minor',
        costClass: 'AUTHORITY_PER_CUSTOMER',
        authority: 'receivables',
        moneyOrigin: { kind: 'authority_reported', authority: 'receivables' },
      }),
    ).not.toThrow();
  });

  it('refuses a money literal that arrived as a JavaScript number', () => {
    const p = allOf(STATUS_ACTIVE, leaf('insight.ar_outstanding_base_minor', 'eq', 0));
    const r = refusalOf(() => validatePredicate(p, { bounds: BOUNDS, narrowedCandidateCount: 1 }));
    expect(r.context['designCode']).toBe('segment.literal_invalid');
  });

  it('resolves a money-needing predicate to a REFUSAL and not a zero, because the port is absent', () => {
    // Measured on this branch: the money read authorities do not exist, exactly as
    // src/ports.ts records. The honest answer is a named refusal.
    const p = allOf(STATUS_ACTIVE, leaf('insight.ar_outstanding_base_minor', 'eq', '0'));
    const input: ValidationInput = { bounds: BOUNDS, narrowedCandidateCount: 10 };
    expect(validatePredicate(p, input).costProfile.AUTHORITY_PER_CUSTOMER).toBe(1);
    const r = refusalOf(() => validateAndRequireAuthorities(p, input, NO_AUTHORITY_PRESENT));
    expect(r.code).toBe('analytics.waiting_for_integrated_surface');
    expect(r.httpStatus).toBe(503);
    expect(['customers_own_columns', 'receivables']).toContain(r.context['authority']);
  });

  it('admits the same predicate once the owning authority is present', () => {
    const present: AuthorityPresence = {
      customers_own_columns: true,
      customer_contacts: true,
      sales_activity: true,
      receivables: true,
      marketing_consent: true,
    };
    const p = allOf(STATUS_ACTIVE, leaf('insight.ar_outstanding_base_minor', 'eq', '0'));
    const admission = validateAndRequireAuthorities(p, { bounds: BOUNDS, narrowedCandidateCount: 10 }, present);
    expect(admission.authoritiesRequired).toContain('receivables');
  });
});

/* ================================================================== *
 * The per-cost-class bounds.
 * ================================================================== */

describe('the per-cost-class bounds the design states', () => {
  const setLeaves = (n: number): Predicate =>
    allOf(...Array.from({ length: n }, () => leaf('insight.sale_count_total', 'gte', 1)));

  it('admits 3 and 4 set-based authority leaves and refuses 5', () => {
    expect(validatePredicate(setLeaves(3), INPUT).costProfile.AUTHORITY_SET).toBe(3);
    expect(validatePredicate(setLeaves(4), INPUT).costProfile.AUTHORITY_SET).toBe(4);
    const r = refusalOf(() => validatePredicate(setLeaves(5), INPUT));
    expect(r.context['costClass']).toBe('AUTHORITY_SET');
    expect(r.context['limit']).toBe('4');
    expect(r.context['actual']).toBe('5');
  });

  const perCustomer = allOf(STATUS_ACTIVE, leaf('insight.ar_open_invoice_count', 'eq', 0));

  it('admits one per-customer leaf when a narrowing leaf bounds the candidate set', () => {
    const admission = validatePredicate(perCustomer, { bounds: BOUNDS, narrowedCandidateCount: 10 });
    expect(admission.costProfile.AUTHORITY_PER_CUSTOMER).toBe(1);
  });

  it('refuses a second per-customer leaf', () => {
    const two = allOf(
      STATUS_ACTIVE,
      leaf('insight.ar_open_invoice_count', 'eq', 0),
      leaf('insight.ar_outstanding_base_minor', 'eq', '0'),
    );
    const r = refusalOf(() => validatePredicate(two, { bounds: BOUNDS, narrowedCandidateCount: 10 }));
    expect(r.context['costClass']).toBe('AUTHORITY_PER_CUSTOMER');
    expect(r.context['limit']).toBe('1');
    expect(r.context['actual']).toBe('2');
  });

  it('admits a narrowed set at the ceiling and one under, and refuses one over', () => {
    const at = validatePredicate(perCustomer, { bounds: BOUNDS, narrowedCandidateCount: CEILING_SUPPLIED_BY_TEST });
    expect(at.candidateCeilingApplied).toBe(CEILING_SUPPLIED_BY_TEST);
    expect(() =>
      validatePredicate(perCustomer, { bounds: BOUNDS, narrowedCandidateCount: CEILING_SUPPLIED_BY_TEST - 1 }),
    ).not.toThrow();
    const r = refusalOf(() =>
      validatePredicate(perCustomer, { bounds: BOUNDS, narrowedCandidateCount: CEILING_SUPPLIED_BY_TEST + 1 }),
    );
    expect(r.context['ceiling']).toBe(String(CEILING_SUPPLIED_BY_TEST));
    expect(r.context['candidates']).toBe(String(CEILING_SUPPLIED_BY_TEST + 1));
  });

  it('refuses when the narrowed candidate count was never established: an unknown cost is refused', () => {
    const r = refusalOf(() => validatePredicate(perCustomer, INPUT));
    expect(r.context['attr']).toBe('insight.ar_open_invoice_count');
    expect(r.context['supplied']).toBe('undefined');
  });

  it('refuses a per-customer leaf in disjunctive position, because an OR does not narrow', () => {
    const r = refusalOf(() =>
      validatePredicate(anyOf(STATUS_ACTIVE, leaf('insight.ar_open_invoice_count', 'eq', 0)), {
        bounds: BOUNDS,
        narrowedCandidateCount: 1,
      }),
    );
    expect(r.context['attr']).toBe('insight.ar_open_invoice_count');
    expect(r.context['path']).toContain('any_of');
  });

  it('refuses a per-customer leaf with no narrowing leaf anywhere: the narrowing may not itself be per-customer', () => {
    const r = refusalOf(() =>
      validatePredicate(leaf('insight.ar_open_invoice_count', 'eq', 0), {
        bounds: BOUNDS,
        narrowedCandidateCount: 1,
      }),
    );
    expect(r.context['attr']).toBe('insight.ar_open_invoice_count');
  });

  it('refuses the aging leaf without the segment’s own bucket-days policy, and admits it with one', () => {
    const aging = allOf(STATUS_ACTIVE, leaf('insight.ar_max_bucket_no', 'lte', 1));
    const r = refusalOf(() => validatePredicate(aging, { bounds: BOUNDS, narrowedCandidateCount: 10 }));
    expect(r.context['law']).toBe('bucket_days_required');
    const admission = validatePredicate(aging, {
      bounds: BOUNDS,
      narrowedCandidateCount: 10,
      bucketDays: [30, 60, 90],
    });
    expect(admission.leafCount).toBe(2);
  });
});

/* ================================================================== *
 * Literals, comparators, and the stored-definition path.
 * ================================================================== */

describe('literals and comparators', () => {
  it('refuses a comparator that does not apply to the attribute type', () => {
    const r = refusalOf(() => validatePredicate(leaf('customer.status', 'gt', 'active'), INPUT));
    expect(r.context['designCode']).toBe('segment.operator_not_applicable');
    expect(r.context['cmp']).toBe('gt');
  });

  it('refuses a value on a bool comparator, which is the whole predicate by itself', () => {
    const r = refusalOf(() => validatePredicate(leaf('customer.has_email', 'is_true', true), INPUT));
    expect(r.context['designCode']).toBe('segment.literal_invalid');
  });

  it('refuses a date that is well-formed but not a real date, and admits a real one', () => {
    expect(refusalOf(() => validatePredicate(leaf('customer.created_on', 'on', '2026-02-30'), INPUT)).context['designCode']).toBe(
      'segment.literal_invalid',
    );
    expect(refusalOf(() => validatePredicate(leaf('customer.created_on', 'on', '12/10/2026'), INPUT)).context['designCode']).toBe(
      'segment.literal_invalid',
    );
    expect(validatePredicate(leaf('customer.created_on', 'on_or_after', '2026-10-12'), INPUT).leafCount).toBe(1);
  });

  it('refuses a negative or fractional count literal', () => {
    expect(refusalOf(() => validatePredicate(leaf('customer.contact_count', 'eq', -1), INPUT)).context['designCode']).toBe(
      'segment.literal_invalid',
    );
    expect(refusalOf(() => validatePredicate(leaf('customer.contact_count', 'eq', 1.5), INPUT)).context['designCode']).toBe(
      'segment.literal_invalid',
    );
    expect(validatePredicate(leaf('customer.contact_count', 'eq', 0), INPUT).leafCount).toBe(1);
  });

  it('checks both operands of a `between`', () => {
    const ok = allOf(leaf('customer.created_on', 'between', ['2026-01-01', '2026-12-31']));
    expect(validatePredicate(ok, INPUT).leafCount).toBe(1);
    const r = refusalOf(() =>
      validatePredicate(leaf('customer.created_on', 'between', ['2026-01-01', 'not-a-date']), INPUT),
    );
    expect(r.context['designCode']).toBe('segment.literal_invalid');
    expect(refusalOf(() => validatePredicate(leaf('customer.created_on', 'between', ['2026-01-01']), INPUT)).context['designCode']).toBe(
      'segment.literal_invalid',
    );
  });
});

describe('a stored definition is revalidated on every evaluation', () => {
  it('admits a well-formed stored definition', () => {
    const stored = JSON.stringify({
      node: 'all_of',
      of: [
        { node: 'leaf', attr: 'customer.status', cmp: 'eq', value: 'active' },
        { node: 'leaf', attr: 'consent.state', cmp: 'eq', value: 'opted_in' },
      ],
    });
    const admission = validateSerialisedDefinition(stored, INPUT);
    expect(admission.leafCount).toBe(2);
    expect(admission.confersAuthority).toBe(false);
  });

  it('drops any field the grammar does not have, so no stored key can become a passenger', () => {
    const stored = JSON.stringify({
      node: 'leaf',
      attr: 'customer.status',
      cmp: 'eq',
      value: 'active',
      sql: 'anything at all',
      raw: 'anything at all',
    });
    const admission = validateSerialisedDefinition(stored, INPUT);
    expect(Object.keys(admission.predicate).sort()).toEqual(['attr', 'cmp', 'node', 'value']);
  });

  it('refuses a stored node that is not a leaf or one of the three boolean nodes', () => {
    const r = refusalOf(() => validateSerialisedDefinition(JSON.stringify({ node: 'not', of: [] }), INPUT));
    expect(r.context['designCode']).toBe('segment.literal_invalid');
  });

  it('refuses malformed JSON and a non-object root', () => {
    expect(refusalOf(() => validateSerialisedDefinition('{not json', INPUT)).code).toBe(
      'analytics.predicate_not_serveable',
    );
    expect(refusalOf(() => validateSerialisedDefinition('[]', INPUT)).context['designCode']).toBe(
      'segment.literal_invalid',
    );
  });

  it('refuses a stored boolean node whose `of` is not an array', () => {
    const r = refusalOf(() => validateSerialisedDefinition(JSON.stringify({ node: 'all_of', of: 'x' }), INPUT));
    expect(r.context['designCode']).toBe('segment.literal_invalid');
  });
});
