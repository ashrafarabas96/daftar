# P14 — TASK DAG AND FILE OWNERSHIP
## Phase 14 · Integrations, Public API, Developer Platform

- **Status: `PREPARED / NOT PROMOTED`.** Nothing below is started; every task
  state is `PREPARED`.
- PART 8 shape: every task carries an ID, dependencies, allowed files,
  forbidden shared files, DB impact, accounting risk, security risk, whether a
  migration is needed, the tests required, acceptance conditions, and whether it
  is parallelizable.
- PART 41: every shared/high-risk file has **one** owner; other tasks submit a
  `PATCH-REQ-*` and do not edit it.
- PART 42: each task runs in its own worktree on a branch cut from the Phase 14
  captain branch. No Phase 14 task touches the Phase 4 integration tree.

### ملخص عربي

هذه خطة التنفيذ: **34 مهمة** (٢٥ ثم ثلاث بكل ملحق من ٣ و٤ و٥) مع تبعياتها وملفاتها
المسموحة، و**ستة ملفات
مشتركة** لا يعدّلها أحد مباشرة (تُعدَّل بطلب تعديل `PATCH-REQ`). أقصى تواز مفيد
محسوبًا من التبعيات: **من خمس إلى سبع مهام** في الموجة الأولى، وليس مئة — ثلاث
موجات من ست موقوفة على ملف مشترك أو على ترقيم مالك الـmigrations، والتوجيه نفسه
يمنع «عملًا مصطنعًا لإشغال الوكلاء» (PART 5). لا تحتاج أي مهمة رقم migration قبل
الترقية. ومهمتان (`P14-SEC-026` و`P14-SEC-029`) **مالكهما خارج هذا الخيط
وكلتاهما تمنع كتابة DDL**: حكم مالك الأمن، وحكم مالكي الـoutbox والأمن والهجرات
في ربط التسليم بمصدره. ولا رقم ترحيل قبل ختم القسم 13.

> **Evidence classes (standing law PART E §6).** Every line in this document is
> one of: **PROVEN IN LIVE CODE** — it carries a `file:line` or a migration
> filename read in the tree at `93084f8`; **DESIGN ONLY** — everything proposed
> for Phase 14, which has no implementation; **UNMEASURED** — every gate, test
> and threshold named here, none of which has been executed. No line is PROVEN
> BY TEST or PROVEN BY DATABASE CATALOGUE, because nothing of Phase 14 has been
> run. **No timing or performance number is claimed anywhere in this pack**
> (PART E §5): this container is a different box and a number from it would not
> be comparable.
>
> **Base limitation, stated rather than discovered later:** this pack was read
> from the branch's **remote** head `93084f8`. The Phase 4 coordinator's
> checkpoint of 2026-10-07 records two **unpushed** local commits (`54a851c`,
> `f6f2e0b`) that this thread could not see. Both are Phase 4 receivables work
> (the S4 aging-bucket fix); neither touches any surface Phase 14 binds to —
> the guard, the permission registry, the outbox publisher, the rate limiter or
> the RLS helpers. If that changes, §2 of the architecture lock must be re-read
> against the assembled head before promotion.

---

## §1. Shared files — one owner each (PART 41)

