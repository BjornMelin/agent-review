// @vitest-environment happy-dom

import type { ReviewPublishPreviewResponse } from '@review-agent/review-types';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PublishPreviewPanel } from './publish-preview-panel';

function previewResponse(
  reviewId: string,
  pullRequestNumber: number,
  commitSha: string
): ReviewPublishPreviewResponse {
  return {
    reviewId,
    target: {
      owner: 'owner',
      repo: 'repo',
      repositoryId: 123,
      installationId: 456,
      commitSha,
      ref: `refs/pull/${pullRequestNumber}/head`,
      pullRequestNumber,
    },
    items: [
      {
        channel: 'pullRequestComment',
        targetKey: `pr-comment:${reviewId}`,
        action: 'create',
        message: 'would create pull request comment',
        externalUrl: 'https://github.com/owner/repo/pull/42#discussion_r1',
        fingerprint: `finding-${reviewId}`,
        path: 'src/app.ts',
        line: 12,
      },
    ],
    existingPublications: [],
    summary: {
      checkRunAction: 'create',
      sarifAction: 'create',
      pullRequestCommentCount: 1,
      blockedCount: 0,
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('PublishPreviewPanel', () => {
  it('renders a successful preview and publication records', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        previewResponse(
          'review-1',
          42,
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        )
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <PublishPreviewPanel
        canPreview={true}
        publications={[
          {
            publicationId: 'publication-1',
            reviewId: 'review-1',
            channel: 'checkRun',
            targetKey: 'check-run:review-1',
            status: 'published',
            message: 'published check run',
            createdAt: 1,
            updatedAt: 2,
          },
        ]}
        reviewId="review-1"
      />
    );

    expect(
      await screen.findByText('owner/repo PR #42 @ aaaaaaaaaaaa')
    ).toBeTruthy();
    expect(screen.getByText('would create pull request comment')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Existing target/ })).toMatchObject(
      {
        target: '_blank',
        rel: 'noopener noreferrer',
      }
    );
    expect(screen.getByText('published check run')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/review/review-1/publish/preview',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('does not render a stale preview after switching review ids', async () => {
    const first = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(
        jsonResponse(
          previewResponse(
            'review-2',
            2,
            'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
          )
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(
      <PublishPreviewPanel
        canPreview={true}
        publications={[]}
        reviewId="review-1"
      />
    );

    rerender(
      <PublishPreviewPanel
        canPreview={true}
        publications={[]}
        reviewId="review-2"
      />
    );

    expect(
      await screen.findByText('owner/repo PR #2 @ bbbbbbbbbbbb')
    ).toBeTruthy();

    first.resolve(
      jsonResponse(
        previewResponse(
          'review-1',
          1,
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        )
      )
    );
    await waitFor(() => {
      expect(screen.queryByText('owner/repo PR #1 @ aaaaaaaaaaaa')).toBeNull();
    });
  });

  it('refreshes the preview on demand', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          previewResponse(
            'review-1',
            1,
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
          )
        )
      )
      .mockResolvedValueOnce(
        jsonResponse(
          previewResponse(
            'review-1',
            2,
            'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
          )
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <PublishPreviewPanel
        canPreview={true}
        publications={[]}
        reviewId="review-1"
      />
    );

    await screen.findByText('owner/repo PR #1 @ aaaaaaaaaaaa');
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(
      await screen.findByText('owner/repo PR #2 @ bbbbbbbbbbbb')
    ).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
