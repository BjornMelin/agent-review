import { NextResponse } from 'next/server';
import { authorizeReviewRoomRequest } from '@/lib/review-room-access';
import { resolveReviewWebConfig } from '@/lib/review-service';
import { reviewRoomAccessHeaders } from '@/lib/route-security';

export function GET(request: Request): NextResponse {
  const access = authorizeReviewRoomRequest(request.headers);
  if (!access.ok) {
    return NextResponse.json(
      { error: access.error },
      { headers: reviewRoomAccessHeaders(access), status: access.status }
    );
  }
  const config = resolveReviewWebConfig();
  return NextResponse.json({
    ok: true,
    serviceUrl: config.serviceUrl,
    tokenConfigured: Boolean(config.token),
    tokenSource: config.tokenSource ?? null,
  });
}
