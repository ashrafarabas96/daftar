-- 0056_inventory_branch_warehouses.sql
-- P3-S1, part 4 — warehouse authorization and the lifecycle that keeps it
-- true (P3-AL-15 §A/§B; physically P3-AL-54 §H/§I and P3-AL-55 §G).
--
-- ── The relation ─────────────────────────────────────────────────────────
--
-- `branch_warehouses` is the AUTHORIZATION relation: an assigned-scope actor
-- reaches a warehouse only through a row here naming one of their branches.
-- `warehouses.branch_id` keeps its meaning — the warehouse's HOME branch —
-- and is neither altered nor made nullable. `warehouses.is_default` stays a
-- UX default and is never authority.
--
-- ── The invariant ────────────────────────────────────────────────────────
--
-- For every warehouse, whatever its status, the row
-- (business_id, branch_id, id) exists in `branch_warehouses`. A backfill
-- alone would be true only on the day it runs, and one of the three
-- warehouse writers — the frozen `provision_create_business` (0033), running
-- as daftar_platform during onboarding — cannot be edited. So the invariant
-- is a SCHEMA rule that reaches every writer, present and future:
--
--   1. warehouses_home_branch_maintain  AFTER INSERT ON warehouses
--      Writes the home row. Derived data, not input: the home association
--      is `warehouses.branch_id` restated. SECURITY DEFINER, internal-owned,
--      so neither daftar_app nor daftar_platform needs any privilege here.
--   2. warehouses_require_home_branch   deferred constraint trigger,
--      AFTER INSERT ON warehouses. Refuses the COMMIT if the home row is
--      missing — load-bearing proof that 1 did not fail, was not dropped and
--      was not bypassed (0036:107-109 shape).
--   3. branch_warehouses_keep_home      deferred constraint trigger,
--      AFTER DELETE OR UPDATE ON branch_warehouses. Refuses the COMMIT if the
--      home row of a warehouse that still exists is gone (0036:110-112
--      shape). `inventory.home_branch_association_required`.
--   4. warehouses_home_branch_immutable BEFORE UPDATE ON warehouses, invoker
--      rights, migrator-owned. `inventory.warehouse_home_branch_immutable`:
--      moving authority is done by ADDING an association, never by rewriting
--      the home one.
--
-- ── Row level security — and the one place this file departs from the lock
--
-- ENABLE + FORCE with the two-policy layering of `warehouses` (0006:28-49).
--
-- P3-AL-54 §I says the maintainer needs no policy of its own because it is
-- admitted "by exactly the predicate that admitted the warehouse row":
-- `app_business()` in the Structure paths and `app_bypass()` in onboarding,
-- "true there for every principal except daftar_app (0010:8-11)". That
-- premise is out of date. `app_bypass()` was redefined by 0032:17-19 and again
-- by 0052:244-246 as `current_user = 'daftar_platform'` — it no longer reads
-- a GUC at all — and inside a SECURITY DEFINER trigger owned by
-- daftar_inventory_internal `current_user` is that role. Onboarding runs with
-- no tenant or business scope (withProvisionerTransaction passes `{}`), so
-- under the two policies alone the maintainer's INSERT is refused and EVERY
-- new business fails to provision. There is no lock-literal alternative: an
-- invoker maintainer needs a platform grant (forbidden by §I), a
-- platform-owned one the same, and a migrator-owned one is subject to FORCE.
--
-- So the internal role is admitted by name, on this table only, in the
-- accepted accounting shape (0040:203-209 — `accounting_seeder` plus the
-- internal clause in the RESTRICTIVE policy): it may READ every association
-- and INSERT one. It gets no UPDATE, and DELETE still needs the ordinary
-- scope. This is safe for the reason 0040's is: the role cannot log in, no
-- runtime role is a member, and its only reachable code — the maintainer
-- (writes NEW's own triple, pinned by the composite FKs), the two proofs
-- (read by exact key) and the two routines (verified assertion, explicit
-- business filter, scope already equal to the asserted business) — never
-- takes a business from anything but a row or a signature. Runtime roles see
-- exactly what the two accepted policies give them.
--
-- FLAGGED FOR TECH LEAD RATIFICATION in the P3-S1 report: it contradicts the
-- sentence "No new policy names the internal role" of P3-AL-54 §I, which
-- cannot be implemented against the accepted app_bypass().
--
-- ── The two commands ─────────────────────────────────────────────────────
--
-- `structure_associate_warehouse_branch` / `structure_dissociate_warehouse_branch`
-- (P3-AL-15 §B, P3-AL-54 §E): internal-owned SECURITY DEFINER, EXECUTE to
-- daftar_app only, each FIRST consuming an `invctl/1` assertion of its own
-- kind over the exact (warehouse_id, branch_id). The application mints one
-- only for `warehouse.manage` AND `branch_scope_mode = 'all'`; the routines
-- enforce structure: both rows in the asserted business, neither archived
-- (associate), the home row never removed (dissociate), idempotent both ways.
-- daftar_app has no INSERT or DELETE on the table, so raw DML cannot add or
-- remove an association.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. The ownership-transfer authority, taken and returned inside this file.
-- ─────────────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. The relation (P3-AL-15).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE branch_warehouses (
  business_id  UUID NOT NULL,
  branch_id    UUID NOT NULL,
  warehouse_id UUID NOT NULL,
  PRIMARY KEY (business_id, branch_id, warehouse_id),
  CONSTRAINT branch_warehouses_branch_fk
    FOREIGN KEY (business_id, branch_id) REFERENCES branches (business_id, id) ON DELETE CASCADE,
  CONSTRAINT branch_warehouses_warehouse_fk
    FOREIGN KEY (business_id, warehouse_id) REFERENCES warehouses (business_id, id) ON DELETE CASCADE
);
REVOKE ALL ON branch_warehouses FROM PUBLIC;

-- The reverse lookup — "which branches reach this warehouse" — is the
-- authority question every Phase 3 stock command asks, and it also serves the
-- warehouse FK's cascade.
CREATE INDEX branch_warehouses_warehouse_idx ON branch_warehouses (business_id, warehouse_id);

ALTER TABLE branch_warehouses ENABLE ROW LEVEL SECURITY;
ALTER TABLE branch_warehouses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_membership ON branch_warehouses
  USING (app_bypass() OR EXISTS (
    SELECT 1 FROM businesses b
    WHERE b.id = branch_warehouses.business_id AND b.tenant_id::text = app_tenant()))
  WITH CHECK (app_bypass() OR EXISTS (
    SELECT 1 FROM businesses b
    WHERE b.id = branch_warehouses.business_id AND b.tenant_id::text = app_tenant()));
CREATE POLICY business_isolation ON branch_warehouses AS RESTRICTIVE
  USING (app_bypass() OR current_user = 'daftar_inventory_internal' OR business_id::text = app_business())
  WITH CHECK (app_bypass() OR current_user = 'daftar_inventory_internal' OR business_id::text = app_business());
-- The internal principal's admission (see the header): read everything,
-- insert — nothing else.
CREATE POLICY inventory_internal_read ON branch_warehouses
  FOR SELECT TO daftar_inventory_internal USING (true);
CREATE POLICY inventory_internal_insert ON branch_warehouses
  FOR INSERT TO daftar_inventory_internal WITH CHECK (true);

-- P3-AL-54 §H. The merchant runtime reads; only the internal principal
-- writes. daftar_platform and daftar_provisioner receive nothing.
GRANT SELECT ON branch_warehouses TO daftar_app;
GRANT SELECT, INSERT, DELETE ON branch_warehouses TO daftar_inventory_internal;
GRANT SELECT ON branches, warehouses TO daftar_inventory_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. The seed: every existing warehouse, exactly its home association.
--
-- The migrator owns `warehouses` but is NOT exempt from its row security
-- (FORCE), and `app_bypass()` is true only for daftar_platform. Applied by a
-- non-superuser deployment principal, a plain INSERT … SELECT would see no
-- warehouse at all, seed nothing in production, and pass every count below
-- vacuously. So the owner lifts FORCE on the two tables for the length of
-- the seed and restores it before anything else happens. The statements are
-- transactional and take ACCESS EXCLUSIVE locks, so no other session can
-- observe the window; the end-state assertions below require FORCE again. A
-- superuser build runs the same statements and is unaffected by them.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE warehouses NO FORCE ROW LEVEL SECURITY;
ALTER TABLE branch_warehouses NO FORCE ROW LEVEL SECURITY;

INSERT INTO branch_warehouses (business_id, branch_id, warehouse_id)
SELECT w.business_id, w.branch_id, w.id FROM warehouses w;

DO $$
DECLARE
  v_count  BIGINT;
  v_expect BIGINT;
BEGIN
  -- Row A of the permanent matrix: EXACTLY the home association, no other.
  SELECT count(*) INTO v_expect FROM warehouses;
  SELECT count(*) INTO v_count FROM branch_warehouses;
  IF v_count <> v_expect THEN
    RAISE EXCEPTION 'inventory.branch_warehouses_seed_mismatch: % warehouses but % associations', v_expect, v_count;
  END IF;
  SELECT count(*) INTO v_count
  FROM warehouses w
  WHERE NOT EXISTS (SELECT 1 FROM branch_warehouses bw
                     WHERE bw.business_id = w.business_id AND bw.warehouse_id = w.id AND bw.branch_id = w.branch_id);
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'inventory.branch_warehouses_seed_mismatch: % warehouses lack their home association', v_count;
  END IF;
END $$;

ALTER TABLE warehouses FORCE ROW LEVEL SECURITY;
ALTER TABLE branch_warehouses FORCE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. The four lifecycle objects (P3-AL-15 §A, P3-AL-54 §I).
-- ─────────────────────────────────────────────────────────────────────────

-- 4.1 Maintainer.
CREATE OR REPLACE FUNCTION warehouses_home_branch_maintain() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  INSERT INTO branch_warehouses (business_id, branch_id, warehouse_id)
  VALUES (NEW.business_id, NEW.branch_id, NEW.id)
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$$;

-- 4.2 Completeness proof, at COMMIT.
--
-- It reads only `branch_warehouses`, which the internal role sees in full
-- (section 2), and not `warehouses`, which it sees only under the writer's
-- scope — onboarding has none. The home branch is NEW.branch_id and cannot
-- change (4.4). A warehouse inserted and deleted in the same transaction
-- would be refused here; no writer does that.
CREATE OR REPLACE FUNCTION warehouses_require_home_branch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM branch_warehouses bw
                      WHERE bw.business_id = NEW.business_id AND bw.warehouse_id = NEW.id AND bw.branch_id = NEW.branch_id) THEN
    RAISE EXCEPTION 'inventory.home_branch_association_required: warehouse % has no association with its home branch', NEW.id
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

