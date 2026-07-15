import type { NextConfig } from "next";

// Internal admin console — locked down harder than the public web app:
// no Stripe.js, no maps, no third-party scripts at all. Only Supabase (auth +
// PostgREST via our own server runtime) and Supabase Storage images.
// 'unsafe-eval' is DEV-only (Fast Refresh); 'unsafe-inline' stays for Next's
// hydration bootstrap (same reviewed trade-off as web/next.config.ts — no
// raw-HTML sinks exist here either).
const isDev = process.env.NODE_ENV !== "production";
const scriptSrc = isDev
  ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
  : "script-src 'self' 'unsafe-inline'";
const CSP = [
  "default-src 'self'",
  scriptSrc,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://nfioebqsgmmzhbksxozc.supabase.co",
  "font-src 'self' data:",
  "connect-src 'self' https://nfioebqsgmmzhbksxozc.supabase.co",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Content-Security-Policy", value: CSP },
  // Internal tool: keep it out of every index, even if the domain leaks.
  { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
];

const nextConfig: NextConfig = {
  // Standalone app (no shared/ dependency) — its own lockfile is the root.
  turbopack: { root: __dirname },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "nfioebqsgmmzhbksxozc.supabase.co" },
    ],
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
