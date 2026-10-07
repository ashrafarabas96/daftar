import { z } from 'zod';
import { searchQueryParam } from '../inventory/read-scope';

/**
 * THE POS READ REQUESTS (P4-S3) — the query schemas of the till's reads.
 *
 * Separate from `pos.schemas.ts`, which holds the till-session COMMANDS: a
 * command's body and a read's query string are different contracts with
 * different owners, and one file holding both would make every slice that
 * touches either one edit the same file.
 *
 * `.strict()`, the accepted P3-S4 / P4-S1 shape, and for the same reason the
 * command schemas are: the client sends IDENTITIES and nothing else is
 * believed. On a READ the strictness earns its place twice over — a POS
 * client that sent `price=0`, or `unitPriceMinor=1`, and had it silently
 * dropped would believe it had asked the server for something the server
 * never did, and would render whatever came back as the answer to its own
 * question.
 *
 * What is refused here because the field's mere presence is the defect:
 *
 * - **`tenantId` / `businessId`.** Scope is resolved from the membership and
 *   enforced by RLS (`P4-AL-40`); a request carrying its own scope is a
 *   request asking to choose it.
 * - **`warehouseId`.** REFUSED as of the P4-S3 coordinator's RULING 2, and
 *   this one is worth stating because it used to be accepted. The till's
 *   warehouse is a FACT OF THE SESSION: `pos_till_sessions.warehouse_id` is
 *   `NOT NULL`, it is immutable after the session opens
 *   (`pos_till_session_guard()` refuses a change with
 *   `pos.till_session_immutable`), and it carries a composite foreign key into
 *   `warehouses (business_id, id)`. A client that could name the warehouse
 *   could name a warehouse its own open till does not sell from, which is
 *   `P4-AL-18` exactly: the client would be the source of truth for the scope
 *   of its own read. So the request names the SESSION and the server derives
 *   the warehouse.
 * - **`cursor`, `page`, `offset`.** There is no page two. `OFFSET` is
 *   forbidden to every read module (G-6), a keyset cursor over a UNION of five
 *   independent index ranges would need one position per arm and would still
 *   reorder under a catalogue edit between keystrokes, and a type-ahead is
 *   narrowed by typing one more character rather than by walking pages. The
 *   read says `moreMatches` instead, which is an answer a cashier can act on.
 * - **any price, total or tax field.** `P4-AL-18`: the client sends
 *   identities, quantities and a discount request, and nothing else is
 *   believed. A read that accepted a price would be accepting one.
 */

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'must be a canonical lowercase uuid');

/** The cap P4-A measures at, and the ceiling the route accepts. */
export const POS_SEARCH_MAX_LIMIT = 50;
export const POS_SEARCH_DEFAULT_LIMIT = 20;

/** `limit` as query text: 1..50. */
const limit = z
  .string()
  .regex(/^\d{1,2}$/, `a limit is 1..${POS_SEARCH_MAX_LIMIT}`)
  .transform((s) => Number.parseInt(s, 10))
  .pipe(z.number().int().min(1).max(POS_SEARCH_MAX_LIMIT));

/**
 * `GET /v1/pos/products` — the till SESSION and the typed prefix.
 *
 * `sessionId` and not `warehouseId`: the warehouse is derived from the
 * session, which is the only party entitled to say which warehouse this till
 * sells from (RULING 2; see the refusal list above).
 *
 * `q` reuses `searchQueryParam`, the P3-S7 parameter: it trims, bounds the
 * length to 1..100 and refuses a NUL. PostgreSQL rejects a NUL in text with
 * SQLSTATE 22021, which would otherwise surface as a 500 rather than as a
 * validation refusal (P3-S7 review finding L-2).
 *
 * `q` is REQUIRED. A type-ahead with no prefix means "list the whole
 * catalogue", which is the stock page's job (`GET /v1/inventory/stock`) and
 * not this read's — and answering it here would be the one shape of this query
 * that no index can serve.
 */
export const PosProductSearchQuerySchema = z
  .object({
    sessionId: uuid,
    q: searchQueryParam,
    limit: limit.optional(),
  })
  .strict();

export type PosProductSearchQuery = z.infer<typeof PosProductSearchQuerySchema>;
