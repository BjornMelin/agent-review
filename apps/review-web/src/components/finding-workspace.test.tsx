// @vitest-environment happy-dom

import type { ReviewFinding } from '@review-agent/review-types';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FindingWorkspace } from './finding-workspace';

const refresh = vi.fn();
const replace = vi.fn((href: string) => {
  window.history.replaceState(null, '', href);
});

vi.mock('next/navigation', () => ({
  usePathname: () => window.location.pathname,
  useRouter: () => ({ refresh, replace }),
  useSearchParams: () => new URLSearchParams(window.location.search),
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

const secondaryFinding: ReviewFinding = {
  title: 'Slow audit',
  body: 'The audit path should stay deterministic.',
  confidenceScore: 0.72,
  codeLocation: {
    absoluteFilePath: '/repo/src/audit.ts',
    lineRange: { start: 22, end: 22 },
  },
  fingerprint: 'finding-2',
  priority: 2,
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
  replace.mockClear();
  window.history.replaceState(null, '', '/review/review-1');
});

describe('FindingWorkspace', () => {
  it('hydrates filters from URL search params for shareable triage views', () => {
    window.history.replaceState(
      null,
      '',
      '/review/review-1?triagePath=src/app'
    );

    render(
      <FindingWorkspace
        findings={[finding, secondaryFinding]}
        publications={[]}
        provider="codexDelegate"
        reviewId="review-1"
        triage={[]}
      />
    );

    expect(screen.getByText('1 of 2 findings visible')).toBeTruthy();
  });

  it('persists filter changes into URL search params without a scroll jump', async () => {
    window.history.replaceState(null, '', '/review/review-1?tab=findings');

    render(
      <FindingWorkspace
        findings={[finding, secondaryFinding]}
        publications={[]}
        provider="codexDelegate"
        reviewId="review-1"
        triage={[]}
      />
    );

    await userEvent.selectOptions(screen.getByLabelText('Priority'), '1');

    expect(replace).toHaveBeenLastCalledWith(
      '/review/review-1?tab=findings&triagePriority=1',
      { scroll: false }
    );
  });

  it('preserves unsaved note drafts when refreshed triage records arrive', async () => {
    const { rerender } = render(
      <FindingWorkspace
        findings={[finding, secondaryFinding]}
        publications={[]}
        provider="codexDelegate"
        reviewId="review-1"
        triage={[
          {
            reviewId: 'review-1',
            fingerprint: 'finding-1',
            status: 'open',
            note: 'server note',
            createdAt: 1,
            updatedAt: 1,
          },
          {
            reviewId: 'review-1',
            fingerprint: 'finding-2',
            status: 'open',
            note: 'old note',
            createdAt: 1,
            updatedAt: 1,
          },
        ]}
      />
    );
    const draft = screen.getByLabelText(
      'Triage note for Slow audit'
    ) as HTMLTextAreaElement;

    await userEvent.clear(draft);
    await userEvent.type(draft, 'unsaved reviewer note');
    rerender(
      <FindingWorkspace
        findings={[finding, secondaryFinding]}
        publications={[]}
        provider="codexDelegate"
        reviewId="review-1"
        triage={[
          {
            reviewId: 'review-1',
            fingerprint: 'finding-1',
            status: 'accepted',
            note: 'server note changed',
            createdAt: 1,
            updatedAt: 2,
          },
          {
            reviewId: 'review-1',
            fingerprint: 'finding-2',
            status: 'open',
            note: 'old note',
            createdAt: 1,
            updatedAt: 2,
          },
        ]}
      />
    );

    expect(
      (
        screen.getByLabelText(
          'Triage note for Unsafe publish'
        ) as HTMLTextAreaElement
      ).value
    ).toBe('server note changed');
    expect(draft.value).toBe('unsaved reviewer note');
  });

  it('clears unsaved note drafts when the review changes', async () => {
    const { rerender } = render(
      <FindingWorkspace
        findings={[finding]}
        publications={[]}
        provider="codexDelegate"
        reviewId="review-1"
        triage={[
          {
            reviewId: 'review-1',
            fingerprint: 'finding-1',
            status: 'open',
            note: 'review one note',
            createdAt: 1,
            updatedAt: 1,
          },
        ]}
      />
    );
    const draft = screen.getByLabelText(
      'Triage note for Unsafe publish'
    ) as HTMLTextAreaElement;

    await userEvent.clear(draft);
    await userEvent.type(draft, 'unsaved review one draft');
    rerender(
      <FindingWorkspace
        findings={[finding]}
        publications={[]}
        provider="codexDelegate"
        reviewId="review-2"
        triage={[
          {
            reviewId: 'review-2',
            fingerprint: 'finding-1',
            status: 'open',
            note: 'review two note',
            createdAt: 2,
            updatedAt: 2,
          },
        ]}
      />
    );

    expect(
      (
        screen.getByLabelText(
          'Triage note for Unsafe publish'
        ) as HTMLTextAreaElement
      ).value
    ).toBe('review two note');
  });

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
