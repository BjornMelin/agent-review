'use client';

import type {
  ReviewPublicationPreviewItem,
  ReviewPublicationRecord,
  ReviewPublishPreviewResponse,
} from '@review-agent/review-types';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  GitBranch,
  Loader2,
  RefreshCw,
  Send,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

type PublishPreviewPanelProps = {
  canPreview: boolean;
  publications: ReviewPublicationRecord[];
  reviewId: string;
};

function actionVariant(
  action: ReviewPublicationPreviewItem['action']
): React.ComponentProps<typeof Badge>['variant'] {
  if (action === 'create' || action === 'update' || action === 'reuse') {
    return 'success';
  }
  if (action === 'blocked' || action === 'delete') {
    return 'danger';
  }
  if (action === 'skip' || action === 'unsupported') {
    return 'warning';
  }
  return 'neutral';
}

function statusVariant(
  status: ReviewPublicationRecord['status']
): React.ComponentProps<typeof Badge>['variant'] {
  if (status === 'published') {
    return 'success';
  }
  if (status === 'failed') {
    return 'danger';
  }
  return 'warning';
}

function targetLabel(
  preview: ReviewPublishPreviewResponse | null
): string | null {
  if (!preview) {
    return null;
  }
  const pullRequest = preview.target.pullRequestNumber
    ? ` PR #${preview.target.pullRequestNumber}`
    : '';
  return `${preview.target.owner}/${preview.target.repo}${pullRequest} @ ${preview.target.commitSha.slice(0, 12)}`;
}

/**
 * Renders GitHub publication preview evidence and existing publication records.
 *
 * @param props - Preview eligibility, persisted publication records, and review ID.
 * @returns Publish preview panel UI with abortable network refresh behavior.
 */
