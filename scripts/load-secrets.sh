#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
secrets_file="$repo_root/secrets.yaml"
env_e2e="$repo_root/.env.secrets.e2e"

if [[ ! -f "$secrets_file" ]]; then
	echo "Error: secrets.yaml not found at $secrets_file"
	echo "Run 'make sops-decrypt' first."
	exit 1
fi

if ! command -v yq >/dev/null 2>&1; then
	echo "Error: yq is not installed"
	echo "  brew install yq  # macOS"
	echo "  or: https://github.com/mikefarah/yq#install"
	exit 1
fi

{
	echo "# Generated from secrets.yaml (e2e) - DO NOT COMMIT"
	echo "# Generated at: $(date)"
	echo ""
	yq -o=json '.e2e // {}' "$secrets_file" | python3 -c 'import json,sys
for k,v in json.load(sys.stdin).items():
    if isinstance(v, str):
        print(f"{k.upper()}=" + json.dumps(v))'
} > "$env_e2e"

echo "Written: $env_e2e"
