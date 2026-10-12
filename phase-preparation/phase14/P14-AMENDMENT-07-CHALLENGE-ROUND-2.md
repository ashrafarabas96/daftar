# P14 — AMENDMENT 07: response to the independent challenge, round 2 (at `08d23da`)

**Status: `PREPARED`, `CHALLENGED`, `NOT PROMOTED`. `READY_TO_PROMOTE` = NO.**
Round 2's verdict was **PASS-WITH-SCOPE**: all seven round-1 findings closed, all
three of this thread's own new findings reproduced and confirmed — one *a
fortiori* — and the eight-column outcome upheld. **What the challenger would not
sign was the evidence pack's reproducibility, and it was right.** This amendment
closes that. It still does not sign the pack.

## 1. P1-02 — my evidence was not reproducible, and that is the worst defect in this pack's history

`C8-rotation` was recorded as **exit 0** and **fails on re-run**. The composite
FK the case tests — `(business_id, replaces_api_key_id)` — was created by an
**ad-hoc `psql -c` command** and existed in **no committed script**. The
challenger re-ran my own committed files twice, standalone and in documented
order on a fresh database, and got exit 3 with
`LAW VIOLATED: business 2 rotated business 1 key`. A `grep` for `FOREIGN KEY` over
all 34 committed cases returned exactly one, and it was a different constraint on
a different table.

So `evidence.psv`'s `C8-rotation|0` could not be regenerated from the pack, and
*"the composite rotation link refuses a cross-business predecessor with 23503"*
had **no executed support** at the time it was published.

**It also had no proof-of-proof, and it was the only case that did not.**
`c1_grant_narrow`, `c9_setup_eight`, `c7_setup` and `c7_fix` all end by reading
`pg_get_constraintdef` or `prosecdef` to show the mutation landed. `C8` asserted
a **refusal** without first proving that the constraint which must produce it
exists. That is this pack's own §4 lesson inverted: I had written that an
unfenced **ABSENT** result settles nothing, and then published an unfenced
**PRESENT** one.

**Closed by construction.** `c8_setup_fk.sql` creates the constraint and refuses
to proceed unless `pg_get_constraintdef` returns a definition naming
`business_id`. Re-run in a single clean replay: `c8_setup_fk` exit 0 with
`LANDED: FOREIGN KEY (business_id, replaces_api_key_id) REFERENCES
p14s.api_keys(business_id, id)`, then `c8_rotation` exit 0.

## 2. P2-03 — three recorded runs had no committed script, two of them red proofs

`C2c-redproof` and `C3c-redproof` had no `c2c_*`/`c3c_*` file; their mutations
were ad-hoc commands. `C7d` depended on a `GRANT SELECT ON outbox_events`
performed by hand, and the challenger confirmed it exits 3 without it. **Two of
four red proofs were unreproducible, and the red proof is the only thing
separating a real gate from a decorative one** — which this pack's own README
says.

Closed: `c2c_rewiden_insert.sql`, `c3c_readd_disjunct.sql` and
`c7d_setup_grant.sql`, each with a proof-of-proof. And the smaller instance the
challenger noted — recorded case ids (`C1a-refused`) not matching script
filenames (`c1a_restrict_column_refused.sql`), with no mapping — is closed the
way it suggested: **`run.sh` now derives the case id from the script path**, so
every recorded run names the file that produced it and the class cannot recur.

Every run in the regenerated evidence comes from **one uninterrupted replay on a
freshly created database** in the order `ORDER` records. 43 runs; the only
non-zero exits are the four red proofs, where 3 is required.

## 3. (a) — the law citation was wrong; the outcome was not

The eight-column resolution stands and was verified propagated to all three
sections. **But it cited `P14-AL-11`, which is `IDEMPOTENCY FOLLOWS THE
REPOSITORY'S CONVENTION` and says nothing about this column.** Misattributed in
three places, all corrected.

