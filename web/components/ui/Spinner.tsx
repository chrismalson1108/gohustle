import { Loader2 } from "lucide-react";
import { classNames } from "@/lib/format";

export default function Spinner({ className = "" }: { className?: string }) {
  return <Loader2 className={classNames("animate-spin text-primary", className)} />;
}

// Centered loading block. Despite the name, almost every call site renders this
// INSIDE a bounded container — the login card, the consent document column, a
// page section — so the default height is deliberately small (12rem). It used to
// be `min-h-[60vh]`, which inflated those containers to 60% of the viewport and
// then collapsed them the moment data arrived (a visible jump on every sign-in),
// and `vh` mis-measures on mobile Safari where the URL bar collapses.
//
// `className` REPLACES the default height rather than being appended to it: two
// competing min-height utilities on one element resolve by stylesheet order, not
// by author intent. Callers that genuinely own the whole page pass "min-h-dvh".
export function FullPageSpinner({ label, className = "min-h-48" }: { label?: string; className?: string }) {
  return (
    <div className={classNames("flex flex-col items-center justify-center gap-3", className)}>
      <Spinner className="size-8" />
      {label && <p className="text-sm text-ink-muted">{label}</p>}
    </div>
  );
}
