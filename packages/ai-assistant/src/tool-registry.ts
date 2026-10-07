/**
 * DAFTAR Phase 12 — the tool registry and its gate.
 *
 * P12-TOOL-REGISTRY-SPEC. The registry is a CLOSED set: a tool not listed here does not exist, and a
 * call naming one refuses `ai_tool.not_registered`.
 *
 * SCOPE LIMIT (standing law PART E; Phase 4 coordinator narrowing 2026-10-07): Phase 12 names no
 * permission key and states nothing about what a role can see. Every tool's authority binding is
 * therefore `unbound`, and an unbound tool is UNREACHABLE: the gate refuses it. When the security
 * authority supplies the vocabulary, binding a tool is a visible, reviewable change to this file —
 * not a default that quietly became permissive.
 *
 * Two structural facts carry the security of this layer:
 *   1. `plane` has exactly two values. There is no 'write'. A write tool cannot be added without
 *      changing this type.
 *   2. The gate at dispatch is authoritative; which tools were DESCRIBED to the model is not. A
 *      precondition at a call site is not a property of the function.
 *
 * STATUS: PREPARED / NOT PROMOTED.
 */

import { type AuthorityOracle } from './authority';
import { allow, deny, refuse, type Decision } from './refusals';

/** There is no 'write'. See the contract §2.1. */
export type Plane = 'read' | 'draft';

/** Which phase owns the underlying capability. Confined by a guard to this list. */
export const SURFACES = ['phase1.catalog', 'phase2.accounting', 'phase3.inventory', 'phase3.purchasing', 'phase4.sales', 'phase12.assistant'] as const;
export type SurfaceId = (typeof SURFACES)[number];

/**
 * 'waiting' means the owning phase's command/read surface is not integrated on this base. Such a
 * tool is DECLARED but unreachable: it refuses `ai_tool.surface_unavailable`.
 */
export type SurfaceState = 'integrated' | 'waiting';

/**
 * The authority a tool requires, as a binding that is explicitly UNRESOLVED until the security
 * authority decides it.
 *
 * `unbound` is not a placeholder to be filled in by whoever is passing: it is a refusal state. The
 * alternative — a plausible-looking key list written now — would be the "dead constant authority"
 * defect: a declaration that looks like an authority check and checks nothing.
 */
export type AuthorityBinding = { readonly state: 'unbound'; readonly reason: string } | { readonly state: 'bound'; readonly keys: readonly string[] };

export interface ToolSpec {
  readonly name: string;
  readonly plane: Plane;
  readonly surface: SurfaceId;
  readonly surfaceState: SurfaceState;
  readonly authority: AuthorityBinding;
}

const AUTHORITY_PENDING: AuthorityBinding = {
  state: 'unbound',
  reason: 'authority vocabulary is the security authority’s; Phase 12 states the requirement and does not answer it',
};

/**
 * The registry: what the assistant may ever be able to do, as identities and planes.
 *
 * Every entry is `unbound`, so the gate currently refuses every tool. That is the intended state of
 * a prepared, unpromoted phase whose authority model is open.
 */
export const TOOL_REGISTRY: readonly ToolSpec[] = [
  // ---- read plane ---------------------------------------------------------
  { name: 'product.search', plane: 'read', surface: 'phase1.catalog', surfaceState: 'integrated', authority: AUTHORITY_PENDING },
  { name: 'product.price.read', plane: 'read', surface: 'phase1.catalog', surfaceState: 'integrated', authority: AUTHORITY_PENDING },
  { name: 'stock.onhand.read', plane: 'read', surface: 'phase3.inventory', surfaceState: 'integrated', authority: AUTHORITY_PENDING },
  { name: 'supplier.search', plane: 'read', surface: 'phase3.purchasing', surfaceState: 'integrated', authority: AUTHORITY_PENDING },
  { name: 'purchase.read', plane: 'read', surface: 'phase3.purchasing', surfaceState: 'integrated', authority: AUTHORITY_PENDING },
  { name: 'accounting.balance.read', plane: 'read', surface: 'phase2.accounting', surfaceState: 'integrated', authority: AUTHORITY_PENDING },
  { name: 'ai.draft.list', plane: 'read', surface: 'phase12.assistant', surfaceState: 'integrated', authority: AUTHORITY_PENDING },
  { name: 'customer.search', plane: 'read', surface: 'phase4.sales', surfaceState: 'waiting', authority: AUTHORITY_PENDING },
  { name: 'customer.balance.read', plane: 'read', surface: 'phase4.sales', surfaceState: 'waiting', authority: AUTHORITY_PENDING },
  { name: 'invoice.read', plane: 'read', surface: 'phase4.sales', surfaceState: 'waiting', authority: AUTHORITY_PENDING },

  // ---- draft plane --------------------------------------------------------
  { name: 'purchase.draft', plane: 'draft', surface: 'phase3.purchasing', surfaceState: 'integrated', authority: AUTHORITY_PENDING },
  { name: 'stock.adjust.draft', plane: 'draft', surface: 'phase3.inventory', surfaceState: 'integrated', authority: AUTHORITY_PENDING },
  { name: 'stock.transfer.draft', plane: 'draft', surface: 'phase3.inventory', surfaceState: 'integrated', authority: AUTHORITY_PENDING },
  { name: 'sale.draft', plane: 'draft', surface: 'phase4.sales', surfaceState: 'waiting', authority: AUTHORITY_PENDING },
  { name: 'payment.receive.draft', plane: 'draft', surface: 'phase4.sales', surfaceState: 'waiting', authority: AUTHORITY_PENDING },
  { name: 'return.draft', plane: 'draft', surface: 'phase4.sales', surfaceState: 'waiting', authority: AUTHORITY_PENDING },
];

