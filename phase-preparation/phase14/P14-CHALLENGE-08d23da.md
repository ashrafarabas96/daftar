# P14 — INDEPENDENT CHALLENGE, ROUND 2, at `08d23da`

**Challenger:** the same independent session as the round-1 report
(`P14-CHALLENGE-2026-10-12.md`), which authored no part of the Phase 14 pack.
Dispatched under PART 15 of the owner's *MAXIMUM SAFE VELOCITY* directive.
Round 1 returned **REJECT**; this round re-challenges the author's answer.

## VERDICT: **PASS-WITH-SCOPE**

All seven round-1 findings are genuinely closed, and the three new findings the
author raised against its own pack are **all real** — I reproduced each one.
What I can sign is the laws I re-executed. What I cannot sign is the **evidence
pack's reproducibility**: one recorded exit code does not reproduce from the
committed files, three recorded runs have no committed script, the P1's
settlement cites a law that says something else, and the `TL-P14-SEC-02` option
menu is neither exhaustive nor correctly priced.

`READY_TO_PROMOTE` remains **NO**, on the pack's own grounds (Phase 13 unsealed,
`TL-P14-SEC-01/02/03`, no migration number) and on P1-02 below.

### Signature scope

**SIGNED** — re-executed from the committed scripts and reproduced: `C1`, `C2`,
`C2d`, `C3` (including the fence and the restore), `C4`, `C5`, `C6`, `C7a`,
`C7c`, `C7d`, `C9` (all three arms), the eight-column outcome and its
propagation to §1, §3 and §11.1, every round-1 fix, and the manifest's 15
hashes. The three new findings are confirmed, one of them strengthened.

**NOT SIGNED** — `C8-rotation` (P1-02: does not reproduce); `C2c-redproof` and
`C3c-redproof` (P2-03: no committed script); the `TL-P14-SEC-02` option menu
(P2-05, P2-06); and, as in round 1, the `TL-P14-SEC-01/02/03` rulings
themselves, every operational value, and anything requiring repository test
suites that do not exist. A signature on a law executed against a **scratch
analogue** is not a signature that a migration applies — there is no migration.

---

## 1. Run identity and exit codes (Mission V3 §9)

| | |
|---|---|
| Subject | `08d23da4e850b7498d03eefd893283d39309c712` on `claude/project-thread-1zqgj8`, path `phase-preparation/phase14/` |
| Commit scope | **verified**: 55 files, every one under `phase-preparation/phase14/`. No file under `apps/`, `packages/`, `scripts/`, `infrastructure/`. **No frozen migration touched** — the only path matching `migration` is the patch-request document |
| Parent | `6fc505d` (`main`). **The declared base `93084f8` is not in this branch's history** — see P3-09 |
| Declared base | `93084f8`, fetched and read in a separate worktree for every citation |
| Database runtime | **PostgreSQL 16.15** @ `datcollate = datctype = en_US.utf8` — the settled target. `en_US.utf8` generated with `localedef` first; `initdb` run as an unprivileged uid; data and socket directories outside the root-only scratch path |
| Roles under test | `p14_owner`, `p14_merchant`, `p14_resolver`, `p14_worker` — read from `pg_roles`: **all four `rolsuper = false`, `rolbypassrls = false`**. The pack's claim is true |

| Run | Command | Exit |
|---|---|---|
| commit scope | `git diff --name-only 6fc505d 08d23da` | **0** (55 paths, all in-scope) |
| manifest hashes | `sha256sum` over all 15 listed artifacts | **0** — all 15 match |
| cluster | `initdb --locale=en_US.utf8` then `pg_ctl … -w start` | **0**, **0** |
| bootstrap, fixture | the pack's own `bootstrap.sql`, `fixture.sql` | **0**, **0** |
| suite, documented order | 34 committed cases on a fresh database | per §3 below |
| suite, C7 in the pack's own order | 7 cases on a fresh database | per §3 below |
| independent probes | my own `app.bypass_rls` and real-column-set scripts | **0** |

**Re-executed exit codes, against `evidence.psv`:**

