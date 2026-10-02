-- 0079_phase4_pos_till_sessions_cart.sql
-- Phase 4 / P4-S3 — the POS till session and the SERVER-SIDE CART
-- (docs/PHASE_4_ARCHITECTURE_LOCK.md P4-AL-05, P4-AL-06, P4-AL-08, P4-AL-09,
-- P4-AL-15b, P4-AL-18, P4-AL-33, P4-AL-38, P4-AL-39, P4-AL-44, P4-AL-86, and
-- the two rulings this slice is blocked on: OD-P4-02 — DISCOUNT ONLY — and
-- OD-P4-09 — ONE SESSION, ONE AUTHENTICATED USER;
-- docs/PHASE_4_EXECUTION_PLAN.md §P4-S3 and its migration table row,
-- `pos_till_sessions` and `pos_cart_lines`; no accounting object).
--
-- Migrations 0000-0078 are FROZEN and untouched. This is P4-S3's ONLY
-- migration and it stays a CANDIDATE: no MIGRATION_MANIFEST.json entry and no
-- `frozenThrough` movement (TL-P4-S1-C8 — only an acceptance commit freezes a
-- digest, and freezing one early turns `check:migrations` red on the next edit
-- of the same file).
--
-- ── What this file does ─────────────────────────────────────────────────
--
--   1. pos_till_sessions: the authenticated till shift. One row per shift,
--      carrying tenant_id and business_id as real columns (P4-AL-08), the
--      branch the till is bound to (P4-AL-40), the warehouse it sells from and
--      the currency that denominates every minor-unit figure beneath it.
--   2. pos_cart_lines: the server-side basket, keyed by the till session
--      (P4-AL-18). IDENTITIES, A QUANTITY AND A DISCOUNT REQUEST, and nothing
--      else: no unit price, no gross, no net, no line total and no cart total,
--      because every one of those is DERIVED from the catalogue at read time
--      and a stored copy is a second writer's truth (P4-AL-05, P4-AL-06).
--   3. OD-P4-09 AS A CONSTRAINT AND NOT AS A SERVICE CONVENTION — see the
--      header rule R-P4-S3-02. A cart line whose actor is not the session's
--      own user is UNREPRESENTABLE: the composite foreign key points at the
--      candidate key `(business_id, id, opened_by)`, so the database itself
--      refuses it, and the trusted generic primitive cannot write the row
--      either ([[daftar-wrapper-is-not-an-invariant]]).
--   4. Row security ENABLEd and FORCEd on both relations, with the SIX
--      policies of an ordinary relation (P4-AL-38 as corrected by
--      TL-P4-S1-C2; the accepted shape is `0077`'s `sale_items` and the
--      purchase bridge at `0063:555-568`). NEITHER relation is an
--      accounting-source relation, so neither carries `accounting_validator`
--      and `daftar_accounting_internal` holds no privilege on either —
--      asserted, because an unexplained accounting principal on a POS table
--      is exactly how a slice that creates no accounting object starts
--      creating one.
--   5. The lifecycle guards, and the four till commands with their
--      `inventory_operation_kinds` registrations.
--   6. 0079-E(1)…(13): the end state, asserted against the LIVE catalogues.
--   7. 0079-P(a)…(c): three PERFORMED refusals, each rolled back.
--
-- ── What this file does NOT do ──────────────────────────────────────────
--
--   NO ACCOUNTING OBJECT AT ALL, which is this slice's migration row verbatim.
--   No `accounting_source_types` row, no `accounting_operation_kinds` row, no
--   `accounting_source_bindings` edge, no completeness validator, no trigger on
--   `journal_entries`, and neither relation carries an
--   `accounting_source_type` or a `binding_source_id` column. A till shift and
--   a basket are not documents; the document is the sale, which `0077`/`0078`
--   already own. 0079-E(5) asserts every half of that from the catalogue.
--
--   NO STOCK OBJECT. No `stock_source_types` row, no `stock_movement_kinds`
--   row, no bridge table and no movement: a cart RESERVES NOTHING
--   (`NEVER_STORED` at scripts/guards/no-authoritative-balance.ts refuses a
--   `reserved_*` or `available_*` column, and P4-AL-06 refuses the quantity
--   behind it). `inventory_apply_stock_movements` is not altered and
--   `inventory_stock_source_guard_gaps()` is not replaced — 0079-E(10)
--   asserts both.
--
--   NO PAYMENT, ALLOCATION, CREDIT, REFUND, RETURN OR INSTALMENT of any kind:
--   those are P4-S4…P4-S7's and P4-AL-86's forward-scope check refuses a
--   later slice's surface here.
--
--   NO TAX COLUMN. `0077` carries `tax_minor` with `CHECK (tax_minor = 0)`
--   because a sale's total arithmetic names a tax term; a cart line carries no
--   total, so it needs no term, and the strongest expression of OD-03 BEING
--   OPEN is a relation on which a tax is not writable at all (P4-AL-44).
--   0079-E(3) asserts the absence from the live column list.
--
--   NO BRANCH-SCOPE POLICY. P4-AL-40 asks that a user whose
--   `member_branch_scopes` do not include the till's branch be refused BY THE
--   POLICY and not by the controller. It cannot be honoured here and is
--   reported rather than faked: there is no `app_user()` RLS helper in the
--   tree (`0006:5-11`, `0052:236-248` define exactly `app_tenant()`,
--   `app_business()` and `app_bypass()`), so a branch-scope policy would need
--   a new session setting and a new estate-wide RLS mechanism, which is not
--   one migration's decision. What IS enforced here is narrower and real: the
--   session's branch is composite-FK-bound to its business, and the ACTOR is
--   the `invctl/1` assertion's — a cryptographically asserted user, never a
--   client claim. Recorded as a Tech Lead review point in
--   docs/PHASE_4_S3_MIGRATION_DESIGN.md §9.
--
-- ── Header rules (P4-S3) ───────────────────────────────────────────────
--
--   R-P4-S3-01 THE LIVE CATALOGUE IS THE POLICY
--        ([[daftar-the-live-catalogue-is-the-policy]]). The pre-flight block
--        and 0079-E read `pg_class`, `pg_policy`, `pg_constraint`, `pg_index`,
--        `pg_proc`, `pg_trigger`, `aclexplode()` and
--        `has_table_privilege()` TODAY. A migration that asserts what it just
--        wrote asserts nothing: the `CREATE POLICY` above and the row
--        `pg_policy` holds are different claims, and a `GRANT` issued without
--        grant option is a WARNING that COMMITS, so the only way to know a
--        privilege was granted is to ask the catalogue for it.
--
--   R-P4-S3-02 OD-P4-09 IS A CONSTRAINT, NOT A CONVENTION. The ruling is
--        "one till session = one authenticated user; a change of user is a new
--        session". A service that checks the actor before it writes is a
--        convention, because `daftar_inventory_internal` — the trusted generic
--        principal every inventory command runs as — can still write the row.
--        So the ruling is carried by FOUR physical facts, none of them a
--        wrapper:
--
--        (a) `pos_till_sessions_actor_uq UNIQUE (business_id, id, opened_by)`
--            is a candidate key, and `pos_cart_lines_session_actor_fk` names
--            `(business_id, till_session_id, added_by)` against it. A line
--            added by anyone but the session's own user has no parent row to
--            point at, so it is not representable at all — the `0067:344` +
--            `:394-396` composite-key idiom, used here for an ACTOR edge
--            rather than a business edge.
--        (b) That foreign key is `ON UPDATE RESTRICT`, so the session's user
--            cannot be swapped out from under a basket that already exists.
--        (c) `pos_till_sessions_one_open_per_user_uq`, a PARTIAL unique index
--            on `(business_id, opened_by) WHERE status = 'open'`: one user
--            holds at most one open session, so "a shift change is a new
--            session" is a uniqueness fact and not an instruction.
--        (d) `pos_till_session_guard()`, which refuses any UPDATE of
--            `opened_by` by name — the case (b) cannot reach, because a
--            session with no lines yet has no referencing row.
--
--        And `pos_till_sessions_one_open_per_terminal_uq` closes the other
--        half of the ruling's own risk sentence — "a cash-drawer discrepancy
--        then has no single owner": two open sessions on one physical till
--        would reproduce exactly that, with one drawer and two owners, so one
--        `(business_id, branch_id, terminal_code)` has at most one open
--        session.
--
--   R-P4-S3-03 THE CLIENT SENDS IDENTITIES, QUANTITIES AND A DISCOUNT REQUEST
--        (P4-AL-18, OD-P4-02 OPTION A). `requested_discount_minor` is the
--        ONLY money column this file creates, it is a BIGINT in the minor
--        units of the SESSION's currency, and its name says what it is: a
--        REQUEST. Nothing in the database derives from it, nothing authorises
--        it, and no second column records what was granted — the granted
--        discount is a fact of the SALE (`sale_items.discount_txn_minor`,
--        `0077`), written by `sale_commit` under `sales.discount`, and
--        `sale_items_discount_ck` (`0077`, `discount_txn_minor <=
--        gross_txn_minor`) is where the cap lives, because the cap is against
--        a GROSS the cart deliberately does not store.
--
--        There is no percentage column and no second representation: a
--        percentage would have to be resolved against a price, and resolving
--        a price is the server's at commit time, not the cart's.
--        0079-E(3) asserts the price vocabulary is absent from the live
--        column list, so a later hand adding `unit_price_txn_minor` to "save a
--        lookup" turns this file's own end state red.
--
--   R-P4-S3-04 GRANT BEFORE OWNER, AND THE CREATE BRACKET (P4-AL-39,
--        [[daftar-grant-before-owner]]). PUBLIC's EXECUTE is revoked, the
--        runtime grants issued and the triggers created while the MIGRATOR
--        still owns each function; only then is ownership handed over, inside
--        a `GRANT CREATE ON SCHEMA public` / `REVOKE CREATE ON SCHEMA public`
--        bracket (the guard G-7 contract,
--        scripts/guards/inventory-definer-contract.ts). A `GRANT` by a
--        non-owner without grant option WARNS and COMMITS, so the reverse
--        order would silently grant nothing and the migration would be green.
--
--   R-P4-S3-05 EXECUTE IS REACHABILITY, NOT AUTHORITY (P4-AL-39,
--        [[daftar-execute-is-reachability-not-authority]]). `daftar_app` holds
--        SELECT and EXECUTE and NO DML on either relation (P4-AL-38 in terms:
--        "`daftar_app` gets no DML on any Phase 4 table"), so each of the four
--        commands first CONSUMES an `invctl/1` assertion of its own registered
--        kind over its own arguments. The business, the tenant AND THE ACTOR
--        come from that verified assertion and never from an argument — which
--        is also what makes OD-P4-09's actor a signed fact rather than a
--        client's word.
--
--   R-P4-S3-06 NO FIFTH PRINCIPAL (TL-P4-S1-C17). `daftar_sales_internal` does
--        not exist and is not created: the till commands are owned by
--        `daftar_inventory_internal`, the principal that already owns
--        `sale_commit`. This DEEPENS the concentration the lock itself records
--        as risk R-P4-08, and it is recorded again in the design document
--        rather than introduced silently.
--
--   R-P4-S3-07 A CLOSURE RULE IS NOT AN INVARIANT (P4-AL-88). Every registry
--        assertion below is an equality over the `P4-S3`-REGISTERED SUBSET,
--        never a count over the whole registry, so a later slice registering
--        its own kinds does not turn this file's end state red.

