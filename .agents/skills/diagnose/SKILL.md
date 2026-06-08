---
name: diagnose
description: Diagnose SDK bugs by reproducing, minimizing, instrumenting, fixing, and adding regression tests.
---

# Diagnose

## Loop

1. Reproduce the failure with `pnpm test` or a focused Vitest test.
2. Minimize the failing case.
3. Inspect public API expectations, generated OpenAPI shapes, and request construction.
4. Fix the smallest relevant surface.
5. Add or update a regression test.
6. Run `pnpm typecheck && pnpm test`.

Prefer explaining the observed failure over guessing.
