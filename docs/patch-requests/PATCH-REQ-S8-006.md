# PATCH-REQ-S8-006 — the `provider_reference` partial unique (`P4-AL-30`)

| | |
|---|---|
| raised by | P4-S8 |
| base SHA | `6587460ba3632231e4324c5ce2af92e1589d0705` |
| target | a future candidate migration — **number allocated by the migration owner, not here** |
| owner | the migration owner (S5/S6 as the commercial relations land) |
| check waiting on it | `idempotency-provider-reference` (`WAITING_FOR_INTEGRATED_SURFACE`) |

## The finding

There is **no `provider_reference` column anywhere** in the 87 migrations on
disk. `P4-AL-30` settles idempotency as *document UUID + `intent_sha256`*, with
no `idempotency_key` column — and the inventory confirms the estate matches:
24 discovered idempotency keys, 20 guarded by an advisory lock, 2 by a row lock
on the identity relation, 2 physically by `INSERT … ON CONFLICT DO NOTHING` plus
`GET DIAGNOSTICS` and a re-read. Zero findings.

What is missing is the **database-level** refusal of a replayed external
webhook. An intent hash refuses a *changed* intent; it does not refuse the same
provider event delivered twice, because the second delivery carries the same
intent and the same hash and is therefore indistinguishable from a legitimate
replay — which the key correctly answers "success" to. A payment provider
retrying a webhook is not replaying a command the system issued.

## Required change

A **partial unique index** on the provider reference of the settlement relation,
partial so rows with no provider reference (cash, in-person) are unconstrained:

```sql
CREATE UNIQUE INDEX <name> ON payments (business_id, provider, provider_reference)
  WHERE provider_reference IS NOT NULL;
```

The refusal must be the **database's**, not the application's:
`[[daftar-idempotency-key-is-not-permission]]`. A replay path must prove WHICH
command it is replaying before it answers "success", and it must consult that
proof BEFORE it reads current state (`[[daftar-registry-before-state]]`).
`idempotencyFindings` already checks `registryBeforeState` against the first DML
of each routine, and the inventory records `locksBeforeIntent` as a FACT beside
it.

## What S8 explicitly did not do

**Allocate a migration number.** `0000`–`0079` are byte-for-byte immutable,
`0080`–`0086` are S4 candidates, and there is exactly one migration owner. A
gate author reserving a future number is how two owners come to hold the same
number.

## Expected semantic diff

| | before | after |
|---|---|---|
| `provider_reference` | exists nowhere | a column with a partial unique index |
| a replayed provider webhook | refused by application code, if at all | refused by the database |
| `idempotency-provider-reference` | WAITING (column absent) | evaluates |
| inventory rows with `bareKey` | 1 | to be re-measured after the patch |
