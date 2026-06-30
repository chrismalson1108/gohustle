import Link from "next/link";
import { CheckCircle2 } from "lucide-react";

export const metadata = { title: "Payout Setup • GoHustlr" };

// Public landing page Stripe Connect redirects to after Express onboarding.
// Lives on the web app (NOT a Supabase Edge Function) because the functions
// gateway forces text/plain + nosniff on browser responses, so HTML served from
// /functions/v1/* renders as raw source. Vercel serves real text/html.
export default function ConnectReturnPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-6 py-12">
      <div className="w-full max-w-sm rounded-3xl bg-white p-8 text-center shadow-[var(--shadow-card)] ring-1 ring-line/70">
        <div className="mx-auto mb-5 flex size-16 items-center justify-center rounded-full bg-success-light text-success">
          <CheckCircle2 className="size-9" />
        </div>
        <h1 className="font-display text-2xl font-black text-ink">Payout setup complete</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          Your bank account is connected. Earnings are deposited automatically after a job is verified.
        </p>
        <Link
          href="/profile/payouts"
          className="mt-7 inline-flex w-full items-center justify-center rounded-2xl bg-primary px-6 py-3.5 font-bold text-white transition-colors hover:bg-primary-dark"
        >
          Return to GoHustlr
        </Link>
      </div>
    </main>
  );
}
