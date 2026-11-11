-- 0090_mvp03_ar_source_document_guard.sql
-- ─────────────────────────────────────────────────────────────────────────
-- 0090 — MVP-03 / DR-114/ثالثًا/2 and /3: a journal line on the receivable
--        control account, or on the customer credit liability, must belong to
--        an entry that a SALES DOCUMENT owns.
--
-- WHY, MEASURED AND NOT REASONED. The probe on `diag/mvp03-ar-source` @
-- `0451ef6a` (CI run 42875894978; evidence
-- `.local-context/evidence/MVP03_SOURCE_OF_TRUTH_2026-11-10_AR.md` §12) asked
-- both derivations of a customer's debt after nine events. Through every path
-- that goes by a sales document the two agreed EXACTLY — delta 0, every minor
-- unit attributable to a named customer. Then
-- `accounting_post_manual_adjustment` debited `accounts_receivable` directly:
-- 123,456 minor units, ACCEPTED, entry
-- 79269c76-ea51-4ce1-919c-63e97d8d6856. The journal then held debt that no
-- join can put behind any customer's name, because `journal_lines` carries
-- `branch_id` and `warehouse_id` and NO counterparty column (`0042`), and the
-- statement a merchant reads is derived from the sales documents
-- (`customer_ar_outstanding`, `0084:627`) and never from the journal
-- (`0084:263` forbids "no journal read as an alternate authority"). The same
-- command credited `customer_credit_liability` with 65,432 and was accepted
-- too. So the statement and the control account could be made to disagree,
-- today, through a command granted to `daftar_app` (`0045:867`).
--
-- THE TWO ALLOW-LISTS ARE MEASURED, NOT ASSUMED.
--
--   accounts_receivable        invoice                      0077:1457, the one
--                                                           place an `invoice`
--                                                           entry names the key
--                              customer_payment_allocation  0081:1500/1503
--                              customer_credit_application  0081:1588/1591
--
--   customer_credit_liability  customer_credit              0081:1682
--                              customer_credit_application  0081:1594/1597
--
-- A sweep of every migration on `main` @ 4c878e0f for the two quoted keys hits
-- only 0040, 0075, 0077, 0080 and 0081; outside the three entry-complete
-- functions of 0081 and `accounting_invoice_entry_complete` of 0077 the
-- mentions are reads. `sale` posts cogs and inventory and never AR (0080's
-- own note), and a cash invoice debits `cash` instead (0077:1457).
--
-- A `reversal` IS allowed, but only TRANSITIVELY: the entry it reverses must
-- itself be one of that account's sales documents. `accounting_post_reversal`
-- writes `source_type = 'reversal'` and `source_id = p_original_entry_id`
-- (0046), so the original is reachable by that key and the question is
-- answerable in one lookup. This is a temporary decision of the MVP-03 lane
-- (MVP03-م-1 in `.local-context/OWNER_QUEUE_AR.md`), taken because the
-- alternative — an absolute ban — would, with the write-off reducer deferred
-- by DR-114/ثالثًا/1, leave a wrongly posted invoice permanently
-- uncorrectable, which is a worse fault than the one being prevented.
--
-- `manual_adjustment` and `opening_balance` are refused on both accounts.
-- The opening-balance arm is its own owner decision (DR-114/ثالثًا/3 and /4):
-- a merchant's old customer balances are entered as a HISTORICAL INVOICE per
-- customer, with no exception, because `accounting_open_balance_post` is
-- granted to `daftar_app` (`0047:1049`) and its only restriction is that
-- `opening_equity` may not be stated as a position (`0047:519`) — so AR is
-- open to it today, and an opening AR position is debt that belongs to no
-- customer by construction.
--
-- WHERE THE GUARD SITS. On `journal_lines`, per DR-114/ثالثًا/2, as a
-- DEFERRABLE INITIALLY DEFERRED constraint trigger: the line names the
-- account, so the question "may this account hold this money" is a property
-- of the line and not of the entry. Deferred because the entry and its lines
-- are written in one transaction and the entry's row must be visible before
-- its `source_type` can be read. `journal_lines` is append-only on this head,
-- so AFTER INSERT alone is the whole surface.
--
-- WHAT THIS MIGRATION DOES NOT DO. It does not touch a sealed function, it
-- does not touch `frozenThrough = 0079`, it replaces nothing, and it adds no
-- production code for any phase from P5 to P15 (DR-05). It only adds one
-- function and one constraint trigger.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION accounting_ar_control_line_source_document()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_system_key  TEXT;
  v_source_type TEXT;
  v_source_id   UUID;
  v_origin_type TEXT;
  v_judged      TEXT;
