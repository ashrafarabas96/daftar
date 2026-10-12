# P14 — INDEPENDENT CHALLENGE, ROUND 3, at `6f744c1`

**Challenger:** the same independent session as rounds 1 and 2, which authored no
part of the Phase 14 pack. Round 1 **REJECT** (7 findings), round 2
**PASS-WITH-SCOPE** (P1-02 and six others). This round re-challenges
`6f744c16ac5741b23fe8bdcd607e29b2778d0307`.

## VERDICT: **PASS-WITH-SCOPE**

Narrower than round 2, and for a different reason. **Every round-2 item is
closed, and closed by construction rather than by explanation.** `C8` reproduces.
All four previously unscripted mutations are committed scripts with catalogue
proof-of-proof. The evidence is one clean replay. **With the harness driven as it
is designed to be driven, all 43 recorded exit codes reproduce exactly** — 39
zeros and the four red proofs at 3.

What keeps it from a plain PASS is two mechanical defects, neither of them in the
design or in a law:

1. **The committed replay recipe cannot produce the committed evidence** (P2-01).
   Executed verbatim, it exits **127** on all four red-proof lines and cannot
   record their aliases — so `evidence.psv` as committed was produced by a
   wrapper that is not in the pack. That is round 2's P1-02 species, inside the
   harness built to close it.
2. **One real order dependency** (P2-02), which is what the author asked me to
   hunt: the **entire `C7` family** — all of `TL-P14-SEC-02`'s evidence — fails
   in isolation because `c7_setup.sql` alters a table that `c3_setup.sql`
   creates.

`READY_TO_PROMOTE` remains **NO** on the pack's own grounds: Phase 13 unsealed,
`TL-P14-SEC-01`/`-02`/`-03` open, no migration number.

### Signature scope

**SIGNED** — every law in the pack. I re-executed all 43 runs in `ORDER` on a
freshly created database and each matched its recorded exit code; I then ran each
of the nine case families in isolation; and I ran independent probes outside the
pack's harness. `C8-rotation`, which I could not sign in round 2, is signed.

**NOT SIGNED** — the committed reproduction recipe (P2-01); `C7`'s
self-sufficiency (P2-02); the `TL-P14-SEC-01`/`-02`/`-03` rulings, which are the
owners' and which this challenge does not pre-empt; §11.1a's unenumerated
`INSERT` set, correctly routed and therefore not mine to settle; every
operational value. As in both earlier rounds: a law proven against a scratch
analogue is not a proven migration — there is no migration.

---

## 0. A correction to my own round-2 report

The author is right and I was wrong.

Round 2's P1-01 said: *"There is **no numbered law** for the rule at all — only
unnumbered prose (`P14-S0:563`)."* That sub-claim is false. `P14-S0:563` is a
line inside the body of **`P14-AL-29` — AN AUTHORIZATION PREDICATE NAMES ONLY
COLUMNS THAT EXIST** (`:558-568` at `08d23da`), which states: *"a boolean of
intent (`revoke_scheduled`) is written at write time and **never read to decide
usability**."* The rule is numbered, and it carries the exact qualifier I had
identified as the one the author's reformulation dropped. I read a law's body as
loose prose because I had searched for the column name rather than reading the
law that governs the predicate — the same error in kind as the one I was
reporting.

**The two load-bearing parts of P1-01 stand**, and the author accepts both: the
citation to `P14-AL-11` was a misattribution in three places (that law is
idempotency), and the broadened reformulation *"a resolver that selects it is a
reader of it"* contradicted §11.1's own grant of `SELECT`/`UPDATE` on that column
to `daftar_app`.

**And the resolution now in §1 is better than the one I proposed.** I offered
minimal reach as a fallback ground. The pack's new text does something sharper:
the exclusion follows from `P14-AL-29` **for the resolver specifically**, because
the resolver's only purpose in reading the row *is* to decide usability, so for
that principal selecting and consulting are the same act — while `daftar_app` is
a reader *and a permitted one*, which is why the same law does not touch its
grant. That is the correct resolution of the tension I raised, and it keeps
minimal reach as an independent ground rather than the only one.

