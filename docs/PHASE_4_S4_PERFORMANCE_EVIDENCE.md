# P4-S4 — the customer settlement budgets, measured

This page records one authoritative measurement of `P4-D` and `P4-F`, the
environment it was taken in, and the diagnosis of the three budgets it missed.
It changes no ceiling, no ratio, no iteration count, no index, no policy, no
product query and no migration. **Two budgets and one host-independent ratio
are FAILED here, and the diagnosis below is the deliverable, not the number.**

Measured by `tests/performance/receivables-s4-budgets.test.ts` at
`P4_PERF_SCALE=1`. Every figure on this page comes from the run whose log is
quoted; nothing is carried over from an earlier slice or an earlier run.

## The verdict, first

```
[P4-S4 budgets] VERDICT — RED: {
 "declaredCases": 18, "casesInTheFile": 18, "ranToAVerdict": 18,
 "passed": 15, "failed": 3, "unaccounted": [], "fixtureCompleted": true
}
Test Files  1 failed (1)
     Tests  3 failed | 15 passed (18)
  Duration  1145.43s
```

| | budget | ceiling | measured `p95` | verdict |
|---|---|---|---|---|
| **P4-D** | customer receivable, fat-tail (live AR) | 100 ms | **125.469 ms** | **FAIL** |
| **P4-D** | `p95(fat-tail) ≤ 3 × p95(median)` | 3× | **9.63×** | **FAIL** |
| **P4-F** | allocation, 5 invoices, in-transaction | 40 ms | **41.724 ms** | **FAIL** |
| P4-F | allocation, 5 invoices, over HTTP | 100 ms | 56.509 ms | PASS |
| P4-F | allocation, 5 invoices foreign currency, over HTTP | 100 ms | 59.916 ms | PASS |
| P4-F | `p95(5) ≤ 3 × p95(1)`, in-transaction | 3× | 2.806× | PASS |
| P4-F | `p95(5) ≤ 3 × p95(1)`, over HTTP | 3× | 2.022× | PASS |
| P4-D | RLS cost, `daftar_app` over schema owner | 3× | **1.691×** | PASS |

Every gate passed: one transaction per allocation command, one journal entry
per allocation and no per-line entry, no `OFFSET` in any statement, a statement
count independent of the customer's invoice count, every read deriving its
money through the product's own reader of record and summing nothing itself,
and the `FINDING` that the reader of record is not inlinable.

## The environment, read from the server that answered

```
[plan-evidence] AUTHORITATIVE TARGET PLAN EVIDENCE |
  server_version_num=160013 datcollate=C.UTF-8 datctype=C.UTF-8
  provider=c byteOrder=false
```

| field | value |
|---|---|
| server version | `16.13 (Ubuntu 16.13-0ubuntu0.24.04.1)`, `server_version_num=160013`, major **16** |
| database | `daftar`, encoding `UTF8` |
| `datcollate` / `datctype` | `C.UTF-8` / `C.UTF-8` |
| locale provider | `c` (libc); `icuLocale` null |
| `collationIsByteOrder` | `false` |
| server provenance | **external**, port 5432, `PG_DIR` not set |
| provenance rule | the embedded data directory `/tmp/daftar-pg-shared` holds major 18, but major 16 answered on port 5432, so the server measured is external |
| data directory | `/var/tmp/pgdata` |
| free disk before the figures | **9 645 559 808 B** on the filesystem holding the data directory (9.08 GiB); `/tmp` is the same filesystem. A shell reading 24 s before the run gave 9 716 633 600 B. |
| CPUs | 4 |
| total memory | 16 876 511 232 B (16 GiB); 15 838 990 336 B available before the run |
| server settings | `fsync=off synchronous_commit=off full_page_writes=off max_connections=200` |

This is the **first** run of this suite that `classifyPlanEvidence` calls
authoritative, so the collation deserves saying plainly rather than resting on
the label:

- the **major is 16**, which is what the deployment target and
  `.github/workflows/ci.yml` (`image: postgres:16`) run;
- the **collation spelling is `C.UTF-8` here and `en_US.utf8` in CI**. The
  spellings differ, and that difference is recorded rather than smoothed over;
