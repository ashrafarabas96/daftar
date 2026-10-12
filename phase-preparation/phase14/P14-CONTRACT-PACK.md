# P14 — PUBLIC API CONTRACT PACK
## The surface other phases and external developers bind against

- **Status: `PREPARED / NOT PROMOTED`.** A proposal, not a published contract.
- Companion to `P14-S0-ARCHITECTURE-LOCK.md`; every law referenced as
  `P14-AL-nn` is defined there.
- Every internal route named below was read in the live tree at `93084f8`. The
  public surface is an **adapter** over those exact services (`P14-AL-09`), so
  nothing here needs a new domain service.

### ملخص عربي

هذا هو **عقد** الواجهة العامة: المسارات، الترويسات، أكواد الرفض، الصفحات،
وقائمة أحداث الـwebhook. القواعد المهمة للمراجعة:

- إدارة المفاتيح والـwebhooks **لا تُتاح لمفتاح API أبدًا** — فقط من داخل
  التطبيق بجلسة مستخدم حقيقية، وإلا صار المفتاح قادرًا على ترقية نفسه.
- كل كتابة عامة تستخدم **مُعرِّفًا يختاره العميل** (هذه قاعدة المشروع القائمة):
  `201` عند الإنشاء، `200` عند التكرار المطابق، ورفض عند التكرار المختلف.
- حمولة كل حدث webhook محدودة بحقول مُسمّاة صراحةً، و«المنع» هو الأصل.

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

## §1. Base, media type, and what is *not* here

| Item | Value |
|---|---|
| Base path | `/public/v1` (`OD-P14-03` may move it to a dedicated host) |
| Content type | `application/json; charset=utf-8` |
| Credential | API key only (`P14-AL-05`); a session access token is refused |
| Error body | the existing `ApiErrorBody` shape — `{ "error": { "code", "message", "requestId", "details"? } }` (`domain-core/src/errors.ts:44`) |
| Locale | `Accept-Language: ar \| en \| tr`; messages localized, **codes never** |

**Key management is not on this surface.** `integrations.view` and
`integrations.manage` are deliberately **absent** from the scope set
(`P14-AL-03`, §4 of the lock): a key that can mint keys or repoint a webhook is
a privilege-escalation ladder, and the escape from any single leaked key must
not itself be reachable with that key. Key and endpoint management lives on the
internal, session-authenticated surface under `/v1/integrations/...`, and a key
presented there is refused like any other key (`P14-AL-05`).

## §2. Request headers

| Header | Required | Meaning |
|---|---|---|
| `Authorization: Bearer dftr_<key_id>_<secret>` | yes | the key; the business is the key's own (`P14-AL-06`) |
| `X-Business-Id` | no | accepted only if it **equals** the key's business; a different value is `KEY_BUSINESS_MISMATCH` |
| `Accept-Language` | no | `ar` (default), `en`, `tr` |
| `X-Request-Id` | no | echoed into the response `requestId` and the audit row if it is a UUID; otherwise one is minted (`infra/request-context.ts:15`) |

## §3. Response headers

| Header | On | Meaning |
|---|---|---|
| `X-RateLimit-Limit` / `-Remaining` / `-Reset` | every response | the **narrowest** bucket that applied, named in `details.bucket` on a `429`. The values are **configuration with no production default** and the surface refuses to start in production without them (Directive 11 PART 97) |
| `Retry-After` | `429`, `503` | seconds; on `503` it is the limiter-outage case (`redis.ts:17-23`) |
| `Sunset` | a deprecated version | RFC 8594 date (`P14-AL-23`) |

## §4. Refusal codes (additions to `ApiErrorCode`)

All SCREAMING_SNAKE, the existing style at the HTTP boundary
(`domain-core/src/errors.ts:6-31`). Dotted codes stay where they belong —
inside the domain authorities.

