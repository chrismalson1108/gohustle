"use client";

import { useState, useMemo, useEffect } from "react";
import { redeemPromoCode, normalizePromoCode } from "@/lib/promoCodes";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Search, X, ChevronRight, UserCircle2, Clock, Eye, CreditCard, Receipt,
  SlidersHorizontal, Bell, Bookmark, Heart, FileText, Lock, Briefcase, Mail, LogOut, Tag,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useJobs } from "@/lib/jobs";
import { SUPPORT_EMAIL } from "@/lib/legal";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import Button from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import { classNames } from "@/lib/format";

// The settings HUB — the mirror of src/screens/SettingsScreen.js, which is where
// the You tab's gear actually goes on mobile. Web previously sent the gear straight
// to the long profile form (mobile's ProfileSettings, one tap deeper than this), so
// everything else reachable from mobile's Settings had no home on web at all.
//
// This screen is navigation plus the things that don't need a form; the search
// filters across every row, because a flat list of 20-odd rows is unusable without
// it — which is why both iOS and Android ship search in Settings.

interface Row {
  icon: LucideIcon;
  title: string;
  sub?: string;
  /** Widens what a row matches without cluttering its label. */
  keywords?: string;
  href?: string;
  onClick?: () => void;
  danger?: boolean;
}

export default function SettingsPage() {
  const { user, signOut } = useAuth();
  // Promo-code redemption. Mobile got this first; leaving web without it would mean a
  // campaign distributed by code reached phone users and nobody else — the same
  // one-surface gap that made 2FA bypassable by opening a browser.
  const [codeOpen, setCodeOpen] = useState(false);
  const [code, setCode] = useState("");
  const [codeBusy, setCodeBusy] = useState(false);
  const [codeMsg, setCodeMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const { getPaymentReadiness } = useJobs();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [payReady, setPayReady] = useState<Awaited<ReturnType<typeof getPaymentReadiness>> | null>(null);

  useEffect(() => {
    getPaymentReadiness().then(setPayReady).catch(() => {});
  }, [getPaymentReadiness]);

  // Payments subtitle mirrors the You tab's banner so the two never disagree.
  const paymentsSub = !payReady
    ? "Payout account & card on file"
    : payReady.payoutReady && payReady.paymentMethodReady
      ? "Payouts active · card on file"
      : payReady.payout?.state === "pending"
        ? "Stripe is verifying your details"
        : !payReady.payoutReady
          ? "Finish payout setup to get paid"
          : "Add a card so you can hire";

  const GROUPS: { title: string; rows: Row[] }[] = useMemo(
    () => [
      {
        title: "Account",
        rows: [
          {
            icon: UserCircle2,
            title: "Profile settings",
            sub: "Photo, name, bio, skills, college, availability radius",
            keywords: "avatar picture username role location skills major graduation certifications date of birth",
            href: "/profile/settings",
          },
          {
            icon: Clock,
            title: "Availability & schedule",
            sub: "Work status, hours & classes",
            keywords: "busy hours calendar classes schedule status",
            href: "/profile/availability",
          },
          {
            icon: Eye,
            title: "View my public profile",
            sub: "See exactly how others see you",
            keywords: "public preview others reviews",
            href: user ? `/u/${user.id}` : undefined,
          },
        ],
      },
      {
        title: "Money",
        rows: [
          {
            icon: CreditCard,
            title: "Payments & payouts",
            sub: paymentsSub,
            keywords: "stripe bank card payout money withdraw earnings deposit",
            href: "/profile/payouts",
          },
          {
            icon: Receipt,
            title: "Tax Center",
            sub: "Track expenses & export for taxes",
            keywords: "tax 1099 expenses mileage receipts income export csv",
            href: "/profile/taxes",
          },
          {
            icon: Tag,
            title: "Have a code?",
            sub: "Redeem a promo or referral code",
            keywords: "promo code coupon referral discount voucher offer redeem claim",
            onClick: () => setCodeOpen(true),
          },
        ],
      },
      {
        title: "Notifications",
        rows: [
          {
            icon: SlidersHorizontal,
            title: "Notification settings",
            sub: "Push & email preferences",
            keywords: "push email alerts mute preferences",
            href: "/profile/notifications",
          },
          {
            icon: Bell,
            title: "Alerts inbox",
            sub: "Booking updates & gig matches",
            keywords: "inbox unread messages updates",
            href: "/notifications",
          },
        ],
      },
      {
        title: "Saved",
        rows: [
          {
            icon: Bookmark,
            title: "Saved gigs",
            sub: "Gigs you've bookmarked",
            keywords: "bookmarks favourites favorites later",
            href: "/profile/saved-gigs",
          },
          {
            icon: Heart,
            title: "Saved people",
            sub: "Workers & clients you've favorited",
            keywords: "favourites favorites people workers clients",
            href: "/profile/saved",
          },
        ],
      },
      {
        title: "Legal & support",
        rows: [
          { icon: FileText, title: "Terms of Service", keywords: "legal terms agreement", href: "/legal/terms" },
          { icon: Lock, title: "Privacy Policy", keywords: "legal privacy data gdpr", href: "/legal/privacy" },
          {
            icon: Briefcase,
            title: "Independent Contractor Agreement",
            keywords: "legal contractor 1099 employment classification",
            href: "/legal/contractor",
          },
          {
            icon: Mail,
            title: "Contact support",
            sub: SUPPORT_EMAIL,
            keywords: "help email problem report bug",
            href: `mailto:${SUPPORT_EMAIL}?subject=GoHustlr%20Support`,
          },
        ],
      },
      {
        title: "Account actions",
        rows: [
          // Sign out is the ONLY account action at this level. Deleting your account
          // is deliberately not a row here — it lives at the bottom of Profile
          // settings, behind a typed confirmation, so it can't be reached by
          // scrolling to the end of the settings list and tapping the last red
          // thing. Search still finds it (see the keywords below).
          {
            icon: LogOut,
            title: "Sign out",
            danger: true,
            keywords: "logout log out leave",
            onClick: () => setSignOutOpen(true),
          },
          {
            icon: UserCircle2,
            title: "Manage your account",
            sub: "Profile details, and closing your account",
            keywords: "delete remove close erase gdpr account deletion",
            href: "/profile/settings",
          },
        ],
      },
    ],
    [user, paymentsSub],
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return GROUPS;
    return GROUPS.map((g) => ({
      ...g,
      rows: g.rows.filter((r) =>
        `${r.title} ${r.sub || ""} ${r.keywords || ""} ${g.title}`.toLowerCase().includes(needle),
      ),
    })).filter((g) => g.rows.length > 0);
  }, [q, GROUPS]);

  return (
    <div>
      <PageHeader title="Settings" width="form" back="/profile">
        <div className="mt-4 flex h-11 items-center gap-2 rounded-full border border-line bg-white px-3.5">
          <Search className="size-4 shrink-0 text-ink-muted" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search settings"
            aria-label="Search settings"
            autoCorrect="off"
            autoCapitalize="none"
            className="h-full min-w-0 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-ink-muted sm:text-[15px]"
          />
          {q && (
            <button onClick={() => setQ("")} aria-label="Clear search" className="shrink-0">
              <X className="size-4 text-ink-muted" />
            </button>
          )}
        </div>
      </PageHeader>

      <PageContainer width="form" className="space-y-6 pb-10">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center px-10 pt-14 text-center">
            <Search className="size-[30px] text-ink-muted" />
            <p className="mt-3 line-clamp-2 text-base font-bold text-ink">No settings match “{q}”</p>
            <p className="mt-1.5 text-[13px] leading-[18px] text-ink-muted">
              Try a different word, like “payout”, “notifications” or “privacy”.
            </p>
          </div>
        ) : (
          filtered.map((group) => (
            <section key={group.title} className="min-w-0">
              {/* Uppercase + letter-spacing is a deliberate exception to the app's
                  "no uppercase labels" rule: it is the iOS/Android Settings idiom
                  and it is exactly what mobile's SettingsScreen groupTitle does
                  (12px/700, letterSpacing 0.6). Don't "de-AI" this one away. */}
              <h2 className="mb-2 ml-1 text-xs font-bold uppercase tracking-[0.6px] text-ink-muted">
                {group.title}
              </h2>
              <div className="overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-card)]">
                {group.rows.map((r, i) => (
                  <SettingsRow key={r.title} row={r} last={i === group.rows.length - 1} />
                ))}
              </div>
            </section>
          ))
        )}
      </PageContainer>

      {/* Signing out means re-verifying by email to get back in, so it asks first. */}
      <Modal open={signOutOpen} onClose={() => setSignOutOpen(false)} title="Sign out?" size="sm">
        <p className="text-sm leading-relaxed text-ink-soft">
          You&apos;ll need to sign in again to get back to your gigs.
        </p>
        <div className="mt-5 flex gap-3">
          <Button variant="outline" fullWidth onClick={() => setSignOutOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            fullWidth
            onClick={async () => {
              setSignOutOpen(false);
              await signOut();
              router.replace("/login");
            }}
          >
            Sign out
          </Button>
        </div>
      </Modal>

      {/* Promo / referral code redemption. One message for every failure — the RPC
          returns a bare boolean on purpose, because distinct errors would be an
          existence oracle for brute-forcing valid codes, and it is rate-limited on
          ATTEMPTS rather than successes. */}
      <Modal open={codeOpen} onClose={() => setCodeOpen(false)} title="Have a code?">
        <div className="space-y-3">
          <p className="text-sm text-ink-soft">
            Promo and referral codes are claimed once and apply automatically to your next
            eligible gig.
          </p>
          <input
            value={code}
            onChange={(e) => { setCode(normalizePromoCode(e.target.value)); setCodeMsg(null); }}
            placeholder="ENTER CODE"
            autoCapitalize="characters"
            autoCorrect="off"
            className="w-full rounded-xl bg-canvas px-4 py-3 text-center text-lg font-bold tracking-[0.2em] text-ink outline-none ring-1 ring-line focus:ring-2 focus:ring-primary"
          />
          {codeMsg ? (
            <p className={classNames("text-center text-sm font-semibold", codeMsg.ok ? "text-success" : "text-urgent")}>
              {codeMsg.text}
            </p>
          ) : null}
          <Button
            className="w-full"
            disabled={!code || codeBusy}
            onClick={async () => {
              setCodeBusy(true); setCodeMsg(null);
              try {
                const ok = await redeemPromoCode(code);
                if (ok) {
                  setCodeMsg({ ok: true, text: "Code applied — it will apply to your next eligible gig." });
                  setCode("");
                } else {
                  setCodeMsg({ ok: false, text: "That code isn't available. Check it and try again." });
                }
              } finally { setCodeBusy(false); }
            }}
          >
            {codeBusy ? "Checking…" : "Apply code"}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

function SettingsRow({ row, last }: { row: Row; last: boolean }) {
  const { icon: Icon, title, sub, danger, href, onClick } = row;
  const content = (
    <>
      <span
        className={classNames(
          "flex size-[34px] shrink-0 items-center justify-center rounded-xl",
          danger ? "bg-urgent-light" : "bg-canvas",
        )}
      >
        <Icon className={classNames("size-[18px]", danger ? "text-urgent" : "text-primary")} />
      </span>
      {/* min-w-0 on the text column + shrink-0 on the chevron: a long row title
          must ellipsize rather than push the chevron past the card's edge. */}
      <span className="min-w-0 flex-1">
        <span className={classNames("block truncate text-[15px] font-semibold", danger ? "text-urgent" : "text-ink")}>
          {title}
        </span>
        {sub && <span className="mt-0.5 block line-clamp-2 text-[13px] leading-[17px] text-ink-muted">{sub}</span>}
      </span>
      <ChevronRight className="size-[17px] shrink-0 text-ink-muted" />
    </>
  );
  const cls = classNames(
    "flex w-full items-center gap-3 px-3.5 py-3.5 text-left transition hover:bg-canvas",
    !last && "border-b border-line",
  );

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={cls}>
        {content}
      </button>
    );
  }
  // mailto: and any other non-app scheme must be a plain anchor — next/link's
  // client router would try to resolve it as a route.
  if (href?.startsWith("mailto:")) {
    return (
      <a href={href} className={cls}>
        {content}
      </a>
    );
  }
  if (href) {
    return (
      <Link href={href} className={cls}>
        {content}
      </Link>
    );
  }
  return <div className={classNames(cls, "cursor-default")}>{content}</div>;
}
