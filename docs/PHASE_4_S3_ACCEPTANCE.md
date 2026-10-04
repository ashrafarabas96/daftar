# DAFTAR — P4-S3 Acceptance / قبول الشريحة الثالثة من المرحلة الرابعة

> **What this is.** The freeze page for slice **P4-S3: the POS till session, the server-side cart, and the
> atomic checkout that turns one into a sale** (`docs/PHASE_4_EXECUTION_PLAN.md`). It records the accepted
> candidate, the one migration and the digest it froze at, the Tech Lead's corrective rulings
> `TL-P4-S3-R1` … `TL-P4-S3-R5`, and the boundary the next slice starts from. The evidence for what the
> corrective pass built and proved is `/mnt/project-files/phase4/P4-S3-REPORT-AR.md` and §27 of
> `docs/PHASE_4_ARCHITECTURE_LOCK.md`; this page is the freeze itself.
>
> **ما هذه الوثيقة.** صفحة تجميد الشريحة P4-S3: جلسة الصندوق، والسلّة المحفوظة على الخادم، والخروج الذرّي
> الذي يحوّل إحداهما إلى بيع. تُسجّل المرشّح المقبول، والتهجير الواحد وبصمته، وأحكام المراجعة التصحيحية
> الخمسة، والحدّ الذي تبدأ منه الشريحة التالية.

## 0. Status: ACCEPTED AND FROZEN

- **Accepted candidate head:** `f3bf439dff5d12c4d1f3bd4c682d37feca0d8a4a`, branch
  `phase/4-sales-pos-customers-receivables`, PR #6 (**Draft** — not merged).
- **Candidate CI, on that exact SHA:** `DAFTAR CI` **37143557554** (push), **six jobs SUCCESS, attempt 1** —
  `workspaces`, `backend`, `web-admin`, `android`, `hygiene`, `browser`. Inside the required `backend` job,
  step **33** `Phase 4 slice gate — P4-S1`, step **34** `Phase 4 slice gate — P4-S2` and step **35**
  `Phase 4 slice gate — P4-S3` all SUCCESS in that visible order, followed by step **36** the process
  composition guard's planted-defect red proof, step **37** the plan-evidence contract and step **38** the
  plan-evidence target measurement — none carrying `continue-on-error` and none carrying an `if:`.
- **Verdict:** the Tech Lead's long-run engineering directive (2026-10-03 11:38:59Z) — **P4-S3 CHANGES
  REQUIRED, final narrow corrective pass**, whose §26 authorizes this seal once the corrected candidate's
  exact-SHA CI comes back fully green. The five rulings are recorded in
  `docs/PHASE_4_ARCHITECTURE_LOCK.md` §27.
- **The seal commit is documentation and freeze metadata only.** It fills `S3_ACCEPTED` in
  `scripts/phase4-s3-gate.ts` and `PHASE4_S3_PREFIX` / `PHASE4_SLICE_HEADS` in `scripts/phase4-prefix.ts`,
  moves the manifest to `frozenThrough = 0079_phase4_pos_till_sessions_cart.sql` with the one entry
  appended, and deletes the fenced candidate-tense block (P4-AL-61), replacing it with `boundaryProblems`
  in the accepted tense. **No migration file, no product behaviour, no API behaviour, no permission
  behaviour, no RLS policy and no performance threshold changed.**

| migration | SHA-256 | state |
|---|---|---|
| `0079_phase4_pos_till_sessions_cart.sql` | `1dd406985f6800244e0a0d8a14248595330f6995d3e867e483eda6b9affa173f` | FROZEN |

The digest was **recomputed from the file in the accepted candidate tree**, not copied from the candidate
round and not from any document. That distinction is load-bearing here: `0079` CHANGED during the
corrective pass — section `2b` added the two byte-order barcode indexes — so an inherited digest would have
pinned a file that no longer exists. `scripts/check-migration-manifest.ts`, `scripts/phase4-prefix.ts` and
this slice's own gate recompute it independently.

**`0000`–`0079` are now immutable:** no edit, no rename, no reorder, no deletion, no whitespace or comment
edit, no digest rewrite. Every correction from here is a NEW migration beginning at `0080`, and only under
an explicit Tech Lead directive. **80 migrations frozen.**

