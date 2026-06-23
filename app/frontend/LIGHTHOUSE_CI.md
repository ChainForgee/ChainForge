# Lighthouse CI (optional, not gated in CI)

The `lighthouserc.json` in this directory configures [Lighthouse CI][lighthouse-ci]
to perform an accessibility audit of the production build.

## When does it run?

It is **not** executed by `.github/workflows/frontend-ci.yml` because
Lighthouse needs a live, fully-rendered page (the static `jest-axe` unit
tests already catch the same class of violations faster and with zero
infrastructure overhead).

Use this configuration:

- During code review, when changing navigation, theming, or layout.
- Locally before tagging a release: `pnpm dlx @lhci/cli autorun`.
- In a separate, opt-in workflow when accessibility is the focus of the
  story being shipped.

[lighthouse-ci]: https://github.com/GoogleChrome/lighthouse-ci
