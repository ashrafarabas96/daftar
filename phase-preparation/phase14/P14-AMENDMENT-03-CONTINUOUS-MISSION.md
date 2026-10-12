# P14 — AMENDMENT 03: the Master Continuous Mission, Phases 4–15

**Status: `PREPARED / NOT PROMOTED`. DOCS ONLY. ALL GATES UNMEASURED.**
**Base: `93084f8`. Branch `claude/phase14-prep-1zqgj8`, no commits, no code, no
migration number. No timing or performance claim is made anywhere in this pack.**

> **ANNOTATION (`COORD-DIFF-REVIEW c812aa5 P2-03`).** This header's branch name and *no commits* are **false now and were false from `08d23da` onward**: the real branch is `claude/project-thread-1zqgj8`, cut from `6fc505d`, and the pack is committed and pushed on it. The line is left as written because an amendment is dated evidence; what it says about the branch is corrected here and in `P14-HANDOFF-MANIFEST.md` §1.

Source: the owner's *Master Continuous Mission, Phases 4 to 15* (2026-10-12),
`## 21. Phase 14 — Public API / Integrations` of the uploaded original, read in
full and verified line by line against the coordinator's extraction in
`/mnt/project-files/directives/MASTER-CONTINUOUS-MISSION-PER-PHASE.md`.

## §0. Verification of the extraction against the original

The extraction is **faithful**: every ruling in it is in the original. Three
details the extraction compressed are recorded here because each one carries
work, and the original is what this amendment applies:

| Original (§21) | In the extraction | Why it matters |
|---|---|---|
| “ويتبع DELETE وإضافة الوقائع العقد” | folded into the UPDATE sentence | `DELETE` and fact-insertion are themselves contract questions, so the matrix states them per relation rather than only fixing `UPDATE` (§11.8) |
| “لا جدول مفقود في مصفوفة الهجوم” | folded into the inventory sentence | makes the *attack matrix*, not only the grants summary, the place completeness is proved — §11b exists because of this clause |
| “احسم مراجع الاحتفاظ وإعداد الحداثة بدل رقم 300s غير معتمد” | “Replace the unapproved `300s` value” | **retention** is part of the same ruling, not only freshness — hence two decisions, `OD-P14-09` and `OD-P14-10` |

Nothing in the original contradicts the extraction, and nothing in either
contradicts Directive 11 or §77 as this pack already adopted them.

## §1. What the Mission confirmed

The “Covered” list is this pack's existing design, restated by the owner:
key = live member ∩ scopes; no sensitive permission on a v1 key; `/public/v1` on
the same host with a separate guard, DTOs, limits, audit and error ceiling; no
generic `Idempotency-Key` authority; digest-only secret shown once; explicit
rotation with no hidden window; the full SSRF list with pinning; webhook
signing; sealed contracts only. **No change is required by any of it.**

Two further confirmations:

- **The v1 surface is exactly what this pack proposed** — eight paths, nine
  operations, seven reads and two writes, from sealed contracts, with the S4/S7
  routes and events deferred until seal and a Contract Diff. The Mission arrived
  at the same numbers independently (`P14-MIGRATION-PATCH-REQUEST.md` §11.9).
- **Execution comes after P13.** Phase 14 prep continues in parallel; promotion
  does not. This is the serial-promotion law, not a new constraint, and the
  status stays `PREPARED / NOT PROMOTED`.

## §2. What the Mission changed: six spec fixes, before any DDL

The Mission's instruction is “أصلح المواصفة قبل DDL”. Four of the six are
**defects in this pack**, found by the owner's reading and not by mine. Each is
recorded with what was wrong, not only what is now right.

### FIX 1 — the authentication path read a column that does not exist
`§1` of the migration request listed `status` among the columns the resolver
selects, while `§3` of the same document declared that **there is no `status`
column** and that usability is derived from `revoked_at` and `expires_at`. A
reader implementing the resolver from `§1` would have written a query that does
not compile against the schema. Fixed: the read list names the eight real
columns; the derivation is written once as an expression; each refusal code is
mapped to the column that produces it; and a catalogue test asserts that every
column the resolver names exists and that **no** column named `status` does, with
a planted red proof. New law **`P14-AL-29`**.

### FIX 2 — a summary granted what a section denied
The old `§11` put `api_keys` and `api_key_scopes` in one cell reading
“SELECT/INSERT/UPDATE, no DELETE”, while `§4` grants `UPDATE` on
`api_key_scopes` to **nobody** and needs `DELETE` to withdraw a scope. Both
halves were wrong, in opposite directions. Fixed: `§11` is now a matrix of one
relation per subsection and one operation per column, column-scoped where the
column matters, declared **the authority** over any section's prose; `§11.8`
adds the scope → operation → relation map the Mission asked for, keeping the
HTTP-scope question and the DB-grant question apart instead of conflating them;
and a gate asserts the matrix from `information_schema` in both directions. New
law **`P14-AL-30`**.

