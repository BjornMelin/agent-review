import type {
  ProviderPolicyTelemetry,
  ProviderUsage,
  ReviewArtifactMetadata,
  ReviewRunListResponse,
  ReviewRunMetrics,
  ReviewRunStatus,
  ReviewStatusResponse,
} from '@review-agent/review-types';
import {
  AlertTriangle,
  Archive,
  Bot,
  CircleDot,
  Code2,
  Download,
  ExternalLink,
  FileJson,
  GitPullRequest,
  Layers3,
  SearchX,
  ShieldCheck,
} from 'lucide-react';
import Link from 'next/link';
import { FindingWorkspace } from '@/components/finding-workspace';
import { LiveTimeline } from '@/components/live-timeline';
import { PublishPreviewPanel } from '@/components/publish-preview-panel';
import { ReviewActions } from '@/components/review-actions';
import { StatusBadge } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  formatAbsoluteTime,
  formatBytes,
  formatRelativeTime,
} from '@/lib/format';
import {
  artifactHref,
  type ReviewServiceReadResult,
} from '@/lib/review-service';
import { cn } from '@/lib/utils';

type ReviewRoomProps = {
  runs: ReviewServiceReadResult<ReviewRunListResponse>;
  selected: ReviewServiceReadResult<ReviewStatusResponse> | null;
  selectedReviewId: string | undefined;
};

function statusCount(
  runs: ReviewRunListResponse,
  status: ReviewRunStatus
): number {
  return runs.runs.filter((run) => run.status === status).length;
}

function issueCountLabel(count: number): string {
  if (count === 1) {
    return '1 finding';
  }
  return `${count} findings`;
}

function formatProviderUsage(usage: ProviderUsage | undefined): string {
  if (!usage || usage.status === 'unknown') {
    return 'unknown';
  }
  const tokenParts = [
    usage.inputTokens === undefined ? undefined : `${usage.inputTokens} in`,
    usage.outputTokens === undefined ? undefined : `${usage.outputTokens} out`,
    usage.totalTokens === undefined ? undefined : `${usage.totalTokens} total`,
  ].filter((part): part is string => Boolean(part));
  const costPart =
    usage.costUsd === undefined ? undefined : `$${usage.costUsd.toFixed(6)}`;
  return [...tokenParts, costPart].filter(Boolean).join(' / ') || 'reported';
}

function formatProviderFallback(
  telemetry: ProviderPolicyTelemetry | undefined
): string {
  if (!telemetry) {
    return 'none';
  }
  if (!telemetry.fallbackUsed) {
    return telemetry.fallbackOrder.length === 0 ? 'not configured' : 'not used';
  }
  return `used ${telemetry.resolvedModel}`;
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) {
    return 'pending';
  }
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 10) {
    return `${seconds.toFixed(1)}s`;
  }
  const roundedSeconds = Math.round(seconds);
  if (roundedSeconds < 60) {
    return `${roundedSeconds}s`;
  }
  const minutes = Math.floor(roundedSeconds / 60);
  const remainingSeconds = roundedSeconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

function formatOptionalDuration(
  ms: number | undefined,
  fallback: string
): string {
  return ms === undefined ? fallback : formatDuration(ms);
}

function formatSandboxCommands(metrics: ReviewRunMetrics | undefined): string {
  if (!metrics?.sandbox) {
    return 'none';
  }
  return `${metrics.sandbox.commandCount} / ${formatDuration(
    metrics.sandbox.commandDurationMs
  )}`;
}

function artifactIcon(
  format: ReviewArtifactMetadata['format']
): React.ReactNode {
  if (format === 'markdown') {
    return <Archive className="h-4 w-4" aria-hidden="true" />;
  }
  if (format === 'sarif') {
    return <ShieldCheck className="h-4 w-4" aria-hidden="true" />;
  }
  return <FileJson className="h-4 w-4" aria-hidden="true" />;
}

function ServiceBanner({
  result,
}: {
  result: ReviewServiceReadResult<unknown>;
}): React.ReactNode {
  return (
    <div className="border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-xs text-[var(--muted-foreground)]">
      <span className="font-medium text-[var(--foreground)]">Service</span>{' '}
      <span className="break-all">{result.serviceUrl}</span>
      {!result.ok ? (
        <span className="ml-3 break-words text-[var(--destructive)]">
          {result.error}
        </span>
      ) : null}
    </div>
  );
}

