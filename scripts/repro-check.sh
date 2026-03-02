#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[repro] Installing dependencies"
pnpm install --frozen-lockfile

echo "[repro] Running full checks"
pnpm check

echo "[repro] Building workspace (pass 1)"
pnpm build

hash_dist_tree() {
  if ! find apps packages -type d -name dist | grep -q .; then
    echo "no-dist"
    return
  fi

  find apps packages -type d -name dist -print0 \
    | xargs -0 -I{} find "{}" -type f -print0 \
    | sort -z \
    | xargs -0 sha256sum \
    | sha256sum \
    | awk '{ print $1 }'
}

FIRST_HASH="$(hash_dist_tree)"
echo "[repro] pass1 hash: $FIRST_HASH"

echo "[repro] Building workspace (pass 2, forced)"
pnpm turbo run build --force

SECOND_HASH="$(hash_dist_tree)"
echo "[repro] pass2 hash: $SECOND_HASH"

if [[ "$FIRST_HASH" != "$SECOND_HASH" ]]; then
  echo "[repro] ERROR: build outputs are not reproducible"
  exit 1
fi

echo "[repro] OK: build outputs are reproducible"
