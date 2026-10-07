/**
 * P4-S4 — THE PAGE READER'S `ROWS` ESTIMATE IS COUPLED TO THE ENDPOINT'S
 * LIMIT CAP, AND THE COUPLING IS LOAD-BEARING.
 * (`0084` R-108 and `0084-E(4)`; `apps/api/src/modules/selling/selling.schemas.ts`
 *  the `limit` validator; P4-AL-74.)
 *
 * ── WHY THE CLAUSE EXISTS AT ALL ──────────────────────────────────────────
 *
 * `customer_open_invoices_page` is a set-returning `plpgsql` routine carrying a
 * `SET search_path`, so PostgreSQL can neither inline it nor see through it:
 * every call plans as an opaque `Function Scan`. With no `ROWS` clause the
 * planner falls back to its default estimate of **1 000 rows**, and measured on
 * PostgreSQL 16.13 that made it plan the app's bounded join back onto
 * `invoices` as a **Hash Join over a sequential scan of every invoice in the
 * business** — the very shape `0084`'s Correction 1 removes from the two AR
 * readers, reappearing one level up.
 *
 * `ROWS 51` turns that into 51 `invoices_pkey` loops. It is not a tuning guess:
 * it is the EXACT upper bound on what the routine can return, because the
 * endpoint's `limit` validator caps the page at 50 and the reader is asked for
 * `limit + 1` so the caller can tell whether another page exists.
 *
 * ── WHAT THIS FILE PROTECTS, AND WHY IT IS A SEPARATE TEST ────────────────
 *
 * The clause's correctness depends on a number that lives in a DIFFERENT FILE,
 * in a different language, with nothing between them. Raise the validator's cap
 * to 100 and `ROWS 51` silently becomes an estimate half the truth; lower it and
 * the estimate becomes loose. Neither breaks an answer — an estimate cannot —
 * which is exactly why nothing else would report it, and why a plan regression
 * found months later would be read as a planner mood rather than as this edit.
 *
 * So the coupling is asserted as a coupling: the cap is read from the SCHEMA by
 * exercising it, the estimate is read from the CATALOGUE, and the claim is that
 * one is the other plus one. The `+ 1` is named here as the probe, so a reader
 * meeting `52` knows which half moved.
 *
 * `0084-E(4)` already asserts `prorows = 51` inside the migration. That is a
 * different claim: it says the migration applied what it meant to. This says the
 * number is still the RIGHT number. A migration cannot make that claim, because
 * the file it depends on can change after the migration is frozen.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool } from '../helpers/test-app';
import { CustomerOpenInvoicesQuerySchema } from '../../apps/api/src/modules/selling/selling.schemas';

/** The largest `limit` the endpoint accepts, discovered by exercising the validator rather than read off its source. */
function endpointLimitCap(): number {
  let highest = 0;
  for (let n = 1; n <= 120; n += 1) {
    if (CustomerOpenInvoicesQuerySchema.safeParse({ asOf: '2026-01-01', limit: String(n) }).success) highest = n;
  }
  return highest;
}

describe('P4-S4 the open-invoice page reader’s ROWS estimate — coupled to the endpoint’s limit cap', () => {
  beforeAll(async () => {
    await ensurePostgres();
  });
  afterAll(async () => {
    // `ownerPool()` is shared by the estate; closing it here would break
    // whatever runs next in the same worker.
  });

  it('the subject exists: the page reader is in the catalogue and the validator accepts a bounded limit', async () => {
    const found = await ownerPool().query<{ sig: string; prorows: number }>(
      `SELECT p.oid::regprocedure::text AS sig, p.prorows::int AS prorows
         FROM pg_proc p WHERE p.proname = 'customer_open_invoices_page'`,
    );
    expect(found.rowCount, 'customer_open_invoices_page is not in the catalogue, so this file has no subject (0084 absent?)').toBe(1);
    const cap = endpointLimitCap();
    expect(cap, 'the limit validator accepts nothing at all, so the cap below would be meaningless').toBeGreaterThan(0);
    // A cap of 120 would mean the probe never found the ceiling.
    expect(cap, 'the validator accepted every value probed, so the real cap is above the probe range and unknown').toBeLessThan(120);
  });

  it('THE COUPLING: prorows equals the endpoint’s limit cap plus one, which is the `limit + 1` probe', async () => {
    const cap = endpointLimitCap();
    const row = await ownerPool().query<{ prorows: number }>(`SELECT p.prorows::int AS prorows FROM pg_proc p WHERE p.proname = 'customer_open_invoices_page'`);
    const prorows = row.rows[0]?.prorows;
    expect(
      prorows,
      `If this is red, one of two numbers moved and they are in different files. The endpoint's limit cap ` +
        `(apps/api/src/modules/selling/selling.schemas.ts, the \`limit\` validator) is now ${cap}, so the page ` +
        `reader can return at most ${cap + 1} rows — the cap plus the one extra row openInvoices asks for to ` +
        `decide whether a next page exists. Its ROWS clause says ${String(prorows)}. The answer is NOT to relax ` +
        `this assertion: a ROWS estimate that is no longer the real bound brings back the Hash Join over a ` +
        `sequential scan of every invoice in the business that 0084 R-108 measured and removed. Correct the ` +
        `ROWS clause in a NEW appended migration to ${cap + 1}, or put the cap back.`,
    ).toBe(cap + 1);
  });

  it('the ONE definition deliberately keeps the default estimate — no ROWS clause was added to it (0084 R-108)', async () => {
    // The array form is called with anything from one id to a whole fat tail,
    // so no single constant is right for it; 0084 R-108 refuses to declare one
    // rather than declaring one that is wrong on one side. This asserts that
    // refusal is still in force, because "add ROWS to the other one too" is the
    // obvious next edit and it would be a mistake.
    const rows = await ownerPool().query<{ sig: string; prorows: number }>(
      `SELECT p.oid::regprocedure::text AS sig, p.prorows::int AS prorows
         FROM pg_proc p WHERE p.proname = 'invoice_outstanding' ORDER BY 1`,
    );
    expect(rows.rowCount, 'invoice_outstanding has lost one of its two forms').toBe(2);
    for (const r of rows.rows) {
      expect(
        r.prorows,
        `${r.sig} carries a ROWS estimate. 0084 R-108 refuses one on the settlement sum: it is called with ` +
          `one id and with thousands, so a constant is wrong on one side. If a later slice has evidence for ` +
          `one, it owes the measurement on BOTH arms, not this assertion's removal.`,
      ).toBe(1000);
    }
  });
});
