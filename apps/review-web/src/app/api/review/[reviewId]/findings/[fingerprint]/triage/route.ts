import { NextResponse } from 'next/server';
import { authorizeReviewRoomRequest } from '@/lib/review-room-access';
import { updateFindingTriage } from '@/lib/review-service';
import {
  reviewRoomAccessHeaders,
  validateReviewRoomMutation,
} from '@/lib/route-security';

export async function PATCH(
  request: Request,
  context: { params: Promise<{ fingerprint: string; reviewId: string }> }
): Promise<NextResponse> {
  const access = authorizeReviewRoomRequest(request.headers);
  if (!access.ok) {
    return NextResponse.json(
      { error: access.error },
      { headers: reviewRoomAccessHeaders(access), status: access.status }
    );
  }
  const guard = validateReviewRoomMutation(request, 'triage');
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  const { fingerprint, reviewId } = await context.params;
  const body = await request.json().catch(() => undefined);
  const result = await updateFindingTriage(reviewId, fingerprint, body);
  return NextResponse.json(result.ok ? result.data : { error: result.error }, {
    status: result.ok ? 200 : (result.status ?? 502),
  });
}