-- ─────────────────────────────────────────────────────────────────────────
-- 0. Preconditions, read from the live catalogue (R-P4-S3-01).
-- ─────────────────────────────────────────────────────────────────────────
DO $pre$
DECLARE
  c_new CONSTANT TEXT[] := ARRAY['pos_till_sessions', 'pos_cart_lines'];
  c_fns CONSTANT TEXT[] := ARRAY['pos_till_session_guard', 'pos_cart_line_guard', 'pos_till_session_open',
                                 'pos_till_session_close', 'pos_cart_set_line', 'pos_cart_remove_line'];
  v_name TEXT;
BEGIN
  FOREACH v_name IN ARRAY c_new LOOP
    IF to_regclass('public.' || v_name) IS NOT NULL THEN
      RAISE EXCEPTION 'pos.migration_end_state_invalid: % already exists, so 0079 is not the migration that creates it', v_name
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- The P4-S2 head: the sale apparatus exists, because the cart's whole
  -- purpose is to become one of its sales and the POS surface is meaningless
  -- without the committer.
  IF to_regclass('public.sales') IS NULL OR to_regclass('public.sale_items') IS NULL
     OR to_regprocedure('public.sale_bridge_commit(uuid)') IS NULL THEN
    RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079 applies on the P4-S2 head (sales, sale_items and the sale commit apparatus) only'
      USING ERRCODE = 'P0001';
  END IF;

  -- The parents every edge names.
  IF to_regclass('public.businesses') IS NULL OR to_regclass('public.branches') IS NULL
     OR to_regclass('public.warehouses') IS NULL OR to_regclass('public.products') IS NULL
     OR to_regclass('public.product_variants') IS NULL OR to_regclass('public.currencies') IS NULL
     OR to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'pos.migration_end_state_invalid: a parent relation 0079 references is missing' USING ERRCODE = 'P0001';
  END IF;

  -- The assertion apparatus the four commands rest on, and the two internal
  -- principals. A command that cannot verify an assertion is a command with
  -- no authority check at all (P4-AL-39).
  IF to_regprocedure('public.inventory_assertion_consume(text,text)') IS NULL
     OR to_regprocedure('public.inventory_claimed_payload_digest(text,text[],text[])') IS NULL
     OR to_regprocedure('public.inventory_fixed_text(numeric,integer)') IS NULL
     OR to_regprocedure('public.inventory_business_transaction_id()') IS NULL THEN
    RAISE EXCEPTION 'pos.migration_end_state_invalid: the invctl/1 assertion apparatus 0079''s commands consume is missing'
      USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = 'daftar_inventory_internal') THEN
    RAISE EXCEPTION 'pos.migration_end_state_invalid: daftar_inventory_internal is missing' USING ERRCODE = 'P0001';
  END IF;
  -- TL-P4-S1-C17, asserted BEFORE this file writes: no fifth principal exists,
  -- so the ownership decision below is the only one available and is not a
  -- choice between two principals one of which nobody reviewed.
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = 'daftar_sales_internal') THEN
    RAISE EXCEPTION 'pos.authority_leak: daftar_sales_internal exists, which TL-P4-S1-C17 refused' USING ERRCODE = 'P0001';
  END IF;

  -- The registry rows this file writes are not already there, and the op-code
  -- namespace is free.
  IF EXISTS (SELECT 1 FROM inventory_operation_kinds k WHERE k.op_code LIKE 'pos.%')
     OR EXISTS (SELECT 1 FROM stock_movement_kinds k WHERE k.movement_kind LIKE 'pos%')
     OR EXISTS (SELECT 1 FROM stock_source_types t WHERE t.source_type LIKE 'pos%')
     OR EXISTS (SELECT 1 FROM accounting_source_types t WHERE t.source_type LIKE 'pos%') THEN
    RAISE EXCEPTION 'pos.migration_end_state_invalid: a registry already holds a P4-S3 row' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM inventory_operation_kinds k WHERE k.registered_by = 'P4-S3')
     OR EXISTS (SELECT 1 FROM stock_movement_kinds k WHERE k.registered_by = 'P4-S3')
     OR EXISTS (SELECT 1 FROM stock_source_types t WHERE t.registered_by = 'P4-S3')
     OR EXISTS (SELECT 1 FROM inventory_operation_movement_kinds m WHERE m.registered_by = 'P4-S3') THEN
    RAISE EXCEPTION 'pos.migration_end_state_invalid: a registry already attributes a row to P4-S3' USING ERRCODE = 'P0001';
  END IF;
  -- `registered_by = 'P4-S3'` must be EXPRESSIBLE: 0074 widened the four
  -- CHECKs, and a migration that discovers otherwise at its INSERT has already
  -- half run.
  IF (SELECT count(*) FROM pg_constraint c
       WHERE c.conname IN ('inventory_operation_kinds_registered_by_check', 'stock_movement_kinds_registered_by_check',
                           'stock_source_types_registered_by_check', 'inventory_operation_movement_kinds_registered_by_check')
         AND pg_get_constraintdef(c.oid) LIKE '%P[0-9]+-S[0-9]+%') <> 4 THEN
    RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079 applies on the 0074 head (the four widened registered_by CHECKs) only'
      USING ERRCODE = 'P0001';
  END IF;

  -- No routine this file creates may already exist: an ACL that is already
  -- there is an ACL nobody reviewed.
  FOREACH v_name IN ARRAY c_fns LOOP
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = v_name) THEN
      RAISE EXCEPTION 'pos.authority_leak: %() already exists, so its ACL is not reviewable', v_name USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- And the guard this slice must not disturb reports no gap BEFORE it starts,
  -- so a gap blamed on 0079 is a gap 0079 made.
  IF EXISTS (SELECT 1 FROM inventory_stock_source_guard_gaps()) THEN
    RAISE EXCEPTION 'pos.migration_end_state_invalid: inventory_stock_source_guard_gaps() already reports a gap before 0079 writes anything'
      USING ERRCODE = 'P0001';
  END IF;
END
$pre$;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. The till session: the authenticated shift (OD-P4-09, P4-AL-40).
--
--    `opened_by` is a single-column reference to the global `users`, which is
--    the accepted shape for an ACTOR on every commercial relation
--    (`0077`'s `sales.created_by`, `confirmed_by`, `voided_by`). The composite
--    rule is about CROSS-BUSINESS edges between commercial rows (P4-AL-09),
--    and `users` is not business-scoped; the business containment of the
--    session is carried by `pos_till_sessions_tenant_fk` over two NOT NULL
--    columns, which is also what makes every MATCH SIMPLE edge below safe.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE pos_till_sessions (
  tenant_id               UUID NOT NULL,
  business_id             UUID NOT NULL,
  id                      UUID NOT NULL,
  branch_id               UUID NOT NULL,
  warehouse_id            UUID NOT NULL,
  -- The physical till. Held to the `invpl/1` `code` grammar
  -- (`0054:206`, `^[a-z][a-z0-9_]{0,31}$`) so the whole argument is
  -- canonicalisable and therefore signable: a terminal name the minter cannot
  -- canonicalise is an argument no assertion can cover.
  terminal_code           TEXT NOT NULL
    CONSTRAINT pos_till_sessions_terminal_code_ck CHECK (terminal_code ~ '^[a-z][a-z0-9_]{0,31}$'),
  -- The denomination of every minor-unit figure beneath this session. The
  -- cart lines carry no currency of their own, which is how a basket cannot
  -- hold two denominations at once.
  currency_code           CHAR(3) NOT NULL,
  status                  TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  opened_by               UUID NOT NULL REFERENCES users (id),
  opened_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at               TIMESTAMPTZ,
  open_intent_sha256      TEXT NOT NULL CHECK (open_intent_sha256 ~ '^[0-9a-f]{64}$'),
  close_intent_sha256     TEXT CHECK (close_intent_sha256 IS NULL OR close_intent_sha256 ~ '^[0-9a-f]{64}$'),
  business_transaction_id UUID NOT NULL,
  PRIMARY KEY (business_id, id),
  -- R-P4-S3-02(a): the candidate key OD-P4-09's cart-line edge points at. It
  -- is redundant as a uniqueness claim — `(business_id, id)` is already the
  -- primary key — and it is NOT redundant as a REFERENCE TARGET, which is the
  -- only thing that makes a foreign key naming the actor expressible at all
  -- (the `0063:392` / `sale_items_bridge_uq` idiom).
  CONSTRAINT pos_till_sessions_actor_uq UNIQUE (business_id, id, opened_by),
  -- The state machine as a physical shape (the `0047` / stocktake pattern
  -- `0063:260` names; P4-AL-33): one CHECK enumerating each status with every
  -- column that must be null or non-null in it.
  CONSTRAINT pos_till_sessions_state_ck CHECK (
    (status = 'open'   AND closed_at IS NULL     AND close_intent_sha256 IS NULL)
    OR (status = 'closed' AND closed_at IS NOT NULL AND close_intent_sha256 IS NOT NULL)
  ),
  CONSTRAINT pos_till_sessions_closed_after_ck CHECK (closed_at IS NULL OR closed_at >= opened_at),
  CONSTRAINT pos_till_sessions_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT pos_till_sessions_branch_fk FOREIGN KEY (business_id, branch_id) REFERENCES branches (business_id, id),
  CONSTRAINT pos_till_sessions_warehouse_fk FOREIGN KEY (business_id, warehouse_id) REFERENCES warehouses (business_id, id),
  CONSTRAINT pos_till_sessions_currency_fk FOREIGN KEY (currency_code) REFERENCES currencies (code)
);
REVOKE ALL ON pos_till_sessions FROM PUBLIC;

-- R-P4-S3-02(c). OD-P4-09, as uniqueness: one authenticated user holds at most
-- ONE OPEN session in a business, so "a change of user is a new session" is a
-- fact the database keeps rather than a rule a service remembers. The index is
-- PARTIAL on purpose — a user's closed shifts are history and there may be any
-- number of them.
CREATE UNIQUE INDEX pos_till_sessions_one_open_per_user_uq
  ON pos_till_sessions (business_id, opened_by) WHERE status = 'open';

-- The other half of OD-P4-09's own risk sentence: one physical till, one open
-- session, so a cash-drawer discrepancy has exactly one owner.
CREATE UNIQUE INDEX pos_till_sessions_one_open_per_terminal_uq
  ON pos_till_sessions (business_id, branch_id, terminal_code) WHERE status = 'open';

-- The till's own shift list, and the branch's, as keyset walks.
CREATE INDEX pos_till_sessions_branch_idx ON pos_till_sessions (business_id, branch_id, opened_at, id);

-- ─────────────────────────────────────────────────────────────────────────
-- 2. The server-side cart (P4-AL-18, OD-P4-02, R-P4-S3-03).
--
--    Read the column list as the specification: four identities, one
--    quantity, one DISCOUNT REQUEST, one actor and one instant. There is no
--    price, no gross, no net, no line total, no cart total, no tax and no
--    currency — the currency is the session's and everything about price is
--    derived from the catalogue when the cart is read or committed. A cart
--    total column would be the forged-total attack of §12 with the attacker
--    replaced by a convenience ([[daftar-no-stored-derived-truth]]).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE pos_cart_lines (
  tenant_id                UUID NOT NULL,
  business_id              UUID NOT NULL,
  till_session_id          UUID NOT NULL,
  id                       UUID NOT NULL,
  line_no                  INTEGER NOT NULL CHECK (line_no >= 1),
  product_id               UUID NOT NULL,
  variant_id               UUID NOT NULL,
  -- A quantity is NUMERIC and money is integer minor units (P4-AL-15b). Q4,
  -- the scale `inventory_fixed_text(…, 4)` canonicalises and every accepted
  -- quantity column in the tree carries.
  quantity                 NUMERIC(18,4) NOT NULL CHECK (quantity > 0),
  -- THE CLIENT'S DISCOUNT REQUEST, and the only money column in this file:
  -- integer minor units of the SESSION's currency, never a rate, never a
  -- percentage, never a float. Zero is "no discount requested". No column
  -- records what was GRANTED, because the grant is a fact of the sale and a
  -- second copy here is a second writer (R-P4-S3-03).
  requested_discount_minor BIGINT NOT NULL DEFAULT 0 CHECK (requested_discount_minor BETWEEN 0 AND 1000000000000000000),
  -- The actor, and the subject of OD-P4-09's composite edge below.
  added_by                 UUID NOT NULL,
  added_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id),
  CONSTRAINT pos_cart_lines_line_uq UNIQUE (business_id, till_session_id, line_no),
  CONSTRAINT pos_cart_lines_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  -- ── OD-P4-09 IN THE DATABASE (R-P4-S3-02(a), (b)) ──────────────────────
  --
  -- This single edge does two jobs, and the second is the ruling. It is the
  -- parent edge — `(business_id, till_session_id)` into the session's own
  -- business and id, so a cross-business basket is not representable — AND it
  -- names `added_by` against the session's `opened_by`. A line added by any
  -- user but the session's own has NO PARENT ROW to point at, so the refusal
  -- is the referential integrity of the database and not a check inside a
  -- wrapper: `daftar_inventory_internal`, the trusted generic principal every
  -- till command runs as, cannot write the row either.
  --
  -- ON UPDATE RESTRICT is the other half: while a basket exists, the
  -- session's user cannot be swapped out from under it. The case this cannot
  -- reach — a session with no lines yet — is `pos_till_session_guard()`'s.
  CONSTRAINT pos_cart_lines_session_actor_fk
    FOREIGN KEY (business_id, till_session_id, added_by)
    REFERENCES pos_till_sessions (business_id, id, opened_by) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT pos_cart_lines_product_fk FOREIGN KEY (business_id, product_id) REFERENCES products (business_id, id),
  CONSTRAINT pos_cart_lines_variant_fk FOREIGN KEY (business_id, variant_id) REFERENCES product_variants (business_id, id)
);
REVOKE ALL ON pos_cart_lines FROM PUBLIC;

