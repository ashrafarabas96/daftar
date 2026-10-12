# P13-PROOF-RLS — tenant and business isolation, asserted as a non-superuser

`tenant-isolation.pgtest.mts` is Phase 13's **first RLS evidence of any kind.**
Before it, the phase had a pure unit suite and a concurrency proof, and
neither can be denied a row: a fold held in memory has no tenant, no role and
no policy. The phase directive lists "RLS and permission tests" as outstanding
work, and the security part of the same directive sets the standard this file is
written to:

- **no superuser.** Every isolation assertion runs on a connection
  authenticated as an unprivileged role. The superuser connection builds the
  fixture and reads the catalogue, and never asserts that a row was or was not
  visible.
- **the role's own attributes are measured, not assumed.** Case 1 reads
  `pg_roles` and fails if the probing role is superuser or carries `BYPASSRLS`,
  so "we tested as a non-superuser" is itself evidence.
- **positive controls beside negative ones.** A schema that denies everything —
  a revoked grant, a missing `GRANT USAGE`, a deny-all typo — would pass every
  negative case and prove nothing. Case 2 proves the permitted capability works.
- **a mutation control.** Case 6 drops one policy, shows the leak appears,
  restores it, and shows the leak goes. A guard that does not go red when
  removed is not a proof of anything.

## How to run it, and the version it must run on

**Precondition: the `en_US.utf8` locale must be generated.** A minimal image has
only `C`, `C.utf8` and `POSIX`, and `initdb --locale=en_US.utf8` then dies with
`invalid locale name` — a failure that names neither cause nor cure, as an
independent challenge measured (`0/1 cases passed`, rc=1). This proof now checks
the locale **before** `initdb` and refuses with the command that fixes it:

```
localedef -i en_US -f UTF-8 en_US.UTF-8
```

