import type { Job } from "./types";

export function money(n: number | null | undefined, opts: { cents?: boolean } = {}): string {
  const v = Number(n ?? 0) / (opts.cents ? 100 : 1);
  return v % 1 === 0 ? `$${v.toFixed(0)}` : `$${v.toFixed(2)}`;
}

// "$25/hr" for hourly, "$120" for flat.
export function payLabel(job: Pick<Job, "pay" | "payType">): string {
  return job.payType === "hourly" ? `${money(job.pay)}/hr` : money(job.pay);
}

// Effective total value used for sorting/filtering (hourly × estimated hours).
export function effectivePay(job: Pick<Job, "pay" | "payType" | "estimatedHours">): number {
  return job.payType === "hourly" ? job.pay * (job.estimatedHours || 1) : job.pay;
}

export function initialOf(name?: string | null): string {
  return (name?.trim()?.charAt(0) || "?").toUpperCase();
}

export function shortDate(iso?: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

export function timeAgo(iso?: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

export function classNames(...xs: Array<string | false | null | undefined>): string {
  return xs.filter(Boolean).join(" ");
}
