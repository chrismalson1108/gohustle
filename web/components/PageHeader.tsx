import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { classNames } from "@/lib/format";

// ── Content width system ──────────────────────────────────────────────────────
// The web app fills the viewport at any width (no app-wide max-w cap on the
// shell); what keeps it readable is a per-page-type measure. A header and the
// container beneath it MUST use the same width, or the title floats out of
// alignment with the content — the "ratios look off" problem this replaced.
//
//   feed    card grids and lists — goes very wide, the grid adds columns
//   content detail/profile reading pages — wide, but bounded for line length
//   form    single-column forms and settings — narrow, comfortable measure
export type PageWidth = "feed" | "content" | "form";

export const WIDTHS: Record<PageWidth, string> = {
  feed: "max-w-[1760px]",
  content: "max-w-[1120px]",
  form: "max-w-[760px]",
};

// Fluid gutters. Matches mobile's 20px screen padding at the small end and opens
// up on desktop so content never crowds the sidebar.
export const GUTTER = "px-4 sm:px-6 lg:px-8";

// Flat screen header — the replacement for the old gradient hero, mirroring
// mobile's ScreenHeader (src/components/ScreenHeader.js). Cream surface, ink
// text, no LinearGradient. Same children API as before, so pages migrate by
// recoloring their header children from white to ink.
export default function PageHeader({
  title,
  subtitle,
  right,
  children,
  width = "feed",
  back,
  className = "",
}: {
  title: string;
  subtitle?: string;
  /** Retired: every header is flat now. Kept so call sites don't need editing. */
  variant?: "brand" | "earn" | "gold";
  right?: React.ReactNode;
  children?: React.ReactNode;
  width?: PageWidth;
  /** Renders a back affordance above the title. A path string, or {href,label}.
   *  NOT a boolean — this said "`true` uses history.back()" and the body reads
   *  back.href, so `back` would have rendered a link to undefined. */
  back?: string | { href: string; label?: string };
  className?: string;
}) {
  return (
    <header className={classNames("bg-canvas pb-3 pt-6 sm:pt-8", GUTTER, className)}>
      <div className={classNames("mx-auto w-full", WIDTHS[width])}>
        {back && (
          <Link
            href={typeof back === "string" ? back : back.href}
            className="mb-3 inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline"
          >
            <ArrowLeft className="size-4" />
            {typeof back === "string" ? "Back" : (back.label ?? "Back")}
          </Link>
        )}
        <div className="flex items-start justify-between gap-3">
          {/* min-w-0 so a long title ellipsizes instead of shoving `right` off-screen. */}
          <div className="min-w-0 flex-1">
            {title && (
              <h1 className="truncate text-[26px] font-bold leading-tight tracking-[-0.02em] text-ink sm:text-[28px]">
                {title}
              </h1>
            )}
            {subtitle && <p className="mt-0.5 text-sm text-ink-soft">{subtitle}</p>}
          </div>
          {right && <div className="shrink-0">{right}</div>}
        </div>
        {children}
      </div>
    </header>
  );
}

export function PageContainer({
  children,
  className = "",
  width = "feed",
}: {
  children: React.ReactNode;
  className?: string;
  width?: PageWidth;
}) {
  // `className` goes on the INNER element, not the outer one: call sites pass
  // spacing utilities like `space-y-4`, which only affect an element's own
  // children — on the outer wrapper (whose single child is this inner div) they
  // would silently do nothing.
  return (
    <div className={classNames(GUTTER, "w-full py-4")}>
      <div className={classNames("mx-auto w-full", WIDTHS[width], className)}>{children}</div>
    </div>
  );
}

export function EmptyState({ icon, title, body }: { icon?: React.ReactNode; title: string; body?: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-16 text-center">
      {icon && <div className="text-ink-muted">{icon}</div>}
      <p className="font-bold text-ink">{title}</p>
      {body && <p className="max-w-xs text-sm text-ink-soft">{body}</p>}
    </div>
  );
}
