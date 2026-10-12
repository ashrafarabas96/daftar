import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTE_REGISTRY,
  ATTR_NAMES,
  COMPARATOR_MATRIX,
  COST_BOUNDS,
  COST_CLASSES,
  SHAPE_BOUNDS,
  type AttrName,
  type Comparator,
  type CostClass,
  type Predicate,
  authoritiesUsed,
  collectLeaves,
  comparatorAppliesTo,
  costClassOf,
  costProfile,
  isLeaf,
  isNarrowingClass,
  isRegisteredAttr,
  isUnaryLeaf,
  leafCount,
  nestingDepth,
  specFor,
} from '../src/segments/predicate';

const leaf = (attr: AttrName, cmp: Comparator, value?: unknown): Predicate =>
  ({ node: 'leaf', attr, cmp, ...(value === undefined ? {} : { value }) }) as unknown as Predicate;

describe('the AST is pure data plus pure functions', () => {
  it('has exactly the three boolean nodes, and negation lives in only one of them', () => {
    const nodes = new Set<string>();
    const p: Predicate = {
      node: 'all_of',
      of: [{ node: 'any_of', of: [{ node: 'none_of', of: [leaf('customer.has_email', 'is_true')] }] }],
    };
    const visit = (q: Predicate): void => {
      nodes.add(q.node);
      if (!isLeaf(q)) q.of.forEach(visit);
    };
    visit(p);
    expect([...nodes].sort()).toEqual(['all_of', 'any_of', 'leaf', 'none_of']);
  });

  it('exposes no comparator that is a second spelling of negation, and no pattern operator', () => {
    const all = new Set<Comparator>();
    for (const row of Object.values(COMPARATOR_MATRIX)) for (const c of row) all.add(c);
    expect(all.has('neq' as Comparator)).toBe(false);
    for (const forbidden of ['like', 'ilike', 'regex', 'matches', 'contains']) {
      expect(all.has(forbidden as Comparator)).toBe(false);
    }
  });

  it('keeps the comparator matrix total over the attribute types in the registry', () => {
    for (const attr of ATTR_NAMES) {
      const row = COMPARATOR_MATRIX[specFor(attr).type];
      expect(row.length).toBeGreaterThan(0);
      for (const cmp of row) expect(comparatorAppliesTo(specFor(attr).type, cmp)).toBe(true);
    }
  });

  it('gives every registered attribute an explicit cost class drawn from the design’s four names', () => {
    expect([...COST_CLASSES].sort()).toEqual(
      ['AUTHORITY_PER_CUSTOMER', 'AUTHORITY_SET', 'INDEXED_SCAN', 'JOIN_AGGREGATE'],
    );
    for (const attr of ATTR_NAMES) {
      expect(COST_CLASSES).toContain(costClassOf(attr));
    }
    expect(ATTR_NAMES.length).toBeGreaterThan(0);
  });

  it('names only indexed and join-aggregate classes as able to narrow candidates', () => {
    expect(isNarrowingClass('INDEXED_SCAN')).toBe(true);
    expect(isNarrowingClass('JOIN_AGGREGATE')).toBe(true);
    expect(isNarrowingClass('AUTHORITY_SET')).toBe(false);
    expect(isNarrowingClass('AUTHORITY_PER_CUSTOMER')).toBe(false);
  });

  it('refuses to recognise an unregistered attribute name as a value of the type', () => {
    expect(isRegisteredAttr('customer.status')).toBe(true);
    expect(isRegisteredAttr('consent.opt_out_count')).toBe(false);
    expect(isRegisteredAttr('customers.email')).toBe(false);
    expect(isRegisteredAttr('__proto__')).toBe(false);
  });
});

describe('the registry carries the laws on its own entries', () => {
  it('declares every money attribute as authority-reported, never recomputed in CRM', () => {
    const money = ATTR_NAMES.filter((a) => specFor(a).type === 'money_minor');
    expect(money.length).toBeGreaterThan(0);
    for (const attr of money) {
      const origin = specFor(attr).moneyOrigin;
      expect(origin, `${attr} must declare a money origin`).toBeDefined();
      expect(origin?.kind).toBe('authority_reported');
    }
  });

  it('admits exactly one consent literal, the positive state, and registers no opted-out member', () => {
    const spec = ATTRIBUTE_REGISTRY['consent.state'];
    expect(spec.type).toBe('enum');
    expect(spec.enumMembers).toEqual(['opted_in']);
    expect(spec.enumMembers).not.toContain('opted_out');
    expect(spec.positivePolarityOnly).toBe(true);
  });

  it('registers no absence-shaped consent counter at all', () => {
    for (const attr of ATTR_NAMES) {
      expect(attr).not.toMatch(/opt_out|unsubscribed|not_/);
    }
  });

  it('marks the aging attribute as meaningless without the segment’s own bucket-days policy', () => {
    expect(ATTRIBUTE_REGISTRY['insight.ar_max_bucket_no'].requiresBucketDaysPolicy).toBe(true);
    expect(ATTRIBUTE_REGISTRY['customer.status'].requiresBucketDaysPolicy).toBeUndefined();
  });

  it('puts the per-customer class exactly on the attributes whose upstream signature takes one customer', () => {
    const perCustomer = ATTR_NAMES.filter((a) => costClassOf(a) === 'AUTHORITY_PER_CUSTOMER');
    expect([...perCustomer].sort()).toEqual([
      'insight.ar_max_bucket_no',
      'insight.ar_open_invoice_count',
      'insight.ar_outstanding_base_minor',
    ]);
  });
});

