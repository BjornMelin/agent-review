import { NextResponse } from 'next/server';
import { authorizeReviewRoomRequest } from '@/lib/review-room-access';
import { createServiceRequest } from '@/lib/review-service';
import { reviewRoomAccessHeaders } from '@/lib/route-security';

export async function GET(
  request: Request,
  context: { params: Promise<{ reviewId: string; format: string }> }
): Promise<Response> {
  const access = authorizeReviewRoomRequest(request.headers);
  if (!access.ok) {
    return NextResponse.json(
      { error: access.error },
      { headers: reviewRoomAccessHeaders(access), status: access.status }
    );
  }
  const { reviewId, format } = await context.params;
  const upstream = createServiceRequest(
    `/v1/review/${encodeURIComponent(reviewId)}/artifacts/${encodeURIComponent(format)}`
  );
  const response = await fetch(upstream.url, upstream.init);
  return new Response(response.body, {
    status: response.status,
    headers: {
      'content-type':
        response.headers.get('content-type') ?? 'application/octet-stream',
      'cache-control': 'no-store',
    },
  });
}
