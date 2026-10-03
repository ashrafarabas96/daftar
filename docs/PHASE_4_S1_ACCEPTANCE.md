# DAFTAR — P4-S1 Acceptance / قبول الشريحة الأولى من المرحلة الرابعة

> **What this is.** The freeze page for slice **P4-S1: customers, sales documents and per-business document
> numbering** (`docs/PHASE_4_EXECUTION_PLAN.md`). It records the accepted candidate, the three migrations and
> the digests they froze at, the Tech Lead's three seal rulings, and the boundary the next slice starts from.
> The evidence for what the slice built and proved is `docs/PHASE_4_S1_ESTATE_REEXPRESSION.md` and the §25
> correction table of `docs/PHASE_4_ARCHITECTURE_LOCK.md`; this page is the freeze itself.
>
> **ما هذه الوثيقة.** صفحة تجميد الشريحة P4-S1: العملاء ومستندات البيع والترقيم لكل منشأة. تُسجِّل المرشّح
> المقبول، والهجرات الثلاث وبصماتها، وقرارات الختم الثلاثة، والحدّ الذي تبدأ منه الشريحة التالية.

## 0. Status: ACCEPTED AND FROZEN

- **Accepted candidate head:** `9a41089724e585f90fa3d2eee9b08c27254318ae`, branch
  `phase/4-sales-pos-customers-receivables`, PR #6 (**Draft** — not merged).
- **Candidate CI, on that exact SHA:** `DAFTAR CI` **36804706477** (push) and **36804714710**
  (pull_request), six jobs SUCCESS each, attempt 1 — `workspaces`, `backend`, `web-admin`, `android`,
  `hygiene`, `browser`. `mergeable_state: clean`.
- **Verdict:** the Tech Lead's P4-S1 final seal directive (2026-10-01) — **TECHNICALLY ACCEPTED / AUTHORIZED
  TO SEAL**, with the three rulings recorded in `docs/PHASE_4_ARCHITECTURE_LOCK.md` §25.
- **The seal commit is documentation and freeze metadata only.** It fills `S1_ACCEPTED` in
  `scripts/phase4-s1-gate.ts` and `PHASE4_S1_PREFIX` / `PHASE4_SLICE_HEADS` in `scripts/phase4-prefix.ts`,
  moves the manifest to `frozenThrough = 0076_phase4_permission_defaults_backfill.sql` with the three
  entries appended, deletes the fenced candidate-tense block (P4-AL-61), and records R1/R2/R3. **No
  migration file, no product behaviour, no API behaviour, no permission behaviour, no RLS policy and no
  performance threshold changed.**

| migration | SHA-256 | state |
|---|---|---|
| `0074_phase4_registry_widening.sql` | `8f8fa9c080661255f77a6a036292bc8cd786a3c8f5a22a38f359cbbdaf66901d` | FROZEN |
| `0075_phase4_customers_invoices_numbering.sql` | `b5d64176c3af9fb38a56b26f3e767a36fd2fd4a583423a1f60b3165d5f239905` | FROZEN |
| `0076_phase4_permission_defaults_backfill.sql` | `2bbad56286ac06e988e4d590b290957fbb716313a6d82c4ba85c1f164bc3dcec` | FROZEN |

Each digest was computed from the file in the accepted candidate tree, not copied from chat or from a
document, and `scripts/check-migration-manifest.ts` and `scripts/phase4-prefix.ts` recompute both
independently. **`0000`–`0076` are now immutable:** no edit, no rename, no reorder, no deletion, no
whitespace or comment edit, no digest rewrite. Every correction from here is a NEW migration beginning at
`0077`, and only under an explicit Tech Lead directive. 77 migrations frozen.

## 1. What P4-S1 delivers

| migration | delivers |
|---|---|
| `0074` | The four `registered_by` pattern widenings, from `^P3-S[0-9]+$` to `^P[0-9]+-S[0-9]+$`, keeping the `P3-C` arm on `inventory_operation_kinds` alone (`TL-P4-S1-C3`). No table, function, policy or registry row. |
| `0075` | `customers`, `customer_contacts`, `invoices`, `invoice_items`, `invoice_sequences`. RLS ENABLE + FORCE on each, with **six** policies on an ordinary relation and **seven** on `invoices` — the seventh is the accounting validator's read, without which the deferred completeness validator reads zero rows and passes vacuously (`TL-P4-S1-C2`). SELECT-only runtime grants, seven `SECURITY DEFINER` guard triggers, one deferrable constraint trigger, four `SECURITY INVOKER` read functions, and the `0075-E` end-state block of ten assertion groups read from the live catalogues. Numbering is **YEARLY** per business and document kind (`TL-P4-S1-C9`). Adds **no** registry row (`TL-P4-S1-C7`, `TL-P4-S1-C8`). |
| `0076` | The twelve Phase 4 permission defaults for owner, manager and cashier in every existing business, the manager's set **derived** from the sensitivity vector rather than copied into a second list, and one audited `structure.permission_backfilled` row per role that grew (R-P4-10/11/12). |

## 2. The Tech Lead's seal rulings

| id | ruling | where it lands |
|---|---|---|
| `TL-P4-S1-R1` | **Invoice accounting-source ownership moved to the posting slice (P4-S2).** A source type may not exist as a dead registry concept. `0075` is not changed. | `docs/PHASE_4_EXECUTION_PLAN.md` slice table (S1 and S2 rows), lock §25 |
| `TL-P4-S1-R2` | **A general Phase 4 RLS/FORCE discovery guard is required**, discovering relations from the tree or the catalogue and never from a handwritten list, with three planted red proofs. It is **P4-S2's first mandatory protection, before `0077`**. Not retrofitted into `0075`. | lock §25, and the carried-forward list |
| `TL-P4-S1-R3` | **`document_kind` narrowing accepted.** `invoices.document_kind` stays `'invoice'`; no fake credit-note row; P4-S5 owns the widening. | lock §25 |

## 3. The boundary P4-S2 starts from

- Migrations begin at **`0077`**, allocated by the single migration owner, and `0077` may not be created
  until the `TL-P4-S1-R2` guard is integrated and red-proven as part of `gate:phase4:s2`.
- `gate:phase4:s1` is now permanent and runs in the accepted tense: its candidate-tense closure rule is
  gone, and `closureRuleProblems` refuses a tree in which any fence marker survived (P4-AL-61).
- PR #6 stays **Draft**. **OD-03 remains OPEN**: sales tax is structurally zero and a non-zero tax is
  refused until an approved Country Pack backed by official legal sources exists.
