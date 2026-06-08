---
name: expose-api-change
description: Self-refresh loop for exposing intentional Tilde API changes through the SDK.
---

# Expose API Change

## Process

1. Run `pnpm sdk:refresh`.
2. Inspect OpenAPI operation and schema diffs.
3. Decide whether each changed operation belongs in the public SDK.
4. For supported changes, use `add-sdk-wrapper`.
5. Do not expose raw generated OpenAPI paths as the public SDK.
6. Run `pnpm lint && pnpm test`.
7. Summarize public API changes and migration notes.

## Defaults

- Prefer small, stable wrappers over broad generated clients.
- Use camelCase in TypeScript APIs.
- Preserve existing public names unless the user explicitly asks for a breaking change.
