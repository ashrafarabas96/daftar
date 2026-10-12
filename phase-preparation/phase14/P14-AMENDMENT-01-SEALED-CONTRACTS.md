# P14 — AMENDMENT 01
## §77 of the Final Audited Master Directive: *“Public API follows sealed contracts.”*

- Received 2026-10-08. **Adopted. The pack is not restarted** — the laws,
  the patch request, the DAG and the open decisions all stand. This amendment
  adds one law and **narrows the first public version**.
- Discovery first, as §77 orders: an existing Phase 14 thread was found — this
  one — and its work is confirmed, not redone.
- Evidence classes: **PROVEN IN LIVE CODE** for every seal fact below (manifest
  and migration filenames read in the tree); **DESIGN ONLY** for the surface
  decision. No timing claim.
- **Vocabulary aligned 2026-10-12:** what this amendment called `DEFERRED` is
  now written `WAITING_FOR_INTEGRATED_SURFACE`, the evidence class Directive 11
  PART 15 lists and PART 99 names for exactly this case. Same meaning, the
  programme's word.

### ملخص عربي

التوجيه الجديد يقول: **«الواجهة العامة تتبع العقود المختومة»** ولا تُجمَّد فيها
مخططات غير مستقرة. هذه مخالفة حقيقية في حزمتي، وقد صحّحتها: كانت الحزمة تنشر
**خمسة مسارات وحدثين** تعتمد على شرائح **غير مختومة** (S4 للدفعات والتسوية
والأعمار، وS7 لتفصيل الأعمار). هذه المسارات **أُزيلت من الإصدار العام الأول**
وبقيت موصوفة كإضافة مؤجّلة تُنشر بعد الختم. ما بقي في الإصدار الأول يعتمد فقط
على ما هو مجمّد فعلًا حتى `0079`. ولم يُلغَ شيء من العمل السابق.

---

## §1. The new law

### `P14-AL-25` — NO PUBLIC ROUTE OVER AN UNSEALED CONTRACT
A public endpoint, response field or webhook event may be **published** only
when every contract it reads is sealed. Concretely:

- each public route and each event carries, in the contract pack, the **slice
  that owns its contract** and that slice's seal state;
- a route whose owning slice is unsealed is `WAITING_FOR_INTEGRATED_SURFACE`, specified but not
  published, and the OpenAPI document does not contain it;
- the enforcement is not a comment: the publishable set is a **declared
  roster**, and a gate refuses to generate the OpenAPI document for any path
  whose owning slice is not recorded as sealed. A path cannot reach the public
  document by being written.

Reason, in the directive's own terms: a public contract is a promise that
outlives the phase that made it (`P14-AL-23` forbids removing a published
field). Publishing over an unsealed slice would convert a Phase 4 design still
under challenge into a frozen external promise — and would do it silently,
which is the worst version of it.

## §2. Seal facts (measured, not assumed)

From `infrastructure/database/MIGRATION_MANIFEST.json` and the migration
filenames in the tree at `93084f8`:

| Slice | Owns | Migrations | State |
|---|---|---|---|
| Phase 3 | catalog, inventory, stock reads | `0053`–`0073` | **SEALED** (merged to `main`) |
| P4-S1 | customers, sales documents, invoice numbering | `0074`–`0076` | **SEALED / FROZEN** |
| P4-S2 | the atomic sale commit, sale items, stock sources | `0077`–`0078` | **SEALED / FROZEN** |
| P4-S3 | POS till sessions, server cart | `0079` | **SEALED / FROZEN** |
| P4-S4 | customer payments, allocations, credits, AR outstanding, aging | unfrozen candidates | **NOT SEALED** |
| P4-S5 | returns, credit notes, refunds | none allocated | **NOT SEALED** |
| P4-S6 | payment/allocation reversals, invoice voids | none allocated | **NOT SEALED** |
| P4-S7 | installment schedules, aging granularity | none allocated | **NOT SEALED** |

`frozenThrough = 0079_phase4_pos_till_sessions_cart.sql`. Everything after it
is a candidate, and this amendment treats a candidate as unsealed regardless of
how far its local work has progressed.

## §3. What leaves the first public version

Five routes and two events, each named with the slice that made it ineligible:

