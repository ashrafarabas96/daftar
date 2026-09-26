-- 0061_inventory_movement_sources.sql
-- P3-S3, part 1 — the SOURCE side of transfers, adjustments, damage,
-- stocktakes and the inventory opening: the TD-13 prune replacement, the
-- strengthened source-guard discovery, the eight source-document tables, the
-- four bridges and their stock-side guards, the four stock source types, the
-- two accounting source types with their completeness, reversal and
-- opening-balance guards, the opening-position read, and the P3-AL-41
-- archival rule (docs/PHASE_3_S3_CONTRACT.md §2.1-§2.3, §2.6, §2.7, A-04,
-- A-05, A-11-A-19).
--
-- ── What this file does NOT do ──────────────────────────────────────────
--
-- It registers no inventory operation kind and no op→movement mapping. After
-- it, `inventory_operation_kinds` still holds the three P3-S1 rows and
-- `inventory_operation_movement_kinds` is empty, so no signed command can
-- reach a single new table or write a single movement (0061-E (9)). The
-- runtime reach is 0062's, and only 0062's.
--
-- ── Engineering rulings taken here (documented for the report) ──────────
--
--   R-1  Opening serialization lock. A-13 names a fresh advisory key
--        `hashtext('daftar.opening_position')`. `accounting_open_balance_post`
--        (0047, frozen) takes its own per-business key FIRST, then
--        `businesses` FOR UPDATE, and only then updates the status that
--        fires the A-14(c) guard. An inventory opening holding a different
--        key while its later posting waits for `businesses` would therefore
--        form a lock cycle with it. The only cycle-free choice is the lock
--        the opening-balance workflow already takes first:
--        `accounting_opening_balance_lock_key(business)`. It is taken by the
--        accounting-owned position read (A-14(d)) and by the A-14(c) guard
--        (re-entrant there). The read is therefore VOLATILE, not STABLE.
--   R-2  Product archival. A-19 has the product trigger take an EXCLUSIVE
--        advisory lock that every routine holds SHARED. The archiving UPDATE
--        already holds the product row, and the stock primitive takes that
--        row FOR SHARE (0060 step 4) while the routine would hold the shared
--        advisory lock — a cycle. Products are therefore serialized by the
--        row lock the primitive already takes, and 0062's routines re-check
--        product status AFTER the primitive (whose FOR SHARE waited for any
--        archiver). Warehouses and variants use the advisory key on their own
--        id: no stock command ever locks those rows, so no cycle exists.
--   R-3  `inventory_largest_remainder` is created HERE (not in 0062): the
--        opening's value-completeness trigger in this file needs it.
--   R-4  Accounting-side opening check. A-18 grants the accounting principal
--        the headers only, so the per-warehouse split of a Case A entry is
--        proven for membership, home branch, distinctness and totals; the
--        per-line shares are proven on the inventory side (A-15(f)).
--
-- Migrations 0000-0060 are FROZEN and untouched.

-- ─────────────────────────────────────────────────────────────────────────
-- 0. TD-13 pre-state capture (A-17). Transaction-local settings, no table:
--    compared in the end state of this same transaction.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  PERFORM set_config('daftar.td13_pre_accounting_actor',
    (SELECT format('%s|%s|%s|%s', p.proowner::regrole, p.prosecdef, coalesce(p.proconfig::text, '-'), coalesce(p.proacl::text, '-'))
       FROM pg_proc p WHERE p.oid = 'public.accounting_actor(text[])'::regprocedure), true);
  PERFORM set_config('daftar.td13_pre_provision_actor',
    (SELECT format('%s|%s|%s|%s', p.proowner::regrole, p.prosecdef, coalesce(p.proconfig::text, '-'), coalesce(p.proacl::text, '-'))
       FROM pg_proc p WHERE p.oid = 'public.provision_actor(text[])'::regprocedure), true);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. TD-13 (A-17): the plain-DELETE prunes become the 0054 advisory-lock
--    prune.
--
-- Reproduced from code first: `accounting_actor` (0045:233) and
-- `provision_actor` (0038:135) each end with
--     DELETE FROM <uses> WHERE used_at < now() - interval '1 hour';
-- which row-locks every expired row. While one consumer's transaction is
-- open, every other consumer — in any tenant — reaching the same DELETE
-- queues on those row locks until the first transaction ends. The fix is
-- exactly 0054:468-470: only the one transaction that wins a
-- transaction-scoped try-lock prunes; every other one skips hygiene without
-- waiting.
--
-- Both bodies are byte-identical to their accepted definitions except the
-- prune. `accounting_actor` is replaced BY ITS OWNER under SET LOCAL ROLE
-- (the 0040/0060 precedent); `provision_actor` by its owner, the migrator,
-- keeping the EFFECTIVE path 0045 §9b left (`public, pg_catalog, pg_temp`,
-- TL-9). CREATE OR REPLACE keeps owner and ACL; the end state proves it.
-- ─────────────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO daftar_accounting_internal;
SET LOCAL ROLE daftar_accounting_internal;

CREATE OR REPLACE FUNCTION accounting_actor(p_allowed_kinds TEXT[]) RETURNS accounting_verified_actor
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_raw      TEXT;
  v_parts    TEXT[];
  v_secret   BYTEA;
  v_expected TEXT;
  v_exp      BIGINT;
  v_jti      UUID;
  v_xact     XID8;
  v_out      accounting_verified_actor;
BEGIN
  v_raw := current_setting('app.accounting_assertion', true);
  IF v_raw IS NULL OR v_raw = '' THEN
    RAISE EXCEPTION 'accounting.assertion_missing: posting requires a server-minted accounting assertion' USING ERRCODE = 'P0001';
  END IF;

  v_parts := string_to_array(v_raw, '.');
  IF array_length(v_parts, 1) <> 12 OR v_parts[1] <> 'v1' THEN
    RAISE EXCEPTION 'accounting.assertion_malformed: the accounting assertion is malformed' USING ERRCODE = 'P0001';
  END IF;

  SELECT k.secret INTO v_secret
  FROM accounting_assertion_keys k
  WHERE k.kid = v_parts[2] AND k.status = 'active';
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'accounting.assertion_key_unknown: the accounting assertion key is unknown or retired' USING ERRCODE = 'P0001';
  END IF;

  -- The signature covers all eleven claims, so none of them can be swapped
  -- after minting.
  v_expected := encode(hmac(convert_to(array_to_string(v_parts[1:11], '.'), 'UTF8'), v_secret, 'sha256'), 'hex');
  IF length(v_parts[12]) <> 64 OR v_expected <> lower(v_parts[12]) THEN
    RAISE EXCEPTION 'accounting.assertion_invalid_signature: the accounting assertion signature is invalid' USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    v_out.actor_user_id       := v_parts[3]::uuid;
    v_out.tenant_id           := v_parts[4]::uuid;
    v_out.business_id         := v_parts[5]::uuid;
    v_out.operation_kind      := v_parts[6];
    v_out.source_type         := v_parts[7];
    v_out.source_id           := v_parts[8]::uuid;
    v_out.posting_fingerprint := lower(v_parts[9]);
    v_exp                     := v_parts[10]::bigint;
    v_jti                     := v_parts[11]::uuid;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'accounting.assertion_malformed: the accounting assertion claims are malformed' USING ERRCODE = 'P0001';
  END;

  IF v_out.posting_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'accounting.assertion_malformed: the accounting assertion carries no valid posting fingerprint' USING ERRCODE = 'P0001';
  END IF;
  IF v_exp <= extract(epoch FROM now())::bigint THEN
    RAISE EXCEPTION 'accounting.assertion_expired: the accounting assertion has expired' USING ERRCODE = 'P0001';
  END IF;
  IF NOT (v_out.operation_kind = ANY (p_allowed_kinds)) THEN
    RAISE EXCEPTION 'accounting.assertion_wrong_operation: the accounting assertion was minted for a different operation' USING ERRCODE = 'P0001';
  END IF;

  -- Replay: the jti belongs to the FIRST transaction that presents it. Several
  -- trusted calls composing one workflow inside that transaction may present
  -- it again; a later transaction may not (§17).
  INSERT INTO accounting_assertion_uses (jti, xact) VALUES (v_jti, pg_current_xact_id())
  ON CONFLICT (jti) DO NOTHING;
  SELECT u.xact INTO v_xact FROM accounting_assertion_uses u WHERE u.jti = v_jti;
  IF v_xact <> pg_current_xact_id() THEN
    RAISE EXCEPTION 'accounting.assertion_replayed: the accounting assertion was already used' USING ERRCODE = 'P0001';
  END IF;

  -- Opportunistic hygiene: a jti is useless once well past the longest TTL.
  -- TD-13 (P3-S3): it must never make a consumer wait, so only the one
  -- transaction that wins this transaction-scoped try-lock prunes.
  IF pg_try_advisory_xact_lock(hashtext('daftar.accounting_assertion_uses'), hashtext('hygiene')) THEN
    DELETE FROM accounting_assertion_uses WHERE used_at < now() - interval '1 hour';
  END IF;

  RETURN v_out;
END;
$$;

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM daftar_accounting_internal;

CREATE OR REPLACE FUNCTION provision_actor(p_allowed_kinds TEXT[]) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog, pg_temp AS $$
DECLARE
  v_raw      TEXT;
  v_parts    TEXT[];
  v_secret   BYTEA;
  v_expected TEXT;
  v_exp      BIGINT;
  v_actor    UUID;
  v_jti      UUID;
  v_xact     XID8;
BEGIN
  v_raw := current_setting('app.provisioning_assertion', true);
  IF v_raw IS NULL OR v_raw = '' THEN
    RAISE EXCEPTION 'PROV:FORBIDDEN:Provisioning requires a server-minted assertion';
  END IF;
  v_parts := string_to_array(v_raw, '.');
  IF array_length(v_parts, 1) <> 7 OR v_parts[1] <> 'v1' THEN
    RAISE EXCEPTION 'PROV:FORBIDDEN:Provisioning assertion is malformed';
  END IF;

  SELECT k.secret INTO v_secret FROM provisioning_assertion_keys k WHERE k.kid = v_parts[2] AND k.status = 'active';
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'PROV:FORBIDDEN:Provisioning assertion key is unknown or retired';
  END IF;

  -- Signature over every claim (version, kid, actor, kind, exp, jti).
  v_expected := encode(hmac(convert_to(array_to_string(v_parts[1:6], '.'), 'UTF8'), v_secret, 'sha256'), 'hex');
  IF length(v_parts[7]) <> 64 OR v_expected <> lower(v_parts[7]) THEN
    RAISE EXCEPTION 'PROV:FORBIDDEN:Provisioning assertion signature is invalid';
  END IF;

  BEGIN
    v_actor := v_parts[3]::uuid;
    v_exp   := v_parts[5]::bigint;
    v_jti   := v_parts[6]::uuid;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'PROV:FORBIDDEN:Provisioning assertion claims are malformed';
  END;

  IF v_exp <= extract(epoch FROM now())::bigint THEN
    RAISE EXCEPTION 'PROV:FORBIDDEN:Provisioning assertion has expired';
  END IF;
  IF NOT (v_parts[4] = ANY (p_allowed_kinds)) THEN
    RAISE EXCEPTION 'PROV:FORBIDDEN:Provisioning assertion was minted for a different operation (%)', v_parts[4];
  END IF;

  -- Single use: the jti belongs to the first transaction that presents it.
  INSERT INTO provisioning_assertion_uses (jti, xact) VALUES (v_jti, pg_current_xact_id())
  ON CONFLICT (jti) DO NOTHING;
  SELECT u.xact INTO v_xact FROM provisioning_assertion_uses u WHERE u.jti = v_jti;
  IF v_xact <> pg_current_xact_id() THEN
    RAISE EXCEPTION 'PROV:FORBIDDEN:Provisioning assertion was already used';
  END IF;
  -- Opportunistic hygiene: expired jtis are useless after the longest TTL.
  -- TD-13 (P3-S3): never make a consumer wait on another's row locks.
  IF pg_try_advisory_xact_lock(hashtext('daftar.provisioning_assertion_uses'), hashtext('hygiene')) THEN
    DELETE FROM provisioning_assertion_uses WHERE used_at < now() - interval '1 hour';
  END IF;

  RETURN v_actor;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. The strengthened source-guard discovery (A-16), BEFORE any source type
--    is registered.
--
-- The S2 body checked NAMES: a trigger of the right name on the wrong event,
-- with the wrong function, or enabled only for replica sessions ('R') passed.
-- This body checks the SHAPE of every guard. Same owner (the migrator), same
-- signature, still SECURITY INVOKER, STABLE and pinned; strictly stronger.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION inventory_stock_source_guard_gaps()
RETURNS TABLE (source_type TEXT, missing TEXT)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_type   TEXT;
  v_bridge REGCLASS;
  v_bind   REGCLASS := 'public.stock_source_bindings'::regclass;
  v_fn     REGPROCEDURE;
