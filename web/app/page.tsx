import Link from "next/link";
import { Akshar, JetBrains_Mono } from "next/font/google";
import {
  HustlrMark,
  HustlrWordmark,
  IconArrow,
  IconBookmark,
  IconBriefcase,
  IconCampus,
  IconChat,
  IconHome,
  IconParttime,
  IconPerson,
  IconRemote,
  IconStar,
} from "@/components/brand/glyphs";

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
   Blue stays #3F25FE, the value the rest of the site already ships. */
/* globals.css sets `h1, h2 { font-family: Sora; letter-spacing: -.02em }` as an
   unlayered rule, which outranks Tailwind's layered utilities — hence the `!` on
   both. Without it every heading here silently falls back to Sora. */
const display = "font-[family-name:var(--font-akshar)]!";
const overline = "font-[family-name:var(--font-mono-brand)]! uppercase";
/* Section gutter: the mock is a fixed 1520px desktop canvas at 56px; step it down
   on narrow screens so the page is usable on a phone. */
const gutter = "px-5 sm:px-8 lg:px-14";

const STATS = [
  { value: "$184", label: "median weekly earnings" },
  { value: "48 hrs", label: "from finished job to bank" },
  { value: "100%", label: "of earners ID verified" },
  { value: "4.9", label: "average job rating", star: true },
];

