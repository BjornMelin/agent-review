import { NextResponse } from 'next/server';
import { authorizeReviewRoomRequest } from '@/lib/review-room-access';
import { updateFindingTriage } from '@/lib/review-service';
import {
  reviewRoomAccessHeaders,
  validateReviewRoomMutation,
} from '@/lib/route-security';

/**
 * Proxies one Review Room finding triage mutation to the review service.
 *
 * @param request - Incoming mutation request containing the triage JSON body.
 * @param context - Route context with the review identifier and finding fingerprint.
 * @returns JSON response containing updated triage state or an error payload.
 */
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
  let body: Parameters<typeof updateFindingTriage>[2];
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const result = await updateFindingTriage(reviewId, fingerprint, body);
  return NextResponse.json(result.ok ? result.data : { error: result.error }, {
    status: result.ok ? 200 : (result.status ?? 502),
  });
}
