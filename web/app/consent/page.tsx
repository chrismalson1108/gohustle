"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, ChevronRight } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { REQUIRED_SLUGS, fetchCurrentDocs, recordAcceptances, type LegalDoc } from "@/lib/legal";
import Button from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import { FullPageSpinner } from "@/components/ui/Spinner";

export default function ConsentPage() {
  const router = useRouter();
  const { user, session, loading: authLoading, needsTermsAcceptance, markTermsAccepted, signOut } = useAuth();
  const [docs, setDocs] = useState<Record<string, LegalDoc> | null>(null);
  const [saving, setSaving] = useState(false);
  const [openDoc, setOpenDoc] = useState<LegalDoc | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading) return; // session unknown yet — don't redirect-pinball on refresh
    if (session === null) router.replace("/login");
    else if (session && !needsTermsAcceptance) router.replace("/browse");
  }, [authLoading, session, needsTermsAcceptance, router]);

  useEffect(() => {
    fetchCurrentDocs().then(setDocs).catch(() => setDocs({}));
  }, []);

  const accept = async () => {
    if (!user) return;
    setError(null);
    setSaving(true);
    try {
      await recordAcceptances(user.id, docs || {});
      markTermsAccepted();
      router.replace("/browse");
    } catch {
      // Without feedback the auth gate just keeps bouncing the user back here.
      setError("Couldn't save your acceptance — check your connection and try again.");
      setSaving(false);
    }
  };

  if (!session) return <FullPageSpinner />;
  const ordered = REQUIRED_SLUGS.map((s) => docs?.[s]).filter(Boolean) as LegalDoc[];

  return (
    <div className="min-h-screen bg-canvas">
      <div className="bg-brand flex flex-col items-center px-6 pb-9 pt-16 text-center text-white">
        <FileText className="mb-3 size-11" />
        <h1 className="text-2xl font-black">We&apos;ve updated our terms</h1>
        <p className="mt-1.5 text-white/75">Please review and accept to keep using GoHustlr.</p>
      </div>

      <div className="mx-auto w-full max-w-md p-6">
        <p className="mb-5 text-sm leading-relaxed text-ink-soft">
          By continuing you agree to our updated documents. As an Earner you operate as an independent
          contractor and are responsible for your own taxes.
        </p>

        {docs === null ? (
          <FullPageSpinner />
        ) : (
          <div className="divide-y divide-divider overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-card)] ring-1 ring-line/70">
            {ordered.map((d) => (
              <button key={d.slug} onClick={() => setOpenDoc(d)} className="flex w-full items-center justify-between px-4 py-4 text-left hover:bg-primary-light/40">
                <span className="font-bold text-ink">{d.title}</span>
                <ChevronRight className="size-4 text-ink-muted" />
              </button>
            ))}
          </div>
        )}

        <Button size="lg" fullWidth className="mt-6" loading={saving} disabled={docs === null} onClick={accept}>
          Accept &amp; continue
        </Button>
        {error && <p className="mt-3 text-center text-sm font-medium text-urgent">{error}</p>}
        <Button variant="ghost" size="sm" fullWidth className="mt-4 text-ink-muted" onClick={() => signOut()}>
          Sign out
        </Button>
      </div>

      <Modal open={!!openDoc} onClose={() => setOpenDoc(null)} title={openDoc?.title} size="lg">
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-soft">{openDoc?.body}</p>
      </Modal>
    </div>
  );
}
