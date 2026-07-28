import { classNames } from "@/lib/format";
import { HustlrLockup, HustlrMark } from "@/components/brand/glyphs";

// Hustlr logo for in-app chrome. Renders the INLINE VECTOR from
// components/brand/glyphs, whose paths are lifted verbatim from the designer's own
// files — verified pixel-identical to Group 87 (44 differing pixels out of 292,800,
// i.e. edge antialiasing).
//
// This replaced a next/image PNG. Two reasons, one cosmetic and one structural:
//   • The PNG was a fixed-resolution raster scaled to whatever height the caller
//     asked for. Vector is exact at every size and DPR.
//   • The PNG version needed a hardcoded aspect ratio to size the <Image>, and that
//     constant went stale every single time the art changed — three times in this
//     rollout alone, each time silently stretching every logo in the app. An SVG
//     carries its own viewBox, so `w-auto` derives the width and there is no number
//     left to get wrong.
//
// `light` swaps to the Cream colourway for dark / Blue surfaces. `mark` renders the
// compact H-monogram instead of the full lockup (used in the app sidebar).
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
  const Glyph = mark ? HustlrMark : HustlrLockup;
  return (
    <Glyph
      role="img"
      aria-label="Hustlr"
      aria-hidden={undefined}
      style={{ height, width: "auto" }}
      className={classNames("select-none", light ? "text-[#FEF4E5]" : "text-[#3F25FE]", className)}
    />
  );
}
