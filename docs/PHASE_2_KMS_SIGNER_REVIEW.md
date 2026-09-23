# DAFTAR — P2-S8 review: a KMS-backed accounting signer

**Status: REVIEW ONLY. Nothing in this document has been implemented.**
P2-S8 was authorised to *review* this boundary (§43) and explicitly *not* to
build it (§44). No KMS service was created, no cloud SDK was added, no
assertion format was changed, and nothing local has been relabelled
"KMS-backed".

---

## 1. The boundary as it stands today

`ACCOUNTING_ASSERTION_KEY` is a raw HMAC secret (base64, ≥ 32 bytes) held in
the environment of the **merchant-api** process. `AccountingAssertionMinterService`
parses it at construction and `mintAccountingAssertion` computes the MAC in
process. The database holds the *same* secret in `accounting_assertion_keys`
(installed by the platform-only `accounting_assertion_key_install`, `0044`) and
`accounting_actor()` recomputes the MAC to verify every posting.

The configuration refuses the key to every other runtime — the platform API,
the worker and, as of this slice, the reconciler — so the exposure is confined
to one process. It is still an exposure:

> A fully compromised merchant-api process can read the signing secret and
> mint accounting assertions for any actor, business and payload, for as long
> as that key remains installed — including after the intrusion ends, offline,
> from anywhere.

That last clause is the whole of the threat. Everything below is about whether
it can be removed.

---

## 2. The six questions §43 asks

### A. Can the current abstraction perform MAC/sign operations without exposing raw signing key material to merchant-api?

**No.** DAFTAR's KMS-style infrastructure is `KmsCredentialEncryptor`
(`apps/api/src/modules/delivery/credential-protector.ts`). Its port is
`CredentialPayloadEncryptor`, and that port has exactly one verb:

```ts
encrypt(secret: string, aad: Buffer): Promise<ProtectedPayload>
```

It posts `{plaintext, aad}` to an authenticated HTTPS bridge and expects
`{ciphertext, nonce, keyVersion}` back. There is no `mac`, no `sign` and no
`verify`. It is an envelope-encryption client, not a signer.

Its *transport* discipline is reusable and is already production-grade —
HTTPS-only, bearer authentication, a bounded timeout with abort, a bounded and
schema-validated response, one retry confined to transport failures and
502–504, and errors that never carry the plaintext or the response body. A
`KmsAccountingSigner` would want all of that. But reusing the transport is not
the same as having the capability: the **provider** must expose a MAC or sign
operation, and that is a deployment decision nobody has made. Claiming
otherwise would be exactly the overclaim §44 forbids.

### B. Can accounting and provisioning domains retain independent keys?

**Yes, and they must.** They are independent today and the separation is
enforced twice: production config validation refuses `PROVISIONING_ASSERTION_KEY`
and `ACCOUNTING_ASSERTION_KEY` that are byte-identical, and
`AccountingAssertionMinterService` repeats the comparison at the point the key
is actually loaded, because config validation only runs in production and a
staging box sharing one secret would otherwise look healthy until it leaked.

A KMS-backed signer preserves this trivially: two key identifiers under one
provider, with separate access policies. It does not weaken domain separation
and nothing about the change requires merging the domains.

### C. Latency and availability

A posting currently mints its assertion in microseconds — an in-process
`crypto.createHmac` over a short preimage.

A remote MAC turns every posting into an extra network round trip on the
**critical write path**. On the same-VPC assumption the credential bridge
already makes, that is realistically 2–15 ms per call, against a §34 budget of
**15 ms p95 for the whole posting command inside its transaction**. A remote
signer would consume that budget outright.

The availability consequence is sharper than the latency one. Credential
encryption can fail closed with a retry and a delivery that lands a moment
later; a MAC that cannot be obtained means **the merchant cannot post at
all**. The KMS becomes a hard dependency of writing the ledger. Mitigations
exist (short-lived batch assertions, a local cache of pre-minted MACs, an
asymmetric scheme with a cached key handle) but each is a design with its own
threat model, and none of them is "the same thing, remote".

### D. Rotation

Rotation is already modelled in the database: `accounting_assertion_keys` is
keyed by `kid`, installation is idempotent for the same material, loud for
different material under a live `kid`, and retirement is terminal. An
assertion names its `kid`, so two keys can be live at once and a rotation is
install-new → switch-minting → retire-old.

