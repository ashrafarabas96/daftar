/**
 * PHASE 15 — GUARD-DELETION PROOF FOR THE EXIT-CODE SWEEP'S PROVENANCE RULE
 * (PREPARED / NOT PROMOTED)
 *
 * WHY THIS IS ITS OWN INSTRUMENT
 *   `exit-code-sweep.ts` takes exactly one exemption — it does not scan itself —
 *   and that exemption is MEASURED rather than asserted: the file does not
 *   import `spawnSync` as a value, so it cannot run a command, so it has no exit
 *   code to discard. A guard-deletion test has to run a MODIFIED COPY of that
 *   sweep as a child process, which would mean importing `spawnSync` into it and
 *   withdrawing the exemption its own inertness earns. So the child-process half
 *   lives here instead, and the sweep stays inert.
 *
 * WHAT IT MEASURES (round-9B's F-R9B-01)
 *   The sweep used to credit ANY returned object literal carrying a property
 *   named `status` as forwarding a command's exit code — `{ status: 0, out }`
 *   included, with the real code thrown away. The fix requires the value's
 *   PROVENANCE: the status must come from the spawn result. `X15` in the sweep's
 *   own `--prove` shows the planted defect reddens. That alone cannot say WHICH
 *   rule caught it, so this instrument runs the same plant twice:
 *     1. against the real sweep           → it must be REPORTED
 *     2. against a copy of the sweep with the provenance requirement replaced by
 *        the old blanket test             → it must NOT be reported
 *   If the stripped copy still reports it, provenance is not what catches it and
 *   X15's red belongs to another rule; this instrument then fails rather than
 *   letting the pack keep a credit it has not earned.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const SWEEP = join(ROOT, 'scripts/phase15/exit-code-sweep.ts');
const PLANT = 'planted-invented-status.ts';

/** The provenance requirement, as one line of this repository's source. */
const GUARD = "      if (ts.isPropertyAssignment(prop) && prop.name.getText(sf) === 'status' && fromSpawn(prop.initializer, call, bound)) return true;";
/** What it replaced, which is the fail-open the challenger measured. */
const BLANKET = "      if (ts.isPropertyAssignment(prop) && prop.name.getText(sf) === 'status') return true;";

function plant(dir: string): void {
  writeFileSync(
    join(dir, PLANT),
    [
      "import { spawnSync } from 'node:child_process';",
      '// A helper shaped like every other run-a-command helper in this pack. The',
      '// one thing it does not do is read the exit code: the `0` it hands on is',
      "// its own, and its caller's `if (r.status !== 0)` decides on that zero.",
      'export function run(cmd: string, args: readonly string[]): { status: number; out: string } {',
      "  const r = spawnSync(cmd, [...args], { encoding: 'utf8' });",
      "  return { status: 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };",
      '}',
      'export function listed(): readonly string[] {',
      "  const r = run('git', ['ls-files']);",
      "  if (r.status !== 0) throw new Error('git ls-files failed');",
      "  return r.out.split('\\n');",
      '}',
      '',
    ].join('\n'),
  );
}

/** Run one sweep over one pack copy. The exit code is read HERE, at the spawn. */
function sweepOver(script: string, pack: string): { readonly ran: boolean; readonly reported: boolean; readonly code: number | null; readonly out: string } {
  const r = spawnSync('npx', ['tsx', script], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, P15_SWEEP_DIR: pack } });
  const code = r.status;
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  // The sweep's own codes are 0 and 1. Anything else is this runner failing to
  // start it, which must never read as "nothing was reported".
  const ran = r.error === undefined && (code === 0 || code === 1);
  // ONLY the unchecked block counts. The sweep names every call it measured
  // too, so a bare `out.includes(PLANT)` is true in both arms — the plant's
  // file appears in the GREEN list when the sweep believes the invented status.
  // This proof read exactly that way at first and reported the stripped copy as
  // still catching the defect, which is the fail-open it exists to refuse.
  const header = 'CALLS WHOSE EXIT CODE IS NEVER READ';
  const block = out.includes(header) ? out.slice(out.indexOf(header)) : '';
  return { ran, reported: block.includes(PLANT), code: code, out };
}

function main(): number {
  console.log('━'.repeat(78));
  console.log('PHASE 15 — GUARD-DELETION PROOF: IS PROVENANCE WHAT CATCHES AN INVENTED STATUS?   (PREPARED / NOT PROMOTED)');
  console.log('━'.repeat(78));
  const me = readFileSync(SWEEP, 'utf8');
  if (!me.includes(GUARD)) {
    console.log('  the provenance requirement is not written in the shape this proof removes, so nothing here was measured.');
    console.log('  Expected this line in scripts/phase15/exit-code-sweep.ts:');
    console.log(`    ${GUARD.trim()}`);
    console.log('');
    console.log('EXIT 2 — UNMEASURED. A guard-deletion proof that cannot find the guard proves nothing.');
    return 2;
  }
  const tmp = mkdtempSync(join(tmpdir(), 'p15-guard-'));
  try {
    const pack = join(tmp, 'phase15');
    cpSync(join(ROOT, 'scripts/phase15'), pack, { recursive: true });
    plant(pack);
    const stripped = join(tmp, 'sweep-without-provenance.ts');
    writeFileSync(stripped, me.replace(GUARD, BLANKET));

    const real = sweepOver(SWEEP, pack);
    const without = sweepOver(stripped, pack);
    const problems: string[] = [];
    if (!real.ran) problems.push(`the real sweep did not run (exit ${String(real.code)}), so its silence says nothing`);
    else if (!real.reported) problems.push(`the real sweep did not report ${PLANT}: a helper that invents its status is being credited as a forwarder`);
    if (!without.ran) problems.push(`the sweep with the guard removed did not run (exit ${String(without.code)}), so the deletion arm is UNMEASURED`);
    else if (without.reported)
      problems.push(
        `the sweep with the provenance requirement REMOVED still reported ${PLANT}: provenance is not the rule that catches this, and the red proof credits it to the wrong guard`,
      );

    console.log(`  with provenance required   exit ${String(real.code)}  ${real.reported ? 'REPORTED the invented status' : 'said nothing'}`);
    console.log(
      `  with that one line removed exit ${String(without.code)}  ${without.reported ? 'REPORTED it anyway' : 'said nothing — so that line is what catches it'}`,
    );
    console.log('');
    if (problems.length > 0) {
      for (const p of problems) console.log(`  FINDING: ${p}`);
      console.log('');
      console.log(`EXIT 1 — ${String(problems.length)} finding(s). A rule that can be deleted without the proof noticing was never doing the work.`);
      return 1;
    }
    console.log('The provenance requirement is load-bearing: deleting that one line makes the planted');
    console.log('  defect invisible, and restoring it makes it visible again. The plant and both runs');
    console.log('  happen in a throwaway copy; neither this repository nor the pack is written to.');
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

process.exitCode = main();
