import Image from "next/image";
import { classNames } from "@/lib/format";

// Hustlr logo — a custom mark, never set in type. Served from /brand/*, which is kept
// in sync with the single source of truth (shared/assets/brand) via `npm run brand:sync`.
// `light` swaps to the orange variant for dark / Electric-Blue surfaces. `mark` renders
// the compact H-monogram instead of the full wordmark (used in the app sidebar).
const WORDMARK_RATIO = 1584 / 749; // intrinsic aspect ratio of wordmark-*.png
const MONOGRAM_RATIO = 542 / 741; // intrinsic aspect ratio of monogram-*.png

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
      src={`/brand/${variant}-${light ? "orange" : "blue"}.png`}
      alt="Hustlr"
      width={Math.round(height * ratio)}
      height={height}
      priority
      className={classNames("select-none", className)}
    />
  );
}
