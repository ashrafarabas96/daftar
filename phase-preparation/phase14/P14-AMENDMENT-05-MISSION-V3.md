# P14 — AMENDMENT 05: Master Continuous Mission V3

**Status: `PREPARED / NOT PROMOTED`. DOCS ONLY. ALL GATES UNMEASURED.**
**Base `93084f8`. Branch `claude/phase14-prep-1zqgj8`, no commits, no code, no
migration number — and none may be allocated before Phase 13 seals.** No timing
or performance claim is made anywhere in this pack.

Source: the owner's *Master Continuous Mission, Phases 4–15, **V3*** (2026-10-12),
`## 21. Phase 14 — Public API / Integrations`, read in the original and verified
against the coordinator's delta in
`/mnt/project-files/directives/MASTER-CONTINUOUS-MISSION-V3-DELTA.md`. **V3
replaces V2.** The delta is faithful to the original.

## §0. What V3 settles

V3 **accepts the Amendment 04 corrections** — the parentheses, the resolver, the
revocation intent, the secret `INSERT`, the source-outbox binding, retention and
the worker — and says plainly: *“do not reopen the corrected fixes as if they did
not exist.”* They are closed. What V3 asks for instead is **unification and
proof**: the fixes exist in prose, and the documents that must agree with them do
not all agree yet.

Carried forward unchanged: `TL-P14-SEC-01` and `TL-P14-SEC-02` both stay open
with their owners, both still block DDL; the no-early-numbering rule holds;
`OD-P14-09` and `OD-P14-10` stay open and operational; status stays DOCS ONLY
with every gate UNMEASURED.

## §1. The three findings

### FINDING 1 — the fix did not reach the table that is declared authoritative *(defect, mine)*
Amendment 04 derived the resolver's column set in §1 — ten columns, including
`key_id` for the lookup's own `WHERE` clause and `id` for the scope join — and
**did not carry it into the §11.1 grants matrix**, which still listed eight. So
§1 required ten and §11 granted eight, and §11 is the section this request
declares authoritative over any prose.

This is the **same contradiction `P14-AL-30` was written to prevent**, and it
reappeared inside the fix that introduced the §1 table. The lesson is narrower
and more useful than “be careful”: a derivation stated in one section and relied
on in another must be **asserted equal in both directions**, because each list
was independently plausible and nothing compared them. §11.1 now carries the ten
columns, and §14 asserts the two lists equal with a red proof that dropping
either column breaks the resolver.

### FINDING 2 — two documents named different authorities for one route, and the stricter one was right *(defect, mine, a privilege escalation)*
§11.8 mapped `GET /stock` to `catalog.view`; `P14-CONTRACT-PACK.md` and
`P14-OPENAPI-SKELETON.yaml` both said `inventory.view`. **The live code settles
it**: the route carries `@RequiresPermission('inventory.view')`
(`apps/api/src/modules/inventory/inventory-reads.controller.ts:60-61`), so the
two contract documents were right and the table written this morning was wrong.

**It was an escalation, not a typo.** `BUILTIN_ROLE_PERMISSIONS` gives the
**cashier** exactly `['catalog.view']` (`permissions.ts:149`) and grants
`inventory.view` only to manager and owner (`permissions.ts:144`). A key scoped
per that table and delegated by a cashier would have read stock levels **the
cashier cannot read in the application** — the public API granting what the
business permissions deny, which is the single binding law this phase was given.

The part worth keeping is why no existing guard would have caught it: the live
intersection `membership ∩ scopes` is non-empty, because the cashier genuinely
holds `catalog.view`. **A wrong scope→route mapping is not checked by the
intersection; it defines what the intersection is checked against.** So the
mapping itself is now asserted against the live route guard, every document that
names a permission is asserted equal to the others, and each mapping carries a
**negative** test: a key holding only the wrong scope is refused with
`SCOPE_INSUFFICIENT`. New law **`P14-AL-39`**.

**Building that gate turned up something worth stating.** Measured at the
declared base `93084f8`, route authority is carried by **three** mechanisms, not
one: `@RequiresPermission` (Phase 3 inventory, POS till sessions), a *different*
decorator `@phase4Permission` (the Phase 4 selling reads,
`selling/customers.controller.ts:49`), and **tables** rather than decorators —
`OPERATION_AUTHORITY` (`inventory/inventory-authorization.ts:100-103`) and the
frozen POS route tables (`pos/pos-permissions.ts:84-100`,
`pos/pos-cart-routes.ts:150-187`). A grep for
`RequiresPermission('customers.view')` returns **zero** at the base while the
route is properly guarded by the second mechanism. So a decorator-only gate would
report the entire Phase 4 surface as unguarded — a false negative whose obvious
"fix" is to loosen the mapping. `P14-GATE-032` reads all three and fails when an
operation's authority cannot be found in any of them.

