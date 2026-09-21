# DAFTAR — Phase 1 Design Review (Review C) / مراجعة التصميم والتجربة

> Lens: UX, visual quality, design-system compliance, localization. Verdict at the end.

## 1. Design system (`@daftar/design-system`)

- Tokens: `colors`, `typography`, `spacing`, `radius`, `elevation`, `motion`, `breakpoints`, `zIndex`, `TOUCH_TARGET`, logical (start/end) helpers and `dirOf` for RTL.
- 34 components in five families: buttons (`Button`, `IconButton`), fields (`TextField`, `PasswordField`, `SearchField`, `Textarea`, `Select`, `Combobox`, `Checkbox`, `RadioCard`, `Switch`), layout (`Card`, `Badge`, `Tabs`, `Table`, `List`, `Pagination`, `Breadcrumb`, `Dropdown`), overlays (`Dialog`, `ConfirmationDialog`, `Drawer`, `BottomSheet`, `ToastRegion`, `Tooltip`), feedback (`Spinner`, `Skeleton`, `EmptyState`, `ErrorState`, `OfflineState`, `PermissionDeniedState`, `FeatureLockedState`, `PlanLimitState`).
- `DaftarProvider` sets locale and direction once; every page renders inside it (`apps/web/src/app/[locale]/layout.tsx`).
- Rule enforced by golden 05: web/admin never import server-only or database code; UI imports tokens/components, never raw hex or pixel values in new pages (spot-checked on the 8 pages added in the closure).

## 2. Merchant web (16 pages)

| Page | States covered |
|---|---|
| login / register / forgot / reset | loading, validation, generic error (no user enumeration), success redirect |
| onboarding | slug suggestion, slug taken with alternatives, idempotent submit |
| dashboard | business context, quick links |
| catalog (products / categories) | empty state, pagination, create with variants, category creation, feature/limit states |
| catalog/[id] | translations ar/en/tr, price, identifiers, category, variants table, media upload with signed previews, archive, optimistic version conflict |
| structure | branches/warehouses, `FeatureLockedState` (MULTI_BRANCH), `PlanLimitState` (MAX_BRANCHES) |
| roles | permission matrix from the shared registry, system roles read-only, delegation errors surfaced |
| team | roles editor, branch-scope editor (`all`/`assigned` + set), suspend/reactivate, remove with `ConfirmationDialog`, pending invitations |
| invitations/accept | signed-in accept or register+join, invalid/expired token messages |
| businesses/new | second business in the same tenant |
| plan | state, trial end, limits with usage, features |
| settings | locales, storefront slug, timezone |
| security | sessions, logout-all |

Every mutation shows a pending state on the button, disables double submit and maps API error codes to translated messages (`error.*` keys).

## 3. Localization (§58–61)

- Merchant web: 187 keys × ar/en/tr, checked by `npm run check:localization` (missing key in any locale fails CI). RTL for Arabic through `dir` on `<html>` and logical spacing tokens.
- Android: 57 string resources × `values`, `values-ar`, `values-tr`; Compose layouts use start/end padding; resource completeness verified by key count and Gradle lint.
- **Admin console: English-only by decision.** Rationale: it is an internal platform-staff tool (`platform-api` runtime), its users are the operator's own staff, and translating operational/audit vocabulary without a glossary would create inconsistent Arabic terms in audit trails. The decision is recorded here and in `TECHNICAL_DEBT.md`; the console's layout already receives its strings through one `text()` helper per page so a locale switch is a Phase 2+ task, not a rewrite.
- Glossary compliance: new keys follow `DAFTAR_LOCALIZATION_GLOSSARY.md` (e.g. "فرع" for branch, "مستودع" for warehouse, "دور" for role).

## 4. Responsiveness and accessibility

- Layouts are fluid (flex with wrap, no fixed pixel widths in the pages added during the closure); touch targets use the `TOUCH_TARGET` token (44 px). No rendered viewport audit (phone/tablet) was executed at closure; the responsive claim rests on the source review of the layouts and is recorded as TD-06 in `TECHNICAL_DEBT.md`.
- Form controls carry labels and `aria-invalid`/`aria-describedby` from the field components; dialogs move focus into the dialog on open; colour contrast of the token palette meets WCAG AA for text.
- Security headers (CSP without inline scripts) are compatible with the design system (inline styles only, per ADR-001).

## 5. Findings

| # | Finding | Resolution |
|---|---|---|
| D-1 | Invitation accept page used `useSearchParams` without Suspense (Next 15 prerender error) | Wrapped in Suspense (`8d0eff5`) |
| D-2 | `<img>` for signed previews (Next image optimizer cannot fetch private signed URLs) | Kept `<img>` deliberately; documented here |
| D-3 | Admin not localized | Documented decision (§3) |

**Verdict (Review C): PASS.**
