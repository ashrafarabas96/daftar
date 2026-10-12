# P14 — AMENDMENT 06: response to the independent challenge of 2026-10-12

**Status after this amendment: `PREPARED`, `CHALLENGED`, `NOT PROMOTED`.
`READY_TO_PROMOTE` = NO.** The pack has been independently challenged for the
first time since 2026-10-07; Amendment 05 §2 recorded that review as owed
rather than optional, and it is now done. **This amendment does not sign the
pack.** The challenger's verdict was **REJECT**; the five required items are
closed below, and the challenger — not this thread — decides whether that
suffices. Nothing here is self-signed.

## 1. What the challenge got right, and it was verified rather than accepted

Every load-bearing claim in the report was re-measured in this thread against
the declared base `93084f8` before any document was edited. **All seven findings
are real.** Specifically verified:

- `P14-MIGRATION-PATCH-REQUEST.md` §3 did grant **eight** columns to
  `daftar_identity` while §11.1 granted **ten** — and §3 *argued* for eight on
  security grounds, so the two sections gave opposite reasons for opposite
  grants.
- `permissions.ts` at `93084f8`: the cashier is at **`:214`** and holds
  **five** permissions, not one; manager's `inventory.view` is at **`:179`**;
  `:146` is `isSensitivePermission()` and `:144` is the tail of
  `SENSITIVE_PERMISSIONS`. The pack's `:149`/`:144` citations and its
  single-permission cashier were both wrong.
- §3 did carry an unapproved `5 minutes`, and the manifest did claim no timing
  value appeared anywhere in the pack.
- `P14-GATE-033` was scoped to §1 ↔ §11.1 in both `P14-TASK-DAG.md:191` and
  Amendment 05 §3, so the §3 contradiction was **outside the gate written for
  exactly that class**.
- The manifest described `P14-S0-ARCHITECTURE-LOCK.md` as 32 laws; it carries 39.

**The challenger's own evidence was also checked and is sound**, including its
reading that the species here is the one V3 FINDING 1 named: *a fix correct where
written and not propagated to the section that executes it.* That is now the
fourth consecutive recurrence, and the gate restatement below is aimed at the
recurrence rather than at this instance of it.

## 2. P1-01 — settled EIGHT, and the defect was in §1 and §11.1

The challenger asked that eight-or-ten be settled on §1's own derivation rule
rather than by copying ten into §3. Applying that rule:

**`P14-AL-29` states that a boolean of intent is written at write time and
*never read to decide usability*.** The resolver's only purpose in reading the
key row **is** to decide usability, so for that principal reading and consulting
are the same act, and the exclusion follows from the law **for the resolver
alone**.

> **Corrected in round 2 (CHALLENGE R2 (a)):** this paragraph originally cited
> `P14-AL-11`, which is `IDEMPOTENCY FOLLOWS THE REPOSITORY'S CONVENTION`
> (`P14-S0-ARCHITECTURE-LOCK.md:268`) and says nothing about this column. The
> misattribution was real and is corrected in all three places it appeared. It
> also stated the rule as *"a resolver that selects it is a reader of it"*,
> dropping *to decide usability* — and in that broader form the rule would have
> invalidated §11.1's own grant of `SELECT` and `UPDATE` on this column to
> `daftar_app`, which the management surface needs. The qualifier is the law.
> One correction in the other direction: the rule **is** numbered — it is the
> third sentence of `P14-AL-29` — rather than unnumbered prose, so a gate
> asserting derivations against numbered laws can reach it. `name` is management data; error and audit context is read
in the business transaction by `daftar_app`, which already holds it, and granting
it to the one role that can read every key row's digest across every business
widens the blast radius of the pack's most privileged principal for no
authentication purpose.

**So §3 was right and §1 and §11.1 were wrong.** All three now read the same
eight columns, and §1 carries the exclusion as a derivation with its reason
rather than as a trimmed list.

**Executed** (`P14-EVIDENCE-2026-10-12.md` §3, case `C9`, PostgreSQL 16.15 @
`en_US.utf8`, non-superuser): the ten-column query under §3's grant is refused
with `SQLSTATE 42501` — the authentication path refuses every request — each
omitted column isolated as a cause; the eight-column query and the usability
predicate both execute; and withdrawing `secret_sha256` turns that arm **red**
(exit 3), which is the red proof for the auth query the challenge required.

**`P14-GATE-033` is restated.** It no longer names a pair of sections. For every
relation it asserts **every section of the request that names a grant for it** —
§1's derivation, the relation's own DDL block, §11's matrix — equal in both
directions, with the sections found by **scanning the document for grant
statements** rather than by a list. A gate that enumerates its sources by name is
blind to the next section added, which is precisely how this defect arrived.

## 3. P2-02 — the cashier, corrected, and `sales.create` named

Line numbers and the permission list are corrected in both the patch request and
the architecture lock.

