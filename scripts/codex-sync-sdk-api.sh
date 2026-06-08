#!/usr/bin/env bash
set -euo pipefail

cd /root/tilde-harness-sdk
pnpm sdk:refresh

codex "Using AGENTS.md and .agents/skills/expose-api-change/SKILL.md, inspect the refreshed OpenAPI diff and plan any SDK wrapper updates needed. Do not expose raw generated OpenAPI types as the public SDK."
