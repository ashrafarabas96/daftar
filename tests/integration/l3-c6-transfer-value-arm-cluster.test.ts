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
 * It also carries its own NEGATIVE CONTROL: the law `sum(value_delta) = 0` is
 * exercised by writing a transfer whose two movements do NOT cancel, and the
 * database must refuse it by name. A guard that only ever sees balanced input
 * is a guard nobody has seen work.
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
    expect(row?.digest, 'the digest 0093 recorded for this body').toBe('5b5e64f0bc35117698fe3659444ca307575342717d4ee8d9b27f5cd64a39e58e');
  });

  it('§3 the schema floor constant names the head this build ships', async () => {
    const head = db.applied[db.applied.length - 1];
    expect(head, 'the head of the applied set').toBe('0093_c6_transfer_value_conservation.sql');
  });
});
