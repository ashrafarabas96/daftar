# P14 — AMENDMENT 02
## Directive 11 (2026-10-12), PARTs 90–100 + 118 and the common rules

- Received 2026-10-12. **Adopted. Nothing restarted.** Four rulings confirm
  decisions this pack had already recommended; **five are real corrections**
  that change the design; one changes a status word; the eight open decisions
  are now reconciled and **none of them is still waiting on Ashraf**.
- Verified against the PDF itself, not only the per-phase extraction: the
  extraction at `/mnt/project-files/directives/DIRECTIVE-11-PER-PHASE.md` is
  faithful for PARTs 90–100 and 118, and the wording below is taken from the
  PDF text.
- Live rediscovery first (PART 2): `origin/main` = `6fc505d`; Phase 4 branch
  remote head = `93084f8`; this thread's tree is clean and carries no commit.
  Nothing was mutated during discovery.
- Evidence classes (PART 15): **PROVEN IN LIVE CODE** where a `file:line`
  appears; **DESIGN ONLY** for everything Phase 14 proposes; **UNMEASURED** for
  every gate; **WAITING_FOR_INTEGRATED_SURFACE** for the seven items Amendment
  01 withheld. No timing claim anywhere.

### ملخص عربي

التوجيه الجديد **حسم أربعة** من قراراتي الثمانية، وكلها جاءت **مطابقة لتوصيتي**:
لا ترويسة `Idempotency-Key`، ولا صلاحيات حسّاسة على المفاتيح، ونفس المضيف مع
بادئة `/public/v1/` وحاجز مستقل، والمفتاح **تفويض من عضوية** لا هوية آلية.

ومعه **خمس تصحيحات حقيقية** طبّقتها:

1. **«لا نافذة سماح مخفية» عند تدوير المفتاح** — كان تصميمي يقول «إلغاء بعد مدة
   سماح»، وهذه مدة ضمنية ممنوعة. صارت: مفتاح بديل يُنشأ، والتعايش بينهما
   **صريح ومُدقَّق ومُسجَّل في عمود**، والإلغاء فوري أو بوقت مُحدَّد مُخزَّن، ويسري
   **لحظة التحقّق** لا بعد انتهاء أي تخزين مؤقّت.
2. **تحصين SSRF أوسع مما كتبت**: أضفت رفض **بيانات الدخول داخل الرابط**،
   وعناوين IPv6 التي تُخفي عنوانًا خاصًا، وصيغ العناوين الرقمية غير القياسية
   (ثماني/عشري/ست عشري)، والمنافذ غير المسموحة، ومفاجآت الوكيل في البيئة،
   و**إعادة التحقّق من DNS في كل محاولة تسليم**، لا مرة واحدة.
3. **حدود الطلبات ليست قرارًا أخترعه**: إنها **إعداد**، و«لا تُخمَّن حصص
   الإنتاج». فحُذفت أرقامي كتوصيات، وصار المطلوب أن **ترفض الخدمة العامة
   الإقلاع في الإنتاج** بلا حدود مُعدَّة فعلًا.
4. **نسخة الحدث** مطلوبة صراحةً في مغلّف الـwebhook، فأضفتها.
5. **مصطلح الحالة**: المسارات المؤجَّلة تحمل الآن
   `WAITING_FOR_INTEGRATED_SURFACE` بدل `DEFERRED`.

**ولا يوجد الآن أي قرار معلّق عليك.** الأربعة الباقية: قرارَان تقنيان حسمتهما
بنفسي كما أمر التوجيه، وواحد نصفه تقني (حسمته) ونصفه تسعير يملكه الطور الخامس،
وواحد ألغاه التوجيه لأنه إعداد لا قرار.

---

## §1. The four rulings — all confirming what the pack recommended

