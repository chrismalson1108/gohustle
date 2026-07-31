import { GraduationCap } from "lucide-react";
import { studentTrustLabel } from "@gohustlr/shared";
import { classNames } from "@/lib/format";

interface StudentLike {
  studentVerified?: boolean;
  student_verified?: boolean;
  studentStatus?: string;
  student_status?: string;
}

// "Verified Student / Alumni" pill. Renders nothing when not verified.
// Mirrors src/components/StudentBadge.js: the 10px chip radius (this is the
// secondary badge class, not a pill), 11px/600 primary on primary-light, and a
// shrinkable label — without `min-w-0 shrink truncate` the badge pushes the
// rating and spacer off the end of a job card's poster row instead of
// ellipsizing itself.
export default function StudentBadge({
  profile,
  compact = false,
}: {
  profile: StudentLike | null | undefined;
  compact?: boolean;
}) {
  const label = studentTrustLabel(profile ?? null);
  if (!label) return null;
  return (
    <span
      className={classNames(
        "inline-flex min-w-0 shrink items-center gap-1 self-start rounded-lg bg-primary-light font-semibold text-primary",
        compact ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-[11px]",
      )}
    >
      <GraduationCap className={classNames("shrink-0", compact ? "size-2.5" : "size-3")} />
      <span className="truncate">{compact ? "Student" : label}</span>
    </span>
  );
}