### FIX 3 — the scheduled revoke had four readers and no single definition
Fixed in place: one table naming the auth predicate, the listing surface, the
consistency trigger and the rotation command, with the rule that
`revoke_scheduled` is a **write-time assertion of intent that no reader may
consult to decide usability**. A scheduled revoke whose instant has passed keeps
`revoke_scheduled = true` and **is revoked**; a reader that branched on the
boolean would serve a revoked key. A new trigger
(`api_keys_revocation_consistent`) refuses a row where the boolean and the
timestamp disagree, on INSERT and UPDATE both, and a test exercises the instant
either side of the boundary against the predicate itself.

### FIX 4 — the context-free worker construction was unsound
This pack wrote, in `§5` and implied in the old `§11`, that the delivery worker
reaches its rows through “a role-keyed PERMISSIVE SELECT”. **Measured, not
recalled:** `outbox_events` carries three PERMISSIVE policies and **no
RESTRICTIVE policy at all** (`0006_rls.sql:59-61`, `0010_db_roles.sql:36-38`,
`0045_accounting_post_entry.sql:434`), which is why the outbox relay works
today. Every Phase 14 relation carries the RESTRICTIVE `business_isolation`
pair, on which a PERMISSIVE addition is **inert**, and
`withWorkerTransaction` sets neither scope nor bypass
(`database.ts:849-851`). So the proposed construction yields a worker that sees
**zero rows**: the delivery loop never dispatches, and the obvious “repair” —
dropping the RESTRICTIVE policy — would expose every delivery row to every
context-free connection. Failing closed was the good case; the repair was the
dangerous one.

**Looking for the precedent found that the house had already hit this, twice,
and that the repository contains the evidence.** `0014_branch_scopes.sql:10-15`
drops and recreates a RESTRICTIVE policy to exempt `daftar_resolver` under the
comment “*the RESTRICTIVE business_isolation policy applies to EVERY role*”, and
`0020_credential_delivery_outbox.sql:72-78` does the same for `daftar_worker`
under “*must not block the worker. Recreate it with the worker exemption (0014
pattern)*” — **while also** creating a PERMISSIVE `worker_delivery` policy
(`:65-70`). Both were needed, which is direct evidence from inside this
repository that the construction this pack proposed does not work. So the
accepted house shape is the disjunct in **both** halves, and the shape this
request recommends is **stricter** than the precedent, not a novelty: `USING`
only, with every write performed in a per-business scoped transaction. §11a now
presents both, says plainly which one the house already approved, and routes the
choice to the Security Owner with the non-superuser attack and its planted red
proof as the required evidence. **No DDL for `webhook_endpoints`,
`webhook_subscriptions` or `webhook_deliveries` is written until that ruling
exists.** New law **`P14-AL-31`**; ruling `TL-P14-SEC-01`.

**A requirement this pack had omitted entirely, surfaced by the same search.**
`0020:54-58` records that a context-free role needs `GRANT SELECT ON businesses`
because the PERMISSIVE `tenant_membership` policy evaluates its
`EXISTS (SELECT 1 FROM businesses ...)` subquery whichever permissive policy
matches. Without that privilege the worker's statement fails on a **permission
error**, not with zero rows. It was in no part of this request and is now
required under every option in §11a. It is the kind of requirement that stays
invisible until the worker is run as itself, which is the argument for the
non-superuser attack in one line.

### FIX 5 — a business-scoped relation was missing from the inventory
`webhook_inbound_events` was absent from the grants summary, had no RLS or grants
paragraph of its own, and was the sixth table behind a cross-tenant test that
said “all five business-scoped tables”. Fixed: `§8` gains its RLS, grants and
append-only trigger; `§11.6` gives it a matrix row; `§11b` is a new **attack
matrix** over all six relations by name, with the two global registries listed as
deliberately absent **and the reason stated**; and the cross-tenant test names
the six instead of counting them. New law **`P14-AL-32`**.

### FIX 6 — the `300s` freshness value was never approved
It stood in `P14-AL-14`, in the receiver contract and in the already-withdrawn
`OD-P14-07` table. It was the common default of other vendors, which is not a
ruling about this product. Withdrawn by name. What is fixed instead is the
**mechanism, with no number**: one configured tolerance, published in the
developer documentation and read by the sample code and the signing tests from
the same source; never inferred from retry backoff or lease duration; **no
production default**, so a configuration that omits it is a startup refusal, as
`P14-AL-18` already requires of the rate limits; and a test that prevents the
number re-entering the pack as a “temporary” constant. The value is
**`OD-P14-10`**. Retention — the other half of the same Mission clause — is
**`OD-P14-09`**: no role holds `DELETE` on either ledger, deliberately, and the
retention window of `webhook_inbound_events` **is** the replay-dedupe window, so
it may not be shorter than the longest redelivery interval of any external
source.

