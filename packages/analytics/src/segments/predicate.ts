/**
 * P13-S5 — the segment predicate AST.
 *
 * Pure data and pure functions. No I/O, no database handle, no clock. The AST is
 * the whole of what a merchant may supply: a tree of typed leaves drawn from a
 * closed registry plus one literal per leaf. A merchant never supplies SQL,
 * never an identifier, never an operator, never a fragment of query text
 * (design §3.3's governing law).
 *
 * TWO THINGS THIS FILE IS NOT:
 *
 *  1. It is not a permission. A predicate answers *who*; the permission registry
 *     answers *whether this member may act* (design §4). Nothing in this file
 *     returns an authorisation, a role, a grant or a boolean named like one, and
 *     `validate.ts` hands back a certificate whose shape refuses to be read as a
 *     grant.
 *  2. It is not a suppression mechanism. Suppression, consent and opt-out are
 *     enforced PER RECIPIENT on the send path (design §4.0.1). A frozen
 *     membership cannot reach that point, so no shape here may stand in for it.
 *
 * NOT MEASURED HERE, and deliberately so: this file emits no SQL. The compiler
 * of design §3.5 and its byte-for-byte shape invariant are a separate unit; a
 * placeholder-fragment table does not belong in the AST module, and inventing one
 * here would put query text next to merchant-supplied values.
 */

/* ------------------------------------------------------------------ *
 * Attribute types, comparators, and the closed comparator matrix.
 * ------------------------------------------------------------------ */

/** The literal types an attribute may carry (design §3.3.2 "Type" column). */
export type AttributeType = 'enum' | 'bool' | 'civil_date' | 'count' | 'money_minor';

/**
 * The closed comparator set. `neq` is deliberately absent from every row of the
 * matrix: negation lives in exactly one place, the `none_of` node, so that a
 * second spelling of negation cannot smuggle an absence predicate back in
 * (design §3.3.3).
 */
export type Comparator =
  | 'eq'
  | 'in'
  | 'is_true'
  | 'is_false'
  | 'on'
  | 'before'
  | 'after'
  | 'on_or_before'
  | 'on_or_after'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'between';

/** Comparators valid per type. The matrix is closed and total (design §3.3.3). */
export const COMPARATOR_MATRIX: { readonly [T in AttributeType]: readonly Comparator[] } = {
  enum: ['eq', 'in'],
  bool: ['is_true', 'is_false'],
  civil_date: ['on', 'before', 'after', 'on_or_before', 'on_or_after', 'between'],
  count: ['eq', 'lt', 'lte', 'gt', 'gte', 'between'],
  money_minor: ['eq', 'lt', 'lte', 'gt', 'gte', 'between'],
} as const;

export function comparatorAppliesTo(type: AttributeType, cmp: Comparator): boolean {
  return COMPARATOR_MATRIX[type].includes(cmp);
}

/* ------------------------------------------------------------------ *
 * Cost classes — the design's own four names (design §3.8).
 * ------------------------------------------------------------------ */

/**
 * A cost class is a property of the UPSTREAM'S OWN SIGNATURE, not an estimate.
 * `AUTHORITY_PER_CUSTOMER` exists because the canonical AR readers each take one
 * customer, so a whole-business evaluation would be O(customers) round trips.
 * Phase 13's two honest options there are to loop or to refuse; it refuses.
 */
export type CostClass = 'INDEXED_SCAN' | 'JOIN_AGGREGATE' | 'AUTHORITY_SET' | 'AUTHORITY_PER_CUSTOMER';

export const COST_CLASSES: readonly CostClass[] = ['INDEXED_SCAN', 'JOIN_AGGREGATE', 'AUTHORITY_SET', 'AUTHORITY_PER_CUSTOMER'] as const;

/** The classes that may perform candidate narrowing (design §3.8, last bullet). */
export function isNarrowingClass(c: CostClass): boolean {
  return c === 'INDEXED_SCAN' || c === 'JOIN_AGGREGATE';
}

/* ------------------------------------------------------------------ *
 * The authorities a leaf may be served by.
 * ------------------------------------------------------------------ */

/**
 * Which owning authority serves an attribute. `customers_own_columns` means the
 * answer is a column on a row the actor can already see — a fact about a visible
 * row, which design §5.2 distinguishes from the absence of a row.
 */
export type AuthorityName = 'customers_own_columns' | 'customer_contacts' | 'sales_activity' | 'receivables' | 'marketing_consent';

