import { NextResponse } from 'next/server';
import { resolveReviewRoomAccessConfig } from '@/lib/review-room-access';
import { resolveReviewWebConfig } from '@/lib/review-service';

export function GET(): NextResponse {
  const service = resolveReviewWebConfig();
  const access = resolveReviewRoomAccessConfig();
  return NextResponse.json({
    ok: true,
    accessTokenConfigured: Boolean(access.accessToken),
    productionRuntime: access.productionRuntime,
    serviceTokenConfigured: Boolean(service.token),
  });
}
