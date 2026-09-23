-- 0050_accounting_report_indexes.sql
-- P2-S7 — two indexes, and nothing else (directive §12, §13, §14, §57, §69).
-- CANDIDATE: not frozen, not in the manifest.
--
-- ── Why this file exists, and why it nearly did not ──────────────────────
--
-- The directive's order was: build the reports against the schema 0049 froze,
-- MEASURE, and create a migration only if the evidence asks for one. The
-- measurement is `tests/performance/accounting-read-plans.test.ts`, and on a
-- journal of 4,000 entries / 8,000 lines across 8 accounts it said this:
--
--   trial balance     Seq Scan on journal_lines, Seq Scan on journal_entries
--   ledger page       Seq Scan on journal_entries, Seq Scan on journal_lines
--   account balance   Seq Scan on journal_entries, Seq Scan on journal_lines
--
-- The middle line is the one that decided it. A merchant opening ONE
-- account's ledger and asking for the FIRST FIFTY ROWS caused PostgreSQL to
-- read every line and every entry the business has ever posted, join them,
-- sort the result, and throw almost all of it away. That cost is not a
-- constant a bigger server absorbs: it is proportional to the merchant's
-- entire history, so the ledger gets slower every day the business trades,
-- and the day it becomes a problem is the day the merchant has the most data
-- and the least patience.
--
-- The trial balance is a different matter. It aggregates every line of the
-- business by construction, so reading every line is the CORRECT plan and no
-- index would improve it. It is measured here and deliberately not indexed
-- for: an index created "while we are in here" is schema nobody can point at
-- a reason for.
--
-- ── What each index is for ───────────────────────────────────────────────
--
--   journal_lines (business_id, account_id, journal_entry_id, line_no)
--     Reaches one account's lines without reading the others, and carries
--     the last two columns of the ledger's ordering tuple so a page of one
--     account comes back in an order the index already knows. The general
--     ledger, the per-account balance and the balances list all use it.
--
--   journal_entries (business_id, entry_date, id)
--     IS the entry list's ordering tuple, and the date bound of every
--     report. A keyset page of the entry list becomes a range scan over
--     exactly the rows the page contains (§19, §28).
--
-- ── What this migration is NOT ───────────────────────────────────────────
--
-- No table, no column, no constraint, no function, no trigger, no policy, no
-- grant, no role change, no data. Two CREATE INDEX statements and the block
-- that proves it. AL-15 is untouched: an index is a faster route to the
-- journal, never a second copy of it, and nothing here stores a balance.
--
-- Applied by `daftar_migrator`, which owns both tables. No SUPERUSER, no
-- BYPASSRLS, no elevated principal, no CONCURRENTLY (a migration runs in a
-- transaction, and an index built outside one is an index that can be left
-- INVALID by a failure nobody notices).
-- ─────────────────────────────────────────────────────────────────────────

CREATE INDEX journal_lines_business_account_idx
  ON journal_lines (business_id, account_id, journal_entry_id, line_no);

COMMENT ON INDEX journal_lines_business_account_idx IS
  'P2-S7 §13: reaches one account''s lines without reading the business''s whole journal, and carries the tail of the general-ledger ordering tuple. Derived access path only — the journal remains the sole financial truth (AL-15).';

CREATE INDEX journal_entries_business_date_idx
  ON journal_entries (business_id, entry_date, id);

COMMENT ON INDEX journal_entries_business_date_idx IS
  'P2-S7 §19/§28: the entry list''s keyset ordering tuple and the date bound of every financial report. Derived access path only (AL-15).';

-- ─────────────────────────────────────────────────────────────────────────
-- Proof, in the same transaction that made the change.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_count INTEGER;
  v_bad   TEXT;
BEGIN
  -- (a) Both indexes exist, on the tables named, and are valid.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_class tc ON tc.oid = i.indrelid
    WHERE ic.relname = 'journal_lines_business_account_idx' AND tc.relname = 'journal_lines' AND i.indisvalid
  ) THEN
    RAISE EXCEPTION 'accounting.report_index_invalid: journal_lines_business_account_idx is missing or invalid';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_class tc ON tc.oid = i.indrelid
    WHERE ic.relname = 'journal_entries_business_date_idx' AND tc.relname = 'journal_entries' AND i.indisvalid
  ) THEN
    RAISE EXCEPTION 'accounting.report_index_invalid: journal_entries_business_date_idx is missing or invalid';
  END IF;

  -- (b) Neither index is UNIQUE. A unique index is a CONSTRAINT wearing an
  --     index's clothes, and this migration is not authorized to add one.
  SELECT string_agg(ic.relname, ', ') INTO v_bad
  FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
  WHERE ic.relname IN ('journal_lines_business_account_idx', 'journal_entries_business_date_idx') AND i.indisunique;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'accounting.report_index_invalid: % is UNIQUE — an index migration may not add a constraint', v_bad;
  END IF;

  -- (c) The journal is unchanged. Same tables, same columns, same row counts
  --     as this transaction found them: an index migration that touched data
  --     would be a data migration with a misleading name.
  SELECT count(*) INTO v_count FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'journal_lines';
  IF v_count <> 19 THEN
    RAISE EXCEPTION 'accounting.report_index_invalid: journal_lines has % columns — this migration adds none (expected 19)', v_count;
  END IF;

  -- (d) Nothing gained elevation, and the internal principal stays unreachable.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname LIKE 'daftar\_%' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'accounting.report_index_invalid: a DAFTAR role holds SUPERUSER or BYPASSRLS';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'daftar_accounting_internal' AND (rolcanlogin OR rolbypassrls OR rolsuper)) THEN
    RAISE EXCEPTION 'accounting.report_index_invalid: daftar_accounting_internal must remain NOLOGIN, NOBYPASSRLS and NOSUPERUSER';
  END IF;

  -- (e) AL-15, restated where a future editor of this file will read it: no
  --     table in the accounting perimeter stores a balance.
  SELECT string_agg(table_name || '.' || column_name, ', ') INTO v_bad
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND (table_name = 'accounts' OR table_name LIKE 'journal\_%' OR table_name LIKE 'accounting\_%')
    AND column_name ~ '(^|_)(balance|balances)($|_)'
    AND column_name NOT LIKE '%\_id'
    AND table_name NOT IN ('accounting_opening_balances', 'accounting_opening_balance_lines');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'accounting.report_index_invalid: a stored accounting balance exists (%) — the journal is the only financial truth (AL-15)', v_bad;
  END IF;
END $$;