| File | Owner | Why it is shared | How others change it |
|---|---|---|---|
| `packages/domain-core/src/permissions.ts` | Authority Owner | the permission registry of the whole product | `PATCH-REQ-P14-PERM-01`: append exactly two keys + one sensitivity entry, append-only, no reordering (the discipline `permissions.ts:176-196` states for Phase 3/4) |
| `apps/api/src/infra/redis.ts` | Harness/Infra Owner | the `RateLimiter` interface every abuse-protected path uses | `PATCH-REQ-P14-RL-01`: widen `take()` to return the bucket state, preserving the fail-closed contract (`redis.ts:17-23`) byte-for-byte in behaviour |
| `apps/api/src/modules/outbox/publisher.ts` | Outbox Owner | the accepted at-least-once publisher | `PATCH-REQ-P14-OUTBOX-01`: register the fan-out sink through the **existing** `OutboxSink` seam (`publisher.ts:13-15`); the claim/mark/backoff logic is not edited |
| `apps/api/src/common/guards.ts` + `modules/tenancy/tenancy.service.ts` | Authority Owner | the one authorization path | `PATCH-REQ-P14-AUTH-01`: add the delegation narrowing inside `require` and the public credential guard beside `AuthGuard`; the existing guard's behaviour is unchanged for internal routes |
| `infrastructure/database/migrations/*` | **Migration Owner only** | frozen history | `P14-MIGRATION-PATCH-REQUEST.md`; no number is allocated by anyone else |
| `packages/shared-contracts/src/*` | Contracts Owner | shared between API, web and admin | public DTOs land in a **new** `packages/shared-contracts/src/public-api.ts` file; no existing contract file is edited |

## §2. The DAG

Wave = earliest wave the task can start in, given dependencies only.

