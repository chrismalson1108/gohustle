"use client";

import Link from "next/link";
import { CheckCircle2, Clock, AlertTriangle, HelpCircle, Smartphone } from "lucide-react";
import Button, { buttonClasses } from "@/components/ui/Button";
import Spinner from "@/components/ui/Spinner";
import { SUPPORT_EMAIL } from "@/lib/legal";
import type { ConnectStatus } from "@/lib/connectStatus";

// Presentational half of the Stripe onboarding return screen. Kept free of fetching
// so every branch can be rendered (and eyeballed) from a known status object —
// this screen's whole job is telling four outcomes apart, and it used to get that
// wrong by hard-coding success.
export default function PayoutStatusCard({
  status,
  failed,
  resuming,
  noWebSession,
  onFinishSetup,
}: {
  /** null while loading. */
  status: ConnectStatus | null;
  failed: boolean;
  resuming: boolean;
  /** Visitor has no web session — almost always a mobile user returning from Stripe. */
  noWebSession?: boolean;
  onFinishSetup: () => void;
}) {
  // Mobile users land here inside an in-app browser that shares NO session with the
  // native app (the app's session lives in AsyncStorage). We can't read their payout
  // status, and we must NOT send them to /profile/payouts — that route is gated and
  // bounces to /login, which reads as "the app logged me out and made me sign up
  // again". Terminal state: send them back to the app, which re-checks status itself.
  if (noWebSession) {
    return (
      <Shell>
        <Badge tone="neutral">
          <Smartphone className="size-9" />
        </Badge>
        <Heading>Head back to the app</Heading>
        <Body>
          Your details were submitted to Stripe. Open Hustlr and your payout status will be up to date —
          you can close this window.
        </Body>
        <a href="gohustlr://" className={buttonClasses("primary", "lg", "mt-5 w-full")}>
          Open Hustlr
        </a>
      </Shell>
    );
  }

  if (!status && !failed) {
    return (
      <Shell>
        <div className="flex flex-col items-center gap-4 py-6">
          <Spinner className="size-7 text-primary" />
          <p className="text-sm text-ink-soft">Checking your payout status…</p>
        </div>
      </Shell>
    );
  }

  // Couldn't reach the server — say exactly that. Never claim a success we haven't seen.
  if (failed || !status) {
    return (
      <Shell>
        <Badge tone="neutral">
          <HelpCircle className="size-9" />
        </Badge>
        <Heading>Check your payout status</Heading>
        <Body>
          We couldn&apos;t confirm where your setup got to. Open Payouts &amp; payments to see the current state.
        </Body>
        <ReturnLink />
      </Shell>
    );
  }

  if (status.state === "active") {
    return (
      <Shell>
        <Badge tone="success">
          <CheckCircle2 className="size-9" />
        </Badge>
        <Heading>{status.title}</Heading>
        <Body>{status.message}</Body>
        <ReturnLink />
      </Shell>
    );
  }

  if (status.state === "pending") {
    return (
      <Shell>
        <Badge tone="neutral">
          <Clock className="size-9" />
        </Badge>
        <Heading>{status.title}</Heading>
        <Body>{status.message}</Body>
        <ReturnLink />
      </Shell>
    );
  }

  if (status.state === "restricted") {
    return (
      <Shell>
        <Badge tone="warning">
          <AlertTriangle className="size-9" />
        </Badge>
        <Heading>{status.title}</Heading>
        <Body>{status.message}</Body>
        <a href={`mailto:${SUPPORT_EMAIL}`} className={buttonClasses("outline", "lg", "mt-5 w-full")}>
          Contact support
        </a>
        <ReturnLink variant="ghost" />
      </Shell>
    );
  }

  // 'incomplete' / 'none' — they still owe Stripe something, so make finishing the
  // obvious next step instead of dropping them back into the app unable to be paid.
  return (
    <Shell>
      <Badge tone="warning">
        <AlertTriangle className="size-9" />
      </Badge>
      <Heading>{status.title}</Heading>
      <Body>{status.message}</Body>
      {status.requirements.length > 0 && (
        <ul className="mt-4 space-y-1.5 rounded-2xl bg-canvas p-4 text-left">
          {status.requirements.map((r) => (
            <li key={r} className="flex items-start gap-2 text-sm font-semibold text-ink">
              <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-urgent" />
              {r}
            </li>
          ))}
        </ul>
      )}
      <Button fullWidth size="lg" className="mt-5" loading={resuming} onClick={onFinishSetup}>
        Finish setup
      </Button>
      <ReturnLink label="Not now" variant="ghost" />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-full max-w-sm rounded-3xl bg-white p-8 text-center shadow-[var(--shadow-card)] ring-1 ring-line/70">
      {children}
    </div>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h1 className="font-display text-2xl font-bold text-ink">{children}</h1>;
}

function Body({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 text-sm leading-relaxed text-ink-soft">{children}</p>;
}

function Badge({ tone, children }: { tone: "success" | "warning" | "neutral"; children: React.ReactNode }) {
  const tones = {
    success: "bg-success-light text-success",
    warning: "bg-urgent-light text-urgent",
    neutral: "bg-primary-light text-primary",
  } as const;
  return (
    <div className={`mx-auto mb-5 flex size-16 items-center justify-center rounded-full ${tones[tone]}`}>
      {children}
    </div>
  );
}

function ReturnLink({
  label = "Return to GoHustlr",
  variant = "primary",
}: {
  label?: string;
  variant?: "primary" | "ghost";
}) {
  return (
    <Link href="/profile/payouts" className={buttonClasses(variant, "lg", "mt-3 w-full")}>
      {label}
    </Link>
  );
}
