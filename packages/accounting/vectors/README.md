# `acctfp/1` shared vectors

`acctfp-vectors.json` is the SINGLE source of truth for the canonical
fingerprint, used by both implementations:

- the TypeScript canonicalizer in `packages/accounting/src/fingerprint.ts`,
  exercised by `packages/accounting/test/fingerprint.test.ts`;
- the PostgreSQL canonicalizer added by `0045`, exercised by
  `tests/integration/accounting-fingerprint-parity.test.ts`, which reads
  **this same file**.

Directive §21 requires exactly that: one spec, two implementations, one vector
source. Nobody may hand-copy a vector into a second file — a duplicated vector
is a vector that will be updated in one place only, and the two implementations
would then agree with their own copies while disagreeing with each other.

Each case carries its inputs, the expected canonical byte stream as lowercase
hex, and the expected SHA-256. The byte stream is stored deliberately: a digest
alone tells you two implementations disagree, while the bytes tell you *where*.
It also lets a reviewer verify the spec by eye — `61 63 63 74 66 70 2f 31 0a`
is `acctfp/1\n`, `1f` is the field separator, `1e` terminates a line, and `00`
is the NULL dimension that must never be spelled as text.
