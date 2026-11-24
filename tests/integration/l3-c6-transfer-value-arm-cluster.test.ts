/**
 * C6 — THE TRANSFER'S VALUE ARM, PROVED ON A REAL CLUSTER.
 *
 * `0093` registers a new guard in `inventory_stock_source_guard_gaps()` and
 * asserts, in the migration itself, that the registry reports no gap. That
 * assertion covers the trigger by table, name, event, deferral, enabled state,
 * owner, SECURITY DEFINER, pinned `search_path` AND the SHA-256 of the
 * function's `prosrc` — so a wrong digest or a wrong trigger shape fails the
 * APPLY rather than passing quietly.
 *
 * This file does not trust that silence (RULE-29): it builds a throw-away
 * database to the head, reads the registry back, and reads the trigger's own
 * row out of `pg_trigger` and `pg_proc` so the numbers in the migration's
 * header are measured rather than asserted by their own author.
 *
 * WHAT THIS FILE DOES NOT CARRY, AND WHO DOES CARRY IT NOW. The behavioural
 * control — a COMPLETE transfer whose movements do not cancel, so the law is
 * SEEN refusing — is no longer owed and no longer a question for the
 * coordinator: it is in `l3-c6-transfer-value-behaviour.test.ts` on this
 * branch, where §1 plants a one-minor-unit imbalance and asserts the refusal BY
 * NAME, §2 commits the same shape balanced, §3 plants a two-line document that
 * sums to zero while each line is out by 50 in opposite directions, and §4
 * commits that same two-line shape balanced. The owner-level harness that was
 * missing is `seedOwnerTransfer` and `seedOwnerTransferLines` in
 * `tests/helpers/stock-ledger.ts`.
 *
 * An earlier form of this comment said the control was "owed" and left the
 * choice with the coordinator, and it stayed that way after the branch itself
 * delivered it. Two independent reviews of `798d6cdb` flagged it, and both were
 * right to: in this project a comment is read as a measurement record, so a
 * stale one UNDERSTATES this branch's own coverage and keeps a settled question
 * open. What this file does carry is the textual and registry half, which is
 * the half a cluster cannot prove.
 */
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScratchDb, urlOf, type ScratchDb } from '../helpers/scratch-db';

let db: ScratchDb;
let client: Client;

beforeAll(async () => {
  db = await createScratchDb('daftar_l3_c6_transfer_value');
  client = new Client({ connectionString: urlOf(db.name, 'postgres') });
  await client.connect();
}, 900_000);

afterAll(async () => {
  await client?.end();
  await db?.drop();
});

// HOISTED TO MODULE SCOPE, so the two describes name these triggers from ONE
// declaration. They were declared inside the ordering describe, and §1b below
// — added in the same breath as this move — referred to `CONSERVE` from the
// other block and died with `ReferenceError: CONSERVE is not defined`. The
// alternative was to write the trigger name again as a literal, which is a
// second source of truth for an identifier: the thing this suite exists to
// forbid elsewhere.
const COMPLETE = 'stock_source_complete_inventory_transfer';
const CONSERVE = 'transfer_value_conserved_per_line';

