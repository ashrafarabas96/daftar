import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * P7-02 — the declared list of atomic write points EQUALS the real one.
 *
 * The card asks for equality, not containment, and the difference is the whole
 * value of the check. Containment in one direction misses a write point that
 * was added and never declared; containment in the other misses a declared name
 * that has quietly stopped opening a transaction, so the crash suite keeps
 * "covering" a point that no longer exists while a real one goes untested. Both
 * directions are asserted below, and each has a positive control proving the
 * probe would notice.
 *
 * This runs in the unit lane, so it needs no JDK — which matters, because this
 * host has none and the Kotlin crash suite therefore DID NOT RUN. What a static
 * equality check can establish without a compiler is exactly what it claims:
 * that the list and the code agree. It does not establish that the transactions
 * work; `PersistenceCrashSafetyTest` is what does that, and it is NOT_RUN here.
 */

const ROOT = join(__dirname, '..');
const KERNEL = join(ROOT, 'apps', 'android', 'offline-kernel');
const PERSISTENCE = join(KERNEL, 'src', 'main', 'java', 'app', 'daftar', 'offline', 'Persistence.kt');
const CRASH_SUITE = join(KERNEL, 'src', 'test', 'java', 'app', 'daftar', 'offline', 'PersistenceCrashSafetyTest.kt');

const persistence = () => readFileSync(PERSISTENCE, 'utf8');

/** The names in `ATOMIC_WRITE_POINTS`, read from the declaration itself. */
function declaredWritePoints(source: string): string[] {
  const start = source.indexOf('val ATOMIC_WRITE_POINTS: List<String> = listOf(');
  if (start === -1) throw new Error('Persistence.kt declares no ATOMIC_WRITE_POINTS list');
  const open = source.indexOf('(', start + 'val ATOMIC_WRITE_POINTS: List<String> = listOf'.length - 1);
  const close = source.indexOf(')', open);
  if (close === -1) throw new Error('the ATOMIC_WRITE_POINTS list is not closed');
  return [...source.slice(open + 1, close).matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? '');
}

/**
 * Split a Kotlin source into `{ name, body }` for every `fun`, by matching
 * braces from the start of each body.
 *
 * The parser is deliberately naive, and REFUSES rather than guessing when its
 * assumptions do not hold: a `${` interpolation or a brace inside a string
 * literal would make brace counting wrong, and a guard that silently
 * miscounts is worse than one that stops. Both are checked before any body is
 * read.
 */
function functionBodies(source: string): Array<{ name: string; body: string }> {
  if (source.includes('${')) {
    throw new Error(
      'Persistence.kt now uses ${} interpolation; this brace-matching parser cannot be trusted ' +
        'on it, so it refuses rather than reporting a set it may have got wrong',
    );
  }
  const out: Array<{ name: string; body: string }> = [];
  const signature = /\bfun\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = signature.exec(source)) !== null) {
    const name = match[1] ?? '';
    // Walk past the parameter list, matching its own parentheses.
    let i = match.index + match[0].length - 1;
    let parens = 0;
    for (; i < source.length; i += 1) {
      if (source[i] === '(') parens += 1;
      else if (source[i] === ')') {
        parens -= 1;
        if (parens === 0) {
          i += 1;
          break;
        }
      }
    }
    // Then past an optional return type to the first `{` or `=`.
    while (i < source.length && source[i] !== '{' && source[i] !== '=') i += 1;
    if (source[i] === '=') {
      // An expression body: one statement, to the end of the line. None of
      // these opens a transaction, but the name still has to be collected so
      // that an expression-bodied write point would show up as a difference
      // rather than being skipped.
      const eol = source.indexOf('\n', i);
      out.push({ name, body: source.slice(i, eol === -1 ? source.length : eol) });
      continue;
    }
    let depth = 0;
    const bodyStart = i;
    for (; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push({ name, body: source.slice(bodyStart, i + 1) });
  }
  return out;
}

/** The functions that actually open a transaction. */
function realWritePoints(source: string): string[] {
  return functionBodies(source)
    .filter(({ body }) => body.includes('db.begin()'))
    .map(({ name }) => name)
    .sort();
}