The real rule is the third sentence of **`P14-AL-29`**: *a boolean of intent is
written at write time and **never read to decide usability***. And the
reformulation I used — *"a resolver that selects it is a reader of it"* — **dropped
the qualifier**, which matters more than the citation: in that broader form the
rule invalidates §11.1's own grant of `SELECT` and `UPDATE` on
`revoke_scheduled` to `daftar_app`, which the management surface needs in order
to display and set the intent. The resolver would consult it to decide
usability; the listing surface would not. **The qualifier is the law**, and the
exclusion follows for the resolver alone.

One correction in the other direction, offered because the challenger asked for
the rule to be numbered: **it already is.** It is inside `P14-AL-29`
(`P14-S0-ARCHITECTURE-LOCK.md:558-568`), not unnumbered prose at `:563` — `:563`
is a line of that law's body. So a gate asserting derivations against numbered
laws can reach it. The exclusion is now also justified independently, on the
ground that already carries `name`: minimal reach for the one principal that
reads every key digest in every business. That argument needs no law at all.

## 4. (b) — `TL-P14-SEC-02` had three errors, not one

**Option (C) was mispriced, and this is the important one.** It read *"the
correct fix, and it is not available"*. What is forbidden is **altering** frozen
`0004`; a `UNIQUE (business_id, id)` added by an **appended** migration alters no
frozen file — and §7a's own earlier paragraph already permits *"appending one to
a table this phase does not own"* (`:602`). **I collapsed "I may not write it"
into "it cannot be done", and so took the best option off the owner's menu.**
It is not unavailable; it is not Phase 14's to write, which is a different
ruling and precisely the one being asked for. Mechanically it works: the child's
`business_id` is `NOT NULL`, so under `MATCH SIMPLE` the composite FK is always
checked and a `NULL`-business parent can never be named — no trigger, no grant,
no exemption.

**A fifth option was missing.** (E): a relation **Phase 14 owns**, keyed
`(business_id, outbox_event_id)`, populated at fan-out where the business is
already known and policed by this phase's own RLS, with `webhook_deliveries`
carrying a composite FK to it. Composite key kept, no frozen change, no
`SECURITY DEFINER` exemption, no global read grant. Its cost is a second
relation and a fan-out write whose own correctness must be proved.

**Option (A)'s price depends on `TL-P14-SEC-01`, and I presented the two rulings
as independent.** Measured at the base: `0010_db_roles.sql:36-39` is
`CREATE POLICY outbox_worker ON outbox_events USING (current_user =
'daftar_worker')` — **PERMISSIVE, no business predicate** — plus `GRANT SELECT,
UPDATE ON outbox_events TO daftar_worker`. So if the Security Owner names
`daftar_worker` the delivery principal, **(A) costs nothing new**; if a dedicated
internal role is named, the `C7d` cost applies in full. And the cut runs both
ways, which the owner should have in those words: that `daftar_worker` already
holds a global read is **an argument against naming it**, and it belongs to
`TL-P14-SEC-01`. §11a already notes that role reaches credential deliveries and
invitations; this is a third instance of the same reach and, unlike the first
two, it is measurable. **The two rulings must be answered together.**

## 5. P2-04, P2-07, P3-08, P3-09

- **P2-04** — §4 was titled *"the two runs that were wrong"* while four exit-3
  non-red-proof runs existed; the two it omitted were `C7a` and `C7b`, the ones
  touching the open ruling. In the regenerated replay the only non-zero exits
  are the four red proofs, so the class is gone. And the result I was
  understating is now recorded: **`c7b_refused_after_grant`, exit 0** — §7a's
  central law, which had no passing run anywhere in the pack. The challenger was
  right that this is the strongest single piece of evidence for
  `TL-P14-SEC-02`.
- **P2-07** — the manifest said *"nothing has been executed, so nothing is
  claimed"* on the same page that describes a 45-run evidence document, and that
  clause survived my edit to the sentence beside it. The challenger's own
  distinction is adopted verbatim because it is exact: **no gate has been
  measured; 43 law proofs have been executed.** Gates are tasks
  002/007/013/023/025 and `GATE-032`/`033`/`034`, all still `UNMEASURED`.
