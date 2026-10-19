-- Case helpers. Every refusal is asserted BY NAME — the constraint name or the
-- named condition in the message — never by "it throws": a case that accepts
-- any exception passes when the statement fails for an unrelated reason, which
-- is how a proof comes to protect nothing.
SET search_path = p8, public;

-- ROUND 27, the sixteenth challenger's S-5 (P2). A refusal is evidence only if
-- its SUBJECT exists. It measured `W-2` — the worker may not rewrite the
-- obligation key — with the row pointed at a uuid no fixture creates, and the
-- case PASSED, rc 0, `passes=98`, the same figure a clean run prints. The
-- reason is structural and it is not the permits vacuity in another costume:
-- the GRANT refuses the statement before any row is read, so `permission
-- denied` arrives whether the row is there or not, and `ROW_COUNT` is the wrong
-- instrument because a refused statement affects zero rows BY CONSTRUCTION.
-- A vacuous permits-case leaves a row unmoved, which is readable; a vacuous
-- refuses-case has nothing to read back, because the statement is SUPPOSED to
-- have no effect. So `W-2` would survive its own fixture being deleted,
-- renamed, or never created, and no figure in the run would move.
--
-- The guard is a WITNESS: a boolean the case declares, asserted BEFORE the
-- statement runs, naming the thing the refusal is about.
--
-- ROUND 28, F-B (P1). Round 27's witness was a FREE EXPRESSION beside the
-- statement, with nothing binding the two together. The coordinator's review
-- moved ONLY the statement's uuid to a nonexistent row, left the witness alone,
-- and `W-2` printed PASS at `passes=98` — the witness was true of a row the
-- statement no longer touched. Round 27's own arm could not see it, because
-- that arm retargets both halves at once: it tests the pair moving TOGETHER,
-- which is the one way they cannot diverge.
--
-- So the subject is now ONE value, passed once, and substituted into both. A
-- case cannot write a witness about a different row than its statement reads,
-- because there is no second place to write a row in. `@SUBJECT@` stands for
-- the subject as a quoted literal; the WITNESS must contain it, and the
-- STATEMENT must contain it or the subject's own text, so a statement that
-- stops naming its subject is refused BY NAME instead of passing.
--
-- The four-argument form is GONE rather than deprecated. A form that still
-- accepts an unbound witness is the hole, whatever its comment says.
DROP FUNCTION IF EXISTS p8.case_refuses(TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS p8.case_refuses_unwitnessed(TEXT, TEXT, TEXT);
CREATE OR REPLACE FUNCTION p8.case_refuses(label TEXT, stmt TEXT, expect TEXT, witness TEXT, subject TEXT) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE msg TEXT; sst TEXT; ok BOOLEAN; stmt2 TEXT; wit2 TEXT;
BEGIN
  IF subject IS NULL OR subject = '' THEN
    RAISE EXCEPTION '% FAIL: NO SUBJECT DECLARED — this form takes the subject as ONE value and '
                    'puts it in both the statement and the witness; an empty one binds nothing', label;
  END IF;
  IF position('@SUBJECT@' in witness) = 0 THEN
    RAISE EXCEPTION '% FAIL: SUBJECT NOT IN THE WITNESS — the witness "%" never mentions @SUBJECT@, '
                    'so it is a free expression again and can be true of something the statement '
                    'does not touch (F-B)', label, witness;
  END IF;
  IF position('@SUBJECT@' in stmt) = 0 AND position(subject in stmt) = 0 THEN
    RAISE EXCEPTION '% FAIL: SUBJECT NOT IN THE STATEMENT — the declared subject "%" appears in the '
                    'witness and NOT in the statement, which is exactly the divergence F-B '
                    'measured: a witness true of a row the statement no longer reads', label, subject;
  END IF;
  stmt2 := replace(stmt, '@SUBJECT@', quote_literal(subject));
  wit2  := replace(witness, '@SUBJECT@', quote_literal(subject));
  BEGIN
    EXECUTE 'SELECT (' || wit2 || ')::boolean' INTO ok;
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT, sst = RETURNED_SQLSTATE;
    RAISE EXCEPTION '% FAIL: the WITNESS itself could not be read — [%] %. A refusal whose '
                    'subject cannot even be looked for is not evidence', label, sst, msg;
  END;
  IF ok IS NOT TRUE THEN
    RAISE EXCEPTION '% FAIL: NO SUBJECT — the witness "%" is not true of subject "%", so the thing '
                    'this refusal is about is not there, and the refusal below would arrive whether '
                    'it existed or not. A refusal against an empty set measures nothing',
      label, witness, subject;
  END IF;
  PERFORM p8.case_refuses_core(label, stmt2, expect, true);
END $$;

-- ROUND 28, T-2. The paragraph above said the obligation is DERIVED from the
-- case's own declaration. The eighteenth challenge measured what that
-- derivation actually read: `position('permission denied' in lower(expect))`
-- reads the AUTHOR'S PROSE, which is a representation the subject controls.
-- It rewrote `W-2` in the three-argument form with `expect` spelled
-- `denied for table notifications` — a true substring of the real message,
-- SQLSTATE 42501, and WITHOUT the trigger phrase — pointed it at a dead uuid,
-- and **the baseline accepted it at `passes=98`**: S-5 again, through a
-- spelling the derivation did not cover, and invisible to the case-count
-- literal because no case was added or lost. `must be owner of table
-- notifications` is a second natural spelling with the same SQLSTATE.
--
-- So the obligation is now derived from EXECUTION and not from text: the
-- refusal that ARRIVES carries SQLSTATE 42501 (insufficient_privilege), the
-- server says so rather than the author, and no spelling of `expect` can move
-- it. This is the project's own rule — a derived subject set must not be
-- derived from a representation the subject can alter — applied to the one
-- place in this file that still broke it.
--
-- The prose test is KEPT, and demoted. It refuses BEFORE the statement runs,
-- which is a better message when it fires; it is no longer what makes the law
-- hold. Two gates, and the load-bearing one is the SQLSTATE.
CREATE OR REPLACE FUNCTION p8.case_refuses(label TEXT, stmt TEXT, expect TEXT) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF position('permission denied' in lower(expect)) > 0 THEN
    RAISE EXCEPTION '% FAIL: WITNESS REQUIRED — this case expects a PERMISSION denial ("%"), and a '
                    'grant refuses before any row is read, so the case would pass against an empty '
                    'set. Call the four-argument form with a boolean naming the subject this '
                    'refusal is about (S-5)', label, expect;
  END IF;
  PERFORM p8.case_refuses_core(label, stmt, expect, false);
END $$;

-- `case_refuses_unwitnessed` is DELETED, not kept and forbidden (round 28,
-- F-A). The coordinator's review dodged the witness requirement by calling it
-- directly, and a second door that a comment asks people not to use is still a
-- door. No case file ever called it (measured: 0 occurrences outside this
-- file), and the DROP above removes it from any database where an older copy of
-- this file created it.

CREATE OR REPLACE FUNCTION p8.case_refuses_core(label TEXT, stmt TEXT, expect TEXT, witnessed BOOLEAN) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE msg TEXT; cons TEXT; sst TEXT;
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT, cons = CONSTRAINT_NAME, sst = RETURNED_SQLSTATE;
    -- Derived from the refusal that ARRIVED, before its spelling is compared
    -- to anything the case wrote. 42501 is insufficient_privilege: a grant or
    -- ownership decision, taken before any row is looked at.
    --
    -- ONE class of 42501 is exempt, and the exemption is itself derived from
    -- the SERVER's words rather than the author's: a row-level security WITH
    -- CHECK refusal reads the row BEING WRITTEN, so its subject is in the
    -- statement by construction and a witness would restate it. Measured while
    -- writing this guard: `new row violates row-level security policy
    -- "business_isolation" for table "notifications"` arrives as 42501 too, and
    -- without this exemption the derivation obliged a witness for every
    -- isolation case in the pack — an over-reach, caught by the pack itself on
    -- the first run after the change.
    --
    -- The exemption fails CLOSED, which is why it is allowed to be a phrase: if
    -- a future PostgreSQL reworded it, the phrase would stop matching and the
    -- case would be OBLIGED to carry a witness. A wording change can only add
    -- obligation here, never remove it.
    IF NOT witnessed AND sst = '42501'
       AND position('row-level security policy' in lower(coalesce(msg,''))) = 0 THEN
      RAISE EXCEPTION '% FAIL: WITNESS REQUIRED — the refusal that arrived is SQLSTATE 42501 '
                      '(insufficient_privilege): a grant decision, taken before any row is read, '
                      'so this case would pass against an empty set whatever its expectation says. '
                      'The arriving refusal is what obliges it, not the wording of "%" — call the '
                      'four-argument form with a boolean naming the subject (S-5 / T-2). Got [%] %',
        label, expect, sst, msg;
    END IF;
    IF position(expect in coalesce(cons,'') || ' ' || coalesce(msg,'')) = 0 THEN
      RAISE EXCEPTION '% FAIL: refused, but NOT by "%" — got [%] % (constraint %)',
        label, expect, sst, msg, coalesce(cons,'none');
    END IF;
    RAISE NOTICE '% PASS refused by % [%]', label, expect, sst;
    RETURN;
  END;
  RAISE EXCEPTION '% FAIL: ACCEPTED — the refusal "%" never happened', label, expect;
END $$;

-- ROUND 26. A permits-case used to pass on one fact: the statement did not
-- raise. The sixteenth challenger measured what that costs. It pointed one
-- `WHERE id` at a uuid no fixture creates, so the UPDATE matched zero rows and
-- raised nothing, and **five of the seven UPDATE permits-cases passed with the
-- statement they name never touching a row** — at the same `passes=91`, so no
-- figure in the run told an exercised case from an unexercised one. My own
-- answer to it had been an argument rather than a measurement: that the ladder
-- runs on one row, so a neutered `I3-a` would be caught downstream by `I3-d`.
-- It is not. **The chain self-heals**: with `I3-a` neutered the row stays at
-- `queued`, `I3-b` becomes `queued -> delivered`, which is still a forward move
-- and still permitted, the row still reaches `read`, and `I3-d` is still
-- correctly refused. Only `I3-g` and `N6-a` were caught, each for a reason
-- specific to it — a downstream refusal that happens to become a permitted
-- move. A protection that holds by accident in two places out of seven is not a
-- protection.
--
-- So the obligation moves HERE, where it cannot be forgotten, instead of into
-- seven read-backs. Read-backs assert the VALUE the statement wrote and this
-- asserts that it wrote ANYTHING: both are needed, and only this one covers a
-- case nobody has written yet. An enumerated set of read-backs fixes the shape
-- hole and leaves the time hole open, because it cannot name a case that does
-- not exist. The default is now fail-closed: **a permits-case whose statement
-- affects no row is a refusal, by name.** A case that genuinely means zero must
-- say so through `case_permits_rows`, and saying so is itself a claim that goes
-- red when it stops being true.
CREATE OR REPLACE FUNCTION p8.case_permits_rows(label TEXT, stmt TEXT, want BIGINT) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE msg TEXT; sst TEXT; n BIGINT;
BEGIN
  BEGIN
    EXECUTE stmt;
    GET DIAGNOSTICS n = ROW_COUNT;
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT, sst = RETURNED_SQLSTATE;
    RAISE EXCEPTION '% FAIL: REFUSED, and it should not be — [%] %', label, sst, msg;
  END;
  IF want IS NULL THEN
    IF n = 0 THEN
      RAISE EXCEPTION '% FAIL: VACUOUS — permitted, and the statement affected 0 rows, so this '
                      'case asserts nothing about what it claims. A permits-case claims the '
                      'statement DID the thing; if zero rows is the point, say so with '
                      'case_permits_rows(label, stmt, 0)', label;
    END IF;
    RAISE NOTICE '% PASS permitted, % row(s)', label, n;
    RETURN;
  END IF;
  IF n <> want THEN
    RAISE EXCEPTION '% FAIL: permitted, but affected % row(s) and this case DECLARES %', label, n, want;
  END IF;
  RAISE NOTICE '% PASS permitted, % row(s) as declared', label, n;
END $$;

CREATE OR REPLACE FUNCTION p8.case_permits(label TEXT, stmt TEXT) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM p8.case_permits_rows(label, stmt, NULL);
END $$;

CREATE OR REPLACE FUNCTION p8.case_equals(label TEXT, got ANYELEMENT, want ANYELEMENT) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF got IS DISTINCT FROM want THEN
    RAISE EXCEPTION '% FAIL: got %, want %', label, got, want;
  END IF;
  RAISE NOTICE '% PASS % = %', label, got, want;
END $$;
