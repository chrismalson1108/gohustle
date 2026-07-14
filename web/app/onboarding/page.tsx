"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Sparkles, Tag, Target, MapPin, Dumbbell, Rocket, ArrowRight, Check, GraduationCap, Briefcase, Zap } from "lucide-react";
import { parseDob, isAdult, MIN_AGE } from "@gohustlr/shared";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/lib/auth";
import { fetchCurrentDocs, recordAcceptances } from "@/lib/legal";
import { getReferralCode, recordReferral } from "@/lib/referrals";
import Button from "@/components/ui/Button";
import { Input, Textarea, Select } from "@/components/ui/Field";
import { FullPageSpinner } from "@/components/ui/Spinner";
import LocationPicker from "@/components/LocationPicker";
import { classNames } from "@/lib/format";

const ROLES = [
  { id: "earner", label: "Earner", desc: "I want to find gigs and earn money", Icon: GraduationCap },
  { id: "poster", label: "Poster", desc: "I want to post jobs and hire people", Icon: Briefcase },
  { id: "both", label: "Both", desc: "I want to earn AND post jobs", Icon: Zap },
];
const SKILL_OPTIONS = ["Lawn Care","Moving Help","Cleaning","Tutoring","Tech Help","Delivery","Pet Care","Handyman","Photography","Writing","Design","Cooking","Driving","Assembly","Painting","Music","Fitness","Childcare","Errands","Other"];
const RADIUS_OPTIONS = [5, 10, 15, 25, 50];
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

