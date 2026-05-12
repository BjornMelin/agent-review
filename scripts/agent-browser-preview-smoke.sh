#!/usr/bin/env bash
set -euo pipefail

DEPLOYMENT_URL="${PREVIEW_URL:-${DEPLOYMENT_URL:-${1:-}}}"
if [[ -z "$DEPLOYMENT_URL" ]]; then
  echo "[agent-browser-preview] ERROR: set PREVIEW_URL or DEPLOYMENT_URL" >&2
  exit 1
fi

if [[ ! "$DEPLOYMENT_URL" =~ ^https?:// ]]; then
  DEPLOYMENT_URL="https://${DEPLOYMENT_URL}"
fi

HEADERS_JSON="$(
  node --input-type=module <<'NODE'
const headers = {};
const accessToken = process.env.REVIEW_WEB_ACCESS_TOKEN?.trim();
const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
if (accessToken) headers['x-review-room-access-token'] = accessToken;
if (bypassSecret) {
  headers['x-vercel-protection-bypass'] = bypassSecret;
  headers['x-vercel-set-bypass-cookie'] = 'true';
}
process.stdout.write(JSON.stringify(headers));
NODE
)"

AGENT_BROWSER_CMD="${AGENT_BROWSER_CMD:-pnpm exec agent-browser}"
SCREENSHOT_CAPTURED="false"

run_agent_browser() {
  # AGENT_BROWSER_CMD intentionally supports commands with arguments, for CI
  # overrides such as: AGENT_BROWSER_CMD="agent-browser".
  # shellcheck disable=SC2086
  $AGENT_BROWSER_CMD "$@"
}

capture_screenshot() {
  if [[ -n "${PREVIEW_SMOKE_SCREENSHOT:-}" && "$SCREENSHOT_CAPTURED" != "true" ]]; then
    mkdir -p "$(dirname "$PREVIEW_SMOKE_SCREENSHOT")"
    run_agent_browser screenshot "$PREVIEW_SMOKE_SCREENSHOT" >/dev/null 2>&1 || true
    SCREENSHOT_CAPTURED="true"
  fi
}

trap 'status=$?; if [[ "$status" -ne 0 ]]; then capture_screenshot; fi' EXIT

run_agent_browser close --all >/dev/null 2>&1 || true
run_agent_browser set headers "$HEADERS_JSON"
if [[ -n "${REVIEW_WEB_ACCESS_TOKEN:-}" ]]; then
  run_agent_browser open "$DEPLOYMENT_URL"
else
  run_agent_browser open "${DEPLOYMENT_URL%/}/api/health"
fi
run_agent_browser wait --load networkidle || run_agent_browser wait 2000

BODY_TEXT="$(run_agent_browser get text body)"
if [[ -n "${REVIEW_WEB_ACCESS_TOKEN:-}" ]]; then
  TITLE="$(run_agent_browser get title)"
  if [[ "$TITLE" != *"Review Room"* ]]; then
    echo "[agent-browser-preview] ERROR: expected Review Room title, got: $TITLE" >&2
    exit 1
  fi
  if [[ "$BODY_TEXT" == *"Review Room access required"* ]]; then
    echo "[agent-browser-preview] ERROR: Review Room access token was not accepted" >&2
    exit 1
  fi
else
  if [[ "$BODY_TEXT" != *"\"serviceTokenConfigured\":true"* ]]; then
    echo "[agent-browser-preview] ERROR: Review Room health did not report a configured service token" >&2
    exit 1
  fi
  if [[ "$BODY_TEXT" != *"\"accessTokenConfigured\":true"* ]]; then
    echo "[agent-browser-preview] ERROR: Review Room health did not report a configured access token" >&2
    exit 1
  fi
fi

if [[ -n "${PREVIEW_SMOKE_SCREENSHOT:-}" ]]; then
  capture_screenshot
fi

if [[ -n "${REVIEW_WEB_ACCESS_TOKEN:-}" ]]; then
  echo "[agent-browser-preview] OK: Review Room rendered in agent-browser"
else
  echo "[agent-browser-preview] OK: Review Room failed closed in agent-browser"
fi