-- The cart read: every line of one session in display order, which is the
-- P4-B budget's access path.
CREATE INDEX pos_cart_lines_session_idx ON pos_cart_lines (business_id, till_session_id, line_no);

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Row security: ENABLE and FORCE on both (TL-P4-S1-R2), then the SIX
--    policies of an ordinary relation (P4-AL-38 as corrected by TL-P4-S1-C2;
--    the accepted shape is `0077`'s `sale_items` and the purchase bridge at
--    `0063:555-568`, which carries `tenant_membership`, the four RESTRICTIVE
--    per-command isolation policies and `inventory_internal_read`).
--
--    The tenant policy takes the DIRECT form `0052:305-330` adopted after
--    measurement, never `0063:555-557`'s correlated `businesses` subselect
--    ([[daftar-rls-policy-shape-is-a-cost]]) — which is available here
--    precisely because both relations carry `tenant_id` as a real column.
--
--    NEITHER relation is an accounting-source relation, so neither carries the
--    seventh `accounting_validator` policy and the restrictive read admits
--    `daftar_inventory_internal` ALONE. Each guard's reads were re-derived
--    from its own body below rather than assumed: `pos_cart_line_guard()`
--    reads `pos_till_sessions` and the four commands read both relations, all
--    as `daftar_inventory_internal`; nothing in this slice is read by
--    `daftar_accounting_internal`, because this slice creates no accounting
--    object. An assumed read is how a vacuous pass gets in (TL-P4-S1-C2).
--
--    The general Phase 4 RLS/FORCE DISCOVERY law
--    (scripts/guards/phase4-rls-force.ts) finds both relations by itself, from
--    the migration tree and from `pg_class`, and owes them ENABLE + FORCE
--    because each carries both dimensions. 0079-E(1) states the same thing
--    about these two so a failure names this file.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE pos_till_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_till_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE pos_cart_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_cart_lines FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_membership ON pos_till_sessions
  USING      (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON pos_till_sessions AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user = 'daftar_inventory_internal' OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON pos_till_sessions AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON pos_till_sessions AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON pos_till_sessions AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON pos_till_sessions
  FOR SELECT TO daftar_inventory_internal USING (true);

CREATE POLICY tenant_membership ON pos_cart_lines
  USING      (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON pos_cart_lines AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user = 'daftar_inventory_internal' OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON pos_cart_lines AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON pos_cart_lines AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON pos_cart_lines AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON pos_cart_lines
  FOR SELECT TO daftar_inventory_internal USING (true);

-- ─────────────────────────────────────────────────────────────────────────
-- 4. The privileges (P4-AL-38, R-P4-S3-05): `daftar_app` reads and holds NO
--    DML, so every write goes through a routine whose authority was checked —
--    [[daftar-wrapper-is-not-an-invariant]] is closed by the GRANT, not by the
--    wrapper. `daftar_accounting_internal` gets nothing at all: this slice
--    creates no accounting object, and an accounting principal with a read on
--    a POS table is a seam nobody asked for.
--
--    UPDATE is COLUMN-LEVEL, never table-level: a table-level UPDATE would let
--    the trusted generic primitive write a column the lifecycle guard happens
--    not to name (the `0063:597` / `0077` shape). On the session the writable
--    set is exactly the closing columns; on a cart line it is exactly the two
--    figures a cashier may revise — and `added_by` is NOT among them, which is
--    a fifth, privilege-level expression of OD-P4-09.
--
--    There is NO DELETE on `pos_till_sessions` for anyone: a shift is history
--    the moment it opens. There IS a DELETE on `pos_cart_lines`, because
--    removing a line from a basket is what a till does, and the guard binds it
--    to an OPEN session, so a closed shift's basket is frozen evidence.
-- ─────────────────────────────────────────────────────────────────────────
GRANT SELECT ON pos_till_sessions, pos_cart_lines TO daftar_app;
GRANT SELECT, INSERT ON pos_till_sessions, pos_cart_lines TO daftar_inventory_internal;
GRANT UPDATE (status, closed_at, close_intent_sha256, business_transaction_id) ON pos_till_sessions TO daftar_inventory_internal;
GRANT UPDATE (quantity, requested_discount_minor) ON pos_cart_lines TO daftar_inventory_internal;
GRANT DELETE ON pos_cart_lines TO daftar_inventory_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. The guards. Created while the migrator still owns them, PUBLIC revoked,
--    the triggers installed, and only then handed over inside the CREATE
--    bracket (R-P4-S3-04).
--
--    Each is SECURITY DEFINER with the pinned path and no grantee: none of
--    them authorises by `current_user`, because the authority is the GRANT and
--    the trigger carries the invariant
--    ([[daftar-a-guard-that-asks-who-must-run-as-the-writer]] — a guard that
--    DID ask would have to be INVOKER, since a definer always sees its own
--    owner there).
-- ─────────────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;

-- (a) The session's lifecycle, and R-P4-S3-02(d).
--
--     A session is INSERTed OPEN and never already closed; its identity and
--     its ACTOR are final; it goes open → closed exactly once; and it is never
--     deleted. The `opened_by` clause is OD-P4-09's fourth fact and is
--     deliberately a refusal OF ITS OWN, with its own message, because the
--     composite foreign key cannot reach the case where the basket is still
--     empty: there is no referencing row to restrict, so without this the
--     session's user could be reassigned in the one window that matters, the
--     start of a shift.
CREATE FUNCTION pos_till_session_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' OR NEW.closed_at IS NOT NULL OR NEW.close_intent_sha256 IS NOT NULL THEN
      RAISE EXCEPTION 'pos.till_session_lifecycle_invalid: a till session is created open, never already closed' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pos.till_session_immutable: a till session is never deleted' USING ERRCODE = 'P0001';
  END IF;
  -- OD-P4-09: one session, one authenticated user. Named on its own so the
  -- refusal says which ruling refused it.
  IF NEW.opened_by IS DISTINCT FROM OLD.opened_by THEN
    RAISE EXCEPTION 'pos.till_session_actor_immutable: a till session belongs to one authenticated user and a change of user is a new session (OD-P4-09)'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.business_id IS DISTINCT FROM OLD.business_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.branch_id IS DISTINCT FROM OLD.branch_id OR NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id
     OR NEW.terminal_code IS DISTINCT FROM OLD.terminal_code OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
     OR NEW.opened_at IS DISTINCT FROM OLD.opened_at
     OR NEW.open_intent_sha256 IS DISTINCT FROM OLD.open_intent_sha256 THEN
    RAISE EXCEPTION 'pos.till_session_immutable: the identity and the opening facts of a till session are final' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'pos.till_session_immutable: a closed till session is final' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status <> 'closed' THEN
    RAISE EXCEPTION 'pos.till_session_lifecycle_invalid: an open till session becomes a closed one and nothing else' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- (b) A basket belongs to an OPEN session, and its identity is final.
--
--     The parent is read `FOR NO KEY UPDATE` and NOT merely selected, and that
--     is the whole protection rather than a decoration. The foreign key takes
--     `FOR KEY SHARE` on the session row; closing a session is a NON-KEY
--     UPDATE, which takes `FOR NO KEY UPDATE`; those two do NOT conflict, so
--     without a stronger lock here a line could be added to a session that is
--     being closed in a concurrent transaction and the basket of a finished
--     shift would grow after the fact. `FOR NO KEY UPDATE` conflicts with the
--     close's own lock, so one of the two waits and the loser sees the
--     committed truth. Measured, not assumed — recorded in
--     docs/PHASE_4_S3_MIGRATION_DESIGN.md §7.
--
--     The actor is NOT re-checked here: it is the composite foreign key's, and
--     restating it in a trigger would make the invariant look like a
--     convention again.
CREATE FUNCTION pos_cart_line_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_status   TEXT;
  v_session  UUID;
  v_business UUID;
BEGIN
  -- On DELETE there is no NEW at all — referencing it would raise
  -- "record NEW is not assigned yet" and the guard would fail as a defect
  -- rather than as a refusal — so the subject is chosen by TG_OP first.
  IF TG_OP = 'DELETE' THEN
    v_session  := OLD.till_session_id;
    v_business := OLD.business_id;
  ELSE
    v_session  := NEW.till_session_id;
    v_business := NEW.business_id;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.business_id IS DISTINCT FROM OLD.business_id
       OR NEW.id IS DISTINCT FROM OLD.id OR NEW.till_session_id IS DISTINCT FROM OLD.till_session_id
       OR NEW.line_no IS DISTINCT FROM OLD.line_no
       OR NEW.product_id IS DISTINCT FROM OLD.product_id OR NEW.variant_id IS DISTINCT FROM OLD.variant_id
       OR NEW.added_by IS DISTINCT FROM OLD.added_by OR NEW.added_at IS DISTINCT FROM OLD.added_at THEN
      RAISE EXCEPTION 'pos.cart_line_immutable: a cart line''s identity, its product and its actor are final; a revision changes the quantity or the discount request'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  SELECT s.status INTO v_status
  FROM pos_till_sessions s
  WHERE s.business_id = v_business AND s.id = v_session
  FOR NO KEY UPDATE;
  IF NOT FOUND OR v_status <> 'open' THEN
    RAISE EXCEPTION 'pos.till_session_not_open: a cart is only written while its till session is open' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pos_till_session_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION pos_cart_line_guard() FROM PUBLIC;

CREATE TRIGGER pos_till_sessions_lifecycle
  BEFORE INSERT OR UPDATE OR DELETE ON pos_till_sessions
  FOR EACH ROW EXECUTE FUNCTION pos_till_session_guard();

CREATE TRIGGER pos_cart_lines_session_open
  BEFORE INSERT OR UPDATE OR DELETE ON pos_cart_lines
  FOR EACH ROW EXECUTE FUNCTION pos_cart_line_guard();

-- ─────────────────────────────────────────────────────────────────────────
-- 6. The four till commands (R-P4-S3-05). Each one's FIRST executable
--    statement is the assertion consume, so no relation is read before the
--    caller's authority is decided (the `0078-E(11)` claim, asserted again at
--    0079-E(8) over `prosrc`).
--
--    The payload grammar of each is recorded field by field in
--    docs/PHASE_4_S3_MIGRATION_DESIGN.md §6, because the minter
--    (`packages/inventory/src/payload.ts`) is held byte-identical to
--    `inventory_payload_digest` by the shared vectors and a command whose
--    grammar is not written down is a command nobody can mint for.
-- ─────────────────────────────────────────────────────────────────────────

-- (a) Open a shift. The actor is the assertion's; the business and the tenant
--     are the assertion's; a replay of the same intent on the same id is the
--     same session, and a different intent on the same id is a conflict.
CREATE FUNCTION pos_till_session_open(
  p_session_id    UUID,
  p_branch_id     UUID,
  p_warehouse_id  UUID,
  p_terminal_code TEXT,
  p_currency_code TEXT
) RETURNS TABLE (
  till_session_id UUID,
  replayed        BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_actor  inventory_verified_actor;
  v_trace  UUID;
  v_intent TEXT;
  v_stored TEXT;
  v_owner  UUID;
  v_replay BOOLEAN;
BEGIN
  v_actor := inventory_assertion_consume('pos.session_open', inventory_claimed_payload_digest('pos.session_open',
    ARRAY['uuid', 'uuid', 'uuid', 'code', 'code'],
    ARRAY[p_session_id::text, p_branch_id::text, p_warehouse_id::text, p_terminal_code, lower(p_currency_code)]));
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'inventory.isolation_unsupported: POS commands run only at READ COMMITTED' USING ERRCODE = 'P0001';
  END IF;
  v_replay := false;
  v_trace  := inventory_business_transaction_id();
  IF v_trace IS NULL THEN
    RAISE EXCEPTION 'inventory.trace_missing: a till session records its business transaction id' USING ERRCODE = 'P0001';
  END IF;
  IF p_session_id IS NULL OR p_branch_id IS NULL OR p_warehouse_id IS NULL THEN
    RAISE EXCEPTION 'inventory.payload_invalid: a till session names its id, its branch and its warehouse' USING ERRCODE = 'P0001';
  END IF;
  IF p_currency_code IS NULL OR p_currency_code <> upper(p_currency_code) OR char_length(p_currency_code) <> 3 THEN
    RAISE EXCEPTION 'inventory.payload_invalid: a till session names an upper-case ISO currency code' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('daftar.pos_till_session_id'), hashtext(p_session_id::text));
  v_intent := split_part(current_setting('app.inventory_assertion', true), '.', 7);

  SELECT s.open_intent_sha256, s.opened_by INTO v_stored, v_owner
  FROM pos_till_sessions s WHERE s.business_id = v_actor.business_id AND s.id = p_session_id FOR UPDATE;
  IF FOUND THEN
    IF v_stored <> v_intent THEN
      RAISE EXCEPTION 'pos.idempotency_conflict: this till session id was used for a different session' USING ERRCODE = 'P0001';
    END IF;
    -- OD-P4-09 again, at the replay: a second user presenting the first
    -- user's intent is not a replay, it is a takeover.
    IF v_owner <> v_actor.actor_user_id THEN
      RAISE EXCEPTION 'pos.till_session_not_yours: a till session belongs to one authenticated user (OD-P4-09)' USING ERRCODE = 'P0001';
    END IF;
    v_replay := true;
  ELSE
    BEGIN
      INSERT INTO pos_till_sessions (tenant_id, business_id, id, branch_id, warehouse_id, terminal_code, currency_code,
                                     status, opened_by, open_intent_sha256, business_transaction_id)
      VALUES (v_actor.tenant_id, v_actor.business_id, p_session_id, p_branch_id, p_warehouse_id, p_terminal_code,
              upper(p_currency_code), 'open', v_actor.actor_user_id, v_intent, v_trace);
    EXCEPTION
      WHEN unique_violation THEN
        -- The two partial unique indexes of OD-P4-09 and of the drawer,
        -- turned into the two stable business refusals a till can act on.
        IF position('pos_till_sessions_one_open_per_user_uq' IN SQLERRM) > 0 THEN
          RAISE EXCEPTION 'pos.till_session_already_open: this user already holds an open till session; close it before opening another (OD-P4-09)'
            USING ERRCODE = 'P0001';
        END IF;
        IF position('pos_till_sessions_one_open_per_terminal_uq' IN SQLERRM) > 0 THEN
          RAISE EXCEPTION 'pos.terminal_already_open: this terminal already holds an open till session' USING ERRCODE = 'P0001';
        END IF;
        RAISE;
    END;

    INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, metadata)
    VALUES (v_actor.tenant_id, v_actor.business_id, v_actor.actor_user_id, 'pos.till_session_opened', 'pos_till_session',
            p_session_id::text,
            jsonb_build_object('assertionJti', v_actor.jti, 'business_transaction_id', v_trace, 'branchId', p_branch_id));
  END IF;

  RETURN QUERY SELECT s.id, v_replay FROM pos_till_sessions s
   WHERE s.business_id = v_actor.business_id AND s.id = p_session_id;
