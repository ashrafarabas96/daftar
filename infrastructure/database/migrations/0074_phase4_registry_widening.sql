-- 0074_phase4_registry_widening.sql
-- Phase 4, slice P4-S1 — the FIRST Phase 4 migration.
-- Architecture lock: P4-AL-83 (one migration owner), P4-AL-84 (this file
-- carries the registry widenings and nothing else of substance), P4-AL-85
-- (0000–0073 stay immutable byte for byte).
--
-- ── What this file does, and why it does only this ──────────────────────
--
-- Four accepted registries constrain their own provenance column to a
-- Phase 3 registrant:
--
--   inventory_operation_kinds           registered_by ~ '^P3-S[0-9]+$' OR registered_by = 'P3-C'
--   inventory_operation_movement_kinds  registered_by ~ '^P3-S[0-9]+$'
--   stock_movement_kinds                registered_by ~ '^P3-S[0-9]+$'
--   stock_source_types                  registered_by ~ '^P3-S[0-9]+$'
--
-- Every one of them REFUSES 'P4-S1'. So the first Phase 4 row in any of
-- those registries fails an accepted CHECK, and it fails at INSERT time
-- inside whatever transaction happens to be registering it. P4-AL-84 puts
-- the widening first and alone, so that the first red CI run of Phase 4 is
-- about the widening rather than about the widening plus a table.
--
-- This file therefore creates NO table, NO function, NO trigger, NO policy
-- and NO sequence, and it REGISTERS NOTHING: the widening admits a Phase 4
-- registrant, and the slice that actually needs a kind or a source type
-- inserts it (ruling C8 — this migration carries no registry row).
--
-- ── Why the fourth statement differs from the other three ──────────────
--
-- TL-P4-S1-C3. `0072:812-814` dropped and re-added
-- `inventory_operation_kinds_registered_by_check` as
-- `CHECK (registered_by ~ '^P3-S[0-9]+$' OR registered_by = 'P3-C')` and
-- `0072:817` inserted ('purchase.write_off_residue', 'P3-C'). That row is
-- live. `ADD CONSTRAINT` validates the rows already in the table, so a
-- widening that produced a bare `^P[0-9]+-S[0-9]+$` on that table would
-- FAIL at ADD CONSTRAINT — 'P3-C' matches no `Pn-Sn` shape. The fourth
-- statement keeps the corrective arm:
--
--   CHECK (registered_by ~ '^P[0-9]+-S[0-9]+$' OR registered_by = 'P3-C')
--
-- This is the reason the file reads the LIVE CATALOGUE and not the
-- migration that wrote each constraint: the text at `0054:54` is not the
-- text in `pg_constraint` today.
--
-- ── What is asserted, and where the proof comes from ───────────────────
--
--   1. BEFORE: each of the four constraints exists and its live definition
--      is exactly the one this file was written against. A shape this file
--      does not recognise stops the migration instead of being silently
--      replaced.
--   2. AFTER: each new definition is exactly the intended one.
--   3. AFTER, by PERFORMING it rather than by reading a regex: a row
--      carrying 'P4-S1' is INSERTED into each of the four registries inside
--      a subtransaction and rolled back, so the admission proved is the
--      LIVE constraint's and not this file's opinion of it; and a malformed
--      registrant ('P4') is still refused by each of the four.
--   4. AFTER: 'P3-C' is still admitted by the one table that holds it —
--      proved by the ADD CONSTRAINT above having validated that row, and
--      re-proved directly, together with the row counts of all four
--      registries being unchanged by this migration.
--
-- Nothing here writes a committed row: every probe lives in a PL/pgSQL
-- BEGIN … EXCEPTION block, which is a subtransaction, and each one ends by
-- raising so that the insert is rolled back.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. BEFORE: the four constraints are the ones this file was written for.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  c_before CONSTANT JSONB := jsonb_build_object(
    'inventory_operation_kinds_registered_by_check',
      'CHECK (((registered_by ~ ''^P3-S[0-9]+$''::text) OR (registered_by = ''P3-C''::text)))',
    'inventory_operation_movement_kinds_registered_by_check',
      'CHECK ((registered_by ~ ''^P3-S[0-9]+$''::text))',
    'stock_movement_kinds_registered_by_check',
      'CHECK ((registered_by ~ ''^P3-S[0-9]+$''::text))',
    'stock_source_types_registered_by_check',
      'CHECK ((registered_by ~ ''^P3-S[0-9]+$''::text))'
  );
  v_name   TEXT;
  v_actual TEXT;
