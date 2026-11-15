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

/** The one table whose `state` CHECK this package restates. */
const ENTITLEMENTS_TABLE = 'business_entitlements';

/** One `CHECK (state IN (...))` found in the migrations, with the table it constrains. */
interface StateCheck {
  readonly file: string;
  readonly table: string;
  readonly states: string[];
}

/**
 * The statement a byte offset belongs to, named by its table.
 *
 * SQL has no block structure to lean on, so the owning statement is found by
 * the NEAREST PRECEDING `CREATE TABLE` / `ALTER TABLE` anchor. That is the
 * only thing in the file that says which table the next constraint belongs
 * to. Scoping by FILE instead is not the same question and does not answer
 * it: `0088` both names `business_entitlements` (a foreign key) and defines
 * `subscription_invoices.state`, so a file-level filter admits the invoice
 * states. An optional schema qualifier (`public.`) and quoting are stripped,
 * because `public.subscription_invoices` and `subscription_invoices` are one
 * table.
 */
const TABLE_ANCHOR =
  /\b(?:CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE(?:\s+IF\s+EXISTS)?(?:\s+ONLY)?)\s+("?[A-Za-z_][\w$]*"?\s*\.\s*)?("?[A-Za-z_][\w$]*"?)/gi;

function bareTableName(raw: string): string {
  return raw.replace(/"/g, '').trim().toLowerCase();
}

function owningTableAt(sql: string, offset: number): string | null {
  TABLE_ANCHOR.lastIndex = 0;
  let owner: string | null = null;
  let anchor: RegExpExecArray | null;
  while ((anchor = TABLE_ANCHOR.exec(sql)) !== null) {
    if (anchor.index >= offset) break;
    const name = anchor[2];
    if (name !== undefined) owner = bareTableName(name);
  }
  return owner;
}

/**
 * Every `CHECK (… state IN (…))` in the migrations, in migration order, each
 * one labelled with the table it actually constrains.
 *
 * The match must be a CHECK on the column itself: a `WHERE state IN (…)`
 * inside a function body, and a trigger's `NEW.state IN (…)`, are reads of
 * the column, not definitions of its domain, and `0088` contains both. The
 * value list is read case-sensitively as written, so an upper-case domain
 * (`'DRAFT'`) is reported rather than silently dropped to an empty list —
 * an extractor that drops what it cannot read is the vacuity this file
 * exists to prevent.
 */
function stateChecksInMigrations(dir: string = MIGRATIONS_DIR): StateCheck[] {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort(); // numeric prefixes are zero-padded, so lexical order is numeric order
  const checks: StateCheck[] = [];
  for (const file of files) {
    const sql = readFileSync(join(dir, file), 'utf8');
    const pattern = /CHECK\s*\(\s*(?:[^()]{0,200}?\b)?state\b\s*(?:::\s*[A-Za-z_][\w$]*\s*)?IN\s*\(([^)]*)\)/gi;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(sql)) !== null) {
      const body = match[1];
      if (body === undefined) continue;
      const states = [...body.matchAll(/'([A-Za-z_]+)'/g)].map((m) => m[1]).filter((s): s is string => s !== undefined);
      if (states.length === 0) continue;
      const table = owningTableAt(sql, match.index);
      if (table === null) continue;
      checks.push({ file, table, states });
    }
  }
  return checks;
}

/**
 * The LIVE value set of `business_entitlements.state`.
 *
 * Only CHECKs on THAT table are considered, and the LAST one by migration
 * number wins, because a later `ALTER TABLE … ADD CONSTRAINT` replaces an
 * earlier one. Reading the first match, or the last match anywhere in the
 * last file that happens to contain one, is how a slice ends up pinned to a
 * definition the database replaced — or, as `0088` proved, to another
 * table's domain entirely.
 */
function liveSubscriptionStates(): { states: string[]; file: string; table: string } {
  const mine = stateChecksInMigrations().filter((check) => check.table === ENTITLEMENTS_TABLE);
  const found = mine.at(-1);
  if (found === undefined) {
    throw new Error(`no CHECK (state IN (...)) on ${ENTITLEMENTS_TABLE} was found in the migrations — the extractor has nothing to compare`);
  }
  return found;
}

describe('the subscription state set this package restates', () => {
  it('finds a live definition at all, in a file this slice did not write', () => {
    const live = liveSubscriptionStates();
    expect(live.table).toBe(ENTITLEMENTS_TABLE);
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

  it('reads the entitlements table ONLY, and not another table that also has a `state` CHECK', () => {
    // The guard this asserts is not hypothetical: the extractor used to take
    // the last `state IN (...)` in the last migration file, and `0088` made
    // that `subscription_invoices` — so this package was being pinned to the
    // INVOICE state domain. The scan must therefore have work to do (other
    // tables are present) and must still land on the entitlements table.
    const all = stateChecksInMigrations();
    const mine = all.filter((check) => check.table === ENTITLEMENTS_TABLE);
    const others = all.filter((check) => check.table !== ENTITLEMENTS_TABLE);

    expect(all.length).toBeGreaterThan(0);
    expect(mine.length).toBeGreaterThanOrEqual(2); // `0007` defines, `0021` replaces
    expect(others.length).toBeGreaterThan(0); // the filter is exercised, not vacuous
    expect(others.map((check) => check.table)).toContain('subscription_invoices');

    const live = new Set(liveSubscriptionStates().states);
    // The two values that are invoice-only. Their presence here would mean
    // the invoice CHECK had been read as the subscription CHECK again.
    expect(live.has('voided')).toBe(false);
    expect(live.has('uncollectible')).toBe(false);
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