END;
$$;

COMMENT ON FUNCTION pos_till_session_open(UUID, UUID, UUID, TEXT, TEXT) IS
  'P4-S3, OD-P4-09. Opens one till session for the actor the invctl/1 pos.session_open assertion names; the business, the tenant and the ACTOR come from the assertion and never from an argument. Under the daftar.pos_till_session_id key an existing id replays when its open intent AND its user are equal, and is pos.idempotency_conflict or pos.till_session_not_yours otherwise. A second open session for the same user is pos.till_session_already_open and for the same terminal pos.terminal_already_open, both decided by a partial unique index and not by this body. EXECUTE: daftar_app only — reachability, not authority.';

-- (b) Close a shift. The basket stays: a closed session and its lines are the
--     frozen record of what was in the drawer, and `pos_cart_line_guard()`
--     refuses every write to them afterwards.
CREATE FUNCTION pos_till_session_close(p_session_id UUID) RETURNS TABLE (
  till_session_id UUID,
  replayed        BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_actor  inventory_verified_actor;
  v_trace  UUID;
  v_intent TEXT;
  v_status TEXT;
  v_owner  UUID;
  v_close  TEXT;
  v_replay BOOLEAN;
BEGIN
  v_actor := inventory_assertion_consume('pos.session_close', inventory_claimed_payload_digest('pos.session_close',
    ARRAY['uuid'], ARRAY[p_session_id::text]));
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'inventory.isolation_unsupported: POS commands run only at READ COMMITTED' USING ERRCODE = 'P0001';
  END IF;
  v_replay := false;
  v_trace  := inventory_business_transaction_id();
  IF v_trace IS NULL THEN
    RAISE EXCEPTION 'inventory.trace_missing: a till session records its business transaction id' USING ERRCODE = 'P0001';
  END IF;
  v_intent := split_part(current_setting('app.inventory_assertion', true), '.', 7);

  SELECT s.status, s.opened_by, s.close_intent_sha256 INTO v_status, v_owner, v_close
  FROM pos_till_sessions s WHERE s.business_id = v_actor.business_id AND s.id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pos.till_session_unknown: no such till session' USING ERRCODE = 'P0001';
  END IF;
  -- OD-P4-09: only the session's own user ends their own shift.
  IF v_owner <> v_actor.actor_user_id THEN
    RAISE EXCEPTION 'pos.till_session_not_yours: a till session belongs to one authenticated user (OD-P4-09)' USING ERRCODE = 'P0001';
  END IF;
  IF v_status = 'closed' THEN
    IF v_close <> v_intent THEN
      RAISE EXCEPTION 'pos.idempotency_conflict: this till session was closed by a different request' USING ERRCODE = 'P0001';
    END IF;
    v_replay := true;
  ELSE
    UPDATE pos_till_sessions s
       SET status = 'closed', closed_at = now(), close_intent_sha256 = v_intent, business_transaction_id = v_trace
     WHERE s.business_id = v_actor.business_id AND s.id = p_session_id;

    INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, metadata)
    VALUES (v_actor.tenant_id, v_actor.business_id, v_actor.actor_user_id, 'pos.till_session_closed', 'pos_till_session',
            p_session_id::text, jsonb_build_object('assertionJti', v_actor.jti, 'business_transaction_id', v_trace));
  END IF;

  RETURN QUERY SELECT s.id, v_replay FROM pos_till_sessions s
   WHERE s.business_id = v_actor.business_id AND s.id = p_session_id;
END;
$$;

COMMENT ON FUNCTION pos_till_session_close(UUID) IS
  'P4-S3, OD-P4-09. Closes the actor''s OWN till session (pos.till_session_not_yours otherwise), under an invctl/1 pos.session_close assertion. Already closed by the same intent replays; by a different one it is pos.idempotency_conflict. The basket is NOT deleted: a closed session and its lines are the frozen record of the shift, and pos_cart_line_guard() refuses every later write to them. EXECUTE: daftar_app only.';

