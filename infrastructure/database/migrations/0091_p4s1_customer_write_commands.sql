-- 0091_p4s1_customer_write_commands.sql
-- P4-S1 — THE CUSTOMER WRITE COMMANDS: `customer_create` and
-- `customer_update`, in the accepted `supplier_*` command shape
-- (`0064:341`, `0064:421`), and NOTHING else.
--
-- ── The authority this file rests on ───────────────────────────────────
--
-- Owner decision DR-142 (2026-11-12), quoted:
--
--   «أوافق على هجرة كتابة الزبون بنمط دوالّ الأوامر (أ)، داخل
--    `withBusinessInventoryTransaction` كنمط `supplier_*`، مع الإبقاء على
--    `customers_revision_guard` وbaseline بصمة النية.»
--
-- and its scope limit: CREATE AND UPDATE ONLY. Therefore this file does
-- NOT create `customer_archive`, does NOT create `customer_reactivate`,
-- does NOT create a reader, and writes no customer row of its own.
-- `customer.archive` and `customer.reactivate` are deliberately NOT
-- registered as operation kinds here: a registered kind with no consumer
-- is a violation of the P3-S8 operation-kind law
-- (`tests/security/phase3-s8-operation-kinds.test.ts`, rule 1), so
-- registering them before their routines exist would be registering an
-- authority nothing can exercise.
--
-- ── Why this migration is needed at all (measured) ─────────────────────
--
-- `customers` (`0075:190`) is live with every column these routines need,
-- but NO role holds INSERT on it: `0075:494-495` grants only SELECT to
-- `daftar_app` and to `daftar_inventory_internal`, and `0081:661` adds
-- only `UPDATE (status)` to the internal principal. So a customer cannot
-- be created at all today, by anybody, through any path.
--
-- ── The two tables other than `customers` that this file touches, and
--    why each is the pattern's plumbing and not a widening ─────────────
--
--   (1) `inventory_operation_kinds` — ONE row per routine. The FIRST
--       statement of each routine consumes an `invctl/1` assertion of its
--       own kind, and `inventory_assertion_consume` (`0054:344`) admits
--       no kind the registry does not carry. The precedent is exact and
--       recent: `0081:2479` registered `customer.collect_payment` and
--       `customer.apply_credit` beside the routines that consume them, as
--       `0079:1221` did for the four `pos.*` kinds. Measured: zero
--       migration mentions `customer.create` or `customer.update` today
--       (positive control: `supplier.create` appears in 0064, 0066, 0068
--       and 0079), so without these two rows the approved routines are
--       unreachable rather than merely ungranted.
--
--   (2) `audit_events` and `outbox_events` — the trail every command
--       routine in this codebase writes (`0064:409-415` for
--       `supplier_create`). Both are append-only infrastructure
--       (`0004:2`, `0004:25`) and carry no money.
--
-- Nothing else is touched. `customer_contacts` is NOT written by either
-- routine — its own table, outside DR-142 — which is why the API refuses a
-- request that names contacts instead of accepting one and dropping them.
--
-- ── The privilege shape (`0063:593-601`, the supplier precedent) ───────
--
-- `daftar_app` gains NO DML on `customers` and keeps only the SELECT it
-- has (P4-AL-38); it gains EXECUTE on the two routines, which is
-- reachability and not authority (P4-AL-39: each routine verifies the
-- signed server decision itself). The internal principal gains INSERT and
-- a COLUMN-SCOPED UPDATE — never a table-level UPDATE, DELETE or TRUNCATE
-- — and `status` is deliberately ABSENT from that column list: the
-- lifecycle is out of scope, so no privilege granted here could change a
-- customer's status even if a routine tried.
--
-- `customers_revision_guard()` and `customers_no_delete()` (`0075:507`,
-- `0075:516`) are left exactly as they are: this file drops no trigger,
-- replaces no guard function, and the end state re-reads both from the
-- catalogue. The internal principal owns those guard FUNCTIONS but not the
-- TABLE (`0081:655-660`), so it cannot disable them.
--
-- No routine reads a clock for a bound value. `updated_at = now()` is a
-- row timestamp, not a bound date, and is the accepted `supplier_update`
-- behaviour (`0064:467`); no date, period, due date or FX instant is
-- derived here, because a customer carries none.