| ID | Task | Wave | Deps | Files allowed | DB | Acct risk | Sec risk | Migration? | Parallel |
|---|---|---|---|---|---|---|---|---|---|
| `P14-REG-001` | Scope set + the two new permissions (TypeScript) | 1 | — | `PATCH-REQ-P14-PERM-01`, new `packages/domain-core/src/api-scopes.ts` | none | none | **high** (a wrong scope widens every key) | no | yes |
| `P14-REG-002` | Bijection gate: TS scope set ↔ `api_scopes` rows ↔ `PERMISSIONS`, with red proofs on each side | 2 | 001 | new `scripts/phase14-registry-gate.ts` | reads only | none | high | no | yes |
| `P14-KEY-003` | Key material: format/parse `dftr_<id>_<secret>`, digest, constant-time compare | 1 | — | new `apps/api/src/modules/integrations/key-material.ts` | none | none | **high** | no | yes |
| `P14-KEY-004` | Key lifecycle: create, list, revoke; write-once secret; audit rows; **D11 PART 95** — rotation mints a replacement naming its predecessor, overlap only when explicitly requested and audited, revoke now or at a configured timestamp, **no grace window**, **no authorization cache** | 3 | 003, MIG | `modules/integrations/*` | writes `api_keys`, `api_key_scopes`, `audit_events` | none | high | **yes** (patch request) | yes |
| `P14-AUTH-005` | Delegation narrowing in the membership authority + property test over `PERMISSIONS × subsets` + mutation proof | 2 | 001 | `PATCH-REQ-P14-AUTH-01` | none | none | **critical** | no | no (shared file) |
| `P14-AUTH-006` | Public credential guard: resolve key (identity role, no business context), fail-closed on an undeclared route, `X-Business-Id` equality | 3 | 003, 005 | `PATCH-REQ-P14-AUTH-01`, `modules/integrations/*` | reads `api_keys` | none | **critical** | yes (patch request) | no (shared file) |
| `P14-AUTH-007` | Route-enumeration test: every route's surface and credential type (`P14-AL-05`); **D11 PART 93** — also asserts the public guard accepts **no cookie** and that **no decision depends on the hostname** | 4 | 006 | new test only | none | none | critical | no | yes |
| `P14-SURF-008` | Public surface bootstrap: prefix, public DTO file, error mapping, pagination cursor signing | 3 | 005 | new `apps/api/src/modules/public-api/*`, new `packages/shared-contracts/src/public-api.ts` | none | none | medium | no | yes |
| `P14-SURF-009` | Public read endpoints (11 routes, §5 of the contract pack) | 4 | 008 | `modules/public-api/*` | reads via existing services | none | medium | no | yes |
| `P14-SURF-010` | Public write endpoints (3 routes) — adapters only, client-chosen ids | 4 | 008 | `modules/public-api/*` | via existing services | **none by construction** (`P14-AL-09`: no minor unit is touched here) | high | no | yes |
| `P14-RL-011` | Rate limiting: three buckets, headers, fail-closed preserved; **D11 PART 97** — thresholds are configuration with **no production default**, and a startup assertion refuses to launch the production public surface without them | 3 | — | `PATCH-REQ-P14-RL-01`, `modules/public-api/*` | none | none | medium | no | no (shared file) |
| `P14-WH-012` | Event catalogue + per-type projectors + exact-key-set fixtures | 1 | — | new `modules/integrations/webhooks/projectors/*` | none | none | **high** (leak surface) | no | yes |
| `P14-WH-013` | Catalogue roster gate: every emitted outbox `type` is public-with-projector or internal-only, with a red proof | 2 | 012 | new `scripts/phase14-event-catalogue-gate.ts` | none | none | high | no | yes |
| `P14-WH-014` | Fan-out sink inside the publisher's transaction; `(business, endpoint, outbox_event)` uniqueness | 4 | 012, MIG | `PATCH-REQ-P14-OUTBOX-01`, `webhooks/*` | writes `webhook_deliveries` | none | high | yes | no (shared file) |
| `P14-WH-015` | Egress guard, **widened by D11 PART 96**: reject non-HTTPS, **userinfo in the URL**, loopback/private/link-local/CGNAT/ULA/multicast, **IPv4-mapped private IPv6**, **noncanonical numeric literals**, disallowed ports; resolve **all** A/AAAA and validate **all**; dial the validated address with SNI preserved; **revalidate DNS on every attempt**; **bypass env proxy**; no redirects; bounded timeout/size; **DNS-rebinding/TOCTOU tests** | 1 | — | new `webhooks/egress-guard.ts` | none | none | **critical** (SSRF) | no | yes |
| `P14-WH-016` | Signing + the executed verification sample + stale-timestamp rejection; **D11 PART 98** — the event carries its own `version`, distinct from the signature scheme's `v1=` | 2 | — | new `webhooks/signature.ts` | none | none | **critical** | no | yes |
| `P14-WH-017` | Delivery worker: lease claim, `SKIP LOCKED`, backoff, dead-letter, auto-disable on sustained failure | 5 | 014, 015, 016 | `webhooks/*` | updates `webhook_deliveries`, reads endpoints | none | high | yes | yes |
| `P14-WH-018` | Endpoint + delivery management API (internal surface) and replay from the stored projection | 5 | 004, 014 | `modules/integrations/*` | writes endpoints/subscriptions | none | high | yes | yes |
| `P14-IN-019` | Inbound adapter frame: verification seam, dedupe on the fixed triple, audit; **no** provider | 3 | — | new `modules/integrations/inbound/*` | writes `webhook_inbound_events` | none | high | yes | yes |
| `P14-DOC-020` | OpenAPI 3.1 generation from the typed contracts + drift gate + **the `P14-AL-25` seal roster**: generation refuses any path whose owning slice is not recorded as sealed, with a red proof that a `WAITING_FOR_INTEGRATED_SURFACE` path cannot reach the document | 5 | 009, 010 | new `scripts/phase14-openapi.ts`, generated artifact | none | none | **high** (a published path over an unsealed contract is an external promise that cannot be withdrawn) | no | yes |
| `P14-DOC-021` | Developer guides `ar`/`en`/`tr`: auth, rotation, webhook verification, rate limits, errors, versioning | 5 | 016, 020 | `docs/` (new files only) | none | none | low | no | yes |
| `P14-UX-022` | Merchant developer settings: keys, endpoints, deliveries; secret shown once; RTL + three locales; **D11 PART 94 / `P14-AL-27`** — every screen names the member a key is delegated from, and revoking a membership shows which live keys go inert | 5 | 004, 018 | `apps/web/src/app/.../integrations/*` | none | none | medium | no | yes |
| `P14-SEC-023` | Attack matrix: cross-tenant, cross-business pivot, scope escalation, direct-SQL scope insert, secret exposure shapes, key-after-revocation | 6 | 004, 006, 014 | new tests only | reads | none | **critical** | no | yes |
| `P14-PERF-024` | Performance evidence on the dedicated lane: auth-lookup cost, rate-limit overhead, fan-out throughput | 6 | 017 | new perf harness only | reads | none | low | no | **no** (exclusive box, PART 48) |
| `P14-GATE-025` | `gate:phase14` composition — correctness lane only; the performance benchmark is **not** recursively invoked; **`P14-AL-28`** — the proof roster is checked for any write under `infrastructure/database/migrations/`, and such a proof is rewritten, never excepted | 6 | 002, 007, 013, 023 | new `scripts/phase14-gate.ts` | none | none | high | no | yes |

