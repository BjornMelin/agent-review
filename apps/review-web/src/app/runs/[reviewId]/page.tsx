import type { Metadata } from 'next';
import { ReviewRoomPage } from '../../review-room-page';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ reviewId: string }>;
}): Promise<Metadata> {
  const { reviewId } = await params;
  return {
    title: reviewId,
  };
}

export default async function RunPage({
  params,
}: {
  params: Promise<{ reviewId: string }>;
}): Promise<React.ReactNode> {
  const { reviewId } = await params;
  return <ReviewRoomPage reviewId={reviewId} />;
}
