import type { Metadata, Viewport } from "next";
import { Sora, Inter } from "next/font/google";
import "./globals.css";
import Providers from "./providers";

// Hustlr type system: Sora for display/headings, Inter for body & UI.
const sora = Sora({ variable: "--font-sora", subsets: ["latin"], display: "swap" });
const inter = Inter({ variable: "--font-inter", subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: {
    default: "GoHustlr — Gig work for college students",
    template: "%s · GoHustlr",
  },
  description:
    "GoHustlr is the gig marketplace built for college students. Find flexible local gigs, hire help, get paid securely, and build your hustle.",
  metadataBase: new URL("https://gohustlr.com"),
  openGraph: {
    title: "GoHustlr — Gig work for college students",
    description:
      "Find flexible local gigs, hire help, and get paid securely. Built for college students.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "GoHustlr — Gig work for college students",
    description:
      "Find flexible local gigs, hire help, and get paid securely. Built for college students.",
  },
};

export const viewport: Viewport = {
  themeColor: "#3F25FE",
  width: "device-width",
  initialScale: 1,
  // Extend under the notch / home indicator so env(safe-area-inset-*) is non-zero
  // and fixed bottom bars can pad themselves clear of the iOS home indicator.
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${sora.variable} ${inter.variable} h-full`}>
      <body className="min-h-full">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
