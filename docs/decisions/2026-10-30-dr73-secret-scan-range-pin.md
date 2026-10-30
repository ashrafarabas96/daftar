# DR-73 §1 — a range finding allowlisted by pinning the line it names

## What was flagged, and what it was

The secret history range scan reports the same finding at two commits:

```
tests/security/dr71-zod-sensitive-paths.test.ts:396   rule generic-api-key
```

The line, read from git at both commits, is:

```ts
{ grantAll: true, roleKeys: 'owner-SECRET9' },
```

**It is a role name, not a secret.** It is a fixture handed to a schema that
must **reject** it, because a string sits where an array is required; the value
is `owner-` plus a marker suffix chosen to be conspicuous in a diff. It was
never a key, it opened nothing, and no system ever accepted it — the assertion
it serves is that the rejection envelope names the field and nothing else.

**It is already corrected at the head.** Line 396 is now a comment, and the
fixture reads `'not-an-array'`. The tree scan reports **no leaks**, and these
entries do not touch it.

## Why it could not simply be removed

The finding sits at **historical commits** in this branch's range. Removing it
from history means rewriting history, which is permanently forbidden here. The
working tree being clean does not help: the range scan reads every commit of the
pull request, which is the whole point of having it.

## What changed, and why it is narrower than it looks

`.gitleaksignore` already accepted a **line pinned by its own SHA-256**, in
`tree` mode. Two things were in the way of using the same mechanism for a range
finding, and both were mechanical rather than deliberate:

1. `parseIgnoreFile` read the pin out of the reason comment **only** for a tree
   entry, so a range entry could carry a correct `line-sha256` and still be
   refused for pinning nothing. Measured before the line existed.
2. `verifyEntry` checked a pin **only** for a tree entry.

Both now apply to either mode. The obligation a range entry carries is
**stricter**, not looser: `verifyDigestEntry` reads the line with
`git show <commit>:<path>`, so the pin is against the content **as it stood at
that commit**. A tree pin can be satisfied by editing the file. A range pin
cannot be satisfied at all except by history that is already written.

## What did not move

- **Only `generic-api-key` may ever be allowlisted.** Any other rule — a token,
  a private key — is refused regardless of fingerprint or reason.
- **The fingerprint is exact.** One commit, one path, one rule, one line. A
  wildcard anywhere in the line is a reported problem, so neither a pattern nor
  a whole path can be listed.
- **A reason comment stays mandatory**, and the pin lives inside it, so an entry
  without a justification is refused before its content is read.
- **The tree scan is untouched.** A range fingerprint has four fields and can
  never match a tree finding's `<path>:<rule>:<line>`.
- **`.gitleaks.toml`, `GITLEAKS_CONFIG` and `GITLEAKS_CONFIG_TOML` remain
  refused**, and inline `gitleaks:allow` comments remain refused. The exception
  is recorded in the one file the gate validates, not in configuration the gate
  cannot see.

## Evidence

Measured locally, against the two entries as written:

- both **accepted** — the pinned digest equals the SHA-256 of line 396 at each
  commit, `47d504318a05644336289d916ba8a4c5d8d062e8c8c191e28c8ce4a6b8694b84`;
- **wrong pin refused**, and the refusal reports the true digest;
- **another rule refused** on the same fingerprint;
- **wrong line refused** on the same commit and path;
- the **eleven pre-existing entries still verify**, so no earlier entry was
  loosened to make these two fit.

Not measured here, and owed to CI: the range scan itself, and the scanner's own
suites. Both need the gitleaks binary, which has no pinned build for this
platform — the suites report 43 cases skipped for that reason on this host,
independently of this change.
