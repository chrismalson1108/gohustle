import Link from "next/link";
import { FUNCTIONS_URL, SUPABASE_ANON_KEY } from "@/lib/config";
import BrandShell, { BrandLockup } from "@/components/brand/BrandShell";

export const metadata = { title: "Confirm your email · Hustlr" };
// The token is in the URL and the answer depends on it, so there is nothing to cache
// and a cached "already confirmed" served to the next visitor would be wrong.
export const dynamic = "force-dynamic";

// The landing page for the button in the confirmation email.
//
// A SERVER component that does the work on load: the token never reaches the browser's
// JS, there is no loading flash, and no client bundle ships for a page somebody sees
// once. Confirming is idempotent and safe to repeat, which is why it is allowed to
// happen on a plain page load — unsubscribe, which is not, has a button instead.
export default async function WaitlistConfirmPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const token = (await searchParams).token ?? "";

  let ok = false;
  let email: string | null = null;
  let reachable = true;
  if (token) {
    try {
      const res = await fetch(`${FUNCTIONS_URL}/waitlist-submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
        body: JSON.stringify({ op: "confirm", token }),
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      ok = res.ok && data.ok === true;
      email = typeof data.email === "string" ? data.email : null;
    } catch {
      // The one case the server never gets to answer. Distinct from a bad token: we
      // must not tell someone their link is invalid when it is our own network that
      // failed — they would give up on a link that still works.
      reachable = false;
    }
  }

  return (
    <BrandShell className="min-h-dvh bg-canvas">
      <main className="mx-auto flex min-h-dvh max-w-[560px] flex-col justify-center px-5 py-16">
        <div className="mb-8">
          <BrandLockup />
        </div>
        {ok ? (
          <>
            <h1 className="m-0 mb-3 text-[32px] leading-tight font-bold text-ink">You&rsquo;re on the list.</h1>
            <p className="m-0 mb-6 text-[17px] leading-[1.6] text-ink-soft">
              {email ? (
                <>
                  <strong className="font-semibold text-ink">{email}</strong> is confirmed. We&rsquo;ll email you
                  once — the day Hustlr opens near you. Nothing else.
                </>
              ) : (
                <>Your email is confirmed. We&rsquo;ll write once, the day Hustlr opens near you.</>
              )}
            </p>
          </>
        ) : !reachable ? (
          <>
            <h1 className="m-0 mb-3 text-[32px] leading-tight font-bold text-ink">We couldn&rsquo;t reach us.</h1>
            <p className="m-0 mb-6 text-[17px] leading-[1.6] text-ink-soft">
              Something on our side is down. Your link is still good — open it again in a minute.
            </p>
          </>
        ) : (
          <>
            <h1 className="m-0 mb-3 text-[32px] leading-tight font-bold text-ink">That link has expired.</h1>
            <p className="m-0 mb-6 text-[17px] leading-[1.6] text-ink-soft">
              It may already have been used, or the address may have been removed. Joining again takes a
              second.
            </p>
          </>
        )}
        <div className="flex flex-wrap gap-3">
          <Link
            href="/#waitlist"
            className="inline-flex items-center rounded-xl bg-primary px-6 py-3.5 text-[16px] font-semibold text-white transition hover:bg-primary-dark"
          >
            {ok ? "Back to gohustlr.com" : "Join the waitlist"}
          </Link>
          <Link
            href="/contact"
            className="inline-flex items-center rounded-xl border-2 border-line px-6 py-3 text-[16px] font-semibold text-ink transition hover:border-primary hover:text-primary"
          >
            Contact us
          </Link>
        </div>
      </main>
    </BrandShell>
  );
}
