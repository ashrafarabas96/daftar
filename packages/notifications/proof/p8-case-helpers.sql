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
-- ROUND 29, U-2. The sentinel subject: a syntactically valid uuid that no
-- fixture in this pack creates, declared ONCE here so that the value the witness
-- test uses and the value the refusal names are the same value. It is a function
-- rather than a literal repeated at each site because two spellings of one
-- constant is the shape this phase has paid for before.
CREATE OR REPLACE FUNCTION p8.sentinel_subject() RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$ SELECT 'ffffffff-ffff-4fff-8fff-ffffffffffff'::TEXT $$;

-- ROUND 29, U-3/U-7. The identifier substitution ALWAYS quotes. `quote_ident`
-- does not: for a plain lower-case name it returns the name unchanged, so
-- `quote_ident('notifications')` is the bare word `notifications`, and a check
-- that the statement contains it is satisfied by `UPDATE notifications` written
-- by hand — the substring test U-3 was about, reappearing inside the function
-- that was meant to replace it. Measured while writing this: a direct call
-- claiming subject `notifications` over a hand-written `UPDATE notifications`
-- passed. With the quotes always present, the only way a statement carries this
-- form is if this substitution put it there.
CREATE OR REPLACE FUNCTION p8.quoted_ident(t TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$ SELECT '"' || replace(t, '"', '""') || '"' $$;

DROP FUNCTION IF EXISTS p8.case_refuses(TEXT, TEXT, TEXT, TEXT);
-- ROUND 29, U-7. The four-argument core with a caller-supplied BOOLEAN is
-- dropped by signature, so no database carrying an older copy of this file keeps
-- a door this one closed.
DROP FUNCTION IF EXISTS p8.case_refuses_core(TEXT, TEXT, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS p8.case_refuses_unwitnessed(TEXT, TEXT, TEXT);
-- ROUND 29. THE WITNESS IS NO LONGER SUPPLIED BY THE CASE.
--
-- Round 28 took an author-written witness and required it to mention the
-- subject. Two reviewers broke that in three ways in one round:
--
--   U-2  `@SUBJECT@ IS NOT NULL` mentions the subject, evaluates TRUE, reads
--        nothing, and the case passed against a uuid no fixture creates.
--   U-3  `position(subject in stmt)` is satisfied by the subject's text in a
--        COMMENT: witness about `notifications`, statement about
--        `notification_provider_quarantine`, accepted.
--   N-2  changing which subject is DECLARED converts a row case into a
--        relation case — statement `WHERE attempt_key = 'NO-SUCH-ATTEMPT'`,
--        subject `notification_attempts`, witness `to_regclass(@SUBJECT@) IS
--        NOT NULL` — and the whole gate stayed green at `passes=101`.
--
-- Every one of those is the same shape: the witness and the statement were two
-- texts a reviewer could move independently. Adding another test on the
-- witness's text would have been a fourth turn of the same screw. So the
-- witness is DERIVED here, from the same values the statement is built from,
-- and there is no witness argument to write. A case declares WHAT its refusal
-- is about, in one of exactly three forms, and this file constructs the
-- evidence:
--
--   case_refuses_row(label, stmt, expect, relation, key_column, key_value)
--       The refusal is about a ROW. The statement must carry @REL@ and @KEY@;
--       the witness built from them is `SELECT 1 FROM <relation> WHERE
--       <key_column> = <key_value>` and must return at least one row, and no
--       row for the sentinel key. Vacuity is impossible: the row is read.
--
--   case_refuses_relation(label, stmt, expect, relation)
--       The refusal is about a RELATION. The statement must carry @REL@ and
--       must contain NO key predicate — a statement with a WHERE is about a
--       row, and must say so, which is what closes N-2.
--
--   case_refuses_role(label, stmt, expect, role)
--       The refusal is about a ROLE, with the same no-WHERE rule.
--
-- The five-argument form is GONE. So is every argument a case could use to
-- say what its own evidence is.
DROP FUNCTION IF EXISTS p8.case_refuses(TEXT, TEXT, TEXT, TEXT, TEXT);

-- Comments are stripped before any binding test (the coordinator's N-2 ruling).
-- U-3 was a subject's text inside a comment; the same hole run the other way is
-- a PLACEHOLDER inside a comment satisfying the requirement that the statement
-- carry one. Neither survives reading the statement without its comments.
CREATE OR REPLACE FUNCTION p8.strip_sql_comments(t TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT regexp_replace(regexp_replace(t, '/\*.*?\*/', ' ', 'gs'), '--[^\n]*', ' ', 'g')
$$;

-- A case statement may not carry its own exception handler (the coordinator's
-- N-3). The witness law is derived from the SQLSTATE that ARRIVES, and a
-- `DO … EXCEPTION WHEN insufficient_privilege THEN RAISE EXCEPTION 'denied …'`
-- re-raises a permission denial as P0001, which the derivation cannot see.
-- Refusing the handler is cheaper than reading through it.
CREATE OR REPLACE FUNCTION p8.assert_no_handler(label TEXT, stmt TEXT) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p8.strip_sql_comments(stmt) ~* '(^|[^a-z_])exception([^a-z_]|$)' THEN
    RAISE EXCEPTION '% FAIL: THE STATEMENT CARRIES AN EXCEPTION HANDLER — the witness law is '
                    'derived from the SQLSTATE that arrives, and a handler can re-raise a '
                    'permission denial as P0001, which that derivation cannot see (N-3). Write '
                    'the statement without a handler', label;
  END IF;
END $$;

-- The common binding test: the statement must be BUILT from the declared
-- relation, and may not reach for a row unless the form says it does.
CREATE OR REPLACE FUNCTION p8.assert_statement_built(label TEXT, stmt TEXT, what TEXT,
                                                     allow_key BOOLEAN) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE bare TEXT;
BEGIN
  bare := p8.strip_sql_comments(stmt);
  IF position('@REL@' in bare) = 0 THEN
    RAISE EXCEPTION '% FAIL: THE STATEMENT IS NOT BUILT FROM ITS SUBJECT — it does not carry @REL@ '
                    'outside a comment, so it is not a product of the declared subject "%" and the '
                    'evidence below could be about something else (F-B, U-3)', label, what;
  END IF;
  IF NOT allow_key AND bare ~* '(^|[^a-z_])where([^a-z_]|$)' THEN
    RAISE EXCEPTION '% FAIL: A RELATION CASE WITH A KEY PREDICATE — this form says the refusal is '
                    'about "%" itself, and the statement selects a row, so the refusal it measures '
                    'would arrive whether that row existed or not. Use case_refuses_row and declare '
                    'the key (N-2)', label, what;
  END IF;
  IF allow_key AND position('@KEY@' in bare) = 0 THEN
    RAISE EXCEPTION '% FAIL: A ROW CASE WITH NO KEY IN ITS STATEMENT — this form says the refusal '
                    'is about one row of "%", and the statement does not carry @KEY@ outside a '
                    'comment, so nothing ties the refusal to the row the witness reads', label, what;
  END IF;
END $$;

-- The derived witness, for all three forms: a query that must return at least
-- one row for the declared subject and NO row for a sentinel. The sentinel leg
-- is what makes the first leg a measurement rather than a shape: an expression
-- that answers the same way for both reads nothing (U-2).
CREATE OR REPLACE FUNCTION p8.assert_witness(label TEXT, what TEXT, query TEXT,
                                             sentinel_query TEXT) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE n BIGINT; m BIGINT; msg TEXT; sst TEXT;
BEGIN
  BEGIN
    EXECUTE 'SELECT count(*) FROM (' || query || ') p8w' INTO n;
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT, sst = RETURNED_SQLSTATE;
    RAISE EXCEPTION '% FAIL: THE WITNESS COULD NOT BE READ — [%] %. A refusal whose subject cannot '
                    'even be looked for is not evidence', label, sst, msg;
  END;
  IF n < 1 THEN
    RAISE EXCEPTION '% FAIL: NO SUBJECT — nothing answers for "%", so the thing this refusal is '
                    'about is not there and the refusal would arrive whether it existed or not. A '
                    'refusal against an empty set measures nothing (S-5)', label, what;
  END IF;
  BEGIN
    EXECUTE 'SELECT count(*) FROM (' || sentinel_query || ') p8w' INTO m;
  EXCEPTION WHEN others THEN
    m := 0;   -- the sentinel's shape reached the query, which is the property
  END;
  IF m > 0 THEN
    RAISE EXCEPTION '% FAIL: THE WITNESS DOES NOT READ ITS SUBJECT — it answers for "%" AND for a '
                    'sentinel that nothing creates, so it is true however the subject is spelled '
                    'and witnesses nothing (U-2)', label, what;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION p8.case_refuses_row(label TEXT, stmt TEXT, expect TEXT,
                                               relation TEXT, key_column TEXT, key_value TEXT)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE stmt2 TEXT; wq TEXT; sq TEXT;
BEGIN
  IF relation IS NULL OR relation = '' OR key_column IS NULL OR key_column = ''
     OR key_value IS NULL OR key_value = '' THEN
    RAISE EXCEPTION '% FAIL: NO SUBJECT DECLARED — a row case names the relation, the key column '
                    'and the key value, and all three are built into the statement and the '
                    'witness', label;
  END IF;
  IF key_value = p8.sentinel_subject() THEN
    RAISE EXCEPTION '% FAIL: THE SENTINEL IS NOT A SUBJECT — this case declares the sentinel value '
                    'itself as its key', label;
  END IF;
  PERFORM p8.assert_no_handler(label, stmt);
  PERFORM p8.assert_statement_built(label, stmt, relation || '.' || key_column, true);
  wq := 'SELECT 1 FROM ' || p8.quoted_ident(relation) || ' WHERE '
        || p8.quoted_ident(key_column) || '::text = ' || quote_literal(key_value);
  sq := 'SELECT 1 FROM ' || p8.quoted_ident(relation) || ' WHERE '
        || p8.quoted_ident(key_column) || '::text = ' || quote_literal(p8.sentinel_subject());
  PERFORM p8.assert_witness(label, relation || ' keyed by ' || key_column || ' = ' || key_value,
                            wq, sq);
  stmt2 := replace(replace(stmt, '@REL@', p8.quoted_ident(relation)),
                   '@KEY@', quote_literal(key_value));
  PERFORM p8.case_refuses_core(label, stmt2, expect, key_value);
END $$;

CREATE OR REPLACE FUNCTION p8.case_refuses_relation(label TEXT, stmt TEXT, expect TEXT,
                                                    relation TEXT)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE stmt2 TEXT; wq TEXT; sq TEXT;
BEGIN
  IF relation IS NULL OR relation = '' THEN
    RAISE EXCEPTION '% FAIL: NO SUBJECT DECLARED — a relation case names the relation its refusal '
                    'is about', label;
  END IF;
  PERFORM p8.assert_no_handler(label, stmt);
  PERFORM p8.assert_statement_built(label, stmt, relation, false);
  wq := 'SELECT 1 FROM pg_class WHERE relname = ' || quote_literal(relation);
  sq := 'SELECT 1 FROM pg_class WHERE relname = ' || quote_literal(p8.sentinel_subject());
  PERFORM p8.assert_witness(label, 'relation ' || relation, wq, sq);
  stmt2 := replace(stmt, '@REL@', p8.quoted_ident(relation));
  PERFORM p8.case_refuses_core(label, stmt2, expect, relation);
END $$;

CREATE OR REPLACE FUNCTION p8.case_refuses_role(label TEXT, stmt TEXT, expect TEXT, role_name TEXT)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE stmt2 TEXT; wq TEXT; sq TEXT;
BEGIN
  IF role_name IS NULL OR role_name = '' THEN
    RAISE EXCEPTION '% FAIL: NO SUBJECT DECLARED — a role case names the role its refusal is '
                    'about', label;
  END IF;
  PERFORM p8.assert_no_handler(label, stmt);
  PERFORM p8.assert_statement_built(label, stmt, role_name, false);
  wq := 'SELECT 1 FROM pg_roles WHERE rolname = ' || quote_literal(role_name);
  sq := 'SELECT 1 FROM pg_roles WHERE rolname = ' || quote_literal(p8.sentinel_subject());
  PERFORM p8.assert_witness(label, 'role ' || role_name, wq, sq);
  stmt2 := replace(stmt, '@REL@', p8.quoted_ident(role_name));
  PERFORM p8.case_refuses_core(label, stmt2, expect, role_name);
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
  PERFORM p8.case_refuses_core(label, stmt, expect, NULL);
END $$;

-- `case_refuses_unwitnessed` is DELETED, not kept and forbidden (round 28,
-- F-A). The coordinator's review dodged the witness requirement by calling it
-- directly, and a second door that a comment asks people not to use is still a
-- door. No case file ever called it (measured: 0 occurrences outside this
-- file), and the DROP above removes it from any database where an older copy of
-- this file created it.

-- ROUND 29, U-7. This function used to take `witnessed BOOLEAN` — a claim
-- supplied by the caller and believed. The nineteenth challenge called it
-- directly with `true`, no witness, no subject and a dead uuid, and it passed:
-- F-A, on the head that closes F-A, through a door the same commit opened. The
-- lesson round 28 wrote for `case_refuses_unwitnessed` applied to its own
-- replacement, and deleting a door is not the same as not building one.
--
-- So the fourth argument is no longer a claim but a VALUE, and this function
-- checks the claim itself: the subject must appear in the statement as the
-- quoted literal substitution would have put it there. A caller cannot assert
-- "witnessed" any more; it can only hand over a subject that the statement
-- demonstrably reads.
--
-- That is a narrowing, not a closure — a direct caller can still supply a
-- subject bound into its own statement and skip the witness. The enforceable
-- closure is STATIC and lives in the gate: `CORE-NET` greps every case file for
-- a direct call and reds by name, with a control that plants one. REVOKE is not
-- available here: the wrappers are not SECURITY DEFINER, so the case-running
-- roles need EXECUTE on this function either way.
CREATE OR REPLACE FUNCTION p8.case_refuses_core(label TEXT, stmt TEXT, expect TEXT, subject TEXT) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE msg TEXT; cons TEXT; sst TEXT; witnessed BOOLEAN;
BEGIN
  witnessed := subject IS NOT NULL;
  -- ROUND 29, N-3. Every path into this function passes through here, including
  -- the unwitnessed three-argument wrapper, which is the one the coordinator's
  -- laundering attack used. The three new forms check it too; checking it twice
  -- costs nothing and means no future caller can arrive without it.
  PERFORM p8.assert_no_handler(label, stmt);
  IF witnessed AND position(quote_literal(subject) in stmt) = 0
            AND position(p8.quoted_ident(subject) in stmt) = 0 THEN
    RAISE EXCEPTION '% FAIL: THE SUBJECT IS NOT BOUND INTO THE STATEMENT — this form was given '
                    'subject "%" and the statement contains it neither as % nor as %, which is how '
                    'the two substitutions write it, so "witnessed" is a claim about a statement '
                    'that does not read the subject (U-7)',
                    label, subject, quote_literal(subject), p8.quoted_ident(subject);
  END IF;
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