-- (c) Set a cart line: the whole of what a client may say about a basket.
--     IDENTITIES, A QUANTITY AND A DISCOUNT REQUEST (P4-AL-18, OD-P4-02).
--     There is no argument for a price, a line total or a tax, so a forged one
--     has nowhere to arrive: it is not validated and then rejected, it is
--     UNEXPRESSIBLE in the signature ([[daftar-an-unrepresentable-state-needs-no-check]]).
CREATE FUNCTION pos_cart_set_line(
  p_session_id               UUID,
  p_line_id                  UUID,
  p_line_no                  INTEGER,
  p_product_id               UUID,
  p_variant_id               UUID,
  p_quantity                 NUMERIC,
  p_requested_discount_minor BIGINT
) RETURNS TABLE (
  cart_line_id UUID,
  line_no      INTEGER,
  revised      BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_actor  inventory_verified_actor;
  v_old    RECORD;
  v_revise BOOLEAN;
BEGIN
  v_actor := inventory_assertion_consume('pos.cart_set_line', inventory_claimed_payload_digest('pos.cart_set_line',
    ARRAY['uuid', 'uuid', 'integer', 'uuid', 'uuid', 'integer', 'integer'],
    ARRAY[p_session_id::text, p_line_id::text, p_line_no::text, p_product_id::text, p_variant_id::text,
          inventory_fixed_text(p_quantity, 4), p_requested_discount_minor::text]));
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'inventory.isolation_unsupported: POS commands run only at READ COMMITTED' USING ERRCODE = 'P0001';
  END IF;
  IF p_session_id IS NULL OR p_line_id IS NULL OR p_product_id IS NULL OR p_variant_id IS NULL
     OR p_line_no IS NULL OR p_line_no < 1 THEN
    RAISE EXCEPTION 'inventory.payload_invalid: a cart line names its session, its id, its ordinal and its variant' USING ERRCODE = 'P0001';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'inventory.payload_invalid: a cart line carries a positive quantity' USING ERRCODE = 'P0001';
  END IF;
  -- The discount is a REQUEST in the minor units of the session's currency.
  -- It is NOT capped here and must not be: the cap is against a GROSS this
  -- relation deliberately does not store, and `sale_items_discount_ck` is
  -- where it lives (R-P4-S3-03).
  IF p_requested_discount_minor IS NULL OR p_requested_discount_minor < 0 THEN
    RAISE EXCEPTION 'inventory.payload_invalid: a discount request is a non-negative amount in minor units (OD-P4-02)' USING ERRCODE = 'P0001';
  END IF;
  v_revise := false;

  SELECT l.till_session_id, l.line_no, l.product_id, l.variant_id, l.added_by INTO v_old
  FROM pos_cart_lines l WHERE l.business_id = v_actor.business_id AND l.id = p_line_id FOR UPDATE;
  IF FOUND THEN
    IF v_old.till_session_id <> p_session_id OR v_old.line_no <> p_line_no
       OR v_old.product_id <> p_product_id OR v_old.variant_id <> p_variant_id THEN
      RAISE EXCEPTION 'pos.cart_line_conflict: this cart line id already names a different line' USING ERRCODE = 'P0001';
    END IF;
    IF v_old.added_by <> v_actor.actor_user_id THEN
      RAISE EXCEPTION 'pos.till_session_not_yours: a cart line belongs to the user whose session it is on (OD-P4-09)' USING ERRCODE = 'P0001';
    END IF;
    UPDATE pos_cart_lines l
       SET quantity = p_quantity, requested_discount_minor = p_requested_discount_minor
     WHERE l.business_id = v_actor.business_id AND l.id = p_line_id;
    v_revise := true;
  ELSE
    -- `added_by` is the ASSERTION's actor and nothing else, which is what
    -- makes `pos_cart_lines_session_actor_fk` the enforcer of OD-P4-09: on a
    -- session that is not this user's, the parent tuple does not exist and the
    -- INSERT has nothing to point at.
    BEGIN
      INSERT INTO pos_cart_lines (tenant_id, business_id, till_session_id, id, line_no, product_id, variant_id,
                                  quantity, requested_discount_minor, added_by)
      VALUES (v_actor.tenant_id, v_actor.business_id, p_session_id, p_line_id, p_line_no, p_product_id, p_variant_id,
              p_quantity, p_requested_discount_minor, v_actor.actor_user_id);
    EXCEPTION
      WHEN foreign_key_violation THEN
        IF position('pos_cart_lines_session_actor_fk' IN SQLERRM) > 0 THEN
          RAISE EXCEPTION 'pos.till_session_not_yours: that till session is not this authenticated user''s (OD-P4-09)' USING ERRCODE = 'P0001';
        END IF;
        RAISE;
      WHEN unique_violation THEN
        IF position('pos_cart_lines_line_uq' IN SQLERRM) > 0 THEN
          RAISE EXCEPTION 'pos.cart_line_conflict: this cart already holds a line at that ordinal' USING ERRCODE = 'P0001';
        END IF;
        RAISE;
    END;
  END IF;

  RETURN QUERY SELECT l.id, l.line_no, v_revise FROM pos_cart_lines l
   WHERE l.business_id = v_actor.business_id AND l.id = p_line_id;
END;
$$;

COMMENT ON FUNCTION pos_cart_set_line(UUID, UUID, INTEGER, UUID, UUID, NUMERIC, BIGINT) IS
  'P4-S3, P4-AL-18, OD-P4-02. The one writer of pos_cart_lines. Takes identities, a Q4 quantity and a DISCOUNT REQUEST in minor units, and NOTHING about price: there is no unit-price, line-total or tax argument, so a forged figure is unexpressible rather than rejected. added_by is the invctl/1 assertion''s actor, so pos_cart_lines_session_actor_fk — not this body — refuses a line on another user''s session (pos.till_session_not_yours). An existing line id with different identities is pos.cart_line_conflict; otherwise the quantity and the discount request are revised. EXECUTE: daftar_app only.';

-- (d) Remove a cart line. Idempotent by row count: a line already gone
--     returns 0 and raises nothing, because a till that taps "remove" twice
--     has not done anything wrong.
CREATE FUNCTION pos_cart_remove_line(p_session_id UUID, p_line_id UUID) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_actor inventory_verified_actor;
  v_rows  INTEGER;
BEGIN
  v_actor := inventory_assertion_consume('pos.cart_remove_line', inventory_claimed_payload_digest('pos.cart_remove_line',
    ARRAY['uuid', 'uuid'], ARRAY[p_session_id::text, p_line_id::text]));
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'inventory.isolation_unsupported: POS commands run only at READ COMMITTED' USING ERRCODE = 'P0001';
  END IF;
  IF p_session_id IS NULL OR p_line_id IS NULL THEN
    RAISE EXCEPTION 'inventory.payload_invalid: a removal names its session and its line' USING ERRCODE = 'P0001';
  END IF;
  -- `added_by` is in the predicate, so the removal is bounded by OD-P4-09 the
  -- same way the INSERT is: a DELETE has no foreign key to refuse it.
  DELETE FROM pos_cart_lines l
   WHERE l.business_id = v_actor.business_id AND l.till_session_id = p_session_id AND l.id = p_line_id
     AND l.added_by = v_actor.actor_user_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;

COMMENT ON FUNCTION pos_cart_remove_line(UUID, UUID) IS
  'P4-S3, OD-P4-09. Removes one line of the actor''s OWN open cart, under an invctl/1 pos.cart_remove_line assertion; added_by is in the predicate because a DELETE has no foreign key to refuse it, and pos_cart_line_guard() refuses the removal outright once the session is closed. Returns the row count, so a repeated removal is 0 and not an error. EXECUTE: daftar_app only.';

REVOKE ALL ON FUNCTION pos_till_session_open(UUID, UUID, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION pos_till_session_close(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION pos_cart_set_line(UUID, UUID, INTEGER, UUID, UUID, NUMERIC, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION pos_cart_remove_line(UUID, UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION pos_till_session_open(UUID, UUID, UUID, TEXT, TEXT) TO daftar_app;
GRANT EXECUTE ON FUNCTION pos_till_session_close(UUID) TO daftar_app;
GRANT EXECUTE ON FUNCTION pos_cart_set_line(UUID, UUID, INTEGER, UUID, UUID, NUMERIC, BIGINT) TO daftar_app;
GRANT EXECUTE ON FUNCTION pos_cart_remove_line(UUID, UUID) TO daftar_app;

-- The handover, last (R-P4-S3-04), and the bracket closed immediately after.
ALTER FUNCTION pos_till_session_guard() OWNER TO daftar_inventory_internal;
ALTER FUNCTION pos_cart_line_guard() OWNER TO daftar_inventory_internal;
ALTER FUNCTION pos_till_session_open(UUID, UUID, UUID, TEXT, TEXT) OWNER TO daftar_inventory_internal;
ALTER FUNCTION pos_till_session_close(UUID) OWNER TO daftar_inventory_internal;
ALTER FUNCTION pos_cart_set_line(UUID, UUID, INTEGER, UUID, UUID, NUMERIC, BIGINT) OWNER TO daftar_inventory_internal;
ALTER FUNCTION pos_cart_remove_line(UUID, UUID) OWNER TO daftar_inventory_internal;

REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;

-- The registration, AFTER every guard and every command above exists: an
-- `inventory_operation_kinds` row is a registration of AUTHORITY, and
-- registering one without its writer is what TL-P4-S1-R1 and TL-P4-S2-K1
-- refused. There is NO `inventory_operation_movement_kinds` row and no
-- `stock_movement_kinds` row: a till session and a basket move no stock, which
-- is the accepted shape of `supplier.create` and `inventory.stocktake_open`
-- (`0064:1500`, `0062:1517`) — an operation kind with no movement kind.
INSERT INTO inventory_operation_kinds (op_code, registered_by) VALUES
  ('pos.session_open', 'P4-S3'), ('pos.session_close', 'P4-S3'),
  ('pos.cart_set_line', 'P4-S3'), ('pos.cart_remove_line', 'P4-S3');

-- ─────────────────────────────────────────────────────────────────────────
-- 7. 0079-E — the end state, read from the LIVE catalogues and never from this
--    file's own statements (R-P4-S3-01). Every claim is numbered so a failure
--    names itself.
-- ─────────────────────────────────────────────────────────────────────────
DO $end$
DECLARE
  c_relations CONSTANT TEXT[] := ARRAY['pos_till_sessions', 'pos_cart_lines'];
  c_ordinary  CONSTANT TEXT[] := ARRAY['business_isolation_delete', 'business_isolation_insert', 'business_isolation_read',
                                       'business_isolation_update', 'inventory_internal_read', 'tenant_membership'];
  c_runtime   CONSTANT TEXT[] := ARRAY['daftar_app', 'daftar_platform', 'daftar_worker', 'daftar_identity', 'daftar_resolver',
                                       'daftar_provisioner', 'daftar_reconciler', 'public'];
  c_dml       CONSTANT TEXT[] := ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
  c_guards    CONSTANT TEXT[] := ARRAY['pos_till_session_guard()', 'pos_cart_line_guard()'];
  c_commands  CONSTANT TEXT[] := ARRAY['pos_till_session_open(uuid,uuid,uuid,text,text)', 'pos_till_session_close(uuid)',
                                       'pos_cart_set_line(uuid,uuid,integer,uuid,uuid,numeric,bigint)',
                                       'pos_cart_remove_line(uuid,uuid)'];
  c_ops       CONSTANT TEXT[] := ARRAY['pos.cart_remove_line', 'pos.cart_set_line', 'pos.session_close', 'pos.session_open'];
  -- R-P4-02's vocabulary as TL-P4-S1-C1 fixed it, plus the DERIVED PRICE
  -- vocabulary this slice adds. The second half is the one that matters here:
  -- a cart that stores what something COSTS has adopted the client's number or
  -- cached the catalogue's, and either way a second writer can disagree with
  -- it (P4-AL-05, P4-AL-18).
  c_forbidden CONSTANT TEXT := '(^|_)(balance|outstanding|paid|unpaid|due|owed|payable|receivable|settled|refunded|collected'
                            || '|allocated|cogs|cost|reserved|available|stock)($|_)';
  c_priced    CONSTANT TEXT := '(^|_)(price|prices|unit_price|gross|net|subtotal|subtotals|total|totals|amount|amounts'
                            || '|tax|taxes|rate|rates|percent|percentage|value)($|_)';
  c_instant   CONSTANT TEXT := '_(id|ids|at|date|by|status|kind|type|code|name|currency|seq|no)$';
  v_name      TEXT;
  v_sig       TEXT;
  v_n         INTEGER;
  v_def       TEXT;
  v_actual    TEXT[];
BEGIN
  -- (1) Both relations exist as plain tables, row security is ENABLED *AND*
  --     FORCED on each, and each carries tenant_id and business_id as real
  --     NOT NULL columns. This is the law the general Phase 4 RLS/FORCE
  --     discovery enforces over the whole Phase 4 surface and which finds
  --     these two by itself; 0079 states it about its own two so a failure
  --     names this file.
  SELECT count(*) INTO v_n FROM pg_class c
   WHERE c.oid = ANY (SELECT ('public.' || x)::regclass FROM unnest(c_relations) x)
     AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-E(1): row security is not enabled and forced on both P4-S3 relations (found %)', v_n
      USING ERRCODE = 'P0001';
  END IF;
  FOREACH v_name IN ARRAY c_relations LOOP
    IF (SELECT count(*) FROM pg_attribute a
         WHERE a.attrelid = ('public.' || v_name)::regclass AND a.attnum > 0 AND NOT a.attisdropped
           AND a.attname IN ('tenant_id', 'business_id') AND a.attnotnull) <> 2 THEN
      RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-E(1): % does not carry tenant_id and business_id as NOT NULL columns', v_name
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- (2) The policy sets, by NAME and not by count: SIX on each, because
  --     neither is an accounting-source relation (P4-AL-38 as corrected by
  --     TL-P4-S1-C2). The tenant policy is the DIRECT form. The restrictive
  --     read names the inventory principal and NOT the accounting one, and
  --     `daftar_accounting_internal` holds no privilege on either relation —
  --     all three halves, because a slice that creates no accounting object
  --     must not leave an accounting principal a seam, and a policy without
  --     the grant or a grant without the policy each look harmless alone.
  FOREACH v_name IN ARRAY c_relations LOOP
    SELECT array_agg(p.polname::text ORDER BY p.polname) INTO v_actual
      FROM pg_policy p WHERE p.polrelid = ('public.' || v_name)::regclass;
    IF v_actual IS DISTINCT FROM c_ordinary THEN
      RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-E(2): % does not carry exactly the six ordinary policies (found %)', v_name, v_actual
        USING ERRCODE = 'P0001';
    END IF;
    IF (SELECT pg_get_expr(p.polqual, p.polrelid) FROM pg_policy p
         WHERE p.polrelid = ('public.' || v_name)::regclass AND p.polname = 'tenant_membership')
       NOT LIKE '%tenant_id = (NULLIF(app_tenant()%' THEN
      RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-E(2): %''s tenant policy is not the direct form 0052 measured', v_name
        USING ERRCODE = 'P0001';
    END IF;
    v_def := (SELECT pg_get_expr(p.polqual, p.polrelid) FROM pg_policy p
               WHERE p.polrelid = ('public.' || v_name)::regclass AND p.polname = 'business_isolation_read');
    IF v_def NOT LIKE '%daftar_inventory_internal%' THEN
      RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-E(2): %''s restrictive read shuts out the principal its own guards run as, so every guard would read zero rows and pass vacuously', v_name
        USING ERRCODE = 'P0001';
    END IF;
    IF v_def LIKE '%daftar_accounting_internal%' THEN
      RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-E(2): %''s restrictive read admits the accounting principal, and P4-S3 creates no accounting object', v_name
        USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) x
                WHERE c.oid = ('public.' || v_name)::regclass AND x.grantee::regrole::text = 'daftar_accounting_internal') THEN
      RAISE EXCEPTION 'pos.authority_leak: 0079-E(2): daftar_accounting_internal holds a privilege on %, and P4-S3 creates no accounting object', v_name
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- (3) NO STORED DERIVED TRUTH AND NO STORED PRICE, over the LIVE column
  --     list (P4-AL-05, P4-AL-06, P4-AL-18, OD-P4-02). The derived-truth
  --     vocabulary is the one the estate's guard already carries; the PRICE
  --     vocabulary is this slice's, and it is what makes the cart's design
  --     mechanical: a later hand adding `unit_price_txn_minor` to save a
  --     catalogue lookup turns this file's own end state red.
  --
  --     And the only money column in the slice is the DISCOUNT REQUEST, it is
  --     a BIGINT, and nothing here is a float (P4-AL-15b). No tax column of
  --     any kind exists, which is the strongest reading of OD-03 BEING OPEN.
  FOREACH v_name IN ARRAY c_relations LOOP
    IF EXISTS (SELECT 1 FROM pg_attribute a
                WHERE a.attrelid = ('public.' || v_name)::regclass AND a.attnum > 0 AND NOT a.attisdropped
                  AND a.attname ~ c_forbidden AND a.attname !~ c_instant) THEN
      RAISE EXCEPTION 'pos.derived_truth_stored: 0079-E(3): % carries % — a column of the vocabulary P4-AL-05/06 refuses', v_name,
        (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = ('public.' || v_name)::regclass AND a.attnum > 0
           AND NOT a.attisdropped AND a.attname ~ c_forbidden AND a.attname !~ c_instant LIMIT 1)
        USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_attribute a
                WHERE a.attrelid = ('public.' || v_name)::regclass AND a.attnum > 0 AND NOT a.attisdropped
                  AND a.attname ~ c_priced AND a.attname !~ c_instant) THEN
      RAISE EXCEPTION 'pos.derived_truth_stored: 0079-E(3): % carries % — the cart holds identities, a quantity and a DISCOUNT REQUEST, and everything about price is derived (P4-AL-18)', v_name,
        (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = ('public.' || v_name)::regclass AND a.attnum > 0
           AND NOT a.attisdropped AND a.attname ~ c_priced AND a.attname !~ c_instant LIMIT 1)
        USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_attribute a
                WHERE a.attrelid = ('public.' || v_name)::regclass AND a.attnum > 0 AND NOT a.attisdropped
                  AND format_type(a.atttypid, NULL) IN ('real', 'double precision', 'money')) THEN
      RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-E(3): % carries a floating point or money column (P4-AL-15b)', v_name
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  SELECT array_agg(c.relname || '.' || a.attname || ':' || format_type(a.atttypid, NULL) ORDER BY 1) INTO v_actual
    FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
   WHERE c.oid = ANY (SELECT ('public.' || x)::regclass FROM unnest(c_relations) x)
     AND a.attnum > 0 AND NOT a.attisdropped AND a.attname LIKE '%_minor';
  IF v_actual IS DISTINCT FROM ARRAY['pos_cart_lines.requested_discount_minor:bigint'] THEN
    RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-E(3): the slice''s minor-unit columns are % and not the one discount REQUEST (OD-P4-02 is DISCOUNT ONLY)', v_actual
      USING ERRCODE = 'P0001';
  END IF;

  -- (4) OD-P4-09 IN THE DATABASE, read from the catalogue (R-P4-S3-02).
  --     Four claims, and each is the mechanism and not a description of it.
  --
  --     (a) the candidate key the actor edge points at.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                  WHERE c.conname = 'pos_till_sessions_actor_uq' AND c.conrelid = 'public.pos_till_sessions'::regclass
                    AND c.contype = 'u'
                    AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
                           FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
                        = ARRAY['business_id', 'id', 'opened_by']) THEN
    RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-E(4a): pos_till_sessions carries no (business_id, id, opened_by) candidate key, so OD-P4-09''s actor edge is not expressible'
      USING ERRCODE = 'P0001';
  END IF;
  --     (b) THE RULING ITSELF: a cart line's actor IS the session's user,
  --         because the foreign key says so. Both column lists in order, the
  --         target relation, VALIDATED, and RESTRICT on update as well as on
  --         delete — the update half is what stops the session's user being
  --         swapped out from under an existing basket.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                  WHERE c.conname = 'pos_cart_lines_session_actor_fk' AND c.conrelid = 'public.pos_cart_lines'::regclass
                    AND c.contype = 'f' AND c.convalidated
                    AND c.confrelid = 'public.pos_till_sessions'::regclass
                    AND c.confupdtype = 'r' AND c.confdeltype = 'r'
                    AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
                           FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
                        = ARRAY['business_id', 'till_session_id', 'added_by']
                    AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
                           FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
                           JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum)
                        = ARRAY['business_id', 'id', 'opened_by']) THEN
    RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-E(4b): pos_cart_lines does not bind (business_id, till_session_id, added_by) to pos_till_sessions (business_id, id, opened_by) as a validated RESTRICT/RESTRICT edge — OD-P4-09 would then be a service convention and the trusted generic primitive could still write the row'
      USING ERRCODE = 'P0001';
  END IF;
  --     (c) one open session per authenticated user, as a PARTIAL unique
  --         index — predicate and column list both read from the definition,
  --         because an index on the same columns without the predicate is a
  --         different and much stronger claim, and one WITHOUT a predicate at
  --         all would forbid a second shift ever.
  v_def := (SELECT pg_get_indexdef(i.indexrelid) FROM pg_index i
             WHERE i.indrelid = 'public.pos_till_sessions'::regclass
               AND i.indexrelid = 'public.pos_till_sessions_one_open_per_user_uq'::regclass);
  IF v_def IS NULL OR v_def NOT LIKE '%UNIQUE INDEX%(business_id, opened_by)%'
     OR v_def NOT LIKE '%WHERE (status = ''open''::text)%' THEN
    RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-E(4c): pos_till_sessions_one_open_per_user_uq is not the partial unique index on (business_id, opened_by) WHERE status = ''open'' (found %)', coalesce(v_def, '<absent>')
      USING ERRCODE = 'P0001';
  END IF;
  --     (d) one open session per physical till, which is the other half of
  --         the ruling's own risk sentence about the cash drawer's owner.
  v_def := (SELECT pg_get_indexdef(i.indexrelid) FROM pg_index i
             WHERE i.indrelid = 'public.pos_till_sessions'::regclass
               AND i.indexrelid = 'public.pos_till_sessions_one_open_per_terminal_uq'::regclass);
  IF v_def IS NULL OR v_def NOT LIKE '%UNIQUE INDEX%(business_id, branch_id, terminal_code)%'
     OR v_def NOT LIKE '%WHERE (status = ''open''::text)%' THEN
    RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-E(4d): pos_till_sessions_one_open_per_terminal_uq is not the partial unique index one drawer owes (found %)', coalesce(v_def, '<absent>')
      USING ERRCODE = 'P0001';
  END IF;
  --     (e) and the case the foreign key cannot reach — an empty basket's
  --         session — is refused by the guard, read from the BODY the
  --         database holds rather than from the text above.
  SELECT regexp_replace(p.prosrc, '--[^\n]*', '', 'g') INTO v_def
    FROM pg_proc p WHERE p.oid = 'public.pos_till_session_guard()'::regprocedure;
  IF position('NEW.opened_by IS DISTINCT FROM OLD.opened_by' IN v_def) = 0
     OR position('pos.till_session_actor_immutable' IN v_def) = 0 THEN
    RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-E(4e): the live pos_till_session_guard() body does not refuse a change of opened_by, so a shift could change hands in the one window the foreign key cannot see'
      USING ERRCODE = 'P0001';
  END IF;

  -- (5) NO ACCOUNTING OBJECT AT ALL — this slice's migration row, verbatim,
  --     asserted from the catalogue in six independent ways, because "we
  --     didn't add one" is exactly the kind of claim that is true of the file
  --     and false of the database.
  -- `accounting_source_types` carries NO `registered_by` column (its shape is
  -- `source_type`, the two bound policies, a description and a sort order), so
  -- this half cannot be a per-slice attribution the way the inventory
  -- registries are — measured, not assumed. It is stated over the VOCABULARY
  -- of this slice's surface instead, which is P4-AL-88-safe: a later slice
  -- registering `payment` or `credit_note` does not turn it red, and the one
  -- thing it forbids is the only thing 0079 could have added.
  IF EXISTS (SELECT 1 FROM accounting_source_types t WHERE t.source_type ~ '^(pos|till|cart)') THEN
    RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-E(5): an accounting source type of the POS vocabulary exists, and P4-S3 creates no accounting object'
      USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM accounting_operation_kinds k WHERE k.source_type ~ '^(pos|till|cart)') THEN
    RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-E(5): an accounting operation kind of the POS vocabulary exists, and P4-S3 creates no accounting object'
      USING ERRCODE = 'P0001';
  END IF;
  -- And the accounting principal is a stranger to this slice from BOTH sides:
  -- it owns none of these routines and may execute none of them. A read grant
  -- was already refused at 0079-E(2).
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
              JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname LIKE 'pos_%' AND r.rolname = 'daftar_accounting_internal') THEN
    RAISE EXCEPTION 'pos.authority_leak: 0079-E(5): a POS routine is owned by the accounting principal' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
                  aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
              WHERE n.nspname = 'public' AND p.proname LIKE 'pos_%'
                AND x.grantee::regrole::text = 'daftar_accounting_internal') THEN
    RAISE EXCEPTION 'pos.authority_leak: 0079-E(5): the accounting principal may execute a POS routine' USING ERRCODE = 'P0001';
  END IF;
  FOREACH v_name IN ARRAY c_relations LOOP
    IF EXISTS (SELECT 1 FROM pg_attribute a
                WHERE a.attrelid = ('public.' || v_name)::regclass AND a.attnum > 0 AND NOT a.attisdropped
                  AND a.attname IN ('accounting_source_type', 'binding_source_id', 'journal_entry_id')) THEN
      RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-E(5): % carries an accounting binding column', v_name USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint c
                WHERE c.conrelid = ('public.' || v_name)::regclass AND c.contype = 'f'
                  AND c.confrelid IN ('public.accounting_source_bindings'::regclass, 'public.journal_entries'::regclass,
                                      'public.journal_lines'::regclass, 'public.accounts'::regclass)) THEN
      RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-E(5): % carries a foreign key into the accounting estate', v_name USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  -- No trigger of this slice reached `journal_entries`: the two relations'
  -- names appear in no trigger function installed on it.
  IF EXISTS (SELECT 1 FROM pg_trigger g JOIN pg_proc p ON p.oid = g.tgfoid
              WHERE g.tgrelid = 'public.journal_entries'::regclass AND NOT g.tgisinternal
                AND (p.proname LIKE 'pos_%' OR p.prosrc LIKE '%pos_till_sessions%' OR p.prosrc LIKE '%pos_cart_lines%')) THEN
    RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-E(5): a P4-S3 routine is installed on journal_entries' USING ERRCODE = 'P0001';
  END IF;
  -- And no command body touches the ledger: `accounting_post_entry` is the one
  -- writer and P4-S3 does not call it either.
  FOREACH v_sig IN ARRAY c_commands LOOP
    SELECT regexp_replace(p.prosrc, '--[^\n]*', '', 'g') INTO v_def
      FROM pg_proc p WHERE p.oid = ('public.' || v_sig)::regprocedure;
    IF v_def ~* '\m(journal_entries|journal_lines|accounting_source_bindings|accounting_post_entry|stock_movements|stock_levels|sales|sale_items|invoices)\M' THEN
      RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-E(5): the live body of % names an accounting or stock relation, and a cart posts nothing and moves nothing', v_sig
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- (6) The privileges, read from the catalogue and not from the GRANTs above
  --     — a GRANT without grant option WARNS and COMMITS, so the statement
  --     having run is not evidence that the privilege is held
  --     ([[daftar-grant-before-owner]]).
  --
  --     `daftar_app` holds SELECT and nothing else; no runtime principal and
  --     not PUBLIC holds DML at table level or ANY privilege at column level;
  --     the internal writer's UPDATE is COLUMN-LEVEL on exactly the named
  --     columns and there is no table-level UPDATE behind it; nobody at all
  --     may DELETE a till session.
  FOREACH v_name IN ARRAY c_relations LOOP
    IF NOT has_table_privilege('daftar_app', 'public.' || v_name, 'SELECT') THEN
      RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-E(6): daftar_app cannot read %', v_name USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) x
                WHERE c.oid = ('public.' || v_name)::regclass
                  AND x.grantee::regrole::text = ANY (c_runtime) AND x.privilege_type = ANY (c_dml)) THEN
      RAISE EXCEPTION 'pos.authority_leak: 0079-E(6): a runtime principal holds DML on % — P4-AL-38 gives daftar_app no DML on any Phase 4 table', v_name
        USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_attribute a, aclexplode(a.attacl) x
                WHERE a.attrelid = ('public.' || v_name)::regclass AND a.attnum > 0 AND NOT a.attisdropped
                  AND x.grantee::regrole::text = ANY (c_runtime)) THEN
      RAISE EXCEPTION 'pos.authority_leak: 0079-E(6): a runtime principal holds a column privilege on %', v_name USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) x
                WHERE c.oid = ('public.' || v_name)::regclass
                  AND x.grantee::regrole::text = 'daftar_inventory_internal' AND x.privilege_type = 'UPDATE') THEN
      RAISE EXCEPTION 'pos.authority_leak: 0079-E(6): the internal writer holds TABLE-level UPDATE on %, which is authority to write a column the lifecycle guard happens not to name', v_name
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  SELECT array_agg(a.attname::text ORDER BY a.attname) INTO v_actual
    FROM pg_attribute a, aclexplode(a.attacl) x
   WHERE a.attrelid = 'public.pos_till_sessions'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND x.grantee::regrole::text = 'daftar_inventory_internal' AND x.privilege_type = 'UPDATE';
  IF v_actual IS DISTINCT FROM ARRAY['business_transaction_id', 'close_intent_sha256', 'closed_at', 'status'] THEN
    RAISE EXCEPTION 'pos.authority_leak: 0079-E(6): the session''s writable columns are % and not the four closing columns — in particular opened_by must not be among them (OD-P4-09)', v_actual
      USING ERRCODE = 'P0001';
  END IF;
  SELECT array_agg(a.attname::text ORDER BY a.attname) INTO v_actual
    FROM pg_attribute a, aclexplode(a.attacl) x
   WHERE a.attrelid = 'public.pos_cart_lines'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND x.grantee::regrole::text = 'daftar_inventory_internal' AND x.privilege_type = 'UPDATE';
  IF v_actual IS DISTINCT FROM ARRAY['quantity', 'requested_discount_minor'] THEN
    RAISE EXCEPTION 'pos.authority_leak: 0079-E(6): a cart line''s writable columns are % and not the quantity and the discount request alone (OD-P4-09: added_by is not revisable)', v_actual
      USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) x
              WHERE c.oid = 'public.pos_till_sessions'::regclass AND x.privilege_type = 'DELETE'
                AND x.grantee <> c.relowner) THEN
    RAISE EXCEPTION 'pos.authority_leak: 0079-E(6): somebody may DELETE a till session, and a shift is history the moment it opens' USING ERRCODE = 'P0001';
  END IF;

  -- (7) The two guards: internal DEFINER, owned by daftar_inventory_internal,
  --     pinned path, and NO grantee but the owner. EXECUTE is reachability,
  --     not authority ([[daftar-execute-is-reachability-not-authority]]) — a
  --     trigger function needs none at all. And both are installed as the row
  --     triggers they are, on the relations they are for: tgtype 31 is
  --     ROW|BEFORE|INSERT|DELETE|UPDATE (1|2|4|8|16).
  FOREACH v_sig IN ARRAY c_guards LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                    WHERE p.oid = ('public.' || v_sig)::regprocedure
                      AND r.rolname = 'daftar_inventory_internal' AND p.prosecdef
                      AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp'])
       OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
                   WHERE p.oid = ('public.' || v_sig)::regprocedure AND x.grantee <> p.proowner) THEN
      RAISE EXCEPTION 'pos.authority_leak: 0079-E(7): % is not the inventory principal''s pinned DEFINER with no grantee', v_sig USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                  WHERE g.tgrelid = 'public.pos_till_sessions'::regclass AND g.tgname = 'pos_till_sessions_lifecycle'
                    AND NOT g.tgisinternal AND g.tgtype = 31 AND g.tgenabled IN ('O', 'A')
                    AND g.tgfoid = 'public.pos_till_session_guard()'::regprocedure)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger g
                     WHERE g.tgrelid = 'public.pos_cart_lines'::regclass AND g.tgname = 'pos_cart_lines_session_open'
                       AND NOT g.tgisinternal AND g.tgtype = 31 AND g.tgenabled IN ('O', 'A')
                       AND g.tgfoid = 'public.pos_cart_line_guard()'::regprocedure) THEN
    RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-E(7): a lifecycle guard is not installed as an enabled BEFORE INSERT OR UPDATE OR DELETE row trigger on its own relation'
      USING ERRCODE = 'P0001';
  END IF;
  -- The cart guard takes the lock that makes it real, and not a bare SELECT:
  -- the foreign key's FOR KEY SHARE does not conflict with the close's FOR NO
  -- KEY UPDATE, so without this the basket of a closing shift could still grow.
  SELECT regexp_replace(p.prosrc, '--[^\n]*', '', 'g') INTO v_def
    FROM pg_proc p WHERE p.oid = 'public.pos_cart_line_guard()'::regprocedure;
  IF position('FOR NO KEY UPDATE' IN v_def) = 0 OR position('pos.till_session_not_open' IN v_def) = 0 THEN
    RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-E(7): the live pos_cart_line_guard() body does not lock its session row, so a line can be added to a session being closed concurrently'
      USING ERRCODE = 'P0001';
  END IF;

  -- (8) The four commands: pinned DEFINER owned by the inventory principal,
  --     no DEFAULT on any argument, EXECUTE held by daftar_app and by NOBODY
  --     else, and the assertion consume as the FIRST executable statement, so
  --     no relation is read before the caller's authority is decided (the
  --     0078-E(11) claim, re-stated per command and read from `prosrc`).
  FOREACH v_sig IN ARRAY c_commands LOOP
    IF to_regprocedure('public.' || v_sig) IS NULL THEN
      RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-E(8): % is not in the catalogue', v_sig USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                    WHERE p.oid = ('public.' || v_sig)::regprocedure
                      AND r.rolname = 'daftar_inventory_internal' AND p.prosecdef
                      AND p.pronargdefaults = 0
                      AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']) THEN
      RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-E(8): % is not a pinned-path, default-free SECURITY DEFINER owned by daftar_inventory_internal', v_sig
        USING ERRCODE = 'P0001';
    END IF;
    IF NOT has_function_privilege('daftar_app', ('public.' || v_sig)::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-E(8): daftar_app cannot execute %', v_sig USING ERRCODE = 'P0001';
    END IF;
    SELECT array_agg(x.grantee::regrole::text ORDER BY 1) INTO v_actual
      FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
     WHERE p.oid = ('public.' || v_sig)::regprocedure AND x.privilege_type = 'EXECUTE' AND x.grantee <> p.proowner;
    IF v_actual IS DISTINCT FROM ARRAY['daftar_app'] THEN
      RAISE EXCEPTION 'pos.authority_leak: 0079-E(8): EXECUTE on % is held by % and not by daftar_app alone — reachability is authority', v_sig, v_actual
        USING ERRCODE = 'P0001';
    END IF;
    SELECT p.prosrc INTO v_def FROM pg_proc p WHERE p.oid = ('public.' || v_sig)::regprocedure;
    IF (SELECT x.line FROM unnest(string_to_array(substring(v_def FROM position('BEGIN' IN v_def)), E'\n')) AS x(line)
         WHERE btrim(x.line) <> '' AND btrim(x.line) NOT LIKE '--%' AND btrim(x.line) <> 'BEGIN'
         LIMIT 1) NOT LIKE '%inventory_assertion_consume%' THEN
      RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-E(8): the first statement of % is not the assertion consume, so something is read before the caller''s authority is decided', v_sig
        USING ERRCODE = 'P0001';
    END IF;
    -- No command builds SQL at run time (the G-7 contract) and none defaults a
    -- date from the clock (P4-AL-30 — there is no date argument here at all,
    -- which is the stronger form).
    IF v_def ~* '\mEXECUTE\s+(format|''|")' THEN
      RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-E(8): % builds SQL at run time, which an elevated routine may not do', v_sig
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  -- And the actor of every write is the ASSERTION's, never an argument: no
  -- command takes a user-id argument, and each one's writes name
  -- `v_actor.actor_user_id`. This is what makes OD-P4-09's actor a signed fact.
  FOREACH v_sig IN ARRAY c_commands LOOP
    SELECT pg_get_function_arguments(p.oid) INTO v_def
      FROM pg_proc p WHERE p.oid = ('public.' || v_sig)::regprocedure;
    IF v_def ~* '(user|actor|cashier|opened_by|added_by)' THEN
      RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-E(8): % takes an actor as an ARGUMENT (%), and the actor is the verified assertion''s (OD-P4-09, P4-AL-39)', v_sig, v_def
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- (9) The registry, as an equality over the P4-S3-REGISTERED SUBSET and
  --     never as a count over the whole registry (P4-AL-88): exactly the four
  --     POS operation kinds, each with a writer in this file, and NO movement
  --     kind, NO stock source type and NO op→kind row, because a till session
  --     and a basket move no stock.
  SELECT array_agg(k.op_code::text ORDER BY k.op_code) INTO v_actual
    FROM inventory_operation_kinds k WHERE k.registered_by = 'P4-S3';
  IF v_actual IS DISTINCT FROM c_ops THEN
    RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-E(9): P4-S3 registers % and not the four POS operation kinds', v_actual USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM stock_movement_kinds k WHERE k.registered_by = 'P4-S3')
     OR EXISTS (SELECT 1 FROM stock_source_types t WHERE t.registered_by = 'P4-S3')
     OR EXISTS (SELECT 1 FROM inventory_operation_movement_kinds m WHERE m.registered_by = 'P4-S3') THEN
    RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-E(9): P4-S3 registered a stock movement kind, a stock source type or an op-to-kind row, and a cart moves no stock'
      USING ERRCODE = 'P0001';
  END IF;

  -- (10) The frozen neighbours are untouched: `inventory_apply_stock_movements`
  --      is still exactly one routine owned by the inventory principal and
  --      still refuses an oversell under the key lock (OD-P4-05), and the
  --      stock-source discovery still reports no gap. A slice that needs
  --      neither must leave both exactly as it found them (P4-AL-29).
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'inventory_apply_stock_movements';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-E(10): inventory_apply_stock_movements is not exactly one routine (found %)', v_n USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                  JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'inventory_apply_stock_movements'
                    AND r.rolname = 'daftar_inventory_internal' AND p.prosrc LIKE '%inventory.insufficient_stock%') THEN
    RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-E(10): the stock writer changed owner or no longer refuses an oversell (OD-P4-05)' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM inventory_stock_source_guard_gaps()) THEN
    RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-E(10): inventory_stock_source_guard_gaps() reports a gap after 0079' USING ERRCODE = 'P0001';
  END IF;

  -- (11) Both relations are EMPTY: this file created a writer, not a row
  --      (the 0078-E(8) claim).
  IF EXISTS (SELECT 1 FROM pos_till_sessions) OR EXISTS (SELECT 1 FROM pos_cart_lines) THEN
    RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-E(11): 0079 wrote a till session or a cart line, and a migration is not a writer' USING ERRCODE = 'P0001';
  END IF;

  -- (12) The ownership-transfer authority was handed back, and no fifth
  --      principal appeared (TL-P4-S1-C17, R-P4-S3-06).
  IF has_schema_privilege('daftar_inventory_internal', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'pos.authority_leak: 0079-E(12): daftar_inventory_internal still holds CREATE ON SCHEMA public' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = 'daftar_sales_internal') THEN
    RAISE EXCEPTION 'pos.authority_leak: 0079-E(12): daftar_sales_internal exists, which TL-P4-S1-C17 refused' USING ERRCODE = 'P0001';
  END IF;

  -- (13) Every edge between two commercial rows carries the business
  --      (P4-AL-09), read from the catalogue: each foreign key of either
  --      relation whose TARGET is a business-scoped relation names
  --      `business_id` in its own column list. `users` and `currencies` are
  --      global relations and are the two exemptions — stated as a PROPERTY
  --      of the target (its primary key does not contain `business_id`)
  --      rather than as two names, so a later edge to a third global relation
  --      is judged by the same rule.
  FOR v_name, v_def IN
    SELECT c.conname::text, cl.relname::text
      FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.confrelid
     WHERE c.conrelid = ANY (SELECT ('public.' || x)::regclass FROM unnest(c_relations) x)
       AND c.contype = 'f'
  LOOP
    IF EXISTS (SELECT 1 FROM pg_constraint pk
                CROSS JOIN LATERAL unnest(pk.conkey) AS k(attnum)
                JOIN pg_attribute a ON a.attrelid = pk.conrelid AND a.attnum = k.attnum
               WHERE pk.conrelid = ('public.' || v_def)::regclass AND pk.contype = 'p' AND a.attname = 'business_id')
       AND NOT EXISTS (SELECT 1 FROM pg_constraint c2
                        CROSS JOIN LATERAL unnest(c2.conkey) AS k(attnum)
                        JOIN pg_attribute a ON a.attrelid = c2.conrelid AND a.attnum = k.attnum
                       WHERE c2.conname = v_name AND a.attname = 'business_id') THEN
      RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-E(13): % points at the business-scoped % without naming business_id, so a cross-business edge is representable (P4-AL-09)', v_name, v_def
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
END
$end$;