| Ruling | What it settles | My open decision | Outcome |
|---|---|---|---|
| **TL-P14-R1** (PART 91) | v1 has **no generic `Idempotency-Key` header authority**; reuse domain-native caller-chosen ids plus a stored intent fingerprint. A future endpoint with no natural identity must define its own real contract **before** publication. *“Do not add a generic header that can silently become weaker than domain semantics.”* | `OD-P14-01`, recommended (أ) | **RULED as recommended.** `P14-AL-11` stands. The `api_idempotency_operations` table stays specified-and-not-created, and §9 of the patch request is now marked **not to be created in v1** rather than awaiting a choice. |
| **TL-P14-R2** (PART 92) | A public API key v1 **cannot hold sensitive permissions**; strict deny; *“do not let UI checkbox or custom scope override this”*; future machine-to-machine sensitive authority needs a service-principal architecture review, **not a boolean**. | `OD-P14-02`, recommended (أ) | **RULED as recommended.** `P14-AL-07` stands, and the enforcement is stronger than a UI rule: a scope is a row with a foreign key into a closed registry (`api_key_scopes.scope → api_scopes.scope`), so a “custom scope” has nowhere to exist and a checkbox has nothing to write. |
| **TL-P14-R3** (PART 93) | Same host with `/public/v1/` is accepted initially, but the surface must have **independent auth guard, DTOs, rate limits, audit and error shaping**, with **no cookie/session auth crossover**; internal auth must not accidentally satisfy the public guard; a dedicated host may come later; **no security dependence on hostname**. | `OD-P14-03`, recommended (أ) | **RULED as recommended, with two additions** now carried as `P14-AL-26`. |
| **TL-P14-R4** (PART 94) | v1 keys are **membership-delegated**; effective authority = **live member authority ∩ key scopes**; disabled / removed / permission loss makes the key inert; **no stale copied permission authority**; key management requires explicit integrations-management authority; **UI and docs must state** the key is delegated from a member; **no service-principal identity in v1**. | `OD-P14-04`, recommended (أ) | **RULED as recommended.** `P14-AL-02` stands verbatim. The operational surprise I flagged is now a **documentation obligation**, not a choice — carried as `P14-AL-27`. |

## §2. The five corrections

### `P14-AL-08` AMENDED — no hidden grace window (PART 95)
The pack said rotation is *“create a new key, then revoke the old one with a
grace window.”* **“Grace window” was an implicit, hard-coded overlap, which
PART 95 forbids.** Corrected:

- the secret stays cryptographically random, write-once at display, stored as a
  digest only — unchanged;
- rotation is: **mint a replacement key**; overlap exists **only if explicitly
  requested**, and it is **audited and recorded in data**, not implied by a
  convention — the replacement row names its predecessor
  (`replaces_api_key_id`), so an overlap is a readable fact;
- revocation of the predecessor is **explicit now** or **scheduled at a
  configured timestamp** stored on the row. There is no default, no hidden
  default, and no indefinite overlap;
- **revocation takes effect at the auth check.** Therefore the resolver reads
  the key row on **every** request and the public surface holds **no
  authorization cache**: a cached validity decision would be exactly the
  “effective a few minutes later” behaviour PART 95 refuses. This is why the
  unique index on `key_id` matters — the cost of the rule is one indexed read,
  and the rule is worth it.
- `revoked_at` in the **future** is a scheduled revoke; the derived state is
  `revoked` only when `revoked_at <= now()`, and the management surface shows
  “revokes at” rather than “revoked”.

### `P14-AL-15` AMENDED — the SSRF list was incomplete (PART 96)
My law had https-only, port 443, resolve-then-dial-the-validated-address, no
redirects, bounded timeout and response size, and no body logging. PART 96 adds
six things I did not have, and every one of them is a real hole:

| Added rejection / requirement | Why my version leaked without it |
|---|---|
| **credentials/userinfo in the URL** | `https://victim@internal.host/` parses, and a naive host extraction can read the wrong side of the `@`. My column `CHECK` (`^https://[^[:space:]]{1,2000}$`) accepted it; it now also requires `url !~ '^https://[^/?#]*@'` |
| **IPv4-mapped private IPv6** (`::ffff:10.0.0.1`) | a private address wearing an IPv6 shape passes an IPv4-only private-range test |
| **noncanonical numeric IP forms** and **policy-prohibited literal forms** | `0177.0.0.1`, `2130706433`, `0x7f.1` all reach loopback while failing a dotted-quad check |
| **disallowed ports** | stated as 443-only before; now an explicit allowed-port policy, so a later relaxation is a policy change rather than a regex edit |
| **disable/bypass environment proxy surprises** | an `HTTPS_PROXY` in the worker's environment would send the request somewhere the validation never examined, making the whole pin meaningless |
| **revalidate DNS on each later delivery attempt** | my law resolved once per delivery. A retry hours later must re-resolve and re-validate; a record that was public at attempt 1 can be private at attempt 4 |

Also explicit: resolve **all** A and AAAA answers and validate **every** one
(not the first), preserve correct TLS SNI/Host for the approved hostname, and
add **DNS-rebinding / TOCTOU tests**. The directive's own sentence is the
acceptance criterion: *“No ‘validate hostname once then let a generic HTTP
client re-resolve anywhere’.”*

