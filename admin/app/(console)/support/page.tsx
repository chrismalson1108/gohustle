import Link from "next/link";
import { requireAdminPage } from "@/lib/guard";
import { fmtDate } from "@/lib/format";
import { Pill, statusTone } from "@/lib/ui";

export const metadata = { title: "Support" };

export default async function SupportPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const ctx = await requireAdminPage("support");
  const status = (await searchParams).status ?? "open";

  let q = ctx.service
    .from("support_tickets")
    .select("id, email, name, subject, category, status, last_message_at")
    .order("last_message_at", { ascending: false })
    .limit(100);
  if (status !== "all") q = q.eq("status", status);
  const { data: tickets, error } = await q;

  const TABS = ["open", "pending", "closed", "all"];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Support</h1>
        <div className="flex gap-2 text-sm">
          {TABS.map((t) => (
            <Link
              key={t}
              href={`/support?status=${t}`}
              className={`rounded-lg px-3 py-1.5 capitalize ${status === t ? "bg-[var(--brand)] text-white" : "border border-[var(--line)]"}`}
            >
              {t}
            </Link>
          ))}
        </div>
      </div>

      {error && <p className="text-sm text-[var(--danger)]">{error.message}</p>}

      <div className="overflow-x-auto rounded-xl border border-[var(--line)] bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--line)] text-left text-xs uppercase tracking-wide text-[var(--muted)]">
              <th className="px-4 py-3">Subject</th>
              <th className="px-4 py-3">From</th>
              <th className="px-4 py-3">Category</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Updated</th>
            </tr>
          </thead>
          <tbody>
            {(tickets ?? []).map((t) => (
              <tr key={t.id} className="border-b border-[var(--line)] last:border-0 hover:bg-[var(--surface)]">
                <td className="px-4 py-3">
                  <Link href={`/support/${t.id}`} className="font-medium text-[var(--brand)] hover:underline">
                    #{t.id} · {t.subject}
                  </Link>
                </td>
                <td className="px-4 py-3">{t.name ? `${t.name} · ` : ""}{t.email}</td>
                <td className="px-4 py-3">{t.category ?? "—"}</td>
                <td className="px-4 py-3"><Pill tone={statusTone(t.status)}>{t.status}</Pill></td>
                <td className="px-4 py-3">{fmtDate(t.last_message_at)}</td>
              </tr>
            ))}
            {(tickets ?? []).length === 0 && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-sm text-[var(--muted)]">No {status} tickets.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