BEGIN
  -- One lookup, two primary-key reads, and it returns nothing at all unless
  -- this line sits on one of the two guarded accounts. Every other line in
  -- the ledger pays exactly this and no more.
  SELECT a.system_key, e.source_type, e.source_id
    INTO v_system_key, v_source_type, v_source_id
    FROM accounts a
    JOIN journal_entries e
      ON e.business_id = NEW.business_id AND e.id = NEW.journal_entry_id
   WHERE a.business_id = NEW.business_id
     AND a.id = NEW.account_id
     AND a.system_key IN ('accounts_receivable', 'customer_credit_liability');
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- A reversal is judged by what it reverses, never by itself.
  v_judged := v_source_type;
  IF v_source_type = 'reversal' THEN
    SELECT o.source_type INTO v_origin_type
      FROM journal_entries o
     WHERE o.business_id = NEW.business_id AND o.id = v_source_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'accounting.ar_source_document_required: MVP03_AR_SOURCE_DOCUMENT_GUARD — a reversal on % must name the entry it reverses, and entry % was not found in this business',
        v_system_key, v_source_id
        USING ERRCODE = 'P0001';
    END IF;
    v_judged := v_origin_type;
  END IF;

  IF (v_system_key = 'accounts_receivable'
        AND v_judged IN ('invoice', 'customer_payment_allocation', 'customer_credit_application'))
     OR (v_system_key = 'customer_credit_liability'
        AND v_judged IN ('customer_credit', 'customer_credit_application'))
  THEN
    RETURN NULL;
  END IF;

  RAISE EXCEPTION
    'accounting.ar_source_document_required: MVP03_AR_SOURCE_DOCUMENT_GUARD — a journal line on % must belong to a sales document; source_type % (judged as %) is not one, so this money would belong to no customer. Correct the customer through a sales document.',
    v_system_key, v_source_type, v_judged
    USING ERRCODE = 'P0001';
END;
$$;

REVOKE ALL ON FUNCTION accounting_ar_control_line_source_document() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER journal_lines_ar_control_source_document
  AFTER INSERT ON journal_lines DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION accounting_ar_control_line_source_document();

-- The ownership transfer needs the schema's CREATE privilege FOR THE NEW
-- OWNER: `ALTER FUNCTION … OWNER TO` is refused without it, and the role holds
-- none standing — `bootstrap.sql:198` grants `daftar_accounting_internal`
-- schema USAGE only, by name and on purpose. So the grant is opened for this
-- one statement and closed again immediately, which is this estate's own
-- convention and not an invention here: measured over
-- `infrastructure/database/migrations/`, 56 executable
-- GRANT/REVOKE CREATE-on-public pairs in 34 migrations precede this one, 23 of
-- them for this very role (`0040:263`/`:471`, `0069:223`/`:257`,
-- `0081:1388`/`:1742`), and no file in that set grants without revoking.
--
-- A CORRECTION TO WHAT THIS FILE SAID BEFORE, measured: it claimed the
-- statement would be REFUSED under the deployment authority `daftar_migrator`
-- and that a superuser CI run hid that. It would not. The project's own runner
-- lends CREATE on `public` to every `OWNER TO daftar_*` target of a file for
-- the length of that file's transaction and takes it back inside the same
-- transaction (`apps/api/src/infra/migrate.ts:64-68` and `:106-111`, which
-- calls a file that revokes it itself "the intended overlap"). And the tail is
-- applied as that NOSUPERUSER role by a suite, not only as `postgres`:
-- `tests/integration/migration-portability.test.ts:841` with the role proved
-- `rolsuper:false` at `:234` — step #26 «Integration + security tests» was
-- `success` both before this bracket (`43028057105` on `d97ef0d6`) and after
-- it (`43053033501` on `9c587078`).
--
-- So this bracket is not a repair of a refusal. It is what the estate's every
-- other handover does, and it is the defence for an apply that does not go
-- through `migrate.ts` — a direct `psql` run, where nothing lends the
-- privilege. The `REVOKE` is the file's last statement, which keeps
-- `migration-portability.test.ts:1558` true: the role holds no CREATE once the
-- file has run. The wording this replaces was mine and was not measured;
-- `daftar-reviewer` caught it in the narrow confirming round.
GRANT CREATE ON SCHEMA public TO daftar_accounting_internal;

ALTER FUNCTION accounting_ar_control_line_source_document() OWNER TO daftar_accounting_internal;

REVOKE CREATE ON SCHEMA public FROM daftar_accounting_internal;