export default function OnboardingPage() {
  const router = useRouter();
  const { user, session, loading: authLoading, onboardingResolved, onboardingDone, markOnboardingDone } =
    useAuth();

  const [step, setStep] = useState(0);
  const [username, setUsername] = useState("");
  const [usernameError, setUsernameError] = useState("");
  // DOB as Month/Day/Year dropdown parts (mirror of mobile DobPicker) — no more
  // free-form MM/DD/YYYY typing. Composed into a parseDob-compatible string below.
  const [dobM, setDobM] = useState("");
  const [dobD, setDobD] = useState("");
  const [dobY, setDobY] = useState("");
  const [dobError, setDobError] = useState("");
  const dob = dobM && dobD && dobY ? `${dobM}/${dobD}/${dobY}` : "";
  const dobDayCount = new Date(Number(dobY) || 2000, Number(dobM) || 12, 0).getDate();
  const dobYears = Array.from({ length: new Date().getFullYear() - 1920 + 1 }, (_, i) => new Date().getFullYear() - i);
  const [role, setRole] = useState("");
  const [city, setCity] = useState("");
  const [skills, setSkills] = useState<string[]>([]);
  const [radius, setRadius] = useState(25);
  const [bio, setBio] = useState("");
  const [saving, setSaving] = useState(false);
  const [finishError, setFinishError] = useState("");
  const [agreedTerms, setAgreedTerms] = useState(false);

  // Email sign-ups accepted the legal terms via the signup checkbox; OAuth users
  // (Google) never saw one, so capture explicit consent here before finish()
  // records their acceptance. Fail-safe: unknown provider → show the checkbox.
  const needsConsent =
    ((user?.app_metadata?.provider as string | undefined) ?? "") !== "email";

  useEffect(() => {
    // Don't route until we actually know the session + onboarding state — otherwise
    // a not-onboarded user (onboardingDone defaults to true until loaded) gets
    // bounced to /browse and pinballs back here.
    if (authLoading || (session && !onboardingResolved)) return;
    if (session === null) router.replace("/login");
    else if (onboardingDone) router.replace("/browse");
  }, [authLoading, session, onboardingResolved, onboardingDone, router]);

  const next = () => setStep((s) => s + 1);
  const toggleSkill = (s: string) =>
    setSkills((p) => (p.includes(s) ? p.filter((x) => x !== s) : [...p, s]));

  const checkUsername = async () => {
    const u = username.trim().toLowerCase();
    if (!u || !/^[a-z0-9_]{3,30}$/.test(u)) {
      setUsernameError("3–30 characters, letters, numbers, underscores only");
      return false;
    }
    const { data } = await supabase.from("profiles").select("id").eq("username", u).neq("id", user!.id).maybeSingle();
    if (data) {
      setUsernameError("That username is already taken");
      return false;
    }
    setUsernameError("");
    return true;
  };

  // Age floor (H7): require a valid, 18+ DOB. Server also blocks a known minor at
  // action time (guard_min_age); this is the UX gate.
  const checkDob = () => {
    const iso = parseDob(dob);
    if (!iso) { setDobError("Select your date of birth."); return false; }
    if (!isAdult(iso)) { setDobError(`You must be ${MIN_AGE} or older to use GoHustlr.`); return false; }
    setDobError("");
    return true;
  };

  const finish = async () => {
    if (!user) return;
    setFinishError("");
    setSaving(true);
    // Record the user's agreement to the current terms FIRST, and BLOCK on failure —
    // the account must not be marked onboarded until acceptance is durably stored
    // (it is the legal audit source of truth). recordAcceptances is idempotent, so
    // retrying after a later error (e.g. a username collision below) is safe.
    try {
      await recordAcceptances(user.id, await fetchCurrentDocs());
    } catch {
      setSaving(false);
      setFinishError("Couldn't record your agreement to the terms — check your connection and try again.");
      return;
    }
    const { error } = await supabase
      .from("profiles")
      .update({
        username: username.trim().toLowerCase(),
        date_of_birth: parseDob(dob),
        role,
        city,
        skills,
        radius_miles: radius,
        bio: bio || null,
        onboarding_done: true,
      })
      .eq("id", user.id);
    if (error) {
      // Don't mark onboarded if the DB write failed — otherwise the in-memory gate
      // says "done" but loadOnboarding reads false next login and bounces the user
      // back here in an invisible loop.
      setSaving(false);
      if ((error as { code?: string }).code === "23505") {
        // Username was claimed between the step-1 check and now.
        setUsernameError("That username was just taken — please pick another.");
        setStep(1);
      } else {
        setFinishError("Couldn't save your profile. Check your connection and try again.");
      }
      return;
    }
    try {
      await getReferralCode(user.id);
      const code = (user.user_metadata as { referral_code?: string })?.referral_code;
      if (code) await recordReferral(user.id, code);
    } catch {}
    setSaving(false);
    markOnboardingDone();
    router.replace("/browse");
  };

  const totalSteps = 6;

  // Never paint the wizard in an unresolved or already-onboarded state — hold a
  // spinner while auth resolves and during the brief window before the redirect
  // effect above navigates an onboarded/logged-out visitor away.
  if (authLoading || !session || !onboardingResolved || onboardingDone) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas">
        <FullPageSpinner label="Loading…" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-gradient-to-b from-canvas via-primary-light to-white">
      {step > 0 && step < totalSteps - 1 && (
        <div className="flex justify-center gap-1.5 py-5">
          {Array.from({ length: totalSteps - 2 }).map((_, i) => (
            <span
              key={i}
              className={classNames(
                "h-2 rounded-full transition-all",
                i === step - 1 ? "w-5 bg-primary" : i < step ? "w-2 bg-primary/50" : "w-2 bg-line",
              )}
            />
          ))}
        </div>
      )}

      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-6 pb-10 text-center">
        {step === 0 && (
          <Step icon={<Sparkles className="size-14 text-primary" />} title="Welcome to GoHustlr!" sub="The gig marketplace for college students. Let's set up your profile in 60 seconds.">
            <Button size="lg" fullWidth onClick={next}>Let&apos;s go <ArrowRight className="size-5" /></Button>
          </Step>
        )}

        {step === 1 && (
          <Step icon={<Tag className="size-14 text-primary" />} title="Pick a username" sub="This is how others will see you on GoHustlr.">
            <Input
              value={username}
              onChange={(e) => { setUsername(e.target.value); setUsernameError(""); }}
              placeholder="e.g. chris_hustler"
              maxLength={30}
              autoCapitalize="none"
              aria-label="Username"
            />
            {usernameError && <p role="alert" className="mt-1.5 text-left text-sm font-medium text-urgent">{usernameError}</p>}
            <p className="mb-4 mt-1.5 text-left text-xs text-ink-muted">@{username.toLowerCase() || "username"}</p>
            <p className="mb-1.5 text-left text-sm font-bold text-ink-soft">Date of birth</p>
            <div className="flex gap-2">
              <Select
                value={dobM}
                onChange={(e) => {
                  const m = e.target.value;
                  setDobM(m);
                  setDobError("");
                  // Changing month/year can invalidate the chosen day (e.g. Feb 30) — clear it.
                  if (dobD && Number(dobD) > new Date(Number(dobY) || 2000, Number(m) || 12, 0).getDate()) setDobD("");
                }}
                aria-label="Month"
                className="flex-[1.6]"
              >
                <option value="">Month</option>
                {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
              </Select>
              <Select
                value={dobD}
                onChange={(e) => { setDobD(e.target.value); setDobError(""); }}
                aria-label="Day"
                className="flex-1"
              >
                <option value="">Day</option>
                {/* Day list adapts to the chosen month/year — no Feb 30. */}
                {Array.from({ length: dobDayCount }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
              </Select>
              <Select
                value={dobY}
                onChange={(e) => {
                  const y = e.target.value;
                  setDobY(y);
                  setDobError("");
                  if (dobD && Number(dobD) > new Date(Number(y) || 2000, Number(dobM) || 12, 0).getDate()) setDobD("");
                }}
                aria-label="Year"
                className="flex-[1.2]"
              >
                <option value="">Year</option>
                {dobYears.map((y) => <option key={y} value={y}>{y}</option>)}
              </Select>
            </div>
            {dobError && <p role="alert" className="mt-1.5 text-left text-sm font-medium text-urgent">{dobError}</p>}
            <p className="mb-4 mt-1.5 text-left text-xs text-ink-muted">You must be {MIN_AGE}+ to use GoHustlr.</p>
            <Button size="lg" fullWidth disabled={!username || !dob} onClick={async () => { const dobOk = checkDob(); if ((await checkUsername()) && dobOk) next(); }}>
              Continue <ArrowRight className="size-5" />
            </Button>
          </Step>
        )}

        {step === 2 && (
          <Step icon={<Target className="size-14 text-primary" />} title="What are you here for?" sub="You can change this later in your Profile.">
            <div className="space-y-3">
              {ROLES.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setRole(r.id)}
                  className={classNames(
                    "flex w-full items-center gap-3 rounded-2xl border-2 p-4 text-left transition",
                    role === r.id ? "border-primary bg-primary-light" : "border-line bg-white",
                  )}
                >
                  <r.Icon className={classNames("size-6 shrink-0", role === r.id ? "text-primary" : "text-ink-soft")} />
                  <span className="flex-1">
                    <span className={classNames("block font-bold", role === r.id ? "text-primary" : "text-ink")}>{r.label}</span>
                    <span className="block text-sm text-ink-muted">{r.desc}</span>
                  </span>
                  {role === r.id && <Check className="size-5 text-primary" />}
                </button>
              ))}
            </div>
            <Button size="lg" fullWidth className="mt-5" disabled={!role} onClick={next}>Continue <ArrowRight className="size-5" /></Button>
          </Step>
        )}

        {step === 3 && (
          <Step icon={<MapPin className="size-14 text-primary" />} title="Where are you based?" sub="Used to surface nearby gigs for you.">
            <div className="text-left">
              <LocationPicker value={city} onChange={(label) => setCity(label)} placeholder="e.g. Austin, TX" />
            </div>
            <Button size="lg" fullWidth className="mt-5" disabled={!city} onClick={next}>Continue <ArrowRight className="size-5" /></Button>
            <button onClick={next} className="mt-4 text-sm font-semibold text-ink-muted">Skip for now</button>
          </Step>
        )}

        {step === 4 &&
          (role === "earner" || role === "both" ? (
            <Step icon={<Dumbbell className="size-14 text-primary" />} title="Your skills" sub="Earners with skills get hired faster.">
              <div className="flex flex-wrap justify-center gap-2">
                {SKILL_OPTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => toggleSkill(s)}
                    className={classNames(
                      "rounded-full border px-3.5 py-2 text-sm font-bold transition",
                      skills.includes(s) ? "border-primary bg-primary text-white" : "border-line bg-white text-ink-soft hover:bg-primary-light/40",
                    )}
                  >
                    {s}
                  </button>
                ))}
              </div>
              <p className="mt-5 text-sm text-ink-soft">How far will you travel?</p>
              <div className="mt-2 flex flex-wrap justify-center gap-2">
                {RADIUS_OPTIONS.map((r) => (
                  <button
                    key={r}
                    onClick={() => setRadius(r)}
                    className={classNames(
                      "rounded-xl border px-4 py-2.5 text-sm font-bold transition",
                      radius === r ? "border-primary bg-primary text-white" : "border-line bg-white text-ink-soft hover:bg-primary-light/40",
                    )}
                  >
                    {r} mi
                  </button>
                ))}
              </div>
              <Button size="lg" fullWidth className="mt-6" onClick={next}>Almost done <ArrowRight className="size-5" /></Button>
            </Step>
          ) : (
            <Step icon={<Dumbbell className="size-14 text-primary" />} title="Add a short bio" sub="Tell earners a bit about yourself and your gigs.">
              <Textarea value={bio} onChange={(e) => setBio(e.target.value)} maxLength={280} placeholder="College senior looking for reliable help with yard work and errands..." />
              <Button size="lg" fullWidth className="mt-5" onClick={next}>Almost done <ArrowRight className="size-5" /></Button>
            </Step>
          ))}

        {step === 5 && (
          <Step icon={<Rocket className="size-14 text-primary" />} title="You're all set!" sub={`Welcome to GoHustlr, @${username || "hustler"}. Time to start hustling!`}>
            {needsConsent && (
              <label className="mb-4 flex cursor-pointer items-start gap-2.5 text-left text-sm text-ink-soft">
                <input
                  type="checkbox"
                  checked={agreedTerms}
                  onChange={(e) => setAgreedTerms(e.target.checked)}
                  className="mt-0.5 size-4 shrink-0 accent-primary"
                />
                <span>
                  I confirm I&apos;m 18 or older and agree to the{" "}
                  <Link href="/legal/terms" target="_blank" className="font-semibold text-primary hover:underline">Terms</Link>,{" "}
                  <Link href="/legal/privacy" target="_blank" className="font-semibold text-primary hover:underline">Privacy Policy</Link>, and{" "}
                  <Link href="/legal/contractor" target="_blank" className="font-semibold text-primary hover:underline">Independent Contractor Agreement</Link>.
                </span>
              </label>
            )}
            <Button size="lg" fullWidth loading={saving} disabled={needsConsent && !agreedTerms} onClick={finish}>Enter GoHustlr</Button>
            {finishError && <p role="alert" className="mt-3 text-sm font-medium text-urgent">{finishError}</p>}
          </Step>
        )}
      </div>
    </div>
  );
}

function Step({ icon, title, sub, children }: { icon: React.ReactNode; title: string; sub: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center">
      <div className="mb-4">{icon}</div>
      <h1 className="text-2xl font-black text-ink">{title}</h1>
      <p className="mb-7 mt-2 max-w-xs text-sm text-ink-soft">{sub}</p>
      <div className="w-full">{children}</div>
    </div>
  );
}
