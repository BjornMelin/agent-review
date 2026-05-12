#!/usr/bin/env node
import process from 'node:process';

const deploymentUrl =
  process.env.PREVIEW_URL ?? process.env.DEPLOYMENT_URL ?? process.argv[2];
const authenticated = Boolean(process.env.REVIEW_WEB_ACCESS_TOKEN?.trim());

function fail(message) {
  console.error(`[preview-smoke] ERROR: ${message}`);
  process.exit(1);
}

function normalizeDeploymentUrl(value) {
  if (!value?.trim()) {
    fail('set PREVIEW_URL, DEPLOYMENT_URL, or pass a deployment URL argument');
  }
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const parsed = new URL(withProtocol);
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') {
      fail('preview URL must use HTTPS unless testing localhost');
    }
    const allowedHosts = (
      process.env.PREVIEW_SMOKE_ALLOWED_HOSTS ?? '.vercel.app,localhost'
    )
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean);
    const hostname = parsed.hostname.toLowerCase();
    const hostAllowed = allowedHosts.some((host) =>
      host.startsWith('.')
        ? hostname.endsWith(host) && hostname.length > host.length
        : hostname === host
    );
    if (!hostAllowed) {
      fail(`preview URL host is not allowed: ${parsed.hostname}`);
    }
    parsed.hash = '';
    return parsed;
  } catch {
    fail(`invalid preview URL: ${value}`);
  }
}

function previewHeaders() {
  const headers = new Headers({ accept: 'application/json, text/html' });
  const accessToken = process.env.REVIEW_WEB_ACCESS_TOKEN?.trim();
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
  if (accessToken) {
    headers.set('x-review-room-access-token', accessToken);
  }
  if (bypassSecret) {
    headers.set('x-vercel-protection-bypass', bypassSecret);
    headers.set('x-vercel-set-bypass-cookie', 'true');
  }
  return headers;
}

function previewTimeoutMs() {
  const rawTimeout = process.env.PREVIEW_SMOKE_TIMEOUT_MS ?? '15000';
  const timeoutMs = Number.parseInt(rawTimeout, 10);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000) {
    fail(`invalid PREVIEW_SMOKE_TIMEOUT_MS: ${rawTimeout}`);
  }
  return timeoutMs;
}

async function fetchPreview(url, path, headers) {
  const target = new URL(path, url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), previewTimeoutMs());
  let response;
  try {
    response = await fetch(target, {
      headers,
      redirect: 'follow',
      signal: controller.signal,
    });
  } catch (error) {
    fail(
      `${target} request failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  return { response, text, target };
}

const url = normalizeDeploymentUrl(deploymentUrl);
const headers = previewHeaders();

const health = await fetchPreview(url, '/api/health', headers);
if (!health.response.ok) {
  fail(
    `${health.target} returned HTTP ${health.response.status}: ${health.text.slice(0, 240)}`
  );
}

let healthBody;
try {
  healthBody = JSON.parse(health.text);
} catch {
  fail(`${health.target} did not return JSON`);
}

if (healthBody?.ok !== true) {
  fail(`${health.target} did not report ok: true`);
}

if (healthBody.serviceTokenConfigured !== true) {
  fail(
    `${health.target} reported serviceTokenConfigured=${String(
      healthBody.serviceTokenConfigured
    )}; configure REVIEW_WEB_SERVICE_TOKEN for preview`
  );
}

if (healthBody.accessTokenConfigured !== true) {
  fail(
    `${health.target} reported accessTokenConfigured=${String(
      healthBody.accessTokenConfigured
    )}; configure REVIEW_WEB_ACCESS_TOKEN for preview`
  );
}

const page = await fetchPreview(url, '/', headers);
if (authenticated) {
  if (!page.response.ok) {
    fail(`${page.target} returned HTTP ${page.response.status}`);
  }

  if (!page.text.includes('Review Room')) {
    fail(`${page.target} did not render Review Room content`);
  }
} else {
  if (page.response.status !== 401) {
    fail(
      `${page.target} returned HTTP ${page.response.status}; expected Review Room access to fail closed without credentials`
    );
  }
  if (!page.text.includes('Review Room access required')) {
    fail(`${page.target} did not render the Review Room access challenge`);
  }
}

console.log(
  `[preview-smoke] OK: ${url.origin} has configured Review Room preview health and ${authenticated ? 'authenticated access' : 'fail-closed access'}`
);