`MIG` = the Migration Owner's allocation from `P14-MIGRATION-PATCH-REQUEST.md`.
Tasks marked `yes` under *Migration?* **cannot start their integration** before
that allocation; their pure logic (001, 003, 012, 015, 016) has no such
dependency and is exactly why those five sit in wave 1.

## §3. Useful safe concurrency (PART 5 / PART 7)

Measured from the dependency graph, not asserted:

| Wave | Tasks | Count |
|---|---|---|
| 1 | 001, 003, 012, 015, 016 *(+ gate scaffolding for 002, 013)* | 5–7 |
| 2 | 002, 005, 013 | 3 |
| 3 | 004, 006, 008, 011, 019 | 5 |
| 4 | 007, 009, 010, 014 | 4 |
| 5 | 017, 018, 020, 021, 022 | 5 |
| 6 | 023, 025 (024 runs **alone** on the exclusive box) | 2 + 1 |

**Maximum useful concurrency for this phase is about 7, not 100.** Three of the
six waves are gated on a shared-file patch request or the migration allocation,
and PART 5 is explicit: *no artificial work to keep agents busy*. Phase 14's
honest parallelism is wide **across** phases, not inside this one.

## §3a. Amendment 01 (§77 of the Final Audited Master Directive)

The publishable surface narrowed on 2026-10-08: five routes and two events moved
to `WAITING_FOR_INTEGRATED_SURFACE` because the slices owning their contracts (P4-S4, P4-S7) are not
sealed. No task is removed or restarted — `P14-SURF-009` and `P14-SURF-010` now
implement the published subset, and the withheld items become later tasks in the
public version that follows each slice's seal. `P14-DOC-020` carries the
enforcement. A hand-written skeleton of the published subset exists as
`P14-OPENAPI-SKELETON.yaml` (8 paths, 9 operations) and is scaffolding only: the
published document is generated (`P14-AL-20`).

## §3b. Amendment 02 (Directive 11, 2026-10-12)

No task added, none removed, none restarted. Seven existing tasks carry new
obligations, marked **D11** in the table above: key rotation without a grace
window and with no authorization cache (004), configured-only rate thresholds
with a startup refusal (011), the widened SSRF list with DNS-rebinding tests
(015), the event version (016), the cookie and hostname negatives (007), the
delegation disclosure (022), and the frozen-history check on the proof roster
(025). `P14-DOC-021` additionally documents the delegation and the replay
handling the directive requires of receiver docs.

## §3c. Amendment 03 (Master Continuous Mission, 2026-10-12)

**Three tasks added, none removed, none restarted** — the non-interruption law
holds, and the Mission's own fixes are spec work that precedes DDL rather than a
re-plan of running work.

