"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin, AdminAuthError, type AdminContext } from "@/lib/guard";
import { audit } from "@/lib/audit";

export interface ActionResult {
  ok: boolean;
  message: string;
}

// public.categories has SELECT and INSERT policies for authenticated users and
// deliberately no UPDATE or DELETE policy — "users create; moderators shape". So every
// action in this file only works because the console holds service role, and that also
// means trg_guard_category_write (which pins status/merged_into and runs the keyword
// filter for ordinary writers) returns early for us. The structural checks it would
// have applied are re-stated here; the only DB backstop still in force is the
// categories_label_len constraint.
const LABEL_MIN = 2;
const LABEL_MAX = 32;

// A gig whose booking is live has its core terms — title, category, location — pinned
// by guard_jobs_write so a poster cannot rewrite what someone already agreed to work.
// That trigger returns early for service_role, and this console IS service_role: there
// is nothing in the database to stop a merge here from silently changing the category
// of a gig somebody is halfway through. So the pin is mirrored in application code.
// Those gigs keep the label they were booked under and only their category_slug moves,
// which is what discovery joins on — so the merge still lands everywhere it matters.
const LIVE_BOOKING_STATUSES = ["confirmed", "completed", "verified"];

// PostgREST puts .in() lists in the query string, so ids go over in chunks.
const ID_CHUNK = 200;

// Ceiling on how many gigs one curation action rewrites. Hitting it is not a partial
// failure: the source is marked 'merged' BEFORE any gig is touched, and
// resolve_category_slug follows merged_into, so a gig left behind on the old slug still
// resolves to the target. Re-running the action picks up the rest.
const MAX_JOBS_PER_ACTION = 2000;

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function adminCtx() {
  return requireAdmin("admin");
}

// Mirror of validateCategoryLabel in shared/categories.js. The console is a standalone
// Next app with no shared/ dependency (see next.config.ts), the same reason
// safePhotoUrl in jobs/[id] restates the clients' storage-URL check rather than
// importing it. Keep the two in step.
function labelError(label: string): string | null {
  if (label.length < LABEL_MIN) return "That name is too short.";
  if (label.length > LABEL_MAX) return `Keep the name under ${LABEL_MAX} characters.`;
  if (!/[a-zA-Z]/.test(label)) return "A category name needs at least one letter.";
  if (/https?:\/\/|www\.|@|\d{7,}/i.test(label)) {
    return "A category name can't contain links, emails or phone numbers.";
  }
  return null;
}

function cleanLabel(raw: unknown): string {
  return String(raw ?? "").trim().replace(/\s+/g, " ").slice(0, LABEL_MAX + 1);
}

// Ask the database for a category's identity instead of reimplementing categorySlug()
// plus the alias table here. public.resolve_category_slug follows merged_into, and the
// alias table is curated at runtime by this very page — any local copy would be stale
// the first time a moderator merged two categories.
async function slugOf(ctx: AdminContext, text: string): Promise<string> {
  const { data, error } = await ctx.service.rpc("resolve_category_slug", { input: text });
  if (error) throw new Error(`Could not read the taxonomy: ${error.message}`);
  return typeof data === "string" ? data : "";
}

interface RepointResult {
  relabelled: number;
  pinned: number;
  remaining: number;
}

// Move every gig sitting on `fromSlug` over to `toSlug` / `toLabel`.
async function repointJobs(
  ctx: AdminContext,
  fromSlug: string,
  toSlug: string,
  toLabel: string,
): Promise<RepointResult> {
  const { data: rows, error } = await ctx.service
    .from("jobs")
    .select("id")
    .eq("category_slug", fromSlug)
    .limit(MAX_JOBS_PER_ACTION + 1);
  if (error) throw new Error(error.message);

  const all = (rows ?? []).map((r) => String(r.id));
  const remaining = Math.max(0, all.length - MAX_JOBS_PER_ACTION);
  const ids = all.slice(0, MAX_JOBS_PER_ACTION);
  if (ids.length === 0) return { relabelled: 0, pinned: 0, remaining: 0 };

  const pinned = new Set<string>();
  for (const part of chunked(ids, ID_CHUNK)) {
    const { data: live, error: liveErr } = await ctx.service
      .from("bookings")
      .select("job_id")
      .in("job_id", part)
      .in("status", LIVE_BOOKING_STATUSES);
    if (liveErr) throw new Error(liveErr.message);
    (live ?? []).forEach((b) => pinned.add(String(b.job_id)));
  }

  const free = ids.filter((id) => !pinned.has(id));
  const held = ids.filter((id) => pinned.has(id));

  // Free gigs: write the LABEL and let trg_y_normalize_job_category derive
  // category_slug from it. Sending a slug alongside would be theatre — the trigger
  // overwrites it — and would hide any disagreement between our value and the DB's.
  for (const part of chunked(free, ID_CHUNK)) {
    const { error: e } = await ctx.service.from("jobs").update({ category: toLabel }).in("id", part);
    if (e) throw new Error(e.message);
  }
  // Pinned gigs: repoint the identity only. Writing category_slug does not fire the
  // normalize trigger, which is bound to `category`, so the booked label survives.
  if (toSlug !== fromSlug) {
    for (const part of chunked(held, ID_CHUNK)) {
      const { error: e } = await ctx.service.from("jobs").update({ category_slug: toSlug }).in("id", part);
      if (e) throw new Error(e.message);
    }
  }

  return { relabelled: free.length, pinned: held.length, remaining };
}

