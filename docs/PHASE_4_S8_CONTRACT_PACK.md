# DAFTAR — PHASE 4 — P4-S8 CONTRACT PACK

**Whole-system hardening. Adversarial by assignment: S8's job is to try to break DAFTAR.**

| | |
|---|---|
| slice | P4-S8 |
| branch | `p4s89/owner` |
| **base SHA** | **`6587460ba3632231e4324c5ce2af92e1589d0705`** |
| base branch | `phase/4-sales-pos-customers-receivables` |
| `git merge-base` with `main` | `6fc505d33b7a6f7a49fa04ee3bc60bb1ddf3b595` (verified, not assumed) |
| maturity delivered | **A–E**: pure logic, ports, test models, surfaces, specifications |
| maturity NOT delivered | real DB binding of the executed halves, the integrated gate, the seal |
| **READY_TO_PROMOTE** | **NO** |

Every assumption below is written so that a diff against the sealed trees can
**confirm or refute it**. An assumption nobody can check is a hope.

---

## 1. What this slice built

| artefact | path | what it is |
|---|---|---|
| the verdict law | `scripts/phase4-s8/verdict.ts` | `Verdict`, `SubjectRequirement`, `evaluateCheck`; the no-fake-PASS law, structural |
| live-tree discovery | `scripts/phase4-s8/tree.ts` | a real SQL scanner, workflow-step parser, `probeSubject` |
| R-SAL framework | `scripts/phase4-s8/reconciliation-framework.ts` | R-SAL-01…07 + 13 discrepancy plants |
| lock order | `scripts/phase4-s8/lock-order.ts` | rank walk with `PERFORM` inlining; forbidden remedies refused |
| deadlock matrix | `scripts/phase4-s8/deadlock-matrix.ts` | 42 ordered pairs over 21 unordered, both directions |
| inventories | `scripts/phase4-s8/inventories.ts` | idempotency, permissions, sources, + the live role-grant arm |
| goldens & browser | `scripts/phase4-s8/golden-and-browser.ts` | completeness, the unit-tree estate, the 16×3×3 matrix |
| RLS estate | `scripts/phase4-s8/rls-estate.ts` | static + **live catalogue** arms |
| performance orchestrator | `scripts/phase4-s8/performance-orchestrator.ts` | builds the plan; **never measures** |
| scenarios | `scripts/phase4-s8/scenarios.ts` | the 14-stage lifecycle, the 7-step isolation path |
| registry + runner | `scripts/phase4-s8/index.ts`, `run.ts` | 19 checks |
| inventory generator | `scripts/phase4-s8/generate-inventories.ts` | `--check` compares the documents against the live tree |

### Measured from the live tree at the base SHA

87 migrations · 123 relations · 1226 columns · 455 constraints · 359 policies ·
294 routines · 17 accounting source types · 10 stock source types ·
36 operation kinds · 58 permissions (30 sensitive) · 368 suites ·
72 workflow steps · 70 npm scripts · 14 Phase 4 relations.

### Current verdict

```
FAIL: 3 of 19 check(s) refuse this tree (11 pass, 5 waiting for an integrated surface)
```

That it is **FAIL and not green** is the point. A gate that has never been
proven able to be RED is not a gate.

---

## 2. The no-fake-PASS law

> Where a downstream relation is not yet real, the status of a check is exactly
> `WAITING_FOR_INTEGRATED_SURFACE`. **NEVER a fake PASS.**

Encoded **structurally**, not by convention: `evaluateCheck` resolves every
declared subject FIRST and **does not call `evaluate` at all** while any subject
is missing. Proved by a check whose `evaluate` throws
(`tests/guards/p4s89-waiting-status-law.test.ts`). A subject-less check is
refused as a FAIL of the framework, because it would otherwise be evaluated
unconditionally and pass vacuously —
`[[daftar-an-empty-collection-is-never-a-refusal]]`.

### Checks reporting `WAITING_FOR_INTEGRATED_SURFACE`, and why

| check | missing subject | owed by | why it cannot be asked |
|---|---|---|---|
| `rsal-in-product-reconciler` | `packages/accounting/src/reconciliation.ts#SALES_RECONCILIATION_CHECK_IDS` | P4-S8 (post-S5) | until the ids are in the product reconciler, no R-SAL identity is computed anywhere |
| `deadlock-matrix-execution` | `credit_notes`, `refunds`, `payment_reversals`, `installments` | P4-S5/S6/S7 | a pair needs BOTH commands real; a matrix over absent routines is an empty matrix |
| `idempotency-provider-reference` | the `provider_reference` column | the migration owner | the column exists nowhere in the 87 migrations (PATCH-REQ-S8-006) |
| `lifecycle-scenario-execution` | `credit_notes`, `refunds`, `payment_reversals`, `installments` | P4-S5/S6/S7 | stages 8–12 cannot be performed, so the books cannot be checked after them |
| `isolation-scenario-execution` | `refunds` | P4-S5 | iso-06 attempts a cross-business refund; with no relation the attempt cannot be made, and a pass would mean only that nothing happened |

