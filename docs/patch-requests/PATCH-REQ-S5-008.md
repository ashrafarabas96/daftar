# PATCH-REQ-S5-008 — parameterize the liability account in the canonical AR credit application

| field | value |
|---|---|
| requested by | P4-S5 owner |
| base of record | `phase/4-sales-pos-customers-receivables` @ `6587460` |
| target file | `packages/inventory/src/customer-settlement.ts` (`creditLines`, `:457-470`; `ReceivableAccount`, `:394`; `CustomerCreditApplicationInput`, `:575`) |
| owner of target | the AR settlement arithmetic — **one owner in this phase, and it is not S5** |
| depends on | nothing. It is a PROMOTION-TIME request |
| blocks | nothing. S5 works at levels A–E without it, through a relabelling that is itself asserted |

## Required change

Let the caller of `planCustomerCreditApplication` name the liability account the consumer's
side posts to, defaulting to today's `customer_credit_liability`:

1. add `'customer_refund_liability'` to the `ReceivableAccount` union (`:394`);
2. add one field to `CustomerCreditApplicationInput`:

   ```ts
   /** The liability the consumer represents. 2210 for a customer credit, 2200 for a credit note. */
   readonly liabilityAccount?: Extract<ReceivableAccount, 'customer_credit_liability' | 'customer_refund_liability'>;
   ```

3. have `creditLines` take that account instead of hardcoding `'customer_credit_liability'`
   at `:460` and `:468`, so the principal line AND its dust line both move together — the dust
   must stay on the same account as its principal (OQ-9, ruled), and splitting them would be
   the rounding-account mistake P4-AL-19 forbids;
4. change nothing else. No amount, no sign, no refusal code, no `balanced` call.

## Reason

A credit note and a customer credit are the SAME consumer arithmetically — a stored
`(original, original_carrying, remaining)` triple with its own FX snapshot, releasing against
an invoice at the invoice's AR level. They differ in exactly one respect: which liability the
consumer IS. A customer credit is `customer_credit_liability` (2210); a credit note is
`customer_refund_liability` (2200). Nothing else about the two differs, and
`packages/inventory/src/customer-settlement.ts:394` says so in its own comment — it excludes
2200 from `ReceivableAccount` with the words *"never `customer_refund_liability` (2200), which
is P4-S5's"*. This request is S5 arriving to claim it.

Until then S5 reaches the canonical algorithm through `planCreditNoteApplication`
(`apps/api/src/modules/returns/returns-settlement.ts`), which calls
`planCustomerCreditApplication` and passes its lines through a pure relabelling of 2210 to
2200. That is correct but it is a SEAM, and a seam is worth removing because the relabelling
has to be proved rather than assumed: the test
`tests/guards/p4s5-refund-plan-red-proofs.test.ts` asserts every amount identical to the
canonical plan's, every line identical but for that one account name, and that the
relabelling genuinely happened in both directions. After this patch the delegation is total,
those three assertions collapse into one, and there is no transformation left between the one
canonical AR algorithm and the row it produces.

## Dependency

None. The change is additive and the new field is optional, so every existing caller —
`planCustomerCreditApplication`'s own S4 call sites and `customer_credit_verify`'s expected
shape — compiles and behaves identically. It can land before, with, or after S5's own
migration.

## The test that requires it

`tests/guards/p4s5-refund-plan-red-proofs.test.ts` →
`an application reduces AR through the ONE canonical algorithm` →
`is the canonical plan with ONE account relabelled — 2210 becomes 2200 and nothing else moves`.

That test exists to bound the relabelling. With this patch it becomes:

```ts
expect(planCreditNoteApplication(args)).toEqual(
  planCustomerCreditApplication({ ...args, liabilityAccount: 'customer_refund_liability' }),
);
```

— one assertion over two whole plans, with no mapping in the assertion itself. An assertion
that has to describe the transformation it tolerates is weaker than one that tolerates none.

## Expected semantic diff

- `ReceivableAccount` gains one member: five accounts become six;
- `CustomerCreditApplicationInput` gains one OPTIONAL field; no existing call site changes;
- `creditLines`' two literal `'customer_credit_liability'` occurrences become one parameter,
  used twice;
- **no amount, no sign, no account on any existing path changes.** Called without the new
  field, the function emits byte-identical lines, which `vectors/` and
  `customer_credit_verify`'s expected shape both already pin;
- `accounting_customer_credit_application_entry_complete` (`0081:1594`) is NOT touched by this
  patch: it validates `customer_credit_application` entries, and the credit-note application's
  own validator is a separate routine specified in
  `docs/PHASE_4_S5_DDL_SPECIFICATION.md` §5.5.