| Case | psv | mine | |
|---|---|---|---|
| `C1a`, `C1b`, `C1-SETUP-*` | 0 | **0** | reproduced |
| `C1c-redproof` | 3 | **3** | reproduced |
| `C2a`, `C2b`, `C2-SETUP-*` | 0 | **0** | reproduced |
| `C2d-unsatisfiable` | 0 | **0** | reproduced |
| `C3-SETUP`, `C3-FENCE`, `C3a`, `C3b`, `C3-RESTORE` | 0 | **0** | reproduced |
| `C4`, `C5` | 0 | **0** | reproduced |
| `C6a`, `C6b`, `C6-SETUP-*` | 0 | **0** | reproduced |
| `C7a-defect` | 3 | **3** | reproduced |
| `C7a-fk-bypass`, `C7c-inoperable` | 0 | **0** | reproduced |
| `C7b-refused` | 3 | **3** | reproduced — **and 0 once option (A)'s grant exists; see P2-04** |
| `C7d-grant-cost` | 0 | **3**, then **0** | **only after an uncommitted `GRANT`; see P2-03** |
| `C9a`, `C9b`, `C9-SETUP-*` | 0 | **0** | reproduced |
| `C9c-redproof` | 3 | **3** | reproduced |
| `C2c-redproof`, `C3c-redproof` | 3 | **not runnable** | **no committed script; see P2-03** |
| `C8-rotation` | 0 | **3** | **does not reproduce; see P1-02** |

---

## 2. The round-1 findings: all seven closed, and closed well

Verified in the committed tree, not accepted on the amendment's word.

| Round 1 | State at `08d23da` |
|---|---|
| **P1-01** eight-vs-ten | **Closed.** §1 (its exclusion table), §3 (`:401-405`) and §11.1 (`:782`) all read the same eight columns. `C9a/C9b/C9c` reproduce. The outcome is right — **the justification is not; see P1-01 below** |
| **P2-02** the cashier | **Closed, generously.** `permissions.ts:214` and `:179` corrected in both the patch request and the architecture lock, and the consequence is now stated in the words it was missing: *"`sales.create` is reachable by a cashier-delegated v1 key"* (`:1287`), four of six scopes (`:1284`), and every pre-mortem line re-pointed at `:214` (`:1296`) |
| **P2-03** §12's triggers | **Closed.** §12 now carries `webhook_delivery_source_business` (`:1216`) and `webhook_delivery_link_immutable` (`:1217`), and states the payload freeze with **exactly one permitted transition** (`:1215`) |
| **P2-04** the `5 minutes` | **Closed.** `OD-P14-11`, no default, fail-closed startup; the manifest sentence corrected — **though incompletely; see P2-07** |
| **P3-05** the global FK | **Closed.** Disclosed in §3 with its three siblings and raised as `TL-P14-SEC-03` (`:359`) rather than decided |
| **P3-06** the RESTRICTIVE `USING` | **Closed.** `FOR SELECT`, not `FOR ALL` (`:381`, `:389`) |
| **P3-07** the manifest row | **Closed.** 39 laws (`:56`) |

The amendment also re-measured each round-1 claim before editing, and corrected
my own imprecision in passing (`isSensitivePermission()` is at `:146`, not
`:149`). That is the right order of work and it is worth saying so.

## 3. The three new findings: all three real

### Finding 1 — §11.1's merchant `INSERT` set is unsatisfiable — **CONFIRMED and stronger than measured**

`C2d` reproduces (exit 0). I then re-ran it against **§3's real column set**
rather than the fixture analogue, with §11.1's own stated grant
(*"column-scoped to the fields a merchant genuinely supplies — `name`"*):

```
INSERT INTO real_api_keys (name) VALUES ('…');
→ ERROR: null value in column "business_id" … violates not-null constraint   (23502)
INSERT INTO real_api_keys (name, business_id) VALUES (…);
→ ERROR: permission denied for table real_api_keys                            (42501)
```

Both branches closed on the **real** schema, which carries **six** NOT NULL
columns outside the merchant's set (`business_id`, `tenant_id`, `key_id`,
`secret_sha256`, `subject_user_id`, `created_by_user_id`) where the fixture
analogue carries fewer. The finding holds *a fortiori*. *"A grant matrix must be
satisfiable as well as safe"* is a real law and nothing in the pack asserted it
before it was run. **One caveat for whoever closes it, in P3-08.**

### Finding 2 — §7a's assertion is inoperable under invoker rights — **CONFIRMED**