/**
 * NO FINANCIAL RE-DERIVATION IN CRM (design §3.7 clause 3, lock PART 81/PART 89).
 *
 * A money figure may only ever be REFERENCED as the owning authority returned
 * it. Phase 13 may not recompute one — not from lines, not from a sum, not from
 * "the same arithmetic the authority does". The origin therefore travels on the
 * attribute spec, and `validate.ts` refuses any money leaf that does not declare
 * `authority_reported`. The second member of this union exists so that the law
 * is a checkable branch rather than a comment: a planted spec declaring it is
 * what the red proof in the test suite feeds the validator.
 */
export type MoneyOrigin = { readonly kind: 'authority_reported'; readonly authority: AuthorityName } | { readonly kind: 'recomputed_in_crm' };

/* ------------------------------------------------------------------ *
 * The attribute registry (closed).
 * ------------------------------------------------------------------ */

/**
 * `AttrName` is a TypeScript union, not a string checked against an allow-list.
 * An unregistered name is not a value of the type, and the registry map is
 * exhaustive by construction, so a registry entry added without a spec does not
 * compile.
 */
export type AttrName =
  | 'customer.status'
  | 'customer.created_on'
  | 'customer.has_email'
  | 'customer.has_phone'
  | 'customer.contact_count'
  | 'insight.last_sale_on'
  | 'insight.sale_count_window'
  | 'insight.sale_count_total'
  | 'insight.value_total_base_minor'
  | 'insight.ar_outstanding_base_minor'
  | 'insight.ar_open_invoice_count'
  | 'insight.ar_max_bucket_no'
  | 'consent.state';

export interface AttributeSpec {
  readonly type: AttributeType;
  readonly costClass: CostClass;
  readonly authority: AuthorityName;
  /** Present exactly when `type === 'money_minor'`. */
  readonly moneyOrigin?: MoneyOrigin;
  /** Enum member set, present exactly when `type === 'enum'`. */
  readonly enumMembers?: readonly string[];
  /**
   * True when the attribute may appear only in POSITIVE polarity — i.e. with no
   * `none_of` anywhere above it. See `validate.ts` and the note on
   * `consent.state` below.
   */
  readonly positivePolarityOnly?: boolean;
  /** True when a leaf naming it is meaningless without the segment's own `bucketDays`. */
  readonly requiresBucketDaysPolicy?: boolean;
}

/**
 * The closed registry.
 *
 * WHERE THE DESIGN AND THE LIVE TREE DISAGREE, and it is recorded here rather
 * than quietly resolved: design §3.3.2 cites a "Served from" relation for every
 * row. Measured on this branch on 2026-10-12 by `git grep`, NONE of those
 * relations exists — the Phase 4 customers, sales and receivables modules are
 * absent from `main`, exactly as `src/ports.ts:5-16` already records for the
 * read ports. So the registry below declares the SHAPE of each attribute and
 * names its owning authority; whether that authority can be called at all is a
 * separate, injected fact (`AuthorityPresence` in `validate.ts`), and the honest
 * answer while it is absent is a refusal and never a zero.
 */
