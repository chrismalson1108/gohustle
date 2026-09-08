import Link from "next/link";
import { Akshar, JetBrains_Mono } from "next/font/google";
import WaitlistForm from "@/components/waitlist/WaitlistForm";
// These three were module-private consts here. They moved out when the waitlist form
// became a separate client island: it cannot import a private const, and retyping the
// literals is how a fourth copy of a design token drifts.
import { display, overline, gutter } from "@/lib/landingTokens";
import {
  HustlrMark,
  HustlrWordmark,
  HustlrLockup,
  IconArrow,
  IconBriefcase,
  IconCampus,
  IconChat,
  IconHome,
  IconParttime,
  IconPerson,
  IconStar,
} from "@/components/brand/glyphs";
// The device mock deliberately uses Ionicons — the same set @expo/vector-icons
// renders in the shipped mobile app — so the screenshot matches what a user sees.
// Brand glyphs above stay on the marketing surfaces (categories, trust, pills).
import {
  IonBarChart,
  IonBookmark,
  IonBookmarkOutline,
  IonBriefcase,
  IonChatbubble,
  IonFlame,
  IonFlash,
  IonGrid,
  IonMap,
  IonMegaphone,
  IonOptions,
  IonPerson,
  IonPersonCircle,
  IonSearch,
  IonSparkles,
  IonStar,
  IonWifi,
} from "@/components/brand/ionicons";

// Akshar carries display/headlines, JetBrains Mono sets the overlines. Both are scoped
// to this page so the rest of the app keeps the type stack it already ships with.
// Inter (body) is already loaded globally in app/layout.tsx as --font-inter.
const akshar = Akshar({
  variable: "--font-akshar",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});
const mono = JetBrains_Mono({
  variable: "--font-mono-brand",
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
});

/* Brand Guidelines v1.0 — Cream #FEF4E5 · Ink #363636 · Signal Red #EA4637.
   Blue stays #5038FF, the value the rest of the site already ships. */

/* One source for the section anchors — the desktop bar and the mobile disclosure
   render the same four links, so neither can drift out of sync with the other. */
const NAV_LINKS = [
  { label: "How it works", href: "#how" },
  { label: "Find work", href: "#work" },
  { label: "Post a job", href: "#post" },
  { label: "Safety", href: "#trust" },
  { label: "Join the waitlist", href: "#waitlist" },
];

/* PRE-LAUNCH RULE: everything on this page has to be true of the product as it
   stands, not of the product as it will be.

   These four were "$184 median weekly earnings", "48 hrs from finished job to
   bank", "100% of earners ID verified" and "4.9 average job rating" — invented
   figures on a live public site, against a database with no completed jobs in it.
   They are replaced by properties that are true BY CONSTRUCTION: the fee comes
   out of the earner's payout at the rate in platform_rates (700 bps today), tips
   carry no application fee at all (stripe-tip sets transfer_data.destination with
   no application_fee_amount), the hold is a manual-capture PaymentIntent minted
   before the work starts, and both parties must mark done before anything moves.
   Each is checkable in the code. Put real numbers back the moment there are
   real numbers. */
const STATS = [
  { value: "0%", label: "taken from your tips" },
  { value: "7%", label: "our fee, from the earner's payout" },
  { value: "$0", label: "to join, post, or apply" },
  { value: "100%", label: "of gigs paid through escrow" },
];

/* The `meta` lines used to carry live-looking counts — "62 open", "18 urgent right
   now" — for a marketplace with zero open gigs. They are typical pay ranges now,
   which is what somebody deciding whether to join actually wants, and which does
   not become a lie the moment nobody has posted this week. */
const CATEGORIES = [
  { icon: IconCampus, title: "Moving & lifting", meta: "Typically $40–90", tone: "blue" },
  { icon: IconHome, title: "Cleaning & yard", meta: "Typically $30–110", tone: "plain" },
  { icon: IconPerson, title: "Tutoring", meta: "Typically $22–45/hr", tone: "plain" },
  { icon: IconBriefcase, title: "Events & setup", meta: "Typically $50–140", tone: "plain" },
  { icon: IconParttime, title: "Same-day help", meta: "Post it, get it done today", tone: "red" },
] as const;

const STEPS = [
  {
    n: "01",
    title: "Find a gig near you",
    body: "Filter by campus, remote, pay, or the hours you actually have free. Save the ones you want to come back to.",
  },
  {
    n: "02",
    title: "Book a time slot",
    body: "Pick from the times the poster offered, or counter with your own rate. Message them before anyone shows up.",
  },
  {
    n: "03",
    title: "Do the work, get paid",
    body: "Money is held from the moment you're booked. Both sides mark it done, and it's in your bank in 48 hours.",
  },
];

const TRUST = [
  {
    icon: IconPerson,
    title: "ID + .edu verified",
    body: "Two checks before the first booking. No anonymous accounts on either side.",
  },
  {
    icon: IconBriefcase,
    title: "Escrowed payment",
    body: "Funds are captured at booking and released only when both parties mark it complete.",
  },
  {
    icon: IconStar,
    title: "Two-sided reviews",
    body: "Posters rate earners, earners rate posters. Reputation follows you across every gig.",
  },
  {
    icon: IconChat,
    title: "In-app messaging",
    body: "Sort out the details without handing over your number. Report and block in two taps.",
  },
];

