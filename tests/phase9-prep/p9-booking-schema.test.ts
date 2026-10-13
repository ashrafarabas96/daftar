/**
 * P9 PREP — THE SCHEMA APPLIES, AND IT APPLIES TO THE RIGHT END STATE.
 *
 * Status: PREPARED / NOT PROMOTED (master directive Part 9). Nothing here
 * runs in required CI; see docs/phase9/P9-PREP-REPORT.md §LIMITATIONS.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScratchDb } from '../helpers/scratch-db';
import { createScratchDb } from '../helpers/scratch-db';
import {
  BASE_HEAD,
  BOOTSTRAP_PATCH,
  P9_RELATIONS,
  endStateBlock,
  loadSpec,
  occupyingStates,
  parseStateContractForTest,
  releasingStates,
} from './p9-booking-spec';
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
    const r = await db.pool.query<{ relname: string }>(
      `SELECT relname FROM pg_class WHERE relname = ANY($1::text[]) AND relkind = 'r' ORDER BY relname COLLATE "C"`,
      [[...P9_RELATIONS]],
    );
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
        WHERE c.contype = 'x' ORDER BY c.conname COLLATE "C"`,
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
    // The predicate must hold every occupying state and no releasing one —
    // and both lists come from the spec's own P9-STATE-CONTRACT line, not from
    // a copy of it written here. A sixth state cannot pass unclassified: the
    // loader reds first.
    const occupying = occupyingStates();
    const releasing = releasingStates();
    expect(occupying.length).toBeGreaterThan(0);
    expect(releasing.length).toBeGreaterThan(0);
    for (const state of occupying) expect(row?.def).toContain(`'${state}'`);
    for (const state of releasing) expect(row?.def).not.toContain(`'${state}'`);
  });

  it('row security is enabled AND forced on every relation', async () => {
    const r = await db.pool.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1::text[]) ORDER BY relname COLLATE "C"`,
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
      `SELECT tbl FROM unnest($1::text[]) tbl WHERE has_table_privilege('daftar_app', tbl, 'SELECT') ORDER BY tbl COLLATE "C"`,
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

  it('both definer routines are owned by the internal principal with a pinned path, and the three raise-only guards are not definers', async () => {
    const r = await db.pool.query<{ proname: string; prosecdef: boolean; owner: string; proconfig: string[] | null }>(
      `SELECT p.proname, p.prosecdef, r.rolname AS owner, p.proconfig
         FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.proname = ANY($1::text[]) ORDER BY p.proname COLLATE "C"`,
      [['bookings_buffers_match_service', 'bookings_chain_symmetric', 'bookings_no_delete', 'bookings_transition', 'booking_operations_immutable']],
    );
    const by = new Map(r.rows.map((x) => [x.proname, x]));
    expect([...by.keys()].sort()).toEqual([
      'booking_operations_immutable',
      'bookings_buffers_match_service',
      'bookings_chain_symmetric',
      'bookings_no_delete',
      'bookings_transition',
    ]);
    // Two definers now, and for the same reason: each READS a relation to
    // decide, so row security that hid its subject would turn it into a guard
    // that passes by seeing nothing. The chain guard pairs that with a named
    // refusal for the counterpart it cannot read (R-P9-17), because the
    // definer is what stops the blindness and the refusal is what happens if
    // anything causes it anyway.
    for (const name of ['bookings_buffers_match_service', 'bookings_chain_symmetric']) {
      const definer = by.get(name);
      expect({ name, definer: definer?.prosecdef }).toEqual({ name, definer: true });
      expect({ name, owner: definer?.owner }).toEqual({ name, owner: 'daftar_booking_internal' });
      expect({ name, path: definer?.proconfig }).toEqual({ name, path: ['search_path=pg_catalog, public, pg_temp'] });
    }
    for (const name of ['bookings_no_delete', 'bookings_transition', 'booking_operations_immutable']) {
      expect({ name, definer: by.get(name)?.prosecdef }).toEqual({ name, definer: false });
      expect({ name, path: by.get(name)?.proconfig }).toEqual({ name, path: ['search_path=pg_catalog, public, pg_temp'] });
    }
  });

  it('nobody but the owner may execute either definer guard', async () => {
    const r = await db.pool.query<{ role: string; fn: string }>(
      `SELECT role, fn FROM unnest($1::text[]) role, unnest($2::text[]) fn WHERE has_function_privilege(role, fn, 'EXECUTE')`,
      [
        ['daftar_app', 'daftar_platform', 'daftar_worker', 'daftar_identity', 'daftar_resolver', 'daftar_provisioner', 'daftar_reconciler', 'public'],
        ['bookings_buffers_match_service()', 'bookings_chain_symmetric()'],
      ],
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

  it('both deferred guards are DEFERRABLE INITIALLY DEFERRED constraint triggers', async () => {
    // For the chain guard this is not bookkeeping: evaluated per statement it
    // would refuse the lawful reschedule, whose two halves are symmetric only
    // once both are written (R-P9-17). A deployment that landed it immediate
    // would break every reschedule, so the deferral is asserted and not just
    // the trigger's existence.
    const r = await db.pool.query<{ tgname: string; tgdeferrable: boolean; tginitdeferred: boolean; tgconstraint: string }>(
      `SELECT tgname, tgdeferrable, tginitdeferred, tgconstraint::text
         FROM pg_trigger WHERE tgname = ANY($1::text[]) ORDER BY tgname COLLATE "C"`,
      [['bookings_buffers_are_the_service_s', 'bookings_chain_agrees']],
    );
    expect(r.rows.map((x) => x.tgname)).toEqual(['bookings_buffers_are_the_service_s', 'bookings_chain_agrees']);
    for (const row of r.rows) {
      expect({ t: row.tgname, deferrable: row.tgdeferrable, deferred: row.tginitdeferred }).toEqual({ t: row.tgname, deferrable: true, deferred: true });
      expect({ t: row.tgname, constraint: row.tgconstraint === '0' }).toEqual({ t: row.tgname, constraint: false });
    }
  });

  it('each deferred guard is pinned as ONE ROW: table, function, enabled, events, deferral and WHEN clause (C8-P9-01)', async () => {
    // The gate this replaces asked four separate questions about `tgname`.
    // Round 8 landed three wrong triggers that passed all four while the
    // 2-ring committed with no refusal: the shipped trigger with DISABLE
    // TRIGGER applied, a same-shaped trigger executing a do-nothing function,
    // and NO trigger on `bookings` at all with a same-name decoy on another
    // table. Unpinned: `tgrelid`, `tgfoid`, `tgenabled` — and separate
    // existence tests over a name need not be satisfied by the SAME ROW, which
    // is the deeper defect. One row now carries every identifying fact.
    const r = await db.pool.query<{
      tgname: string;
      tgtype: number;
      tgenabled: string;
      relname: string;
      nspname: string;
      proname: string;
      pronsp: string;
      def: string;
    }>(
      `SELECT tg.tgname, tg.tgtype::int AS tgtype, tg.tgenabled::text AS tgenabled,
              c.relname, n.nspname, p.proname, pn.nspname AS pronsp, pg_get_triggerdef(tg.oid) AS def
         FROM pg_trigger tg
         JOIN pg_class c ON c.oid = tg.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_proc p ON p.oid = tg.tgfoid
         JOIN pg_namespace pn ON pn.oid = p.pronamespace
        WHERE tg.tgname = ANY($1::text[]) ORDER BY tg.tgname COLLATE "C"`,
      [['bookings_buffers_are_the_service_s', 'bookings_chain_agrees']],
    );
    expect(r.rows.map((x) => x.tgname)).toEqual(['bookings_buffers_are_the_service_s', 'bookings_chain_agrees']);
    // Shapes are the SERVER's, measured: 21 is ROW+INSERT+UPDATE and 5 is
    // ROW+INSERT, AFTER being the absence of the BEFORE bit, and the WHEN
    // renderings carry the paren nesting and `::text` cast the server stores —
    // which differ between the two because one expression is an OR and the
    // other is a comparison.
    expect(r.rows.map((x) => ({ t: x.tgname, on: `${x.nspname}.${x.relname}`, fn: `${x.pronsp}.${x.proname}`, type: x.tgtype, enabled: x.tgenabled }))).toEqual(
      [
        { t: 'bookings_buffers_are_the_service_s', on: 'public.bookings', fn: 'public.bookings_buffers_match_service', type: 5, enabled: 'O' },
        { t: 'bookings_chain_agrees', on: 'public.bookings', fn: 'public.bookings_chain_symmetric', type: 21, enabled: 'O' },
      ],
    );
    expect(r.rows[0]?.def).toMatch(/AFTER INSERT ON public\.bookings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN \(\(new\.kind = 'appointment'::text\)\)/);
    expect(r.rows[1]?.def).toMatch(
      /AFTER INSERT OR UPDATE ON public\.bookings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN \(\(\(new\.rescheduled_to_id IS NOT NULL\) OR \(new\.rescheduled_from_id IS NOT NULL\)\)\)/,
    );
  });

  describe('the end-state gate REFUSES each of the three wrong triggers round 8 landed (C8-P9-01)', () => {
    // The red proofs. Each one plants a wrong trigger, re-runs the MIGRATION'S
    // OWN end-state block — extracted from the spec, never retyped, because a
    // second copy of the gate would be a second implementation and would prove
    // nothing about the migration — and asserts the refusal BY NAME. Then it
    // restores the trigger from the definition the server itself rendered
    // before the plant, and asserts the gate passes again.
    // `events` is the guard's own event list as the server renders it, and
    // `otherEvents` a DIFFERENT one that still fires on the rows the WHEN
    // clause admits — the pair the `tgtype` probe below needs, since swapping
    // the events is the only way to change `tgtype` while leaving every other
    // fact the gate reads identical.
    const GUARDS = [
      { tgname: 'bookings_chain_agrees', proname: 'bookings_chain_symmetric', events: 'AFTER INSERT OR UPDATE ON', otherEvents: 'AFTER INSERT ON' },
      {
        tgname: 'bookings_buffers_are_the_service_s',
        proname: 'bookings_buffers_match_service',
        events: 'AFTER INSERT ON',
        otherEvents: 'AFTER INSERT OR UPDATE ON',
      },
    ] as const;

    /** Run the spec's own end-state block and return its refusal, or `''`. */
    const gate = async (block: string): Promise<string> => {
      try {
        await db.pool.query(block);
        return '';
      } catch (e) {
        return e instanceof Error ? e.message : 'non-error thrown';
      }
    };

    const defOf = async (tgname: string): Promise<string> => {
      const r = await db.pool.query<{ def: string }>(
        `SELECT pg_get_triggerdef(tg.oid) AS def FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
          WHERE tg.tgname = $1 AND c.relname = 'bookings'`,
        [tgname],
      );
      const def = r.rows[0]?.def;
      if (def === undefined) throw new Error(`${tgname} is not on public.bookings`);
      return def;
    };

    /**
     * Plant something wrong, measure the gate, restore, measure again.
     *
     * `plant` must leave the schema wrong and `undo` must put it back; the
     * helper asserts the gate is GREEN before planting and GREEN after
     * restoring, so a plant that failed to apply cannot be read as a proof.
     */
    const withPlant = async (plant: string[], undo: string[], whilePlanted?: () => Promise<void>): Promise<string> => {
      const block = endStateBlock();
      expect(await gate(block)).toBe('');
      let said = 'the plant never ran';
      let probe: unknown = null;
      try {
        for (const q of plant) await db.pool.query(q);
        said = await gate(block);
        // Anything the case wants to measure while the schema is wrong runs
        // HERE, inside the try, so a failed assertion still reaches `undo`
        // below (F-7): a measurement taken after this helper returned would
        // leave the trigger planted for every later case in the file.
        if (whilePlanted !== undefined) await whilePlanted();
      } catch (e) {
        probe = e;
      }
      let restoreFailure: unknown = null;
      try {
        for (const q of undo) await db.pool.query(q);
      } catch (e) {
        restoreFailure = e;
      }
      if (probe !== null) throw probe;
      if (restoreFailure !== null) throw restoreFailure;
      expect(await gate(block)).toBe('');
      return said;
    };

    for (const g of GUARDS) {
      it(`A1 — ${g.tgname} DISABLED: every shape fact is unchanged and the guard does not run`, async () => {
        const before = await defOf(g.tgname);
        // The point of this case: DISABLE changes nothing the old gate looked
        // at. `pg_get_triggerdef` renders the same text, and only `tgenabled`
        // moves — measured here rather than asserted from the manual, and
        // measured WHILE the trigger is disabled, inside the helper, so the
        // trigger is re-enabled even if one of these assertions fails (F-7).
        let during: { e: string; def: string } | undefined;
        const said = await withPlant([`ALTER TABLE bookings DISABLE TRIGGER ${g.tgname}`], [`ALTER TABLE bookings ENABLE TRIGGER ${g.tgname}`], async () => {
          const r = await db.pool.query<{ e: string; def: string }>(
            `SELECT tg.tgenabled::text AS e, pg_get_triggerdef(tg.oid) AS def FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
                WHERE tg.tgname = $1 AND c.relname = 'bookings'`,
            [g.tgname],
          );
          during = r.rows[0];
        });
        expect(said).toMatch(/booking\.migration_end_state_invalid/);
        expect(said).toContain(g.tgname);
        expect(during?.e).toBe('D');
        expect(during?.def).toBe(before);
      });

      it(`A2 — ${g.tgname} with the same name, events, deferral and WHEN clause, executing a DO-NOTHING function`, async () => {
        const before = await defOf(g.tgname);
        // The decoy's definition is the real one with the function swapped, so
        // it renders character for character apart from the last two words.
        const decoyDef = before.replace(`EXECUTE FUNCTION ${g.proname}()`, 'EXECUTE FUNCTION zz_nothing()');
        expect(decoyDef).not.toBe(before);
        expect(decoyDef).toContain('zz_nothing()');
        const said = await withPlant(
          [
            `CREATE OR REPLACE FUNCTION zz_nothing() RETURNS trigger LANGUAGE plpgsql AS $zz$ BEGIN RETURN NULL; END $zz$`,
            `DROP TRIGGER ${g.tgname} ON bookings`,
            decoyDef,
          ],
          [`DROP TRIGGER ${g.tgname} ON bookings`, before, `DROP FUNCTION zz_nothing()`],
        );
        expect(said).toMatch(/booking\.migration_end_state_invalid/);
        expect(said).toContain(g.proname);
      });

      it(`A3 — no ${g.tgname} on bookings at all, and a same-name decoy on another table`, async () => {
        const before = await defOf(g.tgname);
        const said = await withPlant(
          [
            `CREATE TABLE zz_decoy (id UUID PRIMARY KEY, kind TEXT, rescheduled_to_id UUID, rescheduled_from_id UUID)`,
            `CREATE OR REPLACE FUNCTION zz_nothing() RETURNS trigger LANGUAGE plpgsql AS $zz$ BEGIN RETURN NULL; END $zz$`,
            `DROP TRIGGER ${g.tgname} ON bookings`,
            before.replace('ON public.bookings', 'ON public.zz_decoy').replace(`EXECUTE FUNCTION ${g.proname}()`, 'EXECUTE FUNCTION zz_nothing()'),
          ],
          [`DROP TABLE zz_decoy CASCADE`, before, `DROP FUNCTION zz_nothing()`],
        );
        expect(said).toMatch(/booking\.migration_end_state_invalid/);
        expect(said).toContain(g.tgname);
      });

      it(`and every one of the 11 conditions is load-bearing for ${g.tgname}: delete it and its own wrong trigger passes`, async () => {
        // The gate could refuse all three of A1-A3 for the wrong reason — one
        // over-strict clause catching everything — and nine of its eleven
        // conditions could be decoration. So EVERY condition is deleted from
        // the extracted block in turn and the wrong trigger it was added for
        // is then measured PASSING. Round 9 asked for all eleven on both
        // guards rather than three on one (F-6).
        //
        // Three of the eleven cannot be isolated by a single deletion in any
        // state a DEPLOYMENT can reach, and the wording matters (C10-P9-05):
        // **no DDL path produces** `tgdeferrable = false` with
        // `tginitdeferred = true`, measured three ways on PostgreSQL 16.15 —
        // `CREATE CONSTRAINT TRIGGER … NOT DEFERRABLE INITIALLY DEFERRED` and
        // the equivalent `ALTER TABLE … ALTER CONSTRAINT` both error with
        // "constraint declared INITIALLY DEFERRED must be DEFERRABLE", and
        // `ALTER CONSTRAINT … NOT DEFERRABLE` is foreign-key-only. The state
        // itself is NOT impossible: a superuser `UPDATE pg_trigger SET
        // tgdeferrable = false` produces it, and on that state a single cut
        // of `tg.tgdeferrable` WOULD isolate the condition. An earlier edition
        // of this comment said a trigger "cannot" be in that pair, which is
        // false about the catalogue and true about DDL; the challenger
        // measured it after being asked to. A plain trigger can be neither
        // deferrable nor initially deferred, which is the second pair. The
        // gate is not fail-open on the catalogue state — the full block
        // refuses `tgdeferrable = false` whatever `tginitdeferred` holds — and
        // a superuser who can write `pg_trigger` can also drop the table, so
        // it is not a state to design a proof around. For every state a
        // deployment can reach, `stillRed` names the strictly smaller deletion
        // that must STILL refuse, which is what shows the extra condition is
        // carrying weight instead of riding along.
        const block = endStateBlock();
        const cut = (fragments: readonly (readonly [string, string])[]): string => {
          let out = block;
          for (const [fragment, replacement] of fragments) {
            if (out.split(fragment).length !== 2) throw new Error(`the end-state block does not contain exactly one ${JSON.stringify(fragment)}`);
            out = out.replace(fragment, replacement);
          }
          if (out === block) throw new Error('the deletion changed nothing');
          return out;
        };
        // The conditions, quoted from the spec with their own whitespace so a
        // reformatting of the gate fails this case instead of silently
        // deleting nothing.
        const C = {
          tgname: ['       WHERE tg.tgname       = v_g.tgname\n', '       WHERE true\n'] as const,
          relname: ["         AND c.relname       = 'bookings'\n", ''] as const,
          nspname: ["         AND n.nspname       = 'public'\n", ''] as const,
          proname: ['         AND p.proname       = v_g.proname\n', ''] as const,
          pronsp: ["         AND pn.nspname      = 'public'\n", ''] as const,
          enabled: ["         AND tg.tgenabled    = 'O'\n", ''] as const,
          tgtype: ['         AND tg.tgtype       = v_g.tgtype\n', ''] as const,
          deferrable: ['         AND tg.tgdeferrable\n', ''] as const,
          initdeferred: ['         AND tg.tginitdeferred\n', ''] as const,
          constraintOid: ['         AND tg.tgconstraint <> 0\n', ''] as const,
          whenclause: ['         AND pg_get_triggerdef(tg.oid) LIKE v_g.whenlike\n', ''] as const,
        };
        const before = await defOf(g.tgname);
        const drop = `DROP TRIGGER ${g.tgname} ON bookings`;
        const nothing = `CREATE OR REPLACE FUNCTION zz_nothing() RETURNS trigger LANGUAGE plpgsql AS $zz$ BEGIN RETURN NULL; END $zz$`;
        const cols = '(id UUID PRIMARY KEY, kind TEXT, rescheduled_to_id UUID, rescheduled_from_id UUID)';
        const noDeferral = before.replace('DEFERRABLE INITIALLY DEFERRED ', '');
        expect(noDeferral).not.toBe(before);
        const noWhen = before.replace(/ WHEN \(.*\) EXECUTE FUNCTION /, ' EXECUTE FUNCTION ');
        expect(noWhen).not.toBe(before);
        expect(noWhen).not.toContain(' WHEN ');

        const probes: {
          condition: string;
          wrong: string;
          cuts: readonly (readonly [string, string])[];
          stillRed?: readonly (readonly [string, string])[];
          plant: string[];
          undo: string[];
        }[] = [
          {
            condition: 'tg.tgname',
            wrong: 'the guard renamed, everything else identical',
            cuts: [C.tgname],
            plant: [drop, before.replace(`TRIGGER ${g.tgname} `, 'TRIGGER zz_renamed ')],
            undo: [`DROP TRIGGER zz_renamed ON bookings`, before],
          },
          {
            condition: 'c.relname',
            wrong: 'the guard moved to another table in public',
            cuts: [C.relname],
            plant: [`CREATE TABLE zz_decoy ${cols}`, drop, before.replace('ON public.bookings', 'ON public.zz_decoy')],
            undo: [`DROP TABLE zz_decoy CASCADE`, before],
          },
          {
            condition: 'n.nspname',
            wrong: 'the guard moved to a table also called bookings, in another schema',
            cuts: [C.nspname],
            plant: [`CREATE SCHEMA zz`, `CREATE TABLE zz.bookings ${cols}`, drop, before.replace('ON public.bookings', 'ON zz.bookings')],
            undo: [`DROP SCHEMA zz CASCADE`, before],
          },
          {
            condition: 'p.proname',
            wrong: 'the guard executing a do-nothing function',
            cuts: [C.proname],
            plant: [nothing, drop, before.replace(`EXECUTE FUNCTION ${g.proname}()`, 'EXECUTE FUNCTION zz_nothing()')],
            undo: [drop, before, `DROP FUNCTION zz_nothing()`],
          },
          {
            condition: 'pn.nspname',
            wrong: 'the guard executing a same-named function in another schema',
            cuts: [C.pronsp],
            plant: [
              `CREATE SCHEMA zz`,
              `CREATE FUNCTION zz.${g.proname}() RETURNS trigger LANGUAGE plpgsql AS $zz$ BEGIN RETURN NULL; END $zz$`,
              drop,
              before.replace(`EXECUTE FUNCTION ${g.proname}()`, `EXECUTE FUNCTION zz.${g.proname}()`),
            ],
            undo: [drop, before, `DROP SCHEMA zz CASCADE`],
          },
          {
            condition: 'tg.tgenabled',
            wrong: 'the guard disabled',
            cuts: [C.enabled],
            plant: [`ALTER TABLE bookings DISABLE TRIGGER ${g.tgname}`],
            undo: [`ALTER TABLE bookings ENABLE TRIGGER ${g.tgname}`],
          },
          {
            condition: 'tg.tgtype',
            wrong: 'the guard on a different event list',
            cuts: [C.tgtype],
            plant: [drop, before.replace(g.events, g.otherEvents)],
            undo: [drop, before],
          },
          {
            condition: 'tg.tginitdeferred',
            wrong: 'the guard DEFERRABLE INITIALLY IMMEDIATE',
            cuts: [C.initdeferred],
            plant: [drop, before.replace('DEFERRABLE INITIALLY DEFERRED', 'DEFERRABLE INITIALLY IMMEDIATE')],
            undo: [drop, before],
          },
          {
            condition: 'tg.tgdeferrable',
            wrong: 'the guard NOT DEFERRABLE',
            cuts: [C.deferrable, C.initdeferred],
            stillRed: [C.initdeferred],
            plant: [drop, noDeferral],
            undo: [drop, before],
          },
          {
            condition: 'tg.tgconstraint',
            wrong: 'a plain trigger in the constraint trigger\u2019s place',
            cuts: [C.deferrable, C.initdeferred, C.constraintOid],
            stillRed: [C.deferrable, C.initdeferred],
            plant: [drop, noDeferral.replace('CREATE CONSTRAINT TRIGGER', 'CREATE TRIGGER')],
            undo: [drop, before],
          },
          {
            condition: 'pg_get_triggerdef LIKE',
            wrong: 'the guard with its WHEN clause removed, so it fires on rows it was never measured on',
            cuts: [C.whenclause],
            plant: [drop, noWhen],
            undo: [drop, before],
          },
        ];
        expect(probes.length).toBe(11);
        expect(new Set(probes.map((x) => x.condition)).size).toBe(11);

        for (const probe of probes) {
          const where = `${probe.condition} / ${probe.wrong}`;
          const withFull = block; // the migration's own gate, unmodified
          const withCut = cut(probe.cuts);
          const withSmaller = probe.stillRed === undefined ? null : cut(probe.stillRed);
          expect(await gate(withFull), `${where}: the gate is not green before the plant`).toBe('');
          let seen: { full: string; cutted: string; smaller: string | null } | null = null;
          let failure: unknown = null;
          try {
            for (const q of probe.plant) await db.pool.query(q);
            seen = {
              full: await gate(withFull),
              cutted: await gate(withCut),
              smaller: withSmaller === null ? null : await gate(withSmaller),
            };
          } catch (e) {
            failure = e;
          }
          let restoreFailure: unknown = null;
          try {
            for (const q of probe.undo) await db.pool.query(q);
          } catch (e) {
            restoreFailure = e;
          }
          if (failure !== null) throw failure;
          if (restoreFailure !== null) throw restoreFailure;
          expect(seen, where).not.toBeNull();
          // The gate refuses the wrong trigger BY NAME.
          expect(seen?.full, `${where}: the full gate did not refuse`).toMatch(/booking\.migration_end_state_invalid/);
          expect(seen?.full, where).toContain(g.tgname);
          // And it refuses it ONLY because of this condition.
          expect(seen?.cutted, `${where}: the gate still refused without the condition, so the condition is not what refused`).toBe('');
          if (withSmaller !== null) {
            expect(seen?.smaller, `${where}: the smaller deletion already passed, so this condition carries no weight`).toMatch(
              /booking\.migration_end_state_invalid/,
            );
          }
          // And the schema is back, byte for byte, before the next probe.
          expect(await gate(withFull), `${where}: the gate is not green after the restore`).toBe('');
          expect(await defOf(g.tgname), `${where}: the trigger was not restored`).toBe(before);
        }
      });
    }
  });

  it('the state contract is CHECKED against the document, not trusted: four mutations each red it by name', () => {
    // The red proofs for the occupancy contract (PART 17). Each mutation is a
    // one-line change to the spec TEXT, applied in memory, and each must be
    // refused with a message that names what is wrong — because a parser that
    // accepts a contradiction is not a contract, it is a comment.
    const text = loadSpec();
    const mutations: { label: string; from: string; to: string; expect: string }[] = [
      {
        label: 'the declaration is gone',
        from: 'P9-STATE-CONTRACT: occupying',
        to: 'P9-STATE-CONTRACK: occupying',
        expect: 'carries no P9-STATE-CONTRACT line',
      },
      {
        label: 'a state is declared on both sides',
        from: 'occupying = booked, completed, no_show; releasing = cancelled, rescheduled',
        to: 'occupying = booked, completed, no_show; releasing = cancelled, rescheduled, booked',
        expect: 'both occupying and releasing',
      },
      {
        label: 'the declaration and the index disagree',
        from: 'occupying = booked, completed, no_show; releasing = cancelled, rescheduled',
        to: 'occupying = booked, completed; releasing = no_show, cancelled, rescheduled',
        expect: 'but the state contract declares',
      },
      {
        label: 'a sixth state is allowed but classified by nobody',
        from: "CHECK (state IN ('booked', 'completed', 'no_show', 'cancelled', 'rescheduled'))",
        to: "CHECK (state IN ('booked', 'completed', 'no_show', 'cancelled', 'rescheduled', 'abandoned'))",
        expect: 'which the P9 state contract does not classify',
      },
    ];
    for (const m of mutations) {
      // PROVE THE MUTATION LANDED. A sed that matches nothing goes green and
      // records a missing law as fine — this project has paid for that once.
      expect(text, m.label).toContain(m.from);
      const mutated = text.replace(m.from, m.to);
      expect(mutated, m.label).not.toBe(text);
      let message = '';
      try {
        parseStateContractForTest(mutated);
      } catch (e) {
        message = (e as Error).message;
      }
      // The SPECIFIC refusal, never merely "it threw".
      expect(message, m.label).toContain(m.expect);
    }
    // And the unmutated document still parses, so the four refusals above are
    // about the mutations and not about a parser that refuses everything.
    const sound = parseStateContractForTest(text);
    expect([...sound.occupying].sort()).toEqual(['booked', 'completed', 'no_show']);
    expect([...sound.releasing].sort()).toEqual(['cancelled', 'rescheduled']);
  });

  it('the spec loader refuses a subject it cannot recognise', () => {
    // The loader is this directory's only protection against applying an
    // emptied document and reporting a green. Its own refusals must fire.
    expect(() => loadSpec()).not.toThrow();
  });

  /**
   * HIGH-VELOCITY V1 names PostgreSQL 16 with `en_US.utf8` as the approved
   * target and asks for the database version AND COLLATION in every piece of
   * evidence (PART 19). Running this suite against a real PG16/en_US.utf8
   * cluster found a defect in THIS FILE, not in the schema: five assertions
   * sorted text in SQL — under the database's collation — and compared the
   * result to a JavaScript `.sort()`, which is code-unit order. Under
   * `en_US.utf8` the underscore is not a primary-weight character, so
   * `booking_resources` sorts BEFORE `booking_resource_schedules`; under `C`
   * it sorts after. The suite passed on one collation and failed on the other
   * while the schema was identical.
   *
   * The orderings now pin `COLLATE "C"`, and this case proves the hazard is
   * real rather than theoretical — a fix for a difference nobody can
   * demonstrate is a guess.
   */
  it('the suite’s orderings are collation-independent, and the server’s collation is recorded', async () => {
    const r = await db.pool.query<{ c_order: string[]; locale_order: string[]; datcollate: string; version: string }>(
      `SELECT (SELECT array_agg(n ORDER BY n COLLATE "C") FROM unnest(ARRAY['booking_resources', 'booking_resource_schedules']) n) AS c_order,
              (SELECT array_agg(n ORDER BY n) FROM unnest(ARRAY['booking_resources', 'booking_resource_schedules']) n) AS locale_order,
              (SELECT datcollate FROM pg_database WHERE datname = current_database()) AS datcollate,
              version() AS version`,
    );
    const row = r.rows[0];
    if (row === undefined) throw new Error('the collation probe returned no row');
    // `C` is the order JavaScript's own sort produces, which is what the
    // assertions in this file compare against.
    expect(row.c_order).toEqual(['booking_resource_schedules', 'booking_resources']);
    expect([...row.c_order].sort()).toEqual(row.c_order);
    // On a locale collation the two disagree — and that disagreement is the
    // whole defect. On a `C`-collated cluster they agree, and the case still
    // holds: the assertion is that the pinned order equals JavaScript's, not
    // that the database's default differs from it.
    if (row.datcollate.startsWith('en_US')) {
      expect(row.locale_order).toEqual(['booking_resources', 'booking_resource_schedules']);
      expect(row.locale_order).not.toEqual(row.c_order);
    }
    // Recorded for the evidence record PART 19 asks for.
    console.log(`[P9 runtime] ${row.version.split(' on ')[0]} / collation ${row.datcollate}`);
  });
});