Run in the pack's own order, `C7c` exits 0: the non-`SECURITY DEFINER` trigger
cannot read the parent, so it refuses the **same-business** write too with
`42501`. It fails closed and is unusable. `C7d` then shows it working once the
read is granted — cross-business `23514`, same-business accepted, `NULL`-business
refused — and the cost is real. I verified the cost's premise at the declared
base rather than taking it: `0006_rls.sql:59-61` is
`CREATE POLICY outbox_scope ON outbox_events USING (…)` with **no `AS
RESTRICTIVE`**, so `outbox_events` genuinely carries no restrictive policy.
**But the pricing of the options is wrong in two ways — P2-05 and P2-06.**

### Finding 3 — `app.bypass_rls` relaxes only the RESTRICTIVE half — **CONFIRMED independently**

Verified outside the pack's harness, on the same cluster:

```
SET app.bypass_rls = 'on';                      → 0 rows
SET app.tenant_id = …; SET app.business_id = …;  → 5 rows
```

with `tenant_membership` (PERMISSIVE), `worker_delivery` (PERMISSIVE) and
`business_isolation` (RESTRICTIVE) in force. Bypass alone is not a god-mode read
on this idiom: a caller still needs a PERMISSIVE policy to admit it.

**And §4's write-up of how this surfaced is the best reasoning in the pack.** A
*failing fence* revealed that `C3a`'s 0-row assertion had first passed against an
**empty table** — an unfenced ABSENT result settles nothing, and a case that
cannot tell "refused" from "nothing there" passes for the wrong reason. Keeping
the two wrong runs rather than deleting them is the right discipline. **P1-02 is
that same lesson in its positive form, and the pack did not apply it there.**

---

## 4. Findings against `08d23da`

### P1-01 — the P1's settlement is justified by a law that says something else, and the restatement contradicts §11.1

**Eight is the right answer.** The round-1 report said so — §3's minimal-reach
argument was the better one — and §1, §3 and §11.1 now agree. What is wrong is
the reasoning carried into three documents as the justification.

Amendment 06 §2, `P14-EVIDENCE-2026-10-12.md:190` and the patch request's own
exclusion table at `:114` all state:

> *"`P14-AL-11` states that `revoke_scheduled` is a write-time assertion of
> intent that no reader may consult … A resolver that selects it is a reader of
> it."*

**`P14-AL-11` is `IDEMPOTENCY FOLLOWS THE REPOSITORY'S CONVENTION`**
(`P14-S0-ARCHITECTURE-LOCK.md:268`). It is about client-chosen resource ids,
`201`/`200`/conflict, and the absence of an `Idempotency-Key` header. **It
contains no sentence about `revoke_scheduled`.** The pack cites it *correctly*
for idempotency in two other places — `P14-CONTRACT-PACK.md:133` and
`P14-AMENDMENT-02:53` — so this is a misattribution in the three new citations,
not a renumbering.

Two consequences, and the second is the serious one:

1. **There is no numbered law for the rule at all.** The `revoke_scheduled` read
   rule exists as unnumbered prose (`P14-S0:563`, and the §3 "four readers"
   table). So the resolution of the pack's P1 rests on an unnumbered sentence,
   and the restated `P14-GATE-033` — which now finds grant statements by
   **scanning**, a good fix — will never check a derivation justified by prose.

2. **The restatement, taken at its word, invalidates a grant two sections
   later.** If "a reader that selects it is a reader of it" and such reading is
   forbidden, then §11.1's `daftar_app` row — `SELECT` on *"all columns except
   `secret_sha256`"*, which includes `revoke_scheduled`, plus **`UPDATE` on
   `revoke_scheduled`** (`:781`) — is a violation of the rule the same table
   relies on. And §3's four-readers table *requires* the listing surface to
   display it. The actual rule is narrower and survives both: **no reader may
   consult it *to decide usability*.** The resolver would; the listing surface
   would not. The reformulation erased exactly that qualifier.

**Required:** state the real rule, give it a number, and justify the exclusion on
the ground that already carries `name` — minimal reach for the one principal
that reads every key digest in every business. That argument needs no `AL-11`,
covers `revoke_scheduled` identically, and does not contradict §11.1.

### P1-02 — `C8-rotation`'s recorded exit 0 does not reproduce, and the constraint it tests exists nowhere in the pack

`evidence.psv` records `C8-rotation|p14_owner|…|0`, and the evidence document
§3 states:

> *"The composite rotation link refuses a cross-business predecessor with
> `23503`, and a `NULL` link is accepted."*

