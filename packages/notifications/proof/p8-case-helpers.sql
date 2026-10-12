-- Case helpers. Every refusal is asserted BY NAME — the constraint name or the
-- named condition in the message — never by "it throws": a case that accepts
-- any exception passes when the statement fails for an unrelated reason, which
-- is how a proof comes to protect nothing.
SET search_path = p8, public;

CREATE OR REPLACE FUNCTION p8.case_refuses(label TEXT, stmt TEXT, expect TEXT) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE msg TEXT; cons TEXT; sst TEXT;
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT, cons = CONSTRAINT_NAME, sst = RETURNED_SQLSTATE;
    IF position(expect in coalesce(cons,'') || ' ' || coalesce(msg,'')) = 0 THEN
      RAISE EXCEPTION '% FAIL: refused, but NOT by "%" — got [%] % (constraint %)',
        label, expect, sst, msg, coalesce(cons,'none');
    END IF;
    RAISE NOTICE '% PASS refused by % [%]', label, expect, sst;
    RETURN;
  END;
  RAISE EXCEPTION '% FAIL: ACCEPTED — the refusal "%" never happened', label, expect;
END $$;

CREATE OR REPLACE FUNCTION p8.case_permits(label TEXT, stmt TEXT) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE msg TEXT; sst TEXT;
BEGIN
  EXECUTE stmt;
  RAISE NOTICE '% PASS permitted', label;
EXCEPTION WHEN others THEN
  GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT, sst = RETURNED_SQLSTATE;
  RAISE EXCEPTION '% FAIL: REFUSED, and it should not be — [%] %', label, sst, msg;
END $$;

CREATE OR REPLACE FUNCTION p8.case_equals(label TEXT, got ANYELEMENT, want ANYELEMENT) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF got IS DISTINCT FROM want THEN
    RAISE EXCEPTION '% FAIL: got %, want %', label, got, want;
  END IF;
  RAISE NOTICE '% PASS % = %', label, got, want;
END $$;
