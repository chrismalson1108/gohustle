import { GraduationCap } from "lucide-react";
import { studentTrustLabel } from "@gohustlr/shared";

interface StudentLike {
  studentVerified?: boolean;
  student_verified?: boolean;
  studentStatus?: string;
  student_status?: string;
}

// "Verified Student / Alumni" pill. Renders nothing when not verified.
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
    <span className="inline-flex items-center gap-1 rounded-full bg-primary-light px-2 py-0.5 text-[11px] font-extrabold text-primary">
      <GraduationCap className={compact ? "size-3" : "size-3.5"} />
      {compact ? "Student" : label}
    </span>
  );
}
