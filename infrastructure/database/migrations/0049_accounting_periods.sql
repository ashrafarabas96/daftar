-- 0049_accounting_periods.sql
-- P2-S6 — accounting periods, and the refusal that makes a close mean
-- something (directive §8-§45). CANDIDATE: not frozen, not in the manifest.
--
-- Everything before this file could be posted at any time, to any date not in
-- the future. A merchant who had finished a month, filed it and moved on had
-- no way to say so, and nothing in the database would have stopped a late
-- entry from landing inside the month they had already reported.
--
-- This migration gives them that sentence, and gives the database the power
-- to keep it.
--
-- ── What a period IS here (§9, §11) ──────────────────────────────────────
--
-- A period row is a stated, finite span of civil dates belonging to ONE
-- business, in exactly one of two states: `open` or `closed`. It is not a
-- fiscal calendar, not a year, not a quarter and not a month — it is whatever
-- range the merchant created, and DAFTAR has no opinion about which.
--
-- ── THE ACTIVATION MODEL, which is the most important paragraph here ─────
--
-- DAFTAR INVENTS NO FISCAL CALENDAR AND CREATES NO PERIOD BY ITSELF.
--
-- A business with ZERO periods behaves exactly as it did before this
-- migration existed: the posting-date rules of P2-S3 continue unchanged, and
-- nothing about periods is enforced. That is not a transitional state to be
-- migrated away from; it is a supported permanent state.
--
-- The FIRST period a merchant explicitly creates ACTIVATES period-managed
-- posting for that business, from that moment forward. Afterwards every NEW
-- ordinary posting's `entry_date` must fall inside exactly one existing
-- period, and that period must be `open`:
--
--   * inside an OPEN period          -> permitted
--   * inside a CLOSED period         -> REFUSED (accounting.period_closed)
--   * outside every period           -> REFUSED (accounting.period_missing_for_date)
--
-- ── THE ONE EXCEPTION, and it is narrow ──────────────────────────────────
--
-- An `opening_balance` whose `entry_date` PREDATES the earliest period start
-- posts without a covering period. The first period is where the books BEGIN
-- in DAFTAR; the opening position is by definition what was carried in from
-- before that, and 0042 already registers the source with
-- lower_bound_policy = 'none'. Without this, the same opening balance would
-- be accepted when entered before the merchant defined their first period and
-- REFUSED when entered after it — the accounting meaning of a fact would
-- depend on the order somebody configured the product.
--
-- The exception does not travel further than that sentence. An opening
-- balance INSIDE the chain obeys the covering-period rule in full, so a
-- CLOSED period still refuses it; an opening balance AFTER the chain is
-- uncovered and refused; and no other source gets the exception, so a manual
-- adjustment or a reversal dated before the earliest period is refused
-- exactly as any other uncovered date is. The universal no-future rule of
-- P2-S3 is untouched for every source, opening balances included.
--
-- History is NEVER rewritten. Entries posted before the first period existed
-- keep their dates, their entries and their balances, whether or not a period
-- later covers them. No period is invented to cover them, and no entry is
-- moved, re-dated, reversed or flagged.
--
-- ── What this file deliberately does NOT build (§8) ──────────────────────
--
--   * no trial balance, no general ledger, no balance read model, no
--     materialized balances, no report index, no reconciliation worker.
--   * no period-end journals, no retained-earnings close, no year-end or tax
--     close automation. Closing a period here records a DECISION; it posts
--     nothing.
--   * no fiscal-calendar generator, no auto-created periods, no inferred
--     year, quarter or month.
--   * no inventory, sales, purchases, payments, POS, customers or suppliers.
--   * no FX provider. P2-S5's registry is untouched.
--   * no 0050. Migrations 0000-0048 are FROZEN and untouched.
--
-- ── The universal no-future rule is NOT relaxed (§10) ────────────────────
--
-- `accounting_post_entry` (0045, FROZEN) refuses an `entry_date` after today
-- in the business timezone, and a reversal before the entry it reverses. An
-- OPEN period covering a future date does NOT make that date postable: the
-- two rules are independent and BOTH must pass. A period says which dates the
-- merchant has left open; the date rule says which dates have happened.
--
-- ── Why the refusal lives in the DATABASE (§23) ──────────────────────────
--
-- A guard in the API is a guard for callers that go through the API. The
-- ledger has other writers — migrations, future domain slices, a support
-- session with the merchant runtime credential — and a close that only the
-- HTTP layer honoured would be a convention, not a promise. So the refusal is
-- a BEFORE INSERT trigger on `journal_entries` itself, which every writer
-- passes through, and which locks the business the same way the posting
-- engine does so that closing and posting cannot both win.
--
-- ── THE LOCK ORDER, restated (§14, §24-§27) ──────────────────────────────
--
-- 0047 fixed the order for every accounting command; this file extends it by
-- one level and changes nothing above it:
--
--   1. verify the assertion                        (no lock)
--   2. pg_advisory_xact_lock(<per-business key>)   topology serialization
--   3. businesses row  FOR UPDATE / FOR SHARE      the business
--   4. accounting_periods row FOR UPDATE/FOR SHARE the period
--   5. mutate
--
-- A period command walks 2 -> 3 -> 4 exclusively. A posting walks 3 (FOR
-- SHARE, inside `accounting_post_entry`) -> 4 (FOR SHARE, inside this file's
-- trigger). BUSINESS BEFORE PERIOD on both paths, so the two can contend but
-- can never form a cycle, and the answer is decided by who reached the
-- business row first rather than by who happened to commit first.

-- ─────────────────────────────────────────────────────────────────────────
-- 0. btree_gist, and why this needs no new privilege (§12).
--
-- Physical non-overlap over (business_id, daterange) needs a GiST index that
-- can hold an equality column beside a range column, and that opclass lives
-- in `btree_gist`. PostgreSQL 13 and later mark the extension `trusted`, so
-- installing it does not require a superuser — but it DOES require CREATE on
-- the database, which `daftar_migrator` deliberately does not hold.
--
-- Three shapes were measured against a throw-away server before this line was
-- written:
--
--   1. migrator with CONNECT only, CREATE EXTENSION          -> REFUSED
--   2. migrator with CREATE ON DATABASE, CREATE EXTENSION    -> OK
--   3. extension already installed, migrator with CONNECT only,
--      CREATE EXTENSION IF NOT EXISTS                        -> OK
--
-- Shape 3 is the one this deployment uses, because it is the one that adds NO
-- privilege at all. `infrastructure/database/bootstrap.sql` installs the
-- extension as the deployment administrator — the same principal that already
-- creates the roles — and this file only asserts that it is there. Granting
-- `CREATE ON DATABASE` to the migration principal would have worked too and
-- would have been a permanent, broader authority bought for one statement.
--
-- The one thing NOT done here is abandoning physical non-overlap because the
-- extension is inconvenient. A trigger that SELECTed for an overlap would be
-- a check, not a constraint: two concurrent inserts can both find nothing and
-- both write. The exclusion constraint is the only mechanism that is right
-- under concurrency, so the deployment contract moves, not the invariant.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist') THEN
    BEGIN
      CREATE EXTENSION btree_gist;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION 'accounting.period_extension_missing: accounting periods require the btree_gist extension, which the migration principal may not install. Install it once as the deployment administrator — infrastructure/database/bootstrap.sql does exactly that — and re-run this migration.';
    END;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. The ownership-transfer authority, taken and returned inside this file.
