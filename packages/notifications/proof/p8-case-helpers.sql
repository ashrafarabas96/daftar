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
-- ROUND 34, the coordinator's section 4: the core now also takes the RELATION
-- the case declared, because for a row case the `subject` is the key value and
-- the law below is about the relation. The five-argument signature goes with
-- the same DROP, and the new one has no DEFAULT: a caller that does not say
-- which relation its refusal is about cannot reach this function at all.
DROP FUNCTION IF EXISTS p8.case_refuses_core(TEXT, TEXT, TEXT, TEXT, TEXT);
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
--       ROUND 31 wrote, in place of that argument, a list of three refusals
--       and the sentence "Reach is bounded by those three refusals together".
--       That sentence was FALSE AS WRITTEN and both reviewers measured it: the
--       coordinator's `RB-astral`,
--         UPDATE @REL@ SET v = 2 + length($𐀀$a'b$𐀀$) - 3 ; SELECT 1 FROM @REL@
--       IS more than one statement, was NOT refused, and the appended
--       predicate joined the second statement — `PASS refused by
--       DENIED-BY-THE-OTHER-ROW [42501]`, rc 0, with the whole gate FAILED=0
--       and the attack installed in the real case `W-2`. The three refusals
--       were real; the clause that made them sufficient was not, because all
--       three read the statement THROUGH a scanner that did not follow the
--       server's own lexing, so each of them was looking at a different
--       program. A list of refusals is only as good as the reading they share.
--
--       What is true now is that same list of three refusals, plus the thing
--       the sentence above assumed and never measured: the shared reading is
--       itself checked AGAINST THE SERVER. `SCANNER-ORACLE` runs each corpus
--       payload on a two-row bench and reads the server's verdict OFF THE
--       ROWS — one row moved means a predicate acted — and requires the
--       scanner's reading of what is code to match it, with a control that
--       restores round 31's tag class and reds. `IDENT-RULE` asks the server
--       to classify each probe character and requires `p8.ident_start` to
--       agree. So the bound is: three named refusals, over a reading the
--       server attests. It is still not a proof that no fourth route exists.
--
--       ROUND 33 found the fourth route, and it was in the words "a reading
--       the server attests": round 32 attested it in a psql connection of
--       the arm's own, not in the session where a case runs. With
--       `standard_conforming_strings = off` set by the case file itself, the
--       server's literals end somewhere else than the scanner's — `'A\'B'`
--       is one literal to the server and two fragments to both scanners — so
--       a `;` the scanners place INSIDE a string is at top level to the
--       server, the appended predicate joins the second statement and the
--       mutation runs against every row. The same PASS on a refusal another
--       row decided, through a reading nobody had asked the session about.
--       `p8.assert_lex_session`, called at the top of `p8.sql_scan`, now
--       makes the reading assert its own preconditions where the lexing will
--       happen. The bound is unchanged in shape and one clause stronger: three
--       named refusals, over a reading the SESSION attests. It is still not a
--       proof that no fifth route exists.
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
-- ROUND 32, D-1 and D-2 (both P1), and one class found reproducing them. The
-- round-31 scanner restated PostgreSQL's identifier grammar as a regex, once
-- per language, and got it wrong three ways at once. Measured on PG 16.15:
--
--   SELECT a$b$c$b$  -> ERROR: column "a$b$c$b$" does not exist
--        `$` is an identifier CONTINUATION character, so that is ONE
--        identifier and there is no dollar quote in it at all. Both scanners
--        read a quote there and blanked `c`, which is code to the server.
--   SELECT $E1$E'a'  -- and  SELECT 😀E'a' -> ERROR: type "😀e" does not exist
--        a supplementary-plane character is an identifier character; both
--        scanners stopped their class at U+FFFF (D-1).
--   SELECT ·E'a'     -> ERROR: type "·e" does not exist
--        U+00B7 is an identifier character to the server and is NOT
--        alphanumeric to Python, so round 31's two readers disagreed (D-2)
--        and BOTH were wrong, in opposite directions.
--
-- The rule is declared ONCE below in the server's own terms (scan.l:
-- ident_start `[A-Za-z\200-\377_]`, ident_cont adds `[0-9$]`, and a
-- dollar-quote tag takes the identifier characters EXCEPT `$`), it is
-- ASSERTED against the server by the `IDENT-RULE` arm rather than remembered,
-- and an identifier is consumed as a WHOLE TOKEN so that a `$` or an `E'`
-- inside one is never examined alone. One character of lookback cannot decide
-- it: `1$x$y$x$` IS a dollar quote to the server and `a$x$y$x$` is not, and
-- the character before the `$` is an identifier-continuation character in
-- both.
CREATE OR REPLACE FUNCTION p8.ident_start(ch TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT ch ~ '^[A-Za-z_]$' OR ascii(ch) >= 128
$fn$;

CREATE OR REPLACE FUNCTION p8.ident_cont(ch TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT p8.ident_start(ch) OR ch ~ '^[0-9$]$'
$fn$;

-- A dollar-quote tag takes identifier characters but NOT `$`, which is why
-- `SELECT $1x$y$1x$` is a positional parameter with trailing junk and not a
-- tag. Returns the whole tag including both `$`, or NULL.
CREATE OR REPLACE FUNCTION p8.dollar_tag(t TEXT, i INT) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE n INT := length(t); j INT;
BEGIN
  IF i > n OR substr(t, i, 1) <> '$' THEN RETURN NULL; END IF;
  j := i + 1;
  IF j <= n AND p8.ident_start(substr(t, j, 1)) THEN
    j := j + 1;
    WHILE j <= n AND (p8.ident_start(substr(t, j, 1))
                      OR substr(t, j, 1) ~ '^[0-9]$') LOOP
      j := j + 1;
    END LOOP;
  END IF;
  IF j <= n AND substr(t, j, 1) = '$' THEN RETURN substr(t, i, j - i + 1); END IF;
  RETURN NULL;
END $fn$;

-- ROUND 33, the coordinator diff review's BLOCKING finding on `b7c0933` and
-- the twenty-third challenge's D-2, which rebuilt it independently.
--
-- Round 32 added an arm, `LEX-SETTINGS`, that reads
-- `standard_conforming_strings` and `backslash_quote` and aborts the run if
-- the cluster does not lex the way both scanners do. The diagnosis was right
-- and the guard did not close it: those are SESSION GUCs, settable by any
-- role with a plain `SET`, and the arm read them in a psql connection OF ITS
-- OWN. So the one setting every reading in this gate depends on was asserted
-- where it cannot be violated and unasserted where it can.
--
-- The attack the coordinator built, and the challenger reproduced on a bench
-- of his own, is two lines in a case file:
--
--     SET standard_conforming_strings = off;
--     SELECT p8.case_refuses_row('…',
--       $q$UPDATE @REL@ SET v = 2 + length('A\'B') - 3 ; SELECT … FROM @REL@$q$,
--       'DENIED-BY-THE-OTHER-ROW', 'p8bench_reach', 'k', 'W');
--
-- With the setting off the server reads `'A\'B'` as ONE literal, so the `;`
-- is at top level and the statement is two statements. Both scanners
-- implement `on`, so to them the backslash is ordinary, `'A\'` is a complete
-- literal and the `;` is INSIDE the next one — `assert_single_statement`
-- sees no semicolon at all, the appended predicate joins the SECOND
-- statement, the UPDATE runs unqualified, and the case reports a PASS on a
-- refusal the row it did not declare decided. Installed in the real case
-- `W-6`, the whole of gate 6 stayed `FAILED=0`, 202 of 202 arms,
-- `passes=101` — the honest run's figures exactly.
--
-- This is the same shape as the defect round 32 closed, one layer along:
-- round 31 hid the semicolon behind a dollar tag the scanners did not know,
-- and it can still be hidden behind a lexing setting they assume.
--
-- So the reading asserts its own preconditions AT THE MOMENT IT READS, in
-- the session that will do the lexing, which is the only place a `SET` in a
-- case file cannot get in front of: the `SET` is then exactly what the law
-- reads. One call site, at the top of `p8.sql_scan`, covers every law in the
-- pack, because every law reads its statement through it.
--
-- The three settings are read in ONE comparison against ONE expected string,
-- not field by field. This phase's own rule: a reader that compares each
-- field separately has defined every field it does not read as not
-- mattering, and the next setting that decides how bytes become tokens is
-- then a silence rather than a refusal.
--
-- `client_encoding` is in it because it sits between the bytes a case file
-- declares and the bytes the server lexes.
--
-- ROUND 34, the coordinator's section 5 (P1). The sentence that used to
-- stand here said the encoding term "cannot red a cluster that is internally
-- consistent", and it was FALSE as written, because the term compared the
-- two settings' NAMES. `UNICODE` is a documented alias of `UTF8` and the
-- server keeps the spelling it was given, so on a cluster where nothing can
-- possibly be converted the guard refused:
--
--   SET client_encoding='UNICODE';
--   → current_setting: UNICODE | UTF8, pg_char_to_encoding: 6 | 6
--   → ERROR: p8: UNLEXABLE SESSION … = on/safe_encoding/UNICODE
--
-- Reproduced here before it was changed. A hardening that causes a false red
-- is not hardening, and this phase's own lesson says why it happened: a
-- whitelist of NAMES is not a whitelist of BEHAVIOURS, and an encoding's name
-- is a projection of the encoding.
--
-- So no term of this guard reads a setting's name any more. ROUND 34 reads
-- what the settings DO, in the session that will lex, through the server:
--
--   * a backslash inside an ordinary literal — `length('\\')` is 2 where the
--     server is standard-conforming and 1 where it is not;
--   * a backslash-escaped quote inside an E-string — `length(E'\'')` is 1
--     where `\'` is accepted and a 42601 where it is not. This also closes
--     the twenty-fourth challenge's residual 1: the old term required the
--     exact spelling `safe_encoding` and refused `on`, and with a safe client
--     encoding the two lex IDENTICALLY (both measured here: 1). The name test
--     was over-strict; the behaviour test is not;
--   * the two encodings' IDENTITY, `pg_char_to_encoding(client) =
--     pg_char_to_encoding(server)` — the server's own answer about what the
--     name stands for, which is 6 = 6 for `UNICODE` against `UTF8`;
--   * `transform_null_equals`, named UNMEASURED by the coordinator's 6.4 and
--     measured here: with it on, `1 = NULL` is rewritten to `1 IS NULL`, so
--     `(1 = NULL) IS NULL` answers `true` with it off and `false` with it on.
--     It changes a statement's MEANING rather than its tokens, which is the
--     question the coordinator asked should decide membership, so it is in.
--
-- Each probe's text is built from `chr(92)` and `chr(39)` so that THIS
-- function compiles under any setting — a literal backslash in its own body
-- would make the guard the thing that cannot be loaded (section 6.1).
--
-- The refusal is NOT spelled `p8.sql_scan: UNLEXABLE`, which is this file's
-- prefix for an unterminated construct: `p8.sql_scan_value` catches exactly
-- that prefix and returns the raw body, and `p8.sql_scan_hex` turns it into
-- the string `UNLEXABLE`. A session refusal that wore that prefix would be
-- SWALLOWED by both — a guard that cannot be run is not a guard — so it is
-- spelled `p8: UNLEXABLE SESSION` and propagates out of every wrapper.
--
-- `p8.sql_scan` and the two functions that wrap it are STABLE from this
-- round, not IMMUTABLE. They were never immutable in truth once they read a
-- setting, and a declaration that lies to the planner is the kind of sentence
-- this phase keeps measuring false.
CREATE OR REPLACE FUNCTION p8.lex_session() RETURNS TEXT
LANGUAGE plpgsql STABLE AS $fn$
DECLARE bs TEXT; eq TEXT; enc TEXT; tne TEXT; n INT; b BOOLEAN;
BEGIN
  -- `SELECT length('\\')`, assembled so that no backslash appears in this body.
  EXECUTE 'SELECT length(' || chr(39) || chr(92) || chr(92) || chr(39) || ')' INTO n;
  bs := n::text;
  -- `SELECT length(E'\'')`. A 42601 here IS the measurement.
  BEGIN
    EXECUTE 'SELECT length(E' || chr(39) || chr(92) || chr(39) || chr(39) || ')' INTO n;
    eq := n::text;
  EXCEPTION WHEN others THEN
    eq := 'refused';
  END;
  SELECT pg_char_to_encoding(current_setting('client_encoding')) = pg_char_to_encoding(current_setting('server_encoding')) INTO b;
  enc := CASE WHEN b THEN 'same' ELSE 'differs' END;
  EXECUTE 'SELECT (1 = NULL) IS NULL' INTO b;
  tne := CASE WHEN b THEN 'null-is-unknown' ELSE 'null-is-rewritten' END;
  RETURN bs || '/' || eq || '/' || enc || '/' || tne;
END $fn$;

-- What the two scanners in this pack implement, as four measurements and not
-- as four setting names: a backslash in an ordinary literal is an ordinary
-- character (so `length` is 2), a backslash-escaped quote in an E-string is
-- one character, the client and the server agree on the encoding, and
-- `= NULL` is an ordinary comparison that answers unknown.
--
-- DECLARED BOUND, R25-S-2, named and not closed. These four are an
-- ENUMERATION, so the guard's DOMAIN is four behaviours and not "the session
-- lexes as the scanner reads". R25 measured five more settings under which
-- `p8.lex_session()` still answers the declared tuple:
--
--   DateStyle='DMY, SQL'  escape_string_warning=off  bytea_output='escape'
--   IntervalStyle='sql_standard'  search_path=<other>,p8,public
--
-- `DateStyle` meets this phase's own membership test — it changes a
-- statement's MEANING and not its tokens ('01/02/2024'::date answers
-- 2024-01-02 under MDY and 2024-02-01 under DMY) — and is UNMEASURED here. No
-- live case depends on it: the four case files carry no `::date` and no
-- `::timestamp`, and their one `interval '1 second'` is not moved on input by
-- `IntervalStyle`. `search_path` is the one that is not inert, because the
-- attribution law below resolves the declared relation THROUGH it with
-- `to_regclass`; that is the same ambiguity R25-F-1 names, and it is bounded
-- there by the privilege question and not by the name.
CREATE OR REPLACE FUNCTION p8.lex_session_expected() RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT '2/1/same/null-is-unknown'
$fn$;

CREATE OR REPLACE FUNCTION p8.assert_lex_session() RETURNS void
LANGUAGE plpgsql STABLE AS $fn$
BEGIN
  IF p8.lex_session() <> p8.lex_session_expected() THEN
    RAISE EXCEPTION 'p8: UNLEXABLE SESSION — THIS SESSION LEXES DIFFERENTLY FROM THE SCANNER: '
                    'measured backslash-in-literal/escaped-quote-in-E-string/encoding-identity/'
                    'null-equals = %, and both scanners implement %. The settings behind it are '
                    'standard_conforming_strings=%, backslash_quote=%, client_encoding=%, '
                    'server_encoding=%, transform_null_equals=%. A backslash, a quote, a byte or '
                    'an equals sign means something else here than it does to the reading every '
                    'law in this pack is about to make, so no refusal derived from that reading '
                    'would be evidence about the statement the server will run (the '
                    'coordinator''s b7c0933 section 3, and section 5 of the review of 2e6b0e9)',
                    p8.lex_session(), p8.lex_session_expected(),
                    current_setting('standard_conforming_strings'),
                    current_setting('backslash_quote'),
                    current_setting('client_encoding'),
                    current_setting('server_encoding'),
                    current_setting('transform_null_equals')
      USING ERRCODE = 'P0001';
  END IF;
END $fn$;

-- The 'dollar' mode's recursion, with the refusal turned into the raw body.
-- See the comment at its call site.
CREATE OR REPLACE FUNCTION p8.sql_scan_value(body TEXT) RETURNS TEXT
LANGUAGE plpgsql STABLE AS $fn$
BEGIN
  RETURN p8.sql_scan(body, 'dollar');
EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM LIKE 'p8.sql_scan: UNLEXABLE%' THEN RETURN body; END IF;
  RAISE;
END $fn$;

CREATE OR REPLACE FUNCTION p8.sql_scan(t TEXT, mode TEXT DEFAULT 'strip')
RETURNS TEXT LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  out TEXT := '';
  i INT := 1;
  n INT := length(t);
  j INT; k INT; depth INT; tag TEXT; esc BOOLEAN; c TEXT; closed BOOLEAN;
BEGIN
  PERFORM p8.assert_lex_session();
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
      j := i + 1; closed := FALSE;
      WHILE j <= n LOOP
        IF substr(t, j, 1) = '"' THEN
          IF substr(t, j, 2) = '""' THEN j := j + 2; CONTINUE; END IF;
          j := j + 1; closed := TRUE; EXIT;
        END IF;
        j := j + 1;
      END LOOP;
      IF NOT closed THEN
        RAISE EXCEPTION 'p8.sql_scan: UNLEXABLE — an unterminated quoted identifier'
          USING ERRCODE = 'P0001';
      END IF;
      out := out || substr(t, i, j - i);
      i := j;
    -- ROUND 32. An identifier is consumed as ONE TOKEN, and that single change
    -- is the whole of the D-1 / D-2 fix: a `$` or an `E'` falling INSIDE an
    -- identifier is never examined on its own, so there is no one-character
    -- lookback left to get wrong, and `a$b$c$b$` comes out whole exactly as
    -- the server reads it. The greedy consumption also ENCODES the lookback
    -- the E-string test below needs: control only reaches that test where no
    -- identifier was running, so an `E'` found there really does open one.
    ELSIF p8.ident_start(c)
          AND NOT (c IN ('E','e') AND substr(t, i + 1, 1) = '''') THEN
      j := i + 1;
      WHILE j <= n AND p8.ident_cont(substr(t, j, 1)) LOOP j := j + 1; END LOOP;
      out := out || substr(t, i, j - i);
      i := j;
    -- A numeric token. The server does not continue an identifier into one, so
    -- `1$x$y$x$` IS a dollar quote while `a$x$y$x$` is not; and after a number
    -- `E'` is not an E-string but an error the server names, so the scanner
    -- REFUSES rather than choosing one of the two readings.
    ELSIF c ~ '^[0-9]$' THEN
      j := i + 1;
      WHILE j <= n AND substr(t, j, 1) ~ '^[0-9.]$' LOOP j := j + 1; END LOOP;
      IF j <= n AND substr(t, j, 1) IN ('E','e') AND substr(t, j + 1, 1) = '''' THEN
        RAISE EXCEPTION 'p8.sql_scan: UNLEXABLE — E-string directly after a numeric literal'
          USING ERRCODE = 'P0001';
      END IF;
      out := out || substr(t, i, j - i);
      i := j;
    ELSE
      esc := c IN ('E','e') AND substr(t, i + 1, 1) = '''';
      IF c = '''' OR esc THEN
        j := CASE WHEN esc THEN i + 2 ELSE i + 1 END;
        closed := FALSE;
        WHILE j <= n LOOP
          -- ROUND 34, the coordinator's 6.1. This used to be the literal
          -- '\', and under standard_conforming_strings = off plpgsql cannot
          -- COMPILE it, so a flip in a session that had not yet called
          -- `p8.sql_scan` reds with a syntax error pointing into this file
          -- instead of with the guard's own name. chr(92) compiles either
          -- way, after which `assert_lex_session` is the first thing that
          -- can fire. Fail-closed before and after; what changes is that the
          -- refusal is BY NAME.
          IF esc AND substr(t, j, 1) = chr(92) THEN j := j + 2; CONTINUE; END IF;
          IF substr(t, j, 1) = '''' THEN
            IF substr(t, j, 2) = '''''' THEN j := j + 2; CONTINUE; END IF;
            j := j + 1; closed := TRUE; EXIT;
          END IF;
          j := j + 1;
        END LOOP;
        IF NOT closed THEN
          RAISE EXCEPTION 'p8.sql_scan: UNLEXABLE — an unterminated string literal'
            USING ERRCODE = 'P0001';
        END IF;
        out := out || CASE WHEN mode = 'exec' THEN substr(t, i, j - i) ELSE ' ' END;
        i := j;
      ELSE
        tag := p8.dollar_tag(t, i);
        IF tag IS NOT NULL THEN
          k := position(tag in substr(t, i + length(tag)));
          IF k = 0 THEN
            RAISE EXCEPTION 'p8.sql_scan: UNLEXABLE — an unterminated dollar-quoted string'
              USING ERRCODE = 'P0001';
          ELSE
            out := out || CASE
                   WHEN mode = 'exec'   THEN substr(t, i, length(tag) + k - 1 + length(tag))
                   -- ROUND 31: the body is RE-SCANNED, not copied. A kept body that is
                   -- not read the way the top level is read is a second reading again.
                   WHEN mode = 'dollar'
                     -- ROUND 32: a dollar body is a VALUE, not a statement, so
                     -- it need not lex as SQL — `$q$it's$q$` is a good literal
                     -- whose body alone is an unterminated string. The re-scan
                     -- exists only to REVEAL nested constructs to the handler
                     -- ban, so where it cannot lex the body the RAW body is
                     -- kept: the safe direction, since it can only show the
                     -- ban more text and never less.
                     THEN ' ' || p8.sql_scan_value(substr(t, i + length(tag), k - 1)) || ' '
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

-- The hex reading used by SCANNER-AGREE, with a refusal reported AS A READING.
-- ROUND 32: the scanner now refuses an input whose lexing is not determined
-- (an unterminated construct, an E-string after a number). Both sides must
-- report that the same way, or the comparison is between an output on one
-- side and an abort on the other, and an abort is not a reading.
CREATE OR REPLACE FUNCTION p8.sql_scan_hex(t TEXT, mode TEXT) RETURNS TEXT
LANGUAGE plpgsql STABLE AS $fn$
BEGIN
  RETURN encode(convert_to(p8.sql_scan(t, mode), 'UTF8'), 'hex');
EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM LIKE 'p8.sql_scan: UNLEXABLE%' THEN RETURN 'UNLEXABLE'; END IF;
  RAISE;
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
  PERFORM p8.case_refuses_core(label, stmt2, expect, key_value, 'row', relation);
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
  PERFORM p8.case_refuses_core(label, stmt2, expect, relation, 'relation', relation);
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
  PERFORM p8.case_refuses_core(label, stmt2, expect, role_name, 'role', NULL);
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
  PERFORM p8.case_refuses_core(label, stmt, expect, NULL, 'unwitnessed', NULL);
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

-- ROUND 36, R26-F-1 and the coordinator's ruling on `d418171`. THE REACH
-- TERM, and it is the direction R25's 4.4 put third and nobody had built.
--
-- Rounds 34 and 35 asked the catalogue a question DERIVED FROM THE CASE'S OWN
-- TEXT — which privileges the statement's keywords imply — and a set derived
-- from text the case writes is a set the case CHOOSES. R26 measured three
-- ways to choose it, against the head that shipped round 35:
--
--   W1 'SELECT 1 AS truncate FROM @REL@, p8other.p8bench_rel'     → PASS rc 0
--   W2 the row form with 'AS delete'                              → PASS rc 0
--   W3 'INSERT INTO p8other.p8bench_ro SELECT k FROM @REL@'       → PASS rc 0
--
-- `W1` and `W2` carry one extra DECLARED keyword as a column label, which
-- makes the conjunction smaller and switches the term off. `W3` needs no
-- trick at all and defeats the leading-keyword reading too: it needs SELECT
-- on the declared relation, which the role HOLDS, and INSERT on the twin,
-- which it lacks — so every reading of the case's text is silent, while the
-- refusal the case reads is about the twin. And the twin's message is
-- byte-identical, because the server names no schema.
--
-- So the set is taken FROM THE SERVER instead. `EXPLAIN (FORMAT JSON)` of the
-- same statement lists every relation the plan touches; the plan is produced
-- through a SECURITY DEFINER helper owned by the migrator, so a role that
-- holds everything does the planning and no ACL hides a relation from the
-- list. The statement must reach EXACTLY the declared relation and nothing
-- else. A statement that reaches a second relation cannot be evidence about
-- the first, whatever the server's message says and whatever privileges
-- anyone holds.
--
-- DECLARED BOUNDS of the reach term:
--   * the plan is what a non-ANALYZE EXPLAIN shows, so a relation reached by
--     a TRIGGER at run time is not in it. That is deliberate and it is the
--     EXPLAIN construction's question, not this one's: `Y1` plans as exactly
--     its declared relation and is refused by the construction.
--   * the helper pins `search_path` to `p8, public, pg_temp`, which is
--     `p8, public` — what every case file in this pack sets — with `pg_temp`
--     named LAST, which is PostgreSQL's own idiom for a definer: unnamed, it
--     is searched FIRST, so a caller's temporary relation could shadow a
--     schema name the plan resolves. ROUND 37, the coordinator's 6.4: the
--     sentence here used to omit the third entry, and a reader auditing the
--     pin would not have gone looking for an entry the prose left out. No
--     case role may create a temporary relation in this database (measured:
--     `permission denied to create temporary tables in database "daftar"`),
--     so the shadow is not reachable from a case either way. A session that
--     sets a different search_path resolves its declared relation differently
--     from the plan, and the comparison reds — fail-closed, by construction.
--   * a statement the planner cannot plan at all is refused by name here
--     rather than being admitted unmeasured.
--
-- DECLARED RESIDUAL, NOT CLOSED IN THIS COMMIT — ROUND 37, `R27-S-1` and the
-- coordinator's 6.1, and both reviewers rated it non-blocking. This helper is
-- `SECURITY DEFINER` owned by the migrator, and the runner grants EXECUTE on
-- it to all three case roles. PLANNING is not free of execution: the planner
-- FOLDS an `IMMUTABLE` function with constant arguments, so that function's
-- BODY runs — and under this wrapper it runs as the owner. The twenty-seventh
-- challenge measured the lever end to end: a role that may execute neither
-- `p8bench_tell()` nor read what it reads got both in one call. Writes are
-- refused by PostgreSQL itself (`INSERT is not allowed in a non-volatile
-- function`) and an injected tail is refused below, so no measured claim in
-- this gate is false because of it, and the helper lives in the proof schema
-- and ships in no migration. What closes it is a least-privilege planning
-- role — one holding nothing but the reads `EXPLAIN` needs — in place of the
-- migrator, who owns the law's own functions; roles in this project are
-- created by `bootstrap.sql`, which this pack does not write, so that is a
-- change of its own and not this commit's. Named here, with its measurement,
-- rather than left for a reader to find.
CREATE OR REPLACE FUNCTION p8.plan_nodes(node JSONB) RETURNS SETOF JSONB
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE child JSONB; k TEXT;
BEGIN
  IF node IS NULL THEN RETURN; END IF;
  IF jsonb_typeof(node) = 'array' THEN
    FOR child IN SELECT jsonb_array_elements(node) LOOP
      RETURN QUERY SELECT * FROM p8.plan_nodes(child);
    END LOOP;
    RETURN;
  END IF;
  IF jsonb_typeof(node) <> 'object' THEN RETURN; END IF;
  RETURN NEXT node;
  -- Every nested plan the server can hang off a node, named explicitly so a
  -- key this reader does not know cannot hide a relation: `Plans` carries
  -- children, InitPlan and SubPlan alike.
  FOREACH k IN ARRAY ARRAY['Plans', 'Plan'] LOOP
    IF node ? k THEN
      RETURN QUERY SELECT * FROM p8.plan_nodes(node -> k);
    END IF;
  END LOOP;
END $fn$;

CREATE OR REPLACE FUNCTION p8.plan_relations(stmt TEXT) RETURNS OID[]
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = p8, public, pg_temp AS $fn$
DECLARE j JSONB; oids OID[];
BEGIN
  -- ROUND 37, the coordinator's 6.1. This helper prepends text to the
  -- statement it is given and runs the result as the migrator, so a second
  -- statement riding on the first would run there too. Every caller inside
  -- this pack has already passed `p8.assert_single_statement`, which is where
  -- the law lives; this is the HELPER refusing for itself, so the guarantee
  -- does not depend on who calls it. Narrowing by text is fail-closed — it can
  -- only refuse, never admit — which is why it does not reintroduce the defect
  -- round 36 closed. The scanner blanks literals and strips comments, so a
  -- semicolon inside a payload is not one of these.
  -- ROUND 38, `R28-S-2`: one-argument `rtrim` strips SPACES only, so a
  -- statement ending `;` and a newline was refused. Fail-closed, and no live
  -- statement is that shape, but the guard was plainly written to tolerate
  -- trailing whitespace and tolerated one class of it.
  IF position(';' in rtrim(rtrim(p8.sql_scan(stmt), E' \t\n\r'), ';')) > 0 THEN
    RAISE EXCEPTION 'p8.plan_relations: MORE THAN ONE STATEMENT — this helper plans the statement '
                    'it is given as the role that owns it, so it will not be handed a second one'
      USING ERRCODE = 'P0001';
  END IF;
  EXECUTE 'EXPLAIN (FORMAT JSON, VERBOSE, COSTS OFF) ' || stmt INTO j;
  SELECT array_agg(DISTINCT o) INTO oids FROM (
    SELECT to_regclass(quote_ident(n ->> 'Schema') || '.'
                       || quote_ident(n ->> 'Relation Name'))::oid AS o
      FROM p8.plan_nodes(j) n
     WHERE n ? 'Relation Name' AND n ? 'Schema'
  ) t WHERE t.o IS NOT NULL;
  RETURN coalesce(oids, ARRAY[]::OID[]);
END $fn$;

CREATE OR REPLACE FUNCTION p8.case_refuses_core(label TEXT, stmt TEXT, expect TEXT, subject TEXT,
                                                kind TEXT, relation TEXT) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE msg TEXT; cons TEXT; sst TEXT; ctx TEXT; witnessed BOOLEAN; rowlevel BOOLEAN;
        eplan BOOLEAN; esst TEXT; emsg TEXT; servergrant BOOLEAN; named BOOLEAN;
        rlsdecision BOOLEAN; rlsrel TEXT;
        relid OID; holdspriv BOOLEAN; kindword TEXT; needprivs TEXT[]; leadkw TEXT; scanned TEXT;
        homonyms TEXT;
        raisedpriv BOOLEAN; impostor TEXT;
        reach OID[];
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
    --
    -- ROUND 32, R-2 (P2), measured by the twenty-second challenge and
    -- reproduced here: SQLSTATE 42501 alone does not say a GRANT decided
    -- anything. A trigger can raise it for one row —
    --   RAISE EXCEPTION 'permission denied for table t2: ROW-DECIDED-DENIAL'
    --     USING ERRCODE = '42501'
    -- — and the relation case passed, rc 0, because the class matched and the
    -- RLS phrase did not. So the third term is derived from the CONTEXT, the
    -- same arrival this pack already reads elsewhere: a refusal whose
    -- innermost frame is a PL/pgSQL function AT RAISE was raised by code that
    -- ran for a row, not taken by the server before any row was read. A grant
    -- or ownership denial, and an RLS WITH CHECK violation, both come from the
    -- server itself and carry no such frame.
    --
    -- ROUND 33: that last sentence is TRUE about the frame and the inference
    -- drawn from it was FALSE, measured by the twenty-third challenge. A
    -- grant denial does come from the server — and WHETHER THE SERVER IS
    -- EVER ASKED can be decided by the row. The term below it is kept and is
    -- no longer what carries this form; the paragraph that said the
    -- remaining class was empty is withdrawn.
    rowlevel := (sst <> '42501'
                 OR position('row-level security policy' in lower(coalesce(msg,''))) > 0
                 OR split_part(coalesce(ctx,''), E'\n', 1) ~ 'PL/pgSQL function .* at RAISE');
    IF kind = 'relation' AND rowlevel THEN
      RAISE EXCEPTION '% FAIL: A RELATION CASE REFUSED BY SOMETHING ROW-LEVEL — this form claims '
                      'the refusal is about "%" as a whole, and what arrived is [%] %, which is '
                      'decided by the row rather than by a grant. Use case_refuses_row and declare '
                      'the key the refusal is about (W-3, R-2). Innermost frame: %',
        label, subject, sst, msg, split_part(coalesce(ctx,''), E'\n', 1);
    END IF;
    -- ROUND 33, the twenty-third challenge's D-1, which is round 22's R-2
    -- again: the term above closes the route it was built for and not the
    -- class. It asks WHO RAISED the refusal; what this form needs answered is
    -- WHETHER THE OUTCOME DEPENDED ON THE ROW. A trigger that reaches an
    -- object the role may not touch, for one row's content only, makes the
    -- SERVER raise 42501 — no `at RAISE` frame, no RLS phrase, the innermost
    -- frame is `SQL statement "SELECT count(*) FROM forbidden"` — and the
    -- relation case passed on it, with the relation witness attesting only
    -- that the relation exists.
    --
    -- Both reviewers prescribed a control ROW: run the statement against a
    -- second row the case declares and require the refusal for both. I did
    -- not take that, and the reason is the one this phase keeps re-learning —
    -- the control would be chosen by the case, so a trigger that refuses for
    -- both declared values passes it, and the form would again be evidence
    -- about two rows rather than about the relation.
    --
    -- What the form needs is answerable by CONSTRUCTION, from the server, and
    -- the server already has the question built in. A relation-level refusal
    -- is a permission decision taken when the executor starts, BEFORE any row
    -- is processed; `EXPLAIN` starts the executor and processes no row. So:
    -- plan the same statement and require the same refusal to arrive. The
    -- measurements that decide this, taken on PostgreSQL 16.15 as an
    -- unprivileged role:
    --
    --   INSERT INTO nogrant VALUES (1)   → 42501 permission denied
    --   EXPLAIN INSERT INTO nogrant …    → 42501 permission denied   (same)
    --   EXPLAIN SELECT * FROM nogrant    → 42501 permission denied
    --   INSERT INTO t3 VALUES ('BAD')    → 42501, raised inside a trigger
    --   EXPLAIN INSERT INTO t3 VALUES ('BAD')  → a PLAN, no refusal
    --
    -- A grant denial reproduces under the plan; a row-decided one cannot,
    -- because no row is ever reached. That ends the question in behaviour
    -- rather than in the wording of `PG_EXCEPTION_CONTEXT`, and it does not
    -- enumerate mechanisms: anything that needs a row to happen is invisible
    -- to the planner, whatever raises it.
    --
    -- ROUND 34, the coordinator's 3.2 and the twenty-fourth challenge's
    -- residual 3, both measured and both in the SAME direction. The sentence
    -- above — anything that needs a row is invisible to the planner — is true,
    -- and the inference this code draws is its CONVERSE: from "it did not
    -- reproduce under the plan" it concludes "a row decided it". That converse
    -- is false, and there are two measured counterexamples:
    --
    --   * a STATEMENT-level trigger refuses every statement, with no row
    --     processed and nothing row-decided about it, and the planner never
    --     fires it:
    --       CREATE TRIGGER … AFTER INSERT ON t FOR EACH STATEMENT …
    --       INSERT INTO t VALUES ('x')          → 42501
    --       EXPLAIN INSERT INTO t VALUES ('x')  → a PLAN
    --   * a sequence USAGE denial on `INSERT … DEFAULT VALUES` is reached at
    --     run time and does not arrive from the plan either.
    --
    -- Both would be refused here as "needing a row". That is the fail-CLOSED
    -- direction — this form sends such a case to the row form or to another
    -- shape, it never passes one — so it is a NAMED BOUND of the construction
    -- and not a hole, and it is written here rather than left to a reader to
    -- discover. No case in this pack is of either shape.
    --
    -- A statement the server will not PLAN is refused by name rather than
    -- waved through. `EXPLAIN TRUNCATE t` is a syntax error (42601), so a
    -- TRUNCATE relation case cannot be verified this way and this form says
    -- so instead of passing it. No case in this pack is one today — the four
    -- relation cases are three SELECTs and an INSERT — so this refuses
    -- nothing that exists and refuses the first one that arrives, which is
    -- the direction this phase requires of a law it cannot complete.
    IF kind = 'relation' THEN
      BEGIN
        EXECUTE 'EXPLAIN ' || stmt;
        eplan := TRUE;
      EXCEPTION WHEN others THEN
        GET STACKED DIAGNOSTICS esst = RETURNED_SQLSTATE, emsg = MESSAGE_TEXT;
        eplan := FALSE;
      END;
      IF eplan THEN
        RAISE EXCEPTION '% FAIL: THE REFUSAL DID NOT ARRIVE BEFORE ANY ROW WAS READ — this form '
                        'claims the refusal is about "%" as a whole, and the server PLANNED the '
                        'same statement without refusing, so what arrived ([%] %) needed a row to '
                        'be processed and is not a decision about the relation. A trigger, a '
                        'constraint or any other per-row mechanism can produce it for one row and '
                        'not another. Use case_refuses_row and declare the key the refusal is '
                        'about (D-1, W-3, R-2)',
          label, subject, sst, msg;
      ELSIF esst = '42601' THEN
        RAISE EXCEPTION '% FAIL: THIS FORM CANNOT VERIFY A STATEMENT THE SERVER WILL NOT PLAN — '
                        'the relation form proves a refusal is relation-level by requiring it to '
                        'arrive from EXPLAIN, which processes no row, and the server answered '
                        '[%] % to EXPLAIN of this statement. TRUNCATE is the known shape. Write '
                        'the case in a form whose evidence this pack can build (D-1)',
          label, esst, emsg;
      ELSIF esst <> sst OR position(expect in coalesce(emsg,'')) = 0 THEN
        RAISE EXCEPTION '% FAIL: THE PLANNED REFUSAL IS NOT THE ONE THAT ARRIVED — running the '
                        'statement gave [%] % and planning it gave [%] %, so the refusal this '
                        'case reads is not the relation-level one the plan meets (D-1)',
          label, sst, msg, esst, emsg;
      END IF;
    END IF;
    -- ROUND 34, the coordinator's section 4 (P1), REWRITTEN IN ROUND 35 after
    -- both reviews of `b1b4b7a` measured the pair still open (R25-F-1, the
    -- coordinator's 3.2). Every law above says something true about the
    -- refusal and NONE of them says what it is ABOUT. Measured on
    -- PostgreSQL 16.15 as an unprivileged role that HAS `SELECT` on `rela`:
    --
    --   X1 case_refuses_relation(… 'SELECT public.rela() FROM @REL@' …, 'rela')
    --     → PASS refused by permission denied [42501], rc 0
    --   X2 … 'SELECT 1 FROM @REL@, other.rela' …                     → PASS
    --   X3/X4 the same two statements in the row form                → PASS
    --   X5 X2 with `expect` spelled 'permission denied for table rela' → PASS
    --   SELECT count(*) FROM rela → 1, so the claim is FALSE of the subject
    --
    -- Round 34's two terms did not bound these. Its arrival term read the
    -- server's message for the BARE name, so `permission denied for function
    -- rela` (X1, X4) and `permission denied for table rela` about ANOTHER
    -- SCHEMA's `rela` (X2, X3, X5) both satisfied it — the message carries no
    -- schema and no kind. Its catalogue term asked whether the role held ALL
    -- SEVEN table privileges, which is the COMPLEMENT of the question and not
    -- its negation: it speaks only for a role that holds everything, so it was
    -- silent for every role in this pack, and the reviews showed that what red
    -- round 34's own T4 was the bench's `GRANT ALL PRIVILEGES` line and not the
    -- shape of the attack.
    --
    -- Two terms, neither of them a text test on prose the CASE controls, and
    -- both only where the SERVER itself took a grant decision — a refusal a
    -- trigger raised, an RLS WITH CHECK violation or a constraint is decided
    -- somewhere else and the rules above are what bound those.
    --
    --   (a) BY ARRIVAL, KIND-QUALIFIED: the server's own message must be
    --       `permission denied for <kind> <declared>`, where <kind> is read
    --       from the declared relation's OWN `relkind` in `pg_class` (plus
    --       the version-independent spelling `relation`). The server names
    --       the kind of the object it refused — measured on 16.15: `table`,
    --       `view`, `materialized view`, `foreign table`, `sequence`,
    --       `function` — so a refusal about a FUNCTION wearing the declared
    --       relation's name no longer arrives, which is what the bare token
    --       test could not see. ROUND 36, R26-S-3: the MAP below covers the
    --       first four of those kinds only (`relkind` r/p/v/m/f). A declared
    --       SEQUENCE is refused by name as a kind this form cannot read out
    --       of the message, and a `function` is not a relation and cannot be
    --       declared at all — both fail-closed, and no case in this pack is
    --       either.
    --   (b) BY CONSTRUCTION, from the catalogue, the NEGATION and not the
    --       complement: the privilege the statement needs is derived from its
    --       LEADING keyword (SELECT, INSERT, UPDATE, DELETE, TRUNCATE — the
    --       five whose table privilege is the keyword's own), plus UPDATE
    --       where the statement carries an `ON CONFLICT … DO UPDATE`, and the
    --       role must NOT hold all of them on the declared relation. A role
    --       that holds every privilege the statement needs cannot have been
    --       refused BY A GRANT on that relation, so the refusal is about
    --       something else — which is what catches the cross-schema twin,
    --       whose message is BYTE-IDENTICAL to the one the declared relation
    --       would produce. The derivation is POSITIONAL on purpose: round 35
    --       read every keyword PRESENT, and one declared keyword carried as a
    --       column label switched the term off (Z1, Z2 — the reason is
    --       written at the term itself).
    --
    -- Measured consequence of (b)'s semantics, and the reason it is the right
    -- question: `has_table_privilege(…, 'UPDATE')` answers FALSE for a role
    -- holding only a COLUMN-scoped `UPDATE (col)` grant, which is exactly the
    -- live W-2 and W-6 shape — the server refused those `permission denied for
    -- table`, and the catalogue agrees the table-level privilege is absent.
    --
    -- DECLARED BOUNDS of the pair, neither of them a fail-open:
    --   * (a) is kind-qualified but still not SCHEMA-qualified, because the
    --     server's message carries no schema; what closes the cross-schema
    --     half is (b), through the privilege, and only while the role lacks
    --     the needed privilege on the declared relation. A twin in another
    --     schema refusing a role that ALSO lacks the privilege on the declared
    --     one is UNMEASURED here, and `R25-F-1`'s X5 is why no text test on
    --     the message can close it.
    --   * the declared relation is resolved with `to_regclass` and therefore
    --     THROUGH `search_path`; a case that declares a bare name resolving to
    --     a different schema than the statement reaches is bounded by (b)'s
    --     privilege question on whatever it resolved to, not by name.
    --   * (b) OVER-REFUSES, fail-closed, where a role holds the table-level
    --     privilege and is refused by a COLUMN grant on the same relation:
    --     that case is genuinely about the declared relation and this form
    --     will red it. No live case is that shape (the six relation and row
    --     sites lead with SELECT, INSERT or UPDATE and none is column-denied
    --     while holding the table-level privilege).
    IF relation IS NOT NULL AND kind IN ('relation', 'row') THEN
      -- ROUND 39, `R29-F-2`. The bound below this block used to say that a
      -- refusal the server did not decide as a GRANT -- a trigger's own
      -- `RAISE ... USING ERRCODE = '42501'` among them -- was bounded by
      -- `assert_arriving_class`, the handler ban and the EXPLAIN
      -- construction. For the ROW form that sentence was FALSE, and round 38
      -- published it as withdrawn while leaving the paragraph byte-identical
      -- to its parent's. It is withdrawn HERE, in the only way a withdrawal
      -- counts, by the attack it admitted being measured and closed.
      --
      -- Measured on this cluster (PG 16.15), on the parent `4003984`:
      --
      --   public.p8c29_h, `GRANT SELECT, UPDATE` to daftar_worker, with a
      --   BEFORE UPDATE trigger whose whole body is
      --     RAISE EXCEPTION 'permission denied for table p8c29_h'
      --       USING ERRCODE = '42501';
      --   and the case
      --     case_refuses_row('ATK-H2', 'UPDATE @REL@ SET v = 2',
      --                      'permission denied', 'p8c29_h', 'k', 'a')
      --     -> NOTICE: ATK-H2 PASS refused by permission denied [42501], rc 0
      --
      --   Route removal: `ALTER TABLE public.p8c29_h DISABLE TRIGGER
      --   p8c29_htg` and the same UPDATE by the same role returns UPDATE 1.
      --   So the role MAY do the thing the case published as refused, and
      --   the relation case's `rowlevel` term never saw it because that term
      --   refuses the RELATION form only.
      --
      -- The class cannot be refused outright, and the reason is in this
      -- pack's own bench: `REACH-BENCH` refuses with a code `RAISE` at 42501
      -- on purpose, so that whether the composed predicate APPLIES is read
      -- off an outcome instead of off the statement's text, and `RB-honest`,
      -- `RB-comment`, `RB-semi` and `RB-astral` all run through it. A row
      -- form that rejected every code-raised 42501 would delete those four
      -- arms, which is the `R28` lesson inverted: a guard that reds the
      -- instrument measures nothing.
      --
      -- What CAN be closed by construction is the only thing that made
      -- ATK-H2 a false published claim: it asserted a refusal that code
      -- wrote AS the server's own privilege decision. The server's privilege
      -- prose is BUILT here from the declared relation's name, never read
      -- out of the arriving message, and a code-raised 42501 whose assertion
      -- overlaps that prose in either direction is refused by name. The test
      -- is overlap and not equality because equality leaves the near miss
      -- (one trailing space in the raised message, `expect` spelling it) that
      -- the `R29-F-1` parse left in its own term.
      --
      -- DECLARED BOUND, stated as what it admits rather than as what it
      -- covers: a code-raised 42501 asserted by prose of the case's OWN,
      -- which the server never prints -- `DENIED-BY-THE-OTHER-ROW` is the
      -- live example -- is admitted and takes no attribution term. Such a
      -- case cannot carry a privilege claim, because the string it publishes
      -- as the refusal is not a string the server can produce; what it
      -- claims is that the statement was refused and by which prose, which
      -- is what the four bench arms claim. The window is named, and the
      -- case that was built to walk through it (ATK-H2) now reds.
      raisedpriv := (sst = '42501'
                     AND split_part(coalesce(ctx,''), E'\n', 1) ~ 'PL/pgSQL function .* at RAISE');
      IF raisedpriv AND coalesce(expect, '') <> '' THEN
        SELECT string_agg(c.cand, ' / ') INTO impostor FROM (
          SELECT cand FROM unnest(ARRAY[
            'permission denied for table ' || lower(relation),
            'permission denied for view ' || lower(relation),
            'permission denied for materialized view ' || lower(relation),
            'permission denied for sequence ' || lower(relation),
            'permission denied for foreign table ' || lower(relation),
            'permission denied for relation ' || lower(relation),
            'new row violates row-level security policy for table "'
              || lower(relation) || '"',
            'new row violates row-level security policy (USING expression) for table "'
              || lower(relation) || '"',
            'query would be affected by row-level security policy for table "'
              || lower(relation) || '"'
          ]) AS cand
        ) c
        WHERE position(lower(expect) in c.cand) > 0
           OR position(c.cand in lower(expect)) > 0;
        IF impostor IS NOT NULL THEN
          RAISE EXCEPTION '% FAIL: A CODE-RAISED 42501 IS ASSERTED AS A SERVER PRIVILEGE REFUSAL '
                          '- the refusal that arrived was written by a RAISE inside the database '
                          '(innermost frame: %), so no catalogue decided it and nothing in it is '
                          'about "%", yet this case asserts it with "%", which overlaps the prose '
                          'the SERVER itself would print for that relation (%). Assert the refusal '
                          'this code actually raises, in prose the server cannot produce, or make '
                          'the case one the server decides (R29-F-2). Arrived: [%] %',
            label, split_part(coalesce(ctx,''), E'\n', 1), relation, expect, impostor, sst, msg;
        END IF;
      END IF;
      servergrant := (sst = '42501'
                      AND position('row-level security policy' in lower(coalesce(msg,''))) = 0
                      AND split_part(coalesce(ctx,''), E'\n', 1) !~ 'PL/pgSQL function .* at RAISE');
      -- ROUND 38, `R28-F-1` (P1, fail-open), reproduced here before anything
      -- was changed. Every attribution term above and below sat inside
      -- `servergrant`, and `servergrant` EXCLUDES the row-level-security
      -- class by construction. For the ROW form nothing else asked the
      -- question: `assert_arriving_class` admits 42501 outright for a row
      -- case and asks nothing about which relation, the handler ban reads the
      -- statement's own block, and the EXPLAIN construction is relation-only.
      -- So a row case passed at rc 0 on a refusal about a DIFFERENT relation
      -- entirely — measured, with `expect` spelling that other relation's
      -- name in full:
      --
      --   UPDATE @REL@ SET v = 2, declared `p8r28_d`, whose BEFORE UPDATE
      --   trigger inserts a row an RLS policy on `p8r28_rls` rejects
      --     → PASS refused by new row violates row-level security policy for
      --       table "p8r28_rls" [42501], rc 0
      --
      -- The previous head's own declared bound said this residue was covered
      -- by `assert_arriving_class`, the handler ban and the construction.
      -- That sentence was FALSE of the row form for this class. ROUND 39,
      -- `R29-F-2`: this paragraph then said it was "withdrawn below at the
      -- bound it belonged to", and no such edit was made — the paragraph
      -- stayed byte-identical to its parent's, so round 38 shipped a second
      -- false claim on top of the first. The withdrawal is in this head, at
      -- that bound, and the sentence above is true of THIS head only.
      --
      -- It needs no fourth reader. An RLS refusal names its object IN THE
      -- MESSAGE, quoted — `for table "<name>"` — so the answer is the
      -- SERVER'S and not the case's text, which is the only kind of answer
      -- this law takes. The class is admitted into the block with an arrival
      -- term of its own, and the name it yields is a BARE one, so it is
      -- carried by the same name-uniqueness term the grant class uses.
      rlsdecision := (sst = '42501'
                      AND position('row-level security policy' in lower(coalesce(msg,''))) > 0
                      AND split_part(coalesce(ctx,''), E'\n', 1) !~ 'PL/pgSQL function .* at RAISE');
      IF servergrant OR rlsdecision THEN
        relid := to_regclass(p8.quoted_ident(relation));
        IF relid IS NULL THEN
          RAISE EXCEPTION '% FAIL: THE DECLARED RELATION DOES NOT RESOLVE — "%" is not visible as '
                          'a relation in this session''s search_path, so neither the statement''s '
                          'reach nor the catalogue can be compared against it (R26-F-1)',
            label, relation;
        END IF;
        SELECT CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'table' WHEN 'v' THEN 'view'
                              WHEN 'm' THEN 'materialized view' WHEN 'f' THEN 'foreign table'
               END INTO kindword
          FROM pg_class c WHERE c.oid = relid;
        IF kindword IS NULL THEN
          RAISE EXCEPTION '% FAIL: THIS FORM CANNOT ASK WHO THE REFUSAL IS ABOUT — the declared '
                          'relation "%" is not a kind this form knows how to read out of the '
                          'server''s refusal, so the arrival term cannot be evaluated (R25-F-1)',
            label, relation;
        END IF;
        IF relation !~ '^[a-z_][a-z0-9_]*$' THEN
          RAISE EXCEPTION '% FAIL: THIS FORM CANNOT ASK WHO THE REFUSAL IS ABOUT — the declared '
                          'relation "%" is not a plain lower-case identifier, so neither the '
                          'kind-qualified test on the server''s message nor the catalogue lookup '
                          'can be evaluated for it, and this form will not pass a refusal it '
                          'cannot attribute (R25-F-1)', label, relation;
        END IF;
      IF rlsdecision THEN
        -- The RLS arrival term. PostgreSQL spells the object in every message
        -- of this class with `for table "<name>"` — measured on 16.15 in both
        -- spellings, with and without the policy's own name in front of it —
        -- so the quoted name is read out of the server's words and compared
        -- to the declared relation. A message of this class this form cannot
        -- read is refused by name rather than admitted unmeasured. The reach
        -- term is NOT asked here and the reason is the class itself: an RLS
        -- refusal is a decision about a ROW, so the set of relations the
        -- statement touches is not the question. The NAME is, and it is bare,
        -- which is why the uniqueness term below runs for this class too.
        -- ROUND 39, `R29-F-1`. Round 38 PARSED this name out of the server's
        -- prose with `for table "([^"]*)"[^"]*$`, and defended it by saying
        -- the text comes from the server rather than from the case. That is
        -- true of who EMITS the message and false of what the message
        -- CONTAINS: PostgreSQL builds both of these messages with `%s` on the
        -- bare relation name, with no quoting and no escaping of the very
        -- delimiter the message uses. So the field was attacker-adjacent data
        -- inside server prose, and the law's own regex decided where it
        -- ended. Measured, on this head's parent and on round 38 alike:
        --
        --   a relation named `z" for table "p8c29_d` carrying the policy, and
        --   a case declaring `p8c29_d`
        --     → the server says: new row violates row-level security policy
        --       for table "z" for table "p8c29_d"
        --     → the regex's `$` anchor reads the LAST field, `p8c29_d`
        --     → PASS at rc 0, with `expect` spelling the other relation's
        --       whole message if the case likes
        --
        -- The anchor was put there so a POLICY name carrying the delimiter
        -- could not win, because the server prints the policy BEFORE the
        -- table. The relation is printed LAST, so an injected field inside it
        -- IS the last field and the anchor selects it. No anchor fixes this:
        -- the message is genuinely ambiguous, because the name was never
        -- escaped.
        --
        -- So the message is no longer PARSED. It is BUILT, from the declared
        -- relation's own name and from the policy names this database carries
        -- ON that relation, and the server's message must equal one of those
        -- candidates byte for byte. Every field in a candidate is supplied by
        -- the catalogue, so a name cannot inject one. The five shapes below
        -- are PostgreSQL 16's own, measured.
        --
        -- DECLARED BOUNDS. A refusal naming a PARTITION of a declared
        -- partitioned parent would not match a candidate built for the
        -- parent, and is refused by name — fail-closed, and no case in this
        -- pack declares a partitioned relation. The challenger also proposed
        -- requiring `relrowsecurity` on the declared relation for this class.
        -- It is NOT added, and the reason is this phase's own rule that a
        -- guard nobody can run is not a guard: with the message BUILT rather
        -- than read, a message equal to a candidate constructed for the
        -- declared relation is already a message about the declared relation,
        -- so the extra term could never be the thing that refuses and would
        -- ship with no arm. Recorded rather than silently dropped.
        SELECT bool_or(lower(coalesce(msg,'')) = cand) INTO named FROM (
          SELECT lower(pre || 'for table "' || relation || '"') AS cand
            FROM unnest(ARRAY['new row violates row-level security policy ',
                              'new row violates row-level security policy (USING expression) ',
                              'query would be affected by row-level security policy ']) AS pre
          UNION ALL
          SELECT lower('new row violates row-level security policy "' || pol.polname
                       || '" ' || pre || 'for table "' || relation || '"')
            FROM pg_policy pol
            CROSS JOIN unnest(ARRAY['', '(USING expression) ']) AS pre
           WHERE pol.polrelid = relid
        ) c;
        IF NOT coalesce(named, FALSE) THEN
          RAISE EXCEPTION '% FAIL: THE ROW-LEVEL REFUSAL IS ABOUT ANOTHER RELATION — this case '
                          'declares the % "%" and the server answered [%] %, which is not any of '
                          'the messages PostgreSQL would write for a policy on THAT relation. '
                          'This form BUILDS those messages from the catalogue — the declared '
                          'name and the policies this database carries on it — rather than '
                          'reading a name out of the server''s prose, because the server writes '
                          'the name unescaped and a relation named with the delimiter injected a '
                          'field that every anchor read as the real one (R28-F-1, R29-F-1)',
            label, kindword, relation, sst, msg;
        END IF;
      END IF;
      IF servergrant THEN
          -- (0) BY REACH, FROM THE SERVER, and it runs FIRST of the three:
          -- a statement that touches a second relation is not evidence about
          -- the first, whatever the server's message says and whatever
          -- privileges anyone holds. The prose above `p8.plan_relations` says
          -- why the set is taken from the plan and not from the case's own
          -- keywords.
          --
          -- DECLARED BOUND on its placement: it sits inside the grant-decision
          -- condition with the other two terms, so a case refused by something
          -- the server did not decide as a GRANT — a trigger's RAISE, a
          -- constraint, an error the statement computed for itself — is not
          -- reach-checked. The measurement that put it here is `RB-class`:
          -- `SELECT 1/0 FROM @REL@` is folded by the PLANNER, so EXPLAIN
          -- raises 22012 and a reach term outside this condition refused an
          -- honest probe for a reason that has nothing to do with reach.
          --
          -- WITHDRAWN, ROUND 39, `R29-F-2`. This paragraph used to end with
          -- the sentence "Those are what `assert_arriving_class`, the handler
          -- ban and the EXPLAIN construction bound". That sentence was FALSE
          -- of the ROW form, and what falsified it is ATK-H2: a trigger whose
          -- body is one `RAISE ... USING ERRCODE = '42501'` spelling the
          -- server's own privilege prose, on a relation the role may in fact
          -- update, passing at rc 0 with `expect` = 'permission denied'.
          -- `assert_arriving_class` admits 42501 for a row case and asks
          -- nothing further; the handler ban reads the statement's own block,
          -- and this trigger has none; the EXPLAIN construction is the
          -- relation form's. Round 38 published the sentence as withdrawn and
          -- left it byte-identical to its parent's, which is the second false
          -- claim it cost. What is true now is written at the top of this
          -- block, with the term that closes the assertion and the named
          -- bound on what stays admitted.
        -- ROUND 38. The declared relation is resolved, its kind read and its
        -- identifier shape checked ABOVE, because the row-level class needs
        -- the same three and a security term written twice is a term that
        -- drifts.
        -- ROUND 37, `R27-S-2`. A plain VIEW is expanded by the REWRITER, so the
        -- plan names the view's base tables and never the view itself —
        -- measured on 16.15: `SELECT k FROM p8bench_vw` plans as
        -- `public.p8bench_own` and the view's own oid appears nowhere. The
        -- reach term below can therefore never be satisfied by a view, and
        -- before this refusal existed such a case was told its statement
        -- "reaches more than the declared relation" when what it really
        -- reaches is that relation's own definition. The over-refusal is
        -- fail-CLOSED and stays; what changes is that the message now names
        -- the real reason. Materialized views are unaffected: the server scans
        -- them directly and the plan names them, so `m` is still a kind this
        -- form reads. No case in this pack declares a view.
        IF kindword = 'view' THEN
          RAISE EXCEPTION '% FAIL: THIS FORM CANNOT BOUND A STATEMENT ABOUT A VIEW — the declared '
                          'relation "%" is a view, and a view is expanded by the rewriter before '
                          'the planner sees it, so the plan this form reads names the view''s BASE '
                          'relations and never the view. The reach term can never be satisfied for '
                          'one, so this form refuses the case by name rather than reporting that '
                          'the statement reaches more than its subject (R27-S-2)',
            label, relation;
        END IF;
        BEGIN
          reach := p8.plan_relations(stmt);
        EXCEPTION WHEN others THEN
          GET STACKED DIAGNOSTICS esst = RETURNED_SQLSTATE, emsg = MESSAGE_TEXT;
          -- ROUND 37, the coordinator's 6.2, and the window this branch used to
          -- open is GONE rather than narrowed. Round 36 admitted one case
          -- unmeasured: where the PLAN and the RUN both gave a kind-qualified
          -- 42501 about the declared relation, the reach was left UNREAD and
          -- the case continued on the other terms. The window was exactly "a
          -- declared relation the OWNER itself may not touch", and only one
          -- probe in this pack entered it — `FB-i`, which declared `pg_class`
          -- for no reason but that a row of it exists in every configuration.
          -- Both reviews measured a case walking into the window on purpose
          -- and passing while reaching a second relation the role cannot read.
          -- `FB-i` is re-aimed at `notifications`, an ordinary relation the
          -- worker may not write, and with nothing left in the window the
          -- branch is deleted: ANY failure to plan refuses by name. That is
          -- the fail-closed direction, and it removes a hole instead of
          -- trading it for a wider definer.
          RAISE EXCEPTION '% FAIL: THIS FORM CANNOT BOUND THE STATEMENT''S REACH — the server '
                          'answered [%] % when asked to PLAN this statement for a role that '
                          'holds everything, so the set of relations it touches cannot be read '
                          'out of the plan, and this form will not pass a refusal whose subject '
                          'it cannot bound (R26-F-1, the coordinator''s 6.2)', label, esst, emsg;
        END;
        IF reach <> ARRAY[relid] THEN
          RAISE EXCEPTION '% FAIL: THE STATEMENT REACHES MORE THAN THE DECLARED RELATION — this '
                          'case declares "%" (oid %) and the server''s own plan for this statement '
                          'touches %, so whatever was refused, the evidence is not about "%" alone. '
                          'A second relation the statement reaches can be the one the refusal is '
                          'about, and its message is byte-identical when it wears the same name '
                          '(R26-F-1 W1/W2/W3, the coordinator''s Z1/Z2)',
            label, relation, relid,
            (SELECT coalesce(string_agg(r::regclass::text, ', ' ORDER BY r::regclass::text),
                             'nothing at all') FROM unnest(reach) AS r),
            relation;
        END IF;
        -- ROUND 39, `R29-F-1`, and this term is in its fifth round of the same
        -- class. It ended in a boundary CLASS rather than at the end of the
        -- message, so a twin whose name was the declared name plus any
        -- character outside [a-z0-9_] satisfied it — measured: a twin named
        -- `p8c29_g x` produces `permission denied for table p8c29_g x`, which
        -- the old regex matched, and the case passed at rc 0 while the role
        -- was free to do what the case said it may not (route removal
        -- checked: with the trigger disabled the statement is ACCEPTED).
        --
        -- PostgreSQL writes this message with `%s` on the bare name and
        -- nothing after it, so the name runs to the END of the message. The
        -- test is therefore byte EQUALITY against the two messages the server
        -- could write about the declared relation, built from its own
        -- `relkind` — not a pattern with a boundary to get wrong.
        named := lower(coalesce(msg,'')) IN
                   ('permission denied for ' || kindword || ' ' || lower(relation),
                    'permission denied for relation ' || lower(relation));
        IF NOT named THEN
          RAISE EXCEPTION '% FAIL: THE REFUSAL IS NOT ABOUT THE DECLARED RELATION — this case '
                          'declares the % "%" and the server refused with [%] %, which is not '
                          '"permission denied for % %". A grant decision the server takes names '
                          'the KIND and the name of the object it refused, and this one is about '
                          'something else the statement reached — another relation, or a function '
                          'the role may not execute, even one wearing this relation''s own name '
                          '(R25-F-1, the coordinator''s 3.2)',
            label, kindword, relation, sst, msg, kindword, relation;
        END IF;
        -- ROUND 36, the coordinator's 3.1 and 3.2 (P1), and it REPLACES round
        -- 35's reading of this term. Round 35 read EVERY privilege-bearing
        -- keyword the scanned statement carried and required the role to hold
        -- ALL of them. That conjunction gets SMALLER as the statement gets
        -- longer: one extra keyword whose privilege the role lacks turns it
        -- false and takes the term out of the law. Both forms DECLARE a
        -- privilege-bearing keyword no statement of that form needs, and a
        -- column label is enough to carry it — measured on 16.15 against the
        -- head that shipped round 35:
        --
        --   Z1 case_refuses_relation(… 'SELECT 1 AS truncate FROM @REL@, other.rela' …, 'rela')
        --     → PASS refused by permission denied [42501], rc 0
        --   Z2 the row form with 'AS delete'                              → PASS, rc 0
        --   SELECT count(*) FROM rela → 1, so the claim is FALSE of the subject
        --
        -- The guard's monotonicity was backwards. What runs now derives the
        -- privilege from POSITION, which a column label can never occupy: the
        -- statement's LEADING keyword, plus UPDATE where the statement really
        -- carries an `ON CONFLICT … DO UPDATE`. That reds Z1 and Z2, leaves
        -- X2, X3, X5 and T6 exactly as they were, and still answers {INSERT,
        -- UPDATE} for the `FB-f` shape, so `WITNESS-SHAPE-CTL` keeps its
        -- attribution. (`\y` is PostgreSQL's word boundary; `\b` is a
        -- backspace, which matches nothing here and would fail silently.)
        --
        -- ROUND 35's JUSTIFICATION FOR READING EVERY KEYWORD IS WITHDRAWN. It
        -- said `FB-f` reds under the leading-keyword reading. `FB-f` never
        -- reaches this term: `assert_shape` refuses it first, for the
        -- keywords `conflict, do, on, set, update`, which the relation form
        -- does not declare — measured. It reaches this term only inside
        -- `WITNESS-SHAPE-CTL`, which deletes that guard on purpose. The
        -- sentence presented a live over-refusal and there was none; what was
        -- really at stake was a control's attribution, and trading a
        -- fail-open in the law for an attribution in a control is backwards.
        scanned := p8.sql_scan(stmt);
        leadkw := lower(coalesce((regexp_match(scanned, '^[^A-Za-z]*([A-Za-z]+)'))[1], ''));
        needprivs := CASE leadkw WHEN 'select' THEN ARRAY['SELECT']
                                 WHEN 'insert' THEN ARRAY['INSERT']
                                 WHEN 'update' THEN ARRAY['UPDATE']
                                 WHEN 'delete' THEN ARRAY['DELETE']
                                 WHEN 'truncate' THEN ARRAY['TRUNCATE'] END;
        IF needprivs IS NOT NULL
           AND scanned ~* '\yon\s+conflict\y.*\ydo\s+update\y'
           AND NOT ('UPDATE' = ANY (needprivs)) THEN
          needprivs := array_append(needprivs, 'UPDATE');
        END IF;
        IF needprivs IS NULL THEN
          RAISE EXCEPTION '% FAIL: THIS FORM CANNOT DERIVE THE PRIVILEGE THE STATEMENT NEEDS — it '
                          'leads with "%", which is not one of the five keywords whose table '
                          'privilege is the keyword''s own (SELECT, INSERT, UPDATE, DELETE, '
                          'TRUNCATE), so the catalogue cannot be asked the question that '
                          'attributes the refusal, and this form will not pass a refusal it '
                          'cannot attribute (R25-F-1, the coordinator''s 3.5)', label, leadkw;
        END IF;
        BEGIN
          SELECT bool_and(has_table_privilege(current_user, relid, pr)) INTO holdspriv
            FROM unnest(needprivs) AS pr;
        EXCEPTION WHEN others THEN
          GET STACKED DIAGNOSTICS emsg = MESSAGE_TEXT;
          RAISE EXCEPTION '% FAIL: THE CATALOGUE COULD NOT BE ASKED ABOUT THE DECLARED RELATION — '
                          'has_table_privilege(%, "%", %) answered %, so the second term of the '
                          'attribution law cannot be evaluated and this form will not pass a '
                          'refusal it cannot attribute (R25-F-1)',
            label, current_user, relation, array_to_string(needprivs, ','), emsg;
        END;
        IF holdspriv THEN
          RAISE EXCEPTION '% FAIL: THE ROLE HOLDS EVERY PRIVILEGE THE STATEMENT NEEDS ON THE '
                          'DECLARED RELATION — this case says a grant refuses % on "%", the '
                          'statement leads with a keyword needing %, and the catalogue says '
                          'the role HOLDS all of them on it. Whatever [%] % was about, it was not '
                          'a grant on this relation: the message names no schema, so a same-named '
                          'relation in another schema produces a byte-identical one '
                          '(R25-F-1 X2/X5)',
            label, current_user, relation, array_to_string(needprivs, ', '), sst, msg;
        END IF;
      END IF;
        -- ROUND 37, `R27-F-1`, and it is the fourth round of ONE class. The
        -- three terms above are each sound and the class survives all three,
        -- because every one of them is blind in the same place: the server's
        -- grant refusal names a KIND and a BARE NAME and no schema, so a
        -- relation in another schema wearing the declared relation's name
        -- produces a BYTE-IDENTICAL message. Round 36 closed the half of the
        -- class the PLAN can see. The twenty-seventh challenge built the half
        -- it cannot, and this author reproduced it and then found it is not
        -- one half but two. Measured on 16.15, each a case that PASSED at
        -- rc 0 on `54f3a53` while the refusal was about another relation:
        --
        --   R1  the ROW form. A BEFORE UPDATE trigger on the declared
        --       relation reads a same-named twin; the UPDATE grant is
        --       COLUMN-scoped. reach = {declared} — a non-ANALYZE plan does
        --       not enter triggers; arrival matches byte for byte;
        --       has_table_privilege answers FALSE for a column grant, so the
        --       privilege term is silent. PASS.
        --   F2  the RELATION form. ROUND 38, `R28-F-2`: THE ARM ROUND 37
        --       SHIPPED FOR THIS HALF WAS AN HONEST CASE AND ITS PUBLISHED
        --       SENTENCES WERE FALSE. It declared `p8bench_ro`, on which the
        --       role holds no INSERT at all, so the bare statement — no
        --       function, no twin, nothing folded — is refused with the
        --       byte-identical message, at run time and under the plan alike
        --       (measured). Its refusal was ABOUT the declared relation; the
        --       case carried a TRUE claim and its pass was honest. And the
        --       sentence that said "written VOLATILE the construction reds
        --       it" was false of that arm for the same reason: the INSERT's
        --       own ACL check refuses the plan under either volatility.
        --       Withdrawn by name. The CLASS it described is real, and round
        --       38 ships an arm that establishes it the way `R1` is
        --       established — by making the role genuinely able to do what
        --       the case says it may not:
        --
        --         `INSERT INTO @REL@ VALUES (p8bench_foldtwin())`, declared
        --         `p8bench_fold`, on which the role holds a COLUMN-scoped
        --         INSERT. The plain INSERT is ACCEPTED, so the refusal is
        --         wholly the twin's; the IMMUTABLE function is folded, so the
        --         twin is absent from the plan AND the refusal reproduces
        --         under EXPLAIN, which satisfies the construction. Written
        --         VOLATILE the construction reds it — measured both ways on
        --         THIS fixture, where the split is real.
        --
        -- Two fixes were suggested and NEITHER is what runs here, each for a
        -- measured reason.
        --
        --   * Take the row form's reach from `EXPLAIN (ANALYZE, FORMAT JSON)`
        --     in a rolled-back subtransaction, reading its `Trigger` nodes.
        --     Measured: a `Trigger` node carries `Trigger Name`, `Relation`
        --     (the relation the trigger is ON), `Time` and `Calls`. The
        --     relations the trigger's BODY read appear nowhere — the twin's
        --     name is absent from the whole plan. So it does not produce the
        --     reach set it is wanted for, and it would buy that nothing by
        --     EXECUTING the case's statement as the role that owns the
        --     helper.
        --   * Require a row case whose relation carries a trigger to spell
        --     `expect` with the relation's name and resolve it with
        --     `to_regclass`. That is round 34's error again: `X5` already
        --     spells `permission denied for table p8bench_rel` IN FULL and
        --     passes, and `to_regclass` in the case's own session answers the
        --     DECLARED relation's oid for the bare name — measured, the
        --     declared oid and never the twin's. A name cannot distinguish
        --     two objects that share it.
        --
        -- What runs instead removes the AMBIGUITY rather than chasing the
        -- mechanisms. The server's message identifies its object by kind and
        -- bare name; so this term requires that pair to identify exactly ONE
        -- object. If no other relation in this database wears the declared
        -- relation's name, then a kind-qualified grant refusal naming it IS
        -- about it — whatever reached it, trigger, folded function or anything
        -- else nobody has thought of. The question is asked of the catalogue,
        -- which is the server's, not of the case's text, and the case cannot
        -- answer it by writing a different statement.
        --
        -- It is fail-CLOSED in the one direction that matters: a case whose
        -- declared relation HAS a homonym is refused by name, and the
        -- homonyms are named in the refusal. Measured on the real
        -- 87-migration schema, no relation name is carried by two relations,
        -- so this reds no live case; the bench's own twins are declared by
        -- arms that red on the reach or arrival terms BEFORE this one, which
        -- is why this term runs LAST and leaves every existing attribution
        -- where it was.
        --
        -- DECLARED BOUNDS. Sequences and functions are included and excluded
        -- respectively, and for the same reason: the server spells the kind,
        -- `permission denied for sequence s` and `for function f`, so a
        -- function homonym is already refused by the arrival term above
        -- (`X1`), while a sequence prints a kind this form does not map and
        -- the version-independent spelling `relation` is accepted by arrival,
        -- so sequences are counted here. ROUND 38, `R28-S-1`: a TOAST
        -- relation (`relkind` 't') is spelled `table` by the server — it maps
        -- to `OBJECT_TABLE` in `get_relkind_objtype` — so it belongs in the
        -- set and is now in it. It is unreachable from a case (without a
        -- superuser's `USAGE` on `pg_toast` the refusal names the SCHEMA, and
        -- the arrival term reds that), but a set that is complete only
        -- because nothing can reach the gap is a set with a gap. `i`/`I` map
        -- to `index`, which the arrival term reds, and `c` is never
        -- ACL-checked through `pg_class`. What this term does NOT answer is
        -- whether the statement needed that relation to be reached at all —
        -- that is the reach term's question and it is still asked first.
        SELECT coalesce(string_agg(n.nspname || '.' || c.relname, ', '
                                   ORDER BY n.nspname || '.' || c.relname), '')
          INTO homonyms
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relname = relation AND c.oid <> relid
           AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S', 't');
        IF homonyms <> '' THEN
          RAISE EXCEPTION '% FAIL: THE DECLARED RELATION''S NAME DOES NOT NAME ONE OBJECT — this '
                          'case declares the % "%" (oid %) and this database also carries %. The '
                          'server''s grant refusal names a kind and a BARE name and no schema, so '
                          'its message about either of them is byte-identical, and no term of this '
                          'law can tell which one [%] % was about: a plan does not enter a '
                          'trigger, a folded IMMUTABLE function''s reads are not in the plan '
                          'either, and a column-scoped grant makes the catalogue answer FALSE for '
                          'the relation the case DID declare. Give the case a subject whose name '
                          'is its own (R27-F-1 R1/F2)',
            label, kindword, relation, relid, homonyms, sst, msg;
        END IF;
      END IF;
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

-- ROUND 34, the coordinator's 6.2, recorded here where the forms are rather
-- than in a review nobody reads beside the code. `p8.case_permits`,
-- `p8.case_permits_rows` and `p8.case_equals` call neither
-- `assert_single_statement` nor `assert_no_handler`, so they reach neither
-- scanner nor `assert_lex_session`: a permits-case goes straight to
-- `EXECUTE stmt` and reads `ROW_COUNT`. A permits-case may therefore carry
-- two statements behind a plain visible semicolon, under any lexing settings,
-- and `ROW_COUNT` is the LAST statement's. What that buys is bounded — both
-- statements run as the case role, so a PERMITTED claim stays true of the
-- role's authority, which is the whole of what a permits-case asserts — and
-- no attack past that has been built, by the coordinator's review or here. It
-- is the same observation round 31 made about `W-1`/`W-1b`. Named, not rated
-- higher, and not closed: closing it means putting the permits forms through
-- the scanner too, which changes what every permits-case is allowed to say.
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