---

## 3. The three real findings, routed and NOT fixed

| finding | routed to | patch request |
|---|---|---|
| `customers` locked AFTER `invoices` in `customer_collect_payment` / `customer_apply_credit`, against `P4-AL-41`'s declared rank | **P4-S4** / the architecture-lock owner | PATCH-REQ-S8-002 |
| G-14 and G-15 declared, owner SHIPPED, absent from `tests/golden-regression/phase4*` | **P4-S4** | PATCH-REQ-S8-003 |
| four registered `p4-pos-*` browser steps named by none of `P4-AL-68`'s sixteen | the architecture-lock owner | PATCH-REQ-S8-004 |

S8 chose none of the readings in any of the three. Picking the reading would
make the checker agree with whichever answer its author preferred, which is not
a check.

---

## 4. Red proofs — every major invariant has a passing case, a planted defect and the expected red

| law | red proof | what it plants |
|---|---|---|
| R-SAL contract | `p4s89-framework-laws::the R-SAL contract refuses a check whose plant mutates a relation it never reads` | a mutated copy of the real table: the plant touches `journal_lines`, the check's relation list no longer reads it |
| deadlock matrix | `::the deadlock matrix refuses a pair run in only one direction` | the reverse run of one real pair deleted |
| idempotency | `::the idempotency inventory names a replay path whose registry read follows its first change` | `registryBeforeState` flipped on a real discovered row |
| source inventory | `::the source inventory names a registry row whose name appears nowhere but its own INSERT` | a real row with `hasWriter: false` |
| golden completeness | `::golden completeness names a declared golden whose shipped owner left it unreferenced` | P4-S5 declared shipped while its goldens are absent |
| unit-tree estate | `::the unit-tree estate check names the ordering when npm test moves after the database steps` | a real extra `bootstrap:db-roles` step inserted before `npm test` in a copy of `ci.yml` |
| browser matrix | `::the browser matrix refuses a PHASE4_STEPS entry that collides with a Phase 3 step` | `'return'` added to `PHASE4_STEPS` in a copy of `flows.ts` |
| budgets | `::the budget plan refuses a ceiling increase, a p95 to p90 change and a reduced sample` | all **seven** forbidden mutations |
| orchestrator | `::the orchestrator refuses an unattested box and a relaxed ceiling` | no attestation; `analyzePerformed: false`; every ceiling doubled |
| lifecycle | `::the lifecycle refuses a stage order that is not the required fourteen` | a stage dropped; two `order` fields swapped |
| isolation | `::the isolation path refuses a second-business arm that only drives the API` | every second-business step's `layer` set to `api` |
| **RLS estate (LIVE)** | `p4s8-red-proofs::the RLS estate checker names a REAL planted relation with FORCE missing and three policies` | **a real table** in a real scratch database: RLS enabled, FORCE absent, 3 of 4 RESTRICTIVE policies; dropped afterwards |
| **lock order (LIVE)** | `p4s8-red-proofs::the lock-order checker names a REAL planted routine that inverts the declared order` | **a real `plpgsql` function** locking `invoice_sequences` then `invoices`; read from `pg_proc.prosrc`; dropped afterwards |
| **permissions (LIVE)** | `p4s8-red-proofs::the permission inventory names a REAL planted cashier -> sales.void grant` | **a real `role_permissions` row** against a real business and a real role keyed `cashier`, through the real composite FK; deleted afterwards |

The three LIVE proofs plant a real subject because their checkers never look at
files: a mutated file would prove nothing about them. A plant of a **fictional**
subject asserts "no finding", which is the opposite of its intent.

No lexical-only pseudo-proof was used where semantic evaluation was possible:
the RLS estate is read from `pg_class`/`pg_policy`, the lock order from
`pg_proc.prosrc` (which matters — `0085` re-defines `customer_collect_payment`,
so a checker reading the migration text could be judging a body that no longer
exists), and the grant from `role_permissions` joined to `business_roles`.

---

## 5. The expected surface, stated so a diff can refute it

### Relations S8 assumes will exist (owner in brackets)

`credit_notes`, `credit_note_items` [S5] · `refunds` [S5] ·
`payment_reversals`, `allocation_reversals` [S6] · `installment_plans`,
`installments` [S7].

