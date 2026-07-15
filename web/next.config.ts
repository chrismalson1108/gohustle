import type { NextConfig } from "next";
import path from "node:path";

// Content-Security-Policy (ENFORCING). 'unsafe-eval' is DEV-only (React Fast
// Refresh needs it); production drops it so an injected script can't eval(). Next's
// App Router still needs 'unsafe-inline' for its hydration bootstrap scripts.
//
// Residual-risk decision (reviewed): we deliberately do NOT use a nonce-based CSP.
// In Next 16 a nonce forces EVERY page into dynamic rendering — disabling static
// generation and CDN caching for the SEO landing/browse pages, raising cost, and
// risking Stripe Elements / hydration breakage. The 'unsafe-inline' it would remove
// has nothing to backstop here: the web app has no XSS sink (no dangerouslySetInnerHTML,
// innerHTML, eval, or new Function — all user content flows through React's
// auto-escaping). If a raw-HTML sink is ever introduced, revisit and adopt a nonce
// (Next renames middleware -> proxy; see node_modules/next/dist/docs CSP guide).
//
// The hard wins remain: frame-ancestors (clickjacking), restricted connect/img/frame
// sources, base-uri, form-action, object-src 'none'. Stripe Elements needs
// js.stripe.com (script/frame), *.stripe.com (api + telemetry) and *.stripe.network
// (3-D Secure); maps use OSM/Carto.
const isDev = process.env.NODE_ENV !== "production";
const scriptSrc = isDev
  ? "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://js.stripe.com"
  : "script-src 'self' 'unsafe-inline' https://js.stripe.com";
const CSP = [
  "default-src 'self'",
  scriptSrc,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://nfioebqsgmmzhbksxozc.supabase.co https://*.stripe.com https://*.tile.openstreetmap.org https://*.basemaps.cartocdn.com",
  "font-src 'self' data:",
  "connect-src 'self' https://nfioebqsgmmzhbksxozc.supabase.co wss://nfioebqsgmmzhbksxozc.supabase.co https://*.stripe.com https://nominatim.openstreetmap.org",
  "frame-src https://js.stripe.com https://hooks.stripe.com https://*.stripe.network",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-DNS-Prefetch-Control", value: "on" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=(self), payment=(self)" },
  { key: "Content-Security-Policy", value: CSP },
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
