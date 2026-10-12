# P14-HANDOFF-MANIFEST.md
## Phase 14 — Integrations, Public API, Developer Platform

Required by Directive 11 **PART 13** (handoff integrity, a required gate) and
**PART 90** (create a canonical handoff manifest). Written 2026-10-12.

> **PART 13's rule was followed before anything was written:** *“absent
> companion doc in zip ≠ work never existed.”* Every artifact PART 90 listed as
> missing was **searched for and found** in the shared project folder, and
> **nothing was recreated**. The hashes below are of the live files.

### ملخص عربي

هذا **سجل التسليم** الذي طلبه التوجيه: المرحلة، وSHA الأساس، والفرع، والحالة،
وكل مُخرَج بمكانه وبصمته، وحالة المراجعة، والعوائق. **لا مخرَج مفقودًا**، ولا
شيء أُعيد إنشاؤه فوق موجود، ولا نسخة مكرّرة في مجلد المشروع.

---

## 1. Identity

| | |
|---|---|
| Phase | 14 — Integrations, Public API, Developer Platform (roadmap PARTs 90–100 of Directive 11) |
| Status | **`PREPARED` · `CHALLENGED` · `NOT PROMOTED`** · **DOCS ONLY** · **ALL GATES UNMEASURED** (43 law proofs executed; no gate measured) |
| `READY_TO_PROMOTE` | **NO** — Phase 13 is not PASS, and promotion is serial (PART 4) |
| Exact prep base SHA | `93084f8` (remote head of `phase/4-sales-pos-customers-receivables`, read 2026-10-07 and re-verified 2026-10-12) |
| `origin/main` at preparation | `6fc505d` |
| Prep branch | `claude/phase14-prep-1zqgj8`, cut from the base above |
| Commits on it | **none** — every deliverable is a document in the shared project folder |
| Worktree | isolated, created in this session's scratch area; clean; no commit, no push, no force, no rewrite (PART 12 permits a preservation push but an empty branch preserves nothing) |
| Tree actually checked out | **`6fc505d`**, of which `93084f8` is a **descendant** — so the checked-out tree is *behind* the declared base, and **the declared base is not in the history of the commit carrying this pack** (`git merge-base --is-ancestor 93084f8 <head>` fails). **Some cited files differ between the two trees and others do not exist at `6fc505d` at all; the counts are GENERATED and this row deliberately does not repeat them** — they are in the generated block in §15 of `P14-MIGRATION-PATCH-REQUEST.md`, produced by `tools/citation-provenance.py`, whose `--check` mode `P14-GATE-032` runs. This row used to carry “six of fourteen” from a hand-kept list, and `CHALLENGE R5` found the wrong figure in **four documents at once**: a count copied out of its generator is a typed claim wherever it lands. Earlier revisions also said *every cited frozen migration is byte-identical at both*, which is **false**: `0076`, `0079` and `0086` are absent at `6fc505d`. The conclusion still holds for the stated reason that every migration cited **for an RLS policy, a grant or a role** is byte-identical at both, and the three absent ones are cited only for Phase 4 surface facts. The full table, the reason neither remediation is taken, and why this is the **root cause** of the round-1 cashier finding rather than a footnote: **§15 of `P14-MIGRATION-PATCH-REQUEST.md`** (CHALLENGE R2 P3-09). Stated rather than silently fixed since `P14-AMENDMENT-03` §2a |
| Code written | **none.** No file under `apps/`, `packages/`, `scripts/` or `infrastructure/` was created or modified by this thread |
| Migration numbering | **none allocated, and none may be, before promotion.** Mission V2 §14 explicitly overrides this pack's own sentence that allowed early allocation: preparation carries no number, and Phase 14 is numbered only after Phase 13 seals |
| Migration impact | **none allocated.** `frozenThrough = 0079_phase4_pos_till_sessions_cart.sql` untouched; `0080`–`0086` candidates untouched; no number, filename or example proposed (PART 6) |

## 2. Artifacts — location, hash, state

All **25** live at **`/mnt/project-files/phase14/`** — the shared project folder,
which outlives this container. All are **uncommitted / off-Git**, so PART 13's
SHA256 requirement applies to every row. **Regenerated, not patched**, after the
Master Continuous Mission **V3** amendment of 2026-10-12: every hash below was computed
from the file as it now stands, so a stale digest cannot survive an edit.

