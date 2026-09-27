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
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

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

/**
 * ── Run standalone, the canary runs for real ──────────────────────────────
 *
 * `npx tsx scripts/runner-canary.ts` is step 1 of `gate:phase3:release` and of
 * `gate:phase2:release`. Until P3-S9 this module only exported the decision
 * above, so that step started a process that ran no test and exited 0: the
 * "canary first" step of the Phase 2 release gate proved nothing (P3-S9
 * contract, finding F-1). Executed directly, it now runs both runners this
 * repository has — the root runner, through the same global setup that
 * installs the exit-code guard, and the web runner — each over its
 * deliberately failing fixture, in a real `vitest` child, and applies
 * `canaryRefusal` to what came back. Any refusal exits 1 and names the
 * runner. Importing the module still runs nothing.
 */
const CANARIES: readonly { readonly runner: string; readonly config: string }[] = [
  { runner: 'root', config: 'tests/fixtures/runner-exit-code/vitest.config.ts' },
  { runner: 'web', config: 'apps/web/test/fixtures/runner-exit-code/vitest.config.mts' },
];

if (require.main === module) {
  const root = join(__dirname, '..');
  const refusals: string[] = [];
  for (const { runner, config } of CANARIES) {
    const res = spawnSync('npx', ['vitest', 'run', '--config', config, 'failing'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '0' },
      maxBuffer: 64 * 1024 * 1024,
    });
    const refusal = canaryRefusal({ output: `${res.stdout ?? ''}${res.stderr ?? ''}`, status: res.status });
    if (refusal === null) console.log(`PASS the ${runner} runner reports failure (its canary exited ${res.status ?? 'on a signal'})`);
    else refusals.push(`the ${runner} runner (${config}): ${refusal}`);
  }
  if (refusals.length > 0) {
    console.error(`FAIL runner canary\n  ${refusals.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`PASS runner canary: ${CANARIES.length} runners can report failure`);
}
