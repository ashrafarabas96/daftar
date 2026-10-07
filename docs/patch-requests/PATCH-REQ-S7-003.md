# PATCH-REQ-S7-003 — the slice has no acceptance gate, and I may not write one

**Raised by:** P4-S7 owner
**Base SHA:** `be5f07f`
**Kind:** EDIT to files on the forbidden list
**Blocking:** level G (the integrated gate). Levels A–E do not need it

---

## TARGET FILES (all three are forbidden to the S7 owner)

1. `scripts/phase4-s7-gate.ts` — **new** (`scripts/phase4-s*-gate.ts` is forbidden)
2. `package.json` — one script entry `"gate:phase4:s7": "tsx scripts/phase4-s7-gate.ts"`, after `gate:phase4:s4` (`package.json:79`)
3. `.github/workflows/ci.yml` — the step that runs it, and `npm run perf:phase4:s7` under an **exclusive** runner

---

## THE REQUIRED CHANGE

Every Phase 4 slice has a documented acceptance gate: `phase4-s1-gate.ts`
through `phase4-s4-gate.ts` exist and are wired as `gate:phase4:s1…s4`. S7 has
none, and the S7 owner may not create one.

The S7 gate must check, structurally and then integrated:

| # | Check | Already proved by |
| --- | --- | --- |
| 1 | `installment_plans` / `installments` draw **no** polymorphic FK and no single-component edge | `tests/guards/p4s7-schedule-laws.test.ts §1` — reuse `compositeFkProblems` |
| 2 | neither table carries a status, balance, `settled_minor`, `outstanding_minor` or `settled_at` column | `§2` — reuse `findAuthoritativeSalesColumns` / `DERIVED_SETTLEMENT_INSTANT` |
| 3 | `installments-reads.ts` contains no `OFFSET` and every ordering component is in the cursor | `§3` — reuse `findReadSurfaceViolations` |
| 4 | no routine of the slice resolves a date, and every derived status takes a supplied `asOf` | `tests/integration/p4s7-asof-and-closure-redproofs.test.ts` |
| 5 | the closure trigger exists, is `DEFERRABLE INITIALLY DEFERRED`, and FIRES inside the command's transaction | same suite |
| 6 | the 26 refusal codes the database raises are exactly the 26 the API classifies | `installments-errors.ts` + a level-F integration test |
| 7 | the declared route surface equals the mounted one | the existing `tests/security/phase4-route-surface.test.ts`, once a controller exists |
| 8 | both tables were `ANALYZE`d before any budget is claimed, with the evidence read back from `pg_stat_user_tables` | `tests/performance/installments-s7-harness.ts` |
| 9 | the catalogue shape of `docs/PHASE_4_S7_DDL_SPECIFICATION.md §E.7`, **including the absences** | not yet; needs the real DDL |

Checks 1–5 and 8 are already implemented as suites the gate can call; the gate
is the thing that makes them a GATE rather than a suite someone remembers to
run. **It should call them, not re-implement them** — a gate with its own copy
of a detector is a second detector, and the two drift.

## THE REASON

`npx tsx scripts/phase4-s4-gate.ts --structural-only` is the current
integration authority, and it stays PASS with this slice's work on the branch
(verified). But there is no command that answers "is S7 acceptable", so at
promotion time the answer would be a person's recollection of which suites were
green. A slice whose gate is a memory is a slice that regresses silently.

## DEPENDENCY

- Checks 1–3 and 9 need the real DDL, so the gate's *integrated* half depends
  on the migration owner writing it after S7 is promoted;
- Check 7 needs the controller, i.e. level F;
- The `perf:phase4:s7` step must run on an **exclusive** runner, or the gate
  records `resource_contention` and asserts nothing. A performance step that
  shares a box with four other jobs produces a number that is neither a pass
  nor a fail, which is worse than no step at all.

Checks 4, 5 and 8 can be wired **now**, before the DDL exists, because they run
against planted real subjects in rolled-back transactions.

## THE TEST THAT REQUIRES IT

All five S7 suites. They are currently reachable only by naming their paths:

```
npx vitest run packages/domain-core/test/installment-schedule.test.ts
npx vitest run tests/guards/p4s7-schedule-laws.test.ts
npx vitest run tests/integration/p4s7-asof-and-closure-redproofs.test.ts
npx vitest run tests/performance/installments-s7-budgets.test.ts
npx vitest run test/installments-views.test.tsx --root apps/web
```

## EXPECTED SEMANTIC DIFF

`npm run gate:phase4:s7` exists and exits non-zero on any of checks 1–9; CI
fails on a change that reintroduces an `OFFSET` page, a status column, a
clock-reading routine, or a schedule that does not close. Today each of those
would be caught only if someone ran the right suite by hand.
