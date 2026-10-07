# PATCH-REQ-S7-004 — TD-22 is repaid; its row in `TECHNICAL_DEBT.md` still says `open (decision)`

**Raised by:** P4-S7 owner
**Base SHA:** `be5f07f`
**Kind:** EDIT to a shared file four other owners are editing concurrently
**Blocking:** no

---

## TARGET FILE

`TECHNICAL_DEBT.md:31` — the TD-22 row's status column.

## THE REQUIRED CHANGE

Move TD-22 from `open (decision)` to closed, naming P4-S7 and the two commits'
worth of change below. Both halves were repaid in this slice, exactly as
`docs/PHASE_4_ARCHITECTURE_LOCK.md:1138-1146` (P4-AL-56) rules:

> "TD-22 is bound to P4-S7 and repaid narrowly: the design-system document is
> corrected to the shipped tokens, and the Inter reference is removed. … Both
> halves are repaid by correcting the **document** to the shipped tokens and by
> removing the unloaded font name — not by changing every button in the product
> during a sales phase."

**What was done, on this branch:**

- **TD-22(1)** — `docs/DAFTAR_DESIGN_SYSTEM.md` §4 drew the radius scale one
  step above what ships (`sm=8, md=12–14, lg=16–20`) and §5 drew the primary
  button at `radius 12–16` and `≥ 48px`. The shipped values are
  `tokens.ts:76` (`sm=6, md=8, lg=12, xl=16`) and `buttons.tsx:9-11,39`
  (`radius.md` = 8, `minHeight` = `TOUCH_TARGET` = 44px, `sm` = 36, `lg` = 52).
  **The document is now what ships**, with the old numbers and the reason
  recorded in an HTML comment beside each. No component changed, which is the
  point: §21 makes the tokens the source, so the drawing is what was wrong.
- **TD-22(2)** — `tokens.ts:45` named `'Inter'` in the base font stack while
  only `@fontsource/tajawal` is ever loaded
  (`apps/web/src/app/[locale]/layout.tsx:14-16`) under a `font-src 'self'` CSP.
  **The name is removed.** An unloaded font name is not a fallback: it is
  either nothing, or whichever face happens to sit on the reader's machine — a
  shape no gate can check and no two readers share. The real fallback is the
  system stack, and it is what actually draws the Turkish ğ, ş and İ that the
  published Tajawal subsets do not cover. `docs/DAFTAR_DESIGN_SYSTEM.md:42`
  no longer proposes Inter either.

**Verified not to regress the browser gate:** `tests/browser/invariants.ts:252`
requires the computed `font-family` to BEGIN with `Tajawal`
(`/^\s*["']?Tajawal/`) and `:242-243` requires a loaded Tajawal face. Removing a
later member of the stack changes neither.

## WHY THIS IS A PATCH REQUEST AND NOT AN EDIT I MADE

`TECHNICAL_DEBT.md` is not on the S7 owner's forbidden list, and the change is
one cell. It is filed as a request anyway for one reason: **four other Phase 4
owners are working in parallel right now**, every slice that repays a debt
touches this one file, and a debt register is exactly the file where four
simultaneous one-cell edits become a conflict that someone resolves by picking
a side. The coordinator holds the merge order and can apply this in one place.

It is also a ledger of record. Closing a row is a statement that the debt is
gone, and that statement should be made by whoever can see all four branches —
not by the branch that believes its own half is done.

## DEPENDENCY

None. Both edits are on this branch and self-contained.

## THE TEST THAT REQUIRES IT

None, and that is the honest answer: no suite reads `TECHNICAL_DEBT.md`. The
closing evidence is the browser gate staying green
(`tests/browser/invariants.ts` typography checks) plus the whole-tree
`format` / `lint` / `typecheck`, all of which pass on this branch.

## EXPECTED SEMANTIC DIFF

One status cell, plus a dated note naming P4-S7 and P4-AL-56. No code, no
screen and no rendered pixel changes beyond the font stack having one fewer
name that was never loaded.
