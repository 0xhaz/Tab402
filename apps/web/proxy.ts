import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";

/**
 * Optimistic redirect for signed-out visitors, keeping where they were going. Pages still check the
 * session server-side; this only decides where to send people without one (Next 16 `proxy`).
 */
export function proxy(request: NextRequest) {
  if (getSessionCookie(request)) return NextResponse.next();
  // Signed-out visitors to the root see the landing page (same URL); the dashboard stays at /.
  if (request.nextUrl.pathname === "/")
    return NextResponse.rewrite(new URL("/welcome", request.url));
  const url = new URL("/sign-in", request.url);
  url.searchParams.set("callbackURL", `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except auth pages, the auth API, OAuth discovery, and static assets.
  matcher: [
    "/((?!sign-in|sign-up|welcome|directory|~offline|serwist|icons|manifest\\.webmanifest|api/auth|\\.well-known|_next|favicon\\.ico|.*\\.(?:png|svg|ico|webmanifest)$).*)",
  ],
};