BEGIN
  FOR v_type IN SELECT t.source_type FROM stock_source_types t ORDER BY t.source_type LOOP
    v_bridge := to_regclass('public.stock_source_bridge_' || v_type);
    IF v_bridge IS NULL OR NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = v_bridge AND c.relkind = 'r') THEN
      source_type := v_type; missing := 'bridge'; RETURN NEXT;
    ELSE
      IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = v_bridge AND c.relrowsecurity AND c.relforcerowsecurity) THEN
        source_type := v_type; missing := 'bridge_rls'; RETURN NEXT;
      END IF;
      IF (SELECT array_agg(a.attname::text ORDER BY k.ord)
            FROM pg_constraint c
            CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
           WHERE c.conrelid = v_bridge AND c.contype = 'p')
         IS DISTINCT FROM ARRAY['business_id', 'source_id', 'source_line_id', 'movement_kind'] THEN
        source_type := v_type; missing := 'bridge_pk'; RETURN NEXT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                      WHERE a.attrelid = v_bridge AND a.attname = 'source_type' AND NOT a.attisdropped
                        AND a.attgenerated = 's'
                        AND pg_get_expr(d.adbin, d.adrelid) = quote_literal(v_type) || '::text') THEN
        source_type := v_type; missing := 'bridge_source_type'; RETURN NEXT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                      WHERE c.contype = 'f' AND c.conrelid = v_bridge AND c.confrelid = v_bind AND c.confdeltype = 'r'
                        AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
                               FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
                            = ARRAY['business_id', 'source_type', 'source_id', 'source_line_id', 'movement_kind']
                        AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
                               FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
                               JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum)
                            = ARRAY['business_id', 'source_type', 'source_id', 'source_line_id', 'movement_kind']) THEN
        source_type := v_type; missing := 'bridge_binding_fk'; RETURN NEXT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                      WHERE c.contype = 'f' AND c.conrelid = v_bridge AND c.confrelid <> v_bind
                        AND c.confrelid <> v_bridge AND c.confdeltype = 'r'
                        AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
                               FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
                            = ARRAY['business_id', 'source_id', 'source_line_id']) THEN
        source_type := v_type; missing := 'bridge_line_fk'; RETURN NEXT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                      WHERE g.tgrelid = v_bridge AND NOT g.tgisinternal
                        AND g.tgname = 'stock_bridge_immutable_' || v_type
                        AND g.tgtype = 27                -- ROW | BEFORE | DELETE | UPDATE, nothing else
                        AND g.tgenabled IN ('O', 'A')
                        AND g.tgfoid = 'public.stock_ledger_append_only()'::regprocedure) THEN
        source_type := v_type; missing := 'bridge_immutable'; RETURN NEXT;
      END IF;
    END IF;
    v_fn := to_regprocedure('public.stock_binding_requires_' || v_type || '()');
    IF v_fn IS NULL OR NOT EXISTS (
         SELECT 1 FROM pg_trigger g
           JOIN pg_proc p ON p.oid = g.tgfoid
           JOIN pg_roles r ON r.oid = p.proowner
          WHERE g.tgrelid = v_bind
            AND g.tgname = 'stock_binding_requires_' || v_type
            AND g.tgtype = 5                              -- ROW | AFTER | INSERT, nothing else
            AND g.tgconstraint <> 0 AND g.tgdeferrable AND g.tginitdeferred
            AND g.tgenabled IN ('O', 'A')
            AND g.tgfoid = v_fn
            AND r.rolname = 'daftar_inventory_internal' AND p.prosecdef
            AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']
            AND position('WHEN ((new.source_type = ' || quote_literal(v_type) || '::text))' IN pg_get_triggerdef(g.oid)) > 0) THEN
      source_type := v_type; missing := 'binding_trigger'; RETURN NEXT;
    END IF;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION inventory_stock_source_guard_gaps() IS
  'P3-AL-51 §B, strengthened by P3-S3 (A-16). Catalogue-only discovery: for every stock_source_types row, reports each missing or mis-shaped guard — bridge (a plain table), bridge_rls (enabled and forced), bridge_pk (exactly business_id, source_id, source_line_id, movement_kind), bridge_source_type (a stored generated constant equal to the type), bridge_binding_fk (RESTRICT, five columns in order), bridge_line_fk (RESTRICT, business_id, source_id, source_line_id), bridge_immutable (ROW BEFORE UPDATE OR DELETE, enabled for origin sessions, on stock_ledger_append_only()), binding_trigger (ROW AFTER INSERT deferred constraint trigger on its own internal DEFINER function with the pinned path and the WHEN on the type). Every migration that registers a source type asserts it returns no row. Migrator-owned INVOKER; no EXECUTE grant.';

REVOKE ALL ON FUNCTION inventory_stock_source_guard_gaps() FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. The ownership-transfer authority for the rest of this file.
-- ─────────────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;
GRANT CREATE ON SCHEMA public TO daftar_accounting_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. The source documents (§2.2, A-04).
--
-- `source_id` of every movement is the document id and `source_line_id` a
-- real line id. Headers and lines of transfers, adjustments and openings are
-- complete at insert and immutable. A stocktake is the one document with a
-- human interval: draft → finalized | cancelled, nothing else.
--
-- Money is BIGINT minor units, costs NUMERIC(28,10), quantities
-- NUMERIC(18,4). A posting header carries a nullable mirror of its own id,
-- `binding_source_id`, bound to the accounting binding registry by a
-- DEFERRABLE foreign key (the 0047 shape): NULL exactly when no entry is
-- owed, so the header cannot commit without its entry and vice versa
-- (A-14(a)).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE inventory_transfers (
  tenant_id                UUID NOT NULL,
  business_id              UUID NOT NULL,
  id                       UUID NOT NULL,
  source_warehouse_id      UUID NOT NULL,
  destination_warehouse_id UUID NOT NULL,
  intent_sha256            TEXT NOT NULL CHECK (intent_sha256 ~ '^[0-9a-f]{64}$'),
  actor_user_id            UUID NOT NULL REFERENCES users (id),
  business_transaction_id  UUID NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id),
  CONSTRAINT inventory_transfers_distinct_ck CHECK (source_warehouse_id <> destination_warehouse_id),
  CONSTRAINT inventory_transfers_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT inventory_transfers_source_fk FOREIGN KEY (business_id, source_warehouse_id) REFERENCES warehouses (business_id, id),
  CONSTRAINT inventory_transfers_destination_fk FOREIGN KEY (business_id, destination_warehouse_id) REFERENCES warehouses (business_id, id)
);
REVOKE ALL ON inventory_transfers FROM PUBLIC;

CREATE TABLE inventory_transfer_lines (
  tenant_id   UUID NOT NULL,
  business_id UUID NOT NULL,
  transfer_id UUID NOT NULL,
  id          UUID NOT NULL,
  line_no     INTEGER NOT NULL CHECK (line_no > 0),
  variant_id  UUID NOT NULL,
  qty         NUMERIC(18,4) NOT NULL CHECK (qty > 0),
  PRIMARY KEY (business_id, transfer_id, id),
  CONSTRAINT inventory_transfer_lines_line_no_uq UNIQUE (business_id, transfer_id, line_no),
  CONSTRAINT inventory_transfer_lines_variant_uq UNIQUE (business_id, transfer_id, variant_id),
  CONSTRAINT inventory_transfer_lines_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT inventory_transfer_lines_header_fk FOREIGN KEY (business_id, transfer_id) REFERENCES inventory_transfers (business_id, id),
  CONSTRAINT inventory_transfer_lines_variant_fk FOREIGN KEY (business_id, variant_id) REFERENCES product_variants (business_id, id)
);
REVOKE ALL ON inventory_transfer_lines FROM PUBLIC;

CREATE TABLE inventory_adjustments (
  tenant_id               UUID NOT NULL,
  business_id             UUID NOT NULL,
  id                      UUID NOT NULL,
  kind                    TEXT NOT NULL CHECK (kind IN ('adjustment', 'damage')),
  warehouse_id            UUID NOT NULL,
  occurred_on             DATE NOT NULL,
  reason                  TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500),
  intent_sha256           TEXT NOT NULL CHECK (intent_sha256 ~ '^[0-9a-f]{64}$'),
  total_value_base_minor  BIGINT NOT NULL CHECK (total_value_base_minor BETWEEN -1000000000000000000 AND 1000000000000000000),
  accounting_source_type  TEXT NOT NULL GENERATED ALWAYS AS ('inventory_adjustment') STORED,
  binding_source_id       UUID,
  actor_user_id           UUID NOT NULL REFERENCES users (id),
  business_transaction_id UUID NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id),
  CONSTRAINT inventory_adjustments_binding_identity_ck CHECK (binding_source_id IS NULL OR binding_source_id = id),
  CONSTRAINT inventory_adjustments_binding_owed_ck CHECK ((total_value_base_minor = 0) = (binding_source_id IS NULL)),
  CONSTRAINT inventory_adjustments_damage_sign_ck CHECK (kind <> 'damage' OR total_value_base_minor <= 0),
  CONSTRAINT inventory_adjustments_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT inventory_adjustments_warehouse_fk FOREIGN KEY (business_id, warehouse_id) REFERENCES warehouses (business_id, id),
  CONSTRAINT inventory_adjustments_binding_fk
    FOREIGN KEY (business_id, accounting_source_type, binding_source_id)
    REFERENCES accounting_source_bindings (business_id, source_type, source_id)
    DEFERRABLE INITIALLY DEFERRED
);
REVOKE ALL ON inventory_adjustments FROM PUBLIC;

CREATE TABLE inventory_adjustment_lines (
  tenant_id            UUID NOT NULL,
  business_id          UUID NOT NULL,
  adjustment_id        UUID NOT NULL,
  id                   UUID NOT NULL,
  line_no              INTEGER NOT NULL CHECK (line_no > 0),
  variant_id           UUID NOT NULL,
  qty_delta            NUMERIC(18,4) NOT NULL CHECK (qty_delta <> 0),
  unit_cost_base_minor NUMERIC(28,10) CHECK (unit_cost_base_minor IS NULL OR unit_cost_base_minor >= 0),
  PRIMARY KEY (business_id, adjustment_id, id),
  CONSTRAINT inventory_adjustment_lines_cost_shape_ck CHECK ((qty_delta > 0) = (unit_cost_base_minor IS NOT NULL)),
  CONSTRAINT inventory_adjustment_lines_line_no_uq UNIQUE (business_id, adjustment_id, line_no),
  CONSTRAINT inventory_adjustment_lines_variant_uq UNIQUE (business_id, adjustment_id, variant_id),
  CONSTRAINT inventory_adjustment_lines_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT inventory_adjustment_lines_header_fk FOREIGN KEY (business_id, adjustment_id) REFERENCES inventory_adjustments (business_id, id),
  CONSTRAINT inventory_adjustment_lines_variant_fk FOREIGN KEY (business_id, variant_id) REFERENCES product_variants (business_id, id)
);
REVOKE ALL ON inventory_adjustment_lines FROM PUBLIC;

CREATE TABLE stocktakes (
  tenant_id              UUID NOT NULL,
  business_id            UUID NOT NULL,
  id                     UUID NOT NULL,
  warehouse_id           UUID NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN ('draft', 'finalized', 'cancelled')),
  intent_sha256          TEXT NOT NULL CHECK (intent_sha256 ~ '^[0-9a-f]{64}$'),
  finalize_intent_sha256 TEXT CHECK (finalize_intent_sha256 IS NULL OR finalize_intent_sha256 ~ '^[0-9a-f]{64}$'),
  occurred_on            DATE,
  total_value_base_minor BIGINT CHECK (total_value_base_minor IS NULL OR total_value_base_minor BETWEEN -1000000000000000000 AND 1000000000000000000),
  accounting_source_type TEXT NOT NULL GENERATED ALWAYS AS ('inventory_adjustment') STORED,
  binding_source_id      UUID,
  opened_by              UUID NOT NULL REFERENCES users (id),
  closed_by              UUID REFERENCES users (id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_at           TIMESTAMPTZ,
  cancelled_at           TIMESTAMPTZ,
  PRIMARY KEY (business_id, id),
  CONSTRAINT stocktakes_binding_identity_ck CHECK (binding_source_id IS NULL OR binding_source_id = id),
  -- The state machine as a physical shape (the 0047 pattern).
  CONSTRAINT stocktakes_state_ck CHECK (
    (status = 'draft'
       AND finalize_intent_sha256 IS NULL AND occurred_on IS NULL AND total_value_base_minor IS NULL
       AND binding_source_id IS NULL AND closed_by IS NULL AND finalized_at IS NULL AND cancelled_at IS NULL)
    OR (status = 'finalized'
       AND finalize_intent_sha256 IS NOT NULL AND occurred_on IS NOT NULL AND total_value_base_minor IS NOT NULL
       AND closed_by IS NOT NULL AND finalized_at IS NOT NULL AND cancelled_at IS NULL
       AND (total_value_base_minor <> 0) = (binding_source_id IS NOT NULL))
    OR (status = 'cancelled'
       AND finalize_intent_sha256 IS NOT NULL AND cancelled_at IS NOT NULL AND closed_by IS NOT NULL
       AND occurred_on IS NULL AND total_value_base_minor IS NULL AND binding_source_id IS NULL AND finalized_at IS NULL)
  ),
  CONSTRAINT stocktakes_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT stocktakes_warehouse_fk FOREIGN KEY (business_id, warehouse_id) REFERENCES warehouses (business_id, id),
  CONSTRAINT stocktakes_binding_fk
    FOREIGN KEY (business_id, accounting_source_type, binding_source_id)
    REFERENCES accounting_source_bindings (business_id, source_type, source_id)
    DEFERRABLE INITIALLY DEFERRED
);
REVOKE ALL ON stocktakes FROM PUBLIC;

-- Two open drafts counting one key would apply one physical correction twice.
CREATE UNIQUE INDEX stocktakes_one_draft_per_warehouse_uq ON stocktakes (business_id, warehouse_id) WHERE status = 'draft';

CREATE TABLE stocktake_lines (
  tenant_id                UUID NOT NULL,
  business_id              UUID NOT NULL,
  stocktake_id             UUID NOT NULL,
  id                       UUID NOT NULL,
  variant_id               UUID NOT NULL,
  expected_qty_at_capture  NUMERIC(18,4) NOT NULL CHECK (expected_qty_at_capture >= 0),
  captured_at_stock_seq    BIGINT NOT NULL CHECK (captured_at_stock_seq >= 0),
  counted_qty              NUMERIC(18,4) NOT NULL CHECK (counted_qty >= 0),
  variance_qty             NUMERIC(18,4) GENERATED ALWAYS AS (counted_qty - expected_qty_at_capture) STORED,
  unit_cost_base_minor     NUMERIC(28,10) CHECK (unit_cost_base_minor IS NULL OR unit_cost_base_minor >= 0),
  applied_value_base_minor BIGINT CHECK (applied_value_base_minor IS NULL OR applied_value_base_minor BETWEEN -1000000000000000000 AND 1000000000000000000),
  captured_at              TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (business_id, stocktake_id, id),
  CONSTRAINT stocktake_lines_variant_uq UNIQUE (business_id, stocktake_id, variant_id),
  CONSTRAINT stocktake_lines_zero_variance_ck CHECK (variance_qty <> 0 OR applied_value_base_minor IS NULL),
  CONSTRAINT stocktake_lines_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT stocktake_lines_header_fk FOREIGN KEY (business_id, stocktake_id) REFERENCES stocktakes (business_id, id),
  CONSTRAINT stocktake_lines_variant_fk FOREIGN KEY (business_id, variant_id) REFERENCES product_variants (business_id, id)
);
REVOKE ALL ON stocktake_lines FROM PUBLIC;