---

## 1. Run identity and exit codes (Mission V3 §9)

| | |
|---|---|
| Subject | `6f744c16ac5741b23fe8bdcd607e29b2778d0307`, branch `claude/project-thread-1zqgj8`, path `phase-preparation/phase14/` |
| Commit scope | **verified**: 63 files, all under `phase-preparation/phase14/`; nothing under `apps/`, `packages/`, `scripts/`, `infrastructure/`; no frozen migration. The delta from `08d23da` is 18 paths, all in-pack |
| My round-2 report | committed **unedited**: `ae87a5cac2d6d1bbd65a00d0fa0d660227ee3373e13095966d08140a5ff524b2`, the digest I claimed |
| Manifest | **17 rows, every SHA256 recomputed and matching** |
| Ancestry | `93084f8` is still **not** an ancestor (`6f744c1` → `08d23da` → `6fc505d`). Now disclosed in the run-identity table, per round-2 P3-09 |
| Runtime | **PostgreSQL 16.15** @ `datcollate = datctype = en_US.utf8`, `en_US.utf8` generated with `localedef`; `initdb` as an unprivileged uid; data and socket directories outside the root-only path |
| Roles | the pack's own `bootstrap.sql`; all four under test `NOSUPERUSER`, `NOBYPASSRLS` |

| Run | Command | Result |
|---|---|---|
| scope | `git diff --name-only 6fc505d 6f744c1` | 63 paths, all in-pack |
| manifest | `sha256sum` over 17 listed artifacts | **all match** |
| cluster, bootstrap, fixture | the pack's own recipe | **0**, **0**, **0** |
| **recipe, verbatim** | `while read role script; do ./run.sh "$role" "$script"; done < ORDER` | **39 × 0, 4 × 127** — see P2-01 |
| **replay, as designed** | same loop, splitting `\|REDPROOF\|` and exporting `P14_CASE_ALIAS` | **39 × 0, 4 × 3 — every recorded code reproduced** |
| **isolation** | each of 9 families on a fresh database + `fixture.sql` | 8 clean, **`C7` 6 × 3** — see P2-02 |
| independent probe | `NOT NULL` / `CHECK` deferrability in PG 16 | **0** — see P3-04 |

**Diff of my replay against the committed `evidence.psv`, by script and exit
code: four differences, all four the red-proof lines, all `127` against the
recorded `3`. The other 39 rows are identical.** Driven as designed, the
difference is zero.

## 2. Every round-2 item: closed

| Round 2 | State at `6f744c1` |
|---|---|
| **P1-02** `C8` unreproducible | **Closed by construction.** `c8_setup_fk.sql` creates the composite FK and aborts unless `pg_get_constraintdef` returns a definition naming `business_id`. Executed: `c8_setup_fk` **0**, `c8_rotation` **0**, and `C8` also passes with its family in isolation. The law now has executed support |
| **P2-03** three unscripted runs | **Closed, and better than I asked.** `c2c_rewiden_insert.sql`, `c3c_readd_disjunct.sql`, `c7d_setup_grant.sql`, each with a catalogue proof-of-proof. `run.sh` derives the case id from the script path **and** `evidence.psv` carries the script as column 1 with the recorded id as column 3, so a red proof is visibly its green twin re-run. I suggested keying on the path; carrying both is the stronger design — **though see P2-01 and P3-03** |
| **P2-04** incomplete failure accounting | **Gone by construction.** One uninterrupted replay; the only non-zero exits are the four red proofs. There are no unexplained exit-3 runs left to account for. And `c7b_refused_after_grant` exits **0** — §7a's central law has a passing run for the first time, which was the substantive half of this item |
| **P2-05** options not exhaustive, (C) mispriced | **Closed.** Five options. (C) reads *"NOT unavailable — it is not Phase 14's to write"* with the `:602` citation and my `MATCH SIMPLE` point recorded. (E) added, **with a cost I had not stated**: a fan-out write whose own correctness must then be proved, since the binding is only as good as the moment it is recorded. That is a fair charge against my own proposal |
| **P2-06** (A) mispriced, rulings coupled | **Closed.** (A)'s cell now leads with *"depends entirely on which principal `TL-P14-SEC-01` names, and the two rulings are therefore COUPLED"*, the base citation verified by the author independently, and the cut-both-ways point put to the owners: that `daftar_worker` already holds a global read is an argument **against** naming it |
| **P2-07** manifest §5 | **Adopted verbatim**: *no gate has been measured; 43 law proofs have been executed* |
| **P3-08** script comments | **Closed, and it exposed a real gap** — §11.1a. See P3-04 |
| **P3-09** ancestry | **Closed**: stated in the run-identity table |

