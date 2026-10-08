/**
 * THE ONE DECLARATION OF THE GRANTED EVIDENCE LEVEL.
 *
 * ## The failure this module exists to prevent
 *
 * `tests/integration/p4s6-level-f-spec-executed.test.ts` gated its thirteen
 * live-database cases on `process.env['P4S6_LEVEL_F'] === '1'`, and that
 * string existed in exactly one file in the repository. The rationale was
 * correct — the coordinator's standing ruling puts S6 at levels A-E, and a
 * level-F suite running green in ordinary CI would assert a maturity level
 * nobody granted — but the MECHANISM had no other side:
 *
 * > **When the grant moves to F, nothing reddens and the thirteen cases stay
 * > dark forever.**
 *
 * A ratchet has two sides. A gate that correctly refuses to over-claim today
 * must also stop being skippable the moment the claim becomes true, or the
 * honest default silently becomes a permanent omission. `TL-P4-COORD-R28`
 * recorded this as owed and attributed it to the coordinator, not to S6: the
 * suite's own reasoning was sound, and what was missing was a declared grant
 * for its default to derive from.
 *
 * ## How it works
 *
 * `GRANTED_EVIDENCE_LEVEL` below is the single place the granted level is
 * written. A suite's default is DERIVED from it by `levelDefaultEnabled`, so
 * raising the grant enables every level-gated suite in one edit, and the
 * environment variable survives only as an explicit pre-grant override for
 * the owner who wants to run the cases before the grant exists.
 *
 * `levelDefaultEnabled` takes the granted level as an ARGUMENT rather than
 * reading the constant, so the derivation itself is testable at a level the
 * project has not been granted — otherwise the only case that could exist
 * would be vacuous today and would stay vacuous until the very moment it was
 * supposed to fire.
 */

/** The project's evidence ladder, weakest first. */
export const EVIDENCE_LEVELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;

export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

/**
 * THE GRANTED LEVEL. Coordinator ruling; nothing else may set it.
 *
 * Raising this is the ONLY supported way to enable a level-gated suite by
 * default. Do not add a second constant, and do not read a suite's override
 * variable anywhere but through `levelDefaultEnabled`.
 */
export const GRANTED_EVIDENCE_LEVEL: EvidenceLevel = 'E';

/** True when `granted` reaches `required` on the ladder above. */
export function levelReached(granted: EvidenceLevel, required: EvidenceLevel): boolean {
  return EVIDENCE_LEVELS.indexOf(granted) >= EVIDENCE_LEVELS.indexOf(required);
}

/**
 * Whether a suite requiring `required` runs by default.
 *
 * The grant decides. The override exists only so an owner can run the cases
 * BEFORE the grant moves, and it can never turn a reached grant back off —
 * a gate that the grant has opened is not closable by an environment.
 */
export function levelDefaultEnabled(granted: EvidenceLevel, required: EvidenceLevel, override: string | undefined): boolean {
  return levelReached(granted, required) || override === '1';
}

/** The same question asked against the real grant. */
export function levelEnabled(required: EvidenceLevel, override: string | undefined): boolean {
  return levelDefaultEnabled(GRANTED_EVIDENCE_LEVEL, required, override);
}
