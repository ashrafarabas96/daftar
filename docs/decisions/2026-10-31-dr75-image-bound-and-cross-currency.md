# DR-75 §1 and §2 — the image dimension bound, and cross-currency overpayment

Every measurement below was taken on `p4/seal-candidate` at
**`9abb381f574ce07b0f8c3587030eab041d72f016`**, on Windows, with no database.
Where a claim is carried by a different SHA or by a CI run, that SHA or run
number is named on the claim. Where something was not run, it is listed in §3
with the condition that would let a CI step report success **without exercising
its subject** — the shape of defect this project has already met once, when
`verify:history` printed `PASS` against a database with zero migrations applied.

---

## 1. DR-75 §1 — the image dimension bound

### 1.1 What was previously believed

Two things, and both were wrong in the same direction — they understated what
already existed:

- That `sharp` might have no pixel ceiling configured, so DR-75 §1 was written
  with an "if not ⇒ set an explicit bound" branch.
- That `limitInputPixels` appeared **4** times in the project. That count was
  taken without a scope: all four matches were inside `node_modules`
  (`sharp`'s and `next`'s type declarations). **Measured at `9abb381f`, scoped
  to `apps packages tests tests-unit infrastructure scripts`, the count is 0.**

### 1.2 What is measured now

**An explicit dimension bound already exists, and it is enforced before any
decode.** At `9abb381f`, in `apps/api/src/modules/catalog/media.service.ts`:

| Line | What is there |
| --- | --- |
| 17 | `const MAX_DIMENSION = 6000;` |
| 40 | the byte ceiling, `this.config.MEDIA_MAX_BYTES` (default `5 * 1024 * 1024`, `config.ts:90-94`) |
| 49 | `imageSize(file.buffer)` — parses the header; it does not decode |
| 59 | `if (dims.width > MAX_DIMENSION \|\| dims.height > MAX_DIMENSION)` → `AppError('MEDIA_INVALID', 'Image dimensions exceed limits', 400)` |
| 67 | the **first** `sharp()` call |

So the refusal at 59 precedes the first decoder call at 67. The "if not" branch
of DR-75 §1 does not fire, and **no second limit was added** — the owner's
instruction, and the right call independently: a second ceiling in a second
place is a second thing to keep in step.

**The bound is not redundant with the library's own ceiling.** Measured
directly rather than recalled: `sharp` 0.35.5 **at its default settings decodes
the 7000×7000 PNG** (1333 ms, 87,400-byte WebP out). The same call with an
explicit `limitInputPixels: 1000` refuses it (`Input image exceeds pixel
limit`), so the option exists and bites and the probe discriminates. 7000×7000
is 49,000,000 pixels; what `MAX_DIMENSION` permits at most is 36,000,000.
⇒ `MAX_DIMENSION = 6000` is **strictly tighter than sharp's default**, and it,
not the library, is what refuses the bomb.

**What did not exist is a test that names it.** Measured at `9abb381f`, scoped
to `tests tests-unit`: `MAX_DIMENSION` → **0 hits**; `dimensions exceed` →
**0 hits**. The same probe over `apps/` → **4 hits**, so the probe finds the
string when the string is there and the absence was real, not a broken pattern.

That gap is now closed by **`tests-unit/dr75-media-dimension-bound.test.ts`**
(6 cases, exit 0, 327 ms). It adds no product code.

### 1.3 The discriminator, and why a status assertion would not have done

Six refusals stand on this path before any pixel is read, and **three of them
are the same code and the same status**:

| # | Line | Refusal | Code / status |
| --- | --- | --- | --- |
| 1 | 38 | empty buffer | `VALIDATION_FAILED` 400 |
| 2 | 40 | over `MEDIA_MAX_BYTES` | `MEDIA_TOO_LARGE` 413 |
| 3 | 42 | MIME not in `ALLOWED_MIME` | `MEDIA_INVALID` 415 |
| 4 | 47–54 | `image-size` cannot parse it | `MEDIA_INVALID` 400 |
| 5 | 56–58 | magic MIME ≠ declared MIME | `MEDIA_INVALID` 400 |
| 6 | **59** | **a side exceeds `MAX_DIMENSION`** | **`MEDIA_INVALID` 400** |

A test asserting only `400` + `MEDIA_INVALID` would pass just as happily on a
malformed file, and would keep passing with line 59 deleted. The discriminator
is therefore **not** the status. It is a pair plus a count:

- **The pair.** Both arms come out of one generator with one argument changed —
  a real, fully valid **7000×7000** PNG (measured: **156,520 bytes**) and the
  same generator at **100×100**. Every property refusals 1–5 test is a property
  the two arms *share*, and the test asserts each one **on both arms** rather
  than arguing it: non-empty, under `MEDIA_MAX_BYTES`, the same declared MIME
  literal, parsed by `image-size` with all three of width/height/type, and
  magic agreeing with declared.
