import { headers } from 'next/headers';
import { ReviewRoom } from '@/components/review-room';
import { authorizeReviewRoomRequest } from '@/lib/review-room-access';
import { getReviewRuns, getReviewStatus } from '@/lib/review-service';

function AccessDenied({ message }: { message: string }): React.ReactNode {
  return (
    <main className="grid min-h-screen place-items-center bg-[var(--background)] px-6 text-center text-[var(--foreground)]">
      <div className="max-w-sm">
        <h1 className="text-lg font-semibold">Review Room access required</h1>
        <p className="mt-2 text-sm text-[var(--muted-foreground)]">{message}</p>
      </div>
    </main>
  );
}

export async function ReviewRoomPage({
  reviewId,
}: {
  reviewId?: string;
}): Promise<React.ReactNode> {
  const access = authorizeReviewRoomRequest(await headers());
  if (!access.ok) {
    return <AccessDenied message={access.error} />;
  }
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