-- 4.3 Keep-one, at COMMIT. It must know whether the warehouse still exists
--     (a cascade from `businesses` removes both, legitimately), so it reads
--     `warehouses` — under the deleting transaction's scope, which every
--     writer that can delete an association has (the internal role's DELETE
--     is admitted only by the ordinary scope policies).
CREATE OR REPLACE FUNCTION branch_warehouses_keep_home() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM warehouses w
              WHERE w.business_id = OLD.business_id AND w.id = OLD.warehouse_id AND w.branch_id = OLD.branch_id)
     AND NOT EXISTS (SELECT 1 FROM branch_warehouses bw
                      WHERE bw.business_id = OLD.business_id AND bw.warehouse_id = OLD.warehouse_id AND bw.branch_id = OLD.branch_id) THEN
    RAISE EXCEPTION 'inventory.home_branch_association_required: the association of warehouse % with its home branch cannot be removed', OLD.warehouse_id
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

-- 4.4 Home immutability. Invoker rights: it reads only OLD and NEW.
CREATE OR REPLACE FUNCTION warehouses_home_branch_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.branch_id IS DISTINCT FROM OLD.branch_id THEN
    RAISE EXCEPTION 'inventory.warehouse_home_branch_immutable: a warehouse''s home branch cannot change; add an association instead'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- Triggers are attached while the migrator still owns the functions.
