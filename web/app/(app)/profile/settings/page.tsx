"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronDown, Trash2, Plus, X, Camera, Loader2, LogOut, Lock, Award,
  GraduationCap, ClipboardList, Zap, Star, Banknote, MessageCircle, Briefcase,
} from "lucide-react";
import { CLASS_STANDINGS, DEGREE_TYPES, parseDob, isAdult, MIN_AGE, findProhibited } from "@gohustlr/shared";
import { moderateText, logModerationBlock } from "@/lib/moderation";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/lib/auth";
import { useUser } from "@/lib/user";
import {
  fetchCertifications,
  addCertification,
  deleteCertification,
  type Certification,
} from "@/lib/certifications";
import { uploadToBucket } from "@/lib/uploadImage";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import Avatar from "@/components/ui/Avatar";
import Button, { buttonClasses } from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import { Input, Textarea, Label, Select } from "@/components/ui/Field";
import LocationPicker from "@/components/LocationPicker";
import { FullPageSpinner } from "@/components/ui/Spinner";
import { classNames } from "@/lib/format";

const SKILL_OPTIONS = ["Lawn Care","Moving Help","Cleaning","Tutoring","Tech Help","Delivery","Pet Care","Handyman","Photography","Writing","Design","Cooking","Driving","Assembly","Painting","Music","Fitness","Childcare","Errands","Other"];
const RADIUS_OPTIONS = [5, 10, 15, 25, 50];
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
// Icon + label, matching mobile's role chips (school / clipboard / flash).
// "Post Jobs" is title case on purpose — it is the one label mobile does not
// write in sentence case, and the two clients should read identically.
const ROLES = [
  { id: "earner", label: "Earn", Icon: GraduationCap },
  { id: "poster", label: "Post Jobs", Icon: ClipboardList },
  { id: "both", label: "Both", Icon: Zap },
] as const;

// Selectable pill. One size, one radius, one active treatment — the four
// near-identical local Chips across the app each drifted to a different scale.
// min-h-11 keeps it above the 44px touch minimum; the label never wraps.
// `icon` sits OUTSIDE the truncating span so a long label clips its own text
// instead of eating the glyph.
function Chip({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={classNames(
        "inline-flex min-h-11 max-w-full shrink-0 items-center justify-center gap-1.5 rounded-full border px-4 text-[13px] font-semibold transition",
        active ? "border-primary bg-primary text-white" : "border-line bg-white text-ink-soft hover:border-primary",
      )}
    >
      {icon}
      <span className="truncate">{children}</span>
    </button>
  );
}