| Removed from v1 | Owning slice | Why it cannot be published yet |
|---|---|---|
| `GET /public/v1/invoices/{invoiceId}/settlement` | P4-S4 | `paidTxnMinor` / `outstandingTxnMinor` / `settlementState` are **derived per request** through `invoice_outstanding(...)` and `invoice_settlement_state(...)` (`packages/shared-contracts/src/invoices.ts:37-41,191-212`), functions defined in the unfrozen candidates |
| `GET /public/v1/customers/{customerId}/receivable` | P4-S4 | AR outstanding is the same unsealed authority |
| `GET /public/v1/customers/{customerId}/receivable/aging` | P4-S4 + P4-S7 | the aging read is the slice with an **open Critical** in this project's own record; publishing its shape externally now would be the clearest possible violation of §77 |
| `GET /public/v1/customers/{customerId}/open-invoices` | P4-S4 | same authority |
| `POST /public/v1/customer-payments` | P4-S4 | the payment command itself |
| event `invoice.settlement_changed` | P4-S4 | settlement shape |
| event `customer.payment_recorded` | P4-S4 | payment shape |

They stay fully specified in `P14-CONTRACT-PACK.md` as `WAITING_FOR_INTEGRATED_SURFACE`, so nothing
designed is lost; each is published in a **later** public version once its
slice seals, which `P14-AL-23` permits (adding a path is additive).

## §4. What the first public version keeps

Every item below reads a contract frozen at or before `0079`:

| Kept | Owning slice |
|---|---|
| `GET /products`, `GET /products/{id}`, `GET /stock` | Phase 3 (sealed) |
| `GET /customers`, `GET /customers/{id}`, `POST /customers` | P4-S1 (sealed) |
| `GET /invoices`, `GET /invoices/{id}` | P4-S1 (sealed) — **lifecycle status only**; the DTO's `status` is `draft \| open \| void` and never a settlement value (`invoices.ts:160`), which is exactly why this route survives while `/settlement` does not |
| `POST /sales` | P4-S2 (sealed) |
| events `customer.created`, `customer.updated` | P4-S1 |
| events `product.*`, `stock.level_changed` | Phase 3 |
| event `sale.committed` | P4-S2 — projected without any settlement field |
| events `api_key.revoked`, `webhook.endpoint_disabled` | Phase 14's own |

A consequence worth stating plainly: **the first public version is read-mostly
plus two writes.** That is smaller than the pack originally proposed, and it is
the correct size — it is exactly the part of the product that is finished.

## §5. One more consequence: the `sale.committed` projection

The original projection listed `totalMinor`. A sale's total is sealed under
P4-S2, so the field stays — but the projector must take it from the committed
sale document, **never** from a settlement or outstanding computation. The
projection gate's exact-key-set fixture (`P14-AL-13`) now also serves as the
§77 guard for this event: a settlement field cannot be added to it without
turning that fixture red.

## §6. Ownership alignment with §80

§80 of the directive names one writer per shared file. My DAG's table is
aligned, with one honest gap:

| My DAG's entry | §80's owner | Status |
|---|---|---|
| `permissions.ts` → Authority Owner | permissions → Authority Owner | ✅ matches |
| migrations + manifest → Migration Owner | same | ✅ matches |
| RLS policies in the patch request | RLS → Security Owner | ✅ the patch request goes to both the Migration Owner and the Security Owner |
| `docs/` prep documents | canonical status/docs → Coordinator | ✅ this pack lives in the project folder, not in `docs/`, precisely so it edits nothing the Coordinator owns |
| `apps/api/src/infra/redis.ts` (rate limiter) | **not named in §80** | ⚠️ **owner needed.** Until one is named, `PATCH-REQ-P14-RL-01` is addressed to the Phase 4 coordinator as holder, and Phase 14 does not edit the file |
| `apps/api/src/modules/outbox/publisher.ts` | **not named in §80** | ⚠️ same; `PATCH-REQ-P14-OUTBOX-01` is addressed the same way |

Phase 14 edits neither file under any circumstance (§78's rule: no future phase
bypasses file ownership because its work is infrastructure).

## §7. What this amendment does not change

- `PREPARED / NOT PROMOTED`; `READY_TO_PROMOTE = NO`.
- No migration number, no filename, no example (§4 of the directive).
- Promotion order unchanged: Phase 14 promotes after Phase 13 (§10).
- All 24 existing laws stand; this adds `P14-AL-25` and narrows the surface
  tables. Nothing earlier is withdrawn.
- No work was restarted, no document rewritten from scratch, and nothing of
  the previous pack was discarded (§0).

---

*`PREPARED / NOT PROMOTED`. Amendment 01, 2026-10-08, from `93084f8`.*