export const ATTRIBUTE_REGISTRY: { readonly [A in AttrName]: AttributeSpec } = {
  'customer.status': {
    type: 'enum',
    costClass: 'INDEXED_SCAN',
    authority: 'customers_own_columns',
    enumMembers: ['active', 'inactive'],
  },
  'customer.created_on': {
    type: 'civil_date',
    costClass: 'INDEXED_SCAN',
    authority: 'customers_own_columns',
  },
  // Column-NULL on a VISIBLE row is a fact (design §5.2), so these need no
  // restatement as a positive count.
  'customer.has_email': { type: 'bool', costClass: 'INDEXED_SCAN', authority: 'customers_own_columns' },
  'customer.has_phone': { type: 'bool', costClass: 'INDEXED_SCAN', authority: 'customers_own_columns' },
  // A positive count. `eq 0` is the legitimate form of "has no contacts".
  'customer.contact_count': { type: 'count', costClass: 'JOIN_AGGREGATE', authority: 'customer_contacts' },

  'insight.last_sale_on': { type: 'civil_date', costClass: 'AUTHORITY_SET', authority: 'sales_activity' },
  'insight.sale_count_window': { type: 'count', costClass: 'AUTHORITY_SET', authority: 'sales_activity' },
  'insight.sale_count_total': { type: 'count', costClass: 'AUTHORITY_SET', authority: 'sales_activity' },
  'insight.value_total_base_minor': {
    type: 'money_minor',
    costClass: 'AUTHORITY_SET',
    authority: 'sales_activity',
    moneyOrigin: { kind: 'authority_reported', authority: 'sales_activity' },
  },

  'insight.ar_outstanding_base_minor': {
    type: 'money_minor',
    costClass: 'AUTHORITY_PER_CUSTOMER',
    authority: 'receivables',
    moneyOrigin: { kind: 'authority_reported', authority: 'receivables' },
  },
  'insight.ar_open_invoice_count': {
    type: 'count',
    costClass: 'AUTHORITY_PER_CUSTOMER',
    authority: 'receivables',
  },
  'insight.ar_max_bucket_no': {
    type: 'count',
    costClass: 'AUTHORITY_PER_CUSTOMER',
    authority: 'receivables',
    requiresBucketDaysPolicy: true,
  },

  /**
   * CONSENT — admissible in exactly one form (design §4.0.1).
   *
   * `enumMembers` is the single member `opted_in` and not the full lifecycle of a
   * consent record. The design admits the literal form `{consent.state, eq,
   * 'opted_in'}` and nothing else, on the argument that a positive-state
   * allow-list narrows the audience and therefore fails CLOSED. Registering
   * `opted_out` as a member would make the deny-list audience expressible with
   * no further code, and that audience fails toward SEND.
   *
   * `positivePolarityOnly` is this file's CONSERVATIVE READING of a case the
   * design does not settle: §3.3.3 moves all negation into `none_of`, and
   * §4.0.1 argues only about the leaf in isolation, so `none_of [ {consent.state,
   * eq, 'opted_in'} ]` — "not opted in" — is left unaddressed. It is an
   * absence-shaped predicate wearing a negation node, with the same failure
   * direction §4.0.1 refuses the count for, so it is refused.
   */
  'consent.state': {
    type: 'enum',
    costClass: 'AUTHORITY_SET',
    authority: 'marketing_consent',
    enumMembers: ['opted_in'],
    positivePolarityOnly: true,
  },
} as const;

export const ATTR_NAMES: readonly AttrName[] = Object.keys(ATTRIBUTE_REGISTRY) as readonly AttrName[];

export function isRegisteredAttr(name: string): name is AttrName {
  return Object.prototype.hasOwnProperty.call(ATTRIBUTE_REGISTRY, name);
}

export function specFor(attr: AttrName): AttributeSpec {
  const spec = ATTRIBUTE_REGISTRY[attr];
  /* istanbul ignore if -- unreachable: AttrName is the registry's key union */
  if (spec === undefined) throw new Error(`unregistered attribute: ${attr}`);
  return spec;
}

export function costClassOf(attr: AttrName): CostClass {
  return specFor(attr).costClass;
}

/* ------------------------------------------------------------------ *
 * The AST.
 * ------------------------------------------------------------------ */

/**
 * A literal. Money is a decimal STRING end to end — a `number` on a money path
 * has already lost the value — and a civil date is a `YYYY-MM-DD` string.
 */
export type Literal = string | number | boolean;

/** Leaves, as discriminated unions over the comparator's arity. */
export interface UnaryLeaf {
  readonly node: 'leaf';
  readonly attr: AttrName;
  /** The comparator IS the whole predicate; there is no `value`. */
  readonly cmp: 'is_true' | 'is_false';
}

export interface ComparisonLeaf {
  readonly node: 'leaf';
  readonly attr: AttrName;
  readonly cmp: 'eq' | 'on' | 'before' | 'after' | 'on_or_before' | 'on_or_after' | 'lt' | 'lte' | 'gt' | 'gte';
  readonly value: Literal;
}

export interface BetweenLeaf {
  readonly node: 'leaf';
  readonly attr: AttrName;
  readonly cmp: 'between';
  readonly value: readonly [Literal, Literal];
}

export interface InLeaf {
  readonly node: 'leaf';
  readonly attr: AttrName;
  readonly cmp: 'in';
  readonly value: readonly Literal[];
}

export type Leaf = UnaryLeaf | ComparisonLeaf | BetweenLeaf | InLeaf;

/**
 * Boolean nodes. Exactly three, and the tree nests through these alone, so the
 * grammar is not recursive beyond a fixed depth and has no construct whose
 * evaluation depends on the data it evaluates over.
 */
export interface AllOfNode {
  readonly node: 'all_of';
  readonly of: readonly Predicate[];
}
export interface AnyOfNode {
  readonly node: 'any_of';
  readonly of: readonly Predicate[];
}
/** The ONE place negation lives. `not` in the design's `none_of` spelling. */
export interface NoneOfNode {
  readonly node: 'none_of';
  readonly of: readonly Predicate[];
}

