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
  const blind = join(ROOT, 'scripts/phase15', `.pitr-proof-blinded-${String(process.pid)}.tmp.ts`);
  const sweep = (): void => {
    rmSync(blind, { force: true });
  };
  process.on('exit', sweep);
  try {
    const real = runDrill(DRILL);
    writeFileSync(
      blind,
      GUARDS.reduce((text, g) => text.replace(g.from, g.to), source),
    );
    const stripped = runDrill(blind);

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
    console.log(
      `  with both lines blinded    exit ${String(stripped.status)}  ${/^\s+P\d FAIL\b/m.test(stripped.out) ? 'failed a validator, as the defect did' : 'did not fail a validator'}`,
    );
    console.log('');
    if (problems.length > 0) {
      for (const p of problems) console.log(`  FINDING: ${p}`);
      console.log('');
      console.log(`EXIT 1 — ${String(problems.length)} finding(s).`);
      return 1;
    }
    console.log('A busy port is reported as a measurement that did not happen, and the code that says so');
    console.log('  is load-bearing: blinding it brings the false FAIL back. The port was held by this');
    console.log('  process and released; no cluster or document was written.');
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