- **The count.** `sharp` is mocked by a recorder, so "before decode" is a
  measurement and not an inference from the order of lines. The refused arm
  leaves the recorder at **0** calls and writes nothing to storage and opens no
  transaction; the accepted arm reaches the decoder (**≥ 1** call, handed
  exactly the submitted byte length) and stores its original.

The asymmetry is what carries the claim. Refusals 1–5 would *also* leave the
decoder uncalled, so "uncalled" alone proves nothing; what proves it is that
**when only the dimension changes, the decoder runs**. The refusal is therefore
attributable to the dimension and to nothing else on the path.

Two further things the file pins, because each is a distinct claim:

- **The bound reads the declared header, so the attack is cheap.**
  `image-size` 2.0.4 does **not** verify the IHDR CRC — measured in both
  directions, including a buffer whose CRC was deliberately left unrepaired. A
  **94-byte** PNG can therefore *declare* 7000×7000 and is refused identically,
  before decode.
- **Both arms of the `||`.** Line 59 has two sides. A test that varied only the
  width would leave half the bound unguarded, so 6001×6000 and 6000×6001 are
  each exercised, and 6000×6000 — the value *on* the limit, where `>` is
  strict — is asserted to pass the bound and reach the decoder.

`MAX_DIMENSION` is module-private and this card may not edit the service to
export it, so `6000` is written down a second time in the test. The duplicate
is **pinned, not left to rot**: the first case asserts the service's own source
declares exactly `const MAX_DIMENSION = 6000;`, on source text with comments
stripped (and with a positive control that the stripper did not eat its own
subjects). Plant A below is the proof that this pin bites.

### 1.4 The negative control (DR-55)

Two plants, each proven applied by its `sha256` **before** the result was read,
each restored by byte-copy from a pristine snapshot — **not** by
`git checkout --`, which under this host's `core.autocrlf=true` would have
restored CRLF and made a byte comparison lie.

Pristine `apps/api/src/modules/catalog/media.service.ts`:
`48725d41d9829d6919af3f0b2f28a901b0fe177f384278c2dfb20ae3562ab92c`,
9089 bytes, 0 CR bytes.

| Plant | Mutation | `sha256` after | Result |
| --- | --- | --- | --- |
| **A** | `MAX_DIMENSION` 6000 → 60000 | `2b3b1515ff4f1835214c211fb30cacc0c3f2d3a08c731f6280863dc0b36fc21b` | **exit 1**, 4 failed / 2 passed |
| **B** | the guard block at 59–61 deleted (9089 → 8932 bytes) | `e0ca801ad9566ab56dd6d9180b0acc01e4e233a8b9982b23389d96bc8d7323ea` | **exit 1**, 4 failed / 2 passed |

Both plants reddened the same four cases, by name: the pinned-constant case,
the refused-bomb case, the header-lie case, and the boundary case. The refused
arm failed with **`the upload was ACCEPTED — there is no refusal to inspect`** —
i.e. with the bound raised, the 7000×7000 bomb is accepted and decoded, which
is the hazard stated as an outcome rather than as a worry. The pinned-constant
case failed with `this file asserts a boundary of 6000. If the service's
constant moved, THIS is the assertion that must fail.`

After each plant: restored `sha256` **equals pristine**, `git diff --numstat`
returns **0 lines**, and the suite is **green again (6/6)** — so the plants,
not the fixture, were the cause.

**Two cases did not redden, and that is correct.** The accepted arm (100×100 is
still accepted) and the discriminator case (which asserts properties of the two
buffers and never calls the service) are both insensitive to the bound by
construction.

### 1.5 The limits of this evidence

- The test asserts the **`AppError`'s own `httpStatus`** (400) — note the
  property is `httpStatus`, not `status` (`packages/domain-core/src/errors.ts:55`).
  It does **not** exercise the HTTP response. The mapping to a wire body is
  covered elsewhere (`tests/integration/media.test.ts:80`), **but that case
  covers the magic-byte refusal, not this one** — reading it as cover for the
  dimension path would be reading an empty pass.
- **No memory figure is claimed.** The decode probe reported a 1 MiB RSS delta,
  which is not the cost of a 49-megapixel decode: sharp allocates in native
  memory off the JS heap. The decode's real footprint is NOT_MEASURED, and the
  bound exists so that it is never paid.
- The comment stripper used by the ordering case is a regex; it would mishandle
  a `//` inside a string literal. The file has none, and the case asserts both
  anchors survive the strip, which is the positive control for that limit.

