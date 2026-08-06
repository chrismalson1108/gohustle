#!/usr/bin/env node
/**
 * Re-renders the Hustlr brand raster pack for Brand Guidelines v3.0.
 *
 *   node scripts/gen-brand-assets-v3.js
 *   npm run brand:sync      # then distribute
 *
 * WHY THIS IS A RECOLOR, NOT A REPLACEMENT
 * ----------------------------------------
 * shared/assets/brand/vector/logo/ already holds v3 GEOMETRY — the pack was rebuilt
 * from the designer's vector in commit 4c1aaec ("rebuild the v3 pack from vector, in
 * the existing brand blue"). Only the blue was left on v2. Comparing the vector pack
 * with the designer's handoff confirmed it: the cream (#FEF4E5) and ink
 * (#363636) colorways are already byte-correct, the mark renders pixel-identically,
 * and the only stale value is #3F25FE -> #5038FF.
 *
 * The handoff bundle itself was removed in the pre-beta cleanup; the two SVGs it
 * uniquely supplied (appicon, mark-white) now live alongside the rest of the pack as
 * hustlr-appicon.svg / hustlr-mark-white.svg, so VEC is the single vector source.
 *
 * So the handoff's Stage 2 table ("wordmark-{...}.svg -> shared/assets/brand/") must
 * NOT be followed literally here. In this repo `wordmark-*.png` is the horizontal
 * LOCKUP — mark + "HUSTLR" in one raster — which src/components/Logo.js documents at
 * length and depends on. Dropping the handoff's text-only wordmark under that name
 * would delete the H-mark from AuthScreen, the only place a logo renders in the whole
 * mobile app, and leave Logo.js's hardcoded 11818/2401 ratio 13% wide.
 *
 * The 1.068 / 0.472 mark-to-wordmark construction the handoff specifies is therefore
 * already baked into hustlr-lockup-*.svg. Verified against its path geometry:
 *   mark height / wordmark height = 1913.86 / 1792 = 1.06800   (spec 1.068)
 *   gap / wordmark height         =  846.11 / 1792 = 0.47216   (spec 0.472)
 *
 * SIZING RULE: every output reuses the CURRENT file's canvas size and its art-fill
 * fraction, so the only thing that changes on screen is the colour. That keeps
 * Logo.js's ratio constants valid and keeps this a no-layout-change commit.
 */
const fs = require('fs');
const path = require('path');
const sharp = require(path.join(__dirname, '..', 'web', 'node_modules', 'sharp'));

const ROOT = path.resolve(__dirname, '..');
const BRAND = path.join(ROOT, 'shared', 'assets', 'brand');
const VEC = path.join(BRAND, 'vector', 'logo');

const V2_BLUE = /#3F25FE/gi;
const V3_BLUE = '#5038FF';

// Art box for the marks that sit on a 1024 canvas, carried over from the v2 files
// these replace. DECLARED rather than measured: reading it back off the output is how
// this broke once — sharp's `.trim().metadata()` reports the INPUT dimensions, not the
// trimmed ones, so the "measured" box came back as the full 1024x1024 and every mark
// was scaled to fill the canvas edge to edge.
//
// The sizes matter. Android masks an adaptive icon to an arbitrary shape and only
// guarantees the central ~66% (≈676px) survives, so a full-bleed foreground is clipped
// on every device — and android-monochrome doubles as the push notification small icon.
// The splash uses the same restraint so it cannot bleed at any device size.
const ART_BOX = {
  'android-foreground.png': { w: 543, h: 355 },
  'android-monochrome.png': { w: 543, h: 355 },
  'splash-icon.png':        { w: 500, h: 326 },
};

// ── 1. Recolor the vector source of truth ───────────────────────────────────
function recolorVectors() {
  const touched = [];
  for (const f of fs.readdirSync(VEC).filter((n) => n.endsWith('.svg'))) {
    const p = path.join(VEC, f);
    const before = fs.readFileSync(p, 'utf8');
    const after = before.replace(V2_BLUE, V3_BLUE);
    if (after !== before) {
      fs.writeFileSync(p, after);
      touched.push(f);
    }
  }
  return touched;
}