CREATE TABLE inventory_openings (
  tenant_id                 UUID NOT NULL,
  business_id               UUID NOT NULL,
  id                        UUID NOT NULL,
  status                    TEXT NOT NULL CHECK (status IN ('posted', 'superseded')),
  case_kind                 TEXT NOT NULL CHECK (case_kind IN ('ledger_posting', 'opening_balance_bound')),
  occurred_on               DATE NOT NULL,
  opening_balance_id        UUID,
  matched_amount_base_minor BIGINT,
  total_value_base_minor    BIGINT NOT NULL CHECK (total_value_base_minor BETWEEN 0 AND 1000000000000000000),
  accounting_source_type    TEXT NOT NULL GENERATED ALWAYS AS ('inventory_opening') STORED,
  binding_source_id         UUID,
  intent_sha256             TEXT NOT NULL CHECK (intent_sha256 ~ '^[0-9a-f]{64}$'),
  actor_user_id             UUID NOT NULL REFERENCES users (id),
  business_transaction_id   UUID NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id),
  CONSTRAINT inventory_openings_binding_identity_ck CHECK (binding_source_id IS NULL OR binding_source_id = id),
  CONSTRAINT inventory_openings_case_ck CHECK (
    (case_kind = 'ledger_posting'
       AND opening_balance_id IS NULL AND matched_amount_base_minor IS NULL
       AND (binding_source_id IS NOT NULL) = (total_value_base_minor > 0))
    OR (case_kind = 'opening_balance_bound'
       AND opening_balance_id IS NOT NULL AND matched_amount_base_minor = total_value_base_minor
       AND binding_source_id IS NULL)
  ),
  CONSTRAINT inventory_openings_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT inventory_openings_opening_balance_fk
    FOREIGN KEY (business_id, opening_balance_id) REFERENCES accounting_opening_balances (business_id, id),
  CONSTRAINT inventory_openings_binding_fk
    FOREIGN KEY (business_id, accounting_source_type, binding_source_id)
    REFERENCES accounting_source_bindings (business_id, source_type, source_id)
    DEFERRABLE INITIALLY DEFERRED
);
REVOKE ALL ON inventory_openings FROM PUBLIC;

-- At most one posted opening per business (L:724).
CREATE UNIQUE INDEX inventory_openings_posted_uq ON inventory_openings (business_id) WHERE status = 'posted';

CREATE TABLE inventory_opening_lines (
  tenant_id            UUID NOT NULL,
  business_id          UUID NOT NULL,
  opening_id           UUID NOT NULL,
  id                   UUID NOT NULL,
  line_no              INTEGER NOT NULL CHECK (line_no > 0),
  warehouse_id         UUID NOT NULL,
  variant_id           UUID NOT NULL,
  qty                  NUMERIC(18,4) NOT NULL CHECK (qty > 0),
  unit_cost_base_minor NUMERIC(28,10) NOT NULL CHECK (unit_cost_base_minor >= 0),
  PRIMARY KEY (business_id, opening_id, id),
  CONSTRAINT inventory_opening_lines_line_no_uq UNIQUE (business_id, opening_id, line_no),
  CONSTRAINT inventory_opening_lines_key_uq UNIQUE (business_id, opening_id, warehouse_id, variant_id),
  CONSTRAINT inventory_opening_lines_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT inventory_opening_lines_header_fk FOREIGN KEY (business_id, opening_id) REFERENCES inventory_openings (business_id, id),
  CONSTRAINT inventory_opening_lines_warehouse_fk FOREIGN KEY (business_id, warehouse_id) REFERENCES warehouses (business_id, id),
  CONSTRAINT inventory_opening_lines_variant_fk FOREIGN KEY (business_id, variant_id) REFERENCES product_variants (business_id, id)
);
REVOKE ALL ON inventory_opening_lines FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. The four bridges (A-15(a)): exactly the L:1501-1519 template.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE stock_source_bridge_inventory_transfer (
  business_id    UUID NOT NULL,
  source_id      UUID NOT NULL,
  source_line_id UUID NOT NULL,
  movement_kind  TEXT NOT NULL,
  source_type    TEXT NOT NULL GENERATED ALWAYS AS ('inventory_transfer') STORED,
  PRIMARY KEY (business_id, source_id, source_line_id, movement_kind),
  CONSTRAINT stock_source_bridge_inventory_transfer_line_fk
    FOREIGN KEY (business_id, source_id, source_line_id)
    REFERENCES inventory_transfer_lines (business_id, transfer_id, id) ON DELETE RESTRICT,
  CONSTRAINT stock_source_bridge_inventory_transfer_binding_fk
    FOREIGN KEY (business_id, source_type, source_id, source_line_id, movement_kind)
    REFERENCES stock_source_bindings (business_id, source_type, source_id, source_line_id, movement_kind) ON DELETE RESTRICT
);
REVOKE ALL ON stock_source_bridge_inventory_transfer FROM PUBLIC;

CREATE TABLE stock_source_bridge_inventory_adjustment (
  business_id    UUID NOT NULL,
  source_id      UUID NOT NULL,
  source_line_id UUID NOT NULL,
  movement_kind  TEXT NOT NULL,
  source_type    TEXT NOT NULL GENERATED ALWAYS AS ('inventory_adjustment') STORED,
  PRIMARY KEY (business_id, source_id, source_line_id, movement_kind),
  CONSTRAINT stock_source_bridge_inventory_adjustment_line_fk
    FOREIGN KEY (business_id, source_id, source_line_id)
    REFERENCES inventory_adjustment_lines (business_id, adjustment_id, id) ON DELETE RESTRICT,
  CONSTRAINT stock_source_bridge_inventory_adjustment_binding_fk
    FOREIGN KEY (business_id, source_type, source_id, source_line_id, movement_kind)
    REFERENCES stock_source_bindings (business_id, source_type, source_id, source_line_id, movement_kind) ON DELETE RESTRICT
);
REVOKE ALL ON stock_source_bridge_inventory_adjustment FROM PUBLIC;

CREATE TABLE stock_source_bridge_stocktake (
  business_id    UUID NOT NULL,
  source_id      UUID NOT NULL,
  source_line_id UUID NOT NULL,
  movement_kind  TEXT NOT NULL,
  source_type    TEXT NOT NULL GENERATED ALWAYS AS ('stocktake') STORED,
  PRIMARY KEY (business_id, source_id, source_line_id, movement_kind),
  CONSTRAINT stock_source_bridge_stocktake_line_fk
    FOREIGN KEY (business_id, source_id, source_line_id)
    REFERENCES stocktake_lines (business_id, stocktake_id, id) ON DELETE RESTRICT,
  CONSTRAINT stock_source_bridge_stocktake_binding_fk
    FOREIGN KEY (business_id, source_type, source_id, source_line_id, movement_kind)
    REFERENCES stock_source_bindings (business_id, source_type, source_id, source_line_id, movement_kind) ON DELETE RESTRICT
);
REVOKE ALL ON stock_source_bridge_stocktake FROM PUBLIC;

CREATE TABLE stock_source_bridge_inventory_opening (
  business_id    UUID NOT NULL,
  source_id      UUID NOT NULL,
  source_line_id UUID NOT NULL,
  movement_kind  TEXT NOT NULL,
  source_type    TEXT NOT NULL GENERATED ALWAYS AS ('inventory_opening') STORED,
  PRIMARY KEY (business_id, source_id, source_line_id, movement_kind),
  CONSTRAINT stock_source_bridge_inventory_opening_line_fk
    FOREIGN KEY (business_id, source_id, source_line_id)
    REFERENCES inventory_opening_lines (business_id, opening_id, id) ON DELETE RESTRICT,
  CONSTRAINT stock_source_bridge_inventory_opening_binding_fk
    FOREIGN KEY (business_id, source_type, source_id, source_line_id, movement_kind)
    REFERENCES stock_source_bindings (business_id, source_type, source_id, source_line_id, movement_kind) ON DELETE RESTRICT
);
REVOKE ALL ON stock_source_bridge_inventory_opening FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────
-- 6. Stock-side functions (A-15(b)-(f), A-19, R-3). Created while the
--    migrator owns them; PUBLIC revoked, triggers installed, then handed to
--    the internal principal (S2 order).
-- ─────────────────────────────────────────────────────────────────────────

-- The opening allocator (L:785, A-13): largest remainder of p_total over the
-- non-negative weights, tie-break on array index (= line_no). Exact NUMERIC
-- integer division only. All-zero weights give all-zero shares.
CREATE OR REPLACE FUNCTION inventory_largest_remainder(p_weights NUMERIC[], p_total BIGINT) RETURNS BIGINT[]
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_n      INTEGER;
  v_w      NUMERIC := 0;
  v_shares BIGINT[];
  v_rest   NUMERIC[];
  v_sum    NUMERIC := 0;
  v_left   BIGINT;
  v_i      INTEGER;
  v_ix     INTEGER;
BEGIN
  IF p_weights IS NULL OR p_total IS NULL OR p_total < 0 OR array_ndims(p_weights) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'inventory.allocation_invalid: an allocation needs one-dimensional weights and a non-negative total' USING ERRCODE = 'P0001';
  END IF;
  v_n := cardinality(p_weights);
  FOR v_i IN 1 .. v_n LOOP
    IF p_weights[array_lower(p_weights, 1) + v_i - 1] IS NULL OR p_weights[array_lower(p_weights, 1) + v_i - 1] < 0 THEN
      RAISE EXCEPTION 'inventory.allocation_invalid: an allocation weight is present and non-negative' USING ERRCODE = 'P0001';
    END IF;
    v_w := v_w + p_weights[array_lower(p_weights, 1) + v_i - 1];
  END LOOP;
  v_shares := array_fill(0::bigint, ARRAY[v_n]);
  v_rest   := array_fill(0::numeric, ARRAY[v_n]);
  IF v_n = 0 OR v_w = 0 THEN
    RETURN v_shares;
  END IF;
  FOR v_i IN 1 .. v_n LOOP
    v_shares[v_i] := div(p_total::numeric * p_weights[array_lower(p_weights, 1) + v_i - 1], v_w)::bigint;
    v_rest[v_i]   := p_total::numeric * p_weights[array_lower(p_weights, 1) + v_i - 1] - v_shares[v_i]::numeric * v_w;
    v_sum         := v_sum + v_shares[v_i];
  END LOOP;
  v_left := (p_total::numeric - v_sum)::bigint;
  FOR v_ix IN
    SELECT r.ix FROM unnest(v_rest) WITH ORDINALITY AS r(rest, ix) ORDER BY r.rest DESC, r.ix ASC LIMIT v_left
  LOOP
    v_shares[v_ix] := v_shares[v_ix] + 1;
  END LOOP;
  RETURN v_shares;
END;
$$;

COMMENT ON FUNCTION inventory_largest_remainder(NUMERIC[], BIGINT) IS
  'P3-S3 A-13 (L:785). Largest-remainder allocation of p_total over non-negative exact weights: s_i = floor(T·w_i/W), then the residue one unit at a time to the largest remainders, ties by array index (line_no ASC). Sum of shares = T exactly; all-zero weights give zeros. inventory.allocation_invalid otherwise. No grant.';

-- (b) Binding → bridge, at COMMIT, one function per source type.
CREATE OR REPLACE FUNCTION stock_binding_requires_inventory_transfer() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM stock_source_bridge_inventory_transfer b
                  WHERE b.business_id = NEW.business_id AND b.source_id = NEW.source_id
                    AND b.source_line_id = NEW.source_line_id AND b.movement_kind = NEW.movement_kind) THEN
    RAISE EXCEPTION 'inventory.stock_source_line_missing: a transfer stock binding has no source line' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION stock_binding_requires_inventory_adjustment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM stock_source_bridge_inventory_adjustment b
                  WHERE b.business_id = NEW.business_id AND b.source_id = NEW.source_id
                    AND b.source_line_id = NEW.source_line_id AND b.movement_kind = NEW.movement_kind) THEN
    RAISE EXCEPTION 'inventory.stock_source_line_missing: an adjustment stock binding has no source line' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION stock_binding_requires_stocktake() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM stock_source_bridge_stocktake b
                  WHERE b.business_id = NEW.business_id AND b.source_id = NEW.source_id
                    AND b.source_line_id = NEW.source_line_id AND b.movement_kind = NEW.movement_kind) THEN
    RAISE EXCEPTION 'inventory.stock_source_line_missing: a stocktake stock binding has no source line' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION stock_binding_requires_inventory_opening() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM stock_source_bridge_inventory_opening b
                  WHERE b.business_id = NEW.business_id AND b.source_id = NEW.source_id
                    AND b.source_line_id = NEW.source_line_id AND b.movement_kind = NEW.movement_kind) THEN
    RAISE EXCEPTION 'inventory.stock_source_line_missing: an opening stock binding has no source line' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

-- (d) Line → required movement set, at COMMIT. Every movement is found
--     THROUGH the bridge and matched by kind, warehouse, variant and
--     quantity; any other movement on the line makes the count wrong.
CREATE OR REPLACE FUNCTION stock_source_complete_inventory_transfer() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_src   UUID;
  v_dst   UUID;
  v_all   INTEGER;
  v_out   INTEGER;
  v_in    INTEGER;
BEGIN
  SELECT t.source_warehouse_id, t.destination_warehouse_id INTO v_src, v_dst
  FROM inventory_transfers t WHERE t.business_id = NEW.business_id AND t.id = NEW.transfer_id;
  SELECT count(*),
         count(*) FILTER (WHERE m.movement_kind = 'transfer_out' AND m.warehouse_id = v_src
                            AND m.variant_id = NEW.variant_id AND m.qty_delta = -NEW.qty),
         count(*) FILTER (WHERE m.movement_kind = 'transfer_in' AND m.warehouse_id = v_dst
                            AND m.variant_id = NEW.variant_id AND m.qty_delta = NEW.qty)
    INTO v_all, v_out, v_in
  FROM stock_source_bridge_inventory_transfer b
  JOIN stock_movements m ON m.business_id = b.business_id AND m.source_type = b.source_type AND m.source_id = b.source_id
                        AND m.source_line_id = b.source_line_id AND m.movement_kind = b.movement_kind
  WHERE b.business_id = NEW.business_id AND b.source_id = NEW.transfer_id AND b.source_line_id = NEW.id;
  IF v_all <> 2 OR v_out <> 1 OR v_in <> 1 THEN
    RAISE EXCEPTION 'inventory.source_movement_set_incomplete: a transfer line needs exactly its transfer_out and its transfer_in' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION stock_source_complete_inventory_adjustment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_kind TEXT;
  v_wh   UUID;
  v_all  INTEGER;
  v_ok   INTEGER;
BEGIN
  SELECT a.kind, a.warehouse_id INTO v_kind, v_wh
  FROM inventory_adjustments a WHERE a.business_id = NEW.business_id AND a.id = NEW.adjustment_id;
  SELECT count(*),
         count(*) FILTER (WHERE m.movement_kind = v_kind AND m.warehouse_id = v_wh
                            AND m.variant_id = NEW.variant_id AND m.qty_delta = NEW.qty_delta)
    INTO v_all, v_ok
  FROM stock_source_bridge_inventory_adjustment b
  JOIN stock_movements m ON m.business_id = b.business_id AND m.source_type = b.source_type AND m.source_id = b.source_id
                        AND m.source_line_id = b.source_line_id AND m.movement_kind = b.movement_kind
  WHERE b.business_id = NEW.business_id AND b.source_id = NEW.adjustment_id AND b.source_line_id = NEW.id;
  IF v_all <> 1 OR v_ok <> 1 THEN
    RAISE EXCEPTION 'inventory.source_movement_set_incomplete: an adjustment line needs exactly one movement of its document kind' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION stock_source_complete_stocktake() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_status TEXT;
  v_wh     UUID;
  v_var    NUMERIC;
  v_value  BIGINT;
  v_all    INTEGER;
  v_ok     INTEGER;