**The hash and byte cells of this table are GENERATED**, by
`tools/manifest-digests.py`, whose `--check` mode exits `1` when any cell is
stale, when a listed artifact has no file, or when an artifact in the folder has
no row. They used to be typed, and a typed digest is a claim: `CHALLENGE P3-07`
already found a correct hash in this table beside a wrong description, which a
reader checking the hash would have concluded was verified. The descriptions are
still written by hand, deliberately — a description is a judgement, not a
measurement.

| Artifact | What it is | SHA256 | Bytes |
|---|---|---|---|
| `P14-AMENDMENT-01-SEALED-CONTRACTS.md` | Amendment 01 (§77): law P14-AL-25; narrows the first public version to sealed contracts; measured seal table | `8174a5c30753b02290d6324a06d982c984ee65ff429c0bb0c9dba40b83fbaa10` | 8,705 |
| `P14-AMENDMENT-02-DIRECTIVE-11.md` | Amendment 02 (Directive 11 PARTs 90-100): 4 rulings adopted, 5 corrections applied, 3 new laws, the 8 decisions reconciled, artifact recovery record | `6211a47034bf778a646f19573fe96a80467c6ac917c4bf34e5d0263fd6ec4edc` | 18,560 |
| `P14-AMENDMENT-03-CONTINUOUS-MISSION.md` | Amendment 03 (Master Continuous Mission, Phases 4-15): the 6 spec fixes required before DDL, 4 of them real defects in this pack; 4 new laws; the measured 0014/0020 precedent; the base-tree discrepancy; 3 added tasks; ruling TL-P14-SEC-01 routed to the Security Owner | `87112ede9ce71e96b5f949f27d044d6c75b2162812137e0006f2a6e15feecb9f` | 14,692 |
| `P14-AMENDMENT-04-MISSION-V2.md` | Amendment 04 (Master Continuous Mission V2): the six V1 fixes confirmed closed; 8 new review findings, 6 of them real defects here and 4 of those written the same morning; 5 new laws (AL-33…37); ruling TL-P14-SEC-02 on the delivery/source link; early migration numbering withdrawn | `c76296e0ce59856292f5fa5b085ca731867b66253485bd7dc9ef32ceb3a3646f` | 12,050 |
| `P14-AMENDMENT-05-MISSION-V3.md` | Amendment 05 (Master Continuous Mission V3): the Amendment 04 fixes accepted; 3 findings — the grants matrix not receiving §1’s ten columns, GET /stock mapped to a LOWER permission than the live guard requires (a cashier privilege escalation), and replay after purge undefined; 2 new laws (AL-38, AL-39); 3 gate tasks | `f231eb915245a4754a26b7c4bdc2b9d66076323f591391d2519de89a02053a82` | 9,831 |
| `P14-CONTRACT-PACK.md` | Public API contract: routes with owning slice and publication state, headers, refusal codes, pagination, webhook event catalogue and receiver contract (freshness tolerance now configured, not a literal) | `aee22cf0efa111d799ace38382ddbfcf4fbae2848348aaa9018422ee53c681a3` | 17,003 |
| `P14-MIGRATION-PATCH-REQUEST.md` | MIGRATION PATCH REQUEST: 8 new relations, columns, CHECKs, keys, indexes, RLS policies, the per-relation/per-operation grants matrix (§11), the Security Owner ruling request (§11a), the attack matrix (§11b), triggers, tests. NO number, NO filename, NO example | `ff52fb708f5b2ec19c61e9a55def3b8fc941271508f4bfae0a5de0b1a64110e9` | 110,146 |
| `P14-OPEN-DECISIONS-AR.md` | The decisions (Arabic): the original 8 all settled, plus OD-P14-09 (retention), OD-P14-10 (signature freshness tolerance) and OD-P14-11 (the last_used_at write interval, added by CHALLENGE P2-04) — operational, blocking production launch and not review | `86ea1302702e471fbf75e0b0b26bda42812ce9fa6a496245bc46ced6dba2589c` | 22,581 |
| `P14-OPENAPI-SKELETON.yaml` | OpenAPI 3.1 skeleton, 8 paths / 9 operations, published subset only. DESIGN ONLY — the final document is generated | `0e2476dbb7685a608a130c6059227db153fbc7391942bee43ddc0db219b27f5f` | 11,169 |
| `P14-S0-ARCHITECTURE-LOCK.md` | Architecture lock: **39** numbered laws (P14-AL-01…39), verified-fact table, 14-path pre-mortem, done-definition (CHALLENGE P3-07: this row read 32 while the hashed file carried 39 — a correct digest beside a wrong description, which a reader checking the hash would conclude was verified) | `87acc46a5b0b65bf14956457f67786e272973569b95ff10460c1e71b4107623d` | 49,766 |
| `P14-TASK-DAG.md` | 34 tasks with dependencies, allowed files, DB impact, risk, tests, acceptance; shared-file ownership; review routing; honest concurrency ceiling | `2fbc60fbcae4db4768f7e99f23a9bed5b446bb3fae846b83fff61a47d614dc88` | 22,839 |
| `P14-CHALLENGE-2026-10-12.md` | The independent challenge, authored by a session that wrote no part of this pack. Verdict **REJECT**: 1 P1 in the auth path, 3 P2, 3 P3; manifest integrity PASS; 9 executable proofs run on PostgreSQL 16.15 @ en_US.utf8, 9 PASS for the pack. Hashed here as received and **not edited by this thread** | `2ea7bbf6669b865a52149d13177c179c021f3d9657c8a6125c0302b1f7f35ab9` | 26,126 |
| `P14-AMENDMENT-06-INDEPENDENT-CHALLENGE.md` | Amendment 06: the response. All 7 findings re-verified against `93084f8` before any edit and all 7 real; P1-01 settled at EIGHT columns on §1's own derivation rule (the defect was in §1/§11.1, not §3); GATE-033 restated to scan for grant statements rather than name sections; `sales.create` reachability stated; 3 further findings this thread's own execution added. **Does not sign the pack** | `31b791b945f812f22f794591482a09226cbdb70e8912d624df1d33b4d2366a13` | 10,551 |
| `P14-EVIDENCE-2026-10-12.md` | **EXECUTED evidence**, the first in this phase's history: 43 runs with run IDs and exit codes on PostgreSQL 16.15 @ `en_US.utf8` as non-superuser roles, 9 case families C1–C9, red proofs on C1/C2/C3/C9, and the two wrong runs kept rather than deleted. No migration number, no frozen migration touched, no timing claim | `286085920f2a8c8020f8cf4a929c85bafa815a6f0ee76eec06b1693f2315e96f` | 20,000 |
| `P14-CHALLENGE-08d23da.md` | The independent challenge, round 2 at `08d23da`. Verdict **PASS-WITH-SCOPE**: all 7 round-1 findings closed and all 3 of this thread's new findings reproduced, against 1 P1 (the evidence pack was not reproducible — `C8`'s constraint existed in no committed script), 4 P2 and 2 P3. The challenger re-ran all 34 committed cases and re-read `pg_roles` itself. Hashed as received and **not edited by this thread** | `ae87a5cac2d6d1bbd65a00d0fa0d660227ee3373e13095966d08140a5ff524b2` | 25,792 |
| `P14-AMENDMENT-07-CHALLENGE-ROUND-2.md` | Amendment 07: the round-2 response. P1-02 and P2-03 closed **by construction** — the 4 missing mutations are now scripts with proof-of-proof, the case id is derived from the script path, and the evidence is one clean replay; the law citation re-grounded on `P14-AL-29` with its *"to decide usability"* qualifier restored; `TL-P14-SEC-02` repriced to **5** options with (C) corrected from "unavailable" to "not Phase 14's to write" and coupled to `TL-P14-SEC-01`; §11.1a records the unenumerated `INSERT` cell. **Does not sign the pack** | `c87180fef5c09b75bece35eb9058593284c35b163610426c40e5f6eb3fad2dcb` | 13,532 |
| `P14-CHALLENGE-6f744c1.md` | The independent challenge, round 3. Verdict **PASS-WITH-SCOPE, narrower than round 2**: every round-2 item closed by construction and all 43 exit codes reproduced when the harness is driven as designed, against 2 P2 and 2 P3 — the committed replay recipe exited 127 on all four red proofs, and the whole C7 family (all of `TL-P14-SEC-02`'s evidence) had an undeclared dependency on C3. It also **retracts** one claim of its own round-2 report. Hashed as received and **not edited by this thread** | `90fce1db02222d55c28d8c20b66aba6d6b76fc75f9037bb4641c09644d1a3ae5` | 19,539 |
| `P14-AMENDMENT-08-CHALLENGE-ROUND-3.md` | Amendment 08: the round-3 response. The replay recipe is now **committed code** (`proofs/replay.sh`) that enforces the verdict, rather than prose that drifted from the driver actually used; every cross-family prerequisite is declared in its script's header and asserted with `to_regclass`; the evidence column list is corrected and duplicated beside the `printf` that writes it; §11.1a option (ii) is recorded as **unimplementable** in PG 16 (`NOT NULL`/`CHECK` cannot be `DEFERRABLE`; only a deferred constraint trigger can). **Does not sign the pack** | `8a65dd96f10dcc520ab95dd797faf3ac235d35ab9064a6ab359345f58cd3e11e` | 7,207 |
| `P14-CHALLENGE-fcb85f8.md` | The independent challenge, round 4 at `fcb85f8`. Verdict **REJECT**, on the pack's own disclosure rather than its engineering: §15's base-tree table and its “six of fourteen” count were typed from a hand-kept list, the per-citation provenance claim was wider than what the pack does, the *every cited frozen migration is byte-identical* sentence was false, and two citations were bare basenames resolving to several files. Hashed as received and **not edited by this thread** | `6c1ca856fb94c70a112c54e31a8df3a5e1c29e5b8e90fc37cec4527735ae6e5e` | 11,608 |
| `P14-CHALLENGE-23b24ca.md` | The independent challenge, round 5 at `23b24ca`. Verdict **PASS-WITH-SCOPE**: both round-3 findings closed **by execution** (43 cases, 0 off their required exit code, the preflight red proof reproduced), against 1 P2 and 3 P3 — the only documented one-family command could not exit 0 in any state of the database, and in the state a reader is actually in it printed `FINDING REFUTED` about the live `TL-P14-SEC-02` ruling from a leftover `GRANT`. Hashed as received and **not edited by this thread** | `8d910bb71f13b1bb35a5ec78a36c70f3853c2dba260383ab6e43dc96ef214ca6` | 12,997 |
| `P14-AMENDMENT-09-CHALLENGE-ROUNDS-4-5.md` | Amendment 09: the rounds 4 and 5 response. §15's table is **generated** by `tools/citation-provenance.py` (the counts are in the generated block itself, not copied here) and gated by its `--check`; the per-citation claim restated to the one declared base the pack actually has; the frozen-migration sentence corrected to name `0076`/`0079`/`0086` with the RLS-citation conclusion preserved and its reason stated; the filtered replay now takes the one unconditional setup path and `c7c` asserts the **absence** it requires, so a leftover grant can no longer print a verdict; the preflight red-proofed on 5 of its 6 arms by a committed script, the version arm recorded as UNFENCED; the orphan `c7a_cross_business_accepted.sql` deleted. Records that the generator's own first run mis-measured. **Does not sign the pack** | `f6a546de54d0b0fc63acd90d944dc7c7e141a56e498f2527187ef97f9c3bec56` | 11,871 |
| `P14-CHALLENGE-2430504.md` | The independent challenge, round 6 at `2430504`. Verdict **PASS-WITH-SCOPE**: all eight reported exit codes reproduced on the challenger's own cluster, 22/22 manifest rows re-verified, and **both new `--check` gates red-proofed by the challenger itself** (a corrupted digest and a flipped provenance row each exit 1). Against 1 P2 and 3 P3 — chiefly that the freeze boundary is a FIELD in `MIGRATION_MANIFEST.json`, readable at both trees, so on `6fc505d` it yields `0073` and contradicts rather than being unverifiable; and that `json` sat outside the provenance generator's pattern, so the one cited file whose difference changes a rule appeared in no row. It also **corrects its own round-4 count** and confirms this pack's generated measurement as the right one. Hashed as received and **not edited by this thread** | `eb7a0bd031fbc643c9eae92df554cc23075c53be4cc56aa54aefe6781b087fd1` | 11,798 |
| `P14-CHALLENGE-2430504-ADDENDUM-01.md` | Addendum to round 6: the challenger **WITHDRAWS its own `R5 P3-04`** after executing the command it had reported absent. `locale-gen` exists, is on the unprivileged account's `PATH`, and works; the two documents changed on its word are reverted. Kept as a separate file so the round-6 report's digest does not change for anyone who has already hashed it. Hashed as received and **not edited by this thread** | `2b92623339435550e21a33e1955a6c7c153dbc9b3ee61e2859a0932103f08101` | 3,573 |
| `P14-AMENDMENT-10-CHALLENGE-ROUND-6.md` | Amendment 10: the round-6 response. The freeze boundary read at both trees and §15 corrected to **CONTRADICTS at `6fc505d`** (`frozenThrough` = `0073` there), with the admission that the previous sentence was adopted from a reviewer's phrasing instead of measured; the provenance generator widened to ten extensions and made to **print the population it scanned**, its buckets decided by resolution rather than a name pattern, and the wrong law number removed from its generated prose; `c1a`'s control moved **above** its conclusion with the `SQLSTATE` asserted; the typed copies of the provenance counts removed from four documents so the figure exists only in the generated block; and the withdrawn `locale-gen` finding reverted **with its record**. **Does not sign the pack** | `38ad43d229f80b884b68f19ce327a915b3bdbaa99a1b7aa76ccd85dada066cfb` | 8,432 |
| `README-AR.md` | Arabic index of the pack and what needs the owner’s attention | `b203e7fbbdfaf070ce5726cdb5f55cb67a0964da6231f2e22ae6c81f98c6af7e` | 9,576 |

Every row is **present**. No artifact is missing, so this handoff is
**COMPLETE** in PART 13's sense. `P14-HANDOFF-MANIFEST.md` is itself excluded
from the table, because a file cannot carry its own digest.

## 3. The three artifacts PART 90 called missing

| Named | Found at | Verdict |
|---|---|---|
| migration patch request | `P14-MIGRATION-PATCH-REQUEST.md` (row above) | present since 2026-10-07; not recreated |
| open-decisions document | `P14-OPEN-DECISIONS-AR.md` (row above) | present since 2026-10-07; **recovered and reconciled**, not guessed (PART 100) |
| OpenAPI skeleton | `P14-OPENAPI-SKELETON.yaml` (row above) | present since 2026-10-08; DESIGN ONLY (PART 99) |

## 4. Duplicates (PART 14)

A search of `/mnt/project-files/` found **exactly one** amendment-01 file and no
byte-identical duplicate of any artifact in this pack.

- Canonical amendment 01: `/mnt/project-files/phase14/P14-AMENDMENT-01-SEALED-CONTRACTS.md`.
- PART 90 reports three byte-identical amendment copies **in the reviewed zip
  bundle**. This thread cannot see that bundle, so I neither confirm nor deny
  it; what is stated is the canonical location and hash. A bundle rebuilt from
  this folder cannot reproduce the duplication, because there is one file to
  copy.

## 5. Tests and evidence

**No gate has been measured. 43 law proofs HAVE been executed** — see
`P14-EVIDENCE-2026-10-12.md`. The distinction is exact and the earlier wording
erased it (CHALLENGE R2 P2-07): the **gates** are tasks 002/007/013/023/025 and
`P14-GATE-032`/`033`/`034`, and every one of them remains `UNMEASURED`, which is
the correct state for a DOCS-ONLY phase. What was executed is the **laws** the
request states, on scratch objects, with no migration number. The previous
revision said *"nothing has been executed, so nothing is claimed"* on the same
page that describes a 45-run evidence document, and that clause survived an edit
to the sentence beside it. The
gates this phase owes, each with its red-proof obligation, are listed in
`P14-TASK-DAG.md` §2 (tasks 002, 007, 013, 023, 025). No timing or performance
number appears anywhere in the pack (PART 10/16: this container is not the
authoritative box). **Corrected (CHALLENGE P2-04): that sentence was false as
written.** §3 carried *"`last_used_at` is written at most once per key per 5
minutes"* — a chosen write-rate value with no decision record, the identical
species to the `300s` that Mission FIX 6 struck by name, and not harmless: the
interval sets how stale `last_used_at` may be, and `last_used_at` is what a
merchant reads to decide whether a key is still in use and can be revoked. It is
now `OD-P14-11` with no default and a fail-closed startup, and the sentence is
true again. No **measured** timing number has ever appeared and none may.

## 6. Migration patch request

`P14-MIGRATION-PATCH-REQUEST.md`. Eight new relations: `api_scopes`,
`api_keys`, `api_key_scopes`, `webhook_event_types`, `webhook_endpoints`,
`webhook_subscriptions`, `webhook_deliveries`, `webhook_inbound_events`. One
backfill (the two new permission keys onto existing owner roles). Three
triggers. **No `SECURITY DEFINER` function.** Addressed to the **Migration
Owner** and, for the RLS policies and grants, to the **Security Owner**
(PART 80). Not allocated, not numbered, not scheduled.

## 7. Shared-file patch requests (PART 80 / PART 41)

| Request | File | Addressee | State |
|---|---|---|---|
| `PATCH-REQ-P14-PERM-01` | `packages/domain-core/src/permissions.ts` | **Authority Owner** | drafted, not submitted — append two keys (`integrations.view`, `integrations.manage`) and one sensitivity entry, append-only |
| `PATCH-REQ-P14-AUTH-01` | `apps/api/src/common/guards.ts`, `modules/tenancy/tenancy.service.ts` | **Authority Owner** | drafted — the delegation narrowing inside `require`, plus the public credential guard beside `AuthGuard`; internal behaviour unchanged |
| `PATCH-REQ-P14-RL-01` | `apps/api/src/infra/redis.ts` | **owner not named by PART 80** — routed to the Phase 4 coordinator as interim holder | drafted — widen `take()` to return bucket state, preserving the fail-closed contract |
| `PATCH-REQ-P14-OUTBOX-01` | `apps/api/src/modules/outbox/publisher.ts` | **owner not named by PART 80** — same | drafted — register the fan-out sink through the existing `OutboxSink` seam; claim/mark/backoff untouched |

Phase 14 edits none of these files itself, under any circumstance (PART 78: no
future phase bypasses ownership because its work is infrastructure).

## 8. Open decisions

Eight, in `P14-OPEN-DECISIONS-AR.md`, reconciled 2026-10-12 under PART 100:
four **ruled by Directive 11** (PARTs 91–94, each matching this pack's
recommendation), two **resolved autonomously** as technical (`05` no wildcard,
`08` nobody may read a signing secret), one **split** (`06`: the capability seam
is resolved; pricing belongs to Phase 5), one **superseded** (`07`: thresholds
are configuration, and guessing production quotas is forbidden — the proposed
numbers are withdrawn).

The Master Continuous Mission of 2026-10-12 adds **two** operational decisions
and **one** ruling that is not the owner's:

| Item | Subject | Who decides |
|---|---|---|
| `OD-P14-09` | retention of `webhook_deliveries` and `webhook_inbound_events` — no role holds `DELETE` on either, deliberately, and the inbound window **is** the replay-dedupe window | operations, before production launch |
| `OD-P14-10` | the signature freshness tolerance, replacing the withdrawn `300s` | operations, before production launch |
| `TL-P14-SEC-01` | the context-free delivery principal and its RESTRICTIVE-policy exception (`P14-MIGRATION-PATCH-REQUEST.md` §11a) | **Security Owner** — and it **blocks DDL** for three relations |

**Escalated to the owner: nothing architectural.** Four items need a human, and
all before production launch rather than before review: the configured rate limit
**values**, the Phase 5 **pricing** of the public-API capability, and the two
operational decisions above.

## 9. Review state

| | |
|---|---|
| Author | this thread; self-review performed, including re-verification of every `file:line` citation and correction of a wrong count (the permission registry has 58 keys, 30 sensitive — an earlier draft said 82). **Self-review was not sufficient:** the Master Continuous Mission found four defects it had missed (Amendment 03 §2), and the search for their precedent then surfaced a fifth omission — the `businesses` SELECT grant a context-free role needs (`0020:54-58`) |
| Independent Challenger | **NOT DISPATCHED.** PART 100: Phase 14 could not be Challenger-complete before the open-decisions artifact was recovered and reconciled. That reconciliation is done as of 2026-10-12, so the phase is now **eligible** for a challenger |
| Coordinator | **NOT SIGNED** |
| Reviews A / B / C (functional, security, UX) | none; all `UNMEASURED` |

An author does not sign their own work, so nothing here is presented as
accepted.

## 10. Unresolved blockers

| # | Blocker | Class | Owner |
|---|---|---|---|
| 1 | Phase 13 is not PASS; promotion is serial | dependency | programme |
| 2 | Five routes and two events `WAITING_FOR_INTEGRATED_SURFACE` until P4-S4 and P4-S7 seal | dependency | Phase 4 |
| 3 | Migration allocation | process | Migration Owner |
| 4 | Two shared files have **no owner named by PART 80** (`redis.ts`, outbox `publisher.ts`) | ownership gap | needs an owner named |
| 5 | Independent challenger and coordinator review | review | programme |
| 6 | Configured rate-limit values before any production launch | operations | owner / ops |
| 7 | Pricing of the public-API capability | business | Phase 5 |
| 8 | **`TL-P14-SEC-01`**: the context-free delivery principal and its RESTRICTIVE-policy exception. **Blocks DDL** for `webhook_endpoints`, `webhook_subscriptions`, `webhook_deliveries` | security ruling | **Security Owner** |
| 9 | `OD-P14-09` retention and `OD-P14-10` freshness tolerance | operations | owner / ops |
| 10 | **`TL-P14-SEC-02`** (§7a): a delivery row may name another business's source outbox event — the global FK does not constrain it and RLS does not imply it. **Blocks `webhook_deliveries` DDL** | security ruling | **Outbox + Security owners, with the Migration Owner** |
| 11 | The intent-field question of V2 FINDING 3: which fields count as revocation intent, and whether a revoked key's metadata may be edited | contract | contract owner |

Items 1–3 and 5 are the ordinary promotion path; 4 is a gap in the ownership
table, not in the work; 6, 7 and 9 are launch-time inputs; 11 is a product
question. **8 and 10 both stop DDL being written, and both exist because the
Mission found defects in this preparation.**

**Mission V3 (2026-10-12) then accepted the Amendment 04 corrections and found
two conflicts, both in that morning's text and both the same species: a fix that
was right where it was written and was not propagated to the document depending
on it** — the resolver's ten-column derivation never reached the grants matrix
declared authoritative over it, and `GET /stock` was mapped to `catalog.view`
while two other documents and **the live route guard** said `inventory.view`. The
second was a **privilege escalation**: the cashier holds `catalog.view` and not
`inventory.view`, so a cashier-delegated key would have read stock the cashier
cannot read in the app, and the live-authority intersection does not catch it
because the scope the mapping named is one the cashier genuinely holds. V3 also
settled that a purged delivery **refuses** replay rather than re-projecting or
sending empty. Recorded in `P14-AMENDMENT-05-MISSION-V3.md`.

**Mission V2 (2026-10-12) found eight, six of them defects here, and
four of those six in text written the same morning while fixing the first four**
— among them a usability predicate missing its parentheses, which accepted every
never-revoked key however long ago it expired, and an unqualified `INSERT` grant
that would have let the merchant request path mint an API key with a digest and
a subject of its own choosing. Both are recorded in
`P14-AMENDMENT-04-MISSION-V2.md` §1. Across V1, V2 and V3 the owner's reviews have found **thirteen** defects here
against **four** found by this thread's own review; that is the honest state of
this pack's assurance, and the reason the independent challenger is owed rather
than optional.

**This manifest no longer claims that none of its blockers is a defect in this
preparation.** The earlier revision said so of seven blockers, and that was true
of those seven. The Mission then found four real defects here — a resolver
reading a non-existent column, a summary granting what a section denied, an
unsound context-free-worker construction, and a business-scoped relation missing
from the inventory — all four now fixed and recorded in
`P14-AMENDMENT-03-CONTINUOUS-MISSION.md` §2. Three were found by the owner's
reading rather than by this thread's self-review, which is the honest state of
this pack's assurance and the reason the independent challenger in §9 is owed
rather than optional.

---

*`PREPARED / NOT PROMOTED`. Manifest **regenerated** 2026-10-12 after Amendment
03, for base `93084f8`.
Hashes are of the files as they stand at that moment; any later edit changes
them, and the manifest is regenerated rather than patched.*
