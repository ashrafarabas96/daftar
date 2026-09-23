import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pidFileHeld } from '../helpers/test-app';

/**
 * A crashed postmaster must not lock the suite out forever.
 *
 * `postmaster.pid` survives a crash, a `kill -9` and a container restart. The
 * shared-server guard used to read the file's EXISTENCE, so one abnormal exit
 * made every later run wait out its attempts and fail with "did not become
 * usable within 6s" — permanently, until somebody deleted the file by hand.
 * That is exactly what happened mid-slice, and it is the kind of defect §3 of
 * the directive is about: a harness that cannot recover from a crash cannot
 * report anything, so its silence is not evidence of anything either.
 *
 * The guard now asks the operating system whether the named postmaster is
 * still alive. These are the three answers it can get.
 */
describe('a stale postmaster.pid does not hold the data directory', () => {
  const dirs: string[] = [];
  const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'daftar-pidfile-'));
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('is not held when there is no file at all', () => {
    expect(pidFileHeld(scratch())).toBe(false);
  });

  it('IS held while the named postmaster is alive', () => {
    const dir = scratch();
    // This process is unquestionably alive, and is the one asking.
    writeFileSync(join(dir, 'postmaster.pid'), `${process.pid}\n${dir}\n1790168620\n`);
    expect(pidFileHeld(dir)).toBe(true);
    expect(existsSync(join(dir, 'postmaster.pid'))).toBe(true);
  });

  it('is NOT held when the named postmaster is gone, and the leftovers are cleared', () => {
    const dir = scratch();
    // A pid that cannot be running: the kernel reserves nothing above the max,
    // and 0x7fffffff is above every configured pid_max in practice.
    writeFileSync(join(dir, 'postmaster.pid'), `2147483646\n${dir}\n1790168620\n`);

    expect(pidFileHeld(dir)).toBe(false);
    // …and the file is gone, so the next start can take the directory. Leaving
    // it would hand PostgreSQL its own lock-file refusal instead.
    expect(existsSync(join(dir, 'postmaster.pid'))).toBe(false);
  });

  it('is not held when the file names nothing readable', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'postmaster.pid'), 'not a pid\n');
    expect(pidFileHeld(dir)).toBe(false);
  });
});
