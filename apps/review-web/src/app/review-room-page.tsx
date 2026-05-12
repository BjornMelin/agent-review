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
  const requestedReviewStatusPromise = reviewId
    ? getReviewStatus(reviewId)
    : null;
  const runs = await runsPromise;
  const selectedReviewId =
    reviewId ?? (runs.ok ? runs.data.runs[0]?.reviewId : undefined);
  const selected = requestedReviewStatusPromise
    ? await requestedReviewStatusPromise
    : selectedReviewId
      ? await getReviewStatus(selectedReviewId)
      : null;
  return (
    <ReviewRoom
      runs={runs}
      selected={selected}
      selectedReviewId={selectedReviewId}
    />
  );
}