- **neither is byte order**, and that is the property the plan claims rest on.
  `TARGET_PLAN_EVIDENCE_CONTRACT` gates on the property and never on a
  literal, because PostgreSQL stores `datcollate` exactly as given and
  normalises nothing — a contract that string-matched one spelling would
  reject the very environments it exists to describe
  (`tests/helpers/plan-evidence-env.ts`). The record carries
  `spellingsIdentical: false` and `propertyIdentical: true` as explicit
  fields so no reader has to compare two strings in two places.

The plan claims on this page are therefore authoritative for the deployment
**major** and for the byte-order **property**. They are not a claim that
`C.UTF-8` and `en_US.utf8` are the same locale.

## The load context, observed rather than assumed

The box had just finished another agent's gate battery. I watched
`/proc/loadavg` and the process table rather than taking the quiet on trust,
and **waited 8 min 51 s** (12:14:47 → 12:22:38 UTC) for it to settle:

```
12:15:12 load=1.04 1.74 1.86 otherRuns=4 foreignBackendsOn5432=0
12:15:33 load=0.75 1.63 1.82 otherRuns=0 foreignBackendsOn5432=0
   …
12:22:30 load=0.01 0.47 1.19 otherRuns=0
```

The run then held 12:22:54 → 12:42:11 UTC with 1-minute load between **0.09
and 0.74** (mostly 0.10–0.30) on 4 CPUs, never once above 0.74. The suite's
own reading at the point it recorded the dataset was `loadAverage: [0.17,
0.19, 0.55]`. No other `vitest run` or gate script was present and **no
foreign client backend ever appeared on 5432** — the only databases seen in
`pg_stat_activity` across the run were `daftar` (this run) and `postgres`
(the watchdog's own connection).

One correction, recorded because the instrument was wrong and the box was not.
My watchdog counted a "foreign run" on every sample. It was my own process:
`npm run` spawns `sh -c vitest run …`, which carries no path, so the
watchdog's `grep -v wt-b2` exclusion never matched it. Three facts establish
this rather than assertion — the count was exactly 1 for the whole run and
dropped to 0 in the same sample the run ended; the 1-minute load never left
0.09–0.74, where a competing battery had previously shown 1.0+; and no third
database ever appeared on 5432. Reproduced afterwards: `ps` shows both
`sh -c vitest run …` (no path) and
`node /tmp/claude-0/wt-b2/node_modules/.bin/vitest …` (path present). The
round stands.

## The dataset, counted in the database

`P4-AL-73`'s `D-SALES` fat-tail arm at acceptance volume, realized and
asserted before any timing was taken:

| | realized |
|---|---|
| fat-tail customer, open invoices | **2 000** |
| …of which still carry a non-zero outstanding | **2 000** |
| fat-tail allocations | **4 000** |
| fat-tail payments / of them foreign currency | 200 / 23 |
| customer credits / credit applications | 40 / 20 |
| median customers / open invoices each | 60 / 3 (all sixty) |
| business invoices / allocations | 4 435 / 4 180 |
| dataset tier | `acceptance (D-SALES fat-tail arm)` |
| seed wall clock | 428.9 s |
| database size | **87 712 271 B** |

Relation sizes (`pg_total_relation_size`, bytes): `invoices` 4 374 528,
`sales` 3 072 000, `payment_allocations` 2 736 128, `payments` 270 336,
`customer_credits` 114 688, `customer_credit_applications` 98 304,
`businesses` 98 304, `customers` 90 112, `payment_methods` 65 536,
`accounting_fx_rates` 49 152.

`ANALYZE` state — every measured relation, none null (`P4-AL-74`):

| relation | rows | analyzed (UTC) |
|---|---|---|
| `invoices` | 4 435 | 2026-10-05T12:38:18.755Z |
| `sales` | 4 435 | 12:38:19.092Z |
| `payment_allocations` | 4 180 | 12:38:18.919Z |
| `payments` | 260 | 12:38:18.907Z |
| `customers` | 64 | 12:38:19.100Z |
| `customer_credits` | 40 | 12:38:19.105Z |
| `customer_credit_applications` | 20 | 12:38:19.093Z |
| `accounting_fx_rates` | 2 | 12:38:18.855Z |
| `businesses` | 1 | 12:38:19.200Z |
| `payment_methods` | 1 | 12:38:19.199Z |

## Sample counts, pacing and authentication

Every declared series carried its full **200** measured iterations, with 5
warm-up iterations discarded and never averaged in. Twelve series:

```
P4-D HTTP receivable                       200
P4-D HTTP receivable/aging                 200
P4-D HTTP open-invoices                    200
P4-D median (the ratio denominator)        200
P4-D daftar_app statements (RLS numerator) 200
P4-D owner statements (RLS denominator)    200
P4-F base-1 in-transaction / over HTTP     200 / 200
P4-F base-5 in-transaction / over HTTP     200 / 200
P4-F foreign-5 in-transaction / over HTTP  200 / 200
before-ANALYZE diagnostic                   30
```

Pacing against the product's own limiter (300 requests per 60 s per route
handler per client, `apps/api/src/app/runtime.ts:116`) — the limit was not
raised, the guard not disabled, no `429` retried into a sample, and every wait
happened outside a measured span:

