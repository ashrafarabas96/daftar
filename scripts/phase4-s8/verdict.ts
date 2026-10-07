#!/usr/bin/env tsx
/**
 * PHASE 4 — P4-S8 FRAMEWORK — THE VERDICT LAW
 *
 * S8 is built BEFORE S5, S6 and S7 exist. Every check it carries has a
 * SUBJECT — a relation, a column, a routine, a constraint, a policy, a source
 * type, an operation kind, a permission key, a suite, a workflow step. Most of
 * those subjects are not real yet. The whole point of this module is that a
 * check whose subject is not real reports
 *
 *     WAITING_FOR_INTEGRATED_SURFACE
 *
 * and NEVER `PASS`. A checker that reports green because its subject does not
 * exist yet is worse than no checker: it converts an unbuilt invariant into
 * recorded evidence that the invariant holds.
 *
 * Two recorded project lessons are encoded here as code rather than prose:
 *
 *   `[[daftar-an-empty-collection-is-never-a-refusal]]` — a check whose
 *   subject set is EMPTY is a FAIL of the framework, not a pass of the
 *   product. `declaredSubjectsProblem` refuses it.
 *
 *   `[[daftar-a-green-gate-must-prove-it-can-be-red]]` — a check that has
 *   never been shown able to say FAIL is not a check. Every check in the S8
 *   registry declares `redProof`, and `registryProblems` refuses a check whose
 *   red proof does not name a real suite title.
 *
 * And one that bites every verdict reader:
 *
 *   `[[daftar-a-verdict-is-read-from-fields-that-name-something]]` — DAFTAR's
 *   SQLSTATE classifier once matched its pattern inside a random request id,
 *   about one run in four thousand, because it scanned a whole response body.
 *   `readVerdictField` and `readSqlstateField` read ONLY from a field that
 *   names what it holds, and refuse a free-text blob.
 */

/** The three honest outcomes of an S8 check. There is no fourth, and no skip. */
export type Verdict = 'PASS' | 'FAIL' | 'WAITING_FOR_INTEGRATED_SURFACE';

/**
 * The kinds of subject an S8 check can be ABOUT. The kind decides how reality
 * is probed, which is why it is a closed vocabulary rather than a free string:
 * a probe that does not know what it is looking for answers "absent" for
 * everything, and a framework whose every check is WAITING is as useless as
 * one whose every check is PASS.
 */
export type SubjectKind =
  | 'relation'
  | 'column'
  | 'constraint'
  | 'policy'
  | 'routine'
  | 'accounting-source-type'
  | 'stock-source-type'
  | 'operation-kind'
  | 'permission'
  | 'suite'
  | 'golden-directory'
  | 'workflow-step'
  | 'npm-script'
  | 'module-export';

/** One thing a check needs to be real before its verdict can be PASS or FAIL. */
export interface SubjectRequirement {
  readonly kind: SubjectKind;
  /**
   * The subject's name in the vocabulary of its kind: `refunds` for a
   * relation, `refunds.source_payment_id` for a column, `credit_note` for an
   * accounting source type, `tests/...test.ts` for a suite.
   */
  readonly name: string;
  /** The slice that makes it real. `P4-S5`, `P4-S6`, `P4-S7`, `P4-S8`, `P4-S9`. */
  readonly owedBy: string;
  /** Why this check cannot be evaluated without it. Printed on a WAITING row. */
  readonly why: string;
}

/** Answers "is this subject real in the tree at `root`?". Implemented in `tree.ts`. */
export type SubjectProbe = (root: string, subject: SubjectRequirement) => boolean;

/**
 * One S8 check.
 *
 * `evaluate` is called ONLY when every declared subject is real. That is the
 * structural half of the no-fake-PASS law: the evaluation cannot accidentally
 * return "no problems" over an absent subject, because it never runs.
 */
export interface FrameworkCheck {
  readonly id: string;
  readonly title: string;
  /** What a PASS of this check actually asserts. Printed on a PASS row. */
  readonly ok: string;
  /** Every subject this check is about. MUST be non-empty. */
  readonly subjects: readonly SubjectRequirement[];
  /** The evaluation. Returns the problems; an empty array is a PASS. */
  readonly evaluate: (root: string) => string[];
  /**
   * `<suite file>::<it( title prefix>` — the planted-defect proof that this
   * check can report FAIL. A check with no red proof is a claim.
   */
  readonly redProof: string;
  /** Measured numbers, reported on every verdict including WAITING. */
  readonly note?: (root: string) => string;
}