CREATE TRIGGER warehouses_home_branch_maintain
  AFTER INSERT ON warehouses
  FOR EACH ROW EXECUTE FUNCTION warehouses_home_branch_maintain();
CREATE CONSTRAINT TRIGGER warehouses_require_home_branch
  AFTER INSERT ON warehouses DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION warehouses_require_home_branch();
CREATE CONSTRAINT TRIGGER branch_warehouses_keep_home
  AFTER DELETE OR UPDATE ON branch_warehouses DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION branch_warehouses_keep_home();
CREATE TRIGGER warehouses_home_branch_immutable
  BEFORE UPDATE ON warehouses
  FOR EACH ROW EXECUTE FUNCTION warehouses_home_branch_immutable();

-- Trigger functions: no EXECUTE for anyone (P3-AL-54 §D.3) — PostgreSQL does
-- not check EXECUTE when a trigger fires, so a grant would only enable a
-- direct call.
REVOKE ALL ON FUNCTION warehouses_home_branch_maintain() FROM PUBLIC;
REVOKE ALL ON FUNCTION warehouses_require_home_branch() FROM PUBLIC;
REVOKE ALL ON FUNCTION branch_warehouses_keep_home() FROM PUBLIC;
REVOKE ALL ON FUNCTION warehouses_home_branch_immutable() FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. The two association commands (P3-AL-15 §B).
--
-- Both return TRUE when they changed something and FALSE for an idempotent
-- no-op (already associated / already absent), and audit only a change.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION structure_associate_warehouse_branch(p_warehouse_id UUID, p_branch_id UUID) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_actor    inventory_verified_actor;
  v_business UUID;
  v_status   TEXT;
  v_rows     INTEGER;
  v_trace    UUID;