- **P3-08** — three script comments misnamed what their script does, which
  matters when the exit code *is* the verdict. `c1c_red_proof` said *"the lookup
  column"* and revokes `secret_sha256` (the lookup column is `key_id`); `c2d`
  named `secret_sha256` as the blocking `NOT NULL` while the document records
  `subject_user_id` firing first; `c2_scope_insert` grants a four-column set
  while §11.1 enumerates none. All three corrected — and the third exposed a
  real gap, below.
- **§11.1a, new.** §11.1's `daftar_app` `INSERT` cell read *"see below"* and the
  prose below it never enumerates a set; it says only what is **not** in it. A
  matrix that declares itself authoritative must state the set. Rather than
  invent one, the gap is recorded with its two candidate resolutions and
  **routed with `TL-P14-SEC-01`**, because *"which principal may write a key
  digest"* is the same question as *"which principal holds the plaintext"*. The
  proof case now states that its own column set is **illustrative**.
- **P3-09 — and this one turned out to be the root cause of P2-02, so it is
  treated as a section rather than a footnote (new §15).** The finding is about
  the commit this pack was **cut from**, not about the branch's name:
  `git merge-base --is-ancestor 93084f8 <head>` fails, so the declared base is
  not in this commit's history. My first answer pointed at the designated-branch
  rule, which was a non-answer — **that rule constrains the branch's name, not
  the commit it is cut from**, and the challenger was right to refuse it.

  Investigating it properly produced something neither review had: **six of the
  fourteen cited files differ between the two trees**, not just `database.ts`
  as the manifest disclosed — and one of them is `permissions.ts`, by 66 lines.
  **At `6fc505d`, `:149` *is* `cashier: ['catalog.view']` and `:144` *is*
  `'inventory.view'` in the manager block.** So the round-1 P2-02 citations were
  **exactly right for the tree they were read from and exactly wrong for the
  base this pack declares**, and round 1's diagnosis — a historical set read as
  the current one — is wrong. The challenger could not have seen this, having
  read only a `93084f8` worktree where those citations are simply wrong.

  That reframes the trap: **a citation verified against the wrong tree is not a
  typo, it is a coherent reading of the wrong world**, and it produces findings
  that look like carelessness. Every cited frozen migration is byte-identical at
  both trees, so no RLS, grant or policy citation is exposed.

  **Neither remediation is taken, and §15 says why in full.** Cutting the branch
  from `93084f8` was available and was not done — but doing it now, or merging,
  pulls **327 files and 133,615 insertions** of Phase 4's **unmerged, unsigned**
  work (PR #6, `S7 C1` open) into a docs-only branch, which would misrepresent
  it as carrying another phase's unreviewed state. Rewriting history is
  forbidden. The fix is §15's per-citation provenance table plus an extension to
  `P14-GATE-032`: every citation is asserted against `93084f8` **explicitly**,
  not against whatever tree the runner happens to have.

## 6. What round 2 confirmed and should not be reopened

- All seven round-1 findings properly closed; the eight-column outcome and its
  propagation to §1, §3 and §11.1.
- Commit hygiene: 55 files, no application code, no frozen migration, no
  migration number. All 15 manifest hashes.
- The four roles' `NOSUPERUSER`/`NOBYPASSRLS` status, **re-read from `pg_roles`
  by the challenger** rather than taken from this pack's claim.
- Every law runnable from the committed scripts reproduced its recorded exit
  code, red proofs included, **except `C8`**.
- All three of this thread's own findings, reproduced independently, with
  finding 1 holding *a fortiori*.

## 7. What remains blocking

- **`TL-P14-SEC-01` and `TL-P14-SEC-02`, now explicitly coupled**, and
  `TL-P14-SEC-03`. SEC-02 carries **five** costed options, not four.
- **No migration number** before Phase 13 seals.
- `OD-P14-09`, `OD-P14-10`, `OD-P14-11`, rate limits, Phase 5 pricing — the
  owner's.
- §11.1a's `INSERT` principal, routed with SEC-01.
- **The challenger's signature. This thread does not sign its own pack**, and
  round 2 is the second consecutive round in which an independent reviewer found
  a defect class my own review did not.
