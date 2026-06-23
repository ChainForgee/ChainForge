# Lighthouse CI

A scheduled GitHub Actions workflow audits the production build of the
frontend every day at **00:30 UTC** so accessibility and SEO regressions
surface long before any user notices.

> **Heads-up:** GitHub-hosted cron schedules are best-effort. A daily run
> can be delayed by 5–15 minutes during peak load or skipped entirely if
> the queue is full. The badge going stale on a Monday morning doesn't
> always mean a regression — trigger a manual run from the Actions tab
> (`workflow_dispatch`) when in doubt.

## How it works

`.github/workflows/lighthouse.yml` runs `pnpm build` and then
`pnpm lhci autorun`. Results are written to `./lhci-reports` in the
frontend directory and uploaded as a CI artifact named `lighthouse-reports`.

If the run fails, the workflow's status badge turns red, and your team
gets a standard "Scheduled workflow failed" email. We deliberately do
**not** auto-open GitHub issues for regressions, so the team can decide
when a finding is real rather than chasing flakiness.

## Assertions

`lighthouserc.json` is the single source of truth. As of this writing:

| Category         | Level | Threshold | Rationale                                         |
|------------------|-------|-----------|---------------------------------------------------|
| accessibility    | error | ≥ 0.90    | WCAG — non-negotiable for an aid-recipient form   |
| seo              | error | ≥ 0.90    | Public pages need to be indexable                 |
| best-practices   | warn  | ≥ 0.80    | Mostly about secure-context / no-vuln libraries   |
| performance      | warn  | ≥ 0.50    | Not gated to avoid blocking on flaky LCP swings   |
| pwa              | off   | n/a       | The app is not a PWA                              |

To tighten or relax any threshold, edit `lighthouserc.json` and open a PR.

## Audited routes

The full production Next.js app is audited on:

- `/` (root redirect → default locale)
- `/en/dashboard`
- `/en/help`
- `/en/verification-review`

Each URL is collected **twice** and the run uses the median, so a single
slow CI runner won't produce a noisy regression report.

## Reviewing a failed run

1. Open the **Actions** tab of the repository.
2. Pick the most recent `Lighthouse CI (Scheduled)` workflow run that failed.
3. Scroll to **Artifacts** and download `lighthouse-reports`.
4. Unzip and open any `lhr-*.html` in your browser — it has the full
   per-audit breakdown for each route.

## Running locally

You need a real Chrome / Chromium available on `PATH` (Lighthouse does
not run on Firefox). With Chrome installed:

```bash
cd app/frontend
pnpm build
pnpm lhci autorun
```

Open the resulting `./lhci-reports/manifest.json` link to inspect the
HTML report for any flagged route.
