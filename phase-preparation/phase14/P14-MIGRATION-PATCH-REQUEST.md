# MIGRATION PATCH REQUEST — PHASE 14
## Integrations, Public API, Developer Platform

> **PART 10 compliance.** This document allocates **no migration number**,
> creates no file in `infrastructure/database/migrations/`, and edits no
> manifest. The Migration Owner reads the live prefix, allocates, creates and
> verifies. Nothing here reserves a number speculatively.
>
> **Live boundary at the time of writing:** `frozenThrough =
> 0079_phase4_pos_till_sessions_cart.sql`
> (`infrastructure/database/MIGRATION_MANIFEST.json`); `0080`–`0086` exist on
> the Phase 4 branch as **unfrozen S4/S5/S6/S7 candidates**. **Nothing in this
> request touches `0000`–`0086`.** Every object below is new.
>
> **Status: `PREPARED / NOT PROMOTED`.** Submitted for Tech Lead ruling and,
> on promotion, for the Migration Owner's allocation.

### ملخص عربي

هذا **طلب تعديل قاعدة بيانات** لا يحمل رقمًا ولا ينشئ ملف migration — مالك
الـmigrations وحده يرقّم ويطبّق. كل الجداول جديدة ولا تلمس أي migration مجمّد.
أهم نقطتين للمراجعة:

- جدول `api_scopes` **سجل مغلق**: النطاق المسموح موجود كصف في القاعدة ومرتبط
  بمفتاح أجنبي، فإدخال نطاق مزيّف عبر SQL مباشر **ترفضه القاعدة** لا التطبيق.
- أسرار توقيع الـwebhook مُشفّرة (AES-256-GCM) بحلقة مفاتيح **منفصلة** عن حلقة
  مفاتيح رسائل الاعتماد، ولا يقرأها دور التطبيق مطلقًا — فقط دور العامل.

