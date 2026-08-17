"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, KeyRound, ShieldCheck, ShieldOff } from "lucide-react";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import Button from "@/components/ui/Button";
import { FullPageSpinner } from "@/components/ui/Spinner";
import { useUser } from "@/lib/user";
import {
  fetchMfaStatus, startEnrollment, confirmEnrollment, disableMfa,
  generateRecoveryCodes, confirmRecoveryCodes,
  type Enrollment, type MfaStatus,
} from "@/lib/mfa";

// ─────────────────────────────────────────────────────────────────────────────
// Two-factor, on the web — the counterpart to src/screens/SecurityScreen.js.
//
// The web could FORCE you through two-factor and could not help you manage it. The
// challenge screen at /mfa has gated every web sign-in since it was written; there was
// no page on gohustlr.com to turn 2FA on, off, or mint recovery codes, and the only
// surface that could was a current build of the mobile app.
//
// On 2026-08-17 that turned out to matter: an admin needed recovery codes, the
// simulator's dev client was a stale SDK 54 binary, and "just generate them" had no
// answer at all from a laptop. Anyone without an up-to-date app was in the same spot,
// including — by construction — anyone locked out of the device the app is on.
//
// ── THE QR IS PRIMARY HERE, WHICH IS THE REVERSE OF MOBILE ──────────────────
// A phone has one screen and cannot photograph itself, so the app leads with the
// otpauth:// deep link. On a laptop the second screen is the entire point: the QR is
// what works, and the setup key is the fallback for a password manager that would
// rather be pasted into.
//
// ── RECOVERY CODES ARE MINTED AT ENROLMENT, NOT OFFERED LATER ───────────────
// Same rule as the app, for the same reason: 2FA with no way back in turns a lost phone
// into a lost account, and "I'll do it later" is precisely how that happens. Generate,
// SHOW, and only then retire the previous set — the old codes stay valid until
// confirmRecoveryCodes lands, so a closed tab leaves someone with codes that work
// rather than none at all.
// ─────────────────────────────────────────────────────────────────────────────

type Step = "idle" | "setup" | "codes" | "disable";

function fmt(ts: string | null): string {
  if (!ts) return "an unknown time";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "an unknown time";
  }
}

