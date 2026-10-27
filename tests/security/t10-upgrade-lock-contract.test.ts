import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * T-10: what the tree actually resolves, not what it is allowed to resolve.
 *
 * Every version in this batch was chosen because a specific advisory or a
 * specific behaviour required it. A caret range says only that npm MAY pick
 * that version; the lock says what it DID pick, and the lock is what CI
 * installs and what ships. Asserting the range would let a future `npm
 * update` walk the tree off these versions while this suite stayed green —
 * which is precisely how a security batch quietly comes undone.
 *
 * These are floors, not pins: a newer resolution is allowed and expected.
 * What is not allowed is sliding BACK below the version the advisory named.
 * `zod` is the exception that is pinned exactly, because the whole batch
 * hangs on its DoS advisory and the error-contract tests were written
 * against its short-circuit behaviour.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

interface Lock {
  packages?: Record<string, { version?: string }>;
}
interface Manifest {
  dependencies?: Record<string, string>;
  overrides?: Record<string, string>;
}

const lock = JSON.parse(readFileSync(`${ROOT}package-lock.json`, 'utf8')) as Lock;
const manifest = JSON.parse(readFileSync(`${ROOT}package.json`, 'utf8')) as Manifest;

function resolved(name: string): string {
  const entry = lock.packages?.[`node_modules/${name}`];
  const version = entry?.version;
  if (version === undefined) throw new Error(`${name} has no resolved version in package-lock.json`);
  return version;
}

/** Compare `a` to `b` numerically, segment by segment; prerelease tags are not in play here. */
function atLeast(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

const FLOORS: ReadonlyArray<readonly [string, string, string]> = [
  ['next', '15.5.28', 'the advisory this batch closes'],
  ['sharp', '0.35.5', 'image decoding, reached by every upload'],
  ['multer', '2.5.0', 'the multipart parser in front of the upload route'],
  ['vite', '7.3.7', 'build toolchain'],
  ['vitest', '4.1.12', 'the runner these assertions themselves run on'],
  ['nodemailer', '10.1.4', 'the only mail transport in the product'],
  ['postcss', '8.5.28', 'declared through an override'],
  ['body-parser', '2.4.0', 'declared through an override'],
];

describe('T-10: the lock, not the range', () => {
  for (const [name, floor, why] of FLOORS) {
    it(`${name} resolves to at least ${floor} — ${why}`, () => {
      const got = resolved(name);
      expect(atLeast(got, floor), `${name} resolved to ${got}, below the ${floor} this batch requires`).toBe(true);
    });
  }

  it('zod resolves to exactly 4.6.7 — the DoS advisory floor AND the behaviour the error-contract tests were written against', () => {
    // Pinned both ways on purpose: below it the advisory is open, and above
    // it the short-circuit behaviour those tests deliberately left unpinned
    // could move under them without anyone choosing that.
    expect(resolved('zod')).toBe('4.6.7');
  });

  it('nodemailer is declared exactly, not as a range', () => {
    // A minor release of the mail transport is a behavioural change in the
    // one path that carries credentials and tokens. It moves when someone
    // decides it moves.
    expect(manifest.dependencies?.['nodemailer']).toBe('10.1.4');
  });

  it('every override is an exact version, so an override cannot drift the thing it was added to hold', () => {
    for (const [name, spec] of Object.entries(manifest.overrides ?? {})) {
      expect(/^\d+\.\d+\.\d+$/.test(spec), `override ${name} is "${spec}", which is a range`).toBe(true);
    }
  });

  it('no second copy of a batched package is hiding deeper in the tree below its floor', () => {
    // A nested `node_modules/x/node_modules/y` is the classic way a fixed
    // advisory stays live: the top-level copy is new, the one actually
    // imported by a dependency is not.
    const offenders: string[] = [];
    for (const [path, entry] of Object.entries(lock.packages ?? {})) {
      const match = /(?:^|\/)node_modules\/([^/]+)$/.exec(path);
      const name = match?.[1];
      if (name === undefined || path === `node_modules/${name}`) continue;
      const floor = FLOORS.find(([n]) => n === name)?.[1] ?? (name === 'zod' ? '4.6.7' : undefined);
      const version = entry.version;
      if (floor !== undefined && version !== undefined && !atLeast(version, floor)) offenders.push(`${path}@${version} < ${floor}`);
    }
    expect(offenders, `nested copies below their floor: ${offenders.join(', ')}`).toEqual([]);
  });
});
