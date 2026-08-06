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
// Only files something actually LOADS belong here. The web UI renders its logos as
// inline SVG and src/components/Logo.js requires straight out of shared/assets/brand,
// so the old web/public/brand/* and assets/brand/* raster copies were written on every
// sync and read by nothing — they were dropped in the pre-beta cleanup. Adding a copy
// back is only correct if a real import points at the destination path.
const COPIES = [
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
