# P14-S0 — PHASE 14 ARCHITECTURE LOCK
## Integrations · Public API · Developer Platform

- **Status: `PREPARED / NOT PROMOTED`** (master directive PART 9).
- **Authority: this document is a PROPOSAL for Tech Lead ruling.** It creates no
  product code, no endpoint, no screen and **no migration number** (PART 10).
- Prepared from the live tree `origin/phase/4-sales-pos-customers-receivables`
  at `93084f8` (`fix(p4s1-gate): a delegator may not also compute`), read on
  2026-10-07. Every claim about existing behaviour below carries its
  `file:line` or migration name; nothing here is asserted from memory.
- Scope source: master directive **PART 34** — API key lifecycle, scopes,
  webhook infrastructure, outbound events, inbound adapters, rate limiting,
  audit, developer docs, rotation/revocation, idempotency, versioning, and the
  binding law **“No public API bypasses business permissions.”**
- Phase 14 **does not start** before Phase 13 PASS (roadmap rule 1). This is
  preparation under PART 9 only.

### ملخص عربي (للمراجعة)

هذه وثيقة **تحضير فقط** للمرحلة 14 (التكاملات وواجهة البرمجة العامة ومنصّة
المطوّرين). لا تنشئ أي migration ولا أي كود، ولا تُرقّى قبل إقفال المراحل التي
قبلها. القوانين الأساسية المقترحة:

1. مفتاح الـAPI **ليس سلطة جديدة**: صلاحياته الفعلية = صلاحيات العضوية الحيّة
   ∩ نطاقات المفتاح، ويُحسب في كل طلب ولا يُخزَّن كصورة ثابتة.
2. **النطاق (scope) هو نفسه مفتاح صلاحية (permission)** موجود أصلًا — لا قاموس
   ثانٍ ولا جدول ترجمة يمكن أن يتباعد عن الأصل.
3. الواجهة العامة **لا تملك أي سلطة مالية**: تنادي نفس خدمات Phase 2/3/4 ولا
   تكتب قيدًا ولا تحرّك مخزونًا بنفسها.
4. أحداث الـwebhook مصدرها الوحيد `outbox_events` القائم، وحمولتها **تُسقَط
   بمُسقِط مكتوب لكل نوع حدث** (المنع هو الأصل) حتى لا تتسرّب بيانات داخلية.
5. لا توجد في هذه المرحلة أي دالة `SECURITY DEFINER` جديدة.
6. القرارات التي تحتاج حكمك مجموعة في `P14-OPEN-DECISIONS-AR.md` (ثمانية
   قرارات)، وأهمها: هوية المفتاح (موظف مُفوَّض أم هوية آلية)، ومنع المفاتيح من
   حمل الصلاحيات الحسّاسة.

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

## §1. What Phase 14 is, and what it must never become

Phase 14 adds a **second front door** to a system whose authority model is
already settled. It adds no domain. It adds no money. Its entire engineering
risk is that the new door is **wider than the old one** — in any of four ways:

| Widening | Concrete failure | Law that closes it |
|---|---|---|
| A credential that outlives an authority | a revoked member's key keeps selling | §3 / `P14-AL-02` |
| A vocabulary that drifts from the authority | a scope that is not a permission | §4 / `P14-AL-03` |
| A payload wider than the caller's right | an internal outbox field reaches a merchant | §7 / `P14-AL-13` |
| An egress the merchant controls | a webhook URL aimed at cloud metadata | §8 / `P14-AL-15` |

Everything else in this document exists to serve those four rows.

## §2. The authority that already exists (verified facts)

These are not proposals. They are the live mechanisms Phase 14 must bind to,
and the reason Phase 14 needs no new evaluator.

| Fact | Evidence |
|---|---|
| One guard resolves principal → business → permission; the client *requests* a business via `X-Business-Id` and the **server** resolves membership | `apps/api/src/common/guards.ts:45-87` |
| Permission registry is a closed TypeScript tuple of 58 keys, 30 of them marked sensitive; every key matches `^[a-z]+(\.[a-z_]+)+$` | `packages/domain-core/src/permissions.ts:11-89` and `:97-145` |
| Permission rows in the database carry **no** FK to a registry (`role_permissions.permission TEXT`) | `infrastructure/database/migrations/0003_tenancy.sql:35-41` |
| A closed-registry-with-regex-CHECK pattern already exists for operation codes | `0054_inventory_assertion_authority.sql:52-56` (`inventory_operation_kinds`) |
| Transactional outbox with at-least-once delivery, `FOR UPDATE SKIP LOCKED`, exponential backoff, dead-letter, and a pluggable `OutboxSink` seam | `apps/api/src/modules/outbox/publisher.ts:16-74`; table `0004_infra.sql:25-37` |
| Append-only audit with UPDATE/DELETE triggers and a `request_id` column | `0004_infra.sql:2-23` |
| Rate limiter interface with a **fail-closed** outage contract (`RateLimiterUnavailableError` → safe 503, never “no limit”) | `apps/api/src/infra/redis.ts:11-43` |
| Opaque secrets are stored as SHA-256 only; comparison is `timingSafeEqual`; passwords use argon2id | `apps/api/src/modules/auth/tokens.ts:105-122`, `0002_identity.sql:17` |
| Recoverable secrets use application-level AES-256-GCM envelope encryption with a key ring, AAD context binding, and KMS-style encrypt/decrypt separation | `apps/api/src/modules/delivery/credential-protector.ts:4-29,137-207`; `0025_credential_payload_protection.sql:1-27` |
| A hardened outbound HTTPS client already exists: HTTPS-only, bearer auth, bounded timeout with abort, bounded response size, schema-validated response, one retry, errors that never carry the body | `credential-protector.ts:196-207` |
| Inbound event de-duplication shape is **already fixed by an accepted document**: real columns `(business_id, event_source, external_event_id)`; a shared idempotency registry, if one ever appears, must carry a real `operation_type` column | `docs/DAFTAR_DATA_MODEL.md:433-435` |
| The repository's command idempotency convention is **client-chosen resource ids** — “201 on create, 200 on replay. There is no `idempotencyKey` header” | `apps/api/src/modules/receivables/receivables.controller.ts:43-45` |
| Webhook security is already a committed requirement (signature + idempotency + replay protection) and `TH-06 Webhook Replay` is already in the threat model | `docs/DAFTAR_SECURITY_MODEL.md:41`, `docs/DAFTAR_THREAT_MODEL.md:14` |
| Row level security is ENABLE **and** FORCE on new tables, with policies keyed on `app.tenant_id` / `app.business_id` GUCs and named database roles | `0006_rls.sql`, `0020_credential_delivery_outbox.sql:25-34` |

