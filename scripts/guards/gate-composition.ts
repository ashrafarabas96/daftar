/**
 * THE TWO LANES, AND THE ONE FLAG THAT SEPARATES THEM (TL-P4-GATE-COMP-01).
 *
 * THE DEFECT THIS MODULE EXISTS FOR, stated as the owner stated it:
 * «HOST-SENSITIVE ABSOLUTE PERFORMANCE MUST NOT BE RE-EXECUTED INSIDE
 * RECURSIVELY COMPOSED PREDECESSOR GATES.» It is an architectural defect, not
 * a number. `tests/performance/accounting-budgets.test.ts` is a RUNTIME STEP
 * of the P2-S8 gate; later gates compose predecessor gates; so
 * `gate:phase4:s1` — a CORRECTNESS gate — can print FAIL because of latency
 * noise on the machine that happened to execute it. Raising a ceiling does not
 * fix that, and neither does re-running.
 *
 * ── LANE A, COMPOSABLE CORRECTNESS ─────────────────────────────────────────
 * Structural checks, migration checks, security checks, deterministic
 * functional tests, the runner failure canary, permission/RLS invariants, and
 * the EXISTENCE AND WIRING verification of the performance contracts. May be
 * recursively composed, because its verdict does not depend on how fast or how
 * busy the executing machine is.
 *
 * ── LANE B, PERFORMANCE EVIDENCE ───────────────────────────────────────────
 * The timing budgets themselves: sample counts, p95, absolute millisecond
 * ceilings, datasets, plans and statistics, exclusive-environment evidence.
 * Must NOT be recursively executed by every later slice.
 *
 * ── WHAT THIS IS NOT ───────────────────────────────────────────────────────
 * It is not permission to remove performance. "Remove the budget so the gate
 * goes green" is forbidden. Accounting A/B/C/D/E/F remain part of the
 * performance contract in full. What moves is WHERE the LATENCY VERDICT is
 * taken — once, in a named step a reviewer can point at — not WHETHER it is
 * taken. The CONTRACT SHAPE stays composable and is checked in every mode by
 * `scripts/guards/performance-contract.ts`, which reads the suite's source
 * and goes red on a changed ceiling, a changed sample count, a changed
 * percentile or a COMMIT moved out of the timed region WITHOUT executing the
 * benchmark.
 *
 * ── WHY AN EXPLICIT FLAG AND NOT AN ENVIRONMENT VARIABLE ───────────────────
 * An environment variable whose ABSENCE changes a gate's authority is a gate
 * whose authority depends on something no reviewer sees in the command. The
 * mode is therefore an argument — `npm run gate:phase2:s8 -- --composition` —
 * and NOTHING in this module reads `process.env`. Four properties make the
 * flag undefeatable by accident:
 *
 *   1. STRICT ARGV. `decideMode()` refuses any `--` token the caller did not
 *      declare. `--Composition`, `--compose`, `--composition=1` and a stray
 *      `--no-perf` are all REFUSALS with a named reason, never a silent fall
 *      back to one mode or the other. A mode nobody can mistype into is a
 *      mode nobody can mistype out of.
 *   2. ONE DIRECTION ONLY. A predecessor is ALWAYS composed in composition
 *      mode — `PREDECESSOR_ARGS` takes no parameters, so no caller can decide
 *      to compose one in direct mode. The invariant is in the type, not in a
 *      convention.
 *   3. NO SILENT SKIP. Composition mode skips a step only through
 *      `laneBNotice()`, which PRINTS the step it did not run, the ruling it
 *      did not run it under, and WHERE the measurement is taken instead. A
 *      log that omits performance says so in the log.
 *   4. NO EMPTY PASS. `emptyCompositionRefusal()` makes "every step was
 *      skipped" a FAILURE. Composition mode cannot become a mode that
 *      reports PASS over nothing.
 *
 * ── WHAT COMPOSITION MODE STILL VERIFIES ───────────────────────────────────
 * Everything in Lane A: the whole structural half of each gate runs
 * unconditionally and BEFORE the mode is consulted, so composition mode still
 * refuses a moved migration boundary, a thawed frozen migration, a changed
 * RLS or role invariant, a lost reconciliation authority, a dormant runner
 * canary, a broken supply-chain law, a missing performance suite, a weakened
 * threshold, or missing evidence wiring. It skips ONLY the EXECUTION of
 * host-sensitive timing workloads.
 *
 * ── WHAT IS NOT LANE B, DELIBERATELY ───────────────────────────────────────
 * The ruling is about host-sensitive ABSOLUTE PERFORMANCE. The real-browser
 * matrix, `check:db-from-zero` and the rollback rehearsal are slow and
 * tool-dependent but their verdicts are not millisecond comparisons, so they
 * are NOT marked Lane B and NOT skipped. Scope discipline is the point:
 * remove host-sensitive timing execution from recursive composition and
 * nothing more.
 *
 * ── RELEASE GATES COMPOSE IN DIRECT MODE ───────────────────────────────────
 * `gate:phase2:release`, `gate:phase2:s8:release` and `gate:phase3:release`
 * are the place where full evidence is demanded, they are run in an exclusive
 * environment rather than on every push, and no CI workflow in this tree runs
 * them. They keep their predecessors' performance verdicts. Nothing here
 * downgrades a release verdict, and nothing here downgrades the visible direct
 * `Phase 2 slice gate — P2-S8` CI step either: that step keeps DEFAULT mode
 * and keeps measuring Tier 1 in CI exactly as it did before.
 */

