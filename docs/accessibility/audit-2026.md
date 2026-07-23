# Frontend Accessibility Audit — WCAG 2.2 AA (2026)

- **Date:** 2026-07-17
- **Issue:** #293 — Accessibility audit: WCAG 2.2 AA cross-cutting fixes
- **Target:** WCAG 2.2 Level AA
- **Scope:** `app/frontend` pages `/` (home), `/campaigns`, `/claim-receipt`, plus cross-cutting concerns (root layout, Navbar)
- **Methodology:** automated axe-core scan via jest-axe in jsdom (`app/frontend/test/accessibility.spec.tsx`, enforced in CI by `.github/workflows/frontend-ci.yml`) plus manual code review of the page sources.

## Limits of the automated scan

jest-axe runs in jsdom, which has **no layout engine**. The following cannot be
verified automatically here and need a browser-based pass (see ticket backlog):

- **Color contrast (1.4.3)** — the `color-contrast` rule is explicitly disabled in the jest suite.
- **Focus visibility (2.4.7 / 2.4.11)** — requires rendered focus styles.
- **Reflow / zoom (1.4.10)** — requires real viewport rendering.
- **Target size (2.5.8, new in WCAG 2.2)** — requires computed element geometry.
- Real assistive-technology behavior (screen reader announcement order, etc.).

## Scope notes

- The issue names `/claims/[id]`, but **that route does not exist** in the
  frontend. The closest page is `/[locale]/claim-receipt?claimId=…` (client
  component, currently rendering mock data). This audit covers `/claim-receipt`
  in its place (maintainer-confirmed). Creating a real `/claims/[id]` route with
  API wiring is listed as a ticket below.
- Locale routing (`/[locale]/`, en/es/fr/fr-CA/pt-BR/sw via next-intl) exists,
  but the audited pages render **hardcoded English copy** and do not call
  translation hooks.
  Related: the root layout hardcodes `<html lang="en">` for every locale.

## Per-page results

Legend: **Pass** · **Fail** · **Fixed** (in this PR) · **Manual** (needs browser/AT check)

### `/` (home) — `src/app/[locale]/page.tsx`, `src/components/AidPackageList.tsx`

| Criterion | Result | Notes |
|---|---|---|
| 1.3.1 Info and Relationships (heading order) | **Fixed** | h1 → h3 skips: feature cards and "Available Aid Packages" were `<h3>` directly under the page `<h1>`; package card titles were `<h4>`. Changed to `<h2>`/`<h3>` (Tailwind classes unchanged, no visual shift). |
| 1.1.1 Non-text Content | Pass | No informative images; status badges are text. |
| 2.4.4 Link Purpose | Pass | "Get Started" link text is descriptive. |
| 2.1.1 Keyboard | Fail | "Learn More" button is focusable but has no handler — it does nothing for any user (functional bug with a11y impact; ticket). |
| 1.4.3 Contrast | Manual | Not verifiable in jsdom. |
| 4.1.2 Name, Role, Value | Pass | Native elements throughout. |

### `/campaigns` — `src/app/[locale]/campaigns/page.tsx`

| Criterion | Result | Notes |
|---|---|---|
| 1.3.1 Landmarks (`region` best practice) | **Fixed** | "Access Denied" branch rendered outside any landmark; now wrapped in `<main>`. The NGO branch already had `<main>`. |
| 4.1.3 Status Messages | **Fixed** | Form feedback (`formMessage`) now renders `role="status"` for success and `role="alert"` for errors, so screen readers announce it without focus moves. |
| 1.3.1 / 3.3.2 Labels | Pass | All four form inputs are wrapped in `<label>` with visible text. |
| 1.3.5 Input Purpose | Pass | No personal-data fields on this form. |
| 2.4.6 Headings and Labels | Pass | h1 → h2 → h3 hierarchy is correct. |
| 2.4.7 Focus Visible | Manual/Fail | Form inputs use `focus:outline-none` but add `focus:ring-2` (likely OK — verify in browser). `ExportControls`' format selector uses `focus:outline-none` with **no** replacement indicator (ticket). |
| 4.1.3 Status Messages (list states) | Fail | "Loading campaigns..." / fetch-error messages are plain `<p>` with no live region (ticket; kept out of this PR to stay minimal). |
| 1.4.3 Contrast | Manual | Not verifiable in jsdom. |