BEGIN
  SELECT s.status, s.warehouse_id INTO v_status, v_wh
  FROM stocktakes s WHERE s.business_id = NEW.business_id AND s.id = NEW.stocktake_id;
  -- Re-read the line: a deferred check judges the row as it is at COMMIT.
  SELECT l.variance_qty, l.applied_value_base_minor INTO v_var, v_value
  FROM stocktake_lines l
  WHERE l.business_id = NEW.business_id AND l.stocktake_id = NEW.stocktake_id AND l.id = NEW.id;
  SELECT count(*),
         count(*) FILTER (WHERE m.movement_kind = 'stocktake' AND m.warehouse_id = v_wh AND m.variant_id = NEW.variant_id
                            AND m.qty_delta = v_var AND m.value_delta_base_minor = v_value)
    INTO v_all, v_ok
  FROM stock_source_bridge_stocktake b
  JOIN stock_movements m ON m.business_id = b.business_id AND m.source_type = b.source_type AND m.source_id = b.source_id
                        AND m.source_line_id = b.source_line_id AND m.movement_kind = b.movement_kind
  WHERE b.business_id = NEW.business_id AND b.source_id = NEW.stocktake_id AND b.source_line_id = NEW.id;
  IF v_status = 'finalized' AND v_var <> 0 THEN
    IF v_all <> 1 OR v_ok <> 1 THEN
      RAISE EXCEPTION 'inventory.source_movement_set_incomplete: a finalized stocktake line with a variance needs exactly its one stocktake movement' USING ERRCODE = 'P0001';
    END IF;
  ELSIF v_all <> 0 THEN
    RAISE EXCEPTION 'inventory.source_movement_set_incomplete: a stocktake line without an applied variance carries no movement' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

-- The header twin: a stocktake that became finalized re-checks EVERY line,
-- so a finalize that touched no line cannot escape the line check.
CREATE OR REPLACE FUNCTION stock_source_complete_stocktake_header() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_status TEXT;
  v_bad    INTEGER;
BEGIN
  SELECT s.status INTO v_status FROM stocktakes s WHERE s.business_id = NEW.business_id AND s.id = NEW.id;
  SELECT count(*) INTO v_bad
  FROM stocktake_lines l
  WHERE l.business_id = NEW.business_id AND l.stocktake_id = NEW.id
    AND (SELECT count(*) FROM stock_source_bridge_stocktake b
           JOIN stock_movements m ON m.business_id = b.business_id AND m.source_type = b.source_type AND m.source_id = b.source_id
                                 AND m.source_line_id = b.source_line_id AND m.movement_kind = b.movement_kind
          WHERE b.business_id = l.business_id AND b.source_id = l.stocktake_id AND b.source_line_id = l.id
            AND (v_status <> 'finalized' OR l.variance_qty = 0 OR NOT (m.movement_kind = 'stocktake' AND m.variant_id = l.variant_id
                 AND m.warehouse_id = NEW.warehouse_id AND m.qty_delta = l.variance_qty
                 AND m.value_delta_base_minor = l.applied_value_base_minor)))
        + CASE WHEN v_status = 'finalized' AND l.variance_qty <> 0 THEN
            1 - (SELECT count(*) FROM stock_source_bridge_stocktake b
                  WHERE b.business_id = l.business_id AND b.source_id = l.stocktake_id AND b.source_line_id = l.id)
          ELSE 0 END <> 0;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'inventory.source_movement_set_incomplete: a finalized stocktake line does not carry exactly its required movement' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION stock_source_complete_inventory_opening() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_all INTEGER;
  v_ok  INTEGER;
BEGIN
  SELECT count(*),
         count(*) FILTER (WHERE m.movement_kind = 'inventory_opening' AND m.warehouse_id = NEW.warehouse_id
                            AND m.variant_id = NEW.variant_id AND m.qty_delta = NEW.qty)
    INTO v_all, v_ok
  FROM stock_source_bridge_inventory_opening b
  JOIN stock_movements m ON m.business_id = b.business_id AND m.source_type = b.source_type AND m.source_id = b.source_id
                        AND m.source_line_id = b.source_line_id AND m.movement_kind = b.movement_kind
  WHERE b.business_id = NEW.business_id AND b.source_id = NEW.opening_id AND b.source_line_id = NEW.id;
  IF v_all <> 1 OR v_ok <> 1 THEN
    RAISE EXCEPTION 'inventory.source_movement_set_incomplete: an opening line needs exactly its one inventory_opening movement' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

-- (e) Line freeze. Transfer, adjustment and opening lines are final at
--     insert; a stocktake line is editable only while its stocktake is a
--     draft, and its identity never.
CREATE OR REPLACE FUNCTION stock_source_freeze_inventory_transfer() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'inventory.source_line_frozen: a transfer line is final' USING ERRCODE = 'P0001';
END;
$$;

CREATE OR REPLACE FUNCTION stock_source_freeze_inventory_adjustment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'inventory.source_line_frozen: an adjustment line is final' USING ERRCODE = 'P0001';
END;
$$;

CREATE OR REPLACE FUNCTION stock_source_freeze_inventory_opening() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'inventory.source_line_frozen: an opening line is final' USING ERRCODE = 'P0001';
END;
$$;

CREATE OR REPLACE FUNCTION stock_source_freeze_stocktake() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_status TEXT;
BEGIN
  SELECT s.status INTO v_status FROM stocktakes s WHERE s.business_id = OLD.business_id AND s.id = OLD.stocktake_id;
  IF v_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'inventory.source_line_frozen: the lines of a closed stocktake are final' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE'
     AND (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.business_id IS DISTINCT FROM OLD.business_id
          OR NEW.stocktake_id IS DISTINCT FROM OLD.stocktake_id OR NEW.id IS DISTINCT FROM OLD.id
          OR NEW.variant_id IS DISTINCT FROM OLD.variant_id) THEN
    RAISE EXCEPTION 'inventory.source_line_frozen: the identity of a stocktake line is final' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- Header immutability, one function for the four headers. The only moves
-- are the stocktake's draft → finalized | cancelled; an opening's
-- posted → superseded is refused until B-1 is decided.
CREATE OR REPLACE FUNCTION inventory_source_header_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory.source_document_immutable: a % document is never deleted', TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;
  IF TG_TABLE_NAME = 'stocktakes' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'inventory.stocktake_state_invalid: a % stocktake is closed', OLD.status USING ERRCODE = 'P0001';
    END IF;
    IF NEW.status NOT IN ('finalized', 'cancelled') THEN
      RAISE EXCEPTION 'inventory.stocktake_state_invalid: a draft stocktake is only finalized or cancelled' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.business_id IS DISTINCT FROM OLD.business_id
       OR NEW.id IS DISTINCT FROM OLD.id OR NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id
       OR NEW.intent_sha256 IS DISTINCT FROM OLD.intent_sha256 OR NEW.opened_by IS DISTINCT FROM OLD.opened_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'inventory.stocktake_state_invalid: closing a stocktake changes its closing fields only' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  -- Nested: PL/pgSQL resolves every field of a condition, so `status` is
  -- read only on the one header that has it.
  IF TG_TABLE_NAME = 'inventory_openings' THEN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'inventory.opening_state_invalid: superseding a posted inventory opening is not available (B-1)' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RAISE EXCEPTION 'inventory.source_document_immutable: a % document is final', TG_TABLE_NAME USING ERRCODE = 'P0001';
END;
$$;

-- (f) Header value completeness, at COMMIT: the header total is Σ of the
--     values of the movements bound to its lines (the inventory half of
--     equation (3)); an opening's movements carry exactly their shares.
CREATE OR REPLACE FUNCTION inventory_source_value_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_total  BIGINT;
  v_sum    NUMERIC;
  v_status TEXT;
  v_w      NUMERIC[];
  v_vals   BIGINT[];
  v_shares BIGINT[];
BEGIN
  IF TG_TABLE_NAME = 'inventory_adjustments' THEN
    SELECT a.total_value_base_minor INTO v_total FROM inventory_adjustments a WHERE a.business_id = NEW.business_id AND a.id = NEW.id;
    SELECT coalesce(sum(m.value_delta_base_minor), 0) INTO v_sum
    FROM stock_source_bridge_inventory_adjustment b
    JOIN stock_movements m ON m.business_id = b.business_id AND m.source_type = b.source_type AND m.source_id = b.source_id
                          AND m.source_line_id = b.source_line_id AND m.movement_kind = b.movement_kind
    WHERE b.business_id = NEW.business_id AND b.source_id = NEW.id;
    IF v_sum IS DISTINCT FROM v_total::numeric THEN
      RAISE EXCEPTION 'inventory.source_value_mismatch: an adjustment total is not the sum of its movement values' USING ERRCODE = 'P0001';
    END IF;
  ELSIF TG_TABLE_NAME = 'stocktakes' THEN
    SELECT s.status, s.total_value_base_minor INTO v_status, v_total FROM stocktakes s WHERE s.business_id = NEW.business_id AND s.id = NEW.id;
    IF v_status = 'finalized' THEN
      SELECT coalesce(sum(m.value_delta_base_minor), 0) INTO v_sum
      FROM stock_source_bridge_stocktake b
      JOIN stock_movements m ON m.business_id = b.business_id AND m.source_type = b.source_type AND m.source_id = b.source_id
                            AND m.source_line_id = b.source_line_id AND m.movement_kind = b.movement_kind
      WHERE b.business_id = NEW.business_id AND b.source_id = NEW.id;
      IF v_sum IS DISTINCT FROM v_total::numeric THEN
        RAISE EXCEPTION 'inventory.source_value_mismatch: a stocktake total is not the sum of its movement values' USING ERRCODE = 'P0001';
      END IF;
    END IF;
  ELSE
    SELECT o.total_value_base_minor INTO v_total FROM inventory_openings o WHERE o.business_id = NEW.business_id AND o.id = NEW.id;
    SELECT array_agg(l.qty * l.unit_cost_base_minor ORDER BY l.line_no),
           array_agg((SELECT m.value_delta_base_minor
                        FROM stock_source_bridge_inventory_opening b
                        JOIN stock_movements m ON m.business_id = b.business_id AND m.source_type = b.source_type AND m.source_id = b.source_id
                                              AND m.source_line_id = b.source_line_id AND m.movement_kind = b.movement_kind
                       WHERE b.business_id = l.business_id AND b.source_id = l.opening_id AND b.source_line_id = l.id)
                     ORDER BY l.line_no)
      INTO v_w, v_vals
    FROM inventory_opening_lines l
    WHERE l.business_id = NEW.business_id AND l.opening_id = NEW.id;
    IF v_w IS NULL
       OR v_total IS DISTINCT FROM inventory_half_even((SELECT sum(x) FROM unnest(v_w) AS x), 1, 0)::bigint THEN
      RAISE EXCEPTION 'inventory.source_value_mismatch: an opening total is not HALF_EVEN of the sum of its line weights' USING ERRCODE = 'P0001';
    END IF;
    v_shares := inventory_largest_remainder(v_w, v_total);
    IF v_vals IS DISTINCT FROM v_shares THEN
      RAISE EXCEPTION 'inventory.source_value_mismatch: an opening movement does not carry its allocated share' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

-- A-19 (P3-AL-41). Archival requires zero stock, re-checked against the
-- movement ledger. Warehouses and variants serialize with every S3 routine
-- through an exclusive advisory lock on their own id (the routines hold it
-- shared); products through the row lock the primitive takes (R-2).
CREATE OR REPLACE FUNCTION warehouses_30_archive_requires_zero_stock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('daftar.stock_target'), hashtext(NEW.id::text));
  IF EXISTS (SELECT 1 FROM stock_levels l WHERE l.business_id = NEW.business_id AND l.warehouse_id = NEW.id AND l.on_hand <> 0)
     OR EXISTS (SELECT 1 FROM stock_movements m WHERE m.business_id = NEW.business_id AND m.warehouse_id = NEW.id
                GROUP BY m.variant_id HAVING sum(m.qty_delta) <> 0) THEN
    RAISE EXCEPTION 'inventory.warehouse_has_stock: a warehouse holding stock cannot be archived' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION product_variants_30_archive_requires_zero_stock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('daftar.stock_target'), hashtext(NEW.id::text));
  IF EXISTS (SELECT 1 FROM stock_levels l WHERE l.business_id = NEW.business_id AND l.variant_id = NEW.id AND l.on_hand <> 0)
     OR EXISTS (SELECT 1 FROM stock_movements m WHERE m.business_id = NEW.business_id AND m.variant_id = NEW.id
                GROUP BY m.warehouse_id HAVING sum(m.qty_delta) <> 0) THEN
    RAISE EXCEPTION 'inventory.variant_has_stock: a variant holding stock cannot be archived' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION products_30_archive_requires_zero_stock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM stock_levels l
               JOIN product_variants v ON v.business_id = l.business_id AND v.id = l.variant_id
              WHERE v.business_id = NEW.business_id AND v.product_id = NEW.id AND l.on_hand <> 0)
     OR EXISTS (SELECT 1 FROM stock_movements m
                  JOIN product_variants v ON v.business_id = m.business_id AND v.id = m.variant_id
                 WHERE v.business_id = NEW.business_id AND v.product_id = NEW.id
                 GROUP BY m.warehouse_id, m.variant_id HAVING sum(m.qty_delta) <> 0) THEN
    RAISE EXCEPTION 'inventory.product_has_stock: a product holding stock cannot be archived' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION inventory_largest_remainder(NUMERIC[], BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION stock_binding_requires_inventory_transfer() FROM PUBLIC;
REVOKE ALL ON FUNCTION stock_binding_requires_inventory_adjustment() FROM PUBLIC;
REVOKE ALL ON FUNCTION stock_binding_requires_stocktake() FROM PUBLIC;
REVOKE ALL ON FUNCTION stock_binding_requires_inventory_opening() FROM PUBLIC;
REVOKE ALL ON FUNCTION stock_source_complete_inventory_transfer() FROM PUBLIC;
REVOKE ALL ON FUNCTION stock_source_complete_inventory_adjustment() FROM PUBLIC;
REVOKE ALL ON FUNCTION stock_source_complete_stocktake() FROM PUBLIC;
REVOKE ALL ON FUNCTION stock_source_complete_stocktake_header() FROM PUBLIC;
REVOKE ALL ON FUNCTION stock_source_complete_inventory_opening() FROM PUBLIC;
REVOKE ALL ON FUNCTION stock_source_freeze_inventory_transfer() FROM PUBLIC;
REVOKE ALL ON FUNCTION stock_source_freeze_inventory_adjustment() FROM PUBLIC;
REVOKE ALL ON FUNCTION stock_source_freeze_inventory_opening() FROM PUBLIC;
REVOKE ALL ON FUNCTION stock_source_freeze_stocktake() FROM PUBLIC;
REVOKE ALL ON FUNCTION inventory_source_header_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION inventory_source_value_complete() FROM PUBLIC;
REVOKE ALL ON FUNCTION warehouses_30_archive_requires_zero_stock() FROM PUBLIC;
REVOKE ALL ON FUNCTION product_variants_30_archive_requires_zero_stock() FROM PUBLIC;
REVOKE ALL ON FUNCTION products_30_archive_requires_zero_stock() FROM PUBLIC;

-- ── The stock-side triggers (§2.3) ──────────────────────────────────────
CREATE CONSTRAINT TRIGGER stock_binding_requires_inventory_transfer
  AFTER INSERT ON stock_source_bindings DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.source_type = 'inventory_transfer')
  EXECUTE FUNCTION stock_binding_requires_inventory_transfer();
