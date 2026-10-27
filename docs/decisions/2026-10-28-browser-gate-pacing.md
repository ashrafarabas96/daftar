# Browser gate pacing, and the proof that nothing walks past it

**Decided 2026-10-28.** Recorded here because it governs how the real-browser
gate behaves, and a decision that lives only in a working note is a decision
the next reader never sees.

Numbering: the owner issued this as "DR-41". That number was already taken by
the aging endpoint's performance budget, so this is recorded as **DR-44**,
with the cross-reference kept rather than silently renumbered. (DR-40 and
DR-42 collided the same way earlier; the pattern is a decision being named
from one thread while another thread had already spent the number.)

## What happened

CI run 40565741434, self-hosted runner: the browser gate failed with twelve
`429 GET /api/proxy/inventory/access` and forty `Timeout 20000ms`, beginning
at the `starting-stock` step at 768px and continuing in all three locales.
The same gate passes on the hosted runner.

The matrix did not change; the machine did. Twenty cores drive the screens
several times faster than four, and `inventory/access` is read by the app
header *and* four page modules, which makes it the busiest route in the suite
by a wide margin. The API allows 300 per client and route handler per minute
(TD-19), and every browser the gate drives shares one client address.

## What was decided

1. **The gate paces itself further below the allowance.** The margin was a
   tenth; it is now a fifth (240 of 300). Deterministic sliding window, as
   before — no random sleeps.
2. **The API's limit is not changed, no timeout is raised, and no assertion,
   screen, locale or viewport is dropped.**
3. **Coverage is proved, not assumed.** Every proxied request is counted three
   ways per route — seen by the page, charged by the pacer, or answered
   locally by a step — and `seen = paced + local` must hold for every route or
   the gate fails and names it. A wider margin alone would have bought a green
   run while leaving an unpaced path in place, which is the failure this
   check exists to prevent.
4. **A negative control exists.** `BROWSER_GATE_NO_PACING=1` removes the
   waiting and keeps the interception, so a control run meets the limiter
   while the counts stay exact. Never set in CI's own gate steps.
5. **The limiter is proved separately.** Pacing below a limiter is
   indistinguishable from a limiter that stopped limiting, so going over the
   production limit is asserted to be refused as `RATE_LIMITED` — not merely
   as some 4xx — in `tests/integration/p3c-bff-route-throttle.test.ts`.

## What this does not settle

`Retry-After` on that refusal is **not** pinned. This route's refusal travels
the error filter's generic `HttpException` arm, which sets no such header;
whether `@nestjs/throttler` sets one before throwing was not measured here,
and `apps/api/src/common/error.filter.ts` belongs to another open branch.
Pinning a header nobody observed would be a claim; pinning its absence would
freeze a gap worth closing. The run prints what it saw, and the question is
left open for whichever card owns that file.

## Evidence owed before this is accepted

- Three consecutive clean browser-gate runs on the self-hosted runner.
- One control run with `BROWSER_GATE_NO_PACING=1` that goes red on 429.
- The per-route coverage table, with no unpaced route, on each of them.
