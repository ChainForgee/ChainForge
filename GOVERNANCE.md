# Governance

ChainForge uses lightweight, maintainer-led governance. The goal is to keep decisions transparent while allowing small, well-scoped contributions to move quickly.

## Decision model

| Decision type | Owner | Process |
|---|---|---|
| Small fixes and documentation | Area maintainer or reviewer | Normal pull request review |
| Service-level feature work | Area maintainer | Issue discussion followed by pull request review |
| Cross-service architecture | Maintainers for affected services | Design discussion in an issue before implementation |
| Security-sensitive changes | Core maintainers and affected area maintainers | Private disclosure when needed, followed by coordinated fix and public notes |
| Releases and roadmap priorities | Core maintainers | Consensus after reviewing project impact and maintenance cost |

Consensus means maintainers have had a fair chance to review and no unresolved blocking concerns remain. If consensus is not reached, core maintainers make the final call and document the reasoning.

## Maintainer responsibilities

- Keep issue and pull request triage moving.
- Ask for tests or documentation when a change affects behavior or operations.
- Be explicit about security, privacy, and on-chain risk.
- Help contributors understand project conventions.
- Avoid merging changes that introduce secrets or unsafe defaults.

## Contributor recognition

Maintainers may nominate contributors for reviewer or maintainer roles after repeated, high-quality contributions. Nominations should consider code quality, review quality, communication, and reliability across more than one contribution.

## Conflict resolution

When discussion stalls, maintainers should restate the open decision, list the tradeoffs, and invite final comments. Core maintainers can then decide, with a short note explaining why the chosen direction best serves ChainForge users and maintainers.
