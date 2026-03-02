#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[repro] Installing dependencies"
pnpm install --frozen-lockfile

echo "[repro] Running full checks"
pnpm check

WORKSPACE_ROOTS=()
if [[ -d apps ]]; then
  WORKSPACE_ROOTS+=("apps")
fi
if [[ -d packages ]]; then
  WORKSPACE_ROOTS+=("packages")
fi
if [[ ${#WORKSPACE_ROOTS[@]} -eq 0 ]]; then
  echo "[repro] ERROR: expected workspace roots (apps and/or packages)" >&2
  exit 1
fi

HASH_TOOL="sha256sum"
HASH_TOOL_ARGS=()
if ! command -v "$HASH_TOOL" >/dev/null 2>&1; then
  if command -v shasum >/dev/null 2>&1; then
    HASH_TOOL="shasum"
    HASH_TOOL_ARGS=("-a" "256")
  else
    echo "[repro] ERROR: no supported SHA-256 tool found (sha256sum or shasum required)" >&2
    exit 1
  fi
fi

run_build() {
  local label="$1"

  echo "[repro] Cleaning dist directories before ${label}"
  for root in "${WORKSPACE_ROOTS[@]}"; do
    find "$root" -type d -name dist -prune -exec rm -rf {} +
  done

  echo "[repro] Building workspace (${label})"
  pnpm turbo run build --force
}

hash_dist_tree() {
  local files=()
  while IFS= read -r -d '' file; do
    files+=("$file");
  done < <(
    find "${WORKSPACE_ROOTS[@]}" -type f -print0 | sort -z
  )

  if ((${#files[@]} == 0)); then
    echo "[repro] ERROR: no regular files found after build" >&2
    return 1
  fi

  {
    for file in "${files[@]}"; do
      printf '%s\0' "${file#"$ROOT_DIR"/}"
      cat "$file"
    done
  } | "$HASH_TOOL" "${HASH_TOOL_ARGS[@]}" | awk '{ print $1 }'
}

run_build "pass 1"
FIRST_HASH="$(hash_dist_tree)"
echo "[repro] pass1 hash: $FIRST_HASH"

run_build "pass 2"
SECOND_HASH="$(hash_dist_tree)"
echo "[repro] pass2 hash: $SECOND_HASH"

if [[ "$FIRST_HASH" != "$SECOND_HASH" ]]; then
  echo "[repro] ERROR: build outputs are not reproducible"
  exit 1
fi

echo "[repro] OK: build outputs are reproducible"