### 0a. The performance-evidence pass, and the head this seal actually stands on

The candidate above (`f3bf439`) was green on its push run and **red on the pull-request run of the same
tree**, at the P4-S1 gate's replay of Budget A — accepted Phase 2 evidence, not P4-S3 content. P4-S3 was
therefore reported **BLOCKED** with the freeze mechanics already written, and the Tech Lead authorised one
narrow corrective pass (2026-10-04, OPTION A): raise the sample count of the two short percentile budgets
to 200 measured iterations and change nothing else. See `docs/PHASE_4_S3_PERFORMANCE_EVIDENCE.md` for the
method, the prohibitions it honours, and the finding that the percentile itself is the nearest-rank
definition and not an arithmetic error.

- **The head this seal stands on:** `e3039298731c3a4224184a0d958795e113983541`, branch
  `phase/4-sales-pos-customers-receivables`, PR #6 (**Draft** — not merged), `mergeable_state: clean`.
  Two commits separate it from `f3bf439`: the seal metadata itself, the plan-claim generator fix
  (`ee4322c`), and this performance-evidence commit.
- **BOTH runs on that exact SHA, six jobs SUCCESS, attempt 1:** `DAFTAR CI` **37168434225** (push) and
  **37168436641** (pull_request) — `workspaces`, `backend`, `web-admin`, `android`, `hygiene`, `browser`
  in each. Step 33 `P4-S1 GATE: PASS`, step 34 `PASS gate:phase4:s2 … 6 check(s) ok`
  (220 tests, 0 skipped), step 35 `PASS gate:phase4:s3 … 7 check(s) ok` (402 tests, 0 skipped). This is
  the first head on which the pull-request run is green as well, which is what the acceptance required.
- **Budgets A and B at 200 samples, as measured by the P2-S8 gate's own step in each run:**

  | run | budget | iterations | min | p50 | p95 | p99 | max | ceiling | samples over |
  |---|---|---|---|---|---|---|---|---|---|
  | push 37168434225 | A `post()` incl. COMMIT | 200 | 3.738 | 3.982 | **4.566** | 8.326 | 8.423 | 15 | 0 |
  | push 37168434225 | B adjustment endpoint | 200 | 8.404 | 8.995 | **11.524** | 16.831 | 25.320 | 60 | 0 |
  | PR 37168436641 | A `post()` incl. COMMIT | 200 | 3.703 | 4.073 | **6.928** | 8.384 | 9.831 | 15 | 0 |
  | PR 37168436641 | B adjustment endpoint | 200 | 8.412 | 8.952 | **10.961** | 17.015 | 20.099 | 60 | 0 |

  The two budgets are measured seven times per run (once in the P2-S8 gate's own step and six times inside
  the gates step 33 composes). Worst `p95` across all fourteen A measurements: **7.230** of 15. Worst
  across all fourteen B measurements: **11.777** of 60.
- **The slow mode did appear, and the count is what absorbed it.** In two of the seven A repetitions on the
  push run a single sample landed at 16.922 ms and 17.220 ms — above the ceiling — and `p95` stayed at
  4.988 and 4.563, because at n = 200 `p95` is the tenth-worst sample. At n = 30 two such samples are the
  verdict. Nothing was removed to achieve this: `countAboveThreshold` is recorded as 1 in both, the
  complete ordered series is in the log, and `p95` was taken over all 200 samples.

## 1. What the corrective pass closed