Under a KMS signer the same shape holds, with the key *version* living in the
provider rather than in the environment. The one new requirement is that the
database must be able to verify assertions minted under a version it was not
told about ahead of time — which brings us to E.

### E. Would the database verifier still obtain compatible verification material safely?

**This is the question that decides the whole proposal, and with HMAC the
answer is no.**

HMAC is symmetric: the verification material *is* the signing material. So a
KMS-backed HMAC signer would still require the raw secret to be installed in
`accounting_assertion_keys` for `accounting_actor()` to verify. The secret
would leave merchant-api and stay in PostgreSQL.

That is a real reduction — a compromised application process could no longer
exfiltrate a key that lets it mint forever — but it is a *partial* one, and it
must be stated as such: the secret has moved, it has not disappeared, and the
database now holds the only copy of a credential that is also the credential a
database compromise would need.

Making the reduction complete requires changing the scheme to **asymmetric**:
sign in the KMS with a private key that never leaves it, and give PostgreSQL
only a public key. `pgcrypto` does not verify Ed25519, so the verifier would
need a different mechanism entirely. That is not a KMS integration; it is a
redesign of the assertion protocol, and §44 forbids doing it silently.

### F. Does moving the signer reduce the threat boundary, or merely move the same secret?

Honestly: **both, in different measures, depending on the scheme.**

- **Remote HMAC.** A compromised merchant-api can still obtain MACs for
  anything it asks for *while it is compromised*, but it cannot steal a key
  and mint after eviction. The blast radius becomes bounded in time and
  observable at the provider — every mint is a request that can be rate
  limited, logged and revoked. The secret itself moves from the application
  environment to the database. A genuine but partial reduction.
- **Remote asymmetric signing.** The private key never exists outside the
  provider, and the database holds only public verification material. This is
  the real reduction, and it requires a new assertion protocol.

So the shortest honest summary is: a KMS-backed HMAC signer buys
*revocability and observability*, not *secrecy*. Only an asymmetric scheme
buys secrecy, and that is a separate decision.

---

## 3. §44 classification

**CURRENT STATE.** Raw HMAC secret in the merchant-api environment; identical
secret in `accounting_assertion_keys`; MAC computed and verified in process
and in the database. Refused to every other runtime by configuration.

**TARGET STATE.** Assertion MACs produced by a provider that holds the key
material, over the existing authenticated HTTPS transport, with per-domain key
identifiers and provider-side rate limiting, audit and revocation.

**THREAT REDUCTION.** Removes offline, post-eviction minting from a
merchant-api compromise, and makes every mint an observable, revocable,
rate-limitable event. Does **not** remove the secret from the system while the
scheme stays symmetric.

**REQUIRED PROVIDER CAPABILITY.** A `mac` / `sign` operation over a
caller-supplied preimage, with a named key identifier, authenticated, and with
a latency budget compatible with a synchronous write path. DAFTAR's existing
bridge contract offers `encrypt` only; the provider contract would need to
grow one verb. No such provider is deployed.

**MIGRATION PLAN.** Introduce an `AccountingAssertionSigner` port with the
current in-process implementation behind it (no behaviour change). Add a
remote implementation reusing the credential bridge's transport discipline.
Install the new `kid` in the database first, switch minting, then retire the
old `kid` — the existing rotation shape, unchanged.

**ROTATION PLAN.** As in D: `kid`-addressed, two keys live during a rotation,
terminal retirement, and `check:key-retirement` already guards the invariant
that a retired version is not removed while rows still reference it.

**FAILURE MODE.** The KMS is a hard dependency of posting. An outage stops
merchants from writing to the ledger; it must fail closed with a classified,
non-leaking error (as `KmsEncryptError` already does) and must never fall back
to a local key, because a fallback would reinstate exactly the exposure the
change is meant to remove.

**LATENCY EXPECTATION.** 2–15 ms per mint on a same-VPC provider, against a
15 ms p95 budget for the entire posting command. The budget would have to be
renegotiated, or the design would have to avoid a per-posting round trip.

---

## 4. Recommendation

Leave the boundary where it is for Phase 2, and carry it as a known,
documented exposure rather than as a silent one. The change worth making is
not "point the signer at a KMS"; it is the asymmetric redesign in E, and that
needs a Tech Lead decision about the assertion protocol and about the posting
latency budget before any code is written.

Recorded in `TECHNICAL_DEBT.md`.