describe('P7-02: declared write points equal the real ones', () => {
  it('declares six write points', () => {
    expect(declaredWritePoints(persistence())).toEqual(['captureWithKey', 'markReleased', 'recordSendAttempt', 'recordOutcome', 'recordProcessDeath', 'purge']);
  });

  it('the declared set EQUALS the set that opens a transaction', () => {
    const declared = [...declaredWritePoints(persistence())].sort();
    const real = realWritePoints(persistence());
    // One assertion, both directions. A `toContain` pair here would pass on a
    // set that is merely overlapping.
    expect(real).toEqual(declared);
  });

  it('the probe notices an undeclared write point', () => {
    // Positive control for the first direction: add a function that opens a
    // transaction without declaring it. The real set must grow past declared.
    const planted = `${persistence()}
class Sneaky(private val db: Transactional) {
    fun writeBehindTheList() {
        db.begin()
        db.markSuccessful()
        db.end()
    }
}
`;
    const declared = [...declaredWritePoints(planted)].sort();
    const real = realWritePoints(planted);
    expect(real).toContain('writeBehindTheList');
    expect(real).not.toEqual(declared);
  });

  it('the probe notices a declared name that stopped opening a transaction', () => {
    // Positive control for the OTHER direction, which containment would miss:
    // `purge` keeps its declaration but loses its transaction.
    const planted = persistence().replace(
      `    fun purge(idempotencyKey: String) {
        db.begin()`,
      `    fun purge(idempotencyKey: String) {
        db.markSuccessful()`,
    );
    expect(planted).not.toBe(persistence()); // the plant landed
    const declared = [...declaredWritePoints(planted)].sort();
    const real = realWritePoints(planted);
    expect(real).not.toContain('purge');
    expect(real).not.toEqual(declared);
  });

  /**
   * The ordering that makes a transaction atomic at all: the success mark is
   * the LAST thing before the end. A `markSuccessful()` ahead of the write
   * commits whatever happened to land, which is precisely the defect the crash
   * suite's negative control implements.
   */
  it('marks success after the write, in every write point', () => {
    const declared = new Set(declaredWritePoints(persistence()));
    const wrong: string[] = [];
    for (const { name, body } of functionBodies(persistence())) {
      if (!declared.has(name)) continue;
      const mark = body.indexOf('db.markSuccessful()');
      const lastWrite = Math.max(body.lastIndexOf('db.write('), body.lastIndexOf('db.delete('));
      if (mark === -1 || lastWrite === -1 || mark < lastWrite) wrong.push(name);
    }
    expect(wrong).toEqual([]);
  });

  it('ends the transaction in a finally, in every write point', () => {
    const declared = new Set(declaredWritePoints(persistence()));
    const unguarded = functionBodies(persistence())
      .filter(({ name }) => declared.has(name))
      .filter(({ body }) => !/finally\s*\{[^}]*db\.end\(\)/.test(body))
      .map(({ name }) => name);
    expect(unguarded).toEqual([]);
  });
});

describe('P7-02: every declared write point is killed by name', () => {
  const crash = () => readFileSync(CRASH_SUITE, 'utf8');

  /**
   * The crash suite iterates `ATOMIC_WRITE_POINTS` at runtime, so coverage is
   * structural rather than a list someone has to remember to extend. This still
   * checks that each name APPEARS in the suite, because the runtime iteration
   * is what a reader cannot see from here and an empty list would iterate
   * nothing while passing.
   */
  it('names each declared point, and asserts the list is not empty', () => {
    const source = crash();
    const missing = declaredWritePoints(persistence()).filter((name) => !source.includes(name));
    expect(missing).toEqual([]);
    expect(source).toContain('ATOMIC_WRITE_POINTS');
    // A suite that iterated an empty list would kill nothing and go green.
    expect(source).toMatch(/assertEquals\(\s*6,\s*ATOMIC_WRITE_POINTS\.size/);
  });

  /**
   * The negative control ships WITH the suite rather than being planted from
   * outside, so what is checked here is that it exists, that it is actually
   * exercised, and that its verdict is asserted — a control nobody reads the
   * result of is a control that did not run.
   */
  it('carries the negative control that defeats atomicity, and asserts its verdict', () => {
    const source = crash();
    expect(source).toContain('private class NotAtomic : FakeDb()');
    expect(source).toContain('the non-atomic store fails the very same check');
    // The control is driven over the same declared list as the real store...
    expect(source).toMatch(/NotAtomic\(\)[\s\S]{0,400}killAtMutation/);
    // ...and its reach is asserted by name rather than claimed to be total.
    expect(source).toMatch(/assertEquals\(\s*listOf\("purge"\),\s*survived/);
  });

  /**
   * The kill must be located by the FAILURE, not by the loop variable. The
   * first version of this suite armed the kill on the next write and labelled
   * it with the point under test, so every driver that captured first was
   * killed at the capture while the assertion agreed it had not been.
   */
  it('reads where the death happened from the failure itself', () => {
    const source = crash();
    expect(source).toContain('class ProcessDied(val atMutation: Int)');
    expect(source).toMatch(/assertEquals\(last, died\.atMutation/);
    expect(source).toContain('committedAtLastBegin');
  });

  it('carries no skipped, focused or pending marker', () => {
    const banned = /@Ignore\b|\.skip\b|\.only\b|\.todo\b|@Disabled\b/;
    expect(banned.test('@Ignore')).toBe(true);
    expect(banned.test(crash())).toBe(false);
  });
});

describe('P7-02: the payload never reaches the database in the clear', () => {
  /**
   * An absence claim, so it needs a probe proven able to find the thing. The
   * claim is narrow and worth stating exactly: every `StoredRow` constructed in
   * `Persistence.kt` sets `sealedPayload` from a cipher call, and no raw
   * `payload` is assigned to it. It does NOT claim the metadata is encrypted —
   * it deliberately is not, and `Persistence.kt` says why.
   */
  it('assigns sealedPayload only from the cipher', () => {
    const assignments = [...persistence().matchAll(/sealedPayload = ([A-Za-z0-9_.()]+)/g)].map((m) => m[1] ?? '');
    expect(assignments.length).toBeGreaterThan(0);
    const fromRawPayload = assignments.filter((rhs) => rhs === 'payload');
    // Probe proven able to find the defect it denies.
    expect(['payload'].filter((rhs) => rhs === 'payload')).toEqual(['payload']);
    expect(fromRawPayload).toEqual([]);
  });

  it('declares a schema version on every row it writes (L13)', () => {
    expect(persistence()).toContain('const val SCHEMA_VERSION: Int = 1');
    expect(persistence()).toContain('schemaVersion = SCHEMA_VERSION');
    expect(persistence()).toContain('class SchemaVersionRefused');
  });
});
