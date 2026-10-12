/**
 * P13-S5 — the segment predicate VALIDATOR.
 *
 * It decides ADMISSIBILITY and refuses otherwise. It never degrades, never
 * truncates, never samples, never evaluates over "the first page", and never
 * loops over customers to serve an expensive leaf. A predicate the reader cannot
 * serve inside its cost bound is a named refusal (design §3.8).
 *
 * THE FOUR LAWS THIS FILE IS ACCOUNTABLE FOR
 *
 *  1. A SEGMENT IS NEVER A PERMISSION BOUNDARY (design §4). Nothing here returns
 *     a grant, a role, a permission key or a boolean that could be read as one.
 *     Success is a `PredicateAdmission` whose own fields say, at the type level,
 *     that it confers nothing; see the note on that interface.
 *  2. FAIL CLOSED. Every exit from this module is either an admission or a
 *     throw. There is no `false`, no `null` and no partial result to mistake for
 *     an answer.
 *  3. CONSENT: ONLY A POSITIVE STATE (design §4.0.1). The absence-shaped count is
 *     not in the registry at all, so it is unrepresentable rather than guarded;
 *     and a positive consent leaf under a `none_of` is refused, because negating
 *     it reconstructs the absence predicate.
 *  4. NO FINANCIAL RE-DERIVATION IN CRM. A money leaf may only reference a figure
 *     the owning authority returns.
 *
 * REFUSAL CODES, and a disagreement with the design recorded rather than papered
 * over: design §3.4/§3.8/§7 name a `segment.*` refusal namespace
 * (`segment.predicate_too_complex`, `segment.attribute_unknown`,
 * `segment.operator_not_applicable`, `segment.literal_invalid`,
 * `segment.predicate_not_servable`). The live catalogue in `src/errors.ts` has
 * none of those; it has `analytics.predicate_not_servable`
 * (`src/errors.ts:36-37`, and the spelling is now aligned on "servable"). That
 * file is not this agent's to edit, so every admissibility refusal here is
 * raised as `analytics.predicate_not_servable` and carries the design's own
 * code in `context.designCode`, so that the specific law is still named in the
 * refusal and a later catalogue entry is a rename and not a rediscovery.
 */

import { refuse } from '../errors';
import {
  type AttrName,
  type AttributeSpec,
  type AuthorityName,
  type CostClass,
  type Leaf,
  type LeafOccurrence,
  type Literal,
  type Predicate,
  COST_BOUNDS,
  SHAPE_BOUNDS,
  collectLeaves,
  comparatorAppliesTo,
  costClassOf,
  costProfile,
  isNarrowingClass,
  isRegisteredAttr,
  isUnaryLeaf,
  nestingDepth,
  specFor,
} from './predicate';

/* ------------------------------------------------------------------ *
 * The caller's inputs.
 * ------------------------------------------------------------------ */

/**
 * The cost bound the design leaves to MEASUREMENT.
 *
 * `candidateCeiling` has NO DEFAULT and no fallback constant beside it. The
 * design proposed a figure here and then withdrew it: an arbitrary numeric
 * production limit is the Performance owner's to calibrate on the authoritative
 * box, and an unmeasured figure standing next to a mechanism is what a later
 * implementer lifts as a default. So it is a required argument, an unconfigured
 * bound means REFUSE, and it never means UNBOUNDED.
 */
export interface CostBoundConfig {
  readonly candidateCeiling: number;
}

/**
 * Which owning authorities can actually be called.
 *
 * MEASURED, 2026-10-12, by `git grep` over this branch: the Phase 4 customers,
 * sales and receivables modules and their canonical readers are NOT present on
 * `main`, which is the same measurement `src/ports.ts:5-16` already records for
 * the read ports. There is therefore no marketing-consent relation either. So
 * presence is an injected fact and the fail-closed default below says "absent",
 * because a stub that answers zero is the dangerous option: zero is a number,
 * and a number reaches a screen.
 */
export type AuthorityPresence = { readonly [A in AuthorityName]: boolean };

/** The fail-closed presence map. Nothing is present; every leaf refuses. */
export const NO_AUTHORITY_PRESENT: AuthorityPresence = {
  customers_own_columns: false,
  customer_contacts: false,
  sales_activity: false,
  receivables: false,
  marketing_consent: false,
} as const;

