/**
 * The ports the posting engine needs to execute a post.
 *
 * §11 draws the line: this package owns the posting contract, the money and FX
 * arithmetic, the canonical fingerprint and the typed errors. It owns no
 * transport, no Nest wiring, no configuration and no environment. Everything
 * it cannot do itself is expressed here as an interface that `apps/api`
 * implements — which is what keeps the engine framework-agnostic and lets a
 * future domain slice reuse it without importing a web framework.
 *
 * Note what is NOT a port. There is no "authorization port" and no
 * `skipAuthorization` switch: authority arrives as a minted assertion or the
 * post does not happen (§53). A seam that could be handed `true` would become
 * a permanent bypass the moment a later slice found it convenient.
 */
import type { AccountingAssertionClaims } from './assertion';
import type { PostingCommand, PostingResult } from './types';

/**
 * Mints an accounting assertion for already-authorized claims.
 *
 * The implementation holds the signing key. It is deliberately a port rather
 * than a direct dependency so the engine never touches key material and the
 * platform and worker processes, which must not hold the key at all (§19),
 * cannot accidentally acquire minting ability by importing this package.
 */
export interface AccountingAssertionMinter {
  mint(claims: AccountingAssertionClaims): string;
}

/** One call of the database posting primitive, inside one transaction. */
export interface PostEntryRequest {
  /** The minted assertion, presented to the database as-is. */
  readonly assertion: string;
  /** The ACTUAL payload. The database recomputes its fingerprint from this (§27). */
  readonly command: PostingCommand;
}

/**
 * Executes `accounting_post_entry`.
 *
 * The adapter's only permitted journal interaction is CALLING this primitive.
 * It must never issue INSERT/UPDATE/DELETE against `journal_entries`,
 * `journal_lines` or `accounting_source_bindings` — guard G-4 fails CI if it
 * ever does (§67).
 */
export interface AccountingPostingPort {
  postEntry(request: PostEntryRequest): Promise<PostingResult>;
}

/** Injectable clock, so date-boundary behaviour is testable without waiting. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