/** The outcome of one check, with everything a reader needs to audit it. */
export interface CheckOutcome {
  readonly id: string;
  readonly title: string;
  readonly verdict: Verdict;
  /** The problems, when the verdict is FAIL. Empty otherwise. */
  readonly problems: readonly string[];
  /** The subjects that were not real, when the verdict is WAITING. Empty otherwise. */
  readonly missingSubjects: readonly SubjectRequirement[];
  /** The subjects that WERE real. Printed so a WAITING row is not read as "nothing exists". */
  readonly presentSubjects: readonly SubjectRequirement[];
  readonly redProof: string;
  readonly note: string | null;
}

/**
 * `[[daftar-an-empty-collection-is-never-a-refusal]]`.
 *
 * A check with no declared subject would be evaluated unconditionally and
 * could therefore PASS vacuously over a tree in which its subject is absent.
 * That is the exact shape this framework exists to prevent, so a subject-less
 * check is refused by the framework rather than run by it.
 */
export function declaredSubjectsProblem(check: FrameworkCheck): string | null {
  if (check.subjects.length === 0)
    return `${check.id}: declares NO subject, so nothing decides whether its verdict may be PASS — an empty subject set is never a refusal`;
  const seen = new Set<string>();
  for (const s of check.subjects) {
    const key = `${s.kind}:${s.name}`;
    if (seen.has(key)) return `${check.id}: declares the subject ${key} twice, so the WAITING row would name it twice and the count would be wrong`;
    seen.add(key);
  }
  if (check.redProof.includes('::') === false)
    return `${check.id}: redProof ${JSON.stringify(check.redProof)} is not of the form <suite file>::<it( title prefix>`;
  return null;
}

/**
 * EVALUATE ONE CHECK UNDER THE LAW.
 *
 * The order is load-bearing and is the same order `[[daftar-registry-before-state]]`
 * requires of a replay path: the SUBJECT REGISTRY is consulted BEFORE any
 * state is read. `evaluate` is not called, not even speculatively, while a
 * subject is absent.
 */
export function evaluateCheck(root: string, check: FrameworkCheck, probe: SubjectProbe): CheckOutcome {
  const structural = declaredSubjectsProblem(check);
  if (structural !== null)
    return {
      id: check.id,
      title: check.title,
      verdict: 'FAIL',
      problems: [structural],
      missingSubjects: [],
      presentSubjects: [],
      redProof: check.redProof,
      note: null,
    };

  const present: SubjectRequirement[] = [];
  const missing: SubjectRequirement[] = [];
  for (const subject of check.subjects) (probe(root, subject) ? present : missing).push(subject);

  const note = check.note === undefined ? null : check.note(root);

  if (missing.length > 0)
    return {
      id: check.id,
      title: check.title,
      verdict: 'WAITING_FOR_INTEGRATED_SURFACE',
      problems: [],
      missingSubjects: missing,
      presentSubjects: present,
      redProof: check.redProof,
      note,
    };

  const problems = check.evaluate(root);
  return {
    id: check.id,
    title: check.title,
    verdict: problems.length === 0 ? 'PASS' : 'FAIL',
    problems,
    missingSubjects: [],
    presentSubjects: present,
    redProof: check.redProof,
    note,
  };
}

/** The tally of a framework run. `waiting > 0` is NOT a pass and never prints as one. */
export interface RunTally {
  readonly pass: number;
  readonly fail: number;
  readonly waiting: number;
  readonly total: number;
}

export function tally(outcomes: readonly CheckOutcome[]): RunTally {
  let pass = 0;
  let fail = 0;
  let waiting = 0;
  for (const o of outcomes) {
    if (o.verdict === 'PASS') pass += 1;
    else if (o.verdict === 'FAIL') fail += 1;
    else waiting += 1;
  }
  return { pass, fail, waiting, total: outcomes.length };
}

/**
 * The one-line verdict of a framework run.
 *
 * A run with any FAIL is a FAIL. A run with no FAIL and any WAITING is
 * `FRAMEWORK_READY` — which is a statement about the FRAMEWORK, never about
 * the product invariants whose subjects do not exist. The word `PASS` appears
 * only when `waiting === 0`, so no reader can mistake one for the other.
 */
