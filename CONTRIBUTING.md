# Contributing to ChainForge

Thank you for contributing to ChainForge! This document provides an overview of how to contribute to the project.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Module-Specific Guides](#module-specific-guides)
- [Pull Request Process](#pull-request-process)
- [Community](#community)

---

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code. Please be respectful, inclusive, and constructive in all interactions.

---

## Getting Started

### Prerequisites

- Node.js 18+
- pnpm 9.x
- Python 3.11+ (for AI service)
- Rust toolchain with Soroban CLI (for smart contracts)
- Docker (optional, for containerized development)

### Fork and Clone

```bash
git clone https://github.com/YOUR_USERNAME/ChainForge.git
cd ChainForge
```

### Install Dependencies

From the repository root:

```bash
pnpm install
```

---

## Development Workflow

### 1. Create a Branch

Always work on a branch, never directly on `main`:

```bash
git checkout -b feature/your-feature-name
```

Branch naming conventions:
- `feature/*` — New features
- `fix/*` — Bug fixes
- `chore/*` — Tooling and documentation

### 2. Make Your Changes

- Follow the coding conventions in each module's contributing guide
- Add or update tests as needed
- Update documentation if you change APIs or add features
- Ensure no secrets, keys, or seed phrases are committed

### 3. Commit Your Changes

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```bash
git add .
git commit -m "feat(frontend): add campaign creation dialog"
```

### 4. Push and Open a PR

```bash
git push origin feature/your-feature-name
```

---

## Module-Specific Guides

Each service in the `app/` directory has its own contributing guide with detailed instructions:

| Service | Guide | Description |
|---|---|---|
| Smart Contracts | [app/onchain/CONTRIBUTING.md](app/onchain/CONTRIBUTING.md) | Rust + Soroban contracts |
| Backend | [app/backend/CONTRIBUTING.md](app/backend/CONTRIBUTING.md) | NestJS API server |
| Frontend | [app/frontend/CONTRIBUTING.md](app/frontend/CONTRIBUTING.md) | Next.js admin dashboard |
| Mobile | [app/mobile/CONTRIBUTING.md](app/mobile/CONTRIBUTING.md) | Expo React Native app |

Before contributing to a specific module, read its contributing guide for setup instructions and validation requirements.

---

## Pull Request Process

### Before Opening a PR

- [ ] Branch is up-to-date with `main`
- [ ] All validation checks pass locally
- [ ] New features include tests where applicable
- [ ] Documentation updated

### PR Description

Include in your PR description:

- **What changed** — Brief summary of the change and why it's needed
- **How to run** — Setup steps if different from standard workflow
- **Test logs** — Output from local test runs
- **Closes** — Reference to any related issue (`Closes #92`)

---

## Community

- **Questions:** Open a [GitHub Discussion](https://github.com/ChainForge/ChainForge/discussions)
- **Bugs:** Open a [GitHub Issue](https://github.com/ChainForge/ChainForge/issues)
- **Documentation:** Check the root [README.md](README.md) first

---

Thank you for contributing to making humanitarian aid delivery more transparent and efficient!