import ConnectReturnStatus from "./ConnectReturnStatus";

export const metadata = { title: "Payout Setup • GoHustlr" };

// Public landing page Stripe Connect redirects to after Express onboarding.
// Lives on the web app (NOT a Supabase Edge Function) because the functions
// gateway forces text/plain + nosniff on browser responses, so HTML served from
// /functions/v1/* renders as raw source. Vercel serves real text/html.
//
// This stays a Server Component purely to keep the `metadata` export (only Server
// Components may export it — Next 16). All the live status logic is in the client
// child, which is where the real fix lives: this page used to hard-code "Payout
// setup complete — your bank account is connected", which was a lie whenever the
// user tapped "Skip for now" during onboarding. Stripe redirects here either way,
// so they'd read a success screen and then find payouts still off one tap later.
export default function ConnectReturnPage() {
  return <ConnectReturnStatus />;
}
