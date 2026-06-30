"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { GraduationCap, ArrowLeft, CheckCircle2 } from "lucide-react";
import { isEduEmail } from "@gohustlr/shared";
import { useUser } from "@/lib/user";
import { startStudentVerification, confirmStudentVerification } from "@/lib/student";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import Button, { buttonClasses } from "@/components/ui/Button";
import { Input, Label, FieldError } from "@/components/ui/Field";

export default function VerifyStudentPage() {
  const router = useRouter();
  const { studentVerified, studentStatus, refreshProfile, showToast } = useUser();
  const [step, setStep] = useState<"email" | "code" | "done">(studentVerified ? "done" : "email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendCode = async () => {
    setError(null);
    if (!isEduEmail(email)) return setError("Enter a valid school (.edu) email.");
    setBusy(true);
    try {
      await startStudentVerification(email.trim().toLowerCase());
      setStep("code");
    } catch (e) {
      const err = e as Error & { code?: string };
      setError(
        err.code === "email_not_configured"
          ? "Student verification email isn't set up yet (admin: add RESEND_API_KEY)."
          : err.message || "Could not send the code.",
      );
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setError(null);
    if (!code.trim()) return setError("Enter the 6-digit code.");
    setBusy(true);
    try {
      await confirmStudentVerification(email.trim().toLowerCase(), code.trim());
      await refreshProfile();
      showToast({ icon: "🎓", title: "Verified Student!", message: "Your school email is confirmed." });
      setStep("done");
    } catch (e) {
      setError((e as Error).message || "That code didn't match.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader title="Verified Student" subtitle="Confirm your school email" />
      <PageContainer className="max-w-md">
        <button onClick={() => router.push("/profile")} className={buttonClasses("ghost", "sm", "mb-4 -ml-3")}>
          <ArrowLeft className="size-4" /> Back to profile
        </button>

        <div className="rounded-3xl bg-white p-6 shadow-[var(--shadow-card)] ring-1 ring-line/70">
          <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-primary-light text-primary">
            <GraduationCap className="size-6" />
          </div>

          {step === "done" || studentVerified ? (
            <div>
              <div className="flex items-center gap-2">
                <CheckCircle2 className="size-6 text-success" />
                <h2 className="text-xl font-black text-ink">
                  {studentStatus === "alumni" ? "Verified Alumni" : "You're a Verified Student"}
                </h2>
              </div>
              <p className="mt-2 text-sm text-ink-soft">
                Your Verified Student badge is live across GoHustlr — on your profile and every gig you post.
              </p>
              <Button className="mt-5" fullWidth onClick={() => router.push("/profile")}>
                Done
              </Button>
            </div>
          ) : step === "email" ? (
            <div>
              <h2 className="text-xl font-black text-ink">Verify your student status</h2>
              <p className="mt-1 text-sm text-ink-soft">
                We&apos;ll email a code to your school address. Adds a Verified Student badge that builds trust
                with posters and earners.
              </p>
              <div className="mt-5">
                <Label>School email</Label>
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); setError(null); }}
                  placeholder="you@school.edu"
                  autoComplete="email"
                />
                <FieldError>{error}</FieldError>
              </div>
              <Button className="mt-4" fullWidth size="lg" loading={busy} onClick={sendCode}>
                Send code
              </Button>
            </div>
          ) : (
            <div>
              <h2 className="text-xl font-black text-ink">Enter your code</h2>
              <p className="mt-1 text-sm text-ink-soft">We sent a 6-digit code to {email}. It expires in 15 minutes.</p>
              <div className="mt-5">
                <Label>Verification code</Label>
                <Input
                  inputMode="numeric"
                  value={code}
                  onChange={(e) => { setCode(e.target.value.replace(/\D/g, "").slice(0, 6)); setError(null); }}
                  placeholder="123456"
                  className="text-center text-2xl font-black tracking-[0.4em]"
                  maxLength={6}
                />
                <FieldError>{error}</FieldError>
              </div>
              <Button className="mt-4" fullWidth size="lg" loading={busy} onClick={confirm}>
                Verify
              </Button>
              <Button variant="ghost" size="sm" fullWidth className="mt-4" onClick={() => setStep("email")}>
                Use a different email
              </Button>
            </div>
          )}
        </div>
      </PageContainer>
    </div>
  );
}