export interface ValidationInput {
  /** Required. No default; absent or non-positive ⇒ refuse. */
  readonly bounds: CostBoundConfig;
  /**
   * The size of the candidate set the predicate's NARROWING leaves leave behind,
   * established positively under the stated visibility scope by the caller.
   * Required when the predicate carries an `AUTHORITY_PER_CUSTOMER` leaf;
   * without it the cost of that leaf is unknown, and an unknown cost is refused.
   */
  readonly narrowedCandidateCount?: number;
  /** The segment's own stored bucket-days policy, when a leaf needs one. */
  readonly bucketDays?: readonly number[];
}

/* ------------------------------------------------------------------ *
 * The result.
 * ------------------------------------------------------------------ */

/**
 * The admission certificate.
 *
 * WHY IT IS SHAPED LIKE THIS. The most natural-feeling shortcut in the phase is
 * to treat "this predicate validated" or "this customer is a member" as
 * permission to do something. So the success value is deliberately not a
 * boolean, not a truthy handle and not a token: it is a record that states its
 * own three negations, and the two `never`-typed fields below make the mistake a
 * COMPILE error rather than a code-review topic — `cert.authorityDecision = true`
 * does not typecheck, and `if (cert.grantedPermissions.includes(k))` does not
 * either. There is no function in this module that returns a permission, a role,
 * a `TrustedRoleSet` or a boolean named like a decision.
 */
export interface PredicateAdmission {
  readonly kind: 'segment_predicate_admission';
  /** A segment answers *who*. The permission registry answers *whether you may*. */
  readonly confersAuthority: false;
  readonly isPermissionBoundary: false;
  /** Suppression is enforced per recipient on the send path, which this cannot reach. */
  readonly isSuppressionMechanism: false;
  readonly predicate: Predicate;
  readonly leafCount: number;
  readonly nestingDepth: number;
  readonly costProfile: { readonly [C in CostClass]: number };
  readonly authoritiesRequired: readonly AuthorityName[];
  readonly candidateCeilingApplied: number;
  /** Never set. Present so that writing to it does not compile. */
  readonly authorityDecision?: never;
  /** Never set. Present so that reading it as a grant list does not compile. */
  readonly grantedPermissions?: never;
}

/** The design's own refusal codes, carried in a refusal's context. */
export type SegmentDesignCode =
  | 'segment.predicate_too_complex'
  | 'segment.attribute_unknown'
  | 'segment.operator_not_applicable'
  | 'segment.literal_invalid'
  | 'segment.predicate_not_servable';

function refuseAdmissibility(designCode: SegmentDesignCode, message: string, context: Record<string, string> = {}): never {
  refuse('analytics.predicate_not_servable', message, { designCode, ...context });
}

function refuseAbsentAuthority(message: string, context: Record<string, string> = {}): never {
  refuse('analytics.waiting_for_integrated_surface', message, context);
}

/* ------------------------------------------------------------------ *
 * The validator.
 * ------------------------------------------------------------------ */

/**
 * Decide admissibility, or refuse.
 *
 * The order is load-bearing and runs cheapest-and-most-fail-closed first: the
 * cost configuration, then the shape bounds, then each leaf's attribute,
 * comparator and literal, then the laws about meaning (consent polarity, money
 * origin), then the cost model. A predicate that cannot be bounded cannot be
 * costed, and a predicate that cannot be costed cannot be refused on cost — so
 * the shape bounds come before the cost model, not after it.
 */
export function validatePredicate(predicate: Predicate, input: ValidationInput): PredicateAdmission {
  const ceiling = requireCandidateCeiling(input);

  assertShapeBounds(predicate);

  const occurrences = collectLeaves(predicate);
  for (const occ of occurrences) {
    const spec = assertRegisteredAttribute(occ.leaf, occ.path);
    assertComparatorApplies(occ.leaf, spec, occ.path);
    assertLiteralValid(occ.leaf, spec, occ.path);
    assertPolarityAdmissible(occ, spec);
    assertNoFinancialRederivation(occ.leaf.attr, spec);
    assertPolicyPresent(occ.leaf.attr, spec, input);
  }

  assertCostAdmissible(predicate, occurrences, ceiling, input);

  return Object.freeze({
    kind: 'segment_predicate_admission' as const,
    confersAuthority: false as const,
    isPermissionBoundary: false as const,
    isSuppressionMechanism: false as const,
    predicate,
    leafCount: occurrences.length,
    nestingDepth: nestingDepth(predicate),
    costProfile: costProfile(predicate),
    authoritiesRequired: [...new Set(occurrences.map((o) => specFor(o.leaf.attr).authority))],
    candidateCeilingApplied: ceiling,
  });
}