Already real and assumed stable: `sales`, `sale_items`, `invoices`,
`payments`, `payment_allocations`, `customer_credits`,
`customer_credit_applications`, `invoice_sequences`, `pos_till_sessions`,
`customers`, `products`, `businesses`, `journal_entries`, `journal_lines`,
`stock_ledger`, `audit_events`, `outbox_events`, `role_permissions`,
`business_roles`.

### Columns and constraints assumed

- `invoices.tax_minor` with `invoices_tax_policy_absent_ck CHECK (tax_minor = 0)` (`0075:261`) — **confirmed present**.
- `invoices_customer_uq` (`0082:151`) and the composite FKs at `0082:217/225` — **confirmed present**.
- a `*intent_sha256` column on every idempotent document — **confirmed, 24 keys**.
- `provider_reference` — **REFUTED: exists nowhere.** PATCH-REQ-S8-006.

### Accounts (from `0040:44-67`, confirmed)

1000 cash · 1010 bank · 1100 AR · 1200 inventory · 2000 AP · 2100 tax payable ·
2200 refund liability · 2210 credit liability · 4000 revenue · 4100 returns ·
4200 discounts · 4900 fx gain · 5000 COGS · 6100 rounding · 6900 fx loss.

### Permissions

12 Phase 4 keys (`P4-AL-36/37`); 58 total, 30 sensitive. `OD-P4-01` OPTION A:
**no sensitive Phase 4 key is a built-in default of any role but the owner**.
Measured: 0 findings. `role.assign` is sensitive AND a manager default — an
accepted **Phase 1** classification, recorded by `inheritedSensitiveDefaults`
and deliberately not counted as this slice's finding, because `OD-P4-01` does
not reach it and reporting it would be an over-claim against a sealed decision.

### Lock order (`P4-AL-41`, `P4-AL-32`)

9 declared domains; `payments`, `credit_notes`, `customer_credits` and `refunds`
share rank 4; **`invoice_sequences` is last, always**. The walk inlines
`PERFORM helper(...)` at the call offset (`sale_commit` reaches `products`
through `sale_lock_commit_targets`), and an **uncovered helper is reported,
never skipped** — a gap in the walk that produced "no problem" would be the
vacuous pass on the one question asked.

### Transaction boundary (`P4-AL-48` / `48(a)`)

The effect audit is written in the **same** transaction as the effect. A
**refusal** audit is written in its **own** transaction, because the refusing
transaction rolls back and would take the record of the refusal with it.

### RLS (`P4-AL-38`, `TL-P4-S1-C2`)

ENABLE **and** FORCE on every Phase 4 relation; 6 policies for an ordinary
relation, **7** for an accounting-source relation — the seventh being
`accounting_validator`, without which the deferred completeness validator reads
ZERO rows under FORCE and passes **vacuously**. Measured: 14 Phase 4 relations,
all ENABLE+FORCE, 7 with 7 policies, 7 with 6 — **0 problems**, which is the
passing case the live red proof is contrasted against.

### Performance (`P4-AL-71`…`76`)

8 budgets + P4-R; p95; 30 iterations; a host-independent ratio per budget; a
`planningStatistics` null **fails** the suite; measured as `daftar_app` with the
scope GUCs a request sets, and again as the owner on the same rows to record the
**RLS cost only**.

---

## 6. The performance box — what S8 did NOT do

**S8 built the orchestrator. S8 ran no benchmark.**

An authoritative measurement requires exclusive use of the container, and five
other agents were running. `orchestrate(null, tier)` returns
`INVALID_RESOURCE_CONTENTION` — **the exact words** — with **no steps**, because
a plan handed back is a plan somebody runs. The verdict is a name for a state
that is *neither a pass nor a fail*, so it can be recorded rather than rounded
to one of the two.

Two recorded lessons are encoded as refusals, not comments:

- `analyzePerformed: false` ⇒ `INVALID_RESOURCE_CONTENTION`, naming the measured
  fact: **2.9 s on a runner, 122 ms after one ANALYZE, same query**. A budget
  measured against a table with no statistics is a number about the missing
  statistics.
- The seven forbidden mutations are refused by comparison against
  `DECLARED_THRESHOLDS`, an **independent second copy** of the numbers. Added
  because the first version of `budgetPlanProblems` accepted a table whose every
  ceiling had been **doubled** — a test found it by asking. The honest weakness
  is recorded rather than claimed away: one commit could change both copies.
  `scripts/phase4-budget-ratchet.ts` keeps a third, with the same weakness.

---

## 7. Inventories — generated from the live tree, never hand-written

