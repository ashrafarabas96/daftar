# DR-82 — the closure proof, and the four conditions that gated the merge of PR #17

**Decision: the external review's round-3 verdict is accepted.** It returned
**REJECT** on `C1_RESPONSE_TO_REVIEW_2`, `C1_POSTSEAL` and `C1_FINAL`, and
**ACCEPT with notes** on `T10`, with **no defect in the code**. It named **four
conditions** blocking the merge of PR #17, and stated that the declared
follow-ups — `TD-24`, `TD-25`, the image dimension bound over HTTP, mail TLS, and
inventory-to-gate binding — **are not merge blockers**.

**A limit on this record's sourcing, stated rather than glossed:** the round-3
text was relayed by the owner in prose, **not handed over verbatim**. Everything
attributed to the review here rests on that relay.

## 1. The closure proof — and the correction of my own first withdrawal

**DR-81 withdrew the "zero transaction figure" case. That withdrawal was itself
wrong**, and this is the correction. It inferred `Σ amount = 0` **from closure**.
That inference is false: **closure does not mean nothing was applied, it means
everything was.**

**Symbols, defined before use.** `T` — the invoice total in the **transaction**
currency. `B` — that same invoice's value in the **base** currency, as stored on
the invoice. `amount` — the amounts applied to the invoice, in the transaction
currency. `rel` — the carrying amount released from the base.

```
outstanding_txn = T − Σ amount = 0  ⇒  Σ amount = T
                                    ⇒  Σ rel = HALF_EVEN(B·T, T) = B
                                    ⇒  outstanding_base = B − Σ rel = 0
```

**The transaction side closing forces the base side to close**, so a closed
invoice cannot carry a non-zero base. **And `Σ amount = 0` means no net amount
was applied, not that settlement completed** — it is not the closure case at all,
and nothing about closure follows from it. That conflation was the error.

### The proof is not asserted on its own authority

**Pinned line by line to a live test** —
`tests/integration/receivables-s4-fx-closure.test.ts`, 8 cases, 8 passed, on a
real `ILS` invoice under a `USD` base with `T = 3000` (applied `400 + 1200 +
1400`) and `B = 721`:

| step of the proof | assertion | line |
|---|---|---|
| `outstanding_txn = 0` | `expect(read.outstandingTxnMinor …).toBe(0n)` | **`:495`**, in case `4. CLOSURE` (**`:491`**) |
| `Σ amount = T` | `expect(sumApplied, "Σ a = T").toBe(T)` | **`:525`**, in case `5. the TELESCOPING identity` (**`:505`**) |
| `Σ rel = B` | `expect(sumRel, "…STORED total_base_minor… EXACTLY").toBe(B)` | **`:545`** |
| `outstanding_base = 0` | `expect(read.outstandingBaseMinor …).toBe(0n)` | **`:497`** |

The `Σ rel = B` assertion is against the invoice's **stored** `total_base_minor`
— an absolute value, not an identity between two sums computed the same way — and
case 5 additionally requires **at least one leg with `rel ≠ conv_R(a)`**, so a
per-leg conversion could not pass in place of the telescoping release.

**And it is independently grounded in DR-72**, which states the same thing of the
release formula: over a chain whose positions are the running sums the
intermediate terms cancel, giving `HALF_EVEN(B·Σa, T)`, *"which at `Σa = T` is
exactly `B`"* (`docs/decisions/2026-10-30-dr72-closure-conservation.md` §layer 1).
⇒ the proof is a restatement of an already-decided property, not a new claim.

## 2. The prescribed remedy is withdrawn, with no replacement

"If it is reachable, fix by the remainder method" is **deleted** wherever it
appeared. It prescribed a repair for a behaviour nobody has observed — and
**DR-72 had already withdrawn the remainder method**, so the reports were
re-proposing a withdrawn remedy.

**The follow-up is instead: measure the per-row sign path, then let the result
determine the correction, subject to preserving the conservation identity.**
Carried as `TD-26`.

## 3. Three narrowings

1. **The realized-difference equation does not carry the claim alone.** Keeping
   exchange difference out of the carrying base is attributed to **the release
   law, `invoice_settlement_verify`, and `realized = payment_base −
   released_base` acting together**. **"Not representable" is deleted**: the
   equation fixes the residual's value, it does not by itself constrain the
   released base.
2. **The 357→358 / 6,618→6,626 arithmetic is a consistency check only.** The
   primary evidence is the step output's own line naming the file with its eight
   cases passing. **A count cannot identify which file was added** ⇒ the
   arithmetic corroborates and does not establish.
3. **The two local FX negative controls are supporting evidence, not a proven
   gate** — local planted edits, in no CI run, with **no fingerprint recorded
   proving each plant applied before its result was read**.

## 4. The delivery gate

The four conditions are enforced by a script, not by reading. It fails on: the
remainder phrase outside a withdrawal sentence; any passage deriving
`Σ amount = 0` from closure; the phrases `All eight`, `All of it ran`, `not
representable`; the proof missing from any of its three required files; or any
file at or over 25,000 characters. **Scanning is by sentence, not by line**,
because this prose wraps across line breaks and a raw line scan would miss a
wrapped phrase.

**Proven by a negative control, with the plant proven applied first:** the
remainder phrase was planted in a temporary copy, the copy's fingerprint moved
`c3a4fc57…` → `751f5f96…`, and the gate then **failed with exit 1 naming
`C1_POSTSEAL_FOR_CHATGPT.md:118`** while the other two files still passed. The
real files were verified byte-identical to their baseline afterwards.

## 5. What this decision does not claim

The merge of PR #17 is authorised **by the owner**, under the gates recorded with
it — not by this document, and not by the review. No PASS for Phase 4 is claimed
beyond what the decisive run measured. The follow-up cards remain open and are
**not** closed by the merge.
