import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { authorizeReviewRoomRequest } from '@/lib/review-room-access';
import { reviewRoomAccessHeaders } from '@/lib/route-security';

/**
 * Declares Review Room routes that must pass through the access gate.
 */
export const config = {
  matcher: ['/', '/runs/:path*', '/api/:path*'],
};

/**
 * Enforces Review Room access control before protected page and API routes run.
 *
 * @param request - Incoming Next.js request with pathname and authorization headers.
 * @returns A blocking response for unauthorized requests, or undefined to continue routing.
 */
export function proxy(request: NextRequest): NextResponse | undefined {
  if (request.nextUrl.pathname === '/api/health') {
    return undefined;
  }

  const access = authorizeReviewRoomRequest(request.headers);
  if (access.ok) {
    return undefined;
  }

  const headers = reviewRoomAccessHeaders(access);
  if (request.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json(
      { error: access.error },
      { headers, status: access.status }
    );
  }
  return new NextResponse(
    `<!doctype html><html lang="en"><body><h1>Review Room access required</h1><p>${access.error}</p></body></html>`,
    {
      headers: {
        ...headers,
        'content-type': 'text/html; charset=utf-8',
      },
      status: access.status,
    }
  );
}