A related count was wrong and is corrected: the v1 surface exercises **six**
scopes, not five — the missing `inventory.view` was the sixth. And the surface
set is deliberately **narrower than the registry**: §4 registers twelve scopes as
the vocabulary, six have a published v1 operation, and a registered scope with no
published operation admits nothing. The two counts differ for a stated reason.

### FINDING 3 — replay after a purge was undefined
V3 requires that the effect of replay after a purge be settled, *“so that the
absence of a payload does not turn into a new send or a new execution.”*
Amendment 04 introduced the payload purge and `P14-AL-16` says a replay re-sends
the **stored** projection; once the payload is cleared, nothing connected the
two. Both tempting behaviours are wrong: re-projecting from current state
delivers **today's** truth under yesterday's event id, which is exactly what the
immutable payload exists to prevent, and sending an empty body presents an
absence as an event.

Settled: replay of a purged delivery is **refused** with a new code
`DELIVERY_PAYLOAD_PURGED`; the row keeps attesting that the original delivery
happened; nothing is reconstructed and nothing empty is sent. A consequence
worth stating for whoever sets the window: **the purge window is also the replay
window**, so `OD-P14-09` decides how long replay stays possible — one decision,
not two. New law **`P14-AL-38`**, with red proofs on both wrong behaviours.

## §2. What this run of the review says

V3's two conflicts were **both** in text written this morning, and both are the
same species: a fix that was correct where it was written and not propagated to
the document that depends on it. Findings 1 and 2 are now covered by laws that
assert **equality between sources** rather than correctness of each source, which
is the only form of check that catches this class.

The running count stands at **thirteen** defects found by the owner's reviews
across V1, V2 and V3, against four found by this thread's own review. The
independent challenger has **still never been dispatched**; the pack remains at
**`PREPARED`**, not `CHALLENGED`, and on this evidence that review is owed rather
than optional.

## §3. Task DAG additions

| Task | Deliverable | Owner | Blocker class |
|---|---|---|---|
| `P14-GATE-032` | the authority-agreement gate (`P14-AL-39`): every published operation's permission asserted against the **live route guard**, all three documents asserted equal, and a negative scope test per mapping — the cashier/`/stock` case among them | Phase 14 author | blocks publication of any route |
| `P14-GATE-033` | the cross-section equality gate, **restated (CHALLENGE P1-01)**: for every relation, **every section naming a grant for it** (§1's derivation, the relation's own DDL block, §11's matrix) asserted equal in both directions, the sections found by scanning for grant statements rather than by a named list, red proof on each column | Phase 14 author | blocks the security tier |
| `P14-GATE-034` | replay-after-purge (`P14-AL-38`): refusal with `DELIVERY_PAYLOAD_PURGED`, plus red proofs that re-projection and empty-body sending are both refused | Phase 14 author | blocks the purge operation |

## §4. What is owed

Unchanged from Amendment 04 except that nothing has been added to the owner's
list:

- **Security Owner**: `TL-P14-SEC-01`. **Blocks DDL.**
- **Outbox + Security + Migration owners**: `TL-P14-SEC-02`. **Blocks DDL.**
- **Contract owner**: the intent-field question (Amendment 04 FINDING 3).
- **Migration Owner**: the number, at promotion, after Phase 13 seals.
- **An independent challenger**: never run. See §2.
- **Coordinator**: an actual-diff review; owners for `redis.ts` and the outbox
  `publisher.ts`.
- **Owner, before production and not before review**: rate limits, Phase 5
  pricing, `OD-P14-09` retention — **which is also the replay window** — and
  `OD-P14-10` freshness tolerance.

Nothing architectural waits on the owner today.

---

*`PREPARED / NOT PROMOTED`. Amended 2026-10-12 from `93084f8`. Evidence classes:
`DESIGN ONLY` for everything Phase 14 proposes, `PROVEN IN LIVE CODE` for each
line carrying a `file:line`, `UNMEASURED` for every gate. No timing claim is made
from this container.*
