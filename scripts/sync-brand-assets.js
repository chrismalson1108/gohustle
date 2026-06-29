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
const COPIES = [
  // ── Web: UI logos served from /brand/* ───────────────────────────────
  ["wordmark-blue.png", "web/public/brand/wordmark-blue.png"],
  ["wordmark-orange.png", "web/public/brand/wordmark-orange.png"],
  ["monogram-orange.png", "web/public/brand/monogram-orange.png"],
  ["monogram-blue.png", "web/public/brand/monogram-blue.png"],
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
  // ── Mobile: in-app <Image> logos ─────────────────────────────────────
  ["wordmark-blue.png", "assets/brand/wordmark-blue.png"],
  ["wordmark-orange.png", "assets/brand/wordmark-orange.png"],
  ["monogram-orange.png", "assets/brand/monogram-orange.png"],
  ["monogram-blue.png", "assets/brand/monogram-blue.png"],
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
