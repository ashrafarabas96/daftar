# Phase 11 mutation set — in the repository, by name

A mutation measured in the author's shell is a mutation a challenger cannot
reproduce. Each file here is applied through `P11_MUTATION_SQL` at step 5c of
`rebuild_and_prove.sh`, which applies it on a FRESH database after the packs
and the worlds and BEFORE any proof runs (finding of round 3: a mutation
applied after the suite has run measures the re-run), and which now digests
the DDL-visible state before and after and REFUSES a mutation that changed
nothing (finding P2-02 of round 4).

    P11_MUTATION_SQL=prep/phase11/harness/mutations/M7-drop-deferred-grid-closure.sql \
      bash prep/phase11/harness/rebuild_and_prove.sh

`M7`, `M8` and `M9` are a PAIR-DROP, and the reason is the P5 R9 lesson: a
one-at-a-time sweep cannot see two defences that mask each other. C-APP-01 is
now held by two layers — the BEFORE per-verb guards and the deferred
grid-closure check at COMMIT — so dropping either alone leaves the other
answering, and only the pair shows which law each door actually meets.

`M10` changes nothing. It is the red proof of the hook itself: a run with it
must REFUSE rather than report a green mutation run.

`M11` (round 5) drops ONLY the write-identity comparison inside
`catalog_grid_closed_check`, leaving the privilege loop and both guard layers in
place. It is the red proof of round 5's own finding — privilege is not
visibility, and the session that judges must be the session that wrote.

`M13` (round 5) applies the two statements the challenger produced as
byte-identical no-ops under round 4's digest: a column ACL and a `DROP NOT
NULL`. It is the red proof of the DIGEST, not of the tautology test, and the
file states its own measurement including the half of its first draft that was
wrong.

`M14`, `M15` and `M18` (round 6) are about the LEDGER that replaced the
forgeable GUC. `M14` restores the two privileges whose absence makes a
recorded identity unforgeable and unremovable. `M15` drops the RLS
own-transaction write policy, and its result was not the one predicted:
dropping the only `INSERT` policy on a FORCE RLS table permits no insert at
all, so it is fail-closed and broken rather than open. `M18` replaces that
policy with a PERMISSIVE one, and that is the plant defence's real red proof.

`M16`, `M17` and `M19` ARE GONE, and why they are gone is the seventh round's
finding. All three targeted `AND l.xmin = pg_current_xact_id()::xid` in the
deferred check. `M16` dropped the clause and reded nothing, and round 6 read
that green as "defence in depth whose effect is UNMEASURED" — named as a
residual rather than counted as a tested layer, which was the careful half of
the mistake. The careless half was treating unmeasured as inert. The clause
was reachable, and in both directions: `pg_current_xact_id()` returns the
TOP-LEVEL transaction id while a row written inside a SUBtransaction carries
the subtransaction's id as `xmin`, so the clause discarded every ledger row
written inside a savepoint, a PL/pgSQL `BEGIN ... EXCEPTION` block or an ORM's
nested transaction. It was a FAIL-OPEN (the harmful chain inside a RELEASEd
savepoint committed, rc 0) and a REFUSAL OF LAWFUL WORK (a wholly lawful build
inside a RELEASEd savepoint, rc 3). The clause is deleted from the pack, which
makes all three files vacuous: there is nothing left to drop.

`M20` (round 7) is their replacement and it runs the other way: it puts the
clause BACK, and the suite must go red. A remedy that is an ABSENCE can only be
red-proved by restoring what was removed, and `PA7-S1` and `PA7-S3` are the two
cases that must flip. `M20` is therefore the one mutation in this directory
whose point is that it is NOT green.

`M21` (round 9, finding `R9-F1`) is `PA8-O1`'s red proof, and it exists because
a passing case measures nothing until something can make it fail. `PA8-O1` says
the plant of a row for another transaction is refused for the ledger's OWNER as
well, because the ledger is FORCE RLS. Three candidates were measured rather
than reasoned about, and only one isolates that leg: `M15` leaves `PA8-O1`
green (a FORCE RLS table with no `INSERT` policy is default-deny, so the plant
is refused for a different reason), `M18` makes BOTH arms commit (it reds the
predicate for every role at once and attributes nothing to the owner), and
`M21` — `NO FORCE` with the policy kept — flips exactly one of the two. Its
`daftar_app` sibling `PA6-L2` is the isolating control and must stay red. The
apply-time half is a different defence and `M21` does not test it: removing the
`FORCE ROW LEVEL SECURITY` line from a COPY of the pack makes the rebuild exit
7 with `catalog.migration_end_state_invalid` by name.

`M11`, `M20` mutate by TEXT SURGERY on the live function body rather than by
pasting a copy of it, and they REFUSE outright if the text they target is not
there — `M20` refuses in both directions, including when the clause it restores
is already present, so it cannot pass as a test of a remedy that is not in
place. A pasted copy is a second implementation that drifts: it would keep
reding long after the real function changed, and the log would still say the
guard was tested.

**Every count reported from a mutation run names the PASS it was measured on**
(`P3-01` of round 5). The suites run twice on one database on purpose: the
second pass starts from the state the first left behind, so a bare number is an
ambiguous cell. There is no numbered migration anywhere in this directory.

None of these touches a frozen migration. They are applied to the running
scratch database, never to the tree.
