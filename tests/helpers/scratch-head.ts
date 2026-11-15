/**
 * Is a scratch database built to the WHOLE migration set?
 *
 * "The whole set" is the head the migrations folder holds, so the expected
 * value is DERIVED by the caller (`headMigration()` in `scratch-db.ts`) and
 * never written down as a number — a number is true until the next migration
 * and then reds a suite before one assertion in it runs. The claim itself is
 * not weakened: a database built lower than the head, higher than it, or not
 * at all, is refused and named.
 *
 * Pure, so `tests-unit/scratch-head-assertion.test.ts` can plant each case
 * without a database.
 */
export function scratchHeadProblem(applied: readonly string[], expectedHead: string): string | null {
  const last = applied[applied.length - 1];
  if (last === undefined) return `no migration was applied, so the scratch database is not built to ${expectedHead}`;
  if (last !== expectedHead) return `the scratch database was not built to the head ${expectedHead} but to ${last}`;
  return null;
}
