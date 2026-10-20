/**
 * PHASE 15 — THE CLUSTER-PORT WAIT, in a module of its own.
 *
 * It lives here rather than in `run-evidence-log.ts` for one measured reason:
 * that file runs its `main()` at import time, so the red proof below could not
 * import the wait without driving the entire evidence inventory as a side
 * effect. A mechanism nothing can import is a mechanism nothing can test, and
 * round 21's F-R21-15 is exactly that finding.
 *
 * `verify:port-wait:prove` is the instrument that measures what is here.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import ts from 'typescript';

const ROOT = join(import.meta.dirname, '../..');

/**
 * AN INSTRUMENT IS NOT FINISHED UNTIL THE PORTS IT HELD ARE FREE.
 *
 * **Corrected after round 21 (F-R21-07). The first version of this comment,
 * and of `6c574eb`'s commit message, asserted a mechanism that the pack's own
 * port map contradicts, and the correction belongs here rather than in a
 * document nobody reads beside the code.** What was claimed: `pg_ctl stop`
 * returns before the socket closes, and in the `ed26e00` run the next cluster
 * instrument started inside that gap. What is measured:
 *
 * * Port 55432 is bound by `tests/helpers/embedded-cluster.ts` and by nothing
 *   else in this inventory — every phase15 cluster instrument owns a private
 *   port, and `pg-cluster.ts` says in as many words that it never touches
 *   55432. So "the previous instrument's postmaster" cannot have held it.
 * * The instrument before it in that run was `pitr:proof:prove`, on
 *   55473-55475, and it had returned **117 ms** earlier
 *   (`19:33:44.474Z` against `19:33:44.591Z`, bind failure at `19:33:48.772`).
 * * The 55432 cluster is stopped by `EmbeddedPostgres`, not by `pg_ctl`, so
 *   the `pg_ctl stop` gap is not even the right mechanism for that port.
 *
 * **The holder of 55432 at 19:33:48 is UNIDENTIFIED and is recorded as such.**
 * The event is measured; its cause is not. What the wait is therefore good for
 * is narrower than first claimed: it catches a leftover holder before an
 * instrument that needs the port, whoever left it.
 *
 * It also used to wait on ONE port, which was the one port only the LAST
 * instrument ever binds — while the ports two CONSECUTIVE instruments really
 * do share (`dr:proof` then `dr:proof:prove` on 55471/55472; `pitr:proof`
 * then `pitr:proof:prove` on 55473-55475) got no wait at all. The set is now
 * DERIVED from the pack's own sources rather than hand-listed, so an
 * instrument that takes a new port is covered by the next run and not by an
 * edit somebody has to remember.
 *
 * This REMOVES a cause of the failure; it does not replace the classifier rule
 * that CATCHES it. A port held by something outside this runner outlasts any
 * wait, and `SERVER_BIND_FAILURE` is what reads that.
 */
const PORT_WAIT_MS = 30_000;
const PORT_POLL_MS = 500;

/**
 * Every cluster port this pack declares, read from its own sources.
 *
 * A hand-kept list is a second place to forget, and this pack's rule is to
 * derive a subject set rather than retype it. The ports are five-digit
 * literals in the 55xxx block the project reserves for its disposable
 * clusters; the shared vitest helper is read too, because that is where 55432
 * comes from and it is the port that actually failed.
 *
 * READ FROM THE SYNTAX TREE, NOT FROM THE TEXT (round 22, F-R22-11). A regex
 * over the bytes got this wrong in both directions at once, and the challenger
 * measured both in the pack's own source: it admitted **55900**, which nothing
 * binds and which appears only inside two COMMENTS -- one of them the sentence
 * saying no instrument declares that block -- and it lost **55901** and
 * **55902**, which `port-wait-proof.ts` really does bind, because they are
 * written `55_901` and `55_902` and `\b55\d{3}\b` does not match across a
 * numeric separator. A comment is prose and a separator is formatting; a
 * NUMERIC LITERAL is neither. So the set is now the numeric literals the
 * parser finds, whose VALUE falls in the block -- comments are not literals,
 * and `55_901` is one literal worth 55901.
 */
// The block's own bounds are COMPUTED, not written. Written as `55_000` and
// `55_999` they are numeric literals in the block, in a file this function
// reads -- so the first version of the syntax-tree reader declared 55000 and
// 55999 as cluster ports, out of its own range check. A reader that reads
// itself has to be written so that there is nothing of itself to read.
const BLOCK_LO = 55 * 1000;
const BLOCK_HI = BLOCK_LO + 999;

export function declaredClusterPorts(): readonly number[] {
  const found = new Set<number>();
  const files = [
    ...readdirSync(join(ROOT, 'scripts/phase15'))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => join(ROOT, 'scripts/phase15', f)),
    join(ROOT, 'tests/helpers/embedded-cluster.ts'),
  ];
  for (const f of files) {
    let text = '';
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const sf = ts.createSourceFile(basename(f), text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const walk = (n: ts.Node): void => {
      if (ts.isNumericLiteral(n)) {
        const v = Number(n.text.replace(/_/g, ''));
        if (Number.isInteger(v) && v >= BLOCK_LO && v <= BLOCK_HI) found.add(v);
      }
      // A port can also be written as a string, `'55432'`, which is how a URL
      // or an env default carries one.
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) for (const m of n.text.matchAll(/(?<!\d)(55\d{3})(?!\d)/g)) found.add(Number(m[1]));
      n.forEachChild(walk);
    };
    walk(sf);
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * A SYNCHRONOUS sleep, because this runner is synchronous end to end: it drives
 * children with `spawnSync` so that the record is written in the order the
 * instruments ran. `Atomics.wait` on a buffer nobody else can reach is the one
 * way to wait here without burning the CPU and without pulling in a sleep
 * binary, which would make the record depend on one more thing in the
 * container.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function portIsFree(port: number): boolean {
  // A port that is not a port is not "busy": refuse rather than poll a NaN for
  // thirty seconds and then report a held port that never existed (round 21,
  // F-R21-13 -- `PG_PORT=foo` did exactly that).
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`not a port: ${String(port)}`);
  const probe = `const s=require('net').createServer();s.once('error',()=>process.exit(1));s.listen(${String(port)},'127.0.0.1',()=>s.close(()=>process.exit(0)));`;
  const r = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', timeout: 5_000 });
  return r.status === 0;
}

/**
 * Returns null when every declared port is free, or a sentence naming those
 * that are not. Exported for the proof: a wait nobody can test is a wait
 * nobody has tested (round 21, F-R21-15).
 */
export function waitForClusterPorts(ports: readonly number[], budgetMs = PORT_WAIT_MS): string | null {
  const started = Date.now();
  let held: number[] = [];
  for (;;) {
    held = [];
    for (const p of ports) {
      try {
        if (!portIsFree(p)) held.push(p);
      } catch (e) {
        return `${(e as Error).message} -- the port set is wrong, so nothing was waited for`;
      }
    }
    if (held.length === 0) return null;
    if (Date.now() - started >= budgetMs) break;
    sleepSync(PORT_POLL_MS);
  }
  return `port(s) ${held.join(', ')} still bound after ${String(Math.round((Date.now() - started) / 1000))}s`;
}