### `P14-AL-18` AMENDED — thresholds are configuration, not my invention (PART 97)
*“Rate-limit thresholds are configuration. Do not guess production quotas.”*
My `OD-P14-07` proposed numbers. **They are withdrawn as recommendations.**
What stands is the **shape**, which the directive confirms: per API key, per
business, per endpoint/risk class, and **no one global counter that lets one
business exhaust another's allowance**. Added:

- every threshold is a configuration value with **no production default**;
- the public surface **refuses to start in production** when they are not
  configured — *“Production public API cannot launch without real configured
  limits”* becomes a startup assertion, the same discipline the credential key
  ring already uses (`credential-protector.ts:21-25`: production requires the
  key, config validation fails startup without it);
- fail-closed on a limiter-backend outage for sensitive and write surfaces,
  which the live limiter already implements (`redis.ts:17-23`).

### `P14-AL-14` AMENDED — the event carries a version (PART 98)
PART 98 lists **version** as an attribute of the outbound event. Added to the
envelope as `"version": "1"` and as the `X-Daftar-Event-Version` header. The
`v1=` tag inside `X-Daftar-Signature` remains the **signature scheme** version;
these are two different things and conflating them is how a signing-scheme
change silently becomes an event-shape change. Everything else in PART 98 was
already in the pack: stable event id, timestamp, signed payload, replay
guidance, encrypted and rotatable secret, no raw secret in logs, retry under a
stable delivery identity, and receiver docs covering verification and replay.

### `P14-AL-25` AMENDED — the status word is the directive's (PART 99)
Deferred routes, fields and events now carry
**`WAITING_FOR_INTEGRATED_SURFACE`**, which PART 15 lists as an evidence class
and PART 99 names for exactly this case, replacing the pack's own `DEFERRED`.
The rest of Amendment 01 is confirmed by PART 99 word for word, including
*“skeleton is design only.”*

## §3. Three new laws

### `P14-AL-26` — THE PUBLIC SURFACE IS INDEPENDENT IN FIVE WAYS, AND NEVER IN THE HOSTNAME
Independent auth guard, DTOs, rate limits, **audit shaping** and **error
shaping** (PART 93). Two consequences the pack had not stated:

- the public guard **never reads a cookie**, and no session credential can
  satisfy it — the route-enumeration test of `P14-AL-05` now asserts the
  negative for cookies as well as for bearer session tokens;
- **no security decision depends on the hostname.** A guard that trusted
  `Host` would grant public authority to anything that can set a header, and
  would silently change meaning the day a dedicated host arrives. The host is
  deployment, never authorization.

### `P14-AL-27` — DELEGATION IS DISCLOSED, NOT INFERRED
Because a key is delegated (PART 94), the member it depends on must be visible
wherever the key is: the creation screen names that member, the key list shows
it, the developer documentation states that a key's authority follows its
member's, and revoking a membership shows which live keys go inert. This closes
the operational surprise Amendment 00 raised as a risk — by disclosure, which
the directive requires, rather than by a choice.

### `P14-AL-28` — NO PROOF OF THIS PHASE TOUCHES FROZEN HISTORY
`0000`–`0079` are byte-immutable **including for mutation testing** (PART 6),
and `0080`–`0086` are candidates nobody here edits. Every red proof in this
phase mutates a Phase 14 file — a gate script, a projector, a guard — and never
a migration. PART 6's sentence is adopted as the test: *a proof that needs
frozen history modified is wrongly designed*, so such a proof is rewritten, not
granted an exception.

## §4. The eight open decisions, reconciled (PART 100)

PART 100 says the artifact was missing from the bundle, orders recovery, and
forbids guessing. **Recovered, not guessed:** `P14-OPEN-DECISIONS-AR.md` exists
at `/mnt/project-files/phase14/`, SHA256
`af6fe4c65a2f9794d5c87e6c4c672b5e77984d6e341f2983dea9187fbb3ab5a7`, written
2026-10-07 by this thread. All eight items are below with their real text, and
each is classified as PART 100 requires.