export function lookupTool(name: string): ToolSpec | undefined {
  return TOOL_REGISTRY.find((t) => t.name === name);
}

// ---------------------------------------------------------------------------
// Registry validation
// ---------------------------------------------------------------------------

export type RegistryViolationKind = 'empty_keys' | 'duplicate_name' | 'unknown_surface';

export interface RegistryViolation {
  readonly kind: RegistryViolationKind;
  readonly tool: string;
}

/**
 * Structural validation that holds regardless of the authority model.
 *
 * `empty_keys` catches a binding declared `bound` with an empty key list — which would make
 * `keys.every(...)` vacuously true and enable the tool for every actor. That is the vacuous-green
 * shape in the one place where it is a privilege bug rather than a test bug.
 *
 * Returns EVERY violation, not the first: a validator that stops at one defect lets the rest hide.
 */
export function validateRegistry(specs: readonly ToolSpec[]): RegistryViolation[] {
  const violations: RegistryViolation[] = [];
  const seen = new Set<string>();
  for (const spec of specs) {
    if (seen.has(spec.name)) violations.push({ kind: 'duplicate_name', tool: spec.name });
    seen.add(spec.name);
    if (!(SURFACES as readonly string[]).includes(spec.surface)) violations.push({ kind: 'unknown_surface', tool: spec.name });
    if (spec.authority.state === 'bound' && spec.authority.keys.length === 0) violations.push({ kind: 'empty_keys', tool: spec.name });
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Per-turn tool-set computation
// ---------------------------------------------------------------------------

/**
 * The frozen set of tools described to the model for one turn.
 *
 * An unbound tool is never enabled, whatever the oracle says. A bound tool with an empty key list is
 * never enabled either (the vacuous-`every` hazard above).
 */
export function computeEnabledTools(specs: readonly ToolSpec[], authority: AuthorityOracle): readonly ToolSpec[] {
  return Object.freeze(
    specs.filter((t) => {
      if (t.surfaceState !== 'integrated') return false;
      if (t.authority.state !== 'bound') return false;
      if (t.authority.keys.length === 0) return false;
      return t.authority.keys.every((k) => authority.holds(k));
    }),
  );
}

// ---------------------------------------------------------------------------
// Dispatch gate — this is the authoritative check
// ---------------------------------------------------------------------------

/**
 * Decide whether one tool call may dispatch.
 *
 * Deliberately does NOT take the enabled set: it re-derives the verdict. "The model was never told
 * about this tool" is a property of prompt assembly, which is one bug away from being false; this
 * function is the property of the dispatcher.
 */
export function gateToolCall(name: string, authority: AuthorityOracle): Decision<ToolSpec> {
  const spec = lookupTool(name);
  if (spec === undefined) return deny(refuse('ai_tool.not_registered', { detail: name }));
  if (spec.surfaceState === 'waiting') return deny(refuse('ai_tool.surface_unavailable', { detail: name }));
  if (spec.authority.state !== 'bound') return deny(refuse('ai_tool.authority_unbound', { detail: name }));
  if (spec.authority.keys.length === 0) return deny(refuse('ai_tool.authority_unbound', { detail: name }));
  for (const key of spec.authority.keys) {
    if (!authority.holds(key)) return deny(refuse('ai_tool.not_permitted', { detail: name, field: key }));
  }
  return allow(spec);
}

/**
 * Argument validation: an unknown field is a refusal, never ignored.
 *
 * Silently dropping an unexpected field is how an injected argument becomes invisible rather than
 * refused, so the unknown-field branch is the point of this function, not a courtesy.
 */
export function validateArgs(allowedFields: readonly string[], args: Readonly<Record<string, unknown>>): Decision<true> {
  const allowed = new Set(allowedFields);
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) return deny(refuse('ai_tool.args_invalid', { field: key, detail: 'unknown field' }));
  }
  return allow(true);
}