**Executed, twice — standalone and in the full documented order on a fresh
database — the committed `c8_rotation.sql` against the committed `fixture.sql`
exits 3:**

```
NOTICE: INSTANT 1 (T-1d):  old key usable = t
NOTICE: INSTANT 2 (T-1us): old key usable = t
NOTICE: INSTANT 3 (T exactly): old key usable = f — revoked at its own instant
NOTICE: INSTANT 4 (T+1d):  usable = f, revoke_scheduled still = true
NOTICE: ROTATION: the replacement is usable across all four instants
ERROR:  LAW VIOLATED: business 2 rotated business 1 key
```

The four-instant arms pass. The last arm fails because **the composite FK does
not exist**. `fixture.sql` declares `replaces_api_key_id UUID` with no
constraint, and a search for every foreign key in the pack —

```
grep -n "FOREIGN KEY\|REFERENCES" proofs/cases/*.sql proofs/fixture.sql
→ c7_setup.sql:16:  FOREIGN KEY (outbox_event_id) REFERENCES p14s.outbox_events(id)
```

— returns **exactly one**, a single-column global FK on a different table. No
script in the pack creates `FOREIGN KEY (business_id, replaces_api_key_id)`.
The case expects `foreign_key_violation` from a constraint that is never built.

So one of the following is true, and each is the same defect: the committed
script is not the one that produced exit 0; a precondition was applied in the
author's session and not committed; or the recorded 0 came from a different
state. **A recorded exit code that cannot be regenerated from the committed
files is not evidence**, and this pack's own standard is *"the exit code IS the
verdict"*.

**And the case lacks the protection its own setups carry.** `c1_grant_narrow`,
`c9_setup_eight`, `c7_setup` and `c7_fix` each end with a proof-of-proof that the
mutation landed — `pg_get_constraintdef`, `prosecdef`, a column-grant read.
`c8_rotation` asserts a refusal **without first proving the constraint that must
produce it exists**. That is §4's own lesson in the other direction: an
unfenced **PRESENT** result settles nothing either, and a case that cannot tell
"refused by the right constraint" from "no constraint at all" will pass or fail
on run order.

**Required:** create the composite FK in a committed setup script with a
`pg_get_constraintdef` proof-of-proof, re-run `C8`, and append the real exit
code. If it then passes, the law is proven and the claim stands; the claim
cannot stand on the current evidence either way.

### P2-03 — three recorded runs have no committed script

The README's recipe is `./run.sh <case-id> <role> cases/<case>.sql`. For three
recorded runs that cannot be followed:

- **`C2c-redproof` (3)** — there is no `c2c_*.sql`. The narrative says *"re-widening
  the grant turns the refusal arm red"*, so it was presumably `c2b` re-run after
  `c2_grant_table_insert`; neither the composition nor the mutation order is
  recorded anywhere.
- **`C3c-redproof` (3)** — there is no `c3c_*.sql`. Same shape: *"re-adding the
  disjunct turns the 0-row arm red"*.
- **`C7d-grant-cost` (0)** — requires `GRANT SELECT ON p14s.outbox_events TO
  p14_merchant`, which **no script in the pack performs**. Executed: `C7d` exits
  **3** without it and **0** once I granted it by hand.

**Two of the four red proofs are therefore unreproducible**, and the red proof is
the single thing that distinguishes a real gate from a decorative one — the
pack's own README says so. A fourth, smaller instance: `evidence.psv` records
case **ids** (`C1a-refused`) while `cases/` holds different **filenames**
(`c1a_restrict_column_refused.sql`), with no mapping in any document, so even the
reproducible rows must be matched to their scripts by guesswork.

**Required:** commit a script per recorded case id, including the mutation steps
and `C7d`'s grant, and record the id → script mapping. A `run.sh` that took the
script path as the case id would close this class permanently.

### P2-04 — the evidence document's accounting of its own failures is incomplete, and it understates a result it already has

§4 is titled **"The two runs that were wrong"** and explains `C3-SETUP` and
`C3-FENCE`. `evidence.psv` carries **four** non-red-proof exit-3 runs: those
two, plus **`C7a-defect` (3)** and **`C7b-refused` (3)**, which §2 labels a bare
*"failed"* and §4 never mentions — and they are the two that touch the open
ruling.

