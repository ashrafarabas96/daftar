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
-- ROUND 30, W-3: the core now takes the FORM that called it, so the arriving
-- refusal can be checked against what that form claims. The four-argument
-- signature goes with the same DROP the earlier ones got.
DROP FUNCTION IF EXISTS p8.case_refuses_core(TEXT, TEXT, TEXT, TEXT);
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
--       The refusal is about a ROW. The statement must carry @REL@ and may NOT
--       carry a predicate of its own (ROUND 30, F-1: it must not carry @KEY@);
--       the form APPENDS `WHERE <key_column>::text = <key_value>` to the
--       statement and builds the witness `SELECT 1 FROM <relation> WHERE
--       <key_column> = <key_value>` from the same two values, which must return
--       at least one row and no row for the sentinel key.
--
--       ROUND 31 corrects what this paragraph used to claim. It said the
--       statement and the witness "read the same row because one expression
--       produces both predicates", and that appending made the attack
--       "unwritable". Both were FALSE, and two reviewers measured it on the
--       same day from different directions: appending text to a statement is
--       not composing one, because the case controls what the appended text is
--       appended TO. `… SET v = 2 --` put the predicate inside a comment and
--       `… SET v = 2; SELECT 1 FROM @REL@` gave it to a second statement; in
--       both the mutation ran against every row and the case reported the
--       refusal a DIFFERENT row decided. Separately, one apostrophe inside a
--       dollar-quoted body blinded the stripper every law read through, so a
--       predicate the case wrote itself was invisible too.
--
--       What is true now is narrower and is a list of refusals rather than an
--       argument: the appended predicate applies because the statement may not
--       end in a comment (the form runs the scanner's 'exec' text), may not be
--       more than one statement (`assert_single_statement`), and may not carry
--       `where` or `@KEY@` of its own (the keyword law, reading through a
--       scanner that follows the server's own lexing). Each of those three is
--       refused BY NAME and each has an arm and a control. Reach is bounded by
--       those three refusals together, not by the shape of one expression.
--
--   case_refuses_relation(label, stmt, expect, relation)
--       The refusal is about a RELATION. The statement must carry @REL@ and may
--       carry only the SQL keywords this form declares, read from
--       `pg_get_keywords()`: a statement that can single out a row carries a
--       keyword nobody declared and is refused by name. ROUND 30, F-2: the
--       earlier rule asked whether the word `where` appeared, and `MERGE … ON`
--       reached one row without it. The arriving refusal must also be a
--       relation-level one — 42501 that is not a row-level policy — so a
--       refusal the ROW decides belongs in the row form.
--
--   case_refuses_role(label, stmt, expect, role)
--       The refusal is about a ROLE, and its declared shape is `SET ROLE`.
--
-- The five-argument form is GONE. So is every argument a case could use to
-- say what its own evidence is.
DROP FUNCTION IF EXISTS p8.case_refuses(TEXT, TEXT, TEXT, TEXT, TEXT);

-- ROUND 31, the coordinator's BLOCKING finding, and it is one finding under
-- three of this round's closures. Every text law here read its statement
-- through two regexes:
--
--     regexp_replace(t, '/\*.*?\*/', ' ', 'gs')  -- and '--[^\n]*'
--     regexp_replace(t, $re$'(''|[^'])*'$re$, ' ', 'g')
--
-- and PostgreSQL has more than one string syntax. An apostrophe inside a
-- DOLLAR-QUOTED body is read by that second regex as the START of a literal,
-- so everything from it to the next quote is deleted from the text the law
-- reads. Measured by the coordinator on a real cluster:
--
--     UPDATE @REL@ SET obligation_key = $n$a'b$n$ WHERE id = '0fff…dead' --
--   strips to
--     UPDATE @REL@ SET obligation_key = $n$a 0fff…dead'
--
-- WHERE is gone. The ROW shape law declares `where` nowhere and passed it; so
-- did the handler ban and the @KEY@ ban; and the same character hid
-- `ON CONFLICT … DO UPDATE SET` from the RELATION shape law. Three laws were
-- blind at once because three laws read ONE stripper, and the whole gate ran
-- green — FAILED=0, 178 of 178 arms, 101 cases — over a tree whose case W-2
-- touched no row at all.
--
-- The regress ends where it has ended before in this phase: in the thing
-- itself. Below is a character scanner that follows the same five rules the
-- server's own lexer follows — `--` to end of line, `/* */` NESTED, a literal
-- with doubled quotes, an E-literal with backslash escapes, and
-- `$tag$…$tag$` — and consumes each construct WHOLE, so no shift inside one
-- can move where another begins. `p8-case-net.py` carries the same scanner in
-- Python, and `SCANNER-AGREE` runs a declared corpus through both and
-- requires the two outputs to be byte-identical, because two readings of one
-- language that can drift apart are two languages.
--
-- Three modes, and each caller's choice is a claim about what it is reading:
--   'strip'  comments gone, EVERY literal blanked. The shape laws and the
--            binding tests: to them a literal is a value, not text.
--   'dollar' comments gone, single-quoted and E-literals blanked,
--            dollar-quoted BODIES kept. The handler ban alone, because
--            `DO $d$ … EXCEPTION … $d$` carries its handler inside dollar
--            quotes and that is the shape the ban exists for.
--   'exec'   comments gone, every literal kept verbatim. What the form RUNS,
--            so that the statement executed is the statement the laws read.
--
-- A quoted "identifier" is consumed and kept in every mode: it names a thing
-- rather than carrying a value, and an apostrophe inside one would otherwise
-- desync everything after it. An unterminated construct consumes to the end of
-- the input, which can only hide text from a law and never reveal it.
CREATE OR REPLACE FUNCTION p8.sql_scan(t TEXT, mode TEXT DEFAULT 'strip')
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  out TEXT := '';
  i INT := 1;
  n INT := length(t);
  j INT; k INT; depth INT; tag TEXT; esc BOOLEAN; c TEXT; prev TEXT;
BEGIN
  IF mode NOT IN ('strip', 'dollar', 'exec') THEN
    RAISE EXCEPTION 'p8.sql_scan: unknown mode %', mode;
  END IF;
  WHILE i <= n LOOP
    c := substr(t, i, 1);
    IF substr(t, i, 2) = '--' THEN
      j := position(E'\n' in substr(t, i));
      out := out || ' ';
      i := CASE WHEN j = 0 THEN n + 1 ELSE i + j - 1 END;
    ELSIF substr(t, i, 2) = '/*' THEN
      depth := 1; i := i + 2;
      WHILE i <= n AND depth > 0 LOOP
        IF substr(t, i, 2) = '/*' THEN depth := depth + 1; i := i + 2;
        ELSIF substr(t, i, 2) = '*/' THEN depth := depth - 1; i := i + 2;
        ELSE i := i + 1;
        END IF;
      END LOOP;
      out := out || ' ';
    ELSIF c = '"' THEN
      j := i + 1;
      WHILE j <= n LOOP
        IF substr(t, j, 1) = '"' THEN
          IF substr(t, j, 2) = '""' THEN j := j + 2; CONTINUE; END IF;
          j := j + 1; EXIT;
        END IF;
        j := j + 1;
      END LOOP;
      out := out || substr(t, i, j - i);
      i := j;
    ELSE
      prev := CASE WHEN i > 1 THEN substr(t, i - 1, 1) ELSE '' END;
      esc := c IN ('E','e') AND substr(t, i + 1, 1) = '''' AND prev !~ '[A-Za-z0-9_]';
      IF c = '''' OR esc THEN
        j := CASE WHEN esc THEN i + 2 ELSE i + 1 END;
        WHILE j <= n LOOP
          IF esc AND substr(t, j, 1) = '\' THEN j := j + 2; CONTINUE; END IF;
          IF substr(t, j, 1) = '''' THEN
            IF substr(t, j, 2) = '''''' THEN j := j + 2; CONTINUE; END IF;
            j := j + 1; EXIT;
          END IF;
          j := j + 1;
        END LOOP;
        out := out || CASE WHEN mode = 'exec' THEN substr(t, i, j - i) ELSE ' ' END;
        i := j;
      ELSE
        tag := CASE WHEN c = '$'
               THEN (SELECT m[1] FROM regexp_matches(substr(t, i),
                       '^(\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$)') AS m)
               ELSE NULL END;
        IF tag IS NOT NULL THEN
          k := position(tag in substr(t, i + length(tag)));
          IF k = 0 THEN
            out := out || CASE WHEN mode = 'exec' THEN substr(t, i) ELSE ' ' END;
            i := n + 1;
          ELSE
            out := out || CASE
                   WHEN mode = 'exec'   THEN substr(t, i, length(tag) + k - 1 + length(tag))
                   -- ROUND 31: the body is RE-SCANNED, not copied. A kept body that is
                   -- not read the way the top level is read is a second reading again.
                   WHEN mode = 'dollar'
                     THEN ' ' || p8.sql_scan(substr(t, i + length(tag), k - 1), 'dollar') || ' '
                   ELSE ' ' END;
            i := i + length(tag) + k - 1 + length(tag);
          END IF;
        ELSE
          out := out || c;
          i := i + 1;
        END IF;
      END IF;
    END IF;
  END LOOP;
  RETURN out;
END $fn$;

-- The two broken readers are REMOVED rather than left beside the scanner. A
-- caller that can still reach the old stripper is a caller that can still be
-- blinded, and the arms below would then be measuring one of two readings.
DROP FUNCTION IF EXISTS p8.strip_sql_comments(TEXT);
DROP FUNCTION IF EXISTS p8.strip_sql_strings(TEXT);

-- A case statement may not carry its own exception handler (the coordinator's
-- N-3). The witness law is derived from the SQLSTATE that ARRIVES, and a
-- `DO … EXCEPTION WHEN insufficient_privilege THEN RAISE EXCEPTION 'denied …'`
-- re-raises a permission denial as P0001, which the derivation cannot see.
-- Refusing the handler is cheaper than reading through it.
CREATE OR REPLACE FUNCTION p8.assert_no_handler(label TEXT, stmt TEXT) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE bare TEXT;
BEGIN
  bare := p8.sql_scan(stmt, 'dollar');
  IF bare ~* '(^|[^a-z_])exception([^a-z_]|$)' THEN
    RAISE EXCEPTION '% FAIL: THE STATEMENT CARRIES AN EXCEPTION HANDLER — the witness law is '
                    'derived from the SQLSTATE that arrives, and a handler can re-raise a '
                    'permission denial as P0001, which that derivation cannot see (N-3). Write '
                    'the statement without a handler', label;
  END IF;
  -- ROUND 30, W-4. Reading the statement cannot see a frame BENEATH it, and the
  -- cheapest frame to add is a string this statement executes. Both halves of
  -- that are now closed: a handler inside a p8 frame can no longer launder a
  -- SQLSTATE (`case_permits_rows` re-raises with `USING ERRCODE`), and a
  -- handler inside a string this statement would EXECUTE never runs, because a
  -- case statement may not build more SQL. No live case does
  -- (measured: 0 occurrences of EXECUTE in the four case files), so this costs
  -- nothing and closes the nesting the literal-stripping above would otherwise
  -- open.
  IF bare ~* '(^|[^a-z_])execute([^a-z_]|$)' THEN
    RAISE EXCEPTION '% FAIL: THE STATEMENT BUILDS MORE SQL — a case statement is executed as it '
                    'is written, so that the refusal the law reads is the refusal the reader sees. '
                    'A statement that EXECUTEs text can carry a handler this test cannot read '
                    '(W-4). Write the statement itself', label;
  END IF;
END $$;

-- ROUND 30, W-3. The rule that stopped a row case being declared as a relation
-- case (the coordinator's N-2) looked for the word `where`. The twentieth
-- challenge reached exactly one row by its key without it:
-- `INSERT … ON CONFLICT (business_id, attempt_key) DO UPDATE SET outcome = …`,
-- measured as `daftar_worker`, PASS, with a witness that said only that the
-- relation exists. Adding `on conflict` to the list of banned words is the
-- shape that reopens on the next spelling (`using`, `having`, `merge`, …).
--
-- So the test is INVERTED, into the same law round 29 gave the census: refuse
-- what you cannot classify. The statement's keywords are read with
-- `pg_get_keywords()` — the SERVER's list, not a list of mine — and every
-- keyword must be one this form DECLARES. `where`, `on`, `conflict`, `do`,
-- `update`, `using`, `having` and every keyword nobody has thought of yet are
-- refused by name, because they are not declared. The price is the same price
-- the census pays: a relation case that genuinely needs a new keyword gets it
-- declared, and declaring it is a claim that it cannot reach one row.
--
-- Identifiers are not keywords, so a column called `outcome` or `locale` costs
-- nothing; a column that IS a keyword would have to be declared, which is
-- correct, because then the statement cannot be read without it.
CREATE OR REPLACE FUNCTION p8.assert_shape(label TEXT, stmt TEXT, what TEXT, form TEXT,
                                           allowed TEXT[]) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg(DISTINCT w, ', ' ORDER BY w) INTO bad
    FROM (SELECT lower(m[1]) AS w
            FROM regexp_matches(p8.sql_scan(stmt),
                                '[A-Za-z_][A-Za-z_0-9]*', 'g') AS m) t
    JOIN pg_get_keywords() k ON k.word = t.w
   WHERE NOT (t.w = ANY (allowed));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '% FAIL: THE STATEMENT IS NOT A DECLARED % SHAPE — it carries the SQL '
                    'keyword(s) %, which this form does not declare, so it cannot be read as a '
                    'statement about "%" as a whole. A statement that reaches one row belongs in '
                    'case_refuses_row with its key declared (N-2, W-3); a shape that is genuinely '
                    'relation-level gets its keyword declared here, and that is a claim',
                    label, form, bad, what;
  END IF;
END $$;

-- The common binding test: the statement must be BUILT from the declared
-- relation, and may not reach for a row unless the form says it does.
CREATE OR REPLACE FUNCTION p8.assert_statement_built(label TEXT, stmt TEXT, what TEXT,
                                                     allow_key BOOLEAN) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE bare TEXT;
BEGIN
  bare := p8.sql_scan(stmt);
  IF position('@REL@' in bare) = 0 THEN
    RAISE EXCEPTION '% FAIL: THE STATEMENT IS NOT BUILT FROM ITS SUBJECT — it does not carry @REL@ '
                    'outside a comment, so it is not a product of the declared subject "%" and the '
                    'evidence below could be about something else (F-B, U-3)', label, what;
  END IF;
  -- ROUND 30, F-1: a row case no longer carries @KEY@ at all — the predicate is
  -- composed by the form — so there is nothing to require here. The row form
  -- refuses the placeholder instead, and `allow_key` now says only that this is
  -- the row form.
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
  PERFORM p8.assert_single_statement(label, stmt);
  PERFORM p8.assert_statement_built(label, stmt, relation || '.' || key_column, true);
  -- ROUND 30, F-1. `@KEY@` used to be substituted into a predicate the CASE
  -- wrote, and the form required only that it OCCUR. The coordinator's review
  -- measured the gap: `WHERE id = '0fffffff-dead-…' AND @KEY@ <> ''` carries
  -- the key, reads as witnessed, and aims at a row that does not exist — the
  -- witness read one row, the statement touched none, PASS at rc 0. A text
  -- test on the statement cannot bound what the statement REACHES.
  --
  -- So the predicate is no longer the case's to write. The case supplies the
  -- mutation and nothing else; this form appends `WHERE <key_column>::text =
  -- <key_value>` from the same two values the witness is built from.
  --
  -- ROUND 31: appending is not composing, and the sentence that used to stand
  -- here said it was. The case still controls what the appended text is
  -- appended TO, and two spellings carrying neither `@KEY@` nor `where`
  -- detached it — a trailing comment and a second statement. Both are refused
  -- by name now, and the third way, a predicate of the case's own, is refused
  -- by a keyword law that can finally see `where`.
  IF position('@KEY@' in p8.sql_scan(stmt)) > 0 THEN
    RAISE EXCEPTION '% FAIL: A ROW CASE MAY NOT WRITE ITS OWN PREDICATE — this form appends '
                    'WHERE %::text = % to the statement itself, from the same values the witness '
                    'is built from, so the statement and the witness cannot aim at different rows '
                    '(F-1). Write the mutation without a WHERE and without @KEY@',
                    label, p8.quoted_ident(key_column), quote_literal(key_value);
  END IF;
  PERFORM p8.assert_shape(label, stmt, relation || '.' || key_column, 'ROW',
                          ARRAY['select','from','update','set','delete',
                                'null','true','false','as','cast']);
  wq := 'SELECT 1 FROM ' || p8.quoted_ident(relation) || ' WHERE '
        || p8.quoted_ident(key_column) || '::text = ' || quote_literal(key_value);
  sq := 'SELECT 1 FROM ' || p8.quoted_ident(relation) || ' WHERE '
        || p8.quoted_ident(key_column) || '::text = ' || quote_literal(p8.sentinel_subject());
  PERFORM p8.assert_witness(label, relation || ' keyed by ' || key_column || ' = ' || key_value,
                            wq, sq);
  -- ROUND 31, C-1(a). This used to append to the RAW statement, so a trailing
  -- `--` put the form's own predicate inside a comment and the UPDATE ran
  -- against every row. What is appended to now is the statement the laws read:
  -- comments removed by the scanner, literals untouched, so the text that
  -- EXECUTES is the text that was checked.
  stmt2 := replace(p8.sql_scan(stmt, 'exec'), '@REL@', p8.quoted_ident(relation))
           || ' WHERE ' || p8.quoted_ident(key_column) || '::text = '
           || quote_literal(key_value);
  PERFORM p8.case_refuses_core(label, stmt2, expect, key_value, 'row');
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
  -- The declared relation-level keywords. Every one of them reads or writes the
  -- relation as a whole; none of them can single out a row.
  PERFORM p8.assert_shape(label, stmt, relation, 'RELATION',
                          ARRAY['select','from','insert','into','values','truncate',
                                'distinct','all','as','cast','null','true','false']);
  wq := 'SELECT 1 FROM pg_class WHERE relname = ' || quote_literal(relation);
  sq := 'SELECT 1 FROM pg_class WHERE relname = ' || quote_literal(p8.sentinel_subject());
  PERFORM p8.assert_witness(label, 'relation ' || relation, wq, sq);
  stmt2 := replace(stmt, '@REL@', p8.quoted_ident(relation));
  PERFORM p8.case_refuses_core(label, stmt2, expect, relation, 'relation');
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
  -- A role case says what a role may or may not BECOME, so its declared shape
  -- is `SET ROLE`. Anything that reads or writes a relation is not a role case,
  -- and the refusal names the keyword that gave it away.
  PERFORM p8.assert_shape(label, stmt, role_name, 'ROLE', ARRAY['set','role']);
  wq := 'SELECT 1 FROM pg_roles WHERE rolname = ' || quote_literal(role_name);
  sq := 'SELECT 1 FROM pg_roles WHERE rolname = ' || quote_literal(p8.sentinel_subject());
  PERFORM p8.assert_witness(label, 'role ' || role_name, wq, sq);
  stmt2 := replace(stmt, '@REL@', p8.quoted_ident(role_name));
  PERFORM p8.case_refuses_core(label, stmt2, expect, role_name, 'role');
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
  PERFORM p8.case_refuses_core(label, stmt, expect, NULL, 'unwitnessed');
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
-- ROUND 31, C-1 (the second challenge pack). Round 30 said of the row form's
-- appended predicate: "the attack is not refused, it is unwritable". It was
-- writable, in two spellings that carry neither `@KEY@` nor a `WHERE`:
--
--     UPDATE @REL@ SET v = 2 --                     -> the predicate is inside the comment
--     UPDATE @REL@ SET v = 2; SELECT 1 FROM @REL@   -> the predicate joins a SECOND statement
--
-- Both ran the UPDATE with no predicate at all, and the second carries only
-- keywords the row form declares, so no keyword law could ever see it.
-- Appending text to a statement is not composition: the case controls what the
-- appended text is appended TO. There are exactly three ways to detach it — a
-- trailing comment, a second statement, and a predicate of the case's own —
-- and this round closes each one by name rather than arguing the list is
-- complete:
--
--   * the comment: the form now RUNS `p8.sql_scan(stmt, 'exec')`, so what
--     executes is the statement the laws read, with its comments already gone;
--   * the second statement: the law below;
--   * its own predicate: the keyword law, which can see `where` again now that
--     the scanner is not blinded by one apostrophe.
CREATE OR REPLACE FUNCTION p8.assert_single_statement(label TEXT, stmt TEXT) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE bare TEXT;
BEGIN
  bare := rtrim(p8.sql_scan(stmt));
  IF right(bare, 1) = ';' THEN
    bare := rtrim(left(bare, length(bare) - 1));
  END IF;
  IF position(';' in bare) > 0 THEN
    RAISE EXCEPTION '% FAIL: MORE THAN ONE STATEMENT — this form composes a predicate and appends '
                    'it, so a second statement takes the predicate and leaves the first one '
                    'unbounded: `UPDATE @REL@ SET v = 2; SELECT 1 FROM @REL@` ran the UPDATE '
                    'against every row and reported the refusal a different row decided (C-1). '
                    'A case is one statement', label;
  END IF;
END $$;

-- ROUND 31, C-2. The arriving-class derivation existed and was applied to the
-- RELATION form alone, so a ROW case passed on any error its own statement
-- could provoke: `SELECT 1/0 FROM @REL@` expecting 'division by zero' passed,
-- and so did a statement that called one of this pack's own helpers to raise a
-- P0001 of its choosing. The case chose the error and the server merely
-- reported it, which is the F-3 principle with the subject changed.
--
-- The rule is derived from what ARRIVED, like its relation-form twin. A row
-- case's refusal must be one a row-level authority can decide: a grant or
-- row-level security decision (42501), an integrity constraint (class 23), or
-- a trigger's own RAISE. Everything else — a data exception the expression
-- computed (class 22), a syntax or type error (class 42 other than 42501), an
-- undefined object — is the statement failing, not an authority refusing.
--
-- And in every form: a refusal raised inside one of THIS PACK's functions is
-- the pack reporting on itself. `p8-case-net.py` bans the core helper by name
-- in the case files; this bans every helper at the place the error arrives,
-- where no spelling can get around it.
CREATE OR REPLACE FUNCTION p8.assert_arriving_class(label TEXT, kind TEXT, sst TEXT,
                                                    msg TEXT, ctx TEXT) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- The INNERMOST frame only. The exception context is a stack, and this
  -- pack is always somewhere in it — `case_refuses_core` is the frame that
  -- ran the statement — so a match anywhere would red every case ever
  -- written. The first line names where the error was RAISED, which is the
  -- only frame that says who decided. The names come from the catalogue
  -- rather than from a list written here, because a helper added later is a
  -- helper a hand-written list would not know; and the schema prefix is
  -- optional in the match because the context prints the name as the
  -- search_path resolves it.
  --
  -- And the frame must be `at RAISE`. `case_refuses_core` is a p8 function and
  -- it is the frame that EXECUTEs the case statement, so for an error the
  -- STATEMENT caused before it became a statement — a syntax error — the
  -- innermost frame is this pack's own EXECUTE. Without `at RAISE` this rule
  -- attributed the server's syntax error to the pack, which is the same kind
  -- of false sentence the coordinator's section 5 named one layer up.
  IF EXISTS (SELECT 1 FROM pg_proc pr JOIN pg_namespace nsp ON nsp.oid = pr.pronamespace
              WHERE nsp.nspname = 'p8'
                AND split_part(coalesce(ctx,''), E'\n', 1)
                      ~* ('function (p8\.)?' || pr.proname || '\(.*at RAISE')) THEN
    RAISE EXCEPTION '% FAIL: THE REFUSAL CAME FROM THIS PACK — the error this case reads was '
                    'raised inside a p8 helper called by the statement itself (context: %), so the '
                    'case chose both the error and its wording. A case states what the SCHEMA '
                    'refuses (C-2). Got [%] %',
                    label, split_part(coalesce(ctx,''), E'\n', 1), sst, msg;
  END IF;
  IF kind = 'row' AND NOT (sst = '42501' OR left(sst, 2) = '23' OR sst = 'P0001') THEN
    RAISE EXCEPTION '% FAIL: A ROW CASE REFUSED BY SOMETHING NO AUTHORITY DECIDED — what arrived '
                    'is [%] %, and a row-level refusal is a grant or row-level security decision '
                    '(42501), an integrity constraint (class 23) or a trigger''s own RAISE '
                    '(P0001). Any other class is the statement failing rather than the schema '
                    'refusing, so `SELECT 1/0 FROM @REL@` would otherwise pass as a refusal the '
                    'case chose (C-2)', label, sst, msg;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION p8.case_refuses_core(label TEXT, stmt TEXT, expect TEXT, subject TEXT, kind TEXT) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE msg TEXT; cons TEXT; sst TEXT; ctx TEXT; witnessed BOOLEAN; rowlevel BOOLEAN;
BEGIN
  witnessed := subject IS NOT NULL;
  -- ROUND 29, N-3. Every path into this function passes through here, including
  -- the unwitnessed three-argument wrapper, which is the one the coordinator's
  -- laundering attack used. The three new forms check it too; checking it twice
  -- costs nothing and means no future caller can arrive without it.
  PERFORM p8.assert_no_handler(label, stmt);
  PERFORM p8.assert_single_statement(label, stmt);
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
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT, cons = CONSTRAINT_NAME, sst = RETURNED_SQLSTATE,
                            ctx = PG_EXCEPTION_CONTEXT;
    -- ROUND 30, F-3. `assert_no_handler` reads the statement's TEXT, and the
    -- coordinator's review split the keyword across a concatenation
    -- (`'EXCEP' || 'TION'`) inside a statement that EXECUTEs the pieces: 42501
    -- laundered to P0001, no witness owed, against a dead row. The text test
    -- cannot see that, and no text test can — a regex says a keyword appears,
    -- never that it is all that runs.
    --
    -- This is read from what ARRIVED instead: the server's own exception
    -- context names the frame that raised. A refusal raised inside the
    -- statement's own anonymous block — `inline_code_block`, which is what a
    -- `DO` in the statement compiles to — is the statement reporting on itself,
    -- whatever it spelled. A trigger or a function names itself in the context
    -- and is untouched, which is why this does not red the ladder cases.
    -- ROUND 31, the coordinator's section 5. This matched the context
    -- ANYWHERE, including a frame ABOVE the statement, so a refusal the
    -- SERVER decided inside a case that happens to run in a block was
    -- reported as one the statement decided — a sentence false of the case it
    -- was printed about. The innermost frame is the one that says who raised.
    IF split_part(coalesce(ctx,''), E'\n', 1) ~ 'inline_code_block' THEN
      RAISE EXCEPTION '% FAIL: THE REFUSAL CAME FROM THE STATEMENT''S OWN BLOCK — the error this '
                      'case reads was raised inside an anonymous block in the statement '
                      '(context: %), so what the law sees is what the statement chose to say and '
                      'not what the server decided. Write the statement without a block of its '
                      'own (F-3). Got [%] %',
                      label, split_part(coalesce(ctx,''), E'\n', 1), sst, msg;
    END IF;
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
    -- ROUND 30, W-3, the other half. A relation case claims its refusal is
    -- about the relation AS A WHOLE, which for this schema means a grant or
    -- ownership decision — SQLSTATE 42501, taken before any row is read. Any
    -- other arriving class (a row-level security WITH CHECK violation, a check
    -- constraint, a unique violation) depends on the row being written, so a
    -- relation-level witness would be evidence about something the refusal did
    -- not decide. That case belongs in the row form, with its key declared and
    -- read. Derived from what ARRIVES, so no spelling of the statement can
    -- dodge it.
    rowlevel := (sst <> '42501'
                 OR position('row-level security policy' in lower(coalesce(msg,''))) > 0);
    IF kind = 'relation' AND rowlevel THEN
      RAISE EXCEPTION '% FAIL: A RELATION CASE REFUSED BY SOMETHING ROW-LEVEL — this form claims '
                      'the refusal is about "%" as a whole, and what arrived is [%] %, which is '
                      'decided by the row rather than by a grant. Use case_refuses_row and declare '
                      'the key the refusal is about (W-3)', label, subject, sst, msg;
    END IF;
    -- ROUND 31, C-2, and it runs HERE rather than at the top of the handler:
    -- the two rules above already name the attacks they were built for, and a
    -- new rule that renamed their refusals would make their arms measure
    -- something else. This one catches what neither of them looks at — a row
    -- case refused by an error its own statement computed, and any case
    -- refused by this pack's own helpers.
    PERFORM p8.assert_arriving_class(label, kind, sst, msg, ctx);
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
    -- ROUND 30, W-4. This frame used to re-raise with P0001, and the twentieth
    -- challenge made that the laundry: a case wrapped a privilege-denied
    -- statement in `p8.case_permits`, the denial came back as P0001, and the
    -- witness law — which is derived from the arriving 42501 — never saw it.
    -- The handler ban could not help, because the handler is not in the
    -- statement; it is in this function, which the pack grants to every case
    -- role. `USING ERRCODE` keeps the arriving SQLSTATE through this frame, so
    -- the derivation sees what the server said however deep it was caught.
    RAISE EXCEPTION '% FAIL: REFUSED, and it should not be — [%] %', label, sst, msg
      USING ERRCODE = sst;
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