| Code | HTTP | When |
|---|---|---|
| `API_KEY_INVALID` | 401 | no key, malformed key, unknown id, or digest mismatch — **one** code for all four, so the error cannot be used as an oracle |
| `API_KEY_REVOKED` | 401 | the key row is revoked |
| `API_KEY_EXPIRED` | 401 | `expires_at` has passed |
| `SCOPE_INSUFFICIENT` | 403 | the route's permission is outside the key's scopes; `details.required` names the permission |
| `MEMBERSHIP_INSUFFICIENT` | 403 | the key's scopes allow it but the **live** membership no longer does (`P14-AL-02`) — a separate code because the merchant's fix is different |
| `KEY_BUSINESS_MISMATCH` | 403 | `X-Business-Id` names another business |
| `INTEGRATIONS_NOT_ENABLED` | 403 | the business's plan does not carry the capability (`P14-AL-24`) |
| `SENSITIVE_SCOPE_REFUSED` | 422 | key creation asked for a sensitive permission (`P14-AL-07`) |
| `UNSUPPORTED_API_VERSION` | 404 | a version that was never published or is past its sunset |
| `WEBHOOK_URL_REJECTED` | 422 | not https, not port 443, or resolves outside the globally-routable set (`P14-AL-15`); `details.reason` names the class, never the resolved address |
| `WEBHOOK_ENDPOINT_DISABLED` | 409 | an action on an endpoint auto-disabled after sustained failure |
| `RATE_LIMITED` | 429 | reuses the existing code |
| `IDEMPOTENCY_CONFLICT` | 409 | reuses the existing code: same resource id, different payload digest |
| `DELIVERY_PAYLOAD_PURGED` | 409 | a replay was requested for a delivery whose payload has been purged. The delivery still attests that it happened; the stored projection no longer exists, and it is **never** re-projected from current state nor sent empty (`P14-AL-38`, Mission V3) |

`API_KEY_INVALID` covering four distinct causes is deliberate. Distinguishing
“unknown key id” from “wrong secret” tells an attacker which half of a guess
was right.

## §5. Read endpoints (initial surface)

Each is a thin adapter over the named live internal route. The surface is
independent of the internal one in five ways — guard, DTOs, rate limits, audit
shaping, error shaping — it accepts **no cookie**, and **no decision of it
depends on the hostname** (`P14-AL-26`).

**`P14-AL-25` applies to every row** (`P14-AMENDMENT-01-SEALED-CONTRACTS.md`): a
route is published only when the slice owning its contract is sealed. `WAITING_FOR_INTEGRATED_SURFACE`
rows are specified here and are **absent from the OpenAPI document**.

| Public | Permission / scope | Adapts | Owning slice | v1 |
|---|---|---|---|---|
| `GET /public/v1/products` | `catalog.view` | catalog `GET products` | Phase 3 | **published** |
| `GET /public/v1/products/{productId}` | `catalog.view` | catalog `GET products/:id` | Phase 3 | **published** |
| `GET /public/v1/stock` | `inventory.view` | inventory reads `GET stock` | Phase 3 | **published** |
| `GET /public/v1/customers` | `customers.view` | customers `GET` | P4-S1 | **published** |
| `GET /public/v1/customers/{customerId}` | `customers.view` | customers `GET :customerId` | P4-S1 | **published** |
| `GET /public/v1/invoices` | `sales.view` | sales `GET invoices` | P4-S1 | **published** (lifecycle `status` only) |
| `GET /public/v1/invoices/{invoiceId}` | `sales.view` | sales `GET invoices/:invoiceId` | P4-S1 | **published** (lifecycle `status` only) |
| `GET /public/v1/customers/{customerId}/receivable` | `receivables.view` | customers `GET :customerId/receivable` | **P4-S4** | `WAITING_FOR_INTEGRATED_SURFACE` |
| `GET /public/v1/customers/{customerId}/receivable/aging` | `receivables.view` | customers `GET :customerId/receivable/aging` | **P4-S4 + P4-S7** | `WAITING_FOR_INTEGRATED_SURFACE` |
| `GET /public/v1/customers/{customerId}/open-invoices` | `receivables.view` | customers `GET :customerId/open-invoices` | **P4-S4** | `WAITING_FOR_INTEGRATED_SURFACE` |
| `GET /public/v1/invoices/{invoiceId}/settlement` | `receivables.view` | sales `GET invoices/:invoiceId/settlement` | **P4-S4** | `WAITING_FOR_INTEGRATED_SURFACE` |