/**
 * Admissible AND servable on this branch.
 *
 * Kept separate from admissibility on purpose: whether a predicate is a legal
 * audience definition is a property of the predicate, while whether its
 * authority exists is a property of the tree we are standing in. Folding the two
 * together is how an absent authority turns into a zero.
 */
export function validateAndRequireAuthorities(predicate: Predicate, input: ValidationInput, presence: AuthorityPresence): PredicateAdmission {
  const admission = validatePredicate(predicate, input);
  for (const authority of admission.authoritiesRequired) {
    if (!presence[authority]) {
      refuseAbsentAuthority(`the ${authority} read authority is not present on this branch, so this predicate resolves to a refusal and not to a zero`, {
        authority,
      });
    }
  }
  return admission;
}

/* ------------------------------------------------------------------ *
 * 1. The configured bound.
 * ------------------------------------------------------------------ */

function requireCandidateCeiling(input: ValidationInput): number {
  const bounds: CostBoundConfig | undefined = input?.bounds;
  const ceiling: unknown = bounds?.candidateCeiling;
  if (typeof ceiling !== 'number' || !Number.isInteger(ceiling) || ceiling <= 0) {
    refuseAdmissibility(
      'segment.predicate_not_servable',
      'no candidate ceiling was supplied; the bound is a configuration input calibrated by measurement, it has no default, and an unconfigured bound means refuse and never unbounded',
      { bound: 'candidateCeiling', supplied: String(ceiling) },
    );
  }
  return ceiling;
}

/* ------------------------------------------------------------------ *
 * 2. Shape bounds (design §3.4), at parse time, before any SQL exists.
 * ------------------------------------------------------------------ */

function assertShapeBounds(predicate: Predicate): void {
  const depth = nestingDepth(predicate);
  if (depth > SHAPE_BOUNDS.maxDepth) {
    refuseAdmissibility('segment.predicate_too_complex', 'the predicate nests deeper than the depth bound', {
      bound: 'maxDepth',
      limit: String(SHAPE_BOUNDS.maxDepth),
      actual: String(depth),
    });
  }

  assertArity(predicate, 'root');

  const leaves = collectLeaves(predicate).length;
  if (leaves > SHAPE_BOUNDS.maxLeaves) {
    refuseAdmissibility('segment.predicate_too_complex', 'the predicate carries more leaves than the leaf bound', {
      bound: 'maxLeaves',
      limit: String(SHAPE_BOUNDS.maxLeaves),
      actual: String(leaves),
    });
  }
}

function assertArity(p: Predicate, path: string): void {
  if (p.node === 'leaf') {
    if (p.cmp === 'in') {
      const n = p.value.length;
      if (n < 1 || n > SHAPE_BOUNDS.maxInElements) {
        refuseAdmissibility('segment.predicate_too_complex', 'an `in` list is outside the element bound', {
          bound: 'maxInElements',
          limit: String(SHAPE_BOUNDS.maxInElements),
          actual: String(n),
          path,
        });
      }
    }
    return;
  }
  const n = p.of.length;
  if (n < SHAPE_BOUNDS.minChildren || n > SHAPE_BOUNDS.maxChildren) {
    refuseAdmissibility('segment.predicate_too_complex', 'a boolean node is outside the child-count bound', {
      bound: 'maxChildren',
      limit: String(SHAPE_BOUNDS.maxChildren),
      actual: String(n),
      path,
    });
  }
  p.of.forEach((child, i) => assertArity(child, `${path}.${p.node}[${i}]`));
}

/**
 * The parser bound, checked BEFORE parsing. Our own storage is not a trust
 * boundary: a stored definition is revalidated through this identical path on
 * every single evaluation and is never evaluated from its stored form.
 */
