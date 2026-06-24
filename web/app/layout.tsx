import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import Providers from "./providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

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
  icons: { icon: "/favicon.ico" },
};

export const viewport: Viewport = {
  themeColor: "#6D28D9",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geistSans.variable} h-full`}>
      <body className="min-h-full">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