-- ─────────────────────────────────────────────────────────────────────────
-- 8. 0079-P — the performed proofs (the `0074:150-300` / `0077` three-block
--    pattern): a claim read from the catalogue is a claim about SHAPE, and a
--    shape can be right while the behaviour is wrong. Each block below
--    PERFORMS the refusal inside a subtransaction and rolls it back, and each
--    handler reads the SQLSTATE or the SQLERRM, so a probe that trips a
--    DIFFERENT refusal is reported as a DEFECTIVE PROBE and never as a proof.
--
--    THREE, AND WHY NOT MORE. A migration must not create a business, a
--    branch, a warehouse and two users to prove something — `0077` states the
--    same limit for the same reason — and every refusal that needs two
--    committed rows needs exactly that fixture. So the probes here are the
--    ones reachable with invented identifiers, which is precisely the set
--    whose refusal fires BEFORE the foreign keys: a BEFORE ROW trigger, and
--    the row security policy, both of which are evaluated before any AFTER
--    trigger. The refusals that need a fixture are OWED, named, and recorded
--    in docs/PHASE_4_S3_MIGRATION_DESIGN.md §8 as the slice's test estate's:
--    the second open session for one user, the second open session on one
--    terminal, the cart line on another user's session, the reassignment of
--    `opened_by`, and the write to a closed shift's basket. Owed and written
--    down beats absent and unmentioned.
-- ─────────────────────────────────────────────────────────────────────────
DO $proof$
DECLARE
  v_msg      TEXT;
  v_tenant   UUID := gen_random_uuid();
  v_business UUID := gen_random_uuid();
