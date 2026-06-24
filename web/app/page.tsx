import Link from "next/link";
import { CATEGORIES } from "@gohustlr/shared";
import { ArrowRight, ShieldCheck, Zap, Wallet, Star, MapPin } from "lucide-react";
import Logo from "@/components/Logo";
import { buttonClasses } from "@/components/ui/Button";

const STEPS = [
  { n: "1", title: "Post or find a gig", body: "Browse local gigs near campus, or post one in seconds and set your price." },
  { n: "2", title: "Book & confirm", body: "Pick a time slot, send a counter-offer, and get confirmed by the other side." },
  { n: "3", title: "Do the work, get paid", body: "Money is held safely in escrow and released the moment the job is verified." },
];

const FEATURES = [
  { icon: ShieldCheck, title: "Secure escrow", body: "Card payments are held until the job is done — protected for both sides." },
  { icon: Zap, title: "Built for students", body: "Flexible, low-barrier gigs that fit around classes. Earn between lectures." },
  { icon: Wallet, title: "Fast payouts + Tax Center", body: "Cash out to your bank, log expenses, and export a Schedule-C summary." },
  { icon: Star, title: "Two-way ratings", body: "Reviews on both sides build a reputation you can take anywhere." },
];

export default function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col">
      {/* Nav */}
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-5">
        <Logo />
        <div className="flex items-center gap-2">
          <Link href="/login" className={buttonClasses("ghost", "sm")}>
            Log in
          </Link>
          <Link href="/login?mode=signup" className={buttonClasses("primary", "sm")}>
            Get started
          </Link>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="mx-auto grid w-full max-w-6xl items-center gap-10 px-5 py-12 md:grid-cols-2 md:py-20">
          <div>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-primary-light px-3 py-1 text-sm font-bold text-primary">
              <MapPin className="size-4" /> Gig work for college students
            </span>
            <h1 className="mt-5 text-4xl font-black leading-[1.05] tracking-tight text-ink md:text-6xl">
              Turn spare hours into{" "}
              <span className="bg-brand bg-clip-text text-transparent" style={{ WebkitBackgroundClip: "text", backgroundImage: "var(--background-image-brand)" }}>
                real money.
              </span>
            </h1>
            <p className="mt-5 max-w-md text-lg text-ink-soft">
              GoHustlr connects students who need a hand with students ready to hustle. Find flexible local
              gigs, hire help, and get paid securely.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Link href="/login?mode=signup" className={buttonClasses("primary", "lg")}>
                Start hustling <ArrowRight className="size-5" />
              </Link>
              <Link href="/browse" className={buttonClasses("outline", "lg")}>
                Browse gigs
              </Link>
            </div>
            <p className="mt-4 text-sm text-ink-muted">Free to join · Secure payments · No subscriptions</p>
          </div>

          {/* Hero card */}
          <div className="relative">
            <div className="bg-brand absolute -inset-4 rounded-[2rem] opacity-10 blur-2xl" />
            <div className="relative rounded-[2rem] bg-white p-6 shadow-[var(--shadow-pop)] ring-1 ring-line">
              <div className="bg-brand flex items-center justify-between rounded-2xl p-4 text-white">
                <div>
                  <p className="text-sm/none opacity-80">This week</p>
                  <p className="mt-1 text-3xl font-black">$420 earned</p>
                </div>
                <div className="rounded-xl bg-white/15 px-3 py-2 text-center">
                  <p className="text-xl font-black">🔥 7</p>
                  <p className="text-[10px] opacity-80">day streak</p>
                </div>
              </div>
              <div className="mt-4 space-y-3">
                {[
                  { t: "Move a couch across campus", p: "$60", c: "Moving" },
                  { t: "Calc II tutoring — 2 hrs", p: "$50", c: "Tutoring" },
                  { t: "Grocery run to Trader Joe's", p: "$25", c: "Errands" },
                ].map((g) => (
                  <div key={g.t} className="flex items-center justify-between rounded-2xl border border-line p-3">
                    <div>
                      <p className="text-sm font-bold text-ink">{g.t}</p>
                      <p className="text-xs text-ink-muted">{g.c}</p>
                    </div>
                    <span className="rounded-full bg-accent-light px-2.5 py-1 text-sm font-black text-success">
                      {g.p}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Categories */}
      <section className="mx-auto w-full max-w-6xl px-5 py-12">
        <h2 className="text-center text-2xl font-black text-ink">Every kind of hustle</h2>
        <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {CATEGORIES.filter((c) => c.id !== "all").map((c) => (
            <Link
              key={c.id}
              href="/login"
              className="flex flex-col items-center gap-2 rounded-2xl border border-line bg-white p-5 text-center transition hover:border-primary hover:shadow-[var(--shadow-soft)]"
            >
              <span className="text-3xl">{c.icon}</span>
              <span className="text-sm font-bold text-ink">{c.label}</span>
            </Link>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="bg-white py-16">
        <div className="mx-auto w-full max-w-6xl px-5">
          <h2 className="text-center text-3xl font-black text-ink">How it works</h2>
          <div className="mt-10 grid gap-6 md:grid-cols-3">
            {STEPS.map((s) => (
              <div key={s.n} className="rounded-3xl border border-line p-7">
                <div className="bg-brand flex size-11 items-center justify-center rounded-2xl text-lg font-black text-white">
                  {s.n}
                </div>
                <h3 className="mt-4 text-lg font-black text-ink">{s.title}</h3>
                <p className="mt-2 text-ink-soft">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="mx-auto w-full max-w-6xl px-5 py-16">
        <div className="grid gap-5 sm:grid-cols-2">
          {FEATURES.map((f) => {
            const Icon = f.icon;
            return (
              <div key={f.title} className="flex gap-4 rounded-3xl border border-line bg-white p-6">
                <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-primary-light text-primary">
                  <Icon className="size-6" />
                </div>
                <div>
                  <h3 className="text-lg font-black text-ink">{f.title}</h3>
                  <p className="mt-1 text-ink-soft">{f.body}</p>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* CTA */}
      <section className="px-5 pb-20">
        <div className="bg-brand mx-auto w-full max-w-5xl rounded-[2.5rem] px-8 py-14 text-center text-white shadow-[var(--shadow-pop)]">
          <h2 className="text-3xl font-black md:text-4xl">Ready to start your hustle?</h2>
          <p className="mx-auto mt-3 max-w-md text-white/80">
            Join thousands of students earning on their own schedule.
          </p>
          <Link href="/login?mode=signup" className={buttonClasses("secondary", "lg", "mt-7 bg-white text-primary hover:bg-white")}>
            Create your free account <ArrowRight className="size-5" />
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-line bg-white">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-4 px-5 py-8 sm:flex-row">
          <Logo />
          <p className="text-sm text-ink-muted">© {new Date().getFullYear()} GoHustlr. Built for students.</p>
          <div className="flex gap-5 text-sm font-medium text-ink-soft">
            <Link href="/legal/terms" className="hover:text-primary">Terms</Link>
            <Link href="/legal/privacy" className="hover:text-primary">Privacy</Link>
            <Link href="/login" className="hover:text-primary">Log in</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
