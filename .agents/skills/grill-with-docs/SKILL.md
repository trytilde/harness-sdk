---
name: grill-with-docs
description: Stress-test SDK plans against AGENTS.md, README examples, and public API naming rules.
---

# Grill With Docs

Use this before broad SDK API changes.

## Process

1. Read `AGENTS.md` and relevant README examples.
2. Check whether proposed names match `createClient`, `createConfig`, and `chatKitEndpoint` style.
3. Challenge whether the raw generated OpenAPI client is leaking into public docs.
4. Identify any breaking changes.
5. Update docs only when the public API decision is settled.