-- ─────────────────────────────────────────────────────────────────────────
-- 0. 0091-P — the pre state, read from the LIVE catalogues. A migration
--    that replaces a function it did not expect to find has silently
--    changed somebody else's behaviour.
-- ─────────────────────────────────────────────────────────────────────────
DO $pre$
BEGIN
  IF to_regprocedure('public.customer_create(uuid,text,text,text,text)') IS NOT NULL
     OR to_regprocedure('public.customer_update(uuid,integer,text,text,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'selling.migration_pre_state_invalid: a customer write routine 0091 creates already exists, so its ACL is not reviewable'
      USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM inventory_operation_kinds k WHERE k.op_code IN ('customer.create', 'customer.update')) THEN
    RAISE EXCEPTION 'selling.migration_pre_state_invalid: a customer write operation kind is already registered'
      USING ERRCODE = 'P0001';
  END IF;
  -- The guards this file must leave standing are standing before it runs.
  IF to_regprocedure('public.customers_revision_guard()') IS NULL OR to_regprocedure('public.customers_no_delete()') IS NULL THEN
    RAISE EXCEPTION 'selling.migration_pre_state_invalid: the 0075 customer guards are not live' USING ERRCODE = 'P0001';
  END IF;
END
$pre$;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. The privileges on `customers`, BEFORE the bracket (the `0075:505` /
--    `0081:661` order: GRANT before OWNER).
--
--    INSERT, and UPDATE on exactly the columns `customer_update` states.
--    `status` is NOT among them (the lifecycle is out of DR-142's scope)
--    and neither are `tenant_id`, `business_id`, `id`,
--    `create_intent_sha256`, `created_by` or `created_at` — the identity
--    `customers_revision_guard()` already calls final. The privilege and
--    the guard therefore say the same thing twice, which is the point: a
--    privilege is not a fiction, and a rule only the wrapper keeps is a
--    convention ([[daftar-wrapper-is-not-an-invariant]]).
-- ─────────────────────────────────────────────────────────────────────────
GRANT INSERT ON customers TO daftar_inventory_internal;
GRANT UPDATE (name, phone, email, notes, revision, last_intent_sha256, business_transaction_id, updated_by, updated_at)
  ON customers TO daftar_inventory_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. The bracket, and the two routines inside it.
-- ─────────────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;

CREATE FUNCTION customer_create(
  p_customer_id UUID,
  p_name        TEXT,
  p_phone       TEXT,
  p_email       TEXT,
  p_notes       TEXT
) RETURNS TABLE (
  customer_id UUID,
  replayed    BOOLEAN,
  revision    INTEGER,
  status      TEXT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_actor    inventory_verified_actor;
  v_business UUID;
  v_tenant   UUID;
  v_trace    UUID;
  v_intent   TEXT;
  v_stored   TEXT;
  v_replay   BOOLEAN;
-- The assignment below is the FIRST statement of the body, over ALL of this
-- routine's own arguments: the id, then the eight words of each of the four
-- text groups. 33 fields, which is `INVENTORY_PAYLOAD_FIELDS['customer.create']`
-- (`packages/inventory/src/payload.ts:699`) exactly — one uuid plus
-- `CUSTOMER_TEXT`. Nothing is read, locked or written before it.
--
-- THIS PROSE SITS ABOVE `BEGIN` AND NOT BELOW IT, AND THAT IS LOAD-BEARING.
-- §4 claim (3) reads the body's first statement as
-- `btrim(split_part(substr(prosrc, position(E'\nBEGIN\n' IN prosrc) + 7), ';', 1))`
-- — the `0064:1612` idiom — which takes the RAW text after `BEGIN` and does
-- not strip comments. A comment between `BEGIN` and the assignment therefore
-- makes the routine's own end-state claim fail, which is exactly what it did:
-- `customer_create does not consume its own customer kind as its first
-- statement` on CI run 43117037383, step `Fresh database migrate
-- (0000 -> latest)`. `supplier_create` (`0064:341`) puts the assignment on the
-- line immediately after `BEGIN` for the same reason.
BEGIN
  v_actor := inventory_assertion_consume('customer.create', inventory_claimed_payload_digest('customer.create',
    ARRAY['uuid'] || array_fill('integer'::text, ARRAY[32]),
    ARRAY[p_customer_id::text] || inventory_reason_words(p_name) || inventory_reason_words(p_phone)
      || inventory_reason_words(p_email) || inventory_reason_words(p_notes)));
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'inventory.isolation_unsupported: inventory commands run only at READ COMMITTED' USING ERRCODE = 'P0001';
  END IF;
  v_business := v_actor.business_id;
  v_tenant   := v_actor.tenant_id;
  v_replay   := false;
  v_trace    := inventory_business_transaction_id();
  IF v_trace IS NULL THEN
    RAISE EXCEPTION 'inventory.trace_missing: a customer records its business transaction id' USING ERRCODE = 'P0001';
  END IF;
  IF p_customer_id IS NULL THEN
    RAISE EXCEPTION 'inventory.payload_invalid: a customer names its id' USING ERRCODE = 'P0001';
  END IF;

  -- R-26: the document key precedes the intent read and the row read.
  PERFORM pg_advisory_xact_lock(hashtext('daftar.customer_id'), hashtext(p_customer_id::text));
  v_intent := split_part(current_setting('app.inventory_assertion', true), '.', 7);

  SELECT c.create_intent_sha256 INTO v_stored FROM customers c WHERE c.business_id = v_business AND c.id = p_customer_id FOR UPDATE;
  IF FOUND THEN
    -- The intent fingerprint BASELINE: the id is the client's idempotency
    -- key, so the same id with a different intent is a different customer
    -- wearing a used key, and is refused rather than overwritten.
    IF v_stored <> v_intent THEN
      RAISE EXCEPTION 'customer.idempotency_conflict: this customer id was used for a different customer' USING ERRCODE = 'P0001';
    END IF;
    v_replay := true;
  ELSE
    IF p_name IS NULL OR p_name <> btrim(p_name) OR char_length(p_name) NOT BETWEEN 1 AND 200
       OR (p_phone IS NOT NULL AND (p_phone <> btrim(p_phone) OR char_length(p_phone) NOT BETWEEN 1 AND 40))
       OR (p_email IS NOT NULL AND (p_email <> btrim(p_email) OR char_length(p_email) NOT BETWEEN 3 AND 254))
       OR (p_notes IS NOT NULL AND (p_notes <> btrim(p_notes) OR char_length(p_notes) NOT BETWEEN 1 AND 1000)) THEN
      RAISE EXCEPTION 'inventory.payload_invalid: a customer has a trimmed name of 1..200 characters and trimmed, non-empty contacts within their limits' USING ERRCODE = 'P0001';
    END IF;
    -- The tenant and the business are the VERIFIED actor's, never an
    -- argument: there is no parameter by which a caller could name another
    -- merchant's business, and the RESTRICTIVE insert policy (`0075:412`)
    -- re-checks the one written against `app_business()`.
    INSERT INTO customers (tenant_id, business_id, id, name, phone, email, notes, status, revision,
                           create_intent_sha256, last_intent_sha256, business_transaction_id, created_by, updated_by)
    VALUES (v_tenant, v_business, p_customer_id, p_name, p_phone, p_email, p_notes, 'active', 1,
            v_intent, v_intent, v_trace, v_actor.actor_user_id, v_actor.actor_user_id);

    INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, metadata)
    VALUES (v_tenant, v_business, v_actor.actor_user_id, 'customer.created', 'customer', p_customer_id::text,
            jsonb_build_object('revision', 1, 'assertionJti', v_actor.jti, 'business_transaction_id', v_trace));
    INSERT INTO outbox_events (tenant_id, business_id, type, payload)
    VALUES (v_tenant, v_business, 'customer.created.v1',
            jsonb_build_object('businessId', v_business, 'customerId', p_customer_id, 'businessTransactionId', v_trace));
  END IF;

  RETURN QUERY
  SELECT c.id, v_replay, c.revision, c.status FROM customers c WHERE c.business_id = v_business AND c.id = p_customer_id;
END;
$$;

COMMENT ON FUNCTION customer_create(UUID, TEXT, TEXT, TEXT, TEXT) IS
  'P4-S1, owner decision DR-142. First consumes an invctl/1 assertion of kind customer.create over its own arguments (the id, then the eight words each of name, phone, email and notes: the 33 fields of INVENTORY_PAYLOAD_FIELDS[customer.create]). Under the daftar.customer_id key, an existing id replays when its create intent is equal and is customer.idempotency_conflict otherwise. Creates an ACTIVE customer at revision 1; the tenant and business are the verified actor''s and are not parameters. Writes no customer_contacts row (out of DR-142''s scope). Audit customer.created and its outbox row. EXECUTE: daftar_app only — reachability, not authority.';

CREATE FUNCTION customer_update(
  p_customer_id       UUID,
  p_expected_revision INTEGER,
  p_name              TEXT,
  p_phone             TEXT,
  p_email             TEXT,
  p_notes             TEXT
) RETURNS TABLE (
  customer_id UUID,
  replayed    BOOLEAN,
  revision    INTEGER,
  status      TEXT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_actor    inventory_verified_actor;
  v_business UUID;
  v_tenant   UUID;
  v_trace    UUID;
  v_intent   TEXT;
  v_row      RECORD;
  v_replay   BOOLEAN;
BEGIN
  v_actor := inventory_assertion_consume('customer.update', inventory_claimed_payload_digest('customer.update',
    ARRAY['uuid', 'integer'] || array_fill('integer'::text, ARRAY[32]),
    ARRAY[p_customer_id::text, p_expected_revision::text] || inventory_reason_words(p_name) || inventory_reason_words(p_phone)
      || inventory_reason_words(p_email) || inventory_reason_words(p_notes)));
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'inventory.isolation_unsupported: inventory commands run only at READ COMMITTED' USING ERRCODE = 'P0001';
  END IF;
  v_business := v_actor.business_id;
  v_tenant   := v_actor.tenant_id;
  v_replay   := false;
  v_trace    := inventory_business_transaction_id();
  IF v_trace IS NULL THEN
    RAISE EXCEPTION 'inventory.trace_missing: a customer records its business transaction id' USING ERRCODE = 'P0001';
  END IF;
  IF p_customer_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision < 1 THEN
    RAISE EXCEPTION 'inventory.payload_invalid: a customer update names the customer and the revision it replaces' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('daftar.customer_id'), hashtext(p_customer_id::text));
  v_intent := split_part(current_setting('app.inventory_assertion', true), '.', 7);

  -- The business scope is in the predicate, so another merchant's customer
  -- is not found rather than updated; the RESTRICTIVE read policy
  -- (`0075:410`) is the second, independent refusal of the same thing.
  SELECT c.revision, c.last_intent_sha256 INTO v_row FROM customers c WHERE c.business_id = v_business AND c.id = p_customer_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer.not_found: the customer does not exist in this business' USING ERRCODE = 'P0001';
  END IF;
  -- The intent fingerprint baseline for an edit: the stored revision is the
  -- one THIS command produced and the stored intent is THIS command's.
  IF v_row.revision = p_expected_revision + 1 AND v_row.last_intent_sha256 = v_intent THEN
    v_replay := true;
  ELSE
    IF v_row.revision <> p_expected_revision THEN
      RAISE EXCEPTION 'customer.revision_changed: the customer changed since it was read' USING ERRCODE = 'P0001';
    END IF;
    IF p_name IS NULL OR p_name <> btrim(p_name) OR char_length(p_name) NOT BETWEEN 1 AND 200
       OR (p_phone IS NOT NULL AND (p_phone <> btrim(p_phone) OR char_length(p_phone) NOT BETWEEN 1 AND 40))
       OR (p_email IS NOT NULL AND (p_email <> btrim(p_email) OR char_length(p_email) NOT BETWEEN 3 AND 254))
       OR (p_notes IS NOT NULL AND (p_notes <> btrim(p_notes) OR char_length(p_notes) NOT BETWEEN 1 AND 1000)) THEN
      RAISE EXCEPTION 'inventory.payload_invalid: a customer has a trimmed name of 1..200 characters and trimmed, non-empty contacts within their limits' USING ERRCODE = 'P0001';
    END IF;
    -- THE STATUS RULE: `status` is not in the SET list and is not in this
    -- role's UPDATE privilege either. An edit states the customer's TEXT in
    -- full (an omitted optional field is cleared) and never its lifecycle;
    -- `active → inactive` is `customer_archive`, which DR-142 excludes and
    -- this file does not create.
    UPDATE customers c
       SET name = p_name, phone = p_phone, email = p_email, notes = p_notes,
           revision = c.revision + 1, last_intent_sha256 = v_intent, business_transaction_id = v_trace,
           updated_by = v_actor.actor_user_id, updated_at = now()
     WHERE c.business_id = v_business AND c.id = p_customer_id;

    INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, metadata)
    VALUES (v_tenant, v_business, v_actor.actor_user_id, 'customer.updated', 'customer', p_customer_id::text,
            jsonb_build_object('revision', p_expected_revision + 1, 'assertionJti', v_actor.jti, 'business_transaction_id', v_trace));
    INSERT INTO outbox_events (tenant_id, business_id, type, payload)
    VALUES (v_tenant, v_business, 'customer.updated.v1',
            jsonb_build_object('businessId', v_business, 'customerId', p_customer_id, 'businessTransactionId', v_trace));
  END IF;

  RETURN QUERY
  SELECT c.id, v_replay, c.revision, c.status FROM customers c WHERE c.business_id = v_business AND c.id = p_customer_id;
