import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminPage } from "@/lib/guard";
import { fmtDate } from "@/lib/format";
import { Section, Pill, statusTone } from "@/lib/ui";
import { auditRead } from "@/lib/audit";
import TakedownControls from "./TakedownControls";

export const metadata = { title: "Job detail" };

export default async function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminPage("support");
  const { id } = await params;

  const { data: job } = await ctx.service.from("jobs").select("*").eq("id", id).maybeSingle();
  if (!job) notFound();
  const photos: string[] = job.photos ?? [];
  await auditRead(ctx, "job.view", "job", id);

  const [posterRes, slotsRes, bookingsRes] = await Promise.all([
    ctx.service.from("profiles").select("id, name, username").eq("id", job.poster_id).maybeSingle(),
    ctx.service.from("job_slots").select("id, label, taken").eq("job_id", id),
    ctx.service.from("bookings").select("id, earner_id, status, slot_label, created_at").eq("job_id", id).order("created_at", { ascending: false }),
  ]);

  const earnerIds = [...new Set((bookingsRes.data ?? []).map((b) => b.earner_id))];
  const earners = earnerIds.length
    ? (await ctx.service.from("profiles").select("id, name, username").in("id", earnerIds)).data ?? []
    : [];
  const earnerOf = new Map(earners.map((e) => [e.id, e.username ? `@${e.username}` : e.name]));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{job.title}</h1>
        <Pill tone={statusTone(job.status)}>{job.status}</Pill>
        {job.urgent && <Pill tone="amber">urgent</Pill>}
      </div>

      <Section title="Gig">
        <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm md:grid-cols-4">
          <div><dt className="text-[var(--muted)]">Category</dt><dd>{job.category}</dd></div>
          <div><dt className="text-[var(--muted)]">Pay</dt><dd>${Number(job.pay)}{job.pay_type === "hourly" ? "/hr" : " flat"}</dd></div>
          <div><dt className="text-[var(--muted)]">Location</dt><dd>{job.location}</dd></div>
          <div><dt className="text-[var(--muted)]">Posted</dt><dd>{fmtDate(job.created_at)}</dd></div>
          <div className="col-span-2">
            <dt className="text-[var(--muted)]">Poster</dt>
            <dd>
              <Link href={`/users/${job.poster_id}`} className="text-[var(--brand)] hover:underline">
                {posterRes.data ? (posterRes.data.username ? `@${posterRes.data.username}` : posterRes.data.name) : job.poster_id.slice(0, 8)}
              </Link>
            </dd>
          </div>
          <div className="col-span-4">
            <dt className="text-[var(--muted)]">Description</dt>
            <dd className="whitespace-pre-wrap">{job.description}</dd>
          </div>
        </dl>
      </Section>

      {photos.length > 0 && (
        <Section title={`Photos (${photos.length})`}>
          <div className="flex flex-wrap gap-3">
            {photos.map((url, i) => (
              <a key={i} href={url} target="_blank" rel="noreferrer noopener">
                <img src={url} alt={`job photo ${i + 1}`} className="h-40 w-40 rounded-lg border border-[var(--line)] object-cover" />
              </a>
            ))}
          </div>
        </Section>
      )}

      <Section title="Actions">
        <TakedownControls jobId={job.id} cancelled={job.status === "cancelled"} isAdmin={ctx.role === "admin"} />
      </Section>

      <div className="grid gap-6 md:grid-cols-2">
        <Section title={`Slots (${slotsRes.data?.length ?? 0})`}>
          {(slotsRes.data ?? []).length === 0 ? (
            <p className="text-sm text-[var(--muted)]">No slots.</p>
          ) : (
            <ul className="text-sm">
              {(slotsRes.data ?? []).map((s) => (
                <li key={s.id} className="flex justify-between border-t border-[var(--line)] py-1.5 first:border-0">
                  <span>{s.label}</span>
                  {s.taken ? <Pill tone="gray">taken</Pill> : <Pill tone="green">open</Pill>}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title={`Bookings (${bookingsRes.data?.length ?? 0})`}>
          {(bookingsRes.data ?? []).length === 0 ? (
            <p className="text-sm text-[var(--muted)]">No bookings.</p>
          ) : (
            <ul className="text-sm">
              {(bookingsRes.data ?? []).map((b) => (
                <li key={b.id} className="flex items-center justify-between border-t border-[var(--line)] py-2 first:border-0">
                  <Link href={`/bookings/${b.id}`} className="text-[var(--brand)] hover:underline">
                    {earnerOf.get(b.earner_id) ?? b.earner_id.slice(0, 8)}
                  </Link>
                  <span className="flex items-center gap-2 text-xs text-[var(--muted)]">
                    <Pill tone={statusTone(b.status)}>{b.status}</Pill>
                    {fmtDate(b.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}