--    Same dance as 0040/0042/0044/0045/0046/0048: DDL is transactional,
--    nothing temporary survives into a committed database, and section 14
--    refuses to commit if any of it did. Nothing assumes SUPERUSER.
-- ─────────────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO daftar_accounting_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. `accounting_periods` — the boundaries and their state (§11, §15, §16).
--
-- The boundaries are IMMUTABLE. There is no path that edits `start_date` or
-- `end_date`, no DELETE path, and no generic PATCH endpoint above this table.
-- Only the open/closed state and the metadata that records a transition may
-- ever change, and only through the two commands in section 10.
--
-- Why immutable boundaries. A period is the thing a merchant reported
-- against. Moving its edge after entries exist inside it silently changes
-- what was reported, and nothing in the ledger would record that it happened.
-- A merchant who got the boundary wrong creates the periods they meant; a
-- merchant who got it wrong after closing reopens, and the reopen is audited.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE accounting_periods (
  tenant_id                UUID NOT NULL,
  business_id              UUID NOT NULL,
  id                       UUID NOT NULL,
  start_date               DATE NOT NULL,
  end_date                 DATE NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_by_user_id       UUID NOT NULL REFERENCES users (id),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_by_user_id        UUID REFERENCES users (id),
  closed_at                TIMESTAMPTZ,
  last_reopened_by_user_id UUID REFERENCES users (id),
  last_reopened_at         TIMESTAMPTZ,
  last_reopen_reason       TEXT,
  PRIMARY KEY (business_id, id),

  -- §11: composite ownership, in both components. A row can never claim
  -- tenant A while naming a business tenant B owns.
  CONSTRAINT accounting_periods_tenant_business_fk
    FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),

  -- §11: a period ends on or after it starts. A single day is a period.
  CONSTRAINT accounting_periods_range_ck CHECK (start_date <= end_date),

  -- §11: FINITE. PostgreSQL DATE has `infinity` and `-infinity`, and an
  -- infinite period is not a period a merchant can ever close honestly: it
  -- would swallow every future date and make the contiguity rule meaningless.
  CONSTRAINT accounting_periods_finite_ck CHECK (
    start_date <> 'infinity'::date AND start_date <> '-infinity'::date
    AND end_date <> 'infinity'::date AND end_date <> '-infinity'::date
  ),

  -- §16: the closed metadata exists exactly when the period is closed. Stated
  -- as an equivalence rather than two one-way checks, so neither a closed
  -- period without an author nor an open period carrying a stale close can
  -- exist even for the duration of one statement.
  CONSTRAINT accounting_periods_closed_shape_ck CHECK (
    (status = 'closed') = (closed_at IS NOT NULL AND closed_by_user_id IS NOT NULL)
  ),

  -- §17: a reopen is recorded in full or not at all — who, when, and why.
  CONSTRAINT accounting_periods_reopen_shape_ck CHECK (
    (last_reopened_at IS NOT NULL) = (last_reopened_by_user_id IS NOT NULL)
    AND (last_reopened_at IS NOT NULL) = (last_reopen_reason IS NOT NULL)
  ),

  -- §17: the reason is real text, already trimmed, bounded at 500. Trimmed
  -- physically because "   " is not a reason and a validation layer that
  -- trimmed it would be the only thing standing between blank and stored.
  CONSTRAINT accounting_periods_reopen_reason_ck CHECK (
    last_reopen_reason IS NULL
    OR (btrim(last_reopen_reason, E' \t\n\r') = last_reopen_reason
        AND length(last_reopen_reason) BETWEEN 1 AND 500)
  ),

  -- §12: PHYSICAL non-overlap, per business. Not a trigger that looks for a
  -- conflict — two concurrent inserts can both look and both find nothing.
  -- An exclusion constraint is the only mechanism that is correct under
  -- concurrency, and `'[]'` makes the range INCLUSIVE at both ends, which is
  -- what a civil-date period means: 1-31 January and 1-28 February are
  -- adjacent, not overlapping.
  CONSTRAINT accounting_periods_no_overlap
    EXCLUDE USING gist (business_id WITH =, daterange(start_date, end_date, '[]') WITH &&)
);

COMMENT ON TABLE accounting_periods IS
  'Accounting periods (directive §9-§17). A finite, inclusive span of civil dates belonging to one business, open or closed. DAFTAR creates none automatically and infers no fiscal calendar: a business with zero periods posts under the pre-P2-S6 date rules, and the FIRST period a merchant creates activates period-managed posting. Boundaries are immutable and rows are never deleted.';
COMMENT ON COLUMN accounting_periods.start_date IS
  'Inclusive first civil date, in the business timezone. IMMUTABLE after creation: a period is what was reported against, and moving its edge would silently change what was reported.';
COMMENT ON COLUMN accounting_periods.end_date IS
  'Inclusive last civil date. IMMUTABLE after creation, for the same reason as start_date.';
COMMENT ON COLUMN accounting_periods.status IS
  'Exactly ''open'' or ''closed''. There is no ''locked'', ''archived'' or ''pending'' state: a third value would be a state no command can produce and no rule can interpret.';
COMMENT ON COLUMN accounting_periods.last_reopen_reason IS
  'Why the period was reopened, mandatory on every reopen and audited (§17). Deliberately NOT published on the outbox: it is free merchant text and an event bus is read by more systems than the ledger is.';

-- §37, §38: the lookups this slice actually performs. The exclusion
-- constraint's GiST index answers "which period contains this date" for the
-- posting guard, and the primary key answers "this period by id". Contiguity
-- reads min(start_date)/max(end_date) per business, which the GiST index also
-- serves. No speculative index: every one costs each insert, and there is no
-- report surface in this slice to serve.

-- ─────────────────────────────────────────────────────────────────────────
-- 3. `accounting_period_operations` — durable command identity (§18).
--
-- An `Idempotency-Key` is not by itself permission to answer "success". The
-- registry records WHICH command a key performed, WHAT it did and WHAT state
-- resulted, so a replay can be answered from the record rather than by
-- re-deciding from current state.
--
-- ── The hazard this exists for ───────────────────────────────────────────
--
-- A merchant reopens March, fixes an entry, closes March again. The original
-- reopen request is then retried — a stuck client, a queue redelivery, a
-- human pressing a button twice. Without a record of what that key already
-- did, the retry finds a CLOSED period and a well-formed reopen command, and
-- REOPENS A PERIOD THE MERCHANT HAS CLOSED. The registry answers it with the
-- original result instead, and the period does not move.
--
-- Append-only: no UPDATE, no DELETE, from any principal.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE accounting_period_operations (
  tenant_id           UUID NOT NULL,
  business_id         UUID NOT NULL,
  id                  UUID NOT NULL,
  operation_kind      TEXT NOT NULL CHECK (operation_kind IN ('period_create', 'period_close', 'period_reopen')),
  period_id           UUID NOT NULL,
  payload_fingerprint CHAR(64) NOT NULL CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  resulting_status    TEXT NOT NULL CHECK (resulting_status IN ('open', 'closed')),
  actor_user_id       UUID NOT NULL REFERENCES users (id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id),
  CONSTRAINT accounting_period_operations_tenant_business_fk
    FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT accounting_period_operations_period_fk
    FOREIGN KEY (business_id, period_id) REFERENCES accounting_periods (business_id, id)
);

COMMENT ON TABLE accounting_period_operations IS
  'Append-only registry of period commands (directive §18). One row per performed create, close or reopen, binding the operation id derived from the request Idempotency-Key to the command kind, the period, the canonical payload fingerprint, the resulting state and the actor. A replay is answered from this record, never by re-deciding from current state: an old reopen retried after a later close must not reopen the period again.';

