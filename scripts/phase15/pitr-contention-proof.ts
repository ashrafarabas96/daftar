/**
 * PHASE 15 — RED PROOF: DOES THE PITR DRILL TELL CONTENTION FROM A BROKEN RESTORE?
 * (PREPARED / NOT PROMOTED)
 *
 * WHY
 *   Measured on 2026-10-13 at `44e3c39`: three consecutive runs of `pitr:proof`
 *   printed `P2 FAIL — The base backup plus archived WAL recovers to a
 *   consistent, read-write cluster`, with `P3` and `P4` failing behind it. The
 *   cause was one line inside the server log every time — `could not bind IPv4
 *   address "127.0.0.1": Address already in use` on the recovered cluster's
 *   FIXED port — so the recovery was never attempted. Run alone, the same drill
 *   passes every validator. «Disaster recovery is broken» and «I could not run
 *   the drill» had the same exit code and nearly the same text, and the first of
 *   those is a false measured claim about release evidence.
 *
 * WHAT IS MEASURED HERE
 *   1. With the port deliberately held, the drill must report **INVALID
 *      MEASUREMENT — RESOURCE CONTENTION** and exit **3**, and no validator may
 *      read FAIL.
 *   2. THE GUARD-DELETION HALF: a copy of the drill with the contention
 *      classification removed, against the same held port, must go back to
 *      printing a FAILED validator. If it does not, something else produces the
 *      difference and arm 1 credits the behaviour to the wrong code.
 *   3. A MEASURED FAILURE MUST SURVIVE THE CONTENTION (round 12, F-R12-03).
 *      The fix for 1 bought a second way to lose a finding: the verdict read
 *      contention BEFORE the failure list, so a validator that decided and
 *      FAILED before the recovery was ever attempted printed «the drill did not
 *      run» and exited 3. A copy with P1 forced to fail — through the drill's
 *      own `fail()` path, against the same held port — must print `P1 FAIL`,
 *      say FAIL, and exit **1**.
 *   4. ITS OWN GUARD-DELETION HALF: the same forced failure, in a copy where
 *      the verdict is put back in its old order, must return to exit 3 and
 *      CONTENTION. Without this arm, arm 3 would pass on any build that
 *      happened to fail-closed for another reason.
 *
 *   The port is held by a listener in THIS process, released in a `finally`, and
 *   no cluster, data directory or document is written by this file.
 */
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const DRILL = join(ROOT, 'scripts/phase15/pitr-proof.ts');
/**
 * The classification under test, as the TWO lines of this repository's source
 * that make it up: the pre-flight wait's verdict about a port it never got, and
 * the bind test on the server log. Removing one leaves the other still
 * reporting contention — measured, when this proof's first version blinded the
 * log test alone and the stripped copy still refused to fail a validator. A
 * guard with two halves is deleted whole, or the arm attributes the difference
 * to a line that was not deciding it.
 */
const GUARDS: readonly { readonly from: string; readonly to: string }[] = [
  {
    from: '    const bind = /could not bind IPv4 address|could not create any TCP\\/IP sockets|Address already in use/.test(log);',
    to: '    const bind = false;',
  },
  { from: '      contention: true,', to: '      contention: false,' },
];

/**
 * The plant for arms 3 and 4: P1's verdict is decided from `pg_stat_archiver`
 * BEFORE any recovery is attempted, so forcing its condition false produces a
 * genuine measured failure through the drill's own `fail()` — not an injected
 * string — in the window where contention also happens.
 */
const FORCE_FAIL = {
  from: '    if (Number(archiver.archived) > 0 && archiver.last && Number(archiver.failed) === 0 && segments.length > 0) {',
  to: '    if (false && Number(archiver.archived) > 0 && archiver.last && Number(archiver.failed) === 0 && segments.length > 0) {',
} as const;

/** The verdict's order, put back the way F-R12-03 found it. */
const OLD_ORDER: readonly { readonly from: string; readonly to: string }[] = [
  {
    from: `        failed.length > 0 || (PROVE && redsNotRed.length > 0)
        ? 'FAIL'
        : contentionDetail !== null
          ? 'INVALID MEASUREMENT — RESOURCE CONTENTION'`,
    to: `        contentionDetail !== null
        ? 'INVALID MEASUREMENT — RESOURCE CONTENTION'
        : failed.length > 0 || (PROVE && redsNotRed.length > 0)
          ? 'FAIL'`,
  },
  {
    from: `  if (failed.length > 0 || (PROVE && redsNotRed.length > 0)) process.exitCode = 1;
  else if (contentionDetail !== null) process.exitCode = 3;
  else if (!ok) process.exitCode = 1;`,
    to: `  if (contentionDetail !== null) process.exitCode = 3;
  else if (!ok) process.exitCode = 1;`,
  },
];