// Render an SVG so its ART (ignoring viewBox padding) fits the `box` the current file
// uses, then centre it on the canvas. Fitting to the whole box rather than to height
// alone matters: the mark is 1.53:1, so a height-only fit overflows a square canvas.
async function markOnCanvas(svg, canvasW, canvasH, box, background) {
  const big = await sharp(svg).resize({ height: Math.max(box.h * 4, 1200) }).png().toBuffer();
  const trimmed = await sharp(big)
    .trim({ threshold: 1 })
    .resize({ width: box.w, height: box.h, fit: 'inside' })
    .png()
    .toBuffer();
  const m = await sharp(trimmed).metadata();
  return sharp({
    create: { width: canvasW, height: canvasH, channels: 4, background: background || { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: trimmed, top: Math.round((canvasH - m.height) / 2), left: Math.round((canvasW - m.width) / 2) }])
    .png()
    .toBuffer();
}

async function dims(f) {
  try { const m = await sharp(f).metadata(); return `${m.width}x${m.height}`; } catch { return 'missing'; }
}

(async () => {
  const changed = recolorVectors();
  console.log(`recolored ${changed.length} vector file(s): ${changed.join(', ')}\n`);

  const jobs = [];

  // Lockups -> wordmark-*.png. The full padded viewBox is rendered (NOT trimmed), so
  // the framing — and therefore Logo.js's 11818/2401 ratio — is preserved exactly.
  for (const tone of ['blue', 'cream', 'ink']) {
    jobs.push({
      out: path.join(BRAND, `wordmark-${tone}.png`),
      make: () => sharp(path.join(VEC, `hustlr-lockup-${tone}.svg`)).resize(1560, 317, { fit: 'fill' }).png().toBuffer(),
    });
  }

  // Marks -> monogram-*.png, same padded-viewBox rule.
  for (const tone of ['blue', 'cream']) {
    jobs.push({
      out: path.join(BRAND, `monogram-${tone}.png`),
      make: () => sharp(path.join(VEC, `hustlr-mark-${tone}.svg`)).resize(620, 404, { fit: 'fill' }).png().toBuffer(),
    });
  }

  // App icon — the one genuinely NEW piece of art in v3: blue field + cream mark,
  // already composed by the designer. Opaque; Apple does not mask transparency well.
  jobs.push({
    out: path.join(BRAND, 'app-icon.png'),
    make: () => sharp(path.join(VEC, 'hustlr-appicon.svg'))
      .resize(1024, 1024, { fit: 'fill' }).flatten({ background: V3_BLUE }).png().toBuffer(),
  });

  // Android adaptive background: solid v3 blue, per the handoff.
  jobs.push({
    out: path.join(BRAND, 'android-background.png'),
    make: () => sharp({ create: { width: 1024, height: 1024, channels: 4, background: V3_BLUE } }).png().toBuffer(),
  });

  // Adaptive foreground sits ON that blue, so it uses the CREAM mark. Art height is
  // matched to the current file so the safe-zone padding is unchanged.
  const fgArt = ART_BOX['android-foreground.png'];
  jobs.push({
    out: path.join(BRAND, 'android-foreground.png'),
    make: () => markOnCanvas(path.join(VEC, 'hustlr-mark-cream.svg'), 1024, 1024, fgArt),
  });

  // Android 13 themed icon + the expo-notifications small icon read this as a pure
  // alpha mask, so the fill colour is irrelevant — only the silhouette matters.
  const monoArt = ART_BOX['android-monochrome.png'];
  jobs.push({
    out: path.join(BRAND, 'android-monochrome.png'),
    make: () => markOnCanvas(path.join(VEC, 'hustlr-mark-white.svg'), 1024, 1024, monoArt),
  });

  // OG / Twitter card. MUST stay exactly 1200x630 — web/app/layout.tsx declares no
  // openGraph.images and no twitter.images, so Next derives both from this file.
  jobs.push({
    out: path.join(BRAND, 'og-image.png'),
    make: async () => {
      const lockup = await sharp(path.join(VEC, 'hustlr-lockup-cream.svg')).resize({ width: 760 }).png().toBuffer();
      const m = await sharp(lockup).metadata();
      return sharp({ create: { width: 1200, height: 630, channels: 4, background: V3_BLUE } })
        .composite([{ input: lockup, top: Math.round((630 - m.height) / 2), left: Math.round((1200 - m.width) / 2) }])
        .png().toBuffer();
    },
  });

  // Splash mark. Hand-maintained (NOT in scripts/sync-brand-assets.js), so it is
  // written straight to assets/ and would otherwise silently stay on v2 art.
  const splash = path.join(ROOT, 'assets', 'splash-icon.png');
  const splashArt = ART_BOX['splash-icon.png'];
  jobs.push({
    out: splash,
    make: () => markOnCanvas(path.join(VEC, 'hustlr-mark-blue.svg'), 1024, 1024, splashArt),
  });

  for (const j of jobs) {
    const before = await dims(j.out);
    fs.writeFileSync(j.out, await j.make());
    const after = await dims(j.out);
    const rel = path.relative(ROOT, j.out);
    // Canvas AND art box. Canvas alone is not enough — it is identical whether the
    // mark is correctly inset or scaled to fill the whole square.
    let art = '';
    try { const b = await artBoxOf(j.out); art = `  art ${b.w}x${b.h}`; } catch { /* opaque */ }
    console.log(`${after === before ? ' ok ' : ' !! '} ${rel.padEnd(44)} ${after}${art}`);
  }
})();

// True bounding box of the non-transparent art. NOTE `.trim().metadata()` does NOT
// work here — on a Sharp pipeline metadata() describes the INPUT, so it reports the
// untrimmed canvas. Only toBuffer's `info` carries the post-trim size.
async function artBoxOf(file) {
  const { info } = await sharp(file).trim({ threshold: 1 }).toBuffer({ resolveWithObject: true });
  return { w: info.width, h: info.height };
}
