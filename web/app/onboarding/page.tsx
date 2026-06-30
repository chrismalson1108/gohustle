"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, Tag, Target, MapPin, Dumbbell, Rocket, ArrowRight, Check, GraduationCap, Briefcase, Zap } from "lucide-react";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/lib/auth";
import { fetchCurrentDocs, recordAcceptances } from "@/lib/legal";
import { getReferralCode, recordReferral } from "@/lib/referrals";
import Button from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Field";
import LocationPicker from "@/components/LocationPicker";
import { classNames } from "@/lib/format";

const ROLES = [
  { id: "earner", label: "Earner", desc: "I want to find gigs and earn money", Icon: GraduationCap },
  { id: "poster", label: "Poster", desc: "I want to post jobs and hire people", Icon: Briefcase },
  { id: "both", label: "Both", desc: "I want to earn AND post jobs", Icon: Zap },
];
const SKILL_OPTIONS = ["Lawn Care","Moving Help","Cleaning","Tutoring","Tech Help","Delivery","Pet Care","Handyman","Photography","Writing","Design","Cooking","Driving","Assembly","Painting","Music","Fitness","Childcare","Errands","Other"];
const RADIUS_OPTIONS = [5, 10, 15, 25, 50];

export default function OnboardingPage() {
  const router = useRouter();
  const { user, session, onboardingDone, markOnboardingDone } = useAuth();

  const [step, setStep] = useState(0);
  const [username, setUsername] = useState("");
  const [usernameError, setUsernameError] = useState("");
  const [role, setRole] = useState("");
  const [city, setCity] = useState("");
  const [skills, setSkills] = useState<string[]>([]);
  const [radius, setRadius] = useState(25);
  const [bio, setBio] = useState("");
  const [saving, setSaving] = useState(false);
  const [finishError, setFinishError] = useState("");

  useEffect(() => {
    if (session && onboardingDone) router.replace("/browse");
    if (session === null) router.replace("/login");
  }, [session, onboardingDone, router]);

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

  const finish = async () => {
    if (!user) return;
    setFinishError("");
    setSaving(true);
    const { error } = await supabase
      .from("profiles")
      .update({
        username: username.trim().toLowerCase(),
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
      await recordAcceptances(user.id, await fetchCurrentDocs());
    } catch {}
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
            />
            {usernameError && <p className="mt-1.5 text-left text-sm font-medium text-urgent">{usernameError}</p>}
            <p className="mb-4 mt-1.5 text-left text-xs text-ink-muted">@{username.toLowerCase() || "username"}</p>
            <Button size="lg" fullWidth disabled={!username} onClick={async () => { if (await checkUsername()) next(); }}>
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
            <Button size="lg" fullWidth loading={saving} onClick={finish}>Enter GoHustlr</Button>
            {finishError && <p className="mt-3 text-sm font-medium text-urgent">{finishError}</p>}
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