BEGIN
  -- (a) A till session is never INSERTed already closed. The lifecycle guard
  --     is a BEFORE ROW trigger, so it decides before `pos_till_sessions_state_ck`
  --     and before any foreign key: no fixture row is needed and none is made.
  BEGIN
    INSERT INTO pos_till_sessions (tenant_id, business_id, id, branch_id, warehouse_id, terminal_code, currency_code,
                                   status, opened_by, closed_at, open_intent_sha256, close_intent_sha256,
                                   business_transaction_id)
      VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'till_a', 'USD',
              'closed', gen_random_uuid(), now(), repeat('a', 64), repeat('b', 64), gen_random_uuid());
    RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-P(a): a till session was INSERTed already closed' USING ERRCODE = 'P0001';
  EXCEPTION
    WHEN OTHERS THEN
      v_msg := SQLERRM;
      IF position('pos.till_session_lifecycle_invalid' IN v_msg) = 0 THEN
        RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-P(a) is a DEFECTIVE PROBE — it tripped % instead of the lifecycle guard', v_msg
          USING ERRCODE = 'P0001';
      END IF;
  END;

  -- (b) A cart line is never written outside an OPEN till session. With no
  --     session in the catalogue at all, the guard's own `SELECT … FOR NO KEY
  --     UPDATE` finds nothing — which is the NOT FOUND arm, and it is the arm
  --     a reader would most easily leave out, so it is the one performed.
  BEGIN
    INSERT INTO pos_cart_lines (tenant_id, business_id, till_session_id, id, line_no, product_id, variant_id,
                                quantity, requested_discount_minor, added_by)
      VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1,
              gen_random_uuid(), gen_random_uuid(), 1.0000, 0, gen_random_uuid());
    RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-P(b): a cart line was written with no open till session' USING ERRCODE = 'P0001';
  EXCEPTION
    WHEN OTHERS THEN
      v_msg := SQLERRM;
      IF position('pos.till_session_not_open' IN v_msg) = 0 THEN
        RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-P(b) is a DEFECTIVE PROBE — it tripped % instead of the open-session guard', v_msg
          USING ERRCODE = 'P0001';
      END IF;
  END;

  -- (c) A TILL NAME NO MINTER COULD HAVE SIGNED IS REFUSED BY THE DATABASE.
  --
  --     `terminal_code` is an ARGUMENT of `pos_till_session_open` and it is
  --     hashed into the `invpl/1` payload as a `code` field, whose grammar is
  --     `^[a-z][a-z0-9_]{0,31}$` (`0054:206`). A till name outside that grammar
  --     is a name the canonicalizer refuses, so an assertion covering it
  --     cannot exist — and the column therefore carries the same grammar, so
  --     the state is unreachable from either direction rather than merely
  --     unreachable through the routine.
  --
  --     This probe needs the row to REACH its CHECK constraints, and
  --     PostgreSQL evaluates the INSERT policies' WITH CHECK before them. It is
  --     satisfied the only way that widens nothing — the `0077` idiom: the
  --     probe STATES a tenant and a business context and inserts a row in it.
  --
  --     ── AND WHY THERE IS NO PERFORMED RLS PROOF IN THIS FILE ────────────
  --
  --     The obvious probe — insert a FOREIGN tenant's row and require
  --     `42501` — was written, run, and REMOVED, because its verdict depends
  --     on WHO IS MIGRATING. `scripts/db-from-zero.ts:67` migrates as
  --     `postgres`, a SUPERUSER, and a superuser bypasses row security
  --     altogether; a deployment migrates as the non-superuser
  --     `daftar_migrator`, where FORCE ROW LEVEL SECURITY does apply to the
  --     owner. Measured: under the superuser the foreign-tenant row sailed
  --     past every policy and was stopped by `pos_till_sessions_opened_by_fkey`
  --     instead, and the probe correctly reported ITSELF defective. A proof
  --     that passes or fails by the migrating principal is not a proof, and
  --     `tests/integration/migration-portability.test.ts` exists because this
  --     file must behave identically for both. So ENABLE and FORCE stay a
  --     CATALOGUE claim here (0079-E(1)) — which is also all `0077` claimed —
  --     and the BEHAVIOURAL refusal is owed by the slice's security suite,
  --     which runs as `daftar_app` and can therefore mean it
  --     (docs/PHASE_4_S3_MIGRATION_DESIGN.md §8).
  PERFORM set_config('app.tenant_id', v_tenant::text, true);
  PERFORM set_config('app.business_id', v_business::text, true);
  BEGIN
    INSERT INTO pos_till_sessions (tenant_id, business_id, id, branch_id, warehouse_id, terminal_code, currency_code,
                                   status, opened_by, open_intent_sha256, business_transaction_id)
      VALUES (v_tenant, v_business, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'Till #1', 'USD',
              'open', gen_random_uuid(), repeat('a', 64), gen_random_uuid());
    RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-P(c): a till name outside the invpl/1 code grammar was accepted, so a session could exist that no assertion can cover'
      USING ERRCODE = 'P0001';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS v_msg = CONSTRAINT_NAME;
      IF v_msg IS DISTINCT FROM 'pos_till_sessions_terminal_code_ck' THEN
        RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-P(c) is a DEFECTIVE PROBE — it tripped % instead of pos_till_sessions_terminal_code_ck', v_msg
          USING ERRCODE = 'P0001';
      END IF;
    WHEN OTHERS THEN
      RAISE EXCEPTION 'pos.migration_end_state_invalid: 0079-P(c) is a DEFECTIVE PROBE — it tripped % (%)', SQLSTATE, SQLERRM
        USING ERRCODE = 'P0001';
  END;
  PERFORM set_config('app.tenant_id', '', true);
  PERFORM set_config('app.business_id', '', true);
END
$proof$;