`C7b` is *"the delivery cannot name another business's source event"* — the law
§7a exists to enforce and §14 requires. **It has no green run anywhere in the
pack.** It has one in reality: executed, `C7b` exits **3** before option (A)'s
grant and **0** after it. So the pack records a failure for a law it can prove
under the very option it costed, and a reader of §2 alone concludes the
source-outbox binding was never demonstrated to work.

**Required:** §4 covers every exit-3 run including `C7a-defect` and `C7b`, §2's
*"failed"* rows cross-reference the finding they became, and `C7b`'s passing run
under option (A) is recorded — it is the strongest single piece of evidence for
`TL-P14-SEC-02` and it is currently missing.

### P2-05 — the four `TL-P14-SEC-02` options are **not** exhaustive, and (C) is mispriced

The author asked this question directly. The answer is no.

**(C) is not "not available".** The table reads *"the correct fix, and it is
**not available**"*. What is forbidden is altering **frozen `0004`**. A
`UNIQUE (business_id, id)` added to `outbox_events` by an **appended** migration
alters no frozen file — and §7a's own earlier paragraph says exactly this: *"or
appending one to a table this phase does not own."* So (C) is not unavailable;
it is **not Phase 14's to write**, which is a different ruling and precisely the
one the Migration and Outbox Owners are being asked for. Collapsing "I may not"
into "it cannot be done" removes the correct fix from the menu. (The mechanics
work: the child's `business_id` is NOT NULL, so under MATCH SIMPLE the composite
FK is always checked and a `NULL`-business parent can never be named — the
refusal §7a wants.)

**A fifth option is missing.** Phase 14 may create a relation **it owns** keyed
`(business_id, outbox_event_id)`, populated at fan-out where the business is
already known and policed by this phase's own RLS, and give
`webhook_deliveries` a **composite** FK to *that*. This keeps the composite key
with no frozen change, no `SECURITY DEFINER` exemption and no global read grant
for the writing role; the residual risk moves to one insert inside the phase's
own policies. Whether it is the right design is the owners' call — but it
belongs on a menu presented as complete.

### P2-06 — option (A)'s cost is conditional on `TL-P14-SEC-01`, and the pack prices it as unconditional

Verified at the declared base, `0010_db_roles.sql:36-38`:

```
CREATE POLICY outbox_worker ON outbox_events
  USING (current_user = 'daftar_worker')
  WITH CHECK (current_user = 'daftar_worker');
GRANT SELECT, UPDATE ON outbox_events TO daftar_worker;
```

**PERMISSIVE, with no business predicate, plus an existing table-wide `SELECT`.**
So if the Security Owner names `daftar_worker` as the delivery principal — one of
the two candidates `TL-P14-SEC-01` puts to them — option (A) **costs nothing
new**: that role already reads every business's outbox rows and the §7a
assertion is already operable for it. If a dedicated `daftar_webhook_internal`
is chosen instead, (A) requires a new global grant and the measured cost applies.

**The two rulings are therefore coupled, and the pack presents them as
independent.** `TL-P14-SEC-02`'s option table cannot be priced until
`TL-P14-SEC-01` names the principal — and conversely, the fact that one
candidate already holds the global read is an argument *against* that candidate
that `TL-P14-SEC-01` should carry. §11a already notes `daftar_worker` *"already
reaches credential deliveries and invitations"*; this is a third, sharper
instance of the same blast-radius argument and it is measurable rather than
rhetorical.

### P2-07 — the manifest says nothing has been executed, in the pack that carries 45 runs

`P14-HANDOFF-MANIFEST.md:60` describes the evidence document as *"**EXECUTED
evidence**, the first in this phase's history: 45 runs with run IDs and exit
codes"*. Twenty-nine lines later, §5 *"Tests and evidence"* opens:

> **None. Every gate is `UNMEASURED`** (PART 15) … **nothing has been executed,
> so nothing is claimed.**

**That paragraph was edited in this very round** to correct the timing sentence —
and the clause beside it was left standing. A reader of §5 alone concludes
Phase 14 has no executed evidence.

To be fair to the distinction: *"every gate is `UNMEASURED`"* is still **true** —
the gates are `P14-TASK-DAG.md` tasks 002/007/013/023/025 and `GATE-032/033/034`,
and none has been measured. What was executed is **law proofs**, not gates. The
defensible sentence is *"no gate has been measured; 45 law proofs have been
executed, in `P14-EVIDENCE-2026-10-12.md`."* The sentence as written is false,
and it is the fifth consecutive appearance of this pack's defining species: a
correction landing in one place and not in the sentence next to it.