BEGIN
  -- 1. Authority first, over the exact pair.
  v_actor := inventory_assertion_consume(
    'structure.associate_warehouse_branch',
    inventory_claimed_payload_digest(
      'structure.associate_warehouse_branch',
      ARRAY['uuid', 'uuid'],
      ARRAY[p_warehouse_id::text, p_branch_id::text]
    )
  );
  v_business := v_actor.business_id;
  v_trace    := inventory_business_transaction_id();

  IF p_warehouse_id IS NULL OR p_branch_id IS NULL THEN
    RAISE EXCEPTION 'inventory.payload_invalid: an association names a warehouse and a branch' USING ERRCODE = 'P0001';
  END IF;

  -- 2. Both rows exist in the ASSERTED business, and neither is archived.
  SELECT w.status INTO v_status FROM warehouses w WHERE w.business_id = v_business AND w.id = p_warehouse_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'structure.warehouse_not_found: the warehouse does not exist in this business' USING ERRCODE = 'P0001';
  END IF;
  IF v_status <> 'active' THEN
    RAISE EXCEPTION 'structure.warehouse_archived: an archived warehouse cannot be associated with a branch' USING ERRCODE = 'P0001';
  END IF;
  SELECT b.status INTO v_status FROM branches b WHERE b.business_id = v_business AND b.id = p_branch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'structure.branch_not_found: the branch does not exist in this business' USING ERRCODE = 'P0001';
  END IF;
  IF v_status <> 'active' THEN
    RAISE EXCEPTION 'structure.branch_archived: an archived branch cannot be associated with a warehouse' USING ERRCODE = 'P0001';
  END IF;

  -- 3. Idempotent: an existing association is a success with no second row
  --    and no second audit event.
  INSERT INTO branch_warehouses (business_id, branch_id, warehouse_id)
  VALUES (v_business, p_branch_id, p_warehouse_id)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN false;
  END IF;

  INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, metadata)
  VALUES (v_actor.tenant_id, v_business, v_actor.actor_user_id, 'structure.warehouse_branch_associated', 'warehouse', p_warehouse_id::text,
          jsonb_build_object('warehouseId', p_warehouse_id, 'branchId', p_branch_id, 'assertionJti', v_actor.jti,
                             'business_transaction_id', v_trace));
  RETURN true;
