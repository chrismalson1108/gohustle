import type { Metadata, Viewport } from "next";
import { Sora, Inter } from "next/font/google";
import "./globals.css";
import Providers from "./providers";

// Hustlr type system: Sora for display/headings, Inter for body & UI.
const sora = Sora({ variable: "--font-sora", subsets: ["latin"], display: "swap" });
const inter = Inter({ variable: "--font-inter", subsets: ["latin"], display: "swap" });

// Brand Guidelines v1.0: the product is "Hustlr" (gohustlr.com is just the address),
// and the store/link headline is "Find jobs between classes" — under 30 characters,
// sentence case, no exclamation mark.
const TITLE = "Hustlr — Find jobs between classes";
const DESCRIPTION =
  "Real, paid work that fits between classes. Verified students, payment held in escrow, and money in your bank 48 hours after the job is done.";

export const metadata: Metadata = {
  title: {
    default: TITLE,
    template: "%s · Hustlr",
  },
  description: DESCRIPTION,
  metadataBase: new URL("https://gohustlr.com"),
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    siteName: "Hustlr",
    url: "https://gohustlr.com",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
};

export const viewport: Viewport = {
  themeColor: "#5038FF",
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