**Consequence:** Phase 14 writes no authorization logic. It writes a
**credential resolver** and a **narrowing**, and hands the result to the
evaluator that already exists.

## §3. The credential model

### `P14-AL-01` — ONE AUTHORIZATION PATH
A public API request is authorized by the same evaluator as a merchant web
request (`MembershipResolver.require`, `guards.ts:17-20`, whose `require` is line 19). No public controller
performs its own permission check. No second evaluator is written. A public
route carries the **same** `@RequiresPermission(...)` metadata as its internal
sibling.

### `P14-AL-02` — A KEY IS A DELEGATION, NOT AN AUTHORITY
A key's **effective permission set** is

```
effective = live_membership_permissions(subject, business) ∩ key_scopes
```

computed **per request**, never snapshotted into the key row. Therefore:

- A member who loses a permission loses it on every key they delegated, at the
  next request, with no revocation step.
- A membership revoked or a user disabled makes every key of that subject
  **inert** — the key does not become partially valid, it resolves to the empty
  set and every scoped route refuses.
- The key row stores scopes; it never stores permissions, roles or a “grants”
  blob. A stored permission would be a second truth that drifts the moment a
  role is edited.

This is the single most important law in the phase: a snapshot here is exactly
the “fired employee keeps posting sales” defect, and it is invisible in tests
that only ever use a live, fully-permissioned member.

### `P14-AL-03` — A SCOPE IS A PERMISSION
`PUBLIC_API_SCOPES ⊆ PERMISSIONS` (`permissions.ts:11`). There is no scope
vocabulary, no `read:invoices`-style alias, and no mapping table. A scope string
that is not a permission key cannot exist:

- in TypeScript, by a `satisfies readonly Permission[]` constraint;
- in the database, by a closed registry table whose rows the migration inserts
  (the `inventory_operation_kinds` pattern, `0054:52`), with a real FK from the
  key's scope rows — so a scope inserted by direct SQL is refused by the
  database, not merely by the application;
- in CI, by a **bijection** gate: the TypeScript set and the registry rows must
  be equal in both directions, and the gate must turn red when either side
  gains or loses one element. (A count-only check is not acceptable: the S5
  record of this project already proved that a count floor is satisfied by
  corrupt content — `P4-SLOT4-ROSTER-PROOF-LAW.md`.)

### `P14-AL-04` — THE NARROWING LIVES IN ONE PLACE
The intersection is applied inside the membership authority
(`TenancyService.require`), on the `MembershipContext` object — not at each
route, and not in the public controllers. A controller that forgets a decorator
must fail **closed**: a delegated context with no required permission declared
is refused, because an undeclared route on the public surface is a defect, not
an “authenticated only” route. (`guards.ts:23,72` treats missing metadata as
“authenticated only”; that default is correct for the internal surface and
**wrong** for the public one, so the public guard inverts it.)

Proof obligation: a property test over `PERMISSIONS × scope-subsets` asserting
that `require(delegated(ctx, S), p)` throws for every `p ∉ S` **even when the
underlying membership allows `p`**, plus a mutation proof that deleting the
intersection line turns that test red.

### `P14-AL-05` — TWO SURFACES, NO CROSSOVER
An API key presented on an internal route is refused. A session access token
presented on a public route is refused. Neither is “also accepted for
convenience”. Proof obligation: a route-enumeration test that walks every
registered route of the Nest application, classifies it by prefix, and asserts
the credential type its guard accepts — so a route added later cannot quietly
join the wrong surface.

