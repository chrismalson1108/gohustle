"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin, AdminAuthError } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { pathFromPublicUrl } from "@/lib/media";

export interface ActionResult {
  ok: boolean;
  message: string;
}

// Take a listing down (soft-delete = status 'cancelled', same as the poster's
// own delete). Service role bypasses guard_jobs_write. Audited.
export async function setJobStatus(formData: FormData): Promise<ActionResult> {
  const jobId = String(formData.get("jobId") ?? "");
  const status = String(formData.get("status") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!jobId || !["cancelled", "open"].includes(status)) return { ok: false, message: "Bad request." };

  let ctx;
  try {
    ctx = await requireAdmin("admin");
  } catch (e) {
    if (e instanceof AdminAuthError) return { ok: false, message: "Not authorized." };
    throw e;
  }
  try {
    const { error } = await ctx.service.from("jobs").update({ status }).eq("id", jobId);
    if (error) throw new Error(error.message);

    // On take-down, also purge the gig's photos from the public bucket (a
    // policy-violating image otherwise stays live at its URL). Best-effort.
    // SECURITY: jobs.photos is attacker-controlled free text, so only ever delete
    // objects under the POSTER's own folder and never a path containing ".." —
    // otherwise a crafted photos entry could make the service role delete another
    // user's (or another bucket's) file.
    let photosDeleted = 0;
    if (status === "cancelled") {
      const { data: job } = await ctx.service.from("jobs").select("photos, poster_id").eq("id", jobId).maybeSingle();
      const posterId = job?.poster_id as string | undefined;
      const paths = ((job?.photos as string[] | null) ?? [])
        .map((u) => pathFromPublicUrl(u, "job-photos"))
        .filter((p): p is string => !!p && !p.includes("..") && !!posterId && p.startsWith(`${posterId}/`));
      if (paths.length) {
        const { error: rmErr } = await ctx.service.storage.from("job-photos").remove(paths);
        if (!rmErr) {
          photosDeleted = paths.length;
          await ctx.service.from("jobs").update({ photos: [] }).eq("id", jobId);
        }
      }
    }

    await audit(ctx, status === "cancelled" ? "job.takedown" : "job.restore", "job", jobId, {
      reason: reason || undefined,
      photos_deleted: photosDeleted || undefined,
    });
    revalidatePath(`/jobs/${jobId}`);
    revalidatePath("/jobs");
    return {
      ok: true,
      message: status === "cancelled" ? `Taken down${photosDeleted ? ` (${photosDeleted} photo(s) removed)` : ""}.` : "Restored.",
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
