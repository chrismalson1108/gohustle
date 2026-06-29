import Image from "next/image";
import { classNames } from "@/lib/format";

// Hustlr wordmark — a custom logo, never set in type. Served from /brand/*, which is
// kept in sync with the single source of truth (shared/assets/brand) via `npm run brand:sync`.
// `light` swaps to the orange wordmark for dark / Electric-Blue surfaces.
const RATIO = 1584 / 749; // intrinsic wordmark aspect ratio

export default function Logo({
  light = false,
  height = 32,
  className = "",
}: {
  light?: boolean;
  height?: number;
  className?: string;
}) {
  return (
    <Image
      src={light ? "/brand/wordmark-orange.png" : "/brand/wordmark-blue.png"}
      alt="Hustlr"
      width={Math.round(height * RATIO)}
      height={height}
      priority
      className={classNames("select-none", className)}
    />
  );
}