export default function SecurityPage() {
  const { showToast } = useUser();

  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<Step>("idle");
  const [enroll, setEnroll] = useState<Enrollment | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await fetchMfaStatus());
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial async data load; setState runs after awaits, mirrors sibling pages
    load();
  }, [load]);

  const begin = async () => {
    setErr(null);
    setBusy(true);
    try {
      setEnroll(await startEnrollment());
      setStep("setup");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const showFreshCodes = async () => {
    const fresh = await generateRecoveryCodes();
    setCodes(fresh);
    setCopied(false);
    setStep("codes");
    await confirmRecoveryCodes();
  };

  const verify = async () => {
    if (!enroll) return;
    setErr(null);
    setBusy(true);
    // Tracked separately because the two halves fail differently, and the SECOND one
    // failing does not undo the first.
    let factorOn = false;
    try {
      await confirmEnrollment(enroll.factorId, code);
      factorOn = true;
      await showFreshCodes();
      setCode("");
    } catch (e) {
      // If the factor verified and only the CODES failed, two-factor is genuinely ON.
      // Reporting the generic error here would tell someone enrolment had failed while
      // the card reads "On" — so they walk away believing they have no 2FA and no
      // recovery codes, when in fact they have 2FA and no recovery codes. That is the
      // exact state that turns a lost phone into a lost account.
      setErr(
        factorOn
          ? "Two-factor is now ON, but we couldn't create your recovery codes. Use “New recovery codes” below before you lose access to this device."
          : e instanceof Error ? e.message : String(e),
      );
    } finally {
      // ALWAYS reload, in the finally. Once the factor is verified the card must never
      // still claim "Off", whatever happened afterwards.
      await load();
      setBusy(false);
    }
  };

  const regenerate = async () => {
    setErr(null);
    setBusy(true);
    try {
      await showFreshCodes();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      await load();
      setBusy(false);
    }
  };

  const turnOff = async () => {
    if (!status?.factors[0]) return;
    setErr(null);
    setBusy(true);
    try {
      await disableMfa(status.factors[0].id, code);
      setStep("idle");
      setCode("");
      showToast({ icon: "🔓", title: "Two-factor is off", message: "Your account is password-only again." });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const copyCodes = async () => {
    if (!codes) return;
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
    } catch {
      // Clipboard is permission-gated and blocked outright in some browsers. The codes
      // are on screen and selectable either way, so say what to do instead of failing.
      showToast({ icon: "📋", title: "Couldn't copy", message: "Select the codes and copy them manually." });
    }
  };

  if (loading) return <FullPageSpinner />;

  const on = Boolean(status?.enabled);
  const remaining = status?.recovery.remaining ?? 0;

  return (
    <>
      <PageHeader title="Two-factor authentication" back="/settings" />
      <PageContainer>
        {/* ── Status ─────────────────────────────────────────────────────── */}
        <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-line">
          <div className="flex items-start gap-3">
            {on ? (
              <ShieldCheck className="mt-0.5 size-6 shrink-0 text-success" />
            ) : (
              <ShieldOff className="mt-0.5 size-6 shrink-0 text-ink-soft" />
            )}
            <div className="min-w-0 flex-1">
              <p className="font-extrabold text-ink">
                Two-factor is {on ? "on" : "off"}
              </p>
              <p className="mt-1 text-sm leading-relaxed text-ink-soft">
                {on
                  ? "Signing in needs a code from your authenticator as well as your password."
                  : "Your account is protected by a password alone. Turning this on means a stolen password isn't enough to reach your earnings or your payout account."}
              </p>
              {on && status?.factors.map((f) => (
                <p key={f.id} className="mt-2 text-xs text-ink-soft">
                  ↳ {f.name === "GoHustlr Admin" ? "set up on the admin console" : "set up in the app or here"}, {fmt(f.createdAt)}
                </p>
              ))}
            </div>
          </div>

          {on && (
            <div className="mt-4 border-t border-line pt-4">
              <div className="flex items-center gap-2">
                <KeyRound className="size-4 shrink-0 text-ink-soft" />
                <p className="text-sm font-bold text-ink">
                  {remaining} recovery code{remaining === 1 ? "" : "s"} left
                </p>
              </div>
              {remaining === 0 && (
                <p className="mt-1.5 text-sm leading-relaxed text-urgent">
                  You have no recovery codes. If you lose your authenticator you will not be
                  able to get back in, and there is no identity check support can run that is
                  stronger than the factor you just lost.
                </p>
              )}
              {remaining > 0 && status?.recovery.generatedAt && (
                <p className="mt-1 text-xs text-ink-soft">Created {fmt(status.recovery.generatedAt)}</p>
              )}
            </div>
          )}
        </div>

        {err && <p className="mt-4 text-sm font-semibold text-urgent">{err}</p>}

        {/* ── Setup ──────────────────────────────────────────────────────── */}
        {step === "setup" && enroll && (
          <div className="mt-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-line">
            <p className="font-extrabold text-ink">Scan this with your authenticator</p>
            <p className="mt-1 text-sm leading-relaxed text-ink-soft">
              1Password, Google Authenticator, Authy — any of them. Then enter the 6-digit
              code it shows.
            </p>
            {enroll.qr && (
              /* eslint-disable-next-line @next/next/no-img-element -- inline SVG/data URI from Supabase, not a remote asset */
              <img
                src={enroll.qr.startsWith("data:") ? enroll.qr : `data:image/svg+xml;utf8,${encodeURIComponent(enroll.qr)}`}
                alt="Two-factor setup QR code"
                className="mx-auto my-4 size-44"
              />
            )}
            {enroll.secret && (
              <p className="mb-4 break-all text-center text-xs text-ink-soft">
                Or paste this key: <code className="font-mono">{enroll.secret}</code>
              </p>
            )}
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000000"
              maxLength={6}
              className="w-full rounded-xl bg-canvas py-3 text-center text-xl tracking-[0.4em] text-ink outline-none ring-1 ring-line focus:ring-2 focus:ring-primary"
            />
            <Button className="mt-4" fullWidth loading={busy} disabled={code.length !== 6} onClick={verify}>
              Turn on two-factor
            </Button>
            <Button className="mt-2" variant="ghost" fullWidth onClick={() => { setStep("idle"); setCode(""); setErr(null); }}>
              Cancel
            </Button>
          </div>
        )}

        {/* ── Recovery codes, shown once ─────────────────────────────────── */}
        {step === "codes" && codes && (
          <div className="mt-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-line">
            <p className="font-extrabold text-ink">Save your recovery codes</p>
            <p className="mt-1 text-sm leading-relaxed text-ink-soft">
              Each one works once and gets you back in if you lose your authenticator.
              They are shown here and nowhere else. Keep them somewhere that is not the
              same place as your password.
            </p>
            <div className="my-4 grid grid-cols-2 gap-2 rounded-xl bg-canvas p-4 font-mono text-sm text-ink">
              {codes.map((c) => (
                <span key={c} className="select-all">{c}</span>
              ))}
            </div>
            <Button variant="secondary" fullWidth onClick={copyCodes}>
              {copied ? <><Check className="size-4" /> Copied</> : <><Copy className="size-4" /> Copy all</>}
            </Button>
            <Button className="mt-2" fullWidth onClick={() => { setStep("idle"); setCodes(null); }}>
              I&apos;ve saved them
            </Button>
          </div>
        )}

        {/* ── Turn off ───────────────────────────────────────────────────── */}
        {step === "disable" && (
          <div className="mt-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-line">
            <p className="font-extrabold text-ink">Turn off two-factor</p>
            <p className="mt-1 text-sm leading-relaxed text-ink-soft">
              Enter a current code to confirm it&apos;s you. A stolen session on its own
              must not be able to switch this off.
            </p>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000000"
              maxLength={6}
              className="mt-4 w-full rounded-xl bg-canvas py-3 text-center text-xl tracking-[0.4em] text-ink outline-none ring-1 ring-line focus:ring-2 focus:ring-primary"
            />
            <Button className="mt-4" variant="danger" fullWidth loading={busy} disabled={code.length !== 6} onClick={turnOff}>
              Turn it off
            </Button>
            <Button className="mt-2" variant="ghost" fullWidth onClick={() => { setStep("idle"); setCode(""); setErr(null); }}>
              Keep it on
            </Button>
          </div>
        )}

        {/* ── Actions ────────────────────────────────────────────────────── */}
        {step === "idle" && (
          <div className="mt-4 space-y-2">
            {!on && (
              <Button fullWidth loading={busy} onClick={begin}>
                Turn on two-factor
              </Button>
            )}
            {on && (
              <>
                <Button variant="secondary" fullWidth loading={busy} onClick={regenerate}>
                  {remaining > 0 ? "New recovery codes" : "Create recovery codes"}
                </Button>
                <Button variant="ghost" fullWidth onClick={() => { setStep("disable"); setErr(null); }}>
                  Turn off two-factor
                </Button>
                {remaining > 0 && (
                  <p className="pt-1 text-center text-xs text-ink-soft">
                    Making new codes retires the old set.
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </PageContainer>
    </>
  );
}