function tailNote(res: RepointResult): string {
  const bits: string[] = [];
  if (res.relabelled) bits.push(`${res.relabelled} gig${res.relabelled === 1 ? "" : "s"} relabelled`);
  if (res.pinned) {
    bits.push(
      `${res.pinned} with a live booking kept ${res.pinned === 1 ? "its" : "their"} agreed label (moved by slug only)`,
    );
  }
  if (res.remaining) bits.push(`${res.remaining} more still to move — run it again`);
  return bits.length ? ` ${bits.join("; ")}.` : "";
}

// Only user-created rows are curated here. A seeded category's label and identity ship
// inside shared/categories.js, and findCategory() prefers that catalog over the DB — so
// renaming or merging one from the console would look like it worked and change nothing
// in either app. Those belong in a code change plus a redeploy.
function communityOnly(status: string, label: string, verb: string): string {
  return `Only user-created categories can be ${verb} here — "${label}" is ${status}. A seeded category's label lives in shared/categories.js, so changing it here would not reach the apps.`;
}

export async function promoteCategory(formData: FormData): Promise<ActionResult> {
  const slug = String(formData.get("slug") ?? "").trim();
  const groupKey = String(formData.get("groupKey") ?? "").trim();
  if (!slug) return { ok: false, message: "Missing category." };

  let ctx;
  try {
    ctx = await adminCtx();
  } catch (e) {
    if (e instanceof AdminAuthError) return { ok: false, message: "Not authorized." };
    throw e;
  }

  try {
    const { data: row, error } = await ctx.service
      .from("categories")
      .select("slug, label, status")
      .eq("slug", slug)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) return { ok: false, message: "That category no longer exists." };
    if (row.status !== "community") return { ok: false, message: communityOnly(row.status, row.label, "promoted") };

    const patch: Record<string, unknown> = { status: "canonical", updated_at: new Date().toISOString() };
    if (groupKey) {
      // group_key is an FK, so a bad value would fail anyway — checking first turns a
      // raw constraint error into something a moderator can act on.
      const { data: group } = await ctx.service
        .from("category_groups")
        .select("key")
        .eq("key", groupKey)
        .maybeSingle();
      if (!group) return { ok: false, message: `No group called "${groupKey}".` };
      patch.group_key = groupKey;
    }

    await audit(ctx, "category.promote", "category", slug, { label: row.label, group_key: groupKey || null });

    const { error: upErr } = await ctx.service.from("categories").update(patch).eq("slug", slug);
    if (upErr) throw new Error(upErr.message);

    revalidatePath("/categories");
    return {
      ok: true,
      // Say what promoting does NOT do: it changes ranking and curation status, not
      // what an offline / not-yet-updated app shows for the category.
      message: `"${row.label}" is now canonical. Add it to CATEGORY_CATALOG in shared/categories.js so the apps carry it offline too.`,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export async function renameCategory(formData: FormData): Promise<ActionResult> {
  const slug = String(formData.get("slug") ?? "").trim();
  const label = cleanLabel(formData.get("label"));
  if (!slug) return { ok: false, message: "Missing category." };
  const invalid = labelError(label);
  if (invalid) return { ok: false, message: invalid };

  let ctx;
  try {
    ctx = await adminCtx();
  } catch (e) {
    if (e instanceof AdminAuthError) return { ok: false, message: "Not authorized." };
    throw e;
  }

  try {
    const { data: row, error } = await ctx.service
      .from("categories")
      .select("slug, label, status")
      .eq("slug", slug)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) return { ok: false, message: "That category no longer exists." };
    if (row.status !== "community") return { ok: false, message: communityOnly(row.status, row.label, "renamed") };
    if (row.label === label) return { ok: false, message: "That is already the name." };

    const newSlug = await slugOf(ctx, label);
    if (!newSlug) return { ok: false, message: "Use letters and numbers in the name." };

    // The slug is the identity — gigs, saved searches and profile skills all reference
    // it — so a rename never moves it. When the new spelling normalizes to a DIFFERENT
    // slug, that spelling is recorded as a merge alias pointing back here. Without it,
    // the next gig posted under the new name would slug to something with no row and
    // mint a duplicate of the category we just renamed.
    let aliasSlug: string | null = null;
    if (newSlug !== slug) {
      const { data: clash } = await ctx.service
        .from("categories")
        .select("slug, label, merged_into")
        .eq("slug", newSlug)
        .maybeSingle();
      if (clash && clash.merged_into !== slug) {
        return {
          ok: false,
          message: `"${label}" already belongs to the category "${clash.label}". Merge into it instead of renaming.`,
        };
      }
      if (!clash) aliasSlug = newSlug;
    }

    await audit(ctx, "category.rename", "category", slug, { from: row.label, to: label, alias: aliasSlug });

    if (aliasSlug) {
      // Alias rows carry their slug as the label, matching the merge aliases seeded by
      // 20260805000000 — they are never selectable, so there is nothing to display.
      const { error: aliasErr } = await ctx.service.from("categories").insert({
        slug: aliasSlug,
        label: aliasSlug.slice(0, LABEL_MAX),
        group_key: "general",
        status: "merged",
        merged_into: slug,
      });
      // Fatal on purpose: without the alias, relabelling the gigs below would make the
      // normalize trigger mint a fresh category for the new spelling and fork the very
      // category being renamed.
      if (aliasErr) throw new Error(`Could not record the new spelling: ${aliasErr.message}`);
    }

    const { error: upErr } = await ctx.service
      .from("categories")
      .update({ label, updated_at: new Date().toISOString() })
      .eq("slug", slug);
    if (upErr) throw new Error(upErr.message);

    const res = await repointJobs(ctx, slug, slug, label);

    revalidatePath("/categories");
    revalidatePath("/jobs");
    return { ok: true, message: `Renamed to "${label}".${tailNote(res)}` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export async function mergeCategory(formData: FormData): Promise<ActionResult> {
  const slug = String(formData.get("slug") ?? "").trim();
  const targetRaw = String(formData.get("target") ?? "").trim();
  if (!slug || !targetRaw) return { ok: false, message: "Pick a category to merge into." };

  let ctx;
  try {
    ctx = await adminCtx();
  } catch (e) {
    if (e instanceof AdminAuthError) return { ok: false, message: "Not authorized." };
    throw e;
  }

  try {
    const { data: source, error } = await ctx.service
      .from("categories")
      .select("slug, label, status, usage_count")
      .eq("slug", slug)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!source) return { ok: false, message: "That category no longer exists." };
    if (source.status !== "community") return { ok: false, message: communityOnly(source.status, source.label, "merged") };

    const targetSlug = await slugOf(ctx, targetRaw);
    if (!targetSlug) return { ok: false, message: `"${targetRaw}" is not a usable category name.` };
    if (targetSlug === slug) return { ok: false, message: "A category cannot merge into itself." };

    const { data: target } = await ctx.service
      .from("categories")
      .select("slug, label, status, usage_count")
      .eq("slug", targetSlug)
      .maybeSingle();
    if (!target) {
      return { ok: false, message: `No category matches "${targetRaw}" — pick one from the suggestions.` };
    }
    // Merging into a merged or reserved row would either build a chain (resolution is
    // bounded at four hops and would silently stop) or park gigs on a control value the
    // browse chips refuse to show.
    if (target.status !== "canonical" && target.status !== "community") {
      return { ok: false, message: `"${target.label}" is ${target.status} and cannot be a merge target.` };
    }

    await audit(ctx, "category.merge", "category", slug, {
      label: source.label,
      into: targetSlug,
      into_label: target.label,
      usage_count: source.usage_count,
    });

    // Mark the merge FIRST. resolve_category_slug follows merged_into, so from this
    // moment every new write and every alias-aware client already lands on the target.
    // That is what makes the gig repoint below safe to bound and safe to re-run.
    const { error: mergeErr } = await ctx.service
      .from("categories")
      .update({ status: "merged", merged_into: targetSlug, updated_at: new Date().toISOString() })
      .eq("slug", slug);
    if (mergeErr) throw new Error(mergeErr.message);

    const res = await repointJobs(ctx, slug, targetSlug, target.label);

    // Usage follows the gigs, so the merged category stops out-ranking real ones in the
    // picker's "most used" ordering.
    const moved = res.relabelled + res.pinned;
    if (moved > 0) {
      await ctx.service
        .from("categories")
        .update({ usage_count: (target.usage_count ?? 0) + moved })
        .eq("slug", targetSlug);
      await ctx.service
        .from("categories")
        .update({ usage_count: Math.max(0, (source.usage_count ?? 0) - moved) })
        .eq("slug", slug);
    }

    revalidatePath("/categories");
    revalidatePath("/jobs");
    return { ok: true, message: `"${source.label}" now folds into "${target.label}".${tailNote(res)}` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