---

## 3. Findings against `6f744c1`

### P2-01 — the committed recipe cannot produce the committed evidence

This is the author's own question 1 — *"the replay is the thing to attack"* — and
it is the harness rather than `ORDER` that gives way.

`README.md:23` is the documented replay:

```
while read role script; do ./run.sh "$role" "$script"; done < ORDER
```

`ORDER` lines 6, 13, 22 and 43 carry a **third** field:

```
p14_resolver cases/c1b_lookup_succeeds.sql|REDPROOF|c1c_redproof_expect_3
```

**Executed, verbatim, on a clean cluster:**

```
c1_grant_narrow                     role=p14_owner     exit=0
… 38 more rows at their recorded exit codes …
c1b_lookup_succeeds.sql|REDPROOF|c1c_redproof_expect_3  role=p14_resolver  exit=127
      bash: line 1: REDPROOF: command not found
      bash: line 1: c1c_redproof_expect_3: command not found
      psql:cases/c1b_lookup_succeeds.sql:13: ERROR: permission denied for table api_keys
```

and the same on lines 13, 22 and 43. Two independent mechanical causes:

- `read role script` does not split the third field, so `$script` is the whole
  pipe-joined string and `run.sh`'s `basename` records the case id as
  `c1b_lookup_succeeds.sql|REDPROOF|c1c_redproof_expect_3`;
- `run.sh` interpolates `$FILE` **unquoted** into `su claude -s /bin/bash -c
  "… -f $FILE"`, so the `|` is read as a shell pipe — hence `127` and
  `REDPROOF: command not found`, rather than the `3` a failed assertion gives.

And the alias reaches `evidence.psv` only through `${P14_CASE_ALIAS:-$CASE}`, an
environment variable **neither `ORDER` nor the documented loop ever sets**.

The committed `evidence.psv` nonetheless carries exit `3` on those four rows and
the aliases in column 3. **Therefore the committed evidence was produced by a
wrapper that splits `|REDPROOF|` and exports `P14_CASE_ALIAS`, and that wrapper
is not in the pack.** It is the same species as round 2's P1-02 — a step the
evidence depends on living outside the committed files — now in the component
built specifically to close P1-02. The author's own diagnosis of P1-02 applies
unchanged: *created with an ad-hoc command and never noticed to be outside every
script.*

**What this does not impugn.** The science is sound and I can sign it. Supplying
the wrapper the design implies, the full replay reproduces **all 43** recorded
exit codes exactly, and the verbatim run's own `psql` output shows each red proof
genuinely turning red for the right reason — `LAW VIOLATED: the forging INSERT
still succeeded`, `LAW VIOLATED: the PERMISSIVE policy admitted 2 row(s) past the
RESTRICTIVE one`, and `permission denied` on the two grant arms. Nothing is
misreported except the exit code and the id.

**Required:** commit the wrapper, or — better, and in this round's own spirit of
closing by construction — change `ORDER` to a form `run.sh` parses natively (a
third whitespace field, with `run.sh` taking an optional alias argument) and
quote `"$FILE"` inside the `bash -c` string. Then the documented one-liner is
the thing that produced the evidence, which is what the round was for.

