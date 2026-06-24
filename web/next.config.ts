import type { NextConfig } from "next";
import path from "node:path";

// Content-Security-Policy. Shipped in Report-Only mode first (below) so a missed
// source can't break the live app — promote the header name to
// "Content-Security-Policy" once the browser console shows no violations.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://js.stripe.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.supabase.co https://*.tile.openstreetmap.org https://*.basemaps.cartocdn.com",
  "font-src 'self' data:",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.stripe.com https://nominatim.openstreetmap.org",
  "frame-src https://js.stripe.com https://hooks.stripe.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-DNS-Prefetch-Control", value: "on" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=(self), payment=(self)" },
  { key: "Content-Security-Policy-Report-Only", value: CSP },
];

const nextConfig: NextConfig = {
  // The monorepo root (one level up) holds both web/ and the symlinked shared/.
  // Pin it so Turbopack resolves @gohustlr/shared and stops guessing from lockfiles.
  turbopack: { root: path.join(__dirname, "..") },
  // shared/ is plain ESM consumed from outside web/ — let Next compile it.
  transpilePackages: ["@gohustlr/shared"],
  images: {
    // Supabase Storage public buckets (avatars, job-photos, completion-photos, chat-photos).
    remotePatterns: [
      { protocol: "https", hostname: "nfioebqsgmmzhbksxozc.supabase.co" },
    ],
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
