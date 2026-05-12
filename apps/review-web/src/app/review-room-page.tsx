import { ReviewRoom } from '@/components/review-room';
import { getReviewRuns, getReviewStatus } from '@/lib/review-service';

/**
 * Loads the review room data needed to render either the requested run or the latest run.
 *
 * @param props - Routing props that may identify the review run to select.
 * @returns The review room shell with run list and selected run state.
 */
export async function ReviewRoomPage(props: {
  reviewId?: string;
}): Promise<React.ReactNode> {
  const { reviewId } = props;
  const runsPromise = getReviewRuns({ limit: 25 });
  const selectedStatusPromise = reviewId
    ? getReviewStatus(reviewId)
    : runsPromise.then((runs) => {
        const latestReviewId = runs.ok
          ? runs.data.runs[0]?.reviewId
          : undefined;
        return latestReviewId ? getReviewStatus(latestReviewId) : null;
      });
  const [runs, selected] = await Promise.all([
    runsPromise,
    selectedStatusPromise,
  ]);
  const selectedReviewId =
    reviewId ?? (runs.ok ? runs.data.runs[0]?.reviewId : undefined);
  return (
    <ReviewRoom
      runs={runs}
      selected={selected}
      selectedReviewId={selectedReviewId}
    />
  );
}
