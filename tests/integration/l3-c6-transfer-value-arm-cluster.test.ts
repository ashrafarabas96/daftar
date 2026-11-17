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

describe('C6 — the transfer value arm on a cluster', () => {
  it('§1 the migration set applies, and the guard registry reports NO gap', async () => {
    const gaps = await client.query<{ source_type: string; missing: string }>('SELECT source_type, missing FROM inventory_stock_source_guard_gaps()');
    expect(gaps.rows, 'a gap here names the guard the registry demands and the database does not have').toEqual([]);
  });

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
    expect(row?.digest, 'the digest 0093 recorded for this body').toBe('c211ab86ac19c1f886367cff71f6c7656448b853bcf502c4090b0f40e30a9cfc');
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
  const COMPLETE = 'stock_source_complete_inventory_transfer';
  const CONSERVE = 'transfer_value_conserved_per_line';

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
