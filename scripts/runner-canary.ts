/**
 * THE VERDICT THE EXIT-CODE CANARY READS, ON ITS OWN (f §3, §24).
 *
 * `scripts/phase2-s8-gate.ts` runs a deliberately failing test through a real
 * `vitest` child process and decides, from what came back, whether any test
 * result in the run may be trusted. Deciding is three lines; running is the
 * expensive part. They are separated here for one reason: f §24 asks for
 * permanent proof that the refusal can actually fire — "make the runner
 * canary exit 0" — and the only honest way to produce that case without
 * breaking the repository is to hand the decision the pair of values a
 * broken runner would produce and check that it says no.
 *
 * A subprocess cannot be asked to do that on demand: the defect the canary
 * watches for is a RACE between `embedded-postgres`'s shutdown hook and
 * Vitest's teardown, so a fixture built to lose that race would report the
 * bug some of the time and pass the rest — which is exactly the property
 * that made the original defect so expensive to find. A flaky proof of a
 * safety check is worse than none. So the runner is exercised for real by
 * the gate, and the verdict is proved exhaustively here.
 */

/** What the canary saw: the child's combined output and its exit status. */
export interface CanaryResult {
  readonly output: string;
  readonly status: number | null;
}

/**
 * The reason to refuse, or null when the runner proved it can report failure.
 *
 * Two distinct refusals, and the difference matters to whoever reads it. The
 * first says the canary never ran its failing test, so the run proves nothing
 * either way. The second says it ran, the failure was printed, and the
 * process still left with status 0 — which means every green in this run, and
 * in every gate it composes, is unverified.
 */
export function canaryRefusal({ output, status }: CanaryResult): string | null {
  if (!/1 failed/.test(output)) {
    return `the exit-code canary did not run its failing test, so this run proves nothing about the runner:\n${output.slice(-2000)}`;
  }
  if (status === 0) {
    return 'the test runner exited 0 over a failing test. No test result in this run — or in any gate it composes — is evidence. See tests/helpers/exit-code.ts.';
  }
  return null;
}
