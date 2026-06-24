import type { NextConfig } from "next";
import path from "node:path";

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
};

export default nextConfig;