export type BooleanNode = AllOfNode | AnyOfNode | NoneOfNode;
export type Predicate = Leaf | BooleanNode;

/** A leaf whose comparator IS the whole predicate, so it carries no literal. */
export function isUnaryLeaf(leaf: Leaf): leaf is UnaryLeaf {
  return leaf.cmp === 'is_true' || leaf.cmp === 'is_false';
}

export function isLeaf(p: Predicate): p is Leaf {
  return p.node === 'leaf';
}
export function isBooleanNode(p: Predicate): p is BooleanNode {
  return p.node === 'all_of' || p.node === 'any_of' || p.node === 'none_of';
}

/* ------------------------------------------------------------------ *
 * The design's shape bounds (design §3.4). These are the design's own
 * figures and are quoted, not invented. CANDIDATE_CEILING is NOT here:
 * the design withdrew that figure, so it is a required argument of the
 * validator with no default (see validate.ts).
 * ------------------------------------------------------------------ */

export const SHAPE_BOUNDS = {
  /** Max nesting depth of boolean nodes. */
  maxDepth: 4,
  /** Max children per boolean node (and the minimum, which is one). */
  minChildren: 1,
  maxChildren: 8,
  /** Max leaves in the whole predicate, bounded separately and absolutely. */
  maxLeaves: 32,
  /** Max elements in an `in` list. */
  maxInElements: 32,
  /** Max serialised definition size, a parser bound checked BEFORE parsing. */
  maxSerialisedBytes: 8 * 1024,
} as const;

/** The design's per-cost-class round-trip bound (design §3.8). */
export const COST_BOUNDS = {
  /** At most one `AUTHORITY_PER_CUSTOMER` leaf in a predicate. */
  maxAuthorityPerCustomerLeaves: 1,
  /** At most four `AUTHORITY_SET` leaves — each is one call, so the bound is on round trips. */
  maxAuthoritySetLeaves: 4,
} as const;

/* ------------------------------------------------------------------ *
 * Pure traversal.
 * ------------------------------------------------------------------ */

/** Every leaf, with the number of `none_of` nodes between it and the root. */
export interface LeafOccurrence {
  readonly leaf: Leaf;
  readonly depth: number;
  readonly negationsAbove: number;
  /** Dotted index path, for naming the offender in a refusal. */
  readonly path: string;
}

export function collectLeaves(p: Predicate): readonly LeafOccurrence[] {
  const out: LeafOccurrence[] = [];
  walk(p, 0, 0, 'root', out);
  return out;
}

function walk(p: Predicate, depth: number, negationsAbove: number, path: string, out: LeafOccurrence[]): void {
  if (isLeaf(p)) {
    out.push({ leaf: p, depth, negationsAbove, path });
    return;
  }
  const nextNegations = p.node === 'none_of' ? negationsAbove + 1 : negationsAbove;
  p.of.forEach((child, i) => {
    walk(child, depth + 1, nextNegations, `${path}.${p.node}[${i}]`, out);
  });
}

/** Leaf count over the whole tree. */
export function leafCount(p: Predicate): number {
  return collectLeaves(p).length;
}

/**
 * Nesting depth measured in BOOLEAN NODES, so a bare leaf has depth 0 and
 * `all_of [ leaf ]` has depth 1. The bound is on how deep the nesting goes, not
 * on how far a leaf sits from the root.
 */
export function nestingDepth(p: Predicate): number {
  if (isLeaf(p)) return 0;
  let deepest = 0;
  for (const child of p.of) {
    const d = nestingDepth(child);
    if (d > deepest) deepest = d;
  }
  return 1 + deepest;
}

/** The multiset of cost classes a predicate's leaves draw on. */
export function costProfile(p: Predicate): { readonly [C in CostClass]: number } {
  const counts: { [C in CostClass]: number } = {
    INDEXED_SCAN: 0,
    JOIN_AGGREGATE: 0,
    AUTHORITY_SET: 0,
    AUTHORITY_PER_CUSTOMER: 0,
  };
  for (const occ of collectLeaves(p)) {
    counts[costClassOf(occ.leaf.attr)] += 1;
  }
  return counts;
}

/** Distinct authorities a predicate would have to call. */
export function authoritiesUsed(p: Predicate): readonly AuthorityName[] {
  const seen = new Set<AuthorityName>();
  for (const occ of collectLeaves(p)) seen.add(specFor(occ.leaf.attr).authority);
  return [...seen];
}
