"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { supabase } from "@/lib/supabaseClient";
import { SUPPORT_EMAIL } from "@/lib/legal";
import Logo from "@/components/Logo";
import { FullPageSpinner } from "@/components/ui/Spinner";

interface Doc {
  slug: string;
  version: string;
  title: string;
  body: string;
  published_at?: string;
}

// Public legal document viewer (Terms, Privacy, Independent Contractor Agreement).
// Reads the latest published version per slug from the legal_documents table.
export default function LegalDocPage() {
  const { doc } = useParams<{ doc: string }>();
  const [data, setData] = useState<Doc | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      const { data: rows } = await supabase
        .from("legal_documents")
        .select("slug, version, title, body, published_at")
        .eq("slug", doc)
        .order("published_at", { ascending: false })
        .limit(1);
      if (active) {
        setData((rows?.[0] as Doc) || null);
        setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [doc]);

  return (
    <div className="min-h-screen bg-canvas">
      <header className="mx-auto flex w-full max-w-3xl items-center justify-between px-5 py-5">
        <Link href="/">
          <Logo />
        </Link>
        <Link href="/" className="flex items-center gap-1 text-sm font-bold text-primary">
          <ArrowLeft className="size-4" /> Home
        </Link>
      </header>

      <main className="mx-auto w-full max-w-3xl px-5 pb-20">
        {loading ? (
          <FullPageSpinner />
        ) : data ? (
          <article className="rounded-3xl bg-white p-7 shadow-[var(--shadow-card)] ring-1 ring-line/70">
            <h1 className="text-2xl font-black text-ink">{data.title}</h1>
            <p className="mt-1 text-xs text-ink-muted">Version {data.version}</p>
            <div className="mt-5 whitespace-pre-wrap text-sm leading-relaxed text-ink-soft">{data.body}</div>
          </article>
        ) : (
          <div className="rounded-3xl bg-white p-7 text-center shadow-[var(--shadow-card)] ring-1 ring-line/70">
            <h1 className="text-xl font-black text-ink">Document not available</h1>
            <p className="mt-2 text-ink-soft">
              We couldn&apos;t find that document. Questions? Email{" "}
              <a href={`mailto:${SUPPORT_EMAIL}`} className="font-bold text-primary">{SUPPORT_EMAIL}</a>.
            </p>
          </div>
        )}
        <div className="mt-6 flex justify-center gap-5 text-sm font-medium text-ink-soft">
          <Link href="/legal/terms" className="hover:text-primary">Terms</Link>
          <Link href="/legal/privacy" className="hover:text-primary">Privacy</Link>
          <Link href="/legal/contractor" className="hover:text-primary">Contractor Agreement</Link>
        </div>
      </main>
    </div>
  );
}
