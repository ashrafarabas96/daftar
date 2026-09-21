# DAFTAR — Phase 1 RBAC Review / مراجعة الصلاحيات

## 1. Registry

- 38 permissions defined once in `packages/domain-core/src/permissions.ts` and re-exported by `@daftar/shared-contracts`; the web roles page and Android read the same list (no hand-copied strings).
- Sensitive permissions (`SENSITIVE_PERMISSIONS`) are the ones the delegation ceiling treats as owner-grade.
- System roles per business: `owner` (all permissions, system-managed), `manager`, `cashier`, plus custom roles behind the `CUSTOM_ROLES` feature.

## 2. Enforcement points

| Layer | Mechanism | Guard |
|---|---|---|
| Controller | `@RequiresPermission('x')` resolved against the union of the member's roles (multi-role union) | `team.test.ts` "union permissions" |
| Fine-grained | `member.branch_scope.manage`, `role.assign` distinct from `member.manage` | `role-crud.test.ts` |
| Database | System roles immutable by trigger; `daftar_app` cannot insert an owner grant or update a grant into the owner role | `owner-authority.test.ts`, `isolation.test.ts` |
| Delegation ceiling | Creating, updating, assigning or inviting with a role whose permissions exceed the actor's own is refused; owner exempt | `delegation-ceiling.test.ts`, `role-crud.test.ts` |
| Mass assignment | `is_system`, `key='owner'` cannot be set from the API | `isolation.test.ts` |
| Role deletion | `409 ROLE_IN_USE` without replacement; atomic reassignment with replacement | `role-crud.test.ts` |

## 3. Branch scope

- Modes `all` and `assigned`; `assigned` with zero branches is a legal "sees nothing" state.
- Every branch/warehouse list and write is filtered by scope; archived or foreign branches rejected on assignment; audited (`branch-scopes.test.ts`, 10 cases).
- Web team page edits `mode/branchIds` through the `BranchScopeUpdateDto` contract (golden 06).

## 4. Platform roles

- `platform_owner`, `support_agent` (and others in `platform_role_memberships`) are separate from business roles and only meaningful in the `platform-api` runtime.
- Bootstrap of the first `platform_owner` is a CLI under the platform principal with an advisory lock (`bootstrap-owner.test.ts`); grants afterwards are audited admin actions.

## 5. Findings

- None open. During the closure the permission list was moved to a single export so the web roles page could not drift from the API (golden 06 mechanically compares the client and the controllers).

**Verdict: PASS.**
