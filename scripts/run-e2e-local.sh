#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
api_dir="${TILDE_API_DIR:-/root/tilde-api}"
run_id="${TILDE_RUN_ID:-sdk-e2e-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
run_dir="$api_dir/.tilde-runs/$run_id"
manifest_path="$run_dir/manifest.json"
credentials_path="$api_dir/.tilde-test-credentials.json"
node_extra_ca_certs="$api_dir/dev/certs/public/rootCA.pem"
backend_pid=""

cleanup() {
	if [[ -n "$backend_pid" ]]; then
		kill -TERM "-$backend_pid" >/dev/null 2>&1 || true
		wait "$backend_pid" >/dev/null 2>&1 || true
	fi
	docker rm -f "tilde-postgres-$run_id" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

if [[ ! -d "$api_dir" ]]; then
	echo "Error: TILDE_API_DIR does not exist: $api_dir"
	exit 1
fi
if [[ ! -f "$node_extra_ca_certs" ]]; then
	echo "Error: dev-agent public root CA not found: $node_extra_ca_certs"
	echo "Run make dev-certs in $api_dir first."
	exit 1
fi

rm -f "$credentials_path"

echo "Starting tilde-api dev-agent with TILDE_RUN_ID=$run_id"
setsid bash -c 'cd "$1"; RUSTC_WRAPPER="${RUSTC_WRAPPER:-}" TILDE_RUN_ID="$2" make dev-agent' bash "$api_dir" "$run_id" &
backend_pid="$!"

for _ in {1..180}; do
	if [[ -f "$manifest_path" ]]; then
		break
	fi
	if ! kill -0 "$backend_pid" >/dev/null 2>&1; then
		echo "Error: dev-agent exited before writing manifest"
		wait "$backend_pid" || true
		exit 1
	fi
	sleep 1
done

if [[ ! -f "$manifest_path" ]]; then
	echo "Error: timed out waiting for dev-agent manifest at $manifest_path"
	exit 1
fi

api_origin="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["api_origin"])' "$manifest_path")"
credentials_path="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["credentials_path"])' "$manifest_path")"

echo "Waiting for SDK e2e credentials at $credentials_path"
for _ in {1..180}; do
	if python3 - "$credentials_path" >/dev/null 2>&1 <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as f:
    data = json.load(f)
sdk = data.get("sdk_e2e") or {}
if not sdk.get("api_key") or not sdk.get("org_id") or not sdk.get("team_id"):
    raise SystemExit(1)
PY
	then
		break
	fi
	if ! kill -0 "$backend_pid" >/dev/null 2>&1; then
		echo "Error: dev-agent exited before writing SDK e2e credentials"
		wait "$backend_pid" || true
		exit 1
	fi
	sleep 1
done

IFS=$'\t' read -r e2e_org_id e2e_team_id e2e_api_key < <(
	python3 - "$credentials_path" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as f:
    sdk = json.load(f)["sdk_e2e"]
print(f"{sdk['org_id']}\t{sdk['team_id']}\t{sdk['api_key']}")
PY
)

echo "Waiting for API readiness at $api_origin"
for _ in {1..180}; do
	if curl -kfsS "$api_origin/api/v1/identity/auth/debug-profiles" >/dev/null 2>&1; then
		break
	fi
	if ! kill -0 "$backend_pid" >/dev/null 2>&1; then
		echo "Error: dev-agent exited before API became ready"
		wait "$backend_pid" || true
		exit 1
	fi
	sleep 1
done

TILDE_E2E=1 \
	TILDE_E2E_BASE_URL="$api_origin" \
	TILDE_E2E_ORG_ID="$e2e_org_id" \
	TILDE_E2E_TEAM_ID="$e2e_team_id" \
	TILDE_E2E_API_KEY="$e2e_api_key" \
	NODE_EXTRA_CA_CERTS="$node_extra_ca_certs" \
	pnpm --dir "$repo_root" test:e2e
