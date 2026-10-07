/**
 * DAFTAR Phase 12 — the authority seam.
 *
 * SCOPE LIMIT (standing law PART E, and the Phase 4 coordinator's narrowing of 2026-10-07): Phase 12
 * does NOT define a permission model, does not name permission keys, and makes no statement about
 * what any role can see. The row-security and permission truth is the security authority's, and it
 * is under repair.
 *
 * So this file defines a SEAM, not a model: an interface Phase 12 will call once the authority
 * exists, and a fail-closed default until then. The requirement Phase 12 states — and does not
 * answer — is in P12-S0-ARCHITECTURE-CONTRACT §3 as an open question.
 *
 * STATUS: PREPARED / NOT PROMOTED.
 */

/**
 * Answers "does this actor hold this authority?" — where the authority's identity, vocabulary and
 * evaluation are entirely the security authority's to define.
 *
 * Deliberately string-keyed and deliberately opaque to this package: Phase 12 passes a key through
 * and reads a boolean. It never constructs, copies, widens or interprets an authority, so it cannot
 * become a second authority.
 */
export interface AuthorityOracle {
  holds(authorityKey: string): boolean;
}

/**
 * The default oracle until the security authority supplies one: it holds nothing.
 *
 * This is the fail-closed half of the design. Combined with every tool's authority binding being
 * `unbound` (see `tool-registry.ts`), the assistant currently grants nothing at all — which is the
 * correct state for a phase whose authority model has not been decided.
 */
export function denyAllAuthority(): AuthorityOracle {
  return {
    holds(): boolean {
      return false;
    },
  };
}

/**
 * Wrap an evaluator supplied by the platform at wiring time.
 *
 * `evaluate` is whatever the security authority exposes. Phase 12 asserts nothing about what it
 * returns for any key; it only requires that a `false` is honoured as a refusal.
 */
export function fromEvaluator(evaluate: (authorityKey: string) => boolean): AuthorityOracle {
  return {
    holds(authorityKey: string): boolean {
      return evaluate(authorityKey) === true;
    },
  };
}

/** Test seam: an oracle over an explicit set of keys. Never a production construction. */
export function oracleFromKeys(keys: Iterable<string>): AuthorityOracle {
  const set = new Set<string>(keys);
  return {
    holds(authorityKey: string): boolean {
      return set.has(authorityKey);
    },
  };
}
