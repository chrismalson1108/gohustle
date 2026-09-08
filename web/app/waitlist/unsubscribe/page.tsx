import Link from "next/link";
import BrandShell, { BrandLockup } from "@/components/brand/BrandShell";
import UnsubscribeButton from "./UnsubscribeButton";

export const metadata = { title: "Unsubscribe · Hustlr" };
export const dynamic = "force-dynamic";

// The landing page for the "Unsubscribe" link in the footer of a waitlist email.
//
// It ASKS before it acts, and that is the whole point of the page existing. Corporate
// mail filters and link scanners fetch every URL in a message before a human sees it,
// so an unsubscribe that fired on page load would quietly empty the list one security
// appliance at a time. The edge function refuses `unsubscribe` on anything but POST for
// the same reason.
//
// RFC 8058 one-click is unaffected: the List-Unsubscribe header points straight at the
// function, and Gmail/Yahoo POST to it. This page is for the human who clicks.
export default async function WaitlistUnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const token = (await searchParams).token ?? "";

  return (
    <BrandShell className="min-h-dvh bg-canvas">
      <main className="mx-auto flex min-h-dvh max-w-[560px] flex-col justify-center px-5 py-16">
        <div className="mb-8">
          <BrandLockup />
        </div>
        {token ? (
          <UnsubscribeButton token={token} />
        ) : (
          <>
            <h1 className="m-0 mb-3 text-[32px] leading-tight font-bold text-ink">
              That link isn&rsquo;t complete.
            </h1>
            <p className="m-0 mb-6 text-[17px] leading-[1.6] text-ink-soft">
              Use the unsubscribe link at the bottom of any email we&rsquo;ve sent you, or write to us and
              we&rsquo;ll remove you by hand.
            </p>
            <div>
              <Link
                href="/contact"
                className="inline-flex items-center rounded-xl bg-primary px-6 py-3.5 text-[16px] font-semibold text-white transition hover:bg-primary-dark"
              >
                Contact us
              </Link>
            </div>
          </>
        )}
      </main>
    </BrandShell>
  );
}