BEGIN
  FOR v_name IN SELECT jsonb_object_keys(c_before) LOOP
    SELECT pg_catalog.pg_get_constraintdef(c.oid) INTO v_actual
      FROM pg_catalog.pg_constraint c
     WHERE c.conname = v_name AND c.contype = 'c';
    IF NOT FOUND THEN
      RAISE EXCEPTION '0074: the CHECK % does not exist — this migration was written against a catalogue that had it', v_name
        USING ERRCODE = 'P0001';
    END IF;
    IF v_actual IS DISTINCT FROM (c_before ->> v_name) THEN
      RAISE EXCEPTION '0074: the live definition of % is % — this migration was written against %; a migration reads the live catalogue, so stop rather than replace a shape nobody reviewed',
        v_name, v_actual, (c_before ->> v_name) USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. The widening. Three identical statements and one that keeps the
--    corrective 'P3-C' arm (TL-P4-S1-C3). Named explicitly rather than
--    looped, because each is a reviewable change to an accepted constraint.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE inventory_operation_movement_kinds DROP CONSTRAINT inventory_operation_movement_kinds_registered_by_check;
ALTER TABLE inventory_operation_movement_kinds ADD CONSTRAINT inventory_operation_movement_kinds_registered_by_check
  CHECK (registered_by ~ '^P[0-9]+-S[0-9]+$');

ALTER TABLE stock_movement_kinds DROP CONSTRAINT stock_movement_kinds_registered_by_check;
ALTER TABLE stock_movement_kinds ADD CONSTRAINT stock_movement_kinds_registered_by_check
  CHECK (registered_by ~ '^P[0-9]+-S[0-9]+$');

ALTER TABLE stock_source_types DROP CONSTRAINT stock_source_types_registered_by_check;
ALTER TABLE stock_source_types ADD CONSTRAINT stock_source_types_registered_by_check
  CHECK (registered_by ~ '^P[0-9]+-S[0-9]+$');

-- The corrective arm stays: 'purchase.write_off_residue' is registered
-- 'P3-C' (0072:817) and ADD CONSTRAINT validates it.
ALTER TABLE inventory_operation_kinds DROP CONSTRAINT inventory_operation_kinds_registered_by_check;
ALTER TABLE inventory_operation_kinds ADD CONSTRAINT inventory_operation_kinds_registered_by_check
  CHECK (registered_by ~ '^P[0-9]+-S[0-9]+$' OR registered_by = 'P3-C');

-- ─────────────────────────────────────────────────────────────────────────
-- 3. AFTER: the four definitions are exactly the intended ones.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  c_after CONSTANT JSONB := jsonb_build_object(
    'inventory_operation_kinds_registered_by_check',
      'CHECK (((registered_by ~ ''^P[0-9]+-S[0-9]+$''::text) OR (registered_by = ''P3-C''::text)))',
    'inventory_operation_movement_kinds_registered_by_check',
      'CHECK ((registered_by ~ ''^P[0-9]+-S[0-9]+$''::text))',
    'stock_movement_kinds_registered_by_check',
      'CHECK ((registered_by ~ ''^P[0-9]+-S[0-9]+$''::text))',
    'stock_source_types_registered_by_check',
      'CHECK ((registered_by ~ ''^P[0-9]+-S[0-9]+$''::text))'
  );
  v_name   TEXT;
  v_actual TEXT;