function RunList({
  runs,
  selectedReviewId,
}: {
  runs: ReviewRunListResponse;
  selectedReviewId: string | undefined;
}): React.ReactNode {
  return (
    <aside className="order-2 min-h-0 border-t border-[var(--border)] bg-[var(--sidebar)] lg:order-none lg:w-[360px] lg:border-r lg:border-t-0">
      <div className="flex h-14 items-center justify-between border-b border-[var(--border)] px-4">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase text-[var(--muted-foreground)]">
            Runs
          </p>
          <p className="truncate text-sm text-[var(--foreground)]">
            {runs.runs.length} retained
          </p>
        </div>
        <Badge variant="info">{statusCount(runs, 'running')} live</Badge>
      </div>
      <ScrollArea className="h-[calc(100vh-7.5rem)] lg:h-[calc(100vh-6.5rem)]">
        <nav aria-label="Review runs" className="space-y-2 p-3">
          {runs.runs.map((run) => {
            const selected = run.reviewId === selectedReviewId;
            const href = `/runs/${encodeURIComponent(run.reviewId)}` as const;
            return (
              <Link
                key={run.reviewId}
                href={href}
                aria-current={selected ? 'page' : undefined}
                className={cn(
                  'block rounded-md border p-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]',
                  selected
                    ? 'border-[var(--primary)] bg-[var(--selected)]'
                    : 'border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-hover)]'
                )}
              >
                <span className="flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block truncate font-mono text-xs font-semibold">
                      {run.reviewId}
                    </span>
                    <span className="mt-1 flex min-w-0 items-center gap-1 text-xs text-[var(--muted-foreground)]">
                      <GitPullRequest
                        className="h-3.5 w-3.5"
                        aria-hidden="true"
                      />
                      <span className="truncate">
                        {run.repository?.fullName ?? run.request.targetType}
                      </span>
                    </span>
                  </span>
                  <StatusBadge status={run.status} />
                </span>
                <span className="mt-3 grid grid-cols-3 gap-2 text-xs text-[var(--muted-foreground)]">
                  <span className="truncate">{run.request.provider}</span>
                  <span className="truncate">
                    {issueCountLabel(run.findingCount)}
                  </span>
                  <span className="truncate">
                    {formatRelativeTime(run.updatedAt)}
                  </span>
                </span>
              </Link>
            );
          })}
        </nav>
      </ScrollArea>
    </aside>
  );
}

function EmptyState(): React.ReactNode {
  return (
    <div className="grid min-h-[45vh] place-items-center px-6 text-center">
      <div>
        <SearchX
          className="mx-auto h-9 w-9 text-[var(--muted-foreground)]"
          aria-hidden="true"
        />
        <h2 className="mt-4 text-base font-semibold">No review runs</h2>
        <p className="mt-2 max-w-sm text-sm text-[var(--muted-foreground)]">
          Hosted service history will appear here after a detached or inline run
          is accepted.
        </p>
      </div>
    </div>
  );
}

function ArtifactLinks({
  reviewId,
  artifacts,
}: {
  reviewId: string;
  artifacts: ReviewArtifactMetadata[];
}): React.ReactNode {
  if (artifacts.length === 0) {
    return (
      <p className="text-sm text-[var(--muted-foreground)]">
        No artifacts are available for this run.
      </p>
    );
  }
  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {artifacts.map((artifact) => (
        <Button key={artifact.format} asChild variant="secondary">
          <a href={artifactHref(reviewId, artifact.format)}>
            {artifactIcon(artifact.format)}
            {artifact.format.toUpperCase()}
            <span className="text-[var(--muted-foreground)]">
              {formatBytes(artifact.byteLength)}
            </span>
            <Download className="h-4 w-4" aria-hidden="true" />
          </a>
        </Button>
      ))}
    </div>
  );
}

