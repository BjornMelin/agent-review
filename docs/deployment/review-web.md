# Review Room Deployment

Review Room is the Next.js operational surface in `apps/review-web`. It is a
hosted-service client, not a second review engine.

## Runtime Shape

- Server Components load run lists and run detail data from the review service.
- Next.js route handlers proxy artifact downloads, lifecycle SSE, finding
  triage writes, publication previews, cancel, and publish requests.
- The bearer token is read only on the server from environment variables and
  must never use a `NEXT_PUBLIC_*` name.
- Browser-rendered findings and metadata rely on React escaping. Provider
  Markdown artifacts are downloaded through artifact routes instead of rendered
  as executable HTML.
- Browser mutation route handlers require same-origin requests plus a
  route-specific `x-review-room-action` header before proxying the server-side
  service token.
- Production and Vercel preview runtimes fail closed in `src/proxy.ts` unless
  `REVIEW_WEB_ACCESS_TOKEN` is configured. Page loads receive a real `401`
  Basic-auth challenge when credentials are required, and API proxy routes
  receive JSON errors before any service-token-backed call.

## Environment Variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `REVIEW_WEB_SERVICE_URL` | Recommended | Base URL for the hosted review service. Falls back to `REVIEW_AGENT_SERVICE_URL`, then `REVIEW_SERVICE_URL`, then `http://localhost:3042`. |
| `REVIEW_WEB_SERVICE_TOKEN` | Required when service auth is enabled | Scoped bearer token used by server-side service calls. Falls back to `REVIEW_AGENT_SERVICE_TOKEN`, then `REVIEW_SERVICE_TOKEN`. |
| `REVIEW_WEB_ACCESS_TOKEN` | Required in production/preview | Browser-origin access gate checked before Review Room pages or proxy routes use the server-side service token. Accepted through Basic auth, bearer auth, or `x-review-room-access-token`. |
| `REVIEW_WEB_BUILD_ID` | Optional | Overrides the deterministic Next.js build ID. When unset, Review Room uses `VERCEL_GIT_COMMIT_SHA`, then `GITHUB_SHA`, then `local`. |

The service URL rejects credentials, query strings, fragments, non-HTTP(S)
schemes, and plaintext remote HTTP before a service token is attached. HTTP is
allowed only for localhost and loopback development origins.

The service token should carry the smallest scope set needed by the deployment:
`review:read` for read-only dashboards, plus `review:cancel` for cancellation
and `review:publish` for finding triage, publication previews, and publish
controls.

## Local Development

```bash
pnpm --filter @review-agent/review-service dev

export REVIEW_WEB_SERVICE_URL=http://localhost:3042
export REVIEW_WEB_SERVICE_TOKEN=rat_<tokenId>_<secret>
pnpm --filter @review-agent/review-web dev
```

For no-auth local service testing, set `REVIEW_SERVICE_AUTH_MODE=disabled` on
the service. Production service startup rejects disabled auth.

## Vercel Deployment Notes

- Deploy `apps/review-web` as the project root.
- Set `REVIEW_WEB_SERVICE_URL` to an HTTPS review-service origin.
- Store `REVIEW_WEB_SERVICE_TOKEN` as an encrypted server-side environment
  variable for the target Vercel environment.
- Store `REVIEW_WEB_ACCESS_TOKEN` as a separate encrypted environment variable
  and share it only through the deployment's intended access channel. For human
  browser use, Basic auth with any username and this token as the password is
  supported.
- Let Vercel provide `VERCEL_GIT_COMMIT_SHA` for stable build IDs, or set
  `REVIEW_WEB_BUILD_ID` explicitly for non-Vercel promotion pipelines.
- Keep Review Room metadata `noindex` until customer-facing auth, tenancy, and
  domain policy are finalized.
- Do not expose the review service token to client components, edge config, log
  drains, or public runtime configuration.
- Keep `/api/health` public. It returns only non-secret readiness booleans and
  lets the secret-free preview smoke workflow prove deployment configuration
  without sending repository secrets to PR preview deployments.
- Treat authenticated preview dogfood as a trusted manual lane. If deployment
  protection blocks the preview before Review Room can serve `/api/health`, use
  Vercel's automation bypass only from trusted operator environments.

## Security Posture

Review Room currently ships as an internal service-token deployment shell: a
trusted deployment reads authorized runs server-side and proxies browser actions
only after a coarse Review Room access gate passes. It does not implement a
browser-native GitHub login/session model or per-user repository authorization.
That session model and CSP rollout remain follow-up hardening before Review Room
becomes a multi-user browser session surface.

The review service remains the authorization authority. Review Room must not
filter unauthorized runs in the browser; route handlers and server components
only render data returned by already-authorized service endpoints.
