# tilde-harness-sdk

TypeScript SDK monorepo for Tilde Harness APIs.

## Rules

- Use `pnpm`.
- Public packages are `@tilde/harness-sdk` and `@tilde/harness-sdk-vercel`.
- Public helper names should be concise: `createClient`, `createConfig`, `chatKitEndpoint`.
- Do not add public names like `createTildeClient`, `createTildeConfig`, or `createTildeVercelAiSdkHandler`.
- Generated OpenAPI files must not be manually edited.
- Raw generated OpenAPI types are internal implementation details, not the supported SDK surface.
- Expose API features through hand-authored wrappers in `packages/core/src`.
- Run `pnpm sync:openapi` after Tilde API changes.
- Run `pnpm validate:openapi`, `pnpm typecheck`, and `pnpm test` before finishing SDK changes.
- Add tests for config, auth headers, URL construction, wrapper request paths, API errors, and webhook verification.

## OpenAPI

The canonical source defaults to `/root/tilde-api/openapi.cloud.json`.
Override with `TILDE_OPENAPI_PATH` when testing a worktree:

```bash
TILDE_OPENAPI_PATH=/root/.t3/worktrees/tilde-api/<branch>/openapi.cloud.json pnpm sync:openapi
```

Generated output:

```text
specs/openapi.cloud.json
packages/core/src/generated/schema.d.ts
```

Do not import `packages/core/src/generated/schema.d.ts` from examples or app code.

## Checks

```bash
pnpm sdk:refresh
pnpm lint
```

## Skills

Use `.agents/skills/update-openapi-generated-client/SKILL.md` when the Tilde API spec changes.
Use `.agents/skills/add-sdk-wrapper/SKILL.md` when exposing a new operation.
Use `.agents/skills/expose-api-change/SKILL.md` for the Codex self-refresh loop.