function DetailHeader({
  detail,
}: {
  detail: ReviewStatusResponse;
}): React.ReactNode {
  const summary = detail.summary;
  return (
    <header className="border-b border-[var(--border)] bg-[var(--background)] px-4 py-4 lg:px-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h1 className="min-w-0 break-all font-mono text-lg font-semibold">
              {detail.reviewId}
            </h1>
            <StatusBadge status={detail.status} />
            {summary?.repository ? (
              <Badge className="max-w-full break-all" variant="neutral">
                {summary.repository.fullName}
              </Badge>
            ) : null}
          </div>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm text-[var(--muted-foreground)]">
            <span className="inline-flex items-center gap-1">
              <Bot className="h-4 w-4" aria-hidden="true" />
              {summary?.request.provider ?? detail.result?.metadata.provider}
            </span>
            <span className="inline-flex items-center gap-1">
              <Layers3 className="h-4 w-4" aria-hidden="true" />
              {summary?.request.executionMode ??
                detail.result?.metadata.executionMode}
            </span>
            <span className="inline-flex items-center gap-1">
              <CircleDot className="h-4 w-4" aria-hidden="true" />
              {summary?.modelResolved ??
                detail.result?.metadata.modelResolved ??
                'pending'}
            </span>
            <span>{formatAbsoluteTime(detail.updatedAt)}</span>
          </div>
        </div>
        <ReviewActions
          reviewId={detail.reviewId}
          canCancel={detail.status === 'queued' || detail.status === 'running'}
          canPublish={detail.status === 'completed' && Boolean(detail.result)}
        />
      </div>
    </header>
  );
}

