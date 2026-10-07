#!/usr/bin/env tsx
/**
 * PHASE 4 — P4-S9 — THE PUSH / PULL_REQUEST ASYMMETRY DETECTOR
 *
 * THE LIVE DEFECT THIS MODULE WAS WRITTEN FOR
 *
 * `.github/workflows/ci.yml`, the `hygiene` job:
 *
 *     702:      - name: Secret history range scan (every commit of the pull request)
 *     703:        if: github.event_name == 'pull_request'
 *     …
 *     712:          npm run scan:secrets:phase3 -- --head="$HEAD_SHA" …
 *     714:        if: always() && github.event_name == 'pull_request'   (the artefact upload)
 *
 * The step that scans the candidate history for secrets RUNS ON THE PULL
 * REQUEST PATH AND IS SKIPPED ON THE PUSH PATH.
 *
 * Why that matters exactly here and not in general: `P4-AL-79` makes the
 * **push** run at the seal commit's own SHA the AUTHORITATIVE evidence —
 * "Phase 4 closes only on a `push` run of `DAFTAR CI` at the seal commit's own
 * SHA plus that release-evidence run at the same SHA; a `pull_request` run on
 * a merge commit is equivalent-tree evidence and is labelled as such". So the
 * ONE run that is exact-SHA evidence for the commit being released is the one
 * run in which the secret-history range scan DOES NOT EXECUTE. The gitleaks
 * ACTION above it does run on both paths, but its own step comment records why
 * it is not the cover: on a pull request it pages the first 30 OLDEST commits
 * and scanned about 30 of 400 on PR #4. So on the push path the candidate
 * history is covered by nothing.
 *
 * `[[daftar-a-check-only-asked-where-it-passes]]` in its purest form: the
 * check exists, it is green, and it is green on the path that is not the
 * evidence.
 *
 * ── WHY THIS IS A PATCH REQUEST AND NOT AN EDIT ──────────────────────────
 *
 * `.github/workflows/**` is the evidence surface for a slice currently in
 * acceptance (P4-S4). Editing it from here would change, mid-acceptance, the
 * job whose green tick that slice's evidence rests on. So this module DETECTS
 * and the fix is `docs/patch-requests/PATCH-REQ-S9-001.md`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWorkflowSteps, type WorkflowStep } from '../phase4-s8/tree';

export interface TriggerAsymmetry {
  readonly job: string;
  readonly step: string;
  readonly line: number;
  readonly ifExpr: string;
  /** Which triggers the step runs on, as read from its `if:`. */
  readonly runsOn: readonly string[];
  /** Which triggers it is skipped on. */
  readonly skippedOn: readonly string[];
  readonly command: string | null;
}

const TRIGGERS: readonly string[] = ['push', 'pull_request'];

/**
 * Which triggers an `if:` admits.
 *
 * Deliberately narrow and conservative: it understands the two shapes this
 * workflow uses (`github.event_name == 'x'` and `github.event_name != 'x'`,
 * optionally behind `always() &&`) and reports an expression it does not
 * understand as admitting BOTH triggers — so an unparsed condition is never
 * reported as an asymmetry. A detector that guessed would cry wolf on the
 * first clever expression somebody writes, and then be ignored.
 */
export function triggersAdmittedBy(ifExpr: string | null): readonly string[] {
  if (ifExpr === null || ifExpr.trim() === '') return TRIGGERS;
  const equals = [...ifExpr.matchAll(/github\.event_name\s*==\s*'([a-z_]+)'/g)].map((m) => m[1] ?? '');
  const notEquals = [...ifExpr.matchAll(/github\.event_name\s*!=\s*'([a-z_]+)'/g)].map((m) => m[1] ?? '');
  if (equals.length === 0 && notEquals.length === 0) return TRIGGERS;
  if (equals.length > 0) return TRIGGERS.filter((t) => equals.includes(t));
  return TRIGGERS.filter((t) => !notEquals.includes(t));
}

/**
 * Steps whose command matches `pattern` and that do NOT run on every trigger.
 *
 * `pattern` is matched against the step's `run:` body, so the detector is
 * about WHAT A STEP DOES rather than what it is called — a renamed step is
 * still found, which is the property a lexical name check would not have.
 */