### `/claim-receipt` — `src/app/[locale]/claim-receipt/page.tsx`, `src/components/ClaimReceipt.tsx`

| Criterion | Result | Notes |
|---|---|---|
| 4.1.3 Status Messages (loading) | **Fixed** | Loading block now has `role="status"`; spinner icon is `aria-hidden`. |
| 4.1.3 Status Messages (error) | **Fixed** | Error block now has `role="alert"`; alert icon is `aria-hidden`. |
| 1.1.1 Non-text Content | **Fixed** | Decorative `←` glyph in the back button is now `aria-hidden` (accessible name is just "Back"). |
| 2.4.6 Headings and Labels | Pass | h1 → h2 → h3 hierarchy is correct. |
| 4.1.2 Name, Role, Value | Pass | Share/Copy/Download buttons have visible text alongside icons. |
| 2.4.4 Link Purpose | Pass | Explorer links use the address/hash as link text. |
| 1.4.3 Contrast | Manual | Opacity-based text (`opacity-75` labels) is a likely contrast risk — check in browser pass. |

### Cross-cutting — `src/app/layout.tsx`, `src/components/Navbar.tsx`

| Criterion | Result | Notes |
|---|---|---|
| 3.1.1 Language of Page | Fail | `<html lang="en">` is hardcoded for all locales (en/es/fr). Should derive from the active locale (ticket). |
| 2.4.1 Bypass Blocks | Fail | No skip-to-content link before the Navbar (ticket). |
| 1.4.10 Reflow, 1.4.4 Resize Text | Manual | Needs browser pass. |
| 2.5.8 Target Size (WCAG 2.2) | Manual | Needs browser pass; small icon buttons (e.g. ExportControls) are candidates. |
| 1.4.13 Content on Hover/Focus | Manual | Toasts/dropdowns need browser verification. |

## Automated coverage (what CI enforces)

`app/frontend/test/accessibility.spec.tsx` (runs via `frontend-ci.yml` on every
frontend PR) renders and scans with axe-core defaults (WCAG A/AA rules + axe
best practices), asserting **zero violations** for:

1. `/` (home, packages loaded)
2. `/campaigns` as `ngo` role (form + campaign list)
3. `/campaigns` as `guest` role (Access Denied branch)
4. `/claim-receipt?claimId=…` (loaded receipt)
5. `/claim-receipt` without `claimId` (error state)

Exclusions: `color-contrast` rule disabled (jsdom limitation, see above). Data
hooks (`useAidPackages`, `useCampaigns`, campaign mutations) and
`next/navigation` are mocked with deterministic fixtures.

The test file is `.tsx` (the issue says `.ts`) because it renders JSX.

## Issues to become tickets

| # | Title | WCAG | Severity | Affected files |
|---|---|---|---|---|
| 1 | Add skip-to-content link before the Navbar | 2.4.1 (A) | High | `src/app/layout.tsx`, `src/components/Navbar.tsx` |
| 2 | Set `<html lang>` from the active locale instead of hardcoded `en` | 3.1.1 (A) | High | `src/app/layout.tsx` |
| 3 | Browser-based a11y pass: contrast, focus visibility, reflow, target size (Playwright + axe) | 1.4.3, 2.4.7, 1.4.10, 2.5.8 (AA) | High | all pages |
| 4 | Wire up or remove the non-functional "Learn More" button on home | 2.1.1 (A) | Medium | `src/app/[locale]/page.tsx` |
| 5 | Create a real `/claims/[id]` route backed by the claims API (replaces mock-data `/claim-receipt`) | — | Medium | new route, `src/hooks/` |
| 6 | Add live regions to campaigns list loading/error states | 4.1.3 (AA) | Medium | `src/app/[locale]/campaigns/page.tsx` |
| 7 | Give ExportControls' format selector a visible focus indicator | 2.4.7 (AA) | Medium | `src/components/dashboard/ExportControls.tsx` |
| 8 | Extend axe test coverage to `/dashboard`, `/help`, `/verification-review` | — | Medium | `test/accessibility.spec.tsx` |
| 9 | Fix pre-existing frontend lint errors and make the CI lint step blocking | — | Low | `frontend-ci.yml`, various |