CREATE CONSTRAINT TRIGGER stock_binding_requires_inventory_adjustment
  AFTER INSERT ON stock_source_bindings DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.source_type = 'inventory_adjustment')
  EXECUTE FUNCTION stock_binding_requires_inventory_adjustment();
CREATE CONSTRAINT TRIGGER stock_binding_requires_stocktake
  AFTER INSERT ON stock_source_bindings DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.source_type = 'stocktake')
  EXECUTE FUNCTION stock_binding_requires_stocktake();
CREATE CONSTRAINT TRIGGER stock_binding_requires_inventory_opening
  AFTER INSERT ON stock_source_bindings DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.source_type = 'inventory_opening')
  EXECUTE FUNCTION stock_binding_requires_inventory_opening();

CREATE TRIGGER stock_bridge_immutable_inventory_transfer
  BEFORE UPDATE OR DELETE ON stock_source_bridge_inventory_transfer
  FOR EACH ROW EXECUTE FUNCTION stock_ledger_append_only();
CREATE TRIGGER stock_bridge_immutable_inventory_adjustment
  BEFORE UPDATE OR DELETE ON stock_source_bridge_inventory_adjustment
  FOR EACH ROW EXECUTE FUNCTION stock_ledger_append_only();
CREATE TRIGGER stock_bridge_immutable_stocktake
  BEFORE UPDATE OR DELETE ON stock_source_bridge_stocktake
  FOR EACH ROW EXECUTE FUNCTION stock_ledger_append_only();
CREATE TRIGGER stock_bridge_immutable_inventory_opening
  BEFORE UPDATE OR DELETE ON stock_source_bridge_inventory_opening
  FOR EACH ROW EXECUTE FUNCTION stock_ledger_append_only();

CREATE CONSTRAINT TRIGGER stock_source_complete_inventory_transfer
  AFTER INSERT ON inventory_transfer_lines DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION stock_source_complete_inventory_transfer();
CREATE CONSTRAINT TRIGGER stock_source_complete_inventory_adjustment
  AFTER INSERT ON inventory_adjustment_lines DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION stock_source_complete_inventory_adjustment();
CREATE CONSTRAINT TRIGGER stock_source_complete_stocktake
  AFTER INSERT OR UPDATE ON stocktake_lines DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION stock_source_complete_stocktake();
CREATE CONSTRAINT TRIGGER stock_source_complete_inventory_opening
  AFTER INSERT ON inventory_opening_lines DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION stock_source_complete_inventory_opening();
CREATE CONSTRAINT TRIGGER stocktakes_finalized_complete
  AFTER UPDATE ON stocktakes DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION stock_source_complete_stocktake_header();

CREATE TRIGGER stock_source_freeze_inventory_transfer
  BEFORE UPDATE OR DELETE ON inventory_transfer_lines
  FOR EACH ROW EXECUTE FUNCTION stock_source_freeze_inventory_transfer();
CREATE TRIGGER stock_source_freeze_inventory_adjustment
  BEFORE UPDATE OR DELETE ON inventory_adjustment_lines
  FOR EACH ROW EXECUTE FUNCTION stock_source_freeze_inventory_adjustment();
CREATE TRIGGER stock_source_freeze_stocktake
  BEFORE UPDATE OR DELETE ON stocktake_lines
  FOR EACH ROW EXECUTE FUNCTION stock_source_freeze_stocktake();
CREATE TRIGGER stock_source_freeze_inventory_opening
  BEFORE UPDATE OR DELETE ON inventory_opening_lines
  FOR EACH ROW EXECUTE FUNCTION stock_source_freeze_inventory_opening();

CREATE TRIGGER inventory_transfers_immutable
  BEFORE UPDATE OR DELETE ON inventory_transfers
  FOR EACH ROW EXECUTE FUNCTION inventory_source_header_guard();
CREATE TRIGGER inventory_adjustments_immutable
  BEFORE UPDATE OR DELETE ON inventory_adjustments
  FOR EACH ROW EXECUTE FUNCTION inventory_source_header_guard();
CREATE TRIGGER stocktakes_immutable
  BEFORE UPDATE OR DELETE ON stocktakes
  FOR EACH ROW EXECUTE FUNCTION inventory_source_header_guard();
CREATE TRIGGER inventory_openings_immutable
  BEFORE UPDATE OR DELETE ON inventory_openings
  FOR EACH ROW EXECUTE FUNCTION inventory_source_header_guard();

CREATE CONSTRAINT TRIGGER inventory_adjustments_value_complete
  AFTER INSERT OR UPDATE ON inventory_adjustments DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION inventory_source_value_complete();
CREATE CONSTRAINT TRIGGER stocktakes_value_complete
  AFTER INSERT OR UPDATE ON stocktakes DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION inventory_source_value_complete();
CREATE CONSTRAINT TRIGGER inventory_openings_value_complete
  AFTER INSERT OR UPDATE ON inventory_openings DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION inventory_source_value_complete();

-- A-19: `_30_` sorts after the existing `_10_`/`_20_` guards on each table.
CREATE TRIGGER warehouses_30_archive_requires_zero_stock
  BEFORE UPDATE OF status ON warehouses
  FOR EACH ROW
  WHEN (NEW.status = 'archived' AND OLD.status IS DISTINCT FROM 'archived')
  EXECUTE FUNCTION warehouses_30_archive_requires_zero_stock();
CREATE TRIGGER product_variants_30_archive_requires_zero_stock
  BEFORE UPDATE OF status ON product_variants
  FOR EACH ROW
  WHEN (NEW.status = 'archived' AND OLD.status IS DISTINCT FROM 'archived')
  EXECUTE FUNCTION product_variants_30_archive_requires_zero_stock();
CREATE TRIGGER products_30_archive_requires_zero_stock
  BEFORE UPDATE OF status ON products
  FOR EACH ROW
  WHEN (NEW.status = 'archived' AND OLD.status IS DISTINCT FROM 'archived')
  EXECUTE FUNCTION products_30_archive_requires_zero_stock();

-- ─────────────────────────────────────────────────────────────────────────
-- 7. Stock-source registration (A-01): after every guard above exists.
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO stock_source_types (source_type, registered_by) VALUES
  ('inventory_adjustment', 'P3-S3'),
  ('inventory_opening',    'P3-S3'),
  ('inventory_transfer',   'P3-S3'),
  ('stocktake',            'P3-S3');

-- ─────────────────────────────────────────────────────────────────────────
-- 8. The accounting side (A-14). Every function is owned by
--    daftar_accounting_internal, DEFINER, pinned, PUBLIC revoked.
-- ─────────────────────────────────────────────────────────────────────────

-- (a) Detail completeness (the AL-01 contract re-proved, L:1054-1056): an
--     entry of an inventory source cannot commit without exactly its header,
--     in exactly the A-05 shape, for exactly the header's total.
CREATE OR REPLACE FUNCTION accounting_inventory_adjustment_entry_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_n       INTEGER;
  v_date    DATE;
  v_total   BIGINT;
  v_wh      UUID;
  v_branch  UUID;
  v_lines   INTEGER;
  v_inv     INTEGER;
  v_cogs    INTEGER;
  v_inv_net NUMERIC;
  v_cogs_net NUMERIC;
  v_dims    BOOLEAN;
BEGIN
  SELECT count(*) INTO v_n FROM (
    SELECT a.id FROM inventory_adjustments a WHERE a.business_id = NEW.business_id AND a.binding_source_id = NEW.source_id
    UNION ALL
    SELECT s.id FROM stocktakes s WHERE s.business_id = NEW.business_id AND s.binding_source_id = NEW.source_id AND s.status = 'finalized'
  ) h;
  IF v_n = 0 THEN
    RAISE EXCEPTION 'accounting.inventory_detail_missing: an inventory-adjustment entry must be registered by its inventory document in the same transaction'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'accounting.inventory_entry_mismatch: an inventory-adjustment entry resolves to more than one inventory document' USING ERRCODE = 'P0001';
  END IF;
  SELECT h.occurred_on, h.total_value_base_minor, h.warehouse_id INTO v_date, v_total, v_wh FROM (
    SELECT a.occurred_on, a.total_value_base_minor, a.warehouse_id FROM inventory_adjustments a
     WHERE a.business_id = NEW.business_id AND a.binding_source_id = NEW.source_id
    UNION ALL
    SELECT s.occurred_on, s.total_value_base_minor, s.warehouse_id FROM stocktakes s
     WHERE s.business_id = NEW.business_id AND s.binding_source_id = NEW.source_id AND s.status = 'finalized'
  ) h;
  SELECT w.branch_id INTO v_branch FROM warehouses w WHERE w.business_id = NEW.business_id AND w.id = v_wh;

  SELECT count(*),
         count(*) FILTER (WHERE a.system_key = 'inventory'),
         count(*) FILTER (WHERE a.system_key = 'cogs'),
         coalesce(sum(l.debit_minor::numeric - l.credit_minor::numeric) FILTER (WHERE a.system_key = 'inventory'), 0),
         coalesce(sum(l.debit_minor::numeric - l.credit_minor::numeric) FILTER (WHERE a.system_key = 'cogs'), 0),
         coalesce(bool_and(l.warehouse_id IS NOT DISTINCT FROM v_wh AND l.branch_id IS NOT DISTINCT FROM v_branch), false)
    INTO v_lines, v_inv, v_cogs, v_inv_net, v_cogs_net, v_dims
  FROM journal_lines l
  JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
  WHERE l.business_id = NEW.business_id AND l.journal_entry_id = NEW.id;

  IF NEW.entry_date IS DISTINCT FROM v_date OR v_total IS NULL OR v_total = 0
     OR v_lines <> 2 OR v_inv <> 1 OR v_cogs <> 1
     OR v_inv_net <> v_total::numeric OR v_cogs_net <> -v_total::numeric OR NOT v_dims OR v_branch IS NULL THEN
    RAISE EXCEPTION 'accounting.inventory_entry_mismatch: an inventory-adjustment entry is not exactly the net Inventory/COGS pair of its document'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION accounting_inventory_opening_entry_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_n        INTEGER;
  v_date     DATE;
  v_total    BIGINT;
  v_lines    INTEGER;
  v_inv      INTEGER;
  v_inv_wh   INTEGER;
  v_eq       INTEGER;
  v_inv_dr   NUMERIC;
  v_eq_cr    NUMERIC;
  v_inv_ok   BOOLEAN;
  v_eq_ok    BOOLEAN;
BEGIN
  SELECT count(*) INTO v_n FROM inventory_openings o
   WHERE o.business_id = NEW.business_id AND o.binding_source_id = NEW.source_id
     AND o.case_kind = 'ledger_posting' AND o.status = 'posted';
  IF v_n = 0 THEN
    RAISE EXCEPTION 'accounting.inventory_detail_missing: an inventory-opening entry must be registered by its inventory opening in the same transaction'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT o.occurred_on, o.total_value_base_minor INTO v_date, v_total FROM inventory_openings o
   WHERE o.business_id = NEW.business_id AND o.binding_source_id = NEW.source_id
     AND o.case_kind = 'ledger_posting' AND o.status = 'posted';

  SELECT count(*),
         count(*) FILTER (WHERE a.system_key = 'inventory'),
         count(DISTINCT l.warehouse_id) FILTER (WHERE a.system_key = 'inventory'),
         count(*) FILTER (WHERE a.system_key = 'opening_equity'),
         coalesce(sum(l.debit_minor::numeric) FILTER (WHERE a.system_key = 'inventory'), 0),
         coalesce(sum(l.credit_minor::numeric) FILTER (WHERE a.system_key = 'opening_equity'), 0),
         coalesce(bool_and(l.debit_minor > 0 AND l.warehouse_id IS NOT NULL
                           AND l.branch_id IS NOT DISTINCT FROM (SELECT w.branch_id FROM warehouses w
                                                                  WHERE w.business_id = l.business_id AND w.id = l.warehouse_id))
                    FILTER (WHERE a.system_key = 'inventory'), false),
         coalesce(bool_and(l.credit_minor > 0 AND l.warehouse_id IS NULL AND l.branch_id IS NULL)
                    FILTER (WHERE a.system_key = 'opening_equity'), false)
    INTO v_lines, v_inv, v_inv_wh, v_eq, v_inv_dr, v_eq_cr, v_inv_ok, v_eq_ok
  FROM journal_lines l
  JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
  WHERE l.business_id = NEW.business_id AND l.journal_entry_id = NEW.id;

  IF NEW.entry_date IS DISTINCT FROM v_date OR v_total IS NULL OR v_total <= 0
     OR v_inv < 1 OR v_inv_wh <> v_inv OR v_eq <> 1 OR v_lines <> v_inv + 1
     OR v_inv_dr <> v_total::numeric OR v_eq_cr <> v_total::numeric OR NOT v_inv_ok OR NOT v_eq_ok THEN
    RAISE EXCEPTION 'accounting.inventory_entry_mismatch: an inventory-opening entry is not one Inventory debit per warehouse against one opening-equity credit for its total'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

-- (b) The reversal guard (TL-6): an entry a domain owns is reversed only by
--     that domain (B-1 for openings), never by the generic workflow.
CREATE OR REPLACE FUNCTION accounting_reversals_20_domain_source_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM journal_entries je
              WHERE je.business_id = NEW.business_id AND je.id = NEW.original_entry_id
                AND je.source_type IN ('inventory_adjustment', 'inventory_opening')) THEN
    RAISE EXCEPTION 'accounting.reversal_source_domain_owned: an entry owned by the inventory domain is not reversed by the generic reversal workflow'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- (c) The opening-balance guard (TL-6), serialized with the inventory
