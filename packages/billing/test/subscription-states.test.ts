/**
 * The pin between this package's restated vocabulary and its live sources.
 *
 * `types.ts` restates two things it does not own: the subscription state set
 * (owned by a database CHECK) and the money cap (owned by the accounting
 * authority). A restatement that nothing checks is a copy, and a copy drifts
 * in silence. These tests read the live sources and fail on any difference,
 * in both directions.
 *
 * Each extraction is also proved NON-VACUOUS before it is compared: an
 * extractor that found nothing would otherwise report "no difference" and
 * pass forever. That is the failure mode P4-S5 spent two review rounds on.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_BILLING_MINOR, SUBSCRIPTION_STATES } from '../src/types';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'infrastructure', 'database', 'migrations');

/**
 * The LIVE value set of `business_entitlements.state`.
 *
 * Every migration is scanned and the LAST definition by migration number
 * wins, because a later `ALTER TABLE … ADD CONSTRAINT` replaces an earlier
 * one. Reading the first match, or the last match in the first file that
 * happens to contain one, is how a slice ends up pinned to a definition the
 * database replaced three migrations ago.
 */
function liveSubscriptionStates(): { states: string[]; file: string } {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort(); // numeric prefixes are zero-padded, so lexical order is numeric order
  let found: { states: string[]; file: string } | null = null;
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    // Both shapes the project uses: the inline CHECK in the CREATE TABLE and
    // the named constraint added later. The capture runs to the closing paren
    // of the IN list, across newlines.
    const pattern = /state\s+IN\s*\(([^)]*)\)/gi;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(sql)) !== null) {
      const body = match[1];
      if (body === undefined) continue;
      const states = [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).filter((s): s is string => s !== undefined);
      if (states.length > 0) found = { states, file };
    }
  }
  if (!found) throw new Error('no CHECK (state IN (...)) was found in the migrations — the extractor has nothing to compare');
  return found;
}

describe('the subscription state set this package restates', () => {
  it('finds a live definition at all, in a file this slice did not write', () => {
    const live = liveSubscriptionStates();
    expect(live.states.length).toBeGreaterThanOrEqual(4);
    expect(live.file).toMatch(/^\d{4}_/);
  });

  it('is EXACTLY the live set, in both directions', () => {
    const live = liveSubscriptionStates();
    const restated = [...SUBSCRIPTION_STATES].sort();
    expect([...new Set(live.states)].sort()).toEqual(restated);
  });

  it('comes from the LAST definition, not the first — the live one', () => {
    // `0007` creates the table with four states; `0021` replaces the
    // constraint with nine. Pinning to `0007` would make this package reject
    // `grace_period`, which is the state dunning depends on. This test fails
    // if the extractor ever starts reading the earlier definition.
    const live = liveSubscriptionStates();
    expect(live.states).toContain('grace_period');
    expect(live.states).toContain('paused');
    expect(live.states.length).toBeGreaterThan(4);
  });

  it('declares no duplicates of its own', () => {
    expect(new Set(SUBSCRIPTION_STATES).size).toBe(SUBSCRIPTION_STATES.length);
  });
});

describe('the money cap this package restates', () => {
  it('equals the accounting authority MAX_MONEY_MINOR, read from its source', () => {
    const source = readFileSync(join(REPO_ROOT, 'packages', 'accounting', 'src', 'types.ts'), 'utf8');
    const match = /export const MAX_MONEY_MINOR\s*=\s*([^;]+);/.exec(source);
    expect(match, 'MAX_MONEY_MINOR was not found in the accounting authority — the extractor has nothing to compare').not.toBeNull();
    const expression = match?.[1]?.trim();
    expect(expression).toBe('10n ** 18n');
    expect(MAX_BILLING_MINOR).toBe(10n ** 18n);
  });
});
