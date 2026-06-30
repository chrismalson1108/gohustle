import Link from "next/link";
import { ShieldCheck } from "lucide-react";

export const metadata = { title: "Identity Verification • GoHustlr" };

// Public landing page Stripe Identity redirects to after the document/selfie flow.
// The actual result arrives asynchronously via the stripe-webhook function (which
// flips profiles.verified), so this page just reassures the user. Hosted on the web
// app rather than a Supabase Edge Function — see connect-return for the why.
export default function IdentityReturnPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-6 py-12">
      <div className="w-full max-w-sm rounded-3xl bg-white p-8 text-center shadow-[var(--shadow-card)] ring-1 ring-line/70">
        <div className="mx-auto mb-5 flex size-16 items-center justify-center rounded-full bg-primary-light text-primary">
          <ShieldCheck className="size-9" />
        </div>
        <h1 className="font-display text-2xl font-black text-ink">Thanks — we&apos;re reviewing your ID</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          Your documents were submitted. Verification usually completes within a few minutes — your Verified
          badge appears once it&apos;s confirmed.
        </p>
        <Link
          href="/profile"
          className="mt-7 inline-flex w-full items-center justify-center rounded-2xl bg-primary px-6 py-3.5 font-bold text-white transition-colors hover:bg-primary-dark"
        >
          Return to GoHustlr
        </Link>
      </div>
    </main>
  );
}
