---
name: update-openapi-generated-client
description: Refresh the generated OpenAPI TypeScript types and validate the SDK surface after Tilde API changes.
---

# Update OpenAPI Generated Client

Use this when `/root/tilde-api/openapi.cloud.json` or a worktree OpenAPI file changes.

## Process

1. Run `pnpm sync:openapi`.
2. Run `pnpm validate:openapi`.
3. Inspect generated type diffs.
4. Do not manually edit generated files.
5. Update hand-authored wrappers only when operation names or schema shapes changed.
6. Run `pnpm typecheck && pnpm test`.

## Rules

- Generated OpenAPI types stay internal.
- Do not document generated import paths.
- Public SDK names should remain concise: `createClient`, `createConfig`, `chatKitEndpoint`.