describe('the design’s own shape bounds are quoted and not invented', () => {
  it('carries the depth, arity, leaf, in-list and serialised-size bounds', () => {
    expect(SHAPE_BOUNDS.maxDepth).toBe(4);
    expect(SHAPE_BOUNDS.minChildren).toBe(1);
    expect(SHAPE_BOUNDS.maxChildren).toBe(8);
    expect(SHAPE_BOUNDS.maxLeaves).toBe(32);
    expect(SHAPE_BOUNDS.maxInElements).toBe(32);
    expect(SHAPE_BOUNDS.maxSerialisedBytes).toBe(8 * 1024);
  });

  it('carries the per-cost-class round-trip bounds and NO candidate ceiling', () => {
    expect(COST_BOUNDS.maxAuthorityPerCustomerLeaves).toBe(1);
    expect(COST_BOUNDS.maxAuthoritySetLeaves).toBe(4);
    // The withdrawn figure must not reappear as a constant anywhere in this module.
    expect(Object.keys(COST_BOUNDS)).not.toContain('candidateCeiling');
    expect(Object.keys(SHAPE_BOUNDS)).not.toContain('candidateCeiling');
  });
});

describe('traversal', () => {
  const tree: Predicate = {
    node: 'all_of',
    of: [
      leaf('customer.status', 'eq', 'active'),
      {
        node: 'none_of',
        of: [
          leaf('customer.has_phone', 'is_false'),
          { node: 'any_of', of: [leaf('customer.contact_count', 'eq', 0)] },
        ],
      },
    ],
  };

  it('counts leaves and nesting depth in boolean nodes', () => {
    expect(leafCount(tree)).toBe(3);
    expect(nestingDepth(tree)).toBe(3);
    expect(nestingDepth(leaf('customer.status', 'eq', 'active'))).toBe(0);
  });

  it('records how many negations stand between each leaf and the root', () => {
    const occ = collectLeaves(tree);
    const byAttr = new Map(occ.map((o) => [o.leaf.attr, o.negationsAbove]));
    expect(byAttr.get('customer.status')).toBe(0);
    expect(byAttr.get('customer.has_phone')).toBe(1);
    expect(byAttr.get('customer.contact_count')).toBe(1);
  });

  it('names each leaf by a path, so a refusal can say which leaf offended', () => {
    const paths = collectLeaves(tree).map((o) => o.path);
    expect(paths[0]).toBe('root.all_of[0]');
    expect(paths).toContain('root.all_of[1].none_of[0]');
  });

  it('profiles cost by class and lists the distinct authorities a predicate would call', () => {
    expect(costProfile(tree)).toEqual({
      INDEXED_SCAN: 2,
      JOIN_AGGREGATE: 1,
      AUTHORITY_SET: 0,
      AUTHORITY_PER_CUSTOMER: 0,
    });
    expect([...authoritiesUsed(tree)].sort()).toEqual(['customer_contacts', 'customers_own_columns']);
  });

  it('identifies the unary leaves, the ones whose comparator is the whole predicate', () => {
    const occ = collectLeaves(tree);
    const unary = occ.filter((o) => isUnaryLeaf(o.leaf)).map((o) => o.leaf.attr);
    expect(unary).toEqual(['customer.has_phone']);
  });

  it('profiles a per-customer leaf under its own class', () => {
    const p = leaf('insight.ar_open_invoice_count', 'eq', 0);
    expect(costProfile(p).AUTHORITY_PER_CUSTOMER).toBe(1);
    expect(costClassOf('insight.ar_outstanding_base_minor')).toBe('AUTHORITY_PER_CUSTOMER');
  });
});

describe('the AST module emits no query text at all', () => {
  const sources = ['predicate.ts', 'validate.ts'].map((f) => ({
    name: f,
    text: readFileSync(join(__dirname, '..', 'src', 'segments', f), 'utf8'),
  }));

  it('holds no SQL keyword, no fragment template and no escape-hatch field name', () => {
    for (const { name, text } of sources) {
      for (const kw of ['SELECT', 'UNION', 'DROP', 'INSERT', 'DELETE', 'SECURITY DEFINER']) {
        expect(text.includes(kw), `${name} must not contain ${kw}`).toBe(false);
      }
      expect(text).not.toMatch(/%P%/);
    }
  });

  it('exposes no grammar field whose value could reach a query', () => {
    const forbiddenKeys = ['sql', 'expr', 'raw', 'having', 'orderBy', 'limit'];
    const spec = JSON.stringify(ATTRIBUTE_REGISTRY);
    for (const k of forbiddenKeys) {
      expect(spec.includes(`"${k}"`), `registry must not carry a ${k} field`).toBe(false);
    }
  });
});
