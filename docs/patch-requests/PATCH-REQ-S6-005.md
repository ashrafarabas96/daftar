# PATCH-REQ-S6-005 — re-record `purchase_settlement_verify`'s digest forward, and the substring assertions that are the real hazard

**From:** P4-S6 owner, branch `p4s6/owner`, base `6587460ba3632231e4324c5ce2af92e1589d0705`.
**Status:** OPEN as a **TASK**. No ruling is required and none is sought.
**Severity:** routine. It blocks nothing, and it never did.

## Two withdrawn framings, both mine

This request was drafted twice wrongly, and the drafts are named here because the pack went
out with them.

1. **"The one blocker that is a decision and not a task."** Wrong: the frozen **file** is
   modified by none of the options — the routine is replaced by forward DDL, which is already
   append-only — and byte-immutability binds the **migrations**, not the accepted suites.
2. **"An open ruling of the coordinator's, to be made at S6 promotion."** Also wrong, and
   this is the one that mattered: there is nothing to rule, because the consumer does not
   hard-code a digest at all.

The second correction came with first-hand evidence, and I have verified it in the tree
myself rather than taking it on report.

## The measured fact, read from the consumer and not from the migration

`tests/security/settlement-s6-guard-gaps.test.ts:122-140` computes
`encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex')` **from live `pg_proc`** for every
watched function, and then asserts that `supplier_settlement_guard_gaps()`'s own **live**
`prosrc` CONTAINS `"<signature>": "<that live sha>"`:

```
for (const row of r.rows) expect(src, `${row.f} is recorded at its installed body`).toContain(`"${row.f}": "${row.sha}"`);
expect(src.match(/"[a-z_]+\([a-z,]*\)": "[0-9a-f]{64}"/g)?.length, …).toBe(22 + TD16_TRIGGERS.length);
```

**No digest is hard-coded anywhere in the suite.** The claim is live-against-live: *the
recording matches the installed body*. And the count — `22 + 3` recorded digests — is
unchanged by a **replaced** entry, because replacing a digest does not add one.

So one migration that does both:

- `CREATE OR REPLACE FUNCTION purchase_settlement_verify(…)` — the ACTIVE-subset widening, and
- `CREATE OR REPLACE FUNCTION supplier_settlement_guard_gaps()` — the same body with that one
  digest re-recorded,

is **green**. `0067.sql` stays byte-for-byte identical and no `tests/` file is edited.

**The precedent is in the same pair of functions, and I had quoted the comment that records
it.** `0067:1431-1435`: the S5 source-guard discovery is "`0065`'s text byte for byte — every
S3/S4/S5 row and the forty other recorded digests — **except the one `credit_note_immutable`
digest**, which is now the SHA-256 of section 4(e)'s body". And the suite asserts exactly that
re-recording at `:143-147`. The device I was calling impossible is one the tree had already
performed once, on the function next door.

**The general rule, which is the part worth keeping:** a digest recorded inside a frozen file
is a pin on the **installed body**, not a freeze of the recording. Whether it obstructs
forward DDL is a question about its **CONSUMER** — never about the migration. I applied one
standard to dropping a frozen constraint by forward DDL (fine, and I specified it) and another
to re-recording a frozen digest (a blocker). That inconsistency was the defect.

## Required change

In the S6 migration (number unknown — `PATCH-REQ-S6-004`), as ordinary forward DDL:

1. `CREATE OR REPLACE FUNCTION purchase_settlement_verify(uuid,uuid)` over the **ACTIVE**
   subset, anti-joined against the supplier reversal relations.
2. `CREATE OR REPLACE FUNCTION supplier_settlement_guard_gaps()` with its own text unchanged
   except the one `"purchase_settlement_verify(uuid,uuid)"` digest, computed from the body
   installed in step 1 by the probe ritual `0067` itself uses, with the same signature, owner,
   `INVOKER STABLE`, pinned `search_path` and ACL.
3. The end-state block asserts, **from the live catalogue**, that the recorded digest equals
   `encode(sha256(convert_to(prosrc,'UTF8')),'hex')` of the installed body, and that the
   recorded-digest **count is unchanged** — so a migration that adds a digest instead of
   replacing one is refused by its own end state.

## The hazard that is actually open, and is not this one

`0067:2790`, `0072:903` and `0077` each assert a **SUBSTRING** of
`accounting_reversals_20_domain_source_guard()`'s always-refused source-type list.

> **An assertion on a substring of a message is an assertion about the wording, not about the
> law.** Three accepted migrations depend on the *text* of a refusal list for a claim they
> intend to make about *which source types are refused*. A rewording that preserved the law
> exactly would break them; a membership change that preserved the matched substring would
> not.

S6 moves three types **out of** that plain arm into a `purchase`-style paired arm, which
changes the list's membership. The S6 migration must therefore probe what those three
assertions still match and either keep the plain arm's remaining order byte-identical or
carry the same forward-re-recording treatment. The durable fix — assertions that name the
refused **set** rather than quote the message — is larger than S6 and is not proposed here.

## Dependency

S6 promotion and a migration number, like every other DDL item. Nothing else.

## Consequence for the pack

The supplier half of TD-15 is **no longer blocked and is now specified** past level E:
`docs/PHASE_4_S6_DDL_SPECIFICATION.md` §4 carries `purchase_settlement_verify`'s widening as
an ordinary replaced routine, and `docs/PHASE_4_S6_LEVEL_UNIQUENESS.md` §5 carries L4 and L5's
replacement on the same footing as L1–L3. `docs/PHASE_4_ARCHITECTURE_LOCK.md:1630` — *"Phase 4
may not close with TD-15 unowned"* — is met by specification rather than deferred to a ruling.

## The test that requires it

`tests/security/settlement-s6-guard-gaps.test.ts`, which is green at the base SHA, stays green
through the change **because** step 2 re-records the digest; it is the test that forces step 2
rather than the test that blocks step 1.

## Expected semantic diff

Two `CREATE OR REPLACE`s and one end-state assertion, inside the S6 migration. No frozen file
touched, no `tests/` file edited, no new relation, no new refusal.