BEGIN
  FOR v_name IN SELECT jsonb_object_keys(c_after) LOOP
    SELECT pg_catalog.pg_get_constraintdef(c.oid) INTO v_actual
      FROM pg_catalog.pg_constraint c
     WHERE c.conname = v_name AND c.contype = 'c';
    IF NOT FOUND THEN
      RAISE EXCEPTION '0074: the CHECK % is missing after the widening', v_name USING ERRCODE = 'P0001';
    END IF;
    IF v_actual IS DISTINCT FROM (c_after ->> v_name) THEN
      RAISE EXCEPTION '0074: after the widening % is % and not %', v_name, v_actual, (c_after ->> v_name) USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. AFTER, PERFORMED: each registry admits 'P4-S1' and refuses 'P4'.
--
--    The admission is proved by inserting and rolling back, not by
--    evaluating the pattern here: what has to be true is that the LIVE
--    constraint admits a Phase 4 registrant, and a regex written in this
--    file is evidence about this file.
--
--    Each probe borrows real parent keys where the registry has foreign
--    keys, so a refusal can only come from the CHECK under test.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_op     TEXT;
  v_kind   TEXT;
  v_admit  TEXT;
  v_stage  TEXT;
  v_counts INT[];
  v_con    TEXT;
BEGIN
  -- The counts are CAPTURED, never written down: "this migration registers
  -- nothing" is a statement about this migration, and a literal here would
  -- be a statement about the prefix that happens to precede it.
  SELECT ARRAY[
    (SELECT pg_catalog.count(*)::int FROM inventory_operation_kinds),
    (SELECT pg_catalog.count(*)::int FROM stock_source_types),
    (SELECT pg_catalog.count(*)::int FROM stock_movement_kinds),
    (SELECT pg_catalog.count(*)::int FROM inventory_operation_movement_kinds)
  ] INTO v_counts;

  -- A pair the op→movement registry does NOT already hold, so its probe
  -- reaches the CHECK instead of the primary key. Both components are real
  -- parent keys, so no foreign key can refuse it either.
  SELECT k.op_code, m.movement_kind INTO v_op, v_kind
    FROM inventory_operation_kinds k
    CROSS JOIN stock_movement_kinds m
   WHERE NOT EXISTS (
     SELECT 1 FROM inventory_operation_movement_kinds p
      WHERE p.op_code = k.op_code AND p.movement_kind = m.movement_kind)
   ORDER BY k.op_code, m.movement_kind
   LIMIT 1;
  IF v_op IS NULL OR v_kind IS NULL THEN
    RAISE EXCEPTION '0074: no unregistered op-code/movement-kind pair exists, so the pair probe below would prove nothing'
      USING ERRCODE = 'P0001';
  END IF;

  -- (a) ADMITTED: a Phase 4 registrant, in each of the four registries.
  FOREACH v_stage IN ARRAY ARRAY['inventory_operation_kinds', 'stock_movement_kinds', 'stock_source_types', 'inventory_operation_movement_kinds'] LOOP
    BEGIN
      CASE v_stage
        WHEN 'inventory_operation_kinds' THEN
          INSERT INTO inventory_operation_kinds (op_code, registered_by) VALUES ('sale.probe', 'P4-S1');
        WHEN 'stock_movement_kinds' THEN
          INSERT INTO stock_movement_kinds (movement_kind, qty_sign, requires_reason, registered_by)
            VALUES ('probe_0074', 'either', FALSE, 'P4-S1');
        WHEN 'stock_source_types' THEN
          INSERT INTO stock_source_types (source_type, registered_by) VALUES ('probe_0074', 'P4-S1');
        WHEN 'inventory_operation_movement_kinds' THEN
          INSERT INTO inventory_operation_movement_kinds (op_code, movement_kind, registered_by)
            VALUES (v_op, v_kind, 'P4-S1');
      END CASE;
      -- The insert succeeded, which is the whole claim. Undo it.
      RAISE EXCEPTION 'probe_rollback' USING ERRCODE = 'P0001';
    EXCEPTION
      WHEN SQLSTATE 'P0001' THEN
        IF SQLERRM <> 'probe_rollback' THEN RAISE; END IF;
      WHEN check_violation THEN
        -- WHICH constraint refused matters. A probe key that trips the
        -- table's own op-code or name pattern is a defect in the PROBE, and
        -- reporting it as "the widening failed" would be a false accusation
        -- against the statement under test.
        GET STACKED DIAGNOSTICS v_con = CONSTRAINT_NAME;
        IF v_con <> v_stage || '_registered_by_check' THEN
          RAISE EXCEPTION '0074: the % admission probe was refused by %, not by the registered_by CHECK, so it proved nothing about the widening (%)',
            v_stage, coalesce(v_con, '(unnamed)'), SQLERRM USING ERRCODE = 'P0001';
        END IF;
        RAISE EXCEPTION '0074: % still refuses the Phase 4 registrant ''P4-S1'' after the widening (%)', v_stage, SQLERRM
          USING ERRCODE = 'P0001';
      WHEN unique_violation THEN
        -- A probe key that already exists says nothing either way; the
        -- probe must be able to reach the CHECK.
        RAISE EXCEPTION '0074: the % admission probe collided with an existing row, so it proved nothing (%)', v_stage, SQLERRM
          USING ERRCODE = 'P0001';
    END;
  END LOOP;

  -- (b) REFUSED: a malformed registrant, in each of the four registries.
  --     A widening that admitted anything would be a deletion.
  FOREACH v_stage IN ARRAY ARRAY['inventory_operation_kinds', 'stock_movement_kinds', 'stock_source_types', 'inventory_operation_movement_kinds'] LOOP
    v_admit := 'admitted';
    BEGIN
      CASE v_stage
        WHEN 'inventory_operation_kinds' THEN
          INSERT INTO inventory_operation_kinds (op_code, registered_by) VALUES ('sale.probe', 'P4');
        WHEN 'stock_movement_kinds' THEN
          INSERT INTO stock_movement_kinds (movement_kind, qty_sign, requires_reason, registered_by)
            VALUES ('probe_0074', 'either', FALSE, 'P4');
        WHEN 'stock_source_types' THEN
          INSERT INTO stock_source_types (source_type, registered_by) VALUES ('probe_0074', 'P4');
        WHEN 'inventory_operation_movement_kinds' THEN
          INSERT INTO inventory_operation_movement_kinds (op_code, movement_kind, registered_by)
            VALUES (v_op, v_kind, 'P4');
      END CASE;
      RAISE EXCEPTION 'probe_rollback' USING ERRCODE = 'P0001';
    EXCEPTION
      WHEN check_violation THEN
        -- Refused, but it must be the constraint under test that refused.
        GET STACKED DIAGNOSTICS v_con = CONSTRAINT_NAME;
        IF v_con <> v_stage || '_registered_by_check' THEN
          RAISE EXCEPTION '0074: the % refusal probe was refused by %, not by the registered_by CHECK, so it proved nothing (%)',
            v_stage, coalesce(v_con, '(unnamed)'), SQLERRM USING ERRCODE = 'P0001';
        END IF;
        v_admit := 'refused';
      WHEN SQLSTATE 'P0001' THEN
        IF SQLERRM <> 'probe_rollback' THEN RAISE; END IF;
    END;
    IF v_admit <> 'refused' THEN
      RAISE EXCEPTION '0074: % admitted the malformed registrant ''P4'' — the widening is a deletion, not a widening', v_stage
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- (c) 'P3-C' is still admitted where it lives, and no registry row moved.
  IF NOT EXISTS (SELECT 1 FROM inventory_operation_kinds k WHERE k.registered_by = 'P3-C') THEN
    RAISE EXCEPTION '0074: the corrective registrant ''P3-C'' is gone from inventory_operation_kinds'
      USING ERRCODE = 'P0001';
  END IF;
  IF ARRAY[
       (SELECT pg_catalog.count(*)::int FROM inventory_operation_kinds),
       (SELECT pg_catalog.count(*)::int FROM stock_source_types),
       (SELECT pg_catalog.count(*)::int FROM stock_movement_kinds),
       (SELECT pg_catalog.count(*)::int FROM inventory_operation_movement_kinds)
     ] IS DISTINCT FROM v_counts THEN
    RAISE EXCEPTION '0074: a registry row count changed from % — this migration registers nothing (ruling C8)', v_counts
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;