-- ─────────────────────────────────────────────────────────────────────────
-- 4. `acctperiod/1` — the canonical period-command fingerprint (§20).
--
-- The PostgreSQL half of a specification implemented twice. The TypeScript
-- half is `packages/accounting/src/period.ts`, and the shared vectors in
-- `packages/accounting/vectors/acctperiod-vectors.json` are the single source
-- both are tested against, so neither can drift without the other failing.
--
-- The stream is UTF-8, newline-separated and newline-terminated:
--
--   acctperiod/1 \n <kind> \n <tenant> \n <business> \n <operation_id> \n
--   <period_id> \n
--     period_create: <start_date> \n <end_date> \n
--     period_close:  (nothing further)
--     period_reopen: <reason_digest> \n
--
-- The KIND is the second field, so the three streams are distinguishable at
-- their fifth byte and no create payload can ever equal a close payload.
--
-- Not `JSON.stringify` and not `row_to_json`: key order, unicode escaping and
-- whitespace are implementation-defined and none of them is stable across two
-- languages.
--
-- ── The reason identity contract (§20) ───────────────────────────────────
--
-- The reopen reason is free text a human typed, so it needs an exact
-- normalization both languages can reproduce:
--
--   1. Strip leading and trailing SPACE, TAB, LF and CR — those four bytes
--      and no others. NOT a language's "trim whitespace", because
--      JavaScript's and PostgreSQL's differ on U+00A0, U+2028 and several
--      others, and a fingerprint that disagreed about one invisible
--      character would refuse a command nobody changed.
--   2. SHA-256 of the UTF-8 bytes, lowercase hex.
--
-- ── Why there is no Unicode NFC step ─────────────────────────────────────
--
-- There was one, and it came out. PostgreSQL's `normalize(text, NFC)` raises
-- `Unicode normalization can only be performed if server encoding is UTF8`,
-- and DAFTAR does not require a UTF8 server encoding of a deployment today.
-- Keeping the step would have meant one of two things: a new, unstated
-- deployment requirement that the bootstrap does not enforce and that a
-- restored database could silently not meet, or a specification whose
-- PostgreSQL half degrades to something the TypeScript half does not do —
-- which is exactly the drift the shared vectors exist to prevent.
--
-- So the contract takes the bytes VERBATIM. The cost is small and precise: a
-- reason typed with a decomposed accent and the same reason typed with a
-- composed one are two different reasons, and a client that retried with the
-- other spelling would be told its payload does not match what was
-- authorized. That is a refusal, never a silent divergence, and the merchant
-- surface normalizes on the way in anyway — it simply does not get to claim
-- that the DATABASE did.
--
-- The DIGEST is what the stream carries, not the reason. The reason reaches
-- the audit trail, where it belongs; the fingerprint only has to bind it.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION accounting_period_reason_digest(p_reason TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT encode(digest(convert_to(btrim(p_reason, E' \t\n\r'), 'UTF8'), 'sha256'), 'hex')
$$;

CREATE OR REPLACE FUNCTION accounting_period_canonical(
  p_kind          TEXT,
  p_tenant        UUID,
  p_business      UUID,
  p_operation_id  UUID,
  p_period_id     UUID,
  p_start_date    DATE,
  p_end_date      DATE,
  p_reason_digest TEXT
) RETURNS BYTEA
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_head TEXT;
BEGIN
  IF p_kind IS NULL OR p_tenant IS NULL OR p_business IS NULL OR p_operation_id IS NULL OR p_period_id IS NULL THEN
    RAISE EXCEPTION 'accounting.payload_missing_field: a period command fingerprint states a kind, a tenant, a business, an operation and a period' USING ERRCODE = 'P0001';
  END IF;

  v_head :=
    'acctperiod/1' || E'\n' ||
    p_kind || E'\n' ||
    lower(p_tenant::text) || E'\n' ||
    lower(p_business::text) || E'\n' ||
    lower(p_operation_id::text) || E'\n' ||
    lower(p_period_id::text) || E'\n';

  IF p_kind = 'period_create' THEN
    IF p_start_date IS NULL OR p_end_date IS NULL THEN
      RAISE EXCEPTION 'accounting.payload_missing_field: creating a period states both of its boundaries' USING ERRCODE = 'P0001';
    END IF;
    RETURN convert_to(v_head || to_char(p_start_date, 'YYYY-MM-DD') || E'\n' || to_char(p_end_date, 'YYYY-MM-DD') || E'\n', 'UTF8');
  ELSIF p_kind = 'period_close' THEN
    RETURN convert_to(v_head, 'UTF8');
  ELSIF p_kind = 'period_reopen' THEN
    IF p_reason_digest IS NULL OR p_reason_digest !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'accounting.period_reopen_reason_required: reopening a period states a reason' USING ERRCODE = 'P0001';
    END IF;
    RETURN convert_to(v_head || p_reason_digest || E'\n', 'UTF8');
  END IF;

  RAISE EXCEPTION 'accounting.payload_invalid: unknown period command kind' USING ERRCODE = 'P0001';
END;
$$;

CREATE OR REPLACE FUNCTION accounting_period_fingerprint(
  p_kind          TEXT,
  p_tenant        UUID,
  p_business      UUID,
  p_operation_id  UUID,
  p_period_id     UUID,
  p_start_date    DATE,
  p_end_date      DATE,
  p_reason_digest TEXT
) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT encode(digest(accounting_period_canonical(p_kind, p_tenant, p_business, p_operation_id, p_period_id, p_start_date, p_end_date, p_reason_digest), 'sha256'), 'hex')
$$;

COMMENT ON FUNCTION accounting_period_fingerprint(TEXT, UUID, UUID, UUID, UUID, DATE, DATE, TEXT) IS
  'acctperiod/1: the SHA-256 of a canonical byte stream over every field that identifies one period command (directive §20). One specification, two implementations — this one and packages/accounting/src/period.ts — kept byte-identical by shared vectors.';

-- ─────────────────────────────────────────────────────────────────────────
-- 5. The topology lock (§14, §24).
--
-- ONE key per business, not one global accounting lock. Creating a period for
-- business A never waits on business B, and no posting anywhere waits on
-- either: the posting path does not take this lock at all. It exists so that
-- the two operations that change a business's period TOPOLOGY — creating the
-- first period, and creating any later one — are serialized against each
-- other before either reads min/max to decide contiguity.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION accounting_period_topology_lock_key(p_business UUID) RETURNS BIGINT
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT hashtextextended('period:' || lower(p_business::text) || '|topology', 0)
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 6. Immutability and the transition rule (§15, §16).
--
-- Two independent mechanisms, deliberately redundant, exactly as 0048 does
-- for rate history. No runtime role holds UPDATE or DELETE (section 12), and
-- these triggers raise on their own terms — so the rule is answered by the
-- TRIGGER even when the caller is the schema owner, the one principal a
-- privilege check can never stop. §36 asks for precisely that distinction:
-- `permission denied` is evidence about an ACL, not about an invariant.
--
-- NO IDENTITY EXEMPTION. There is no `current_user` branch anywhere below,
-- no "unless the internal principal", and no GUC that relaxes it. The trusted
-- command in section 10 satisfies these rules; it is not excused from them.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION accounting_periods_no_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'accounting.period_immutable: an accounting period cannot be deleted (business %, period %) — a period that existed is part of what was reported',
    OLD.business_id, OLD.id USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER accounting_periods_no_deletion
  BEFORE DELETE ON accounting_periods
  FOR EACH ROW EXECUTE FUNCTION accounting_periods_no_delete();

CREATE OR REPLACE FUNCTION accounting_periods_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- ── Identity and boundaries are immutable (§15) ────────────────────────
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.business_id IS DISTINCT FROM OLD.business_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.start_date IS DISTINCT FROM OLD.start_date
     OR NEW.end_date IS DISTINCT FROM OLD.end_date
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'accounting.period_immutable: a period''s identity, boundaries and creation record cannot be changed (business %, period %)',
      OLD.business_id, OLD.id USING ERRCODE = 'P0001';
  END IF;

  -- ── Only two transitions exist (§16) ───────────────────────────────────
  IF OLD.status = NEW.status THEN
    RAISE EXCEPTION 'accounting.period_immutable: a period row changes only by closing or reopening it (business %, period %, status %)',
      OLD.business_id, OLD.id, OLD.status USING ERRCODE = 'P0001';
  END IF;

  IF OLD.status = 'open' AND NEW.status = 'closed' THEN
    -- Closing records who and when, and touches nothing else. The reopen
    -- metadata of an EARLIER reopen is left exactly as it was: it is the
    -- record of that reopen, not of this close.
    IF NEW.closed_at IS NULL OR NEW.closed_by_user_id IS NULL THEN
      RAISE EXCEPTION 'accounting.period_immutable: closing a period records who closed it and when (business %, period %)',
        OLD.business_id, OLD.id USING ERRCODE = 'P0001';
    END IF;
    IF NEW.last_reopened_at IS DISTINCT FROM OLD.last_reopened_at
       OR NEW.last_reopened_by_user_id IS DISTINCT FROM OLD.last_reopened_by_user_id
       OR NEW.last_reopen_reason IS DISTINCT FROM OLD.last_reopen_reason THEN
      RAISE EXCEPTION 'accounting.period_immutable: closing a period may not rewrite the record of an earlier reopen (business %, period %)',
        OLD.business_id, OLD.id USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'closed' AND NEW.status = 'open' THEN
    -- Reopening records who, when and WHY, and clears the close it undid.
    -- The reason is mandatory here and not merely in a DTO: a reopen nobody
    -- explained is a reopen nobody can review.
    IF NEW.last_reopened_at IS NULL OR NEW.last_reopened_by_user_id IS NULL THEN
      RAISE EXCEPTION 'accounting.period_immutable: reopening a period records who reopened it and when (business %, period %)',
        OLD.business_id, OLD.id USING ERRCODE = 'P0001';
    END IF;
    IF NEW.last_reopen_reason IS NULL OR btrim(NEW.last_reopen_reason, E' \t\n\r') = '' THEN
      RAISE EXCEPTION 'accounting.period_reopen_reason_required: reopening a period requires a reason (business %, period %)',
        OLD.business_id, OLD.id USING ERRCODE = 'P0001';
    END IF;
    IF NEW.last_reopened_at IS NOT DISTINCT FROM OLD.last_reopened_at THEN
      RAISE EXCEPTION 'accounting.period_immutable: reopening a period records a NEW reopen, not a copy of the previous one (business %, period %)',
        OLD.business_id, OLD.id USING ERRCODE = 'P0001';
    END IF;
    IF NEW.closed_at IS NOT NULL OR NEW.closed_by_user_id IS NOT NULL THEN
      RAISE EXCEPTION 'accounting.period_immutable: a reopened period carries no close (business %, period %)',
        OLD.business_id, OLD.id USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'accounting.period_immutable: % is not a period transition (business %, period %)',
    OLD.status || ' -> ' || NEW.status, OLD.business_id, OLD.id USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER accounting_periods_transition_only
  BEFORE UPDATE ON accounting_periods
  FOR EACH ROW EXECUTE FUNCTION accounting_periods_transition();

CREATE OR REPLACE FUNCTION accounting_period_operations_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'accounting.period_immutable: a recorded period operation cannot be % (business %, operation %) — the registry is the record of what a key already did',
    lower(TG_OP), OLD.business_id, OLD.id USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER accounting_period_operations_no_mutation
  BEFORE UPDATE OR DELETE ON accounting_period_operations
  FOR EACH ROW EXECUTE FUNCTION accounting_period_operations_immutable();

-- ─────────────────────────────────────────────────────────────────────────
-- 7. THE POSTING GUARD (§23, §25, §26, §38).
--
-- A BEFORE INSERT trigger on `journal_entries`, so it covers every writer
-- that has ever existed or will: the posting command, any future domain
-- slice, a migration, a support session. Nothing here depends on NestJS,
-- TypeScript, HTTP or a service being called first.
--
-- ── It takes its own business lock ───────────────────────────────────────
--
-- `accounting_post_entry` already locks the business row before it inserts,
-- so in the ordinary path the `FOR SHARE` below is a lock this transaction
-- already holds and costs nothing. It is issued anyway, because a guard that
-- assumed its caller had locked would be a guard that protects the ONE writer
-- that remembers to. The lock belongs to the rule, not to the caller.
--
-- ── Why this makes close-versus-post deterministic (§25) ─────────────────
--
-- A close takes the business row FOR UPDATE; a posting holds it FOR SHARE.
-- The two conflict, so one of them reaches the business row first and the
-- other waits for it to finish:
--
--   posting first -> the close waits; the entry commits inside a period that
--                    was still open; the close then closes a period that
--                    already contains it. Correct: the entry was committed
--                    BEFORE the close.
--   close first   -> the posting waits; when it proceeds it re-reads the
--                    period row under FOR SHARE and sees `closed`, and is
--                    REFUSED.
--
-- There is no third outcome, and no ordering in which a posting commits into
-- a period after that period was closed. Both paths take BUSINESS before
-- PERIOD, so they cannot deadlock.
--
-- ── Replay is not an insert ──────────────────────────────────────────────
--
-- An idempotent replay of an already-posted command returns from
-- `accounting_post_entry` before reaching its INSERT, so this trigger never
-- fires for it. That is exactly the required behaviour (§38): re-sending a
-- command that was accepted while the period was open still succeeds after
-- the close, because it creates nothing. A close refuses NEW truth; it does
-- not retract an answer the merchant already received.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION accounting_period_guard_posting() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_earliest DATE;
  v_status   TEXT;
  v_id       UUID;
BEGIN
  -- 1. Stabilize the business in the established lock order. See above for
  --    why the guard takes this itself rather than trusting its caller.
  PERFORM 1 FROM businesses b WHERE b.id = NEW.business_id FOR SHARE;

  -- 2. Activation (§9) AND the earliest boundary, in ONE set-wise read. A
  --    NULL minimum means this business has no periods at all, which is a
  --    supported permanent state rather than a state to be migrated away
  --    from: the business posts exactly as it did before this migration
  --    existed.
  SELECT min(p.start_date) INTO v_earliest
  FROM accounting_periods p
  WHERE p.business_id = NEW.business_id;

  IF v_earliest IS NULL THEN
    RETURN NEW;
  END IF;

  -- 3. THE ONE HISTORICAL EXCEPTION — an opening position that predates the
  --    books.
  --
  --    A merchant's first period is when their books BEGIN in DAFTAR. The
  --    opening balance is, by definition, the position carried in from
  --    before that — 0042 registers `opening_balance` with
  --    lower_bound_policy = 'none' precisely because it has no historical
  --    floor. Refusing it for want of a covering period would mean the same
  --    financial fact is valid or invalid depending on whether the merchant
  --    entered their opening position before or after they defined their
  --    first period. Accounting truth does not depend on the order in which
  --    somebody configured a product.
  --
  --    The exception is deliberately narrow, and each half of the condition
  --    carries its own weight:
  --
  --      * the SOURCE must be `opening_balance`. A manual adjustment or a
  --        reversal dated before the earliest period is refused exactly as
  --        before — they are ordinary postings and periods narrow them.
  --      * the DATE must PREDATE the earliest period start. An opening
  --        balance that lands INSIDE the covered chain is not historical,
  --        so it falls through to the covering-period rule below and obeys
  --        it in full: permitted in an open period, REFUSED in a closed one.
  --        An opening balance after the chain is uncovered and is refused.
  --
  --    So this is a rule about placement relative to the beginning of the
  --    books, not a licence for one source to ignore period state. The
  --    universal date authority is untouched: P2-S3 still refuses any entry
  --    dated after today in the business timezone, opening balances
  --    included, and it does so before this trigger is ever reached.
  IF NEW.source_type = 'opening_balance' AND NEW.entry_date < v_earliest THEN
    RETURN NEW;
  END IF;

  -- 4. Exactly one period may contain the date — the exclusion constraint is
  --    what makes "exactly one" true rather than "the first one found".
  SELECT p.id, p.status INTO v_id, v_status
  FROM accounting_periods p
  WHERE p.business_id = NEW.business_id
    AND NEW.entry_date >= p.start_date
    AND NEW.entry_date <= p.end_date
  FOR SHARE;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'accounting.period_missing_for_date: this business manages accounting periods and none covers % — create the period before posting into it', NEW.entry_date
      USING ERRCODE = 'P0001';
  END IF;

  IF v_status = 'closed' THEN
    RAISE EXCEPTION 'accounting.period_closed: the accounting period covering % is closed (business %, period %)', NEW.entry_date, NEW.business_id, v_id
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

-- `accounting_period_guard` sorts after every BEFORE INSERT trigger 0042
-- installed, which is deliberate: the journal's own shape rules answer first,
-- so a malformed entry is refused as malformed rather than as out-of-period.
CREATE TRIGGER accounting_period_guard
  BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION accounting_period_guard_posting();

COMMENT ON FUNCTION accounting_period_guard_posting() IS
  'The DATABASE-level closed-period refusal (directive §23). A BEFORE INSERT trigger on journal_entries, so every writer passes through it and no application layer can be the thing that enforces a close. Takes the business row FOR SHARE and the covering period FOR SHARE, in that order, which is the same order the period commands take them in — so a close and a posting contend but never deadlock, and a posting can never commit into a period after it was closed. One narrow exception, which exists so that an accounting fact does not change meaning with setup order: an opening_balance dated strictly before the earliest period start posts without a covering period. It is the only source with that exception, it applies only before the chain begins, and an opening balance inside a CLOSED period is still refused.';

-- ─────────────────────────────────────────────────────────────────────────
-- 8. RLS — the established business-scoped model, unchanged (§35).
--
-- `app_bypass()` is not touched and nothing gains BYPASSRLS. The internal
-- principal gets its own policies because the business it writes comes from
-- the VERIFIED assertion rather than from a GUC, and a row-level rule keyed
-- on a caller-settable GUC would make that GUC load-bearing.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE accounting_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_periods FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_membership ON accounting_periods
  USING (app_bypass() OR EXISTS (SELECT 1 FROM businesses b WHERE b.id = accounting_periods.business_id AND b.tenant_id::text = app_tenant()))
  WITH CHECK (app_bypass() OR EXISTS (SELECT 1 FROM businesses b WHERE b.id = accounting_periods.business_id AND b.tenant_id::text = app_tenant()));
CREATE POLICY accounting_writer ON accounting_periods
  FOR INSERT WITH CHECK (current_user = 'daftar_accounting_internal');
CREATE POLICY accounting_validator ON accounting_periods
  FOR SELECT USING (current_user = 'daftar_accounting_internal');
CREATE POLICY accounting_transition ON accounting_periods
  FOR UPDATE USING (current_user = 'daftar_accounting_internal')
  WITH CHECK (current_user = 'daftar_accounting_internal');
CREATE POLICY business_isolation ON accounting_periods AS RESTRICTIVE
  USING (app_bypass() OR current_user = 'daftar_accounting_internal' OR business_id::text = app_business())
  WITH CHECK (app_bypass() OR current_user = 'daftar_accounting_internal' OR business_id::text = app_business());

ALTER TABLE accounting_period_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_period_operations FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_membership ON accounting_period_operations
  USING (app_bypass() OR EXISTS (SELECT 1 FROM businesses b WHERE b.id = accounting_period_operations.business_id AND b.tenant_id::text = app_tenant()))
  WITH CHECK (app_bypass() OR EXISTS (SELECT 1 FROM businesses b WHERE b.id = accounting_period_operations.business_id AND b.tenant_id::text = app_tenant()));
CREATE POLICY accounting_writer ON accounting_period_operations
  FOR INSERT WITH CHECK (current_user = 'daftar_accounting_internal');
CREATE POLICY accounting_validator ON accounting_period_operations
  FOR SELECT USING (current_user = 'daftar_accounting_internal');
CREATE POLICY business_isolation ON accounting_period_operations AS RESTRICTIVE
  USING (app_bypass() OR current_user = 'daftar_accounting_internal' OR business_id::text = app_business())
  WITH CHECK (app_bypass() OR current_user = 'daftar_accounting_internal' OR business_id::text = app_business());

-- ─────────────────────────────────────────────────────────────────────────
-- 9. Grants — default deny, minimum read, no runtime writer (§35).
--
-- End state:
--   daftar_app                  SELECT on accounting_periods, and nothing
--                               else. The merchant UI lists a business's
--                               periods and the read runs as the CALLER, so
--                               RLS decides what it can see.
--   every other runtime role    nothing at all, on either table.
--   daftar_app                  NOTHING on accounting_period_operations. The
--                               registry holds internal command identities
--                               and §32 forbids exposing them.
--   daftar_accounting_internal  SELECT + INSERT + UPDATE on the periods,
--                               SELECT + INSERT on the registry. Never
--                               DELETE, on either.
-- ─────────────────────────────────────────────────────────────────────────
REVOKE ALL ON accounting_periods FROM PUBLIC;
REVOKE ALL ON accounting_period_operations FROM PUBLIC;
GRANT SELECT ON accounting_periods TO daftar_app;
GRANT SELECT, INSERT, UPDATE ON accounting_periods TO daftar_accounting_internal;
GRANT SELECT, INSERT ON accounting_period_operations TO daftar_accounting_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 10. The three commands (§18-§20, §29-§34).
--
-- Each one follows the same order, and the order IS the contract:
--
--   1. verified authority, narrowed to this command kind
--   2. the payload is well-formed
--   3. the signed fingerprint describes THIS payload
--   4. serialize the business's period topology, then the business row
--   5. has this operation id already run?  -> the ORIGINAL result, or
--      accounting.idempotency_conflict. BEFORE any state is inspected.
--   6. the domain rules
--   7. write, audit, publish — one transaction, all or nothing
--
-- Step 5 before step 6 is the whole point of §18's hazard: a replayed reopen
-- must be answered from the record of what it did, never from what is true
-- now.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION accounting_period_create(
  p_operation_id UUID,
  p_start_date   DATE,
  p_end_date     DATE,
  p_request_id   TEXT
) RETURNS TABLE (period_id UUID, created BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_actor  accounting_verified_control_actor;
  v_tenant UUID;
  v_fp     TEXT;
  v_op     accounting_period_operations%ROWTYPE;
  v_min    DATE;
  v_max    DATE;
BEGIN
  -- ── 1. Authority ───────────────────────────────────────────────────────
  v_actor := accounting_control_actor(ARRAY['period_create']);

  -- ── 2. The payload, refused by name before anything is derived ─────────
  IF p_operation_id IS NULL THEN
    RAISE EXCEPTION 'accounting.payload_missing_field: a period command states its operation identity' USING ERRCODE = 'P0001';
  END IF;
  IF p_start_date IS NULL OR p_end_date IS NULL THEN
    RAISE EXCEPTION 'accounting.payload_missing_field: a period states both of its boundaries' USING ERRCODE = 'P0001';
  END IF;
  -- Finite and ordered, checked here as well as by the table, so the refusal
  -- carries the domain's own sentence rather than a constraint name.
  IF p_start_date IN ('infinity'::date, '-infinity'::date) OR p_end_date IN ('infinity'::date, '-infinity'::date) THEN
    RAISE EXCEPTION 'accounting.period_range_invalid: a period has finite boundaries' USING ERRCODE = 'P0001';
  END IF;
  IF p_start_date > p_end_date THEN
    RAISE EXCEPTION 'accounting.period_range_invalid: a period ends on or after it starts' USING ERRCODE = 'P0001';
  END IF;

  -- ── 3. The signed fingerprint must describe THIS payload (§20) ─────────
  v_fp := accounting_period_fingerprint('period_create', v_actor.tenant_id, v_actor.business_id,
                                        p_operation_id, v_actor.resource_id, p_start_date, p_end_date, NULL);
  IF v_fp <> v_actor.payload_fingerprint THEN
    RAISE EXCEPTION 'accounting.assertion_payload_mismatch: the submitted period is not the period that was authorized' USING ERRCODE = 'P0001';
  END IF;

  -- ── 4. Topology, then the business (§14, §24) ──────────────────────────
  PERFORM pg_advisory_xact_lock(accounting_period_topology_lock_key(v_actor.business_id));
  SELECT b.tenant_id INTO v_tenant FROM businesses b WHERE b.id = v_actor.business_id FOR UPDATE;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'accounting.forbidden: the accounting assertion names a business that does not exist' USING ERRCODE = 'P0001';
  END IF;
  IF v_tenant IS DISTINCT FROM v_actor.tenant_id THEN
    RAISE EXCEPTION 'accounting.forbidden: the accounting assertion tenant does not own the named business' USING ERRCODE = 'P0001';
  END IF;

  -- ── 5. Has this operation id already run? (§18) ────────────────────────
  SELECT * INTO v_op FROM accounting_period_operations o
  WHERE o.business_id = v_actor.business_id AND o.id = p_operation_id;
  IF FOUND THEN
    IF v_op.payload_fingerprint = v_fp THEN
      RETURN QUERY SELECT v_op.period_id, false;
      RETURN;
    END IF;
    RAISE EXCEPTION 'accounting.idempotency_conflict: this idempotency key already performed a different period operation' USING ERRCODE = 'P0001';
  END IF;

  -- ── 6. Overlap, then contiguity (§13, §37) ─────────────────────────────
  --
  -- Overlap first, because an overlapping range is a different mistake from a
  -- gap and deserves its own sentence. Both are REFUSALS: nothing here merges
  -- ranges, splits them, snaps a boundary or infers what the merchant meant.
  IF EXISTS (
    SELECT 1 FROM accounting_periods p
    WHERE p.business_id = v_actor.business_id
      AND daterange(p.start_date, p.end_date, '[]') && daterange(p_start_date, p_end_date, '[]')
  ) THEN
    RAISE EXCEPTION 'accounting.period_overlap: this business already has a period covering part of % to %', p_start_date, p_end_date
      USING ERRCODE = 'P0001';
  END IF;

  SELECT min(p.start_date), max(p.end_date) INTO v_min, v_max
  FROM accounting_periods p WHERE p.business_id = v_actor.business_id;

  IF v_min IS NOT NULL THEN
    -- A later period is exactly adjacent to what exists, at one end or the
    -- other. A gap would mean dates no period covers sitting BETWEEN dates
    -- some period does, and every posting into that gap would be refused with
    -- no way for the merchant to tell a deliberate boundary from an omission.
    IF p_end_date <> v_min - 1 AND p_start_date <> v_max + 1 THEN
      RAISE EXCEPTION 'accounting.period_not_contiguous: a period joins the existing range exactly — this business''s periods run % to %', v_min, v_max
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- ── 7. The row, its registry entry, its audit and its event ────────────
  INSERT INTO accounting_periods (tenant_id, business_id, id, start_date, end_date, status, created_by_user_id)
  VALUES (v_actor.tenant_id, v_actor.business_id, v_actor.resource_id, p_start_date, p_end_date, 'open', v_actor.actor_user_id);

  INSERT INTO accounting_period_operations (tenant_id, business_id, id, operation_kind, period_id, payload_fingerprint, resulting_status, actor_user_id)
  VALUES (v_actor.tenant_id, v_actor.business_id, p_operation_id, 'period_create', v_actor.resource_id, v_fp, 'open', v_actor.actor_user_id);

  INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, request_id, metadata)
  VALUES (v_actor.tenant_id, v_actor.business_id, v_actor.actor_user_id, 'accounting.period_created', 'accounting_period',
          v_actor.resource_id::text, p_request_id,
          jsonb_build_object('startDate', to_char(p_start_date, 'YYYY-MM-DD'),
                             'endDate', to_char(p_end_date, 'YYYY-MM-DD'),
                             'status', 'open'));

  INSERT INTO outbox_events (tenant_id, business_id, type, payload)
  VALUES (v_actor.tenant_id, v_actor.business_id, 'accounting.period.created',
          jsonb_build_object('periodId', v_actor.resource_id, 'businessId', v_actor.business_id,
                             'startDate', to_char(p_start_date, 'YYYY-MM-DD'),
                             'endDate', to_char(p_end_date, 'YYYY-MM-DD'),
                             'status', 'open'));

  RETURN QUERY SELECT v_actor.resource_id, true;
EXCEPTION
  WHEN exclusion_violation THEN
    -- The physical backstop under true concurrency, surfaced as the domain's
    -- own sentence. No SQLSTATE and no constraint name reaches a caller (§37).
    RAISE EXCEPTION 'accounting.period_overlap: this business already has a period covering part of % to %', p_start_date, p_end_date
      USING ERRCODE = 'P0001';
  WHEN unique_violation THEN
    IF SQLERRM LIKE '%accounting_period%' THEN
      RAISE EXCEPTION 'accounting.idempotency_conflict: this idempotency key already performed a period operation' USING ERRCODE = 'P0001';
    END IF;
    RAISE;
END;
$$;

COMMENT ON FUNCTION accounting_period_create(UUID, DATE, DATE, TEXT) IS
  'The ONLY way an accounting period comes into existence (directive §29). Requires a verified acctctl/1 assertion for command kind period_create; the actor, tenant, business and period id come from it and from nowhere else. The first period a business creates ACTIVATES period-managed posting for it (§9); DAFTAR creates none by itself and infers no fiscal calendar.';

CREATE OR REPLACE FUNCTION accounting_period_close(
  p_operation_id UUID,
  p_request_id   TEXT
) RETURNS TABLE (period_id UUID, changed BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_actor  accounting_verified_control_actor;
  v_tenant UUID;
  v_fp     TEXT;
  v_op     accounting_period_operations%ROWTYPE;
  v_period accounting_periods%ROWTYPE;
BEGIN
  v_actor := accounting_control_actor(ARRAY['period_close']);

  IF p_operation_id IS NULL THEN
    RAISE EXCEPTION 'accounting.payload_missing_field: a period command states its operation identity' USING ERRCODE = 'P0001';
  END IF;

  v_fp := accounting_period_fingerprint('period_close', v_actor.tenant_id, v_actor.business_id,
                                        p_operation_id, v_actor.resource_id, NULL, NULL, NULL);
  IF v_fp <> v_actor.payload_fingerprint THEN
    RAISE EXCEPTION 'accounting.assertion_payload_mismatch: the submitted command is not the command that was authorized' USING ERRCODE = 'P0001';
  END IF;

  -- Topology, then business, then period — the order the posting guard also
  -- takes, which is what makes §25 decidable instead of a race.
  PERFORM pg_advisory_xact_lock(accounting_period_topology_lock_key(v_actor.business_id));
  SELECT b.tenant_id INTO v_tenant FROM businesses b WHERE b.id = v_actor.business_id FOR UPDATE;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'accounting.forbidden: the accounting assertion names a business that does not exist' USING ERRCODE = 'P0001';
  END IF;
  IF v_tenant IS DISTINCT FROM v_actor.tenant_id THEN
    RAISE EXCEPTION 'accounting.forbidden: the accounting assertion tenant does not own the named business' USING ERRCODE = 'P0001';
  END IF;

  -- BEFORE any state is inspected (§18, §40).
  SELECT * INTO v_op FROM accounting_period_operations o
  WHERE o.business_id = v_actor.business_id AND o.id = p_operation_id;
  IF FOUND THEN
    IF v_op.payload_fingerprint = v_fp THEN
      RETURN QUERY SELECT v_op.period_id, false;
      RETURN;
    END IF;
    RAISE EXCEPTION 'accounting.idempotency_conflict: this idempotency key already performed a different period operation' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_period FROM accounting_periods p
  WHERE p.business_id = v_actor.business_id AND p.id = v_actor.resource_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'accounting.period_not_found: this business has no such accounting period' USING ERRCODE = 'P0001';
  END IF;
  IF v_period.status <> 'open' THEN
    -- Not silently successful. A NEW key closing an already-closed period is
    -- a caller whose belief about the ledger is wrong, and saying so is the
    -- only way they find out. A genuine retry replays above, by its key.
    RAISE EXCEPTION 'accounting.period_not_open: this accounting period is already closed (business %, period %)', v_actor.business_id, v_actor.resource_id
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE accounting_periods
  SET status = 'closed', closed_at = now(), closed_by_user_id = v_actor.actor_user_id
  WHERE business_id = v_actor.business_id AND id = v_actor.resource_id;

  INSERT INTO accounting_period_operations (tenant_id, business_id, id, operation_kind, period_id, payload_fingerprint, resulting_status, actor_user_id)
  VALUES (v_actor.tenant_id, v_actor.business_id, p_operation_id, 'period_close', v_actor.resource_id, v_fp, 'closed', v_actor.actor_user_id);

  INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, request_id, metadata)
  VALUES (v_actor.tenant_id, v_actor.business_id, v_actor.actor_user_id, 'accounting.period_closed', 'accounting_period',
          v_actor.resource_id::text, p_request_id,
          jsonb_build_object('startDate', to_char(v_period.start_date, 'YYYY-MM-DD'),
                             'endDate', to_char(v_period.end_date, 'YYYY-MM-DD'),
                             'previousStatus', 'open', 'status', 'closed'));

  INSERT INTO outbox_events (tenant_id, business_id, type, payload)
  VALUES (v_actor.tenant_id, v_actor.business_id, 'accounting.period.closed',
          jsonb_build_object('periodId', v_actor.resource_id, 'businessId', v_actor.business_id,
                             'startDate', to_char(v_period.start_date, 'YYYY-MM-DD'),
                             'endDate', to_char(v_period.end_date, 'YYYY-MM-DD'),
                             'status', 'closed'));

  RETURN QUERY SELECT v_actor.resource_id, true;
EXCEPTION
  WHEN unique_violation THEN
    IF SQLERRM LIKE '%accounting_period%' THEN
      RAISE EXCEPTION 'accounting.idempotency_conflict: this idempotency key already performed a period operation' USING ERRCODE = 'P0001';
    END IF;
    RAISE;
END;
$$;

COMMENT ON FUNCTION accounting_period_close(UUID, TEXT) IS
  'Closes one accounting period (directive §30). The closing actor and instant come from the verified assertion and from the database clock; there is no parameter through which a caller could state either. Closing posts nothing — it records a decision, and from then on the posting guard refuses new entries dated inside the period.';

CREATE OR REPLACE FUNCTION accounting_period_reopen(
  p_operation_id UUID,
  p_reason       TEXT,
  p_request_id   TEXT
) RETURNS TABLE (period_id UUID, changed BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_actor  accounting_verified_control_actor;
  v_tenant UUID;
  v_reason TEXT;
  v_digest TEXT;
  v_fp     TEXT;
  v_op     accounting_period_operations%ROWTYPE;
  v_period accounting_periods%ROWTYPE;
BEGIN
  v_actor := accounting_control_actor(ARRAY['period_reopen']);

  IF p_operation_id IS NULL THEN
    RAISE EXCEPTION 'accounting.payload_missing_field: a period command states its operation identity' USING ERRCODE = 'P0001';
  END IF;

  -- §17, §20: trim exactly as the fingerprint specification says, then refuse
  -- an empty or oversized reason. The STORED reason is the trimmed text, so
  -- the bytes the audit trail carries are the bytes that were signed.
  v_reason := btrim(coalesce(p_reason, ''), E' \t\n\r');
  IF v_reason = '' THEN
    RAISE EXCEPTION 'accounting.period_reopen_reason_required: reopening a period requires a reason' USING ERRCODE = 'P0001';
  END IF;
  IF length(v_reason) > 500 THEN
    RAISE EXCEPTION 'accounting.period_reopen_reason_required: a reopen reason is at most 500 characters' USING ERRCODE = 'P0001';
  END IF;
  v_digest := accounting_period_reason_digest(v_reason);

  v_fp := accounting_period_fingerprint('period_reopen', v_actor.tenant_id, v_actor.business_id,
                                        p_operation_id, v_actor.resource_id, NULL, NULL, v_digest);
  IF v_fp <> v_actor.payload_fingerprint THEN
    RAISE EXCEPTION 'accounting.assertion_payload_mismatch: the submitted command is not the command that was authorized' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(accounting_period_topology_lock_key(v_actor.business_id));
  SELECT b.tenant_id INTO v_tenant FROM businesses b WHERE b.id = v_actor.business_id FOR UPDATE;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'accounting.forbidden: the accounting assertion names a business that does not exist' USING ERRCODE = 'P0001';
  END IF;
  IF v_tenant IS DISTINCT FROM v_actor.tenant_id THEN
    RAISE EXCEPTION 'accounting.forbidden: the accounting assertion tenant does not own the named business' USING ERRCODE = 'P0001';
  END IF;

  -- THE HAZARD (§18, §40). This lookup happens BEFORE the period's state is
  -- read. An old reopen replayed after the merchant closed the period again
  -- is answered from this record — the original result, no transition, no
  -- audit, no event. Deciding from current state instead would reopen a
  -- period the merchant deliberately closed.
  SELECT * INTO v_op FROM accounting_period_operations o
  WHERE o.business_id = v_actor.business_id AND o.id = p_operation_id;
  IF FOUND THEN
    IF v_op.payload_fingerprint = v_fp THEN
      RETURN QUERY SELECT v_op.period_id, false;
      RETURN;
    END IF;
    RAISE EXCEPTION 'accounting.idempotency_conflict: this idempotency key already performed a different period operation' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_period FROM accounting_periods p
  WHERE p.business_id = v_actor.business_id AND p.id = v_actor.resource_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'accounting.period_not_found: this business has no such accounting period' USING ERRCODE = 'P0001';
  END IF;
  IF v_period.status <> 'closed' THEN
    RAISE EXCEPTION 'accounting.period_not_closed: this accounting period is already open (business %, period %)', v_actor.business_id, v_actor.resource_id
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE accounting_periods
  SET status = 'open',
      closed_at = NULL,
      closed_by_user_id = NULL,
      last_reopened_at = now(),
      last_reopened_by_user_id = v_actor.actor_user_id,
      last_reopen_reason = v_reason
  WHERE business_id = v_actor.business_id AND id = v_actor.resource_id;

  INSERT INTO accounting_period_operations (tenant_id, business_id, id, operation_kind, period_id, payload_fingerprint, resulting_status, actor_user_id)
  VALUES (v_actor.tenant_id, v_actor.business_id, p_operation_id, 'period_reopen', v_actor.resource_id, v_fp, 'open', v_actor.actor_user_id);

  -- The audit trail carries the reason. It is the record a reviewer reads,
  -- and a reopen nobody explained is a reopen nobody can review (§17, §33).
  INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, request_id, metadata)
  VALUES (v_actor.tenant_id, v_actor.business_id, v_actor.actor_user_id, 'accounting.period_reopened', 'accounting_period',
          v_actor.resource_id::text, p_request_id,
          jsonb_build_object('startDate', to_char(v_period.start_date, 'YYYY-MM-DD'),
                             'endDate', to_char(v_period.end_date, 'YYYY-MM-DD'),
                             'previousStatus', 'closed', 'status', 'open',
                             'reason', v_reason));

  -- The outbox does NOT (§34). It carries identifiers, dates and state; the
  -- reason is free merchant text, and an event bus is read by more systems,
  -- retained longer and exported more widely than the audit trail is.
  INSERT INTO outbox_events (tenant_id, business_id, type, payload)
  VALUES (v_actor.tenant_id, v_actor.business_id, 'accounting.period.reopened',
          jsonb_build_object('periodId', v_actor.resource_id, 'businessId', v_actor.business_id,
                             'startDate', to_char(v_period.start_date, 'YYYY-MM-DD'),
                             'endDate', to_char(v_period.end_date, 'YYYY-MM-DD'),
                             'status', 'open'));

  RETURN QUERY SELECT v_actor.resource_id, true;
EXCEPTION
  WHEN unique_violation THEN
    IF SQLERRM LIKE '%accounting_period%' THEN
      RAISE EXCEPTION 'accounting.idempotency_conflict: this idempotency key already performed a period operation' USING ERRCODE = 'P0001';
    END IF;
    RAISE;
END;
$$;

COMMENT ON FUNCTION accounting_period_reopen(UUID, TEXT, TEXT) IS
  'Reopens one closed accounting period (directive §31). The reason is MANDATORY, trimmed of space/tab/LF/CR, bounded at 500 characters and written to the audit trail — and deliberately NOT to the outbox (§34). A replayed reopen is answered from the operation registry, so an old request retried after a later close does not reopen the period again (§18, §40).';

-- ─────────────────────────────────────────────────────────────────────────
-- 11. Permissions (§21).
--
-- Exactly two keys, both SENSITIVE, registered in
-- packages/domain-core/src/permissions.ts — the closed registry — and
-- persisted here for the OWNER role of every existing business, exactly as
-- 0041 did for the five P2-S1 keys.
--
--   accounting.period.manage   create and close
--   accounting.period.reopen   reopen, and ONLY reopen
--
-- Reopen is NOT implied by manage. Closing a period is the ordinary end of a
-- month; undoing a close after the fact is a different decision, made less
-- often, by fewer people, and worth being able to delegate separately. A
-- system that treated them as one authority could not express "this person
-- closes the books, that person may undo it".
--
-- No new built-in role. Manager and cashier gain nothing here: their
-- permission lists are explicit, so a new registry key reaches neither. The
-- owner's authority is role IDENTITY (business_roles.is_system AND
-- key = 'owner'), and the delegation ceiling is untouched.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_new TEXT[] := ARRAY['accounting.period.manage', 'accounting.period.reopen'];
  v_bad TEXT;
