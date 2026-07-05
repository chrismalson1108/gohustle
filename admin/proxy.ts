import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./lib/config";

// UX layer ONLY: bounce clearly-signed-out visitors to /login and keep the
// Supabase session cookies refreshed. Real enforcement (MFA level, admin_users
// membership, role tier) lives in lib/guard.ts at the data layer — never add
// authorization logic here (middleware/proxy-only auth is a known Next.js
// bypass footgun).
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        // Canonical @supabase/ssr pattern: write refreshed cookies onto BOTH the
        // request (so downstream reads see them) and a freshly-rebuilt response
        // (so they reach the browser). Rebuilding here means a later
        // NextResponse.redirect must copy these cookies over — see below.
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  // Refreshes the token if expired (triggers setAll above).
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isAuthRoute = path === "/login" || path === "/mfa" || path === "/denied";

  // Redirect while PRESERVING any refreshed session cookies (else the browser
  // never gets the rotated token and re-refreshes on every request → loop).
  const redirectTo = (to: string) => {
    const r = NextResponse.redirect(new URL(to, request.url));
    response.cookies.getAll().forEach((c) => r.cookies.set(c));
    return r;
  };

  if (!user && !isAuthRoute) return redirectTo("/login");
  if (user && path === "/login") return redirectTo("/");
  return response;
}

export const config = {
  // Skip static assets; run on pages and server-action posts.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt).*)"],
};
