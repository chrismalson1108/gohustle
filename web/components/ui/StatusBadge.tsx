import { BOOKING_STATUS } from "@gohustlr/shared";
import { CheckCircle2, Clock, RefreshCw, ShieldCheck, XCircle, Ban } from "lucide-react";
import type { BookingStatus } from "@/lib/types";

const ICONS: Record<string, typeof Clock> = {
  pending: Clock,
  confirmed: CheckCircle2,
  completed: RefreshCw,
  verified: ShieldCheck,
  declined: XCircle,
  cancelled: Ban,
};

export default function StatusBadge({ status }: { status: BookingStatus | string }) {
  const cfg = BOOKING_STATUS[status as BookingStatus] || BOOKING_STATUS.pending;
  const Icon = ICONS[status] || Clock;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold"
      style={{ backgroundColor: cfg.bg, color: cfg.color }}
    >
      <Icon className="size-3.5" />
      {cfg.label}
    </span>
  );
}