BEGIN
  INSERT INTO role_permissions (business_id, role_id, permission)
  SELECT r.business_id, r.id, p.permission
  FROM business_roles r
  CROSS JOIN unnest(v_new) AS p(permission)
  WHERE r.is_system AND r.key = 'owner'
  ON CONFLICT (business_id, role_id, permission) DO NOTHING;

  SELECT string_agg(r.business_id::text, ', ' ORDER BY r.business_id::text) INTO v_bad
  FROM business_roles r
  WHERE r.is_system AND r.key = 'owner'
    AND (SELECT count(*) FROM role_permissions rp
         WHERE rp.business_id = r.business_id AND rp.role_id = r.id
           AND rp.permission = ANY (v_new)) <> array_length(v_new, 1);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'accounting.permission_backfill_incomplete: owner role incomplete for business(es) %', v_bad;
  END IF;

  SELECT string_agg(DISTINCT r.key, ', ') INTO v_bad
  FROM role_permissions rp
  JOIN business_roles r ON r.business_id = rp.business_id AND r.id = rp.role_id
  WHERE rp.permission = ANY (v_new)
    AND NOT (r.is_system AND r.key = 'owner');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'accounting.permission_backfill_overreach: non-owner role(s) hold period permissions: %', v_bad;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 12. Ownership and the final ACL (§35).
