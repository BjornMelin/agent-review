#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

readonly CARGO_AUDIT_VERSION="0.22.1"

echo "[security] Auditing production npm dependency graph"
pnpm audit --audit-level high --prod

if ! command -v cargo-audit >/dev/null 2>&1; then
  echo "[security] Installing cargo-audit ${CARGO_AUDIT_VERSION}"
  cargo install cargo-audit --version "$CARGO_AUDIT_VERSION" --locked
fi

echo "[security] Auditing Cargo.lock against RustSec advisories"
cargo audit --deny warnings

echo "[security] OK: pnpm and Cargo advisory audits passed"
