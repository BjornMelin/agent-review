// @vitest-environment happy-dom

import type { ReviewFinding } from '@review-agent/review-types';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FindingWorkspace } from './finding-workspace';

const refresh = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));

const finding: ReviewFinding = {
  title: 'Unsafe publish',
  body: 'The publish path needs owner review.',
  confidenceScore: 0.9,
  codeLocation: {
    absoluteFilePath: '/repo/src/app.ts',
    lineRange: { start: 10, end: 10 },
  },
  fingerprint: 'finding-1',
  priority: 1,
};

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
  refresh.mockClear();
});

describe('FindingWorkspace', () => {
  it('rolls back optimistic triage state when the service rejects the write', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ error: 'triage denied' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FindingWorkspace
        findings={[finding]}
        publications={[]}
        provider="codexDelegate"
        reviewId="review-1"
        triage={[]}
      />
    );

    const stateSelect = screen.getByLabelText(
      'Triage state for Unsafe publish'
    );
    await userEvent.selectOptions(stateSelect, 'accepted');

    expect((await screen.findByRole('alert')).textContent).toBe(
      'triage denied'
    );
    await waitFor(() =>
      expect((stateSelect as HTMLSelectElement).value).toBe('open')
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/review/review-1/findings/finding-1/triage',
      expect.objectContaining({
        method: 'PATCH',
        headers: expect.objectContaining({
          'x-review-room-action': 'triage',
        }),
      })
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it('disables row triage controls while a write is pending', async () => {
    const pendingResponse = deferred<Response>();
    const fetchMock = vi.fn(() => pendingResponse.promise);
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FindingWorkspace
        findings={[finding]}
        publications={[]}
        provider="codexDelegate"
        reviewId="review-1"
        triage={[]}
      />
    );

    const stateSelect = screen.getByLabelText(
      'Triage state for Unsafe publish'
    ) as HTMLSelectElement;
    await userEvent.selectOptions(stateSelect, 'accepted');

    expect(stateSelect.disabled).toBe(true);
    expect(
      (
        screen.getByLabelText(
          'Triage note for Unsafe publish'
        ) as HTMLTextAreaElement
      ).disabled
    ).toBe(true);
    expect(
      (
        screen.getByRole('button', {
          name: 'Save triage note for Unsafe publish',
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    pendingResponse.resolve(
      new Response(
        JSON.stringify({
          reviewId: 'review-1',
          record: {
            reviewId: 'review-1',
            fingerprint: 'finding-1',
            status: 'accepted',
            createdAt: 1,
            updatedAt: 2,
          },
          audit: {
            auditId: 'audit-1',
            reviewId: 'review-1',
            fingerprint: 'finding-1',
            toStatus: 'accepted',
            createdAt: 2,
          },
        }),
        { headers: { 'content-type': 'application/json' } }
      )
    );
    await waitFor(() => expect(stateSelect.disabled).toBe(false));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
