SHELL := /bin/bash
export BASH_ENV := $(HOME)/.bashrc

SOPS_KMS_ARN ?= arn:aws:kms:us-east-1:914788356809:alias/tilde-app-dev-sops
TILDE_API_DIR ?= /root/tilde-api

.PHONY: load-secrets sops-decrypt sops-encrypt test-e2e test-e2e-local

load-secrets:
	./scripts/load-secrets.sh

sops-decrypt:
	@if [ ! -f secrets.yaml ]; then \
		sops decrypt secrets.enc.yaml > secrets.yaml; \
	else \
		echo "secrets.yaml already exists. Not decrypting to prevent overwriting."; \
	fi
	./scripts/load-secrets.sh

sops-encrypt:
	@tmp="$$(mktemp)"; \
	trap 'rm -f "$$tmp"' EXIT; \
	sops encrypt --kms $(SOPS_KMS_ARN) secrets.yaml > "$$tmp"; \
	mv "$$tmp" secrets.enc.yaml

test-e2e:
	@set -euo pipefail; \
	set -a; \
	if [ -f .env.e2e ]; then source .env.e2e; fi; \
	if [ -f .env.secrets.e2e ]; then source .env.secrets.e2e; fi; \
	set +a; \
	TILDE_E2E=1 pnpm test:e2e

test-e2e-local:
	TILDE_API_DIR="$(TILDE_API_DIR)" ./scripts/run-e2e-local.sh