| handler | requests | waited |
|---|---|---|
| `POST /v1/sales` | 4 435 | 711 992 ms |
| `POST /v1/customer-payments` | 875 | 98 478 ms |
| `GET /v1/customers/:id/receivable` | 447 | 24 906 ms |
| `GET /v1/customers/:id/receivable/aging` | 205 | 0 ms |
| `GET /v1/customers/:id/open-invoices` | 205 | 0 ms |
| `POST /v1/customer-credits/:creditId/applications` | 20 | 0 ms |
| `POST /v1/inventory/adjustments` | 2 | 0 ms |

**Re-authentications: 1**, at 600.8 s, through the product's own
`POST /v1/auth/login`, inside `pace()` and therefore outside every measured
span. The access token's lifetime is 900 s
(`apps/api/src/modules/auth/tokens.ts`) and the pacing wait alone is 835 s, so
a run of this fixture necessarily outlives its own bearer; the TTL is read
from the login response rather than copied into the suite, and is not raised.

## P4-D — the diagnosis

### What is measured

`GET /v1/customers/:customerId/receivable`, the real route in the real
composition, as `daftar_app` with row security applied. The statement is the
product's own (`apps/api/src/modules/selling/customer-reads.ts`):

```sql
SELECT r.currency_code, r.txn_minor::text AS txn_minor, r.base_minor::text AS base_minor
  FROM customer_ar_outstanding($1::uuid, $2::uuid) r
 ORDER BY r.currency_code NULLS FIRST
```

Fat-tail customer, 2 000 open invoices: `p95` **125.469 ms** against 100 ms,
with **107 of 200** samples above the ceiling (min 92.667, p50 100.913, p99
151.784, max 157.527). Median customer, 3 open invoices: `p95` **13.027 ms**.
Ratio **9.63×** against a maximum of 3×.

### The cause

The growth is **linear in the customer's open-invoice count**, and the
coefficient is one `plpgsql` function call per open invoice.

`customer_ar_outstanding` is `LANGUAGE sql STABLE` and set-returning, and its
body is

```sql
SELECT i.currency_code::TEXT,
       pg_catalog.sum(o.outstanding_txn_minor)::BIGINT,
       pg_catalog.sum(o.outstanding_base_minor)::BIGINT
  FROM public.invoices i
  JOIN LATERAL public.invoice_outstanding(i.business_id, i.id) o ON TRUE
 WHERE i.business_id = $1 AND i.customer_id = $2 AND i.status = 'open'
 GROUP BY i.currency_code
HAVING pg_catalog.sum(o.outstanding_txn_minor) <> 0;
```

PostgreSQL will not inline it, for **two independent reasons**, both read from
`pg_proc` on this 16.13 server:

1. **`proconfig` is set.** All three AR routines carry
   `search_path=pg_catalog, public, pg_temp`.
   `inline_set_returning_function` refuses a function with a SET clause before
   it ever examines the body, because the GUC has to be established around
   execution. This is a deliberate hardening, present on every routine in the
   estate.
2. **The body aggregates.** `sum(...)`, `GROUP BY` and `HAVING` each refuse
   inlining on their own (`hasAggs`, `groupClause`, `havingQual`).

`invoice_outstanding` is `plpgsql`, which is never inlinable under any rule,
and it is invoked through `JOIN LATERAL` **once per open invoice**. The suite
counted it: `invoiceOutstandingCallsPerRead: 2000`.