> **NO NUMBER, NO FILENAME, NO EXAMPLE (Migration Owner's rule 1).** This
> request proposes no migration number, no filename and no example of either,
> in prose, in a comment or anywhere else. **Every number that appears below is
> an existing, already-applied migration cited as precedent or as a boundary
> fact** under PART E §6, which requires a citation; none is a proposal, a
> reservation or a pattern for the migration this request asks for. The
> Migration Owner reads the live prefix and allocates.
>
> It does name, exactly as that rule requires: the relations, every column with
> its type and `CHECK`, every key and index, every policy and grant, every
> trigger, and the invariant each one enforces.

> **Evidence classes (standing law PART E §6).** Every line in this document is
> one of: **PROVEN IN LIVE CODE** — it carries a `file:line` or a migration
> filename read in the tree at `93084f8`; **DESIGN ONLY** — everything proposed
> for Phase 14, which has no implementation; **UNMEASURED** — every gate, test
> and threshold named here, none of which has been executed. No line is PROVEN
> BY TEST or PROVEN BY DATABASE CATALOGUE, because nothing of Phase 14 has been
> run. **No timing or performance number is claimed anywhere in this pack**
> (PART E §5): this container is a different box and a number from it would not
> be comparable.
>
> **Base limitation, stated rather than discovered later:** this pack was read
> from the branch's **remote** head `93084f8`. The Phase 4 coordinator's
> checkpoint of 2026-10-07 records two **unpushed** local commits (`54a851c`,
> `f6f2e0b`) that this thread could not see. Both are Phase 4 receivables work
> (the S4 aging-bucket fix); neither touches any surface Phase 14 binds to —
> the guard, the permission registry, the outbox publisher, the rate limiter or
> the RLS helpers. If that changes, §2 of the architecture lock must be re-read
> against the assembled head before promotion.

---

## §0. House conventions this request follows

Read from the live tree at `93084f8`, so the DDL below is in the repository's
own idiom rather than a generic one:

- Business-scoped tables carry `business_id` in a **composite primary key**
  `(business_id, id)` and composite foreign keys, so a child can never point at
  a parent in another business (`0003_tenancy.sql:24-54`).
- RLS is `ENABLE` **and** `FORCE`, with the accepted two-policy shape: a
  PERMISSIVE `tenant_membership` policy and a RESTRICTIVE `business_isolation`
  policy, both `USING` and `WITH CHECK`, so an unset `app.business_id` yields
  **zero** rows (`0006_rls.sql:28-48`).
- A role-scoped read uses `current_user IN (...)` inside the policy — no
  `SECURITY DEFINER` wrapper (`0020_credential_delivery_outbox.sql:29-34`).
- A closed vocabulary is a table with a regex `CHECK` and a `registered_by`
  column, `REVOKE ALL ... FROM PUBLIC` (`0054_inventory_assertion_authority.sql:52-56`).
- Recoverable secrets are stored as `*_ciphertext` / `*_nonce` / `key_version`,
  encrypted application-side, with `daftar_app` holding a **column-scoped**
  SELECT that excludes them (`0025_credential_payload_protection.sql:1-27`).
- Worker claims use `locked_at` / `locked_by` / `lease_until` plus
  `FOR UPDATE SKIP LOCKED` (`0025_credential_payload_protection.sql:26-28`, `publisher.ts:45`).

## §1. The authentication chicken-and-egg (read this first)

A key must be resolved **before** any business context exists, but every
business-scoped table is default-deny without `app.business_id`
(`0006_rls.sql:25`). This is the same problem the system already solved for
`users` and `sessions`, and it takes the same answer: a narrow, role-keyed
read.

**Resolution path, exactly:**

1. A short transaction on the **`daftar_identity`** role selects the key row by
   `key_id`, with **no** business GUC set, permitted by a policy keyed on
   `current_user`. The column set is derived from the statements the resolver
   actually runs, not from the fields the predicate reads
   (**V2 FINDING 2**):

   | Column | Why the resolver needs it |
   |---|---|
   | `key_id` | the `WHERE` clause. PostgreSQL requires the `SELECT` privilege on a column a query **restricts on**, not only on one it returns; a column-scoped grant that omits it refuses the lookup itself |
   | `id` | the join key to `api_key_scopes (business_id, api_key_id)`, and the row identity the `last_used_at` write names later |
   | `tenant_id`, `business_id` | the GUCs set for the business transaction |
   | `subject_user_id` | the delegating member, whose live permissions are intersected |
   | `secret_sha256` | compared in the application |
   | `expires_at`, `revoked_at` | **the only** inputs to the usability predicate |

   **Deliberately NOT in the set, and this is the derivation, not a trim
   (CHALLENGE P1-01, settled EIGHT):**

   | Column | Why the resolver must not read it |
   |---|---|
   | `revoke_scheduled` | **`P14-AL-29`** (not `P14-AL-11`, which is idempotency — misattributed in the previous revision, CHALLENGE R2 (a)): *a boolean of intent is written at write time and **never read to decide usability***. The resolver's only purpose in reading this row **is** to decide usability, so for the resolver the two are the same act — which is why the exclusion follows from the law **for this principal only**. It does not follow for `daftar_app`, which §11.1 grants `SELECT` and `UPDATE` on this column so the management surface can display and set the intent: that is a reader, and a permitted one. **The independent reformulation "a resolver that selects it is a reader of it" dropped the qualifier and would have invalidated that grant two sections later.** The qualifier is the law. Independently of it, the exclusion stands on the same ground as `name`: minimal reach for the one principal that reads every key digest in every business |
   | `name` | management data. Error and audit context is read in the business transaction by `daftar_app`, which already holds it. Granting it to the one role that can read **every** key row's digest across **every** business widens the blast radius of the most privileged principal in the pack for no authentication purpose |

   The previous revision listed neither `key_id` nor `id`, so the resolver as
   written could not have performed its own lookup or its scope join. The
   failure would have surfaced as a permission error on the `WHERE` clause,
   which reads like a policy problem and is not one. **A grant is never widened
   to make an error go away**: the column set follows from the query, the query
   is stated here, and any addition to it is a ruling, not a repair.

   **EXECUTED, PostgreSQL 16.15 @ `en_US.utf8`, non-superuser (case `C9`).**
   The revision before this one derived **ten** columns here while §3 granted
   **eight** and argued for eight on security grounds. Under §3's grant
   verbatim, the ten-column resolver `SELECT` is refused with `SQLSTATE 42501`
   — *the authentication path refuses every request* — and each omitted column
   was isolated as a cause rather than inferred (`C9a`, exit 0). The
   eight-column query and the usability predicate both execute and return
   `usable = t` (`C9b`, exit 0), and withdrawing `secret_sha256` turns that arm
   red (`C9c`, exit 3), so the arm tests the grant and nothing else.
   **§3 was right and this section was wrong.** Both now read eight, and so
   does §11.1
   (`P14-AL-29`).

   `daftar_app` holds no `SELECT` on `secret_sha256` and no access at all to the
   endpoint signing-secret columns, under every revision of §11.

   **There is no `status` column and the resolver must not name one** (§3; MISSION
   FIX 1). An earlier revision listed `status` in this very sentence while §3
   declared the column non-existent: a reader implementing the resolver from §1
   would have written `SELECT ... status ...` and the authentication path would
   fail to compile against the schema. The predicate is **derived, in SQL, from
   real columns**, and it is the single definition of usability:

   ```sql
   (revoked_at IS NULL OR revoked_at >  now())
   AND
   (expires_at IS NULL OR expires_at >  now())
   ```

   **Both halves are parenthesised, and this is a correction, not a restatement
   (V2 FINDING 1).** The revision written this morning read
   `revoked_at IS NULL OR revoked_at > now() AND (expires_at ...)`, and `AND`
   binds tighter than `OR`, so it parses as
   `revoked_at IS NULL OR (revoked_at > now() AND (...))`: **a key that was never
   revoked would have been accepted however long ago it expired.** The expiry
   check was unreachable for exactly the keys it exists to stop. The defect was
   in an expression a reader scans as obviously right, which is why the
   executable predicate — not the prose around it — is what the test asserts.

   Three properties the comparison fixes, each with its own test (§14):
   - **the boundary refuses.** `>` not `>=`: at exactly `revoked_at = now()` or
     `expires_at = now()` the key is **refused**. A key is not usable in the
     instant it expires.
   - **the clock is the server's**, taken from the database in the same
     statement per the contract. No client-supplied time reaches this predicate.
   - **the two conditions compose.** A key both expired and revoked is refused,
     and the refusal code is chosen from the facts rather than from a second,
     invented condition.

   The refusal is chosen from the same two columns and never from a stored word:
   `revoked_at <= now()` → `API_KEY_REVOKED`; `expires_at <= now()` →
   `API_KEY_EXPIRED`; no row, or a digest mismatch → `API_KEY_INVALID`. A
   catalogue test asserts that every column the resolver names exists on
   `api_keys` (§14), because a comment cannot keep a query and a schema in
   agreement.
2. The digest is compared in the application with `timingSafeEqual`
   (`apps/api/src/modules/auth/tokens.ts:112`). Nothing about the comparison happens in SQL, so no
   SQL-level timing or error-message difference can leak which half matched.
3. The resolved `tenant_id` / `business_id` then set the transaction-local GUCs
   for the **business** transaction, which runs as `daftar_app` under the
   ordinary policies. From that point the request is indistinguishable from a
   merchant web request (`P14-AL-01`).

Consequences that must be stated and tested, not assumed:

- `daftar_identity` can read **every** key row's digest. That is the same reach
  it already has over `sessions`, and it is the reach PART 13 calls intentional
  for internal authorities. It is also why the table holds a digest and never a
  secret.
- `daftar_app` must **not** hold the cross-business read: it gets the ordinary
  business-scoped policies, so a compromised merchant request path cannot
  enumerate keys.
- **No `SECURITY DEFINER` function is created for this** (`P14-AL-22`). A
  definer here would read as its owner through one policy and could not
  distinguish absent from invisible — the failure this project already
  documented.

## §2. Closed registries

### `api_scopes`
```
scope          TEXT PRIMARY KEY CHECK (scope ~ '^[a-z]+(\.[a-z_]+)+$')
registered_by  TEXT NOT NULL CHECK (registered_by ~ '^P14-S[0-9]+$')
```
- Rows inserted by the migration: exactly the scope set of
  `P14-S0-ARCHITECTURE-LOCK.md` §4.
- `REVOKE ALL ON api_scopes FROM PUBLIC`; `GRANT SELECT` to `daftar_app` and
  `daftar_identity` only.
- **No RLS** — it is a global vocabulary, not business data, exactly as
  `inventory_operation_kinds` is.
- **Bijection obligation (CI, not DDL):** the TypeScript `PUBLIC_API_SCOPES`
  set and these rows must be equal in both directions, and each side's gate
  must have a planted red proof. A count check is explicitly **not** sufficient
  (`P4-SLOT4-ROSTER-PROOF-LAW.md`).
- Every row must also be a member of `PERMISSIONS` (`permissions.ts:11`) and
  **not** a member of `SENSITIVE_PERMISSIONS` (`permissions.ts:97`) — asserted
  by the same gate, because the database cannot know the TypeScript registry.

### `webhook_event_types`
```
event_type     TEXT PRIMARY KEY CHECK (event_type ~ '^[a-z]+(\.[a-z_]+)+$')
registered_by  TEXT NOT NULL CHECK (registered_by ~ '^P14-S[0-9]+$')
```
Rows: the catalogue of `P14-CONTRACT-PACK.md` §9. Same grants, no RLS. A
subscription's FK to this table makes an unknown event type a **database**
refusal, not an application one.

## §3. `api_keys`

```
business_id      UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE
id               UUID NOT NULL DEFAULT gen_random_uuid()
tenant_id        UUID NOT NULL                       -- denormalized for the pre-context read
key_id           TEXT NOT NULL UNIQUE CHECK (key_id ~ '^[0-9a-z]{26}$')
secret_sha256    TEXT NOT NULL CHECK (secret_sha256 ~ '^[0-9a-f]{64}$')
subject_user_id  UUID NOT NULL REFERENCES users(id)  -- the delegating member
name             TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80)
created_by_user_id UUID NOT NULL REFERENCES users(id)
created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
expires_at       TIMESTAMPTZ                          -- NULL = no expiry
revoked_at       TIMESTAMPTZ
revoked_by_user_id UUID REFERENCES users(id)
revoked_reason   TEXT CHECK (revoked_reason IS NULL OR char_length(revoked_reason) BETWEEN 1 AND 200)
revoke_scheduled BOOLEAN NOT NULL DEFAULT false   -- true when revoked_at is a future, configured timestamp
replaces_api_key_id UUID                           -- the predecessor this key was minted to replace
last_used_at     TIMESTAMPTZ
PRIMARY KEY (business_id, id)
FOREIGN KEY (business_id, replaces_api_key_id) REFERENCES api_keys(business_id, id)
CHECK ((revoked_at IS NULL AND revoked_by_user_id IS NULL AND revoked_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL))
```

- `key_id` is **globally** unique: it is the lookup handle before any business
  context exists (§1), so it cannot be scoped to a business.
- `tenant_id` is denormalized deliberately. The pre-context read runs with no
  business GUC; joining to `businesses` there would need a second role-keyed
  policy on `businesses`, widening a frozen table's reach for this phase's
  convenience. A `CHECK`-able invariant instead: a trigger asserts
  `tenant_id = (SELECT tenant_id FROM businesses WHERE id = business_id)` on
  insert. Denormalization without that assertion would be a second truth.
- No `status` column: status is **derived** from `revoked_at` and `expires_at`.
  A stored status could disagree with them. **A `revoked_at` in the future is a
  scheduled revoke** (Directive 11 PART 95): the key is revoked only when
  `revoked_at <= now()`, the auth predicate reads it that way, and the
  management surface shows “revokes at” rather than “revoked”. `revoke_scheduled`
  exists so that a scheduled revoke is a stated intent rather than something a
  reader infers from a comparison, and a trigger asserts the two agree.
- **`replaces_api_key_id` makes an overlap a readable fact** (PART 95: no
  hidden, hard-coded grace window). A replacement minted during rotation names
  its predecessor; the composite FK keeps both keys in the same business; the
  column is NULL for an ordinary key. There is no default overlap and no
  indefinite overlap — the predecessor's own `revoked_at` ends it, now or at a
  configured timestamp.
- **No authorization cache anywhere** (PART 95: revocation takes effect at the
  auth check). The resolver reads this row per request; that is what the unique
  index on `key_id` is for.

- **MISSION FIX 3 — one derivation, four readers.** The Mission requires the
  scheduled revoke, the consistency trigger, the listing surface and every
  time-derived behaviour to agree, “دون قيمة منطقية قديمة”. There is exactly one
  definition, the predicate in §1, and these are all of its readers:

  | Reader | What it must do |
  |---|---|
  | the auth predicate (§1) | refuse only when `revoked_at <= now()` or `expires_at <= now()`; a future `revoked_at` is **usable** |
  | the listing surface (`GET api-keys`) | derive the displayed word from the same two columns in the same statement; show `revokes_at` for a future `revoked_at`, never the word “revoked” |
  | the `api_keys_revocation_consistent` trigger | evaluated **only when an intent field changes** — see the correction below |
  | the rotation command | may set a future `revoked_at` on the predecessor only, and only with `revoke_scheduled = true`; may never set one on the key it is minting |

  `revoke_scheduled` is therefore a **write-time assertion of intent, never a
  source of truth at read time.** This is the one thing a careless reader gets
  wrong here, so it is stated as a law: a scheduled revoke whose instant has
  passed carries `revoke_scheduled = true` and a `revoked_at` in the past, and
  it is **revoked** — the boolean does not become false on its own, no job
  rewrites it, and **no reader may consult it to decide usability.** A reader
  that branched on the boolean would serve a revoked key.

  **V2 FINDING 3 — the trigger as written would have refused unrelated
  updates, and the fix is not to soften it.** The previous revision evaluated
  `revoke_scheduled = (revoked_at IS NOT NULL AND revoked_at > now())` on
  **every** UPDATE. Once a scheduled instant passes, that equality is false by
  construction — `revoked_at` is now in the past while the boolean stays `true`,
  which is the correct state — so the next write of `name` or `last_used_at`
  would have been refused with a revocation error. The key keeps working and its
  **metadata becomes unwritable**, which is a confusing failure a long way from
  its cause. The flaw is deeper than a missing condition: a constraint whose
  truth depends on `now()` is **clock-derived mutable truth**, and a row that
  satisfied it at write time stops satisfying it with the passage of time alone.

  The rule instead: **`revoked_at` and `revoke_scheduled` are the intent fields**,
  and the trigger's check runs on `INSERT`, and on `UPDATE` **only when one of
  those two columns is actually changed** — in which case `now()` is again the
  instant of a write, not of an unrelated read. An update that leaves both
  untouched passes without the comparison being made at all. `revoked_at` is
  additionally append-once: it may go from `NULL` to a value, or move **earlier**
  (revoking sooner than scheduled), never later and never back to `NULL`, so a
  scheduled revoke cannot be quietly postponed.

  **Who settles the rest.** Which further fields count as intent, and whether
  metadata writes on a revoked key are permitted at all, belong to the contract
  owner together with `TL-P14-SEC-01`: a revoked key whose `name` can still be
  edited is a product question, not a schema one. This request states the
  mechanism and does not decide it. The tests in §14 pin the behaviour either
  way: minted at `T0`, accepted before `T`, refused **at** `T` and after, and an
  unrelated metadata update tried on both sides of `T`.
- `last_used_at` is written at most once per key per **configured interval**,
  **outside** the business transaction. A write per request would turn every
  public read into a row-level write hotspot on the key row and serialize an
  integration against itself. **There is no default and no value is proposed
  here (CHALLENGE P2-04).** The earlier revision wrote `5 minutes`, which is
  the identical species to the `300s` Mission FIX 6 struck by name, and it is
  not harmless: the interval sets how stale `last_used_at` may be, and
  `last_used_at` is what a merchant reads to answer *"is this key still in use,
  can I revoke it?"* — a staleness window on a revocation-decision signal is an
  operational value. It is therefore `OD-P14-11`, fail-closed: with no value
  configured the service refuses to start rather than choosing one.

**The global-FK species on `subject_user_id` (CHALLENGE P3-05).** §7a raises
`webhook_deliveries.outbox_event_id -> outbox_events(id)` as a global FK from a
business-scoped child and escalates it to three owners. The identical shape
appears here and was **not** disclosed: `subject_user_id -> users(id)`,
`created_by_user_id`, `revoked_by_user_id`, and `webhook_endpoints.created_by_user_id`
likewise. `subject_user_id` is the load-bearing one — it is **the delegating
member whose live permissions become the key's authority**. A `subject_user_id`
naming a user with no membership in the key's business is accepted by the
schema: the row inserts and no constraint fires.

It **fails closed at runtime**, which is why this is disclosed rather than
blocking: effective authority is `live_membership_permissions ∩ key_scopes`
computed per request for `(subject_user_id, business_id)`, so a subject with no
membership in that business yields an empty intersection and a powerless key
(`P14-AL-02`). But that is a **single application-layer defence on the pack's
most load-bearing column**, with no database invariant, in a request that
escalated the same species one section earlier. Stated as a choice rather than
left silent: the intersection is the only guard, and a membership-binding
assertion is `TL-P14-SEC-03`, raised to the Security Owner on the §7a
precedent — with the grant consequence §7a now records, since an
invoker-rights assertion over `users` would need a read the key-management
role does not hold.

**Indexes**
```
UNIQUE (key_id)                                        -- the auth lookup, one index hit
(business_id, created_at DESC)                          -- the management list
(business_id, subject_user_id) WHERE revoked_at IS NULL -- "which live keys break if I revoke this membership?"
```

**Immutability trigger (`P14-AL-08`)** — `BEFORE UPDATE`, raising
`integrations.key_identity_immutable` when `key_id`, `secret_sha256`,
`business_id`, `tenant_id`, `subject_user_id` or `created_at` would change.
Revocation and `last_used_at` remain updatable. This is what makes "rotation =
create + revoke" a database fact rather than a convention.

**RLS** — `ENABLE` + `FORCE`:
- PERMISSIVE `tenant_membership` and RESTRICTIVE `business_isolation`, the
  accepted shape (`0006_rls.sql:38-47`), for the management path.
- One additional PERMISSIVE policy for the pre-context read:
  `FOR SELECT USING (app_bypass() OR current_user = 'daftar_identity')`.
  **Exactness matters here:** a RESTRICTIVE policy narrows *every* role unless
  it is role-scoped, so the accepted `business_isolation` text copied verbatim
  would make the pre-context read return zero rows. Its `USING` on this table
  must therefore read
  `app_bypass() OR current_user = 'daftar_identity' OR business_id::text = app_business()`
  and its `WITH CHECK` must **not** carry the `daftar_identity` disjunct — the
  resolver reads, it never writes.
  **The extended policy is `FOR SELECT`, not `FOR ALL` (CHALLENGE P3-06).**
  `WITH CHECK` does not apply to `DELETE`, which is governed by `USING` alone,
  so a `FOR ALL` policy carrying the identity disjunct in `USING` would place
  **no business isolation on a `DELETE` by `daftar_identity`**. Nothing is
  reachable today — §11.1 grants `DELETE` to nobody — but that leaves the
  isolation of this role resting on a grant never being widened, in the policy
  whose stated purpose is to be the second line of defence. `FOR SELECT` costs
  nothing and removes the dependency. The management path keeps the accepted
  `FOR ALL` pair unchanged.
  This is the one place where the two-policy shape is deliberately extended,
  and a test asserts both halves: the identity role can SELECT with no business
  GUC, and cannot INSERT or UPDATE at all.
- `GRANT SELECT (business_id, id, tenant_id, key_id, secret_sha256,
  subject_user_id, expires_at, revoked_at) ON api_keys TO daftar_identity` —
  exactly those eight columns, no INSERT/UPDATE/DELETE. `name`,
  `revoke_scheduled`, `created_by_user_id`, `revoked_by_user_id`,
  `revoked_reason` and `last_used_at` are management data the resolver has no
  reason to read, and a column it cannot read is a column it cannot leak.
  **This set is now the settled one (CHALLENGE P1-01): §1 derives the same
  eight and §11.1 grants the same eight, and the equality is asserted by
  `P14-GATE-033`, which reads every section of this request that names a grant
  rather than a named pair of sections.**
- `daftar_app`: `SELECT, INSERT, UPDATE` under the business policies.
  `DELETE` is granted to **nobody**: a key is revoked, never deleted, or the
  audit trail of a leak has a hole in it.

## §4. `api_key_scopes`

```
business_id  UUID NOT NULL
api_key_id   UUID NOT NULL
scope        TEXT NOT NULL REFERENCES api_scopes(scope)
PRIMARY KEY (business_id, api_key_id, scope)
FOREIGN KEY (business_id, api_key_id) REFERENCES api_keys(business_id, id) ON DELETE CASCADE
```

- A child table, not a `TEXT[]` column, precisely so the FK exists: a scope
  inserted by direct SQL that is not a registered scope is refused **by
  PostgreSQL** (PART 22's "DB-level direct SQL protection").
- Same RLS shape as `api_keys` for the management path, plus the role-keyed
  SELECT for `daftar_identity` (the resolver needs the scopes in the same
  pre-context read).
- A key with zero scope rows is valid and **powerless** — every scoped route
  refuses it. That is the correct degenerate case: an empty intersection is
  empty (`P14-AL-02`).
- `UPDATE` is granted to nobody: a scope row is inserted or deleted, which
  keeps the audit interpretation unambiguous.

## §5. `webhook_endpoints`

```
business_id          UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE
id                   UUID NOT NULL DEFAULT gen_random_uuid()
url                  TEXT NOT NULL
                     CHECK (url ~ '^https://[^[:space:]]{1,2000}$')
                     CHECK (url !~ '^https://[^/?#]*@')   -- D11 PART 96: no credentials/userinfo
description          TEXT CHECK (description IS NULL OR char_length(description) BETWEEN 1 AND 200)
secret_ciphertext    TEXT NOT NULL
secret_nonce         TEXT NOT NULL
key_version          TEXT NOT NULL
status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled'))
consecutive_failures INT NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0)
disabled_at          TIMESTAMPTZ
disabled_reason      TEXT
created_by_user_id   UUID NOT NULL REFERENCES users(id)
created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
PRIMARY KEY (business_id, id)
UNIQUE (business_id, url)
CHECK ((status = 'active' AND disabled_at IS NULL)
    OR (status = 'disabled' AND disabled_at IS NOT NULL AND disabled_reason IS NOT NULL))
```

- The two `CHECK`s are **defence in depth, not the guard.** The real check is
  the dispatch-time resolve-and-validate of `P14-AL-15` as widened by Directive
  11 PART 96; a regex cannot know that a hostname resolves to
  `169.254.169.254`, nor that it will resolve there on the fourth retry. The
  userinfo `CHECK` is worth having at the column anyway, because
  `https://victim@internal/` is the one hostile URL that a *parser* can get
  wrong before any resolution happens.
- `UNIQUE (business_id, url)` stops one business registering the same URL ten
  times and multiplying its own fan-out.
- A cap on endpoints per business is enforced in the application (a `CHECK`
  cannot count sibling rows) and is tested. The **value is configuration** with
  no production default — `OD-P14-07` is **withdrawn** and this was a stale
  reference to it (V2 FINDING 8); thresholds are configured and never guessed
  (Directive 11 PART 97).
- **Secret columns**: `GRANT SELECT` on them to the delivery worker role only.
  `daftar_app` gets a column-scoped SELECT that **excludes** all three, exactly
  as `0025` does for credential payloads, and INSERT/UPDATE of them only
  through the management command. The key ring is **domain-separated** from the
  credential-delivery ring (`P14-AL-14`); the AAD binds
  `(business_id, endpoint_id)` so ciphertext cannot be moved between endpoints
  (`credential-protector.ts:15-19`).
- RLS: the accepted two-policy shape. **How the context-free delivery worker
  reaches these rows is NOT settled here** — an added PERMISSIVE policy would
  not work and must not be written (§11a, MISSION FIX 4). The earlier revision
  of this line proposed exactly that and was wrong.

## §6. `webhook_subscriptions`

```
business_id  UUID NOT NULL
endpoint_id  UUID NOT NULL
event_type   TEXT NOT NULL REFERENCES webhook_event_types(event_type)
created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
PRIMARY KEY (business_id, endpoint_id, event_type)
FOREIGN KEY (business_id, endpoint_id) REFERENCES webhook_endpoints(business_id, id) ON DELETE CASCADE
```
No wildcard subscription (`OD-P14-05`): a wildcard means a merchant silently
starts receiving every event a future phase adds, which is the opposite of
deny-by-default.

## §7. `webhook_deliveries`

```
business_id      UUID NOT NULL
id               UUID NOT NULL DEFAULT gen_random_uuid()
endpoint_id      UUID NOT NULL
event_type       TEXT NOT NULL REFERENCES webhook_event_types(event_type)
outbox_event_id  UUID NOT NULL REFERENCES outbox_events(id)
payload          JSONB NOT NULL          -- the PROJECTED payload, frozen at fan-out
occurred_at      TIMESTAMPTZ NOT NULL    -- the source event's time, not the row's
status           TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','delivering','delivered','failed','dead'))
attempts         INT NOT NULL DEFAULT 0 CHECK (attempts >= 0)
next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now()
locked_at        TIMESTAMPTZ
locked_by        TEXT
lease_until      TIMESTAMPTZ
last_status_code INT
last_error_class TEXT     -- a CLASS, never a response body
delivered_at     TIMESTAMPTZ
created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
PRIMARY KEY (business_id, id)
UNIQUE (business_id, endpoint_id, outbox_event_id)
FOREIGN KEY (business_id, endpoint_id) REFERENCES webhook_endpoints(business_id, id) ON DELETE CASCADE
CHECK ((status = 'delivered') = (delivered_at IS NOT NULL))
```

- `UNIQUE (business_id, endpoint_id, outbox_event_id)` is the **exactly-once
  fan-out** invariant: the publisher may run twice over the same outbox row
  (crash between deliver and mark) and cannot create a second delivery row. At
  least once to the **merchant**, exactly once in the **ledger**.
- `payload` is immutable after insert (`BEFORE UPDATE` trigger raising
  `integrations.delivery_payload_immutable`). This is what makes replay honest:
  a replay re-sends this row, so if it could be rewritten, a replay could
  deliver today's truth under yesterday's event id (`P14-AL-16`).
- `last_error_class` is a closed set of classes (`timeout`, `dns`,
  `tls`, `refused`, `redirect`, `http_4xx`, `http_5xx`, `signature_unverifiable`,
  `target_rejected`). Free-text from a remote server is never stored: it is
  attacker-controlled content that would end up on a merchant's screen.
- **Indexes**
  ```
  (next_attempt_at) WHERE status = 'pending'        -- mirrors outbox_pending_idx (0004:37)
  (business_id, created_at DESC)                     -- the merchant's delivery list
  (lease_until) WHERE status = 'delivering'          -- crashed-worker reclaim
  ```
- **Retention and payload purge (V2 FINDING 8; window `OD-P14-09`, not
  `OD-P14-08` — that was a stale reference to the signing-secret decision).**
  Two things this request had conflated: **no runtime role holding `DELETE` is
  not a purge mechanism.** §11 grants `DELETE` to nobody, which stops ad-hoc
  deletion and leaves the ledger growing with no way to shed payloads at all.
  So the mechanism is stated here and the **duration is not**:
  - the purge is an **authorized operation**, not a cron job with table-owner
    rights: it runs under a named authority, writes an `audit_events` row
    carrying the actor identity, the window applied and the row count, and is
    refused outside that path;
  - it **clears the `payload`** of terminal deliveries older than the configured
    window and keeps the row — `business_id`, `endpoint_id`, `outbox_event_id`,
    status, attempts and timestamps all survive, so the delivery history and the
    exactly-once uniqueness constraint are untouched. The payload is the only
    part that carries merchant data forward, and it is a copy of
    merchant-visible data, so clearing it destroys no accounting record;
  - on `webhook_inbound_events` a purge **must not** shorten the dedupe window:
    the row **is** the replay defence, so no row may be removed while it is
    still inside the approved duplicate window, whatever the retention setting
    says. Where the two disagree, the dedupe window wins;
  - the `payload` immutability trigger must permit this one transition —
    `payload` to a cleared value by the purge authority — and nothing else, or
    the purge cannot run and the trigger would be weakened later to let it;
  - **a purged delivery is not replayable, and that is a refusal, not a
    fallback (V3).** `P14-AL-16` says a replay re-sends the **stored**
    projection; once the payload is cleared there is nothing stored to re-send,
    and the two tempting behaviours are both wrong. Re-projecting from current
    state would deliver **today's** truth under yesterday's event id — the exact
    dishonesty the immutable payload exists to prevent — and sending an empty or
    partial body would present an absence as an event. So replay of a purged
    delivery is refused with its own code, `DELIVERY_PAYLOAD_PURGED`, the row
    keeps saying that the original delivery happened, and **the absence of a
    payload never becomes a new send or a new execution** on either side of the
    wire. The purge window is therefore also the replay window, and an operator
    choosing it is choosing how long replay stays possible (`OD-P14-09`).

  **No retention period or legal duration is proposed here, by me or by anyone
  on this thread** (`OD-P14-09`). The mechanism takes a configured window; a
  configuration without one purges nothing, which is the fail-closed direction.

## §7a. OPEN RULING REQUESTED — the delivery's link to its source event

**V2 FINDING 6.** `webhook_deliveries.outbox_event_id` references
`outbox_events(id)` — a **global** foreign key — while the delivery row carries
its own `business_id`. RLS constrains which *delivery* rows a business sees; it
says nothing about which *source event* a delivery names. So a delivery row of
business A can reference an outbox event of business B, and every policy in this
request still passes. Since the projected `payload` is copied from the source
event at fan-out, that is a cross-business payload leak with a clean audit trail.

**Why the obvious fix is not available.** A composite
`FOREIGN KEY (business_id, outbox_event_id) REFERENCES outbox_events(business_id, id)`
would close it in the database, and it cannot be written: at `93084f8`
`outbox_events` is `id UUID PRIMARY KEY` with a **nullable** `business_id`
(`0004_infra.sql`), with no unique constraint on `(business_id, id)` to
reference. Adding one means altering a **frozen** migration, which
`P14-AL-28` and the Mission both forbid, or appending one to a table this phase
does not own. **No new FK goes into a frozen migration**, so this request
proposes none.

**What this request proposes in the meantime, and what it does not decide.**
A `BEFORE INSERT` trigger on `webhook_deliveries` asserting that the source
event's business is the delivery's own:

```
(SELECT business_id FROM outbox_events WHERE id = NEW.outbox_event_id)
  IS NOT DISTINCT FROM NEW.business_id
```

Two properties worth stating because they are easy to get wrong:

- The trigger function is **not** `SECURITY DEFINER` (`P14-AL-22`), so it runs
  as the caller and the subquery is itself subject to `outbox_scope`. Under
  `daftar_app` a foreign event is invisible, the subquery yields `NULL`, and the
  insert is refused — the check succeeds *because* of RLS, not despite it. The
  explicit comparison is written anyway, so the guard does not **rest** on that
  coincidence: a principal that bypasses or widens RLS must still fail the
  comparison.
- An outbox event with a `NULL` `business_id` — which that frozen schema allows
  — is refused. A webhook delivery always belongs to a business.

**The ruling belongs to the Outbox and Security owners together with the
Migration Owner**, as the Mission directs, and covers: whether a trigger is
accepted as the enforcement or the outbox table should gain the unique
constraint in a future owned migration; whether `event_type` and `occurred_at`
must likewise be proved to agree with the source rather than passed in; and
whether the typed payload projection is performed under an authority narrower
than the fan-out's. **Source identity must be stable across every retry** —
`P14-AL-16` already freezes `payload`, and this adds that `outbox_event_id`,
`endpoint_id` and `business_id` are immutable after insert, so a delivery cannot
be re-pointed at another source, endpoint or business once the fact exists.

Tests in §14: direct SQL attempting a cross-business link; concurrent fan-out
over the same outbox row; an attempted re-point of each of the three columns
after insert; and the planted red proof that removing the trigger turns the
first of these green.

**EXECUTED on PostgreSQL 16.15 @ `en_US.utf8`, non-superuser (case `C7`), and
the result changes this ruling request.**

1. **The defect is stronger than stated.** The writing role was given **no
   `SELECT` at all** on `outbox_events` — proved by a fenced refusal,
   `SQLSTATE 42501` — and the cross-business parent link was **still accepted**
   (`C7a`, exit 0). Foreign-key enforcement does not consult the writer's
   privileges, so "the merchant cannot read the other business's events" is not
   a mitigation of any kind.
2. **The proposed assertion, as written, is inoperable.** A trigger function
   that is not `SECURITY DEFINER` executes with the **invoker's** rights, so it
   cannot read `outbox_events` unless the **writing** role holds `SELECT` on
   it. Under §11's grants the assertion refuses the **same-business** write too,
   with `42501` (`C7c`, exit 0). It fails **closed**, which is the right
   direction, and it is unusable.
3. **Making it operable has a measured cost.** With `GRANT SELECT ON
   outbox_events` to the writing role the assertion works exactly as designed —
   cross-business refused with `23514`, same-business accepted, and the
   `NULL`-business platform event refused because `IS NOT DISTINCT FROM` does
   not match `NULL` (`C7d`, exit 0). But in the same run that role then read
   **1** of its own outbox rows **and 2 rows belonging to another business or to
   the platform**, because `outbox_events` carries **no RESTRICTIVE policy**
   (`0006_rls.sql:59-61`, `0010_db_roles.sql:36-38`,
   `0045_accounting_post_entry.sql:434`).

**So `TL-P14-SEC-02` is not a choice between a trigger and nothing. It is a
choice between three costs**, and the Security, Outbox and Migration Owners are
asked to rule on which is acceptable rather than on the trigger in the
abstract:

| Option | What it costs |
|---|---|
| (A) invoker-rights assertion + `GRANT SELECT ON outbox_events` | **depends entirely on which principal `TL-P14-SEC-01` names, and the two rulings are therefore COUPLED, not independent** — see the paragraph below. For `daftar_worker` it costs **nothing new**; for a dedicated internal role it costs the measured global read |
| (B) `SECURITY DEFINER` assertion reading only the one row | violates `P14-AL-22` (no new `SECURITY DEFINER`), so it needs an explicit exemption with its own search-path and ownership discipline |
| (C) a `(business_id, id)` unique on `outbox_events` and a composite FK | **the correct fix, and it is NOT unavailable — it is not Phase 14's to write, which is a different ruling and precisely the one being asked for.** Corrected in round 2 (CHALLENGE R2 (b)): what is forbidden is **altering** frozen `0004`, and a `UNIQUE (business_id, id)` added by an **appended** migration alters no frozen file — this section's own earlier paragraph already allows *"appending one to a table this phase does not own"* (`:602`). The previous revision collapsed *"I may not write it"* into *"it cannot be done"* and so took the best option off the menu. Mechanically it works: the child's `business_id` is `NOT NULL`, so under `MATCH SIMPLE` the composite FK is **always** checked and a `NULL`-business parent can never be named — no trigger, no grant, no exemption. The cost is that it belongs to the **Outbox and Migration Owners**, and it touches a relation six other phases read |
| (D) no database invariant; the application binds the pair | the honest DESIGN-ONLY answer, and it must then be **stated** as the only guard, as §3 now does for `subject_user_id` |
| (E) a relation **Phase 14 owns**, keyed `(business_id, outbox_event_id)`, populated at fan-out where the business is already known, policed by this phase's own RLS, with `webhook_deliveries` carrying a composite FK to **it** | **added in round 2 (CHALLENGE R2 (b)); this request had missed it.** The composite key is kept, no frozen relation changes, no `SECURITY DEFINER` exemption, no global read grant, and the invariant stays inside the phase that owns it. The cost is a second relation and a write at fan-out whose own correctness must then be proved — the binding is only as good as the moment it is recorded |

**Why (A)'s price is `TL-P14-SEC-01`'s answer, measured at `93084f8`.**
`0010_db_roles.sql:36-39` is `CREATE POLICY outbox_worker ON outbox_events USING
(current_user = 'daftar_worker')` — **PERMISSIVE, with no business predicate** —
together with `GRANT SELECT, UPDATE ON outbox_events TO daftar_worker`. So if the
Security Owner names `daftar_worker` as the delivery principal, that role
**already** reads every business's outbox rows and the assertion is **already
operable for it at no new cost**. If a dedicated internal role is chosen
instead, the cost measured in `C7d` applies in full.

That cuts both ways and the owner should have it in those words: the fact that
`daftar_worker` already holds a global read is itself **an argument against
naming it** the delivery principal, and it belongs to `TL-P14-SEC-01`. §11a
already observes that `daftar_worker` reaches credential deliveries and
invitations; this is a **third** instance of the same reach, and unlike the
first two it is measurable rather than rhetorical. **The two rulings must be
answered together, and the previous revision presented them as independent.**

This request states the five and decides none. **No DDL for
`webhook_deliveries` is written until the ruling returns.**

## §8. `webhook_inbound_events`

```
business_id        UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE
id                 UUID NOT NULL DEFAULT gen_random_uuid()
event_source       TEXT NOT NULL CHECK (event_source ~ '^[a-z][a-z0-9_]{1,40}$')
external_event_id  TEXT NOT NULL CHECK (char_length(external_event_id) BETWEEN 1 AND 200)
received_at        TIMESTAMPTZ NOT NULL DEFAULT now()
processed_at       TIMESTAMPTZ
PRIMARY KEY (business_id, id)
UNIQUE (business_id, event_source, external_event_id)
```
The UNIQUE triple is the shape `docs/DAFTAR_DATA_MODEL.md:435` already fixed —
**real columns**, not a literal inside a constraint, which that document
explicitly forbids (`:433`). A duplicate inbound event is a safe no-op. No
payload column: an unverified body is never persisted (`P14-AL-17`), and a
verified one is handled by the registering phase's own tables.

**RLS and grants (MISSION FIX 5 — this paragraph was missing).** This is a
business-scoped relation like any other and had been left out of both the grants
summary and the cross-tenant matrix, which is the precise omission the Mission
forbids (“اجرد كل العلاقات ذات نطاق المنشأة، ومنها inbound events. لا جدول مفقود
في مصفوفة الهجوم”). It therefore carries: `ENABLE` **and** `FORCE` RLS; the
PERMISSIVE `tenant_membership` and RESTRICTIVE `business_isolation` pair, both
halves; `REVOKE ALL FROM PUBLIC`; `SELECT, INSERT, UPDATE` to `daftar_app` and
`DELETE` to nobody — a dedupe ledger is append-only but for `processed_at`, so
UPDATE is granted and a trigger freezes every other column after insert. It
appears in §11 and in every row of the §11b attack matrix. An inbound adapter
runs **with** the business context of the endpoint it was authenticated for, so
it needs no exception of the §11a kind.

## §9. NOT CREATED: `api_idempotency_operations`

**Ruled, not pending** (Directive 11 PART 91, TL-P14-R1): v1 has no generic
`Idempotency-Key` header authority, so **this table is not created.** The shape
below is recorded only so that a future endpoint lacking a natural domain
identity does not have to design it from scratch — and PART 91 requires such an
endpoint to define its own real idempotency contract **before** publication. Its shape is not
open to design — `docs/DAFTAR_DATA_MODEL.md:434` already fixed it:

```
business_id      UUID NOT NULL
operation_type   TEXT NOT NULL          -- a REAL column, never a literal in the constraint
idempotency_key  TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200)
payload_sha256   TEXT NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$')
response_status  INT NOT NULL
response_body    JSONB NOT NULL
created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
PRIMARY KEY (business_id, operation_type, idempotency_key)
```
Replay with a matching digest returns the stored response; a mismatching digest
is `IDEMPOTENCY_CONFLICT`, the `0045:738` precedent. It is **not created**: the
repository's client-id convention covers every command on the initial surface,
and PART 91's reason is the stronger one — a generic header *“can silently
become weaker than domain semantics.”*

## §10. Permission backfill

Two keys are appended to `PERMISSIONS` (`P14-S0` §5). For **existing**
businesses, the owner role's `role_permissions` rows must be backfilled — the
`0076_phase4_permission_defaults_backfill.sql` precedent, including its taste
for a loud structural assertion:

- insert `integrations.view` and `integrations.manage` for every role where
  `business_roles.is_system AND key = 'owner'`;
- insert **nothing** for manager or cashier (`P14-S0` §5);
- `RAISE EXCEPTION` with a `phase14.permission_key_set_malformed`-style code if
  the key set is not exactly two keys with exactly one sensitive
  (`0076:154-163`), so a hand-edited migration cannot pass silently;
- idempotent (`ON CONFLICT DO NOTHING`), because a migration may be re-applied
  on a database that already carries the rows.

New businesses get the keys through `BUILTIN_ROLE_PERMISSIONS`
(`permissions.ts:156`), whose `owner: PERMISSIONS` entry already includes
anything appended to the registry — so the TypeScript side needs no edit beyond
the two new keys and their sensitivity entry.

## §11. Grants matrix, per relation and per operation

**MISSION FIX 2.** This section replaces a five-column summary that disagreed
with the sections above it. The disagreement was not cosmetic: §4 grants `UPDATE`
on `api_key_scopes` to **nobody** and requires `DELETE` so a scope can be
withdrawn, while the old summary put `api_keys` and `api_key_scopes` in one cell
reading “SELECT/INSERT/UPDATE, no DELETE” — denying UPDATE in the section and
granting it in the summary, and denying the DELETE the section depends on. The
Mission names that shape directly (“لا تمنع UPDATE ثم تمنحه في الملخص”). One
relation per row, one operation per column, and **this table is the authority**:
where a section's prose and this table disagree, the migration is not written
until the request is corrected.

`—` is *not granted*. A column list means the grant is column-scoped to exactly
those columns. Every relation below also gets `REVOKE ALL ... FROM PUBLIC`, so
the `PUBLIC` row is empty by construction and is not repeated per table.

### §11.1 `api_keys`

| Role | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `daftar_app` | all columns **except** `secret_sha256` | **NOT ENUMERATED — see §11.1a, this is a gap and not a scoping** | `name`, `revoked_at`, `revoked_by_user_id`, `revoked_reason`, `revoke_scheduled`, `last_used_at` only | — |
| `daftar_identity` | `key_id`, `id`, `tenant_id`, `business_id`, `subject_user_id`, `secret_sha256`, `expires_at`, `revoked_at` — **eight columns, matching §1 and §3 exactly** (CHALLENGE P1-01: this row read ten while §3 granted eight; the ten-column query is refused with `42501`, executed as `C9a`. `revoke_scheduled` and `name` are excluded by derivation, not trimmed — see §1) | — | — | — |
| `daftar_worker` | — | — | — | — |
| `daftar_platform` | per the accepted platform bypass policy | " | " | — |

- **`key_id` and `id` are in that list, and were not in the previous revision
  (V3 FINDING 1).** Amendment 04 derived the resolver's column set in §1 and
  **did not carry it into this matrix**, so §1 required ten columns while §11.1
  granted eight — the lookup's own `WHERE` column and the scope join's key being
  the two missing. That is the identical contradiction `P14-AL-30` was written to
  prevent, reappearing in the fix that introduced the §1 table: a derivation
  stated in one section and not propagated to the section that is declared
  authoritative. §14 asserts the two lists are **equal**, in both directions,
  rather than each being plausible on its own.
- `daftar_app`'s UPDATE is **column-scoped**, not whole-row. The immutability
  trigger (`P14-AL-08`) is the second line of defence, not the first: a grant
  that cannot name the column is better than a trigger that must refuse it.
**§11.1a — the `INSERT` cell is not enumerated anywhere, and that is a gap
(CHALLENGE R2 P3-08, found indirectly).** This row read *"see below — not an
unqualified yes"*, and the prose below it says only what is **not** in the set.
A matrix that declares itself authoritative must state the set, so the honest
record is that it does not yet, rather than a set invented here. The two
candidate resolutions:

| | |
|---|---|
| (i) `daftar_app` holds **no** `INSERT` on `api_keys` | key creation is a distinct minting principal's, the only one holding the plaintext. This follows from `C2d` below and is this request's reading |
| (ii) `daftar_app` holds a column-scoped `INSERT` and a second write supplies the digest | two statements where one fact is created, so the row exists briefly without its digest — which needs its own invariant. **And the obvious way to express that invariant does not exist (EXECUTED, CHALLENGE R3 P3-04).** `secret_sha256` is `NOT NULL`, and in PostgreSQL 16 **neither `NOT NULL` nor `CHECK` can be `DEFERRABLE`**: both `b TEXT CHECK (b IS NOT NULL) DEFERRABLE` and `b TEXT NOT NULL DEFERRABLE` are refused with `SQLSTATE 42601, misplaced DEFERRABLE clause`. The **only** deferral route is a `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED`, which the same run confirmed is accepted. So (ii) is not simply costlier than (i) — as stated it is **unimplementable**, and it survives only if it is restated with a deferred constraint trigger, which is a new trigger this request would then owe |

**This is routed with `TL-P14-SEC-01` rather than decided here**, because
*"which principal may write a key digest"* is the same question as *"which
principal holds the plaintext"*, and the Security Owner is already being asked
the second. No DDL for `api_keys` grants is written until it returns. The proof
case for this area (`c2_scope_insert.sql`) therefore states in its own comment
that its column set is **illustrative**, not a quotation of this matrix.

**The column-scoped `INSERT` for `daftar_app` is NOT satisfiable as a direct
statement, and that is a property of this matrix, not a defect to repair by
widening it (EXECUTED, case `C2d`, exit 0).** `secret_sha256` and
`subject_user_id` are `NOT NULL` and are **not** in `daftar_app`'s `INSERT`
column set. Both branches are therefore closed: omitting them is refused with
`SQLSTATE 23502` (`null value in column "subject_user_id" ... violates not-null
constraint` — note that the constraint which fires first is not the one under
test, so the second branch was executed separately rather than inferred), and
supplying them is refused with `SQLSTATE 42501`. **Key creation is consequently
not a direct `daftar_app` `INSERT` at all**: the digest and the subject are
written by the minting path, which is the only thing that holds the plaintext,
and this matrix must name that principal rather than leave the row looking
usable. A grant matrix has to be **satisfiable** as well as safe, and nothing
in this request asserted that until it was executed.

- `daftar_app` never reads `secret_sha256`. Only `daftar_identity` does, and
  only in the §1 transaction.
- **`daftar_app` holds no `INSERT` privilege on `secret_sha256`,
  `subject_user_id`, `business_id`, `tenant_id` or `key_id` (V2 FINDING 5).**
  The earlier revision wrote “INSERT: yes” unqualified, and **withholding
  `SELECT` on a column does not withhold `INSERT` into it** — the two privileges
  are independent in PostgreSQL. As written, the merchant request path could
  have inserted a key row carrying a **digest of its own choosing** and a
  `subject_user_id` of its own choosing: minting a working API key that
  impersonates another member, without ever reading a secret. That is the
  severe form of this finding and it was in this request until now.
  A key is therefore minted **only** by the management command, under an
  internal authority that is not the ordinary request role, which is the `0025`
  shape for credential payloads and the same reason `secret_ciphertext` is not
  `daftar_app`'s to write in §11.3. `daftar_app`'s own `INSERT` is column-scoped
  to the fields a merchant genuinely supplies — `name` — and the rest are
  supplied by the command. Whether the mint command's authority is a new NOLOGIN
  role or an existing one is part of `TL-P14-SEC-01`; **a NOLOGIN identity does
  not by itself relax any grant.**
- The same question, asked of every relation in §11 rather than only this one:
  **can the runtime role insert a value it may not read?** Where the answer was
  yes, the `INSERT` is now column-scoped. §14 asserts it from the catalogue
  rather than from this paragraph.
- `DELETE` is granted to nobody on this relation: a key is revoked, and the row
  is the audit record of that (`0020` precedent). Cascade from a deleted
  `businesses` row is the only route by which a row disappears.

### §11.2 `api_key_scopes`

| Role | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `daftar_app` | yes | yes | **—** | yes |
| `daftar_identity` | `business_id`, `api_key_id`, `scope` | — | — | — |
| `daftar_worker` | — | — | — | — |
| `daftar_platform` | per the platform bypass policy | " | — | " |

A scope grant has no mutable field: it is added or withdrawn, so `UPDATE` is
granted to nobody and `DELETE` is the withdrawal mechanism. This is the row the
old summary got backwards in both directions.

### §11.3 `webhook_endpoints`

| Role | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `daftar_app` | all columns **except** `secret_ciphertext`, `secret_nonce`, `key_version` | **column-scoped**: `url`, `description` only — **not** the three secret columns (V2 FINDING 5) | all columns except the three secret columns | — |
| `daftar_identity` | — | — | — | — |
| `daftar_worker` | `business_id`, `id`, `url`, `status`, `secret_ciphertext`, `secret_nonce`, `key_version` | — | — | — |
| `daftar_platform` | per the platform bypass policy | " | " | — |

- The three secret columns are written **only** by the management command, which
  runs under a dedicated internal authority, never by `daftar_app` directly —
  the `0025` shape. **This now holds on `INSERT` as well as `UPDATE`**: the
  earlier revision blocked the update and left the insert open, so a merchant
  path could have registered an endpoint with an attacker-chosen signing secret
  and key version at creation time, and rotation would have had nothing to
  protect (V2 FINDING 5). `daftar_app` holding UPDATE on the non-secret columns and
  not on these is what makes “rotate the signing secret” an auditable command
  rather than an ordinary field edit.
- An endpoint is disabled (`status = 'disabled'`), never deleted, so deliveries
  keep a parent. Hence no `DELETE`.

### §11.4 `webhook_subscriptions`

| Role | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `daftar_app` | yes | yes | **—** | yes |
| `daftar_identity` | — | — | — | — |
| `daftar_worker` | `business_id`, `endpoint_id`, `event_type` | — | — | — |
| `daftar_platform` | per the platform bypass policy | " | — | " |

A subscription is `(business_id, endpoint_id, event_type)` and nothing else:
there is no field to update, so it follows `api_key_scopes` exactly.

### §11.5 `webhook_deliveries`

| Role | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `daftar_app` | all columns **except** `payload` | fan-out only, inside the publisher's transaction — and it **does** write `payload`, which it may not read (see §7a) | **—** | — |
| `daftar_identity` | — | — | — | — |
| `daftar_worker` | yes | — | `status`, `attempts`, `next_attempt_at`, `last_status_code`, `last_error_class`, `delivered_at`, `locked_at`, `locked_by`, `lease_until` only | — |
| `daftar_platform` | per the platform bypass policy | " | " | — |

- `daftar_app` does **not** hold UPDATE here. Attempt accounting belongs to the
  worker alone; a merchant request path that could write `attempts` could hide a
  failed delivery.
- `daftar_app` does not read `payload`: a merchant reads the delivery's status,
  never the projected body back out of the ledger, and never the response body
  (`P14-AL-19`).
- Neither role holds `DELETE`. Retention is a policy question with no mechanism
  in this request (`OD-P14-09`).
- **How `daftar_worker` reaches these rows at all is §11a**, not this table.
- **`GRANT SELECT ON businesses TO daftar_worker` is required** for any
  context-free read of these relations, under every option in §11a, because the
  PERMISSIVE `tenant_membership` policy evaluates its
  `EXISTS (SELECT 1 FROM businesses ...)` subquery whichever permissive policy
  matches (`0020_credential_delivery_outbox.sql:54-58`). The role already holds
  it if `0020` applied; the migration must not assume so and must not re-grant
  blindly either — it asserts the privilege exists and raises if it does not.

### §11.6 `webhook_inbound_events`

| Role | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `daftar_app` | yes | yes | `processed_at` only | — |
| `daftar_identity` | — | — | — | — |
| `daftar_worker` | — | — | — | — |
| `daftar_platform` | per the platform bypass policy | " | " | — |

The relation the earlier revision left out of the summary altogether (§8).

### §11.7 The two registries

| Relation | `daftar_app` | `daftar_identity` | `daftar_worker` | `daftar_platform` | RLS |
|---|---|---|---|---|---|
| `api_scopes` | SELECT | SELECT | — | SELECT | **none** (global vocabulary) |
| `webhook_event_types` | SELECT | — | SELECT | SELECT | **none** (global vocabulary) |

Rows are inserted by the migration only. No runtime role holds INSERT, UPDATE or
DELETE on either, which is what makes the vocabulary closed in the database
rather than by convention.

### §11.8 The scope → operation map

The Mission asks for the scope grant matrix per relation, and the honest answer
has two halves that must not be conflated. A **scope** authorises an *HTTP
operation on the public surface*; a **database grant** authorises a *role*.
A scope never reaches a relation directly, because the public request runs as
`daftar_app` under the same policies as a merchant session (`P14-AL-01`).

| Scope | Public operations it admits | Relations the request then touches | Mode |
|---|---|---|---|
| `catalog.view` | `GET /products`, `GET /products/{productId}` | `products`, `product_variants`, `categories` | read |
| `inventory.view` | `GET /stock` | stock reads | read |
| `customers.view` | `GET /customers`, `GET /customers/{customerId}` | `customers` | read |
| `customers.manage` | `POST /customers` | `customers` | write |
| `sales.view` | `GET /invoices`, `GET /invoices/{invoiceId}` | `invoices`, `invoice_lines` | read |
| `sales.create` | `POST /sales` | the P4-S2 sale command's own relations | write |

- **`GET /stock` requires `inventory.view`, not `catalog.view` (V3 FINDING 2).**
  The previous revision of this table put it under `catalog.view`, disagreeing
  with `P14-CONTRACT-PACK.md` and `P14-OPENAPI-SKELETON.yaml`, which both say
  `inventory.view`. **The live code settles it:** the route carries
  `@RequiresPermission('inventory.view')`
  (`apps/api/src/modules/inventory/inventory-reads.controller.ts:60-61`), so the
  two contract documents were right and this table was wrong.

  **And the live authority is not reachable by one grep (measured at `93084f8`,
  the declared base).** Three mechanisms carry route authority in this codebase,
  so the gate that asserts this mapping must know all of them or it will report
  a published scope as unguarded and be "fixed" by loosening the mapping:
  - `@RequiresPermission(...)` — the Phase 3 inventory routes, and the POS
    till-session routes (`till-sessions.controller.ts:89`);
  - **`@phase4Permission(...)`** — a *different decorator*, from
    `selling/selling-permissions`, on the Phase 4 selling reads
    (`selling/customers.controller.ts:49`, `:56`);
  - a **table**, not a decorator: `OPERATION_AUTHORITY` keyed by operation
    (`inventory/inventory-authorization.ts:100-103` for the `customer.*` writes)
    and the frozen route tables of `pos/pos-permissions.ts:84-100` and
    `pos/pos-cart-routes.ts:150-187` for `sales.create`.

  A grep for `RequiresPermission('customers.view')` alone returns **zero** at the
  base, which says nothing about whether the route is guarded — it is, by the
  second mechanism. A decorator-only check would therefore be a false negative on
  the whole Phase 4 surface. `P14-GATE-032` reads all three sources and fails if
  a published operation's authority cannot be located in any of them, which is a
  stronger statement than "the decorator agrees".

  **This was a privilege escalation, not a typo.** `BUILTIN_ROLE_PERMISSIONS`
  gives the **cashier five** permissions —
  `['catalog.view', 'sales.view', 'sales.create', 'customers.view',
  'payments.collect']` (`permissions.ts:214`) — and `inventory.view` only to
  manager and owner (`permissions.ts:179`). **The earlier revision of this
  paragraph said the cashier held `catalog.view` alone and cited `:149` and
  `:144`; both are wrong **at the declared base** (CHALLENGE P2-02), and the
  corrected values above are verified at `93084f8`.

  **The cause was not what either review supposed, and it matters more than the
  correction (CHALLENGE R2 P3-09, re-diagnosed).** The round-1 review concluded
  that the Phase 1 cashier set had been read as the current one. It had not. At
  **`6fc505d`** — the tree this container has checked out, and the commit this
  pack's own branch descends from — `:149` **is** `cashier: ['catalog.view']`
  and `:144` **is** `'inventory.view'` inside the manager block. **Both original
  citations were exactly right for the tree they were read from and exactly
  wrong for the base this pack declares.** `permissions.ts` differs between the
  two trees by 66 lines, and Phase 4 appended four permissions to the cashier in
  that gap.

  So this was never a misreading of a comment. It is the base-tree trap, and the
  trap produces findings that look like carelessness and are not — which is why
  it is now treated as a root cause with a per-citation provenance table (§15),
  rather than as a disclosed footnote. The independent challenger could not have
  seen this, because it read only a `93084f8` worktree, where the original
  citations are simply wrong.
  Had a key been scoped per this table, a
  cashier-delegated key would have read stock levels **that the same cashier
  cannot read in the application** — the public API granting what the business
  permissions deny, which is the one law this phase was given
  (`P14-AL-01`/`P14-AL-02`). The intersection in `TenancyService.require` would
  not have saved it either: the cashier genuinely holds `catalog.view`, so the
  intersection is non-empty and the request passes. **A wrong scope→route
  mapping is not caught by the intersection; it defines what the intersection
  is checked against.**
- The **six** scopes above are the entire set the v1 surface exercises: seven
  reads and two writes over eight paths and nine operations (§11.9). The earlier
  revision said five, because the missing `inventory.view` row was the sixth.
- That set is **narrower than the registry**. §4 of `P14-S0-ARCHITECTURE-LOCK.md`
  registers twelve scopes as the vocabulary; six of them have a published v1
  operation and six do not yet. A registered scope with no published operation
  **admits nothing** — it is grantable and opens no route — and the bijection
  gate asserts the registry against the TypeScript `PUBLIC_API_SCOPES` set, not
  against the route table. Saying so here is the point: the two counts differ for
  a stated reason, and neither is a correction of the other.
- `integrations.view` and `integrations.manage` are **absent from this table on
  purpose**: they are session-only permissions, so no key can mint a key, read a
  digest or register an endpoint (`P14-AL-07`). The management surface in §11.1–
  §11.6 is reached by a merchant session, never by a public key.
- No scope admits a `DELETE` on any relation, and none admits an UPDATE outside
  the command surfaces above — which is the contract the Mission's “ويتبع DELETE
  وإضافة الوقائع العقد” asks to be stated rather than left implied.

### §11.9 Surface count, restated for the Migration Owner

Eight paths, nine operations, seven reads and two writes — `GET /products`,
`GET /products/{productId}`, `GET /stock`, `GET /customers`,
`GET /customers/{customerId}`, `GET /invoices`, `GET /invoices/{invoiceId}`,
`POST /customers`, `POST /sales`. `/customers` carries two operations, which is
why eight paths yield nine. This matches the Mission's own proposal exactly and
is unchanged by this revision.

## §11a. OPEN RULING REQUESTED — the context-free delivery worker

**MISSION FIX 4, and the one item in this request that must not be implemented
until an owner rules.** The Mission states it: a worker that carries no business
context **does not** get past a RESTRICTIVE policy by adding a PERMISSIVE one,
and the **Security Owner** decides the exact role, the exception and the access,
and proves it with an attack run as a **non-superuser**.

### What the earlier revision of this request got wrong

`§5` said the worker reaches its rows through “a role-keyed PERMISSIVE SELECT”,
and `§11` implied the same. That is inert on every relation in this request, and
the reasoning is measurable rather than remembered:

- `outbox_events` carries **three PERMISSIVE policies and no RESTRICTIVE policy
  at all** — `outbox_scope` (`0006_rls.sql:59-61`), `outbox_worker`
  (`0010_db_roles.sql:36-38`, `USING (current_user = 'daftar_worker')`) and
  `outbox_accounting_writer` (`0045_accounting_post_entry.sql:434`). A search
  for `RESTRICTIVE` across every migration at `93084f8` returns no policy on
  that relation. **That** is why the outbox relay works today, and it is the
  precedent a reader would copy.
- Every relation in this request instead carries the RESTRICTIVE
  `business_isolation` pair (§0). A RESTRICTIVE policy is ANDed: the qual
  `app_bypass() OR business_id::text = app_business()` must still hold, and
  `withWorkerTransaction` sets **neither** — it runs with no scope and no bypass
  (`database.ts:1024-1026` at `93084f8`; the same two lines, `{}` and `false`,
  are at `:849-851` in the `6fc505d` tree, so the fact does not depend on which
  tree is read).

So the copied precedent yields a worker that sees **zero rows**: the delivery
loop never dispatches. The feature failing closed is the good case; the likely
repair — dropping the RESTRICTIVE policy — would expose every delivery row to
every context-free connection.

### The house has already solved this, twice, and the precedent is explicit

This is not new ground, and the Security Owner should rule with the precedent in
front of them rather than against a blank page:

- `0014_branch_scopes.sql:10-15`: “*The RESTRICTIVE business_isolation policy
  applies to EVERY role — exempt the resolver explicitly (same pattern as 0013
  on the membership tables).*” The policy is dropped and recreated with
  `current_user = 'daftar_resolver'` as a disjunct in **both** halves.
- `0020_credential_delivery_outbox.sql:72-78`: “*The RESTRICTIVE
  business_isolation policy on business_invitations must not block the worker.
  Recreate it with the worker exemption (0014 pattern).*” Again both halves,
  for `daftar_worker` — **and the same migration also creates a PERMISSIVE
  `worker_delivery` policy** (`:65-70`). Both were needed: the permissive one to
  admit the role at all, the restrictive rewrite because the permissive one
  alone admits nothing. That migration is the direct evidence that the
  construction this request originally proposed does not work, written by
  someone who hit it.

**A requirement this request had omitted entirely, and would have failed on.**
`0020:54-58` records it: `GRANT SELECT ON businesses TO daftar_worker`, because
the PERMISSIVE `tenant_membership` policy evaluates
`EXISTS (SELECT 1 FROM businesses ...)` **regardless of which permissive policy
matches**, so a context-free role needs the table privilege on `businesses` even
though it never names that relation in a query of its own. Without it the
worker's statement fails on a permission error rather than returning zero rows.
This grant is therefore required under **every** option below, is added to §11,
and is called out here because it is exactly the kind of requirement that is
invisible until the worker is run as itself — which is what the non-superuser
attack is for.

### Three shapes

**(A) STRICTER THAN THE PRECEDENT — the disjunct in `USING` only.**

```
USING (app_bypass() OR current_user = 'daftar_worker' OR business_id::text = app_business())
WITH CHECK (app_bypass() OR business_id::text = app_business())
```

The grants stay exactly as §11.5 states them — `SELECT` on the relation and
`UPDATE` on the nine attempt-accounting columns — because a grant authorises a
role while a policy decides which rows it sees, and conflating the two is how
this request went wrong in the first place. The loop is **two transactions**:

1. a **context-free claim**, `daftar_worker` with no GUC, which the `USING`
   disjunct admits; it reads `(business_id, id)` of due rows and nothing more;
2. per claimed row, a transaction **as the same role with `app.business_id` set**
   to that row's business, which performs the attempt and the UPDATE. There the
   ordinary `business_id::text = app_business()` qual admits both halves, so the
   write never relies on the role disjunct at all.

Because step 2 is scoped, the `WITH CHECK` half needs no disjunct, and the
`UPDATE` grant of §11.5 is reachable without one. Nothing a worker writes is
admitted by a role disjunct — so no worker statement can create or move a row
across businesses even if the claim query is wrong, and a context-free UPDATE
finds zero rows to write. This is the `daftar_reconciler` enumeration shape
(`database.ts:1026-1041` at `93084f8`) without its `SECURITY DEFINER`, which
`P14-AL-22` forbids adding.

**(B) THE ACCEPTED HOUSE PRECEDENT — the disjunct in both halves.**
`0014`/`0020` exactly: one transaction, a simpler loop, consistent with two
migrations a reviewer already approved. Its cost is real and should be stated
rather than glossed: `WITH CHECK` then admits a worker-written row whose
`business_id` is **anything**, so cross-business movement is prevented only by a
`BEFORE UPDATE` trigger freezing `business_id` — a trigger standing where a
policy could stand.

**(C) REFUSED — a PERMISSIVE worker policy alone**, as `§5` and the old `§11`
implied. Inert, for the reason measured above, and `0020` is the record of
someone discovering that. Recorded as refused so it is not rediscovered.

### What the Security Owner is asked to settle

- **(A) or (B).** This request **recommends (A)** and says plainly that (B) is
  the established pattern: the recommendation is to tighten, not to follow. The
  deciding question is whether a context-free principal should be able to have
  its writes admitted by its role at all when a scoped second transaction costs
  one extra round trip. That is a security judgement, not an author's.
- **Which principal.** Whether `daftar_worker` is right for webhook dispatch, or
  a new `daftar_webhook_internal` NOLOGIN authority is. This request takes no
  position; it notes only that `daftar_worker` already reaches credential
  deliveries and invitations, so adding webhook egress widens an existing
  principal's blast radius rather than creating a bounded one.
- **The same question for `webhook_endpoints` and `webhook_subscriptions`**,
  which the worker must read to know where to send and what to send — including
  whether the worker reads the endpoint secret columns at all, or whether
  signing moves behind a narrower authority.
- **The reachability bound, separately from the principal (V2).** A broad
  `SELECT` grant is **not** a decision that the role may see every row: the
  grant and the policy answer different questions, and the ruling must state
  both. It must likewise not assume a policy subquery always executes — the
  `businesses` dependency of `0020:54-58` is exactly a case where the planner's
  behaviour, not the policy text, decides whether a privilege is needed. **A
  NOLOGIN identity relaxes no grant by itself**, so choosing a dedicated role
  settles who, never what.

**No DDL for those three relations is written until that ruling exists.** That is
why this is a ruling request inside the patch request and not a proposed policy
text.

### The proof the ruling must carry

Required by the Mission, and repeated in §14. **The catalogue first, then the
runtime** — a grant matrix read from `information_schema` proves what was
granted, never what is reachable, and only the second kind of evidence closes
this ruling:

1. **Catalogue**: the §11 matrix asserted in both directions for the four
   runtime roles over the eight relations, `PUBLIC` included.
2. **Runtime, positive**: the admitted path works — claim, scoped UPDATE,
   fan-out, and a rotation of an endpoint secret under the management authority.
3. **Runtime, negative**: run as `daftar_worker` itself, **non-superuser**, no
   GUC set — exactly the admitted columns of exactly the admitted relations and
   **zero** rows of every other business-scoped relation here and in Phase 4; no
   INSERT, UPDATE or DELETE that §11 does not grant, **including no INSERT of a
   column it may not read** (V2 FINDING 5); under (A) a context-free UPDATE
   writes zero rows, under (B) the `business_id` freeze trigger refuses a
   cross-business move.
4. **Mutation**: with the policy's disjunct removed — and separately with each
   protection above removed — the corresponding test turns **red**. A protection
   whose absence changes no test is not protecting anything.

Every one of these runs against a scratch database. **No proof mutates a frozen
migration**, even temporarily (`P14-AL-28`).

## §11b. Attack matrix — every business-scoped relation in this request

**MISSION FIX 5: “no missing table in the attack matrix.”** The six
business-scoped relations, each with the properties the security tier must prove.
`webhook_inbound_events` is the row that was missing.

| Relation | RLS `ENABLE`+`FORCE` | Two-policy pair | Cross-tenant read = 0 | Cross-business INSERT refused | Secret columns unreadable by `daftar_app` | Context-free read |
|---|---|---|---|---|---|---|
| `api_keys` | required | required | required | required | `secret_sha256` | `daftar_identity` only, §1 |
| `api_key_scopes` | required | required | required | required | n/a | `daftar_identity` only, §1 |
| `webhook_endpoints` | required | required | required | required | `secret_ciphertext`, `secret_nonce`, `key_version` | **§11a ruling** |
| `webhook_subscriptions` | required | required | required | required | n/a | **§11a ruling** |
| `webhook_deliveries` | required | required | required | required | `payload` | **§11a ruling** |
| `webhook_inbound_events` | required | required | required | required | n/a | none — runs with context |

The two registries (`api_scopes`, `webhook_event_types`) are deliberately outside
this matrix: they are global vocabularies with no `business_id`, no RLS and no
runtime write grant (§11.7). Saying so here is the point — an absent row must be
absent for a stated reason, not by oversight.

## §12. Triggers and functions

| Object | Kind | Purpose |
|---|---|---|
| `api_keys_identity_immutable` | `BEFORE UPDATE` trigger | `P14-AL-08`: `key_id`, digest, business, tenant, subject, `created_at` frozen |
| `api_keys_tenant_consistent` | `BEFORE INSERT` trigger | the denormalized `tenant_id` must equal the business's tenant |
| `api_keys_revocation_consistent` | `BEFORE INSERT`, and `BEFORE UPDATE OF revoked_at, revoke_scheduled` | MISSION FIX 3 as corrected by **V2 FINDING 3**: the intent check runs only when an intent field changes, so it is never re-evaluated against a later `now()`; `revoked_at` is append-once and may only move earlier; `revoked_by_user_id` required whenever `revoked_at` is set |
| `webhook_inbound_events_append_only` | `BEFORE UPDATE` trigger | §8: every column but `processed_at` is frozen after insert |
| `webhook_delivery_payload_immutable` | `BEFORE UPDATE` trigger | `P14-AL-16`: the projected payload is frozen, **with exactly one permitted transition** — the purge authority setting `payload` to `NULL` on a row past the `OD-P14-09` retention window, audited. Stated here because §7 warns that a flat freeze makes the purge impossible and *"the trigger would be weakened later to let it"*, which is the forbidden repair |
| `webhook_delivery_source_business` | `BEFORE INSERT` trigger | **§7a, `TL-P14-SEC-02`'s entire proposed enforcement** (CHALLENGE P2-03: committed in §7a and absent from this table). The source event's business must equal the delivery's own, `IS NOT DISTINCT FROM` so a `NULL`-business platform event is refused rather than matching; an **absent** source event is a refusal, never a reconstruction (`P14-AL-38`); **not** `SECURITY DEFINER` (`P14-AL-22`). See §7a for the grant consequence the execution exposed |
| `webhook_delivery_link_immutable` | `BEFORE UPDATE OF outbox_event_id, endpoint_id, business_id` trigger | §7a: a delivery cannot be re-pointed at another source, endpoint or business once the fact exists. §14 already tests the re-point refusal of all three columns, so the test roster expected a trigger this table did not create (CHALLENGE P2-03) |
| — | **no** `SECURITY DEFINER` | `P14-AL-22` |

Each trigger function is `LANGUAGE plpgsql`, `RAISE EXCEPTION` with a dotted
`integrations.*` code and `ERRCODE = 'P0001'`, the house style
(`0004_infra.sql:18-22`). Each is created **before** the trigger that
references it — the S7 defect where two `CREATE CONSTRAINT TRIGGER`s preceded
their function and the whole slice failed to apply with `42883`.

## §13. Fresh install and upgrade

- **Fresh install:** all objects created in order; both registries seeded; the
  backfill is a no-op on an empty database.
- **Upgrade from the then-current frozen head:** every *table* is new, but
  **a migration's effects are not only its tables** (V2 FINDING 7). The earlier
  revision reasoned from new tables alone and so understated the upgrade. What
  this migration actually changes on a populated database: the §10 permission
  **backfill** over existing owner roles; the **grants** of §11 to four runtime
  roles, including the column-scoped ones a later revision narrows; the
  **`businesses` SELECT privilege** a context-free principal needs
  (`0020:54-58`), which may or may not already be held; and the **registry
  seeds**, which must be idempotent on a database that already carries them.
  The upgrade proof therefore exercises a database with real businesses, real
  owner roles and the previous grant state — not an empty one, where every
  statement is trivially satisfiable.
- **Reversal:** forward-only, like every migration in this repository. There is
  no down migration; a mistake is corrected by a new appended migration under
  an explicit directive.
- **Order of application matters in one place:** `webhook_deliveries`
  references `outbox_events(id)`, which exists since `0004`, and §7a explains
  why that reference is not yet settled. No new dependency on an unfrozen
  `0080`–`0086` object exists anywhere in this request.
- **That independence is NOT an argument for early numbering (V2 FINDING 7).**
  The earlier revision concluded from it that “Phase 14 can therefore be
  allocated whether or not the S4–S7 candidates are sealed, which is
  deliberate.” **That sentence is withdrawn.** The Mission's §14 overrides it
  explicitly: the train rule governs, preparation carries **no number**, and
  Phase 14 is numbered and promoted only **after Phase 13 is sealed**. Having no
  blocking dependency says this request *could* be applied early; the train says
  it **will not be**, and the number is the Migration Owner's to allocate at
  promotion and at no earlier moment.

## §14. Tests the Migration Owner should require

| Tier | Test |
|---|---|
| DDL | fresh install on a clean cluster, then a real upgrade from the frozen head **on a database carrying real businesses, owner roles and the previous grant state** — the backfill, the grants, the `businesses` privilege and the registry seeds are all exercised, because a migration's effects are not only its tables (V2 FINDING 7) |
| DDL | the migration applies as **`daftar_migrator`**, not as the superuser — the rule that found three defects a superuser cannot meet during the Phase 4 S7 work (a missing `CREATE` bracket for an `ALTER FUNCTION ... OWNER TO`, an owner transfer placed before the function's own `REVOKE`/`COMMENT`, and a `CASE` over a record's fields that plpgsql resolves in every branch) |
| Security | direct SQL as `daftar_app`: inserting an unregistered scope fails on the FK; updating `secret_sha256` fails on the trigger; `DELETE FROM api_keys` fails on grants |
| Security | cross-tenant matrix: with business A's GUCs set, zero rows of business B are visible in **all six** business-scoped tables — `api_keys`, `api_key_scopes`, `webhook_endpoints`, `webhook_subscriptions`, `webhook_deliveries`, `webhook_inbound_events` — and an INSERT naming B fails `WITH CHECK` on each. (The earlier revision of this row said “five” and the table it omitted was `webhook_inbound_events`: MISSION FIX 5. A count in a test description is a place a missing relation hides, so the six are named.) |
| Security | **the §11a ruling's proof**: as `daftar_worker`, non-superuser, with no GUC set — exactly the admitted columns of exactly the admitted relations, zero rows of every other business-scoped relation here and in Phase 4, no INSERT/UPDATE/DELETE the §11 matrix does not grant; and with the `USING` disjunct removed the same attack turns **red** (the planted red proof) |
| Security | **the §11 matrix is asserted from the catalogue, not read from this document**: `information_schema.role_table_grants` and `role_column_grants` for the four runtime roles over the eight new relations equal §11 exactly, with a planted red proof on each direction — the gate that would have caught the `api_key_scopes` UPDATE/DELETE contradiction |
| Security | the fan-out path cannot write a delivery row for a business other than the outbox row's own, attempted by direct SQL rather than through the publisher |
| DDL | **every column the resolver names exists** (MISSION FIX 1): the `api_keys` column set from `information_schema.columns` contains each column of the §1 read list and **no** column named `status`, with a planted red proof that adding `status` to the resolver's list turns it red |
| Security | **the usability predicate is executed, not read** (V2 FINDING 1): a key with `revoked_at IS NULL` and `expires_at` in the past is **refused**; the planted red proof removes the parentheses and that exact case turns green, which is the defect this pack carried |
| Security | the boundary refuses: at exactly `revoked_at = now()` and at exactly `expires_at = now()` the key is refused (`>`, never `>=`); a key both expired and revoked is refused once, with a code chosen from the facts |
| Security | no client-supplied time reaches the predicate: the comparison uses the server clock per the contract, asserted by a test that offers a false client timestamp and sees it ignored |
| Security | **resolver sufficiency, not column existence** (V2 FINDING 2): as `daftar_identity` with no business context, the real lookup by `key_id` and the real scope join both execute under the §11 grants; the red proof removes `key_id` from the grant and the lookup fails, proving the `WHERE`-clause privilege is load-bearing. `daftar_app` can read neither the key digest nor any endpoint signing-secret column |
| Security | **a role cannot insert a column it may not read** (V2 FINDING 5): as `daftar_app`, an INSERT naming `secret_sha256` or `subject_user_id` on `api_keys`, or any of the three secret columns on `webhook_endpoints`, is refused by privilege — the forged-key and forged-signing-secret cases, each with its own red proof |
| Security | **the delivery cannot name another business's source event** (V2 FINDING 6): by direct SQL, an insert linking business A's delivery to business B's outbox event is refused; a `NULL`-business source event is refused; `outbox_event_id`, `endpoint_id` and `business_id` cannot be changed after insert; concurrent fan-out over one outbox row still yields exactly one delivery per endpoint |
| Integrity | **a purged delivery refuses replay** (V3): after a purge, a replay attempt is refused with `DELIVERY_PAYLOAD_PURGED` — it does **not** re-project from current state and does **not** send an empty body; the row still attests the original delivery; red proofs on both wrong behaviours |
**What the corrected premise changes (CHALLENGE P2-02).** The escalation
conclusion survives unchanged — the cashier does **not** hold `inventory.view`,
so the mapping defect was real and `P14-AL-39` and `P14-GATE-032` stand. What
does not survive is every statement that reasoned from "a cashier can only read
the catalogue". Four of the cashier's five permissions — `catalog.view`,
`sales.view`, `sales.create`, `customers.view` — are **published v1 scopes**,
so a cashier-delegated key reaches **four of the six** v1 scopes, and one of
them is a **write**:

> **`sales.create` is reachable by a cashier-delegated v1 key, which means such
> a key can commit a sale through the public API.** That is the single most
> consequential thing a delegated v1 key can do, and no earlier revision of
> this pack said so in those words.

This is **not** an escalation: it mirrors the cashier's real application
authority and the `membership ∩ scopes` intersection is doing exactly its job.
It is a blast-radius statement. Every place the pre-mortem, the attack matrix
and the §11.8 commentary treat the cashier as the **narrowest** delegating
principal must be read against `permissions.ts:214`, because the narrowest
built-in delegating principal can sell.

| Security | **the two authority sources agree** (V3 FINDING 2): the scope→route map of §11.8, the contract pack and the OpenAPI skeleton name the same permission for every published operation, asserted against the live route guards; and the **negative** test — a key scoped `catalog.view` only is **refused** on `GET /stock` with `SCOPE_INSUFFICIENT`, which is the cashier-escalation case |
| Security | **§1 and §11.1 name the same ten columns** (V3 FINDING 1), asserted in both directions, with a red proof that dropping either `key_id` or `id` from the grant breaks the resolver — the contradiction a per-section derivation reintroduced |
| Integrity | **the purge is a mechanism, not an absence of DELETE** (V2 FINDING 8): the authorized purge clears `payload` on terminal deliveries older than a configured window, keeps the row and its uniqueness constraint, writes an audit row naming the actor and the window; the same operation attempted outside that authority is refused; and **no inbound row is removed while inside the approved dedupe window**, tested by replaying an event at the window's edge |
| Integrity | the four readers of the revocation predicate agree (MISSION FIX 3): a key with `revoked_at` in the future is accepted by the auth predicate and displayed as “revokes at”; the same key one instant after is refused with `API_KEY_REVOKED` while `revoke_scheduled` is **still true**; a row where `revoke_scheduled` disagrees with `revoked_at > now()` is refused by the trigger on both INSERT and UPDATE |
| Integrity | `webhook_inbound_events`: a duplicate `(business_id, event_source, external_event_id)` is a no-op, and an UPDATE of any column but `processed_at` is refused by the trigger |
| Security | with **no** `app.business_id`, `daftar_app` sees zero rows (the default-deny property of `0006_rls.sql:25`) |
| Security | `daftar_app` cannot read any secret column (column-scoped grant), proved by an error, not by absence from a SELECT list |
| Security | the `daftar_identity` pre-context read returns exactly the permitted columns and cannot UPDATE |
| Concurrency | two connections fan out the same outbox row; exactly one delivery row per `(endpoint, outbox_event)` survives — real PostgreSQL, multiple connections, no `sleep()` (PART 39) |
| Concurrency | a `delivering` row whose `lease_until` passed is reclaimed by another worker; a live lease is not stolen |
| Integrity | the tenant-consistency trigger refuses a mismatched `tenant_id` |
| Integrity | a future `revoked_at` leaves the key **usable** until that instant and refuses it from that instant, measured against the auth predicate itself, not a comment |
| Integrity | **a metadata write is not a revocation write** (V2 FINDING 3): minted at `T0`, accepted before `T`, refused **at** `T` and after; and an update of `name` or `last_used_at` attempted on **both** sides of `T` behaves per the contract owner's ruling — the previous design refused it after `T`, which is the defect. `revoked_at` may move earlier, never later, never back to `NULL` |
| Integrity | `replaces_api_key_id` cannot name a key in another business (composite FK), and the revoke/schedule pair cannot disagree (trigger) |
| Security | the `url` userinfo `CHECK` refuses `https://victim@internal/` on INSERT, by direct SQL as `daftar_app` |
| Security | **no test anywhere mutates a frozen migration** (`P14-AL-28`, PART 6): the proof roster is checked for writes under `infrastructure/database/migrations/`, and a proof that would need one is rewritten |
| Integrity | `0076`-style structural assertion: the backfill refuses if the Phase 14 key set is not exactly two keys with exactly one sensitive |
| Performance | the auth lookup is **one** unique-index hit with the RLS qual evaluated once per query, not once per row — the concern `0086_phase4_rls_quals_once_per_query.sql` exists for; measured on the dedicated performance lane, never inside a correctness gate (PART 18) |

---

*`PREPARED / NOT PROMOTED`. No number allocated. Prepared 2026-10-07 from
`93084f8`.*

## §15. Live-code citation provenance

**Every citation in this request is verified at the declared base `93084f8`.**
The tree this container has checked out is **`6fc505d`**, which is `93084f8`'s
**ancestor** — so the declared base is **not in the history of the commit
carrying this pack**, and a reader who verifies a citation against the branch
they checked out may get a different file. `git merge-base --is-ancestor
93084f8 <head>` fails by design here.

### What this pack claims, exactly (CHALLENGE R4 P2-02)

Earlier revisions of this section read as though each citation carried its own
recorded tree. It does not, and the claim is now stated as what the pack
actually does:

> There is **one declared base for the whole pack**, `93084f8`. No individual
> citation names a tree. The per-file record of what that base costs a reader
> on another tree is the **generated** table below, which is derived by
> scanning the pack rather than kept by hand, and which names, per cited file,
> which pack documents cite it.

That is per-*file* provenance, generated; it is not per-*citation* provenance,
and this section no longer implies otherwise. Pinning the tree at read time is
`P14-GATE-032`'s obligation, below.

### The measurement (CHALLENGE R4 P2-01)

The previous table and its "six of the fourteen" count were **typed from a
hand-kept list**, which is the same mechanism the base-tree trap is made of.
The table below is produced by `tools/citation-provenance.py`, which scans
every pack document for `` `path:line` `` citations, resolves each against
`git ls-tree` at the declared base, and compares the blobs.

Two corrections came out of generating it rather than typing it:

- the count was wrong in **both** directions — not "six of fourteen", and not
  the eleven the challenger inferred from the hand-kept list either;
- two citations were **bare basenames that resolve to several real files** —
  an unqualified errors.ts, which matches three files in the tree, and an
  unqualified tokens.ts, which matches two. Both are now cited by full path
  (CHALLENGE R4 P3-04), and with the ambiguity gone the generated set is
  smaller and truer: three rows of the pre-fix run existed only because a
  basename matched a file the pack never cited. (Those two names are written
  here **without backticks on purpose** — the generator scans backticked
  tokens, so writing them as citations in the very paragraph that retires them
  would resurrect them in the table. The generated block below is the
  authority for the counts, and it is checked, not typed.)

<!-- BEGIN GENERATED citation-provenance -- do not edit by hand -->
| Cited file | `6fc505d` vs `93084f8` | cited as | cited in |
|---|---|---|---|
| `.prettierrc.json` | identical | `.prettierrc.json` | P14-AMENDMENT-20-CHALLENGE-ROUND-14, P14-AMENDMENT-21-CHALLENGE-ROUND-15 |
| `infrastructure/database/migrations/0002_identity.sql` | identical | `0002_identity.sql` | P14-S0-ARCHITECTURE-LOCK |
| `infrastructure/database/migrations/0003_tenancy.sql` | identical | `0003_tenancy.sql` | P14-MIGRATION-PATCH-REQUEST |
| `infrastructure/database/migrations/0004_infra.sql` | identical | `0004_infra.sql` | P14-AMENDMENT-04-MISSION-V2, P14-MIGRATION-PATCH-REQUEST, P14-S0-ARCHITECTURE-LOCK |
| `infrastructure/database/migrations/0006_rls.sql` | identical | `0006_rls.sql` | P14-AMENDMENT-03-CONTINUOUS-MISSION, P14-MIGRATION-PATCH-REQUEST, P14-S0-ARCHITECTURE-LOCK |
| `infrastructure/database/migrations/0010_db_roles.sql` | identical | `0010_db_roles.sql` | P14-AMENDMENT-03-CONTINUOUS-MISSION, P14-AMENDMENT-07-CHALLENGE-ROUND-2, P14-MIGRATION-PATCH-REQUEST, P14-S0-ARCHITECTURE-LOCK |
| `infrastructure/database/migrations/0014_branch_scopes.sql` | identical | `0014_branch_scopes.sql` | P14-AMENDMENT-03-CONTINUOUS-MISSION, P14-MIGRATION-PATCH-REQUEST |
| `infrastructure/database/migrations/0020_credential_delivery_outbox.sql` | identical | `0020_credential_delivery_outbox.sql` | P14-AMENDMENT-03-CONTINUOUS-MISSION, P14-MIGRATION-PATCH-REQUEST, P14-S0-ARCHITECTURE-LOCK |
| `infrastructure/database/migrations/0025_credential_payload_protection.sql` | identical | `0025_credential_payload_protection.sql` | P14-MIGRATION-PATCH-REQUEST, P14-S0-ARCHITECTURE-LOCK |
| `infrastructure/database/migrations/0045_accounting_post_entry.sql` | identical | `0045_accounting_post_entry.sql` | P14-AMENDMENT-03-CONTINUOUS-MISSION, P14-MIGRATION-PATCH-REQUEST |
| `infrastructure/database/migrations/0054_inventory_assertion_authority.sql` | identical | `0054_inventory_assertion_authority.sql` | P14-MIGRATION-PATCH-REQUEST, P14-S0-ARCHITECTURE-LOCK |
| `infrastructure/database/migrations/0073_default_warehouse_locale_name.sql` | identical | `0073_default_warehouse_locale_name.sql` | P14-AMENDMENT-09-CHALLENGE-ROUNDS-4-5, P14-AMENDMENT-10-CHALLENGE-ROUND-6, P14-HANDOFF-MANIFEST, P14-MIGRATION-PATCH-REQUEST |
| `infrastructure/database/migrations/0076_phase4_permission_defaults_backfill.sql` | **ABSENT at 6fc505d** | `0076_phase4_permission_defaults_backfill.sql` | P14-MIGRATION-PATCH-REQUEST |
| `infrastructure/database/migrations/0079_phase4_pos_till_sessions_cart.sql` | **ABSENT at 6fc505d** | `0079_phase4_pos_till_sessions_cart.sql` | P14-AMENDMENT-10-CHALLENGE-ROUND-6, P14-MIGRATION-PATCH-REQUEST, P14-S0-ARCHITECTURE-LOCK |
| `infrastructure/database/migrations/0086_phase4_rls_quals_once_per_query.sql` | **ABSENT at 6fc505d** | `0086_phase4_rls_quals_once_per_query.sql` | P14-MIGRATION-PATCH-REQUEST |
| `docs/DAFTAR_DATA_MODEL.md` | identical | `DAFTAR_DATA_MODEL.md` | P14-S0-ARCHITECTURE-LOCK |
| `infrastructure/database/MIGRATION_MANIFEST.json` | **DIFFERS** (+27/-3) | `MIGRATION_MANIFEST.json` | P14-AMENDMENT-10-CHALLENGE-ROUND-6, P14-AMENDMENT-11-CHALLENGE-ROUND-7-AND-COORD-REVIEW, P14-HANDOFF-MANIFEST, P14-MIGRATION-PATCH-REQUEST, README-AR |
| `apps/api/src/common/guards.ts` | identical | `apps/api/src/common/guards.ts` | P14-HANDOFF-MANIFEST, P14-S0-ARCHITECTURE-LOCK, P14-TASK-DAG |
| `apps/api/src/infra/database.ts` | **DIFFERS** (+190/-15) | `apps/api/src/infra/database.ts` | P14-AMENDMENT-03-CONTINUOUS-MISSION |
| `apps/api/src/infra/redis.ts` | identical | `apps/api/src/infra/redis.ts` | P14-AMENDMENT-01-SEALED-CONTRACTS, P14-HANDOFF-MANIFEST, P14-S0-ARCHITECTURE-LOCK, P14-TASK-DAG |
| `apps/api/src/modules/auth/tokens.ts` | identical | `apps/api/src/modules/auth/tokens.ts` | P14-AMENDMENT-09-CHALLENGE-ROUNDS-4-5, P14-MIGRATION-PATCH-REQUEST, P14-S0-ARCHITECTURE-LOCK |
| `apps/api/src/modules/delivery/credential-protector.ts` | identical | `apps/api/src/modules/delivery/credential-protector.ts` | P14-S0-ARCHITECTURE-LOCK |
| `apps/api/src/modules/inventory/inventory-reads.controller.ts` | identical | `apps/api/src/modules/inventory/inventory-reads.controller.ts` | P14-AMENDMENT-05-MISSION-V3, P14-MIGRATION-PATCH-REQUEST |
| `apps/api/src/modules/outbox/publisher.ts` | identical | `apps/api/src/modules/outbox/publisher.ts` | P14-AMENDMENT-01-SEALED-CONTRACTS, P14-HANDOFF-MANIFEST, P14-S0-ARCHITECTURE-LOCK, P14-TASK-DAG |
| `apps/api/src/modules/receivables/receivables.controller.ts` | **ABSENT at 6fc505d** | `apps/api/src/modules/receivables/receivables.controller.ts` | P14-OPEN-DECISIONS-AR, P14-S0-ARCHITECTURE-LOCK |
| `packages/domain-core/src/capabilities.ts` | identical | `capabilities.ts` | P14-AMENDMENT-02-DIRECTIVE-11 |
| `.github/workflows/ci.yml` | **DIFFERS** (+242/-21) | `ci.yml` | P14-HANDOFF-MANIFEST |
| `docs/DAFTAR_SECURITY_MODEL.md` | identical | `docs/DAFTAR_SECURITY_MODEL.md` | P14-OPEN-DECISIONS-AR, P14-S0-ARCHITECTURE-LOCK |
| `docs/DAFTAR_THREAT_MODEL.md` | identical | `docs/DAFTAR_THREAT_MODEL.md` | P14-OPEN-DECISIONS-AR, P14-S0-ARCHITECTURE-LOCK |
| `packages/domain-core/src/errors.ts` | identical | `domain-core/src/errors.ts` | P14-CONTRACT-PACK |
| `apps/api/src/common/error.filter.ts` | **DIFFERS** (+59/-0) | `error.filter.ts` | P14-S0-ARCHITECTURE-LOCK |
| `apps/api/src/infra/request-context.ts` | identical | `infra/request-context.ts` | P14-CONTRACT-PACK |
| `apps/api/src/modules/inventory/inventory-authorization.ts` | **DIFFERS** (+117/-1) | `inventory/inventory-authorization.ts` | P14-AMENDMENT-05-MISSION-V3, P14-MIGRATION-PATCH-REQUEST |
| `packages/shared-contracts/src/invoices.ts` | **ABSENT at 6fc505d** | `invoices.ts` | P14-AMENDMENT-01-SEALED-CONTRACTS |
| `apps/api/src/modules/tenancy/tenancy.service.ts` | identical | `modules/tenancy/tenancy.service.ts` | P14-HANDOFF-MANIFEST, P14-TASK-DAG |
| `package-lock.json` | **DIFFERS** (+123/-138) | `package-lock.json` | P14-AMENDMENT-20-CHALLENGE-ROUND-14 |
| `package.json` | **DIFFERS** (+15/-2) | `package.json` | P14-AMENDMENT-21-CHALLENGE-ROUND-15 |
| `packages/domain-core/src/money.ts` | identical | `packages/domain-core/src/money.ts` | P14-CONTRACT-PACK |
| `packages/domain-core/src/permissions.ts` | **DIFFERS** (+66/-1) | `packages/domain-core/src/permissions.ts` | P14-HANDOFF-MANIFEST, P14-S0-ARCHITECTURE-LOCK, P14-TASK-DAG |
| `apps/api/src/modules/pos/pos-cart-routes.ts` | **ABSENT at 6fc505d** | `pos/pos-cart-routes.ts` | P14-AMENDMENT-05-MISSION-V3, P14-MIGRATION-PATCH-REQUEST |
| `apps/api/src/modules/pos/pos-permissions.ts` | **ABSENT at 6fc505d** | `pos/pos-permissions.ts` | P14-AMENDMENT-05-MISSION-V3, P14-MIGRATION-PATCH-REQUEST |
| `packages/accounting/vectors/README.md` | identical | `proofs/README.md` | P14-AMENDMENT-08-CHALLENGE-ROUND-3, P14-AMENDMENT-09-CHALLENGE-ROUNDS-4-5, P14-AMENDMENT-10-CHALLENGE-ROUND-6 |
| `scripts/static-guards.ts` | **DIFFERS** (+106/-9) | `scripts/static-guards.ts` | P14-S0-ARCHITECTURE-LOCK |
| `apps/api/src/modules/selling/customers.controller.ts` | **ABSENT at 6fc505d** | `selling/customers.controller.ts` | P14-AMENDMENT-05-MISSION-V3, P14-MIGRATION-PATCH-REQUEST |
| `apps/api/src/modules/pos/till-sessions.controller.ts` | **ABSENT at 6fc505d** | `till-sessions.controller.ts` | P14-MIGRATION-PATCH-REQUEST |

**45 cited files resolved: 9 DIFFER, 27 identical, 9 ABSENT at `6fc505d`.**

Scanned population: backticked citations with one of these extensions — `.ts`, `.tsx`, `.sql`, `.yaml`, `.yml`, `.kt`, `.js`, `.json`, `.sh`, `.py`, `.md` — taken from **41 document(s)**: every `.md` and `.yaml` under the pack, walked recursively (so `proofs/README.md` and the case headers are included), excluding the challenge reports and the coordinator reviews, which are other people's words committed unedited, and excluding this generated block itself, which would otherwise count its own rows. The population is printed because `ROUND-6 P2-01` and `COORD-DIFF-REVIEW R1 P3-12` each found the sentence claiming more than the pattern matched: first `json` was missing — and the one cited file whose difference changes a RULE is a `.json` — then `md` was, and only top-level documents were read.

Absent at `6fc505d`: `apps/api/src/modules/pos/pos-cart-routes.ts`, `apps/api/src/modules/pos/pos-permissions.ts`, `apps/api/src/modules/pos/till-sessions.controller.ts`, `apps/api/src/modules/receivables/receivables.controller.ts`, `apps/api/src/modules/selling/customers.controller.ts`, `infrastructure/database/migrations/0076_phase4_permission_defaults_backfill.sql`, `infrastructure/database/migrations/0079_phase4_pos_till_sessions_cart.sql`, `infrastructure/database/migrations/0086_phase4_rls_quals_once_per_query.sql`, `packages/shared-contracts/src/invoices.ts` — a reader on that tree cannot verify these citations at all.

**Cited tokens that are not live code at `93084f8`, classified.** Each token is in exactly one bucket, and the generator asserts that all six add up to the 155 unresolved tokens. The counts below are of FILES (spellings of one path folded together); the token count is given beside each, because an earlier edition counted tokens while saying files and the buckets summed to one more than existed (`COORD-DIFF-REVIEW R1 P2-02`).
- **123 file(s)** (130 tokens) resolve to real files INSIDE this pack — its proof scripts, its driver and its tools — which live in the pack and not in the repo.
- **1 file(s)** (2 tokens) were proof scripts this pack DELETED and still names: `cases/c7a_cross_business_accepted.sql`. Git knows them under the pack, so they are neither live code nor proposed files, and a reader must not look for them.
- **8 file(s)** (8 tokens) are cited by an ABSOLUTE path outside the repository (`/mnt/project-files/directives/DIRECTIVE-11-PER-PHASE.md`, `/mnt/project-files/directives/MASTER-CONTINUOUS-MISSION-PER-PHASE.md`, `/mnt/project-files/directives/MASTER-CONTINUOUS-MISSION-V2-DELTA.md`, `/mnt/project-files/directives/MASTER-CONTINUOUS-MISSION-V3-DELTA.md`, `/mnt/project-files/phase14/P14-AMENDMENT-01-SEALED-CONTRACTS.md`, `/mnt/project-files/phase14/P14-MIGRATION-PATCH-REQUEST.md`, `/mnt/project-files/phase14/P14-OPEN-DECISIONS-AR.md`, `/mnt/project-files/phase14/P14-OPENAPI-SKELETON.yaml`). They are not resolved here: resolving an absolute token would measure this host rather than either tree.
- **3 file(s)** (3 tokens) are documents that live OUTSIDE this pack and outside both trees — another phase's pack, or a directive — cited by name: `LEDGER.md`, `P4-SLOT4-ROSTER-PROOF-LAW.md`, `promoted/HANDOFF.md`. They are not files this phase proposes.
- **1 file(s)** (1 tokens) are spelled like one of THIS pack's own documents and are not in the pack: `P14-AMENDMENT-11-CHALLENGE-ROUND-7.md`. Such a token is neither an outside document nor a proposed file — it is a name that exists nowhere, either a typo or a wrong name quoted as wrong (`COORD-DIFF-REVIEW a725342`).
- **10 file(s)** (11 tokens) are files this phase PROPOSES and that correctly do not exist yet: `apps/api/src/modules/integrations/key-material.ts`, `packages/domain-core/src/api-scopes.ts`, `packages/shared-contracts/src/public-api.ts`, `prettier.config.js`, `scripts/phase14-event-catalogue-gate.ts`, `scripts/phase14-gate.ts`, `scripts/phase14-openapi.ts`, `scripts/phase14-registry-gate.ts`, `webhooks/egress-guard.ts`, `webhooks/signature.ts`
  A reader should not look for these in any tree. They are absent at `93084f8` by this scan's own construction. **No gate asserts their absence, and `--check` cannot detect their arrival**: resolution is pinned to `93084f8`, so building the phase would not make them resolve there. What `--check` does detect is this block drifting from the trees it describes.
<!-- END GENERATED citation-provenance -->

**The frozen-migration sentence, corrected (CHALLENGE R4 P3-03).** Earlier
revisions said *every cited frozen migration is byte-identical at both trees*.
That is false: **three cited migrations do not exist at `6fc505d` at all** —
`0076_phase4_permission_defaults_backfill.sql`,
`0079_phase4_pos_till_sessions_cart.sql` and
`0086_phase4_rls_quals_once_per_query.sql`, all three of them Phase 4's
unmerged work. The conclusion the sentence was carrying nevertheless **holds,
for a reason that must be stated rather than assumed**: every migration this
pack cites *for an RLS policy, a grant or a role* — `0002`, `0003`, `0004`,
`0006`, `0010`, `0014`, `0020`, `0025`, `0045`, `0054` — is byte-identical at
both trees. So no RLS, grant or policy citation in this request is exposed to
the trap, and a reader on `6fc505d` cannot check the three absent ones at all
rather than checking them wrongly, which is the better of the two failures.

What the three absent ones are cited **for** has to be said rather than
generalised, because two of them are not route-surface facts: `0076` and `0086`
are cited for Phase 4 permission and RLS surface facts, and **`0079` is cited as
the freeze boundary** — `frozenThrough = 0079_phase4_pos_till_sessions_cart.sql`
— in four places in this pack.

**And the boundary is worse than unverifiable on the other tree: it
CONTRADICTS (`CHALLENGE R6 P2-01`).** The boundary is not the migration file, it
is a **field**, and this pack says so itself:
`infrastructure/database/MIGRATION_MANIFEST.json`. That file exists at **both**
trees, and it was read at both rather than reasoned about:

| tree | `frozenThrough` in `MIGRATION_MANIFEST.json` |
|---|---|
| `93084f8` (declared base) | `0079_phase4_pos_till_sessions_cart.sql` |
| `6fc505d` (checked out) | **`0073_default_warehouse_locale_name.sql`** |

**And at the declared base that file disagrees with itself
(`COORD-DIFF-REVIEW R1 P3-11`).** At `93084f8`, `MIGRATION_MANIFEST.json` has
`frozenThrough = 0079_phase4_pos_till_sessions_cart.sql` on line 3, while its
own `policy` text on line 4 says *"Migrations 0000–0078 are FROZEN"* and
*"every schema correction is a NEW migration appended after 0078"*. Both were
read, not inferred. **Fixing that is not Phase 14's to do; disclosing it is**,
and it matters here because this pack's standing rule — `0000`–`0079` are
byte-immutable — follows the field and not the prose, so a reader comparing the
two will find the file's own two answers before they find a disagreement with
this pack. It is raised to the Migration Owner with no number and no filename
proposed, like everything else in this request.

So a reader on `6fc505d` does **not** fail to verify the freeze line. They
verify it, get `0073`, and conclude this pack's boundary is wrong by six
migrations — a coherent reading of the wrong world, which is this section's own
thesis applied to a **rule** instead of a citation, and strictly worse than
being unable to check. An earlier revision of this paragraph said *cannot verify
the freeze boundary at all*; that sentence was **adopted from a reviewer's
phrasing without being measured**, which is the thing this section exists to
warn against, and it is corrected here with the reading of the file.

**The two remediations, and why neither is taken.**

1. **Cut this pack's branch from `93084f8` instead of from `6fc505d`.** This was
   available at cut time and was not done — and the designated-branch rule
   constrains the branch's *name*, not the commit it is cut from, so that rule is
   no answer to this finding and is not offered as one. The reason not to do it
   is different and is an engineering one: `93084f8` carries **327 files and
   133,615 insertions** of Phase 4's work, which is **unmerged and unsigned**
   (PR #6, with `S7 C1` open). A docs-only Phase 14 branch that contained it
   would misrepresent itself as carrying another phase's unreviewed state, and
   merging it in now has the same effect.
2. **Rewrite the branch's history.** Forbidden outright, and not proposed.

**So the fix is this generated table plus a gate obligation**, not a different
commit. `P14-GATE-032` is extended twice over:

- it **asserts each citation against `93084f8` in an explicitly checked-out
  worktree**, never against whatever tree the runner happens to have — because
  a citation verified against the wrong tree is not a typo, it is a coherent
  reading of the wrong world, and it will keep producing findings that look
  like carelessness;
- and it **runs `tools/citation-provenance.py --check` on this document**,
  which exits `1` when the block above has drifted from the trees. A
  provenance table that cannot detect its own staleness is a typed claim
  again, which is exactly the defect this round found.

**The generator's own first run was wrong, and that is the fourth appearance
of this round's pattern.** It reported `absent=0` while `0079` is genuinely
absent at `6fc505d`, because `git rev-parse <rev>:<missing path>` exits
non-zero **but still echoes the ref to stdout**, so a missing file read as a
present blob while only stdout was checked. The fix is one line
(`if rb.returncode == 0`), the note is in the script, and the lesson is that
the instrument written to replace a hand-kept claim must itself be measured:
`0079`'s absence was confirmed against `git` directly before either the
generator or the challenge report was believed.
