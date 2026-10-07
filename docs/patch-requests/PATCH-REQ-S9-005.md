# PATCH-REQ-S9-005 — the worktree repoint script leaves `@daftar/design-system` unbuilt

| | |
|---|---|
| raised by | P4-S9 |
| base SHA | `6587460ba3632231e4324c5ce2af92e1589d0705` |
| target | `/tmp/claude-0/fix-worktree-node-modules.sh` (container tooling, outside the repository) |
| owner | the coordinator / whoever owns the container tooling |
| detector | `scripts/phase4-s9/resolution-containment.ts` → `resolutionContainmentProblems` |
| check | `scripts/phase4-s9/index.ts` → `resolution-containment` |
| red proof | `tests/guards/p4s89-framework-laws.test.ts::the resolution checker names a workspace link that escapes the root being judged` |

## The hazard, restated so the patch is not read as cosmetic

npm writes workspace links as **relative** symlinks
(`node_modules/@daftar/inventory -> ../../packages/inventory`). A git worktree
whose whole `node_modules` is a symlink to the main checkout therefore resolves
every `@daftar/*` import to the **main checkout's** packages. The worktree's own
`tests/`, `scripts/` and `apps/` sources are still compiled — tsconfig includes
them by PATH — so the run is green and the green is a statement about a tree the
author never edited. It has bitten the P4-S5 owner and an integrator in this
container on the same day.

`[[daftar-a-check-only-asked-where-it-passes]]` is usually about which question
a check asks. This is the same shape one level down: the right question, asked
of the wrong tree.

## The measured gap in the fix script

`fix-worktree-node-modules.sh` repoints `@daftar/*` correctly and then builds
`domain-core`, `accounting`, `inventory` and `shared-contracts`. It does **not**
build `design-system`, and `packages/design-system/package.json` declares
`"main": "./dist/index.js"` and `"types": "./dist/index.d.ts"`. So immediately
after the script runs:

```
@daftar/design-system: declares ./dist/index.js and it does not exist
@daftar/design-system: declares ./dist/index.d.ts and it does not exist
```

Every `@daftar/design-system` import is then `TS2307` — and there are at least
eleven files under `apps/admin/src/app/**` that import it. A `TS2307` reads as a
defect in the *importing* code, which is how an hour goes into the wrong file.

## Required change

Add `design-system` to the script's final build list. Build it **after**
`domain-core` and `shared-contracts` if it depends on them.

## And the second failure mode, which is worse

A **stale** `dist/` resolves, and answers from code that is not the code in the
tree. That is how a merge adding package exports produced a `TS2305` that read
as a defect in the merged code. `resolutionContainmentProblems` reports the two
cases **differently**, because "nothing is built" and "something old is built"
need different actions.

## Why this is in S9's scope at all

Because a release gate's whole claim is "this commit, this tree, these results",
and the hazard is invisible: nothing fails, a number is simply about the wrong
thing. So the containment is now asserted rather than assumed — a check
(`resolution-containment`) and a step of the extracted-archive procedure
(`A-4`), which is the place it bites hardest: an archive extracted beside a
repository, with a `node_modules` that leads back into it, would run the whole
release gate against the repository's packages.

## Expected semantic diff

| | before | after |
|---|---|---|
| `@daftar/design-system` after the script | unbuilt, every import `TS2307` | built |
| `resolutionContainmentProblems(worktree)` | 2 problems | `[]` |
