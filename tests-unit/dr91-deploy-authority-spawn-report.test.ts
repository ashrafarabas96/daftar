/**
 * DR-91 — when the deployment-authority script cannot START a program, its
 * message must name why, and must not call it a signal.
 *
 * The defect this pins, measured on run 41823029477: ubuntu-26.04 ships
 * PostgreSQL 18.6 where ubuntu-24.04 shipped 16.15, so
 * `/usr/lib/postgresql/16/bin/initdb` — the path `PG_BIN` defaults to — was
 * simply absent. `spawnSync` then leaves `status` null and sets `error`, and
 * the script reported `res.status ?? 'signal'`, so an absent binary read as a
 * killed process. One root failure cascaded P3-S1..P3-S6, the Phase 3
 * corrective gate and P4-S1, and three sessions' worth of reading began from a
 * word the measurement never supported.
 *
 * `spawnSync` leaves `status` null in TWO unrelated cases — killed by a signal,
 * and never started — and only `error` tells them apart. That is the whole of
 * the fix, and the whole of what this file measures.
 *
 * The negative control is a path that does not exist, which is the owner's
 * requirement for this card and also the only way to reach the branch: the
 * subject cannot be imported, because the module runs `main()` at import, so
 * the script is executed as a program with `DEPLOY_PG_BIN` pointed at nothing.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const SCRIPT = join('scripts', 'phase2-deployment-authority.ts');
const TSX_ENTRY = join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');

// The project's own installed tsx, never `npx`, which fetches the newest
// release while this repository pins another one. And `node --import` rather
// than the `.bin` shim, so no `shell: true` is needed on Windows — a shell
// here would concatenate rather than escape the arguments.
const runWithBogusPgBin = (): { out: string; status: number | null } => {
  const res = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DEPLOY_PG_BIN: join(ROOT, 'no-such-postgres-bin-dr91') },
  });
  return { out: `${res.stdout ?? ''}${res.stderr ?? ''}`, status: res.status };
};

const SIGNAL_CLAIM = /failed \(signal\)/;

describe('DR-91: a program that cannot be started is not a program killed by a signal', () => {
  it('names the real reason, and never calls a failed spawn a signal', { timeout: 180_000 }, () => {
    expect(existsSync(TSX_ENTRY)).toBe(true);
    const { out, status } = runWithBogusPgBin();

    // Positive controls first. A probe that never reached the branch would
    // otherwise pass by producing nothing at all, which is this project's
    // most expensive recurring mistake.
    expect(out.length).toBeGreaterThan(0);
    expect(status).not.toBe(0);
    expect(out).toContain('initdb');
    expect(out).toContain('no-such-postgres-bin-dr91');

    // The claim under test.
    expect(out).toMatch(/ENOENT/);
    expect(out).not.toMatch(SIGNAL_CLAIM);
  });

  it('is not vacuous: the pattern it forbids does match the text it was taken from', () => {
    // The exact shape the 26.04 run printed. If this ever stops matching, the
    // assertion above has become decoration rather than a measurement.
    const asPrinted = '/usr/lib/postgresql/16/bin/initdb -D /tmp/x failed (signal):';
    expect(SIGNAL_CLAIM.test(asPrinted)).toBe(true);
  });
});