--     opening by the opening-balance workflow's own per-business lock (R-1).
CREATE OR REPLACE FUNCTION accounting_opening_balances_30_inventory_opening_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_inv_code TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(accounting_opening_balance_lock_key(NEW.business_id));
  IF OLD.status = 'draft' AND NEW.status = 'posted' THEN
    SELECT a.code INTO v_inv_code FROM accounts a WHERE a.business_id = NEW.business_id AND a.system_key = 'inventory';
    IF EXISTS (SELECT 1 FROM accounting_opening_balance_lines ol
                WHERE ol.business_id = NEW.business_id AND ol.opening_balance_id = NEW.id
                  AND ((ol.account_ref_kind = 'system' AND ol.account_system_key = 'inventory')
                    OR (ol.account_ref_kind = 'code' AND ol.account_code = v_inv_code)))
       AND EXISTS (SELECT 1 FROM inventory_openings o
                    WHERE o.business_id = NEW.business_id AND o.status = 'posted' AND o.case_kind = 'ledger_posting') THEN
      RAISE EXCEPTION 'accounting.opening_balance_inventory_conflict: the inventory opening already posted Inventory, so an opening position cannot state it again'
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF OLD.status = 'posted' AND NEW.status = 'superseded' THEN
    IF EXISTS (SELECT 1 FROM inventory_openings o
                WHERE o.business_id = NEW.business_id AND o.status = 'posted'
                  AND o.case_kind = 'opening_balance_bound' AND o.opening_balance_id = OLD.id) THEN
      RAISE EXCEPTION 'accounting.opening_balance_inventory_bound: the inventory opening is decomposed against this opening position, which therefore cannot be superseded'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- (d) The opening-position read. Reachable only from signed inventory
--     routines (the one grant is to the NOLOGIN internal inventory
--     principal); the business must be the transaction's. Takes the
--     opening-balance workflow lock (R-1), so the answer stays true until
--     the calling transaction ends.
CREATE OR REPLACE FUNCTION accounting_inventory_opening_position(p_business_id UUID)
RETURNS TABLE (opening_balance_id UUID, inventory_net_minor BIGINT)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_ob       UUID;
  v_inv_code TEXT;
  v_n        INTEGER;
  v_net      NUMERIC;
BEGIN
  IF p_business_id IS NULL
     OR p_business_id IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid THEN
    RAISE EXCEPTION 'accounting.scope_mismatch: the opening position is read only for the transaction''s business' USING ERRCODE = 'P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(accounting_opening_balance_lock_key(p_business_id));
  SELECT ob.id INTO v_ob FROM accounting_opening_balances ob WHERE ob.business_id = p_business_id AND ob.status = 'posted';
  IF v_ob IS NULL THEN
    RETURN;
  END IF;
  SELECT a.code INTO v_inv_code FROM accounts a WHERE a.business_id = p_business_id AND a.system_key = 'inventory';
  SELECT count(*), coalesce(sum(CASE WHEN ol.side = 'D' THEN ol.base_amount_minor::numeric ELSE -ol.base_amount_minor::numeric END), 0)
    INTO v_n, v_net
  FROM accounting_opening_balance_lines ol
  WHERE ol.business_id = p_business_id AND ol.opening_balance_id = v_ob
    AND ((ol.account_ref_kind = 'system' AND ol.account_system_key = 'inventory')
      OR (ol.account_ref_kind = 'code' AND ol.account_code = v_inv_code));
  IF v_n = 0 THEN
    RETURN;
  END IF;
  opening_balance_id  := v_ob;
  inventory_net_minor := v_net::bigint;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION accounting_inventory_opening_position(UUID) IS
  'P3-S3 A-14(d). The posted opening balance of the transaction''s business and its net Σ debit − Σ credit on lines resolving to the business Inventory system account (by system key or by that account''s code); zero rows when there is no posted opening balance or no such line. Takes the opening-balance workflow lock. accounting.scope_mismatch for another business. EXECUTE: daftar_inventory_internal only (reachability for signed routines, not runtime reach).';

REVOKE ALL ON FUNCTION accounting_inventory_adjustment_entry_complete() FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_inventory_opening_entry_complete() FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_reversals_20_domain_source_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_opening_balances_30_inventory_opening_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_inventory_opening_position(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION accounting_inventory_opening_position(UUID) TO daftar_inventory_internal;

CREATE CONSTRAINT TRIGGER journal_entries_inventory_adjustment_complete
  AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.source_type = 'inventory_adjustment')
  EXECUTE FUNCTION accounting_inventory_adjustment_entry_complete();
CREATE CONSTRAINT TRIGGER journal_entries_inventory_opening_complete
  AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.source_type = 'inventory_opening')
  EXECUTE FUNCTION accounting_inventory_opening_entry_complete();
CREATE TRIGGER accounting_reversals_20_domain_source_guard
  BEFORE INSERT ON accounting_reversals
  FOR EACH ROW EXECUTE FUNCTION accounting_reversals_20_domain_source_guard();
CREATE TRIGGER accounting_opening_balances_30_inventory_opening_guard
  BEFORE UPDATE OF status ON accounting_opening_balances
  FOR EACH ROW EXECUTE FUNCTION accounting_opening_balances_30_inventory_opening_guard();

-- (e) The registries (L:1040-1041), with the owning operation kind the 0046
--     rule requires.
INSERT INTO accounting_source_types (source_type, lower_bound_policy, upper_bound_policy, description, sort_order) VALUES
  ('inventory_adjustment', 'none', 'not_after_today', 'Inventory loss, gain, damage or stocktake variance valued against COGS (P3-AL-17).', 4),
  ('inventory_opening',    'none', 'not_after_today', 'Opening stock posted against opening equity when no opening position holds Inventory (P3-AL-18).', 5);
INSERT INTO accounting_operation_kinds (operation_kind, source_type, description) VALUES
  ('post', 'inventory_adjustment', 'Inventory adjustment, damage or stocktake variance; derived by the inventory command.'),
  ('post', 'inventory_opening',    'Opening stock, Case A; derived by the inventory command.');

