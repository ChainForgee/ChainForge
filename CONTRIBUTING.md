# Contributing to ChainForge

Thank you for helping improve ChainForge. This guide describes the repository-wide contribution path. Service-specific setup and coding conventions live in each `app/` subdirectory.

## Contribution ladder

| Role | Typical scope | Responsibilities | How to progress |
|---|---|---|---|
| Contributor | Issues, documentation, tests, small fixes | Follow the PR checklist, keep changes focused, and respond to review feedback | Land several focused PRs that follow project conventions |
| Reviewer | Code review and triage in familiar areas | Review PRs for correctness, tests, security, and maintainability | Provide consistent, constructive reviews and help newer contributors |
| Maintainer | Ownership of one or more services or workflows | Triage issues, approve PRs, guide roadmap work, and keep CI healthy | Demonstrate sustained ownership and project judgment |
| Core Maintainer | Cross-project governance and releases | Resolve cross-service decisions, coordinate releases, and steward project direction | Be nominated by existing core maintainers after sustained maintainer work |

Role changes are based on demonstrated trust, project knowledge, and respectful collaboration rather than a fixed number of commits.

## Development workflow

1. Open or comment on an issue before starting larger changes.
2. Fork the repository and create a focused branch.
3. Follow the setup instructions for the affected service.
4. Add or update tests when behavior changes.
5. Update documentation when APIs, configuration, workflows, or user-facing behavior changes.
6. Open a pull request that links the issue and summarizes testing.

## Pull request checklist

- The PR addresses one clear concern.
- Tests, linting, or a documented manual check were run.
- New configuration is documented with safe example values.
- Secrets, keys, wallets, seed phrases, and private data are not committed.
- Security-sensitive or on-chain changes include enough context for careful review.

## Review expectations

Reviewers should focus on correctness, security, reliability, and maintainability. Prefer clear, actionable feedback. Contributors should respond to requested changes or explain tradeoffs when a suggestion cannot be applied.

## Getting help

Use the issue thread or pull request discussion for project-specific questions. For service setup, start with the README in the affected `app/` directory.