## §6. Write endpoints (initial surface)

Every write takes a **client-chosen id** as its idempotency key
(`P14-AL-11`): `201` on create, `200` on an identical replay,
`IDEMPOTENCY_CONFLICT` when the same id arrives with a different payload
digest. No `Idempotency-Key` header exists (`OD-P14-01`).

| Public | Permission / scope | Adapts | Client-chosen id | Owning slice | v1 |
|---|---|---|---|---|---|
| `POST /public/v1/customers` | `customers.manage` | customers create | `customerId` | P4-S1 | **published** |
| `POST /public/v1/sales` | `sales.create` | selling `POST` (the atomic sale commit) | `saleId` | P4-S2 | **published** |
| `POST /public/v1/customer-payments` | `payments.collect` | receivables `POST customer-payments` | `paymentId` | **P4-S4** | `WAITING_FOR_INTEGRATED_SURFACE` |

So the first public version is **seven reads and two writes**. That is smaller
than this pack first proposed, and it is the part of the product that is
actually finished (`P14-AL-25`).

Not on the initial surface, and each for a stated reason, not an oversight:
voids, returns, refunds, payment reversals, discounts and installment changes
are all `SENSITIVE_PERMISSIONS` and therefore outside any key
(`P14-AL-07`); stock movements are sensitive for the same reason; anything
touching roles, members or accounting configuration is never delegable to an
unattended credential.

## §7. Money and amounts in the public contract

- Every amount is an **integer in minor units** with an explicit currency, the
  repository's existing representation (`packages/domain-core/src/money.ts`,
  PART 12). No decimal string, no float, in either direction.
- The server recomputes every total. A client-supplied total is **ignored**, not
  trusted and not echoed as authoritative (PART 12: “Client financial totals:
  never authoritative”).
- Sales tax is a **structural zero** for this phase (`OD-03`, PART 14). A
  non-zero tax field is refused, never normalized to zero silently.

## §8. Pagination, filtering and ordering

- Cursor pagination only: `?limit=` (1..100, default 50) and `?cursor=`, with
  `{ "data": [...], "nextCursor": "..." | null }`.
- The cursor is an **opaque** server-signed string over `(sort key, tiebreaker
  id)`. Offset pagination is not offered: it skips and duplicates rows under
  concurrent writes, which for an invoice list is a reconciliation defect.
- Every list has a **total order** (a timestamp plus the id as tiebreaker), or
  the cursor cannot be stable.
- A cursor is valid only for the key's business; one presented against another
  business is `VALIDATION_FAILED`, never a cross-business read.

## §9. Webhook event catalogue (initial)

Each public type has a **projector** and an exact key set (`P14-AL-13`). The
`type` column of `outbox_events` is the only source (`P14-AL-12`); any emitted
type absent from both this catalogue and the internal-only roster turns the
catalogue gate red.

| Public event type | Fired when | Projected fields (exact) | Owning slice | v1 |
|---|---|---|---|---|
| `sale.committed` | a sale commits | `saleId`, `invoiceId`, `invoiceNumber`, `customerId?`, `branchId`, `totalMinor`, `currency`, `committedAt` | P4-S2 | **published** — the total comes from the committed sale document, never from a settlement computation |
| `invoice.settlement_changed` | settlement state changes | `invoiceId`, `settlementState`, `paidMinor`, `outstandingMinor`, `currency`, `changedAt` | **P4-S4** | `WAITING_FOR_INTEGRATED_SURFACE` |
| `customer.payment_recorded` | a customer payment commits | `paymentId`, `customerId`, `amountMinor`, `currency`, `method`, `recordedAt` | **P4-S4** | `WAITING_FOR_INTEGRATED_SURFACE` |
| `customer.created` / `customer.updated` | customer record changes | `customerId`, `name`, `phone?`, `updatedAt` | P4-S1 | **published** |
| `product.created` / `product.updated` / `product.archived` | catalog change | `productId`, `sku?`, `name`, `status`, `updatedAt` | Phase 3 | **published** |
| `stock.level_changed` | a stock level moves | `productId`, `warehouseId`, `quantity`, `unit`, `changedAt` | Phase 3 | **published** |
| `api_key.revoked` | a key is revoked | `keyId`, `revokedAt`, `reason` | P14 | **published** |
| `webhook.endpoint_disabled` | sustained failure disabled an endpoint | `endpointId`, `disabledAt`, `consecutiveFailures` | P14 | **published** |