| document | rows | findings |
|---|---|---|
| `docs/PHASE_4_S8_IDEMPOTENCY_INVENTORY.md` | **24** keys (20 advisory, 2 row, 2 physical; 1 bare) | **0** |
| `docs/PHASE_4_S8_PERMISSION_INVENTORY.md` | **58** permissions (30 sensitive) | **0** |
| `docs/PHASE_4_S8_SOURCE_INVENTORY.md` | **63** registry rows | **0** |

Each stamped with the commit it was generated from, and
`generate-inventories.ts --check` reports **PASS: all 3 inventory documents
agree with the live tree**. The discovery **rule** is stated in the code beside
each inventory so it can be refuted — several rules were tightened after their
first version reported accepted, sealed code as defective, on the principle that
a rule which does that destroys the inventory's credibility, while a rule
reporting fewer rows than exist is the dangerous direction.

Each idempotency row records: the identity, the intent hash column, the identity
guard mechanism, **what exact replay returns**, and **what a changed intent
conflicts on**. All 24 resolve a conflict refusal code.

---

## 8. Prohibited assumptions — things S8 may NOT assume

1. That a check with no subject can be evaluated. Refused.
2. That an empty collection is a refusal. It is a FAIL of the framework.
3. That a green exit status means anything before a canary has proved one can be
   non-zero. DAFTAR's runner once exited 0 over four failing tests and hid them.
4. That a verdict may be read from a free-text body. The SQLSTATE classifier
   matched its pattern inside a random request id about one run in four
   thousand. `readVerdictField` / `readSqlstateField` read only from fields that
   **name** what they hold; `refuseBlobClassification` refuses a string.
5. That a deadlock may be answered by `deadlock_timeout`, a retry loop, or
   treating it as a business outcome. All three refused by name.
6. That an idempotency key is permission. It is not: a replay path must prove
   WHICH command it is replaying before it answers "success", and must consult
   that proof BEFORE it reads current state.
7. That a migration number may be allocated here. It may not.
8. That the lifecycle may skip a stage, or that `ap` and `reconciliation` are
   gaps. They are **named exemptions** with stated reasons, and the exemption
   itself is checked so it cannot quietly grow.
9. That timing may substitute for an injected interleaving (`P4-AL-42`). The
   barriers are `advisory-park` and `pg-locks-observed`; `pg_sleep`,
   `setTimeout` and sleep helpers are refused.

---

## 9. Test hooks and integration seams

- `--root=<dir>` on both runners: the whole framework can be pointed at a copy
  of the tree. Every tree-based red proof uses it.
- `probeSubject` is the single seam between "is it real" and "is it correct".
- `LIVE_RELATION_SQL`, `LIVE_POLICY_SQL`, `LIVE_ROLE_GRANT_SQL`: the live arms,
  so a checker is not left reading the file that asked.
- `ExitStatusProof` / `exitStatusProofProblems`: the canary as a **value a
  caller must produce**, not a comment.
- `ExclusiveBoxAttestation`: every field is something the attester asserts about
  the machine, not something the module can measure. A process cannot prove it
  is alone on a box, and a check that pretended to would be the fake PASS in a
  new costume. What the module CAN do is refuse to measure without it, and
  record the attestation beside every figure.

---

## 10. READY_TO_PROMOTE = **NO**

What would make it YES:

- [ ] P4-S5, P4-S6 and P4-S7 sealed, so the five WAITING checks have subjects.
- [ ] PATCH-REQ-S8-002 resolved — the lock-order reading decided and one side corrected.
- [ ] PATCH-REQ-S8-003 resolved — G-14 and G-15 in the estate, or exempted in the lock.
- [ ] PATCH-REQ-S8-004 resolved — the browser step lists made to intersect.
- [ ] PATCH-REQ-S8-001 landed — `SALES_RECONCILIATION_CHECK_IDS` in the product reconciler and the stale `sales-payment` deferral removed.
- [ ] PATCH-REQ-S8-006 landed — the `provider_reference` partial unique.
- [ ] PATCH-REQ-S8-005 landed — `scripts/phase4-s8-gate.ts`, the npm alias, the `backend` step.
- [ ] The deadlock matrix **EXECUTED**: 42 ordered pairs × 20 iterations, zero deadlocks, zero stale-head commits, deterministic barriers.
- [ ] The 14-stage lifecycle **EXECUTED**, with GL/AR/inventory/COGS/cash/credit/refund-liability/outstanding/source-binding/audit/outbox agreement asserted after **every** stage.
- [ ] The isolation path **EXECUTED** against a real cluster, both arms, the second-business arm reaching SQL.
- [ ] The Tier-1 budgets measured under an exclusive box, every sample kept, `planningStatistics` non-null.
- [ ] `npx tsx scripts/phase4-s8/run.ts` reporting `PASS` with **zero** WAITING — the word `PASS` is printed only when `waiting === 0`.
