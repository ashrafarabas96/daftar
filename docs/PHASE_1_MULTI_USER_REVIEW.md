# DAFTAR — Phase 1 Multi-User Review / مراجعة تعدّد المستخدمين

> Scope: one identity, many tenants and businesses; many members per business; invitations; concurrent actors. Every property has a guard test.

## 1. Model

- **Identity** (`users`, `sessions`, `refresh_token_lineage`, `password_reset_tokens`) lives behind the `daftar_identity` principal; merchant code cannot read it (`db-privileges.test.ts`).
- **Tenant** owns businesses; a user is `tenant_owner` through `tenant_memberships`. A user may own several tenants and be a member of businesses in others (`tenant-memberships.test.ts`).
- **Membership** per business with status `active | suspended | removed` (never deleted), a set of roles (`membership_roles`) and a branch scope (`all` or `assigned` + `member_branch_scopes`).
- **Current business** is selected per request through `X-Business-Id`; the resolver principal maps user → membership → tenant and sets the RLS context inside the transaction.

## 2. Flows verified

| Flow | Behaviour | Guard |
|---|---|---|
| Register → onboard | One atomic provisioning transaction creates tenant, business, default branch, owner membership, entitlement; `Idempotency-Key` replays return the same business | `onboarding.test.ts` (16 cases) |
| Create second business | Same tenant, new business, key scoped to the target tenant | `onboarding.test.ts` |
| Switch business | `GET /v1/businesses/mine` + `X-Business-Id`; membership revoked mid-session denies the next request | `isolation.test.ts`, web AppHeader switcher |
| Invite by email | Pending invitation + encrypted credential enqueued in the request tx; worker delivers; expired invitations swept before invite/list/resend/accept; resend of expired rejected | `invitation-lifecycle.test.ts`, `team.test.ts` |
| Accept (existing user) | Actor email must equal the invitation email inside the SECURITY DEFINER command; double accept → one 200 / one 404 | `provisioner-boundary.test.ts`, `concurrency-matrix.test.ts` |
| Accept (new user) | Register + join in one step, invited role only | `invitation-lifecycle.test.ts`, golden 06 |
| Direct add | Converts a pending reservation without double quota | `invitation-lifecycle.test.ts` |
| Suspend / reactivate | Immediate access loss; reactivate re-checks `MAX_USERS` | `team.test.ts` |
| Remove | Status `removed`, effective roles and scopes deleted, audit carries the removed role keys; re-add starts clean | `membership-lifecycle.test.ts` |
| Role change vs removal race | Removal always wins; a removed member never keeps roles | `concurrency-matrix.test.ts` |
| Last owner | Removal, demotion, suspension of the last owner rejected; two concurrent removals → exactly one succeeds | `isolation.test.ts`, `owner-authority.test.ts` |
| Ownership transfer | Successor promoted and predecessor demoted in one transaction | `owner-authority.test.ts` |
| Quota under race | `MAX_USERS` with one slot and two concurrent invitations → exactly one | `quota-race.test.ts` |

## 3. Surfaces

- **Web**: team page (roles, branch-scope editor, suspend/reactivate/remove with confirmation), invitation accept page (sign-in or register+join), business switcher and create-business page.
- **Android**: team screen (member list with status and roles — read-only in Phase 1), business switch on Home.
- **Admin**: tenants and businesses views show members and subscription state; support sessions grant time-boxed read access per tenant.

## 4. Findings

None open. One defect found and fixed during the closure: concurrent last-owner operations could deadlock (40P01 → 500); fixed by a business-level advisory lock taken before row locks (`0c60b54`), guarded by the concurrent demotion/removal tests.

**Verdict: PASS.**
