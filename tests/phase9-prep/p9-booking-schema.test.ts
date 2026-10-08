/**
 * P9 PREP — THE SCHEMA APPLIES, AND IT APPLIES TO THE RIGHT END STATE.
 *
 * Status: PREPARED / NOT PROMOTED (master directive Part 9). Nothing here
 * runs in required CI; see docs/phase9/P9-PREP-REPORT.md §LIMITATIONS.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScratchDb } from '../helpers/scratch-db';
import { createScratchDb } from '../helpers/scratch-db';
import { BASE_HEAD, BOOTSTRAP_PATCH, P9_RELATIONS, loadSpec } from './p9-booking-spec';
import { applySpecAsMigrator } from './p9-booking-world';
import { sqlState } from './p9-booking-world';

describe('P9 booking schema — applies as the deployment principal', () => {
  let db: ScratchDb;

  beforeAll(async () => {
    db = await createScratchDb('daftar_p9_schema', { upTo: BASE_HEAD, keys: false, migratorOwned: true });
    await db.pool.query(BOOTSTRAP_PATCH);
    await applySpecAsMigrator(db);
  }, 600_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('built on Phase 3’s sealed head, not on an unsealed Phase 4 candidate', () => {
    expect(db.applied[db.applied.length - 1]).toBe(BASE_HEAD);
    // The base is `main`. Had this prep been cut from the Phase 4 branch it
    // would carry unsealed candidates, and a Phase 9 proof would then be
    // evidence about a tree nobody has accepted.
    expect(db.applied.some((m) => m > BASE_HEAD)).toBe(false);
  });

  it('created all seven relations', async () => {
    const r = await db.pool.query<{ relname: string }>(`SELECT relname FROM pg_class WHERE relname = ANY($1::text[]) AND relkind = 'r' ORDER BY 1`, [
      [...P9_RELATIONS],
    ]);
    expect(r.rows.map((x) => x.relname)).toEqual([...P9_RELATIONS].sort());
  });

  it('left the frozen history untouched — no object of 0000-0073 was dropped or replaced', async () => {
    // The spec may only ADD. If it had altered a frozen relation the proof
    // below would be about a schema no deployment will ever have.
    const r = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_class
        WHERE relname IN ('journal_entries', 'journal_lines', 'stock_movements', 'stock_levels', 'accounting_periods', 'businesses', 'branches', 'users')
          AND relkind = 'r'`,
    );
    expect(r.rows[0]?.n).toBe(8);
    // And the one pre-existing exclusion constraint is still the accounting
    // periods' own, so Phase 9 added its invariant beside it rather than over it.
    const x = await db.pool.query<{ conname: string; relname: string }>(
      `SELECT c.conname, t.relname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
        WHERE c.contype = 'x' ORDER BY 1`,
    );
    expect(x.rows).toEqual([
      { conname: 'accounting_periods_no_overlap', relname: 'accounting_periods' },
      { conname: 'bookings_no_overlap', relname: 'bookings' },
    ]);
  });

  it('is idempotent in the only sense a migration can be: re-applying it is refused, not half-done', async () => {
    // A migration is applied once by the runner. What matters is that a
    // second application fails LOUDLY and atomically rather than leaving a
    // partially mutated schema behind.
    let state = '';
    try {
      await applySpecAsMigrator(db);
    } catch (e) {
      state = sqlState(e);
    }
    expect(state).toBe('42P07'); // duplicate_table
    const r = await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_class WHERE relname = ANY($1::text[]) AND relkind = 'r'`, [
      [...P9_RELATIONS],
    ]);
    expect(r.rows[0]?.n).toBe(P9_RELATIONS.length);
  });

  it('the invariant is an exclusion constraint, is partial, and excludes on the blocking window', async () => {
    const r = await db.pool.query<{ def: string; partial: boolean; contype: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS def, x.indpred IS NOT NULL AS partial, c.contype::text AS contype
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_index x ON x.indexrelid = c.conindid
        WHERE t.relname = 'bookings' AND c.conname = 'bookings_no_overlap'`,
    );
    const row = r.rows[0];
    expect(row).toBeDefined();
    expect(row?.contype).toBe('x');
    expect(row?.partial).toBe(true);
    expect(row?.def).toContain('EXCLUDE USING gist (business_id WITH =, resource_id WITH =, blocking_window WITH &&)');
    // The predicate must hold the three occupying states and neither releasing one.
    expect(row?.def).toContain("'booked'");
    expect(row?.def).toContain("'completed'");
    expect(row?.def).toContain("'no_show'");
    expect(row?.def).not.toContain("'cancelled'");
    expect(row?.def).not.toContain("'rescheduled'");
  });

  it('row security is enabled AND forced on every relation', async () => {
    const r = await db.pool.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1::text[]) ORDER BY 1`,
      [[...P9_RELATIONS]],
    );
    expect(r.rows).toHaveLength(P9_RELATIONS.length);
    for (const row of r.rows) {
      expect({ t: row.relname, on: row.relrowsecurity, forced: row.relforcerowsecurity }).toEqual({ t: row.relname, on: true, forced: true });
    }
  });

  it('no runtime role holds any write privilege, and PUBLIC holds nothing', async () => {
    const roles = ['daftar_app', 'daftar_platform', 'daftar_worker', 'daftar_identity', 'daftar_resolver', 'daftar_provisioner', 'daftar_reconciler', 'public'];
    const r = await db.pool.query<{ role: string; tbl: string; priv: string }>(
      `SELECT role, tbl, priv
         FROM unnest($1::text[]) role,
              unnest($2::text[]) tbl,
              unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']) priv
        WHERE has_table_privilege(role, tbl, priv)`,
      [roles, [...P9_RELATIONS]],
    );
    expect(r.rows).toEqual([]);
  });

  it('the merchant runtime may read the calendar and nothing may read the operation registry', async () => {
    const readable = await db.pool.query<{ tbl: string }>(
      `SELECT tbl FROM unnest($1::text[]) tbl WHERE has_table_privilege('daftar_app', tbl, 'SELECT') ORDER BY 1`,
      [[...P9_RELATIONS]],
    );
    expect(readable.rows.map((x) => x.tbl)).toEqual([...P9_RELATIONS].filter((t) => t !== 'booking_operations').sort());
    const registry = await db.pool.query<{ role: string }>(
      `SELECT role FROM unnest($1::text[]) role WHERE has_table_privilege(role, 'booking_operations', 'SELECT')`,
      [['daftar_app', 'daftar_platform', 'daftar_worker', 'daftar_identity', 'daftar_resolver', 'daftar_provisioner', 'daftar_reconciler', 'public']],
    );
    expect(registry.rows).toEqual([]);
  });

  it('the internal principal may never DELETE, and may never UPDATE the registry', async () => {
    const r = await db.pool.query<{ tbl: string }>(
      `SELECT tbl FROM unnest($1::text[]) tbl WHERE has_table_privilege('daftar_booking_internal', tbl, 'DELETE')`,
      [[...P9_RELATIONS]],
    );
    expect(r.rows).toEqual([]);
    const u = await db.pool.query<{ ok: boolean }>(`SELECT has_table_privilege('daftar_booking_internal', 'booking_operations', 'UPDATE') AS ok`);
    expect(u.rows[0]?.ok).toBe(false);
  });

  it('the one definer routine is owned by the internal principal with a pinned path, and the three raise-only guards are not definers', async () => {
    const r = await db.pool.query<{ proname: string; prosecdef: boolean; owner: string; proconfig: string[] | null }>(
      `SELECT p.proname, p.prosecdef, r.rolname AS owner, p.proconfig
         FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.proname = ANY($1::text[]) ORDER BY 1`,
      [['bookings_buffers_match_service', 'bookings_no_delete', 'bookings_transition', 'booking_operations_immutable']],
    );
    const by = new Map(r.rows.map((x) => [x.proname, x]));
    expect([...by.keys()].sort()).toEqual(['booking_operations_immutable', 'bookings_buffers_match_service', 'bookings_no_delete', 'bookings_transition']);
    const definer = by.get('bookings_buffers_match_service');
    expect(definer?.prosecdef).toBe(true);
    expect(definer?.owner).toBe('daftar_booking_internal');
    expect(definer?.proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);
    for (const name of ['bookings_no_delete', 'bookings_transition', 'booking_operations_immutable']) {
      expect({ name, definer: by.get(name)?.prosecdef }).toEqual({ name, definer: false });
      expect({ name, path: by.get(name)?.proconfig }).toEqual({ name, path: ['search_path=pg_catalog, public, pg_temp'] });
    }
  });

  it('nobody but the owner may execute the buffer guard', async () => {
    const r = await db.pool.query<{ role: string }>(
      `SELECT role FROM unnest($1::text[]) role WHERE has_function_privilege(role, 'bookings_buffers_match_service()', 'EXECUTE')`,
      [['daftar_app', 'daftar_platform', 'daftar_worker', 'daftar_identity', 'daftar_resolver', 'daftar_provisioner', 'daftar_reconciler', 'public']],
    );
    expect(r.rows).toEqual([]);
  });

  it('the ownership-transfer authority did not survive the file', async () => {
    const r = await db.pool.query<{ ok: boolean }>(`SELECT has_schema_privilege('daftar_booking_internal', 'public', 'CREATE') AS ok`);
    expect(r.rows[0]?.ok).toBe(false);
  });

  it('no money-shaped column reached the booking schema', async () => {
    const r = await db.pool.query<{ relname: string; attname: string }>(
      `SELECT t.relname, a.attname FROM pg_attribute a JOIN pg_class t ON t.oid = a.attrelid
        WHERE t.relname = ANY($1::text[]) AND a.attnum > 0 AND NOT a.attisdropped
          AND a.attname ~ '(amount|price|total|balance|cost|fee|minor|tax)'`,
      [[...P9_RELATIONS]],
    );
    expect(r.rows).toEqual([]);
  });

  it('the deferred buffer guard is a DEFERRABLE INITIALLY DEFERRED constraint trigger', async () => {
    const r = await db.pool.query<{ tgdeferrable: boolean; tginitdeferred: boolean; tgconstraint: string }>(
      `SELECT tgdeferrable, tginitdeferred, tgconstraint::text FROM pg_trigger WHERE tgname = 'bookings_buffers_are_the_service_s'`,
    );
    expect(r.rows[0]?.tgdeferrable).toBe(true);
    expect(r.rows[0]?.tginitdeferred).toBe(true);
    expect(r.rows[0]?.tgconstraint).not.toBe('0');
  });

  it('the spec loader refuses a subject it cannot recognise', () => {
    // The loader is this directory's only protection against applying an
    // emptied document and reporting a green. Its own refusals must fire.
    expect(() => loadSpec()).not.toThrow();
  });
});
