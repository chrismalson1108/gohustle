import { Akshar } from "next/font/google";
import Logo from "@/components/Logo";

const akshar = Akshar({
  variable: "--font-akshar",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

/**
 * Brand Guidelines v1.0 shell for the logged-out surfaces (sign-in, legal,
 * consent, contact, reset-password).
 *
 * Most of the palette already matches the guidelines — ink-soft #5B5570,
 * ink-muted #9A93AD, primary #3F25FE and primary-light #E9E6FF are all correct
 * in globals.css. Only three tokens and the display face are off, so rather
 * than restyle every element this re-points those CSS variables for its own
 * subtree. Anything inside using `bg-canvas` / `text-ink` / `border-line`
 * picks up the v1 values automatically, and the logged-in app — which shares
 * those utilities — is untouched.
 *
 * The `brand-v1` class carries the Akshar heading rule (see globals.css); it
 * has to be a real stylesheet rule because globals declares `h1, h2` unlayered,
 * which outranks Tailwind's layered utilities.
 */
export default function BrandShell({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`brand-v1 ${akshar.variable} ${className}`}
      style={
        {
          "--color-canvas": "#FEF4E5",
          "--color-ink": "#363636",
          // Solid equivalent of the rgba(54,54,54,.12) hairline the homepage
          // uses, composited over Cream — kept solid so `border-line/70` and
          // friends still resolve.
          "--color-line": "#E6DDD0",
        } as React.CSSProperties
      }
    >
      {children}
    </div>
  );
}

/** The horizontal lockup.
 *
 *  This used to compose the inline SVG glyphs (HustlrMark + HustlrWordmark) at the
 *  documented construction ratios. Those glyphs are the v1 vector pack — viewBox
 *  1210×1400 and 2600×588 — and the v3 art has different proportions AND ships the
 *  mark and wordmark drawn together as one lockup. Keeping the SVG path here would
 *  leave every logged-out page (login, consent, contact, legal, reset-password)
 *  showing the previous logo while the in-app chrome showed the new one.
 *
 *  Rendering the shared <Logo> keeps one source of truth: the PNGs distributed by
 *  `npm run brand:sync`. Swap back to vector only when a v3 SVG pack exists. */
export function BrandLockup({ height = 34 }: { height?: number }) {
  return (
    <span className="inline-flex items-center">
      <Logo height={height} />
      <span className="sr-only">Hustlr</span>
    </span>
  );
}