-- ─────────────────────────────────────────────────────────────────────────
-- 9. Row security, grants and the ownership transfer (§2.6, A-18).
--
-- The stock_movements layering: a tenant policy through the businesses
-- subquery, a restrictive business isolation that ADMITS the internal
-- principals for reading only (USING, never WITH CHECK), and permissive
-- FOR SELECT admissions for the principals whose triggers judge these rows
-- whatever scope the writing session carries.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE inventory_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_transfers FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory_transfer_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_transfer_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_adjustments FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory_adjustment_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_adjustment_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE stocktakes ENABLE ROW LEVEL SECURITY;
ALTER TABLE stocktakes FORCE ROW LEVEL SECURITY;
ALTER TABLE stocktake_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE stocktake_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory_openings ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_openings FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory_opening_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_opening_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE stock_source_bridge_inventory_transfer ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_source_bridge_inventory_transfer FORCE ROW LEVEL SECURITY;
ALTER TABLE stock_source_bridge_inventory_adjustment ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_source_bridge_inventory_adjustment FORCE ROW LEVEL SECURITY;
ALTER TABLE stock_source_bridge_stocktake ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_source_bridge_stocktake FORCE ROW LEVEL SECURITY;
ALTER TABLE stock_source_bridge_inventory_opening ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_source_bridge_inventory_opening FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_membership ON inventory_transfers
  USING      (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = inventory_transfers.business_id) = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = inventory_transfers.business_id) = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation ON inventory_transfers AS RESTRICTIVE
  USING      (app_bypass() OR current_user = 'daftar_inventory_internal' OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON inventory_transfers
  FOR SELECT TO daftar_inventory_internal USING (true);

CREATE POLICY tenant_membership ON inventory_transfer_lines
  USING      (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = inventory_transfer_lines.business_id) = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = inventory_transfer_lines.business_id) = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation ON inventory_transfer_lines AS RESTRICTIVE
  USING      (app_bypass() OR current_user = 'daftar_inventory_internal' OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON inventory_transfer_lines
  FOR SELECT TO daftar_inventory_internal USING (true);

CREATE POLICY tenant_membership ON inventory_adjustments
  USING      (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = inventory_adjustments.business_id) = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = inventory_adjustments.business_id) = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation ON inventory_adjustments AS RESTRICTIVE
  USING      (app_bypass() OR current_user IN ('daftar_inventory_internal', 'daftar_accounting_internal') OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON inventory_adjustments
  FOR SELECT TO daftar_inventory_internal USING (true);
CREATE POLICY accounting_validator ON inventory_adjustments
  FOR SELECT TO daftar_accounting_internal USING (true);

CREATE POLICY tenant_membership ON inventory_adjustment_lines
  USING      (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = inventory_adjustment_lines.business_id) = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = inventory_adjustment_lines.business_id) = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation ON inventory_adjustment_lines AS RESTRICTIVE
  USING      (app_bypass() OR current_user = 'daftar_inventory_internal' OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON inventory_adjustment_lines
  FOR SELECT TO daftar_inventory_internal USING (true);

CREATE POLICY tenant_membership ON stocktakes
  USING      (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = stocktakes.business_id) = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = stocktakes.business_id) = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation ON stocktakes AS RESTRICTIVE
  USING      (app_bypass() OR current_user IN ('daftar_inventory_internal', 'daftar_accounting_internal') OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON stocktakes
  FOR SELECT TO daftar_inventory_internal USING (true);
CREATE POLICY accounting_validator ON stocktakes
  FOR SELECT TO daftar_accounting_internal USING (true);

CREATE POLICY tenant_membership ON stocktake_lines
  USING      (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = stocktake_lines.business_id) = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = stocktake_lines.business_id) = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation ON stocktake_lines AS RESTRICTIVE
  USING      (app_bypass() OR current_user = 'daftar_inventory_internal' OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON stocktake_lines
  FOR SELECT TO daftar_inventory_internal USING (true);

CREATE POLICY tenant_membership ON inventory_openings
  USING      (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = inventory_openings.business_id) = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = inventory_openings.business_id) = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation ON inventory_openings AS RESTRICTIVE
  USING      (app_bypass() OR current_user IN ('daftar_inventory_internal', 'daftar_accounting_internal') OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON inventory_openings
  FOR SELECT TO daftar_inventory_internal USING (true);
CREATE POLICY accounting_validator ON inventory_openings
  FOR SELECT TO daftar_accounting_internal USING (true);

CREATE POLICY tenant_membership ON inventory_opening_lines
  USING      (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = inventory_opening_lines.business_id) = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = inventory_opening_lines.business_id) = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation ON inventory_opening_lines AS RESTRICTIVE
  USING      (app_bypass() OR current_user = 'daftar_inventory_internal' OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON inventory_opening_lines
  FOR SELECT TO daftar_inventory_internal USING (true);

CREATE POLICY tenant_membership ON stock_source_bridge_inventory_transfer
  USING      (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = stock_source_bridge_inventory_transfer.business_id) = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = stock_source_bridge_inventory_transfer.business_id) = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation ON stock_source_bridge_inventory_transfer AS RESTRICTIVE
  USING      (app_bypass() OR current_user = 'daftar_inventory_internal' OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON stock_source_bridge_inventory_transfer
  FOR SELECT TO daftar_inventory_internal USING (true);

CREATE POLICY tenant_membership ON stock_source_bridge_inventory_adjustment
  USING      (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = stock_source_bridge_inventory_adjustment.business_id) = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = stock_source_bridge_inventory_adjustment.business_id) = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation ON stock_source_bridge_inventory_adjustment AS RESTRICTIVE
  USING      (app_bypass() OR current_user = 'daftar_inventory_internal' OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON stock_source_bridge_inventory_adjustment
  FOR SELECT TO daftar_inventory_internal USING (true);

CREATE POLICY tenant_membership ON stock_source_bridge_stocktake
  USING      (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = stock_source_bridge_stocktake.business_id) = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = stock_source_bridge_stocktake.business_id) = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation ON stock_source_bridge_stocktake AS RESTRICTIVE
  USING      (app_bypass() OR current_user = 'daftar_inventory_internal' OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON stock_source_bridge_stocktake
  FOR SELECT TO daftar_inventory_internal USING (true);

CREATE POLICY tenant_membership ON stock_source_bridge_inventory_opening
  USING      (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = stock_source_bridge_inventory_opening.business_id) = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = stock_source_bridge_inventory_opening.business_id) = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation ON stock_source_bridge_inventory_opening AS RESTRICTIVE
  USING      (app_bypass() OR current_user = 'daftar_inventory_internal' OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON stock_source_bridge_inventory_opening
  FOR SELECT TO daftar_inventory_internal USING (true);

-- A-18. daftar_app reads the eight documents (the A-10 proof and replay)
-- and nothing else; no runtime role holds any DML here.
GRANT SELECT ON inventory_transfers, inventory_transfer_lines, inventory_adjustments, inventory_adjustment_lines,
                stocktakes, stocktake_lines, inventory_openings, inventory_opening_lines TO daftar_app;

GRANT SELECT, INSERT ON inventory_transfers, inventory_transfer_lines, inventory_adjustments, inventory_adjustment_lines,
                        stocktakes, stocktake_lines, inventory_openings, inventory_opening_lines,
                        stock_source_bridge_inventory_transfer, stock_source_bridge_inventory_adjustment,
                        stock_source_bridge_stocktake, stock_source_bridge_inventory_opening
  TO daftar_inventory_internal;
GRANT UPDATE (status, occurred_on, total_value_base_minor, binding_source_id, finalize_intent_sha256, finalized_at, cancelled_at, closed_by)
  ON stocktakes TO daftar_inventory_internal;
GRANT UPDATE (counted_qty, expected_qty_at_capture, captured_at_stock_seq, captured_at, unit_cost_base_minor, applied_value_base_minor)
  ON stocktake_lines TO daftar_inventory_internal;
GRANT SELECT ON stock_source_bindings TO daftar_inventory_internal;
GRANT INSERT ON outbox_events TO daftar_inventory_internal;

GRANT SELECT ON inventory_adjustments, stocktakes, inventory_openings, warehouses TO daftar_accounting_internal;

-- The ownership transfer (after the ACL and the triggers).
ALTER FUNCTION inventory_largest_remainder(NUMERIC[], BIGINT) OWNER TO daftar_inventory_internal;
ALTER FUNCTION stock_binding_requires_inventory_transfer() OWNER TO daftar_inventory_internal;
ALTER FUNCTION stock_binding_requires_inventory_adjustment() OWNER TO daftar_inventory_internal;
ALTER FUNCTION stock_binding_requires_stocktake() OWNER TO daftar_inventory_internal;
ALTER FUNCTION stock_binding_requires_inventory_opening() OWNER TO daftar_inventory_internal;
ALTER FUNCTION stock_source_complete_inventory_transfer() OWNER TO daftar_inventory_internal;
ALTER FUNCTION stock_source_complete_inventory_adjustment() OWNER TO daftar_inventory_internal;
ALTER FUNCTION stock_source_complete_stocktake() OWNER TO daftar_inventory_internal;
ALTER FUNCTION stock_source_complete_stocktake_header() OWNER TO daftar_inventory_internal;
ALTER FUNCTION stock_source_complete_inventory_opening() OWNER TO daftar_inventory_internal;
ALTER FUNCTION stock_source_freeze_inventory_transfer() OWNER TO daftar_inventory_internal;
ALTER FUNCTION stock_source_freeze_inventory_adjustment() OWNER TO daftar_inventory_internal;
ALTER FUNCTION stock_source_freeze_inventory_opening() OWNER TO daftar_inventory_internal;
ALTER FUNCTION stock_source_freeze_stocktake() OWNER TO daftar_inventory_internal;
ALTER FUNCTION inventory_source_header_guard() OWNER TO daftar_inventory_internal;
ALTER FUNCTION inventory_source_value_complete() OWNER TO daftar_inventory_internal;
ALTER FUNCTION warehouses_30_archive_requires_zero_stock() OWNER TO daftar_inventory_internal;
ALTER FUNCTION product_variants_30_archive_requires_zero_stock() OWNER TO daftar_inventory_internal;
ALTER FUNCTION products_30_archive_requires_zero_stock() OWNER TO daftar_inventory_internal;

ALTER FUNCTION accounting_inventory_adjustment_entry_complete() OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_inventory_opening_entry_complete() OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_reversals_20_domain_source_guard() OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_opening_balances_30_inventory_opening_guard() OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_inventory_opening_position(UUID) OWNER TO daftar_accounting_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 10. Hand back the ownership-transfer authority.
-- ─────────────────────────────────────────────────────────────────────────
REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;
REVOKE CREATE ON SCHEMA public FROM daftar_accounting_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 11. Refuse to commit unless the end state is exactly right (0061-E,
--     §2.9). `has_*_privilege` against the live catalogue.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_role     TEXT;
  v_table    TEXT;
  v_priv     TEXT;
  v_detail   TEXT;
  v_n        INTEGER;
  v_actual   TEXT[];
  v_expected TEXT[];
  v_def      TEXT;
  v_fn       REGPROCEDURE;
  c_docs     CONSTANT TEXT[] := ARRAY['inventory_adjustment_lines', 'inventory_adjustments', 'inventory_opening_lines', 'inventory_openings',
                                      'inventory_transfer_lines', 'inventory_transfers', 'stocktake_lines', 'stocktakes'];
  c_bridges  CONSTANT TEXT[] := ARRAY['stock_source_bridge_inventory_adjustment', 'stock_source_bridge_inventory_opening',
                                      'stock_source_bridge_inventory_transfer', 'stock_source_bridge_stocktake'];
  c_runtime  CONSTANT TEXT[] := ARRAY['daftar_app', 'daftar_platform', 'daftar_worker', 'daftar_identity', 'daftar_resolver',
                                      'daftar_provisioner', 'daftar_reconciler', 'public'];
  c_privs    CONSTANT TEXT[] := ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
  c_inv_fns  CONSTANT REGPROCEDURE[] := ARRAY[
    'inventory_largest_remainder(numeric[],bigint)'::regprocedure,
    'stock_binding_requires_inventory_transfer()'::regprocedure,
    'stock_binding_requires_inventory_adjustment()'::regprocedure,
    'stock_binding_requires_stocktake()'::regprocedure,
    'stock_binding_requires_inventory_opening()'::regprocedure,
    'stock_source_complete_inventory_transfer()'::regprocedure,
    'stock_source_complete_inventory_adjustment()'::regprocedure,
    'stock_source_complete_stocktake()'::regprocedure,
    'stock_source_complete_stocktake_header()'::regprocedure,
    'stock_source_complete_inventory_opening()'::regprocedure,
    'stock_source_freeze_inventory_transfer()'::regprocedure,
    'stock_source_freeze_inventory_adjustment()'::regprocedure,
    'stock_source_freeze_inventory_opening()'::regprocedure,
    'stock_source_freeze_stocktake()'::regprocedure,
    'inventory_source_header_guard()'::regprocedure,
    'inventory_source_value_complete()'::regprocedure,
    'warehouses_30_archive_requires_zero_stock()'::regprocedure,
    'product_variants_30_archive_requires_zero_stock()'::regprocedure,
    'products_30_archive_requires_zero_stock()'::regprocedure];
  c_acc_fns  CONSTANT REGPROCEDURE[] := ARRAY[
    'accounting_inventory_adjustment_entry_complete()'::regprocedure,
    'accounting_inventory_opening_entry_complete()'::regprocedure,
    'accounting_reversals_20_domain_source_guard()'::regprocedure,
    'accounting_opening_balances_30_inventory_opening_guard()'::regprocedure,
    'accounting_inventory_opening_position(uuid)'::regprocedure];
BEGIN
  -- (1) The four S3 stock source types, and nothing else.
  SELECT array_agg(t.source_type || ':' || t.registered_by ORDER BY t.source_type) INTO v_actual FROM stock_source_types t;
  IF v_actual IS DISTINCT FROM ARRAY['inventory_adjustment:P3-S3', 'inventory_opening:P3-S3', 'inventory_transfer:P3-S3', 'stocktake:P3-S3'] THEN
    RAISE EXCEPTION 'inventory.migration_end_state_invalid: stock_source_types is not exactly the four P3-S3 types, found %', v_actual;
  END IF;

  -- (2) Every registered source type is fully guarded, and the discovery is
  --     live: disabling one guard inside a rolled-back block is reported.
  IF EXISTS (SELECT 1 FROM inventory_stock_source_guard_gaps()) THEN
    SELECT string_agg(g.source_type || ':' || g.missing, ', ') INTO v_detail FROM inventory_stock_source_guard_gaps() g;
    RAISE EXCEPTION 'inventory.source_guard_missing: a registered stock source type lacks a guard: %', v_detail;
  END IF;
  BEGIN
    ALTER TABLE stock_source_bridge_inventory_transfer DISABLE TRIGGER stock_bridge_immutable_inventory_transfer;
    SELECT string_agg(g.source_type || ':' || g.missing, ', ') INTO v_detail FROM inventory_stock_source_guard_gaps() g;
    RAISE EXCEPTION 'inventory.probe_rollback: %', coalesce(v_detail, '');
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_detail = MESSAGE_TEXT;
  END;
  IF v_detail IS DISTINCT FROM 'inventory.probe_rollback: inventory_transfer:bridge_immutable' THEN
    RAISE EXCEPTION 'inventory.source_guard_missing: the strengthened discovery did not report a disabled bridge guard (%)', v_detail;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgname = 'stock_bridge_immutable_inventory_transfer' AND g.tgenabled = 'O') THEN
    RAISE EXCEPTION 'inventory.migration_end_state_invalid: the discovery probe did not roll back';
  END IF;

  -- (3) The accounting source registry: the three native rows unchanged,
  --     plus exactly the two S3 rows.
  SELECT array_agg(s.source_type || ':' || s.lower_bound_policy || ':' || s.upper_bound_policy || ':' || s.sort_order ORDER BY s.sort_order)
    INTO v_actual FROM accounting_source_types s WHERE s.sort_order > 3 OR s.source_type IN ('inventory_adjustment', 'inventory_opening');
  IF v_actual IS DISTINCT FROM ARRAY['inventory_adjustment:none:not_after_today:4', 'inventory_opening:none:not_after_today:5'] THEN
    RAISE EXCEPTION 'inventory.migration_end_state_invalid: accounting_source_types beyond the natives is not exactly the two P3-S3 rows, found %', v_actual;
  END IF;
  SELECT array_agg(s.source_type ORDER BY s.sort_order) INTO v_actual FROM accounting_source_types s WHERE s.sort_order <= 3;
  IF v_actual IS DISTINCT FROM ARRAY['opening_balance', 'manual_adjustment', 'reversal'] THEN
    RAISE EXCEPTION 'inventory.migration_end_state_invalid: the native accounting source types changed, found %', v_actual;
  END IF;

  -- (4) The operation kinds: three native pairs plus the two S3 pairs, and
  --     every source type owned (the 0046 rule).
  SELECT array_agg(k.operation_kind || ':' || k.source_type ORDER BY k.source_type) INTO v_actual FROM accounting_operation_kinds k;
  IF v_actual IS DISTINCT FROM ARRAY['post:inventory_adjustment', 'post:inventory_opening', 'post:manual_adjustment',
                                     'post:opening_balance', 'reverse:reversal'] THEN
    RAISE EXCEPTION 'inventory.migration_end_state_invalid: accounting_operation_kinds is not the native three plus the two P3-S3 pairs, found %', v_actual;
  END IF;
  IF EXISTS (SELECT 1 FROM accounting_source_types st
              WHERE NOT EXISTS (SELECT 1 FROM accounting_operation_kinds k WHERE k.source_type = st.source_type)) THEN
    RAISE EXCEPTION 'inventory.migration_end_state_invalid: a registered accounting source type has no owning operation kind';
  END IF;

  -- (5) Every §2.3 trigger, by table, name, tgtype, function, enabled, and
  --     its function's owner, security and path.
  WITH expected (tbl, tg, typ, fn, owner, definer, deferred) AS (VALUES
    ('stock_source_bindings', 'stock_binding_requires_inventory_transfer', 5, 'stock_binding_requires_inventory_transfer()', 'daftar_inventory_internal', true, true),
    ('stock_source_bindings', 'stock_binding_requires_inventory_adjustment', 5, 'stock_binding_requires_inventory_adjustment()', 'daftar_inventory_internal', true, true),
    ('stock_source_bindings', 'stock_binding_requires_stocktake', 5, 'stock_binding_requires_stocktake()', 'daftar_inventory_internal', true, true),
    ('stock_source_bindings', 'stock_binding_requires_inventory_opening', 5, 'stock_binding_requires_inventory_opening()', 'daftar_inventory_internal', true, true),
    ('stock_source_bridge_inventory_transfer', 'stock_bridge_immutable_inventory_transfer', 27, 'stock_ledger_append_only()', NULL, false, false),
    ('stock_source_bridge_inventory_adjustment', 'stock_bridge_immutable_inventory_adjustment', 27, 'stock_ledger_append_only()', NULL, false, false),
    ('stock_source_bridge_stocktake', 'stock_bridge_immutable_stocktake', 27, 'stock_ledger_append_only()', NULL, false, false),
    ('stock_source_bridge_inventory_opening', 'stock_bridge_immutable_inventory_opening', 27, 'stock_ledger_append_only()', NULL, false, false),
    ('inventory_transfer_lines', 'stock_source_complete_inventory_transfer', 5, 'stock_source_complete_inventory_transfer()', 'daftar_inventory_internal', true, true),
    ('inventory_adjustment_lines', 'stock_source_complete_inventory_adjustment', 5, 'stock_source_complete_inventory_adjustment()', 'daftar_inventory_internal', true, true),
    ('stocktake_lines', 'stock_source_complete_stocktake', 21, 'stock_source_complete_stocktake()', 'daftar_inventory_internal', true, true),
    ('inventory_opening_lines', 'stock_source_complete_inventory_opening', 5, 'stock_source_complete_inventory_opening()', 'daftar_inventory_internal', true, true),
    ('stocktakes', 'stocktakes_finalized_complete', 17, 'stock_source_complete_stocktake_header()', 'daftar_inventory_internal', true, true),
    ('inventory_transfer_lines', 'stock_source_freeze_inventory_transfer', 27, 'stock_source_freeze_inventory_transfer()', 'daftar_inventory_internal', true, false),
    ('inventory_adjustment_lines', 'stock_source_freeze_inventory_adjustment', 27, 'stock_source_freeze_inventory_adjustment()', 'daftar_inventory_internal', true, false),
    ('stocktake_lines', 'stock_source_freeze_stocktake', 27, 'stock_source_freeze_stocktake()', 'daftar_inventory_internal', true, false),
    ('inventory_opening_lines', 'stock_source_freeze_inventory_opening', 27, 'stock_source_freeze_inventory_opening()', 'daftar_inventory_internal', true, false),
    ('inventory_transfers', 'inventory_transfers_immutable', 27, 'inventory_source_header_guard()', 'daftar_inventory_internal', true, false),
    ('inventory_adjustments', 'inventory_adjustments_immutable', 27, 'inventory_source_header_guard()', 'daftar_inventory_internal', true, false),
    ('stocktakes', 'stocktakes_immutable', 27, 'inventory_source_header_guard()', 'daftar_inventory_internal', true, false),
    ('inventory_openings', 'inventory_openings_immutable', 27, 'inventory_source_header_guard()', 'daftar_inventory_internal', true, false),
    ('inventory_adjustments', 'inventory_adjustments_value_complete', 21, 'inventory_source_value_complete()', 'daftar_inventory_internal', true, true),
    ('stocktakes', 'stocktakes_value_complete', 21, 'inventory_source_value_complete()', 'daftar_inventory_internal', true, true),
    ('inventory_openings', 'inventory_openings_value_complete', 21, 'inventory_source_value_complete()', 'daftar_inventory_internal', true, true),
    ('warehouses', 'warehouses_30_archive_requires_zero_stock', 19, 'warehouses_30_archive_requires_zero_stock()', 'daftar_inventory_internal', true, false),
    ('product_variants', 'product_variants_30_archive_requires_zero_stock', 19, 'product_variants_30_archive_requires_zero_stock()', 'daftar_inventory_internal', true, false),
    ('products', 'products_30_archive_requires_zero_stock', 19, 'products_30_archive_requires_zero_stock()', 'daftar_inventory_internal', true, false),
    ('journal_entries', 'journal_entries_inventory_adjustment_complete', 5, 'accounting_inventory_adjustment_entry_complete()', 'daftar_accounting_internal', true, true),
    ('journal_entries', 'journal_entries_inventory_opening_complete', 5, 'accounting_inventory_opening_entry_complete()', 'daftar_accounting_internal', true, true),
    ('accounting_reversals', 'accounting_reversals_20_domain_source_guard', 7, 'accounting_reversals_20_domain_source_guard()', 'daftar_accounting_internal', true, false),
    ('accounting_opening_balances', 'accounting_opening_balances_30_inventory_opening_guard', 19, 'accounting_opening_balances_30_inventory_opening_guard()', 'daftar_accounting_internal', true, false)
  )
  SELECT string_agg(e.tg, ', ' ORDER BY e.tg) INTO v_detail
  FROM expected e
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_trigger g
      JOIN pg_proc p ON p.oid = g.tgfoid
      JOIN pg_roles r ON r.oid = p.proowner
     WHERE g.tgrelid = ('public.' || e.tbl)::regclass AND g.tgname = e.tg AND NOT g.tgisinternal
       AND g.tgtype = e.typ AND g.tgenabled = 'O'
       AND g.tgfoid = ('public.' || e.fn)::regprocedure
       AND (g.tgconstraint <> 0 AND g.tgdeferrable AND g.tginitdeferred) = e.deferred
       AND (e.owner IS NULL OR r.rolname = e.owner)
       AND p.prosecdef = e.definer
       AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']);
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'inventory.migration_end_state_invalid: trigger(s) missing or mis-shaped: %', v_detail;
  END IF;
  -- The WHEN filters that keep Budget A and the other source types untouched.
  IF (SELECT count(*) FROM pg_trigger g
       WHERE g.tgname IN ('journal_entries_inventory_adjustment_complete', 'journal_entries_inventory_opening_complete',
                          'stock_binding_requires_inventory_transfer', 'stock_binding_requires_inventory_adjustment',
                          'stock_binding_requires_stocktake', 'stock_binding_requires_inventory_opening',
                          'warehouses_30_archive_requires_zero_stock', 'product_variants_30_archive_requires_zero_stock',
                          'products_30_archive_requires_zero_stock')
         AND g.tgqual IS NOT NULL) <> 9 THEN
    RAISE EXCEPTION 'inventory.migration_end_state_invalid: a conditional S3 trigger lost its WHEN clause';
  END IF;

  -- (6) Every new function: owner, DEFINER, pinned path, and no EXECUTE for
  --     PUBLIC or any runtime role; the position read for the inventory
  --     principal only.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO v_detail
  FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
  WHERE (p.oid = ANY (c_inv_fns) AND r.rolname <> 'daftar_inventory_internal')
     OR (p.oid = ANY (c_acc_fns) AND r.rolname <> 'daftar_accounting_internal')
     OR ((p.oid = ANY (c_inv_fns) OR p.oid = ANY (c_acc_fns))
         AND (NOT p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']));
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'inventory.migration_end_state_invalid: function(s) with the wrong owner, security or path: %', v_detail;
  END IF;
  IF (SELECT count(*) FROM pg_proc p WHERE p.oid = ANY (c_inv_fns) OR p.oid = ANY (c_acc_fns)) <> 24 THEN
    RAISE EXCEPTION 'inventory.migration_end_state_invalid: a P3-S3 source-side function is missing';
  END IF;
  FOREACH v_fn IN ARRAY c_inv_fns || c_acc_fns || ARRAY['inventory_stock_source_guard_gaps()'::regprocedure] LOOP
    FOREACH v_role IN ARRAY c_runtime LOOP
      IF has_function_privilege(v_role, v_fn, 'EXECUTE') THEN
        RAISE EXCEPTION 'inventory.migration_end_state_invalid: % may execute %', v_role, v_fn;
      END IF;
    END LOOP;
    IF v_fn <> 'accounting_inventory_opening_position(uuid)'::regprocedure
       AND (SELECT count(*) FROM pg_proc p, aclexplode(p.proacl) x
             WHERE p.oid = v_fn AND x.privilege_type = 'EXECUTE' AND x.grantee <> p.proowner) > 0 THEN
      RAISE EXCEPTION 'inventory.migration_end_state_invalid: % has an EXECUTE grantee', v_fn;
    END IF;
  END LOOP;
  SELECT array_agg(x.grantee::regrole::text ORDER BY x.grantee::regrole::text) INTO v_actual
  FROM pg_proc p, aclexplode(p.proacl) x
  WHERE p.oid = 'accounting_inventory_opening_position(uuid)'::regprocedure AND x.privilege_type = 'EXECUTE' AND x.grantee <> p.proowner;
  IF v_actual IS DISTINCT FROM ARRAY['daftar_inventory_internal'] THEN
    RAISE EXCEPTION 'inventory.migration_end_state_invalid: accounting_inventory_opening_position must be executable by daftar_inventory_internal only, found %', v_actual;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'inventory_stock_source_guard_gaps()'::regprocedure
               AND (p.prosecdef OR p.provolatile <> 's' OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
                    OR pg_get_function_result(p.oid) <> 'TABLE(source_type text, missing text)')) THEN
    RAISE EXCEPTION 'inventory.migration_end_state_invalid: inventory_stock_source_guard_gaps changed its contract';
  END IF;

  -- (7) The A-18 grant matrix, exactly.
  FOREACH v_table IN ARRAY c_docs || c_bridges LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = ('public.' || v_table)::regclass
                     AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity) THEN
      RAISE EXCEPTION 'inventory.migration_end_state_invalid: row security is not enabled and forced on %', v_table;
    END IF;
    FOREACH v_role IN ARRAY c_runtime LOOP
      FOREACH v_priv IN ARRAY c_privs LOOP
        IF has_table_privilege(v_role, v_table, v_priv)
           AND NOT (v_role = 'daftar_app' AND v_priv = 'SELECT' AND v_table = ANY (c_docs)) THEN
          RAISE EXCEPTION 'inventory.migration_end_state_invalid: % holds % on %', v_role, v_priv, v_table;
        END IF;
      END LOOP;
      FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
        IF has_any_column_privilege(v_role, v_table, v_priv)
           AND NOT (v_role = 'daftar_app' AND v_priv = 'SELECT' AND v_table = ANY (c_docs)) THEN
          RAISE EXCEPTION 'inventory.migration_end_state_invalid: % holds column-level % on %', v_role, v_priv, v_table;
        END IF;
      END LOOP;
    END LOOP;
    IF v_table = ANY (c_docs) AND NOT has_table_privilege('daftar_app', v_table, 'SELECT') THEN
      RAISE EXCEPTION 'inventory.migration_end_state_invalid: daftar_app cannot read %', v_table;
    END IF;
  END LOOP;

  v_expected := ARRAY[]::text[];
  FOREACH v_table IN ARRAY c_docs || c_bridges LOOP
    v_expected := v_expected || (v_table || ':INSERT') || (v_table || ':SELECT');
  END LOOP;
  SELECT array_agg(x ORDER BY x) INTO v_expected FROM unnest(v_expected) AS x;
  SELECT array_agg(t || ':' || p ORDER BY t || ':' || p) INTO v_actual
  FROM unnest(c_docs || c_bridges) AS t CROSS JOIN unnest(c_privs) AS p
  WHERE has_table_privilege('daftar_inventory_internal', t, p);
  IF v_actual IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'inventory.migration_end_state_invalid: daftar_inventory_internal table privileges on the S3 tables are not exactly SELECT, INSERT, found %', v_actual;
  END IF;
  SELECT array_agg(c.relname || '.' || a.attname ORDER BY c.relname, a.attname) INTO v_actual
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
  WHERE c.relname = ANY (c_docs || c_bridges) AND a.attnum > 0 AND NOT a.attisdropped
    AND has_column_privilege('daftar_inventory_internal', c.oid, a.attnum, 'UPDATE');
  IF v_actual IS DISTINCT FROM ARRAY[
       'stocktake_lines.applied_value_base_minor', 'stocktake_lines.captured_at', 'stocktake_lines.captured_at_stock_seq',
       'stocktake_lines.counted_qty', 'stocktake_lines.expected_qty_at_capture', 'stocktake_lines.unit_cost_base_minor',
       'stocktakes.binding_source_id', 'stocktakes.cancelled_at', 'stocktakes.closed_by', 'stocktakes.finalize_intent_sha256',
       'stocktakes.finalized_at', 'stocktakes.occurred_on', 'stocktakes.status', 'stocktakes.total_value_base_minor'] THEN
    RAISE EXCEPTION 'inventory.migration_end_state_invalid: daftar_inventory_internal column UPDATE is not exactly the A-18 set, found %', v_actual;
  END IF;
  IF NOT has_table_privilege('daftar_inventory_internal', 'stock_source_bindings', 'SELECT')
     OR NOT has_table_privilege('daftar_inventory_internal', 'outbox_events', 'INSERT')
     OR has_table_privilege('daftar_inventory_internal', 'outbox_events', 'SELECT')
     OR has_table_privilege('daftar_inventory_internal', 'stock_source_bindings', 'UPDATE')
     OR has_table_privilege('daftar_inventory_internal', 'stock_source_bindings', 'DELETE')
     OR NOT has_function_privilege('daftar_inventory_internal', 'accounting_inventory_opening_position(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'inventory.migration_end_state_invalid: daftar_inventory_internal does not hold exactly its A-18 additions';
  END IF;
  -- The accounting principal reads the three posting headers and the
  -- warehouses, and holds nothing else on any S3 table.
  SELECT array_agg(t || ':' || p ORDER BY t || ':' || p) INTO v_actual
  FROM unnest(c_docs || c_bridges || ARRAY['warehouses', 'stock_movements', 'stock_levels', 'stock_source_bindings']) AS t
  CROSS JOIN unnest(c_privs) AS p
  WHERE has_table_privilege('daftar_accounting_internal', t, p)
     OR CASE WHEN p IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
             THEN has_any_column_privilege('daftar_accounting_internal', t, p) ELSE false END;
  IF v_actual IS DISTINCT FROM ARRAY['inventory_adjustments:SELECT', 'inventory_openings:SELECT', 'stocktakes:SELECT', 'warehouses:SELECT'] THEN
    RAISE EXCEPTION 'inventory.migration_end_state_invalid: daftar_accounting_internal holds more than A-18 on inventory tables, found %', v_actual;
  END IF;

  -- (8) Neither internal principal keeps CREATE on public, and no role
  --     gained an attribute or a membership.
  IF has_schema_privilege('daftar_inventory_internal', 'public', 'CREATE')
     OR has_schema_privilege('daftar_accounting_internal', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'inventory.migration_end_state_invalid: an internal principal still holds CREATE on schema public';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('daftar_inventory_internal', 'daftar_accounting_internal')
               AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR rolinherit)) THEN
    RAISE EXCEPTION 'inventory.migration_end_state_invalid: an internal principal is no longer an unreachable NOLOGIN NOINHERIT role';
  END IF;

  -- (9) Nothing can reach the new tables yet.
  SELECT array_agg(k.op_code ORDER BY k.op_code) INTO v_actual FROM inventory_operation_kinds k;
  IF v_actual IS DISTINCT FROM ARRAY['inventory.configure_product', 'structure.associate_warehouse_branch', 'structure.dissociate_warehouse_branch'] THEN
    RAISE EXCEPTION 'inventory.migration_end_state_invalid: inventory_operation_kinds is not still the three P3-S1 rows';
  END IF;
  IF EXISTS (SELECT 1 FROM inventory_operation_movement_kinds) THEN
    RAISE EXCEPTION 'inventory.migration_end_state_invalid: inventory_operation_movement_kinds must still be empty after 0061';
  END IF;

  -- (10) TD-13: owner, security, path and ACL unchanged; the try-lock guards
  --      the only DELETE; nobody gained EXECUTE.
  IF (SELECT format('%s|%s|%s|%s', p.proowner::regrole, p.prosecdef, coalesce(p.proconfig::text, '-'), coalesce(p.proacl::text, '-'))
        FROM pg_proc p WHERE p.oid = 'public.accounting_actor(text[])'::regprocedure)
     IS DISTINCT FROM current_setting('daftar.td13_pre_accounting_actor', true)
     OR (SELECT format('%s|%s|%s|%s', p.proowner::regrole, p.prosecdef, coalesce(p.proconfig::text, '-'), coalesce(p.proacl::text, '-'))
           FROM pg_proc p WHERE p.oid = 'public.provision_actor(text[])'::regprocedure)
     IS DISTINCT FROM current_setting('daftar.td13_pre_provision_actor', true) THEN
    RAISE EXCEPTION 'inventory.migration_end_state_invalid: TD-13 changed the owner, security, path or ACL of an assertion verifier';
  END IF;
  IF (SELECT p.proowner::regrole::text FROM pg_proc p WHERE p.oid = 'public.accounting_actor(text[])'::regprocedure) <> 'daftar_accounting_internal'
     OR NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = 'public.provision_actor(text[])'::regprocedure)
     OR (SELECT p.proconfig FROM pg_proc p WHERE p.oid = 'public.provision_actor(text[])'::regprocedure)
        IS DISTINCT FROM ARRAY['search_path=public, pg_catalog, pg_temp'] THEN
    RAISE EXCEPTION 'inventory.migration_end_state_invalid: TD-13 verifiers do not keep their accepted configuration';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['accounting_actor(text[])'::regprocedure, 'provision_actor(text[])'::regprocedure] LOOP
    v_def := pg_get_functiondef(v_fn);
    IF (length(v_def) - length(replace(v_def, 'DELETE FROM', ''))) / length('DELETE FROM') <> 1
       OR position('pg_try_advisory_xact_lock(' IN v_def) = 0
       OR position('pg_try_advisory_xact_lock(' IN v_def) > position('DELETE FROM' IN v_def) THEN
      RAISE EXCEPTION 'inventory.migration_end_state_invalid: % does not guard its only prune with pg_try_advisory_xact_lock', v_fn;
    END IF;
  END LOOP;
  FOREACH v_role IN ARRAY ARRAY['daftar_app', 'daftar_worker', 'daftar_identity', 'daftar_resolver', 'daftar_provisioner', 'daftar_reconciler', 'public'] LOOP
    IF has_function_privilege(v_role, 'accounting_actor(text[])', 'EXECUTE')
       OR has_function_privilege(v_role, 'provision_actor(text[])', 'EXECUTE') THEN
      RAISE EXCEPTION 'inventory.migration_end_state_invalid: % may execute an assertion verifier', v_role;
    END IF;
  END LOOP;
