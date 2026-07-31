"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, ChevronRight } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { REQUIRED_SLUGS, fetchCurrentDocs, recordAcceptances, type LegalDoc } from "@/lib/legal";
import Button from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import BrandShell from "@/components/brand/BrandShell";
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

  const loadDocs = () => {
    setError(null);
    fetchCurrentDocs()
      .then(setDocs)
      .catch(() => { setDocs({}); setError("Couldn't load the documents — check your connection and try again."); });
  };
  useEffect(loadDocs, []);

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

  // This one genuinely owns the whole page, so it opts into the full height.
  if (!session) return <FullPageSpinner className="min-h-dvh" />;
  const ordered = REQUIRED_SLUGS.map((s) => docs?.[s]).filter(Boolean) as LegalDoc[];

  return (
    <BrandShell>
      {/* dvh: 100vh is the URL-bar-collapsed height on mobile browsers. */}
      <div className="min-h-dvh bg-canvas px-4 pb-10 sm:px-6">
      {/* Header and body share one measure so the title lines up with the list. */}
      <div className="mx-auto flex w-full max-w-lg flex-col items-center pb-7 pt-12 text-center">
        <FileText className="mb-3 size-9 text-primary" />
        <h1 className="text-[26px] font-bold leading-[33px] text-ink">We&apos;ve updated our terms</h1>
        <p className="mt-2 text-sm leading-5 text-ink-soft">Please review and accept to keep using Hustlr.</p>
      </div>

      <div className="mx-auto w-full max-w-lg">
        <p className="mb-5 text-sm leading-relaxed text-ink-soft">
          By continuing you agree to our updated documents. As an Earner you operate as an independent
          contractor and are responsible for your own taxes.
        </p>

        {docs === null ? (
          <FullPageSpinner />
        ) : (
          // Each document is its own floating card, as on mobile — a hairline-
          // divided group that ALSO carried a ring and a shadow was three
          // elevation cues on one list, and `divide-divider` only started
          // resolving to a soft rule once --color-divider was defined.
          <div className="space-y-2.5">
            {ordered.map((d) => (
              <button
                key={d.slug}
                onClick={() => setOpenDoc(d)}
                className="flex w-full cursor-pointer items-center gap-3 rounded-2xl bg-white px-4 py-4 text-left shadow-[var(--shadow-card)] transition hover:bg-primary-light/40"
              >
                <span className="min-w-0 flex-1 text-[15px] font-semibold leading-5 text-ink">{d.title}</span>
                <ChevronRight className="size-4 shrink-0 text-ink-muted" />
              </button>
            ))}
          </div>
        )}

        <Button size="lg" fullWidth className="mt-6" loading={saving} disabled={docs === null || ordered.length === 0} onClick={accept}>
          Accept &amp; continue
        </Button>
        {/* A failed docs fetch must NOT let the user pass the gate without accepting. */}
        {docs !== null && ordered.length === 0 && (
          <Button variant="outline" size="sm" fullWidth className="mt-3" onClick={loadDocs}>
            Retry loading documents
          </Button>
        )}
        {error && <p role="alert" className="mt-3 text-center text-sm font-medium text-urgent">{error}</p>}
        <Button variant="ghost" size="sm" fullWidth className="mt-4 text-ink-muted" onClick={() => signOut()}>
          Sign out
        </Button>
      </div>

      {/* Legal copy is read, not scanned — 15px at a generous leading rather than
          the 14px used for UI text. */}
      <Modal open={!!openDoc} onClose={() => setOpenDoc(null)} title={openDoc?.title} size="lg">
        <p className="whitespace-pre-wrap text-[15px] leading-7 text-ink-soft">{openDoc?.body}</p>
      </Modal>
      </div>
    </BrandShell>
  );
}
