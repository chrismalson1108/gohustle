import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminPage } from "@/lib/guard";
import { fmtDate } from "@/lib/format";
import { Section, Pill, statusTone } from "@/lib/ui";
import { auditRead } from "@/lib/audit";
import TakedownControls from "./TakedownControls";

export const metadata = { title: "Job detail" };

// jobs.photos is poster-controlled free text — RLS checks ownership, and no guard pins
// these to the project's storage host — so a poster can put any string in the array.
// Both user-facing clients already refuse to render one unless it is a genuine https
// Supabase public-storage URL (safeCertUrl in src/lib/certifications.js and its web
// twin). The admin console did not, and rendered them straight into href and src.
//
// That is the worst place to skip the check. An admin opening a flagged gig would make
// their browser fetch an attacker-chosen URL — confirming that a moderator looked, and
// leaking the admin's IP — from the one browser in the system holding service-role
// power. Same rule as the clients, so the three cannot drift.
function safePhotoUrl(url: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return null;
    if (!u.pathname.includes("/storage/v1/object/public/")) return null;
    return url;
  } catch {
    return null;
  }
}

export default async function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminPage("support");
  const { id } = await params;

  const { data: job } = await ctx.service.from("jobs").select("*").eq("id", id).maybeSingle();
  if (!job) notFound();
  const photos: string[] = job.photos ?? [];
  await auditRead(ctx, "job.view", "job", id);

  const [posterRes, slotsRes, bookingsRes, categoryRes] = await Promise.all([
    ctx.service.from("profiles").select("id, name, username").eq("id", job.poster_id).maybeSingle(),
    ctx.service.from("job_slots").select("id, label, taken").eq("job_id", id),
    ctx.service.from("bookings").select("id, earner_id, status, slot_label, created_at").eq("job_id", id).order("created_at", { ascending: false }),
    // The category is user-authored free text now — a poster can invent one by typing
    // it — so a moderator looking at a flagged gig needs to know whether its category is
    // a curated one or something this poster made up, and get to it in one click.
    job.category_slug
      ? ctx.service.from("categories").select("slug, status").eq("slug", job.category_slug).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const category = categoryRes.data;

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
          <div>
            <dt className="text-[var(--muted)]">Category</dt>
            <dd className="flex flex-wrap items-center gap-2">
              {job.category_slug ? (
                <Link href={`/jobs?cat=${encodeURIComponent(job.category_slug)}`} className="text-[var(--brand)] hover:underline">
                  {job.category || job.category_slug}
                </Link>
              ) : (
                // Null slug means the value normalized away or collided with one of the
                // app's reserved control words, so the gig is filed nowhere.
                <span>{job.category || "—"}</span>
              )}
              {category?.status === "community" && (
                <Link href={`/categories?status=community&q=${encodeURIComponent(category.slug)}`}>
                  <Pill tone="amber">user-created</Pill>
                </Link>
              )}
              {!job.category_slug && <Pill tone="gray">unfiled</Pill>}
            </dd>
          </div>
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
            {photos.map((url, i) => {
              const safe = safePhotoUrl(url);
              if (!safe) {
                // Show that a photo exists and was refused, rather than hiding it —
                // an off-platform URL on a gig is itself worth a moderator seeing.
                return (
                  <div
                    key={i}
                    title={url}
                    className="flex h-40 w-40 items-center justify-center rounded-lg border border-dashed border-[var(--line)] p-2 text-center text-xs text-[var(--muted)]"
                  >
                    Photo {i + 1} not shown — off-platform URL
                  </div>
                );
              }
              return (
                <a key={i} href={safe} target="_blank" rel="noreferrer noopener">
                  <img src={safe} alt={`job photo ${i + 1}`} className="h-40 w-40 rounded-lg border border-[var(--line)] object-cover" />
                </a>
              );
            })}
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