END;
$$;

COMMENT ON FUNCTION structure_associate_warehouse_branch(UUID, UUID) IS
  'P3-AL-15 §B, P3-AL-54 §E, P3-AL-55 §G. First consumes an invctl/1 assertion of kind structure.associate_warehouse_branch over (warehouse_id, branch_id); the business is the asserted one. Both rows must exist there (structure.warehouse_not_found, structure.branch_not_found) and be active (structure.warehouse_archived, structure.branch_archived). Idempotent: returns false with no audit when already associated, true after inserting and auditing structure.warehouse_branch_associated with the signed actor. EXECUTE: daftar_app only — reachability, not authority.';

CREATE OR REPLACE FUNCTION structure_dissociate_warehouse_branch(p_warehouse_id UUID, p_branch_id UUID) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_actor    inventory_verified_actor;
  v_business UUID;
  v_home     UUID;
  v_rows     INTEGER;
  v_trace    UUID;
BEGIN
  -- 1. Authority first, over the exact pair.
  v_actor := inventory_assertion_consume(
    'structure.dissociate_warehouse_branch',
    inventory_claimed_payload_digest(
      'structure.dissociate_warehouse_branch',
      ARRAY['uuid', 'uuid'],
      ARRAY[p_warehouse_id::text, p_branch_id::text]
    )
  );
  v_business := v_actor.business_id;
  v_trace    := inventory_business_transaction_id();

  IF p_warehouse_id IS NULL OR p_branch_id IS NULL THEN
    RAISE EXCEPTION 'inventory.payload_invalid: an association names a warehouse and a branch' USING ERRCODE = 'P0001';
  END IF;

  -- 2. Both rows exist in the ASSERTED business. Archived rows may still be
  --    dissociated: removing reach is never refused for being archived.
  SELECT w.branch_id INTO v_home FROM warehouses w WHERE w.business_id = v_business AND w.id = p_warehouse_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'structure.warehouse_not_found: the warehouse does not exist in this business' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM branches b WHERE b.business_id = v_business AND b.id = p_branch_id) THEN
    RAISE EXCEPTION 'structure.branch_not_found: the branch does not exist in this business' USING ERRCODE = 'P0001';
  END IF;

  -- 3. The home association is never removed while the warehouse exists —
  --    refused here, and again by branch_warehouses_keep_home at COMMIT.
  IF v_home = p_branch_id THEN
    RAISE EXCEPTION 'inventory.home_branch_association_required: the association of a warehouse with its home branch cannot be removed'
      USING ERRCODE = 'P0001';
  END IF;

  -- 4. Idempotent: an absent association is a success with no audit event.
  DELETE FROM branch_warehouses bw
   WHERE bw.business_id = v_business AND bw.branch_id = p_branch_id AND bw.warehouse_id = p_warehouse_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN false;
  END IF;

  INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, metadata)
  VALUES (v_actor.tenant_id, v_business, v_actor.actor_user_id, 'structure.warehouse_branch_dissociated', 'warehouse', p_warehouse_id::text,
          jsonb_build_object('warehouseId', p_warehouse_id, 'branchId', p_branch_id, 'assertionJti', v_actor.jti,
                             'business_transaction_id', v_trace));
  RETURN true;
END;
$$;

COMMENT ON FUNCTION structure_dissociate_warehouse_branch(UUID, UUID) IS
  'P3-AL-15 §B, P3-AL-54 §E, P3-AL-55 §G. First consumes an invctl/1 assertion of kind structure.dissociate_warehouse_branch over (warehouse_id, branch_id); the business is the asserted one. Both rows must exist there (structure.warehouse_not_found, structure.branch_not_found). The home association is refused (inventory.home_branch_association_required). Idempotent: returns false with no audit when not associated, true after deleting and auditing structure.warehouse_branch_dissociated with the signed actor. EXECUTE: daftar_app only — reachability, not authority.';