### 1.6 Current state

The bound existed and now has a test that names it, distinguishes it from every
neighbouring refusal, proves it precedes decode by count rather than by reading
order, covers both sides of the `||` and the strict boundary, and pins the one
constant it had to restate. No product code changed.

---

## 2. DR-75 §2 / C1.1 — overpayment settled in a currency other than the invoice's

### 2.1 What was previously believed

That this might be an uncovered gap, to be answered either by a new live test
or by proving no lawful path exists — and, in the weaker reading, that it could
be deferred to the `B ≠ T` follow-up card.

### 2.2 What is measured now

**The path exists, it is a first-class planned case, and it is already covered
live — twice, by two independent suites. No test was added.**

The path. `apps/api/src/modules/receivables/customer-payment.service.ts:332`
computes `sameCurrency: a.invoice.currency === i.currency` per allocation leg
and hands it to the pure planner `planCustomerPayment`; line 372 records
`invoiceCurrency` beside the resolved payment currency. Paying an invoice in a
currency other than its own is planned for, not an accident.

**(a) Is conservation (DR-23) asserted on an overpayment whose payment currency
differs from the invoice currency? Yes — in both of these:**

- `tests/golden-regression/phase4-s4/12-overpayment-customer-credit.golden.test.ts:453`
  — *“the overpaid invoice closes exactly, and the payment document accounts for
  every minor unit it received”*. It asserts `{paid, outstanding, state}` equals
  `{invoice total, '0', 'paid'}` (“outstanding is exactly zero and never
  negative”), then `residueMinor === '0'` and `residueBaseMinor === '0'` — i.e.
  **Σ allocations + credit created = amount received, in the payment's own
  currency and in base.** Its own words: *“a positive residue is money that
  arrived and went nowhere, a negative one is money the document conjured.”*
- `tests/golden-regression/phase4-s4/10-settlement-cross-currency.golden.test.ts:629`
  — *“the closure holds in the PAYMENT's currency and in base — and the figures
  genuinely distinguish it from the invoice-side sum”*. It runs on
  `creditCase`, the overpayment scenario, and asserts `closureResidue === '0'`
  and `closureResidueBase === '0'`.

Both are genuinely overpayments and genuinely cross-currency:
`10-…:313` collects `amountMinor: (p3 + surplusMinor).toString()` in
`PAY_CURRENCY` against a base-currency invoice, so the surplus is real and the
currencies differ. `12-…:117-118` declares `PAY_CURRENCY = 'USD'` as *“the currency the
surplus arrives in. Deliberately not the base, and asserted so before anything
runs.”* `10-…:659` adds `paid + outstanding = total` **in the invoice's own
currency** across all three scenarios, including the credit one.

**(b) Do those suites run in CI? Yes — verified, not assumed, by four
measurements:**

1. `test:golden` is `vitest run tests/golden-regression` (root `package.json`).
2. `.github/workflows/ci.yml:384` is `run: npm run test:golden`, step *“Golden
   regression suite”*, `env: PG_PORT: '5432'`, inside the **`backend`** job
   (declared at `ci.yml:182`).
3. `vitest.config.ts:10` includes `tests/**/*.test.ts`, and both files sit under
   `tests/golden-regression/phase4-s4/`, so the path argument reaches them.
4. Both are on the P4-S4 roster: `scripts/phase4-s4-gate.ts:2278` names file 10
   together with its `describe` title, and `:2475` names file 12.

And neither can be quietly switched off: `grep -cE "\.(skip|only|todo)\("`
returns **0** for each.

**(c) Non-vacuity — would any of this still pass if the cross-currency arm went
inert? No. Three independent guards fail first, and the authors wrote them:**

- `10-…:257` — at fixture time, before any scenario is built:
  `expect(PAY_CURRENCY, 'NO SUBJECT — the payment currency must differ from the
  business base currency').not.toBe(base)`. If the two currencies ever became
  the same, setup fails. `12-…:239` carries the same guard.
- `10-…:633` — `expect(closure.amountMinor > 0n, 'NO SUBJECT — a payment of
  zero satisfies every identity at 0 = 0').toBe(true)`.
- `10-…:651-656` — the sharpest one, and exactly the (c) question answered in
  advance. It computes the **wrong** law (`amountMinor − appliedInvoiceMinor −
  creditCreatedMinor`) and asserts it is **not** zero: *“summing the
  INVOICE-side amounts against a payment of … happens to close too, so this
  scenario cannot tell the corrected law from the wrong one. The two currencies
  must make the two sums differ, or the correction is untested.”* In a
  single-currency fixture `payment_amount_minor = invoice_amount_applied_minor`
  by `payment_allocations_same_currency_ck`, so the corrected law and the
  original wording are indistinguishable; this case **refuses to pass** where
  they are indistinguishable.

