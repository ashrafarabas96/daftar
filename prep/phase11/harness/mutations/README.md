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

**Every count reported from a mutation run names the PASS it was measured on**
(`P3-01` of round 5). The suites run twice on one database on purpose: the
second pass starts from the state the first left behind, so a bare number is an
ambiguous cell. There is no numbered migration anywhere in this directory.

None of these touches a frozen migration. They are applied to the running
scratch database, never to the tree.
