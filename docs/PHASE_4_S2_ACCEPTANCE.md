# DAFTAR — P4-S2 Acceptance / قبول الشريحة الثانية من المرحلة الرابعة

> **What this is.** The freeze page for slice **P4-S2: the atomic sale commit primitive and the stock source
> bridge** (`docs/PHASE_4_EXECUTION_PLAN.md`). It records the accepted candidate, the two migrations and the
> digests they froze at, the Tech Lead's corrective rulings `TL-P4-S2-R1` … `TL-P4-S2-R6`, and the boundary
> the next slice starts from. The evidence for what the corrective pass built and proved is
> `/mnt/project-files/phase4/P4-S2-CORRECTIVE-REPORT-AR.md` and the §25 table of
> `docs/PHASE_4_ARCHITECTURE_LOCK.md`; this page is the freeze itself.
>
> **ما هذه الوثيقة.** صفحة تجميد الشريحة P4-S2: أمرُ البيع الذرّي وجسرُ مصدر المخزون. تُسجّل المرشّح المقبول،
> والتهجيرين وبصمتيهما، وقرارات المراجعة التصحيحية الستّة، والحدّ الذي تبدأ منه الشريحة التالية.

## 0. Status: ACCEPTED AND FROZEN

- **Accepted candidate head:** `712eafee9c15daadaeff773a69c73cf5e535c01c`, branch
  `phase/4-sales-pos-customers-receivables`, PR #6 (**Draft** — not merged).
- **Candidate CI, on that exact SHA:** `DAFTAR CI` **36950325428** (push), **six jobs SUCCESS, attempt 1** —
  `workspaces`, `backend`, `web-admin`, `android`, `hygiene`, `browser`. Inside the required `backend` job,
  step **33** `Phase 4 slice gate — P4-S1` SUCCESS and step **34** `Phase 4 slice gate — P4-S2` SUCCESS, in
  that visible order, neither carrying `continue-on-error` and neither carrying an `if:`.
- **Verdict:** the Tech Lead's P4-S2 final corrective directive (2026-10-01 22:46Z) — **CHANGES REQUIRED,
  narrow corrective pass**, whose §18 pre-authorized this seal once the corrected candidate's exact-SHA CI
  came back fully green. The six rulings are recorded in `docs/PHASE_4_ARCHITECTURE_LOCK.md` §25.
- **The seal commit is documentation and freeze metadata only.** It fills `S2_ACCEPTED` in
  `scripts/phase4-s2-gate.ts` and `PHASE4_S2_PREFIX` / `PHASE4_SLICE_HEADS` in `scripts/phase4-prefix.ts`,
  moves the manifest to `frozenThrough = 0078_phase4_sale_commit.sql` with the two entries appended, and
  deletes the fenced candidate-tense block (P4-AL-61). **No migration file, no product behaviour, no API
  behaviour, no permission behaviour, no RLS policy and no performance threshold changed.**

| migration | SHA-256 | state |
|---|---|---|
| `0077_phase4_sales_sale_items_sources.sql` | `9d9c34f83b77085b8e8d85aeb457ce9df9c011084b25d382ad7d323b4f544237` | FROZEN |
| `0078_phase4_sale_commit.sql` | `8a11b768c3259a75d0e341f20b97037146ae8b40e9dc7f86655f77ba1b6dc730` | FROZEN |

Each digest was computed from the file in the accepted candidate tree, not copied from chat or from a
document, and `scripts/check-migration-manifest.ts`, `scripts/phase4-prefix.ts` and this slice's own gate
recompute it independently. **`0000`–`0078` are now immutable:** no edit, no rename, no reorder, no
deletion, no whitespace or comment edit, no digest rewrite. Every correction from here is a NEW migration
beginning at `0079`, and only under an explicit Tech Lead directive. **79 migrations frozen.**

## 1. What the corrective pass closed