File 10 carries **15** `NO SUBJECT` guards in total.

### 2.3 The limits of this evidence

- **Which half of "cross-currency" is covered.** In both suites the *invoice* is
  in the business base currency and the *payment* is not. That satisfies
  "payment currency ≠ invoice currency". What is **not** reachable is an
  overpayment on an invoice in a **non-base** currency: a product's
  `price_currency` is pinned to the business base currency by
  `catalog.service.ts:249-252` (measured: it *refuses* a `priceCurrency` that
  is not the base), so every invoice carries `rate_source = 'base'`
  and `source_to_base_rate = 1`, hence `B = T`. File 10 does not paper over
  this — `:679` measures the pin and reports it as a disclosure, names the dead
  FX branch it strands (`sale-commit.service.ts:641-660`), and `:727` proves the
  AR-dust law *can* be non-zero as a red proof over synthetic `(B, T, R)`. It
  does not assert the gap is correct. **The `B ≠ T`-through-the-sale-path card
  therefore stays open and stays visible in the seal summary**, as a follow-up
  accepted by decision — it is not what C1.1 asked, and C1.1 is answered.
- **I did not run these suites.** They need PostgreSQL and this host has none
  (see §3). What I measured is their *content*, their CI wiring and their roster
  membership. Their green is owed to the decisive run.

### 2.4 Current state

C1.1 is answered by existing live coverage, with the combination — overpayment
*and* payment-currency ≠ invoice-currency *and* conservation in both the payment
currency and base — asserted in two places, each with its own non-vacuity
guard. **No test was added, and nothing in either golden suite was weakened,
skipped or re-titled.**

---

## 3. NOT_RUN, and what would make each pass empty

| # | NOT_RUN | What would make a CI pass **empty** |
| --- | --- | --- |
| 1 | **Both golden suites** (`10-…`, `12-…`) — not executed here. Measured by me: nothing is listening on 5432 on this host, and `tests/helpers/embedded-cluster.ts` contains **0** matches for `initdb\|encoding\|locale\|LC_\|createdb` (positive control: 5 for `ensurePostgres\|PG_PORT`), so the cluster it starts inherits the host code page. That it then dies in `applyBootstrap` on a `WIN1256` mismatch is a **previously recorded** measurement, not one I reproduced. | A `requireSubject` that *returned* on an absent subject instead of throwing. **Measured and closed:** `tests/golden-regression/phase4-s2/harness.ts:181-188` **throws**, so an absent subject is red, not green. Separately, a wrong path in `test:golden` would collect nothing — also closed, because `vitest run` exits 1 on "No test files found". |
| 2 | **The dimension bound over HTTP** — the new test asserts the `AppError`'s `httpStatus`, not a response. | Reading `tests/integration/media.test.ts:80` as cover: it asserts `MEDIA_INVALID` for the **magic-byte** refusal (line 56–58), not for the dimension refusal. Same code, same status, different line — the exact confusion §1.3 was built to defeat. |
| 3 | **The memory cost of an unrefused decode.** | Quoting the 1 MiB RSS delta measured here as the cost. It is not: sharp allocates natively, off the JS heap. Any future memory claim must measure native allocation, not `process.memoryUsage()`. |
| 4 | **`npm test` end to end, and `test:integration`** — only `test:unit` (9 files, 73 tests, exit 0), `typecheck`, `lint` and `format` were run on this host. | `tests-unit/**` silently leaving the chain. **Guarded:** `tests-unit/test-lane-roster.test.ts` fails if `test:unit` leaves `npm test` or if a root test directory has no roster row. |
| 5 | **That the new test's `sharp` mock really applies.** | This is the one worth stating plainly. If `vi.mock('sharp')` ever stopped taking effect, the recorder would stay at 0 calls for **every** arm — and the refused arm's `toEqual([])` would still pass. It is the **accepted** arm, asserting `≥ 1` call, that makes that failure visible. The pair is not decoration; drop either half and the remaining one can go emptily green. |

## 4. Scope

Added: `tests-unit/dr75-media-dimension-bound.test.ts`, this document.
`apps/api/src/modules/catalog/media.service.ts` was mutated **transiently** for
the two DR-55 plants and restored byte-for-byte (`sha256` equal to pristine,
`git diff --numstat` 0 lines). No migration, no workflow, no performance suite
and no golden suite was touched.

Exit codes on `9abb381f` plus this change: `test:unit` **0** (9 files, 73
tests) · `typecheck` **0** (0 `error TS`) · `lint` **0** · `format` **0**.
