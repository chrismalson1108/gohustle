import Link from "next/link";
import { requireAdminPage } from "@/lib/guard";
import { auditRead } from "@/lib/audit";
import { fmtDate } from "@/lib/format";
import { Section, Pill } from "@/lib/ui";
import CurationControls, { type GroupOption } from "./CurationControls";

export const metadata = { title: "Categories" };

const PAGE_SIZE = 100;

// The gig taxonomy is user-extensible: posting a gig with a category nobody has used
// before mints a 'community' row (trg_y_normalize_job_category), live immediately. That
// is the whole point — a snow-removal or mobile-mechanic gig should not have to
// masquerade as "Odd Jobs" — but it only works if someone curates afterwards. Until
// this page there was no afterwards: categories has no UPDATE or DELETE policy, so
// promoting, renaming or folding away a duplicate needed the SQL editor, and a
// moderator had no way at all to act on an abusive user-invented category.
const STATUSES = [
  { key: "community", label: "Review queue" },
  { key: "canonical", label: "Canonical" },
  { key: "merged", label: "Merged" },
  { key: "reserved", label: "Reserved" },
  { key: "", label: "All" },
];

function statusPill(status: string) {
  if (status === "canonical") return <Pill tone="green">canonical</Pill>;
  if (status === "community") return <Pill tone="amber">community</Pill>;
  if (status === "merged") return <Pill tone="gray">merged</Pill>;
  return <Pill tone="blue">{status}</Pill>;
}