REVOKE ALL ON FUNCTION structure_associate_warehouse_branch(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION structure_dissociate_warehouse_branch(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION structure_associate_warehouse_branch(UUID, UUID) TO daftar_app;
GRANT EXECUTE ON FUNCTION structure_dissociate_warehouse_branch(UUID, UUID) TO daftar_app;

-- ─────────────────────────────────────────────────────────────────────────
-- 6. The ownership transfer (the immutability guard stays the migrator's).
-- ─────────────────────────────────────────────────────────────────────────
ALTER FUNCTION warehouses_home_branch_maintain() OWNER TO daftar_inventory_internal;
ALTER FUNCTION warehouses_require_home_branch() OWNER TO daftar_inventory_internal;
ALTER FUNCTION branch_warehouses_keep_home() OWNER TO daftar_inventory_internal;
ALTER FUNCTION structure_associate_warehouse_branch(UUID, UUID) OWNER TO daftar_inventory_internal;
ALTER FUNCTION structure_dissociate_warehouse_branch(UUID, UUID) OWNER TO daftar_inventory_internal;

REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;

COMMENT ON TABLE branch_warehouses IS
  'P3-AL-15. The warehouse AUTHORIZATION relation: an assigned-scope actor reaches a warehouse only through a row naming one of their branches. Every warehouse always has its home row (warehouses.branch_id restated), maintained for every writer by warehouses_home_branch_maintain and proved at COMMIT by warehouses_require_home_branch / branch_warehouses_keep_home. Other rows are written only by structure_associate_warehouse_branch / structure_dissociate_warehouse_branch. daftar_app: SELECT only.';

-- ─────────────────────────────────────────────────────────────────────────
-- 7. Refuse to commit unless the end state is exactly right.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_role   TEXT;
  v_priv   TEXT;
  v_detail TEXT;
BEGIN
  IF has_schema_privilege('daftar_inventory_internal', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'inventory.authority_leak: daftar_inventory_internal still holds CREATE on schema public';
  END IF;

  -- (a) The four lifecycle triggers, by name, on the expected tables, with
  --     the expected timing, events and deferral (P3-AL-15 §A).
  SELECT string_agg(x.name, ', ') INTO v_detail
  FROM (VALUES
    ('warehouses_home_branch_maintain',  'warehouses',        'warehouses_home_branch_maintain',  false, 4  + 1),
    ('warehouses_require_home_branch',   'warehouses',        'warehouses_require_home_branch',   true,  4  + 1),
    ('branch_warehouses_keep_home',      'branch_warehouses', 'branch_warehouses_keep_home',      true,  8 + 16 + 1),
    ('warehouses_home_branch_immutable', 'warehouses',        'warehouses_home_branch_immutable', false, 2 + 16 + 1)
  ) AS x(name, tbl, fn, deferred, tgtype)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE t.tgname = x.name AND c.relname = x.tbl AND p.proname = x.fn
      AND t.tgenabled = 'O' AND t.tgdeferrable = x.deferred AND t.tginitdeferred = x.deferred
      AND t.tgtype = x.tgtype
  );
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'inventory.authority_leak: warehouse lifecycle trigger(s) missing or reshaped: %', v_detail;
  END IF;

  -- (b) Rights and owners (P3-AL-54 §I).
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_detail
  FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
  WHERE p.proname IN ('warehouses_home_branch_maintain', 'warehouses_require_home_branch', 'branch_warehouses_keep_home',
                      'structure_associate_warehouse_branch', 'structure_dissociate_warehouse_branch')
    AND (r.rolname <> 'daftar_inventory_internal' OR NOT p.prosecdef
         OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
         OR has_function_privilege('public', p.oid, 'EXECUTE'));
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'inventory.authority_leak: warehouse authority routine(s) with the wrong owner, rights, path or PUBLIC EXECUTE: %', v_detail;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.proname = 'warehouses_home_branch_immutable' AND NOT p.prosecdef
                    AND pg_get_userbyid(p.proowner) = current_user
                    AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']
                    AND NOT has_function_privilege('public', p.oid, 'EXECUTE')) THEN
    RAISE EXCEPTION 'inventory.authority_leak: warehouses_home_branch_immutable must be an invoker-rights guard owned by the migrating principal';
  END IF;

  -- (c) The grant matrix of P3-AL-54 §H for this table and these routines.
  FOREACH v_priv IN ARRAY ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
    IF has_table_privilege('daftar_app', 'branch_warehouses', v_priv) THEN
      RAISE EXCEPTION 'inventory.authority_leak: daftar_app holds % on branch_warehouses', v_priv;
    END IF;
  END LOOP;
  IF NOT has_table_privilege('daftar_app', 'branch_warehouses', 'SELECT') THEN
    RAISE EXCEPTION 'inventory.authority_leak: daftar_app cannot read branch_warehouses';
  END IF;
  FOR v_role IN SELECT unnest(ARRAY['daftar_platform','daftar_worker','daftar_identity','daftar_resolver','daftar_provisioner','daftar_reconciler','public']) LOOP
    FOREACH v_priv IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
      IF has_table_privilege(v_role, 'branch_warehouses', v_priv) THEN
        RAISE EXCEPTION 'inventory.authority_leak: % holds % on branch_warehouses', v_role, v_priv;
      END IF;
    END LOOP;
    IF has_function_privilege(v_role, 'structure_associate_warehouse_branch(uuid,uuid)', 'EXECUTE')
       OR has_function_privilege(v_role, 'structure_dissociate_warehouse_branch(uuid,uuid)', 'EXECUTE') THEN
      RAISE EXCEPTION 'inventory.authority_leak: % may execute a warehouse association routine', v_role;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('daftar_app', 'structure_associate_warehouse_branch(uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('daftar_app', 'structure_dissociate_warehouse_branch(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'inventory.authority_leak: daftar_app cannot reach the warehouse association routines';
  END IF;
  IF has_table_privilege('daftar_inventory_internal', 'branch_warehouses', 'UPDATE')
     OR has_table_privilege('daftar_inventory_internal', 'branches', 'INSERT')
     OR has_table_privilege('daftar_inventory_internal', 'branches', 'UPDATE')
     OR has_table_privilege('daftar_inventory_internal', 'warehouses', 'INSERT')
     OR has_table_privilege('daftar_inventory_internal', 'warehouses', 'UPDATE') THEN
    RAISE EXCEPTION 'inventory.authority_leak: daftar_inventory_internal holds more than §H on the structure tables';
  END IF;

  -- (d) Row security: ENABLE + FORCE on both tables the seed touched, and
  --     exactly four policies — the two accepted ones for everybody, and the
  --     internal role's read and insert admission for it alone.
  IF (SELECT count(*) FROM pg_class WHERE relname IN ('branch_warehouses', 'warehouses') AND relkind = 'r'
        AND relrowsecurity AND relforcerowsecurity) <> 2 THEN
    RAISE EXCEPTION 'inventory.authority_leak: warehouses and branch_warehouses must ENABLE and FORCE row level security';
  END IF;
  IF (SELECT array_agg(pol.polname::text || ':' || pol.polcmd::text || ':' || pol.polpermissive::text || ':'
                       || (SELECT coalesce(string_agg(CASE WHEN r = 0 THEN 'public' ELSE pg_get_userbyid(r) END, ','), '') FROM unnest(pol.polroles) r)
                       ORDER BY pol.polname)
        FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid
       WHERE c.relname = 'branch_warehouses')
     IS DISTINCT FROM ARRAY['business_isolation:*:false:public',
                            'inventory_internal_insert:a:true:daftar_inventory_internal',
                            'inventory_internal_read:r:true:daftar_inventory_internal',
                            'tenant_membership:*:true:public'] THEN
    RAISE EXCEPTION 'inventory.authority_leak: branch_warehouses policies are not exactly the accepted pair plus the internal read/insert admission';
  END IF;
END $$;