### P2-02 — the one real order dependency: the whole `C7` family needs `C3`'s setup

The author's question 1 again: *"if `ORDER` has an implicit dependency I haven't
noticed — a case that only passes because an earlier one left state behind."*
There is exactly one, and it is in the worst possible family.

**Method:** nine runs, each on a freshly created database with `bootstrap.sql`
and `fixture.sql` only, executing just that family's lines from `ORDER`.

| Family | In isolation |
|---|---|
| `C1`, `C2`, `C3`, `C4`, `C5`, `C6`, `C8`, `C9` | every case at its expected code |
| **`C7`** | **six cases exit 3** — `c7_setup`, `c7a_fk_bypasses_privilege`, `c7_fix`, `c7c_assertion_inoperable`, `c7d_grant_cost`, `c7b_refused_after_grant` |

The cause, first line of the first failure:

```
psql:cases/c7_setup.sql:16: ERROR:  relation "p14s.webhook_deliveries" does not exist
```

`c7_setup.sql` opens by **altering** `p14s.webhook_deliveries`
(`ADD COLUMN outbox_event_id`, `ADD CONSTRAINT … FOREIGN KEY`). That table is
created at `c3_setup.sql:9` — **a different family's setup**. `ORDER` places
`C3` at line 15 and `C7` at line 30, so the full replay is correct; nothing in
`ORDER`, the README or `c7_setup.sql` records that `C7` requires `C3`.

**And `c7_setup.sql`'s proof-of-proof does not catch it.** It reads
`pg_get_constraintdef` for the FK it adds — a good check of its own mutation —
while never asserting that the table it alters exists with the columns `C7`
needs. A proof-of-proof that validates what a script *writes* but not what it
*assumes* is half the guard, and the README's claim that *"every mutation a case
depends on is performed by a committed script"* is literally true here while
still leaving this gap: the mutation is committed, it is just in another family.

**Why this family and not another matters.** `C7` carries the **entire** evidence
base for `TL-P14-SEC-02`: the FK-bypasses-privilege finding, the
inoperable-assertion finding, the measured grant cost, and
`c7b_refused_after_grant` — the law that had no passing run anywhere in the pack
until this round. The three owners ruling on `TL-P14-SEC-02` are the readers most
likely to re-run one family rather than all nine, and they would get six
failures and no finding.

**Required:** `c7_setup.sql` creates `webhook_deliveries` when absent and ends
with a catalogue proof-of-proof that it exists with the columns `C7` uses —
closing it by construction, as `c8_setup_fk.sql` now does. Declaring the
dependency in `ORDER` is the weaker fix; it leaves the failure mode intact for
anyone who runs a family.

### P3-03 — the README documents six evidence columns; `run.sh` writes seven

`README.md:40`: *"`evidence.psv` is `case|role|run_id|start_utc|end_utc|exit_code`"*
— six fields. `run.sh` writes **seven**
(`case|role|alias|run_id|start|end|exit`), and the committed file has seven; the
`run.sh` comment correctly says *"column 3 is the recorded case id"*.

The column added **this round**, to make every row name its own script, is
missing from the one line that describes the format. It is a small instance of
the species that has run through all three rounds, and it is in the
reproducibility artefact that this round existed to repair — a reader parsing by
the documented schema reads the alias as the run id.

### P3-04 — §11.1a is a referral, not a dodge; but option (ii) is not implementable, and it is offered as though it were

The author asks directly whether routing the unenumerated `INSERT` set to
`TL-P14-SEC-01` is a dodge.

**It is a referral, and the right call.** §11.1 declares itself authoritative and
genuinely does not state that set; the two candidates are materially different
*security* designs, not phrasings; and what separates them — whether a distinct
minting principal holds the plaintext — is exactly `TL-P14-SEC-01`'s question.
Recording the gap as *"NOT ENUMERATED — this is a gap and not a scoping"* with
both candidates, rather than inventing a set, is the honest move, and it matches
how `SEC-02` and `SEC-03` are handled. Inventing the set would have been the
dodge.