const CATEGORIES = [
  { icon: IconCampus, title: "Moving & lifting", meta: "62 open · $40–90", tone: "blue" },
  { icon: IconHome, title: "Cleaning & yard", meta: "48 open · $30–110", tone: "plain" },
  { icon: IconPerson, title: "Tutoring", meta: "37 open · $22–45/hr", tone: "plain" },
  { icon: IconBriefcase, title: "Events & setup", meta: "29 open · $50–140", tone: "plain" },
  { icon: IconParttime, title: "Same-day", meta: "18 urgent right now", tone: "red" },
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

const REVIEWS = [
  {
    quote: "I made $240 in one weekend helping with move-in. It paid for my textbooks.",
    initials: "MR",
    name: "Maya R.",
    meta: "Ohio State '27 · 27 jobs",
    bg: "bg-[#3F25FE]",
  },
  {
    quote: "Posted at 8 PM, had three applicants by 9, and my garage was cleared out Saturday.",
    initials: "DK",
    name: "Dana K.",
    meta: "Poster · Columbus, OH",
    bg: "bg-[#EA4637]",
  },
  {
    quote:
      "Better than a campus job because I choose the hours. I work around my labs, not the other way.",
    initials: "JT",
    name: "Jordan T.",
    meta: "Ohio State '26 · 41 jobs",
    bg: "bg-[#363636]",
  },
];

function Check({ className = "text-[#15803D]" }: { className?: string }) {
  return <span className={`font-bold ${className}`}>✓</span>;
}

export default function LandingPage() {
  return (
    // overflow-x-clip: the hero's decorative glow bleeds past the viewport by
    // design — clip it so narrow screens never get a horizontal scrollbar.
    <div
      className={`${akshar.variable} ${mono.variable} overflow-x-clip bg-[#FEF4E5] text-[#363636]`}
    >
      {/* ── Nav ─────────────────────────────────────────────────────────── */}
      <header
        className={`flex items-center justify-between gap-3 border-b border-[#363636]/8 py-[22px] sm:gap-8 ${gutter}`}
      >
        <Link href="/" className="flex shrink-0 items-center gap-2 sm:gap-3">
          <HustlrMark className="h-[26px] w-auto text-[#3F25FE] sm:h-[30px]" />
          <HustlrWordmark className="h-[19px] w-auto text-[#3F25FE] sm:h-[23px]" />
          <span className="sr-only">Hustlr — home</span>
        </Link>

        <nav className="hidden min-w-0 items-center gap-7 whitespace-nowrap text-[14.5px] font-medium text-[#5B5570] lg:flex">
          <a href="#how" className="transition hover:text-[#3F25FE]">
            How it works
          </a>
          <a href="#work" className="transition hover:text-[#3F25FE]">
            Find work
          </a>
          <a href="#post" className="transition hover:text-[#3F25FE]">
            Post a job
          </a>
          <a href="#trust" className="transition hover:text-[#3F25FE]">
            Safety
          </a>
        </nav>

        <div className="flex shrink-0 items-center gap-3">
          <Link
            href="/login"
            className="px-2 py-[11px] text-[14.5px] font-semibold text-[#363636] transition hover:text-[#3F25FE] sm:px-[18px]"
          >
            Log in
          </Link>
          <Link
            href="/login?mode=signup"
            className="inline-flex items-center gap-[9px] rounded-[14px] bg-[#3F25FE] px-4 py-3 text-[14.5px] font-semibold whitespace-nowrap text-[#FEF4E5] transition hover:bg-[#2b17c2] sm:px-[22px]"
          >
            Get started <IconArrow className="h-[11px] w-auto" />
          </Link>
        </div>
      </header>

      {/* ── Hero ────────────────────────────────────────────────────────── */}
      <section
        className={`grid items-center gap-14 pt-16 pb-[72px] lg:grid-cols-[repeat(auto-fit,minmax(440px,1fr))] lg:pt-[88px] ${gutter}`}
      >
        <div>
          <span className="mb-7 inline-flex items-center gap-2 rounded-full bg-[#E9E6FF] px-[15px] py-2 text-[13px] font-bold text-[#3F25FE]">
            <IconCampus className="h-[14px] w-auto" /> Now live on 12 campuses
          </span>
          <h1
            className={`${display} m-0 mb-[26px] text-[clamp(56px,6.4vw,104px)] leading-[0.94] font-bold tracking-[-0.025em]! text-balance text-[#3F25FE]`}
          >
            Find jobs between classes.
          </h1>
          <p className="m-0 mb-[34px] max-w-[46ch] text-[19px] leading-[1.6] text-pretty text-[#5B5570]">
            Real work, posted by real neighbors, paid through the app. Pick up a gig on Thursday,
            get paid by Monday. No résumé, no interview, no shift you can&apos;t get out of.
          </p>
          <div className="mb-[22px] flex flex-wrap gap-[14px]">
            <Link
              href="/login?mode=signup"
              className="inline-flex items-center gap-[10px] rounded-[14px] bg-[#3F25FE] px-[30px] py-[17px] text-[17px] font-semibold text-[#FEF4E5] transition hover:bg-[#2b17c2]"
            >
              Find jobs <IconArrow className="h-[13px] w-auto" />
            </Link>
            <Link
              href="/login?mode=signup"
              className="inline-flex items-center gap-[10px] rounded-[14px] border-2 border-[#3F25FE] px-[30px] py-[15px] text-[17px] font-semibold text-[#3F25FE] transition hover:bg-[#3F25FE]/6"
            >
              Post a job
            </Link>
          </div>
          <div className="flex flex-wrap items-center gap-x-[22px] gap-y-2 text-[13.5px] text-[#5B5570]">
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
            className={`px-6 py-[34px] sm:px-10 ${
              i < STATS.length - 1 ? "border-r border-[#FEF4E5]/14" : ""
            } ${i < 2 ? "border-b border-[#FEF4E5]/14 lg:border-b-0" : ""}`}
          >
            <div className="flex items-center gap-[9px]">
              <span className={`${display} text-[40px] leading-none font-bold text-[#FEF4E5]`}>
                {s.value}
              </span>
              {s.star && <IconStar className="h-[26px] w-auto text-[#FEF4E5]" />}
            </div>
            <div className="mt-1.5 text-[12.5px] text-[#FEF4E5]/60">{s.label}</div>
          </div>
        ))}
      </section>

      {/* ── Categories ──────────────────────────────────────────────────── */}
      <section id="work" className={`scroll-mt-8 py-16 lg:py-24 ${gutter}`}>
        <div className="mb-11 flex flex-wrap items-end justify-between gap-10">
          <div>
            <div className={`${overline} mb-4 text-[11.5px] tracking-[0.2em] text-[#3F25FE]`}>
              What&apos;s on Hustlr
            </div>
            <h2
              className={`${display} m-0 text-[clamp(36px,4.4vw,64px)] leading-none font-bold tracking-[-0.02em]! text-[#363636]`}
            >
              Every kind of hustle
            </h2>
          </div>
          <Link
            href="/login"
            className="inline-flex items-center gap-[9px] text-[15px] font-semibold text-[#3F25FE] transition hover:opacity-70"
          >
            Browse all 240 open gigs <IconArrow className="h-3 w-auto" />
          </Link>
        </div>

        <div className="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-4">
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
                    ? "bg-[#3F25FE]"
                    : red
                      ? "bg-[#EA4637]"
                      : "border border-[#363636]/12 bg-white hover:border-[#3F25FE]"
                }`}
              >
                <Icon
                  className={`mb-auto h-7 w-auto ${onColor ? "text-[#FEF4E5]" : "text-[#3F25FE]"}`}
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
        <div className={`${overline} mb-4 text-[11.5px] tracking-[0.2em] text-[#3F25FE]`}>
          How it works
        </div>
        <h2
          className={`${display} m-0 mb-5 text-[clamp(36px,4.4vw,64px)] leading-none font-bold tracking-[-0.02em]! text-[#363636]`}
        >
          Three steps. No résumé.
        </h2>
        <p className="m-0 mb-13 max-w-[56ch] text-[17.5px] leading-[1.6] text-[#5B5570]">
          The whole thing is designed to fit in the gap between a 9 AM and a 2 PM.
        </p>
        <div className="grid gap-px border border-[#363636]/14 bg-[#363636]/14 md:grid-cols-3">
          {STEPS.map((s) => (
            <div key={s.n} className="bg-white px-9 py-10">
              <div className={`${display} mb-[18px] text-[56px] leading-none font-bold text-[#E9E6FF]`}>
                {s.n}
              </div>
              <div className={`${display} mb-2.5 text-[27px] font-semibold text-[#363636]`}>
                {s.title}
              </div>
              <p className="m-0 text-[15.5px] leading-[1.6] text-[#5B5570]">{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Trust & safety ──────────────────────────────────────────────── */}
      <section
        id="trust"
        className={`relative scroll-mt-8 overflow-hidden bg-[#3F25FE] py-16 lg:py-24 ${gutter}`}
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
          <div className={`${overline} mb-4 text-[11.5px] tracking-[0.2em] text-[#FEF4E5]/60`}>
            Trust &amp; safety
          </div>
          <h2
            className={`${display} m-0 mb-5 text-[clamp(36px,4.4vw,64px)] leading-none font-bold tracking-[-0.02em]! text-[#FEF4E5]`}
          >
            Work you can trust.
          </h2>
          <p className="m-0 mb-13 max-w-[58ch] text-[17.5px] leading-[1.6] text-[#FEF4E5]/75">
            Every earner verifies a .edu address and a government ID before their first job. Every
            dollar sits in escrow until both sides confirm the work is done.
          </p>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-5">
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
        className="grid scroll-mt-8 gap-px bg-[#363636]/14 lg:grid-cols-[repeat(auto-fit,minmax(400px,1fr))]"
      >
        <div className={`bg-[#FEF4E5] py-16 lg:py-[88px] ${gutter}`}>
          <span className="mb-6 inline-flex items-center gap-2 rounded-full bg-[#E9E6FF] px-[14px] py-[7px] text-[12.5px] font-bold text-[#3F25FE]">
            <IconParttime className="h-[13px] w-auto" /> For students
          </span>
          <h3
            className={`${display} m-0 mb-[18px] text-[clamp(30px,3.4vw,46px)] leading-[1.05] font-semibold tracking-[-0.02em]! text-[#363636]`}
          >
            Earn between
            <br />
            lectures.
          </h3>
          <p className="m-0 mb-[26px] max-w-[42ch] text-[16.5px] leading-[1.6] text-[#5B5570]">
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
          <Link
            href="/login?mode=signup"
            className="inline-flex items-center gap-[10px] rounded-[14px] bg-[#3F25FE] px-7 py-[15px] text-[16px] font-semibold text-[#FEF4E5] transition hover:bg-[#2b17c2]"
          >
            Start earning <IconArrow className="h-3 w-auto" />
          </Link>
        </div>

        <div className={`bg-[#363636] py-16 lg:py-[88px] ${gutter}`}>
          <span className="mb-6 inline-flex items-center gap-2 rounded-full bg-[#FEF4E5]/14 px-[14px] py-[7px] text-[12.5px] font-bold text-[#FEF4E5]">
            <IconHome className="h-[13px] w-auto" /> For posters
          </span>
          <h3
            className={`${display} m-0 mb-[18px] text-[clamp(30px,3.4vw,46px)] leading-[1.05] font-semibold tracking-[-0.02em]! text-[#FEF4E5]`}
          >
            Someone at your
            <br />
            door by Friday.
          </h3>
          <p className="m-0 mb-[26px] max-w-[42ch] text-[16.5px] leading-[1.6] text-[#FEF4E5]/72">
            Post the job, name the price, pick the times that work. Verified students nearby apply
            within the hour.
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
          <Link
            href="/login?mode=signup"
            className="inline-flex items-center gap-[10px] rounded-[14px] bg-[#EA4637] px-7 py-[15px] text-[16px] font-semibold text-white transition hover:bg-[#B8291B]"
          >
            Post a job <IconArrow className="h-3 w-auto" />
          </Link>
        </div>
      </section>

      {/* ── Testimonials ────────────────────────────────────────────────── */}
      <section className={`border-t border-[#363636]/8 bg-white py-16 lg:py-24 ${gutter}`}>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-6">
          {REVIEWS.map((r) => (
            <figure
              key={r.name}
              className="m-0 rounded-[20px] border border-[#363636]/12 px-8 py-9"
            >
              <div className="mb-5 flex gap-[3px]" aria-label="5 out of 5 stars">
                {Array.from({ length: 5 }).map((_, i) => (
                  <IconStar key={i} className="h-[15px] w-auto text-[#3F25FE]" />
                ))}
              </div>
              <blockquote
                className={`${display} m-0 mb-6 text-[23px] leading-[1.3] font-medium text-[#363636]`}
              >
                &ldquo;{r.quote}&rdquo;
              </blockquote>
              <figcaption className="flex items-center gap-[11px]">
                <span
                  className={`flex size-9 items-center justify-center rounded-full text-[13px] font-bold text-[#FEF4E5] ${r.bg}`}
                >
                  {r.initials}
                </span>
                <span>
                  <span className="block text-[14px] font-bold text-[#363636]">{r.name}</span>
                  <span className="block text-[12.5px] text-[#9A93AD]">{r.meta}</span>
                </span>
              </figcaption>
            </figure>
          ))}
        </div>
      </section>

      {/* ── Closing CTA ─────────────────────────────────────────────────── */}
      <section className={`pt-20 pb-24 ${gutter}`}>
        <div className="overflow-hidden rounded-[28px] bg-[linear-gradient(140deg,#3F25FE_0%,#7A5CF0_55%,#C94FA8_100%)] px-8 py-16 text-center lg:px-14 lg:py-20">
          <HustlrMark className="mx-auto mb-7 h-11 w-auto text-[#FEF4E5]" />
          <h2
            className={`${display} m-0 mb-[18px] text-[clamp(36px,4.8vw,72px)] leading-none font-bold tracking-[-0.02em]! text-[#FEF4E5]`}
          >
            Make your next move.
          </h2>
          <p className="mx-auto m-0 mb-[34px] max-w-[44ch] text-[18px] leading-[1.6] text-[#FEF4E5]/82">
            Free to join. Verified in a day. First gig usually within the week.
          </p>
          <div className="flex flex-wrap justify-center gap-[14px]">
            <Link
              href="/login?mode=signup"
              className="inline-flex items-center gap-[10px] rounded-[14px] bg-[#FEF4E5] px-8 py-[17px] text-[17px] font-semibold text-[#3F25FE] transition hover:opacity-90"
            >
              Get started <IconArrow className="h-[13px] w-auto" />
            </Link>
            <Link
              href="/login?mode=signup"
              className="inline-flex items-center gap-[10px] rounded-[14px] border-2 border-[#FEF4E5]/50 px-8 py-[15px] text-[17px] font-semibold text-[#FEF4E5] transition hover:bg-[#FEF4E5]/10"
            >
              Download the app
            </Link>
          </div>
        </div>
      </section>

      {/* ── Footer ──────────────────────────────────────────────────────── */}
      <footer className={`bg-[#363636] pt-16 pb-10 ${gutter}`}>
        <div className="mb-12 flex flex-wrap justify-between gap-14">
          <div className="max-w-[34ch]">
            <div className="mb-[18px] flex items-center gap-3">
              <HustlrMark className="h-[30px] w-auto text-[#FEF4E5]" />
              <HustlrWordmark className="h-[23px] w-auto text-[#FEF4E5]" />
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
            <FooterCol
              heading="Company"
              links={[
                { label: "Contact", href: "/contact" },
                { label: "Campus partners", href: "/contact" },
                { label: "Careers", href: "/contact" },
              ]}
            />
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
            className={`${overline} normal-case transition hover:text-[#FEF4E5]/80`}
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
      <div
        className={`${overline} mb-4 text-[10.5px] tracking-[0.16em] text-[#FEF4E5]/45`}
      >
        {heading}
      </div>
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
   real app read as the same product. Decorative: hidden from assistive tech. */
function PhoneMock() {
  return (
    <div className="relative flex justify-center" aria-hidden>
      <div className="absolute inset-y-[-10%] inset-x-[-6%] rounded-[48px] bg-[linear-gradient(150deg,#5038FF,#3F25FE)] opacity-10 blur-[50px]" />
      <div className="relative w-[326px] max-w-full rounded-[50px] bg-[#1B1B1B] p-[9px] shadow-[0_30px_70px_rgba(24,18,49,.28)]">
        <div className="relative h-[640px] w-full overflow-hidden rounded-[42px] bg-[#F7F2EA]">
          {/* Dynamic Island */}
          <div className="absolute top-2.5 left-1/2 z-30 h-[27px] w-[98px] -translate-x-1/2 rounded-2xl bg-black" />

          <div className="px-4">
            {/* Status bar */}
            <div className="flex h-11 items-end justify-between pb-1">
              <span className="text-xs font-semibold text-[#1A1338]">20:01</span>
              <span className="flex items-center gap-[5px]">
                <IconRemote className="h-2 w-auto text-[#1A1338]" />
                <span className="h-[9px] w-[19px] rounded-[2.5px] bg-[#1A1338]" />
              </span>
            </div>

            {/* Greeting */}
            <div className="mt-4 flex items-start justify-between gap-2.5">
              <div>
                <div className="text-[27px] leading-[1.05] font-extrabold tracking-[-0.6px] text-[#1A1338]">
                  Hey Chris
                </div>
                <div className="mt-[3px] text-[13.5px] text-[#6B6482]">Ready to hustle?</div>
              </div>
              <span className="mt-[3px] inline-flex items-center gap-1.5 rounded-full bg-white px-[13px] py-2 whitespace-nowrap shadow-[0_1px_4px_rgba(24,18,49,.06)]">
                <span className="text-[11px]">🔥</span>
                <span className="text-xs font-semibold text-[#1A1338]">Start a streak</span>
              </span>
            </div>

            {/* Search + filter */}
            <div className="mt-3.5 flex items-center gap-[9px]">
              <div className="flex h-10 flex-1 items-center gap-[9px] rounded-full bg-white px-[15px]">
                <span className="size-[11px] shrink-0 rounded-full border-[1.8px] border-[#9A93AD]" />
                <span className="text-[13px] text-[#9A93AD]">Search gigs...</span>
              </div>
              <div className="flex size-10 shrink-0 flex-col items-center justify-center gap-[3px] rounded-[13px] bg-[#1A1338]">
                <span className="h-[1.6px] w-[15px] rounded-[1px] bg-[#FEF4E5]" />
                <span className="h-[1.6px] w-[15px] rounded-[1px] bg-[#FEF4E5]" />
                <span className="h-[1.6px] w-[15px] rounded-[1px] bg-[#FEF4E5]" />
              </div>
            </div>

            {/* Chips */}
            <div className="mt-[13px] flex gap-[7px] overflow-hidden">
              <span className="inline-flex items-center gap-[5px] rounded-full bg-white px-[13px] py-2 text-[11.5px] font-semibold whitespace-nowrap text-[#1A1338]">
                <IconStar className="h-2.5 w-auto" /> For You
              </span>
              <span className="inline-flex items-center gap-[5px] rounded-full bg-[#1A1338] px-[13px] py-2 text-[11.5px] font-semibold whitespace-nowrap text-[#FEF4E5]">
                <IconCampus className="h-2.5 w-auto" /> All
              </span>
              <span className="inline-flex items-center gap-[5px] rounded-full bg-white px-[13px] py-2 text-[11.5px] font-semibold whitespace-nowrap text-[#1A1338]">
                <IconPerson className="h-2.5 w-auto" /> Tutoring
              </span>
              <span className="inline-flex items-center rounded-full bg-white px-[13px] py-2 text-[11.5px] font-semibold whitespace-nowrap text-[#1A1338]">
                Delivery
              </span>
            </div>

            {/* List header */}
            <div className="mt-3.5 mb-[9px] flex items-center justify-between">
              <span className="text-[12.5px] font-semibold text-[#6B6482]">6 gigs available</span>
              <span className="flex items-center gap-3 text-xs font-semibold text-[#1A1338]">
                <span>Insights</span>
                <span>Map</span>
              </span>
            </div>

            {/* Card 1 — urgent */}
            <div className="relative mb-2.5 rounded-[20px] bg-white p-3.5">
              <IconBookmark className="absolute top-3.5 right-3.5 h-3.5 w-auto text-[#3F25FE]" />
              <div className="mb-2 flex items-center gap-[7px]">
                <span className="inline-flex items-center gap-[3px] rounded-full bg-[#FFE7E3] px-2 py-[3px] text-[9.5px] font-bold text-[#EA4637]">
                  ⚡ Urgent
                </span>
                <span className="text-[10.5px] font-medium text-[#9A93AD]">Moving</span>
                <span className="flex-1" />
                <span className="mr-[22px] text-[10.5px] text-[#9A93AD]">Jul 30</span>
              </div>
              <div className="mb-[3px] text-[14.5px] font-bold text-[#1A1338]">
                Help unload a U-Haul
              </div>
              <div className="mb-[9px] text-[11.5px] text-[#6B6482]">Two-bedroom, second floor.</div>
              <div className="mb-[9px] flex items-center justify-between">
                <span className="text-[13.5px] font-bold text-[#1A1338]">$60 flat</span>
                <span className="text-[10.5px] text-[#9A93AD]">Plano, TX</span>
              </div>
              <div className="flex items-center gap-[7px] border-t border-[#F0EBDF] pt-[9px]">
                <span className="flex size-[19px] items-center justify-center rounded-full bg-[#3F25FE] text-[8.5px] font-bold text-[#FEF4E5]">
                  DK
                </span>
                <span className="text-[11px] font-semibold text-[#6B6482]">Dana Kim</span>
                <span className="flex-1" />
                <span className="flex items-center gap-[3px]">
                  <IconStar className="h-2.5 w-auto text-[#3F25FE]" />
                  <span className="text-[11px] font-semibold text-[#6B6482]">4.9</span>
                </span>
              </div>
            </div>

            {/* Card 2 */}
            <div className="relative mb-2.5 rounded-[20px] bg-white p-3.5">
              <IconBookmark className="absolute top-3.5 right-3.5 h-3.5 w-auto text-[#3F25FE] opacity-25" />
              <div className="mb-2 flex items-center gap-[7px]">
                <span className="text-[10.5px] font-medium text-[#9A93AD]">Tutoring</span>
                <span className="flex-1" />
                <span className="mr-[22px] text-[10.5px] text-[#9A93AD]">Aug 3</span>
              </div>
              <div className="mb-2 text-[14.5px] font-bold text-[#1A1338]">Calc II exam prep</div>
              <div className="flex items-center justify-between">
                <span className="text-[13.5px] font-bold text-[#1A1338]">$28 / hr</span>
                <span className="mr-[52px] text-[10.5px] text-[#9A93AD]">Farmers Branch, TX</span>
              </div>
            </div>

            {/* Card 3 — crops under the tab bar */}
            <div className="rounded-[20px] bg-white px-3.5 pt-3.5 pb-8">
              <div className="mb-[7px] text-[10.5px] font-medium text-[#9A93AD]">Moving</div>
              <div className="mb-[3px] text-[14.5px] font-bold text-[#1A1338]">
                Furniture moving help
              </div>
              <div className="text-[11.5px] text-[#6B6482]">Two couches, one flight of stairs.</div>
            </div>
          </div>

          {/* AI FAB */}
          <div className="absolute right-4 bottom-[100px] z-20 flex size-11 items-center justify-center rounded-full bg-[#3F25FE] shadow-[0_6px_18px_rgba(63,37,254,.34)]">
            <IconStar className="h-[19px] w-auto text-[#FEF4E5]" />
          </div>

          {/* Tab bar */}
          <div className="absolute inset-x-3 bottom-[18px] z-20 flex items-center justify-around rounded-full bg-white px-1 py-[9px] shadow-[0_6px_22px_rgba(24,18,49,.14)]">
            <TabItem icon={IconHome} label="Browse" active />
            <TabItem icon={IconBriefcase} label="My Jobs" badge="1" />
            <TabItem icon={IconCampus} label="Hire" />
            <TabItem icon={IconChat} label="Messages" />
            <TabItem icon={IconPerson} label="Profile" />
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
  icon: typeof IconHome;
  label: string;
  active?: boolean;
  badge?: string;
}) {
  return (
    <span className="relative flex flex-col items-center gap-0.5">
      <Icon className={`h-4 w-auto text-[#3F25FE] ${active ? "" : "opacity-[0.42]"}`} />
      {badge && (
        <span className="absolute -top-1 right-0.5 flex h-[13px] min-w-[13px] items-center justify-center rounded-[7px] bg-[#EA4637] text-[8px] font-bold text-white">
          {badge}
        </span>
      )}
      <span
        className={`text-[8.5px] font-semibold ${active ? "text-[#3F25FE]" : "text-[#9A93AD]"}`}
      >
        {label}
      </span>
    </span>
  );
}