--
-- The ACL is set while the MIGRATOR still owns these functions, and the
-- ownership transfer follows. That order matters on a managed PostgreSQL: a
-- non-superuser migrator is a member of the internal principal WITH INHERIT
-- FALSE, so once a function belongs to that principal a REVOKE issued by the
-- migrator matches no grantor, PostgreSQL emits a WARNING instead of an error,
-- and the migration commits with PUBLIC still able to execute. Do not reorder.
-- ─────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION accounting_period_reason_digest(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_period_canonical(TEXT, UUID, UUID, UUID, UUID, DATE, DATE, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_period_fingerprint(TEXT, UUID, UUID, UUID, UUID, DATE, DATE, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_period_topology_lock_key(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_period_guard_posting() FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_periods_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_periods_no_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_period_operations_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_period_create(UUID, DATE, DATE, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_period_close(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_period_reopen(UUID, TEXT, TEXT) FROM PUBLIC;

-- The merchant runtime, and no other runtime role. Managing periods is
-- financial authority; a platform or worker credential has no part in it.
GRANT EXECUTE ON FUNCTION accounting_period_create(UUID, DATE, DATE, TEXT) TO daftar_app;
GRANT EXECUTE ON FUNCTION accounting_period_close(UUID, TEXT) TO daftar_app;
GRANT EXECUTE ON FUNCTION accounting_period_reopen(UUID, TEXT, TEXT) TO daftar_app;

-- The elevated commands run AS the internal principal and call the helpers by
-- name, so those are OWNED by it rather than granted to it — 0045's and
-- 0048's pattern, for the same reason: an EXECUTE grant would be an ACL entry
-- on an internal routine, and the rule is "no runtime role or PUBLIC may call
-- an internal accounting routine", stated as an empty ACL.
--
-- The posting guard is SECURITY DEFINER and must read `accounting_periods`
-- whatever the writer's own privileges are, so it is owned by the internal
-- principal too. The two pure raise-only triggers are not: they read nothing,
-- they are not SECURITY DEFINER, and elevating them would widen the internal
-- principal's surface for no property gained — the same call 0046 and 0048
-- make for their immutability triggers.
ALTER FUNCTION accounting_period_reason_digest(TEXT) OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_period_canonical(TEXT, UUID, UUID, UUID, UUID, DATE, DATE, TEXT) OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_period_fingerprint(TEXT, UUID, UUID, UUID, UUID, DATE, DATE, TEXT) OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_period_topology_lock_key(UUID) OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_period_guard_posting() OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_period_create(UUID, DATE, DATE, TEXT) OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_period_close(UUID, TEXT) OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_period_reopen(UUID, TEXT, TEXT) OWNER TO daftar_accounting_internal;

-- Hand back the ownership-transfer authority from section 1.
REVOKE CREATE ON SCHEMA public FROM daftar_accounting_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 13. Refuse to commit unless the end state is exactly right.
--
-- Everything asserted here is also proven from the live catalogue by the
-- P2-S6 matrices. Asserting it in the migration too means a deployment that
-- somehow diverges fails at deploy time rather than at the first close.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_role  TEXT;
  v_priv  TEXT;
  v_count INTEGER;
BEGIN
  -- (a) No runtime login role may WRITE either table, and PUBLIC may not
  --     touch them at all. The migrator is excluded: it owns them and
  --     PostgreSQL gives an owner rights that cannot be revoked — which is
  --     precisely why the triggers in section 6 refuse it too.
  FOR v_role IN
    SELECT unnest(ARRAY['daftar_app', 'daftar_platform', 'daftar_worker', 'daftar_identity', 'daftar_resolver', 'daftar_provisioner', 'public'])
  LOOP
    FOR v_priv IN SELECT unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'])
    LOOP
      IF has_table_privilege(v_role, 'accounting_periods', v_priv) THEN
        RAISE EXCEPTION 'accounting.period_registry_exposed: % holds % on accounting_periods', v_role, v_priv;
      END IF;
      IF has_table_privilege(v_role, 'accounting_period_operations', v_priv) THEN
        RAISE EXCEPTION 'accounting.period_registry_exposed: % holds % on accounting_period_operations', v_role, v_priv;
      END IF;
    END LOOP;
  END LOOP;

  -- (b) Not even the internal principal may DELETE. Append-only and
  --     transition-only are properties of the GRANT as well as of the trigger.
  IF has_table_privilege('daftar_accounting_internal', 'accounting_periods', 'DELETE')
     OR has_table_privilege('daftar_accounting_internal', 'accounting_period_operations', 'DELETE')
     OR has_table_privilege('daftar_accounting_internal', 'accounting_period_operations', 'UPDATE') THEN
    RAISE EXCEPTION 'accounting.period_registry_invalid: the internal principal must hold no DELETE on either period table and no UPDATE on the operation registry';
  END IF;

  -- (c) Exactly one runtime reader of the periods, and none of the registry.
  FOR v_role IN SELECT unnest(ARRAY['daftar_platform', 'daftar_worker', 'daftar_identity', 'daftar_resolver', 'daftar_provisioner', 'public'])
  LOOP
    IF has_table_privilege(v_role, 'accounting_periods', 'SELECT') THEN
      RAISE EXCEPTION 'accounting.period_registry_exposed: % may read accounting_periods and has no requirement to (§35)', v_role;
    END IF;
  END LOOP;
  FOR v_role IN SELECT unnest(ARRAY['daftar_app', 'daftar_platform', 'daftar_worker', 'daftar_identity', 'daftar_resolver', 'daftar_provisioner', 'public'])
  LOOP
    IF has_table_privilege(v_role, 'accounting_period_operations', 'SELECT') THEN
      RAISE EXCEPTION 'accounting.period_registry_exposed: % may read accounting_period_operations — internal command identities are not a merchant surface (§32)', v_role;
    END IF;
  END LOOP;
  IF NOT has_table_privilege('daftar_app', 'accounting_periods', 'SELECT') THEN
    RAISE EXCEPTION 'accounting.period_registry_invalid: the merchant runtime cannot read the periods it is meant to show';
  END IF;

  -- (d) The three commands are executable by the merchant runtime and nobody else.
  FOR v_role IN SELECT unnest(ARRAY['daftar_platform', 'daftar_worker', 'daftar_identity', 'daftar_resolver', 'daftar_provisioner', 'public'])
  LOOP
    IF has_function_privilege(v_role, 'accounting_period_create(uuid,date,date,text)', 'EXECUTE')
       OR has_function_privilege(v_role, 'accounting_period_close(uuid,text)', 'EXECUTE')
       OR has_function_privilege(v_role, 'accounting_period_reopen(uuid,text,text)', 'EXECUTE') THEN
      RAISE EXCEPTION 'accounting.period_registry_exposed: % may manage accounting periods (§35)', v_role;
    END IF;
  END LOOP;
  FOR v_role IN SELECT unnest(ARRAY['daftar_app', 'daftar_platform', 'daftar_worker', 'daftar_identity', 'daftar_resolver', 'daftar_provisioner', 'public'])
  LOOP
    IF has_function_privilege(v_role, 'accounting_period_guard_posting()', 'EXECUTE') THEN
      RAISE EXCEPTION 'accounting.period_registry_exposed: % may execute the posting guard directly', v_role;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('daftar_app', 'accounting_period_create(uuid,date,date,text)', 'EXECUTE')
     OR NOT has_function_privilege('daftar_app', 'accounting_period_close(uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('daftar_app', 'accounting_period_reopen(uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'accounting.period_registry_invalid: the merchant runtime cannot manage periods';
  END IF;

  -- (e) The elevated routines belong to the unreachable NOLOGIN principal.
  SELECT count(*) INTO v_count
  FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
  WHERE p.proname IN ('accounting_period_create', 'accounting_period_close', 'accounting_period_reopen',
                      'accounting_period_canonical', 'accounting_period_fingerprint',
                      'accounting_period_reason_digest', 'accounting_period_topology_lock_key',
                      'accounting_period_guard_posting')
    AND r.rolname = 'daftar_accounting_internal';
  IF v_count <> 8 THEN
    RAISE EXCEPTION 'accounting.period_registry_invalid: the elevated period routines must be owned by daftar_accounting_internal (got %)', v_count;
  END IF;

  -- (f) G-5: every routine this file adds pins pg_temp LAST.
  SELECT count(*) INTO v_count
  FROM pg_proc p
  WHERE p.proname IN ('accounting_period_create', 'accounting_period_close', 'accounting_period_reopen',
                      'accounting_period_canonical', 'accounting_period_fingerprint',
                      'accounting_period_reason_digest', 'accounting_period_topology_lock_key',
                      'accounting_period_guard_posting', 'accounting_periods_transition',
                      'accounting_periods_no_delete', 'accounting_period_operations_immutable')
    AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) AS c WHERE c ~ '^search_path=.*,\s*pg_temp$');
  IF v_count <> 11 THEN
    RAISE EXCEPTION 'accounting.period_registry_invalid: % of 11 P2-S6 routines pin pg_temp last in their search_path (G-5)', v_count;
  END IF;

  -- (g) Both tables ENABLE and FORCE row level security, so even their owner
  --     is filtered.
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'accounting_periods' AND relrowsecurity AND relforcerowsecurity)
     OR NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'accounting_period_operations' AND relrowsecurity AND relforcerowsecurity) THEN
    RAISE EXCEPTION 'accounting.period_registry_invalid: both period tables must ENABLE and FORCE row level security (§35)';
  END IF;

  -- (h) The physical non-overlap constraint exists and is a real exclusion
  --     constraint, not a unique index somebody substituted for it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'accounting_periods' AND c.contype = 'x' AND c.conname = 'accounting_periods_no_overlap'
  ) THEN
    RAISE EXCEPTION 'accounting.period_registry_invalid: accounting_periods must carry the gist exclusion constraint that makes overlap physically impossible (§12)';
  END IF;

  -- (i) The posting guard is installed on journal_entries itself, not on a
  --     view, a rule or an application layer.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger tg JOIN pg_class t ON t.oid = tg.tgrelid
    WHERE t.relname = 'journal_entries' AND tg.tgname = 'accounting_period_guard' AND NOT tg.tgisinternal
  ) THEN
    RAISE EXCEPTION 'accounting.period_registry_invalid: the closed-period refusal must be a trigger on journal_entries (§23)';
  END IF;

  -- (j) P2-S6 registered no journal source and created no 0050 surface. A
  --     period is a decision, not a posting: closing one writes no entry.
  IF EXISTS (SELECT 1 FROM accounting_source_types WHERE source_type LIKE '%period%') THEN
    RAISE EXCEPTION 'accounting.period_registry_invalid: a period source type was registered — closing a period posts nothing (§8)';
  END IF;

  -- (k) Zero periods exist. This migration creates the MECHANISM; it invents
  --     no fiscal calendar and back-fills no history (§9, §28).
  SELECT count(*) INTO v_count FROM accounting_periods;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'accounting.period_registry_invalid: this migration must create no period (got %) — DAFTAR does not guess a merchant''s fiscal calendar (§9)', v_count;
  END IF;

  -- (l) The temporary CREATE is gone.
  IF has_schema_privilege('daftar_accounting_internal', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'accounting.period_registry_invalid: the temporary CREATE on schema public was not revoked';
  END IF;

  -- (m) Nothing gained BYPASSRLS, and the internal principal stays unreachable.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'daftar_accounting_internal' AND (rolcanlogin OR rolbypassrls OR rolsuper)) THEN
    RAISE EXCEPTION 'accounting.period_registry_invalid: daftar_accounting_internal must remain NOLOGIN, NOBYPASSRLS and NOSUPERUSER';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname LIKE 'daftar\_%' AND rolbypassrls) THEN
    RAISE EXCEPTION 'accounting.period_registry_invalid: a DAFTAR role holds BYPASSRLS (§35)';
  END IF;
END $$;