export default async function CategoriesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string }>;
}) {
  const ctx = await requireAdminPage("support");
  const sp = await searchParams;
  // The review queue is the default view — it is the reason to open this page.
  const status = sp.status === undefined ? "community" : sp.status;
  const search = sp.q?.trim() ?? "";
  await auditRead(ctx, "categories.view", "categories", undefined, { status: status || "all", q: search || undefined });

  let query = ctx.service
    .from("categories")
    .select("slug, label, group_key, status, merged_into, base_rate, usage_count, created_by, created_at", {
      count: "exact",
    })
    .order("usage_count", { ascending: false })
    .order("slug")
    .limit(PAGE_SIZE);
  if (status) query = query.eq("status", status);
  if (search) {
    // Strip the PostgREST filter metacharacters before interpolating into .or(): a
    // comma or paren in the search box would otherwise rewrite the expression.
    const term = search.replace(/[%,()*\\]/g, " ").trim();
    if (term) query = query.or(`label.ilike.%${term}%,slug.ilike.%${term}%`);
  }

  const tallied = STATUSES.filter((s) => s.key);
  const [listRes, groupsRes, targetsRes, counts] = await Promise.all([
    query,
    ctx.service.from("category_groups").select("key, label").order("label"),
    // Suggestions for the merge box. Reserved and merged rows are excluded — merging
    // into either would build a resolution chain or park gigs on a control value.
    ctx.service.from("categories").select("slug, label").in("status", ["canonical", "community"]).order("label"),
    Promise.all(
      tallied.map((s) => ctx.service.from("categories").select("slug", { count: "exact", head: true }).eq("status", s.key)),
    ),
  ]);

  const countOf = new Map(tallied.map((s, i) => [s.key, counts[i]?.count ?? 0]));
  const groups: GroupOption[] = (groupsRes.data ?? []).map((g) => ({ key: g.key, label: g.label }));
  const groupLabel = new Map(groups.map((g) => [g.key, g.label]));
  const rows = listRes.data ?? [];
  const total = listRes.count ?? 0;

  const creatorIds = [...new Set(rows.map((r) => r.created_by).filter(Boolean))] as string[];
  const creators = creatorIds.length
    ? (await ctx.service.from("profiles").select("id, name, username").in("id", creatorIds)).data ?? []
    : [];
  const creatorOf = new Map(creators.map((p) => [p.id, p.username ? `@${p.username}` : p.name]));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Categories</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Anyone posting a gig can create a category, and it goes live immediately. This is where it
          gets curated afterwards — promoted, renamed, or folded into the category it duplicates.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <form method="GET" className="flex flex-1 gap-2">
          {/* Always carried, even when empty: an absent status means "not chosen",
              which falls back to the review queue — so omitting it here would throw the
              moderator off the All tab the moment they searched. */}
          <input type="hidden" name="status" value={status} />
          <input
            name="q"
            defaultValue={search}
            placeholder="Search name or slug…"
            className="min-w-0 flex-1 rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-sm"
          />
          <button className="rounded-lg bg-[var(--brand)] px-4 py-2 text-sm font-semibold text-white">Search</button>
        </form>
        <div className="flex flex-wrap gap-1 text-xs">
          {STATUSES.map((s) => {
            const href = new URLSearchParams();
            // 'All' is status='' and must be explicit in the URL — omitting the param
            // means "not chosen", which falls back to the review queue.
            href.set("status", s.key);
            if (search) href.set("q", search);
            return (
              <Link
                key={s.key || "all"}
                href={`/categories?${href.toString()}`}
                className={`rounded px-2 py-1.5 ${
                  status === s.key ? "bg-[var(--brand)] text-white" : "border border-[var(--line)]"
                }`}
              >
                {s.label}
                {s.key ? ` (${countOf.get(s.key) ?? 0})` : ""}
              </Link>
            );
          })}
        </div>
      </div>

      {listRes.error && <p className="text-sm text-[var(--danger)]">Failed to load: {listRes.error.message}</p>}

      <div className="rounded-xl border border-[var(--line)] bg-white px-4 py-3 text-xs text-[var(--muted)]">
        <strong className="text-[var(--ink)]">What a merge touches.</strong> The old category stops being
        selectable and every gig on it moves to the target. Gigs with a live booking (confirmed or later)
        keep the label they were booked under — <code className="font-mono">guard_jobs_write</code> pins a
        live gig&apos;s core terms so nobody&apos;s agreed job description changes underneath them, and this
        console mirrors that rather than using its service role to override it. Their{" "}
        <code className="font-mono">category_slug</code> still repoints, which is what browse, alerts and
        market stats join on, so the merge takes effect for discovery either way.
      </div>

      <Section title={`${STATUSES.find((s) => s.key === status)?.label ?? "All"} (${total})`}>
        {rows.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">
            {search
              ? `No category matches “${search}”.`
              : status === "community"
              ? "Queue is clear — no user-created categories waiting on review. 🎉"
              : "Nothing here."}
          </p>
        ) : (
          <ul className="divide-y divide-[var(--line)]">
            {rows.map((c) => (
              <li key={c.slug} className="flex flex-wrap items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{c.label}</span>
                    {statusPill(c.status)}
                    <span className="font-mono text-xs text-[var(--muted)]">{c.slug}</span>
                  </div>
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    {groupLabel.get(c.group_key) ?? c.group_key} · {c.usage_count} gig
                    {c.usage_count === 1 ? "" : "s"}
                    {c.base_rate != null ? ` · $${Number(c.base_rate)}/hr starting rate` : ""}
                    {c.merged_into ? ` · folds into ${c.merged_into}` : ""}
                  </p>
                  <p className="mt-0.5 text-xs text-[var(--muted)]">
                    {c.created_by ? (
                      <>
                        created by{" "}
                        <Link href={`/users/${c.created_by}`} className="text-[var(--brand)] hover:underline">
                          {creatorOf.get(c.created_by) ?? c.created_by.slice(0, 8)}
                        </Link>
                      </>
                    ) : (
                      // No creator means it came from the seed or the migration's
                      // backfill of categories that already existed in production.
                      "seeded"
                    )}{" "}
                    · {fmtDate(c.created_at)} ·{" "}
                    <Link href={`/jobs?cat=${encodeURIComponent(c.slug)}`} className="text-[var(--brand)] hover:underline">
                      view gigs
                    </Link>
                  </p>
                </div>
                <CurationControls
                  slug={c.slug}
                  label={c.label}
                  groupKey={c.group_key}
                  status={c.status}
                  groups={groups}
                  isAdmin={ctx.role === "admin"}
                />
              </li>
            ))}
          </ul>
        )}
        {total > rows.length && (
          <p className="mt-3 text-xs text-[var(--muted)]">
            Showing the {rows.length} most used of {total}. Use search to find a specific category.
          </p>
        )}
      </Section>

      <datalist id="category-merge-targets">
        {(targetsRes.data ?? []).map((t) => (
          <option key={t.slug} value={t.label} />
        ))}
      </datalist>
    </div>
  );
}
