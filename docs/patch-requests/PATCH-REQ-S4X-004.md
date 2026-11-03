# PATCH-REQ-S4X-004 — the gate's only reader of the settlement bodies judges `0081`'s superseded `customer_collect_payment`, not `0085`'s live one

- **Raised by:** `p4s4c/exit-criteria` (P4-S4 exit-criteria stream)
- **Target file:** `scripts/phase4-s4-gate.ts`
- **Status:** OPEN — the gate is the coordinator's file, so this is a request, not an edit

---

## 1. `routineBody` takes the FIRST definition and is handed the JOINED surface

`routineBody` (`scripts/phase4-s4-gate.ts:669-679`) locates the routine with

```ts
const head = new RegExp(String.raw`create\s+(?:or\s+replace\s+)?function\s+…${fn}\b`, 'i').exec(sql);
```

`RegExp.prototype.exec` without `/g` returns the **first** match. And its only caller chain
is handed the **joined** text of every candidate migration:

```ts
const surface = files.map((f) => read(root, `${MIGRATIONS_SUBDIR}/${f}`)).join('\n');   // :932
…
for (const p of settlementContractProblems(surface)) …                                  // :971
  → problems.push(...rowLockOnlyWriteProblems(sql));                                    // :905
```

`0085_phase4_allocation_recompute_set_based.sql` **re-defines** `customer_collect_payment`.
The joined surface therefore contains two definitions, and the gate reads the earlier one.

## 2. Measured, not inferred

Running the gate's own exported functions over the gate's own joined surface:

```
candidate files: 0080…, 0081…, 0082…, 0083…, 0084…, 0085…, 0086…
0081_phase4_customer_payments_credits.sql   defines customer_collect_payment, body length 24690,
                                            identical to surface-read body: true
0085_phase4_allocation_recompute_set_based.sql defines customer_collect_payment, body length 25577,
                                            identical to surface-read body: false
surface-read body length: 24690
rowLockOnlyWriteProblems(surface) => []
```

The gate is judging a **24 690-byte body that is no longer installed**, while the live routine
is `0085`'s 25 577-byte one. The green verdict is about a routine that does not exist.

## 3. Why it has been harmless, and why that is not a reason to leave it

For the one law that uses it — "neither settlement routine issues an `UPDATE` of `invoices`
or `customers`" — both bodies happen to satisfy it, so the verdict is accidentally correct.
But:

- the comment at `:582-599` states the law is "MACHINE-CHECKED here, over the routine bodies"
  so that "neither the prose of the migration nor the prose of this law can satisfy it or
  break it". Over a superseded body, that is not true: `0085` could introduce an
  `UPDATE invoices` tomorrow and this law would stay green.
- `rowLockOnlyWriteProblems` is the **only** machine check in the tree that reads these two
  bodies for anything. Any future body law added beside it inherits the defect silently.
- the same mistake is what makes an acquisition-order check unreliable: a checker reading
  migration text by name would judge a body that no longer exists, which is exactly the
  failure mode `PATCH-REQ-S4X-003` had to design around.

## Required change

Make `routineBody` return the **LAST** definition the text declares, and say why in the doc
comment — a migration estate supersedes by re-definition, so "the routine" means the body the
final `CREATE OR REPLACE` installed. The minimal form:

```ts
export function routineBody(sql: string, fn: string): string | null {
  const head = new RegExp(String.raw`create\s+(?:or\s+replace\s+)?function\s+(?:public\s*\.\s*)?${fn}\b`, 'gi');
  let found: string | null = null;
  for (const m of sql.matchAll(head)) {
    const rest = sql.slice(m.index ?? 0);
    const open = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
    if (open === null) continue;
    const tag = open[0];
    const from = (m.index ?? 0) + open.index + tag.length;
    const end = sql.indexOf(tag, from);
    if (end < 0) continue;
    found = sql.slice(from, end);     // keep going: the LAST wins
  }
  return found;
}
```

`scripts/guards/phase4-lock-order.ts`'s `lastRoutineBody` is exactly this and is green, so the
shape is already exercised in the tree.

Note that `settlementContractProblems` has a **separate** law immediately above
(`:893-896`) that reports `${fn} is DEFINED again in the settlement text` for the
`SETTLEMENT_ARITHMETIC` names. The settlement **commands** are deliberately not under that
prohibition — `0085` re-defining `customer_collect_payment` is lawful and intended — which is
precisely why the body reader has to cope with two definitions rather than the gate forbidding
them.

## A second, smaller item in the same file

The doc comment at `:587-589` states: "The invoice's status is advanced by the sale and void
paths of `0078`, and a customer's by `0075`." **Measured, there is no `UPDATE invoices` and no
`UPDATE customers` anywhere in the tree** — not in `0078`, not in `0075`, not in any migration
and not in the application code. `invoices.status` admits only `draft | open | void`
(`0075:257`), transitions are refused by the trigger at `0075:585`, and the settlement figures
are derived (`P4-AL-06`), so on this head the only writers of either table are `INSERT`s.

This does not change the law's verdict — the law is a prohibition, and nothing violates it —
but it is a false statement of fact in the justification a reviewer reads to decide the
row-lock grant is safe. The same pattern is recorded at `09-settlement-last-amount-race.golden.test.ts:270-289`,
where a comment that was measured false had already led a reviewer to a wrong conclusion. It
should say that the status columns have **no** writer yet and name the slice that will add one.

## The test that requires it

`tests/guards/p4s4-lock-order-law.test.ts::customer_collect_payment is defined TWICE and the
checker reads 0085's body, not 0081's superseded one` — green, and it asserts the property
this request asks `routineBody` to have, over the real two-definition surface. It first
asserts the two bodies are different texts (or which one a reader picks could not matter),
then that the reader handed the joined surface reports `0085`'s acquisition sequence.

`tests/guards/p4s4-settlement-surface-laws.test.ts:623-654` is the existing suite for
`rowLockOnlyWriteProblems`; its cases are built from a synthetic one-definition `shape(...)`
helper, which is why none of them exercises the two-definition case. A case handing `shape()`
twice — the second body carrying the `UPDATE invoices` plant — would be red before this change
and green after, and is the natural regression to add alongside it.

## Expected semantic diff

The gate's body reader starts judging the routine the database actually holds. Over today's
tree the verdict does not change (both bodies satisfy the write law), so this is a
no-behaviour-change correction that removes a silent blind spot: an `UPDATE invoices`
introduced by `0085` or any later re-definition becomes visible.

**No law is weakened.** The prohibition is unchanged; its subject becomes the live routine
instead of a superseded one, which can only make the law stricter.