| ruling | what was wrong | what closed it |
|---|---|---|
| `TL-P4-S3-R1` | POS checkout committed the sale and consumed the cart as separate acts, so a failure between them could leave a sale with an unconsumed basket, or a cleared basket with no sale. | One transaction owns the whole act: it locks the till session, establishes tenant, business, branch, warehouse, session owner and OPEN status, binds the exact active cart rows by identity and quantity, derives every price, discount and tax from server truth, calls the **existing** accepted sale primitive, then tombstones exactly the rows that sale represents, and verifies the result under those row locks before committing. **No second sale writer, no second COGS path, no second invoice or journal writer** — the only change to `sale-commit.service.ts` is a pure seam extraction, with no arithmetic and no new SQL. `POST /v1/sales` stays generic. Replay proves which command it is replaying as step 0, before reading any state, and never issues "delete all active lines": a line scanned after the accepted checkout stays in the basket. Sixteen permanent tests, deterministic interleaving, no sleeps. |
| `TL-P4-S3-R2` | — | The existing per-line discount grain was ACCEPTED as it stands. No cart-wide or order-wide discount exists in Phase 4 and no proportional distribution was introduced. Where two scans of one product merge into the one sale line the stock writer permits, their quantities and their discount REQUESTS are summed as exact integers; no money is computed outside the sale writer. |
| `TL-P4-S3-R3` | — | The closed owned cart read was ACCEPTED: read only, the authenticated session owner only, another user's closed session unreadable, and an access refusal is a refusal rather than an empty cart. |
| `TL-P4-S3-R4` | Plan-shape gates were measured on the embedded test cluster, whose collation is `C`. PostgreSQL derives a prefix range from `^@` only on a byte-order collation and recognises exactly `C` and `POSIX` — so the till's scanner path had **no index range at all** on the deployment target, and the gate that existed to catch that was green for months. | Every plan-shape assertion is now DISCOVERED from the tree (41 plan gates across 37 files, machine-readable at `docs/plan-evidence/plan-claim-inventory.json`) and every one of them was re-executed against a PostgreSQL 16 cluster initialised like the deployment target: **all pass**. No regression, no invalid historical claim, no missing product index, no test correction — and no plan assertion was deleted, lowered, or turned into "the query succeeded". The contract gates on the collation **property**, never on a spelling, because one glibc locale has two spellings and a literal match would reject the very environment it describes. The required job now also MEASURES its own `postgres:16` service and prints the measurement: `server_version_num=160015 datcollate=en_US.utf8 datctype=en_US.utf8 provider=c byteOrder=false`. The product fix is `0079`'s two `COLLATE "C"` partial indexes. |
| `TL-P4-S3-R5` | The process composition guard was one-directional: it could see a controller in production that no test composition reached, but not a controller attached to the wrong process, and not one attached to nothing at all. | The law is bidirectional and established by **module reflection, by constructor identity** — every membership question is `Set.has(constructor)`; names are used only for diagnostics. Source scanning only enumerates candidates, deliberately over-inclusively, and controller-hood is settled by Nest's own `PATH_METADATA` via `getOwnMetadata`, so no import statement and no regex can satisfy the check and no test fixture is ever counted. A planted unattached controller and a planted wrong-process controller are each proved RED in the real tree by a required CI step, which also requires the tree to be green before and after and each red to NAME the planted defect. |

## 2. The boundary this slice leaves

- `frozenThrough` = `0079_phase4_pos_till_sessions_cart.sql`; **80** migrations; `0000`–`0079` immutable;
  the next migration is `0080`.
- `PHASE4_SLICE_HEADS` records `P4-S1` → `0076`, `P4-S2` → `0078`, `P4-S3` → `0079`.
- `gate:phase4:s3` is in the accepted tense: seven checks, the candidate fence deleted, `boundaryProblems`
  asserting the file against its accepted digest in three independent readers.
- **Still open, and deliberately not closed by this slice:** `OD-03` (purchase tax; non-zero is refused and
  structurally zero stands — no tax law was researched and no VAT rule inferred), and the
  `credit_note` / `document_kind` question, which the directive's §18 rules is **owned by P4-S5**.
- **Carried into P4-S4 as a named item, not as technical debt:** a cash-settled invoice to a named customer
  reports an outstanding receivable the ledger never carried, because the invoice is written `open` and
  `invoice_outstanding` keys on status alone while the posting debits cash. P4-S4 is the slice that owns
  what "outstanding" means, its fix is a new migration rather than an edit to anything frozen here, and
  nothing merges before it lands.
- `TL-P4-S1-R2` (the RLS `ENABLE`/`FORCE` law) is **DISCHARGED** by P4-S2; its guard is Phase-4 scoped by
  intent and is not to be widened into a tree-wide law that would fail accepted non-commercial relations.