## §2a. A discrepancy in this pack's own identity, stated rather than quietly fixed

While verifying the new citations, the working tree was found to be at
**`6fc505d`** (`main`) while this pack declares its base as **`93084f8`**, and
the Phase 14 prep branch is checked out in a different worktree. `93084f8` is a
descendant of `6fc505d`, so the tree is *behind* the declared base, and
`apps/api/src/infra/database.ts` differs between the two trees; **the line counts are generated** and not typed here — the table in §15 of `P14-MIGRATION-PATCH-REQUEST.md` carries them, produced by `tools/citation-provenance.py` (`COORD-DIFF-REVIEW c812aa5 P2-03`: this line said *205 lines*, a figure copied out of its generator).

Consequences, measured:

- **Every migration cited by this amendment is byte-identical at both commits**
  (`0006_rls.sql`, `0010_db_roles.sql`, `0045_accounting_post_entry.sql`,
  `0014_branch_scopes.sql`, `0020_credential_delivery_outbox.sql`), as frozen
  files must be. Those citations hold at the declared base.
- **Two `database.ts` citations needed correcting to the declared base's line
  numbers**: `withWorkerTransaction` is `:1024-1026` at `93084f8`, not
  `:849-851`, and the reconciler block is `:1026-1041`. The *fact* those lines
  carry — `this.run(this.workerPool, {}, false, fn)`, no scope and no bypass —
  is identical at both commits, so no argument changes; only the citations did,
  and both now name the base with the other tree's numbers noted.
- The base of record stays **`93084f8`**. This pack has no commits, so there is
  nothing to rebase; what mattered was that a citation written from one tree was
  about to be published against another, which is the mistake this project has
  already recorded more than once.

## §3. Cross-phase items in the Mission that touch this pack

| Mission item | Effect here |
|---|---|
| hard-link hazard: never write inside a hard-linked sandbox | no proof in this pack writes to any tree; `P14-AL-28` already forbids touching frozen history. Adopted as-is |
| frozen boundary moves forward only | this pack allocates no number and depends on no `0080`–`0086` object, so a boundary that advances cannot invalidate it |
| status ladder `PREPARED → CHALLENGED → READY_TO_PROMOTE → PROMOTION_IN_PROGRESS → ACCEPTED / SEALED` | adopted as the superset of Directive 11 PART 117. This pack is at **`PREPARED`**; it reaches `CHALLENGED` only when an independent challenger runs, which has **not** happened |
| ownership table (§6) | the Security Owner now holds `TL-P14-SEC-01`; the Migration Owner still holds the number; the two unowned shared files (`redis.ts`, outbox `publisher.ts`) are unchanged by this amendment and still sit with the Phase 4 coordinator as interim holder |
| DAG task schema | the task DAG already carries requirement ids, owners, reviewers, write paths and blocker classes; three tasks are added by this amendment (§4) |
| defect budget P0=P1=P2=0 for money/stock/security/tenant | FIX 4 would have been a P1 security defect had the DDL been written. It was not written, and no DDL for the three affected relations is written now |
| progress reporting: do not derive progress from agent, test or line counts | this amendment reports fixes, not counts |

## §4. Task DAG additions

| Task | Deliverable | Owner | Blocker class |
|---|---|---|---|
| `P14-SEC-026` | obtain `TL-P14-SEC-01`: the Security Owner's ruling on the context-free delivery principal, with the non-superuser attack and its red proof | Security Owner | **blocks DDL** for three relations |
| `P14-GATE-027` | the grants-matrix gate: `§11` asserted from `information_schema` in both directions, planted red proof each way | Phase 14 author | blocks the security tier |
| `P14-GATE-028` | the resolver-column gate (`P14-AL-29`) and the no-literal-tolerance gate (FIX 6) | Phase 14 author | blocks publication of the developer docs |

## §5. What is owed, and by whom

Unchanged by this amendment except where noted:

- **The Migration Owner**: the number. Still not allocated, still not guessed.
- **The Security Owner**: `TL-P14-SEC-01`. **New, and it blocks DDL.**
- **An independent challenger**: has never run on this pack. The Mission's ladder
  makes that the step between `PREPARED` and `CHALLENGED`.
- **The coordinator**: an actual-diff review, and an owner for `redis.ts` and the
  outbox `publisher.ts`.
- **The owner, before production and not before review**: `OD-P14-09`
  (retention), `OD-P14-10` (freshness tolerance), the rate-limit values, and the
  Phase 5 pricing of the public-API capability.

Nothing architectural waits on the owner today.

---

*`PREPARED / NOT PROMOTED`. Amended 2026-10-12 from `93084f8`. Evidence classes:
`DESIGN ONLY` for everything Phase 14 proposes, `PROVEN IN LIVE CODE` for each
line carrying a `file:line`, `UNMEASURED` for every gate. No timing claim is made
from this container.*