interface Arm {
  /** Named `status`, not `code`: the exit-code sweep recognises a forwarded
   *  exit code by the property's name AND its provenance from the spawn. */
  readonly status: number | null;
  readonly out: string;
}

function runDrill(script: string): Arm {
  const r = spawnSync('npx', ['tsx', script], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.error !== undefined) return { status: null, out: `${out}\n[harness] the drill could not start: ${r.error.message}` };
  return { status: r.status, out };
}

/** The port the recovered cluster takes, read from the drill rather than typed here. */
function recoveredPort(): number | null {
  const m = /const RECOVERED: ClusterSpec = \{ dir: `\$\{BASE\}-recovered`, port: (\d+)/.exec(readFileSync(DRILL, 'utf8'));
  return m === null ? null : Number(m[1]);
}

async function main(): Promise<number> {
  console.log('━'.repeat(78));
  console.log('PHASE 15 — RED PROOF: CONTENTION IS NOT A FAILED RESTORE   (PREPARED / NOT PROMOTED)');
  console.log('━'.repeat(78));
  const port = recoveredPort();
  const source = readFileSync(DRILL, 'utf8');
  if (port === null || GUARDS.some((g) => !source.includes(g.from))) {
    console.log('  the drill no longer declares its recovered port, or no longer classifies a bind failure,');
    console.log('  in the shape this proof reads. Nothing was measured.');
    console.log('');
    console.log('EXIT 2 — UNMEASURED. A proof that cannot find what it is proving proves nothing.');
    return 2;
  }
  const held = createServer();
  await new Promise<void>((resolve, reject) => {
    held.once('error', reject);
    held.listen(port, '127.0.0.1', () => {
      resolve();
    });
  });
  console.log(`  holding 127.0.0.1:${String(port)} — the port the recovered cluster needs\n`);
  // THE BLINDED COPY LIVES BESIDE THE ORIGINAL, and it has to.
  //
  // The drill resolves its own imports (`./pg-cluster`) and the repository root
  // (`join(__dirname, '..', '..')`, which is how it finds bootstrap.sql and the
  // migrations) from the file's own directory. A copy under /tmp therefore does
  // not run at all — measured: it exits 1 having printed no validator, which
  // this proof's first version read as "the blinded copy did not fail a
  // validator" and reported as a finding. A copy that cannot start proves
  // nothing in either direction, so the copy goes here, under a name nothing
  // else matches, and is removed in the `finally` below and on exit.
  const tmp = mkdtempSync(join(tmpdir(), 'p15-contention-'));
  const beside = (tag: string): string => join(ROOT, 'scripts/phase15', `.pitr-proof-${tag}-${String(process.pid)}.tmp.ts`);
  const blind = beside('blinded');
  const planted = beside('planted');
  const plantedOld = beside('planted-oldorder');
  const sweep = (): void => {
    for (const f of [blind, planted, plantedOld]) rmSync(f, { force: true });
  };
  process.on('exit', sweep);
  try {
    const real = runDrill(DRILL);
    writeFileSync(
      blind,
      GUARDS.reduce((text, g) => text.replace(g.from, g.to), source),
    );
    const stripped = runDrill(blind);

    // Arms 3 and 4: a MEASURED failure, in the same held-port window.
    const haveFail = source.includes(FORCE_FAIL.from);
    const haveOrder = OLD_ORDER.every((g) => source.includes(g.from));
    // Each drill result is BOUND and its status read where it is bound, which
    // is what this pack's own exit-code sweep requires of every command: an
    // assignment to an outer `let`, read later through a cast, is a shape the
    // sweep cannot follow — and it is right not to, since nothing in that
    // shape says the code was ever looked at.
    const plants = ((): { readonly forced: Arm; readonly forcedOld: Arm } | null => {
      if (!haveFail || !haveOrder) return null;
      const withFail = source.replace(FORCE_FAIL.from, FORCE_FAIL.to);
      writeFileSync(planted, withFail);
      const a = runDrill(planted);
      if (a.status === null) return { forced: a, forcedOld: a };
      writeFileSync(
        plantedOld,
        OLD_ORDER.reduce((text, g) => text.replace(g.from, g.to), withFail),
      );
      const b = runDrill(plantedOld);
      if (b.status === null) return { forced: a, forcedOld: b };
      return { forced: a, forcedOld: b };
    })();
    const forced = plants?.forced ?? null;
    const forcedOld = plants?.forcedOld ?? null;

    const problems: string[] = [];
    const named = real.out.includes('INVALID MEASUREMENT — RESOURCE CONTENTION');
    const failed = /^\s+P\d FAIL\b/m.test(real.out);
    if (real.status === null) problems.push('the drill did not start, so this proof measured nothing');
    else {
      if (real.status !== 3) problems.push(`the drill exited ${String(real.status)} with the port held; 3 is the code that says the drill did not run`);
      if (!named) problems.push('the drill did not print INVALID MEASUREMENT — RESOURCE CONTENTION, so a reader cannot tell a busy port from a broken restore');
      if (failed) problems.push('a validator read FAIL while the recovery was never attempted — a false measured claim about disaster recovery');
    }
    const strippedRanTheDrill = /^VALIDATORS$/m.test(stripped.out);
    if (stripped.status === null || !strippedRanTheDrill)
      problems.push(
        `the copy without the classification did not run the drill (exit ${String(stripped.status)}), so the guard-deletion arm is UNMEASURED — and a copy that cannot start must never read as "it did not fail a validator"`,
      );
    else if (!/^\s+P\d FAIL\b/m.test(stripped.out))
      problems.push(
        'with the bind classification removed, the drill STILL did not fail a validator — so that classification is not what separates contention from a failed restore, and arm 1 credits the behaviour to the wrong code',
      );

    console.log(
      `  with the classification    exit ${String(real.status)}  ${named ? 'named it CONTENTION' : 'did NOT name contention'}, ${failed ? 'and failed a validator' : 'no validator failed'}`,
    );
    // ── arms 3 and 4 ──────────────────────────────────────────────────────
    const ranIt = (a: Arm | null): boolean => a !== null && /^VALIDATORS$/m.test(a.out);
    if (!haveFail || !haveOrder) {
      problems.push(
        'the drill no longer carries P1\u2019s verdict condition or the verdict order this proof plants into, so the MEASURED-FAILURE arms are UNMEASURED — not passed',
      );
    } else if (!ranIt(forced) || !ranIt(forcedOld)) {
      problems.push(
        `a planted copy did not run the drill (exit ${String(forced?.status)} / ${String(forcedOld?.status)}), so arms 3 and 4 are UNMEASURED — a copy that cannot start must never read as a result`,
      );
    } else {
      const f = forced as Arm;
      const fo = forcedOld as Arm;
      if (!/^\s+P1 FAIL\b/m.test(f.out)) problems.push('the forced P1 failure did not appear as `P1 FAIL`, so arm 3 did not plant what it claims to plant');
      if (f.status !== 1)
        problems.push(
          `with a validator FAILED and the port held, the drill exited ${String(f.status)}; a measured failure is a fact the port cannot undo, so the code must be 1 and the verdict FAIL`,
        );
      if (!/PHASE 15 PITR PROOF: FAIL\b/.test(f.out))
        problems.push('with a validator FAILED and the port held, the verdict line did not say FAIL — a real finding was reported as a drill that did not run');
      if (fo.status !== 3 || !fo.out.includes('INVALID MEASUREMENT — RESOURCE CONTENTION'))
        problems.push(
          `with the verdict order put back, the same forced failure exited ${String(fo.status)} instead of 3/CONTENTION — so the ORDER is not what makes arm 3 pass, and arm 3 credits the behaviour to the wrong code`,
        );
    }

    console.log(
      `  with both lines blinded    exit ${String(stripped.status)}  ${/^\s+P\d FAIL\b/m.test(stripped.out) ? 'failed a validator, as the defect did' : 'did not fail a validator'}`,
    );
    console.log(
      `  a validator FORCED to fail exit ${String(forced?.status)}  ${forced !== null && /PHASE 15 PITR PROOF: FAIL\b/.test(forced.out) ? 'said FAIL — the finding survived the contention' : 'did NOT say FAIL'}`,
    );
    console.log(
      `  the same, old verdict order exit ${String(forcedOld?.status)}  ${forcedOld !== null && forcedOld.out.includes('INVALID MEASUREMENT — RESOURCE CONTENTION') ? 'swallowed it as CONTENTION, as the defect did' : 'did not swallow it'}`,
    );
    console.log('');
    if (problems.length > 0) {
      for (const p of problems) console.log(`  FINDING: ${p}`);
      console.log('');
      console.log(`EXIT 1 — ${String(problems.length)} finding(s).`);
      return 1;
    }
    console.log('A busy port is reported as a measurement that did not happen, and the code that says so');
    console.log('  is load-bearing: blinding it brings the false FAIL back. A validator that DID fail');
    console.log('  before the contention still reads FAIL and exits 1, and putting the verdict order');
    console.log('  back makes that finding disappear again. The port was held by this process and');
    console.log('  released; no cluster or document was written.');
    return 0;
  } finally {
    held.close();
    sweep();
    rmSync(tmp, { recursive: true, force: true });
  }
}

main()
  .then((c) => {
    process.exitCode = c;
  })
  .catch((e: unknown) => {
    console.log(`EXIT 1 — the proof itself failed: ${(e as Error).message}`);
    process.exitCode = 1;
  });
