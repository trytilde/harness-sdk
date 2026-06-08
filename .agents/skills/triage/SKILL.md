---
name: triage
description: Triage SDK feature requests and bugs into actionable states.
---

# Triage

Classify each request:

- Bug: observable SDK behavior is wrong.
- Wrapper request: an OpenAPI operation needs a stable public helper.
- Spec drift: generated types changed and wrappers need review.
- Docs: README or examples are unclear.

For each item, identify the package, public API, tests, and whether OpenAPI validation must change.
