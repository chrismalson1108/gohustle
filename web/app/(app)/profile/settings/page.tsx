"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Trash2, Plus, X } from "lucide-react";
import { CLASS_STANDINGS, DEGREE_TYPES } from "@gohustlr/shared";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/lib/auth";
import { useUser } from "@/lib/user";
import {
  fetchCertifications,
  addCertification,
  deleteCertification,
  type Certification,
} from "@/lib/certifications";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import Button from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import { Input, Textarea, Label } from "@/components/ui/Field";
import LocationPicker from "@/components/LocationPicker";
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
  const [certs, setCerts] = useState<Certification[]>([]);
  const [certModalOpen, setCertModalOpen] = useState(false);
  const [savingCert, setSavingCert] = useState(false);
  const [cert, setCert] = useState({ title: "", issuer: "", year: "", file: null as File | null });
  const [f, setF] = useState({
    name: "", username: "", bio: "", city: "", role: "earner" as "earner" | "poster" | "both",
    skills: [] as string[], radiusMiles: 25, skillRates: {} as Record<string, string>,
    school: "", major: "", degreeType: "", classStanding: "", gradYear: "",
    showAvailability: false,
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data } = await supabase
        .from("profiles")
        .select("name, username, bio, city, role, skills, radius_miles, skill_rates, school, major, degree_type, class_standing, grad_year, show_availability")
        .eq("id", user.id)
        .single();
      if (data) {
        setF({
          name: data.name || "", username: data.username || "", bio: data.bio || "", city: data.city || "",
          role: data.role || "earner", skills: data.skills || [], radiusMiles: data.radius_miles || 25,
          skillRates: data.skill_rates ? Object.fromEntries(Object.entries(data.skill_rates).map(([k, v]) => [k, String(v)])) : {},
          school: data.school || "", major: data.major || "", degreeType: data.degree_type || "",
          classStanding: data.class_standing || "", gradYear: data.grad_year ? String(data.grad_year) : "",
          showAvailability: data.show_availability === true,
        });
      }
      try {
        setCerts(await fetchCertifications(user.id));
      } catch {
        /* non-fatal */
      }
      setLoading(false);
    })();
  }, [user]);

  const saveCert = async () => {
    if (!user) return;
    const title = cert.title.trim();
    if (!title) {
      showToast({ icon: "⚠️", title: "Title required", message: "Add the certification name." });
      return;
    }
    setSavingCert(true);
    try {
      const created = await addCertification({
        userId: user.id,
        title,
        issuer: cert.issuer.trim() || null,
        year: cert.year ? parseInt(cert.year, 10) || null : null,
        file: cert.file,
      });
      setCerts((p) => [created, ...p]);
      setCert({ title: "", issuer: "", year: "", file: null });
      setCertModalOpen(false);
      showToast({ icon: "✅", title: "Certification added!", message: "It now shows on your profile." });
    } catch (e) {
      showToast({ icon: "❌", title: "Couldn't add", message: (e as Error)?.message || "Please try again." });
    }
    setSavingCert(false);
  };

  const removeCert = async (id: string) => {
    const prev = certs;
    setCerts((p) => p.filter((c) => c.id !== id));
    try {
      await deleteCertification(id);
    } catch {
      setCerts(prev);
      showToast({ icon: "⚠️", title: "Couldn't remove", message: "Please try again." });
    }
  };

  const toggleSkill = (s: string) => set("skills", f.skills.includes(s) ? f.skills.filter((x) => x !== s) : [...f.skills, s]);

  const toggleShowAvailability = async (value: boolean) => {
    if (!user) return;
    set("showAvailability", value); // optimistic
    const { error } = await supabase.from("profiles").update({ show_availability: value }).eq("id", user.id);
    if (error) {
      set("showAvailability", !value); // revert
      showToast({ icon: "⚠️", title: "Couldn't update", message: "Please try again." });
      return;
    }
    await refreshProfile();
  };

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
        show_availability: f.showAvailability,
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
            <LocationPicker value={f.city} onChange={(label) => set("city", label)} placeholder="Your city or 'Remote'" />
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
                        <div className="flex w-28 items-center gap-1 rounded-2xl border border-line bg-white px-3 py-1.5 transition focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/15">
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
              <div className="flex items-center justify-between gap-4 rounded-2xl bg-white p-4 shadow-[var(--shadow-card)] ring-1 ring-line/70">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-ink">Show my availability on my profile</p>
                  <p className="mt-0.5 text-xs text-ink-muted">Lets signed-in clients see when you&apos;re free.</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={f.showAvailability}
                  onClick={() => toggleShowAvailability(!f.showAvailability)}
                  className={classNames(
                    "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition",
                    f.showAvailability ? "bg-primary" : "bg-line",
                  )}
                >
                  <span
                    className={classNames(
                      "inline-block size-5 transform rounded-full bg-white shadow transition",
                      f.showAvailability ? "translate-x-[22px]" : "translate-x-0.5",
                    )}
                  />
                </button>
              </div>
            </>
          )}

          {/* College */}
          <div className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)] ring-1 ring-line/70">
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

          {/* Certifications */}
          <div className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)] ring-1 ring-line/70">
            <div className="flex items-center justify-between">
              <Label className="mb-0">Certifications</Label>
              <Button variant="outline" size="sm" onClick={() => setCertModalOpen(true)}>
                <Plus className="size-4" /> Add
              </Button>
            </div>
            <p className="mt-1.5 text-xs text-ink-muted">
              Trade certs &amp; credentials (e.g. EPA 608, OSHA 10) — shown on your public profile.
            </p>
            {certs.length > 0 && (
              <div className="mt-3 space-y-2">
                {certs.map((c) => (
                  <div key={c.id} className="flex items-center gap-3 rounded-xl bg-canvas px-3 py-2.5 ring-1 ring-line/70">
                    {c.image_url && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={c.image_url} alt={c.title} className="size-10 shrink-0 rounded-lg object-cover" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold text-ink">{c.title}</p>
                      {(c.issuer || c.year) && (
                        <p className="truncate text-xs text-ink-muted">
                          {[c.issuer, c.year].filter(Boolean).join(" · ")}
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => removeCert(c.id)}
                      className="rounded-full p-1.5 text-ink-muted hover:bg-line/60 hover:text-urgent"
                      aria-label={`Remove ${c.title}`}
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <Button fullWidth size="lg" loading={saving} onClick={save}>Save changes</Button>

          {/* Danger zone */}
          <div className="mt-8 rounded-2xl border border-urgent/30 bg-urgent/5 p-4">
            <p className="text-xs font-bold uppercase tracking-wide text-urgent">Danger zone</p>
            <p className="mt-1 text-sm text-ink-soft">
              Permanently delete your account, profile, gigs, bookings, messages, reviews, and photos. This can&apos;t be undone.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3 border-urgent text-urgent hover:bg-urgent/5 hover:text-urgent"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className="size-4" /> Delete account
            </Button>
          </div>
        </div>
      </PageContainer>

      <Modal
        open={certModalOpen}
        onClose={() => !savingCert && setCertModalOpen(false)}
        title="Add certification"
        size="sm"
        footer={
          <div className="flex gap-2">
            <Button variant="outline" fullWidth onClick={() => setCertModalOpen(false)} disabled={savingCert}>Cancel</Button>
            <Button fullWidth loading={savingCert} onClick={saveCert}>Add</Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div>
            <Label>Title</Label>
            <Input
              value={cert.title}
              onChange={(e) => setCert((p) => ({ ...p, title: e.target.value }))}
              placeholder="e.g. EPA 608 Certification"
              maxLength={120}
            />
          </div>
          <div>
            <Label>Issuer</Label>
            <Input
              value={cert.issuer}
              onChange={(e) => setCert((p) => ({ ...p, issuer: e.target.value }))}
              placeholder="e.g. Trade Tech"
              maxLength={120}
            />
          </div>
          <div>
            <Label>Year</Label>
            <Input
              value={cert.year}
              onChange={(e) => setCert((p) => ({ ...p, year: e.target.value.replace(/[^0-9]/g, "").slice(0, 4) }))}
              inputMode="numeric"
              maxLength={4}
              placeholder="e.g. 2024"
            />
          </div>
          <div>
            <Label>Image (optional)</Label>
            <input
              type="file"
              accept="image/*"
              onChange={(e) => setCert((p) => ({ ...p, file: e.target.files?.[0] || null }))}
              className="block w-full text-sm text-ink-soft file:mr-3 file:rounded-xl file:border-0 file:bg-primary file:px-4 file:py-2 file:text-sm file:font-bold file:text-white hover:file:bg-primary/90"
            />
            {cert.file && <p className="mt-1.5 truncate text-xs text-ink-muted">{cert.file.name}</p>}
          </div>
        </div>
      </Modal>

      <Modal
        open={confirmDelete}
        onClose={() => !deleting && setConfirmDelete(false)}
        title="Delete your account?"
        size="sm"
        footer={
          <div className="flex gap-2">
            <Button variant="outline" fullWidth onClick={() => setConfirmDelete(false)} disabled={deleting}>Cancel</Button>
            <Button fullWidth loading={deleting} onClick={deleteAccount} variant="danger">Delete forever</Button>
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
