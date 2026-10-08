# Phase 10 preparation — isolated domain code

Status: **PREPARED / NOT PROMOTED.** This directory is deliberately outside every
canonical glob: the repository's `vitest.config.ts` includes `tests/**/*.test.ts`,
its root `tsconfig.json` includes `tests/**`, `scripts/**` and `vitest.config.ts`,
and `workspaces` in `package.json` is an explicit list. So nothing here enters the
required CI estate, the repository typecheck or the lint run until a patch request
moves it — which is what the directive requires of code whose predecessors are not
sealed.

It is pure domain logic: no database, no HTTP, no Nest, no imports from `apps/` or
`packages/`. It answers the questions a restaurant pack can answer without a
cluster, and it answers them against the LIVE sale contract's real constraints.

| File | What it owns |
|---|---|
| `src/split-bill.ts` | even, by-amount and by-line splits that conserve the total exactly, or refuse. **By-amount is `WAITING_FOR_INTEGRATED_SURFACE` (§51): the arithmetic is proven, the settlement path is not** |
| `src/bill-discount.ts` | a whole-bill discount apportioned onto line discounts by largest remainder, because the live sale contract has no order-level discount column |
| `src/table-session-state.ts` | the table session lifecycle, with the settlement fact supplied by the sale authority rather than read here |
| `src/preparation-state.ts` | the kitchen state machine, and the one place that decides whether a cancellation owes a waste movement |
| `src/order-to-sale.ts` | aggregating order lines and priced modifiers into the sale lines the sale authority will accept, and the kitchen's separate view |
| `src/recipe-version.ts` | immutable recipe versions and their deterministic expansion: Q4 quantities, HALF_EVEN scaling, and a refusal rather than a dropped component when one scales to zero (§49) |
| `src/stock-effect.ts` | the three stock-effect modes — direct, service, composed, and no fourth — and the completeness verifier that requires exact-set equality rather than a count (§46, §48) |
| `proofs/red-proofs.py` | plants the minimal defect for each law and requires the suite to red AND name the right case |

Run from the repository root:

```
npm ci
./node_modules/.bin/prettier --check "phase-preparation/phase10/**/*.ts"
./node_modules/.bin/eslint phase-preparation/phase10 --max-warnings 0
./node_modules/.bin/tsc -p phase-preparation/phase10/tsconfig.json --noEmit
./node_modules/.bin/vitest run --config phase-preparation/phase10/vitest.config.ts
python3 phase-preparation/phase10/proofs/red-proofs.py
```

The design, the laws these modules enforce, and the architectural finding that
gates the whole phase are in the project's shared folder under `phase10/`.