### `P14-AL-06` — THE KEY CARRIES THE BUSINESS
For a key credential the business is **the key's own business**. An
`X-Business-Id` header that differs is a refusal (`KEY_BUSINESS_MISMATCH`, the repository's `ApiErrorCode` style at the HTTP boundary — `errors.ts:6-31` — not a dotted domain code),
never an override and never silently ignored. A key cannot pivot to another
business of the same tenant.

### `P14-AL-07` — NO SENSITIVE PERMISSION IN A KEY (Phase 14 default)
A key may not be created with, nor exercise, any permission in
`SENSITIVE_PERMISSIONS` (`permissions.ts:97-145`) — `sales.void`,
`sales.return`, `sales.discount`, `payments.reverse`, `refunds.approve`,
`installments.manage`, every `accounting.*` authority key, every stock-moving
key, and every member/role key. Reason: a key is an **unattended** credential,
and the `OD-P4-01` ruling of 2026-09-30 already refused sensitive permissions
as defaults even for a human cashier. An unattended credential is strictly
weaker ground than a cashier. Relaxation is `OD-P14-02`, not an implementation
choice.

### `P14-AL-08` — THE SECRET IS WRITE-ONCE AND IMMUTABLE
- 32 bytes from `randomBytes`, presented **once** in the creation response.
- Stored as SHA-256 hex only (the refresh-token precedent, `tokens.ts:105`).
  Argon2 is deliberately **not** used: it is the right answer for low-entropy
  human passwords and the wrong answer for a 256-bit random secret on a hot
  path.
- Lookup is by the key's **public id** (indexed), then
  `timingSafeEqual` on the digest (`tokens.ts:112`). No table scan, no
  comparison that leaks length by early return.
- A key row's `key_id` and secret digest are **immutable after insert**,
  enforced by a database trigger. One key row has exactly one secret for its
  whole life, which is what makes the audit trail of a leak answerable.
- **Rotation (amended by Directive 11 PART 95, 2026-10-12): there is no grace
  window.** The pack previously said “revoke the old one with a grace window”;
  an implicit, hard-coded overlap is forbidden. Rotation is: mint a replacement
  key, which records its predecessor in data (`replaces_api_key_id`); overlap
  exists **only when explicitly requested**, and is audited; the predecessor is
  revoked **now**, or at a **configured timestamp** stored on the row. No
  default overlap, no indefinite overlap.
- **Revocation takes effect at the auth check.** The resolver reads the key row
  on every request and the public surface holds **no authorization cache** — a
  cached decision is the “effective a few minutes later” behaviour PART 95
  refuses. The cost of the rule is one indexed read, and `key_id`'s unique
  index is what makes it cheap.

### `P14-AL-09` — THE PUBLIC API ADDS NO FINANCIAL AUTHORITY
A public write calls the **same** service method the merchant web app calls. It
opens no transaction of its own, mints no assertion of its own, computes no
total, and touches no minor unit (the taste of
`receivables.controller.ts:47` — “Not a single minor unit is added, compared or
converted in this file”). PART 11 and PART 12 of the master directive are
untouched by this phase.

## §4. Scopes

The Phase 14 scope set is the **ordinary** (non-sensitive) subset of the
permissions whose domains have a public surface, plus the two new integration
keys of §5. Proposed initial set, every element already a `Permission`:

```
catalog.view      inventory.view    sales.view        sales.create
customers.view    customers.manage  payments.collect  receivables.view
purchases.view    suppliers.view    accounting.view   business.view
```

A “read-only key” is not a flag — it is a key whose scopes are the `*.view`
subset. A flag would be a second truth that could disagree with the scopes.

## §5. Two new permissions (registry change)

Phase 14 appends exactly two keys to `PERMISSIONS`, both satisfying the frozen
operation-code regex and the plural-prefix convention recorded at
`permissions.ts:69-75`:

| Key | Grants | Sensitive? | Built-in default |
|---|---|---|---|
| `integrations.view` | list keys (never secrets), list webhook endpoints, read delivery history | no | owner only |
| `integrations.manage` | create/revoke keys, create/disable endpoints, replay a delivery | **yes** | owner only |

`integrations.manage` is sensitive for the same reason `role.assign` is: it
mints standing authority. Neither key is a manager default — issuing a
credential that acts without a human present is an owner's decision. A backfill
for existing businesses' owner roles is required (the `0076` precedent) and is
specified in the patch request.

## §6. Surface, versioning and shape

### `P14-AL-10` — THE PUBLIC CONTRACT IS SEPARATE FROM THE INTERNAL ONE
The internal routes are already `/v1` (`receivables.controller.ts:51`) and are
**not** a public contract: they change with every phase. The public surface is
a distinct prefix (`/public/v1`, `OD-P14-03`) with **its own DTOs** in
`packages/shared-contracts`. An internal DTO change may not alter a public
response; a type-level test pins each public shape so the breakage is a
compile error rather than a silent contract change.

### `P14-AL-23` — VERSION POLICY
Additive within a version (new optional response field, new endpoint, new
enum member *only* where the client contract documents forward-compatibility).
Removing or narrowing anything is a new version. At most two versions live at
once; the older one answers with a `Sunset` HTTP header and a dated entry in
the public changelog. A version is never changed in place after publication.

### `P14-AL-11` — IDEMPOTENCY FOLLOWS THE REPOSITORY'S CONVENTION
Client-chosen resource ids are the idempotency key: `201` on create, `200` on
replay of the identical intent, and a refusal when the same id arrives with a
different payload digest — the live Phase 4 behaviour
(`receivables.controller.ts:43-45`) and the accounting
`idempotency_conflict` precedent (`0045:738`). Phase 14 adds **no**
`Idempotency-Key` header and **no** shared idempotency registry. If the Tech
Lead wants the header (`OD-P14-01`), its only admissible shape is already
fixed by `DAFTAR_DATA_MODEL.md:434`: a real `operation_type` column and
`UNIQUE(business_id, operation_type, idempotency_key)`, storing a payload
fingerprint and refusing a conflicting replay. It is specified-but-not-created
in the patch request.

### `P14-AL-18` — RATE LIMITING IS FAIL-CLOSED
The public surface reuses the existing `RateLimiter` and inherits its outage
contract: backend unreachable → a safe `503`, never an unlimited request
(`redis.ts:11-43`). Limits are enforced on **three** keys, because any one of
them alone is bypassable:

- per key (`rl:papi:key:<key_id>`) — stops one integration running hot;
- per business (`rl:papi:biz:<business_id>`) — stops a business minting twenty
  keys to multiply its ceiling;
- per endpoint class (read / write / report) — stops a cheap global ceiling
  being spent entirely on the most expensive route.

**Thresholds are configuration, not a number anyone here invents** (Directive 11
PART 97, 2026-10-12): every limit is a configuration value with **no production
default**, and the public surface **refuses to start in production** when they
are unset — the discipline the credential key ring already uses, where
production requires the key and config validation fails startup without it
(`credential-protector.ts:21-25`). The numbers this pack once proposed are
withdrawn; what stands is the bucket shape above, which PART 97 confirms,
including *“no one global counter that lets one business exhaust another's
allowance.”*

Responses carry `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
`X-RateLimit-Reset`, and `Retry-After` on `429`. The current interface's
`take()` returns `void` (`redis.ts:27`), so reporting *Remaining* needs a
widened interface — a shared-file change submitted as `PATCH-REQ-P14-RL-01`
under PART 41, not edited directly.

## §7. Outbound events

### `P14-AL-12` — ONE EVENT SOURCE
`outbox_events` is the only event ledger (`0004_infra.sql:25-37`). Phase 14 adds
**no** second one. Fan-out happens inside the existing publisher's
transaction, through the already-present `OutboxSink` seam
(`publisher.ts:13-15`): the Phase 14 sink writes one `webhook_deliveries` row
per matching **active** subscription, in the same transaction that marks the
outbox row published, so a delivery row cannot exist for an event that was not
published and cannot be duplicated by a publisher re-run (a uniqueness
constraint on `(business_id, endpoint_id, outbox_event_id)` makes that a
database fact, not a hope).

Subscriptions bind **at publish time**: an endpoint created today receives no
event published yesterday. That is intended and documented — a merchant
expecting backfill is expecting a different product.

### `P14-AL-13` — THE PAYLOAD IS PROJECTED, DENY BY DEFAULT
An outbox payload is **internal**. It is never forwarded. Each public event
type has a hand-written, typed **projector** that selects named fields, and the
delivery row stores the projector's **output** — frozen at fan-out. Two gates
make the default actually deny:

1. **Catalogue roster gate.** Every `type` string any code path can insert into
   `outbox_events` is either in the public catalogue (and therefore has a
   projector) or in an explicit internal-only roster. A new internal event type
   added by a later phase turns the gate **red** until someone classifies it;
   it cannot leak by default.
2. **Projection gate.** For each public event type, a fixture asserts the
   projected object's key set **exactly** — so a field added to an internal
   payload does not appear in a merchant's webhook because a spread operator
   let it through.

Red-proof obligation (PART 40): each gate ships with a planted mutation that
makes it red, and the mutation must be shown to have landed in the file before
its run is read — this project has already recorded a `sed` that matched no
line and went green (`daftar-a-red-proof-must-name-the-refusal-it-expects`).

### `P14-AL-14` — SIGNED, TIMESTAMPED, REPLAY-BOUND
- `X-Daftar-Signature: t=<unix>,v1=<hex>` where `v1 = HMAC-SHA256(secret, t + "." + raw_body)`.
  Signing the timestamp **with** the body is what stops a captured body being
  replayed under a fresh timestamp.
- `X-Daftar-Event-Id` (the delivery id), `X-Daftar-Event-Type` and
  **`X-Daftar-Event-Version`** are headers — the event version is required by
  Directive 11 PART 98 and also appears in the envelope as `"version"`. It is
  **not** the same thing as the `v1=` tag inside the signature, which versions
  the *signing scheme*; conflating them is how a signing change silently
  becomes an event-shape change. The
  receiver de-duplicates on the event id. A redelivery of the same event keeps
  the same event id — that is the receiver's only reliable dedupe handle, so it
  is stable by contract.
- The documented receiver check is: reject if `|now − t|` exceeds the
  **published freshness tolerance**, then compare with a constant-time
  comparison. The published sample code does both; a sample that forgets either
  one is a defect in the documentation, and the docs gate executes the sample
  against a known vector rather than merely printing it.
- **The tolerance is a configured value with no number in this pack
  (MISSION FIX 6).** Earlier revisions wrote `300s` in this law, in the receiver
  contract and in a decisions table. It was never approved: it was the common
  default of other vendors, which is not a ruling about this product, and the
  Mission strikes it by name (“احسم مراجع الاحتفاظ وإعداد الحداثة بدل رقم 300s
  غير معتمد”). What this pack fixes is the **mechanism**, which needs no number:
  one configured tolerance, published in the developer documentation and used by
  the sample code and the signing tests from the same source; a value that is
  **not** inferred from retry backoff, lease duration or any other setting; and
  **no production default** — a configuration that omits it is a startup
  refusal, exactly as `P14-AL-18` requires of the rate limits. The number itself
  is `OD-P14-10`, for the owner. A test asserts that no literal tolerance
  appears in the sample, the receiver docs or the verifier, so the number cannot
  re-enter the pack as a “temporary” constant.
- The endpoint secret is **recoverable by necessity** (we must sign with it),
  therefore it is stored envelope-encrypted with a **domain-separated** key
  ring — a Phase 14 ring, never the credential-delivery ring, following the
  same reasoning that gave the accounting posting and control assertions
  separate GUCs (`database.ts:37-43`): a process that holds one ring must not
  thereby be able to read the other's secrets. AAD binds the ciphertext to
  `(business_id, endpoint_id)` so a row's secret cannot be moved to another
  endpoint (`credential-protector.ts:15-19`).
- Only the delivery worker's database role may read the ciphertext columns;
  `daftar_app` holds a column-scoped SELECT that excludes them — the `0025`
  precedent, which exists precisely because “the application can read every
  secret” is the failure mode.

### `P14-AL-15` — EGRESS IS HOSTILE-TARGET-SAFE
A webhook URL is merchant-controlled input, which makes the dispatcher an
SSRF primitive unless every one of these holds:

*(Amended and widened by Directive 11 PART 96, 2026-10-12 — the six additions
are marked **[D11]** and each closed a real hole in the earlier list; see
`P14-AMENDMENT-02-DIRECTIVE-11.md` §2.)*

- `https` only; **[D11]** an explicit allowed-**port** policy rather than a bare
  “443 only”, so a later relaxation is a policy change and not a regex edit;
  enforced by a `CHECK` on the column **and** at dispatch time;
- **[D11]** no **credentials / userinfo** in the URL: `https://victim@internal/`
  parses, and a naive host extraction reads the wrong side of the `@`. The
  column `CHECK` also requires `url !~ '^https://[^/?#]*@'`;
- **all** A and AAAA answers resolved and **every** one validated as globally
  routable — not the first — rejecting loopback, RFC1918/private, link-local,
  CGNAT, IPv6 ULA and link-local, multicast, `169.254.169.254`, **[D11]**
  IPv4-mapped private IPv6 (`::ffff:10.0.0.1`), and **[D11]** noncanonical
  numeric literal forms (`0177.0.0.1`, `2130706433`, `0x7f.1`) together with any
  literal form policy prohibits;
- the connection made **to the validated address** with TLS SNI/Host preserved
  for the approved hostname — resolving and then handing the hostname to a
  generic HTTP client re-resolves and reopens the rebinding window; the
  directive's own acceptance sentence is *“no ‘validate hostname once then let a
  generic HTTP client re-resolve anywhere’”*;
- **[D11]** DNS **revalidated on every later delivery attempt**: a record that
  was public at attempt 1 can be private at attempt 4, and the earlier law
  resolved once per delivery;
- **[D11]** environment proxy surprises disabled or bypassed: an `HTTPS_PROXY`
  in the worker's environment would send the request somewhere the validation
  never examined, making the entire pin meaningless;
- **[D11]** DNS-rebinding / TOCTOU tests are required, not optional;
- redirects never followed (a `3xx` is a delivery failure with a distinct
  classification, not a hop);
- bounded connect/total timeout with abort, bounded response size, response
  body discarded and **never** logged or shown to the merchant beyond a status
  code and an error class;
- no request header carries anything about the Daftar deployment beyond the
  signature, the event headers and a fixed user agent.

The existing `KmsCredentialEncryptor` already implements most of this shape
(`credential-protector.ts:200-206`); the dispatcher reuses it rather than
writing a second HTTP client. The IP-validation predicate is pure and gets its
own fixture table (every rejected CIDR named, one case per class), because a
guard whose subject it cannot parse refuses or admits everything —
`daftar-a-guard-that-cannot-read-its-subject-refuses-everything`.

### `P14-AL-16` — DELIVERY IS AT-LEAST-ONCE, VISIBLE, AND REPLAYED FROM THE RECORD
- Retry with exponential backoff and a dead-letter terminal state, reusing the
  accepted outbox semantics (`publisher.ts:25-31`) rather than inventing a
  second retry policy.
- A worker claims rows with a **lease** (`locked_at`/`locked_by`/`lease_until`,
  the `0025_credential_payload_protection.sql:26-28` precedent) so a crashed worker's rows become reclaimable
  instead of stuck, and `FOR UPDATE SKIP LOCKED` so N workers do not collide.
- An endpoint with a long run of consecutive failures is **disabled** with a
  reason, and the merchant sees it. Silent indefinite retrying against a dead
  URL is a resource leak dressed as reliability.
- **Replay re-sends the stored projection**, never a recomputed one. A replay
  that recomputed from live data would deliver *today's* truth under
  *yesterday's* event id — the worst possible outcome for a merchant
  reconciling.
- Consumers must be idempotent; the delivery contract says so in the same words
  the publisher already uses (`publisher.ts:30`: “a duplicate delivery is
  legal by design”).

## §8. Inbound adapters

### `P14-AL-17` — DEDUPE ON THE SHAPE ALREADY FIXED
Real columns `(business_id, event_source, external_event_id)` with a UNIQUE
constraint — the shape `DAFTAR_DATA_MODEL.md:435` already mandates. A duplicate
is safely ignored. Phase 14 ships the **frame** (verification seam,
de-duplication, audit, typed handler registry) and no production provider: the
providers belong to the phases that own them (payments → Phase 5, WhatsApp →
Phase 8), and each will register its own verifier. An adapter with no
credentials remains `ENGINEERING COMPLETE — EXTERNAL ACTIVATION PENDING`
(PART 65/66), never PASS.

Every inbound adapter verifies **before** parsing beyond what verification
needs, and an unverified body is never persisted in a form a later reader could
mistake for verified data.

## §9. Audit, logging and secrecy

### `P14-AL-19` — AUDIT EVERYTHING, LOG NOTHING SECRET
- Every key-lifecycle action (create, revoke, scope set, endpoint create /
  disable / secret regenerate, delivery replay) writes an `audit_events` row
  with the actor, the key's **public id**, and the request id
  (`0004_infra.sql:2-15`). The table's append-only triggers already make that
  record non-rewritable.
- Every public API write carries the key's public id in the audit metadata of
  the command it invokes, so “which integration did this?” is answerable from
  the ledger alone.
- A key secret, a signing secret, and the `Authorization` header are never
  logged, never echoed in an error body, and never returned by any read
  endpoint. The existing error filter's discipline is the model: a refusal
  renders a stable code and identifiers only, never a secret
  (`error.filter.ts:41-47`). `scripts/static-guards.ts` already exists as the
  place for the grep-level proof of this.

### `P14-AL-20` — THE DEVELOPER DOCS ARE GENERATED
The OpenAPI 3.1 document is generated from the typed public contracts, and a
gate fails when the committed document differs from a fresh regeneration — the
PART 51 rule (generate after the tree stabilises) with the drift check that
makes it enforceable. Hand-maintained API reference prose is forbidden for
anything the schema can state. Narrative guides (authentication, rotation,
webhook verification, rate limits, error codes, versioning) are written in
`ar`/`en`/`tr` to the Phase 1 localization standard, and the webhook
verification sample is **executed** by a test against a known vector.

### `P14-AL-21` — NO MIGRATION NUMBER IS ALLOCATED HERE
PART 10. All DDL lives in `P14-MIGRATION-PATCH-REQUEST.md` with **no** number,
no file in `infrastructure/database/migrations/`, and no manifest edit. The
Migration Owner allocates when Phase 14 is promoted and the predecessor phases
are sealed. `frozenThrough` is `0079_phase4_pos_till_sessions_cart.sql`
(`infrastructure/database/MIGRATION_MANIFEST.json`) and nothing in this phase
touches `0000`–`0086`.

### `P14-AL-22` — NO NEW `SECURITY DEFINER`
Phase 14 introduces no `SECURITY DEFINER` function. Nothing in it needs
cross-tenant visibility: a key resolves inside its own business, a delivery row
belongs to one business, and an inbound event is addressed to one business. The
project's own record shows what a definer costs when its visibility is not
exactly reasoned — a definer that reads as its owner through one policy cannot
distinguish “absent” from “invisible”
(`daftar-under-rls-absent-and-invisible-are-one-answer`). Declining the
mechanism outright is cheaper than proving it safe.

### `P14-AL-24` — PLAN BINDING IS AN ENTITLEMENT, NOT A HARD-CODED TIER
Public API availability is a capability key in the Phase 1 registry
(`packages/domain-core/src/capabilities.ts:26-34`), checked through the
existing entitlements module. Phase 14 adds the key and the check; **Phase 5
owns what it costs** and which plans carry it. A business without it gets a
stable `403` refusal code (it has already proved it owns the business, so there
is nothing to hide behind a 404). Phase 14 never reads a plan name.

### `P14-AL-25` — NO PUBLIC ROUTE OVER AN UNSEALED CONTRACT
Added by §77 of the Final Audited Master Directive (2026-10-08): a route, a
response field or an event is published only when the slice owning its contract
is sealed, and the publishable set is a declared roster a gate enforces when it
generates the OpenAPI document. Full reasoning, the measured seal table and the
seven items this removed from the first public version are in
`P14-AMENDMENT-01-SEALED-CONTRACTS.md`.

### `P14-AL-26` — INDEPENDENT IN FIVE WAYS, NEVER IN THE HOSTNAME
Directive 11 PART 93: the public surface has its own auth guard, DTOs, rate
limits, **audit shaping** and **error shaping**. It **never reads a cookie**,
and no session credential satisfies it — the route-enumeration test of
`P14-AL-05` asserts that negative for cookies too. And **no security decision
depends on the hostname**: a guard that trusted `Host` would grant public
authority to anything that can set a header, and would change meaning the day a
dedicated host arrives. The host is deployment, never authorization.

### `P14-AL-27` — DELEGATION IS DISCLOSED, NOT INFERRED
Directive 11 PART 94 requires UI and documentation to state that a key is
delegated from a member. So the member appears on the creation screen, in the
key list and in the developer documentation, and revoking a membership shows
which live keys go inert. The operational surprise this pack raised as a risk is
closed by disclosure, which the directive requires, rather than by a choice.

### `P14-AL-28` — NO PROOF OF THIS PHASE TOUCHES FROZEN HISTORY
Directive 11 PART 6: `0000`–`0079` are byte-immutable **including for mutation
testing**, and `0080`–`0086` are candidates nobody here edits. Every red proof
in this phase mutates a Phase 14 file — a gate script, a projector, a guard —
never a migration. A proof that would need frozen history modified is wrongly
designed and gets rewritten, not excepted.

### `P14-AL-29` — AN AUTHORIZATION PREDICATE NAMES ONLY COLUMNS THAT EXIST
Added by the Master Continuous Mission (MISSION FIX 1), which found this pack
describing an authentication read of a `status` column that the same pack
declares non-existent. Usability of a key is **derived**, in one SQL expression,
from `revoked_at` and `expires_at`; the refusal code is chosen from the same two
columns; a boolean of intent (`revoke_scheduled`) is written at write time and
**never read to decide usability**. The law is wider than the one slip: no guard,
resolver or policy in this phase may name a column that is not in the migration
request, and a catalogue test — not a reviewer's eye — asserts it, because prose
and schema drift apart silently and a comment cannot hold them together.

### `P14-AL-30` — A SUMMARY NEVER GRANTS WHAT A SECTION DENIES
Added by MISSION FIX 2. Grants are stated **per relation and per operation**,
column-scoped where the column matters, and the matrix is the authority: where a
section's prose disagrees with it, no DDL is written until the request is
corrected. This pack had denied `UPDATE` on `api_key_scopes` in its section and
granted it in its summary, while denying the `DELETE` the section needs to
withdraw a scope — a readable contradiction that a five-column summary made easy
to miss. The matrix is asserted from `information_schema` in both directions with
a planted red proof, so the next contradiction fails a gate instead of surviving
a review.

### `P14-AL-31` — A RESTRICTIVE POLICY IS NOT BYPASSED BY ADDING A PERMISSIVE ONE
Added by MISSION FIX 4, and it corrects a construction this pack proposed twice.
A PERMISSIVE policy keyed on `current_user` suffices on a relation that carries
**no** RESTRICTIVE policy — which is exactly why the `outbox_worker` precedent
works on `outbox_events` (`0010_db_roles.sql:36-38`, and `outbox_events` has no
restrictive policy) — and is **inert** on a relation that carries one, as every
Phase 14 relation does. A context-free principal therefore reaches rows only
through a disjunct inside the RESTRICTIVE policy's **`USING` half**, never its
`WITH CHECK` half, so that nothing it writes is admitted by its role; the
**Security Owner** rules on the principal and the exception; and the exception is
proved by an attack run as that **non-superuser** role with a planted red proof,
not asserted. Until that ruling exists, the affected DDL is not written
(`P14-MIGRATION-PATCH-REQUEST.md` §11a).

### `P14-AL-33` — A PREDICATE IS EXECUTED BEFORE IT IS BELIEVED
Added by the Mission's V2 review, which found that this pack's usability
expression read `A OR B AND C` and so **accepted every never-revoked key however
long ago it expired** — the expiry check was unreachable for exactly the keys it
existed to stop. Boolean precedence, a boundary (`>` versus `>=`), and the clock
a comparison uses are not review-by-reading matters: every authorization
predicate in this phase is asserted by a test that runs it, including its
boundary instants and the case where two conditions hold at once, with a planted
red proof that the parenthesisation is load-bearing. Server time per the
contract; no client-supplied time reaches a predicate.

### `P14-AL-34` — A GRANT FOLLOWS THE QUERY, AND IS NEVER WIDENED TO CLEAR AN ERROR
Added by the same review. Column sufficiency is decided by the statements a path
actually runs — a `WHERE` clause needs the `SELECT` privilege on the column it
restricts on, and a join needs it on the join key — not by the fields a
predicate reads; this pack's narrowed resolver list omitted `key_id` and `id`
and could not have performed its own lookup. And the two directions of a
privilege are independent: **withholding `SELECT` on a column does not withhold
`INSERT` into it**, which is how this pack came to let the merchant request path
insert an API key digest and a subject of its own choosing. Every `INSERT` is
column-scoped to what the role genuinely supplies, and a grant that would be
added to make an error go away is a ruling, never a repair.

### `P14-AL-35` — NO INVARIANT DEPENDS ON A CLOCK THAT KEEPS MOVING
Added by the same review. A constraint whose truth is derived from `now()` is
satisfied at write time and stops being satisfied by the passage of time alone:
this pack's revocation-consistency trigger ran on every `UPDATE` and would have
refused an ordinary `name` or `last_used_at` write once a scheduled instant had
passed — the key still working while its metadata became unwritable. A check over
intent fields runs on `INSERT` and only on an `UPDATE` that actually changes one
of those fields, so `now()` is always the instant of the write being judged. The
fix is never to soften the check into a live status.

### `P14-AL-36` — A CHILD ROW PROVES ITS PARENT IS IN THE SAME BUSINESS
Added by the same review. RLS constrains which rows of a relation a business
sees; it says nothing about which **parent** a row may name. A global foreign key
from a business-scoped child to a global parent therefore admits a
cross-business link that every policy in this pack still passes — as
`webhook_deliveries.outbox_event_id` did, carrying a projected payload with it.
Where a composite key cannot be referenced because the parent is frozen, the
agreement is asserted explicitly and the gap is routed to the owning phase as a
ruling; it is never left to RLS to imply, and **no new foreign key is added to a
frozen migration**.

### `P14-AL-37` — AN ABSENT PRIVILEGE IS NOT A MECHANISM
Added by the same review. Granting `DELETE` to nobody prevents ad-hoc deletion
and provides no way to shed data at all, so a ledger grows without bound and the
missing capability is discovered in production. Where data must eventually be
shed, this phase states the **operation** — a named authority, an audit row
carrying actor, window and count, a transition the immutability trigger permits
and nothing else — while the **duration** stays an owner's decision this phase
does not make. A purge may never shorten a window another guarantee depends on:
the inbound dedupe window wins over any retention setting.

### `P14-AL-38` — AN ABSENT RECORD IS A REFUSAL, NEVER A RECONSTRUCTION
Added by the Mission's V3 review. Once the stored projection of a delivery is
purged there is nothing to re-send, and both tempting behaviours are wrong:
re-projecting from current state delivers **today's** truth under yesterday's
event id, which is what the immutable payload exists to prevent, and sending an
empty body presents an absence as an event. Replay of a purged delivery is
refused with `DELIVERY_PAYLOAD_PURGED`; the row still attests the original
delivery; **the absence of a payload never becomes a new send or a new
execution.** Choosing the purge window is therefore choosing how long replay
remains possible, which is why the two are one decision (`OD-P14-09`).

### `P14-AL-39` — ONE AUTHORITY PER OPERATION, ACROSS EVERY DOCUMENT THAT NAMES IT
Added by the same review, which found `GET /stock` mapped to `catalog.view` in
the migration request while the contract pack and the OpenAPI skeleton said
`inventory.view` — and the **live route guard settles it at `inventory.view`**
(`inventory-reads.controller.ts:60-61`). That was not a typo: the cashier holds
`catalog.view` and **not** `inventory.view` (`permissions.ts:214`, `:179`), so a
cashier-delegated key would have read stock the cashier cannot read in the app.
**Line numbers and the cashier's permission list corrected (CHALLENGE P2-02):**
the earlier text cited `:144`/`:149`, which are the tail of
`SENSITIVE_PERMISSIONS` and `isSensitivePermission()`, and said the cashier held
`catalog.view` alone. At `93084f8` the cashier holds **five** —
`['catalog.view', 'sales.view', 'sales.create', 'customers.view',
'payments.collect']` (`:214`) — of which four are published v1 scopes and one,
`sales.create`, is a **write**: a cashier-delegated v1 key can commit a sale
through the public API. The escalation finding below is unaffected; what changes
is that the narrowest built-in delegating principal can sell.
The live-authority intersection does not catch this, because the cashier
genuinely holds the scope the mapping named: **a wrong scope→route mapping is
not checked by the intersection; it defines what the intersection is checked
against.** So every published operation's permission is asserted against the
live guard, every document that names it is asserted equal to the others, and
each mapping carries a **negative** test — a key holding only the wrong scope is
refused. The same rule governs any derivation stated in one section and relied
on in another: the two are asserted equal in both directions, never left each
plausible on its own.

### `P14-AL-32` — EVERY BUSINESS-SCOPED RELATION IS IN THE ATTACK MATRIX
Added by MISSION FIX 5. The security tier enumerates relations by **name**, never
by count: this pack's cross-tenant test said “all five business-scoped tables”
when there were six, and the one it omitted — `webhook_inbound_events` — was also
missing from the grants summary and had no RLS paragraph of its own. A count in a
test description is where a missing relation hides. Inbound events are
business-scoped data like any other and carry the full pair of policies; and a
relation deliberately outside the matrix (the two global registries) is listed as
absent **with its reason**, so that absence is a decision and not an oversight.

## §10. Pre-mortem (PART 70)

> *If this phase corrupts money, leaks tenant data, deadlocks, duplicates
> effects or blocks upgrade, what is the most plausible path?*

| # | Most plausible path | Closed by | Must be proved by |
|---|---|---|---|
| 1 | Key stores a permission snapshot; a revoked member's integration keeps selling | `P14-AL-02` | integration test: revoke the membership mid-life, assert every scoped route refuses, with the key unchanged |
| 2 | Scope vocabulary drifts from `PERMISSIONS`; a stale alias grants more than its name suggests | `P14-AL-03` | bijection gate + red proof on each side |
| 3 | A controller forgets `@RequiresPermission`; the public route becomes authenticated-only | `P14-AL-04` | route-enumeration test asserting every public route declares a permission **in** the scope set |
| 4 | Outbox payload forwarded; an internal field (another party's id, an assertion, an amount) reaches a merchant | `P14-AL-13` | exact-key-set fixture per event type + catalogue roster gate |
| 5 | Webhook URL points at `169.254.169.254` or a private address, directly or by DNS rebinding | `P14-AL-15` | pure-predicate fixture over every rejected class **and** a connect-time test that the validated address is the one dialled |
| 6 | Signature verified without the timestamp, so a captured body replays forever | `P14-AL-14` | executed sample-code test, including a stale-timestamp rejection case |
| 7 | At-least-once delivery produces a duplicate effect in the merchant's system | `P14-AL-16` | stable event id across redelivery, asserted; contract text and sample show the dedupe |
| 8 | Rate limit bypassed by minting many keys | `P14-AL-18` | per-business limit test with N keys |
| 9 | Fan-out amplification: one event × many endpoints exhausts the worker | caps per business + bounded concurrency | load evidence on the dedicated performance lane (PART 18), never inside a correctness gate |
| 10 | Cross-business pivot via `X-Business-Id` with a valid key | `P14-AL-06` | attack-matrix case per cross-tenant pair |
| 11 | Secret appears in a log line, an error body, or a read endpoint | `P14-AL-19` | static guard + response-shape test that no field matches a secret pattern |
| 12 | Replay recomputes and sends today's truth under yesterday's event id | `P14-AL-16` | test that a replay after a data change delivers the **stored** projection byte-for-byte |
| 13 | Delivery worker and publisher deadlock on the same rows | lease + `SKIP LOCKED` + one documented lock order | real multi-connection PostgreSQL concurrency test (PART 39), never `sleep()` |
| 14 | An upgrade on a live database fails because a new unique index collides | all tables are new; no backfill except the owner-role permission rows | fresh install **and** real upgrade from the then-current frozen head |

## §11. What this phase explicitly does not do

- No migration, no number, no manifest edit (`P14-AL-21`).
- No change to any frozen migration, ever.
- No payment provider, no WhatsApp provider, no third-party credential.
- No tax behaviour: `OD-03` is closed for Phase 4 as structural zero, and
  nothing here reopens it.
- No second entitlement truth, no second event ledger, no second idempotency
  registry, no second permission vocabulary.
- No `SECURITY DEFINER` function (`P14-AL-22`).
- No promotion. `READY_TO_PROMOTE = NO` until Phase 13 PASS and the gates of
  this phase are measured — and the status of every unmeasured gate here is
  `UNMEASURED`, not PASS (PART 65).

## §12. Definition of done for the phase (PART 38/46)

| Tier | Required before promotion |
|---|---|
| T0 | format, lint, typecheck exit 0 on the assembled tree |
| T1 | unit: scope algebra, key parse/format, projectors, IP predicate, signature |
| T2 | integration on a real cluster: key lifecycle, narrowing, fan-out, delivery, lease recovery, inbound dedupe |
| T2 | security: cross-tenant matrix, permission matrix, direct-SQL scope insertion refused, secret-exposure shapes |
| T2 | concurrency: multi-connection publisher/worker race, lease expiry reclaim, documented lock order |
| T3 | phase candidate integration + the roster/bijection/projection gates with their red proofs |
| T4 | full repository estate |
| T5 | release evidence: exact-SHA CI, fresh install, real upgrade, secret scan |
| — | browser flows for the developer settings surface; `ar`/`en`/`tr` + RTL; three reviews A/B/C (PART 36) |

Performance evidence (rate-limit overhead, fan-out throughput) belongs to the
**dedicated performance lane** and must not be recursively re-run inside a
correctness gate — PART 18, which this project already paid for once.

---

*Prepared by the Phase 14 preparation thread, 2026-10-07, from
`93084f8`. `PREPARED / NOT PROMOTED`.*