`UTF-8` is the charmap's spelling; `localedef -f utf8` fails with `cannot open
charmap`, so the printed command does not echo the locale name PostgreSQL
reports. Measured: with `P13_PG_LOCALE=zz_ZZ.utf8` the proof exits **1** before
any cluster is created. Unlike the concurrency proof, this one has **no**
version fallback at all: an RLS result on an unchosen major line is not the
evidence that was asked for.

```
export PATH=<node 24 bin>:$PATH
cd /home/user/daftar
node packages/analytics/test/rls/tenant-isolation.pgtest.mts
echo "RC=$?"
```

Observed: **8/8 cases passed, RC=0** on PostgreSQL **16.15** with
`datcollate=en_US.utf8 datctype=en_US.utf8 encoding=UTF8`, all read back from
`pg_database` and printed by the run.

Unlike the concurrency proof beside it, **this file has no fallback to another
major version.** It refuses to run if it cannot find PostgreSQL 16 binaries, and
says why: the deploy line is settled as the PostgreSQL 16 family, and an RLS
result on an unchosen version is not the evidence that was asked for.

It is `.mts` under `test/rls/`, deliberately outside the package's vitest
pattern (`test/**/*.test.ts`), so the unit suite stays cluster-free. That suite
still reports `rc=0`, and the case count for a given SHA is the generated row in
`P13-HANDOFF-MANIFEST.md` §3.5 rather than a second copy here: a figure typed into a
README is gated by nothing, and F-18 of a challenge round found three of them stale.

## What it does not touch

`infrastructure/database/migrations/**` is byte-frozen. **No migration file is
read, copied or applied.** The DDL is scratch and unnumbered, lives only in a
throwaway cluster that is stopped and deleted in a `finally` on success and
failure alike, and carries no migration number and no `.sql` file anywhere.

The policy shape **mirrors** the live pattern rather than inventing one: the
PERMISSIVE tenant-membership policy plus the RESTRICTIVE business-isolation
policy, `ENABLE` **and** `FORCE ROW LEVEL SECURITY`, and the
`app_tenant()` / `app_business()` / `app_bypass()` helpers.

Applying the real migration history is **not** done here, and the reason is a
standing ruling rather than convenience: migration application belongs to the
deployment principal under the sealed Deployment Authority contract, and the
same ruling says a superuser applying migrations successfully in CI must not be
equated with the real deployment role applying them correctly. Doing it here as
a superuser would manufacture exactly the evidence that ruling forbids relying
on.

## The cases, and what was actually observed

| # | Case | Outcome | Observed |
|---|------|---------|----------|
| 1 | the probing role's attributes and the relations' RLS flags | **PROVEN BY DATABASE CATALOGUE** | `superuser=false bypassrls=false createdb=false createrole=false replication=false`; both relations `rowsecurity=true forcerowsecurity=true` |
| 2 | **positive control** — own tenant and business context | reads and writes its own rows | 3 rows visible; an `INSERT` into its own business `accepted` |
| 3 | **negative** — the sibling business in the same tenant | invisible **and** unwritable | 0 rows visible whose business is not its own (while the superuser counts 2 in the sibling); an `INSERT` naming the sibling refused **`42501`** from the policy `WITH CHECK` |
| 4 | **negative** — the *correct* business id under the *wrong* tenant | invisible | 0 rows. A leaked or guessed business id is **not** sufficient on its own |
| 5a | **negative** — no tenant or business context set at all | **fail-closed** | 0 rows. A request that forgets its context reads nothing, not everything |
| 5b | **escalation attempt** — the role sets `app.bypass_rls = 'true'` itself | **inert** | visibility unchanged at 4 rows, of 10 that exist. The case first prints the live `app_bypass()` body from the catalogue and fails if it still reads the GUC, so it cannot pass against the wrong shape |
| 6 | **mutation control** — drop the RESTRICTIVE business policy | **RED on removal, green on restore** | 0 sibling rows → **2 leaked** → 0 again |
| 7 | **append-only** — `UPDATE` and `DELETE` as the runtime role | both refused by the **grant** | **`42501`** for each; `information_schema.role_table_grants` confirms the role holds exactly `INSERT, SELECT` |
| 8 | **negative** — an aggregate and a `GROUP BY` aimed across the boundary | neither rows nor counts nor groups cross | the sibling-filtered aggregate returns `rows=0, sum=NULL`; the `GROUP BY` returns exactly **one** group, its own |

## The escalation case is the one worth reading twice

Case 5b is not hypothetical. This project's migration history defined
`app_bypass()` **five different ways**, and the first one was:

```sql
SELECT coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
```

A **client-settable GUC**. Any connected role could `SET` it and read every
tenant. The second definition narrowed it with `AND current_user <> 'daftar_app'`
— still a GUC, now with one role excluded. The third replaced the GUC with a
pure role check, and the live form at the frozen head is a role check against
`daftar_platform` alone.

So the escalation **was** open and **is** closed, and case 5b measures the
closure rather than trusting the reading. It also guards itself: it reads the
function's own body out of `pg_get_functiondef` and **fails** if the body still
mentions `bypass_rls`, because a case that proves a GUC is inert is worthless if
the function under test was never the GUC form.

`CREATE OR REPLACE` means the last definition in apply order wins, and apply
order is migration order. **Verifying that the real history leaves the role form
in place on a real deployment is the deployment path's proof, not this one's.**

## Two test bugs this proof caught in itself, recorded because both are easy to repeat

1. **Case 3's first draft asked the wrong question.** It set the business
   context *to* the sibling business and then asserted zero rows — so it asked
   the sibling's own session whether it could see the sibling's own rows, and
   failed because the answer was correctly "yes, two of them". That is the
   positive control again under a different name, not an isolation test. The
   isolation question is the other way round: a session scoped to **its own**
   business must see nothing of the sibling's.
2. **Both drafts asserted on counts, which an earlier case had legitimately
   changed.** Case 2's `INSERT` is part of its positive control, so any later
   case keyed to "3 rows" becomes wrong the moment case 2 passes. The cases now
   assert on **content** (`count(*) WHERE business_id <> its own` must be zero)
   and compare against what the superuser can see, so they cannot be perturbed
   by a legitimate write.

Both are instances of one thing: **a test that passes for the wrong reason is
worse than a test that fails**, because it is quoted later.

## What remains UNMEASURED

- **The real relations.** There is no Phase 13 DDL yet and no migration number
  is allocated, so this proves the *shape* isolates. That the relations which
  eventually ship carry these policies is established from the catalogue at
  integration, by the Migration Owner.
- **The real role.** `daftar_app_probe` is created here with exactly the
  attributes and grants the design asks for. Whether the real `daftar_app` in a
  candidate or staging database carries any elevated attribute is a read-only
  `pg_roles` check on that database, by its own authority — and a standing
  ruling is explicit that a fixture finding about role attributes is not
  evidence about a real deployment's roles.
- **The API and HTTP layers.** A policy that isolates rows says nothing about a
  route that forgets to set the context, or an endpoint that leaks a count in an
  error message. Case 5a proves the database fails closed when the context is
  missing, which is the backstop, not the fix.
- **`SECURITY DEFINER` boundaries**, cross-tenant cache keys, and export
  authorization — all in the phase's security scope, none of them reachable from
  a scratch schema with no application in front of it.
- **Any timing figure.** None is asserted and nothing sleeps.
