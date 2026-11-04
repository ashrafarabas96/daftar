# DR-46 — test tooling never asks for a weaker CSP

**Decided 2026-10-28**, from a defect this repository produced and measured on
itself the same day.

## The rule

1. **No test tool, harness or fixture may require a relaxed Content Security
   Policy.** Not `unsafe-eval`, not `unsafe-inline`, and not a
   test-environment exception, a test-only directive, or a conditional policy
   that is looser when some flag is set.
2. **Browser-gate polling goes through `page.evaluate` or the debugging
   protocol only** — never through anything that installs script into the
   page.
3. **A `CSP-VIOLATION` in the browser gate is a blocking failure, always.** It
   is never expected, never filtered, never downgraded to a warning.

## What produced it

The browser gate's keyboard walk was racing the render: it started tabbing
before the page's own reads had landed, so it measured whether a button had
arrived yet rather than whether the keyboard could reach it. The fix was a
readiness wait — and it was written with `page.waitForFunction`.

`waitForFunction` installs a polling script **inside the page**. This app
serves `script-src 'self' 'nonce-…' 'strict-dynamic'` with no `unsafe-eval`,
so the browser refused it. Measured on run 40607960533: **nine
`CSP-VIOLATION script-src eval`**, the wait never evaluated once, and
`receive` reported its button absent in all three locales at all three
widths. The race it replaced had failed two combinations intermittently; the
fix failed nine deterministically — and it added CSP violations to a gate
whose job includes reporting them.

The correct mechanism was in the same file, three functions away:
`tabUntil` has always polled with `page.evaluate`, which travels the
debugging protocol and is not page script at all.

## Why the rule is worth having

The tempting repair, at the moment of that failure, is a line of CSP for the
test environment. It would have turned the gate green in minutes.

It would also have meant the gate no longer tests the policy the merchant's
browser enforces. A CSP is only worth what it refuses; a suite that runs
under a looser one measures an application that does not ship. And the
violation here was not incidental noise — it was the gate correctly reporting
that something had injected script into a page that forbids it. Silencing it
would have discarded a true report to protect a wrong tool.

## Clause 3 is already enforced by construction, and measured

`tests/browser/run-context.ts` records a `csp` issue — in the `console`
handler, ahead of the `console-error` branch — for any
CSP-violation text **unconditionally** — it sits outside the `isExpected`
URL filter that `console-error` on the next line passes through. Any recorded
issue fails the run's verdict. So a CSP violation cannot be suppressed by the
expected-noise list, which is the one place it could plausibly have leaked
away.

That is a property to keep rather than a change to make. Anyone adding a
filter in front of it is removing this rule.
