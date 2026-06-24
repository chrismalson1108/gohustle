import { classNames } from "@/lib/format";

// GoHustlr wordmark. `light` renders white-on-dark (for gradient hero surfaces).
export default function Logo({ light = false, className = "" }: { light?: boolean; className?: string }) {
  return (
    <span className={classNames("inline-flex items-center text-2xl font-black tracking-tight", className)}>
      <span className={light ? "text-white" : "text-ink"}>Go</span>
      <span
        className={classNames(
          "bg-clip-text text-transparent",
          light ? "bg-gradient-to-r from-white to-purple-200" : "bg-brand",
        )}
        style={!light ? { WebkitBackgroundClip: "text", backgroundImage: "var(--background-image-brand)" } : undefined}
      >
        Hustlr
      </span>
    </span>
  );
}