> **Re-diagnosed in round 2.** This amendment accepted the round-1 reading that
> a historical set had been read as the current one. That was wrong. At
> `6fc505d` — this container's checked-out tree — `:149` **is**
> `cashier: ['catalog.view']` and `:144` **is** `'inventory.view'` in the manager
> block, so both original citations were right for the tree they were read from
> and wrong for the declared base. The cause is the base-tree trap, now treated
> as a root cause in §15 of the patch request rather than as a footnote. The escalation conclusion **survives**: the cashier does
not hold `inventory.view`, so mapping `GET /stock` to `catalog.view` was a real
privilege escalation and `P14-AL-39` and `P14-GATE-032` stand.

What did not survive is the reasoning built on the false premise, and the pack
now states the consequence in the words it was missing:

> **`sales.create` is reachable by a cashier-delegated v1 key, so such a key can
> commit a sale through the public API.** Four of the cashier's five permissions
> are published v1 scopes and one of them is a write.

This is not an escalation — it mirrors the cashier's real application authority
and `membership ∩ scopes` is doing its job. It is a blast-radius statement, and
every place the pre-mortem and the attack matrix treated the cashier as the
narrowest delegating principal must now be read against `:214`: **the narrowest
built-in delegating principal can sell.**

## 4. P2-03 — §12 enumerates what the request commits to

§12 now lists `webhook_delivery_source_business` (§7a's entire proposed
enforcement for `TL-P14-SEC-02`, with its non-`SECURITY DEFINER` property and
its `NULL`-business refusal) and `webhook_delivery_link_immutable` (the
re-point refusal §14 already tests), and states
`webhook_delivery_payload_immutable` as a freeze with **exactly one permitted
transition** — the purge authority clearing `payload`, audited. §7 warned that a
flat freeze makes the purge impossible and that *"the trigger would be weakened
later to let it"*; the version §12 carried was the version §7 predicted would be
weakened.

## 5. P2-04 — the `5 minutes` is now a decision with no default

It becomes **`OD-P14-11`**, fail-closed: no default, and the service refuses to
start rather than choosing a value. The challenger's reasoning for why this is
not pedantry is adopted verbatim into the decision record — the interval sets
how stale `last_used_at` may be, and `last_used_at` is what a merchant reads to
decide whether a key is still in use and can be revoked. The manifest §5
sentence is corrected.

## 6. P3-05, P3-06, P3-07

- **P3-05** — the `subject_user_id -> users(id)` global FK is now disclosed in
  §3 on the §7a precedent, with the three sibling columns, the executed fact that
  a subject with no membership in the key's business is accepted by the schema,
  and the statement that the `membership ∩ scopes` intersection is the **only**
  guard. A membership-binding assertion is raised as **`TL-P14-SEC-03`** rather
  than decided here.
- **P3-06** — the extended RESTRICTIVE policy is now **`FOR SELECT`**, not
  `FOR ALL`. `WITH CHECK` does not govern `DELETE`, so a `FOR ALL` policy
  carrying the identity disjunct in `USING` placed no business isolation on a
  `DELETE` by `daftar_identity`. Nothing was reachable — `DELETE` is granted to
  nobody — but the isolation of that role rested on a grant never being widened.
- **P3-07** — the manifest row reads 39 laws.

## 7. What this thread's own execution added, beyond the challenge

The challenge was answered while this thread was converting its own prose claims
into executed evidence on the same settled target. Three findings came out of
that work and none of them is in the challenge report:

1. **§11.1's column-scoped merchant `INSERT` set is not satisfiable** (`C2d`).
   Both branches are closed — `23502` without the columns outside the set,
   `42501` with them — so key creation cannot be a direct merchant `INSERT` at
   all. A grant matrix must be **satisfiable** as well as safe.
2. **§7a's proposed assertion is inoperable as written** (`C7c`), and making it
   operable costs the writing role a read over a **global** event ledger
   (`C7d`, measured: 2 rows belonging to another business or to the platform).
   `TL-P14-SEC-02` is therefore re-put to its owners as **four costed options**
   rather than as a trigger in the abstract.
3. **`app.bypass_rls` is not a god-mode read on this idiom** (§4 of the evidence
   document). It relaxes only the RESTRICTIVE half; a caller still needs a
   PERMISSIVE policy to admit it. This surfaced as a *failing fence*, and the
   fence's failure is what revealed that `C3a`'s 0-row assertion had first passed
   against an **empty table** — an unfenced ABSENT result settles nothing.

## 8. What remains blocking, independently of this amendment

Unchanged, and none of it is this thread's to close:

- `TL-P14-SEC-01` (Security Owner), `TL-P14-SEC-02` (Security + Outbox +
  Migration Owners, now with four costed options), and the new
  `TL-P14-SEC-03` (Security Owner).
- **No migration number** before Phase 13 seals (Mission V2 §14).
- `OD-P14-09`, `OD-P14-10`, the new `OD-P14-11`, rate limits and Phase 5
  pricing — the owner's.
- The challenger's counter-signature on these fixes. **This thread does not
  sign its own pack.**
