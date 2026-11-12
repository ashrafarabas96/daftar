import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The OTHER half of DR-84's gate: not "does the app depend on the kernel", but
 * "does anything in the kernel's own production code reach the open door".
 *
 * `Operation.capture` accepts any non-empty string as a digest (`Queue.kt`), and
 * an `Operation` holds no bytes, so it cannot verify one. That is tolerable only
 * while nothing but tests calls it: the seal file rests the whole DR-84
 * argument on exactly that sentence, and until now the sentence was a grep
 * somebody ran once, dated to a commit that is no longer the head. A claim a
 * financial gate rests on has to be a law a run can fail (RULE-3).
 *
 * So it is one here. While the tracked decision record says OPEN, the kernel's
 * `src/main` may contain the DECLARATION of `capture` and nothing else: no
 * production caller. When the record says CLOSED -- the day the store's
 * verified digest is wired in, which is an owner decision -- the law lifts,
 * because by then the caller is the wiring and the digest comes from the
 * bytes.
 *
 * The matcher's own positive control is the test tree: the same words, run over
 * `src/test`, must find many callers. A sweep that finds none anywhere is a
 * broken sweep reading as a clean tree, which is the failure mode this project
 * has been bitten by more than once (RULE-11, RULE-18).
 */

const MODULE = join(__dirname, '..', 'apps', 'android', 'offline-kernel');
const MAIN = join(MODULE, 'src', 'main', 'java');
const TEST = join(MODULE, 'src', 'test', 'java');
const RECORD = join(__dirname, '..', 'docs', 'decisions', '2026-11-04-dr84-capture-digest-gate.md');

function statusOf(recordText: string): 'OPEN' | 'CLOSED' {
  const m = /^\*\*Status:\s*(OPEN|CLOSED)\*\*$/m.exec(recordText);
  if (m === null) throw new Error('the decision record states no machine-readable status');
  return m[1] as 'OPEN' | 'CLOSED';
}

function kotlinFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.kt')) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

/**
 * Comments are removed before the sweep, and removed as RANGES rather than as
 * whole lines: a `capture(` sitting after code on the same line as a trailing
 * comment must still be seen, and a `capture(` inside a KDoc block must not be
 * (the unnumbered rule: flatten the prose first, or the sweep answers about the
 * wrong text).
 */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '');
}

/**
 * Every line that CALLS `capture`, which is every `capture(` that is not the
 * declaration and not a longer name that merely starts with it
 * (`captureWithKey`, `captureSale`).
 */
export function captureCallLines(text: string): string[] {
  const lines = stripComments(text).split('\n');
  const out: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (!/(?<![A-Za-z0-9_])capture\s*\(/.test(line)) continue;
    if (/\bfun\s+capture\s*\(/.test(line)) continue;
    out.push(`${index + 1}: ${line.trim()}`);
  }
  return out;
}

export function declarationLines(text: string): string[] {
  return stripComments(text)
    .split('\n')
    .map((line, i) => [i + 1, line] as const)
    .filter(([, line]) => /\bfun\s+capture\s*\(/.test(line))
    .map(([n, line]) => `${n}: ${line.trim()}`);
}

describe('DR-84: the words of the law, measured on synthetic text', () => {
  it('a production caller is an offence', () => {
    expect(captureCallLines('val op = Operation.capture(key, scope, e, d, null, null)\n')).toHaveLength(1);
  });

  it('the declaration itself is not an offence', () => {
    expect(captureCallLines('        fun capture(\n')).toEqual([]);
    expect(declarationLines('        fun capture(\n')).toHaveLength(1);
  });

  it('the store door `captureWithKey` is a different name and is not an offence', () => {
    expect(captureCallLines('    store.captureWithKey(key, op, bytes)\n')).toEqual([]);
    expect(captureCallLines('    fun captureWithKey(\n')).toEqual([]);
  });

  it('a mention inside a comment is not a call', () => {
    expect(captureCallLines('// nothing reaches Operation.capture(...) except tests\n')).toEqual([]);
    expect(captureCallLines('/**\n * Operation.capture(key, ...) is the open door.\n */\n')).toEqual([]);
  });

  it('a call after a trailing comment on a line of code is still a call', () => {
    expect(captureCallLines('val op = Operation.capture(k, s, e, d, null, null) // minted here\n')).toHaveLength(1);
  });

  it('a name that merely ends in capture is not this function', () => {
    expect(captureCallLines('    recapture(key)\n')).toEqual([]);
  });
});

describe('DR-84: the law on this tree', () => {
  const mainFiles = kotlinFiles(MAIN);
  const testFiles = kotlinFiles(TEST);
  const read = (p: string): string => readFileSync(p, 'utf8');

  it('the subject is the kernel, and it is not empty', () => {
    expect(mainFiles.length).toBeGreaterThan(5);
    expect(mainFiles.every((p) => read(p).length > 0)).toBe(true);
  });

  it("the sweep can see a call at all — the test tree's callers are the positive control", () => {
    const calls = testFiles.flatMap((p) => captureCallLines(read(p)));
    expect(calls.length).toBeGreaterThan(10);
  });

  it('the declaration is in the production tree exactly once', () => {
    const declared = mainFiles.flatMap((p) => declarationLines(read(p)).map((l) => `${p}:${l}`));
    expect(declared).toHaveLength(1);
    expect(declared[0]).toContain('Queue.kt');
  });

  it('the record still says OPEN, so the law is live', () => {
    expect(statusOf(read(RECORD))).toBe('OPEN');
  });

  it('NO production file calls `capture` while the record is OPEN', () => {
    const offenders = mainFiles.flatMap((p) => captureCallLines(read(p)).map((l) => `${p}:${l}`));
    expect(offenders).toEqual([]);
  });
});