/** The one spelling. Nothing else selects composition mode. */
export const COMPOSITION_FLAG = '--composition';

/** `direct`: this gate was asked for its own full verdict. `composition`: it is a predecessor. */
export type GateMode = 'direct' | 'composition';

export interface ModeDecision {
  readonly mode: GateMode;
  /**
   * A sentence, when the argument vector cannot be read. A gate that receives
   * one must print it and exit non-zero: an unreadable argument vector means
   * nobody knows which lane the run was in, and a verdict nobody can classify
   * is not a verdict.
   */
  readonly refusal: string | null;
}

/**
 * A flag this caller accepts. `--root` takes a separate value token;
 * `--evidence=` carries its value inline. Both shapes are declared rather
 * than guessed, so a gate cannot acquire a flag by accident.
 */
export type KnownFlag = { readonly flag: string; readonly takesValue?: boolean } | { readonly prefix: string };

/**
 * Reads the mode out of an argument vector, STRICTLY.
 *
 * Any `--` token that is not declared is a refusal. That is the whole of the
 * guard against a silently-defeated mode: the dangerous direction is a gate
 * that stops taking a measurement because of a token nobody noticed, and the
 * only way a token can have an effect here is by being declared here.
 */
export function decideMode(argv: readonly string[], known: readonly KnownFlag[]): ModeDecision {
  const declared = [...known, { flag: COMPOSITION_FLAG } as KnownFlag];
  let skipNext = false;
  let selected = false;
  const unknown: string[] = [];
  for (const raw of argv) {
    // A token CONSUMED as the value of a `takesValue` flag is not a flag, even
    // when it is spelled like one. `['--root', '--composition']` names a
    // directory called `--composition`; it does not select composition mode.
    // Deciding the mode with `argv.includes()` after this loop would discard
    // exactly the knowledge the loop has, and the claim that the mode cannot
    // be mistyped INTO would rest on logic the decision never consulted.
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (!raw.startsWith('--')) continue;
    const match = declared.find((k) => ('flag' in k ? k.flag === raw : raw.startsWith(k.prefix)));
    if (match === undefined) {
      unknown.push(raw);
      continue;
    }
    if (raw === COMPOSITION_FLAG) selected = true;
    if ('flag' in match && match.takesValue === true) skipNext = true;
  }
  if (unknown.length > 0) {
    return {
      mode: 'direct',
      refusal:
        `unrecognized argument${unknown.length === 1 ? '' : 's'} ${unknown.join(', ')} — this gate reads its lane from its arguments ` +
        `and refuses rather than guess one. The only mode argument is \`${COMPOSITION_FLAG}\` (TL-P4-GATE-COMP-01); ` +
        'a near miss such as `--compose`, `--Composition` or `--composition=1` is refused on purpose, because a mode a caller ' +
        'can mistype INTO is a mode a caller can mistype OUT OF, and the second mistake silently drops a measurement.',
    };
  }
  return { mode: selected ? 'composition' : 'direct', refusal: null };
}