describe('C6 — the transfer value arm on a cluster', () => {
  it('§1 the migration set applies, and the guard registry reports NO gap', async () => {
    const gaps = await client.query<{ source_type: string; missing: string }>('SELECT source_type, missing FROM inventory_stock_source_guard_gaps()');
    expect(gaps.rows, 'a gap here names the guard the registry demands and the database does not have').toEqual([]);
  });

  it('§1b THE CONTROL FOR §1: drop the trigger and the registry NAMES the gap, so that zero is sighted', async () => {
    // §1 asserts an EMPTY gap list, and an empty list cannot tell two very
    // different worlds apart: "the registry demands this guard and the database
    // has it" and "the registry never demanded it at all". Delete the registry
    // row at `0093:317` alone and §1 stays green, §2 stays green (the trigger
    // is still there with its digest), and the whole behavioural suite stays
    // green (the law still fires) — so nothing in this branch would have
    // noticed. The independent review of 94ef0108 named it, and the precedent
    // is in this repository's own words at `0077:1223`:
    //   "Before this replacement a sale bridge whose line foreign key pointed
    //    at the wrong table was reported as no gap at all"
    // — the same shape, already paid for once.
    //
    // So: inside a transaction this case rolls back, drop the guard and require
    // the registry to name EXACTLY the pair it reserved for it. That is what
    // makes §1's zero a measurement (RULE-3, charter §5: an absence claim needs
    // a positive control).
    await client.query('BEGIN');
    let named: readonly { source_type: string; missing: string }[] = [];
    try {
      await client.query(`DROP TRIGGER ${CONSERVE} ON inventory_transfer_lines`);
      const gaps = await client.query<{ source_type: string; missing: string }>('SELECT source_type, missing FROM inventory_stock_source_guard_gaps()');
      named = gaps.rows;
    } finally {
      await client.query('ROLLBACK');
    }

    // Asserted AFTER the rollback so a failure here cannot leave the schema
    // altered, and named one field at a time: a whole-object compare would also
    // pass if both fields were wrong together.
    expect(named.length, 'dropping the guard produced NO gap — the registry does not demand it, and §1 was blind').toBe(1);
    expect(named[0]?.source_type, 'the gap must be reported for the transfer source').toBe('inventory_transfer');
    expect(named[0]?.missing, 'the gap must name the reserved guard slot, not some other one').toBe('value_complete');

    // And the live schema is back: the same query §1 runs must be empty again,
    // or this control has damaged the subject it was measuring.
    const after = await client.query<{ source_type: string; missing: string }>('SELECT source_type, missing FROM inventory_stock_source_guard_gaps()');
    expect(after.rows, 'the rollback took the drop with it').toEqual([]);
  }, 300_000);

  it('§2 the new trigger exists with the shape the registry recorded, and its body digest matches', async () => {
    const r = await client.query<{
      tgname: string;
      tgtype: number;
      deferred: boolean;
      owner: string;
      secdef: boolean;
      proconfig: string[] | null;
      digest: string;
    }>(
      `SELECT g.tgname, g.tgtype::int AS tgtype,
              (g.tgconstraint <> 0 AND g.tgdeferrable AND g.tginitdeferred) AS deferred,
              r.rolname AS owner, p.prosecdef AS secdef, p.proconfig,
              encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') AS digest
         FROM pg_trigger g
         JOIN pg_proc p ON p.oid = g.tgfoid
         JOIN pg_roles r ON r.oid = p.proowner
        WHERE g.tgrelid = 'public.inventory_transfer_lines'::regclass
          AND g.tgname = 'transfer_value_conserved_per_line' AND NOT g.tgisinternal`,
    );
    const row = r.rows[0];
    expect(row, 'the trigger must exist before its shape can be judged').toBeDefined();
    expect(row?.tgtype, 'AFTER INSERT, FOR EACH ROW — the shape the registry records as 5, on the LINES table so the completeness guard speaks first').toBe(5);
    expect(row?.deferred, 'a deferred constraint trigger, because the movements are written after the header').toBe(true);
    expect(row?.owner).toBe('daftar_inventory_internal');
    expect(row?.secdef, 'SECURITY DEFINER').toBe(true);
    expect(row?.proconfig, 'the pinned search_path').toEqual(['search_path=pg_catalog, public, pg_temp']);
    // THE DIGEST MOVED WITH THE BODY, and this literal is SUPPOSED to be a
    // tripwire rather than a derivation: reading it out of the migration file
    // would make the assertion agree with any body, which is the opposite of
    // what it is for. So it is pinned, and it moves by hand when the body
    // moves, with both values named (DR-103/7):
    //
    //   OLD  c211ab86ac19c1f886367cff71f6c7656448b853bcf502c4090b0f40e30a9cfc
    //   NEW  bfdb2f2b98d8ccbe0f829b1b65e2bf2660828d2e1c1a0e88b29b832789e0a33d
    //
    // AND IT MOVED AGAIN, for a REASON worth recording rather than a value:
    // a narrow round of a6a8fb51 found a sentence still inside the body that
    // stated the REJECTED design -- "The sum is still the whole document's,
    // not the line's" -- twenty lines above the block that says the subject
    // is the line. Deleting prose changes `prosrc`, so the digest moved a
    // third time. The chain, so no reader has to reconstruct it:
    //   first   c211ab86ac19c1f886367cff71f6c7656448b853bcf502c4090b0f40e30a9cfc   (document-wide body)
    //   then    bfdb2f2b98d8ccbe0f829b1b65e2bf2660828d2e1c1a0e88b29b832789e0a33d   (per-line body, stale prose)
    //   now     49e7db9679170a7cf272ff61e8eca14a731cb5f89b0f87cc843817b4b5f6b725   (per-line body, prose corrected)
    //
    // The body changed because `0093`'s conservation became PER LINE: the
    // queries gained `AND b.source_line_id = NEW.id` and the leg count became
    // exactly two, after the independent review of 798d6cdb found the sum was
    // taken over the whole document while the trigger is named `..._per_line`.
    // Run 44107148875 failed on THIS line alone -- the only failure in 6683
    // cases -- which is the tripwire doing its job: a third place pinned the
    // digest and I had moved only two of them (the migration's own c_digest
    // and nothing else). `row?.digest` is computed by POSTGRES over the stored
    // `prosrc`, and it returned exactly the value my local extraction had
    // computed, so the extraction method proved against the old digest also
    // agrees with the database.
    expect(row?.digest, 'the digest 0093 recorded for this body').toBe('49e7db9679170a7cf272ff61e8eca14a731cb5f89b0f87cc843817b4b5f6b725');
  });

  it('§3 the schema floor constant names the head this build ships', async () => {
    const head = db.applied[db.applied.length - 1];
    expect(head, 'the head of the applied set').toBe('0093_c6_transfer_value_conservation.sql');
  });
});