export function findTriggerAsymmetries(workflowText: string, pattern: RegExp): TriggerAsymmetry[] {
  const out: TriggerAsymmetry[] = [];
  for (const step of parseWorkflowSteps(workflowText)) {
    if (step.run === null || !pattern.test(step.run)) continue;
    const runsOn = triggersAdmittedBy(step.ifExpr);
    if (runsOn.length === TRIGGERS.length) continue;
    out.push({
      job: step.job,
      step: step.name,
      line: step.line,
      ifExpr: step.ifExpr ?? '',
      runsOn,
      skippedOn: TRIGGERS.filter((t) => !runsOn.includes(t)),
      command: step.run,
    });
  }
  return out;
}

/** The commands whose trigger coverage decides whether candidate history is scanned at all. */
export const SECRET_HISTORY_COMMAND = /scan:secrets:phase[0-9]|phase[0-9]-secret-scan\.ts/;

export interface SecretScanCoverage {
  readonly workflowPath: string;
  /** The range-scan steps, with their trigger coverage. */
  readonly rangeSteps: readonly TriggerAsymmetry[];
  /** Whether the gitleaks ACTION step exists, and on which triggers. */
  readonly actionStep: { readonly line: number; readonly runsOn: readonly string[] } | null;
  /** Triggers on which NO range scan runs. */
  readonly uncoveredTriggers: readonly string[];
}

export function secretScanCoverage(root: string, workflowRelative = '.github/workflows/ci.yml'): SecretScanCoverage {
  const path = join(root, workflowRelative);
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const rangeSteps = findTriggerAsymmetries(text, SECRET_HISTORY_COMMAND);
  const allRangeSteps = parseWorkflowSteps(text).filter((s) => s.run !== null && SECRET_HISTORY_COMMAND.test(s.run));
  const covered = new Set<string>();
  for (const step of allRangeSteps) for (const trigger of triggersAdmittedBy(step.ifExpr)) covered.add(trigger);
  const action = parseWorkflowSteps(text).find((s: WorkflowStep) => s.uses !== null && s.uses.includes('gitleaks-action'));
  return {
    workflowPath: workflowRelative,
    rangeSteps,
    actionStep: action === undefined ? null : { line: action.line, runsOn: triggersAdmittedBy(action.ifExpr) },
    uncoveredTriggers: TRIGGERS.filter((t) => !covered.has(t)),
  };
}

/**
 * THE FINDING.
 *
 * Reported with `file:line` so a patch request can name the exact subject, and
 * with the consequence spelled out rather than left to the reader: the push
 * path is the exact-SHA evidence path, so a check that is skipped there is a
 * check that does not cover the commit being released.
 */
export function secretScanCoverageProblems(root: string, workflowRelative = '.github/workflows/ci.yml'): string[] {
  const coverage = secretScanCoverage(root, workflowRelative);
  const problems: string[] = [];
  if (coverage.rangeSteps.length === 0 && coverage.uncoveredTriggers.length === TRIGGERS.length)
    problems.push(`${coverage.workflowPath}: NO secret-history range scan step exists at all — the candidate history is covered by nothing on either trigger`);
  for (const step of coverage.rangeSteps)
    problems.push(
      `${coverage.workflowPath}:${step.line.toString()} — the \`${step.job}\` job's step "${step.step}" runs the secret-history range scan ` +
        `only on ${step.runsOn.join(', ') || 'no trigger'} and is SKIPPED on ${step.skippedOn.join(', ')} (\`if: ${step.ifExpr}\`). ` +
        'The PUSH path is the exact-SHA evidence path (P4-AL-79), so the one run that is evidence for the commit being released is the one run in which this scan does not execute.',
    );
  for (const trigger of coverage.uncoveredTriggers)
    problems.push(
      `${coverage.workflowPath}: no secret-history range scan runs on a \`${trigger}\` event. ` +
        (coverage.actionStep === null
          ? 'and no gitleaks action step was found either'
          : `the gitleaks action at line ${coverage.actionStep.line.toString()} does run there, but its own step comment records that on a pull request it pages the 30 OLDEST commits and scanned about 30 of 400 on PR #4 — it is not the cover.`),
    );
  return problems;
}
