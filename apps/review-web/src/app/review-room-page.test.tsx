import type {
  ReviewRunListResponse,
  ReviewStatusResponse,
} from '@review-agent/review-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getReviewRuns, getReviewStatus } from '@/lib/review-service';
import { ReviewRoomPage } from './review-room-page';

vi.mock('@/components/review-room', () => ({
  ReviewRoom: vi.fn(() => null),
}));

vi.mock('@/lib/review-service', () => ({
  getReviewRuns: vi.fn(),
  getReviewStatus: vi.fn(),
}));

const getReviewRunsMock = vi.mocked(getReviewRuns);
const getReviewStatusMock = vi.mocked(getReviewStatus);

describe('ReviewRoomPage', () => {
  beforeEach(() => {
    getReviewRunsMock.mockReset();
    getReviewStatusMock.mockReset();
  });

  it('starts the selected status request without waiting for the run list', async () => {
    let resolveRuns: (
      result: Awaited<ReturnType<typeof getReviewRuns>>
    ) => void = () => undefined;
    const runsPromise = new Promise<Awaited<ReturnType<typeof getReviewRuns>>>(
      (resolve) => {
        resolveRuns = resolve;
      }
    );
    const statusResult = {
      ok: true,
      serviceUrl: 'http://localhost:3042',
      data: {
        reviewId: 'review-1',
        status: 'completed',
        createdAt: 1,
        updatedAt: 2,
      } satisfies ReviewStatusResponse,
    } satisfies Awaited<ReturnType<typeof getReviewStatus>>;

    getReviewRunsMock.mockReturnValue(runsPromise);
    getReviewStatusMock.mockResolvedValue(statusResult);

    const page = ReviewRoomPage({ reviewId: 'review-1' });
    await Promise.resolve();

    expect(getReviewStatusMock).toHaveBeenCalledWith('review-1');
    resolveRuns({
      ok: true,
      serviceUrl: 'http://localhost:3042',
      data: {
        runs: [
          {
            reviewId: 'review-1',
            status: 'completed',
            request: {
              provider: 'codexDelegate',
              executionMode: 'localTrusted',
              targetType: 'uncommittedChanges',
              outputFormats: ['json'],
            },
            findingCount: 0,
            artifactFormats: ['json'],
            publicationCount: 0,
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      } satisfies ReviewRunListResponse,
    });

    await page;
    expect(getReviewRunsMock).toHaveBeenCalledWith({ limit: 25 });
    expect(getReviewStatusMock).toHaveBeenCalledTimes(1);
  });
});
