---
name: tdd
description: Test-driven development for SDK features and fixes using Vitest and public interfaces.
---

# Test-Driven Development

Write behavior tests through public SDK APIs, then implement the smallest wrapper or helper needed.

## Workflow

1. Pick one observable behavior.
2. Add one failing Vitest test.
3. Implement the minimum code to pass.
4. Repeat for the next behavior.
5. Refactor only after tests pass.

## Rules

- Test public imports from `src/index.ts` when possible.
- Avoid tests that only verify DTO construction.
- Mock `fetch` at the boundary; do not mock internal wrapper methods.
- Run `pnpm typecheck && pnpm test`.
