# P14 — AMENDMENT 04: Master Continuous Mission V2

**Status: `PREPARED / NOT PROMOTED`. DOCS ONLY. ALL GATES UNMEASURED.**
**Base `93084f8`. Branch `claude/phase14-prep-1zqgj8`, no commits, no code,
**no migration number — and under V2 none may be allocated before promotion.**
No timing or performance claim is made anywhere in this pack.

Source: the owner's *Master Continuous Mission, Phases 4–15, **V2*** (2026-10-12),
`## 21. Phase 14 — Public API / Integrations`, read in full in the original and
verified against the coordinator's delta in
`/mnt/project-files/directives/MASTER-CONTINUOUS-MISSION-V2-DELTA.md`. **V2
replaces V1.** The delta is faithful to the original.

## §0. What V2 settles, and what it opens

**Settled.** V2 records the six V1 spec fixes as **closed by Amendment 03** and
**removes V1's five bullets**. They are not to be re-asked or re-litigated. The
v1 surface stays eight paths / nine operations; execution stays after P13;
status stays DOCS ONLY with every gate UNMEASURED.

**Opened: eight review findings, to be closed before any SQL is executed.**
Six of the eight are **defects in this pack**, four of them in text written
**this morning** as part of Amendment 03 — a fix introducing its own defect is
the pattern worth naming, and the reason `P14-AL-33` now requires predicates to
be executed rather than read.

## §1. The eight findings

### FINDING 1 — the usability predicate was missing its parentheses *(defect, mine, severe)*
Amendment 03 wrote:

```
revoked_at IS NULL OR revoked_at > now() AND (expires_at IS NULL OR expires_at > now())
```

`AND` binds tighter than `OR`, so this parses as
`revoked_at IS NULL OR (…)`: **every key that was never revoked would have been
accepted however long ago it expired.** The expiry check was unreachable for
exactly the keys it exists to stop — and it was introduced by the fix that
replaced the non-existent `status` column, in an expression that reads as
obviously correct. Corrected to the fully parenthesised form, with three
properties now tested rather than asserted: the boundary **refuses** (`>`, never
`>=`), the clock is the **server's** per the contract with no client time
reaching it, and expiry and revocation **compose** rather than needing a second
invented condition. New law **`P14-AL-33`**.

### FINDING 2 — the narrowed resolver list could not run its own query *(defect, mine)*
Amendment 03 narrowed the `daftar_identity` read to eight columns and omitted
**`key_id`** and **`id`**. PostgreSQL requires the `SELECT` privilege on a column
a statement **restricts on**, not only on one it returns, so the lookup
`WHERE key_id = $1` would have been refused; and `id` is the join key to
`api_key_scopes (business_id, api_key_id)` and the row identity the
`last_used_at` write names. The failure would have surfaced as a permission
error on the `WHERE` clause — which reads like a policy problem and is not one.
Column sufficiency is now derived in a table from **the statements the resolver
runs**, and the rule that a grant is never widened to make an error disappear is
law **`P14-AL-34`**.

### FINDING 3 — the revocation trigger would have refused unrelated updates *(defect, mine)*
Amendment 03's trigger compared `revoke_scheduled` with `revoked_at > now()` on
**every** `UPDATE`. Once a scheduled instant passes, that equality is false by
construction — the boolean stays `true` and `revoked_at` is now past, which is
the correct state — so the next write of `name` or `last_used_at` would have
been refused with a revocation error: the key still works while its metadata
becomes unwritable, a confusing failure far from its cause. The deeper flaw is
**clock-derived mutable truth**. The check now runs on `INSERT` and only on an
`UPDATE` that changes an intent field (`revoked_at`, `revoke_scheduled`), and
`revoked_at` is append-once and may move **earlier** only. Which further fields
count as intent, and whether a revoked key's metadata may be edited at all, is
the contract owner's with `TL-P14-SEC-01` — a product question, not a schema
one. New law **`P14-AL-35`**.

### FINDING 4 — `TL-P14-SEC-01` stays open, with a wider brief
Unchanged in substance, widened in scope: the Security Owner decides the
principal **and the reachability bound**, and whether the exception is `USING`
only with scoped writes or both halves per the approved precedent, across
endpoints, subscriptions and deliveries together. V2 adds three cautions now
written into §11a: **a broad `SELECT` grant is not a decision that a role may
see every row**; a policy subquery must not be assumed always to execute (the
`businesses` dependency of `0020:54-58` is exactly that case); and **a NOLOGIN
identity relaxes no grant by itself**. The proof is sequenced — catalogue, then
positive runtime, then negative runtime, then mutation — because a catalogue
assertion proves what was granted and never what is reachable. No DDL for the
three relations until the ruling.

### FINDING 5 — a role could insert a column it may not read *(defect, mine, severe)*
§11 said `INSERT: yes` unqualified while withholding `SELECT` on the secret
columns. **The two privileges are independent in PostgreSQL.** As written,
`daftar_app` — the ordinary merchant request path — could have inserted an
`api_keys` row carrying a **digest of its own choosing** and a
`subject_user_id` of its own choosing: minting a working API key impersonating
another member, without ever reading a secret. The same held for
`webhook_endpoints`, where a merchant path could have registered an endpoint
with an attacker-chosen signing secret, leaving rotation nothing to protect.
Every `INSERT` is now column-scoped to what the role genuinely supplies; keys
and secrets are written only by the management command under an internal
authority; and the question *“can this role insert a value it may not read?”* is
asked of every relation in §11 and asserted from the catalogue. Part of
**`P14-AL-34`**.