export function PublishPreviewPanel({
  canPreview,
  publications,
  reviewId,
}: PublishPreviewPanelProps): React.ReactNode {
  const [preview, setPreview] = useState<ReviewPublishPreviewResponse | null>(
    null
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const abortController = useRef<AbortController | null>(null);

  const refreshPreview = useCallback(async (): Promise<void> => {
    abortController.current?.abort();
    if (!canPreview) {
      setPreview(null);
      setPending(false);
      setError(null);
      return;
    }
    const requestId = requestSequence.current + 1;
    requestSequence.current = requestId;
    const controller = new AbortController();
    abortController.current = controller;
    setPreview(null);
    setPending(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/review/${encodeURIComponent(reviewId)}/publish/preview`,
        { signal: controller.signal }
      );
      const body = await response.json().catch(() => undefined);
      if (requestId !== requestSequence.current || controller.signal.aborted) {
        return;
      }
      if (!response.ok) {
        const message =
          body &&
          typeof body === 'object' &&
          'error' in body &&
          typeof body.error === 'string'
            ? body.error
            : `preview failed with HTTP ${response.status}`;
        setError(message);
        return;
      }
      setPreview(body as ReviewPublishPreviewResponse);
    } catch (requestError) {
      if (controller.signal.aborted) {
        return;
      }
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'preview request failed'
      );
    } finally {
      if (requestId === requestSequence.current && !controller.signal.aborted) {
        setPending(false);
      }
    }
  }, [canPreview, reviewId]);

  useEffect(() => {
    void refreshPreview();
    return () => {
      abortController.current?.abort();
    };
  }, [refreshPreview]);

  if (!canPreview) {
    return (
      <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-4 text-sm text-[var(--muted-foreground)]">
        Publication preview is available after a review completes.
      </div>
    );
  }

  const target = targetLabel(preview);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded-md border border-[var(--border)] bg-[var(--surface)] p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-semibold">GitHub publication plan</p>
          <p className="mt-1 break-all text-xs text-[var(--muted-foreground)]">
            {target ?? 'Resolving target'}
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          disabled={pending}
          onClick={() => void refreshPreview()}
        >
          {pending ? (
            <Loader2
              className="h-4 w-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : (
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
          )}
          Refresh
        </Button>
      </div>

      {error ? (
        <div
          className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4" aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}

      {preview ? (
        <div className="grid gap-3 sm:grid-cols-4">
          <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-3">
            <p className="text-xs uppercase text-[var(--muted-foreground)]">
              Check Run
            </p>
            <p className="mt-2 text-sm font-semibold">
              {preview.summary.checkRunAction ?? 'none'}
            </p>
          </div>
          <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-3">
            <p className="text-xs uppercase text-[var(--muted-foreground)]">
              SARIF
            </p>
            <p className="mt-2 text-sm font-semibold">
              {preview.summary.sarifAction ?? 'none'}
            </p>
          </div>
          <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-3">
            <p className="text-xs uppercase text-[var(--muted-foreground)]">
              Comments
            </p>
            <p className="mt-2 text-sm font-semibold">
              {preview.summary.pullRequestCommentCount}
            </p>
          </div>
          <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-3">
            <p className="text-xs uppercase text-[var(--muted-foreground)]">
              Blocked
            </p>
            <p className="mt-2 text-sm font-semibold">
              {preview.summary.blockedCount}
            </p>
          </div>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-md border border-[var(--border)]">
        <table className="w-full min-w-[860px] border-separate border-spacing-0 text-left text-sm">
          <thead>
            <tr className="text-xs uppercase text-[var(--muted-foreground)]">
              <th className="border-b border-[var(--border)] px-3 py-2 font-medium">
                Channel
              </th>
              <th className="border-b border-[var(--border)] px-3 py-2 font-medium">
                Action
              </th>
              <th className="border-b border-[var(--border)] px-3 py-2 font-medium">
                Target
              </th>
              <th className="border-b border-[var(--border)] px-3 py-2 font-medium">
                Evidence
              </th>
            </tr>
          </thead>
          <tbody>
            {(preview?.items ?? []).map((item) => (
              <tr
                key={`${item.channel}:${item.targetKey}`}
                className="align-top"
              >
                <td className="border-b border-[var(--border)] px-3 py-3">
                  <span className="inline-flex items-center gap-2">
                    {item.channel === 'sarif' ? (
                      <GitBranch className="h-4 w-4" aria-hidden="true" />
                    ) : item.channel === 'checkRun' ? (
                      <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <Send className="h-4 w-4" aria-hidden="true" />
                    )}
                    {item.channel}
                  </span>
                </td>
                <td className="border-b border-[var(--border)] px-3 py-3">
                  <Badge variant={actionVariant(item.action)}>
                    {item.action}
                  </Badge>
                </td>
                <td className="max-w-xs border-b border-[var(--border)] px-3 py-3">
                  <p className="break-all font-mono text-xs">
                    {item.path ? `${item.path}:${item.line}` : item.targetKey}
                  </p>
                  {item.fingerprint ? (
                    <p className="mt-1 break-all text-xs text-[var(--muted-foreground)]">
                      {item.fingerprint}
                    </p>
                  ) : null}
                </td>
                <td className="border-b border-[var(--border)] px-3 py-3">
                  <p>{item.message}</p>
                  {item.externalUrl ? (
                    <a
                      className="mt-1 inline-flex items-center gap-1 text-xs text-[var(--primary)]"
                      href={item.externalUrl}
                    >
                      Existing target
                      <ExternalLink
                        className="h-3.5 w-3.5"
                        aria-hidden="true"
                      />
                    </a>
                  ) : null}
                  {item.bodyPreview ? (
                    <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--background)] p-2 text-xs text-[var(--muted-foreground)]">
                      {item.bodyPreview}
                    </pre>
                  ) : null}
                </td>
              </tr>
            ))}
            {preview && preview.items.length === 0 ? (
              <tr>
                <td
                  className="px-3 py-6 text-center text-sm text-[var(--muted-foreground)]"
                  colSpan={4}
                >
                  No publication actions are planned.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <section aria-labelledby="publication-records-heading">
        <h3 id="publication-records-heading" className="text-sm font-semibold">
          Publication records
        </h3>
        <div className="mt-2 grid gap-2">
          {publications.length === 0 ? (
            <p className="text-sm text-[var(--muted-foreground)]">
              No publication records have been written yet.
            </p>
          ) : (
            publications.map((record) => (
              <div
                key={record.publicationId}
                className="flex flex-col gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="break-all font-mono text-xs">
                    {record.channel}:{record.targetKey}
                  </p>
                  <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                    {record.message ?? record.error ?? 'recorded'}
                  </p>
                </div>
                <Badge variant={statusVariant(record.status)}>
                  {record.status}
                </Badge>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
