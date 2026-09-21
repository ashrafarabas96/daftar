import { ensurePostgres } from './test-app';

/** Vitest global setup: start shared PostgreSQL once per run (forks ping-reuse it). */
export default async function setup(): Promise<void> {
  await ensurePostgres();
}