### FINDING 6 — a delivery could name another business's source event *(defect, mine)*
`webhook_deliveries.outbox_event_id` is a **global** FK to `outbox_events(id)`
while the delivery carries its own `business_id`. RLS constrains which delivery
rows a business sees and says nothing about which source event one may name, so
business A's delivery could reference business B's event — and since the
projected payload is copied from that event at fan-out, that is a cross-business
payload leak that every policy in this pack passes. **Measured:** at `93084f8`
`outbox_events` is `id UUID PRIMARY KEY` with a **nullable** `business_id`
(`0004_infra.sql`) and no unique on `(business_id, id)`, so the composite FK that
would close this **cannot be written without altering frozen history** — and no
new FK goes into a frozen migration. New **§7a** proposes an explicit
`BEFORE INSERT` assertion (not `SECURITY DEFINER`, so the subquery is itself
under RLS — the check succeeds *because* of RLS, while the explicit comparison
means it does not **rest** on that), refuses a `NULL`-business source, and makes
`outbox_event_id`, `endpoint_id` and `business_id` immutable after insert so a
retry cannot re-point a delivery. **The ruling belongs to the Outbox and
Security owners with the Migration Owner**, and covers `event_type`,
`occurred_at` and the authority performing the typed projection. New law
**`P14-AL-36`**.

### FINDING 7 — the early-numbering exception is withdrawn
§13 had concluded that because nothing here depends on `0080`–`0086`, “Phase 14
can therefore be allocated whether or not the S4–S7 candidates are sealed, which
is deliberate.” **V2's §14 overrides that sentence explicitly** and it is
withdrawn: having no blocking dependency says this request *could* be applied
early; the train rule says it **will not be**. Preparation carries no number;
Phase 14 is numbered and promoted only after Phase 13 is sealed. V2 also
corrects the reasoning that produced it — *“not every migration effect is a new
table”*: the real upgrade surface is the §10 backfill, the §11 grants, the
`businesses` privilege and the registry seeds, so the upgrade proof runs against
a database with real businesses, owner roles and a previous grant state.

### FINDING 8 — withholding `DELETE` is not a purge mechanism
§11 grants `DELETE` to nobody, which stops ad-hoc deletion and leaves the
ledgers growing with **no way to shed payloads at all** — the missing capability
would have been discovered in production. §7 now states the **operation** and
not the duration: a named authority, an audit row carrying actor, window and
count, `payload` cleared on terminal deliveries while the row and its
exactly-once constraint survive, and one permitted transition in the
immutability trigger rather than a trigger weakened later to allow it. On
`webhook_inbound_events`, **a purge may never shorten the dedupe window** — the
row *is* the replay defence, so where retention and dedupe disagree, dedupe
wins. Two **stale references corrected**: the delivery retention window cited
`OD-P14-08` (which is “who may read a signing secret”) and now cites
`OD-P14-09`; the endpoint cap cited the withdrawn `OD-P14-07` and is now stated
as configuration with no production default. No retention period or legal
duration is proposed by this thread. New law **`P14-AL-37`**.

## §2. What this says about the pack's assurance

Three of the four Mission-V1 defects, and six of these eight, were found by the
owner's review rather than by this thread. **Four of the eight are in text
written this morning while fixing the previous four.** That is the honest state
of this preparation: its self-review is not catching this class of defect, and
the independent challenger — still **never dispatched** — is owed, not optional.
The pack remains at **`PREPARED`**, not `CHALLENGED`.

The pattern across findings 1, 3 and 5 is one thing: each was a statement that
reads correctly and executes differently — a precedence rule, a clock inside a
constraint, two privileges that look like one. `P14-AL-33`, `P14-AL-34` and
`P14-AL-35` exist to make the executable artifact, not the prose, the thing a
gate asserts.

## §3. Task DAG additions

| Task | Deliverable | Owner | Blocker class |
|---|---|---|---|
| `P14-SEC-029` | the delivery/source-event ruling of §7a: `event_type`, `occurred_at`, the projection authority, and whether `outbox_events` should gain the unique constraint in a future owned migration | **Outbox + Security owners, with the Migration Owner** | blocks `webhook_deliveries` DDL alongside `TL-P14-SEC-01` |
| `P14-GATE-030` | the executed-predicate gate (`P14-AL-33`): boundary instants, composed expiry and revocation, server clock, and the planted red proof that the parenthesisation is load-bearing | Phase 14 author | blocks the security tier |
| `P14-GATE-031` | the insert-privilege gate (`P14-AL-34`): no runtime role may insert a column it may not read, asserted from the catalogue over all eight relations | Phase 14 author | blocks the security tier |

## §4. What is owed

- **Security Owner**: `TL-P14-SEC-01`, with V2's widened brief. **Blocks DDL.**
- **Outbox + Security + Migration owners**: §7a. **Blocks DDL.**
- **Contract owner**: the intent-field question of FINDING 3.
- **Migration Owner**: the number — **at promotion, after Phase 13 seals**, and
  at no earlier moment.
- **An independent challenger**: never run. See §2.
- **Coordinator**: an actual-diff review; owners for `redis.ts` and the outbox
  `publisher.ts`.
- **Owner, before production and not before review**: rate limits, Phase 5
  pricing, `OD-P14-09` retention, `OD-P14-10` freshness tolerance.

Nothing architectural waits on the owner today.

---

*`PREPARED / NOT PROMOTED`. Amended 2026-10-12 from `93084f8`. Evidence classes:
`DESIGN ONLY` for everything Phase 14 proposes, `PROVEN IN LIVE CODE` for each
line carrying a `file:line`, `UNMEASURED` for every gate. No timing claim is made
from this container.*
