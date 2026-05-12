import { NextResponse } from 'next/server';
import { authorizeReviewRoomRequest } from '@/lib/review-room-access';
import { getPublishPreview } from '@/lib/review-service';
import { reviewRoomAccessHeaders } from '@/lib/route-security';

export async function GET(
  request: Request,
  context: { params: Promise<{ reviewId: string }> }
): Promise<NextResponse> {
  const access = authorizeReviewRoomRequest(request.headers);
  if (!access.ok) {
    return NextResponse.json(
      { error: access.error },
      { headers: reviewRoomAccessHeaders(access), status: access.status }
    );
  }
  const { reviewId } = await context.params;
  const result = await getPublishPreview(reviewId);
  return NextResponse.json(result.ok ? result.data : { error: result.error }, {
    status: result.ok ? 200 : (result.status ?? 502),
  });
}
