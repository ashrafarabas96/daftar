# DR-45 — every 429 carries a Retry-After

**Decided 2026-10-28.** Recorded as a card, not done here: the file it needs
belongs to another open branch.

## What was found

The browser-gate pacing work (DR-44) asked a narrow question — does the
route-throttle refusal say *when* to come back? — and the answer, read from
`apps/api/src/common/error.filter.ts`, is that it depends on which refusal
you hit:

- The auth limiter raises its own `RateLimitError`, and the filter sets
  `Retry-After: <seconds>` from it.
- The general per-route throttle (`ThrottlerModule`, 300 per client and route
  handler per minute) raises an `HttpException` with status 429, which falls
  through to the filter's generic status map. That arm sets the code
  `RATE_LIMITED` and **no header at all**.

Whether `@nestjs/throttler` sets a header of its own before throwing was not
measured; the gate run prints what it saw so the next person does not have to
guess either.

## The decision

A 429 without `Retry-After` tells a client it was refused and nothing about
when to try again, so every client either gives up or retries blindly — and
blind retries are what the limiter exists to stop. **Every 429 the API
returns carries `Retry-After`, in whole seconds, with a test that pins it.**

This is a soundness gap in production behaviour, not a gap in the tests. The
browser gate's pacing is unaffected either way: it stays below the allowance
so it never sees the refusal at all.

## Not blocking the Phase 4 seal

Nothing in the receivables, aging, instalment or credit-balance work reads
this header, and no money or tenant-isolation property depends on it. It is
recorded as a tracked card and done after the seal.

## Sequencing — why it is not done in the card that found it

`apps/api/src/common/error.filter.ts` is owned by PR #7
(`claude/upload-scanner-fail-closed-bkr7h9`, head `4f9c34c`), which is open
and modifies that file. One writer per file: this card starts once #7 is
merged, rebased or closed, and not before.

## What the card must do

1. Set `Retry-After` on the 429 arm of the filter, in whole seconds, from the
   throttler's own time-to-expire rather than a constant — a fixed number is
   a guess that is wrong for every window but one.
2. Extend `tests/integration/p3c-bff-route-throttle.test.ts`, which already
   drives the real limit through the real proxy: the refusal carries the
   header, it parses as a positive integer, and it is not larger than the
   window.
3. Leave the auth limiter's existing behaviour alone; it already does this.
4. A negative control: removing the header turns that assertion red.
