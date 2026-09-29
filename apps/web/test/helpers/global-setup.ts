// FIRST, before anything else: make sure a failing run can still say so.
// This is the first line of tests/helpers/global-setup.ts, without
// ensurePostgres — no web test touches a database.
import { protectFailingExitCode } from '../../../../tests/helpers/exit-code';

protectFailingExitCode();

/** Vitest global setup for the web runner: nothing else to start. */
export default function setup(): void {}
