---
name: pre-commit-checks
description: Run the required SDK checks before publishing or committing changes.
---

# Pre-Commit Checks

Run:

```bash
pnpm validate:openapi
pnpm typecheck
pnpm test
pnpm lint
```

If OpenAPI changed, run `pnpm sync:openapi` first.

Do not commit generated type changes without the matching copied spec in `specs/openapi.cloud.json`.
