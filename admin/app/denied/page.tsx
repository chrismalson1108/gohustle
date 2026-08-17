import { signOutAction } from "../auth-actions";
import { getServerSupabase } from "@/lib/supabaseServer";
import { getServiceClient } from "@/lib/serviceClient";

// ─────────────────────────────────────────────────────────────────────────────
// Four different situations used to render one sentence.
//
// requireAdmin throws "forbidden" for no membership row, a PENDING row, a DISABLED
// row, and an active row whose role is too low for the page. This screen answered all
// four with "This account doesn't have access to this tool." — which is true of exactly
// one of them and actively misleading about the other three.
//
// It cost us on 2026-08-17. A newly invited admin enrolled his authenticator, passed the
// code prompt, landed here, and read it as "wrong account" — he had done everything
// right and was one click from being switched on. His next message was "I have other
// emails if I need to set it up through another one", which is the worst possible
// outcome: a second account, a second factor, and a second thing for someone to confirm.
// He said "But is signed in" three times, because he was, and the screen was telling him
// something that contradicted what he could see.
//
// "You're on the list, an admin has to flip a switch, do nothing" and "this account has
// no business here" are opposite messages. The gate stays exactly as strict — nothing
// below grants anything — but a person who is one approval away should be told so.
//
// ── ON DISCLOSURE ───────────────────────────────────────────────────────────
// This tells the signed-in person about THEIR OWN membership, and only after they have
// already presented a password and a TOTP code for that account. It reveals nothing
// about anyone else and nothing about what lies behind the gate. The generic string is
// kept for the case where there is genuinely no row, so someone who lands here by
// guessing still learns nothing.
// ─────────────────────────────────────────────────────────────────────────────

type Situation = "pending" | "disabled" | "role" | "none";

async function situation(): Promise<Situation> {
  try {
    const supa = await getServerSupabase();
    const { data: { user } } = await supa.auth.getUser();
    if (!user) return "none";
    const { data: row } = await getServiceClient()
      .from("admin_users")
      .select("status")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!row) return "none";
    if (row.status === "pending") return "pending";
    if (row.status === "disabled") return "disabled";
    // Active, so the denial was the role tier — they have access, just not to that page.
    return "role";
  } catch {
    // Never let a lookup failure turn the dead end into a 500. The generic copy is
    // correct-enough for every case and gives nothing away.
    return "none";
  }
}

const COPY: Record<Situation, { title: string; body: string }> = {
  pending: {
    title: "Waiting on approval",
    body:
      "You're signed in and your authenticator is set up — that part is done. An admin " +
      "still has to switch your access on, and they'll confirm with you first that the " +
      "authenticator that appeared was yours. Nothing else for you to do; signing in " +
      "again won't change it, and a different email would just create a second account " +
      "with the same problem.",
  },
  disabled: {
    title: "Access revoked",
    body: "This account's console access was turned off. Ask an admin if that's wrong.",
  },
  role: {
    title: "Not your access level",
    body:
      "Your account can reach the console, but not this page. Ask an admin if you need it.",
  },
  none: {
    title: "Not authorized",
    body: "This account doesn't have access to this tool.",
  },
};

export default async function DeniedPage() {
  const { title, body } = COPY[await situation()];

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-xl border border-[var(--line)] bg-white p-8 text-center shadow-sm">
        <h1 className="mb-2 text-xl font-semibold">{title}</h1>
        <p className="mb-6 text-sm leading-relaxed text-[var(--muted)]">{body}</p>
        <form action={signOutAction}>
          <button
            type="submit"
            className="w-full rounded-lg border border-[var(--line)] py-2 text-sm font-semibold"
          >
            Sign out
          </button>
        </form>
      </div>
    </main>
  );
}