END;
$$;

COMMENT ON FUNCTION customer_update(UUID, INTEGER, TEXT, TEXT, TEXT, TEXT) IS
  'P4-S1, owner decision DR-142. First consumes an invctl/1 assertion of kind customer.update over its own arguments (the id, the expected revision, then the four word groups). Under the daftar.customer_id key: customer.not_found; a stored revision of expected + 1 with an equal last intent replays; any other revision is customer.revision_changed. States the whole TEXT of the customer (an omitted contact is cleared) and NEVER its status — the lifecycle is customer_archive / customer_reactivate, which DR-142 excludes and 0091 does not create. Writes no customer_contacts row. Audit customer.updated and its outbox row. EXECUTE: daftar_app only.';

REVOKE ALL ON FUNCTION customer_create(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION customer_update(UUID, INTEGER, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION customer_create(UUID, TEXT, TEXT, TEXT, TEXT) TO daftar_app;
GRANT EXECUTE ON FUNCTION customer_update(UUID, INTEGER, TEXT, TEXT, TEXT, TEXT) TO daftar_app;

ALTER FUNCTION customer_create(UUID, TEXT, TEXT, TEXT, TEXT) OWNER TO daftar_inventory_internal;
ALTER FUNCTION customer_update(UUID, INTEGER, TEXT, TEXT, TEXT, TEXT) OWNER TO daftar_inventory_internal;

REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. The registrations, LAST (the `0067:2280-2288` / `0079:1215-1223` /
--    `0081:2479` order). A registry row is a registration of AUTHORITY, so
--    it goes after the routine that consumes it exists.
--
--    `registered_by = 'P4-S1'`: the slice that owns the customer. The
--    column's CHECK is `^P[0-9]+-S[0-9]+$ OR 'P3-C'` after `0074:115-117`,
--    which admits it. The op codes are `customer.*` and not
--    `customer_write.*` because `^[a-z]+(\.[a-z_]+)+$` is frozen inside
--    `inventory_payload_digest` (`0054:229`) — the reasoning `0081:2465-2472`
--    sets out.
--
--    Two rows, not four: `customer.archive` and `customer.reactivate` stay
--    unregistered until their routines exist, because the P3-S8
--    operation-kind law refuses a registered kind with zero consumers.
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO inventory_operation_kinds (op_code, registered_by) VALUES
  ('customer.create', 'P4-S1'),
  ('customer.update', 'P4-S1');

-- ─────────────────────────────────────────────────────────────────────────
-- 4. 0091-E — the end state, read from the LIVE CATALOGUES and never from
--    this file's own statements. A migration that asserts what it just
--    wrote asserts nothing. Every claim is numbered so a failure names
--    itself, and every claim that asserts an ABSENCE carries a positive
--    control in the same query so a zero cannot come from a blind probe.
-- ─────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  c_create CONSTANT OID := to_regprocedure('public.customer_create(uuid,text,text,text,text)');
  c_update CONSTANT OID := to_regprocedure('public.customer_update(uuid,integer,text,text,text,text)');
  v_src    TEXT;
  v_proc   OID;
BEGIN
  -- (1) Both routines exist, are SECURITY DEFINER, internally owned, and
  --     carry the pinned search_path.
  IF c_create IS NULL OR c_update IS NULL THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: a customer write routine is missing' USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
       WHERE p.oid IN (c_create, c_update) AND p.prosecdef
         AND r.rolname = 'daftar_inventory_internal'
         AND array_to_string(p.proconfig, ',') LIKE '%search_path=pg_catalog, public, pg_temp%') <> 2 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: a customer write routine is not internally owned SECURITY DEFINER with the pinned path'
      USING ERRCODE = 'P0001';
  END IF;

  -- (2) EXECUTE reaches daftar_app and NOT PUBLIC. The non-zero arm is the
  --     control for the zero arm: the same probe on the same two oids. The
  --     PUBLIC arm reads the ACL through `acldefault('f', …)` and not
  --     `coalesce(…, '{}')`, because a NULL `proacl` is the DEFAULT acl —
  --     which GRANTS PUBLIC execute — and an empty-array substitution would
  --     report the most permissive state as the safest one (`0042:516-521`).
  IF (SELECT count(*) FROM pg_proc p WHERE p.oid IN (c_create, c_update)
        AND has_function_privilege('daftar_app', p.oid, 'EXECUTE')) <> 2
     OR EXISTS (SELECT 1 FROM pg_proc p
                 CROSS JOIN LATERAL unnest(coalesce(p.proacl, acldefault('f', p.proowner))) acl
                 WHERE p.oid IN (c_create, c_update) AND acl::text LIKE '=%') THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the customer write routines are not reachable by daftar_app alone'
      USING ERRCODE = 'P0001';
  END IF;

  -- (3) Each routine consumes ITS OWN kind as its first statement (the
  --     `0064` §(5) idiom). A routine that consumed another kind would be
  --     authorized by the wrong decision.
  FOREACH v_proc IN ARRAY ARRAY[c_create, c_update] LOOP
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_proc;
    IF btrim(split_part(substr(v_src, position(E'\nBEGIN\n' IN v_src) + 7), ';', 1))
       !~ ('^v_actor := inventory_assertion_consume\(''customer\.' || split_part(v_proc::regproc::text, '_', 2) || '''') THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: % does not consume its own customer kind as its first statement', v_proc::regproc
        USING ERRCODE = 'P0001';
    END IF;
    -- (4) And neither routine writes the contacts table, which DR-142
    --     leaves out. The positive control is that both DO name `customers`.
    IF v_src LIKE '%customer_contacts%' OR (v_src NOT LIKE '%INTO customers%' AND v_src NOT LIKE '%UPDATE customers%') THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: % writes customer_contacts, or does not write customers at all', v_proc::regproc
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- (5) `daftar_app` still holds NO DML on `customers`, and the control is
  --     that it DOES hold SELECT and that the internal principal DOES hold
  --     the INSERT this file granted.
  IF has_table_privilege('daftar_app', 'customers', 'INSERT')
     OR has_table_privilege('daftar_app', 'customers', 'UPDATE')
     OR has_table_privilege('daftar_app', 'customers', 'DELETE')
     OR has_table_privilege('daftar_app', 'customers', 'TRUNCATE')
     OR NOT has_table_privilege('daftar_app', 'customers', 'SELECT')
     OR NOT has_table_privilege('daftar_inventory_internal', 'customers', 'INSERT') THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the customers privilege set is not SELECT for daftar_app and INSERT for the internal principal'
      USING ERRCODE = 'P0001';
  END IF;

  -- (6) The internal principal's UPDATE is COLUMN-scoped and excludes
  --     `status` and the final identity columns. `has_column_privilege` on
  --     `name` is the control for the `status` zero.
  IF NOT has_column_privilege('daftar_inventory_internal', 'customers', 'name', 'UPDATE')
     OR has_column_privilege('daftar_inventory_internal', 'customers', 'id', 'UPDATE')
     OR has_column_privilege('daftar_inventory_internal', 'customers', 'create_intent_sha256', 'UPDATE')
     OR has_column_privilege('daftar_inventory_internal', 'customers', 'created_by', 'UPDATE') THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the internal UPDATE on customers is not column-scoped away from the final identity'
      USING ERRCODE = 'P0001';
  END IF;
  -- `status` was granted by 0081 for the lifecycle and 0091 neither adds
  -- nor removes it; it is asserted as INHERITED, not as this file's.
  IF NOT has_column_privilege('daftar_inventory_internal', 'customers', 'status', 'UPDATE') THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0081''s UPDATE (status) on customers was lost' USING ERRCODE = 'P0001';
  END IF;

  -- (7) The 0075 guards are still installed on the table, by trigger and
  --     not merely by the function existing.
  IF (SELECT count(*) FROM pg_trigger t
       WHERE t.tgrelid = 'customers'::regclass AND NOT t.tgisinternal
         AND t.tgfoid IN (to_regprocedure('public.customers_revision_guard()'), to_regprocedure('public.customers_no_delete()'))) <> 2 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: customers_revision_guard or customers_no_delete is no longer triggered on customers'
      USING ERRCODE = 'P0001';
  END IF;

  -- (8) Exactly two `customer.*` kinds are registered by P4-S1, and the
  --     control is that the two P4-S4 ones from `0081` are still there and
  --     still P4-S4 — so the count is a measurement and not an empty table.
  IF (SELECT count(*) FROM inventory_operation_kinds k WHERE k.registered_by = 'P4-S1' AND k.op_code LIKE 'customer.%') <> 2
     OR NOT EXISTS (SELECT 1 FROM inventory_operation_kinds k WHERE k.op_code = 'customer.create' AND k.registered_by = 'P4-S1')
     OR NOT EXISTS (SELECT 1 FROM inventory_operation_kinds k WHERE k.op_code = 'customer.update' AND k.registered_by = 'P4-S1')
     OR (SELECT count(*) FROM inventory_operation_kinds k
          WHERE k.op_code IN ('customer.collect_payment', 'customer.apply_credit') AND k.registered_by = 'P4-S4') <> 2 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the two P4-S1 customer kinds are not registered beside 0081''s two P4-S4 kinds'
      USING ERRCODE = 'P0001';
  END IF;

  -- (9) The lifecycle kinds DR-142 excludes are NOT registered. The control
  --     is claim (8): the same probe on the same table found four rows.
  IF EXISTS (SELECT 1 FROM inventory_operation_kinds k WHERE k.op_code IN ('customer.archive', 'customer.reactivate')) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: a customer lifecycle kind is registered and 0091 creates no routine for it'
      USING ERRCODE = 'P0001';
  END IF;
  IF to_regprocedure('public.customer_archive(uuid,integer)') IS NOT NULL
     OR to_regprocedure('public.customer_reactivate(uuid,integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0091 created a lifecycle routine outside DR-142' USING ERRCODE = 'P0001';
  END IF;

  -- (10) No CREATE left on schema public for the internal principal.
  IF has_schema_privilege('daftar_inventory_internal', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: an internal principal still holds CREATE on schema public' USING ERRCODE = 'P0001';
  END IF;
END
$post$;