END $$;

COMMENT ON TABLE inventory_transfers IS
  'P3-S3 A-04. A stock transfer between two warehouses of one business, complete at insert and immutable. No journal entry (L:537).';
COMMENT ON TABLE inventory_transfer_lines IS
  'P3-S3 A-04. One variant and positive quantity per line; each line owns exactly one transfer_out and one transfer_in (A-15(d)).';
COMMENT ON TABLE inventory_adjustments IS
  'P3-S3 A-04/A-12. An adjustment or damage document, complete at insert and immutable. total_value_base_minor = Σ its movement values; binding_source_id = id exactly when an inventory_adjustment journal entry is owed.';
COMMENT ON TABLE inventory_adjustment_lines IS
  'P3-S3 A-12. Signed quantity per variant; an explicit unit cost exactly on the positive lines.';
COMMENT ON TABLE stocktakes IS
  'P3-S3 A-11. draft → finalized | cancelled; terminal states immutable. Posts as accounting source inventory_adjustment when its total is non-zero.';
COMMENT ON TABLE stocktake_lines IS
  'P3-S3 A-11. The capture (expected quantity and stock_seq at count time) and the counted quantity; variance_qty is generated. Final once the stocktake closes.';
COMMENT ON TABLE inventory_openings IS
  'P3-S3 A-13. The one posted inventory opening of a business: Case A posts Inventory against opening equity; Case B is decomposed against a posted opening balance and posts nothing. posted → superseded is refused until B-1 is decided.';
COMMENT ON TABLE inventory_opening_lines IS
  'P3-S3 A-13. Warehouse, variant, quantity and unit cost; the movement carries the largest-remainder share of the document total.';