| Task | Deliverable | Owner | Predecessor | Reviewer | Blocker class |
|---|---|---|---|---|---|
| `P14-SEC-026` | `TL-P14-SEC-01`: the ruling on the context-free delivery principal, with a non-superuser attack and a planted red proof (`P14-AL-31`, patch request §11a) | **Security Owner**, not this thread | the patch request as amended | Security Owner + coordinator | **blocks DDL** for `webhook_endpoints`, `webhook_subscriptions`, `webhook_deliveries` |
| `P14-GATE-027` | the grants-matrix gate: §11 asserted from `information_schema.role_table_grants` and `role_column_grants` in both directions, red proof each way (`P14-AL-30`) | Phase 14 author | 026 | challenger | blocks the security tier |
| `P14-GATE-028` | the resolver-column gate (`P14-AL-29`) and the no-literal-freshness-tolerance gate (FIX 6) | Phase 14 author | none | challenger | blocks publication of the developer docs |

Four existing tasks carry new obligations, marked **M** where they appear above:
the key lifecycle task owns the single revocation derivation and its four
readers (004); the webhook-endpoint task may not write its DDL before
`P14-SEC-026` (015); the docs task reads the freshness tolerance from
configuration and publishes no literal (021); and the gate composition task
(025) now also composes 027 and 028.

**`P14-SEC-026` is the only task in this DAG whose owner is outside this thread
and which blocks other work.** It is listed first for that reason.

## §3d. Amendment 04 (Master Continuous Mission **V2**, 2026-10-12)

**Three tasks added (029, 030, 031), none removed, none restarted.** V2 records
the six V1 spec fixes as closed and opens eight review findings; six were real
defects in this pack and **four of those were in text written the same morning
while fixing the previous four**.

| Task | Deliverable | Owner | Blocker class |
|---|---|---|---|
| `P14-SEC-029` | §7a: the delivery/source-event ruling — `event_type`, `occurred_at`, the projection authority, and whether `outbox_events` gains a unique constraint in a future owned migration | **Outbox + Security owners, with the Migration Owner** | **blocks `webhook_deliveries` DDL** |
| `P14-GATE-030` | the executed-predicate gate (`P14-AL-33`): boundaries, composed expiry+revocation, server clock, planted red proof on the parenthesisation | Phase 14 author | blocks the security tier |
| `P14-GATE-031` | the insert-privilege gate (`P14-AL-34`): no runtime role inserts a column it may not read, asserted from the catalogue over all eight relations | Phase 14 author | blocks the security tier |

Existing tasks carrying new obligations: the key lifecycle task owns the
corrected predicate and the intent-field trigger (004); the webhook-endpoint and
delivery tasks are now blocked by **two** rulings, not one (015, 016); the docs
task states the purge operation without a duration (021); and the gate
composition task (025) composes 027, 028, 030 and 031.

**`P14-SEC-026` and `P14-SEC-029` are the only tasks whose owners are outside
this thread, and both block DDL.** No migration number may be allocated before
Phase 13 seals, so no task waits on numbering either.

## §3e. Amendment 05 (Master Continuous Mission **V3**, 2026-10-12)

**Three gate tasks added (032, 033, 034), none removed, none restarted.** V3
**accepts** the Amendment 04 corrections and asks for unification and proof
instead: both of its conflicts were fixes that were right where they were written
and not propagated to the document depending on them.

