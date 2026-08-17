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

  // GET only, and that word is load-bearing. This redirect is a UX affordance for
  // someone who NAVIGATES to /login while already signed in — it has no business
  // touching a server-action POST, which is not a navigation.
  //
  // It did, and it wedged sign-in completely (2026-08-17). The login form calls the
  // recordLoginAttempt server action immediately after signInWithPassword, and that
  // POSTs back to /login — by which point the session cookie exists, so `user` is
  // truthy and this line answered a server action with a 307 to "/". NextResponse.redirect
  // is a 307, so the POST is re-sent to a route whose bundle does not contain that
  // action; it fails, the client await rejects, and setBusy(false) below it never runs.
  // The button sat on "Signing in…" forever while the session was in fact established,
  // which is why refreshing landed straight on /mfa.
  //
  // Only successful sign-ins broke: a failed one leaves no session, so `user` is null
  // here and the action POST passes through untouched.
  if (user && path === "/login" && request.method === "GET") return redirectTo("/");
  return response;
}

export const config = {
  // Skip static assets; run on pages and server-action posts.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt).*)"],
};