### P3-08 — three case-script comments misname what the script does

In a pack whose standard is *"the exit code IS the verdict"*, a comment that
misnames the mutation makes the verdict unauditable without re-running it.

- `c1c_red_proof.sql` — *"withdraw ONLY the lookup column"*; it revokes
  `secret_sha256`, which is not the lookup column (`key_id` is).
- `c2d_matrix_unsatisfiable.sql` — *"`secret_sha256` is NOT NULL and is not in
  the merchant's INSERT set"*; the evidence document honestly records that
  `subject_user_id` fired first. The script catches `not_null_violation`
  generically, so it passes on whichever fires — correct, and the comment is not.
- `c2_scope_insert.sql` — grants the merchant
  `INSERT (tenant_id, business_id, name, expires_at)`, four columns, while
  §11.1 states the scoped set is **`name`**. The `C2d` finding holds under both
  (I proved the one-column form in §3 above), but **whoever closes `C2d` needs to
  know which set §11.1 means**, and the document and the artefact disagree.

No exit code is affected by any of the three.

### P3-09 — the branch's tree is behind the base the pack declares

`08d23da`'s parent is `6fc505d` (`main`), and `git merge-base 08d23da 93084f8` is
`6fc505d` — so **the declared base `93084f8` is not an ancestor of this commit**.
The checked-out tree is therefore 205 lines of `apps/api/src/infra/database.ts`
behind the base every citation is measured against. The round-1 manifest warned
about exactly this trap and the warning survives in the committed manifest, so
this is disclosed rather than hidden, and no citation I checked was wrong because
of it — every one I verified, I verified in a `93084f8` worktree and it held.
Recorded because a future reader who verifies a citation **against the branch
they checked out** will get a different file, and because committing a
preparation pack onto a branch cut from `main` rather than from its own declared
base is avoidable.

---

## 5. What held, and should not be reopened

- Commit hygiene: 55 files, no app code, no frozen migration, no number.
- The manifest's 15 hashes: **all match**.
- The roles: **all four non-superuser, non-bypassrls**, read from `pg_roles`.
  The pack's central methodological claim is true.
- Every law I could run from the committed scripts reproduced its recorded exit
  code, red proofs included, except `C8`.
- The eight-column **outcome** and its propagation to all three sections.
- All seven round-1 fixes.
- All three of the author's new findings, one strengthened.
- `C3`/§4's reasoning about the failing fence and the empty-table pass. This is
  the pack's best work and the standard the rest of it should be held to.

## 6. Required before this challenger would sign without scope

1. **P1-02** — a committed setup script creating the composite FK with a
   proof-of-proof, `C8` re-run, the real exit code appended. **This is the one
   item that keeps the verdict from being a plain PASS.**
2. **P2-03** — a committed script per recorded case id, `C7d`'s grant included,
   and an id → script mapping.
3. **P1-01** — the real rule stated, numbered, and the `AL-11` citation
   withdrawn from the three places that misattribute it.
4. **P2-04** — §4 covers all four exit-3 runs; `C7b`'s passing run under option
   (A) recorded.
5. **P2-05, P2-06** — (C) re-priced as an ownership question, the owned-projection
   option added, and the coupling of `TL-P14-SEC-01` to `TL-P14-SEC-02`'s pricing
   stated.
6. **P2-07, P3-08, P3-09** — the manifest §5 sentence, the three script comments,
   and the branch's base.

None of these needs the owner. `TL-P14-SEC-01`, `TL-P14-SEC-02`,
`TL-P14-SEC-03`, the migration number and the operational values remain
blocking for their own reasons, independently of this verdict.

---

*Independent challenge, round 2, 2026-10-12. Subject `08d23da`, declared base
`93084f8`. 34 committed cases plus independent probes re-executed on PostgreSQL
16.15 @ `en_US.utf8`, all roles non-superuser and non-bypassrls; exit codes in
§1. No file of the Phase 14 pack was edited and nothing was pushed to the
author's branch. Evidence classes: `RE-EXECUTED` for §1 and §3, `PROVEN IN LIVE
CODE` at `93084f8` for §4's citations, `VERIFIED` for the manifest and commit
scope, `DESIGN REVIEW` for P2-05 and P2-06. No timing or performance claim is
made from this container.*
