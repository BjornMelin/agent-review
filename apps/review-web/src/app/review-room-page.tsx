import { ReviewRoom } from '@/components/review-room';
import { getReviewRuns, getReviewStatus } from '@/lib/review-service';

export async function ReviewRoomPage({
  reviewId,
}: {
  reviewId?: string;
}): Promise<React.ReactNode> {
  const runs = await getReviewRuns({ limit: 25 });
  const selectedReviewId =
    reviewId ?? (runs.ok ? runs.data.runs[0]?.reviewId : undefined);
  const selected = selectedReviewId
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