| ruling | what was wrong | what closed it |
|---|---|---|
| `TL-P4-S2-R2` | `gate:phase4:s2` registered its roster and checked only that the files and the red-proof titles EXISTED. Only `rls-force-runtime` executed anything, so a real S2 test could fail while the gate printed PASS. | The gate now EXECUTES the roster in one bounded Vitest run and reports the numbers on a pass as well as a failure: **15 suites claimed → 15 files resolved, 201 passed, 0 failed, 0 skipped, 0 todo**. A missing file, a `.skip`/`.todo`/`.only`, an empty discovery, a signal, a non-zero status or an unreadable tally is a FAIL. Red-proved against the REAL roster: one broken assertion, roster and proof title intact, turned the gate red at exit 1. |
| `TL-P4-S2-R3` | The required `backend` job never ran `gate:phase4:s2` at all. | `.github/workflows/ci.yml:343`, immediately after the P4-S1 step at `:317`, in the same required job. The composition is asserted structurally by `tests/guards/required-ci-chain-composition.test.ts`, which parses this workflow — seven claims, 18 tests, 12 red proofs over mutated copies, and no new YAML dependency. |
| `TL-P4-S2-R4` | Nothing in `0000`–`0078` created an `invoice_sequences` row, and `0078-E(5)` asserted that the routine never writes one. A newly onboarded business could not number its first invoice without manual SQL. | `sale_commit` step 10 inserts the row for the document date's period with `ON CONFLICT (business_id, document_kind, period) DO NOTHING`, THEN locks that exact row `FOR NO KEY UPDATE`, THEN reads `max(number_seq) + 1`. 16 permanent cases in `tests/integration/sale-s2-sequence-init.test.ts`, the ten the directive enumerated among them, concurrency forced deterministically through `pg_blocking_pids` with no sleeps. |
| `TL-P4-S2-R5` | `apps/api/src/common/error.filter.ts` rendered every `P0001` as an opaque 403, reading an internal invariant failure as an authorization denial. | One block: known `sale.*`/`invoice.*`/`customer.*` codes render through the canonical `sellingRefusal(...)` with their registered status; registered internal `selling.*` invariants render **500 INTERNAL_ERROR** with no `details`, the code reaching only the log beside the `requestId`; an unknown historical `P0001` keeps the previous fallback so no accepted Phase 1–3 contract moves; `42501` stays 403. 25 tests, including real `POST /v1/sales` cases and a planted internal defect. |
| `TL-P4-S2-R1` | — | The correction of the SEALED `scripts/phase4-s1-gate.ts` (`S-P4-01` reads the `invoices` child relation instead of grepping the whole Phase 4 DDL) was explicitly authorized as strictly stronger hardening. The planted red proof is retained; nothing else in that gate was touched. |
| `TL-P4-S2-R6` | — | **History rewrite REFUSED by the Tech Lead.** No commit was rewritten and no force-push was performed. The question is closed. |

## 2. The default invoice number format

The Tech Lead's product ruling names `INV-{YYYY}-{SEQ:06}`, as a DAFTAR **internal identifier** and
explicitly **not** a fiscal or tax compliance claim; `OD-03` remains **OPEN** and a Country Pack may later
impose legal requirements.

The FROZEN `invoice_sequences_format_ck` (`0075:379`) admits
`^[A-Za-z0-9/-]*\{YYYY\}[A-Za-z0-9/-]*\{SEQ:[1-9][0-9]?\}[A-Za-z0-9/-]*$` — the first width digit cannot be
`0`, so `{SEQ:06}` is unstorable. The shipped default is `INV-{YYYY}-{SEQ:6}`, which `lpad` renders as
`INV-2026-000001`: the ruling's own rendering, reached without widening a sealed constraint. The Tech Lead
was asked which of the two to take and chose **(أ) keep `{SEQ:6}`** on 2026-10-02.

An existing `number_format` is never overwritten, and not by convention: the writing principal holds no
`UPDATE` privilege on the relation, which `0078-E(7)` asserts against the live catalogues. There is no
counter column and no PostgreSQL sequence.

## 3. The boundary the next slice starts from

- `frozenThrough` = `0078_phase4_sale_commit.sql`; **79** migrations frozen; `0000`–`0078` immutable.
- The next Phase 4 migration is **`0079`**.
- `PHASE4_SLICE_HEADS['P4-S2'] = '0078_phase4_sale_commit.sql'`.
- The candidate-tense marker (P4-AL-61) passes to the gate of whichever slice opens next; this gate carries
  no fence, and `closureRuleProblems` refuses a tree in which one survived.
- `inventory_apply_stock_movements` is unchanged, as §13 of the directive requires.
- Still open: `OD-03`, the `credit_note` / `document_kind` widening (P4-S5's), and the general RLS
  `ENABLE`/`FORCE` law over the discovered surface beyond the Phase 4 partition.