function DetailBody({
  detail,
}: {
  detail: ReviewStatusResponse;
}): React.ReactNode {
  const findings = detail.result?.findings ?? [];
  const providerTelemetry =
    detail.summary?.providerTelemetry ??
    detail.result?.metadata.providerTelemetry;
  const runMetrics = detail.summary?.metrics;
  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_340px]">
      <main className="min-w-0 overflow-auto">
        <div className="space-y-6 p-4 lg:p-6">
          <section aria-labelledby="outcome-heading">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-3">
                <p className="text-xs uppercase text-[var(--muted-foreground)]">
                  Correctness
                </p>
                <p id="outcome-heading" className="mt-2 text-sm font-semibold">
                  {detail.result?.overallCorrectness ?? 'Pending'}
                </p>
              </div>
              <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-3">
                <p className="text-xs uppercase text-[var(--muted-foreground)]">
                  Findings
                </p>
                <p className="mt-2 text-sm font-semibold">
                  {issueCountLabel(findings.length)}
                </p>
              </div>
              <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-3">
                <p className="text-xs uppercase text-[var(--muted-foreground)]">
                  Confidence
                </p>
                <p className="mt-2 text-sm font-semibold">
                  {detail.result
                    ? `${Math.round(detail.result.overallConfidenceScore * 100)}%`
                    : 'Pending'}
                </p>
              </div>
            </div>
            {detail.result?.overallExplanation ? (
              <p className="mt-4 max-w-4xl text-sm leading-6 text-[var(--muted-foreground)]">
                {detail.result.overallExplanation}
              </p>
            ) : null}
            {detail.error ? (
              <div className="mt-4 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100">
                <AlertTriangle className="mt-0.5 h-4 w-4" aria-hidden="true" />
                <span>{detail.error}</span>
              </div>
            ) : null}
          </section>

          <Tabs defaultValue="findings">
            <TabsList aria-label="Review detail views">
              <TabsTrigger value="findings">Findings</TabsTrigger>
              <TabsTrigger value="publish">Publish</TabsTrigger>
              <TabsTrigger value="artifacts">Artifacts</TabsTrigger>
              <TabsTrigger value="metadata">Metadata</TabsTrigger>
            </TabsList>
            <TabsContent value="findings">
              <FindingWorkspace
                findings={findings}
                publications={detail.publications ?? []}
                provider={
                  detail.summary?.request.provider ??
                  detail.result?.metadata.provider
                }
                reviewId={detail.reviewId}
                triage={detail.triage ?? []}
              />
            </TabsContent>
            <TabsContent value="publish">
              <PublishPreviewPanel
                canPreview={
                  detail.status === 'completed' && Boolean(detail.result)
                }
                publications={detail.publications ?? []}
                reviewId={detail.reviewId}
              />
            </TabsContent>
            <TabsContent value="artifacts">
              <ArtifactLinks
                reviewId={detail.reviewId}
                artifacts={detail.artifacts ?? []}
              />
            </TabsContent>
            <TabsContent value="metadata">
              <dl className="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-3">
                {[
                  ['Created', formatAbsoluteTime(detail.createdAt)],
                  ['Updated', formatAbsoluteTime(detail.updatedAt)],
                  ['Target', detail.summary?.request.targetType ?? 'unknown'],
                  [
                    'Outputs',
                    detail.summary?.request.outputFormats.join(', ') ??
                      'pending',
                  ],
                  ['Detached Run', detail.summary?.detachedRunId ?? 'none'],
                  ['Workflow Run', detail.summary?.workflowRunId ?? 'none'],
                  ['Sandbox', detail.summary?.sandboxId ?? 'none'],
                  ['Duration', formatDuration(runMetrics?.durationMs)],
                  ['Queue Time', formatDuration(runMetrics?.queueMs)],
                  [
                    'Artifact Bytes',
                    runMetrics
                      ? formatBytes(runMetrics.artifacts.totalBytes)
                      : 'pending',
                  ],
                  ['Sandbox Commands', formatSandboxCommands(runMetrics)],
                  [
                    'Sandbox Output',
                    runMetrics?.sandbox
                      ? formatBytes(runMetrics.sandbox.outputBytes)
                      : 'none',
                  ],
                  [
                    'Lease TTL',
                    formatOptionalDuration(
                      runMetrics?.runtime.leaseTtlMs,
                      'not leased'
                    ),
                  ],
                  [
                    'Provider Policy',
                    providerTelemetry?.policyVersion ?? 'none',
                  ],
                  ['Provider Route', providerTelemetry?.route ?? 'none'],
                  [
                    'Final Provider',
                    providerTelemetry?.finalProvider ?? 'unknown',
                  ],
                  ['Fallback', formatProviderFallback(providerTelemetry)],
                  [
                    'Provider Latency',
                    providerTelemetry
                      ? `${providerTelemetry.totalLatencyMs}ms`
                      : 'pending',
                  ],
                  [
                    'Provider Timeout',
                    providerTelemetry
                      ? `${providerTelemetry.timeoutMs}ms`
                      : 'pending',
                  ],
                  ['Usage', formatProviderUsage(providerTelemetry?.usage)],
                  ['Retention', providerTelemetry?.retention ?? 'unknown'],
                ].map(([label, value]) => (
                  <div
                    key={label}
                    className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-3"
                  >
                    <dt className="text-xs uppercase text-[var(--muted-foreground)]">
                      {label}
                    </dt>
                    <dd className="mt-1 break-words font-mono text-xs">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            </TabsContent>
          </Tabs>
        </div>
      </main>
      <aside className="min-h-0 border-t border-[var(--border)] p-4 xl:border-l xl:border-t-0 xl:p-5">
        <LiveTimeline
          reviewId={detail.reviewId}
          status={detail.status}
          createdAt={detail.createdAt}
          updatedAt={detail.updatedAt}
        />
      </aside>
    </div>
  );
}

function DetailPane({
  selected,
}: {
  selected: ReviewServiceReadResult<ReviewStatusResponse> | null;
}): React.ReactNode {
  if (!selected) {
    return <EmptyState />;
  }
  if (!selected.ok) {
    return (
      <div className="grid min-h-[45vh] place-items-center px-6 text-center">
        <div>
          <AlertTriangle
            className="mx-auto h-9 w-9 text-[var(--destructive)]"
            aria-hidden="true"
          />
          <h2 className="mt-4 text-base font-semibold">Review unavailable</h2>
          <p className="mt-2 max-w-sm text-sm text-[var(--muted-foreground)]">
            {selected.error}
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DetailHeader detail={selected.data} />
      <DetailBody detail={selected.data} />
    </div>
  );
}

export function ReviewRoom({
  runs,
  selected,
  selectedReviewId,
}: ReviewRoomProps): React.ReactNode {
  const runData = runs.ok ? runs.data : { runs: [] };
  const activeReviewId =
    selectedReviewId ??
    (runData.runs.length > 0 ? runData.runs[0]?.reviewId : undefined);
  return (
    <div className="flex min-h-screen flex-col bg-[var(--background)] text-[var(--foreground)]">
      <ServiceBanner result={runs} />
      <div className="flex h-14 items-center justify-between border-b border-[var(--border)] px-4 lg:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--primary)] text-[var(--primary-foreground)]">
            <Code2 className="h-4 w-4" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">Review Room</p>
            <p className="truncate text-xs text-[var(--muted-foreground)]">
              Review Agent Platform
            </p>
          </div>
        </div>
        <Button asChild variant="ghost" size="sm">
          <a href="/api/health">
            Health
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
          </a>
        </Button>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[360px_minmax(0,1fr)]">
        <RunList runs={runData} selectedReviewId={activeReviewId} />
        <section className="order-1 min-h-0 bg-[var(--background)] lg:order-none">
          {runs.ok ? <DetailPane selected={selected} /> : <EmptyState />}
        </section>
      </div>
    </div>
  );
}
