// FIRST, before anything can register a shutdown hook: make sure a failing run
// can still say so. See tests/helpers/exit-code.ts for what goes wrong without
// it and why every gate's verdict depends on this line.
import { protectFailingExitCode } from './exit-code';

import { ensurePostgres } from './test-app';

protectFailingExitCode();

/** Vitest global setup: start shared PostgreSQL once per run (forks ping-reuse it). */
export default async function setup(): Promise<void> {
  await ensurePostgres();
}