export function runVerdict(t: RunTally): string {
  if (t.fail > 0) return `FAIL: ${t.fail} of ${t.total} check(s) refuse this tree (${t.pass} pass, ${t.waiting} waiting for an integrated surface)`;
  if (t.waiting > 0)
    return (
      `FRAMEWORK_READY (NOT A PASS OF THE INVARIANTS): ${t.pass} of ${t.total} check(s) have a real subject and pass; ` +
      `${t.waiting} report WAITING_FOR_INTEGRATED_SURFACE because their subject is not real yet`
    );
  return `PASS: all ${t.total} check(s) have a real subject and pass`;
}

// ───── READING A VERDICT FROM FIELDS THAT NAME SOMETHING ──────────────────

/**
 * `[[daftar-a-verdict-is-read-from-fields-that-name-something]]`.
 *
 * DAFTAR's refusal classifier once scanned a whole response body for its
 * SQLSTATE pattern and matched it inside a random request id, about one run in
 * four thousand. So: a verdict is read from a field whose NAME says it holds a
 * verdict, out of a parsed object, and from nowhere else. A free-text blob
 * returns null — which a caller must handle, rather than being silently told
 * "no problem found".
 */
const VERDICT_FIELDS = ['verdict', 'status', 'outcome', 'conclusion'] as const;

export function readVerdictField(payload: unknown): { readonly field: string; readonly value: string } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  for (const field of VERDICT_FIELDS) {
    const value = record[field];
    if (typeof value === 'string' && value.length > 0) return { field, value };
  }
  return null;
}

/** The same discipline for a SQLSTATE: a named field, never a substring of a body. */
const SQLSTATE_FIELDS = ['sqlstate', 'code', 'errcode', 'pgCode'] as const;
const SQLSTATE_SHAPE = /^[0-9A-Z]{5}$/;

export function readSqlstateField(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  for (const field of SQLSTATE_FIELDS) {
    const value = record[field];
    if (typeof value === 'string' && SQLSTATE_SHAPE.test(value)) return value;
  }
  return null;
}

/**
 * Refuses a classifier that was handed a STRING instead of a parsed object.
 *
 * This is the guard the four-thousand-run defect needed: the call site that
 * passed the body text rather than the parsed field could not be type-checked
 * into correctness, because the body text is a legal `unknown`. So it is
 * refused at run time and the refusal names the mistake.
 */
export function refuseBlobClassification(payload: unknown, where: string): string | null {
  if (typeof payload === 'string')
    return `${where}: a verdict was read from a free-text body rather than a named field — a pattern matched anywhere in a blob is not a verdict (the SQLSTATE-in-a-request-id defect)`;
  return null;
}

// ───── AN EXIT STATUS THAT CAN SAY NO ─────────────────────────────────────

/**
 * `[[daftar-a-gate-that-reads-an-exit-status-must-prove-it-can-say-no]]`.
 *
 * DAFTAR's test runner once exited 0 over four failing tests. So a gate that
 * reads a verdict out of an exit status must first prove that status can be
 * non-zero in THIS environment, by running something that must fail. This type
 * makes the proof a value a caller has to produce, rather than a comment.
 */
export interface ExitStatusProof {
  /** The command run purely to be refused. */
  readonly command: string;
  /** Its observed status. Must be non-zero, or the proof fails. */
  readonly observedStatus: number | null;
  /** Its observed signal, if it died on one. A signal is not a verdict. */
  readonly observedSignal: string | null;
}

export function exitStatusProofProblems(proof: ExitStatusProof): string[] {
  const problems: string[] = [];
  if (proof.observedSignal !== null)
    problems.push(
      `the canary \`${proof.command}\` died on signal ${proof.observedSignal}: a signal is not a verdict, so this environment has not proved an exit status can say NO`,
    );
  if (proof.observedStatus === null)
    problems.push(`the canary \`${proof.command}\` reported no exit status at all, so no verdict can be read from an exit status in this environment`);
  else if (proof.observedStatus === 0)
    problems.push(
      `the canary \`${proof.command}\` was expected to FAIL and exited 0: the runner cannot report failure here, so every green in this run is unreadable`,
    );
  return problems;
}
