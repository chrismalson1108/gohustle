import { BOOKING_STATUS } from "@gohustlr/shared";
import { CheckCircle2, Clock, RefreshCw, ShieldCheck, XCircle, Ban } from "lucide-react";
import { classNames } from "@/lib/format";
import type { BookingStatus } from "@/lib/types";

const ICONS: Record<string, typeof Clock> = {
  pending: Clock,
  confirmed: CheckCircle2,
  completed: RefreshCw,
  verified: ShieldCheck,
  declined: XCircle,
  cancelled: Ban,
};

// Semantic brand tints, mirroring src/components/BookingStatusBadge.js:
// green = confirmed/paid, red = declined, amber = awaiting the other party,
// neutral ink = in-flight / cancelled. The label still comes from the shared
// BOOKING_STATUS so both apps read identically, but the COLOURS there are a
// legacy six-hue set (#D97706 / #059669 / #4F46E5 / #DC2626 / #9CA3AF) that
// belongs to no palette — a list of bookings rendered as a rainbow. Retinting
// shared/lifecycle.js is the eventual single source of truth; until then this
// map keeps web on-token instead of inlining those hexes as style props.
const TINTS: Record<string, string> = {
  pending: "bg-warning-light text-warning-deep",
  confirmed: "bg-success-light text-success",
  completed: "bg-canvas text-ink-soft",
  verified: "bg-success-light text-success",
  declined: "bg-urgent-light text-urgent",
  cancelled: "bg-divider text-ink-soft",
};

export default function StatusBadge({ status }: { status: BookingStatus | string }) {
  const cfg = BOOKING_STATUS[status as BookingStatus] || BOOKING_STATUS.pending;
  const Icon = ICONS[status] || Clock;
  return (
    <span
      className={classNames(
        "inline-flex min-w-0 max-w-full shrink items-center gap-1.5 self-start rounded-full px-2.5 py-1 text-xs font-semibold",
        TINTS[status] || TINTS.pending,
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">{cfg.label}</span>
    </span>
  );
}
