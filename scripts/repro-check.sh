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

next_config_files() {
  find "${WORKSPACE_ROOTS[@]}" \
    \( -name next.config.js -o -name next.config.cjs -o -name next.config.mjs -o -name next.config.ts \) \
    -type f \
    -print0
}

is_docker_like_environment() {
  if [[ -f /.dockerenv ]]; then
    return 0
  fi
  if [[ -r /proc/self/cgroup ]] && grep -qaE 'docker|kubepods|containerd' /proc/self/cgroup; then
    return 0
  fi
  return 1
}

ensure_next_preview_cache_supported() {
  local has_next_app=0
  while IFS= read -r -d '' _config_file; do
    has_next_app=1
    break
  done < <(next_config_files)

  if [[ "$has_next_app" -eq 1 ]] && is_docker_like_environment; then
    echo "[repro] ERROR: Next.js disables persistent preview-key cache in Docker-like environments." >&2
    echo "[repro] ERROR: Run this reproducibility gate on a non-container runner, or Next preview keys will stay random between cold builds." >&2
    exit 1
  fi
}

seed_next_preview_cache() {
  while IFS= read -r -d '' config_file; do
    local app_dir
    app_dir="$(dirname "$config_file")"
    local cache_dir="$app_dir/.next/cache"
    mkdir -p "$cache_dir"
    cat >"$cache_dir/.previewinfo" <<'JSON'
{"previewModeId":"00000000000000000000000000000000","previewModeSigningKey":"1111111111111111111111111111111111111111111111111111111111111111","previewModeEncryptionKey":"2222222222222222222222222222222222222222222222222222222222222222","expireAt":4102444800000}
JSON
  done < <(next_config_files)
}

ensure_next_preview_cache_supported

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
    find "$root" -type d -name .next -prune -exec rm -rf {} +
    find "$root" -type f -name tsconfig.tsbuildinfo -delete
  done

  seed_next_preview_cache

  echo "[repro] Building review-types contract package (${label})"
  pnpm --filter @review-agent/review-types build

  echo "[repro] Building workspace (${label})"
  REVIEW_WEB_BUILD_ID="${REVIEW_WEB_BUILD_ID:-local-repro}" \
    NEXT_SERVER_ACTIONS_ENCRYPTION_KEY="${NEXT_SERVER_ACTIONS_ENCRYPTION_KEY:-MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=}" \
    pnpm turbo run build --force
}

hash_dist_tree() {
  local files=()
  while IFS= read -r -d '' file; do
    files+=("$file");
  done < <(
    # Next trace files contain timing diagnostics, not deployable app code.
    find "${WORKSPACE_ROOTS[@]}" \
      \( -path '*/dist/*' -o -path '*/.next/*' \) \
      -type f \
      ! -path '*/.next/cache/*' \
      ! -path '*/.next/trace' \
      ! -path '*/.next/trace-build' \
      -print0 | sort -z
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