So the planner has nothing to choose, and the plan — captured in this run as
`daftar_app` with row security applied, on major 16 — is an opaque function
scan with no `invoices` node anywhere in the outer plan:

```
Sort  (cost=70.08..72.58 rows=1000 width=96)
  Sort Key: currency_code NULLS FIRST
  ->  Function Scan on customer_ar_outstanding r  (cost=0.25..20.25 rows=1000 width=96)
```

Fitting a line to the two measured points — 3 invoices at 13.027 ms, 2 000 at
125.469 ms — gives

- **marginal cost 56.3 µs per open invoice**,
- **fixed cost 12.858 ms**,

and that model reproduces both measured percentiles to three decimal places
(13.027 and 125.469). A linear fit that exact over a 667-fold range of row
count is strong evidence that the per-row call is the whole story and that
nothing else in the read grows.

### Three causes ruled out, not left open

- **It is not missing statistics.** Every measured relation has a non-null
  `last_analyze` above, and the same read taken *before* the seed's `ANALYZE`
  was **116.147 ms** — marginally *faster* than the 125.469 ms after it. The
  figure is not a figure about the planner's ignorance.
- **It is not the row-security policy.** The RLS instrument measures like
  against like, the same captured statements on the same rows with no HTTP
  envelope on either side: `daftar_app` 101.843 ms, schema owner with row
  security bypassed 60.235 ms, **ratio 1.691×** against the provisional 3×
  maximum. (This supersedes an earlier contended smoke indication near 4.4×,
  which was contention.) More decisively: even with row security entirely
  bypassed the statement alone costs 60.235 ms at 2 000 invoices, and with the
  23.626 ms HTTP envelope that is 83.9 ms against a 100 ms ceiling — so **no
  policy change can reach this budget**, and removing row security would only
  move the crossing point rather than fix the growth.
- **It is not the HTTP envelope.** The envelope is 23.626 ms
  (125.469 − 101.843) and it does not grow with the invoice count; the fitted
  fixed cost of 12.858 ms is of the same order. The growing term is the
  statement.

### Where the budget actually holds

With the as-shipped per-call cost of 50.9 µs (`daftar_app`, statements only)
and the measured 23.626 ms envelope, the 100 ms ceiling is met up to roughly
**1 500 open invoices for one customer**. `P4-AL-73`'s fat-tail customer has
2 000. The budget and the dataset were therefore specified about 25 % apart,
and the read crosses its ceiling before it reaches the volume the lock names.

### What the shape would have to become — proposed, not built

To bring the **ratio** to 3× with the same fixed cost, the per-invoice
marginal cost would have to fall from 56.3 µs to **12.9 µs — a 4.36×
reduction** — or stop being per-invoice at all.

The second is the real fix, and it is a reshaping of the body rather than of
the plan: compute every invoice's outstanding in **one set-based pass** over
`payment_allocations UNION ALL customer_credit_applications` grouped by
invoice, instead of a `LATERAL` scalar call per invoice. Two thousand
`plpgsql` invocations become one aggregate over two index ranges, and the
function may stay opaque, because opacity costs nothing here.

The constraint that shapes the fix is `P4-AL-07`: a second set-based body
beside `invoice_outstanding` would be a second copy of the settlement
arithmetic, which is the thing that article exists to forbid. The only honest
form is to make the set-based version the **one** definition and reduce
`invoice_outstanding(business, invoice)` to a thin single-row wrapper over it,
so one copy of the arithmetic remains.

Explicitly **not** proposed, and not to be revisited:

- removing the pinned `search_path` to reach inlinability — that trades a
  deliberate security hardening for milliseconds;
- a stored or cached balance — the second truth with a slower failure mode
  that `G-3` and `AL-15` forbid;
- an index — no index helps a per-row function call;
- moving the ceiling, in either direction. `min(hard cap, calibrated)` is
  tighten-only.

This needs a migration, which this slice does not own, and it is not
authorised. Nothing has been built for it.

### The answer-equivalence proof it would need

In the form `tests/performance/accounting-rls-equivalence.test.ts` actually
uses: a scratch database inside the same cluster; the accepted migration
history applied up to the migration **before** the change; seeded once; read
as `daftar_app` under the same tenant and business context with the product's
own statement **imported from the reader module** rather than copied; the new
migration then applied **to that very database** with nothing reset; and the
two results compared **byte for byte**.

