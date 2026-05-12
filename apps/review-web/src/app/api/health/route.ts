import { NextResponse } from 'next/server';
import { resolveReviewRoomAccessConfig } from '@/lib/review-room-access';
import { resolveReviewWebConfig } from '@/lib/review-service';

/**
 * Returns non-secret Review Room readiness signals for preview smoke checks.
 *
 * @returns JSON health payload with configuration booleans.
 */
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
