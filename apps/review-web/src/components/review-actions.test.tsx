// @vitest-environment happy-dom

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewActions } from './review-actions';

const refresh = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  refresh.mockClear();
});

describe('ReviewActions', () => {
  it('surfaces publish failures instead of silently refreshing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(JSON.stringify({ error: 'publish denied' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        });
      })
    );

    render(
      <ReviewActions
        reviewId="review_123"
        canCancel={false}
        canPublish={true}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'publish denied'
    );
    expect(refresh).not.toHaveBeenCalled();
  });
});
