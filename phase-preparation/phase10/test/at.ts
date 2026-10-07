/**
 * Indexed access that states its own failure instead of asserting non-null.
 *
 * The repository forbids `!` (`@typescript-eslint/no-non-null-assertion`), and
 * for good reason: in a test, `xs[3]!.code` on a short array reports
 * "cannot read property of undefined" rather than "the list was shorter than
 * the test assumed". This says which.
 */
export function at<T>(xs: readonly T[], index: number): T {
  const value = xs[index];
  if (value === undefined) {
    throw new Error(`index ${index} is absent from a list of length ${xs.length}`);
  }
  return value;
}
