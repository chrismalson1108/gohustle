"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Trash2 } from "lucide-react";
import { CLASS_STANDINGS, DEGREE_TYPES } from "@gohustlr/shared";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/lib/auth";
import { useUser } from "@/lib/user";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import Button from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import { Input, Textarea, Label } from "@/components/ui/Field";
import { FullPageSpinner } from "@/components/ui/Spinner";
import { classNames } from "@/lib/format";

const SKILL_OPTIONS = ["Lawn Care","Moving Help","Cleaning","Tutoring","Tech Help","Delivery","Pet Care","Handyman","Photography","Writing","Design","Cooking","Driving","Assembly","Painting","Music","Fitness","Childcare","Errands","Other"];
const RADIUS_OPTIONS = [5, 10, 15, 25, 50];
const ROLES = [
  { id: "earner", label: "Earn" },
  { id: "poster", label: "Post jobs" },
  { id: "both", label: "Both" },
] as const;

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={classNames(
        "rounded-full border px-3.5 py-2 text-[13px] font-bold transition",
        active ? "border-primary bg-primary text-white" : "border-line bg-white text-ink-soft hover:border-primary",
      )}
    >
      {children}
    </button>
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const { user, signOut } = useAuth();
  const { setRole, refreshProfile, showToast } = useUser();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [usernameError, setUsernameError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [f, setF] = useState({
    name: "", username: "", bio: "", city: "", role: "earner" as "earner" | "poster" | "both",
    skills: [] as string[], radiusMiles: 25, skillRates: {} as Record<string, string>,
    school: "", major: "", degreeType: "", classStanding: "", gradYear: "",
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data } = await supabase
        .from("profiles")
        .select("name, username, bio, city, role, skills, radius_miles, skill_rates, school, major, degree_type, class_standing, grad_year")
        .eq("id", user.id)
        .single();
      if (data) {
        setF({
          name: data.name || "", username: data.username || "", bio: data.bio || "", city: data.city || "",
          role: data.role || "earner", skills: data.skills || [], radiusMiles: data.radius_miles || 25,
          skillRates: data.skill_rates ? Object.fromEntries(Object.entries(data.skill_rates).map(([k, v]) => [k, String(v)])) : {},
          school: data.school || "", major: data.major || "", degreeType: data.degree_type || "",
          classStanding: data.class_standing || "", gradYear: data.grad_year ? String(data.grad_year) : "",
        });
      }
      setLoading(false);
    })();
  }, [user]);

  const toggleSkill = (s: string) => set("skills", f.skills.includes(s) ? f.skills.filter((x) => x !== s) : [...f.skills, s]);

  const checkUsername = async () => {
    const u = f.username.trim().toLowerCase();
    if (!u) return true;
    if (!/^[a-z0-9_]{3,30}$/.test(u)) {
      setUsernameError("3–30 chars, lowercase letters/numbers/underscores only");
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

  const save = async () => {
    if (!user) return;
    if (!(await checkUsername())) return;
    setSaving(true);
    const { error } = await supabase
      .from("profiles")
      .update({
        name: f.name,
        avatar_initial: f.name?.trim().charAt(0).toUpperCase() || "H",
        username: f.username.trim().toLowerCase() || null,
        bio: f.bio || null,
        city: f.city || null,
        role: f.role,
        skills: f.skills,
        radius_miles: f.radiusMiles,
        skill_rates: f.skills.reduce<Record<string, number>>((acc, s) => {
          const r = parseInt(f.skillRates?.[s], 10);
          if (r > 0) acc[s] = r;
          return acc;
        }, {}),
        school: f.school || null,
        major: f.major || null,
        degree_type: f.degreeType || null,
        class_standing: f.classStanding || null,
        grad_year: f.gradYear ? parseInt(f.gradYear, 10) || null : null,
      })
      .eq("id", user.id);
    setSaving(false);
    if (error) {
      showToast({ icon: "❌", title: "Save failed", message: error.message || "Please try again." });
      return;
    }
    setRole(f.role);
    await refreshProfile();
    showToast({ icon: "✅", title: "Profile updated!", message: "Your settings have been saved." });
    router.push("/profile");
  };

  const deleteAccount = async () => {
    setDeleting(true);
    const { error } = await supabase.functions.invoke("delete-account");
    if (error) {
      setDeleting(false);
      setConfirmDelete(false);
      showToast({ icon: "❌", title: "Could not delete", message: "Please try again, or email support." });
      return;
    }
    // Account is gone — clear the now-invalid session and return to sign-in.
    await signOut();
    router.replace("/login");
  };

  if (loading) return <FullPageSpinner />;
  const showEarnerFields = f.role === "earner" || f.role === "both";

  return (
    <div>
      <PageHeader title="Profile settings" subtitle="Your info, role, location, skills & college" variant="gold" />
      <PageContainer>
        <button onClick={() => router.push("/profile")} className="mb-4 flex items-center gap-1 text-sm font-bold text-primary">
          <ArrowLeft className="size-4" /> Back
        </button>

        <div className="space-y-5">
          <div>
            <Label>Display name</Label>
            <Input value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Your name" />
          </div>
          <div>
            <Label>Username</Label>
            <Input value={f.username} onChange={(e) => { set("username", e.target.value); setUsernameError(""); }} placeholder="e.g. chris_hustler" maxLength={30} />
            {usernameError ? <p className="mt-1 text-sm font-medium text-urgent">{usernameError}</p> : <p className="mt-1 text-xs text-ink-muted">@{f.username || "username"}</p>}
          </div>
          <div>
            <Label>Bio</Label>
            <Textarea value={f.bio} onChange={(e) => set("bio", e.target.value)} maxLength={280} placeholder="A short bio about yourself…" />
          </div>
          <div>
            <Label>I&apos;m here to…</Label>
            <div className="flex gap-2">
              {ROLES.map((r) => (
                <Chip key={r.id} active={f.role === r.id} onClick={() => set("role", r.id)}>{r.label}</Chip>
              ))}
            </div>
          </div>
          <div>
            <Label>Location</Label>
            <Input value={f.city} onChange={(e) => set("city", e.target.value)} placeholder="Your city or 'Remote'" />
          </div>

          {showEarnerFields && (
            <>
              <div>
                <Label>Travel radius</Label>
                <div className="flex flex-wrap gap-2">
                  {RADIUS_OPTIONS.map((r) => (
                    <Chip key={r} active={f.radiusMiles === r} onClick={() => set("radiusMiles", r)}>{r} mi</Chip>
                  ))}
                </div>
              </div>
              <div>
                <Label>My skills</Label>
                <div className="flex flex-wrap gap-2">
                  {SKILL_OPTIONS.map((s) => (
                    <Chip key={s} active={f.skills.includes(s)} onClick={() => toggleSkill(s)}>{s}</Chip>
                  ))}
                </div>
              </div>
              {f.skills.length > 0 && (
                <div>
                  <Label>Hourly rates (optional)</Label>
                  <div className="space-y-2">
                    {f.skills.map((s) => (
                      <div key={s} className="flex items-center justify-between gap-3">
                        <span className="text-sm font-semibold text-ink">{s}</span>
                        <div className="flex w-28 items-center gap-1 rounded-xl border border-line bg-white px-3 py-1.5">
                          <span className="text-ink-soft">$</span>
                          <input
                            value={f.skillRates?.[s] || ""}
                            onChange={(e) => setF((p) => ({ ...p, skillRates: { ...p.skillRates, [s]: e.target.value.replace(/[^0-9]/g, "") } }))}
                            inputMode="numeric"
                            placeholder="—"
                            className="w-full bg-transparent text-sm font-bold outline-none"
                          />
                          <span className="text-xs text-ink-muted">/hr</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {/* College */}
          <div className="rounded-2xl border border-line bg-canvas p-4">
            <Label>College (optional)</Label>
            <Input value={f.school} onChange={(e) => set("school", e.target.value)} placeholder="e.g. University of Texas at Austin" />
            <p className="mt-1.5 text-xs text-ink-muted">
              Verify your .edu email on the{" "}
              <a href="/verify-student" className="font-bold text-primary">Verify Student</a> page to earn a badge.
            </p>
            {f.school && (
              <div className="mt-4 space-y-4">
                <div>
                  <Label>Major</Label>
                  <Input value={f.major} onChange={(e) => set("major", e.target.value)} placeholder="e.g. Computer Science" />
                </div>
                <div>
                  <Label>Class standing</Label>
                  <div className="flex flex-wrap gap-2">
                    {CLASS_STANDINGS.map((s) => (
                      <Chip key={s} active={f.classStanding === s} onClick={() => set("classStanding", f.classStanding === s ? "" : s)}>{s}</Chip>
                    ))}
                  </div>
                </div>
                <div>
                  <Label>Degree</Label>
                  <div className="flex flex-wrap gap-2">
                    {DEGREE_TYPES.map((d) => (
                      <Chip key={d} active={f.degreeType === d} onClick={() => set("degreeType", f.degreeType === d ? "" : d)}>{d}</Chip>
                    ))}
                  </div>
                </div>
                <div>
                  <Label>Graduation year</Label>
                  <Input value={f.gradYear} onChange={(e) => set("gradYear", e.target.value.replace(/[^0-9]/g, "").slice(0, 4))} inputMode="numeric" maxLength={4} placeholder="e.g. 2027" />
                </div>
              </div>
            )}
          </div>

          <Button fullWidth size="lg" loading={saving} onClick={save}>Save changes</Button>

          {/* Danger zone */}
          <div className="mt-8 rounded-2xl border border-urgent/30 bg-urgent/5 p-4">
            <p className="text-xs font-extrabold uppercase tracking-wide text-urgent">Danger zone</p>
            <p className="mt-1 text-sm text-ink-soft">
              Permanently delete your account, profile, gigs, bookings, messages, reviews, and photos. This can&apos;t be undone.
            </p>
            <button
              onClick={() => setConfirmDelete(true)}
              className="mt-3 inline-flex items-center gap-2 rounded-xl border border-urgent bg-white px-4 py-2.5 text-sm font-bold text-urgent hover:bg-urgent/5"
            >
              <Trash2 className="size-4" /> Delete account
            </button>
          </div>
        </div>
      </PageContainer>

      <Modal
        open={confirmDelete}
        onClose={() => !deleting && setConfirmDelete(false)}
        title="Delete your account?"
        size="sm"
        footer={
          <div className="flex gap-2">
            <Button variant="outline" fullWidth onClick={() => setConfirmDelete(false)} disabled={deleting}>Cancel</Button>
            <Button fullWidth loading={deleting} onClick={deleteAccount} className="bg-urgent hover:bg-urgent">Delete forever</Button>
          </div>
        }
      >
        <p className="text-sm text-ink-soft">
          This permanently deletes your account and all your data — your profile, gigs, bookings, messages, reviews, and uploaded
          photos. This action <span className="font-bold text-ink">cannot be undone</span>.
        </p>
      </Modal>
    </div>
  );
}
