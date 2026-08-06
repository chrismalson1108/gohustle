#!/usr/bin/env node
/**
 * Distributes the canonical Hustlr brand assets (shared/assets/brand) into the
 * locations the web app and the mobile app expect. Run from the repo root:
 *
 *   npm run brand:sync
 *
 * Edit the source files in shared/assets/brand — never the copies this writes.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "shared", "assets", "brand");

// [sourceFileName, destinationPathRelativeToRepoRoot]
//
// Only files something actually LOADS belong here — but "loads" includes HTTP fetches
// from OUTSIDE this repo, not just import/require. That distinction cost us once: the
// pre-beta cleanup dropped web/public/brand/* after grepping for imports, and it took
// down the logo in 15 Supabase auth email templates plus student-verify-start, all of
// which hotlink https://gohustlr.com/brand/wordmark-cream.png. An import grep cannot
// see an <img src> in an email that Supabase renders.
//
// So before removing a destination here, grep for its URL as well as its path:
//   rg "gohustlr\.com/brand/|/brand/[a-z-]+\.png" --glob '!node_modules'
const COPIES = [
  // ── Web: publicly hotlinked by email templates. NOT dead — see above. ─
  ["wordmark-cream.png", "web/public/brand/wordmark-cream.png"],
  // ── Web: Next.js App Router file conventions ─────────────────────────
  ["app-icon.png", "web/app/icon.png"],
  ["app-icon.png", "web/app/apple-icon.png"],
  ["og-image.png", "web/app/opengraph-image.png"],
  // ── Mobile: icon slots referenced by app.json ────────────────────────
  ["app-icon.png", "assets/icon.png"],
  ["app-icon.png", "assets/favicon.png"],
  ["android-foreground.png", "assets/android-icon-foreground.png"],
  ["android-background.png", "assets/android-icon-background.png"],
  ["android-monochrome.png", "assets/android-icon-monochrome.png"],
];

let count = 0;
for (const [src, dest] of COPIES) {
  const from = path.join(SRC, src);
  const to = path.join(ROOT, dest);
  if (!fs.existsSync(from)) {
    console.error(`✗ missing source: shared/assets/brand/${src}`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  console.log(`  ✓ ${dest}`);
  count++;
}
console.log(`\nSynced ${count} brand files from shared/assets/brand → web + mobile.`);