export function validateSerialisedDefinition(serialised: string, input: ValidationInput): PredicateAdmission {
  const bytes = utf8ByteLength(serialised);
  if (bytes > SHAPE_BOUNDS.maxSerialisedBytes) {
    refuseAdmissibility('segment.predicate_too_complex', 'the serialised definition is larger than the parser bound', {
      bound: 'maxSerialisedBytes',
      limit: String(SHAPE_BOUNDS.maxSerialisedBytes),
      actual: String(bytes),
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialised);
  } catch {
    refuseAdmissibility('segment.literal_invalid', 'the serialised definition is not well-formed JSON');
  }
  return validatePredicate(parseUnknownPredicate(parsed, 'root'), input);
}

/** UTF-8 byte length, computed without a platform global. */
function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) bytes += 1;
    else if (cp < 0x800) bytes += 2;
    else if (cp < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/**
 * Structural parse of an untrusted value into the AST. Refuses anything that is
 * not exactly one of the four node shapes; in particular there is no field whose
 * value could reach query text, so an unexpected key is a refusal and not a
 * passenger.
 */
export function parseUnknownPredicate(value: unknown, path: string): Predicate {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    refuseAdmissibility('segment.literal_invalid', 'a predicate node must be an object', { path });
  }
  const rec = value as Record<string, unknown>;
  const node = rec['node'];
  if (node === 'all_of' || node === 'any_of' || node === 'none_of') {
    const of = rec['of'];
    if (!Array.isArray(of)) {
      refuseAdmissibility('segment.literal_invalid', 'a boolean node must carry an `of` array', { path, node });
    }
    const children = (of as unknown[]).map((child, i) => parseUnknownPredicate(child, `${path}.${node}[${i}]`));
    if (node === 'all_of') return { node, of: children };
    if (node === 'any_of') return { node, of: children };
    return { node, of: children };
  }
  if (node !== 'leaf') {
    refuseAdmissibility('segment.literal_invalid', 'a predicate node must be a leaf or one of the three boolean nodes', {
      path,
      node: String(node),
    });
  }
  const attr = rec['attr'];
  if (typeof attr !== 'string' || !isRegisteredAttr(attr)) {
    refuseAdmissibility('segment.attribute_unknown', 'the attribute is not in the closed registry', {
      path,
      attr: String(attr),
    });
  }
  const cmp = rec['cmp'];
  if (typeof cmp !== 'string') {
    refuseAdmissibility('segment.operator_not_applicable', 'the comparator is missing', { path, attr });
  }
  const leaf = { node: 'leaf' as const, attr, cmp, value: rec['value'] } as unknown as Leaf;
  // The comparator and literal are checked against the attribute's own type by
  // the ordinary validation path, so the parse does not duplicate the matrix.
  return leaf;
}

/* ------------------------------------------------------------------ *
 * 3. Attribute, comparator and literal.
 * ------------------------------------------------------------------ */

function assertRegisteredAttribute(leaf: Leaf, path: string): AttributeSpec {
  if (!isRegisteredAttr(leaf.attr)) {
    refuseAdmissibility('segment.attribute_unknown', 'the attribute is not in the closed registry', {
      path,
      attr: String(leaf.attr),
    });
  }
  return specFor(leaf.attr);
}

function assertComparatorApplies(leaf: Leaf, spec: AttributeSpec, path: string): void {
  if (!comparatorAppliesTo(spec.type, leaf.cmp)) {
    refuseAdmissibility('segment.operator_not_applicable', 'the comparator does not apply to the attribute type', {
      path,
      attr: leaf.attr,
      type: spec.type,
      cmp: leaf.cmp,
    });
  }
}

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Money is a decimal STRING end to end; a `number` on a money path has already lost the value. */
const MONEY_MINOR = /^-?\d{1,19}$/;

function assertLiteralValid(leaf: Leaf, spec: AttributeSpec, path: string): void {
  if (isUnaryLeaf(leaf)) {
    const carried: unknown = (leaf as Leaf & { value?: unknown }).value;
    if (carried !== undefined) {
      refuseAdmissibility('segment.literal_invalid', 'a bool comparator is the whole predicate and carries no value', {
        path,
        attr: leaf.attr,
      });
    }
    return;
  }
  if (leaf.cmp === 'between') {
    const pair = leaf.value as unknown as Literal[];
    if (!Array.isArray(pair) || pair.length !== 2) {
      refuseAdmissibility('segment.literal_invalid', '`between` takes exactly two literals', { path, attr: leaf.attr });
    }
    for (const v of pair) assertScalarLiteral(v, spec, leaf.attr, path);
    return;
  }
  if (leaf.cmp === 'in') {
    const list = leaf.value as unknown as Literal[];
    if (!Array.isArray(list)) {
      refuseAdmissibility('segment.literal_invalid', '`in` takes a list of literals', { path, attr: leaf.attr });
    }
    for (const v of list) assertScalarLiteral(v, spec, leaf.attr, path);
    return;
  }
  assertScalarLiteral(leaf.value, spec, leaf.attr, path);
}