| Task | Deliverable | Owner | Blocker class |
|---|---|---|---|
| `P14-GATE-032` | the authority-agreement gate (`P14-AL-39`): every published operation's permission asserted against the live authority — **all three mechanisms** (`@RequiresPermission`, `@phase4Permission`, and the `OPERATION_AUTHORITY` / POS route tables), failing when an operation's authority is in none of them; the three documents asserted equal; a negative scope test per mapping; and **extended (CHALLENGE R2 P3-09): the assertion runs in an explicitly checked-out `93084f8` worktree**, never against whatever tree the runner has — cited files differ between `6fc505d` and `93084f8` and others do not exist at `6fc505d` at all, as the **generated** table measures — the per-file counts are **not repeated here**: they live only in the generated block in §15 of `P14-MIGRATION-PATCH-REQUEST.md`, because a figure copied into a second document is a typed claim again and `CHALLENGE R4/R5` found this one in four places at once, and a citation read from the wrong tree is a coherent reading of the wrong world rather than a typo (§15); and **`P14-GATE-032` runs `tools/citation-provenance.py --check` on `P14-MIGRATION-PATCH-REQUEST.md`**, which exits `1` when that generated table has drifted from the trees | Phase 14 author | **blocks publication of any route** |
| `P14-GATE-033` | the cross-section equality gate, **restated (CHALLENGE P1-01)**: for every relation in this request, **every section that names a grant for it** — §1's derivation, the relation's own §3-§8 DDL block, and §11's matrix — asserted equal in both directions, enumerated by **scanning the document for grant statements** and never by a named list of sections, with a red proof per column. The earlier scope named §1 and §11.1 only, so the §3 contradiction that refused the whole auth path was outside it and the gate passed while the defect stood. A gate that enumerates its sources by name is blind to the next section added | Phase 14 author | blocks the security tier |
| `P14-GATE-034` | replay-after-purge (`P14-AL-38`): refusal with `DELIVERY_PAYLOAD_PURGED`, red proofs that re-projection and empty-body sending are both refused | Phase 14 author | blocks the purge operation |
| `P14-GATE-035` | the handoff-integrity gate (Directive 11 PART 13, added by `CHALLENGE R4 P2-01` and `R5`): **`tools/manifest-digests.py --check`** and **`tools/citation-provenance.py --check`** both exit `0`, so no digest, byte count or provenance figure in the pack can be a typed claim, a listed artifact can have no file, and an artifact in the shared folder can have no row; and **`proofs/redproof-preflight.sh`** exits `0`, so the run-identity assertions are fenced rather than merely present. The version arm is recorded UNFENCED and the gate does not claim it | Phase 14 author | **blocks any handoff** |

Existing tasks carrying new obligations: the key lifecycle task owns the ten-column
resolver grant (004); the route tasks may publish nothing until 032 passes; the
docs task states that the purge window **is** the replay window (021); and the
gate composition task (025) composes 027, 028, 030, 031, 032, 033 and 034.

## §4. Definition of done per task (PART 38)

No task is `DONE` on code alone. Each needs, as applicable: implementation,
validation and refusals, unit tests, integration tests on a real cluster,
security tests, direct-SQL tests, concurrency tests, browser tests,
localization, responsiveness, the contract/doc update, no placeholder, no debug
code, and no `TODO` hiding required work. A task whose tests are absent is
`NOT DONE`.

Every guard task (002, 007, 013, 023, 025) additionally owes a **red proof**
per law (PART 40): the mutation is shown to have landed in the file **before**
its run is read, and the failure names the specific law — this project has
already recorded a `sed` that matched no line and produced a green that was
read as a pass.

## §5. Review routing (PART 44 / PART 69)

| Class | Tasks | Route |
|---|---|---|
| Security / authority | 005, 006, 007, 015, 016, 023 | author → Captain → security specialist → **independent challenger** → coordinator actual-diff review |
| Data / DDL | the patch request, 004, 014, 017, 019 | author → Captain → Migration Owner → challenger |
| Ordinary | 008, 009, 010, 011, 018, 020, 021, 022 | author → Captain |
| Gates | 002, 013, 025 | author → challenger (the author of a gate may not be its final challenger) |

## §6. States and what would change them

Every task: `PREPARED`. The phase: `PREPARED / NOT PROMOTED`.

`READY_TO_PROMOTE` requires, and currently has none of: Phase 13 PASS; the
Migration Owner's allocation; the gates of §2 **measured** (until then their
status is `UNMEASURED`, never PASS — PART 65); reviews A, B and C (PART 36);
and zero Critical/High findings (PART 37).

---

*`PREPARED / NOT PROMOTED`. Prepared 2026-10-07 from `93084f8`.*
