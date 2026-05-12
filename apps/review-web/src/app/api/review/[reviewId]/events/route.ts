import { NextResponse } from 'next/server';
import { authorizeReviewRoomRequest } from '@/lib/review-room-access';
import { createServiceRequest } from '@/lib/review-service';
import { reviewRoomAccessHeaders } from '@/lib/route-security';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ reviewId: string }> }
): Promise<Response> {
  const access = authorizeReviewRoomRequest(request.headers);
  if (!access.ok) {
    return NextResponse.json(
      { error: access.error },
      { headers: reviewRoomAccessHeaders(access), status: access.status }
    );
  }
  const { reviewId } = await context.params;
  const url = new URL(request.url);
  const lastEventId = request.headers.get('last-event-id');
  const upstream = createServiceRequest(
    `/v1/review/${encodeURIComponent(reviewId)}/events${url.search}`,
    {
      headers: {
        accept: 'text/event-stream',
        ...(lastEventId ? { 'last-event-id': lastEventId } : {}),
      },
    }
  );
  const response = await fetch(upstream.url, upstream.init);
  if (!response.ok || !response.body) {
    return new Response(await response.text(), {
      status: response.status,
      headers: {
        'content-type':
          response.headers.get('content-type') ??
          'application/json; charset=utf-8',
      },
    });
  }
  return new Response(response.body, {
    status: response.status,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  });
}