Deliberately **not** published in Phase 14: anything carrying a journal entry,
an FX rate, a carrying value, an assertion, a cost, or another party's
identity. A merchant's integration has no business reading the ledger through a
webhook, and a cost figure in an outbound payload is a competitive leak as well
as an accounting one.

## §10. Webhook request contract

```
POST <endpoint url>
Content-Type: application/json
User-Agent: Daftar-Webhooks/1
X-Daftar-Event-Id: <delivery uuid>          # stable across every redelivery
X-Daftar-Event-Type: sale.committed
X-Daftar-Event-Version: 1                   # the EVENT's version (D11 PART 98)
X-Daftar-Business-Id: <business uuid>
X-Daftar-Signature: t=1760000000,v1=<hex hmac-sha256>   # v1 = the SIGNING SCHEME's version

{ "id": "...", "type": "sale.committed", "version": "1", "businessId": "...",
  "occurredAt": "2026-10-07T22:00:00.000Z", "data": { ... } }
```

Receiver contract, in the order the published sample performs it:

1. read the raw body **before** any JSON parsing or framework transformation;
2. reject if `|now − t|` exceeds the **published freshness tolerance** — a
   configured value, deliberately not a number in this pack, with no production
   default and a startup refusal when unset (`OD-P14-10`, MISSION FIX 6; the
   `300` that stood here was never approved);
3. recompute `HMAC-SHA256(secret, t + "." + raw_body)` and compare in constant
   time;
4. de-duplicate on `X-Daftar-Event-Id`;
5. respond `2xx` **fast**; a long handler is a timeout, and a timeout is a
   retry. Do the work asynchronously.

Any `2xx` is success. A `3xx` is a failure (redirects are never followed,
`P14-AL-15`). Timeout, connection failure and `4xx`/`5xx` are failures that
retry with the accepted outbox backoff and end in a dead-letter state
(`P14-AL-16`), never in silence.

## §11. Management surface (internal, session-authenticated)

`/v1/integrations/...`, permission `integrations.view` / `integrations.manage`,
reached from the merchant web app only.

| Route | Permission | Note |
|---|---|---|
| `GET api-keys` | `integrations.view` | never returns a secret or a digest |
| `POST api-keys` | `integrations.manage` | the **only** response that ever contains the secret (`P14-AL-08`) |
| `POST api-keys/{id}/revoke` | `integrations.manage` | effective immediately; emits `api_key.revoked` |
| `GET webhook-endpoints` | `integrations.view` | never returns the signing secret |
| `POST webhook-endpoints` | `integrations.manage` | validates the URL at creation **and** again at every dispatch |
| `POST webhook-endpoints/{id}/secret` | `integrations.manage` | regenerates; shown once |
| `POST webhook-endpoints/{id}/disable` / `enable` | `integrations.manage` | re-enabling resets the failure counter |
| `GET webhook-deliveries` | `integrations.view` | status, attempts, last status code, error class — never the response body |
| `POST webhook-deliveries/{id}/replay` | `integrations.manage` | re-sends the **stored** projection (`P14-AL-16`) |

There is no “rotate” route: rotation is create-then-revoke, because a route
that replaced a live secret in place would make a leak un-auditable
(`P14-AL-08`).

## §12. Deprecation and change discipline

- Published fields are never removed, renamed or narrowed inside a version.
- A new optional request field must have a documented default that preserves
  the previous behaviour exactly.
- Any change to this pack after publication requires a changelog entry with a
  date; the OpenAPI document is **generated**, so a drift between this pack and
  the schema is a gate failure, not a documentation habit (`P14-AL-20`).

---

*`PREPARED / NOT PROMOTED`. Prepared 2026-10-07 from `93084f8`.*
