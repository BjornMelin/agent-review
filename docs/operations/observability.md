# Observability Runbook

This runbook defines the first-party observability contract for hosted review
runs. It follows OpenTelemetry's signals model by keeping structured logs
correlated with durable metrics while keeping private repository material out of
durable and platform log surfaces.

## Source References

- OpenTelemetry observability primer:
  <https://opentelemetry.io/docs/concepts/observability-primer/>
- OpenTelemetry log correlation spec:
  <https://opentelemetry.io/docs/specs/otel/logs/>
- Vercel Runtime Logs:
  <https://vercel.com/docs/logs/runtime>
- Vercel Log Drains:
  <https://vercel.com/docs/drains>
- Vercel Workflow log filtering changelog:
  <https://vercel.com/changelog/logs-filtering-for-vercel-workflows-now-available>
- Vercel Sandbox SDK reference:
  <https://vercel.com/docs/vercel-sandbox/sdk-reference>

## Durable Metrics

`ReviewRunMetricsSchema` is the durable, redaction-safe summary for service
status, service lists, CLI `review-agent list`, and Review Room metadata.

Allowed fields:

- Run status and timing: `startedAt`, `completedAt`, `durationMs`, `queueMs`.
- Stable low-cardinality dimensions: provider, execution mode, target type, and
  safe requested/resolved model IDs. Unsafe optional model values are omitted
  from observable summaries; unsafe required provider telemetry model fields use
  `unknown`.
- Correlation IDs: `reviewId`, optional `workflowRunId`, optional `sandboxId`.
- Provider summary: total latency, attempt count, fallback state, failure class,
  and reported or unknown token/cost usage.
- Sandbox summary: command count, command duration, wall time, output bytes,
  artifact bytes, and redaction counters.
- Artifact summary: artifact count and total bytes.
- Runtime summary: lease owner, lease timing fields, and `cancelRequestedAt`.

Prohibited fields:

- cwd values, runtime scope keys, prompt text, rubrics, diffs, file contents,
  artifact bodies, provider raw output, stack traces, sandbox command args,
  stdout, stderr, stdin, environment values, tokens, hashes, private keys, and
  repository branch/commit values as metric labels.
- Terminal run errors exposed through status/list/events use bounded,
  redaction-safe diagnostic messages. Harmless summaries such as
  `provider returned invalid JSON` may be preserved; messages containing
  secrets, host paths, cwd, prompt text, diffs, files, stack traces, or other
  private payload markers fall back to generic text such as
  `review run failed`, `detached run failed`, or `detached start failed`.

## Structured Logs

The review service emits `[review-service] run observability` records with the
`ReviewServiceRunLogRecord` envelope. Events are:

- `review.run.reserved`
- `review.run.backpressure`
- `review.run.running`
- `review.run.terminal`
- `review.run.cancel.requested`

Allowed structured log fields are `event`, `reviewId`, `status`, `provider`,
`executionMode`, `targetType`, optional `workflowRunId`, optional `sandboxId`,
`durationMs`, `queueMs`, provider latency/attempt/usage/fallback fields,
sandbox command and output byte counts, `artifactBytes`, `failureClass`, and
`cancelRequested`.

Use these logs to correlate Vercel Runtime Logs with durable status rows. Do not
depend on runtime logs as the audit store; runtime log retention and export are
controlled by Vercel account configuration. Use Log Drains for longer external
retention when production operations require it.

## Operator Workflow

1. Start with the durable list:

   ```bash
   review-agent list --status failed --repo owner/name --service-url "$REVIEW_AGENT_SERVICE_URL"
   ```

   The list endpoint is freshness-gated for active detached runs. If it returns
   `502` with `failed to list review runs`, check service logs for
   `list sync freshness unavailable` and inspect Workflow/detached status before
   treating the durable list as stale.

2. Open a single run with:

   ```bash
   review-agent status <reviewId> --service-url "$REVIEW_AGENT_SERVICE_URL"
   ```

3. If `workflowRunId` is present, filter Vercel Workflow logs by Workflow Run
   ID and Step ID in the Vercel dashboard.
4. If `sandboxId` is present, inspect sandbox execution only through aggregate
   audit summaries unless an explicitly authorized debug session is required.
5. For user-facing triage, prefer Review Room metadata. It shows the same
   metrics without exposing service tokens to the browser.

## Alert Seeds

Initial production alerts should target derived counts, not raw payloads:

- `review.run.backpressure` count above the deployment baseline.
- Failed terminal runs grouped by safe failure class.
- Provider `usage.status="unknown"` spikes.
- Sandbox output or artifact bytes approaching configured budgets.
- Redaction counters greater than zero on completed runs.