// Mirrors mobile's formatDob: parse at noon UTC so the stored calendar date
// never shifts a day under a negative-offset timezone.
function formatDob(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

// The shared `Select` sets `appearance-none pr-10`, which suppresses the native
// dropdown arrow and then reserves 40px for a chevron nobody draws — every select
// on this page read as a plain text box. Until the affordance moves into
// components/ui/Field.tsx itself, this wrapper supplies it.
function SelectWrap({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-w-0">
      {children}
      <ChevronDown className="pointer-events-none absolute right-3.5 top-1/2 size-4 -translate-y-1/2 text-ink-muted" />
    </div>
  );
}

// Chunks the long settings form into labeled sections. Mobile separates them
// with whitespace alone (32 above / 16 below, 17px ink) — the rule that used to
// sit above each heading is a line the rest of the app never draws.
function SectionHeader({ children, first }: { children: React.ReactNode; first?: boolean }) {
  return (
    <h2 className={classNames("text-[17px] font-bold tracking-[-0.01em] text-ink", first ? "mb-4" : "mb-4 mt-8")}>
      {children}
    </h2>
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const { user, signOut } = useAuth();
  const { setRole, refreshProfile, showToast, name, avatarUrl, avatarInitial } = useUser();

  const [loading, setLoading] = useState(true);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  // If the profile never loaded we must NOT let save run: the update writes every
  // field unconditionally, so saving from a blank form overwrites the stored profile.
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [usernameError, setUsernameError] = useState("");
  // 0 closed, 1 consequences, 2 type-to-confirm. Deleting is irreversible and
  // takes earnings history and reviews with it, so it is a deliberate gauntlet
  // rather than one destructive button in a dialog.
  const [deleteStep, setDeleteStep] = useState(0);
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [certs, setCerts] = useState<Certification[]>([]);
  const [certModalOpen, setCertModalOpen] = useState(false);
  const [savingCert, setSavingCert] = useState(false);
  const [cert, setCert] = useState({ title: "", issuer: "", year: "", file: null as File | null });
  // One-time 18+ DOB backfill for legacy accounts created before the age floor.
  // Once a DOB exists it is write-once (server guard pins it), so we lock the
  // field. Holding the ISO value (not just a boolean) lets the locked state show
  // WHAT is on file, the way mobile does — a bare disappearing field left users
  // unable to tell whether a birth date had ever been recorded.
  const [existingDob, setExistingDob] = useState<string | null>(null);
  const dobLocked = !!existingDob;
  const [dobM, setDobM] = useState("");
  const [dobD, setDobD] = useState("");
  const [dobY, setDobY] = useState("");
  const [dobError, setDobError] = useState("");
  const dob = dobM && dobD && dobY ? `${dobM}/${dobD}/${dobY}` : "";
  const dobDayCount = new Date(Number(dobY) || 2000, Number(dobM) || 12, 0).getDate();
  const dobYears = Array.from({ length: new Date().getFullYear() - 1920 + 1 }, (_, i) => new Date().getFullYear() - i);
  const [f, setF] = useState({
    name: "", username: "", bio: "", city: "", role: "earner" as "earner" | "poster" | "both",
    skills: [] as string[], radiusMiles: 25, skillRates: {} as Record<string, string>,
    school: "", major: "", degreeType: "", classStanding: "", gradYear: "",
    showAvailability: false,
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));
  // Typing your own username is the strongest available signal that this is
  // the account you meant; fall back to DELETE if a legacy row has none.
  const CONFIRM_WORD = f.username.trim() || "DELETE";
  const confirmMatches = deleteConfirm.trim().toLowerCase() === CONFIRM_WORD.toLowerCase();

  useEffect(() => {
    if (!user) return;
    (async () => {
      // date_of_birth is deliberately NOT selected here, and must not be added back.
      // It has no column-level SELECT grant (20260624221000_profile_column_lockdown.sql)
      // and must never get one: profiles_select_all is USING(true), so a table-wide
      // column grant would expose EVERY user's date of birth to every other signed-in
      // user — on a platform that includes minors. Naming it here made PostgREST reject
      // the WHOLE query with 42501, which rendered a blank form that Save then wrote
      // back over the stored profile. The owner's own DOB comes from my_profile()
      // instead: SECURITY DEFINER, scoped to auth.uid() (same source web/lib/user.tsx uses).
      const { data, error } = await supabase
        .from("profiles")
        .select("name, username, bio, city, role, skills, radius_miles, skill_rates, school, major, degree_type, class_standing, grad_year, show_availability")
        .eq("id", user.id)
        .single();
      if (error || !data) {
        // Never fall through to a blank form — the save handler writes every field
        // unconditionally, so that would silently wipe the profile.
        setLoadError(error?.message || "Could not load your profile.");
        setLoading(false);
        return;
      }
      if (data) {
        // A legacy account may have no DOB yet — offer the one-time backfill; if it's
        // already set, keep the field locked/omitted (write-once).
        const { data: mine } = await supabase.rpc("my_profile");
        setExistingDob(mine?.date_of_birth || null);
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

  const onAvatar = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;
    setUploadingAvatar(true);
    try {
      const url = await uploadToBucket(file, "avatars", user.id);
      // supabase resolves with { error } instead of rejecting, so this has to be
      // checked explicitly — otherwise an RLS or network failure on the profile
      // write still fell through to the success toast and the user was told
      // "Photo updated!" while looking at their old picture.
      const { error } = await supabase.from("profiles").update({ avatar_url: url }).eq("id", user.id);
      if (error) throw error;
      await refreshProfile();
      showToast({ icon: "✅", title: "Photo updated!", message: "Your new profile picture is live." });
    } catch (err) {
      showToast({ icon: "⚠️", title: "Upload failed", message: (err as Error).message || "Please try again." });
    } finally {
      setUploadingAvatar(false);
      // Clear the input so picking the SAME file again after a failure re-fires change.
      e.target.value = "";
    }
  };

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
    // Hard stop if the profile never loaded. The update below writes EVERY field
    // unconditionally, so saving from the empty initial form state would blank the
    // user's name, username, bio, city, skills, rates and school data.
    if (loadError) return;
    if (!(await checkUsername())) return;

    // Name, username and bio are PUBLIC user-generated text (they render on the
    // public profile, job cards, chat headers, reviews and push notifications), so
    // they get the same two-layer check the mobile client and every other UGC
    // surface run: the keyword list, then the context-aware pass. App Store
    // Guideline 1.2 requires filtering objectionable material on every UGC surface.
    // Mobile already did this (src/screens/SettingsScreen.js); this editor ran no
    // filter at all, so the web was a clean bypass of both layers. The DB backstop
    // (guard_prohibited_content) now covers name/username too and is the real
    // enforcement point — this is the fast, user-friendly check in front of it.
    const profileText = [f.name, f.username, f.bio].filter(Boolean).join(" ");
    const kwTerm = findProhibited(profileText);
    if (kwTerm) {
      logModerationBlock(kwTerm, "profile", profileText);
      showToast({
        icon: "⚠️",
        title: "Check your wording",
        message: "Your profile contains content that isn't allowed. Please edit it.",
      });
      return;
    }
    const mod = await moderateText([f.name, f.bio].filter(Boolean).join("\n"), "profile");
    // A 429 here is self-inflicted (own quota), not an outage, so moderateText
    // fails CLOSED on it — otherwise burning the quota would disable this layer.
    if (mod.rateLimited) {
      showToast({ icon: "⏳", title: "Too many checks", message: "You've made a lot of checks in a row. Wait a minute and try again." });
      return;
    }
    if (!mod.allowed) {
      showToast({
        icon: "⚠️",
        title: "Check your wording",
        message: "Your profile contains content that isn't allowed. Please edit it.",
      });
      return;
    }
    // One-time 18+ DOB backfill (write-once — the server guard pins it once set). Only
    // validate/write when the account has no DOB yet and the user filled it in here.
    let dobIso: string | null = null;
    if (!dobLocked && dob) {
      dobIso = parseDob(dob);
      if (!dobIso) { setDobError("Enter a valid date of birth."); return; }
      if (!isAdult(dobIso)) { setDobError(`You must be ${MIN_AGE} or older to use GoHustlr.`); return; }
      setDobError("");
    }
    setSaving(true);
    const { error } = await supabase
      .from("profiles")
      .update({
        ...(dobIso ? { date_of_birth: dobIso } : {}),
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
    const { data, error } = await supabase.functions.invoke("delete-account");
    if (error) {
      setDeleting(false);
      setDeleteStep(0);
      // The function refuses (409) while the account still has open bookings, so
      // deleting can't void an escrow hold on work someone already did. supabase-js
      // puts a non-2xx body on error.context — read the specific reason and tell the
      // user what to clear instead of a generic "try again".
      let message = "Please try again, or email support.";
      try {
        const body = await (error as { context?: { json?: () => Promise<{ error?: string; message?: string }> } })
          .context?.json?.();
        if (body?.message && ["UNSETTLED_BOOKINGS", "UNDER_REVIEW", "REVIEW_CHECK_FAILED", "SETTLEMENT_CHECK_FAILED"].includes(body.error ?? "")) message = body.message;
      } catch {
        /* keep the generic message */
      }
      showToast({ icon: "❌", title: "Could not delete", message });
      return;
    }
    if (["UNSETTLED_BOOKINGS", "UNDER_REVIEW", "REVIEW_CHECK_FAILED", "SETTLEMENT_CHECK_FAILED"].includes(data?.error ?? "")) {
      setDeleting(false);
      setDeleteStep(0);
      showToast({ icon: "❌", title: "Could not delete", message: data.message });
      return;
    }
    // Account is gone — clear the now-invalid session and return to sign-in.
    await signOut();
    router.replace("/login");
  };

  if (loading) return <FullPageSpinner className="min-h-[60dvh]" />;

  // The profile failed to load. Render a retry state rather than the form: the form
  // would show every field blank, and saving it would overwrite the stored profile.
  //
  // Built from the app primitives (PageHeader/PageContainer/Button). The previous
  // version hand-rolled it with `text-[var(--ink)]`, `text-[var(--muted)]` and
  // `bg-[var(--brand)]` — none of which are defined (the tokens are --color-ink,
  // --color-ink-muted, --color-primary), so an undefined custom property made the
  // background invalid at computed-value time and the button rendered white text
  // on the cream canvas: invisible, on the one screen whose whole job is to offer
  // a retry.
  if (loadError) {
    return (
      <div>
        <PageHeader title="Profile settings" width="form" back="/profile" />
        <PageContainer width="form">
          <div className="flex min-h-[40dvh] flex-col items-center justify-center gap-3 text-center">
            <p className="text-lg font-bold text-ink">Couldn&apos;t load your profile</p>
            <p className="max-w-prose text-sm text-ink-soft">
              Your settings weren&apos;t loaded, so they can&apos;t be edited safely right now.
            </p>
            <Button className="mt-2" onClick={() => window.location.reload()}>Try again</Button>
            {/* Mobile pairs the retry with a way out, so a persistent failure is
                not a dead end on a page whose form is deliberately withheld. */}
            <Button variant="ghost" size="sm" onClick={() => router.push("/profile")}>Go back</Button>
          </div>
        </PageContainer>
      </div>
    );
  }
  const showEarnerFields = f.role === "earner" || f.role === "both";

  return (
    <div>
      <PageHeader
        title="Profile settings"
        subtitle="Change your info, role, location, and skills"
        width="form"
        back="/profile"
      />
      <PageContainer width="form">
        {/* No `space-y` on this wrapper: section spacing is carried by
            SectionHeader's own top margin, and a `space-y-*` on the parent wins
            on specificity and would flatten it. */}
        <div>
          {/* The only place on web to change the profile photo — the Profile page's
              avatar links to the public profile instead of opening a picker. */}
          <SectionHeader first>Photo</SectionHeader>
          <label
            className={classNames(
              "flex items-center gap-4 rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]",
              uploadingAvatar ? "cursor-default opacity-60" : "cursor-pointer",
            )}
          >
            <div className="relative">
              <Avatar url={avatarUrl} initial={avatarInitial} name={name} size={64} />
              <span className="absolute -bottom-0.5 -right-0.5 flex size-6 items-center justify-center rounded-full bg-primary ring-2 ring-white">
                {uploadingAvatar
                  ? <Loader2 className="size-3.5 animate-spin text-white" />
                  : <Camera className="size-3.5 text-white" />}
              </span>
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold text-ink">Profile photo</p>
              <p className="mt-0.5 text-xs text-ink-muted">
                {uploadingAvatar ? "Uploading…" : "Click to choose a new picture"}
              </p>
            </div>
            <span className={buttonClasses("outline", "sm", "shrink-0")}>Change</span>
            {/* sr-only, not hidden: display:none takes the input out of the tab
                order, and this is now the ONLY way to set a profile photo on web. */}
            <input type="file" accept="image/*" className="sr-only" onChange={onAvatar} disabled={uploadingAvatar} />
          </label>

          <SectionHeader>Basics</SectionHeader>
          <div className="space-y-6">
            {/* Short fields pair two-up once the column is wide enough. Container
                queries, not viewport ones: `main` is the query container, so this
                measures the space the form actually has instead of guessing from the
                window and being wrong by one sidebar width. */}
            <div className="grid gap-6 @2xl:grid-cols-2">
              <div className="min-w-0">
                <Label>Display name</Label>
                <Input value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Your name" autoCapitalize="words" />
              </div>
              <div className="min-w-0">
                <Label>Username</Label>
                <Input
                  value={f.username}
                  onChange={(e) => { set("username", e.target.value); setUsernameError(""); }}
                  placeholder="e.g. chris_hustler"
                  maxLength={30}
                  autoCapitalize="none"
                  autoCorrect="off"
                />
                {usernameError && <p className="mt-1.5 text-sm font-medium text-urgent">{usernameError}</p>}
                {/* Mobile keeps the handle preview AND the format rule visible at all
                    times — the rule used to appear only after a rejected save, which
                    is exactly when it is too late to be useful. */}
                <p className="mt-1.5 truncate text-xs text-ink-muted">
                  @{f.username || "username"} · 3–30 lowercase chars
                </p>
              </div>
            </div>
            <div>
              <Label>Bio</Label>
              <Textarea value={f.bio} onChange={(e) => set("bio", e.target.value)} maxLength={280} placeholder="A short bio about yourself..." />
            </div>
            <div>
              <Label>I&apos;m here to...</Label>
              <div className="grid grid-cols-3 gap-2">
                {ROLES.map((r) => (
                  <Chip
                    key={r.id}
                    active={f.role === r.id}
                    onClick={() => set("role", r.id)}
                    icon={<r.Icon className="size-4 shrink-0" />}
                  >
                    {r.label}
                  </Chip>
                ))}
              </div>
            </div>
            <div>
              <Label>Location</Label>
              <LocationPicker value={f.city} onChange={(label) => set("city", label)} placeholder="Your city or 'Remote'" />
            </div>

            <div>
              <Label>Date of birth</Label>
              {dobLocked ? (
                <>
                  {/* Write-once: the DB guard pins date_of_birth once it exists, so
                      this is a read-only echo. Showing the stored value (mobile does)
                      is the only way a user can confirm what is on file — the field
                      simply vanishing read as "we never asked". */}
                  <div className="flex items-center gap-2 rounded-xl border border-line bg-white px-4 py-3">
                    <Lock className="size-4 shrink-0 text-ink-muted" />
                    <span className="min-w-0 truncate text-base text-ink sm:text-[15px]">{formatDob(existingDob!)}</span>
                  </div>
                  <p className="mt-1.5 text-xs text-ink-muted">Your date of birth is set and can&apos;t be changed.</p>
                </>
              ) : (
                <>
                  {/* Stacked until the column can hold three selects. As three
                      flex-basis columns the Day select got ~84px on a 375px screen, and
                      Select's `appearance-none pr-10` spends 40px of that on the right —
                      "September" had nowhere to go. Container step, not `sm:`, for the
                      same reason as the pairs above: `main` is the query container, so
                      this measures the form column instead of the window. */}
                  <div className="grid grid-cols-1 gap-2 @2xl:grid-cols-3">
                    <SelectWrap>
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
                      >
                        <option value="">Month</option>
                        {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                      </Select>
                    </SelectWrap>
                    <SelectWrap>
                      <Select value={dobD} onChange={(e) => { setDobD(e.target.value); setDobError(""); }} aria-label="Day">
                        <option value="">Day</option>
                        {Array.from({ length: dobDayCount }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
                      </Select>
                    </SelectWrap>
                    <SelectWrap>
                      <Select
                        value={dobY}
                        onChange={(e) => {
                          const y = e.target.value;
                          setDobY(y);
                          setDobError("");
                          if (dobD && Number(dobD) > new Date(Number(y) || 2000, Number(dobM) || 12, 0).getDate()) setDobD("");
                        }}
                        aria-label="Year"
                      >
                        <option value="">Year</option>
                        {dobYears.map((y) => <option key={y} value={y}>{y}</option>)}
                      </Select>
                    </SelectWrap>
                  </div>
                  {dobError ? (
                    <p className="mt-1.5 text-sm font-medium text-urgent">{dobError}</p>
                  ) : (
                    <p className="mt-1.5 text-xs text-ink-muted">
                      You must be {MIN_AGE}+ to use GoHustlr. This is saved once and can&apos;t be changed later.
                    </p>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Education sits between Basics and Work preferences, as on mobile —
              it is the section every role sees, so it must not be stranded after a
              block that only earners get. */}
          <SectionHeader>Education</SectionHeader>
          <div className="space-y-6">
            <div>
              <Label>College (optional)</Label>
              <Input value={f.school} onChange={(e) => set("school", e.target.value)} placeholder="e.g. University of Texas at Austin" />
              <p className="mt-1.5 text-xs text-ink-muted">
                Verify your .edu email on the{" "}
                <a href="/verify-student" className="font-bold text-primary">Verify Student</a> page to earn a Verified Student badge.
              </p>
            </div>
            {f.school && (
              <>
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
                {/* Grad year is four digits — it takes one column of the pair grid so
                    it never stretches to a 760px-wide text box. Mobile's field order
                    puts it last, after the two chip grids, so it cannot pair with Major. */}
                <div className="grid gap-6 @2xl:grid-cols-2">
                  <div className="min-w-0">
                    <Label>Graduation year</Label>
                    <Input value={f.gradYear} onChange={(e) => set("gradYear", e.target.value.replace(/[^0-9]/g, "").slice(0, 4))} inputMode="numeric" maxLength={4} placeholder="e.g. 2027" />
                  </div>
                </div>
              </>
            )}
          </div>

          {showEarnerFields && (
            <>
              <SectionHeader>Work preferences</SectionHeader>
              <div className="space-y-6">
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
                    <div className="grid gap-2 @2xl:grid-cols-2 @2xl:gap-x-6">
                      {f.skills.map((s) => (
                        <div key={s} className="flex items-center justify-between gap-3">
                          <span className="min-w-0 truncate text-sm font-semibold text-ink">{s}</span>
                          <div className="flex w-28 shrink-0 items-center gap-1 rounded-xl border border-line bg-white px-3 py-2.5 transition focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/15">
                            <span className="shrink-0 text-ink-soft">$</span>
                            <input
                              value={f.skillRates?.[s] || ""}
                              onChange={(e) => setF((p) => ({ ...p, skillRates: { ...p.skillRates, [s]: e.target.value.replace(/[^0-9]/g, "") } }))}
                              inputMode="numeric"
                              placeholder="—"
                              aria-label={`Hourly rate for ${s}`}
                              className="w-full min-w-0 bg-transparent text-base font-bold outline-none sm:text-sm"
                            />
                            <span className="shrink-0 text-xs text-ink-muted">/hr</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {/* Saves on toggle, not on "Save changes" — the only control on this
                    page that writes immediately (mobile behaves the same way). */}
                <div className="flex items-center justify-between gap-4 rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
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
              </div>
            </>
          )}

          {/* Certifications — every role, outside the earner-only block. */}
          <div className="mt-8">
            <Label>Certifications</Label>
            <p className="text-xs text-ink-muted">
              Trade certs &amp; credentials (e.g. EPA 608, OSHA 10) — shown on your public profile.
            </p>
            {certs.length > 0 && (
              <div className="mt-3 grid gap-2 @2xl:grid-cols-2">
                {certs.map((c) => (
                  <div key={c.id} className="flex items-center gap-3 rounded-2xl bg-white p-3 shadow-[var(--shadow-card)]">
                    {c.image_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={c.image_url} alt={c.title} className="size-10 shrink-0 rounded-lg bg-divider object-cover" />
                    ) : (
                      // Placeholder tile so an image-less cert still lines its title
                      // up with the ones that have artwork.
                      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-canvas text-ink-soft">
                        <Award className="size-[18px]" />
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold text-ink">{c.title}</p>
                      {(c.issuer || c.year) && (
                        <p className="truncate text-xs text-ink-muted">
                          {[c.issuer, c.year].filter(Boolean).join(" · ")}
                        </p>
                      )}
                    </div>
                    {/* An explicit 44px box. Padding around the glyph only reached
                        36px (the old p-1.5 was 28px), and the negative margin pulls
                        the layout back in — it does not enlarge the hit area. */}
                    <button
                      type="button"
                      onClick={() => removeCert(c.id)}
                      className="-m-2 flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-ink-muted transition hover:text-urgent"
                      aria-label={`Remove ${c.title}`}
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {/* Mobile puts the add control after the list, reading "Add
                certification" in full — a bare "Add" beside the label was
                ambiguous next to the page's other add affordances. */}
            <Button variant="outline" fullWidth className="mt-3" onClick={() => setCertModalOpen(true)}>
              <Plus className="size-4" /> Add certification
            </Button>
          </div>

          {/* Sticky save bar: the form is ~14 controls tall, and Save used to be
              reachable only from the very bottom. Offset above the mobile tab bar
              (which is `md:hidden`, so the offset drops at md too). */}
          <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-30 -mx-4 mt-8 border-t border-line bg-canvas/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 md:bottom-0 lg:-mx-8 lg:px-8">
            <Button fullWidth size="lg" loading={saving} onClick={save}>Save changes</Button>
          </div>

          {/* Sign out. Both clients moved this off the profile tab so it could not be
              mis-tapped, leaving the comment "Sign out lives in Settings only" — but on
              web the second half never happened, so there was NO way to end a web
              session at all. Mobile's SettingsScreen has had confirmSignOut the whole
              time. Confirmed, like mobile, because this is still a one-tap exit. */}
          <div className="mt-6 rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
            <p className="text-[13px] font-semibold text-ink-muted">Account</p>
            <p className="mt-1 text-sm text-ink-soft">
              You&apos;ll need to sign in again to get back to your gigs.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => setSignOutOpen(true)}
            >
              <LogOut className="size-4" /> Sign out
            </Button>
          </div>

          {/* Danger zone */}
          {/* Tinted surface rather than an alpha border + alpha fill — the tinted
              bg / deep text pair is the palette's one convention for a warning. */}
          <div className="mt-8 rounded-2xl bg-urgent-light p-4">
            <p className="text-[13px] font-semibold text-urgent">Danger zone</p>
            <p className="mt-1 text-sm text-ink-soft">
              Permanently delete your account, profile, gigs, bookings, messages, reviews, and photos. This can&apos;t be undone.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3 border-urgent text-urgent hover:bg-urgent/5 hover:text-urgent"
              onClick={() => { setDeleteConfirm(""); setDeleteStep(1); }}
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
        open={signOutOpen}
        onClose={() => setSignOutOpen(false)}
        title="Sign out?"
        size="sm"
        footer={
          <div className="flex flex-col gap-2">
            <Button fullWidth onClick={() => setSignOutOpen(false)}>Stay signed in</Button>
            <Button
              variant="ghost"
              fullWidth
              onClick={async () => {
                setSignOutOpen(false);
                await signOut();
                router.replace("/login");
              }}
            >
              Sign out
            </Button>
          </div>
        }
      >
        <p className="text-sm text-ink-soft">
          You&apos;ll need to sign in again to get back to your gigs.
        </p>
      </Modal>

      <Modal
        open={deleteStep > 0}
        onClose={() => !deleting && setDeleteStep(0)}
        title={deleteStep === 1 ? "Delete your account?" : "Confirm deletion"}
        size="sm"
        footer={
          deleteStep === 1 ? (
            <div className="flex flex-col gap-2">
              <Button fullWidth onClick={() => setDeleteStep(0)}>Keep my account</Button>
              <Button variant="ghost" fullWidth className="text-urgent" onClick={() => setDeleteStep(2)}>
                Continue to delete
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <Button fullWidth onClick={() => setDeleteStep(0)} disabled={deleting}>Cancel</Button>
              <Button
                fullWidth
                variant="danger"
                loading={deleting}
                disabled={!confirmMatches || deleting}
                onClick={deleteAccount}
              >
                Delete my account forever
              </Button>
            </div>
          )
        }
      >
        {deleteStep === 1 ? (
          <>
            <p className="text-sm text-ink-soft">This can&apos;t be undone. You&apos;ll permanently lose:</p>
            {/* Icon per consequence, in mobile's order. The glyphs are what make
                this read as four distinct losses rather than one block of text —
                this is the step that has to actually land before step 2. */}
            <ul className="mt-3 space-y-2.5 text-sm text-ink">
              {[
                { Icon: Star, text: "Your rating and every review you’ve earned" },
                { Icon: Banknote, text: "Your earnings history and tax records" },
                { Icon: MessageCircle, text: "All your messages and booking history" },
                { Icon: Briefcase, text: "Any gigs you’ve posted" },
              ].map((row) => (
                <li key={row.text} className="flex items-start gap-2.5">
                  <row.Icon className="mt-0.5 size-4 shrink-0 text-urgent" />
                  <span className="min-w-0">{row.text}</span>
                </li>
              ))}
            </ul>
            <p className="mt-4 rounded-xl bg-canvas p-3 text-sm text-ink-soft">
              Just need a break? Setting your work status to Offline hides you from new gigs without
              losing any of this.
            </p>
          </>
        ) : (
          <>
            <p className="text-sm text-ink-soft">
              Type <span className="font-bold text-ink">{CONFIRM_WORD}</span> below to permanently delete your account.
            </p>
            <Input
              className="mt-3"
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              placeholder={CONFIRM_WORD}
              autoComplete="off"
            />
          </>
        )}
      </Modal>
    </div>
  );
}
