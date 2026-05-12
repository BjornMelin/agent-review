import { NextResponse } from 'next/server';
import { authorizeReviewRoomRequest } from '@/lib/review-room-access';
import { getPublishPreview } from '@/lib/review-service';
import { reviewRoomAccessHeaders } from '@/lib/route-security';

export const dynamic = 'force-dynamic';

function noStoreHeaders(headers: HeadersInit = {}): Headers {
  const next = new Headers(headers);
  next.set('cache-control', 'no-store');
  return next;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ reviewId: string }> }
): Promise<NextResponse> {
  const access = authorizeReviewRoomRequest(request.headers);
  if (!access.ok) {
    return NextResponse.json(
      { error: access.error },
      {
        headers: noStoreHeaders(reviewRoomAccessHeaders(access)),
        status: access.status,
      }
    );
  }
  const { reviewId } = await context.params;
  const result = await getPublishPreview(reviewId);
  return NextResponse.json(result.ok ? result.data : { error: result.error }, {
    headers: noStoreHeaders(),
    status: result.ok ? 200 : (result.status ?? 502),
  });
}
