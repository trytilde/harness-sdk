---
name: improve-codebase-architecture
description: Improve SDK architecture while preserving a small stable public interface.
---

# Improve Codebase Architecture

Look for:

- Repeated request-building logic that belongs in `internal/`.
- Public wrappers exposing too much generated shape.
- Missing tests around auth, paths, and errors.
- Naming drift from concise public helper style.

Avoid broad refactors unless they simplify public wrapper maintenance.
