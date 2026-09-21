# DAFTAR — Technical Debt Register / سجل الديون التقنية

> ممنوع تسجيل: فساد محاسبي، مشكلة أمنية، مشكلة سلامة بيانات — هذه تُصلح فورًا (Master §137).
> Forbidden here: accounting corruption, security defects, data-integrity defects — those are fixed immediately, never registered.

## Registered debt (Phase 1 closure)

| ID | Description | Why it is debt and not a defect | Impact | Repayment plan | Status |
|---|---|---|---|---|---|
| TD-01 | `@vitest/mocker` moderate advisory (GHSA-82fw-gwwq-j7x9, path traversal via redirect mock) — vitest 3.2.7 | Dev/test-only dependency; never present in a runtime image; `npm audit --audit-level=high` is the release gate and passes | None in production | Upgrade to vitest ≥ 4.1.11 (config migration for `poolOptions`) at the start of Phase 2 | open |
| TD-02 | Admin console is English-only (`lang="en"`) | Internal platform-staff tool; documented decision in `docs/PHASE_1_DESIGN_REVIEW.md` §3 (§58–61 allow a documented English-only admin) | Operator staff only | Add `messages/*.json` + the same `check:localization` when a non-English operations team is planned | open (decision) |
| TD-03 | Android instrumented UI tests not run in CI (JVM tests + lint + assemble only) | CI has no device/emulator lab; the contract, retry and money logic are covered by JVM tests | UI regressions caught manually | Add a Firebase Test Lab / emulator job in Phase 7 (offline and mobile production workflows), when offline sync lands | open |
| TD-04 | Next.js `<img>` (not `next/image`) for signed media previews | The image optimizer cannot fetch short-lived signed private URLs; the preview is already a server-resized variant | No optimization pass on previews | Revisit if a CDN in front of the bucket is introduced (Phase 6 storefront) | open (decision) |
| TD-05 | Platform-console MFA not implemented | ASVS V4.3 partial; console is behind the internal ALB + SSO/VPN in the reference architecture | Depends on deployment controls | Phase 15 (production hardening) — earlier if the console is exposed outside the internal network | open |
| TD-06 | No browser viewport audit (phone/tablet × ar/en/tr) executed or automated at closure | Layouts are fluid and token-based; the check is a review of the source, not a rendered screenshot | Layout regressions caught by review, not CI | Playwright screenshot job per locale/breakpoint in a later UI phase | open |
| TD-07 | `provisioning_assertion_uses.used_at` has no index; the opportunistic cleanup (`DELETE … WHERE used_at < now() - interval '1 hour'`) scans the table | The table holds at most the assertions of the last hour — a few rows per provisioning transaction — so no cost is measurable today. Adding a migration for a speculative optimisation during final closure is forbidden by the closure directive | None measured | Measure the table's size and the cleanup plan under Phase 2 load; add an index in a normal (non-closure) migration only if the measurement justifies it | open (P3) |

## Closed during the Phase 1 closure (were defects, fixed — listed for traceability, not debt)

- Provisioner accepted a caller-chosen actor id → server-derived actor (`0033`).
- Runtime isolation existed only as env validation → real per-process modules.
- Credential DEV key fallback reachable in production → throws under `NODE_ENV=production`.
- Rate limiter outage failed open → 503 + `Retry-After`.
- Audit/outbox rows without tenant → CHECK + backfill (`0035`).
- JSONB translations / per-table SKU uniqueness → normalized tables + `catalog_identifiers` (`0036`, `0037`).
- Bootstrap ran with migration credentials → platform principal + advisory lock + `--promote-existing`.
- Android retry rebuilt requests → `RequestSpec` replay.
- 12 npm advisories (1 critical) → 0 high/critical.

## Deferred decisions (not debt — see docs/DAFTAR_OPEN_DECISIONS.md)

- OD-02 WhatsApp provider · OD-03 country tax rules · OD-04 payment gateways · OD-07 currency revaluation.