function assertScalarLiteral(value: Literal | undefined, spec: AttributeSpec, attr: AttrName, path: string): void {
  const bad: (why: string) => never = (why) => refuseAdmissibility('segment.literal_invalid', why, { path, attr, type: spec.type, value: String(value) });

  switch (spec.type) {
    case 'enum': {
      if (typeof value !== 'string') bad('an enum literal must be a string');
      const members = spec.enumMembers ?? [];
      if (!members.includes(value as string)) {
        bad('the enum literal is not an admissible member of this attribute');
      }
      return;
    }
    case 'civil_date': {
      if (typeof value !== 'string' || !CIVIL_DATE.test(value)) bad('a civil date literal must be YYYY-MM-DD');
      const d = new Date(`${value as string}T00:00:00Z`);
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) bad('the civil date is not a real date');
      return;
    }
    case 'count': {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        bad('a count literal must be a non-negative integer');
      }
      return;
    }
    case 'money_minor': {
      if (typeof value === 'number') bad('a money literal must never arrive as a number; it is a decimal string end to end');
      if (typeof value !== 'string' || !MONEY_MINOR.test(value)) bad('a money literal must be a decimal minor-unit string');
      return;
    }
    case 'bool': {
      bad('a bool attribute takes no literal');
      return;
    }
    /* istanbul ignore next -- the switch is total over AttributeType */
    default:
      bad('unhandled attribute type');
  }
}

/* ------------------------------------------------------------------ *
 * 4. The laws about MEANING.
 * ------------------------------------------------------------------ */

/**
 * CONSENT POLARITY.
 *
 * The absence-shaped consent predicate — a count of opt-outs equal to zero — is
 * not in the registry at all, so it refuses as an unknown attribute: it is
 * unrepresentable rather than guarded, and a law enforced by non-existence has
 * no branch to get wrong.
 *
 * What remains is the case THE DESIGN DOES NOT SETTLE: a `none_of` wrapped around
 * the admissible positive leaf. Design §3.3.3 puts all negation in `none_of` and
 * §4.0.1 argues only about the leaf standing alone, so the composition is
 * unaddressed. This is the CONSERVATIVE READING, and here is the argument for
 * it: `none_of [ {consent.state, eq, 'opted_in'} ]` is "not opted in", which is
 * an assertion that a thing was not found. Under partial visibility the consent
 * row is invisible, the leaf reads false, the negation reads true, and the
 * customer lands IN the audience — the failure direction is SEND, which is
 * exactly the direction §4.0.1 refuses the count for. So a positive-polarity-only
 * attribute is refused under any number of negations above it, even an even
 * number: a double negation of a consent leaf is the same audience by a longer
 * road, and admitting it would make the law depend on counting parity.
 */
function assertPolarityAdmissible(occ: LeafOccurrence, spec: AttributeSpec): void {
  if (spec.positivePolarityOnly !== true) return;
  if (occ.negationsAbove === 0) return;
  refuseAdmissibility(
    'segment.predicate_not_servable',
    'this attribute is admissible only as a positive, audience-narrowing state; negating it rebuilds the absence-shaped predicate whose failure direction is send, and in no form is a segment the suppression mechanism',
    {
      attr: occ.leaf.attr,
      path: occ.path,
      negationsAbove: String(occ.negationsAbove),
      law: 'consent.positive_state_only',
    },
  );
}

/**
 * NO FINANCIAL RE-DERIVATION IN CRM.
 *
 * Exported because the red proof needs to feed it a planted spec: the law has to
 * be a branch that can be shown to fire, not a registry that happens to contain
 * no offender today. A money attribute whose figure Phase 13 would compute
 * itself is refused; only `authority_reported` passes.
 */
export function assertNoFinancialRederivation(attr: string, spec: AttributeSpec): void {
  if (spec.type !== 'money_minor') return;
  const origin = spec.moneyOrigin;
  if (origin === undefined) {
    refuseAdmissibility('segment.predicate_not_servable', 'a money attribute must declare the authority that reports it', {
      attr,
      law: 'no_financial_rederivation',
    });
  }
  if (origin.kind !== 'authority_reported') {
    refuseAdmissibility(
      'segment.predicate_not_servable',
      'a CRM predicate may not recompute a money figure; it may only reference a figure the owning authority returns',
      { attr, origin: origin.kind, law: 'no_financial_rederivation' },
    );
  }
}

