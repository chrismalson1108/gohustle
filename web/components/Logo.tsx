import Image from "next/image";
import { classNames } from "@/lib/format";

// Hustlr logo — served from /brand/*, kept in sync with the single source of truth
// in shared/assets/brand via `npm run brand:sync`. Redrawn from the v1.0 vector pack.
//
// `light` swaps to the Cream colourway for dark / Blue surfaces — this replaced the
// old Orange variant, which Brand Guidelines v1.0 retired. `mark` renders the compact
// H-monogram instead of the full wordmark (used in the app sidebar).
//
// Marketing and logged-out pages use the inline vector lockup in
// components/brand/BrandShell.tsx instead; this stays for the in-app chrome.
// Intrinsic aspect ratios of the PNGs in web/public/brand. RE-MEASURE THESE whenever
// the art is replaced — a stale ratio silently stretches every logo in the app.
// Note the v3 wordmark art is the full horizontal lockup (H-mark + "HUSTLR"), not
// text alone, which is why it is far wider than the version it replaced.
const WORDMARK_RATIO = 1560 / 379; // wordmark-*.png (the horizontal lockup)
const MONOGRAM_RATIO = 620 / 404; // monogram-*.png

export default function Logo({
  light = false,
  height = 32,
  mark = false,
  className = "",
}: {
  light?: boolean;
  height?: number;
  mark?: boolean;
  className?: string;
}) {
  const variant = mark ? "monogram" : "wordmark";
  const ratio = mark ? MONOGRAM_RATIO : WORDMARK_RATIO;
  return (
    <Image
      src={`/brand/${variant}-${light ? "cream" : "blue"}.png`}
      alt="Hustlr"
      width={Math.round(height * ratio)}
      height={height}
      priority
      className={classNames("select-none", className)}
    />
  );
}