| # | Subject | Class | Resolution |
|---|---|---|---|
| `OD-P14-01` | generic `Idempotency-Key` header | technical | **RULED** by TL-P14-R1, as recommended: no header in v1 |
| `OD-P14-02` | sensitive permissions on a key | technical | **RULED** by TL-P14-R2, as recommended: strict deny |
| `OD-P14-03` | where the public surface lives | technical | **RULED** by TL-P14-R3, as recommended: same host, independent everything |
| `OD-P14-04` | key identity: delegation vs machine identity | technical | **RULED** by TL-P14-R4, as recommended: membership-delegated, no service principal in v1 |
| `OD-P14-05` | wildcard `*` webhook subscription | technical | **RESOLVED autonomously: no wildcard.** Per-event-type subscription only. A wildcard would start sending a merchant every event a future phase adds, with nobody deciding it — the opposite of deny-by-default, and `P14-AL-13`'s catalogue gate would be bypassed by it. The FK to the closed `webhook_event_types` registry already makes an unregistered type impossible |
| `OD-P14-06` | plan / entitlement binding | **split** | *Technical half resolved autonomously:* availability is a capability key in the existing Phase 1 registry (`capabilities.ts:26-34`), checked through the existing entitlements module; Phase 14 adds the key and the check and reads no plan name. *Business half NOT mine and NOT Ashraf's today:* which plans carry it and what it costs belongs to **Phase 5**, whose own directive owns SaaS billing. Recorded as a Phase 5 input, not an escalation |
| `OD-P14-07` | the numeric limits | **superseded** | PART 97 removes this from the decision space: thresholds are **configuration**, and guessing production quotas is forbidden. My proposed numbers are withdrawn. What replaces them: the bucket shape (key / business / endpoint class), configuration keys with no production default, and a startup assertion that refuses to launch the production public surface without configured limits. The **values** are an operations input before launch, not an architecture decision |
| `OD-P14-08` | who may read a webhook signing secret after creation | technical | **RESOLVED autonomously: nobody.** Shown once, stored encrypted with a domain-separated key ring, readable only by the delivery worker's role; a lost secret is **regenerated**. PART 98's *“no raw secrets in logs”* and PART 95's write-once discipline both point the same way, and a later-readable secret would make a compromise of the owner's account hand over the signing authority with no trace |

**Net result: no architectural decision is waiting on Ashraf.** What remains for
a human, and only before production launch rather than before review, is the
configured limit values (operations) and the Phase 5 pricing of the capability.

## §5. Artifact recovery (PARTs 90, 13, 14)

PART 90 lists three artifacts as missing from the reviewed bundle. All three
**exist** and were written on 2026-10-07; none is recreated, which PART 13
forbids before searching:

| Artifact PART 90 called missing | Location | SHA256 |
|---|---|---|
| migration patch request | `/mnt/project-files/phase14/P14-MIGRATION-PATCH-REQUEST.md` | `c971ce33d5f634981505800bdff462de93395f5bbf84f992c88156df84ec1d48` |
| open-decisions document | `/mnt/project-files/phase14/P14-OPEN-DECISIONS-AR.md` | `af6fe4c65a2f9794d5c87e6c4c672b5e77984d6e341f2983dea9187fbb3ab5a7` |
| OpenAPI skeleton | `/mnt/project-files/phase14/P14-OPENAPI-SKELETON.yaml` | `0e2476dbb7685a608a130c6059227db153fbc7391942bee43ddc0db219b27f5f` |

**On the “three byte-identical amendment copies” (PARTs 90, 14):** the project
folder holds **exactly one** amendment file,
`P14-AMENDMENT-01-SEALED-CONTRACTS.md`, SHA256
`315ebb8af5ef3981fff9e7d457b96ddb352c20c23adf4cdbc5febbd2bef8cf1f` — verified
by a search of `/mnt/project-files/`. This thread cannot see the zip bundle the
review was performed on, so I cannot confirm or deny that three copies existed
there; what I can state is the canonical location and hash above, which the
handoff manifest records. If the bundle is rebuilt from this folder the
duplication cannot recur, because there is one file to copy.

PART 13's manifest is now a deliverable of this phase:
`P14-HANDOFF-MANIFEST.md`.

## §6. What this amendment does not change

- `PREPARED / NOT PROMOTED`; **DOCS ONLY**; **ALL GATES UNMEASURED** (PART 90)
  — which is exactly what this pack has said since 2026-10-07.
- No migration number, filename or example (PART 6).
- Promotion order unchanged (PART 4); Phase 14 promotes after Phase 13 and
  cannot self-promote.
- Amendment 01's narrowing stands, confirmed by PART 99.
- The 25 earlier laws stand; this adds `P14-AL-26`, `27`, `28` and amends
  `08`, `14`, `15`, `18`, `25`. Nothing is withdrawn except my own rate-limit
  numbers, which PART 97 was right to refuse.
- Nothing killed, no reset, no commit, no push (PART 12: a preservation push is
  *allowed*, not required, and an empty branch preserves nothing).

---

*`PREPARED / NOT PROMOTED`. Amendment 02, 2026-10-12, from `93084f8`.*
