---
name: to-issues
description: Break an SDK plan into independently implementable vertical slices.
---

# To Issues

Create thin SDK slices that are independently testable.

Each issue should include:

- Public API being added or changed
- OpenAPI operation dependency, if any
- Tests required
- README update required or not
- Acceptance criteria

Prefer slices such as "Expose MCP server creation wrapper" over horizontal tasks like "write all types".