**One correction to the referral.** Candidate (ii) — *"`daftar_app` holds a
column-scoped `INSERT` and a second write supplies the digest, so the row exists
briefly without its digest"* — **cannot be implemented under §3's schema.**
`secret_sha256` is `NOT NULL`, so the first statement is refused `23502`, which
is precisely what `C2d` executes. I then checked whether a deferral route exists
and **predicted one; the cluster refuted me:**

```
CREATE TABLE … (b text NOT NULL DEFERRABLE INITIALLY DEFERRED);
→ ERROR: misplaced DEFERRABLE clause
CREATE TABLE … (CONSTRAINT b_nn CHECK (b IS NOT NULL) DEFERRABLE INITIALLY DEFERRED);
→ ERROR: CHECK constraints cannot be marked DEFERRABLE
```

In PostgreSQL 16 **neither** a `NOT NULL` nor a `CHECK` may be deferred — I had
expected the `CHECK` form to work and it does not. So (ii) has no route at all
short of dropping `secret_sha256 NOT NULL`.

The ruling the owners actually face is therefore narrower than two co-equal
options: **(i), or an explicit schema change to make (ii) possible.** §11.1a
should say so, because an option that cannot be built is not a choice, and the
pack's own `C2d` already proved it.

---

## 4. What held, and should not be reopened

- Commit scope: 63 files, all in-pack, no app code, no frozen migration, no
  number. My round-2 report committed unedited at the digest I claimed.
- All 17 manifest hashes.
- All four roles `NOSUPERUSER`/`NOBYPASSRLS`, read from the pack's own bootstrap.
- **All 43 recorded exit codes**, reproduced on a freshly created database when
  the harness is driven as designed — `C8` among them, which round 2 could not
  sign.
- Eight of nine case families are self-contained in isolation.
- The `P14-AL-29` re-grounding, with the *"to decide usability"* qualifier
  restored and the principal-specific reasoning that resolves it correctly.
- All five `TL-P14-SEC-02` options, (C)'s re-pricing, (E) with its fair
  counter-cost, and the stated coupling to `TL-P14-SEC-01`.
- §11.1a as a referral.

Across three rounds, **no finding has ever landed against this pack's
architecture.** Every law I have executed has held, and every defect — mine in
round 1 and 2, the author's three, and these two — has been in a document, a
citation, or the harness. That is worth recording as the shape of the risk here:
the designs have been right and the *account* of them has been where the errors
live.

## 5. Required for a plain PASS

Two items, both mechanical, neither touching a law:

1. **P2-01** — commit the wrapper, or make `ORDER` parse natively and quote
   `"$FILE"`, so the documented one-liner produces the committed evidence.
2. **P2-02** — `c7_setup.sql` creates `webhook_deliveries` when absent, with a
   catalogue proof-of-proof of its own precondition.

And two smaller: **P3-03** the README's column list, **P3-04** §11.1a's option
(ii) marked as needing a schema change.

None needs the owner. `TL-P14-SEC-01`, `-02`, `-03`, the migration number and the
operational values remain blocking for their own reasons, independently of this
verdict.

---

*Independent challenge, round 3, 2026-10-12. Subject `6f744c1`, declared base
`93084f8`. All 43 committed cases replayed in `ORDER`, each of 9 families run in
isolation, plus independent probes, on PostgreSQL 16.15 @ `en_US.utf8` with all
roles non-superuser and non-bypassrls; results in §1. No file of the Phase 14
pack was edited and nothing was pushed to the author's branch. Evidence classes:
`RE-EXECUTED` for §1–§3, `VERIFIED` for the manifest and commit scope,
`DESIGN REVIEW` for P3-04's judgement. One correction to my own round-2 report is
in §0. No timing or performance claim is made from this container.*