/**
 * THE ARGUMENTS A PREDECESSOR GATE IS ALWAYS COMPOSED WITH.
 *
 * It is a constant and not a function of the caller's own mode, and that is
 * the invariant TL-P4-GATE-COMP-01 asks for: a gate reached THROUGH another
 * gate is in Lane A whether the outer gate was the top of the chain or not.
 * A per-call-site decision is exactly the shape of defect that left six
 * direct spawns of one benchmark in this repository.
 *
 * The leading `--` is npm's separator: `npm run <script> -- --composition`.
 */
export const PREDECESSOR_ARGS: readonly string[] = ['--', COMPOSITION_FLAG];

/** The same vector for a direct `tsx scripts/<gate>.ts` spawn, with no npm separator. */
export const PREDECESSOR_ARGS_DIRECT: readonly string[] = [COMPOSITION_FLAG];

/**
 * A step marked as Lane B: a host-sensitive timing workload whose verdict is a
 * millisecond comparison against an absolute ceiling.
 *
 * `measuredBy` is not decoration. A step that is not executed here must name
 * the step that DOES execute it, or this mechanism would be a way to delete a
 * measurement by marking it. The red proofs assert the name is non-empty.
 */
export interface LaneB {
  readonly hostSensitive: true;
  readonly measuredBy: string;
}

/** The sentence a composed gate prints in place of a Lane B step. */
export function laneBNotice(stepName: string, measuredBy: string): string {
  return (
    `  NOT RUN [lane-b] ${stepName} — host-sensitive absolute performance is not re-executed inside a composed ` +
    `predecessor gate (TL-P4-GATE-COMP-01). This is NOT a pass and NOT a skip of the contract: the ceilings, the ` +
    `sample counts, the percentile and the timed scope were all checked structurally above. The latency verdict is ` +
    `taken by: ${measuredBy}.`
  );
}

/**
 * THE EMPTY-SUBJECT DECISION, AS A FUNCTION SO IT CAN BE PROVED
 * (challenger finding F6).
 *
 * The branch `if (executed === 0)` lives in each gate's step loop, and on THIS
 * tree it is unreachable: every gate of the chain has at least one step that
 * is not Lane B — a predecessor, a unit suite, a static check — so something
 * always executes. A red proof that only asserted the branch exists in source
 * would therefore have been proving the presence of text, not the behaviour of
 * a guard, which is the vacuity this project keeps catching.
 *
 * So the decision is a function. The proof hands it `executed = 0` directly
 * and reads the refusal, which is a real exercise of the mechanism rather than
 * a grep. And the honest statement about the gates is recorded here rather
 * than implied: the guard is LATENT on this tree. It becomes reachable the day
 * a gate's plan is all Lane B — which is exactly the day somebody would
 * otherwise have shipped a composed gate that reports PASS over nothing.
 */
export function compositionOutcome(gate: string, executed: number, laneBSkipped: number): string | null {
  if (executed > 0) return null;
  return emptyCompositionRefusal(gate, laneBSkipped);
}

/**
 * The refusal when composition mode would have run nothing at all.
 *
 * Red proof (J): a composition-mode run whose predecessor subject is empty
 * must not report PASS. "I skipped everything and found no problem" is the
 * failure mode this whole mechanism would otherwise introduce, so it is a
 * non-zero exit with its own sentence.
 */
export function emptyCompositionRefusal(gate: string, laneBSkipped: number): string {
  return (
    `${gate}: FAIL — composition mode executed NO step (${laneBSkipped} Lane B step(s) were not run and nothing else ` +
    'remained). An empty predecessor subject is not a pass: composition mode exists to drop host-sensitive timing from a ' +
    'recursive chain, never to drop the chain (TL-P4-GATE-COMP-01).'
  );
}

/**
 * The suffix every verdict line carries, so no log can show a bare PASS that
 * quietly omitted a measurement. A reviewer reading only the last line still
 * learns which lane the verdict belongs to and how many timing steps it left
 * to a dedicated step.
 */
export function verdictSuffix(mode: GateMode, laneBSkipped: readonly string[]): string {
  if (mode === 'direct') return '';
  if (laneBSkipped.length === 0) return ' (composition mode — Lane A; this gate declares no Lane B step)';
  return (
    ` (composition mode — Lane A only; ${laneBSkipped.length} Lane B timing step(s) NOT executed here` +
    ' — see the NOT RUN lines above for where each one is measured)'
  );
}
