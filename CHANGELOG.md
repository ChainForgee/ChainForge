# Changelog

All notable changes to ChainForge are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows semantic versioning where possible.

## [Unreleased]

### Added

- Testnet deployment and observability runbooks for operators.
- Admin key policy guidance for testnet deployments.
- Merkle allowlist tooling for auditable aid recipient eligibility lists.
- Testnet smoke tooling for validating deployed service health.

### Changed

- Repository documentation now points contributors to service-specific setup
  guides for backend, frontend, mobile, AI service, and Soroban contracts.

### Security

- Contributor guidance emphasizes keeping secrets, private keys, and seed
  phrases out of commits and issue attachments.

## [1.0.0] - 2026-06-15

### Added

- Initial monorepo release for the ChainForge humanitarian aid platform.
- Soroban contract workspace for aid escrow logic under `app/onchain`.
- NestJS backend service with Prisma-backed persistence under `app/backend`.
- Next.js frontend dashboard under `app/frontend`.
- Expo mobile application for field operations under `app/mobile`.
- FastAPI AI service for verification workflows under `app/ai-service`.
- Documentation index in `README.md` covering architecture, setup, testing, and
  component-specific contribution entry points.

### Changed

- Declared root package metadata and workspace-level scripts for build, lint,
  and test orchestration.

### Fixed

- No fixes have been recorded for this release yet.

### Security

- No security advisories have been published for this release.

Release links can be added once the repository starts publishing Git tags or
GitHub releases.