/**
 * THE ORDER IS THE LAW, NOT THE NAME.
 *
 * CI 43831620333 measured the fault this pins: with the guard on the HEADER it
 * fired before `stock_source_complete_inventory_transfer` and answered for a
 * refusal that mechanism owns (`inventory-s3-transfer.test.ts` T-05, the §E
 * nine-state vector under H-6). The repair was to hang it off
 * `inventory_transfer_lines` under a name that sorts AFTER that guard's, since
 * PostgreSQL fires triggers of one event in alphabetical order by name.
 *
 * But a repair that rests on alphabetical order and is asserted only by its
 * own name is a guard with no law behind it: any later rename, however well
 * meant, brings the fault back silently. So this asserts the ORDER and the
 * three things that make the order mean anything — one relation, one event,
 * one deferral class — because alphabetical order decides nothing between an
 * immediate trigger and a deferred one.
 */
describe('C6 — the firing order the repair rests on', () => {
  interface TrigRow {
    readonly tgname: string;
    readonly tgtype: number;
    readonly is_constraint: boolean;
    readonly tgdeferrable: boolean;
    readonly tginitdeferred: boolean;
  }

  async function pairOrderedByName(names: readonly string[]): Promise<readonly TrigRow[]> {
    const r = await client.query<TrigRow>(
      `SELECT g.tgname, g.tgtype::int AS tgtype, (g.tgconstraint <> 0) AS is_constraint,
              g.tgdeferrable, g.tginitdeferred
         FROM pg_trigger g
        WHERE g.tgrelid = 'public.inventory_transfer_lines'::regclass
          AND NOT g.tgisinternal AND g.tgname = ANY($1::text[])
        ORDER BY g.tgname`,
      [names],
    );
    return r.rows;
  }

  // WHY SORTING BY NAME IS NOT A TAUTOLOGY HERE, and what it still does not do.
  // `ORDER BY g.tgname` trivially returns name order; the CLAIM is that
  // completeness's name sorts before conservation's, and for row-level triggers
  // on the SAME relation, event and timing PostgreSQL fires in name order — so
  // the order asserted below IS the firing order, which is why the arm also
  // pins `tgtype` and the relation rather than the names alone. What it does
  // NOT do is observe a firing sequence directly, and it says nothing about a
  // third trigger added later in a different timing or deferral class: that
  // would be outside the pair this arm is about. The behaviour itself
  // ("completeness speaks first") is measured by `inventory-s3-transfer.test.ts`
  // T-05, which this branch does not reproduce.
  it('§4 completeness sorts BEFORE conservation, on one relation, one event and one deferral class', async () => {
    const rows = await pairOrderedByName([COMPLETE, CONSERVE]);
    expect(rows.length, 'both triggers must exist on inventory_transfer_lines before their order can mean anything').toBe(2);
    const first = rows[0];
    const second = rows[1];
    expect(first?.tgname, 'the mechanism that owns the incomplete-set refusal must be fired first').toBe(COMPLETE);
    expect(second?.tgname).toBe(CONSERVE);
    // Same event, or the order says nothing about which one judges an insert.
    expect(second?.tgtype, `both must be AFTER INSERT FOR EACH ROW; got ${String(first?.tgtype)} and ${String(second?.tgtype)}`).toBe(first?.tgtype);
    // Same deferral class, for the same reason: an immediate trigger fires at
    // the statement and a deferred one at COMMIT, and no name ordering bridges
    // that.
    for (const row of rows) {
      expect(
        [row.is_constraint, row.tgdeferrable, row.tginitdeferred],
        `${row.tgname} must be a DEFERRABLE INITIALLY DEFERRED constraint trigger for the name order to decide anything`,
      ).toEqual([true, true, true]);
    }
  });

  it('§5 and the order law can fail: renamed to sort first, the predicate breaks', async () => {
    // THE NEGATIVE CONTROL. A rename inside a transaction this case rolls
    // back, so the live schema is untouched — asserted afterwards by reading
    // the pair back.
    const probe = 'aaa_value_conserved_order_probe';
    await client.query('BEGIN');
    try {
      await client.query(`ALTER TRIGGER ${CONSERVE} ON inventory_transfer_lines RENAME TO ${probe}`);
      const rows = await pairOrderedByName([COMPLETE, probe]);
      expect(rows.length, 'the rename must have taken, or this control proves nothing').toBe(2);
      expect(rows[0]?.tgname, 'under a name that sorts first the conservation guard would fire FIRST again, which is exactly the fault CI measured').toBe(
        probe,
      );
    } finally {
      await client.query('ROLLBACK');
    }
    const after = await pairOrderedByName([COMPLETE, CONSERVE]);
    expect(
      after.map((r) => r.tgname),
      'the rollback took the rename with it',
    ).toEqual([COMPLETE, CONSERVE]);
  });
});