/* This was three testimonials — "Maya R., Ohio State '27 · 27 jobs", "Dana K.,
   Poster · Columbus, OH", "Jordan T., Ohio State '26 · 41 jobs" — invented people
   describing work that never happened, attributed to a state Hustlr does not
   operate in, on a live public site. The FTC's rule on fake reviews and
   testimonials (16 CFR Part 465, in force since 2024) carries civil penalties per
   violation, and separately it is the fastest way to lose a waitlist: somebody
   joins expecting a busy marketplace and opens an empty one.

   Replaced with answers to the questions the founder's own FAQ already poses.
   Every line here is checkable against the code. Real quotes from real testers
   belong in a testimonial section — this one — the day there are any. */
const FAQ = [
  {
    q: "Where is Hustlr live?",
    a: "Nowhere yet. We're opening first in Monroe and West Monroe, then the corridor through Ruston and Grambling. The waitlist is how you find out the day it reaches your ZIP.",
  },
  {
    q: "How does payment work?",
    a: "When a poster accepts you, the money is authorised and held before you start — not promised. It is released when both of you mark the job done, and it lands in the bank account you connect through Stripe.",
  },
  {
    q: "What does Hustlr take?",
    a: "A 7% platform fee, out of the earner's payout — never added on top of what the poster agreed. Tips are yours in full: we pay the card processing on them rather than take a cut.",
  },
  {
    q: "What if the job goes wrong?",
    a: "Either side can report a problem before the money is released, and a person reviews it. Nothing is released while a report is open.",
  },
  {
    // 18, not 16. The founder's FAQ draft said 16 — but the published Terms say "at
    // least 18 years old", the Privacy Policy §14 says the same, and shared/age.js sets
    // MIN_AGE = 18 with a server-side guard_min_age trigger (20260710040000) that
    // REJECTS a younger signup. Marketing copy promising 16 would send people to a
    // form that refuses them, against terms they had already been shown. Changing the
    // floor to 16 is a Terms + Privacy + trigger change and a parental-consent
    // question, not a copy edit.
    q: "Who can sign up?",
    a: "Anyone 18 or older. Earners verify their identity, and students can verify a .edu address for a student badge — both are checks other people can see before they hire you.",
  },
  {
    q: "What do you do with my email?",
    a: "Email you once, the day Hustlr opens near you. There is an unsubscribe link in that email and in this one, and using it removes you from the list.",
  },
];

function Check({ className = "text-[#15803D]" }: { className?: string }) {
  return <span className={`font-bold ${className}`}>✓</span>;
}

/* Menu + close marks for the mobile nav disclosure. The shared brand set has no
   menu glyph, so they live here — solid shapes in currentColor, per Brand
   Guidelines v1.0 ("solid, never outlined"). Same 20×20 box so they swap in place. */
function IconMenu({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden focusable="false" className={className}>
      <rect y="3.7" width="20" height="2.6" rx="1.3" />
      <rect y="8.7" width="20" height="2.6" rx="1.3" />
      <rect y="13.7" width="20" height="2.6" rx="1.3" />
    </svg>
  );
}

function IconClose({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden focusable="false" className={className}>
      <path d="M2.6 0.8 19.2 17.4 17.4 19.2 0.8 2.6Z" />
      <path d="M17.4 0.8 19.2 2.6 2.6 19.2 0.8 17.4Z" />
    </svg>
  );
}

