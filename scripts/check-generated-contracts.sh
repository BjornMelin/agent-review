#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[contracts] Regenerating review-types JSON Schema artifacts"
pnpm --filter @review-agent/review-types generate:schemas

echo "[contracts] Checking committed generated schema drift"
if ! git diff --quiet --exit-code -- packages/review-types/generated/json-schema; then
  echo "[contracts] ERROR: generated JSON Schema artifacts are stale" >&2
  git diff --stat -- packages/review-types/generated/json-schema >&2
  git diff --name-only -- packages/review-types/generated/json-schema >&2
  exit 1
fi

echo "[contracts] Running Rust contract parity tests"
cargo test -p review-agent-contracts --locked

echo "[contracts] OK: generated TypeScript schemas and Rust DTO parity are in sync"