For this change the subjects must include the fat-tail arm, the median
population, and deliberately adversarial cases: an invoice settled exactly to
zero so the `HAVING` drop is exercised, a multi-currency customer, an invoice
with credit applications and no allocations and the reverse, a
foreign-currency chain, a walk-in invoice with a null customer, a chain of two
or more legs, and a customer with no invoices at all. The subject list must be
driven from `SELECT DISTINCT customer_id FROM invoices` so no customer can be
omitted by a hand-written list, and the same proof is owed for
`customer_ar_aging` and for `invoice_outstanding` **per invoice**, since the
wrapper must answer identically for every single invoice too. The plan half is
stated as the narrow durable property — `invoice_outstanding` is no longer
invoked once per open invoice — never as a required plan node.

## P4-F — the diagnosis

In-transaction, 5 invoices, base currency: `p95` **41.724 ms** against 40 ms —
a **4.3 % overshoot**, with **15 of 200** samples above the ceiling (min
26.648, p50 30.472, p99 53.598, max 99.135). Over HTTP the same command is
56.509 ms against 100 ms, and the foreign-currency arm 59.916 ms, both PASS.

Unlike P4-D this is **not** a growth defect. The 1→5 scaling is 2.806× at
`p95` and 2.785× at `p50`, inside `P4-AL-72`'s 3× constant, and the
one-invoice arm is 14.870 ms `p95` against the same 40 ms ceiling. The
marginal cost is 4.883 ms per invoice at `p50`, and the central tendency —
30.472 ms at `p50` — sits comfortably inside the ceiling.

The miss is therefore in the **tail**: 92.5 % of samples are inside, and a max
of 99.135 ms against a 30 ms median is a stall, not a cost. Two things must be
said about it honestly:

- **I cannot attribute the tail from this run.** The suite prints
  `orderedMs`, which is the complete series *sorted*; the time-ordered series
  is not recorded, so I cannot see whether the slow samples cluster — which is
  exactly what would distinguish a checkpoint, a WAL segment switch or
  autovacuum from a uniformly heavier command. This is an instrument gap, named
  in full below, and I have not changed the instrument after seeing the
  numbers.
- **This server is configured more favourably than production.**
  `fsync=off synchronous_commit=off full_page_writes=off` is what CI's service
  runs, so it is the right basis for the gate, but it is not a deployment
  configuration. A 4.3 % miss here is, if anything, optimistic.

No policy, index or product query has been touched for it.

## Known gaps in this evidence

Stated rather than left for a reader to notice:

1. **Two of the three P4-D reads have no reported `p95`.** The
   `MEASUREMENT` case loops over receivable, aging and open-invoices and
   `assertWithin` throws on the first failure, so `receivable/aging` and
   `open-invoices` were never diagnosed. Both series exist and both carry
   their full 200 samples — the census above proves it — but their
   percentiles are unreported. The same fail-fast hides the
   `foreign-5` in-transaction figure.
2. **The time-ordered series is not recorded**, only the sorted one, which is
   what blocks the P4-F tail attribution above.
3. **The authoritative dataset no longer exists.** A later verification run
   `resetData()`-ed the shared database, so no post-hoc `EXPLAIN (ANALYZE)`
   can be taken against the exact rows these figures came from. The plans
   captured *during* the run, quoted above, are unaffected.

Each is a change to the instrument, each would improve the next round, and
none has been made in this diff: changing the instrument after seeing the
numbers is the thing that must not happen quietly.

## What this page does not claim

- It is not a claim about `P4-A` or `P4-B`, which are the POS read budgets and
  are measured elsewhere.
- It is not whole-`D-SALES` evidence. This is the **fat-tail arm** —
  `P4-AL-73`'s fat-tail customer, a median population, credits and credit
  applications so both arms of `invoice_outstanding`'s `UNION ALL` carry rows,
  and a payment-side foreign-currency share. The 20 000 customers, 200 000
  invoices and 20 000 installment plans sit inside `gate:phase4:s8` and P4-S8
  owns them.
- The invoice-side currency mix is still owed by the slice that unpins
  `price_currency`; on this head a product's `price_currency` is pinned to the
  business base currency, so the realized mix is on the payment side.
- The three missed budgets are **FAIL until diagnosed**. This page is the
  diagnosis. No ceiling or ratio moved in either direction to produce it.