export default function LandingPage() {
  return (
    // The root is deliberately NOT clipped. `overflow-x-clip` used to live here to
    // contain the hero's decorative glow, but a clip at the root also swallows
    // every real overflow below it — a too-wide grid track or an unwrappable
    // heading silently lost content instead of showing the horizontal scrollbar
    // that says something is broken. The clip now sits on the hero section, which
    // is the only thing that bleeds on purpose.
    <div className={`${akshar.variable} ${mono.variable} bg-[#FEF4E5] text-[#363636]`}>
      {/* ── Nav ─────────────────────────────────────────────────────────── */}
      {/* `relative` is the anchor for the mobile disclosure panel below. */}
      <header className={`relative border-b border-[#363636]/8 ${gutter}`}>
        <div className="flex items-center justify-between gap-2 py-[22px] sm:gap-8">
          <Link href="/" className="flex shrink-0 items-center">
            {/* Mark only below sm. The full lockup is 4.9:1 — 162px at h-33 — which
                is 58% of the content width on a 320px screen and pushed the bar
                (logo + Log in + CTA + menu) past the viewport edge. */}
            <HustlrMark className="h-[30px] w-auto text-[#5038FF] sm:hidden" />
            <HustlrLockup className="hidden h-[33px] w-auto text-[#5038FF] sm:block sm:h-[38px]" />
            <span className="sr-only">Hustlr — home</span>
          </Link>

          <nav className="hidden min-w-0 items-center gap-7 whitespace-nowrap text-[14.5px] font-medium text-[#6B6482] lg:flex">
            {NAV_LINKS.map((l) => (
              <a key={l.href} href={l.href} className="transition hover:text-[#5038FF]">
                {l.label}
              </a>
            ))}
          </nav>

          <div className="flex shrink-0 items-center gap-1 sm:gap-3">
            <Link
              href="/login"
              className="px-1.5 py-[11px] text-[14.5px] font-semibold text-[#363636] transition hover:text-[#5038FF] sm:px-[18px]"
            >
              Log in
            </Link>
            <a
              href="#waitlist"
              className="inline-flex items-center gap-[9px] rounded-[14px] bg-[#5038FF] px-3.5 py-3 text-[14.5px] font-semibold whitespace-nowrap text-[#FEF4E5] transition hover:bg-[#2E1BC7] sm:px-[22px]"
            >
              Join the list <IconArrow className="hidden h-[11px] w-auto sm:block" />
            </a>

            {/* Mobile nav disclosure. The section anchors above are `lg:flex`, so
                below 1024px — most of the traffic — How it works / Find work /
                Post a job / Safety had no route at all. A <details> keeps this a
                server component: a nav toggle is not worth shipping the whole
                landing page to the browser. The header is not sticky, so a panel
                left open after a jump link scrolls away with it. */}
            <details className="group lg:hidden">
              <summary className="flex size-11 cursor-pointer list-none items-center justify-center text-[#363636] transition hover:text-[#5038FF] [&::-webkit-details-marker]:hidden">
                <IconMenu className="h-[15px] w-auto group-open:hidden" />
                <IconClose className="hidden h-[15px] w-auto group-open:block" />
                <span className="sr-only">Menu</span>
              </summary>
              <nav
                className={`absolute inset-x-0 top-full z-40 flex flex-col divide-y divide-[#363636]/8 border-b border-[#363636]/8 bg-[#FEF4E5] pb-2 shadow-[0_18px_28px_rgba(54,54,54,.08)] ${gutter}`}
              >
                {NAV_LINKS.map((l) => (
                  <a
                    key={l.href}
                    href={l.href}
                    className="flex min-h-11 items-center text-[15.5px] font-medium text-[#363636] transition hover:text-[#5038FF]"
                  >
                    {l.label}
                  </a>
                ))}
              </nav>
            </details>
          </div>
        </div>
      </header>

      {/* ── Hero ────────────────────────────────────────────────────────── */}
      {/* overflow-x-clip is scoped here: the PhoneMock's glow is inset -6% past its
          own box by design, and this is the only element on the page allowed to
          bleed. Every auto-fit track below carries a `min(100%, …)` floor so the
          clip never has real overflow to hide. */}
      <section
        className={`grid items-center gap-14 overflow-x-clip pt-16 pb-[72px] lg:grid-cols-[repeat(auto-fit,minmax(min(100%,440px),1fr))] lg:pt-[88px] ${gutter}`}
      >
        <div className="min-w-0">
          <span className="mb-7 inline-flex items-center gap-2 rounded-full bg-[#EAE6FF] px-[15px] py-2 text-[13px] font-bold text-[#5038FF]">
            <IconCampus className="h-[14px] w-auto" /> Launching first in Monroe &amp; West Monroe
          </span>
          <h1
            className={`${display} m-0 mb-[26px] text-[clamp(38px,9vw,104px)] leading-[0.94] font-bold tracking-[-0.025em]! text-balance text-[#5038FF]`}
          >
            Find jobs between classes.
          </h1>
          <p className="m-0 mb-[34px] max-w-[46ch] text-[19px] leading-[1.6] text-pretty text-[#6B6482]">
            Real work, posted by real neighbors, paid through the app — money held in escrow before
            you start. No résumé, no interview, no shift you can&apos;t get out of. We&apos;re opening
            soon; get on the list.
          </p>
          <div className="mb-[22px] flex flex-wrap gap-[14px]">
            <a
              href="#waitlist"
              className="inline-flex items-center gap-[10px] rounded-[14px] bg-[#5038FF] px-[30px] py-[17px] text-[17px] font-semibold text-[#FEF4E5] transition hover:bg-[#2E1BC7]"
            >
              Join the waitlist <IconArrow className="h-[13px] w-auto" />
            </a>
            <a
              href="#how"
              className="inline-flex items-center gap-[10px] rounded-[14px] border-2 border-[#5038FF] px-[30px] py-[15px] text-[17px] font-semibold text-[#5038FF] transition hover:bg-[#5038FF]/6"
            >
              See how it works
            </a>
          </div>
          <div className="flex flex-wrap items-center gap-x-[22px] gap-y-2 text-[13.5px] text-[#6B6482]">
            <span className="flex items-center gap-[7px]">
              <Check /> Free to join
            </span>
            <span className="flex items-center gap-[7px]">
              <Check /> Payment held in escrow
            </span>
            <span className="flex items-center gap-[7px]">
              <Check /> .edu verified earners
            </span>
          </div>
        </div>

        <PhoneMock />
      </section>

      {/* ── Stat strip ──────────────────────────────────────────────────── */}
      <section className="grid grid-cols-2 bg-[#363636] lg:grid-cols-4">
        {STATS.map((s, i) => (
          <div
            key={s.label}
            className={`px-5 py-[34px] sm:px-10 ${
              i < STATS.length - 1 ? "border-r border-[#FEF4E5]/14" : ""
            } ${i < 2 ? "border-b border-[#FEF4E5]/14 lg:border-b-0" : ""}`}
          >
            {/* Two columns at 320px leaves ~110px of content per cell, so the numeral
                scales with the viewport and min-w-0 lets the row shrink inside its grid
                cell instead of pushing the strip past the page edge. */}
            <div className="flex min-w-0 items-center gap-[9px]">
              <span
                className={`${display} text-[clamp(28px,7vw,40px)] leading-none font-bold text-[#FEF4E5]`}
              >
                {s.value}
              </span>
            </div>
            <div className="mt-1.5 text-[12.5px] text-[#FEF4E5]/60">{s.label}</div>
          </div>
        ))}
      </section>

      {/* ── Categories ──────────────────────────────────────────────────── */}
      <section id="work" className={`scroll-mt-8 py-16 lg:py-24 ${gutter}`}>
        <div className="mb-11 flex flex-wrap items-end justify-between gap-10">
          <div>
            <div className={`${overline} mb-4 text-[12.5px] text-[#5038FF]`}>
              What&apos;s on Hustlr
            </div>
            <h2
              className={`${display} m-0 text-[clamp(32px,4.4vw,64px)] leading-none font-bold tracking-[-0.02em]! text-[#363636]`}
            >
              Every kind of hustle
            </h2>
          </div>
          <a
            href="#waitlist"
            className="inline-flex items-center gap-[9px] text-[15px] font-semibold text-[#5038FF] transition hover:opacity-70"
          >
            Get told when these open near you <IconArrow className="h-3 w-auto" />
          </a>
        </div>

        {/* min(100%, …) on every auto-fit floor: without it a track wider than the
            container (190px of track inside a 280px box is fine, 300px is not)
            overflows the section instead of collapsing to one column. */}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,190px),1fr))] gap-4">
          {CATEGORIES.map(({ icon: Icon, title, meta, tone }) => {
            const blue = tone === "blue";
            const red = tone === "red";
            const onColor = blue || red;
            return (
              <Link
                key={title}
                href="/login"
                className={`flex min-h-[170px] flex-col rounded-[20px] px-6 py-[26px] transition ${
                  blue
                    ? "bg-[#5038FF]"
                    : red
                      ? "bg-[#EA4637]"
                      : "border border-[#363636]/12 bg-white hover:border-[#5038FF]"
                }`}
              >
                <Icon
                  className={`mb-auto h-7 w-auto ${onColor ? "text-[#FEF4E5]" : "text-[#5038FF]"}`}
                />
                <div
                  className={`${display} mt-[22px] text-[23px] font-semibold ${
                    onColor ? "text-[#FEF4E5]" : "text-[#363636]"
                  }`}
                >
                  {title}
                </div>
                <div
                  className={`mt-1 text-[12.5px] ${
                    blue
                      ? "text-[#FEF4E5]/72"
                      : red
                        ? "text-[#FEF4E5]/82"
                        : "text-[#9A93AD]"
                  }`}
                >
                  {meta}
                </div>
              </Link>
            );
          })}
        </div>
      </section>

      {/* ── How it works ────────────────────────────────────────────────── */}
      <section
        id="how"
        className={`scroll-mt-8 border-y border-[#363636]/8 bg-white py-16 lg:py-24 ${gutter}`}
      >
        <div className={`${overline} mb-4 text-[12.5px] text-[#5038FF]`}>How it works</div>
        <h2
          className={`${display} m-0 mb-5 text-[clamp(32px,4.4vw,64px)] leading-none font-bold tracking-[-0.02em]! text-[#363636]`}
        >
          Three steps. No résumé.
        </h2>
        <p className="m-0 mb-13 max-w-[56ch] text-[17.5px] leading-[1.6] text-[#6B6482]">
          The whole thing is designed to fit in the gap between a 9 AM and a 2 PM.
        </p>
        <div className="grid gap-px border border-[#363636]/14 bg-[#363636]/14 md:grid-cols-3">
          {STEPS.map((s) => (
            <div key={s.n} className="bg-white px-9 py-10">
              <div className={`${display} mb-[18px] text-[56px] leading-none font-bold text-[#EAE6FF]`}>
                {s.n}
              </div>
              <div className={`${display} mb-2.5 text-[27px] font-semibold text-[#363636]`}>
                {s.title}
              </div>
              <p className="m-0 text-[15.5px] leading-[1.6] text-[#6B6482]">{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Trust & safety ──────────────────────────────────────────────── */}
      <section
        id="trust"
        className={`relative scroll-mt-8 overflow-hidden bg-[#5038FF] py-16 lg:py-24 ${gutter}`}
      >
        {/* The Hustle pattern — texture only, dialled to 4.5% so the copy stays readable. */}
        <div
          aria-hidden
          className="absolute inset-0 opacity-[0.045]"
          style={{
            backgroundImage: "url(/brand/hustle-pattern.png)",
            backgroundSize: "120px 733px",
          }}
        />
        <div className="relative">
          <div className={`${overline} mb-4 text-[12.5px] text-[#FEF4E5]/60`}>
            Trust &amp; safety
          </div>
          <h2
            className={`${display} m-0 mb-5 text-[clamp(32px,4.4vw,64px)] leading-none font-bold tracking-[-0.02em]! text-[#FEF4E5]`}
          >
            Work you can trust.
          </h2>
          <p className="m-0 mb-13 max-w-[58ch] text-[17.5px] leading-[1.6] text-[#FEF4E5]/75">
            Every earner verifies a .edu address and a government ID before their first job. Every
            dollar sits in escrow until both sides confirm the work is done.
          </p>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-5">
            {TRUST.map(({ icon: Icon, title, body }) => (
              <div
                key={title}
                className="rounded-[20px] border border-[#FEF4E5]/18 bg-[#FEF4E5]/10 px-[26px] py-7"
              >
                <Icon className="mb-5 h-[26px] w-auto text-[#FEF4E5]" />
                <div className="mb-2 text-[17px] font-bold text-[#FEF4E5]">{title}</div>
                <p className="m-0 text-[14px] leading-[1.55] text-[#FEF4E5]/72">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Two-sided split ─────────────────────────────────────────────── */}
      <section
        id="post"
        className="grid scroll-mt-8 gap-px bg-[#363636]/14 lg:grid-cols-[repeat(auto-fit,minmax(min(100%,400px),1fr))]"
      >
        <div className={`bg-[#FEF4E5] py-16 lg:py-[88px] ${gutter}`}>
          <span className="mb-6 inline-flex items-center gap-2 rounded-full bg-[#EAE6FF] px-[14px] py-[7px] text-[12.5px] font-bold text-[#5038FF]">
            <IconParttime className="h-[13px] w-auto" /> For students
          </span>
          <h3
            className={`${display} m-0 mb-[18px] text-[clamp(30px,3.4vw,46px)] leading-[1.05] font-semibold tracking-[-0.02em]! text-[#363636]`}
          >
            Earn between
            <br />
            lectures.
          </h3>
          <p className="m-0 mb-[26px] max-w-[42ch] text-[16.5px] leading-[1.6] text-[#6B6482]">
            Pick up two gigs a week and cover groceries and gas. Pick up five and cover rent.
            Nothing recurring, nothing you can&apos;t cancel.
          </p>
          <ul className="mb-[30px] flex list-none flex-col gap-3 p-0">
            {[
              "Set your own availability by day and hour",
              "Counter-offer any rate before you commit",
              "Built-in expense log and Schedule-C export",
            ].map((t) => (
              <li key={t} className="flex items-center gap-[11px] text-[15px] text-[#363636]">
                <Check /> {t}
              </li>
            ))}
          </ul>
          <a
            href="#waitlist"
            className="inline-flex items-center gap-[10px] rounded-[14px] bg-[#5038FF] px-7 py-[15px] text-[16px] font-semibold text-[#FEF4E5] transition hover:bg-[#2E1BC7]"
          >
            Get on the list to earn <IconArrow className="h-3 w-auto" />
          </a>
        </div>

        <div className={`bg-[#363636] py-16 lg:py-[88px] ${gutter}`}>
          <span className="mb-6 inline-flex items-center gap-2 rounded-full bg-[#FEF4E5]/14 px-[14px] py-[7px] text-[12.5px] font-bold text-[#FEF4E5]">
            <IconHome className="h-[13px] w-auto" /> For posters
          </span>
          <h3
            className={`${display} m-0 mb-[18px] text-[clamp(30px,3.4vw,46px)] leading-[1.05] font-semibold tracking-[-0.02em]! text-[#FEF4E5]`}
          >
            Help, without
            <br />
            the group chat.
          </h3>
          <p className="m-0 mb-[26px] max-w-[42ch] text-[16.5px] leading-[1.6] text-[#FEF4E5]/72">
            Post the job, name the price, pick the times that work. Verified students nearby see it
            and apply — and you choose who shows up.
          </p>
          <ul className="mb-[30px] flex list-none flex-col gap-3 p-0">
            {[
              "See ratings and completed jobs before you book",
              "Your address stays hidden until you confirm",
              "You approve the work before money moves",
            ].map((t) => (
              <li key={t} className="flex items-center gap-[11px] text-[15px] text-[#FEF4E5]">
                <Check className="text-[#7FD8A0]" /> {t}
              </li>
            ))}
          </ul>
          <a
            href="#waitlist"
            className="inline-flex items-center gap-[10px] rounded-[14px] bg-[#EA4637] px-7 py-[15px] text-[16px] font-semibold text-white transition hover:bg-[#B8291B]"
          >
            Get on the list to hire <IconArrow className="h-3 w-auto" />
          </a>
        </div>
      </section>

      {/* ── FAQ ─────────────────────────────────────────────────────────── */}
      {/* Native <details>, so this stays a server component — the same choice the
          mobile nav above makes, and for the same reason: an accordion is not worth
          shipping the page to the browser. It also means every answer is in the DOM
          for search engines and for anyone reading with the keyboard. */}
      <section id="faq" className={`scroll-mt-8 border-t border-[#363636]/8 bg-white py-16 lg:py-24 ${gutter}`}>
        <div className="mb-11">
          <div className={`${overline} mb-4 text-[12.5px] text-[#5038FF]`}>Before you join</div>
          <h2
            className={`${display} m-0 text-[clamp(32px,4.4vw,64px)] leading-none font-bold tracking-[-0.02em]! text-[#363636]`}
          >
            Straight answers
          </h2>
        </div>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,380px),1fr))] gap-x-10">
          {FAQ.map((item) => (
            <details
              key={item.q}
              className="group border-b border-[#363636]/12 py-5"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-6 text-[17px] font-semibold text-[#363636] transition hover:text-[#5038FF] [&::-webkit-details-marker]:hidden">
                {item.q}
                <span className="shrink-0 text-[22px] leading-none text-[#5038FF] transition group-open:rotate-45">
                  +
                </span>
              </summary>
              <p className="m-0 mt-3 max-w-[62ch] text-[15.5px] leading-[1.65] text-[#6B6482]">{item.a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* ── Waitlist ────────────────────────────────────────────────────── */}
      {/* This section used to be the closing CTA: a heading, a promise, and two
          buttons — the second labelled "Download the app" and pointing at
          /login?mode=signup, the same destination as the first. It was already
          shaped like a waitlist block, and one of its two slots was a duplicate.

          It is the waitlist now because signing up is the wrong ask today.
          beta_allowlist holds a '*' row, so an account CAN be created — into a
          marketplace with nothing in it. Somebody who does that once does not come
          back. Existing testers still reach the app through "Log in" in the header. */}
      <section id="waitlist" className={`scroll-mt-8 pt-20 pb-24 ${gutter}`}>
        <div className="overflow-hidden rounded-[28px] bg-[linear-gradient(140deg,#5038FF_0%,#7A5CF0_55%,#C94FA8_100%)] px-6 py-14 text-center sm:px-8 lg:px-14 lg:py-20">
          <HustlrMark className="mx-auto mb-7 h-11 w-auto text-[#FEF4E5]" />
          <h2
            className={`${display} m-0 mb-[18px] text-[clamp(32px,4.8vw,72px)] leading-none font-bold tracking-[-0.02em]! text-[#FEF4E5]`}
          >
            Be first in Monroe.
          </h2>
          <p className="mx-auto m-0 mb-[34px] max-w-[46ch] text-[18px] leading-[1.6] text-[#FEF4E5]/82">
            We&rsquo;re opening in Monroe and West Monroe first, then Ruston and Grambling. Leave your
            email and we&rsquo;ll tell you the day you can get in.
          </p>
          <WaitlistForm />
        </div>
      </section>

      {/* ── Footer ──────────────────────────────────────────────────────── */}
      <footer className={`bg-[#363636] pt-16 pb-10 ${gutter}`}>
        <div className="mb-12 flex flex-wrap justify-between gap-14">
          <div className="max-w-[34ch]">
            <div className="mb-[18px] flex items-center">
              <HustlrLockup className="h-[38px] w-auto text-[#FEF4E5]" />
            </div>
            <p className="m-0 text-[14px] leading-[1.6] text-[#FEF4E5]/60">
              The campus gig marketplace. Real work, verified students, money that actually lands.
            </p>
          </div>

          <div className="flex flex-wrap gap-x-16 gap-y-10">
            <FooterCol
              heading="Product"
              links={[
                { label: "Find work", href: "#work" },
                { label: "Post a job", href: "#post" },
                { label: "How it works", href: "#how" },
                { label: "Tax Center", href: "/login" },
              ]}
            />
            {/* Only routes that actually exist get listed. Campus partners /
                Careers / About have no page yet — add them back here when they do. */}
            <FooterCol heading="Company" links={[{ label: "Contact", href: "/contact" }]} />
            <FooterCol
              heading="Legal"
              links={[
                { label: "Terms", href: "/legal/terms" },
                { label: "Privacy", href: "/legal/privacy" },
                { label: "Contractor agreement", href: "/legal/contractor" },
                { label: "Trust & safety", href: "#trust" },
              ]}
            />
          </div>
        </div>

        <div className="flex flex-wrap justify-between gap-6 border-t border-[#FEF4E5]/14 pt-[26px] text-[12.5px] text-[#FEF4E5]/50">
          <div>© {new Date().getFullYear()} Hustlr. Built for students.</div>
          <a
            href="mailto:mainmail@gohustlr.com"
            className={`${overline} transition hover:text-[#FEF4E5]/80`}
          >
            mainmail@gohustlr.com
          </a>
        </div>
      </footer>
    </div>
  );
}

function FooterCol({
  heading,
  links,
}: {
  heading: string;
  links: { label: string; href: string }[];
}) {
  return (
    <div>
      <div className={`${overline} mb-4 text-[11.5px] text-[#FEF4E5]/45`}>{heading}</div>
      <div className="flex flex-col gap-[11px] text-[14px] text-[#FEF4E5]/80">
        {links.map((l) => (
          <Link key={l.label} href={l.href} className="transition hover:text-[#FEF4E5]">
            {l.label}
          </Link>
        ))}
      </div>
    </div>
  );
}

/* The hero device — mirrors the shipped Browse screen so the marketing page and the
   real app read as the same product. Decorative: hidden from assistive tech.

   RADIUS EXCEPTION — do not "fix" these. The four arbitrary radii on the frame
   (`rounded-[48px]` glow, `rounded-[50px]` device body, `rounded-[42px]` screen,
   `rounded-[2.5px]` battery pip) are HARDWARE geometry, not UI: they draw an
   iPhone's bezel, whose corner radii are what they are. The 10/14/20/28 radius
   scale governs app surfaces — chips, controls, cards, sheets — and snapping the
   bezel to it would simply make the drawing of the phone wrong. Everything INSIDE
   the screen is app UI and does follow the scale (see the 14px filter button).

   Shadows, by contrast, are NOT exempt: they are neutral black here because the
   app's elevation tokens are neutral, and this mock is meant to read as a
   screenshot of the app. */
function PhoneMock() {
  return (
    // min-w-0: this is a grid item, and a grid item's automatic minimum size is
    // its content — the 326px frame below was sizing the whole hero track, so at
    // 320px BOTH columns became 326px wide and the headline, body copy and the
    // "Post a job" CTA ran off the right edge. Capping the minimum lets max-w-full
    // do its job and the frame shrinks with the screen instead.
    <div className="relative flex min-w-0 justify-center" aria-hidden>
      <div className="absolute inset-y-[-10%] inset-x-[-6%] rounded-[48px] bg-[linear-gradient(150deg,#5038FF,#5038FF)] opacity-10 blur-[50px]" />
      <div className="relative w-[326px] max-w-full rounded-[50px] bg-[#1B1B1B] p-[9px] shadow-[0_30px_70px_rgba(0,0,0,.28)]">
        <div className="relative h-[640px] w-full overflow-hidden rounded-[42px] bg-[#F7F4EC]">
          {/* Dynamic Island */}
          <div className="absolute top-2.5 left-1/2 z-30 h-[27px] w-[98px] -translate-x-1/2 rounded-2xl bg-black" />

          <div className="px-4">
            {/* Status bar */}
            <div className="flex h-11 items-end justify-between pb-1">
              <span className="text-xs font-semibold text-[#363636]">20:01</span>
              <span className="flex items-center gap-[5px]">
                <IonWifi className="h-2.5 w-auto text-[#363636]" />
                <span className="h-[9px] w-[19px] rounded-[2.5px] bg-[#363636]" />
              </span>
            </div>

            {/* Greeting */}
            <div className="mt-4 flex items-start justify-between gap-2.5">
              <div>
                {/* 700, matching HomeScreen's `greeting` style. The app caps at
                    700 everywhere, so an 800 here advertised a weight it no
                    longer ships. */}
                <div className="text-[27px] leading-[1.05] font-bold tracking-[-0.6px] text-[#363636]">
                  Hey Chris
                </div>
                <div className="mt-[3px] text-[13.5px] text-[#6B6482]">Ready to hustle?</div>
              </div>
              <span className="mt-[3px] inline-flex items-center gap-1.5 rounded-full bg-white px-[13px] py-2 whitespace-nowrap shadow-[0_1px_4px_rgba(0,0,0,.06)]">
                <IonFlame className="h-3 w-auto text-[#EA4637]" />
                <span className="text-xs font-semibold text-[#363636]">Start a streak</span>
              </span>
            </div>

            {/* Search + filter */}
            <div className="mt-3.5 flex items-center gap-[9px]">
              <div className="flex h-10 flex-1 items-center gap-[9px] rounded-full bg-white px-[15px]">
                <IonSearch className="h-3.5 w-auto shrink-0 text-[#9A93AD]" />
                <span className="text-[13px] text-[#9A93AD]">Search gigs...</span>
              </div>
              {/* 14px — the control radius, same as HomeScreen's filterBtn. */}
              <div className="flex size-10 shrink-0 items-center justify-center rounded-[14px] bg-[#363636]">
                <IonOptions className="h-[18px] w-auto text-[#FEF4E5]" />
              </div>
            </div>

            {/* Chips */}
            <div className="mt-[13px] flex gap-[7px] overflow-hidden">
              <span className="inline-flex items-center gap-[5px] rounded-full bg-white px-[13px] py-2 text-[11.5px] font-semibold whitespace-nowrap text-[#363636]">
                <IonSparkles className="h-2.5 w-auto" /> For You
              </span>
              <span className="inline-flex items-center gap-[5px] rounded-full bg-[#363636] px-[13px] py-2 text-[11.5px] font-semibold whitespace-nowrap text-[#FEF4E5]">
                <IonGrid className="h-2.5 w-auto" /> All
              </span>
              <span className="inline-flex items-center gap-[5px] rounded-full bg-white px-[13px] py-2 text-[11.5px] font-semibold whitespace-nowrap text-[#363636]">
                <IonPerson className="h-2.5 w-auto" /> Tutoring
              </span>
              <span className="inline-flex items-center rounded-full bg-white px-[13px] py-2 text-[11.5px] font-semibold whitespace-nowrap text-[#363636]">
                Delivery
              </span>
            </div>

            {/* List header */}
            <div className="mt-3.5 mb-[9px] flex items-center justify-between">
              <span className="text-[12.5px] font-semibold text-[#6B6482]">6 gigs available</span>
              <span className="flex items-center gap-3 text-xs font-semibold text-[#363636]">
                <span className="inline-flex items-center gap-1">
                  <IonBarChart className="h-3 w-auto" />
                  Insights
                </span>
                <span className="inline-flex items-center gap-1">
                  <IonMap className="h-3 w-auto" />
                  Map
                </span>
              </span>
            </div>

            {/* Card 1 — urgent */}
            <div className="relative mb-2.5 rounded-[20px] bg-white p-3.5">
              <IonBookmark className="absolute top-3.5 right-3.5 h-3.5 w-auto text-[#5038FF]" />
              <div className="mb-2 flex items-center gap-[7px]">
                <span className="inline-flex items-center gap-[3px] rounded-full bg-[#FFE7E3] px-2 py-[3px] text-[9.5px] font-bold text-[#EA4637]">
                  <IonFlash className="h-2.5 w-auto" /> Urgent
                </span>
                <span className="text-[10.5px] font-medium text-[#9A93AD]">Moving</span>
                <span className="flex-1" />
                <span className="mr-[22px] text-[10.5px] text-[#9A93AD]">Jul 30</span>
              </div>
              <div className="mb-[3px] text-[14.5px] font-bold text-[#363636]">
                Help unload a U-Haul
              </div>
              <div className="mb-[9px] text-[11.5px] text-[#6B6482]">Two-bedroom, second floor.</div>
              <div className="mb-[9px] flex items-center justify-between">
                <span className="text-[13.5px] font-bold text-[#363636]">$60 flat</span>
                <span className="text-[10.5px] text-[#9A93AD]">Plano, TX</span>
              </div>
              <div className="flex items-center gap-[7px] border-t border-[#EFEBE1] pt-[9px]">
                <span className="flex size-[19px] items-center justify-center rounded-full bg-[#5038FF] text-[8.5px] font-bold text-[#FEF4E5]">
                  DK
                </span>
                <span className="text-[11px] font-semibold text-[#6B6482]">Dana Kim</span>
                <span className="flex-1" />
                <span className="flex items-center gap-[3px]">
                  <IonStar className="h-2.5 w-auto text-[#5038FF]" />
                  <span className="text-[11px] font-semibold text-[#6B6482]">4.9</span>
                </span>
              </div>
            </div>

            {/* Card 2 */}
            <div className="relative mb-2.5 rounded-[20px] bg-white p-3.5">
              <IonBookmarkOutline className="absolute top-3.5 right-3.5 h-3.5 w-auto text-[#9A93AD]" />
              <div className="mb-2 flex items-center gap-[7px]">
                <span className="text-[10.5px] font-medium text-[#9A93AD]">Tutoring</span>
                <span className="flex-1" />
                <span className="mr-[22px] text-[10.5px] text-[#9A93AD]">Aug 3</span>
              </div>
              <div className="mb-2 text-[14.5px] font-bold text-[#363636]">Calc II exam prep</div>
              <div className="flex items-center justify-between">
                <span className="text-[13.5px] font-bold text-[#363636]">$28 / hr</span>
                <span className="mr-[52px] text-[10.5px] text-[#9A93AD]">Farmers Branch, TX</span>
              </div>
            </div>

            {/* Card 3 — crops under the tab bar */}
            <div className="rounded-[20px] bg-white px-3.5 pt-3.5 pb-8">
              <div className="mb-[7px] text-[10.5px] font-medium text-[#9A93AD]">Moving</div>
              <div className="mb-[3px] text-[14.5px] font-bold text-[#363636]">
                Furniture moving help
              </div>
              <div className="text-[11.5px] text-[#6B6482]">Two couches, one flight of stairs.</div>
            </div>
          </div>

          {/* AI FAB */}
          {/* Neutral drop, not a purple glow: brand-tinted shadows were removed
              from the app, and this mock is supposed to be a screenshot of it. */}
          <div className="absolute right-4 bottom-[100px] z-20 flex size-11 items-center justify-center rounded-full bg-[#5038FF] shadow-[0_6px_18px_rgba(0,0,0,0.18)]">
            <IonSparkles className="h-[19px] w-auto text-[#FEF4E5]" />
          </div>

          {/* Tab bar */}
          <div className="absolute inset-x-3 bottom-[18px] z-20 flex items-center justify-around rounded-full bg-white px-1 py-[9px] shadow-[0_6px_22px_rgba(0,0,0,.14)]">
            <TabItem icon={IonSearch} label="Browse" active />
            <TabItem icon={IonBriefcase} label="My Jobs" badge="1" />
            <TabItem icon={IonMegaphone} label="Hire" />
            <TabItem icon={IonChatbubble} label="Messages" />
            <TabItem icon={IonPersonCircle} label="Profile" />
          </div>
        </div>
      </div>
    </div>
  );
}

function TabItem({
  icon: Icon,
  label,
  active = false,
  badge,
}: {
  icon: typeof IonSearch;
  label: string;
  active?: boolean;
  badge?: string;
}) {
  return (
    <span className="relative flex flex-col items-center gap-0.5">
      <Icon className={`h-4 w-auto text-[#5038FF] ${active ? "" : "opacity-[0.42]"}`} />
      {badge && (
        /* Count badges are true pills in the app, not a 7px near-square. */
        <span className="absolute -top-1 right-0.5 flex h-[13px] min-w-[13px] items-center justify-center rounded-full bg-[#EA4637] text-[8px] font-bold text-white">
          {badge}
        </span>
      )}
      <span
        className={`text-[8.5px] font-semibold ${active ? "text-[#5038FF]" : "text-[#9A93AD]"}`}
      >
        {label}
      </span>
    </span>
  );
}
