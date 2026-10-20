/**
 * PHASE 15 — RED PROOF: THE CLUSTER-PORT WAIT   (PREPARED / NOT PROMOTED)
 *
 * Round 21's F-R21-15: `waitForClusterPorts` was added to stop one instrument
 * starting while another's port was still held, and nothing tested it. Worse,
 * §8b.3.1 called two green evidence runs «the measurement that the wait does
 * what it says» — and in both runs the gap at every cluster boundary was
 * 0.1-0.2s, so the wait never waited. A green run with a free port measures
 * that the port was free. This measures the wait.
 *
 * Four arms, each against a REAL listener in a REAL other process:
 *
 *   W1  a free port returns null and returns FAST
 *   W2  a held port is NAMED, and the call takes at least its budget
 *   W3  the port coming free DURING the wait ends it, which is the behaviour
 *       the runner actually depends on
 *   W4  a value that is not a port REFUSES instead of polling it for the whole
 *       budget and then reporting a held port that never existed
 *
 * It starts listeners of its own on 55901 and 55902. Round 22's F-R22-11 fix
 * made the port reader derive the declared set from the pack's own numeric
 * literals, so these two ARE declared now -- by this file. What keeps the
 * proof from contending is narrower than the sentence that stood here: no
 * CLUSTER instrument binds either port, and no other file writes them.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import { waitForClusterPorts } from './cluster-ports';

const PROOF_PORT = 55_901;
const PROOF_PORT_2 = 55_902;

async function holdAsync(port: number): Promise<net.Server> {
  const srv = net.createServer();
  await new Promise<void>((res) => srv.listen(port, '127.0.0.1', res));
  return srv;
}

async function main(): Promise<number> {
  console.log('━'.repeat(78));
  console.log('PHASE 15 — RED PROOF: THE CLUSTER-PORT WAIT   (PREPARED / NOT PROMOTED)');
  console.log('━'.repeat(78));
  let failures = 0;
  let unmeasured = 0;
  const say = (id: string, ok: boolean, what: string, got: string): void => {
    if (!ok) failures += 1;
    console.log(`  ${id} ${ok ? 'AS REQUIRED' : 'FAILED     '} ${what}`);
    console.log(`     got: ${got}`);
  };

  // W1 — a free port, and it must not dawdle.
  {
    const t0 = Date.now();
    const r = waitForClusterPorts([PROOF_PORT], 5_000);
    const ms = Date.now() - t0;
    say('W1', r === null && ms < 2_000, 'a FREE port returns null, and returns fast', `${r === null ? 'null' : r} in ${String(ms)}ms`);
  }

  // W2 — a held port must be NAMED, and the wait must actually spend its budget.
  {
    const srv = await holdAsync(PROOF_PORT);
    const t0 = Date.now();
    const r = waitForClusterPorts([PROOF_PORT], 2_000);
    const ms = Date.now() - t0;
    srv.close();
    await new Promise<void>((res) => srv.once('close', () => res()));
    say(
      'W2',
      r !== null && r.includes(String(PROOF_PORT)) && ms >= 2_000,
      'a HELD port is named in the sentence, and the wait spends its budget',
      `${r ?? 'null'} in ${String(ms)}ms`,
    );
  }

  // W3 — the port coming free DURING the wait ends it. The holder is a CHILD
  // PROCESS, and that is not incidental: `sleepSync` uses `Atomics.wait`,
  // which blocks this thread's event loop, so a listener closed by a
  // `setTimeout` in THIS process could never be released while the wait ran.
  // The first version of this arm did exactly that and failed, measuring the
  // test's own design rather than the wait -- which is the arm doing its job.
  //
  // ROUND 22: the second version carried a comment saying it waited for the
  // child to hold the port, and waited for nothing. Two of five solo runs
  // read `null in 29ms` — the wait returned because the port was still FREE,
  // and the arm's own `ms >= 500` turned that into a FAILED row. It did not
  // fail open, but a ~40% red on an instrument is noise nobody can read, and
  // the comment was a false claim about this file. The child now ANNOUNCES
  // its listen on stdout, this process reads that line before the wait
  // starts, and a child that never announces makes the arm UNMEASURED rather
  // than failed: a holder that never held measures nothing either way.
  {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `const s=require('net').createServer();s.listen(${String(PROOF_PORT_2)},'127.0.0.1',()=>{process.stdout.write('UP\\n');setTimeout(()=>process.exit(0),1500);});`,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const up = await new Promise<boolean>((res) => {
      const timer = setTimeout(() => {
        res(false);
      }, 10_000);
      child.stdout.on('data', (b: Buffer) => {
        if (b.toString('utf8').includes('UP')) {
          clearTimeout(timer);
          res(true);
        }
      });
      child.once('exit', () => {
        clearTimeout(timer);
        res(false);
      });
    });
    if (!up) {
      child.kill();
      unmeasured += 1;
      console.log('  W3 UNMEASURED  the holder never announced its listen, so nothing was held and there was no wait to measure');
      console.log('     re-run this instrument alone; a holder that never held is not a verdict about the wait');
    } else {
      const t0 = Date.now();
      const r = waitForClusterPorts([PROOF_PORT_2], 20_000);
      const ms = Date.now() - t0;
      child.kill();
      say(
        'W3',
        r === null && ms >= 500 && ms < 10_000,
        'a port freed DURING the wait ends it, before the budget',
        `${r === null ? 'null' : r} in ${String(ms)}ms`,
      );
    }
  }

  // W4 — not a port. It must refuse, not poll NaN for the whole budget and
  // then report a holder that never existed.
  {
    const t0 = Date.now();
    const r = waitForClusterPorts([Number('not-a-port')], 8_000);
    const ms = Date.now() - t0;
    say('W4', r !== null && r.includes('not a port') && ms < 2_000, 'a value that is NOT a port refuses at once', `${r ?? 'null'} in ${String(ms)}ms`);
  }

  console.log('');
  if (unmeasured > 0) {
    console.log(`EXIT 2 — ${String(unmeasured)} arm(s) could not be set up, so this run is NOT a clean bill.`);
    console.log('  A proof that could not stage its own fixture measured nothing; re-run it alone.');
    return 2;
  }
  if (failures === 0) {
    console.log('All 4 arms behaved: a free port is fast, a held port is named and waited for,');
    console.log('  a port freed mid-wait ends it, and a non-port refuses instead of stalling.');
    console.log('  What this does NOT show: that any instrument needed the wait. It shows the');
    console.log('  wait is a mechanism and not a comment — which two green evidence runs did not.');
    return 0;
  }
  console.log(`EXIT 1 — ${String(failures)} of 4 arm(s) did not behave as required. A wait nobody can`);
  console.log('  test is a wait nobody has tested, which is the finding this instrument answers.');
  return 1;
}

main()
  .then((c) => {
    process.exitCode = c;
  })
  .catch((e: unknown) => {
    console.log(`EXIT 2 — the proof could not be set up: ${(e as Error).message}`);
    process.exitCode = 2;
  });