/** A leaf that is meaningless without the segment's own policy is refused without it. */
function assertPolicyPresent(attr: AttrName, spec: AttributeSpec, input: ValidationInput): void {
  if (spec.requiresBucketDaysPolicy !== true) return;
  const policy = input.bucketDays;
  if (policy === undefined || policy.length === 0) {
    refuseAdmissibility(
      'segment.predicate_not_servable',
      'this attribute means nothing without the segment’s own stored bucket-days policy, so a leaf naming it is refused rather than approximated',
      { attr, law: 'bucket_days_required' },
    );
  }
}

/* ------------------------------------------------------------------ *
 * 5. The cost model (design §3.8).
 * ------------------------------------------------------------------ */

function assertCostAdmissible(predicate: Predicate, occurrences: readonly LeafOccurrence[], ceiling: number, input: ValidationInput): void {
  const profile = costProfile(predicate);

  if (profile.AUTHORITY_SET > COST_BOUNDS.maxAuthoritySetLeaves) {
    refuseAdmissibility('segment.predicate_not_servable', 'the predicate issues more set-based authority calls than the round-trip bound', {
      costClass: 'AUTHORITY_SET',
      limit: String(COST_BOUNDS.maxAuthoritySetLeaves),
      actual: String(profile.AUTHORITY_SET),
    });
  }

  const perCustomer = occurrences.filter((o) => costClassOf(o.leaf.attr) === 'AUTHORITY_PER_CUSTOMER');
  if (perCustomer.length === 0) return;

  if (perCustomer.length > COST_BOUNDS.maxAuthorityPerCustomerLeaves) {
    refuseAdmissibility(
      'segment.predicate_not_servable',
      'a predicate may carry at most one per-customer authority leaf; more would be a round-trip storm, and the honest options are to loop or to refuse',
      {
        costClass: 'AUTHORITY_PER_CUSTOMER',
        limit: String(COST_BOUNDS.maxAuthorityPerCustomerLeaves),
        actual: String(perCustomer.length),
        attrs: perCustomer.map((o) => o.leaf.attr).join(','),
      },
    );
  }

  const only = perCustomer[0];
  /* istanbul ignore if -- length was just checked to be exactly one */
  if (only === undefined) return;

  // The narrowing must actually narrow. A disjunction above the expensive leaf
  // widens the candidate set rather than narrowing it, and a negation inverts
  // the narrowing, so a per-customer leaf is admissible only in conjunctive
  // position. The design states the bound and not this reading of "the
  // predicate's other leaves narrow"; this is the conservative one.
  if (!isConjunctiveOnly(predicate, only.leaf)) {
    refuseAdmissibility(
      'segment.predicate_not_servable',
      'a per-customer authority leaf is admissible only in conjunctive position, because a disjunction or a negation above it does not narrow the candidate set',
      { attr: only.leaf.attr, path: only.path },
    );
  }

  const narrowingLeaves = occurrences.filter((o) => isNarrowingClass(costClassOf(o.leaf.attr)));
  if (narrowingLeaves.length === 0) {
    refuseAdmissibility(
      'segment.predicate_not_servable',
      'a per-customer authority leaf requires at least one narrowing leaf of an indexed or join-aggregate class, because a narrowing step that is itself per-customer is the thing being bounded',
      { attr: only.leaf.attr },
    );
  }

  const count: unknown = input.narrowedCandidateCount;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
    refuseAdmissibility(
      'segment.predicate_not_servable',
      'the narrowed candidate count was not established, so the cost of the per-customer leaf is unknown; an unknown cost is refused and never attempted',
      { attr: only.leaf.attr, supplied: String(count) },
    );
  }
  if (count > ceiling) {
    refuseAdmissibility(
      'segment.predicate_not_servable',
      'the narrowed candidate set exceeds the configured candidate ceiling, so this predicate is refused rather than evaluated over a sample, a page, or the branches the actor happens to see',
      { attr: only.leaf.attr, ceiling: String(ceiling), candidates: String(count) },
    );
  }
}

/** True when the leaf sits under `all_of` nodes only, all the way to the root. */
function isConjunctiveOnly(root: Predicate, target: Leaf): boolean {
  const search = (p: Predicate, conjunctive: boolean): boolean => {
    if (p.node === 'leaf') return p === target ? conjunctive : false;
    const stillConjunctive = conjunctive && p.node === 'all_of';
    return p.of.some((child) => search(child, stillConjunctive));
  };
  if (root.node === 'leaf') return root === target;
  return search(root, true);
}
