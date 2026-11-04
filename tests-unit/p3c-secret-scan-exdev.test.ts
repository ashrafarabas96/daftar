/**
 * THE PINNED GITLEAKS MUST REACH ITS CACHE ACROSS A FILESYSTEM BOUNDARY.
 *
 * `ensureGitleaks` downloads the pinned gitleaks into a temporary directory
 * under `os.tmpdir()`, verifies two digests, and moves it into
 * `node_modules/.cache`. `rename(2)` cannot cross a filesystem, and on the
 * `ubuntu26/20261101.64` runner image those two paths are on different
 * devices: the step died with `EXDEV: cross-device link not permitted` before
 * a single commit was scanned (measured on job 126623991768; the same step
 * passed on image `ubuntu26/20261025.179`). An environment failure in a
 * security gate reads exactly like a clean gate that found nothing, which is
 * why this is a defect and not an inconvenience.
 *
 * The fallback is deliberately narrow: `EXDEV` alone falls back to a copy.
 * Any other error is rethrown, because a gate that swallows errors is not a
 * gate — the second case below is that control, and it fails if the catch is
 * ever widened.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moveIntoPlace } from '../scripts/phase3-secret-scan';

const BODY = 'the pinned gitleaks binary, stood in for by these bytes\n';

let work: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'p3c-exdev-'));
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

function seed(name: string): string {
  const src = join(work, name);
  writeFileSync(src, BODY);
  chmodSync(src, 0o755);
  return src;
}

function exdev(): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error('EXDEV: cross-device link not permitted, rename');
  error.code = 'EXDEV';
  return error;
}

describe('moveIntoPlace', () => {
  it('falls back to a copy when the rename crosses a filesystem', () => {
    const src = seed('a-src');
    const dest = join(work, 'a-dest');
    moveIntoPlace(src, dest, () => {
      throw exdev();
    });
    expect(readFileSync(dest, 'utf8')).toBe(BODY);
    expect(existsSync(src)).toBe(false);
  });

  it('NEGATIVE CONTROL: any other error still brings the scan down', () => {
    const src = seed('b-src');
    const dest = join(work, 'b-dest');
    const denied: NodeJS.ErrnoException = new Error('EACCES: permission denied, rename');
    denied.code = 'EACCES';
    expect(() =>
      moveIntoPlace(src, dest, () => {
        throw denied;
      }),
    ).toThrow(denied);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(src)).toBe(true);
  });

  it('NEGATIVE CONTROL: an error with no code at all is still thrown', () => {
    const src = seed('c-src');
    const dest = join(work, 'c-dest');
    expect(() =>
      moveIntoPlace(src, dest, () => {
        throw new Error('something the filesystem did not explain');
      }),
    ).toThrow('something the filesystem did not explain');
    expect(existsSync(dest)).toBe(false);
  });

  it('does not copy when the rename succeeds', () => {
    const src = seed('d-src');
    const dest = join(work, 'd-dest');
    moveIntoPlace(src, dest, (from, to) => {
      rmSync(from);
      writeFileSync(to, 'RENAMED');
    });
    // The copy fallback would have written BODY here.
    expect(readFileSync(dest, 'utf8')).toBe('RENAMED');
  });

  it('moves the file with the real rename when nothing is injected', () => {
    const src = seed('e-src');
    const dest = join(work, 'e-dest');
    moveIntoPlace(src, dest);
    expect(readFileSync(dest, 'utf8')).toBe(BODY);
    expect(existsSync(src)).toBe(false);
  });
});
