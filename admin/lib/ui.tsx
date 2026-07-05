import Link from "next/link";

// Small shared presentational helpers used across the console pages.

export function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-[var(--line)] bg-white p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--muted)]">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

const TONES = {
  red: "bg-red-100 text-red-700",
  green: "bg-emerald-100 text-emerald-700",
  gray: "bg-gray-100 text-gray-600",
  amber: "bg-amber-100 text-amber-700",
  blue: "bg-indigo-100 text-indigo-700",
} as const;

export function Pill({ tone, children }: { tone: keyof typeof TONES; children: React.ReactNode }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TONES[tone]}`}>{children}</span>;
}

export function StatCard({
  label,
  value,
  sub,
  href,
  tone,
}: {
  label: string;
  value: string | number;
  sub?: string;
  href?: string;
  tone?: "red" | "amber";
}) {
  const body = (
    <div
      className={`rounded-xl border bg-white p-4 ${
        tone === "red"
          ? "border-red-200"
          : tone === "amber"
          ? "border-amber-200"
          : "border-[var(--line)]"
      } ${href ? "transition hover:border-[var(--brand)] hover:shadow-sm" : ""}`}
    >
      <div className="text-xs uppercase tracking-wide text-[var(--muted)]">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-[var(--muted)]">{sub}</div>}
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

// Status → pill tone, shared by bookings/jobs/payments/tickets views.
export function statusTone(status: string): keyof typeof TONES {
  switch (status) {
    case "verified":
    case "captured":
    case "confirmed":
    case "closed":
      return "green";
    case "completed":
    case "authorized":
    case "pending":
    case "open":
      return "amber";
    case "cancelled":
    case "declined":
    case "failed":
      return "red";
    default:
      return "gray";
  }
}
