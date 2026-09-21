# ADR-010 — Module System Strategy (CommonJS/ESM)

**Status:** Accepted — Phase 1 (Recovery Directive §13)
**Date:** 2026-09-19

## Context

The monorepo mixes NestJS (API), Next.js (web), Vitest (tests), and shared
packages. Mixing module systems casually caused interop failures in earlier
work (esbuild/vitest not emitting decorator metadata being the most expensive
example). One documented, maintainable strategy is required.

## Decision

| Consumer | Module system | Why |
|---|---|---|
| `packages/domain-core`, `packages/shared-contracts` | **CommonJS** (`"type": "commonjs"`, compiled by `tsc` to `dist/`) | NestJS runtime is CommonJS-first; both Node and bundlers consume CJS safely. |
| `apps/api` | **CommonJS** via NestJS build | Matches NestJS 11 defaults; `pg`, `argon2`, `pino` all CJS-friendly. |
| `apps/web` | **ESM** (Next.js 15 bundler resolution) | Next.js owns its pipeline; imports shared packages via `transpilePackages`. |
| Tests (`tests/**`, package tests) | Vitest with `tsx`/esbuild transform | Executes TS directly; consumes built `dist/` of shared packages through workspace links. |
| `apps/android` | Kotlin/Gradle — outside npm entirely | Not an npm workspace; builds with its own toolchain. |

## Rules

1. Shared packages ship compiled `dist/` with `.d.ts`; consumers never import
   TypeScript sources across package boundaries except Next.js via
   `transpilePackages`.
2. No `"type": "module"` in shared packages — avoids dual-package hazards.
3. Decorator-dependent NestJS classes always declare explicit
   `@Inject(token)` on constructor parameters: esbuild/vitest/tsx do not emit
   decorator metadata, and `emitDecoratorMetadata` output is not available in
   the test path. This is a load-bearing rule, not a style choice.
4. ESLint flat config (`eslint.config.mjs`) is the single lint entry — it is
   config-as-ESM, which Node 24 loads natively; this does not change the
   module type of any shipped package.

## Consequences

- One mental model: CJS inside the server/packages, ESM inside Next.js,
  Vitest bridges them.
- No dual-package publishing, no ESM shim layers.
- The explicit-`@Inject` rule is enforced by API tests (DI fails loudly
  otherwise).
